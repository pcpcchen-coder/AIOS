// WK-00 喚醒詞 spike：候選詞、發音單元與 sherpa-onnx 關鍵詞檔產生（純函式，不碰音訊或檔案）。
// 規劃見 docs/17 §3；量測見 docs/validation/wk-00-spike-2026-10-29.md。
// 關鍵詞檔一行的格式（sherpa-onnx csrc/utils.cc 的 EncodeKeywords）：發音單元以空白分開，
// 之後可接 `:提升分數`、`#觸發門檻`、`@原詞`；`@` 後面只能是一個不含空白的字串，所以英文別名用 HEY_NOUS。

export type ModelId = "wenetspeech-3.3M" | "zh-en-3M";

export const MODEL_IDS: readonly ModelId[] = ["wenetspeech-3.3M", "zh-en-3M"];

export interface Candidate {
  /** 偵測結果回傳的 `@` 字串，也是報告裡的鍵。 */
  id: string;
  /** 給人看的寫法。 */
  label: string;
  /** 發音單元：中文為 ppinyin（聲母＋帶調韻母），英文為 ARPAbet。 */
  tokens: readonly string[];
  /** 這個詞的發音單元只在哪些模型的 tokens.txt 裡。 */
  models: readonly ModelId[];
  /** 替代念法或子詞：以哪個候選詞的錄音（或合成正例）當正例。 */
  variantOf?: string;
}

/** 單字的帶調拼音。只收候選詞會用到的字；其他詞請用 `--keywords-file` 直接寫發音單元。 */
export const PINYIN: Readonly<Record<string, string>> = {
  哈: "hā",
  囉: "luō",
  啰: "luō",
  努: "nǔ",
  斯: "sī",
  嘿: "hēi",
};

/** ppinyin 的聲母；sherpa-onnx 的拼音模型把 y、w 也當聲母。順序：兩個字母的先比。 */
const INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];

/** 把一個帶調拼音拆成 [聲母, 韻母] 或只有韻母（例如「ài」）。 */
export function splitPinyin(syllable: string): string[] {
  const s = syllable.normalize("NFC");
  if (!s) throw new Error("empty syllable");
  const initial = INITIALS.find((i) => s.startsWith(i) && s.length > i.length);
  return initial ? [initial, s.slice(initial.length)] : [s];
}

/** 中文詞轉發音單元；遇到表中沒有的字就丟錯，不猜。 */
export function hanziToTokens(word: string): string[] {
  return [...word].flatMap((ch) => {
    const py = PINYIN[ch];
    if (!py) throw new Error(`no pinyin for ${ch}; pass tokens explicitly`);
    return splitPinyin(py);
  });
}

export const CANDIDATES: readonly Candidate[] = [
  { id: "HALUO_NUSI", label: "哈囉努斯", tokens: hanziToTokens("哈囉努斯"), models: MODEL_IDS },
  { id: "HEI_NUSI", label: "嘿努斯", tokens: hanziToTokens("嘿努斯"), models: MODEL_IDS },
  // Nous 依希臘文 νοῦς 讀作 N UW1 S（docs/17 §3.2）；zh-en 模型的 en.phone 也是 NOUS N UW1 S。只有 zh-en 模型有 ARPAbet 單元。
  { id: "HEY_NOUS", label: "Hey Nous", tokens: ["HH", "EY1", "N", "UW1", "S"], models: ["zh-en-3M"] },
];

/**
 * 替代念法與子詞，只用來診斷（WK-00 審查）：合成正例對完整候選詞 0 命中時，分辨是「哈囉」的發音單元
 * （台灣常念 hā-lóu）還是整體的問題。子詞「努斯」只有 4 個單元，誤報風險高，不是喚醒詞候選。
 */
export const VARIANTS: readonly Candidate[] = [
  { id: "HALOU_NUSI", label: "哈囉努斯(hā-lóu)", tokens: ["h", "ā", "l", "óu", "n", "ǔ", "s", "ī"], models: MODEL_IDS, variantOf: "HALUO_NUSI" },
  { id: "NUSI", label: "努斯", tokens: hanziToTokens("努斯"), models: MODEL_IDS, variantOf: "HALUO_NUSI" },
];

const ALL: readonly Candidate[] = [...CANDIDATES, ...VARIANTS];

export interface KeywordSetting {
  candidate: Candidate;
  /** 提升分數（`:`）；undefined 用引擎預設 keywordsScore。 */
  boost?: number;
  /** 觸發門檻（`#`）；undefined 用引擎預設 keywordsThreshold。 */
  threshold?: number;
}

function findCandidate(name: string): Candidate {
  const key = name.trim();
  const hit = ALL.find((c) => c.id === key || c.label === key || c.label.toLowerCase() === key.toLowerCase());
  if (!hit) throw new Error(`unknown keyword "${key}"; known: ${ALL.map((c) => c.label).join(", ")}`);
  return hit;
}

function parseNumber(text: string, what: string, min: number, max: number): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${what} must be a number in [${min}, ${max}], got "${text}"`);
  return n;
}

/**
 * 解析 `哈囉努斯:1.5#0.35,嘿努斯#0.3,Hey Nous` 這類設定。`:` 是提升分數、`#` 是觸發門檻，兩者都可省略、順序不拘。
 */
export function parseKeywordSpec(spec: string): KeywordSetting[] {
  const parts = spec.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("no keywords");
  const seen = new Set<string>();
  return parts.map((part) => {
    const m = part.match(/^([^:#]+)((?:[:#][^:#]+)*)$/);
    if (!m) throw new Error(`cannot parse keyword "${part}"`);
    const candidate = findCandidate(m[1]!);
    if (seen.has(candidate.id)) throw new Error(`duplicate keyword ${candidate.label}`);
    seen.add(candidate.id);
    const setting: KeywordSetting = { candidate };
    for (const opt of m[2]!.match(/[:#][^:#]+/g) ?? []) {
      if (opt[0] === ":") setting.boost = parseNumber(opt.slice(1), "boost", 0, 10);
      else setting.threshold = parseNumber(opt.slice(1), "threshold", 0, 1);
    }
    return setting;
  });
}

/** 讀 tokens.txt 的內容（每行「單元 編號」），回傳單元集合。 */
export function parseTokens(tokensTxt: string): Set<string> {
  return new Set(
    tokensTxt
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((t): t is string => Boolean(t)),
  );
}

/**
 * 產生 sherpa-onnx 關鍵詞檔內容。模型不支援的候選（例如 wenetspeech 沒有英文單元）或 tokens.txt 缺單元時丟錯，
 * 不讓引擎默默把未知單元略過（sherpa-onnx 遇到未知單元只記 log）。
 */
export function buildKeywordsText(settings: readonly KeywordSetting[], model: ModelId, tokenSet?: ReadonlySet<string>): string {
  return (
    settings
      .map(({ candidate, boost, threshold }) => {
        if (!candidate.models.includes(model)) throw new Error(`${candidate.label} is not supported by model ${model}`);
        const missing = tokenSet ? candidate.tokens.filter((t) => !tokenSet.has(t)) : [];
        if (missing.length) throw new Error(`model ${model} has no token(s) ${missing.join(" ")} for ${candidate.label}`);
        const extra = [boost === undefined ? null : `:${boost}`, threshold === undefined ? null : `#${threshold}`].filter(Boolean);
        return [...candidate.tokens, ...extra, `@${candidate.id}`].join(" ");
      })
      .join("\n") + "\n"
  );
}

/** 偵測結果的 `keyword`（即 `@` 字串）轉回候選。 */
export function candidateById(id: string): Candidate | undefined {
  return ALL.find((c) => c.id === id);
}

/** 報告用：設定的文字形式，例如 `哈囉努斯:1.5#0.35`。 */
export function formatSetting(s: KeywordSetting): string {
  return `${s.candidate.label}${s.boost === undefined ? "" : `:${s.boost}`}${s.threshold === undefined ? "" : `#${s.threshold}`}`;
}
