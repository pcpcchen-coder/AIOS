import type { Task } from "../shared/types.ts";
import type { Surface, VisibilityReason } from "./shell-state.ts";

// 確定性呈現政策：獨立於模型，在畫面渲染前檢查每個 Surface 是否有可驗證的出現理由。

export interface PolicyContext {
  /** 本次 session 內真實的使用者輸入（打字、語音、按鈕）id。 */
  userRequestIds: ReadonlySet<string>;
  tasks: ReadonlyMap<string, Task>;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** 原型目前只會產生 user_request；其他理由需要訂閱、確認等機制，尚未實作，一律拒絕。 */
const SUPPORTED_REASONS: ReadonlySet<VisibilityReason> = new Set(["user_request"]);

export function evaluateSurface(surface: Surface | null, ctx: PolicyContext): PolicyDecision {
  if (!surface) return { allowed: true };
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
