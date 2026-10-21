// 家電狀態查詢（docs/12 H0）交還給模型與畫面的結果；前後端共用。

export interface Reading {
  name: string;
  /** null 表示中控沒有讀值，要說「沒有讀值」。 */
  value: number | string | boolean | null;
  unit: string;
}

export interface DeviceReport {
  device: string;
  room: string | null;
  online: "在線" | "離線" | "狀態未知";
  /** 讀值的性質；沒有感測功能的設備為 null。 */
  data: "即時" | "快照" | "過期資料" | "沒有讀值" | null;
  /** 中控收到讀值的時間（HH:mm；不是今天時為 M/D HH:mm），沒有時為 null。 */
  time: string | null;
  minutes_ago: number | null;
  source: string | null;
  readings: Reading[];
}

/** 交還給模型的結果；模型只依這些內容說話。 */
export type HomeStatusResult =
  | { ok: true; status: "ok"; scope: string; devices: DeviceReport[]; truncated: boolean }
  | { ok: true; status: "ambiguous"; candidates: string[] }
  | { ok: true; status: "not_found"; target: string }
  | { ok: true; status: "no_such_reading"; scope: string; metric: string };

function readingText(r: Reading): string {
  if (r.value === null) return `${r.name}沒有讀值`;
  if (typeof r.value === "boolean") return `${r.name}：${r.value ? "是" : "否"}`;
  return `${r.name} ${r.value}${r.unit ? ` ${r.unit}` : ""}`;
}

/** 字幕用的一行錨點：房間或設備、讀值與資料時間；快照與過期資料照實標示。 */
export function homeStatusLine(result: HomeStatusResult): string {
  switch (result.status) {
    case "ambiguous":
      return `要查哪一個：${result.candidates.join("、")}`;
    case "not_found":
      return `家裡找不到「${result.target}」`;
    case "no_such_reading":
      return `${result.scope}沒有能量${result.metric}的設備`;
    case "ok": {
      const parts = result.devices.slice(0, 3).map((d) => {
        const where = d.room && result.scope !== d.device ? `${d.room} ${d.device}` : d.device;
        if (!d.data) return `${where}：${d.online}`;
        const values = d.readings.length ? d.readings.map(readingText).join("、") : "沒有讀值";
        const when = d.time ? `（${d.data === "即時" ? "" : `${d.data} `}${d.time}）` : d.data === "沒有讀值" ? "" : `（${d.data}）`;
        return `${where}：${values}${when}`;
      });
      if (!parts.length) return `${result.scope}沒有設備`;
      return parts.join("；") + (result.devices.length > 3 || result.truncated ? "；…" : "");
    }
  }
}
