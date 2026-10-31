// 常駐喚醒聆聽（WK-01a）：未喚醒音訊只留在 worker 記憶體的 2 秒環形緩衝（docs/17 §5.2）。
// 移植自 WK-00 spike（spike/wake/ring-buffer.ts）。刻意不提供序列化：toJSON 會丟錯，避免被 JSON.stringify 寫進 log、trace 或 IPC；
// clear() 以 0 覆寫。停用、暫停、鎖定、睡眠、錯誤與通話中（in_call）都會清空（src/audio/front-end.ts 停止擷取時送 clear）。

export const RING_SECONDS = 2;
export const SAMPLE_RATE = 16000;

export class AudioRing {
  readonly capacity: number;
  private readonly data: Float32Array;
  private write = 0;
  private filled = 0;

  constructor(seconds = RING_SECONDS, sampleRate = SAMPLE_RATE) {
    if (!(seconds > 0) || !(sampleRate > 0)) throw new Error("seconds and sampleRate must be positive");
    this.capacity = Math.round(seconds * sampleRate);
    this.data = new Float32Array(this.capacity);
  }

  /** 推入新樣本，超過容量時覆寫最舊的。 */
  push(samples: Float32Array): void {
    const src = samples.length > this.capacity ? samples.subarray(samples.length - this.capacity) : samples;
    const first = Math.min(src.length, this.capacity - this.write);
    this.data.set(src.subarray(0, first), this.write);
    if (first < src.length) this.data.set(src.subarray(first), 0);
    this.write = (this.write + src.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + src.length);
  }

  /** 緩衝內目前的樣本數（≤ capacity）。 */
  get length(): number {
    return this.filled;
  }

  /** 依時間順序讀出最後 n 個樣本（複本，只供 worker 內本機計算；WK-01a 沒有使用者，SP-02 才複製喚醒片段給音色辨認）。 */
  latest(n = this.filled): Float32Array {
    const count = Math.max(0, Math.min(n, this.filled));
    const out = new Float32Array(count);
    const start = (this.write - count + this.capacity) % this.capacity;
    const first = Math.min(count, this.capacity - start);
    out.set(this.data.subarray(start, start + first), 0);
    if (first < count) out.set(this.data.subarray(0, count - first), first);
    return out;
  }

  /** 以 0 覆寫並歸零。 */
  clear(): void {
    this.data.fill(0);
    this.write = 0;
    this.filled = 0;
  }

  /** 檢查用：緩衝內是否全為 0（測試確認 clear 真的覆寫）。 */
  isZeroed(): boolean {
    return this.data.every((v) => v === 0);
  }

  toJSON(): never {
    throw new Error("AudioRing must not be serialized");
  }
}
