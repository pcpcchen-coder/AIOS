import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { toolResult, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import type { ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";

// MAIL-1（George 2026-11-04）：用 gog（github.com/steipete/gogcli，MIT）寄信給使用者自己。
// - 收件人與寄件帳號都只來自核心設定 NOUS_MAIL_SELF（.env，不在 repo）；模型只能給主旨與內文，沒有收件人參數。
// - 不經 shell：spawn 參數陣列、旗標一律寫成 --flag=value（值以 - 開頭也不會被當成旗標）；內文經 stdin（--body-file -），
//   不出現在程序參數裡。gog 自己管 OAuth 與 refresh token（macOS 鑰匙圈），Nous 不讀、不存任何 Google 權杖。
// - 結果：結束代碼 0 而且 --json 輸出裡找得到郵件 ID → confirmed；結束代碼 0 但沒有 ID → unconfirmed；
//   非 0 → unknown（gog 可能在 Gmail 收下之後才出錯，例如回應途中斷線；不能說沒寄出，也避免模型重寄）；
//   gog 根本沒能啟動（spawn 失敗）→ failed（確定沒有送出）；逾時或中止 → 由 Dispatcher 回 unknown。
//   gog gmail send --json 的輸出欄位官方 README 沒寫（2026-11-04 查核），所以 ID 的欄位名稱寬鬆比對，需在 Mac 上核對。
// - stderr 不讀、不記：可能含帳號或錯誤細節。log 只有 Dispatcher 的狀態代碼。
// - 寄給自己不需要當次確認：George 2026-11-04 的明確決定（policy.ts CONFIRMATION_EXEMPT_TOOLS）。

export const MAIL_TOOL_ID = "app.mail.send_to_self" as const;
/** NOUS_GOG_PATH 沒設定時依序找的位置（App 從 Finder 啟動時 PATH 不含 Homebrew）。 */
export const GOG_CANDIDATES = ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"] as const;
export const MAIL_LIMITS = { subject: 200, body: 10_000, timeoutMs: 30_000, perMinute: 5 } as const;
/** SIGTERM 之後多久還沒結束就 SIGKILL。 */
export const GOG_KILL_GRACE_MS = 2_000;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

export interface GogRunOptions {
  signal: AbortSignal;
  /** 寫進 stdin 的內容（沒有時 stdin 關閉）。 */
  stdin?: string;
}
export type GogRunner = (file: string, args: string[], opts: GogRunOptions) => Promise<{ code: number | null; stdout: string }>;

export interface GmailGogOptions {
  /** 使用者自己的 Gmail（寄件帳號與收件人相同）。 */
  self: string;
  gogPath: string;
  run?: GogRunner;
  now?: () => number;
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** NOUS_MAIL_SELF：必須是一個 email；沒設定回 null。 */
export function parseMailSelf(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!isEmail(v)) throw new Error("NOUS_MAIL_SELF 必須是一個 email 地址");
  return v;
}

/** NOUS_GOG_PATH：必須是絕對路徑；沒設定回 null（之後依 GOG_CANDIDATES 找）。 */
export function parseGogPath(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (!isAbsolute(v)) throw new Error("NOUS_GOG_PATH 必須是絕對路徑");
  return v;
}

/** 找 gog：設定的路徑優先，否則看 Homebrew 的兩個位置；找不到回 null。 */
export function resolveGogPath(configured: string | null, exists: (path: string) => boolean = existsSync): string | null {
  if (configured) return configured;
  return GOG_CANDIDATES.find((p) => exists(p)) ?? null;
}

/** 主旨：去掉控制字元（含換行，避免標頭注入）、壓縮空白、截長度。 */
export function cleanSubject(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAIL_LIMITS.subject);
}

/** 內文：去掉 NUL、統一換行。 */
export function cleanBody(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").slice(0, MAIL_LIMITS.body);
}

export function buildSendArgs(self: string, subject: string): string[] {
  return ["gmail", "send", `--account=${self}`, `--to=${self}`, `--subject=${subject}`, "--body-file=-", "--json"];
}

/** 在 gog 的 JSON 輸出裡找郵件 ID（欄位名稱寬鬆比對：id、messageId、message_id，頂層或 message 物件裡）。 */
export function findMessageId(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "null");
  } catch {
    return null;
  }
  const pick = (o: unknown): string | null => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const r = o as Record<string, unknown>;
    for (const key of ["id", "messageId", "message_id"]) {
      const v = r[key];
      if (typeof v === "string" && /^[A-Za-z0-9_-]{4,128}$/.test(v)) return v;
    }
    return null;
  };
  return pick(parsed) ?? pick((parsed as Record<string, unknown> | null)?.message);
}

/** 預設的執行方式：spawn（不經 shell）、stderr 丟掉、stdout 最多 64 KB；中止時送 SIGTERM。 */
export const defaultGogRunner: GogRunner = (file, args, { signal, stdin }) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const child = spawn(file, args, { shell: false, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      // 不理 SIGTERM 的 gog：寬限後 SIGKILL，不留下殘餘的子行程。
      killTimer = setTimeout(() => child.kill("SIGKILL"), GOG_KILL_GRACE_MS);
      killTimer.unref?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 65_536) stdout += chunk;
    });
    child.stdin?.on("error", () => undefined);
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
    // 沒能啟動（找不到、沒有執行權限…）：標記 spawnFailed，呼叫端據此判斷「確定沒有送出」。
    let started = false;
    child.once("spawn", () => void (started = true));
    child.once("error", (err) => done(() => reject(started ? err : Object.assign(err, { spawnFailed: true }))));
    child.once("close", (code) => done(() => (signal.aborted ? reject(new Error("aborted")) : resolve({ code, stdout }))));
  });

const TOOLS: readonly ToolDefinition[] = [
  {
    id: MAIL_TOOL_ID,
    description:
      "寄一封 email 到使用者自己的 Gmail。收件人固定是使用者本人，不能寄給別人（使用者要寄給別人時照實說不支援）。使用者明確要你寄信、email 給他、寄到他的信箱時才呼叫。subject 寫一句簡短主旨；body 寫使用者要的內容，用使用者的語言。",
    descriptionEn:
      "Send an email to the user's own Gmail. The recipient is always the user; it cannot be sent to anyone else (if asked to email someone else, say that is not supported). Call only when the user explicitly asks you to email them or send something to their inbox. subject is a short line; body is the content the user wants, in the user's language.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "簡短主旨", minLength: 1, maxLength: MAIL_LIMITS.subject },
        body: { type: "string", description: "信件內文（純文字）", minLength: 1, maxLength: MAIL_LIMITS.body },
      },
      required: ["subject", "body"],
      additionalProperties: false,
    },
    effect: "external_commit",
    enabled: true,
    timeoutMs: MAIL_LIMITS.timeoutMs,
    supportedRoutes: ["api_key", "live"],
  },
];

export class GmailGogAdapter implements IntegrationAdapter {
  readonly id = "gmail_gog";
  readonly service = "mail";
  readonly version = 1;
  readonly mock = false;
  private readonly run: GogRunner;
  /** 寄給自己不出確認卡，所以另外限制：每分鐘最多 MAIL_LIMITS.perMinute 封（避免模型重複呼叫一直寄）。 */
  private sentAt: number[] = [];

  constructor(private readonly options: GmailGogOptions) {
    if (!isEmail(options.self)) throw new Error("寄件信箱不合法");
    if (!isAbsolute(options.gogPath)) throw new Error("gog 路徑必須是絕對路徑");
    this.run = options.run ?? defaultGogRunner;
  }

  tools(): readonly ToolDefinition[] {
    return TOOLS;
  }

  /** gog 能不能執行（gog --version）。不代表已登入 Gmail：真的寄得出去要看寄信的結果。 */
  async health(signal: AbortSignal): Promise<HealthReport> {
    try {
      const { code } = await this.run(this.options.gogPath, ["--version"], { signal });
      return code === 0 ? { health: "available", reason: "ok" } : { health: "unknown", reason: "error" };
    } catch (err) {
      if (signal.aborted) return { health: "unknown", reason: "timeout" };
      return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? { health: "unavailable", reason: "not_configured" } : { health: "unknown", reason: "error" };
    }
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    if (toolId !== MAIL_TOOL_ID) return toolResult("refused", "沒有這個整合工具，沒有執行。", { reason: "not_registered" });
    const subject = cleanSubject(String(args.subject ?? ""));
    const body = cleanBody(String(args.body ?? ""));
    if (!subject || !body.trim()) return toolResult("refused", "參數不正確，沒有執行。", { reason: "invalid_arguments" });
    const now = (this.options.now ?? Date.now)();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= MAIL_LIMITS.perMinute) return toolResult("refused", "這一分鐘寄太多封了，這封沒有寄出；請稍後再說一次。", { reason: "rate_limited" });
    this.sentAt.push(now);
    let result: { code: number | null; stdout: string };
    try {
      result = await this.run(this.options.gogPath, buildSendArgs(this.options.self, subject), { signal: ctx.signal, stdin: body });
    } catch (err) {
      // 中止：交給 Dispatcher（已經判定 unknown）。gog 沒能啟動（找不到檔案）：確定沒有送出。
      if (ctx.signal.aborted) throw err;
      if ((err as { spawnFailed?: boolean })?.spawnFailed || (err as NodeJS.ErrnoException)?.code === "ENOENT") return toolResult("failed", "gog 沒能啟動，信沒有寄出。", { reason: "unavailable" });
      throw err;
    }
    // 非 0：gog 可能在 Gmail 收下之後才出錯，不能說沒寄出（也不要重寄）。
    if (result.code !== 0) return toolResult("unknown", "gog 回報錯誤，不確定信有沒有寄出；請看一下信箱，也可以在 Mac 上檢查 gog 的登入。", { reason: "adapter_error" });
    return findMessageId(result.stdout)
      ? toolResult("confirmed", "信已寄到你的 Gmail。")
      : toolResult("unconfirmed", "gog 說已送出，但沒有回傳郵件 ID；請看一下信箱。");
  }
}
