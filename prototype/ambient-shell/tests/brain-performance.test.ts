// 電子腦依這台裝置的畫面效能（src/performance.ts）繪製：格數上限、畫布解析度、光脈衝上限、簡化光暈。
// 腦區仍要在每一種設定下亮起、畫出光脈衝與標籤（CLAUDE.md 的腦區動畫要求）。
import { afterEach, expect, it, vi } from "vitest";
import { Brain, type BrainVisualState } from "../src/brain.ts";
import { RENDER_BUDGETS } from "../src/performance.ts";
import { activityDescription, type RegionActivity } from "../src/region-activity.ts";

afterEach(() => vi.unstubAllGlobals());

const idle: BrainVisualState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null };

function renderer(opts: { reducedMotion?: boolean; devicePixelRatio?: number } = {}) {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  const calls = { clearRect: 0, fillText: [] as string[], drawImage: 0, shadowBlur: 0, radialGradients: 0 };
  const gradient = () => ({ addColorStop() {} });
  const target: Record<string, unknown> = {
    createRadialGradient: () => { calls.radialGradients++; return gradient(); },
    createLinearGradient: gradient,
    measureText: (text: string) => ({ width: text.length * 8 }),
    clearRect: () => { calls.clearRect++; },
    fillText: (text: string) => { calls.fillText.push(text); },
    drawImage: () => { calls.drawImage++; },
  };
  const context = new Proxy(target, {
    get: (t, key) => Reflect.get(t, key) ?? (() => {}),
    set: (t, key, value) => {
      if (key === "shadowBlur" && value > 0) calls.shadowBlur++;
      return Reflect.set(t, key, value);
    },
  });
  vi.stubGlobal("window", {
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: opts.devicePixelRatio ?? 2,
    matchMedia: () => ({ matches: opts.reducedMotion ?? false }), addEventListener() {},
  });
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }), documentElement: { style: { setProperty() {} } } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const canvas = { getContext: () => context, dataset: {}, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const brain = new Brain(canvas);
  brain.start();
  /** 以 1 ms 的 rAF 間隔模擬 ms 毫秒，回傳真的畫了幾格。 */
  const run = (ms: number) => {
    const before = calls.clearRect;
    for (let i = 0; i < ms; i++) nextFrame(now += 1);
    return calls.clearRect - before;
  };
  const pulses = () => (brain as unknown as { pulses: unknown[] }).pulses.length;
  return { brain, canvas, calls, run, pulses };
}

it.each([
  ["full", 30],
  ["balanced", 20],
  ["light", 12],
] as const)("%s draws at most %i frames per simulated second", (profile, fps) => {
  const t = renderer();
  t.brain.setRenderBudget(RENDER_BUDGETS[profile]);
  t.run(100);
  const frames = t.run(3000);
  expect(frames).toBeLessThanOrEqual(fps * 3);
  expect(frames).toBeGreaterThanOrEqual(Math.floor(fps * 3 * 0.95));
  const stats = t.brain.frameStats()!;
  expect(stats.fps).toBeLessThanOrEqual(fps);
  expect(stats.fps).toBeGreaterThan(fps * 0.95);
  expect(stats.drawMs).toBeGreaterThanOrEqual(0);
});

it("the default budget is full (unchanged 30 FPS cap), and reduced motion keeps its 10 FPS at every setting", () => {
  const plain = renderer();
  expect(plain.run(3000)).toBeLessThanOrEqual(90);
  expect(plain.run(3000)).toBeGreaterThanOrEqual(85);
  for (const profile of ["full", "light"] as const) {
    const t = renderer({ reducedMotion: true });
    t.brain.setRenderBudget(RENDER_BUDGETS[profile]);
    t.run(100);
    expect(t.run(3000)).toBe(30);
  }
});

it("frame stats are empty before two frames and reset when the budget changes", () => {
  const t = renderer();
  expect(t.brain.frameStats()).toBeNull();
  t.run(500);
  expect(t.brain.frameStats()).not.toBeNull();
  t.brain.setRenderBudget(RENDER_BUDGETS.light);
  expect(t.brain.frameStats()).toBeNull();
});

it("the canvas resolution follows the pixel-ratio cap, live", () => {
  const t = renderer({ devicePixelRatio: 2 });
  expect([t.canvas.width, t.canvas.height]).toEqual([2560, 1600]);
  t.brain.setRenderBudget(RENDER_BUDGETS.balanced);
  expect([t.canvas.width, t.canvas.height]).toEqual([1280, 800]);
  t.brain.setRenderBudget(RENDER_BUDGETS.light);
  expect([t.canvas.width, t.canvas.height]).toEqual([960, 600]);
  expect(t.canvas.style.width).toBe("1280px");
  t.brain.setRenderBudget(RENDER_BUDGETS.full);
  expect([t.canvas.width, t.canvas.height]).toEqual([2560, 1600]);
  const lowDensity = renderer({ devicePixelRatio: 1 });
  lowDensity.brain.setRenderBudget(RENDER_BUDGETS.light);
  expect(lowDensity.canvas.width).toBe(960);
});

it("pulses are capped by the budget, and switching down trims the existing ones", () => {
  const t = renderer();
  for (let i = 0; i < 4; i++) t.brain.pulse("success");
  expect(t.pulses()).toBe(70);
  t.brain.setRenderBudget(RENDER_BUDGETS.light);
  expect(t.pulses()).toBe(20);
  t.brain.pulse("success", "language");
  expect(t.pulses()).toBe(20);
  t.brain.setRenderBudget(RENDER_BUDGETS.balanced);
  for (let i = 0; i < 4; i++) t.brain.pulse("success");
  expect(t.pulses()).toBe(40);
});

it("light still lights the active region, draws its pulses and its label, without shadow blur", () => {
  const activity: RegionActivity[] = [{ domain: "language", source: "tts", owner: "speech" }];
  const label = activityDescription(activity[0]);
  const light = renderer();
  light.brain.setRenderBudget(RENDER_BUDGETS.light);
  light.brain.setState({ ...idle, listening: true, activity });
  light.brain.pulse("step", "language");
  light.calls.drawImage = 0;
  light.calls.radialGradients = 0;
  const frames = light.run(200);
  expect(light.calls.fillText).toContain(label);
  expect(light.calls.drawImage).toBeGreaterThan(0);
  // 每格一個中心光暈加上亮起腦區（語言區）的光暈
  expect(light.calls.radialGradients).toBe(frames * 2);
  expect(light.calls.shadowBlur).toBe(0);

  const full = renderer();
  full.brain.setState({ ...idle, listening: true, activity });
  full.run(200);
  expect(full.calls.fillText).toContain(label);
  expect(full.calls.shadowBlur).toBeGreaterThan(0);
});
