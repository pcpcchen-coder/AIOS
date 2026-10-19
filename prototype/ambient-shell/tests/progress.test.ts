import { describe, expect, it } from "vitest";
import { computeProgress, sortForProgress, summarize } from "../shared/progress.ts";
import { makeTask, step } from "./fixtures.ts";

describe("computeProgress", () => {
  it("規劃完成前不給百分比，也不猜總步數", () => {
    const p = computeProgress(makeTask({ steps: [step("規劃步驟", "running")] }));
    expect(p).toMatchObject({ done: 0, total: null, percent: null });
    expect(p.current?.index).toBe(1);
  });

  it("percent = round(done / total × 100)：5 步完成 2 步為 40%", () => {
    const task = makeTask({
      plan_ready: true,
      steps: [
        step("規劃步驟", "done"),
        step("蒐集", "done"),
        step("分析", "running", 320),
        step("撰寫", "pending"),
        step("彙整成果", "pending"),
      ],
    });
    const p = computeProgress(task);
    expect(p).toMatchObject({ done: 2, total: 5, percent: 40 });
    expect(p.current).toMatchObject({ index: 3, step: { title: "分析", output_chars: 320 } });
  });

  it("3 步完成 1 步四捨五入為 33%，失敗步驟不算完成", () => {
    const task = makeTask({
      plan_ready: true,
      status: "failed",
      steps: [step("規劃步驟", "done"), step("A", "failed"), step("B", "pending")],
    });
    expect(computeProgress(task)).toMatchObject({ done: 1, total: 3, percent: 33, current: null });
  });

  it("全部完成為 100%", () => {
    const task = makeTask({ plan_ready: true, steps: [step("規劃步驟", "done"), step("A", "done")] });
    expect(computeProgress(task).percent).toBe(100);
  });
});

describe("summarize / sortForProgress", () => {
  const tasks = [
    makeTask({ task_id: "a", status: "succeeded", created_at: "2026-10-19T09:00:00.000Z" }),
    makeTask({ task_id: "b", status: "running", created_at: "2026-10-19T08:00:00.000Z" }),
    makeTask({ task_id: "c", status: "failed", created_at: "2026-10-19T10:00:00.000Z" }),
    makeTask({ task_id: "d", status: "queued", created_at: "2026-10-19T07:00:00.000Z" }),
    makeTask({ task_id: "e", status: "cancelled", created_at: "2026-10-19T06:00:00.000Z" }),
  ];

  it("統計各狀態數量", () => {
    expect(summarize(tasks)).toEqual({ active: 2, succeeded: 1, failed: 1, cancelled: 1 });
  });

  it("進行中的任務排在前面，其餘新到舊", () => {
    expect(sortForProgress(tasks).map((t) => t.task_id)).toEqual(["b", "d", "c", "a", "e"]);
  });
});
