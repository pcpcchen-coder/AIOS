// 前後端共用的資料契約（原型版）。
// 正式版應改為 packages/shared/schemas 的版本化 JSON Schema（見 docs/07 §3）；
// 這裡先用 TS 型別，schema_version 標為 proto-0.1 以免與正式契約混淆。

export const SCHEMA_VERSION = "proto-0.1";

/** 任務狀態；與 docs/06 §5 的 Task 狀態對齊（本原型無 awaiting_* 狀態）。 */
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export type StepStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** 執行器種類。mock 一律在 UI 標示為「模擬」。 */
export type ExecutorMode = "claude" | "mock";

export interface TaskStep {
  title: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  /** 這一步目前已收到的模型輸出字元數；只有真實串流時才會有值。 */
  output_chars: number | null;
}

export interface Task {
  schema_version: string;
  task_id: string;
  /** 觸發這個任務的使用者輸入 id，Presentation Policy 用它驗證 user_request。 */
  request_id: string;
  /** 使用者交辦時的原文。 */
  title: string;
  status: TaskStatus;
  mode: ExecutorMode;
  model: string | null;
  /** 步驟總數確定後才為 true；在此之前不得顯示百分比。 */
  plan_ready: boolean;
  steps: TaskStep[];
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  error: string | null;
  artifact_id: string | null;
  /** 由哪個任務重試而來。 */
  retry_of: string | null;
}

export interface Artifact {
  schema_version: string;
  artifact_id: string;
  version: number;
  task_id: string;
  title: string;
  /** Markdown 內容；呈現前一律經過 sanitize。 */
  content: string;
  mode: ExecutorMode;
  model: string | null;
  assumptions: string[];
  capability_gaps: string[];
  status: "complete" | "partial";
  created_at: string;
}

export interface ServerStatus {
  schema_version: string;
  mode: ExecutorMode;
  /** mock 模式的原因（例如未設定 API key），會顯示給使用者。 */
  mode_reason: string;
}

export type ServerEvent =
  | { type: "hello"; sequence: number; status: ServerStatus; tasks: Task[] }
  | { type: "task.updated"; sequence: number; task: Task };
