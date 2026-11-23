import { afterEach, describe, expect, it, vi } from "vitest";
import { CALL_WARN_BEFORE_MS, CallGuard, DEFAULT_MAX_CALL_MS } from "../src/call-guard.ts";
import { ALIVE_INTERVAL_MS, ALIVE_TIMEOUT_MS, CallLifecycle, GONE_GRACE_MS, HIDDEN_END_MS, type AliveOutcome } from "../src/call-lifecycle.ts";
import { RealtimeVoice, type RealtimeCallbacks } from "../src/realtime.ts";
import { LiveVoice, type LiveDeps } from "../src/live-voice.ts";
import { CALL_END_TEXT, type HostCall, type LiveCoreEvent } from "../shared/realtime-route.ts";
import { ZH_TW_TRANSCRIPTION_PROMPT } from "../shared/zh-tw.ts";
import { callMeterText, formatCallClock } from "../shared/call-meter.ts";
import { maxCallMs } from "../shared/voice-prefs.ts";
import { emptyVoiceUsage, parsePageEndReason, type PageEndReason } from "../shared/voice-cost.ts";
import { translate } from "../shared/i18n.mjs";

// 即時語音費用防護（George 2026-11-06，docs/validation/realtime-cost-guard-2026-11-06.md）：頁面這一端。
// 全部是 fixture：假的 WebRTC、假的資料通道與核心，不需要麥克風、喇叭或網路。

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const IDLE = 120_000;

describe("CallGuard", () => {
  function guard(opts: { maxMs?: number; busy?: () => boolean } = {}) {
    vi.useFakeTimers();
    const log: string[] = [];
    const g = new CallGuard(
      { busy: opts.busy ?? (() => false), idle: () => log.push("idle"), warn: (ms) => log.push(`warn:${ms}`), max: () => log.push("max") },
      { idleMs: IDLE, maxMs: opts.maxMs },
    );
    return { g, log };
  }

  it("ends at the idle time when nothing real happens; a reply end without a real turn does not extend it", () => {
    const { g, log } = guard();
    g.start();
    vi.advanceTimersByTime(IDLE - 1_000);
    g.replyDone(); // 雜音觸發的回覆：沒有 credit
    vi.advanceTimersByTime(1_000);
    expect(log).toEqual(["idle"]);
  });

  it("a real turn resets it, and only the first reply end after that turn resets again (credit is used once)", () => {
    const { g, log } = guard();
    g.start();
    vi.advanceTimersByTime(60_000);
    g.activity();
    vi.advanceTimersByTime(60_000);
    g.replyDone(); // 用掉 credit：從這裡重新倒數
    vi.advanceTimersByTime(IDLE - 1);
    g.replyDone(); // 沒有 credit：不延長
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual(["idle"]);
  });

  it("busy at the idle time re-arms once more (a long reply is never cut); the cap ignores busy", () => {
    let busy = true;
    const { g, log } = guard({ busy: () => busy });
    g.start();
    vi.advanceTimersByTime(IDLE);
    expect(log).toEqual([]);
    busy = false;
    vi.advanceTimersByTime(IDLE);
    expect(log).toEqual(["idle"]);
    const capped = guard({ busy: () => true, maxMs: 300_000 });
    capped.g.start();
    vi.advanceTimersByTime(300_000);
    expect(capped.log).toEqual([`warn:${CALL_WARN_BEFORE_MS}`, "max"]);
  });

  it("defaults to a 20-minute cap with one warning 60 s before it, counted from start()", () => {
    const { g, log } = guard({ busy: () => true });
    expect(g.maxCallMs).toBe(DEFAULT_MAX_CALL_MS);
    expect(DEFAULT_MAX_CALL_MS).toBe(20 * 60_000);
    g.start();
    vi.advanceTimersByTime(DEFAULT_MAX_CALL_MS - CALL_WARN_BEFORE_MS - 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(log).toEqual([`warn:${CALL_WARN_BEFORE_MS}`]);
    for (let i = 0; i < 10; i++) g.activity(); // 使用者一直說話也不延長上限
    vi.advanceTimersByTime(CALL_WARN_BEFORE_MS);
    expect(log).toEqual([`warn:${CALL_WARN_BEFORE_MS}`, "max"]);
  });

  it("setMaxMs during a call re-counts from the connection time; stop() clears every timer", () => {
    const { g, log } = guard({ busy: () => true, maxMs: 600_000 });
    g.start();
    vi.advanceTimersByTime(400_000);
    g.setMaxMs(1_800_000);
    vi.advanceTimersByTime(600_000);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(800_000 - CALL_WARN_BEFORE_MS);
    expect(log).toEqual([`warn:${CALL_WARN_BEFORE_MS}`]);
    g.stop();
    vi.advanceTimersByTime(10 * 60_000);
    expect(log).toEqual([`warn:${CALL_WARN_BEFORE_MS}`]);
    expect(g.startedAt).toBeNull();
  });
});

// ───────── RealtimeVoice（API key 路徑）─────────

class FakeChannel {
  readyState = "open";
  onmessage: ((e: { data: string }) => void) | null = null;
  send() {}
  close() { this.readyState = "closed"; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function callbacks(closed: { reason: string; code?: PageEndReason }[], warnings: number[] = []): RealtimeCallbacks {
  return {
    onPhase() {}, onUserTranscript() {}, onAssistantTranscript() {},
    onDelegate: async () => ({}), onGetTasks: async () => ({}), onWebSearch: async () => ({}), onHomeStatus: async () => ({}),
    onHomeControl: async () => ({ ok: false, error: "unused" }), onHomeConfirm: async () => ({ ok: false, error: "unused" }),
    onApprovalPrompt() {}, onApprovalResolved() {}, onToolActivity() {},
    onClosed: (reason, code) => void closed.push(code ? { reason, code } : { reason }),
    onCallWarning: (ms) => void warnings.push(ms),
  };
}

async function apiKeyCall(options: { maxCallMs?: number } = {}) {
  vi.useFakeTimers();
  const channel = new FakeChannel();
  const peer = {
    ontrack: null, onconnectionstatechange: null, connectionState: "new",
    addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
  };
  const track = { stop() {} };
  const closed: { reason: string; code?: PageEndReason }[] = [];
  const warnings: number[] = [];
  const voice = new RealtimeVoice(callbacks(closed, warnings), {
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: async () => "v=0 answer",
  }, { idleMs: IDLE, ...options });
  await voice.start();
  channel.emit({ type: "session.created" });
  const noise = () => {
    channel.emit({ type: "input_audio_buffer.speech_started" });
    channel.emit({ type: "input_audio_buffer.speech_stopped" });
  };
  const reply = () => {
    channel.emit({ type: "response.created" });
    channel.emit({ type: "response.done", response: { status: "completed", usage: { total_tokens: 100 } } });
  };
  return { voice, channel, closed, warnings, noise, reply };
}

describe("RealtimeVoice idle only resets on real user turns", () => {
  it("TV-like speech_started without any transcript does not keep the call alive", async () => {
    const t = await apiKeyCall();
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(10_000);
      t.noise();
    }
    vi.advanceTimersByTime(IDLE - 110_000);
    expect(t.voice.on).toBe(false);
    expect(t.closed).toEqual([{ reason: "一段時間沒有說話，即時語音已結束（避免持續計費）。", code: "idle" }]);
  });

  it("an empty or prompt-echo transcript and the reply it triggers do not reset; a real sentence does", async () => {
    const t = await apiKeyCall();
    vi.advanceTimersByTime(100_000);
    t.noise();
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "  " });
    t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: ZH_TW_TRANSCRIPTION_PROMPT });
    t.reply(); // 模型回應了雜音：不延長
    vi.advanceTimersByTime(20_000);
    expect(t.closed).toHaveLength(1);

    const u = await apiKeyCall();
    vi.advanceTimersByTime(100_000);
    u.noise();
    u.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "今天天氣如何" });
    vi.advanceTimersByTime(10_000);
    u.reply(); // 真的一輪之後的第一個回覆：從這裡重新倒數
    vi.advanceTimersByTime(IDLE - 1);
    expect(u.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(u.closed).toHaveLength(1);
  });

  it("tool results extend the call only when the response answered a real user turn", async () => {
    const toolTurn = async (t: Awaited<ReturnType<typeof apiKeyCall>>, real: boolean) => {
      vi.advanceTimersByTime(100_000);
      t.noise();
      if (real) t.channel.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: "我的任務進度如何" });
      t.channel.emit({ type: "response.created", response: { id: "resp_1" } });
      t.channel.emit({ type: "response.function_call_arguments.done", name: "get_tasks", call_id: "call_1", arguments: "{}", response_id: "resp_1" });
      t.channel.emit({ type: "response.done", response: { id: "resp_1", status: "completed" } });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      // 工具結果之後的接續回應
      t.channel.emit({ type: "response.created", response: { id: "resp_2" } });
      t.channel.emit({ type: "response.done", response: { id: "resp_2", status: "completed" } });
    };
    const noise = await apiKeyCall();
    await toolTurn(noise, false);
    vi.advanceTimersByTime(20_000);
    expect(noise.closed).toEqual([{ reason: "一段時間沒有說話，即時語音已結束（避免持續計費）。", code: "idle" }]);
    const real = await apiKeyCall();
    await toolTurn(real, true);
    vi.advanceTimersByTime(IDLE - 1);
    expect(real.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(real.closed).toHaveLength(1);
  });

  it("typed text counts as a turn", async () => {
    const t = await apiKeyCall();
    vi.advanceTimersByTime(100_000);
    t.voice.sendText("幫我查天氣");
    vi.advanceTimersByTime(100_000);
    expect(t.closed).toEqual([]);
  });

  it("warns 60 s before the cap and ends at the cap with max_duration even while the user keeps talking", async () => {
    const t = await apiKeyCall({ maxCallMs: 300_000 });
    expect(t.voice.callStartedAt).not.toBeNull();
    expect(t.voice.maxCallMs).toBe(300_000);
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(10_000);
      t.voice.sendText(`第 ${i} 句`);
    }
    expect(t.warnings).toEqual([CALL_WARN_BEFORE_MS]);
    expect(t.closed).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(t.closed).toEqual([{ reason: CALL_END_TEXT.max_duration, code: "max_duration" }]);
    expect(t.voice.callStartedAt).toBeNull();
  });

  it("setMaxCallMs applies to a call in progress; a user stop sends no guard code", async () => {
    const t = await apiKeyCall();
    t.voice.setMaxCallMs(300_000);
    vi.advanceTimersByTime(100_000);
    t.voice.sendText("還在");
    vi.advanceTimersByTime(100_000);
    t.voice.sendText("還在");
    vi.advanceTimersByTime(40_000);
    expect(t.warnings).toHaveLength(1);
    t.voice.stop();
    vi.advanceTimersByTime(600_000);
    expect(t.closed).toEqual([]);
  });
});

// ───────── LiveVoice（ChatGPT 方案路徑）─────────

async function liveCall(options: { maxCallMs?: number; quietPowerEnd?: boolean } = {}) {
  vi.useFakeTimers();
  const channel = new FakeChannel();
  const peer = {
    ontrack: null as ((e: { streams: unknown[] }) => void) | null, onconnectionstatechange: null as (() => void) | null, connectionState: "new",
    addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
  };
  const track = { stop() {}, readyState: "live" };
  let handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void } | null = null;
  let level: ((rms: number) => void) | null = null;
  const ends: (PageEndReason | undefined)[] = [];
  const closed: { reason: string; code?: PageEndReason }[] = [];
  const warnings: number[] = [];
  const spoken: string[] = [];
  const deps: LiveDeps = {
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: async () => "v=0 answer",
    input: async () => {},
    hostResult: async () => {},
    approval: async () => {},
    end: async (reason) => void ends.push(reason),
    subscribe: (h) => ((handlers = h), () => (handlers = null)),
    watchLevel: (_s, onLevel) => ((level = onLevel), () => (level = null)),
    setMuted: () => {},
    speak: (text) => void spoken.push(text),
    ...(options.quietPowerEnd ? { quietPowerEnd: true } : {}),
  };
  const voice = new LiveVoice(callbacks(closed, warnings), deps, { idleMs: IDLE, ...(options.maxCallMs ? { maxCallMs: options.maxCallMs } : {}) });
  await voice.start();
  peer.ontrack?.({ streams: [{}] });
  peer.connectionState = "connected";
  peer.onconnectionstatechange?.();
  channel.emit({ type: "session.started", session: {} });
  const core = (event: LiveCoreEvent) => handlers!.core(event);
  const speak = (ms: number) => {
    for (let t = 0; t <= ms; t += 50) {
      level?.(0.1);
      vi.advanceTimersByTime(50);
    }
    for (let t = 0; t <= 800; t += 50) {
      level?.(0);
      vi.advanceTimersByTime(50);
    }
  };
  return { voice, channel, core, speak, ends, closed, warnings, spoken };
}

describe("LiveVoice idle only resets on real user turns", () => {
  it("speech.started and partial transcripts do not reset; the call ends at idle and tells the core why", async () => {
    const t = await liveCall();
    for (let i = 0; i < 11; i++) {
      vi.advanceTimersByTime(10_000);
      t.channel.emit({ type: "input_audio_buffer.speech_started" });
      t.core({ kind: "transcript", role: "user", text: "電視", final: false, item_id: `i${i}` });
    }
    vi.advanceTimersByTime(IDLE - 110_000);
    expect(t.voice.on).toBe(false);
    expect(t.closed).toEqual([{ reason: "一段時間沒有說話，即時語音已結束（避免持續使用額度）。", code: "idle" }]);
    expect(t.ends).toEqual(["idle"]);
  });

  it("a reply after noise does not extend the call; a final user sentence and the reply after it do", async () => {
    const t = await liveCall();
    vi.advanceTimersByTime(100_000);
    t.speak(5_000); // 回覆（沒有真的使用者一輪）
    vi.advanceTimersByTime(IDLE - 100_000 - 5_900 - 1);
    expect(t.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.closed).toHaveLength(1);

    const u = await liveCall();
    vi.advanceTimersByTime(100_000);
    u.core({ kind: "transcript", role: "user", text: "幫我查天氣", final: true, item_id: "u1" });
    u.speak(5_000); // 說完（安靜 600 ms 之後）才重新倒數
    vi.advanceTimersByTime(IDLE - 1_000);
    expect(u.closed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(u.closed).toHaveLength(1);
  });

  it("pauses inside one long reply do not start the idle countdown mid-reply; the reply's final transcript ends it", async () => {
    const t = await liveCall();
    t.core({ kind: "transcript", role: "user", text: "講一個很長的故事", final: true, item_id: "u1" });
    for (let i = 0; i < 13; i++) t.speak(10_000); // 約 142 秒的回覆，中間有停頓
    expect(t.closed).toEqual([]);
    t.core({ kind: "transcript", role: "assistant", text: "故事講完了。", final: true, item_id: "a1" });
    vi.advanceTimersByTime(IDLE - 1);
    expect(t.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.closed).toHaveLength(1);
    // 之後雜音觸發的回覆不再延長（credit 已用掉）
    const u = await liveCall();
    u.core({ kind: "transcript", role: "user", text: "你好", final: true, item_id: "u1" });
    u.speak(2_000);
    u.core({ kind: "transcript", role: "assistant", text: "你好！", final: true, item_id: "a1" });
    vi.advanceTimersByTime(100_000);
    u.channel.emit({ type: "input_audio_buffer.speech_started" });
    u.speak(5_000);
    vi.advanceTimersByTime(20_000);
    expect(u.closed).toHaveLength(1);
  });

  it("os_lock/suspend: the Mac App window ends silently; a Pi or browser page says why", async () => {
    for (const reason of ["os_lock", "suspend"] as const) {
      const app = await liveCall({ quietPowerEnd: true });
      app.core({ kind: "closed", reason, message: CALL_END_TEXT[reason] });
      expect(app.spoken).toEqual([]);
      const pi = await liveCall();
      pi.core({ kind: "closed", reason, message: CALL_END_TEXT[reason] });
      expect(pi.spoken).toEqual([CALL_END_TEXT[reason]]);
    }
    const app = await liveCall({ quietPowerEnd: true });
    app.core({ kind: "closed", reason: "max_duration", message: CALL_END_TEXT.max_duration });
    expect(app.spoken).toEqual([CALL_END_TEXT.max_duration]);
  });

  it("the cap warns and ends with max_duration and the core gets that reason", async () => {
    const t = await liveCall({ maxCallMs: 300_000 });
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(10_000);
      t.voice.sendText(`第 ${i} 句`);
    }
    expect(t.warnings).toEqual([CALL_WARN_BEFORE_MS]);
    expect(t.closed).toEqual([{ reason: CALL_END_TEXT.max_duration, code: "max_duration" }]);
    expect(t.ends).toEqual(["max_duration"]);
  });

  it("a core closed event with a guard reason (max_duration, client_lost, os_lock) ends the page side without calling /end", async () => {
    for (const reason of ["max_duration", "client_lost", "os_lock"] as const) {
      const t = await liveCall();
      t.core({ kind: "closed", reason, message: CALL_END_TEXT[reason] });
      expect(t.voice.on).toBe(false);
      expect(t.closed).toEqual([{ reason: CALL_END_TEXT[reason] }]);
      expect(t.ends).toEqual([]);
    }
  });
});

// ───────── 頁面生命週期（App／瀏覽器與 Pi）─────────

function lifecycle(desktop: boolean, alive: (signal: AbortSignal) => Promise<AliveOutcome> = async () => "ok") {
  vi.useFakeTimers();
  const stops: { reason: PageEndReason | null; message: string; keepalive?: boolean }[] = [];
  let active = true;
  let connected = true;
  let key: string | null = "rt_a";
  let checks = 0;
  const l = new CallLifecycle({
    desktop,
    active: () => active,
    connected: () => connected,
    callKey: () => (active ? key : null),
    stop: (reason, message, keepalive) => {
      stops.push(keepalive ? { reason, message, keepalive } : { reason, message });
      active = false;
    },
    alive: (signal) => (checks++, alive(signal)),
  });
  return { l, stops, setActive: (v: boolean) => (active = v), setConnected: (v: boolean) => (connected = v), setKey: (k: string) => (key = k), checks: () => checks };
}

describe("CallLifecycle", () => {
  it("browser/Pi: hidden for more than 30 s ends the call (hidden); coming back earlier keeps it", () => {
    const t = lifecycle(false);
    t.l.visibility(true);
    vi.advanceTimersByTime(HIDDEN_END_MS - 1);
    t.l.visibility(false);
    vi.advanceTimersByTime(HIDDEN_END_MS);
    expect(t.stops).toEqual([]);
    t.l.visibility(true);
    vi.advanceTimersByTime(HIDDEN_END_MS);
    expect(t.stops).toEqual([{ reason: "hidden", message: CALL_END_TEXT.hidden }]);
  });

  it("the hidden timer belongs to one call: a call that ends cancels it, and the next call gets its own full 30 s", () => {
    const t = lifecycle(false);
    t.l.sync(false);
    t.l.visibility(true);
    vi.advanceTimersByTime(20_000);
    t.setActive(false); // 第一通結束
    t.l.sync(true);
    vi.advanceTimersByTime(5_000);
    t.setKey("rt_b");
    t.setActive(true); // 第二通在背景中開始
    t.l.sync(true);
    vi.advanceTimersByTime(HIDDEN_END_MS - 1);
    expect(t.stops).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.stops).toEqual([{ reason: "hidden", message: CALL_END_TEXT.hidden }]);
  });

  it("a call started while the page is already hidden ends 30 s after it started", () => {
    const t = lifecycle(false);
    t.setActive(false);
    t.l.visibility(true);
    t.l.sync(true);
    vi.advanceTimersByTime(60_000);
    t.setActive(true);
    t.l.sync(true);
    vi.advanceTimersByTime(HIDDEN_END_MS);
    expect(t.stops).toEqual([{ reason: "hidden", message: CALL_END_TEXT.hidden }]);
  });

  it("browser/Pi: pagehide ends at once with a keepalive end request", () => {
    const t = lifecycle(false);
    t.l.pageHide();
    expect(t.stops).toEqual([{ reason: "hidden", message: CALL_END_TEXT.hidden, keepalive: true }]);
  });

  it("App: a hidden or collapsed window keeps the call; lock and sleep end it; resume/unlock do nothing", () => {
    const t = lifecycle(true);
    t.l.visibility(true);
    t.l.sync(true);
    t.l.pageHide();
    vi.advanceTimersByTime(10 * HIDDEN_END_MS);
    t.l.power("resume");
    t.l.power("unlock");
    expect(t.stops).toEqual([]);
    t.l.power("lock");
    expect(t.stops).toEqual([{ reason: "os_lock", message: CALL_END_TEXT.os_lock }]);
    const u = lifecycle(true);
    u.l.power("suspend");
    expect(u.stops).toEqual([{ reason: "suspend", message: CALL_END_TEXT.suspend }]);
    // 瀏覽器沒有電源事件；有也不理
    const b = lifecycle(false);
    b.l.power("lock");
    expect(b.stops).toEqual([]);
  });

  it("nothing happens without a call", () => {
    const t = lifecycle(false);
    t.setActive(false);
    t.l.visibility(true);
    t.l.pageHide();
    vi.advanceTimersByTime(HIDDEN_END_MS);
    expect(t.stops).toEqual([]);
  });

  it("checks in every 15 s only while connected; a 404 (gone) ends the local side after a short grace, network errors do not", async () => {
    let outcome: AliveOutcome = "error";
    const t = lifecycle(false, async () => outcome);
    t.setConnected(false);
    t.l.startAlive();
    await vi.advanceTimersByTimeAsync(ALIVE_INTERVAL_MS);
    expect(t.checks()).toBe(0);
    t.setConnected(true);
    await vi.advanceTimersByTimeAsync(ALIVE_INTERVAL_MS);
    expect(t.checks()).toBe(1);
    expect(t.stops).toEqual([]);
    outcome = "gone";
    await vi.advanceTimersByTimeAsync(ALIVE_INTERVAL_MS);
    expect(t.stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS);
    expect(t.stops).toEqual([{ reason: null, message: CALL_END_TEXT.gone }]);
    t.l.stopAlive();
  });

  it("a 404 that arrives before the core's closed event does not override it (the call ended or was rebuilt during the grace)", async () => {
    const ended = lifecycle(false, async () => "gone");
    void ended.l.checkIn();
    await vi.advanceTimersByTimeAsync(0);
    ended.setActive(false); // closed{max_duration} 到了，頁面自己結束
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS);
    expect(ended.stops).toEqual([]);
    const rebuilt = lifecycle(false, async () => "gone");
    void rebuilt.l.checkIn();
    await vi.advanceTimersByTimeAsync(0);
    rebuilt.setKey("rt_rebuilt"); // closed{memory_revoked, rebuild} 之後開了新的一通
    await vi.advanceTimersByTimeAsync(GONE_GRACE_MS);
    expect(rebuilt.stops).toEqual([]);
  });

  it("a stalled check-in is aborted after 10 s and does not block the next one", async () => {
    const signals: AbortSignal[] = [];
    const t = lifecycle(false, (signal) => (signals.push(signal), new Promise<AliveOutcome>(() => {})));
    t.l.startAlive();
    await vi.advanceTimersByTimeAsync(ALIVE_INTERVAL_MS);
    expect(t.checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(ALIVE_TIMEOUT_MS);
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(ALIVE_INTERVAL_MS - ALIVE_TIMEOUT_MS);
    expect(t.checks()).toBe(2);
    expect(t.stops).toEqual([]);
    t.l.stopAlive();
  });
});

describe("call meter, prefs and end reasons", () => {
  it("formats the clock and the approximate tokens; the ChatGPT route says usage is unknown", () => {
    expect(formatCallClock(187_400)).toBe("3:07");
    expect(formatCallClock(3_725_000)).toBe("1:02:05");
    const zh = (s: string, ...v: unknown[]) => translate(s, "zh-TW", ...v);
    const en = (s: string, ...v: unknown[]) => translate(s, "en", ...v);
    const usage = { ...emptyVoiceUsage(), total_tokens: 3400 };
    expect(callMeterText({ route: "api_key", startedAt: 0, maxMs: 1_200_000, usage }, 187_000, zh)).toBe("3:07 / 20:00 · 約 3,400 tokens");
    expect(callMeterText({ route: "api_key", startedAt: 0, maxMs: 1_200_000, usage }, 187_000, en)).toBe("3:07 / 20:00 · ~3,400 tokens");
    expect(callMeterText({ route: "api_key", startedAt: 0, maxMs: 1_200_000, usage: null }, 5_000, zh)).toBe("0:05 / 20:00");
    expect(callMeterText({ route: "live", startedAt: 0, maxMs: 1_200_000, usage: null }, 5_000, zh)).toBe("0:05 / 20:00 · ChatGPT 方案：用量不明");
    expect(callMeterText({ route: "live", startedAt: 0, maxMs: 1_200_000, usage: null }, 5_000, en)).toBe("0:05 / 20:00 · ChatGPT plan: usage unknown");
    expect(callMeterText({ route: "live", startedAt: null, maxMs: 1_200_000, usage: null }, 5_000, zh)).toBe("");
  });

  it("the page reads the cap from settings.voice (default 20 min)", () => {
    expect(maxCallMs(undefined)).toBe(1_200_000);
    expect(maxCallMs({ voice_idle_s: 90, realtime_idle_s: 120, realtime_max_call_s: 600, search_close_s: 8 })).toBe(600_000);
  });

  it("the page may report the guard reasons; anything else is still ignored", () => {
    for (const reason of ["no_voice", "idle", "max_duration", "hidden", "os_lock", "suspend"]) expect(parsePageEndReason(reason)).toBe(reason);
    // client_lost 只有核心會記
    expect(parsePageEndReason("client_lost")).toBeNull();
    expect(parsePageEndReason("ended")).toBeNull();
    expect(parsePageEndReason("made_up")).toBeNull();
  });

  it("every new string has an English entry without Chinese characters", () => {
    const han = /\p{Script=Han}/u;
    for (const text of Object.values(CALL_END_TEXT)) expect(translate(text, "en", 20), text).not.toMatch(han);
    for (const text of ["約 {0} tokens", "ChatGPT 方案：用量不明", "tokens 是頁面加總 response.done 回報的數字（約略），不是帳單", "每通即時語音最長多久", "從連上算起；到上限前一分鐘提醒，到了就結束（通話中也算）", "一段時間沒有說話，即時語音已結束（避免持續計費）。", "一段時間沒有說話，即時語音已結束（避免持續使用額度）。"]) {
      expect(translate(text, "en", "3,400"), text).not.toMatch(han);
    }
  });
});
