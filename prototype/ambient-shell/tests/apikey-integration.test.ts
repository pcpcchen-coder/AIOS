import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { CodexAuth } from "../server/codex-auth.ts";
import { CodexResponses } from "../server/codex-responses.ts";
import { LiveRoute } from "../server/live-route.ts";
import { LiveToolCaller } from "../server/live-tool-caller.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { buildLiveInstructions } from "../server/realtime.ts";
import type { SessionContext } from "../server/realtime-routes.ts";
import { RealtimeSettingsStore } from "../server/realtime-settings.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { WebSearch } from "../server/web-search.ts";
import type { CallAnswer, StartDecision } from "../shared/realtime-route.ts";
import type { MemoryFactView } from "../shared/memory.ts";
import { ga, gaBridge, until } from "./fixtures/apikey.ts";
import { scriptedFetch, writeCredentials } from "./fixtures/fake-chatgpt.ts";
import { startFakeGa, type FakeGa } from "./fixtures/fake-sideband.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CLAUDE, CODEX, enable, harness, manage, OPENAI_RT, type Harness } from "./fixtures/memory-service.ts";
import { ApiKeyRoute } from "../server/realtime-routes.ts";

// MEM-3 端到端（全部 fixture）：本機核心 ↔ 真的 SSE 串流 ↔ 假的頁面；假的 GA 伺服器（REST＋旁路 WebSocket）、
// 假的 chatgpt.com（live 失敗改用 API key）、真 AES-GCM 記憶。驗證交辦途中忘記、晚到的工具結果、停播回報、重建走同一條路徑、
// 改路徑時的同意，以及 canary 只出現在旁路與 IPC。不是 Mac gate。全部是虛構人物與內容。

// 不含 KEY、TOKEN 之類的字（parser 會把它當成敏感資料拒絕保存）。
const CANARY = "MEM3_GA_CANARY_七三九";

let server: Server | null = null;
let fake: FakeGa | null = null;
const aborts: AbortController[] = [];
const dirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  server = null;
  await fake?.close();
  fake = null;
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** 假的頁面：一條真的 SSE 串流，記錄每一個 frame。 */
async function page(base: string) {
  const controller = new AbortController();
  aborts.push(controller);
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          frames.push(frame);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as Record<string, unknown>);
        }
      }
    } catch {
      // 頁面關閉
    }
  })();
  const waitFor = async (predicate: (e: Record<string, unknown>) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(predicate);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`no matching SSE event; got ${events.map((e) => e.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const hello = await waitFor((e) => e.type === "hello");
  return { frames, events, waitFor, clientId: hello.client_id as string, close: () => controller.abort() };
}

const liveEvent = (kind: string) => (e: Record<string, unknown>) => e.type === "realtime.live" && (e.event as { kind: string }).kind === kind;

async function memoryHarness(allow = [CLAUDE, OPENAI_RT, CODEX]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "nous-mem3-int-"));
  dirs.push(dir);
  const h = harness({ dir, key: randomBytes(32), live: CODEX, apiKey: OPENAI_RT, release: { api_key: true } });
  harnesses.push(h);
  await enable(h, "George", allow);
  return h;
}

async function start(h: Harness, options: { route?: "auto" | "live" | "api_key"; liveFails?: boolean } = {}) {
  fake = await startFakeGa();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "nous-mem3-app-"));
  dirs.push(dir);
  writeCredentials(dir);
  const logs: string[] = [];
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
  const store = new TaskStore(null);
  const siwc = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(siwc, { model: null }), mock: new MockExecutor(5), auth: siwc, dir, preferred: "mock", onChange: () => {} });
  const runner = new TaskRunner(store, providers);
  let notify = () => {};
  const codexAuth = new CodexAuth({ dir, onChange: () => notify(), fetch: scriptedFetch(() => new Response("{}", { status: 500 })).fetch, log: (l) => logs.push(l) });
  const codex = new CodexResponses(codexAuth, { model: null, clientVersion: "0.1.0", turnTimeoutMs: 20_000, baseUrl: "https://chatgpt.fixture/backend-api/codex", fetch: scriptedFetch(() => new Response("no", { status: 500 })).fetch });
  const webSearch = new WebSearch({ apiKey: fake.apiKey, model: "m", country: "TW", timezone: "Asia/Taipei", codex });
  // live 失敗（503，可以改路徑）或成功。
  const callFetch = scriptedFetch(() => (options.liveFails ? new Response("unavailable", { status: 503 }) : new Response("v=0 live-answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_live" } })));
  const prefs = new RealtimeSettingsStore({ dir, defaults: { route: options.route ?? "api_key", live_voice: "cove" }, onChange: () => notify(), log: () => {} });
  const caps = () => ({ webSearch: true, mcp: [], taskWebSearch: true, home: false });
  const live = new LiveRoute({
    auth: codexAuth,
    voice: () => prefs.view().live_voice,
    model: { display: "gpt-live-1-codex", send: null },
    caller: (ctx, mem) => new LiveToolCaller({ responses: codex, caps: () => ({ ...caps(), memory: !!mem }), host: ctx.host, tasks: ctx.tasks, approval: ctx.approval, now: ctx.now, ...(mem ? { memory: mem } : {}) }),
    instructions: (ctx, memoryOn) => buildLiveInstructions(ctx.tasks(), new Date(), { mcp: [], memory: !!memoryOn }),
    memory: (ctx: SessionContext) => h.service.openLive({ lookToTalk: !!ctx.lookToTalk, rebuild: !!ctx.rebuild, now: ctx.now, locale: ctx.locale }),
    capabilities: () => ({ webSearch: true, home: false }),
    clientVersion: "0.1.0",
    fetch: callFetch.fetch,
    urls: { call: "https://chatgpt.fixture/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas", sideband: (id) => `ws://127.0.0.1:1/never/${id}` },
    sleep: async () => {},
    log: (l) => logs.push(l),
  });
  const bridge = gaBridge(fake);
  const apiKey = new ApiKeyRoute(bridge, true, "marin", {
    memory: (ctx) => h.service.openVoice("api_key", { lookToTalk: !!ctx.lookToTalk, rebuild: !!ctx.rebuild, now: ctx.now, locale: ctx.locale, approvalOpen: () => ctx.approval().open }),
    log: (l) => logs.push(l),
  });
  const app = createApp({ store, runner, settings: providers, auth: siwc, chat: providers, realtime: bridge, realtimeRoutes: { live, api_key: apiKey }, realtimePrefs: prefs, codexAuth, webSearch, port, devPort: 5173, distDir: null });
  notify = app.notifySettings;
  server = app;
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const bodies: string[] = [];
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: JSON.parse(text || "{}") as Record<string, unknown> };
  };
  const get = async (path: string) => {
    const text = await (await fetch(base + path)).text();
    bodies.push(text);
    return text;
  };
  return { base, post, get, bodies, logs, store, prefs, fake: fake! };
}

function scanDir(dir: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...scanDir(path));
    else if (readFileSync(path).includes(Buffer.from(CANARY))) hits.push(path);
  }
  return hits;
}

describe.skipIf(!realLockAvailable)("MEM-3 API key memory end to end (fixture)", () => {
  it("forget during a delegation: hold, revoke, hangup, late host-result refused, web-search 403, stop report, rebuild on the same route without the canary; canary only on the sideband and IPC", async () => {
    const h = await memoryHarness();
    await h.turn(`記住，我喜歡${CANARY}色`);
    const t = await start(h, { route: "api_key" });
    const p = await page(t.base);
    const other = await page(t.base);
    const decision = (await t.post("/api/realtime/start", { client_id: p.clientId })).json as StartDecision;
    if (!decision.ok) throw new Error(decision.message);
    expect(decision.route).toBe("api_key");
    const ticket = { session_id: decision.session_id, owner: decision.owner };
    const answer = (await t.post("/api/realtime/call", { sdp: "v=0 offer", ...ticket })).json as unknown as CallAnswer;
    expect(answer).toMatchObject({ sdp: "v=0 ga-answer", route: "api_key", core_tools: ["recall_memory", "delegate_task"], memory: { used: 0, reason: "no_pinned" } });
    const conn = await t.fake.next();
    const update = await conn.waitFor((e) => e.type === "session.update");
    expect(JSON.stringify(update)).not.toContain(CANARY);

    // 「你記得我什麼？」：內容只經 IPC card_view。
    ga.user(conn, "你記得我什麼？");
    const card = await p.waitFor(liveEvent("memory_card"));
    const view = await h.call({ op: "card_view", card: (card.event as { card: string }).card });
    expect(JSON.stringify(view)).toContain(CANARY);

    // 交辦（還沒帶記憶）：核心經 SSE 請頁面照常交辦；頁面還沒回。
    ga.user(conn, "幫我整理一份顏色報告");
    ga.functionCall(conn, "delegate_task", { title: "整理顏色報告" });
    const host = await p.waitFor((e) => e.type === "realtime.host");
    const callId = (host.call as { call_id: string }).call_id;
    // 模型查記憶：結果經旁路交回（canary 允許出現在這裡），這通從此帶著記憶。
    ga.functionCall(conn, "recall_memory", { query: "七三九色" });
    const output = await conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output" && String((e.item as { output: string }).output).includes(CANARY));
    expect(output).toBeTruthy();

    // 交辦途中忘記 canary（記憶管理）。
    const token = await manage(h);
    const fact = ((await h.call({ op: "list" })).facts as MemoryFactView[]).find((f) => f.text.includes(CANARY))!;
    expect(await h.call({ op: "forget", id: fact.id, revision: fact.revision, token })).toMatchObject({ ok: true, receipt: { status: "forgotten" } });
    const hold = await p.waitFor(liveEvent("hold"));
    const closed = await p.waitFor(liveEvent("closed"));
    expect(p.events.indexOf(hold)).toBeLessThan(p.events.indexOf(closed));
    expect(closed.event).toMatchObject({ reason: "memory_revoked", rebuild: true });
    await until(() => t.fake.hangups.length > 0);
    expect(t.fake.hangups).toEqual(["rtc_test"]);
    await conn.waitClosed();
    const sentAtClose = conn.received.length;
    // 晚到的工具結果：不交給任何人；查詢回 403。
    expect(await t.post("/api/realtime/host-result", { ...ticket, call_id: callId, output: { ok: true, task: `顏色（${CANARY}）` } })).toMatchObject({ status: 200, json: { accepted: false } });
    expect((await t.post("/api/realtime/web-search", { query: "明天天氣", ...ticket })).status).toBe(403);
    // 停播回報（擁有者才行）。
    expect((await t.post("/api/realtime/stopped", { ...ticket, owner: "own_" + "x".repeat(32), evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 4 } })).status).toBe(403);
    expect(await t.post("/api/realtime/stopped", { ...ticket, evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 4 } })).toMatchObject({ json: { accepted: true } });
    expect(conn.received.length).toBe(sentAtClose);

    // 重建：偏好改成 live 也走被撤銷那通的路徑（api_key），沒有備援、不發互動 ID；新的旁路不含被忘記的 canary。
    await t.post("/api/settings/realtime", { route: "live" });
    const rebuilt = (await t.post("/api/realtime/start", { client_id: p.clientId, rebuild: true, source: "look_to_talk" })).json as StartDecision;
    expect(rebuilt).toMatchObject({ ok: true, route: "api_key", interaction: null });
    if (!rebuilt.ok) throw new Error("rebuild refused");
    expect((await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: rebuilt.session_id, owner: rebuilt.owner })).status).toBe(200);
    const conn2 = await t.fake.next();
    const update2 = await conn2.waitFor((e) => e.type === "session.update");
    expect(JSON.stringify(update2)).not.toContain(CANARY);

    // canary：不在 SSE、log、TaskStore、/call 回應、/api/settings、任何 HTTP 回應或記憶資料夾的明文。
    const settings = await t.get("/api/settings");
    p.close();
    other.close();
    expect(p.frames.join("\n")).not.toContain(CANARY);
    expect(other.frames.join("\n")).not.toContain(CANARY);
    expect(t.logs.join("\n")).not.toContain(CANARY);
    expect(JSON.stringify(t.store.list())).not.toContain(CANARY);
    expect(settings).not.toContain(CANARY);
    expect(t.bodies.join("\n")).not.toContain(CANARY);
    expect(scanDir(dirs[0]!)).toEqual([]);
    // 上游的 REST 請求（client secret、calls）也不帶 canary：記憶只經旁路。
    expect(t.fake.requests.map((r) => r.body).join("\n")).not.toContain(CANARY);
  });

  it("pinned canary: only in the sideband's session.update; never in SSE, logs, the /call answer or the REST requests", async () => {
    const h = await memoryHarness();
    await h.turn(`記住，我喜歡${CANARY}色`);
    const token = await manage(h);
    for (const f of (await h.call({ op: "list", token })).facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
    const t = await start(h);
    const p = await page(t.base);
    const decision = (await t.post("/api/realtime/start", { client_id: p.clientId })).json as StartDecision;
    if (!decision.ok) throw new Error(decision.message);
    const answer = await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: decision.session_id, owner: decision.owner });
    expect(answer.json).toMatchObject({ memory: { used: 1, reason: null } });
    const conn = await t.fake.next();
    expect(JSON.stringify(await conn.waitFor((e) => e.type === "session.update"))).toContain(CANARY);
    // 模型念出來的逐字稿只在旁路與頁面自己的資料通道，核心不轉送（API key 路徑沒有 transcript 事件）。
    ga.assistant(conn, `你喜歡${CANARY}色`);
    await new Promise((r) => setTimeout(r, 50));
    await t.post("/api/realtime/end", { session_id: decision.session_id, owner: decision.owner });
    await conn.waitClosed();
    p.close();
    expect(p.frames.join("\n")).not.toContain(CANARY);
    expect([...t.logs, ...t.bodies].join("\n")).not.toContain(CANARY);
    expect(t.fake.requests.map((r) => r.body).join("\n")).not.toContain(CANARY);
  });
});

describe.skipIf(!realLockAvailable)("MEM-3 live → API key fallback", () => {
  it("live fails at start: its memory binding is released; codex consent alone gives the API key call no memory (no_consent)", async () => {
    const h = await memoryHarness([CLAUDE, CODEX]);
    await h.turn("記住，我不吃香菜");
    const token = await manage(h);
    for (const f of (await h.call({ op: "list", token })).facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
    const t = await start(h, { route: "auto", liveFails: true });
    const p = await page(t.base);
    const decision = (await t.post("/api/realtime/start", { client_id: p.clientId, source: "look_to_talk" })).json as StartDecision;
    if (!decision.ok) throw new Error(decision.message);
    expect(decision.route).toBe("live");
    const failed = await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: decision.session_id, owner: decision.owner });
    expect(failed.status).toBe(409);
    const offer = (failed.json as { fallback: { session_id: string; owner: string; route: string } }).fallback;
    expect(offer.route).toBe("api_key");
    const answer = await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: offer.session_id, owner: offer.owner });
    expect(answer.json).toMatchObject({ route: "api_key", memory: { used: 0, reason: "no_consent" }, core_tools: [] });
    expect(t.fake.upgrades).toBe(0);
    p.close();
  });

  it("with both consents the API key call after a live failure carries the same pinned memory (M02)", async () => {
    const h = await memoryHarness();
    await h.turn("記住，我不吃香菜");
    const token = await manage(h);
    for (const f of (await h.call({ op: "list", token })).facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
    const t = await start(h, { route: "auto", liveFails: true });
    const p = await page(t.base);
    const decision = (await t.post("/api/realtime/start", { client_id: p.clientId })).json as StartDecision;
    if (!decision.ok) throw new Error(decision.message);
    const failed = await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: decision.session_id, owner: decision.owner });
    const offer = (failed.json as { fallback: { session_id: string; owner: string } }).fallback;
    const answer = await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: offer.session_id, owner: offer.owner });
    expect(answer.json).toMatchObject({ route: "api_key", memory: { used: 1, reason: null } });
    const conn = await t.fake.next();
    expect(JSON.stringify(await conn.waitFor((e) => e.type === "session.update"))).toContain("不吃香菜");
    p.close();
  });
});
