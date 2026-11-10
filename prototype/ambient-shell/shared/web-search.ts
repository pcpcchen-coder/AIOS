// 即時語音上網查詢的結果形狀（核心 server/web-search.ts 產生、頁面 src/search-panel.ts 顯示），以及兩個純函式：
// parseCandidates：從搜尋模型的文字取出念給使用者的答案與最多 3 則候選；
// matchSpokenPoint：助理念到哪一點（跟讀亮起）。兩者都不呼叫網路、不猜內容。

/** 一次上網查詢的上限。ChatGPT 方案路徑的 Codex 那一輪也用這個時限（含第一次查模型清單），所以兩條路徑一樣。 */
export const WEB_SEARCH_TIMEOUT_MS = 30_000;

export interface WebSource {
  title: string;
  url: string;
}

export interface SearchCandidate {
  n: 1 | 2 | 3;
  title: string;
  url: string;
  host: string;
  /** 0–5 個重點，數字照原文；summarized 為 false 時是空的。 */
  points: string[];
  /** false：搜尋模型沒有給結構化重點，只是從來源（citations）補上的標題與網址。 */
  summarized: boolean;
  /**
   * 網址是否對得上這次查詢的來源（citations）。有來源時對不上的候選一律丟掉（模型可能編網址），所以只有
   * 「這次查詢完全沒有回來源」時才會是 false：照樣顯示，但畫面註明網址沒有經來源核對。
   */
  cited: boolean;
}

export interface WebSearchResult {
  ok: true;
  answer: string;
  sources: WebSource[];
  candidates: SearchCandidate[];
  model: string;
}

export const MAX_CANDIDATES = 3;
export const MAX_POINTS = 5;
/** 指示要求每點 40 字以內；模型超過時截到這個長度（只截不改）。 */
const MAX_POINT_CHARS = 60;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * 比對網址用的 key：忽略 #、結尾斜線、www. 與 utm_* 參數（搜尋服務的 citations 常加上 ?utm_source=…，
 * 模型寫的網址通常沒有）。
 */
function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function clip(text: string): string {
  return text.length > MAX_POINT_CHARS ? `${text.slice(0, MAX_POINT_CHARS - 1)}…` : text;
}

/** 文字尾端可能是 JSON 的開頭：`[{` 或 `{"`。 */
const JSON_START = /\[\s*\{|\{\s*"/g;

/**
 * JSON 區塊的位置：最後一個 ```json 區塊；沒有的話，文字中第一個能解析成候選清單的 `[{`／`{"` 起點到結尾。
 * 都解析不出來但有 `[{`／`{"` 時，仍把第一個起點到結尾當成（壞掉的）JSON：答案要念出來，不能念 JSON。
 */
function findJsonBlock(text: string): { start: number; end: number; body: string } | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)(?:```|$)/gi)];
  const fence = fences.at(-1);
  if (fence && fence.index !== undefined) return { start: fence.index, end: fence.index + fence[0].length, body: fence[1] };
  const starts = [...text.matchAll(JSON_START)].map((m) => m.index ?? 0);
  for (const start of starts) {
    const body = text.slice(start);
    if (listOf(parseJson(body))) return { start, end: text.length, body };
  }
  if (starts.length) return { start: starts[0], end: text.length, body: text.slice(starts[0]) };
  return null;
}

function parseJson(body: string): unknown {
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 區塊後面多了說明文字：取到最後一個右括號再試一次。
    const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (last <= 0) return null;
    try {
      return JSON.parse(trimmed.slice(0, last + 1));
    } catch {
      return null;
    }
  }
}

/** 候選清單：陣列本身，或 {candidates:[…]}／{results:[…]}；清單裡至少要有一個帶 url 的物件才算。 */
function listOf(value: unknown): unknown[] | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
    ? ((value as { candidates?: unknown }).candidates ?? (value as { results?: unknown }).results)
    : null;
  if (!Array.isArray(list)) return null;
  return list.some((item) => item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string") ? list : null;
}

function fromModel(value: unknown): Omit<SearchCandidate, "n" | "cited">[] {
  const list = listOf(value);
  if (!list) return [];
  const out: Omit<SearchCandidate, "n" | "cited">[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { title, url, points } = item as { title?: unknown; url?: unknown; points?: unknown };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) continue;
    const kept = Array.isArray(points)
      ? points.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => clip(p.trim())).slice(0, MAX_POINTS)
      : [];
    out.push({ title: typeof title === "string" ? title.trim() : "", url: url.trim(), host: hostOf(url.trim()), points: kept, summarized: kept.length > 0 });
  }
  return out;
}

function numbered(list: Omit<SearchCandidate, "n">[]): SearchCandidate[] {
  const seen = new Set<string>();
  const out: SearchCandidate[] = [];
  for (const c of list) {
    const key = urlKey(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, n: (out.length + 1) as SearchCandidate["n"] });
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * 搜尋模型的文字 → 念給使用者的答案＋候選。
 * 有來源（citations）時，只留網址對得上來源的候選（標題空的用來源標題）；全部對不上或 JSON 解析不出候選時，
 * 改用來源的標題與網址，points 留空、summarized 為 false：不替來源編重點。
 * 沒有來源時照樣用模型的候選，但 cited 為 false（畫面註明沒有經來源核對）。
 */
export function parseCandidates(text: string, citations: readonly WebSource[]): { answer: string; candidates: SearchCandidate[] } {
  const block = findJsonBlock(text);
  const answer = (block ? text.slice(0, block.start) + text.slice(block.end) : text).trim();
  const model = block ? fromModel(parseJson(block.body)) : [];
  const cited = new Map(citations.map((s) => [urlKey(s.url), s]));
  const kept = citations.length
    ? model.flatMap((c) => {
      const source = cited.get(urlKey(c.url));
      return source ? [{ ...c, title: c.title || source.title.trim() || c.host, cited: true }] : [];
    })
    : model.map((c) => ({ ...c, title: c.title || c.host, cited: false }));
  const parsed = numbered(kept);
  if (parsed.length) return { answer, candidates: parsed };
  return {
    answer,
    candidates: numbered(citations.map((s) => ({ title: s.title.trim() || hostOf(s.url), url: s.url, host: hostOf(s.url), points: [], summarized: false, cited: true }))),
  };
}

// ---- 跟讀：助理念到哪一點 ----

/** 比對用的正規化：全形轉半形、小寫、拿掉空白與標點；數字裡的千分位逗號拿掉，小數點與百分號保留。 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/(\d)\.(?=\d)/g, "$1\u0000")
    .replace(/[\s\p{P}\p{S}]/gu, (ch) => (ch === "%" ? "%" : ""))
    .replace(/\u0000/g, ".");
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 一點的辨識詞：開頭幾個字（中文最多 6 個、遇到數字就停，因為念的時候數字常換成中文讀法；英文 12 個字母），
 * 加上點裡夠長的數字（23456.78、1.2%）。head 是開頭那個詞（可能沒有）。
 */
function keysOf(point: string): { head: string | null; all: string[] } {
  const norm = normalizeForMatch(point);
  if (!norm) return { head: null, all: [] };
  const cjk = CJK.test(norm[0]);
  const lead = norm.slice(0, cjk ? 6 : 12);
  const lead2 = cjk ? lead.replace(/\d.*$/, "") : lead;
  const head = lead2.length >= (cjk ? 2 : 4) ? lead2 : null;
  const numbers = [...norm.matchAll(/\d+(?:\.\d+)?%?/g)].map((m) => m[0]).filter((n) => n.replace(/\D/g, "").length >= 3 || n.endsWith("%"));
  return { head, all: [...(head ? [head] : []), ...numbers] };
}

export interface MatchOptions {
  /** 只考慮這一點之後的點（跟讀只往前走）；null 或不給＝全部。 */
  after?: number | null;
  /** 只認開頭的詞（還沒亮任何一點時用：結論句常重複各點的數字，不能只憑數字就開始亮）。 */
  headOnly?: boolean;
  /** 只認正規化文字中這個位置之後出現的詞（跟讀：下一點要出現在目前這一點之後，結論句裡的數字不算）。 */
  fromPos?: number;
}

/**
 * 助理目前念到第幾點（0 起算）：在累積的助理文字裡，找最後出現的辨識詞屬於哪一點。兩點共用的辨識詞不算（分不出是哪一點）。
 * 沒有任何辨識詞出現就回 null（不猜）。
 */
export function matchSpokenPoint(spokenText: string, points: readonly string[], options: MatchOptions = {}): number | null {
  return locateSpokenPoint(spokenText, points, options)?.index ?? null;
}

/** 同 matchSpokenPoint，另外回傳那個詞在正規化文字中的結尾位置（下一次的 fromPos）。 */
export function locateSpokenPoint(spokenText: string, points: readonly string[], options: MatchOptions = {}): { index: number; end: number } | null {
  const spoken = normalizeForMatch(spokenText);
  if (!spoken) return null;
  const keys = points.map(keysOf);
  const owners = new Map<string, number>();
  for (const { all } of keys) for (const k of new Set(all)) owners.set(k, (owners.get(k) ?? 0) + 1);
  const from = options.after === null || options.after === undefined ? 0 : options.after + 1;
  let best: number | null = null;
  let bestEnd = -1;
  for (let index = from; index < keys.length; index++) {
    const list = options.headOnly ? (keys[index].head ? [keys[index].head!] : []) : keys[index].all;
    for (const key of list) {
      if (!key || owners.get(key) !== 1) continue;
      const at = spoken.lastIndexOf(key);
      if (at < 0 || at < (options.fromPos ?? 0)) continue;
      const end = at + key.length;
      if (end >= bestEnd) {
        best = index;
        bestEnd = end;
      }
    }
  }
  return best === null ? null : { index: best, end: bestEnd };
}

// ---- 交回語音模型的內容 ----

/** 畫面沒有顯示查詢結果時（確認卡開著、找不到使用者這一句話、通話已結束）交回模型的說明：不能說「畫面已顯示」。 */
export const NOT_SHOWN_NOTE = "畫面沒有顯示查詢結果，用說的告訴使用者。";

/**
 * web_search 交回模型的內容：候選只給編號、標題、網站（選之前不給重點，模型才不會先念內容）。只有一則時直接給重點。
 * shown：畫面真的顯示了結果才說「畫面已顯示／已列出」。answer 是空的時候不要求先講結論（沒有結論可講）。
 */
export function searchToolOutput(result: Pick<WebSearchResult, "answer" | "candidates">, shown: boolean): Record<string, unknown> {
  const list = result.candidates.map(({ n, title, host }) => ({ n, title, host }));
  const only = result.candidates.length === 1 ? result.candidates[0] : null;
  const conclusion = result.answer.trim() ? "先用一句話講結論，再" : "";
  if (only) {
    if (!only.summarized) {
      return { ok: true, answer: result.answer, candidates: list, next: shown ? "這則沒有摘要，畫面只顯示來源；用 answer 回答。" : `這則沒有摘要。${NOT_SHOWN_NOTE}用 answer 回答。` };
    }
    const read = `${conclusion}依序念 points，每點一句，用那一點開頭的字開始，數字照念、不要改寫。`;
    return { ok: true, answer: result.answer, candidates: list, points: only.points, next: shown ? `畫面已顯示這一則的重點。${read}` : `${NOT_SHOWN_NOTE}${read}` };
  }
  if (result.candidates.length > 1) {
    const ask = `${conclusion ? "可以先用一句話講結論，再" : ""}簡短念出各則的編號和標題（第一則…第二則…），問使用者要看哪一則；先不要念內容。使用者選了之後呼叫 show_search_result。`;
    return { ok: true, answer: result.answer, candidates: list, next: shown ? `畫面已列出編號的查詢結果。${ask}` : `${NOT_SHOWN_NOTE}${ask}` };
  }
  return { ok: true, answer: result.answer, candidates: [], next: "用 answer 回答。" };
}

/** show_search_result 交回模型的內容；shown 同上。 */
export function pickToolOutput(candidate: SearchCandidate, shown: boolean): Record<string, unknown> {
  const base = { ok: true, n: candidate.n, title: candidate.title, host: candidate.host, points: candidate.points };
  const read = "依序念 points，每點一句，用那一點開頭的字開始，數字照念、不要改寫。";
  if (!candidate.summarized) return { ...base, note: `這則沒有摘要，只有來源；照實告訴使用者，不要自己補內容。${shown ? "" : NOT_SHOWN_NOTE}` };
  return { ...base, next: shown ? `畫面已顯示這一則的重點。${read}` : `${NOT_SHOWN_NOTE}${read}` };
}

export const SEARCH_ERRORS = { none: "還沒有查詢結果", outOfRange: "沒有這一則" } as const;
