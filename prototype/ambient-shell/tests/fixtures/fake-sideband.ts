import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

// （fixture）假的 sideband：手寫的 WebSocket upgrade 伺服器，代替 wss://api.openai.com/v1/live/{callId}。
// 和 Node 22 內建的 WebSocket 真的握手，所以也證明 Nous 送出的自訂標頭（Authorization、chatgpt-account-id、
// OpenAI-Alpha）確實到達伺服器——不需要 ws 套件。只實作測試用到的部分：文字框、close、遮罩。
// 內容不代表 OpenAI 伺服器的真實行為。
// MEM-3：startFakeGa 用同一個伺服器做 OpenAI Realtime GA 的假版本（/realtime/client_secrets、/realtime/calls 回
// Location: /v1/realtime/calls/rtc_test、/v1/realtime?call_id= 的 WebSocket 檢查 Bearer API key、/hangup）。
// P1–P5（旁路真的收得到哪些事件）只能在 Mac 上用真 key 驗證，這裡的事件順序只是假設。

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FakeConnection {
  path: string;
  headers: IncomingHttpHeaders;
  /** 用戶端送來的 JSON 事件。 */
  received: Record<string, unknown>[];
  closed: boolean;
  send(event: Record<string, unknown>): void;
  /** 伺服器端直接斷線（模擬 sideband 掉線）。 */
  drop(): void;
  /** 等到收到符合條件的事件。 */
  waitFor(predicate: (event: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitClosed(timeoutMs?: number): Promise<void>;
}

export interface FakeSideband {
  base: string;
  url(callId: string): string;
  connections: FakeConnection[];
  /** 接下來要拒絕幾次 upgrade（回 401）。 */
  refuse: number;
  /** 接下來的 upgrade 要不要不回應（模擬連線逾時）。 */
  hang: boolean;
  upgrades: number;
  next(timeoutMs?: number): Promise<FakeConnection>;
  close(): Promise<void>;
}

function encode(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]) : (() => {
    const b = Buffer.alloc(10);
    b[0] = 0x80 | opcode;
    b[1] = 127;
    b.writeBigUInt64BE(BigInt(len), 2);
    return b;
  })();
  return Buffer.concat([header, payload]);
}

interface FakeOptions {
  /** HTTP 請求（非 upgrade）；沒有時一律 404。 */
  http?: (req: IncomingMessage, body: string, res: ServerResponse) => void;
  /** upgrade 前的驗證；false 回 401。 */
  authorize?: (req: IncomingMessage) => boolean;
  /** 收到一個用戶端事件之後（例如自動回 session.updated）。 */
  onMessage?: (conn: FakeConnection, event: Record<string, unknown>) => void;
}

export async function startFakeSideband(options: FakeOptions = {}): Promise<FakeSideband> {
  const server: Server = createServer((req, res) => {
    if (!options.http) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => options.http!(req, body, res));
  });
  const waiters: ((c: FakeConnection) => void)[] = [];
  const sockets = new Set<Duplex>();
  const fake: FakeSideband = {
    base: "",
    url: (callId) => `${fake.base}/v1/live/${encodeURIComponent(callId)}`,
    connections: [],
    refuse: 0,
    hang: false,
    upgrades: 0,
    next(timeoutMs = 2000) {
      const ready = fake.connections.find((c) => !(c as { taken?: boolean }).taken);
      if (ready) {
        (ready as { taken?: boolean }).taken = true;
        return Promise.resolve(ready);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no sideband connection")), timeoutMs);
        waiters.push((c) => {
          clearTimeout(timer);
          (c as { taken?: boolean }).taken = true;
          resolve(c);
        });
      });
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    fake.upgrades++;
    if (fake.hang) return;
    if (fake.refuse > 0 || (options.authorize && !options.authorize(req))) {
      if (fake.refuse > 0) fake.refuse--;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const listeners: (() => void)[] = [];
    const closeListeners: (() => void)[] = [];
    const conn: FakeConnection = {
      path: req.url ?? "",
      headers: req.headers,
      received: [],
      closed: false,
      send: (event) => {
        if (!conn.closed) socket.write(encode(JSON.stringify(event)));
      },
      drop: () => {
        conn.closed = true;
        socket.destroy();
      },
      waitFor(predicate, timeoutMs = 2000) {
        const found = conn.received.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no matching sideband event; got ${JSON.stringify(conn.received.map((e) => e.type))}`)), timeoutMs);
          const check = () => {
            const hit = conn.received.find(predicate);
            if (hit) {
              clearTimeout(timer);
              resolve(hit);
            }
          };
          listeners.push(check);
        });
      },
      waitClosed(timeoutMs = 2000) {
        if (conn.closed) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("sideband not closed")), timeoutMs);
          closeListeners.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffer[1] & 0x80) !== 0;
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + len) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + len));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskOffset + (i % 4)];
        buffer = buffer.subarray(offset + len);
        if (opcode === 0x8) {
          if (!conn.closed) socket.write(Buffer.from([0x88, 0x00]));
          conn.closed = true;
          socket.end();
          continue;
        }
        if (opcode === 0x9) {
          socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          continue;
        }
        if (opcode === 0x1) {
          let event: Record<string, unknown> | null = null;
          try {
            event = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
            conn.received.push(event);
          } catch {
            // 測試只送 JSON
          }
          for (const l of listeners) l();
          if (event) options.onMessage?.(conn, event);
        }
      }
    });
    socket.on("close", () => {
      conn.closed = true;
      for (const l of closeListeners) l();
    });
    fake.connections.push(conn);
    const waiter = waiters.shift();
    if (waiter) waiter(conn);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

// ─────────────── MEM-3：OpenAI Realtime GA 的假伺服器 ───────────────

export interface FakeGaRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeGa extends FakeSideband {
  /** http://127.0.0.1:port */
  http: string;
  /** 旁路只接受這把 key（Bearer）。 */
  apiKey: string;
  /** 每個 REST 請求（client_secrets、calls、hangup），依到達順序。 */
  requests: FakeGaRequest[];
  /** 被掛斷的 call ID。 */
  hangups: string[];
  /** /calls 回應的 Location；null＝不送（測試「沒有 call ID」）。 */
  location: string | null;
  /** 收到 session.update 時自動回 session.updated（false＝測試自己送）。 */
  autoAck: boolean;
  /** 收到 response.create 時自動回 response.created＋response.done（模擬模型說完；false＝測試自己送）。 */
  autoRespond: boolean;
  /** 收到 session.update 時改回一個指回它的 error（error.event_id），模擬上游拒絕記憶設定。 */
  rejectUpdate: boolean;
  /** 送一個 error 給這條旁路（event_id：指回哪一個用戶端事件；可以是頁面或核心的）。 */
  error(conn: FakeConnection, code: string, eventId: string | null): void;
  /** /calls 的回應狀態碼（預設 201）。 */
  callStatus: number;
  /** RealtimeBridge 的 urls 選項。 */
  bridgeUrls: { api: string; sideband: (callId: string) => string };
  /** 送出的 REST 請求（不含 hangup）的快照：方法、路徑、標頭（只取會影響內容的）與內容。 */
  snapshot(): { method: string; path: string; authorization: string | undefined; contentType: string | undefined; body: string }[];
}

export async function startFakeGa(apiKey = "sk-fixture-ga"): Promise<FakeGa> {
  const state = { requests: [] as FakeGaRequest[], hangups: [] as string[], location: "/v1/realtime/calls/rtc_test" as string | null, autoAck: true, autoRespond: true, rejectUpdate: false, callStatus: 201, responses: 0 };
  const base = await startFakeSideband({
    http: (req, body, res) => {
      const path = req.url ?? "";
      state.requests.push({ method: req.method ?? "", path, headers: req.headers, body });
      if (path === "/v1/realtime/client_secrets") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ value: "ek_fixture_ga", expires_at: 1 }));
        return;
      }
      if (path === "/v1/realtime/calls") {
        res.writeHead(state.callStatus, { "Content-Type": "application/sdp", ...(state.location ? { Location: state.location } : {}) }).end(state.callStatus < 300 ? "v=0 ga-answer" : "fixture error");
        return;
      }
      const hang = /^\/v1\/realtime\/calls\/([^/]+)\/hangup$/.exec(path);
      if (hang) {
        state.hangups.push(decodeURIComponent(hang[1]!));
        res.writeHead(200).end("{}");
        return;
      }
      res.writeHead(404).end();
    },
    authorize: (req) => (req.url ?? "").startsWith("/v1/realtime?call_id=") && req.headers.authorization === `Bearer ${apiKey}`,
    onMessage: (conn, event) => {
      if (state.rejectUpdate && event.type === "session.update") {
        conn.send({ type: "error", event_id: "event_server_1", error: { type: "invalid_request_error", code: "invalid_value", message: "fixture rejection", event_id: event.event_id ?? null } });
        return;
      }
      if (state.autoAck && event.type === "session.update") conn.send({ type: "session.updated", session: { type: "realtime" } });
      if (state.autoRespond && event.type === "response.create") {
        const id = `resp_fixture_${++state.responses}`;
        // 上游把 response.metadata 放在 response 物件回送（MEM-4b 的觸發項目對應用）。
        const metadata = (event.response as { metadata?: unknown } | undefined)?.metadata;
        conn.send({ type: "response.created", response: { id, ...(metadata ? { metadata } : {}) } });
        conn.send({ type: "response.done", response: { id, status: "completed" } });
      }
    },
  });
  const http = base.base.replace(/^ws:/, "http:");
  const fake = base as FakeGa;
  Object.defineProperties(fake, {
    location: { get: () => state.location, set: (v: string | null) => (state.location = v) },
    autoAck: { get: () => state.autoAck, set: (v: boolean) => (state.autoAck = v) },
    autoRespond: { get: () => state.autoRespond, set: (v: boolean) => (state.autoRespond = v) },
    rejectUpdate: { get: () => state.rejectUpdate, set: (v: boolean) => (state.rejectUpdate = v) },
    callStatus: { get: () => state.callStatus, set: (v: number) => (state.callStatus = v) },
  });
  fake.error = (conn, code, eventId) => conn.send({ type: "error", event_id: `event_server_${Math.random().toString(36).slice(2, 8)}`, error: { type: "invalid_request_error", code, message: "fixture", event_id: eventId } });
  fake.http = http;
  fake.apiKey = apiKey;
  fake.requests = state.requests;
  fake.hangups = state.hangups;
  fake.bridgeUrls = { api: `${http}/v1`, sideband: (callId) => `${base.base}/v1/realtime?call_id=${encodeURIComponent(callId)}` };
  fake.snapshot = () => state.requests.filter((r) => !r.path.endsWith("/hangup")).map((r) => ({
    method: r.method,
    path: r.path,
    authorization: r.headers.authorization,
    contentType: r.headers["content-type"],
    body: r.body,
  }));
  return fake;
}
