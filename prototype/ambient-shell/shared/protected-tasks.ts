// MEM-4a：加密保存的任務只經 macOS App 的 IPC（desktop/tasks-ipc.mjs → server/nous.ts）給可信主視窗；
// SSE、/api/tasks、/api/history 與模型只看到外殼。這裡是 IPC 的 op 與回應形狀（前後端共用）。

import type { Artifact, Task } from "./types.ts";
import type { HistoryPage, HistoryQuery } from "./history.ts";

export const TASK_OPS = ["status", "list", "get", "search", "redo", "delete_backups", "voice_tasks", "card_title", "card_delegate"] as const;
export type TaskOp = (typeof TASK_OPS)[number];

export type MigrationView = { ok: true; tasks: number; artifacts: number; backup: string } | { ok: false; step: "read" | "encrypt" | "verify" | "backup" | "switch" };

/** 加密保存的狀態（只有狀態、筆數與資料夾名稱，沒有任何內容）。 */
export interface VaultView {
  mode: "plain" | "sealed" | "plain_fallback";
  failure: "key_unavailable" | "locked" | "permissions" | "corrupt" | "unavailable" | null;
  migration: MigrationView | null;
  backups: string[];
  unsealed: number;
  /** 這次讀不到內容的任務數（金鑰被拒、權限不符或檔案損壞；加密檔原封不動）。 */
  unreadable: number;
}

/**
 * all：成果紀錄是從選單列「成果紀錄…」打開的（George 的 D2）：主程序在點擊後 10 秒內收到第一個 all 請求時，核心在 10 分鐘內
 * 讓帶 all 的請求也看得到其他家人的帶記憶任務；其他情況那些任務只有外殼。
 */
export type TasksRequest =
  | { op: "status" }
  | { op: "list"; all?: boolean }
  | { op: "get"; task_id: string; all?: boolean }
  | { op: "search"; query: HistoryQuery; all?: boolean }
  | { op: "redo"; task_id: string; request_id: string; all?: boolean }
  | { op: "delete_backups" }
  /** get_tasks（即時語音）：依那條路徑的記憶同意給真實標題或外殼。 */
  | { op: "voice_tasks"; route: "live" | "api_key" }
  /** MEM-4b：受保護原句卡的標題（SSE 只送卡片 ID）。 */
  | { op: "card_title"; card: string }
  /** MEM-4b：原句卡上按「交辦」（可信主視窗的點擊算直接確認；卡片一次性）。 */
  | { op: "card_delegate"; card: string; request_id: string };

export type TasksResponse =
  | { ok: true; op: "status"; vault: VaultView }
  | { ok: true; op: "list"; tasks: Task[] }
  | { ok: true; op: "get"; task: Task; artifact: Artifact | null }
  | { ok: true; op: "search"; page: HistoryPage }
  | { ok: true; op: "redo"; task: Task; memory_used: number }
  | { ok: true; op: "delete_backups"; deleted: number; vault: VaultView }
  | { ok: true; op: "voice_tasks"; tasks: Task[] }
  | { ok: true; op: "card_title"; title: string }
  /** memory：unavailable＝這次不能受保護交辦，照舊建立了不帶記憶的任務（頁面照實告知）。 */
  | { ok: true; op: "card_delegate"; task: Task; memory_used: number; memory: "used" | "unavailable" }
  | { ok: false; code: "unavailable" | "bad_request" | "not_found" | "conflict" | "cancelled"; message: string };

export const TASK_ID = /^task_[0-9a-f-]{36}$/;
/** MEM-4b：受保護原句卡的 ID（和 server/memory/service.ts 的 DELEGATE_CARD_ID 相同）。 */
export const DELEGATE_CARD = /^dc_[0-9a-f]{24}$/;
