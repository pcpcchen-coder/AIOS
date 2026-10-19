import Anthropic from "@anthropic-ai/sdk";
import { ExecutionError, type ExecutionResult, type Executor, type Reporter } from "./runner.ts";

export interface ClaudeExecutorOptions {
  apiKey: string;
  /** 明確指定的模型 id（NOUS_MODEL）；未指定時經 Models API 取得。 */
  model: string | null;
  /** 未指定模型時，從 Models API 挑選 id 含此字串的最新模型。 */
  modelFamily: string;
  /** 是否啟用伺服器端 refusal fallback（beta）。 */
  fallbacks: boolean;
  client?: Anthropic;
}

const SYSTEM = [
  "你是 Nous 的任務執行 Agent。使用者在桌面上交辦一件事，你負責完成它。",
  "能力限制：這個原型沒有任何工具——不能上網、不能讀寫檔案、不能寄信或對外發布、不能付款、不能查詢即時資料。",
  "你只能運用既有知識進行思考、分析、撰寫與規劃。",
  "需要上述能力的部分，必須明確寫出缺口，並提供可行的替代產出（例如草稿、清單、操作步驟），不得假裝已經完成。",
  "不確定的事實要標明是推測。使用繁體中文（台灣用語）。",
].join("\n");

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          instruction: { type: "string" },
        },
        required: ["title", "instruction"],
        additionalProperties: false,
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    capability_gaps: { type: "array", items: { type: "string" } },
  },
  required: ["steps", "assumptions", "capability_gaps"],
  additionalProperties: false,
} as const;

interface Plan {
  steps: { title: string; instruction: string }[];
  assumptions: string[];
  capability_gaps: string[];
}

const MAX_PLAN_STEPS = 5;
const SYNTHESIS_TITLE = "彙整成果";

export class ClaudeExecutor implements Executor {
  readonly mode = "claude" as const;
  private readonly client: Anthropic;
  private resolvedModel: Promise<string> | null = null;

  constructor(private readonly options: ClaudeExecutorOptions) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: 5 * 60_000 });
  }

  /** 模型不寫死：優先用設定值，否則向 Models API 查詢最新的指定系列模型。 */
  resolveModel(): Promise<string> {
    if (this.options.model) return Promise.resolve(this.options.model);
    this.resolvedModel ??= this.lookupModel().catch((err) => {
      this.resolvedModel = null; // 失敗時下次重新查詢
      throw err;
    });
    return this.resolvedModel;
  }

  private async lookupModel(): Promise<string> {
    const models: Anthropic.ModelInfo[] = [];
    for await (const m of this.client.models.list()) models.push(m);
    if (models.length === 0) throw new ExecutionError("Models API 沒有回傳任何可用模型。");
    const newestFirst = [...models].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const family = this.options.modelFamily.toLowerCase();
    return (newestFirst.find((m) => m.id.toLowerCase().includes(family)) ?? newestFirst[0]).id;
  }

  private extra(): { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: "default" } {
    return this.options.fallbacks
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
      : {};
  }

  async run(input: { title: string }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    try {
      return await this.execute(input.title, reporter, signal);
    } catch (err) {
      throw toExecutionError(err);
    }
  }

  private async execute(title: string, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    const model = await this.resolveModel();
    const served = new Set<string>();
    const today = new Date().toISOString().slice(0, 10);

    const planMessage = await this.client.beta.messages.create(
      {
        model,
        max_tokens: 4000,
        system: SYSTEM,
        output_config: { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              `今天日期：${today}`,
              `使用者交辦的任務：${title}`,
              "",
              `請把任務拆成 1 到 ${MAX_PLAN_STEPS} 個具體執行步驟，每步給一個 15 字以內的標題與給執行者的指示。`,
              "不要加入「彙整」或「總結」步驟，系統會自動在最後加上。",
              "同時列出你做的假設，以及因為沒有工具而無法完成的部分（能力缺口）。",
            ].join("\n"),
          },
        ],
        ...this.extra(),
      },
      { signal },
    );
    served.add(planMessage.model);
    assertUsable(planMessage, "規劃");
    const plan = parsePlan(textOf(planMessage));

    const titles = [...plan.steps.map((s) => s.title), SYNTHESIS_TITLE];
    reporter.planReady(titles, model);

    const planText = plan.steps.map((s, i) => `${i + 1}. ${s.title}：${s.instruction}`).join("\n");
    const outputs: string[] = [];
    let truncated = false;

    for (let i = 0; i < titles.length; i++) {
      const isSynthesis = i === titles.length - 1;
      const previous = outputs
        .map((out, j) => `### 步驟 ${j + 1}：${plan.steps[j].title}\n${out}`)
        .join("\n\n");
      const instruction = isSynthesis
        ? [
            "根據以上步驟的產出，寫出交付給使用者的最終成果（Markdown）。",
            "開頭先用 1–2 句總結。若有能力缺口，最後用「尚未完成／需要你處理」小節列出。",
          ].join("\n")
        : `現在執行步驟 ${i + 1}：${plan.steps[i].title}\n指示：${plan.steps[i].instruction}\n只輸出這一步的產出（Markdown）。`;

      reporter.stepStarted(i);
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: isSynthesis ? 32000 : 16000,
          system: SYSTEM,
          output_config: { effort: "medium" },
          messages: [
            {
              role: "user",
              content: [
                `今天日期：${today}`,
                `使用者交辦的任務：${title}`,
                "",
                "完整計畫：",
                planText,
                previous ? `\n先前步驟的產出：\n${previous}` : "",
                "",
                instruction,
              ].join("\n"),
            },
          ],
          ...this.extra(),
        },
        { signal },
      );
      let chars = 0;
      let lastReport = 0;
      stream.on("text", (delta) => {
        chars += delta.length;
        const now = Date.now();
        if (now - lastReport >= 700) {
          lastReport = now;
          reporter.stepProgress(i, chars);
        }
      });
      const message = await stream.finalMessage();
      served.add(message.model);
      assertUsable(message, titles[i]);
      if (message.stop_reason === "max_tokens") truncated = true;
      reporter.stepProgress(i, chars);
      outputs.push(textOf(message));
      reporter.stepDone(i);
    }

    const gaps = [...plan.capability_gaps];
    if (truncated) gaps.push("部分步驟的輸出達到長度上限而被截斷。");
    return {
      content: outputs[outputs.length - 1],
      assumptions: plan.assumptions,
      capability_gaps: gaps,
      status: truncated ? "partial" : "complete",
      model: [...served].join(", "),
    };
  }
}

function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function assertUsable(message: Anthropic.Beta.BetaMessage, stage: string): void {
  if (message.stop_reason === "refusal") {
    throw new ExecutionError(`模型在「${stage}」階段拒絕處理這個請求（安全政策）。`);
  }
}

export function parsePlan(text: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ExecutionError("規劃結果不是有效的 JSON，無法確定步驟。");
  }
  const obj = raw as Partial<Plan>;
  const steps = Array.isArray(obj.steps)
    ? obj.steps
        .filter((s) => typeof s?.title === "string" && s.title.trim() && typeof s.instruction === "string")
        .slice(0, MAX_PLAN_STEPS)
        .map((s) => ({ title: s.title.trim().slice(0, 40), instruction: s.instruction.trim() }))
    : [];
  if (steps.length === 0) throw new ExecutionError("規劃結果沒有任何可執行的步驟。");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { steps, assumptions: strings(obj.assumptions), capability_gaps: strings(obj.capability_gaps) };
}

/** 把 SDK 錯誤轉成使用者看得懂、且不誇大的說明。子類別要先判斷。 */
export function toExecutionError(err: unknown): ExecutionError {
  if (err instanceof ExecutionError) return err;
  const wrap = (msg: string) => new ExecutionError(msg, { cause: err });
  if (err instanceof Anthropic.AuthenticationError) return wrap("API key 無效或未授權（401），請檢查 .env 的 ANTHROPIC_API_KEY。");
  if (err instanceof Anthropic.PermissionDeniedError) return wrap("這個 API key 沒有使用該模型或功能的權限（403）。");
  if (err instanceof Anthropic.NotFoundError) return wrap("找不到指定的模型（404），請檢查 NOUS_MODEL。");
  if (err instanceof Anthropic.RateLimitError) return wrap("超過 API 速率限制（429），請稍後重試。");
  if (err instanceof Anthropic.BadRequestError) return wrap(`請求被 API 拒絕（400）：${err.message}`);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return wrap("連線逾時：Anthropic API 未在時限內回應。");
  if (err instanceof Anthropic.APIConnectionError) return wrap("無法連線到 Anthropic API（網路中斷或被阻擋）。");
  if (err instanceof Anthropic.APIError) return wrap(`Anthropic API 錯誤（${err.status ?? "未知狀態"}）：${err.message}`);
  return wrap(`執行失敗：${(err as Error)?.message ?? String(err)}`);
}
