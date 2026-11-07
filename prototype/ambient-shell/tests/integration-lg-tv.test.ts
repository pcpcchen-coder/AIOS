import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig } from "../server/config.ts";
import { LgTvAdapter, powerOf, TV_TEXT, TV_TOOL } from "../server/integrations/adapters/lg-tv.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { liveCallerTools } from "../server/live-tool-caller.ts";
import { buildRealtimeTools, INTEGRATION_RULE, realtimeToolRules, TV_RULE, voiceVolumeRule } from "../server/realtime.ts";
import { inputOfApp, resolveApp, resolveInput } from "../server/lgtv/apps.ts";
import { connectSsap, SsapLost, SsapPairingRequired, SsapRejected, SsapUnreachable } from "../server/lgtv/ssap.ts";
import { pairingFile, readPairing, removePairing, writePairing } from "../server/lgtv/store.ts";
import { magicPacket, normalizeMac } from "../server/lgtv/wol.ts";
import type { ExecutionContext } from "../server/integrations/contracts.ts";
import type { IntegrationToolId } from "../shared/integrations.ts";

// LGTV-1：雲端沒有電視。這裡用 ws 起一台「假的 webOS 電視」（fixture，只模擬 SSAP 訊息），不是實機驗證。

const KEY = "FAKE-CLIENT-KEY-0123";
const HOST = "192.168.1.50";
const MAC = "a8:23:fe:12:34:56";

interface FakeTvOptions {
  power?: string;
  app?: string;
  volume?: number;
  muted?: boolean;
  /** setVolume 不生效（接聲霸時讀不到）。 */
  ignoreVolume?: boolean;
  /** launch／switchInput 不改前景 App。 */
  ignoreLaunch?: boolean;
  /** 收到 turnOff 不理會。 */
  ignoreOff?: boolean;
  /** 收到這個 uri 時直接斷線。 */
  dropOn?: string;
  /** 對這個 uri 回 returnValue false。 */
  rejectUri?: string;
  /** volumeUp 前幾次成功，之後被拒。 */
  volumeUpOkTimes?: number;
  /** 收到 turnOn 後變成 Active。 */
  wakeOnTurnOn?: boolean;
}

const LAUNCH_POINTS = [
  { id: "youtube.leanback.v4", title: "YouTube" },
  { id: "netflix", title: "Netflix" },
  { id: "com.disney.disneyplus-prod", title: "Disney+" },
  { id: "spotify-beehive", title: "Spotify - Music and Podcasts" },
  { id: "com.linecorp.linetv", title: "LINE TV" },
];

class FakeTv {
  server: WebSocketServer | null = null;
  port = 0;
  power: string;
  app: string;
  volume: number;
  muted: boolean;
  requests: { uri: string; payload: Record<string, unknown> }[] = [];
  registers = 0;
  constructor(readonly o: FakeTvOptions = {}) {
    this.power = o.power ?? "Active";
    this.app = o.app ?? "com.webos.app.home";
    this.volume = o.volume ?? 12;
    this.muted = o.muted ?? false;
  }
  async start(port = 0): Promise<this> {
    this.server = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((r) => this.server!.once("listening", () => r()));
    this.port = (this.server.address() as { port: number }).port;
    this.server.on("connection", (ws) => this.handle(ws));
    return this;
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    for (const c of this.server.clients) c.terminate();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }
  get url() {
    return `ws://127.0.0.1:${this.port}`;
  }
  uris() {
    return this.requests.map((r) => r.uri);
  }
  private handle(ws: WebSocket) {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      const send = (v: unknown) => ws.send(JSON.stringify(v));
      if (m.type === "hello") return send({ type: "hello", id: m.id, payload: { protocolVersion: 1 } });
      if (m.type === "register") {
        this.registers++;
        if (m.payload["client-key"] !== KEY) {
          send({ type: "response", id: m.id, payload: { pairingType: "PROMPT", returnValue: true } });
          // 模擬使用者在電視上按「允許」。
          setTimeout(() => ws.readyState === 1 && send({ type: "registered", id: m.id, payload: { "client-key": KEY } }), 20);
          return;
        }
        return send({ type: "registered", id: m.id, payload: { "client-key": KEY } });
      }
      const uri = String(m.uri ?? "").replace(/^ssap:\/\//, "");
      const payload = m.payload ?? {};
      if (m.id !== "pre_sysinfo") this.requests.push({ uri, payload });
      if (this.o.dropOn === uri) return ws.terminate();
      if (this.o.rejectUri === uri) return send({ type: "response", id: m.id, payload: { returnValue: false, errorText: "nope" } });
      const ok = (extra: Record<string, unknown> = {}) => send({ type: "response", id: m.id, payload: { returnValue: true, ...extra } });
      switch (uri) {
        case "system/getSystemInfo":
          return ok({ modelName: "OLED65G3PTA" });
        case "com.webos.service.tvpower/power/getPowerState":
          return ok({ state: this.power });
        case "com.webos.applicationManager/getForegroundAppInfo":
          return ok({ appId: this.app });
        case "com.webos.applicationManager/listLaunchPoints":
          return ok({ launchPoints: LAUNCH_POINTS });
        case "audio/getVolume":
          return ok({ volumeStatus: { volume: this.volume, muteStatus: this.muted } });
        case "audio/setVolume":
          if (!this.o.ignoreVolume) this.volume = payload.volume;
          return ok();
        case "audio/volumeUp":
          if (this.o.volumeUpOkTimes !== undefined && this.requests.filter((r) => r.uri === uri).length > this.o.volumeUpOkTimes) return send({ type: "response", id: m.id, payload: { returnValue: false } });
          if (!this.o.ignoreVolume) this.volume = Math.min(100, this.volume + 1);
          return ok();
        case "audio/volumeDown":
          if (!this.o.ignoreVolume) this.volume = Math.max(0, this.volume - 1);
          return ok();
        case "audio/setMute":
          this.muted = payload.mute;
          return ok();
        case "tv/getExternalInputList":
          return ok({ devices: [{ id: "HDMI_1", label: "HDMI 1", appId: "com.webos.app.hdmi1", connected: true }, { id: "HDMI_2", label: "Apple TV", appId: "com.webos.app.hdmi2", connected: true }] });
        case "tv/switchInput":
          if (!this.o.ignoreLaunch) this.app = `com.webos.app.${String(payload.inputId).toLowerCase().replace("_", "")}`;
          return ok();
        case "system.launcher/launch":
          if (!this.o.ignoreLaunch) this.app = payload.id;
          return ok({ id: payload.id });
        case "system/turnOn":
          if (this.o.wakeOnTurnOn) this.power = "Active";
          return ok();
        case "system/turnOff":
          if (this.o.ignoreOff) return ok();
          // 真的電視關機時會直接斷線、不再接受連線。
          void this.stop();
          return;
        case "com.webos.service.connectionmanager/getinfo":
          return ok({ wifiInfo: { state: "connected", macAddress: "A8-23-FE-12-34-56" } });
        default:
          return ok();
      }
    });
  }
}

const dirs: string[] = [];
const tvs: FakeTv[] = [];
afterEach(async () => {
  while (tvs.length) await tvs.pop()!.stop();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "lgtv-"));
  dirs.push(d);
  return d;
}

function paired(host = HOST, macs: string[] = [MAC]) {
  const file = pairingFile(tempDir());
  writePairing(file, { version: 1, host, client_key: KEY, macs, paired_at: "2026-11-07T00:00:00Z" });
  return file;
}

async function tv(o: FakeTvOptions = {}) {
  const t = await new FakeTv(o).start();
  tvs.push(t);
  return t;
}

/** 一個沒有人在聽的埠（連線會被拒）。 */
async function deadUrl() {
  const t = await new FakeTv().start();
  const url = t.url;
  await t.stop();
  return url;
}

const FAST = { connectMs: 500, wakeWaitMs: 1_000, pollMs: 20, offWaitMs: 400, appWaitMs: 300, standbyWaitMs: 300, stepMs: 1 };

function adapter(urls: string[], extra: Partial<ConstructorParameters<typeof LgTvAdapter>[0]> = {}) {
  return new LgTvAdapter({ host: HOST, pairingFile: paired(), urls, timing: FAST, wol: async () => undefined, ...extra });
}

const ctx = (): ExecutionContext => ({ actor: "agent", route: "api_key", sessionId: "s", requestId: "r", signal: new AbortController().signal });
const run = (a: LgTvAdapter, tool: IntegrationToolId, args: Record<string, unknown> = {}) => a.execute(tool, args, ctx());

describe("LGTV-1 SSAP 用戶端（假電視）", () => {
  it("配對：允許提示時等使用者按「允許」並拿到金鑰；一般呼叫遇到提示立刻停", async () => {
    const t = await tv();
    let prompted = false;
    const s = await connectSsap({ host: HOST, clientKey: null, urls: [t.url], allowPrompt: true, onPrompt: () => (prompted = true) });
    expect(prompted).toBe(true);
    expect(s.clientKey).toBe(KEY);
    s.close();
    await expect(connectSsap({ host: HOST, clientKey: "wrong", urls: [t.url] })).rejects.toBeInstanceOf(SsapPairingRequired);
    await expect(connectSsap({ host: HOST, clientKey: null, urls: [t.url] })).rejects.toBeInstanceOf(SsapPairingRequired);
  });

  it("連不上、電視拒絕、送出後斷線各是不同的錯誤", async () => {
    await expect(connectSsap({ host: HOST, clientKey: KEY, urls: [await deadUrl()], connectTimeoutMs: 300 })).rejects.toBeInstanceOf(SsapUnreachable);
    const t = await tv({ rejectUri: "audio/setMute", dropOn: "audio/setVolume" });
    const s = await connectSsap({ host: HOST, clientKey: KEY, urls: [t.url] });
    await expect(s.request("audio/setMute", { mute: true })).rejects.toBeInstanceOf(SsapRejected);
    await expect(s.request("audio/setVolume", { volume: 5 })).rejects.toBeInstanceOf(SsapLost);
    s.close();
  });

  it("握手期間 socket 出錯（壞封包）只讓連線失敗，不會讓核心崩潰", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    server.on("connection", (ws) => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ type: "hello", id: "hello", payload: {} }));
        // 寫一個不合法的 WebSocket 封包（opcode 15）。
        (ws as unknown as { _socket: import("node:net").Socket })._socket.write(Buffer.from([0x8f, 0x00]));
      });
    });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const port = (server.address() as { port: number }).port;
      await expect(connectSsap({ host: HOST, clientKey: KEY, urls: [`ws://127.0.0.1:${port}`], connectTimeoutMs: 500 })).rejects.toBeInstanceOf(SsapUnreachable);
      await new Promise((r) => setTimeout(r, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      for (const c of server.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("同一個封包裡的多則訊息、順序顛倒的回覆都照 id 取", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    server.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "hello") ws.send(JSON.stringify({ type: "hello", id: "hello", payload: {} }));
        // 系統資訊不回；註冊時才一次送：先註冊結果，再送晚到的系統資訊。
        if (m.type === "register") {
          ws.send(JSON.stringify({ type: "registered", id: "register_0", payload: { "client-key": KEY } }));
          ws.send(JSON.stringify({ type: "response", id: "pre_sysinfo", payload: { returnValue: true } }));
        }
      });
    });
    try {
      const port = (server.address() as { port: number }).port;
      const s = await connectSsap({ host: HOST, clientKey: KEY, urls: [`ws://127.0.0.1:${port}`], connectTimeoutMs: 300 });
      expect(s.clientKey).toBe(KEY);
      s.close();
    } finally {
      for (const c of server.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("第一個網址連不上時改試下一個（wss:3001 → ws:3000）", async () => {
    const t = await tv();
    const s = await connectSsap({ host: HOST, clientKey: KEY, urls: [await deadUrl(), t.url], connectTimeoutMs: 300 });
    expect(s.isOpen).toBe(true);
    s.close();
  });
});

describe("LGTV-1 配對檔、MAC、名稱解析", () => {
  it("配對檔是 0600；看不懂的檔案當成沒有配對；可以刪除", () => {
    const file = paired();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readPairing(file)?.client_key).toBe(KEY);
    writeFileSync(file, "{oops");
    expect(readPairing(file)).toBeNull();
    expect(removePairing(file)).toBe(true);
    expect(removePairing(file)).toBe(false);
  });

  it("MAC 與 magic packet", () => {
    expect(normalizeMac("A8-23-FE-12-34-56")).toBe(MAC);
    expect(normalizeMac("a823fe123456")).toBe(MAC);
    expect(normalizeMac("zz")).toBeNull();
    const p = magicPacket(MAC);
    expect(p.length).toBe(102);
    expect(p.subarray(0, 6).every((b) => b === 0xff)).toBe(true);
    expect(p.subarray(96).toString("hex")).toBe("a823fe123456");
  });

  it("App 與輸入源名稱", () => {
    expect(resolveApp("網飛", LAUNCH_POINTS)?.id).toBe("netflix");
    expect(resolveApp("youtube", LAUNCH_POINTS)?.id).toBe("youtube.leanback.v4");
    expect(resolveApp("Disney Plus", LAUNCH_POINTS)?.id).toBe("com.disney.disneyplus-prod");
    expect(resolveApp("line tv", LAUNCH_POINTS)?.id).toBe("com.linecorp.linetv");
    expect(resolveApp("Prime Video", LAUNCH_POINTS)).toBeNull(); // 沒裝就不開
    const devices = [{ id: "HDMI_1", label: "HDMI 1", appId: null, connected: true }, { id: "HDMI_2", label: "Apple TV", appId: null, connected: true }];
    expect(resolveInput("hdmi 2", devices)?.id).toBe("HDMI_2");
    expect(resolveInput("2", devices)?.id).toBe("HDMI_2");
    expect(resolveInput("apple tv", devices)?.id).toBe("HDMI_2");
    expect(resolveInput("HDMI_3", devices)).toBeNull();
    expect(inputOfApp("com.webos.app.hdmi3")).toBe("HDMI_3");
    expect(powerOf("Active Standby")).toBe("standby");
    expect(powerOf("Screen Off")).toBe("screen_off");
  });
});

describe("LGTV-1 Adapter（假電視，誠實狀態）", () => {
  it("沒有配對或配對的 IP 不同 → refused，不連電視", async () => {
    const t = await tv();
    const none = new LgTvAdapter({ host: HOST, pairingFile: join(tempDir(), "lgtv.json"), urls: [t.url], timing: FAST });
    expect(await run(none, TV_TOOL.status)).toMatchObject({ status: "refused", message: TV_TEXT.notPaired });
    const other = new LgTvAdapter({ host: HOST, pairingFile: paired("192.168.1.99"), urls: [t.url], timing: FAST });
    expect((await run(other, TV_TOOL.volume, { action: "up" })).status).toBe("refused");
    expect(t.registers).toBe(0);
    expect((await none.health(new AbortController().signal)).reason).toBe("not_paired");
  });

  it("狀態：開著時回 App 名稱、輸入源、音量與靜音；連不上時照實說", async () => {
    const t = await tv({ app: "netflix", volume: 20, muted: true });
    const r = await run(adapter([t.url]), TV_TOOL.status);
    expect(r).toMatchObject({ ok: true, status: "confirmed", data: { reachable: true, power: "on", app: { id: "netflix", title: "Netflix" }, input: null, volume: 20, muted: true } });
    const off = await run(adapter([await deadUrl()]), TV_TOOL.status);
    expect(off).toMatchObject({ status: "confirmed", data: { reachable: false } });
    const standby = await tv({ power: "Active Standby" });
    expect((await run(adapter([standby.url]), TV_TOOL.status)).data).toEqual({ reachable: true, power: "standby" });
  });

  it("開機：已開著 → confirmed；待機（Quick Start+）用 turnOn；連不上用網路喚醒，電視上線才 confirmed", async () => {
    const on = await tv();
    expect(await run(adapter([on.url]), TV_TOOL.power, { state: "on" })).toMatchObject({ status: "confirmed", message: TV_TEXT.alreadyOn });

    const standby = await tv({ power: "Active Standby", wakeOnTurnOn: true });
    expect(await run(adapter([standby.url]), TV_TOOL.power, { state: "on" })).toMatchObject({ status: "confirmed", data: { method: "ssap" } });

    // 網路喚醒：收到封包才把假電視啟動起來。
    const sleeping = new FakeTv();
    tvs.push(sleeping);
    const port = Number((await deadUrl()).split(":").pop());
    const wols: string[] = [];
    const a = adapter([`ws://127.0.0.1:${port}`], {
      wol: async (mac) => {
        wols.push(mac);
        if (!sleeping.server) await sleeping.start(port);
      },
    });
    expect(await run(a, TV_TOOL.power, { state: "on" })).toMatchObject({ status: "confirmed", data: { method: "wake_on_lan", turned_on: true } });
    expect(wols[0]).toBe(MAC);
  });

  it("開機：沒有 MAC → failed；送了喚醒但電視沒上線 → unconfirmed（不說開了）", async () => {
    const dead = await deadUrl();
    const noMac = new LgTvAdapter({ host: HOST, pairingFile: paired(HOST, []), urls: [dead], timing: FAST });
    expect(await run(noMac, TV_TOOL.power, { state: "on" })).toMatchObject({ status: "failed", message: TV_TEXT.noMac });
    let sent = 0;
    const r = await run(adapter([dead], { wol: async () => void sent++ }), TV_TOOL.power, { state: "on" });
    expect(r).toMatchObject({ ok: false, status: "unconfirmed", message: TV_TEXT.onUnconfirmed });
    expect(sent).toBeGreaterThan(1); // 等待期間有補送
  });

  it("NOUS_LGTV_MAC 覆蓋配對時的 MAC；配對時記了兩張網卡就兩張都送", async () => {
    const wols: string[] = [];
    await run(adapter([await deadUrl()], { mac: "00:11:22:33:44:55", wol: async (m) => void wols.push(m) }), TV_TOOL.power, { state: "on" });
    expect(new Set(wols)).toEqual(new Set(["00:11:22:33:44:55"]));
    const both: string[] = [];
    const two = new LgTvAdapter({ host: HOST, pairingFile: paired(HOST, [MAC, "a8:23:fe:00:00:01"]), urls: [await deadUrl()], timing: FAST, wol: async (m) => void both.push(m) });
    await run(two, TV_TOOL.power, { state: "on" });
    expect(both.slice(0, 2)).toEqual([MAC, "a8:23:fe:00:00:01"]);
  });

  it("關機：電視斷線 → confirmed；電視不理 → unconfirmed；連不上 → failed 且沒有送出", async () => {
    const t = await tv();
    expect(await run(adapter([t.url]), TV_TOOL.power, { state: "off" })).toMatchObject({ status: "confirmed", message: TV_TEXT.offConfirmed });
    expect(t.uris()).toContain("system/turnOff");
    const stubborn = await tv({ ignoreOff: true });
    expect(await run(adapter([stubborn.url]), TV_TOOL.power, { state: "off" })).toMatchObject({ status: "unconfirmed", message: TV_TEXT.offUnconfirmed });
    expect(await run(adapter([await deadUrl()]), TV_TOOL.power, { state: "off" })).toMatchObject({ status: "failed", message: TV_TEXT.offUnreachable, data: { sent: false } });
    const standby = await tv({ power: "Active Standby" });
    expect(await run(adapter([standby.url]), TV_TOOL.power, { state: "off" })).toMatchObject({ status: "confirmed", message: TV_TEXT.alreadyOff });
    expect(standby.uris()).not.toContain("system/turnOff");
  });

  it("音量：回讀相符 → confirmed；讀回不符（聲霸）→ unconfirmed；待機或連不上 → failed 不送", async () => {
    const t = await tv({ volume: 10 });
    expect(await run(adapter([t.url]), TV_TOOL.volume, { action: "set", level: 25 })).toMatchObject({ status: "confirmed", data: { before: 10, volume: 25 } });
    expect(await run(adapter([t.url]), TV_TOOL.volume, { action: "up", steps: 3 })).toMatchObject({ status: "confirmed", data: { volume: 28 } });
    expect(await run(adapter([t.url]), TV_TOOL.volume, { action: "down" })).toMatchObject({ status: "confirmed", data: { volume: 27 } });
    expect(await run(adapter([t.url]), TV_TOOL.volume, { action: "set" })).toMatchObject({ status: "refused" });
    const bar = await tv({ ignoreVolume: true });
    expect(await run(adapter([bar.url]), TV_TOOL.volume, { action: "set", level: 30 })).toMatchObject({ status: "unconfirmed", message: TV_TEXT.volumeUnconfirmed });
    const standby = await tv({ power: "Active Standby" });
    expect(await run(adapter([standby.url]), TV_TOOL.volume, { action: "up" })).toMatchObject({ status: "failed", message: TV_TEXT.tvOffForCommand });
    expect(standby.uris()).not.toContain("audio/volumeUp");
    expect(await run(adapter([await deadUrl()]), TV_TOOL.mute, { muted: true })).toMatchObject({ status: "failed", message: TV_TEXT.unreachable });
  });

  it("靜音 confirmed；電視拒絕 → failed；送出後斷線 → unknown", async () => {
    const t = await tv();
    expect(await run(adapter([t.url]), TV_TOOL.mute, { muted: true })).toMatchObject({ status: "confirmed", data: { muted: true } });
    const rej = await tv({ rejectUri: "audio/setMute" });
    expect(await run(adapter([rej.url]), TV_TOOL.mute, { muted: true })).toMatchObject({ status: "failed", message: TV_TEXT.rejected });
    const drop = await tv({ dropOn: "audio/setMute" });
    expect(await run(adapter([drop.url]), TV_TOOL.mute, { muted: true })).toMatchObject({ status: "unknown", message: TV_TEXT.lost });
  });

  it("切輸入源：回讀前景 App 相符 → confirmed；沒有這個輸入 → failed 並列出可用的", async () => {
    const t = await tv();
    expect(await run(adapter([t.url]), TV_TOOL.input, { input: "hdmi 2" })).toMatchObject({ status: "confirmed", data: { input: "HDMI_2", label: "Apple TV" } });
    expect(t.requests.find((r) => r.uri === "tv/switchInput")?.payload).toEqual({ inputId: "HDMI_2" });
    expect(await run(adapter([t.url]), TV_TOOL.input, { input: "HDMI 4" })).toMatchObject({ status: "failed", data: { inputs: ["HDMI 1", "Apple TV"] } });
    const lazy = await tv({ ignoreLaunch: true });
    expect((await run(adapter([lazy.url]), TV_TOOL.input, { input: "1" })).status).toBe("unconfirmed");
  });

  it("開 App：中文別名、回讀確認；沒裝 → failed；Spotify → refused 且沒有送出", async () => {
    const t = await tv();
    expect(await run(adapter([t.url]), TV_TOOL.launch, { app: "網飛" })).toMatchObject({ status: "confirmed", data: { app: "Netflix", app_id: "netflix" } });
    expect(await run(adapter([t.url]), TV_TOOL.launch, { app: "Prime Video" })).toMatchObject({ status: "failed", message: TV_TEXT.appNotFound });
    const failed = await run(adapter([t.url]), TV_TOOL.launch, { app: "Prime Video" });
    expect((failed.data as { installed: string[] }).installed).not.toContain("Spotify - Music and Podcasts");
    const before = t.requests.filter((r) => r.uri === "system.launcher/launch").length;
    expect(await run(adapter([t.url]), TV_TOOL.launch, { app: "spotify" })).toMatchObject({ status: "refused", message: TV_TEXT.appSpotify });
    expect(t.requests.filter((r) => r.uri === "system.launcher/launch").length).toBe(before);
    const lazy = await tv({ ignoreLaunch: true });
    expect((await run(adapter([lazy.url]), TV_TOOL.launch, { app: "YouTube" })).status).toBe("unconfirmed");
  });

  it("開 App 時電視待機：先開機再開 App，結果標示 turned_on", async () => {
    const t = await tv({ power: "Active Standby", wakeOnTurnOn: true });
    expect(await run(adapter([t.url]), TV_TOOL.launch, { app: "YouTube" })).toMatchObject({ status: "confirmed", data: { app: "YouTube", turned_on: true } });
    expect(t.uris().indexOf("system/turnOn")).toBeLessThan(t.uris().indexOf("system.launcher/launch"));
  });

  it("開 App 時開機沒有確認：說還沒開 App（不讓模型以為 App 正在開）", async () => {
    const r = await run(adapter([await deadUrl()], { wol: async () => undefined }), TV_TOOL.launch, { app: "YouTube" });
    expect(r).toMatchObject({ status: "unconfirmed", message: TV_TEXT.appPowerPending, data: { launched: false } });
    const noMac = new LgTvAdapter({ host: HOST, pairingFile: paired(HOST, []), urls: [await deadUrl()], timing: FAST });
    expect(await run(noMac, TV_TOOL.input, { input: "HDMI 1" })).toMatchObject({ status: "failed", message: TV_TEXT.noMac });
  });

  it("送出後才出錯：音量調到一半被拒 → unconfirmed（不說失敗）；喚醒後配對錯誤 → unconfirmed", async () => {
    const t = await tv({ rejectUri: "audio/getVolume" });
    // 讀音量被拒（讀不到前後值）但寫入成功：仍是 unconfirmed。
    expect((await run(adapter([t.url]), TV_TOOL.volume, { action: "up", steps: 2 })).status).toBe("unconfirmed");
    const step = await tv({ volumeUpOkTimes: 2 });
    const r = await run(adapter([step.url]), TV_TOOL.volume, { action: "up", steps: 5 });
    expect(r).toMatchObject({ status: "unconfirmed", message: TV_TEXT.sentThenError });

    // 網路喚醒後，上線的電視不認得金鑰。
    const sleeping = new FakeTv();
    tvs.push(sleeping);
    const port = Number((await deadUrl()).split(":").pop());
    const wrongKey = new LgTvAdapter({ host: HOST, pairingFile: pairingFile(tempDir()), urls: [`ws://127.0.0.1:${port}`], timing: FAST, wol: async () => void (sleeping.server || (await sleeping.start(port))) });
    writePairing((wrongKey as unknown as { options: { pairingFile: string } }).options.pairingFile, { version: 1, host: HOST, client_key: "OTHER", macs: [MAC], paired_at: "" });
    expect(await run(wrongKey, TV_TOOL.power, { state: "on" })).toMatchObject({ status: "unconfirmed", message: TV_TEXT.onPairingAfterWake });
  });

  it("網路喚醒封包送不出去 → failed（沒有開機）", async () => {
    const r = await run(adapter([await deadUrl()], { wol: async () => Promise.reject(new Error("ENETUNREACH")) }), TV_TOOL.power, { state: "on" });
    expect(r.status).toBe("failed");
  });

  it("播放控制只能 unconfirmed（電視不回報播放狀態）", async () => {
    const t = await tv();
    expect(await run(adapter([t.url]), TV_TOOL.media, { action: "pause" })).toMatchObject({ status: "unconfirmed", message: TV_TEXT.mediaSent });
    expect(t.uris()).toContain("media.controls/pause");
  });

  it("健康狀態：連得上 available；連不上 unknown（電視待機是正常的）", async () => {
    const t = await tv();
    expect(await adapter([t.url]).health(new AbortController().signal)).toEqual({ health: "available", reason: "ok" });
    expect(await adapter([await deadUrl()]).health(new AbortController().signal)).toEqual({ health: "unknown", reason: "unreachable" });
  });

  it("結果與工具清單都不含金鑰", async () => {
    const t = await tv();
    const a = adapter([t.url]);
    const all = [await run(a, TV_TOOL.status), await run(a, TV_TOOL.launch, { app: "YouTube" }), await run(a, TV_TOOL.power, { state: "on" })];
    expect(JSON.stringify(all)).not.toContain(KEY);
    expect(JSON.stringify(a.tools())).not.toContain(KEY);
  });
});

describe("LGTV-1 設定與整合層", () => {
  it("NOUS_LGTV_HOST 只接受私有網段；MAC 與廣播位址格式檢查；金鑰檔固定在 configDir", () => {
    const base = { NOUS_AIL: "on", NOUS_AIL_SERVICES: "lg_tv", NOUS_CONFIG_DIR: "/tmp/nous-x" };
    expect(loadConfig({ ...base, NOUS_LGTV_HOST: HOST, NOUS_LGTV_MAC: "A8-23-FE-12-34-56" }).ail.tv).toEqual({ host: HOST, mac: MAC, broadcast: null, pairingFile: "/tmp/nous-x/lgtv.json" });
    expect(loadConfig({ ...base }).ail.tv?.host).toBeNull();
    for (const bad of ["8.8.8.8", "tv.example.com", "192.168.1.300", "172.32.0.1", "010.0.0.1", "192.168.01.5"]) expect(() => loadConfig({ ...base, NOUS_LGTV_HOST: bad })).toThrow(/NOUS_LGTV_HOST/);
    expect(() => loadConfig({ ...base, NOUS_LGTV_HOST: HOST, NOUS_LGTV_MAC: "nope" })).toThrow(/NOUS_LGTV_MAC/);
    expect(() => loadConfig({ ...base, NOUS_LGTV_HOST: HOST, NOUS_LGTV_BROADCAST: "1.1.1.255" })).toThrow(/NOUS_LGTV_BROADCAST/);
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "mock", NOUS_LGTV_HOST: "8.8.8.8" }).ail.tv).toBeUndefined();
  });

  it("沒有電視 IP 不註冊；兩條即時語音路徑拿到同一份 app__tv__ 工具", () => {
    const lines: string[] = [];
    expect(createIntegrations({ enabled: true, services: ["lg_tv"], soloistPort: 19090, tv: { host: null, mac: null, broadcast: null, pairingFile: "/x" } }, (l) => lines.push(l))!.registry.adapters()).toEqual([]);
    expect(lines.join("\n")).toMatch(/NOUS_LGTV_HOST/);
    const ail = createIntegrations({ enabled: true, services: ["lg_tv"], soloistPort: 19090, tv: { host: HOST, mac: null, broadcast: null, pairingFile: "/x" } })!;
    const apiKey = buildRealtimeTools({ webSearch: false, mcp: [], integrations: (l) => ail.registry.functionSpecs("api_key", l) }).filter((t) => String(t.name).startsWith("app__"));
    const live = liveCallerTools({ webSearch: false, mcp: [], integrations: (l) => ail.registry.functionSpecs("live", l) }).filter((t) => t.type === "function" && t.name.startsWith("app__"));
    expect(apiKey.map((t) => t.name)).toEqual(["app__tv__input", "app__tv__launch_app", "app__tv__media", "app__tv__mute", "app__tv__power", "app__tv__status", "app__tv__volume"]);
    expect(live.map((t) => (t.type === "function" ? [t.name, t.parameters] : null))).toEqual(apiKey.map((t) => [t.name, t.parameters]));
  });

  it("模型不能多塞 host／IP 等參數（Schema 拒絕、不執行）", async () => {
    const ail = createIntegrations({ enabled: true, services: ["lg_tv"], soloistPort: 19090, tv: { host: HOST, mac: null, broadcast: null, pairingFile: "/nonexistent/lgtv.json" } })!;
    const r = await ail.dispatcher.execute({ tool: "app__tv__power", args: { state: "on", host: "8.8.8.8" }, route: "live", actor: "agent", sessionId: "s" });
    expect(r).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    const r2 = await ail.dispatcher.execute({ tool: "app__tv__power", args: { state: "on" }, route: "live", actor: "agent", sessionId: "s" });
    expect(r2).toMatchObject({ status: "refused", message: TV_TEXT.notPaired });
  });

  it("說話規則：有電視工具時才說電視用 app__tv__，「電視音量」不再交給 home_control", () => {
    const ail = createIntegrations({ enabled: true, services: ["lg_tv"], soloistPort: 19090, tv: { host: HOST, mac: null, broadcast: null, pairingFile: "/x" } })!;
    const withTv = realtimeToolRules({ webSearch: false, mcp: [], home: true, integrations: (l) => ail.registry.functionSpecs("live", l) });
    expect(withTv).toContain(INTEGRATION_RULE);
    expect(withTv).toContain(TV_RULE);
    expect(withTv).toContain(voiceVolumeRule(true, true));
    expect(voiceVolumeRule(true, true)).toContain("app__tv__volume");
    expect(voiceVolumeRule(true, true)).not.toContain("（電視、音響");
    const withoutTv = realtimeToolRules({ webSearch: false, mcp: [], home: true });
    expect(withoutTv).not.toContain(TV_RULE);
    expect(withoutTv).toContain(voiceVolumeRule(true));
    expect(voiceVolumeRule(true)).toBe(voiceVolumeRule(true, false));
  });
});
