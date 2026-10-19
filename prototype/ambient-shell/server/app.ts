import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { SCHEMA_VERSION, type ServerEvent, type ServerStatus } from "../shared/types.ts";
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
};

const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
};

export interface AppOptions {
  store: TaskStore;
  runner: TaskRunner;
  status: ServerStatus;
  port: number;
  devPort: number;
  distDir: string | null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createApp(options: AppOptions): Server {
  const { store, runner, status } = options;
  const hosts = allowedHosts(options.port, options.devPort);
  const clients = new Set<ServerResponse>();
  let sequence = 0;

  store.subscribe((task) => {
    const event: ServerEvent = { type: "task.updated", sequence: ++sequence, task };
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(frame);
  });

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
        serveStatic(res, url.pathname, options.distDir);
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
    if (method === "GET" && path === "/api/status") return sendJson(res, 200, status);
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

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const hello: ServerEvent = { type: "hello", sequence: ++sequence, status, tasks: store.list() };
    res.write(`data: ${JSON.stringify(hello)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  }

  return server;
}

export function buildStatus(mode: ServerStatus["mode"], modeReason: string): ServerStatus {
  return { schema_version: SCHEMA_VERSION, mode, mode_reason: modeReason };
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

function serveStatic(res: ServerResponse, pathname: string, distDir: string | null): void {
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
  if (type.startsWith("text/html")) Object.assign(headers, PAGE_HEADERS, { "Cache-Control": "no-cache" });
  res.writeHead(200, headers);
  res.end(readFileSync(file));
}
