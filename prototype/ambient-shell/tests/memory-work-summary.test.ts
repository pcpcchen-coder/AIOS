import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_FILE, type MemoryData, type MemoryFact, type MemorySnapshot } from "../server/memory/store.ts";
import { workDecision, parseMemoryText, type ParsedSegment } from "../server/memory/parse.ts";
import { settleWithdrawals, type TaskPort } from "../server/memory/service.ts";
import type { ContextFact } from "../server/memory/retrieve.ts";
import { TaskRunner, type ExecutionResult, type Executor, type Reporter } from "../server/runner.ts";
import { SealedVault } from "../server/sealed-vault.ts";
import { memoryTaskViews, TaskStore } from "../server/store.ts";
import { validateMemoryRequest } from "../desktop/memory-ipc.mjs";
import serverMessages from "../server/messages.en.json" with { type: "json" };
import pageMessages from "../src/messages.en.json" with { type: "json" };
import type { ExecutorMode } from "../shared/types.ts";
import type { Locale } from "../shared/i18n.mjs";
import { CLAUDE, enable, fakeBox, harness, manage, req, selectProfile, type Harness } from "./fixtures/memory-service.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";

// MEM-5b：工作決定（work_summary）。「記住這次選了方案 B」在旗標（NOUS_MEMORY_ROUTES=work_summary）與任務加密保存都開著時，
// 先出選擇卡（最近 24 小時成功完成、沒有撤回、在範圍內的工作），點選才寫入；值是使用者原話，derivedFrom 是那個任務。
// 依賴的記憶被忘記或更正而撤回成果時連帶忘記（固定點）；任務已不存在時由對帳忘記（開檔、可信主視窗的 turn／list）；
// 記憶關閉、撤回同意、依賴索引超過上限只撤回成果、保留工作決定（審查 M1）。真 AES-GCM 的記憶快照與任務加密檔；執行器是假的（不呼叫模型）。
// 全部人物、標題與內容都是虛構的；CANARY 字串用來確認標題與成果不會進入記憶、模型、log。

const TITLE_CANARY = "CANARY_工作標題_OKAPI_7731";
const RESULT_CANARY = "CANARY_工作成果_TAPIR_4410";

class FakeExecutor implements Executor {
  inputs: { title: string; facts?: readonly ContextFact[] }[] = [];
  constructor(public mode: ExecutorMode = "claude") {}
  async run(input: { title: string; mode: ExecutorMode; locale?: Locale; facts?: readonly ContextFact[] }, reporter: Reporter): Promise<ExecutionResult> {
    this.inputs.push({ title: input.title, ...(input.facts ? { facts: input.facts } : {}) });
    reporter.planReady([{ title: "步驟", domain: "language" }], "fixture-model");
    reporter.stepStarted(0);
    reporter.stepDone(0);
    return { content: `${RESULT_CANARY} ${input.facts?.map(f => f.text).join("、") ?? ""}`, assumptions: [], capability_gaps: [], status: "complete", model: "fixture-model" };
  }
}

const dirs: string[] = [], harnesses: Harness[] = [], vaults: SealedVault[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.close()));
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

interface Env { h: Harness; store: TaskStore; runner: TaskRunner; exec: FakeExecutor; logs: string[]; memoryDir: string; dataDir: string; memoryKey: Buffer; taskKey: Buffer }

function setup(options: { workSummary?: boolean; unsealed?: () => boolean; memoryDir?: string; dataDir?: string; memoryKey?: Buffer; taskKey?: Buffer; port?: (port: TaskPort) => TaskPort; resultLimit?: number } = {}): Env {
  const memoryDir = options.memoryDir ?? tempDir("nous-mem5b-memory-");
  const dataDir = options.dataDir ?? tempDir("nous-mem5b-data-");
  const memoryKey = options.memoryKey ?? randomBytes(32), taskKey = options.taskKey ?? randomBytes(32);
  const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(taskKey), lockProvider: testLockProvider });
  vaults.push(vault);
  const store = new TaskStore(dataDir, { vault });
  const exec = new FakeExecutor();
  const runner = new TaskRunner(store, exec);
  const logs: string[] = [];
  // 和 server/nous.ts 相同的任務端（memoryTaskViews 是同一個函式）。
  const base: TaskPort = {
    sealed: () => !(options.unsealed?.() ?? false) && store.sealed && store.vaultStatus().failure === null,
    mode: () => runner.mode, target: () => CLAUDE, submit: (input) => runner.submitProtected(input), publicGet: (id) => store.publicGet(id),
    ...memoryTaskViews(store),
  };
  const h = harness({
    dir: memoryDir, key: memoryKey, clock: { now: Date.now() }, release: { task: true },
    tasks: options.port ? options.port(base) : base,
    onResultsWithdrawn: (ids) => runner.revokeMemory(ids),
    ...(options.workSummary === false ? {} : { workSummary: true }),
    ...(options.resultLimit ? { resultLimit: options.resultLimit } : {}),
    log: (line) => logs.push(line),
  });
  harnesses.push(h);
  // 審查 m7：和 server/nous.ts 相同，任務刪除不通知記憶層（HTTP 刪除沒有記憶票證）；由對帳處理。
  return { h, store, runner, exec, logs, memoryDir, dataDir, memoryKey, taskKey };
}

const snapshotOf = (h: Harness) => (h.service as unknown as { snapshot(): MemorySnapshot }).snapshot();
const workFacts = (h: Harness) => snapshotOf(h).facts.filter(f => f.kind === "work_summary");

/** 一般（不帶記憶）的已完成任務。 */
async function finished(env: Env, title: string) {
  const task = env.runner.submit({ title, request_id: req() });
  await env.runner.idle();
  return env.store.get(task.task_id)!;
}

/** 受保護交辦（帶記憶）：打字那一輪，再由 withChat 的 delegate 建立。 */
async function delegate(env: Env, text: string) {
  const id = req();
  const t = await env.h.turn(text, id) as unknown as { chat: { text: string; memory_turn: string | null } };
  const out = await env.h.service.withChat({ nonce: t.chat.memory_turn, requestId: id, lastUser: t.chat.text, target: CLAUDE }, async (ctx) => (ctx.delegate ? await ctx.delegate() : null));
  await env.runner.idle();
  return env.store.get(out!.task.task_id)!;
}

type WorkCard = { kind: "work_summary"; card: string; value: string; tasks: { task_id: string; title: string; finished_at: string }[]; options: string[] };
async function workCard(env: Env, text = "記住這次選了方案 B") {
  const res = await env.h.turn(text) as unknown as { card: WorkCard | null; receipts: { status: string; message: string; values: string[] }[] };
  return res;
}
async function link(env: Env, taskId: string, text = "記住這次選了方案 B") {
  const { card } = await workCard(env, text);
  expect(card?.kind).toBe("work_summary");
  return env.h.call({ op: "card_answer", card: card!.card, choice: "task", task: taskId }) as unknown as Promise<{ ok: boolean; receipts: { status: string; message: string; values: string[] }[]; code?: string }>;
}

const remember = (text: string) => parseMemoryText(text).find((s): s is Extract<ParsedSegment, { op: "remember" }> => s.op === "remember");

describe("MEM-5b parsing: explicit work decisions", () => {
  it("recognises first-person 這次／剛剛／上次＋選／決定／採用／定了／用 and English I chose / we decided / I went with", () => {
    for (const text of ["記住這次選了方案 B", "幫我記住我們剛剛決定用 Postgres", "記住上次採用了第二個版型", "記住剛才定了週五出發", "記住我這次用了舊的範本", "remember I chose plan B", "remember that we decided to use Postgres", "Remember I went with option two", "please remember we settled on the blue logo"]) {
      const seg = remember(text);
      expect(seg, text).toBeDefined();
      expect(workDecision(seg!), text).toBe(true);
    }
  });

  it("keeps every existing exclusion: preferences, today, third party, hypothetical, joke, uncertain, questions, sensitive", () => {
    for (const text of ["記住我不吃香菜", "記住今天這次選了方案 B", "remember just for today I chose plan B", "記住媽媽這次選了方案 B", "remember my mom chose plan B"]) {
      const seg = remember(text);
      expect(seg ? workDecision(seg) : false, text).toBe(false);
    }
    expect(parseMemoryText("幫媽媽記住她這次選了方案 B")[0]).toMatchObject({ op: "rejected", reason: "third_party" });
    expect(parseMemoryText("remember he chose plan B")[0]).toMatchObject({ op: "rejected", reason: "third_party" });
    expect(parseMemoryText("如果這次選了方案 B，記住")[0]).toMatchObject({ op: "rejected", reason: "hypothetical" });
    expect(parseMemoryText("記住這次選了方案 B，開玩笑的")[0]).toMatchObject({ op: "rejected", reason: "joke" });
    expect(parseMemoryText("記住這次好像選了方案 B")[0]).toMatchObject({ op: "unclear", reason: "uncertain" });
    expect(parseMemoryText("記住這次選了方案 B 嗎？")[0]!.op).not.toBe("remember");
    expect(parseMemoryText("記住這次用了密碼 hunter2")[0]).toMatchObject({ op: "rejected", reason: "sensitive" });
    // 沒有說「記住」：只是一般聊天（不寫入）。
    expect(parseMemoryText("這次選了方案 B")[0]!.op).toBe("chat");
  });

  it("審查 m1／m2: English used to / picked up / nothing, Chinese durations, reply language, a bare verb and preferences are not work decisions", () => {
    for (const text of ["remember I used to like tea", "remember I picked up the kids", "remember I selected nothing", "remember we decided on it", "記住剛剛用了很久", "記住這次用中文", "記住這次選了", "記住這次決定不要加辣"]) {
      const seg = remember(text);
      expect(seg ? workDecision(seg) : false, text).toBe(false);
    }
    // 「這次決定不要加辣」被 parse 判成偏好：和旗標關閉時一樣交給一般記住。
    expect(remember("記住這次決定不要加辣")!.kind).toBe("preference");
    for (const text of ["remember I used the blue mug", "remember I settled on tea", "remember this time I went with option 2", "記住上次用的是 A"]) expect(workDecision(remember(text)!), text).toBe(true);
  });

  it("the cascade's round count equals the hop count and stays within results + 1; reversible withdrawals forget nothing", () => {
    const fact = (id: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({ id, profileId: null, revision: 1, kind: "note", topic: "other", key: id, value: id, audience: "household", source: { kind: "explicit", turnId: "req_x", at: "2026-10-30T00:00:00Z", excerpt: id, by: null }, validFrom: "2026-10-30T00:00:00Z", expiresAt: null, reviewAfter: null, pinned: false, derivedFrom: null, ...extra });
    const task = (i: number) => `task_00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    const hops = 5;
    const facts: MemoryFact[] = [fact("mem_0")];
    const results: MemoryData["results"] = [];
    for (let i = 1; i <= hops; i++) {
      results.push({ id: `res_${String(i).padStart(16, "0")}`, taskId: task(i), subject: null, deps: [{ factId: i === 1 ? "mem_0" : `mem_w${i - 1}`, revision: 1 }], target: { provider: CLAUDE.provider, account: CLAUDE.account! }, createdAt: "2026-10-30T00:00:00Z", state: "active" });
      facts.push(fact(`mem_w${i}`, { kind: "work_summary", derivedFrom: { taskId: task(i) } }));
    }
    const before: MemoryData = { settings: { enabled: true, setupAt: "2026-10-30T00:00:00Z", suggestions: false }, profiles: [], facts, consents: [{ profileId: null, provider: CLAUDE.provider, account: CLAUDE.account!, allowed: true }], tombstones: [], results };
    const forgotten = structuredClone(before);
    forgotten.facts = forgotten.facts.filter(f => f.id !== "mem_0");
    const out = settleWithdrawals(before, forgotten, 9);
    expect(out.rounds).toBe(hops);
    expect(out.rounds).toBeLessThanOrEqual(results.length + 1);
    expect(out.cascaded).toBe(hops);
    expect(forgotten.facts).toHaveLength(0);
    expect(forgotten.results.every(r => r.state === "withdrawn")).toBe(true);
    // 記憶關閉／撤回同意：成果撤回，工作決定一筆都不忘。
    for (const change of [(d: MemoryData) => { d.settings.enabled = false; }, (d: MemoryData) => { d.consents = []; }]) {
      const off = structuredClone(before);
      change(off);
      const r = settleWithdrawals(before, off, 9);
      expect(r.cascaded).toBe(0);
      expect(r.forgotten.size).toBe(0);
      expect(off.facts).toHaveLength(hops + 1);
      expect(off.results.every(x => x.state === "withdrawn")).toBe(true);
    }
  });
});

describe.skipIf(!realLockAvailable)("MEM-5b work_summary (NOUS_MEMORY_ROUTES=work_summary)", () => {
  it("flag off: 「記住這次選了方案 B」 is still a permanent note with no task link, exactly as before", async () => {
    const env = setup({ workSummary: false });
    await enable(env.h, "George");
    await finished(env, TITLE_CANARY);
    const res = await workCard(env);
    expect(res.card).toBeNull();
    expect(res.receipts.map(r => r.status)).toEqual(["saved"]);
    const facts = snapshotOf(env.h).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: "note", value: "這次選了方案 B", derivedFrom: null, expiresAt: null });
    expect(snapshotOf(env.h).version).toBe(2);
  });

  it("flag on but tasks not sealed: unchanged note behaviour", async () => {
    const env = setup({ unsealed: () => true });
    await enable(env.h, "George");
    await finished(env, TITLE_CANARY);
    const res = await workCard(env);
    expect(res.card).toBeNull();
    expect(snapshotOf(env.h).facts[0]).toMatchObject({ kind: "note", derivedFrom: null });
  });

  it("no eligible task: falls back to a note and says so honestly", async () => {
    const env = setup();
    await enable(env.h, "George");
    const res = await workCard(env);
    expect(res.card).toBeNull();
    expect(res.receipts.map(r => r.status)).toEqual(["not_found", "saved"]);
    expect(res.receipts[0]!.message).toBe("最近 24 小時沒有可以連結的已完成工作，改用一般記住處理");
    expect(snapshotOf(env.h).facts[0]).toMatchObject({ kind: "note", derivedFrom: null });
  });

  it("choice card: lists only succeeded, not withdrawn, in-scope work from the last 24 h (newest first, at most 5); a click saves the user's own words linked to the task", async () => {
    const env = setup();
    await enable(env.h, "George");
    const old = await finished(env, "舊的工作");
    env.store.update(old.task_id, t => { t.finished_at = new Date(Date.now() - 25 * 3600_000).toISOString(); });
    const failing = env.runner.submit({ title: "會失敗的工作", request_id: req() });
    env.runner.cancel(failing.task_id);
    const recent: string[] = [];
    for (let i = 0; i < 6; i++) recent.push((await finished(env, i === 5 ? TITLE_CANARY : `工作 ${i}`)).task_id);
    env.store.update(recent[0]!, t => { t.finished_at = new Date(Date.now() - 3600_000).toISOString(); });
    const { card } = await workCard(env);
    expect(card).toMatchObject({ kind: "work_summary", value: "這次選了方案 B", options: ["task", "note", "cancel"] });
    expect(card!.tasks).toHaveLength(5);
    expect(card!.tasks.map(t => t.task_id)).not.toContain(old.task_id);
    expect(card!.tasks.map(t => t.task_id)).not.toContain(failing.task_id);
    expect(card!.tasks.map(t => t.task_id)).not.toContain(recent[0]);
    expect(card!.tasks.some(t => t.title === TITLE_CANARY)).toBe(true);
    const finishedAt = card!.tasks.map(t => t.finished_at);
    expect([...finishedAt].sort().reverse()).toEqual(finishedAt);
    // 選一個不在卡上的工作：拒絕（卡片和其他卡一樣是一次性的，要再說一次）。
    const wrong = await env.h.call({ op: "card_answer", card: card!.card, choice: "task", task: old.task_id });
    expect(wrong).toMatchObject({ ok: false, code: "bad_request" });
    expect(workFacts(env.h)).toHaveLength(0);
    const fresh = (await workCard(env)).card!;
    const chosen = fresh.tasks.find(t => t.title === TITLE_CANARY)!.task_id;
    const res = await env.h.call({ op: "card_answer", card: fresh.card, choice: "task", task: chosen }) as unknown as { ok: boolean; receipts: { status: string; message: string; values: string[] }[] };
    expect(res.ok).toBe(true);
    expect(res.receipts[0]).toMatchObject({ status: "saved", message: "記在 {0} 名下的工作決定了：{1}", values: ["George", "這次選了方案 B"] });
    const snap = snapshotOf(env.h);
    expect(snap.version).toBe(4);
    const fact = snap.facts.find(f => f.kind === "work_summary")!;
    expect(fact).toMatchObject({ value: "這次選了方案 B", derivedFrom: { taskId: chosen }, expiresAt: null, source: { kind: "explicit", excerpt: "記住這次選了方案 B", by: null } });
    expect(JSON.stringify(snap)).not.toContain(TITLE_CANARY);
    expect(JSON.stringify(snap)).not.toContain(RESULT_CANARY);
    // 卡片一次性：再按一次已失效。
    expect(await env.h.call({ op: "card_answer", card: fresh.card, choice: "task", task: chosen })).toMatchObject({ ok: false, code: "expired" });
    // 同一句、同一個工作再記一次：已經記得了。
    const again = await link(env, chosen);
    expect(again.receipts[0]!.status).toBe("unchanged");
  });

  it("re-checks at click time: a task deleted after the card was shown is not linked", async () => {
    const env = setup();
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    const { card } = await workCard(env);
    env.store.delete(task.task_id);
    const res = await env.h.call({ op: "card_answer", card: card!.card, choice: "task", task: task.task_id }) as unknown as { receipts: { status: string; message: string }[] };
    expect(res.receipts[0]).toMatchObject({ status: "not_found", message: "這個工作已不存在、已撤回或不在目前範圍內，這次沒有保存" });
    expect(snapshotOf(env.h).facts).toHaveLength(0);
  });

  it("「只記成一般筆記」 saves a plain note; 「取消」 saves nothing", async () => {
    const env = setup();
    await enable(env.h, "George");
    await finished(env, TITLE_CANARY);
    const first = await workCard(env);
    const note = await env.h.call({ op: "card_answer", card: first.card!.card, choice: "note" }) as unknown as { receipts: { status: string }[] };
    expect(note.receipts[0]!.status).toBe("saved");
    expect(snapshotOf(env.h).facts.map(f => [f.kind, f.derivedFrom])).toEqual([["note", null]]);
    const second = await workCard(env, "記住剛剛決定用 Postgres");
    const cancel = await env.h.call({ op: "card_answer", card: second.card!.card, choice: "cancel" }) as unknown as { receipts: { status: string }[] };
    expect(cancel.receipts[0]!.status).toBe("cancelled");
    expect(snapshotOf(env.h).facts).toHaveLength(1);
  });

  it("the card is bound to the epoch and the person: switching person invalidates it, and another person's memory task is out of scope", async () => {
    const env = setup();
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const george = await delegate(env, "幫我規劃一週晚餐");
    expect(george.memory).toBe(true);
    const plain = await finished(env, "整理收據");
    const { card } = await workCard(env);
    expect(card!.tasks.map(t => t.task_id).sort()).toEqual([george.task_id, plain.task_id].sort());
    await enable(env.h, "Alice");
    expect(await env.h.call({ op: "card_answer", card: card!.card, choice: "task", task: george.task_id })).toMatchObject({ ok: false, code: "expired" });
    // Alice 看不到 George 帶記憶的任務（D2 範圍）。
    const alice = await workCard(env);
    expect(alice.card!.tasks.map(t => t.task_id)).toEqual([plain.task_id]);
    expect(workFacts(env.h)).toHaveLength(0);
  });

  it("minors are refused (no card, nothing saved); no selected person follows the existing clarify flow", async () => {
    const env = setup();
    await enable(env.h, "Kid");
    await finished(env, TITLE_CANARY);
    const token = await manage(env.h);
    const status = await env.h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] };
    await env.h.call({ op: "profile_minor", profile: status.profiles.find(p => p.name === "Kid")!.id, minor: true, token });
    const res = await workCard(env);
    expect(res.card).toBeNull();
    expect(res.receipts.map(r => r.status)).toEqual(["minor"]);
    await selectProfile(env.h, null);
    const none = await workCard(env);
    expect(none.card?.kind).toBe("clarify");
    expect(snapshotOf(env.h).facts).toHaveLength(0);
  });

  it("the model only ever receives the user's words: chat context and task executor payloads carry no title, result or task id; logs carry counts only", async () => {
    const env = setup();
    // 全體 SSE 的 task.updated／task.deleted 來源（app.ts 的 broadcast 直接轉送這兩個訂閱）。
    const sse: unknown[] = [];
    env.store.subscribe((task) => sse.push(task));
    env.store.subscribeDeleted((deleted) => sse.push(deleted));
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    await link(env, task.task_id);
    const id = req();
    const t = await env.h.turn("方案 B 的細節是什麼", id) as unknown as { chat: { text: string; memory_turn: string } };
    const facts = await env.h.service.withChat({ nonce: t.chat.memory_turn, requestId: id, lastUser: t.chat.text, target: CLAUDE }, async (ctx) => ctx.facts);
    expect(facts.map(f => f.text)).toEqual(["這次選了方案 B"]);
    const payload = JSON.stringify(facts);
    for (const canary of [TITLE_CANARY, RESULT_CANARY, task.task_id]) expect(payload).not.toContain(canary);
    const delegated = await delegate(env, "把方案 B 寫成報告");
    expect(env.exec.inputs.at(-1)!.facts!.map(f => f.text)).toEqual(["這次選了方案 B"]);
    expect(JSON.stringify(env.exec.inputs.at(-1))).not.toContain(TITLE_CANARY);
    expect(delegated.memory).toBe(true);
    const logs = env.logs.join("\n");
    for (const canary of [TITLE_CANARY, RESULT_CANARY, "方案 B", task.task_id]) expect(logs).not.toContain(canary);
    expect(logs).toContain("memory: 工作決定 1 筆（連到 1 個工作）");
    const events = JSON.stringify(sse);
    for (const canary of [TITLE_CANARY, RESULT_CANARY, "方案 B"]) expect(events).not.toContain(canary);
  });

  it("task deletion (HTTP, no memory ticket) does not touch memory; retrieval skips the fact at once and the next trusted turn reconciles it in one commit", async () => {
    const env = setup();
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    const other = await finished(env, "另一個工作");
    await link(env, task.task_id);
    await link(env, task.task_id, "記住剛剛決定用 Postgres");
    await link(env, other.task_id, "記住上次採用了第二個版型");
    expect(workFacts(env.h)).toHaveLength(3);
    const before = snapshotOf(env.h).revision;
    expect(env.store.delete(task.task_id).ok).toBe(true);
    // 刪除本身不改記憶檔（審查 m7）。
    expect(snapshotOf(env.h).revision).toBe(before);
    // 可信主視窗的下一輪：先對帳（一次提交忘記 2 筆），這一輪的檢索看不到它們。
    const id = req();
    const t = await env.h.turn("方案 B 和 Postgres 是什麼", id) as unknown as { chat: { text: string; memory_turn: string } };
    const snap = snapshotOf(env.h);
    expect(snap.revision).toBe(before + 1);
    expect(workFacts(env.h).map(f => f.derivedFrom!.taskId)).toEqual([other.task_id]);
    expect(snap.tombstones).toHaveLength(2);
    expect(JSON.stringify(snap.tombstones)).not.toContain("Postgres");
    expect(env.logs).toContain("memory: 工作決定連帶忘記 2 筆（任務已不存在）");
    const facts = await env.h.service.withChat({ nonce: t.chat.memory_turn, requestId: id, lastUser: t.chat.text, target: CLAUDE }, async (ctx) => ctx.facts);
    expect(facts.map(f => f.text)).not.toContain("剛剛決定用 Postgres");
  });

  it("the memory list also reconciles before listing (trusted IPC)", async () => {
    const env = setup();
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    await link(env, task.task_id);
    env.store.delete(task.task_id);
    const list = await env.h.call({ op: "list" }) as unknown as { facts: { kind: string }[] };
    expect(list.facts.filter(f => f.kind === "work_summary")).toHaveLength(0);
    expect(workFacts(env.h)).toHaveLength(0);
  });

  it("race: a task deleted while the click waits for the lock or the commit never leaves a linked fact behind", async () => {
    for (const ticks of [0, 1, 3, 8]) {
      const env = setup();
      await enable(env.h, "George");
      const task = await finished(env, TITLE_CANARY);
      const { card } = await workCard(env);
      const answer = env.h.call({ op: "card_answer", card: card!.card, choice: "task", task: task.task_id });
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      env.store.delete(task.task_id);
      await answer;
      await env.h.turn("你好");
      expect(workFacts(env.h), `ticks ${ticks}`).toHaveLength(0);
    }
  });

  it("withdraw cascade reaches a fixed point across hops inside one commit", async () => {
    const env = setup();
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    // T1 用了「不吃香菜」；W1 連到 T1；T2 用了 W1；W2 連到 T2。
    const t1 = await delegate(env, "幫我規劃一週晚餐");
    await link(env, t1.task_id);
    const t2 = await delegate(env, "把方案 B 寫成報告");
    expect(env.exec.inputs.at(-1)!.facts!.map(f => f.text)).toEqual(["這次選了方案 B"]);
    await link(env, t2.task_id, "記住剛剛決定用方案 B 的報告");
    expect(workFacts(env.h)).toHaveLength(2);
    const before = snapshotOf(env.h).revision;
    // 忘記「不吃香菜」→ T1 撤回 → W1 忘記 → T2 撤回 → W2 忘記，全部在同一次提交。
    const token = await manage(env.h);
    const list = await env.h.call({ op: "list", token }) as unknown as { facts: { id: string; revision: number; text: string }[] };
    const cilantro = list.facts.find(f => f.text === "不吃香菜")!;
    const res = await env.h.call({ op: "forget", id: cilantro.id, revision: cilantro.revision, token });
    expect(res).toMatchObject({ ok: true });
    const snap = snapshotOf(env.h);
    expect(snap.revision).toBe(before + 1);
    expect(snap.facts).toHaveLength(0);
    expect(snap.results.map(r => r.state)).toEqual(["withdrawn", "withdrawn"]);
    await env.runner.idle();
    expect(env.store.publicGet(t1.task_id)!.withdrawn).toBe(true);
    expect(env.store.publicGet(t2.task_id)!.withdrawn).toBe(true);
    expect(env.logs.some(l => /連帶忘記工作決定 2 筆，2 輪/.test(l))).toBe(true);
    // 寫回 version 3（沒有 work_summary 了，但有依賴索引）。
    expect(snap.version).toBe(3);
  });

  it("審查 M1 (probe P1): turning memory off keeps work decisions (results are withdrawn only); after turning it back on they are listed and retrieved", async () => {
    const env = setup();
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const t1 = await delegate(env, "幫我規劃一週晚餐");
    const plain = await finished(env, "整理收據");
    await link(env, t1.task_id);
    await link(env, plain.task_id, "記住剛剛決定用 Postgres");
    const token = await manage(env.h);
    await env.h.call({ op: "setup", token, enabled: false, subject: { kind: "household" }, allow: [] });
    expect(snapshotOf(env.h).results.map(r => r.state)).toEqual(["withdrawn"]);
    expect(workFacts(env.h).map(f => f.value).sort()).toEqual(["剛剛決定用 Postgres", "這次選了方案 B"]);
    expect(env.logs.some(l => l.includes("連帶忘記工作決定"))).toBe(false);
    await env.runner.idle();
    expect(env.store.publicGet(t1.task_id)!.withdrawn).toBe(true);
    await enable(env.h, "George");
    await env.h.turn("你好");
    expect(workFacts(env.h)).toHaveLength(2);
    const id = req();
    const t = await env.h.turn("方案 B 是什麼", id) as unknown as { chat: { text: string; memory_turn: string } };
    const facts = await env.h.service.withChat({ nonce: t.chat.memory_turn, requestId: id, lastUser: t.chat.text, target: CLAUDE }, async (ctx) => ctx.facts);
    expect(facts.map(f => f.text)).toContain("這次選了方案 B");
  });

  it("審查 M1 (probe P2): revoking consent keeps work decisions", async () => {
    const env = setup();
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const t1 = await delegate(env, "幫我規劃一週晚餐");
    await link(env, t1.task_id);
    const token = await manage(env.h);
    const status = await env.h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] };
    await env.h.call({ op: "setup", token, enabled: true, subject: { kind: "profile", profile: status.profiles.find(p => p.name === "George")!.id }, allow: [] });
    expect(snapshotOf(env.h).results.map(r => r.state)).toEqual(["withdrawn"]);
    expect(workFacts(env.h)).toHaveLength(1);
  });

  it("審查 M1: a result-index overflow withdraws the oldest result but keeps its work decision, without an epoch change", async () => {
    const env = setup({ resultLimit: 1 });
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const t1 = await delegate(env, "幫我規劃一週晚餐");
    await link(env, t1.task_id);
    const epoch = (await env.h.call({ op: "status" }) as unknown as { presence: { epoch: number } }).presence.epoch;
    const memo = await env.h.call({ op: "turn", text: "幫我規劃一週午餐", request_id: req() }) as unknown as { chat: { text: string; memory_turn: string } };
    void memo;
    const t2 = await delegate(env, "幫我規劃一週早餐");
    expect(t2.memory).toBe(true);
    expect(snapshotOf(env.h).results.map(r => r.taskId)).toEqual([t2.task_id]);
    expect(workFacts(env.h).map(f => f.derivedFrom!.taskId)).toEqual([t1.task_id]);
    expect((await env.h.call({ op: "status" }) as unknown as { presence: { epoch: number } }).presence.epoch).toBe(epoch);
  });

  it("審查 m1 (probe P3): 「remember I used to like tea」 gets no work card even with work available", async () => {
    const env = setup();
    await enable(env.h, "George");
    await finished(env, "整理收據");
    const res = await workCard(env, "remember I used to like tea");
    expect(res.card).toBeNull();
    expect(snapshotOf(env.h).facts.map(f => f.kind)).toEqual(["preference"]);
  });

  it("voice with the flag on still creates a plain note (no work card from voice)", async () => {
    const env = setup();
    await enable(env.h, "George");
    await finished(env, TITLE_CANARY);
    const out = await env.h.service.voiceTurn("記住這次選了方案 B", "live");
    expect(out.kind).toBe("confirm");
    const res = await env.h.call({ op: "card_answer", card: (out as { card: string }).card, choice: "confirm" }) as unknown as { receipts: { status: string }[] };
    expect(res.receipts[0]!.status).toBe("saved");
    expect(snapshotOf(env.h).facts.map(f => [f.kind, f.derivedFrom])).toEqual([["note", null]]);
  });

  it("審查 m3 (probe P4): building the card does not decrypt titles of old, failed or out-of-window tasks", async () => {
    const env = setup();
    await enable(env.h, "George");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await finished(env, `工作 ${i}`)).task_id);
    for (const id of ids.slice(0, 10)) env.store.update(id, t => { t.finished_at = new Date(Date.now() - 30 * 3600_000).toISOString(); });
    const s = env.store as unknown as { titles: Map<string, unknown>; cool(id: string): void };
    for (const id of ids) s.cool(id);
    s.titles.clear();
    const { card } = await workCard(env);
    expect(card!.tasks.map(t => t.task_id).sort()).toEqual(ids.slice(10).sort());
    expect(s.titles.size).toBeLessThanOrEqual(2);
  });

  it("審查 m5: the request_id cache keeps no task titles; a replay refetches them and drops deleted work", async () => {
    const env = setup();
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    const id = req();
    const first = await env.h.turn("記住這次選了方案 B", id) as unknown as { card: WorkCard };
    expect(first.card.tasks[0]!.title).toBe(TITLE_CANARY);
    const recent = (env.h.service as unknown as { recent: Map<string, unknown> }).recent;
    expect(JSON.stringify([...recent.values()])).not.toContain(TITLE_CANARY);
    const replay = await env.h.turn("記住這次選了方案 B", id) as unknown as { card: WorkCard };
    expect(replay.card.tasks.map(t => t.title)).toEqual([TITLE_CANARY]);
    env.store.delete(task.task_id);
    const after = await env.h.turn("記住這次選了方案 B", id) as unknown as { card: WorkCard };
    expect(after.card.tasks).toEqual([]);
  });

  it("「只記成一般筆記」 is not blocked by an existing work decision with the same words (kind-aware duplicate check)", async () => {
    const env = setup();
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    await link(env, task.task_id);
    const { card } = await workCard(env);
    const res = await env.h.call({ op: "card_answer", card: card!.card, choice: "note" }) as unknown as { receipts: { status: string }[] };
    expect(res.receipts[0]!.status).toBe("saved");
    expect(snapshotOf(env.h).facts.map(f => f.kind).sort()).toEqual(["note", "work_summary"]);
  });

  it("a single corrupt task file with the correct key is not purged (the task is still present)", async () => {
    const memoryDir = tempDir("nous-mem5b-memory-"), dataDir = tempDir("nous-mem5b-data-");
    const memoryKey = randomBytes(32), taskKey = randomBytes(32);
    const env = setup({ memoryDir, dataDir, memoryKey, taskKey });
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    await link(env, task.task_id);
    await env.h.close();
    vaults.splice(0).forEach(v => v.close());
    writeFileSync(join(dataDir, "sealed", `${task.task_id}.enc`), "corrupt");
    const next = setup({ memoryDir, dataDir, memoryKey, taskKey });
    expect(next.store.vaultStatus().failure).toBeNull();
    expect(next.store.publicGet(task.task_id)).toBeDefined();
    await next.h.turn("你好");
    await next.h.call({ op: "list" });
    expect(workFacts(next.h)).toHaveLength(1);
    // 標籤照實說不在範圍內（讀不到標題），不是已不存在。
    await enable(next.h, "George");
    const list = await next.h.call({ op: "list" }) as unknown as { facts: { work: { state: string; title: string | null } | null }[] };
    expect(list.facts[0]!.work).toMatchObject({ state: "out_of_scope", title: null });
  });

  it("reconcile on open forgets work decisions whose task disappeared while memory was closed (crash between delete and commit); retrieval already skips them", async () => {
    const memoryDir = tempDir("nous-mem5b-memory-"), dataDir = tempDir("nous-mem5b-data-");
    const memoryKey = randomBytes(32), taskKey = randomBytes(32);
    const env = setup({ memoryDir, dataDir, memoryKey, taskKey });
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    const keep = await finished(env, "保留的工作");
    await link(env, task.task_id);
    await link(env, keep.task_id, "記住剛剛決定用 Postgres");
    // 刪除任務後，記憶層還沒對帳就結束（等同刪除寫完、記憶提交前當機）。
    expect(env.store.delete(task.task_id).ok).toBe(true);
    expect(workFacts(env.h)).toHaveLength(2);
    const id = req();
    // 檢索前就排除（usableFacts；這裡直接看，不經會先對帳的 turn）。
    const usable = (env.h.service as unknown as { usableFacts(f: MemorySnapshot["facts"]): MemorySnapshot["facts"] }).usableFacts(snapshotOf(env.h).facts);
    expect(usable.filter(f => f.kind === "work_summary").map(f => f.value)).toEqual(["剛剛決定用 Postgres"]);
    void id;
    // 重啟：同一個記憶檔與任務資料夾。
    await env.h.close();
    vaults.splice(0).forEach(v => v.close());
    const next = setup({ memoryDir, dataDir, memoryKey, taskKey });
    await next.h.turn("你好");
    expect(workFacts(next.h).map(f => f.derivedFrom!.taskId)).toEqual([keep.task_id]);
    expect(next.logs).toContain("memory: 工作決定連帶忘記 1 筆（任務已不存在）");
  });

  it("reconcile does not purge when tasks cannot be read (key failure): consistent with MEM-4a B1", async () => {
    const memoryDir = tempDir("nous-mem5b-memory-"), dataDir = tempDir("nous-mem5b-data-");
    const memoryKey = randomBytes(32), taskKey = randomBytes(32);
    const env = setup({ memoryDir, dataDir, memoryKey, taskKey });
    await enable(env.h, "George");
    const task = await finished(env, TITLE_CANARY);
    await link(env, task.task_id);
    await env.h.close();
    vaults.splice(0).forEach(v => v.close());
    // 任務的金鑰換掉（讀不到內容）：任務仍在清單上，記憶層不清。
    const wrongKey = setup({ memoryDir, dataDir, memoryKey, taskKey: randomBytes(32) });
    await wrongKey.h.turn("你好");
    expect(workFacts(wrongKey.h)).toHaveLength(1);
    await wrongKey.h.close();
    vaults.splice(0).forEach(v => v.close());
    // 任務沒有加密保存（金鑰不可用）：不知道任務在不在，一律不清，log 照實說。
    const unknown = setup({ memoryDir, dataDir, memoryKey, taskKey, unsealed: () => true, port: (p) => ({ ...p, taskState: () => "missing" }) });
    await unknown.h.turn("你好");
    expect(workFacts(unknown.h)).toHaveLength(1);
    expect(unknown.logs.some(l => l.startsWith("memory: 工作決定對帳略過"))).toBe(true);
  });

  it("the memory list shows 「工作決定」 with the task title only while it is in scope", async () => {
    const env = setup();
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const george = await delegate(env, "幫我規劃一週晚餐");
    await link(env, george.task_id);
    const list = await env.h.call({ op: "list" }) as unknown as { facts: { kind: string; text: string; work: { task_id: string; title: string | null; state: string } | null }[] };
    const work = list.facts.find(f => f.kind === "work_summary")!;
    expect(work.work).toEqual({ task_id: george.task_id, title: "幫我規劃一週晚餐", state: "in_scope" });
    expect(list.facts.find(f => f.kind === "preference")!.work).toBeNull();
    // 管理畫面看 George 的記憶，但本次人物是 Alice：George 帶記憶的任務不在範圍內，只說連到的工作不在範圍。
    await enable(env.h, "Alice");
    const token = await manage(env.h);
    const status = await env.h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] };
    const managed = await env.h.call({ op: "list", token, subject: status.profiles.find(p => p.name === "George")!.id }) as unknown as { facts: { kind: string; work: { title: string | null; state: string } | null }[] };
    expect(managed.facts.find(f => f.kind === "work_summary")!.work).toMatchObject({ title: null, state: "out_of_scope" });
  });

  it("v4 is written only while a work_summary exists; v2 stays byte-compatible otherwise", async () => {
    const env = setup();
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const envelope = () => JSON.parse(readFileSync(join(env.memoryDir, MEMORY_FILE), "utf8")) as { version: number };
    expect(envelope().version).toBe(2);
    const task = await finished(env, TITLE_CANARY);
    await link(env, task.task_id);
    expect(envelope().version).toBe(4);
    env.store.delete(task.task_id);
    await env.h.turn("你好");
    expect(envelope().version).toBe(2);
  });
});

describe("MEM-5b IPC filter and bilingual strings", () => {
  it("card_answer accepts task and note choices and a well-formed task id only", () => {
    const card = `mc_${"a".repeat(24)}`, task = "task_01234567-89ab-cdef-0123-456789abcdef";
    expect(validateMemoryRequest({ op: "card_answer", card, choice: "task", task, extra: 1 })).toEqual({ ok: true, request: { op: "card_answer", card, choice: "task", task } });
    expect(validateMemoryRequest({ op: "card_answer", card, choice: "note" })).toEqual({ ok: true, request: { op: "card_answer", card, choice: "note" } });
    expect(validateMemoryRequest({ op: "card_answer", card, choice: "task", task: "task_x" })).toMatchObject({ ok: false });
  });

  it("every new core sentence has an English translation", () => {
    const en = serverMessages as Record<string, string>;
    for (const key of ["最近 24 小時沒有可以連結的已完成工作，改用一般記住處理", "工作決定目前沒有開放（或任務沒有加密保存），這次沒有保存", "這個工作已不存在、已撤回或不在目前範圍內，這次沒有保存", "已經記得這個工作決定了（{0}）：{1}", "記在 {0} 名下的工作決定了：{1}", "請從卡片上的工作選擇"]) {
      expect(en[key], key).toBeTruthy();
      expect(en[key]).not.toMatch(/\p{Script=Han}/u);
    }
    const page = pageMessages as Record<string, string>;
    for (const key of ["要連到哪一個工作？", "只記成一般筆記", "連到這個工作", "工作決定", "工作決定 · 連到：{0}", "篩選記憶"]) expect(page[key], key).toBeTruthy();
  });
});
