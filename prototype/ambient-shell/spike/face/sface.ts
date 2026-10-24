// ID-00 spike：SFace 的對齊、輸入張量與比對（純函式）。不接進產品流程，見 docs/14 與 ADR-0001。
// 照 OpenCV 官方實作改寫：opencv/opencv modules/objdetect/src/face_recognize.cpp（FaceRecognizerSFImpl），
// 查核 commit 048f050d5dca7385255583910af704c7c727ac9e。
// - alignCrop：5 點 similarity transform 到 112×112 範本，warpAffine INTER_LINEAR、邊界補 0。
// - feature：blobFromImage(scale 1, mean 0, swapRB=true) → 1×3×112×112，通道為 R、G、B，數值 0–255。
// - match：兩個 128 維特徵各自 L2 normalize 後內積（FR_COSINE）。
// 模型：OpenCV Zoo face_recognition_sface 2021dec（Apache-2.0）。

import type { FiveLandmarks, Point } from "./yunet.ts";

export const SFACE_SIZE = 112;
export const SFACE_DIM = 128;

/** face_recognize.cpp 的 dst 範本（右眼、左眼、鼻尖、右嘴角、左嘴角）。 */
export const SFACE_TEMPLATE: FiveLandmarks = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
/** OpenCV 寫死的範本平均值（等於上列五點平均）。 */
export const SFACE_TEMPLATE_MEAN: Point = { x: 56.0262, y: 71.9008 };

/** 2×3 仿射矩陣 [a, b, tx, c, d, ty]：dst = [a b; c d]·src + t。 */
export type Affine = readonly [number, number, number, number, number, number];

/**
 * 5 點 → 範本的最小平方 similarity（旋轉＋等比縮放＋平移，不含鏡射）。
 * OpenCV 以 2×2 SVD 實作 Umeyama（detA < 0 時把 D 的第二項設為 -1，排除鏡射）。二維時同一最佳解有封閉式：
 * 去平均後 α = Σ(dx·sx + dy·sy) / Σ|s|²、β = Σ(dy·sx − dx·sy) / Σ|s|²，矩陣為 [α −β; β α]。
 * 秩 2（非共線點）時兩者為同一唯一解；單元測試以逐行移植的 SVD 版本比對數值。
 */
export function similarityTransform(src: FiveLandmarks, dst: FiveLandmarks = SFACE_TEMPLATE, dstMean: Point = SFACE_TEMPLATE_MEAN): Affine {
  const n = src.length;
  const sm = { x: src.reduce((a, p) => a + p.x, 0) / n, y: src.reduce((a, p) => a + p.y, 0) / n };
  let num = 0;
  let cross = 0;
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i]!.x - sm.x;
    const sy = src[i]!.y - sm.y;
    const dx = dst[i]!.x - dstMean.x;
    const dy = dst[i]!.y - dstMean.y;
    num += dx * sx + dy * sy;
    cross += dy * sx - dx * sy;
    varS += sx * sx + sy * sy;
  }
  if (varS === 0) throw new Error("degenerate landmarks: all points coincide");
  const a = num / varS;
  const b = cross / varS;
  return [a, -b, dstMean.x - (a * sm.x - b * sm.y), b, a, dstMean.y - (b * sm.x + a * sm.y)];
}

export function applyAffine(m: Affine, p: Point): Point {
  return { x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] };
}

export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[4] - m[1] * m[3];
  if (det === 0) throw new Error("singular affine");
  const ia = m[4] / det;
  const ib = -m[1] / det;
  const ic = -m[3] / det;
  const id = m[0] / det;
  return [ia, ib, -(ia * m[2] + ib * m[5]), ic, id, -(ic * m[2] + id * m[5])];
}

export type ChannelOrder = "rgb" | "bgr";

/**
 * RGBA 像素（列優先，每像素 4 位元組）→ NCHW Float32，數值不縮放（0–255）。
 * YuNet 用 "bgr"（OpenCV blobFromImage 預設不交換通道，輸入為 BGR）；SFace 用 "rgb"（swapRB=true）。
 */
export function rgbaToChw(rgba: ArrayLike<number>, width: number, height: number, order: ChannelOrder): Float32Array {
  const plane = width * height;
  if (rgba.length < plane * 4) throw new Error("rgba buffer too small");
  const out = new Float32Array(plane * 3);
  const [c0, c2] = order === "rgb" ? [0, 2] : [2, 0];
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4 + c0]!;
    out[plane + i] = rgba[i * 4 + 1]!;
    out[2 * plane + i] = rgba[i * 4 + c2]!;
  }
  return out;
}

/**
 * cv::warpAffine（未設 WARP_INVERSE_MAP、INTER_LINEAR、BORDER_CONSTANT=0）直接輸出 SFace 的 RGB NCHW 張量。
 * m 為原圖 → 輸出的矩陣，取樣時用反矩陣。OpenCV 內部是 5 位元定點插值，這裡用浮點，數值會有 ≤1 的差異。
 */
export function warpAffineToChw(rgba: ArrayLike<number>, width: number, height: number, m: Affine, size = SFACE_SIZE): Float32Array {
  const inv = invertAffine(m);
  const plane = size * size;
  const out = new Float32Array(plane * 3);
  const px = (x: number, y: number, ch: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : rgba[(y * width + x) * 4 + ch]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = inv[0] * x + inv[1] * y + inv[2];
      const sy = inv[3] * x + inv[4] * y + inv[5];
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = y * size + x;
      for (let ch = 0; ch < 3; ch++) {
        const v =
          px(x0, y0, ch) * (1 - fx) * (1 - fy) +
          px(x0 + 1, y0, ch) * fx * (1 - fy) +
          px(x0, y0 + 1, ch) * (1 - fx) * fy +
          px(x0 + 1, y0 + 1, ch) * fx * fy;
        out[ch * plane + o] = v;
      }
    }
  }
  return out;
}

export function l2Normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new Error("zero vector cannot be normalized");
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** FR_COSINE：兩向量各自 L2 normalize 後內積，範圍 [-1, 1]；以 float64 計算 dot /(|a|·|b|)，數學上相同。 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`dimension mismatch ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) throw new Error("zero vector cannot be normalized");
  return dot / Math.sqrt(na * nb);
}
