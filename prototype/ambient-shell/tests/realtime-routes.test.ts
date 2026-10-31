import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyVoiceUsage, VOICE_USAGE_CAP, type VoiceCostRecord } from "../shared/voice-cost.ts";
import { WAKE_START_RATE } from "../shared/wake.ts";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { VoiceCostLog } from "../server/voice-cost-log.ts";
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
  WAKE_LIMITED_TEXT,
  COST_AMEND_GRACE_MS,
  GREETING_CLAIM_MS,
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
    // MEM-3 審查：重建一定要有被撤銷、停播回報被採用的那一通；先在 live 上撤銷一通。
    t.setPref("live");
    const first = t.sessions.start("sse_a");
    if (!first.ok) throw new Error("expected start");
    await t.sessions.call("v=0", first.session_id, first.owner);
    t.live.ctx!.emit({ kind: "closed", reason: "memory_revoked", message: "x", rebuild: true });
    expect(t.sessions.stoppedReport(first.session_id, first.owner, { paused: true, peer_closed: true, tracks_ended: true, ms: 1 })).toBe(true);
    t.setPref("api_key");
    const d = t.sessions.start("sse_a", "look_to_talk", "zh-TW", true);
    expect(d).toMatchObject({ ok: true, route: "live", interaction: null });
    if (!d.ok) throw new Error("expected start");
    t.live.fail = new RouteStartError("usage_limit", 429, unavailableText("usage_limit"), true);
    await expect(t.sessions.call("v=0", d.session_id, d.owner)).rejects.toBeInstanceOf(RouteStartError);
    expect(t.live.ctx).toMatchObject({ rebuild: true, lookToTalk: false });
    t.live.ready = USAGE;
    // 那一次撤銷已經重建過：再要求重建照實拒絕（不默默改走別的路徑）。
    expect(t.sessions.start("sse_a", "user", "zh-TW", true)).toMatchObject({ ok: false, reasons: {} });
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

describe("MEM-3 RealtimeSessions: the API key route uses the same session, revocation and rebuild rules", () => {
  /** api_key 的假通話：記下 greetingDecided／playback（ApiKeyCall 的掛鉤）。 */
  function keyWithHooks() {
    const t = setup("api_key");
    const hooks = { greeted: [] as boolean[], playback: 0, stopReply: 0 };
    t.key.connect = async (_sdp, ctx) => {
      t.key.ctx = ctx;
      if (t.key.fail) throw t.key.fail;
      return {
        route: "api_key", answerSdp: "v=0 answer", model: "gpt-realtime", control: null,
        coreTools: ["recall_memory", "delegate_task"], memoryStatus: () => ({ used: 2, reason: null }),
        greetingDecided: (named) => void hooks.greeted.push(named), playback: () => void hooks.playback++, stopReply: () => void hooks.stopReply++,
        close: async (reason) => void t.key.closes.push(reason),
      };
    };
    return { ...t, hooks };
  }

  it("the /call answer carries core tools and the memory status; tool calls go to the owning stream; greeting and playback reach the call", async () => {
    const t = keyWithHooks();
    const d = t.sessions.start("sse_a", "look_to_talk");
    if (!d.ok) throw new Error("expected start");
    const answer = await t.sessions.call("v=0", d.session_id, d.owner);
    expect(answer).toEqual({ sdp: "v=0 answer", model: "gpt-realtime", route: "api_key", session_id: d.session_id, core_tools: ["recall_memory", "delegate_task"], memory: { used: 2, reason: null } });
    expect(t.key.ctx).toMatchObject({ events: true, lookToTalk: true });
    const pending = t.key.ctx!.host.call("delegate_task", { title: "寫週報" }, new AbortController().signal);
    const host = t.sent.at(-1)!.event as { type: string; call: { call_id: string; name: string } };
    expect(host).toMatchObject({ type: "realtime.host", call: { name: "delegate_task" } });
    expect(t.sessions.hostResult(d.session_id, d.owner, host.call.call_id, { output: { ok: true } })).toBe(true);
    expect(await pending).toEqual({ ok: true });
    t.sessions.greeted(d.session_id, true);
    t.sessions.playback(d.session_id, d.owner);
    expect(t.hooks).toEqual({ greeted: [true], playback: 1, stopReply: 0 });
    expect(() => t.sessions.playback(d.session_id, "own_someone_else_00000000")).toThrow(SessionError);
    // F7：手掌停止（停止回覆）只交給擁有者頁面的通話；不結束工作階段。
    t.sessions.stopReply(d.session_id, d.owner);
    expect(t.hooks.stopReply).toBe(1);
    expect(() => t.sessions.stopReply(d.session_id, "own_someone_else_00000000")).toThrow(SessionError);
    expect(t.key.closes).toEqual([]);
    // API key 路徑的輸入走資料通道，不經核心。
    expect(() => t.sessions.input(d.session_id, d.owner, "notice", "x")).toThrow(SessionError);
  });

  it("a page without an SSE stream gets no events (ctx.events false)", async () => {
    const t = keyWithHooks();
    const d = t.sessions.start(null);
    if (!d.ok) throw new Error("expected start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    expect(t.key.ctx).toMatchObject({ events: false });
    await expect(t.key.ctx!.host.call("delegate_task", {}, new AbortController().signal)).rejects.toBeInstanceOf(HostGone);
  });

  it("revoked: new starts wait for the stop result, the stop report checks the owner, late host results are refused, and the rebuild uses api_key again with no fallback", async () => {
    const muted: boolean[] = [];
    const live = fakeRoute("live", "gpt-live-1-codex");
    const key = fakeRoute("api_key", "gpt-realtime");
    const sent: Record<string, unknown>[] = [];
    let preference: RoutePreference = "api_key";
    const sessions = new RealtimeSessions({ routes: { live, api_key: key }, preference: () => preference, tasks: () => [], send: (_c, e) => (sent.push(e as unknown as Record<string, unknown>), true), audio: { setMuted: (m) => void muted.push(m) } });
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await sessions.call("v=0", d.session_id, d.owner);
    const ctx = key.ctx!;
    const pending = ctx.host.call("delegate_task", { title: "x" }, new AbortController().signal);
    const host = sent.at(-1) as { call: { call_id: string } };
    ctx.emit({ kind: "closed", reason: "memory_revoked", message: "記憶已更新，對話已重新開始", rebuild: true });
    await expect(pending).rejects.toBeInstanceOf(HostGone);
    expect(key.closes).toEqual(["ended"]);
    expect(sessions.start("sse_a", "user", "zh-TW", true)).toMatchObject({ ok: false, reasons: { live: "session_busy" } });
    expect(sessions.hostResult(d.session_id, d.owner, host.call.call_id, { output: { ok: true } })).toBe(false);
    expect(sessions.isOwner(d.session_id, d.owner)).toBe(false);
    expect(() => sessions.stoppedReport(d.session_id, "own_someone_else_00000000", { paused: true, peer_closed: true, tracks_ended: true, ms: 1 })).toThrow(SessionError);
    expect(sessions.stoppedReport(d.session_id, d.owner, { paused: true, peer_closed: true, tracks_ended: true, ms: 3 })).toBe(true);
    // 偏好改成 live：重建仍走被撤銷那通的路徑（api_key）。
    preference = "live";
    const rebuilt = sessions.start("sse_a", "look_to_talk", "zh-TW", true);
    expect(rebuilt).toMatchObject({ ok: true, route: "api_key", interaction: null });
    if (!rebuilt.ok) throw new Error("expected rebuild");
    key.fail = new RouteStartError("api_key_rejected", 502, "x", false);
    await expect(sessions.call("v=0", rebuilt.session_id, rebuilt.owner)).rejects.toBeInstanceOf(RouteStartError);
    expect(key.ctx).toMatchObject({ rebuild: true });
    // 同一次撤銷不能重建兩次；找不到要重建的通話時照實拒絕，不默默改走 live。
    expect(sessions.start("sse_a", "user", "zh-TW", true)).toMatchObject({ ok: false, message: "即時語音無法開始：找不到要重建的通話，請重新開始" });
  });

  it("forced silence after an unconfirmed api_key stop lifts when the next call starts; key unavailable refuses a rebuild honestly", async () => {
    const muted: boolean[] = [];
    const key = fakeRoute("api_key", "gpt-realtime");
    const sent: Record<string, unknown>[] = [];
    const sessions = new RealtimeSessions({ routes: { api_key: key }, preference: () => "api_key", tasks: () => [], send: (_c, e) => (sent.push(e as unknown as Record<string, unknown>), true), audio: { setMuted: (m) => void muted.push(m) } });
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await sessions.call("v=0", d.session_id, d.owner);
    const ctx = key.ctx!;
    ctx.emit({ kind: "closed", reason: "memory_revoked", message: "x", rebuild: true });
    expect(await ctx.stopped!(10)).toBeNull();
    ctx.forceSilence!("即時語音停止未確認；這條路徑的記憶已停用");
    expect(muted).toEqual([true]);
    expect(sent.at(-1)).toMatchObject({ type: "realtime.live", event: { kind: "memory_notice" } });
    const next = sessions.start("sse_a");
    if (!next.ok) throw new Error("expected start");
    await sessions.call("v=0", next.session_id, next.owner);
    expect(muted).toEqual([true, false]);
    // 停播回報沒被採用的撤銷不能拿來重建；key 不能用時照實拒絕（不改走 live）。
    key.ready = NO_KEY;
    expect(sessions.start("sse_a", "user", "zh-TW", true)).toMatchObject({ ok: false });
  });
});

describe("MEM-3 test flag NOUS_TEST_RENDERER_IGNORE_REVOKE", () => {
  it("hides only the memory_revoked closed event from the page (hangup alone must stop it); the session still ends and forced silence still works", async () => {
    const muted: boolean[] = [];
    const key = fakeRoute("api_key", "gpt-realtime");
    const sent: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const sessions = new RealtimeSessions({ routes: { api_key: key }, preference: () => "api_key", tasks: () => [], send: (_c, e) => (sent.push(e as unknown as Record<string, unknown>), true), audio: { setMuted: (m) => void muted.push(m) }, hideRevokeFromPage: true, log: (l) => void logs.push(l) });
    const d = sessions.start("sse_a");
    if (!d.ok) throw new Error("expected start");
    await sessions.call("v=0", d.session_id, d.owner);
    const ctx = key.ctx!;
    ctx.emit({ kind: "memory_notice", message: "x" });
    ctx.emit({ kind: "closed", reason: "memory_revoked", message: "記憶已更新，對話已重新開始", rebuild: true });
    expect(sent.map((e) => (e.event as { kind: string }).kind)).toEqual(["memory_notice"]);
    expect(key.closes).toEqual(["ended"]);
    expect(sessions.isOwner(d.session_id, d.owner)).toBe(false);
    ctx.forceSilence!("即時語音停止未確認；這條路徑的記憶已停用");
    expect(muted).toEqual([true]);
    expect(logs.some((l) => l.includes("NOUS_TEST_RENDERER_IGNORE_REVOKE"))).toBe(true);
  });
});

describe("MEM-3 review: one memory-carrying voice call at a time", () => {
  it("while an API key call with core tools (memory rules) is active, any new start and a second /call are refused; the old call is never closed silently", async () => {
    const t = setup("api_key");
    t.key.connect = async (_sdp, ctx) => {
      t.key.ctx = ctx;
      return { route: "api_key", answerSdp: "v=0", model: "gpt-realtime", control: null, coreTools: ["recall_memory", "delegate_task"], memoryStatus: () => null, close: async (reason) => void t.key.closes.push(reason) };
    };
    const a = t.sessions.start("sse_a");
    const b = t.sessions.start("sse_a");
    if (!a.ok || !b.ok) throw new Error("expected decisions");
    await t.sessions.call("v=0", a.session_id, a.owner);
    expect(t.sessions.start("sse_a")).toMatchObject({ ok: false, reasons: { api_key: "session_busy" } });
    t.setPref("live");
    expect(t.sessions.start("sse_a")).toMatchObject({ ok: false, reasons: { api_key: "session_busy" } });
    // 開始之前就決定好的第二個 API key 工作階段：/call 也拒絕，不取代（取代會只關旁路、留下帶記憶的上游通話）。
    await expect(t.sessions.call("v=0", b.session_id, b.owner)).rejects.toMatchObject({ status: 409 });
    expect(t.key.closes).toEqual([]);
    await t.sessions.end(a.session_id, a.owner);
    expect(t.key.closes).toEqual(["ended"]);
    expect(t.sessions.start("sse_a")).toMatchObject({ ok: true });
  });

  it("an API key call without memory is still replaced by the next one (same as before MEM-3)", async () => {
    const t = setup("api_key");
    const a = t.sessions.start("sse_a");
    const b = t.sessions.start("sse_a");
    if (!a.ok || !b.ok) throw new Error("expected decisions");
    await t.sessions.call("v=0", a.session_id, a.owner);
    await t.sessions.call("v=0", b.session_id, b.owner);
    expect(t.key.closes).toEqual(["ended"]);
  });
});

// ───────── WK-02：wake_word 開始來源、限速與費用紀錄（fixture 路徑、假時鐘） ─────────

describe("WK-02 RealtimeSessions: wake_word source", () => {
  function wakeSetup(pref: RoutePreference = "auto", liveFails = false) {
    const clock = { now: 1_000_000 };
    const live = fakeRoute("live", "gpt-live-1-codex");
    const key = fakeRoute("api_key", "gpt-realtime");
    if (liveFails) live.fail = new RouteStartError("usage_limit", 429, "額度已用完（fixture）", true);
    const records: VoiceCostRecord[] = [];
    const sessions = new RealtimeSessions({
      routes: { live, api_key: key },
      preference: () => pref,
      tasks: () => [],
      send: () => true,
      now: () => clock.now,
      costLog: { record: (r) => void records.push(r) },
    });
    return { clock, live, key, sessions, records };
  }

  it("issues an interaction ID for wake_word; claimGreeting reports the source; wakeGreetingOpen is true until the claim", async () => {
    const t = wakeSetup("live");
    const d = t.sessions.start("sse_a", "wake_word", "zh-TW", false, "int_00000000000000aa");
    if (!d.ok || !d.interaction) throw new Error("expected an interaction");
    expect(t.sessions.wakeGreetingOpen()).toBe(true);
    await t.sessions.call("v=0", d.session_id, d.owner);
    // 喚醒開始的通話：記憶的「看著說話」旗標照舊（有互動 ID 就是 true）
    expect(t.live.ctx?.lookToTalk).toBe(true);
    expect(t.sessions.claimGreeting(d.interaction)).toEqual({ route: "live", session_id: d.session_id, source: "wake_word" });
    expect(t.sessions.wakeGreetingOpen()).toBe(false);
    expect(t.sessions.claimGreeting(d.interaction)).toBeNull();
    // 問候被跳過（沒有 claim）時，通話結束也結束放寬
    await t.sessions.end(d.session_id, d.owner);
    const skipped = t.sessions.start("sse_a", "wake_word");
    if (!skipped.ok) throw new Error("start");
    await t.sessions.call("v=0", skipped.session_id, skipped.owner);
    expect(t.sessions.wakeGreetingOpen()).toBe(true);
    await t.sessions.end(skipped.session_id, skipped.owner);
    expect(t.sessions.wakeGreetingOpen()).toBe(false);
    // 看著說話開始的互動不會讓 wakeGreetingOpen 成立
    const l = t.sessions.start("sse_a", "look_to_talk");
    if (!l.ok || !l.interaction) throw new Error("expected an interaction");
    expect(t.sessions.wakeGreetingOpen()).toBe(false);
    // user 沒有互動 ID
    expect(t.sessions.start("sse_a", "user")).toMatchObject({ ok: true, interaction: null });
  });

  it("live → API key fallback keeps the wake interaction ID, its source and the wake_id (at most one greeting per wake)", async () => {
    const t = wakeSetup("auto", true);
    const d = t.sessions.start("sse_a", "wake_word", "zh-TW", false, "int_00000000000000bb");
    if (!d.ok || !d.interaction) throw new Error("start");
    const err = (await t.sessions.call("v=0", d.session_id, d.owner).catch((e: unknown) => e)) as FallbackRequired;
    expect(err).toBeInstanceOf(FallbackRequired);
    expect(t.sessions.claimGreeting(d.interaction)).toBeNull(); // live 沒有連上
    const fb = err.offer.fallback!;
    await t.sessions.call("v=0", fb.session_id, fb.owner);
    expect(t.sessions.claimGreeting(d.interaction)).toEqual({ route: "api_key", session_id: fb.session_id, source: "wake_word" });
    expect(t.sessions.claimGreeting(d.interaction)).toBeNull();
    await t.sessions.end(fb.session_id, fb.owner);
    // 費用紀錄：live 沒連上（connect_failed）、API key 那通，兩筆都帶同一個 wake_id
    expect(t.records.map((r) => [r.route, r.end_reason, r.connected, r.source, r.wake_id])).toEqual([
      ["live", "connect_failed", false, "wake_word", "int_00000000000000bb"],
      ["api_key", "ended", true, "wake_word", "int_00000000000000bb"],
    ]);
  });

  it("rate limit: the 4th accepted wake_word start within a rolling 60 s is refused with wake_limited and retry_after_ms; allowed again at 60 s", () => {
    const t = wakeSetup("api_key");
    for (let i = 0; i < 3; i++) {
      expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: true });
      t.clock.now += 10_000;
    }
    // 第一次在 1_000_000，現在 1_030_000：還要 30 秒
    const refused = t.sessions.start("sse_a", "wake_word");
    expect(refused).toEqual({ ok: false, message: WAKE_LIMITED_TEXT, reasons: {}, wake_limited: true, retry_after_ms: 30_000 });
    expect(WAKE_LIMITED_TEXT).toContain(`${WAKE_START_RATE.per_minute} 次`);
    // 其他來源不算、也不被擋
    expect(t.sessions.start("sse_a", "user")).toMatchObject({ ok: true });
    expect(t.sessions.start("sse_a", "look_to_talk")).toMatchObject({ ok: true });
    t.clock.now += 29_999;
    expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: false, wake_limited: true, retry_after_ms: 1 });
    t.clock.now += 1; // 第一次滿 60 秒
    expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: true });
    expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: false, wake_limited: true });
  });

  it("refused wake starts (route unavailable) are not counted; other sources never count", () => {
    const t = wakeSetup("api_key");
    t.key.ready = NO_KEY;
    for (let i = 0; i < 5; i++) expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: false, reasons: { api_key: "no_api_key" } });
    t.key.ready = READY;
    for (let i = 0; i < 10; i++) expect(t.sessions.start("sse_a", "user")).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++) expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: true });
    expect(t.sessions.start("sse_a", "wake_word")).toMatchObject({ ok: false, wake_limited: true });
  });

  it("F6 cost record: API key usage comes from the page, live is unknown; no_voice is recorded; cost is always unknown", async () => {
    const t = wakeSetup("api_key");
    const d = t.sessions.start("sse_a", "wake_word", "zh-TW", false, "int_00000000000000cc");
    if (!d.ok) throw new Error("start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    t.clock.now += 7_250;
    const usage = { ...emptyVoiceUsage(), responses: 2, input_tokens: 120, output_tokens: 80, total_tokens: 200 };
    await t.sessions.end(d.session_id, d.owner, { reason: "no_voice", usage });
    await t.sessions.end(d.session_id, d.owner, { reason: "no_voice", usage }); // 重複結束不重複記
    expect(t.records).toEqual([
      {
        v: 1,
        session_id: d.session_id,
        route: "api_key",
        model: "gpt-realtime",
        source: "wake_word",
        wake_id: "int_00000000000000cc",
        started_at: new Date(1_000_000).toISOString(),
        ended_at: new Date(1_007_250).toISOString(),
        connected: true,
        connected_ms: 7_250,
        end_reason: "no_voice",
        no_voice_auto_end: true,
        usage,
        cost: "unknown",
      },
    ]);
    const u = wakeSetup("live");
    const e = u.sessions.start("sse_a", "user", "zh-TW", false, "int_00000000000000dd");
    if (!e.ok) throw new Error("start");
    await u.sessions.call("v=0", e.session_id, e.owner);
    await u.sessions.end(e.session_id, e.owner, { usage });
    expect(u.records).toMatchObject([{ route: "live", source: "user", wake_id: null, usage: "unknown", no_voice_auto_end: false, end_reason: "ended", cost: "unknown" }]);
    // 紀錄裡沒有逐字稿、音訊或名字這類欄位
    expect(Object.keys(u.records[0]!).sort()).toEqual(["connected", "connected_ms", "cost", "end_reason", "ended_at", "model", "no_voice_auto_end", "route", "session_id", "source", "started_at", "usage", "v", "wake_id"]);
  });

  it("wakeGreetingOpen only while the start is pending/connecting or connected within GREETING_CLAIM_MS; never after a page abort or a failed connect without fallback", async () => {
    const t = wakeSetup("live");
    const d = t.sessions.start("sse_a", "wake_word");
    if (!d.ok) throw new Error("start");
    expect(t.sessions.wakeGreetingOpen()).toBe(true); // 開始的決定還在
    await t.sessions.end(d.session_id, d.owner); // 頁面在送 offer 前放棄
    expect(t.sessions.wakeGreetingOpen()).toBe(false);
    await expect(t.sessions.call("v=0", d.session_id, d.owner)).rejects.toBeInstanceOf(SessionError);

    const e = t.sessions.start("sse_a", "wake_word");
    if (!e.ok || !e.interaction) throw new Error("start");
    await t.sessions.call("v=0", e.session_id, e.owner);
    t.clock.now += GREETING_CLAIM_MS + 1;
    expect(t.sessions.wakeGreetingOpen()).toBe(false); // 連上超過 20 秒
    await t.sessions.end(e.session_id, e.owner);

    const f = wakeSetup("live");
    f.live.fail = new RouteStartError("model_rejected", 400, "model（fixture）", false);
    const g = f.sessions.start("sse_a", "wake_word");
    if (!g.ok) throw new Error("start");
    await expect(f.sessions.call("v=0", g.session_id, g.owner)).rejects.toBeInstanceOf(RouteStartError);
    expect(f.sessions.wakeGreetingOpen()).toBe(false); // 連線失敗、沒有改路徑
  });

  it("a live no_voice end that arrives after the core already saw closed amends the same record", async () => {
    const t = wakeSetup("live");
    const amended: VoiceCostRecord[] = [];
    (t.sessions as unknown as { options: { costLog: { amend(r: VoiceCostRecord): void } } }).options.costLog.amend = (r) => void amended.push(r);
    const d = t.sessions.start("sse_a", "wake_word", "zh-TW", false, "int_00000000000000ab");
    if (!d.ok) throw new Error("start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    t.live.ctx!.emit({ kind: "closed", reason: "connection_lost", message: "斷線" } as never);
    expect(t.records).toMatchObject([{ end_reason: "connection_lost", no_voice_auto_end: false }]);
    await t.sessions.end(d.session_id, "own_wrongwrongwrongwrongwrong", { reason: "no_voice" }); // 別人的憑證：不改
    expect(amended).toEqual([]);
    await t.sessions.end(d.session_id, d.owner, { reason: "no_voice" });
    expect(amended).toMatchObject([{ session_id: d.session_id, end_reason: "no_voice", no_voice_auto_end: true, usage: "unknown", wake_id: "int_00000000000000ab" }]);
    await t.sessions.end(d.session_id, d.owner, { reason: "no_voice" }); // 只補一次
    expect(amended).toHaveLength(1);
    // 超過補記時限就不改
    const u = wakeSetup("live");
    const late: VoiceCostRecord[] = [];
    (u.sessions as unknown as { options: { costLog: { amend(r: VoiceCostRecord): void } } }).options.costLog.amend = (r) => void late.push(r);
    const e = u.sessions.start("sse_a", "wake_word");
    if (!e.ok) throw new Error("start");
    await u.sessions.call("v=0", e.session_id, e.owner);
    u.live.ctx!.emit({ kind: "closed", reason: "connection_lost", message: "斷線" } as never);
    u.clock.now += COST_AMEND_GRACE_MS + 1;
    await u.sessions.end(e.session_id, e.owner, { reason: "no_voice" });
    expect(late).toEqual([]);
  });

  it("a page that goes away and a live closed event are recorded with the core's own reason", async () => {
    const t = wakeSetup("live");
    const d = t.sessions.start("sse_a", "user");
    if (!d.ok) throw new Error("start");
    await t.sessions.call("v=0", d.session_id, d.owner);
    t.sessions.clientClosed("sse_a");
    const e = t.sessions.start("sse_b", "user");
    if (!e.ok) throw new Error("start");
    await t.sessions.call("v=0", e.session_id, e.owner);
    t.live.ctx!.emit({ kind: "closed", reason: "expired", message: "到期" } as never);
    expect(t.records.map((r) => r.end_reason)).toEqual(["page_gone", "expired"]);
  });
});

describe("WK-02 POST /api/realtime/start: wake_word only with NOUS_WAKE on", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function app(wakeOn: boolean) {
    const store = new TaskStore(null);
    const dir = mkdtempSync(join(tmpdir(), "nous-wake-start-"));
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const runner = new TaskRunner(store, providers);
    const key = fakeRoute("api_key", "gpt-realtime");
    const records: VoiceCostRecord[] = [];
    const costLog = { record: (r: VoiceCostRecord) => void records.push(r), list: () => records.slice().reverse() } as unknown as VoiceCostLog;
    const wake = { view: () => ({ wake_listen: true, device_id: null }), update: () => ({ wake_listen: true, device_id: null }), runtime: () => "missing" as const };
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const server = createApp({ store, runner, settings: providers, auth, chat: providers, realtimeRoutes: { api_key: key }, voiceCostLog: costLog, ...(wakeOn ? { wake } : {}), port, devPort: 5173, distDir: null });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://localhost:${port}`;
    const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
    return { base, post, records };
  }

  it("flag off: wake_word is treated as user (no interaction ID, no rate limit, wake_id ignored); F6 cost records still cover every call (George 2026-10-31: always on)", async () => {
    const a = await app(false);
    for (let i = 0; i < 5; i++) {
      const d = await a.post("/api/realtime/start", { source: "wake_word", wake_id: "int_00000000000000ee" });
      expect(d).toMatchObject({ ok: true, interaction: null });
      await a.post("/api/realtime/call", { sdp: "v=0 offer", session_id: d.session_id, owner: d.owner });
      await a.post("/api/realtime/end", { session_id: d.session_id, owner: d.owner, reason: "no_voice", usage: { input_tokens: 5 } });
    }
    expect(a.records).toHaveLength(5);
    expect(a.records.every((r) => r.source === "user" && r.wake_id === null && r.end_reason === "no_voice")).toBe(true);
    expect(a.records[0]!.usage).toMatchObject({ input_tokens: 5 });
    expect((await fetch(`${a.base}/api/realtime/cost-records`)).status).toBe(200);
  });

  it("flag on: wake_word gets an interaction ID and the 4th start in a minute is refused; a bad wake_id is dropped", async () => {
    const a = await app(true);
    const first = await a.post("/api/realtime/start", { source: "wake_word", wake_id: "not a wake id" });
    expect(first).toMatchObject({ ok: true, interaction: expect.stringMatching(/^int_[0-9a-f]{16}$/) });
    await a.post("/api/realtime/call", { sdp: "v=0 offer", session_id: first.session_id, owner: first.owner });
    // /end：不認得的原因與欄位丟掉，usage 只取認得的數字並截上限
    await a.post("/api/realtime/end", { session_id: first.session_id, owner: first.owner, reason: "hacked", usage: { input_tokens: 5, output_tokens: 1e12, transcript: "秘密", total_tokens: -1 } });
    expect(a.records).toHaveLength(1);
    expect(a.records[0]).toMatchObject({ source: "wake_word", wake_id: null, end_reason: "ended", no_voice_auto_end: false, usage: { input_tokens: 5, output_tokens: VOICE_USAGE_CAP, total_tokens: 0, responses: 0 } });
    expect(JSON.stringify(a.records[0])).not.toContain("秘密");
    await a.post("/api/realtime/start", { source: "wake_word" });
    await a.post("/api/realtime/start", { source: "wake_word" });
    const fourth = await a.post("/api/realtime/start", { source: "wake_word" });
    expect(fourth).toMatchObject({ ok: false, wake_limited: true, retry_after_ms: expect.any(Number) });
    const records = (await (await fetch(`${a.base}/api/realtime/cost-records?limit=5`)).json()) as { records: unknown[] };
    expect(records.records).toHaveLength(1);
  });
});
