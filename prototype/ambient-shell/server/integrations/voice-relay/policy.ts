import type { CommandEntry, IntentDef, Target } from "../../../shared/voice-relay.ts";
import { normalizeSpoken } from "./catalog.ts";

// VCR-0（docs/19 §5）：下游用途政策。在審閱檢查之前執行，所以候選模板也會回報 policy_blocked；診斷模式不能繞過。
// - 只有 riskClass low 的意圖可以播（付款、門鎖、保全、購物、帳號都不是 V1 意圖，就算有也一律擋）。
// - Spotify 語音控制未取得授權（docs/18 §5、SP-2 BLOCKED）：依實際用途判斷，不只看標籤——
//   目標的音樂服務是 Spotify 或不知道是什麼時，所有音樂類意圖一律擋下；下游標成 Spotify 的模板擋下；
//   命令文字（NFKC、小寫、拿掉空白與零寬／雙向格式字元後）提到 Spotify 也擋下。

export type RelayPolicyResult = { ok: true } | { ok: false; detail: "risk_class" | "spotify_downstream" | "spotify_music_service" | "music_service_unknown" | "spotify_text" };

const SPOTIFY_TEXT = /spotify|聲破天/i;

export function relayPolicy(intent: IntentDef, entry: CommandEntry, target: Target, renderedCommand: string): RelayPolicyResult {
  if (intent.riskClass !== "low") return { ok: false, detail: "risk_class" };
  if (entry.downstreamService === "spotify") return { ok: false, detail: "spotify_downstream" };
  if (intent.category === "music" || entry.downstreamService === "configured_music_service") {
    if (target.musicService === "spotify") return { ok: false, detail: "spotify_music_service" };
    if (target.musicService === "unknown") return { ok: false, detail: "music_service_unknown" };
  }
  if (SPOTIFY_TEXT.test(normalizeSpoken(renderedCommand))) return { ok: false, detail: "spotify_text" };
  return { ok: true };
}
