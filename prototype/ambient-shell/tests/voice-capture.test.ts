import { afterEach, describe, expect, it, vi } from "vitest";
import { PushToTalk, VoiceConversation } from "../src/voice.ts";

class Recognition {
  static instances: Recognition[] = [];
  static failStart = false;
  onaudiostart: (() => void) | null = null;
  onaudioend: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
  constructor() { Recognition.instances.push(this); }
  start() { if (Recognition.failStart) throw new Error("fixture startup failure"); }
  stop() {}
  abort() {}
}

function setup() {
  Recognition.instances = []; Recognition.failStart = false;
  vi.useFakeTimers();
  vi.stubGlobal("window", { SpeechRecognition: Recognition });
  vi.stubGlobal("speechSynthesis", { cancel: vi.fn() });
  const capture: boolean[] = [];
  const final = vi.fn();
  const errors = vi.fn();
  const push = new PushToTalk({ onCaptureChange: (v) => capture.push(v), onInterim() {}, onFinal: final, onListeningChange() {}, onError: errors });
  const continuous = new VoiceConversation({ onCaptureChange: (v) => capture.push(v), onUtterance: final, onInterim() {}, onStateChange() {}, onBargeIn() {}, onClosed: errors }, { idleMs: 90_000 });
  return { push, continuous, capture, final, errors };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("actual recognition audio capture", () => {
  it("push-to-talk intent and results do not claim capture before audio events", () => {
    const t = setup(); t.push.start();
    const r = Recognition.instances[0];
    expect(t.push.active).toBe(true); expect(t.push.capturing).toBe(false);
    r.onaudiostart?.(); r.onaudiostart?.(); expect(t.capture).toEqual([true]);
    r.onaudioend?.(); expect(t.push.capturing).toBe(false);
    r.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "照片" } }] });
    r.onend?.(); expect(t.final).toHaveBeenCalledWith("照片"); expect(t.capture).toEqual([true, false]);
  });

  it.each(["stop", "abort", "error", "end"])("push-to-talk %s clears capture and old callbacks cannot clear a new instance", (exit) => {
    const t = setup(); t.push.start(); const old = Recognition.instances[0]; old.onaudiostart?.();
    if (exit === "error") old.onerror?.({ error: "network" });
    else if (exit === "end") old.onend?.();
    else t.push[exit as "stop" | "abort"]();
    expect(t.push.capturing).toBe(false);
    old.onaudiostart?.(); expect(t.push.capturing).toBe(false);
    old.onend?.(); t.push.start(); const fresh = Recognition.instances[1]; fresh.onaudiostart?.();
    old.onaudioend?.(); old.onerror?.({ error: "network" }); old.onend?.();
    expect(t.push.capturing).toBe(true); expect(t.push.active).toBe(true);
    t.push.abort();
  });

  it("push-to-talk start throws leave no capture or live instance", () => {
    const t = setup(); Recognition.failStart = true; t.push.start();
    Recognition.instances[0].onaudiostart?.();
    expect(t.push.capturing).toBe(false); expect(t.push.active).toBe(false); expect(t.errors).toHaveBeenCalledOnce();
  });

  it("continuous restart gaps stay dark and stale audio/error/end callbacks are ignored", () => {
    const t = setup(); t.continuous.start(); const old = Recognition.instances[0];
    expect(t.continuous.capturing).toBe(false); old.onaudiostart?.(); expect(t.continuous.capturing).toBe(true);
    old.onaudioend?.(); expect(t.continuous.capturing).toBe(false);
    old.onend?.(); vi.advanceTimersByTime(150); const fresh = Recognition.instances[1];
    expect(t.continuous.capturing).toBe(false); fresh.onaudiostart?.();
    old.onaudioend?.(); old.onerror?.({ error: "not-allowed" }); old.onend?.();
    expect(t.continuous.capturing).toBe(true); expect(t.continuous.on).toBe(true);
    t.continuous.stop(); fresh.onaudiostart?.();
    expect(t.continuous.capturing).toBe(false); expect(t.capture).toEqual([true, false, true, false]);
  });

  it("continuous errors clear capture immediately, fatal end closes, and start throws stay dark", () => {
    const t = setup(); t.continuous.start(); const r = Recognition.instances[0]; r.onaudiostart?.();
    r.onerror?.({ error: "not-allowed" }); expect(t.continuous.capturing).toBe(false);
    r.onaudiostart?.(); expect(t.continuous.capturing).toBe(false); r.onend?.(); expect(t.continuous.on).toBe(false);
    Recognition.failStart = true; t.continuous.start(); Recognition.instances[1].onaudiostart?.();
    expect(t.continuous.on).toBe(false); expect(t.continuous.capturing).toBe(false); expect(t.errors).toHaveBeenCalledTimes(2);
  });
});
