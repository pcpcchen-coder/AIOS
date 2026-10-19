import type { Task } from "../shared/types.ts";

// Shell 狀態描述「使用者現在看到什麼」，與任務實際狀態分開（docs/06 §5）。
// 聆聽是疊層（listening），結束後回到原本畫面，不銷毀內容。

export type ShellMode = "ambient" | "working" | "presenting" | "recoverable_error";

export type VisibilityReason =
  | "user_request"
  | "task_clarification"
  | "action_confirmation"
  | "subscribed_event"
  | "sensor_status"
  | "user_pinned";

export type SurfaceKind = "progress" | "artifact" | "error" | "notice" | "settings";

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
    case "dismiss":
      // 「收起」只關閉視圖；任務照常在背景執行。
      return { ...initialShell };
  }
}
