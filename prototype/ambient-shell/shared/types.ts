import type { FaceTuningView } from "./face-tuning.ts";
import type { Locale } from "./i18n.mjs";
import type { CameraSettings } from "./sense.ts";
import type { MenuPrefSetting } from "./seconds-menu.ts";
import type { VoicePrefs } from "./voice-prefs.ts";
import type { RealtimeRouteFields, RealtimeServerEvent } from "./realtime-route.ts";
import type { IdentityStatus } from "./identity.ts";
import type { MemorySettingsStatus } from "./memory.ts";
import type { WakeSettingsView } from "./wake.ts";
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
  locale?: Locale;
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
  /**
   * MEM-4a：受保護的外殼（macOS App 加密保存任務時，對外的 SSE、/api/tasks、模型提示都只看到它）。標題、步驟標題與錯誤
   * 換成固定句；真正內容只經可信主視窗的 IPC 取得。瀏覽器版（不加密）沒有這個欄位。
   */
  protected?: boolean;
  /** MEM-4a：這個任務帶著記憶執行（受保護交辦）；只是標記，不含任何記憶內容。 */
  memory?: boolean;
  /** MEM-4a：用到的記憶被忘記、更正、撤回同意、刪除人物或關閉記憶：成果內容已移除（crypto-shred），只留外殼與重做。 */
  withdrawn?: boolean;
  /**
   * MEM-4a（審查 M2）：標題確定是使用者自己的原句（受保護交辦，或明確標為打字的 POST /api/tasks）。只有這種任務的重做
   * 才會重新取用記憶；模型改寫的交辦標題或交辦卡沒有這個欄位，重做時不帶記憶。
   */
  origin?: "user_sentence";
  /** MEM-4a：停止的原因；memory_revoked＝執行中用到的記憶被撤銷，沒有產生成果。 */
  cancel_reason?: "memory_revoked" | null;
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
  /** 雙目鏡頭設定（docs/11）；未提供時不使用鏡頭。 */
  /**
   * enable_via：誰能打開鏡頭。"app"＝只有 App 主程序在原生說明之後（POST /api/settings/camera 的 active: true 回 403，
   * 頁面經 nousDesktop.cameraEnable 請主程序問）；沒有這個欄位＝頁面可以經 HTTP 打開（終端機／瀏覽器版，和以前相同）。
   */
  camera?: CameraSettings & { enable_via?: "app" | "page" };
  /** 語音閒置秒數（voice.json）；本機核心一定提供，未提供時用 DEFAULT_VOICE_PREFS。 */
  voice?: VoicePrefs;
  /**
   * 選單列「鏡頭與語音設定」的所有列：數值設定（秒數與倍率）與鏡頭開關，以 kind（seconds／factor／bool）區分，
   * 給選單列直接畫；由核心推導（describeMenuPrefs）。欄位名沿用最早只有秒數時的舊名。
   */
  seconds?: MenuPrefSetting[];
  /** 選單列「顯示鏡頭畫面」不能用的原因（cameraPreviewDisabledReason）；null＝可以用。未提供時選單不畫這一項。 */
  /** 人臉辨識校正值（shared/face-tuning.ts）；只在鏡頭啟用時提供。 */
  face_tuning?: FaceTuningView;
  camera_preview_disabled_reason?: string | null;
  /** 家人辨識的可用狀態與人數（不含姓名與 person_id）；身分資料只走 macOS App 的 IPC。未提供時選單不畫「家人辨識…」。 */
  identity?: IdentityStatus;
  /** 記憶層（16）：全體 SSE 與 settings 只放可用與否、是否開啟；人物與內容只經 IPC。 */
  memory?: MemorySettingsStatus;
  /** WK-01a 常駐喚醒聆聽：只有 NOUS_WAKE=on 時才有（偏好與引擎核對結果；實際狀態以頁面的裝置事件為準）。 */
  wake?: WakeSettingsView;
}

/** API key 路徑（RealtimeBridge.info）提供的欄位；路徑與計費欄位由 RealtimeSessions 補上。 */
export interface RealtimeBaseInfo {
  available: boolean;
  model: string;
  /** 是否能上網查詢（web_search 工具）。 */
  web_search?: boolean;
  /** 掛上的遠端 MCP 伺服器名稱。 */
  mcp?: string[];
  /** 能查詢與控制武陵居的家電（home_status、home_control）。 */
  home?: boolean;
  /** 可用與否的說明，例如「未設定 OPENAI_API_KEY」。 */
  detail: string;
  /** F2／F10：本機開口偵測的 RMS 門檻（NOUS_EARLY_SPEECH_RMS）；沒有設定時不帶，頁面用預設值。 */
  early_speech_rms?: number;
}

/**
 * 即時語音：available／model／detail／web_search／home／mcp 說的是「下一次開始會用的路徑」；
 * 路徑偏好、兩條路徑各自的狀態、計費與正在進行的工作階段見 RealtimeRouteFields。
 */
export interface RealtimeInfo extends RealtimeBaseInfo, RealtimeRouteFields {}

export type ServerEvent =
  /** client_id：這條 SSE 串流的識別；開始即時語音時帶給核心，核心只把工具呼叫送到這條串流。 */
  | { type: "hello"; sequence: number; settings: SettingsView; tasks: Task[]; client_id?: string }
  | { type: "task.updated"; sequence: number; task: Task }
  | { type: "settings.updated"; sequence: number; settings: SettingsView }
  /** HIST-1：使用者在成果紀錄裡確認刪除了一個任務（與它的成果）。 */
  | { type: "task.deleted"; sequence: number; task_id: string; artifact_id: string | null }
  | RealtimeServerEvent;

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
