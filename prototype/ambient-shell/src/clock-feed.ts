import {
  clockAnchor,
  clockAriaLabel,
  clockNow,
  clockParts,
  clockWeatherRow,
  CLOCK_DRIFT_RELOAD_MS,
  CLOCK_FETCH_TIMEOUT_MS,
  CLOCK_RETRY_MS,
  CLOCK_WEATHER_REFRESH_MS,
  formatClock,
  type ClockAnchor,
  type ClockWeather,
  type ClockWeatherRow,
  type WeatherNowView,
} from "../shared/clock.ts";
import type { Locale } from "../shared/i18n.mjs";

// CLK-1：右上角時鐘的資料與排程（不碰 DOM，可以在 node 測試）：向核心讀時區、核心時間與天氣，算出這一分鐘要畫什麼。
// - 一次只有一個請求；最多等 CLOCK_FETCH_TIMEOUT_MS（請求不理會中止也一樣放手），之後一定重新排下一次。
// - 請求進行中又要求重讀（例如換語言）：記下來，這次結束後立即再讀一次。
// - 時間＝核心時間的錨點＋單調時鐘經過的時間（clockNow），Pi 的牆上時鐘跳動不會讓偏移算兩次。
// - 每次算畫面時檢查：日期換了（過午夜）、或牆上時鐘與單調時鐘走的差距超過 30 秒（睡眠、對時）→ 立即重讀。

export interface ClockFeedOptions {
  fetchWeather(signal: AbortSignal): Promise<WeatherNowView>;
  /** 有新資料（或請求失敗）後呼叫：頁面重畫。 */
  onUpdate(): void;
  wall?: () => number;
  mono?: () => number;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ClockSnapshot {
  now: number;
  time: string;
  date: string;
  row: ClockWeatherRow;
  label: string;
}

export class ClockFeed {
  view: WeatherNowView | null = null;
  last: ClockWeather | null = null;
  timeZone: string | null = null;
  anchor: ClockAnchor | null = null;
  private active = false;
  private inflight = false;
  private pending = false;
  private refreshTimer: unknown = null;
  private seen: { wall: number; mono: number; date: string } | null = null;
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: ClockFeedOptions) {
    this.wall = options.wall ?? Date.now;
    this.mono = options.mono ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get loading(): boolean {
    return this.inflight;
  }

  /** 開始（設定打開、頁面回到前景）：立即讀一次，之後每 15 分鐘。 */
  resume(): void {
    this.active = true;
    void this.load();
  }

  /** 暫停（頁面隱藏、設定關閉）：不再排下一次；進行中的請求結果照收，但不重排。 */
  pause(): void {
    this.active = false;
    this.pending = false;
    if (this.refreshTimer !== null) this.clearTimer(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** 現在（核心時間校正後）。 */
  now(): number {
    return clockNow(this.wall(), this.mono(), this.anchor);
  }

  async load(): Promise<void> {
    if (!this.active) return;
    if (this.inflight) {
      this.pending = true;
      return;
    }
    this.inflight = true;
    if (this.refreshTimer !== null) this.clearTimer(this.refreshTimer);
    this.refreshTimer = null;
    const controller = new AbortController();
    let timeout: unknown = null;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = this.setTimer(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, this.options.timeoutMs ?? CLOCK_FETCH_TIMEOUT_MS);
    });
    const sent = this.mono();
    let ok = false;
    try {
      const view = await Promise.race([this.options.fetchWeather(controller.signal), timedOut]);
      const received = this.mono();
      this.view = view;
      this.timeZone = view.time_zone;
      this.anchor = clockAnchor(view.server_now, sent, received) ?? this.anchor;
      ok = true;
    } catch {
      // 核心連不上或逾時：保留時區、錨點與上一次的天氣（今天、2 小時內，標「N 分鐘前」），不顯示猜的天氣。
      this.view = null;
    } finally {
      this.clearTimer(timeout);
      this.inflight = false;
    }
    this.options.onUpdate();
    if (!this.active) return;
    if (this.pending) {
      this.pending = false;
      void this.load();
      return;
    }
    this.refreshTimer = this.setTimer(() => {
      this.refreshTimer = null;
      void this.load();
    }, ok ? CLOCK_WEATHER_REFRESH_MS : CLOCK_RETRY_MS);
  }

  /** 這一刻要畫的內容；還不知道時區時 null（不畫時鐘）。換日或時鐘跳動時順便要求重讀。 */
  snapshot(locale: Locale): ClockSnapshot | null {
    if (!this.timeZone) return null;
    const wall = this.wall();
    const mono = this.mono();
    const now = clockNow(wall, mono, this.anchor);
    const today = clockParts(now, this.timeZone).date;
    const prev = this.seen;
    this.seen = { wall, mono, date: today };
    if (prev && (prev.date !== today || Math.abs(wall - prev.wall - (mono - prev.mono)) > CLOCK_DRIFT_RELOAD_MS)) void this.load();
    const { time, date } = formatClock(now, this.timeZone, locale);
    const row = clockWeatherRow({ view: this.view, last: this.last, now, today, locale });
    if (row.used) this.last = row.used;
    return { now, time, date, row, label: clockAriaLabel(time, date, row, locale) };
  }
}
