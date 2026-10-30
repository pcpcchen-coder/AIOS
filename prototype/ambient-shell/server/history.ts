// HIST-1：成果紀錄的搜尋（一般任務與成果，明文）。
// - 每次查詢都在記憶體內比對，不建立、不寫入任何搜尋索引；查詢文字不寫 log（呼叫端只記筆數）。
// - 比對沿用記憶檢索的方式（server/search-terms.ts）：簡繁對照、中文二字片段、英文詞。
// - 來源可插拔（HistorySource）。MEM-4c：加密保存的任務（macOS App）改走 server/protected-index.ts 的 RAM 倒排索引，
//   排序與片段沿用這裡的 prepareFields／scoreFields／scoreDocument（同一份程式，結果逐筆相同）；受保護內容不進 CONTENT_CACHE。

import { foldForSearch, queryTerms } from "./search-terms.ts";
import type { Artifact, ExecutorMode, Task, TaskStatus } from "../shared/types.ts";
import type { HistoryFilters, HistoryItem, HistoryPage, HistoryRange, HistorySnippet } from "../shared/history.ts";
import { HISTORY_MAX_LIMIT, HISTORY_PAGE_SIZE, HISTORY_SNIPPET_RADIUS } from "../shared/history.ts";

/** 一筆可搜尋的紀錄：任務與它的成果（沒有成果時 artifact 為 null）。 */
export interface HistoryDocument {
  task: Task;
  artifact: Artifact | null;
}

/** 搜尋來源。source 是來源名稱（目前只有 "tasks"）；protected 的來源在 MEM-4c 才會出現。 */
export interface HistorySource {
  readonly id: string;
  readonly protected: boolean;
  documents(): Iterable<HistoryDocument>;
}

export class HistoryQueryError extends Error {}

const STATUSES: ReadonlySet<TaskStatus> = new Set(["queued", "running", "succeeded", "failed", "cancelling", "cancelled"]);
const MODES: ReadonlySet<ExecutorMode> = new Set(["claude", "chatgpt", "mock"]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const MAX_QUERY_CHARS = 200;

/** 欄位權重：標題（使用者原句）最重要，其次是成果內容與步驟。 */
const WEIGHT = { title: 3, content: 2, step: 1, notes: 1 } as const;
type Field = keyof typeof WEIGHT;

/** 解析 /api/history 的查詢參數；格式不對丟 HistoryQueryError（→ 400）。 */
export function parseHistoryQuery(params: URLSearchParams): HistoryFilters & { cursor: number; limit: number } {
  const q = (params.get("q") ?? "").trim();
  if (q.length > MAX_QUERY_CHARS) throw new HistoryQueryError(`查詢文字超過 ${MAX_QUERY_CHARS} 字`);
  const statuses = (params.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of statuses) if (!STATUSES.has(s as TaskStatus)) throw new HistoryQueryError("未知的任務狀態");
  const modes = (params.get("mode") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const m of modes) if (!MODES.has(m as ExecutorMode)) throw new HistoryQueryError("未知的引擎");
  const range: HistoryRange = { from: parseDate(params.get("from"), false), to: parseDate(params.get("to"), true) };
  if (range.from !== null && range.to !== null && range.from > range.to) throw new HistoryQueryError("開始日期晚於結束日期");
  const cursorText = params.get("cursor");
  let cursor = 0;
  if (cursorText !== null && cursorText !== "") {
    if (!/^\d{1,6}$/.test(cursorText)) throw new HistoryQueryError("分頁位置不正確");
    cursor = Number(cursorText);
  }
  const limitText = params.get("limit");
  let limit = HISTORY_PAGE_SIZE;
  if (limitText !== null && limitText !== "") {
    if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > HISTORY_MAX_LIMIT) throw new HistoryQueryError("每頁筆數不正確");
    limit = Number(limitText);
  }
  return { q, statuses: statuses as TaskStatus[], modes: modes as ExecutorMode[], range, cursor, limit };
}

/** YYYY-MM-DD（本機時區的一整天；to 含當天）或完整 ISO 時間；回傳毫秒。 */
function parseDate(value: string | null, endOfDay: boolean): number | null {
  if (value === null || value === "") return null;
  let ms: number;
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    // 2026-13-45、2026-02-31 這類不存在的日期：Date 會自動進位，所以要核對年月日沒有變。
    const day = new Date(y, m - 1, d);
    if (day.getFullYear() !== y || day.getMonth() !== m - 1 || day.getDate() !== d) throw new HistoryQueryError("日期格式不正確");
    ms = endOfDay ? new Date(y, m - 1, d + 1).getTime() - 1 : day.getTime();
  } else if (ISO_TIME.test(value)) {
    ms = Date.parse(value);
  } else {
    throw new HistoryQueryError("日期格式不正確");
  }
  if (!Number.isFinite(ms)) throw new HistoryQueryError("日期格式不正確");
  return ms;
}

/**
 * Markdown 轉成可搜尋、可顯示的純文字（片段只顯示文字，不渲染 HTML）。
 * 每個樣式都有長度上限，避免像 50,000 個「[」這種內容讓正規式退化成平方時間、卡住核心。
 * 連結文字與網址不收「[」「(」，每次嘗試在下一個連結開頭就停下，重複的「[x](」不會每處往後掃 2,000 字。
 * 底線只去掉成對的強調記號（`_斜體_`、`__粗體__`），識別字裡的底線（ANTHROPIC_API_KEY）保留。
 */
export function markdownToPlain(markdown: string): string {
  return markdown
    .replace(/```[^\n]{0,100}\n?/g, " ")
    .replace(/!\[([^[\]\n]{0,300})\]\(([^()[\]\s]{0,2000})\)/g, "$1")
    .replace(/\[([^[\]\n]{0,300})\]\(([^()[\]\s]{0,2000})\)/g, "$1")
    .replace(/^[ \t]{0,8}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]{0,300}?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]{0,300}?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]{0,300}?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/`+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 成果內容的純文字與折疊結果，只放在核心記憶體（不寫檔）：成果建立後不會再變（固定 version 1），
 * 所以依 artifact_id＋version＋內容長度重用，不必每次查詢都重新轉換。刪除時由 forgetHistoryArtifact 清掉。
 */
const CONTENT_CACHE = new Map<string, { key: string; text: string; folded: string }>();
const CONTENT_CACHE_MAX = 5000;

function contentField(artifact: Artifact): { text: string; folded: string } {
  const key = `${artifact.version}:${artifact.content.length}`;
  const hit = CONTENT_CACHE.get(artifact.artifact_id);
  if (hit && hit.key === key) return hit;
  const text = markdownToPlain(artifact.content);
  const entry = { key, text, folded: foldForSearch(text) };
  if (CONTENT_CACHE.size >= CONTENT_CACHE_MAX) CONTENT_CACHE.delete(CONTENT_CACHE.keys().next().value!);
  CONTENT_CACHE.set(artifact.artifact_id, entry);
  return entry;
}

/** 成果被刪除時呼叫：記憶體裡的純文字也一起丟掉。 */
export function forgetHistoryArtifact(artifactId: string): void {
  CONTENT_CACHE.delete(artifactId);
}

/** MEM-4c：丟棄記憶體裡全部的成果純文字快取（OS 鎖定、閒置、關閉記憶、結束 App 時，和受保護內容一起丟）。 */
export function forgetAllHistoryContent(): number {
  const count = CONTENT_CACHE.size;
  CONTENT_CACHE.clear();
  return count;
}

/** 測試用：快取裡目前有幾筆成果純文字。 */
export function historyContentCacheSize(): number {
  return CONTENT_CACHE.size;
}

export type HistoryField = Field;
/** 一個可比對的欄位（folded 是 foldForSearch 的結果，長度和 text 相同）。 */
export interface PreparedField { field: Field; text: string; folded: string }

interface Prepared {
  doc: HistoryDocument;
  source: HistorySource;
  fields: PreparedField[];
}

/**
 * 一筆紀錄的可比對欄位（順序固定：標題、成果內容、步驟、註記）。cache=false（MEM-4c 的受保護內容）時不讀寫 CONTENT_CACHE，
 * 純文字只留在呼叫端（倒排索引或這一頁的片段），丟棄時不必另外清快取。
 */
export function prepareFields(doc: HistoryDocument, cache = true): PreparedField[] {
  const fields: PreparedField[] = [];
  const add = (field: Field, text: string) => {
    if (text) fields.push({ field, text, folded: foldForSearch(text) });
  };
  add("title", doc.task.title);
  if (doc.artifact) {
    const content = cache ? contentField(doc.artifact) : (() => { const text = markdownToPlain(doc.artifact!.content); return { text, folded: foldForSearch(text) }; })();
    if (content.text) fields.push({ field: "content", text: content.text, folded: content.folded });
  }
  // 「規劃步驟」那一步是系統加的，不是任務內容，但標題就是普通文字；一併比對無害。
  for (const step of doc.task.steps) add("step", step.title);
  if (doc.artifact) for (const note of [...doc.artifact.assumptions, ...doc.artifact.capability_gaps]) add("notes", note);
  return fields;
}

function prepare(doc: HistoryDocument, source: HistorySource, cache = true): Prepared {
  return { doc, source, fields: prepareFields(doc, cache) };
}

export function passesFilters(task: Task, filters: HistoryFilters): boolean {
  if (filters.statuses.length > 0 && !filters.statuses.includes(task.status)) return false;
  if (filters.modes.length > 0 && !filters.modes.includes(task.mode)) return false;
  const created = Date.parse(task.created_at);
  if (filters.range.from !== null && !(created >= filters.range.from)) return false;
  if (filters.range.to !== null && !(created <= filters.range.to)) return false;
  return true;
}

/** text 裡每個詞出現的位置（不重疊、依位置排序）。 */
function findMatches(folded: string, terms: readonly string[]): { start: number; end: number }[] {
  const hits: { start: number; end: number }[] = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at < 0) break;
      hits.push({ start: at, end: at + term.length });
      from = at + term.length;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  // 相鄰的二字片段（香菜、菜湯）合併成一段，標示時才不會切碎。
  const merged: { start: number; end: number }[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  return merged;
}

/** 以第一個命中為中心，前後各約 radius 字的片段；offset 相對於片段文字。 */
export function makeSnippet(field: Field, text: string, matches: { start: number; end: number }[], radius = HISTORY_SNIPPET_RADIUS): HistorySnippet {
  if (matches.length === 0) {
    const end = Math.min(text.length, radius * 2);
    return { field, text: text.slice(0, end), matches: [], truncated_start: false, truncated_end: end < text.length };
  }
  const first = matches[0]!;
  let start = Math.max(0, first.start - radius);
  let end = Math.min(text.length, first.end + radius);
  // 不把代理對（emoji 等）切成一半。
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start -= 1;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end += 1;
  return {
    field,
    text: text.slice(start, end),
    matches: matches.filter((m) => m.start >= start && m.end <= end).map((m) => ({ start: m.start - start, end: m.end - start })),
    truncated_start: start > 0,
    truncated_end: end < text.length,
  };
}

interface Scored {
  item: HistoryItem;
  coverage: number;
  score: number;
  createdMs: number;
}

/**
 * 在所有來源裡搜尋。沒有查詢詞時依交辦時間新到舊列出（只套篩選）。
 * 排序：命中的查詢詞比例 → 加權分數（標題 3、成果內容 2、步驟與註記 1；整句出現另外加分）→ 交辦時間新到舊 → task_id。
 * 有兩個以上的查詢詞時，至少要命中一半才算（避免只命中一個二字片段的雜訊）。
 */
export function searchHistory(sources: readonly HistorySource[], filters: HistoryFilters & { cursor: number; limit: number }): HistoryPage {
  const { terms, phrase } = searchTermsOf(filters.q);
  const hasQuery = filters.q.trim() !== "";
  const sourceList = sources.map((s) => ({ id: s.id, protected: s.protected }));
  const next = filters.cursor + filters.limit;
  if (!hasQuery) {
    // 沒有查詢詞：只套篩選、新到舊；只為這一頁產生片段。
    const listed: { doc: HistoryDocument; source: HistorySource; createdMs: number }[] = [];
    for (const source of sources) {
      for (const doc of source.documents()) if (passesFilters(doc.task, filters)) listed.push({ doc, source, createdMs: Date.parse(doc.task.created_at) || 0 });
    }
    listed.sort((a, b) => b.createdMs - a.createdMs || a.doc.task.task_id.localeCompare(b.doc.task.task_id));
    return {
      items: listed.slice(filters.cursor, next).map((x) => listItem(x.doc, x.source)),
      total: listed.length,
      next_cursor: next < listed.length ? String(next) : null,
      sources: sourceList,
    };
  }
  const scored: Scored[] = [];
  for (const source of sources) {
    for (const doc of source.documents()) {
      if (!passesFilters(doc.task, filters)) continue;
      const result = scoreDocument(prepare(doc, source), terms, phrase);
      if (result) scored.push({ ...result, createdMs: Date.parse(doc.task.created_at) || 0 });
    }
  }
  scored.sort((a, b) => b.coverage - a.coverage || b.score - a.score || b.createdMs - a.createdMs || a.item.task_id.localeCompare(b.item.task_id));
  return {
    items: scored.slice(filters.cursor, next).map((s) => s.item),
    total: scored.length,
    next_cursor: next < scored.length ? String(next) : null,
    sources: sourceList,
  };
}

function baseItem(doc: HistoryDocument, source: HistorySource): Omit<HistoryItem, "title_matches" | "snippet" | "score"> {
  const { task, artifact } = doc;
  return {
    task_id: task.task_id,
    artifact_id: artifact?.artifact_id ?? null,
    title: task.title,
    status: task.status,
    mode: task.mode,
    model: artifact?.model ?? task.model,
    created_at: task.created_at,
    finished_at: task.finished_at,
    source: source.id,
    protected: source.protected,
  };
}

export function listItem(doc: HistoryDocument, source: HistorySource, cache = true): HistoryItem {
  const content = doc.artifact ? (cache ? contentField(doc.artifact).text : markdownToPlain(doc.artifact.content)) : "";
  return { ...baseItem(doc, source), score: 0, title_matches: [], snippet: content ? makeSnippet("content", content, []) : null };
}

/** 查詢詞與整句（searchHistory 和 MEM-4c 的受保護搜尋共用同一份計算）。 */
export function searchTermsOf(q: string): { terms: string[]; phrase: string } {
  return { terms: queryTerms(q), phrase: foldForSearch(q.normalize("NFKC")).replace(/\s+/g, " ").trim() };
}

/**
 * 只用折疊後的欄位計算排序用的命中比例與分數（不需要原文）。不算命中回 null。
 * MEM-4c 的倒排索引用它排序，片段則只為這一頁解密原文後再用 scoreDocument 產生，所以兩邊的結果逐筆相同。
 */
export function scoreFields(fields: readonly { field: Field; folded: string }[], terms: readonly string[], phrase: string): { coverage: number; score: number } | null {
  if (terms.length === 0) return null;
  let score = 0;
  let hit = 0;
  for (const term of terms) {
    let best = 0;
    for (const f of fields) if (WEIGHT[f.field] > best && f.folded.includes(term)) best = WEIGHT[f.field];
    if (best > 0) hit += 1;
    score += best;
  }
  if (hit === 0) return null;
  const coverage = hit / terms.length;
  if (terms.length >= 2 && coverage < 0.5) return null;
  if (phrase.length >= 2) {
    for (const f of fields) if (f.folded.includes(phrase)) score += WEIGHT[f.field] * 2;
  }
  return { coverage, score };
}

/** 一筆紀錄的完整結果（含標題標示與片段）；cache=false 時不碰 CONTENT_CACHE。 */
export function scoreHistoryDocument(doc: HistoryDocument, source: HistorySource, terms: readonly string[], phrase: string, cache = true): { coverage: number; score: number; item: HistoryItem } | null {
  return scoreDocument(prepare(doc, source, cache), terms, phrase);
}

function scoreDocument(p: Prepared, terms: readonly string[], phrase: string): { coverage: number; score: number; item: HistoryItem } | null {
  const ranked = scoreFields(p.fields, terms, phrase);
  if (!ranked) return null;
  const { coverage, score } = ranked;
  const title = p.fields.find((f) => f.field === "title");
  const titleMatches = title ? findMatches(title.folded, terms) : [];
  // 片段：成果內容優先，其次步驟、註記；都沒有命中（只命中標題）時給內容開頭。
  let snippet: HistorySnippet | null = null;
  for (const field of ["content", "step", "notes"] as const) {
    for (const f of p.fields.filter((x) => x.field === field)) {
      const matches = findMatches(f.folded, terms);
      if (matches.length > 0) {
        snippet = makeSnippet(field, f.text, matches);
        break;
      }
    }
    if (snippet) break;
  }
  if (!snippet) {
    const content = p.fields.find((f) => f.field === "content");
    if (content) snippet = makeSnippet("content", content.text, []);
  }
  return { coverage, score, item: { ...baseItem(p.doc, p.source), score, title_matches: titleMatches, snippet } };
}
