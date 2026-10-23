import { homeControlNotice } from "../shared/home.ts";
import { matchApproval } from "../shared/approval.ts";
import type { ApprovalReport } from "../shared/realtime-route.ts";
import type { ApprovalOutcome, ApprovalRequest, HomeResult, RealtimeCallbacks } from "./realtime.ts";

// 兩條即時語音路徑共用的工具執行器與確認卡佇列，從 RealtimeVoice（src/realtime.ts）原樣搬出：
//   API key：RealtimeVoice 收到 response.function_call_arguments.done → executeRealtimeTool → function_call_output
//   ChatGPT 方案：LiveVoice 收到核心的 realtime.host → executeRealtimeTool → POST /api/realtime/host-result
// 所以交辦任務、進度、結果畫面、字幕、腦區光脈衝、確認卡與 busy 在兩條路徑上是同一段程式（George 的要求 2）。
// tests/realtime-voice.test.ts 是回歸門檻，沒有修改。

/** 路徑接到共用佇列的地方。 */
export interface ApprovalSink {
  /** 工作階段的世代；換了（關閉、重開）就丟掉遲到的結果。 */
  generation(): number;
  /** 系統通知：請模型用一句話轉告。 */
  notify(text: string): void;
  /** 背景資訊，不要求回應。 */
  addContext(text: string): void;
  resetIdle(): void;
  /** 開著或排隊中的卡（家電、MCP）數量改變：閒置計時由路徑自己管。 */
  pendingChanged(kind: "home" | "mcp", delta: 1 | -1): void;
  /** 只有 API key 路徑：在資料通道送出 mcp_approval_response。 */
  sendMcpApproval?(request: Extract<ApprovalRequest, { kind: "mcp" }>, approve: boolean, reason: string): void;
  /** 只有 API key 路徑：MCP 確認結束後的回應排程。 */
  mcpResolved?(outcome: ApprovalOutcome): void;
  /** 只有 ChatGPT 方案路徑：告訴核心確認卡打開（帶卡片時限）或結束（帶結果），核心據此判斷「確認執行」的交辦。 */
  cardChanged?(report: ApprovalReport): void;
}

/** 一個佇列、一次一張卡、同一套固定語句；答案依 kind 交給 OpenAI（MCP）或本機核心（家電）。 */
export class ApprovalQueue {
  private approvalQueue: ApprovalRequest[] = [];
  private approval: { request: ApprovalRequest; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly callbacks: RealtimeCallbacks,
    private readonly sink: ApprovalSink,
    private readonly approvalMs: number,
  ) {}

  get current(): ApprovalRequest | null {
    return this.approval?.request ?? null;
  }

  /** 有卡開著或排隊：家電卡不排隊（busy）的條件。 */
  get occupied(): boolean {
    return !!this.approval || this.approvalQueue.length > 0;
  }

  /** 排進確認卡佇列；確認前 OpenAI 端（MCP）或本機核心（家電）都不會執行這個動作。 */
  queue(request: ApprovalRequest): void {
    this.sink.pendingChanged(request.kind, 1);
    this.approvalQueue.push(request);
    if (!this.approval) this.showNext();
  }

  private showNext(): void {
    const request = this.approvalQueue.shift();
    if (!request) return;
    // 家電卡不超過伺服器端確認 ID 的期限：卡上還有時間時，同意一定還有效。
    const ms = Math.min(this.approvalMs, request.kind === "home" ? Math.max(0, request.expiresAt - Date.now()) : Infinity);
    const timer = setTimeout(() => this.resolve(false, "timeout"), ms);
    this.approval = { request, timer };
    this.sink.cardChanged?.({ state: "open", timeout_ms: ms });
    this.callbacks.onApprovalPrompt(request, Date.now() + ms);
    // 家電卡不用另外請模型說明：needs_confirmation 的工具結果已經請它說了。
    if (request.kind === "mcp") this.sink.notify(
      `外部服務「${request.server}」要執行「${request.name}」，需要使用者確認。請用一句話說明要做什麼、對象和影響，並請使用者說「確認執行」或「取消」。不要替使用者確認。`,
    );
  }

  /** 使用者說的話（或打的字）是否為確認卡的固定語句。 */
  check(text: string): void {
    if (!this.approval) return;
    const decision = matchApproval(text);
    if (decision) this.resolve(decision === "approve", decision === "approve" ? "said_approve" : "said_reject");
  }

  /** 結束目前的確認卡；畫面被收起時由呼叫端以 dismissed 拒絕。 */
  resolve(approve: boolean, outcome: ApprovalOutcome): void {
    const current = this.approval;
    if (!current) return;
    clearTimeout(current.timer);
    this.approval = null;
    this.sink.cardChanged?.({ state: "resolved", outcome });
    const { request } = current;
    const reason = outcome === "timeout" ? "使用者沒有在時限內確認" : outcome === "dismissed" ? "使用者收起了確認畫面" : "使用者說取消";
    if (request.kind === "home") {
      this.answerHome(request, approve, outcome);
      this.callbacks.onApprovalResolved(request, approve, outcome);
      this.showNext();
      return;
    }
    this.sink.sendMcpApproval?.(request, approve, reason);
    this.callbacks.onApprovalResolved(request, approve, outcome);
    this.callbacks.onToolActivity(approve ? `已確認：${request.server} · ${request.name}` : `沒有執行：${request.server} · ${request.name}（${reason}）`);
    this.sink.mcpResolved?.(outcome);
    this.showNext();
  }

  /**
   * 家電確認卡的答案交給本機核心；不碰工具計數（工具呼叫早已交回）。
   * 結果用系統通知轉告；說「取消」的那一輪模型已經在回應，只補上背景資訊，不另外要求回應。
   * 對話已結束時不通知（字幕由呼叫端顯示）。
   */
  private answerHome(request: Extract<ApprovalRequest, { kind: "home" }>, approve: boolean, outcome: ApprovalOutcome): void {
    const generation = this.sink.generation();
    const settle = (result: HomeResult) => {
      if (generation !== this.sink.generation()) return;
      this.sink.pendingChanged("home", -1);
      this.sink.resetIdle();
      const text = result.ok ? homeControlNotice(result) : `家電指令出錯：${result.error}`;
      if (outcome === "said_reject") this.sink.addContext(`（系統）${text}`);
      else this.sink.notify(text);
    };
    this.callbacks.onHomeConfirm(request.id, approve).then(settle, (err: unknown) => settle({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }

  /** 工作階段結束：每張開著或排隊的卡都以 closed 結束；家電卡請本機核心忘掉。 */
  clear(): void {
    const open = [...(this.approval ? [this.approval.request] : []), ...this.approvalQueue];
    if (this.approval) clearTimeout(this.approval.timer);
    this.approval = null;
    this.approvalQueue = [];
    for (const request of open) {
      this.callbacks.onApprovalResolved(request, false, "closed");
      // 讓本機核心忘掉這張卡；generation 已經換了，結果不會再通知。
      if (request.kind === "home") this.answerHome(request, false, "closed");
    }
  }
}

export interface ToolContext {
  callbacks: RealtimeCallbacks;
  approvals: ApprovalQueue;
  /** 呼叫當下的世代。 */
  generation: number;
  stale(generation: number): boolean;
  /** end_conversation：同步處理（道別已在同一輪回覆中）。 */
  end(): void;
  /** 工具的結果；路徑決定怎麼交回模型（資料通道或核心）。 */
  deliver(output: Record<string, unknown>): void;
}

/**
 * 驗證參數、呼叫既有的 callbacks（onDelegate、onWebSearch、onHomeStatus、onHomeControl、onGetTasks），
 * 並透過 approvals 套用 needs_confirmation → 確認卡／busy 的規則。分支與搬出前的 runTool 完全相同。
 */
export async function executeRealtimeTool(name: string, rawArgs: string, ctx: ToolContext): Promise<void> {
  const { callbacks, approvals, generation } = ctx;
  let output: Record<string, unknown>;
  try {
    const args = JSON.parse(rawArgs || "{}") as { title?: unknown; query?: unknown; target?: unknown; metric?: unknown; command?: unknown; value?: unknown };
    if (name === "end_conversation") {
      ctx.end();
      return;
    }
    if (name === "delegate_task") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      output = title ? await callbacks.onDelegate(title) : { ok: false, error: "缺少任務描述" };
    } else if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        output = { ok: false, error: "缺少查詢內容" };
      } else {
        callbacks.onToolActivity(`上網查詢：${query}`);
        output = await callbacks.onWebSearch(query);
      }
    } else if (name === "home_status") {
      const target = typeof args.target === "string" ? args.target.trim() : "";
      const metric = typeof args.metric === "string" && args.metric.trim() ? args.metric.trim() : null;
      if (!target) {
        output = { ok: false, error: "缺少要查的房間或設備" };
      } else {
        callbacks.onToolActivity(`查詢家裡：${target}`);
        output = await callbacks.onHomeStatus(target, metric);
      }
    } else if (name === "home_control") {
      const target = typeof args.target === "string" ? args.target.trim() : "";
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const value = typeof args.value === "string" || typeof args.value === "number" || typeof args.value === "boolean" ? args.value : null;
      if (!target || !command) {
        output = { ok: false, error: "缺少要控制的設備或動作" };
      } else {
        const result = await callbacks.onHomeControl({ target, command, value });
        output = result;
        if (result.ok && result.status === "needs_confirmation") {
          if (ctx.stale(generation) || approvals.occupied) {
            // 已經有確認卡開著或排隊：家電卡不排隊（說出的「確認執行」會被算到前一張卡），請本機核心丟掉這張。
            void callbacks.onHomeConfirm(result.confirm_id, false).catch(() => undefined);
            output = { ok: true, status: "busy", device: result.device, room: result.room, action: result.action, message: "另一張確認卡還沒處理完，這個家電指令沒有送出；等那張確認或取消之後，再請使用者說一次。" };
            if (!ctx.stale(generation)) callbacks.onToolActivity(`沒有送出：另一張確認卡還開著（${result.device} ${result.action}）`);
          } else {
            // 先排好確認卡再交回結果：模型請使用者確認時，說出的「確認執行」已經有卡可以比對。
            const expiresAt = Date.now() + Math.max(0, result.expires_in_s) * 1000;
            approvals.queue({ kind: "home", id: result.confirm_id, device: result.device, room: result.room, action: result.action, expiresAt });
          }
        }
      }
    } else if (name === "get_tasks") {
      output = await callbacks.onGetTasks();
    } else {
      output = { ok: false, error: `未知的工具：${name}` };
    }
  } catch (err) {
    output = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  ctx.deliver(output);
}
