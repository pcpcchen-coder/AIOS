import { localize } from "./localization.ts";
import { type Locale } from "../shared/i18n.mjs";
import { isDomain, type Domain } from "../shared/domain.ts";
import type { ErrorAction, ExecutorMode, Task, TaskStep } from "../shared/types.ts";
import type { TaskStore } from "./store.ts";
import type { ContextFact } from "./memory/retrieve.ts";

/** 執行器透過 Reporter 回報真實進度；UI 上的步驟與百分比只來自這些呼叫。 */
export interface Reporter {
  /** 規劃完成，步驟總數從此確定；每步帶有腦區領域（可為 null）。 */
  planReady(steps: { title: string; domain: Domain | null }[], model: string | null): void;
  /** index 為規劃出的步驟序號（0-based，不含「規劃步驟」本身）。 */
  stepStarted(index: number): void;
  /** 真實收到的輸出字元數；沒有串流資料就不要呼叫。 */
  stepProgress(index: number, outputChars: number): void;
  stepDone(index: number): void;
}

export interface ExecutionResult {
  content: string;
  assumptions: string[];
  capability_gaps: string[];
  status: "complete" | "partial";
  model: string | null;
}

export interface Executor {
  /** 新任務會記錄並使用的引擎。 */
  readonly mode: ExecutorMode;
  /**
   * mode 為任務建立時記錄的引擎；可切換引擎的執行器依此分派。
   * facts（MEM-4a）：受保護交辦檢索到的記憶（最多 8 筆、4 KB）；執行器把它放進系統指示的只讀資料區塊（memoryBlock）。
   * 模擬引擎不帶記憶。
   */
  run(input: { title: string; mode: ExecutorMode; locale?: Locale; facts?: readonly ContextFact[] }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult>;
}

/** 帶有可直接顯示給使用者之說明的錯誤；action 為畫面可提供的下一步。 */
export class ExecutionError extends Error {
  constructor(
    readonly userMessage: string,
    options?: { cause?: unknown; action?: ErrorAction },
  ) {
    super(userMessage, options);
    this.name = "ExecutionError";
    this.action = options?.action ?? null;
  }
  readonly action: ErrorAction | null;
}

export const PLANNING_STEP_TITLE = "規劃步驟";

/**
 * 預設同時執行的任務數。對話中每次交辦都會建立任務，真實引擎一個任務要跑數分鐘；
 * 上限太低時，第三次交辦起就只會停在「排隊中」，看起來像不再處理工作。
 */
export const DEFAULT_MAX_CONCURRENT = 4;

export class TaskRunner {
  private controllers = new Map<string, AbortController>();
  private queue: string[] = [];
  private running = 0;
  private inflight = new Set<Promise<void>>();
  /** MEM-4a：受保護交辦的記憶（只在記憶體，任務結束就丟）。 */
  private readonly facts = new Map<string, readonly ContextFact[]>();
  /** MEM-4a（審查 minor 4）：受保護交辦檢索記憶時的同意對象；執行前要和任務引擎現在的帳號一致才帶記憶。 */
  private readonly targets = new Map<string, { provider: string; account: string }>();
  private targetCheck: ((target: { provider: string; account: string }) => boolean) | null = null;
  /** MEM-4a：被撤銷而停止的任務（執行器晚到的輸出一律丟掉）。 */
  private readonly revoked = new Set<string>();

  constructor(
    private readonly store: TaskStore,
    private readonly executor: Executor,
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT,
  ) {}

  get mode(): ExecutorMode {
    return this.executor.mode;
  }

  submit(input: { title: string; request_id: string; retry_of?: string; locale?: Locale; origin?: "user_sentence" }): Task {
    const task = this.store.create({ ...input, mode: this.executor.mode });
    this.queue.push(task.task_id);
    this.pump();
    return this.store.get(task.task_id)!;
  }

  /**
   * MEM-4a 受保護交辦：task_id 由記憶層先決定（依賴索引在建立前已寫入記憶快照），標題一律是使用者原句。
   * facts 只留在記憶體交給執行器；模擬引擎不帶記憶。
   */
  /** 執行前核對同意對象（App：ProviderManager 目前設定的帳號裡有這個服務＋帳號）。 */
  setTargetCheck(check: (target: { provider: string; account: string }) => boolean): void {
    this.targetCheck = check;
  }

  submitProtected(input: { task_id: string; title: string; request_id: string; retry_of?: string; locale?: Locale; facts: readonly ContextFact[]; target?: { provider: string; account: string } | null }): Task {
    const mode = this.executor.mode;
    const facts = mode === "mock" ? [] : input.facts;
    const task = this.store.create({ task_id: input.task_id, title: input.title, request_id: input.request_id, mode, ...(input.retry_of ? { retry_of: input.retry_of } : {}), ...(input.locale ? { locale: input.locale } : {}), memory: facts.length > 0, origin: "user_sentence" });
    if (facts.length) this.facts.set(task.task_id, facts);
    if (facts.length && input.target) this.targets.set(task.task_id, input.target);
    this.queue.push(task.task_id);
    this.pump();
    return this.store.get(task.task_id)!;
  }

  /**
   * MEM-4a 撤銷傳播：這些任務用到的記憶被撤銷。排隊或執行中的任務停止（cancel_reason memory_revoked，不產生成果，
   * 晚到的輸出丟掉）；已結束的任務移除成果內容（TaskStore.withdraw）。換人或閒置不會走到這裡。
   */
  revokeMemory(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      const task = this.store.get(taskId);
      if (!task) continue;
      this.facts.delete(taskId);
      if (task.status === "queued") {
        this.queue = this.queue.filter((id) => id !== taskId);
        this.revoked.add(taskId);
        this.finishCancelled(taskId);
      } else if (task.status === "running" || task.status === "cancelling") {
        this.revoked.add(taskId);
        this.store.update(taskId, (t) => {
          t.status = "cancelling";
          t.cancel_reason = "memory_revoked";
        });
        this.controllers.get(taskId)?.abort();
      } else {
        this.store.withdraw(taskId);
      }
    }
  }

  /** 重試失敗或已停止的任務；redo（成果紀錄的「重做」）也接受已完成的任務。都建立新任務並記下 retry_of。 */
  retry(taskId: string, requestId: string, options: { redo?: boolean } = {}): Task | null {
    const original = this.store.get(taskId);
    const allowed = original && (original.status === "failed" || original.status === "cancelled" || (options.redo === true && original.status === "succeeded"));
    // 審查 M2：這次讀不到內容的加密任務只有外殼的固定句，不能拿它當標題重做。
    if (!original || !allowed || this.store.contentMissing(taskId)) return null;
    return this.submit({ title: original.title, request_id: requestId, retry_of: taskId, ...(original.locale === "en" ? { locale: "en" as const } : {}), ...(original.origin ? { origin: original.origin } : {}) });
  }

  /** 「停止任務」：排隊中直接取消；執行中先標為 cancelling 再中止請求。 */
  cancel(taskId: string): Task | null {
    const task = this.store.get(taskId);
    if (!task) return null;
    if (task.status === "queued") {
      this.queue = this.queue.filter((id) => id !== taskId);
      return this.store.update(taskId, (t) => {
        t.status = "cancelled";
        t.finished_at = new Date().toISOString();
      });
    }
    if (task.status === "running") {
      const updated = this.store.update(taskId, (t) => {
        t.status = "cancelling";
      });
      this.controllers.get(taskId)?.abort();
      return updated;
    }
    return task;
  }

  /** 等待所有執行中的任務結束（測試用）。 */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.running += 1;
      const p = this.execute(taskId).finally(() => {
        this.running -= 1;
        this.inflight.delete(p);
        this.pump();
      });
      this.inflight.add(p);
    }
  }

  private async execute(taskId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const now = () => new Date().toISOString();
    const planning: TaskStep = {
      title: localize(PLANNING_STEP_TITLE, this.store.get(taskId)?.locale),
      status: "running",
      started_at: now(),
      finished_at: null,
      output_chars: null,
      // 規劃階段表示任務拆解，不猜測執行步驟的領域。
      domain: "planning",
    };
    const task = this.store.update(taskId, (t) => {
      t.status = "running";
      t.steps = [planning];
    });

    const stepAt = (t: Task, index: number): TaskStep => {
      if (!t.plan_ready) throw new Error("reporter: step reported before planReady");
      const step = t.steps[index + 1];
      if (!step) throw new Error(`reporter: step ${index} out of range`);
      return step;
    };

    const reporter: Reporter = {
      planReady: (planned, model) => {
        if (this.revoked.has(taskId)) return; // 撤銷後晚到的進度與輸出一律丟掉
        if (planned.length === 0) throw new Error("reporter: empty plan");
        this.store.update(taskId, (t) => {
          t.steps[0].status = "done";
          t.steps[0].finished_at = now();
          t.steps.push(
            ...planned.map<TaskStep>((p) => ({
              title: p.title,
              status: "pending",
              started_at: null,
              finished_at: null,
              output_chars: null,
              domain: isDomain(p.domain) ? p.domain : null,
            })),
          );
          t.plan_ready = true;
          t.model = model;
        });
      },
      stepStarted: (index) => {
        if (this.revoked.has(taskId)) return; // 撤銷後晚到的進度與輸出一律丟掉
        this.store.update(taskId, (t) => {
          const step = stepAt(t, index);
          step.status = "running";
          step.started_at = now();
        });
      },
      stepProgress: (index, outputChars) => {
        if (this.revoked.has(taskId)) return; // 撤銷後晚到的進度與輸出一律丟掉
        this.store.update(taskId, (t) => {
          stepAt(t, index).output_chars = outputChars;
        });
      },
      stepDone: (index) => {
        if (this.revoked.has(taskId)) return; // 撤銷後晚到的進度與輸出一律丟掉
        this.store.update(taskId, (t) => {
          const step = stepAt(t, index);
          step.status = "done";
          step.finished_at = now();
        });
      },
    };

    try {
      let facts = this.facts.get(taskId);
      const target = this.targets.get(taskId);
      // 排隊期間換了帳號（例如換 API key、ChatGPT 換人登入）：同意是給原帳號的，這次不帶記憶。
      if (facts?.length && target && this.targetCheck && !this.targetCheck(target)) facts = undefined;
      const result = await this.executor.run({ title: task.title, mode: task.mode, ...(task.locale === "en" ? { locale: "en" as const } : {}), ...(facts?.length ? { facts } : {}) }, reporter, controller.signal);
      if (controller.signal.aborted || this.revoked.has(taskId)) {
        this.finishCancelled(taskId);
        return;
      }
      const latest = this.store.get(taskId)!;
      const artifact = this.store.addArtifact({
        task_id: taskId,
        title: latest.title,
        content: result.content,
        mode: task.mode,
        model: result.model,
        assumptions: result.assumptions,
        capability_gaps: result.capability_gaps,
        status: result.status,
      });
      this.store.update(taskId, (t) => {
        t.status = "succeeded";
        t.finished_at = now();
        t.artifact_id = artifact.artifact_id;
        t.model = result.model ?? t.model;
      });
    } catch (err) {
      if (controller.signal.aborted || this.revoked.has(taskId)) {
        this.finishCancelled(taskId);
        return;
      }
      const message =
        err instanceof ExecutionError ? err.userMessage : `執行失敗：${(err as Error).message}`;
      this.store.update(taskId, (t) => {
        t.status = "failed";
        t.error = localize(message, task.locale);
        t.error_action = err instanceof ExecutionError ? err.action : null;
        t.finished_at = now();
        for (const s of t.steps) if (s.status === "running") s.status = "failed";
      });
    } finally {
      this.controllers.delete(taskId);
      this.facts.delete(taskId);
      this.targets.delete(taskId);
    }
  }

  private finishCancelled(taskId: string): void {
    const revoked = this.revoked.delete(taskId);
    this.store.update(taskId, (t) => {
      t.status = "cancelled";
      t.finished_at = new Date().toISOString();
      if (revoked) t.cancel_reason = "memory_revoked";
      for (const s of t.steps) {
        if (s.status === "running" || s.status === "pending") s.status = "cancelled";
      }
    });
    // 被撤銷的任務：受記憶影響的步驟標題也一併移除（只留外殼、原句與重做）。
    if (revoked) this.store.withdraw(taskId);
  }
}
