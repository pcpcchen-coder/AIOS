// F2／F10（ID-02 Mac 2026-10-31）：「連線中」與「就緒後、問候送出前」本機判斷使用者是不是已經開口。
// 即時語音的麥克風在連線開始時就已取得（getUserMedia），但 WebRTC 接通前聲音送不到伺服器：這段時間說的話伺服器聽不到，
// 也不會有 speech_started 或逐字稿，所以 Nous 會照常打招呼。這裡只讀本機麥克風的音量（AnalyserNode RMS，每 50 ms 一個數字），
// 連續夠久超過門檻就算「有人在說話」：取消這次招呼；連線中的話另外提示「還在連線，請稍後再說一次」。
// 不緩衝、不轉送、不保存聲音：每一格只留一個 RMS 數字比較門檻，樣本陣列每次覆寫，不寫檔、不進 log 或 trace、不送出。
// 門檻是估計值，沒有在 George 家中校準（F3 的環境雜音也可能超過它）；Mac 重測時記錄誤判。

/**
 * 超過這個 RMS 算有聲音（麥克風開了 echoCancellation／noiseSuppression／autoGainControl）。未校準；
 * 可以用 NOUS_EARLY_SPEECH_RMS（0.005–0.3，核心驗證後經設定交給頁面）覆寫。
 */
export const EARLY_SPEECH_RMS = 0.03;
/** 連續超過門檻這麼久才算開口（避免單一聲響，例如關門、杯子）。未校準。 */
export const EARLY_SPEECH_ON_MS = 300;

/** 連線中偵測到開口時的提示（共用翻譯表：src/messages.en.json）。不代為猜測使用者說了什麼。 */
export const CONNECTING_SPEECH_HINT = "還在連線，請稍後再說一次";

/** 開口偵測觸發時的一行 log：只有事件、階段與峰值 RMS，沒有任何聲音內容。 */
export function earlySpeechLogLine(phase: "connecting" | "pre-greeting", peak: number): string {
  return `[early-speech] detected phase=${phase} peak_rms=${peak.toFixed(3)}`;
}

/** 只判斷「有沒有持續的聲音」：餵 RMS，第一次確認時回 true（之後都回 false）。 */
export class EarlySpeech {
  private since: number | null = null;
  private fired = false;
  /** 這一段持續聲音的最大 RMS（只有一個數字；觸發時給 log 用）。 */
  private peakRms = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly threshold = EARLY_SPEECH_RMS,
    private readonly onMs = EARLY_SPEECH_ON_MS,
  ) {}

  get detected(): boolean {
    return this.fired;
  }

  /** 觸發的那一段聲音的峰值 RMS（沒觸發時是目前這一段的）。 */
  get peak(): number {
    return this.peakRms;
  }

  feed(rms: number): boolean {
    if (this.fired) return false;
    if (!(rms >= this.threshold)) {
      this.since = null;
      this.peakRms = 0;
      return false;
    }
    const t = this.now();
    if (this.since === null) this.since = t;
    this.peakRms = Math.max(this.peakRms, rms);
    if (t - this.since < this.onMs) return false;
    this.fired = true;
    return true;
  }
}
