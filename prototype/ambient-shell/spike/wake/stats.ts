// WK-00：統計與計算方式（純函式）。docs/validation/wk-00-spike-2026-10-29.md 的數字都由這裡算出。

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  /** nearest-rank：排序後取第 ceil(0.95·n) 個。 */
  p95: number;
  min: number;
  max: number;
}

/** nearest-rank 百分位數；p 介於 0 與 100。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("no values");
  if (!(p >= 0 && p <= 100)) throw new Error("p must be in [0, 100]");
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(1, Math.ceil((p / 100) * s.length)) - 1]!;
}

export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    min: s[0]!,
    max: s[s.length - 1]!,
  };
}

/** 每小時次數 = 次數 ÷ (秒數 ÷ 3600)。秒數為 0 時回傳 null，不假裝是 0。 */
export function perHour(count: number, seconds: number): number | null {
  if (!(seconds > 0)) return null;
  return count / (seconds / 3600);
}

/** 單核 CPU 比例 = CPU 時間（user+system，微秒）÷ 牆鐘時間（微秒）× 100。可超過 100（多執行緒）。 */
export function cpuPercent(cpuMicros: number, wallMicros: number): number | null {
  if (!(wallMicros > 0)) return null;
  return (cpuMicros / wallMicros) * 100;
}

/** 即時率 RTF = 處理牆鐘時間 ÷ 音訊長度。< 1 代表比即時快。 */
export function realTimeFactor(processingSeconds: number, audioSeconds: number): number | null {
  if (!(audioSeconds > 0)) return null;
  return processingSeconds / audioSeconds;
}

export interface TokenSpan {
  /** 第一個與最後一個發音單元的時間戳（秒，自串流開始）。 */
  first: number;
  last: number;
  /** last − first；sherpa-onnx 的時間戳是單元開始的幀，所以這比實際說出的長度短約一個單元。 */
  span: number;
}

export function tokenSpan(timestamps: readonly number[]): TokenSpan | null {
  if (timestamps.length === 0) return null;
  const first = Math.min(...timestamps);
  const last = Math.max(...timestamps);
  return { first, last, span: last - first };
}

/**
 * 從偵測位置推估喚醒詞長度：單元時間戳範圍＋最後一個單元的平均長度（span ÷ (單元數 − 1)）。
 * 只有一個單元時無法推估，回傳 null。這是推估，不是量測；實際長度以能量端點（speechBounds）對照。
 */
export function estimateKeywordSeconds(timestamps: readonly number[]): number | null {
  const ts = tokenSpan(timestamps);
  if (!ts || timestamps.length < 2) return null;
  return ts.span + ts.span / (timestamps.length - 1);
}

export interface SpeechBounds {
  start: number;
  end: number;
  duration: number;
}

/**
 * 能量端點偵測：以 frameMs 的幀計算 RMS，高於「最大幀 RMS × relative」的第一幀與最後一幀之間即為語音。
 * 用來量合成正例中喚醒詞實際說了多久，以及家人正例模式中說完的時間點。全靜音回傳 null。
 */
export function speechBounds(samples: Float32Array, sampleRate: number, frameMs = 10, relative = 0.1): SpeechBounds | null {
  const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(sum / (end - i)));
  }
  const peak = Math.max(0, ...rms);
  if (peak === 0) return null;
  const floor = peak * relative;
  const first = rms.findIndex((r) => r >= floor);
  let last = rms.length - 1;
  while (last > first && rms[last]! < floor) last--;
  const start = (first * frame) / sampleRate;
  const end = Math.min(samples.length, (last + 1) * frame) / sampleRate;
  return { start, end, duration: end - start };
}

export interface Expected {
  /** 正例在串流中的位置（秒）。 */
  start: number;
  end: number;
  keyword: string;
}

export interface DetectionAt {
  /** 偵測事件發生時已送進引擎的音訊長度（秒）。 */
  at: number;
  keyword: string;
}

export interface MatchResult {
  hits: { expected: Expected; detection: DetectionAt; latency: number }[];
  misses: Expected[];
  /** 不屬於任何正例窗口的偵測，或關鍵詞不同的偵測（算誤報）。 */
  falseAlarms: DetectionAt[];
}

/**
 * 正例比對：偵測時間落在 [start, end + tolerance] 且關鍵詞相同即為命中；同一正例只算第一次命中，
 * 之後的重複偵測算誤報（docs/17 §5.3 要求 3 秒內不重複觸發，所以重複也是要量的問題）。
 * latency = 偵測時間 − 正例結束時間（可為負：引擎在詞尾結束前就觸發）。
 */
export function matchDetections(expected: readonly Expected[], detections: readonly DetectionAt[], tolerance = 1.5): MatchResult {
  const hits: MatchResult["hits"] = [];
  const falseAlarms: DetectionAt[] = [];
  const used = new Set<number>();
  for (const d of [...detections].sort((a, b) => a.at - b.at)) {
    const i = expected.findIndex((e, idx) => !used.has(idx) && e.keyword === d.keyword && d.at >= e.start && d.at <= e.end + tolerance);
    if (i < 0) {
      falseAlarms.push(d);
      continue;
    }
    used.add(i);
    hits.push({ expected: expected[i]!, detection: d, latency: d.at - expected[i]!.end });
  }
  return { hits, misses: expected.filter((_, i) => !used.has(i)), falseAlarms };
}

/**
 * 樣本序號換算成牆鐘時間（毫秒）：以最近一塊到達的（樣本序號、時間）為錨，假設麥克風以即時速率產生樣本，
 * 往回推 (latest.sample − sample) ÷ rate 秒。管線緩衝造成的固定延遲不在內（由 sox 的 --buffer 決定）。
 */
export function sampleWallMs(latest: { sample: number; wall: number }, sample: number, rate: number): number {
  return latest.wall - ((latest.sample - sample) * 1000) / rate;
}

/** 家人正例模式的代號：1–4 個英文字母或數字，不接受名字。 */
export const PERSON_CODE = /^[A-Za-z0-9]{1,4}$/;

/** 依小時分桶計數（家中電視負例用）；startMs 是開始聆聽的時間。 */
export function hourlyBuckets(eventsMs: readonly number[], startMs: number, endMs: number): number[] {
  const hours = Math.max(1, Math.ceil((endMs - startMs) / 3_600_000));
  const buckets = new Array<number>(hours).fill(0);
  for (const t of eventsMs) {
    const h = Math.floor((t - startMs) / 3_600_000);
    if (h >= 0 && h < hours) buckets[h]! += 1;
  }
  return buckets;
}

/** 成功率 = 成功次數 ÷ 嘗試次數；沒有嘗試時回傳 null。 */
export function successRate(successes: number, attempts: number): number | null {
  return attempts > 0 ? successes / attempts : null;
}
