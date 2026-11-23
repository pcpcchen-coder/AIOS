// 家人聲音登記（SP-01）：一段錄音裡哪裡有人聲。純函式，只在 speaker worker 內用。
// 判斷的是**音量**（20 ms 一格的 RMS 高於「背景噪音的 3 倍」與一個絕對下限），不是語音模型，分不出人聲與電視；
// 所以登記畫面要求在安靜的地方錄。前後各留 100 ms，把有聲的片段接起來交給講者模型。

export const VAD_FRAME = 320; // 20 ms @ 16 kHz
const PAD_FRAMES = 5; // 100 ms
const ABS_FLOOR = 0.006;
const NOISE_RATIO = 3;

export interface VoicedResult {
  /** 接起來的有聲樣本（新陣列；呼叫端用完以 0 覆寫）。 */
  samples: Float32Array;
  /** 有聲的毫秒數（不含前後補的 100 ms）。 */
  voiced_ms: number;
  /** 最大的 20 ms RMS（太小聲時給畫面提示用）。 */
  peak_rms: number;
}

export function voicedSegments(x: Float32Array, sampleRate = 16000): VoicedResult {
  const frames = Math.floor(x.length / VAD_FRAME);
  if (frames === 0) return { samples: new Float32Array(0), voiced_ms: 0, peak_rms: 0 };
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * VAD_FRAME; i < (f + 1) * VAD_FRAME; i++) s += x[i]! * x[i]!;
    rms[f] = Math.sqrt(s / VAD_FRAME);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(frames * 0.2)]!;
  const threshold = Math.max(ABS_FLOOR, noise * NOISE_RATIO);
  const voiced = Array.from(rms, (r) => r > threshold);
  const keep = voiced.slice();
  for (let f = 0; f < frames; f++) {
    if (!voiced[f]) continue;
    for (let d = -PAD_FRAMES; d <= PAD_FRAMES; d++) if (f + d >= 0 && f + d < frames) keep[f + d] = true;
  }
  const kept = keep.filter(Boolean).length;
  const out = new Float32Array(kept * VAD_FRAME);
  let o = 0;
  for (let f = 0; f < frames; f++) {
    if (!keep[f]) continue;
    out.set(x.subarray(f * VAD_FRAME, (f + 1) * VAD_FRAME), o);
    o += VAD_FRAME;
  }
  const voicedFrames = voiced.filter(Boolean).length;
  return { samples: out, voiced_ms: Math.round((voicedFrames * VAD_FRAME * 1000) / sampleRate), peak_rms: sorted[frames - 1]! };
}
