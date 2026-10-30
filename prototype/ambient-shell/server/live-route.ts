import { translate, type Locale } from "../shared/i18n.mjs";
import { randomUUID } from "node:crypto";
import type { RealtimeBaseInfo } from "../shared/types.ts";
import { chunkForAppend, parseFramelessEvent, type FramelessEvent } from "../shared/frameless.ts";
import { GREETING_PLAIN, liveGreetingText } from "../shared/sense.ts";
import { billingLine, LIVE_STOP_REPORT_MS, LIVE_VOICES, unavailableText, type LiveCoreEvent, type LiveInputKind, type LiveVoiceId, type RouteOption, type UnavailableReason } from "../shared/realtime-route.ts";
import { CodexAuthError, CodexUnauthorized, NOUS_ORIGINATOR, type CodexAuth, type CodexRequestAuth } from "./codex-auth.ts";
import { redact } from "./codex-responses.ts";
import type { DelegationRequest, DelegationResult, LiveCallerMemory, TranscriptTurn } from "./live-tool-caller.ts";
import { confirmLine, type LiveCallPort, type LiveMemoryPort, type RevokeWhy, type VoiceDelegatePort } from "./memory/live.ts";
import { RouteStartError, type ApprovalSnapshot, type LiveControl, type Readiness, type RealtimeRoute, type RouteCall, type SessionContext } from "./realtime-routes.ts";

// 即時語音的 ChatGPT 方案路徑：gpt-live-1-codex，用 Nous 自己的 Codex 登入。負責 chatgpt.com 的通話建立與
// api.openai.com 的 sideband；網址、標頭與 frameless 的線路事件只在這個檔案（與共用的 shared/frameless.ts 解析器）。
//
// 對照：
//  通話   POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas
//         （OpenClaw realtime-quicksilver-wire.ts:27-28；Codex realtime_call.rs:213-224、:677）
//  內容   JSON {sdp, session:{instructions, audio:{output:{voice}}, delegation:{type:"client"}, model?}}
//  標頭   Authorization、chatgpt-account-id、OpenAI-Alpha: quicksilver=v2、session-id／thread-id／x-session-id（三個新的 UUID）、
//         originator: nous、User-Agent、Content-Type: application/json；沒有 OpenAI-Beta（wire.ts:227-250）
//  回應   本文是 answer SDP；call id 取 Location 的 rtc_… 或 UUID，沒有時取 openai-session-id（wire.ts:311-344）
//  sideband wss://api.openai.com/v1/live/{callId}，同樣的驗證、alpha 與 id；v3 WebRTC 不送 session.update
//         （wire.ts:500-506；Codex methods.rs:2497-2520、:1237-1243）
//  送出   delegation.context.append、session.context.append（每段 ≤500 bytes）、session.close
//  WS     Node 22 內建的 WebSocket 接受 {headers}（不需要 ws 套件；tests/fixtures/fake-sideband.ts 實際驗證標頭有送到）。

export const LIVE_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
export const LIVE_SIDEBAND_URL = (callId: string) => `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`;

export const LIVE_TIMEOUTS_MS = {
  /** 通話建立（OpenClaw session.ts:59 用 30 秒）。 */
  call: 30_000,
  /** 每次 sideband 連線嘗試（OpenClaw sideband.ts:16-21）。 */
  sidebandAttempt: 15_000,
  /** 伺服器沒有給 expires_at 時的工作階段上限（OpenClaw session.ts:57）。 */
  session: 30 * 60_000,
  /** 交辦超過這麼久而且真的有工具還在跑：說一次「還在處理」（真實事件，不是假進度）。 */
  progressNote: 10_000,
  /** 開始失敗改路徑時，嘗試掛斷剛建立的通話。 */
  hangup: 3_000,
} as const;
export const SIDEBAND_ATTEMPTS = 5;
/**
 * MEM-2：撤銷記憶後等頁面回報「已停播」的最長時間（定義在 shared/realtime-route.ts）。逾時就強制靜音（Electron setAudioMuted）
 * 並停用這條路徑的記憶到重新啟動；boundary 的 live cleanup 時限（LIVE_CLEANUP_MS 3 秒）比它長。
 */
export { LIVE_STOP_REPORT_MS };
/** 嘗試之間的等待：200·2^n 毫秒（0.2＋0.4＋0.8＋1.6＝3 秒）。 */
export const sidebandBackoffMs = (attempt: number) => 200 * 2 ** attempt;
/**
 * 等 answer SDP 的最長時間（docs/validation/live-voice-2026-10-23.md 用這些常數計算）：
 * 通話 30 秒 ＋ 5 × 15 秒 ＋ 3 秒 ＝ 108 秒。
 */
export const ANSWER_BOUND_MS =
  LIVE_TIMEOUTS_MS.call + SIDEBAND_ATTEMPTS * LIVE_TIMEOUTS_MS.sidebandAttempt + Array.from({ length: SIDEBAND_ATTEMPTS - 1 }, (_, n) => sidebandBackoffMs(n)).reduce((a, b) => a + b, 0);

const TRANSCRIPT_RING = 12;
const ANSWER_MAX_BYTES = 256 * 1024;

export { callIdFrom, openSidebandSocket, type SidebandSocket, type SidebandSocketCtor } from "./sideband.ts";
import { openSidebandSocket, callIdFrom, type SidebandSocket, type SidebandSocketCtor } from "./sideband.ts";

export interface DelegationRunner {
  run(request: DelegationRequest, signal: AbortSignal): Promise<DelegationResult>;
}

export interface LiveRouteOptions {
  auth: Pick<CodexAuth, "readiness" | "withAuth">;
  /** realtime.json live_voice（預設 NOUS_LIVE_VOICE，再沒有就是 cove）；邊界已驗證在 LIVE_VOICES 內。 */
  voice: () => LiveVoiceId;
  /** NOUS_LIVE_MODEL：一定顯示（預設 gpt-live-1-codex），只有明確設定時才送出（伺服器可能拒絕 session.model）。 */
  model: { display: string; send: string | null };
  /**
   * 每個工作階段一個 caller（自己的逐字稿與中止範圍）。memory：MEM-2 這通通話的記憶（沒有記憶層時為 null）。
   * voice：MEM-4b 的受保護語音交辦（task 與 live 都放行、記憶開著時才有）。
   */
  caller: (ctx: SessionContext, memory?: LiveCallerMemory | null, voice?: VoiceDelegatePort | null) => DelegationRunner;
  /** buildLiveInstructions(tasks, now, caps)。 */
  instructions: (ctx: SessionContext, memory?: boolean) => string;
  /** 這條路徑提供的工具（給設定畫面的文字）。 */
  capabilities: () => { webSearch: boolean; home: boolean };
  clientVersion: string;
  /**
   * 看著說話的問候（ID-02）：頁面 POST greeting 帶來的文字只當成互動 ID，交給這個函式取核心已組好的短句
   * （IdentityService.takeLiveGreeting）。沒有提供或取不到時送「我在」（LIVE_GREETING_TEXT）。頁面的文字永遠不會成為內容。
   */
  greeting?: (interaction: string, sessionId: string, locale?: Locale) => LiveGreeting | null;
  /** MEM-2：每通通話的記憶（MemoryService.openLive）；沒有記憶層（瀏覽器版）時不提供。 */
  memory?: (ctx: SessionContext) => LiveMemoryPort | null;
  fetch?: typeof fetch;
  WebSocket?: SidebandSocketCtor;
  urls?: { call: string; sideband: (callId: string) => string };
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** 核心挑好的開場：送進 sideband 的整段文字，以及要念的那一句（用來在逐字稿緩衝裡認出問候、交辦時遮掉）。 */
export interface LiveGreeting {
  text: string;
  sentence: string;
  /** 問候有沒有稱名（MEM-2：只有稱名過，臉部候選的問句才帶名字）。 */
  named?: boolean;
}

/** 比對用：去掉空白與標點（模型可能多一個驚嘆號或句號）。 */
function normalizeSpoken(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/**
 * 這一則助理逐字稿是不是開場問候（審查 2026-10-25，George 要求交辦時遮掉）：包含核心送出的那一句，
 * 或是那一句被打斷時的開頭（「George，我」）。
 */
export function isGreetingTurn(text: string, sentence: string): boolean {
  const t = normalizeSpoken(text);
  const s = normalizeSpoken(sentence);
  return t.length > 0 && s.length > 0 && (t.includes(s) || s.startsWith(t));
}

export class LiveRoute implements RealtimeRoute {
  readonly id = "live" as const;
  private readonly fetch: typeof fetch;
  private readonly WS: SidebandSocketCtor;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: LiveRouteOptions) {
    this.fetch = options.fetch ?? fetch;
    // Node 22 的 WebSocket 型別只宣告 protocols，實際接受 {headers}（undici）：唯一的轉型在這裡。
    this.WS = options.WebSocket ?? (globalThis.WebSocket as unknown as SidebandSocketCtor);
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  readiness(): Readiness {
    return this.options.auth.readiness();
  }

  private toolsText(): string {
    const caps = this.options.capabilities();
    return [caps.webSearch ? "上網查詢（Codex 額度）" : null, caps.home ? "家電查詢與控制" : null, "交辦工作"].filter(Boolean).join("、");
  }

  describe(): RouteOption {
    const ready = this.readiness();
    const model = this.options.model.display;
    return {
      id: "live",
      available: ready.ready,
      reason: ready.ready ? null : ready.reason,
      billing_line: billingLine("live", model),
      model,
      voice: this.options.voice(),
      voices: LIVE_VOICES,
      tools: `${this.toolsText()}；MCP 在 ChatGPT 方案路徑不可用`,
      detail: ready.ready ? `ChatGPT 方案（Codex 登入，${model}），用方案的 Codex 額度；工具：${this.toolsText()}；MCP 不可用` : ready.message,
    };
  }

  baseInfo(): RealtimeBaseInfo {
    const ready = this.readiness();
    const caps = this.options.capabilities();
    return {
      available: ready.ready,
      model: this.options.model.display,
      web_search: ready.ready && caps.webSearch,
      home: caps.home,
      mcp: [],
      detail: this.describe().detail,
    };
  }

  /**
   * 1. withAuth：POST 通話（30 秒）。400＋session.model → model_rejected（不能改路徑）；403 → forbidden（附聲音）；
   *    429／usage_limit → usage_limit；401 更新後仍 401 → needs_reauth；5xx／網路 → upstream／network。錯誤文字去掉權杖。
   * 2. 依 Location 取 call id，接上 sideband（最多 5 次）。接不上 → RouteStartError(upstream, 可改路徑)，
   *    而且不回傳 answer（頁面不會連上一個沒人服務的通話），並嘗試掛斷。
   * 3. 回傳 LiveCall，開始處理 sideband 事件。
   * MEM-2：有記憶層時由 LiveMemoryPort.connect 決定要不要帶記憶；帶的話 withVoiceContext 包住整個連線（lease 持有到
   * call.closed），記憶區塊附在 instructions 最後；握手中被撤銷時中止請求，照實說沒有開始（不改用 API key）。
   */
  async connect(offerSdp: string, ctx: SessionContext): Promise<RouteCall> {
    const memory = this.options.memory?.(ctx) ?? null;
    if (!memory) return this.open(offerSdp, ctx, null, null, null);
    try {
      return await memory.connect((block, signal, active) => this.open(offerSdp, ctx, block, signal, memory, active));
    } catch (err) {
      memory.close();
      throw err;
    }
  }

  /** memoryActive：記憶開著而且有 codex 同意時才加記憶規則（否則和 MEM-2 之前一樣）。 */
  private async open(offerSdp: string, ctx: SessionContext, block: string | null, signal: AbortSignal | null, memory: LiveMemoryPort | null, memoryActive = false): Promise<LiveCall> {
    const ids = { "session-id": randomUUID(), "thread-id": randomUUID(), "x-session-id": randomUUID() };
    const voice = this.options.voice();
    const revoked = () => new RouteStartError("upstream", 409, "記憶在連線期間更新了，這次即時語音沒有開始；請再開始一次。", false);
    const base = this.options.instructions(ctx, memoryActive);
    const session: Record<string, unknown> = {
      instructions: block ? `${base}\n${block}` : base,
      audio: { output: { voice } },
      delegation: { type: "client" },
    };
    if (this.options.model.send) session.model = this.options.model.send;
    const urls = this.options.urls ?? { call: LIVE_CALL_URL, sideband: LIVE_SIDEBAND_URL };

    const created = await this.guard(() =>
      this.options.auth.withAuth(async (auth) => {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), LIVE_TIMEOUTS_MS.call);
        let res: Response;
        try {
          res = await this.fetch(urls.call, {
            method: "POST",
            headers: { ...this.headers(auth, ids), "Content-Type": "application/json" },
            body: JSON.stringify({ sdp: offerSdp, session }),
            signal: signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal,
          });
        } catch {
          clearTimeout(timer);
          if (signal?.aborted) throw revoked();
          throw timeout.signal.aborted
            ? new RouteStartError("network", 504, `${unavailableText("network")}（建立通話逾時 ${LIVE_TIMEOUTS_MS.call / 1000} 秒）`, true)
            : new RouteStartError("network", 502, unavailableText("network"), true);
        }
        try {
          if (res.status === 401) {
            await res.text().catch(() => "");
            throw new CodexUnauthorized();
          }
          const raw = await readBounded(res, ANSWER_MAX_BYTES);
          if (!res.ok) throw callError(res.status, raw, voice);
          if (!raw.startsWith("v=0")) throw new RouteStartError("upstream", 502, unavailableText("upstream", { message: "回應不是 SDP" }), true);
          const callId = callIdFrom(res.headers.get("location"), res.headers.get("openai-session-id"));
          if (!callId) throw new RouteStartError("upstream", 502, unavailableText("upstream", { message: "回應沒有通話 ID" }), true);
          return { answer: raw, callId };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    let socket: SidebandSocket | null = null;
    for (let attempt = 0; attempt < SIDEBAND_ATTEMPTS && !socket && !signal?.aborted; attempt++) {
      // 握手中被撤銷：等待與連線嘗試都立刻中斷，不讓 cleanup 超過 boundary 的時限而誤停用整條路徑。
      if (attempt > 0) await this.abortableSleep(sidebandBackoffMs(attempt - 1), signal);
      if (signal?.aborted) break;
      socket = await this.guard(() => this.options.auth.withAuth((auth) => this.openSocket(urls.sideband(created.callId), this.headers(auth, ids), LIVE_TIMEOUTS_MS.sidebandAttempt, signal))).catch(() => null);
    }
    if (signal?.aborted) {
      // 握手中被撤銷（換人、忘記…）：掛斷剛建立的通話，不交出 answer。
      if (socket) {
        try {
          socket.send(JSON.stringify({ type: "session.close" }));
          socket.close();
        } catch {
          // 已關閉
        }
      } else void this.hangup(urls.sideband(created.callId), ids);
      throw revoked();
    }
    if (!socket) {
      this.options.log?.("即時語音（ChatGPT 方案）：sideband 接不上，這次沒有開始");
      // 改路徑前盡力掛斷已建立的通話（只能經 sideband 送 session.close；仍接不上時，瀏覽器沒有拿到 answer，媒體不會連上）。
      void this.hangup(urls.sideband(created.callId), ids);
      throw new RouteStartError("upstream", 502, unavailableText("upstream", { message: "接不上控制連線（sideband）" }), true);
    }
    const call = new LiveCall(created.answer, this.options.model.display, socket, ctx, this.options.caller, memory, this.options.log, this.options.greeting);
    memory?.bind(call);
    return call;
  }

  /** 盡力掛斷：再試一次 sideband（短時限），接上就送 session.close。 */
  private async hangup(url: string, ids: Record<string, string>): Promise<void> {
    try {
      const socket = await this.options.auth.withAuth((auth) => this.openSocket(url, this.headers(auth, ids), LIVE_TIMEOUTS_MS.hangup));
      socket.send(JSON.stringify({ type: "session.close" }));
      socket.close();
      this.options.log?.("即時語音（ChatGPT 方案）：已掛斷沒有用到的通話");
    } catch {
      // 掛不斷：見上面的說明
    }
  }

  private headers(auth: CodexRequestAuth, ids: Record<string, string>): Record<string, string> {
    return {
      ...auth.headers(),
      "OpenAI-Alpha": "quicksilver=v2",
      ...ids,
      originator: NOUS_ORIGINATOR,
      "User-Agent": `nous/${this.options.clientVersion}`,
    };
  }

  /** backoff 的等待；signal 中止時立刻結束。 */
  private abortableSleep(ms: number, signal: AbortSignal | null): Promise<void> {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      void this.sleep(ms).then(done);
    });
  }

  /** 開一條 sideband；open 才 resolve，錯誤、關閉、逾時或 signal 中止 reject（中止時關掉 socket）。 */
  private openSocket(url: string, headers: Record<string, string>, timeoutMs: number = LIVE_TIMEOUTS_MS.sidebandAttempt, signal: AbortSignal | null = null): Promise<SidebandSocket> {
    return openSidebandSocket(this.WS, url, headers, timeoutMs, signal);
  }

  /** 把登入錯誤轉成開始錯誤（可以改路徑：使用者沒做錯設定，只是這條路徑現在不能用）。 */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof RouteStartError) throw err;
      if (err instanceof CodexAuthError) throw new RouteStartError(err.reason, err.reason === "network" ? 502 : 401, err.message, true);
      throw new RouteStartError("upstream", 502, unavailableText("upstream", { message: redact((err as Error).message) }), true);
    }
  }
}

function callError(status: number, raw: string, voice: string): RouteStartError {
  let code: string | null = null;
  let message = "";
  let resetsAt: number | null = null;
  try {
    const body = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown; resets_at?: unknown } | string; detail?: unknown };
    const err = typeof body.error === "object" && body.error ? body.error : null;
    code = typeof err?.code === "string" ? err.code : null;
    message = typeof err?.message === "string" ? err.message : typeof body.error === "string" ? body.error : typeof body.detail === "string" ? body.detail : "";
    resetsAt = typeof err?.resets_at === "number" ? err.resets_at : null;
  } catch {
    message = raw.slice(0, 200);
  }
  if (status === 400 && /session\.model|not allowed/i.test(`${message} ${raw}`)) {
    return new RouteStartError("model_rejected", 400, unavailableText("model_rejected"), false);
  }
  if (status === 429 || (code && /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code))) {
    const resetsInMin = resetsAt !== null ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000)) : null;
    return new RouteStartError("usage_limit", 429, unavailableText("usage_limit", { resetsInMin }), true);
  }
  if (status === 403) return new RouteStartError("forbidden", 403, unavailableText("forbidden", { voice }), true);
  const safe = redact(message);
  return new RouteStartError("upstream" satisfies UnavailableReason, 502, unavailableText("upstream", { message: `HTTP ${status}${safe ? `：${safe}` : ""}` }), true);
}

async function readBounded(res: Response, max: number): Promise<string> {
  const text = await res.text().catch(() => "");
  return new TextEncoder().encode(text).length > max ? "" : text;
}

/** 一個進行中的 live 工作階段。只在這個模組內。 */
class LiveCall implements RouteCall, LiveCallPort {
  readonly route = "live" as const;
  readonly control: LiveControl;
  /** sideband 回報的最近幾輪（裝置回報的逐字稿），給 caller 當上下文。 */
  private readonly transcript: TranscriptTurn[] = [];
  /** 這個工作階段見過的交辦 ID（永久保留）：晚到的重複事件不會再跑一次。 */
  private readonly seen = new Set<string>();
  /** 診斷用：已記過的未處理事件類型。 */
  private readonly unhandled = new Set<string>();
  /** 交辦一個接一個（兩個家電請求不會交錯，同 OpenClaw）。 */
  private chain: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();
  /** 已結束（送過 session.close 或 sideband 已斷）：之後不送任何東西。 */
  private ended = false;
  private started = false;
  /** MEM-2：記憶已撤銷；從這一刻起 send() 拒絕所有 append，晚到的結果一律丟掉。 */
  private revoked = false;
  private revoking: Promise<void> | null = null;
  /** MEM-2：更正或忘記 commit 前暫停輸出（append 先排隊）。 */
  private held = false;
  private readonly heldQueue: Record<string, unknown>[] = [];
  /** 最近一則使用者 final 逐字稿（used：已經當過某個交辦的原句）。 */
  private lastUserFinal: { text: string; used: boolean } | null = null;
  /** 所有結束路徑都 resolve（MEM-2：記憶的 lease 持有到這裡）。 */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly caller: DelegationRunner;
  /** MEM-4b：受保護的語音交辦（放行時）；有它時交辦文字的 log 只記長度。 */
  private readonly voiceDelegation: VoiceDelegatePort | null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private typed = 0;
  /** 這個工作階段已經送過招呼指示：頁面重送也不會再念一次。 */
  private greeted = false;
  /** 送出的開場句，等模型念出後在逐字稿緩衝裡標成問候（交辦時不附這一則）；認出或下一則助理逐字稿之後清掉。 */
  private greetingSentence: string | null = null;

  constructor(
    readonly answerSdp: string,
    readonly model: string,
    private readonly socket: SidebandSocket,
    private readonly ctx: SessionContext,
    callerFor: (ctx: SessionContext, memory?: LiveCallerMemory | null, voice?: VoiceDelegatePort | null) => DelegationRunner,
    private readonly memory: LiveMemoryPort | null,
    private readonly log?: (line: string) => void,
    private readonly greetingText?: (interaction: string, sessionId: string, locale?: Locale) => LiveGreeting | null,
  ) {
    this.closed = new Promise<void>((resolve) => (this.resolveClosed = resolve));
    this.voiceDelegation = memory?.delegatePort?.() ?? null;
    this.caller = callerFor(ctx, memory ? memory.callerPort() : null, this.voiceDelegation);
    this.control = { input: (kind, text) => this.input(kind, text) };
    socket.addEventListener("message", (event) => {
      if (this.ended || this.revoked) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const frameless = parseFramelessEvent(parsed);
      if (frameless) this.onEvent(frameless);
      else this.noteUnhandled(parsed);
    });
    // sideband 斷線或出錯就是結束：不改路徑、不假裝重連（SYNTHESIS 必修 1）。
    const lost = () => this.terminate("connection_lost", "與 ChatGPT 方案即時語音的控制連線中斷，即時語音已結束。");
    socket.addEventListener("close", lost);
    socket.addEventListener("error", lost);
    this.armCap(LIVE_TIMEOUTS_MS.session);
  }

  private armCap(ms: number): void {
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = setTimeout(() => this.terminate("expired", "即時語音已達時間上限，已結束。"), Math.max(0, ms));
    this.capTimer.unref?.();
  }

  /** 診斷：沒處理的 sideband 事件，每種類型只記一次（只記類型，不記內容）。 */
  private noteUnhandled(raw: unknown): void {
    const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
    if (typeof type !== "string" || /audio\.delta$/.test(type) || this.unhandled.has(type)) return;
    this.unhandled.add(type);
    this.log?.(`即時語音（ChatGPT 方案）：未處理的事件 ${type.slice(0, 80)}`);
  }

  private onEvent(event: FramelessEvent): void {
    switch (event.kind) {
      case "session.started":
        if (!this.started) {
          this.log?.(`即時語音（ChatGPT 方案）：已開始（${this.model}）`);
          this.started = true;
          this.ctx.emit({ kind: "started", expires_at: event.expires_at });
          this.memory?.started();
          // MEM-2 重建的新通話：第一句是不含內容的固定句（不重念被忘記的內容）。
          if (this.ctx.rebuild) this.inject("speakable", confirmLine(translate("好，已經更新了。", this.ctx.locale)));
        }
        if (event.expires_at !== null) this.armCap(Math.min(LIVE_TIMEOUTS_MS.session, event.expires_at - this.ctx.now()));
        break;
      case "transcript":
        if (event.final && event.text.trim()) {
          // 開場問候那一則標起來：交辦給 Codex 的最近逐字稿不附它（server/live-tool-caller.ts requestText）。
          // 只看送出開場後的第一則助理逐字稿；使用者自己說的話（例如「幫 George 寫信」）不受影響。
          let greeting = false;
          if (event.role === "assistant" && this.greetingSentence !== null) {
            greeting = isGreetingTurn(event.text, this.greetingSentence);
            this.greetingSentence = null;
          }
          this.transcript.push({ role: event.role, text: event.text.trim(), ...(greeting ? { greeting: true } : {}) });
          if (this.transcript.length > TRANSCRIPT_RING) this.transcript.shift();
          // MEM-2：sideband 的使用者 final 逐字稿（上游 ASR 直接到核心，不經頁面）交給記憶；助理的用來判斷回音與問句念完。
          if (event.role === "user") {
            this.lastUserFinal = { text: event.text.trim(), used: false };
            this.memory?.onUserFinal(event.text, this.ctx.now());
          } else this.memory?.onAssistantFinal(event.text, this.ctx.now());
        } else if (!event.final && event.role === "user" && event.text.trim()) {
          // 這一句第一則未完成的使用者逐字稿：當成開口時間（語音確認要晚於問句播完）。
          this.memory?.onUserSpeechStart(this.ctx.now());
        }
        this.ctx.emit({ kind: "transcript", role: event.role, text: event.text, final: event.final, item_id: event.item_id });
        break;
      case "delegation":
        // 帶著記憶的通話：交辦文字可能含記憶內容，log 只記長度。
        // MEM-4b 審查 minor 2：放行受保護語音交辦時也只記長度（旗標關閉時和之前一樣）。
        this.log?.(this.memory?.carriesMemory() || this.voiceDelegation ? `即時語音（ChatGPT 方案）：收到交辦（${[...event.text].length} 字）` : `即時語音（ChatGPT 方案）：收到交辦「${preview(event.text)}」`);
        this.enqueue(event.id, event.text, "voice");
        break;
      case "speech.started":
        this.memory?.onUserSpeechStart(this.ctx.now());
        break;
      case "audio.done":
        this.memory?.onAssistantAudioDone(this.ctx.now());
        break;
      case "error":
        if (event.fatal) {
          this.terminate("auth", "ChatGPT 方案登入未被接受，即時語音已結束；請到設定重新登入。");
        } else if (event.code && /usage_limit|rate_limit|usage_not_included/i.test(event.code)) {
          this.terminate("usage_limit", `${unavailableText("usage_limit")}，即時語音已結束。`);
        } else {
          this.log?.(`即時語音（ChatGPT 方案）錯誤：${event.code ?? ""} ${redact(event.message)}`);
        }
        break;
      case "audio.cleared":
        break;
    }
  }

  private enqueue(id: string, text: string, source: "voice" | "typed"): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    // 確認卡狀態與時間在「使用者說出這句話」時記下，不是輪到它執行時（前一個交辦可能跑很久）。
    // 觸發交辦的使用者原句：打字就是打的字；語音是交辦送到之前最近一則還沒對應過交辦的使用者 final 逐字稿（MEM-2 交辦卡用）。
    let userText: string | null = source === "typed" ? text : null;
    if (source === "voice" && this.lastUserFinal && !this.lastUserFinal.used) {
      userText = this.lastUserFinal.text;
      this.lastUserFinal.used = true;
    }
    const asked = { approval: this.ctx.approval(), at: this.ctx.now(), userText };
    this.chain = this.chain.then(() => this.delegate(id, text, source, asked)).catch((err: unknown) => {
      this.log?.(`即時語音（ChatGPT 方案）交辦出錯：${redact((err as Error).message)}`);
    });
  }

  /**
   * delegation.created → 頁面顯示「思考中」→ caller.run（自己的上限）→ 結果用 delegation.context.append speakable 送回
   * （typed 用 session.context.append）→ finished／failed／unknown。空內容直接請使用者再說一次，不呼叫 caller。
   * caller 丟出例外也一樣：說一句失敗、送 failed，頁面才會清掉「思考中」、閒置計時才會繼續。
   */
  private async delegate(id: string, text: string, source: "voice" | "typed", asked: { approval: ApprovalSnapshot; at: number; userText: string | null }): Promise<void> {
    if (this.ended || this.revoked) return;
    const append = (result: { channel: "speakable"; text: string }) => {
      if (this.ended || this.revoked) return;
      for (const piece of chunkForAppend(result.text)) {
        const content = [{ type: "input_text", text: piece }];
        this.send(source === "voice" ? { type: "delegation.context.append", delegation_item_id: id, channel: result.channel, content } : { type: "session.context.append", channel: result.channel, content });
      }
    };
    if (!text.trim()) {
      append({ channel: "speakable", text: "沒有聽清楚，請再說一次。" });
      return;
    }
    this.ctx.emit({ kind: "delegation", id, state: "started" });
    let progressed = false;
    const progress = setTimeout(() => {
      // 只在真的有工具還在跑時說一次（真實事件，不是假進度）。
      if (!this.ended && !this.revoked && !progressed && this.ctx.host.outstanding > 0 && source === "voice") {
        progressed = true;
        // 獨立的一句話（session.context.append，不帶交辦 ID），不會變成這次交辦的結果（同 OpenClaw sendSessionContext）。
        for (const piece of chunkForAppend("還在處理，再等一下。")) this.send({ type: "session.context.append", channel: "speakable", content: [{ type: "input_text", text: piece }] });
      }
    }, LIVE_TIMEOUTS_MS.progressNote);
    let result: DelegationResult;
    try {
      result = await this.caller.run({ id, text, source, transcript: [...this.transcript], ...asked }, this.abort.signal);
    } catch (err) {
      this.log?.(`即時語音（ChatGPT 方案）交辦出錯：${redact((err as Error).message)}`);
      result = { ok: false, channel: "speakable", text: "沒有完成：處理這個請求時出錯了，請再說一次。", reason: "upstream", tools: [] };
    } finally {
      clearTimeout(progress);
    }
    if (this.ended || this.revoked) return;
    append(result);
    this.ctx.emit({ kind: "delegation", id, state: result.ok ? "finished" : result.reason === "unknown" ? "unknown" : "failed" });
  }

  /**
   * user_text → 和交辦一樣交給 caller（打字就是請求），結果用 session.context.append 送回。
   * notice    → session.context.append speakable「（系統通知）…」（任務完成、確認卡的結果）。
   * context   → session.context.append commentary（例如手指指著哪一項；不念）。
   * greeting  → session.context.append speakable 核心從固定清單挑好的招呼（「（開場）」開頭，只要模型照念其中「」裡那一句，例如「嗨，George」「早安」；
   *              同 OpenClaw quicksilver triggerGreeting）。頁面送來的文字只當成互動 ID 去取核心的決策（ID-02），取不到就送「我在」；
   *              頁面文字永遠不會變成內容。真的在開著的 sideband 送出才記成已送，每個工作階段最多一次。
   */
  private input(kind: LiveInputKind, text: string): void {
    if (this.ended || this.revoked) return;
    if (kind === "user_text") {
      // MEM-4b：打字之後，之前的語音原句都不能再當交辦原句。
      this.memory?.typedInput?.();
      this.enqueue(`typed_${++this.typed}`, text, "typed");
      return;
    }
    if (kind === "greeting") {
      // sideband 還沒開（或正在關）：不記成已送，之後重送仍有效；送出之後才記，所以不會送兩次。
      if (this.greeted || this.ended || this.socket.readyState !== 1) return;
      const greeting = this.greetingText?.(text, this.ctx.sessionId, this.ctx.locale) ?? { text: liveGreetingText(translate(GREETING_PLAIN, this.ctx.locale), this.ctx.locale), sentence: translate(GREETING_PLAIN, this.ctx.locale) };
      this.greetingSentence = greeting.sentence;
      for (const piece of chunkForAppend(greeting.text)) this.send({ type: "session.context.append", channel: "speakable", content: [{ type: "input_text", text: piece }] });
      this.greeted = true;
      // MEM-2：問候之後才問臉部候選（只有問候稱名過，問句才帶名字）。
      this.memory?.afterGreeting(greeting.named === true);
      return;
    }
    const channel = kind === "notice" ? "speakable" : "commentary";
    const body = kind === "notice" ? `（系統通知）${text}` : text;
    for (const piece of chunkForAppend(body)) this.send({ type: "session.context.append", channel, content: [{ type: "input_text", text: piece }] });
  }

  private send(event: Record<string, unknown>): void {
    // MEM-2：撤銷後拒絕所有 append；暫停中（更正、忘記 commit 前）先排隊：commit 失敗、恢復輸出時補送，撤銷時丟掉。
    if (this.ended || this.revoked || this.socket.readyState !== 1) return;
    if (this.held) {
      this.heldQueue.push(event);
      return;
    }
    this.socket.send(JSON.stringify(event));
  }

  // ─────────────── MEM-2：記憶（LiveCallPort） ───────────────

  get active(): boolean {
    return this.started && !this.ended && !this.revoked;
  }

  /** 核心送出的一句話（session.context.append）。 */
  inject(channel: "speakable" | "commentary", text: string): void {
    for (const piece of chunkForAppend(text)) this.send({ type: "session.context.append", channel, content: [{ type: "input_text", text: piece }] });
  }

  emit(event: LiveCoreEvent): void {
    if (this.ended || this.revoked) return;
    this.ctx.emit(event);
  }

  /** 更正或忘記 commit 前：頁面立刻把播放靜音、核心停止 append；commit 失敗才恢復。 */
  hold(active: boolean): void {
    if (this.ended || this.revoked || this.held === active) return;
    this.held = active;
    this.ctx.emit({ kind: "hold", active });
    if (!active) for (const event of this.heldQueue.splice(0)) this.send(event);
  }

  /**
   * 記憶撤銷的 cleanup（16 §8 的順序；MemoryBoundary 在 LIVE_CLEANUP_MS 內等它）：
   * 1. 同步擋住輸出：revoked（send 拒絕所有 append）、abort（進行中的交辦與 Codex 那一輪中止）。
   * 2. 立刻通知擁有者頁面 closed{memory_revoked, rebuild}；RealtimeSessions 同時結束工作階段（等待中的工具呼叫 HostGone，
   *    之後才到的 host-result 回 accepted:false）。
   * 3. sideband 送 session.close、關 socket。
   * 4. 清掉逐字稿、交辦 ID 與開場句：這個 LiveCall 從此作廢，什麼都不帶到新通話。
   * 5. 等頁面回報停播（最多 LIVE_STOP_REPORT_MS）。主視窗導覽或 renderer 結束（closed）時頁面已經不在，不等。
   * 6. 逾時：強制靜音（Electron setAudioMuted）、reject（boundary 因而停用這條路徑），回條分開說停播未確認。
   */
  revokeMemory(why: RevokeWhy, rebuild: boolean): Promise<void> {
    this.revoking ??= (async () => {
      if (this.ended) return;
      this.revoked = true;
      this.abort.abort();
      this.log?.(`即時語音（ChatGPT 方案）：記憶已撤銷（${why}），${rebuild ? "重建新通話" : "結束通話"}`);
      const message = why === "os_lock" ? "即時語音已結束（電腦已鎖定）" : rebuild ? "記憶已更新，對話已重新開始" : "即時語音已結束（記憶已更新）";
      this.ctx.emit({ kind: "closed", reason: "memory_revoked", message, rebuild });
      await this.close("ended");
      this.transcript.length = 0;
      this.seen.clear();
      this.greetingSentence = null;
      this.heldQueue.length = 0;
      this.lastUserFinal = null;
      if (why === "closed" || !this.ctx.stopped) return;
      const report = await this.ctx.stopped(LIVE_STOP_REPORT_MS);
      if (report) {
        this.log?.(`即時語音（ChatGPT 方案）：頁面已停播（${report.ms} ms）`);
        return;
      }
      this.ctx.forceSilence?.(why === "updated" ? "資料已刪除或更正，但即時語音停止未確認；這條路徑的記憶已停用" : "即時語音停止未確認；這條路徑的記憶已停用");
      this.log?.(`即時語音（ChatGPT 方案）：${LIVE_STOP_REPORT_MS} ms 內沒有停播回報，已強制靜音並停用這條路徑的記憶`);
      throw new Error("stop_unconfirmed");
    })();
    return this.revoking;
  }

  /** 核心這邊發現結束（斷線、錯誤、時間到）：通知頁面，工作階段跟著結束。 */
  private terminate(reason: "connection_lost" | "expired" | "auth" | "usage_limit", message: string): void {
    if (this.ended || this.revoked) return;
    this.log?.(`即時語音（ChatGPT 方案）：結束（${reason}）`);
    this.ctx.emit({ kind: "closed", reason, message });
    void this.close("ended");
  }

  async close(_reason: "ended" | "page_gone" | "fallback"): Promise<void> {
    if (this.ended) return;
    // 先送 session.close，再標記關閉（send 在關閉後不送任何東西）。
    if (this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // 連線已斷
      }
    }
    this.ended = true;
    this.abort.abort();
    if (this.capTimer) clearTimeout(this.capTimer);
    try {
      this.socket.close();
    } catch {
      // 已關閉
    }
    this.memory?.close();
    this.resolveClosed();
  }
}

/** 紀錄用的短摘要（只留本機 log，最多 40 字）。 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
