// 指令解析、H1 指令的中控格式、名稱比對、電視改路、控制計畫（planFor）與 H1 回覆的對應。

import { AC_SWINGS, commandText, HOME_COMMANDS, IR_INTENT_TEXT, IR_INTENTS, keyAction, type AcFan, type AcMode, type AcSwing, type HomeCommand, type RefusedReason } from "../../shared/home.ts";
import { checkClimate, NO_CLIMATE_TEXT } from "./aifa.ts";
import { matchKey } from "./infrared.ts";
import { isRecord, str, UNSUPPORTED_TEXT } from "./parse.ts";
import { norm, splitMetric } from "./readings.ts";
import { HomeBridgeError, type AifaClimateCaps, type ClimateChange, type ControlRequest, type DeviceRoute, type HubDevice, type HubReply, type HubSnapshot, type IrKey, type Refusal } from "./types.ts";

/** AIFA 清單在 24 小時後失效；提早 10 分鐘重新讀取，避免送出途中跨過期限。 */
const AIFA_LIST_TTL_S = 86_400;
const AIFA_STALE_MARGIN_S = 600;

const WHOLE_HOME = new Set(["家", "全家", "家裡", "全部", "所有", "全屋", "家中", "整個家"]);
/** 句尾的「的、裡、裡面、內」（「客廳裡」「家裡的」）；不動句首，避免吃掉「中庭」「內室」這類名稱。 */
const TRAILING = /(的|裡|裡面|內)+$/;

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
export type H1Command = Extract<HomeCommand, { command: (typeof H1_COMMANDS)[number] }>;
const isH1Command = (c: HomeCommand): c is H1Command => (H1_COMMANDS as readonly string[]).includes(c.command);

/** 送到中控 POST /devices/{id}/commands 的內容；只有這裡知道色溫在中控叫 temperature。 */
export function toWire(c: H1Command): { command: string; value: boolean | number | string | null } {
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

const ROUTE_TAG: Partial<Record<DeviceRoute["kind"], string>> = { aifa: "（AIFA）", infrared: "（紅外線遙控）" };
const TAGGED_NOTE = "使用者選了之後，target 照候選名稱一字不差填，包括括號裡的（AIFA）或（紅外線遙控）。";

/**
 * 問是哪一台：設備名稱裡沒有房間時加上房間（「客廳的立燈」）。
 * AIFA 冷氣與紅外線家電一律加上路徑（「冷氣（AIFA）」「客廳的冷氣（紅外線遙控）」）：同名的設備一台有房間、
 * 一台沒有時（AIFA 冷氣常常沒有房間），只看名稱分不出來，照著說也選不到。有路徑時 note 請模型照抄候選名稱。
 */
/** LGTV-1：電視改用 app.tv.* 時，home_control 對電視的固定回覆。 */
export const TV_MOVED = "電視改由 Nous 直接控制（app__tv__ 工具），中控這條不再控制電視；這個指令沒有送出，請改用電視工具。";

const LIVING_TV = new Set(["電視", "tv", "客廳電視", "客廳的電視", "lg電視", "lgtv", "客廳tv"]);

/** 使用者說的是客廳那台電視：「電視」「客廳電視」「LG 電視」；「臥室電視」「電視櫃燈」不算。 */
export function isTvName(text: string): boolean {
  return LIVING_TV.has(norm(text).replace(/[的裡]+$/, ""));
}

/** 中控裡的客廳電視：名稱或別名是上面的說法，或在「客廳」且名稱以電視／TV 結尾。 */
export function isTvDevice(home: HubSnapshot, d: HubDevice): boolean {
  if ([d.name, ...d.aliases].some(isTvName)) return true;
  const room = home.rooms.find((r) => r.id === d.roomId)?.name ?? "";
  return norm(room) === "客廳" && /(電視|tv)$/i.test(norm(d.name));
}

export function ambiguous(home: HubSnapshot, devices: HubDevice[]): { ok: true; status: "ambiguous"; candidates: string[]; note?: string } {
  const shown = devices.slice(0, 5);
  const labels = shown.map((d) => {
    const room = home.rooms.find((r) => r.id === d.roomId)?.name;
    return `${room && !norm(d.name).includes(norm(room)) ? `${room}的${d.name}` : d.name}${ROUTE_TAG[d.route.kind] ?? ""}`;
  });
  return { ok: true, status: "ambiguous", candidates: labels, ...(shown.some((d) => ROUTE_TAG[d.route.kind]) ? { note: TAGGED_NOTE } : {}) };
}

export interface AifaRef {
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

// ───────── 中控回覆的對應（每條路徑一個；純函式）─────────

/** H1：POST /devices/{id}/commands。錯誤是 {code, message}；409 字串＝同 key 不同內容；429 不在這條路徑處理。 */
export function commandsReply(status: number, data: unknown): HubReply {
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
