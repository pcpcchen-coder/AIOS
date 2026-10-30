import { translate } from "../shared/i18n.mjs";
import { parseGaEvent, type GaEvent } from "../shared/realtime-ga.ts";
import { CORE_TOOLS, LIVE_STOP_REPORT_MS, type CoreToolName, type LiveCoreEvent, type LiveMemoryReason } from "../shared/realtime-route.ts";
import { delegatePolicy, MAX_RECALLS, type LiveCallPort, type LiveMemoryPort, type RevokeWhy } from "./memory/live.ts";
import { APIKEY_TIMEOUTS_MS, type RealtimeBridge } from "./realtime.ts";
import { RouteStartError, type RouteCall, type SessionContext } from "./realtime-routes.ts";
import type { SidebandSocket } from "./sideband.ts";

// MEM-3：OpenAI API key 即時語音的記憶（docs/validation/memory-mem3-2026-10-30.md）。
// 核心從 /realtime/calls 回應的 Location 取 call ID，用 API key 開旁路（wss://api.openai.com/v1/realtime?call_id=…），
// 這條旁路是這條路徑記憶的唯一可信控制面：
//  - 只有旁路上的語音辨識逐字稿（conversation.item.input_audio_transcription.completed）算使用者語音；頁面打字或注入的
//    user 文字項目（item_added typed）一律不解析成記憶指令。renderer 的資料通道照舊負責原有的工具、MCP、問候和打字。
//  - 記憶用旁路的 session.update 帶入：先取得 lease（MemoryBoundary.withVoiceContext）、送出、等 session.updated（最多
//    APIKEY_TIMEOUTS_MS.updateAck），之後才把 answer 回給頁面；就算沒等到 ack 也算已帶記憶，撤銷照樣適用。
//  - 旁路連不上：這一通完全不帶記憶（照 16 §8「做不到可靠撤銷的路徑不注入記憶」），照常開始。
//  - 記憶沒開、沒有同意、放行旗標沒開或路徑停用：不開旁路，送出的請求和 MEM-2 之前一個位元組都不差。
//  - 撤銷有兩道停止：renderer 停播回報（POST /api/realtime/stopped，1.5 秒），以及核心 POST /realtime/calls/{id}/hangup。
//    停播回報逾時就強制靜音，並停用這條路徑的記憶到重新啟動。
//  - recall_memory 與 delegate_task 由核心從旁路處理（CORE_TOOLS；頁面略過）；交辦政策集中在 delegatePolicy。
// log 只記事件類型、原因與數字，不記使用者的話、記憶內容或 instructions。

/** 旁路的最近一則使用者語音（used：已經當過某個交辦的原句）。 */
type UserFinal = { text: string; used: boolean };

/** 等待中的回應請求（核心要模型說的一句，或工具結果之後請模型接著說）。eventId：送出時配上的用戶端事件 ID。 */
type Speak = { response: Record<string, unknown> | null; eventId?: string };

/** 等 session.updated 的結果：ok＝已確認；rejected＝上游回了這個 session.update 的錯誤；timeout；lost＝旁路斷了；aborted＝撤銷。 */
export type UpdateOutcome = "ok" | "rejected" | "timeout" | "lost" | "aborted";

export interface ApiKeyCallDeps {
  hangup(callId: string): Promise<boolean>;
  log?: (line: string) => void;
}

/** 核心自己送出的用戶端事件 ID（上游的 error.event_id 會指回它）；頁面的事件沒有這個前綴。 */
const EVENT_PREFIX = "nous_core_";

/** 核心要模型照念的句子 → response.create 的 instructions（只說這一句；系統通知用一句話轉告）。 */
export function speakInstructions(text: string): string {
  const quoted = /^（記憶確認）「([\s\S]*)」$/.exec(text);
  if (quoted) return `只說這一句，一字不改，不加字、不提問：「${quoted[1]}」`;
  return `用一句話轉告使用者，不要逐字念：${text}`;
}

/** 一通帶著記憶規則的 API key 通話（核心旁路）。同時實作 RouteCall（給 RealtimeSessions）與 LiveCallPort（給記憶 binding）。 */
export class ApiKeyCall implements RouteCall, LiveCallPort {
  readonly route = "api_key" as const;
  readonly control = null;
  readonly coreTools: readonly CoreToolName[] = CORE_TOOLS;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly abort = new AbortController();
  private started = false;
  private ended = false;
  private revoked = false;
  private revoking: Promise<void> | null = null;
  /** 更正或忘記 commit 前暫停輸出（旁路的送出先排隊）。 */
  private held = false;
  private readonly heldQueue: Record<string, unknown>[] = [];
  /** 上游正在產生回應（旁路看到 response.created，還沒 response.done）：核心的 response.create 先排隊。 */
  private responding = false;
  /**
   * 核心送出、還沒結束的 response.create（帶自己的 event_id）。只在 response.done 或「指回這個 event_id 的錯誤」時清掉：
   * 頁面自己的回應的 response.created 不能清掉它（否則核心的句子會被丟掉），頁面請求的錯誤也不能讓它重送（否則念兩次）。
   */
  private awaiting: Speak | null = null;
  private eventSeq = 0;
  /** 送出的 session.update 的 event_id（上游拒絕時的錯誤會指回它）。 */
  private updateEventId: string | null = null;
  private updateOutcome: UpdateOutcome | null = null;
  private updateWaiters: ((outcome: UpdateOutcome) => void)[] = [];
  /** input_audio_buffer.committed 看過的項目：只有這些項目的語音辨識逐字稿才算使用者語音。 */
  private readonly committed = new Set<string>();
  private readonly speakQueue: Speak[] = [];
  private lastUserFinal: UserFinal | null = null;
  private recalls = 0;
  /** 問候（頁面送出）之後才問臉部候選：armed＝核心知道要問候了；inflight＝問候那一輪已開始。 */
  private greeting: { named: boolean; phase: "armed" | "inflight" } | null = null;
  private readonly unhandled = new Set<string>();

  constructor(
    readonly answerSdp: string,
    readonly model: string,
    private readonly callId: string,
    private readonly socket: SidebandSocket,
    private readonly ctx: SessionContext,
    private readonly memory: LiveMemoryPort,
    private readonly deps: ApiKeyCallDeps,
  ) {
    this.closed = new Promise<void>((resolve) => (this.resolveClosed = resolve));
    socket.addEventListener("message", (event) => {
      if (this.ended || this.revoked) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const parsed = parseGaEvent(raw);
      if (parsed) this.onEvent(parsed);
      else this.noteUnhandled(raw);
    });
    // 旁路是這條路徑記憶的唯一控制面：斷線就結束這通（掛斷），不假裝重連、不改路徑。
    const lost = () => this.terminate("與 OpenAI 即時語音的核心控制連線中斷，即時語音已結束。");
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
  }

  /** 診斷：沒處理的旁路事件，每種類型只記一次（只記類型）。 */
  private noteUnhandled(raw: unknown): void {
    const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
    if (typeof type !== "string" || /delta$/.test(type) || this.unhandled.has(type)) return;
    this.unhandled.add(type);
    this.deps.log?.(`即時語音（API key）旁路：未處理的事件 ${type.slice(0, 80)}`);
  }

  private onEvent(event: GaEvent): void {
    switch (event.kind) {
      case "session":
        if (event.phase === "updated" && this.updateEventId) this.settleUpdate("ok");
        break;
      case "committed":
        if (event.item_id) {
          this.committed.add(event.item_id);
          if (this.committed.size > 200) this.committed.delete(this.committed.values().next().value!);
        }
        break;
      case "speech_started":
        this.memory.onUserSpeechStart(this.ctx.now());
        break;
      case "user_final":
        // 只有語音辨識的使用者逐字稿（source asr），而且是麥克風緩衝提交出來的項目（committed 看過），才交給記憶。
        if (!event.item_id || !this.committed.has(event.item_id)) {
          this.noteUnhandled({ type: "transcription.completed（未提交的項目，略過）" });
          break;
        }
        if (event.text.trim()) {
          this.lastUserFinal = { text: event.text.trim(), used: false };
          this.recalls = 0;
          this.memory.onUserFinal(event.text, this.ctx.now());
        }
        break;
      case "assistant_final":
        if (event.text.trim()) this.memory.onAssistantFinal(event.text, this.ctx.now());
        break;
      case "item_added":
        // typed／system：頁面打字、通知或背景資料，不是語音，不解析成記憶指令（和 MEM-2 打字不解析一致）。
        // 打字之後，之前的語音原句不再是「觸發交辦的那一句」：交辦卡不顯示過時的原句。
        if (event.source === "typed") this.lastUserFinal = null;
        break;
      case "response":
        if (event.phase === "created") {
          this.responding = true;
          if (this.greeting?.phase === "armed") this.greeting.phase = "inflight";
        } else {
          this.responding = false;
          this.awaiting = null;
          const greeting = this.greeting;
          if (greeting?.phase === "inflight") {
            this.greeting = null;
            this.memory.afterGreeting(greeting.named);
          }
          this.flushSpeak();
        }
        break;
      case "audio":
        if (event.phase === "stopped") this.memory.onAssistantAudioDone(this.ctx.now());
        break;
      case "function_call":
        if ((CORE_TOOLS as readonly string[]).includes(event.name)) void this.coreTool(event.name as CoreToolName, event.call_id, event.arguments);
        break;
      case "error":
        // 只處理指回核心自己事件的錯誤（error.event_id）；頁面請求的錯誤由頁面自己處理。
        if (event.event_id && event.event_id === this.updateEventId) {
          this.deps.log?.(`即時語音（API key）：session.update 被拒絕（${(event.code ?? "").slice(0, 60)}）`);
          this.settleUpdate("rejected");
        } else if (event.event_id && this.awaiting?.eventId === event.event_id) {
          const speak = this.awaiting;
          this.awaiting = null;
          if (event.code && /active_response/.test(event.code)) {
            // 和頁面的回應撞在一起：放回佇列最前面（換新的 event_id），等那一輪結束再送。
            this.speakQueue.unshift({ response: speak.response });
            this.responding = true;
          } else {
            this.deps.log?.(`即時語音（API key）：核心的 response.create 被拒絕（${(event.code ?? "").slice(0, 60)}），不重送`);
            this.flushSpeak();
          }
        } else {
          this.deps.log?.(`即時語音（API key）旁路錯誤：${(event.code ?? "").slice(0, 60)}`);
        }
        break;
    }
  }

  /** 核心處理的工具（recall_memory、delegate_task）：結果經旁路交回，再請模型接著說。 */
  private async coreTool(name: CoreToolName, callId: string, rawArgs: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArgs || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
    } catch {
      // 參數不是 JSON：用空參數
    }
    let output: Record<string, unknown>;
    if (name === "recall_memory") {
      const port = this.memory.callerPort();
      if (!port) output = { ok: false, error: "這次通話沒有記憶。" };
      else if (this.recalls >= MAX_RECALLS) output = { ok: false, error: `這一輪查記憶的次數已達上限（${MAX_RECALLS} 次）。` };
      else {
        this.recalls++;
        output = await port.recall(typeof args.query === "string" ? args.query : "", this.abort.signal);
        this.deps.log?.(`即時語音（API key）：recall_memory ${output.ok === false ? "沒有取用" : "完成"}`);
      }
    } else {
      // 交辦：政策集中在 delegatePolicy；原句是旁路最近一則還沒對應過交辦的使用者語音。
      let title: string | null = null;
      if (this.lastUserFinal && !this.lastUserFinal.used) {
        title = this.lastUserFinal.text;
        this.lastUserFinal.used = true;
      }
      const decision = delegatePolicy("api_key", this.memory.carriesMemory(), title);
      if (!decision.run) {
        this.memory.callerPort()?.delegateBlocked(decision.title);
        output = decision.output;
        this.deps.log?.("即時語音（API key）：交辦被封鎖（這通用到記憶），改成畫面上的交辦卡");
      } else {
        try {
          output = await this.ctx.host.call("delegate_task", args, this.abort.signal);
        } catch {
          // 工作階段已結束或撤銷：不交回任何東西。
          return;
        }
      }
    }
    if (this.ended || this.revoked) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.enqueueSpeak({ response: null });
  }

  /** 一個回應請求：上游還在回應時排隊，這一輪結束再送（一次一個）。 */
  private enqueueSpeak(speak: Speak): void {
    this.speakQueue.push(speak);
    this.flushSpeak();
  }

  private flushSpeak(): void {
    if (this.responding || this.awaiting || this.ended || this.revoked) return;
    const next = this.speakQueue.shift();
    if (!next) return;
    const eventId = this.nextEventId();
    this.awaiting = { ...next, eventId };
    this.send(next.response ? { type: "response.create", event_id: eventId, response: next.response } : { type: "response.create", event_id: eventId });
  }

  private send(event: Record<string, unknown>): void {
    // 撤銷後拒絕所有送出；暫停中（更正、忘記 commit 前）先排隊：commit 失敗、恢復輸出時補送，撤銷時丟掉。
    if (this.ended || this.revoked || this.socket.readyState !== 1) return;
    if (this.held) {
      this.heldQueue.push(event);
      return;
    }
    this.socket.send(JSON.stringify(event));
  }

  private nextEventId(): string {
    return `${EVENT_PREFIX}${++this.eventSeq}`;
  }

  /** 連線時：送出記憶的 session.update（server/realtime.ts memorySessionUpdate），配上自己的 event_id。 */
  sendSessionUpdate(update: Record<string, unknown>): void {
    this.updateEventId = this.nextEventId();
    this.send({ ...update, event_id: this.updateEventId });
  }

  private settleUpdate(outcome: UpdateOutcome): void {
    if (this.updateOutcome) return;
    this.updateOutcome = outcome;
    for (const waiter of this.updateWaiters.splice(0)) waiter(outcome);
  }

  /** 等 session.update 的結果（ok／rejected／timeout／lost／aborted）。 */
  waitUpdated(timeoutMs: number, signal: AbortSignal | null): Promise<UpdateOutcome> {
    if (this.updateOutcome) return Promise.resolve(this.updateOutcome);
    return new Promise((resolve) => {
      const done = (outcome: UpdateOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.updateWaiters = this.updateWaiters.filter((w) => w !== done);
        resolve(outcome);
      };
      const onAbort = () => done("aborted");
      const timer = setTimeout(() => done("timeout"), timeoutMs);
      timer.unref?.();
      if (signal?.aborted) return done("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.updateWaiters.push(done);
    });
  }

  /** answer 回給頁面之前：記成已開始，告訴頁面這通的記憶狀態；重建的新通話記下頁面要念的固定句（回音判斷用）。 */
  markStarted(): void {
    if (this.started || this.ended) return;
    this.started = true;
    this.memory.started();
    if (this.ctx.rebuild) this.memory.expectSpoken(translate("好，已經更新了。", this.ctx.locale));
  }

  /** IdentityService 的 api_key 問候決策：頁面接著會送問候，問候那一輪結束後才問臉部候選（只有稱名過，問句才帶名字）。 */
  greetingDecided(named: boolean): void {
    if (this.ended || this.revoked) return;
    this.greeting = { named, phase: "armed" };
  }

  /** 頁面在資料通道收到 output_audio_buffer.stopped 後補報（POST /api/realtime/playback）：只會把確認時窗往後延。 */
  playback(): void {
    if (this.ended || this.revoked) return;
    this.memory.onAssistantAudioDone(this.ctx.now());
  }

  /** 這通的記憶狀態（/call 回應用）：只有筆數與原因代碼。 */
  memoryStatus(): { used: number; reason: LiveMemoryReason | null } {
    return { used: this.memory.usedFacts, reason: this.memory.reason };
  }

  // ─────────────── LiveCallPort ───────────────

  get active(): boolean {
    return this.started && !this.ended && !this.revoked;
  }

  /** speakable：請模型照念一句（排隊到沒有進行中的回應）；commentary：system 對話項目，不觸發回應。 */
  inject(channel: "speakable" | "commentary", text: string): void {
    if (channel === "commentary") {
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
      return;
    }
    this.enqueueSpeak({ response: { instructions: speakInstructions(text) } });
  }

  emit(event: LiveCoreEvent): void {
    if (this.ended || this.revoked) return;
    this.ctx.emit(event);
  }

  hold(active: boolean): void {
    if (this.ended || this.revoked || this.held === active) return;
    this.held = active;
    this.ctx.emit({ kind: "hold", active });
    if (!active) for (const event of this.heldQueue.splice(0)) this.send(event);
  }

  /**
   * 記憶撤銷的 cleanup（16 §8；MemoryBoundary 在 LIVE_CLEANUP_MS 內等它）：
   * 1. 同步擋住核心這邊的輸出：revoked（send 拒絕所有送出）、abort（recall 與 ToolHost 等待中的呼叫中止）。
   * 2. 通知擁有者頁面 closed{memory_revoked, rebuild}；RealtimeSessions 記下撤銷（晚到的 host-result 回 accepted:false），結束工作階段。
   * 3. 核心 POST /realtime/calls/{id}/hangup（第二道停止，不等結果，最多 1 秒），然後關旁路。
   * 4. 清掉逐字稿、佇列與問候狀態：這通從此作廢。
   * 5. 等頁面回報停播（最多 LIVE_STOP_REPORT_MS）；主視窗導覽或 renderer 結束（closed）時頁面已經不在，不等。
   * 6. 逾時：強制靜音、reject（boundary 因而停用這條路徑），回條分開說停播未確認。
   */
  revokeMemory(why: RevokeWhy, rebuild: boolean): Promise<void> {
    this.revoking ??= (async () => {
      if (this.ended) return;
      // 握手中（answer 還沒交給頁面）被撤銷：頁面沒有媒體，只要掛斷；不送 closed、不等停播回報、不強制靜音（connectApiKey 回 409）。
      if (!this.started) {
        this.revoked = true;
        this.abort.abort();
        this.settleUpdate("aborted");
        this.deps.log?.(`即時語音（API key）：握手中記憶已撤銷（${why}），掛斷`);
        void this.deps.hangup(this.callId);
        await this.close("ended");
        return;
      }
      this.revoked = true;
      this.abort.abort();
      this.deps.log?.(`即時語音（API key）：記憶已撤銷（${why}），${rebuild ? "重建新通話" : "結束通話"}`);
      const message = why === "os_lock" ? "即時語音已結束（電腦已鎖定）" : rebuild ? "記憶已更新，對話已重新開始" : "即時語音已結束（記憶已更新）";
      this.ctx.emit({ kind: "closed", reason: "memory_revoked", message, rebuild });
      void this.deps.hangup(this.callId).then((ok) => this.deps.log?.(`即時語音（API key）：hangup ${ok ? "已接受" : "沒有成功"}`));
      await this.close("ended");
      this.lastUserFinal = null;
      this.speakQueue.length = 0;
      this.heldQueue.length = 0;
      this.greeting = null;
      if (why === "closed" || !this.ctx.stopped) return;
      const report = await this.ctx.stopped(LIVE_STOP_REPORT_MS);
      if (report) {
        this.deps.log?.(`即時語音（API key）：頁面已停播（${report.ms} ms）`);
        return;
      }
      this.ctx.forceSilence?.(why === "updated" ? "資料已刪除或更正，但即時語音停止未確認；這條路徑的記憶已停用" : "即時語音停止未確認；這條路徑的記憶已停用");
      this.deps.log?.(`即時語音（API key）：${LIVE_STOP_REPORT_MS} ms 內沒有停播回報，已強制靜音並停用這條路徑的記憶`);
      throw new Error("stop_unconfirmed");
    })();
    return this.revoking;
  }

  /** 旁路斷線：通知頁面、掛斷，工作階段跟著結束。握手中（還沒開始）斷線不送 closed，connectApiKey 照實回錯誤。 */
  private terminate(message: string): void {
    if (this.ended || this.revoked) return;
    this.deps.log?.(`即時語音（API key）：旁路中斷，${this.started ? "結束通話" : "這次沒有開始"}`);
    this.settleUpdate("lost");
    if (this.started) this.ctx.emit({ kind: "closed", reason: "connection_lost", message });
    void this.deps.hangup(this.callId);
    void this.close("ended");
  }

  async close(reason: "ended" | "page_gone" | "fallback"): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.abort.abort();
    this.settleUpdate("lost");
    // 頁面已不在：媒體跟著頁面結束，但也掛斷，避免沒人服務的通話留著。
    if (reason === "page_gone") void this.deps.hangup(this.callId);
    try {
      this.socket.close();
    } catch {
      // 已關閉
    }
    this.memory.close();
    this.resolveClosed();
  }
}

/** ApiKeyRoute 用到的 RealtimeBridge 方法（測試可以換成假的）。 */
export type ApiKeyBridge = Pick<RealtimeBridge, "connect" | "openSideband" | "hangup" | "memorySessionUpdate">;

/** 沒有旁路的通話（記憶沒開、沒有同意、放行旗標沒開、路徑停用，或旁路接不上）：和 MEM-2 之前一樣，close 沒有事要做。 */
export function plainApiKeyCall(answer: { sdp: string; model: string }, memory: { used: number; reason: LiveMemoryReason | null } | null): RouteCall {
  return { route: "api_key", answerSdp: answer.sdp, model: answer.model, control: null, coreTools: [], memoryStatus: () => memory, close: async () => {} };
}

const revokedError = () => new RouteStartError("api_key_rejected", 409, "記憶在連線期間更新了，這次即時語音沒有開始；請再開始一次。", false);
/** session.update 被拒絕或沒有在時限內確認：晚到的更新仍可能生效，所以掛斷而不是只關旁路，照實說沒有開始。 */
const unconfirmedError = () => new RouteStartError("api_key_rejected", 409, "記憶設定沒有被即時語音確認，這次沒有開始；請再開始一次。", false);
const lostError = () => new RouteStartError("api_key_rejected", 502, "與 OpenAI 即時語音的核心控制連線在連線期間中斷，這次沒有開始；請再開始一次。", false);

export interface ConnectApiKeyOptions {
  log?: (line: string) => void;
  /** 等 session.updated 的時限（預設 APIKEY_TIMEOUTS_MS.updateAck；測試用）。 */
  updateAckMs?: number;
}

/**
 * API key 路徑的連線（MEM-3）。memory 為 null（瀏覽器版、沒有 SSE 串流）時和 MEM-2 之前完全一樣。
 * 有記憶 binding 時由 binding.connect 決定：
 *  - 記憶沒開、沒有同意、放行旗標沒開或路徑停用（active false）：不開旁路，請求和 MEM-2 之前一樣；
 *  - 帶記憶規則：換 client secret（請求不變）→ /calls（取 Location 的 call ID）→ 開旁路 → session.update → 等 ack → 回 answer。
 *    有釘選記憶時整段在 lease 裡（binding.connect 先取得 lease），握手中被撤銷就中止請求、掛斷，回 409；
 *    session.update 被拒絕（error.event_id 指回它）或沒有在時限內確認：掛斷、回 409（不只關旁路：晚到的更新仍可能生效）；
 *    等待期間旁路斷了：掛斷、回 502；
 *  - 沒有 call ID 或旁路接不上：binding.noControl()，這通完全不帶記憶、照常開始。
 */
export async function connectApiKey(bridge: ApiKeyBridge, offerSdp: string, ctx: SessionContext, memory: LiveMemoryPort | null, options: ConnectApiKeyOptions = {}): Promise<RouteCall> {
  const log = options.log;
  if (!memory) {
    const answer = await bridge.connect(offerSdp, ctx.tasks(), ctx.locale);
    return plainApiKeyCall(answer, null);
  }
  try {
    return await memory.connect(async (block, signal, active) => {
      if (!active) {
        const answer = await bridge.connect(offerSdp, ctx.tasks(), ctx.locale);
        memory.close();
        return { ...plainApiKeyCall(answer, { used: 0, reason: memory.reason }), closed: Promise.resolve() };
      }
      let answer: Awaited<ReturnType<ApiKeyBridge["connect"]>>;
      try {
        answer = await bridge.connect(offerSdp, ctx.tasks(), ctx.locale, signal ?? undefined);
      } catch (err) {
        if (signal?.aborted) throw revokedError();
        throw err;
      }
      if (signal?.aborted) {
        if (answer.callId) void bridge.hangup(answer.callId);
        throw revokedError();
      }
      const noControl = (why: string) => {
        log?.(`即時語音（API key）：${why}，這通不帶記憶`);
        memory.noControl();
        memory.close();
        return { ...plainApiKeyCall(answer, { used: 0, reason: "no_control" }), closed: Promise.resolve() };
      };
      if (!answer.callId) return noControl("回應沒有 call ID");
      let socket: SidebandSocket;
      try {
        socket = await bridge.openSideband(answer.callId, signal);
      } catch {
        if (signal?.aborted) {
          void bridge.hangup(answer.callId);
          throw revokedError();
        }
        return noControl("旁路接不上");
      }
      const call = new ApiKeyCall(answer.sdp, answer.model, answer.callId, socket, ctx, memory, { hangup: (id) => bridge.hangup(id), log });
      memory.bind(call);
      call.sendSessionUpdate(bridge.memorySessionUpdate(ctx.tasks(), ctx.locale ?? "zh-TW", block));
      const outcome = await call.waitUpdated(options.updateAckMs ?? APIKEY_TIMEOUTS_MS.updateAck, signal);
      if (outcome !== "ok" || signal?.aborted) {
        void bridge.hangup(answer.callId);
        await call.close("ended");
        if (signal?.aborted || outcome === "aborted") throw revokedError();
        log?.(`即時語音（API key）：session.update ${outcome === "rejected" ? "被拒絕" : outcome === "timeout" ? "沒有在時限內確認" : "等待期間旁路中斷"}，已掛斷，這次沒有開始`);
        throw outcome === "lost" ? lostError() : unconfirmedError();
      }
      log?.(`即時語音（API key）：旁路已接上，記憶規則已確認${block ? "（含釘選記憶）" : ""}`);
      call.markStarted();
      return call;
    });
  } catch (err) {
    memory.close();
    throw err;
  }
}
