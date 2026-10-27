import { type Locale } from "../shared/i18n.mjs";
import { classifyDomain } from "../shared/domain.ts";
import { DELEGATE_CLOSE, DELEGATE_OPEN, type ChatCapable, type ChatMessage } from "./chat.ts";
import type { ExecutionResult, Executor, Reporter } from "./runner.ts";

/** 模擬模式下視為「要它做事」的動詞；真實引擎由模型自行判斷。 */
const MOCK_WORK = /(寫|撰寫|整理|規劃|分析|翻譯|摘要|總結|製作|準備|做一份)|\b(write|draft|organize|plan|analyze|translate|summarize|create|prepare)\b/i;

/**
 * 模擬執行器：沒有呼叫任何模型，只用計時器走過固定步驟，讓介面流程可被看見。
 * 產出的成果明確寫明「未實際完成」，UI 也會全程標示「模擬」。
 */
export class MockExecutor implements Executor, ChatCapable {
  readonly mode = "mock" as const;

  constructor(private readonly stepDelayMs = 1800) {}

  /**
   * 模擬對話：不呼叫模型，明說自己是模擬，讓語音與插話流程可以被測試。
   * 聽起來像交辦工作時，照真實引擎的格式輸出交辦標記，讓多輪交辦流程也能在模擬模式驗證。
   */
  async chat(
    input: { system: string; messages: ChatMessage[] },
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{ model: string | null }> {
    const heard = input.messages[input.messages.length - 1].content.slice(0, 30);
    const english = input.system.includes("Response language: English");
    const reply = english ? (MOCK_WORK.test(heard)
      ? `(Mock) I have queued “${heard}” as a background task. Progress appears below the brain.\n${DELEGATE_OPEN}${heard}${DELEGATE_CLOSE}`
      : `(Mock) I heard “${heard}”. No AI model is connected, so I cannot actually answer. Open settings to select Claude or ChatGPT.`) : MOCK_WORK.test(heard)
      ? `（模擬）好，我把「${heard}」交辦成背景任務，進度會顯示在電子腦下方。\n${DELEGATE_OPEN}${heard}${DELEGATE_CLOSE}`
      : `（模擬）我聽到你說「${heard}」。現在是模擬模式，沒有連接任何 AI 模型，所以沒辦法真的回答。你可以說「設定」切換到 Claude 或 ChatGPT。`;
    for (const chunk of reply.match(/.{1,6}/gu) ?? []) {
      await sleep(this.stepDelayMs / 30, signal);
      onDelta(chunk);
    }
    return { model: null };
  }

  async run(input: { title: string; locale?: Locale }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    const english = input.locale === "en";
    const steps = english ? ["Understand request (mock)", "Break down work (mock)", "Prepare result (mock)"] : ["理解需求（模擬）", "拆解工作（模擬）", "整理產出（模擬）"];
    await sleep(this.stepDelayMs * 0.6, signal);
    const domain = classifyDomain(input.title) ?? "language";
    reporter.planReady(
      steps.map((title, i) => ({ title, domain: i === steps.length - 1 ? ("language" as const) : domain })),
      null,
    );
    for (let i = 0; i < steps.length; i++) {
      reporter.stepStarted(i);
      await sleep(this.stepDelayMs, signal);
      reporter.stepDone(i);
    }
    return {
      content: english ? ["## Mock result", "", `Your request: “${input.title}”.`, "", "This is **mock mode**. No AI model was called, and **the request was not actually completed**.", "The steps use timers to demonstrate task, progress, and result views.", "", "To run Claude, configure `ANTHROPIC_API_KEY` in `.env` and restart."].join("\n") : [
        "## 模擬結果",
        "",
        `你交辦的是：「${input.title}」。`,
        "",
        "目前是**模擬模式**：系統沒有呼叫任何 AI 模型，也**沒有實際完成這件事**。",
        "剛才的步驟只是用計時器走過固定流程，用來展示交辦 → 進度 → 成果的介面。",
        "",
        "要讓 Claude 真的執行，請在 `.env` 設定 `ANTHROPIC_API_KEY` 後重新啟動。",
      ].join("\n"),
      assumptions: [],
      capability_gaps: [english ? "Mock mode: no Agent or tools are connected" : "模擬模式：未連接任何 Agent 或工具"],
      status: "partial",
      model: null,
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
