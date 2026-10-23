import { matchApproval } from "../shared/approval.ts";
import { RESULT_UNKNOWN_TEXT, SIDE_EFFECT_TOOLS, type HostToolName } from "../shared/realtime-route.ts";
import type { Task } from "../shared/types.ts";
import { CodexError, type CodexInputItem, type CodexResponses, type CodexToolSpec, type FunctionToolSpec } from "./codex-responses.ts";
import { buildRealtimeTools, realtimeToolRules, taskLines, type RealtimeCapabilities } from "./realtime.ts";
import { HOST_TIMEOUT_MS, HostGone, type ApprovalSnapshot, type ToolHost } from "./realtime-routes.ts";

// gpt-live-1-codex 不能呼叫函式；它把使用者的請求用文字交辦（delegation.created）。
// LiveToolCaller 用同一個 Codex 登入的 Codex Responses，把這段文字變成 API key 路徑的語音模型會做的
// 同一組函式呼叫，並且每個呼叫都交給同一個執行器（頁面，經 ToolHost）。它是 live 路徑上
// 「內建函式呼叫」的替代品：不是第二個執行器，也不是第二個背景 agent（背景工作仍是 TaskRunner，經 delegate_task）。

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

export interface DelegationRequest {
  id: string;
  /** delegation.created 的內容，或使用者打的字。 */
  text: string;
  source: "voice" | "typed";
  /** sideband 回報的最近幾輪逐字稿（由舊到新）。 */
  transcript: readonly TranscriptTurn[];
}

/** 給 log 與驗證用。腦區只由頁面的執行器依實際執行的工具亮起。 */
export interface ExecutedTool {
  name: HostToolName;
  ok: boolean;
  ms: number;
}

/** 交回語音模型的內容。speakable：模型用自己的話說出；commentary：安靜的背景。 */
export type DelegationResult =
  | { ok: true; channel: "speakable" | "commentary"; text: string; tools: ExecutedTool[]; ended?: true }
  | { ok: false; channel: "speakable"; text: string; reason: "timeout" | "usage_limit" | "auth" | "upstream" | "unknown" | "closed"; tools: ExecutedTool[] };

export const CALLER_LIMITS = {
  /** 每次交辦的模型輪數：呼叫 → 結果 →（第二個呼叫，例如「開冷氣 26 度」＝power 再 ac_temperature）→ 最後的話。 */
  maxTurns: 3,
  turnTimeoutMs: 20_000,
  /** 每次交辦最多幾個工具呼叫（家電指令一個一個來，最多兩個）。 */
  maxHostCalls: 2,
  /** 送回結果（appends）的餘裕。 */
  marginMs: 3_000,
} as const;

/** 最慢的工具等待時間。 */
export const MAX_HOST_TIMEOUT_MS = Math.max(...Object.values(HOST_TIMEOUT_MS));

/**
 * 每次交辦的上限，由常數推導（tests/live-tool-caller.test.ts 用常數重算，不是寫死的數字）：
 * maxTurns × turnTimeoutMs ＋ maxHostCalls × 最慢的工具等待 ＋ 餘裕
 * ＝ 3 × 20 000 ＋ 2 × 62 000 ＋ 3 000 ＝ 187 000 ms。
 */
export const DELEGATION_BUDGET_MS = CALLER_LIMITS.maxTurns * CALLER_LIMITS.turnTimeoutMs + CALLER_LIMITS.maxHostCalls * MAX_HOST_TIMEOUT_MS + CALLER_LIMITS.marginMs;

/** 確認卡結束後多久內，「確認執行／取消」的交辦算是在回答那張卡。 */
export const APPROVAL_WINDOW_MS = 8_000;

const HOST_TOOLS: readonly HostToolName[] = ["web_search", "delegate_task", "get_tasks", "end_conversation", "home_status", "home_control"];

/**
 * 工具表：buildRealtimeTools(caps) 去掉 MCP（MCP 在 ChatGPT 方案路徑不可用）。名稱、說明、參數都和 API key 路徑相同：
 * 同一份 server/realtime.ts。
 */
export function liveCallerTools(caps: RealtimeCapabilities): CodexToolSpec[] {
  return buildRealtimeTools({ ...caps, mcp: [] })
    .filter((tool) => tool.type === "function")
    .map((tool) => {
      const t = tool as unknown as FunctionToolSpec;
      return { type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false } satisfies FunctionToolSpec;
    });
}

/** 說明：工具執行層的開頭 ＋ realtimeToolRules(caps)（API key 路徑語音模型拿到的同一段文字）＋ 回覆約定 ＋ 任務 ＋ 日期。 */
export function buildCallerInstructions(caps: RealtimeCapabilities, tasks: Iterable<Task>, now: Date): string {
  const list = taskLines(tasks);
  return [
    "你是 Nous 的工具執行層。即時語音模型沒有工具，會把使用者的請求交給你；你用工具完成，你最後一則訊息會交給語音模型用口語轉述給使用者。",
    ...realtimeToolRules({ ...caps, mcp: [] }),
    "外部服務（MCP）在這條路徑不能用；使用者要求時照實說，需要時請他到設定切換到 API key 路徑。",
    "最後一則訊息：一到三句繁體中文（台灣用語），只講工具回傳的事實；不要提工具名稱或 JSON。",
    "沒有呼叫工具就不能說做好了；工具失敗照實說；工具回傳 status 是 unknown 時只能說「結果不明，請確認」。",
    "needs_confirmation：說要對哪台設備做什麼，請使用者按畫面上的確認卡或說「確認執行」；你不能確認。",
    "一般聊天或不需要工具的問題，直接簡短回答，不要呼叫工具。",
    "使用者要結束對話時呼叫 end_conversation，最後一則訊息寫一句道別。",
    `今天日期：${now.toISOString().slice(0, 10)}。`,
    list.length ? `目前的任務：\n${list.join("\n")}` : "目前沒有交辦的任務。",
  ].join("\n");
}

/**
 * 確認語句的交辦（純函式）。模型永遠不會被呼叫，所以 agent 沒辦法替使用者確認：
 * - 確認卡在 APPROVAL_WINDOW_MS 內剛結束：這句話就是那張卡的答案（畫面已處理），回 commentary，不重做工具；
 * - 確認卡還開著（交辦比頁面的事件先到）：commentary，答案仍只由畫面處理；
 * - 沒有卡：speakable「目前沒有需要確認的項目」。
 */
export function approvalGuard(text: string, approval: ApprovalSnapshot, now: number): DelegationResult | null {
  if (!matchApproval(text)) return null;
  if (approval.resolvedAt !== null && now - approval.resolvedAt <= APPROVAL_WINDOW_MS) {
    return { ok: true, channel: "commentary", text: "使用者剛用固定語句回答了確認卡，畫面已經處理；結果會用系統通知送來。只簡短回應，不要說已經完成。", tools: [] };
  }
  if (approval.open) {
    return { ok: true, channel: "commentary", text: "確認卡還開著，答案只由畫面處理（使用者按卡片或清楚說「確認執行」或「取消」）；你不能替使用者確認，也不要再交辦一次。", tools: [] };
  }
  return { ok: true, channel: "speakable", text: "目前沒有需要確認的項目。", tools: [] };
}

export interface LiveToolCallerOptions {
  responses: Pick<CodexResponses, "turn">;
  caps: () => RealtimeCapabilities;
  host: ToolHost;
  tasks: () => Task[];
  approval: () => ApprovalSnapshot;
  now?: () => number;
  log?: (line: string) => void;
}

export class LiveToolCaller {
  private readonly now: () => number;

  constructor(private readonly options: LiveToolCallerOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * 1. 確認語句先過 approvalGuard。
   * 2. 最多 maxTurns 輪：responses.turn → 依序執行每個呼叫（host.call）→ function_call_output；最多 maxHostCalls 個呼叫。
   * 3. 最後的文字 → speakable。
   * 4. 超過 DELEGATION_BUDGET_MS：「沒有完成：處理超過時間」；當時有副作用的工具還沒回報 → 「結果不明，請確認」。
   *    用量上限、登入失效照實說；工具逾時以工具自己的輸出交給模型（不會變成成功）。
   */
  async run(request: DelegationRequest, signal: AbortSignal): Promise<DelegationResult> {
    const guarded = approvalGuard(request.text, this.options.approval(), this.now());
    if (guarded) return guarded;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), DELEGATION_BUDGET_MS);
    const combined = AbortSignal.any([signal, budget.signal]);
    const tools: ExecutedTool[] = [];
    /** 有副作用的工具已送出、但還沒有可以轉述的最後一句話：之後的失敗只能說「結果不明」，不能說失敗。 */
    let sideEffectUnsettled = false;
    try {
      const caps = this.options.caps();
      const instructions = buildCallerInstructions(caps, this.options.tasks(), new Date(this.now()));
      const specs = liveCallerTools(caps);
      const allowed = new Set(specs.map((s) => (s.type === "function" ? s.name : "")));
      const input: CodexInputItem[] = [{ role: "user", content: requestText(request) }];
      let hostCalls = 0;
      let ended = false;
      for (let turn = 0; turn < CALLER_LIMITS.maxTurns; turn++) {
        const result = await untilAborted(this.options.responses.turn({ instructions, input, tools: specs, signal: combined }), combined);
        if (!result.calls.length) {
          const text = result.text || (tools.length ? "處理好了，但沒有可以轉述的結果。" : "我沒有聽懂，請再說一次。");
          return ended ? { ok: true, channel: "speakable", text, tools, ended: true } : { ok: true, channel: "speakable", text, tools };
        }
        input.push(...result.replay);
        for (const call of result.calls) {
          let output: Record<string, unknown>;
          const name = call.name as HostToolName;
          if (!HOST_TOOLS.includes(name) || !allowed.has(name)) {
            output = { ok: false, error: `這條路徑沒有這個工具：${call.name}` };
          } else if (hostCalls >= CALLER_LIMITS.maxHostCalls) {
            output = { ok: false, error: `這次交辦的工具呼叫已達上限（${CALLER_LIMITS.maxHostCalls} 次），沒有執行；請使用者再說一次。` };
          } else {
            hostCalls++;
            let args: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(call.arguments || "{}") as unknown;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
            } catch {
              // 參數不是 JSON：交給執行器照常回報缺少參數
            }
            const started = this.now();
            if (SIDE_EFFECT_TOOLS.includes(name)) sideEffectUnsettled = true;
            output = await untilAborted(this.options.host.call(name, args, combined), combined);
            tools.push({ name, ok: output.ok !== false, ms: this.now() - started });
            this.options.log?.(`即時語音（ChatGPT 方案）：工具 ${name} ${output.status === "unknown" ? "結果不明" : output.ok === false ? "失敗" : "完成"}`);
            if (name === "end_conversation") ended = true;
          }
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
        }
      }
      if (sideEffectUnsettled) return { ok: false, channel: "speakable", text: `${RESULT_UNKNOWN_TEXT}。`, reason: "unknown", tools };
      return { ok: false, channel: "speakable", text: "沒有完成：處理步驟超過上限，請再說一次。", reason: "upstream", tools };
    } catch (err) {
      if (signal.aborted) return { ok: false, channel: "speakable", text: "即時語音已結束，這次交辦沒有完成。", reason: "closed", tools };
      if (budget.signal.aborted || (err instanceof CodexError && err.failure.kind === "aborted")) {
        if (sideEffectUnsettled) return { ok: false, channel: "speakable", text: `${RESULT_UNKNOWN_TEXT}。`, reason: "unknown", tools };
        return { ok: false, channel: "speakable", text: `沒有完成：處理超過時間（${Math.round(DELEGATION_BUDGET_MS / 1000)} 秒）。`, reason: "timeout", tools };
      }
      if (err instanceof HostGone) return { ok: false, channel: "speakable", text: sideEffectUnsettled ? `${RESULT_UNKNOWN_TEXT}。` : "沒有完成：畫面已離開。", reason: sideEffectUnsettled ? "unknown" : "closed", tools };
      if (err instanceof CodexError) {
        const failure = err.failure;
        // 有副作用的指令已經送出：不管之後哪裡失敗，都不能說沒做。
        if (sideEffectUnsettled) return { ok: false, channel: "speakable", text: `${RESULT_UNKNOWN_TEXT}。`, reason: "unknown", tools };
        if (failure.kind === "usage_limit") return { ok: false, channel: "speakable", text: `沒有完成：${err.message}。`, reason: "usage_limit", tools };
        if (failure.kind === "auth") return { ok: false, channel: "speakable", text: "沒有完成：ChatGPT 方案登入已失效，請重新登入。", reason: "auth", tools };
        return { ok: false, channel: "speakable", text: `沒有完成：${err.message}`, reason: failure.kind === "timeout" ? "timeout" : "upstream", tools };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 上限一到就不再等（即使下層沒有回應中止訊號）。 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function requestText(request: DelegationRequest): string {
  const recent = request.transcript.slice(-8).map((t) => `${t.role === "user" ? "使用者" : "Nous"}：${t.text}`);
  return [
    ...(recent.length ? ["最近的對話（裝置回報的逐字稿）：", ...recent, ""] : []),
    request.source === "typed" ? `使用者打字：${request.text}` : `語音模型交辦的請求：${request.text}`,
  ].join("\n");
}
