import { afterEach, expect, it, vi } from "vitest";
import { Brain, PROCESSING_TINT, processingEnergy, processingHold } from "../src/brain.ts";
import { DOMAINS } from "../shared/domain.ts";

afterEach(() => vi.unstubAllGlobals());

it("the actual renderer geometry has six nonempty distinct partitions", () => {
  const context = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, setTransform() {} };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, addEventListener() {} });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }), documentElement: { style: { setProperty() {} } } });
  const dataset: Record<string, string> = {};
  const canvas = { getContext: () => context, dataset, style: {} } as unknown as HTMLCanvasElement;
  new Brain(canvas);
  const counts = JSON.parse(dataset.regionCounts) as Record<string, number>;
  expect(Object.keys(counts)).toEqual(DOMAINS);
  expect(Object.values(counts).every((count) => count > 0)).toBe(true);
  expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(500);
});

// 背景處理中（George 2026-11-02）：電子腦保持「思考中」的青色並緩慢呼吸；只由真實的執行中來源（state.processing）驅動。
function makeBrain(reduced = false) {
  const context = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, setTransform() {} };
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }), innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, addEventListener() {} });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }), documentElement: { style: { setProperty() {} } } });
  const canvas = { getContext: () => context, dataset: {}, style: {} } as unknown as HTMLCanvasElement;
  const brain = new Brain(canvas);
  const inner = brain as unknown as { step(dt: number): void; tint: { color: readonly number[]; strength: number }; energy: number; cueRings: number[] };
  return { brain, inner };
}
const idleState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null } as const;

it("processing holds a breathing cyan tint (0.35–0.55, 2 s period; flat 0.45 with reduced motion); speaking and error win", () => {
  expect(PROCESSING_TINT).toEqual({ base: 0.45, swing: 0.1, periodS: 2, energy: 0.65 });
  expect(processingHold({ processing: false, conversation: "idle" }, 0.5, false)).toBe(0);
  expect(processingHold({ processing: true, conversation: "idle" }, 0.5, false)).toBeCloseTo(0.55);
  expect(processingHold({ processing: true, conversation: "listening" }, 1.5, false)).toBeCloseTo(0.35);
  expect(processingHold({ processing: true, conversation: "thinking" }, 0.5, true)).toBe(0.45);
  for (const conversation of ["speaking", "error"] as const) expect(processingHold({ processing: true, conversation }, 0.5, false)).toBe(0);
  expect(processingEnergy({ processing: true, conversation: "idle" })).toBe(0.65);
  expect(processingEnergy({ processing: true, conversation: "listening" })).toBe(0.65);
  expect(processingEnergy({ processing: true, conversation: "speaking" })).toBe(0);
  expect(processingEnergy({ processing: false, conversation: "idle" })).toBe(0);
});

it("the renderer tints cyan and brightens only while processing, and lets success/error flashes fade down to it", () => {
  const { brain, inner } = makeBrain();
  brain.setState({ ...idleState });
  for (let i = 0; i < 30; i++) inner.step(0.1);
  expect(inner.tint.strength).toBe(0);
  brain.setState({ ...idleState, processing: true });
  for (let i = 0; i < 30; i++) inner.step(0.1);
  expect(inner.tint.color).toEqual([92, 225, 255]);
  expect(inner.tint.strength).toBeGreaterThanOrEqual(0.35);
  expect(inner.tint.strength).toBeLessThanOrEqual(0.56);
  expect(inner.energy).toBeGreaterThan(0.6);
  // 成功的薄荷綠先蓋過，再褪到處理中的水準
  brain.pulse("success");
  inner.step(0.05);
  expect(inner.tint.color).toEqual([92, 242, 176]);
  for (let i = 0; i < 30; i++) inner.step(0.1);
  expect(inner.tint.color).toEqual([92, 225, 255]);
  // 沒有在處理：青色照原本的速度褪掉（不假裝還在處理）
  brain.setState({ ...idleState, processing: false });
  for (let i = 0; i < 30; i++) inner.step(0.1);
  expect(inner.tint.strength).toBe(0);
});

it("a ping ring is drawn for a real ping, kept only while processing, never with reduced motion", () => {
  const { brain, inner } = makeBrain();
  brain.setState({ ...idleState });
  brain.cuePing();
  inner.step(0.05);
  expect(inner.cueRings).toEqual([]); // not processing: cleared on the next frame
  // main.ts render(): the first ping happens inside syncProcessingCue, before setState({ processing: true })
  brain.cuePing();
  brain.setState({ ...idleState, processing: true });
  inner.step(0.05);
  expect(inner.cueRings).toHaveLength(1);
  for (let i = 0; i < 13; i++) inner.step(0.1);
  expect(inner.cueRings).toEqual([]);
  const reduced = makeBrain(true);
  reduced.brain.setState({ ...idleState, processing: true });
  reduced.brain.cuePing();
  expect(reduced.inner.cueRings).toEqual([]);
});
