import { localToday } from "./local-date.ts";
import type { Locale } from "../shared/i18n.mjs";
import type { WeatherNowView } from "../shared/clock.ts";
import { WEATHER_ATTRIBUTION, weatherPlace, type DayPart, type WeatherNow, type WeatherFetchState, type WeatherPlace, type WeatherPlaceId, type WeatherToday } from "../shared/proactive.ts";

// PRO-1（George 2026-11-05）：今天的天氣，來源 Open-Meteo（免費、不用金鑰；資料 CC BY 4.0，https://open-meteo.com/）。
// - 網址只由這裡組：固定主機 api.open-meteo.com，參數只有清單地點的座標與時區（shared/proactive.ts WEATHER_PLACES）。
//   模型、頁面或設定都不能傳網址；AIL 的 app.weather.today 沒有任何參數。
// - 快取 30 分鐘（WEATHER_TTL_MS）；超過 2 小時或不是今天的資料不用（WEATHER_MAX_AGE_MS）。
// - 查詢失敗或回覆看不懂：照實記成 failed，不回假資料。只記狀態，不寫檔（天氣內容不保存）。

export const OPEN_METEO_HOST = "https://api.open-meteo.com";
export const WEATHER_TTL_MS = 30 * 60_000;
export const WEATHER_MAX_AGE_MS = 2 * 60 * 60_000;
export const WEATHER_TIMEOUT_MS = 8_000;
/** 查詢失敗後這段時間內不再向 Open-Meteo 查同一個地點（右上角時鐘、招呼與工具都可能一直來問；服務掛掉時不要一直打）。 */
export const WEATHER_FAILURE_COOLDOWN_MS = 2 * 60_000;
const MAX_BODY_BYTES = 64_000;

export function forecastUrl(place: WeatherPlace): string {
  const q = new URLSearchParams({
    latitude: place.latitude.toFixed(2),
    longitude: place.longitude.toFixed(2),
    // CLK-1：右上角時鐘要畫現在的氣溫與天氣（is_day 選白天／夜晚圖示）。
    current: "temperature_2m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    hourly: "precipitation_probability",
    timezone: place.timeZone,
    forecast_days: "1",
  });
  return `${OPEN_METEO_HOST}/v1/forecast?${q.toString()}`;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const PARTS: { part: DayPart; from: number; to: number }[] = [
  { part: "morning", from: 6, to: 12 },
  { part: "afternoon", from: 12, to: 18 },
  { part: "evening", from: 18, to: 24 },
];

/**
 * CLK-1：Open-Meteo 的 current 區塊 → 現在的氣溫與天氣。時間不是 today、氣溫缺漏或不合理、is_day 不是 0／1 時回 null
 * （角落改畫今天的最低／最高，不把整天的資料說成「現在」）。
 */
export function parseCurrent(body: unknown, today: string): WeatherNow | null {
  const cur = (body as { current?: Record<string, unknown> } | null)?.current;
  if (!cur || typeof cur !== "object") return null;
  const time = cur.time;
  if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time) || time.slice(0, 10) !== today) return null;
  const temp = cur.temperature_2m;
  if (!finite(temp) || temp < -60 || temp > 60) return null;
  if (cur.is_day !== 0 && cur.is_day !== 1) return null;
  const code = cur.weather_code;
  return { time, temp_c: temp, code: Number.isInteger(code) ? (code as number) : null, is_day: cur.is_day === 1 };
}

/** Open-Meteo 的回覆 → WeatherToday；日期不是 today、溫度缺漏或不合理時回 null。 */
export function parseForecast(body: unknown, place: WeatherPlaceId, today: string, fetchedAt: number): WeatherToday | null {
  if (!body || typeof body !== "object") return null;
  const daily = (body as { daily?: Record<string, unknown> }).daily;
  if (!daily || typeof daily !== "object") return null;
  const first = (key: string): unknown => (Array.isArray(daily[key]) ? (daily[key] as unknown[])[0] : undefined);
  if (first("time") !== today) return null;
  const min = first("temperature_2m_min");
  const max = first("temperature_2m_max");
  if (!finite(min) || !finite(max) || min > max || min < -60 || max > 60) return null;
  const code = first("weather_code");
  let rain: WeatherToday["rain"] = null;
  const hourly = (body as { hourly?: { time?: unknown; precipitation_probability?: unknown } }).hourly;
  if (hourly && Array.isArray(hourly.time) && Array.isArray(hourly.precipitation_probability)) {
    const probs = hourly.precipitation_probability as unknown[];
    for (const { part, from, to } of PARTS) {
      let best: number | null = null;
      (hourly.time as unknown[]).forEach((t, i) => {
        const m = typeof t === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(t) : null;
        const p = probs[i];
        if (!m || m[1] !== today || !finite(p) || p < 0 || p > 100) return;
        const h = Number(m[2]);
        if (h >= from && h < to && (best === null || p > best)) best = p;
      });
      if (best !== null && (rain === null || best > rain.percent)) rain = { part, percent: Math.round(best) };
    }
  }
  return { place, date: today, code: Number.isInteger(code) ? (code as number) : null, min_c: min, max_c: max, rain, now: parseCurrent(body, today), fetched_at: fetchedAt };
}

export interface WeatherServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** 今天天氣的快取（一個地點一份；換地點時舊的不用）。 */
export class WeatherService {
  private cached: WeatherToday | null = null;
  private inflight: { place: WeatherPlaceId; promise: Promise<WeatherToday | null> } | null = null;
  /** 最近一次查詢（哪個地點、成功或失敗）；顯示用的狀態由 status() 依快取推導。 */
  private last: { place: WeatherPlaceId; ok: boolean; at: number } | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: WeatherServiceOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** 快取裡可以用的今天天氣（不發請求）：同一地點、是今天、2 小時內。 */
  current(placeId: WeatherPlaceId): WeatherToday | null {
    const c = this.cached;
    const place = weatherPlace(placeId);
    if (!c || !place || c.place !== placeId) return null;
    if (this.now() - c.fetched_at > WEATHER_MAX_AGE_MS) return null;
    if (c.date !== localToday(new Date(this.now()), place.timeZone)) return null;
    return c;
  }

  /**
   * 快取超過 30 分鐘（或沒有、或換了地點）才查；同時只有一個請求。失敗回 null。
   * signal 只中止這個呼叫者的等待，不中止共用的請求（工具呼叫被打斷不會讓招呼的預先查詢一起失敗）。
   */
  async refresh(placeId: WeatherPlaceId, signal?: AbortSignal): Promise<WeatherToday | null> {
    const c = this.current(placeId);
    if (c && this.now() - c.fetched_at < WEATHER_TTL_MS) return c;
    // 剛失敗過：冷卻時間內不重查，回快取裡仍可用的資料（2 小時內、今天）或 null。
    if (!this.inflight && this.last?.place === placeId && !this.last.ok && this.now() - this.last.at < WEATHER_FAILURE_COOLDOWN_MS) return c;
    let shared = this.inflight?.place === placeId ? this.inflight.promise : null;
    if (!shared) {
      const promise = this.load(placeId).finally(() => {
        if (this.inflight?.promise === promise) this.inflight = null;
      });
      this.inflight = { place: placeId, promise };
      shared = promise;
    }
    if (!signal) return shared;
    if (signal.aborted) return null;
    return Promise.race([shared, new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }))]);
  }

  /**
   * 這個地點的狀態（設定頁與 Adapter 健康狀態；不含內容）：快取裡有今天可用的資料 → ok（就算之後重查失敗，招呼仍用這份）；
   * 沒有可用資料而這個地點最近一次查詢失敗 → failed；其餘 none。
   */
  status(placeId: WeatherPlaceId): { state: Exclude<WeatherFetchState, "no_place">; at: number | null } {
    const c = this.current(placeId);
    if (c) return { state: "ok", at: c.fetched_at };
    if (this.last?.place === placeId && !this.last.ok) return { state: "failed", at: this.last.at };
    return { state: "none", at: null };
  }

  private async load(placeId: WeatherPlaceId): Promise<WeatherToday | null> {
    const place = weatherPlace(placeId);
    if (!place) return null;
    const timeout = AbortSignal.timeout(WEATHER_TIMEOUT_MS);
    const started = this.now();
    try {
      const res = await this.fetch(forecastUrl(place), { signal: timeout, headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new Error("回覆太大");
      const parsed = parseForecast(JSON.parse(text), placeId, localToday(new Date(this.now()), place.timeZone), this.now());
      if (!parsed) throw new Error("回覆看不懂或不是今天的資料");
      this.cached = parsed;
      this.last = { place: placeId, ok: true, at: this.now() };
      this.options.log?.(`天氣：Open-Meteo ${placeId} 已更新（${this.now() - started} ms）`);
      return parsed;
    } catch (err) {
      this.last = { place: placeId, ok: false, at: this.now() };
      this.options.log?.(`天氣：Open-Meteo ${placeId} 查詢失敗（${err instanceof Error ? err.message.slice(0, 120) : "unknown"}），這次不說天氣`);
      return null;
    }
  }
}

/**
 * CLK-1：GET /api/weather/now 的內容（右上角時鐘）。地點同主動提醒（選的或依系統時區推的）；和招呼共用 WeatherService 的
 * 快取，快取 30 分鐘內不另外查。天氣有沒有說出口的開關不影響這裡（這裡只是畫面上的讀數）。時區：地點的時區，沒有地點時核心的系統時區。
 */
export async function weatherNowView(options: {
  service: Pick<WeatherService, "refresh" | "current" | "status">;
  place: WeatherPlaceId | null;
  locale: Locale;
  now: () => number;
  systemTimeZone: string;
}): Promise<WeatherNowView> {
  const place = weatherPlace(options.place);
  const base = { place: place ? { id: place.id as WeatherPlaceId, label: options.locale === "en" ? place.en : place.zh } : null, attribution: WEATHER_ATTRIBUTION };
  if (!place) return { ...base, time_zone: options.systemTimeZone, server_now: options.now(), state: "no_place", weather: null };
  const id = place.id as WeatherPlaceId;
  await options.service.refresh(id);
  // refresh 失敗時仍可能有 2 小時內的快取（current）：照樣畫，頁面依 fetched_at 標「N 分鐘前」。
  const w = options.service.current(id);
  const state = options.service.status(id).state;
  return {
    ...base,
    time_zone: place.timeZone,
    server_now: options.now(),
    state,
    weather: w
      ? {
          date: w.date,
          code: w.now ? w.now.code : w.code,
          is_day: w.now ? w.now.is_day : true,
          temp_c: w.now ? w.now.temp_c : null,
          min_c: w.min_c,
          max_c: w.max_c,
          rain_percent: w.rain ? w.rain.percent : null,
          fetched_at: w.fetched_at,
        }
      : null,
  };
}
