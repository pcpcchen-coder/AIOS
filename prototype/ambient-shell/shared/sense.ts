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
  /**
   * 看著說話時先打招呼（George 2026-10-23）：看著說話開始的即時語音，連線完成後 Nous 先說一句招呼（每次對話最多一次）。
   * 按鈕、語音指令或打字開始的不打招呼；使用者先開口就不打。
   */
  look_to_talk_greet: boolean;
  /** 手掌停止播報：舉起張開的手掌停止 Nous 說話（不取消任務）。 */
  stop_gesture: boolean;
  /**
   * 靠近時電子腦的最大放大倍率（George 2026-10-23）：站在 BRAIN_ZOOM_NEAR_M 以內時電子腦放大到這個倍率，
   * BRAIN_ZOOM_FAR_M 以外是 1 倍（src/sense/controller.ts brainZoom）。1 = 不放大。字級不受影響（仍是 D ÷ 2 m）。
   */
  brain_zoom_max: number;
}

/**
 * 看著說話開始的即時語音連上後，請模型說的那一句招呼（兩條路徑共用）。只知道使用者面向螢幕：
 * 不得說看到使用者、不得描述長相或環境（CLAUDE.md：沒有影像分析時不得宣稱正在觀看）。
 */
export const LOOK_TO_TALK_GREETING =
  "你是 Nous。使用者剛面向螢幕開始語音對話：請用一句簡短自然的繁體中文打招呼，問有什麼需要幫忙（例如「我在，有什麼需要幫忙的嗎？」）。" +
  "你只知道使用者面向螢幕，看不到畫面：不要說看到使用者，也不要提到長相、表情、穿著或周遭環境。";

/**
 * ChatGPT 方案路徑的招呼要放進 session.context.append speakable：前面加這個固定標記，
 * 語音層說明（server/realtime.ts buildLiveInstructions）才知道這段只是開場指示、不要念出來。
 */
export const GREETING_MARKER = "（開場）";

/** ChatGPT 方案路徑真正送給模型的招呼（核心只送這個常數，忽略頁面送來的文字）。 */
export const LIVE_GREETING_TEXT = `${GREETING_MARKER}${LOOK_TO_TALK_GREETING}`;

/** SettingsView.camera 的形狀。 */
export type CameraSettings = CameraInstall & CameraPrefs;

export type CameraPrefsPatch = Partial<CameraPrefs>;

/**
 * 電子腦靠近放大的距離端點（公尺）：FAR 以外 1 倍，NEAR 以內到使用者設定的最大倍率，中間依距離線性內插
 * （src/sense/controller.ts brainZoom）。PresenceTracker 只回報 0.5–4 m，NEAR 取 0.6 m 讓最大倍率實際到得了。
 */
export const BRAIN_ZOOM_NEAR_M = 0.6;
export const BRAIN_ZOOM_FAR_M = 2.5;

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
  look_to_talk_greet: {
    kind: "bool", default: true, label: "看著說話時先打招呼",
    hint: "看著說話開始的對話，連上後 Nous 先問一句有什麼需要幫忙；你先開口就不打招呼",
  },
  stop_gesture: { kind: "bool", default: true, label: "手掌停止播報", hint: "舉起張開的手掌停止 Nous 說話（不取消任務）" },
  brain_zoom_max: {
    kind: "factor", default: 2, min: 1, max: 3, step: 0.1, presets: [1, 1.5, 2, 2.5, 3],
    label: "靠近時電子腦放大倍率",
    hint: `站到 ${BRAIN_ZOOM_NEAR_M} m 以內放大到這個倍率，${BRAIN_ZOOM_FAR_M} m 以外不放大；1 倍＝不放大，字級不受影響`,
  },
} as const satisfies PrefSpecs<CameraPrefs>;

export type CameraPrefKey = keyof CameraPrefs;

/** 數值（秒數或倍率）的鏡頭設定鍵。 */
export type CameraNumberKey = { [K in CameraPrefKey]: CameraPrefs[K] extends number ? K : never }[CameraPrefKey];

export const CAMERA_PREF_KEYS = Object.keys(CAMERA_PREFS) as CameraPrefKey[];

export const DEFAULT_CAMERA_PREFS: CameraPrefs = prefDefaults<CameraPrefs>(CAMERA_PREFS);

export class CameraPatchError extends Error {}

/**
 * 邊界驗證（HTTP body、camera.json）：只接受 CAMERA_PREFS 裡的鍵；開關必須是 boolean；
 * 秒數與倍率必須在範圍內且落在 step 上。不默默夾住數值，錯誤一律丟 CameraPatchError（→ HTTP 400）。
 */
export function parseCameraPatch(input: unknown): CameraPrefsPatch {
  return parsePrefsPatch<CameraPrefs>(CAMERA_PREFS, input, { noun: "鏡頭設定", make: (m) => new CameraPatchError(m) });
}

/** 設定畫面的 −／+：移動一格並夾在範圍內。 */
export function stepCameraPref(key: CameraNumberKey, current: number, direction: 1 | -1): number {
  return stepPref(CAMERA_PREFS[key], current, direction);
}

/**
 * 「面向螢幕幾秒」換成 LookToTalk 的停留時間：面向本身要先由 AttentionTracker 確認（attentionOnMs），
 * 剩下的才是停留。1.5 秒、確認 300 ms → 1200 ms。
 */
export function lookToTalkDwellMs(lookToTalkS: number, attentionOnMs: number): number {
  return Math.max(0, Math.round(lookToTalkS * 1000) - attentionOnMs);
}
