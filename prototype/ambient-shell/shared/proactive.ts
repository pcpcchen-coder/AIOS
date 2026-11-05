// PRO-1（George 2026-11-05）：主動提醒。打完招呼後，核心依確定性的模板接一句今天的天氣；模型只照念。
// 這裡只有型別、固定清單與純函式（核心與頁面都會讀）：沒有網址、時間來源或檔案。
// - 每人每天早上第一次打招呼（本機時段，預設 5–11 點）才接；沒認出是誰時用「這台裝置今天第一次」的規則。
// - 地點只能從 WEATHER_PLACES 選（固定座標）；模型與頁面都不能指定任意地點或網址。
// - 天氣資料來源 Open-Meteo（CC BY 4.0，https://open-meteo.com/），查不到就略過，不猜。
import type { Locale } from "./i18n.mjs";

/** 天氣可以選的地點：固定座標（WGS84，市府附近，取到小數兩位）。改清單要附來源。 */
export interface WeatherPlace {
  id: string;
  /** 中文名稱（念出來的就是這個）。 */
  zh: string;
  en: string;
  latitude: number;
  longitude: number;
  /** 這個地點的 IANA 時區（Open-Meteo 依這個時區切「今天」）。 */
  timeZone: string;
}

export const WEATHER_PLACES = [
  { id: "taipei", zh: "台北", en: "Taipei", latitude: 25.04, longitude: 121.56, timeZone: "Asia/Taipei" },
  { id: "new_taipei", zh: "新北", en: "New Taipei", latitude: 25.01, longitude: 121.46, timeZone: "Asia/Taipei" },
  { id: "keelung", zh: "基隆", en: "Keelung", latitude: 25.13, longitude: 121.74, timeZone: "Asia/Taipei" },
  { id: "taoyuan", zh: "桃園", en: "Taoyuan", latitude: 24.99, longitude: 121.30, timeZone: "Asia/Taipei" },
  { id: "hsinchu", zh: "新竹", en: "Hsinchu", latitude: 24.81, longitude: 120.97, timeZone: "Asia/Taipei" },
  { id: "taichung", zh: "台中", en: "Taichung", latitude: 24.15, longitude: 120.67, timeZone: "Asia/Taipei" },
  { id: "chiayi", zh: "嘉義", en: "Chiayi", latitude: 23.48, longitude: 120.45, timeZone: "Asia/Taipei" },
  { id: "tainan", zh: "台南", en: "Tainan", latitude: 23.00, longitude: 120.23, timeZone: "Asia/Taipei" },
  { id: "kaohsiung", zh: "高雄", en: "Kaohsiung", latitude: 22.63, longitude: 120.30, timeZone: "Asia/Taipei" },
  { id: "yilan", zh: "宜蘭", en: "Yilan", latitude: 24.76, longitude: 121.75, timeZone: "Asia/Taipei" },
  { id: "hualien", zh: "花蓮", en: "Hualien", latitude: 23.99, longitude: 121.60, timeZone: "Asia/Taipei" },
  { id: "taitung", zh: "台東", en: "Taitung", latitude: 22.76, longitude: 121.14, timeZone: "Asia/Taipei" },
] as const satisfies readonly WeatherPlace[];

export type WeatherPlaceId = (typeof WEATHER_PLACES)[number]["id"];

export function weatherPlace(id: string | null | undefined): WeatherPlace | null {
  return WEATHER_PLACES.find((p) => p.id === id) ?? null;
}

/** 沒選地點時依系統時區推一個：只有 Asia/Taipei 推得出（台北）；其他時區不猜，要使用者在設定裡選。 */
export function defaultPlaceFor(timeZone: string): WeatherPlaceId | null {
  return timeZone === "Asia/Taipei" ? "taipei" : null;
}

export const WEATHER_ATTRIBUTION = "Open-Meteo.com（CC BY 4.0）";

// ───────────── 設定（configDir/proactive.json） ─────────────

export interface ProactivePrefs {
  /** 總開關（預設開）。關掉＝回到只打招呼。 */
  enabled: boolean;
  /** 招呼後接今天的天氣（預設開）。 */
  weather: boolean;
  /**
   * PRO-2：認出行程擁有者時說今天的行程（預設開）：有行程先問「要不要我念今天的行程？」，說好才念；
   * 沒有行程直接說「今天沒有排行程」（George 2026-11-05）。
   */
  calendar: boolean;
  /** 時段開始（本機整點，含）。 */
  start_hour: number;
  /** 時段結束（本機整點，不含）。 */
  end_hour: number;
  /** WEATHER_PLACES 的 id；null＝依系統時區推（defaultPlaceFor）。 */
  place: WeatherPlaceId | null;
}

export type ProactivePrefsPatch = Partial<ProactivePrefs>;

export const DEFAULT_PROACTIVE_PREFS: ProactivePrefs = { enabled: true, weather: true, calendar: true, start_hour: 5, end_hour: 11, place: null };

/** 選單與設定頁可以選的整點（不能輸入數字）。 */
export const START_HOUR_OPTIONS = [4, 5, 6, 7, 8, 9] as const;
export const END_HOUR_OPTIONS = [9, 10, 11, 12, 13, 14] as const;

export const PROACTIVE_PREF_KEYS = Object.keys(DEFAULT_PROACTIVE_PREFS) as (keyof ProactivePrefs)[];

export class ProactivePatchError extends Error {}

/** 邊界驗證（HTTP body、proactive.json 的每一個鍵）：不認得的鍵、型別或範圍不對一律丟 ProactivePatchError（→ HTTP 400）。 */
export function parseProactivePatch(input: unknown): ProactivePrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ProactivePatchError("主動提醒設定必須是 JSON 物件");
  const patch: ProactivePrefsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "enabled" || key === "weather" || key === "calendar") {
      if (typeof value !== "boolean") throw new ProactivePatchError(`${key} 必須是 true 或 false`);
      patch[key] = value;
    } else if (key === "start_hour") {
      if (!(START_HOUR_OPTIONS as readonly unknown[]).includes(value)) throw new ProactivePatchError(`start_hour 必須是 ${START_HOUR_OPTIONS.join("、")} 其中之一`);
      patch.start_hour = value as number;
    } else if (key === "end_hour") {
      if (!(END_HOUR_OPTIONS as readonly unknown[]).includes(value)) throw new ProactivePatchError(`end_hour 必須是 ${END_HOUR_OPTIONS.join("、")} 其中之一`);
      patch.end_hour = value as number;
    } else if (key === "place") {
      if (value !== null && (typeof value !== "string" || !weatherPlace(value))) throw new ProactivePatchError("place 必須是清單上的地點或 null");
      patch.place = value as WeatherPlaceId | null;
    } else {
      throw new ProactivePatchError(`未知的主動提醒設定：${key}`);
    }
  }
  return patch;
}

/** 本機時間是否在時段內（開始含、結束不含）。 */
export function inWindow(hour: number, prefs: Pick<ProactivePrefs, "start_hour" | "end_hour">): boolean {
  return hour >= prefs.start_hour && hour < prefs.end_hour;
}

/** settings.proactive：設定頁與選單列照這個畫。 */
export interface ProactiveSettingsView {
  prefs: ProactivePrefs;
  /** 實際使用的地點（選的，或依系統時區推的）；null＝沒有地點，天氣一律略過。 */
  place: { id: WeatherPlaceId; label: string; auto: boolean } | null;
  places: { id: WeatherPlaceId; label: string }[];
  /** 選單與設定頁可以選的整點（START_HOUR_OPTIONS、END_HOUR_OPTIONS）。 */
  start_hours: readonly number[];
  end_hours: readonly number[];
  /** 最近一次查天氣的結果（只有狀態，不含天氣內容）。 */
  weather: { state: WeatherFetchState; at: number | null };
  /** PRO-2：行事曆（CAL-1）的狀態（只有狀態，不含行程內容）。 */
  calendar: { state: CalendarFetchState };
  attribution: string;
  write_path: "/api/settings/proactive";
}

/** ok：有今天的資料；failed：查詢失敗或回覆看不懂；none：還沒查過；no_place：沒有地點。 */
export type WeatherFetchState = "ok" | "failed" | "none" | "no_place";

/** ok：有今天的行程資料；failed：讀行程失敗；none：還沒讀過；not_connected：CAL-1 沒有設定（NOUS_AIL_SERVICES 沒有 google_calendar）。 */
export type CalendarFetchState = "ok" | "failed" | "none" | "not_connected";

/** 設定頁與選單列共用的文字（中文是翻譯表的鍵；desktop/settings-menu.mjs 有同一份，tests/proactive.test.ts 核對兩邊一致）。 */
export const PROACTIVE_TEXT = {
  group: "主動提醒",
  enabled: "早上招呼後主動提醒",
  enabledNote: "每人每天在時段內第一次打招呼時，接一句今天的天氣；關掉就只打招呼",
  weather: "說今天的天氣",
  weatherNote: "天氣資料：Open-Meteo.com（CC BY 4.0）",
  start: "時段開始",
  end: "時段結束",
  hour: "{0} 點",
  place: "天氣地點",
  auto: "依系統時區（{0}）",
  autoNone: "依系統時區（推不出地點）",
  noPlace: "還沒有地點：請選一個，否則不說天氣",
  stateOk: "天氣：已取得今天的資料",
  stateFailed: "天氣：上次查詢失敗，這次招呼不說天氣",
  stateNone: "天氣：還沒查過（看著說話或喚醒時會先查）",
  stateNoPlace: "天氣：沒有地點",
  calendar: "認出 George 時說今天的行程",
  calendarNote: "有行程先問「要不要我念今天的行程？」，說好才念；沒有行程直接說「今天沒有排行程」",
  calOk: "行事曆：已讀到今天的行程",
  calFailed: "行事曆：上次讀取失敗，這次不提行程",
  calNone: "行事曆：還沒讀過（看著說話或喚醒時會先讀）",
  calNotConnected: "行事曆：沒有連上 Google 日曆（CAL-1）",
} as const;

// ───────────── 今天的天氣（核心從 Open-Meteo 回覆整理；只留念句子需要的欄位） ─────────────

export type DayPart = "morning" | "afternoon" | "evening";

export interface WeatherToday {
  place: WeatherPlaceId;
  /** 這份預報的日期（地點時區的 YYYY-MM-DD）。 */
  date: string;
  /** WMO 天氣代碼；不認得的代碼不念天氣狀況。 */
  code: number | null;
  min_c: number;
  max_c: number;
  /** 降雨機率最高的時段與機率（6–12、12–18、18–24 點，取每小時最大值）；沒有逐時資料時 null。 */
  rain: { part: DayPart; percent: number } | null;
  fetched_at: number;
}

/** WMO 天氣代碼（Open-Meteo 文件的 Weather variable documentation）→ 念出來的狀況。 */
const WMO: { codes: number[]; zh: string; en: string }[] = [
  { codes: [0], zh: "晴天", en: "clear" },
  { codes: [1], zh: "大致晴朗", en: "mostly clear" },
  { codes: [2], zh: "多雲", en: "partly cloudy" },
  { codes: [3], zh: "陰天", en: "overcast" },
  { codes: [45, 48], zh: "有霧", en: "foggy" },
  { codes: [51, 53, 55, 56, 57], zh: "有毛毛雨", en: "drizzly" },
  { codes: [61, 66], zh: "有小雨", en: "light rain" },
  { codes: [63], zh: "有雨", en: "rain" },
  { codes: [65, 67], zh: "有大雨", en: "heavy rain" },
  { codes: [71, 73, 75, 77, 85, 86], zh: "會下雪", en: "snow" },
  { codes: [80, 81, 82], zh: "有陣雨", en: "showers" },
  { codes: [95, 96, 99], zh: "有雷雨", en: "thunderstorms" },
];

export function weatherCondition(code: number | null, locale: Locale): string | null {
  if (code === null) return null;
  const hit = WMO.find((w) => w.codes.includes(code));
  return hit ? (locale === "en" ? hit.en : hit.zh) : null;
}

/** 念出降雨機率的門檻（%）；到 UMBRELLA_PERCENT 再提醒帶傘。 */
export const RAIN_MENTION_PERCENT = 30;
export const UMBRELLA_PERCENT = 50;

const PART_ZH: Record<DayPart, string> = { morning: "早上", afternoon: "下午", evening: "晚上" };
const PART_EN: Record<DayPart, string> = { morning: "this morning", afternoon: "this afternoon", evening: "this evening" };

/**
 * 天氣那一句（確定性的模板）：「今天台北多雲，22 到 28 度，下午降雨機率 60%，記得帶傘」。
 * 溫度四捨五入到整數；降雨機率低於 30% 不念。
 */
export function weatherSentence(w: WeatherToday, locale: Locale): string {
  const place = weatherPlace(w.place)!;
  const min = Math.round(w.min_c);
  const max = Math.round(w.max_c);
  const cond = weatherCondition(w.code, locale);
  const rain = w.rain && w.rain.percent >= RAIN_MENTION_PERCENT ? w.rain : null;
  if (locale === "en") {
    let s = `Today in ${place.en}: ${cond ? `${cond}, ` : ""}${min} to ${max}°C`;
    if (rain) s += `, ${rain.percent}% chance of rain ${PART_EN[rain.part]}`;
    if (rain && rain.percent >= UMBRELLA_PERCENT) s += "; take an umbrella";
    return `${s}.`;
  }
  let s = `今天${place.zh}${cond ?? ""}，${min} 到 ${max} 度`;
  if (rain) s += `，${PART_ZH[rain.part]}降雨機率 ${rain.percent}%`;
  if (rain && rain.percent >= UMBRELLA_PERCENT) s += "，記得帶傘";
  return s;
}

// ───────────── 今天的行程（PRO-2；資料來自 CAL-1，只在核心記憶體裡） ─────────────

/** 念行程用的最小欄位（CAL-1 的 EventSummary）。 */
export interface TodayEvent {
  summary: string;
  start: string;
  all_day: boolean;
  location?: string;
}

export const CALENDAR_ASK = { zh: "要不要我念今天的行程？", en: "Shall I read today's schedule?" } as const;
export const CALENDAR_EMPTY = { zh: "今天沒有排行程", en: "Nothing is on your calendar today." } as const;
/** 一次最多念幾個行程（其餘說「還有 N 個」）。 */
export const SCHEDULE_MAX = 5;
const TITLE_MAX = 40;

const cut = (t: string, n: number) => ([...t].length > n ? `${[...t].slice(0, n).join("")}…` : t);
function startTime(e: TodayEvent): string | null {
  const m = /T(\d{2}):(\d{2})/.exec(e.start);
  return m ? `${Number(m[1])}:${m[2]}` : null;
}

/**
 * 念出今天行程的那一句（確定性的模板）：「今天有 2 個行程：9:30 開會；整天 生日。」標題來自日曆（可能是別人寫的），只當資料。
 */
export function scheduleSentence(events: readonly TodayEvent[], locale: Locale, max: number = SCHEDULE_MAX): string {
  const en = locale === "en";
  if (!events.length) return en ? CALENDAR_EMPTY.en : `${CALENDAR_EMPTY.zh}。`;
  // 標題與地點是別人也能寫的資料：拿掉引號「」，不能跳出念行程指示的引號。
  const clean = (t: string) => cut(t.replace(/[「」『』]/gu, " ").replace(/\s+/gu, " ").trim(), TITLE_MAX);
  if (max <= 0) return en ? `You have ${events.length} ${events.length === 1 ? "event" : "events"} today.` : `今天有 ${events.length} 個行程。`;
  const items = events.slice(0, max).map((e) => {
    const time = e.all_day ? (en ? "all day" : "整天") : (startTime(e) ?? (en ? "today" : "今天"));
    const title = clean(e.summary) || (en ? "(untitled)" : "（沒有標題）");
    const place = e.location ? clean(e.location) : "";
    const where = place ? (en ? ` at ${place}` : `，在${place}`) : "";
    return `${time} ${title}${where}`;
  });
  const rest = events.length - items.length;
  if (en) return `You have ${events.length} ${events.length === 1 ? "event" : "events"} today: ${items.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`;
  return `今天有 ${events.length} 個行程：${items.join("；")}${rest > 0 ? `；還有 ${rest} 個` : ""}。`;
}

/** 主動提醒的幾段（天氣、行程問句或「今天沒有排行程」）接成一段：中文以句號分開，英文以空白分開（各段自帶標點）。 */
export function joinBriefing(parts: readonly string[], locale: Locale): string | null {
  const list = parts.filter((p) => p.length > 0);
  if (!list.length) return null;
  if (locale === "en") return list.join(" ");
  return list.map((p, i) => (i < list.length - 1 && !/[。？！]$/u.test(p) ? `${p}。` : p)).join("");
}

/** 招呼句後面接主動提醒（招呼句本身沒有句尾標點）。 */
export function appendBriefing(greeting: string, extra: string | null, locale: Locale): string {
  if (!extra) return greeting;
  return locale === "en" ? `${greeting}. ${extra}` : `${greeting}。${extra}`;
}

// ───────────── 每日一次 ─────────────

/** 每日紀錄的鍵：認出的家人（person:<id>）、這台裝置（device），或 PRO-2 已經問過／說過行程的人（calendar:<id>）。 */
export type BriefingKey = "device" | `person:${string}` | `calendar:${string}`;

/**
 * 今天要不要主動說（純函式）：認出的人看自己的鍵；沒認出是誰看 device（這台裝置今天有沒有對任何人說過）。
 * 回傳說完要記下的鍵（認出的人：自己＋device），或 null（不說）。
 */
export function briefingKeys(personId: string | null, done: ReadonlySet<string>): BriefingKey[] | null {
  if (personId) {
    const key: BriefingKey = `person:${personId}`;
    return done.has(key) ? null : [key, "device"];
  }
  return done.has("device") ? null : ["device"];
}
