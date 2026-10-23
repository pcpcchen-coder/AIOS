import type { HomeControlResult, HomeStatusResult } from "../shared/home.ts";
import type { CameraPrefsPatch } from "../shared/sense.ts";
import type { VoicePrefsPatch } from "../shared/voice-prefs.ts";
import type { Artifact, ExecutorMode, ServerEvent, SettingsView, Task } from "../shared/types.ts";
import type { FallbackOffer, LiveInputKind, RealtimePrefsPatch, RouteId, StartDecision } from "../shared/realtime-route.ts";
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

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
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
  createTask: (text: string, request_id: string) => call<Task>("POST", "/api/tasks", { text, request_id }),
  cancelTask: (taskId: string) => call<Task>("POST", `/api/tasks/${taskId}/cancel`, {}),
  retryTask: (taskId: string, request_id: string) =>
    call<Task>("POST", `/api/tasks/${taskId}/retry`, { request_id }),
  getArtifact: (artifactId: string) => call<Artifact>("GET", `/api/artifacts/${artifactId}`),
  selectProvider: (provider: ExecutorMode) => call<SettingsView>("POST", "/api/settings/provider", { provider }),
  /** 鏡頭使用者設定（保存在本機 camera.json）；回傳更新後的設定。 */
  updateCamera: (patch: CameraPrefsPatch) => call<SettingsView>("POST", "/api/settings/camera", patch),
  updateVoice: (patch: VoicePrefsPatch) => call<SettingsView>("POST", "/api/settings/voice", patch),
  chatgptLogin: (mode: "auto" | "new") => call<{ authorize_url: string }>("POST", "/api/auth/chatgpt/login", { mode }),
  chatgptCancel: () => call<SettingsView>("POST", "/api/auth/chatgpt/cancel", {}),
  chatgptLogout: () => call<{ revoked: boolean; settings: SettingsView }>("POST", "/api/auth/chatgpt/logout", {}),
  chatgptWelcomeAck: () => call<SettingsView>("POST", "/api/auth/chatgpt/welcome-ack", {}),
  /** 即時語音：開麥克風前先決定路徑（client_id：這個頁面的 SSE 串流）。 */
  realtimeStart: (clientId: string | null) => call<StartDecision>("POST", "/api/realtime/start", clientId ? { client_id: clientId } : {}),
  /**
   * 即時語音：把 WebRTC SDP offer 交給本機核心，由它代為建立連線（API key 或 ChatGPT 方案）。
   * 沒有 ticket 是原本的 API key 呼叫。核心提議改路徑（409 ＋ fallback）時丟 FallbackOfferError。
   */
  realtimeCall: async (sdp: string, ticket?: RealtimeTicket) => {
    if (!ticket) return call<{ sdp: string; model: string }>("POST", "/api/realtime/call", { sdp });
    try {
      return await call<{ sdp: string; model: string; route: RouteId; session_id: string }>("POST", "/api/realtime/call", { sdp, ...ticket });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body && "fallback" in err.body) throw new FallbackOfferError(err.body as unknown as FallbackOffer);
      throw err;
    }
  },
  realtimeInput: (ticket: RealtimeTicket, kind: LiveInputKind, text: string) => call<{ ok: true }>("POST", "/api/realtime/input", { ...ticket, kind, text }),
  realtimeApproval: (ticket: RealtimeTicket, state: "open" | "resolved") => call<{ ok: true }>("POST", "/api/realtime/approval", { ...ticket, state }),
  realtimeHostResult: (ticket: RealtimeTicket, callId: string, output: Record<string, unknown>) =>
    call<{ ok: true; accepted: boolean }>("POST", "/api/realtime/host-result", { ...ticket, call_id: callId, output }),
  realtimeEnd: (ticket: RealtimeTicket) => call<{ ok: true }>("POST", "/api/realtime/end", { ...ticket }),
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
  | { type: "done"; model: string | null }
  | { type: "error"; message: string; action: string | null };

/** 語音對話：POST /api/chat，逐筆回傳串流事件；abort 時中斷（插話）。 */
export async function streamChat(
  messages: ChatTurn[],
  request_id: string,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, request_id }),
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
        if (event.type === "done" || event.type === "error") {
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
