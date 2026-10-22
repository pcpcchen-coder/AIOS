// 武陵居中控（SmartHomeAI）的本機橋接（docs/12 H0 查詢、H1 控制）。
// 本機核心經區網呼叫中控 REST v1，權杖只留在這裡，不進瀏覽器、不進 OpenAI 的工作階段。
// 讀值照中控回報：缺值是 null，不補 0；快照、過期資料要標出來，不當成即時值。
// 控制照中控的結果回報：只有 confirmed 是成功；unconfirmed、沒有回覆都不說成成功。

import { randomUUID } from "node:crypto";
import {
  commandText,
  HOME_COMMANDS,
  type DeviceReport,
  type HomeCommand,
  type HomeControlResult,
  type HomeStatusResult,
  type HomeTarget,
  type RefusedReason,
} from "../shared/home.ts";

const TIMEOUT_MS = 8_000;
const MAX_DEVICES = 12;
/** 中控的控制是同步的：送出後等 0.4 秒再回讀設備（最多 14 秒），所以逾時要比它長。 */
const COMMAND_TIMEOUT_MS = 16_000;
/** POST /devices/{id}/refresh 也是同步回讀（最多 14 秒）。 */
const REFRESH_TIMEOUT_MS = 15_000;
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60_000;
/** 伺服器端確認 ID 的期限；needs_confirmation 帶剩下的秒數，瀏覽器的確認卡取 60 秒與它的較小值。 */
const CONFIRM_TTL_MS = 90_000;
const MAX_PENDING = 8;

export interface HomeBridgeOptions {
  /** SMARTHOME_URL，例如 http://127.0.0.1:8788；分機部署時改成中控的區網位址。 */
  url: string | null;
  /** SMARTHOME_TOKEN，中控「系統接入」核發的權杖。 */
  token: string | null;
  fetch?: typeof fetch;
  /** 念給使用者聽的時間用哪個時區；未指定時用這台電腦的時區。 */
  timeZone?: string;
  /**
   * 只給測試用：讓確認卡流程可以被觸發。不從 .env 或任何檔案讀，nous.ts 也不傳，所以出貨時每台設備都是 allow
   * （George 的決定）。H2 改讀中控每台設備的 voice 設定後刪掉。
   */
  policyFor?: (device: HubDevice) => VoicePolicy;
  /** 毫秒；速率限制與確認卡期限用，測試可替換。 */
  now?: () => number;
  /** 指令 ID（Idempotency-Key）與確認卡 ID 的來源，測試可替換。 */
  newId?: () => string;
  /** 測試用：縮短控制與重新讀取的逾時。 */
  commandTimeoutMs?: number;
  refreshTimeoutMs?: number;
}

export type VoicePolicy = "allow" | "confirm" | "off";

/** home_control 的原始參數（模型送來的字串）；只在 parseCommand 解析一次。 */
export interface ControlRequest {
  target: string;
  command: string;
  value?: string | number | boolean | null;
}

/** 中控 GET /api/v1/home 裡 AIOS 會用到的部分（在邊界解析，其他欄位忽略）。 */
export interface HubMetric {
  key: string;
  label: string;
  unit: string;
  precision: number;
  value: number | string | boolean | null;
}

export type HubDataStatus = "live" | "snapshot" | "stale" | "missing";

export interface HubDevice {
  id: string;
  name: string;
  aliases: string[];
  kind: string;
  roomId: string | null;
  available: boolean | null;
  fresh: boolean;
  /** 中控判斷的「已完成設備接入」；中控沒給時當作 true，交給中控自己拒絕。 */
  configured: boolean;
  /** H1 不送 commands 的設備：冷氣與紅外線家電要走中控的專用路徑（H1b），其他遙控器／按鈕沒有可用的指令。 */
  unsupported: UnsupportedRoute | null;
  telemetry: { metrics: HubMetric[]; status: HubDataStatus; receivedAt: number | null; source: string } | null;
}

export type UnsupportedRoute = "air_con" | "infrared" | "remote";

export interface HubSnapshot {
  rooms: { id: string; name: string }[];
  devices: HubDevice[];
  serverTime: number;
}

export class HomeBridgeError extends Error {
  constructor(message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options);
  }
}

/** 語音可能說的讀值名稱 → 中控的 metric key。 */
const METRICS: Record<string, string[]> = {
  temperature: ["溫度", "氣溫", "幾度"],
  humidity: ["濕度", "溼度"],
  co2: ["二氧化碳", "co2"],
  pm25: ["pm2.5", "pm25"],
  pm10: ["pm10"],
  voc: ["voc"],
  formaldehyde: ["甲醛"],
  illuminance: ["照度", "亮度"],
  battery: ["電池", "電量"],
  power_usage: ["功率", "耗電"],
  energy: ["用電", "累積用電"],
  presence: ["有人", "人體存在"],
  motion: ["移動", "人體感應"],
  leak: ["漏水"],
  contact: ["門窗"],
};

const WHOLE_HOME = new Set(["家", "全家", "家裡", "全部", "所有", "全屋", "家中", "整個家"]);
/** 句尾的「的、裡、裡面、內」（「客廳裡」「家裡的」）；不動句首，避免吃掉「中庭」「內室」這類名稱。 */
const TRAILING = /(的|裡|裡面|內)+$/;
const DATA_TEXT = { live: "即時", snapshot: "快照", stale: "過期資料", missing: "沒有讀值" } as const;

function norm(text: string): string {
  return text
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 回傳中控 metric key；不認得時回傳 null。 */
export function metricKey(text: string): string | null {
  const t = norm(text);
  if (!t) return null;
  for (const [key, words] of Object.entries(METRICS)) {
    if (t === key || words.some((w) => t === norm(w))) return key;
  }
  return null;
}

/** 把「客廳溫度」這類說法拆成目標與讀值。 */
function splitMetric(target: string): { rest: string; metric: string | null } {
  for (const [key, words] of Object.entries(METRICS)) {
    for (const w of words) {
      const n = norm(w);
      if (target.includes(n)) return { rest: target.replace(n, ""), metric: key };
    }
  }
  return { rest: target, metric: null };
}

const ON = new Set(["true", "on", "開", "開啟", "打開"]);
const OFF = new Set(["false", "off", "關", "關閉", "關掉"]);

function toBool(value: ControlRequest["value"]): boolean | null {
  if (typeof value === "boolean") return value;
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ON.has(t) ? true : OFF.has(t) ? false : null;
}

/** 「60」「60%」「3000K」→ 數字；其他回傳 null。 */
function toNumber(value: ControlRequest["value"], unit: RegExp): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const t = value.trim().replace(unit, "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const isCommandName = (c: string): c is HomeCommand["command"] => (HOME_COMMANDS as readonly string[]).includes(c);

/** 解析模型送來的指令與數值；不合中控規則的在這裡就拒絕，不送到中控。 */
export function parseCommand(command: string, value: ControlRequest["value"]): HomeCommand | { error: string } {
  const c = command.trim();
  if (!isCommandName(c)) return { error: `不認得的控制指令「${command}」。` };
  switch (c) {
    case "power":
    case "mute": {
      const v = toBool(value);
      return v === null ? { error: c === "power" ? "要開還是關？" : "要靜音還是取消靜音？" } : { command: c, value: v };
    }
    case "brightness":
    case "volume": {
      const v = toNumber(value, /%$/);
      if (v === null || v < 0 || v > 100) return { error: `${c === "brightness" ? "亮度" : "音量"}要在 0 到 100 之間。` };
      return { command: c, value: Math.round(v) };
    }
    case "color_temperature": {
      const v = toNumber(value, /\s*k$/i);
      if (v === null || v < 2500 || v > 9000) return { error: "色溫要在 2500 到 9000 K 之間（這是燈的色溫；冷氣溫度還不能用語音控制）。" };
      return { command: c, kelvin: Math.round(v) };
    }
    case "color": {
      const t = typeof value === "string" ? value.trim() : "";
      return /^#[0-9a-fA-F]{6}$/.test(t) ? { command: c, value: t.toUpperCase() } : { error: "顏色要用 #RRGGBB 表示。" };
    }
    case "cover": {
      const t = typeof value === "string" ? value.trim().toLowerCase() : "";
      return t === "open" || t === "close" || t === "stop" ? { command: c, value: t } : { error: "窗簾要 open、close 或 stop。" };
    }
    default:
      return { command: c };
  }
}

/** 送到中控 POST /devices/{id}/commands 的內容；只有這裡知道色溫在中控叫 temperature。 */
function toWire(c: HomeCommand): { command: string; value: boolean | number | string | null } {
  switch (c.command) {
    case "color_temperature":
      return { command: "temperature", value: c.kelvin };
    case "play":
    case "pause":
    case "stop":
      return { command: c.command, value: null };
    default:
      return { command: c.command, value: c.value };
  }
}

const names = (d: HubDevice) => [d.name, ...d.aliases].map(norm).filter(Boolean);

export type Resolution =
  | { kind: "match"; scope: string; devices: HubDevice[]; metric: string | null }
  | { kind: "ambiguous"; candidates: HubDevice[] }
  | { kind: "not_found" };

/**
 * 確定性名稱比對（中控提供 GET /resolve 之前的過渡），不呼叫任何模型：
 * 全家 → 設備或別名完全相同 → 房間完全相同 → 房間加設備名稱 → 名稱包含關係。
 * 整句找不到時，再把讀值名稱拿掉重找（「客廳溫度」→ 客廳＋溫度）。
 */
export function resolveTarget(home: HubSnapshot, target: string): Resolution {
  const whole = norm(target);
  const direct = resolveVariants(home, whole);
  if (direct.kind === "match") return { ...direct, metric: null };
  if (direct.kind === "ambiguous") return direct;
  const split = splitMetric(whole);
  if (!split.metric) return direct;
  const rest = resolveVariants(home, split.rest);
  return rest.kind === "match" ? { ...rest, metric: split.metric } : rest;
}

type NameMatch = { kind: "match"; scope: string; devices: HubDevice[] } | Exclude<Resolution, { kind: "match" }>;

/** 先用原字串比對，找不到再去掉句尾的「的、裡」重找。 */
function resolveVariants(home: HubSnapshot, t: string): NameMatch {
  const first = resolveName(home, t);
  const trimmed = t.replace(TRAILING, "");
  return first.kind === "not_found" && trimmed !== t ? resolveName(home, trimmed) : first;
}

function resolveName(home: HubSnapshot, t: string): NameMatch {
  if (!t || WHOLE_HOME.has(t)) return { kind: "match", scope: "全家", devices: home.devices };

  const exact = home.devices.filter((d) => names(d).includes(t));
  if (exact.length === 1) return { kind: "match", scope: exact[0].name, devices: exact };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  const inRooms = (ids: Set<string>) => home.devices.filter((d) => d.roomId !== null && ids.has(d.roomId));
  const rooms = home.rooms.filter((r) => norm(r.name) === t);
  if (rooms.length) return { kind: "match", scope: rooms[0].name, devices: inRooms(new Set(rooms.map((r) => r.id))) };

  // 句中出現房間名稱時取最長的那個（「主臥浴室」優先於「主臥」）；同名房間一起算。
  const longest = Math.max(0, ...home.rooms.map((r) => norm(r.name)).filter((n) => n && t.includes(n)).map((n) => n.length));
  const named = home.rooms.filter((r) => longest > 0 && norm(r.name).length === longest && t.includes(norm(r.name)));
  if (named.length) {
    const rest = t.replace(norm(named[0].name), "").replace(/^的+/, "").replace(TRAILING, "");
    const pool = inRooms(new Set(named.map((r) => r.id)));
    if (!rest) return { kind: "match", scope: named[0].name, devices: pool };
    const inRoom = partialMatch(pool, rest);
    if (inRoom.kind !== "not_found") return inRoom;
  }
  return partialMatch(home.devices, t);
}

function partialMatch(pool: HubDevice[], t: string): NameMatch {
  const partial = pool.filter((d) => names(d).some((n) => n.includes(t) || t.includes(n)));
  if (partial.length === 1) return { kind: "match", scope: partial[0].name, devices: partial };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };
  return { kind: "not_found" };
}

/** 中控收到讀值的時間；不是同一天時加上日期，避免把幾天前的資料說成今天。 */
function clock(epochSeconds: number, nowSeconds: number, timeZone: string | undefined): string {
  const at = new Date(epochSeconds * 1000);
  const day = (d: Date) => d.toLocaleDateString("zh-TW", { timeZone });
  const time = at.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  if (day(at) === day(new Date(nowSeconds * 1000))) return time;
  return `${at.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric", timeZone })} ${time}`;
}

function round(value: HubMetric["value"], precision: number): HubMetric["value"] {
  if (typeof value !== "number") return value;
  const p = Math.max(0, Math.min(3, precision));
  return Number(value.toFixed(p));
}

export function report(home: HubSnapshot, d: HubDevice, metric: string | null, timeZone?: string): DeviceReport {
  const room = home.rooms.find((r) => r.id === d.roomId)?.name ?? null;
  const online = d.available === true && d.fresh ? "在線" : d.available === false ? "離線" : "狀態未知";
  const t = d.telemetry;
  if (!t) return { device: d.name, room, online, data: null, time: null, minutes_ago: null, source: null, readings: [] };
  const metrics = metric ? t.metrics.filter((m) => m.key === metric) : t.metrics;
  return {
    device: d.name,
    room,
    online,
    data: DATA_TEXT[t.status],
    time: t.receivedAt === null ? null : clock(t.receivedAt, home.serverTime, timeZone),
    minutes_ago: t.receivedAt === null ? null : Math.max(0, Math.round((home.serverTime - t.receivedAt) / 60)),
    source: t.source || null,
    readings: metrics.map((m) => ({ name: m.label, value: round(m.value, m.precision), unit: m.unit })),
  };
}

/** 候選名稱：設備名稱裡沒有房間時加上房間（「客廳的立燈」）。 */
function candidates(home: HubSnapshot, devices: HubDevice[]): string[] {
  return devices.slice(0, 5).map((d) => {
    const room = home.rooms.find((r) => r.id === d.roomId)?.name;
    return room && !norm(d.name).includes(norm(room)) ? `${room}的${d.name}` : d.name;
  });
}

/** 一次 POST 的結果（不出 HomeBridge）。 */
type HubReply =
  | { kind: "result"; status: "confirmed" | "unconfirmed" | "failed"; message: string }
  | { kind: "stale" }
  | { kind: "refused"; reason: Extract<RefusedReason, "not_configured" | "unsupported" | "invalid_value">; message: string }
  /** 同一把 key 用在不同指令：只可能是 AIOS 的錯（每個意圖都產生新 key），不重試。 */
  | { kind: "key_conflict" }
  | { kind: "gone" }
  /** maybeReceived：逾時、連上後中斷或 5xx，中控可能已經執行；連線被拒則一定沒收到。 */
  | { kind: "retry"; maybeReceived: boolean };

/** control() 時就綁定設備、指令與 key；瀏覽器只拿到不透明的 confirm_id，改不了要執行的內容。 */
interface PendingCommand {
  deviceId: string;
  target: HomeTarget;
  command: HomeCommand;
  key: string;
  expiresAt: number;
  /** 第一次同意後的執行；重複同意（或之後的拒絕）都拿到同一個結果，不會送第二次。 */
  run: Promise<HomeControlResult> | null;
}

export class HomeBridge {
  private readonly fetch: typeof fetch;
  private readonly base: string | null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly pending = new Map<string, PendingCommand>();
  /** 最近一分鐘送出的控制指令時間（只算第一次送出；同 key 重試、重新讀取不算）。 */
  private sent: number[] = [];

  constructor(private readonly options: HomeBridgeOptions) {
    this.fetch = options.fetch ?? fetch;
    this.base = options.url ? options.url.replace(/\/+$/, "") : null;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  get available(): boolean {
    return !!(this.base && this.options.token);
  }

  /** 啟動訊息與設定畫面用的說明；不含權杖。 */
  get detail(): string {
    if (!this.base) return "未設定 SMARTHOME_URL";
    if (!this.options.token) return "未設定 SMARTHOME_TOKEN";
    return `${this.base}（查詢與控制）`;
  }

  async status(target: string, metric?: string | null): Promise<HomeStatusResult> {
    const home = await this.home();
    const resolved = resolveTarget(home, target);
    if (resolved.kind === "not_found") return { ok: true, status: "not_found", target };
    if (resolved.kind === "ambiguous") {
      return {
        ok: true,
        status: "ambiguous",
        candidates: candidates(home, resolved.candidates),
      };
    }
    if (metric && !metricKey(metric)) return { ok: true, status: "no_such_reading", scope: resolved.scope, metric };
    const key = (metric ? metricKey(metric) : null) ?? resolved.metric;
    const devices = key ? resolved.devices.filter((d) => d.telemetry?.metrics.some((m) => m.key === key)) : resolved.devices;
    if (key && !devices.length) return { ok: true, status: "no_such_reading", scope: resolved.scope, metric: METRICS[key][0] };
    return {
      ok: true,
      status: "ok",
      scope: resolved.scope,
      devices: devices.slice(0, MAX_DEVICES).map((d) => report(home, d, key, this.options.timeZone)),
      truncated: devices.length > MAX_DEVICES,
    };
  }

  /**
   * home_control：解析指令 → 讀中控設備清單比對名稱 → 只控制一台 → 依政策直接執行或等確認卡。
   * 只在完全無法和中控溝通時丟 HomeBridgeError（未設定、連不上、權杖被拒、格式不符），和 status() 相同。
   */
  async control(req: ControlRequest): Promise<HomeControlResult> {
    const command = parseCommand(req.command, req.value ?? null);
    if ("error" in command) return { ok: true, status: "refused", reason: "invalid_value", message: command.error };
    const home = await this.home();
    const resolved = resolveTarget(home, req.target);
    if (resolved.kind === "not_found") return { ok: true, status: "not_found", target: req.target };
    if (resolved.kind === "ambiguous") return { ok: true, status: "ambiguous", candidates: candidates(home, resolved.candidates) };
    if (!resolved.devices.length) return { ok: true, status: "not_found", target: req.target };
    // 說的是房間或全家（即使裡面只有一台）就是房間指令，那是 H3：先問是哪一台，不一次控制多台。
    if (resolved.devices.length > 1 || resolved.scope !== resolved.devices[0].name) {
      return { ok: true, status: "ambiguous", candidates: candidates(home, resolved.devices) };
    }

    const device = resolved.devices[0];
    const target: HomeTarget = { device: device.name, room: home.rooms.find((r) => r.id === device.roomId)?.name ?? null };
    const refuse = (reason: RefusedReason, message: string): HomeControlResult => ({ ok: true, status: "refused", reason, message, ...target });
    if (device.unsupported) return refuse("unsupported", `${device.name}${UNSUPPORTED_TEXT[device.unsupported]}`);
    if (!device.configured) return refuse("not_configured", `${device.name}還沒在中控完成設備接入，指令沒有送出。`);

    const policy = this.options.policyFor?.(device) ?? "allow";
    if (policy === "off") return refuse("voice_disabled", `${device.name}沒有開放語音控制。`);
    const entry = { deviceId: device.id, target, command, key: `nous_${this.newId()}` };
    if (policy === "allow") return this.submit(entry);

    this.prune();
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const confirmId = `home_${this.newId()}`;
    this.pending.set(confirmId, { ...entry, expiresAt: this.now() + CONFIRM_TTL_MS, run: null });
    return { ok: true, status: "needs_confirmation", confirm_id: confirmId, action: commandText(command), expires_in_s: CONFIRM_TTL_MS / 1000, ...target };
  }

  /**
   * 確認卡結束。approve=false 只丟掉這張卡（不呼叫中控）；approve=true 用 control() 時綁定的內容與 key 送出，
   * 重複呼叫拿到同一個結果。找不到或過期的 ID 回 expired。不重新比對名稱：使用者確認的是卡上寫的那台。
   */
  async confirm(confirmId: string, approve: boolean): Promise<HomeControlResult> {
    this.prune();
    const p = this.pending.get(confirmId);
    if (!p) return { ok: true, status: "refused", reason: "expired", message: "這張確認卡已經失效，沒有執行。" };
    if (p.run) return p.run;
    if (!approve) {
      this.pending.delete(confirmId);
      return { ok: true, status: "refused", reason: "declined", message: `沒有確認，${p.target.device}${commandText(p.command)}沒有執行。`, ...p.target };
    }
    p.run = this.submit(p);
    return p.run;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  /** 速率限制：一分鐘內第 7 個指令不送出，回傳要等幾秒；沒超過時記下這一次。 */
  private takeRate(): number | null {
    const now = this.now();
    this.sent = this.sent.filter((t) => t > now - RATE_WINDOW_MS);
    if (this.sent.length >= RATE_LIMIT) return Math.max(1, Math.ceil((this.sent[0] + RATE_WINDOW_MS - now) / 1000));
    this.sent.push(now);
    return null;
  }

  /**
   * 送出一個使用者意圖。state_stale 時重新讀取設備一次，再用同一把 key 重送：中控在記下 key 之前就回 409，
   * 所以不會執行兩次。重新讀取後仍不能控制就照實說沒有送出。最壞的時間見 send()。
   */
  private async submit(p: Omit<PendingCommand, "expiresAt" | "run">): Promise<HomeControlResult> {
    const action = commandText(p.command);
    const base = { ok: true as const, action, ...p.target };
    const wait = this.takeRate();
    if (wait !== null) {
      return { ok: true, status: "refused", reason: "rate_limited", retry_after_s: wait, message: `一分鐘內控制指令太多，這個沒有送出，請等 ${wait} 秒再說。`, ...p.target };
    }
    const reply = await this.send(p);
    switch (reply.kind) {
      case "result":
        if (reply.status === "confirmed") return { ...base, status: "confirmed", message: reply.message || "設備回讀已確認" };
        if (reply.status === "failed") return { ...base, status: "failed", reason: "device", message: reply.message || "中控回報失敗" };
        return { ...base, status: "unconfirmed", why: "hub_unverified", message: reply.message || "已送出，尚未從設備確認" };
      case "stale":
        return { ok: true, status: "refused", reason: "not_ready", message: `${p.target.device}的狀態還沒更新，指令沒有送出；請稍後再試，或先在中控重新讀取設備。`, ...p.target };
      case "refused":
        return { ok: true, status: "refused", reason: reply.reason, message: reply.reason === "invalid_value" ? reply.message : `${p.target.device}${reply.message}`, ...p.target };
      case "key_conflict":
        return { ...base, status: "failed", reason: "internal", message: "AIOS 內部錯誤：指令編號重複，沒有執行" };
      case "gone":
        return { ok: true, status: "not_found", target: p.target.device };
      case "retry":
        return reply.maybeReceived
          ? { ...base, status: "unconfirmed", why: "no_reply", message: "中控沒有回覆，不確定有沒有執行，請看一下設備" }
          : { ...base, status: "failed", reason: "hub_unreachable", message: "無法連線到武陵居中控，指令沒有送出" };
    }
  }

  /**
   * 一個意圖最多 POST 兩次，都用同一把 key 與內容（中控會回傳已記下的結果，不會再執行）。
   * 唯一的一次重送給第一次的逾時、5xx 或連線問題，或給 state_stale（先重新讀取設備）；重送之後不論結果都不再送。
   * 最壞：POST 16 秒 + 重新讀取 15 秒 + POST 16 秒 = 47 秒（算法見 docs/validation/smarthome-h1-2026-10-22.md）。
   */
  private async send(p: Omit<PendingCommand, "expiresAt" | "run">): Promise<HubReply> {
    const path = `/api/v1/devices/${encodeURIComponent(p.deviceId)}/commands`;
    const body = JSON.stringify(toWire(p.command));
    const first = await this.post(path, body, p.key);
    if (first.kind === "retry") {
      const second = await this.post(path, body, p.key);
      return second.kind === "retry" ? { kind: "retry", maybeReceived: first.maybeReceived || second.maybeReceived } : second;
    }
    if (first.kind === "stale" && (await this.refresh(p.deviceId))) return this.post(path, body, p.key);
    return first;
  }

  private async post(path: string, body: string, key: string): Promise<HubReply> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json", "Idempotency-Key": key },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS),
      });
    } catch (err) {
      return { kind: "retry", maybeReceived: !refusedConnection(err) };
    }
    this.checkAuth(res, "控制設備");
    const data: unknown = await res.json().catch(() => null);
    const detail = isRecord(data) ? data.detail : undefined;
    const code = isRecord(detail) ? str(detail.code) : "";
    const message = isRecord(detail) ? str(detail.message) : typeof detail === "string" ? detail : "";
    if (res.ok) {
      const status = isRecord(data) ? str(data.status) : "";
      const text = isRecord(data) ? str(data.message) : "";
      // 中控已記下但還沒完成（accepted／sent）或不認得的狀態，一律當成未確認，不說成功。
      return { kind: "result", status: status === "confirmed" || status === "failed" ? status : "unconfirmed", message: text };
    }
    if (res.status === 409 && code === "state_stale") return { kind: "stale" };
    if (res.status === 409 && code === "not_configured") return { kind: "refused", reason: "not_configured", message: "還沒在中控完成設備接入，指令沒有送出。" };
    if (res.status === 409 && typeof detail === "string") return { kind: "key_conflict" };
    if (res.status === 422 && code === "unsupported_command") return { kind: "refused", reason: "unsupported", message: "沒有這項控制功能，指令沒有送出。" };
    if (res.status === 422) return { kind: "refused", reason: "invalid_value", message: message ? `中控不接受這個數值：${message}` : "中控不接受這個指令的格式。" };
    if (res.status === 404 && code === "device_not_found") return { kind: "gone" };
    // 其他 404（例如舊版中控沒有這個路徑，FastAPI 回 "Not Found"）：路徑不存在，指令沒有執行。
    if (res.status === 404) throw new HomeBridgeError("武陵居中控沒有控制設備的介面（HTTP 404），可能是中控版本太舊；指令沒有送出。", 502);
    if (res.status >= 500) return { kind: "retry", maybeReceived: true };
    throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${res.status}）。`, 502);
  }

  /** POST /devices/{id}/refresh（同步回讀）；成功回 true，任何錯誤都回 false。 */
  private async refresh(deviceId: string): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.base}/api/v1/devices/${encodeURIComponent(deviceId)}/refresh`, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(this.options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS),
      });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" };
  }

  private checkAuth(res: Response, what: string): void {
    if (res.status === 401) throw new HomeBridgeError("武陵居中控拒絕了權杖（401），請到中控「系統接入」重新核發後更新 SMARTHOME_TOKEN。", 502);
    if (res.status === 403) throw new HomeBridgeError(`這把中控權杖沒有${what}的權限（403）。`, 502);
  }

  private async home(): Promise<HubSnapshot> {
    if (!this.base || !this.options.token) throw new HomeBridgeError("尚未設定武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）。", 409);
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/home`, {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      throw new HomeBridgeError(
        timedOut ? "武陵居中控沒有回應（逾時）。" : "無法連線到武陵居中控，請確認中控有在執行、位址正確。",
        502,
        { cause: err },
      );
    }
    this.checkAuth(res, "讀取設備");
    if (!res.ok) throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${res.status}）。`, 502);
    try {
      return parseHome(await res.json());
    } catch (err) {
      throw new HomeBridgeError("武陵居中控回傳的資料格式不符，無法讀取。", 502, { cause: err });
    }
  }
}

/** 連線被拒（ECONNREFUSED）：中控一定沒收到；其他錯誤（逾時、連上後中斷）都可能已經收到。 */
function refusedConnection(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return cause?.code === "ECONNREFUSED";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 中控的資料狀態；不認得的狀態有讀值時當過期資料，不說成即時，也不和讀值互相矛盾。 */
function dataStatus(status: string, metrics: HubMetric[]): HubDataStatus {
  if (status === "live" || status === "snapshot" || status === "stale" || status === "missing") return status;
  return metrics.some((m) => m.value !== null) ? "stale" : "missing";
}

/** Tuya 雲端的冷氣類別（kt 冷氣、ktkzq 冷氣控制器）；中控匯入時把它們當成 switch，只在 config.cloud_category 留下原類別。 */
const TUYA_AIR_CON = new Set(["kt", "ktkzq"]);

const UNSUPPORTED_TEXT: Record<UnsupportedRoute, string> = {
  air_con: "是冷氣，開關和溫度目前都還不能用語音控制。",
  infrared: "是紅外線設備，目前還不能用語音控制。",
  remote: "這類設備（遙控器、無線按鈕）目前還不能用語音控制。",
};

/**
 * 冷氣：AIFA、Tuya kt／ktkzq、Home Assistant 的 climate.* 實體；紅外線：中控的紅外線家電；
 * 其他 kind 是 remote 的（例如 Tuya wxkg 無線按鈕、wnykq 紅外線控制器本身）沒有可用的控制指令。
 */
function unsupportedRoute(kind: string, config: Record<string, unknown>, infrared: boolean): UnsupportedRoute | null {
  if (config.external_provider === "aifa" || kind === "air_conditioner" || TUYA_AIR_CON.has(str(config.cloud_category)) || str(config.entity_id).startsWith("climate.")) {
    return "air_con";
  }
  if (infrared || config.infrared_virtual === true) return "infrared";
  return kind === "remote" ? "remote" : null;
}

/** 解析 GET /api/v1/home；只取 AIOS 用得到的欄位。 */
export function parseHome(body: unknown): HubSnapshot {
  if (!isRecord(body) || !Array.isArray(body.devices)) throw new Error("missing devices");
  const layout = isRecord(body.layout) ? body.layout : {};
  const rooms = (Array.isArray(layout.rooms) ? layout.rooms : [])
    .filter(isRecord)
    .map((r) => ({ id: str(r.id), name: str(r.name) }))
    .filter((r) => r.id && r.name);
  const devices = body.devices.filter(isRecord).map((d): HubDevice => {
    const state = isRecord(d.state) ? d.state : {};
    const placement = isRecord(d.placement) ? d.placement : {};
    const config = isRecord(d.config) ? d.config : {};
    const t = isRecord(d.telemetry) ? d.telemetry : null;
    const metrics: HubMetric[] = (Array.isArray(t?.metrics) ? t.metrics : []).filter(isRecord).map((m) => ({
      key: str(m.key),
      label: str(m.label) || str(m.key),
      unit: str(m.unit),
      precision: num(m.precision) ?? 1,
      value: typeof m.value === "string" || typeof m.value === "boolean" ? m.value : num(m.value),
    }));
    return {
      id: str(d.id),
      name: str(d.name),
      aliases: Array.isArray(d.aliases) ? d.aliases.filter((a): a is string => typeof a === "string") : [],
      kind: str(d.kind),
      roomId: str(placement.room_id) || null,
      available: typeof state.available === "boolean" ? state.available : null,
      fresh: state.fresh === true,
      configured: d.configured !== false,
      unsupported: unsupportedRoute(str(d.kind), config, isRecord(d.infrared)),
      telemetry: t
        ? { metrics, status: dataStatus(str(t.status), metrics), receivedAt: num(t.received_at), source: str(t.source_label) }
        : null,
    };
  });
  return { rooms, devices: devices.filter((d) => d.id && d.name), serverTime: num(body.server_time) ?? Date.now() / 1000 };
}
