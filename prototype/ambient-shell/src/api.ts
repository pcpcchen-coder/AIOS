import type { HomeStatusResult } from "../shared/home.ts";
import type { CameraPrefsPatch } from "../shared/sense.ts";
import type { Artifact, ExecutorMode, ServerEvent, SettingsView, Task } from "../shared/types.ts";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
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
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
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
  chatgptLogin: (mode: "auto" | "new") => call<{ authorize_url: string }>("POST", "/api/auth/chatgpt/login", { mode }),
  chatgptCancel: () => call<SettingsView>("POST", "/api/auth/chatgpt/cancel", {}),
  chatgptLogout: () => call<{ revoked: boolean; settings: SettingsView }>("POST", "/api/auth/chatgpt/logout", {}),
  chatgptWelcomeAck: () => call<SettingsView>("POST", "/api/auth/chatgpt/welcome-ack", {}),
  /** 即時語音：把 WebRTC SDP offer 交給本機核心，由它用 API key 向 OpenAI 建立連線。 */
  realtimeCall: (sdp: string) => call<{ sdp: string; model: string }>("POST", "/api/realtime/call", { sdp }),
  /** 即時語音的上網查詢：由本機核心用 OPENAI_API_KEY 呼叫 web_search。 */
  webSearch: (query: string) =>
    call<{ ok: true; answer: string; sources: { title: string; url: string }[]; model: string }>("POST", "/api/realtime/web-search", { query }),
  /** 武陵居家電狀態（唯讀）：由本機核心帶權杖查中控，權杖不進瀏覽器。 */
  homeStatus: (target: string, metric: string | null) =>
    call<HomeStatusResult>("POST", "/api/home/status", metric ? { target, metric } : { target }),
};

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
