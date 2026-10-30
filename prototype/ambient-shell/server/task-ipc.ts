import { historySearchPath, type HistoryQuery } from "../shared/history.ts";
import { TASK_ID, type TasksResponse, type VaultView } from "../shared/protected-tasks.ts";
import type { Task } from "../shared/types.ts";
import type { Locale } from "../shared/i18n.mjs";
import { HistoryQueryError, parseHistoryQuery, searchHistory } from "./history.ts";
import type { ProtectedDelegation } from "./memory/service.ts";
import type { ChatTarget } from "./memory/retrieve.ts";
import type { TaskRunner } from "./runner.ts";
import { shellOf, tasksForTarget, type TaskStore } from "./store.ts";

// MEM-4a：加密保存任務的 IPC 處理（只有 macOS App；desktop/tasks-ipc.mjs 先過濾發送者與形狀，這裡再完整驗證）。
// - list／get：完整內容只給可信主視窗（進度卡、成果畫面用真實標題與成果）。
// - search：App 內的成果紀錄搜尋加密任務的真實內容（受保護的 HistorySource，MEM-4c 的一部分）；/api/history 仍只有外殼。
// - redo：核心用自己保存的原句重做；記憶放行時重新檢索目前的記憶（不沿用舊依賴）。
// - delete_backups：主程序跳原生確認（頁面無法偽造），使用者按「刪除」才刪明文備份。
// log 只記 op 與筆數，不記內容。

export interface TaskIpcOptions {
  store: TaskStore;
  runner: TaskRunner;
  memory: {
    redoProtected(input: { title: string; requestId: string; retryOf: string; locale?: Locale }): Promise<ProtectedDelegation | null>;
    taskScope?(full: boolean): Promise<(task: Pick<Task, "task_id" | "memory">) => boolean>;
    taskTitleFilter?(target: ChatTarget | null): ((task: Pick<Task, "task_id" | "memory">) => boolean) | null;
    routeTarget?(route: "live" | "api_key"): ChatTarget | null;
  } | null;
  confirmDeleteBackups: (count: number) => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
}

/** 選單列「成果紀錄…」打開後，帶 all 的請求看得到其他家人帶記憶任務的時間（George 的 D2）。 */
export const FULL_SCOPE_MS = 10 * 60_000;

export interface TaskIpc {
  (request: unknown, ctx?: { userInitiated?: boolean }): Promise<TasksResponse>;
  /** 主視窗導覽、重新載入或 renderer 結束：收回「看得到其他家人」的權限。 */
  closeSessions(): void;
}

const REQUEST_ID = /^req_[A-Za-z0-9_-]{6,64}$/;
const FINISHED_ONLY = "只有已結束的任務可以重做";

export function vaultView(store: TaskStore): VaultView {
  const s = store.vaultStatus();
  return { mode: s.mode, failure: s.failure, migration: s.migration, backups: s.backups, unsealed: s.unsealed, unreadable: s.unreadable };
}

export function createTaskIpc(options: TaskIpcOptions): TaskIpc {
  const { store, runner } = options;
  const now = options.now ?? Date.now;
  const bad = (message: string): TasksResponse => ({ ok: false, code: "bad_request", message });
  let fullUntil = 0;
  const handle = async (raw: unknown, ctx: { userInitiated?: boolean } = {}): Promise<TasksResponse> => {
    const req = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (!req) return bad("request must be an object");
    // 選單列點擊（主程序的 10 秒時間窗）開出的權限；帶 all 的請求在期限內才看得到其他家人的帶記憶任務。
    if (ctx.userInitiated === true) fullUntil = now() + FULL_SCOPE_MS;
    const full = req.all === true && now() < fullUntil;
    const scope = async () => (options.memory?.taskScope ? await options.memory.taskScope(full) : (task: Pick<Task, "memory">) => full || task.memory !== true);
    switch (req.op) {
      case "status":
        return { ok: true, op: "status", vault: vaultView(store) };
      case "list": {
        const inScope = await scope();
        return { ok: true, op: "list", tasks: store.list().map((t) => (inScope(t) ? t : shellOf(t))) };
      }
      case "voice_tasks": {
        if (req.route !== "live" && req.route !== "api_key") return bad("route must be live or api_key");
        const target = options.memory?.routeTarget?.(req.route) ?? null;
        return { ok: true, op: "voice_tasks", tasks: tasksForTarget(store, options.memory, target) };
      }
      case "get": {
        if (typeof req.task_id !== "string" || !TASK_ID.test(req.task_id)) return bad("task_id is required");
        const task = store.get(req.task_id);
        if (!task) return { ok: false, code: "not_found", message: "找不到這個任務" };
        if (!(await scope())(task)) return { ok: true, op: "get", task: shellOf(task), artifact: null };
        return { ok: true, op: "get", task, artifact: task.artifact_id ? store.getArtifact(task.artifact_id) ?? null : null };
      }
      case "search": {
        const query = req.query && typeof req.query === "object" && !Array.isArray(req.query) ? req.query as HistoryQuery : null;
        if (!query) return bad("query is required");
        try {
          const params = new URLSearchParams(historySearchPath(query).split("?")[1] ?? "");
          const parsed = parseHistoryQuery(params);
          const inScope = await scope();
          const documents = () => store.documents().map((d) => (inScope(d.task) ? d : { task: shellOf(d.task), artifact: null }));
          return { ok: true, op: "search", page: searchHistory([{ id: "tasks", protected: store.sealed, documents }], parsed) };
        } catch (error) {
          if (error instanceof HistoryQueryError) return bad(error.message);
          throw error;
        }
      }
      case "redo": {
        if (typeof req.task_id !== "string" || !TASK_ID.test(req.task_id)) return bad("task_id is required");
        if (typeof req.request_id !== "string" || !REQUEST_ID.test(req.request_id)) return bad("request_id is required");
        const original = store.get(req.task_id);
        if (!original) return { ok: false, code: "not_found", message: "找不到這個任務" };
        if (!(await scope())(original)) return { ok: false, code: "conflict", message: "這是其他家人的任務；請從選單列「成果紀錄…」打開後再重做" };
        if (original.status !== "succeeded" && original.status !== "failed" && original.status !== "cancelled") return { ok: false, code: "conflict", message: FINISHED_ONLY };
        // 審查 M2：讀不到內容的任務只有外殼的固定句，不能重做。
        if (store.contentMissing(original.task_id)) return { ok: false, code: "conflict", message: "這個任務的內容這次無法解開，不能重做" };
        // 原句由核心保存（不是頁面送來的）。只有確定是使用者原句的任務（origin user_sentence）才在放行時重新取用記憶；
        // 模型改寫的標題或交辦卡的任務照一般重做，不帶記憶。
        const locale = original.locale === "en" ? ("en" as const) : undefined;
        const viaMemory = original.origin === "user_sentence"
          ? await options.memory?.redoProtected({ title: original.title, requestId: req.request_id, retryOf: original.task_id, ...(locale ? { locale } : {}) })
          : null;
        let task: Task | null = viaMemory?.task ?? null;
        if (!task) task = runner.retry(original.task_id, req.request_id, { redo: true });
        if (!task) return { ok: false, code: "conflict", message: FINISHED_ONLY };
        options.log?.(`tasks: 重做（帶記憶 ${viaMemory?.used ?? 0} 筆）`);
        return { ok: true, op: "redo", task, memory_used: viaMemory?.used ?? 0 };
      }
      case "delete_backups": {
        const count = store.vaultStatus().backups.length;
        if (count === 0) return { ok: true, op: "delete_backups", deleted: 0, vault: vaultView(store) };
        if (!(await options.confirmDeleteBackups(count))) return { ok: false, code: "cancelled", message: "沒有刪除明文備份" };
        const deleted = store.deleteBackups();
        return { ok: true, op: "delete_backups", deleted, vault: vaultView(store) };
      }
      default:
        return bad("unknown op");
    }
  };
  return Object.assign(handle, { closeSessions: () => { fullUntil = 0; } });
}
