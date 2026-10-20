import { isDomain, type Domain } from "../shared/domain.ts";
import type { ErrorAction, ExecutorMode, Task, TaskStep } from "../shared/types.ts";
import type { TaskStore } from "./store.ts";

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
  /** mode 為任務建立時記錄的引擎；可切換引擎的執行器依此分派。 */
  run(input: { title: string; mode: ExecutorMode }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult>;
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

  constructor(
    private readonly store: TaskStore,
    private readonly executor: Executor,
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT,
  ) {}

  get mode(): ExecutorMode {
    return this.executor.mode;
  }

  submit(input: { title: string; request_id: string; retry_of?: string }): Task {
    const task = this.store.create({ ...input, mode: this.executor.mode });
    this.queue.push(task.task_id);
    this.pump();
    return this.store.get(task.task_id)!;
  }

  retry(taskId: string, requestId: string): Task | null {
    const original = this.store.get(taskId);
    if (!original || (original.status !== "failed" && original.status !== "cancelled")) return null;
    return this.submit({ title: original.title, request_id: requestId, retry_of: taskId });
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
      title: PLANNING_STEP_TITLE,
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
        this.store.update(taskId, (t) => {
          const step = stepAt(t, index);
          step.status = "running";
          step.started_at = now();
        });
      },
      stepProgress: (index, outputChars) => {
        this.store.update(taskId, (t) => {
          stepAt(t, index).output_chars = outputChars;
        });
      },
      stepDone: (index) => {
        this.store.update(taskId, (t) => {
          const step = stepAt(t, index);
          step.status = "done";
          step.finished_at = now();
        });
      },
    };

    try {
      const result = await this.executor.run({ title: task.title, mode: task.mode }, reporter, controller.signal);
      if (controller.signal.aborted) {
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
      if (controller.signal.aborted) {
        this.finishCancelled(taskId);
        return;
      }
      const message =
        err instanceof ExecutionError ? err.userMessage : `執行失敗：${(err as Error).message}`;
      this.store.update(taskId, (t) => {
        t.status = "failed";
        t.error = message;
        t.error_action = err instanceof ExecutionError ? err.action : null;
        t.finished_at = now();
        for (const s of t.steps) if (s.status === "running") s.status = "failed";
      });
    } finally {
      this.controllers.delete(taskId);
    }
  }

  private finishCancelled(taskId: string): void {
    this.store.update(taskId, (t) => {
      t.status = "cancelled";
      t.finished_at = new Date().toISOString();
      for (const s of t.steps) {
        if (s.status === "running" || s.status === "pending") s.status = "cancelled";
      }
    });
  }
}
