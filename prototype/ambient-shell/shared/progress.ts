import type { Task, TaskStep, TaskStatus } from "./types.ts";

export interface Progress {
  /** 已完成步驟數。 */
  done: number;
  /** 步驟總數；規劃尚未完成時為 null（不得猜測）。 */
  total: number | null;
  /** done / total × 100，四捨五入到整數；total 未知時為 null。 */
  percent: number | null;
  /** 目前正在執行的步驟（1-based 序號與內容）。 */
  current: { index: number; step: TaskStep } | null;
}

/**
 * 進度只由真實的步驟狀態計算，不使用時間或動畫推估。
 * 計算方式：percent = round(done / total × 100)，total 為規劃後的步驟總數。
 */
export function computeProgress(task: Task): Progress {
  const done = task.steps.filter((s) => s.status === "done").length;
  const runningIndex = task.steps.findIndex((s) => s.status === "running");
  const current =
    runningIndex >= 0 ? { index: runningIndex + 1, step: task.steps[runningIndex] } : null;
  if (!task.plan_ready || task.steps.length === 0) {
    return { done, total: null, percent: null, current };
  }
  const total = task.steps.length;
  return { done, total, percent: Math.round((done / total) * 100), current };
}

export const ACTIVE_STATUSES: readonly TaskStatus[] = ["queued", "running", "cancelling"];

export function isActive(task: Task): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}

export interface TaskSummary {
  active: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export function summarize(tasks: Iterable<Task>): TaskSummary {
  const summary: TaskSummary = { active: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const task of tasks) {
    if (isActive(task)) summary.active += 1;
    else if (task.status === "succeeded") summary.succeeded += 1;
    else if (task.status === "failed") summary.failed += 1;
    else if (task.status === "cancelled") summary.cancelled += 1;
  }
  return summary;
}

/** 進度清單排序：進行中在前，其餘依建立時間新到舊。 */
export function sortForProgress(tasks: Iterable<Task>): Task[] {
  return [...tasks].sort((a, b) => {
    const activeDiff = Number(isActive(b)) - Number(isActive(a));
    if (activeDiff !== 0) return activeDiff;
    return b.created_at.localeCompare(a.created_at);
  });
}
