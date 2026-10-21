// 每一幀的偵測結果 → 感知事件。純邏輯：不碰鏡頭、影像或 MediaPipe，測試時直接餵關鍵點。
// 輸出只有 SenseEvent（docs/11 §4），不含影像或座標。

import type { PointZone, SenseEvent } from "../../shared/sense.ts";
import {
  AR0144_NOMINAL,
  handRaised,
  isFacing,
  median,
  pointingZone,
  POSE,
  triangulate,
  type Landmark2,
  type Point3,
  type ScreenGeometry,
  type StereoCalibration,
} from "./geometry.ts";
import { AttentionTracker, PresenceTracker, StopGestureDetector, ZoneStabilizer } from "./trackers.ts";

export interface FrameDetections {
  /** 毫秒時間戳。 */
  t: number;
  /** 左眼影像的 Pose 關鍵點（單眼像素座標）；沒有偵測到人時為 null。 */
  left: Landmark2[] | null;
  /** 右眼影像的 Pose 關鍵點；用於三角化。 */
  right: Landmark2[] | null;
  /** 手勢辨識器判定的張開手掌分數（左眼影像，取最高的一隻手）；沒有時為 null。 */
  openPalm: number | null;
}

export const OPEN_PALM_MIN_SCORE = 0.7;
const MIN_VISIBILITY = 0.5;

export class SenseProcessor {
  private presence = new PresenceTracker();
  private attention = new AttentionTracker();
  private stop = new StopGestureDetector();
  private zone = new ZoneStabilizer();
  private present = false;

  constructor(
    private readonly screen: ScreenGeometry,
    private readonly cal: StereoCalibration = AR0144_NOMINAL,
  ) {}

  process(frame: FrameDetections): SenseEvent[] {
    const events: SenseEvent[] = [];
    const { t, left, right } = frame;
    const detected = !!left && (visible(left, POSE.nose) || (visible(left, POSE.leftShoulder) && visible(left, POSE.rightShoulder)));
    const point = (i: number): Point3 | null =>
      left && right && visible(left, i) && visible(right, i) ? triangulate(left[i], right[i], this.cal) : null;

    // 在場與距離：鼻子與雙肩的深度中位數。
    const depths = [POSE.nose, POSE.leftShoulder, POSE.rightShoulder]
      .map(point)
      .filter((p): p is Point3 => p !== null)
      .map((p) => p.z);
    const presence = this.presence.update(t, detected, median(depths));
    if (presence) {
      this.present = presence.present;
      events.push({ type: "presence", ...presence });
    }

    // 是否面向螢幕（只在有人時判斷；離開時視為未面向）。
    const facing = this.attention.update(t, this.present && !!left && isFacing(left));
    if (facing !== null) events.push({ type: "attention", facing });

    // 停止手勢：張開手掌＋至少一隻手腕高於同側肩膀。
    // 不依賴手勢辨識器的左右手標籤（它假設鏡像畫面，和 Pose 的身體左右相反）。
    const palm = frame.openPalm;
    const candidate =
      this.present && !!left && palm !== null && palm >= OPEN_PALM_MIN_SCORE && (handRaised(left, "left") || handRaised(left, "right"));
    if (this.stop.update(t, candidate)) events.push({ type: "gesture", kind: "stop" });

    // 手臂指向：取伸得比較遠的那隻手。
    const zone = this.present ? this.pointing(point) : null;
    const changed = this.zone.update(t, zone);
    if (changed !== undefined) events.push({ type: "pointing", zone: changed });

    return events;
  }

  private pointing(point: (i: number) => Point3 | null): PointZone | null {
    const arms = [
      { shoulder: point(POSE.leftShoulder), wrist: point(POSE.leftWrist) },
      { shoulder: point(POSE.rightShoulder), wrist: point(POSE.rightWrist) },
    ]
      .filter((a): a is { shoulder: Point3; wrist: Point3 } => !!a.shoulder && !!a.wrist)
      .sort((a, b) => (a.wrist.z - a.shoulder.z) - (b.wrist.z - b.shoulder.z));
    for (const arm of arms) {
      const zone = pointingZone(arm.shoulder, arm.wrist, this.screen);
      if (zone) return zone;
    }
    return null;
  }
}

function visible(landmarks: readonly Landmark2[], index: number): boolean {
  const p = landmarks[index];
  return !!p && (p.visibility ?? 1) >= MIN_VISIBILITY;
}
