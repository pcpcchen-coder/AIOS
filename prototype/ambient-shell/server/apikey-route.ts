import type { RealtimeBaseInfo } from "../shared/types.ts";
import { billingLine, unavailableText, type RouteOption } from "../shared/realtime-route.ts";
import { connectApiKey, type ApiKeyBridge } from "./apikey-call.ts";
import type { LiveMemoryPort } from "./memory/live.ts";
import type { CallFollowUp } from "./proactive-calendar.ts";
import { RealtimeError, type RealtimeBridge } from "./realtime.ts";
import { RouteStartError, type Readiness, type RealtimeRoute, type RouteCall, type SessionContext } from "./realtime-contracts.ts";

// docs/23 §3 的 S7（2026-11-10）：ApiKeyRoute 從 server/realtime-routes.ts 原樣搬到這裡（對稱 server/live-route.ts）；
// server/realtime-routes.ts 照舊 re-export。這個檔不 import realtime-routes.ts。


// ─────────────────────────── api_key 路徑：薄轉接層；MEM-3 起帶記憶時另開核心旁路（server/apikey-call.ts） ───────────────────────────

export interface ApiKeyRouteOptions {
  /**
   * MEM-3：每通通話的記憶 binding（MemoryService.openVoice("api_key")）；沒有記憶層（瀏覽器版）或頁面沒有 SSE 串流時回 null，
   * 那時和 MEM-2 之前完全一樣。
   */
  memory?: (ctx: SessionContext) => LiveMemoryPort | null;
  log?: (line: string) => void;
  /** PRO-2：主動提醒的行程問句（核心旁路聽回答）。 */
  followUp?: (sessionId: string) => CallFollowUp | null;
  /** 等 session.updated 的時限（測試用；預設 3 秒）。 */
  updateAckMs?: number;
}

export class ApiKeyRoute implements RealtimeRoute {
  readonly id = "api_key" as const;

  constructor(private readonly bridge: RealtimeBridge | ApiKeyBridge & Pick<RealtimeBridge, "info">, private readonly hasKey: boolean, private readonly voice: string, private readonly options: ApiKeyRouteOptions = {}) {}

  readiness(): Readiness {
    return this.hasKey ? { ready: true } : { ready: false, reason: "no_api_key", message: unavailableText("no_api_key") };
  }

  baseInfo(): RealtimeBaseInfo {
    return this.bridge.info();
  }

  describe(): RouteOption {
    const info = this.bridge.info();
    const tools = [info.web_search ? "上網查詢（API key 計費）" : null, info.home ? "家電查詢與控制" : null, "交辦工作", ...(info.mcp ?? []).map((m) => `MCP：${m}`)]
      .filter(Boolean)
      .join("、");
    return {
      id: "api_key",
      available: this.hasKey,
      reason: this.hasKey ? null : "no_api_key",
      billing_line: billingLine("api_key", info.model),
      model: info.model,
      voice: this.voice,
      voices: [],
      tools,
      detail: info.detail,
    };
  }

  async connect(offerSdp: string, ctx: SessionContext): Promise<RouteCall> {
    // 記憶工作階段需要 SSE 串流（核心送事件、工具呼叫與撤銷給頁面）；沒有時不帶記憶。
    const memory = ctx.events ? this.options.memory?.(ctx) ?? null : null;
    try {
      return await connectApiKey(this.bridge, offerSdp, ctx, memory, { log: this.options.log, updateAckMs: this.options.updateAckMs, ...(this.options.followUp ? { followUp: this.options.followUp } : {}) });
    } catch (err) {
      if (err instanceof RouteStartError) throw err;
      if (err instanceof RealtimeError) throw new RouteStartError(err.status === 409 ? "no_api_key" : "api_key_rejected", err.status, err.message, false);
      throw err;
    }
  }
}
