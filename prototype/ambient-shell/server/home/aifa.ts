// AIFA 冷氣：設定檢查、完整設定的組合、關機定時說明、控制器回報與中控回覆的對應。

import { AC_FAN_TEXT, AC_FANS, AC_FEATURE_TEXT, AC_FEATURES, AC_MODE_TEXT, AC_MODES, AC_SWING_TEXT, AC_SWINGS, type AcFan, type AcFeature, type AcMode, type AcSwing } from "../../shared/home.ts";
import { isRecord, num, str } from "./parse.ts";
import { HomeBridgeError, type AifaClimateCaps, type ClimateChange, type ClimatePacket, type ControllerReport, type HubReply } from "./types.ts";

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

export const NO_CLIMATE_TEXT = "是 AIFA 家電，但中控只確認了開關；溫度、模式、風量和擺風不能用語音設定，指令沒有送出。";

/** 冷氣設定的值是否在這台冷氣的範圍內；回傳要說的錯誤，或 null。 */
export function checkClimate(c: ClimateChange, caps: AifaClimateCaps): string | null {
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
export function acOffTimerNote(reply: HubReply): string | null {
  if (reply.kind === "result" && reply.status === "unconfirmed") return reply.why === "one_way" ? AC_OFF_TIMER_NOTE : AC_OFF_TIMER_NOTE_UNSURE;
  if (reply.kind === "retry" && reply.maybeReceived) return AC_OFF_TIMER_NOTE_UNSURE;
  return null;
}

/** 「控制器回報：開、冷氣、26 度、風量低」：只能這樣說，不是冷氣的實際狀態。 */
export function reportedText(r: ControllerReport | null | undefined): string | undefined {
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
export function parseReport(v: unknown): ControllerReport | null {
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

/** 中控 AIFA 路徑的錯誤字串（backend/aifa.py）；比對完整文字。 */
export const AIFA_STALE = "請先重新讀取 AIFA 家電清單";
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
