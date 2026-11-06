import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import { connectApiKey, plainApiKeyCall, type ApiKeyBridge } from "../server/apikey-call.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { ALIVE_TIMEOUT_MS, CORE_CAP_GRACE_MS, RealtimeSessions, type RealtimeRoute, type RouteCall, type SessionContext } from "../server/realtime-routes.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { VoiceSettingsStore } from "../server/voice-settings.ts";
import { billingLine, CALL_END_TEXT, type RoutePreference } from "../shared/realtime-route.ts";
import type { RealtimeBaseInfo } from "../shared/types.ts";
import { emptyVoiceUsage, type VoiceCostRecord } from "../shared/voice-cost.ts";
import { realtimeMeter } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";

// 即時語音費用防護（George 2026-11-06）：核心這一端。路徑是假的（fixture），不連 OpenAI 或 Codex。

interface FakeRoute extends RealtimeRoute {
  ctx: SessionContext | null;
  closes: string[];
}

function fakeRoute(id: "live" | "api_key", model: string): FakeRoute {
  const route: FakeRoute = {
    id,
    ctx: null,
    closes: [],
    readiness: () => ({ ready: true }),
    describe: () => ({ id, available: true, reason: null, billing_line: billingLine(id, model), model, voice: "cove", voices: [], tools: "", detail: `fixture ${id}` }),
    baseInfo: (): RealtimeBaseInfo => ({ available: true, model, detail: `fixture ${id}` }),
    async connect(_sdp, ctx): Promise<RouteCall> {
      route.ctx = ctx;
      return { route: id, answerSdp: "v=0 answer", model, control: id === "live" ? { input: () => {} } : null, close: async (reason) => void route.closes.push(reason) };
    },
  };
  return route;
}

function setup(pref: RoutePreference = "live", maxCallMs = 20 * 60_000) {
  vi.useFakeTimers();
  const live = fakeRoute("live", "gpt-live-1-codex");
  const key = fakeRoute("api_key", "gpt-realtime");
  const sent: { client: string; event: Record<string, unknown> }[] = [];
  const records: VoiceCostRecord[] = [];
  const amended: VoiceCostRecord[] = [];
  let max = maxCallMs;
  const sessions = new RealtimeSessions({
    routes: { live, api_key: key },
    preference: () => pref,
    tasks: () => [],
    send: (client, event) => (sent.push({ client, event: event as unknown as Record<string, unknown> }), true),
    maxCallMs: () => max,
    costLog: { record: (r) => void records.push(r), amend: (r) => void amended.push(r) },
  });
  const begin = async (client: string | null = "sse_a", page?: string, app = false) => {
    const d = sessions.start(client, "user", "zh-TW", false, null, page, app);
    if (!d.ok) throw new Error(d.message);
    await sessions.call("v=0 offer", d.session_id, d.owner);
    return d;
  };
  const closedEvents = () => sent.filter((s) => s.event.type === "realtime.live" && (s.event.event as { kind: string }).kind === "closed").map((s) => s.event.event);
  return { live, key, sent, records, amended, sessions, begin, closedEvents, setMax: (ms: number) => (max = ms) };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("core cap (both routes)", () => {
  it.each(["live", "api_key"] as const)("%s: the core ends the call at the cap + 30 s grace, tells the page, records max_duration and hangs up", async (route) => {
    const t = setup(route);
    await t.begin();
    const r = route === "live" ? t.live : t.key;
    vi.advanceTimersByTime(20 * 60_000 + CORE_CAP_GRACE_MS - 1);
    expect(r.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.closedEvents()).toEqual([{ kind: "closed", reason: "max_duration", message: CALL_END_TEXT.max_duration }]);
    expect(r.closes).toEqual(["enforced"]);
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ route, end_reason: "max_duration", connected: true });
    expect(t.sessions.view().active).toBeNull();
  });

  it("raising the cap during a call is honoured by the core; a page that ends first records its own reason", async () => {
    const t = setup("api_key", 10 * 60_000);
    const d = await t.begin();
    vi.advanceTimersByTime(5 * 60_000);
    t.setMax(30 * 60_000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(t.key.closes).toEqual([]);
    // 頁面先結束（自己的上限）：原因與 usage 進費用紀錄，核心的計時器取消。
    await t.sessions.end(d.session_id, d.owner, { reason: "max_duration", usage: { ...emptyVoiceUsage(), total_tokens: 900 } });
    expect(t.records[0]).toMatchObject({ end_reason: "max_duration", usage: { total_tokens: 900 } });
    vi.advanceTimersByTime(60 * 60_000);
    expect(t.records).toHaveLength(1);
    expect(t.key.closes).toEqual(["ended"]);
  });
});

describe("alive check-ins", () => {
  it("no check-in at all (an old page) never ends the call by client_lost", async () => {
    const t = setup("live");
    await t.begin();
    vi.advanceTimersByTime(10 * 60_000);
    expect(t.live.closes).toEqual([]);
  });

  it("after the first check-in, 45 s without another ends the call (client_lost) and keeps the last reported usage", async () => {
    const t = setup("api_key");
    const d = await t.begin();
    for (let i = 0; i < 4; i++) {
      t.sessions.alive(d.session_id, d.owner, { ...emptyVoiceUsage(), total_tokens: 1000 * (i + 1) });
      vi.advanceTimersByTime(15_000);
    }
    expect(t.sessions.view().active).toMatchObject({ route: "api_key", usage: { total_tokens: 4000 }, max_call_s: 1200, page: "main", started_at: expect.any(Number) });
    vi.advanceTimersByTime(ALIVE_TIMEOUT_MS - 15_000 - 1);
    expect(t.key.closes).toEqual([]);
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.key.closes).toEqual(["enforced"]);
    expect(t.closedEvents()).toEqual([{ kind: "closed", reason: "client_lost", message: CALL_END_TEXT.client_lost }]);
    expect(t.records[0]).toMatchObject({ end_reason: "client_lost", usage: { total_tokens: 4000 } });
  });

  it("the ChatGPT route ignores usage in check-ins (unknown, never guessed); the owner token is checked", async () => {
    const t = setup("live");
    const d = await t.begin();
    t.sessions.alive(d.session_id, d.owner, { ...emptyVoiceUsage(), total_tokens: 5 });
    expect(t.sessions.view().active).toMatchObject({ route: "live", usage: null });
    expect(() => t.sessions.alive(d.session_id, "own_wrongwrongwrongwrongwrong")).toThrow();
    await t.sessions.end(d.session_id, d.owner);
    expect(t.records[0]).toMatchObject({ usage: "unknown" });
    expect(() => t.sessions.alive(d.session_id, d.owner)).toThrow(/沒有這個/);
  });
});

describe("Mac lock and sleep", () => {
  it("lock ends only calls started by the Mac App window (not the Pi, not a plain browser); sleep ends every call", async () => {
    const t = setup("live");
    await t.begin("sse_pi", "rpi4");
    await t.sessions.endAll("os_lock", "app");
    expect(t.live.closes).toEqual([]);
    await t.sessions.endAll("suspend");
    expect(t.live.closes).toEqual(["enforced"]);
    expect(t.records[0]).toMatchObject({ end_reason: "suspend" });

    const b = setup("api_key");
    await b.begin("sse_a", "main", false); // Mac 上的一般瀏覽器
    await b.sessions.endAll("os_lock", "app");
    expect(b.key.closes).toEqual([]);

    const u = setup("api_key");
    await u.begin("sse_a", "main", true);
    await u.sessions.endAll("os_lock", "app");
    expect(u.key.closes).toEqual(["enforced"]);
    expect(u.closedEvents()).toEqual([{ kind: "closed", reason: "os_lock", message: CALL_END_TEXT.os_lock }]);
    expect(u.records[0]).toMatchObject({ end_reason: "os_lock" });
  });

  it("a page reason that arrives after the core's generic end replaces it; the core's own reasons are kept", async () => {
    const t = setup("live");
    const d = await t.begin();
    t.sessions.clientClosed("sse_a"); // page_gone
    await t.sessions.end(d.session_id, d.owner, { reason: "hidden" });
    expect(t.amended.at(-1)).toMatchObject({ end_reason: "hidden" });
    const u = setup("live");
    const e = await u.begin();
    await u.sessions.endAll("suspend");
    await u.sessions.end(e.session_id, e.owner, { reason: "idle" });
    expect(u.amended).toEqual([]);
  });
});

describe("SSE drop on a plain API key call", () => {
  it("a call that already checked in survives an SSE reconnect; the 45 s check-in timeout decides", async () => {
    const t = setup("api_key");
    const d = await t.begin();
    t.sessions.alive(d.session_id, d.owner);
    t.sessions.clientClosed("sse_a"); // Wi-Fi 瞬斷、autossh 重連
    expect(t.key.closes).toEqual([]);
    expect(t.sessions.view().active).toMatchObject({ session_id: d.session_id });
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(15_000);
      t.sessions.alive(d.session_id, d.owner); // 重新整理前的同一個頁面還在報到
    }
    expect(t.key.closes).toEqual([]);
    vi.advanceTimersByTime(ALIVE_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.key.closes).toEqual(["enforced"]);
    expect(t.records[0]).toMatchObject({ end_reason: "client_lost" });
    // 串流已斷：結束時沒有事件可送
    expect(t.closedEvents()).toEqual([]);
  });

  it("a call that never checked in still ends at once on page_gone; the ChatGPT route always does", async () => {
    const t = setup("api_key");
    await t.begin();
    t.sessions.clientClosed("sse_a");
    expect(t.key.closes).toEqual(["page_gone"]);
    const u = setup("live");
    const d = await u.begin();
    u.sessions.alive(d.session_id, d.owner);
    u.sessions.clientClosed("sse_a");
    expect(u.live.closes).toEqual(["page_gone"]);
  });
});

describe("plain API key calls hang up when the core ends them", () => {
  it("page_gone and enforced hang up once with the core-held call ID; ended does not", async () => {
    const hung: string[] = [];
    const hangup = async (id: string) => (hung.push(id), true);
    const call = plainApiKeyCall({ sdp: "v=0", model: "gpt-realtime", callId: "rtc_123" }, null, hangup);
    await call.close("ended");
    expect(hung).toEqual([]);
    await call.close("enforced");
    await call.close("page_gone");
    expect(hung).toEqual(["rtc_123"]);
    // 沒有 call ID：沒有東西可掛斷
    await plainApiKeyCall({ sdp: "v=0", model: "m" }, null, hangup).close("enforced");
    expect(hung).toEqual(["rtc_123"]);
  });

  it("connectApiKey without memory keeps the call ID in the core for the hang-up", async () => {
    const hung: string[] = [];
    const bridge = {
      connect: async () => ({ sdp: "v=0 answer", model: "gpt-realtime", callId: "rtc_abc" }),
      hangup: async (id: string) => (hung.push(id), true),
      openSideband: async () => { throw new Error("unused"); },
      memorySessionUpdate: () => ({}),
    } as unknown as ApiKeyBridge;
    const ctx = { sessionId: "rt_x", tasks: () => [], locale: "zh-TW" } as unknown as SessionContext;
    const call = await connectApiKey(bridge, "v=0 offer", ctx, null);
    expect(JSON.stringify(call)).not.toContain("rtc_abc");
    await call.close("enforced");
    expect(hung).toEqual(["rtc_abc"]);
  });
});

describe("menu bar meter (desktop/settings-menu.mjs)", () => {
  const en = (s: string, ...v: unknown[]) => translate(s, "en", ...v);
  it("shows duration / cap and approximate tokens for the API key route, usage unknown for ChatGPT, and the terminal for Pi calls", () => {
    const usage = { ...emptyVoiceUsage(), total_tokens: 3400 };
    const now = 1_000_000;
    expect(realtimeMeter({ session_id: "rt_a", route: "api_key", billing_line: "x", started_at: now - 187_000, max_call_s: 1200, usage, page: "main" }, now)).toBe("3:07 / 20:00 · 約 3,400 tokens");
    expect(realtimeMeter({ session_id: "rt_a", route: "api_key", billing_line: "x", started_at: now - 187_000, max_call_s: 1200, usage, page: "main" }, now, en)).toBe("3:07 / 20:00 · ~3,400 tokens");
    expect(realtimeMeter({ session_id: "rt_a", route: "live", billing_line: "x", started_at: now - 5_000, max_call_s: 1800, usage: null, page: "rpi4" }, now, en)).toBe("Terminal rpi4 · 0:05 / 30:00 · ChatGPT plan: usage unknown");
    // 連線中、舊的核心沒有這些欄位：不顯示
    expect(realtimeMeter({ session_id: "rt_a", route: "live", billing_line: "x", started_at: null, max_call_s: 1200, usage: null }, now)).toBe("");
    expect(realtimeMeter({ session_id: "rt_a", route: "live", billing_line: "x" }, now)).toBe("");
    expect(realtimeMeter(null, now)).toBe("");
  });
});

describe("POST /api/realtime/alive", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it("checks the owner, accepts only known usage numbers, and the cap comes from voice.json", async () => {
    const store = new TaskStore(null);
    const dir = mkdtempSync(join(tmpdir(), "nous-alive-"));
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const runner = new TaskRunner(store, providers);
    const key = fakeRoute("api_key", "gpt-realtime");
    const voice = new VoiceSettingsStore({ dir, onChange: () => {} });
    voice.update({ realtime_max_call_s: 600 });
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const server = createApp({ store, runner, settings: providers, auth, chat: providers, realtimeRoutes: { api_key: key }, voice, port, devPort: 5173, distDir: null });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://localhost:${port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = (await (await post("/api/realtime/start", {})).json()) as { session_id: string; owner: string };
    await post("/api/realtime/call", { sdp: "v=0 offer", session_id: d.session_id, owner: d.owner });
    expect((await post("/api/realtime/alive", { session_id: d.session_id, owner: d.owner, usage: { total_tokens: 1234, transcript: "秘密" } })).status).toBe(200);
    expect((await post("/api/realtime/alive", { session_id: d.session_id, owner: "own_wrongwrongwrongwrongwrong" })).status).toBe(403);
    const settings = (await (await fetch(`${base}/api/settings`)).json()) as { realtime: { active: Record<string, unknown> } };
    expect(settings.realtime.active).toMatchObject({ route: "api_key", max_call_s: 600, usage: { total_tokens: 1234 } });
    expect(JSON.stringify(settings)).not.toContain("秘密");
    await post("/api/realtime/end", { session_id: d.session_id, owner: d.owner });
    expect((await post("/api/realtime/alive", { session_id: d.session_id, owner: d.owner })).status).toBe(404);
  });
});
