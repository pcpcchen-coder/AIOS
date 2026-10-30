import type { Locale } from "../shared/i18n.mjs";
import { exactApproval } from "../shared/approval.ts";
import { RESULT_UNKNOWN_TEXT, SIDE_EFFECT_TOOLS, type HostToolName } from "../shared/realtime-route.ts";
import type { Task } from "../shared/types.ts";
import { CodexError, type CodexInputItem, type CodexResponses, type CodexToolSpec, type FunctionToolSpec } from "./codex-responses.ts";
import { buildRealtimeTools, realtimeToolRules, taskLines, type RealtimeCapabilities } from "./realtime.ts";
import { delegatePolicy, exactVoiceConfirm, MAX_RECALLS } from "./memory/live.ts";
import { HOST_TIMEOUT_MS, HostGone, type ApprovalSnapshot, type ToolHost } from "./realtime-routes.ts";

// gpt-live-1-codex 不能呼叫函式；它把使用者的請求用文字交辦（delegation.created）。
// LiveToolCaller 用同一個 Codex 登入的 Codex Responses，把這段文字變成 API key 路徑的語音模型會做的
// 同一組函式呼叫，並且每個呼叫都交給同一個執行器（頁面，經 ToolHost）。它是 live 路徑上
// 「內建函式呼叫」的替代品：不是第二個執行器，也不是第二個背景 agent（背景工作仍是 TaskRunner，經 delegate_task）。

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  /** 看著說話的開場問候（核心送出、模型念出的那一則）：交辦時不附給 Codex（可能含家人的名字，ADR-0001 §2.4.1）。 */
  greeting?: true;
}

export interface DelegationRequest {
  id: string;
  /** delegation.created 的內容，或使用者打的字。 */
  text: string;
  source: "voice" | "typed";
  /** sideband 回報的最近幾輪逐字稿（由舊到新）。 */
  transcript: readonly TranscriptTurn[];
  /**
   * 交辦「排進佇列時」的確認卡狀態與時間（不是輪到它執行時）：前一個交辦跑了很久，
   * 「確認執行」仍依使用者說出它的那一刻判斷。沒有時用執行當下的狀態。
   */
  approval?: ApprovalSnapshot;
  at?: number;
  /**
   * MEM-2：觸發這次交辦的使用者原句（打字：打的字；語音：交辦送到之前 sideband 最近一則還沒對應過交辦的使用者 final 逐字稿）。
   * 帶記憶的通話交辦被封鎖時，交辦卡的標題用它；找不到時是 null（不出卡、請使用者再說一次完整的要求）。
   */
  userText?: string | null;
}

/** 給 log 與驗證用。腦區只由頁面的執行器依實際執行的工具亮起。 */
export interface ExecutedTool {
  name: HostToolName;
  ok: boolean;
  ms: number;
}

/**
 * 交回語音模型的內容。每個交辦都以一則 speakable 結束（同 OpenClaw realtime-quicksilver-delegation-controller.ts
 * runDelegation：成功、失敗都用 speakable 送回該交辦 ID），模型才會把這次交辦說完。
 */
export type DelegationResult =
  | { ok: true; channel: "speakable"; text: string; tools: ExecutedTool[]; ended?: true }
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
export function liveCallerTools(caps: RealtimeCapabilities, locale: Locale = "zh-TW"): CodexToolSpec[] {
  return buildRealtimeTools({ ...caps, mcp: [] }, locale)
    .filter((tool) => tool.type === "function")
    .map((tool) => {
      const t = tool as unknown as FunctionToolSpec;
      return { type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false } satisfies FunctionToolSpec;
    });
}

/** 說明：工具執行層的開頭 ＋ realtimeToolRules(caps)（API key 路徑語音模型拿到的同一段文字）＋ 回覆約定 ＋ 任務 ＋ 日期。 */
export function buildCallerInstructions(caps: RealtimeCapabilities, tasks: Iterable<Task>, now: Date, locale: Locale = "zh-TW"): string {
  const list = taskLines(tasks);
  return [
    "你是 Nous 的工具執行層。即時語音模型沒有工具，會把使用者的請求交給你；你用工具完成，你最後一則訊息會交給語音模型用口語轉述給使用者。",
    ...realtimeToolRules({ ...caps, mcp: [] }),
    "外部服務（MCP）在這條路徑不能用；使用者要求時照實說，需要時請他到設定（macOS App：選單列「即時語音」）把路徑切換到 API key。",
    locale === "en" ? "Final response: one to three sentences in English, reporting only facts returned by tools. Do not mention tool names or JSON." : "最後一則訊息：一到三句繁體中文（台灣用語），只講工具回傳的事實；不要提工具名稱或 JSON。",
    "沒有呼叫工具就不能說做好了；工具失敗照實說；工具回傳 status 是 unknown 時只能說「結果不明，請確認」。",
    ...(caps.memory ? ["保存、更正與忘記記憶由畫面確認卡或使用者說出的確認詞處理；你沒有寫入記憶的工具，不能說已記住或已忘記。"] : []),
    "needs_confirmation：說要對哪台設備做什麼，請使用者按畫面上的確認卡或說「確認執行」；你不能確認。",
    "一般聊天或不需要工具的問題，直接簡短回答，不要呼叫工具。",
    "使用者要結束對話時呼叫 end_conversation，最後一則訊息寫一句道別。",
    `今天日期：${now.toISOString().slice(0, 10)}。`,
    list.length ? `目前的任務：\n${list.join("\n")}` : "目前沒有交辦的任務。",
  ].join("\n");
}

/**
 * 確認語句的交辦（純函式）。只在「整句就是確認或取消」（exactApproval，錨定比對）而且確認卡開著、
 * 或在 APPROVAL_WINDOW_MS 內剛被使用者回答時才攔下；模型與工具都不會被呼叫，所以 agent 沒辦法替使用者確認：
 * - 確認卡剛被回答：這句話就是那張卡的答案（畫面已處理），不重做工具；
 * - 確認卡還開著（交辦比頁面的事件先到）：答案仍只由畫面處理；
 * - 其他情況（沒有卡、句子裡還有別的請求，例如「停止播放音樂」「不用開燈，查一下客廳溫度」）：null，照一般請求交給 Codex。
 * 攔下時回 speakable：每個交辦都要有一句可以說出的結尾。
 */
export function approvalGuard(text: string, approval: ApprovalSnapshot, now: number): DelegationResult | null {
  if (!exactApproval(text)) return null;
  if (approval.resolvedAt !== null && now - approval.resolvedAt <= APPROVAL_WINDOW_MS) {
    return { ok: true, channel: "speakable", text: "畫面已經收到你對確認卡的回答，結果會另外通知。", tools: [] };
  }
  if (approval.open) {
    return { ok: true, channel: "speakable", text: "確認卡的答案由畫面處理，結果會另外通知；我不能替你確認。", tools: [] };
  }
  return null;
}

/**
 * MEM-2：這通 live 通話的記憶（server/memory/live.ts 的 LiveMemoryBinding 提供）。
 * blocked：這通已經送過記憶，delegate_task 改成問使用者；recall：recall_memory（唯讀、經 lease.deliver）；
 * delegateBlocked：通知頁面出「要交辦這件事嗎？」卡（標題是 sideband 最近一則使用者原句）。
 */
export interface LiveCallerMemory {
  blocked(): boolean;
  recall(query: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** title：觸發交辦的使用者原句；null 時不出卡。 */
  delegateBlocked(title: string | null): void;
}

/** recall_memory 每次交辦最多呼叫幾次（每次都受 8 筆、4 KB 限制；MEM-3 起定義在 server/memory/live.ts，API key 路徑每一輪也用它）。 */
export { MAX_RECALLS };

/** 記憶確認詞的交辦：核心的語音確認已經處理（server/memory/live.ts），不交給 Codex，也不能由模型替使用者確認。 */
export function memoryConfirmGuard(text: string): DelegationResult | null {
  if (exactVoiceConfirm(text) === null) return null;
  return { ok: true, channel: "speakable", text: "記憶的確認由 Nous 核心處理，結果會另外通知。", tools: [] };
}

export interface LiveToolCallerOptions {
  locale?: Locale;
  /** MEM-2：只有 caps().memory 為 true 時才會用到。 */
  memory?: LiveCallerMemory;
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
    const guarded = approvalGuard(request.text, request.approval ?? this.options.approval(), request.at ?? this.now()) ?? (this.options.memory ? memoryConfirmGuard(request.text) : null);
    if (guarded) return guarded;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), DELEGATION_BUDGET_MS);
    const combined = AbortSignal.any([signal, budget.signal]);
    const tools: ExecutedTool[] = [];
    /** 已經執行的工具與它們的輸出：模型來不及轉述時，照這些輸出說（不把已知的結果說成沒做或不明）。 */
    const executed: { name: HostToolName; output: Record<string, unknown> }[] = [];
    /** 有副作用的工具已送出、還沒有確定的結果（等待中或 status unknown）：之後的失敗只能說「結果不明」，不能說失敗。 */
    const unsettled = new Set<string>();
    const done = () => summarizeOutputs(executed);
    /** 失敗的話；之前已經有確定的工具結果時，先說那些結果。 */
    const failed = (text: string) => (executed.length ? `已經執行：${done()}。不過${text}` : text);
    try {
      const caps = { ...this.options.caps(), memory: !!this.options.memory && !!this.options.caps().memory };
      const memory = caps.memory ? this.options.memory! : null;
      const instructions = buildCallerInstructions(caps, this.options.tasks(), new Date(this.now()), this.options.locale);
      const specs = liveCallerTools(caps, this.options.locale);
      const allowed = new Set(specs.map((s) => (s.type === "function" ? s.name : "")));
      const input: CodexInputItem[] = [{ role: "user", content: requestText(request) }];
      let hostCalls = 0;
      let recalls = 0;
      let ended = false;
      for (let turn = 0; turn < CALLER_LIMITS.maxTurns; turn++) {
        const result = await untilAborted(this.options.responses.turn({ instructions, input, tools: specs, signal: combined }), combined);
        this.options.log?.(`即時語音（ChatGPT 方案）：交辦第 ${turn + 1} 輪（${result.model}）${result.calls.length ? `要呼叫 ${result.calls.map((c) => c.name).join("、")}` : "直接回答，沒有呼叫工具"}`);
        if (!result.calls.length) {
          const text = result.text || (tools.length ? "處理好了，但沒有可以轉述的結果。" : "我沒有聽懂，請再說一次。");
          return ended ? { ok: true, channel: "speakable", text, tools, ended: true } : { ok: true, channel: "speakable", text, tools };
        }
        input.push(...result.replay);
        for (const call of result.calls) {
          let output: Record<string, unknown>;
          const name = call.name as HostToolName;
          if (call.name === "recall_memory" && memory && allowed.has("recall_memory")) {
            // 核心工具（不經頁面）：唯讀，結果經 lease.deliver；撤銷後回 ok:false，不交付舊內容。
            if (recalls >= MAX_RECALLS) output = { ok: false, error: `這次交辦查記憶的次數已達上限（${MAX_RECALLS} 次）。` };
            else {
              recalls++;
              let query = "";
              try {
                const parsed = JSON.parse(call.arguments || "{}") as { query?: unknown };
                query = typeof parsed.query === "string" ? parsed.query : "";
              } catch {
                // 參數不是 JSON：用空查詢（只有釘選的）
              }
              output = await untilAborted(memory.recall(query, combined), combined);
              this.options.log?.(`即時語音（ChatGPT 方案）：recall_memory ${output.ok === false ? "沒有取用" : "完成"}`);
            }
          } else if (name === "delegate_task" && memory && allowed.has(name) && !delegatePolicy("live", memory.blocked(), null).run) {
            // 這通通話帶著記憶：交辦改成問使用者（16 §9、M15；政策集中在 server/memory/live.ts delegatePolicy），不呼叫頁面、TaskStore 不新增。
            const decision = delegatePolicy("live", true, request.userText ?? null);
            const title = decision.run ? null : decision.title;
            memory.delegateBlocked(title);
            output = decision.run ? { ok: false } : decision.output;
            this.options.log?.("即時語音（ChatGPT 方案）：交辦被封鎖（這通用到記憶），改成畫面上的交辦卡");
          } else if (!HOST_TOOLS.includes(name) || !allowed.has(name)) {
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
            const key = `${hostCalls}:${call.call_id}`;
            if (SIDE_EFFECT_TOOLS.includes(name)) unsettled.add(key);
            output = await untilAborted(this.options.host.call(name, args, combined), combined);
            // 確定的結果（成功、失敗、需要確認…）就不再是「不明」；只有 status unknown 仍然不明。
            if (output.status !== "unknown") unsettled.delete(key);
            executed.push({ name, output });
            tools.push({ name, ok: output.ok !== false, ms: this.now() - started });
            this.options.log?.(`即時語音（ChatGPT 方案）：工具 ${name} ${output.status === "unknown" ? "結果不明" : output.ok === false ? "失敗" : "完成"}`);
            if (name === "end_conversation") ended = true;
          }
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
        }
      }
      // 輪數用完、模型沒有說最後一句：照已經執行的工具輸出說，已知的結果不說成沒做或不明。
      if (unsettled.size) return { ok: false, channel: "speakable", text: `${RESULT_UNKNOWN_TEXT}。${executed.length ? `已經回報的結果：${done()}。` : ""}`, reason: "unknown", tools };
      if (executed.length) return { ok: true, channel: "speakable", text: `${done()}。`, tools, ...(ended ? { ended: true as const } : {}) };
      return { ok: false, channel: "speakable", text: "沒有完成：處理步驟超過上限，請再說一次。", reason: "upstream", tools };
    } catch (err) {
      if (signal.aborted) return { ok: false, channel: "speakable", text: "即時語音已結束，這次交辦沒有完成。", reason: "closed", tools };
      const sideEffectUnsettled = unsettled.size > 0;
      if (budget.signal.aborted || (err instanceof CodexError && err.failure.kind === "aborted")) {
        if (sideEffectUnsettled) return { ok: false, channel: "speakable", text: `${RESULT_UNKNOWN_TEXT}。`, reason: "unknown", tools };
        return { ok: false, channel: "speakable", text: failed(`沒有完成：處理超過時間（${Math.round(DELEGATION_BUDGET_MS / 1000)} 秒）。`), reason: "timeout", tools };
      }
      if (err instanceof HostGone) return { ok: false, channel: "speakable", text: sideEffectUnsettled ? `${RESULT_UNKNOWN_TEXT}。` : failed("沒有完成：畫面已離開。"), reason: sideEffectUnsettled ? "unknown" : "closed", tools };
      if (err instanceof CodexError) {
        const failure = err.failure;
        this.options.log?.(`即時語音（ChatGPT 方案）：交辦呼叫 Codex 失敗（${failure.kind}${"status" in failure ? ` ${String(failure.status)}` : ""}）：${err.message}`);
        // 有副作用的指令已經送出、結果不明：不管之後哪裡失敗，都不能說沒做。
        if (sideEffectUnsettled) return { ok: false, channel: "speakable", text: `${RESULT_UNKNOWN_TEXT}。`, reason: "unknown", tools };
        if (failure.kind === "usage_limit") return { ok: false, channel: "speakable", text: failed(`沒有完成：${err.message}。`), reason: "usage_limit", tools };
        if (failure.kind === "auth") return { ok: false, channel: "speakable", text: failed("沒有完成：ChatGPT 方案登入已失效，請重新登入。"), reason: "auth", tools };
        return { ok: false, channel: "speakable", text: failed(`沒有完成：${err.message}`), reason: failure.kind === "timeout" ? "timeout" : "upstream", tools };
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 工具輸出的一句話摘要（只用工具自己回傳的文字，不加油添醋）。 */
export function summarizeOutputs(executed: readonly { name: HostToolName; output: Record<string, unknown> }[]): string {
  return executed
    .map(({ name, output }) => {
      const say = (key: string) => (typeof output[key] === "string" && (output[key] as string).trim() ? (output[key] as string).trim().replace(/[。.]+$/, "") : null);
      if (output.status === "unknown") return RESULT_UNKNOWN_TEXT;
      if (output.ok === false) return `沒有成功：${say("error") ?? say("message") ?? name}`;
      return say("message") ?? say("answer") ?? `${name} 已執行`;
    })
    .join("；");
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

/** 交辦給 Codex 的請求文字：最近 8 則逐字稿（不含開場問候那一則；使用者自己說的話照樣保留）＋這次的請求。 */
export function requestText(request: DelegationRequest): string {
  const recent = request.transcript.filter((t) => !t.greeting).slice(-8).map((t) => `${t.role === "user" ? "使用者" : "Nous"}：${t.text}`);
  return [
    ...(recent.length ? ["最近的對話（裝置回報的逐字稿）：", ...recent, ""] : []),
    request.source === "typed" ? `使用者打字：${request.text}` : `語音模型交辦的請求：${request.text}`,
  ].join("\n");
}
