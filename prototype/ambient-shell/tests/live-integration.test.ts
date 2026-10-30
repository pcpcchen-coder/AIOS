import { mkdtempSync } from "node:fs";
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
import { COMMANDS_PATH } from "../server/commands-page.ts";
import { LiveRoute } from "../server/live-route.ts";
import { LiveToolCaller } from "../server/live-tool-caller.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { buildLiveInstructions, RealtimeBridge } from "../server/realtime.ts";
import { ApiKeyRoute, type SessionContext } from "../server/realtime-routes.ts";
import { RealtimeSettingsStore } from "../server/realtime-settings.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { WebSearch } from "../server/web-search.ts";
import type { StartDecision } from "../shared/realtime-route.ts";
import { codexTurn, scriptedFetch, sseResponse, SECRET_TOKEN_MARK, writeCredentials } from "./fixtures/fake-chatgpt.ts";
import { startFakeSideband, type FakeConnection, type FakeSideband } from "./fixtures/fake-sideband.ts";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CODEX, enable, harness, manage, type Harness } from "./fixtures/memory-service.ts";

// 端到端（全部 fixture）：本機核心 ↔ 真的 SSE 串流 ↔ 假的頁面；假的 chatgpt.com、假的 sideband、假的 OpenAI。
// 驗證 host RPC 走真的 SSE、擁有者規則、頁面離開與 sideband 掉線，以及權杖不出現在任何 HTTP、SSE 或 log。

let server: Server | null = null;
let sideband: FakeSideband | null = null;
const aborts: AbortController[] = [];

afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  server = null;
  await sideband?.close();
  sideband = null;
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
  const waiters: (() => void)[] = [];
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
          for (const w of waiters.splice(0)) w();
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
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const hello = await waitFor((e) => e.type === "hello");
  return { frames, events, waitFor, clientId: hello.client_id as string, close: () => controller.abort() };
}

async function start(options: { turns?: Response[]; memory?: Harness; audio?: { setMuted(muted: boolean): void }; dropStopReport?: boolean } = {}) {
  sideband = await startFakeSideband();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "nous-live-int-"));
  const creds = writeCredentials(dir);
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
  const turns = [...(options.turns ?? [])];
  const codexFetch = scriptedFetch((req) => {
    if (req.url.includes("/models")) return new Response(JSON.stringify({ models: [{ slug: "gpt-fixture-codex", visibility: "list", priority: 1 }] }));
    return turns.shift() ?? new Response("no more turns", { status: 500 });
  });
  const codex = new CodexResponses(codexAuth, { model: null, clientVersion: "0.1.0", turnTimeoutMs: 20_000, baseUrl: "https://chatgpt.fixture/backend-api/codex", fetch: codexFetch.fetch });
  const webSearch = new WebSearch({ apiKey: null, model: "m", country: "TW", timezone: "Asia/Taipei", codex });
  const callFetch = scriptedFetch(() => new Response("v=0 live-answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_int" } }));
  const prefs = new RealtimeSettingsStore({ dir, defaults: { route: "auto", live_voice: "cove" }, onChange: () => notify(), log: () => {} });
  const caps = () => ({ webSearch: true, mcp: [], taskWebSearch: true, home: true });
  const live = new LiveRoute({
    auth: codexAuth,
    voice: () => prefs.view().live_voice,
    model: { display: "gpt-live-1-codex", send: null },
    caller: (ctx, mem) => new LiveToolCaller({ responses: codex, caps: () => ({ ...caps(), memory: !!mem }), host: ctx.host, tasks: ctx.tasks, approval: ctx.approval, now: ctx.now, log: (l) => logs.push(l), ...(mem ? { memory: mem } : {}) }),
    instructions: (ctx, memoryOn) => buildLiveInstructions(ctx.tasks(), new Date(), { mcp: [], memory: !!memoryOn }),
    ...(options.memory ? { memory: (ctx: SessionContext) => options.memory!.service.openLive({ lookToTalk: !!ctx.lookToTalk, rebuild: !!ctx.rebuild, now: ctx.now, locale: ctx.locale }) } : {}),
    capabilities: () => ({ webSearch: true, home: true }),
    clientVersion: "0.1.0",
    fetch: callFetch.fetch,
    urls: { call: "https://chatgpt.fixture/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas", sideband: (id) => sideband!.url(id) },
    sleep: async () => {},
    log: (l) => logs.push(l),
  });
  const openaiKey = `sk-${SECRET_TOKEN_MARK}-fixture`;
  const bridge = new RealtimeBridge({
    apiKey: openaiKey,
    model: "gpt-realtime",
    voice: "marin",
    fetch: (async (url: string) => (String(url).endsWith("/client_secrets") ? new Response(JSON.stringify({ value: `ek_${SECRET_TOKEN_MARK}` })) : new Response("v=0 ga-answer", { status: 201 }))) as unknown as typeof fetch,
  });
  const app = createApp({
    store,
    runner,
    settings: providers,
    auth: siwc,
    chat: providers,
    realtime: bridge,
    realtimeRoutes: { live, api_key: new ApiKeyRoute(bridge, true, "marin") },
    realtimePrefs: prefs,
    codexAuth,
    webSearch,
    realtimeAudio: options.audio,
    dropStopReport: options.dropStopReport,
    port,
    devPort: 5173,
    distDir: null,
  });
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
  return { base, post, get, bodies, logs, creds, openaiKey, prefs, codexFetch, callFetch, store };
}

async function startLive(t: Awaited<ReturnType<typeof start>>, clientId: string): Promise<{ decision: Extract<StartDecision, { ok: true }>; conn: FakeConnection }> {
  const decision = (await t.post("/api/realtime/start", { client_id: clientId })).json as StartDecision;
  if (!decision.ok) throw new Error(decision.message);
  expect(decision).toMatchObject({ route: "live", billing_line: "ChatGPT 方案（Codex 額度）· gpt-live-1-codex", notice: null });
  const call = await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: decision.session_id, owner: decision.owner });
  expect(call).toMatchObject({ status: 200, json: { sdp: "v=0 live-answer", route: "live" } });
  return { decision, conn: await sideband!.next() };
}

describe("live route end to end (fixture)", () => {
  it("delegation → host call over real SSE → shared executor on the page → Codex web search → speakable append; no token anywhere", async () => {
    const t = await start({
      turns: [
        codexTurn({ calls: [{ name: "web_search", arguments: { query: "新竹今天降雨機率" }, call_id: "call_ws" }] }),
        // WebSearch via codex（hosted web_search）
        sseResponse([
          { type: "response.output_text.delta", delta: "新竹今天降雨機率 20%（fixture）" },
          { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "新竹今天降雨機率 20%（fixture）", annotations: [{ type: "url_citation", url: "https://example.org/cwa", title: "中央氣象署（fixture）" }] }] } },
          { type: "response.completed", response: { model: "gpt-fixture-codex" } },
        ]),
        codexTurn({ text: "新竹今天降雨機率大約兩成，應該不太會下雨。" }),
      ],
    });
    const p = await page(t.base);
    const { decision, conn } = await startLive(t, p.clientId);
    const ticket = { session_id: decision.session_id, owner: decision.owner };
    conn.send({ type: "session.started", session: { expires_at: Math.floor(Date.now() / 1000) + 600 } });
    conn.send({ type: "turn.done", turn: { role: "user", transcript: "新竹今天會下雨嗎", id: "u1" } });
    conn.send({ type: "delegation.created", item: { type: "delegation", target: "client", id: "del_ws", content: [{ type: "input_text", text: "新竹今天會下雨嗎" }] } });

    const host = (await p.waitFor((e) => e.type === "realtime.host")) as { session_id: string; call: { call_id: string; name: string; arguments: string } };
    expect(host.session_id).toBe(decision.session_id);
    expect(host.call.name).toBe("web_search");
    // 頁面跑共用的執行器：它呼叫 /api/realtime/web-search（帶工作階段憑證 → Codex 額度）。
    const search = await t.post("/api/realtime/web-search", { query: JSON.parse(host.call.arguments).query, ...ticket });
    expect(search).toMatchObject({ status: 200, json: { ok: true, sources: [{ title: "中央氣象署（fixture）" }] } });
    const posted = await t.post("/api/realtime/host-result", { ...ticket, call_id: host.call.call_id, output: { ok: true, answer: search.json.answer, sources: ["中央氣象署（fixture）"] } });
    expect(posted.json).toMatchObject({ ok: true, accepted: true });

    const append = await conn.waitFor((e) => e.type === "delegation.context.append");
    expect(append).toMatchObject({ delegation_item_id: "del_ws", channel: "speakable", content: [{ type: "input_text", text: "新竹今天降雨機率大約兩成，應該不太會下雨。" }] });
    await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string; state?: string }).state === "finished");
    expect(p.events).toContainEqual(expect.objectContaining({ type: "realtime.live", event: { kind: "transcript", role: "user", text: "新竹今天會下雨嗎", final: true, item_id: "u1" } }));
    // 第二次交回同一個 call_id：丟掉（不會執行兩次）。
    expect((await t.post("/api/realtime/host-result", { ...ticket, call_id: host.call.call_id, output: { ok: true } })).json).toMatchObject({ accepted: false });

    const settings = JSON.parse(await t.get("/api/settings")) as { realtime: Record<string, unknown> };
    expect(settings.realtime).toMatchObject({ route: "live", billing_line: "ChatGPT 方案（Codex 額度）· gpt-live-1-codex", active: { route: "live" }, live_account: { signed_in: true, email: "george@example.com" } });
    await t.get(COMMANDS_PATH);
    await t.post("/api/realtime/input", { ...ticket, kind: "notice", text: "報告做好了" });
    await t.post("/api/realtime/end", ticket);
    await conn.waitFor((e) => e.type === "session.close");

    // 也跑一次 API key 路徑，讓它的 key 有機會出現在輸出裡。
    await t.post("/api/settings/realtime", { route: "api_key" });
    const ga = (await t.post("/api/realtime/start", { client_id: p.clientId })).json as StartDecision;
    if (!ga.ok) throw new Error("expected api_key start");
    expect(await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: ga.session_id, owner: ga.owner })).toMatchObject({ status: 200, json: { route: "api_key" } });

    // 權杖、帳號 ID、API key、client secret 都不在任何 HTTP 回應、SSE frame 或 log 裡。
    const everything = [...t.bodies, ...p.frames, ...t.logs].join("\n");
    expect(everything.length).toBeGreaterThan(1000);
    for (const secret of [t.creds.access, t.creds.refresh, t.creds.account, t.openaiKey, `ek_${SECRET_TOKEN_MARK}`, SECRET_TOKEN_MARK]) expect(everything).not.toContain(secret);
    // 但上游請求確實帶了（Codex 額度的上網查詢用 Codex 登入）。
    expect(t.codexFetch.calls.some((c) => c.headers.authorization === `Bearer ${t.creds.access}`)).toBe(true);
  });

  it("owner rules: only the starting page's token works; a wrong owner gets 403", async () => {
    const t = await start();
    const p = await page(t.base);
    const { decision } = await startLive(t, p.clientId);
    const wrong = { session_id: decision.session_id, owner: "own_aaaaaaaaaaaaaaaaaaaaaaaa" };
    expect((await t.post("/api/realtime/input", { ...wrong, kind: "notice", text: "x" })).status).toBe(403);
    expect((await t.post("/api/realtime/host-result", { ...wrong, call_id: `hc_${"0".repeat(32)}`, output: {} })).status).toBe(403);
    expect((await t.post("/api/realtime/end", wrong)).status).toBe(403);
    expect((await t.post("/api/realtime/web-search", { query: "x", ...wrong })).status).toBe(403);
  });

  it("POST /api/realtime/approval needs the card timeout on open and the outcome on resolved", async () => {
    const t = await start();
    const p = await page(t.base);
    const { decision } = await startLive(t, p.clientId);
    const ticket = { session_id: decision.session_id, owner: decision.owner };
    expect((await t.post("/api/realtime/approval", { ...ticket, state: "open" })).status).toBe(400);
    expect((await t.post("/api/realtime/approval", { ...ticket, state: "resolved" })).status).toBe(400);
    expect((await t.post("/api/realtime/approval", { ...ticket, state: "resolved", outcome: "pressed" })).status).toBe(400);
    expect((await t.post("/api/realtime/approval", { ...ticket, state: "open", timeout_ms: 60_000 })).status).toBe(200);
    expect((await t.post("/api/realtime/approval", { ...ticket, state: "resolved", outcome: "timeout" })).status).toBe(200);
  });

  it("reload: the owning SSE stream closes → session ends at once, the pending host call is rejected, and a new page can start right away", async () => {
    const t = await start({ turns: [codexTurn({ calls: [{ name: "home_status", arguments: { target: "客廳" } }] })] });
    const p = await page(t.base);
    const { conn } = await startLive(t, p.clientId);
    conn.send({ type: "delegation.created", item: { type: "delegation", target: "client", id: "del_h", content: [{ type: "input_text", text: "客廳幾度" }] } });
    await p.waitFor((e) => e.type === "realtime.host");
    p.close(); // 頁面重新整理：串流關閉，沒有回覆工具
    await conn.waitFor((e) => e.type === "session.close");
    await conn.waitClosed();
    expect(conn.received.filter((e) => e.type === "delegation.context.append")).toEqual([]);
    const next = await page(t.base);
    const again = (await t.post("/api/realtime/start", { client_id: next.clientId })).json as StartDecision;
    expect(again).toMatchObject({ ok: true, route: "live" });
  });

  it("a sideband drop reaches the page as closed connection_lost; the session is gone", async () => {
    const t = await start();
    const p = await page(t.base);
    const { decision, conn } = await startLive(t, p.clientId);
    conn.drop();
    const closed = await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "closed");
    expect(closed.event).toMatchObject({ reason: "connection_lost" });
    expect((await t.post("/api/realtime/input", { session_id: decision.session_id, owner: decision.owner, kind: "notice", text: "x" })).status).toBe(404);
    const settings = JSON.parse(await t.get("/api/settings")) as { realtime: { active: unknown } };
    expect(settings.realtime.active).toBeNull();
  });

  it("switching the route during a live session keeps it; the change applies to the next start", async () => {
    const t = await start();
    const p = await page(t.base);
    const { decision } = await startLive(t, p.clientId);
    const view = (await t.post("/api/settings/realtime", { route: "api_key" })).json as { realtime: Record<string, unknown> };
    expect(view.realtime).toMatchObject({ preference: "api_key", route: "api_key", billing_line: "OpenAI API key 計費 · gpt-realtime", active: { route: "live", billing_line: "ChatGPT 方案（Codex 額度）· gpt-live-1-codex" } });
    expect(await p.waitFor((e) => e.type === "settings.updated")).toBeTruthy();
    expect((await t.post("/api/settings/realtime", { route: "nope" })).status).toBe(400);
    await t.post("/api/realtime/end", { session_id: decision.session_id, owner: decision.owner });
    expect(((await t.post("/api/realtime/start", { client_id: p.clientId })).json as StartDecision)).toMatchObject({ ok: true, route: "api_key", notice: null });
  });
});

// ─────────────── MEM-2：記憶在 live 路徑上的端到端（真 HTTP、真 SSE、假 sideband、真 AES-GCM 記憶） ───────────────

const CANARY = "MEM2_LIVE_CANARY_五八一";

function scanDir(dir: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...scanDir(path));
    else if (readFileSync(path).includes(Buffer.from(CANARY))) hits.push(path);
  }
  return hits;
}

describe.skipIf(!realLockAvailable)("MEM-2 live memory end to end (fixture)", () => {
  const dirs: string[] = [];
  const harnesses: Harness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.close()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function georgeWithCanary(): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), "nous-mem2-int-"));
    dirs.push(dir);
    const h = harness({ dir, key: randomBytes(32), live: CODEX });
    harnesses.push(h);
    await enable(h, "George", [CODEX]);
    await h.turn(`記住，我喜歡${CANARY}色`);
    await h.turn("記住，我不吃香菜");
    const token = await manage(h);
    for (const f of (await h.call({ op: "list" })).facts as { id: string; revision: number }[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
    const status = (await h.call({ op: "status" })) as unknown as { profiles: { id: string }[] };
    await h.call({ op: "select", profile: status.profiles[0]!.id, token });
    return h;
  }

  it("forget during a delegation: hold, revoke, session.close, late host-result refused, stop report, rebuild without the forgotten canary; canary only in consented payloads", async () => {
    const h = await georgeWithCanary();
    const logs: string[] = [];
    (h.service as unknown as { log: (l: string) => void }).log = (l) => logs.push(l);
    const muted: boolean[] = [];
    const t = await start({ memory: h, audio: { setMuted: (m) => void muted.push(m) }, turns: [codexTurn({ calls: [{ name: "web_search", arguments: { query: "明天台北天氣" }, call_id: "call_ws" }] })] });
    const p = await page(t.base);
    const other = await page(t.base);
    const { decision, conn } = await startLive(t, p.clientId);
    // 已同意的 codex：連線時的記憶包在 /calls 的 instructions 裡（canary 只允許出現在這裡與 Codex Responses）。
    expect(JSON.parse(t.callFetch.calls[0]!.body).session.instructions).toContain(CANARY);
    conn.send({ type: "session.started", session: {} });
    await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "memory");
    // 模型念出記憶（助理逐字稿含 canary）：只送到擁有這通的頁面當字幕，不廣播、不進 log。
    conn.send({ type: "turn.done", turn: { role: "assistant", transcript: `你喜歡${CANARY}色`, id: "a0" } });
    conn.send({ type: "turn.done", turn: { role: "user", transcript: "查一下明天台北天氣", id: "u1" } });
    // 交辦文字含 canary（模型把記憶寫進交辦）：帶著記憶的通話 log 只記長度。
    conn.send({ type: "delegation.created", item: { type: "delegation", target: "client", id: "d1", content: [{ type: "input_text", text: `查明天台北天氣，順便提${CANARY}` }] } });
    const host = await p.waitFor((e) => e.type === "realtime.host");
    const callId = (host.call as { call_id: string }).call_id;

    // 交辦途中忘記那筆 canary（記憶管理的「忘記」）。
    const token = await manage(h);
    const fact = ((await h.call({ op: "list" })).facts as { id: string; revision: number; text: string }[]).find((f) => f.text.includes(CANARY))!;
    expect(await h.call({ op: "forget", id: fact.id, revision: fact.revision, token })).toMatchObject({ ok: true, receipt: { status: "forgotten" } });
    const hold = await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "hold");
    const closed = await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "closed");
    expect(p.events.indexOf(hold)).toBeLessThan(p.events.indexOf(closed));
    expect(closed.event).toMatchObject({ reason: "memory_revoked", rebuild: true });
    await conn.waitFor((e) => e.type === "session.close");
    const appendsAtClose = conn.received.filter((e) => String(e.type).endsWith("context.append")).length;
    // 晚到的工具結果：不交給任何人。
    const late = await t.post("/api/realtime/host-result", { session_id: decision.session_id, owner: decision.owner, call_id: callId, output: { ok: true, answer: `明天晴（${CANARY}）` } });
    expect(late).toMatchObject({ status: 200, json: { ok: true, accepted: false } });
    // 頁面停播後回報（擁有者才行）。
    expect((await t.post("/api/realtime/stopped", { session_id: decision.session_id, owner: "own_" + "x".repeat(32), evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 9 } })).status).toBe(403);
    expect(await t.post("/api/realtime/stopped", { session_id: decision.session_id, owner: decision.owner, evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 9 } })).toMatchObject({ status: 200, json: { accepted: true } });
    await new Promise((r) => setTimeout(r, 30));
    expect(conn.received.filter((e) => String(e.type).endsWith("context.append")).length).toBe(appendsAtClose);
    expect(muted).toEqual([]);

    // 重建：只走 live、不發互動 ID；新的 /calls 不含被忘記的 canary；第一句是固定句。
    const rebuilt = (await t.post("/api/realtime/start", { client_id: p.clientId, rebuild: true, source: "look_to_talk" })).json as StartDecision;
    expect(rebuilt).toMatchObject({ ok: true, route: "live", interaction: null });
    if (!rebuilt.ok) throw new Error("rebuild refused");
    expect((await t.post("/api/realtime/call", { sdp: "v=0 offer", session_id: rebuilt.session_id, owner: rebuilt.owner })).status).toBe(200);
    const second = JSON.parse(t.callFetch.calls[1]!.body).session.instructions as string;
    expect(second).not.toContain(CANARY);
    expect(second).toContain("不吃香菜");
    const conn2 = await sideband!.next();
    conn2.send({ type: "session.started", session: {} });
    const first = await conn2.waitFor((e) => e.type === "session.context.append");
    expect(first).toMatchObject({ channel: "speakable", content: [{ text: "（記憶確認）「好，已經更新了。」" }] });

    // canary：不在 SSE、log、TaskStore、/api/settings、任何 HTTP 回應或記憶資料夾的明文。
    const settings = await t.get("/api/settings");
    expect(p.frames.join("\n")).toContain(CANARY); // 擁有這通的頁面看得到模型念出的字幕
    p.close();
    other.close();
    expect(other.frames.join("\n")).not.toContain(CANARY);
    expect([...t.logs, ...logs].some((l) => l.includes("收到交辦（"))).toBe(true);
    expect(p.frames.filter((f) => !f.includes('"kind":"transcript"')).join("\n")).not.toContain(CANARY);
    expect([...t.logs, ...logs].join("\n")).not.toContain(CANARY);
    expect(JSON.stringify(t.store.list())).not.toContain(CANARY);
    expect(settings).not.toContain(CANARY);
    expect(t.bodies.join("\n")).not.toContain(CANARY);
    expect(scanDir(dirs[0]!)).toEqual([]);
  });

  it("no stop report (test flag NOUS_TEST_DROP_STOP_REPORT): forced silence after 1.5 s, a separate notice, and no memory on the next call", async () => {
    const h = await georgeWithCanary();
    const muted: boolean[] = [];
    const t = await start({ memory: h, audio: { setMuted: (m) => void muted.push(m) }, dropStopReport: true });
    const p = await page(t.base);
    const { decision, conn } = await startLive(t, p.clientId);
    conn.send({ type: "session.started", session: {} });
    await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "memory");
    const status = (await h.call({ op: "status" })) as unknown as { presence: { select_card: string } };
    await h.call({ op: "select", profile: null, card: status.presence.select_card });
    await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "closed");
    const started = Date.now();
    expect(await t.post("/api/realtime/stopped", { session_id: decision.session_id, owner: decision.owner, evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 3 } })).toMatchObject({ json: { accepted: false } });
    // 真實頁面的時序：回報沒被採用就立刻要求重建（舊版頁面的行為）：核心在停播結果出來前拒絕，不和強制靜音競爭。
    const early = (await t.post("/api/realtime/start", { client_id: p.clientId, rebuild: true })).json as StartDecision;
    expect(early).toMatchObject({ ok: false, reasons: { live: "session_busy" } });
    const notice = await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "memory_notice", 4000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect((notice.event as { message: string }).message).toBe("即時語音停止未確認；這條路徑的記憶已停用");
    expect(muted).toEqual([true]);
    // 下一通：解除靜音，但這次執行期間 live 不再帶記憶。
    await startLive(t, p.clientId);
    expect(muted).toEqual([true, false]);
    const next = JSON.parse(t.callFetch.calls[1]!.body).session.instructions as string;
    expect(next).not.toContain("不吃香菜");
    expect(next).not.toContain(CANARY);
  });
});

describe.skipIf(!realLockAvailable)("MEM-2 review: stop-report evidence", () => {
  it("a report whose evidence is incomplete is not accepted and does not lift forced silence; a complete one is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-mem2-evidence-"));
    const h = harness({ dir, key: randomBytes(32), live: CODEX });
    try {
      await enable(h, "George", [CODEX]);
      await h.turn("記住，我不吃香菜");
      const token = await manage(h);
      for (const f of (await h.call({ op: "list" })).facts as { id: string; revision: number }[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
      const t = await start({ memory: h });
      const p = await page(t.base);
      const { decision, conn } = await startLive(t, p.clientId);
      conn.send({ type: "session.started", session: {} });
      await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "memory");
      h.service.suspendAll();
      await p.waitFor((e) => e.type === "realtime.live" && (e.event as { kind: string }).kind === "closed");
      const body = (evidence: Record<string, unknown>) => ({ session_id: decision.session_id, owner: decision.owner, evidence: { paused: true, peer_closed: true, tracks_ended: true, ms: 4, ...evidence } });
      expect(await t.post("/api/realtime/stopped", body({ tracks_ended: false }))).toMatchObject({ json: { accepted: false } });
      expect(await t.post("/api/realtime/stopped", body({ paused: false }))).toMatchObject({ json: { accepted: false } });
      expect(await t.post("/api/realtime/stopped", body({}))).toMatchObject({ json: { accepted: true } });
      p.close();
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
