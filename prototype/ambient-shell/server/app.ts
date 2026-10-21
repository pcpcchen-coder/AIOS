import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { ExecutorMode, ServerEvent, SettingsView } from "../shared/types.ts";
import type { ChatGPTAuth } from "./chatgpt-auth.ts";
import { buildChatSystem, DelegationFilter, validateMessages, type ChatCapable } from "./chat.ts";
import { ExecutionError } from "./runner.ts";
import { RealtimeError, type RealtimeBridge } from "./realtime.ts";
import { WebSearchError, type WebSearch } from "./web-search.ts";
import { HomeBridgeError, type HomeBridge } from "./home-bridge.ts";
import type { CameraSettings } from "../shared/sense.ts";
import { allowedHosts, checkRequest } from "./http-guard.ts";
import type { TaskRunner } from "./runner.ts";
import type { TaskStore } from "./store.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 2000;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{6,64}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
};

/**
 * 頁面安全標頭。鏡頭啟用時（NOUS_CAMERA=on）才允許本頁使用鏡頭，並允許編譯本機的 MediaPipe wasm；
 * 影像處理仍只在本機（connect-src 'self'）。
 */
export function pageHeaders(camera: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": `default-src 'self'; script-src 'self'${camera ? " 'wasm-unsafe-eval'" : ""}; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": `camera=(${camera ? "self" : ""}), microphone=(self), geolocation=()`,
  };
}

export interface AppOptions {
  store: TaskStore;
  runner: TaskRunner;
  settings: {
    view(): SettingsView;
    select(provider: ExecutorMode): void;
  };
  auth: ChatGPTAuth;
  /** 語音對話用的引擎（通常就是 ProviderManager）。 */
  chat: ChatCapable;
  /** 即時語音模式（OpenAI Realtime）；未提供時不可用。 */
  realtime?: RealtimeBridge;
  /** 即時語音的上網查詢；未提供時不可用。 */
  webSearch?: WebSearch;
  /** 武陵居中控的唯讀查詢（docs/12 H0）；未提供時不可用。 */
  home?: HomeBridge;
  /** 雙目鏡頭設定（docs/11）；未提供或未啟用時頁面不允許使用鏡頭。 */
  camera?: CameraSettings;
  port: number;
  devPort: number;
  distDir: string | null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApp(options: AppOptions): Server & { notifySettings(): void } {
  const { store, runner, auth, chat, realtime, webSearch, home } = options;
  const settings = {
    view: (): SettingsView => ({
      ...options.settings.view(),
      ...(realtime ? { realtime: realtime.info() } : {}),
      ...(options.camera ? { camera: options.camera } : {}),
    }),
    select: (provider: ExecutorMode) => options.settings.select(provider),
  };
  const hosts = allowedHosts(options.port, options.devPort);
  const clients = new Set<ServerResponse>();
  let sequence = 0;

  const broadcast = (event: ServerEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  store.subscribe((task) => broadcast({ type: "task.updated", sequence: ++sequence, task }));

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": keep-alive\n\n");
  }, 25_000);
  heartbeat.unref();

  const server = createServer(async (req, res) => {
    try {
      const guard = checkRequest(req.method ?? "GET", req.headers, hosts);
      if (!guard.ok) throw new HttpError(guard.status, guard.message);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname);
      } else {
        serveStatic(res, url.pathname, options.distDir, !!options.camera?.enabled);
      }
    } catch (err) {
      const code = err instanceof HttpError ? err.status : 500;
      if (code === 500) console.error(err);
      if (!res.headersSent) sendJson(res, code, { error: (err as Error).message });
      else res.end();
    }
  });
  server.on("close", () => clearInterval(heartbeat));

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "GET" && path === "/api/settings") return sendJson(res, 200, settings.view());
    if (method === "POST" && path === "/api/settings/provider") {
      const body = await readJson(req);
      const provider = body.provider;
      if (provider !== "claude" && provider !== "chatgpt" && provider !== "mock") throw new HttpError(400, "unknown provider");
      try {
        settings.select(provider);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      return sendJson(res, 200, settings.view());
    }
    if (method === "POST" && path === "/api/chat") return streamChat(req, res);
    if (method === "POST" && path === "/api/realtime/call") {
      const body = await readJson(req);
      const sdp = typeof body.sdp === "string" ? body.sdp : "";
      if (!sdp.startsWith("v=0")) throw new HttpError(400, "sdp offer is required");
      if (!realtime) throw new HttpError(409, "即時語音模式未啟用");
      try {
        return sendJson(res, 200, await realtime.connect(sdp, store.list()));
      } catch (err) {
        if (err instanceof RealtimeError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (method === "POST" && path === "/api/realtime/web-search") {
      const body = await readJson(req);
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) throw new HttpError(400, "query is required");
      if (query.length > 500) throw new HttpError(400, "query is too long");
      if (!webSearch?.available) throw new HttpError(409, "上網查詢未啟用（需要 OPENAI_API_KEY）");
      try {
        return sendJson(res, 200, await webSearch.search(query));
      } catch (err) {
        if (err instanceof WebSearchError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (method === "POST" && path === "/api/home/status") {
      const body = await readJson(req);
      const target = typeof body.target === "string" ? body.target.trim() : "";
      const metric = typeof body.metric === "string" ? body.metric.trim() : null;
      if (!target) throw new HttpError(400, "target is required");
      if (target.length > 100 || (metric?.length ?? 0) > 40) throw new HttpError(400, "target or metric is too long");
      if (!home?.available) throw new HttpError(409, "尚未設定武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）");
      try {
        return sendJson(res, 200, await home.status(target, metric));
      } catch (err) {
        if (err instanceof HomeBridgeError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (method === "POST" && path === "/api/auth/chatgpt/login") {
      const body = await readJson(req);
      const mode = body.mode === "new" ? "new" : "auto";
      return sendJson(res, 200, await auth.startLogin(mode));
    }
    if (method === "POST" && path === "/api/auth/chatgpt/cancel") {
      await readJson(req);
      auth.cancelPending();
      return sendJson(res, 200, settings.view());
    }
    if (method === "POST" && path === "/api/auth/chatgpt/logout") {
      await readJson(req);
      const result = await auth.logout();
      return sendJson(res, 200, { ...result, settings: settings.view() });
    }
    if (method === "POST" && path === "/api/auth/chatgpt/welcome-ack") {
      await readJson(req);
      auth.ackWelcome();
      return sendJson(res, 200, settings.view());
    }
    if (method === "GET" && path === "/api/tasks") return sendJson(res, 200, store.list());
    if (method === "GET" && path === "/api/events") return openEvents(req, res);

    if (method === "POST" && path === "/api/tasks") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new HttpError(400, "text is required");
      if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, `text exceeds ${MAX_TEXT_CHARS} chars`);
      return sendJson(res, 201, runner.submit({ title: text, request_id: requestId(body) }));
    }

    const artifact = path.match(/^\/api\/artifacts\/([\w-]+)$/);
    if (method === "GET" && artifact) {
      const found = store.getArtifact(artifact[1]);
      if (!found) throw new HttpError(404, "artifact not found");
      return sendJson(res, 200, found);
    }

    const action = path.match(/^\/api\/tasks\/([\w-]+)\/(cancel|retry)$/);
    if (method === "POST" && action) {
      const [, taskId, verb] = action;
      const body = await readJson(req);
      if (verb === "cancel") {
        const task = runner.cancel(taskId);
        if (!task) throw new HttpError(404, "task not found");
        return sendJson(res, 200, task);
      }
      const task = runner.retry(taskId, requestId(body));
      if (!task) throw new HttpError(409, "only failed or cancelled tasks can be retried");
      return sendJson(res, 201, task);
    }

    throw new HttpError(404, "not found");
  }

  /** 語音對話：以 SSE 串流回覆文字；客戶端中斷（插話）時一併中止上游請求。 */
  async function streamChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    requestId(body);
    const messages = validateMessages(body.messages);
    if (!messages) throw new HttpError(400, "messages must be 1–40 user/assistant turns ending with user");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const filter = new DelegationFilter();
    try {
      const { model } = await chat.chat(
        { system: buildChatSystem(store.list()), messages },
        (delta) => {
          const { text, delegates } = filter.push(delta);
          if (text) send({ type: "delta", text });
          for (const title of delegates) send({ type: "delegate", title });
        },
        controller.signal,
      );
      const rest = filter.flush();
      if (rest) send({ type: "delta", text: rest });
      send({ type: "done", model });
    } catch (err) {
      if (!controller.signal.aborted) {
        send({
          type: "error",
          message: err instanceof ExecutionError ? err.userMessage : `對話失敗：${(err as Error).message}`,
          action: err instanceof ExecutionError ? err.action : null,
        });
      }
    }
    res.end();
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const hello: ServerEvent = { type: "hello", sequence: ++sequence, settings: settings.view(), tasks: store.list() };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  return Object.assign(server, {
    /** 設定或登入狀態改變時呼叫，推送給所有畫面。 */
    notifySettings: () => broadcast({ type: "settings.updated", sequence: ++sequence, settings: settings.view() }),
  });
}

function requestId(body: Record<string, unknown>): string {
  const id = body.request_id;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new HttpError(400, "valid request_id is required");
  return id;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "body must be a JSON object");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function serveStatic(res: ServerResponse, pathname: string, distDir: string | null, camera = false): void {
  if (!distDir || !existsSync(join(distDir, "index.html"))) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("前端尚未建置：請用 npm start（會先 vite build），或開發時用 npm run dev:web。");
    return;
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(distDir, relative);
  if (!file.startsWith(distDir + sep) && file !== distDir) throw new HttpError(403, "forbidden");
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
  const type = CONTENT_TYPES[extname(file)] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type };
  if (type.startsWith("text/html")) Object.assign(headers, pageHeaders(camera), { "Cache-Control": "no-cache" });
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}
