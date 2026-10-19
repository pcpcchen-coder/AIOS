import type { ExecutionResult, Executor, Reporter } from "./runner.ts";

/**
 * 模擬執行器：沒有呼叫任何模型，只用計時器走過固定步驟，讓介面流程可被看見。
 * 產出的成果明確寫明「未實際完成」，UI 也會全程標示「模擬」。
 */
export class MockExecutor implements Executor {
  readonly mode = "mock" as const;

  constructor(private readonly stepDelayMs = 1800) {}

  async run(input: { title: string }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    const steps = ["理解需求（模擬）", "拆解工作（模擬）", "整理產出（模擬）"];
    await sleep(this.stepDelayMs * 0.6, signal);
    reporter.planReady(steps, null);
    for (let i = 0; i < steps.length; i++) {
      reporter.stepStarted(i);
      await sleep(this.stepDelayMs, signal);
      reporter.stepDone(i);
    }
    return {
      content: [
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
      capability_gaps: ["模擬模式：未連接任何 Agent 或工具"],
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
