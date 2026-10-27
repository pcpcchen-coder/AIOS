import { t, msg } from "./i18n.ts";
import { computeProgress, isActive, queueText, sortForProgress, summarize } from "../shared/progress.ts";
import type { Task } from "../shared/types.ts";

// 語音模式要念出的短句。全部由真實任務狀態計算，不念長報告全文（docs/06 §3.1）。

const MAX_TITLE_CHARS = 18;

export function shortTitle(title: string): string {
  const t = title.trim();
  return t.length > MAX_TITLE_CHARS ? `${t.slice(0, MAX_TITLE_CHARS)}…` : t;
}

export function speakSubmitted(task: Task): string {
  return msg`好，已交辦：${shortTitle(task.title)}。${task.mode === "mock" ? t("目前是模擬模式。") : ""}`;
}

/** 進度摘要：先講總數，再講最需要注意的一個任務。 */
export function speakProgress(tasks: Iterable<Task>): string {
  const sorted = sortForProgress(tasks);
  if (sorted.length === 0) return t("目前沒有交辦的任務。");
  const s = summarize(sorted);
  const counts = [
    s.active && msg`${s.active} 個進行中`,
    s.succeeded && msg`${s.succeeded} 個已完成`,
    s.failed && msg`${s.failed} 個失敗`,
    s.cancelled && msg`${s.cancelled} 個已停止`,
  ].filter(Boolean);
  const head = msg`目前有 ${counts.join("、")}。`;
  const first = sorted[0];
  if (!isActive(first)) return head;
  return `${head}${shortTitle(first.title)}：${speakTaskProgress(first, sorted)}`;
}

export function speakTaskProgress(task: Task, tasks: Iterable<Task> = []): string {
  if (task.status === "queued") return `${t(queueText(task, tasks))}。`;
  if (task.status === "cancelling") return t("正在停止。");
  const p = computeProgress(task);
  if (p.total === null) return t("正在規劃步驟。");
  if (p.current) return msg`第 ${p.current.index} 步，共 ${p.total} 步，正在${p.current.step.title}。`;
  return msg`完成 ${p.done} 步，共 ${p.total} 步。`;
}

export function speakFinished(task: Task): string {
  if (task.status === "succeeded") return msg`${shortTitle(task.title)}完成了，成果在畫面上。`;
  if (task.status === "failed") return msg`${shortTitle(task.title)}失敗了：${task.error ?? t("原因不明")}`;
  return msg`${shortTitle(task.title)}已停止。`;
}
