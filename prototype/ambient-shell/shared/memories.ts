// MEMO-1（George 2026-11-06）：回憶模式。電子腦閒置一段時間後，照片與影片從電子腦浮現、輪流播放；
// 一有事（喚醒、看著說話、通話、交辦、對話、打開畫面）立即收起。
// 這裡只有型別、固定選項、純函式與頁面的狀態機（核心、頁面與測試共用）：沒有檔案路徑或網址來源。
// 照片只在本機核心與頁面之間傳遞：不送模型、不寫 log、不點亮腦區（照片不是視覺處理）。

import type { Locale } from "./i18n.mjs";

// ───────────── 設定（configDir/memories.json） ─────────────

export const DWELL_OPTIONS_S = [5, 8, 12, 20] as const;
export const IDLE_OPTIONS_S = [30, 60, 180, 300] as const;

export interface MemoriesPrefs {
  enabled: boolean;
  /** 每張照片停留秒數（影片播到結束或 MEMORIES_TIMING.videoMaxMs）。 */
  dwell_s: (typeof DWELL_OPTIONS_S)[number];
  /** 電子腦閒置多久才開始。 */
  idle_s: (typeof IDLE_OPTIONS_S)[number];
  /** 影片播放聲音（預設靜音）。 */
  video_sound: boolean;
}

export type MemoriesPrefsPatch = Partial<MemoriesPrefs>;

export const DEFAULT_MEMORIES_PREFS: MemoriesPrefs = { enabled: false, dwell_s: 8, idle_s: 60, video_sound: false };
export const MEMORIES_PREF_KEYS = Object.keys(DEFAULT_MEMORIES_PREFS) as (keyof MemoriesPrefs)[];
export const MEMORIES_WRITE_PATH = "/api/settings/memories";
export const MEMORIES_ITEMS_PATH = "/api/memories/items";
export const MEMORIES_MEDIA_PREFIX = "/api/memories/media/";
/** MEMO-2 的雲端相簿快取上限（2 GiB）；MEMO-1 的本機資料夾不複製檔案，不用到。 */
export const MEMORIES_CACHE_CAP_BYTES = 2 * 1024 ** 3;
/** 項目識別碼：不透明的十六進位字串（不含路徑）。 */
export const MEMORIES_ID = /^[a-f0-9]{16,64}$/;

export class MemoriesPatchError extends Error {}

/** 邊界驗證（HTTP body、memories.json 的每一個鍵）：不認得的鍵、型別或選項不對一律丟 MemoriesPatchError（→ HTTP 400）。 */
export function parseMemoriesPatch(input: unknown): MemoriesPrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MemoriesPatchError("回憶模式設定必須是 JSON 物件");
  const patch: MemoriesPrefsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "enabled" || key === "video_sound") {
      if (typeof value !== "boolean") throw new MemoriesPatchError(`${key} 必須是 true 或 false`);
      patch[key] = value;
    } else if (key === "dwell_s") {
      if (!(DWELL_OPTIONS_S as readonly unknown[]).includes(value)) throw new MemoriesPatchError(`dwell_s 必須是 ${DWELL_OPTIONS_S.join("、")} 其中之一`);
      patch.dwell_s = value as MemoriesPrefs["dwell_s"];
    } else if (key === "idle_s") {
      if (!(IDLE_OPTIONS_S as readonly unknown[]).includes(value)) throw new MemoriesPatchError(`idle_s 必須是 ${IDLE_OPTIONS_S.join("、")} 其中之一`);
      patch.idle_s = value as MemoriesPrefs["idle_s"];
    } else {
      throw new MemoriesPatchError(`未知的回憶模式設定：${key}`);
    }
  }
  return patch;
}

// ───────────── 來源與項目 ─────────────

export type MemoriesKind = "photo" | "video";

/** 城市名稱（核心依座標從固定清單找最近的；座標不離開核心）。 */
export interface MemoriesPlace {
  zh: string;
  en: string;
}

export interface MemoriesItem {
  id: string;
  kind: MemoriesKind;
  /** MEMORIES_MEDIA_PREFIX + id */
  url: string;
  /** 拍攝時間（epoch ms；照片 EXIF、影片 mvhd）；沒有就是 null。 */
  taken_at: number | null;
  /** 拍攝地點（25 km 內最近的城市）；沒有 GPS 或太遠就是 null。MEMO-2 的雲端相簿沒有地點。 */
  place: MemoriesPlace | null;
}

/** ok：有照片或影片；empty：資料夾是空的；missing：找不到資料夾；failed：讀資料夾失敗。 */
export type MemoriesSourceState = "ok" | "empty" | "missing" | "failed";

export interface MemoriesSourceStatus {
  state: MemoriesSourceState;
  photos: number;
  videos: number;
}

// ───────────── MEMO-2：Google 相簿（Picker API，經 gog） ─────────────
// Google 只讓 App 讀使用者在 Google 的畫面裡挑選的項目（不能讀整本相簿、不能持續同步）；挑選的項目下載到 Mac 的快取。

/**
 * 挑選工作的階段：idle → starting（建立挑選連結）→ waiting_pick（等使用者在 Google 挑選）→ downloading → done。
 * 任何階段可以 cancelled；建立、讀取挑選結果失敗或逾時是 failed。
 */
export type GooglePickPhase = "idle" | "starting" | "waiting_pick" | "downloading" | "done" | "failed" | "cancelled";

export const MEMORIES_GOOGLE_PATHS = {
  pick: "/api/memories/google/pick",
  cancel: "/api/memories/google/cancel",
  clear: "/api/memories/google/clear",
  qr: "/api/memories/google/qr.svg",
} as const;

/** 錯誤與不可用的原因：只用這些固定的中文（翻譯表的鍵），不放 gog 的輸出（可能含帳號或網址）。 */
export const MEMORIES_GOOGLE_REASON = {
  noGog: "Mac 上找不到 gog",
  noAccount: "沒有設定 Google 帳號（NOUS_GOG_ACCOUNT）",
  // 建立挑選連結失敗最常見的原因是還沒授權 photospicker，但 gog 的錯誤不外傳，所以只能說「可能」。
  auth: "無法建立 Google 相簿挑選連結（可能尚未授權）：在 Mac 執行 gog auth add 帳號 --services photospicker",
  timeout: "挑選逾時",
  list: "讀不到 Google 相簿的挑選結果",
  download: "下載失敗",
} as const;

export interface MemoriesGoogleView {
  /** gog 找得到而且有設定帳號。 */
  available: boolean;
  /** MEMORIES_GOOGLE_REASON 的其中一個（或設定檔的錯誤訊息）；available 時 null。 */
  unavailable_reason: string | null;
  phase: GooglePickPhase;
  /** 只在 waiting_pick 時有值。 */
  picker_uri: string | null;
  /** epoch ms；只在 waiting_pick 時有值。 */
  expires_at: number | null;
  /** downloading、done（取消時保留到取消前）：done＝已處理（含略過）、skipped＝略過（影片還沒處理好、下載失敗、格式不支援或太大）。 */
  progress: { done: number; total: number; skipped: number } | null;
  /** failed 時 MEMORIES_GOOGLE_REASON 的其中一個。 */
  error: string | null;
  photos: number;
  videos: number;
  bytes: number;
  cap_bytes: number;
  paths: typeof MEMORIES_GOOGLE_PATHS;
}

/** 正在進行的階段（挑選按鈕停用、顯示「取消」）。 */
export function googlePickBusy(phase: GooglePickPhase): boolean {
  return phase === "starting" || phase === "waiting_pick" || phase === "downloading";
}

/** 快取大小：1 GB 以下用 MB（整數），以上用 GB（一位小數）。 */
export function formatCacheSize(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  // 10 MB 以下留一位小數：幾張照片（數百 KB）不會顯示成「0 MB」。
  if (bytes < 1024 ** 3) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** settings.memories：設定頁與選單列照這個畫（只有數量與狀態，不含檔名或路徑）。 */
export interface MemoriesSettingsView {
  prefs: MemoriesPrefs;
  source: { kind: "folder" } & MemoriesSourceStatus;
  dwell_options: readonly number[];
  idle_options: readonly number[];
  write_path: typeof MEMORIES_WRITE_PATH;
  /** MEMO-2：核心有接上 Google 相簿時才有（不可用時 available=false 並說明原因）。 */
  google?: MemoriesGoogleView;
}

/** 設定頁與選單列共用的文字（中文是翻譯表的鍵；desktop/settings-menu.mjs 有同一份，tests/memories-menu.test.ts 核對兩邊一致）。 */
export const MEMORIES_TEXT = {
  group: "回憶模式",
  enabled: "閒置時播放回憶",
  enabledNote: "電子腦沒事一段時間後，照片與影片從電子腦浮現；有人喚醒、看著說話或有任務就立即收起",
  videoSound: "影片播放聲音",
  videoSoundNote: "預設靜音",
  dwell: "每張停留",
  idle: "閒置多久開始",
  seconds: "{0} 秒",
  minutes: "{0} 分鐘",
  stateOk: "照片來源：Mac 上的回憶資料夾，照片 {0} 張、影片 {1} 段",
  stateEmpty: "資料夾是空的：把照片放進 Mac 的回憶資料夾",
  stateMissing: "找不到回憶資料夾",
  stateFailed: "讀不到回憶資料夾",
  openFolder: "打開回憶資料夾",
  googleGroup: "Google 相簿",
  googleStatus: "Google 相簿：照片 {0} 張、影片 {1} 段（{2} / 2 GB）",
  googleUnavailable: "Google 相簿不可用：{0}",
  googlePick: "從 Google 相簿挑選…",
  googleCancel: "取消",
  googleCancelPick: "取消挑選",
  googleClear: "清除 Google 快取",
  googleClearMenu: "清除 Google 快取…",
  googleClearConfirm: "再按一次確認清除",
  googleClearAsk: "要清除 Google 相簿的快取嗎？",
  googleClearDetail: "Mac 上下載的 Google 照片與影片都會刪除；Google 相簿裡的原檔不受影響。",
  googleClearButton: "清除",
  googleOpen: "在瀏覽器開啟",
  googleQrAlt: "Google 相簿挑選連結的 QR code",
  googleScanHint: "用手機掃描，在 Google 相簿搜尋相簿名稱後選取照片，按完成",
  googleExpires: "連結在 {0} 前有效",
  googleStarting: "正在建立挑選連結…",
  googleWaiting: "等待在 Google 相簿挑選…",
  googleProgress: "正在下載 {0}/{1}",
  googleDone: "已加入 Google 相簿的照片：處理 {0} 項，略過 {1} 項",
  googleCancelled: "已取消挑選",
  googleNoSync: "Google 只讓 App 讀你挑選的照片，不能自動同步整本相簿；有新照片時再挑一次。",
  googleNoPlace: "Google 下載的照片沒有地點，只顯示時間。",
} as const;

/** 秒數選項的標籤：一分鐘以上用分鐘。 */
export function durationLabel(seconds: number): { text: string; value: number } {
  return seconds >= 60 && seconds % 60 === 0 ? { text: MEMORIES_TEXT.minutes, value: seconds / 60 } : { text: MEMORIES_TEXT.seconds, value: seconds };
}

export const MEMORIES_STATE_TEXT: Record<MemoriesSourceState, string> = {
  ok: MEMORIES_TEXT.stateOk,
  empty: MEMORIES_TEXT.stateEmpty,
  missing: MEMORIES_TEXT.stateMissing,
  failed: MEMORIES_TEXT.stateFailed,
};

// ───────────── 照片下方的時間與地點（只來自檔案的中繼資料） ─────────────

const ZH_NUM = ["", "一", "兩", "三", "四", "五", "六", "七", "八", "九", "十"];
const zhCount = (n: number) => (n <= 10 ? ZH_NUM[n]! : `${n} `);
const enCount = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** 相對時間（本機日曆）；未來的時間（時鐘不準）回傳 null。 */
function relativeTime(takenAt: number, now: Date, locale: Locale): string | null {
  const t = new Date(takenAt);
  if (takenAt > now.getTime()) return null;
  const en = locale === "en";
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  const days = day(now) - day(t);
  if (days === 0) return en ? "Today" : "今天";
  if (days < 7) return en ? "This week" : "這個星期";
  const months = (now.getFullYear() - t.getFullYear()) * 12 + now.getMonth() - t.getMonth() - (now.getDate() < t.getDate() ? 1 : 0);
  if (months < 1) {
    const w = Math.floor(days / 7);
    return en ? `${enCount(w, "week")} ago` : `${zhCount(w)}個星期前`;
  }
  if (months < 12) return en ? `${enCount(months, "month")} ago` : `${zhCount(months)}個月前`;
  const years = Math.floor(months / 12);
  if (now.getMonth() === t.getMonth() && now.getDate() === t.getDate()) {
    if (years === 1) return en ? "A year ago today" : "一年前的今天";
    return en ? `${years} years ago today` : `${zhCount(years)}年前的今天`;
  }
  // 「去年」只給上一個日曆年；滿一年但跨了兩個日曆年（例如 2024-12 在 2026-11 看）說「一年前」。
  if (years === 1) return now.getFullYear() - t.getFullYear() === 1 ? (en ? "Last year" : "去年") : (en ? "A year ago" : "一年前");
  return en ? `${years} years ago` : `${zhCount(years)}年前`;
}

/** 「三年前在新竹」「Today in Taipei」「在新竹」；時間與地點都沒有時 null（不顯示）。 */
export function memoryCaption(item: Pick<MemoriesItem, "taken_at" | "place">, now: Date, locale: Locale): string | null {
  const en = locale === "en";
  const time = item.taken_at === null ? null : relativeTime(item.taken_at, now, locale);
  const place = item.place ? (en ? item.place.en : item.place.zh) : null;
  if (time && place) return en ? `${time} in ${place}` : `${time}在${place}`;
  if (time) return time;
  if (place) return en ? `In ${place}` : `在${place}`;
  return null;
}

// ───────────── 頁面的狀態機 ─────────────

/** off：沒開；busy：有事（不倒數）；waiting：閒置倒數中；showing：播放回憶。 */
export type MemoriesPhase = "off" | "busy" | "waiting" | "showing";

export interface MemoriesState {
  phase: MemoriesPhase;
  /** 這次閒置從什麼時候開始算（busy、off 時為 null）。 */
  idleSince: number | null;
}

export interface MemoriesInput {
  now: number;
  enabled: boolean;
  busy: boolean;
  hasItems: boolean;
  idleMs: number;
}

export const MEMORIES_OFF: MemoriesState = { phase: "off", idleSince: null };

/**
 * 每次 render／每秒呼叫。規則依序：
 * | 條件                                  | 結果                         |
 * | !enabled                              | off                          |
 * | busy                                  | busy（idleSince = null）     |
 * | idleSince 為 null                      | waiting（idleSince = now）   |
 * | hasItems 且 now − idleSince ≥ idleMs  | showing                      |
 * | 其他                                  | waiting（保留 idleSince）    |
 */
export function stepMemories(state: MemoriesState, input: MemoriesInput): MemoriesState {
  const next: MemoriesState = !input.enabled ? MEMORIES_OFF
    : input.busy ? { phase: "busy", idleSince: null }
    : state.idleSince === null ? { phase: "waiting", idleSince: input.now }
    : input.hasItems && input.now - state.idleSince >= input.idleMs ? { phase: "showing", idleSince: state.idleSince }
    : { phase: "waiting", idleSince: state.idleSince };
  return next.phase === state.phase && next.idleSince === state.idleSince ? state : next;
}

/** 喚醒（喚醒詞、看著說話、交辦、點照片…）：立即收起，倒數從這一刻重新開始。 */
export function wakeMemories(state: MemoriesState, now: number): MemoriesState {
  return state.phase === "off" ? state : { phase: "waiting", idleSince: now };
}
