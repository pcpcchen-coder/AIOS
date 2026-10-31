// 喚醒開始的通話：沒有人出聲就自動結束（docs/17 §5.7 第 2 點；WK-02 接上 WK-01a 交付的 NoVoiceWatchdog）。
// George 2026-10-31：使用者沉默 5 秒就結束。規則（純邏輯，時鐘與計時器可注入，測試見 tests/wake-call.test.ts）：
// - 通話第一次進入 listening 時開始倒數；Nous 在說話（speaking）或思考（thinking）時暫停，回到 listening 時重新倒數 5 秒；
// - 聽到聲音（feed 的 RMS 超過門檻一段時間）、伺服器判斷使用者開口（hearing）或使用者打字：這通不再倒數（disarm）；
// - 逾時只觸發一次 onTimeout（呼叫端結束通話、顯示字幕，喚醒聆聽在麥克風歸還後自己回到 listening_local）。
// 誠實說明：判斷的是音量門檻，不是 VAD，分不出人聲與電視；電視開著時可能不會逾時（17 §5.7）。不保存任何樣本，只看 RMS 數字。

import { NO_VOICE_TIMEOUT_MS, NoVoiceWatchdog } from "./no-voice.ts";

/** 每隔多久檢查一次是否逾時（音量也會在每次 feed 時檢查）。 */
export const WAKE_CALL_TICK_MS = 250;

export type WakeCallState = "idle" | "counting" | "paused" | "disarmed" | "timed_out" | "stopped";

export interface WakeCallOptions {
  now(): number;
  /** 週期計時器（預設 setInterval）；回傳取消。測試注入假的。 */
  every?(run: () => void, ms: number): () => void;
  /** 沉默多久就結束（預設 5 秒）。 */
  timeoutMs?: number;
  /** RMS 門檻（預設與即時語音的開口偵測相同，未校準）。 */
  rms?: number;
  onTimeout(): void;
}

export class WakeCallWatch {
  private readonly watchdog: NoVoiceWatchdog;
  private value: WakeCallState = "idle";
  private cancelTick: (() => void) | null = null;

  constructor(private readonly options: WakeCallOptions) {
    this.watchdog = new NoVoiceWatchdog({
      now: options.now,
      timeoutMs: options.timeoutMs ?? NO_VOICE_TIMEOUT_MS,
      ...(options.rms !== undefined ? { rms: options.rms } : {}),
      onTimeout: () => this.fire(),
    });
  }

  get state(): WakeCallState {
    return this.value;
  }

  /** 通話階段（RealtimePhase：off／connecting／listening／hearing／thinking／speaking）。 */
  phase(phase: string): void {
    if (this.finished()) return;
    if (phase === "listening") {
      if (this.value === "counting") return;
      this.watchdog.start();
      this.value = "counting";
      this.startTick();
    } else if (phase === "hearing") {
      this.disarm();
    } else if (phase === "speaking" || phase === "thinking") {
      if (this.value !== "counting") return;
      this.watchdog.stop();
      this.stopTick();
      this.value = "paused";
    }
  }

  /** 麥克風音量（RMS，約每 50 ms 一次）；聽到聲音就不再倒數。 */
  feed(rms: number): void {
    if (this.value !== "counting") return;
    if (this.watchdog.feed(rms)) this.disarm();
  }

  /** 計時器呼叫（也可由測試直接呼叫）。 */
  check(): void {
    if (this.value === "counting") this.watchdog.check();
  }

  /** 使用者開口或打字：這通不再自動結束。 */
  disarm(): void {
    if (this.finished()) return;
    this.halt("disarmed");
  }

  /** 通話結束：停止一切（可重複呼叫）。 */
  stop(): void {
    if (this.value === "stopped") return;
    this.halt("stopped");
  }

  private finished(): boolean {
    return this.value === "disarmed" || this.value === "timed_out" || this.value === "stopped";
  }

  private halt(state: WakeCallState): void {
    this.watchdog.stop();
    this.stopTick();
    this.value = state;
  }

  private fire(): void {
    if (this.value !== "counting") return;
    this.halt("timed_out");
    this.options.onTimeout();
  }

  private startTick(): void {
    if (this.cancelTick) return;
    const every = this.options.every ?? ((run: () => void, ms: number) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    });
    this.cancelTick = every(() => this.check(), WAKE_CALL_TICK_MS);
  }

  private stopTick(): void {
    const cancel = this.cancelTick;
    this.cancelTick = null;
    cancel?.();
  }
}
