import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { allowedHosts, checkRequest } from "../server/http-guard.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { WebSearch } from "../server/web-search.ts";
import { RealtimeBridge } from "../server/realtime.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { Task } from "../shared/types.ts";

describe("checkRequest", () => {
  const hosts = allowedHosts(8787, 5173);
  const json = { "content-type": "application/json" };

  it("拒絕非本機 Host（DNS rebinding）", () => {
    expect(checkRequest("GET", { host: "evil.example:8787" }, hosts).ok).toBe(false);
    expect(checkRequest("GET", { host: "localhost:8787" }, hosts).ok).toBe(true);
  });

  it("拒絕跨站 Origin 的寫入", () => {
    expect(checkRequest("POST", { host: "localhost:8787", origin: "https://evil.example", ...json }, hosts).ok).toBe(false);
    expect(checkRequest("POST", { host: "localhost:8787", origin: "http://localhost:5173", ...json }, hosts).ok).toBe(true);
  });

  it("寫入必須是 JSON（跨站 simple request 無法帶這個 header）", () => {
    const r = checkRequest("POST", { host: "localhost:8787", "content-type": "text/plain" }, hosts);
    expect(r).toEqual({ ok: false, status: 415, message: expect.any(String) });
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

async function start(mockStepMs = 5, realtime?: RealtimeBridge, webSearch?: WebSearch) {
  const port = await freePort();
  const store = new TaskStore(null);
  const dir = mkdtempSync(join(tmpdir(), "nous-http-"));
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({
    claude: null,
    chatgpt: new ChatGPTExecutor(auth, { model: null }),
    mock: new MockExecutor(mockStepMs),
    auth,
    dir,
    preferred: "mock",
    onChange: () => {},
  });
  const runner = new TaskRunner(store, providers);
  server = createApp({
    store,
    runner,
    settings: providers,
    auth,
    chat: providers,
    realtime,
    webSearch,
    port,
    devPort: 5173,
    distDir: null,
  });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { base, post, runner, store };
}

describe("HTTP API", () => {
  it("交辦 → 完成 → 取回成果", async () => {
    const { base, post, runner } = await start();
    const res = await post("/api/tasks", { text: "  整理待辦  ", request_id: "req_test0001" });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    expect(task).toMatchObject({ title: "整理待辦", mode: "mock" });

    await runner.idle();
    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    const done = list.find((t) => t.task_id === task.task_id)!;
    expect(done.status).toBe("succeeded");
    const artifact = await (await fetch(`${base}/api/artifacts/${done.artifact_id}`)).json();
    expect(artifact).toMatchObject({ task_id: task.task_id, mode: "mock" });
  });

  it("驗證輸入：缺文字、缺 request_id、非 JSON", async () => {
    const { base, post } = await start();
    expect((await post("/api/tasks", { text: "", request_id: "req_test0001" })).status).toBe(400);
    expect((await post("/api/tasks", { text: "hi" })).status).toBe(400);
    const bad = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(bad.status).toBe(400);
  });

  it("SSE 先送完整快照，之後推送真實任務事件", async () => {
    const { base, post, runner } = await start();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame.replace(/^data: /, ""));
    };

    expect(await next()).toMatchObject({ type: "hello", settings: { provider: "mock" }, tasks: [] });
    await post("/api/tasks", { text: "測試事件", request_id: "req_test0002" });
    const first = await next();
    expect(first).toMatchObject({ type: "task.updated", task: { title: "測試事件", status: "queued" } });
    await runner.idle();
    controller.abort();
  });

  it("切換引擎：Claude 未設定 key 時拒絕，ChatGPT 未登入時任務誠實失敗並提示登入", async () => {
    const { base, post, runner } = await start();
    expect((await post("/api/settings/provider", { provider: "claude" })).status).toBe(409);
    const ok = await post("/api/settings/provider", { provider: "chatgpt" });
    expect(((await ok.json()) as { provider: string }).provider).toBe("chatgpt");

    const res = await post("/api/tasks", { text: "寫一首詩", request_id: "req_test0003" });
    const task = (await res.json()) as Task;
    expect(task.mode).toBe("chatgpt");
    await runner.idle();
    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    expect(list.find((t) => t.task_id === task.task_id)).toMatchObject({
      status: "failed",
      error_action: "chatgpt_sign_in",
      artifact_id: null,
    });
  });

  it("語音對話：串流回覆文字並以 done 結束（模擬引擎明示未接模型）", async () => {
    const { post } = await start();
    const res = await post("/api/chat", { request_id: "req_test0004", messages: [{ role: "user", content: "你好" }] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((f) => JSON.parse(f.replace(/^data: /, "")));
    const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(text).toContain("模擬模式");
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((await post("/api/chat", { request_id: "req_test0005", messages: [] })).status).toBe(400);
  });

  it("多輪對話（5 輪）：每次交辦的工作都會開始處理，第三件起不會卡在排隊", async () => {
    // 任務要跑數秒，模擬真實引擎「交辦後還沒做完，使用者就繼續說下一件」的情境。
    const { base, post, runner } = await start(1000);
    const rounds = ["你好", "幫我寫一份專案進度報告", "再幫我整理會議紀錄", "幫我規劃下週行程", "幫我寫一封感謝客戶的信"];
    const history: { role: "user" | "assistant"; content: string }[] = [];
    const delegated: string[] = [];
    for (const [i, text] of rounds.entries()) {
      const requestId = `req_round${String(i).padStart(4, "0")}`;
      const res = await post("/api/chat", { request_id: requestId, messages: [...history, { role: "user", content: text }] });
      const events = (await res.text()).split("\n\n").filter(Boolean).map((f) => JSON.parse(f.replace(/^data: /, "")));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
      expect(answer).not.toContain("⟦");
      for (const e of events.filter((e) => e.type === "delegate")) {
        const created = await post("/api/tasks", { text: e.title, request_id: requestId });
        expect(created.status).toBe(201);
        delegated.push(((await created.json()) as Task).task_id);
      }
      history.push({ role: "user", content: text }, { role: "assistant", content: answer.trim() });
    }

    expect(delegated).toHaveLength(4);
    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    for (const id of delegated) expect(list.find((t) => t.task_id === id)?.status).toBe("running");

    await runner.idle();
    const done = (await (await fetch(`${base}/api/tasks`)).json()) as Task[];
    for (const id of delegated) expect(done.find((t) => t.task_id === id)?.status).toBe("succeeded");
  }, 20_000);

  it("即時語音：設定顯示是否可用，SDP 經本機核心轉送，API key 不出現在回應中", async () => {
    const calls: string[] = [];
    const openai = (async (url: string) => {
      calls.push(url);
      return url.endsWith("/client_secrets")
        ? new Response(JSON.stringify({ value: "ek_fixture" }), { status: 200 })
        : new Response("v=0 answer", { status: 201 });
    }) as unknown as typeof fetch;
    const { base, post } = await start(5, new RealtimeBridge({ apiKey: "sk-fixture", model: "gpt-realtime", voice: "marin", fetch: openai }));
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as { realtime?: { available: boolean } };
    expect(settings.realtime).toMatchObject({ available: true });

    expect((await post("/api/realtime/call", { sdp: "not sdp" })).status).toBe(400);
    const res = await post("/api/realtime/call", { sdp: "v=0 offer" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ sdp: "v=0 answer", model: "gpt-realtime" });
    expect(raw).not.toContain("sk-fixture");
    expect(raw).not.toContain("ek_fixture");
    expect(calls).toEqual(["https://api.openai.com/v1/realtime/client_secrets", "https://api.openai.com/v1/realtime/calls"]);
  });

  it("即時語音：沒有 OPENAI_API_KEY 時回 409 並說明", async () => {
    const { post } = await start(5, new RealtimeBridge({ apiKey: null, model: "gpt-realtime", voice: "marin" }));
    const res = await post("/api/realtime/call", { sdp: "v=0 offer" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("OPENAI_API_KEY");
  });

  it("即時語音上網查詢：驗證輸入、未設定 key 時 409、成功時回傳答案與來源且不外洩 key", async () => {
    const disabled = await start(5, undefined, new WebSearch({ apiKey: null, model: "m", country: "TW", timezone: "Asia/Taipei" }));
    expect((await disabled.post("/api/realtime/web-search", { query: "" })).status).toBe(400);
    expect((await disabled.post("/api/realtime/web-search", { query: "新竹天氣" })).status).toBe(409);
    await new Promise((r) => server!.close(r));

    const openai = (async () =>
      new Response(
        JSON.stringify({ model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "多雲（fixture）", annotations: [] }] }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const { post } = await start(5, undefined, new WebSearch({ apiKey: "sk-fixture", model: "m", country: "TW", timezone: "Asia/Taipei", fetch: openai }));
    const res = await post("/api/realtime/web-search", { query: "新竹天氣" });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({ ok: true, answer: "多雲（fixture）", sources: [] });
    expect(raw).not.toContain("sk-fixture");
  });

  it("前端未建置時回傳說明而不是空白頁", async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("npm start");
  });
});
