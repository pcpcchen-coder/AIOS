// 常駐喚醒聆聽（WK-01a）：把 AudioContext 的取樣率（Mac 通常 48 kHz）轉成 KWS 要的 16 kHz 單聲道。
// 串流版：保留上一塊的最後一個樣本與小數相位，塊與塊之間不會跳。先以視窗化 sinc FIR 低通（截止 0.9 × 8 kHz）防混疊，
// 低通的歷史也跨塊保留。只在 worker 內執行，輸出用完由呼叫端以 0 覆寫。

export class StreamResampler {
  private readonly step: number;
  private readonly taps: Float32Array;
  /** 低通的歷史樣本（上一塊的尾端）。 */
  private readonly history: Float32Array;
  private phase = 0;
  private prev = 0;

  constructor(readonly from: number, readonly to = 16000, tapCount = 31) {
    if (!(from > 0 && to > 0)) throw new Error("sample rates must be positive");
    this.step = from / to;
    this.taps = from > to ? lowpassTaps((0.9 * to) / 2 / from, tapCount) : new Float32Array([1]);
    this.history = new Float32Array(this.taps.length - 1);
  }

  /** 推入一塊原始樣本，回傳轉好的 16 kHz 樣本（新陣列）。 */
  push(input: Float32Array): Float32Array {
    const filtered = this.filter(input);
    if (this.from === this.to) return filtered;
    const out: number[] = [];
    // 位置 x 以「上一塊最後一個樣本」為 -1：x 在 [-1, 0) 時用 prev 與 filtered[0] 內插。
    let x = this.phase;
    while (x < filtered.length - 1 + 1e-9) {
      const i0 = Math.floor(x);
      const frac = x - i0;
      const a = i0 < 0 ? this.prev : filtered[i0]!;
      const b = filtered[Math.min(i0 + 1, filtered.length - 1)]!;
      out.push(a + (b - a) * frac);
      x += this.step;
    }
    this.phase = x - filtered.length;
    if (filtered.length > 0) this.prev = filtered[filtered.length - 1]!;
    filtered.fill(0);
    return Float32Array.from(out);
  }

  /** 清空跨塊的狀態（停用、清空緩衝時）。 */
  reset(): void {
    this.history.fill(0);
    this.phase = 0;
    this.prev = 0;
  }

  private filter(input: Float32Array): Float32Array {
    const n = this.taps.length;
    if (n === 1) return Float32Array.from(input);
    const h = this.history.length;
    const joined = new Float32Array(h + input.length);
    joined.set(this.history, 0);
    joined.set(input, h);
    const out = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += this.taps[k]! * joined[i + k]!;
      out[i] = acc;
    }
    this.history.set(joined.subarray(joined.length - h));
    joined.fill(0);
    return out;
  }
}

/** 視窗化 sinc FIR 低通（Hamming）；cutoff 為相對取樣率的比例（0–0.5）。 */
export function lowpassTaps(cutoff: number, taps: number): Float32Array {
  const half = (taps - 1) / 2;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - half;
    const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * hamming;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i]! /= sum;
  return h;
}
