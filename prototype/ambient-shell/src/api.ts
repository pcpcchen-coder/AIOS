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
  chatgptLogin: (mode: "auto" | "new") => call<{ authorize_url: string }>("POST", "/api/auth/chatgpt/login", { mode }),
  chatgptCancel: () => call<SettingsView>("POST", "/api/auth/chatgpt/cancel", {}),
  chatgptLogout: () => call<{ revoked: boolean; settings: SettingsView }>("POST", "/api/auth/chatgpt/logout", {}),
  chatgptWelcomeAck: () => call<SettingsView>("POST", "/api/auth/chatgpt/welcome-ack", {}),
};

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
