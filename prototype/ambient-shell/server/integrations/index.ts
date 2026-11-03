import type { Config } from "../config.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { SpotifySoloistAdapter } from "./adapters/spotify-soloist.ts";
import { createVoiceRelayAdapter } from "./adapters/voice-relay.ts";
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

/** 已審核的 Adapter（ID → 建立方式，只拿核心設定）。回 null＝這次設定下不啟用（不註冊）。 */
export type AdapterFactory = (config: Config["ail"], log: (line: string) => void) => IntegrationAdapter | null;

export const KNOWN_ADAPTERS: Record<string, AdapterFactory> = {
  mock: () => new MockAdapter(),
  // SP-1：只有本機健康狀態，沒有模型工具（SP-2 BLOCKED）。
  spotify_soloist: (config) => new SpotifySoloistAdapter({ port: config.soloistPort }),
  // VCR-0／VCR-1（docs/19）：只有 NOUS_VCR=fake 才建立（假輸出，mock）；否則回 null。
  voice_relay: (config, log) => createVoiceRelayAdapter(config, log),
};

export function createIntegrations(config: Config["ail"], log: (line: string) => void = () => undefined, known: Record<string, AdapterFactory> = KNOWN_ADAPTERS): Integrations | null {
  if (!config.enabled) return null;
  const enabled = new Set(config.services.filter((id) => Object.hasOwn(known, id)));
  for (const id of config.services) if (!enabled.has(id)) log(`整合層：NOUS_AIL_SERVICES 的 ${id} 不是已審核的 Adapter，略過`);
  const registry = new IntegrationRegistry({ enabled });
  for (const id of enabled) {
    const adapter = known[id]!(config, log);
    if (adapter) registry.register(adapter);
    else log(id === "voice_relay" && !config.vcr ? "整合層：voice_relay 未啟用（NOUS_VCR=off），略過" : `整合層：${id} 未啟用，略過`);
  }
  const audit = (e: AuditEntry) => log(`整合層：${e.requestId.slice(0, 8)} ${e.tool} ${e.route} → ${e.status}${e.reason ? `（${e.reason}）` : ""} ${e.ms} ms`);
  return { registry, dispatcher: new IntegrationDispatcher(registry, { audit }), status: new IntegrationStatusBoard(registry) };
}
