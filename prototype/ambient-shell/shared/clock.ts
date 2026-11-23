// CLK-1（George 2026-11-07）：Pi 畫面右上角的時間、日期、星期、氣溫與天氣。
// 這是環境狀態角落（和 .status-line、鏡頭指示一樣的被動讀數），不是 Surface、Dashboard 或 App 入口：沒有按鈕、不能點、
// 範圍固定只有時間／日期／天氣。這裡只有型別、固定表與純函式（核心、頁面與測試都讀），沒有網址、時鐘來源或檔案。
// - 時間一律用核心給的時區（地點的時區，沒有地點時核心的系統時區）格式化，不用 Pi 自己的時區。
// - 天氣只來自核心的 GET /api/weather/now（Open-Meteo，CC BY 4.0）；查不到就照實說，不顯示猜的天氣。
import { translate, type Locale } from "./i18n.mjs";
import type { WeatherFetchState, WeatherPlaceId } from "./proactive.ts";

// ───────────── 設定（configDir/clock.json） ─────────────

export interface ClockPrefs {
  /** Mac 主視窗（以及不帶 ?terminal= 的瀏覽器頁面）顯示（預設關）。 */
  main: boolean;
  /** 終端機頁面（Pi kiosk）顯示（預設開）。 */
  terminal: boolean;
}

export type ClockPrefsPatch = Partial<ClockPrefs>;

export const DEFAULT_CLOCK_PREFS: ClockPrefs = { main: false, terminal: true };
export const CLOCK_PREF_KEYS = Object.keys(DEFAULT_CLOCK_PREFS) as (keyof ClockPrefs)[];
export const CLOCK_WRITE_PATH = "/api/settings/clock" as const;
export const WEATHER_NOW_PATH = "/api/weather/now" as const;

export class ClockPatchError extends Error {}

/** 邊界驗證（HTTP body、clock.json 的每一個鍵）：不認得的鍵或不是 true／false 一律丟 ClockPatchError（→ HTTP 400）。 */
export function parseClockPatch(input: unknown): ClockPrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ClockPatchError("時鐘設定必須是 JSON 物件");
  const patch: ClockPrefsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== "main" && key !== "terminal") throw new ClockPatchError(`未知的時鐘設定：${key}`);
    if (typeof value !== "boolean") throw new ClockPatchError(`${key} 必須是 true 或 false`);
    patch[key] = value;
  }
  return patch;
}

/** settings.clock：enabled＝這個頁面（依 X-Nous-Terminal 判斷 Mac 主視窗或終端機）要不要顯示。 */
export interface ClockSettingsView {
  enabled: boolean;
  prefs: ClockPrefs;
  write_path: typeof CLOCK_WRITE_PATH;
}

/** 設定頁、選單列與角落共用的文字（中文是翻譯表的鍵；desktop/settings-menu.mjs 有同一份，tests/clock-settings.test.ts 核對兩邊一致）。 */
export const CLOCK_TEXT = {
  group: "右上角時鐘與天氣",
  main: "Mac 視窗",
  mainNote: "在 Mac 的 Nous 視窗右上角顯示時間、日期與天氣",
  terminal: "Pi 終端機",
  terminalNote: "在 Pi 等終端機畫面右上角顯示時間、日期與天氣",
  note: "只顯示時間、日期與天氣，不能點；天氣資料：Open-Meteo.com（CC BY 4.0），地點同「主動提醒」的天氣地點",
  aria: "時間、日期與天氣：{0}",
  age: "{0} 分鐘前",
  rain: "降雨 {0}%",
  today: "今日{0}",
  unavailable: "天氣暫時無法取得",
  noPlace: "設定天氣地點後顯示天氣",
} as const;

// ───────────── GET /api/weather/now 的回應 ─────────────

/** 角落要畫的天氣（不含地點以外的設定）。temp_c 為 null＝這份資料沒有「現在」的氣溫，只畫今天的最低／最高。 */
export interface ClockWeather {
  /** 預報日期（地點時區的 YYYY-MM-DD）。 */
  date: string;
  /** 有現在的資料時是現在的 WMO 代碼，否則是今天整天的代碼；不認得時角落不畫圖示。 */
  code: number | null;
  /** 現在是白天（Open-Meteo 的 is_day）；沒有現在的資料時 true（整天的圖示用白天版）。 */
  is_day: boolean;
  temp_c: number | null;
  min_c: number;
  max_c: number;
  /** 今天降雨機率最高時段的機率；沒有逐時資料時 null。 */
  rain_percent: number | null;
  fetched_at: number;
}

export interface WeatherNowView {
  /** 格式化時間用的 IANA 時區（地點的時區，沒有地點時核心的系統時區）。 */
  time_zone: string;
  /** 核心回應時的時間（epoch ms）；頁面據此校正 Pi 的時鐘偏差。 */
  server_now: number;
  place: { id: WeatherPlaceId; label: string } | null;
  state: WeatherFetchState;
  weather: ClockWeather | null;
  attribution: string;
}

// ───────────── WMO 天氣代碼 → 圖示與文字（Open-Meteo 文件的 Weather variable documentation） ─────────────

export type WeatherIconKind =
  | "clear"
  | "mostly_clear"
  | "partly_cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "sleet"
  | "rain"
  | "heavy_rain"
  | "showers"
  | "snow"
  | "thunder";

/** 有白天／夜晚兩個版本的圖示（太陽換成月亮）。 */
export const DAY_NIGHT_ICONS: readonly WeatherIconKind[] = ["clear", "mostly_clear", "partly_cloudy", "showers"];

export const CLOCK_WMO: readonly { codes: readonly number[]; icon: WeatherIconKind; zh: string; en: string }[] = [
  { codes: [0], icon: "clear", zh: "晴", en: "Clear" },
  { codes: [1], icon: "mostly_clear", zh: "晴時多雲", en: "Mostly clear" },
  { codes: [2], icon: "partly_cloudy", zh: "多雲", en: "Partly cloudy" },
  { codes: [3], icon: "overcast", zh: "陰", en: "Overcast" },
  { codes: [45, 48], icon: "fog", zh: "霧", en: "Fog" },
  { codes: [51, 53, 55], icon: "drizzle", zh: "毛毛雨", en: "Drizzle" },
  { codes: [56, 57, 66, 67], icon: "sleet", zh: "凍雨", en: "Freezing rain" },
  { codes: [61, 63], icon: "rain", zh: "雨", en: "Rain" },
  { codes: [65], icon: "heavy_rain", zh: "大雨", en: "Heavy rain" },
  { codes: [80, 81, 82], icon: "showers", zh: "陣雨", en: "Showers" },
  { codes: [71, 73, 75, 77, 85, 86], icon: "snow", zh: "雪", en: "Snow" },
  { codes: [95, 96, 99], icon: "thunder", zh: "雷雨", en: "Thunderstorm" },
];

export function clockCondition(code: number | null): (typeof CLOCK_WMO)[number] | null {
  if (code === null) return null;
  return CLOCK_WMO.find((w) => w.codes.includes(code)) ?? null;
}

/** 代碼 → 圖示（含白天／夜晚）；不認得的代碼回 null（只畫溫度，不畫圖示）。 */
export function clockIcon(code: number | null, isDay: boolean): { kind: WeatherIconKind; night: boolean } | null {
  const hit = clockCondition(code);
  if (!hit) return null;
  return { kind: hit.icon, night: !isDay && DAY_NIGHT_ICONS.includes(hit.icon) };
}

// ───────────── 時間與日期 ─────────────

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"] as const;
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** 某個時刻在這個時區的時、分、年月日與星期（0＝星期日）。 */
export function clockParts(instant: number, timeZone: string): { hour: number; minute: number; year: number; month: number; day: number; weekday: number; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const weekday = Math.max(0, WEEKDAY_EN.indexOf(get("weekday") as (typeof WEEKDAY_EN)[number]));
  return { hour: Number(get("hour")) % 24, minute: Number(get("minute")), year, month, day, weekday, date: `${get("year")}-${get("month")}-${get("day")}` };
}

/** 角落的時間（24 小時制 HH:mm）與日期（zh「11月7日 週六」、en「Sat, Nov 7」）。 */
export function formatClock(instant: number, timeZone: string, locale: Locale): { time: string; date: string } {
  const p = clockParts(instant, timeZone);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const date = locale === "en" ? `${WEEKDAY_EN[p.weekday]}, ${MONTH_EN[p.month - 1]} ${p.day}` : `${p.month}月${p.day}日 週${WEEKDAY_ZH[p.weekday]}`;
  return { time, date };
}

/** 到下一個整分（再多 50 ms，確定已跨過分界）的毫秒數：角落每分鐘只重寫一次，不用每秒的計時器。 */
export function msUntilNextMinute(now: number): number {
  return 60_000 - (((now % 60_000) + 60_000) % 60_000) + 50;
}

/** 偏差超過這個值（Pi 沒對時）才改用核心的時間。 */
export const CLOCK_SKEW_LIMIT_MS = 60_000;

/** 核心時間的錨點：核心回應的 server_now 對應到頁面單調時鐘（performance.now）的哪一刻。 */
export interface ClockAnchor {
  server: number;
  mono: number;
}

/** 以請求來回的中點（單調時鐘）對應核心當時的時間；數值不合理時 null（不校正）。 */
export function clockAnchor(serverNow: number, monoSent: number, monoReceived: number): ClockAnchor | null {
  if (![serverNow, monoSent, monoReceived].every(Number.isFinite) || monoReceived < monoSent) return null;
  return { server: serverNow, mono: (monoSent + monoReceived) / 2 };
}

/**
 * 角落用的「現在」：核心時間＝錨點＋之後經過的單調時間（不受 Pi 牆上時鐘跳動影響）。牆上時鐘和它差 60 秒內就用牆上時鐘
 * （已對時，不跟著網路抖動）；超過才用核心時間。每次都重新比較，所以 Pi 之後對時（fake-hwclock → NTP 跳回正確時間）
 * 會立即改回牆上時鐘，不會把偏移算兩次。
 */
export function clockNow(wall: number, mono: number, anchor: ClockAnchor | null): number {
  if (!anchor) return wall;
  const core = anchor.server + (mono - anchor.mono);
  return Math.abs(wall - core) > CLOCK_SKEW_LIMIT_MS ? Math.round(core) : wall;
}

/** 兩次重畫之間牆上時鐘與單調時鐘走的差距超過這個值（睡眠、對時跳動）就重新向核心對時並重讀天氣。 */
export const CLOCK_DRIFT_RELOAD_MS = 30_000;

// ───────────── 天氣那幾行（純函式；頁面照這個畫） ─────────────

/** 超過這個年紀（ms）的天氣資料加上「N 分鐘前」。 */
export const CLOCK_WEATHER_AGE_MS = 45 * 60_000;
/** 頁面保留上一次天氣的上限：超過就不顯示天氣，只說「天氣暫時無法取得」（同核心的 WEATHER_MAX_AGE_MS）。 */
export const CLOCK_WEATHER_KEEP_MS = 2 * 60 * 60_000;
/** 頁面重新查天氣的間隔（核心另有 30 分鐘的快取）。 */
export const CLOCK_WEATHER_REFRESH_MS = 15 * 60_000;
/** 讀天氣的請求最多等這麼久（卡住的請求不能擋住之後的更新）。 */
export const CLOCK_FETCH_TIMEOUT_MS = 10_000;
/** 核心還沒回應過（不知道時區）或請求失敗時，多久再試一次。 */
export const CLOCK_RETRY_MS = 60_000;

export interface ClockWeatherRow {
  /** weather：畫天氣；note：只畫一行灰字（查不到、沒有地點）；none：還沒有任何回應，什麼都不畫。 */
  kind: "weather" | "note" | "none";
  icon: { kind: WeatherIconKind; night: boolean } | null;
  /** 主要數字：現在的氣溫「24°」，沒有現在的氣溫時今天的範圍「18°–26°」。 */
  main: string;
  condition: string | null;
  /** 第二行：地點、今天的範圍（有現在的氣溫時）、降雨機率，以「 · 」分開。 */
  detail: string | null;
  /** 「40 分鐘前」：資料超過 45 分鐘，或核心連不上而沿用上一次的資料。 */
  age: string | null;
  note: string | null;
  /** 角落實際用的天氣（頁面記成「上一次」）。 */
  used: ClockWeather | null;
}

const deg = (c: number) => `${Math.round(c) === 0 ? 0 : Math.round(c)}°`;

/**
 * 角落的天氣列。
 * - view：最近一次 GET /api/weather/now 的回應；null＝核心連不上（或還沒回應）。
 * - last：頁面上一次用過的天氣；只在核心沒有可用資料時沿用。
 * 不論來自 view 或 last，都只用「今天、2 小時內」的資料：過了午夜，昨天的範圍與「今日」立即不畫。
 */
export function clockWeatherRow(input: { view: WeatherNowView | null; last: ClockWeather | null; now: number; today: string; locale: Locale }): ClockWeatherRow {
  const { view, last, now, today, locale } = input;
  const tr = (source: string, ...values: unknown[]) => translate(source, locale, ...values);
  const empty: ClockWeatherRow = { kind: "none", icon: null, main: "", condition: null, detail: null, age: null, note: null, used: null };
  if (view?.state === "no_place") return { ...empty, kind: "note", note: tr(CLOCK_TEXT.noPlace) };
  const usable = (w: ClockWeather | null | undefined): w is ClockWeather => !!w && w.date === today && now - w.fetched_at <= CLOCK_WEATHER_KEEP_MS;
  const fresh = usable(view?.weather) ? view.weather : null;
  const kept = !fresh && usable(last) ? last : null;
  const w = fresh ?? kept;
  if (!w) return view || last ? { ...empty, kind: "note", note: tr(CLOCK_TEXT.unavailable) } : empty;
  const cond = clockCondition(w.code);
  const range = `${deg(w.min_c)}–${deg(w.max_c)}`;
  const place = view?.place?.label ?? null;
  const detail = [place, w.temp_c !== null ? range : null, w.rain_percent !== null ? tr(CLOCK_TEXT.rain, Math.round(w.rain_percent)) : null].filter((p): p is string => !!p);
  const ageMs = now - w.fetched_at;
  const age = kept || ageMs > CLOCK_WEATHER_AGE_MS ? tr(CLOCK_TEXT.age, Math.max(1, Math.floor(ageMs / 60_000))) : null;
  return {
    kind: "weather",
    // 沒有現在的資料：整天的代碼用白天版圖示（clockIcon 依 is_day，核心此時給 true）。
    icon: clockIcon(w.code, w.is_day),
    main: w.temp_c !== null ? deg(w.temp_c) : range,
    // 沒有現在的資料：整天的天氣標「今天」，不當成現在的天氣。
    condition: cond ? (w.temp_c !== null ? (locale === "en" ? cond.en : cond.zh) : tr(CLOCK_TEXT.today, locale === "en" ? cond.en.toLowerCase() : cond.zh)) : null,
    detail: detail.length ? detail.join(" · ") : null,
    age,
    note: null,
    used: w,
  };
}

/** 給螢幕閱讀器的一句（容器的 aria-label；不設 aria-live，每分鐘的變化不朗讀）。 */
export function clockAriaLabel(time: string, date: string, row: ClockWeatherRow, locale: Locale): string {
  const sep = locale === "en" ? ", " : "，";
  const parts = [time, date];
  if (row.kind === "weather") parts.push([row.main, row.condition, row.detail, row.age].filter(Boolean).join(sep));
  else if (row.note) parts.push(row.note);
  return translate(CLOCK_TEXT.aria, locale, parts.join(sep));
}
