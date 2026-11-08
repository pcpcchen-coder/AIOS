import WebSocket from "ws";

// LGTV-1：LG webOS 的 SSAP（區網 WebSocket）最小用戶端。協定與註冊內容參考 LGTVG3（pcpcchen-coder/LGTVG3）
// 與它使用的 aiowebostv 1.0.0（Home Assistant，Apache-2.0）的 handshake.py／endpoints.py；這裡只用到 Nous 需要的部分。
// - webOS 23（G3）走 wss://<電視>:3001（自簽憑證，所以不驗證憑證）；連不上再試舊的 ws://<電視>:3000。
// - 每次工具呼叫開一條連線、做完就關，不常駐、不訂閱。
// - 配對金鑰（client-key）只由呼叫端傳入；這裡不寫檔、不記 log、錯誤訊息不含金鑰。

/** 註冊內容（aiowebostv 1.0.0 handshake.py 的 REGISTRATION_PAYLOAD；pairingType PROMPT＝電視上按「允許」）。 */
const PERMISSIONS = [
  "APP_TO_APP", "CLOSE", "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK", "CONTROL_INPUT_MEDIA_PLAYBACK",
  "CONTROL_INPUT_MEDIA_RECORDING", "CONTROL_INPUT_TEXT", "CONTROL_INPUT_TV", "CONTROL_MOUSE_AND_KEYBOARD", "CONTROL_POWER",
  "CONTROL_TV_SCREEN", "LAUNCH", "LAUNCH_WEBAPP", "READ_APP_STATUS", "READ_COUNTRY_INFO", "READ_CURRENT_CHANNEL",
  "READ_INPUT_DEVICE_LIST", "READ_INSTALLED_APPS", "READ_LGE_SDX", "READ_LGE_TV_INPUT_EVENTS", "READ_NETWORK_STATE",
  "READ_NOTIFICATIONS", "READ_POWER_STATE", "READ_RUNNING_APPS", "READ_SETTINGS", "READ_TV_CHANNEL_LIST",
  "READ_TV_CURRENT_TIME", "READ_UPDATE_INFO", "SEARCH", "TEST_OPEN", "TEST_PROTECTED", "TEST_SECURE",
  "UPDATE_FROM_REMOTE_APP", "WRITE_NOTIFICATION_ALERT", "WRITE_NOTIFICATION_TOAST", "WRITE_SETTINGS",
] as const;

export const SSAP = {
  powerState: "com.webos.service.tvpower/power/getPowerState",
  turnOn: "system/turnOn",
  turnOff: "system/turnOff",
  foregroundApp: "com.webos.applicationManager/getForegroundAppInfo",
  launchPoints: "com.webos.applicationManager/listLaunchPoints",
  launch: "system.launcher/launch",
  getVolume: "audio/getVolume",
  audioStatus: "audio/getStatus",
  setVolume: "audio/setVolume",
  volumeUp: "audio/volumeUp",
  volumeDown: "audio/volumeDown",
  setMute: "audio/setMute",
  inputs: "tv/getExternalInputList",
  switchInput: "tv/switchInput",
  connectionInfo: "com.webos.service.connectionmanager/getinfo",
  systemInfo: "system/getSystemInfo",
  inputSocket: "com.webos.service.networkinput/getPointerInputSocket",
  /** LGTV-2：媒體播放狀態（foregroundAppInfo[].playState）。 */
  mediaForeground: "com.webos.media/getForegroundAppInfo",
  media: { play: "media.controls/play", pause: "media.controls/pause", stop: "media.controls/stop", rewind: "media.controls/rewind", fast_forward: "media.controls/fastForward" },
} as const;

/** 遙控按鍵名稱（aiowebostv buttons.py 的子集：大寫英文與數字）。 */
const BUTTON = /^[A-Z0-9_]{1,20}$/;

/** 連不上電視（沒有送出任何指令）：關機待機、不在網路上、LG Connect Apps 關閉。 */
export class SsapUnreachable extends Error {}
/** 電視不認得這個金鑰（或還沒配對），會要求在電視上按「允許」。 */
export class SsapPairingRequired extends Error {}
/** 指令送出後連線中斷或沒有回覆：結果不明。 */
export class SsapLost extends Error {}
/** 電視明確回錯誤（returnValue false 或 type error）：沒有成功。 */
export class SsapRejected extends Error {}

export interface SsapConnectOptions {
  host: string;
  clientKey: string | null;
  /** 連線＋註冊的時限。 */
  connectTimeoutMs?: number;
  /** 單一請求的時限。 */
  requestTimeoutMs?: number;
  /** true＝允許電視跳出配對提示並等使用者按「允許」（只給配對指令用）。 */
  allowPrompt?: boolean;
  /** 等使用者按「允許」的時限。 */
  promptTimeoutMs?: number;
  signal?: AbortSignal;
  /** 測試用：改連這些網址（依序嘗試）。 */
  urls?: readonly string[];
  onPrompt?: () => void;
}

type Payload = Record<string, unknown>;
interface Pending {
  resolve: (p: Payload) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SsapSession {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly clientKey: string,
    private readonly requestTimeoutMs: number,
    /** 這條連線實際連到的主機（遙控按鍵的第二條連線只接受同一台主機）。 */
    readonly remoteHost: string = "",
  ) {
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.failAll(new SsapLost("連線中斷")));
    ws.on("error", () => this.failAll(new SsapLost("連線錯誤")));
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** 送出請求並等回覆。type error 或 returnValue false → SsapRejected；中斷或逾時 → SsapLost。 */
  request(uri: string, payload: Payload = {}): Promise<Payload> {
    if (!this.isOpen) return Promise.reject(new SsapLost("連線已關閉"));
    const id = `n${this.nextId++}`;
    return new Promise<Payload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SsapLost("電視沒有在時限內回覆"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, type: "request", uri: `ssap://${uri}`, payload }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SsapLost("送出失敗"));
      }
    });
  }

  /** 只送出、不等回覆（關機：電視可能直接斷線，回覆不可靠）。回傳是否真的交給了連線。 */
  send(uri: string, payload: Payload = {}): boolean {
    if (!this.isOpen) return false;
    try {
      this.ws.send(JSON.stringify({ id: `n${this.nextId++}`, type: "request", uri: `ssap://${uri}`, payload }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * LGTV-2：送遙控器按鍵（HOME、ENTER、RIGHT…）。按鍵走電視給的第二條 WebSocket（getPointerInputSocket），
   * 只接受和主連線同一台主機的位址（電視回的位址不能把 Nous 帶去別的主機）。每個鍵之間隔 gapMs。
   */
  async buttons(names: readonly string[], gapMs = 150, signal?: AbortSignal): Promise<void> {
    const r = await this.request(SSAP.inputSocket);
    const path = typeof r.socketPath === "string" ? r.socketPath : "";
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      throw new SsapRejected("電視沒有給遙控按鍵的位址");
    }
    if (!["ws:", "wss:"].includes(url.protocol) || (this.remoteHost && url.hostname !== this.remoteHost)) throw new SsapRejected("遙控按鍵的位址不是這台電視");
    // 按鍵連線開不起來：一個鍵都還沒送，是「沒有送出」。
    const input = await openSocket(url.href, 3_000, signal).catch(() => {
      throw new SsapUnreachable("連不上遙控按鍵的連線");
    });
    input.on("error", () => undefined);
    try {
      for (let i = 0; i < names.length; i++) {
        if (signal?.aborted) throw new SsapLost("已中止");
        if (i) await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (!BUTTON.test(names[i]!)) throw new SsapRejected("不支援的按鍵");
        await new Promise<void>((resolve, reject) => input.send(`type:button\nname:${names[i]}\n\n`, (err) => (err ? reject(new SsapLost("按鍵送出失敗")) : resolve())));
      }
    } finally {
      try {
        input.close();
      } catch {
        // ignore
      }
    }
  }

  close(): void {
    this.failAll(new SsapLost("連線已關閉"));
    try {
      this.ws.close();
    } catch {
      // 已經關了
    }
  }

  private onMessage(text: string): void {
    let msg: { id?: unknown; type?: unknown; payload?: unknown; error?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : null;
    const p = id ? this.pending.get(id) : undefined;
    if (!id || !p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const payload = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload) ? (msg.payload as Payload) : {};
    if (msg.type === "error") return p.reject(new SsapRejected(typeof msg.error === "string" ? msg.error.slice(0, 120) : "電視回錯誤"));
    if (payload.returnValue === false) return p.reject(new SsapRejected(typeof payload.errorText === "string" ? payload.errorText.slice(0, 120) : "電視拒絕"));
    p.resolve(payload);
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

function openSocket(url: string, timeoutMs: number, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // 電視用自簽憑證：只在區網連固定的電視 IP，不驗證憑證（和 aiowebostv、LGTVG3 相同）。
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: timeoutMs, maxPayload: 4 * 1024 * 1024 });
    const done = (err?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      ws.removeAllListeners("open");
      ws.removeAllListeners("error");
      if (err) {
        ws.on("error", () => undefined);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(err);
      } else resolve(ws);
    };
    const onAbort = () => done(new SsapUnreachable("已中止"));
    const timer = setTimeout(() => done(new SsapUnreachable("連線逾時")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.once("open", () => done());
    ws.once("error", () => done(new SsapUnreachable("連不上")));
  });
}

/**
 * 握手期間的收件匣：一連上就開始收，所有訊息排隊，依 id 取（同一個封包裡的多則訊息、晚到的舊回覆都不會被拿錯或漏掉）。
 * socket 錯誤或關閉時，等待中的與之後的取件都失敗。
 */
class HandshakeInbox {
  private readonly queue: Record<string, unknown>[] = [];
  private waiter: { match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private dead: Error | null = null;
  private readonly onMessage = (data: WebSocket.RawData) => {
    let v: unknown;
    try {
      v = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    this.queue.push(v as Record<string, unknown>);
    this.pump();
  };
  private readonly onEnd = () => this.kill(new SsapUnreachable("註冊前連線中斷"));

  constructor(private readonly ws: WebSocket) {
    ws.on("message", this.onMessage);
    ws.on("close", this.onEnd);
    ws.on("error", this.onEnd);
  }

  /** 取第一則符合的訊息。 */
  take(match: (m: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new SsapUnreachable("註冊逾時"));
      }, timeoutMs);
      this.waiter = { match, resolve, reject, timer };
      this.pump();
    });
  }

  /** 握手結束：拔掉收件匣的 message／close 監聽（error 監聽留著，直到 Session 接手）。 */
  detach(): void {
    this.ws.off("message", this.onMessage);
    this.ws.off("close", this.onEnd);
  }

  release(): void {
    this.ws.off("error", this.onEnd);
  }

  private pump(): void {
    const w = this.waiter;
    if (!w) return;
    const i = this.queue.findIndex(w.match);
    if (i < 0) return;
    const [m] = this.queue.splice(i, 1);
    clearTimeout(w.timer);
    this.waiter = null;
    w.resolve(m!);
  }

  private kill(err: Error): void {
    if (this.dead) return;
    this.dead = err;
    const w = this.waiter;
    this.waiter = null;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }
}

/**
 * 連線並註冊。沒有金鑰或金鑰無效時，電視會要求配對：allowPrompt=false（一般工具呼叫）立刻斷線並丟 SsapPairingRequired，
 * 不會等使用者按「允許」；allowPrompt=true（配對指令）等使用者按，成功時回新的金鑰。
 */
export async function connectSsap(options: SsapConnectOptions): Promise<SsapSession> {
  const connectTimeout = options.connectTimeoutMs ?? 4_000;
  const urls = options.urls ?? [`wss://${options.host}:3001`, `ws://${options.host}:3000`];
  let ws: WebSocket | null = null;
  let remoteHost = "";
  for (const url of urls) {
    if (options.signal?.aborted) throw new SsapUnreachable("已中止");
    try {
      ws = await openSocket(url, connectTimeout, options.signal);
      remoteHost = new URL(url).hostname;
      break;
    } catch {
      ws = null;
    }
  }
  if (!ws) throw new SsapUnreachable("連不上電視");
  const fail = (err: Error): never => {
    ws!.on("error", () => undefined);
    try {
      ws!.terminate();
    } catch {
      // ignore
    }
    throw err;
  };
  const onAbort = () => {
    try {
      ws!.terminate();
    } catch {
      // ignore
    }
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // 一連上就掛收件匣（含 error 監聽）：握手期間的 socket 錯誤只會讓握手失敗，不會變成未處理的例外。
  const inbox = new HandshakeInbox(ws);
  const byId = (id: string) => (m: Record<string, unknown>) => m.id === id;
  try {
    ws.send(JSON.stringify({ id: "hello", type: "hello", payload: {} }));
    const hello = await inbox.take((m) => m.type === "hello" || m.id === "hello", connectTimeout);
    if (hello.type !== "hello") fail(new SsapUnreachable("電視的回應不是 webOS SSAP"));
    // 新版 webOS 要求註冊前先查系統資訊（aiowebostv 的做法）；結果不用，錯了或沒回也不管。
    ws.send(JSON.stringify({ id: "pre_sysinfo", type: "request", uri: `ssap://${SSAP.systemInfo}`, payload: {} }));
    await inbox.take(byId("pre_sysinfo"), connectTimeout).catch((err) => {
      if (err instanceof SsapUnreachable && err.message === "註冊前連線中斷") throw err;
    });
    const payload: Record<string, unknown> = { forcePairing: false, pairingType: "PROMPT", manifest: { appVersion: "1.1", manifestVersion: 1, permissions: [...PERMISSIONS] } };
    if (options.clientKey) payload["client-key"] = options.clientKey;
    ws.send(JSON.stringify({ id: "register_0", type: "register", payload }));
    let reply = await inbox.take(byId("register_0"), connectTimeout);
    if (reply.type === "response" && (reply.payload as Record<string, unknown> | undefined)?.pairingType === "PROMPT") {
      if (!options.allowPrompt) fail(new SsapPairingRequired("需要在電視上配對"));
      options.onPrompt?.();
      reply = await inbox.take(byId("register_0"), options.promptTimeoutMs ?? 60_000).catch(() => fail(new SsapPairingRequired("沒有在時限內按「允許」")));
    }
    if (reply.type === "error") fail(new SsapPairingRequired("電視拒絕配對"));
    const key = (reply.payload as Record<string, unknown> | undefined)?.["client-key"];
    if (reply.type !== "registered" || typeof key !== "string" || !key) fail(new SsapPairingRequired("註冊沒有完成"));
    inbox.detach();
    const session = new SsapSession(ws, key as string, options.requestTimeoutMs ?? 5_000, remoteHost);
    inbox.release();
    return session;
  } catch (err) {
    inbox.detach();
    ws.on("error", () => undefined);
    onAbort();
    if (err instanceof SsapPairingRequired || err instanceof SsapUnreachable) throw err;
    throw new SsapUnreachable("連線失敗");
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}
