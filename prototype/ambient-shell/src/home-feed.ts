import { HOME_CONTROL_FOLLOWUP_MS, HOME_FETCH_TIMEOUT_MS, HOME_REFRESH_MS, HOME_VIEW_STALE_MS, homeCornerModel, type HomeCornerModel, type HomeOverviewView } from "../shared/home-corner.ts";
import type { Locale } from "../shared/i18n.mjs";

// HOME-1：左上角家中狀態的資料與排程（不碰 DOM，可以在 node 測試）。和 ClockFeed 同一種做法：
// - 一次只有一個請求；最多等 HOME_FETCH_TIMEOUT_MS（請求不理會中止也一樣放手），之後一定重新排下一次（每 60 秒）。
// - 請求進行中又要求重讀（家電控制剛結束）：記下來，這次結束後立即再讀一次。家電控制後 8 秒再追讀一次。
// - 畫面上的資料超過 2 分鐘又正在重讀（從背景回來）：model 標 refreshing，數字淡化並標「更新中…」。
// - 向核心讀失敗：不沿用上一次的數字，改說讀不到。

export interface HomeFeedOptions {
  fetchOverview(signal: AbortSignal): Promise<HomeOverviewView>;
  onUpdate(): void;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export class HomeFeed {
  view: HomeOverviewView | null = null;
  coreDown = false;
  private active = false;
  private inflight = false;
  private pending = false;
  private refreshTimer: unknown = null;
  private followupTimer: unknown = null;
  /** view 是什麼時候讀到的（這台電腦的毫秒）。 */
  private fetchedAt: number | null = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: HomeFeedOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = options.now ?? Date.now;
  }

  /** 正在重讀而手上的資料已經超過 HOME_VIEW_STALE_MS。 */
  get refreshing(): boolean {
    return this.inflight && this.view !== null && this.fetchedAt !== null && this.now() - this.fetchedAt > HOME_VIEW_STALE_MS;
  }

  get loading(): boolean {
    return this.inflight;
  }

  get running(): boolean {
    return this.active;
  }

  resume(): void {
    this.active = true;
    void this.load();
  }

  /** 頁面隱藏、設定關閉：不再排下一次；進行中的請求結果照收，但不重排。 */
  pause(): void {
    this.active = false;
    this.pending = false;
    if (this.refreshTimer !== null) this.clearTimer(this.refreshTimer);
    this.refreshTimer = null;
    if (this.followupTimer !== null) this.clearTimer(this.followupTimer);
    this.followupTimer = null;
  }

  /** 家電控制有了結果：立即重讀，HOME_CONTROL_FOLLOWUP_MS 後再讀一次。 */
  afterControl(): void {
    if (!this.active) return;
    void this.load();
    if (this.followupTimer !== null) this.clearTimer(this.followupTimer);
    this.followupTimer = this.setTimer(() => {
      this.followupTimer = null;
      void this.load();
    }, HOME_CONTROL_FOLLOWUP_MS);
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
      }, this.options.timeoutMs ?? HOME_FETCH_TIMEOUT_MS);
    });
    try {
      this.view = await Promise.race([this.options.fetchOverview(controller.signal), timedOut]);
      this.fetchedAt = this.now();
      this.coreDown = false;
    } catch {
      this.view = null;
      this.coreDown = true;
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
    }, HOME_REFRESH_MS);
  }

  model(locale: Locale): HomeCornerModel {
    return homeCornerModel({ view: this.view, coreDown: this.coreDown, locale, refreshing: this.refreshing });
  }
}
