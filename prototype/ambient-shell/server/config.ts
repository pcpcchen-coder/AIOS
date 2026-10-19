import type { ExecutorMode } from "../shared/types.ts";

export interface Config {
  port: number;
  devPort: number;
  mode: ExecutorMode;
  modeReason: string;
  apiKey: string | null;
  model: string | null;
  modelFamily: string;
  fallbacks: boolean;
  maxConcurrent: number;
}

/** 由環境變數決定設定；未設定 API key 時才使用模擬模式，並說明原因。 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  const requested = env.NOUS_EXECUTOR?.trim().toLowerCase();
  if (requested && requested !== "claude" && requested !== "mock") {
    throw new Error(`NOUS_EXECUTOR 只能是 claude 或 mock，收到 "${env.NOUS_EXECUTOR}"`);
  }

  let mode: ExecutorMode;
  let modeReason: string;
  if (requested === "mock") {
    mode = "mock";
    modeReason = "NOUS_EXECUTOR=mock：使用模擬執行器，未呼叫任何模型。";
  } else if (apiKey) {
    mode = "claude";
    modeReason = "已設定 ANTHROPIC_API_KEY：任務由 Claude 執行。";
  } else if (requested === "claude") {
    throw new Error("NOUS_EXECUTOR=claude 需要設定 ANTHROPIC_API_KEY");
  } else {
    mode = "mock";
    modeReason = "未設定 ANTHROPIC_API_KEY：使用模擬執行器，未呼叫任何模型。";
  }

  return {
    port: intOr(env.PORT, 8787),
    devPort: intOr(env.NOUS_DEV_PORT, 5173),
    mode,
    modeReason,
    apiKey,
    model: env.NOUS_MODEL?.trim() || null,
    modelFamily: env.NOUS_MODEL_FAMILY?.trim() || "opus",
    fallbacks: (env.NOUS_FALLBACKS ?? "on").trim().toLowerCase() !== "off",
    maxConcurrent: Math.max(1, intOr(env.NOUS_MAX_CONCURRENT, 2)),
  };
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
