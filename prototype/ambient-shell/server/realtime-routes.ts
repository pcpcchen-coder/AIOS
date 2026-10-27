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
  type UnavailableReason,
} from "../shared/realtime-route.ts";
import { RealtimeError, type RealtimeBridge } from "./realtime.ts";
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
  /** live：核心端的控制面。api_key：null（頁面的資料通道就是控制面）。 */
  readonly control: LiveControl | null;
  /** 可重複呼叫。live：sideband 送 session.close、中止進行中的交辦。api_key：沒有事要做。 */
  close(reason: "ended" | "page_gone" | "fallback"): Promise<void>;
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
}

interface PendingHost {
  name: HostToolName;
  resolve(output: Record<string, unknown>): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveSession {
  id: string;
  owner: string;
  clientId: string;
  call: RouteCall | null;
  pendingHost: Map<string, PendingHost>;
  /** openUntil：卡片自己的時限；頁面的「結束」回報沒送到時，核心過了這個時間就不再當成卡還開著。 */
  approval: ApprovalSnapshot & { openUntil: number | null };
  closed: boolean;
}

/** 核心眼中的確認卡狀態：開著的卡過了自己的時限就算關了（不會永遠以為卡還開著）。 */
export function effectiveApproval(state: ApprovalSnapshot & { openUntil: number | null }, now: number): ApprovalSnapshot {
  const open = state.open && (state.openUntil === null || now <= state.openUntil);
  return { open, resolvedAt: state.resolvedAt };
}

export class RealtimeSessions {
  private readonly decisions = new Map<string, Decision>();
  private readonly interactions = new Map<string, Interaction>();
  /** 一個核心只有一個 live 工作階段。 */
  private live: LiveSession | null = null;
  /** API key 路徑的工作階段只記下來給畫面顯示（控制面在頁面的資料通道）。 */
  private ga: { id: string; owner: string; clientId: string | null } | null = null;
  private readonly now: () => number;

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
  start(clientId: string | null, source: RealtimeStartSource = "user", locale: Locale = "zh-TW"): StartDecision {
    this.sweep();
    if (this.live) {
      return { ok: false, message: `即時語音無法開始：${unavailableText("session_busy")}`, reasons: { live: "session_busy" } };
    }
    const plan = this.plan();
    if (plan.kind === "refuse") return { ok: false, message: plan.message, reasons: plan.reasons };
    if (plan.route === "live" && !clientId) {
      return { ok: false, message: "即時語音無法開始：頁面沒有連上本機核心的事件串流，請重新整理後再試。", reasons: {} };
    }
    const interaction = source === "look_to_talk" ? this.issueInteraction() : null;
    const decision = this.decide(plan, plan.route, clientId, interaction, normalizeLocale(locale));
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
    const active = s.route === "api_key" ? this.ga?.id === s.id : this.live?.id === s.id && !!this.live.call && !this.live.closed;
    if (!active) return null;
    it.used = true;
    return { route: s.route, session_id: s.id, ...(s.locale === "en" ? { locale: "en" as const } : {}) };
  }

  private decide(plan: Extract<StartPlan, { kind: "start" }>, route: RouteId, clientId: string | null, interaction: string | null = null, locale: Locale = "zh-TW"): Decision {
    const decision: Decision = {
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
  }

  /**
   * POST /api/realtime/call（帶 session_id）。live 失敗而 planFallback 允許時丟 FallbackRequired，
   * 帶著一個新決定的 api_key 工作階段（同一個頁面）。
   */
  async call(offerSdp: string, sessionId: string, owner: string): Promise<{ sdp: string; model: string; route: RouteId; session_id: string }> {
    this.sweep();
    const decision = this.decisions.get(sessionId);
    if (!decision) throw new SessionError(409, "這個即時語音工作階段已過期，請重新開始。");
    if (decision.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    this.decisions.delete(sessionId);
    const route = this.options.routes[decision.route]!;
    if (decision.route === "api_key") {
      const call = await route.connect(offerSdp, this.contextFor(null, decision.id, decision.locale));
      this.ga = { id: decision.id, owner: decision.owner, clientId: decision.clientId };
      this.connected(decision);
      return { sdp: call.answerSdp, model: call.model, route: "api_key", session_id: decision.id };
    }
    if (this.live) throw new SessionError(409, unavailableText("session_busy"));
    const session: LiveSession = {
      id: decision.id,
      owner: decision.owner,
      clientId: decision.clientId!,
      call: null,
      pendingHost: new Map(),
      approval: { open: false, resolvedAt: null, openUntil: null },
      closed: false,
    };
    this.live = session;
    try {
      const call = await route.connect(offerSdp, this.contextFor(session, decision.id, decision.locale));
      if (session.closed) {
        // 連線期間工作階段已結束（頁面離開或控制連線中斷）：掛斷剛建立的通話，照實說沒有開始。
        await call.close("page_gone").catch(() => undefined);
        throw new SessionError(409, "即時語音在連線期間就結束了（頁面離開或控制連線中斷），這次沒有開始。");
      }
      session.call = call;
      this.connected(decision);
      return { sdp: call.answerSdp, model: call.model, route: "live", session_id: decision.id };
    } catch (err) {
      this.finish(session);
      if (!(err instanceof RouteStartError)) throw err;
      const fallback = planFallback(decision.plan, err);
      if (!fallback || !this.options.routes.api_key) throw err;
      const next = this.decide({ kind: "start", route: "api_key", fallback: null, notice: fallback.notice }, "api_key", decision.clientId, decision.interaction, decision.locale);
      const model = this.options.routes.api_key.describe().model;
      this.options.log?.(`即時語音：ChatGPT 方案路徑開始失敗（${err.reason}），改用 API key（這次依用量計費）`);
      throw new FallbackRequired({
        error: err.message,
        fallback: { session_id: next.id, owner: next.owner, route: "api_key", model, billing_line: billingLine("api_key", model), notice: fallback.notice },
      });
    }
  }

  /** 找到工作階段並驗擁有者。 */
  private owned(sessionId: string, owner: string): LiveSession {
    const live = this.live;
    if (!live || live.id !== sessionId) throw new SessionError(404, "沒有這個 ChatGPT 方案即時語音工作階段（可能已結束）。");
    if (live.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    return live;
  }

  /** POST /api/realtime/input：只有 live 有；api_key 用資料通道。 */
  input(sessionId: string, owner: string, kind: LiveInputKind, text: string): void {
    const live = this.owned(sessionId, owner);
    if (!live.call?.control) throw new SessionError(409, "即時語音還在連線中。");
    live.call.control.input(kind, text);
  }

  /**
   * POST /api/realtime/approval：頁面回報確認卡打開（帶卡片的時限）或結束（帶結果）。
   * 只有使用者說出的回答（said_*）才會開始「剛回答過」的時窗；逾時、收起、結束只是關卡。
   */
  approval(sessionId: string, owner: string, report: ApprovalReport): void {
    const live = this.owned(sessionId, owner);
    if (report.state === "open") live.approval = { open: true, resolvedAt: live.approval.resolvedAt, openUntil: this.now() + report.timeout_ms };
    else live.approval = { open: false, resolvedAt: isApprovalAnswer(report.outcome) ? this.now() : live.approval.resolvedAt, openUntil: null };
  }

  /** POST /api/realtime/host-result：交回一個等待中的工具結果；不認得或已逾時的 call_id 丟掉。 */
  hostResult(sessionId: string, owner: string, callId: string, result: HostResult): boolean {
    const live = this.owned(sessionId, owner);
    const pending = live.pendingHost.get(callId);
    if (!pending) return false;
    live.pendingHost.delete(callId);
    clearTimeout(pending.timer);
    pending.resolve(result.output);
    return true;
  }

  /** POST /api/realtime/end。可重複呼叫。 */
  async end(sessionId: string, owner: string): Promise<void> {
    if (this.ga?.id === sessionId) {
      if (this.ga.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
      this.ga = null;
      return;
    }
    const live = this.live;
    if (!live || live.id !== sessionId) return;
    if (live.owner !== owner) throw new SessionError(403, "不是開始這個即時語音的頁面。");
    await this.close(live, "ended");
  }

  /**
   * 一條 SSE 串流關閉了（重新整理、關頁、斷線）。它擁有的 live 工作階段立刻結束，等待中的工具呼叫全部拒絕；
   * 不假裝重連、不保留寬限期。重新整理後的頁面可以馬上開始新的工作階段。
   */
  clientClosed(clientId: string): void {
    for (const [id, d] of this.decisions) if (d.clientId === clientId) this.decisions.delete(id);
    if (this.ga?.clientId === clientId) this.ga = null;
    const live = this.live;
    if (live && live.clientId === clientId) {
      this.options.log?.("即時語音：開始它的頁面已離開，結束 ChatGPT 方案工作階段");
      void this.close(live, "page_gone");
    }
  }

  /** /api/realtime/web-search 用：live 工作階段的查詢走 Codex（同一個方案額度）。 */
  routeOf(sessionId: string | null): RouteId | null {
    if (!sessionId) return null;
    if (this.live?.id === sessionId) return "live";
    if (this.ga?.id === sessionId) return "api_key";
    return null;
  }

  /** 驗證 live 工作階段的擁有者（給 web-search 等附帶 session_id 的請求用）。 */
  isOwner(sessionId: string, owner: string): boolean {
    return (this.live?.id === sessionId && this.live.owner === owner) || (this.ga?.id === sessionId && this.ga.owner === owner);
  }

  private async close(live: LiveSession, reason: "ended" | "page_gone"): Promise<void> {
    const call = live.call;
    this.finish(live);
    await call?.close(reason).catch(() => undefined);
  }

  /** 結束狀態：拒絕所有等待中的工具呼叫，清掉工作階段。可重複呼叫。 */
  private finish(live: LiveSession): void {
    if (live.closed) return;
    live.closed = true;
    if (this.live === live) this.live = null;
    for (const pending of live.pendingHost.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HostGone());
    }
    live.pendingHost.clear();
  }

  private contextFor(live: LiveSession | null, sessionId: string, locale: Locale): SessionContext {
    const sessions = this;
    return {
      sessionId,
      locale,
      tasks: this.options.tasks,
      now: this.now,
      approval: () => (live ? effectiveApproval(live.approval, this.now()) : { open: false, resolvedAt: null }),
      emit: (event) => {
        if (!live || live.closed) return;
        this.options.send(live.clientId, { type: "realtime.live", session_id: sessionId, event });
        if (event.kind === "closed") {
          this.options.log?.(`即時語音：ChatGPT 方案工作階段結束（${event.reason}）`);
          const call = live.call;
          this.finish(live);
          void call?.close(closeReasonForCall(event.reason)).catch(() => undefined);
        }
      },
      host: {
        get outstanding() {
          return live?.pendingHost.size ?? 0;
        },
        call: (name, args, signal) => sessions.hostCall(live, sessionId, name, args, signal),
      },
    };
  }

  private hostCall(live: LiveSession | null, sessionId: string, name: HostToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!live || live.closed) return reject(new HostGone());
      if (signal.aborted) return reject(new HostGone("工具呼叫已中止。"));
      const callId = `hc_${randomUUID().replaceAll("-", "")}`;
      const cleanup = () => {
        clearTimeout(entry.timer);
        live.pendingHost.delete(callId);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!live.pendingHost.has(callId)) return;
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
          if (!live.pendingHost.has(callId)) return;
          cleanup();
          const output = hostTimeoutOutput(name);
          if (SIDE_EFFECT_TOOLS.includes(name)) {
            this.options.send(live.clientId, { type: "realtime.live", session_id: sessionId, event: { kind: "tool_unknown", name, message: RESULT_UNKNOWN_TEXT } });
          }
          resolve(output);
        }, HOST_TIMEOUT_MS[name]),
      };
      live.pendingHost.set(callId, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      const delivered = this.options.send(live.clientId, {
        type: "realtime.host",
        session_id: sessionId,
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

// ─────────────────────────── api_key 路徑：薄轉接層，RealtimeBridge 行為不變 ───────────────────────────

export class ApiKeyRoute implements RealtimeRoute {
  readonly id = "api_key" as const;

  constructor(private readonly bridge: RealtimeBridge, private readonly hasKey: boolean, private readonly voice: string) {}

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
    let answer: { sdp: string; model: string };
    try {
      answer = await this.bridge.connect(offerSdp, ctx.tasks(), ctx.locale);
    } catch (err) {
      if (err instanceof RealtimeError) throw new RouteStartError(err.status === 409 ? "no_api_key" : "api_key_rejected", err.status, err.message, false);
      throw err;
    }
    return { route: "api_key", answerSdp: answer.sdp, model: answer.model, control: null, close: async () => {} };
  }
}
