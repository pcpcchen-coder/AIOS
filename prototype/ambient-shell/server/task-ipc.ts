import { historySearchPath, type HistoryQuery } from "../shared/history.ts";
import { DELEGATE_CARD, TASK_ID, type TasksResponse, type VaultView } from "../shared/protected-tasks.ts";
import type { Task } from "../shared/types.ts";
import type { Locale } from "../shared/i18n.mjs";
import { HistoryQueryError, parseHistoryQuery, searchHistory } from "./history.ts";
import type { ProtectedDelegation } from "./memory/service.ts";
import type { ChatTarget } from "./memory/retrieve.ts";
import type { TaskRunner } from "./runner.ts";
import { RELOAD_FAILED, shellOf, tasksForTarget, type TaskStore } from "./store.ts";
import { VaultError } from "./sealed-vault.ts";

// MEM-4a：加密保存任務的 IPC 處理（只有 macOS App；desktop/tasks-ipc.mjs 先過濾發送者與形狀，這裡再完整驗證）。
// - list／get：完整內容只給可信主視窗（進度卡、成果畫面用真實標題與成果）。
// - search：App 內的成果紀錄搜尋加密任務的真實內容（MEM-4c：TaskStore.searchProtected 的 RAM 倒排索引，結果和逐筆掃描相同）；
//   /api/history 仍只有外殼。範圍（D2）在解密片段之前就套用。
// - MEM-4c：已結束任務的內容在需要時才解密；金鑰不可用時 get／search／redo 照實回 RELOAD_FAILED，不給空結果或外殼冒充。
// - redo：核心用自己保存的原句重做；記憶放行時重新檢索目前的記憶（不沿用舊依賴）。
// - delete_backups：主程序跳原生確認（頁面無法偽造），使用者按「刪除」才刪明文備份。
// - card_title／card_delegate（MEM-4b）：受保護原句卡。SSE 只送卡片 ID；標題經這裡給可信主視窗；按「交辦」算直接確認，
//   放行時走受保護交辦（帶記憶），不能時照舊用核心持有的原句建立不帶記憶的任務。
// log 只記 op 與筆數，不記內容。

export interface TaskIpcOptions {
  store: TaskStore;
  runner: TaskRunner;
  memory: {
    redoProtected(input: { title: string; requestId: string; retryOf: string; locale?: Locale }): Promise<ProtectedDelegation | null>;
    taskScope?(full: boolean): Promise<(task: Pick<Task, "task_id" | "memory">) => boolean>;
    taskTitleFilter?(target: ChatTarget | null): ((task: Pick<Task, "task_id" | "memory">) => boolean) | null;
    routeTarget?(route: "live" | "api_key"): ChatTarget | null;
    /** MEM-4b：受保護原句卡（核心持有原句）。 */
    delegateCardTitle?(card: string): string | null;
    delegateCard?(card: string, requestId: string): Promise<{ title: string; locale?: Locale; out: ProtectedDelegation | null } | null>;
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
/** MEM-4c 審查 minor 3：記憶層正在提交撤回（hold）。 */
export const MEMORY_UPDATING = "正在更新記憶，請稍後再試";

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
    const baseScope = async () => (options.memory?.taskScope ? await options.memory.taskScope(full) : (task: Pick<Task, "memory">) => full || task.memory !== true);
    // MEM-4c：記憶層正在提交撤回的任務（hold）與記憶被撤銷、停止中的任務（審查 minor 1）一律當範圍外（外殼）。
    const scope = async () => { const inScope = await baseScope(); return (task: Pick<Task, "task_id" | "memory" | "cancel_reason" | "withdrawn">) => inScope(task) && !store.hiddenNow(task); };
    const reloadFailed = (): TasksResponse => ({ ok: false, code: "unavailable", message: RELOAD_FAILED });
    switch (req.op) {
      case "status":
        return { ok: true, op: "status", vault: vaultView(store) };
      case "list": {
        const inScope = await scope();
        const st = { decrypted: 0 };
        const started = now();
        const tasks = store.listFor(inScope, st);
        // 只記筆數與耗時（審查 minor 5；Mac gate 第 6 步量延遲用）。
        if (store.sealed) options.log?.(`tasks: 受保護清單（${tasks.length} 筆，解密 ${st.decrypted}，${now() - started} ms）`);
        return { ok: true, op: "list", tasks };
      }
      case "voice_tasks": {
        if (req.route !== "live" && req.route !== "api_key") return bad("route must be live or api_key");
        const target = options.memory?.routeTarget?.(req.route) ?? null;
        return { ok: true, op: "voice_tasks", tasks: tasksForTarget(store, options.memory, target) };
      }
      case "get": {
        if (typeof req.task_id !== "string" || !TASK_ID.test(req.task_id)) return bad("task_id is required");
        const shell = store.publicGet(req.task_id);
        if (!shell) return { ok: false, code: "not_found", message: "找不到這個任務" };
        // 範圍在解密之前判斷（外殼就有 task_id 與 memory）：範圍外的任務不解密。
        if (!(await scope())(shell)) return { ok: true, op: "get", task: shellOf(shell), artifact: null };
        let opened: ReturnType<TaskStore["open"]>;
        try { opened = store.open(req.task_id); } catch (error) { if (error instanceof VaultError) return reloadFailed(); throw error; }
        if (!opened) return { ok: false, code: "not_found", message: "找不到這個任務" };
        return { ok: true, op: "get", task: opened.task, artifact: opened.artifact };
      }
      case "search": {
        const query = req.query && typeof req.query === "object" && !Array.isArray(req.query) ? req.query as HistoryQuery : null;
        if (!query) return bad("query is required");
        try {
          const params = new URLSearchParams(historySearchPath(query).split("?")[1] ?? "");
          const parsed = parseHistoryQuery(params);
          const inScope = await scope();
          // 加密模式（MEM-4c）：倒排索引；await 之後到回傳之間是同步的，撤回或刪除不會插在中間。
          if (store.sealed) {
            const st = { built: false, decrypted: 0, scored: 0, filtered: 0 };
            const started = now();
            const page = store.searchProtected(parsed, inScope, st);
            // 只記筆數與耗時（Mac gate 量延遲用），不記查詢文字或內容。
            options.log?.(`tasks: 受保護搜尋（${st.built ? "建立索引" : parsed.q.trim() === "" ? "清單不用索引" : "索引已建立"}，解密 ${st.decrypted}，比對 ${st.scored}／${st.filtered}，結果 ${page.total}，${now() - started} ms）`);
            return { ok: true, op: "search", page };
          }
          const documents = () => store.documents().map((d) => (inScope(d.task) ? d : { task: shellOf(d.task), artifact: null }));
          return { ok: true, op: "search", page: searchHistory([{ id: "tasks", protected: store.sealed, documents }], parsed) };
        } catch (error) {
          if (error instanceof HistoryQueryError) return bad(error.message);
          if (error instanceof VaultError) return reloadFailed();
          throw error;
        }
      }
      case "redo": {
        if (typeof req.task_id !== "string" || !TASK_ID.test(req.task_id)) return bad("task_id is required");
        if (typeof req.request_id !== "string" || !REQUEST_ID.test(req.request_id)) return bad("request_id is required");
        const shell = store.publicGet(req.task_id);
        if (!shell) return { ok: false, code: "not_found", message: "找不到這個任務" };
        // 審查 minor 3：記憶正在提交撤回時照實說，不說成「其他家人的任務」。
        if (store.isHeld(req.task_id)) return { ok: false, code: "conflict", message: MEMORY_UPDATING };
        if (!(await scope())(shell)) return { ok: false, code: "conflict", message: "這是其他家人的任務；請從選單列「成果紀錄…」打開後再重做" };
        if (shell.status !== "succeeded" && shell.status !== "failed" && shell.status !== "cancelled") return { ok: false, code: "conflict", message: FINISHED_ONLY };
        // 經授權的存取（open：解密、留在記憶體、重新計時）；金鑰不可用照實說，不拿外殼的固定句重做。
        let opened: ReturnType<TaskStore["open"]>;
        try { opened = store.open(req.task_id); } catch (error) { if (error instanceof VaultError) return reloadFailed(); throw error; }
        if (store.isHeld(req.task_id)) return { ok: false, code: "conflict", message: MEMORY_UPDATING };
        const original = opened?.task;
        if (!original) return { ok: false, code: "not_found", message: "找不到這個任務" };
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
      case "card_title": {
        if (typeof req.card !== "string" || !DELEGATE_CARD.test(req.card)) return bad("card is required");
        const title = options.memory?.delegateCardTitle?.(req.card) ?? null;
        if (title === null) return { ok: false, code: "not_found", message: "這張卡片已失效（可能換了人物或超過時間）；請再說一次" };
        return { ok: true, op: "card_title", title };
      }
      case "card_delegate": {
        if (typeof req.card !== "string" || !DELEGATE_CARD.test(req.card)) return bad("card is required");
        if (typeof req.request_id !== "string" || !REQUEST_ID.test(req.request_id)) return bad("request_id is required");
        const taken = await options.memory?.delegateCard?.(req.card, req.request_id);
        if (!taken) return { ok: false, code: "not_found", message: "這張卡片已失效（可能換了人物或超過時間）；請再說一次" };
        // 不能受保護交辦（沒放行、記憶關著、沒有加密保存）：照舊建立不帶記憶的任務（和 MEM-4a 的卡片一樣）。
        const task = taken.out?.task ?? runner.submit({ title: taken.title, request_id: req.request_id, ...(taken.locale === "en" ? { locale: "en" as const } : {}) });
        options.log?.(`tasks: 交辦卡（帶記憶 ${taken.out?.used ?? 0} 筆）`);
        return { ok: true, op: "card_delegate", task, memory_used: taken.out?.used ?? 0, memory: taken.out ? "used" : "unavailable" };
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
