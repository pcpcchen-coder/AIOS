import { afterEach, describe, expect, it, vi } from "vitest";
import { billingLine, RESULT_UNKNOWN_TEXT, unavailableText, type RoutePreference } from "../shared/realtime-route.ts";
import type { RealtimeBaseInfo } from "../shared/types.ts";
import {
  FallbackRequired,
  HOST_TIMEOUT_MS,
  HostGone,
  planFallback,
  planStart,
  RealtimeSessions,
  RouteStartError,
  SessionError,
  type Readiness,
  type RealtimeRoute,
  type RouteCall,
  type SessionContext,
} from "../server/realtime-routes.ts";

// 路徑選擇（純函式）與 RealtimeSessions（工作階段狀態、擁有者、頁面當工具執行器）。路徑都是假的（fixture）。

const READY: Readiness = { ready: true };
const NOT_LOGGED_IN: Readiness = { ready: false, reason: "not_logged_in", message: unavailableText("not_logged_in") };
const USAGE: Readiness = { ready: false, reason: "usage_limit", message: unavailableText("usage_limit") };
const NO_KEY: Readiness = { ready: false, reason: "no_api_key", message: unavailableText("no_api_key") };

describe("billingLine", () => {
  it("is the one sentence every surface prints", () => {
    expect(billingLine("live", "gpt-live-1-codex")).toBe("ChatGPT 方案（Codex 額度）· gpt-live-1-codex");
    expect(billingLine("api_key", "gpt-realtime")).toBe("OpenAI API key 計費 · gpt-realtime");
  });
});

describe("planStart", () => {
  const prefs: RoutePreference[] = ["auto", "live", "api_key"];
  const lives = [READY, NOT_LOGGED_IN, USAGE];
  const keys = [READY, NO_KEY];

  it("covers every preference × live state × key state", () => {
    for (const pref of prefs) {
      for (const live of lives) {
        for (const key of keys) {
          const plan = planStart(pref, live, key);
          if (pref === "live") {
            // live 絕不用 API key 計費。
            expect(plan.kind === "start" ? plan.route : "refuse").toBe(live.ready ? "live" : "refuse");
            if (plan.kind === "start") expect(plan.fallback).toBeNull();
          } else if (pref === "api_key") {
            expect(plan.kind === "start" ? plan.route : "refuse").toBe(key.ready ? "api_key" : "refuse");
            if (plan.kind === "start") expect(plan.notice).toBeNull();
          } else if (live.ready) {
            expect(plan).toEqual({ kind: "start", route: "live", fallback: key.ready ? "api_key" : null, notice: null });
          } else if (key.ready) {
            expect(plan).toMatchObject({ kind: "start", route: "api_key", fallback: null });
            // 從來沒登入 ChatGPT 方案＝只用 API key 的設定：安靜開始；設定過但不能用才說計費通知。
            if (plan.kind === "start") expect(plan.notice).toBe(live.reason === "not_logged_in" ? null : `這次改用 OpenAI API key（依用量計費）：${live.message}`);
          } else {
            expect(plan.kind).toBe("refuse");
          }
        }
      }
    }
  });

  it("auto + never logged in starts the API key route silently; a configured-but-broken live announces", () => {
    // 審查的探針（probe-live/plan.mts）：只用 API key 的使用者每次開始都會聽到改路徑的通知。
    expect(planStart("auto", NOT_LOGGED_IN, READY)).toEqual({ kind: "start", route: "api_key", fallback: null, notice: null });
    for (const reason of ["needs_reauth", "usage_limit", "upstream"] as const) {
      const live: Readiness = { ready: false, reason, message: unavailableText(reason) };
      expect(planStart("auto", live, READY)).toMatchObject({ kind: "start", route: "api_key", notice: `這次改用 OpenAI API key（依用量計費）：${live.message}` });
    }
    // 明確選了 live：照實說為什麼不能用，不改路徑。
    expect(planStart("live", NOT_LOGGED_IN, READY)).toMatchObject({ kind: "refuse", reasons: { live: "not_logged_in" } });
  });

  it("refuses with both reasons in one sentence", () => {
    const plan = planStart("auto", NOT_LOGGED_IN, NO_KEY);
    expect(plan).toMatchObject({ kind: "refuse", reasons: { live: "not_logged_in", api_key: "no_api_key" } });
    if (plan.kind === "refuse") expect(plan.message).toBe(`即時語音無法開始：${NOT_LOGGED_IN.message}；未設定 OPENAI_API_KEY`);
  });

  it("a missing route is treated as absent, so a key-only setup behaves as before", () => {
    expect(planStart("auto", null, READY)).toMatchObject({ kind: "start", route: "api_key", notice: null });
    expect(planStart("live", null, NO_KEY)).toMatchObject({ kind: "refuse", reasons: { api_key: "no_api_key" } });
  });
});

describe("planFallback", () => {
  const live = { kind: "start" as const, route: "live" as const, fallback: "api_key" as const, notice: null };
  it("falls back only for auto + a fallbackable reason + a ready key", () => {
    expect(planFallback(live, new RouteStartError("usage_limit", 429, "額度已用完", true))).toEqual({ notice: "這次改用 OpenAI API key（依用量計費）：額度已用完" });
    expect(planFallback(live, new RouteStartError("model_rejected", 400, "model", false))).toBeNull();
    expect(planFallback({ ...live, fallback: null }, new RouteStartError("usage_limit", 429, "x", true))).toBeNull();
    expect(planFallback({ ...live, route: "api_key" }, new RouteStartError("upstream", 502, "x", true))).toBeNull();
  });
});

// ───────── RealtimeSessions ─────────

interface FakeRoute extends RealtimeRoute {
  ready: Readiness;
  ctx: SessionContext | null;
  closes: string[];
  fail: RouteStartError | null;
}

function fakeRoute(id: "live" | "api_key", model: string): FakeRoute {
  const route: FakeRoute = {
    id,
    ready: READY,
    ctx: null,
    closes: [],
    fail: null,
    readiness: () => route.ready,
    describe: () => ({ id, available: route.ready.ready, reason: route.ready.ready ? null : route.ready.reason, billing_line: billingLine(id, model), model, voice: "cove", voices: [], tools: "", detail: `fixture ${id}` }),
    baseInfo: (): RealtimeBaseInfo => ({ available: route.ready.ready, model, detail: `fixture ${id}` }),
    async connect(_sdp, ctx): Promise<RouteCall> {
      route.ctx = ctx;
      if (route.fail) throw route.fail;
      return { route: id, answerSdp: "v=0 answer", model, control: id === "live" ? { input: () => {} } : null, close: async (reason) => void route.closes.push(reason) };
    },
  };
  return route;
}

function setup(pref: RoutePreference = "auto") {
  const live = fakeRoute("live", "gpt-live-1-codex");
  const key = fakeRoute("api_key", "gpt-realtime");
  const sent: { client: string; event: Record<string, unknown> }[] = [];
  const open = new Set(["sse_a"]);
  let preference = pref;
  const sessions = new RealtimeSessions({
    routes: { live, api_key: key },
    preference: () => preference,
    tasks: () => [],
    send: (client, event) => {
      if (!open.has(client)) return false;
      sent.push({ client, event: event as unknown as Record<string, unknown> });
      return true;
    },
  });
  return { live, key, sent, open, sessions, setPref: (p: RoutePreference) => (preference = p) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeSessions", () => {
  it("start decides once; a preference change during a live session leaves it alone and applies to the next start", async () => {
    const t = setup("auto");
    const d = t.sessions.start("sse_a");
    expect(d).toMatchObject({ ok: true, route: "live", billing_line: "ChatGPT 方案（Codex 額度）· gpt-live-1-codex", notice: null });
    if (!d.ok) throw new Error("expected start");
    expect(await t.sessions.call("v=0 offer", d.session_id, d.owner)).toMatchObject({ route: "live", sdp: "v=0 answer" });
    t.setPref("api_key");
    expect(t.sessions.view()).toMatchObject({ preference: "api_key", route: "api_key", active: { route: "live", billing_line: "ChatGPT 方案（Codex 額度）· gpt-live-1-codex" } });
    // 一個核心只有一個 live 工作階段。
    expect(t.sessions.start("sse_a")).toMatchObject({ ok: false, reasons: { live: "session_busy" } });
    await t.sessions.end(d.session_id, d.owner);
    expect(t.live.closes).toEqual(["ended"]);
    expect(t.sessions.start("sse_a")).toMatchObject({ ok: true, route: "api_key" });
  });

  it("host-result, input and end need the owner token", async () => {
    const t = setup("live");
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await expect(t.sessions.call("v=0", d.session_id, "own_wrongwrongwrongwrongwrong")).rejects.toBeInstanceOf(SessionError);
    const again = t.sessions.start("sse_a");
    if (!again.ok) throw new Error("expected start");
    await t.sessions.call("v=0", again.session_id, again.owner);
    expect(() => t.sessions.input(again.session_id, "own_wrongwrongwrongwrongwrong", "notice", "x")).toThrow(SessionError);
    expect(() => t.sessions.hostResult(again.session_id, "own_wrongwrongwrongwrongwrong", "hc_x", { output: {} })).toThrow(SessionError);
    await expect(t.sessions.end(again.session_id, "own_wrongwrongwrongwrongwrong")).rejects.toBeInstanceOf(SessionError);
  });

  it("the live route needs the page's SSE stream", () => {
    const t = setup("live");
    expect(t.sessions.start(null)).toMatchObject({ ok: false });
  });

  it("host calls go only to the owning stream; when that stream closes the session ends at once and pending calls are rejected", async () => {
    const t = setup("live");
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    const pending = t.live.ctx!.host.call("home_status", { target: "客廳" }, new AbortController().signal);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ client: "sse_a", event: { type: "realtime.host", call: { name: "home_status" } } });
    expect(t.live.ctx!.host.outstanding).toBe(1);
    t.open.delete("sse_a");
    t.sessions.clientClosed("sse_a");
    await expect(pending).rejects.toBeInstanceOf(HostGone);
    expect(t.live.closes).toEqual(["page_gone"]);
    // 重新整理的頁面可以馬上開始（沒有 session_busy 寬限期）。
    t.open.add("sse_b");
    expect(t.sessions.start("sse_b")).toMatchObject({ ok: true, route: "live" });
  });

  it("a host timeout on a side-effecting tool is 「結果不明，請確認」, never failure; other tools time out as ok:false", async () => {
    vi.useFakeTimers();
    const t = setup("live");
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    const signal = new AbortController().signal;
    const control = t.live.ctx!.host.call("home_control", { target: "客廳燈", command: "power", value: "true" }, signal);
    const status = t.live.ctx!.host.call("home_status", { target: "客廳" }, signal);
    vi.advanceTimersByTime(HOST_TIMEOUT_MS.home_status);
    expect(await status).toMatchObject({ ok: false });
    vi.advanceTimersByTime(HOST_TIMEOUT_MS.home_control - HOST_TIMEOUT_MS.home_status);
    const output = await control;
    expect(output).toMatchObject({ status: "unknown" });
    expect(String(output.message)).toContain(RESULT_UNKNOWN_TEXT);
    expect(JSON.stringify(output)).not.toMatch(/失敗|failed/);
    expect(t.sent.map((s) => s.event)).toContainEqual(expect.objectContaining({ type: "realtime.live", event: { kind: "tool_unknown", name: "home_control", message: RESULT_UNKNOWN_TEXT } }));
  });

  it("approval: only a spoken answer opens the answer window; timeout or dismiss just closes the card", async () => {
    vi.useFakeTimers();
    const t = setup("live");
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    const ctx = t.live.ctx!;
    t.sessions.approval(d.session_id, d.owner, { state: "open", timeout_ms: 60_000 });
    expect(ctx.approval()).toEqual({ open: true, resolvedAt: null });
    t.sessions.approval(d.session_id, d.owner, { state: "resolved", outcome: "timeout" });
    expect(ctx.approval()).toEqual({ open: false, resolvedAt: null });
    t.sessions.approval(d.session_id, d.owner, { state: "open", timeout_ms: 60_000 });
    t.sessions.approval(d.session_id, d.owner, { state: "resolved", outcome: "dismissed" });
    expect(ctx.approval()).toEqual({ open: false, resolvedAt: null });
    t.sessions.approval(d.session_id, d.owner, { state: "open", timeout_ms: 60_000 });
    t.sessions.approval(d.session_id, d.owner, { state: "resolved", outcome: "said_approve" });
    expect(ctx.approval()).toEqual({ open: false, resolvedAt: Date.now() });
  });

  it("approval: when the page's 「resolved」 never arrives, the open card expires after its own timeout", async () => {
    vi.useFakeTimers();
    const t = setup("live");
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    t.sessions.approval(d.session_id, d.owner, { state: "open", timeout_ms: 30_000 });
    vi.advanceTimersByTime(30_000);
    expect(t.live.ctx!.approval().open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(t.live.ctx!.approval()).toEqual({ open: false, resolvedAt: null });
  });

  it("a closed event from the route ends the session and rejects pending host calls (no fallback mid-session)", async () => {
    const t = setup("auto");
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    const pending = t.live.ctx!.host.call("web_search", { query: "x" }, new AbortController().signal);
    t.live.ctx!.emit({ kind: "closed", reason: "connection_lost", message: "斷線" });
    await expect(pending).rejects.toBeInstanceOf(HostGone);
    expect(t.sessions.view().active).toBeNull();
    expect(t.sent.at(-1)?.event).toMatchObject({ type: "realtime.live", event: { kind: "closed", reason: "connection_lost" } });
  });

  it("auto: a fallbackable live failure at start offers one api_key session with a billing notice", async () => {
    const t = setup("auto");
    t.live.fail = new RouteStartError("usage_limit", 429, "ChatGPT 方案額度已用完", true);
    const d = t.sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    const err = await t.sessions.call("v=0", d.session_id, d.owner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FallbackRequired);
    const offer = (err as FallbackRequired).offer;
    expect(offer.fallback).toMatchObject({ route: "api_key", notice: "這次改用 OpenAI API key（依用量計費）：ChatGPT 方案額度已用完", billing_line: "OpenAI API key 計費 · gpt-realtime" });
    expect(await t.sessions.call("v=0", offer.fallback!.session_id, offer.fallback!.owner)).toMatchObject({ route: "api_key" });
    expect(t.sessions.view().active).toMatchObject({ route: "api_key" });
  });

  it("live preference or a config error never falls back to billing", async () => {
    for (const [pref, fail] of [
      ["live", new RouteStartError("usage_limit", 429, "額度", true)],
      ["auto", new RouteStartError("model_rejected", 400, unavailableText("model_rejected"), false)],
    ] as const) {
      const t = setup(pref);
      t.live.fail = fail;
      const d = t.sessions.start("sse_a");
      if (!d.ok) throw new Error("expected start");
      await expect(t.sessions.call("v=0", d.session_id, d.owner)).rejects.toBeInstanceOf(RouteStartError);
    }
  });
});

describe("MEM-2 RealtimeSessions: rebuild start and stop reports", () => {
  it("a rebuild start uses live only (even with preference api_key), issues no interaction, and never offers the API key fallback", async () => {
    const t = setup("api_key");
    const d = t.sessions.start("sse_a", "look_to_talk", "zh-TW", true);
    expect(d).toMatchObject({ ok: true, route: "live", interaction: null });
    if (!d.ok) throw new Error("expected start");
    t.live.fail = new RouteStartError("usage_limit", 429, unavailableText("usage_limit"), true);
    await expect(t.sessions.call("v=0", d.session_id, d.owner)).rejects.toBeInstanceOf(RouteStartError);
    expect(t.live.ctx).toMatchObject({ rebuild: true, lookToTalk: false });
    t.live.ready = USAGE;
    expect(t.sessions.start("sse_a", "user", "zh-TW", true)).toMatchObject({ ok: false, reasons: { live: "usage_limit" } });
  });

  it("only a memory-revoked session accepts a stop report (owner checked); a late host result is refused; force silence lifts on the report or the next call", async () => {
    const muted: boolean[] = [];
    const live = fakeRoute("live", "gpt-live-1-codex");
    const sent: Record<string, unknown>[] = [];
    const sessions = new RealtimeSessions({ routes: { live }, preference: () => "live", tasks: () => [], send: (_c, e) => (sent.push(e as unknown as Record<string, unknown>), true), audio: { setMuted: (m) => void muted.push(m) } });
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await sessions.call("v=0", d.session_id, d.owner);
    const ctx = live.ctx!;
    expect(sessions.stoppedReport(d.session_id, d.owner, { paused: true, peer_closed: true, tracks_ended: true, ms: 1 })).toBe(false);
    ctx.emit({ kind: "closed", reason: "memory_revoked", message: "記憶已更新，對話已重新開始", rebuild: true });
    // 停播結果出來之前（沒回報、也還沒逾時）：不開始新的（含重建）。
    expect(sessions.start("sse_a", "user", "zh-TW", true)).toMatchObject({ ok: false, reasons: { live: "session_busy" } });
    const waiting = ctx.stopped!(1_000);
    expect(sessions.hostResult(d.session_id, d.owner, "hc_" + "0".repeat(32), { output: { ok: true } })).toBe(false);
    expect(() => sessions.stoppedReport(d.session_id, "own_someone_else_00000000", { paused: true, peer_closed: true, tracks_ended: true, ms: 1 })).toThrow(SessionError);
    expect(sessions.stoppedReport(d.session_id, d.owner, { paused: true, peer_closed: false, tracks_ended: true, ms: 7 })).toBe(false);
    expect(sessions.stoppedReport(d.session_id, d.owner, { paused: true, peer_closed: true, tracks_ended: true, ms: 7 })).toBe(true);
    expect(await waiting).toEqual({ paused: true, peer_closed: true, tracks_ended: true, ms: 7 });
    // 停播未確認：強制靜音並送一則固定句給頁面；新通話開始時解除。
    ctx.forceSilence!("即時語音停止未確認；這條路徑的記憶已停用");
    expect(muted).toEqual([true]);
    expect(sent.at(-1)).toMatchObject({ type: "realtime.live", session_id: d.session_id, event: { kind: "memory_notice" } });
    const next = sessions.start("sse_a");
    if (!next.ok) throw new Error("expected start");
    await sessions.call("v=0", next.session_id, next.owner);
    expect(muted).toEqual([true, false]);
  });
});
