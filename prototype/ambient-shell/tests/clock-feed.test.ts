// CLK-1：右上角時鐘的資料與排程（ClockFeed，不碰 DOM）。假計時器、假的核心回應（fixture，不連網）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOCK_FETCH_TIMEOUT_MS, CLOCK_RETRY_MS, CLOCK_WEATHER_REFRESH_MS, type WeatherNowView } from "../shared/clock.ts";
import { ClockFeed } from "../src/clock-feed.ts";

/** 2026-11-07 23:58 台北。 */
const LATE = Date.parse("2026-11-07T15:58:00Z");
const MIN = 60_000;

const view = (over: Partial<WeatherNowView> = {}, serverNow = LATE): WeatherNowView => ({
  time_zone: "Asia/Taipei",
  server_now: serverNow,
  place: { id: "taipei", label: "台北" },
  state: "ok",
  weather: { date: "2026-11-07", code: 0, is_day: false, temp_c: 19.2, min_c: 18, max_c: 25, rain_percent: 10, fetched_at: serverNow },
  attribution: "Open-Meteo.com（CC BY 4.0）",
  ...over,
});

let clock: { wall: number; mono: number };
beforeEach(() => {
  vi.useFakeTimers();
  clock = { wall: LATE, mono: 0 };
});
afterEach(() => vi.useRealTimers());

function rig(fetchWeather: (signal: AbortSignal) => Promise<WeatherNowView>) {
  const updates = { n: 0 };
  const calls = vi.fn(fetchWeather);
  const feed = new ClockFeed({ fetchWeather: calls, onUpdate: () => updates.n++, wall: () => clock.wall, mono: () => clock.mono });
  return { feed, calls, updates };
}
const advance = async (ms: number) => {
  clock.wall += ms;
  clock.mono += ms;
  await vi.advanceTimersByTimeAsync(ms);
};

describe("ClockFeed", () => {
  it("a hung request is released after the timeout (signal aborted), reported as unreachable, and the next refresh is still scheduled", async () => {
    let seen: AbortSignal | null = null;
    let hang = true;
    const r = rig((signal) => {
      seen = signal;
      return hang ? new Promise<WeatherNowView>(() => {}) : Promise.resolve(view({}, clock.wall));
    });
    r.feed.resume();
    expect(r.feed.loading).toBe(true);
    await advance(CLOCK_FETCH_TIMEOUT_MS);
    expect(seen!.aborted).toBe(true);
    expect(r.feed.loading).toBe(false);
    expect(r.updates.n).toBe(1);
    expect(r.feed.snapshot("zh-TW")).toBeNull(); // 還沒有時區：不畫時鐘
    hang = false;
    await advance(CLOCK_RETRY_MS);
    expect(r.calls).toHaveBeenCalledTimes(2);
    expect(r.feed.snapshot("zh-TW")?.time).toBe("23:59");
    await advance(CLOCK_WEATHER_REFRESH_MS);
    expect(r.calls).toHaveBeenCalledTimes(3);
  });

  it("a reload requested during a fetch (language change) runs right after it finishes", async () => {
    let resolve: ((v: WeatherNowView) => void) | null = null;
    const r = rig(() => new Promise<WeatherNowView>((res) => (resolve = res)));
    r.feed.resume();
    void r.feed.load();
    void r.feed.load();
    expect(r.calls).toHaveBeenCalledTimes(1);
    resolve!(view({ place: { id: "taipei", label: "台北" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toHaveBeenCalledTimes(2);
    resolve!(view({ place: { id: "taipei", label: "Taipei" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(r.feed.view?.place?.label).toBe("Taipei");
    expect(r.calls).toHaveBeenCalledTimes(2);
  });

  it("midnight: yesterday's cached weather disappears at once and a reload is requested", async () => {
    const r = rig(() => Promise.resolve(view()));
    r.feed.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.feed.snapshot("zh-TW")?.row.kind).toBe("weather");
    await advance(2 * MIN); // 台北 11/8 00:00
    const snap = r.feed.snapshot("zh-TW")!;
    expect(snap.date).toBe("11月8日 週日");
    expect(snap.row).toMatchObject({ kind: "note", note: "天氣暫時無法取得" });
    // 不等 15 分鐘：換日立即重讀（refresh timer 還沒到也一樣）。
    expect(r.calls).toHaveBeenCalledTimes(2);
  });

  it("skew is anchored to the monotonic clock: a later wall-clock jump on the Pi is not applied twice and triggers a re-sync", async () => {
    clock.wall = LATE - 24 * 60 * MIN; // fake-hwclock：停在一天前
    const r = rig(() => Promise.resolve(view({}, LATE + clock.mono)));
    r.feed.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.feed.snapshot("en")).toMatchObject({ time: "23:58", date: "Sat, Nov 7" });
    await advance(30_000);
    clock.wall = LATE + 30_000; // NTP 對時，牆上時鐘跳回正確時間
    const snap = r.feed.snapshot("en")!;
    expect(snap.now).toBe(LATE + 30_000);
    expect(snap.time).toBe("23:58");
    // 牆上時鐘與單調時鐘走的差距超過 30 秒：重新向核心對時。
    expect(r.calls).toHaveBeenCalledTimes(2);
  });

  it("pause stops scheduling; resume reads again", async () => {
    const r = rig(() => Promise.resolve(view()));
    r.feed.resume();
    await vi.advanceTimersByTimeAsync(0);
    r.feed.pause();
    await advance(2 * CLOCK_WEATHER_REFRESH_MS);
    expect(r.calls).toHaveBeenCalledTimes(1);
    r.feed.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toHaveBeenCalledTimes(2);
  });
});
