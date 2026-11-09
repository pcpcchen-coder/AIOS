import type { Config } from "../config.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { SpotifySoloistAdapter } from "./adapters/spotify-soloist.ts";
import { createVoiceRelayAdapter, VoiceRelayAdapter } from "./adapters/voice-relay.ts";
import { GmailGogAdapter, resolveGogPath } from "./adapters/gmail-gog.ts";
import { HomeAdapter, type HomeBridgePort } from "./adapters/home.ts";
import { GoogleCalendarAdapter } from "./adapters/google-calendar.ts";
import { LgTvAdapter } from "./adapters/lg-tv.ts";
import { YouTubeSearch } from "../lgtv/youtube.ts";
import { WeatherAdapter, type WeatherAdapterOptions } from "./adapters/weather.ts";
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

/** 核心已經建立、要交給 Adapter 包裝的既有模組（AIL-2：HomeBridge）。 */
export interface AdapterDeps {
  home?: HomeBridgePort;
  /** PRO-1：天氣快取與主動提醒設定的地點（核心一定建立；測試可以不給）。 */
  weather?: WeatherAdapterOptions;
}

/** 已審核的 Adapter（ID → 建立方式，只拿核心設定與既有模組）。回 null＝這次設定下不啟用（不註冊）。 */
export type AdapterFactory = (config: Config["ail"], log: (line: string) => void, deps: AdapterDeps) => IntegrationAdapter | null;

export const KNOWN_ADAPTERS: Record<string, AdapterFactory> = {
  mock: () => new MockAdapter(),
  // AIL-2：武陵居家電的 Facade（/api/home/* 改經整合層，行為不變）。中控沒設定時不註冊，/api/home/* 照原本的路徑回 409。
  home: (_config, log, deps) => {
    if (!deps.home?.available) {
      log("整合層：home 需要已設定的武陵居中控（SMARTHOME_URL、SMARTHOME_TOKEN），略過");
      return null;
    }
    return new HomeAdapter(deps.home);
  },
  // SP-1：只有本機健康狀態，沒有模型工具（SP-2 BLOCKED）。
  spotify_soloist: (config) => new SpotifySoloistAdapter({ port: config.soloistPort }),
  // VCR-0／VCR-1／VCR-2（docs/19）：NOUS_VCR=fake（假輸出，mock）或 mac（say 實際發聲，只限 macOS）才建立；否則回 null。
  voice_relay: (config, log) => createVoiceRelayAdapter(config, log),
  // CAL-1：用 gog 讀寫自己的 Google 日曆（帳號只來自設定）。沒有帳號或找不到 gog 時不註冊，照實記 log。
  google_calendar: (config, log) => {
    const account = config.calendar?.account ?? null;
    if (!account) {
      log("整合層：google_calendar 需要 NOUS_GOG_ACCOUNT（或 NOUS_MAIL_SELF），略過");
      return null;
    }
    const gogPath = resolveGogPath(config.calendar?.gogPath ?? null);
    if (!gogPath) {
      log("整合層：找不到 gog（/opt/homebrew/bin、/usr/local/bin；或設定 NOUS_GOG_PATH），google_calendar 略過");
      return null;
    }
    return new GoogleCalendarAdapter({ account, gogPath, timeZone: config.calendar?.timeZone });
  },
  // PRO-1：今天的天氣（Open-Meteo，唯讀、沒有參數；地點只來自主動提醒設定）。
  weather: (_config, log, deps) => {
    if (!deps.weather) {
      log("整合層：weather 需要核心的天氣快取，略過");
      return null;
    }
    return new WeatherAdapter(deps.weather);
  },
  // LGTV-1：客廳的 LG 電視（區網 SSAP＋Wake-on-LAN）。沒有 NOUS_LGTV_HOST 時不註冊；沒有配對時註冊，但工具回 refused 並提示配對。
  lg_tv: (config, log) => {
    const tv = config.tv;
    if (!tv?.host) {
      log("整合層：lg_tv 需要 NOUS_LGTV_HOST（電視的區網 IP），略過");
      return null;
    }
    if (!tv.youtubeApiKey) log("整合層：lg_tv 沒有 NOUS_YOUTUBE_API_KEY，不能依名稱搜尋 YouTube（給網址仍可播）");
    return new LgTvAdapter({ host: tv.host, pairingFile: tv.pairingFile, mac: tv.mac, broadcast: tv.broadcast, youtube: tv.youtubeApiKey ? new YouTubeSearch({ apiKey: tv.youtubeApiKey }) : null });
  },
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

/**
 * ALARM-1：核心內建的本機工具（定時器）。不看 NOUS_AIL：NOUS_AIL 關閉時整合層只有這些。enabled 每次查詢時讀
 * （設定頁的「鬧鐘與定時器」開關），關掉時工具不出現在清單、呼叫回 refused disabled。
 */
export interface BuiltinAdapter {
  adapter: IntegrationAdapter;
  enabled(): boolean;
}

export function createIntegrations(config: Config["ail"], log: (line: string) => void = () => undefined, known: Record<string, AdapterFactory> = KNOWN_ADAPTERS, deps: AdapterDeps = {}, builtins: readonly BuiltinAdapter[] = []): Integrations | null {
  if (!config.enabled && !builtins.length) return null;
  const services = config.enabled ? config.services : [];
  const enabled = new Set(services.filter((id) => Object.hasOwn(known, id)));
  for (const id of services) if (!enabled.has(id)) log(`整合層：NOUS_AIL_SERVICES 的 ${id} 不是已審核的 Adapter，略過`);
  const builtinEnabled = new Map(builtins.map((b) => [b.adapter.id, b.enabled] as const));
  const registry = new IntegrationRegistry({ enabled: { has: (id) => builtinEnabled.get(id)?.() ?? enabled.has(id) } });
  for (const b of builtins) {
    try {
      registry.register(b.adapter);
    } catch (err) {
      log(`整合層：內建的 ${b.adapter.id} 註冊失敗，略過（${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}）`);
    }
  }
  let voiceRelay: VoiceRelayAdapter | undefined;
  for (const id of enabled) {
    let adapter: IntegrationAdapter | null;
    try {
      adapter = known[id]!(config, log, deps);
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
