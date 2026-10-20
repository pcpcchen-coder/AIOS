import { DOMAINS, type Domain } from "../shared/domain.ts";
import { describe, expect, it } from "vitest";
import { ExecutionError, PLANNING_STEP_TITLE, TaskRunner, type Executor, type Reporter } from "../server/runner.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { TaskStore } from "../server/store.ts";
import type { Task } from "../shared/types.ts";

/** 由測試手動推進的執行器，用來觀察每一步的真實狀態。 */
class ControlledExecutor implements Executor {
  readonly mode = "claude" as const;
  reporter!: Reporter;
  signal!: AbortSignal;
  private release!: () => void;
  private fail!: (err: unknown) => void;
  private markStarted: () => void = () => {};
  readonly started = new Promise<void>((r) => (this.markStarted = r));

  run(_input: { title: string }, reporter: Reporter, signal: AbortSignal) {
    this.reporter = reporter;
    this.signal = signal;
    this.markStarted();
    return new Promise<{ content: string; assumptions: string[]; capability_gaps: string[]; status: "complete"; model: string }>(
      (resolve, reject) => {
        this.release = () =>
          resolve({ content: "# 完成", assumptions: ["假設 A"], capability_gaps: [], status: "complete", model: "model-x" });
        this.fail = reject;
        signal.addEventListener("abort", () => reject(signal.reason));
      },
    );
  }
  finish() {
    this.release();
  }
  error(err: unknown) {
    this.fail(err);
  }
}

function setup(executor: Executor, max = 2) {
  const store = new TaskStore(null);
  const events: Task[] = [];
  store.subscribe((t) => events.push(t));
  const runner = new TaskRunner(store, executor, max);
  return { store, runner, events };
}

describe("TaskRunner", () => {
  it("成功：步驟依真實回報推進，完成後產生成果", async () => {
    const ex = new ControlledExecutor();
    const { store, runner } = setup(ex);
    const task = runner.submit({ title: "寫週報", request_id: "req_aaaaaaaa" });
    await ex.started;

    let t = store.get(task.task_id)!;
    expect(t.status).toBe("running");
    expect(t.plan_ready).toBe(false);
    expect(t.steps.map((s) => [s.title, s.status])).toEqual([[PLANNING_STEP_TITLE, "running"]]);

    ex.reporter.planReady(
      [
        { title: "蒐集", domain: "math" },
        { title: "撰寫", domain: "language" },
      ],
      "model-x",
    );
    ex.reporter.stepStarted(0);
    ex.reporter.stepProgress(0, 120);
    t = store.get(task.task_id)!;
    expect(t.plan_ready).toBe(true);
    expect(t.steps.map((s) => s.status)).toEqual(["done", "running", "pending"]);
    expect(t.steps.map((s) => s.domain)).toEqual(["planning", "math", "language"]);
    expect(t.steps[1].output_chars).toBe(120);

    ex.reporter.stepDone(0);
    ex.reporter.stepStarted(1);
    ex.reporter.stepDone(1);
    ex.finish();
    await runner.idle();

    t = store.get(task.task_id)!;
    expect(t.status).toBe("succeeded");
    expect(t.steps.every((s) => s.status === "done")).toBe(true);
    const artifact = store.getArtifact(t.artifact_id!)!;
    expect(artifact).toMatchObject({ task_id: t.task_id, content: "# 完成", version: 1, model: "model-x" });
  });

  it("失敗：記錄真實錯誤，不產生成果、不標成功", async () => {
    const ex = new ControlledExecutor();
    const { store, runner } = setup(ex);
    const task = runner.submit({ title: "查即時股價", request_id: "req_aaaaaaaa" });
    await ex.started;
    ex.reporter.planReady([{ title: "查詢", domain: null }], null);
    ex.reporter.stepStarted(0);
    ex.error(new ExecutionError("無法連線到 Anthropic API（網路中斷或被阻擋）。"));
    await runner.idle();

    const t = store.get(task.task_id)!;
    expect(t.status).toBe("failed");
    expect(t.error).toBe("無法連線到 Anthropic API（網路中斷或被阻擋）。");
    expect(t.artifact_id).toBeNull();
    expect(t.steps[1].status).toBe("failed");
  });

  it("停止任務：中止執行器、標為已停止，未完成步驟不算完成", async () => {
    const ex = new ControlledExecutor();
    const { store, runner, events } = setup(ex);
    const task = runner.submit({ title: "長任務", request_id: "req_aaaaaaaa" });
    await ex.started;
    ex.reporter.planReady(
      [
        { title: "A", domain: null },
        { title: "B", domain: null },
      ],
      null,
    );
    ex.reporter.stepStarted(0);

    expect(runner.cancel(task.task_id)!.status).toBe("cancelling");
    expect(ex.signal.aborted).toBe(true);
    await runner.idle();

    const t = store.get(task.task_id)!;
    expect(t.status).toBe("cancelled");
    expect(t.artifact_id).toBeNull();
    expect(t.steps.map((s) => s.status)).toEqual(["done", "cancelled", "cancelled"]);
    expect(events.some((e) => e.status === "cancelling")).toBe(true);
  });

  it("超過同時上限的任務排隊；排隊中可直接取消", async () => {
    const ex = new ControlledExecutor();
    const { store, runner } = setup(ex, 1);
    const first = runner.submit({ title: "一", request_id: "req_aaaaaaaa" });
    const second = runner.submit({ title: "二", request_id: "req_bbbbbbbb" });
    await ex.started;
    expect(store.get(first.task_id)!.status).toBe("running");
    expect(store.get(second.task_id)!.status).toBe("queued");

    expect(runner.cancel(second.task_id)!.status).toBe("cancelled");
    ex.finish();
    await runner.idle();
    expect(store.get(second.task_id)!.status).toBe("cancelled");
    expect(store.get(second.task_id)!.steps).toEqual([]);
  });

  it("只能重試失敗或已停止的任務，重試會建立新任務", async () => {
    const ex = new ControlledExecutor();
    const { store, runner } = setup(ex);
    const task = runner.submit({ title: "重試我", request_id: "req_aaaaaaaa" });
    await ex.started;
    expect(runner.retry(task.task_id, "req_bbbbbbbb")).toBeNull();
    ex.error(new Error("boom"));
    await runner.idle();
    expect(store.get(task.task_id)!.error).toBe("執行失敗：boom");

    const retried = runner.retry(task.task_id, "req_bbbbbbbb")!;
    expect(retried.task_id).not.toBe(task.task_id);
    expect(retried).toMatchObject({ title: "重試我", retry_of: task.task_id, request_id: "req_bbbbbbbb" });
  });

  it("模擬執行器的成果明確寫明未實際完成", async () => {
    const { store, runner } = setup(new MockExecutor(1));
    const task = runner.submit({ title: "訂機票", request_id: "req_aaaaaaaa" });
    await runner.idle();
    const t = store.get(task.task_id)!;
    expect(t.mode).toBe("mock");
    expect(t.status).toBe("succeeded");
    const artifact = store.getArtifact(t.artifact_id!)!;
    expect(artifact.mode).toBe("mock");
    expect(artifact.status).toBe("partial");
    expect(artifact.content).toContain("沒有實際完成這件事");
  });
});


it("Runner preserves six model domains through snapshots and normalizes invalid reporter values", async () => {
  const ex = new ControlledExecutor(); const { store, runner, events } = setup(ex);
  const submitted = runner.submit({ title: "照片", request_id: "req_aaaaaaaa" }); await ex.started;
  expect(store.get(submitted.task_id)?.steps[0].domain).toBe("planning");
  ex.reporter.planReady([...DOMAINS.map((domain) => ({ title: domain, domain })), { title: "legacy", domain: "toString" as Domain }], "fixture");
  expect(events.at(-1)?.steps.map((s) => s.domain)).toEqual(["planning", ...DOMAINS, null]);
  expect(store.get(submitted.task_id)?.steps.map((s) => s.domain)).toEqual(["planning", ...DOMAINS, null]);
  ex.finish(); await runner.idle();
});
