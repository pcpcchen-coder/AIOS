// 雙目鏡頭的感知事件（docs/11）。影像只在本機處理；離開感知管線的只有這些事件，不含任何影像或關鍵點座標。

export type PointZone = "left" | "center" | "right";

export type SensorState = "off" | "starting" | "ok" | "degraded" | "error";

export type SenseEvent =
  /** 螢幕前有沒有人，以及實測距離（公尺，取中位數平滑）。 */
  | { type: "presence"; present: boolean; distance_m: number | null }
  /** 是否面向螢幕（以頭部方向估計，不是眼睛視線）。 */
  | { type: "attention"; facing: boolean }
  /** 停止手勢：舉起張開的手掌朝向螢幕。 */
  | { type: "gesture"; kind: "stop" }
  /** 手臂指向的螢幕區塊（使用者看到的左／中／右）；null 表示沒有穩定指向。 */
  | { type: "pointing"; zone: PointZone | null }
  /** 鏡頭狀態；detail 為可直接顯示的說明。 */
  | { type: "sensor"; state: SensorState; detail: string };

/** 鏡頭與螢幕的安裝設定（由 .env 提供給前端）。 */
export interface CameraSettings {
  enabled: boolean;
  /** 依裝置名稱挑選鏡頭（AR0144 在 macOS 上顯示為 CCB Camera）。 */
  label: string;
  /** 併排影像左半是否為左眼；實測確認前預設 true（docs/11、ADR-0005 待驗證）。 */
  left_first: boolean;
  /** 有人面向螢幕一段時間後自動開始即時語音（免手操作）。 */
  look_to_talk: boolean;
  /** 螢幕寬度（mm），18 吋 16:9 約 398。 */
  screen_width_mm: number;
  /** 鏡頭光心到螢幕中心的垂直距離（mm，鏡頭在上緣時為正）。 */
  screen_offset_mm: number;
}
