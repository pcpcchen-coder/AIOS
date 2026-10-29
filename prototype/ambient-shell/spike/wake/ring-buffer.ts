// WK-00：未喚醒音訊只留在記憶體的環形緩衝（docs/17 §5.2，預設 2 秒、16 kHz）。
// 這個類別刻意不提供序列化：toJSON 會丟錯，避免被 JSON.stringify 寫進報告、log 或 IPC。
// 讀出只給本機計算（例如偵測當下的音量），結束時呼叫 clear() 以 0 覆寫。

export const RING_SECONDS = 2;
export const SAMPLE_RATE = 16000;

export class AudioRing {
  readonly capacity: number;
  private readonly data: Float32Array;
  private write = 0;
  private filled = 0;
  /** 累計推入的樣本數（用來對照偵測器的時間戳）；不是緩衝內容。 */
  private total = 0;

  constructor(seconds = RING_SECONDS, sampleRate = SAMPLE_RATE) {
    if (!(seconds > 0) || !(sampleRate > 0)) throw new Error("seconds and sampleRate must be positive");
    this.capacity = Math.round(seconds * sampleRate);
    this.data = new Float32Array(this.capacity);
  }

  /** 推入新樣本，超過容量時覆寫最舊的。 */
  push(samples: Float32Array): void {
    this.total += samples.length;
    // 一次推入超過容量時，只有最後 capacity 個有意義
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

  /** 開始以來推入的樣本總數。 */
  get pushed(): number {
    return this.total;
  }

  /** 依時間順序讀出最後 n 個樣本（複本，只供本機計算）。 */
  latest(n = this.filled): Float32Array {
    const count = Math.max(0, Math.min(n, this.filled));
    const out = new Float32Array(count);
    const start = (this.write - count + this.capacity) % this.capacity;
    const first = Math.min(count, this.capacity - start);
    out.set(this.data.subarray(start, start + first), 0);
    if (first < count) out.set(this.data.subarray(0, count - first), first);
    return out;
  }

  /** 最後 n 個樣本的 RMS。 */
  rms(n: number): number {
    const tail = this.latest(n);
    if (tail.length === 0) return 0;
    let sum = 0;
    for (const v of tail) sum += v * v;
    tail.fill(0);
    return Math.sqrt(sum / tail.length);
  }

  /** 以 0 覆寫並歸零。 */
  clear(): void {
    this.data.fill(0);
    this.write = 0;
    this.filled = 0;
  }

  toJSON(): never {
    throw new Error("AudioRing must not be serialized");
  }
}
