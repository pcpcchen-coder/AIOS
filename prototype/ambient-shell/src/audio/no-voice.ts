// 常駐喚醒聆聽（WK-01a 交付、WK-02 才接到通話）：喚醒開始的通話就緒後，若 N 秒（起點 5 秒）內沒有「近場人聲」就自動結束（docs/17 §5.7）。
// 誠實說明：這裡判斷的是**音量門檻**（RMS 連續超過門檻一段時間），不是 VAD，分不出人聲與電視、音樂或關門聲。
// 電視開著時它可能一直以為有人在說話，所以只能縮短、不能消除誤喚醒的外傳時間。門檻與時間都未校準（WK-03 實測）。
// 每次只拿到一個 RMS 數字，不保存、不轉送任何樣本。時鐘可注入，假時鐘測試見 tests/wake-logic.test.ts。

import { EARLY_SPEECH_ON_MS, EARLY_SPEECH_RMS, EarlySpeech } from "../early-speech.ts";

export const NO_VOICE_TIMEOUT_MS = 5000;

export interface NoVoiceOptions {
  now: () => number;
  /** 沒有聲音多久算沒人說話（毫秒），起點 5 秒。 */
  timeoutMs?: number;
  /** RMS 門檻（與即時語音的開口偵測同一個預設，未校準）。 */
  rms?: number;
  /** 連續超過門檻多久才算有聲音。 */
  onMs?: number;
  /** 逾時（只呼叫一次）。 */
  onTimeout(): void;
}

export class NoVoiceWatchdog {
  private startedAt: number | null = null;
  private detector: EarlySpeech | null = null;
  private done = false;

  constructor(private readonly options: NoVoiceOptions) {}

  /** 通話就緒時開始倒數。 */
  start(): void {
    this.startedAt = this.options.now();
    this.done = false;
    this.detector = new EarlySpeech(this.options.now, this.options.rms ?? EARLY_SPEECH_RMS, this.options.onMs ?? EARLY_SPEECH_ON_MS);
  }

  get running(): boolean {
    return this.startedAt !== null && !this.done;
  }

  /** 餵一個 RMS 數字（例如每 50 ms 一次）。偵測到聲音就停止倒數；回傳是否已判定有聲音。 */
  feed(rms: number): boolean {
    if (!this.running || !this.detector) return false;
    if (this.detector.feed(rms)) {
      this.done = true;
      return true;
    }
    this.check();
    return false;
  }

  /** 計時器呼叫：超過 timeoutMs 還沒聽到聲音就逾時（只觸發一次）。 */
  check(): void {
    if (!this.running || this.startedAt === null) return;
    if (this.options.now() - this.startedAt < (this.options.timeoutMs ?? NO_VOICE_TIMEOUT_MS)) return;
    this.done = true;
    this.options.onTimeout();
  }

  stop(): void {
    this.startedAt = null;
    this.detector = null;
    this.done = false;
  }
}
