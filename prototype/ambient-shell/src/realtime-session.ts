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
