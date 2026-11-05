import { randomUUID } from "node:crypto";
import { fromWireName, isIntegrationToolId, isToolResult, toolResult, type IntegrationRoute, type IntegrationToolId, type ToolResult } from "../../shared/integrations.ts";
import { decide, MAX_LEGACY_DATA_BYTES, MAX_RESULT_DATA_BYTES, RateLimiter } from "./policy.ts";
import type { IntegrationRegistry } from "./registry.ts";
import { validateArgs } from "./schema.ts";

// AIL-1（docs/18 §4 執行流程 2–5）：Dispatcher。所有整合工具都在核心執行，頁面只傳請求與顯示結果。
// 1. 找工具：未註冊、停用、路徑不支援 → refused（不執行）。
// 2. 驗證參數（模型的參數是外來資料）→ refused invalid_arguments。
// 3. 政策：external_commit 要當次確認；AIL-1 還沒有接確認卡 → refused confirmation_unavailable。
// 4. 速率限制 → refused rate_limited。
// 5. 執行：工具自己的時限＋呼叫端的中止。逾時或中止 → unknown（不能推定沒有執行）；Adapter 丟錯：read → failed，有副作用 → unknown。
// 6. 結果驗證：不符合契約 → failed invalid_result；data 太大 → 拿掉 data。ok 一律由 status 推導。
// 稽核紀錄只有 request-id、工具 ID、Adapter、effect、路徑、status、毫秒數；不記參數、結果內容或權杖。

export interface DispatchRequest {
  /** 工具 ID（app.x.y）或模型看到的函式名稱（app__x__y）。 */
  tool: string;
  /** 已經 JSON.parse 的參數；字串會先試著 parse。 */
  args: unknown;
  route: IntegrationRoute;
  actor: "user" | "agent";
  sessionId: string;
  signal?: AbortSignal;
}

export interface AuditEntry {
  requestId: string;
  tool: string;
  adapter: string | null;
  effect: string | null;
  route: IntegrationRoute;
  status: ToolResult["status"];
  reason: ToolResult["reason"] | null;
  ms: number;
}

export interface DispatcherOptions {
  limiter?: RateLimiter;
  now?: () => number;
  audit?: (entry: AuditEntry) => void;
  requestId?: () => string;
}

export class IntegrationDispatcher {
  private readonly limiter: RateLimiter;
  private readonly now: () => number;

  constructor(
    private readonly registry: IntegrationRegistry,
    private readonly options: DispatcherOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new RateLimiter(undefined, this.now);
  }

  /** 名稱是不是這條路徑上現在可用的整合工具（給呼叫端分流用）。 */
  handles(name: string, route: IntegrationRoute): boolean {
    const id = resolveId(name);
    return !!id && this.registry.status(id, route) === "available";
  }

  /** 工具的副作用類別（呼叫端判斷逾時要不要說「結果不明」）；未註冊回 null。 */
  effectOf(name: string): string | null {
    const id = resolveId(name);
    return id ? (this.registry.lookup(id)?.def.effect ?? null) : null;
  }

  async execute(request: DispatchRequest): Promise<ToolResult> {
    const started = this.now();
    const requestId = (this.options.requestId ?? randomUUID)();
    const id = resolveId(request.tool);
    const found = id ? this.registry.lookup(id) : null;
    const finish = (result: ToolResult): ToolResult => {
      this.options.audit?.({
        requestId,
        tool: id ?? "(invalid)",
        adapter: found?.adapter.id ?? null,
        effect: found?.def.effect ?? null,
        route: request.route,
        status: result.status,
        reason: result.reason ?? null,
        ms: this.now() - started,
      });
      return result;
    };
    if (!id || !found) return finish(toolResult("refused", "沒有這個整合工具，沒有執行。", { reason: "not_registered" }));
    const status = this.registry.status(id, request.route);
    if (status === "disabled") return finish(toolResult("refused", "這個整合功能沒有啟用，沒有執行。", { reason: "disabled" }));
    if (status !== "available") return finish(toolResult("refused", "這條路徑不能用這個整合功能，沒有執行。", { reason: "route_not_supported" }));

    let raw = request.args;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw || "{}");
      } catch {
        return finish(toolResult("refused", "參數不是 JSON，沒有執行。", { reason: "invalid_arguments" }));
      }
    }
    const checked = validateArgs(found.def.inputSchema, raw);
    if (!checked.ok) return finish(toolResult("refused", "參數不正確，沒有執行。", { reason: "invalid_arguments" }));

    if (decide(found.def.effect, id).kind === "confirm") {
      return finish(toolResult("refused", "這個動作需要你當次確認，但確認卡還沒有接上整合層，所以沒有執行。", { reason: "confirmation_unavailable" }));
    }
    // 呼叫前就已中止：不執行（確定沒有送出，所以是 refused，不是 unknown）。
    if (request.signal?.aborted) return finish(toolResult("refused", "這次呼叫在執行前已中止，沒有執行。", { reason: "aborted" }));
    // AIL-2：legacy Facade（例如家電）由原本的模組自己限速（HomeBridge 每分鐘 6 個指令），不另外套整合層的上限。
    if (!found.def.legacyName && !this.limiter.take(found.adapter.id)) return finish(toolResult("refused", "這個服務的呼叫太頻繁，這次沒有執行；請稍後再說一次。", { reason: "rate_limited" }));

    const sideEffect = found.def.effect !== "read";
    const timeout = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => {
        timeout.abort();
        resolve("timeout");
      }, found.def.timeoutMs);
      onAbort = () => resolve("aborted");
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const work = found.adapter.execute(id, checked.value, { actor: request.actor, route: request.route, sessionId: request.sessionId, requestId, signal });
      // 中止或逾時後 Adapter 可能還在跑：不再等它，但它之後丟的錯不能變成未處理的 rejection。
      work.catch(() => undefined);
      const outcome = await Promise.race([work.then((value) => ({ value })), stop.then((why) => ({ why }))]);
      if ("why" in outcome) {
        return finish(toolResult("unknown", outcome.why === "timeout" ? "整合服務沒有在時限內回覆，結果不明，請確認。" : "這次呼叫已中止，結果不明，請確認。", { reason: outcome.why }));
      }
      return finish(normalize(outcome.value, found.def.legacyName ? MAX_LEGACY_DATA_BYTES : MAX_RESULT_DATA_BYTES));
    } catch {
      return finish(sideEffect
        ? toolResult("unknown", "整合服務出錯，結果不明，請確認。", { reason: "adapter_error" })
        : toolResult("failed", "整合服務出錯，沒有取得結果。", { reason: "adapter_error" }));
    } finally {
      clearTimeout(timer);
      if (onAbort) request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** 模型回傳的名稱或核心的工具 ID → 工具 ID。 */
function resolveId(name: string): IntegrationToolId | null {
  if (isIntegrationToolId(name)) return name;
  return fromWireName(name);
}

/** Adapter 的結果：照契約重建（ok 由 status 推導、只留已知欄位、data 有大小上限）。 */
function normalize(value: unknown, maxDataBytes: number = MAX_RESULT_DATA_BYTES): ToolResult {
  if (!isToolResult(value)) return toolResult("failed", "整合服務回傳的結果格式不正確。", { reason: "invalid_result" });
  let data = value.data;
  if (data !== undefined) {
    let size = Infinity;
    try {
      size = Buffer.byteLength(JSON.stringify(data) ?? "", "utf8");
    } catch {
      // 不能序列化：當成太大
    }
    if (size > maxDataBytes) data = undefined;
  }
  return toolResult(value.status, value.message.slice(0, 500), { ...(value.reason ? { reason: value.reason } : {}), ...(data !== undefined ? { data } : {}) });
}

/** 交回模型的內容（function_call_output）：和 home_control 一樣是 {ok, status, message, ...}。 */
export function toModelOutput(result: ToolResult): Record<string, unknown> {
  return { ...result };
}
