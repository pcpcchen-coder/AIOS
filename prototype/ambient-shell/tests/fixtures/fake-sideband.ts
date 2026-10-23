import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

// （fixture）假的 sideband：手寫的 WebSocket upgrade 伺服器，代替 wss://api.openai.com/v1/live/{callId}。
// 和 Node 22 內建的 WebSocket 真的握手，所以也證明 Nous 送出的自訂標頭（Authorization、chatgpt-account-id、
// OpenAI-Alpha）確實到達伺服器——不需要 ws 套件。只實作測試用到的部分：文字框、close、遮罩。
// 內容不代表 OpenAI 伺服器的真實行為。

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

export async function startFakeSideband(): Promise<FakeSideband> {
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
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
        server.close(() => resolve());
      }),
  };

  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    fake.upgrades++;
    if (fake.hang) return;
    if (fake.refuse > 0) {
      fake.refuse--;
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
          try {
            conn.received.push(JSON.parse(payload.toString("utf8")) as Record<string, unknown>);
          } catch {
            // 測試只送 JSON
          }
          for (const l of listeners) l();
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
