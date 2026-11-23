// 讀值名稱的正規化與查詢回報（home_status 的 DeviceReport）。

import type { DeviceReport } from "../../shared/home.ts";
import type { HubDevice, HubMetric, HubSnapshot } from "./types.ts";

/** 語音可能說的讀值名稱 → 中控的 metric key。 */
export const METRICS: Record<string, string[]> = {
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

const DATA_TEXT = { live: "即時", snapshot: "快照", stale: "過期資料", missing: "沒有讀值" } as const;

export function norm(text: string): string {
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
export function splitMetric(target: string): { rest: string; metric: string | null } {
  for (const [key, words] of Object.entries(METRICS)) {
    for (const w of words) {
      const n = norm(w);
      if (target.includes(n)) return { rest: target.replace(n, ""), metric: key };
    }
  }
  return { rest: target, metric: null };
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
