// 即時語音通話在頁面生命週期上的費用防護（George 2026-11-06，docs/validation/realtime-cost-guard-2026-11-06.md）：
//  - macOS App（window.nousDesktop）：螢幕鎖定、睡眠就結束通話；視窗隱藏或收起不結束（George 預設，App 常駐在選單列）。
//  - 瀏覽器與 Raspberry Pi kiosk（沒有 nousDesktop）：頁面在背景超過 HIDDEN_END_MS 就結束；頁面關閉（pagehide）立刻結束。
//    背景計時跟著每一通：通話結束就取消，在背景中開始的通話從開始時算起。
//    Pi 的螢幕關掉不會讓 Chromium 變成背景：那時靠閒置、每通上限與核心的報到檢查（client_lost）。
//  - 兩種都每 ALIVE_INTERVAL_MS 向核心報到（POST /api/realtime/alive，API key 路徑附 usage），每次最多等 ALIVE_TIMEOUT_MS
//    （卡住的請求不擋之後的報到）。核心說這通已不存在（404）時先等 GONE_GRACE_MS：核心的 closed 事件（例如記憶撤銷後的重建、
//    或核心自己的結束原因）通常會先到；等完還是同一通、還開著才照實結束本機這一端。
// 主程式（src/main.ts）只把事件交進來，結束時用自己的 stopRealtime（同一套費用紀錄與結束流程）。

import { CALL_END_TEXT } from "../shared/realtime-route.ts";
import type { PageEndReason } from "../shared/voice-cost.ts";

export const HIDDEN_END_MS = 30_000;
export const ALIVE_INTERVAL_MS = 15_000;
/** 一次報到最多等多久（逾時當成網路錯誤，不結束通話）。 */
export const ALIVE_TIMEOUT_MS = 10_000;
/** 核心回 404 之後，等這麼久讓核心的 closed 事件先到，再確認同一通還開著才結束。 */
export const GONE_GRACE_MS = 1_500;

export type AliveOutcome = "ok" | "gone" | "error";

export interface CallLifecycleDeps {
  /** macOS App（有 window.nousDesktop）。 */
  desktop: boolean;
  /** 有通話（連線中或已連上）。 */
  active(): boolean;
  /** 已連上、可以報到（有工作階段憑證）。 */
  connected(): boolean;
  /** 目前這一通的識別（例如工作階段 ID）；沒有通話時 null。用來確認等待之後還是同一通。 */
  callKey(): string | null;
  /** 結束通話並顯示原因（reason 進費用紀錄）。keepalive：頁面正在關閉，結束的請求要在卸載後送達。 */
  stop(reason: PageEndReason | null, message: string, keepalive?: boolean): void;
  /** 向核心報到；signal 在 ALIVE_TIMEOUT_MS 後中止。 */
  alive(signal: AbortSignal): Promise<AliveOutcome>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export type PowerEventName = "lock" | "suspend" | "resume" | "unlock";

export class CallLifecycle {
  private hiddenTimer: unknown = null;
  private aliveTimer: unknown = null;
  private checking = false;
  private hidden = false;
  /** 上一次 sync 時有沒有通話（偵測通話開始與結束）。 */
  private wasActive = false;

  constructor(private readonly deps: CallLifecycleDeps) {}

  private set(fn: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(fn, ms) : setTimeout(fn, ms);
  }

  private clear(timer: unknown): void {
    if (!timer) return;
    if (this.deps.clearTimer) this.deps.clearTimer(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }

  private cancelHidden(): void {
    this.clear(this.hiddenTimer);
    this.hiddenTimer = null;
  }

  /** 只有瀏覽器與 Pi：這一通在背景超過 HIDDEN_END_MS 就結束（計時綁在開始計時的那一通）。 */
  private armHidden(): void {
    if (this.deps.desktop || this.hiddenTimer || !this.hidden || !this.deps.active()) return;
    const key = this.deps.callKey();
    this.hiddenTimer = this.set(() => {
      this.hiddenTimer = null;
      if (this.deps.active() && this.deps.callKey() === key) this.deps.stop("hidden", CALL_END_TEXT.hidden);
    }, HIDDEN_END_MS);
  }

  /** document.visibilityState 改變。切分頁看一下（30 秒內回來）不會斷。 */
  visibility(hidden: boolean): void {
    this.hidden = hidden;
    if (!hidden) this.cancelHidden();
    else this.armHidden();
  }

  /** 畫面更新時呼叫（主程式的 render）：通話結束就取消這一通的背景計時；通話在背景中開始，從開始時算起。 */
  sync(hidden: boolean): void {
    this.hidden = hidden;
    const active = this.deps.active();
    if (!active && this.wasActive) this.cancelHidden();
    if (active && !this.wasActive) {
      this.cancelHidden();
      this.armHidden();
    }
    this.wasActive = active;
  }

  /** pagehide（關分頁、重新整理、離開）：瀏覽器與 Pi 立刻結束，結束的請求用 keepalive 送出。 */
  pageHide(): void {
    if (this.deps.desktop || !this.deps.active()) return;
    this.deps.stop("hidden", CALL_END_TEXT.hidden, true);
  }

  /** App 的電源事件：鎖定、睡眠就結束通話（醒來、解鎖不自動重開）。 */
  power(event: PowerEventName): void {
    if (!this.deps.desktop || !this.deps.active()) return;
    if (event === "lock") this.deps.stop("os_lock", CALL_END_TEXT.os_lock);
    else if (event === "suspend") this.deps.stop("suspend", CALL_END_TEXT.suspend);
  }

  /** 開始定期報到（可重複呼叫）。 */
  startAlive(): void {
    if (this.aliveTimer) return;
    const tick = () => {
      this.aliveTimer = this.set(tick, ALIVE_INTERVAL_MS);
      void this.checkIn();
    };
    this.aliveTimer = this.set(tick, ALIVE_INTERVAL_MS);
  }

  stopAlive(): void {
    this.clear(this.aliveTimer);
    this.aliveTimer = null;
  }

  /**
   * 報一次到。最多等 ALIVE_TIMEOUT_MS（逾時當成網路錯誤）；網路錯誤不結束（閒置與上限仍在）。核心說這通已不存在時，
   * 等 GONE_GRACE_MS 再確認同一通還開著才結束本機這一端。
   */
  async checkIn(): Promise<void> {
    if (this.checking || !this.deps.connected()) return;
    this.checking = true;
    const key = this.deps.callKey();
    const abort = new AbortController();
    let timer: unknown = null;
    try {
      const timeout = new Promise<AliveOutcome>((resolve) => {
        timer = this.set(() => {
          abort.abort();
          resolve("error");
        }, ALIVE_TIMEOUT_MS);
      });
      const outcome = await Promise.race([this.deps.alive(abort.signal).catch((): AliveOutcome => "error"), timeout]);
      if (outcome === "gone") {
        this.set(() => {
          if (this.deps.active() && this.deps.callKey() === key) this.deps.stop(null, CALL_END_TEXT.gone);
        }, GONE_GRACE_MS);
      }
    } finally {
      this.clear(timer);
      this.checking = false;
    }
  }
}
