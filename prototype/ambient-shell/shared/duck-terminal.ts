// DUCK-2：鴨子當 Nous 的語音終端（Pi 上的 Chromium 開 Nous 頁面，?terminal=<鴨子的終端 ID>）。
// 鴨子本機偵測到喚醒詞 → duck-link 的 wake_word 事件 → 核心對這個終端的頁面送 SSE voice.request →
// 頁面走既有的喚醒開始流程。這裡是核心與頁面共用的常數；沒有任何設定值。

/** 預設的鴨子終端 ID（NOUS_DUCK_TERMINAL 可以改）。 */
export const DEFAULT_DUCK_TERMINAL = "duck";

/**
 * 核心為一次鴨子喚醒發出的一次性權杖。頁面在 /api/realtime/start 帶回來，核心才把這通當成 wake_word 開始
 * （NOUS_WAKE 關閉時也一樣：喚醒是鴨子偵測的，證據是 duck-link 上的事件，不是頁面說了算）。
 */
export const DUCK_WAKE_TOKEN = /^dw_[0-9a-f]{32}$/;
/** 權杖多久沒用就作廢。 */
export const DUCK_WAKE_TTL_MS = 15_000;

/** 頁面回報給核心的語音狀態（src/realtime.ts 的 RealtimePhase，不含 off：結束由核心自己知道）。 */
export const DUCK_REPORT_PHASES = ["connecting", "listening", "hearing", "thinking", "speaking"] as const;
export type DuckReportPhase = (typeof DUCK_REPORT_PHASES)[number];

export function isDuckReportPhase(value: unknown): value is DuckReportPhase {
  return typeof value === "string" && (DUCK_REPORT_PHASES as readonly string[]).includes(value);
}
