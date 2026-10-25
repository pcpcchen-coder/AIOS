// 家人辨識的頁面端（docs/14 ID-01）：Surface 的出現理由與收起、看著說話的抑制、登記取樣規則、取樣器（假 worker、假計時器）
// 與畫格品質。都是 fixture 測試：沒有鏡頭、沒有模型，不證明辨識效果。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { evaluateSurface } from "../src/presentation-policy.ts";
import { blocksAutoTalk, initialShell, reduceShell, type ShellEvent } from "../src/shell-state.ts";
import { ENROLL_MIN_INTERVAL_MS, ENROLL_PROMPTS, ENROLL_TARGET, EnrollmentCollector } from "../src/family-enroll.ts";
import { IdentityClient, type ClientFrame, type ClientState, type WorkerLike } from "../src/sense/identity-client.ts";
import type { WorkerRequest, WorkerResponse } from "../src/sense/identity-protocol.ts";
import { assessQuality, meanLuma, QUALITY_DEFAULTS } from "../src/sense/face/quality.ts";
import type { YuNetFace } from "../src/sense/face/yunet.ts";
import { ENROLL_MAX_SAMPLES, ENROLL_MIN_SAMPLES } from "../shared/identity.ts";
import { unitFeature } from "./fixtures/identity.ts";

describe("family Surface", () => {
  const open: ShellEvent = { type: "show.family", request_id: "req_family01" };

  it("opens as a user_request surface and the policy allows it only for a real user request", () => {
    const s = reduceShell(initialShell, open);
    expect(s.surface).toMatchObject({ kind: "family", visibility_reason: "user_request", request_id: "req_family01" });
    const ctx = (ids: string[]) => ({ userRequestIds: new Set(ids), tasks: new Map() });
    expect(evaluateSurface(s.surface, ctx(["req_family01"])).allowed).toBe(true);
    expect(evaluateSurface(s.surface, ctx([]))).toMatchObject({ allowed: false });
    expect(evaluateSurface({ ...s.surface!, visibility_reason: "sensor_status" }, ctx(["req_family01"]))).toMatchObject({ allowed: false });
  });

  it("「收起」 only closes the view", () => {
    expect(reduceShell(reduceShell(initialShell, open), { type: "dismiss" })).toEqual(initialShell);
  });

  it("while it is open look-to-talk cannot start a conversation (startRealtime would dismiss it)", () => {
    expect(blocksAutoTalk(reduceShell(initialShell, open).surface)).toBe(true);
    expect(blocksAutoTalk(null)).toBe(false);
    expect(blocksAutoTalk(reduceShell(initialShell, { type: "show.progress", request_id: "req_x" }).surface)).toBe(false);
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/canAutoTalk: \(\) => !blocksAutoTalk\(shell\.surface\) &&/);
    // 只由選單列指令打開；離開時 close()（丟樣本與 session），進入時 open()
    expect(main).toMatch(/family: \(\) => dispatch\(\{ type: "show\.family", request_id: userRequest\(\) \}\)/);
    expect(main).toMatch(/if \(leftFamily\) familyView\.close\(\);/);
    expect([...main.matchAll(/type: "show\.family"/g)]).toHaveLength(1);
  });
});

describe("EnrollmentCollector", () => {
  const f = (t: number, extra: Partial<{ face_count: number; quality: string; feature: Float32Array }> = {}) => ({
    t,
    face_count: 1,
    quality: "ok" as const,
    feature: unitFeature(t),
    ...extra,
  }) as Parameters<EnrollmentCollector["push"]>[0];

  it("takes ENROLL_TARGET samples at least 300 ms apart, cycling the five pose prompts", () => {
    expect(ENROLL_TARGET).toBeGreaterThanOrEqual(ENROLL_MIN_SAMPLES);
    expect(ENROLL_TARGET).toBeLessThanOrEqual(ENROLL_MAX_SAMPLES);
    const c = new EnrollmentCollector();
    const prompts = new Set<string>([c.prompt]);
    let t = 0;
    let last;
    for (let i = 0; i < 40 && !c.done; i++) {
      last = c.push(f(t));
      prompts.add(c.prompt);
      t += 250;
    }
    expect(last).toEqual({ kind: "done", count: ENROLL_TARGET });
    expect([...prompts]).toEqual([...ENROLL_PROMPTS]);
    expect(c.takeSamples()).toHaveLength(ENROLL_TARGET);
    expect(c.takeSamples()[0]).toHaveLength(128);
  });

  it("does not sample twice within 300 ms", () => {
    const c = new EnrollmentCollector();
    expect(c.push(f(0))).toEqual({ kind: "sampled", count: 1 });
    expect(c.push(f(ENROLL_MIN_INTERVAL_MS - 1))).toMatchObject({ kind: "waiting", count: 1 });
    expect(c.push(f(ENROLL_MIN_INTERVAL_MS + 100))).toEqual({ kind: "sampled", count: 2 });
  });

  it("poor quality only waits; multiple faces or a gap > 500 ms or a lost face discards the whole batch", () => {
    const c = new EnrollmentCollector();
    c.push(f(0));
    c.push(f(400));
    expect(c.push(f(600, { quality: "not_frontal", feature: undefined }))).toEqual({ kind: "waiting", count: 2, quality: "not_frontal" });
    expect(c.push(f(800, { face_count: 2, quality: "multi_face", feature: undefined }))).toEqual({ kind: "reset", reason: "multi_face" });
    expect(c.count).toBe(0);
    c.push(f(1000));
    c.push(f(1400));
    expect(c.push(f(2000))).toEqual({ kind: "reset", reason: "lost" }); // 600 ms 沒有畫格
    // 還沒有樣本時畫格隔太久（電腦忙）：照實回報 slow，不假裝在取樣
    expect(c.push(f(2700))).toEqual({ kind: "slow", gap_ms: 700 });
    expect(c.count).toBe(0);
    expect(c.count).toBe(0);
    c.push(f(2200));
    expect(c.push(f(2400, { face_count: 0, quality: "no_face", feature: undefined }))).toEqual({ kind: "reset", reason: "lost" });
    expect(c.count).toBe(0);
  });

  it("discard() zeroes and drops the samples (closing the Surface)", () => {
    const c = new EnrollmentCollector();
    const feature = unitFeature(1);
    c.push(f(0, { feature }));
    c.discard();
    expect(c.count).toBe(0);
    expect(c.takeSamples()).toEqual([]);
  });

  it("rejects a target outside 5–10", () => {
    expect(() => new EnrollmentCollector(4)).toThrow();
    expect(() => new EnrollmentCollector(11)).toThrow();
  });
});

class FakeWorker implements WorkerLike {
  readonly sent: { msg: WorkerRequest; transfer?: Transferable[] }[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void {
    this.sent.push({ msg, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(msg: WorkerResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
  frames(): Extract<WorkerRequest, { type: "frame" }>[] {
    return this.sent.map((s) => s.msg).filter((m): m is Extract<WorkerRequest, { type: "frame" }> => m.type === "frame");
  }
}

describe("IdentityClient", () => {
  function setup(sample: () => Promise<ImageBitmap | null> = async () => ({ close: vi.fn() }) as unknown as ImageBitmap) {
    const workers: FakeWorker[] = [];
    const frames: ClientFrame[] = [];
    const states: ClientState[] = [];
    let tick: (() => void) | null = null;
    const clock = { now: 0 };
    const client = new IdentityClient({
      source: { sampleFrame: sample },
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      onFrame: (fr) => frames.push(fr),
      onState: (s) => states.push(s),
      now: () => clock.now,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
    });
    /** 時間前進 ms（預設 50＝一次 POLL_MS），再跑一次 tick。 */
    const step = async (ms = 50) => {
      clock.now += ms;
      tick?.();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { client, workers, frames, states, step, clock, ticking: () => tick !== null };
  }
  const model = { detector: "d", recognizer: "r", align: "a", preproc: "p" };

  it("loads models first, then sends at most one frame at a time (≤4 Hz), transferring the bitmap", async () => {
    const t = setup();
    t.client.start();
    const w = t.workers[0]!;
    expect(w.sent[0]!.msg).toMatchObject({ type: "init", assets: { wasmPrefix: "/face-runtime/" } });
    await t.step();
    expect(w.frames()).toHaveLength(0); // 還沒 ready
    w.reply({ type: "ready", model, load_ms: 10 });
    await t.step();
    await t.step();
    await t.step();
    expect(w.frames()).toHaveLength(1); // 推論還沒回來就不送下一格
    const sent = w.sent.find((s) => s.msg.type === "frame")!;
    expect(sent.transfer).toEqual([(sent.msg as { bitmap: unknown }).bitmap]);
    w.reply({ type: "result", gen: t.client.generation, face_count: 1, quality: "ok", feature: unitFeature(1), ms: 50 });
    expect(t.frames).toHaveLength(1);
    // 上一格在 50 ms 時取，現在 200 ms：還沒滿 250 ms，不取
    await t.step();
    expect(w.frames()).toHaveLength(1);
    // 300 ms：滿 250 ms 且推論已回來，立刻取下一格（不必等下一個整點）
    await t.step(100);
    expect(w.frames()).toHaveLength(2);
  });

  it("stop() bumps the generation, terminates the worker and drops late results", async () => {
    const t = setup();
    t.client.start();
    const w = t.workers[0]!;
    w.reply({ type: "ready", model, load_ms: 1 });
    await t.step();
    const gen = t.client.generation;
    t.client.stop();
    expect(w.terminated).toBe(true);
    expect(w.sent.at(-1)!.msg).toEqual({ type: "dispose" });
    expect(t.ticking()).toBe(false);
    w.reply({ type: "result", gen, face_count: 1, quality: "ok", feature: unitFeature(1), ms: 1 }); // 已解除 onmessage
    expect(t.frames).toHaveLength(0);
    // 重新開始：新的 worker、新的世代，舊世代的結果被丟掉
    t.client.start();
    const w2 = t.workers[1]!;
    w2.reply({ type: "ready", model, load_ms: 1 });
    w2.reply({ type: "result", gen, face_count: 1, quality: "ok", ms: 1 });
    expect(t.frames).toHaveLength(0);
    expect(t.client.generation).toBeGreaterThan(gen);
  });

  it("uses the caller's monotonic generation counter, so a new client never restarts at 0", () => {
    let counter = 41;
    const generation = () => ++counter;
    const make = () =>
      new IdentityClient({ source: { sampleFrame: async () => null }, createWorker: () => new FakeWorker(), onFrame: () => {}, onState: () => {}, generation, setInterval: () => 1, clearInterval: () => {} });
    const a = make();
    a.start();
    expect(a.generation).toBe(42);
    a.stop();
    const b = make();
    b.start();
    expect(b.generation).toBe(44);
    expect(b.generation).toBeGreaterThan(a.generation);
  });

  it("without a camera frame it reports no_camera and a no_frame result, and never posts a frame", async () => {
    const t = setup(async () => null);
    t.client.start();
    t.workers[0]!.reply({ type: "ready", model, load_ms: 1 });
    await t.step();
    expect(t.states.at(-1)).toEqual({ kind: "no_camera" });
    expect(t.frames.at(-1)).toMatchObject({ face_count: 0, quality: "no_frame" });
    expect(t.workers[0]!.frames()).toHaveLength(0);
  });

  it("closes a bitmap that arrives after stop()", async () => {
    const close = vi.fn();
    let resolve!: (b: ImageBitmap) => void;
    const t = setup(() => new Promise((r) => (resolve = r)));
    t.client.start();
    t.workers[0]!.reply({ type: "ready", model, load_ms: 1 });
    t.step();
    t.client.stop();
    resolve({ close } as unknown as ImageBitmap);
    await new Promise((r) => setTimeout(r, 0));
    expect(close).toHaveBeenCalled();
  });

  it("samples at most at 4 Hz by default, polling every 50 ms", () => {
    const src = readFileSync(new URL("../src/sense/identity-client.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export const SAMPLE_INTERVAL_MS = 250;/);
    expect(src).toMatch(/export const POLL_MS = 50;/);
  });
});

describe("assessQuality", () => {
  /** 正面、臉寬 160 px 的合成臉（OpenCV 順序：右眼、左眼、鼻尖、右嘴角、左嘴角）。 */
  function face(over: Partial<YuNetFace> = {}, lm?: [number, number][]): YuNetFace {
    const pts = (lm ?? [[600, 300], [680, 300], [640, 340], [610, 380], [670, 380]]).map(([x, y]) => ({ x, y }));
    return { box: { x: 560, y: 220, width: 160, height: 200 }, score: 0.92, landmarks: pts as unknown as YuNetFace["landmarks"], ...over };
  }
  const mid = () => 120;

  it("accepts one good frontal face", () => {
    expect(assessQuality([face()], 1280, 720, mid)).toMatchObject({ reason: "ok" });
  });

  it("never picks one face out of several", () => {
    expect(assessQuality([face(), face({ box: { x: 100, y: 100, width: 300, height: 300 } })], 1280, 720, mid)).toEqual({ reason: "multi_face" });
    expect(assessQuality([], 1280, 720, mid)).toEqual({ reason: "no_face" });
  });

  it("rejects small, out-of-frame, low-score, turned, tilted, dark and bright faces", () => {
    expect(assessQuality([face({ box: { x: 560, y: 220, width: 99, height: 120 } })], 1280, 720, mid).reason).toBe("too_small");
    expect(assessQuality([face({ box: { x: 1200, y: 220, width: 160, height: 200 } })], 1280, 720, mid).reason).toBe("out_of_frame");
    expect(assessQuality([face({ score: 0.7 })], 1280, 720, mid).reason).toBe("low_score");
    expect(assessQuality([face({}, [[600, 300], [680, 300], [672, 340], [610, 380], [670, 380]])], 1280, 720, mid).reason).toBe("not_frontal"); // 鼻尖偏到 0.9
    expect(assessQuality([face({}, [[600, 300], [680, 300], [640, 305], [610, 380], [670, 380]])], 1280, 720, mid).reason).toBe("not_frontal"); // 抬頭太多
    expect(assessQuality([face({}, [[600, 300], [670, 345], [640, 340], [600, 380], [650, 410]])], 1280, 720, mid).reason).toBe("tilted");
    expect(assessQuality([face()], 1280, 720, () => QUALITY_DEFAULTS.luma_range[0] - 1).reason).toBe("too_dark");
    expect(assessQuality([face()], 1280, 720, () => QUALITY_DEFAULTS.luma_range[1] + 1).reason).toBe("too_bright");
  });

  it("meanLuma averages the box (clamped to the frame)", () => {
    const w = 8;
    const h = 4;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(200);
    expect(meanLuma(rgba, w, h, { x: -5, y: -5, width: 100, height: 100 }, 1)).toBeCloseTo(200, 5);
    expect(meanLuma(rgba, w, h, { x: 20, y: 20, width: 1, height: 1 })).toBe(0);
  });
});
