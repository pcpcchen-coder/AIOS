import { localize } from "./localization.ts";
import { type Locale } from "../shared/i18n.mjs";
import type { ContextFact } from "./memory/retrieve.ts";
import { parsePlan, PLAN_SCHEMA, planPrompt, stepPrompt, SYNTHESIS_TITLE, systemPrompt, WEB_SEARCH_UNAVAILABLE_GAP } from "./prompts.ts";
import { ExecutionError, type ExecutionResult, type Executor, type Reporter } from "./runner.ts";
import { RESOURCE, type ChatGPTAuth } from "./chatgpt-auth.ts";
import type { ChatCapable, ChatMessage } from "./chat.ts";

// 以使用者的 ChatGPT 方案額度執行任務：POST https://api.openai.com/v1/responses，
// 依 SIWC 預覽限制一律 store:false、stream:true，系統指示放在 instructions。

export interface ChatGPTExecutorOptions {
  /** 指定模型 slug（NOUS_CHATGPT_MODEL）；未指定時取帳號模型清單的第一個可顯示模型。 */
  model: string | null;
  /** 步驟執行時提供 Responses API 的 web_search 工具（NOUS_TASK_WEB_SEARCH）。 */
  webSearch?: boolean;
  fetch?: typeof fetch;
}

/** 帶工具的請求被拒（例如方案額度不支援 web_search）：改用不帶工具的請求重試。 */
class ToolsRejected extends Error {}

interface StreamResult {
  text: string;
  model: string | null;
  incomplete: boolean;
}

export class ChatGPTExecutor implements Executor, ChatCapable {
  readonly mode = "chatgpt" as const;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly auth: ChatGPTAuth,
    private readonly options: ChatGPTExecutorOptions,
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  /** 模型不寫死：用設定值，或向 /v1/models 查詢這個帳號可用的模型。 */
  async resolveModel(token: string): Promise<string> {
    if (this.options.model) return this.options.model;
    let res: Response;
    try {
      res = await this.fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      throw new ExecutionError("無法連線到 OpenAI API（網路中斷或被阻擋）。", { cause: err });
    }
    if (!res.ok) throw await this.httpError(res, "取得模型清單");
    const body = (await res.json()) as { models?: { slug?: string; visibility?: string }[] };
    const model = body.models?.find((m) => m.visibility === "list" && m.slug)?.slug;
    if (!model) throw new ExecutionError("這個 ChatGPT 帳號沒有可用的模型。");
    return model;
  }

  async run(input: { title: string; locale?: Locale; facts?: readonly ContextFact[] }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    const facts = input.facts ?? [];
    const model = await this.resolveModel(await this.auth.getAccessToken());
    const served = new Set<string>();
    let webSearch = !!this.options.webSearch;
    const extraGaps: string[] = [];

    const planned = await this.stream(
      {
        model,
        instructions: systemPrompt({ webSearch }, input.locale, facts),
        input: [{ role: "user", content: planPrompt(input.title) }],
        format: { type: "json_schema", name: "nous_plan", schema: PLAN_SCHEMA, strict: true },
      },
      signal,
    );
    if (planned.model) served.add(planned.model);
    const plan = parsePlan(planned.text);
    const synthesisTitle = localize(SYNTHESIS_TITLE, input.locale);
    const titles = [...plan.steps.map((s) => s.title), synthesisTitle];
    reporter.planReady(
      [...plan.steps.map((s) => ({ title: s.title, domain: s.domain })), { title: synthesisTitle, domain: "language" as const }],
      model,
    );

    const outputs: string[] = [];
    let truncated = false;
    for (let i = 0; i < titles.length; i++) {
      reporter.stepStarted(i);
      let chars = 0;
      let lastReport = 0;
      const onDelta = (delta: string) => {
        chars += delta.length;
        const now = Date.now();
        if (now - lastReport >= 700) {
          lastReport = now;
          reporter.stepProgress(i, chars);
        }
      };
      const request = (search: boolean) => ({
        model,
        instructions: systemPrompt({ webSearch: search }, input.locale, facts),
        input: [{ role: "user" as const, content: stepPrompt(input.title, plan, outputs, i) }],
        ...(search ? { tools: [{ type: "web_search" }] } : {}),
      });
      let result: StreamResult;
      try {
        result = await this.stream(request(webSearch), signal, onDelta);
      } catch (err) {
        if (!(err instanceof ToolsRejected)) throw err;
        webSearch = false;
        extraGaps.push(WEB_SEARCH_UNAVAILABLE_GAP);
        chars = 0;
        result = await this.stream(request(false), signal, onDelta);
      }
      if (result.model) served.add(result.model);
      if (result.incomplete) truncated = true;
      reporter.stepProgress(i, chars);
      outputs.push(result.text);
      reporter.stepDone(i);
    }

    const gaps = [...plan.capability_gaps, ...extraGaps.map(gap => localize(gap, input.locale))];
    if (truncated) gaps.push("部分步驟的輸出未完整結束（response.incomplete）。");
    return {
      content: outputs[outputs.length - 1],
      assumptions: plan.assumptions,
      capability_gaps: gaps,
      status: truncated ? "partial" : "complete",
      model: [...served].join(", ") || model,
    };
  }

  /** 語音對話：串流回覆文字；歷史訊息每次完整送出（不使用 previous_response_id）。 */
  async chat(
    input: { system: string; messages: ChatMessage[] },
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ model: string | null }> {
    const model = await this.resolveModel(await this.auth.getAccessToken());
    const request = { model, instructions: input.system, input: input.messages };
    let result: StreamResult;
    try {
      result = await this.stream(this.options.webSearch ? { ...request, tools: [{ type: "web_search" }] } : request, signal, onDelta);
    } catch (err) {
      if (!(err instanceof ToolsRejected)) throw err;
      result = await this.stream(request, signal, onDelta);
    }
    if (result.incomplete) throw new ExecutionError("ChatGPT 回覆尚未完成（response.incomplete），請再試一次。");
    return { model: result.model ?? model };
  }

  /** 送出一個串流 Responses 請求，直到 response.completed（或錯誤）。 */
  private async stream(
    request: {
      model: string;
      instructions: string;
      input: ChatMessage[];
      format?: Record<string, unknown>;
      tools?: Record<string, unknown>[];
    },
    signal: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<StreamResult> {
    const token = await this.auth.getAccessToken();
    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      store: false,
      stream: true,
    };
    if (request.format) body.text = { format: request.format };
    if (request.tools) body.tools = request.tools;
    let res: Response;
    try {
      res = await this.fetch(`${RESOURCE}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ExecutionError("無法連線到 OpenAI API（網路中斷或被阻擋）。", { cause: err });
    }
    if (!res.ok && request.tools && (res.status === 400 || res.status === 403)) {
      throw new ToolsRejected((await this.httpError(res, "推論")).message);
    }
    if (!res.ok || !res.body) throw await this.httpError(res, "推論");

    let text = "";
    let servedModel: string | null = null;
    for await (const event of readSse(res.body)) {
      const type = event.type;
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
        onDelta?.(event.delta);
      } else if (type === "response.created" || type === "response.in_progress") {
        servedModel = modelOf(event) ?? servedModel;
      } else if (type === "response.completed") {
        return { text, model: modelOf(event) ?? servedModel, incomplete: false };
      } else if (type === "response.incomplete") {
        return { text, model: modelOf(event) ?? servedModel, incomplete: true };
      } else if (type === "response.failed") {
        const err = (event.response as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw this.codeError(err?.code ?? null, err?.message ?? "推論失敗", null);
      } else if (type === "error") {
        // 實際串流把錯誤放在 event.error 底下；舊格式在頂層。
        const err = (event.error as { code?: unknown; message?: unknown } | undefined) ?? event;
        if (request.tools && err.code === "subscription_sharing_unsupported_capability" && !text) {
          throw new ToolsRejected(String(err.message ?? err.code));
        }
        throw this.codeError(
          typeof err.code === "string" ? err.code : null,
          typeof err.message === "string" ? err.message : "串流錯誤",
          null,
        );
      }
    }
    throw new ExecutionError("串流中斷：沒有收到 response.completed，結果不完整，未保存。");
  }

  private async httpError(res: Response, stage: string): Promise<ExecutionError> {
    const raw = await res.text().catch(() => "");
    let code: string | null = null;
    let message = raw.slice(0, 300);
    try {
      const body = JSON.parse(raw) as { error?: { code?: string; message?: string }; detail?: string };
      code = body.error?.code ?? null;
      message = body.error?.message ?? body.detail ?? message;
    } catch {
      // 保留原文
    }
    const requestId = res.headers.get("x-request-id");
    return this.codeError(code, `${stage}失敗（HTTP ${res.status}）：${message}`, res.status, requestId);
  }

  /** 依 errors-and-recovery 的錯誤碼給出可讀說明與下一步。 */
  private codeError(code: string | null, fallback: string, status: number | null, requestId?: string | null): ExecutionError {
    const suffix = requestId ? `（request id：${requestId}）` : "";
    switch (code) {
      case "subscription_sharing_usage_limit_exceeded":
        return new ExecutionError(`已達 ChatGPT 方案或 Nous 的用量上限，請到 ChatGPT 設定查看。${suffix}`, {
          action: "manage_chatgpt_usage",
        });
      case "subscription_sharing_usage_unavailable":
      case "subscription_sharing_user_unavailable":
        return new ExecutionError(`ChatGPT 暫時無法確認用量，請稍後重試。${suffix}`);
      case "subscription_sharing_user_not_eligible":
        return new ExecutionError(`這個 ChatGPT 帳號或工作區目前不能在第三方 app 使用方案額度。${suffix}`);
      case "subscription_sharing_unsupported_capability":
        return new ExecutionError(`請求含有 ChatGPT 方案用量不支援的功能：${fallback}${suffix}`);
      case "subscription_sharing_invalid_user":
        this.auth.invalidate("ChatGPT 無法驗證此登入，請重新登入。");
        return new ExecutionError(`ChatGPT 無法驗證此登入，請重新登入。${suffix}`, { action: "chatgpt_sign_in" });
      case "subscription_sharing_route_not_supported":
      case "chatpass_v2_scope_not_authorized":
      case "chatpass_v2_invalid_authorization_context":
        return new ExecutionError(`此登入的權限不允許這個操作（${code}）。${suffix}`, { action: "chatgpt_sign_in" });
    }
    if (status === 401) {
      return new ExecutionError(`ChatGPT 登入未被接受（401），請確認帳號與授權範圍後重新登入。${suffix}`, {
        action: "chatgpt_sign_in",
      });
    }
    if (status === 403) return new ExecutionError(`請求被政策或權限限制拒絕（403）：${fallback}${suffix}`);
    if (status === 503) return new ExecutionError(`ChatGPT 方案路由暫時無法使用（503），請稍後重試。${suffix}`);
    return new ExecutionError(`${fallback}${suffix}`);
  }
}

function modelOf(event: Record<string, unknown>): string | null {
  const model = (event.response as { model?: unknown } | undefined)?.model;
  return typeof model === "string" ? model : null;
}

/** 解析 text/event-stream，逐筆回傳 data 的 JSON。 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 忽略無法解析的事件
      }
    }
  }
}
