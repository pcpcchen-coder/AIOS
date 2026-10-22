// 雙目鏡頭的感知事件與設定（docs/11）。影像只在本機處理；離開感知管線的只有這些事件，不含任何影像或關鍵點座標。
// 使用者要求看鏡頭畫面時，管線把縮小的畫面直接畫到本頁畫布（不寫檔、不進 trace、不外傳）。
import { parsePrefsPatch, prefDefaults, stepPref, type PrefSpecs } from "./prefs.ts";

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

/** 安裝設定：只來自 .env，核心執行期間不變（決定頁面標頭、選哪支鏡頭與幾何）。 */
export interface CameraInstall {
  /** NOUS_CAMERA；決定 Permissions-Policy／CSP，改變需要重新啟動核心。 */
  enabled: boolean;
  /** 依裝置名稱挑選鏡頭（AR0144 在 macOS 上顯示為 CCB Camera）。 */
  label: string;
  /** 併排影像左半是否為左眼；實測確認前預設 true（docs/11、ADR-0005 待驗證）。 */
  left_first: boolean;
  /** 螢幕寬度（mm），18 吋 16:9 約 398。 */
  screen_width_mm: number;
  /** 鏡頭光心到螢幕中心的垂直距離（mm，鏡頭在上緣時為正）。 */
  screen_offset_mm: number;
}

/** 使用者設定：可在「設定」畫面或用語音改，保存在 configDir/camera.json。 */
export interface CameraPrefs {
  /** 使用者要不要開鏡頭；「鏡頭關掉」保存為 false，重新連線或重新啟動都不會自己打開。 */
  active: boolean;
  /** 看著說話：面向螢幕一段時間後自動開始即時語音（免手操作）。 */
  look_to_talk: boolean;
  /** 從開始面向螢幕算起，幾秒後開始對話（使用者感受到的秒數，含面向確認）。 */
  look_to_talk_s: number;
  /** 對話結束（或自動開始）後幾秒內不再自動開始。 */
  look_to_talk_cooldown_s: number;
  /** 手掌停止播報：舉起張開的手掌停止 Nous 說話（不取消任務）。 */
  stop_gesture: boolean;
}

/** SettingsView.camera 的形狀。 */
export type CameraSettings = CameraInstall & CameraPrefs;

export type CameraPrefsPatch = Partial<CameraPrefs>;

/**
 * 唯一的使用者設定清單：預設值、伺服器驗證、設定畫面都由此推導；順序就是設定畫面的順序。
 * `satisfies` 讓型別與清單不一致時編譯失敗。
 */
export const CAMERA_PREFS = {
  active: { kind: "bool", default: true, label: "鏡頭", hint: "實際狀態看右下角指示點" },
  look_to_talk: { kind: "bool", default: true, label: "看著說話", hint: "面向螢幕後自動開始即時語音" },
  look_to_talk_s: {
    kind: "seconds", default: 1.5, min: 0.5, max: 5, step: 0.1, presets: [1, 1.5, 2, 3],
    label: "面向螢幕幾秒後開始對話", hint: "從開始面向螢幕算起；系統約每 0.2 秒檢查一次",
  },
  look_to_talk_cooldown_s: {
    kind: "seconds", default: 10, min: 3, max: 60, step: 1, presets: [5, 10, 15, 20, 30, 60],
    label: "對話結束後暫停", hint: "這段時間內不再自動開始，避免說完再見又被打開",
  },
  stop_gesture: { kind: "bool", default: true, label: "手掌停止播報", hint: "舉起張開的手掌停止 Nous 說話（不取消任務）" },
} as const satisfies PrefSpecs<CameraPrefs>;

export type CameraPrefKey = keyof CameraPrefs;

export const CAMERA_PREF_KEYS = Object.keys(CAMERA_PREFS) as CameraPrefKey[];

export const DEFAULT_CAMERA_PREFS: CameraPrefs = prefDefaults<CameraPrefs>(CAMERA_PREFS);

export class CameraPatchError extends Error {}

/**
 * 邊界驗證（HTTP body、camera.json）：只接受 CAMERA_PREFS 裡的鍵；開關必須是 boolean；
 * 秒數必須在範圍內且落在 step 上。不默默夾住數值，錯誤一律丟 CameraPatchError（→ HTTP 400）。
 */
export function parseCameraPatch(input: unknown): CameraPrefsPatch {
  return parsePrefsPatch<CameraPrefs>(CAMERA_PREFS, input, { noun: "鏡頭設定", make: (m) => new CameraPatchError(m) });
}

/** 設定畫面的 −／+：移動一格並夾在範圍內。 */
export function stepCameraPref(key: "look_to_talk_s" | "look_to_talk_cooldown_s", current: number, direction: 1 | -1): number {
  return stepPref(CAMERA_PREFS[key], current, direction);
}

/**
 * 「面向螢幕幾秒」換成 LookToTalk 的停留時間：面向本身要先由 AttentionTracker 確認（attentionOnMs），
 * 剩下的才是停留。1.5 秒、確認 300 ms → 1200 ms。
 */
export function lookToTalkDwellMs(lookToTalkS: number, attentionOnMs: number): number {
  return Math.max(0, Math.round(lookToTalkS * 1000) - attentionOnMs);
}
