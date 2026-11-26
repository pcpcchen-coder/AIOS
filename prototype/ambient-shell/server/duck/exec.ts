import type { CommandOutcome, DuckLink, LinkSnapshot, Observation } from "./link.ts";
import { toolResult, type ToolResult, type ToolResultReason } from "../../shared/integrations.ts";
import { capabilitiesFor } from "../../shared/duck-capabilities.ts";
import { HEAD_JOINTS, type AckMessage, type AckReason, type DuckAction, type PresenceState, type StateMessage } from "../../shared/duck-link.ts";
import { DUCK_REJECT_TEXT, DUCK_TEXT } from "./text.ts";

// DUCK-1：一則 duck-link 指令 → ToolResult 的共用流程（DuckAdapter 的工具與鴨子的 presence 都走這裡）。
//
// 結果語意（和其他 Adapter 相同；設計見 Nous Duck repo（pcpcchen-coder/Open_Duck_Mini） 的 nous_duck/docs/adr/ADR-0009 §2.2）：
//   沒有連線、沒有送出                         → failed（reason: unavailable）
//   鴨子自己回報這項能力 unsupported（沒有送出） → refused（data.duck_reason: "unsupported"）
//   指令不合 schema（沒有送出）                 → refused（reason: invalid_arguments）
//   ack rejected                               → refused，data.duck_reason 帶鴨子的原因代碼
//   已送出、時限內沒有 ack／連線中斷／被中止     → unknown（不能推定沒有執行）
//   ack accepted，之後的 state（或事件）回讀符合 → confirmed（代表「已接受並開始」，不是做完）
//   ack accepted，但時限內沒有符合的回讀         → unconfirmed
//   ack accepted，但 v0 的 state 沒有可回讀的欄位 → unconfirmed（說明原因）

export interface DuckTiming {
  /** 等 ack 的時間。 */
  ackTimeoutMs: number;
  /** ack 之後等 state 回讀的時間（鴨子每秒至少送一次 state，接受指令後會立刻送一次）。 */
  readbackMs: number;
  /** 頭部到位最多等多久。 */
  lookSettleMaxMs: number;
  /** 預錄動作的回讀（gesture_done 事件）最多等多久。 */
  gestureReadbackMs: number;
  /** state 超過這個時間沒更新就標示 stale。 */
  staleStateMs: number;
}

export const DUCK_TIMING: DuckTiming = { ackTimeoutMs: 1_500, readbackMs: 1_500, lookSettleMaxMs: 4_000, gestureReadbackMs: 3_000, staleStateMs: 3_000 };

/** 頭部到位的容許誤差（rad，約 3.4°）；未經實機校準。 */
export const HEAD_TOLERANCE_RAD = 0.06;

export type ReadbackVerdict =
  | { status: "confirmed"; message: string; data?: Record<string, unknown> }
  | { status: "unconfirmed"; message: string; data?: Record<string, unknown> }
  | { status: "failed"; message: string; data?: Record<string, unknown> };

export interface ReadbackContext {
  link: DuckLink;
  ack: AckMessage;
  requestId: string;
  sentSeq: number;
  ackSeq: number;
  /** 送出指令前的最新 state。 */
  before: StateMessage | null;
  timing: DuckTiming;
  signal?: AbortSignal;
}

export interface CommandSpec {
  action: DuckAction;
  params?: Record<string, unknown>;
  ttlMs: number;
  /** ack accepted 之後怎麼確認；read 類的指令 ack 本身就是結果，不需要。 */
  readback?: (ctx: ReadbackContext) => Promise<ReadbackVerdict | "link_lost" | "aborted">;
  /** read 類：ack accepted 時的說明與資料。 */
  onRead?: (ack: AckMessage, snapshot: LinkSnapshot) => { message: string; data?: Record<string, unknown> };
  /** ack rejected 時先看這裡（例如取消任務但本來就沒有任務）；回 null 就走一般的拒絕對應。 */
  onRejected?: (ack: AckMessage, snapshot: LinkSnapshot) => ToolResult | null;
  signal?: AbortSignal;
  requestId?: string;
  /** 不做「能力 unsupported 就不送」的事前檢查（stop、status）。 */
  skipCapabilityCheck?: boolean;
}

const INVALID_REASONS: readonly AckReason[] = ["invalid", "out_of_range", "unknown_name"];

export function isMock(snapshot: LinkSnapshot): boolean {
  return snapshot.hello?.mock === true || snapshot.state?.mock === true;
}

/** 交回模型的 state 摘要（只留判斷需要的欄位；age_ms 是 hub 收到這則 state 之後過了多久）。 */
export function compactState(snapshot: LinkSnapshot, timing: DuckTiming, now: number = Date.now()): Record<string, unknown> | null {
  const s = snapshot.state;
  if (!s || snapshot.stateAt === null) return null;
  const age = Math.max(0, now - snapshot.stateAt);
  return {
    mode: s.mode,
    control_source: s.control_source,
    ...(s.presence !== undefined ? { presence: s.presence } : {}),
    ...(s.expression !== undefined ? { expression: s.expression } : {}),
    ...(s.tracking !== undefined ? { tracking: s.tracking } : {}),
    ...(s.head ? { head: s.head } : {}),
    ...(s.velocity_cmd ? { velocity_cmd: s.velocity_cmd } : {}),
    ...(s.mission !== undefined ? { mission: s.mission } : {}),
    ...(s.location !== undefined ? { location: s.location } : {}),
    ...(s.battery ? { battery: s.battery } : {}),
    ...(s.tilt_deg !== undefined ? { tilt_deg: s.tilt_deg } : {}),
    faults: s.faults,
    age_ms: age,
    stale: !snapshot.connected || age > timing.staleStateMs,
  };
}

function finish(link: DuckLink, timing: DuckTiming, status: ToolResult["status"], message: string, extra: { reason?: ToolResultReason; data?: Record<string, unknown> } = {}): ToolResult {
  const snapshot = link.snapshot();
  const mock = isMock(snapshot);
  const state = compactState(snapshot, timing);
  const data: Record<string, unknown> = { ...(mock ? { mock: true } : {}), ...extra.data, connected: snapshot.connected, ...(state ? { state } : {}) };
  return toolResult(status, mock ? `${DUCK_TEXT.mockPrefix}${message}` : message, { ...(extra.reason ? { reason: extra.reason } : {}), data });
}

export function rejectedResult(link: DuckLink, timing: DuckTiming, ack: AckMessage): ToolResult {
  const reason: AckReason = ack.reason ?? "internal";
  const aios: ToolResultReason = INVALID_REASONS.includes(reason) ? "invalid_arguments" : reason === "expired" ? "timeout" : "unavailable";
  return finish(link, timing, "refused", `${DUCK_TEXT.rejectedPrefix}${DUCK_REJECT_TEXT[reason]}`, {
    reason: aios,
    data: { duck_reason: reason, ...(ack.detail ? { detail: ack.detail } : {}) },
  });
}

export async function runDuckCommand(link: DuckLink, spec: CommandSpec, timing: DuckTiming = DUCK_TIMING): Promise<ToolResult> {
  const snapshot = link.snapshot();
  if (!snapshot.connected) return finish(link, timing, "failed", spec.action === "stop" ? DUCK_TEXT.notConnectedStop : DUCK_TEXT.notConnected, { reason: "unavailable" });

  if (!spec.skipCapabilityCheck) {
    const capabilities = snapshot.state?.capabilities ?? snapshot.hello?.capabilities ?? {};
    for (const name of capabilitiesFor(spec.action, spec.params)) {
      const cap = capabilities[name];
      if (cap?.status === "unsupported") {
        return finish(link, timing, "refused", `${DUCK_TEXT.unsupported}（${name}）`, {
          reason: "unavailable",
          data: { duck_reason: "unsupported", capability: name, ...(cap.reason ? { capability_reason: cap.reason } : {}), sent: false },
        });
      }
    }
  }

  const before = snapshot.state;
  const outcome: CommandOutcome = await link.sendCommand(spec.action, spec.params, {
    ttlMs: spec.ttlMs,
    ackTimeoutMs: timing.ackTimeoutMs,
    ...(spec.signal ? { signal: spec.signal } : {}),
    ...(spec.requestId ? { requestId: spec.requestId } : {}),
  });

  switch (outcome.kind) {
    case "not_sent":
      if (outcome.why === "invalid") return finish(link, timing, "refused", DUCK_TEXT.invalidCommand, { reason: "invalid_arguments", data: { errors: outcome.errors ?? [], sent: false } });
      if (outcome.why === "aborted") return finish(link, timing, "refused", DUCK_TEXT.abortedBeforeSend, { reason: "aborted", data: { sent: false } });
      return finish(link, timing, "failed", DUCK_TEXT.notConnected, { reason: "unavailable" });
    case "no_ack":
      return finish(link, timing, "unknown", DUCK_TEXT.noAck, { reason: "timeout" });
    case "link_lost":
      return finish(link, timing, "unknown", DUCK_TEXT.linkLost, { reason: "unavailable" });
    case "aborted":
      return finish(link, timing, "unknown", DUCK_TEXT.aborted, { reason: "aborted" });
    case "ack":
      break;
  }

  const ack = outcome.ack;
  if (ack.status === "rejected") return spec.onRejected?.(ack, link.snapshot()) ?? rejectedResult(link, timing, ack);

  const ackData: Record<string, unknown> = {
    ...(ack.applied ? { applied: ack.applied } : {}),
    ...(ack.clamped ? { clamped: true } : {}),
    ...(ack.mission_id ? { mission_id: ack.mission_id } : {}),
    rtt_ms: outcome.rttMs,
  };
  const clampNote = ack.clamped ? DUCK_TEXT.clampedNote : "";

  if (spec.onRead) {
    const read = spec.onRead(ack, link.snapshot());
    return finish(link, timing, "confirmed", read.message, { data: { ...ackData, ...read.data } });
  }
  if (!spec.readback) return finish(link, timing, "unconfirmed", `${DUCK_TEXT.noReadbackField}${clampNote}`, { data: ackData });

  const verdict = await spec.readback({ link, ack, requestId: outcome.requestId, sentSeq: outcome.sentSeq, ackSeq: outcome.ackSeq, before, timing, ...(spec.signal ? { signal: spec.signal } : {}) });
  // ack 已經收到：指令確定被接受了，之後才斷線或中止，只是沒辦法回讀。
  if (verdict === "link_lost") return finish(link, timing, "unconfirmed", DUCK_TEXT.acceptedThenLost, { data: ackData });
  if (verdict === "aborted") return finish(link, timing, "unconfirmed", DUCK_TEXT.acceptedThenAborted, { data: ackData });
  return finish(link, timing, verdict.status, `${verdict.message}${verdict.status === "failed" ? "" : clampNote}`, {
    ...(verdict.status === "failed" ? { reason: "adapter_error" as const } : {}),
    data: { ...ackData, ...verdict.data },
  });
}

// ---- 回讀的組件 ----

/** ack 之後第一則符合條件的 state。 */
export function stateReadback(match: (state: StateMessage) => boolean, text: { confirmed: string; unconfirmed: string }, timeoutMs?: number) {
  return async (ctx: ReadbackContext): Promise<ReadbackVerdict | "link_lost" | "aborted"> => {
    const result = await ctx.link.waitFor((o) => o.kind === "state" && match(o.state), {
      sinceSeq: ctx.ackSeq,
      timeoutMs: timeoutMs ?? ctx.timing.readbackMs,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result === "link_lost" || result === "aborted") return result;
    if (result === "timeout") return { status: "unconfirmed", message: text.unconfirmed };
    return { status: "confirmed", message: text.confirmed };
  };
}

function headDistance(head: StateMessage["head"] | undefined, targets: Record<string, number>): number | null {
  if (!head) return null;
  // 回讀太舊（age_ms 超過 1 秒）不算數。
  if (typeof head.age_ms === "number" && head.age_ms > 1_000) return null;
  let worst = 0;
  for (const [joint, target] of Object.entries(targets)) {
    const actual = head[joint as (typeof HEAD_JOINTS)[number]];
    if (typeof actual !== "number") return null;
    worst = Math.max(worst, Math.abs(actual - target));
  }
  return worst;
}

/**
 * look 的回讀：state.head 是實際關節角度（不是目標），所以
 *   到位（每一軸誤差 ≤ HEAD_TOLERANCE_RAD） → confirmed，data.reached = true
 *   時限內沒到位，但比送出前更接近目標   → confirmed，data.reached = false（已開始轉）
 *   其他                                  → unconfirmed
 */
export async function lookReadback(ctx: ReadbackContext, requested: Record<string, unknown>): Promise<ReadbackVerdict | "link_lost" | "aborted"> {
  const targets: Record<string, number> = {};
  for (const joint of HEAD_JOINTS) {
    const applied = ctx.ack.applied?.[joint];
    const value = typeof applied === "number" ? applied : requested[joint];
    if (typeof value === "number") targets[joint] = value;
  }
  const appliedDuration = ctx.ack.applied?.duration_s;
  const durationS = typeof appliedDuration === "number" ? appliedDuration : typeof requested.duration_s === "number" ? requested.duration_s : 0.5;
  const timeoutMs = Math.min(ctx.timing.lookSettleMaxMs, Math.round(durationS * 1000) + 1_000);
  const reached = await ctx.link.waitFor(
    (o) => {
      if (o.kind !== "state") return false;
      const d = headDistance(o.state.head, targets);
      return d !== null && d <= HEAD_TOLERANCE_RAD;
    },
    { sinceSeq: ctx.ackSeq, timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) },
  );
  if (reached === "link_lost" || reached === "aborted") return reached;
  if (reached !== "timeout") return { status: "confirmed", message: DUCK_TEXT.lookReached, data: { reached: true } };
  const startDistance = headDistance(ctx.before?.head, targets);
  const nowDistance = headDistance(ctx.link.snapshot().state?.head, targets);
  if (startDistance !== null && nowDistance !== null && nowDistance < startDistance - 0.02) {
    return { status: "confirmed", message: DUCK_TEXT.lookMoving, data: { reached: false, remaining_rad: Number(nowDistance.toFixed(3)) } };
  }
  return { status: "unconfirmed", message: DUCK_TEXT.lookUnconfirmed, data: { reached: false } };
}

/** 任務類：ack 要帶 mission_id，之後 state.mission 或 mission_* 事件要對得上。 */
export async function missionReadback(ctx: ReadbackContext, text: { confirmed: string }): Promise<ReadbackVerdict | "link_lost" | "aborted"> {
  const missionId = ctx.ack.mission_id;
  if (!missionId) return { status: "unconfirmed", message: DUCK_TEXT.missionNoId };
  const seen = await ctx.link.waitFor(
    (o: Observation) => (o.kind === "state" ? o.state.mission?.mission_id === missionId : o.event.mission_id === missionId && ["mission_progress", "mission_done", "mission_failed"].includes(o.event.event)),
    { sinceSeq: ctx.sentSeq, timeoutMs: ctx.timing.readbackMs, ...(ctx.signal ? { signal: ctx.signal } : {}) },
  );
  if (seen === "link_lost" || seen === "aborted") return seen;
  if (seen === "timeout") return { status: "unconfirmed", message: DUCK_TEXT.missionUnconfirmed };
  if (seen.kind === "event" && seen.event.event === "mission_failed") {
    return { status: "failed", message: DUCK_TEXT.missionFailedEarly, data: { mission_reason: seen.event.reason ?? "unknown" } };
  }
  return { status: "confirmed", message: text.confirmed };
}

/**
 * presence：語音工作階段的真實狀態 → 鴨子（回讀 state.presence）。不是模型工具；由 PresenceDriver 呼叫。
 * 放在這裡而不是 Adapter 上：只要 duck-link 開著就能用，不需要 duck adapter 有註冊。
 */
export function sendDuckPresence(link: DuckLink, state: PresenceState, speechLevel?: number, signal?: AbortSignal, timing: DuckTiming = DUCK_TIMING): Promise<ToolResult> {
  return runDuckCommand(
    link,
    {
      action: "presence",
      params: { state, ...(speechLevel !== undefined ? { speech_level: speechLevel } : {}) },
      ttlMs: 2_000,
      ...(signal ? { signal } : {}),
      readback: stateReadback((s) => s.presence === state, { confirmed: DUCK_TEXT.presenceConfirmed, unconfirmed: DUCK_TEXT.presenceUnconfirmed }),
    },
    timing,
  );
}
