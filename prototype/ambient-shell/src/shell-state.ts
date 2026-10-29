import type { Task } from "../shared/types.ts";

// Shell 狀態描述「使用者現在看到什麼」，與任務實際狀態分開（docs/06 §5）。
// 聆聽是疊層（listening），結束後回到原本畫面，不銷毀內容。

export type ShellMode = "ambient" | "working" | "presenting" | "confirming" | "recoverable_error";

export type VisibilityReason =
  | "user_request"
  | "task_clarification"
  | "action_confirmation"
  | "subscribed_event"
  | "sensor_status"
  | "user_pinned";

/**
 * family：家人辨識（docs/14 ID-01），只由選單列「家人辨識…」打開，visibility_reason 為 user_request。
 * memory：記憶卡（首次設定、澄清、選人物、「你記得我什麼？」）與記憶管理（docs/16 MEM-1）；request_id 是觸發它的
 * 使用者輸入或選單列點擊，visibility_reason 為 user_request（不冒用外部動作的確認 ID）。
 */
export type SurfaceKind = "progress" | "artifact" | "error" | "notice" | "settings" | "conversation" | "confirm" | "family" | "memory";

export interface Surface {
  surface_id: string;
  kind: SurfaceKind;
  visibility_reason: VisibilityReason;
  /** 觸發這個 Surface 的使用者輸入。 */
  request_id: string;
  task_id: string | null;
  artifact_id: string | null;
  message: string | null;
}

export interface ShellState {
  mode: ShellMode;
  listening: boolean;
  /** 使用者剛交辦、仍在前景等待的任務。收起後清空，背景完成不再搶前景。 */
  foreground_task_id: string | null;
  surface: Surface | null;
}

export type ShellEvent =
  | { type: "input.open" }
  | { type: "input.close" }
  | { type: "task.submitted"; task_id: string; request_id: string }
  | { type: "task.updated"; task: Task }
  | { type: "show.progress"; request_id: string; message?: string | null }
  | { type: "show.artifact"; request_id: string; task_id: string; artifact_id: string }
  | { type: "show.notice"; request_id: string; message: string }
  | { type: "show.settings"; request_id: string; message?: string | null }
  /** 家人辨識畫面；request_id 是選單列點擊產生的使用者請求。 */
  | { type: "show.family"; request_id: string }
  /** 記憶卡或記憶管理；request_id 是那一輪打字或選單列點擊。 */
  | { type: "show.memory"; request_id: string }
  /** 外部動作的確認卡；request_id 為確認請求 id，由 Presentation Policy 對照待確認清單。 */
  | { type: "show.confirm"; request_id: string; message: string }
  | { type: "dismiss" };

export const initialShell: ShellState = {
  mode: "ambient",
  listening: false,
  foreground_task_id: null,
  surface: null,
};

function surface(
  kind: SurfaceKind,
  request_id: string,
  extra: Partial<Pick<Surface, "task_id" | "artifact_id" | "message">> = {},
): Surface {
  return {
    surface_id: `surface_${kind}_${request_id}`,
    kind,
    visibility_reason: "user_request",
    request_id,
    task_id: extra.task_id ?? null,
    artifact_id: extra.artifact_id ?? null,
    message: extra.message ?? null,
  };
}

/**
 * 這個畫面開著時不能自動開始對話（看著說話）：startRealtime 會收起畫面。家人辨識畫面（登記、試認）與記憶卡不能被打斷。
 * 使用者自己按「開始語音對話」不受影響（那是明確的動作）。
 */
export function blocksAutoTalk(surface: Surface | null): boolean {
  return surface?.kind === "family" || surface?.kind === "memory";
}

/** 純函式 reducer；不產生任何副作用（例如取消任務），副作用由呼叫端明確發出。 */
export function reduceShell(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case "input.open":
      return state.listening ? state : { ...state, listening: true };
    case "input.close":
      return state.listening ? { ...state, listening: false } : state;
    case "task.submitted":
      return { mode: "working", listening: false, foreground_task_id: event.task_id, surface: null };
    case "task.updated": {
      const { task } = event;
      if (state.mode !== "working" || state.foreground_task_id !== task.task_id) return state;
      if (task.status === "succeeded" && task.artifact_id) {
        return {
          ...state,
          mode: "presenting",
          foreground_task_id: null,
          surface: surface("artifact", task.request_id, {
            task_id: task.task_id,
            artifact_id: task.artifact_id,
          }),
        };
      }
      if (task.status === "failed") {
        return {
          ...state,
          mode: "recoverable_error",
          foreground_task_id: null,
          surface: surface("error", task.request_id, { task_id: task.task_id, message: task.error }),
        };
      }
      if (task.status === "cancelled") {
        return { ...state, mode: "ambient", foreground_task_id: null, surface: null };
      }
      return state;
    }
    case "show.progress":
      return {
        mode: "presenting",
        listening: false,
        foreground_task_id: null,
        surface: surface("progress", event.request_id, { message: event.message ?? null }),
      };
    case "show.artifact":
      return {
        mode: "presenting",
        listening: false,
        foreground_task_id: null,
        surface: surface("artifact", event.request_id, {
          task_id: event.task_id,
          artifact_id: event.artifact_id,
        }),
      };
    case "show.notice":
      return {
        mode: "presenting",
        listening: false,
        foreground_task_id: null,
        surface: surface("notice", event.request_id, { message: event.message }),
      };
    case "show.settings":
      return {
        mode: "presenting",
        listening: false,
        foreground_task_id: null,
        surface: surface("settings", event.request_id, { message: event.message ?? null }),
      };
    case "show.family":
      return {
        mode: "presenting",
        listening: false,
        foreground_task_id: null,
        surface: surface("family", event.request_id),
      };
    case "show.memory":
      return {
        mode: "presenting",
        listening: false,
        foreground_task_id: null,
        surface: surface("memory", event.request_id),
      };
    case "show.confirm":
      return {
        mode: "confirming",
        listening: false,
        foreground_task_id: null,
        surface: { ...surface("confirm", event.request_id, { message: event.message }), visibility_reason: "action_confirmation" },
      };
    case "dismiss":
      // 「收起」只關閉視圖；任務照常在背景執行。
      return { ...initialShell };
  }
}
