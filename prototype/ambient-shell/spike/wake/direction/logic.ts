// 喚醒方向性診斷（docs/validation/wake-direction-2026-11-08.md）的純邏輯：聲道混音規則、門檻位移、樣本分塊、
// 方向測試的統計（成功率、Wilson 95% 區間、方向差距、每小時誤觸）與結果的匯出／匯入。
// 不碰 DOM、不保存音訊；tests/wake-direction.test.ts 直接測。AudioWorklet（worklet.ts）也 import 這個檔案，所以不得用到 DOM。

import type { WakeKeywordConfig } from "../../../shared/wake.ts";

// ───────────── 測試格 ─────────────

/** 繞音箱 8 個方向（度，0° 是音箱正面：Type-C 孔的那一側，見文件 §5.1）。 */
export const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;
export const DISTANCES = ["1m", "3m"] as const;
export const POSITIVE_PHRASES = ["hello", "hey"] as const;
export const NEGATIVE_KINDS = ["tv", "chat"] as const;
/** 每格每個喚醒詞說幾次。 */
export const TRIALS_PER_CELL = 5;

export type Angle = (typeof ANGLES)[number];
export type Distance = (typeof DISTANCES)[number];
export type Phrase = (typeof POSITIVE_PHRASES)[number];
export type NegativeKind = (typeof NEGATIVE_KINDS)[number];

/** 完整一輪要說幾次：方向 × 距離 × 喚醒詞 × 每格次數（8 × 2 × 2 × 5 = 160）。 */
export function plannedTrials(): number {
  return ANGLES.length * DISTANCES.length * POSITIVE_PHRASES.length * TRIALS_PER_CELL;
}

// ───────────── 混音（產品目前的行為與替代方案） ─────────────

/**
 * 產品擷取（src/audio/capture.ts）的 AudioWorkletNode 設 channelCount 1、channelCountMode "explicit"、
 * channelInterpretation "speakers"：Web Audio 依喇叭規則把 N 聲道混成單聲道。規格只定義 1、2、4、6 聲道的混法；
 * 其他聲道數退回 "discrete"，混成單聲道時**只留第 1 聲道**、其餘丟掉（Web Audio API §Channel up-mixing and down-mixing）。
 */
export function productMixRule(channels: number): "copy" | "average" | "5.1" | "first_only" {
  if (channels <= 1) return "copy";
  if (channels === 2 || channels === 4) return "average";
  if (channels === 6) return "5.1";
  return "first_only";
}

/** 依 productMixRule 把 N 聲道混成單聲道（模擬產品；新陣列）。 */
export function productDownmix(input: readonly Float32Array[]): Float32Array {
  const n = input.length;
  const len = input[0]?.length ?? 0;
  const out = new Float32Array(len);
  if (n === 0) return out;
  const rule = productMixRule(n);
  if (rule === "copy" || rule === "first_only") {
    out.set(input[0]!);
    return out;
  }
  if (rule === "average") return averageMix(input);
  // 5.1 → mono：0.7071 × (L + R) + C + 0.5 × (SL + SR)；聲道順序 L R C LFE SL SR
  const [l, r, c, , sl, sr] = input as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
  for (let i = 0; i < len; i++) out[i] = Math.SQRT1_2 * (l[i]! + r[i]!) + c[i]! + 0.5 * (sl[i]! + sr[i]!);
  return out;
}

/** 所有聲道平均（替代方案：任何聲道數都不會丟掉聲道；新陣列）。 */
export function averageMix(input: readonly Float32Array[]): Float32Array {
  const len = input[0]?.length ?? 0;
  const out = new Float32Array(len);
  if (input.length === 0) return out;
  for (const ch of input) for (let i = 0; i < len; i++) out[i]! += ch[i]!;
  for (let i = 0; i < len; i++) out[i]! /= input.length;
  return out;
}

/** RMS（dBFS，以滿刻度 1.0 為 0 dB）；全 0 時 -Infinity。 */
export function rmsDbfs(samples: Float32Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** 峰值（絕對值）。 */
export function peak(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i]!));
  return p;
}

// ───────────── 偵測器變體 ─────────────

/** 送進某個偵測器的聲音來源：產品混音、全部平均（只在聲道數不是 1/2/4/6 時與產品不同），或單一聲道（0 起算）。 */
export type Source = { kind: "product" } | { kind: "average" } | { kind: "channel"; index: number };

export interface Variant {
  id: string;
  source: Source;
  /** 每一行關鍵詞門檻（含全域門檻）加上的位移；0 是產品設定。 */
  delta: number;
}

/** 門檻位移的選項（越大越嚴、越不容易觸發）。 */
export const THRESHOLD_DELTAS = [0.1, 0.05, 0, -0.05] as const;

export function sourceId(source: Source): string {
  return source.kind === "channel" ? `ch${source.index + 1}` : source.kind;
}

export function variantId(source: Source, delta: number): string {
  return `${sourceId(source)}${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(2)}`;
}

/**
 * 依實際送到 Web Audio 的聲道數排出偵測器：產品混音 × 每個選定的門檻位移；多聲道時另加每一聲道（產品門檻），
 * 聲道數不是 1/2/4/6 時另加「全部平均」。上限 maxDetectors（每個偵測器各跑一次 KWS，CPU 約成正比）。
 */
export function planVariants(channels: number, deltas: readonly number[], perChannel: boolean, maxDetectors = 10): Variant[] {
  const list: Variant[] = [];
  const add = (source: Source, delta: number) => {
    if (list.length < maxDetectors && !list.some((v) => v.id === variantId(source, delta))) list.push({ id: variantId(source, delta), source, delta });
  };
  const sorted = [...new Set(deltas)].sort((a, b) => b - a);
  for (const d of sorted.length ? sorted : [0]) add({ kind: "product" }, d);
  if (channels > 1 && productMixRule(channels) !== "average" && productMixRule(channels) !== "copy") add({ kind: "average" }, 0);
  if (perChannel && channels > 1) for (let i = 0; i < channels; i++) add({ kind: "channel", index: i }, 0);
  return list;
}

const clampThreshold = (t: number) => Math.round(Math.min(0.99, Math.max(0.01, t)) * 100) / 100;

/** 把每一行關鍵詞門檻（含全域門檻）加上 delta，夾在 0.01–0.99、取到小數兩位；提升分數不變。新物件。 */
export function offsetKeywords(k: WakeKeywordConfig, delta: number): WakeKeywordConfig {
  return {
    ...k,
    keywords_threshold: k.keywords_threshold === null ? null : clampThreshold(k.keywords_threshold + delta),
    entries: k.entries.map((e) => ({ ...e, threshold: e.threshold === null ? null : clampThreshold(e.threshold + delta) })),
  };
}

/** 取出一個來源的樣本（新陣列）。 */
export function pickSource(input: readonly Float32Array[], source: Source): Float32Array {
  if (source.kind === "product") return productDownmix(input);
  if (source.kind === "average") return averageMix(input);
  const ch = input[source.index];
  const out = new Float32Array(input[0]?.length ?? 0);
  if (ch) out.set(ch);
  return out;
}

/**
 * 把 render quantum（128 樣本）累積成固定長度的塊（約 100 ms），滿了就交給 emit（emit 取得所有權）。
 * AudioWorklet 每個來源一個；stop() 以 0 覆寫還沒滿的那一塊。
 */
export class Chunker {
  private buf: Float32Array;
  private n = 0;

  constructor(
    private readonly size: number,
    private readonly emit: (full: Float32Array) => void,
  ) {
    this.buf = new Float32Array(size);
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.n++] = samples[i]!;
      if (this.n === this.size) {
        // 先換新的再交出去：交出去的那塊可能被轉移（detached）。
        const full = this.buf;
        this.buf = new Float32Array(this.size);
        this.n = 0;
        this.emit(full);
      }
    }
  }

  stop(): void {
    this.buf.fill(0);
    this.n = 0;
  }
}

// ───────────── 測試紀錄與統計 ─────────────

/** 一次正樣本測試：喚醒詞說一次，每個偵測器有沒有在時間窗內觸發。 */
export interface Trial {
  condition: string;
  angle: Angle;
  distance: Distance;
  phrase: Phrase;
  hits: Record<string, boolean>;
}

/** 一段負樣本（電視、聊天）：持續秒數與每個偵測器的誤觸次數。 */
export interface NegativeRun {
  condition: string;
  kind: NegativeKind;
  seconds: number;
  triggers: Record<string, number>;
}

export interface Results {
  version: 1;
  trials: Trial[];
  negatives: NegativeRun[];
}

export const emptyResults = (): Results => ({ version: 1, trials: [], negatives: [] });

/** 「條件」＝瀏覽器處理與聲道要求（同一次測試裡無法同時比較，要分開跑）。 */
export interface Condition {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** default：和產品一樣不指定；max：要求最多聲道（ideal 8）。 */
  channels: "default" | "max";
}

export const PRODUCT_CONDITION: Condition = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channels: "default" };

export function conditionLabel(c: Condition): string {
  return `ec${c.echoCancellation ? 1 : 0}-ns${c.noiseSuppression ? 1 : 0}-agc${c.autoGainControl ? 1 : 0}-ch:${c.channels}`;
}

export interface Rate {
  hits: number;
  n: number;
  /** hits / n；n 為 0 時 null。 */
  rate: number | null;
  /** Wilson 95% 區間；n 為 0 時 null。 */
  low: number | null;
  high: number | null;
}

/**
 * Wilson score 區間（z＝1.96 約 95%）：center = (p + z²/2n) / (1 + z²/n)，
 * margin = z·√(p(1−p)/n + z²/4n²) / (1 + z²/n)。每格只有 5 次，區間很寬；文件以這個提醒不要過度解讀。
 */
export function wilson(hits: number, n: number, z = 1.96): Rate {
  if (n <= 0) return { hits, n, rate: null, low: null, high: null };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { hits, n, rate: p, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function rateOf(trials: readonly Trial[], variant: string): Rate {
  const scored = trials.filter((t) => variant in t.hits);
  return wilson(scored.filter((t) => t.hits[variant]).length, scored.length);
}

export interface Summary {
  condition: string;
  variant: string;
  /** cells[angle][distance][phrase] */
  cells: Record<string, Record<string, Record<string, Rate>>>;
  /** 每個方向（兩個距離、兩個喚醒詞合計）。 */
  byAngle: Record<string, Rate>;
  byDistance: Record<string, Rate>;
  byPhrase: Record<string, Rate>;
  overall: Rate;
  /** 有資料的方向中，最高成功率減最低成功率；少於兩個方向有資料時 null。 */
  spread: number | null;
  /** 成功率最低的方向（可能並列）。 */
  worstAngles: number[];
  /** 每種負樣本：總秒數、誤觸次數、每小時誤觸 = 次數 ÷ (秒數 ÷ 3600)。 */
  negatives: Record<string, { seconds: number; triggers: number; perHour: number | null }>;
}

export function summarize(results: Results, condition: string, variant: string): Summary {
  const trials = results.trials.filter((t) => t.condition === condition);
  const cells: Summary["cells"] = {};
  const byAngle: Summary["byAngle"] = {};
  for (const a of ANGLES) {
    cells[a] = {};
    for (const d of DISTANCES) {
      cells[a]![d] = {};
      for (const p of POSITIVE_PHRASES) cells[a]![d]![p] = rateOf(trials.filter((t) => t.angle === a && t.distance === d && t.phrase === p), variant);
    }
    byAngle[a] = rateOf(trials.filter((t) => t.angle === a), variant);
  }
  const byDistance = Object.fromEntries(DISTANCES.map((d) => [d, rateOf(trials.filter((t) => t.distance === d), variant)]));
  const byPhrase = Object.fromEntries(POSITIVE_PHRASES.map((p) => [p, rateOf(trials.filter((t) => t.phrase === p), variant)]));
  const measured = ANGLES.filter((a) => byAngle[a]!.rate !== null);
  const rates = measured.map((a) => byAngle[a]!.rate!);
  const min = rates.length ? Math.min(...rates) : null;
  const spread = rates.length >= 2 ? Math.max(...rates) - min! : null;
  const worstAngles = min === null ? [] : measured.filter((a) => byAngle[a]!.rate === min);
  const negatives: Summary["negatives"] = {};
  for (const kind of NEGATIVE_KINDS) {
    const runs = results.negatives.filter((r) => r.condition === condition && r.kind === kind && variant in r.triggers);
    const seconds = runs.reduce((s, r) => s + r.seconds, 0);
    const triggers = runs.reduce((s, r) => s + (r.triggers[variant] ?? 0), 0);
    negatives[kind] = { seconds, triggers, perHour: seconds > 0 ? triggers / (seconds / 3600) : null };
  }
  return { condition, variant, cells, byAngle, byDistance, byPhrase, overall: rateOf(trials, variant), spread, worstAngles, negatives };
}

/** 某一格已經說了幾次（同條件、同方向、同距離、同喚醒詞）。 */
export function cellCount(results: Results, condition: string, angle: Angle, distance: Distance, phrase: Phrase): number {
  return results.trials.filter((t) => t.condition === condition && t.angle === angle && t.distance === distance && t.phrase === phrase).length;
}

/** 下一個還沒滿 5 次的格子（依 喚醒詞 → 距離 → 方向 的順序）；全部滿了回 null。 */
export function nextCell(results: Results, condition: string): { angle: Angle; distance: Distance; phrase: Phrase } | null {
  for (const phrase of POSITIVE_PHRASES)
    for (const distance of DISTANCES)
      for (const angle of ANGLES) if (cellCount(results, condition, angle, distance, phrase) < TRIALS_PER_CELL) return { angle, distance, phrase };
  return null;
}

/** 所有出現過的條件與偵測器 id（給結果表的選單）。 */
export function knownKeys(results: Results): { conditions: string[]; variants: string[] } {
  const conditions = new Set<string>();
  const variants = new Set<string>();
  for (const t of results.trials) {
    conditions.add(t.condition);
    for (const v of Object.keys(t.hits)) variants.add(v);
  }
  for (const r of results.negatives) {
    conditions.add(r.condition);
    for (const v of Object.keys(r.triggers)) variants.add(v);
  }
  return { conditions: [...conditions], variants: [...variants] };
}

/** 結果表（CSV，一列一格）：只有次數與比例，沒有任何音訊。 */
export function toCsv(results: Results): string {
  const { conditions, variants } = knownKeys(results);
  const rows = ["condition,variant,angle,distance,phrase,hits,trials,rate,wilson_low,wilson_high"];
  const f = (x: number | null) => (x === null ? "" : x.toFixed(3));
  for (const c of conditions)
    for (const v of variants) {
      const s = summarize(results, c, v);
      for (const a of ANGLES)
        for (const d of DISTANCES)
          for (const p of POSITIVE_PHRASES) {
            const r = s.cells[a]![d]![p]!;
            if (r.n > 0) rows.push([c, v, a, d, p, r.hits, r.n, f(r.rate), f(r.low), f(r.high)].join(","));
          }
      for (const k of NEGATIVE_KINDS) {
        const neg = s.negatives[k]!;
        if (neg.seconds > 0) rows.push([c, v, "", "", `negative:${k}`, neg.triggers, `${Math.round(neg.seconds)}s`, neg.perHour === null ? "" : `${neg.perHour.toFixed(2)}/h`, "", ""].join(","));
      }
    }
  return rows.join("\n") + "\n";
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const SAFE_KEY = /^[A-Za-z0-9:+.\-]{1,40}$/;

/** 匯入先前複製的結果 JSON；格式不對就丟錯（只接受次數與已知的列舉值，不接受陣列樣本或其他欄位）。 */
export function parseResults(text: string): Results {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.trials) || !Array.isArray(raw.negatives)) throw new Error("not a wake-direction results file");
  const flags = (x: unknown, kind: "boolean" | "number"): Record<string, never> => {
    if (!isRecord(x)) throw new Error("bad detector map");
    for (const [k, v] of Object.entries(x)) {
      if (!SAFE_KEY.test(k) || typeof v !== kind || (kind === "number" && !(Number.isInteger(v) && (v as number) >= 0))) throw new Error("bad detector entry");
    }
    return x as Record<string, never>;
  };
  const condition = (x: unknown): string => {
    if (typeof x !== "string" || !SAFE_KEY.test(x)) throw new Error("bad condition");
    return x;
  };
  const trials: Trial[] = raw.trials.map((t) => {
    if (!isRecord(t)) throw new Error("bad trial");
    if (!ANGLES.includes(t.angle as Angle) || !DISTANCES.includes(t.distance as Distance) || !POSITIVE_PHRASES.includes(t.phrase as Phrase)) throw new Error("bad trial cell");
    return { condition: condition(t.condition), angle: t.angle as Angle, distance: t.distance as Distance, phrase: t.phrase as Phrase, hits: flags(t.hits, "boolean") };
  });
  const negatives: NegativeRun[] = raw.negatives.map((r) => {
    if (!isRecord(r) || !NEGATIVE_KINDS.includes(r.kind as NegativeKind) || typeof r.seconds !== "number" || !(r.seconds >= 0)) throw new Error("bad negative run");
    return { condition: condition(r.condition), kind: r.kind as NegativeKind, seconds: r.seconds, triggers: flags(r.triggers, "number") };
  });
  return { version: 1, trials, negatives };
}
