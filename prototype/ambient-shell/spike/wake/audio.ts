// WK-00：音訊格式轉換（純函式）。只解析讀進記憶體的 WAV 位元組或麥克風的 PCM 串流，不寫任何音訊。

export interface Mono {
  sampleRate: number;
  samples: Float32Array;
}

/** 解析 RIFF/WAVE：PCM 16／24／32-bit 整數或 32-bit float，多聲道平均成單聲道。 */
export function parseWav(bytes: Uint8Array): Mono {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE：子格式 GUID 的前兩個位元組是實際格式
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (!channels || !sampleRate) throw new Error("data chunk before fmt chunk");
      const end = Math.min(bytes.length, body + size);
      return { sampleRate, samples: decode(view, body, end, format, channels, bits) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function decode(view: DataView, start: number, end: number, format: number, channels: number, bits: number): Float32Array {
  const bytesPer = bits / 8;
  const frames = Math.floor((end - start) / (bytesPer * channels));
  const out = new Float32Array(frames);
  const read = (o: number): number => {
    if (format === 3 && bits === 32) return view.getFloat32(o, true);
    if (format !== 1) throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
    if (bits === 16) return view.getInt16(o, true) / 32768;
    if (bits === 24) {
      const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
      return v / 8388608;
    }
    if (bits === 32) return view.getInt32(o, true) / 2147483648;
    throw new Error(`unsupported PCM ${bits}-bit`);
  };
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(start + (f * channels + c) * bytesPer);
    out[f] = sum / channels;
  }
  return out;
}

/** s16le 單聲道 PCM（麥克風串流）轉 float32；奇數個位元組時忽略最後一個（由呼叫端保留到下一塊）。 */
export function pcm16leToFloat32(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * 取樣率轉換：降頻時先以視窗化 sinc 低通（截止為目標奈奎斯特頻率的 0.9 倍），再線性內插。
 * 用於把 TTS（8 kHz／44.1 kHz）或麥克風轉成 16 kHz；品質足以做偵測評估，不是高傳真重取樣器。
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  if (!(from > 0 && to > 0)) throw new Error("sample rates must be positive");
  const src = to < from ? lowpass(samples, (0.9 * to) / 2 / from) : samples;
  const n = Math.floor((samples.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const a = src[i0] ?? 0;
    const b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 視窗化 sinc FIR 低通；cutoff 為相對取樣率的比例（0–0.5）。 */
export function lowpass(samples: Float32Array, cutoff: number, taps = 63): Float32Array {
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
  const out = new Float32Array(samples.length);
  for (let n = 0; n < samples.length; n++) {
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const idx = n + k - half;
      if (idx >= 0 && idx < samples.length) acc += h[k]! * samples[idx]!;
    }
    out[n] = acc;
  }
  return out;
}

/** 決定性的偽亂數（mulberry32），讓合成雜訊與音樂可以重現。 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 白噪音，振幅以 RMS 指定。 */
export function whiteNoise(seconds: number, rms: number, seed: number, sampleRate = 16000): Float32Array {
  const rand = prng(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const scale = rms * Math.sqrt(3); // 均勻分布 [-a, a] 的 RMS 為 a/√3
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * scale;
  return out;
}

/**
 * 合成「音樂」：和弦進行（每個和弦 2 秒）加上隨機旋律音，諧波以 1/k 衰減，音符有起音與衰減包絡。
 * 這是可重現的器樂代用品，不是真實的電視配樂或歌曲（沒有人聲）。
 */
export function syntheticMusic(seconds: number, rms: number, seed: number, sampleRate = 16000): Float32Array {
  const rand = prng(seed);
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const chords = [
    [261.63, 329.63, 392.0],
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
    [196.0, 246.94, 293.66],
  ];
  const note = (freq: number, startS: number, durS: number, amp: number) => {
    const s0 = Math.floor(startS * sampleRate);
    const len = Math.floor(durS * sampleRate);
    for (let i = 0; i < len && s0 + i < out.length; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t / 0.02) * Math.exp(-3 * (t / durS));
      let v = 0;
      for (let k = 1; k <= 4; k++) v += Math.sin(2 * Math.PI * freq * k * t) / k;
      out[s0 + i]! += amp * env * v;
    }
  };
  for (let t = 0, c = 0; t < seconds; t += 2, c++) {
    for (const f of chords[c % chords.length]!) note(f, t, 2, 0.15);
    for (let b = 0; b < 4; b++) note(chords[c % chords.length]![Math.floor(rand() * 3)]! * 2, t + b * 0.5, 0.45, 0.2);
  }
  let sum = 0;
  for (const v of out) sum += v * v;
  const cur = Math.sqrt(sum / Math.max(1, out.length));
  if (cur > 0) for (let i = 0; i < out.length; i++) out[i]! *= rms / cur;
  return out;
}

/** 以指定 SNR（dB，依整段 RMS）把雜訊加到語音上；回傳新陣列。 */
export function mixAtSnr(speech: Float32Array, noise: Float32Array, snrDb: number): Float32Array {
  const rmsOf = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
  const s = rmsOf(speech);
  const n = rmsOf(noise);
  const gain = n > 0 ? s / (n * 10 ** (snrDb / 20)) : 0;
  const out = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) out[i] = speech[i]! + gain * (noise[i % noise.length] ?? 0);
  return out;
}
