import type { Locale } from "../../shared/i18n.mjs";
import { EFFECT_CLASSES, INTEGRATION_ROUTES, isIntegrationToolId, serviceOf, toWireName, type CapabilityStatus, type IntegrationRoute, type IntegrationToolId } from "../../shared/integrations.ts";
import type { IntegrationAdapter, IntegrationFunctionSpec, ToolCapability, ToolDefinition } from "./contracts.ts";
import { registrationRefusal, TIMEOUT_RANGE_MS } from "./policy.ts";
import { assertSupportedSchema } from "./schema.ts";

// AIL-1（docs/18 §4 執行流程 1）：Registry。註冊時檢查唯一 ID、Schema、版本、來源與時限；
// 工具清單依「核心設定啟用的 Adapter」×「工具本身啟用」×「路徑支援」動態產生。
// 啟用只來自核心設定（NOUS_AIL_SERVICES，啟動時讀一次）；沒有任何方法讓模型或頁面打開一個工具。

export class RegistryError extends Error {}

const ADAPTER_ID = /^[a-z][a-z0-9_]{0,31}$/;

interface Entry {
  adapter: IntegrationAdapter;
  tools: Map<IntegrationToolId, ToolDefinition>;
}

export interface RegistryOptions {
  /** 核心設定啟用的 Adapter ID（NOUS_AIL_SERVICES）。不在清單上的 Adapter 可以註冊（給狀態頁看），但沒有任何工具可用。 */
  enabled: ReadonlySet<string>;
}

export class IntegrationRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly toolOwner = new Map<IntegrationToolId, string>();

  constructor(private readonly options: RegistryOptions) {}

  /** 註冊一個 Adapter（只在核心啟動時由程式碼呼叫）。任何一項檢查不過就整個拒絕，不留下部分註冊。 */
  register(adapter: IntegrationAdapter): void {
    if (!ADAPTER_ID.test(adapter.id)) throw new RegistryError(`Adapter ID 不合法：${adapter.id}`);
    if (this.entries.has(adapter.id)) throw new RegistryError(`Adapter 重複註冊：${adapter.id}`);
    if (!Number.isInteger(adapter.version) || adapter.version < 1) throw new RegistryError(`Adapter ${adapter.id} 的版本必須是正整數`);
    const tools = new Map<IntegrationToolId, ToolDefinition>();
    for (const raw of adapter.tools()) {
      const def = freezeDefinition(raw);
      if (!isIntegrationToolId(def.id)) throw new RegistryError(`工具 ID 不合法：${String(def.id)}`);
      if (serviceOf(def.id) !== adapter.service) throw new RegistryError(`工具 ${def.id} 不屬於 Adapter ${adapter.id} 的服務 ${adapter.service}`);
      if (tools.has(def.id) || this.toolOwner.has(def.id)) throw new RegistryError(`工具 ID 重複：${def.id}`);
      const refusal = registrationRefusal(def.id);
      if (refusal) throw new RegistryError(refusal);
      if (!(EFFECT_CLASSES as readonly string[]).includes(def.effect)) throw new RegistryError(`工具 ${def.id} 的 effect 不合法`);
      if (!Number.isInteger(def.timeoutMs) || def.timeoutMs < TIMEOUT_RANGE_MS.min || def.timeoutMs > TIMEOUT_RANGE_MS.max) throw new RegistryError(`工具 ${def.id} 的 timeoutMs 必須在 ${TIMEOUT_RANGE_MS.min}–${TIMEOUT_RANGE_MS.max}`);
      if (!def.supportedRoutes.length || !def.supportedRoutes.every((r) => (INTEGRATION_ROUTES as readonly string[]).includes(r))) throw new RegistryError(`工具 ${def.id} 的 supportedRoutes 不合法`);
      if (typeof def.description !== "string" || !def.description.trim()) throw new RegistryError(`工具 ${def.id} 缺少說明`);
      try {
        assertSupportedSchema(def.inputSchema);
      } catch (err) {
        throw new RegistryError(`工具 ${def.id} 的 inputSchema 不支援：${err instanceof Error ? err.message : String(err)}`);
      }
      tools.set(def.id, def);
    }
    this.entries.set(adapter.id, { adapter, tools });
    for (const id of tools.keys()) this.toolOwner.set(id, adapter.id);
  }

  adapters(): IntegrationAdapter[] {
    return [...this.entries.values()].map((e) => e.adapter);
  }

  adapterEnabled(adapterId: string): boolean {
    return this.entries.has(adapterId) && this.options.enabled.has(adapterId);
  }

  /** 一個工具在這條路徑上的能力狀態。 */
  status(id: IntegrationToolId, route: IntegrationRoute): CapabilityStatus | null {
    const owner = this.toolOwner.get(id);
    if (!owner) return null;
    const def = this.entries.get(owner)!.tools.get(id)!;
    if (!this.adapterEnabled(owner) || !def.enabled) return "disabled";
    if (!def.supportedRoutes.includes(route)) return "unsupported";
    return "available";
  }

  /** 找工具（任何狀態）；沒有註冊回 null。 */
  lookup(id: IntegrationToolId): { adapter: IntegrationAdapter; def: ToolDefinition } | null {
    const owner = this.toolOwner.get(id);
    if (!owner) return null;
    const entry = this.entries.get(owner)!;
    return { adapter: entry.adapter, def: entry.tools.get(id)! };
  }

  /** 這條路徑上現在可用的工具（依 ID 排序，兩條路徑順序一致）。 */
  listTools(route: IntegrationRoute): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const entry of this.entries.values()) for (const def of entry.tools.values()) if (this.status(def.id, route) === "available") out.push(def);
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 這條路徑的函式工具規格（給 buildRealtimeTools）。同一個工具在 api_key 與 live 上產生同一份 schema。 */
  functionSpecs(route: IntegrationRoute, locale: Locale = "zh-TW"): IntegrationFunctionSpec[] {
    return this.listTools(route).map((def) => ({
      type: "function",
      name: toWireName(def.id),
      description: locale === "en" && def.descriptionEn ? def.descriptionEn : def.description,
      parameters: def.inputSchema,
    }));
  }

  /** 診斷用的完整清單（不給模型）。 */
  capabilities(route: IntegrationRoute): ToolCapability[] {
    const out: ToolCapability[] = [];
    for (const entry of this.entries.values()) {
      for (const def of entry.tools.values()) {
        out.push({ id: def.id, adapter: entry.adapter.id, effect: def.effect, supportedRoutes: def.supportedRoutes, capabilityStatus: this.status(def.id, route)! });
      }
    }
    return out;
  }

  /** 這個 Adapter 在任何路徑上可用的工具數。 */
  modelToolCount(adapterId: string): number {
    const entry = this.entries.get(adapterId);
    if (!entry) return 0;
    return [...entry.tools.values()].filter((def) => INTEGRATION_ROUTES.some((r) => this.status(def.id, r) === "available")).length;
  }
}

/** 複製並凍結定義：Adapter 之後改自己的物件也影響不到已註冊的工具。 */
function freezeDefinition(def: ToolDefinition): ToolDefinition {
  const copy = structuredClone({ ...def, supportedRoutes: [...def.supportedRoutes] });
  return deepFreeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
