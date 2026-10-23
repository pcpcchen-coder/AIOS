import { afterEach, expect, it, vi } from "vitest";
import { Brain, brainGeometry, ORBIT_FIT_EXTENT, ZOOM_FIT_EXTENT, type BrainVisualState } from "../src/brain.ts";
import { brainZoom, SenseController, type SenseTuning } from "../src/sense/controller.ts";
import { DEFAULT_CAMERA_PREFS, type SenseEvent } from "../shared/sense.ts";

const idle: BrainVisualState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null };
afterEach(() => vi.unstubAllGlobals());

// 2026-10-23（George）：待機的電子腦改成靠近放大（brainZoom，最大倍率是使用者設定），不再跟字級的 D ÷ 2 m；
// 頂端縮略圖仍跟字級。下面「靠近變大」「重設」「starting」「視窗邊界」「resize」「不合法輸入」幾項原本寫的是
// 舊的共用比例（1.5 m 縮小、3 m 放大），已改成新的規則。

function renderer(width = 1280, height = 900, opts: { reducedMotion?: boolean; prefs?: SenseTuning } = {}) {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  let center = { x: 0, y: 0 };
  let drawn = { cx: 0, cy: 0, rx: 0 };
  /** 這一幀畫的粒子（小方塊）的範圍：腦形實際的邊界。 */
  let particles = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const css = new Map<string, string>();
  const gradient = () => ({ addColorStop() {} });
  const context = new Proxy({
    createRadialGradient: gradient, createLinearGradient: gradient,
    measureText: (text: string) => ({ width: text.length * 8 }),
    translate: (x: number, y: number) => { center = { x, y }; },
    ellipse: (_x: number, _y: number, rx: number) => { drawn = { cx: center.x, cy: center.y, rx }; },
    fillRect: (x: number, y: number, w: number, h: number) => {
      if (w >= 10) return; // 光暈的大方塊不算
      particles = { minX: Math.min(particles.minX, x), maxX: Math.max(particles.maxX, x + w), minY: Math.min(particles.minY, y), maxY: Math.max(particles.maxY, y + h) };
    },
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
  let resize = () => {};
  const viewport = { innerWidth: width, innerHeight: height, devicePixelRatio: 2, matchMedia: () => ({ matches: opts.reducedMotion ?? true }), addEventListener: (_name: string, callback: () => void) => { resize = callback; } };
  vi.stubGlobal("window", viewport);
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }), documentElement: { style: { setProperty: (key: string, value: string) => css.set(key, value) } } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const canvas = { getContext: () => context, dataset: {}, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const brain = new Brain(canvas);
  brain.start();
  const frame = () => {
    particles = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    nextFrame(now += 120);
    return { ...drawn, r: drawn.rx / 1.62, particles };
  };
  const controller = new SenseController({
    now: () => now, isTalking: () => false, canAutoTalk: () => false,
    startTalk() {}, interruptSpeech() {}, onLeave() {}, setPresence() {}, setFacing() {}, pointTo() {}, setSensor() {},
    setScale: (scale) => brain.setDistanceScale(scale),
    setBrainZoom: (factor) => brain.setProximityZoom(factor),
    prefs: opts.prefs ? () => opts.prefs! : undefined,
  });
  return { brain, css, canvas, frame, controller, resize: (w: number, h: number) => { viewport.innerWidth = w; viewport.innerHeight = h; resize(); } };
}

it("moving closer makes the standby brain and its click area bigger; far away is the default size", () => {
  const t = renderer();
  const normal = t.frame();
  const x = normal.cx + normal.r * 1.5;
  expect(t.brain.hitTest(x, normal.cy)).toBe(false);
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  expect(t.frame().r).toBeCloseTo(normal.r); // 2.5 m 以外不放大（舊規則是 1.5 倍）
  t.controller.handle({ type: "presence", present: true, distance_m: 1.5 });
  const mid = t.frame();
  expect(mid.r).toBeCloseTo(normal.r * brainZoom(1.5, 2)); // 舊規則在 1.5 m 是縮小到 0.75 倍
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const near = t.frame();
  expect(near.r).toBeGreaterThan(mid.r);
  expect(near.r).toBeGreaterThanOrEqual(normal.r * 1.5);
  expect(t.brain.hitTest(x, near.cy)).toBe(true);
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeCloseTo(near.r);
});

it("ordinary visual snapshots preserve the proximity zoom", () => {
  const t = renderer();
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const near = t.frame();
  t.brain.setState({ ...idle, conversation: "thinking", working: true });
  expect(t.frame().r).toBeCloseTo(near.r);
  t.brain.setState({ ...idle, listening: true });
  expect(t.frame().r).toBeCloseTo(near.r);
});

it("top-layout center and radius follow the text distance factor once, not the proximity zoom", () => {
  const t = renderer();
  t.brain.setState({ ...idle, layout: "top" });
  const normal = t.frame();
  t.controller.handle({ type: "presence", present: true, distance_m: 3 });
  const far = t.frame();
  expect(far.r).toBeCloseTo(normal.r * 1.5);
  expect(far.cy).toBeCloseTo(normal.cy * 1.5);
  t.controller.handle({ type: "presence", present: true, distance_m: 1.5 });
  expect(t.frame().r).toBeCloseTo(normal.r * 0.75); // 縮略圖不放大，才不會蓋住內容面板
  expect(t.css.has("--brain-top-r")).toBe(false);
});

it.each([
  [1920, 1080, 2, 1.95],
  [1920, 1080, 1.5, 1.5],
  [1920, 1080, 3, 2.1],
  [1280, 900, 2, 1.95],
  [390, 844, 2, 2],
])("a %ix%i standby brain at max %s is clearly bigger up close (at least %s×), up to the window bound", (width, height, max, atLeast) => {
  const t = renderer(width, height, { prefs: { ...DEFAULT_CAMERA_PREFS, brain_zoom_max: max } });
  const normal = t.frame();
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const near = t.frame();
  expect(near.r / normal.r).toBeGreaterThanOrEqual(atLeast);
  expect(near.r / normal.r).toBeLessThanOrEqual(max + 1e-9);
  expect(near.r).toBeCloseTo(brainGeometry(width, height, "center", max, 1).r);
});

it("max 1 (off) keeps the standby brain at the default size up close", () => {
  const t = renderer(1280, 900, { prefs: { ...DEFAULT_CAMERA_PREFS, brain_zoom_max: 1 } });
  const normal = t.frame();
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  expect(t.frame().r).toBeCloseTo(normal.r);
});

it("without reduced motion the size eases toward the target over a few frames, and the CSS radius follows the drawing", () => {
  const t = renderer(1280, 900, { reducedMotion: false });
  const base = brainGeometry(1280, 900, "center", 1, 1).r;
  // 呼吸動畫讓繪圖半徑在 ±1.8% 內變化；沒有事件時大小不變。
  for (let i = 0; i < 10; i++) expect(Math.abs(t.frame().r - base)).toBeLessThanOrEqual(base * 0.019);
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeCloseTo(base);
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const target = brainGeometry(1280, 900, "center", 2, 1).r;
  const first = t.frame();
  expect(first.r).toBeGreaterThan(base * 1.019);
  expect(first.r).toBeLessThan(target);
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeLessThan(target);
  let last = first;
  for (let i = 0; i < 12; i++) last = t.frame();
  expect(last.r).toBeGreaterThan(target * 0.98 - 1);
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeCloseTo(target);
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
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  expect(t.frame().r).toBeGreaterThan(normal.r);
  t.controller.handle(event);
  expect(t.frame().r).toBeCloseTo(normal.r);
});

it("starting preserves the existing controller's last zoom", () => {
  const t = renderer();
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const near = t.frame();
  t.controller.handle({ type: "sensor", state: "starting", detail: "starting" });
  expect(t.frame().r).toBeCloseTo(near.r);
});

it.each([[1920, 1080], [1366, 768], [390, 844], [844, 390]])("a %ix%i viewport keeps the brain inside: whole orbits unzoomed; the brain body, or the progress ring when shown, when zoomed", (width, height) => {
  for (const reducedMotion of [true, false]) {
    const t = renderer(width, height, { reducedMotion, prefs: { ...DEFAULT_CAMERA_PREFS, brain_zoom_max: 3 } });
    for (const layout of ["center", "top"] as const) {
      for (const progress of [null, 0.5]) {
        t.brain.setState({ ...idle, layout, progress });
        for (const distance_m of [0.6, 1.5, 2, 3]) {
          t.controller.handle({ type: "presence", present: true, distance_m });
          for (let i = 0; i < 20; i++) t.frame(); // 等緩動到位（含呼吸的各個相位）
          const { cx, cy, rx, particles } = t.frame();
          expect(particles.minX).toBeGreaterThanOrEqual(0);
          expect(particles.maxX).toBeLessThanOrEqual(width);
          expect(particles.minY).toBeGreaterThanOrEqual(0);
          expect(particles.maxY).toBeLessThanOrEqual(height);
          const zoomed = layout === "center" && brainZoom(distance_m, 3) > 1;
          if (zoomed && progress === null) continue; // 只有淡淡的軌道與聆聽光環可以超出邊緣
          const extent = zoomed ? (rx / 1.62) * 1.45 : rx; // 放大時檢查進度環，否則整個軌道
          expect(cx - extent).toBeGreaterThanOrEqual(0);
          expect(cx + extent).toBeLessThanOrEqual(width);
          expect(cy - extent).toBeGreaterThanOrEqual(0);
          expect(cy + extent).toBeLessThanOrEqual(height);
        }
      }
    }
  }
  expect(ZOOM_FIT_EXTENT.body.y).toBeLessThan(ZOOM_FIT_EXTENT.progress.y);
  expect(ZOOM_FIT_EXTENT.progress.y).toBeLessThan(ORBIT_FIT_EXTENT);
});

it("a real progress ring keeps the zoomed brain small enough for the ring; without one the body may fill the window", () => {
  const t = renderer(1920, 1080);
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const body = t.frame();
  expect(body.r).toBeCloseTo(brainGeometry(1920, 1080, "center", 2, 1, false).r);
  expect(body.r / 216).toBeGreaterThan(1.9);
  t.brain.setState({ ...idle, working: true, progress: 0.2 });
  const ring = t.frame();
  expect(ring.r).toBeCloseTo(brainGeometry(1920, 1080, "center", 2, 1, true).r);
  expect(ring.r).toBeLessThan(body.r);
  expect(ring.r / 216).toBeGreaterThan(1.5);
});

it("resize preserves the zoom, updates CSS radius and keeps DPR backing size", () => {
  const t = renderer();
  t.controller.handle({ type: "presence", present: true, distance_m: 1.5 });
  t.resize(390, 844);
  const frame = t.frame();
  expect(frame.r).toBeCloseTo(390 * 0.2 * brainZoom(1.5, 2));
  expect(Number.parseFloat(t.css.get("--brain-r")!)).toBeCloseTo(frame.r);
  expect(t.canvas.width).toBe(780);
  expect(t.canvas.height).toBe(1688);
});

it.each([NaN, Infinity, -1, 0])("invalid renderer input %s recovers neutral geometry", (scale) => {
  const t = renderer();
  const normal = t.frame();
  t.brain.setProximityZoom(2);
  expect(t.frame().r).toBeGreaterThan(normal.r);
  t.brain.setProximityZoom(scale);
  expect(t.frame().r).toBeCloseTo(normal.r);
  t.brain.setState({ ...idle, layout: "top" });
  const top = t.frame();
  t.brain.setDistanceScale(1.5);
  t.frame();
  t.brain.setDistanceScale(scale);
  expect(t.frame().r).toBeCloseTo(top.r);
});
