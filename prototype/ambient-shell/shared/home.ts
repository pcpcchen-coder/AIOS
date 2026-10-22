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

// ───────── 家電控制（docs/12 H1、H1b）─────────

/**
 * 語音工具可以要求的指令；工具的 command enum、parseCommand 與指令表都由這份產生。
 * color_temperature 是燈的色溫（K），送到中控時才改名為中控的 temperature：故意不同名，避免把「冷氣 26 度」送進來。
 * H1b：ac_temperature／ac_mode／ac_fan／ac_swing 只給 AIFA 冷氣（設定溫度故意不叫 temperature，也不是讀值名稱）；
 * press 是紅外線家電（電視、電風扇…）按一個遙控鍵。power 與 mute 三條路徑共用：紅外線家電上是按電源鍵／靜音鍵（切換鍵）。
 */
export const HOME_COMMANDS = [
  "power",
  "brightness",
  "color_temperature",
  "color",
  "volume",
  "mute",
  "play",
  "pause",
  "stop",
  "cover",
  "ac_temperature",
  "ac_mode",
  "ac_fan",
  "ac_swing",
  "press",
] as const;
export type HomeCommandName = (typeof HOME_COMMANDS)[number];

/** AIFA 冷氣（設定碼 173）用語音能設定的值；沒有暖氣與送風。實際可用的以中控的 capabilities 為準。 */
export const AC_MODES = ["auto", "cool", "dry"] as const;
export const AC_FANS = ["auto", "low", "medium", "high"] as const;
export const AC_SWINGS = ["auto", "fixed_1", "fixed_2", "fixed_3", "fixed_4", "fixed_5"] as const;
export const AC_FEATURES = ["normal", "sleep", "turbo", "energy_saving"] as const;
export type AcMode = (typeof AC_MODES)[number];
export type AcFan = (typeof AC_FANS)[number];
export type AcSwing = (typeof AC_SWINGS)[number];
export type AcFeature = (typeof AC_FEATURES)[number];

export const AC_MODE_TEXT: Record<AcMode, string> = { auto: "自動", cool: "冷氣", dry: "除濕" };
export const AC_FAN_TEXT: Record<AcFan, string> = { auto: "自動", low: "低", medium: "中", high: "高" };
export const AC_SWING_TEXT: Record<AcSwing, string> = { auto: "自動", fixed_1: "固定 1", fixed_2: "固定 2", fixed_3: "固定 3", fixed_4: "固定 4", fixed_5: "固定 5" };
export const AC_FEATURE_TEXT: Record<AcFeature, string> = { normal: "一般", sleep: "睡眠", turbo: "強力", energy_saving: "節能" };

/** 紅外線家電的常用按鍵意圖；HomeBridge 依設備實際同步的按鍵名稱找對應的鍵，其他說法當成按鍵名稱。 */
export const IR_INTENTS = ["power", "volume_up", "volume_down", "mute", "channel_up", "channel_down", "fan_speed", "oscillate"] as const;
export type IrIntent = (typeof IR_INTENTS)[number];
export const IR_INTENT_TEXT: Record<IrIntent, string> = {
  power: "電源",
  volume_up: "音量加",
  volume_down: "音量減",
  mute: "靜音",
  channel_up: "頻道加",
  channel_down: "頻道減",
  fan_speed: "風速",
  oscillate: "擺頭",
};

/** 解析並檢查過範圍的指令：這個型別的值一定通過中控的檢查（冷氣的範圍再依那台冷氣的 capabilities 檢查一次）。 */
export type HomeCommand =
  | { command: "power"; value: boolean }
  | { command: "brightness"; value: number }
  | { command: "color_temperature"; kelvin: number }
  | { command: "color"; value: string }
  | { command: "volume"; value: number }
  | { command: "mute"; value: boolean }
  | { command: "play" | "pause" | "stop" }
  | { command: "cover"; value: "open" | "close" | "stop" }
  | { command: "ac_temperature"; celsius: number }
  | { command: "ac_mode"; value: AcMode }
  /** up／down 依控制器回報的目前風量調一格；不知道目前風量時不送出。 */
  | { command: "ac_fan"; value: AcFan | "up" | "down" }
  | { command: "ac_swing"; value: AcSwing }
  /** spoken 是使用者說的按鍵；是常用意圖時 intent 有值。 */
  | { command: "press"; intent: IrIntent | null; spoken: string };

/** 確認卡、字幕與系統通知共用的動作說法：「關閉」「亮度 60%」「色溫 3000 K」「設定 26 度」…。 */
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
    case "ac_temperature":
      return `設定 ${c.celsius} 度`;
    case "ac_mode":
      return `模式改成${AC_MODE_TEXT[c.value]}`;
    case "ac_fan":
      return c.value === "up" ? "風量調大" : c.value === "down" ? "風量調小" : `風量${AC_FAN_TEXT[c.value]}`;
    case "ac_swing":
      return `擺風${AC_SWING_TEXT[c.value]}`;
    case "press":
      return `按「${c.intent ? IR_INTENT_TEXT[c.intent] : c.spoken}」`;
  }
}

/** 已經找到設備上真正的按鍵後的動作說法：「按下「Vol+」鍵」。 */
export function keyAction(label: string): string {
  return `按下「${label}」鍵`;
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
 * unconfirmed 的原因，每一種都不是成功：
 * - hub_unverified：中控送出了，但設備回讀沒有確認（H1）。
 * - no_reply：中控兩次都沒回覆，或中控記錄還停在處理中；不確定有沒有執行。
 * - one_way：AIFA 冷氣與紅外線家電（H1b）：中控已送出，但這類設備不會回報，永遠無法確認，要請使用者看一下。
 * - cloud_no_reply：紅外線：中控沒有收到 Tuya 雲端的回覆，不確定有沒有送出（中控不會自動重送）。
 */
export type UnconfirmedWhy = "hub_unverified" | "no_reply" | "one_way" | "cloud_no_reply";

/** AIFA 冷氣與紅外線結果的附加事實；H1 的結果不帶這些欄位。 */
export type SendFacts = {
  /** 紅外線：實際按下的按鍵名稱（中控同步的名稱），例如「Vol+」。 */
  key?: string;
  /** 紅外線：按的是電源切換鍵，不能說成已開或已關。 */
  toggle?: true;
  /** AIFA 冷氣設定：實際送出的完整設定，例如「冷氣、26 度、風量自動、擺風自動」。 */
  sent_settings?: string;
  /** AIFA 冷氣設定：控制器沒有回報、改用預設值的項目，要說出來。 */
  defaults_used?: string[];
  /** AIFA：「控制器回報：…」，是控制器記得的設定，不是冷氣的實際狀態。 */
  controller_reported?: string;
  /** 補充說明，例如「這個設定不代表會開機」。 */
  note?: string;
};

/**
 * home_control 交還給模型與字幕的結果；中控的 HTTP 狀態、id 與錯誤格式都在 HomeBridge 裡解析掉。
 * confirmed／unconfirmed／failed：中控收到了（或可能收到了）；refused：沒有送出；其餘等使用者回答。
 * unconfirmed 一律不是成功（原因見 UnconfirmedWhy）；AIFA 冷氣與紅外線家電永遠不會是 confirmed。
 */
export type HomeControlResult =
  | ({ ok: true; status: "confirmed"; action: string; message: string } & HomeTarget)
  | ({ ok: true; status: "unconfirmed"; why: UnconfirmedWhy; action: string; message: string } & HomeTarget & SendFacts)
  | ({ ok: true; status: "failed"; reason: "device" | "hub_unreachable" | "internal"; action: string; message: string } & HomeTarget & SendFacts)
  | ({ ok: true; status: "refused"; reason: RefusedReason; message: string; retry_after_s?: number } & Partial<HomeTarget>)
  | { ok: true; status: "ambiguous"; candidates: string[] }
  /** note：AIFA 冷氣清單讀不到時帶上，不把「找不到」說成確定的事。 */
  | { ok: true; status: "not_found"; target: string; note?: string }
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
      if (r.why === "one_way") return `⏳ ${where(r)} ${r.action}：已送出，請確認${r.toggle ? "（電源鍵是切換鍵）" : ""}`;
      if (r.why === "cloud_no_reply") return `? ${where(r)} ${r.action}：雲端沒有回覆，不確定有沒有送出（中控不會自動重送）`;
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
      return r.note ? `家裡找不到「${r.target}」（${r.note}）` : `家裡找不到「${r.target}」`;
    case "needs_confirmation":
      return `請確認：${where(r)} ${r.action}`;
  }
}

/** AIFA／紅外線結果的附加事實，接在系統通知後面（模型照著說）。 */
function factsText(r: SendFacts): string {
  const parts: string[] = [];
  if (r.sent_settings) parts.push(`送出的設定：${r.sent_settings}。`);
  if (r.defaults_used?.length) parts.push(`控制器沒有回報、用了預設值：${r.defaults_used.join("、")}，要告訴使用者。`);
  if (r.controller_reported) parts.push(`${r.controller_reported}（只是控制器記得的設定，不是冷氣的實際狀態）。`);
  if (r.toggle) parts.push("按的是電源切換鍵，不能說已開或已關。");
  if (r.note) parts.push(r.note);
  return parts.join("");
}

/** 確認卡之後才到的結果：交給模型轉告的系統通知內容。 */
export function homeControlNotice(r: HomeControlResult): string {
  switch (r.status) {
    case "confirmed":
      return `${where(r)}「${r.action}」已由設備回讀確認。`;
    case "unconfirmed":
      if (r.why === "one_way") return `${where(r)}「${r.action}」已送出，但這類設備不會回報結果；請使用者看一下有沒有反應，不要說成功。${factsText(r)}`;
      if (r.why === "cloud_no_reply") return `${where(r)}「${r.action}」雲端沒有回覆，不確定有沒有送出（中控不會自動重送）；請使用者看一下，不要說成功。${factsText(r)}`;
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
