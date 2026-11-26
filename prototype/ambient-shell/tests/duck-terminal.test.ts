import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { parseDuckTerminal } from "../server/config.ts";
import { PresenceDriver } from "../server/duck/presence.ts";
import { createPresenceBridge } from "../server/duck/session-bridge.ts";
import { DuckWakeGate } from "../server/duck/wake-gate.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { ProviderManager } from "../server/providers.ts";
import type { Readiness, RealtimeRoute, RouteCall, SessionLifecycleEvent } from "../server/realtime-routes.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { DUCK_WAKE_TOKEN, type DuckReportPhase } from "../shared/duck-terminal.ts";
import { toolResult } from "../shared/integrations.ts";
import { billingLine } from "../shared/realtime-route.ts";
import type { RealtimeBaseInfo, ServerEvent, SettingsView } from "../shared/types.ts";
import { DuckWakeWatch } from "../src/duck-wake-watch.ts";
import { MockDuck } from "./fixtures/mock-duck.ts";

// DUCK-2：鴨子當語音終端。鴨子本機的喚醒（duck-link 的 wake_word 事件）→ 核心對鴨子終端的頁面送 SSE voice.request →
// 頁面帶著一次性權杖開始 wake_word 通話；頁面回報的語音狀態 → 鴨子的互動狀態（有真的 speaking）。
// 全部是 fixture：假的語音路徑、假鴨子、用 fetch 當頁面。沒有瀏覽器、沒有麥克風、沒有語音模型，不是實機或真實語音驗證。

const READY: Readiness = { ready: true };
function fakeRoute(id: "api_key"): RealtimeRoute {
  return {
    id,
    readiness: () => READY,
    describe: () => ({ id, available: true, reason: null, billing_line: billingLine(id, "m"), model: "m", voice: "cove", voices: [], tools: "", detail: `fixture ${id}` }),
    baseInfo: (): RealtimeBaseInfo => ({ available: true, model: "m", detail: `fixture ${id}` }),
    async connect(): Promise<RouteCall> {
      return { route: id, answerSdp: "v=0 answer", model: "m", control: null, close: async () => undefined };
    },
  } as unknown as RealtimeRoute;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** 用 fetch 讀一條 SSE 串流（當成頁面）。 */
async function openSse(url: string): Promise<{ events: ServerEvent[]; close(): void; next(match: (e: ServerEvent) => boolean, ms?: number): Promise<ServerEvent> }> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const events: ServerEvent[] = [];
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) events.push(JSON.parse(line.slice(6)) as ServerEvent);
        }
      }
    } catch {
      // 測試結束時中止
    }
  })();
  return {
    events,
    close: () => controller.abort(),
    async next(match, ms = 3_000) {
      const start = Date.now();
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        if (Date.now() - start > ms) throw new Error("timed out waiting for an SSE event");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

describe("DuckWakeGate（一次性喚醒權杖）", () => {
  it("issues a well-formed token for one page; redeemable once, only by that page, only before it expires", () => {
    let now = 1_000;
    const gate = new DuckWakeGate(() => now, 15_000);
    const token = gate.issue("duck");
    expect(token).toMatch(DUCK_WAKE_TOKEN);
    expect(gate.redeem(token, "main")).toBe(false);
    expect(gate.redeem(token, "duck")).toBe(true);
    expect(gate.redeem(token, "duck")).toBe(false);
    const late = gate.issue("duck");
    now += 15_001;
    expect(gate.redeem(late, "duck")).toBe(false);
    expect(gate.pending).toBe(0);
  });

  it("a new wake for the same page voids the previous unused token; malformed tokens are refused", () => {
    const gate = new DuckWakeGate();
    const first = gate.issue("duck");
    const second = gate.issue("duck");
    expect(gate.pending).toBe(1);
    expect(gate.redeem(first, "duck")).toBe(false);
    for (const bad of [undefined, null, 5, "", "dw_xyz", `${second}0`, { token: second }]) expect(gate.redeem(bad, "duck")).toBe(false);
    expect(gate.redeem(second, "duck")).toBe(true);
  });
});

describe("DuckWakeWatch（鴨子喚醒開始的通話：沒人出聲就結束；只看通話階段）", () => {
  function make() {
    let pending: (() => void) | null = null;
    let fired = 0;
    const watch = new DuckWakeWatch({ timeoutMs: 5_000, onTimeout: () => void fired++, setTimer: (run) => ((pending = run), run), clearTimer: () => void (pending = null) });
    const fire = () => {
      const run = pending;
      pending = null;
      run?.();
    };
    return { watch, fire, armed: () => pending !== null, fired: () => fired };
  }

  it("counts while listening, pauses while thinking or speaking, restarts on listening, fires once", () => {
    const w = make();
    w.watch.phase("connecting");
    expect(w.armed()).toBe(false);
    w.watch.phase("listening");
    expect(w.armed()).toBe(true);
    w.watch.phase("speaking");
    expect(w.armed()).toBe(false);
    w.watch.phase("listening");
    w.fire();
    expect(w.fired()).toBe(1);
    w.watch.phase("listening");
    expect(w.armed()).toBe(false);
  });

  it("the user speaking (hearing), typing (disarm) or the call ending (stop) cancels it for good", () => {
    for (const cancel of [(x: DuckWakeWatch) => x.phase("hearing"), (x: DuckWakeWatch) => x.disarm(), (x: DuckWakeWatch) => x.stop()]) {
      const w = make();
      w.watch.phase("listening");
      cancel(w.watch);
      expect(w.armed()).toBe(false);
      w.watch.phase("listening");
      expect(w.armed()).toBe(false);
      expect(w.fired()).toBe(0);
    }
  });
});

describe("NOUS_DUCK_TERMINAL", () => {
  it("defaults to duck and must be a valid terminal id", () => {
    expect(parseDuckTerminal(undefined)).toBe("duck");
    expect(parseDuckTerminal(" duck-1 ")).toBe("duck-1");
    for (const bad of ["main", "Duck", "a b", "-x", "x".repeat(40)]) expect(() => parseDuckTerminal(bad)).toThrow(/NOUS_DUCK_TERMINAL/);
  });
});

describe("頁面回報的語音狀態 → presence（假時鐘）", () => {
  let sent: string[];
  let driver: PresenceDriver;
  let bridge: ReturnType<typeof createPresenceBridge>;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    driver = new PresenceDriver({ send: async (state) => (sent.push(state), toolResult("confirmed", "ok")) });
    bridge = createPresenceBridge({ handle: (e) => driver.handle(e), pendingMs: 5_000 });
  });
  afterEach(() => {
    bridge.dispose();
    driver.stop();
    vi.useRealTimers();
  });
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const life = (event: SessionLifecycleEvent) => bridge.observe(event);
  const phase = (sessionId: string, p: DuckReportPhase) => bridge.observe({ kind: "phase", sessionId, phase: p });

  it("with page phases the duck gets a real speaking state, in the order things happened", async () => {
    life({ kind: "started", sessionId: "s1", route: "api_key", source: "wake_word", page: "duck" });
    await tick(1);
    phase("s1", "connecting");
    life({ kind: "connected", sessionId: "s1", route: "api_key", page: "duck" });
    phase("s1", "listening");
    await tick(800);
    phase("s1", "hearing");
    await tick(200);
    phase("s1", "thinking");
    await tick(200);
    phase("s1", "speaking");
    await tick(200);
    phase("s1", "listening");
    await tick(200);
    life({ kind: "ended", sessionId: "s1", reason: "no_voice" });
    await tick(200);
    expect(sent).toEqual(["wake", "listening", "thinking", "speaking", "listening", "idle"]);
  });

  it("once the page reports, core-side delegation only toggles working and no longer forces listening", async () => {
    life({ kind: "started", sessionId: "s1", route: "live", source: "user", page: "duck" });
    life({ kind: "connected", sessionId: "s1", route: "live", page: "duck" });
    phase("s1", "thinking");
    await tick(200);
    life({ kind: "delegation", sessionId: "s1", state: "started" });
    await tick(200);
    life({ kind: "delegation", sessionId: "s1", state: "finished" });
    await tick(200);
    phase("s1", "speaking");
    await tick(200);
    expect(sent).toEqual(["thinking", "working", "thinking", "speaking"]);
  });

  it("phases for a session the core does not know (ended, or never started) are ignored", async () => {
    phase("ghost", "speaking");
    await tick(300);
    life({ kind: "started", sessionId: "s1", route: "api_key", source: "user", page: "duck" });
    life({ kind: "connected", sessionId: "s1", route: "api_key", page: "duck" });
    life({ kind: "ended", sessionId: "s1", reason: "ended" });
    await tick(200);
    phase("s1", "speaking");
    await tick(300);
    expect(sent).not.toContain("speaking");
  });
});

describe("HTTP：喚醒權杖、頁面的語音狀態回報、設定（假的語音路徑）", () => {
  const servers: Server[] = [];
  const closers: (() => void)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
  });

  async function app(duck: boolean) {
    const store = new TaskStore(null);
    const dir = mkdtempSync(join(tmpdir(), "nous-duck-terminal-"));
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const runner = new TaskRunner(store, providers);
    const gate = new DuckWakeGate();
    const phases: [string, string][] = [];
    const port = await freePort();
    const server = createApp({
      store,
      runner,
      settings: providers,
      auth,
      chat: providers,
      realtimeRoutes: { api_key: fakeRoute("api_key") },
      ...(duck ? { duck: { terminal: "duck", redeemWake: (token, page) => gate.redeem(token, page), onPhase: (sessionId, phase) => void phases.push([sessionId, phase]) } } : {}),
      port,
      devPort: 5173,
      distDir: null,
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown, terminal?: string) => {
      const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(terminal ? { "X-Nous-Terminal": terminal } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { server, base, post, gate, phases };
  }

  it("voice.request goes only to the duck terminal's SSE stream and carries a core-issued token", async () => {
    const a = await app(true);
    const duckPage = await openSse(`${a.base}/api/events?terminal=duck`);
    const mainPage = await openSse(`${a.base}/api/events`);
    closers.push(duckPage.close, mainPage.close);
    const hello = (await duckPage.next((e) => e.type === "hello")) as Extract<ServerEvent, { type: "hello" }>;
    expect(hello.settings.duck).toEqual({ terminal: true });
    const mainHello = (await mainPage.next((e) => e.type === "hello")) as Extract<ServerEvent, { type: "hello" }>;
    expect(mainHello.settings.duck).toBeUndefined();

    expect(a.server.requestVoice("duck", a.gate.issue("duck"))).toBe(1);
    const request = (await duckPage.next((e) => e.type === "voice.request")) as Extract<ServerEvent, { type: "voice.request" }>;
    expect(request).toMatchObject({ action: "start", source: "wake_word" });
    expect(request.duck_wake).toMatch(DUCK_WAKE_TOKEN);
    await new Promise((r) => setTimeout(r, 50));
    expect(mainPage.events.some((e) => e.type === "voice.request")).toBe(false);
    expect(a.server.requestVoice("nobody", a.gate.issue("nobody"))).toBe(0);
  });

  it("start: a valid token from the duck terminal makes it a wake_word call without NOUS_WAKE; it works once", async () => {
    const a = await app(true);
    const token = a.gate.issue("duck");
    const first = await a.post("/api/realtime/start", { source: "wake_word", duck_wake: token }, "duck");
    // wake_word 開始的通話才有核心發的互動 ID（問候用）。
    expect(first.body).toMatchObject({ ok: true });
    expect(first.body.interaction).toEqual(expect.any(String));
    await a.post("/api/realtime/end", { session_id: first.body.session_id, owner: first.body.owner });
    const replay = await a.post("/api/realtime/start", { source: "wake_word", duck_wake: token }, "duck");
    expect(replay.body).toMatchObject({ ok: true, interaction: null });
  });

  it("start: no token, a made-up token, or a token issued for another page is treated as an ordinary user start", async () => {
    const a = await app(true);
    for (const [body, terminal] of [
      [{ source: "wake_word" }, "duck"],
      [{ source: "wake_word", duck_wake: `dw_${"0".repeat(32)}` }, "duck"],
      [{ source: "wake_word", duck_wake: a.gate.issue("duck") }, undefined],
      [{ source: "wake_word", duck_wake: a.gate.issue("duck") }, "rpi4"],
    ] as const) {
      const d = await a.post("/api/realtime/start", body, terminal);
      expect(d.body, JSON.stringify([body, terminal])).toMatchObject({ ok: true, interaction: null });
      await a.post("/api/realtime/end", { session_id: d.body.session_id, owner: d.body.owner });
    }
  });

  it("start: the existing wake rate limit (3 accepted wake starts per rolling minute) applies to duck wakes too", async () => {
    const a = await app(true);
    for (let i = 0; i < 3; i++) {
      const d = await a.post("/api/realtime/start", { source: "wake_word", duck_wake: a.gate.issue("duck") }, "duck");
      expect(d.body.ok).toBe(true);
      await a.post("/api/realtime/end", { session_id: d.body.session_id, owner: d.body.owner });
    }
    const fourth = await a.post("/api/realtime/start", { source: "wake_word", duck_wake: a.gate.issue("duck") }, "duck");
    expect(fourth.body).toMatchObject({ ok: false, wake_limited: true });
  });

  it("phase: accepted only from the owner, forwarded only for the duck terminal, only known phase names", async () => {
    const a = await app(true);
    const d = (await a.post("/api/realtime/start", { source: "wake_word", duck_wake: a.gate.issue("duck") }, "duck")).body;
    const ticket = { session_id: d.session_id, owner: d.owner };
    // 還沒連上（頁面的 connecting）：核心還沒有這個工作階段，回報被拒絕；頁面不把它當錯誤。
    expect((await a.post("/api/realtime/phase", { ...ticket, phase: "connecting" }, "duck")).status).toBe(403);
    await a.post("/api/realtime/call", { sdp: "v=0 offer", ...ticket }, "duck");
    expect((await a.post("/api/realtime/phase", { ...ticket, phase: "speaking" }, "duck")).status).toBe(200);
    expect((await a.post("/api/realtime/phase", { ...ticket, phase: "listening" }, "duck")).status).toBe(200);
    expect(a.phases).toEqual([[d.session_id, "speaking"], [d.session_id, "listening"]]);
    // 同一個擁有者但不是鴨子終端的頁面：接受請求、不轉給鴨子。
    expect((await a.post("/api/realtime/phase", { ...ticket, phase: "speaking" })).status).toBe(200);
    expect(a.phases).toHaveLength(2);
    expect((await a.post("/api/realtime/phase", { ...ticket, phase: "off" }, "duck")).status).toBe(400);
    expect((await a.post("/api/realtime/phase", { ...ticket, phase: "dancing" }, "duck")).status).toBe(400);
    expect((await a.post("/api/realtime/phase", { session_id: d.session_id, owner: `own_${"x".repeat(24)}`, phase: "speaking" }, "duck")).status).toBe(403);
    expect((await a.post("/api/realtime/phase", { phase: "speaking" }, "duck")).status).toBe(400);
    expect(a.phases).toHaveLength(2);
  });

  it("flag off (no duck option): duck_wake is ignored, there is no phase route, settings carry no duck key", async () => {
    const a = await app(false);
    const d = await a.post("/api/realtime/start", { source: "wake_word", duck_wake: a.gate.issue("duck") }, "duck");
    expect(d.body).toMatchObject({ ok: true, interaction: null });
    await a.post("/api/realtime/call", { sdp: "v=0 offer", session_id: d.body.session_id, owner: d.body.owner }, "duck");
    expect((await a.post("/api/realtime/phase", { session_id: d.body.session_id, owner: d.body.owner, phase: "speaking" }, "duck")).status).toBe(404);
    const settings = (await (await fetch(`${a.base}/api/settings`, { headers: { "X-Nous-Terminal": "duck" } })).json()) as SettingsView;
    expect(settings.duck).toBeUndefined();
  });
});

describe("核心接線：duck-link 的 wake_word 事件 → 鴨子終端頁面的 voice.request（startNous，假鴨子）", () => {
  let core: NousHandle | null = null;
  let duck: MockDuck | null = null;
  let root: string | null = null;
  const closers: (() => void)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    duck?.disconnect();
    await core?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    core = duck = root = null;
  });

  async function boot(env: Record<string, string>) {
    root = mkdtempSync(join(tmpdir(), "nous-duck-voice-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const logs: string[] = [];
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_CAMERA: "off", OPENAI_API_KEY: "", NOUS_WAKE: "off", NOUS_DUCK: "on", ...env },
      log: (line) => logs.push(line),
    });
    duck = new MockDuck({ url: `ws://127.0.0.1:${core.port}/duck-link`, stateIntervalMs: 50 });
    await duck.connect();
    const start = Date.now();
    while (!logs.some((l) => l.includes("鴨子已連線"))) {
      if (Date.now() - start > 3_000) throw new Error("duck did not connect");
      await new Promise((r) => setTimeout(r, 10));
    }
    return { handle: core, logs };
  }
  const waitLog = async (logs: string[], text: string) => {
    const start = Date.now();
    while (!logs.some((l) => l.includes(text))) {
      if (Date.now() - start > 3_000) throw new Error(`log not seen: ${text}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("the duck's wake_word event reaches the terminal page as voice.request; other duck events do not", async () => {
    const { handle, logs } = await boot({});
    expect(logs.some((l) => l.includes(`語音終端頁面：http://localhost:${handle.port}/?terminal=duck`))).toBe(true);
    const page = await openSse(`${handle.url}/api/events?terminal=duck`);
    closers.push(page.close);
    await page.next((e) => e.type === "hello");
    duck!.emitEvent("battery_low");
    duck!.emitEvent("wake_word", { data: { keyword_id: "hey_duck", doa_deg: 20 } });
    const request = (await page.next((e) => e.type === "voice.request")) as Extract<ServerEvent, { type: "voice.request" }>;
    expect(request.duck_wake).toMatch(DUCK_WAKE_TOKEN);
    expect(page.events.filter((e) => e.type === "voice.request")).toHaveLength(1);
    await waitLog(logs, "已請終端頁面（duck）開始對話（1 個頁面）");
  });

  it("no terminal page connected: says so in the log and starts nothing", async () => {
    const { logs } = await boot({});
    duck!.emitEvent("wake_word");
    await waitLog(logs, "終端頁面（?terminal=duck）沒有連著，沒有開始對話");
  });

  it("NOUS_DUCK_TERMINAL picks which page is the duck's", async () => {
    const { handle } = await boot({ NOUS_DUCK_TERMINAL: "duck-desk" });
    const wrong = await openSse(`${handle.url}/api/events?terminal=duck`);
    const right = await openSse(`${handle.url}/api/events?terminal=duck-desk`);
    closers.push(wrong.close, right.close);
    await right.next((e) => e.type === "hello");
    await wrong.next((e) => e.type === "hello");
    duck!.emitEvent("wake_word");
    await right.next((e) => e.type === "voice.request");
    expect(wrong.events.some((e) => e.type === "voice.request")).toBe(false);
  });
});
