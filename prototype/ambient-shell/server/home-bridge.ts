// 武陵居中控（SmartHomeAI）的本機橋接（docs/12 H0）：只做唯讀查詢。
// 本機核心經區網呼叫中控 REST v1，權杖只留在這裡，不進瀏覽器、不進 OpenAI 的工作階段。
// 讀值照中控回報：缺值是 null，不補 0；快照、過期資料要標出來，不當成即時值。

import type { DeviceReport, HomeStatusResult } from "../shared/home.ts";

const TIMEOUT_MS = 8_000;
const MAX_DEVICES = 12;

export interface HomeBridgeOptions {
  /** SMARTHOME_URL，例如 http://127.0.0.1:8788；分機部署時改成中控的區網位址。 */
  url: string | null;
  /** SMARTHOME_TOKEN，中控「系統接入」核發的權杖。 */
  token: string | null;
  fetch?: typeof fetch;
  /** 念給使用者聽的時間用哪個時區；未指定時用這台電腦的時區。 */
  timeZone?: string;
}

/** 中控 GET /api/v1/home 裡 AIOS 會用到的部分（在邊界解析，其他欄位忽略）。 */
export interface HubMetric {
  key: string;
  label: string;
  unit: string;
  precision: number;
  value: number | string | null;
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
  telemetry: { metrics: HubMetric[]; status: HubDataStatus; receivedAt: number | null; source: string } | null;
}

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
const FILLER = /^(的|裡|裡面|裡的|內|中)+|(的|裡|裡面)+$/g;
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
  const direct = resolveName(home, whole.replace(FILLER, ""));
  if (direct.kind === "match") return { ...direct, metric: null };
  if (direct.kind === "ambiguous") return direct;
  const split = splitMetric(whole);
  if (!split.metric) return direct;
  const rest = resolveName(home, split.rest.replace(FILLER, ""));
  return rest.kind === "match" ? { ...rest, metric: split.metric } : rest;
}

type NameMatch = { kind: "match"; scope: string; devices: HubDevice[] } | Exclude<Resolution, { kind: "match" }>;

function resolveName(home: HubSnapshot, t: string): NameMatch {
  if (!t || WHOLE_HOME.has(t)) return { kind: "match", scope: "全家", devices: home.devices };

  const exact = home.devices.filter((d) => names(d).includes(t));
  if (exact.length === 1) return { kind: "match", scope: exact[0].name, devices: exact };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  const inRoom = (roomId: string) => home.devices.filter((d) => d.roomId === roomId);
  const room = home.rooms.find((r) => norm(r.name) === t);
  if (room) return { kind: "match", scope: room.name, devices: inRoom(room.id) };

  const prefix = home.rooms.find((r) => norm(r.name) && t.includes(norm(r.name)));
  const pool = prefix ? inRoom(prefix.id) : home.devices;
  const rest = prefix ? t.replace(norm(prefix.name), "").replace(FILLER, "") : t;
  if (prefix && !rest) return { kind: "match", scope: prefix.name, devices: pool };

  const partial = pool.filter((d) => names(d).some((n) => n.includes(rest) || rest.includes(n)));
  if (partial.length === 1) return { kind: "match", scope: partial[0].name, devices: partial };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };
  return { kind: "not_found" };
}

function clock(epochSeconds: number, timeZone: string | undefined): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
}

function round(value: number | string | null, precision: number): number | string | null {
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
    time: t.receivedAt === null ? null : clock(t.receivedAt, timeZone),
    minutes_ago: t.receivedAt === null ? null : Math.max(0, Math.round((home.serverTime - t.receivedAt) / 60)),
    source: t.source || null,
    readings: metrics.map((m) => ({ name: m.label, value: round(m.value, m.precision), unit: m.unit })),
  };
}

export class HomeBridge {
  private readonly fetch: typeof fetch;
  private readonly base: string | null;

  constructor(private readonly options: HomeBridgeOptions) {
    this.fetch = options.fetch ?? fetch;
    this.base = options.url ? options.url.replace(/\/+$/, "") : null;
  }

  get available(): boolean {
    return !!(this.base && this.options.token);
  }

  /** 啟動訊息與設定畫面用的說明；不含權杖。 */
  get detail(): string {
    if (!this.base) return "未設定 SMARTHOME_URL";
    if (!this.options.token) return "未設定 SMARTHOME_TOKEN";
    return `${this.base}（唯讀查詢）`;
  }

  async status(target: string, metric?: string | null): Promise<HomeStatusResult> {
    const home = await this.home();
    const resolved = resolveTarget(home, target);
    if (resolved.kind === "not_found") return { ok: true, status: "not_found", target };
    if (resolved.kind === "ambiguous") {
      return {
        ok: true,
        status: "ambiguous",
        candidates: resolved.candidates.slice(0, 5).map((d) => {
          const room = home.rooms.find((r) => r.id === d.roomId)?.name;
          return room && !norm(d.name).includes(norm(room)) ? `${room}的${d.name}` : d.name;
        }),
      };
    }
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

  private async home(): Promise<HubSnapshot> {
    if (!this.base || !this.options.token) throw new HomeBridgeError("尚未設定武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN）。", 409);
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/api/v1/home`, {
        headers: { Authorization: `Bearer ${this.options.token}`, Accept: "application/json" },
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
    if (res.status === 401) throw new HomeBridgeError("武陵居中控拒絕了權杖（401），請到中控「系統接入」重新核發後更新 SMARTHOME_TOKEN。", 502);
    if (res.status === 403) throw new HomeBridgeError("這把中控權杖沒有讀取設備的權限（403）。", 502);
    if (!res.ok) throw new HomeBridgeError(`武陵居中控回應錯誤（HTTP ${res.status}）。`, 502);
    try {
      return parseHome(await res.json());
    } catch (err) {
      throw new HomeBridgeError("武陵居中控回傳的資料格式不符，無法讀取。", 502, { cause: err });
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

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
    const t = isRecord(d.telemetry) ? d.telemetry : null;
    const status = str(t?.status);
    return {
      id: str(d.id),
      name: str(d.name),
      aliases: Array.isArray(d.aliases) ? d.aliases.filter((a): a is string => typeof a === "string") : [],
      kind: str(d.kind),
      roomId: str(placement.room_id) || null,
      available: typeof state.available === "boolean" ? state.available : null,
      fresh: state.fresh === true,
      telemetry: t
        ? {
            metrics: (Array.isArray(t.metrics) ? t.metrics : []).filter(isRecord).map((m) => ({
              key: str(m.key),
              label: str(m.label) || str(m.key),
              unit: str(m.unit),
              precision: num(m.precision) ?? 1,
              value: typeof m.value === "string" ? m.value : num(m.value),
            })),
            status: status === "live" || status === "snapshot" || status === "stale" ? status : "missing",
            receivedAt: num(t.received_at),
            source: str(t.source_label),
          }
        : null,
    };
  });
  return { rooms, devices: devices.filter((d) => d.id && d.name), serverTime: num(body.server_time) ?? Date.now() / 1000 };
}
