// ID-00 spike：耗時統計與兩個偵測器的框比較（純函式）。計算方式同 docs/validation/family-id-00-spike-2026-10-24.md。

import { rectOverlap, type FaceBox } from "./yunet.ts";

export interface TimingSummary {
  n: number;
  median: number;
  /** nearest-rank：排序後取第 ceil(0.95·n) 個。 */
  p95: number;
  min: number;
  max: number;
}

export function summarize(samples: readonly number[]): TimingSummary {
  if (samples.length === 0) throw new Error("no samples");
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return {
    n,
    median: n % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2,
    p95: s[Math.ceil(0.95 * n) - 1]!,
    min: s[0]!,
    max: s[n - 1]!,
  };
}

/** 浮點框的 IoU（不截整數；與 NMS 用的 Rect2i 版本分開）。 */
export function iou(a: FaceBox, b: FaceBox): number {
  return rectOverlap(a, b);
}

export interface BoxPair {
  /** a 清單（YuNet）索引 */
  a: number;
  /** b 清單（MediaPipe）索引 */
  b: number;
  iou: number;
  /** 兩框中心距離，像素 */
  centerOffsetPx: number;
  /** b 寬 ÷ a 寬 */
  widthRatio: number;
}

export interface BoxComparison {
  pairs: BoxPair[];
  unmatchedA: number[];
  unmatchedB: number[];
}

/** 依 IoU 由大到小貪婪配對；IoU 低於 minIou 不算同一張臉。 */
export function compareBoxes(a: readonly FaceBox[], b: readonly FaceBox[], minIou = 0.1): BoxComparison {
  const candidates: { a: number; b: number; iou: number }[] = [];
  a.forEach((ba, i) => b.forEach((bb, j) => candidates.push({ a: i, b: j, iou: iou(ba, bb) })));
  candidates.sort((x, y) => y.iou - x.iou);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: BoxPair[] = [];
  for (const c of candidates) {
    if (c.iou < minIou || usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    const ba = a[c.a]!;
    const bb = b[c.b]!;
    pairs.push({
      ...c,
      centerOffsetPx: Math.hypot(ba.x + ba.width / 2 - (bb.x + bb.width / 2), ba.y + ba.height / 2 - (bb.y + bb.height / 2)),
      widthRatio: bb.width / ba.width,
    });
  }
  return {
    pairs,
    unmatchedA: a.map((_, i) => i).filter((i) => !usedA.has(i)),
    unmatchedB: b.map((_, i) => i).filter((i) => !usedB.has(i)),
  };
}
