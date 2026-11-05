// 這台裝置的畫面效能（src/performance.ts）：設定表、每台裝置的預設與保存，以及「只碰畫面」的 import 檢查。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  applyProfile,
  defaultProfile,
  frameStatsText,
  loadProfile,
  NO_BLUR_CLASS,
  PERFORMANCE_KEY,
  PERFORMANCE_PROFILES,
  RENDER_BUDGETS,
  saveProfile,
} from "../src/performance.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
}

describe("render budgets", () => {
  it("full is the previous rendering; balanced and light only lower visual cost", () => {
    expect(PERFORMANCE_PROFILES).toEqual(["full", "balanced", "light"]);
    expect(RENDER_BUDGETS.full).toEqual({ maxFps: 30, pixelRatioCap: 2, maxPulses: 70, glow: "full", backdropBlur: true });
    expect(RENDER_BUDGETS.balanced).toEqual({ maxFps: 20, pixelRatioCap: 1, maxPulses: 40, glow: "full", backdropBlur: false });
    expect(RENDER_BUDGETS.light).toEqual({ maxFps: 12, pixelRatioCap: 0.75, maxPulses: 20, glow: "reduced", backdropBlur: false });
  });
});

describe("per-device default and storage", () => {
  it.each([
    ["", false, "full"],
    ["?terminal=rpi4", false, "balanced"],
    ["?lang=en&terminal=rpi4", false, "balanced"],
    ["?terminal=rpi4", true, "full"], // Mac App window with preload
    ["?terminal=Bad_ID", false, "full"],
    ["?terminal=", false, "full"],
  ] as const)("search %j, desktop=%s defaults to %s", (search, desktop, expected) => {
    expect(defaultProfile({ search, desktop })).toBe(expected);
    expect(loadProfile({ search, desktop }, memoryStorage())).toBe(expected);
  });

  it("a saved choice round-trips and wins over the default", () => {
    const storage = memoryStorage();
    expect(saveProfile("light", storage)).toBe(true);
    expect(storage.data.get(PERFORMANCE_KEY)).toBe("light");
    expect(loadProfile({ search: "", desktop: true }, storage)).toBe("light");
    saveProfile("full", storage);
    expect(loadProfile({ search: "?terminal=rpi4", desktop: false }, storage)).toBe("full");
  });

  it("an invalid stored value falls back to the device default", () => {
    for (const value of ["turbo", "", "FULL", "{}"]) {
      expect(loadProfile({ search: "?terminal=rpi4", desktop: false }, memoryStorage({ [PERFORMANCE_KEY]: value }))).toBe("balanced");
      expect(loadProfile({ search: "", desktop: false }, memoryStorage({ [PERFORMANCE_KEY]: value }))).toBe("full");
    }
  });

  it("storage that throws or is missing does not break loading or applying", () => {
    const broken = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(loadProfile({ search: "?terminal=rpi4", desktop: false }, broken)).toBe("balanced");
    expect(saveProfile("light", broken)).toBe(false);
    expect(loadProfile({ search: "", desktop: false }, null)).toBe("full");
    expect(saveProfile("light", null)).toBe(false);
  });

  it("the default storage is the page's localStorage, and a throwing accessor is tolerated", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    saveProfile("balanced");
    expect(loadProfile({ search: "", desktop: true })).toBe("balanced");
    vi.unstubAllGlobals();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("SecurityError"); } });
    try {
      expect(loadProfile({ search: "?terminal=rpi4", desktop: false })).toBe("balanced");
      expect(saveProfile("light")).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("applying a profile", () => {
  it("hands the budget to the brain and toggles the no-blur root class", () => {
    const toggles: [string, boolean | undefined][] = [];
    const budgets: unknown[] = [];
    const targets = { setRenderBudget: (b: unknown) => void budgets.push(b), root: { classList: { toggle: (name: string, force?: boolean) => toggles.push([name, force]) } } };
    applyProfile("light", targets);
    applyProfile("full", targets);
    expect(budgets).toEqual([RENDER_BUDGETS.light, RENDER_BUDGETS.full]);
    expect(toggles).toEqual([[NO_BLUR_CLASS, true], [NO_BLUR_CLASS, false]]);
  });

  it("the readout is labelled as measured and shows a dash before any sample", () => {
    expect(frameStatsText(null)).toEqual({ source: "實測：—", values: [] });
    expect(frameStatsText({ fps: 11.94, drawMs: 7.25 })).toEqual({ source: "實測：每秒 {0} 格，每格繪製 {1} 毫秒", values: ["12", "7.3"] });
  });
});

// 效能設定只碰畫面：從 src/performance.ts 與 src/brain.ts 出發的實際 import（不含 import type）不能碰到收音、播放、
// 即時語音、語音辨識、喚醒、處理中提示音或 SSE／心跳。
describe("the performance setting does not reach conversation modules", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  function runtimeImports(file: string, seen = new Set<string>()): Set<string> {
    if (seen.has(file)) return seen;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^"']*?from\s+["']([^"']+)["']/gm)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (/\.(ts|mjs|js)$/.test(target)) runtimeImports(target, seen);
    }
    return seen;
  }
  const forbidden = /(audio|realtime|speech|speaker|wake|voice|processing-sound|processing-cue|early-speech|live-|terminal-heartbeat|\/api\.ts$|\/main\.ts$)/;

  it.each(["src/performance.ts", "src/brain.ts"])("%s", (entry) => {
    const files = [...runtimeImports(resolve(root, entry))].map((f) => f.slice(root.length + 1));
    expect(files).toContain(entry);
    if (entry === "src/brain.ts") expect(files).toEqual(expect.arrayContaining(["src/performance.ts", "src/region-activity.ts", "shared/domain.ts"]));
    expect(files.filter((f) => forbidden.test(f))).toEqual([]);
  });
});
