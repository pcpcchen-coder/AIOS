// 使用者設定的規格（CAMERA_PREFS、VOICE_PREFS 都是這種表）：預設值、驗證、設定畫面與選單列的選項都由表推導。

export interface BoolPrefSpec {
  kind: "bool";
  default: boolean;
  /** 設定畫面的標籤，也是語音指令裡的名稱（「關閉看著說話」）。 */
  label: string;
  hint: string;
}

/** 數值設定共用的欄位：秒數與倍率都用同一套驗證、−／+ 與選單選項。 */
interface NumberPrefFields {
  default: number;
  min: number;
  max: number;
  step: number;
  /**
   * 選單列提供的選項（選單不能輸入數字）。每一個都要在範圍內、落在 step 上、由小到大不重複，且包含預設值
   * （tests/prefs.test.ts 對每張表檢查），所以選單的點選不會被核心以 400 拒絕。
   */
  presets: readonly number[];
  label: string;
  hint: string;
}

export interface SecondsPrefSpec extends NumberPrefFields {
  kind: "seconds";
}

/** 倍率（例如「靠近時電子腦放大倍率」）：顯示成「2 倍」，驗證規則與秒數相同。 */
export interface FactorPrefSpec extends NumberPrefFields {
  kind: "factor";
}

export type NumberPrefSpec = SecondsPrefSpec | FactorPrefSpec;

export type PrefSpec<T> = T extends boolean ? BoolPrefSpec : NumberPrefSpec;

/** 一張設定表：每個鍵一個規格，順序就是設定畫面與選單的順序。 */
export type PrefSpecs<P> = { [K in keyof P]: PrefSpec<P[K]> };

/** 表裡的秒數鍵。 */
export type SecondsKeyOf<S> = { [K in keyof S]: S[K] extends { kind: "seconds" } ? K : never }[keyof S];

/** 表裡的倍率鍵。 */
export type FactorKeyOf<S> = { [K in keyof S]: S[K] extends { kind: "factor" } ? K : never }[keyof S];

export interface PatchErrors {
  /** 訊息裡的名稱：「鏡頭設定」「語音設定」。 */
  noun: string;
  make(message: string): Error;
}

/**
 * 邊界驗證（HTTP body、設定檔）：只接受表裡的鍵；開關必須是 boolean；秒數與倍率必須在範圍內且落在 step 上。
 * 不默默夾住數值，錯誤一律用 errors.make 丟出（→ HTTP 400）。通過的數值存成格點上的值（onStep 容許 1e-6 的誤差，
 * 90.000001 存成 90；範圍檢查用對到格點後的值，兩端同樣容許），選單與設定畫面才不會把同一個值當成預設與「（目前）」各列一次。
 */
export function parsePrefsPatch<P>(specs: PrefSpecs<P>, input: unknown, errors: PatchErrors): Partial<P> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw errors.make(`${errors.noun}必須是 JSON 物件`);
  const table = specs as Record<string, BoolPrefSpec | NumberPrefSpec>;
  const patch: Record<string, boolean | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(table, key)) throw errors.make(`未知的${errors.noun}：${key}`);
    const spec = table[key];
    if (spec.kind === "bool") {
      if (typeof value !== "boolean") throw errors.make(`${key} 必須是 true 或 false`);
      patch[key] = value;
      continue;
    }
    // 先對到格點再檢查範圍：範圍兩端與 step 用同一個 1e-6 容許誤差（2.9 + 0.1 = 3.0000000000000004 存成 3）。
    const snapped = typeof value === "number" && Number.isFinite(value) && onStep(value, spec.step) ? snapToStep(value, spec.step) : null;
    if (snapped === null || snapped < spec.min || snapped > spec.max) {
      throw errors.make(`${key} 必須是 ${spec.min}–${spec.max} ${spec.kind === "factor" ? "倍" : "秒"}、間隔 ${spec.step}`);
    }
    patch[key] = snapped;
  }
  return patch as Partial<P>;
}

export function onStep(value: number, step: number): boolean {
  const n = value / step;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

/** 最近的格點，四捨五入到 step 的小數位（避免 1.6000000000000003）。 */
export function snapToStep(value: number, step: number): number {
  const decimals = (String(step).split(".")[1] ?? "").length;
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

/** 設定畫面的 −／+：移動一格並夾在範圍內。 */
export function stepPref(spec: NumberPrefSpec, current: number, direction: 1 | -1): number {
  const next = snapToStep(current + direction * spec.step, spec.step);
  return Math.min(spec.max, Math.max(spec.min, next));
}

/** 表的預設值。 */
export function prefDefaults<P>(specs: PrefSpecs<P>): P {
  return Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, (spec as { default: unknown }).default])) as P;
}

/** 「1.5 秒」「45 秒」「2 分鐘」「1 分 30 秒」：選單、設定畫面與同意說明共用。 */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Number(seconds.toFixed(3))} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Number((seconds - minutes * 60).toFixed(3));
  return rest === 0 ? `${minutes} 分鐘` : `${minutes} 分 ${rest} 秒`;
}

/** 「1 倍」「1.5 倍」「2 倍」：倍率設定的選單、設定畫面共用。 */
export function formatFactor(factor: number): string {
  return `${Number(factor.toFixed(3))} 倍`;
}

/** 依規格的種類格式化數值設定。 */
export function formatNumberPref(spec: NumberPrefSpec, value: number): string {
  return spec.kind === "factor" ? formatFactor(value) : formatSeconds(value);
}
