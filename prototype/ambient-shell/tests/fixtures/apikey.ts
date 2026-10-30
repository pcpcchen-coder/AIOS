import type { McpServerConfig } from "../../server/config.ts";
import type { LiveMemoryBinding } from "../../server/memory/live.ts";
import { RealtimeBridge } from "../../server/realtime.ts";
import { ApiKeyRoute, HostGone, type RouteCall, type SessionContext } from "../../server/realtime-routes.ts";
import type { HostToolName, LiveCoreEvent, StopEvidence } from "../../shared/realtime-route.ts";
import type { FakeConnection, FakeGa } from "./fake-sideband.ts";
import type { Harness } from "./memory-service.ts";

// MEM-3 測試組裝（fixture）：假的 GA 伺服器（tests/fixtures/fake-sideband.ts startFakeGa）＋真的 RealtimeBridge／ApiKeyRoute／
// ApiKeyCall＋真的 MemoryService（AES-GCM 快照）。SessionContext 是假的：事件、工具呼叫與停播回報都換成陣列。
// 全部是虛構人物與內容；不是 Mac gate（沒有真的錄音、AEC、WebRTC 或 OpenAI wire）。

export interface CtxProbe {
  ctx: SessionContext;
  events: LiveCoreEvent[];
  hostCalls: { name: HostToolName; args: Record<string, unknown>; resolve(output: Record<string, unknown>): void }[];
  approval: { open: boolean };
  /** ctx.stopped 回傳的停播回報（null＝模擬逾時，立刻回 null）。 */
  stop: { report: StopEvidence | null; asked: number };
  silenced: string[];
}

export const STOPPED: StopEvidence = { paused: true, peer_closed: true, tracks_ended: true, ms: 5 };

export function makeCtx(clock: { now: number }, options: { lookToTalk?: boolean; rebuild?: boolean; events?: boolean; locale?: "zh-TW" | "en" } = {}): CtxProbe {
  const probe: CtxProbe = { ctx: null as unknown as SessionContext, events: [], hostCalls: [], approval: { open: false }, stop: { report: STOPPED, asked: 0 }, silenced: [] };
  probe.ctx = {
    sessionId: "rt_fixture",
    locale: options.locale ?? "zh-TW",
    lookToTalk: !!options.lookToTalk,
    rebuild: !!options.rebuild,
    events: options.events ?? true,
    tasks: () => [],
    now: () => clock.now,
    approval: () => ({ open: probe.approval.open, resolvedAt: null }),
    emit: (event) => void probe.events.push(event),
    host: {
      get outstanding() {
        return probe.hostCalls.length;
      },
      call: (name, args, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) return reject(new HostGone());
          signal.addEventListener("abort", () => reject(new HostGone("工具呼叫已中止。")), { once: true });
          probe.hostCalls.push({ name, args, resolve });
        }),
    },
    stopped: async () => {
      probe.stop.asked++;
      return probe.stop.report;
    },
    forceSilence: (message) => void probe.silenced.push(message),
  };
  return probe;
}

export function gaBridge(ga: FakeGa, options: { mcp?: McpServerConfig[]; apiKey?: string } = {}): RealtimeBridge {
  return new RealtimeBridge({ apiKey: options.apiKey ?? ga.apiKey, model: "gpt-realtime", voice: "marin", webSearch: true, mcp: options.mcp ?? [], home: false, urls: ga.bridgeUrls, retryDelayMs: 0 });
}

/** ApiKeyRoute（有記憶 harness 時接上 MemoryService.openVoice("api_key")）；bindings 記下每通的 binding。 */
export function gaRoute(ga: FakeGa, h: Harness | null, options: { mcp?: McpServerConfig[]; updateAckMs?: number } = {}): { route: ApiKeyRoute; bindings: LiveMemoryBinding[]; logs: string[] } {
  const bindings: LiveMemoryBinding[] = [];
  const logs: string[] = [];
  const route = new ApiKeyRoute(gaBridge(ga, options), true, "marin", {
    ...(h ? {
      memory: (ctx: SessionContext) => {
        const binding = h.service.openVoice("api_key", { lookToTalk: !!ctx.lookToTalk, rebuild: !!ctx.rebuild, now: ctx.now, locale: ctx.locale, approvalOpen: () => ctx.approval().open });
        bindings.push(binding);
        return binding;
      },
    } : {}),
    log: (line) => void logs.push(line),
    ...(options.updateAckMs !== undefined ? { updateAckMs: options.updateAckMs } : {}),
  });
  return { route, bindings, logs };
}

/** 等到條件成立（旁路的 WebSocket 是非同步的）。 */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 讓旁路上已送出的事件到達並處理完（binding 一則一則處理）。 */
export async function settle(binding?: LiveMemoryBinding): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
  await binding?.idle();
  await new Promise((r) => setTimeout(r, 5));
}

/** 核心送出、要模型照念的句子（response.create 的 instructions 裡「」中的那一句）。 */
export function spoken(conn: FakeConnection): string[] {
  return conn.received
    .filter((e) => e.type === "response.create" && (e.response as { instructions?: string } | undefined)?.instructions)
    .map((e) => (e.response as { instructions: string }).instructions);
}

export function cards(events: LiveCoreEvent[], open = true): string[] {
  return events.filter((e): e is Extract<LiveCoreEvent, { kind: "memory_card" }> => e.kind === "memory_card" && e.open === open).map((e) => e.card);
}

export function notices(events: LiveCoreEvent[]): string[] {
  return events.filter((e): e is Extract<LiveCoreEvent, { kind: "memory_notice" }> => e.kind === "memory_notice").map((e) => e.message);
}

/** 旁路上的 GA 事件（假的 OpenAI 送給核心）。 */
export const ga = {
  /** 麥克風緩衝提交（input_audio_buffer.committed）之後的語音辨識逐字稿。 */
  user: (conn: FakeConnection, transcript: string, id = `item_${Math.random().toString(36).slice(2, 8)}`) => {
    conn.send({ type: "input_audio_buffer.committed", item_id: id, previous_item_id: null });
    conn.send({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript });
  },
  /** 沒有對應 committed 的逐字稿（不是麥克風提交的項目）。 */
  uncommitted: (conn: FakeConnection, transcript: string) => conn.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_uncommitted", transcript }),
  typed: (conn: FakeConnection, text: string) => conn.send({ type: "conversation.item.added", item: { id: "item_typed", type: "message", role: "user", content: [{ type: "input_text", text }] } }),
  assistant: (conn: FakeConnection, transcript: string) => {
    conn.send({ type: "response.created", response: { id: "resp_a" } });
    conn.send({ type: "response.output_audio_transcript.done", item_id: "item_a", transcript });
    conn.send({ type: "response.done", response: { id: "resp_a", status: "completed" } });
  },
  audioStopped: (conn: FakeConnection) => conn.send({ type: "output_audio_buffer.stopped" }),
  speechStarted: (conn: FakeConnection) => conn.send({ type: "input_audio_buffer.speech_started" }),
  functionCall: (conn: FakeConnection, name: string, args: Record<string, unknown>, callId = `call_${name}`) => conn.send({ type: "response.function_call_arguments.done", name, call_id: callId, arguments: JSON.stringify(args) }),
};

export type GaCall = RouteCall & { playback?(): void; greetingDecided?(named: boolean): void };
