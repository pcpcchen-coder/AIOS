import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutorMode } from "../shared/types.ts";
import { DEFAULT_MAX_CONCURRENT } from "./runner.ts";

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
    searchModel: env.NOUS_SEARCH_MODEL?.trim() || "gpt-5.5",
    searchCountry: env.NOUS_SEARCH_COUNTRY?.trim().toUpperCase() || "TW",
    searchTimezone: env.NOUS_SEARCH_TIMEZONE?.trim() || "Asia/Taipei",
    realtimeMcp: parseMcp(env.NOUS_REALTIME_MCP),
    taskWebSearch: (env.NOUS_TASK_WEB_SEARCH ?? "on").trim().toLowerCase() !== "off",
    claudeWebSearchTool: env.NOUS_CLAUDE_WEB_SEARCH?.trim() || "web_search_20250305",
  };
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
