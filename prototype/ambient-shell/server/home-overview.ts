import {
  HOME_AC_MAX,
  HOME_AC_REPORT_KEEP_MS,
  HOME_CLIMATE_KEYS,
  HOME_ON_NAMES_MAX,
  type HomeAcState,
  type HomeClimateReading,
  type HomeOverviewError,
  type HomeOverviewView,
  type HomeSwitchGroup,
} from "../shared/home-corner.ts";
import { HomeBridgeError, type HubDevice, type HubSnapshot, type RememberedReport } from "./home-bridge.ts";

// HOME-1（George 2026-11-07）：GET /api/home/overview 的內容（左上角家中狀態）。唯讀：只讀 HomeBridge 的快照，不送任何控制指令。
// - 快取 30 秒（成功與失敗都算），同時只有一個中控請求；控制指令結束後（HomeBridge.changes 改變）下一次就重讀，
//   控制前就開始的請求不算數（等它結束再讀一次）；控制後讀到的結果只快取 5 秒，頁面 8 秒後的追讀拿得到中控稍晚更新的開關。
// - 只交出角落要畫的：室內讀值（每種一台）、燈與插座的數量、開著的名稱（最多 4 個）、AIFA 冷氣的控制器回報。
//   不交出設備 id、權杖、中控位址或原始回應；不寫 log。

export const HOME_OVERVIEW_TTL_MS = 30_000;
/** 控制結束後讀到的快照只快取這麼久（頁面 HOME_CONTROL_FOLLOWUP_MS 後會再讀一次）。 */
export const HOME_OVERVIEW_AFTER_CONTROL_TTL_MS = 5_000;
const NAME_MAX = 24;

/** HomeBridge 裡 overview 用得到的部分（測試可以換成假的）。 */
export interface HomeOverviewSource {
  readonly available: boolean;
  readonly changes: number;
  readSnapshot(): Promise<HubSnapshot>;
  controllerReports(): ReadonlyMap<string, RememberedReport>;
  pollControllerReports(devices: HubDevice[]): void;
}

const LIGHT_KINDS = new Set(["light"]);
const SWITCH_KINDS = new Set(["switch", "plug", "outlet", "socket"]);
const STATUS_RANK = { live: 0, snapshot: 1, stale: 2, missing: 3 } as const;

const clip = (name: string) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name);

/**
 * 中控回報的開關；設備不在線或中控沒給開關值時 null（不知道）。
 * 中控只把 90 秒內的讀值標成 fresh；較舊的讀值照樣採用，但要知道多舊（age_seconds），不知道多舊就算不知道。
 */
function reportedPower(d: HubDevice): boolean | null {
  if (d.available !== true || typeof d.power !== "boolean") return null;
  if (!d.fresh && typeof d.observedAgeS !== "number") return null;
  return d.power;
}

/**
 * 快照 → 角落的內容（純函式）。elapsedS：快照讀完到現在的秒數（快取期間讀值的年紀照樣往上加）。
 * 年紀＝serverTime − receivedAt：中控有給 server_time 時兩邊都是中控時鐘，不受這台電腦時鐘影響；
 * 中控沒給 server_time 時 parseHome 改用這台電腦的時間，年紀就受兩邊時鐘差影響。
 */
export function overviewFromSnapshot(home: HubSnapshot, reports: ReadonlyMap<string, RememberedReport>, now: number, elapsedS: number): Extract<HomeOverviewView, { state: "ok" }> {
  const roomOf = (d: HubDevice) => home.rooms.find((r) => r.id === d.roomId)?.name ?? null;
  const climate: HomeClimateReading[] = [];
  const sensors = new Map<HubDevice, number>();
  const sensorOf = (d: HubDevice) => sensors.get(d) ?? (sensors.set(d, sensors.size), sensors.size - 1);
  for (const key of HOME_CLIMATE_KEYS) {
    const candidates = home.devices.flatMap((d) => {
      const t = d.telemetry;
      const m = t?.metrics.find((x) => x.key === key);
      if (!t || !m || (m.value !== null && typeof m.value !== "number")) return [];
      // 有讀值卻標 missing（不一致）或沒有讀值：都當成沒有讀值，不拿來當即時值。
      const status = m.value === null ? "missing" : t.status;
      return [{ d, m, status, receivedAt: t.receivedAt }];
    });
    candidates.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (b.receivedAt ?? -Infinity) - (a.receivedAt ?? -Infinity));
    const best = candidates[0];
    if (!best) continue;
    climate.push({
      key,
      sensor: sensorOf(best.d),
      value: best.status === "missing" ? null : (best.m.value as number),
      unit: best.m.unit,
      precision: best.m.precision,
      room: roomOf(best.d),
      status: best.status,
      age_s: best.receivedAt === null ? null : Math.max(0, Math.round(home.serverTime - best.receivedAt + elapsedS)),
    });
  }

  const group = (kind: HomeSwitchGroup["group"], kinds: Set<string>): HomeSwitchGroup => {
    const devices = home.devices.filter((d) => d.route.kind === "commands" && kinds.has(d.kind));
    const powers = devices.map((d) => ({ d, power: reportedPower(d) }));
    const on = powers.filter((p) => p.power === true);
    return {
      group: kind,
      total: devices.length,
      on: on.length,
      unknown: powers.filter((p) => p.power === null).length,
      oldest_age_s: powers.reduce<number | null>((oldest, p) => (p.power === null || p.d.fresh ? oldest : Math.max(oldest ?? 0, Math.round(p.d.observedAgeS ?? 0))), null),
      on_names: on.slice(0, HOME_ON_NAMES_MAX).map((p) => clip(p.d.name)),
    };
  };

  const ac: HomeAcState[] = home.devices
    .filter((d) => d.route.kind === "aifa")
    .slice(0, HOME_AC_MAX)
    .map((d) => {
      const kept = reports.get(d.id);
      const r = kept && now - kept.at <= HOME_AC_REPORT_KEEP_MS ? kept : null;
      return {
        name: clip(d.name),
        room: roomOf(d),
        power: r?.report.power ?? null,
        mode: r?.report.mode ?? null,
        temperature: r?.report.temperature ?? null,
        age_s: r && r.report.power !== null ? Math.max(0, Math.round((now - r.at) / 1000)) : null,
      };
    });

  return { configured: true, state: "ok", server_now: now, climate, switches: [group("light", LIGHT_KINDS), group("switch", SWITCH_KINDS)], ac };
}

function errorCode(err: unknown): HomeOverviewError {
  const code = err instanceof HomeBridgeError ? err.code : null;
  return code === "timeout" || code === "auth" || code === "bad_response" ? code : "unreachable";
}

type Cached = { at: number; changes: number; afterControl: boolean; home: HubSnapshot | null; error: HomeOverviewError | null };

export class HomeOverview {
  private cached: Cached | null = null;
  private inflight: { changes: number; read: Promise<Cached> } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: { source: HomeOverviewSource; now?: () => number; ttlMs?: number }) {
    this.now = options.now ?? Date.now;
  }

  async view(): Promise<HomeOverviewView> {
    const source = this.options.source;
    if (!source.available) return { configured: false };
    const c = await this.current();
    const now = this.now();
    if (!c.home) return { configured: true, state: "unreachable", error: c.error ?? "unreachable", server_now: now };
    source.pollControllerReports(c.home.devices);
    return overviewFromSnapshot(c.home, source.controllerReports(), now, Math.max(0, (now - c.at) / 1000));
  }

  private async current(): Promise<Cached> {
    const source = this.options.source;
    const c = this.cached;
    const ttl = c?.afterControl ? Math.min(HOME_OVERVIEW_AFTER_CONTROL_TTL_MS, this.options.ttlMs ?? HOME_OVERVIEW_TTL_MS) : (this.options.ttlMs ?? HOME_OVERVIEW_TTL_MS);
    if (c && this.now() - c.at < ttl && c.changes === source.changes) return c;
    if (this.inflight) {
      if (this.inflight.changes === source.changes) return this.inflight.read;
      // 這個請求在控制結束前就開始了：等它結束（同時只有一個中控請求），再讀一次控制之後的狀態。
      return this.inflight.read.then(() => this.current());
    }
    const changes = source.changes;
    const afterControl = c !== null && c.changes !== changes;
    const read = source
      .readSnapshot()
      .then(
        (home): Cached => ({ at: this.now(), changes, afterControl, home, error: null }),
        (err: unknown): Cached => ({ at: this.now(), changes, afterControl, home: null, error: errorCode(err) }),
      )
      .then((next) => {
        this.cached = next;
        return next;
      })
      .finally(() => {
        if (this.inflight?.read === read) this.inflight = null;
      });
    this.inflight = { changes, read };
    return read;
  }
}
