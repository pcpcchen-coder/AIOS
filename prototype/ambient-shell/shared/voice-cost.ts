// F6 費用紀錄（docs/13 F6、docs/17 §5.7 第 3 點；WK-02）：每通即時語音的路徑、連線秒數、結束原因與已收到的 usage。
// 只有這些欄位：不含逐字稿、音訊、姓名或任何內容。缺單價或帳號用量證據，所以費用一律是 "unknown"，不推算成確定帳單。
// live（ChatGPT 方案）路徑拿不到 usage，一律 "unknown"；API key 路徑的 usage 是頁面加總 response.done 的數字（頁面回報，不是帳單）。

import type { RouteId } from "./realtime-route.ts";

/** 誰開始了這次即時語音（頁面報的；只決定互動 ID、問候與限速，不是授權）。 */
export type VoiceStartSource = "look_to_talk" | "wake_word" | "user";

/** API key 路徑加總的 usage（Realtime API response.done 的 usage 欄位）。全部是非負整數。 */
export interface VoiceUsage {
  responses: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_text_tokens: number;
  input_audio_tokens: number;
  input_cached_tokens: number;
  output_text_tokens: number;
  output_audio_tokens: number;
}

export const VOICE_USAGE_KEYS = [
  "responses",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "input_text_tokens",
  "input_audio_tokens",
  "input_cached_tokens",
  "output_text_tokens",
  "output_audio_tokens",
] as const satisfies readonly (keyof VoiceUsage)[];

/** 單一欄位的上限（頁面回報的數字；超過就截在這裡，不讓一個請求寫進離譜的值）。 */
export const VOICE_USAGE_CAP = 100_000_000;

export function emptyVoiceUsage(): VoiceUsage {
  return Object.fromEntries(VOICE_USAGE_KEYS.map((key) => [key, 0])) as unknown as VoiceUsage;
}

/**
 * 頁面回報的 usage：只取認得的鍵、非負有限數字（取整數、截在 VOICE_USAGE_CAP），其餘丟掉；沒有任何認得的鍵時回 null。
 */
export function parseVoiceUsage(value: unknown): VoiceUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const usage = emptyVoiceUsage();
  let seen = false;
  for (const key of VOICE_USAGE_KEYS) {
    const n = input[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue;
    usage[key] = Math.min(Math.floor(n), VOICE_USAGE_CAP);
    seen = true;
  }
  return seen ? usage : null;
}

/**
 * 加一個 response.done 的 usage（Realtime API 的形狀：input_tokens、output_tokens、total_tokens、
 * input_token_details.{text_tokens,audio_tokens,cached_tokens}、output_token_details.{text_tokens,audio_tokens}）。
 * 認不得的形狀只算一次回應、不加數字。
 */
export function addResponseUsage(total: VoiceUsage, raw: unknown): VoiceUsage {
  const u = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const sub = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const inDetail = sub(u.input_token_details);
  const outDetail = sub(u.output_token_details);
  const add = (a: number, b: number) => Math.min(a + b, VOICE_USAGE_CAP);
  return {
    responses: add(total.responses, 1),
    input_tokens: add(total.input_tokens, num(u.input_tokens)),
    output_tokens: add(total.output_tokens, num(u.output_tokens)),
    total_tokens: add(total.total_tokens, num(u.total_tokens)),
    input_text_tokens: add(total.input_text_tokens, num(inDetail.text_tokens)),
    input_audio_tokens: add(total.input_audio_tokens, num(inDetail.audio_tokens)),
    input_cached_tokens: add(total.input_cached_tokens, num(inDetail.cached_tokens)),
    output_text_tokens: add(total.output_text_tokens, num(outDetail.text_tokens)),
    output_audio_tokens: add(total.output_audio_tokens, num(outDetail.audio_tokens)),
  };
}

/** 頁面可以說明的結束原因（POST /api/realtime/end 的 reason）；其他值一律忽略，由核心記自己的原因。 */
export const PAGE_END_REASONS = ["no_voice"] as const;
export type PageEndReason = (typeof PAGE_END_REASONS)[number];

export function parsePageEndReason(value: unknown): PageEndReason | null {
  return typeof value === "string" && (PAGE_END_REASONS as readonly string[]).includes(value) ? (value as PageEndReason) : null;
}

/** 一筆費用紀錄（configDir/voice-cost.jsonl 的一行）。 */
export interface VoiceCostRecord {
  v: 1;
  session_id: string;
  route: RouteId;
  model: string;
  source: VoiceStartSource;
  /** 喚醒開始的通話：頁面那次喚醒的識別碼；其他為 null。 */
  wake_id: string | null;
  /** 工作階段開始連線的時間（ISO 8601）。 */
  started_at: string;
  ended_at: string;
  /** 真的連上（SDP 已交換）。 */
  connected: boolean;
  /** 連上到結束的毫秒數；沒連上為 0。 */
  connected_ms: number;
  /** ended（頁面結束）、no_voice（喚醒後沒人出聲自動結束）、page_gone、connect_failed，或 live 的關閉原因。 */
  end_reason: string;
  no_voice_auto_end: boolean;
  usage: VoiceUsage | "unknown";
  /** 沒有單價與帳號用量證據：一律未知。 */
  cost: "unknown";
}
