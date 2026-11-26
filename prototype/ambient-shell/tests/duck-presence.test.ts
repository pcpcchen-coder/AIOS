import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceDriver } from "../server/duck/presence.ts";
import { createPresenceBridge } from "../server/duck/session-bridge.ts";
import { RealtimeSessions, RouteStartError, type Readiness, type RealtimeRoute, type RouteCall, type SessionContext, type SessionLifecycleEvent } from "../server/realtime-routes.ts";
import { toolResult } from "../shared/integrations.ts";
import { billingLine } from "../shared/realtime-route.ts";
import type { RealtimeBaseInfo } from "../shared/types.ts";

// DUCK-1（D4a）：即時語音工作階段的觀察點 → 鴨子的 presence。路徑與鴨子都是假的（fixture，不是實機或真實語音驗證）。

const READY: Readiness = { ready: true };
function fakeRoute(id: "live" | "api_key"): RealtimeRoute & { ctx: SessionContext | null; fail: RouteStartError | null } {
  const route = {
    id,
    ctx: null as SessionContext | null,
    fail: null as RouteStartError | null,
    readiness: () => READY,
    describe: () => ({ id, available: true, reason: null, billing_line: billingLine(id, "m"), model: "m", voice: "cove", voices: [], tools: "", detail: `fixture ${id}` }),
    baseInfo: (): RealtimeBaseInfo => ({ available: true, model: "m", detail: `fixture ${id}` }),
    async connect(_sdp: string, ctx: SessionContext): Promise<RouteCall> {
      route.ctx = ctx;
      if (route.fail) throw route.fail;
      return { route: id, answerSdp: "v=0 answer", model: "m", control: id === "live" ? { input: () => {} } : null, close: async () => undefined };
    },
  };
  return route as never;
}

describe("RealtimeSessions.onSessionEvent（觀察點）", () => {
  function setup(observer?: (e: SessionLifecycleEvent) => void) {
    const live = fakeRoute("live");
    const seen: SessionLifecycleEvent[] = [];
    const sessions = new RealtimeSessions({ routes: { live }, preference: () => "live", tasks: () => [], send: () => true, onSessionEvent: observer ?? ((e) => seen.push(e)) });
    return { live, seen, sessions };
  }

  it("reports started (with the real source and page), connected, delegation and ended, in order", async () => {
    const { live, seen, sessions } = setup();
    const d = sessions.start("sse_a", "wake_word", "zh-TW", false, "wake_1", "rpi4");
    if (!d.ok) throw new Error("expected start");
    expect(seen).toEqual([{ kind: "started", sessionId: d.session_id, route: "live", source: "wake_word", page: "rpi4" }]);
    await sessions.call("v=0", d.session_id, d.owner);
    expect(seen.at(-1)).toEqual({ kind: "connected", sessionId: d.session_id, route: "live", page: "rpi4" });
    live.ctx!.emit({ kind: "delegation", id: "del_1", state: "started" });
    live.ctx!.emit({ kind: "delegation", id: "del_1", state: "finished" });
    await sessions.end(d.session_id, d.owner);
    expect(seen.map((e) => e.kind)).toEqual(["started", "connected", "delegation", "delegation", "ended"]);
    expect(seen.at(-1)).toMatchObject({ kind: "ended", sessionId: d.session_id });
  });

  it("reports ended with the close reason when the route closes the call", async () => {
    const { live, seen, sessions } = setup();
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await sessions.call("v=0", d.session_id, d.owner);
    live.ctx!.emit({ kind: "closed", reason: "connection_lost", message: "x" });
    expect(seen.at(-1)).toEqual({ kind: "ended", sessionId: d.session_id, reason: "connection_lost" });
    expect(seen.filter((e) => e.kind === "ended")).toHaveLength(1);
  });

  it("a refused start reports nothing", () => {
    const live = fakeRoute("live");
    live.readiness = () => ({ ready: false, reason: "not_logged_in", message: "x" });
    const seen: SessionLifecycleEvent[] = [];
    const sessions = new RealtimeSessions({ routes: { live }, preference: () => "live", tasks: () => [], send: () => true, onSessionEvent: (e) => seen.push(e) });
    expect(sessions.start("sse_a").ok).toBe(false);
    expect(seen).toEqual([]);
  });

  it("an observer that throws does not break the call", async () => {
    const { sessions } = setup(() => {
      throw new Error("observer bug");
    });
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await expect(sessions.call("v=0", d.session_id, d.owner)).resolves.toMatchObject({ sdp: "v=0 answer" });
    await sessions.end(d.session_id, d.owner);
    expect(sessions.view().active).toBeNull();
  });

  it("without an observer nothing changes (flag off)", async () => {
    const live = fakeRoute("live");
    const sessions = new RealtimeSessions({ routes: { live }, preference: () => "live", tasks: () => [], send: () => true });
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await sessions.call("v=0", d.session_id, d.owner);
    await sessions.end(d.session_id, d.owner);
    expect(sessions.view().active).toBeNull();
  });
});

describe("createPresenceBridge + PresenceDriver（工作階段事件 → presence，假時鐘）", () => {
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

  it("wake-word call: wake → listening → working → listening → idle", async () => {
    bridge.observe({ kind: "started", sessionId: "s1", route: "live", source: "wake_word", page: "main" });
    await tick(1);
    bridge.observe({ kind: "connected", sessionId: "s1", route: "live", page: "main" });
    await tick(800);
    bridge.observe({ kind: "delegation", sessionId: "s1", state: "started" });
    await tick(200);
    bridge.observe({ kind: "delegation", sessionId: "s1", state: "finished" });
    await tick(200);
    bridge.observe({ kind: "ended", sessionId: "s1", reason: "ended" });
    await tick(200);
    // 連上之後一律是 listening：核心分不出模型正在說話（speaking 要等頁面回報 phase 的批次）。
    expect(sent).toEqual(["wake", "listening", "working", "listening", "idle"]);
    expect(sent).not.toContain("speaking");
  });

  it("a user-started call does not act out wake; an error end shows error then idle", async () => {
    bridge.observe({ kind: "started", sessionId: "s1", route: "api_key", source: "user", page: "main" });
    await tick(200);
    bridge.observe({ kind: "connected", sessionId: "s1", route: "api_key", page: "main" });
    await tick(200);
    bridge.observe({ kind: "ended", sessionId: "s1", reason: "connection_lost" });
    await tick(2_000);
    expect(sent).toEqual(["thinking", "listening", "error", "idle"]);
  });

  it("a start that never connects falls back to idle after the pending window, without error", async () => {
    bridge.observe({ kind: "started", sessionId: "s1", route: "live", source: "user", page: "main" });
    await tick(200);
    expect(sent).toEqual(["thinking"]);
    await tick(5_000);
    expect(sent).toEqual(["thinking", "idle"]);
  });

  it("two calls at once: idle only after both ended; a route change connects under a new id", async () => {
    bridge.observe({ kind: "started", sessionId: "a", route: "live", source: "user", page: "main" });
    bridge.observe({ kind: "connected", sessionId: "a2", route: "api_key", page: "main" });
    bridge.observe({ kind: "started", sessionId: "b", route: "live", source: "user", page: "rpi4" });
    bridge.observe({ kind: "connected", sessionId: "b", route: "live", page: "rpi4" });
    await tick(200);
    bridge.observe({ kind: "ended", sessionId: "a2", reason: "ended" });
    await tick(200);
    expect(sent).toEqual(["listening"]);
    bridge.observe({ kind: "ended", sessionId: "b", reason: "ended" });
    await tick(200);
    expect(sent).toEqual(["listening", "idle"]);
  });

  it("delegation of an unknown session is ignored", async () => {
    bridge.observe({ kind: "delegation", sessionId: "ghost", state: "started" });
    await tick(300);
    expect(sent).toEqual([]);
  });
});
