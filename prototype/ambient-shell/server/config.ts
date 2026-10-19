import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecutorMode } from "../shared/types.ts";

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
    maxConcurrent: Math.max(1, intOr(env.NOUS_MAX_CONCURRENT, 2)),
  };
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
