import type { ToolResult } from "../../shared/integrations.ts";
import type { PresenceState } from "../../shared/duck-link.ts";

// presence：把「Nous 語音工作階段真的發生的事」轉成 duck-link 的 presence 指令（鴨子本機決定怎麼演）。
// DUCK-1 原則：只由真實事件驅動，不演沒有發生的事；不是模型工具。
//
// 輸入事件的形狀對照核心與頁面現有的訊號：
//   phase            頁面的 RealtimePhase（src/realtime.ts:32）：off／connecting／listening／hearing／thinking／speaking
//   session_started  RealtimeSessions.start() 的 source（user／look_to_talk／wake_word）
//   session_ended    finish(session, reason) 與 LiveCloseReason
//   working          delegation started／finished、背景任務執行中
//   speech_level     頁面量到的助理語音 RMS（src/live-voice.ts 的 browserWatchLevel；原始 RMS，不是 0～1）
//   sleep            目前 AIOS 沒有對應的語音概念（最接近的是日夜模式與終端螢幕關閉）；先留介面
// AIOS 核心目前拿不到 phase 與音量（只有頁面知道），所以這些事件現在只有「開發用手動來源」會送。

export type VoicePhase = "off" | "connecting" | "listening" | "hearing" | "thinking" | "speaking";

export type VoiceSessionEvent =
  | { kind: "session_started"; source: "user" | "look_to_talk" | "wake_word" }
  | { kind: "phase"; phase: VoicePhase }
  | { kind: "working"; active: boolean }
  | { kind: "speech_level"; rms: number }
  | { kind: "session_ended"; reason: string }
  | { kind: "sleep"; asleep: boolean };

/** 工作階段因為這些原因結束時，鴨子先表現 error 再回 idle（AIOS 的 LiveCloseReason 與 finish 的原因）。 */
export const ERROR_END_REASONS: readonly string[] = ["connection_lost", "auth", "usage_limit", "error", "connect_failed"];

export interface PresenceSource {
  /** 給人看的來源名稱（診斷用）。 */
  readonly label: string;
  /** true＝開發用的假來源，不是 Nous 的真實事件。 */
  readonly dev: boolean;
  subscribe(listener: (event: VoiceSessionEvent) => void): () => void;
}

export interface PresenceDriverOptions {
  /** 送出 presence（通常是 DuckAdapter.presence）。 */
  send: (state: PresenceState, speechLevel?: number) => Promise<ToolResult>;
  /** 狀態要穩定這麼久才送出（去抖動；wake 與 error 不等）。 */
  debounceMs?: number;
  /** wake 至少維持多久才換下一個狀態。 */
  wakeHoldMs?: number;
  /** error 維持多久後回到 idle。 */
  errorHoldMs?: number;
  /** speech_level 最短的送出間隔。 */
  levelIntervalMs?: number;
  /** speech_level 至少變化這麼多才送。 */
  levelStep?: number;
  /** RMS 多大算滿格（未校準的初始值；AIOS 頁面只有一個門檻 SPEAKING_RMS = 0.02）。 */
  fullScaleRms?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PresenceSent {
  state: PresenceState;
  speechLevel?: number;
  at: number;
  result: ToolResult;
}

/**
 * 語音工作階段事件 → presence 狀態 → 節流後送出。
 * 同一時間只有一則在路上；送出期間狀態又變了，只送最後一個（不排隊）。
 */
export class PresenceDriver {
  private readonly options: Required<Omit<PresenceDriverOptions, "send" | "log">> & Pick<PresenceDriverOptions, "send" | "log">;
  // 由事件累積的工作階段狀態
  private phase: VoicePhase = "off";
  private working = false;
  private asleep = false;
  private wakeUntil = 0;
  private errorUntil = 0;
  private level: number | undefined;

  private sent: { state: PresenceState; level: number | undefined; at: number } | null = null;
  private lastResult: PresenceSent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private readonly idleWaiters: (() => void)[] = [];
  private unsubscribe: (() => void) | null = null;
  source: { label: string; dev: boolean } | null = null;

  constructor(options: PresenceDriverOptions) {
    this.options = { debounceMs: 120, wakeHoldMs: 600, errorHoldMs: 1_500, levelIntervalMs: 200, levelStep: 0.1, fullScaleRms: 0.2, now: Date.now, ...options };
  }

  /** 接上一個事件來源（一次只有一個）。 */
  attach(source: PresenceSource): void {
    this.unsubscribe?.();
    this.source = { label: source.label, dev: source.dev };
    this.unsubscribe = source.subscribe((event) => this.handle(event));
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.timer = null;
    this.holdTimer = null;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** 目前依事件算出來、應該讓鴨子表現的狀態。 */
  target(): PresenceState {
    const now = this.options.now();
    if (now < this.errorUntil) return "error";
    if (this.phase === "off") return this.asleep ? "sleeping" : "idle";
    if (now < this.wakeUntil) return "wake";
    if (this.phase === "speaking") return "speaking";
    if (this.phase === "listening" || this.phase === "hearing") return "listening";
    // connecting 與 thinking：有工具或任務在跑就是 working。
    return this.working ? "working" : "thinking";
  }

  handle(event: VoiceSessionEvent): void {
    if (this.stopped) return;
    const now = this.options.now();
    let immediate = false;
    switch (event.kind) {
      case "session_started":
        this.asleep = false;
        this.errorUntil = 0;
        if (this.phase === "off") this.phase = "connecting";
        if (event.source === "wake_word") {
          this.wakeUntil = now + this.options.wakeHoldMs;
          immediate = true;
        }
        break;
      case "phase":
        this.phase = event.phase;
        if (event.phase !== "speaking") this.level = undefined;
        if (event.phase === "off") this.working = false;
        break;
      case "working":
        this.working = event.active;
        break;
      case "speech_level":
        if (this.phase !== "speaking" || !Number.isFinite(event.rms)) return;
        // 量化到 0.05，避免每個取樣都觸發。
        this.level = Math.round(Math.min(1, Math.max(0, event.rms / this.options.fullScaleRms)) * 20) / 20;
        break;
      case "session_ended":
        this.phase = "off";
        this.working = false;
        this.level = undefined;
        this.wakeUntil = 0;
        if (ERROR_END_REASONS.includes(event.reason)) {
          this.errorUntil = now + this.options.errorHoldMs;
          immediate = true;
        }
        break;
      case "sleep":
        this.asleep = event.asleep;
        break;
    }
    if (event.kind === "speech_level") this.schedule(this.levelDelay(), false);
    else this.schedule(immediate ? 0 : this.options.debounceMs);
  }

  /** 連線恢復後重送目前的狀態（鴨子重開或重連後不知道 Nous 在做什麼）。 */
  resend(): void {
    this.sent = null;
    this.schedule(0);
  }

  /** 等到沒有待送與在路上的 presence；回傳最後一次送出的內容與結果。 */
  async settled(): Promise<PresenceSent | null> {
    if (this.timer || this.inFlight || this.dirty) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    return this.lastResult;
  }

  get last(): PresenceSent | null {
    return this.lastResult;
  }

  private levelDelay(): number {
    const since = this.sent ? this.options.now() - this.sent.at : Infinity;
    return Math.max(0, this.options.levelIntervalMs - since);
  }

  /** restart=false：已經有更早的計時器在等就不動它（音量更新不能把狀態改變往後推）。 */
  private schedule(delayMs: number, restart = true): void {
    if (this.stopped) return;
    this.dirty = true;
    const due = this.options.now() + delayMs;
    if (this.timer && !restart && this.due <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return; // 送完後會再檢查 dirty
    this.dirty = false;
    const now = this.options.now();
    const state = this.target();
    const level = state === "speaking" ? this.level : undefined;
    const stateChanged = !this.sent || this.sent.state !== state;
    const levelChanged = level !== undefined && (this.sent?.level === undefined || Math.abs(level - this.sent.level) >= this.options.levelStep);
    if (stateChanged || levelChanged) {
      this.sent = { state, level, at: now };
      this.inFlight = this.options
        .send(state, level)
        .then((result) => {
          this.lastResult = { state, ...(level !== undefined ? { speechLevel: level } : {}), at: now, result };
          // 沒送到（鴨子沒連線等）：忘掉「已送出」，下次事件或重連時再送。
          if (result.status === "failed" || result.status === "refused") this.sent = null;
        })
        .catch((error: unknown) => {
          this.sent = null;
          this.options.log?.(`presence 送出失敗：${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.inFlight = null;
        });
      await this.inFlight;
    }
    // 送出期間又有事件：已經有計時器在等就讓它處理，否則立刻再跑一次。
    if (this.dirty) {
      if (!this.timer) this.schedule(0);
      return;
    }
    // wake／error 的維持時間到了要自己往下走（不算在 settled() 的等待裡）。
    const remaining = Math.max(this.wakeUntil, this.errorUntil) - this.options.now();
    if (remaining > 0) {
      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.schedule(0);
      }, remaining);
    }
    if (this.timer) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
}
