// 常駐喚醒聆聽（docs/17 §5、ADR-0003；WK-01a）的共用型別、狀態、原因碼、偏好驗證與介面文字。
// 狀態以裝置事件為準（17 §5.1）：只有來源 track 為 live 而且 AudioWorklet 回報開始處理之後才是 listening_local。
// 這個檔案只有型別、常數與純函式；音訊程式在 src/audio/（NOUS_WAKE=on 才以動態 import 載入）。
// 介面文字以繁中為原文，英文在 shared/messages.en.json（共用翻譯表）。

export const WAKE_STATES = ["off", "armed", "listening_local", "paused", "in_call", "released", "error"] as const;
export type WakeState = (typeof WAKE_STATES)[number];

export const WAKE_REASONS = [
  "pref_off",
  "starting",
  "auto_resume",
  "user_pause",
  "sleep",
  "lock",
  "realtime",
  "web_speech",
  "permission_denied",
  "device_missing",
  "device_ended",
  "runtime_missing",
  "runtime_load_failed",
  "audio_failed",
  "unsupported",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

/** 每個狀態允許的原因碼（reportState 的白名單；preload.cjs 有同一份，tests/audio-privacy.test.ts 核對兩者相同）。 */
export const WAKE_STATE_REASONS: { readonly [S in WakeState]: readonly (WakeReason | null)[] } = {
  off: [null, "pref_off"],
  armed: ["starting", "auto_resume"],
  listening_local: [null],
  paused: ["user_pause", "sleep", "lock"],
  in_call: ["realtime"],
  released: ["web_speech"],
  error: ["permission_denied", "device_missing", "device_ended", "runtime_missing", "runtime_load_failed", "audio_failed", "unsupported"],
};

export type WakeErrorReason = "permission_denied" | "device_missing" | "device_ended" | "runtime_missing" | "runtime_load_failed" | "audio_failed" | "unsupported";

/** 回報給 App 選單列的喚醒狀態（只有列舉值）。 */
export interface WakeReport {
  state: WakeState;
  reason: WakeReason | null;
}

export function isWakeReport(value: unknown): value is WakeReport {
  if (!value || typeof value !== "object") return false;
  const { state, reason } = value as Record<string, unknown>;
  if (typeof state !== "string" || !(WAKE_STATES as readonly string[]).includes(state)) return false;
  return (WAKE_STATE_REASONS[state as WakeState] as readonly unknown[]).includes(reason ?? null);
}

// ───────────── 偏好（configDir/wake.json；server/wake-settings.ts 是唯一寫入者） ─────────────

export interface WakePrefs {
  /** 「常駐喚醒聆聽」開關；預設關閉，讀不懂時也是關閉（fail closed）。 */
  wake_listen: boolean;
  /** 上一次真的進入 listening_local 的麥克風 deviceId；自動恢復時以 exact 指定，找不到就 error device_missing。 */
  device_id: string | null;
}
export type WakePrefsPatch = Partial<WakePrefs>;

export const DEFAULT_WAKE_PREFS: WakePrefs = { wake_listen: false, device_id: null };
export const WAKE_PREF_KEYS = ["wake_listen", "device_id"] as const satisfies readonly (keyof WakePrefs)[];

export class WakePatchError extends Error {}

/** deviceId 是瀏覽器給的不透明字串；只接受可見 ASCII、最多 256 字元。 */
const DEVICE_ID = /^[\x21-\x7e]{1,256}$/;

/** 邊界驗證：只接受 wake_listen（布林）與 device_id（字串或 null）；其他鍵、空 patch、型別不符一律丟錯。 */
export function parseWakePatch(input: unknown): WakePrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WakePatchError("喚醒設定必須是 JSON 物件");
  const patch: WakePrefsPatch = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "wake_listen") {
      if (typeof value !== "boolean") throw new WakePatchError("wake_listen 必須是 true 或 false");
      patch.wake_listen = value;
    } else if (key === "device_id") {
      if (value !== null && (typeof value !== "string" || !DEVICE_ID.test(value))) throw new WakePatchError("device_id 格式不正確");
      patch.device_id = value;
    } else {
      throw new WakePatchError(`不認得的喚醒設定：${key}`);
    }
  }
  if (Object.keys(patch).length === 0) throw new WakePatchError("喚醒設定沒有任何欄位");
  return patch;
}

/** 喚醒引擎檔案（shared/wake-runtime.json）的核對結果；WK-01a 清單是空的，所以一律是 missing。 */
export type WakeRuntimeState = "ok" | "missing" | "hash_mismatch" | "not_configured";

/** SettingsView.wake：只有 NOUS_WAKE=on 時才有這個欄位（關閉時 /api/settings 與之前逐位元組相同）。 */
export interface WakeSettingsView extends WakePrefs {
  runtime: WakeRuntimeState;
}

// ───────────── 喚醒觸發（WK-01 的終點，WK-02 接上 startRealtime("wake_word")） ─────────────

export interface WakeTrigger {
  /** 這次喚醒的識別碼（頁面產生；核心不能拿它當成喚醒真的發生的證據，ADR-0003 §2.2）。 */
  wake_id: string;
  /** 偵測到的時間（頁面時鐘，毫秒）。 */
  detected_at: number;
  /** 關鍵詞清單中的編號（不是文字、不含音訊）。 */
  keyword_index: number;
}

// ───────────── worker 協定：worker 只送出事件，不送出任何樣本（started／detected／load_error／closed） ─────────────

export type WakeWorkerOut =
  | { type: "started" }
  /** worker 已清空環形緩衝並釋放偵測器（收到 close 之後），主執行緒等到它才 terminate。 */
  | { type: "closed" }
  | { type: "detected"; keyword_index: number }
  | { type: "load_error"; reason: "runtime_missing" | "runtime_load_failed" };

/**
 * worker 送出訊息的完整檢查：只接受上面三種形狀，欄位只能是字串或整數，不能有型別陣列、ArrayBuffer、陣列或多餘欄位。
 * 主執行緒收到不符的訊息一律丟掉（tests/audio-privacy.test.ts 另外靜態檢查 worker 的 postMessage）。
 */
export function isWakeWorkerOut(value: unknown): value is WakeWorkerOut {
  if (!value || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (o.type === "started" || o.type === "closed") return keys === "type";
  if (o.type === "detected") return keys === "keyword_index,type" && Number.isInteger(o.keyword_index) && (o.keyword_index as number) >= 0 && (o.keyword_index as number) < 64;
  if (o.type === "load_error") return keys === "reason,type" && (o.reason === "runtime_missing" || o.reason === "runtime_load_failed");
  return false;
}

// ───────────── 介面文字（共用翻譯表） ─────────────

export const WAKE_WORD_TEXT = "哈囉努斯";

export const WAKE_STATE_LABEL: { readonly [S in WakeState]: string } = {
  off: "未開啟",
  armed: "準備中",
  listening_local: "本機聆聽中",
  paused: "已暫停",
  in_call: "通話中",
  released: "已讓出麥克風",
  error: "無法使用",
};

export const WAKE_REASON_LABEL: { readonly [R in WakeReason]: string } = {
  pref_off: "常駐喚醒聆聽已關閉",
  starting: "正在取得麥克風",
  auto_resume: "正在自動恢復",
  user_pause: "暫停到這次結束；App 重開後會自動恢復，要長期停止請關掉開關",
  sleep: "系統睡眠中",
  lock: "螢幕已鎖定",
  realtime: "即時語音使用中，喚醒偵測暫停",
  web_speech: "按下說話或語音模式使用中，喚醒偵測暫停",
  permission_denied: "麥克風權限被拒，常駐聆聽沒有開啟",
  device_missing: "找不到上次使用的麥克風",
  device_ended: "麥克風已拔除或停止，沒有改用其他麥克風",
  runtime_missing: "喚醒引擎尚未安裝，沒有開啟麥克風",
  runtime_load_failed: "喚醒引擎載入失敗，已停止收音",
  audio_failed: "無法開始本機收音",
  unsupported: "這個環境不支援本機收音",
};

/** 選單列與畫面上的固定文字。 */
export const WAKE_TEXT = {
  group: "喚醒詞",
  statusPrefix: "喚醒聆聽",
  listen: "常駐喚醒聆聽",
  listenNote: "只在這台 Mac 本機偵測「哈囉努斯」",
  pause: "暫停聆聽（到這次結束）",
  resume: "繼續聆聽",
  speaker: "通話中辨認說話者",
  speakerNote: "SP-02 之後才能使用",
  heard: "聽到了",
  resumed: "已恢復常駐喚醒聆聽（只在本機偵測「哈囉努斯」）",
  failed: "常駐喚醒聆聽沒有開啟：{0}",
  stopped: "常駐喚醒聆聽已停止：{0}",
  notReported: "尚未回報",
  indicator: "本機聆聽喚醒詞中",
  dialogMessage: "要開啟常駐喚醒聆聽嗎？",
  dialogDetail:
    "開啟後麥克風會常駐開著，只在這台 Mac 本機偵測「哈囉努斯」。沒有喚醒時的聲音只留在記憶體中約 2 秒，不寫檔、不進紀錄、不上傳。App 重開與睡眠回來後會自動恢復，直到你關掉這個開關；「暫停聆聽」只到這次結束。",
  dialogRuntimeMissing: "目前還沒有安裝喚醒引擎：開啟後會顯示「無法使用」，不會開啟麥克風。",
  dialogEnable: "開啟",
  dialogCancel: "取消",
  notSaved: "常駐喚醒聆聽沒有保存",
} as const;
