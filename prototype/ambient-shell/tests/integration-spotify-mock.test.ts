import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../server/config.ts";
import { readAuthState, SpotifySoloistAdapter, type SoloistSocket } from "../server/integrations/adapters/spotify-soloist.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { buildRealtimeTools } from "../server/realtime.ts";
import { setLocale } from "../src/i18n.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

// SP-1：Spotify Soloist 本機健康狀態。這裡沒有 Pi、沒有 Soloist、沒有 Spotify 帳號：
// 一部分用注入的假 WebSocket，一部分用本機 Node HTTP upgrade 寫的假 Soloist WebSocket 伺服器（fixture）；
// 訊息格式照官方 WebSocket API 文件的 auth_state（2026-11-03 查核），歌名、裝置名都是虛構的。

const AUTH = (logged_in: unknown, is_active: unknown) => JSON.stringify({ type: "auth_state", logged_in, is_active, device_name: "Fixture Speaker" });
const PLAYBACK = JSON.stringify({ type: "playback_state", status: "playing", item: { name: "FIXTURE-TRACK-NAME" }, context: { name: "FIXTURE-PLAYLIST" } });

describe("readAuthState", () => {
  it("only reads the two booleans of auth_state", () => {
    expect(readAuthState(AUTH(true, true))).toEqual({ health: "available", reason: "ok" });
    expect(readAuthState(AUTH(true, false))).toEqual({ health: "unavailable", reason: "taken_over" });
    expect(readAuthState(AUTH(false, false))).toEqual({ health: "unavailable", reason: "not_ready" });
    expect(readAuthState(AUTH("yes", true))).toEqual({ health: "unknown", reason: "bad_reply" });
    expect(readAuthState(PLAYBACK)).toBeNull();
    expect(readAuthState("not json")).toBeNull();
    expect(readAuthState(`{"type":"auth_state","logged_in":true,"is_active":true,"pad":"${"x".repeat(5000)}"}`)).toBeNull();
    expect(readAuthState(new Uint8Array([1, 2]))).toBeNull();
  });
});

/** 注入的假 WebSocket：記錄網址與送出的訊息，依腳本觸發事件。 */
function fakeSocket(script: (s: { emit: (type: string, data?: unknown) => void }) => void) {
  const created: { url: string; sent: string[]; closed: boolean }[] = [];
  class Fake implements SoloistSocket {
    private readonly listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
    readonly record: { url: string; sent: string[]; closed: boolean };
    constructor(url: string) {
      this.record = { url, sent: [], closed: false };
      created.push(this.record);
      queueMicrotask(() => script({ emit: (type, data) => this.listeners.get(type)?.forEach((l) => l({ data })) }));
    }
    send(data: string) {
      this.record.sent.push(data);
    }
    close() {
      this.record.closed = true;
    }
    addEventListener(type: string, listener: (e: { data?: unknown }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
  }
  return { Fake, created };
}

describe("SpotifySoloistAdapter (injected fake WebSocket)", () => {
  const signal = () => new AbortController().signal;

  it("connects only to ws://127.0.0.1:<configured port>, sends only get_auth_state, and ignores playback content", async () => {
    const { Fake, created } = fakeSocket((s) => {
      s.emit("open");
      s.emit("message", PLAYBACK);
      s.emit("message", AUTH(true, true));
    });
    const adapter = new SpotifySoloistAdapter({ port: 19090, WebSocket: Fake });
    const report = await adapter.health(signal());
    expect(report).toEqual({ health: "available", reason: "ok" });
    expect(created).toEqual([{ url: "ws://127.0.0.1:19090", sent: ['{"type":"command","command":"get_auth_state"}'], closed: true }]);
    expect(JSON.stringify(report)).not.toMatch(/FIXTURE|Fixture Speaker/);
  });

  it("has no model tools and refuses execution (SP-2 blocked)", async () => {
    const adapter = new SpotifySoloistAdapter();
    expect(adapter.tools()).toEqual([]);
    expect(await adapter.execute()).toMatchObject({ ok: false, status: "refused" });
  });

  it("error before open → unavailable; close after open → unknown; silence → unknown timeout; abort → unknown", async () => {
    const refused = fakeSocket((s) => { s.emit("error"); s.emit("close"); });
    expect(await new SpotifySoloistAdapter({ WebSocket: refused.Fake }).health(signal())).toEqual({ health: "unavailable", reason: "connection_refused" });
    const dropped = fakeSocket((s) => { s.emit("open"); s.emit("close"); });
    expect(await new SpotifySoloistAdapter({ WebSocket: dropped.Fake }).health(signal())).toEqual({ health: "unknown", reason: "connection_closed" });
    const silent = fakeSocket((s) => s.emit("open"));
    expect(await new SpotifySoloistAdapter({ WebSocket: silent.Fake, timeoutMs: 30 }).health(signal())).toEqual({ health: "unknown", reason: "timeout" });
    expect(silent.created[0]!.closed).toBe(true);
    const controller = new AbortController();
    const pending = new SpotifySoloistAdapter({ WebSocket: silent.Fake, timeoutMs: 5_000 }).health(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ health: "unknown", reason: "timeout" });
    const throws = class { constructor() { throw new Error("bad"); } } as unknown as typeof refused.Fake;
    expect(await new SpotifySoloistAdapter({ WebSocket: throws }).health(signal())).toEqual({ health: "unavailable", reason: "connection_refused" });
    // 執行環境沒有 WebSocket：是 Nous 這邊的問題，不說成 Pi 離線。
    vi.stubGlobal("WebSocket", undefined);
    try {
      expect(await new SpotifySoloistAdapter().health(signal())).toEqual({ health: "unknown", reason: "error" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects ports outside 1024–65535 (config and constructor)", () => {
    expect(() => new SpotifySoloistAdapter({ port: 80 })).toThrow();
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "spotify_soloist" }).ail).toEqual({ enabled: true, services: ["spotify_soloist"], soloistPort: 19090 });
    expect(loadConfig({ NOUS_AIL: "on", NOUS_SPOTIFY_SOLOIST_PORT: "29090" }).ail.soloistPort).toBe(29090);
    expect(() => loadConfig({ NOUS_AIL: "on", NOUS_SPOTIFY_SOLOIST_PORT: "ws://10.0.0.5:9090" })).toThrow(/NOUS_SPOTIFY_SOLOIST_PORT/);
    expect(() => loadConfig({ NOUS_AIL: "on", NOUS_SPOTIFY_SOLOIST_PORT: "22" })).toThrow(/NOUS_SPOTIFY_SOLOIST_PORT/);
  });
});

// ── 本機假 Soloist WebSocket 伺服器（RFC 6455 握手＋未遮罩的文字框，只送不收） ──

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

async function fakeSoloist(messages: string[]): Promise<{ server: Server; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("close", () => sockets.forEach((s) => s.destroy()));
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    const key = String(req.headers["sec-websocket-key"]);
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (chunk: Buffer) => received.push(chunk.toString("hex").slice(0, 4)));
    socket.on("error", () => undefined);
    for (const m of messages) socket.write(wsFrame(m));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, received };
}

describe("SpotifySoloistAdapter against a local fake Soloist WebSocket server (Node global WebSocket)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.emit("close"); })));
  });

  it("logged in and active → available; logged out → unavailable; playback events are skipped", async () => {
    const ok = await fakeSoloist([PLAYBACK, AUTH(true, true)]);
    servers.push(ok.server);
    expect(await new SpotifySoloistAdapter({ port: ok.port }).health(new AbortController().signal)).toEqual({ health: "available", reason: "ok" });
    const out = await fakeSoloist([AUTH(false, false)]);
    servers.push(out.server);
    expect(await new SpotifySoloistAdapter({ port: out.port }).health(new AbortController().signal)).toEqual({ health: "unavailable", reason: "not_ready" });
  });

  it("nothing listening (Pi offline / tunnel down / Soloist stopped or expired) → unavailable connection_refused", async () => {
    const probe = await fakeSoloist([]);
    const port = probe.port;
    await new Promise<void>((r) => probe.server.close(() => r()));
    expect(await new SpotifySoloistAdapter({ port }).health(new AbortController().signal)).toEqual({ health: "unavailable", reason: "connection_refused" });
  });
});

describe("SP-1 through the integration layer", () => {
  it("registers with zero model tools; nothing Spotify reaches the model's tool list; status shows the real check", async () => {
    const ail = createIntegrations({ enabled: true, services: ["spotify_soloist"], soloistPort: 19090 }, () => undefined, {
      spotify_soloist: () => new SpotifySoloistAdapter({ WebSocket: fakeSocket((s) => { s.emit("open"); s.emit("message", AUTH(true, false)); }).Fake }),
    })!;
    expect(ail.registry.listTools("api_key")).toEqual([]);
    expect(ail.registry.listTools("live")).toEqual([]);
    const tools = buildRealtimeTools({ webSearch: true, mcp: [], home: true, integrations: (l) => ail.registry.functionSpecs("api_key", l) });
    expect(JSON.stringify(tools)).not.toMatch(/spotify/i);
    expect(await ail.dispatcher.execute({ tool: "app__spotify__play", args: {}, route: "api_key", actor: "agent", sessionId: "s" })).toMatchObject({ status: "refused", reason: "not_registered" });
    expect((await ail.status.view()).services).toEqual([{ service: "spotify_soloist", mock: false, health: "unavailable", reason: "taken_over", checked_at: expect.any(Number), model_tools: 0 }]);
  });
});

// ── 設定頁「App 整合」段（假 DOM） ──

class El {
  children: (El | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  value = "";
  innerHTML = "";
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  append(...n: (El | string)[]) { this.children.push(...n); }
  replaceChildren(...n: (El | string)[]) { this.children = n; }
  addEventListener(type: string, cb: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
  get textContent(): string { return this.children.map((n) => (typeof n === "string" ? n : n.textContent)).join(""); }
  set textContent(v: string) { this.children = [v]; }
  all(): El[] { return this.children.flatMap((n) => (typeof n === "string" ? [] : [n, ...n.all()])); }
}

describe("settings: on-demand App integration status (zh-TW and en)", () => {
  let views: typeof import("../src/views.ts");
  beforeAll(async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
    views = await import("../src/views.ts");
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    setLocale("zh-TW");
  });

  const state = (health: "available" | "unavailable" | "unknown", reason: "ok" | "connection_refused" | "taken_over" | "timeout") => ({
    view: { services: [{ service: "spotify_soloist", mock: false, health, reason, checked_at: 1_793_000_000_000, model_tools: 0 }] },
    loading: false,
    error: false,
  });

  it("renders the real health in both languages and a re-check button", () => {
    let refreshed = 0;
    const actions = { refreshIntegrations: () => void refreshed++ } as never;
    setLocale("zh-TW");
    const zh = views.renderIntegrationStatus(state("unavailable", "connection_refused"), actions) as unknown as El;
    expect(zh.textContent).toContain("Pi 上的 Spotify 播放器");
    expect(zh.textContent).toContain("不可用：連不上（Pi 離線、SSH 通道中斷、Soloist 沒有執行或版本已過期）");
    expect(zh.textContent).toContain("Spotify 語音控制沒有取得授權");
    zh.all().find((e) => e.tagName === "button")!.listeners.get("click")!.forEach((cb) => cb());
    expect(refreshed).toBe(1);
    setLocale("en");
    const en = views.renderIntegrationStatus(state("available", "ok"), actions) as unknown as El;
    expect(en.textContent).toContain("Spotify player on the Pi");
    expect(en.textContent).toContain("Available: Connected");
    expect(en.textContent).toContain("Spotify voice control is not authorized");
    expect(en.getAttribute("aria-label")).toBe("App integrations");
    const unknown = views.renderIntegrationStatus(state("unknown", "timeout"), actions) as unknown as El;
    expect(unknown.textContent).toContain("Status unknown: No reply within the time limit");
    expect(unknown.textContent).not.toContain("Available");
    const failed = views.renderIntegrationStatus({ view: null, loading: false, error: true }, actions) as unknown as El;
    expect(failed.textContent).toContain("Could not get the integration status");
  });
});
