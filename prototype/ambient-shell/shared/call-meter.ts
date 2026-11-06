// 即時語音通話的計時與用量顯示（費用防護，George 2026-11-06）：頁面的語音指示與設定畫面共用。
// macOS 選單列另有同樣格式的一份（desktop/settings-menu.mjs 的 realtimeMeter；main.mjs 不能 import shared/）。
// tokens 是 API key 路徑頁面加總 response.done 的 usage（頁面回報的數字，不是帳單）；ChatGPT 方案路徑拿不到 usage，照實說用量不明。

import type { RouteId } from "./realtime-route.ts";
import type { VoiceUsage } from "./voice-cost.ts";

/** 顯示用的文字（英文在 src/messages.en.json；選單列的在 desktop/messages.en.json）。 */
export const CALL_METER_TEXT = {
  tokens: "約 {0} tokens",
  liveUnknown: "ChatGPT 方案：用量不明",
  tokensNote: "tokens 是頁面加總 response.done 回報的數字（約略），不是帳單",
} as const;

/** 「3:07」「1:02:05」：通話經過的時間（不足一秒捨去）。 */
export function formatCallClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export interface CallMeterInput {
  route: RouteId;
  /** 連上的時間（epoch ms）；還在連線時為 null（不顯示）。 */
  startedAt: number | null;
  maxMs: number;
  usage: VoiceUsage | null;
}

/**
 * 「3:07 / 20:00 · 約 3,400 tokens」或「3:07 / 20:00 · ChatGPT 方案：用量不明」。還沒連上時回空字串。
 * API key 路徑還沒有任何 response.done 時只顯示時間（沒有數字可說）。
 */
export function callMeterText(input: CallMeterInput, now: number, translate: (source: string, ...values: unknown[]) => string): string {
  if (input.startedAt === null) return "";
  const clock = `${formatCallClock(now - input.startedAt)} / ${formatCallClock(input.maxMs)}`;
  if (input.route === "live") return `${clock} · ${translate(CALL_METER_TEXT.liveUnknown)}`;
  if (!input.usage) return clock;
  return `${clock} · ${translate(CALL_METER_TEXT.tokens, input.usage.total_tokens.toLocaleString("en-US"))}`;
}
