// 看著說話問候的時序（docs/14 §8 最後一段；Mac 實測用，docs/validation/family-id-02-2026-10-25.md §5）。
// 記錄真實事件的時間：在場確認、面向確認、互動啟動、語音就緒、問候決策、實際首音（回覆中），對話結束或首音時印一行到
// DevTools console。只有相對毫秒，不含姓名、person_id、分數或任何影像資料，也不寫檔、不送出。
// 「面向確認」是 AttentionTracker 已持續 300 ms 之後的事件；「在場確認」是 PresenceTracker 連續 500 ms 之後的事件。

export type LookStage = "present" | "facing" | "start" | "ready" | "decided" | "first_audio";

const LABEL: Record<LookStage, string> = {
  present: "在場確認",
  facing: "面向確認",
  start: "互動啟動",
  ready: "語音就緒",
  decided: "問候決策",
  first_audio: "首音",
};
const ORDER: LookStage[] = ["present", "facing", "start", "ready", "decided", "first_audio"];

export class LookTimeline {
  private marks: Partial<Record<LookStage, number>> = {};
  /** 看著說話開始了一次互動，還沒印出。 */
  private active = false;

  constructor(
    private readonly now: () => number,
    private readonly report: (line: string) => void,
  ) {}

  mark(stage: LookStage): void {
    const t = this.now();
    if (!this.active) {
      if (stage === "present") this.marks = { present: t };
      else if (stage === "facing") this.marks.facing = t;
      else if (stage === "start") {
        this.active = true;
        this.marks.start = t;
      }
      return;
    }
    if (stage === "present" || stage === "facing" || stage === "start" || this.marks[stage] !== undefined) return;
    this.marks[stage] = t;
    if (stage === "first_audio") this.flush();
  }

  /** 對話結束（沒有首音也印出已有的部分）。 */
  end(): void {
    if (this.active) this.flush();
  }

  /** 以面向確認為 0（沒有時用互動啟動）的一行文字。 */
  line(): string {
    const zero = this.marks.facing ?? this.marks.start ?? 0;
    const parts = ORDER.map((stage) => {
      const t = this.marks[stage];
      if (t === undefined) return `${LABEL[stage]} —`;
      const d = Math.round(t - zero);
      return `${LABEL[stage]} ${d > 0 ? "+" : ""}${d} ms`;
    });
    return `[看著說話時序] ${parts.join("｜")}（以面向確認為 0）`;
  }

  private flush(): void {
    this.report(this.line());
    this.active = false;
    this.marks = {};
  }
}
