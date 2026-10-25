// 武陵居中控（SmartHomeAI）的本機橋接（docs/12 H0 查詢、H1 控制、H1b AIFA 冷氣與紅外線家電）。
// 本機核心經區網呼叫中控 REST v1，權杖只留在這裡，不進瀏覽器、不進 OpenAI 的工作階段。
// 讀值照中控回報：缺值是 null，不補 0；快照、過期資料要標出來，不當成即時值。
// 控制照中控的結果回報：只有 confirmed 是成功；unconfirmed、沒有回覆都不說成成功。AIFA 冷氣與紅外線家電沒有回讀，永遠不是 confirmed。
// 三條控制路徑都在這個檔案：control → planFor → sendCommands／sendAifa／sendIr → commandsReply／aifaReply／irReply。

import { randomUUID } from "node:crypto";
import {
  AC_FAN_TEXT,
  AC_FANS,
  AC_FEATURE_TEXT,
  AC_FEATURES,
  AC_MODE_TEXT,
  AC_MODES,
  AC_SWING_TEXT,
  AC_SWINGS,
  commandText,
  HOME_COMMANDS,
  IR_INTENT_TEXT,
  IR_INTENTS,
  keyAction,
  type AcFan,
  type AcFeature,
  type AcMode,
  type AcSwing,
  type DeviceReport,
  type HomeCommand,
  type HomeControlResult,
  type HomeStatusResult,
  type HomeTarget,
  type IrIntent,
  type RefusedReason,
  type SendFacts,
  type UnconfirmedWhy,
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

/**
 * H1b 的逾時（毫秒）。最壞時間的算法寫在 tests/home-bridge.test.ts 的 budget 測試與
 * docs/validation/smarthome-h1b-2026-10-22.md，測試把這些常數加起來，不另外寫死總和。
 */
export const H1B_TIMEOUTS_MS = {
  /** GET /home 與 GET /integrations/aifa 同時讀，各 8 秒。 */
  snapshot: TIMEOUT_MS,
  /** POST …/status：連線 5 + 授權 3 + 讀 3.6 秒，可能先換 AIFA 權杖（10 秒）。 */
  aifaStatus: 22_000,
  /** POST /integrations/aifa/discover：廠商清單 10 秒，可能先換權杖 10 秒，加上排隊。 */
  aifaDiscover: 25_000,
  /** AIFA 送出：中控沒有整體逾時（約 12.6 秒，換權杖約 22.6 秒）；同 key 重送等中控的鎖後拿已記下的結果。 */
  aifaSend: 16_000,
  aifaRetry: 12_000,
  /** 紅外線：Tuya 每次呼叫 8 秒，可能先取權杖 8 秒。 */
  irSend: 16_000,
  irRetry: 10_000,
} as const;
/** 中控冷卻（AIFA 全域 2 秒、紅外線每個控制器 1 秒）回 429 後，等這麼久再用同一把 key 重送一次。 */
export const COOLDOWN_WAIT_MS = { aifa: 2_200, infrared: 1_200 } as const;
/** 一句話（一次 control 或 confirm）在 AIFA／紅外線路徑最多花的時間；每一步的逾時都被它截短。 */
export const UTTERANCE_MS = 60_000;
/** 剩下的時間少於這個就不再開始 POST（第一次之前：沒有送出；之後：不確定有沒有執行）。 */
export const MIN_SEND_WINDOW_MS = 5_000;
/** AIFA 清單在 24 小時後失效；提早 10 分鐘重新讀取，避免送出途中跨過期限。 */
const AIFA_LIST_TTL_S = 86_400;
const AIFA_STALE_MARGIN_S = 600;
/**
 * 冷氣設定缺值時用的預設（要說出來）。特殊功能沒有回報時用 normal。
 * 模式預設自動（George 2026-10-25 決定，不分季節）：冷氣關著時控制器不記得模式，猜冷氣在冬天不合適。
 */
export const CLIMATE_DEFAULTS = { mode: "auto", temperature: 26, fan: "auto", swing: "auto" } as const satisfies {
  mode: AcMode;
  temperature: number;
  fan: AcFan;
  swing: AcSwing;
};

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
  /** 測試用：縮短 AIFA／紅外線各步驟的逾時。 */
  timeoutsMs?: Partial<Record<Exclude<keyof typeof H1B_TIMEOUTS_MS, "snapshot">, number>>;
  /** 中控冷卻後的等待；測試換成推進假時鐘。 */
  sleep?: (ms: number) => Promise<void>;
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

/** 紅外線家電同步到的一個按鍵，照中控 /home 的 infrared.keys[]。 */
export interface IrKey {
  key: string;
  key_id: number;
  label: string;
}

/** AIFA 冷氣（設定碼 173）的可用範圍，來自中控 GET /integrations/aifa 的 capabilities。 */
export interface AifaClimateCaps {
  minC: number;
  maxC: number;
  modes: AcMode[];
  fans: AcFan[];
  swings: AcSwing[];
  features: AcFeature[];
}

/**
 * 這台設備怎麼控制。只在 parseHome（routeOf）與 parseAifa 決定一次，之後都依它分流。
 * - commands：H1 的 POST /devices/{id}/commands；configured 只有這條路徑用得到。
 * - aifa：AIFA 冷氣（GET /integrations/aifa 的子設備，不是中控的設備）；listQueriedAt 是中控的時鐘（秒）。
 * - infrared：Tuya 紅外線家電；中控的 configured 對它永遠是 false，只看 infrared.ready。
 * - unsupported：冷氣但不是 AIFA（Tuya kt／ktkzq、Home Assistant climate.*）、AIFA 控制器本身、
 *   紅外線控制器本身（wnykq）、其他遙控器／按鈕、AIFA 的非冷氣家電。
 */
export type DeviceRoute =
  | { kind: "commands"; configured: boolean }
  | { kind: "aifa"; hubId: string; childId: string; climate: AifaClimateCaps | null; listQueriedAt: number | null }
  | { kind: "infrared"; keys: IrKey[]; ready: boolean; controllerName: string | null; error: string | null }
  | { kind: "unsupported"; why: UnsupportedWhy };

export type UnsupportedWhy = "air_con" | "aifa_controller" | "ir_blaster" | "remote" | "aifa_other";

export interface HubDevice {
  id: string;
  name: string;
  aliases: string[];
  kind: string;
  roomId: string | null;
  /** AIFA 冷氣：清單裡的 online，最多可能是 24 小時前的；所以 fresh 一律 false，查詢時不說成在線。 */
  available: boolean | null;
  fresh: boolean;
  /** 只有 AIFA 子設備有：available 是哪一次讀 AIFA 清單得到的（queried_at，中控時鐘的秒；沒有時 null）。離線要連時間一起說，不說成現在。 */
  listedAt?: number | null;
  route: DeviceRoute;
  telemetry: { metrics: HubMetric[]; status: HubDataStatus; receivedAt: number | null; source: string } | null;
}

/** GET /integrations/aifa 讀到了沒有；讀不到時不影響 /home 的設備，但「找不到冷氣」要說是清單讀不到。 */
export type AifaListState = "ok" | "not_connected" | "unavailable";

export interface HubSnapshot {
  rooms: { id: string; name: string }[];
  /** /home 的設備加上 AIFA 冷氣。 */
  devices: HubDevice[];
  serverTime: number;
  /** 只有 snapshot() 會填；parseHome 單獨用時沒有。 */
  aifa?: AifaListState;
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
      if (v === null || v < 2500 || v > 9000) return { error: "色溫要在 2500 到 9000 K 之間（這是燈的色溫；冷氣溫度請用 ac_temperature）。" };
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
    case "ac_temperature": {
      const v = toNumber(value, /\s*(度|°c|℃|c)$/i);
      if (v === null || !Number.isInteger(v)) return { error: "冷氣溫度要說整數度數，例如 26。" };
      return { command: c, celsius: v };
    }
    case "ac_mode": {
      const t = word(value);
      if (NO_SUCH_MODE.has(t)) return { error: "這台冷氣用語音只能設自動、冷氣或除濕，沒有暖氣和送風。" };
      const mode = AC_MODE_WORDS[t];
      return mode ? { command: c, value: mode } : { error: "冷氣模式要說自動、冷氣或除濕。" };
    }
    case "ac_fan": {
      const fan = AC_FAN_WORDS[word(value)];
      return fan ? { command: c, value: fan } : { error: "風量要說自動、低、中、高，或調大、調小。" };
    }
    case "ac_swing": {
      const t = word(value);
      const swing = (AC_SWINGS as readonly string[]).includes(t) ? (t as AcSwing) : t === "自動" ? "auto" : /^(固定)?[1-5]$/.test(t) ? (`fixed_${t.slice(-1)}` as AcSwing) : null;
      return swing ? { command: c, value: swing } : { error: "擺風要說自動，或固定 1 到 5。" };
    }
    case "press": {
      const t = typeof value === "string" ? value.trim() : "";
      if (!t) return { error: "要按哪一個鍵？" };
      const lower = t.toLowerCase();
      const intent = IR_INTENTS.find((i) => i === lower || IR_INTENT_TEXT[i] === t) ?? null;
      return { command: c, intent, spoken: t };
    }
    default:
      return { command: c };
  }
}

/** 小寫、去空白，給模式／風量／擺風比對用。 */
function word(value: ControlRequest["value"]): string {
  return typeof value === "string" ? value.replace(/\s+/g, "").toLowerCase() : "";
}

const AC_MODE_WORDS: Record<string, AcMode> = { auto: "auto", 自動: "auto", cool: "cool", 冷氣: "cool", 冷房: "cool", 製冷: "cool", dry: "dry", 除濕: "dry", 除溼: "dry" };
/** 中控的冷氣設定碼 173 沒有暖氣與送風：在本機就說清楚，不送出。 */
const NO_SUCH_MODE = new Set(["heat", "暖氣", "製熱", "制熱", "暖房", "fan_only", "fanonly", "fan", "送風"]);
const AC_FAN_WORDS: Record<string, AcFan | "up" | "down"> = {
  auto: "auto",
  自動: "auto",
  low: "low",
  低: "low",
  弱: "low",
  medium: "medium",
  中: "medium",
  high: "high",
  高: "high",
  強: "high",
  up: "up",
  調大: "up",
  大一點: "up",
  強一點: "up",
  down: "down",
  調小: "down",
  小一點: "down",
  弱一點: "down",
};

/** H1 的指令：只有這些會送到 POST /devices/{id}/commands。 */
const H1_COMMANDS = ["power", "brightness", "color_temperature", "color", "volume", "mute", "play", "pause", "stop", "cover"] as const;
type H1Command = Extract<HomeCommand, { command: (typeof H1_COMMANDS)[number] }>;
const isH1Command = (c: HomeCommand): c is H1Command => (H1_COMMANDS as readonly string[]).includes(c.command);

/** 送到中控 POST /devices/{id}/commands 的內容；只有這裡知道色溫在中控叫 temperature。 */
function toWire(c: H1Command): { command: string; value: boolean | number | string | null } {
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
  const resolved = resolveUntagged(home, target);
  // 候選的回答（「冷氣（AIFA）」「客廳的冷氣（紅外線遙控）」）：名稱比對照舊，再用路徑從候選裡挑。
  const tag = /aifa/i.test(target) ? "aifa" : /紅外線/.test(target) ? "infrared" : null;
  if (!tag) return resolved;
  // 名稱只比對到另一條路徑的一台（「客廳的冷氣（AIFA）」，但 AIFA 冷氣沒有房間）：路徑是使用者指定的，從全部設備裡找。
  const otherRoute = resolved.kind === "match" && resolved.devices.length === 1 && resolved.devices[0].route.kind !== tag;
  if (resolved.kind !== "ambiguous" && !otherRoute) return resolved;
  const byRoute = (resolved.kind === "ambiguous" ? resolved.candidates : home.devices).filter((d) => d.route.kind === tag);
  // 候選說法是「名稱」或「房間的名稱」：完全相同的優先（「客廳的冷氣」不要連「書房冷氣」也算進來）。
  const whole = norm(target);
  const said = byRoute.filter((d) => {
    const room = home.rooms.find((r) => r.id === d.roomId)?.name;
    const n = norm(d.name);
    return whole === n || (!!room && (whole === norm(room) + n || whole === `${norm(room)}的${n}`));
  });
  const picked = said.length ? said : otherRoute ? byRoute.filter((d) => names(d).some((n) => whole.includes(n))) : byRoute;
  if (picked.length === 1) return { kind: "match", scope: picked[0].name, devices: picked, metric: null };
  return picked.length ? { kind: "ambiguous", candidates: picked } : resolved;
}

function resolveUntagged(home: HubSnapshot, target: string): Resolution {
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

/** 中控說離線；AIFA 子設備的 online 是讀清單當時的（最多 24 小時前），要說是什麼時候，不知道時間就說狀態未知。 */
function offline(d: HubDevice, nowSeconds: number, timeZone: string | undefined): DeviceReport["online"] {
  if (d.listedAt === undefined) return "離線";
  return d.listedAt === null ? "狀態未知" : `上次讀取 AIFA 清單時離線（${clock(d.listedAt, nowSeconds, timeZone)}）`;
}

export function report(home: HubSnapshot, d: HubDevice, metric: string | null, timeZone?: string): DeviceReport {
  const room = home.rooms.find((r) => r.id === d.roomId)?.name ?? null;
  const online = d.available === true && d.fresh ? "在線" : d.available === false ? offline(d, home.serverTime, timeZone) : "狀態未知";
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

const ROUTE_TAG: Partial<Record<DeviceRoute["kind"], string>> = { aifa: "（AIFA）", infrared: "（紅外線遙控）" };
const TAGGED_NOTE = "使用者選了之後，target 照候選名稱一字不差填，包括括號裡的（AIFA）或（紅外線遙控）。";

/**
 * 問是哪一台：設備名稱裡沒有房間時加上房間（「客廳的立燈」）。
 * AIFA 冷氣與紅外線家電一律加上路徑（「冷氣（AIFA）」「客廳的冷氣（紅外線遙控）」）：同名的設備一台有房間、
 * 一台沒有時（AIFA 冷氣常常沒有房間），只看名稱分不出來，照著說也選不到。有路徑時 note 請模型照抄候選名稱。
 */
function ambiguous(home: HubSnapshot, devices: HubDevice[]): { ok: true; status: "ambiguous"; candidates: string[]; note?: string } {
  const shown = devices.slice(0, 5);
  const labels = shown.map((d) => {
    const room = home.rooms.find((r) => r.id === d.roomId)?.name;
    return `${room && !norm(d.name).includes(norm(room)) ? `${room}的${d.name}` : d.name}${ROUTE_TAG[d.route.kind] ?? ""}`;
  });
  return { ok: true, status: "ambiguous", candidates: labels, ...(shown.some((d) => ROUTE_TAG[d.route.kind]) ? { note: TAGGED_NOTE } : {}) };
}

/** 一次 POST 的結果（不出 HomeBridge）。 */
type HubReply =
  | { kind: "result"; status: "confirmed" | "unconfirmed" | "failed"; message: string; why?: UnconfirmedWhy; controller?: ControllerReport | null }
  /** commands：409 state_stale；AIFA：409「請先重新讀取 AIFA 家電清單」。中控在記下 key 之前就拒絕。 */
  | { kind: "stale" }
  /** AIFA／紅外線的冷卻 429：中控在記下 key 之前就拒絕，同一把 key 重送是安全的。 */
  | { kind: "cooldown"; retryAfterS: number }
  | { kind: "refused"; reason: Extract<RefusedReason, "not_configured" | "not_ready" | "unsupported" | "invalid_value">; message: string; retryAfterS?: number }
  /** 同一把 key 用在不同指令：只可能是 AIOS 的錯（每個意圖都產生新 key），不重試。 */
  | { kind: "key_conflict" }
  | { kind: "gone" }
  /** maybeReceived：逾時、連上後中斷或 5xx，中控可能已經執行；連線被拒則一定沒收到。 */
  | { kind: "retry"; maybeReceived: boolean }
  /** 這句話的時間（UTTERANCE_MS）不夠，沒有開始 POST：中控沒有收到。 */
  | { kind: "too_late" }
  /** AIOS 自己的每分鐘上限（RATE_LIMIT），在第一次 POST 之前：中控沒有收到。 */
  | { kind: "rate_limited"; retryAfterS: number };

type ReplyMapper = (status: number, data: unknown) => HubReply;

/** 控制器（不是冷氣本身）記得的設定；冷氣關著時 mode 與 temperature 是 null。 */
export interface ControllerReport {
  power: boolean | null;
  mode: AcMode | null;
  temperature: number | null;
  fan: AcFan | null;
  swing: AcSwing | null;
  feature: AcFeature | null;
}

export type ClimateChange = Extract<HomeCommand, { command: "ac_temperature" | "ac_mode" | "ac_fan" | "ac_swing" }>;

/** AIFA 冷氣設定的完整內容（中控要求每個欄位都有；feature 明確送出，避免把睡眠／強力清掉）。 */
export interface ClimatePacket {
  mode: AcMode;
  temperature: number;
  fan: AcFan;
  swing: AcSwing;
  feature: AcFeature;
}

interface AifaRef {
  hubId: string;
  childId: string;
  /** AIOS 時鐘（毫秒）：這之後 AIFA 清單就快到 24 小時，先重新讀取。 */
  freshUntil: number;
}

/** 要送出的內容在 control() 時就決定（確認卡執行的就是卡上那個）；紅外線的按鍵也在這時選好。冷氣設定的完整內容送出前才組。 */
export type Plan =
  | { route: "commands"; deviceId: string; command: H1Command }
  | { route: "aifa_power"; aifa: AifaRef; power: boolean }
  | { route: "aifa_climate"; aifa: AifaRef; change: ClimateChange; caps: AifaClimateCaps }
  | { route: "ir_key"; deviceId: string; key: IrKey; toggle: boolean };

/** control() 時就綁定計畫、動作說法與 key；瀏覽器只拿到不透明的 confirm_id，改不了要執行的內容。 */
interface PendingCommand {
  plan: Plan;
  target: HomeTarget;
  action: string;
  key: string;
  expiresAt: number;
  /** 第一次同意後的執行；重複同意（或之後的拒絕）都拿到同一個結果，不會送第二次。 */
  run: Promise<HomeControlResult> | null;
}

type Entry = Omit<PendingCommand, "expiresAt" | "run">;

type Refusal = { refuse: RefusedReason; message: string };

/**
 * 路徑檢查與計畫（純函式）。
 * commands：只接受 H1 指令，未完成接入就不送；aifa：開關或冷氣設定（範圍照那台的 capabilities）；
 * infrared：只按遙控鍵（電源、靜音或 press），按鍵要先同步好；unsupported：照實說不能用語音控制。
 * now／serverTime 用來換算 AIFA 清單什麼時候快過期（中控的時鐘和這台電腦可能不同）。
 */
export function planFor(device: HubDevice, c: HomeCommand, clock: { now: number; serverTime: number }): { plan: Plan; action: string } | Refusal {
  const route = device.route;
  const refuse = (reason: RefusedReason, message: string): Refusal => ({ refuse: reason, message });
  switch (route.kind) {
    case "unsupported":
      return refuse("unsupported", `${device.name}${UNSUPPORTED_TEXT[route.why]}`);
    case "commands":
      if (!isH1Command(c)) return refuse("unsupported", `${device.name}不是 AIFA 冷氣或紅外線家電，不能「${commandText(c)}」，指令沒有送出。`);
      if (!route.configured) return refuse("not_configured", `${device.name}還沒在中控完成設備接入，指令沒有送出。`);
      return { plan: { route: "commands", deviceId: device.id, command: c }, action: commandText(c) };
    case "aifa": {
      const left = route.listQueriedAt === null ? -Infinity : route.listQueriedAt + AIFA_LIST_TTL_S - AIFA_STALE_MARGIN_S - clock.serverTime;
      const aifa: AifaRef = { hubId: route.hubId, childId: route.childId, freshUntil: clock.now + left * 1000 };
      if (c.command === "power") return { plan: { route: "aifa_power", aifa, power: c.value }, action: commandText(c) };
      if (c.command !== "ac_temperature" && c.command !== "ac_mode" && c.command !== "ac_fan" && c.command !== "ac_swing") {
        return refuse("unsupported", `${device.name}是 AIFA 冷氣，用語音只能開關、設定溫度、模式、風量和擺風。`);
      }
      const caps = route.climate;
      if (!caps) return refuse("unsupported", `${device.name}${NO_CLIMATE_TEXT}`);
      const invalid = checkClimate(c, caps);
      if (invalid) return refuse("invalid_value", invalid);
      return { plan: { route: "aifa_climate", aifa, change: c, caps }, action: commandText(c) };
    }
    case "infrared": {
      if (c.command === "ac_temperature" || c.command === "ac_mode" || c.command === "ac_fan" || c.command === "ac_swing") {
        return refuse("unsupported", `${device.name}是紅外線遙控的家電，只能按它的遙控鍵（例如說「按溫度加」），不能直接設定溫度、模式或風量。`);
      }
      if (c.command === "volume") return refuse("unsupported", `${device.name}是紅外線家電，不能直接設定音量數字；可以說「大聲一點」或「小聲一點」，一次按一下。`);
      if (c.command !== "power" && c.command !== "mute" && c.command !== "press") {
        return refuse("unsupported", `${device.name}是紅外線家電，只能按遙控鍵（電源、音量、頻道等），不能「${commandText(c)}」。`);
      }
      if (!route.ready) {
        return refuse("not_ready", `${device.name}的遙控按鍵還沒同步或超過 24 小時，請在中控的紅外線控制器按「同步」；指令沒有送出。${route.error ? `（中控：${route.error}）` : ""}`);
      }
      const m = matchKey(device.name, route.keys, c);
      if ("refuse" in m) return m;
      return { plan: { route: "ir_key", deviceId: device.id, key: m.key, toggle: m.toggle }, action: keyAction(m.key.label) };
    }
  }
}

const NO_CLIMATE_TEXT = "是 AIFA 家電，但中控只確認了開關；溫度、模式、風量和擺風不能用語音設定，指令沒有送出。";

/** 冷氣設定的值是否在這台冷氣的範圍內；回傳要說的錯誤，或 null。 */
function checkClimate(c: ClimateChange, caps: AifaClimateCaps): string | null {
  switch (c.command) {
    case "ac_temperature":
      return c.celsius < caps.minC || c.celsius > caps.maxC ? `冷氣溫度要在 ${caps.minC} 到 ${caps.maxC} 度之間（整數），指令沒有送出。` : null;
    case "ac_mode":
      return caps.modes.includes(c.value) ? null : `這台冷氣用語音只能設${caps.modes.map((m) => AC_MODE_TEXT[m]).join("、")}，指令沒有送出。`;
    case "ac_fan":
      return c.value === "up" || c.value === "down" || caps.fans.includes(c.value) ? null : `這台冷氣沒有「風量${AC_FAN_TEXT[c.value]}」，指令沒有送出。`;
    case "ac_swing":
      return caps.swings.includes(c.value) ? null : `這台冷氣沒有「擺風${AC_SWING_TEXT[c.value]}」，指令沒有送出。`;
  }
}

/**
 * 組出完整的冷氣設定（純函式）：要改的那一項 → 控制器回報的值 → 預設值（CLIMATE_DEFAULTS；feature 是 normal），
 * 用了預設值的項目放在 defaultsUsed，一定要說出來。風量調大／調小要知道目前風量，不知道（或是自動）就不送。
 */
export function buildClimate(change: ClimateChange, report: ControllerReport | null, caps: AifaClimateCaps):
  | { packet: ClimatePacket; text: string; defaultsUsed: string[] }
  | { error: string } {
  const defaultsUsed: string[] = [];
  const pick = <T extends string | number>(reported: T | null | undefined, ok: (v: T) => boolean, fallback: T, label: string, show: (v: T) => string): T => {
    if (reported !== null && reported !== undefined && ok(reported)) return reported;
    defaultsUsed.push(`${label}：${show(fallback)}`);
    return fallback;
  };
  const r = report;
  const inRange = (t: number) => Number.isInteger(t) && t >= caps.minC && t <= caps.maxC;
  const defaultMode = caps.modes.includes(CLIMATE_DEFAULTS.mode) ? CLIMATE_DEFAULTS.mode : caps.modes[0];
  const defaultTemp = Math.min(caps.maxC, Math.max(caps.minC, CLIMATE_DEFAULTS.temperature));

  let fan: AcFan;
  if (change.command === "ac_fan") {
    if (change.value === "up" || change.value === "down") {
      const now = r?.fan;
      if (!now || now === "auto") return { error: "不知道目前風量，請說低、中、高或自動；指令沒有送出。" };
      const order: AcFan[] = ["low", "medium", "high"];
      const next = order[order.indexOf(now) + (change.value === "up" ? 1 : -1)];
      if (!next) return { error: change.value === "up" ? "風量已經是最高，指令沒有送出。" : "風量已經是最低，指令沒有送出。" };
      fan = next;
    } else fan = change.value;
  } else fan = pick(r?.fan, (v) => caps.fans.includes(v), CLIMATE_DEFAULTS.fan, "風量", (v) => AC_FAN_TEXT[v]);

  const mode = change.command === "ac_mode" ? change.value : pick(r?.mode, (v) => caps.modes.includes(v), defaultMode, "模式", (v) => AC_MODE_TEXT[v]);
  const temperature = change.command === "ac_temperature" ? change.celsius : pick(r?.temperature, inRange, defaultTemp, "溫度", (v) => `${v} 度`);
  const swing = change.command === "ac_swing" ? change.value : pick(r?.swing, (v) => caps.swings.includes(v), CLIMATE_DEFAULTS.swing, "擺風", (v) => AC_SWING_TEXT[v]);
  const feature = pick<AcFeature>(r?.feature, (v) => caps.features.includes(v), "normal", "特殊功能", (v) => AC_FEATURE_TEXT[v]);

  const packet: ClimatePacket = { mode, temperature, fan, swing, feature };
  const text = [`模式${AC_MODE_TEXT[mode]}`, `${temperature} 度`, `風量${AC_FAN_TEXT[fan]}`, `擺風${AC_SWING_TEXT[swing]}`, ...(feature === "normal" ? [] : [AC_FEATURE_TEXT[feature]])].join("、");
  return { packet, text, defaultsUsed };
}

/**
 * 關冷氣時中控會一併取消這台冷氣的定時（中控的固定做法；George 2026-10-25 決定要讓 AI 說出來）。
 * note 只放要念給使用者聽的句子；不能說的話（確實取消了、冷氣已經關了）在 realtimeToolRules。
 * AIOS 讀不到定時，不知道原本有沒有設定，所以句子是「如果有設定定時」。只在關機可能已送到中控時說：
 * - 已送出（one_way）：中控執行了關機，定時照中控做法取消。
 * - 中控沒有回覆或可能收到（no_reply、retry 且可能收到）：加上「如果中控有執行這次關機」。
 * - 失敗、沒有送出：不說（中控沒有執行關機；200 failed 時定時會不會被取消，要等 George 實測）。
 */
export const AC_OFF_TIMER_NOTE = "如果這台冷氣有設定定時，中控關機時會一併取消，需要的話請重新設定。";
export const AC_OFF_TIMER_NOTE_UNSURE = "如果中控有執行這次關機，而且這台冷氣有設定定時，定時也會一併取消，需要的話請重新設定。";
function acOffTimerNote(reply: HubReply): string | null {
  if (reply.kind === "result" && reply.status === "unconfirmed") return reply.why === "one_way" ? AC_OFF_TIMER_NOTE : AC_OFF_TIMER_NOTE_UNSURE;
  if (reply.kind === "retry" && reply.maybeReceived) return AC_OFF_TIMER_NOTE_UNSURE;
  return null;
}

/** 「控制器回報：開、冷氣、26 度、風量低」：只能這樣說，不是冷氣的實際狀態。 */
function reportedText(r: ControllerReport | null | undefined): string | undefined {
  if (!r) return undefined;
  const parts = [
    r.power === null ? null : r.power ? "開" : "關",
    r.mode ? AC_MODE_TEXT[r.mode] : null,
    r.temperature === null ? null : `${r.temperature} 度`,
    r.fan ? `風量${AC_FAN_TEXT[r.fan]}` : null,
    r.swing ? `擺風${AC_SWING_TEXT[r.swing]}` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? `控制器回報：${parts.join("、")}` : undefined;
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);

/** 中控 status／controller_status 物件 → ControllerReport；不是物件時 null。 */
function parseReport(v: unknown): ControllerReport | null {
  if (!isRecord(v)) return null;
  const t = num(v.temperature);
  return {
    power: typeof v.power === "boolean" ? v.power : null,
    mode: oneOf(AC_MODES, v.mode),
    temperature: t !== null && Number.isInteger(t) ? t : null,
    fan: oneOf(AC_FANS, v.fan),
    swing: oneOf(AC_SWINGS, v.swing),
    feature: oneOf(AC_FEATURES, v.feature),
  };
}

// ───────── 紅外線按鍵比對 ─────────

/**
 * 按鍵名稱正規化：NFKC（全形＋／－變成 +／-）、小寫、加→+、減→-、減號 −（U+2212）→-、▲／△→+、▼／▽→-，
 * 去掉空白與底線、去掉不在結尾的連字號（「ch-up」→「chup」，「Vol-」不變）。
 * 所以「音量▲」「Vol −」「頻道▼」和「音量+」「Vol-」「頻道-」一樣，不必另加同義詞。
 */
export function keyNorm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[加▲△]/g, "+")
    .replace(/[減−▼▽]/g, "-")
    .replace(/[\s_]/g, "")
    .replace(/-(?=.)/g, "");
}

/**
 * 每個意圖對應的按鍵名稱（正規化前）。power_on／power_off 是分開的開機、關機鍵；power 是切換鍵。
 * 刻意沒有「auto／低／on／高」這類字：紅外線冷氣遙控上它們是模式鍵，不是風速或電源。
 */
export const IR_SYNONYMS: { readonly [I in IrIntent | "power_on" | "power_off"]: readonly string[] } = {
  power_on: ["poweron", "開機", "電源開"],
  power_off: ["poweroff", "關機", "電源關"],
  power: ["power", "電源", "開關", "onoff", "pwr"],
  volume_up: ["vol+", "volume+", "volup", "volumeup", "音量+", "聲音+"],
  volume_down: ["vol-", "volume-", "voldown", "volumedown", "音量-", "聲音-"],
  mute: ["mute", "靜音"],
  channel_up: ["ch+", "chup", "channel+", "channelup", "頻道+"],
  channel_down: ["ch-", "chdown", "channel-", "channeldown", "頻道-"],
  fan_speed: ["speed", "fanspeed", "windspeed", "fan", "風速", "風量"],
  oscillate: ["swing", "oscillate", "osc", "shake", "擺頭", "搖頭", "擺動"],
};

const SYNONYM_SETS = Object.fromEntries(Object.entries(IR_SYNONYMS).map(([k, v]) => [k, new Set(v.map(keyNorm))])) as Record<keyof typeof IR_SYNONYMS, Set<string>>;
const MAX_KEY_LABELS = 8;

/**
 * 在設備實際同步的按鍵裡找要按的那一個（模型看不到 key_id）。
 * 1. 意圖（電源、音量、頻道…）照 IR_SYNONYMS 完全相同比對；開：先找開機鍵，再找電源切換鍵；關：先找關機鍵。
 *    意圖只再比對完全相同的按鍵名稱，不找包含的（「volume_up」不能落到導覽的「Up」，冷氣遙控上可能是溫度鍵）。
 * 2. 其他說法當成按鍵名稱：先完全相同，再找唯一一個包含它的。
 * 好幾個不同的鍵（key 與 key_id 都算；中控的 key_id 預設 0）→ 問要按哪一個；找不到 → 照實說沒有這個鍵，列出最多 8 個真的有的鍵。
 * 電源切換鍵與靜音鍵都是切換鍵（toggle）：按一下切換一次，「取消靜音」按的也是同一個鍵。
 */
export function matchKey(device: string, keys: IrKey[], c: Extract<HomeCommand, { command: "power" | "mute" | "press" }>): { key: IrKey; toggle: boolean } | Refusal {
  const label = (k: IrKey) => keyNorm(k.label);
  const inRow = (row: keyof typeof IR_SYNONYMS, k: IrKey) => SYNONYM_SETS[row].has(label(k)) || SYNONYM_SETS[row].has(keyNorm(k.key));
  const isToggle = (k: IrKey) => inRow("power", k) || inRow("mute", k);
  const id = (k: IrKey) => `${k.key}:${k.key_id}`;
  const decide = (hits: IrKey[]): { key: IrKey; toggle: boolean } | Refusal | null => {
    const distinct = hits.filter((k, i) => hits.findIndex((x) => id(x) === id(k)) === i);
    if (!distinct.length) return null;
    if (distinct.length === 1) return { key: distinct[0], toggle: isToggle(distinct[0]) };
    return { refuse: "invalid_value", message: `${device}有好幾個可能的鍵：${distinct.map((k) => `「${k.label}」`).join("、")}；要按哪一個？指令沒有送出。` };
  };
  const rows: (keyof typeof IR_SYNONYMS)[] =
    c.command === "power" ? (c.value ? ["power_on", "power"] : ["power_off", "power"]) : c.command === "mute" ? ["mute"] : c.intent ? [c.intent] : [];
  for (const row of rows) {
    const found = decide(keys.filter((k) => inRow(row, k)));
    if (found) return found;
  }
  if (c.command === "press") {
    const t = keyNorm(c.spoken);
    const exact = decide(keys.filter((k) => label(k) === t || keyNorm(k.key) === t));
    if (exact) return exact;
    const partial = c.intent ? null : decide(keys.filter((k) => t.length > 0 && (label(k).includes(t) || (label(k).length >= 2 && t.includes(label(k))))));
    if (partial) return partial;
  }
  const what = c.command === "power" ? "電源" : c.command === "mute" ? "靜音" : c.intent ? IR_INTENT_TEXT[c.intent] : c.spoken;
  if (!keys.length) return { refuse: "unsupported", message: `${device}沒有同步到任何遙控按鍵，指令沒有送出。` };
  const labels = keys.map((k) => k.label).filter((l, i, all) => all.indexOf(l) === i);
  const listed = labels.slice(0, MAX_KEY_LABELS).join("、") + (labels.length > MAX_KEY_LABELS ? "…" : "");
  return { refuse: "unsupported", message: `${device}沒有「${what}」鍵，指令沒有送出；有：${listed}。` };
}

// ───────── 中控回覆的對應（每條路徑一個；純函式）─────────

/** H1：POST /devices/{id}/commands。錯誤是 {code, message}；409 字串＝同 key 不同內容；429 不在這條路徑處理。 */
function commandsReply(status: number, data: unknown): HubReply {
  const detail = isRecord(data) ? data.detail : undefined;
  const code = isRecord(detail) ? str(detail.code) : "";
  const message = isRecord(detail) ? str(detail.message) : typeof detail === "string" ? detail : "";
  if (status >= 200 && status < 300) {
    const s = isRecord(data) ? str(data.status) : "";
    const text = isRecord(data) ? str(data.message) : "";
    // 中控已記下但還沒完成（accepted／sent）或不認得的狀態，一律當成未確認，不說成功。
    return { kind: "result", status: s === "confirmed" || s === "failed" ? s : "unconfirmed", message: text };
  }
  if (status === 409 && code === "state_stale") return { kind: "stale" };
  if (status === 409 && code === "not_configured") return { kind: "refused", reason: "not_configured", message: "還沒在中控完成設備接入，指令沒有送出。" };
  if (status === 409 && typeof detail === "string") return { kind: "key_conflict" };
  if (status === 422 && code === "unsupported_command") return { kind: "refused", reason: "unsupported", message: "沒有這項控制功能，指令沒有送出。" };
  if (status === 422) return { kind: "refused", reason: "invalid_value", message: message ? `中控不接受這個數值：${message}` : "中控不接受這個指令的格式。" };
  if (status === 404 && code === "device_not_found") return { kind: "gone" };
  // 其他 404（例如舊版中控沒有這個路徑，FastAPI 回 "Not Found"）：路徑不存在，指令沒有執行。
  if (status === 404) throw new HomeBridgeError("武陵居中控沒有控制設備的介面（HTTP 404），可能是中控版本太舊；指令沒有送出。", 502);
  if (status >= 500) return { kind: "retry", maybeReceived: true };
  throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${status}）。`, 502);
}

/** 中控 AIFA 路徑的錯誤字串（backend/aifa.py）；比對完整文字。 */
const AIFA_STALE = "請先重新讀取 AIFA 家電清單";
const AIFA_KEY_CONFLICT = "相同指令識別碼不可用於不同內容";

/**
 * AIFA：錯誤都是字串。200 的 status：unconfirmed＝已送出（one_way，帶控制器回報）；failed＝沒送出或連線失敗；
 * 已記下但還在處理（accepted）＝不確定。409 都在送出之前（清單過期、不是自己的冷氣），不是 AIOS 的錯；429＝2 秒冷卻。
 */
export function aifaReply(status: number, data: unknown): HubReply {
  const detail = isRecord(data) ? data.detail : undefined;
  const text = typeof detail === "string" ? detail : "";
  if (status >= 200 && status < 300) {
    const s = isRecord(data) ? str(data.status) : "";
    const message = isRecord(data) ? str(data.message) : "";
    if (s === "failed") return { kind: "result", status: "failed", message };
    // 中控的 AIFA 結果不會是 confirmed；萬一是，也只當成已送出。
    if (s === "unconfirmed" || s === "confirmed") return { kind: "result", status: "unconfirmed", why: "one_way", message, controller: parseReport(isRecord(data) ? data.controller_status : null) };
    return { kind: "result", status: "unconfirmed", why: "no_reply", message: "中控的紀錄還停在處理中，不確定有沒有送出" };
  }
  if (status === 409 && text === AIFA_STALE) return { kind: "stale" };
  if (status === 409 && text === AIFA_KEY_CONFLICT) return { kind: "key_conflict" };
  if (status === 409) return { kind: "refused", reason: "not_ready", message: `中控回覆「${text || "AIFA 冷氣目前不能控制"}」，指令沒有送出。` };
  if (status === 429) return { kind: "cooldown", retryAfterS: 2 };
  if (status === 422) return { kind: "refused", reason: "invalid_value", message: text ? `中控不接受這個冷氣指令：${text}。` : "中控不接受這個冷氣設定的格式，指令沒有送出。" };
  if (status === 404) throw new HomeBridgeError("武陵居中控沒有 AIFA 冷氣控制的介面（HTTP 404），可能是中控版本太舊；指令沒有送出。", 502);
  if (status >= 500) return { kind: "retry", maybeReceived: true };
  throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${status}）。`, 502);
}

/**
 * 紅外線：錯誤是 {code, message}（不是紅外線家電的 422 是字串）。200：雲端接受＝one_way；雲端沒回覆＝cloud_no_reply；
 * failed＝Tuya 拒絕；已記下但還在處理＝不確定。429 ir_cooldown＝每個控制器 1 秒冷卻。
 */
export function irReply(status: number, data: unknown): HubReply {
  const detail = isRecord(data) ? data.detail : undefined;
  const code = isRecord(detail) ? str(detail.code) : "";
  const message = isRecord(detail) ? str(detail.message) : typeof detail === "string" ? detail : "";
  if (status >= 200 && status < 300) {
    const s = isRecord(data) ? str(data.status) : "";
    const transport = isRecord(data) ? str(data.transport_status) : "";
    const text = isRecord(data) ? str(data.message) : "";
    if (s === "failed") return { kind: "result", status: "failed", message: text };
    if ((s === "unconfirmed" || s === "confirmed") && transport === "accepted_by_cloud") return { kind: "result", status: "unconfirmed", why: "one_way", message: text };
    if (s === "unconfirmed" && transport === "unknown") return { kind: "result", status: "unconfirmed", why: "cloud_no_reply", message: text };
    return { kind: "result", status: "unconfirmed", why: "no_reply", message: "中控的紀錄還停在處理中，不確定有沒有送出" };
  }
  if (status === 409 && code === "ir_keys_required") return { kind: "refused", reason: "not_ready", message: "遙控按鍵還沒同步或超過 24 小時，請在中控的紅外線控制器按「同步」；指令沒有送出。" };
  if (status === 409 && (code === "ir_controller_missing" || code === "ir_not_authorized")) return { kind: "refused", reason: "not_configured", message: `中控回覆「${message || code}」，指令沒有送出。` };
  if (status === 409 && code === "idempotency_conflict") return { kind: "key_conflict" };
  if (status === 409) return { kind: "refused", reason: "not_ready", message: `中控回覆「${message || "紅外線家電目前不能控制"}」，指令沒有送出。` };
  if (status === 422 && (code === "ir_key_unsupported" || typeof detail === "string")) return { kind: "refused", reason: "unsupported", message: `中控回覆「${message || "不支援這個按鍵"}」，指令沒有送出。` };
  if (status === 422) return { kind: "refused", reason: "invalid_value", message: "中控不接受這個按鍵的格式，指令沒有送出。" };
  if (status === 429) return { kind: "cooldown", retryAfterS: 1 };
  if (status === 404 && code === "device_not_found") return { kind: "gone" };
  if (status === 404) throw new HomeBridgeError("武陵居中控沒有紅外線家電的控制介面（HTTP 404），可能是中控版本太舊；指令沒有送出。", 502);
  if (status >= 500) return { kind: "retry", maybeReceived: true };
  throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${status}）。`, 502);
}

export class HomeBridge {
  private readonly fetch: typeof fetch;
  private readonly base: string | null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeouts: Record<Exclude<keyof typeof H1B_TIMEOUTS_MS, "snapshot">, number>;
  private readonly pending = new Map<string, PendingCommand>();
  /**
   * 最近一分鐘送出的控制指令時間，三條路徑共用。每個意圖在第一次控制 POST 之前才記一次（takeRate）：
   * 沒有 POST 就拒絕的（AIFA 清單重新讀取失敗、冷氣設定組不出來、已經最低、時間不夠）不算；
   * 同 key 重送、冷卻後重送、重新讀取清單後重送、重新讀取設備、/discover、/status 也都不算。
   */
  private sent: number[] = [];

  constructor(private readonly options: HomeBridgeOptions) {
    this.fetch = options.fetch ?? fetch;
    this.base = options.url ? options.url.replace(/\/+$/, "") : null;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const t = H1B_TIMEOUTS_MS;
    this.timeouts = { aifaStatus: t.aifaStatus, aifaDiscover: t.aifaDiscover, aifaSend: t.aifaSend, aifaRetry: t.aifaRetry, irSend: t.irSend, irRetry: t.irRetry, ...options.timeoutsMs };
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
    const home = await this.snapshot();
    const resolved = resolveTarget(home, target);
    if (resolved.kind === "not_found") return { ok: true, status: "not_found", target };
    if (resolved.kind === "ambiguous") return ambiguous(home, resolved.candidates);
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
   * home_control：解析指令 → 讀中控設備清單（加上 AIFA 冷氣）比對名稱 → 只控制一台 → 依路徑訂計畫 →
   * 依政策直接執行或等確認卡。只在完全無法和中控溝通時丟 HomeBridgeError（未設定、連不上、權杖被拒、格式不符），和 status() 相同。
   */
  async control(req: ControlRequest): Promise<HomeControlResult> {
    const startedAt = this.now();
    const command = parseCommand(req.command, req.value ?? null);
    if ("error" in command) return { ok: true, status: "refused", reason: "invalid_value", message: command.error };
    const home = await this.snapshot();
    const resolved = resolveTarget(home, req.target);
    if (resolved.kind === "not_found") {
      return home.aifa === "unavailable" ? { ok: true, status: "not_found", target: req.target, note: "AIFA 冷氣清單讀不到" } : { ok: true, status: "not_found", target: req.target };
    }
    if (resolved.kind === "ambiguous") return ambiguous(home, resolved.candidates);
    if (!resolved.devices.length) return { ok: true, status: "not_found", target: req.target };
    // 說的是房間或全家（即使裡面只有一台）就是房間指令，那是 H3：先問是哪一台，不一次控制多台。
    if (resolved.devices.length > 1 || resolved.scope !== resolved.devices[0].name) {
      return ambiguous(home, resolved.devices);
    }

    const device = resolved.devices[0];
    const target: HomeTarget = { device: device.name, room: home.rooms.find((r) => r.id === device.roomId)?.name ?? null };
    const refuse = (reason: RefusedReason, message: string): HomeControlResult => ({ ok: true, status: "refused", reason, message, ...target });
    const planned = planFor(device, command, { now: this.now(), serverTime: home.serverTime });
    if ("refuse" in planned) return refuse(planned.refuse, planned.message);

    const policy = this.options.policyFor?.(device) ?? "allow";
    if (policy === "off") return refuse("voice_disabled", `${device.name}沒有開放語音控制。`);
    const entry: Entry = { plan: planned.plan, target, action: planned.action, key: `nous_${this.newId()}` };
    if (policy === "allow") return this.submit(entry, startedAt + UTTERANCE_MS);

    this.prune();
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const confirmId = `home_${this.newId()}`;
    this.pending.set(confirmId, { ...entry, expiresAt: this.now() + CONFIRM_TTL_MS, run: null });
    return { ok: true, status: "needs_confirmation", confirm_id: confirmId, action: planned.action, expires_in_s: CONFIRM_TTL_MS / 1000, ...target };
  }

  /**
   * 確認卡結束。approve=false 只丟掉這張卡（不呼叫中控）；approve=true 用 control() 時綁定的計畫與 key 送出，
   * 重複呼叫拿到同一個結果。找不到或過期的 ID 回 expired。不重新比對名稱：使用者確認的是卡上寫的那台。
   */
  async confirm(confirmId: string, approve: boolean): Promise<HomeControlResult> {
    this.prune();
    const p = this.pending.get(confirmId);
    if (!p) return { ok: true, status: "refused", reason: "expired", message: "這張確認卡已經失效，沒有執行。" };
    if (p.run) return p.run;
    if (!approve) {
      this.pending.delete(confirmId);
      return { ok: true, status: "refused", reason: "declined", message: `沒有確認，${p.target.device}${p.action}沒有執行。`, ...p.target };
    }
    p.run = this.submit(p, this.now() + UTTERANCE_MS);
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

  /** 送出一個使用者意圖：依計畫的路徑送出。速率限制在各路徑第一次控制 POST 之前（見 sent）。deadline 只用在 AIFA／紅外線。 */
  private async submit(p: Entry, deadline: number): Promise<HomeControlResult> {
    const plan = p.plan;
    switch (plan.route) {
      case "commands": {
        const wait = this.takeRate();
        if (wait !== null) return this.oneWayResult({ kind: "rate_limited", retryAfterS: wait }, p, {});
        return this.commandsResult(p, await this.sendCommands({ deviceId: plan.deviceId, command: plan.command, key: p.key }));
      }
      case "aifa_power":
      case "aifa_climate":
        return this.sendAifa(plan, p, deadline);
      case "ir_key":
        return this.sendIr(plan, p, deadline);
    }
  }

  /**
   * H1 的結果對應（不變）。state_stale 時 send() 已重新讀取設備一次，再用同一把 key 重送：中控在記下 key 之前就回 409，
   * 所以不會執行兩次。重新讀取後仍不能控制就照實說沒有送出。最壞的時間見 sendCommands()。
   */
  private commandsResult(p: Entry, reply: HubReply): HomeControlResult {
    const base = { ok: true as const, action: p.action, ...p.target };
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
      case "cooldown":
      case "too_late":
      case "rate_limited":
        // commandsReply 不會產生這三種（H1 的 429 是 HomeBridgeError，也沒有 deadline；速率限制在 submit）。
        return { ...base, status: "failed", reason: "internal", message: "AIOS 內部錯誤：無法解讀中控的回覆，沒有執行" };
    }
  }

  /**
   * H1：一個意圖最多 POST 兩次，都用同一把 key 與內容（中控會回傳已記下的結果，不會再執行）。
   * 唯一的一次重送給第一次的逾時、5xx 或連線問題，或給 state_stale（先重新讀取設備）；重送之後不論結果都不再送。
   * 最壞：POST 16 秒 + 重新讀取 15 秒 + POST 16 秒 = 47 秒（算法見 docs/validation/smarthome-h1-2026-10-22.md）。
   */
  private async sendCommands(p: { deviceId: string; command: H1Command; key: string }): Promise<HubReply> {
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

  /**
   * AIFA 冷氣的開關或設定。清單快過期（或中控回 409 清單過期）時先 POST /integrations/aifa/discover 一次；
   * 設定先讀 POST …/status，缺的項目用預設值並說出來；送出最多兩次 POST，同一把 key 與內容（見 postTwice）。
   * 每一步都在 deadline 之內（UTTERANCE_MS）。
   */
  private async sendAifa(plan: Extract<Plan, { route: "aifa_power" | "aifa_climate" }>, p: Entry, deadline: number): Promise<HomeControlResult> {
    const left = () => deadline - this.now();
    const ref = plan.aifa;
    const device = p.target.device;
    /** 這次有沒有重新讀取過清單（每個意圖最多一次）；cooldown＝中控說一分鐘內有人讀過。 */
    const state: { discovered: "no" | "ok" | "cooldown" } = { discovered: "no" };
    /** 重新讀取 AIFA 清單一次；不能繼續時回傳沒有送出的原因。 */
    const discover = async (): Promise<HubReply | null> => {
      const d = await this.discoverAifa(Math.min(this.timeouts.aifaDiscover, left()));
      if (d.kind === "failed") {
        return { kind: "refused", reason: "not_ready", message: `AIFA 冷氣清單超過 24 小時，重新讀取沒有成功（${d.message}），指令沒有送出；請到中控的 AIFA 頁重新讀取。` };
      }
      state.discovered = d.kind;
      if (d.kind === "ok") {
        const fresh = d.devices.find((x) => x.id === aifaId(ref.hubId, ref.childId));
        if (!fresh) return { kind: "refused", reason: "not_ready", message: `重新讀取 AIFA 清單後找不到${device}，指令沒有送出。` };
        if (fresh.route.kind !== "aifa") return { kind: "refused", reason: "unsupported", message: `${device}${UNSUPPORTED_TEXT.aifa_other}` };
        if (plan.route === "aifa_climate" && !fresh.route.climate) return { kind: "refused", reason: "unsupported", message: `${device}${NO_CLIMATE_TEXT}` };
      }
      return null;
    };

    if (this.now() >= ref.freshUntil) {
      const stop = await discover();
      if (stop) return this.oneWayResult(stop, p, {});
    }

    let body: string;
    const facts: SendFacts = {};
    if (plan.route === "aifa_power") {
      body = JSON.stringify({ power: plan.power });
    } else {
      let read = await this.readAifaStatus(ref, left());
      if (read === "stale" && state.discovered === "no") {
        const stop = await discover();
        if (stop) return this.oneWayResult(stop, p, {});
        read = await this.readAifaStatus(ref, left());
      }
      const report = read === "stale" ? null : read;
      const built = buildClimate(plan.change, report, plan.caps);
      if ("error" in built) return { ok: true, status: "refused", reason: "invalid_value", message: built.error, ...p.target };
      body = JSON.stringify(built.packet);
      facts.sent_settings = built.text;
      if (built.defaultsUsed.length) facts.defaults_used = built.defaultsUsed;
      if (report?.power !== true) {
        facts.note =
          report?.power === false
            ? "控制器回報冷氣是關的：這個設定不代表會開機，要開冷氣請說「開冷氣」。"
            : "讀不到控制器的開關狀態：這個設定不代表會開機，要開冷氣請說「開冷氣」。";
      }
    }

    const path = `/api/v1/integrations/aifa/devices/${encodeURIComponent(ref.hubId)}/children/${encodeURIComponent(ref.childId)}/${plan.route === "aifa_power" ? "power" : "climate"}`;
    let reply = await this.postTwice({
      path,
      body,
      key: p.key,
      map: aifaReply,
      deadline,
      firstMs: this.timeouts.aifaSend,
      retryMs: this.timeouts.aifaRetry,
      cooldownMs: COOLDOWN_WAIT_MS.aifa,
      onStale: () => (state.discovered === "no" ? discover() : Promise.resolve({ kind: "stale" } as HubReply)),
    });
    if (reply.kind === "stale") {
      // 清單已重新讀取（或剛剛有人讀過、還在 60 秒冷卻）中控仍說過期：照中控的話說，沒有送出。
      reply = {
        kind: "refused",
        reason: "not_ready",
        message: `中控回覆「${AIFA_STALE}」，指令沒有送出${state.discovered === "cooldown" ? "；剛剛有人重新讀取過，一分鐘內不能再讀，請一分鐘後再說一次" : ""}。`,
        ...(state.discovered === "cooldown" ? { retryAfterS: 60 } : {}),
      };
    }
    const reported = reply.kind === "result" ? reportedText(reply.controller) : undefined;
    if (reported) facts.controller_reported = reported;
    if (plan.route === "aifa_power" && !plan.power) {
      const timer = acOffTimerNote(reply);
      if (timer) facts.note = timer;
    }
    return this.oneWayResult(reply, p, facts);
  }

  /** 紅外線家電按一個鍵：POST /devices/{id}/infrared-commands {key, key_id}，最多兩次（見 postTwice）。不呼叫紅外線同步。 */
  private async sendIr(plan: Extract<Plan, { route: "ir_key" }>, p: Entry, deadline: number): Promise<HomeControlResult> {
    const reply = await this.postTwice({
      path: `/api/v1/devices/${encodeURIComponent(plan.deviceId)}/infrared-commands`,
      body: JSON.stringify({ key: plan.key.key, key_id: plan.key.key_id }),
      key: p.key,
      map: irReply,
      deadline,
      firstMs: this.timeouts.irSend,
      retryMs: this.timeouts.irRetry,
      cooldownMs: COOLDOWN_WAIT_MS.infrared,
    });
    return this.oneWayResult(reply, p, { key: plan.key.label, ...(plan.toggle ? { toggle: true as const } : {}) });
  }

  /**
   * AIFA／紅外線：一個意圖最多 POST 兩次，同一把 key 與內容。唯一的一次重送給：
   * 逾時、5xx 或連線問題（中控回傳已記下的結果）；冷卻 429（中控在記下 key 之前就拒絕，等一下再送）；
   * 清單過期 409（onStale 重新讀取清單後再送）。剩下的時間少於 MIN_SEND_WINDOW_MS 就不再開始 POST。
   * 第一次 POST 之前才算速率限制（每個意圖一次）。
   * 第一次可能已經送到時，第二次若說「沒有送出」（409 等）不採信：中控在比對已記下的 key 之前就會先檢查清單與授權。
   */
  private async postTwice(o: {
    path: string;
    body: string;
    key: string;
    map: ReplyMapper;
    deadline: number;
    firstMs: number;
    retryMs: number;
    cooldownMs: number;
    onStale?: () => Promise<HubReply | null>;
  }): Promise<HubReply> {
    const left = () => o.deadline - this.now();
    if (left() < MIN_SEND_WINDOW_MS) return { kind: "too_late" };
    // 這個意圖的第一次控制 POST：這時才算一次速率限制；下面的重送都不再算。
    const wait = this.takeRate();
    if (wait !== null) return { kind: "rate_limited", retryAfterS: wait };
    const first = await this.post(o.path, o.body, o.key, o.map, Math.min(o.firstMs, left()));
    let nextMs: number;
    if (first.kind === "retry") nextMs = o.retryMs;
    else if (first.kind === "cooldown") {
      await this.sleep(o.cooldownMs);
      nextMs = o.firstMs;
    } else if (first.kind === "stale" && o.onStale) {
      const stop = await o.onStale();
      if (stop) return stop;
      nextMs = o.firstMs;
    } else return first;
    if (left() < MIN_SEND_WINDOW_MS) return first.kind === "stale" ? { kind: "too_late" } : first;
    const second = await this.post(o.path, o.body, o.key, o.map, Math.min(nextMs, left()));
    if (first.kind === "retry" && second.kind === "retry") return { kind: "retry", maybeReceived: first.maybeReceived || second.maybeReceived };
    if (first.kind === "retry" && first.maybeReceived && second.kind !== "result") return { kind: "retry", maybeReceived: true };
    return second;
  }

  /** AIFA／紅外線的結果：永遠不是 confirmed。 */
  private oneWayResult(reply: HubReply, p: Entry, facts: SendFacts): HomeControlResult {
    const base = { ok: true as const, action: p.action, ...p.target };
    const what = p.plan.route === "ir_key" ? "家電" : "冷氣";
    switch (reply.kind) {
      case "result":
        // 失敗時不帶「送出的設定」與預設值（中控可能根本沒送出）；紅外線只留按的是哪個鍵。
        if (reply.status === "failed") return { ...base, status: "failed", reason: "device", message: reply.message || "中控回報失敗", ...(facts.key ? { key: facts.key } : {}) };
        return {
          ...base,
          status: "unconfirmed",
          why: reply.why ?? "no_reply",
          message: reply.message || (reply.why === "one_way" ? "已送出，請看一下有沒有反應" : `不確定有沒有送出，請看一下${what}`),
          ...facts,
        };
      case "stale":
        return { ok: true, status: "refused", reason: "not_ready", message: `中控回覆「${AIFA_STALE}」，指令沒有送出。`, ...p.target };
      case "cooldown":
        return {
          ok: true,
          status: "refused",
          reason: "rate_limited",
          retry_after_s: reply.retryAfterS,
          message: `中控要求兩次控制之間稍等，「${p.action}」沒有送出，請等 ${reply.retryAfterS} 秒再說。`,
          ...p.target,
        };
      case "refused":
        return { ok: true, status: "refused", reason: reply.reason, message: reply.message, ...(reply.retryAfterS ? { retry_after_s: reply.retryAfterS } : {}), ...p.target };
      case "key_conflict":
        return { ...base, status: "failed", reason: "internal", message: "AIOS 內部錯誤：指令編號重複，沒有執行" };
      case "gone":
        return { ok: true, status: "not_found", target: p.target.device };
      case "retry":
        return reply.maybeReceived
          ? { ...base, status: "unconfirmed", why: "no_reply", message: `中控沒有回覆，不確定有沒有送出，請看一下${what}`, ...facts }
          : { ...base, status: "failed", reason: "hub_unreachable", message: "無法連線到武陵居中控，指令沒有送出" };
      case "too_late":
        return { ok: true, status: "refused", reason: "not_ready", message: `中控回應太慢，「${p.action}」沒有送出，請再說一次。`, ...p.target };
      case "rate_limited":
        return {
          ok: true,
          status: "refused",
          reason: "rate_limited",
          retry_after_s: reply.retryAfterS,
          message: `一分鐘內控制指令太多，這個沒有送出，請等 ${reply.retryAfterS} 秒再說。`,
          ...p.target,
        };
    }
  }

  /** 一次 POST；回覆交給該路徑的 mapper。fetch 失敗都是 retry（連線被拒例外：中控一定沒收到）。 */
  private async post(path: string, body: string, key: string, map: ReplyMapper = commandsReply, timeoutMs = this.options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS): Promise<HubReply> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json", "Idempotency-Key": key },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
    } catch (err) {
      return { kind: "retry", maybeReceived: !refusedConnection(err) };
    }
    this.checkAuth(res, "控制設備");
    const data: unknown = await res.json().catch(() => null);
    return map(res.status, data);
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

  /**
   * POST …/children/{c}/status（沒有 body、沒有冷卻、不算速率限制）：控制器記得的設定。
   * 逾時或其他錯誤回 null（呼叫端用預設值並說出來）；清單過期回 "stale"。
   */
  private async readAifaStatus(ref: AifaRef, budgetMs: number): Promise<ControllerReport | null | "stale"> {
    // 留下送出需要的時間；不夠就不讀，改用預設值（會說出來）。
    const timeout = Math.min(this.timeouts.aifaStatus, budgetMs - MIN_SEND_WINDOW_MS);
    if (timeout <= 0) return null;
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/integrations/aifa/devices/${encodeURIComponent(ref.hubId)}/children/${encodeURIComponent(ref.childId)}/status`, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, timeout)),
      });
    } catch {
      return null;
    }
    this.checkAuth(res, "讀取冷氣狀態");
    const data: unknown = await res.json().catch(() => null);
    if (res.status === 409 && isRecord(data) && data.detail === AIFA_STALE) return "stale";
    if (!res.ok || !isRecord(data)) return null;
    return parseReport(data.status);
  }

  /** POST /integrations/aifa/discover 一次。429（一分鐘內有人讀過）不算失敗：照樣送出，由中控決定。 */
  private async discoverAifa(timeoutMs: number): Promise<{ kind: "ok"; devices: HubDevice[] } | { kind: "cooldown" } | { kind: "failed"; message: string }> {
    if (timeoutMs <= 0) return { kind: "failed", message: "時間不夠" };
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/integrations/aifa/discover`, {
        method: "POST",
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: "failed", message: "中控沒有回應" };
    }
    this.checkAuth(res, "重新讀取 AIFA 清單");
    const data: unknown = await res.json().catch(() => null);
    if (res.status === 429) return { kind: "cooldown" };
    if (res.ok) {
      const parsed = parseAifa(data, []);
      return parsed.aifa === "unavailable" ? { kind: "failed", message: "中控回傳的清單格式不符" } : { kind: "ok", devices: parsed.devices };
    }
    const detail = isRecord(data) ? data.detail : undefined;
    return { kind: "failed", message: typeof detail === "string" && detail ? detail : `HTTP ${res.status}` };
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" };
  }

  private checkAuth(res: Response, what: string): void {
    if (res.status === 401) throw new HomeBridgeError("武陵居中控拒絕了權杖（401），請到中控「系統接入」重新核發後更新 SMARTHOME_TOKEN。", 502);
    if (res.status === 403) throw new HomeBridgeError(`這把中控權杖沒有${what}的權限（403）。`, 502);
  }

  /** GET /home 與 GET /integrations/aifa 同時讀；AIFA 讀不到不影響 /home 的設備（燈照樣能控制）。 */
  private async snapshot(): Promise<HubSnapshot> {
    const [home, aifa] = await Promise.all([this.home(), this.aifaList()]);
    const merged = aifa === null ? { aifa: "unavailable" as const, devices: [] } : parseAifa(aifa, home.devices);
    return { ...home, devices: [...home.devices, ...merged.devices], aifa: merged.aifa };
  }

  /** GET /api/v1/integrations/aifa；任何錯誤都回 null，不丟例外。 */
  private async aifaList(): Promise<unknown> {
    if (!this.base || !this.options.token) return null;
    try {
      const res = await this.fetch(`${this.base}/api/v1/integrations/aifa`, {
        headers: this.headers(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
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

const UNSUPPORTED_TEXT: Record<UnsupportedWhy, string> = {
  air_con: "是冷氣，但不是透過 AIFA 連接，目前不能用語音控制。",
  aifa_controller: "是 AIFA 控制器本身；要控制冷氣，請說 AIFA App 裡的冷氣名稱。",
  ir_blaster: "是紅外線控制器本身，請說要控制的家電名稱，例如電視。",
  remote: "這類設備（遙控器、無線按鈕）目前還不能用語音控制。",
  aifa_other: "是 AIFA 的非冷氣家電，目前不能用語音控制。",
};

/** 紅外線家電的按鍵與狀態（中控 /home 的 infrared）。 */
function parseInfrared(v: unknown): Extract<DeviceRoute, { kind: "infrared" }> {
  const ir = isRecord(v) ? v : {};
  const keys = (Array.isArray(ir.keys) ? ir.keys : []).filter(isRecord).flatMap((k): IrKey[] => {
    const id = num(k.key_id);
    const key = str(k.key);
    return key && id !== null && Number.isInteger(id) && id >= 0 ? [{ key, key_id: id, label: str(k.label) || key }] : [];
  });
  const error = isRecord(ir.error) ? str(ir.error.message) || str(ir.error.code) : str(ir.error);
  return { kind: "infrared", keys, ready: ir.ready === true, controllerName: str(ir.controller_name) || null, error: error || null };
}

/**
 * 設備走哪條路徑，依序判斷（紅外線先：紅外線的冷氣遙控不能拿到 AIFA 的溫度設定）：
 * 1. 紅外線家電（config.infrared_virtual 或有 infrared 紀錄）；
 * 2. 不是 AIFA 的冷氣（Tuya kt／ktkzq、Home Assistant climate.*、kind air_conditioner）與 AIFA 控制器本身；
 * 3. 紅外線控制器本身（Tuya wnykq）與其他 kind remote（wxkg 無線按鈕）；4. 其他走 H1 的 commands。
 */
function routeOf(kind: string, config: Record<string, unknown>, infrared: unknown, configured: boolean): DeviceRoute {
  if (config.infrared_virtual === true || isRecord(infrared)) return parseInfrared(infrared);
  if (config.external_provider === "aifa") return { kind: "unsupported", why: "aifa_controller" };
  if (kind === "air_conditioner" || TUYA_AIR_CON.has(str(config.cloud_category)) || str(config.entity_id).startsWith("climate.")) {
    return { kind: "unsupported", why: "air_con" };
  }
  if (str(config.cloud_category) === "wnykq") return { kind: "unsupported", why: "ir_blaster" };
  if (kind === "remote") return { kind: "unsupported", why: "remote" };
  return { kind: "commands", configured };
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
    // configured：中控判斷的「已完成設備接入」；中控沒給時當作 true，交給中控自己拒絕。紅外線家電不看它（中控對它們永遠是 false）。
    const route = routeOf(str(d.kind), config, d.infrared, d.configured !== false);
    return {
      id: str(d.id),
      name: str(d.name),
      aliases: Array.isArray(d.aliases) ? d.aliases.filter((a): a is string => typeof a === "string") : [],
      kind: str(d.kind),
      roomId: str(placement.room_id) || null,
      available: typeof state.available === "boolean" ? state.available : null,
      fresh: state.fresh === true,
      route,
      telemetry: t
        ? { metrics, status: dataStatus(str(t.status), metrics), receivedAt: num(t.received_at), source: str(t.source_label) }
        : null,
    };
  });
  return { rooms, devices: devices.filter((d) => d.id && d.name), serverTime: num(body.server_time) ?? Date.now() / 1000 };
}

const aifaId = (hubId: string, childId: string) => `aifa:${hubId}:${childId}`;

/** capabilities（只有設定碼 173 有）→ 可用範圍；溫度限制在中控接受的 17–30 度之內。 */
function parseCaps(v: unknown): AifaClimateCaps | null {
  if (!isRecord(v)) return null;
  const list = <T extends string>(all: readonly T[], x: unknown): T[] => (Array.isArray(x) ? all.filter((a) => x.includes(a)) : []);
  const minC = Math.max(17, num(v.min_temperature) ?? 17);
  const maxC = Math.min(30, num(v.max_temperature) ?? 30);
  const caps = { minC, maxC, modes: list(AC_MODES, v.modes), fans: list(AC_FANS, v.fan_modes), swings: list(AC_SWINGS, v.swing_modes), features: list(AC_FEATURES, v.features) };
  return caps.modes.length && caps.fans.length && caps.swings.length && minC <= maxC ? { ...caps, features: caps.features.length ? caps.features : ["normal"] } : null;
}

/**
 * 解析 GET /api/v1/integrations/aifa：AIFA 冷氣不是中控的設備，只在這份清單裡。
 * type "0"、sub_type "0" 的子設備是冷氣；房間只能經 matched_device_id（MAC 對到的中控設備）得知，對不到就沒有房間。
 */
export function parseAifa(body: unknown, homeDevices: HubDevice[]): { aifa: AifaListState; devices: HubDevice[] } {
  if (!isRecord(body) || !Array.isArray(body.items)) return { aifa: "unavailable", devices: [] };
  const queriedAt = num(body.queried_at);
  const devices: HubDevice[] = [];
  for (const item of body.items.filter(isRecord)) {
    const hubId = str(item.id);
    if (!hubId) continue;
    const matched = str(item.matched_device_id);
    const roomId = (matched && homeDevices.find((d) => d.id === matched)?.roomId) || null;
    const online = typeof item.online === "boolean" ? item.online : null;
    for (const child of (Array.isArray(item.children) ? item.children : []).filter(isRecord)) {
      const childId = str(child.id);
      if (!childId) continue;
      const name = str(child.name) || "未命名家電";
      const isAc = str(child.type) === "0" && str(child.sub_type) === "0";
      const route: DeviceRoute = isAc
        ? { kind: "aifa", hubId, childId, climate: parseCaps(child.capabilities), listQueriedAt: queriedAt }
        : { kind: "unsupported", why: "aifa_other" };
      devices.push({ id: aifaId(hubId, childId), name, aliases: [], kind: isAc ? "air_conditioner" : "aifa_other", roomId, available: online, fresh: false, listedAt: queriedAt, route, telemetry: null });
    }
  }
  if (!devices.length && body.connected !== true) return { aifa: "not_connected", devices };
  return { aifa: "ok", devices };
}
