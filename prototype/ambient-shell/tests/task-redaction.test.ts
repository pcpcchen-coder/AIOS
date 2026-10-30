import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import type { ChatCapable, ChatMessage } from "../server/chat.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { buildLiveInstructions, buildRealtimeInstructions } from "../server/realtime.ts";
import { buildCallerInstructions } from "../server/live-tool-caller.ts";
import { TaskRunner, type Executor } from "../server/runner.ts";
import type { ContextFact } from "../server/memory/retrieve.ts";
import { SealedVault } from "../server/sealed-vault.ts";
import { PROTECTED_TITLE, TaskStore, tasksForTarget } from "../server/store.ts";
import type { ChatTarget } from "../server/memory/retrieve.ts";
import type { SettingsView, Task } from "../shared/types.ts";
import { CHATGPT, CLAUDE, CODEX, enable, fakeBox, harness, manage, req, selectProfile, type Harness } from "./fixtures/memory-service.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";

// MEM-4a：加密保存時，所有對外頻道只看到外殼（canary 測試）：SSE、/api/tasks、/api/artifacts、/api/history、
// 對話提示（沒有記憶同意的服務帳號）、即時語音指示與 get_tasks 的來源。瀏覽器版（不加密）照舊。

const CANARY = "CANARY_交辦原句_NARWHAL_5521";
const servers: Server[] = [], dirs: string[] = [], vaults: SealedVault[] = [], harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
  await Promise.all(harnesses.splice(0).map(h => h.close()));
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeEngine extends ChatCapable { systems: string[]; script: string[]; current: ChatTarget; chatTarget(): ChatTarget | null }
function engine(target: ChatTarget, script = ["好的。"]): FakeEngine {
  const e: FakeEngine = {
    systems: [], script, current: target, chatTarget: () => e.current,
    async chat(input: { system: string; messages: ChatMessage[] }, onDelta: (text: string) => void) {
      e.systems.push(input.system);
      for (const piece of e.script) onDelta(piece);
      return { model: "fixture" };
    },
  };
  return e;
}

async function start(options: { sealed: boolean; chat?: FakeEngine; memory?: Harness; executor?: Executor }) {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => probe.close(() => r()));
  const dir = mkdtempSync(join(tmpdir(), "nous-redaction-")); dirs.push(dir);
  let store: TaskStore;
  if (options.sealed) {
    const vault = SealedVault.open({ dir: join(dir, "sealed"), secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider });
    vaults.push(vault);
    store = new TaskStore(dir, { vault });
  } else store = new TaskStore(dir);
  const runner = new TaskRunner(store, options.executor ?? new MockExecutor(1));
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const settings = { view: (): SettingsView => ({ schema_version: "proto-0.1", provider: "mock", providers: [], chatgpt: auth.info() }), select: () => {} };
  const chat = options.chat ?? engine(CLAUDE);
  const app = createApp({ store, runner, settings, auth, chat, ...(options.memory ? { memory: options.memory.service } : {}), port, devPort: 5173, distDir: null });
  servers.push(app);
  await new Promise<void>(r => app.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const json = (path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const chatCall = async (text: string, requestId: string, memoryTurn?: string | null) => {
    const res = await json("/api/chat", { messages: [{ role: "user", content: text }], request_id: requestId, ...(memoryTurn ? { memory_turn: memoryTurn } : {}) });
    const raw = await res.text();
    return { raw, events: raw.split("\n\n").filter(f => f.startsWith("data:")).map(f => JSON.parse(f.slice(5)) as Record<string, unknown>) };
  };
  return { base, dir, store, runner, json, chatCall, chat };
}

async function readSse(base: string, during: () => Promise<void>): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body!.getReader();
  let text = "";
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString("utf8"); } } catch { /* aborted */ } })();
  await new Promise(r => setTimeout(r, 30));
  await during();
  await new Promise(r => setTimeout(r, 60));
  controller.abort();
  await pump;
  return text;
}

function allBytes(dir: string): string {
  return readdirSync(dir).map(n => { const p = join(dir, n); return lstatSync(p).isDirectory() ? allBytes(p) : readFileSync(p).toString("utf8"); }).join("");
}

describe.skipIf(!realLockAvailable)("MEM-4a redaction across every outward channel (sealed App store)", () => {
  it("SSE, /api/tasks, /api/artifacts, /api/history and the files on disk never carry the sentence or the result", async () => {
    const app = await start({ sealed: true });
    let created!: Task;
    const sse = await readSse(app.base, async () => {
      const res = await app.json("/api/tasks", { text: `寫一份${CANARY}報告`, request_id: req() });
      created = await res.json() as Task;
      await app.runner.idle();
    });
    expect(created).toMatchObject({ protected: true, title: PROTECTED_TITLE });
    expect(sse).toContain("task.updated");
    expect(sse).not.toContain(CANARY);
    const task = app.store.get(created.task_id)!;
    expect(task.title).toContain(CANARY);
    expect(app.store.getArtifact(task.artifact_id!)!.content).toContain(CANARY);
    const tasks = await (await app.json("/api/tasks")).text();
    expect(tasks).not.toContain(CANARY);
    expect(JSON.parse(tasks)[0]).toMatchObject({ protected: true, status: "succeeded" });
    expect((await app.json(`/api/artifacts/${task.artifact_id}`)).status).toBe(404);
    for (const path of ["/api/history", `/api/history?q=${encodeURIComponent(CANARY)}`, `/api/history/${task.task_id}`]) {
      const res = await app.json(path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(CANARY);
    }
    const detail = await (await app.json(`/api/history/${task.task_id}`)).json() as { protected: boolean; artifact: unknown; task: Task };
    expect(detail).toMatchObject({ protected: true, artifact: null, task: { protected: true } });
    const page = await (await app.json("/api/history")).json() as { items: { protected: boolean; snippet: unknown }[] };
    expect(page.items[0]).toMatchObject({ protected: true, snippet: null });
    expect(allBytes(app.dir)).not.toContain(CANARY);
  });

  it("realtime instructions and get_tasks: shells without that route's consent; real titles only for allowed tasks (George 2026-10-30, minor 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-redaction-rt-")); dirs.push(dir);
    let app!: Awaited<ReturnType<typeof start>>;
    const seen: unknown[] = [];
    const executor: Executor = { mode: "claude", run: async (input, reporter) => { seen.push(input.facts); reporter.planReady([{ title: "s", domain: "language" }], "m"); return { content: "ok", assumptions: [], capability_gaps: [], status: "complete", model: "m" }; } };
    const h = harness({ dir, key: randomBytes(32), live: CODEX, release: { task: true }, tasks: { sealed: () => app.store.sealed, mode: () => app.runner.mode, target: () => CLAUDE, submit: (input) => app.runner.submitProtected(input) } });
    harnesses.push(h);
    app = await start({ sealed: true, memory: h, executor });
    await enable(h, "George", [CLAUDE]);
    await h.turn("記住，我不吃香菜");
    const plain = app.runner.submit({ title: `整理${CANARY}`, request_id: req() });
    const id = req();
    const t = await h.turn("幫我規劃一週晚餐", id) as unknown as { chat: { text: string; memory_turn: string } };
    const mem = await h.service.withChat({ nonce: t.chat.memory_turn, requestId: id, lastUser: t.chat.text, target: CLAUDE }, async (ctx) => ctx.delegate!());
    await app.runner.idle();
    const titles = (target: ChatTarget | null) => Object.fromEntries(tasksForTarget(app.store, h.service, target).map(x => [x.task_id, x.title]));
    // 沒有 codex 同意：即時語音（live）全部外殼。
    expect(Object.values(titles(h.service.routeTarget("live")))).toEqual([PROTECTED_TITLE, PROTECTED_TITLE]);
    // Claude 有同意、本次人物是 George：兩個都看得到。
    expect(titles(CLAUDE)).toMatchObject({ [plain.task_id]: `整理${CANARY}`, [mem!.task.task_id]: "幫我規劃一週晚餐" });
    // 換成沒有選人：George 的帶記憶任務變外殼，一般任務仍可（全家共用的同意）。
    await selectProfile(h, null);
    expect(titles(CLAUDE)).toMatchObject({ [plain.task_id]: `整理${CANARY}`, [mem!.task.task_id]: PROTECTED_TITLE });
    // 給 codex 同意之後：一般任務的真實標題給 live；帶記憶的任務是給 Claude 的，對 live 仍是外殼。
    const token = await manage(h);
    await h.call({ op: "setup", token, enabled: true, subject: { kind: "household" }, allow: [{ provider: CLAUDE.provider, account: CLAUDE.account }, { provider: CODEX.provider, account: CODEX.account }] });
    expect(titles(h.service.routeTarget("live"))).toMatchObject({ [plain.task_id]: `整理${CANARY}`, [mem!.task.task_id]: PROTECTED_TITLE });
    const text = buildLiveInstructions(tasksForTarget(app.store, h.service, null), new Date(), { mcp: [] }, "en");
    expect(text).not.toContain(CANARY);
    const appSource = readFileSync(join(import.meta.dirname, "../server/app.ts"), "utf8");
    expect(appSource).toContain("tasks: (route) => tasksFor(route ? options.memory?.routeTarget?.(route as VoiceRoute) ?? null : null)");
    expect(appSource).toContain("realtime.connect(sdp, store.publicList()");
    for (const shellText of [buildRealtimeInstructions(app.store.publicList(), new Date(), { webSearch: true, mcp: [], taskWebSearch: false, home: false }, "zh-TW"), buildCallerInstructions({ webSearch: true, mcp: [], taskWebSearch: false, home: false }, app.store.publicList(), new Date())]) {
      expect(shellText).not.toContain(CANARY);
    }
  });

  it("chat prompt: a target without memory consent sees shells; the delegate title from the model still works (no memory context)", async () => {
    const chat = engine(CLAUDE, ["好。"]);
    const app = await start({ sealed: true, chat });
    await app.json("/api/tasks", { text: `整理${CANARY}`, request_id: req() });
    await app.runner.idle();
    await app.chatCall("進度如何", req());
    expect(chat.systems[0]).not.toContain(CANARY);
    expect(chat.systems[0]).toContain(PROTECTED_TITLE);
  });

  it("chat prompt: real titles only where the memory consent for that target holds (conservative)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-redaction-mem-")); dirs.push(dir);
    const h = harness({ dir, key: randomBytes(32) });
    harnesses.push(h);
    await enable(h, "George", [CLAUDE]);
    const claude = engine(CLAUDE);
    const app = await start({ sealed: true, chat: claude, memory: h });
    await app.json("/api/tasks", { text: `整理${CANARY}`, request_id: req() });
    await app.runner.idle();
    await app.chatCall("進度如何", req());
    expect(claude.systems.at(-1)).toContain(CANARY);
    claude.current = CHATGPT;
    h.target.current = CHATGPT;
    await app.chatCall("進度如何", req());
    expect(claude.systems.at(-1)).not.toContain(CANARY);
  });

  it("protected delegation over /api/chat: the page gets a shell task, never the model's rewrite; the executor gets the memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-redaction-del-")); dirs.push(dir);
    const chat = engine(CLAUDE, ["我來安排。", `⟦交辦：規劃一週不含香菜的晚餐${CANARY}⟧`]);
    let app!: Awaited<ReturnType<typeof start>>;
    const h = harness({ dir, key: randomBytes(32), release: { task: true }, tasks: { sealed: () => app.store.sealed, mode: () => app.runner.mode, target: () => CLAUDE, submit: (input) => app.runner.submitProtected(input) } });
    harnesses.push(h);
    const seen: (readonly ContextFact[] | undefined)[] = [];
    const executor: Executor = { mode: "claude", run: async (input, reporter) => { seen.push(input.facts); reporter.planReady([{ title: "s", domain: "language" }], "m"); return { content: "ok", assumptions: [], capability_gaps: [], status: "complete", model: "m" }; } };
    app = await start({ sealed: true, chat, memory: h, executor });
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const id = req();
    const t = await h.turn("幫我規劃一週晚餐", id) as unknown as { chat: { text: string; memory_turn: string } };
    const { raw, events } = await app.chatCall(t.chat.text, id, t.chat.memory_turn);
    await app.runner.idle();
    expect(seen[0]!.map(f => f.text)).toEqual(["不吃香菜"]);
    expect(raw).not.toContain(CANARY);
    expect(events.filter(e => e.type === "delegate" || e.type === "delegate_blocked")).toEqual([]);
    const delegated = events.find(e => e.type === "delegated") as { task: Task; memory_used: number };
    expect(delegated).toMatchObject({ memory_used: 1, task: { protected: true, title: PROTECTED_TITLE } });
    // 標題是使用者原句，不是模型的改寫。
    expect(app.store.get(delegated.task.task_id)!.title).toBe("幫我規劃一週晚餐");
  });

  it("route task off: a memory turn that delegates still gets the M15 card with the user's sentence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-redaction-off-")); dirs.push(dir);
    const chat = engine(CLAUDE, ["我來安排。", "⟦交辦：規劃一週不含香菜的晚餐⟧"]);
    let app!: Awaited<ReturnType<typeof start>>;
    const h = harness({ dir, key: randomBytes(32), tasks: { sealed: () => app.store.sealed, mode: () => app.runner.mode, target: () => CLAUDE, submit: (input) => app.runner.submitProtected(input) } });
    harnesses.push(h);
    app = await start({ sealed: true, chat, memory: h });
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const id = req();
    const t = await h.turn("幫我規劃一週晚餐", id) as unknown as { chat: { text: string; memory_turn: string } };
    const { events } = await app.chatCall(t.chat.text, id, t.chat.memory_turn);
    expect(events.find(e => e.type === "delegate_blocked")).toEqual({ type: "delegate_blocked", title: "幫我規劃一週晚餐" });
    expect(app.store.list()).toEqual([]);
  });
});

describe("browser build (no sealing) is unaffected", () => {
  it("/api/tasks, SSE and the chat prompt keep the real title; artifacts are served", async () => {
    const chat = engine(CLAUDE);
    const app = await start({ sealed: false, chat });
    const created = await (await app.json("/api/tasks", { text: `寫${CANARY}`, request_id: req() })).json() as Task;
    expect(created.title).toContain(CANARY);
    expect(created.protected).toBeUndefined();
    await app.runner.idle();
    const task = app.store.get(created.task_id)!;
    expect((await app.json(`/api/artifacts/${task.artifact_id}`)).status).toBe(200);
    expect(await (await app.json("/api/tasks")).text()).toContain(CANARY);
    await app.chatCall("進度", req());
    expect(chat.systems[0]).toContain(CANARY);
  });
});
