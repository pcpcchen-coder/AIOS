import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type AckMessage, type CommandMessage, type DuckAction, type EventMessage, type HelloMessage, type StateMessage } from "../../shared/duck-link.ts";
import { createValidator, type DuckLinkValidator } from "./schema.ts";

// DUCK-1：duck-link hub，Nous 端的 WebSocket 端點（鴨子是 client；設計見 Nous Duck repo（pcpcchen-coder/Open_Duck_Mini） 的 nous_duck/docs/adr/ADR-0009 §2.1）。
// - 只綁 127.0.0.1；鴨子經 SSH 通道連進來。帶 Origin 的請求（瀏覽器頁面）一律拒絕。
// - 連線後雙方先送 hello；之後 hub 每 500 ms 送 heartbeat（連線租約），用鴨子的回聲量往返時間。
// - 指令送出後等 ack（一個 request_id 一個 ack）；保存最新 state；轉發 event（依 event_id 去重）。
// - 收到與送出的每一則訊息都用 duck-link.v0.schema.json 驗證；不合格的訊息丟掉並計數，不猜測內容。
// 在核心裡用 attach() 掛到既有的 http server（server/nous.ts）；start() 是獨立執行用（測試與開發）。

export const DEFAULT_PORT = 8791;
export const DUCK_LINK_PATH = "/duck-link";

/** WebSocket 關閉代碼（4000 以上是應用自訂）。 */
export const CLOSE = { stale: 4000, replaced: 4001, version: 4002, badHello: 4003, shutdown: 4004 } as const;

export interface DuckLinkHubOptions {
  /** 預設 8791；測試用 0（系統配置臨時埠）。 */
  port?: number;
  /** 心跳間隔（協定規定 500 ms；只有測試會改）。 */
  heartbeatMs?: number;
  /** 連線後多久沒收到鴨子的 hello 就關閉。 */
  helloTimeoutMs?: number;
  /** 多久沒收到鴨子的任何訊息就視為連線失效並關閉。 */
  staleMs?: number;
  software?: string;
  now?: () => number;
  log?: (line: string) => void;
  validator?: DuckLinkValidator;
}

export type CommandOutcome =
  /** 沒有送出：沒有連線、指令本身不合 schema，或送出前呼叫端已經中止。 */
  | { kind: "not_sent"; why: "not_connected" | "invalid" | "aborted"; errors?: string[] }
  /** 鴨子回了 ack（accepted 或 rejected）。ackSeq 之後收到的 state 才算回讀。 */
  | { kind: "ack"; ack: AckMessage; requestId: string; sentSeq: number; ackSeq: number; rttMs: number }
  /** 已送出，時限內沒有 ack：結果不明。 */
  | { kind: "no_ack"; requestId: string; sentSeq: number }
  /** 已送出，等 ack 時連線中斷：結果不明。 */
  | { kind: "link_lost"; requestId: string; sentSeq: number }
  /** 已送出，呼叫端中止：結果不明。 */
  | { kind: "aborted"; requestId: string; sentSeq: number };

export interface SendOptions {
  ttlMs: number;
  ackTimeoutMs: number;
  signal?: AbortSignal;
  /** 指定 request_id（要符合 ^[A-Za-z0-9_-]{8,64}$）；不給就自動產生。 */
  requestId?: string;
}

export type Observation =
  | { seq: number; at: number; kind: "state"; state: StateMessage }
  | { seq: number; at: number; kind: "event"; event: EventMessage };

export type WaitResult = Observation | "timeout" | "link_lost" | "aborted";

export interface LinkSnapshot {
  connected: boolean;
  /** 鴨子的 hello（沒有連線時是上一次連線的，僅供診斷）。 */
  hello: HelloMessage | null;
  state: StateMessage | null;
  /** 收到最新 state 的時間（hub 的時鐘，epoch ms）。 */
  stateAt: number | null;
  rttMs: number | null;
  connectedAt: number | null;
  counters: { connections: number; rxInvalid: number; txInvalid: number; unmatchedAcks: number; duplicateEvents: number; commands: number };
}

export type LinkChange = { up: true; hello: HelloMessage } | { up: false; reason: string };

/** DuckAdapter 與 presence 需要的連線介面（hub 實作它；測試可以另外實作）。 */
export interface DuckLink {
  snapshot(): LinkSnapshot;
  sendCommand(action: DuckAction, params: Record<string, unknown> | undefined, options: SendOptions): Promise<CommandOutcome>;
  /** 等一則 seq 大於 sinceSeq、符合條件的 state 或 event（先看最近收到的，再等新的）。 */
  waitFor(match: (o: Observation) => boolean, options: { sinceSeq: number; timeoutMs: number; signal?: AbortSignal }): Promise<WaitResult>;
  onState(listener: (state: StateMessage) => void): () => void;
  onEvent(listener: (event: EventMessage) => void): () => void;
  onLink(listener: (change: LinkChange) => void): () => void;
}

interface Pending {
  resolve: (outcome: CommandOutcome) => void;
  sentSeq: number;
  sentAt: number;
  cleanup: () => void;
}

interface Waiter {
  match: (o: Observation) => boolean;
  finish: (result: WaitResult) => void;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RECENT = 64;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export class DuckLinkHub implements DuckLink {
  private readonly heartbeatMs: number;
  private readonly helloTimeoutMs: number;
  private readonly staleMs: number;
  private readonly software: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly validator: DuckLinkValidator;
  private readonly requestedPort: number;

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private detach: (() => void) | null = null;
  /** 已完成 hello 的鴨子連線。 */
  private duck: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatSeq = 0;
  private readonly heartbeatSent = new Map<number, number>();
  private lastRxAt = 0;

  private hello: HelloMessage | null = null;
  private state: StateMessage | null = null;
  private stateAt: number | null = null;
  private rttMs: number | null = null;
  private connectedAt: number | null = null;
  private rxSeq = 0;
  private readonly recent: Observation[] = [];
  private readonly seenEvents: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<Waiter>();
  private readonly stateListeners = new Set<(s: StateMessage) => void>();
  private readonly eventListeners = new Set<(e: EventMessage) => void>();
  private readonly linkListeners = new Set<(c: LinkChange) => void>();
  private readonly counters = { connections: 0, rxInvalid: 0, txInvalid: 0, unmatchedAcks: 0, duplicateEvents: 0, commands: 0 };

  constructor(options: DuckLinkHubOptions = {}) {
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.heartbeatMs = options.heartbeatMs ?? 500;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 3_000;
    this.staleMs = options.staleMs ?? 3_000;
    this.software = options.software ?? "duck-link-hub 0.1.0";
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.validator = options.validator ?? createValidator();
  }

  /**
   * 掛到一個既有的 http.Server（AIOS 核心的作法）：只接 /duck-link 的 WebSocket 升級，其他路徑的升級一律 404。
   * hosts＝允許的 Host 標頭（AIOS 的 allowedHosts()）；不給時只看主機名稱是 127.0.0.1 或 localhost。
   * 這個方法不呼叫 listen，也不改 server 綁的位址——綁 loopback 是呼叫端的責任。
   */
  attach(server: Server, options: { hosts?: ReadonlySet<string> } = {}): void {
    if (this.wss) throw new Error("hub 已經啟動");
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(wss, req, socket, head, options.hosts);
    server.on("upgrade", onUpgrade);
    this.wss = wss;
    this.detach = () => server.off("upgrade", onUpgrade);
  }

  /** 獨立執行（開發用的 hub 行程）：自己開一個只聽 127.0.0.1 的 http server（沒有選項可以改成別的位址）。回傳實際的埠號。 */
  async start(): Promise<number> {
    if (this.http || this.wss) throw new Error("hub 已經啟動");
    const http = createServer((_req, res) => {
      // 這個埠只提供 duck-link 的 WebSocket；一般 HTTP 請求一律 404，不提供任何狀態頁。
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
    });
    this.attach(http);
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.requestedPort, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
    this.http = http;
    return this.port;
  }

  get port(): number {
    const address = this.http?.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  /** 結束：關掉鴨子的連線、拿掉 upgrade 監聽；自己開的 http server 也一併關閉（掛在別人 server 上時不關它）。 */
  async stop(): Promise<void> {
    this.dropDuck("shutdown", CLOSE.shutdown);
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    this.detach?.();
    this.detach = null;
    const http = this.http;
    this.http = null;
    this.wss = null;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  // ---- 連線 ----

  private onUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, hosts?: ReadonlySet<string>): void {
    const refuse = (code: number, text: string) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const path = (req.url ?? "").split("?")[0];
    if (path !== DUCK_LINK_PATH) return refuse(404, "Not Found");
    // 鴨子不是瀏覽器，不會帶 Origin；帶 Origin 的是網頁（跨站 WebSocket），拒絕。
    if (req.headers.origin !== undefined) return refuse(403, "Forbidden");
    const hostHeader = req.headers.host ?? "";
    const host = hostHeader.replace(/:\d+$/, "");
    if (hosts ? !hosts.has(hostHeader) : host !== "127.0.0.1" && host !== "localhost") return refuse(403, "Forbidden");
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return refuse(403, "Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    this.counters.connections += 1;
    let ready = false;
    const helloTimer = setTimeout(() => {
      this.log("連線後沒有收到 hello，關閉");
      ws.close(CLOSE.badHello, "hello timeout");
    }, this.helloTimeoutMs);

    this.transmit(ws, { protocol_version: PROTOCOL_VERSION, type: "hello", sent_at_ms: this.now(), role: "nous", software: this.software });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        this.counters.rxInvalid += 1;
        return;
      }
      const text = raw.toString();
      const result = this.validator.parse(text);
      if (!result.ok) {
        this.counters.rxInvalid += 1;
        // 主版本不合：拒絕並回報，不猜測（duck-link 的設計原則）。
        const version = peekVersion(text);
        if (version !== null && version !== PROTOCOL_VERSION) {
          this.log(`協定版本不合（對方 ${version.slice(0, 16)}，這裡 ${PROTOCOL_VERSION}），關閉連線`);
          ws.close(CLOSE.version, "protocol version mismatch");
          return;
        }
        this.log(`收到不合 schema 的訊息，已丟棄：${result.errors.join("；")}`);
        if (!ready) ws.close(CLOSE.badHello, "first message must be a valid hello");
        return;
      }
      const message = result.message;
      if (!ready) {
        if (message.type !== "hello" || message.role !== "duck") {
          ws.close(CLOSE.badHello, "first message must be hello with role duck");
          return;
        }
        clearTimeout(helloTimer);
        ready = true;
        this.adopt(ws, message);
        return;
      }
      if (ws !== this.duck) return;
      this.lastRxAt = this.now();
      switch (message.type) {
        case "heartbeat":
          if (message.echo_of !== undefined) {
            const sent = this.heartbeatSent.get(message.echo_of);
            if (sent !== undefined) this.rttMs = Math.max(0, this.now() - sent);
          }
          break;
        case "ack":
          this.onAck(message);
          break;
        case "state":
          this.state = message;
          this.stateAt = this.now();
          this.observe({ seq: ++this.rxSeq, at: this.stateAt, kind: "state", state: message });
          for (const l of this.stateListeners) l(message);
          break;
        case "event":
          if (this.seenEvents.includes(message.event_id)) {
            this.counters.duplicateEvents += 1;
            break;
          }
          this.seenEvents.push(message.event_id);
          if (this.seenEvents.length > 256) this.seenEvents.shift();
          this.observe({ seq: ++this.rxSeq, at: this.now(), kind: "event", event: message });
          for (const l of this.eventListeners) l(message);
          break;
        case "hello":
          // 鴨子重送 hello（例如能力改變）：更新紀錄。
          if (message.role === "duck") this.hello = message;
          break;
        case "command":
          // 指令只有 Nous → 鴨子一個方向。
          this.counters.rxInvalid += 1;
          break;
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (ws === this.duck) this.dropDuck("closed");
    });
    ws.on("error", (error) => this.log(`連線錯誤：${error.message}`));
  }

  private adopt(ws: WebSocket, hello: HelloMessage): void {
    // 同一時間只有一隻鴨子。新的連線完成 hello 就取代舊的（鴨子重連時舊連線可能還沒被發現已斷）。
    if (this.duck) this.dropDuck("replaced", CLOSE.replaced);
    this.duck = ws;
    this.hello = hello;
    this.connectedAt = this.now();
    this.lastRxAt = this.connectedAt;
    this.rttMs = null;
    this.heartbeatSent.clear();
    this.heartbeat = setInterval(() => this.beat(), this.heartbeatMs);
    this.beat();
    this.log(`鴨子已連線：${hello.software}${hello.mock ? "（mock）" : ""}`);
    for (const l of this.linkListeners) l({ up: true, hello });
  }

  private beat(): void {
    const ws = this.duck;
    if (!ws) return;
    const now = this.now();
    if (now - this.lastRxAt > this.staleMs) {
      this.log(`超過 ${this.staleMs} ms 沒有收到鴨子的訊息，關閉連線`);
      this.dropDuck("stale", CLOSE.stale);
      return;
    }
    const seq = ++this.heartbeatSeq;
    this.heartbeatSent.set(seq, now);
    if (this.heartbeatSent.size > 16) this.heartbeatSent.delete(this.heartbeatSent.keys().next().value!);
    this.transmit(ws, { protocol_version: PROTOCOL_VERSION, type: "heartbeat", sent_at_ms: now, seq });
  }

  private dropDuck(reason: string, code?: number): void {
    const ws = this.duck;
    if (!ws) return;
    this.duck = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.connectedAt = null;
    this.rttMs = null;
    if (code !== undefined && ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    else if (ws.readyState === WebSocket.OPEN) ws.terminate();
    for (const [requestId, p] of [...this.pending]) {
      this.pending.delete(requestId);
      p.cleanup();
      p.resolve({ kind: "link_lost", requestId, sentSeq: p.sentSeq });
    }
    for (const w of [...this.waiters]) w.finish("link_lost");
    this.log(`鴨子連線結束（${reason}）`);
    for (const l of this.linkListeners) l({ up: false, reason });
  }

  private transmit(ws: WebSocket, message: Record<string, unknown>): boolean {
    const check = this.validator.validate(message);
    if (!check.ok) {
      this.counters.txInvalid += 1;
      this.log(`要送出的訊息不合 schema，沒有送出：${check.errors.join("；")}`);
      return false;
    }
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  // ---- 指令與回讀 ----

  sendCommand(action: DuckAction, params: Record<string, unknown> | undefined, options: SendOptions): Promise<CommandOutcome> {
    const ws = this.duck;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ kind: "not_sent", why: "not_connected" });
    const requestId = options.requestId && REQUEST_ID.test(options.requestId) && !this.pending.has(options.requestId) ? options.requestId : `req_${randomUUID().replaceAll("-", "")}`;
    const command: CommandMessage = {
      protocol_version: PROTOCOL_VERSION,
      type: "command",
      sent_at_ms: this.now(),
      request_id: requestId,
      action,
      ttl_ms: options.ttlMs,
      ...(params && Object.keys(params).length ? { params } : {}),
    };
    const check = this.validator.validate(command);
    if (!check.ok) {
      this.counters.txInvalid += 1;
      return Promise.resolve({ kind: "not_sent", why: "invalid", errors: check.errors });
    }
    if (options.signal?.aborted) return Promise.resolve({ kind: "not_sent", why: "aborted" });
    const sentSeq = this.rxSeq;
    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        cleanup();
        resolve({ kind: "no_ack", requestId, sentSeq });
      }, options.ackTimeoutMs);
      const onAbort = () => {
        this.pending.delete(requestId);
        cleanup();
        resolve({ kind: "aborted", requestId, sentSeq });
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, { resolve, sentSeq, sentAt: this.now(), cleanup });
      this.counters.commands += 1;
      ws.send(JSON.stringify(command));
    });
  }

  private onAck(ack: AckMessage): void {
    const p = this.pending.get(ack.request_id);
    if (!p) {
      // 逾時後才到的 ack，或不認得的 request_id：只計數。
      this.counters.unmatchedAcks += 1;
      return;
    }
    this.pending.delete(ack.request_id);
    p.cleanup();
    p.resolve({ kind: "ack", ack, requestId: ack.request_id, sentSeq: p.sentSeq, ackSeq: this.rxSeq, rttMs: Math.max(0, this.now() - p.sentAt) });
  }

  private observe(observation: Observation): void {
    this.recent.push(observation);
    if (this.recent.length > RECENT) this.recent.shift();
    for (const w of [...this.waiters]) if (w.match(observation)) w.finish(observation);
  }

  waitFor(match: (o: Observation) => boolean, options: { sinceSeq: number; timeoutMs: number; signal?: AbortSignal }): Promise<WaitResult> {
    const already = this.recent.find((o) => o.seq > options.sinceSeq && match(o));
    if (already) return Promise.resolve(already);
    if (!this.duck) return Promise.resolve("link_lost");
    if (options.signal?.aborted) return Promise.resolve("aborted");
    return new Promise<WaitResult>((resolve) => {
      const waiter: Waiter = {
        match,
        finish: (result) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          this.waiters.delete(waiter);
          resolve(result);
        },
      };
      const timer = setTimeout(() => waiter.finish("timeout"), options.timeoutMs);
      const onAbort = () => waiter.finish("aborted");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  snapshot(): LinkSnapshot {
    return {
      connected: this.duck !== null,
      hello: this.hello,
      state: this.state,
      stateAt: this.stateAt,
      rttMs: this.rttMs,
      connectedAt: this.connectedAt,
      counters: { ...this.counters },
    };
  }

  /** 目前的接收序號（之後收到的 state／event 的 seq 都比它大）。 */
  get seq(): number {
    return this.rxSeq;
  }

  onState(listener: (state: StateMessage) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: (event: EventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onLink(listener: (change: LinkChange) => void): () => void {
    this.linkListeners.add(listener);
    return () => this.linkListeners.delete(listener);
  }
}

function peekVersion(text: string): string | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && typeof (value as Record<string, unknown>).protocol_version === "string") return (value as Record<string, string>).protocol_version!;
  } catch {
    // 不是 JSON
  }
  return null;
}
