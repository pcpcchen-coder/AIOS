import { afterEach, expect, it, vi } from "vitest";
import { Brain, brainGeometry, HIT_EXTENT, ORBIT_FIT_EXTENT, ZOOM_FIT_EXTENT, type BrainVisualState } from "../src/brain.ts";
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
  const frame = (ms = 120) => {
    particles = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    nextFrame(now += ms);
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

it("easing at 30 fps: k = 1/6 per frame, so 63% after 6 frames (0.2 s) and 95% after 17 frames (about 0.57 s)", () => {
  const t = renderer(1920, 1080, { reducedMotion: false });
  t.frame();
  const base = brainGeometry(1920, 1080, "center", 1, 1).r;
  const target = brainGeometry(1920, 1080, "center", 2, 1).r;
  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const frameMs = 1000 / 30 + 0.01; // 剛好超過 FRAME_MS 的閘門，每次都畫
  const cross = (fraction: number) => {
    for (let n = 1; n <= 60; n++) {
      t.frame(frameMs);
      if (Number.parseFloat(t.css.get("--brain-r")!) >= base + (target - base) * fraction) return n;
    }
    return Infinity;
  };
  const n63 = cross(1 - 1 / Math.E);
  const n95 = n63 + cross(0.95);
  // 解析解：剩下的差每幀乘 5/6；ln(0.05) ÷ ln(5/6) = 16.4 幀，ln(1/e) ÷ ln(5/6) = 5.5 幀。
  expect(n63).toBe(Math.ceil(-1 / Math.log(5 / 6)));
  expect(n95).toBe(Math.ceil(Math.log(0.05) / Math.log(5 / 6)));
  expect(n63).toBe(6);
  expect(n95).toBe(17);
  expect((n95 * frameMs) / 1000).toBeCloseTo(0.567, 2);
});

it("the click area is an ellipse fitted to the body: inside hits at 2x, empty space below it misses, 1x edges still hit", () => {
  const t = renderer(1920, 1080, { reducedMotion: false }); // 一般動態效果：腦形會左右擺動，範圍最大
  // 量腦形範圍：多幀（含擺動、呼吸的各個相位）的粒子範圍聯集。
  const extent = () => {
    const e = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    let cx = 0, cy = 0;
    for (let i = 0; i < 300; i++) {
      const f = t.frame();
      ({ cx, cy } = f);
      e.minX = Math.min(e.minX, f.particles.minX); e.maxX = Math.max(e.maxX, f.particles.maxX);
      e.minY = Math.min(e.minY, f.particles.minY); e.maxY = Math.max(e.maxY, f.particles.maxY);
    }
    return { ...e, cx, cy };
  };
  const one = extent();
  const R1 = brainGeometry(1920, 1080, "center", 1, 1).r;
  // 量到的範圍（相對於 R）要在 HIT_EXTENT 之內，而且只差一點餘裕：上 1.07、下 0.78、左 1.22、右 1.19。
  const up = (one.cy - one.minY) / R1, down = (one.maxY - one.cy) / R1;
  const left = (one.cx - one.minX) / R1, right = (one.maxX - one.cx) / R1;
  expect(up).toBeCloseTo(1.07, 1);
  expect(down).toBeCloseTo(0.78, 1);
  expect(Math.max(left, right)).toBeCloseTo(1.22, 1);
  for (const [measured, limit] of [[up, HIT_EXTENT.up], [down, HIT_EXTENT.down], [left, HIT_EXTENT.x], [right, HIT_EXTENT.x]]) {
    expect(limit - measured).toBeGreaterThan(0.02);
    expect(limit - measured).toBeLessThan(0.1);
  }
  // 1 倍：腦形四邊的邊緣點，以及往外 5 px，都還點得到（原本 1.35 R 的圓也點得到）。
  for (const [x, y] of [[one.minX - 5, one.cy], [one.maxX + 5, one.cy], [one.cx, one.minY - 5], [one.cx, one.maxY + 5], [one.cx + R1 * 0.6, one.cy - R1 * 0.6], [one.cx - R1 * 0.7, one.cy + R1 * 0.4]]) {
    expect(Math.hypot(x - one.cx, y - one.cy)).toBeLessThan(R1 * 1.35);
    expect(t.brain.hitTest(x, y)).toBe(true);
  }
  expect(t.brain.hitTest(one.cx + R1 * 1.3, one.cy)).toBe(false);

  t.controller.handle({ type: "presence", present: true, distance_m: 0.6 });
  const two = extent();
  const R2 = brainGeometry(1920, 1080, "center", 2, 1).r;
  expect(R2).toBeCloseTo(432);
  // 2 倍：腦形裡面、腦形邊緣都點得到。
  for (const [x, y] of [[two.cx, two.cy], [two.cx + R2 * 0.8, two.cy], [two.cx, two.maxY - 2], [two.cx, two.minY + 2], [two.minX + 2, two.cy]]) {
    expect(t.brain.hitTest(x, y)).toBe(true);
  }
  // 腦形下方的空白（1920×1080 的 (960, 950)，在下緣約 842 px 之下）不會開對話；原本 1.35 R（583 px）的圓會。
  expect(two.maxY).toBeLessThan(950);
  expect(Math.hypot(960 - two.cx, 950 - two.cy)).toBeLessThan(R2 * 1.35);
  expect(t.brain.hitTest(960, 950)).toBe(false);
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
