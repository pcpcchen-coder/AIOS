import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutorMode } from "../shared/types.ts";
import { DEFAULT_CAMERA_PREFS, type CameraSettings } from "../shared/sense.ts";
import { DEFAULT_MAX_CONCURRENT } from "./runner.ts";
import { DEFAULT_LIVE_VOICE, isLiveVoice, LIVE_VOICES, ROUTE_PREFERENCES, type LiveVoiceId, type RoutePreference } from "../shared/realtime-route.ts";

export interface Config {
  port: number;
  devPort: number;
  /** NOUS_PROVIDER（或舊的 NOUS_EXECUTOR）指定的預設引擎；畫面上切換後以保存的選擇為準。 */
  preferred: ExecutorMode | null;
  apiKey: string | null;
  model: string | null;
  modelFamily: string;
  fallbacks: boolean;
  /** ChatGPT 模型 slug；未設定時取帳號模型清單第一個。 */
  chatgptModel: string | null;
  /** 憑證與設定目錄（預設 ~/.config/nous），不放在 repo 內。 */
  configDir: string;
  /** Sign in with ChatGPT 的 loopback 回呼埠。 */
  oauthPort: number;
  maxConcurrent: number;
  /** 即時語音模式用的 OpenAI API key（OPENAI_API_KEY）；只留在本機核心。 */
  openaiApiKey: string | null;
  realtimeModel: string;
  realtimeVoice: string;
  /** 即時語音路徑偏好的預設（NOUS_REALTIME_ROUTE：auto、live、api_key）；設定畫面與選單改過後以 realtime.json 為準。 */
  realtimeRoute: RoutePreference;
  /**
   * MEM-3：記憶的放行旗標（NOUS_MEMORY_ROUTES，逗號分隔：live、api_key、task）。API key 即時語音的記憶預設關閉，列出 api_key 才打開
   * （Mac gate 通過後才改預設）；live 維持 MEM-2 的現狀（一律放行），這個旗標不能關掉它。
   * MEM-4a：task＝背景任務自動帶記憶（受保護交辦）；預設關閉，關閉時交辦和 M15 一樣。
   * MEM-5a：suggest＝記憶建議；MEM-5b：work_summary＝工作決定連到任務。兩者都預設關閉。
   */
  memoryRoutes: { api_key: boolean; task: boolean; suggest: boolean; work_summary: boolean };
  /** ChatGPT 方案路徑的模型（NOUS_LIVE_MODEL）：一定顯示；只有明確設定時才送出（send）。 */
  liveModel: { display: string; send: string | null };
  /** ChatGPT 方案路徑的聲音預設（NOUS_LIVE_VOICE，Codex 的聲音清單）。 */
  liveVoice: LiveVoiceId;
  /** ChatGPT 方案路徑上替語音模型執行工具的模型（NOUS_LIVE_AGENT_MODEL）；未設定時查 Codex 模型清單。 */
  liveAgentModel: string | null;
  /**
   * 查 Codex 模型清單時帶的 client_version（NOUS_CODEX_CLIENT_VERSION）。Codex 只列出支援這個版本的模型，
   * 帶 Nous 自己的版本（0.1.0）會拿到空清單，所以預設用和 OpenClaw 相同的 Codex 版本號。
   */
  codexClientVersion: string;
  /** Nous 自己的版本（package.json），只用在 User-Agent。 */
  nousVersion: string;
  /** 上網查詢用的模型（NOUS_SEARCH_MODEL），經 OPENAI_API_KEY 呼叫 Responses API 的 web_search。 */
  searchModel: string;
  /** 上網查詢的大致位置（NOUS_SEARCH_COUNTRY、NOUS_SEARCH_TIMEZONE）。 */
  searchCountry: string;
  searchTimezone: string;
  /** 掛到即時語音的遠端 MCP 伺服器（NOUS_REALTIME_MCP，JSON 陣列）。 */
  realtimeMcp: McpServerConfig[];
  /** 背景任務是否開放上網搜尋（NOUS_TASK_WEB_SEARCH，預設 on）。 */
  taskWebSearch: boolean;
  /** Claude 背景任務使用的 web search 工具版本（NOUS_CLAUDE_WEB_SEARCH）。 */
  claudeWebSearchTool: string;
  /** 雙目鏡頭（docs/11）：安裝設定與使用者設定的預設；使用者改過的值由 CameraSettingsStore 疊上去。 */
  camera: CameraSettings;
  /** 武陵居中控（docs/12）：SMARTHOME_URL、SMARTHOME_TOKEN；權杖只留在本機核心。 */
  smarthomeUrl: string | null;
  smarthomeToken: string | null;
}

/** OpenAI Realtime 的 mcp 工具設定；require_approval 預設 always，外部動作要在畫面上確認。 */
export interface McpServerConfig {
  server_label: string;
  server_url: string;
  server_description?: string;
  authorization?: string;
  allowed_tools?: string[];
  require_approval: "always" | "never";
}

const PROVIDERS: readonly ExecutorMode[] = ["claude", "chatgpt", "mock"];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const raw = (env.NOUS_PROVIDER ?? env.NOUS_EXECUTOR)?.trim().toLowerCase() || null;
  if (raw && !PROVIDERS.includes(raw as ExecutorMode)) {
    throw new Error(`NOUS_PROVIDER 只能是 claude、chatgpt 或 mock，收到 "${raw}"`);
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  if (raw === "claude" && !apiKey) throw new Error("NOUS_PROVIDER=claude 需要設定 ANTHROPIC_API_KEY");

  return {
    port: intOr(env.PORT, 8787),
    devPort: intOr(env.NOUS_DEV_PORT, 5173),
    preferred: raw as ExecutorMode | null,
    apiKey,
    model: env.NOUS_MODEL?.trim() || null,
    modelFamily: env.NOUS_MODEL_FAMILY?.trim() || "opus",
    fallbacks: (env.NOUS_FALLBACKS ?? "on").trim().toLowerCase() !== "off",
    chatgptModel: env.NOUS_CHATGPT_MODEL?.trim() || null,
    configDir: env.NOUS_CONFIG_DIR?.trim() || join(homedir(), ".config", "nous"),
    oauthPort: intOr(env.NOUS_OAUTH_PORT, 1455),
    maxConcurrent: Math.max(1, intOr(env.NOUS_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT)),
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    realtimeModel: env.NOUS_REALTIME_MODEL?.trim() || "gpt-realtime",
    realtimeVoice: env.NOUS_REALTIME_VOICE?.trim() || "marin",
    realtimeRoute: parseRoute(env.NOUS_REALTIME_ROUTE),
    memoryRoutes: parseMemoryRoutes(env.NOUS_MEMORY_ROUTES),
    liveModel: { display: env.NOUS_LIVE_MODEL?.trim() || "gpt-live-1-codex", send: env.NOUS_LIVE_MODEL?.trim() || null },
    liveVoice: parseLiveVoice(env.NOUS_LIVE_VOICE),
    liveAgentModel: env.NOUS_LIVE_AGENT_MODEL?.trim() || null,
    codexClientVersion: env.NOUS_CODEX_CLIENT_VERSION?.trim() || DEFAULT_CODEX_CLIENT_VERSION,
    nousVersion: packageVersion(),
    searchModel: env.NOUS_SEARCH_MODEL?.trim() || "gpt-5.5",
    searchCountry: env.NOUS_SEARCH_COUNTRY?.trim().toUpperCase() || "TW",
    searchTimezone: env.NOUS_SEARCH_TIMEZONE?.trim() || "Asia/Taipei",
    realtimeMcp: parseMcp(env.NOUS_REALTIME_MCP),
    taskWebSearch: (env.NOUS_TASK_WEB_SEARCH ?? "on").trim().toLowerCase() !== "off",
    claudeWebSearchTool: env.NOUS_CLAUDE_WEB_SEARCH?.trim() || "web_search_20250305",
    smarthomeUrl: parseHttpUrl(env.SMARTHOME_URL, "SMARTHOME_URL"),
    smarthomeToken: env.SMARTHOME_TOKEN?.trim() || null,
    camera: {
      enabled: (env.NOUS_CAMERA ?? "off").trim().toLowerCase() === "on",
      label: env.NOUS_CAMERA_LABEL?.trim() || "CCB Camera",
      left_first: (env.NOUS_CAMERA_LEFT_FIRST ?? "true").trim().toLowerCase() !== "false",
      screen_width_mm: positiveOr(env.NOUS_SCREEN_WIDTH_MM, 398),
      screen_offset_mm: numberOr(env.NOUS_CAMERA_OFFSET_MM, 140),
      ...DEFAULT_CAMERA_PREFS,
      // .env 只提供這一個使用者設定的預設；使用者在設定畫面改過後以 camera.json 為準。
      look_to_talk: (env.NOUS_LOOK_TO_TALK ?? "on").trim().toLowerCase() !== "off",
    },
  };
}

/**
 * MEM-5a：suggest（打字聊天的記憶建議與全家共用的「由誰記下」）同樣預設關閉。
 * MEM-5b：work_summary（「記住這次選了方案 B」連到最近完成的受保護工作）同樣預設關閉；關閉時照舊記成一般筆記。
 */
function parseMemoryRoutes(raw: string | undefined): { api_key: boolean; task: boolean; suggest: boolean; work_summary: boolean } {
  const values = (raw ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  for (const value of values) if (value !== "live" && value !== "api_key" && value !== "task" && value !== "suggest" && value !== "work_summary") throw new Error(`NOUS_MEMORY_ROUTES 只能列出 live、api_key、task、suggest、work_summary，收到 "${value}"`);
  return { api_key: values.includes("api_key"), task: values.includes("task"), suggest: values.includes("suggest"), work_summary: values.includes("work_summary") };
}

function parseRoute(raw: string | undefined): RoutePreference {
  const value = raw?.trim().toLowerCase();
  if (!value) return "auto";
  if (!(ROUTE_PREFERENCES as readonly string[]).includes(value)) throw new Error(`NOUS_REALTIME_ROUTE 只能是 ${ROUTE_PREFERENCES.join("、")}，收到 "${value}"`);
  return value as RoutePreference;
}

function parseLiveVoice(raw: string | undefined): LiveVoiceId {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_LIVE_VOICE;
  // 清單外的聲音會讓伺服器回語意不明的 403：啟動時就說清楚。
  if (!isLiveVoice(value)) throw new Error(`NOUS_LIVE_VOICE 只能是 ${LIVE_VOICES.join("、")}，收到 "${value}"`);
  return value;
}

/** 查 Codex 模型清單用的版本號（OpenClaw extensions/openai/base-url.ts 的 OPENAI_CODEX_CLIENT_VERSION）。 */
export const DEFAULT_CODEX_CLIENT_VERSION = "0.162.1";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : fallback;
}

function positiveOr(value: string | undefined, fallback: number): number {
  const n = numberOr(value, fallback);
  return n > 0 ? n : fallback;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 NOUS_REALTIME_MCP；格式錯誤時直接報錯，避免默默少掉工具。 */
export function parseMcp(raw: string | undefined): McpServerConfig[] {
  const text = raw?.trim();
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("NOUS_REALTIME_MCP 必須是 JSON 陣列");
  }
  if (!Array.isArray(value)) throw new Error("NOUS_REALTIME_MCP 必須是 JSON 陣列");
  const labels = new Set<string>();
  return value.map((item, i) => {
    const o = (item ?? {}) as Record<string, unknown>;
    const label = typeof o.server_label === "string" ? o.server_label.trim() : "";
    const url = typeof o.server_url === "string" ? o.server_url.trim() : "";
    if (!label || !url) throw new Error(`NOUS_REALTIME_MCP 第 ${i + 1} 項需要 server_label 與 server_url`);
    if (!/^https:\/\//.test(url)) throw new Error(`NOUS_REALTIME_MCP「${label}」的 server_url 必須是 https`);
    if (labels.has(label)) throw new Error(`NOUS_REALTIME_MCP 的 server_label 重複：${label}`);
    labels.add(label);
    const server: McpServerConfig = {
      server_label: label,
      server_url: url,
      require_approval: o.require_approval === "never" ? "never" : "always",
    };
    if (typeof o.server_description === "string") server.server_description = o.server_description;
    if (typeof o.authorization === "string" && o.authorization) server.authorization = o.authorization;
    if (Array.isArray(o.allowed_tools)) server.allowed_tools = o.allowed_tools.filter((t): t is string => typeof t === "string");
    return server;
  });
}

/** 中控位址：只接受 http／https，去掉結尾斜線；空白時視為未設定。 */
export function parseHttpUrl(raw: string | undefined, name: string): string | null {
  const text = raw?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} 不是有效的網址：${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} 必須是 http 或 https 網址`);
  if (url.username || url.password) throw new Error(`${name} 不可內含帳號密碼；權杖請放在 SMARTHOME_TOKEN`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
