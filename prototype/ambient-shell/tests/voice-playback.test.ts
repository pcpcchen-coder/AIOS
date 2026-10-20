import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceConversation } from "../src/voice.ts";

function setup() {
  const spoken: SpeechSynthesisUtterance[] = [];
  const states: string[] = [];
  class Recognition {
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
  }, { idleMs: 90_000 });
  voice.start();
  return { voice, spoken, states };
}

afterEach(() => vi.unstubAllGlobals());

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
