import { normalizeLocale, type Locale } from "../shared/i18n.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import type { RealtimeBaseInfo, RealtimeInfo, Task } from "../shared/types.ts";
import {
  billingLine,
  RESULT_UNKNOWN_TEXT,
  ROUTE_BILLING,
  SIDE_EFFECT_TOOLS,
  unavailableText,
  isApprovalAnswer,
  type ApprovalReport,
  type FallbackOffer,
  type HostResult,
  type HostToolName,
  type LiveAccountInfo,
  type LiveCloseReason,
  type LiveCoreEvent,
  type LiveInputKind,
  type RealtimeRouteFields,
  type RealtimeServerEvent,
  type RouteId,
  type RouteOption,
  type RoutePreference,
  type StartDecision,
  type StopEvidence,
  LIVE_STOP_REPORT_MS,
  type UnavailableReason,
  type CallAnswer,
  type CoreToolName,
  type LiveMemoryReason,
} from "../shared/realtime-route.ts";
import { RealtimeError, type RealtimeBridge } from "./realtime.ts";
import { connectApiKey, type ApiKeyBridge } from "./apikey-call.ts";
import type { LiveMemoryPort } from "./memory/live.ts";
import { WEB_SEARCH_TIMEOUT_MS } from "./web-search.ts";

// George 要的接縫：一個小的 RealtimeRoute 介面，每條路徑一個模組
// （ApiKeyRoute＝包住不改的 RealtimeBridge；server/live-route.ts＝Codex／gpt-live-1-codex），
// 以及 RealtimeSessions：「用哪條路徑、哪個工作階段、能不能改路徑」的唯一擁有者。

// ─────────────────────────── 兩條路徑都實作的介面 ───────────────────────────

export type Readiness = { ready: true } | { ready: false; reason: UnavailableReason; message: string };

/** 頁面的確認卡狀態（頁面回報）：核心據此判斷「確認執行」是在回答哪張卡。 */
export interface ApprovalSnapshot {
  open: boolean;
  /** 最近一次確認卡結束的時間（epoch ms）。 */
  resolvedAt: number | null;
}

/** 一個工作階段給路徑的東西。由 RealtimeSessions 建立；路徑看不到其他工作階段。 */
export interface SessionContext {
  readonly sessionId: string;
  readonly locale?: Locale;
  readonly tasks: () => Task[];
  /** 真實事件 → 擁有工作階段的頁面（SSE realtime.live）。closed 事件同時結束工作階段。 */
  emit(event: LiveCoreEvent): void;
  /** 共用的工具執行器（頁面），經 SSE realtime.host ＋ POST /api/realtime/host-result。 */
  readonly host: ToolHost;
  /** 頁面確認卡的狀態。 */
  approval(): ApprovalSnapshot;
  now(): number;
  /** MEM-2：看著說話開始的（核心發了互動 ID）：本次人物可能由臉部候選決定，連線時先不放記憶。 */
  readonly lookToTalk?: boolean;
  /** MEM-2：記憶撤銷後自動重建的通話（MEM-3：走被撤銷那通的路徑、不問候、第一句是固定句）。 */
  readonly rebuild?: boolean;
  /** MEM-3：開始的頁面有 SSE 串流（核心能送事件與工具呼叫給它）；記憶工作階段需要它。 */
  readonly events?: boolean;
  /** MEM-2：等頁面回報這個工作階段已停播（POST /api/realtime/stopped）；逾時回 null。 */
  stopped?(timeoutMs: number): Promise<StopEvidence | null>;
  /** MEM-2：停播未確認：強制靜音（Electron setAudioMuted），並把分開的回條送給頁面。 */
  forceSilence?(message: string): void;
}

export interface RealtimeRoute {
  readonly id: RouteId;
  /** 本機、同步（有沒有登入、有沒有 key）；不連網，每次設定畫面都會呼叫。 */
  readiness(): Readiness;
  /** 標籤、計費、聲音、工具：RealtimeInfo.routes。 */
  describe(): RouteOption;
  /** 舊欄位（available／model／web_search／home／mcp／detail）在這條路徑的值。 */
  baseInfo(): RealtimeBaseInfo;
  /**
   * 開始：把瀏覽器的 offer 換成 answer。只有在這條路徑能服務整個工作階段時才 resolve
   * （live：通話建立而且 sideband 接上）。失敗丟 RouteStartError。
   */
  connect(offerSdp: string, ctx: SessionContext): Promise<RouteCall>;
}

export interface RouteCall {
  readonly route: RouteId;
  readonly answerSdp: string;
  readonly model: string;
  /** live：核心端的控制面。api_key：null（頁面的資料通道照舊負責工具、問候與打字；記憶的控制面是核心旁路）。 */
  readonly control: LiveControl | null;
  /**
   * 可重複呼叫。live：sideband 送 session.close、中止進行中的交辦。api_key：沒有旁路時沒有事要做；
   * MEM-3 有旁路時關旁路（頁面離開時另外掛斷）。
   */
  close(reason: "ended" | "page_gone" | "fallback"): Promise<void>;
  /** MEM-3：頁面略過、由核心處理的工具（API key 路徑帶記憶規則時）。 */
  readonly coreTools?: readonly CoreToolName[];
  /** MEM-3：這通記憶的初始狀態（/call 回應用；只有筆數與原因代碼）。 */
  memoryStatus?(): { used: number; reason: LiveMemoryReason | null } | null;
  /** MEM-3：API key 路徑的問候決策已做出（IdentityService）：問候那一輪結束後才問臉部候選。 */
  greetingDecided?(named: boolean): void;
  /** MEM-3：頁面回報播放結束（只會把語音確認的時窗往後延）。 */
  playback?(): void;
}

/** live 路徑上頁面 → 模型的輸入；sideband 是唯一寫給模型的管道。 */
export interface LiveControl {
  input(kind: LiveInputKind, text: string): void;
}

export class RouteStartError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly status: number,
    message: string,
    /**
     * auto 能不能在「這次開始」改用 api_key：usage_limit、forbidden、network、upstream、needs_reauth、
     * not_logged_in、no_account_id 可以；model_rejected 不行（設定錯了要修，不能默默換成計費路徑來掩蓋）。
     */
    readonly fallbackable: boolean,
  ) {
    super(message);
  }
}

// ─────────────────────────── 頁面當工具執行器 ───────────────────────────

/** 工作階段已結束（頁面離開、sideband 斷線、使用者結束）：等待中的工具呼叫一律拒絕。 */
export class HostGone extends Error {
  constructor(message = "即時語音已結束，工具呼叫沒有完成。") {
    super(message);
  }
}

export interface ToolHost {
  /**
   * 請頁面照 API key 路徑的方式執行一個工具（同一份 callbacks、同一個畫面）。
   * 逾時：有副作用的工具回 status unknown（「結果不明，請確認」），其他回 ok:false；從不假裝成功。
   * 工作階段結束時丟 HostGone。
   */
  call(name: HostToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** 正在等頁面回覆的工具數量（進度提示只在真的有工具在跑時才說）。 */
  readonly outstanding: number;
}

/** 頁面轉交工具結果（POST host-result）的餘裕。 */
export const HOST_REPLY_MARGIN_MS = 2_000;

/**
 * 每個工具等頁面回覆的時限。home_control＝home-bridge UTTERANCE_MS（60 秒）＋2 秒；
 * web_search＝WEB_SEARCH_TIMEOUT_MS（30 秒；Codex 那一輪的時限也是它，含第一次查模型清單）＋2 秒。
 */
export const HOST_TIMEOUT_MS: Record<HostToolName, number> = {
  home_control: 62_000,
  home_status: 20_000,
  web_search: WEB_SEARCH_TIMEOUT_MS + HOST_REPLY_MARGIN_MS,
  delegate_task: 10_000,
  get_tasks: 5_000,
  end_conversation: 5_000,
};

/** 有副作用的工具沒有在時限內回覆時交給模型的內容：結果不明，不是失敗。 */
export function unknownOutput(name: HostToolName): Record<string, unknown> {
  return { ok: true, status: "unknown", message: `${RESULT_UNKNOWN_TEXT}（${name} 沒有在時限內回報結果，可能已經執行，也可能沒有）` };
}

export function hostTimeoutOutput(name: HostToolName): Record<string, unknown> {
  return SIDE_EFFECT_TOOLS.includes(name) ? unknownOutput(name) : { ok: false, error: `畫面沒有在時限內回覆這個工具（${name}，逾時）` };
}

// ─────────────────────────── 選路徑：純函式，唯一決定改路徑的地方 ───────────────────────────

export type StartPlan =
  | { kind: "start"; route: RouteId; /** auto：live 建立失敗時還能改用 api_key */ fallback: "api_key" | null; notice: string | null }
  | { kind: "refuse"; message: string; reasons: Partial<Record<RouteId, UnavailableReason>> };

export function fallbackNotice(reason: string): string {
  return `這次改用 OpenAI API key（依用量計費）：${reason}`;
}

/**
 * live    → live 可用就用，否則拒絕（說 live 的原因）。絕不用 api_key 計費。
 * api_key → api_key 可用就用，否則拒絕。
 * auto    → live 可用：用 live，api_key 可用時保留一次改路徑的機會。
 *           live 不可用、api_key 可用：用 api_key。live 從來沒登入（not_logged_in）就是只用 API key 的設定，
 *           照舊安靜開始；live 設定過但現在不能用（需要重新登入、額度用完…）才附上計費通知。
 *           都不可用：拒絕，一句話說出兩個原因。
 * 沒有接上的路徑（null）當作不存在：只有 api_key 的設定照舊行為。
 */
export function planStart(pref: RoutePreference, live: Readiness | null, apiKey: Readiness | null): StartPlan {
  const effective: RoutePreference = live === null ? "api_key" : apiKey === null ? "live" : pref;
  const refuse = (reasons: Partial<Record<RouteId, UnavailableReason>>, messages: string[]): StartPlan => ({
    kind: "refuse",
    message: `即時語音無法開始：${messages.join("；")}`,
    reasons,
  });
  if (effective === "live") {
    if (!live) return refuse({}, ["ChatGPT 方案路徑未設定"]);
    return live.ready ? { kind: "start", route: "live", fallback: null, notice: null } : refuse({ live: live.reason }, [live.message]);
  }
  if (effective === "api_key") {
    if (!apiKey) return refuse({}, ["API key 路徑未設定"]);
    return apiKey.ready ? { kind: "start", route: "api_key", fallback: null, notice: null } : refuse({ api_key: apiKey.reason }, [apiKey.message]);
  }
  const l = live!;
  const k = apiKey!;
  if (l.ready) return { kind: "start", route: "live", fallback: k.ready ? "api_key" : null, notice: null };
  if (k.ready) return { kind: "start", route: "api_key", fallback: null, notice: l.reason === "not_logged_in" ? null : fallbackNotice(l.message) };
  return refuse({ live: l.reason, api_key: k.reason }, [l.message, k.message]);
}

/** live 在「開始時」connect() 失敗之後才會呼叫；工作階段中途的失敗從不經過這裡。 */
export function planFallback(plan: Extract<StartPlan, { kind: "start" }>, err: RouteStartError): { notice: string } | null {
  return plan.route === "live" && plan.fallback === "api_key" && err.fallbackable ? { notice: fallbackNotice(err.message) } : null;
}

// ─────────────────────────── RealtimeSessions：工作階段狀態的唯一擁有者 ───────────────────────────

export class FallbackRequired extends Error {
  constructor(readonly offer: FallbackOffer) {
    super(offer.error);
  }
}

/** HTTP 狀態碼對應的錯誤（擁有者不符 403、工作階段不存在 404、狀態不對 409）。 */
export class SessionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RealtimeSessionsOptions {
  routes: { api_key?: RealtimeRoute; live?: RealtimeRoute };
  /** RealtimeSettingsStore.view().route；只在 start() 讀一次。 */
  preference: () => RoutePreference;
  tasks: () => Task[];
  /** 送一個事件到指定的 SSE 串流；那條串流已不存在時回傳 false。 */
  send(clientId: string, event: DistributiveOmit<RealtimeServerEvent, "sequence">): boolean;
  liveAccount?: () => LiveAccountInfo;
  now?: () => number;
  /** 頁面一直沒送 offer 時，開始的決定多久後作廢。 */
  pendingTtlMs?: number;
  log?: (line: string) => void;
  /** MEM-2：停播未確認時強制靜音的開關（macOS App：主視窗 webContents.setAudioMuted）；沒有時只記 log。 */
  audio?: { setMuted(muted: boolean): void };
  /** 只限測試 build（NOUS_TEST_DROP_STOP_REPORT=1）：丟掉頁面的停播回報，用來驗證強制靜音的路徑。 */
  dropStopReport?: boolean;
  /**
   * MEM-3 只限測試 build（NOUS_TEST_RENDERER_IGNORE_REVOKE=1）：記憶撤銷的 closed 事件不送給頁面（頁面不拆掉播放），
   * 用來量測只靠核心 hangup 時多久無聲，以及 1.5 秒後的強制靜音（Mac 第 12 步）。
   */
  hideRevokeFromPage?: boolean;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** 誰開始了這次即時語音（頁面報的；只決定要不要發互動 ID，不是授權）。 */
export type RealtimeStartSource = "look_to_talk" | "user";

/** 互動 ID 在工作階段真的連上之後多久內可以拿來做問候決策（ID-02）。 */
export const GREETING_CLAIM_MS = 20_000;

/**
 * 核心發出的互動 ID（ID-02，ADR-0001 §2.4.1）：問候決策只接受這裡登記過、還沒用過、工作階段真的連上（api_key：SDP 已交換；
 * live：sideband 已接上）而且還在進行、連上後 GREETING_CLAIM_MS 內的 ID。頁面自己產生的 ID 一律不給名字。
 */
interface Interaction {
  id: string;
  issuedAt: number;
  /** 真的連上的工作階段；null＝還沒連上。 */
  session: { id: string; route: RouteId; at: number; locale: Locale } | null;
  used: boolean;
}

interface Decision {
  locale: Locale;
  id: string;
  owner: string;
  clientId: string | null;
  /** 看著說話開始的互動 ID（核心發出）；改路徑時交給新的決定。 */
  interaction: string | null;
  plan: Extract<StartPlan, { kind: "start" }>;
  route: RouteId;
  at: number;
  /** MEM-2：記憶撤銷後的重建。 */
  rebuild: boolean;
}

/** MEM-2：因為記憶撤銷而結束的工作階段（等頁面的停播回報；晚到的 host-result 回 accepted:false）。MEM-3 起不分路徑。 */
interface RevokedSession {
  owner: string;
  clientId: string;
  /** MEM-3：被撤銷那通的路徑（重建走同一條，沒有備援）。 */
  route: RouteId;
  at: number;
  report: StopEvidence | null;
  waiters: ((report: StopEvidence) => void)[];
  /** 已有結果：停播回報被採用，或逾時後已強制靜音（或頁面已不在、不需要等）。 */
  settled: boolean;
  /** 停播回報被採用（可以重建）。 */
  accepted: boolean;
  /** 已經被拿去重建過（每次撤銷最多重建一次）。 */
  rebuilt: boolean;
}

/** 撤銷後最多等這麼久就不再擋新的開始（停播回報時限加餘裕；頁面已不在時 revokeMemory 不會等回報）。 */
const REVOKE_SETTLE_MS = LIVE_STOP_REPORT_MS + 1_000;

interface PendingHost {
  name: HostToolName;
  resolve(output: Record<string, unknown>): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一個進行中的工作階段（live，或 MEM-3 起的 api_key）。 */
interface VoiceSession {
  id: string;
  route: RouteId;
  owner: string;
  /** api_key 的頁面可能沒有 SSE 串流（null）：那時核心不送事件也不帶記憶。 */
  clientId: string | null;
  call: RouteCall | null;
  pendingHost: Map<string, PendingHost>;
  /** openUntil：卡片自己的時限；頁面的「結束」回報沒送到時，核心過了這個時間就不再當成卡還開著。 */
  approval: ApprovalSnapshot & { openUntil: number | null };
  closed: boolean;
  locale: Locale;
}

/** 核心眼中的確認卡狀態：開著的卡過了自己的時限就算關了（不會永遠以為卡還開著）。 */
export function effectiveApproval(state: ApprovalSnapshot & { openUntil: number | null }, now: number): ApprovalSnapshot {
  const open = state.open && (state.openUntil === null || now <= state.openUntil);
  return { open, resolvedAt: state.resolvedAt };
}

const ROUTE_LOG_LABEL: Record<RouteId, string> = { live: "ChatGPT 方案", api_key: "API key" };
/** MEM-3：帶記憶的 API key 通話還在進行時拒絕新的開始。 */
export const API_KEY_BUSY_TEXT = "已經有一個帶記憶的 API key 即時語音在進行中（一次只能一個）";

export class RealtimeSessions {
  private readonly decisions = new Map<string, Decision>();
  private readonly interactions = new Map<string, Interaction>();
  /** 一個核心只有一個 live 工作階段。 */
  private live: VoiceSession | null = null;
  /**
   * API key 路徑的工作階段。沒有記憶時控制面在頁面的資料通道（核心只記下來給畫面顯示）；MEM-3 帶記憶時核心另有旁路，
   * 也用同一套擁有者、工具呼叫（ToolHost）、確認卡與撤銷。
   */
  private ga: VoiceSession | null = null;
  private readonly now: () => number;
  private readonly revoked = new Map<string, RevokedSession>();
  /** forceSilence 之後為 true：下一次頁面回報停播或新通話開始才解除。 */
  private muted = false;

  constructor(private readonly options: RealtimeSessionsOptions) {
    this.now = options.now ?? Date.now;
  }

  private readiness(id: RouteId): Readiness | null {
    return this.options.routes[id]?.readiness() ?? null;
  }

  private plan(): StartPlan {
    return planStart(this.options.preference(), this.readiness("live"), this.readiness("api_key"));
  }

  /** RealtimeInfo 的路徑欄位；每次由路徑、偏好與狀態推導，不快取。 */
  view(): RealtimeRouteFields {
    const plan = this.plan();
    const route = plan.kind === "start" ? plan.route : null;
    const options = [this.options.routes.live?.describe(), this.options.routes.api_key?.describe()].filter((o): o is RouteOption => !!o);
    const routeModel = (id: RouteId) => this.options.routes[id]?.describe().model ?? "";
    let active: RealtimeRouteFields["active"] = null;
    if (this.live?.call) active = { session_id: this.live.id, route: "live", billing_line: billingLine("live", this.live.call.model) };
    else if (this.ga) active = { session_id: this.ga.id, route: "api_key", billing_line: billingLine("api_key", routeModel("api_key")) };
    return {
      preference: this.options.preference(),
      route,
      billing: route ? ROUTE_BILLING[route] : null,
      billing_line: route ? billingLine(route, routeModel(route)) : null,
      routes: options,
      live_account: this.options.liveAccount?.() ?? null,
      active,
    };
  }

  /** 完整的 RealtimeInfo：舊欄位說的是下一次開始會用的路徑。 */
  info(): RealtimeInfo {
    const fields = this.view();
    const plan = this.plan();
    const base: RealtimeBaseInfo =
      fields.route
        ? this.options.routes[fields.route]!.baseInfo()
        : this.options.routes.live
          ? {
              available: false,
              model: this.options.routes.api_key?.baseInfo().model ?? this.options.routes.live.describe().model,
              web_search: false,
              mcp: [],
              detail: plan.kind === "refuse" ? plan.message.replace(/^即時語音無法開始：/, "") : "不可用",
            }
          : this.options.routes.api_key!.baseInfo();
    return { ...base, ...fields };
  }

  /**
   * POST /api/realtime/start。偏好只在這裡讀一次；之後改偏好只影響下一次開始。
   * clientId：開始的頁面的 SSE 串流；live 路徑一定要有（工具呼叫只送到這條串流）。
   */
  start(clientId: string | null, source: RealtimeStartSource = "user", locale: Locale = "zh-TW", rebuild = false): StartDecision {
    this.sweep();
    if (this.live) {
      return { ok: false, message: `即時語音無法開始：${unavailableText("session_busy")}`, reasons: { live: "session_busy" } };
    }
    // MEM-3：帶記憶規則的 API key 通話（核心旁路）還在：不開始新的（任何路徑），也不靜默取代它。
    // 取代它會只關旁路、放掉 lease，上游通話卻還帶著記憶，撤銷就碰不到了。
    if (this.coreOwnedGa()) {
      return { ok: false, message: `即時語音無法開始：${API_KEY_BUSY_TEXT}`, reasons: { api_key: "session_busy" } };
    }
    // MEM-2：上一通因記憶撤銷結束、還沒有停播結果（沒回報也還沒逾時）：不開始新的，避免重建和強制靜音、停用路徑互相競爭。
    if ([...this.revoked.values()].some((r) => !r.settled && this.now() - r.at < REVOKE_SETTLE_MS)) {
      return { ok: false, message: "即時語音無法開始：上一通還在確認是否已停止播放，請稍候再試", reasons: { live: "session_busy" } };
    }
    // MEM-2／MEM-3 重建：走被撤銷那通的路徑（這個頁面最近一次停播回報被採用、還沒重建過的撤銷），沒有備援、不發互動 ID（不會再問候）。
    // 找不到這樣的撤銷或那條路徑不能用：照實拒絕（不默默改走 live）。
    let plan: StartPlan;
    if (!rebuild) plan = this.plan();
    else {
      const gone = [...this.revoked.values()].filter((r) => r.clientId === clientId && r.accepted && !r.rebuilt).at(-1);
      if (!gone) return { ok: false, message: "即時語音無法開始：找不到要重建的通話，請重新開始", reasons: {} };
      const route: RouteId = gone.route;
      gone.rebuilt = true;
      const ready = this.readiness(route);
      const label = route === "live" ? "ChatGPT 方案路徑" : "API key 路徑";
      plan = !ready ? { kind: "refuse", message: `即時語音無法開始：${label}未設定`, reasons: {} }
        : ready.ready ? { kind: "start", route, fallback: null, notice: null }
          : { kind: "refuse", message: `即時語音無法開始：${ready.message}`, reasons: { [route]: ready.reason } };
    }
    if (plan.kind === "refuse") return { ok: false, message: plan.message, reasons: plan.reasons };
    if (plan.route === "live" && !clientId) {
      return { ok: false, message: "即時語音無法開始：頁面沒有連上本機核心的事件串流，請重新整理後再試。", reasons: {} };
    }
    const interaction = source === "look_to_talk" && !rebuild ? this.issueInteraction() : null;
    const decision = this.decide(plan, plan.route, clientId, interaction, normalizeLocale(locale), rebuild);
    const model = this.options.routes[plan.route]!.describe().model;
    return { ok: true, session_id: decision.id, owner: decision.owner, route: plan.route, model, billing_line: billingLine(plan.route, model), notice: plan.notice, interaction };
  }

  private issueInteraction(): string {
    const id = `int_${randomBytes(8).toString("hex")}`;
    this.interactions.set(id, { id, issuedAt: this.now(), session: null, used: false });
    return id;
  }

  /** 工作階段真的連上：記下互動 ID 屬於哪個工作階段、何時連上。 */
  private connected(decision: Decision): void {
    const it = decision.interaction ? this.interactions.get(decision.interaction) : undefined;
    if (it && !it.used) it.session = { id: decision.id, route: decision.route, at: this.now(), locale: decision.locale };
  }

  /**
   * IdentityService 的問候決策呼叫（ID-02）：這個互動 ID 是核心發出、還沒用過、工作階段真的連上而且還在進行、
   * 連上後 GREETING_CLAIM_MS 內，才回傳它屬於哪個工作階段並標記已用；否則 null（不給名字）。一個 ID 只能成功一次。
   */
  claimGreeting(id: string): { route: RouteId; session_id: string; locale?: Locale } | null {
    this.sweep();
    const it = this.interactions.get(id);
    if (!it || it.used || !it.session) return null;
    const s = it.session;
    if (this.now() - s.at > GREETING_CLAIM_MS) return null;
    const active = s.route === "api_key" ? this.ga?.id === s.id && !this.ga.closed : this.live?.id === s.id && !!this.live.call && !this.live.closed;
    if (!active) return null;
    it.used = true;
    return { route: s.route, session_id: s.id, ...(s.locale === "en" ? { locale: "en" as const } : {}) };
  }

  /** 帶記憶規則（有核心工具、核心旁路）的 API key 工作階段還在。 */
  private coreOwnedGa(): boolean {
    return !!this.ga && !this.ga.closed && (this.ga.call?.coreTools?.length ?? 0) > 0;
  }

  /** MEM-3：API key 路徑的問候決策已做出（IdentityService）：交給這通的旁路，問候那一輪結束後才問臉部候選。 */
  greeted(sessionId: string, named: boolean): void {
    if (this.ga?.id === sessionId && !this.ga.closed) this.ga.call?.greetingDecided?.(named);
  }

  /** MEM-3：POST /api/realtime/playback：頁面在資料通道收到播放結束（只會把語音確認時窗往後延）。 */
  playback(sessionId: string, owner: string): void {
    const session = this.owned(sessionId, owner);
    session.call?.playback?.();
  }

  private decide(plan: Extract<StartPlan, { kind: "start" }>, route: RouteId, clientId: string | null, interaction: string | null = null, locale: Locale = "zh-TW", rebuild = false): Decision {
    const decision: Decision = {
      rebuild,
      locale,
      id: `rt_${randomUUID().replaceAll("-", "")}`,
      owner: `own_${randomBytes(24).toString("base64url")}`,
      clientId,
      interaction,
      plan,
      route,
      at: this.now(),
    };
    this.decisions.set(decision.id, decision);
    return decision;
  }

  private sweep(): void {
    const ttl = this.options.pendingTtlMs ?? 60_000;
    for (const [id, d] of this.decisions) if (this.now() - d.at > ttl) this.decisions.delete(id);
    for (const [id, it] of this.interactions) if (this.now() - it.issuedAt > ttl + GREETING_CLAIM_MS) this.interactions.delete(id);
    for (const [id, r] of this.revoked) if (this.now() - r.at > ttl) this.revoked.delete(id);
  }

  private newSession(decision: Decision): VoiceSession {
    return {
      id: decision.id,
      route: decision.route,
      owner: decision.owner,
      clientId: decision.clientId,
      call: null,
      pendingHost: new Map(),
      approval: { open: false, resolvedAt: null, openUntil: null },
      closed: false,
      locale: decision.locale,
    };
  }

  private answer(call: RouteCall, session: VoiceSession): CallAnswer {
    return { sdp: call.answerSdp, model: call.model, route: session.route, session_id: session.id, core_tools: call.coreTools ?? [], memory: call.memoryStatus?.() ?? null };
  }

  /**
   * POST /api/realtime/call（帶 session_id）。live 失敗而 planFallback 允許時丟 FallbackRequired，
   * 帶著一個新決定的 api_key 工作階段（同一個頁面，同一個互動 ID）。
   */
  async call(offerSdp: string, sessionId: string, owner: string): Promise<CallAnswer> {
    this.sweep();
    const decision = this.decisions.get(sessionId);
    if (!decision) throw new SessionError(409, "這個即時語音工作階段已過期，請重新開始。");
    if (decision.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    this.decisions.delete(sessionId);
    const route = this.options.routes[decision.route]!;
    const flags = { lookToTalk: decision.interaction !== null, rebuild: decision.rebuild };
    if (decision.route === "api_key") {
      // 同時只有一個 API key 工作階段。帶記憶規則的那通不能被取代（start 已拒絕；這裡防決定之後才出現的）；
      // 沒有記憶的舊工作階段（頁面沒說結束就又開始）照舊先結束，和 MEM-2 之前一樣。
      if (this.coreOwnedGa()) throw new SessionError(409, API_KEY_BUSY_TEXT);
      if (this.ga) await this.close(this.ga, "ended");
      this.unmute();
      const session = this.newSession(decision);
      this.ga = session;
      try {
        const call = await route.connect(offerSdp, this.contextFor(session, flags));
        if (session.closed) {
          await call.close("page_gone").catch(() => undefined);
          throw new SessionError(409, "即時語音在連線期間就結束了（頁面離開），這次沒有開始。");
        }
        session.call = call;
        this.connected(decision);
        return this.answer(call, session);
      } catch (err) {
        this.finish(session);
        throw err;
      }
    }
    if (this.live) throw new SessionError(409, unavailableText("session_busy"));
    // 新通話開始：解除上次停播未確認時的強制靜音。
    this.unmute();
    const session = this.newSession(decision);
    this.live = session;
    try {
      const call = await route.connect(offerSdp, this.contextFor(session, flags));
      if (session.closed) {
        // 連線期間工作階段已結束（頁面離開或控制連線中斷）：掛斷剛建立的通話，照實說沒有開始。
        await call.close("page_gone").catch(() => undefined);
        throw new SessionError(409, "即時語音在連線期間就結束了（頁面離開或控制連線中斷），這次沒有開始。");
      }
      session.call = call;
      this.connected(decision);
      return this.answer(call, session);
    } catch (err) {
      this.finish(session);
      if (!(err instanceof RouteStartError)) throw err;
      const fallback = planFallback(decision.plan, err);
      if (!fallback || !this.options.routes.api_key) throw err;
      // 改路徑：同一個互動 ID（看著說話延續）；api_key 的記憶用 openai_realtime 同意鍵重新判斷，codex 的同意不帶過去。
      const next = this.decide({ kind: "start", route: "api_key", fallback: null, notice: fallback.notice }, "api_key", decision.clientId, decision.interaction, decision.locale);
      const model = this.options.routes.api_key.describe().model;
      this.options.log?.(`即時語音：ChatGPT 方案路徑開始失敗（${err.reason}），改用 API key（這次依用量計費）`);
      throw new FallbackRequired({
        error: err.message,
        fallback: { session_id: next.id, owner: next.owner, route: "api_key", model, billing_line: billingLine("api_key", model), notice: fallback.notice },
      });
    }
  }

  /** 找到工作階段（兩條路徑）並驗擁有者。 */
  private owned(sessionId: string, owner: string): VoiceSession {
    const session = this.live?.id === sessionId ? this.live : this.ga?.id === sessionId ? this.ga : null;
    if (!session) throw new SessionError(404, "沒有這個即時語音工作階段（可能已結束）。");
    if (session.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    return session;
  }

  /** POST /api/realtime/input：只有 live 有；api_key 用資料通道。 */
  input(sessionId: string, owner: string, kind: LiveInputKind, text: string): void {
    const session = this.owned(sessionId, owner);
    if (session.route !== "live") throw new SessionError(409, "API key 路徑的輸入走頁面的資料通道。");
    if (!session.call?.control) throw new SessionError(409, "即時語音還在連線中。");
    session.call.control.input(kind, text);
  }

  /**
   * POST /api/realtime/approval：頁面回報確認卡打開（帶卡片的時限）或結束（帶結果）。兩條路徑都回報（MEM-3：記憶的「取消」
   * 不和確認卡衝突）。只有使用者說出的回答（said_*）才會開始「剛回答過」的時窗；逾時、收起、結束只是關卡。
   */
  approval(sessionId: string, owner: string, report: ApprovalReport): void {
    const session = this.owned(sessionId, owner);
    if (report.state === "open") session.approval = { open: true, resolvedAt: session.approval.resolvedAt, openUntil: this.now() + report.timeout_ms };
    else session.approval = { open: false, resolvedAt: isApprovalAnswer(report.outcome) ? this.now() : session.approval.resolvedAt, openUntil: null };
  }

  /**
   * POST /api/realtime/host-result：交回一個等待中的工具結果；不認得或已逾時的 call_id 丟掉。
   * MEM-2：記憶撤銷後才到的結果回 false（accepted:false），不交給任何人（MEM-3 起兩條路徑都是）。
   */
  hostResult(sessionId: string, owner: string, callId: string, result: HostResult): boolean {
    const gone = this.revoked.get(sessionId);
    if (gone && this.live?.id !== sessionId && this.ga?.id !== sessionId) {
      if (gone.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
      return false;
    }
    const session = this.owned(sessionId, owner);
    const pending = session.pendingHost.get(callId);
    if (!pending) return false;
    session.pendingHost.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(result.output);
    return true;
  }

  /**
   * MEM-2：POST /api/realtime/stopped。頁面在 closed{memory_revoked} 之後停播並核對（audio 暫停、peer 關閉、遠端軌道結束）
   * 再回報；只接受因記憶撤銷而結束、擁有者相符的工作階段（MEM-3 起不分路徑）。收到後解除強制靜音。回傳是否採用。
   */
  stoppedReport(sessionId: string, owner: string, evidence: StopEvidence): boolean {
    const gone = this.revoked.get(sessionId);
    if (!gone) return false;
    if (gone.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    if (this.options.dropStopReport) {
      this.options.log?.("即時語音：測試旗標 NOUS_TEST_DROP_STOP_REPORT，丟掉停播回報");
      return false;
    }
    // 三項證據都成立（播放已暫停、peer 已關、遠端軌道都結束）才採用、解除靜音；否則等逾時後強制靜音。
    if (!evidence.paused || !evidence.peer_closed || !evidence.tracks_ended) {
      this.options.log?.("即時語音：停播回報的證據不完整，不採用");
      return false;
    }
    gone.settled = true;
    gone.accepted = true;
    if (!gone.report) {
      gone.report = evidence;
      for (const waiter of gone.waiters.splice(0)) waiter(evidence);
    }
    this.unmute();
    return true;
  }

  private unmute(): void {
    if (!this.muted) return;
    this.muted = false;
    try { this.options.audio?.setMuted(false); } catch { /* 主視窗已不在 */ }
  }

  /** POST /api/realtime/end。可重複呼叫。 */
  async end(sessionId: string, owner: string): Promise<void> {
    const session = this.live?.id === sessionId ? this.live : this.ga?.id === sessionId ? this.ga : null;
    if (!session) return;
    if (session.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    await this.close(session, "ended");
  }

  /**
   * 一條 SSE 串流關閉了（重新整理、關頁、斷線）。它擁有的工作階段立刻結束，等待中的工具呼叫全部拒絕；
   * 不假裝重連、不保留寬限期。重新整理後的頁面可以馬上開始新的工作階段。
   */
  clientClosed(clientId: string): void {
    for (const [id, d] of this.decisions) if (d.clientId === clientId) this.decisions.delete(id);
    // 頁面已不在：它的撤銷不會有停播回報，也不用再等（不擋重新整理後的新開始）。
    for (const r of this.revoked.values()) if (r.clientId === clientId) r.settled = true;
    for (const session of [this.ga, this.live]) {
      if (session && session.clientId === clientId) {
        this.options.log?.(`即時語音：開始它的頁面已離開，結束${ROUTE_LOG_LABEL[session.route]}工作階段`);
        void this.close(session, "page_gone");
      }
    }
  }

  /** /api/realtime/web-search 用：live 工作階段的查詢走 Codex（同一個方案額度）。 */
  routeOf(sessionId: string | null): RouteId | null {
    if (!sessionId) return null;
    if (this.live?.id === sessionId) return "live";
    if (this.ga?.id === sessionId) return "api_key";
    return null;
  }

  /** 驗證工作階段的擁有者（給 web-search 等附帶 session_id 的請求用）；已結束或撤銷的工作階段一律 false。 */
  isOwner(sessionId: string, owner: string): boolean {
    return (this.live?.id === sessionId && this.live.owner === owner) || (this.ga?.id === sessionId && this.ga.owner === owner);
  }

  private async close(session: VoiceSession, reason: "ended" | "page_gone"): Promise<void> {
    const call = session.call;
    this.finish(session);
    await call?.close(reason).catch(() => undefined);
  }

  /** 結束狀態：拒絕所有等待中的工具呼叫，清掉工作階段。可重複呼叫。 */
  private finish(session: VoiceSession): void {
    if (session.closed) return;
    session.closed = true;
    if (this.live === session) this.live = null;
    if (this.ga === session) this.ga = null;
    for (const pending of session.pendingHost.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostGone());
    }
    session.pendingHost.clear();
  }

  private contextFor(session: VoiceSession, flags: { lookToTalk: boolean; rebuild: boolean }): SessionContext {
    const sessions = this;
    const sessionId = session.id;
    return {
      sessionId,
      locale: session.locale,
      lookToTalk: flags.lookToTalk,
      rebuild: flags.rebuild,
      events: session.clientId !== null,
      tasks: this.options.tasks,
      now: this.now,
      approval: () => effectiveApproval(session.approval, this.now()),
      emit: (event) => {
        if (session.closed || !session.clientId) return;
        // 記憶撤銷：先記下這個工作階段（等停播回報、拒絕晚到的 host-result），再送給頁面。
        if (event.kind === "closed" && event.reason === "memory_revoked") {
          this.revoked.set(sessionId, { owner: session.owner, clientId: session.clientId, route: session.route, at: this.now(), report: null, waiters: [], settled: false, accepted: false, rebuilt: false });
        }
        const hidden = this.options.hideRevokeFromPage === true && event.kind === "closed" && event.reason === "memory_revoked";
        if (hidden) this.options.log?.("即時語音：測試旗標 NOUS_TEST_RENDERER_IGNORE_REVOKE，記憶撤銷沒有送給頁面");
        else this.options.send(session.clientId, { type: "realtime.live", session_id: sessionId, event });
        if (event.kind === "closed") {
          this.options.log?.(`即時語音：${ROUTE_LOG_LABEL[session.route]}工作階段結束（${event.reason}）`);
          const call = session.call;
          this.finish(session);
          void call?.close(closeReasonForCall(event.reason)).catch(() => undefined);
        }
      },
      host: {
        get outstanding() {
          return session.pendingHost.size;
        },
        call: (name, args, signal) => sessions.hostCall(session, name, args, signal),
      },
      stopped: (timeoutMs) => {
        const gone = this.revoked.get(sessionId);
        if (!gone) return Promise.resolve(null);
        if (gone.report) return Promise.resolve(gone.report);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            gone.waiters = gone.waiters.filter((w) => w !== waiter);
            resolve(null);
          }, timeoutMs);
          timer.unref?.();
          const waiter = (report: StopEvidence) => {
            clearTimeout(timer);
            resolve(report);
          };
          gone.waiters.push(waiter);
        });
      },
      forceSilence: (message) => {
        this.muted = true;
        const settled = this.revoked.get(sessionId);
        if (settled) settled.settled = true;
        try {
          this.options.audio?.setMuted(true);
        } catch {
          // 主視窗已不在
        }
        this.options.log?.(`即時語音：停播未確認，已強制靜音（${this.options.audio ? "主視窗" : "沒有可用的靜音開關"}）`);
        const gone = this.revoked.get(sessionId);
        if (gone) this.options.send(gone.clientId, { type: "realtime.live", session_id: sessionId, event: { kind: "memory_notice", message } });
      },
    };
  }

  private hostCall(session: VoiceSession, name: HostToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (session.closed || !session.clientId) return reject(new HostGone());
      const clientId = session.clientId;
      if (signal.aborted) return reject(new HostGone("工具呼叫已中止。"));
      const callId = `hc_${randomUUID().replaceAll("-", "")}`;
      const cleanup = () => {
        clearTimeout(entry.timer);
        session.pendingHost.delete(callId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!session.pendingHost.has(callId)) return;
        cleanup();
        // 中止時有副作用的工具一樣結果不明：交給呼叫端決定怎麼說。
        reject(new HostGone("工具呼叫已中止。"));
      };
      const entry: PendingHost = {
        name,
        resolve: (output) => {
          signal.removeEventListener("abort", onAbort);
          resolve(output);
        },
        reject: (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer: setTimeout(() => {
          if (!session.pendingHost.has(callId)) return;
          cleanup();
          const output = hostTimeoutOutput(name);
          if (SIDE_EFFECT_TOOLS.includes(name)) {
            this.options.send(clientId, { type: "realtime.live", session_id: session.id, event: { kind: "tool_unknown", name, message: RESULT_UNKNOWN_TEXT } });
          }
          resolve(output);
        }, HOST_TIMEOUT_MS[name]),
      };
      session.pendingHost.set(callId, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      const delivered = this.options.send(clientId, {
        type: "realtime.host",
        session_id: session.id,
        call: { call_id: callId, name, arguments: JSON.stringify(args) },
      });
      if (!delivered) {
        cleanup();
        reject(new HostGone("開始即時語音的頁面已離開。"));
      }
    });
  }
}

function closeReasonForCall(reason: LiveCloseReason): "ended" | "page_gone" {
  return reason === "page_gone" ? "page_gone" : "ended";
}

// ─────────────────────────── api_key 路徑：薄轉接層；MEM-3 起帶記憶時另開核心旁路（server/apikey-call.ts） ───────────────────────────

export interface ApiKeyRouteOptions {
  /**
   * MEM-3：每通通話的記憶 binding（MemoryService.openVoice("api_key")）；沒有記憶層（瀏覽器版）或頁面沒有 SSE 串流時回 null，
   * 那時和 MEM-2 之前完全一樣。
   */
  memory?: (ctx: SessionContext) => LiveMemoryPort | null;
  log?: (line: string) => void;
  /** 等 session.updated 的時限（測試用；預設 3 秒）。 */
  updateAckMs?: number;
}

export class ApiKeyRoute implements RealtimeRoute {
  readonly id = "api_key" as const;

  constructor(private readonly bridge: RealtimeBridge | ApiKeyBridge & Pick<RealtimeBridge, "info">, private readonly hasKey: boolean, private readonly voice: string, private readonly options: ApiKeyRouteOptions = {}) {}

  readiness(): Readiness {
    return this.hasKey ? { ready: true } : { ready: false, reason: "no_api_key", message: unavailableText("no_api_key") };
  }

  baseInfo(): RealtimeBaseInfo {
    return this.bridge.info();
  }

  describe(): RouteOption {
    const info = this.bridge.info();
    const tools = [info.web_search ? "上網查詢（API key 計費）" : null, info.home ? "家電查詢與控制" : null, "交辦工作", ...(info.mcp ?? []).map((m) => `MCP：${m}`)]
      .filter(Boolean)
      .join("、");
    return {
      id: "api_key",
      available: this.hasKey,
      reason: this.hasKey ? null : "no_api_key",
      billing_line: billingLine("api_key", info.model),
      model: info.model,
      voice: this.voice,
      voices: [],
      tools,
      detail: info.detail,
    };
  }

  async connect(offerSdp: string, ctx: SessionContext): Promise<RouteCall> {
    // 記憶工作階段需要 SSE 串流（核心送事件、工具呼叫與撤銷給頁面）；沒有時不帶記憶。
    const memory = ctx.events ? this.options.memory?.(ctx) ?? null : null;
    try {
      return await connectApiKey(this.bridge, offerSdp, ctx, memory, { log: this.options.log, updateAckMs: this.options.updateAckMs });
    } catch (err) {
      if (err instanceof RouteStartError) throw err;
      if (err instanceof RealtimeError) throw new RouteStartError(err.status === 409 ? "no_api_key" : "api_key_rejected", err.status, err.message, false);
      throw err;
    }
  }
}
