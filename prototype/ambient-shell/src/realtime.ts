import { matchApproval } from "./approval.ts";

// 即時語音模式（OpenAI Realtime）：像 ChatGPT 語音模式，語音直接對語音。
// 麥克風音訊經 WebRTC 串流到 OpenAI，由伺服器端 VAD 判斷你何時說完；你一開口，
// 正在播放的回覆就會被 OpenAI 截斷（插話）。SDP 交換經本機核心，API key 不進瀏覽器。
// 上網查詢、交辦工作與查進度用 function calling：查詢經本機核心代為呼叫 web_search，
// 交辦與進度呼叫既有的任務 API，任務仍用目前選擇的引擎執行。
// 設定了遠端 MCP 伺服器時，由 OpenAI 端直接呼叫；需要核准的動作顯示確認卡，
// 使用者說出固定語句（「確認執行」或「取消」）才回覆 OpenAI，不需要按任何東西。

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
  /** MCP 工具需要核准：顯示確認卡，等使用者說「確認執行」或「取消」。 */
  onApprovalPrompt(request: McpApprovalRequest, expiresAt: number): void;
  /** 確認卡結束：同意、拒絕、逾時、畫面被收起或對話結束。 */
  onApprovalResolved(request: McpApprovalRequest, approved: boolean, outcome: ApprovalOutcome): void;
  /** 工具活動的短說明（例如「上網查詢：新竹天氣」），顯示在字幕。 */
  onToolActivity(text: string): void;
  /** 模式因錯誤或閒置而關閉。 */
  onClosed(reason: string): void;
}

export type ApprovalOutcome = "said_approve" | "said_reject" | "timeout" | "dismissed" | "closed";

export interface McpApprovalRequest {
  id: string;
  server: string;
  name: string;
  arguments: string;
}

/** 可替換的瀏覽器能力，方便在測試中模擬。 */
export interface RealtimeDeps {
  getMicrophone(): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  playRemote(stream: MediaStream): () => void;
  /** 把 SDP offer 交給本機核心，取回 OpenAI 的 SDP answer。 */
  exchange(offerSdp: string): Promise<string>;
}

interface RealtimeOptions {
  /** 多久沒有任何說話就自動結束（毫秒），避免忘記關而持續計費。 */
  idleMs: number;
  /** 確認卡多久沒回應就自動取消（毫秒），預設 60 秒。 */
  approvalMs?: number;
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
  private toolsCalled = false;
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
  private handledApprovals = new Set<string>();
  /** 等待使用者語音確認的請求：一次只顯示一張確認卡，其餘排隊。 */
  private approvalQueue: McpApprovalRequest[] = [];
  private approval: { request: McpApprovalRequest; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly callbacks: RealtimeCallbacks,
    private readonly deps: RealtimeDeps,
    private readonly options: RealtimeOptions,
  ) {}

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

  /** 打字輸入：當成使用者這一輪說的話送出。 */
  sendText(text: string): void {
    if (!this.channel) return;
    this.resetIdle();
    if (this.responding) this.interrupt();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.checkApproval(text);
    this.requestResponse();
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

  private sendNotice(text: string): void {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `（系統通知）${text}` }] } });
    this.requestResponse();
  }

  /**
   * 請模型回應。送出當下就視為回應中，直到 response.done：
   * 同時有多則通知時才不會連續送出 response.create（OpenAI 會拒絕重疊的回應）。
   */
  private requestResponse(): void {
    this.responding = true;
    this.awaitingCreated = true;
    this.send({ type: "response.create" });
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case "session.created":
        this.setPhase("listening");
        break;
      case "input_audio_buffer.speech_started":
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
      case "response.created":
        this.responding = true;
        this.awaitingCreated = false;
        this.toolsCalled = false;
        if (this.phase !== "speaking") this.setPhase("thinking");
        break;
      case "output_audio_buffer.started":
        this.setPhase("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (this.phase === "speaking") this.setPhase(this.responding ? "thinking" : "listening");
        if (this.endRequested && !this.responding) this.close("對話已結束。");
        break;
      case "response.output_audio_transcript.done":
        if (typeof event.transcript === "string" && event.transcript.trim()) this.callbacks.onAssistantTranscript(event.transcript.trim());
        break;
      case "response.function_call_arguments.done":
        void this.runTool(String(event.name ?? ""), String(event.call_id ?? ""), String(event.arguments ?? "{}"));
        break;
      case "conversation.item.done":
      case "conversation.item.added": {
        const item = event.item as { type?: string; id?: string; server_label?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === "mcp_approval_request" && item.id && !this.handledApprovals.has(item.id)) {
          this.handledApprovals.add(item.id);
          this.queueApproval({ id: item.id, server: item.server_label ?? "", name: item.name ?? "", arguments: item.arguments ?? "{}" });
        }
        break;
      }
      case "mcp_list_tools.failed":
        this.callbacks.onToolActivity("外部服務（MCP）的工具清單載入失敗");
        break;
      case "response.mcp_call.in_progress":
        this.mcpPending += 1;
        this.toolsCalled = true;
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
        const error = event.error as { message?: string; code?: string } | undefined;
        // 取消已結束的回覆之類的錯誤不影響對話。
        if (error?.code === "response_cancel_not_active") break;
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

  private async runTool(name: string, callId: string, rawArgs: string): Promise<void> {
    this.pendingTools += 1;
    this.toolsCalled = true;
    const generation = this.generation;
    let output: Record<string, unknown>;
    try {
      const args = JSON.parse(rawArgs || "{}") as { title?: unknown; query?: unknown };
      if (name === "end_conversation") {
        // 不需要模型再接著說：道別已在同一輪回覆中。
        this.endRequested = true;
        this.pendingTools -= 1;
        this.toolsCalled = false;
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) } });
        return;
      }
      if (name === "delegate_task") {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        output = title ? await this.callbacks.onDelegate(title) : { ok: false, error: "缺少任務描述" };
      } else if (name === "web_search") {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) {
          output = { ok: false, error: "缺少查詢內容" };
        } else {
          this.callbacks.onToolActivity(`上網查詢：${query}`);
          output = await this.callbacks.onWebSearch(query);
        }
      } else if (name === "get_tasks") {
        output = await this.callbacks.onGetTasks();
      } else {
        output = { ok: false, error: `未知的工具：${name}` };
      }
    } catch (err) {
      output = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (generation !== this.generation) return;
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.pendingTools -= 1;
    this.continueAfterTools();
  }

  /** MCP 需要核准：排進確認卡佇列；確認前 OpenAI 端不會執行這個動作。 */
  private queueApproval(request: McpApprovalRequest): void {
    this.mcpPending += 1;
    this.approvalQueue.push(request);
    if (!this.approval) this.showNextApproval();
  }

  private showNextApproval(): void {
    const request = this.approvalQueue.shift();
    if (!request) return;
    const ms = this.options.approvalMs ?? 60_000;
    const timer = setTimeout(() => this.resolveApproval(false, "timeout"), ms);
    this.approval = { request, timer };
    this.callbacks.onApprovalPrompt(request, Date.now() + ms);
    this.notify(
      `外部服務「${request.server}」要執行「${request.name}」，需要使用者確認。請用一句話說明要做什麼、對象和影響，並請使用者說「確認執行」或「取消」。不要替使用者確認。`,
    );
  }

  /** 使用者說的話（或打的字）是否為確認卡的固定語句。 */
  private checkApproval(text: string): void {
    if (!this.approval) return;
    const decision = matchApproval(text);
    if (decision) this.resolveApproval(decision === "approve", decision === "approve" ? "said_approve" : "said_reject");
  }

  /** 結束目前的確認卡並回覆 OpenAI；畫面被收起時由呼叫端以 dismissed 拒絕。 */
  resolveApproval(approve: boolean, outcome: ApprovalOutcome): void {
    const current = this.approval;
    if (!current) return;
    clearTimeout(current.timer);
    this.approval = null;
    const { request } = current;
    const reason = outcome === "timeout" ? "使用者沒有在時限內確認" : outcome === "dismissed" ? "使用者收起了確認畫面" : "使用者說取消";
    this.send({
      type: "conversation.item.create",
      item: {
        id: `mcp_approval_${request.id}`,
        type: "mcp_approval_response",
        approval_request_id: request.id,
        approve,
        ...(approve ? {} : { reason }),
      },
    });
    this.callbacks.onApprovalResolved(request, approve, outcome);
    this.callbacks.onToolActivity(approve ? `已確認：${request.server} · ${request.name}` : `沒有執行：${request.server} · ${request.name}（${reason}）`);
    this.toolsCalled = true;
    // 說出確認語句的這一輪已經（或即將）有回應：等它結束再接著回應，避免重疊的 response.create。
    this.finishMcp(outcome !== "said_approve" && outcome !== "said_reject");
    this.showNextApproval();
  }

  get pendingApproval(): McpApprovalRequest | null {
    return this.approval?.request ?? null;
  }

  private finishMcp(continueNow = true): void {
    this.mcpPending = Math.max(0, this.mcpPending - 1);
    if (continueNow) this.continueAfterTools();
  }

  /**
   * 工具結果都交回、這輪回覆也結束後，請模型接著用語音回應；再補上排隊的系統通知。
   * OpenAI 端的 MCP 呼叫或確認卡未結束時只先送通知（例如請模型說明確認卡），等它結束再接著回應。
   */
  private continueAfterTools(): void {
    if (this.responding || this.pendingTools > 0) return;
    if (this.toolsCalled && this.mcpPending === 0) {
      this.toolsCalled = false;
      this.requestResponse();
      return;
    }
    const notice = this.notices.shift();
    if (notice) this.sendNotice(notice);
  }

  private send(event: Record<string, unknown>): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.responding || this.phase === "speaking" || this.pendingTools > 0 || this.mcpPending > 0) {
        this.resetIdle();
        return;
      }
      this.close("一段時間沒有說話，即時語音已結束（避免持續計費）。");
    }, this.options.idleMs);
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
    this.handledApprovals.clear();
    const open = [...(this.approval ? [this.approval.request] : []), ...this.approvalQueue];
    if (this.approval) clearTimeout(this.approval.timer);
    this.approval = null;
    this.approvalQueue = [];
    for (const request of open) this.callbacks.onApprovalResolved(request, false, "closed");
    this.toolsCalled = false;
    this.responding = false;
    this.awaitingCreated = false;
    this.notices = [];
  }

  private setPhase(phase: RealtimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.callbacks.onPhase(phase);
  }
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
