// CLK-1（George 2026-11-07）：右上角時鐘的格式與天氣列（純函式；固定時刻、假的天氣資料，不連網）。
import { describe, expect, it } from "vitest";
import {
  clockAriaLabel,
  clockParts,
  clockAnchor,
  clockNow,
  clockWeatherRow,
  CLOCK_WEATHER_AGE_MS,
  CLOCK_WEATHER_KEEP_MS,
  formatClock,
  msUntilNextMinute,
  type ClockWeather,
  type WeatherNowView,
} from "../shared/clock.ts";

/** 2026-11-07 09:05 台北（UTC+8，星期六）。 */
const SAT_0905 = Date.parse("2026-11-07T01:05:00Z");
const MIN = 60_000;

const weather = (over: Partial<ClockWeather> = {}): ClockWeather => ({ date: "2026-11-07", code: 2, is_day: true, temp_c: 23.6, min_c: 18.2, max_c: 26.4, rain_percent: 20, fetched_at: SAT_0905, ...over });
const view = (over: Partial<WeatherNowView> = {}): WeatherNowView => ({
  time_zone: "Asia/Taipei",
  server_now: SAT_0905,
  place: { id: "taipei", label: "台北" },
  state: "ok",
  weather: weather(),
  attribution: "Open-Meteo.com（CC BY 4.0）",
  ...over,
});

describe("time and date in the core's time zone", () => {
  it("formats 24-hour time and the zh / en date with weekday (Asia/Taipei, not the machine's zone)", () => {
    expect(formatClock(SAT_0905, "Asia/Taipei", "zh-TW")).toEqual({ time: "09:05", date: "11月7日 週六" });
    expect(formatClock(SAT_0905, "Asia/Taipei", "en")).toEqual({ time: "09:05", date: "Sat, Nov 7" });
    // 同一個時刻在 UTC 是 01:05；頁面一律用核心給的時區。
    expect(formatClock(SAT_0905, "UTC", "en").time).toBe("01:05");
  });

  it("rolls the date over at local midnight, not UTC midnight", () => {
    const before = Date.parse("2026-11-07T15:59:00Z"); // 台北 23:59 星期六
    const after = Date.parse("2026-11-07T16:00:00Z"); // 台北 00:00 星期日
    expect(formatClock(before, "Asia/Taipei", "zh-TW")).toEqual({ time: "23:59", date: "11月7日 週六" });
    expect(formatClock(after, "Asia/Taipei", "zh-TW")).toEqual({ time: "00:00", date: "11月8日 週日" });
    expect(formatClock(after, "Asia/Taipei", "en")).toEqual({ time: "00:00", date: "Sun, Nov 8" });
    // UTC 換日時台北已是早上 8 點，日期不變。
    expect(formatClock(Date.parse("2026-11-08T00:00:00Z"), "Asia/Taipei", "zh-TW").date).toBe("11月8日 週日");
    expect(clockParts(after, "Asia/Taipei").date).toBe("2026-11-08");
  });

  it("waits until just past the next whole minute (no per-second timer)", () => {
    expect(msUntilNextMinute(SAT_0905)).toBe(60_050);
    expect(msUntilNextMinute(SAT_0905 + 59_000)).toBe(1_050);
    expect(msUntilNextMinute(SAT_0905 + 12_345)).toBe(47_705);
  });

  it("corrects the page clock only when it is more than 60 s off the core (anchor at the round-trip midpoint on the monotonic clock)", () => {
    const anchor = clockAnchor(SAT_0905, 1_000, 1_400)!;
    expect(anchor).toEqual({ server: SAT_0905, mono: 1_200 });
    // 牆上時鐘已對時（差 59 秒內）：用牆上時鐘。
    expect(clockNow(SAT_0905 + 10_000 + 59_000, 11_200, anchor)).toBe(SAT_0905 + 69_000);
    // Pi 慢了 5 分鐘：用核心時間＋經過的單調時間。
    expect(clockNow(SAT_0905 - 5 * MIN + 10_000, 11_200, anchor)).toBe(SAT_0905 + 10_000);
    expect(clockNow(SAT_0905, 0, null)).toBe(SAT_0905);
    expect(clockAnchor(Number.NaN, 0, 1)).toBeNull();
    expect(clockAnchor(SAT_0905, 5, 4)).toBeNull();
  });

  it("a later clock jump on the Pi (fake-hwclock → NTP) is not corrected twice", () => {
    // 對時前：Pi 的牆上時鐘停在一天前；錨點在單調時鐘 0。
    const anchor = clockAnchor(SAT_0905, 0, 0)!;
    const stale = SAT_0905 - 24 * 60 * MIN;
    expect(clockNow(stale + 30_000, 30_000, anchor)).toBe(SAT_0905 + 30_000);
    // NTP 把牆上時鐘跳回正確時間：立即改用牆上時鐘，不再加一天的偏移。
    expect(clockNow(SAT_0905 + 60_000, 60_000, anchor)).toBe(SAT_0905 + 60_000);
    expect(clockNow(SAT_0905 + 90_500, 90_000, anchor)).toBe(SAT_0905 + 90_500);
  });
});

describe("weather row (honest states)", () => {
  const today = "2026-11-07";

  it("ok: current temperature, icon, condition, then place · range · rain", () => {
    const row = clockWeatherRow({ view: view(), last: null, now: SAT_0905, today, locale: "zh-TW" });
    expect(row).toMatchObject({ kind: "weather", icon: { kind: "partly_cloudy", night: false }, main: "24°", condition: "多雲", detail: "台北 · 18°–26° · 降雨 20%", age: null });
    const en = clockWeatherRow({ view: view({ place: { id: "taipei", label: "Taipei" } }), last: null, now: SAT_0905, today, locale: "en" });
    expect(en).toMatchObject({ main: "24°", condition: "Partly cloudy", detail: "Taipei · 18°–26° · Rain 20%" });
    expect(clockAriaLabel("09:05", "Sat, Nov 7", en, "en")).toBe("Time, date, and weather: 09:05, Sat, Nov 7, 24°, Partly cloudy, Taipei · 18°–26° · Rain 20%");
  });

  it("night uses the moon icon; unknown codes keep the temperature without an icon or condition; no rain data drops the rain part", () => {
    expect(clockWeatherRow({ view: view({ weather: weather({ code: 0, is_day: false }) }), last: null, now: SAT_0905, today, locale: "zh-TW" }).icon).toEqual({ kind: "clear", night: true });
    const unknown = clockWeatherRow({ view: view({ weather: weather({ code: 1234, rain_percent: null }) }), last: null, now: SAT_0905, today, locale: "zh-TW" });
    expect(unknown).toMatchObject({ kind: "weather", icon: null, condition: null, main: "24°", detail: "台北 · 18°–26°" });
  });

  it("without a current temperature it shows today's range and labels the condition as today's, never as now", () => {
    const row = clockWeatherRow({ view: view({ weather: weather({ temp_c: null, code: 0 }) }), last: null, now: SAT_0905, today, locale: "zh-TW" });
    expect(row).toMatchObject({ main: "18°–26°", condition: "今日晴", detail: "台北 · 降雨 20%", icon: { kind: "clear", night: false } });
    expect(clockWeatherRow({ view: view({ weather: weather({ temp_c: null, code: 0 }) }), last: null, now: SAT_0905, today, locale: "en" }).condition).toBe("Today: clear");
  });

  it("adds the age after 45 minutes", () => {
    expect(clockWeatherRow({ view: view(), last: null, now: SAT_0905 + CLOCK_WEATHER_AGE_MS, today, locale: "zh-TW" }).age).toBeNull();
    expect(clockWeatherRow({ view: view(), last: null, now: SAT_0905 + 50 * MIN, today, locale: "zh-TW" }).age).toBe("50 分鐘前");
    expect(clockWeatherRow({ view: view(), last: null, now: SAT_0905 + 50 * MIN, today, locale: "en" }).age).toBe("50 min ago");
  });

  it("failed or unreachable: keeps the last value with its age for up to 2 hours, then says weather is unavailable", () => {
    const last = weather();
    const failed = view({ state: "failed", weather: null });
    const kept = clockWeatherRow({ view: failed, last, now: SAT_0905 + 10 * MIN, today, locale: "zh-TW" });
    expect(kept).toMatchObject({ kind: "weather", main: "24°", age: "10 分鐘前" });
    expect(clockWeatherRow({ view: null, last, now: SAT_0905 + CLOCK_WEATHER_KEEP_MS, today, locale: "zh-TW" }).age).toBe("120 分鐘前");
    const gone = clockWeatherRow({ view: failed, last, now: SAT_0905 + CLOCK_WEATHER_KEEP_MS + 1, today, locale: "zh-TW" });
    expect(gone).toMatchObject({ kind: "note", note: "天氣暫時無法取得", used: null });
    expect(clockWeatherRow({ view: null, last, now: SAT_0905 + CLOCK_WEATHER_KEEP_MS + 1, today, locale: "en" }).note).toBe("Weather is unavailable right now");
    // 昨天的資料不用（換日）。
    expect(clockWeatherRow({ view: failed, last, now: SAT_0905 + 10 * MIN, today: "2026-11-08", locale: "zh-TW" }).kind).toBe("note");
    expect(clockWeatherRow({ view: view({ state: "none", weather: null }), last: null, now: SAT_0905, today, locale: "zh-TW" }).note).toBe("天氣暫時無法取得");
    // 還沒有任何回應：什麼都不畫。
    expect(clockWeatherRow({ view: null, last: null, now: SAT_0905, today, locale: "zh-TW" }).kind).toBe("none");
  });

  it("never uses yesterday's data from the core either: after midnight the range and the 'today' label go at once", () => {
    const afterMidnight = Date.parse("2026-11-07T16:00:30Z"); // 台北 11/8 00:00
    const row = clockWeatherRow({ view: view(), last: weather(), now: afterMidnight, today: "2026-11-08", locale: "zh-TW" });
    expect(row).toMatchObject({ kind: "note", note: "天氣暫時無法取得", used: null });
    // 核心的資料超過 2 小時也一樣不用。
    expect(clockWeatherRow({ view: view(), last: null, now: SAT_0905 + CLOCK_WEATHER_KEEP_MS + 1, today, locale: "zh-TW" }).kind).toBe("note");
    // 核心給的資料日期不是今天、但頁面有今天的上一份：用上一份並標年紀。
    const kept = clockWeatherRow({ view: view({ weather: weather({ date: "2026-11-06" }) }), last: weather({ fetched_at: SAT_0905 - 20 * MIN }), now: SAT_0905, today, locale: "zh-TW" });
    expect(kept).toMatchObject({ kind: "weather", age: "20 分鐘前" });
  });

  it("no place: asks for a weather place instead of guessing", () => {
    const row = clockWeatherRow({ view: view({ state: "no_place", place: null, weather: null }), last: weather(), now: SAT_0905, today, locale: "zh-TW" });
    expect(row).toMatchObject({ kind: "note", note: "設定天氣地點後顯示天氣", used: null });
    expect(clockAriaLabel("09:05", "11月7日 週六", row, "zh-TW")).toBe("時間、日期與天氣：09:05，11月7日 週六，設定天氣地點後顯示天氣");
    expect(clockWeatherRow({ view: view({ state: "no_place", place: null, weather: null }), last: null, now: SAT_0905, today, locale: "en" }).note).toBe("Choose a weather place to show the weather");
  });

  it("rounds temperatures and never shows -0°", () => {
    expect(clockWeatherRow({ view: view({ weather: weather({ temp_c: -0.3, min_c: -2.6, max_c: 4.5 }) }), last: null, now: SAT_0905, today, locale: "en" })).toMatchObject({ main: "0°", detail: "台北 · -3°–5° · Rain 20%" });
  });
});
