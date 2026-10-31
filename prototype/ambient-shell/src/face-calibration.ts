// 「校正人臉辨識」的量測與建議（George 2026-10-31）：鏡頭裝的位置一變，近距離範圍、面向判斷與臉部品質門檻就要跟著調。
// 純邏輯（不碰鏡頭、DOM 或 IPC）：畫面（family-view.ts）把每一格的品質與量測值、每 200 ms 的感知狀態與試認結果餵進來，
// 這裡算出每個位置的統計、給人看的建議，以及一組建議的校正值（使用者按「套用」才保存）。
// 只有數字：品質原因、臉的大小與角度、距離、面向與否；沒有影像、座標或分數。

import { DEFAULT_FACE_TUNING, FACE_TUNING_KEYS, NEAR_RANGE_MIN_SPAN_M, snapTuning, type FaceTuning } from "../shared/face-tuning.ts";
import type { IdentityState, QualityReason } from "../shared/identity.ts";
import type { FaceMetrics } from "./sense/face/quality.ts";

/** 建議依序量測的位置（使用者可以跳過任何一個）。 */
export const CALIBRATION_SPOTS = [
  { id: "seat", label: "平常坐著跟 Nous 說話的位置" },
  { id: "stand", label: "站著跟 Nous 說話的位置" },
  { id: "far", label: "最遠還會跟 Nous 說話的地方" },
] as const;

/** 每個位置量測多久（毫秒）。取樣器約 4 Hz，約 24 格。 */
export const SPOT_MEASURE_MS = 6000;

export interface FrameSample {
  quality: QualityReason;
  face_count: number;
  metrics?: FaceMetrics;
}

export interface SenseSample {
  present: boolean;
  facing: boolean;
  distance_m: number | null;
}

/** 一個位置的原始紀錄（只在記憶體，畫面收起就丟）。 */
export class SpotRecorder {
  readonly frames: FrameSample[] = [];
  readonly sense: SenseSample[] = [];
  readonly observations: IdentityState[] = [];

  addFrame(frame: FrameSample): void {
    this.frames.push({ quality: frame.quality, face_count: frame.face_count, ...(frame.metrics ? { metrics: frame.metrics } : {}) });
  }

  addSense(sample: SenseSample): void {
    this.sense.push(sample);
  }

  addObservation(state: IdentityState): void {
    this.observations.push(state);
  }
}

export interface SpotSummary {
  frames: number;
  /** 在場時的距離中位數（公尺）；量不到為 null。 */
  distance_m: number | null;
  /** 感知取樣中「在場」的比例。 */
  present_ratio: number;
  /** 在場時「面向螢幕」的比例。 */
  facing_ratio: number;
  /** 偵測到至少一張臉的畫格比例。 */
  face_ratio: number;
  /** 多張臉的畫格比例。 */
  multi_ratio: number;
  /** 用預設門檻判定品質合格的畫格比例。 */
  ok_ratio: number;
  /** 品質原因的次數（不含 ok）。 */
  reasons: Partial<Record<QualityReason, number>>;
  /** 單張臉時臉框寬度（px）的中位數。 */
  face_px: number | null;
  /** 臉框碰到畫面上緣的畫格比例（臉超出畫面上方）。 */
  top_edge_ratio: number;
  /** 試認：有認出（matched）為 yes；只看到「不認得」為 no；沒有可判斷的結果為 null。 */
  recognized: "yes" | "no" | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 百分位數（0–1，最近秩）。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

const ratio = (n: number, total: number) => (total === 0 ? 0 : n / total);

export function summarizeSpot(rec: SpotRecorder): SpotSummary {
  const frames = rec.frames.length;
  const present = rec.sense.filter((s) => s.present);
  const distances = present.map((s) => s.distance_m).filter((d): d is number => d !== null);
  const reasons: Partial<Record<QualityReason, number>> = {};
  for (const f of rec.frames) if (f.quality !== "ok") reasons[f.quality] = (reasons[f.quality] ?? 0) + 1;
  const single = rec.frames.filter((f) => f.face_count === 1 && f.metrics).map((f) => f.metrics!);
  const recognized = rec.observations.includes("matched") ? "yes" : rec.observations.includes("unknown") ? "no" : null;
  return {
    frames,
    distance_m: median(distances),
    present_ratio: ratio(present.length, rec.sense.length),
    facing_ratio: ratio(present.filter((s) => s.facing).length, present.length),
    face_ratio: ratio(rec.frames.filter((f) => f.face_count > 0).length, frames),
    multi_ratio: ratio(rec.frames.filter((f) => f.face_count > 1).length, frames),
    ok_ratio: ratio(rec.frames.filter((f) => f.quality === "ok").length, frames),
    reasons,
    face_px: median(single.map((m) => m.face_px)),
    top_edge_ratio: ratio(single.filter((m) => m.edge === "top").length, frames),
    recognized,
  };
}

/** 次數最多的品質原因（沒有就是 null）。 */
export function topReason(summary: SpotSummary): QualityReason | null {
  let best: QualityReason | null = null;
  let n = 0;
  for (const [reason, count] of Object.entries(summary.reasons) as [QualityReason, number][]) {
    if (count > n) {
      best = reason;
      n = count;
    }
  }
  return best;
}

/** 一個位置算不算「看得到臉」：至少一半的畫格有臉、而且量得到距離。只有這種位置會拿來推建議值。 */
export function spotUsable(summary: SpotSummary): boolean {
  return summary.frames > 0 && summary.face_ratio >= 0.5 && summary.distance_m !== null;
}

/** 給人看的建議（繁體中文原文；畫面再經 t() 翻譯）。最多四條，最重要的在前。 */
export function spotAdvice(summary: SpotSummary): string[] {
  const out: string[] = [];
  if (summary.frames === 0) return ["沒有取到畫面：確認鏡頭有在運作"];
  if (summary.present_ratio < 0.5) out.push("鏡頭幾乎沒看到人：確認你在鏡頭畫面裡");
  const topEdge = summary.top_edge_ratio > 0.1;
  if (topEdge) out.push("臉常超出畫面上緣：把鏡頭往上調一點");
  else if (summary.face_ratio < 0.5 && summary.present_ratio >= 0.5) out.push("鏡頭看得到人，卻常找不到臉：可能臉超出畫面（看右邊的鏡頭畫面）、背光或太遠");
  if (summary.multi_ratio > 0.1) out.push("畫面裡常有第二張臉（旁人、照片或電視）：這時不會叫名字");
  const top = topReason(summary);
  const topShare = top ? (summary.reasons[top] ?? 0) / summary.frames : 0;
  if (top && topShare >= 0.3) {
    if (top === "too_small") out.push("臉太小：這個位置太遠，可以調小「臉的大小下限」或站近一點");
    else if (top === "not_frontal") out.push("常被判定側臉：鏡頭和你平常看的方向差太多，可放寬「側臉容許量」或把鏡頭移到螢幕正上方");
    else if (top === "too_dark") out.push("太暗：開燈，或避免背對窗戶");
    else if (top === "too_bright") out.push("太亮：避免陽光直射臉或鏡頭");
    else if (top === "tilted") out.push("頭常是歪的：坐正一點，或確認鏡頭沒有裝歪");
    else if (top === "out_of_frame" && !topEdge) out.push("臉常碰到畫面邊緣：調整鏡頭方向，讓你在畫面中間");
  }
  if (summary.present_ratio >= 0.5 && summary.facing_ratio < 0.7) out.push("常被判定沒有面向螢幕：可放寬「面向螢幕的寬鬆度」");
  if (summary.recognized === "no" && summary.ok_ratio >= 0.3) out.push("看得清楚卻認不出：光線或樣子和登記時差很多，可以重新登記");
  return out.slice(0, 4);
}

/**
 * 依量測結果建議一組校正值（純函式）。只用看得到臉的位置；沒有任何可用位置時沿用目前的值。
 * - 距離：涵蓋最近的可用位置再近 0.15 m（不比預設遠）到最遠的可用位置再遠 0.25 m；
 * - 臉的大小下限：可用位置臉寬的第 20 百分位 × 0.9（不超過預設 100 px，不低於 60 px）；
 * - 側臉容許量：可用位置偏轉量的第 80 百分位 + 0.03（不低於預設、不超過 0.3）；
 * - 面向寬鬆度與轉頭寬限：在場時面向比例偏低就放寬。
 */
export function suggestTuning(spots: readonly { summary: SpotSummary; recorder: SpotRecorder }[], current: FaceTuning): FaceTuning {
  const usable = spots.filter((s) => spotUsable(s.summary));
  if (usable.length === 0) return { ...current };
  const distances = usable.map((s) => s.summary.distance_m!);
  let nearMin = snapTuning("near_min_m", Math.min(DEFAULT_FACE_TUNING.near_min_m, Math.min(...distances) - 0.15));
  let nearMax = snapTuning("near_max_m", Math.max(...distances) + 0.25);
  if (nearMax - nearMin < NEAR_RANGE_MIN_SPAN_M) nearMax = snapTuning("near_max_m", nearMin + NEAR_RANGE_MIN_SPAN_M);
  if (nearMax - nearMin < NEAR_RANGE_MIN_SPAN_M) nearMin = snapTuning("near_min_m", nearMax - NEAR_RANGE_MIN_SPAN_M);

  const metrics = usable.flatMap((s) => s.recorder.frames.filter((f) => f.face_count === 1 && f.metrics).map((f) => f.metrics!));
  const sizes = metrics.filter((m) => m.edge === null).map((m) => m.face_px);
  const p20 = percentile(sizes, 0.2);
  const minFace = p20 === null ? current.min_face_px : snapTuning("min_face_px", Math.min(DEFAULT_FACE_TUNING.min_face_px, Math.floor(p20 * 0.9)));
  const yaws = metrics.filter((m) => m.yaw < 1).map((m) => m.yaw);
  const p80 = percentile(yaws, 0.8);
  const yaw = p80 === null ? current.max_yaw_offset : snapTuning("max_yaw_offset", Math.max(DEFAULT_FACE_TUNING.max_yaw_offset, p80 + 0.03));

  const facing = Math.min(...usable.map((s) => s.summary.facing_ratio));
  const facingRatio = facing < 0.5 ? 0.3 : facing < 0.7 ? 0.25 : DEFAULT_FACE_TUNING.facing_yaw_ratio;
  const grace = facing < 0.85 ? 1500 : DEFAULT_FACE_TUNING.facing_grace_ms;

  return {
    near_min_m: nearMin,
    near_max_m: nearMax,
    facing_yaw_ratio: snapTuning("facing_yaw_ratio", facingRatio),
    facing_grace_ms: snapTuning("facing_grace_ms", grace),
    min_face_px: minFace,
    max_yaw_offset: yaw,
  };
}

/** 建議值和目前值不同的項目（「套用」只送這些）。 */
export function tuningChanges(current: FaceTuning, next: FaceTuning): Partial<FaceTuning> {
  const patch: Partial<FaceTuning> = {};
  for (const k of FACE_TUNING_KEYS) if (next[k] !== current[k]) patch[k] = next[k];
  return patch;
}
