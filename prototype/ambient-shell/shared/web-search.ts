// 即時語音上網查詢的結果形狀（核心 server/web-search.ts 產生、頁面 src/search-panel.ts 顯示），以及兩個純函式：
// parseCandidates：從搜尋模型的文字取出念給使用者的答案與最多 3 則候選；
// matchSpokenPoint：助理念到哪一點（跟讀亮起）。兩者都不呼叫網路、不猜內容。

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

function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function clip(text: string): string {
  return text.length > MAX_POINT_CHARS ? `${text.slice(0, MAX_POINT_CHARS - 1)}…` : text;
}

/** JSON 區塊的位置：最後一個 ```json 區塊，或文字尾端的 JSON 物件；兩種都會從答案裡拿掉（即使解析失敗）。 */
function findJsonBlock(text: string): { start: number; end: number; body: string } | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)(?:```|$)/gi)];
  const fence = fences.at(-1);
  if (fence && fence.index !== undefined) return { start: fence.index, end: fence.index + fence[0].length, body: fence[1] };
  const marker = text.search(/\{\s*"candidates"\s*:/);
  if (marker >= 0) return { start: marker, end: text.length, body: text.slice(marker) };
  return null;
}

function parseJson(body: string): unknown {
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 區塊後面多了說明文字：取到最後一個右大括號再試一次。
    const last = trimmed.lastIndexOf("}");
    if (last <= 0) return null;
    try {
      return JSON.parse(trimmed.slice(0, last + 1));
    } catch {
      return null;
    }
  }
}

function fromModel(value: unknown): Omit<SearchCandidate, "n">[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? (value as { candidates?: unknown }).candidates : null;
  if (!Array.isArray(list)) return [];
  const out: Omit<SearchCandidate, "n">[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { title, url, points } = item as { title?: unknown; url?: unknown; points?: unknown };
    if (typeof title !== "string" || !title.trim() || typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) continue;
    const kept = Array.isArray(points)
      ? points.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => clip(p.trim())).slice(0, MAX_POINTS)
      : [];
    out.push({ title: title.trim(), url: url.trim(), host: hostOf(url.trim()), points: kept, summarized: kept.length > 0 });
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
 * 搜尋模型的文字 → 念給使用者的答案＋候選。JSON 解析不出可用的候選時，改用來源（citations）的標題與網址，
 * points 留空、summarized 為 false：不替來源編重點。
 */
export function parseCandidates(text: string, citations: readonly WebSource[]): { answer: string; candidates: SearchCandidate[] } {
  const block = findJsonBlock(text);
  const answer = (block ? text.slice(0, block.start) + text.slice(block.end) : text).trim();
  const parsed = block ? numbered(fromModel(parseJson(block.body))) : [];
  if (parsed.length) return { answer, candidates: parsed };
  return {
    answer,
    candidates: numbered(citations.map((s) => ({ title: s.title.trim() || hostOf(s.url), url: s.url, host: hostOf(s.url), points: [], summarized: false }))),
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
 * 加上點裡夠長的數字（23456.78、1.2%）。
 */
function keysOf(point: string): string[] {
  const norm = normalizeForMatch(point);
  if (!norm) return [];
  const cjk = CJK.test(norm[0]);
  const lead = norm.slice(0, cjk ? 6 : 12);
  const head = cjk ? lead.replace(/\d.*$/, "") : lead;
  const numbers = [...norm.matchAll(/\d+(?:\.\d+)?%?/g)].map((m) => m[0]).filter((n) => n.replace(/\D/g, "").length >= 3 || n.endsWith("%"));
  return [...(head.length >= (cjk ? 2 : 4) ? [head] : []), ...numbers];
}

/**
 * 助理目前念到第幾點（0 起算）：在累積的助理文字裡，找最後出現的辨識詞屬於哪一點。兩點共用的辨識詞不算（分不出是哪一點）。
 * 沒有任何辨識詞出現就回 null（不猜）。
 */
export function matchSpokenPoint(spokenText: string, points: readonly string[]): number | null {
  const spoken = normalizeForMatch(spokenText);
  if (!spoken) return null;
  const keys = points.map(keysOf);
  const owners = new Map<string, number>();
  for (const list of keys) for (const k of new Set(list)) owners.set(k, (owners.get(k) ?? 0) + 1);
  let best: number | null = null;
  let bestEnd = -1;
  for (let index = 0; index < keys.length; index++) {
    for (const key of keys[index]) {
      if (!key || owners.get(key) !== 1) continue;
      const at = spoken.lastIndexOf(key);
      if (at < 0) continue;
      const end = at + key.length;
      if (end >= bestEnd) {
        best = index;
        bestEnd = end;
      }
    }
  }
  return best;
}

// ---- 交回語音模型的內容 ----

/** web_search 交回模型的內容：候選只給編號、標題、網站（選之前不給重點，模型才不會先念內容）。只有一則時直接給重點。 */
export function searchToolOutput(result: Pick<WebSearchResult, "answer" | "candidates">): Record<string, unknown> {
  const list = result.candidates.map(({ n, title, host }) => ({ n, title, host }));
  const only = result.candidates.length === 1 ? result.candidates[0] : null;
  if (only) {
    return only.summarized
      ? { ok: true, answer: result.answer, candidates: list, points: only.points, next: "畫面已顯示這一則的重點。先用一句話講結論，再依序念 points，每點一句，用那一點開頭的字開始，數字照念、不要改寫。" }
      : { ok: true, answer: result.answer, candidates: list, next: "這則沒有摘要，畫面只顯示來源；用 answer 回答。" };
  }
  if (result.candidates.length > 1) {
    return {
      ok: true,
      answer: result.answer,
      candidates: list,
      next: "畫面已列出編號的查詢結果。可以先用一句話講結論，再簡短念出各則的編號和標題（第一則…第二則…），問使用者要看哪一則；先不要念內容。使用者選了之後呼叫 show_search_result。",
    };
  }
  return { ok: true, answer: result.answer, candidates: [], next: "用 answer 回答。" };
}

/** show_search_result 交回模型的內容。 */
export function pickToolOutput(candidate: SearchCandidate): Record<string, unknown> {
  const base = { ok: true, n: candidate.n, title: candidate.title, host: candidate.host, points: candidate.points };
  return candidate.summarized
    ? { ...base, next: "畫面已顯示這一則的重點。依序念 points，每點一句，用那一點開頭的字開始，數字照念、不要改寫。" }
    : { ...base, note: "這則沒有摘要，只有來源；照實告訴使用者，不要自己補內容。" };
}

export const SEARCH_ERRORS = { none: "還沒有查詢結果", outOfRange: "沒有這一則" } as const;
