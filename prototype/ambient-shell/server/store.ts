import { localize } from "./localization.ts";
import { normalizeLocale, type Locale } from "../shared/i18n.mjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, type Artifact, type ExecutorMode, type Task } from "../shared/types.ts";
import { isDomain } from "../shared/domain.ts";

type Listener = (task: Task) => void;
/** 刪除通知：被刪的任務 ID 與它的成果 ID（沒有成果時 null）。 */
type DeleteListener = (deleted: { task_id: string; artifact_id: string | null }) => void;

const INTERRUPTED = "本機核心重新啟動，任務在完成前中斷（未產生成果）。";

/**
 * 任務與成果的本機儲存。每次變更都寫入 JSON 檔，重啟後可喚回。
 * dataDir 為 null 時只存在記憶體（測試用）。
 */
export class TaskStore {
  private tasks = new Map<string, Task>();
  private artifacts = new Map<string, Artifact>();
  private listeners = new Set<Listener>();
  private deleteListeners = new Set<DeleteListener>();

  constructor(private readonly dataDir: string | null) {
    if (dataDir) this.load(dataDir);
  }

  private load(dir: string): void {
    mkdirSync(dir, { recursive: true });
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
    const now = new Date().toISOString();
    for (const t of tasks) {
      if (normalizeLocale(t.locale) !== "en") delete t.locale;
      for (const step of t.steps) if (!isDomain(step.domain)) delete step.domain;
      // 上次未完成的任務不可能還在跑：誠實標為失敗，而不是假裝仍在進行。
      if (t.status === "queued" || t.status === "running" || t.status === "cancelling") {
        t.status = "failed";
        t.error = localize(INTERRUPTED, t.locale);
        t.finished_at = now;
        t.updated_at = now;
        for (const s of t.steps) if (s.status === "running") s.status = "failed";
      }
      this.tasks.set(t.task_id, t);
    }
    this.persistTasks();
    if (orphans > 0) this.persistArtifacts();
  }

  private persistTasks(): void {
    if (this.dataDir) writeJsonAtomic(join(this.dataDir, "tasks.json"), [...this.tasks.values()]);
  }

  private persistArtifacts(): void {
    if (this.dataDir) writeJsonAtomic(join(this.dataDir, "artifacts.json"), [...this.artifacts.values()]);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDeleted(listener: DeleteListener): () => void {
    this.deleteListeners.add(listener);
    return () => this.deleteListeners.delete(listener);
  }

  /** 成果紀錄搜尋用（HIST-1）：每個任務與它的成果（快照）。 */
  documents(): { task: Task; artifact: Artifact | null }[] {
    return [...this.tasks.values()].map((t) => {
      const artifact = t.artifact_id ? this.artifacts.get(t.artifact_id) : undefined;
      return { task: clone(t), artifact: artifact ? clone(artifact) : null };
    });
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
    // 同一個任務的成果（正常只有 artifact_id 那一份；保險起見依 task_id 一併清掉）。
    for (const [id, a] of this.artifacts) if (id === artifactId || a.task_id === taskId) this.artifacts.delete(id);
    // 先移除成果內容，再移除任務（見 load 的說明）。
    this.persistArtifacts();
    this.persistTasks();
    const deleted = { task_id: taskId, artifact_id: artifactId };
    for (const l of this.deleteListeners) l(deleted);
    return { ok: true, ...deleted };
  }

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

  create(input: { title: string; request_id: string; mode: ExecutorMode; retry_of?: string; locale?: Locale }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      schema_version: SCHEMA_VERSION,
      task_id: `task_${randomUUID()}`,
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
    };
    this.tasks.set(task.task_id, task);
    this.commit(task);
    return clone(task);
  }

  /** 以 mutator 修改任務並通知訂閱者；回傳修改後的快照。 */
  update(taskId: string, mutate: (task: Task) => void): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    mutate(task);
    task.updated_at = new Date().toISOString();
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
    this.persistArtifacts();
    return clone(artifact);
  }

  private commit(task: Task): void {
    this.persistTasks();
    const snapshot = clone(task);
    for (const l of this.listeners) l(snapshot);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}
