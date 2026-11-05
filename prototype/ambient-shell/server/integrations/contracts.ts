import type { CapabilityStatus, EffectClass, HealthReason, IntegrationHealth, IntegrationRoute, IntegrationToolId, ToolResult } from "../../shared/integrations.ts";
import type { InputSchema } from "./schema.ts";

// AIL-1（docs/18 §4）：Adapter 契約。只有程式碼裡明確註冊的 Adapter（server/integrations/adapters/）；
// 不動態載入第三方程式碼，模型也沒有任何方法新增、啟用或設定工具。

export interface ToolDefinition {
  /** app.<service>.<action>；service 必須等於 Adapter 的 service。 */
  id: IntegrationToolId;
  /** 給模型看的說明（中文；英文介面另外提供 descriptionEn）。 */
  description: string;
  descriptionEn?: string;
  inputSchema: InputSchema;
  effect: EffectClass;
  /** Adapter 預設是否提供；最後還要看核心設定（NOUS_AIL_SERVICES）。 */
  enabled: boolean;
  /** 單次執行的時限（100 ms 到 60 s）。 */
  timeoutMs: number;
  /** 這個工具接受的呼叫來源。 */
  supportedRoutes: readonly IntegrationRoute[];
  /**
   * AIL-2：既有工具的 Facade（例如 home_status）。模型看到的仍是 server/realtime.ts 原本的工具定義（一個位元組都不變），
   * 所以這種工具**不會**出現在 functionSpecs；Adapter 的結果放在 data 原封不動交回（不截大小、不套 Dispatcher 的頻率限制，
   * 由原本的模組自己控管），可以用 scalar 參數，時限可到 90 秒。
   */
  legacyName?: string;
}

export interface ExecutionContext {
  actor: "user" | "agent";
  route: IntegrationRoute;
  sessionId: string;
  /** 核心產生的請求 ID（不含使用者內容）；有副作用的 Adapter 用它當 idempotency key。 */
  requestId: string;
  signal: AbortSignal;
}

export interface HealthReport {
  health: IntegrationHealth;
  reason: HealthReason;
}

export interface IntegrationAdapter {
  /** Adapter ID（例如 mock、spotify_soloist），註冊時唯一。 */
  readonly id: string;
  /** 工具 ID 的服務段（例如 mock、spotify）。 */
  readonly service: string;
  readonly version: number;
  /** 模擬的 Adapter（測試或示範）：狀態與結果一律標示 mock。 */
  readonly mock: boolean;
  tools(): readonly ToolDefinition[];
  health(signal: AbortSignal): Promise<HealthReport>;
  execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult>;
}

/** 一個工具在目前設定下的完整狀態（診斷用；不給模型）。 */
export interface ToolCapability {
  id: IntegrationToolId;
  adapter: string;
  effect: EffectClass;
  supportedRoutes: readonly IntegrationRoute[];
  capabilityStatus: CapabilityStatus;
}

/** 交給即時語音工具表的函式規格（兩條路徑相同的形狀）。 */
export interface IntegrationFunctionSpec {
  type: "function";
  name: string;
  description: string;
  parameters: InputSchema;
}
