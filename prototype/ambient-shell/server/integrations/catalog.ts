import { isDomain, type Domain } from "../../shared/domain.ts";
import type { Locale } from "../../shared/i18n.mjs";
import { toWireName, type CapabilityStatus, type EffectClass, type IntegrationRoute } from "../../shared/integrations.ts";
import { HOST_TOOL_NAMES, type HostToolName } from "../../shared/realtime-route.ts";
import { localize } from "../localization.ts";
import { ALARM_CATALOG } from "./adapters/alarm.ts";
import { GMAIL_GOG_CATALOG } from "./adapters/gmail-gog.ts";
import { GOOGLE_CALENDAR_CATALOG } from "./adapters/google-calendar.ts";
import { HOME_CATALOG, HOME_NEEDS } from "./adapters/home.ts";
import { LG_TV_CATALOG } from "./adapters/lg-tv.ts";
import { MOCK_CATALOG } from "./adapters/mock.ts";
import { DUCK_CATALOG } from "./adapters/duck.ts";
import { SPOTIFY_SOLOIST_CATALOG } from "./adapters/spotify-soloist.ts";
import { TIMER_CATALOG } from "./adapters/timer.ts";
import { VOICE_RELAY_CATALOG } from "./adapters/voice-relay.ts";
import { WEATHER_CATALOG } from "./adapters/weather.ts";
import type { AdapterCatalog, ToolCatalogInfo } from "./contracts.ts";
import type { IntegrationRegistry } from "./registry.ts";

// CAP-1（docs/24 §3）：能力總表。給人與開發工具看（CAP-2 起 /help/commands 與 README 的整合工具列由它產生），**不給模型**：送給模型的工具 JSON 仍然只由 registry.functionSpecs()
// 與 server/realtime.ts 產生（tests/capability-catalog.test.ts 比對與加入總表之前逐字相同）。
// 靜態總表＝所有已審核 Adapter 模組層級的資料＋9 個頁面工具，不需要任何設定；即時總表＝靜態總表＋執行中登記表的狀態。

/** 已審核的 Adapter（index.ts 的 KNOWN_ADAPTERS，加上核心內建的定時器與鬧鐘）。測試確認與 KNOWN_ADAPTERS 一致。 */
export const ADAPTER_CATALOGS: readonly AdapterCatalog[] = [
  MOCK_CATALOG,
  DUCK_CATALOG,
  HOME_CATALOG,
  SPOTIFY_SOLOIST_CATALOG,
  VOICE_RELAY_CATALOG,
  GOOGLE_CALENDAR_CATALOG,
  WEATHER_CATALOG,
  LG_TV_CATALOG,
  GMAIL_GOG_CATALOG,
  TIMER_CATALOG,
  ALARM_CATALOG,
];

/** 頁面工具不屬於任何 Adapter；總表上用這個名稱分組。 */
export const HOST_GROUP = { id: "host", label: "即時語音內建" } as const;

const WEB_SEARCH_NEEDS = "上網查詢（ChatGPT 方案路徑用 Codex 額度；API key 路徑需要 OPENAI_API_KEY）";

/**
 * George 決定 6：9 個頁面工具（shared/realtime-route.ts 的 HOST_TOOL_NAMES）也列在總表上。目前只有資料：
 * /help/commands 的「可以問 AI」仍由 shared/voice-commands.ts 的 ASK_THE_AI 產生（改由總表產生是 CAP-4）；
 * CAP-2 起整合工具（定時器、鬧鐘與其他 Adapter）的列由總表產生。例句取自 ASK_THE_AI（測試比對）。
 */
export const HOST_TOOL_CATALOG: { readonly [T in HostToolName]: ToolCatalogInfo } = {
  web_search: { summary: "上網查詢後回答，字幕顯示來源。", examples: ["新竹今天會下雨嗎"], needs: WEB_SEARCH_NEEDS, domain: "language" },
  show_search_result: { summary: "查詢有兩則以上的結果時，選一則在畫面顯示重點並依序念。", examples: ["第二個", "看第一則"], needs: WEB_SEARCH_NEEDS, domain: "visual" },
  delegate_task: { summary: "把較長的工作交辦成背景任務，進度顯示在電子腦下方。", examples: ["幫我寫一份下週出差規劃"], domain: "planning" },
  get_tasks: { summary: "查交辦任務的真實狀態後用說的回答。", examples: ["任務做好了沒", "報告寫到哪了"], domain: "planning" },
  end_conversation: { summary: "道別並結束即時語音（由模型判斷，不保證每次都結束）。", examples: ["再見", "先這樣"], domain: "language" },
  home_status: { summary: "查武陵居的感測值與設備狀態。", examples: ["客廳現在幾度"], needs: HOME_NEEDS, domain: "math" },
  home_control: { summary: "請中控控制一台家電，照中控的回讀說結果；沒有回讀的只說「已送出，請確認」。", examples: ["客廳主燈關掉", "冷氣調 26 度"], needs: HOME_NEEDS, domain: null },
  set_voice_volume: { summary: "調這台裝置上 Nous 說話的音量（日間、夜間各一個）。", examples: ["你講話大聲一點", "晚上的音量調到 30"], domain: "auditory" },
  set_day_night: { summary: "切換日間或夜間模式，家裡所有 Nous 畫面一起變。", examples: ["切到夜間模式", "恢復自動"], domain: "visual" },
};

/** 總表的一筆（靜態總表沒有 status 與 configured）。 */
export interface CatalogEntry {
  /** 整合工具是 app.<service>.<action>；頁面工具是原本的名稱。 */
  id: string;
  /** 模型看到的函式名稱。 */
  wire: string;
  kind: "integration" | "host";
  /** Adapter ID；頁面工具是 "host"。 */
  group: string;
  group_label: string;
  /** 核心內建的 Adapter（定時器、鬧鐘；AdapterCatalog.builtin）。頁面工具是 false。 */
  builtin: boolean;
  /** 整合工具的副作用類別；頁面工具沒有分類（null）。 */
  effect: EffectClass | null;
  routes: readonly IntegrationRoute[];
  summary: string;
  examples: readonly string[];
  needs: string | null;
  domain: Domain | null;
  hidden: boolean;
  /** 靜態總表：Adapter 宣告的值（"config"＝依設定）；即時總表：這次實際註冊的 Adapter 是不是模擬。 */
  mock: boolean | "config";
  /** 只在即時總表：這次設定下有沒有註冊（缺設定時 factory 回 null，就是 false）。頁面工具沒有這一欄。 */
  configured?: boolean;
  /** 只在即時總表：兩條即時語音路徑上的能力狀態。沒有註冊的工具是 disabled。頁面工具沒有這一欄（CAP-1 不推導）。 */
  status?: Record<VoiceRoute, CapabilityStatus>;
}

export const VOICE_ROUTES = ["api_key", "live"] as const satisfies readonly IntegrationRoute[];
export type VoiceRoute = (typeof VOICE_ROUTES)[number];

function info(catalog: ToolCatalogInfo) {
  return { summary: catalog.summary, examples: [...catalog.examples], needs: catalog.needs ?? null, domain: catalog.domain, hidden: catalog.hidden === true };
}

/** 靜態總表：依 ADAPTER_CATALOGS 的順序，Adapter 內依工具宣告順序；最後是頁面工具（HOST_TOOL_NAMES 的順序）。 */
export function staticCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const adapter of ADAPTER_CATALOGS) {
    for (const tool of adapter.tools) {
      out.push({ id: tool.id, wire: toWireName(tool.id), kind: "integration", group: adapter.id, group_label: adapter.label, builtin: adapter.builtin === true, effect: tool.effect, routes: [...tool.supportedRoutes], ...info(tool.catalog), mock: adapter.mock });
    }
  }
  for (const name of HOST_TOOL_NAMES) {
    out.push({ id: name, wire: name, kind: "host", group: HOST_GROUP.id, group_label: HOST_GROUP.label, builtin: false, effect: null, routes: [...VOICE_ROUTES], ...info(HOST_TOOL_CATALOG[name]), mock: false });
  }
  return out;
}

/** 即時總表：靜態總表加上這次登記表的註冊狀態與兩條語音路徑的能力狀態。 */
export function liveCatalog(registry: IntegrationRegistry): CatalogEntry[] {
  return staticCatalog().map((entry) => {
    if (entry.kind === "host") return entry;
    const found = registry.lookup(entry.id as `app.${string}.${string}`);
    const status = Object.fromEntries(VOICE_ROUTES.map((route) => [route, found ? registry.status(found.def.id, route)! : "disabled"])) as Record<VoiceRoute, CapabilityStatus>;
    return { ...entry, mock: found ? found.adapter.mock : entry.mock, configured: Boolean(found), status };
  });
}

/** 給人看的文字換成指定語言（中文是原文；英文來自 server/messages.en.json）。 */
export function localizeCatalog(entries: readonly CatalogEntry[], locale: Locale): CatalogEntry[] {
  if (locale !== "en") return entries.map((e) => ({ ...e }));
  const t = (text: string) => localize(text, locale);
  return entries.map((e) => ({ ...e, group_label: t(e.group_label), summary: t(e.summary), examples: e.examples.map(t), needs: e.needs === null ? null : t(e.needs) }));
}

const HAN = /\p{Script=Han}/u;

/** `npm run catalog -- --check` 與測試共用的檢查。回傳問題清單（空＝通過）。 */
export function checkCatalog(entries: readonly CatalogEntry[] = staticCatalog(), adapters: readonly AdapterCatalog[] = ADAPTER_CATALOGS): string[] {
  const problems: string[] = [];
  const english = (where: string, text: string) => {
    const en = localize(text, "en");
    if (en === text || HAN.test(en)) problems.push(`${where}：缺英文翻譯（server/messages.en.json）：${text}`);
  };
  const seen = new Map<string, string>();
  const claim = (key: string, owner: string) => {
    const prior = seen.get(key);
    if (prior) problems.push(`ID 撞名：${key}（${prior} 與 ${owner}）`);
    else seen.set(key, owner);
  };
  const adapterIds = new Set<string>();
  for (const adapter of adapters) {
    if (adapterIds.has(adapter.id)) problems.push(`Adapter ID 撞名：${adapter.id}`);
    adapterIds.add(adapter.id);
    if (!adapter.label.trim()) problems.push(`${adapter.id}：沒有服務名稱`);
    else english(`${adapter.id} 的服務名稱`, adapter.label);
    for (const tool of adapter.tools) {
      if (tool.legacyName && !tool.catalog.hidden) problems.push(`${tool.id}：legacy Facade 工具要標 hidden`);
      if (adapter.mock === true && !tool.catalog.hidden) problems.push(`${tool.id}：模擬工具要標 hidden`);
    }
  }
  english(`${HOST_GROUP.id} 的服務名稱`, HOST_GROUP.label);
  for (const e of entries) {
    claim(e.id, e.group);
    if (e.wire !== e.id) claim(e.wire, e.group);
    if (typeof e.summary !== "string" || !e.summary.trim()) problems.push(`${e.id}：沒有 summary`);
    else english(`${e.id} 的 summary`, e.summary);
    const examples = e.examples.filter((x) => typeof x === "string" && x.trim());
    if (!examples.length || examples.length !== e.examples.length) problems.push(`${e.id}：至少要一句例句，而且不能是空白`);
    for (const x of examples) english(`${e.id} 的例句`, x);
    if (e.needs !== null) {
      if (!e.needs.trim()) problems.push(`${e.id}：needs 是空白（沒有前提就不寫）`);
      else english(`${e.id} 的 needs`, e.needs);
    }
    if (e.domain !== null && !isDomain(e.domain)) problems.push(`${e.id}：domain 不合法：${String(e.domain)}`);
  }
  return problems;
}

/** 開發用的 Markdown（給人看的表：不列 hidden 的工具，最後註明略過幾個）。 */
export function catalogMarkdown(entries: readonly CatalogEntry[], locale: Locale = "zh-TW"): string {
  const t = (text: string) => localize(text, locale);
  const cell = (text: string) => text.replace(/\|/g, "\\|");
  const head = locale === "en" ? ["Tool", "What it does", "Try saying", "Needs", "Brain region", "Effect"] : ["工具", "做什麼", "可以這樣說", "前提", "腦區", "副作用"];
  const lines: string[] = [];
  const groups = [...new Set(entries.map((e) => e.group))];
  for (const group of groups) {
    const rows = entries.filter((e) => e.group === group && !e.hidden);
    if (!rows.length) continue;
    lines.push(`### ${rows[0]!.group_label}`, "", `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`);
    for (const e of rows) {
      const quote = e.examples.map((x) => (locale === "en" ? `"${x}"` : `「${x}」`)).join(locale === "en" ? ", " : "、");
      lines.push(`| \`${e.wire}\` | ${cell(e.summary)} | ${cell(quote)} | ${cell(e.needs ?? "—")} | ${e.domain ?? "—"} | ${e.effect ?? "—"} |`);
    }
    lines.push("");
  }
  const hidden = entries.filter((e) => e.hidden).length;
  lines.push(t(`另有 ${hidden} 個 hidden 工具（模擬或 legacy Facade）不列在表上。`));
  return `${lines.join("\n")}\n`;
}
