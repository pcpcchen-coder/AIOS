import type { Config } from "../config.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { SpotifySoloistAdapter } from "./adapters/spotify-soloist.ts";
import { createVoiceRelayAdapter, VoiceRelayAdapter } from "./adapters/voice-relay.ts";
import { GmailGogAdapter, resolveGogPath } from "./adapters/gmail-gog.ts";
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
  /** VCR-2：voice_relay 有註冊時才有（設定頁的語音中繼診斷用；不給模型）。 */
  voiceRelay?: VoiceRelayAdapter;
}

/** 已審核的 Adapter（ID → 建立方式，只拿核心設定）。回 null＝這次設定下不啟用（不註冊）。 */
export type AdapterFactory = (config: Config["ail"], log: (line: string) => void) => IntegrationAdapter | null;

export const KNOWN_ADAPTERS: Record<string, AdapterFactory> = {
  mock: () => new MockAdapter(),
  // SP-1：只有本機健康狀態，沒有模型工具（SP-2 BLOCKED）。
  spotify_soloist: (config) => new SpotifySoloistAdapter({ port: config.soloistPort }),
  // VCR-0／VCR-1／VCR-2（docs/19）：NOUS_VCR=fake（假輸出，mock）或 mac（say 實際發聲，只限 macOS）才建立；否則回 null。
  voice_relay: (config, log) => createVoiceRelayAdapter(config, log),
  // MAIL-1：用 gog 寄信給自己（收件人只來自 NOUS_MAIL_SELF）。沒有信箱或找不到 gog 時不註冊，照實記 log。
  gmail_gog: (config, log) => {
    const self = config.mail?.self ?? null;
    if (!self) {
      log("整合層：gmail_gog 需要 NOUS_MAIL_SELF（你自己的 Gmail），略過");
      return null;
    }
    const gogPath = resolveGogPath(config.mail?.gogPath ?? null);
    if (!gogPath) {
      log("整合層：找不到 gog（/opt/homebrew/bin、/usr/local/bin；或設定 NOUS_GOG_PATH），gmail_gog 略過");
      return null;
    }
    return new GmailGogAdapter({ self, gogPath });
  },
};

export function createIntegrations(config: Config["ail"], log: (line: string) => void = () => undefined, known: Record<string, AdapterFactory> = KNOWN_ADAPTERS): Integrations | null {
  if (!config.enabled) return null;
  const enabled = new Set(config.services.filter((id) => Object.hasOwn(known, id)));
  for (const id of config.services) if (!enabled.has(id)) log(`整合層：NOUS_AIL_SERVICES 的 ${id} 不是已審核的 Adapter，略過`);
  const registry = new IntegrationRegistry({ enabled });
  let voiceRelay: VoiceRelayAdapter | undefined;
  for (const id of enabled) {
    let adapter: IntegrationAdapter | null;
    try {
      adapter = known[id]!(config, log);
    } catch (err) {
      // 建立失敗：記錄並略過這個 Adapter（fail closed），不讓 Nous 啟動失敗。
      log(`整合層：${id} 建立失敗，略過（${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}）`);
      continue;
    }
    if (adapter) {
      registry.register(adapter);
      if (adapter instanceof VoiceRelayAdapter) voiceRelay = adapter;
    }
    else log(id === "voice_relay" && !config.vcr ? "整合層：voice_relay 未啟用（NOUS_VCR=off），略過" : `整合層：${id} 未啟用，略過`);
  }
  const audit = (e: AuditEntry) => log(`整合層：${e.requestId.slice(0, 8)} ${e.tool} ${e.route} → ${e.status}${e.reason ? `（${e.reason}）` : ""} ${e.ms} ms`);
  return { registry, dispatcher: new IntegrationDispatcher(registry, { audit }), status: new IntegrationStatusBoard(registry), ...(voiceRelay ? { voiceRelay } : {}) };
}
