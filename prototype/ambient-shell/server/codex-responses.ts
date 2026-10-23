import { readSse } from "./chatgpt-executor.ts";
import { CodexUnauthorized, NOUS_ORIGINATOR, type CodexAuth } from "./codex-auth.ts";

// chatgpt.com/backend-api/codex/responses 的用戶端，用和語音通話同一個 Codex 登入，
// 讓 ChatGPT 方案路徑上交辦的推論（LiveToolCaller）與上網查詢（WebSearch via codex）都算 Codex 額度。
//
// 請求約定（OpenClaw openai-chatgpt-responses*.ts、Codex common.rs:279-304、hosted_spec.rs、endpoint/models.rs）：
//  POST {base}/responses：model、instructions、input、store:false（後端不接受 true）、stream:true、
//    include:["reasoning.encrypted_content"]、tools（function，strict:false）、tool_choice:"auto"、
//    parallel_tool_calls:false（家電指令要一個一個來）
//  標頭：Authorization、chatgpt-account-id、originator: nous、User-Agent、OpenAI-Beta: responses=experimental、accept: text/event-stream
//  上網：{type:"web_search", external_web_access:true, user_location}
//  模型：GET {base}/models?client_version=<v> → {models:[{slug, visibility, priority}]}（不寫死模型）
//  用量上限：429 或 error.code usage_limit_reached｜usage_not_included｜rate_limit_exceeded（resets_at 是秒）

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** 和 REALTIME_TOOLS 宣告的一樣（扁平的 Responses function 形狀，不用 namespace）。 */
export interface FunctionToolSpec {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: false;
}
export type CodexToolSpec = FunctionToolSpec | { type: "web_search"; external_web_access: true; user_location?: Record<string, unknown> };

/** 模型這一輪輸出的項目，下一輪要原樣帶回（store:false，狀態由用戶端保存）。不透明、不寫 log。 */
export type ReplayItem = { readonly __replay: unique symbol };

export type CodexInputItem = ReplayItem | { role: "user"; content: string } | { type: "function_call_output"; call_id: string; output: string };

export interface CodexTurnRequest {
  instructions: string;
  input: readonly CodexInputItem[];
  tools: readonly CodexToolSpec[];
  signal?: AbortSignal;
}

export interface CodexCall {
  call_id: string;
  name: string;
  arguments: string;
}

export interface CodexTurn {
  text: string;
  calls: CodexCall[];
  citations: { title: string; url: string }[];
  model: string;
  replay: ReplayItem[];
}

export type CodexFailure =
  | { kind: "usage_limit"; plan: string | null; resets_in_min: number | null }
  | { kind: "auth"; reason: "not_logged_in" | "needs_reauth" | "no_account_id" }
  | { kind: "forbidden" }
  | { kind: "bad_request" }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "network" }
  | { kind: "upstream"; status: number | null };

export class CodexError extends Error {
  constructor(readonly failure: CodexFailure, message: string) {
    super(message);
  }
}

export interface CodexResponsesOptions {
  /** NOUS_LIVE_AGENT_MODEL；null 時查 /models（visibility 為 list、priority 最小者）。 */
  model: string | null;
  /** NOUS_CODEX_CLIENT_VERSION，/models 的 client_version。 */
  clientVersion: string;
  /** 每一輪串流的時限。 */
  turnTimeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface Deadline {
  signal: AbortSignal;
  outer: AbortSignal | undefined;
  timedOut(): boolean;
  clear(): void;
}

const USAGE_CODES = /usage_limit_reached|usage_not_included|rate_limit_exceeded/i;

export class CodexResponses {
  private model: Promise<string> | null = null;
  private readonly fetch: typeof fetch;
  private readonly base: string;

  constructor(private readonly auth: CodexAuth, private readonly options: CodexResponsesOptions) {
    this.fetch = options.fetch ?? fetch;
    this.base = (options.baseUrl ?? CODEX_BASE_URL).replace(/\/+$/, "");
  }

  get available(): boolean {
    return this.auth.readiness().ready;
  }

  /** 第一次成功後在這個行程內沿用；失敗不快取。 */
  resolveModel(signal?: AbortSignal): Promise<string> {
    if (this.options.model) return Promise.resolve(this.options.model);
    this.model ??= this.lookupModel(signal).catch((err: unknown) => {
      this.model = null;
      throw err;
    });
    return this.model;
  }

  private async lookupModel(signal?: AbortSignal): Promise<string> {
    const url = `${this.base}/models?client_version=${encodeURIComponent(this.options.clientVersion)}`;
    const deadline = this.deadline(signal);
    let res: Response;
    try {
      res = await this.send(url, { method: "GET" }, deadline, "取得 Codex 模型清單");
    } finally {
      deadline.clear();
    }
    const body = (await res.json().catch(() => ({}))) as { models?: { slug?: unknown; visibility?: unknown; priority?: unknown }[] };
    const listed = (body.models ?? [])
      .filter((m) => typeof m.slug === "string" && m.slug && m.visibility === "list")
      .sort((a, b) => (typeof a.priority === "number" ? a.priority : 1e9) - (typeof b.priority === "number" ? b.priority : 1e9));
    const slug = listed[0]?.slug as string | undefined;
    if (!slug) throw new CodexError({ kind: "bad_request" }, "Codex 模型清單是空的；請在 .env 設定 NOUS_LIVE_AGENT_MODEL。");
    return slug;
  }

  /** 一輪串流 Responses。錯誤訊息不含權杖、帳號 ID 或 JWT。 */
  async turn(request: CodexTurnRequest): Promise<CodexTurn> {
    const model = await this.resolveModel(request.signal);
    const body = {
      model,
      instructions: request.instructions,
      input: request.input.map(toWire),
      tools: request.tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    };
    // 時限涵蓋整輪（連線＋串流），不只是等標頭。
    const deadline = this.deadline(request.signal);
    try {
      return await this.stream(model, body, deadline);
    } catch (err) {
      if (err instanceof CodexError) throw err;
      if (request.signal?.aborted) throw new CodexError({ kind: "aborted" }, "Codex 推論已中止。");
      if (deadline.timedOut()) throw new CodexError({ kind: "timeout" }, `Codex 推論逾時（${this.options.turnTimeoutMs / 1000} 秒）。`);
      throw new CodexError({ kind: "network" }, "Codex 串流中斷（網路）。");
    } finally {
      deadline.clear();
    }
  }

  private async stream(model: string, body: Record<string, unknown>, deadline: Deadline): Promise<CodexTurn> {
    const res = await this.send(
      `${this.base}/responses`,
      { method: "POST", headers: { "OpenAI-Beta": "responses=experimental", accept: "text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify(body) },
      deadline,
      "Codex 推論",
    );
    if (!res.body) throw new CodexError({ kind: "upstream", status: res.status }, "Codex 推論沒有回應內容。");
    let text = "";
    let served = model;
    const calls: CodexCall[] = [];
    const replay: Record<string, unknown>[] = [];
    const citations = new Map<string, { title: string; url: string }>();
    let messageText = "";
    for await (const event of readSse(res.body)) {
      const type = event.type;
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
      } else if (type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (!item) continue;
        replay.push(item);
        if (item.type === "function_call" && typeof item.name === "string") {
          calls.push({ call_id: String(item.call_id ?? item.id ?? ""), name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" });
        } else if (item.type === "message") {
          for (const part of (item.content as { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[] | undefined) ?? []) {
            if (part.type !== "output_text") continue;
            if (typeof part.text === "string") messageText += part.text;
            for (const a of part.annotations ?? []) {
              if (a.type === "url_citation" && a.url && !citations.has(a.url)) citations.set(a.url, { title: a.title?.trim() || hostOf(a.url), url: a.url });
            }
          }
        }
      } else if (type === "response.created" || type === "response.in_progress") {
        const m = (event.response as { model?: unknown } | undefined)?.model;
        if (typeof m === "string") served = m;
      } else if (type === "response.completed") {
        const m = (event.response as { model?: unknown } | undefined)?.model;
        return {
          text: (text || messageText).trim(),
          calls,
          citations: [...citations.values()].slice(0, 5),
          model: typeof m === "string" ? m : served,
          replay: replay as unknown as ReplayItem[],
        };
      } else if (type === "response.failed" || type === "error") {
        const err = ((event.response as { error?: unknown } | undefined)?.error ?? event.error ?? event) as { code?: unknown; message?: unknown; resets_at?: unknown; plan_type?: unknown };
        throw this.failure(typeof err.code === "string" ? err.code : null, null, err);
      }
    }
    throw new CodexError({ kind: "upstream", status: null }, "Codex 串流中斷：沒有收到 response.completed。");
  }

  /** 呼叫端的中止＋這一輪的時限（用 setTimeout，測試的假時鐘控制得到）。 */
  private deadline(signal?: AbortSignal): Deadline {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.turnTimeoutMs);
    return {
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      outer: signal,
      timedOut: () => timeout.signal.aborted,
      clear: () => clearTimeout(timer),
    };
  }

  /** 帶憑證送出；401 交給 withAuth 更新一次。逾時與中止分開回報。 */
  private async send(url: string, init: RequestInit, deadline: Deadline, stage: string): Promise<Response> {
    const combined = deadline.signal;
    const signal = deadline.outer;
    try {
      return await this.auth.withAuth(async (auth) => {
        let res: Response;
        try {
          res = await this.fetch(url, {
            ...init,
            headers: { ...(init.headers as Record<string, string> | undefined), ...auth.headers(), originator: NOUS_ORIGINATOR, "User-Agent": `nous/${this.options.clientVersion}` },
            signal: combined,
          });
        } catch {
          if (signal?.aborted) throw new CodexError({ kind: "aborted" }, `${stage}已中止。`);
          if (deadline.timedOut()) throw new CodexError({ kind: "timeout" }, `${stage}逾時（${this.options.turnTimeoutMs / 1000} 秒）。`);
          throw new CodexError({ kind: "network" }, `${stage}失敗：無法連線到 chatgpt.com（網路中斷或被阻擋）。`);
        }
        if (res.status === 401) {
          await res.text().catch(() => "");
          throw new CodexUnauthorized();
        }
        if (!res.ok) {
          const raw = await res.text().catch(() => "");
          let err: { code?: unknown; message?: unknown; resets_at?: unknown; plan_type?: unknown } = {};
          try {
            err = ((JSON.parse(raw) as { error?: typeof err }).error ?? {}) as typeof err;
          } catch {
            // 非 JSON
          }
          throw this.failure(typeof err.code === "string" ? err.code : null, res.status, err, stage);
        }
        return res;
      });
    } catch (err) {
      if (err instanceof CodexError || err instanceof CodexUnauthorized) throw err;
      const reason = (err as { reason?: unknown }).reason;
      if (reason === "not_logged_in" || reason === "needs_reauth" || reason === "no_account_id") throw new CodexError({ kind: "auth", reason }, (err as Error).message);
      if (reason === "network") throw new CodexError({ kind: "network" }, (err as Error).message);
      throw new CodexError({ kind: "upstream", status: null }, (err as Error).message);
    }
  }

  private failure(code: string | null, status: number | null, err: { message?: unknown; resets_at?: unknown; plan_type?: unknown }, stage = "Codex 推論"): CodexError {
    if (status === 429 || (code && USAGE_CODES.test(code))) {
      const resets = typeof err.resets_at === "number" ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60_000)) : null;
      const plan = typeof err.plan_type === "string" ? err.plan_type : null;
      return new CodexError({ kind: "usage_limit", plan, resets_in_min: resets }, `ChatGPT 方案額度已用完${resets !== null ? `，約 ${resets} 分鐘後重置` : ""}`);
    }
    const message = redact(typeof err.message === "string" ? err.message : "");
    if (status === 403) return new CodexError({ kind: "forbidden" }, `${stage}被拒絕（403）${message ? `：${message}` : ""}`);
    if (status === 400) return new CodexError({ kind: "bad_request" }, `${stage}失敗（400）${message ? `：${message}` : ""}`);
    return new CodexError({ kind: "upstream", status }, `${stage}失敗${status ? `（HTTP ${status}）` : ""}${message ? `：${message}` : ""}`);
  }
}

function toWire(item: CodexInputItem): Record<string, unknown> {
  const value = item as unknown as Record<string, unknown>;
  if (value.role === "user" && typeof value.content === "string") {
    return { type: "message", role: "user", content: [{ type: "input_text", text: value.content }] };
  }
  return value;
}

/** 去掉看起來像權杖的字串（JWT、Bearer、sk-…）；最多 300 字。 */
export function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[\w-]{8,}/g, "[redacted]")
    .slice(0, 300);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
