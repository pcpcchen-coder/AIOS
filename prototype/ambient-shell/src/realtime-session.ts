import type { FallbackOffer, RouteId, StartDecision } from "../shared/realtime-route.ts";
import type { ApprovalOutcome, ApprovalRequest, RealtimePhase, RealtimeVoice } from "./realtime.ts";

// 頁面唯一的接縫：main.ts 只跟 RealtimeSession 說話，不直接碰哪條路徑的類別。
// RealtimeVoice（API key，公開 API 不變）與 LiveVoice（ChatGPT 方案）都符合它。

/** main.ts 今天在 realtime 上用到的成員。 */
export interface RealtimeSession {
  readonly current: RealtimePhase;
  readonly on: boolean;
  readonly capturing: boolean;
  readonly playing: boolean;
  readonly pendingApproval: ApprovalRequest | null;
  start(): Promise<void>;
  stop(): void;
  interrupt(): void;
  sendText(text: string): void;
  addContext(text: string): void;
  notify(text: string): void;
  setIdleMs(ms: number): void;
  resolveApproval(approve: boolean, outcome: ApprovalOutcome): void;
  /** live 建立失敗、auto 可以改路徑時，核心給的改路徑提議（start() 結束後讀）。 */
  readonly fallbackOffer?: FallbackOffer | null;
}

// 編譯期檢查：API key 路徑的類別不用改就符合接縫。
export type GaFitsSeam = RealtimeVoice extends RealtimeSession ? true : never;
const gaFits: GaFitsSeam = true;
void gaFits;

/** 誰開始了這次即時語音：只有看著說話（鏡頭）開始的會打招呼；按鈕、語音指令、打字、同意說明後開始的都是 user。 */
export type RealtimeStartSource = "look_to_talk" | "user";

export type GreetingState = "pending" | "sent" | "skipped";

/**
 * 看著說話開始的即時語音要打的一次招呼（George 2026-10-23）。一次 startRealtime 建一個，
 * 改路徑時兩個工作階段共用同一個物件，所以整次對話最多打一次招呼。
 * - 工作階段確定連上（API key：session.created；ChatGPT 方案：麥克風＋peer＋session.started）時呼叫 take()；
 * - 使用者在那之前先開口或打字：skip()，這次不打招呼；
 * - take() 當下再讀一次設定（設定改了立即生效）：關了就不打。
 */
export class GreetingOnce {
  private value: GreetingState = "pending";

  constructor(
    readonly instructions: string,
    private readonly enabled: () => boolean = () => true,
  ) {}

  get state(): GreetingState {
    return this.value;
  }

  /** 還沒打過、沒被取消、設定還開著：回傳要給模型的指示並標記已送出；否則 null。 */
  take(): string | null {
    if (this.value !== "pending") return null;
    if (!this.enabled()) {
      this.value = "skipped";
      return null;
    }
    this.value = "sent";
    return this.instructions;
  }

  /** 使用者先開口（或打字）：還沒送出的招呼不再送。已送出的不受影響。 */
  skip(): void {
    if (this.value === "pending") this.value = "skipped";
  }
}

/**
 * 這次開始要不要打招呼：只有看著說話開始、而且「看著說話時先打招呼」開著時才建立 GreetingOnce。
 * enabled 在連上的那一刻再讀一次（設定畫面或語音改了立即生效）。
 */
export function greetingFor(source: RealtimeStartSource, greetOn: () => boolean, instructions: string): GreetingOnce | null {
  if (source !== "look_to_talk" || !greetOn()) return null;
  return new GreetingOnce(instructions, greetOn);
}

/** 還沒開始過的即時語音：main.ts 載入時讀 on／current 等都安全。 */
export function idleSession(): RealtimeSession {
  return {
    current: "off",
    on: false,
    capturing: false,
    playing: false,
    pendingApproval: null,
    start: async () => {},
    stop: () => {},
    interrupt: () => {},
    sendText: () => {},
    addContext: () => {},
    notify: () => {},
    setIdleMs: () => {},
    resolveApproval: () => {},
  };
}

export interface SessionDecision {
  route: RouteId;
  session_id: string;
  owner: string;
  model: string;
  billing_line: string;
}

export interface OpenRealtimeDeps {
  /** POST /api/realtime/start。 */
  start(): Promise<StartDecision>;
  makeSession(decision: SessionDecision): RealtimeSession;
  /** 說出並顯示計費通知（字幕＋語音）；麥克風開之前呼叫。 */
  announce(notice: string): Promise<void>;
  /** 兩條路徑都不能用：照實說原因。 */
  refused(message: string): void;
  /** 這次真的開始的路徑（引擎列、設定）。 */
  began(session: RealtimeSession, decision: SessionDecision): void;
}

/**
 * 開始即時語音；頁面唯一可能改路徑的地方：
 * 1. decision = start()；拒絕 → refused(原因)（例如「ChatGPT 方案路徑尚未登入；未設定 OPENAI_API_KEY」）。
 * 2. decision.notice（auto 改用 API key）→ 開麥克風前 announce(notice)。
 * 3. session = makeSession(decision)；await session.start()。
 * 4. live 建立失敗而核心提議改路徑（fallbackOffer.fallback）：live 的麥克風已經關掉，
 *    先 announce 計費通知，再開 API key 的工作階段（麥克風這時才再開）。最多一次；進入聆聽之後不會發生。
 * signal：使用者在等待期間按 Esc、收起或人離開（stopRealtime／closeConversation 會中止它）。每個 await 之後都檢查；
 * 已中止就不再開新的工作階段，已經開始的那個立刻 stop()（麥克風不會在使用者收起之後才打開）。
 */
export async function openRealtime(deps: OpenRealtimeDeps, signal?: AbortSignal): Promise<RealtimeSession | null> {
  const cancelled = () => !!signal?.aborted;
  const decision = await deps.start();
  if (cancelled()) return null;
  if (!decision.ok) {
    deps.refused(decision.message);
    return null;
  }
  if (decision.notice) await deps.announce(decision.notice);
  if (cancelled()) return null;
  const first = deps.makeSession(decision);
  deps.began(first, decision);
  await first.start();
  if (cancelled()) {
    first.stop();
    return null;
  }
  const offer = first.fallbackOffer;
  if (!offer?.fallback) return first;
  await deps.announce(offer.fallback.notice);
  if (cancelled()) return null;
  const second = deps.makeSession(offer.fallback);
  deps.began(second, offer.fallback);
  await second.start();
  if (cancelled()) {
    second.stop();
    return null;
  }
  return second;
}

/** POST /api/realtime/call 回 409 而且帶改路徑提議。 */
export class FallbackOfferError extends Error {
  constructor(readonly offer: FallbackOffer) {
    super(offer.error);
  }
}
