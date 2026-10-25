import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareBoxes, summarize } from "../spike/face/metrics.ts";
import {
  applyAffine,
  cosineSimilarity,
  invertAffine,
  l2Normalize,
  rgbaToChw,
  SFACE_TEMPLATE,
  similarityTransform,
  warpAffineToChw,
  type Affine,
} from "../src/sense/face/sface.ts";
import {
  decodeYuNet,
  nmsBoxes,
  padToDivisor,
  planLetterbox,
  postProcessYuNet,
  toSourceCoords,
  type FiveLandmarks,
  type YuNetStrideOutput,
} from "../src/sense/face/yunet.ts";

// ID-00 spike 的前後處理（docs/14、ADR-0001）。golden 來源見 docs/validation/family-id-00-spike-2026-10-24/opencv-golden.py：
// NMS 與 warpAffine 直接呼叫 opencv-python-headless 5.0.0；similarity 的 golden 是 OpenCV 演算法（getSimilarityTransformMatrix）
// 的逐行移植，不是呼叫 OpenCV API，端到端對齊由 spike/face/tools/opencv-crosscheck.ts 以 alignCrop 佐證。
// 這些測試不載入模型、不證明辨識準確率。
const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "face-spike-opencv-golden.json"), "utf8")) as {
  similarity: Record<string, { src: [number, number][]; m: number[] }>;
  nms: { boxes: number[][]; scores: number[]; score_threshold: number; nms_threshold: number; top_k: number; keep: number[]; keep_topk2: number[] };
  warp: { w: number; h: number; m: number[]; size: number; out_bgr: number[][][] };
};

const five = (pts: [number, number][]): FiveLandmarks => pts.map(([x, y]) => ({ x, y })) as unknown as FiveLandmarks;

/** 640×640 輸入的三個尺度，全部為 0（分數 0）。 */
function emptyOutputs(pad = 640): YuNetStrideOutput[] {
  return [8, 16, 32].map((s) => {
    const cells = (pad / s) * (pad / s);
    return { cls: new Float32Array(cells), obj: new Float32Array(cells), bbox: new Float32Array(cells * 4), kps: new Float32Array(cells * 10) };
  });
}

function setCell(o: YuNetStrideOutput, idx: number, cls: number, obj: number, bbox: number[], kps: number[]): void {
  (o.cls as Float32Array)[idx] = cls;
  (o.obj as Float32Array)[idx] = obj;
  (o.bbox as Float32Array).set(bbox, idx * 4);
  (o.kps as Float32Array).set(kps, idx * 10);
}

describe("YuNet decode (face_detect.cpp postProcess)", () => {
  it("decodes an anchor-free cell into box, landmarks and sqrt(cls·obj) score", () => {
    const out = emptyOutputs();
    // stride 16、640/16 = 40 欄；第 5 列第 7 欄
    setCell(out[1]!, 5 * 40 + 7, 0.81, 1, [0.5, 0.25, Math.log(4), Math.log(2)], [0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1]);
    const [face, ...rest] = decodeYuNet(out, 640, 640, 0.6);
    expect(rest).toEqual([]);
    expect(face!.score).toBeCloseTo(0.9, 6);
    expect(face!.box.x).toBeCloseTo(88, 4);
    expect(face!.box.y).toBeCloseTo(68, 4);
    expect(face!.box.width).toBeCloseTo(64, 4);
    expect(face!.box.height).toBeCloseTo(32, 4);
    expect(face!.landmarks.map((p) => [p.x, p.y])).toEqual([
      [112, 80],
      [128, 80],
      [120, 88],
      [112, 96],
      [128, 96],
    ]);
  });

  it("clamps scores to [0,1] and drops cells below the threshold", () => {
    const out = emptyOutputs();
    setCell(out[0]!, 0, 1.7, 1.3, [0, 0, 0, 0], new Array(10).fill(0)); // 夾到 1 → 分數 1
    setCell(out[2]!, 3, 0.5, 0.5, [0, 0, 0, 0], new Array(10).fill(0)); // √0.25 = 0.5 < 0.6
    const faces = decodeYuNet(out, 640, 640, 0.6);
    expect(faces.map((f) => f.score)).toEqual([1]);
  });

  it("suppresses an overlapping lower-score cell only when more than one candidate exists", () => {
    const out = emptyOutputs();
    setCell(out[2]!, 2 * 20 + 2, 0.9, 0.9, [0.5, 0.5, Math.log(3), Math.log(3)], new Array(10).fill(0.5));
    setCell(out[2]!, 2 * 20 + 3, 0.8, 0.8, [-0.4, 0.5, Math.log(3), Math.log(3)], new Array(10).fill(0.5));
    setCell(out[2]!, 15 * 20 + 15, 0.7, 0.7, [0.5, 0.5, Math.log(2), Math.log(2)], new Array(10).fill(0.5));
    const faces = postProcessYuNet(out, 640, 640);
    expect(faces.map((f) => Number(f.score.toFixed(2)))).toEqual([0.9, 0.7]);
  });

  it("rejects outputs that do not match the padded input size", () => {
    expect(() => decodeYuNet(emptyOutputs(320), 640, 640, 0.6)).toThrow(/expected 6400 cells/);
  });
});

describe("NMS (cv::dnn::NMSBoxes)", () => {
  it("matches OpenCV's kept indices, including integer truncation and topK", () => {
    const g = golden.nms;
    const boxes = g.boxes.map(([x, y, width, height]) => ({ x: x!, y: y!, width: width!, height: height! }));
    expect(nmsBoxes(boxes, g.scores, g.score_threshold, g.nms_threshold, g.top_k)).toEqual(g.keep);
    expect(nmsBoxes(boxes, g.scores, g.score_threshold, g.nms_threshold, 2)).toEqual(g.keep_topk2);
  });
});

describe("letterbox into the fixed 640×640 YuNet input", () => {
  it("scales a 1280×720 frame by 0.5 and maps detections back to frame pixels", () => {
    const lb = planLetterbox(1280, 720, 640, 640);
    expect(lb).toEqual({ inputW: 640, inputH: 640, scale: 0.5, drawnW: 640, drawnH: 360 });
    const back = toSourceCoords(
      { score: 0.9, box: { x: 10, y: 20, width: 50, height: 60 }, landmarks: five([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]) },
      lb.scale,
    );
    expect(back.box).toEqual({ x: 20, y: 40, width: 100, height: 120 });
    expect(back.landmarks[4]).toEqual({ x: 18, y: 20 });
  });

  it("pads dynamic-shape input to a multiple of 32 like padWithDivisor", () => {
    expect([padToDivisor(720), padToDivisor(1280), padToDivisor(1), padToDivisor(32)]).toEqual([736, 1280, 32, 32]);
  });
});

describe("SFace alignment (getSimilarityTransformMatrix)", () => {
  it.each(Object.keys(golden.similarity))("matches a line-by-line port of OpenCV's SVD Umeyama for %s landmarks", (name) => {
    const g = golden.similarity[name]!;
    const m = similarityTransform(five(g.src));
    // OpenCV 以 float32 算平均與去平均，平移項（數百像素）約有 1e-4 的捨入差；旋轉縮放項比到 1e-6。
    [0, 1, 3, 4].forEach((i) => expect(m[i]).toBeCloseTo(g.m[i]!, 6));
    [2, 5].forEach((i) => expect(m[i]).toBeCloseTo(g.m[i]!, 3));
  });

  it("maps landmarks generated from the template by a known similarity back onto the template", () => {
    const forward: Affine = [2.4 * Math.cos(0.3), -2.4 * Math.sin(0.3), 500, 2.4 * Math.sin(0.3), 2.4 * Math.cos(0.3), 210];
    const src = SFACE_TEMPLATE.map((p) => applyAffine(forward, p)) as unknown as FiveLandmarks;
    const m = similarityTransform(src);
    src.forEach((p, i) => {
      const q = applyAffine(m, p);
      expect(q.x).toBeCloseTo(SFACE_TEMPLATE[i]!.x, 3);
      expect(q.y).toBeCloseTo(SFACE_TEMPLATE[i]!.y, 3);
    });
  });

  it("never returns a reflection, even for mirrored landmarks", () => {
    const m = similarityTransform(five(golden.similarity.mirrored!.src));
    expect(m[0] * m[4] - m[1] * m[3]).toBeGreaterThan(0);
  });

  it("inverts an affine matrix", () => {
    const m: Affine = [0.9, -0.2, 4.3, 0.2, 0.9, -2.1];
    const p = applyAffine(invertAffine(m), applyAffine(m, { x: 7, y: -3 }));
    expect(p.x).toBeCloseTo(7, 9);
    expect(p.y).toBeCloseTo(-3, 9);
  });
});

describe("pixel tensors", () => {
  const { w, h, m, size, out_bgr } = golden.warp;
  // 與 golden.py 相同的合成影像；OpenCV 的通道順序為 B、G、R，這裡轉成 RGBA。
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = ((x + y) * 3) % 256;
      rgba[i + 1] = (y * 6) % 256;
      rgba[i + 2] = (x * 5) % 256;
      rgba[i + 3] = 255;
    }

  it("warps like cv::warpAffine INTER_LINEAR within OpenCV's fixed-point rounding", () => {
    const chw = warpAffineToChw(rgba, w, h, m as unknown as Affine, size);
    const plane = size * size;
    let maxDiff = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const [b, g, r] = out_bgr[y]![x]!;
        const o = y * size + x;
        maxDiff = Math.max(maxDiff, Math.abs(chw[o]! - r!), Math.abs(chw[plane + o]! - g!), Math.abs(chw[2 * plane + o]! - b!));
      }
    expect(maxDiff).toBeLessThanOrEqual(1.5);
  });

  it("orders channels BGR for YuNet and RGB for SFace", () => {
    const px = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
    expect([...rgbaToChw(px, 2, 1, "bgr")]).toEqual([30, 60, 20, 50, 10, 40]);
    expect([...rgbaToChw(px, 2, 1, "rgb")]).toEqual([10, 40, 20, 50, 30, 60]);
  });
});

describe("feature comparison (FR_COSINE)", () => {
  it("L2-normalizes before the dot product", () => {
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 0], [0, 5])).toBeCloseTo(0, 9);
    expect(cosineSimilarity([1, 2], [-2, -4])).toBeCloseTo(-1, 9);
    const n = l2Normalize([3, 4]);
    expect([n[0], n[1]].map((v) => Number(v!.toFixed(6)))).toEqual([0.6, 0.8]);
  });

  it("rejects mismatched dimensions and zero vectors", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension/);
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow(/zero/);
  });
});

describe("spike metrics", () => {
  it("reports median and nearest-rank p95", () => {
    const s = summarize(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(s).toEqual({ n: 20, median: 10.5, p95: 19, min: 1, max: 20 });
    expect(summarize([5, 1, 3]).median).toBe(3);
  });

  it("pairs YuNet and MediaPipe boxes by IoU and reports unmatched faces", () => {
    const c = compareBoxes(
      [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 500, y: 500, width: 50, height: 50 },
      ],
      [{ x: 10, y: 10, width: 100, height: 100 }],
    );
    expect(c.pairs).toHaveLength(1);
    expect(c.pairs[0]!.iou).toBeCloseTo(8100 / 11900, 6);
    expect(c.pairs[0]!.centerOffsetPx).toBeCloseTo(Math.hypot(10, 10), 6);
    expect(c.unmatchedA).toEqual([1]);
    expect(c.unmatchedB).toEqual([]);
  });
});
