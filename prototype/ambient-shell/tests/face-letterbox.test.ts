// 產品 worker 的 YuNet 640 前處理（src/sense/face/yunet.ts letterboxToChw）對 OpenCV cv2.resize INTER_LINEAR 的核對。
// golden 由 docs/validation/family-id-01-2026-10-25/opencv-letterbox-golden.py 以 opencv-python-headless 5.0.0 產生。
// 這補上 ADR-0001 §10「YuNet 640 letterbox 沒有對 OpenCV 核對」的前處理部分；不載入模型、不證明辨識準確率。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { letterboxToChw, planLetterbox } from "../src/sense/face/yunet.ts";

const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "face-letterbox-opencv-golden.json"), "utf8")) as {
  cases: { src_w: number; src_h: number; input_w: number; input_h: number; drawn_w: number; drawn_h: number; rgba: number[]; bgr: number[] }[];
};

describe("letterboxToChw vs cv2.resize INTER_LINEAR", () => {
  it.each(golden.cases.map((c) => [`${c.src_w}×${c.src_h} → ${c.drawn_w}×${c.drawn_h}`, c] as const))("%s", (_name, c) => {
    const lb = planLetterbox(c.src_w, c.src_h, c.input_w, c.input_h);
    expect([lb.drawnW, lb.drawnH]).toEqual([c.drawn_w, c.drawn_h]);
    const chw = letterboxToChw(c.rgba, c.src_w, c.src_h, lb, "bgr");
    const plane = c.input_w * c.input_h;
    let maxDiff = 0;
    let exact = 0;
    for (let y = 0; y < c.input_h; y++) {
      for (let x = 0; x < c.input_w; x++) {
        for (let ch = 0; ch < 3; ch++) {
          const got = chw[ch * plane + y * c.input_w + x]!;
          if (x >= c.drawn_w || y >= c.drawn_h) {
            expect(got).toBe(0); // 右下補 0
            continue;
          }
          const want = c.bgr[(y * c.drawn_w + x) * 3 + ch]!;
          maxDiff = Math.max(maxDiff, Math.abs(got - want));
          if (got === want) exact++;
        }
      }
    }
    // 縮小（產品的情況）逐像素相同；放大時 OpenCV 走的路徑略有不同，個別像素差 1。
    if (c.drawn_w <= c.src_w) expect(maxDiff).toBe(0);
    else {
      expect(maxDiff).toBeLessThanOrEqual(1);
      expect(exact / (c.drawn_w * c.drawn_h * 3)).toBeGreaterThan(0.95);
    }
  });

  it("exact 0.5× downscale equals the rounded 2×2 average (the 1280×720 → 640×360 case)", () => {
    const c = golden.cases.find((g) => g.src_w === 64)!;
    const lb = planLetterbox(64, 36, 32, 32);
    const chw = letterboxToChw(c.rgba, 64, 36, lb, "bgr");
    const at = (x: number, y: number, ch: number) => c.rgba[(y * 64 + x) * 4 + ch]!;
    for (const [x, y] of [[0, 0], [5, 7], [31, 17]] as const) {
      const avg = (at(2 * x, 2 * y, 2) + at(2 * x + 1, 2 * y, 2) + at(2 * x, 2 * y + 1, 2) + at(2 * x + 1, 2 * y + 1, 2)) / 4;
      expect(Math.abs(chw[y * 32 + x]! - avg)).toBeLessThanOrEqual(0.5);
    }
  });

  it("rejects a buffer smaller than the source", () => {
    expect(() => letterboxToChw(new Uint8Array(10), 4, 4, planLetterbox(4, 4, 8, 8))).toThrow(/too small/);
  });
});
