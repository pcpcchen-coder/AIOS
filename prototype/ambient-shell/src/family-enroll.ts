// 家人登記的取樣（純邏輯，tests/family-enroll.test.ts 用假時間測）。頁面只收集特徵，送出後由核心檢查一致性、去重與確認。
// 規則（docs/14 §5、ADR-0001）：
// - 依序提示正面／稍左／稍右／抬頭／低頭；品質合格的畫格自動取樣，兩次取樣間隔至少 300 ms；收滿 ENROLL_TARGET 張就完成。
// - 中途畫面臉數不是 1，或相鄰兩格相隔超過 500 ms（追蹤斷開），整批丟棄重來，避免混到別人。
// - 品質不足（太小、側太多、太暗…）只是不取樣，不丟棄已取的樣本。

import { ENROLL_MAX_SAMPLES, ENROLL_MIN_SAMPLES, EVIDENCE_RULES, type QualityReason } from "../shared/identity.ts";

export const ENROLL_PROMPTS = ["請正面看鏡頭", "臉稍微轉向左邊", "臉稍微轉向右邊", "稍微抬頭", "稍微低頭"] as const;
/** 每位家人取幾張（5–10 之間）。 */
export const ENROLL_TARGET = 7;
export const ENROLL_MIN_INTERVAL_MS = 300;

export interface EnrollFrame {
  t: number;
  face_count: number;
  quality: QualityReason;
  feature?: Float32Array;
}

export type EnrollEvent =
  | { kind: "sampled"; count: number }
  | { kind: "waiting"; count: number; quality: QualityReason }
  /** 相鄰兩格隔太久（電腦忙、推論太慢），還沒有樣本可丟：照實說取不到樣本的原因。 */
  | { kind: "slow"; gap_ms: number }
  | { kind: "reset"; reason: "multi_face" | "lost" }
  | { kind: "done"; count: number };

export class EnrollmentCollector {
  private samples: Float32Array[] = [];
  private lastFrameAt: number | null = null;
  private lastSampleAt: number | null = null;

  constructor(readonly target = ENROLL_TARGET) {
    if (target < ENROLL_MIN_SAMPLES || target > ENROLL_MAX_SAMPLES) throw new Error(`target must be ${ENROLL_MIN_SAMPLES}–${ENROLL_MAX_SAMPLES}`);
  }

  get count(): number {
    return this.samples.length;
  }

  get done(): boolean {
    return this.samples.length >= this.target;
  }

  /** 目前該提示的姿勢（依已取的張數平均分配五個提示）。 */
  get prompt(): string {
    const i = Math.min(ENROLL_PROMPTS.length - 1, Math.floor((this.samples.length * ENROLL_PROMPTS.length) / this.target));
    return ENROLL_PROMPTS[i]!;
  }

  push(frame: EnrollFrame): EnrollEvent {
    if (this.done) return { kind: "done", count: this.samples.length };
    const previous = this.lastFrameAt;
    const gap = previous !== null && frame.t - previous > EVIDENCE_RULES.gap_ms;
    this.lastFrameAt = frame.t;
    if (frame.face_count > 1) {
      this.discard();
      return { kind: "reset", reason: "multi_face" };
    }
    if (frame.face_count === 0 || gap) {
      const had = this.samples.length > 0;
      const gapMs = previous === null ? 0 : frame.t - previous;
      this.discard();
      this.lastFrameAt = frame.t;
      if (had) return { kind: "reset", reason: "lost" };
      if (gap && frame.face_count > 0) return { kind: "slow", gap_ms: gapMs };
      return { kind: "waiting", count: 0, quality: "no_face" };
    }
    if (frame.quality !== "ok" || !frame.feature) return { kind: "waiting", count: this.samples.length, quality: frame.quality };
    if (this.lastSampleAt !== null && frame.t - this.lastSampleAt < ENROLL_MIN_INTERVAL_MS) return { kind: "waiting", count: this.samples.length, quality: "ok" };
    this.samples.push(Float32Array.from(frame.feature));
    this.lastSampleAt = frame.t;
    return this.done ? { kind: "done", count: this.samples.length } : { kind: "sampled", count: this.samples.length };
  }

  /** 送出用的樣本（一般陣列，經 IPC 傳給核心）。 */
  takeSamples(): number[][] {
    return this.samples.map((f) => Array.from(f));
  }

  /** 丟掉記憶體中的樣本（重新取樣、收起畫面、送出之後）。 */
  discard(): void {
    for (const f of this.samples) f.fill(0);
    this.samples = [];
    this.lastSampleAt = null;
    this.lastFrameAt = null;
  }
}
