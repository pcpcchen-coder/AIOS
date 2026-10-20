import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceConversation } from "../src/voice.ts";

function setup() {
  vi.useFakeTimers();
  const spoken: SpeechSynthesisUtterance[] = [];
  const states: string[] = [];
  const playback: boolean[] = [];
  const capture: boolean[] = [];
  const sentence = vi.fn();
  const recognitions: Recognition[] = [];
  class Recognition {
    onaudiostart: (() => void) | null = null;
    onaudioend: (() => void) | null = null;
    constructor() { recognitions.push(this); }
    start() {}
    stop() {}
    abort() {}
  }
  class Utterance {
    constructor(readonly text: string) {}
  }
  vi.stubGlobal("window", { SpeechRecognition: Recognition });
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), getVoices: () => [], speak: (utterance: SpeechSynthesisUtterance) => spoken.push(utterance) });
  const voice = new VoiceConversation({
    onUtterance: () => {}, onInterim: () => {}, onStateChange: (value) => states.push(value), onBargeIn: vi.fn(), onClosed: () => {},
    onCaptureChange: (v) => capture.push(v), onPlaybackChange: (v) => playback.push(v), onSentenceSpoken: sentence,
  }, { idleMs: 90_000 });
  voice.start();
  return { voice, spoken, states, playback, capture, sentence, recognitions };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("voice playback state", () => {
  it("reports speaking only when the browser starts actual playback", async () => {
    const t = setup();
    const reply = t.voice.beginReply();
    reply.push("你好。");
    reply.end();
    expect(t.voice.current).toBe("listening");
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    expect(t.voice.current).toBe("speaking");
    t.spoken[0].onend?.(new Event("end") as SpeechSynthesisEvent);
    await reply.done;
    expect(t.voice.current).toBe("listening");
    t.voice.stop();
  });

  it("leaves speaking between streamed sentences and re-enters only on the next playback", async () => {
    const t = setup();
    const reply = t.voice.beginReply();
    reply.push("第一句。");
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    t.spoken[0].onend?.(new Event("end") as SpeechSynthesisEvent);
    await Promise.resolve();
    expect(t.voice.current).toBe("listening");
    reply.push("第二句。");
    expect(t.voice.current).toBe("listening");
    t.spoken[1].onstart?.(new Event("start") as SpeechSynthesisEvent);
    expect(t.voice.current).toBe("speaking");
    reply.end();
    t.spoken[1].onend?.(new Event("end") as SpeechSynthesisEvent);
    await reply.done;
    expect(t.voice.current).toBe("listening");
    t.voice.stop();
  });

  it("ignores delayed playback start after interruption", () => {
    const t = setup();
    const reply = t.voice.beginReply();
    reply.push("你好。");
    t.voice.interrupt();
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    expect(t.voice.current).toBe("listening");
    expect(reply.cancelled).toBe(true);
    t.spoken[0].onend?.(new Event("end") as SpeechSynthesisEvent);
    t.voice.stop();
  });
});


describe("actual speech playback ownership", () => {
  it("capture and TTS can overlap, and ending one clears only its source", async () => {
    const t = setup();
    const reply = t.voice.beginReply(); reply.push("你好。"); reply.end();
    expect(t.voice.playing).toBe(false); expect(t.sentence).not.toHaveBeenCalled();
    t.recognitions[0].onaudiostart?.();
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    expect(t.voice.capturing).toBe(true); expect(t.voice.playing).toBe(true);
    expect(t.sentence).toHaveBeenCalledOnce();
    t.recognitions[0].onaudioend?.(); expect(t.voice.playing).toBe(true);
    t.spoken[0].onend?.(new Event("end") as SpeechSynthesisEvent); await reply.done;
    expect(t.voice.playing).toBe(false); expect(t.playback).toEqual([true, false]);
    t.voice.stop();
  });

  it("buffering, cancelled queued speech and absent TTS never claim playback", async () => {
    const t = setup();
    const buffered = t.voice.beginReply(); buffered.push("還沒有標點");
    expect(t.spoken).toHaveLength(0); expect(t.voice.playing).toBe(false); buffered.cancel();
    const queued = t.voice.beginReply(); queued.push("排隊。"); queued.cancel();
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    expect(t.voice.playing).toBe(false); expect(t.sentence).not.toHaveBeenCalled();
    vi.stubGlobal("speechSynthesis", undefined);
    const silent = t.voice.beginReply(); silent.push("不支援。"); silent.end(); await silent.done;
    expect(t.voice.playing).toBe(false); expect(t.playback).toEqual([]); t.voice.stop();
  });

  it("old reply cancellation and delayed events cannot end newer playback", async () => {
    const t = setup();
    const old = t.voice.beginReply(); old.push("第一句。");
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    const fresh = t.voice.beginReply(); fresh.push("第二句。");
    t.spoken[1].onstart?.(new Event("start") as SpeechSynthesisEvent);
    const cancels = vi.mocked(speechSynthesis.cancel).mock.calls.length;
    old.cancel(); t.spoken[0].onend?.(new Event("end") as SpeechSynthesisEvent);
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent); await Promise.resolve();
    expect(t.voice.playing).toBe(true); expect(t.voice.current).toBe("speaking");
    expect(speechSynthesis.cancel).toHaveBeenCalledTimes(cancels); expect(t.sentence).toHaveBeenCalledTimes(2);
    fresh.cancel(); expect(t.voice.playing).toBe(false); t.voice.stop();
  });

  it("actual playback error clears focus", async () => {
    const t = setup(); const reply = t.voice.beginReply(); reply.push("你好。"); reply.end();
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    t.spoken[0].onerror?.(new Event("error") as SpeechSynthesisErrorEvent); await reply.done;
    expect(t.voice.playing).toBe(false); expect(t.playback).toEqual([true, false]); t.voice.stop();
  });

  it("watchdog cancels actual synthesis before clearing playback", async () => {
    const t = setup(); const reply = t.voice.beginReply(); reply.push("你好。"); reply.end();
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    const observed: boolean[] = [];
    vi.mocked(speechSynthesis.cancel).mockImplementation(() => { observed.push(t.voice.playing); });
    await vi.advanceTimersByTimeAsync(2900); await reply.done;
    expect(observed).toEqual([true]); expect(t.voice.playing).toBe(false);
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent); expect(t.voice.playing).toBe(false); t.voice.stop();
  });

  it("stop clears playback synchronously and cannot leave a later idle-close callback", async () => {
    const t = setup(); const reply = t.voice.beginReply(); reply.push("你好。");
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent);
    t.voice.stop(); expect(t.voice.playing).toBe(false); expect(t.voice.current).toBe("off");
    expect(vi.getTimerCount()).toBe(0); await reply.done;
    t.spoken[0].onstart?.(new Event("start") as SpeechSynthesisEvent); expect(t.voice.playing).toBe(false);
  });
});
