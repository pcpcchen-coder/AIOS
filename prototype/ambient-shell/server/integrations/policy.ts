import type { EffectClass, IntegrationToolId } from "../../shared/integrations.ts";
import { serviceOf } from "../../shared/integrations.ts";

// AIL-1（docs/18 §4、§5）：政策。集中在這裡，Registry 與 Dispatcher 都只問這個檔案。

/**
 * Spotify 語音控制 gate（docs/18 §5、SP-2 BLOCKED）：Spotify Developer Policy III.3 禁止未經授權的語音控制整合，
 * Premium Family 不等於授權。在取得書面授權並由 George 開 gate 之前，任何 app.spotify.* 工具都不能註冊成模型可用的工具
 * （包括 play、pause、search_and_play，也包括經 Soloist WebSocket 或鍵盤模擬的替代做法）。SP-1 的 Spotify 健康狀態只經
 * 核心的狀態檢查與 HTTP 狀態頁，不是模型工具。改這個常數需要另開 PR 並附官方條款或書面授權證據。
 */
export const SPOTIFY_VOICE_CONTROL_GATE = "blocked" as const;

/** 註冊時的政策檢查：回傳拒絕原因，或 null（可以註冊）。 */
export function registrationRefusal(id: IntegrationToolId): string | null {
  if (serviceOf(id) === "spotify" && SPOTIFY_VOICE_CONTROL_GATE === "blocked") {
    return "Spotify 語音控制未取得授權（docs/18 §5，SP-2 BLOCKED）：app.spotify.* 不能註冊成模型工具";
  }
  return null;
}

/**
 * 不需要當次確認的 external_commit 工具（使用者明確決定的例外；產品紅線預設每次確認）。
 * 每一項都要寫是誰、哪一天、為什麼；新增例外需要使用者本人的決定。
 */
export const CONFIRMATION_EXEMPT_TOOLS: Readonly<Record<string, string>> = {
  // MAIL-1：收件人固定是 George 自己（NOUS_MAIL_SELF），模型改不了收件人。
  "app.mail.send_to_self": "George 2026-11-04：寄給自己的信每次不用確認，直接寄",
};

/** 執行前的決定：run 直接執行；confirm 需要使用者當次確認。 */
export type PolicyDecision = { kind: "run" } | { kind: "confirm" };

/**
 * read 與 reversible_write 直接執行；external_commit（寄出、發布、付費、永久刪除）一律要當次確認（產品紅線）。
 * AIL-1 還沒有接上確認卡，所以 Dispatcher 對 confirm 一律回 refused（confirmation_unavailable），不會執行。
 */
export function decide(effect: EffectClass, id?: IntegrationToolId): PolicyDecision {
  if (effect === "external_commit" && id && Object.hasOwn(CONFIRMATION_EXEMPT_TOOLS, id)) return { kind: "run" };
  return effect === "external_commit" ? { kind: "confirm" } : { kind: "run" };
}

/** 每個 Adapter 每分鐘最多幾次呼叫（所有路徑合計）。 */
export const RATE_LIMIT_PER_MINUTE = 30;

/** 結果 data 序列化後的上限（位元組）；超過就不交回模型。 */
export const MAX_RESULT_DATA_BYTES = 4_096;

/** 工具時限的範圍（模型工具）。 */
export const TIMEOUT_RANGE_MS = { min: 100, max: 60_000 } as const;
/** AIL-2：legacy Facade 工具的時限上限（家電控制一句話最多 60 秒，加上讀中控清單）。 */
export const LEGACY_TIMEOUT_MAX_MS = 90_000;
/** AIL-2：legacy Facade 工具交回的原始結果上限（位元組）；只防異常，正常的家電結果遠小於此。 */
export const MAX_LEGACY_DATA_BYTES = 262_144;

/** 簡單的滑動視窗計數器（每個 Adapter 一個）。 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perMinute: number = RATE_LIMIT_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  /** 還有額度就記一次並回 true。 */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
