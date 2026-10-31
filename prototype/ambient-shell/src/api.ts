import type { FaceTuning } from "../shared/face-tuning.ts";
import { getLocale, type Locale } from "./i18n.ts";
import type { HomeControlResult, HomeStatusResult } from "../shared/home.ts";
import type { CameraPrefsPatch } from "../shared/sense.ts";
import type { VoicePrefsPatch } from "../shared/voice-prefs.ts";
import type { Artifact, ExecutorMode, ServerEvent, SettingsView, Task } from "../shared/types.ts";
import { historySearchPath, type HistoryDetail, type HistoryPage, type HistoryQuery } from "../shared/history.ts";
import type { ApprovalReport, CallAnswer, FallbackOffer, LiveInputKind, RealtimePrefsPatch, StartDecision, StopEvidence } from "../shared/realtime-route.ts";
import { FallbackOfferError } from "./realtime-session.ts";

/** 一個經 /api/realtime/start 決定的工作階段（session_id ＋ 擁有者憑證）。 */
export interface RealtimeTicket {
  session_id: string;
  owner: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> | null = null) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, locale: Locale = getLocale()): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "X-Nous-Locale": locale, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "無法連到本機核心（伺服器未啟動或已停止）");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`, data as Record<string, unknown>);
  return data as T;
}

export const api = {
  getSettings: (locale?: Locale) => call<SettingsView>("GET", "/api/settings", undefined, locale),
  createTask: (text: string, request_id: string, locale?: Locale) => call<Task>("POST", "/api/tasks", { text, request_id }, locale),
  cancelTask: (taskId: string) => call<Task>("POST", `/api/tasks/${taskId}/cancel`, {}),
  retryTask: (taskId: string, request_id: string) =>
    call<Task>("POST", `/api/tasks/${taskId}/retry`, { request_id }),
  getArtifact: (artifactId: string) => call<Artifact>("GET", `/api/artifacts/${artifactId}`),
  /** 成果紀錄（HIST-1）：搜尋、單筆詳細、經確認的刪除、重做（沿用重試，接受已完成的任務）。 */
  searchHistory: (query: HistoryQuery) => call<HistoryPage>("GET", historySearchPath(query)),
  getHistory: (taskId: string) => call<HistoryDetail>("GET", `/api/history/${encodeURIComponent(taskId)}`),
  deleteHistory: (taskId: string, request_id: string) =>
    call<{ ok: true; task_id: string; artifact_id: string | null }>("POST", `/api/history/${encodeURIComponent(taskId)}/delete`, { request_id, confirm: true }),
  redoTask: (taskId: string, request_id: string) => call<Task>("POST", `/api/tasks/${encodeURIComponent(taskId)}/retry`, { request_id, redo: true }),
  selectProvider: (provider: ExecutorMode) => call<SettingsView>("POST", "/api/settings/provider", { provider }),
  /** 鏡頭使用者設定（保存在本機 camera.json）；回傳更新後的設定。 */
  updateCamera: (patch: CameraPrefsPatch) => call<SettingsView>("POST", "/api/settings/camera", patch),
  updateVoice: (patch: VoicePrefsPatch) => call<SettingsView>("POST", "/api/settings/voice", patch),
  /** 人臉辨識校正值（face-tuning.json）：calibrated 表示這次是「校正人臉辨識」的套用；reset 還原預設。 */
  updateFaceTuning: (change: Partial<FaceTuning> | "reset", calibrated = false) =>
    call<SettingsView>("POST", "/api/settings/camera-tuning", change === "reset" ? { reset: true } : { ...change, ...(calibrated ? { calibrated: true } : {}) }),
  chatgptLogin: (mode: "auto" | "new") => call<{ authorize_url: string }>("POST", "/api/auth/chatgpt/login", { mode }),
  chatgptCancel: () => call<SettingsView>("POST", "/api/auth/chatgpt/cancel", {}),
  chatgptLogout: () => call<{ revoked: boolean; settings: SettingsView }>("POST", "/api/auth/chatgpt/logout", {}),
  chatgptWelcomeAck: () => call<SettingsView>("POST", "/api/auth/chatgpt/welcome-ack", {}),
  /** 即時語音：開麥克風前先決定路徑（client_id：這個頁面的 SSE 串流）。 */
  /** rebuild：MEM-2 記憶撤銷後自動重建（只走 live、不問候）。 */
  realtimeStart: (clientId: string | null, source: "look_to_talk" | "user" = "user", locale?: Locale, rebuild = false) =>
    call<StartDecision>("POST", "/api/realtime/start", { ...(clientId ? { client_id: clientId } : {}), ...(source === "look_to_talk" ? { source } : {}), ...(rebuild ? { rebuild: true } : {}) }, locale),
  /**
   * 即時語音：把 WebRTC SDP offer 交給本機核心，由它代為建立連線（API key 或 ChatGPT 方案）。
   * 沒有 ticket 是原本的 API key 呼叫。核心提議改路徑（409 ＋ fallback）時丟 FallbackOfferError。
   */
  realtimeCall: async (sdp: string, ticket?: RealtimeTicket) => {
    if (!ticket) return call<{ sdp: string; model: string }>("POST", "/api/realtime/call", { sdp });
    try {
      return await call<CallAnswer>("POST", "/api/realtime/call", { sdp, ...ticket });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && "fallback" in err.body) throw new FallbackOfferError(err.body as unknown as FallbackOffer);
      throw err;
    }
  },
  realtimeInput: (ticket: RealtimeTicket, kind: LiveInputKind, text: string) => call<{ ok: true }>("POST", "/api/realtime/input", { ...ticket, kind, text }),
  realtimeApproval: (ticket: RealtimeTicket, report: ApprovalReport) => call<{ ok: true }>("POST", "/api/realtime/approval", { ...ticket, ...report }),
  realtimeHostResult: (ticket: RealtimeTicket, callId: string, output: Record<string, unknown>) =>
    call<{ ok: true; accepted: boolean }>("POST", "/api/realtime/host-result", { ...ticket, call_id: callId, output }),
  realtimeEnd: (ticket: RealtimeTicket) => call<{ ok: true }>("POST", "/api/realtime/end", { ...ticket }),
  /** MEM-2：記憶撤銷後停播並核對的證據（只有布林值與毫秒數）。 */
  /** MEM-3：API key 路徑的頁面在資料通道收到播放結束（沒有內容、沒有時間戳）。 */
  realtimePlayback: (ticket: RealtimeTicket) => call<{ ok: true }>("POST", "/api/realtime/playback", { ...ticket }),
  /** F7：手掌停止（停止回覆）：核心把這一輪還沒回來的工具結果改成不念出（任務照常）。 */
  realtimeStopReply: (ticket: RealtimeTicket) => call<{ ok: true }>("POST", "/api/realtime/stop-reply", { ...ticket }),
  realtimeStopped: (ticket: RealtimeTicket, evidence: StopEvidence) => call<{ ok: true; accepted: boolean }>("POST", "/api/realtime/stopped", { ...ticket, evidence }),
  /** 路徑偏好與 ChatGPT 方案路徑的聲音；下一次開始才生效。 */
  updateRealtime: (patch: RealtimePrefsPatch) => call<SettingsView>("POST", "/api/settings/realtime", patch),
  codexLogin: (method: "browser" | "device") =>
    call<{ method: "browser"; authorize_url: string; port: number } | { method: "device"; verification_url: string; user_code: string; note: string | null }>(
      "POST", "/api/auth/codex/login", { method },
    ),
  codexCancel: () => call<SettingsView>("POST", "/api/auth/codex/cancel", {}),
  codexLogout: () => call<{ revoked: boolean; settings: SettingsView }>("POST", "/api/auth/codex/logout", {}),
  /** 即時語音的上網查詢：API key 路徑用 OPENAI_API_KEY；ChatGPT 方案路徑的工作階段（帶 ticket）用 Codex 額度。 */
  webSearch: (query: string, ticket?: RealtimeTicket) =>
    call<{ ok: true; answer: string; sources: { title: string; url: string }[]; model: string }>("POST", "/api/realtime/web-search", ticket ? { query, ...ticket } : { query }),
  /** 武陵居家電狀態（唯讀）：由本機核心帶權杖查中控，權杖不進瀏覽器。 */
  homeStatus: (target: string, metric: string | null) =>
    call<HomeStatusResult>("POST", "/api/home/status", metric ? { target, metric } : { target }),
  /** 武陵居家電控制：由本機核心帶權杖送到中控，回傳中控的真實結果。 */
  homeControl: (args: HomeControlArgs) => call<HomeControlResult>("POST", "/api/home/control", args),
  /** 確認卡的答案（同意或不同意）；本機核心才知道這張卡要執行什麼。 */
  homeConfirm: (confirmId: string, approve: boolean) => call<HomeControlResult>("POST", "/api/home/confirm", { confirm_id: confirmId, approve }),
};

export interface HomeControlArgs {
  target: string;
  command: string;
  value: string | number | boolean | null;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "delegate"; title: string }
  /** 這一輪用了記憶：不自動交辦，改問使用者（title 是使用者原句）。 */
  | { type: "delegate_blocked"; title: string }
  /** MEM-4a：核心已建立受保護交辦的任務（外殼；標題是使用者原句，畫面經 IPC 讀）。 */
  | { type: "delegated"; task: Task; memory_used: number }
  /** 核心的固定句型：這次沒有保存或沒有用到記憶。 */
  | { type: "memory_notice"; message: string }
  /** 記憶被撤銷（換人、更正、忘記、關閉記憶）：回覆停止，這是結束事件。 */
  | { type: "memory_revoked"; message: string }
  | { type: "done"; model: string | null; memory_used?: number }
  | { type: "error"; message: string; action: string | null };

/** 語音對話：POST /api/chat，逐筆回傳串流事件；abort 時中斷（插話）。 */
export async function streamChat(
  messages: ChatTurn[],
  request_id: string,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
  locale: Locale = getLocale(),
  memoryTurn: string | null = null,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nous-Locale": locale },
      body: JSON.stringify({ messages, request_id, ...(memoryTurn ? { memory_turn: memoryTurn } : {}) }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError(0, "無法連到本機核心（伺服器未啟動或已停止）");
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replaceAll("\r\n", "\n");
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as ChatEvent;
        onEvent(event);
        if (event.type === "done" || event.type === "error" || event.type === "memory_revoked") {
          terminal = true;
          return;
        }
      }
      if (done) break;
    }
    if (!terminal) throw new ApiError(0, "回覆串流中斷，未收到完成確認。請再試一次。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface EventHandlers {
  onEvent(event: ServerEvent): void;
  onConnectionChange(connected: boolean): void;
}

/** 以 SSE 接收真實任務事件；斷線時 EventSource 會自動重連，重連後收到完整快照。 */
export function subscribeEvents(handlers: EventHandlers): () => void {
  const source = new EventSource("/api/events");
  source.onopen = () => handlers.onConnectionChange(true);
  source.onerror = () => handlers.onConnectionChange(false);
  source.onmessage = (msg) => {
    try {
      handlers.onEvent(JSON.parse(msg.data) as ServerEvent);
    } catch (err) {
      console.error("無法解析事件", err);
    }
  };
  return () => source.close();
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}
