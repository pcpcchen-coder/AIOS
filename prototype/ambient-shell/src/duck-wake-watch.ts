// DUCK-2：鴨子喚醒開始的通話「沒人出聲就結束」的計時。
// 鴨子終端的頁面不載入 src/audio（喚醒由鴨子本機偵測，這個頁面不做喚醒聆聽），所以這裡只看通話的階段，不碰任何音訊：
// - 通話進入 listening 時開始倒數；Nous 在想（thinking）或說話（speaking）時暫停，回到 listening 重新倒數；
// - 上游判斷使用者開口（hearing）：這通不再倒數；
// - 逾時只觸發一次 onTimeout（呼叫端結束通話）。
// 規則和 src/audio/wake-call.ts 的 WakeCallWatch 相同，少了音量門檻那一條（那需要麥克風的音量，屬於 src/audio）。
// 純邏輯，計時器可注入；測試見 tests/duck-terminal.test.ts。

export interface DuckWakeWatchOptions {
  timeoutMs: number;
  onTimeout(): void;
  /** 測試注入的計時器（預設 setTimeout／clearTimeout）。 */
  setTimer?(run: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class DuckWakeWatch {
  private timer: unknown = null;
  private done = false;

  constructor(private readonly options: DuckWakeWatchOptions) {}

  /** 通話的階段（RealtimePhase）。 */
  phase(phase: string): void {
    if (this.done) return;
    if (phase === "hearing") return this.disarm();
    this.cancel();
    if (phase !== "listening") return;
    const set = this.options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.timer = set(() => {
      this.timer = null;
      if (this.done) return;
      this.done = true;
      this.options.onTimeout();
    }, this.options.timeoutMs);
  }

  /** 使用者已經開口（或打字）：這通不再倒數。 */
  disarm(): void {
    this.done = true;
    this.cancel();
  }

  stop(): void {
    this.disarm();
  }

  private cancel(): void {
    if (this.timer === null) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
}
