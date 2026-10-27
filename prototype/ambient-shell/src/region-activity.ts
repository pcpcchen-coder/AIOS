import { t } from "./i18n.ts";
import { classifyDomain, DOMAIN_LABEL, isDomain, type Domain } from "../shared/domain.ts";
import type { Task } from "../shared/types.ts";
import type { ConversationReply } from "./conversation.ts";

export type RegionActivity =
  | { domain: Domain; source: "topic"; owner: string }
  | { domain: Domain; source: "task-step" | "task-planning"; owner: string; requestId: string; mock: boolean }
  | { domain: "auditory"; source: "microphone"; owner: "push" | "continuous" }
  | { domain: "language"; source: "tts"; owner: "speech" };

export interface ActivitySnapshot {
  tasks: readonly Task[];
  reply: ConversationReply;
  conversationVisible: boolean;
  capture: { push: boolean; continuous: boolean };
  playback: boolean;
}

/** Merge independent owners on read; terminal and hidden owners supply no topic focus. */
export function collectRegionActivity(input: ActivitySnapshot): RegionActivity[] {
  const activity: RegionActivity[] = [];
  for (const task of input.tasks) {
    if (task.status !== "running") continue;
    if (!task.plan_ready) {
      activity.push({ domain: "planning", source: "task-planning", owner: task.task_id, requestId: task.request_id, mock: task.mode === "mock" });
      continue;
    }
    for (const step of task.steps) {
      // Task snapshots arrive from persisted data and SSE, including legacy domain-less steps.
      if (step.status === "running" && isDomain(step.domain)) activity.push({ domain: step.domain, source: "task-step", owner: task.task_id, requestId: task.request_id, mock: task.mode === "mock" });
    }
  }
  if (input.conversationVisible && input.reply.kind === "pending") {
    const domain = classifyDomain(input.reply.user);
    if (domain) activity.push({ domain, source: "topic", owner: input.reply.requestId });
  }
  if (input.capture.push) activity.push({ domain: "auditory", source: "microphone", owner: "push" });
  if (input.capture.continuous) activity.push({ domain: "auditory", source: "microphone", owner: "continuous" });
  if (input.playback) activity.push({ domain: "language", source: "tts", owner: "speech" });
  return activity;
}

export function activityDescription(activity: RegionActivity): string {
  const source = activity.source === "topic" ? t("主題分類")
    : activity.source === "microphone" ? t("麥克風收音")
    : activity.source === "tts" ? t("語音播放")
    : activity.mock ? t("模擬任務") : activity.source === "task-planning" ? t("任務規劃") : t("任務步驟");
  return `${t(DOMAIN_LABEL[activity.domain])} · ${source}`;
}
