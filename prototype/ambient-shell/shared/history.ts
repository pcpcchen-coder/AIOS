// HIST-1 成果紀錄的資料契約（核心 /api/history 與頁面共用）。
// source／protected：目前只有一般任務（"tasks"，protected=false）；MEM-4c 的受保護成果之後以另一個來源併入，
// 頁面依 protected 決定能不能顯示內容與刪除方式。

import type { Artifact, ExecutorMode, Task, TaskStatus } from "./types.ts";

/** 每頁筆數（預設）與上限。 */
export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_MAX_LIMIT = 50;
/** 片段以命中處為中心、前後各約這麼多字。 */
export const HISTORY_SNIPPET_RADIUS = 120;

export interface HistoryRange {
  /** 交辦時間下限（毫秒，含）；null＝不限。 */
  from: number | null;
  /** 交辦時間上限（毫秒，含）；null＝不限。 */
  to: number | null;
}

export interface HistoryFilters {
  q: string;
  statuses: TaskStatus[];
  modes: ExecutorMode[];
  range: HistoryRange;
}

/** 命中的位置（UTF-16 單位，相對於所在文字）；[start, end)。 */
export interface HistoryMatch {
  start: number;
  end: number;
}

export interface HistorySnippet {
  /** 片段取自哪裡：成果內容、步驟標題，或假設與能力缺口。 */
  field: "content" | "step" | "notes" | "title";
  text: string;
  matches: HistoryMatch[];
  /** 片段前後是否還有被截掉的文字（頁面自己加「…」，不放進 text，offset 才不會偏）。 */
  truncated_start: boolean;
  truncated_end: boolean;
}

export interface HistoryItem {
  task_id: string;
  artifact_id: string | null;
  /** 使用者交辦時的原句。 */
  title: string;
  status: TaskStatus;
  mode: ExecutorMode;
  model: string | null;
  created_at: string;
  finished_at: string | null;
  /** 來源（目前只有 "tasks"）。 */
  source: string;
  /** 受保護成果（MEM-4c）；HIST-1 一律 false。 */
  protected: boolean;
  score: number;
  title_matches: HistoryMatch[];
  snippet: HistorySnippet | null;
}

export interface HistoryPage {
  items: HistoryItem[];
  total: number;
  /** 下一頁的游標（不透明字串）；null＝沒有下一頁。 */
  next_cursor: string | null;
  sources: { id: string; protected: boolean }[];
}

export interface HistoryDetail {
  task: Task;
  artifact: Artifact | null;
  source: string;
  protected: boolean;
}

/** 頁面送給 /api/history 的查詢參數。 */
export interface HistoryQuery {
  q?: string;
  status?: TaskStatus | "";
  mode?: ExecutorMode | "";
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}

export function historySearchPath(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.status) params.set("status", query.status);
  if (query.mode) params.set("mode", query.mode);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit) params.set("limit", String(query.limit));
  const text = params.toString();
  return text ? `/api/history?${text}` : "/api/history";
}

/** 執行中（含排隊、停止中）的任務不能刪除，要先停止。 */
export function isDeletable(task: Pick<Task, "status">): boolean {
  return task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
}
