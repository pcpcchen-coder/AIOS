import { type Locale } from "../shared/i18n.mjs";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_VERSION, type ExecutorMode, type ProviderInfo, type SettingsView } from "../shared/types.ts";
import type { ChatGPTAuth } from "./chatgpt-auth.ts";
import type { ChatCapable, ChatMessage } from "./chat.ts";
import type { ChatTarget } from "./memory/retrieve.ts";

/** 記憶同意的帳號鍵：Claude 用 API key 的 HMAC 指紋前 16 碼（不保存 key 本身）。 */
export function claudeAccountKey(apiKey: string): string {
  return createHmac("sha256", "nous.memory.account.claude.v1").update(apiKey).digest("hex").slice(0, 16);
}
/** ChatGPT 用帳號 ID（subject）的雜湊前 16 碼。 */
export function chatgptAccountKey(subject: string): string {
  return createHash("sha256").update(`nous.memory.account.chatgpt.v1:${subject}`).digest("hex").slice(0, 16);
}
/**
 * MEM-2：ChatGPT 方案即時語音（Nous 自己的 Codex 登入）用 ChatGPT 帳號 ID 的雜湊前 16 碼。和 chatgpt（Sign in with ChatGPT）
 * 是不同的同意鍵：新增服務要另外確認（16 §4），即使背後是同一個 ChatGPT 帳號也不沿用。
 */
export function codexAccountKey(accountId: string): string {
  return createHash("sha256").update(`nous.memory.account.codex.v1:${accountId}`).digest("hex").slice(0, 16);
}
/** 記憶管理與首次設定卡上的名稱；同一個同意涵蓋 live 語音模型與交辦用的 Codex Responses（同一個帳號）。 */
export const CODEX_TARGET_LABEL = "ChatGPT 方案即時語音（Codex 登入）";
export function codexTarget(accountId: string | null): ChatTarget | null {
  return accountId ? { provider: "codex", account: codexAccountKey(accountId), label: CODEX_TARGET_LABEL } : null;
}
/**
 * MEM-3：OpenAI API key 即時語音的同意鍵：OPENAI_API_KEY 的 HMAC 指紋前 16 碼（比照 claudeAccountKey，不保存 key 本身）。
 * 不沿用 codex 或 chatgpt 的同意；換 key 就是另一個帳號，要重新允許。
 */
export function openaiRealtimeAccountKey(apiKey: string): string {
  return createHmac("sha256", "nous.memory.account.openai_realtime.v1").update(apiKey).digest("hex").slice(0, 16);
}
export const OPENAI_REALTIME_TARGET_LABEL = "OpenAI API key 即時語音";
export function openaiRealtimeTarget(apiKey: string | null): ChatTarget | null {
  return apiKey ? { provider: "openai_realtime", account: openaiRealtimeAccountKey(apiKey), label: OPENAI_REALTIME_TARGET_LABEL } : null;
}
import { ExecutionError, type ExecutionResult, type Executor, type Reporter } from "./runner.ts";

export interface ProviderManagerOptions {
  /** 沒有 ANTHROPIC_API_KEY 時為 null。 */
  claude: (Executor & ChatCapable) | null;
  chatgpt: Executor & ChatCapable;
  mock: Executor & ChatCapable;
  auth: ChatGPTAuth;
  /** 保存使用者選擇的引擎（settings.json）的目錄。 */
  dir: string;
  /** NOUS_PROVIDER 指定的預設引擎；使用者在畫面上切換後以保存的選擇為準。 */
  preferred: ExecutorMode | null;
  onChange(): void;
  /** Claude 的帳號指紋（claudeAccountKey）；沒有 API key 時省略。 */
  claudeAccount?: string | null;
}

/**
 * 可切換的 AI 引擎：Claude（API key）、ChatGPT（Sign in with ChatGPT）、模擬。
 * 任務建立時記錄當下的引擎，執行時依任務記錄分派，切換不影響已排隊的任務。
 */
export class ProviderManager implements Executor, ChatCapable {
  private current: ExecutorMode;
  private readonly file: string;

  constructor(private readonly options: ProviderManagerOptions) {
    this.file = join(options.dir, "settings.json");
    const saved = this.readSaved();
    this.current = saved ?? options.preferred ?? (options.claude ? "claude" : options.auth.usable ? "chatgpt" : "mock");
    if (this.current === "claude" && !options.claude) this.current = "mock";
  }

  get mode(): ExecutorMode {
    return this.current;
  }

  select(provider: ExecutorMode): void {
    if (provider === "claude" && !this.options.claude) {
      throw new ExecutionError("尚未設定 ANTHROPIC_API_KEY，無法使用 Claude。");
    }
    this.current = provider;
    writeJson(this.file, { provider });
    this.options.onChange();
  }

  view(): SettingsView {
    const chatgpt = this.options.auth.info();
    const providers: ProviderInfo[] = [
      {
        id: "claude",
        label: "Claude",
        available: this.options.claude !== null,
        detail: this.options.claude ? "使用 .env 的 ANTHROPIC_API_KEY，依用量計費" : "未設定 ANTHROPIC_API_KEY",
      },
      {
        id: "chatgpt",
        label: "ChatGPT",
        available: this.options.auth.usable,
        detail: chatgpt.needs_reauth
          ? "登入已失效，需要重新登入"
          : chatgpt.signed_in
            ? chatgpt.plan_usage
              ? `使用 ${chatgpt.email ?? "已登入帳號"} 的 ChatGPT 方案`
              : "已登入，但未授權使用 ChatGPT 方案"
            : "尚未登入",
      },
      { id: "mock", label: "模擬", available: true, detail: "不呼叫任何模型，只展示流程" },
    ];
    return { schema_version: SCHEMA_VERSION, provider: this.current, providers, chatgpt };
  }

  run(input: { title: string; mode: ExecutorMode; locale?: Locale }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    const executor =
      input.mode === "claude" ? this.options.claude : input.mode === "chatgpt" ? this.options.chatgpt : this.options.mock;
    if (!executor) {
      return Promise.reject(new ExecutionError("這個任務指定的 Claude 引擎未設定（缺少 ANTHROPIC_API_KEY）。"));
    }
    return executor.run(input, reporter, signal);
  }

  /**
   * 記憶同意用的「服務＋帳號」（16 §4）：一般聊天目前會送到哪個帳號。只換模型名稱不改變這個值，所以不用重問。
   * 模擬模式不呼叫模型，也不送記憶。
   */
  chatTarget(): ChatTarget | null {
    return this.targetOf(this.current);
  }

  /** 所有已設定、可用的服務帳號（首次設定逐一允許）。 */
  chatTargets(): ChatTarget[] {
    return (["claude", "chatgpt"] as const).map(mode => this.targetOf(mode)).filter((t): t is ChatTarget => t !== null && t.account !== null);
  }

  private targetOf(mode: ExecutorMode): ChatTarget | null {
    if (mode === "claude") return this.options.claude ? { provider: "claude", account: this.options.claudeAccount ?? null, label: "Claude" } : null;
    if (mode === "chatgpt") {
      const subject = this.options.auth.usable ? this.options.auth.accountSubject?.() ?? null : null;
      const email = this.options.auth.info().email;
      return { provider: "chatgpt", account: subject ? chatgptAccountKey(subject) : null, label: email ? `ChatGPT（${email}）` : "ChatGPT" };
    }
    return null;
  }

  /** 語音對話用目前選擇的引擎。 */
  chat(
    input: { system: string; messages: ChatMessage[] },
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ model: string | null }> {
    const executor =
      this.current === "claude" ? this.options.claude : this.current === "chatgpt" ? this.options.chatgpt : this.options.mock;
    if (!executor) return Promise.reject(new ExecutionError("Claude 引擎未設定（缺少 ANTHROPIC_API_KEY）。"));
    return executor.chat(input, onDelta, signal);
  }

  private readSaved(): ExecutorMode | null {
    if (!existsSync(this.file)) return null;
    try {
      const p = (JSON.parse(readFileSync(this.file, "utf8")) as { provider?: string }).provider;
      return p === "claude" || p === "chatgpt" || p === "mock" ? p : null;
    } catch {
      return null;
    }
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}
