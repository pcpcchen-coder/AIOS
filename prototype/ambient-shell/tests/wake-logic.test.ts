import { describe, expect, it, vi } from "vitest";
import { SherpaWasmDetector, WakeDetectorError } from "../src/audio/detector.ts";
import { DEDUPE_MS, SPEECH_TAIL_MS, WakeGuard } from "../src/audio/guard.ts";
import { NO_VOICE_TIMEOUT_MS, NoVoiceWatchdog } from "../src/audio/no-voice.ts";
import { StreamResampler } from "../src/audio/resample.ts";
import { AudioRing } from "../src/audio/ring.ts";
import { WakeWorkerCore } from "../src/audio/worker-core.ts";
import { isWakeReport, isWakeWorkerOut, parseWakePatch, WAKE_REASONS, WAKE_STATE_REASONS, WAKE_STATES, WakePatchError, type WakeWorkerOut } from "../shared/wake.ts";
import { FakeClock, FakeDetector, flush } from "./fixtures/wake.ts";

// WK-01a 純邏輯：環形緩衝、取樣率轉換、自我觸發防護、無人聲計時（假時鐘，沒有牆鐘斷言）與 worker 協定。

describe("AudioRing (ported from the WK-00 spike)", () => {
  it("keeps the last 2 s at 16 kHz in order and overwrites the oldest", () => {
    const ring = new AudioRing(1, 4);
    ring.push(Float32Array.from([1, 2, 3]));
    ring.push(Float32Array.from([4, 5, 6]));
    expect([...ring.latest()]).toEqual([3, 4, 5, 6]);
    expect(new AudioRing().capacity).toBe(32_000);
  });

  it("cannot be serialized and clear() zero-fills", () => {
    const ring = new AudioRing(1, 4);
    ring.push(Float32Array.from([1, 2]));
    expect(() => JSON.stringify({ ring })).toThrow(/must not be serialized/);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.isZeroed()).toBe(true);
  });
});

describe("StreamResampler", () => {
  it("turns 48 kHz into 16 kHz with no gaps between chunks", () => {
    const r = new StreamResampler(48_000);
    let total = 0;
    for (let i = 0; i < 10; i++) total += r.push(new Float32Array(4800).fill(0.5)).length;
    expect(Math.abs(total - 16_000)).toBeLessThanOrEqual(1);
    // 直流成分經過低通後維持（最後一塊已經穩定）
    const out = r.push(new Float32Array(4800).fill(0.5));
    expect(out[out.length - 1]).toBeCloseTo(0.5, 3);
  });

  it("passes 16 kHz through as a copy", () => {
    const r = new StreamResampler(16_000);
    const input = Float32Array.from([0.1, 0.2]);
    const out = r.push(input);
    expect([...out].map((v) => Number(v.toFixed(3)))).toEqual([0.1, 0.2]);
    expect(out).not.toBe(input);
  });
});

describe("WakeGuard (fake clock)", () => {
  it("drops during speech and for 1.5 s after it, during playback and the earcon, and de-duplicates for 3 s", () => {
    const clock = new FakeClock();
    const g = new WakeGuard(clock.now);
    expect(SPEECH_TAIL_MS).toBe(1500);
    expect(DEDUPE_MS).toBe(3000);
    g.begin("speech");
    g.begin("speech");
    g.end("speech");
    expect(g.check()).toBe("speaking");
    g.end("speech");
    clock.advance(1499);
    expect(g.check()).toBe("speech_tail");
    clock.advance(1);
    g.begin("playback");
    expect(g.check()).toBe("playback");
    g.end("playback");
    g.begin("earcon");
    expect(g.check()).toBe("earcon");
    g.end("earcon");
    expect(g.check()).toBeNull();
    clock.advance(2999);
    expect(g.check()).toBe("duplicate");
    clock.advance(1);
    expect(g.check()).toBeNull();
  });

  it("extra end() calls never go negative, and drops do not extend the de-duplication window", () => {
    const clock = new FakeClock();
    const g = new WakeGuard(clock.now);
    g.end("playback");
    g.end("speech");
    expect(g.check()).toBeNull();
    clock.advance(2000);
    expect(g.check()).toBe("duplicate");
    clock.advance(1000);
    expect(g.check()).toBeNull();
  });
});

describe("NoVoiceWatchdog (energy threshold, not a VAD; fake clock)", () => {
  it("times out once after N = 5 s without sustained level", () => {
    const clock = new FakeClock();
    const onTimeout = vi.fn();
    const w = new NoVoiceWatchdog({ now: clock.now, onTimeout });
    expect(NO_VOICE_TIMEOUT_MS).toBe(5000);
    w.start();
    for (let i = 0; i < 99; i++) {
      clock.advance(50);
      w.feed(0.001);
    }
    expect(onTimeout).not.toHaveBeenCalled();
    clock.advance(50);
    w.feed(0.001);
    w.check();
    clock.advance(1000);
    w.check();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("sustained level above the threshold stops the countdown; a single spike does not", () => {
    const clock = new FakeClock();
    const onTimeout = vi.fn();
    const w = new NoVoiceWatchdog({ now: clock.now, onTimeout, rms: 0.03, onMs: 300 });
    w.start();
    w.feed(0.5);
    clock.advance(50);
    w.feed(0.001); // 單一聲響
    for (let i = 0; i < 7; i++) {
      clock.advance(50);
      w.feed(0.1);
    }
    expect(w.running).toBe(false);
    clock.advance(10_000);
    w.check();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe("wake worker protocol: only events leave the worker", () => {
  it("isWakeWorkerOut accepts the three event shapes and rejects samples, buffers and extra fields", () => {
    expect(isWakeWorkerOut({ type: "started" })).toBe(true);
    expect(isWakeWorkerOut({ type: "detected", keyword_index: 0 })).toBe(true);
    expect(isWakeWorkerOut({ type: "load_error", reason: "runtime_missing" })).toBe(true);
    expect(isWakeWorkerOut({ type: "closed" })).toBe(true);
    expect(isWakeWorkerOut({ type: "closed", ring: [0] })).toBe(false);
    for (const bad of [
      new Float32Array(4),
      new ArrayBuffer(8),
      [0.1, 0.2],
      { type: "started", samples: new Float32Array(1) },
      { type: "detected", keyword_index: 0, pcm: [1] },
      { type: "detected", keyword_index: 0.5 },
      { type: "detected", keyword_index: new Int16Array(1) },
      { type: "load_error", reason: "other" },
      { type: "audio", data: new Float32Array(1) },
      null,
      "started",
    ]) expect(isWakeWorkerOut(bad), String(bad)).toBe(false);
  });

  async function run(detector: FakeDetector, chunks: number, sampleRate = 48_000) {
    const out: WakeWorkerOut[] = [];
    const core = new WakeWorkerCore(detector, (m) => out.push(m));
    await core.init(sampleRate);
    const sent: Float32Array[] = [];
    for (let i = 0; i < chunks; i++) {
      const chunk = new Float32Array(sampleRate / 10).fill(0.25);
      sent.push(chunk);
      core.audio(chunk);
    }
    return { out, core, sent };
  }

  const hasTyped = (value: unknown): boolean =>
    ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof value === "object" && value !== null && Object.values(value).some(hasTyped));

  it("posts started after the first processed chunk, then detected; nothing posted carries typed arrays", async () => {
    const detector = new FakeDetector({ detectOnChunk: 3, keyword: 1 });
    const { out, sent } = await run(detector, 5);
    expect(out).toEqual([{ type: "started" }, { type: "detected", keyword_index: 1 }]);
    expect(out.some(hasTyped)).toBe(false);
    expect(detector.samples).toBe(5 * 1600); // 16 kHz、每塊 100 ms，串流轉換不掉樣本
    expect(detector.resets).toBe(1);
    // worker 用過的樣本塊以 0 覆寫
    expect(sent.every((c) => c.every((v) => v === 0))).toBe(true);
  });

  it("a detector that cannot load posts load_error (runtime_missing) and never started", async () => {
    const detector = new FakeDetector({ failLoad: "runtime_missing" });
    const { out } = await run(detector, 3);
    expect(out).toEqual([{ type: "load_error", reason: "runtime_missing" }]);
    expect(detector.chunks).toBe(0);
    expect(detector.disposed).toBe(true);
    const other = await run(new FakeDetector({ failLoad: "throw" }), 1);
    expect(other.out).toEqual([{ type: "load_error", reason: "runtime_load_failed" }]);
  });

  it("clear() zero-fills the ring and close() drops later audio", async () => {
    const detector = new FakeDetector();
    const { core } = await run(detector, 4);
    expect(core.ringCleared).toBe(false);
    core.clear();
    expect(core.ringCleared).toBe(true);
    core.close();
    core.audio(new Float32Array(4800).fill(1));
    expect(core.ringCleared).toBe(true);
    expect(detector.chunks).toBe(4);
  });

  it("the product detector (SherpaWasmDetector) honestly reports runtime_missing in WK-01a and never detects", async () => {
    await expect(new SherpaWasmDetector({ prefix: "/wake-runtime/", files: [] }).load()).rejects.toMatchObject({ reason: "runtime_missing" });
    await expect(new SherpaWasmDetector({ prefix: "/wake-runtime/", files: ["x.wasm"] }).load()).rejects.toBeInstanceOf(WakeDetectorError);
    expect(new SherpaWasmDetector({ prefix: "/wake-runtime/", files: [] }).accept()).toBeNull();
    await flush();
  });
});

describe("shared/wake.ts boundaries", () => {
  it("reports are enum pairs from the allowlist only", () => {
    for (const state of WAKE_STATES) for (const reason of WAKE_STATE_REASONS[state]) expect(isWakeReport({ state, reason })).toBe(true);
    expect(isWakeReport({ state: "listening_local", reason: "sleep" })).toBe(false);
    expect(isWakeReport({ state: "listening", reason: null })).toBe(false);
    expect(isWakeReport({ state: "error", reason: "mic-a" })).toBe(false);
    expect(new Set(Object.values(WAKE_STATE_REASONS).flat().filter((r) => r !== null))).toEqual(new Set(WAKE_REASONS));
  });

  it("parseWakePatch accepts only wake_listen and device_id", () => {
    expect(parseWakePatch({ wake_listen: true })).toEqual({ wake_listen: true });
    expect(parseWakePatch({ device_id: "abc123", wake_listen: false })).toEqual({ device_id: "abc123", wake_listen: false });
    expect(parseWakePatch({ device_id: null })).toEqual({ device_id: null });
    for (const bad of [{}, null, [], { wake_listen: "true" }, { device_id: "" }, { device_id: "a b" }, { device_id: "x".repeat(257) }, { speaker: true }, "on"]) {
      expect(() => parseWakePatch(bad), JSON.stringify(bad)).toThrow(WakePatchError);
    }
  });
});
