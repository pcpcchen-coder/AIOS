// 家電狀態查詢（docs/12 H0）與控制（H1）交還給模型與畫面的結果；前後端共用。

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

// ───────── 家電控制（docs/12 H1）─────────

/**
 * 語音工具可以要求的指令；工具的 command enum、parseCommand 與指令表都由這份產生。
 * color_temperature 是燈的色溫（K），送到中控時才改名為中控的 temperature：故意不同名，避免把「冷氣 26 度」送進來。
 */
export const HOME_COMMANDS = ["power", "brightness", "color_temperature", "color", "volume", "mute", "play", "pause", "stop", "cover"] as const;
export type HomeCommandName = (typeof HOME_COMMANDS)[number];

/** 解析並檢查過範圍的指令：這個型別的值一定通過中控的檢查。 */
export type HomeCommand =
  | { command: "power"; value: boolean }
  | { command: "brightness"; value: number }
  | { command: "color_temperature"; kelvin: number }
  | { command: "color"; value: string }
  | { command: "volume"; value: number }
  | { command: "mute"; value: boolean }
  | { command: "play" | "pause" | "stop" }
  | { command: "cover"; value: "open" | "close" | "stop" };

/** 確認卡、字幕與系統通知共用的動作說法：「關閉」「亮度 60%」「色溫 3000 K」…。 */
export function commandText(c: HomeCommand): string {
  switch (c.command) {
    case "power":
      return c.value ? "開啟" : "關閉";
    case "brightness":
      return `亮度 ${c.value}%`;
    case "color_temperature":
      return `色溫 ${c.kelvin} K`;
    case "color":
      return `顏色 ${c.value}`;
    case "volume":
      return `音量 ${c.value}`;
    case "mute":
      return c.value ? "靜音" : "取消靜音";
    case "play":
      return "播放";
    case "pause":
      return "暫停";
    case "stop":
      return "停止播放";
    case "cover":
      return c.value === "open" ? "打開" : c.value === "close" ? "關上" : "停住";
  }
}

export type HomeTarget = {
  device: string;
  room: string | null;
};

/** 沒有送出的原因：每一種都表示中控沒有收到指令。 */
export type RefusedReason =
  | "not_configured"
  | "not_ready"
  | "unsupported"
  | "invalid_value"
  | "rate_limited"
  | "voice_disabled"
  | "declined"
  | "expired";

/**
 * home_control 交還給模型與字幕的結果；中控的 HTTP 狀態、id 與錯誤格式都在 HomeBridge 裡解析掉。
 * confirmed／unconfirmed／failed：中控收到了（或可能收到了）；refused：沒有送出；其餘等使用者回答。
 * unconfirmed 一律不是成功：hub_unverified＝中控送出但設備沒確認；no_reply＝中控兩次都沒回覆，不確定有沒有執行。
 */
export type HomeControlResult =
  | ({ ok: true; status: "confirmed"; action: string; message: string } & HomeTarget)
  | ({ ok: true; status: "unconfirmed"; why: "hub_unverified" | "no_reply"; action: string; message: string } & HomeTarget)
  | ({ ok: true; status: "failed"; reason: "device" | "hub_unreachable" | "internal"; action: string; message: string } & HomeTarget)
  | ({ ok: true; status: "refused"; reason: RefusedReason; message: string; retry_after_s?: number } & Partial<HomeTarget>)
  | { ok: true; status: "ambiguous"; candidates: string[] }
  | { ok: true; status: "not_found"; target: string }
  | ({ ok: true; status: "needs_confirmation"; confirm_id: string; action: string; expires_in_s: number } & HomeTarget);

function where(t: HomeTarget): string {
  return t.room && !t.device.includes(t.room) ? `${t.room} ${t.device}` : t.device;
}

/** 字幕用的一行錨點（✓ 已確認／⏳ 已送出、未確認／✕ 失敗）；未確認不寫成成功。 */
export function homeControlLine(r: HomeControlResult): string {
  switch (r.status) {
    case "confirmed":
      return `✓ ${where(r)} ${r.action}：已確認`;
    case "unconfirmed":
      return r.why === "no_reply"
        ? `? ${where(r)} ${r.action}：中控沒有回覆，不確定有沒有執行`
        : `⏳ ${where(r)} ${r.action}：已送出、未確認`;
    case "failed":
      return `✕ ${where(r)} ${r.action}：失敗（${r.message}）`;
    case "refused":
      return `沒有送出：${r.message}`;
    case "ambiguous":
      return `要控制哪一個：${r.candidates.join("、")}`;
    case "not_found":
      return `家裡找不到「${r.target}」`;
    case "needs_confirmation":
      return `請確認：${where(r)} ${r.action}`;
  }
}

/** 確認卡之後才到的結果：交給模型轉告的系統通知內容。 */
export function homeControlNotice(r: HomeControlResult): string {
  switch (r.status) {
    case "confirmed":
      return `${where(r)}「${r.action}」已由設備回讀確認。`;
    case "unconfirmed":
      return r.why === "no_reply"
        ? `${where(r)}「${r.action}」中控沒有回覆，不確定有沒有執行；請使用者看一下設備，不要說成功。`
        : `${where(r)}「${r.action}」已送出，但設備還沒確認；請使用者看一下有沒有反應，不要說成功。`;
    case "failed":
      return `${where(r)}「${r.action}」沒有成功：${r.message}`;
    case "refused":
      return `家電指令沒有執行：${r.message}`;
    default:
      return homeControlLine(r);
  }
}
