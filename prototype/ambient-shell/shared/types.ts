// 前後端共用的資料契約（原型版）。
// 正式版應改為 packages/shared/schemas 的版本化 JSON Schema（見 docs/07 §3）；
// 這裡先用 TS 型別，schema_version 標為 proto-0.1 以免與正式契約混淆。

import type { Domain } from "./domain.ts";

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

/** AI 引擎（執行器）種類。mock 一律在 UI 標示為「模擬」。 */
export type ExecutorMode = "claude" | "chatgpt" | "mock";

/** 任務失敗時，畫面可提供的下一步。 */
export type ErrorAction = "chatgpt_sign_in" | "manage_chatgpt_usage";

export interface TaskStep {
  title: string;
  status: StepStatus;
  started_at: string | null;
  finished_at: string | null;
  /** 這一步目前已收到的模型輸出字元數；只有真實串流時才會有值。 */
  output_chars: number | null;
  /** 這一步屬於哪個象徵腦區，驅動電子腦對應區域亮起。 */
  domain?: Domain | null;
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
  /** 失敗時建議的下一步（例如重新登入 ChatGPT、管理用量）。 */
  error_action?: ErrorAction | null;
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

export interface ProviderInfo {
  id: ExecutorMode;
  label: string;
  available: boolean;
  /** 可用與否的說明，例如「未設定 ANTHROPIC_API_KEY」。 */
  detail: string;
}

export interface ChatGPTAccountInfo {
  signed_in: boolean;
  email: string | null;
  /** 是否取得 chatgpt.tokens.use.direct（用 ChatGPT 方案額度推論）。 */
  plan_usage: boolean;
  /** 登入已失效，需要重新登入。 */
  needs_reauth: boolean;
  /** 已看過「你正在使用 ChatGPT 方案」說明。 */
  welcome_ack: boolean;
  /** 已開啟瀏覽器登入頁，等待回呼。 */
  pending_login: boolean;
  last_error: string | null;
}

export interface SettingsView {
  schema_version: string;
  provider: ExecutorMode;
  providers: ProviderInfo[];
  chatgpt: ChatGPTAccountInfo;
  /** 即時語音模式（OpenAI Realtime）；未提供時視為不可用。 */
  realtime?: RealtimeInfo;
}

export interface RealtimeInfo {
  available: boolean;
  model: string;
  /** 是否能上網查詢（web_search 工具）。 */
  web_search?: boolean;
  /** 掛上的遠端 MCP 伺服器名稱。 */
  mcp?: string[];
  /** 可用與否的說明，例如「未設定 OPENAI_API_KEY」。 */
  detail: string;
}

export type ServerEvent =
  | { type: "hello"; sequence: number; settings: SettingsView; tasks: Task[] }
  | { type: "task.updated"; sequence: number; task: Task }
  | { type: "settings.updated"; sequence: number; settings: SettingsView };

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
