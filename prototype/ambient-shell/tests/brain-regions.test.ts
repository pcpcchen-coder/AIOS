import { afterEach, expect, it, vi } from "vitest";
import { Brain } from "../src/brain.ts";
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
