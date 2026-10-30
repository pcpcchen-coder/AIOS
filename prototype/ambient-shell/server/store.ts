import { localize } from "./localization.ts";
import { normalizeLocale, type Locale } from "../shared/i18n.mjs";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, type Artifact, type ExecutorMode, type Task } from "../shared/types.ts";
import { isDomain } from "../shared/domain.ts";
import { VaultError, type SealedVault, type VaultFailure } from "./sealed-vault.ts";
import { hasPlaintext, migratePlaintext, plaintextBackups, deletePlaintextBackups, type MigrationResult, type MigrationStep } from "./task-migration.ts";
import { forgetHistoryArtifact } from "./history.ts";

type Listener = (task: Task) => void;
/** 刪除通知：被刪的任務 ID 與它的成果 ID（沒有成果時 null）。 */
type DeleteListener = (deleted: { task_id: string; artifact_id: string | null }) => void;

const INTERRUPTED = "本機核心重新啟動，任務在完成前中斷（未產生成果）。";

/** MEM-4a：受保護外殼的固定句（共用翻譯表；畫面另依目前語言顯示）。 */
export const PROTECTED_TITLE = "受保護的任務，請在 App 內查看";
export const PROTECTED_STEP = "受保護的步驟";
export const PROTECTED_ERROR = "受保護的錯誤說明，請在 App 內查看";
/** 用到的記憶被撤銷後，成果內容已移除（刪除加密檔），只留外殼與重做。 */
export const WITHDRAWN_TEXT = "這份成果用到已忘記的記憶，內容已移除";

/**
 * 任務加密（MEM-4a，只有 macOS App 注入）。vault 為 null：金鑰不可用或鎖被占用（failure 說明原因）。
 */
export interface TaskSealing {
  vault: SealedVault | null;
  failure?: VaultFailure | null;
  log?: (line: string) => void;
  now?: () => Date;
  /** 測試專用：搬遷每一步開始前呼叫，丟錯即模擬那一步失敗（after_shells＝tasks.json 已換成外殼、刪 artifacts.json 之前）。 */
  migrationCheckpoint?: (step: MigrationStep | "after_shells") => void;
  /**
   * MEM-4a（審查 M4a）：上次執行時記憶是否開著（memory-enabled.json 的提示，不開記憶檔）。回 false 時，載入時把所有
   * 帶記憶、還沒撤回的任務撤回：處理「關閉記憶後、刪成果檔前當機」而下次啟動又不會開記憶檔的情況。沒有提供時不做。
   */
  memoryEnabled?: () => boolean;
}

/**
 * 加密保存的狀態（給可信主視窗的 IPC 與 log；不含任何內容）。
 * mode：plain＝瀏覽器版（沒有加密）；sealed＝加密保存；plain_fallback＝macOS App 但這次無法加密（明文搬遷失敗，
 * 或金鑰不可用而舊資料還是明文），照舊明文保存，明文原檔沒有被改動。
 */
export interface VaultStatus {
  mode: "plain" | "sealed" | "plain_fallback";
  /** 金鑰或鎖的問題（sealed 模式下新任務的內容只留在記憶體，重新啟動後就沒有了）。 */
  failure: VaultFailure | null;
  migration: MigrationResult | null;
  /** 還沒刪除的明文備份資料夾名稱（只有名稱）。 */
  backups: string[];
  /** 這次執行裡沒能加密保存、只留在記憶體的任務數。 */
  unsealed: number;
  /** 這次讀不到內容的任務數（金鑰被拒、權限不符或檔案損壞）；這些任務只顯示外殼，加密檔原封不動。 */
  unreadable: number;
}

/**
 * 任務與成果的本機儲存。每次變更都寫入 JSON 檔，重啟後可喚回。
 * dataDir 為 null 時只存在記憶體（測試用）。
 *
 * MEM-4a（sealing）：tasks.json 只放受保護外殼（protected: true；標題、步驟標題、錯誤換成固定句），沒有 artifacts.json；
 * 真正的任務與成果放在 data/sealed/ 的加密檔（SealedVault）。核心記憶體裡仍有完整內容（執行器與可信主視窗要用），
 * 但對外的頻道（SSE、/api/tasks、/api/history、模型提示）一律走 public* 方法，只拿到外殼。
 * 加密檔只在建立、規劃完成、狀態改變、成果產生與撤銷時寫；步驟進度只改外殼。
 */
export class TaskStore {
  private tasks = new Map<string, Task>();
  private artifacts = new Map<string, Artifact>();
  private listeners = new Set<Listener>();
  private deleteListeners = new Set<DeleteListener>();
  private mode: VaultStatus["mode"] = "plain";
  private vault: SealedVault | null = null;
  private failure: VaultFailure | null = null;
  private migration: MigrationResult | null = null;
  private readonly unsealed = new Set<string>();
  /**
   * 審查 B1：這次讀不到內容的任務（解密或讀檔失敗）。它們在記憶體裡只有外殼；絕不重新加密寫入（會把外殼的固定句永久蓋掉
   * 原句），也不刪它們的加密檔。下次能讀時就恢復。
   */
  private readonly unreadable = new Set<string>();
  private readonly log: (line: string) => void;

  constructor(private readonly dataDir: string | null, private readonly sealing?: TaskSealing) {
    this.log = sealing?.log ?? (() => {});
    if (dataDir) this.load(dataDir);
    else if (sealing) {
      this.mode = "sealed";
      this.vault = sealing.vault;
      this.failure = sealing.failure ?? (sealing.vault ? null : "unavailable");
    }
  }

  /** 是否以加密外殼對外（macOS App 的正常狀態）。 */
  get sealed(): boolean {
    return this.mode === "sealed";
  }

  vaultStatus(): VaultStatus {
    return { mode: this.mode, failure: this.failure, migration: this.migration, backups: this.dataDir && this.sealing ? plaintextBackups(this.dataDir) : [], unsealed: this.unsealed.size, unreadable: this.unreadable.size };
  }

  /** 使用者在畫面上確認後（主程序先跳原生確認）刪除明文備份。 */
  deleteBackups(): number {
    if (!this.dataDir || !this.sealing) return 0;
    const count = deletePlaintextBackups(this.dataDir);
    this.log(`tasks: 已刪除明文備份 ${count} 個資料夾`);
    return count;
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (/^(tasks|artifacts)\.json\.tmp-[0-9a-f-]+$/.test(name)) unlinkSync(join(dir, name));
    if (this.sealing) {
      this.failure = this.sealing.failure ?? (this.sealing.vault ? null : "unavailable");
      const plaintext = hasPlaintext(dir);
      if (plaintext && !this.sealing.vault) {
        // 金鑰不可用而舊資料是明文：這次照舊明文，不動原檔（下次能解開金鑰時再搬）。
        this.mode = "plain_fallback";
        this.log(`tasks: 無法加密保存（${this.failure}），這次照舊明文`);
      } else if (plaintext) {
        this.migration = migratePlaintext({ dataDir: dir, vault: this.sealing.vault!, now: this.sealing.now, checkpoint: this.sealing.migrationCheckpoint, writeShells: (tasks) => writeJsonAtomic(join(dir, "tasks.json"), tasks.map(shellOf)) });
        if (this.migration.ok) {
          this.mode = "sealed";
          this.log(`tasks: 明文已加密搬遷（任務 ${this.migration.tasks}、成果 ${this.migration.artifacts}），備份保留到使用者確認刪除`);
        } else {
          this.mode = "plain_fallback";
          this.log(`tasks: 明文加密搬遷失敗（步驟 ${this.migration.step}），明文原檔沒有改動，這次照舊明文`);
        }
      } else {
        this.mode = "sealed";
      }
      this.vault = this.mode === "sealed" ? this.sealing.vault : null;
    }
    if (this.mode === "sealed") this.loadSealed(dir);
    else this.loadPlain(dir);
  }

  private loadPlain(dir: string): void {
    const tasks = readJson<Task[]>(join(dir, "tasks.json")) ?? [];
    const artifacts = readJson<Artifact[]>(join(dir, "artifacts.json")) ?? [];
    const taskIds = new Set(tasks.map((t) => t.task_id));
    let orphans = 0;
    for (const a of artifacts) {
      // 刪除時先寫 artifacts.json 再寫 tasks.json；萬一中間中斷，留下的只會是沒有成果的任務，不會是沒有任務的成果。
      // 保險起見，載入時仍丟掉找不到任務的成果。
      if (!taskIds.has(a.task_id)) { orphans += 1; continue; }
      this.artifacts.set(a.artifact_id, a);
    }
    for (const t of tasks) this.tasks.set(t.task_id, t);
    this.normalize();
    this.persistTasks();
    if (orphans > 0) this.persistArtifacts();
  }

  /**
   * 加密模式的載入：外殼（tasks.json）決定有哪些任務與它們的狀態，加密檔補上內容。
   * 找不到任何外殼的加密檔是孤兒（例如刪除或撤銷中途中斷），直接刪掉；已撤銷任務殘留的成果檔也刪掉。
   */
  private loadSealed(dir: string): void {
    const shells = readJson<Task[]>(join(dir, "tasks.json")) ?? [];
    const keep = new Set<string>();
    let unreadable = 0;
    // 金鑰被拒或權限不符：這次整個不清孤兒（讀不到不代表是孤兒），並照實記下原因。
    let skipCleanup = !this.vault;
    const failed = (error: unknown) => {
      unreadable += 1;
      const code = error instanceof VaultError ? error.code : "unavailable";
      if (code === "key_unavailable" || code === "permissions" || code === "unavailable") {
        skipCleanup = true;
        this.failure ??= code;
      }
    };
    for (const shell of shells) {
      keep.add(shell.task_id);
      if (shell.artifact_id) keep.add(shell.artifact_id);
      let real: Task | null = null;
      let readable = !!this.vault;
      try { real = this.vault?.read<Task>(shell.task_id) ?? null; } catch (error) { failed(error); readable = false; }
      const task = real ? merge(real, shell) : { ...shell };
      if (!real) this.unreadable.add(task.task_id);
      if (!real && readable) this.unsealed.add(task.task_id);
      this.tasks.set(task.task_id, task);
      if (task.artifact_id && !task.withdrawn) {
        try {
          const artifact = this.vault?.read<Artifact>(task.artifact_id) ?? null;
          if (artifact && artifact.task_id === task.task_id) this.artifacts.set(artifact.artifact_id, artifact);
        } catch (error) { failed(error); }
      } else if (task.artifact_id && task.withdrawn) keep.delete(task.artifact_id);
    }
    let orphans = 0;
    if (this.vault && !skipCleanup) {
      for (const id of this.vault.ids()) {
        if (keep.has(id)) continue;
        try { this.vault.remove(id); orphans += 1; } catch { /* 下次再清 */ }
      }
    }
    if (orphans || unreadable) this.log(`tasks: 載入加密任務（孤兒清除 ${orphans}，無法解開 ${unreadable}${skipCleanup && this.vault ? "，這次不清孤兒" : ""}）`);
    const interrupted = this.normalize();
    // 讀不到內容的任務只改外殼（seal 會略過它們）。
    for (const id of interrupted) this.seal(this.tasks.get(id)!);
    this.persistTasks();
    // 審查 M4a：上次執行時記憶已關閉，帶記憶的成果一律撤回（刪成果檔、留外殼與重做）。
    if (this.sealing?.memoryEnabled && this.sealing.memoryEnabled() === false) {
      const pending = [...this.tasks.values()].filter(t => t.memory === true && !t.withdrawn).map(t => t.task_id);
      for (const id of pending) this.withdraw(id);
      if (pending.length) this.log(`tasks: 記憶已關閉，撤回帶記憶的成果 ${pending.length} 筆`);
    }
  }

  /** 上次未完成的任務不可能還在跑：誠實標為失敗，而不是假裝仍在進行。回傳被標為失敗的任務。 */
  private normalize(): string[] {
    const now = new Date().toISOString();
    const interrupted: string[] = [];
    for (const t of this.tasks.values()) {
      if (normalizeLocale(t.locale) !== "en") delete t.locale;
      for (const step of t.steps) if (!isDomain(step.domain)) delete step.domain;
      if (t.status === "queued" || t.status === "running" || t.status === "cancelling") {
        t.status = "failed";
        t.error = localize(INTERRUPTED, t.locale);
        t.finished_at = now;
        t.updated_at = now;
        for (const s of t.steps) if (s.status === "running") s.status = "failed";
        interrupted.push(t.task_id);
      }
    }
    return interrupted;
  }

  private persistTasks(): void {
    if (!this.dataDir) return;
    const tasks = [...this.tasks.values()];
    writeJsonAtomic(join(this.dataDir, "tasks.json"), this.mode === "sealed" ? tasks.map(shellOf) : tasks);
  }

  private persistArtifacts(): void {
    // 加密模式沒有 artifacts.json：成果只在加密檔。
    if (this.dataDir && this.mode !== "sealed") writeJsonAtomic(join(this.dataDir, "artifacts.json"), [...this.artifacts.values()]);
  }

  /** 加密寫入一筆；失敗時內容只留在記憶體（照實記數，不假裝已保存）。 */
  private seal(value: Task | Artifact): void {
    if (this.mode !== "sealed" || !this.dataDir) return;
    const isArtifact = "artifact_id" in value && "content" in value;
    const id = isArtifact ? (value as Artifact).artifact_id : value.task_id;
    const owner = value.task_id;
    // 審查 B1：讀不到原內容的任務絕不重新寫入（只會寫進外殼的固定句，永久蓋掉原句與成果）。
    if (this.unreadable.has(owner)) return;
    if (!this.vault) { this.unsealed.add(owner); return; }
    try {
      this.vault.write(id, value);
      if (!isArtifact) this.unsealed.delete(owner);
    } catch (error) {
      if (!this.unsealed.has(owner)) this.log(`tasks: 加密保存失敗（${(error as { code?: string }).code ?? "error"}），內容只留在記憶體`);
      this.unsealed.add(owner);
    }
  }

  private shred(id: string): void {
    if (this.mode !== "sealed" || !this.vault) return;
    try { this.vault.remove(id); } catch { this.log("tasks: 加密檔刪除失敗，下次啟動時再清"); }
  }

  /** 訂閱任務變化；加密模式下收到的是外殼。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDeleted(listener: DeleteListener): () => void {
    this.deleteListeners.add(listener);
    return () => this.deleteListeners.delete(listener);
  }

  /** 成果紀錄搜尋用（HIST-1）：每個任務與它的成果（快照）。完整內容，只給核心與可信主視窗。 */
  documents(): { task: Task; artifact: Artifact | null }[] {
    return [...this.tasks.values()].map((t) => {
      const artifact = t.artifact_id ? this.artifacts.get(t.artifact_id) : undefined;
      return { task: clone(t), artifact: artifact ? clone(artifact) : null };
    });
  }

  /** 對外（/api/history）的搜尋來源：加密模式下只有外殼、沒有成果內容。 */
  publicDocuments(): { task: Task; artifact: Artifact | null }[] {
    if (this.mode !== "sealed") return this.documents();
    return [...this.tasks.values()].map((t) => ({ task: shellOf(t), artifact: null }));
  }

  /**
   * 刪除任務與它的成果（成果紀錄裡經使用者明確確認後）。執行中（排隊、執行、停止中）的任務不能刪：
   * 回 "active"，要先停止。不存在回 "not_found"。兩個檔都改寫後才通知訂閱者。
   */
  delete(taskId: string): { ok: true; task_id: string; artifact_id: string | null } | { ok: false; reason: "not_found" | "active" } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, reason: "not_found" };
    if (task.status === "queued" || task.status === "running" || task.status === "cancelling") return { ok: false, reason: "active" };
    const artifactId = task.artifact_id;
    this.tasks.delete(taskId);
    this.unsealed.delete(taskId);
    this.unreadable.delete(taskId);
    // 同一個任務的成果（正常只有 artifact_id 那一份；保險起見依 task_id 一併清掉）。
    const shredIds = new Set<string>(artifactId ? [artifactId] : []);
    for (const [id, a] of this.artifacts) if (id === artifactId || a.task_id === taskId) { this.artifacts.delete(id); shredIds.add(id); }
    for (const id of shredIds) forgetHistoryArtifact(id);
    // 明文模式：先移除成果內容，再移除任務（見 load 的說明）。
    this.persistArtifacts();
    // 加密模式（審查 minor 2）：先寫外殼，再刪加密檔；中途中斷時留下的加密檔在下次載入時當孤兒清掉。
    this.persistTasks();
    for (const id of shredIds) this.shred(id);
    this.shred(taskId);
    const deleted = { task_id: taskId, artifact_id: artifactId };
    for (const l of this.deleteListeners) l(deleted);
    return { ok: true, ...deleted };
  }

  /**
   * MEM-4a 撤銷傳播：用到的記憶被忘記、更正、撤回同意、刪除人物或關閉記憶。成果內容（與受記憶影響的步驟標題）移除，
   * 成果加密檔刪掉（刪檔）；任務留外殼、使用者原句與重做。執行中的任務不在這裡處理（TaskRunner 先取消）。
   */
  withdraw(taskId: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.withdrawn) return clone(task);
    if (task.status === "queued" || task.status === "running" || task.status === "cancelling") return null;
    const shredIds = new Set<string>(task.artifact_id ? [task.artifact_id] : []);
    for (const [id, a] of this.artifacts) if (id === task.artifact_id || a.task_id === taskId) { this.artifacts.delete(id); shredIds.add(id); }
    // HIST-1 的搜尋快取（記憶體裡折疊過的成果純文字）一起丟掉。
    for (const id of shredIds) forgetHistoryArtifact(id);
    if (shredIds.size) this.persistArtifacts();
    // 先寫外殼（withdrawn），再刪成果檔（審查 minor 2）：中途中斷時，下次載入把殘留的成果檔當孤兒刪掉。
    const updated = this.update(taskId, (t) => {
      t.withdrawn = true;
      t.artifact_id = null;
      for (const s of t.steps) s.title = localize(PROTECTED_STEP, t.locale);
    });
    for (const id of shredIds) this.shred(id);
    return updated;
  }

  /** 審查 B1／M2：這次讀不到內容的任務（只有外殼）；不能重做、不能送給模型。 */
  contentMissing(taskId: string): boolean {
    return this.unreadable.has(taskId);
  }

  /** 完整內容（核心內部與可信主視窗）。 */
  list(): Task[] {
    return [...this.tasks.values()].map(clone);
  }

  get(taskId: string): Task | undefined {
    const t = this.tasks.get(taskId);
    return t ? clone(t) : undefined;
  }

  getArtifact(artifactId: string): Artifact | undefined {
    const a = this.artifacts.get(artifactId);
    return a ? clone(a) : undefined;
  }

  /** 對外（SSE、/api/tasks、模型提示）：加密模式下是外殼。 */
  publicList(): Task[] {
    return this.mode === "sealed" ? [...this.tasks.values()].map(shellOf) : this.list();
  }

  publicGet(taskId: string): Task | undefined {
    const t = this.tasks.get(taskId);
    return t ? (this.mode === "sealed" ? shellOf(t) : clone(t)) : undefined;
  }

  /** 對外的成果：加密模式下一律沒有（/api/artifacts 回 404，內容只經 IPC）。 */
  publicArtifact(artifactId: string): Artifact | undefined {
    return this.mode === "sealed" ? undefined : this.getArtifact(artifactId);
  }

  create(input: { title: string; request_id: string; mode: ExecutorMode; retry_of?: string; locale?: Locale; task_id?: string; memory?: boolean; origin?: "user_sentence" }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      schema_version: SCHEMA_VERSION,
      task_id: input.task_id ?? `task_${randomUUID()}`,
      request_id: input.request_id,
      title: input.title,
      ...(normalizeLocale(input.locale) === "en" ? { locale: "en" as const } : {}),
      status: "queued",
      mode: input.mode,
      model: null,
      plan_ready: false,
      steps: [],
      created_at: now,
      updated_at: now,
      finished_at: null,
      error: null,
      artifact_id: null,
      retry_of: input.retry_of ?? null,
      ...(input.memory ? { memory: true } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    };
    if (this.tasks.has(task.task_id)) throw new Error("duplicate task id");
    this.tasks.set(task.task_id, task);
    this.seal(task);
    this.commit(task);
    return clone(task);
  }

  /** 以 mutator 修改任務並通知訂閱者；回傳修改後的快照。 */
  update(taskId: string, mutate: (task: Task) => void): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const before = sealKey(task);
    mutate(task);
    task.updated_at = new Date().toISOString();
    // 加密檔只在狀態、規劃、錯誤、成果或撤銷改變時寫；步驟進度只改外殼。
    if (sealKey(task) !== before) this.seal(task);
    this.commit(task);
    return clone(task);
  }

  addArtifact(input: Omit<Artifact, "schema_version" | "artifact_id" | "version" | "created_at">): Artifact {
    const artifact: Artifact = {
      schema_version: SCHEMA_VERSION,
      artifact_id: `artifact_${randomUUID()}`,
      version: 1,
      created_at: new Date().toISOString(),
      ...input,
    };
    this.artifacts.set(artifact.artifact_id, artifact);
    this.seal(artifact);
    this.persistArtifacts();
    return clone(artifact);
  }

  private commit(task: Task): void {
    this.persistTasks();
    const snapshot = this.mode === "sealed" ? shellOf(task) : clone(task);
    for (const l of this.listeners) l(snapshot);
  }
}

function sealKey(t: Task): string {
  return JSON.stringify([t.status, t.plan_ready, t.steps.length, t.error, t.artifact_id, t.withdrawn ?? false, t.cancel_reason ?? null, t.model]);
}

/** 加密檔的內容加上外殼的狀態（外殼在每次更新都寫，比加密檔新）。 */
function merge(real: Task, shell: Task): Task {
  // 撤回過的任務：受記憶影響的步驟標題不從加密檔拿回來（加密檔可能是撤回前寫的）。
  const steps = shell.steps.map((s, i) => ({ ...s, title: shell.withdrawn ? s.title : real.steps[i]?.title ?? s.title }));
  const { protected: _shell, ...rest } = real;
  return {
    ...rest,
    status: shell.status,
    plan_ready: shell.plan_ready,
    steps,
    updated_at: shell.updated_at,
    finished_at: shell.finished_at,
    artifact_id: shell.artifact_id,
    model: shell.model,
    error: shell.error === null ? null : real.error ?? shell.error,
    ...(shell.error_action !== undefined ? { error_action: shell.error_action } : {}),
    ...(shell.withdrawn ? { withdrawn: true } : {}),
    ...(shell.cancel_reason ? { cancel_reason: shell.cancel_reason } : {}),
  };
}

/**
 * 給模型的任務清單（MEM-4a，George 2026-10-30）：加密模式下，目標有記憶同意時，可以給的任務放真實標題，
 * 其他任務（含讀不到內容的）一律外殼；沒有同意或沒有記憶層時全部外殼。瀏覽器版照舊。
 * 用在對話提示、即時語音指示與 get_tasks（App 的頁面經 IPC voice_tasks 取得）。
 */
export function tasksForTarget<T>(store: TaskStore, memory: { taskTitleFilter?(target: T | null): ((task: Pick<Task, "task_id" | "memory">) => boolean) | null } | null, target: T | null): Task[] {
  if (!store.sealed) return store.publicList();
  const allow = memory?.taskTitleFilter?.(target) ?? null;
  if (!allow) return store.publicList();
  return store.list().map((t) => (allow(t) && !store.contentMissing(t.task_id) ? t : shellOf(t)));
}

/** 受保護外殼：標題、步驟標題與錯誤換成固定句；狀態、時間、步驟數與腦區（domain）照舊，電子腦動畫仍由真實事件驅動。 */
export function shellOf(task: Task): Task {
  const t = clone(task);
  return {
    ...t,
    title: localize(PROTECTED_TITLE, t.locale),
    steps: t.steps.map((s) => ({ ...s, title: localize(PROTECTED_STEP, t.locale) })),
    error: t.error === null ? null : localize(PROTECTED_ERROR, t.locale),
    protected: true,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 0600、唯一的暫存檔名、fsync 檔案與資料夾後才 rename（MEM-4a 補強；格式不變）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* 已不存在 */ }
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
  const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
