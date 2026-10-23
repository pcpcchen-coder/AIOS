import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_PREFS, idleTimeoutsMs } from "../shared/voice-prefs.ts";
import { RealtimeVoice, type RealtimeDeps } from "../src/realtime.ts";
import { VoiceConversation } from "../src/voice.ts";

// 閒置秒數改了（voice.json → settings.updated → setIdleMs）：只有值真的改變而且正開著時，才從現在重新倒數。

class Recognition {
  onaudiostart: (() => void) | null = null;
  onaudioend: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  start() {}
  stop() {}
  abort() {}
}

function voiceMode() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { SpeechRecognition: Recognition });
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn() });
  const closed: string[] = [];
  const conversation = new VoiceConversation(
    { onUtterance() {}, onInterim() {}, onStateChange() {}, onBargeIn() {}, onClosed: (r) => closed.push(r) },
    { idleMs: 90_000 },
  );
  return { conversation, closed };
}

class FakeChannel {
  readyState = "open";
  onmessage: ((e: { data: string }) => void) | null = null;
  send() {}
  close() { this.readyState = "closed"; }
  emit(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function realtimeVoice() {
  vi.useFakeTimers();
  const channel = new FakeChannel();
  const peer = {
    ontrack: null, onconnectionstatechange: null, connectionState: "new",
    addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ type: "offer", sdp: "v=0 offer" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
  };
  const track = { stop() {} };
  const deps: RealtimeDeps = {
    getMicrophone: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream,
    createPeer: () => peer as unknown as RTCPeerConnection,
    playRemote: () => () => {},
    exchange: async () => "v=0 answer",
  };
  const closed: string[] = [];
  const voice = new RealtimeVoice(
    {
      onPhase() {}, onUserTranscript() {}, onAssistantTranscript() {},
      onDelegate: async () => ({}), onGetTasks: async () => ({}), onWebSearch: async () => ({}), onHomeStatus: async () => ({}),
      onHomeControl: async () => ({ ok: false, error: "unused" }), onHomeConfirm: async () => ({ ok: false, error: "unused" }),
      onApprovalPrompt() {}, onApprovalResolved() {}, onToolActivity() {}, onClosed: (r) => closed.push(r),
    },
    deps,
    { idleMs: 120_000 },
  );
  return { voice, channel, closed };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("voice mode idle setting", () => {
  it("the same value (an unrelated settings frame) does not extend the countdown", () => {
    const t = voiceMode();
    t.conversation.start();
    vi.advanceTimersByTime(80_000);
    t.conversation.setIdleMs(90_000);
    vi.advanceTimersByTime(10_000);
    expect(t.closed).toEqual(["一段時間沒有聽到指令，語音模式已關閉。"]);
  });

  it("a changed value restarts the countdown from now with the new length", () => {
    const t = voiceMode();
    t.conversation.start();
    vi.advanceTimersByTime(50_000);
    t.conversation.setIdleMs(60_000);
    vi.advanceTimersByTime(59_000);
    expect(t.closed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(t.closed).toHaveLength(1);
  });

  it("a stopped session is untouched (no spurious close) and the next start uses the new value", () => {
    const t = voiceMode();
    t.conversation.setIdleMs(30_000);
    vi.advanceTimersByTime(600_000);
    expect(t.closed).toEqual([]);
    expect(t.conversation.on).toBe(false);
    t.conversation.start();
    vi.advanceTimersByTime(29_000);
    expect(t.closed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(t.closed).toHaveLength(1);
  });
});

describe("realtime idle setting", () => {
  it("the same value does not extend the countdown", async () => {
    const t = realtimeVoice();
    await t.voice.start();
    t.channel.emit({ type: "session.created" });
    vi.advanceTimersByTime(100_000);
    t.voice.setIdleMs(120_000);
    vi.advanceTimersByTime(20_000);
    expect(t.closed).toEqual(["一段時間沒有說話，即時語音已結束（避免持續計費）。"]);
  });

  it("a changed value restarts the countdown from now; a reply in progress still does not count", async () => {
    const t = realtimeVoice();
    await t.voice.start();
    t.channel.emit({ type: "session.created" });
    vi.advanceTimersByTime(30_000);
    t.voice.setIdleMs(300_000);
    vi.advanceTimersByTime(299_000);
    expect(t.closed).toEqual([]);
    t.channel.emit({ type: "response.created" });
    vi.advanceTimersByTime(1_000);
    expect(t.closed).toEqual([]); // 回覆中不算閒置，重新倒數
    t.channel.emit({ type: "response.done", response: { status: "completed" } });
    vi.advanceTimersByTime(300_000);
    expect(t.closed).toHaveLength(1);
  });

  it("a session that is off is untouched; the next connection uses the new value", async () => {
    const t = realtimeVoice();
    t.voice.setIdleMs(60_000);
    vi.advanceTimersByTime(600_000);
    expect(t.closed).toEqual([]);
    await t.voice.start();
    t.channel.emit({ type: "session.created" });
    vi.advanceTimersByTime(59_000);
    expect(t.closed).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(t.closed).toHaveLength(1);
  });
});

describe("the page hands settings.voice to the idle timers in milliseconds", () => {
  it("idleTimeoutsMs converts seconds to ms and falls back to the defaults", () => {
    expect(idleTimeoutsMs({ voice_idle_s: 60, realtime_idle_s: 300 })).toEqual({ voice_mode: 60_000, realtime: 300_000 });
    expect(idleTimeoutsMs(undefined)).toEqual({
      voice_mode: DEFAULT_VOICE_PREFS.voice_idle_s * 1000,
      realtime: DEFAULT_VOICE_PREFS.realtime_idle_s * 1000,
    });
  });

  it("applySettings passes value.voice through idleTimeoutsMs to both timers, and the constructors start from it", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const apply = main.slice(main.indexOf("function applySettings("), main.indexOf("function chatGPTAvailable("));
    expect(apply).toContain("const idle = idleTimeoutsMs(value.voice);");
    expect(apply).toContain("conversation.setIdleMs(idle.voice_mode);");
    expect(apply).toContain("realtime.setIdleMs(idle.realtime);");
    expect(apply).not.toMatch(/setIdleMs\([^)]*_s\b/); // 秒數不直接交給計時器
    expect(main).toContain("{ idleMs: idleTimeoutsMs(undefined).voice_mode }");
    // 即時語音的建構子另外帶看著說話的招呼（greeting，George 2026-10-23）。
    expect(main).toContain("{ idleMs: idleTimeoutsMs(undefined).realtime, greeting }");
  });
});
