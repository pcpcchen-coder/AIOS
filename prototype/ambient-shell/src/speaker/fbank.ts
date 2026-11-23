// 家人聲音辨認（SP-01）：講者特徵模型（3D-Speaker CAM++ zh_en advanced）的前處理，移植自 SP-00 spike。
// Kaldi 風格 80 維 fbank：16 kHz、25 ms 窗、10 ms 位移、snip_edges=false（邊緣反射）、去直流、預強調 0.97、povey 窗、
// 512 點 FFT 的功率譜、mel 20–7600 Hz、log（下限 FLT_EPSILON），最後對整段做 global-mean（每一維減掉平均）。
// 2026-11-01 與 kaldi-native-fbank（sherpa-onnx 用的同一個函式庫）逐格比對，最大差 4e-4（docs/validation/sp-00-2026-11-01.md）。
// 只在 worker 內執行；輸入樣本與輸出特徵都由呼叫端用完以 0 覆寫，不保存、不轉送。

export const FBANK_SAMPLE_RATE = 16000;
export const FBANK_BINS = 80;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const LOW_FREQ = 20;
const HIGH_FREQ = FBANK_SAMPLE_RATE / 2 - 400;
const PREEMPH = 0.97;
const LOG_FLOOR = 1.1920928955078125e-7;

const melScale = (hz: number) => 1127 * Math.log(1 + hz / 700);

const POVEY = Float64Array.from({ length: FRAME_LENGTH }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1)), 0.85));

/** Kaldi MelBanks：mel 刻度上等距的三角濾波器，作用於 FFT bin 0..FFT_SIZE/2-1。每個濾波器只存非零的區段。 */
const MEL_BANKS: { start: number; weights: Float64Array }[] = (() => {
  const bins = FFT_SIZE / 2;
  const binWidth = FBANK_SAMPLE_RATE / FFT_SIZE;
  const low = melScale(LOW_FREQ);
  const delta = (melScale(HIGH_FREQ) - low) / (FBANK_BINS + 1);
  const banks = [];
  for (let b = 0; b < FBANK_BINS; b++) {
    const left = low + b * delta;
    const center = left + delta;
    const right = center + delta;
    const w = new Float64Array(bins);
    let first = -1;
    let last = -1;
    for (let i = 0; i < bins; i++) {
      const m = melScale(binWidth * i);
      if (m > left && m < right) {
        w[i] = m <= center ? (m - left) / (center - left) : (right - m) / (right - center);
        if (first < 0) first = i;
        last = i;
      }
    }
    banks.push({ start: Math.max(first, 0), weights: w.slice(Math.max(first, 0), last + 1) });
  }
  return banks;
})();

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** snip_edges=false 的幀數：每 10 ms 一幀，第一幀以 5 ms 為中心。 */
export function fbankFrameCount(samples: number): number {
  return Math.floor((samples + FRAME_SHIFT / 2) / FRAME_SHIFT);
}

/**
 * 16 kHz 單聲道樣本（[-1, 1]）→ [frames × 80] 的特徵（已減掉每一維的平均），列優先排列。
 * 少於一幀時回傳空陣列（呼叫端照實回報 too_short）。
 */
export function speakerFbank(samples: Float32Array): { features: Float32Array; frames: number } {
  const n = samples.length;
  const frames = n > 0 ? fbankFrameCount(n) : 0;
  const out = new Float32Array(frames * FBANK_BINS);
  if (frames === 0) return { features: out, frames };
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const win = new Float64Array(FRAME_LENGTH);
  for (let f = 0; f < frames; f++) {
    const start = f * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LENGTH / 2;
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      let s = start + i;
      // Kaldi 的邊緣反射（片段比一幀還短時可能要反射多次）
      while (s < 0 || s >= n) s = s < 0 ? -s - 1 : 2 * n - 1 - s;
      win[i] = samples[s]!;
      mean += win[i]!;
    }
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) win[i] = win[i]! - mean;
    for (let i = FRAME_LENGTH - 1; i > 0; i--) win[i] = win[i]! - PREEMPH * win[i - 1]!;
    win[0] = win[0]! - PREEMPH * win[0]!;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FRAME_LENGTH; i++) re[i] = win[i]! * POVEY[i]!;
    fftInPlace(re, im);
    for (let b = 0; b < FBANK_BINS; b++) {
      const { start: s0, weights } = MEL_BANKS[b]!;
      let energy = 0;
      for (let k = 0; k < weights.length; k++) {
        const i = s0 + k;
        energy += weights[k]! * (re[i]! * re[i]! + im[i]! * im[i]!);
      }
      out[f * FBANK_BINS + b] = Math.log(Math.max(energy, LOG_FLOOR));
    }
  }
  for (let b = 0; b < FBANK_BINS; b++) {
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += out[f * FBANK_BINS + b]!;
    mean /= frames;
    for (let f = 0; f < frames; f++) out[f * FBANK_BINS + b] = out[f * FBANK_BINS + b]! - mean;
  }
  win.fill(0);
  re.fill(0);
  im.fill(0);
  return { features: out, frames };
}

/** L2 正規化成新陣列；全 0 或含非有限值時回傳 null（不當成有效特徵）。 */
export function normalizeEmbedding(raw: ArrayLike<number>): Float32Array | null {
  let sum = 0;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    if (!Number.isFinite(v)) return null;
    sum += v * v;
  }
  if (!(sum > 0)) return null;
  const norm = Math.sqrt(sum);
  return Float32Array.from(raw, (v) => v / norm);
}
