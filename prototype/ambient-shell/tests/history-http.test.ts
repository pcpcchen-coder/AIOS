import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { buildRealtimeTools } from "../server/realtime.ts";
import type { HistoryDetail, HistoryPage } from "../shared/history.ts";
import type { Task } from "../shared/types.ts";

// HIST-1：/api/history 的搜尋、詳細、刪除，與其他 /api 路由相同的本機保護（Host、Origin、JSON content-type）。

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nous-history-"));
  dirs.push(dir);
  return dir;
}

async function start(options: { stepMs?: number; dataDir?: string } = {}) {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const dir = temp();
  const store = new TaskStore(options.dataDir ?? null);
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(options.stepMs ?? 1), auth, dir, preferred: "mock", onChange: () => {} });
  const runner = new TaskRunner(store, providers);
  const app = createApp({ store, runner, settings: providers, auth, chat: providers, port, devPort: 5173, distDir: null });
  servers.push(app);
  await new Promise<void>((r) => app.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const getJson = async <T>(path: string) => (await fetch(base + path)).json() as Promise<T>;
  return { base, port, post, getJson, store, runner };
}

/** fetch 不能改 Host；用 node:http 直接送。 */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function submit(ctx: Awaited<ReturnType<typeof start>>, text: string, n: number): Promise<Task> {
  const res = await ctx.post("/api/tasks", { text, request_id: `req_history${String(n).padStart(4, "0")}` });
  expect(res.status).toBe(201);
  return (await res.json()) as Task;
}

describe("GET /api/history", () => {
  it("searches tasks and artifacts in memory and returns items labelled with their source", async () => {
    const ctx = await start();
    await submit(ctx, "規劃晚餐菜單，不要香菜", 1);
    await submit(ctx, "Draft a budget email", 2);
    await ctx.runner.idle();
    const page = await ctx.getJson<HistoryPage>("/api/history?q=%E9%A6%99%E8%8F%9C");
    expect(page.items.map((i) => i.title)).toEqual(["規劃晚餐菜單，不要香菜"]);
    expect(page.items[0]).toMatchObject({ source: "tasks", protected: false, status: "succeeded", mode: "mock" });
    expect(page.sources).toEqual([{ id: "tasks", protected: false }]);
    expect((await ctx.getJson<HistoryPage>("/api/history?q=BUDGET")).items).toHaveLength(1);
    const all = await ctx.getJson<HistoryPage>("/api/history");
    expect(all.total).toBe(2);
    expect(all.items[0]!.title).toBe("Draft a budget email");
    expect((await fetch(`${ctx.base}/api/history?status=bogus`)).status).toBe(400);
    expect((await fetch(`${ctx.base}/api/history?cursor=abc`)).status).toBe(400);
    const bad = await fetch(`${ctx.base}/api/history?from=2026-10-05&to=2026-10-01`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("開始日期晚於結束日期");
    const badEn = await fetch(`${ctx.base}/api/history?from=2026-13-45`, { headers: { "X-Nous-Locale": "en" } });
    expect(((await badEn.json()) as { error: string }).error).toBe("Invalid date");
    const missing = await fetch(`${ctx.base}/api/history/task_missing`, { headers: { "X-Nous-Locale": "en" } });
    expect(((await missing.json()) as { error: string }).error).toBe("Task not found");
  });

  it("returns a task's detail with its artifact; unknown ids are 404", async () => {
    const ctx = await start();
    const task = await submit(ctx, "整理書單", 3);
    await ctx.runner.idle();
    const detail = await ctx.getJson<HistoryDetail>(`/api/history/${task.task_id}`);
    expect(detail.task.title).toBe("整理書單");
    expect(detail.artifact?.task_id).toBe(task.task_id);
    expect(detail).toMatchObject({ source: "tasks", protected: false });
    expect((await fetch(`${ctx.base}/api/history/task_missing`)).status).toBe(404);
  });

  it("writes no search index and never logs the query text", async () => {
    const dataDir = temp();
    const ctx = await start({ dataDir });
    await submit(ctx, "秘密查詢測試", 4);
    await ctx.runner.idle();
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    const canary = "CANARYQUERY香菜";
    await fetch(`${ctx.base}/api/history?q=${encodeURIComponent(canary)}`);
    await fetch(`${ctx.base}/api/history?q=${encodeURIComponent(canary)}&status=nope`);
    expect(logged.join("\n")).not.toContain("CANARYQUERY");
    expect(readdirSync(dataDir).sort()).toEqual(["artifacts.json", "tasks.json"]);
    for (const file of readdirSync(dataDir)) expect(readFileSync(join(dataDir, file), "utf8")).not.toContain("CANARYQUERY");
  });
});

describe("history routes have the same local protections as the other /api routes", () => {
  it("rejects a foreign Host for reads, and a foreign Origin or non-JSON body for deletes, exactly like /api/tasks", async () => {
    const ctx = await start();
    const task = await submit(ctx, "保護測試", 5);
    await ctx.runner.idle();
    const evil = { host: `evil.example:${ctx.port}` };
    for (const path of ["/api/tasks", "/api/history", `/api/history/${task.task_id}`]) {
      expect(await raw(ctx.port, "GET", path, evil), path).toBe(403);
    }
    const body = JSON.stringify({ request_id: "req_history9999", confirm: true });
    const local = { host: `localhost:${ctx.port}` };
    for (const path of [`/api/tasks/${task.task_id}/retry`, `/api/history/${task.task_id}/delete`]) {
      expect(await raw(ctx.port, "POST", path, { ...local, origin: "https://evil.example", "content-type": "application/json" }, body), path).toBe(403);
      expect(await raw(ctx.port, "POST", path, { ...local, "content-type": "text/plain" }, body), path).toBe(415);
      expect(await raw(ctx.port, "POST", path, { ...evil, "content-type": "application/json" }, body), path).toBe(403);
    }
    // 沒被刪掉。
    expect((await ctx.getJson<Task[]>("/api/tasks")).map((t) => t.task_id)).toContain(task.task_id);
  });

  it("no realtime model tool can open or search the results history", () => {
    const names = buildRealtimeTools({ webSearch: true, home: true, mcp: [] }).map((t) => String(t.name));
    expect(names.some((n) => /history|result|artifact/i.test(n))).toBe(false);
  });
});

describe("POST /api/history/:id/delete", () => {
  it("requires a request_id and explicit confirm: true", async () => {
    const ctx = await start();
    const task = await submit(ctx, "要刪的任務", 6);
    await ctx.runner.idle();
    expect((await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0601" })).status).toBe(400);
    expect((await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0602", confirm: "yes" })).status).toBe(400);
    expect((await ctx.post(`/api/history/${task.task_id}/delete`, { confirm: true })).status).toBe(400);
    expect(ctx.store.get(task.task_id)).toBeDefined();
  });

  it("refuses a running task until it is stopped", async () => {
    const ctx = await start({ stepMs: 60_000 });
    const task = await submit(ctx, "還在跑的任務", 7);
    const res = await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0701", confirm: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("執行中的任務不能刪除，請先停止任務");
    const en = await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0702", confirm: true }, { "X-Nous-Locale": "en" });
    expect(((await en.json()) as { error: string }).error).toBe("A running task cannot be deleted; stop the task first");
    await ctx.post(`/api/tasks/${task.task_id}/cancel`, {});
    await ctx.runner.idle();
    expect(ctx.store.get(task.task_id)!.status).toBe("cancelled");
    expect((await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0703", confirm: true })).status).toBe(200);
  });

  it("deletes the task and its artifact from memory and disk, and broadcasts task.deleted over SSE", async () => {
    const dataDir = temp();
    const ctx = await start({ dataDir });
    const task = await submit(ctx, "刪除後不該留下 DELETECANARY", 8);
    const keep = await submit(ctx, "留下來的任務", 9);
    await ctx.runner.idle();
    const artifactId = ctx.store.get(task.task_id)!.artifact_id!;
    expect(readFileSync(join(dataDir, "artifacts.json"), "utf8")).toContain("DELETECANARY");

    const controller = new AbortController();
    const events = await fetch(`${ctx.base}/api/events`, { signal: controller.signal });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame!.replace(/^data: /, ""));
    };
    expect((await next()).type).toBe("hello");

    const res = await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0801", confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, task_id: task.task_id, artifact_id: artifactId });
    expect(await next()).toMatchObject({ type: "task.deleted", task_id: task.task_id, artifact_id: artifactId });
    controller.abort();

    expect((await ctx.getJson<Task[]>("/api/tasks")).map((t) => t.task_id)).toEqual([keep.task_id]);
    expect((await fetch(`${ctx.base}/api/artifacts/${artifactId}`)).status).toBe(404);
    expect((await ctx.getJson<HistoryPage>("/api/history?q=DELETECANARY")).total).toBe(0);
    for (const file of ["tasks.json", "artifacts.json"]) expect(readFileSync(join(dataDir, file), "utf8")).not.toContain("DELETECANARY");
    const reloaded = new TaskStore(dataDir);
    expect(reloaded.get(task.task_id)).toBeUndefined();
    expect(reloaded.get(keep.task_id)).toBeDefined();
    expect((await ctx.post(`/api/history/${task.task_id}/delete`, { request_id: "req_history0802", confirm: true })).status).toBe(404);
  });
});

describe("deletion is safe across the two files", () => {
  it("writes artifacts.json before tasks.json, and load() drops artifacts whose task is gone", async () => {
    const dataDir = temp();
    const store = new TaskStore(dataDir);
    const t = store.create({ title: "孤兒測試", request_id: "req_orphan0001", mode: "mock" });
    const a = store.addArtifact({ task_id: t.task_id, title: t.title, content: "ORPHANCANARY", mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    store.update(t.task_id, (x) => { x.status = "succeeded"; x.artifact_id = a.artifact_id; });
    // 模擬「刪除時只寫了一個檔就中斷」的舊狀態：tasks.json 沒有這個任務，artifacts.json 還有成果。
    const tasksFile = join(dataDir, "tasks.json");
    writeFileSync(tasksFile, "[]");
    const reloaded = new TaskStore(dataDir);
    expect(reloaded.getArtifact(a.artifact_id)).toBeUndefined();
    expect(readFileSync(join(dataDir, "artifacts.json"), "utf8")).not.toContain("ORPHANCANARY");
    // 刪除的寫入順序：先成果、後任務。
    const fresh = new TaskStore(temp());
    const order: string[] = [];
    const proto = fresh as unknown as { persistArtifacts(): void; persistTasks(): void };
    const pa = proto.persistArtifacts.bind(fresh), pt = proto.persistTasks.bind(fresh);
    const t2 = fresh.create({ title: "順序", request_id: "req_orphan0002", mode: "mock" });
    fresh.update(t2.task_id, (x) => { x.status = "failed"; });
    proto.persistArtifacts = () => { order.push("artifacts"); pa(); };
    proto.persistTasks = () => { order.push("tasks"); pt(); };
    expect(fresh.delete(t2.task_id)).toMatchObject({ ok: true });
    expect(order).toEqual(["artifacts", "tasks"]);
  });
});

describe("redo reuses retry", () => {
  it("accepts a succeeded task only with redo: true and links the new task to the original", async () => {
    const ctx = await start();
    const task = await submit(ctx, "重做這件事", 10);
    await ctx.runner.idle();
    expect((await ctx.post(`/api/tasks/${task.task_id}/retry`, { request_id: "req_history1001" })).status).toBe(409);
    const res = await ctx.post(`/api/tasks/${task.task_id}/retry`, { request_id: "req_history1002", redo: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "重做這件事", retry_of: task.task_id, request_id: "req_history1002" });
    await ctx.runner.idle();
  });
});

describe("search latency through HTTP", () => {
  it("answers a search over 500 stored tasks within the stated bound", async () => {
    const ctx = await start();
    const filler = "成果內容包含晚餐、旅行、預算與 budget report。".repeat(100);
    for (let i = 0; i < 500; i++) {
      const t = ctx.store.create({ title: `合成任務 ${i}`, request_id: `req_perf${String(i).padStart(6, "0")}`, mode: "mock" });
      const a = ctx.store.addArtifact({ task_id: t.task_id, title: t.title, content: `${filler} 編號${i}`, mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
      ctx.store.update(t.task_id, (x) => { x.status = "succeeded"; x.artifact_id = a.artifact_id; x.finished_at = x.created_at; });
    }
    await fetch(`${ctx.base}/api/history?q=warmup`);
    const times: number[] = [];
    for (const q of ["晚餐", "budget", "編號42", "不存在的詞", "晚餐", "budget"]) {
      const start = performance.now();
      const page = (await (await fetch(`${ctx.base}/api/history?q=${encodeURIComponent(q)}`)).json()) as HistoryPage;
      times.push(performance.now() - start);
      expect(page.items.length).toBeLessThanOrEqual(20);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    console.log(`[history perf http] 500 tasks: median ${median.toFixed(1)} ms, worst ${times[times.length - 1]!.toFixed(1)} ms`);
    expect(median).toBeLessThan(300);
    expect(times[times.length - 1]!).toBeLessThan(1000);
  });
});
