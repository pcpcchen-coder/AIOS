import { HEALTH_REASONS, INTEGRATION_HEALTH, type IntegrationServiceStatus, type IntegrationStatusView } from "../../shared/integrations.ts";
import type { HealthReport, IntegrationAdapter } from "./contracts.ts";
import type { IntegrationRegistry } from "./registry.ts";

// AIL-1（docs/18 §4 執行流程 6）：按需的服務狀態。頁面要看時才檢查（GET /api/integrations/status），
// 短時間內重複查詢用快取，不在背景輪詢。health() 逾時、丟錯或回傳看不懂的內容一律是 unknown，不會變成 available。

export const HEALTH_TIMEOUT_MS = 3_000;
export const HEALTH_CACHE_MS = 5_000;

export interface StatusBoardOptions {
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
}

export class IntegrationStatusBoard {
  private readonly cache = new Map<string, { at: number; report: HealthReport }>();
  private readonly inflight = new Map<string, Promise<HealthReport>>();
  private readonly now: () => number;

  constructor(
    private readonly registry: IntegrationRegistry,
    private readonly options: StatusBoardOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async view(): Promise<IntegrationStatusView> {
    const services = await Promise.all(this.registry.adapters().map((adapter) => this.service(adapter)));
    return { services };
  }

  private async service(adapter: IntegrationAdapter): Promise<IntegrationServiceStatus> {
    const base = { service: adapter.id, mock: adapter.mock, model_tools: this.registry.modelToolCount(adapter.id) };
    if (!this.registry.adapterEnabled(adapter.id)) return { ...base, health: "unavailable", reason: "not_configured", checked_at: null };
    const report = await this.check(adapter);
    return { ...base, health: report.health, reason: report.reason, checked_at: this.cache.get(adapter.id)?.at ?? null };
  }

  /** 檢查一個 Adapter（有快取；同時多個查詢共用一次檢查）。 */
  check(adapter: IntegrationAdapter): Promise<HealthReport> {
    const cached = this.cache.get(adapter.id);
    if (cached && this.now() - cached.at < (this.options.cacheMs ?? HEALTH_CACHE_MS)) return Promise.resolve(cached.report);
    const running = this.inflight.get(adapter.id);
    if (running) return running;
    const work = probe(adapter, this.options.timeoutMs ?? HEALTH_TIMEOUT_MS).then((report) => {
      this.cache.set(adapter.id, { at: this.now(), report });
      this.inflight.delete(adapter.id);
      return report;
    });
    this.inflight.set(adapter.id, work);
    return work;
  }
}

async function probe(adapter: IntegrationAdapter, timeoutMs: number): Promise<HealthReport> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HealthReport>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ health: "unknown", reason: "timeout" });
    }, timeoutMs);
  });
  try {
    const work = adapter.health(controller.signal);
    work.catch(() => undefined);
    const report = await Promise.race([work, timeout]);
    return isHealthReport(report) ? report : { health: "unknown", reason: "bad_reply" };
  } catch {
    return { health: "unknown", reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

function isHealthReport(value: unknown): value is HealthReport {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!(INTEGRATION_HEALTH as readonly unknown[]).includes(v.health) || !(HEALTH_REASONS as readonly unknown[]).includes(v.reason)) return false;
  // 只有 reason ok 能配 available，反過來也一樣。
  return (v.health === "available") === (v.reason === "ok");
}
