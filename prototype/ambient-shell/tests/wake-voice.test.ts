// SP-02a 喚醒時認聲音的頁面端與喚醒 worker 的喚醒詞片段：
// - WakeWorkerCore 只在偵測到喚醒詞的那一刻把緩衝最後 1.6 秒交給 keyword 接收端（給主執行緒的事件仍然沒有樣本）。
// - WakeVoice：喚醒詞特徵與這次喚醒配對後送 voice_probe；連線前的話在問候決策前結束、最多等 250 ms；一律歸還麥克風。
// 全部是 fixture：假的偵測器、假的 speaker worker、假的麥克風租用與 IPC。
import { describe, expect, it, vi } from "vitest";
import { KEYWORD_SPAN_S, WakeWorkerCore } from "../src/audio/worker-core.ts";
import { CALL_WINDOW_MS, FINISH_BUDGET_MS, KEYWORD_MAX_AGE_MS, WakeVoice, type WakeVoiceDeps } from "../src/speaker/wake-voice.ts";
import type { SpeakerWorkerRequest, SpeakerWorkerResponse } from "../src/speaker/protocol.ts";
import type { SpeakerWorkerLike } from "../src/speaker/recorder.ts";
import { SPEAKER_RUNTIME_ASSETS } from "../src/speaker/recorder.ts";
import { SPEAKER_MODEL_VERSION } from "../server/speaker-runtime.ts";
import type { IdentityRequest } from "../shared/identity.ts";
import type { WakeWorkerOut } from "../shared/wake.ts";
import { FakeDetector } from "./fixtures/wake.ts";

describe("WakeWorkerCore keyword span", () => {
  it("copies the last 1.6 s of the ring once, at detection, to the keyword sink; main-thread events stay sample-free", async () => {
    const out: WakeWorkerOut[] = [];
    const spans: Float32Array[] = [];
    const core = new WakeWorkerCore(new FakeDetector({ detectOnChunk: 20 }), (m) => out.push(m), (span) => spans.push(span));
    await core.init(16_000);
    for (let i = 0; i < 25; i++) core.audio(new Float32Array(1600).fill(0.1 + i / 100));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.length).toBe(Math.round(KEYWORD_SPAN_S * 16_000));
    // 最後一個樣本是偵測那一塊（第 20 塊，值 0.29）
    expect(spans[0]!.at(-1)).toBeCloseTo(0.29, 5);
    expect(out).toEqual([{ type: "started" }, { type: "detected", keyword_index: 0 }]);
  });

  it("without a sink nothing is copied", async () => {
    const out: WakeWorkerOut[] = [];
    const core = new WakeWorkerCore(new FakeDetector({ detectOnChunk: 3 }), (m) => out.push(m));
    await core.init(16_000);
    for (let i = 0; i < 5; i++) core.audio(new Float32Array(1600).fill(0.2));
    expect(out.map((m) => m.type)).toEqual(["started", "detected"]);
  });
});

class FakeWorker implements SpeakerWorkerLike {
  posted: { message: SpeakerWorkerRequest; transfer?: Transferable[] }[] = [];
  onmessage: ((event: MessageEvent<SpeakerWorkerResponse>) => void) | null = null;
  terminated = false;
  postMessage(message: SpeakerWorkerRequest, transfer?: Transferable[]): void {
    this.posted.push({ message, ...(transfer ? { transfer } : {}) });
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(msg: SpeakerWorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<SpeakerWorkerResponse>);
  }
  types(): string[] {
    return this.posted.map((p) => p.message.type);
  }
}

const FEATURE = Array.from({ length: 192 }, (_, i) => (i === 0 ? 1 : 0));
const WAKE = "int_00000000000000aa";
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(options: { finishNever?: boolean } = {}) {
  const worker = new FakeWorker();
  const clock = { now: 10_000 };
  const sent: IdentityRequest[] = [];
  const stream = { id: "leased" } as unknown as MediaStream;
  const released: MediaStream[] = [];
  const taps = { started: 0, stopped: 0 };
  let resolveWait: (() => void) | null = null;
  const deps: WakeVoiceDeps = {
    createWorker: () => worker,
    assets: SPEAKER_RUNTIME_ASSETS,
    model: SPEAKER_MODEL_VERSION,
    send: async (r) => void sent.push(r),
    lease: vi.fn(async () => stream),
    release: (s) => void released.push(s),
    tap: async () => {
      taps.started++;
      return { stop: () => void taps.stopped++ };
    },
    now: () => clock.now,
    wait: (ms) => {
      expect(ms).toBe(FINISH_BUDGET_MS);
      return new Promise<void>((r) => (resolveWait = r));
    },
  };
  const v = new WakeVoice(deps);
  v.start();
  worker.emit({ type: "ready", model: SPEAKER_MODEL_VERSION, load_ms: 5 });
  return { v, worker, clock, sent, released, taps, deps, stream, timeout: () => resolveWait?.(), ...options };
}

describe("WakeVoice", () => {
  it("hands the wake worker a fresh keyword port each time", () => {
    const { v, worker } = setup();
    const a = v.keywordPort();
    const b = v.keywordPort();
    expect(a).toBeInstanceOf(MessagePort);
    expect(a).not.toBe(b);
    expect(worker.types()).toEqual(["init", "keyword_port", "keyword_port"]);
    a?.close();
    b?.close();
  });

  it("pairs the keyword feature with this wake (either order) and sends it once, without the page knowing the result", async () => {
    const s = setup();
    s.worker.emit({ type: "keyword", feature: FEATURE, problem: null, voiced_ms: 640, ms: 40 });
    await s.v.attach(WAKE);
    await flush();
    expect(s.sent).toEqual([{ op: "voice_probe", wake_id: WAKE, segment: "keyword", voiced_ms: 640, model: SPEAKER_MODEL_VERSION, feature: FEATURE }]);
    // 晚到的另一段喚醒詞不會再送給同一次喚醒
    s.worker.emit({ type: "keyword", feature: FEATURE, problem: null, voiced_ms: 500, ms: 40 });
    await flush();
    expect(s.sent).toHaveLength(1);
    s.v.cancel();
  });

  it("a keyword that arrives after attach is still sent; a stale one is dropped; a too-short one is sent without a feature", async () => {
    const s = setup();
    await s.v.attach(WAKE);
    s.worker.emit({ type: "keyword", feature: null, problem: "too_short", voiced_ms: 120, ms: 3 });
    await flush();
    expect(s.sent).toEqual([{ op: "voice_probe", wake_id: WAKE, segment: "keyword", voiced_ms: 120, model: SPEAKER_MODEL_VERSION }]);
    s.v.cancel();
    const t = setup();
    t.worker.emit({ type: "keyword", feature: FEATURE, problem: null, voiced_ms: 640, ms: 40 });
    t.clock.now += KEYWORD_MAX_AGE_MS + 1;
    await t.v.attach(WAKE);
    await flush();
    expect(t.sent).toEqual([]);
    t.v.cancel();
  });

  it("collects the pre-connect speech on a leased mic, finishes it before the greeting decision and returns the mic", async () => {
    const s = setup();
    await s.v.attach(WAKE);
    expect(s.taps.started).toBe(1);
    const begin = s.worker.posted.find((p) => p.message.type === "begin")!.message as { id: number };
    const done = s.v.finish(WAKE);
    await flush();
    const end = s.worker.posted.find((p) => p.message.type === "end")!.message;
    expect(end).toEqual({ type: "end", id: begin.id, min_voiced_ms: 1500 });
    s.worker.emit({ type: "segment", id: begin.id, feature: FEATURE, problem: null, voiced_ms: 2100, ms: 60 });
    await done;
    expect(s.sent).toEqual([{ op: "voice_probe", wake_id: WAKE, segment: "utterance", voiced_ms: 2100, model: SPEAKER_MODEL_VERSION, feature: FEATURE }]);
    expect(s.taps.stopped).toBe(1);
    expect(s.released).toEqual([s.stream]);
    // 第二次 finish 或 cancel 不會重複歸還
    await s.v.finish(WAKE);
    s.v.cancel();
    expect(s.released).toHaveLength(1);
  });

  it("does not wait past the budget: no utterance probe, mic still returned", async () => {
    const s = setup();
    await s.v.attach(WAKE);
    const done = s.v.finish(WAKE);
    await flush();
    s.timeout();
    await done;
    expect(s.sent).toEqual([]);
    expect(s.released).toEqual([s.stream]);
  });

  it("cancel (refused / failed / call ended) returns the mic; a lease that resolves after cancel is returned at once", async () => {
    const s = setup();
    await s.v.attach(WAKE);
    s.v.cancel();
    expect(s.released).toEqual([s.stream]);
    expect(s.taps.stopped).toBe(1);
    let resolveLease: (m: MediaStream) => void = () => {};
    const t = setup();
    t.deps.lease = () => new Promise<MediaStream>((r) => (resolveLease = r));
    const attaching = t.v.attach(WAKE);
    t.v.cancel();
    resolveLease(t.stream);
    await attaching;
    expect(t.released).toEqual([t.stream]);
    expect(t.taps.started).toBe(0);
  });

  it("before the model is ready, or after a load error, nothing is leased or sent", async () => {
    const worker = new FakeWorker();
    const lease = vi.fn(async () => ({}) as MediaStream);
    const v = new WakeVoice({ createWorker: () => worker, assets: SPEAKER_RUNTIME_ASSETS, model: SPEAKER_MODEL_VERSION, send: async () => {}, lease, release: () => {}, tap: async () => ({ stop() {} }), now: () => 0 });
    v.start();
    await v.attach(WAKE);
    expect(lease).not.toHaveBeenCalled();
    worker.emit({ type: "error", message: "load failed" });
    expect(worker.terminated).toBe(true);
    expect(v.keywordPort()).toBeNull();
  });
});

describe("WakeVoice in-call windows (SP-02b 通話中辨認說話者)", () => {
  function callSetup() {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const s = setup();
    s.deps.setTimer = (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    };
    s.deps.clearTimer = (h) => void ((h as { cleared: boolean }).cleared = true);
    const fire = async () => {
      const t = timers.filter((x) => !x.cleared).at(-1)!;
      t.cleared = true;
      t.fn();
      await flush();
    };
    const begins = () => s.worker.posted.filter((p) => p.message.type === "begin").map((p) => (p.message as { id: number }).id);
    const ends = () => s.worker.posted.filter((p) => p.message.type === "end").map((p) => p.message as { id: number; min_voiced_ms: number });
    return { ...s, timers, fire, begins, ends };
  }

  it("cuts 6 s windows; a window with ≥2 s of voice becomes one call_voice; the next window starts right away", async () => {
    const s = callSetup();
    await s.v.startCall();
    expect(s.taps.started).toBe(1);
    expect(s.timers[0]!.ms).toBe(CALL_WINDOW_MS);
    const first = s.begins()[0]!;
    await s.fire();
    expect(s.ends()).toEqual([{ type: "end", id: first, min_voiced_ms: 2000 }]);
    expect(s.begins()).toHaveLength(2);
    s.worker.emit({ type: "segment", id: first, feature: FEATURE, problem: null, voiced_ms: 3100, ms: 50 });
    await flush();
    expect(s.sent).toEqual([{ op: "call_voice", voiced_ms: 3100, model: SPEAKER_MODEL_VERSION, feature: FEATURE }]);
    // 人聲不足：不送
    const second = s.begins()[1]!;
    await s.fire();
    s.worker.emit({ type: "segment", id: second, feature: null, problem: "too_short", voiced_ms: 900, ms: 3 });
    await flush();
    expect(s.sent).toHaveLength(1);
    s.v.stopCall();
    expect(s.released).toEqual([s.stream]);
  });

  it("a window during which Nous spoke is thrown away without computing a feature", async () => {
    const s = callSetup();
    await s.v.startCall();
    s.v.setSpeaking(true);
    s.v.setSpeaking(false);
    await s.fire();
    expect(s.ends()).toEqual([]);
    expect(s.begins()).toHaveLength(2);
    // 下一段沒有說話：照常
    await s.fire();
    expect(s.ends()).toHaveLength(1);
    s.v.stopCall();
  });

  it("stopCall clears the timer, returns the mic, and drops a late result; startCall twice is one tap; not before the model is ready", async () => {
    const s = callSetup();
    await s.v.startCall();
    await s.v.startCall();
    expect(s.taps.started).toBe(1);
    const first = s.begins()[0]!;
    await s.fire();
    s.v.stopCall();
    expect(s.timers.every((t) => t.cleared)).toBe(true);
    expect(s.taps.stopped).toBe(1);
    expect(s.released).toEqual([s.stream]);
    s.worker.emit({ type: "segment", id: first, feature: FEATURE, problem: null, voiced_ms: 3000, ms: 50 });
    await flush();
    expect(s.sent).toEqual([]);
    const worker = new FakeWorker();
    const lease = vi.fn(async () => ({}) as MediaStream);
    const v = new WakeVoice({ createWorker: () => worker, assets: SPEAKER_RUNTIME_ASSETS, model: SPEAKER_MODEL_VERSION, send: async () => {}, lease, release: () => {}, tap: async () => ({ stop() {} }), now: () => 0 });
    v.start();
    await v.startCall();
    expect(lease).not.toHaveBeenCalled();
  });
});
