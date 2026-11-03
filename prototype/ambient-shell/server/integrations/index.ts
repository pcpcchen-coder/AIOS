import type { Config } from "../config.ts";
import { MockAdapter } from "./adapters/mock.ts";
import type { IntegrationAdapter } from "./contracts.ts";
import { IntegrationDispatcher, type AuditEntry } from "./dispatcher.ts";
import { IntegrationRegistry } from "./registry.ts";
import { IntegrationStatusBoard } from "./status.ts";

// AIL-1：核心組裝整合層。NOUS_AIL 關閉時回 null（呼叫端一律當成沒有整合層，行為和之前相同）。
// 只有這裡列出的、已審核的 Adapter 可以註冊；NOUS_AIL_SERVICES 只能從這份清單裡選，不能載入其他程式碼。

export interface Integrations {
  registry: IntegrationRegistry;
  dispatcher: IntegrationDispatcher;
  status: IntegrationStatusBoard;
}

/** 已審核的 Adapter（ID → 建立方式）。 */
export const KNOWN_ADAPTERS: Record<string, () => IntegrationAdapter> = {
  mock: () => new MockAdapter(),
};

export function createIntegrations(config: Config["ail"], log: (line: string) => void = () => undefined, known: Record<string, () => IntegrationAdapter> = KNOWN_ADAPTERS): Integrations | null {
  if (!config.enabled) return null;
  const enabled = new Set(config.services.filter((id) => Object.hasOwn(known, id)));
  for (const id of config.services) if (!enabled.has(id)) log(`整合層：NOUS_AIL_SERVICES 的 ${id} 不是已審核的 Adapter，略過`);
  const registry = new IntegrationRegistry({ enabled });
  for (const id of enabled) registry.register(known[id]!());
  const audit = (e: AuditEntry) => log(`整合層：${e.requestId.slice(0, 8)} ${e.tool} ${e.route} → ${e.status}${e.reason ? `（${e.reason}）` : ""} ${e.ms} ms`);
  return { registry, dispatcher: new IntegrationDispatcher(registry, { audit }), status: new IntegrationStatusBoard(registry) };
}
