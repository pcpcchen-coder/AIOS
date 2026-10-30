import { createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_BLOCK_OPEN } from "../server/chat.ts";
import { MemoryStore, type MemorySnapshot } from "../server/memory/store.ts";
import { MemoryService, withdrawals } from "../server/memory/service.ts";
import { CONTEXT_MAX_BYTES, CONTEXT_MAX_FACTS, type ContextFact } from "../server/memory/retrieve.ts";
import { systemPrompt } from "../server/prompts.ts";
import { TaskRunner, type ExecutionResult, type Executor, type Reporter } from "../server/runner.ts";
import { SealedVault } from "../server/sealed-vault.ts";
import { TaskStore } from "../server/store.ts";
import type { ExecutorMode } from "../shared/types.ts";
import type { Locale } from "../shared/i18n.mjs";
import { CHATGPT, CLAUDE, enable, fakeBox, harness, manage, req, selectProfile, type Harness } from "./fixtures/memory-service.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";

// MEM-4a：背景任務自動帶記憶（受保護交辦）、依賴索引（快照 v3）與撤銷傳播（Q3-A）。真 AES-GCM 的記憶快照與任務加密檔；
// 執行器是假的（不呼叫模型），只記下收到的輸入，並可以卡住來測「執行中被撤銷」。全部人物與內容都是虛構的。

const ART_CANARY = "CANARY_受保護成果_IBEX_2290";

class FakeExecutor implements Executor {
  inputs: { title: string; facts?: readonly ContextFact[]; mode: ExecutorMode }[] = [];
  gate: Promise<void> | null = null;
  release: (() => void) | null = null;
  ignoreAbort = false;
  constructor(public mode: ExecutorMode = "claude") {}
  hold(): void { this.gate = new Promise(r => { this.release = r; }); }
  async run(input: { title: string; mode: ExecutorMode; locale?: Locale; facts?: readonly ContextFact[] }, reporter: Reporter, signal: AbortSignal): Promise<ExecutionResult> {
    this.inputs.push({ title: input.title, mode: input.mode, ...(input.facts ? { facts: input.facts } : {}) });
    reporter.planReady([{ title: `步驟（${input.facts?.map(f => f.text).join("、") ?? "無記憶"}）`, domain: "language" }], "fixture-model");
    reporter.stepStarted(0);
    if (this.gate) await this.gate;
    if (signal.aborted && !this.ignoreAbort) throw new Error("aborted");
    reporter.stepDone(0);
    return { content: `${ART_CANARY} ${input.facts?.map(f => f.text).join("、") ?? ""}`, assumptions: [], capability_gaps: [], status: "complete", model: "fixture-model" };
  }
}

const dirs: string[] = [], harnesses: Harness[] = [], vaults: SealedVault[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.close()));
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(options: { resultLimit?: number; unsealed?: boolean; task?: boolean; mode?: ExecutorMode; memoryDir?: string; memoryKey?: Buffer; dataDir?: string; taskKey?: Buffer } = {}) {
  const memoryDir = options.memoryDir ?? (() => { const d = mkdtempSync(join(tmpdir(), "nous-mem4-memory-")); dirs.push(d); return d; })();
  const dataDir = options.dataDir ?? (() => { const d = mkdtempSync(join(tmpdir(), "nous-mem4-data-")); dirs.push(d); return d; })();
  const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(options.taskKey ?? randomBytes(32)), lockProvider: testLockProvider });
  vaults.push(vault);
  const store = new TaskStore(dataDir, { vault });
  const exec = new FakeExecutor(options.mode ?? "claude");
  const runner = new TaskRunner(store, exec);
  const target = { current: CLAUDE };
  const h = harness({
    dir: memoryDir, key: options.memoryKey ?? randomBytes(32),
    ...(options.task === false ? {} : { release: { task: true } }),
    tasks: { sealed: () => !options.unsealed && store.sealed && store.vaultStatus().failure === null, mode: () => runner.mode, target: () => (runner.mode === "mock" ? null : target.current), submit: (input) => runner.submitProtected(input) },
    onResultsWithdrawn: (ids) => runner.revokeMemory(ids),
    ...(options.resultLimit ? { resultLimit: options.resultLimit } : {}),
  });
  harnesses.push(h);
  return { h, store, runner, exec, vault, dataDir, memoryDir };
}

async function memoryTurn(h: Harness, text: string) {
  const id = req();
  const t = await h.turn(text, id) as unknown as { chat: { text: string; memory_turn: string | null } };
  return { id, text: t.chat.text, nonce: t.chat.memory_turn };
}

/** 一般文字聊天裡，模型交辦時核心走的受保護交辦（app.ts 的 streamChat 也是這樣呼叫）。 */
async function delegate(h: Harness, text: string) {
  const t = await memoryTurn(h, text);
  return h.service.withChat({ nonce: t.nonce, requestId: t.id, lastUser: t.text, target: CLAUDE }, async (ctx) => ({ ctx, out: ctx.delegate ? await ctx.delegate() : null }));
}

const snapshotOf = (h: Harness) => (h.service as unknown as { snapshot(): MemorySnapshot }).snapshot();

async function factId(h: Harness): Promise<{ token: string; id: string; revision: number; profile: string }> {
  const token = await manage(h);
  const list = await h.call({ op: "list", token }) as unknown as { facts: { id: string; revision: number }[]; subject: string };
  return { token, id: list.facts[0]!.id, revision: list.facts[0]!.revision, profile: list.subject };
}

async function seededSucceeded() {
  const env = setup();
  await enable(env.h, "George");
  await env.h.turn("記住，我不吃香菜");
  const { out } = await delegate(env.h, "幫我規劃一週晚餐");
  await env.runner.idle();
  const task = env.store.get(out!.task.task_id)!;
  return { ...env, task };
}

describe.skipIf(!realLockAvailable)("MEM-4a protected delegation (NOUS_MEMORY_ROUTES=task)", () => {
  it("retrieves for the user's own sentence, passes facts to the executor, writes the dependency index first (snapshot v3)", async () => {
    const { h, store, runner, exec } = setup();
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const { ctx, out } = await delegate(h, "幫我規劃一週晚餐");
    expect(ctx.delegate).not.toBeNull();
    expect(out!.used).toBe(1);
    await runner.idle();
    expect(exec.inputs).toHaveLength(1);
    expect(exec.inputs[0]!.title).toBe("幫我規劃一週晚餐");
    expect(exec.inputs[0]!.facts!.map(f => f.text)).toEqual(["不吃香菜"]);
    expect(exec.inputs[0]!.facts![0]).not.toHaveProperty("id");
    const task = store.get(out!.task.task_id)!;
    expect(task).toMatchObject({ title: "幫我規劃一週晚餐", memory: true, status: "succeeded", origin: "user_sentence" });
    const snap = snapshotOf(h);
    expect(snap.version).toBe(3);
    expect(snap.results).toHaveLength(1);
    expect(snap.results[0]).toMatchObject({ taskId: task.task_id, state: "active", target: { provider: CLAUDE.provider, account: CLAUDE.account }, deps: [{ factId: snap.facts[0]!.id, revision: snap.facts[0]!.revision }] });
    expect(JSON.stringify(snap.results)).not.toContain("香菜");
  });

  it("review M1: when tasks are not actually sealed (plaintext fallback, key trouble) there is no protected delegation", async () => {
    const { h, store, exec } = setup({ unsealed: true });
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const { ctx, out } = await delegate(h, "幫我規劃一週晚餐");
    expect(ctx.delegate).not.toBeNull();
    expect(out).toBeNull();
    expect(exec.inputs).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(snapshotOf(h).results).toEqual([]);
    // 金鑰問題的 TaskStore 也一樣：sealed() 為 false。
    const keyless = new TaskStore(null, { vault: null, failure: "key_unavailable" });
    expect(keyless.sealed && keyless.vaultStatus().failure === null).toBe(false);
  });

  it("the executors' system prompt carries the memory as a read-only block (and a web-search caution); without facts it is unchanged", () => {
    const facts: ContextFact[] = [{ text: "不吃香菜", source: "explicit", at: "2026-10-30T00:00:00Z", expires: null }];
    expect(systemPrompt({ webSearch: true }, "zh-TW", facts)).toContain(MEMORY_BLOCK_OPEN);
    expect(systemPrompt({ webSearch: true }, "zh-TW", facts)).toContain("不要把下面記憶裡的個人偏好");
    expect(systemPrompt({ webSearch: true }, "zh-TW", [])).toBe(systemPrompt({ webSearch: true }, "zh-TW"));
    expect(systemPrompt({ webSearch: false }, "en")).not.toContain(MEMORY_BLOCK_OPEN);
  });

  it("keeps the 8 facts / 4 KB limits for task retrieval", async () => {
    const { h, runner, exec } = setup();
    await enable(h, "George");
    for (let i = 0; i < 12; i++) await h.turn(`記住，晚餐不要${"很辣的".repeat(20)}料理第${i}號`);
    await delegate(h, "幫我規劃晚餐料理");
    await runner.idle();
    const facts = exec.inputs[0]!.facts!;
    expect(facts.length).toBeLessThanOrEqual(CONTEXT_MAX_FACTS);
    expect(facts.reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f)) + 1, 0)).toBeLessThanOrEqual(CONTEXT_MAX_BYTES);
  });

  it("the mock engine gets no memory and no dependency entry; the title is still the user's sentence", async () => {
    const { h, runner, exec } = setup({ mode: "mock" });
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const { out } = await delegate(h, "幫我規劃一週晚餐");
    await runner.idle();
    expect(out!.used).toBe(0);
    expect(exec.inputs[0]).toMatchObject({ title: "幫我規劃一週晚餐" });
    expect(exec.inputs[0]!.facts).toBeUndefined();
    expect(snapshotOf(h).results).toEqual([]);
    expect(snapshotOf(h).version).toBe(2);
  });

  it("no consent on the task engine's target: the task runs without memory", async () => {
    const env = setup();
    await enable(env.h, "George", [CHATGPT]);
    await env.h.turn("記住，我不吃香菜");
    const { out } = await delegate(env.h, "幫我規劃一週晚餐");
    await env.runner.idle();
    expect(out!.used).toBe(0);
    expect(env.exec.inputs[0]!.facts).toBeUndefined();
  });

  it("flag off: no protected delegation (M15 unchanged) and the snapshot stays version 2 with the MEM-3 key layout", async () => {
    const { h, exec, memoryDir } = setup({ task: false });
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const { ctx, out } = await delegate(h, "幫我規劃一週晚餐");
    expect(ctx.delegate).toBeNull();
    expect(ctx.blockDelegation).toBe(true);
    expect(out).toBeNull();
    expect(exec.inputs).toEqual([]);
    // 快照信封仍是 version 2（欄位順序見下一個測試）。
    expect(JSON.parse(readFileSync(join(memoryDir, "store.v1.enc"), "utf8")).version).toBe(2);
  });

  it("v2 on disk has exactly the MEM-3 keys; v3 (with results) is written only after the first protected result", async () => {
    const key = randomBytes(32);
    const env = setup({ memoryKey: key });
    const plain = () => {
      const e = JSON.parse(readFileSync(join(env.memoryDir, "store.v1.enc"), "utf8"));
      const dek = Buffer.from(fakeBox(key).open(Buffer.from(e.wrappedKey, "base64")), "base64");
      const d = createDecipheriv("aes-256-gcm", dek, Buffer.from(e.nonce, "base64"));
      d.setAAD(Buffer.from(JSON.stringify([e.format, e.version, e.revision, e.wrappedKey]))); d.setAuthTag(Buffer.from(e.tag, "base64"));
      return { envelope: e.version as number, body: JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]).toString("utf8")) as Record<string, unknown> };
    };
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜");
    const before = plain();
    expect(before.envelope).toBe(2);
    expect(Object.keys(before.body)).toEqual(["format", "version", "revision", "dedupKey", "receiptFloor", "settings", "profiles", "facts", "consents", "tombstones", "receipts"]);
    await delegate(env.h, "幫我規劃一週晚餐");
    const after = plain();
    expect(after.envelope).toBe(3);
    expect(after.body.version).toBe(3);
    expect(Object.keys(after.body)).toContain("results");
    // 升到 3 之後重新開啟也讀得回來（舊版 App 會當成損壞，見驗證文件）。
    await env.h.close();
    const s2 = await MemoryStore.open({ dir: env.memoryDir, secretBox: fakeBox(key), lockProvider: testLockProvider });
    expect(s2.read().results).toHaveLength(1);
    await s2.close();
  });
});

describe.skipIf(!realLockAvailable)("MEM-4a revoke propagation (Q3-A)", () => {
  const paths: [string, (h: Harness) => Promise<void>][] = [
    ["forget", async (h) => { const f = await factId(h); expect((await h.call({ op: "forget", id: f.id, revision: f.revision, token: f.token })).ok).toBe(true); }],
    ["correct", async (h) => { const f = await factId(h); expect((await h.call({ op: "edit", id: f.id, revision: f.revision, value: "不吃蔥", token: f.token })).ok).toBe(true); }],
    ["consent revocation", async (h) => { const f = await factId(h); expect((await h.call({ op: "setup", token: f.token, enabled: true, subject: { kind: "profile", profile: f.profile }, allow: [] })).ok).toBe(true); }],
    ["person deletion", async (h) => { const f = await factId(h); expect((await h.call({ op: "profile_delete", profile: f.profile, token: f.token })).ok).toBe(true); }],
    ["memory off", async (h) => { const f = await factId(h); expect((await h.call({ op: "setup", token: f.token, enabled: false, subject: { kind: "profile", profile: f.profile }, allow: [{ provider: CLAUDE.provider, account: CLAUDE.account }] })).ok).toBe(true); }],
    ["forget all", async (h) => { const f = await factId(h); expect((await h.call({ op: "forget", all: true, subject: f.profile, token: f.token })).ok).toBe(true); }],
  ];

  it.each(paths)("%s: the finished result file is deleted, a redacted shell with redo remains", async (_name, revoke) => {
    const { h, store, vault, task, dataDir } = await seededSucceeded();
    const artifactId = task.artifact_id!;
    expect(vault.ids()).toContain(artifactId);
    await revoke(h);
    const after = store.get(task.task_id)!;
    expect(after).toMatchObject({ withdrawn: true, artifact_id: null, title: "幫我規劃一週晚餐", status: "succeeded" });
    expect(after.steps.every(s => s.title === "受保護的步驟")).toBe(true);
    expect(store.getArtifact(artifactId)).toBeUndefined();
    expect(vault.ids()).not.toContain(artifactId);
    expect(existsSync(join(dataDir, "sealed", `${artifactId}.enc`))).toBe(false);
    expect(store.publicGet(task.task_id)).toMatchObject({ withdrawn: true, protected: true });
    const r = snapshotOf(h).results.find(x => x.taskId === task.task_id)!;
    expect(r).toMatchObject({ state: "withdrawn", deps: [], subject: null });
  });

  it("a running task whose memory is revoked is cancelled with memory_revoked, produces no result, and late output is dropped", async () => {
    const { h, store, runner, exec, vault } = setup();
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    exec.hold();
    exec.ignoreAbort = true; // 執行器不理會中止，晚一點還是回傳成果
    const { out } = await delegate(h, "幫我規劃一週晚餐");
    await new Promise(r => setTimeout(r, 10));
    expect(store.get(out!.task.task_id)!.status).toBe("running");
    const f = await factId(h);
    await h.call({ op: "forget", id: f.id, revision: f.revision, token: f.token });
    exec.release!();
    await runner.idle();
    const task = store.get(out!.task.task_id)!;
    expect(task).toMatchObject({ status: "cancelled", cancel_reason: "memory_revoked", artifact_id: null, withdrawn: true });
    expect(vault.ids()).toEqual([task.task_id]);
    expect(JSON.stringify(store.documents())).not.toContain(ART_CANARY);
  });

  it("switching person or going idle does NOT abort a running protected task", async () => {
    const { h, store, runner, exec } = setup();
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    exec.hold();
    const { out } = await delegate(h, "幫我規劃一週晚餐");
    await selectProfile(h, null);
    h.service.suspend("idle");
    h.service.suspendAll();
    exec.release!();
    await runner.idle();
    expect(store.get(out!.task.task_id)).toMatchObject({ status: "succeeded", memory: true });
    expect(store.get(out!.task.task_id)!.withdrawn).toBeUndefined();
  });

  it("an unrelated forget does not touch other results", async () => {
    const { h, store, task } = await seededSucceeded();
    await h.turn("記住，我喜歡爵士樂");
    const token = await manage(h);
    const list = await h.call({ op: "list", token }) as unknown as { facts: { id: string; revision: number; text: string }[] };
    const jazz = list.facts.find(f => f.text.includes("爵士"))!;
    await h.call({ op: "forget", id: jazz.id, revision: jazz.revision, token });
    expect(store.get(task.task_id)!.withdrawn).toBeUndefined();
    expect(store.get(task.task_id)!.artifact_id).not.toBeNull();
  });

  it("redo re-retrieves current memory (new deps) and never reuses the withdrawn ones", async () => {
    const { h, store, runner, exec, task } = await seededSucceeded();
    const f = await factId(h);
    await h.call({ op: "edit", id: f.id, revision: f.revision, value: "不吃蔥", token: f.token });
    expect(store.get(task.task_id)!.withdrawn).toBe(true);
    const redone = await h.service.redoProtected({ title: store.get(task.task_id)!.title, requestId: req(), retryOf: task.task_id });
    await runner.idle();
    expect(redone!.task.retry_of).toBe(task.task_id);
    expect(exec.inputs.at(-1)!.facts!.map(x => x.text)).toEqual(["不吃蔥"]);
    const results = snapshotOf(h).results;
    const fresh = results.find(r => r.taskId === redone!.task.task_id)!;
    expect(fresh.state).toBe("active");
    expect(fresh.deps[0]!.revision).toBe(snapshotOf(h).facts[0]!.revision);
  });

  it("restart: a withdrawn result whose file survived a crash is shredded when memory opens; orphan task files are cleaned", async () => {
    const memoryKey = randomBytes(32), taskKey = randomBytes(32);
    const first = await (async () => {
      const env = setup({ memoryKey, taskKey });
      await enable(env.h, "George");
      await env.h.turn("記住，我不吃香菜");
      const { out } = await delegate(env.h, "幫我規劃一週晚餐");
      await env.runner.idle();
      return { env, task: env.store.get(out!.task.task_id)! };
    })();
    // 模擬「快照已寫 withdrawn、成果檔還沒刪就當機」：先擋住傳播，再撤銷。
    const withdrawnIds: string[] = [];
    (first.env.h.service as unknown as { options: { onResultsWithdrawn: (ids: string[]) => void } }).options.onResultsWithdrawn = (ids) => withdrawnIds.push(...ids);
    const f = await factId(first.env.h);
    await first.env.h.call({ op: "forget", id: f.id, revision: f.revision, token: f.token });
    expect(withdrawnIds).toEqual([first.task.task_id]);
    expect(first.env.vault.ids()).toContain(first.task.artifact_id);
    await first.env.h.close();
    first.env.vault.close();
    // 重新啟動：任務端先載入（成果檔還在），記憶開啟時再把撤回的成果刪掉。
    const second = setup({ memoryDir: first.env.memoryDir, memoryKey, dataDir: first.env.dataDir, taskKey });
    expect(second.store.getArtifact(first.task.artifact_id!)).toBeDefined();
    await second.h.call({ op: "list", manage: true }, { userInitiated: true });
    expect(second.store.get(first.task.task_id)).toMatchObject({ withdrawn: true, artifact_id: null });
    expect(second.vault.ids()).toEqual([first.task.task_id]);
  });

  it("concurrency: a delegation and a forget racing through the writer mutex never leave an active result on a forgotten fact", async () => {
    const { h, store, runner } = setup();
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const t = await memoryTurn(h, "幫我規劃一週晚餐");
    const f = await factId(h);
    const [del] = await Promise.all([
      h.service.withChat({ nonce: t.nonce, requestId: t.id, lastUser: t.text, target: CLAUDE }, async (ctx) => ctx.delegate?.()),
      h.call({ op: "forget", id: f.id, revision: f.revision, token: f.token }),
    ]);
    await runner.idle();
    const snap = snapshotOf(h);
    expect(snap.facts).toEqual([]);
    expect(snap.results.filter(r => r.state === "active")).toEqual([]);
    // 兩種順序都只有一種合法結果：交辦先（帶了記憶）→ 任務被撤回或停止、沒有成果；忘記先 → 交辦沒有帶記憶。
    expect(del).not.toBeNull();
    const task = store.get(del!.task.task_id)!;
    if (del!.used > 0) {
      expect(task.memory).toBe(true);
      expect(task.withdrawn === true || task.cancel_reason === "memory_revoked").toBe(true);
      expect(task.artifact_id).toBeNull();
    } else {
      expect(task.memory).toBeUndefined();
      expect(task.status).toBe("succeeded");
    }
    expect(store.documents().filter(d => d.task.memory === true && d.artifact !== null)).toEqual([]);
  });

  it("review M4b: when the dependency index overflows, the dropped active result is withdrawn instead of silently losing its index", async () => {
    const { h, store, runner } = setup({ resultLimit: 1 });
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const first = (await delegate(h, "幫我規劃一週晚餐")).out!;
    await runner.idle();
    const second = (await delegate(h, "幫我規劃週末晚餐")).out!;
    await runner.idle();
    expect(store.get(first.task.task_id)).toMatchObject({ withdrawn: true, artifact_id: null });
    expect(store.get(second.task.task_id)!.withdrawn).toBeUndefined();
    expect(snapshotOf(h).results.map(r => r.taskId)).toEqual([second.task.task_id]);
  });

  it("review minor 3: a dependency that expires (今天有效) stops the running task without waiting for another memory change", async () => {
    const { h, store, runner, exec } = setup();
    await enable(h, "George");
    await h.turn("記住今天不要放香菜");
    exec.hold();
    const { out } = await delegate(h, "幫我規劃晚餐，不要放香菜");
    expect(out!.used).toBe(1);
    h.clock.now += 26 * 3600_000;
    (h.service as unknown as { checkIdle(): void }).checkIdle();
    await (h.service as unknown as { queue: Promise<unknown> }).queue;
    exec.release!();
    await runner.idle();
    expect(store.get(out!.task.task_id)).toMatchObject({ status: "cancelled", cancel_reason: "memory_revoked" });
    expect(snapshotOf(h).facts).toEqual([]);
  });

  it("review minor 4: if the engine's account changed while queued, the task runs without memory", async () => {
    const { h, runner, exec } = setup();
    runner.setTargetCheck(() => false);
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const { out } = await delegate(h, "幫我規劃一週晚餐");
    await runner.idle();
    expect(out!.used).toBe(1);
    expect(exec.inputs[0]!.facts).toBeUndefined();
  });

  it("withdrawals(): pure rule table", () => {
    const base = { settings: { enabled: true, setupAt: "2026-10-30T00:00:00Z", suggestions: false as const }, profiles: [{ id: "profile_aaaaaaaaaaaaaaaa", name: "甲", createdAt: "2026-10-30T00:00:00Z", facePersonId: null, minor: false }],
      facts: [{ id: "mem_aaaaaaaaaaaaaaaa", profileId: "profile_aaaaaaaaaaaaaaaa", revision: 3 } as never], consents: [{ profileId: "profile_aaaaaaaaaaaaaaaa", provider: "claude", account: "a", allowed: true }], tombstones: [],
      results: [{ id: "res_aaaaaaaaaaaaaaaa", taskId: "task_x", subject: "profile_aaaaaaaaaaaaaaaa", deps: [{ factId: "mem_aaaaaaaaaaaaaaaa", revision: 3 }], target: { provider: "claude", account: "a" }, createdAt: "2026-10-30T00:00:00Z", state: "active" as const }] };
    expect(withdrawals(base, base).size).toBe(0);
    expect(withdrawals(base, { ...base, settings: { ...base.settings, enabled: false } }).size).toBe(1);
    expect(withdrawals(base, { ...base, facts: [] }).size).toBe(1);
    expect(withdrawals(base, { ...base, facts: [{ ...(base.facts[0] as object), revision: 4 } as never] }).size).toBe(1);
    expect(withdrawals(base, { ...base, consents: [] }).size).toBe(1);
    expect(withdrawals(base, { ...base, profiles: [] }).size).toBe(1);
    // 同意給了別的帳號不影響
    expect(withdrawals(base, { ...base, consents: [...base.consents, { profileId: null, provider: "chatgpt", account: "b", allowed: false }] }).size).toBe(0);
  });
});

describe("MEM-4a log and file canary", () => {
  it.skipIf(!realLockAvailable)("logs carry counts only; nothing under the data or memory dirs holds the sentence, memory or result in plaintext", async () => {
    const env = setup();
    const lines: string[] = [];
    (env.h.service as unknown as { log: (l: string) => void }).log = (l) => lines.push(l);
    await enable(env.h, "George");
    await env.h.turn("記住，我不吃香菜CANARYMEM");
    const { out } = await delegate(env.h, "幫我規劃一週晚餐CANARYTITLE");
    await env.runner.idle();
    expect(out!.used).toBe(1);
    const all = (dir: string): string => readdirSync(dir).map(n => { const p = join(dir, n); return lstatSync(p).isDirectory() ? all(p) : readFileSync(p).toString("utf8"); }).join("");
    for (const dir of [env.dataDir, env.memoryDir]) {
      const bytes = all(dir);
      expect(bytes).not.toContain("CANARYMEM");
      expect(bytes).not.toContain("CANARYTITLE");
      expect(bytes).not.toContain(ART_CANARY);
    }
    const log = lines.join("\n");
    expect(log).toContain("受保護交辦（帶 1 筆");
    expect(log).not.toContain("CANARY");
    expect(log).not.toContain("香菜");
  });

  it("MemoryService without a task port never offers protected delegation", () => {
    const service = new MemoryService({ openStore: async () => { throw new Error("no"); }, available: () => false, targets: () => ({ current: null, all: [] }), confirm: async () => false });
    expect((service as unknown as { options: { tasks?: unknown } }).options.tasks).toBeUndefined();
    void service.shutdown();
  });
});
