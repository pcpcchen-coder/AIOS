import { toolResult, type IntegrationToolId, type ToolResult, type ToolResultStatus } from "../../../shared/integrations.ts";
import type { HomeControlResult, HomeStatusResult } from "../../../shared/home.ts";
import { HomeBridgeError, type ControlRequest } from "../../home-bridge.ts";
import type { HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// AIL-2（docs/18 §6）：HomeBridge Facade。武陵居家電的三支本機 API（/api/home/status、control、confirm）改經整合層的
// Registry／Dispatcher 呼叫 HomeBridge，但**行為不變**（H0／H1／H1b 回歸無差異）：
// - 模型看到的仍是 server/realtime.ts 的 home_status／home_control（legacyName；不進 functionSpecs，一個位元組都不變）。
// - HomeBridge 的結果原封不動放在 data.legacy，HTTP 照原樣回給頁面；確認卡、busy、needs_confirmation 仍由頁面的 ApprovalQueue 處理。
// - HomeBridge 自己的速率限制、逾時預算（UTTERANCE_MS）、設備政策、回讀與確認都不變；Dispatcher 不另外限速。
// - HomeBridgeError（未設定、連不上、權杖被拒、格式不符）放在 data.http_error，HTTP 照原本的狀態碼與訊息回。
// 整合層多給的是：同一份 Registry 啟用設定（NOUS_AIL_SERVICES=home）、參數驗證、稽核紀錄（不含目標與數值）與按需健康狀態。

/** HomeBridge 中 Facade 會用到的部分（測試可替換）。 */
export interface HomeBridgePort {
  readonly available: boolean;
  probe(): Promise<void>;
  status(target: string, metric?: string | null): Promise<HomeStatusResult>;
  control(req: ControlRequest): Promise<HomeControlResult>;
  confirm(confirmId: string, approve: boolean): Promise<HomeControlResult>;
}

export const HOME_TOOL = {
  status: "app.home.status",
  control: "app.home.control",
  confirm: "app.home.confirm",
} as const satisfies Record<string, IntegrationToolId>;

/**
 * 時限：status 讀快照（8 秒）＋可能的 AIFA 狀態（22 秒）；control／confirm 是 HomeBridge 的 UTTERANCE_MS（60 秒）加上讀快照。
 * Dispatcher 的時限只是保險，正常一定是 HomeBridge 先結束。
 */
export const HOME_TIMEOUTS_MS = { status: 45_000, control: 80_000, confirm: 80_000 } as const;

const TOOLS: readonly ToolDefinition[] = [
  {
    id: HOME_TOOL.status,
    legacyName: "home_status",
    description: "（Facade）home_status 經整合層呼叫 HomeBridge.status；模型看到的是原本的 home_status。",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", minLength: 1, maxLength: 100 }, metric: { type: "string", maxLength: 40 } },
      required: ["target"],
      additionalProperties: false,
    },
    effect: "read",
    enabled: true,
    timeoutMs: HOME_TIMEOUTS_MS.status,
    supportedRoutes: ["page"],
  },
  {
    id: HOME_TOOL.control,
    legacyName: "home_control",
    description: "（Facade）home_control 經整合層呼叫 HomeBridge.control；設備政策與確認卡由 HomeBridge 與頁面處理，不變。",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", minLength: 1, maxLength: 100 }, command: { type: "string", minLength: 1, maxLength: 40 }, value: { type: "scalar", maxLength: 40 } },
      required: ["target", "command"],
      additionalProperties: false,
    },
    // 可撤回的家電動作；需要確認的設備由 HomeBridge 的設備政策回 needs_confirmation（不是整合層的 external_commit）。
    effect: "reversible_write",
    enabled: true,
    timeoutMs: HOME_TIMEOUTS_MS.control,
    supportedRoutes: ["page"],
  },
  {
    id: HOME_TOOL.confirm,
    legacyName: "home_confirm",
    description: "（Facade）家電確認卡的答案經整合層交給 HomeBridge.confirm；只由頁面的確認卡呼叫，不給模型。",
    inputSchema: {
      type: "object",
      properties: { confirm_id: { type: "string", minLength: 6, maxLength: 69 }, approve: { type: "boolean" } },
      required: ["confirm_id", "approve"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: HOME_TIMEOUTS_MS.confirm,
    supportedRoutes: ["page"],
  },
];

/** HomeBridge 的 status → 統一結果的 status（只用來稽核與診斷；頁面拿到的是 data.legacy 原文）。 */
export function homeStatusOf(result: HomeStatusResult | HomeControlResult): ToolResultStatus {
  switch (result.status) {
    case "ok":
    case "confirmed":
      return "confirmed";
    case "unconfirmed":
      return "unconfirmed";
    case "failed":
      return "failed";
    case "needs_confirmation":
      return "needs_confirmation";
    default:
      // ambiguous、not_found、no_such_reading、refused、busy：沒有執行任何動作。
      return "refused";
  }
}

export class HomeAdapter implements IntegrationAdapter {
  readonly id = "home";
  readonly service = "home";
  readonly version = 1;
  readonly mock = false;

  constructor(
    private readonly bridge: HomeBridgePort,
    /** 測試用：縮短 Dispatcher 的保險時限。 */
    private readonly timeoutsMs: Partial<Record<keyof typeof HOME_TIMEOUTS_MS, number>> = {},
  ) {}

  tools(): readonly ToolDefinition[] {
    if (!Object.keys(this.timeoutsMs).length) return TOOLS;
    const key = (id: string) => (id === HOME_TOOL.status ? "status" : id === HOME_TOOL.control ? "control" : "confirm") as keyof typeof HOME_TIMEOUTS_MS;
    return TOOLS.map((t) => ({ ...t, timeoutMs: this.timeoutsMs[key(t.id)] ?? t.timeoutMs }));
  }

  /** 讀一次中控快照：讀得到才是可用；權杖被拒或設定不對是不可用；連不上或逾時是不可用／狀態不明。 */
  async health(): Promise<HealthReport> {
    if (!this.bridge.available) return { health: "unavailable", reason: "not_configured" };
    try {
      await this.bridge.probe();
      return { health: "available", reason: "ok" };
    } catch (err) {
      if (err instanceof HomeBridgeError) {
        if (err.status === 409) return { health: "unavailable", reason: "not_configured" };
        // HomeBridgeError 都是 502，只能從固定訊息分辨：逾時、權杖或權限被拒、其他（連不上、格式不符、回應錯誤）。
        if (err.message.includes("逾時")) return { health: "unknown", reason: "timeout" };
        if (/權杖|權限/.test(err.message)) return { health: "unavailable", reason: "error" };
        if (err.message.includes("格式不符")) return { health: "unknown", reason: "bad_reply" };
        return { health: "unavailable", reason: "connection_refused" };
      }
      return { health: "unknown", reason: "error" };
    }
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const legacy =
        toolId === HOME_TOOL.status
          ? await this.bridge.status(String(args.target), typeof args.metric === "string" ? args.metric : null)
          : toolId === HOME_TOOL.control
            ? await this.bridge.control({ target: String(args.target), command: String(args.command), value: (args.value ?? null) as ControlRequest["value"] })
            : toolId === HOME_TOOL.confirm
              ? await this.bridge.confirm(String(args.confirm_id), args.approve === true)
              : null;
      if (!legacy) return toolResult("refused", "沒有這個整合工具，沒有執行。", { reason: "not_registered" });
      return toolResult(homeStatusOf(legacy), "home", { data: { legacy } });
    } catch (err) {
      // 和中控完全無法溝通（HomeBridgeError）：HTTP 照原本的狀態碼與訊息回（行為和 Facade 之前相同）。
      if (err instanceof HomeBridgeError) return toolResult("failed", "home", { reason: "unavailable", data: { http_error: { status: err.status, message: err.message } } });
      // 其他錯誤（程式錯誤）：原樣交回，由 HTTP 層照原本的方式處理（500），和 Facade 之前相同。
      return toolResult(toolId === HOME_TOOL.status ? "failed" : "unknown", "home", { reason: "adapter_error", data: { rethrow: err } });
    }
  }
}
