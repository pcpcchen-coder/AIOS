import type { CapabilityStatus, EffectClass, HealthReason, IntegrationHealth, IntegrationRoute, IntegrationToolId, ToolResult } from "../../shared/integrations.ts";
import type { Domain } from "../../shared/domain.ts";
import type { Locale } from "../../shared/i18n.mjs";
import type { InputSchema } from "./schema.ts";

// AIL-1（docs/18 §4）：Adapter 契約。只有程式碼裡明確註冊的 Adapter（server/integrations/adapters/）；
// 不動態載入第三方程式碼，模型也沒有任何方法新增、啟用或設定工具。

/**
 * CAP-1（docs/24 §3.1）：給人看的總表資料。**不會**送給模型（functionSpecs 只取 description 與 inputSchema）。
 * 文字以中文為原文，英文在 server/messages.en.json（localize()）；npm run catalog -- --check 確認每一句都有英文。
 */
export interface ToolCatalogInfo {
  /** 一句話：這個工具替使用者做什麼。 */
  summary: string;
  /** 使用者真的會說、這個工具真的做得到的話（至少一句）。 */
  examples: readonly [string, ...string[]];
  /** 前提（例如要先配對電視）；沒有就不寫。 */
  needs?: string;
  /**
   * George 決定 3（docs/24 §6.1）：真實的工具呼叫要連動的腦區（CAP-6 才接動畫）。null＝這個工具不對應任何腦區，
   * 呼叫時不亮（例如家電控制、模擬工具）；一定要明寫，不能漏。
   */
  domain: Domain | null;
  /** 不列在給人看的表（模擬工具、legacy Facade）。 */
  hidden?: true;
}

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
  /**
   * SKL-2：結果 data 的上限（位元組，預設 MAX_RESULT_DATA_BYTES）。只有 effect 是 read 的工具可以設，範圍到 MAX_READ_DATA_BYTES
   * （app.skill.read 交回技能內文）。不給模型。
   */
  resultDataMaxBytes?: number;
  /** CAP-1：給人看的總表資料（不給模型）。 */
  catalog: ToolCatalogInfo;
}

/** CAP-1：工具在靜態總表上需要的部分（不含 inputSchema，有些 Adapter 的 schema 要看設定才知道）。 */
export type CatalogTool = Pick<ToolDefinition, "id" | "effect" | "enabled" | "supportedRoutes" | "legacyName" | "catalog">;

/**
 * CAP-1：一個已審核 Adapter 的靜態資料。每個 Adapter 模組在模組層級匯出一份，不需要任何設定就能讀
 * （缺設定時 factory 回 null，執行中的登記表看不到它）。tests/capability-catalog.test.ts 比對它與實際的 Adapter 一致。
 */
export interface AdapterCatalog {
  /** 與 IntegrationAdapter.id 相同。 */
  id: string;
  /** 與 IntegrationAdapter.service 相同。 */
  service: string;
  /** 給人看的服務名稱（中文原文，英文用 localize()）。 */
  label: string;
  /** true＝一定是模擬；"config"＝依設定（例如 NOUS_VCR=fake 是模擬、mac 不是）。 */
  mock: boolean | "config";
  /** 核心內建（定時器、鬧鐘），不經 NOUS_AIL_SERVICES。 */
  builtin?: true;
  /** 這個 Adapter 可能提供的全部工具（有些要看設定才真的註冊）。 */
  tools: readonly CatalogTool[];
}

export interface ExecutionContext {
  actor: "user" | "agent";
  route: IntegrationRoute;
  sessionId: string;
  /** 核心產生的請求 ID（不含使用者內容）；有副作用的 Adapter 用它當 idempotency key。 */
  requestId: string;
  signal: AbortSignal;
  /** ALARM-1：開始這通即時語音的頁面（"main" 或終端機識別碼）；不知道時沒有。 */
  page?: string;
  /** SKL-2：這通即時語音的介面語言（app.skill.read 回傳對應語言的內文）；不知道時沒有。 */
  locale?: Locale;
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
