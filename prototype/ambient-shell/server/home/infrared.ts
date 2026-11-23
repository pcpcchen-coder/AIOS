// 紅外線家電：按鍵名稱正規化、按鍵比對與中控回覆的對應。

import { IR_INTENT_TEXT, type HomeCommand, type IrIntent } from "../../shared/home.ts";
import { isRecord, str } from "./parse.ts";
import { HomeBridgeError, type HubReply, type IrKey, type Refusal } from "./types.ts";

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
