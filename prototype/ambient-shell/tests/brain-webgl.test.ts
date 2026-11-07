// 方案 B：電子腦的 WebGL 繪製（src/brain-webgl.ts）。用假的 WebGL context 記錄呼叫，不需要真的 GPU。
// 檢查：每格畫粒子、連線、光脈衝；上傳不超過預先配置的大小、每格不重新配置；遵守效能設定；
// 建立失敗、只有軟體 WebGL、context lost 時自動改回 Canvas 並照實回報；區名畫在上層的 2D 畫布。
import { afterEach, expect, it, vi } from "vitest";
import { Brain, type BrainVisualState } from "../src/brain.ts";
import { RENDER_BUDGETS } from "../src/performance.ts";
import { MAX_PULSES, WEBGL_CONTEXT_ATTRIBUTES, type WebGLBrainRenderer } from "../src/brain-webgl.ts";
import { activityDescription, type RegionActivity } from "../src/region-activity.ts";

afterEach(() => vi.unstubAllGlobals());

const idle: BrainVisualState = { conversation: "idle", listening: false, working: false, layout: "center", progress: null };
const activity: RegionActivity[] = [{ domain: "language", source: "tts", owner: "speech" }];

type Call = { name: string; args: unknown[] };

function fakeGL(opts: { rendererName?: string }) {
  const calls: Call[] = [];
  const allocated = new Map<unknown, number>();
  let bound: unknown = null;
  const target: Record<string, unknown> = {
    getExtension: (name: string) => {
      if (name === "WEBGL_debug_renderer_info") return { UNMASKED_RENDERER_WEBGL: "UNMASKED_RENDERER_WEBGL" };
      if (name === "WEBGL_lose_context") return { loseContext: () => calls.push({ name: "loseContext", args: [] }) };
      return null;
    },
    getParameter: (p: string) => (p === "ALIASED_POINT_SIZE_RANGE" ? new Float32Array([1, 256]) : opts.rendererName ?? "Fake GPU"),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createBuffer: () => ({ buffer: calls.length }),
    createProgram: () => ({}),
    createShader: () => ({}),
    getUniformLocation: (_p: unknown, name: string) => ({ name }),
    bindBuffer: (_t: unknown, b: unknown) => { bound = b; },
    bufferData: (_t: unknown, data: number | Float32Array) => {
      allocated.set(bound, typeof data === "number" ? data : data.byteLength);
      calls.push({ name: "bufferData", args: [bound, data] });
    },
    bufferSubData: (_t: unknown, offset: number, data: Float32Array) => {
      calls.push({ name: "bufferSubData", args: [bound, offset, data, allocated.get(bound)] });
    },
  };
  const gl = new Proxy(target, {
    get: (t, key: string) => {
      if (key in t) return t[key];
      if (/^[A-Z_0-9]+$/.test(key)) return key;
      return (...args: unknown[]) => { calls.push({ name: key, args }); };
    },
  });
  return { gl, calls };
}

function setup(opts: { webgl?: "ok" | "refuse" | "software" | "throw"; devicePixelRatio?: number } = {}) {
  let nextFrame: FrameRequestCallback = () => {};
  let now = 0;
  const text: string[] = [];
  let particles = 0;
  const ctx2d = (record: string[]) =>
    new Proxy({
      createRadialGradient: () => ({ addColorStop() {} }),
      createLinearGradient: () => ({ addColorStop() {} }),
      measureText: (s: string) => ({ width: s.length * 8 }),
      fillText: (s: string) => { record.push(s); },
      fillRect: (_x: number, _y: number, w: number) => { if (w < 10) particles++; },
    } as Record<string, unknown>, { get: (t, k) => Reflect.get(t, k) ?? (() => {}) });
  const main = ctx2d(text);
  const gls: ReturnType<typeof fakeGL>[] = [];
  const attributes: unknown[] = [];
  const glCanvases: { removed: boolean; listeners: Map<string, () => void>; width: number; style: Record<string, string> }[] = [];
  const createElement = () => {
    const listeners = new Map<string, () => void>();
    const element = {
      width: 0, height: 0, style: {} as Record<string, string>, className: "", removed: false, listeners,
      setAttribute() {},
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      remove() { element.removed = true; },
      getContext: (type: string, attrs?: unknown) => {
        if (type !== "webgl") return ctx2d([]);
        attributes.push(attrs);
        if (opts.webgl === "refuse") return null;
        if (opts.webgl === "throw") throw new Error("boom");
        const fake = fakeGL({ rendererName: opts.webgl === "software" ? "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" : undefined });
        gls.push(fake);
        glCanvases.push(element);
        return fake.gl;
      },
    };
    return element;
  };
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800, devicePixelRatio: opts.devicePixelRatio ?? 2, matchMedia: () => ({ matches: false }), addEventListener() {} });
  vi.stubGlobal("document", { createElement, documentElement: { style: { setProperty() {} } } });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { nextFrame = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const inserted: unknown[] = [];
  const canvas = {
    getContext: () => main, dataset: {}, style: {}, width: 0, height: 0,
    parentNode: { insertBefore: (node: unknown) => inserted.push(node) },
  } as unknown as HTMLCanvasElement;
  const brain = new Brain(canvas);
  brain.start();
  let tick = 0;
  const run = (ms: number) => {
    const end = now + ms;
    let ticks = 0;
    while (now < end) {
      tick += 1;
      now += 1000 / 60 + (tick % 3 === 0 ? 0.3 : tick % 3 === 1 ? -0.3 : 0);
      nextFrame(now);
      ticks++;
    }
    return ticks;
  };
  const internal = brain as unknown as { renderer: WebGLBrainRenderer & { kind: string }; pulses: unknown[]; nodes: unknown[]; edges: unknown[] };
  return { brain, canvas, run, gls, glCanvases, inserted, attributes, internal, text, counts: { get particles() { return particles; }, reset() { particles = 0; } } };
}

const draws = (calls: Call[], mode: string) => calls.filter((c) => c.name === "drawArrays" && c.args[0] === mode);
const frameCount = (calls: Call[]) => calls.filter((c) => c.name === "clear").length;

it("asks for WebGL 1 without antialiasing, premultiplied, refusing a major performance caveat", () => {
  const t = setup({ webgl: "ok" });
  expect(t.brain.setRendererPreference(true)).toEqual({ requested: "webgl", active: "webgl", fallback: null, detail: null });
  expect(t.attributes[0]).toMatchObject({ premultipliedAlpha: true, antialias: false, failIfMajorPerformanceCaveat: true });
  expect(WEBGL_CONTEXT_ATTRIBUTES.failIfMajorPerformanceCaveat).toBe(true);
  // 只給量測腳本用的 allowSoftware 才放寬
  const bench = setup({ webgl: "ok" });
  bench.brain.setRendererPreference(true, { allowSoftware: true });
  expect(bench.attributes[0]).toMatchObject({ failIfMajorPerformanceCaveat: false });
});

it("the GL canvas goes under the original canvas, which becomes the label overlay", () => {
  const t = setup({ webgl: "ok" });
  t.brain.setRendererPreference(true);
  expect(t.inserted).toEqual([t.glCanvases[0]]);
  expect(t.internal.renderer.kind).toBe("webgl");
});

it("every frame draws all particles, every connection and the live pulses with additive blending", () => {
  const t = setup({ webgl: "ok" });
  t.brain.setRendererPreference(true);
  t.brain.setState({ ...idle, listening: true, voice: "live", activity });
  t.brain.pulse("step", "language");
  t.run(100);
  const { calls } = t.gls[0];
  calls.length = 0;
  t.run(500);
  const frames = frameCount(calls);
  expect(frames).toBeGreaterThan(10);
  const nodes = t.internal.nodes.length;
  const edges = t.internal.edges.length;
  // 每格：粒子一次（mode 0）、粒子光暈（mode 1）、光脈衝光點（mode 2）
  const points = draws(calls, "POINTS");
  expect(points.filter((c) => c.args[2] === nodes).length).toBe(frames);
  const lines = draws(calls, "LINES");
  expect(lines.filter((c) => (c.args[2] as number) >= edges * 2).length).toBe(frames);
  expect(draws(calls, "LINE_LOOP").length).toBe(frames * 2);
  expect(calls.filter((c) => c.name === "blendFunc" && c.args[0] === "ONE" && c.args[1] === "ONE").length).toBe(frames);
  const counts = t.internal.renderer.lastCounts;
  expect(counts.nodes).toBe(nodes);
  expect(counts.edgeVertices).toBe(edges * 2);
  expect(counts.regionEdgeVertices).toBeGreaterThan(0);
  expect(counts.pulses).toBe(t.internal.pulses.length);
  expect(counts.pulses).toBeGreaterThan(0);
});

it("uploads fit the preallocated buffers and nothing is reallocated per frame", () => {
  const t = setup({ webgl: "ok" });
  t.brain.setRendererPreference(true);
  t.brain.setState({ ...idle, activity });
  for (let i = 0; i < 6; i++) t.brain.pulse("success");
  t.run(100);
  const { calls } = t.gls[0];
  const allocations = calls.filter((c) => c.name === "bufferData").length;
  const uploads = calls.filter((c) => c.name === "bufferSubData");
  expect(allocations).toBe(3); // 方形（靜態）、點、線各一次
  expect(uploads.length).toBeGreaterThan(0);
  const arrays = new Set<unknown>();
  for (const call of uploads) {
    const [, offset, data, capacity] = call.args as [unknown, number, Float32Array, number];
    expect(offset).toBe(0);
    expect(data.byteLength).toBeLessThanOrEqual(capacity);
    arrays.add(data);
  }
  t.run(1000);
  expect(calls.filter((c) => c.name === "bufferData").length).toBe(allocations);
  for (const call of calls.filter((c) => c.name === "bufferSubData")) arrays.add(call.args[2]);
  expect(arrays.size).toBe(2); // 同兩個 Float32Array 每格重複使用
  expect(t.internal.pulses.length).toBeLessThanOrEqual(MAX_PULSES);
});

it.each([
  ["full", 30, 2560, 70],
  ["balanced", 20, 1280, 40],
  ["light", 12, 960, 20],
] as const)("%s: fps cap, pixel-ratio cap and pulse cap hold in WebGL", (profile, fps, width, maxPulses) => {
  const t = setup({ webgl: "ok", devicePixelRatio: 2 });
  t.brain.setRendererPreference(true);
  t.brain.setRenderBudget(RENDER_BUDGETS[profile]);
  expect(t.glCanvases[0].width).toBe(width);
  expect(t.canvas.width).toBe(width); // 疊層與 GL 畫布同解析度
  for (let i = 0; i < 4; i++) t.brain.pulse("success");
  t.run(100);
  const { calls } = t.gls[0];
  calls.length = 0;
  t.run(3000);
  const frames = frameCount(calls);
  expect(frames).toBeLessThanOrEqual(fps * 3 + 1);
  expect(frames).toBeGreaterThanOrEqual(Math.floor(fps * 3 * 0.95));
  expect(t.brain.frameStats()!.fps).toBeLessThanOrEqual(fps * 1.02);
  expect(t.internal.renderer.lastCounts.pulses).toBeLessThanOrEqual(maxPulses);
});

it("reduced glow halves the node-glow sprites and balanced/light send no ring blur to the shader", () => {
  const full = setup({ webgl: "ok" });
  full.brain.setRendererPreference(true);
  full.brain.setState({ ...idle, listening: true });
  full.run(300);
  const light = setup({ webgl: "ok" });
  light.brain.setRendererPreference(true);
  light.brain.setRenderBudget(RENDER_BUDGETS.light);
  light.brain.setState({ ...idle, listening: true });
  light.run(300);
  expect(light.internal.renderer.lastCounts.glows).toBeLessThan(full.internal.renderer.lastCounts.glows);
  const blur = (calls: Call[]) => calls.filter((c) => c.name === "uniform1f" && (c.args[0] as { name: string }).name === "u_blur").map((c) => c.args[1] as number);
  expect(Math.max(...blur(full.gls[0].calls))).toBeGreaterThanOrEqual(18);
  expect(Math.max(...blur(light.gls[0].calls))).toBe(0);
});

it("active-region labels are drawn on the 2D overlay in WebGL mode", () => {
  const t = setup({ webgl: "ok" });
  t.brain.setRendererPreference(true);
  t.brain.setState({ ...idle, activity });
  t.run(300);
  expect(t.text).toContain(activityDescription(activity[0]));
  expect(t.internal.renderer.lastCounts.labels).toBe(true);
  t.brain.setState(idle);
  t.run(3000);
  expect(t.internal.renderer.lastCounts.labels).toBe(false);
});

it.each([
  ["refuse", /refused/],
  ["throw", /refused/],
  ["software", /SwiftShader/],
] as const)("creation failure (%s) falls back to Canvas, keeps drawing and says why", (mode, detail) => {
  const t = setup({ webgl: mode });
  const changes: unknown[] = [];
  t.brain.onRendererChange = (s) => changes.push(s);
  const status = t.brain.setRendererPreference(true);
  expect(status).toMatchObject({ requested: "webgl", active: "canvas", fallback: "unavailable" });
  expect(status.detail).toMatch(detail);
  expect(changes).toEqual([status]);
  expect(t.inserted).toEqual([]);
  t.counts.reset();
  t.run(500);
  expect(t.counts.particles).toBeGreaterThan(0); // Canvas 照畫，不會空白
  // 這次開啟期間不再嘗試；關掉再開仍是 Canvas
  t.brain.setRendererPreference(false);
  expect(t.brain.rendererStatus()).toMatchObject({ active: "canvas", fallback: null });
  expect(t.brain.setRendererPreference(true)).toMatchObject({ active: "canvas", fallback: "unavailable" });
});

it("context loss switches to Canvas for the rest of the session and reports it", () => {
  const t = setup({ webgl: "ok" });
  t.brain.setRendererPreference(true);
  t.run(200);
  const changes: unknown[] = [];
  t.brain.onRendererChange = (s) => changes.push(s);
  t.glCanvases[0].listeners.get("webglcontextlost")!();
  expect(t.brain.rendererStatus()).toMatchObject({ requested: "webgl", active: "canvas", fallback: "context-lost", detail: "webglcontextlost" });
  expect(changes).toHaveLength(1);
  expect(t.glCanvases[0].removed).toBe(true);
  // context 已失去，不再呼叫 loseContext
  expect(t.gls[0].calls.filter((c) => c.name === "loseContext")).toHaveLength(0);
  t.counts.reset();
  t.run(300);
  expect(t.counts.particles).toBeGreaterThan(0);
  expect(t.brain.setRendererPreference(true)).toMatchObject({ active: "canvas", fallback: "context-lost" });
  expect(t.gls).toHaveLength(1);
});

it("switching off removes the GL canvas, releases the context and goes back to Canvas live", () => {
  const t = setup({ webgl: "ok" });
  t.brain.setRendererPreference(true);
  t.run(200);
  expect(t.brain.frameStats()).not.toBeNull();
  t.brain.setRendererPreference(false);
  expect(t.glCanvases[0].removed).toBe(true);
  expect(t.gls[0].calls.filter((c) => c.name === "loseContext")).toHaveLength(1);
  expect(t.brain.rendererStatus()).toEqual({ requested: "canvas", active: "canvas", fallback: null, detail: null });
  expect(t.brain.frameStats()).toBeNull(); // 換繪製方式時重新量
  t.counts.reset();
  t.run(300);
  expect(t.counts.particles).toBeGreaterThan(0);
  expect(t.brain.frameStats()).not.toBeNull();
  // 再開一次是新的 context
  t.brain.setRendererPreference(true);
  expect(t.gls).toHaveLength(2);
});

it("the default is Canvas and nothing touches WebGL until the switch is on", () => {
  const t = setup({ webgl: "ok" });
  t.run(300);
  expect(t.brain.rendererStatus()).toEqual({ requested: "canvas", active: "canvas", fallback: null, detail: null });
  expect(t.attributes).toEqual([]);
});
