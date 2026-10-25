// 家人辨識的畫格品質（純函式，worker 與測試共用）。品質不足就不算特徵、不送核心（ADR-0001 §2.1、docs/14 §4）。
// 所有數值都是起點值、未校準：要在 Mac＋AR0144 實測後調整（驗證紀錄 family-id-01 §5）。

import type { QualityReason } from "../../../shared/identity.ts";
import type { FaceBox, YuNetFace } from "./yunet.ts";

export interface QualityOptions {
  /** 臉框寬度下限（像素，1280×720 畫格）；docs/14 §4 的起點 100 px。 */
  min_face_px: number;
  /** YuNet 分數下限。偵測本身用 0.6（OpenCV Zoo 範例）；登記與比對要求更高。 */
  min_score: number;
  /** 正面程度：鼻尖在兩眼之間的水平位置（0.5＝正中），允許偏離多少。0.2 約可容許「稍左／稍右」。 */
  max_yaw_offset: number;
  /** 抬頭／低頭：鼻尖在「兩眼中點 → 兩嘴角中點」線段上的位置，允許範圍。 */
  pitch_range: readonly [number, number];
  /** 兩眼連線的傾斜角上限（度）。 */
  max_roll_deg: number;
  /** 臉框內平均亮度（0–255）的範圍。 */
  luma_range: readonly [number, number];
}

export const QUALITY_DEFAULTS: QualityOptions = {
  min_face_px: 100,
  min_score: 0.8,
  max_yaw_offset: 0.2,
  pitch_range: [0.2, 0.8],
  max_roll_deg: 20,
  luma_range: [40, 220],
};

export interface QualityResult {
  reason: QualityReason;
  /** 只有 reason 為 ok 時帶出這張臉。 */
  face?: YuNetFace;
}

/** 臉框內的平均亮度（Rec. 601 加權，每隔 step 取一個像素）；框夾到畫格內。 */
export function meanLuma(rgba: ArrayLike<number>, width: number, height: number, box: FaceBox, step = 4): number {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      sum += 0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * 一個畫格的品質判定。多張臉一律 multi_face（不挑最大或最近的臉）；之後依序檢查大小、是否在畫面內、分數、
 * 正面程度、傾斜與亮度。luma 由呼叫端用 meanLuma 算（測試可直接給數字）。
 */
export function assessQuality(
  faces: readonly YuNetFace[],
  frameW: number,
  frameH: number,
  luma: (box: FaceBox) => number,
  opts: QualityOptions = QUALITY_DEFAULTS,
): QualityResult {
  if (faces.length === 0) return { reason: "no_face" };
  if (faces.length > 1) return { reason: "multi_face" };
  const face = faces[0]!;
  const { box, landmarks, score } = face;
  if (box.width < opts.min_face_px) return { reason: "too_small" };
  if (box.x < 0 || box.y < 0 || box.x + box.width > frameW || box.y + box.height > frameH) return { reason: "out_of_frame" };
  if (score < opts.min_score) return { reason: "low_score" };
  // OpenCV 順序：右眼、左眼（以被拍者為準）、鼻尖、右嘴角、左嘴角。
  const [eyeR, eyeL, nose, mouthR, mouthL] = landmarks;
  const eyeDx = eyeL.x - eyeR.x;
  const eyeDy = eyeL.y - eyeR.y;
  const eyeDist = Math.hypot(eyeDx, eyeDy);
  if (eyeDist < 1) return { reason: "not_frontal" };
  // 鼻尖投影到兩眼連線上的位置：0＝右眼、1＝左眼。
  const along = ((nose.x - eyeR.x) * eyeDx + (nose.y - eyeR.y) * eyeDy) / (eyeDist * eyeDist);
  if (Math.abs(along - 0.5) > opts.max_yaw_offset) return { reason: "not_frontal" };
  const eyeMid = { x: (eyeR.x + eyeL.x) / 2, y: (eyeR.y + eyeL.y) / 2 };
  const mouthMid = { x: (mouthR.x + mouthL.x) / 2, y: (mouthR.y + mouthL.y) / 2 };
  const vx = mouthMid.x - eyeMid.x;
  const vy = mouthMid.y - eyeMid.y;
  const vlen2 = vx * vx + vy * vy;
  if (vlen2 < 1) return { reason: "not_frontal" };
  const down = ((nose.x - eyeMid.x) * vx + (nose.y - eyeMid.y) * vy) / vlen2;
  if (down < opts.pitch_range[0] || down > opts.pitch_range[1]) return { reason: "not_frontal" };
  const roll = Math.abs((Math.atan2(eyeDy, eyeDx) * 180) / Math.PI);
  if (roll > opts.max_roll_deg) return { reason: "tilted" };
  const l = luma(box);
  if (l < opts.luma_range[0]) return { reason: "too_dark" };
  if (l > opts.luma_range[1]) return { reason: "too_bright" };
  return { reason: "ok", face };
}

/** 給畫面的中文說明。 */
export const QUALITY_LABEL: Record<QualityReason, string> = {
  ok: "品質合格",
  no_frame: "鏡頭沒有畫面",
  no_face: "沒有看到臉",
  multi_face: "畫面裡有多張臉",
  too_small: "臉太小，請靠近一點",
  out_of_frame: "臉超出畫面",
  low_score: "臉不夠清楚",
  not_frontal: "請把臉轉回來一點",
  tilted: "頭有點歪",
  too_dark: "太暗",
  too_bright: "太亮",
};
