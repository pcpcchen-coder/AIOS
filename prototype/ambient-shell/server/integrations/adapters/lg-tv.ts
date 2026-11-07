import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import { inputOfApp, isSpotifyApp, resolveApp, resolveInput, type InputDevice, type LaunchPoint } from "../../lgtv/apps.ts";
import { connectSsap, SSAP, SsapLost, SsapPairingRequired, SsapRejected, SsapUnreachable, type SsapConnectOptions, type SsapSession } from "../../lgtv/ssap.ts";
import { readPairing } from "../../lgtv/store.ts";
import { sendWol, type WolSender } from "../../lgtv/wol.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// LGTV-1（George 2026-11-07）：用語音控制客廳的 LG G3 電視（webOS 23）。做法來自 LGTVG3（pcpcchen-coder/LGTVG3）的研究：
// 區網 SSAP（wss://電視:3001）＋ Wake-on-LAN。核心在 Mac 上直接連電視；電視控制不經頁面、不開任何對外的埠。
// - 電視 IP 只來自設定（NOUS_LGTV_HOST，限私有網段）；金鑰只來自 <configDir>/lgtv.json（npm run tv:pair 寫入，0600）。
//   模型不能指定 IP、MAC、金鑰或任何 SSAP 位址；只能從固定的動作裡選。
// - 結果（誠實狀態）：有回讀且符合 → confirmed；送出了但讀不到或不符 → unconfirmed；送出後連線斷掉或電視沒回覆 → unknown；
//   連不上電視（沒有送出）或電視回錯誤 → failed；沒有配對 → refused。Dispatcher 的逾時 → unknown。
// - 開 App、切輸入時電視沒開會先開機（George 2026-10-31：便利優先）；開機不出確認卡（可逆，不是紅線列的外部副作用）。
// - Spotify：SP-2 BLOCKED（Spotify 開發者政策 III.3 語音控制條款），不用語音開電視上的 Spotify。

export const TV_TOOL = {
  status: "app.tv.status",
  power: "app.tv.power",
  volume: "app.tv.volume",
  mute: "app.tv.mute",
  input: "app.tv.input",
  launch: "app.tv.launch_app",
  media: "app.tv.media",
} as const satisfies Record<string, IntegrationToolId>;

export const TV_TIMING = {
  connectMs: 3_000,
  /** 開機（網路喚醒）後等電視上線的時間。 */
  wakeWaitMs: 25_000,
  /** 輪詢間隔。 */
  pollMs: 1_500,
  /** 關機後回讀的時間。 */
  offWaitMs: 8_000,
  /** 開 App／切輸入後回讀前景 App 的時間。 */
  appWaitMs: 6_000,
  /** 待機喚醒（system/turnOn）後回讀的時間。 */
  standbyWaitMs: 8_000,
  /** 音量逐格調整的間隔。 */
  stepMs: 150,
} as const;

/** 電源狀態：on＝開著；standby＝SSAP 連得上但在待機（Quick Start+）；screen_off＝聲音開著、螢幕關。 */
export type TvPower = "on" | "standby" | "screen_off" | "unknown";

export function powerOf(state: unknown): TvPower {
  if (typeof state !== "string" || !state) return "unknown";
  if (state === "Active") return "on";
  if (state === "Screen Off" || state === "Screen Saver") return "screen_off";
  if (["Power Off", "Suspend", "Active Standby"].includes(state)) return "standby";
  return "unknown";
}

export interface LgTvOptions {
  host: string;
  /** <configDir>/lgtv.json。 */
  pairingFile: string;
  /** NOUS_LGTV_MAC（覆蓋配對時讀到的 MAC）。 */
  mac?: string | null;
  /** NOUS_LGTV_BROADCAST（例如 192.168.1.255；沒有時用 255.255.255.255）。 */
  broadcast?: string | null;
  /** 測試用：SSAP 連線網址、Wake-on-LAN、計時。 */
  urls?: readonly string[];
  wol?: WolSender;
  timing?: Partial<Record<keyof typeof TV_TIMING, number>>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const sleepDefault = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const ROUTES = ["api_key", "live"] as const;

/** 結果文字（固定句；英文在 server/messages.en.json 與 src/messages.en.json）。 */
export const TV_TEXT = {
  notPaired: "電視還沒配對：請在 Mac 上執行 npm run tv:pair，並在電視上按「允許」。沒有送出。",
  pairingRejected: "電視不認得這台 Mac 的配對金鑰，請在 Mac 上重新執行 npm run tv:pair。沒有送出。",
  unreachable: "連不上電視（可能關機待機或不在網路上），沒有送出。",
  lost: "指令送出後和電視的連線中斷或沒有回覆，結果不明，請看一下電視。",
  rejected: "電視拒絕了這個指令，沒有成功。",
  status: "電視目前的狀態。",
  statusOff: "連不上電視：可能關機待機，或不在網路上。",
  alreadyOn: "電視已經開著。",
  onConfirmed: "電視開了。",
  onUnconfirmed: "已送出開機，但沒有在時限內讀到電視開機，請看一下電視。",
  noMac: "連不上電視，也沒有電視的 MAC 位址，沒辦法用網路喚醒（請重新配對或設定 NOUS_LGTV_MAC）。沒有送出。",
  alreadyOff: "電視已經是關機待機。",
  offUnreachable: "連不上電視（可能已經關機或不在網路上），沒有送出關機指令。",
  offConfirmed: "電視關了。",
  offUnconfirmed: "已送出關機，但沒有讀到電視關機，請看一下電視。",
  volumeConfirmed: "音量調好了。",
  volumeUnconfirmed: "已送出音量指令，但讀回的音量不符（接聲霸或外接音響時常讀不到），請聽一下。",
  muteConfirmed: "靜音設定好了。",
  muteUnconfirmed: "已送出靜音指令，但讀回的狀態不符，請看一下電視。",
  inputNotFound: "電視上沒有這個輸入源，沒有切換。",
  inputConfirmed: "已切到這個輸入源。",
  inputUnconfirmed: "已送出切換輸入源，但沒有讀到電視切過去，請看一下電視。",
  appNotFound: "電視上沒有安裝這個 App，沒有開。",
  appSpotify: "Spotify 的語音控制沒有取得授權（Spotify 開發者政策），不能用語音開電視上的 Spotify。沒有送出。",
  appConfirmed: "App 已經開了。",
  appUnconfirmed: "已送出開 App，但沒有讀到電視切到這個 App，請看一下電視。",
  mediaSent: "已送出；電視不回報播放狀態，請看一下電視。",
  tvOffForCommand: "電視沒有開，沒有送出（要先說「開電視」）。",
  sentThenError: "指令已經送出（至少一部分），但之後電視回了錯誤，沒有確認結果，請看一下電視。",
  onPairingAfterWake: "已送出網路喚醒，但電視不認得這台 Mac 的配對金鑰（請重新執行 npm run tv:pair），沒有確認開機，請看一下電視。",
  appPowerPending: "已送出開機，但沒有讀到電視開機，所以還沒有開 App；電視開好後請再說一次。",
  inputPowerPending: "已送出開機，但沒有讀到電視開機，所以還沒有切輸入源；電視開好後請再說一次。",
  appAfterOnLost: "電視開了，但之後連不上電視，沒有開 App；請再說一次。",
  inputAfterOnLost: "電視開了，但之後連不上電視，沒有切輸入源；請再說一次。",
} as const;

export class LgTvAdapter implements IntegrationAdapter {
  readonly id = "lg_tv";
  readonly service = "tv";
  readonly version = 1;
  readonly mock = false;
  private readonly t: Record<keyof typeof TV_TIMING, number>;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: LgTvOptions) {
    this.t = { ...TV_TIMING, ...(options.timing ?? {}) };
    this.sleep = options.sleep ?? sleepDefault;
    this.now = options.now ?? Date.now;
  }

  tools(): readonly ToolDefinition[] {
    return [
      {
        id: TV_TOOL.status,
        description: "查客廳 LG 電視的狀態：是否連得上、開機或待機、目前的 App 或輸入源、音量與靜音。使用者問電視開著沒、在看什麼時呼叫。",
        descriptionEn: "Check the living-room LG TV: whether it is reachable, on or in standby, the current app or input, volume and mute. Call when the user asks whether the TV is on or what it is showing.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        effect: "read",
        enabled: true,
        timeoutMs: 15_000,
        supportedRoutes: ROUTES,
      },
      {
        id: TV_TOOL.power,
        description: "開或關客廳的 LG 電視。電視待機時用網路喚醒開機，可能要十幾秒。",
        descriptionEn: "Turn the living-room LG TV on or off. Turning on from standby uses Wake-on-LAN and can take more than ten seconds.",
        inputSchema: { type: "object", properties: { state: { type: "string", enum: ["on", "off"], description: "on＝開機；off＝關機" } }, required: ["state"], additionalProperties: false },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 50_000,
        supportedRoutes: ROUTES,
      },
      {
        id: TV_TOOL.volume,
        description: "調電視音量：set 設成 level（0–100）；up／down 調高或調低 steps 格（預設 1）。",
        descriptionEn: "Change the TV volume: set to level (0–100), or up/down by steps (default 1).",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["set", "up", "down"] },
            level: { type: "integer", minimum: 0, maximum: 100, description: "action 是 set 時的音量" },
            steps: { type: "integer", minimum: 1, maximum: 10, description: "action 是 up／down 時調幾格" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 15_000,
        supportedRoutes: ROUTES,
      },
      {
        id: TV_TOOL.mute,
        description: "電視靜音（muted true）或取消靜音（false）。",
        descriptionEn: "Mute (muted true) or unmute (false) the TV.",
        inputSchema: { type: "object", properties: { muted: { type: "boolean" } }, required: ["muted"], additionalProperties: false },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 15_000,
        supportedRoutes: ROUTES,
      },
      {
        id: TV_TOOL.input,
        description: "切換電視的輸入源，例如 HDMI 1、HDMI 2，或電視上設定的輸入名稱。電視沒開時會先開機。",
        descriptionEn: "Switch the TV input, e.g. HDMI 1, HDMI 2, or an input name set on the TV. Turns the TV on first if needed.",
        inputSchema: { type: "object", properties: { input: { type: "string", minLength: 1, maxLength: 40 } }, required: ["input"], additionalProperties: false },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 60_000,
        supportedRoutes: ROUTES,
      },
      {
        id: TV_TOOL.launch,
        description: "在電視上開 App（例如 YouTube、Netflix、Disney+、Prime Video；名稱以電視上安裝的為準）。只開 App，不會播指定的節目。電視沒開時會先開機。",
        descriptionEn: "Open an app on the TV (e.g. YouTube, Netflix, Disney+, Prime Video; names follow what is installed on the TV). Only opens the app; it does not play a specific show. Turns the TV on first if needed.",
        inputSchema: { type: "object", properties: { app: { type: "string", minLength: 1, maxLength: 60, description: "App 名稱" } }, required: ["app"], additionalProperties: false },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 60_000,
        supportedRoutes: ROUTES,
      },
      {
        id: TV_TOOL.media,
        description: "電視的播放控制：播放、暫停、停止、倒轉、快轉（送給目前的 App；電視不回報播放狀態）。",
        descriptionEn: "TV playback control: play, pause, stop, rewind, fast forward (sent to the current app; the TV does not report playback state).",
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "stop", "rewind", "fast_forward"] } }, required: ["action"], additionalProperties: false },
        effect: "reversible_write",
        enabled: true,
        timeoutMs: 15_000,
        supportedRoutes: ROUTES,
      },
    ];
  }

  async health(signal: AbortSignal): Promise<HealthReport> {
    const pairing = this.pairing();
    if (!pairing) return { health: "unavailable", reason: "not_paired" };
    try {
      const s = await this.connect(pairing.client_key, signal);
      s.close();
      return { health: "available", reason: "ok" };
    } catch (err) {
      if (err instanceof SsapPairingRequired) return { health: "unavailable", reason: "not_paired" };
      return { health: "unknown", reason: "unreachable" };
    }
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    const pairing = this.pairing();
    if (!pairing) return toolResult("refused", TV_TEXT.notPaired, { reason: "unavailable" });
    const key = pairing.client_key;
    const macs = this.options.mac ? [this.options.mac] : pairing.macs;
    // 這次呼叫是否已經有一個寫入被電視接受（或網路喚醒已送出）：之後的錯誤不能說成「沒有送出」。
    const call: Call = { sent: false };
    try {
      switch (toolId) {
        case TV_TOOL.status:
          return await this.status(key, ctx.signal);
        case TV_TOOL.power:
          return args.state === "off" ? await this.powerOff(key, ctx.signal, call) : await this.powerOn(key, macs, ctx.signal, call);
        case TV_TOOL.volume:
          return await this.withOn(key, ctx.signal, (s) => this.volume(s, args, ctx.signal, call));
        case TV_TOOL.mute:
          return await this.withOn(key, ctx.signal, (s) => this.mute(s, args.muted === true, call));
        case TV_TOOL.input:
          return await this.withPowerOn(key, macs, ctx.signal, call, "input", (s) => this.input(s, String(args.input ?? ""), ctx.signal, call));
        case TV_TOOL.launch:
          return await this.withPowerOn(key, macs, ctx.signal, call, "app", (s) => this.launch(s, String(args.app ?? ""), ctx.signal, call));
        case TV_TOOL.media:
          return await this.withOn(key, ctx.signal, (s) => this.media(s, String(args.action ?? "")));
        default:
          return toolResult("refused", "沒有這個工具。", { reason: "not_registered" });
      }
    } catch (err) {
      return errorResult(err, call.sent);
    }
  }

  // ---- 連線 ----

  private pairing() {
    const p = readPairing(this.options.pairingFile);
    // 配對時的 IP 和設定不同：當作沒有配對（金鑰是另一台電視的，或電視換了 IP 要重新確認）。
    return p && p.host === this.options.host ? p : null;
  }

  private connect(key: string, signal: AbortSignal, timeoutMs = this.t.connectMs): Promise<SsapSession> {
    const opts: SsapConnectOptions = { host: this.options.host, clientKey: key, connectTimeoutMs: timeoutMs, allowPrompt: false, signal, ...(this.options.urls ? { urls: this.options.urls } : {}) };
    return connectSsap(opts);
  }

  /** 連得上就回 session，連不上回 null（配對錯誤照丟）。 */
  private async tryConnect(key: string, signal: AbortSignal): Promise<SsapSession | null> {
    try {
      return await this.connect(key, signal);
    } catch (err) {
      if (err instanceof SsapUnreachable) return null;
      throw err;
    }
  }

  private async readPower(s: SsapSession): Promise<TvPower> {
    try {
      return powerOf((await s.request(SSAP.powerState)).state);
    } catch (err) {
      if (err instanceof SsapRejected) {
        // 舊版 webOS 沒有 getPowerState：有前景 App 就當開著（aiowebostv 的做法）。
        const app = await this.readForeground(s);
        return app ? "on" : "unknown";
      }
      throw err;
    }
  }

  private async readForeground(s: SsapSession): Promise<string | null> {
    try {
      const v = (await s.request(SSAP.foregroundApp)).appId;
      return typeof v === "string" && v ? v : null;
    } catch (err) {
      if (err instanceof SsapRejected) return null;
      throw err;
    }
  }

  private async readAudio(s: SsapSession): Promise<{ volume: number | null; muted: boolean | null }> {
    let volume: number | null = null;
    let muted: boolean | null = null;
    try {
      const r = await s.request(SSAP.getVolume);
      const v = (r.volumeStatus && typeof r.volumeStatus === "object" ? r.volumeStatus : r) as Record<string, unknown>;
      if (typeof v.volume === "number") volume = v.volume;
      const m = v.muteStatus ?? v.muted ?? v.mute;
      if (typeof m === "boolean") muted = m;
    } catch (err) {
      if (!(err instanceof SsapRejected)) throw err;
    }
    if (muted === null) {
      try {
        const m = (await s.request(SSAP.audioStatus)).mute;
        if (typeof m === "boolean") muted = m;
      } catch (err) {
        if (!(err instanceof SsapRejected)) throw err;
      }
    }
    return { volume, muted };
  }

  private async readLaunchPoints(s: SsapSession): Promise<LaunchPoint[]> {
    const r = await s.request(SSAP.launchPoints);
    const list = Array.isArray(r.launchPoints) ? r.launchPoints : [];
    return list
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string")
      .map((p) => ({ id: String(p.id).slice(0, 120), title: typeof p.title === "string" ? p.title.slice(0, 60) : String(p.id).slice(0, 60) }));
  }

  /** 電視要開著才做（音量、靜音、播放控制）；沒開 → failed，不送。 */
  private async withOn(key: string, signal: AbortSignal, fn: (s: SsapSession) => Promise<ToolResult>): Promise<ToolResult> {
    const s = await this.tryConnect(key, signal);
    if (!s) return toolResult("failed", TV_TEXT.unreachable, { reason: "unavailable" });
    try {
      const power = await this.readPower(s);
      if (power === "standby") return toolResult("failed", TV_TEXT.tvOffForCommand, { reason: "unavailable" });
      return await fn(s);
    } finally {
      s.close();
    }
  }

  /** 開 App、切輸入：電視沒開就先開機（開不起來就照實回）。 */
  private async withPowerOn(key: string, macs: readonly string[], signal: AbortSignal, call: Call, what: "app" | "input", fn: (s: SsapSession) => Promise<ToolResult>): Promise<ToolResult> {
    const on = await this.powerOn(key, macs, signal, call);
    const turnedOn = (on.data as { turned_on?: boolean } | undefined)?.turned_on === true;
    // 開機沒有確認：App／輸入源還沒有送出。只說開機的結果，不讓模型以為 App 正在開。
    if (on.status !== "confirmed") {
      if (on.status === "unconfirmed") return toolResult("unconfirmed", what === "app" ? TV_TEXT.appPowerPending : TV_TEXT.inputPowerPending, { data: { power_on_sent: true, launched: false } });
      return on;
    }
    const s = await this.tryConnect(key, signal);
    if (!s) return toolResult("failed", turnedOn ? (what === "app" ? TV_TEXT.appAfterOnLost : TV_TEXT.inputAfterOnLost) : TV_TEXT.unreachable, { reason: "unavailable", ...(turnedOn ? { data: { turned_on: true } } : {}) });
    try {
      const r = await fn(s);
      return turnedOn ? { ...r, data: { ...((r.data as object | undefined) ?? {}), turned_on: true } } : r;
    } catch (err) {
      const r = errorResult(err, call.sent);
      return turnedOn ? { ...r, data: { turned_on: true } } : r;
    } finally {
      s.close();
    }
  }

  // ---- 工具 ----

  private async status(key: string, signal: AbortSignal): Promise<ToolResult> {
    const s = await this.tryConnect(key, signal);
    if (!s) return toolResult("confirmed", TV_TEXT.statusOff, { data: { reachable: false, power: "off_or_unreachable" } });
    try {
      const power = await this.readPower(s);
      if (power === "standby") return toolResult("confirmed", TV_TEXT.status, { data: { reachable: true, power } });
      const appId = await this.readForeground(s);
      let title: string | null = null;
      if (appId) {
        try {
          title = (await this.readLaunchPoints(s)).find((p) => p.id === appId)?.title ?? null;
        } catch (err) {
          if (!(err instanceof SsapRejected)) throw err;
        }
      }
      const audio = await this.readAudio(s);
      return toolResult("confirmed", TV_TEXT.status, {
        data: { reachable: true, power, app: appId ? { id: appId.slice(0, 120), title } : null, input: inputOfApp(appId), volume: audio.volume, muted: audio.muted },
      });
    } finally {
      s.close();
    }
  }

  async powerOn(key: string, macs: readonly string[], signal: AbortSignal, call: Call = { sent: false }): Promise<ToolResult> {
    const s = await this.tryConnect(key, signal);
    if (s) {
      try {
        const power = await this.readPower(s);
        if (power === "on" || power === "screen_off") return toolResult("confirmed", TV_TEXT.alreadyOn, { data: { power, turned_on: false } });
        // 連得上但在待機（Quick Start+）：先試 SSAP 開機。
        try {
          await s.request(SSAP.turnOn);
          call.sent = true;
        } catch (err) {
          if (!(err instanceof SsapRejected)) throw err;
        }
        const deadline = this.now() + this.t.standbyWaitMs;
        while (this.now() < deadline && !signal.aborted) {
          await this.sleep(this.t.pollMs, signal);
          if ((await this.readPower(s).catch(() => "unknown" as TvPower)) === "on") return toolResult("confirmed", TV_TEXT.onConfirmed, { data: { power: "on", method: "ssap", turned_on: true } });
        }
      } finally {
        s.close();
      }
      if (!macs.length) return toolResult("unconfirmed", TV_TEXT.onUnconfirmed, { data: { method: "ssap" } });
    } else if (!macs.length) {
      return toolResult("failed", TV_TEXT.noMac, { reason: "unavailable" });
    }
    const send = this.options.wol ?? sendWol;
    const broadcast = this.options.broadcast ?? null;
    const wol = async () => {
      for (const mac of macs) await send(mac, broadcast);
    };
    try {
      await wol();
      call.sent = true;
    } catch {
      return toolResult("failed", "網路喚醒封包送不出去（Mac 的網路），沒有開機。", { reason: "unavailable" });
    }
    const deadline = this.now() + this.t.wakeWaitMs;
    while (this.now() < deadline && !signal.aborted) {
      await this.sleep(this.t.pollMs, signal);
      const c = await this.tryConnect(key, signal).catch((err) => {
        // 喚醒已送出：配對錯誤也不能說「沒有送出」。
        if (err instanceof SsapPairingRequired) return "pairing" as const;
        return null;
      });
      if (c === "pairing") return toolResult("unconfirmed", TV_TEXT.onPairingAfterWake, { data: { method: "wake_on_lan" } });
      if (c) {
        try {
          if ((await this.readPower(c).catch(() => "unknown" as TvPower)) === "on") return toolResult("confirmed", TV_TEXT.onConfirmed, { data: { power: "on", method: "wake_on_lan", turned_on: true } });
        } finally {
          c.close();
        }
      }
      // 社群經驗：等待期間補送封包，喚醒成功率較高（中止後不再送）。
      if (signal.aborted) break;
      await wol().catch(() => undefined);
    }
    return toolResult("unconfirmed", TV_TEXT.onUnconfirmed, { data: { method: "wake_on_lan" } });
  }

  private async powerOff(key: string, signal: AbortSignal, call: Call): Promise<ToolResult> {
    const s = await this.tryConnect(key, signal);
    if (!s) return toolResult("failed", TV_TEXT.offUnreachable, { reason: "unavailable", data: { sent: false } });
    try {
      const power = await this.readPower(s);
      if (power === "standby") return toolResult("confirmed", TV_TEXT.alreadyOff, { data: { power } });
      // 關機時電視可能直接斷線，回覆不可靠（aiowebostv 也不等回覆）。
      if (!s.send(SSAP.turnOff)) return toolResult("failed", TV_TEXT.unreachable, { reason: "unavailable" });
      call.sent = true;
    } finally {
      s.close();
    }
    const deadline = this.now() + this.t.offWaitMs;
    while (this.now() < deadline && !signal.aborted) {
      await this.sleep(this.t.pollMs, signal);
      const c = await this.tryConnect(key, signal).catch(() => null);
      if (!c) return toolResult("confirmed", TV_TEXT.offConfirmed, { data: { power: "off_or_unreachable" } });
      try {
        if ((await this.readPower(c).catch(() => "unknown" as TvPower)) === "standby") return toolResult("confirmed", TV_TEXT.offConfirmed, { data: { power: "standby" } });
      } finally {
        c.close();
      }
    }
    return toolResult("unconfirmed", TV_TEXT.offUnconfirmed);
  }

  private async volume(s: SsapSession, args: Record<string, unknown>, signal: AbortSignal, call: Call): Promise<ToolResult> {
    const action = String(args.action);
    const before = (await this.readAudio(s)).volume;
    let expect: number | null;
    if (action === "set") {
      if (typeof args.level !== "number") return toolResult("refused", "要設定音量時需要 level（0–100），沒有送出。", { reason: "invalid_arguments" });
      expect = Math.max(0, Math.min(100, Math.round(args.level)));
      await s.request(SSAP.setVolume, { volume: expect });
      call.sent = true;
    } else {
      const steps = typeof args.steps === "number" ? Math.max(1, Math.min(10, Math.round(args.steps))) : 1;
      for (let i = 0; i < steps; i++) {
        if (i) await this.sleep(this.t.stepMs, signal);
        await s.request(action === "up" ? SSAP.volumeUp : SSAP.volumeDown);
        call.sent = true;
      }
      expect = before === null ? null : Math.max(0, Math.min(100, before + (action === "up" ? steps : -steps)));
    }
    const after = (await this.readAudio(s)).volume;
    const ok = after !== null && (expect === null ? after !== before : after === expect);
    return toolResult(ok ? "confirmed" : "unconfirmed", ok ? TV_TEXT.volumeConfirmed : TV_TEXT.volumeUnconfirmed, { data: { before, volume: after } });
  }

  private async mute(s: SsapSession, muted: boolean, call: Call): Promise<ToolResult> {
    await s.request(SSAP.setMute, { mute: muted });
    call.sent = true;
    const after = (await this.readAudio(s)).muted;
    return after === muted
      ? toolResult("confirmed", TV_TEXT.muteConfirmed, { data: { muted } })
      : toolResult("unconfirmed", TV_TEXT.muteUnconfirmed, { data: { muted: after } });
  }

  private async waitForeground(s: SsapSession, appId: string, signal: AbortSignal): Promise<boolean> {
    const deadline = this.now() + this.t.appWaitMs;
    for (;;) {
      if ((await this.readForeground(s).catch(() => null)) === appId) return true;
      if (this.now() >= deadline || signal.aborted) return false;
      await this.sleep(Math.min(this.t.pollMs, 1_000), signal);
    }
  }

  private async input(s: SsapSession, query: string, signal: AbortSignal, call: Call): Promise<ToolResult> {
    const r = await s.request(SSAP.inputs);
    const devices: InputDevice[] = (Array.isArray(r.devices) ? r.devices : [])
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object" && typeof (d as Record<string, unknown>).id === "string")
      .map((d) => ({ id: String(d.id).slice(0, 40), label: typeof d.label === "string" ? d.label.slice(0, 40) : String(d.id), appId: typeof d.appId === "string" ? d.appId : null, connected: typeof d.connected === "boolean" ? d.connected : null }));
    const device = resolveInput(query, devices);
    if (!device) return toolResult("failed", TV_TEXT.inputNotFound, { reason: "unavailable", data: { inputs: devices.slice(0, 8).map((d) => d.label) } });
    await s.request(SSAP.switchInput, { inputId: device.id });
    call.sent = true;
    const target = device.appId ?? `com.webos.app.${device.id.toLowerCase().replace(/_/g, "")}`;
    const ok = await this.waitForeground(s, target, signal);
    return toolResult(ok ? "confirmed" : "unconfirmed", ok ? TV_TEXT.inputConfirmed : TV_TEXT.inputUnconfirmed, { data: { input: device.id, label: device.label } });
  }

  private async launch(s: SsapSession, query: string, signal: AbortSignal, call: Call): Promise<ToolResult> {
    const points = await this.readLaunchPoints(s);
    const match = resolveApp(query, points);
    if (!match) {
      return toolResult("failed", TV_TEXT.appNotFound, { reason: "unavailable", data: { installed: points.filter((p) => !isSpotifyApp(p)).slice(0, 40).map((p) => p.title) } });
    }
    if (isSpotifyApp(match)) return toolResult("refused", TV_TEXT.appSpotify, { reason: "unavailable" });
    await s.request(SSAP.launch, { id: match.id });
    call.sent = true;
    const ok = await this.waitForeground(s, match.id, signal);
    return toolResult(ok ? "confirmed" : "unconfirmed", ok ? TV_TEXT.appConfirmed : TV_TEXT.appUnconfirmed, { data: { app: match.title, app_id: match.id } });
  }

  private async media(s: SsapSession, action: string): Promise<ToolResult> {
    const uri = SSAP.media[action as keyof typeof SSAP.media];
    if (!uri) return toolResult("refused", "不支援這個播放動作，沒有送出。", { reason: "invalid_arguments" });
    await s.request(uri);
    return toolResult("unconfirmed", TV_TEXT.mediaSent, { data: { action } });
  }
}

interface Call {
  sent: boolean;
}

/** 連線類錯誤 → 誠實狀態。sent＝這次呼叫已經有寫入被電視接受：之後的錯誤只能說「送出了但沒確認」或「結果不明」。 */
function errorResult(err: unknown, sent = false): ToolResult {
  if (sent) {
    if (err instanceof SsapRejected || err instanceof SsapPairingRequired) return toolResult("unconfirmed", TV_TEXT.sentThenError, { reason: "adapter_error" });
    return toolResult("unknown", TV_TEXT.lost, { reason: "adapter_error" });
  }
  if (err instanceof SsapPairingRequired) return toolResult("failed", TV_TEXT.pairingRejected, { reason: "unavailable" });
  if (err instanceof SsapUnreachable) return toolResult("failed", TV_TEXT.unreachable, { reason: "unavailable" });
  if (err instanceof SsapRejected) return toolResult("failed", TV_TEXT.rejected, { reason: "adapter_error" });
  if (err instanceof SsapLost) return toolResult("unknown", TV_TEXT.lost, { reason: "adapter_error" });
  return toolResult("unknown", TV_TEXT.lost, { reason: "adapter_error" });
}
