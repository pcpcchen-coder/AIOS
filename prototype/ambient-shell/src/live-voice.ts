import { parseFramelessEvent, type FramelessEvent } from "../shared/frameless.ts";
import { RESULT_UNKNOWN_TEXT, type ApprovalReport, type FallbackOffer, type HostCall, type LiveCoreEvent, type LiveInputKind } from "../shared/realtime-route.ts";
import type { ApprovalOutcome, ApprovalRequest, RealtimeCallbacks, RealtimeDeps, RealtimePhase } from "./realtime.ts";
import type { GreetingOnce, RealtimeSession } from "./realtime-session.ts";
import { FallbackOfferError, GREETING_SETTLE_MS } from "./realtime-session.ts";
import { ApprovalQueue, executeRealtimeTool } from "./realtime-tools.ts";

// ChatGPT 方案路徑（gpt-live-1-codex）的頁面模組。和 RealtimeVoice 用同一份 RealtimeCallbacks（main.ts 建一次）、
// 同一個 ApprovalQueue 與 executeRealtimeTool。差別只在事件的來源：
//  - 模型事件以 frameless 格式在 oai-events 資料通道上到達（parseFramelessEvent）；核心也會轉送 sideband 的逐字稿；
//  - 工具呼叫由核心送來（SSE realtime.host），結果用 POST 交回；
//  - 打字、通知與背景資訊送給核心（POST /api/realtime/input），不寫在資料通道上；
//  - 資料通道上的 delegation.created 一律忽略：核心的 sideband 才是交辦的擁有者。
// 狀態只看裝置與真實事件：麥克風軌道＋peer 已連線＋session.started 才是「聆聽中」；遠端音量才是「回覆中」。

export interface LiveDeps extends Pick<RealtimeDeps, "getMicrophone" | "createPeer" | "playRemote"> {
  /** POST /api/realtime/call {sdp, session_id, owner}；核心提議改路徑時丟 FallbackOfferError。 */
  exchange(offerSdp: string): Promise<string>;
  input(kind: LiveInputKind, text: string): Promise<void>;
  hostResult(callId: string, output: Record<string, unknown>): Promise<void>;
  /** POST /api/realtime/approval；失敗時 LiveVoice 會再試一次。 */
  approval(report: ApprovalReport): Promise<void>;
  end(): Promise<void>;
  /** 只收這個工作階段的 SSE realtime.host／realtime.live。回傳取消訂閱。 */
  subscribe(handlers: { host(call: HostCall): void; core(event: LiveCoreEvent): void }): () => void;
  /** 遠端音量（AnalyserNode RMS），「回覆中」的證據。回傳停止。 */
  watchLevel(stream: MediaStream, onLevel: (rms: number) => void): () => void;
  /** Esc：這條路徑沒有 response.cancel，只能把本機播放靜音到下一輪。 */
  setMuted(muted: boolean): void;
  /** 說出結束原因（瀏覽器語音合成）。 */
  speak(text: string): void;
}

/** 超過這個 RMS 至少 SPEAKING_ON_MS 算在說話；低於它至少 SPEAKING_OFF_MS 算說完。實際門檻在 George 的家中測試調整並記錄。 */
export const SPEAKING_RMS = 0.02;
export const SPEAKING_ON_MS = 150;
export const SPEAKING_OFF_MS = 600;
/** 本機的道別備援：整句是這些時，念完道別就結束（模型也會交辦 end_conversation）。 */
export const LOCAL_GOODBYES = ["再見", "掰掰", "拜拜", "結束對話"] as const;
const END_GRACE_MS = 1_500;
const END_FALLBACK_MS = 10_000;
const DEDUP_TEXT_MS = 10_000;

/** 逐字稿的來源：資料通道（oai-events）或核心轉送的 sideband。 */
type TranscriptSource = "channel" | "core";

export class LiveVoice implements RealtimeSession {
  private phase: RealtimePhase = "off";
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private stopAudio: (() => void) | null = null;
  private stopLevel: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private readonly approvals: ApprovalQueue;
  /** 核心回報正在進行的交辦（真實事件）：「思考中」與閒置暫停。 */
  private readonly delegations = new Set<string>();
  /** 核心送來、頁面還在執行的工具。 */
  private hostCalls = 0;
  private homePending = 0;
  private endRequested = false;
  private speaking = false;
  private levelSince: number | null = null;
  private muted = false;
  /** 聆聽中的證據。 */
  private evidence = { mic: false, peer: false, started: false };
  /** 逐字稿去重：資料通道與核心可能各送一次。有 item_id 時依 item_id。 */
  private readonly seenItems = new Set<string>();
  /**
   * 沒有 item_id 時：每個來源各自記下還沒被另一個來源配對到的逐字稿。另一個來源送來同一句、而且還有沒配對的那一份，
   * 才算同一個事件的重複；同一個來源的重複（使用者 10 秒內又說一次「確認執行」）是真的又說了一次。
   */
  private readonly unmatched: Record<TranscriptSource, Map<string, number[]>> = { channel: new Map(), core: new Map() };
  /** 確認卡狀態的回報要先於工具結果到達核心。 */
  private approvalSync: Promise<void> = Promise.resolve();
  private idleMs: number;
  /** 看著說話開始的工作階段：進入聆聽後請核心送一句招呼（核心組句，用 session.context.append speakable，同 OpenClaw triggerGreeting）。 */
  private readonly greeting: GreetingOnce | null;
  /** 進入聆聽之後等 GREETING_SETTLE_MS 才送招呼；使用者逐字稿（含未完成的）、打字、收起都會取消。 */
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  /** 連線中（進入聆聽之前）打的字：連上後合併成一則送出。 */
  private queuedText: string[] = [];
  fallbackOffer: FallbackOffer | null = null;
  /** 改路徑時還沒送出的連線中打字（openRealtime 交給 API key 的工作階段）。 */
  unsentText: readonly string[] = [];

  constructor(
    private readonly callbacks: RealtimeCallbacks,
    private readonly deps: LiveDeps,
    options: { idleMs: number; approvalMs?: number; greeting?: GreetingOnce | null },
  ) {
    this.idleMs = options.idleMs;
    this.greeting = options.greeting ?? null;
    this.approvals = new ApprovalQueue(
      callbacks,
      {
        generation: () => this.generation,
        notify: (text) => this.notify(text),
        addContext: (text) => this.addContext(text),
        resetIdle: () => this.resetIdle(),
        pendingChanged: (kind, delta) => {
          if (kind === "home") this.homePending = Math.max(0, this.homePending + delta);
        },
        cardChanged: (report) => {
          const generation = this.generation;
          const post = () => (generation === this.generation ? this.deps.approval(report) : undefined);
          // 送不到就再試一次；仍然失敗時，核心會在卡片自己的時限後把它當成已關閉（不會永遠以為卡還開著）。
          this.approvalSync = this.approvalSync
            .then(post)
            .catch(post)
            .catch(() => undefined);
        },
      },
      options.approvalMs ?? 60_000,
    );
  }

  get current(): RealtimePhase {
    return this.phase;
  }

  get on(): boolean {
    return this.phase !== "off";
  }

  get capturing(): boolean {
    return this.on && this.phase !== "connecting";
  }

  get playing(): boolean {
    return this.phase === "speaking";
  }

  get pendingApproval(): ApprovalRequest | null {
    return this.approvals.current;
  }

  setIdleMs(ms: number): void {
    if (ms === this.idleMs) return;
    this.idleMs = ms;
    if (this.on && this.idleTimer) this.resetIdle();
  }

  /** 和 RealtimeVoice.start 一樣：麥克風 → peer → oai-events → offer → 核心 → answer；再加上核心事件與音量。 */
  async start(): Promise<void> {
    if (this.on) return;
    const generation = ++this.generation;
    this.fallbackOffer = null;
    this.unsentText = [];
    this.setPhase("connecting");
    try {
      const mic = await this.deps.getMicrophone();
      if (generation !== this.generation) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      this.mic = mic;
      this.evidence.mic = mic.getAudioTracks().some((t) => (t as { readyState?: string }).readyState !== "ended");
      this.unsubscribe = this.deps.subscribe({
        host: (call) => {
          if (generation === this.generation) this.onHostCall(call, generation);
        },
        core: (event) => {
          if (generation === this.generation) this.onCore(event);
        },
      });
      const peer = this.deps.createPeer();
      this.peer = peer;
      peer.ontrack = (e) => {
        if (this.peer !== peer) return;
        this.stopAudio?.();
        this.stopLevel?.();
        this.stopAudio = this.deps.playRemote(e.streams[0]);
        this.stopLevel = this.deps.watchLevel(e.streams[0], (rms) => this.onLevel(rms));
      };
      peer.onconnectionstatechange = () => {
        if (this.peer !== peer) return;
        if (peer.connectionState === "connected") {
          this.evidence.peer = true;
          this.checkListening();
        }
        if (peer.connectionState === "failed" || peer.connectionState === "closed") this.close("即時語音連線中斷。", true);
      };
      for (const track of mic.getAudioTracks()) peer.addTrack(track, mic);
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (e) => {
        if (this.channel !== channel) return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const event = parseFramelessEvent(raw);
        if (event) this.handle(event);
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const answer = await this.deps.exchange(offer.sdp ?? "");
      if (generation !== this.generation) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      this.resetIdle();
    } catch (err) {
      if (generation !== this.generation) return;
      if (err instanceof FallbackOfferError && err.offer.fallback) {
        // 核心提議改用 API key：安靜地關掉這次（麥克風也關），由 openRealtime 先說計費通知再開新的。
        this.fallbackOffer = err.offer;
        this.unsentText = this.queuedText.splice(0);
        this.generation++;
        this.teardown();
        this.setPhase("off");
        return;
      }
      const name = (err as { name?: string }).name;
      const reason =
        name === "NotAllowedError" ? "麥克風權限被拒絕，無法使用即時語音。"
        : name === "NotFoundError" ? "找不到可用的麥克風。"
        : err instanceof Error ? err.message : "無法開始即時語音。";
      this.close(reason);
    }
  }

  /** 收起：關閉並請核心結束（sideband 送 session.close）。 */
  stop(): void {
    if (!this.on) return;
    this.generation++;
    this.teardown();
    this.setPhase("off");
    void this.deps.end().catch(() => undefined);
  }

  /** 這條路徑沒有 response.cancel：只把本機播放靜音到下一輪回覆，字幕照實說是靜音、不是打斷。 */
  interrupt(): void {
    if (this.phase !== "speaking") return;
    this.muted = true;
    this.deps.setMuted(true);
    this.callbacks.onToolActivity("已靜音這段回覆");
    this.speaking = false;
    this.setPhase(this.delegations.size ? "thinking" : "listening");
  }

  /** 打字：先比對確認卡（打「確認執行」照樣有效），再交給核心（核心當成請求處理）。連線中打的先排隊，進入聆聽後送出。打字一律取消還沒送出的招呼。 */
  sendText(text: string): void {
    this.skipGreeting();
    if (!this.on) return;
    if (!this.capturing) {
      this.queuedText.push(text);
      return;
    }
    this.resetIdle();
    this.approvals.check(text);
    void this.deps.input("user_text", text).catch(() => undefined);
    if (this.phase !== "speaking") this.setPhase("thinking");
  }

  addContext(text: string): void {
    if (!this.capturing) return;
    void this.deps.input("context", text).catch(() => undefined);
  }

  /** 系統通知（任務完成、確認卡的結果）：和 API key 路徑同一句話，經核心送給模型。 */
  notify(text: string): void {
    if (!this.capturing) return;
    void this.deps.input("notice", text).catch(() => undefined);
  }

  resolveApproval(approve: boolean, outcome: ApprovalOutcome): void {
    this.approvals.resolve(approve, outcome);
  }

  private checkListening(): void {
    const { mic, peer, started } = this.evidence;
    if (this.phase === "connecting" && mic && peer && started) {
      this.setPhase("listening");
      const queued = this.queuedText.splice(0);
      if (queued.length) this.sendText(queued.join("\n"));
      this.scheduleGreeting();
    }
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

  /** 真的進入聆聽（三項證據都到）之後：還有待送的招呼就等 GREETING_SETTLE_MS，讓已經在說話的使用者先取消它。 */
  private scheduleGreeting(): void {
    if (this.greeting?.state !== "pending" || this.greetTimer) return;
    this.greetTimer = setTimeout(() => {
      this.greetTimer = null;
      this.greetIfPending();
    }, GREETING_SETTLE_MS);
  }

  /**
   * 等待結束：使用者還沒開口、設定還開著，就請核心送一句可念的招呼。頁面只送互動 ID：短句（「<名字>，我在」或「我在」）
   * 由核心依問候決策組成並直接送進 sideband，名字不經過頁面。決策期間開口、打字或收起都會取消。
   */
  private greetIfPending(): void {
    if (!this.greeting) return;
    const generation = this.generation;
    void this.greeting.take("live").then((interaction) => {
      if (interaction === null || generation !== this.generation || !this.capturing) return;
      void this.deps.input("greeting", interaction).catch(() => undefined);
    });
  }

  /** 逐字稿：資料通道或核心，哪個先到用哪個，依 item_id（沒有時依來源配對）去重。 */
  private transcript(source: TranscriptSource, role: "user" | "assistant", text: string, final: boolean, itemId: string | null): void {
    const clean = text.trim();
    if (!clean) return;
    // 使用者先開口（逐字稿是真實的說話證據，同 OpenClaw 只讓真的逐字稿取消招呼）：這次不打招呼。
    if (role === "user") this.skipGreeting();
    if (!final) {
      if (role === "user") {
        this.resetIdle();
        if (this.phase === "listening") this.setPhase("hearing");
      }
      return;
    }
    const key = itemId ? `${role}:${itemId}` : null;
    if (key) {
      if (this.seenItems.has(key)) return;
      this.seenItems.add(key);
      if (this.seenItems.size > 200) this.seenItems.delete(this.seenItems.values().next().value!);
    } else if (this.isRelayCopy(source, `${role}:${clean}`)) {
      return;
    }
    if (role === "user") {
      this.callbacks.onUserTranscript(clean);
      this.approvals.check(clean);
      this.resetIdle();
      if (this.phase === "hearing" || this.phase === "listening") this.setPhase("thinking");
      if (isLocalGoodbye(clean)) this.requestEnd();
      return;
    }
    this.callbacks.onAssistantTranscript(clean);
    if (this.muted) {
      this.muted = false;
      this.deps.setMuted(false);
    }
    if (!this.speaking && this.phase === "thinking" && !this.delegations.size) this.setPhase("listening");
    if (this.endRequested) this.scheduleEnd(END_GRACE_MS);
  }

  /** 另一個來源已經送過同一句、還沒配對：這份是同一個事件的另一份，配對掉。否則記成這個來源的一份。 */
  private isRelayCopy(source: TranscriptSource, key: string): boolean {
    const now = Date.now();
    const fresh = (list: number[] | undefined) => (list ?? []).filter((at) => now - at < DEDUP_TEXT_MS);
    const other = this.unmatched[source === "channel" ? "core" : "channel"];
    const waiting = fresh(other.get(key));
    if (waiting.length) {
      waiting.shift();
      if (waiting.length) other.set(key, waiting);
      else other.delete(key);
      return true;
    }
    const own = this.unmatched[source];
    own.set(key, [...fresh(own.get(key)), now]);
    if (own.size > 100) own.delete(own.keys().next().value!);
    return false;
  }

  private handle(event: FramelessEvent): void {
    switch (event.kind) {
      case "session.started":
        this.evidence.started = true;
        this.checkListening();
        break;
      case "transcript":
        this.transcript("channel", event.role, event.text, event.final, event.item_id);
        break;
      case "audio.cleared":
        if (this.speaking) {
          this.speaking = false;
          this.setPhase(this.delegations.size ? "thinking" : "listening");
        }
        if (this.muted) {
          this.muted = false;
          this.deps.setMuted(false);
        }
        break;
      case "delegation":
        // 核心的 sideband 處理交辦；頁面看到的這份忽略，不會執行兩次。
        break;
      case "error":
        console.warn("[live]", event.code, event.message);
        break;
    }
  }

  private onCore(event: LiveCoreEvent): void {
    switch (event.kind) {
      case "started":
        this.evidence.started = true;
        this.checkListening();
        break;
      case "transcript":
        this.transcript("core", event.role, event.text, event.final, event.item_id);
        break;
      case "delegation":
        if (event.state === "started") {
          this.delegations.add(event.id);
          if (this.phase === "listening" || this.phase === "hearing") this.setPhase("thinking");
        } else {
          this.delegations.delete(event.id);
          this.resetIdle();
        }
        break;
      case "tool_unknown":
        this.callbacks.onToolActivity(`${RESULT_UNKNOWN_TEXT}（${event.name === "home_control" ? "家電指令" : "交辦工作"}沒有在時限內回報）`);
        break;
      case "closed":
        // sideband 斷線、登入失效、時間到：結束、拆掉 peer、顯示並說出原因。不改路徑。
        if (event.reason !== "ended") this.deps.speak(event.message);
        this.close(event.message, false);
        break;
    }
  }

  /** 核心請頁面執行一個工具：和 API key 路徑同一個 executeRealtimeTool、同一份 callbacks（字幕、腦區、確認卡、任務）。 */
  private onHostCall(call: HostCall, generation: number): void {
    this.hostCalls += 1;
    const post = (output: Record<string, unknown>) => {
      this.hostCalls = Math.max(0, this.hostCalls - 1);
      if (generation !== this.generation) return;
      this.resetIdle();
      // 確認卡的狀態先送到，核心才知道「確認執行」是在回答這張卡。
      void this.approvalSync
        .then(() => (generation === this.generation ? this.deps.hostResult(call.call_id, output) : undefined))
        .catch(() => undefined);
    };
    void executeRealtimeTool(call.name, call.arguments, {
      callbacks: this.callbacks,
      approvals: this.approvals,
      generation,
      stale: (g) => g !== this.generation,
      end: () => {
        this.requestEnd();
        post({ ok: true });
      },
      deliver: post,
    });
  }

  private requestEnd(): void {
    this.endRequested = true;
    this.scheduleEnd(END_FALLBACK_MS);
  }

  /** 念完道別才結束：還在說話就等音量降下來。 */
  private scheduleEnd(ms: number): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      if (this.speaking) {
        this.scheduleEnd(END_GRACE_MS);
        return;
      }
      this.close("對話已結束。");
    }, ms);
  }

  private onLevel(rms: number): void {
    if (!this.on) return;
    const now = Date.now();
    const loud = rms >= SPEAKING_RMS && !this.muted;
    if (loud !== this.speaking) {
      if (this.levelSince === null) this.levelSince = now;
      if (now - this.levelSince >= (loud ? SPEAKING_ON_MS : SPEAKING_OFF_MS)) {
        this.speaking = loud;
        this.levelSince = null;
        if (loud) {
          if (this.phase !== "connecting") this.setPhase("speaking");
        } else {
          this.resetIdle();
          if (this.phase === "speaking") this.setPhase(this.delegations.size ? "thinking" : "listening");
        }
      }
    } else {
      this.levelSince = null;
    }
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.speaking || this.delegations.size > 0 || this.hostCalls > 0 || this.homePending > 0) {
        this.resetIdle();
        return;
      }
      this.close("一段時間沒有說話，即時語音已結束（避免持續使用額度）。");
    }, this.idleMs);
  }

  /** ended：核心已經知道（closed 事件）時不用再叫 end。 */
  private close(reason: string, tellCore = true): void {
    if (!this.on) return;
    this.generation++;
    this.teardown();
    this.setPhase("off");
    if (tellCore) void this.deps.end().catch(() => undefined);
    this.callbacks.onClosed(reason);
  }

  private teardown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.endRequested = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelGreetTimer();
    this.queuedText = [];
    this.channel?.close();
    this.channel = null;
    this.peer?.close();
    this.peer = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.stopLevel?.();
    this.stopLevel = null;
    this.stopAudio?.();
    this.stopAudio = null;
    if (this.muted) this.deps.setMuted(false);
    this.muted = false;
    this.speaking = false;
    this.levelSince = null;
    this.delegations.clear();
    this.hostCalls = 0;
    this.homePending = 0;
    this.evidence = { mic: false, peer: false, started: false };
    this.unmatched.channel.clear();
    this.unmatched.core.clear();
    this.approvals.clear();
  }

  private setPhase(phase: RealtimePhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.callbacks.onPhase(phase);
  }
}

export function isLocalGoodbye(text: string): boolean {
  const t = text.replace(/[\s，。、！？!?,.「」『』"'～~]/g, "");
  return (LOCAL_GOODBYES as readonly string[]).includes(t);
}

/** 瀏覽器實際使用的遠端音量量測（AnalyserNode RMS，每 50 毫秒）。 */
export function browserWatchLevel(stream: MediaStream, onLevel: (rms: number) => void): () => void {
  const AudioCtx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!AudioCtx) return () => {};
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const v of buffer) sum += v * v;
    onLevel(Math.sqrt(sum / buffer.length));
  }, 50);
  return () => {
    clearInterval(timer);
    source.disconnect();
    void ctx.close().catch(() => undefined);
  };
}
