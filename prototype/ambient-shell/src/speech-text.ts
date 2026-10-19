import { computeProgress, isActive, sortForProgress, summarize } from "../shared/progress.ts";
import type { Task } from "../shared/types.ts";

// 語音模式要念出的短句。全部由真實任務狀態計算，不念長報告全文（docs/06 §3.1）。

const MAX_TITLE_CHARS = 18;

export function shortTitle(title: string): string {
  const t = title.trim();
  return t.length > MAX_TITLE_CHARS ? `${t.slice(0, MAX_TITLE_CHARS)}…` : t;
}

export function speakSubmitted(task: Task): string {
  return `好，已交辦：${shortTitle(task.title)}。${task.mode === "mock" ? "目前是模擬模式。" : ""}`;
}

/** 進度摘要：先講總數，再講最需要注意的一個任務。 */
export function speakProgress(tasks: Iterable<Task>): string {
  const sorted = sortForProgress(tasks);
  if (sorted.length === 0) return "目前沒有交辦的任務。";
  const s = summarize(sorted);
  const counts = [
    s.active && `${s.active} 個進行中`,
    s.succeeded && `${s.succeeded} 個已完成`,
    s.failed && `${s.failed} 個失敗`,
    s.cancelled && `${s.cancelled} 個已停止`,
  ].filter(Boolean);
  const head = `目前有 ${counts.join("、")}。`;
  const first = sorted[0];
  if (!isActive(first)) return head;
  return `${head}${shortTitle(first.title)}：${speakTaskProgress(first)}`;
}

export function speakTaskProgress(task: Task): string {
  if (task.status === "queued") return "排隊中，還沒開始。";
  if (task.status === "cancelling") return "正在停止。";
  const p = computeProgress(task);
  if (p.total === null) return "正在規劃步驟。";
  if (p.current) return `第 ${p.current.index} 步，共 ${p.total} 步，正在${p.current.step.title}。`;
  return `完成 ${p.done} 步，共 ${p.total} 步。`;
}

export function speakFinished(task: Task): string {
  if (task.status === "succeeded") return `${shortTitle(task.title)}完成了，成果在畫面上。`;
  if (task.status === "failed") return `${shortTitle(task.title)}失敗了：${task.error ?? "原因不明"}`;
  return `${shortTitle(task.title)}已停止。`;
}
