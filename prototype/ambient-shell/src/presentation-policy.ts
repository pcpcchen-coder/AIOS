import type { Task } from "../shared/types.ts";
import type { Surface, VisibilityReason } from "./shell-state.ts";

// 確定性呈現政策：獨立於模型，在畫面渲染前檢查每個 Surface 是否有可驗證的出現理由。

export interface PolicyContext {
  /** 本次 session 內真實的使用者輸入（打字、語音、按鈕）id。 */
  userRequestIds: ReadonlySet<string>;
  tasks: ReadonlyMap<string, Task>;
  /** 目前真的在等使用者確認的外部動作 id（來自 OpenAI 的 mcp_approval_request）。 */
  pendingConfirmIds?: ReadonlySet<string>;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** 原型支援 user_request 與 action_confirmation；其他理由需要訂閱等機制，尚未實作，一律拒絕。 */
const SUPPORTED_REASONS: ReadonlySet<VisibilityReason> = new Set(["user_request", "action_confirmation"]);

export function evaluateSurface(surface: Surface | null, ctx: PolicyContext): PolicyDecision {
  if (!surface) return { allowed: true };
  if (surface.visibility_reason === "action_confirmation" || surface.kind === "confirm") {
    if (surface.kind !== "confirm" || surface.visibility_reason !== "action_confirmation") {
      return { allowed: false, reason: "確認卡與 action_confirmation 必須成對" };
    }
    return ctx.pendingConfirmIds?.has(surface.request_id)
      ? { allowed: true }
      : { allowed: false, reason: "沒有對應的待確認動作" };
  }
  // 成果紀錄（HIST-1）只能由使用者的請求打開：一律 user_request，而且要對到真實的輸入（下面檢查）。
  if (surface.kind === "history" && surface.visibility_reason !== "user_request") {
    return { allowed: false, reason: "成果紀錄只能由使用者請求打開" };
  }
  if (!SUPPORTED_REASONS.has(surface.visibility_reason)) {
    return { allowed: false, reason: `visibility_reason "${surface.visibility_reason}" 尚未支援` };
  }
  if (!ctx.userRequestIds.has(surface.request_id)) {
    return { allowed: false, reason: "找不到對應的使用者請求" };
  }
  if (surface.kind === "artifact") {
    const task = surface.task_id ? ctx.tasks.get(surface.task_id) : undefined;
    if (!task) return { allowed: false, reason: "成果所屬的任務不存在" };
    if (task.status !== "succeeded") return { allowed: false, reason: "任務尚未成功完成" };
    if (!surface.artifact_id || task.artifact_id !== surface.artifact_id) {
      return { allowed: false, reason: "成果不屬於該任務" };
    }
  }
  if (surface.kind === "error") {
    const task = surface.task_id ? ctx.tasks.get(surface.task_id) : undefined;
    if (!task || task.status !== "failed") return { allowed: false, reason: "任務並未失敗" };
  }
  return { allowed: true };
}
