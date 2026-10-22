import { afterEach, expect, it, vi } from "vitest";
import { Brain, type BrainVisualState } from "../src/brain.ts";
import { SenseController } from "../src/sense/controller.ts";
import type { SenseEvent } from "../shared/sense.ts";

const idle: BrainVisualState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null };
afterEach(() => vi.unstubAllGlobals());

function renderer(width = 1280, height = 900) {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  let center = { x: 0, y: 0 };
  let drawn = { cx: 0, cy: 0, rx: 0 };
  const css = new Map<string, string>();
  const gradient = () => ({ addColorStop() {} });
  const context = new Proxy({
    createRadialGradient: gradient, createLinearGradient: gradient,
    measureText: (text: string) => ({ width: text.length * 8 }),
    translate: (x: number, y: number) => { center = { x, y }; },
    ellipse: (_x: number, _y: number, rx: number) => { drawn = { cx: center.x, cy: center.y, rx }; },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
  let resize = () => {};
  const viewport = { innerWidth: width, innerHeight: height, devicePixelRatio: 2, matchMedia: () => ({ matches: true }), addEventListener: (_name: string, callback: () => void) => { resize = callback; } };
  vi.stubGlobal("window", viewport);
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }), documentElement: { style: { setProperty: (key: string, value: string) => css.set(key, value) } } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const canvas = { getContext: () => context, dataset: {}, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const brain = new Brain(canvas);
  brain.start();
  const frame = () => { nextFrame(now += 120); return { ...drawn, r: drawn.rx / 1.62 }; };
  const controller = new SenseController({
    now: () => now, isTalking: () => false, canAutoTalk: () => false,
    startTalk() {}, interruptSpeech() {}, onLeave() {}, setPresence() {}, setFacing() {}, pointTo() {}, setSensor() {},
    setScale: (scale) => brain.setDistanceScale(scale),
  });
  return { brain, css, canvas, frame, controller, resize: (w: number, h: number) => { viewport.innerWidth = w; viewport.innerHeight = h; resize(); } };
}

it("measured distances change actual drawing and the matching click area", () => {
  const t = renderer();
  const normal = t.frame();
  const x = normal.cx + normal.r * 1.25;
  t.controller.handle({ type: "presence", present: true, distance_m: 1.5 });
  const near = t.frame();
  expect(near.r).toBeCloseTo(normal.r * 0.75);
  expect(t.brain.hitTest(x, near.cy)).toBe(false);
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  const far = t.frame();
  expect(far.r).toBeGreaterThan(normal.r);
  expect(t.brain.hitTest(x, far.cy)).toBe(true);
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeCloseTo(far.r);
});

it("ordinary visual snapshots preserve measured distance", () => {
  const t = renderer();
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  const far = t.frame();
  t.brain.setState({ ...idle, conversation: "thinking", working: true });
  expect(t.frame().r).toBeCloseTo(far.r);
  t.brain.setState({ ...idle, listening: true });
  expect(t.frame().r).toBeCloseTo(far.r);
});

it("top-layout center and radius follow the distance factor once", () => {
  const t = renderer();
  t.brain.setState({ ...idle, layout: "top" });
  const normal = t.frame();
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  const far = t.frame();
  expect(far.r).toBeCloseTo(normal.r * 1.5);
  expect(far.cy).toBeCloseTo(normal.cy * 1.5);
  expect(t.css.has("--brain-top-r")).toBe(false);
});

it.each<SenseEvent>([
  { type: "presence", present: true, distance_m: null },
  { type: "presence", present: false, distance_m: null },
  { type: "sensor", state: "off", detail: "off" },
  { type: "sensor", state: "error", detail: "error" },
  { type: "sensor", state: "degraded", detail: "degraded" },
])("the existing reset event %j restores default drawing", (event) => {
  const t = renderer();
  const normal = t.frame();
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  expect(t.frame().r).toBeGreaterThan(normal.r);
  t.controller.handle(event);
  expect(t.frame().r).toBeCloseTo(normal.r);
});

it("starting preserves the existing controller's last scale", () => {
  const t = renderer();
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  const far = t.frame();
  t.controller.handle({ type: "sensor", state: "starting", detail: "starting" });
  expect(t.frame().r).toBeCloseTo(far.r);
});

it.each([[1920, 1080], [1366, 768], [390, 844], [844, 390]])("actual orbits remain inside a %ix%i viewport in both layouts", (width, height) => {
  const t = renderer(width, height);
  for (const layout of ["center", "top"] as const) {
    t.brain.setState({ ...idle, layout });
    for (const distance_m of [1.5, 2, 3]) {
      t.controller.handle({ type: "presence", present: true, distance_m });
      const { cx, cy, rx } = t.frame();
      expect(cx - rx).toBeGreaterThanOrEqual(0);
      expect(cx + rx).toBeLessThanOrEqual(width);
      expect(cy - rx).toBeGreaterThanOrEqual(0);
      expect(cy + rx).toBeLessThanOrEqual(height);
    }
  }
});

it("resize preserves distance, updates CSS radius and keeps DPR backing size", () => {
  const t = renderer();
  t.controller.handle({ type: "presence", present: true, distance_m: 1.5 });
  t.resize(390, 844);
  const frame = t.frame();
  expect(frame.r).toBeCloseTo(390 * 0.2 * 0.75);
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeCloseTo(frame.r);
  expect(t.canvas.width).toBe(780);
  expect(t.canvas.height).toBe(1688);
});

it.each([NaN, Infinity, -1, 0])("invalid renderer input %s recovers neutral geometry", (scale) => {
  const t = renderer();
  const normal = t.frame();
  t.brain.setDistanceScale(1.5);
  t.frame();
  t.brain.setDistanceScale(scale);
  expect(t.frame().r).toBeCloseTo(normal.r);
});
