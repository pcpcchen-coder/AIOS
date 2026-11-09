// ALARM-1（George 2026-11-09）：定時器與響鈴的共用契約（核心與頁面都讀）。純資料與純函式，不碰時鐘、檔案或 DOM。
// 排程、保存與響鈴的真相都在核心（server/alarms.ts）；頁面只依 AlarmsView 畫倒數、出聲與顯示停止。
// George 的預設（較溫和）：只在建立的那台裝置響（那台不在線時全部響）、30 秒漸強、響 5 分鐘沒人理自動停並記錄；
// 通話中不掛斷，只把 Nous 的聲音靜音。錯過 30 分鐘內補響並說晚了多久，超過只記錄「錯過」。

export const TIMER_MIN_S = 1;
export const TIMER_MAX_S = 24 * 3600;
/** 同時存在的定時器上限（含暫停的）。 */
export const MAX_TIMERS = 10;
/** ALARM-2：鬧鐘數上限。 */
export const MAX_ALARMS = 20;
/** ALARM-2：多久之內有鬧鐘就算「快到了」（右下角按需顯示；Mac App 阻止閒置睡眠）。 */
export const ALARM_SOON_MS = 60 * 60_000;
export const ALARM_AWAKE_MS = 12 * 3600_000;
export const LABEL_MAX = 40;
/** 響鈴紀錄保留幾筆。 */
export const RING_LOG_MAX = 50;
/** 排程最長隔多久重新檢查一次：Mac 睡眠後 setTimeout 會晚到，醒來後最多這麼久就會發現錯過的響鈴。 */
export const SCHEDULER_MAX_SLEEP_MS = 30_000;

export const ALARM_WRITE_PATH = "/api/settings/alarms";

export interface AlarmPrefs {
  /** 關閉＝不提供工具、不排程、不響（已建立的資料保留，可另外清除）。 */
  enabled: boolean;
  /** 響多久沒人理就自動停（秒）。 */
  ring_s: number;
  /** 從小聲漸強到設定音量的時間（秒）。 */
  ramp_s: number;
  /** 晚了多久以內仍補響（秒）；超過只記錄錯過。 */
  late_ring_max_s: number;
  /** ALARM-2：貪睡多久（秒）。 */
  snooze_s: number;
  /** ALARM-2：鬧鐘的最低音量（%）：對話音量比這個小時用這個（定時器不套用）。 */
  alarm_min_volume: number;
}

export const DEFAULT_ALARM_PREFS: AlarmPrefs = { enabled: true, ring_s: 300, ramp_s: 30, late_ring_max_s: 1800, snooze_s: 540, alarm_min_volume: 30 };

export const ALARM_PREF_RANGES = {
  ring_s: { min: 30, max: 1800 },
  ramp_s: { min: 0, max: 120 },
  late_ring_max_s: { min: 0, max: 6 * 3600 },
  snooze_s: { min: 60, max: 1800 },
  alarm_min_volume: { min: 0, max: 100 },
} as const;

export class AlarmPatchError extends Error {}

export type AlarmPrefsPatch = Partial<AlarmPrefs>;

/** 外來的 patch（HTTP、保存檔的單一鍵）：不認得或範圍外的鍵丟錯。 */
export function parseAlarmPrefsPatch(input: unknown): AlarmPrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AlarmPatchError("設定必須是物件");
  const out: AlarmPrefsPatch = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "enabled") {
      if (typeof value !== "boolean") throw new AlarmPatchError("enabled 必須是 true 或 false");
      out.enabled = value;
    } else if (key === "ring_s" || key === "ramp_s" || key === "late_ring_max_s" || key === "snooze_s" || key === "alarm_min_volume") {
      const range = ALARM_PREF_RANGES[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) throw new AlarmPatchError(`${key} 必須是 ${range.min}–${range.max} 的整數`);
      out[key] = value;
    } else throw new AlarmPatchError(`不認得的設定：${key}`);
  }
  return out;
}

// ---- 定時器 ----

interface TimerBase {
  id: string;
  /** 使用者取的名字（「泡麵」）；沒取是 null。 */
  label: string | null;
  /** 原本設定的總長（延長後會加上去）。 */
  duration_ms: number;
  created_at: number;
  /** 建立這個定時器的頁面（"main"＝Mac 主視窗，或終端機識別碼）；不知道時 null。 */
  origin: string | null;
}

/** 執行中：到 ends_at 響；暫停：保留剩下的時間。用 state 分開，兩種狀態不會同時有 ends_at 與 remaining_ms。 */
export type TimerRecord =
  | (TimerBase & { state: "running"; ends_at: number })
  | (TimerBase & { state: "paused"; remaining_ms: number });

export const RING_KINDS = ["timer", "alarm"] as const;
export type RingKind = (typeof RING_KINDS)[number];

/** ALARM-2：鬧鐘。時間是牆上時鐘（本機時區）；next_at 是核心算好的下一次（epoch），關掉或單次已響過是 null。 */
export interface AlarmRecord {
  id: string;
  label: string | null;
  hour: number;
  minute: number;
  /** 重複的星期幾（0＝星期日）；空的＝單次。 */
  days: number[];
  /** 單次的當地日期（YYYY-MM-DD）。 */
  date: string | null;
  enabled: boolean;
  next_at: number | null;
  created_at: number;
  origin: string | null;
}

/** ALARM-2：貪睡中（due_at 再響）。 */
export interface SnoozeRecord {
  id: string;
  alarm_id: string | null;
  label: string | null;
  due_at: number;
  origin: string | null;
}

/** 正在響的鈴。targets：要在哪些頁面響（"all"＝每個畫面）。 */
export interface RingRecord {
  id: string;
  kind: RingKind;
  /** ALARM-2：鬧鐘（或它的貪睡）響的是哪一個鬧鐘；定時器是 null。 */
  alarm_id?: string | null;
  label: string | null;
  /** 本來應該響的時間。 */
  due_at: number;
  started_at: number;
  /** 晚了多久才響（Mac 睡眠、核心沒在跑）；準時是 0。 */
  late_ms: number;
  targets: string[] | "all";
  /** 回報「真的在出聲」的頁面（只用來照實記錄與顯示，不影響排程）。 */
  heard_by: string[];
}

export const RING_OUTCOMES = ["stopped", "auto_stopped", "missed", "cancelled", "snoozed"] as const;
export type RingOutcome = (typeof RING_OUTCOMES)[number];
export const STOP_SOURCES = ["button", "gesture", "voice", "typed", "key", "tool", "settings"] as const;
export type StopSource = (typeof STOP_SOURCES)[number];

export interface RingLogEntry {
  at: number;
  kind: RingKind;
  label: string | null;
  due_at: number;
  outcome: RingOutcome;
  late_ms: number;
  /** 停止的方式（outcome 是 stopped 時）。 */
  by?: StopSource;
  /** 有沒有頁面回報真的出聲。 */
  heard: boolean;
}

// ---- 頁面看到的（settings.alarms） ----

export interface TimerView {
  id: string;
  label: string | null;
  state: "running" | "paused";
  duration_ms: number;
  /** 執行中才有（核心時間）。 */
  ends_at: number | null;
  /** 暫停中才有。 */
  remaining_ms: number | null;
}

export interface AlarmView {
  id: string;
  label: string | null;
  /** 「07:00」。 */
  time: string;
  days: number[];
  date: string | null;
  enabled: boolean;
  next_at: number | null;
}

export interface SnoozeView {
  id: string;
  label: string | null;
  due_at: number;
}

export interface RingView {
  id: string;
  kind: RingKind;
  label: string | null;
  due_at: number;
  started_at: number;
  late_ms: number;
  /** 這個頁面要不要出聲。 */
  here: boolean;
  auto_stop_at: number;
  heard_by: string[];
}

export interface AlarmsView {
  prefs: AlarmPrefs;
  /** 核心產生這份資料的時間：頁面用它校正自己的時鐘（Pi 的時鐘可能和 Mac 不同）。 */
  server_now: number;
  timers: TimerView[];
  /** ALARM-2。 */
  alarms: AlarmView[];
  snoozes: SnoozeView[];
  rings: RingView[];
  /** ALARM-2：算鬧鐘用的時區（核心的系統時區）。 */
  time_zone: string;
  /** 最近一次自動停止或錯過（頁面按需顯示「錯過了」；使用者看到後可清掉）。 */
  notice: RingLogEntry | null;
  write_path: typeof ALARM_WRITE_PATH;
}

export function timerRemainingMs(timer: TimerView | TimerRecord, now: number): number {
  if (timer.state === "paused") return Math.max(0, ("remaining_ms" in timer ? timer.remaining_ms : 0) ?? 0);
  return Math.max(0, (timer.ends_at ?? now) - now);
}

/** 倒數顯示：一小時以上 h:mm:ss，否則 m:ss。剩下不到 1 秒仍顯示 0:01（避免看起來已經到了卻還沒響）。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 給模型與口語用的長度（「3 分鐘」「1 小時 5 分鐘」「45 秒」）。 */
export function spokenDuration(ms: number, locale: "zh-TW" | "en" = "zh-TW"): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (locale === "en") {
    const parts = [h ? `${h} hour${h > 1 ? "s" : ""}` : "", m ? `${m} minute${m > 1 ? "s" : ""}` : "", s && !h ? `${s} second${s > 1 ? "s" : ""}` : ""].filter(Boolean);
    return parts.join(" ") || "0 seconds";
  }
  const parts = [h ? `${h} 小時` : "", m ? `${m} 分鐘` : "", s && !h ? `${s} 秒` : ""].filter(Boolean);
  return parts.join(" ") || "0 秒";
}

/** 名字：去頭尾空白、壓掉控制字元與換行、截到上限；空的回 null。 */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return text || null;
}

/** ALARM-2：鬧鐘響時的本機貪睡語（整句）。 */
const RING_SNOOZE = /^(?:貪睡|再睡一下|再睡(?:\d+|[一二三四五六七八九十]+)?分鐘?|再五分鐘|等一下再叫我?|晚點再叫我?|snooze|fiveminutesmore|later)(?:了|吧|啦|喔)?$/i;

export function matchRingSnooze(text: string): boolean {
  const t = text.trim().replace(/[\s，。！？、,.!?~～]+/g, "").replace(/^(?:nous|努斯|諾斯)/i, "");
  return !!t && t.length <= 16 && RING_SNOOZE.test(t);
}

/**
 * 響鈴時的本機停止語（不經模型）：整句就是停止的意思才算，避免一般對話裡提到「停」就關掉。
 * 打字、即時語音逐字稿都用這個；鈴沒在響時不比對。
 */
const RING_STOP = /^(?:好了?|好的|知道了|收到|停|停止|停下來?|關掉|關閉|關了|別響了|不要響了|安靜|閉嘴|夠了|起來了|我起來了|我醒了|醒了|stop|ok|okay|enough|quiet|silence|i'?mup|turnitoff|turnoff|shutup)(?:鈴聲|鬧鐘|鬧鈴|定時器|計時器|計時|it)?(?:了|吧|啦|喔|哦|囉)?$/i;

export function matchRingStop(text: string): boolean {
  const t = text.trim().replace(/[\s，。！？、,.!?~～]+/g, "").replace(/^(?:nous|努斯|諾斯)/i, "");
  if (!t || t.length > 16) return false;
  return RING_STOP.test(t) || /^(?:停止|關掉|關閉)(?:鈴聲|鬧鐘|鬧鈴|定時器|計時器)$/.test(t);
}

/** 響鈴的音量（0–1）：定時器跟這台裝置現在的對話音量（日／夜間）。minPercent 留給 ALARM-2 的鬧鐘最低音量。 */
export function ringPeakVolume(voicePercent: number, minPercent = 0): number {
  const v = Math.max(minPercent, Math.min(100, Math.max(10, Number.isFinite(voicePercent) ? voicePercent : 100)));
  return v / 100;
}

/** 漸強：從 ringRampStart 倍開始，ramp_s 內升到滿；ramp_s 為 0 時直接滿音量。 */
export const RING_RAMP_START = 0.15;

export function ringGainAt(elapsedMs: number, rampS: number, peak: number): number {
  if (rampS <= 0) return peak;
  const f = Math.min(1, Math.max(0, elapsedMs / (rampS * 1000)));
  return peak * (RING_RAMP_START + (1 - RING_RAMP_START) * f);
}
