import type { HomeControlResult } from "../shared/home.ts";
import { RESULT_UNKNOWN_TEXT, type ApprovalReport, type HostCall, type LiveCoreEvent, type StopEvidence } from "../shared/realtime-route.ts";
import type { HomeControlArgs } from "./api.ts";
import { CONNECTING_SPEECH_HINT, EARLY_SPEECH_RMS, EarlySpeech, earlySpeechLogLine } from "./early-speech.ts";
import { GREETING_SETTLE_MS, type GreetingOnce } from "./realtime-session.ts";
import { ApprovalQueue, executeRealtimeTool } from "./realtime-tools.ts";

// 即時語音模式（OpenAI Realtime）：像 ChatGPT 語音模式，語音直接對語音。
// 麥克風音訊經 WebRTC 串流到 OpenAI，由伺服器端 VAD 判斷你何時說完；你一開口，
// 正在播放的回覆就會被 OpenAI 截斷（插話）。SDP 交換經本機核心，API key 不進瀏覽器。
// 上網查詢、交辦工作與查進度用 function calling：查詢經本機核心代為呼叫 web_search，
// 交辦與進度呼叫既有的任務 API，任務仍用目前選擇的引擎執行。
// 設定了遠端 MCP 伺服器時，由 OpenAI 端直接呼叫；需要核准的動作顯示確認卡，
// 使用者說出固定語句（「確認執行」或「取消」）才回覆 OpenAI，不需要按任何東西。
// 家電控制（home_control）由本機核心執行；設為需要確認的設備用同一張確認卡，答案交給本機核心，不經 OpenAI。
// 這是 API key 路徑的頁面模組；工具執行與確認卡在 src/realtime-tools.ts，ChatGPT 方案路徑（src/live-voice.ts）共用同一份。
// MEM-3：記憶開著時，記憶的控制面是核心的旁路（server/apikey-call.ts），不是這個頁面：
//  - 核心處理的工具（coreTools：recall_memory、delegate_task）在資料通道上一律略過，不計入 pendingTools；
//  - 核心經 SSE 送來工具呼叫（realtime.host，例如還沒帶記憶時的交辦）與記憶事件（realtime.live）；
//  - 撤銷時（closed{memory_revoked}）可靠停播並回報（POST /api/realtime/stopped），和 LiveVoice.revoke 同樣的順序；
//  - session.*、system 角色項目只看 type：不存、不記 log、不經 SSE 或 HTTP 轉出（上游可能把 instructions 與記憶區塊回送到資料通道）。

export type RealtimePhase = "off" | "connecting" | "listening" | "hearing" | "thinking" | "speaking";

export interface RealtimeCallbacks {
  onPhase(phase: RealtimePhase): void;
  onUserTranscript(text: string): void;
  onAssistantTranscript(text: string): void;
  /** 模型決定交辦工作；回傳的內容會交還給模型，讓它用一句話告訴使用者。 */
  onDelegate(title: string): Promise<Record<string, unknown>>;
  onGetTasks(): Promise<Record<string, unknown>>;
  /** 模型要上網查詢；回傳答案與來源，交還給模型。 */
  onWebSearch(query: string): Promise<Record<string, unknown>>;
  /** 模型要查家電狀態（唯讀）；回傳中控的真實讀值，交還給模型。 */
  onHomeStatus(target: string, metric: string | null): Promise<Record<string, unknown>>;
  /** 模型要控制一台家電；回傳中控的真實結果（或需要確認），交還給模型。 */
  onHomeControl(args: HomeControlArgs): Promise<HomeResult>;
  /** 家電確認卡結束（每種結果都會呼叫，不同意時本機核心也要忘掉這張卡）。 */
  onHomeConfirm(confirmId: string, approve: boolean): Promise<HomeResult>;
  /** 需要確認（MCP 工具或家電）：顯示確認卡，等使用者說「確認執行」或「取消」。 */
  onApprovalPrompt(request: ApprovalRequest, expiresAt: number): void;
  /** 確認卡結束：同意、拒絕、逾時、畫面被收起或對話結束。 */
  onApprovalResolved(request: ApprovalRequest, approved: boolean, outcome: ApprovalOutcome): void;
  /** 工具活動的短說明（例如「上網查詢：新竹天氣」），顯示在字幕。 */
  onToolActivity(text: string): void;
  /** 模式因錯誤或閒置而關閉。 */
  onClosed(reason: string): void;
}

export type ApprovalOutcome = "said_approve" | "said_reject" | "timeout" | "dismissed" | "closed";

export type HomeResult = HomeControlResult | { ok: false; error: string };

/** 一個佇列、一次一張卡、同一套固定語句；答案依 kind 交給 OpenAI（MCP）或本機核心（家電）。 */
export type ApprovalRequest =
  | { kind: "mcp"; id: string; server: string; name: string; arguments: string }
  | { kind: "home"; id: string; device: string; room: string | null; action: string; /** 伺服器端確認 ID 失效的時間（毫秒）。 */ expiresAt: number };

/** 可替換的瀏覽器能力，方便在測試中模擬。 */
export interface RealtimeDeps {
  getMicrophone(): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  playRemote(stream: MediaStream): () => void;
  /** 把 SDP offer 交給本機核心，取回 OpenAI 的 SDP answer。 */
  exchange(offerSdp: string): Promise<string>;
  /**
   * F2／F10：本機麥克風音量（AnalyserNode RMS）。只在連線中與問候送出前用來判斷使用者是不是已經開口；
   * 不保存、不轉送聲音。沒有提供時（舊的測試、沒有 AudioContext）不偵測。回傳停止。
   */
  watchLevel?(stream: MediaStream, onLevel: (rms: number) => void): () => void;
  /** MEM-3：經 /api/realtime/start 決定的工作階段才有（核心的事件、工具呼叫、停播回報）；沒有時行為和 MEM-2 之前一樣。 */
  core?: RealtimeCoreDeps;
}

/** MEM-3：API key 路徑和核心之間的接縫（同 LiveDeps 的對應成員）。 */
export interface RealtimeCoreDeps {
  /** 只收這個工作階段的 SSE realtime.host／realtime.live。回傳取消訂閱。 */
  subscribe(handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void }): () => void;
  hostResult(callId: string, output: Record<string, unknown>): Promise<void>;
  /** POST /api/realtime/approval（確認卡開著時核心不開語音記憶卡，「取消」留給那張卡）。 */
  approval(report: ApprovalReport): Promise<void>;
  /** POST /api/realtime/stopped；回傳核心是否採用。 */
  stopped(evidence: StopEvidence): Promise<boolean>;
  /** POST /api/realtime/playback：資料通道收到播放結束（只會把語音確認時窗往後延）。 */
  playback(): Promise<void>;
  /** 播放靜音（核心要求暫停、撤銷時）。 */
  setMuted(muted: boolean): void;
  /** 播放元素在停播後是不是已暫停（核對用）。 */
  audioPaused(): boolean;
  /** 取消瀏覽器語音合成。 */
  cancelSpeech(): void;
  /** 說出結束原因（瀏覽器語音合成）。 */
  speak(text: string): void;
  /** F7：POST /api/realtime/stop-reply：手掌停止，核心旁路上這一輪還沒回來的工具結果不再請模型念出。 */
  stopReply?(): Promise<void>;
  /** 記憶事件（狀態、卡片 ID、固定句提示、交辦封鎖）交給主程式顯示；內容由主程式經 IPC 取得。 */
  memoryEvent(event: Extract<LiveCoreEvent, { kind: "memory" | "memory_card" | "memory_notice" | "delegate_blocked" | "delegate_card" | "delegated" }>): void;
  /** 停播並回報之後：顯示原因、清掉字幕與卡片；rebuild 而且核心採用了回報時主程式開一通新的（只一次）。 */
  revoked(message: string, rebuild: boolean, accepted: boolean): void;
  /** 核心處理、頁面略過的工具（POST /api/realtime/call 的回應帶來，整通固定）。 */
  coreTools(): readonly string[];
}

/** MEM-3：重建的新通話第一句（固定、不含任何記憶內容；核心把它記進回音清單）。 */
export const REBUILD_LINE = "好，已經更新了。";

interface RealtimeOptions {
  /** 多久沒有任何說話就自動結束（毫秒），避免忘記關而持續計費；之後可用 setIdleMs 改。 */
  idleMs: number;
  /** 確認卡多久沒回應就自動取消（毫秒），預設 60 秒。 */
  approvalMs?: number;
  /**
   * 看著說話開始的工作階段：session.created 之後再等 GREETING_SETTLE_MS，請模型先說一句招呼（response.create 帶這一輪的 instructions，
   * 不加假的使用者訊息）。使用者先開口或打字就不打；改路徑時共用同一個物件，最多一次。
   */
  greeting?: GreetingOnce | null;
  /** MEM-3：記憶撤銷後自動重建的通話：session.created 之後第一句是固定句（REBUILD_LINE），不問候。 */
  rebuild?: boolean;
  /** 重建固定句的語言版本（預設繁中原文）。 */
  rebuildLine?: string;
  /** F2／F10：本機開口偵測的 RMS 門檻（NOUS_EARLY_SPEECH_RMS）；未提供時用 EARLY_SPEECH_RMS。 */
  earlySpeechRms?: number;
}

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export class RealtimeVoice {
  private phase: RealtimePhase = "off";
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private stopAudio: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 一輪回覆中呼叫的工具：全部回覆後才請模型接著說。 */
  private pendingTools = 0;
  /** 本機執行的 function 工具（含 home_control）交回了結果：不用等 OpenAI 端的 MCP。 */
  private functionsCalled = false;
  /** OpenAI 端的 MCP 呼叫或確認：等 mcpPending 歸零才接著回應。 */
  private mcpCalled = false;
  private responding = false;
  private notices: string[] = [];
  private generation = 0;
  /** 模型呼叫了 end_conversation：念完道別就結束。 */
  private endRequested = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已送出 response.create、還沒收到 response.created。 */
  private awaitingCreated = false;
  /** OpenAI 端正在執行的 MCP 呼叫或等待核准的數量。 */
  private mcpPending = 0;
  /** 開著或排隊中的家電確認卡，加上確認後還在執行的家電指令：期間不計閒置。 */
  private homePending = 0;
  private handledApprovals = new Set<string>();
  /** 等待使用者語音確認的請求：一次只顯示一張確認卡，其餘排隊（兩條路徑共用的佇列）。 */
  private readonly approvals: ApprovalQueue;

  private idleMs: number;
  private readonly greeting: GreetingOnce | null;
  /** session.created 之後等 GREETING_SETTLE_MS 才送招呼；使用者開口、打字、收起都會取消。 */
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  /** 連線中（session.created 之前）打的字：連上後合併成一輪送出。 */
  private queuedText: string[] = [];
  /** MEM-3：核心事件的訂閱（取消用）。 */
  private unsubscribe: (() => void) | null = null;
  /** MEM-3：核心要求暫停（更正、忘記 commit 前）：播放靜音到恢復或通話結束。 */
  private held = false;
  /** MEM-3：核心送來、頁面還在執行的工具。 */
  private hostCalls = 0;
  private readonly rebuild: boolean;
  private readonly rebuildLine: string;
  private readonly earlySpeechRms: number;
  /** 確認卡狀態的回報要先於工具結果到達核心。 */
  private approvalSync: Promise<void> = Promise.resolve();
  /** F2／F10：本機麥克風音量的監看（連線中與問候送出前）。 */
  private stopMicLevel: (() => void) | null = null;
  /** F7：手掌停止的次數；工具開始時記下，結果回來時不同就只交回結果、不請模型接著說。 */
  private replyEpoch = 0;
  /**
   * F7：手掌停止之後、下一輪（使用者開口、打字、系統通知或說出確認卡的回答）之前：事件沒有 response_id 時，
   * 晚到的工具呼叫也算停止前的（有 response_id 時以 stoppedResponses 為準）。
   */
  private quietTurn = false;
  /** F7：目前（已建立、還沒結束）的回應 ID。 */
  private currentResponse: string | null = null;
  /** F7：被手掌停止的回應：它們的工具結果（含 cancel 之後才到的 function_call）只交回、不念。 */
  private readonly stoppedResponses = new Set<string>();
  /**
   * F7（審查 minor 4a）：停止時還沒有建立的回應（已送出 response.create，或伺服器 VAD 正要回答）：下一個沒有核心標記的
   * response.created 一建立就取消。使用者再開口、打字或系統通知時解除。
   */
  private cancelNextCreated = false;
  /** F1（審查 minor 6）：問候那一輪的 response.create 的 event_id 與指示；上游拒絕新參數時只退回一次。 */
  private greetRequest: { eventId: string; instructions: string } | null = null;
  private greetSeq = 0;
  private greetFallbackUsed = false;

  constructor(
    private readonly callbacks: RealtimeCallbacks,
    private readonly deps: RealtimeDeps,
    options: RealtimeOptions,
  ) {
    this.idleMs = options.idleMs;
    this.greeting = options.greeting ?? null;
    this.rebuild = options.rebuild === true;
    this.rebuildLine = options.rebuildLine ?? REBUILD_LINE;
    this.earlySpeechRms = options.earlySpeechRms ?? EARLY_SPEECH_RMS;
    this.approvals = new ApprovalQueue(
      callbacks,
      {
        generation: () => this.generation,
        notify: (text) => this.notify(text),
        addContext: (text) => this.addContext(text),
        resetIdle: () => this.resetIdle(),
        pendingChanged: (kind, delta) => {
          if (kind === "mcp") this.mcpPending = delta > 0 ? this.mcpPending + 1 : Math.max(0, this.mcpPending - 1);
          else this.homePending = delta > 0 ? this.homePending + 1 : Math.max(0, this.homePending - 1);
        },
        // MEM-3：確認卡狀態回報給核心（沒有核心接縫時不送）。
        cardChanged: (report) => {
          const core = this.deps.core;
          if (!core) return;
          const generation = this.generation;
          const post = () => (generation === this.generation ? core.approval(report) : undefined);
          this.approvalSync = this.approvalSync.then(post).catch(post).catch(() => undefined);
        },
        sendMcpApproval: (request, approve, reason) =>
          this.send({
            type: "conversation.item.create",
            item: {
              id: `mcp_approval_${request.id}`,
              type: "mcp_approval_response",
              approval_request_id: request.id,
              approve,
              ...(approve ? {} : { reason }),
            },
          }),
        mcpResolved: (outcome) => {
          // F7（審查 minor 4c）：停止之後才說出確認卡的回答＝新的一輪，結果照常念。
          if (outcome === "said_approve" || outcome === "said_reject") this.newTurn();
          this.mcpCalled = true;
          // 說出確認語句的這一輪已經（或即將）有回應：等它結束再接著回應，避免重疊的 response.create。
          this.finishMcp(outcome !== "said_approve" && outcome !== "said_reject");
        },
      },
      options.approvalMs ?? 60_000,
    );
  }

  /**
   * 改閒置時間（voice.json 改了）。值真的改變而且正在倒數時，從現在起重新倒數新的長度；
   * 同樣的值不延長倒數；沒開著時只記下來，下次連線才用。
   */
  setIdleMs(ms: number): void {
    if (ms === this.idleMs) return;
    this.idleMs = ms;
    if (this.on && this.idleTimer) this.resetIdle();
  }

  get current(): RealtimePhase {
    return this.phase;
  }

  get on(): boolean {
    return this.phase !== "off";
  }

  /** 麥克風正在把聲音送出（連線完成後）。 */
  get capturing(): boolean {
    return this.on && this.phase !== "connecting";
  }

  get playing(): boolean {
    return this.phase === "speaking";
  }

  async start(): Promise<void> {
    if (this.on) return;
    const generation = ++this.generation;
    this.setPhase("connecting");
    try {
      const mic = await this.deps.getMicrophone();
      if (generation !== this.generation) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      this.mic = mic;
      this.watchEarlySpeech(mic, generation);
      // MEM-3：先訂閱核心事件再交換 SDP（核心在回 answer 之前就可能送出記憶狀態）。
      const core = this.deps.core;
      if (core) {
        this.unsubscribe = core.subscribe({
          host: (call) => {
            if (generation === this.generation) this.onHostCall(call, generation);
          },
          core: (event) => {
            if (generation === this.generation) this.onCore(event);
          },
        });
      }
      const peer = this.deps.createPeer();
      this.peer = peer;
      peer.ontrack = (e) => {
        if (this.peer !== peer) return;
        this.stopAudio?.();
        this.stopAudio = this.deps.playRemote(e.streams[0]);
      };
      peer.onconnectionstatechange = () => {
        if (this.peer === peer && (peer.connectionState === "failed" || peer.connectionState === "closed")) {
          this.close("即時語音連線中斷。");
        }
      };
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      // 結束後舊連線遲到的事件一律忽略，避免狀態「復活」。
      channel.onmessage = (e) => {
        if (this.channel === channel) this.handle(JSON.parse(String(e.data)) as ServerEvent);
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answer = await this.deps.exchange(offer.sdp ?? "");
      if (generation !== this.generation) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      this.resetIdle();
    } catch (err) {
      if (generation !== this.generation) return;
      const name = (err as { name?: string }).name;
      const reason =
        name === "NotAllowedError" ? "麥克風權限被拒絕，無法使用即時語音。"
        : name === "NotFoundError" ? "找不到可用的麥克風。"
        : err instanceof Error ? err.message : "無法開始即時語音。";
      this.close(reason);
    }
  }

  stop(): void {
    if (!this.on) return;
    this.generation++;
    this.teardown();
    this.setPhase("off");
  }

  /** Esc／點擊打斷：停止正在念的回覆，回到聆聽。 */
  interrupt(): void {
    if (!this.responding && this.phase !== "speaking") return;
    this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.setPhase("listening");
  }

  /**
   * F7：手掌停止（停止回覆）。和 Esc 的打斷一樣停掉正在念或正在產生的回覆（response.cancel＋清掉播放緩衝），另外：
   * 這一輪已經開始、還沒回來的工具結果回來時只交回模型（function_call_output，當背景），不再 response.create 請模型念出；
   * 核心旁路（帶記憶的通話）處理的工具也一樣（POST stop-reply）。工具本身不中止：交辦的背景任務照常建立、照常執行。
   * 排隊中的系統通知（例如任務完成）不屬於這一輪，照常轉告。
   */
  stopReply(): void {
    if (!this.capturing) return;
    this.replyEpoch++;
    this.quietTurn = true;
    this.functionsCalled = false;
    this.mcpCalled = false;
    if (this.currentResponse) this.stoppedResponses.add(this.currentResponse);
    while (this.stoppedResponses.size > 64) this.stoppedResponses.delete(this.stoppedResponses.values().next().value!);
    // 回應還沒建立（已送出請求，或伺服器 VAD 正要回答）：建立時取消。
    if (!this.currentResponse || this.awaitingCreated) this.cancelNextCreated = true;
    if (this.responding || this.phase === "speaking") {
      this.send({ type: "response.cancel" });
      this.send({ type: "output_audio_buffer.clear" });
    }
    if (this.phase === "speaking" || this.phase === "thinking") this.setPhase("listening");
    void this.deps.core?.stopReply?.().catch(() => undefined);
  }

  /** 打字輸入：當成使用者這一輪說的話送出。連線中打的先排隊，session.created 之後送出。打字一律取消還沒送出的招呼。 */
  sendText(text: string): void {
    this.skipGreeting();
    if (!this.on) return;
    if (this.phase === "connecting") {
      this.queuedText.push(text);
      return;
    }
    if (!this.channel) return;
    this.resetIdle();
    if (this.responding) this.interrupt();
    this.newTurn();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.checkApproval(text);
    this.requestResponse();
  }

  /** 補充背景資訊給模型（例如使用者正指著畫面哪一項），不要求模型回應。 */
  addContext(text: string): void {
    if (!this.channel) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
  }

  /** 系統通知（例如任務完成）：請模型用一句話轉告；正在回覆時等這輪結束再說。 */
  notify(text: string): void {
    if (!this.channel) return;
    if (this.responding || this.pendingTools > 0) {
      this.notices.push(text);
      return;
    }
    this.sendNotice(text);
  }

  /** F7：新的一輪（使用者開口、打字、系統通知、說出確認卡的回答）：停止回覆的影響到此為止。 */
  private newTurn(): void {
    this.quietTurn = false;
    this.cancelNextCreated = false;
  }

  private sendNotice(text: string): void {
    this.newTurn();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `（系統通知）${text}` }] } });
    this.requestResponse();
  }

  /**
   * 請模型回應。送出當下就視為回應中，直到 response.done：
   * 同時有多則通知時才不會連續送出 response.create（OpenAI 會拒絕重疊的回應）。
   */
  private requestResponse(response?: Record<string, unknown>, eventId?: string): void {
    this.responding = true;
    this.awaitingCreated = true;
    this.send({ type: "response.create", ...(eventId ? { event_id: eventId } : {}), ...(response ? { response } : {}) });
  }

  /** 使用者先開口或打字：這次不打招呼，等待中的計時器也取消。 */
  private skipGreeting(): void {
    this.greeting?.skip();
    this.cancelGreetTimer();
  }

  private cancelGreetTimer(): void {
    if (this.greetTimer) clearTimeout(this.greetTimer);
    this.greetTimer = null;
  }

  /** session.created 之後：還有待送的招呼就等 GREETING_SETTLE_MS，讓已經在說話的使用者先取消它。 */
  private scheduleGreeting(): void {
    if (this.greeting?.state !== "pending" || this.greetTimer) return;
    this.greetTimer = setTimeout(() => {
      this.greetTimer = null;
      this.greetIfPending();
    }, GREETING_SETTLE_MS);
  }

  /**
   * 等待結束：看著說話開始、使用者還沒開口、設定還開著，就向核心要這一輪的指示（只含核心從固定清單挑好的一句，例如「嗨，George」或「我在」），
   * 請模型照念。決策期間開口、打字或收起都會取消；回來時工作階段已換掉或正在回應就不送（也不重送）。
   */
  private greetIfPending(): void {
    if (!this.greeting || this.responding) return;
    const generation = this.generation;
    void this.greeting.take("api_key").then((instructions) => {
      if (!instructions || generation !== this.generation || this.responding) return;
      const eventId = `greet_${++this.greetSeq}`;
      this.greetRequest = { eventId, instructions };
      this.requestResponse(greetingResponse(instructions), eventId);
    });
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case "session.created": {
        // 只看 type：session 的內容（instructions、工具、記憶區塊）不存、不轉出。
        this.setPhase("listening");
        const queued = this.queuedText.splice(0);
        if (queued.length) this.sendText(queued.join("\n"));
        // MEM-3 重建：第一句是不含內容的固定句（不重念被忘記的內容），不問候。
        if (this.rebuild && !queued.length) this.requestResponse({ instructions: `只說這一句，一字不改，不加字、不提問：「${this.rebuildLine}」` });
        this.scheduleGreeting();
        break;
      }
      case "input_audio_buffer.speech_started":
        // 使用者先開口：這次不打招呼（已經送出的招呼照一般插話處理）。
        this.skipGreeting();
        this.newTurn();
        this.resetIdle();
        this.setPhase("hearing");
        break;
      case "input_audio_buffer.speech_stopped":
        this.setPhase("thinking");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string" && event.transcript.trim()) {
          this.callbacks.onUserTranscript(event.transcript.trim());
          this.checkApproval(event.transcript);
        }
        break;
      case "response.created": {
        const response = event.response as { id?: unknown; metadata?: { nous_trigger?: unknown } | null } | undefined;
        const id = typeof response?.id === "string" ? response.id : null;
        this.currentResponse = id;
        // F7：停止時還沒建立的那一個（沒有核心標記；核心自己的接續回應由核心處理）：一建立就取消，它的工具結果也不念。
        if (this.cancelNextCreated && typeof response?.metadata?.nous_trigger !== "string") {
          this.cancelNextCreated = false;
          if (id) this.stoppedResponses.add(id);
          this.send({ type: "response.cancel", ...(id ? { response_id: id } : {}) });
          this.send({ type: "output_audio_buffer.clear" });
        }
        this.responding = true;
        this.awaitingCreated = false;
        this.functionsCalled = false;
        // 還在執行的 MCP 呼叫不算被這輪回應涵蓋：結束後再接著回應一次。
        if (this.mcpPending === 0) this.mcpCalled = false;
        if (this.phase !== "speaking") this.setPhase("thinking");
        break;
      }
      case "output_audio_buffer.started":
        this.setPhase("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        // MEM-3：帶記憶的通話補報播放結束（核心只會把語音確認時窗往後延）。
        if (event.type === "output_audio_buffer.stopped" && this.deps.core?.coreTools().length) void this.deps.core.playback().catch(() => undefined);
        if (this.phase === "speaking") this.setPhase(this.responding ? "thinking" : "listening");
        if (this.endRequested && !this.responding) this.close("對話已結束。");
        break;
      case "response.output_audio_transcript.done":
        if (typeof event.transcript === "string" && event.transcript.trim()) this.callbacks.onAssistantTranscript(event.transcript.trim());
        break;
      case "response.function_call_arguments.done": {
        const name = String(event.name ?? "");
        // MEM-3：核心處理的工具（recall_memory、delegate_task）：頁面略過，不計入 pendingTools；結果由核心經旁路交回。
        if (this.deps.core?.coreTools().includes(name)) break;
        void this.runTool(name, String(event.call_id ?? ""), String(event.arguments ?? "{}"), typeof event.response_id === "string" ? event.response_id : null);
        break;
      }
      case "conversation.item.done":
      case "conversation.item.added": {
        const item = event.item as { type?: string; id?: string; server_label?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "mcp_approval_request" && item.id && !this.handledApprovals.has(item.id)) {
          this.handledApprovals.add(item.id);
          this.approvals.queue({ kind: "mcp", id: item.id, server: item.server_label ?? "", name: item.name ?? "", arguments: item.arguments ?? "{}" });
        }
        break;
      }
      case "mcp_list_tools.failed":
        this.callbacks.onToolActivity("外部服務（MCP）的工具清單載入失敗");
        break;
      case "response.mcp_call.in_progress":
        this.mcpPending += 1;
        if (!this.isStopped(typeof event.response_id === "string" ? event.response_id : null)) this.mcpCalled = true;
        break;
      case "response.mcp_call.failed":
        this.callbacks.onToolActivity("外部服務（MCP）呼叫失敗");
        this.finishMcp();
        break;
      case "response.output_item.done": {
        const item = event.item as { type?: string; server_label?: string; name?: string } | undefined;
        if (item?.type === "mcp_call") {
          this.callbacks.onToolActivity(`已使用 ${item.server_label ?? "外部服務"}：${item.name ?? ""}`);
          this.finishMcp();
        }
        break;
      }
      case "response.done":
        this.responding = false;
        this.currentResponse = null;
        this.resetIdle();
        if (this.phase === "thinking") this.setPhase("listening");
        if (this.endRequested) {
          // 道別的語音可能還在播放；播完（output_audio_buffer.stopped）就結束，沒有聲音時稍等後結束。
          if (this.endTimer) clearTimeout(this.endTimer);
          this.endTimer = setTimeout(() => this.phase !== "speaking" && this.close("對話已結束。"), 1500);
          break;
        }
        this.continueAfterTools();
        break;
      case "error": {
        const error = event.error as { message?: string; code?: string; param?: string; event_id?: string } | undefined;
        // 取消已結束的回覆之類的錯誤不影響對話。
        if (error?.code === "response_cancel_not_active") break;
        // F1（審查 minor 6）：上游不接受問候那一輪的 output_modalities／tool_choice：只退回一次，只帶 instructions 重送。
        const greet = this.greetRequest;
        if (greet && error?.event_id === greet.eventId && /^response\.(output_modalities|tool_choice)/.test(error.param ?? "") && !this.greetFallbackUsed) {
          this.greetFallbackUsed = true;
          this.greetRequest = null;
          console.warn("[realtime] 問候的 response.create 參數被拒絕，改成只帶 instructions 重送一次", error.param);
          this.awaitingCreated = false;
          this.responding = false;
          this.requestResponse({ instructions: greet.instructions }, `greet_${++this.greetSeq}`);
          break;
        }
        console.warn("[realtime]", error?.code, error?.message);
        // 我們要求的回應沒有被建立（例如被拒絕）：不要卡在「回應中」，繼續處理排隊的通知。
        if (this.awaitingCreated) {
          this.awaitingCreated = false;
          this.responding = false;
          this.continueAfterTools();
        }
        break;
      }
    }
  }

  /** 工具呼叫：計數留在這裡（GA 的回應排程），執行交給共用的 executeRealtimeTool。 */
  private runTool(name: string, callId: string, rawArgs: string, responseId: string | null = null): void {
    const generation = this.generation;
    const epoch = this.isStopped(responseId) ? -1 : this.replyEpoch;
    this.pendingTools += 1;
    // F7：被停止的回應（或沒有 response_id、停止之後才到）的工具：照常執行、交回結果，但不排接續回應。
    if (epoch === this.replyEpoch) this.functionsCalled = true;
    void executeRealtimeTool(name, rawArgs, {
      callbacks: this.callbacks,
      approvals: this.approvals,
      generation,
      stale: (g) => g !== this.generation,
      end: () => {
        // 不需要模型再接著說：道別已在同一輪回覆中。
        this.endRequested = true;
        this.pendingTools -= 1;
        this.functionsCalled = false;
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) } });
      },
      deliver: (output) => {
        if (generation !== this.generation) return;
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
        this.pendingTools -= 1;
        // F7：手掌停止之後才回來：結果已交回模型當背景，不請模型念出（functionsCalled 已在 stopReply 清掉）；排隊的通知照常。
        if (epoch !== this.replyEpoch || this.isStopped(responseId)) console.info("[realtime] 停止回覆之後才回來的工具結果：只交回、不念出");
        this.continueAfterTools();
      },
    });
  }

  /** F7：這個回應被手掌停止了？有 response_id 時看 stoppedResponses（不受開口先後影響）；沒有時退回 quietTurn。 */
  private isStopped(responseId: string | null): boolean {
    return responseId ? this.stoppedResponses.has(responseId) : this.quietTurn;
  }

  /** 使用者說的話（或打的字）是否為確認卡的固定語句（共用佇列判斷）。 */
  private checkApproval(text: string): void {
    this.approvals.check(text);
  }

  /** 結束目前的確認卡並回覆 OpenAI；畫面被收起時由呼叫端以 dismissed 拒絕。 */
  resolveApproval(approve: boolean, outcome: ApprovalOutcome): void {
    // F7（審查 minor 4c）：使用者回答確認卡＝新的一輪。
    if (outcome === "said_approve" || outcome === "said_reject") this.newTurn();
    this.approvals.resolve(approve, outcome);
  }

  get pendingApproval(): ApprovalRequest | null {
    return this.approvals.current;
  }

  private finishMcp(continueNow = true): void {
    this.mcpPending = Math.max(0, this.mcpPending - 1);
    if (continueNow) this.continueAfterTools();
  }

  /**
   * 工具結果都交回、這輪回覆也結束後，請模型接著用語音回應；再補上排隊的系統通知。
   * 本機 function 工具（含家電）的結果不等 MCP；OpenAI 端的 MCP 呼叫或確認卡未結束時，
   * MCP 的部分只先送通知（例如請模型說明確認卡），等它結束再接著回應。
   */
  private continueAfterTools(): void {
    if (this.responding || this.pendingTools > 0) return;
    const mcpDone = this.mcpCalled && this.mcpPending === 0;
    if (this.functionsCalled || mcpDone) {
      this.functionsCalled = false;
      if (mcpDone) this.mcpCalled = false;
      this.requestResponse();
      return;
    }
    const notice = this.notices.shift();
    if (notice) this.sendNotice(notice);
  }

  private send(event: Record<string, unknown>): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  /** MEM-3：核心事件（帶記憶的 API key 通話）。 */
  private onCore(event: LiveCoreEvent): void {
    const core = this.deps.core;
    if (!core) return;
    switch (event.kind) {
      case "memory":
      case "memory_card":
      case "memory_notice":
      case "delegate_blocked":
      case "delegate_card":
      case "delegated":
        core.memoryEvent(event);
        break;
      case "hold":
        // 更正或忘記 commit 前：立刻把播放靜音（核心同時停止送出）；commit 失敗才恢復。
        this.held = event.active;
        core.setMuted(event.active);
        break;
      case "tool_unknown":
        this.callbacks.onToolActivity(`${RESULT_UNKNOWN_TEXT}（${event.name === "home_control" ? "家電指令" : "交辦工作"}沒有在時限內回報）`);
        break;
      case "closed":
        if (event.reason === "memory_revoked") {
          void this.revoke(event.message, event.rebuild === true);
          break;
        }
        // 旁路斷線：核心已經掛斷；結束、說出原因。不改路徑。
        if (event.reason !== "ended") core.speak(event.message);
        this.close(event.message);
        break;
      case "started":
      case "transcript":
      case "delegation":
        break;
    }
  }

  /** MEM-3：核心請頁面執行一個工具（還沒帶記憶時的交辦）：同一個 executeRealtimeTool、同一份 callbacks。 */
  private onHostCall(call: HostCall, generation: number): void {
    const core = this.deps.core;
    if (!core) return;
    this.hostCalls += 1;
    const post = (output: Record<string, unknown>) => {
      this.hostCalls = Math.max(0, this.hostCalls - 1);
      if (generation !== this.generation) return;
      this.resetIdle();
      void this.approvalSync.then(() => (generation === this.generation ? core.hostResult(call.call_id, output) : undefined)).catch(() => undefined);
    };
    void executeRealtimeTool(call.name, call.arguments, {
      callbacks: this.callbacks,
      approvals: this.approvals,
      generation,
      stale: (g) => g !== this.generation,
      end: () => {
        this.endRequested = true;
        post({ ok: true });
      },
      deliver: post,
    });
  }

  /**
   * MEM-3：記憶撤銷後可靠停播（16 §8，和 LiveVoice.revoke 同樣的順序）：generation++ → 播放先靜音、暫停、拿掉 srcObject →
   * 停掉每個遠端軌道 → peer.close、channel.close、麥克風軌道停止 → 取消語音合成。核對（audio 已暫停、peer 已關、遠端軌道都 ended）
   * 後把證據與花費毫秒數 POST stopped，再交給主程式（清字幕、重建）。不呼叫 end（核心已經結束這個工作階段並掛斷）。
   * 已在執行的工具（web_search、家電）因 generation 檢查被丟掉。
   */
  async revoke(message: string, rebuild: boolean): Promise<void> {
    const core = this.deps.core;
    if (!this.on || !core) return;
    const started = Date.now();
    this.generation++;
    core.setMuted(true);
    this.stopAudio?.();
    this.stopAudio = null;
    const peer = this.peer;
    const receivers = peer?.getReceivers?.() ?? [];
    for (const receiver of receivers) receiver.track?.stop();
    // 已經靜音並拆掉播放：teardown 不要再解除靜音。
    this.held = false;
    this.teardown();
    core.cancelSpeech();
    this.setPhase("off");
    const evidence: StopEvidence = {
      paused: core.audioPaused(),
      peer_closed: !peer || peer.connectionState === "closed",
      tracks_ended: receivers.every((r) => !r.track || r.track.readyState === "ended"),
      ms: Date.now() - started,
    };
    let accepted = false;
    try {
      accepted = (await core.stopped(evidence)) === true;
    } catch {
      // 回報送不到：核心在 1.5 秒後強制靜音並停用這條路徑的記憶。
    }
    core.revoked(message, rebuild && accepted, accepted);
  }

  /**
   * F2／F10：取得麥克風之後開始看本機音量，直到連線完成而且問候不會再送出為止。
   * 連線中偵測到開口：取消招呼並提示「還在連線，請稍後再說一次」（那段話伺服器沒聽到，不代為猜內容）；
   * 就緒之後、問候送出前：只取消招呼（聲音已經送到伺服器，照常回答）。
   */
  private watchEarlySpeech(mic: MediaStream, generation: number): void {
    if (!this.deps.watchLevel) return;
    const detector = new EarlySpeech(Date.now, this.earlySpeechRms);
    this.stopMicLevel = this.deps.watchLevel(mic, (rms) => {
      if (generation !== this.generation) return;
      const connecting = this.phase === "connecting";
      if (!connecting && !this.greeting?.open) {
        this.stopEarlySpeech();
        return;
      }
      if (!detector.feed(rms)) return;
      // 只記事件、階段與峰值 RMS（Mac 重測看誤判用），沒有聲音。
      console.info(earlySpeechLogLine(connecting ? "connecting" : "pre-greeting", detector.peak));
      this.skipGreeting();
      if (connecting) this.callbacks.onToolActivity(CONNECTING_SPEECH_HINT);
      this.stopEarlySpeech();
    });
  }

  private stopEarlySpeech(): void {
    const stop = this.stopMicLevel;
    this.stopMicLevel = null;
    stop?.();
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.responding || this.phase === "speaking" || this.pendingTools > 0 || this.mcpPending > 0 || this.homePending > 0 || this.hostCalls > 0) {
        this.resetIdle();
        return;
      }
      this.close("一段時間沒有說話，即時語音已結束（避免持續計費）。");
    }, this.idleMs);
  }

  private close(reason: string): void {
    if (!this.on) return;
    this.generation++;
    this.teardown();
    this.setPhase("off");
    this.callbacks.onClosed(reason);
  }

  private teardown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.endRequested = false;
    this.cancelGreetTimer();
    this.stopEarlySpeech();
    this.queuedText = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.held) this.deps.core?.setMuted(false);
    this.held = false;
    this.hostCalls = 0;
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.stopAudio?.();
    this.stopAudio = null;
    this.pendingTools = 0;
    this.mcpPending = 0;
    this.homePending = 0;
    this.handledApprovals.clear();
    this.approvals.clear();
    this.functionsCalled = false;
    this.mcpCalled = false;
    this.responding = false;
    this.awaitingCreated = false;
    this.notices = [];
    this.currentResponse = null;
    this.cancelNextCreated = false;
    this.quietTurn = false;
    this.stoppedResponses.clear();
    this.greetRequest = null;
  }

  private setPhase(phase: RealtimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.callbacks.onPhase(phase);
  }
}

/**
 * F1（ID-02 Mac 2026-10-31）：問候那一輪的 response.create 內容。instructions 是核心組好的嚴格版（strictGreetingInstructions），
 * 另外只要語音輸出（output_modalities）、不准呼叫工具（tool_choice none），讓這一輪只有那一句。模型是否一字不改只能在 Mac 上重測。
 */
export function greetingResponse(instructions: string): Record<string, unknown> {
  return { instructions, output_modalities: ["audio"], tool_choice: "none" };
}

/** 瀏覽器實際使用的能力。 */
export function browserRealtimeDeps(exchange: (sdp: string) => Promise<string>): RealtimeDeps {
  return {
    getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    createPeer: () => new RTCPeerConnection(),
    playRemote(stream) {
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = stream;
      void audio.play().catch(() => {});
      return () => {
        audio.pause();
        audio.srcObject = null;
      };
    },
    exchange,
  };
}

export function realtimeSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}
