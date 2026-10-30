import { t } from "./i18n.ts";
import type { Artifact, Task } from "../shared/types.ts";
import type { HistoryDetail, HistoryPage, HistoryQuery } from "../shared/history.ts";
import type { TasksRequest, TasksResponse, VaultView } from "../shared/protected-tasks.ts";

// MEM-4a：macOS App 加密保存任務時，SSE 與 HTTP 只給外殼（protected: true）。這裡在可信主視窗裡用 IPC 讀回真實的
// 標題、步驟與成果，只用來畫畫面（進度卡、成果、App 內成果紀錄）。給模型的頻道（get_tasks、即時語音的完成通知）
// 仍用原本的外殼，不經這裡。瀏覽器（沒有 IPC）只能顯示外殼的固定句，照實說「請在 App 內查看」。

export const PROTECTED_TITLE = "受保護的任務，請在 App 內查看";
export const PROTECTED_STEP = "受保護的步驟";
export const PROTECTED_ERROR = "受保護的錯誤說明，請在 App 內查看";
export const WITHDRAWN_TEXT = "這份成果用到已忘記的記憶，內容已移除";

export type TasksBridge = (request: TasksRequest) => Promise<TasksResponse>;

export class TaskBridgeError extends Error {}

/** 外殼的固定句依目前介面語言重畫（核心依任務語言寫，畫面照目前語言）。 */
export function shellView(task: Task): Task {
  if (!task.protected) return task;
  return {
    ...task,
    title: t(PROTECTED_TITLE),
    steps: task.steps.map((s) => ({ ...s, title: t(PROTECTED_STEP) })),
    error: task.error === null ? null : t(PROTECTED_ERROR),
  };
}

export class ProtectedTasks {
  private readonly cache = new Map<string, Task>();
  private readonly pending = new Set<string>();
  private listLoaded = false;
  /** 成果紀錄是從選單列「成果紀錄…」打開的（George 的 D2）：搜尋、詳細與重做帶 all。 */
  private all = false;

  constructor(private readonly bridge: TasksBridge | null, private readonly changed: () => void) {}

  get available(): boolean {
    return this.bridge !== null;
  }

  /** 選單列打開成果紀錄時 true，其他入口 false（核心另外核對選單點擊時間）。 */
  setAllScope(all: boolean): void {
    this.all = all;
  }

  private scope(): { all?: true } {
    return this.all ? { all: true } : {};
  }

  /** get_tasks（即時語音）：核心依那條路徑的記憶同意給真實標題或外殼。 */
  async voiceTasks(route: "live" | "api_key"): Promise<Task[]> {
    const res = await this.call({ op: "voice_tasks", route });
    if (res.op !== "voice_tasks") throw new TaskBridgeError(t("加密任務不可用"));
    return res.tasks;
  }

  private async call(request: TasksRequest): Promise<Extract<TasksResponse, { ok: true }>> {
    if (!this.bridge) throw new TaskBridgeError(t("加密任務不可用"));
    const res = await this.bridge(request);
    if (!res.ok) throw new TaskBridgeError(t(res.message));
    return res;
  }

  /** 畫面用：外殼換成可信主視窗讀回的真實內容；狀態、步驟狀態與時間一律以 SSE 的外殼為準（比較新）。 */
  display(task: Task): Task {
    if (!task.protected) return task;
    const real = this.cache.get(task.task_id);
    if (!real) return shellView(task);
    return {
      ...task,
      title: real.title,
      steps: task.steps.map((s, i) => ({ ...s, title: real.steps[i]?.title ?? t(PROTECTED_STEP) })),
      error: task.error === null ? null : real.error ?? t(PROTECTED_ERROR),
    };
  }

  /** 第一次（hello 之後）讀全部任務的真實內容。 */
  async loadAll(): Promise<void> {
    if (!this.bridge) return;
    try {
      const res = await this.call({ op: "list" });
      if (res.op !== "list") return;
      for (const task of res.tasks) this.cache.set(task.task_id, task);
      this.listLoaded = true;
      this.changed();
    } catch {
      // 讀不到就照外殼顯示（固定句），不假裝有內容。
    }
  }

  /** SSE 的外殼更新：步驟數、狀態或錯誤變了才重讀那一筆。 */
  noteUpdate(shell: Task): void {
    if (!this.bridge || !shell.protected) return;
    const real = this.cache.get(shell.task_id);
    if (real && real.steps.length === shell.steps.length && real.status === shell.status && (real.error === null) === (shell.error === null) && !!real.withdrawn === !!shell.withdrawn) return;
    if (!real && !this.listLoaded && this.pending.size > 16) return;
    void this.refresh(shell.task_id);
  }

  forget(taskId: string): void {
    this.cache.delete(taskId);
  }

  private async refresh(taskId: string): Promise<void> {
    if (this.pending.has(taskId)) return;
    this.pending.add(taskId);
    try {
      const res = await this.call({ op: "get", task_id: taskId });
      if (res.op === "get") {
        this.cache.set(taskId, res.task);
        this.changed();
      }
    } catch {
      // 照外殼顯示
    } finally {
      this.pending.delete(taskId);
    }
  }

  /** 成果內容（只經 IPC）。 */
  async artifact(taskId: string): Promise<Artifact> {
    const res = await this.call({ op: "get", task_id: taskId });
    if (res.op !== "get") throw new TaskBridgeError(t("無法載入成果"));
    this.cache.set(taskId, res.task);
    if (!res.artifact) throw new TaskBridgeError(t(res.task.withdrawn ? WITHDRAWN_TEXT : "無法載入成果"));
    return res.artifact;
  }

  async search(query: HistoryQuery): Promise<HistoryPage> {
    const res = await this.call({ op: "search", query, ...this.scope() });
    if (res.op !== "search") throw new TaskBridgeError(t("無法搜尋"));
    return res.page;
  }

  async detail(taskId: string): Promise<HistoryDetail> {
    const res = await this.call({ op: "get", task_id: taskId, ...this.scope() });
    if (res.op !== "get") throw new TaskBridgeError(t("找不到這個任務"));
    return { task: res.task, artifact: res.artifact, source: "tasks", protected: true };
  }

  async redo(taskId: string, requestId: string): Promise<{ task: Task; memoryUsed: number }> {
    const res = await this.call({ op: "redo", task_id: taskId, request_id: requestId, ...this.scope() });
    if (res.op !== "redo") throw new TaskBridgeError(t("無法重做"));
    this.cache.set(res.task.task_id, res.task);
    return { task: res.task, memoryUsed: res.memory_used };
  }

  /** MEM-4b：受保護原句卡的標題（SSE 只送卡片 ID；原句由核心持有）。 */
  async cardTitle(card: string): Promise<string> {
    const res = await this.call({ op: "card_title", card });
    if (res.op !== "card_title") throw new TaskBridgeError(t("這張卡片已失效（可能換了人物或超過時間）；請再說一次"));
    return res.title;
  }

  /** MEM-4b：原句卡上按「交辦」：核心用自己持有的原句交辦（放行時帶記憶）。 */
  async cardDelegate(card: string, requestId: string): Promise<{ task: Task; memoryUsed: number; memoryUnavailable: boolean }> {
    const res = await this.call({ op: "card_delegate", card, request_id: requestId });
    if (res.op !== "card_delegate") throw new TaskBridgeError(t("這張卡片已失效（可能換了人物或超過時間）；請再說一次"));
    this.cache.set(res.task.task_id, res.task);
    return { task: res.task, memoryUsed: res.memory_used, memoryUnavailable: res.memory === "unavailable" };
  }

  async status(): Promise<VaultView | null> {
    if (!this.bridge) return null;
    try {
      const res = await this.call({ op: "status" });
      return res.op === "status" ? res.vault : null;
    } catch {
      return null;
    }
  }

  /** 刪除明文備份：核心先跳原生確認，使用者按「刪除明文備份」才刪。 */
  async deleteBackups(): Promise<{ deleted: number; vault: VaultView } | null> {
    try {
      const res = await this.call({ op: "delete_backups" });
      return res.op === "delete_backups" ? { deleted: res.deleted, vault: res.vault } : null;
    } catch (error) {
      if (error instanceof TaskBridgeError) return null;
      throw error;
    }
  }
}

const MIGRATION_STEP_LABEL = { read: "讀取明文", encrypt: "加密寫入", verify: "解密驗證", backup: "建立備份", switch: "切換為加密保存" } as const;

/**
 * 加密搬遷與明文備份的提示文字（固定句，經共用翻譯表）。沒有要說的時候回 null。只說真實狀態。
 * 審查 minor 8：自動出現只在這次啟動真的搬遷過（成功或失敗）、或這次無法加密時；其他時候只有使用者從選單列
 * 「刪除明文備份…」打開（manual）才出現。
 */
export function vaultNotice(vault: VaultView | null, manual = false): { text: string; canDelete: boolean } | null {
  if (!vault) return null;
  if (vault.mode === "plain_fallback") {
    const step = vault.migration && !vault.migration.ok ? vault.migration.step : null;
    return { text: step ? t("任務加密搬遷失敗（{0}），這次仍以明文保存；原本的檔案沒有被改動。", t(MIGRATION_STEP_LABEL[step])) : t("這台 Mac 現在無法加密保存任務（金鑰不可用），這次仍以明文保存；原本的檔案沒有被改動。"), canDelete: false };
  }
  if (vault.mode === "sealed" && vault.failure) return { text: t("無法解開任務的加密金鑰：新任務的內容只留在這次執行的記憶體裡，重新啟動後就沒有了。"), canDelete: false };
  if (vault.mode !== "sealed") return null;
  if (vault.backups.length > 0 && (manual || vault.migration?.ok)) {
    return {
      text: vault.backups.length === 1
        ? t("任務與成果已加密保存並逐筆驗證。明文備份保留在資料夾「{0}」，確認不需要後可以刪除。", vault.backups[0]!)
        : t("任務已加密保存；還有 {0} 個明文備份資料夾，確認不需要後可以刪除。", String(vault.backups.length)),
      canDelete: true,
    };
  }
  if (manual) return { text: t("沒有任務的明文備份。"), canDelete: false };
  return null;
}
