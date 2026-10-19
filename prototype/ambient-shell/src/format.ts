import type { StepStatus, TaskStatus } from "../shared/types.ts";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "排隊中",
  running: "進行中",
  succeeded: "已完成",
  failed: "失敗",
  cancelling: "停止中",
  cancelled: "已停止",
};

export const STEP_ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "●",
  done: "✓",
  failed: "✕",
  cancelled: "–",
};

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小時 ${m} 分`;
  if (m > 0) return `${m} 分 ${String(s).padStart(2, "0")} 秒`;
  return `${s} 秒`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("zh-TW");
}
