// 即時語音的上網查詢：用 OPENAI_API_KEY 呼叫 Responses API 的 web_search 工具，回傳簡短答案與來源。
// ChatGPT 方案路徑的工作階段改走 Codex Responses 的 hosted web_search（同一個 Codex 登入、算方案額度）。
// 只在本機核心執行，API key 與權杖都不進瀏覽器。

import { CodexError, type CodexResponses } from "./codex-responses.ts";

const API = "https://api.openai.com/v1";
const TIMEOUT_MS = 30_000;

export interface WebSearchOptions {
  apiKey: string | null;
  /** NOUS_SEARCH_MODEL。 */
  model: string;
  /** 搜尋時的大致位置（ISO 國碼、IANA 時區），讓「天氣」「附近」這類查詢有地區依據。 */
  country: string;
  timezone: string;
  /** ChatGPT 方案路徑的上網查詢（Codex Responses hosted web_search）；未提供時只能用 API key。 */
  codex?: Pick<CodexResponses, "turn" | "available">;
  fetch?: typeof fetch;
}

/** 這次查詢由誰計費：API key 路徑用 OPENAI_API_KEY，ChatGPT 方案路徑用 Codex 額度。 */
export type SearchVia = "api_key" | "codex";

export interface WebSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  ok: true;
  answer: string;
  sources: WebSource[];
  model: string;
}

export class WebSearchError extends Error {
  constructor(message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options);
  }
}

const INSTRUCTIONS = [
  "你替語音助理上網查資料，答案會被念給使用者聽。",
  "根據搜尋結果，用繁體中文（台灣用語）簡短回答，120 字以內。",
  "先講結論，再給具體數字、日期、時間與地點；查到的資料若有時效，說明是哪個時間點的資料。",
  "搜尋結果不足或互相矛盾時直接說明，不要猜。",
].join("\n");

export class WebSearch {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: WebSearchOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  get available(): boolean {
    return !!this.options.apiKey;
  }

  get model(): string {
    return this.options.model;
  }

  /** 指定的計費方式能不能查。 */
  availableVia(via: SearchVia): boolean {
    return via === "codex" ? !!this.options.codex?.available : this.available;
  }

  /** 依工作階段的路徑查詢；api_key 就是原本的 search()，行為不變。 */
  async searchVia(query: string, via: SearchVia, signal?: AbortSignal): Promise<WebSearchResult> {
    if (via === "api_key") return this.search(query, signal);
    const codex = this.options.codex;
    if (!codex?.available) throw new WebSearchError("ChatGPT 方案路徑尚未登入，無法上網查詢。", 409);
    const q = query.trim();
    if (!q) throw new WebSearchError("缺少查詢內容。", 400);
    try {
      const turn = await codex.turn({
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content: q }],
        tools: [{ type: "web_search", external_web_access: true, user_location: { type: "approximate", country: this.options.country, timezone: this.options.timezone } }],
        signal,
      });
      if (!turn.text) throw new WebSearchError("上網查詢沒有得到可用的答案。", 502);
      return { ok: true, answer: turn.text, sources: turn.citations, model: turn.model };
    } catch (err) {
      if (err instanceof WebSearchError) throw err;
      if (err instanceof CodexError) {
        const status = err.failure.kind === "timeout" ? 504 : err.failure.kind === "auth" ? 409 : 502;
        throw new WebSearchError(`上網查詢失敗（ChatGPT 方案）：${err.message}`, status);
      }
      throw err;
    }
  }

  async search(query: string, signal?: AbortSignal): Promise<WebSearchResult> {
    const { apiKey, model } = this.options;
    if (!apiKey) throw new WebSearchError("尚未設定 OPENAI_API_KEY，無法上網查詢。", 409);
    const q = query.trim();
    if (!q) throw new WebSearchError("缺少查詢內容。", 400);

    const body: Record<string, unknown> = {
      model,
      instructions: INSTRUCTIONS,
      input: q,
      tools: [
        {
          type: "web_search",
          search_context_size: "low",
          user_location: { type: "approximate", country: this.options.country, timezone: this.options.timezone },
        },
      ],
      // 查詢要快：推理模型用低推理量；不支援 reasoning 參數的模型會自動改送不含此參數的請求。
      reasoning: { effort: "low" },
      store: false,
    };

    let res = await this.post(body, signal);
    if (res.status === 400) {
      const raw = await res.text().catch(() => "");
      if (/reasoning/i.test(raw)) {
        delete body.reasoning;
        res = await this.post(body, signal);
      } else {
        throw new WebSearchError(`上網查詢失敗（HTTP 400）：${errorMessage(raw)}`, 502);
      }
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      if (res.status === 401) throw new WebSearchError("上網查詢失敗：OPENAI_API_KEY 無效或未授權（401）。", 502);
      if (res.status === 429) throw new WebSearchError(`上網查詢失敗：OpenAI 額度不足或超過速率限制（429）：${errorMessage(raw)}`, 502);
      throw new WebSearchError(`上網查詢失敗（HTTP ${res.status}）：${errorMessage(raw)}`, 502);
    }
    const data = (await res.json()) as ResponsesBody;
    const parsed = parseResponse(data);
    if (!parsed.answer) throw new WebSearchError("上網查詢沒有得到可用的答案。", 502);
    return { ok: true, ...parsed, model: data.model ?? model };
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      return await this.fetch(`${API}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (timeout.aborted) throw new WebSearchError(`上網查詢逾時（${TIMEOUT_MS / 1000} 秒）。`, 504, { cause: err });
      throw new WebSearchError("上網查詢失敗：無法連線到 OpenAI（網路中斷或被阻擋）。", 502, { cause: err });
    }
  }
}

interface ResponsesBody {
  model?: string;
  output?: {
    type?: string;
    content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  }[];
}

/** 取出最終文字與 url_citation 來源（依網址去重）。 */
export function parseResponse(data: ResponsesBody): { answer: string; sources: WebSource[] } {
  const texts: string[] = [];
  const sources = new Map<string, WebSource>();
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text" || typeof part.text !== "string") continue;
      texts.push(part.text);
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && a.url && !sources.has(a.url)) {
          sources.set(a.url, { title: a.title?.trim() || hostOf(a.url), url: a.url });
        }
      }
    }
  }
  return { answer: texts.join("").trim(), sources: [...sources.values()].slice(0, 5) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function errorMessage(raw: string): string {
  try {
    return (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}
