import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// AIL-1：模擬 Adapter（mock）。只用來測試與示範整合層本身；結果與狀態一律標示 mock，
// 不連任何外部服務，也不能拿來宣稱任何真實 App 的能力。
//   app.mock.echo   read：把一段短文字照樣回傳（confirmed）
//   app.mock.toggle reversible_write：切換一個記憶體裡的開關（confirmed，或依情境 unconfirmed／丟錯／不回覆）

export type MockScenario = "normal" | "unconfirmed" | "throw" | "hang" | "bad_result";

export interface MockAdapterOptions {
  /** 測試用的情境（預設 normal）。 */
  scenario?: () => MockScenario;
  /** 測試用的健康狀態（預設 available）。 */
  health?: () => HealthReport | Promise<HealthReport>;
  /** 額外的工具（測試註冊檢查用）。 */
  extraTools?: ToolDefinition[];
  /** 改寫 echo 的時限（測試逾時用）。 */
  timeoutMs?: number;
}

export const MOCK_TOOLS: readonly ToolDefinition[] = [
  {
    id: "app.mock.echo",
    description: "（模擬）整合層測試工具：把 text 原樣回傳。只在使用者明確要求測試整合層時呼叫。",
    descriptionEn: "(Mock) Integration-layer test tool: returns text unchanged. Call only when the user explicitly asks to test the integration layer.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回傳的短文字", maxLength: 200 } },
      required: ["text"],
      additionalProperties: false,
    },
    effect: "read",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
  {
    id: "app.mock.toggle",
    description: "（模擬）整合層測試工具：切換一個模擬開關，回傳切換後的狀態。只在使用者明確要求測試整合層時呼叫。",
    descriptionEn: "(Mock) Integration-layer test tool: flips a simulated switch and returns its new state. Call only when the user explicitly asks to test the integration layer.",
    inputSchema: {
      type: "object",
      properties: { on: { type: "boolean", description: "要打開（true）或關閉（false）" } },
      required: ["on"],
      additionalProperties: false,
    },
    effect: "reversible_write",
    enabled: true,
    timeoutMs: 2_000,
    supportedRoutes: ["api_key", "live"],
  },
];

export class MockAdapter implements IntegrationAdapter {
  readonly id = "mock";
  readonly service = "mock";
  readonly version = 1;
  readonly mock = true;
  /** 模擬開關的狀態（只在記憶體）。 */
  switchOn = false;
  /** 執行過的 request-id（測試確認 idempotency key 有傳進來）。 */
  readonly requests: string[] = [];

  constructor(private readonly options: MockAdapterOptions = {}) {}

  tools(): readonly ToolDefinition[] {
    const base = this.options.timeoutMs ? MOCK_TOOLS.map((t) => ({ ...t, timeoutMs: this.options.timeoutMs! })) : MOCK_TOOLS;
    return [...base, ...(this.options.extraTools ?? [])];
  }

  async health(): Promise<HealthReport> {
    return this.options.health ? this.options.health() : { health: "available", reason: "ok" };
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    this.requests.push(ctx.requestId);
    const scenario = this.options.scenario?.() ?? "normal";
    if (scenario === "throw") throw new Error("mock adapter failure");
    if (scenario === "hang") {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("aborted");
    }
    if (scenario === "bad_result") return { ok: true, status: "unconfirmed", message: "inconsistent" } as ToolResult;
    if (toolId === "app.mock.echo") return toolResult("confirmed", "（模擬）已回傳。", { data: { mock: true, text: args.text } });
    if (toolId === "app.mock.toggle") {
      if (scenario === "unconfirmed") return toolResult("unconfirmed", "（模擬）已送出，沒有回讀確認。", { data: { mock: true } });
      this.switchOn = args.on === true;
      return toolResult("confirmed", this.switchOn ? "（模擬）開關已打開。" : "（模擬）開關已關閉。", { data: { mock: true, on: this.switchOn } });
    }
    return toolResult("refused", "（模擬）沒有這個工具。", { reason: "not_registered" });
  }
}
