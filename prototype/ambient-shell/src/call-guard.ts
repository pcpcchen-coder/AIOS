// 即時語音的費用防護（George 2026-11-06，docs/validation/realtime-cost-guard-2026-11-06.md）：兩條路徑（RealtimeVoice、LiveVoice）共用。
//  - 閒置：只有真的使用者一輪（非空、不是 prompt 回吐的使用者逐字稿、打字、工具與交辦結果、確認卡的回答、連上）才重新倒數。
//    上游的開口事件（speech_started）不算：電視或旁人的聲音會一直觸發它，通話就永遠不會結束。
//    回覆結束（response.done、遠端聲音停止）只有在上一次真的使用者一輪之後的第一次才重新倒數（credit，用一次就沒了），
//    所以雜音觸發的回覆不會無限延長通話。被轉成逐字稿的電視台詞仍算一輪（頁面分不出是誰說的）：每通的上限是最後的防線。
//  - 每通上限：從連上起算；到上限前 warnMs 先提醒一次，到上限就結束。核心另有同一個上限（加寬限），頁面沒結束時由核心掛斷。
//  - 回覆中、查資料、等確認時（busy）不算閒置：到時間時重新倒數一次（和之前相同）。上限不看 busy。

import { CALL_END_TEXT } from "../shared/realtime-route.ts";

/** 每通上限的預設（毫秒）；實際值來自 voice.json 的 realtime_max_call_s。 */
export const DEFAULT_MAX_CALL_MS = 20 * 60_000;

/** 費用防護結束通話時的字幕（兩條路徑共用；英文在 shared/messages.en.json）。 */
export const CALL_MAX_TEXT = CALL_END_TEXT.max_duration;

/** 到上限前多久提醒。 */
export const CALL_WARN_BEFORE_MS = 60_000;

export interface CallGuardHooks {
  /** 回覆中、工具或確認卡進行中：到閒置時間時重新倒數。 */
  busy(): boolean;
  /** 閒置時間到。 */
  idle(): void;
  /** 快到上限（剩下的毫秒數）。每通最多一次。 */
  warn(remainingMs: number): void;
  /** 到上限。 */
  max(): void;
}

export interface CallGuardOptions {
  idleMs: number;
  maxMs?: number;
  warnMs?: number;
  now?: () => number;
}

export class CallGuard {
  private idleMs: number;
  private maxMs: number;
  private readonly warnMs: number;
  private readonly now: () => number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private started: number | null = null;
  private warned = false;
  /** 上一次真的使用者一輪之後，還沒有回覆結束過。 */
  private credit = false;

  constructor(private readonly hooks: CallGuardHooks, options: CallGuardOptions) {
    this.idleMs = options.idleMs;
    this.maxMs = options.maxMs ?? DEFAULT_MAX_CALL_MS;
    this.warnMs = options.warnMs ?? CALL_WARN_BEFORE_MS;
    this.now = options.now ?? Date.now;
  }

  get running(): boolean {
    return this.started !== null;
  }

  /** 連上的時間（epoch ms）；還沒開始或已停止時為 null。 */
  get startedAt(): number | null {
    return this.started;
  }

  get maxCallMs(): number {
    return this.maxMs;
  }

  /** 連上：開始閒置倒數與每通上限。 */
  start(): void {
    this.stop();
    this.started = this.now();
    this.warned = false;
    this.credit = false;
    this.armIdle();
    this.armCap();
  }

  stop(): void {
    for (const timer of [this.idleTimer, this.warnTimer, this.maxTimer]) if (timer) clearTimeout(timer);
    this.idleTimer = this.warnTimer = this.maxTimer = null;
    this.started = null;
    this.credit = false;
  }

  /** 真的使用者一輪（或工具結果、確認卡的回答）：重新倒數，下一次回覆結束也算一次。 */
  activity(): void {
    if (!this.running) return;
    this.credit = true;
    this.armIdle();
  }

  /** 上一次真的使用者一輪之後，還沒有回覆結束過（這一輪的回覆是在回答使用者）。 */
  get credited(): boolean {
    return this.running && this.credit;
  }

  /**
   * 回覆結束：只有上一次真的使用者一輪之後的第一次才重新倒數。回傳這個回覆是不是在回答真的使用者一輪
   * （呼叫端據此決定它的工具結果算不算一輪）。
   */
  replyDone(): boolean {
    if (!this.running || !this.credit) return false;
    this.credit = false;
    this.armIdle();
    return true;
  }

  /** 同一個回覆中間的停頓（ChatGPT 方案的遠端聲音暫時變小）：有 credit 時重新倒數，但不用掉 credit。 */
  replyGap(): void {
    if (this.running && this.credit) this.armIdle();
  }

  /** 新的一輪開始了，但還不知道是不是真的使用者（開口事件）：之前那一輪的 credit 作廢。 */
  dropCredit(): void {
    this.credit = false;
  }

  /** 和之前的 setIdleMs 相同：值真的改變而且正在倒數時，從現在起重新倒數；同樣的值不延長。 */
  setIdleMs(ms: number): void {
    if (ms === this.idleMs) return;
    this.idleMs = ms;
    if (this.running && this.idleTimer) this.armIdle();
  }

  /** 每通上限改了：進行中的通話從它連上的時間重新算（已經提醒過的不再提醒）。 */
  setMaxMs(ms: number): void {
    if (ms === this.maxMs || !(ms > 0)) return;
    this.maxMs = ms;
    if (this.running) this.armCap();
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.running) return;
      if (this.hooks.busy()) {
        this.armIdle();
        return;
      }
      this.hooks.idle();
    }, this.idleMs);
  }

  private armCap(): void {
    if (this.warnTimer) clearTimeout(this.warnTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.warnTimer = this.maxTimer = null;
    const started = this.started;
    if (started === null) return;
    const left = Math.max(0, started + this.maxMs - this.now());
    // 上限改短到提醒時間之內：馬上提醒（還沒提醒過時）。
    if (!this.warned && this.warnMs > 0 && left > 0) {
      this.warnTimer = setTimeout(() => {
        this.warnTimer = null;
        if (!this.running || this.warned) return;
        this.warned = true;
        this.hooks.warn(Math.max(0, (this.started ?? 0) + this.maxMs - this.now()));
      }, Math.max(0, left - this.warnMs));
    }
    this.maxTimer = setTimeout(() => {
      this.maxTimer = null;
      if (this.running) this.hooks.max();
    }, left);
  }
}
