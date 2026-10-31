// 常駐喚醒聆聽（WK-01a）的自我觸發防護（docs/17 §5.3）。純邏輯、時鐘可注入，假時鐘測試見 tests/wake-logic.test.ts。
// 以下期間偵測到喚醒詞一律丟掉（不播提示音、不觸發）：
// - Nous 用瀏覽器語音合成念話（speakText）期間，以及念完後 1.5 秒（起點值，WK-03 依實際回聲調整）；
// - 即時語音的遠端播放（trackedPlayRemote）期間；
// - 本機提示音播放期間。
// 另外，上一次被接受的喚醒之後 3 秒內不再接受（避免一次喚醒開兩次）。

export const SPEECH_TAIL_MS = 1500;
export const DEDUPE_MS = 3000;

export type GuardSource = "speech" | "playback" | "earcon";
export type GuardDrop = "speaking" | "speech_tail" | "playback" | "earcon" | "duplicate";

export class WakeGuard {
  private readonly active: Record<GuardSource, number> = { speech: 0, playback: 0, earcon: 0 };
  private speechEndedAt: number | null = null;
  private acceptedAt: number | null = null;

  constructor(
    private readonly now: () => number,
    private readonly speechTailMs = SPEECH_TAIL_MS,
    private readonly dedupeMs = DEDUPE_MS,
  ) {}

  /** 某個來源開始播放（可重疊；以計數處理巢狀）。 */
  begin(source: GuardSource): void {
    this.active[source]++;
  }

  /** 某個來源結束；多餘的 end 不會讓計數變負。語音合成結束時開始算 1.5 秒尾巴。 */
  end(source: GuardSource): void {
    if (this.active[source] === 0) return;
    this.active[source]--;
    if (source === "speech" && this.active.speech === 0) this.speechEndedAt = this.now();
  }

  /** 偵測事件到達時呼叫：可以接受就記下時間並回 null；否則回丟棄原因（不記時間，不延長去重）。 */
  check(): GuardDrop | null {
    const t = this.now();
    if (this.active.earcon > 0) return "earcon";
    if (this.active.speech > 0) return "speaking";
    if (this.active.playback > 0) return "playback";
    if (this.speechEndedAt !== null && t - this.speechEndedAt < this.speechTailMs) return "speech_tail";
    if (this.acceptedAt !== null && t - this.acceptedAt < this.dedupeMs) return "duplicate";
    this.acceptedAt = t;
    return null;
  }

  /** 全部歸零（停用時）。去重時間也清掉。 */
  reset(): void {
    this.active.speech = 0;
    this.active.playback = 0;
    this.active.earcon = 0;
    this.speechEndedAt = null;
    this.acceptedAt = null;
  }
}
