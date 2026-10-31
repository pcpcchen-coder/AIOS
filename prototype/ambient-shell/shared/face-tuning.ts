// 人臉辨識的校正值（George 2026-10-31）：鏡頭裝的位置不同，近距離範圍、面向判斷與臉部品質的合理門檻就不同。
// 「校正人臉辨識」量測使用者常用的位置後建議一組值，使用者按「套用」才保存（configDir/face-tuning.json）。
// 只影響看著說話的同步辨識與面向判斷；登記家人仍用預設的品質門檻（樣本要清楚），比對門檻（MATCH_THRESHOLDS）不在這裡。

/** 校正值；預設值等於校正功能出現前的固定常數。 */
export interface FaceTuning {
  /** 同步辨識的近距離下限（公尺；AMBIENT_NEAR_M.min）。 */
  near_min_m: number;
  /** 同步辨識的近距離上限（公尺；AMBIENT_NEAR_M.max）。 */
  near_max_m: number;
  /** 面向判斷：鼻子偏離雙耳中點的比例上限（FACING_MAX_YAW_RATIO）；同時影響看著說話。 */
  facing_yaw_ratio: number;
  /** 臉短暫轉開多久內不重置辨識（毫秒；identity-ambient.ts FACING_GRACE_MS）。 */
  facing_grace_ms: number;
  /** 臉框寬度下限（像素，1280×720；QUALITY_DEFAULTS.min_face_px）。 */
  min_face_px: number;
  /** 正面程度：鼻尖偏離兩眼中點的容許量（QUALITY_DEFAULTS.max_yaw_offset）。 */
  max_yaw_offset: number;
}

export interface TuningSpec {
  default: number;
  min: number;
  max: number;
  step: number;
  label: string;
  /** 顯示單位（「m」「ms」「px」；比例不帶單位）。 */
  unit: string;
}

/**
 * 每一項的範圍。下限刻意保守：臉框不小於 60 px（SFace 輸入 112 px，太小的臉特徵不可靠）、
 * 正面容許量不超過 0.3（再側就只剩半張臉），避免為了「認得到」而讓比對變得不可靠。
 */
export const FACE_TUNING_SPEC = {
  near_min_m: { default: 0.6, min: 0.3, max: 1.5, step: 0.05, label: "辨識的最近距離", unit: "m" },
  near_max_m: { default: 1.5, min: 0.8, max: 2.5, step: 0.05, label: "辨識的最遠距離", unit: "m" },
  facing_yaw_ratio: { default: 0.2, min: 0.1, max: 0.35, step: 0.01, label: "面向螢幕的寬鬆度", unit: "" },
  facing_grace_ms: { default: 800, min: 0, max: 3000, step: 100, label: "短暫轉頭的寬限", unit: "ms" },
  min_face_px: { default: 100, min: 60, max: 160, step: 5, label: "臉的大小下限", unit: "px" },
  max_yaw_offset: { default: 0.2, min: 0.1, max: 0.3, step: 0.01, label: "側臉容許量", unit: "" },
} as const satisfies Record<keyof FaceTuning, TuningSpec>;

export const FACE_TUNING_KEYS = Object.keys(FACE_TUNING_SPEC) as (keyof FaceTuning)[];

export const DEFAULT_FACE_TUNING: FaceTuning = Object.fromEntries(FACE_TUNING_KEYS.map((k) => [k, FACE_TUNING_SPEC[k].default])) as unknown as FaceTuning;

/** 最近與最遠距離至少要差這麼多（公尺）。 */
export const NEAR_RANGE_MIN_SPAN_M = 0.3;

export class FaceTuningError extends Error {}

/** 最近的格點，四捨五入到 step 的小數位。 */
export function snapTuning(key: keyof FaceTuning, value: number): number {
  const spec = FACE_TUNING_SPEC[key];
  const decimals = (String(spec.step).split(".")[1] ?? "").length;
  const snapped = Number((Math.round(value / spec.step) * spec.step).toFixed(decimals));
  return Math.min(spec.max, Math.max(spec.min, snapped));
}

/**
 * 邊界驗證（HTTP body、face-tuning.json）：只接受已知的鍵；數值要在範圍內且落在 step 上（容許 1e-6 誤差）。
 * 不默默夾住，錯誤丟 FaceTuningError（→ HTTP 400）。最近／最遠距離的關係在合併後由 checkFaceTuning 檢查。
 */
export function parseFaceTuningPatch(input: unknown): Partial<FaceTuning> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FaceTuningError("校正值必須是 JSON 物件");
  const patch: Partial<FaceTuning> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(FACE_TUNING_SPEC, key)) throw new FaceTuningError(`未知的校正值：${key}`);
    const k = key as keyof FaceTuning;
    const spec = FACE_TUNING_SPEC[k];
    const n = typeof value === "number" && Number.isFinite(value) ? value / spec.step : NaN;
    if (!Number.isFinite(n) || Math.abs(n - Math.round(n)) >= 1e-6) throw new FaceTuningError(`${key} 必須是數字、間隔 ${spec.step}`);
    const snapped = snapTuning(k, value as number);
    if (Math.abs(snapped - (value as number)) > spec.step / 2) throw new FaceTuningError(`${key} 必須在 ${spec.min}–${spec.max}`);
    patch[k] = snapped;
  }
  return patch;
}

/** 合併後的整組校正值是否合理（最遠距離要比最近距離遠 NEAR_RANGE_MIN_SPAN_M 以上）。 */
export function checkFaceTuning(tuning: FaceTuning): void {
  if (tuning.near_max_m - tuning.near_min_m < NEAR_RANGE_MIN_SPAN_M - 1e-9) {
    throw new FaceTuningError(`辨識的最遠距離要比最近距離遠至少 ${NEAR_RANGE_MIN_SPAN_M} m`);
  }
}

/** 「1.2 m」「800 ms」「100 px」「0.25」。 */
export function formatTuning(key: keyof FaceTuning, value: number): string {
  const unit = FACE_TUNING_SPEC[key].unit;
  return unit ? `${value} ${unit}` : String(value);
}

/** 設定畫面與核心 settings view 的形狀：目前值、是否全為預設、上次套用校正的時間。 */
export interface FaceTuningView extends FaceTuning {
  customized: boolean;
  calibrated_at: string | null;
}
