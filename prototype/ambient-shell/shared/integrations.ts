// AIL-1（docs/18 §4）：Nous App Integration Layer 的共用契約（核心與頁面都會讀）。
// 這裡只有型別、列舉與純函式：沒有網址、權杖、帳號或任何外部服務的設定。
// 工具 ID 是 app.<service>.<action>；送給模型的函式名稱是 app__<service>__<action>
// （OpenAI 函式名稱只接受 [A-Za-z0-9_-]，不能有點），兩者一對一、可逆。

/** 工具的副作用類別：read 只查詢；reversible_write 可撤回的改變；external_commit 寄出、發布、付費、永久刪除等。 */
export const EFFECT_CLASSES = ["read", "reversible_write", "external_commit"] as const;
export type EffectClass = (typeof EFFECT_CLASSES)[number];

/** 呼叫來源（路徑）。AIL-1 只接兩條即時語音路徑；text／background 先列在契約上，沒有接上任何呼叫端。 */
export const INTEGRATION_ROUTES = ["api_key", "live", "text", "background"] as const;
export type IntegrationRoute = (typeof INTEGRATION_ROUTES)[number];

/** 一個工具在目前設定下的能力狀態（由核心依設定推導；模型沒辦法改）。 */
export const CAPABILITY_STATUSES = ["available", "disabled", "unsupported", "authorization_required"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/**
 * 統一結果的狀態。只有 confirmed 可以說「完成」；unconfirmed＝已送出但沒有回讀確認；unknown＝結果不明（逾時、中止、連線中斷），
 * 不能推定沒有執行；needs_confirmation＝要使用者當次確認；refused＝沒有送出（未註冊、停用、參數不對、政策不允許）；failed＝確定失敗。
 */
export const TOOL_RESULT_STATUSES = ["confirmed", "unconfirmed", "unknown", "needs_confirmation", "refused", "failed"] as const;
export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];

/** refused／failed／unknown 的原因代碼（固定清單，頁面與模型都看得懂；不含使用者內容）。 */
export const TOOL_RESULT_REASONS = [
  "not_registered",
  "disabled",
  "route_not_supported",
  "invalid_arguments",
  "rate_limited",
  "confirmation_unavailable",
  "timeout",
  "aborted",
  "adapter_error",
  "invalid_result",
  "unavailable",
] as const;
export type ToolResultReason = (typeof TOOL_RESULT_REASONS)[number];

/**
 * 統一結果。ok 只在 status 是 confirmed 時為 true（由 toolResult 推導，不能分開設定）；
 * data 只放可以安全交回模型的最小資料（核心另外限制大小）。
 */
export interface ToolResult {
  ok: boolean;
  status: ToolResultStatus;
  message: string;
  reason?: ToolResultReason;
  data?: unknown;
}

/** 建立結果：ok 一律由 status 推導，避免「ok:true 但其實沒有確認」。 */
export function toolResult(status: ToolResultStatus, message: string, extra: { reason?: ToolResultReason; data?: unknown } = {}): ToolResult {
  return {
    ok: status === "confirmed",
    status,
    message,
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

/** 外來的結果（Adapter 回傳、HTTP 回應）是否符合契約：status 在清單上、ok 與 status 一致、message 是字串。 */
export function isToolResult(value: unknown): value is ToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!(TOOL_RESULT_STATUSES as readonly unknown[]).includes(v.status)) return false;
  if (typeof v.message !== "string" || typeof v.ok !== "boolean") return false;
  if (v.ok !== (v.status === "confirmed")) return false;
  if (v.reason !== undefined && !(TOOL_RESULT_REASONS as readonly unknown[]).includes(v.reason)) return false;
  return true;
}

// ---- 工具 ID 與模型看到的函式名稱 ----

/** service 與 action：小寫英數，可用單一底線分段（不能有連續底線，函式名稱才能可逆）。 */
const SEGMENT = "[a-z][a-z0-9]*(?:_[a-z0-9]+)*";
export const INTEGRATION_TOOL_ID = new RegExp(`^app\\.(${SEGMENT})\\.(${SEGMENT})$`);
export const INTEGRATION_WIRE_NAME = new RegExp(`^app__(${SEGMENT})__(${SEGMENT})$`);
/** OpenAI 函式名稱的上限。 */
export const WIRE_NAME_MAX = 64;

export type IntegrationToolId = `app.${string}.${string}`;

export function isIntegrationToolId(value: unknown): value is IntegrationToolId {
  return typeof value === "string" && INTEGRATION_TOOL_ID.test(value) && toWireName(value as IntegrationToolId).length <= WIRE_NAME_MAX;
}

/** app.spotify.status → app__spotify__status。 */
export function toWireName(id: IntegrationToolId): string {
  const match = INTEGRATION_TOOL_ID.exec(id);
  if (!match) throw new Error(`不是整合工具 ID：${id}`);
  return `app__${match[1]}__${match[2]}`;
}

/** app__spotify__status → app.spotify.status；不是整合工具的名稱回 null。 */
export function fromWireName(name: string): IntegrationToolId | null {
  if (name.length > WIRE_NAME_MAX) return null;
  const match = INTEGRATION_WIRE_NAME.exec(name);
  return match ? (`app.${match[1]}.${match[2]}` as IntegrationToolId) : null;
}

/** 工具 ID 的服務段（app.spotify.status → spotify）。 */
export function serviceOf(id: IntegrationToolId): string {
  return INTEGRATION_TOOL_ID.exec(id)?.[1] ?? "";
}

// ---- 頁面看得到的按需狀態（GET /api/integrations/status） ----

/** 一個服務的健康狀態：available／unavailable 是核心實際檢查的結果；unknown＝檢查沒有得到確定答案（逾時、回覆看不懂）。 */
export const INTEGRATION_HEALTH = ["available", "unavailable", "unknown"] as const;
export type IntegrationHealth = (typeof INTEGRATION_HEALTH)[number];

/** 健康狀態的原因代碼（固定清單，頁面依代碼顯示雙語固定句；不含歌名、帳號、網址或 IP）。 */
export const HEALTH_REASONS = [
  "ok",
  "not_configured",
  "connection_refused",
  "connection_closed",
  "timeout",
  "bad_reply",
  "expired",
  "taken_over",
  "not_ready",
  "error",
] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];

export interface IntegrationServiceStatus {
  /** Adapter ID（例如 spotify_soloist、mock）。 */
  service: string;
  /** 模擬的 Adapter：頁面一定要標示「模擬」。 */
  mock: boolean;
  health: IntegrationHealth;
  reason: HealthReason;
  /** 核心最後一次檢查的時間（epoch ms）；還沒檢查過為 null。 */
  checked_at: number | null;
  /** 模型可以用的工具數（這個服務在任何路徑上都沒有工具時為 0，例如 Spotify 語音控制未授權）。 */
  model_tools: number;
}

export interface IntegrationStatusView {
  services: IntegrationServiceStatus[];
}
