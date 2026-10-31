// 雙目幾何（docs/11 §1–2）：純函式，方便測試。
// 座標系：鏡頭座標，X 向鏡頭右方（＝面對鏡頭的使用者的左方）、Y 向下、Z 朝使用者，單位 mm。
// 影像座標為單眼 1280×720 的像素；目前假設左右影像已大致對齊（未校正時以廠商規格近似）。

import type { PointZone } from "../../shared/sense.ts";

export interface StereoCalibration {
  /** 焦距（像素）；廠商規格推算約 1005（ADR-0005），校正後應改用實測值。 */
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  /** 基線（mm）。 */
  baseline_mm: number;
}

/** AR0144 雙目鏡頭的規格近似值；實測校正前使用（docs/11、this-is-yourX ADR-0005）。 */
export const AR0144_NOMINAL: StereoCalibration = { fx: 1005, fy: 1005, cx: 640, cy: 360, baseline_mm: 52 };

export interface Point2 {
  x: number;
  y: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** 最小可信視差（像素）；低於此值的深度誤差過大（4 m 處約 13 px）。 */
export const MIN_DISPARITY_PX = 8;

/** 左右眼同一個關鍵點的像素座標 → 3D（mm）。視差太小或為負時回傳 null。 */
export function triangulate(left: Point2, right: Point2, cal: StereoCalibration = AR0144_NOMINAL): Point3 | null {
  const disparity = left.x - right.x;
  if (!(disparity >= MIN_DISPARITY_PX)) return null;
  const z = (cal.fx * cal.baseline_mm) / disparity;
  return {
    x: ((left.x - cal.cx) * z) / cal.fx,
    y: ((left.y - cal.cy) * z) / cal.fy,
    z,
  };
}

/** 中位數；空陣列回傳 null。 */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface ScreenGeometry {
  /** 螢幕寬度（mm）。 */
  width_mm: number;
  /** 鏡頭光心到螢幕中心的垂直距離（mm），鏡頭在螢幕上緣時為正（螢幕在鏡頭下方）。 */
  offset_mm: number;
}

/** 手腕至少要比肩膀靠近螢幕這麼多（mm），才算舉手指向；避免垂手或交叉手臂被當成指向。 */
export const POINTING_MIN_REACH_MM = 250;

/**
 * 由肩膀與手腕的 3D 位置估計手臂指向線，與螢幕平面（Z = 0）的交點落在使用者看到的哪一區。
 * 螢幕寬度三等分；交點超出螢幕 1.5 倍範圍時回傳 null。
 * 鏡頭 +X 是使用者的左邊，所以 X 為正的一側是使用者看到的「左」。
 */
export function pointingZone(shoulder: Point3, wrist: Point3, screen: ScreenGeometry): PointZone | null {
  const dz = wrist.z - shoulder.z;
  if (-dz < POINTING_MIN_REACH_MM) return null;
  const t = -shoulder.z / dz;
  if (!(t > 0)) return null;
  const x = shoulder.x + t * (wrist.x - shoulder.x);
  const y = shoulder.y + t * (wrist.y - shoulder.y);
  const half = screen.width_mm / 2;
  const height = (screen.width_mm * 9) / 16;
  if (Math.abs(x) > half * 1.5) return null;
  if (Math.abs(y - screen.offset_mm) > (height / 2) * 1.5) return null;
  const third = screen.width_mm / 6;
  if (x > third) return "left";
  if (x < -third) return "right";
  return "center";
}

/** Pose 關鍵點（MediaPipe Pose Landmarker 的編號）。 */
export const POSE = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftWrist: 15,
  rightWrist: 16,
} as const;

export interface Landmark2 extends Point2 {
  /** 0–1，越高越可信。 */
  visibility?: number;
}

/** 頭部朝向容許範圍：鼻子偏離雙耳中點的比例。 */
export const FACING_MAX_YAW_RATIO = 0.2;
const MIN_VISIBILITY = 0.5;

/**
 * 是否面向鏡頭（鏡頭裝在螢幕上緣，面向鏡頭約等於面向螢幕）。
 * 以 Pose 關鍵點估計頭部轉向：雙耳都可見、鼻子接近雙耳中點才算。只估頭部方向，不是眼睛視線。
 */
export function isFacing(landmarks: readonly Landmark2[]): boolean {
  const nose = landmarks[POSE.nose];
  const earL = landmarks[POSE.leftEar];
  const earR = landmarks[POSE.rightEar];
  if (!nose || !earL || !earR) return false;
  if ([nose, earL, earR].some((p) => (p.visibility ?? 1) < MIN_VISIBILITY)) return false;
  const span = Math.abs(earL.x - earR.x);
  if (span < 8) return false;
  const ratio = (nose.x - (earL.x + earR.x) / 2) / span;
  return Math.abs(ratio) <= FACING_MAX_YAW_RATIO;
}

/**
 * 手腕低於肩膀多少仍算舉手：肩寬的比例。手掌擺在臉前時手腕常在肩膀略下方
 * （George 2026-10-31 Mac 實測：1 m 處手腕比肩膀低約 30 px），垂手、放在腿上則低很多。
 */
export const HAND_RAISED_SLACK = 0.25;

/** 手腕是否舉到同側肩膀附近或更高（影像 y 較小）；停止手勢需要舉手，避免垂手時的誤觸。 */
export function handRaised(landmarks: readonly Landmark2[], side: "left" | "right"): boolean {
  const wrist = landmarks[side === "left" ? POSE.leftWrist : POSE.rightWrist];
  const shoulder = landmarks[side === "left" ? POSE.leftShoulder : POSE.rightShoulder];
  const other = landmarks[side === "left" ? POSE.rightShoulder : POSE.leftShoulder];
  if (!wrist || !shoulder) return false;
  if ((wrist.visibility ?? 1) < MIN_VISIBILITY || (shoulder.visibility ?? 1) < MIN_VISIBILITY) return false;
  const slack = other && (other.visibility ?? 1) >= MIN_VISIBILITY ? HAND_RAISED_SLACK * Math.abs(shoulder.x - other.x) : 0;
  return wrist.y < shoulder.y + slack;
}
