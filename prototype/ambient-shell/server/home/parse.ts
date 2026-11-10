// 中控 JSON 的解析（GET /api/v1/home、GET /api/v1/integrations/aifa）與設備走哪條控制路徑。

import { AC_FANS, AC_FEATURES, AC_MODES, AC_SWINGS } from "../../shared/home.ts";
import type { AifaClimateCaps, AifaListState, DeviceRoute, HubDataStatus, HubDevice, HubMetric, HubSnapshot, IrKey, UnsupportedWhy } from "./types.ts";

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 中控的資料狀態；不認得的狀態有讀值時當過期資料，不說成即時，也不和讀值互相矛盾。 */
function dataStatus(status: string, metrics: HubMetric[]): HubDataStatus {
  if (status === "live" || status === "snapshot" || status === "stale" || status === "missing") return status;
  return metrics.some((m) => m.value !== null) ? "stale" : "missing";
}

/** Tuya 雲端的冷氣類別（kt 冷氣、ktkzq 冷氣控制器）；中控匯入時把它們當成 switch，只在 config.cloud_category 留下原類別。 */
const TUYA_AIR_CON = new Set(["kt", "ktkzq"]);

export const UNSUPPORTED_TEXT: Record<UnsupportedWhy, string> = {
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
      power: reportedPowerValue(state),
      observedAgeS: num(state.age_seconds),
      route,
      telemetry: t
        ? { metrics, status: dataStatus(str(t.status), metrics), receivedAt: num(t.received_at), source: str(t.source_label) }
        : null,
    };
  });
  return { rooms, devices: devices.filter((d) => d.id && d.name), serverTime: num(body.server_time) ?? Date.now() / 1000 };
}

/** SmartHomeAI 的 observation 把開關放在 state.values.power；舊格式的 state.power 也接受。 */
function reportedPowerValue(state: Record<string, unknown>): boolean | null {
  const values = state.values && typeof state.values === "object" ? (state.values as Record<string, unknown>) : null;
  if (typeof values?.power === "boolean") return values.power;
  return typeof state.power === "boolean" ? state.power : null;
}

export const aifaId = (hubId: string, childId: string) => `aifa:${hubId}:${childId}`;

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
