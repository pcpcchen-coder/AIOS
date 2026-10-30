import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveCoreEvent } from "../shared/realtime-route.ts";
import type { MemoryFactView } from "../shared/memory.ts";
import type { ExecutorMode } from "../shared/types.ts";
import type { Locale } from "../shared/i18n.mjs";
import {
  ASR_GRACE_MS,
  DELEGATE_ARG_MATCH,
  DELEGATE_WINDOW_MS,
  DELEGATED_NOTE,
  delegatePolicy,
  delegatedOutput,
  LiveMemoryBinding,
  negationOrHesitation,
  normalizeSpoken,
  shortAffirmative,
  voiceDelegateDecision,
  type LiveCallPort,
  type RevokeWhy,
  type VoiceDelegateOutcome,
  type VoiceDelegatePort,
} from "../server/memory/live.ts";
import type { ContextFact } from "../server/memory/retrieve.ts";
import { TaskRunner, type ExecutionResult, type Executor, type Reporter } from "../server/runner.ts";
import { SealedVault } from "../server/sealed-vault.ts";
import { TaskStore } from "../server/store.ts";
import { createTaskIpc } from "../server/task-ipc.ts";
import { validateTasksRequest } from "../desktop/tasks-ipc.mjs";
import { ga, gaRoute, makeCtx, settle, until, type GaCall } from "./fixtures/apikey.ts";
import { startFakeGa, type FakeGa } from "./fixtures/fake-sideband.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";
import { CLAUDE, CODEX, enable, fakeBox, harness, manage, OPENAI_RT, req, selectProfile, type Harness } from "./fixtures/memory-service.ts";

// MEM-4b：語音交辦自動帶記憶（server/memory/live.ts 的 heard／delegate ＋ MemoryService.delegateVoice ＋ MEM-4a 的受保護交辦）。
// 真 AES-GCM 的記憶快照與任務加密檔、真的 TaskRunner；執行器是假的（不呼叫模型，只記下收到的標題與記憶）。live 用假的 LiveCall，
// API key 用假的 GA 伺服器（真 WebSocket）。不是 Mac gate：沒有真的錄音、AEC、上游 ASR 或 wire。全部人物與內容都是虛構的。

const CANARY = "CANARY_模型改寫_OKAPI_7731";

class FakeExecutor implements Executor {
  inputs: { title: string; facts?: readonly ContextFact[] }[] = [];
  gate: Promise<void> | null = null;
  release: (() => void) | null = null;
  constructor(public mode: ExecutorMode = "claude") {}
  hold(): void { this.gate = new Promise(r => { this.release = r; }); }
  async run(input: { title: string; mode: ExecutorMode; locale?: Locale; facts?: readonly ContextFact[] }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    this.inputs.push({ title: input.title, ...(input.facts ? { facts: input.facts } : {}) });
    reporter.planReady([{ title: "步驟", domain: "language" }], "fixture-model");
    reporter.stepStarted(0);
    if (this.gate) await this.gate;
    if (signal.aborted) throw new Error("aborted");
    reporter.stepDone(0);
    return { content: "成果", assumptions: [], capability_gaps: [], status: "complete", model: "fixture-model" };
  }
}

/** 假的 LiveCall：送給模型的句子與送給頁面的事件都換成陣列。 */
class FakeCall implements LiveCallPort {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  active = true;
  readonly injected: { channel: string; text: string }[] = [];
  readonly events: LiveCoreEvent[] = [];
  readonly revokes: { why: RevokeWhy; rebuild: boolean }[] = [];
  constructor() { this.closed = new Promise(r => (this.resolveClosed = r)); }
  inject(channel: "speakable" | "commentary", text: string): void { if (this.active) this.injected.push({ channel, text }); }
  emit(event: LiveCoreEvent): void { if (this.active) this.events.push(event); }
  async revokeMemory(why: RevokeWhy, rebuild: boolean): Promise<void> { this.revokes.push({ why, rebuild }); this.end(); }
  hold(): void {}
  end(): void { this.active = false; this.resolveClosed(); }
}

const dirs: string[] = [], harnesses: Harness[] = [], vaults: SealedVault[] = [];
let gaServer: FakeGa | null = null;
beforeEach(() => { gaServer = null; });
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.close()));
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await gaServer?.close();
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setup(options: { task?: boolean; apiKey?: boolean; unsealed?: boolean; logs?: string[] } = {}) {
  const dataDir = temp("nous-mem4b-data-");
  const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider });
  vaults.push(vault);
  const store = new TaskStore(dataDir, { vault });
  const exec = new FakeExecutor();
  const runner = new TaskRunner(store, exec);
  const h = harness({
    dir: temp("nous-mem4b-memory-"), key: randomBytes(32), live: CODEX, apiKey: OPENAI_RT,
    release: { task: options.task !== false, api_key: options.apiKey !== false },
    tasks: { sealed: () => !options.unsealed && store.sealed && store.vaultStatus().failure === null, mode: () => runner.mode, target: () => CLAUDE, submit: (input) => runner.submitProtected(input), publicGet: (id) => store.publicGet(id) },
    onResultsWithdrawn: (ids) => runner.revokeMemory(ids),
  });
  if (options.logs) (h.service as unknown as { log: (l: string) => void }).log = (l) => void options.logs!.push(l);
  harnesses.push(h);
  return { h, store, runner, exec };
}

async function pinAll(h: Harness): Promise<void> {
  const token = await manage(h);
  for (const f of (await h.call({ op: "list", token })).facts as MemoryFactView[]) await h.call({ op: "pin", id: f.id, revision: f.revision, pinned: true, token });
}

/** George：記憶允許 Claude（任務引擎）；pinned＝連線時帶釘選記憶（這通帶著記憶）。live 不給 codex 同意（George 決定 1：不需要）。 */
async function george(env: ReturnType<typeof setup>, options: { pinned?: boolean; allow?: typeof CLAUDE[] } = {}): Promise<void> {
  await enable(env.h, "George", options.allow ?? [CLAUDE]);
  await env.h.turn("記住，我不吃香菜");
  if (options.pinned) await pinAll(env.h);
}

async function startLive(h: Harness, graceMs = 60) {
  const binding = h.service.openVoice("live", { lookToTalk: false, rebuild: false, now: () => h.clock.now, asrGraceMs: graceMs });
  const call = new FakeCall();
  await binding.connect(async () => { binding.bind(call); return call; });
  binding.started();
  return { binding, call, port: binding.delegatePort() };
}

async function say(binding: LiveMemoryBinding, text: string, h: Harness) {
  binding.onUserFinal(text, h.clock.now);
  await binding.idle();
}

const delegated = (call: FakeCall) => call.events.filter((e): e is Extract<LiveCoreEvent, { kind: "delegated" }> => e.kind === "delegated");
const cardsOf = (call: FakeCall) => call.events.filter((e): e is Extract<LiveCoreEvent, { kind: "delegate_card" }> => e.kind === "delegate_card").map(e => e.card);
const ask = (port: VoiceDelegatePort | null, title: string, h: Harness, extra: Record<string, unknown> = {}): Promise<VoiceDelegateOutcome> => port!.delegate({ args: JSON.stringify({ title }), arrivedAt: h.clock.now, ...extra });

describe("MEM-4b pure policy", () => {
  it("flags off: delegatePolicy is byte-identical to MEM-4a/M15 (snapshot)", () => {
    expect(JSON.stringify(delegatePolicy("live", false, "幫我規劃晚餐"))).toBe('{"run":true}');
    expect(JSON.stringify(delegatePolicy("api_key", true, " 幫我規劃晚餐 "))).toBe('{"run":false,"title":"幫我規劃晚餐","output":{"ok":false,"status":"delegate_blocked","message":"這次通話用到記憶，交辦要使用者在畫面上按「交辦」；請使用者看畫面上的卡，不對的話請他說出完整的要求。"}}');
    expect(JSON.stringify(delegatePolicy("live", true, null))).toBe('{"run":false,"title":null,"output":{"ok":false,"status":"delegate_blocked","message":"這次通話用到記憶，不能自動交辦，畫面上也沒有交辦卡；請使用者用一句完整的話再說一次要交辦的工作。"}}');
  });

  it("three states (only when released): protected when trusted; otherwise card for a memory call, run for a plain one", () => {
    expect(voiceDelegateDecision({ trusted: true, carriesMemory: true })).toBe("protected");
    expect(voiceDelegateDecision({ trusted: true, carriesMemory: false })).toBe("protected");
    expect(voiceDelegateDecision({ trusted: false, carriesMemory: true })).toBe("card");
    expect(voiceDelegateDecision({ trusted: false, carriesMemory: false })).toBe("run");
  });

  it("review M1: only the affirmative whitelist counts; negation and hesitation are their own list; other short sentences are ordinary", () => {
    for (const w of ["好", "對", "可以", "嗯", "好啊", "ok", "yes"]) expect(shortAffirmative(normalizeSpoken(w))).toBe(true);
    for (const w of ["寫首詩", "快點", "不要", "等一下", "算了", "不用", "幫我規劃一週晚餐"]) expect(shortAffirmative(normalizeSpoken(w))).toBe(false);
    for (const w of ["不要", "等一下", "算了", "不用", "取消", "No.", "wait", "Don't", "stop"]) expect(negationOrHesitation(normalizeSpoken(w))).toBe(true);
    for (const w of ["好", "寫首詩", "不要香菜的晚餐"]) expect(negationOrHesitation(normalizeSpoken(w))).toBe(false);
    expect(DELEGATE_ARG_MATCH).toBeGreaterThan(0);
    expect(ASR_GRACE_MS).toBe(2_000);
    expect(DELEGATE_WINDOW_MS).toBe(30_000);
  });

  it("the model gets a fixed sentence: no title, no counts", () => {
    expect(delegatedOutput("claude")).toEqual({ ok: true, status: "delegated", engine: "Claude", note: DELEGATED_NOTE });
    expect(DELEGATED_NOTE).toBe("已開始處理，完成會通知");
  });
});

describe.skipIf(!realLockAvailable)("MEM-4b live: protected voice delegation", () => {
  it("title and query are the ASR sentence; the executor gets facts; the page gets a shell; no codex consent needed", async () => {
    const env = setup();
    await george(env);
    const { binding, call, port } = await startLive(env.h);
    expect(binding.memoryActive).toBe(false);
    expect(port).not.toBeNull();
    await say(binding, "幫我規劃一週晚餐", env.h);
    const out = await ask(port, `規劃一週晚餐 ${CANARY}`, env.h);
    expect(out).toEqual({ kind: "protected", output: { ok: true, status: "delegated", engine: "Claude", note: "已開始處理，完成會通知" } });
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([{ title: "幫我規劃一週晚餐", facts: [expect.objectContaining({ text: "不吃香菜" })] }]);
    const [event] = delegated(call);
    expect(event).toMatchObject({ kind: "delegated", task: { protected: true, title: "受保護的任務，請在 App 內查看" } });
    expect(event).not.toHaveProperty("memory_used");
    const task = env.store.get(event!.task.task_id)!;
    expect(task).toMatchObject({ title: "幫我規劃一週晚餐", memory: true, origin: "user_sentence" });
    // 模型改寫的描述（canary）不在任務、事件或送給模型的輸出裡。
    expect(JSON.stringify([env.store.list(), call.events, out])).not.toContain(CANARY);
    expect(JSON.stringify(call.events)).not.toContain("規劃一週晚餐");
  });

  it("logs only lengths for the model's description", async () => {
    const logs: string[] = [];
    const env = setup({ logs });
    await george(env);
    const { binding, port } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    await ask(port, `規劃一週晚餐 ${CANARY}`, env.h);
    expect(logs.some(l => l.includes("語音交辦已建立"))).toBe(true);
    expect(logs.join("\n")).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain("一週晚餐");
  });

  it("exclusions: echo, assistant text, confirmation words, memory commands, typed input, approval answers", async () => {
    const env = setup();
    await george(env);
    const { binding, port, call } = await startLive(env.h);
    // 助理的話永遠不是原句。
    binding.onAssistantFinal("幫我規劃一週晚餐", env.h.clock.now);
    expect(await ask(port, "規劃一週晚餐", env.h)).toEqual({ kind: "run" });
    // 回音：使用者逐字稿就是剛才的助理逐字稿。
    await say(binding, "幫我規劃一週晚餐", env.h);
    expect(await ask(port, "規劃一週晚餐", env.h)).toEqual({ kind: "run" });
    env.h.clock.now += 11_000;
    for (const text of ["確認記住", "記住，我不喝咖啡", "你記得我什麼？"]) {
      await say(binding, text, env.h);
      expect(await ask(port, text, env.h)).toEqual({ kind: "run" });
      env.h.clock.now += 1000;
    }
    await say(binding, "幫我寫一封感謝信", env.h);
    binding.typedInput();
    expect(await ask(port, "寫一封感謝信", env.h)).toEqual({ kind: "run" });
    const approval = { open: true };
    const b2 = env.h.service.openVoice("live", { lookToTalk: false, rebuild: false, now: () => env.h.clock.now, asrGraceMs: 30, approvalOpen: () => approval.open });
    const c2 = new FakeCall();
    await b2.connect(async () => { b2.bind(c2); return c2; });
    await say(b2, "確認執行", env.h);
    expect(await b2.delegatePort()!.delegate({ args: { title: "確認執行" }, arrivedAt: env.h.clock.now })).toEqual({ kind: "run" });
    expect(delegated(call)).toEqual([]);
    expect(delegated(c2)).toEqual([]);
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([]);
  });

  it("window expiry, use-once, and an epoch change all fall back", async () => {
    const env = setup();
    await george(env);
    const { binding, port } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    env.h.clock.now += DELEGATE_WINDOW_MS + 1;
    expect(await ask(port, "規劃一週晚餐", env.h)).toEqual({ kind: "run" });
    await say(binding, "幫我寫一封感謝信", env.h);
    expect((await ask(port, "寫一封感謝信", env.h)).kind).toBe("protected");
    expect(await ask(port, "寫一封感謝信", env.h)).toMatchObject({ kind: "once", output: { ok: false, status: "delegate_once" } });
    await say(binding, "幫我整理旅遊行程", env.h);
    // 換本次人物（世代改變）：那一句記下時的世代已經不同。
    await selectProfile(env.h, null);
    expect(await ask(port, "整理旅遊行程", env.h)).toEqual({ kind: "run" });
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["幫我寫一封感謝信"]);
  });

  it("an ASR final that arrives after the tool call but within grace still binds; after grace it does not", async () => {
    const env = setup();
    await george(env);
    const { binding, port } = await startLive(env.h, 400);
    const t0 = env.h.clock.now;
    binding.onUserSpeechStart(t0);
    const pending = ask(port, "規劃一週晚餐", env.h);
    await new Promise(r => setTimeout(r, 40));
    env.h.clock.now += 1500;
    binding.onUserFinal("幫我規劃一週晚餐", env.h.clock.now);
    expect((await pending).kind).toBe("protected");
    // 開口了但 final 一直沒到：等完 grace 就退回。
    binding.onUserSpeechStart(env.h.clock.now);
    const started = Date.now();
    expect(await ask(port, "寫一封感謝信", env.h)).toEqual({ kind: "run" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("George decision 3 = C: a short affirmative binds to the previous eligible sentence; none → card for a memory call", async () => {
    const env = setup();
    await george(env);
    const { binding, port } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    binding.onAssistantFinal("要我把它交辦成背景任務嗎？", env.h.clock.now);
    env.h.clock.now += 3000;
    await say(binding, "好", env.h);
    expect((await ask(port, "規劃一週晚餐", env.h)).kind).toBe("protected");
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["幫我規劃一週晚餐"]);

    const memory = setup();
    await george(memory, { pinned: true, allow: [CLAUDE, CODEX] });
    const m = await startLive(memory.h);
    expect(m.binding.carriesMemory()).toBe(true);
    await say(m.binding, "好", memory.h);
    const out = await ask(m.port, "規劃一週晚餐", memory.h);
    expect(out).toMatchObject({ kind: "card", output: { ok: false, status: "delegate_blocked" } });
    // 沒有原句可以放：不出卡（照 M15），也沒有交辦。
    expect(cardsOf(m.call)).toEqual([]);
    expect(delegated(m.call)).toEqual([]);
  });

  it("description vs ASR mismatch → protected card: the SSE event has only an ID, the title comes over IPC, a click delegates with memory", async () => {
    const env = setup();
    await george(env, { pinned: true, allow: [CLAUDE, CODEX] });
    const { binding, port, call } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    const out = await ask(port, "寫一封道歉信", env.h);
    expect(out).toMatchObject({ kind: "card", output: { status: "delegate_blocked" } });
    const [card] = cardsOf(call);
    expect(card).toMatch(/^dc_[0-9a-f]{24}$/);
    expect(call.events.some(e => e.kind === "delegate_blocked")).toBe(false);
    expect(JSON.stringify(call.events)).not.toContain("晚餐");
    const ipc = createTaskIpc({ store: env.store, runner: env.runner, memory: env.h.service, confirmDeleteBackups: async () => false });
    expect(validateTasksRequest({ op: "card_title", card, extra: 1 })).toEqual({ ok: true, request: { op: "card_title", card } });
    expect(await ipc({ op: "card_title", card })).toEqual({ ok: true, op: "card_title", title: "幫我規劃一週晚餐" });
    const clicked = await ipc({ op: "card_delegate", card, request_id: req() });
    expect(clicked).toMatchObject({ ok: true, op: "card_delegate", memory_used: 1, memory: "used", task: { title: "幫我規劃一週晚餐", memory: true } });
    // 卡片一次性。
    expect(await ipc({ op: "card_delegate", card, request_id: req() })).toMatchObject({ ok: false, code: "not_found" });
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([{ title: "幫我規劃一週晚餐", facts: [expect.objectContaining({ text: "不吃香菜" })] }]);
  });

  it("sealed false → no protected delegation (plain call keeps delegating through the page; the card click makes a plain task)", async () => {
    const env = setup({ unsealed: true });
    await george(env);
    const { binding, port } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    expect(await ask(port, "規劃一週晚餐", env.h)).toEqual({ kind: "run" });
    const card = env.h.service.voiceDelegateCard("幫我寫一封感謝信", "live");
    const ipc = createTaskIpc({ store: env.store, runner: env.runner, memory: env.h.service, confirmDeleteBackups: async () => false });
    expect(await ipc({ op: "card_delegate", card, request_id: req() })).toMatchObject({ ok: true, memory_used: 0, memory: "unavailable", task: { title: "幫我寫一封感謝信" } });
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([{ title: "幫我寫一封感謝信" }]);
  });

  it("forget after delegation → the running task stops with memory_revoked; a person change or the call ending does not stop it", async () => {
    const env = setup();
    await george(env);
    const { binding, port, call } = await startLive(env.h);
    env.exec.hold();
    await say(binding, "幫我規劃一週晚餐", env.h);
    expect((await ask(port, "規劃一週晚餐", env.h)).kind).toBe("protected");
    const id = delegated(call)[0]!.task.task_id;
    await new Promise(r => setTimeout(r, 10));
    call.end();
    await selectProfile(env.h, null);
    expect(env.store.get(id)!.status).toBe("running");
    const token = await manage(env.h);
    const george2 = (await env.h.call({ op: "status" })) as unknown as { profiles: { id: string }[] };
    const list = await env.h.call({ op: "list", token, subject: george2.profiles[0]!.id });
    const f = (list.facts as MemoryFactView[])[0]!;
    await env.h.call({ op: "forget", id: f.id, revision: f.revision, token });
    env.exec.release!();
    await env.runner.idle();
    expect(env.store.get(id)).toMatchObject({ status: "cancelled", cancel_reason: "memory_revoked", artifact_id: null });
  });

  it("flags off (task not released): no delegate port, the card stays the MEM-4a card with the title in the event", async () => {
    const env = setup({ task: false });
    await george(env, { pinned: true, allow: [CLAUDE, CODEX] });
    const { binding, call } = await startLive(env.h);
    expect(binding.delegatePort()).toBeNull();
    binding.callerPort()!.delegateBlocked("幫我規劃一週晚餐");
    expect(call.events.filter(e => e.kind.startsWith("delegate"))).toEqual([{ kind: "delegate_blocked", title: "幫我規劃一週晚餐" }]);
  });
});

describe.skipIf(!realLockAvailable)("MEM-4b review regressions (reviewer probes P1–P5)", () => {
  it("P1: negation or hesitation after a request never delegates (no task, no look-back)", async () => {
    for (const no of ["不要", "等一下", "算了", "不用"]) {
      const env = setup();
      await george(env);
      const { binding, port } = await startLive(env.h);
      await say(binding, "幫我寫一首關於秋天的詩給媽媽", env.h);
      binding.onAssistantFinal("要我交辦嗎？", env.h.clock.now);
      env.h.clock.now += 2000;
      await say(binding, no, env.h);
      expect(await ask(port, "寫秋天的詩給媽媽", env.h)).toEqual({ kind: "run" });
      await env.runner.idle();
      expect(env.exec.inputs).toEqual([]);
      // 帶記憶的通話：出卡的話也沒有原句（不會用前一句）。
      const mem = setup();
      await george(mem, { pinned: true, allow: [CLAUDE, CODEX] });
      const m = await startLive(mem.h);
      await say(m.binding, "幫我寫一首關於秋天的詩給媽媽", mem.h);
      m.binding.onAssistantFinal("要我交辦嗎？", mem.h.clock.now);
      mem.h.clock.now += 2000;
      await say(m.binding, no, mem.h);
      expect((await ask(m.port, "寫秋天的詩給媽媽", mem.h)).kind).toBe("card");
      expect(cardsOf(m.call)).toEqual([]);
    }
  });

  it("P2: a short real request is its own sentence; an English description that does not match gives a card titled with that sentence, never an older one", async () => {
    const env = setup();
    await george(env, { pinned: true, allow: [CLAUDE, CODEX] });
    const { binding, port, call } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    env.h.clock.now += 5000;
    await say(binding, "寫首詩", env.h);
    expect((await ask(port, "Write a poem", env.h)).kind).toBe("card");
    expect(env.h.service.delegateCardTitle(cardsOf(call)[0]!)).toBe("寫首詩");
    // 描述相符的短請求：自己就是標題。
    const plain = setup();
    await george(plain);
    const p = await startLive(plain.h);
    await say(p.binding, "幫我規劃一週晚餐", plain.h);
    await say(p.binding, "寫首詩", plain.h);
    expect((await ask(p.port, "寫一首詩", plain.h)).kind).toBe("protected");
    await plain.runner.idle();
    expect(plain.exec.inputs.map(i => i.title)).toEqual(["寫首詩"]);
  });

  it("P3 / review M2: the look-back only takes the immediately previous sentence, unused, after the model asked", async () => {
    const env = setup();
    await george(env);
    const { binding, port } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐的菜單", env.h);
    env.h.clock.now += 3000;
    await say(binding, "再幫我規劃一週晚餐的採買", env.h);
    expect((await ask(port, "規劃一週晚餐的採買", env.h)).kind).toBe("protected");
    binding.onAssistantFinal("好，已經開始。還要別的嗎？", env.h.clock.now);
    env.h.clock.now += 3000;
    await say(binding, "好", env.h);
    // 緊接的前一句已經交辦過：不跳過它去用更早的「菜單」那一句。
    expect(await ask(port, "規劃晚餐", env.h)).toEqual({ kind: "run" });
    // 模型沒有問（兩句之間沒有助理逐字稿）：也不綁。
    env.h.clock.now += 1000;
    await say(binding, "幫我寫一封感謝信", env.h);
    await say(binding, "好", env.h);
    expect(await ask(port, "寫一封感謝信", env.h)).toEqual({ kind: "run" });
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["再幫我規劃一週晚餐的採買"]);
  });

  it("P4 / review M3: a card clicked after a person change is void (not_found with the existing copy); the IPC title too", async () => {
    const env = setup();
    await george(env, { pinned: true, allow: [CLAUDE, CODEX] });
    const { binding, port, call } = await startLive(env.h);
    await say(binding, "幫我規劃一週晚餐", env.h);
    await ask(port, "寫一封道歉信", env.h);
    const [card] = cardsOf(call);
    expect(card).toBeTruthy();
    await selectProfile(env.h, null);
    expect(await env.h.service.delegateCard(card!, req())).toBeNull();
    const ipc = createTaskIpc({ store: env.store, runner: env.runner, memory: env.h.service, confirmDeleteBackups: async () => false });
    const fresh = env.h.service.voiceDelegateCard("幫我寫一封感謝信", "live");
    await selectProfile(env.h, (await env.h.call({ op: "status" }) as unknown as { profiles: { id: string }[] }).profiles[0]!.id);
    expect(await ipc({ op: "card_title", card: fresh })).toEqual({ ok: false, code: "not_found", message: "這張卡片已失效（可能換了人物或超過時間）；請再說一次" });
    expect(await ipc({ op: "card_delegate", card: fresh, request_id: req() })).toMatchObject({ ok: false, code: "not_found" });
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([]);
  });

  it("P5 / review minor 1: 「我是 X」 (a person selection) is not eligible as a delegation sentence", async () => {
    const env = setup();
    await george(env);
    const { binding, port } = await startLive(env.h);
    await say(binding, "我是 George", env.h);
    expect(await ask(port, "我是George", env.h)).toEqual({ kind: "run" });
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([]);
  });

  it("review minor 2: with the port released, the live delegation log records only lengths", async () => {
    const live = readFileSync(join(import.meta.dirname, "../server/live-route.ts"), "utf8");
    expect(live).toContain("this.memory?.carriesMemory() || this.voiceDelegation ? `即時語音（ChatGPT 方案）：收到交辦（${[...event.text].length} 字）`");
  });
});

describe.skipIf(!realLockAvailable)("MEM-4b API key: committed → response.created → function_call binding", () => {
  async function startCall(env: ReturnType<typeof setup>) {
    gaServer = await startFakeGa();
    const probe = makeCtx(env.h.clock);
    const { route, bindings } = gaRoute(gaServer, env.h);
    const call = (await route.connect("v=0 offer", probe.ctx)) as GaCall;
    const conn = await gaServer.next();
    await conn.waitFor((e) => e.type === "session.update");
    return { call, conn, probe, binding: bindings[0]! };
  }
  const output = async (conn: Awaited<ReturnType<typeof startCall>>["conn"]) => {
    const item = await conn.waitFor((e) => e.type === "conversation.item.create" && (e.item as { type?: string }).type === "function_call_output");
    return JSON.parse((item.item as { output: string }).output) as Record<string, unknown>;
  };

  it("binds only to the committed item that triggered the response; the page never sees the tool call", async () => {
    const env = setup();
    await george(env, { allow: [CLAUDE, OPENAI_RT] });
    const t = await startCall(env);
    ga.user(t.conn, "幫我規劃一週晚餐", "item_u1");
    await settle(t.binding);
    t.conn.send({ type: "response.created", response: { id: "resp_u1" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c1", response_id: "resp_u1", arguments: JSON.stringify({ title: `規劃一週晚餐 ${CANARY}` }) });
    expect(await output(t.conn)).toEqual({ ok: true, status: "delegated", engine: "Claude", note: "已開始處理，完成會通知" });
    expect(t.probe.hostCalls).toEqual([]);
    await until(() => t.probe.events.some(e => e.kind === "delegated"));
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["幫我規劃一週晚餐"]);
    expect(JSON.stringify(t.probe.events)).not.toContain(CANARY);
    expect(JSON.stringify(t.probe.events)).not.toContain("晚餐");
  });

  it("the transcript may arrive after the function call (within grace)", async () => {
    const env = setup();
    await george(env, { allow: [CLAUDE, OPENAI_RT] });
    const t = await startCall(env);
    t.conn.send({ type: "input_audio_buffer.committed", item_id: "item_late" });
    t.conn.send({ type: "response.created", response: { id: "resp_late" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c1", response_id: "resp_late", arguments: JSON.stringify({ title: "寫感謝信" }) });
    await new Promise(r => setTimeout(r, 100));
    t.conn.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_late", transcript: "幫我寫一封感謝信" });
    expect(await output(t.conn)).toMatchObject({ status: "delegated" });
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["幫我寫一封感謝信"]);
  });

  it("a typed-triggered response and a transcript without committed are not trusted (plain call → page delegates as before)", async () => {
    const env = setup();
    await george(env, { allow: [CLAUDE, OPENAI_RT] });
    const t = await startCall(env);
    ga.user(t.conn, "幫我規劃一週晚餐", "item_u1");
    ga.typed(t.conn, "幫我規劃一週晚餐");
    await settle(t.binding);
    t.conn.send({ type: "response.created", response: { id: "resp_typed" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c1", response_id: "resp_typed", arguments: JSON.stringify({ title: "規劃一週晚餐" }) });
    await until(() => t.probe.hostCalls.length === 1);
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    expect(await output(t.conn)).toEqual({ ok: true, status: "queued" });

    ga.uncommitted(t.conn, "幫我寫一封感謝信");
    await settle(t.binding);
    t.conn.send({ type: "response.created", response: { id: "resp_x" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "c2", response_id: "resp_x", arguments: JSON.stringify({ title: "寫感謝信" }) });
    await until(() => t.probe.hostCalls.length === 2);
    await env.runner.idle();
    expect(env.exec.inputs).toEqual([]);
    expect(t.probe.events.some(e => e.kind === "delegated")).toBe(false);
  });

  it("review minor 4: recall_memory → delegate_task in the core's continuation binds to the original item via response.metadata", async () => {
    const env = setup();
    await george(env, { allow: [CLAUDE, OPENAI_RT] });
    const t = await startCall(env);
    gaServer!.autoRespond = false;
    ga.user(t.conn, "幫我規劃一週晚餐", "item_r1");
    await settle(t.binding);
    t.conn.send({ type: "response.created", response: { id: "resp_r1" } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "recall_memory", call_id: "r1", response_id: "resp_r1", arguments: JSON.stringify({ query: "晚餐" }) });
    t.conn.send({ type: "response.done", response: { id: "resp_r1" } });
    const create = await t.conn.waitFor((e) => e.type === "response.create");
    const metadata = (create.response as { metadata: { nous_trigger: string } }).metadata;
    expect(metadata.nous_trigger).toBe(create.event_id);
    t.conn.send({ type: "response.created", response: { id: "resp_core", metadata } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "d1", response_id: "resp_core", arguments: JSON.stringify({ title: "規劃一週晚餐" }) });
    await until(() => t.probe.events.some(e => e.kind === "delegated"));
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["幫我規劃一週晚餐"]);
  });

  it("review minor 4: overlapping page and core responses are attributed by the metadata tag, not by order", async () => {
    const env = setup();
    await george(env, { allow: [CLAUDE, OPENAI_RT] });
    const t = await startCall(env);
    gaServer!.autoRespond = false;
    ga.user(t.conn, "幫我規劃一週晚餐", "item_o1");
    await settle(t.binding);
    // 核心的一句（沒有可信語音）送出、還沒回應時，頁面或伺服器 VAD 的回應先到：它仍歸給麥克風項目；
    // 之後核心那一個回應帶回自己的標記，歸給 null（不是語音觸發）。
    (t.binding as unknown as { say(s: string): void }).say("（測試）核心要念的一句");
    const create = await t.conn.waitFor((e) => e.type === "response.create");
    t.conn.send({ type: "response.created", response: { id: "resp_page" } });
    t.conn.send({ type: "response.created", response: { id: "resp_core2", metadata: (create.response as { metadata: unknown }).metadata } });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "dc", response_id: "resp_core2", arguments: JSON.stringify({ title: "規劃一週晚餐" }) });
    await until(() => t.probe.hostCalls.length === 1);
    t.probe.hostCalls[0]!.resolve({ ok: true, status: "queued" });
    t.conn.send({ type: "response.function_call_arguments.done", name: "delegate_task", call_id: "dp", response_id: "resp_page", arguments: JSON.stringify({ title: "規劃一週晚餐" }) });
    await until(() => t.probe.events.some(e => e.kind === "delegated"));
    await env.runner.idle();
    expect(env.exec.inputs.map(i => i.title)).toEqual(["幫我規劃一週晚餐"]);
  });

  it("without openai_realtime consent there is no sideband, so no protected delegation (MEM-3 byte-identical guarantee)", async () => {
    const env = setup();
    await george(env, { allow: [CLAUDE] });
    gaServer = await startFakeGa();
    const probe = makeCtx(env.h.clock);
    const { route, bindings } = gaRoute(gaServer, env.h);
    const call = await route.connect("v=0 offer", probe.ctx);
    expect(call.coreTools).toEqual([]);
    expect(bindings[0]!.delegatePort()).toBeNull();
  });
});
