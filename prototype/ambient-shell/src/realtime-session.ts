import type { GreetingRoute } from "../shared/identity.ts";
import type { FallbackOffer, RouteId, StartDecision } from "../shared/realtime-route.ts";
import { plainGreetingInstructions } from "../shared/sense.ts";
import { getLocale, type Locale } from "./i18n.ts";
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
  /** 改路徑時：連線中打的、這個工作階段還沒送出的字（openRealtime 交給下一個工作階段）。 */
  readonly unsentText?: readonly string[];
}

// 編譯期檢查：API key 路徑的類別不用改就符合接縫。
export type GaFitsSeam = RealtimeVoice extends RealtimeSession ? true : never;
const gaFits: GaFitsSeam = true;
void gaFits;

/** 誰開始了這次即時語音：只有看著說話（鏡頭）開始的會打招呼；按鈕、語音指令、打字、同意說明後開始的都是 user。 */
export type RealtimeStartSource = "look_to_talk" | "user";

/**
 * 問候的生命週期（和辨識結果分開，docs/14 §3）：pending → deciding（向核心要問候決策）→ sent；
 * 使用者先開口、打字、收起或設定關閉時 → skipped。deciding 期間取消也算 skipped，決策回來後不送。
 */
export type GreetingState = "pending" | "deciding" | "sent" | "skipped";

/**
 * 工作階段就緒（API key：session.created；ChatGPT 方案：麥克風＋peer＋session.started）之後，等這麼久才送招呼，
 * 讓「已經在說話的使用者」有時間產生取消招呼的證據（API key：input_audio_buffer.speech_started；ChatGPT 方案：使用者逐字稿，含未完成的）。
 * 這兩個事件都要等聲音送到伺服器、VAD／轉寫判斷之後才回來，至少一個網路來回加上偵測，約數百毫秒；
 * 600 ms 留一些餘裕，同時讓招呼在就緒後約一秒內開始，聽起來仍是「馬上」。
 * OpenClaw FaceTime（talk-driver.ts FACETIME_GREETING_MEDIA_SETTLE_MS = 100）只等媒體路由穩定，所以短得多。
 * 這是估計值，沒有量測過：家中實測（docs/validation/look-to-talk-greet-2026-10-23.md 第 1、4 項）記錄是否合適。
 */
export const GREETING_SETTLE_MS = 600;

/**
 * 送出前向核心要的內容（docs/14 §6）。api_key：這一輪 response.create 的 instructions（只含核心組好的短句）；
 * live：POST /api/realtime/input greeting 的文字，只是互動 ID，短句留在核心、由核心自己送進 sideband。
 */
export type GreetingDecide = (route: GreetingRoute) => Promise<string>;

/** 不稱名的內容：瀏覽器版、沒有辨識或決策失敗時用。API key 是固定的「我在」指示；live 只送互動 ID（核心取不到決策就送「我在」）。 */
export function plainGreeting(interaction: string, locale: Locale = getLocale()): GreetingDecide {
  return async (route) => (route === "api_key" ? plainGreetingInstructions(locale) : interaction);
}

/** 一次看著說話開始的互動 ID（頁面亂數產生；不含身分，核心只拿來配對問候決策）。 */
export function newInteractionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `int_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface GreetingOptions {
  locale?: Locale;
  /** 這次互動的 ID（看著說話開始時建立；同一次的 live 與 API key 工作階段共用）。 */
  interaction?: string;
  /** 送出前的決策（macOS App：經 IPC 問核心）；未提供時不稱名。 */
  decide?: GreetingDecide;
  /** 問候結束（sent 或 skipped）時呼叫一次：頁面停止為這次互動取樣。 */
  settled?: (state: "sent" | "skipped") => void;
}

/**
 * 看著說話開始的即時語音要打的一次招呼（George 2026-10-23；ID-02 起內容由核心決定）。一次 startRealtime 建一個，
 * 改路徑時兩個工作階段共用同一個物件，所以整次對話最多打一次招呼。
 * - 工作階段確定連上（API key：session.created；ChatGPT 方案：麥克風＋peer＋session.started）之後再等 GREETING_SETTLE_MS 才呼叫 take()；
 * - 使用者在那之前（含等待與決策的這段時間）先開口或打字：skip()，這次不打招呼；
 * - take() 當下再讀一次設定（設定改了立即生效）：關了就不打；決策回來後再讀一次。
 * - 一旦標記 sent 就不再送（送出狀態未知時也不重送，docs/14 I6）。
 */
export class GreetingOnce {
  private readonly locale: Locale;
  private value: GreetingState = "pending";
  readonly interaction: string;
  private readonly decide: GreetingDecide;
  private readonly settled: (state: "sent" | "skipped") => void;

  constructor(
    private readonly enabled: () => boolean = () => true,
    options: GreetingOptions = {},
  ) {
    this.interaction = options.interaction ?? newInteractionId();
    this.locale = options.locale ?? getLocale();
    this.decide = options.decide ?? plainGreeting(this.interaction, this.locale);
    this.settled = options.settled ?? (() => {});
  }

  get state(): GreetingState {
    return this.value;
  }

  /** 還沒打過、沒被取消、設定還開著：向核心要內容並標記已送出；否則 null。 */
  async take(route: GreetingRoute): Promise<string | null> {
    if (this.value !== "pending") return null;
    if (!this.enabled()) {
      this.finish("skipped");
      return null;
    }
    this.value = "deciding";
    let payload: string;
    try {
      payload = await this.decide(route);
    } catch {
      // 決策失敗（IPC 錯誤、核心重新啟動）：照常問候，但不帶名字。
      payload = await plainGreeting(this.interaction, this.locale)(route);
    }
    if (this.value !== "deciding") return null;
    if (!this.enabled()) {
      this.finish("skipped");
      return null;
    }
    this.finish("sent");
    return payload;
  }

  /** 使用者先開口（或打字、收起）：還沒送出的招呼不再送（含正在等決策的）。已送出的不受影響。 */
  skip(): void {
    if (this.value === "pending" || this.value === "deciding") this.finish("skipped");
  }

  private finish(state: "sent" | "skipped"): void {
    this.value = state;
    this.settled(state);
  }
}

/**
 * 這次開始要不要打招呼：看著說話開始的一律建立 GreetingOnce，「看著說話時先打招呼」在要送出的那一刻（take()）才讀，
 * 所以連線中才在設定畫面或用語音打開也會打招呼、關掉就不打。其他開始方式回 null。
 */
export function greetingFor(source: RealtimeStartSource, greetOn: () => boolean, options: GreetingOptions = {}): GreetingOnce | null {
  if (source !== "look_to_talk") return null;
  return new GreetingOnce(greetOn, options);
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
  // live 連線中打的字沒送出：交給 API key 的工作階段（它連線中會先排隊，連上後送出）。
  for (const text of first.unsentText ?? []) second.sendText(text);
  return second;
}

/** POST /api/realtime/call 回 409 而且帶改路徑提議。 */
export class FallbackOfferError extends Error {
  constructor(readonly offer: FallbackOffer) {
    super(offer.error);
  }
}
