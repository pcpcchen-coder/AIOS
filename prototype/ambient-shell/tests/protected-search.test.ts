import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetAllHistoryContent, historyContentCacheSize, parseHistoryQuery, searchHistory } from "../server/history.ts";
import type { MemoryStoreLike, MemorySecretBox } from "../server/memory/store.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { ProtectedIndex } from "../server/protected-index.ts";
import { TaskRunner, type ExecutionResult, type Executor, type Reporter } from "../server/runner.ts";
import { SealedVault } from "../server/sealed-vault.ts";
import { PLAINTEXT_IDLE_MS, RELOAD_FAILED, shellOf, TaskStore, tasksForTarget, TITLE_CACHE_MAX, TITLE_PEEK, WARM_MAX, type ProtectedSearchStats } from "../server/store.ts";
import { createTaskIpc, MEMORY_UPDATING } from "../server/task-ipc.ts";
import { historySearchPath, type HistoryPage, type HistoryQuery } from "../shared/history.ts";
import type { TasksResponse } from "../shared/protected-tasks.ts";
import type { ExecutorMode, Task } from "../shared/types.ts";
import type { Locale } from "../shared/i18n.mjs";
import { CLAUDE, enable, fakeBox, harness, manage, req, type Harness } from "./fixtures/memory-service.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";
import { corpusDoc, openSealed, rng, seedSealed } from "./fixtures/protected-corpus.ts";
import serverMessages from "../server/messages.en.json" with { type: "json" };
import pageMessages from "../src/messages.en.json" with { type: "json" };

// MEM-4c：受保護成果的明文生命週期（已結束任務的解密內容不一直留在核心記憶體）與 RAM 倒排索引。
// 真 AES-GCM 加密檔、真 rename／fsync；只有資料金鑰的包裝是假的（fakeBox）。全部任務與內容都是虛構的合成資料。

const CANARY = "canary犀牛蛋糕七七三一";
const dirs: string[] = [];
const vaults: SealedVault[] = [];
const harnesses: Harness[] = [];
let core: NousHandle | null = null;
afterEach(async () => {
  await core?.close();
  core = null;
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  forgetAllHistoryContent();
});

/** 核心記憶體裡（TaskStore 的內部表、倒排索引、標題快取）所有字串；用來確認 canary 已不在記憶體。 */
function residentText(store: TaskStore): string {
  const s = store as unknown as { tasks: Map<string, Task>; artifacts: Map<string, unknown>; titles: Map<string, Task>; index: { docs: unknown[] } | null };
  return JSON.stringify([[...s.tasks.values()], [...s.artifacts.values()], [...s.titles.values()], s.index?.docs ?? null]);
}

function seed(n: number, options: Parameters<typeof seedSealed>[1] = {}) {
  const seeded = seedSealed(n, options);
  dirs.push(seeded.dataDir);
  return seeded;
}

function open(dataDir: string, box: MemorySecretBox, sealing: Parameters<typeof openSealed>[2] = {}) {
  const opened = openSealed(dataDir, box, sealing);
  vaults.push(opened.vault);
  return opened;
}

const query = (q: string, extra: Partial<HistoryQuery> = {}) => parseHistoryQuery(new URLSearchParams(historySearchPath({ q, ...extra }).split("?")[1] ?? ""));
const stats = (): ProtectedSearchStats => ({ built: false, decrypted: 0, scored: 0, filtered: 0 });
const all = () => true;

/** 可以切換的金鑰：deny 時解不開（模擬解鎖後 Keychain 拒絕）。 */
function switchableBox(): MemorySecretBox & { deny: boolean } {
  const inner = fakeBox(randomBytes(32));
  const box = {
    deny: false,
    available: () => inner.available(),
    seal: (plain: string) => inner.seal(plain),
    open: (sealed: Buffer) => { if (box.deny) throw new Error("keychain denied"); return inner.open(sealed); },
  };
  return box;
}

class GateExecutor implements Executor {
  inputs: string[] = [];
  gate: Promise<void> | null = null;
  release: (() => void) | null = null;
  constructor(public mode: ExecutorMode = "claude") {}
  hold(): void { this.gate = new Promise((r) => { this.release = r; }); }
  async run(input: { title: string; mode: ExecutorMode; locale?: Locale }, reporter: Reporter): Promise<ExecutionResult> {
    this.inputs.push(input.title);
    reporter.planReady([{ title: `步驟：${input.title}`, domain: "language" }], "fixture-model");
    reporter.stepStarted(0);
    if (this.gate) await this.gate;
    reporter.stepDone(0);
    return { content: `成果：${input.title}`, assumptions: [], capability_gaps: [], status: "complete", model: "fixture-model" };
  }
}

describe.skipIf(!realLockAvailable)("MEM-4c plaintext lifecycle", () => {
  it("after a restart every finished protected task is a shell in RAM; access loads lazily; OS lock drops it again", () => {
    const { dataDir, box, docs } = seed(30, { extra: (i) => (i === 3 ? CANARY : ""), titleExtra: (i) => (i === 3 ? CANARY : "") });
    const { store } = open(dataDir, box);
    expect(store.residentPlaintext()).toEqual({ warm: 0, cold: 30, indexed: 0, titles: 0, indexBuilt: false });
    expect(residentText(store)).not.toContain(CANARY);
    const id = docs[3]!.task.task_id;
    const opened = store.open(id)!;
    expect(opened.task.title).toContain(CANARY);
    expect(opened.artifact!.content).toContain(CANARY);
    expect(store.residentPlaintext()).toMatchObject({ warm: 1, cold: 29 });
    expect(residentText(store)).toContain(CANARY);
    // 搜尋建立索引（折疊後的內容也是副本）。
    expect(store.searchProtected(query("犀牛蛋糕"), all).items.map((i) => i.task_id)).toEqual([id]);
    expect(store.residentPlaintext().indexBuilt).toBe(true);
    store.dropPlaintext("os_lock");
    expect(store.residentPlaintext()).toEqual({ warm: 0, cold: 30, indexed: 0, titles: 0, indexBuilt: false });
    expect(residentText(store)).not.toContain(CANARY);
    expect(historyContentCacheSize()).toBe(0);
    // 解鎖後要用時再解密（內容逐位元組相同）。
    expect(store.open(id)).toEqual({ task: docs[3]!.task, artifact: docs[3]!.artifact });
    expect(store.get(id)!.title).toContain(CANARY);
  });

  it("idle: content is dropped after PLAINTEXT_IDLE_MS without authorized access, and reloads afterwards", () => {
    const { dataDir, box, docs } = seed(10);
    const clock = { now: 1_000_000 };
    const { store } = open(dataDir, box, { clock: () => clock.now });
    store.open(docs[0]!.task.task_id);
    store.searchProtected(query("晚餐"), all);
    expect(store.residentPlaintext()).toMatchObject({ warm: 1, indexBuilt: true });
    clock.now += PLAINTEXT_IDLE_MS - 1;
    expect(store.dropIfIdle()).toBe(false);
    store.open(docs[1]!.task.task_id); // 經授權的存取重新計時
    clock.now += PLAINTEXT_IDLE_MS - 1;
    expect(store.dropIfIdle()).toBe(false);
    clock.now += 2;
    expect(store.dropIfIdle()).toBe(true);
    expect(store.residentPlaintext()).toEqual({ warm: 0, cold: 10, indexed: 0, titles: 0, indexBuilt: false });
    // 計時器還沒跑到、下一次存取時也會先丟棄再重建。
    const st = stats();
    store.searchProtected(query("晚餐"), all, st);
    expect(st.built).toBe(true);
    clock.now += PLAINTEXT_IDLE_MS + 1;
    const again = stats();
    store.searchProtected(query("晚餐"), all, again);
    expect(again.built).toBe(true);
    expect(PLAINTEXT_IDLE_MS).toBe(10 * 60_000);
  });

  it("at most WARM_MAX finished tasks stay decrypted (least recently used are dropped first)", () => {
    const { dataDir, box, docs } = seed(WARM_MAX + 5);
    const { store } = open(dataDir, box);
    for (const d of docs) store.open(d.task.task_id);
    expect(store.residentPlaintext().warm).toBe(WARM_MAX);
    expect(store.residentPlaintext().cold).toBe(5);
  });

  it("running and queued tasks keep their content through lock, idle and memory off; finished ones become warm, then drop", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nous-mem4c-run-")); dirs.push(dataDir);
    const clock = { now: 5_000_000 };
    const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider }); vaults.push(vault);
    const store = new TaskStore(dataDir, { vault, clock: () => clock.now });
    const exec = new GateExecutor();
    const runner = new TaskRunner(store, exec, 1);
    exec.hold();
    const running = runner.submit({ title: `跑${CANARY}`, request_id: req() });
    const queued = runner.submit({ title: `排${CANARY}`, request_id: req() });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.get(running.task_id)!.status).toBe("running");
    for (const reason of ["os_lock", "suspend", "memory_off"] as const) store.dropPlaintext(reason);
    clock.now += PLAINTEXT_IDLE_MS * 3;
    store.dropIfIdle();
    expect(store.residentPlaintext().cold).toBe(0);
    expect(store.get(running.task_id)!.title).toBe(`跑${CANARY}`);
    expect(store.get(queued.task_id)!.title).toBe(`排${CANARY}`);
    exec.release!();
    await runner.idle();
    expect(exec.inputs).toEqual([`跑${CANARY}`, `排${CANARY}`]);
    // 結束的任務先留在記憶體（warm）；但結束不算經授權的存取（審查 minor 2），閒置已過，open 會先丟棄再只讀回這一筆。
    expect(store.residentPlaintext()).toMatchObject({ warm: 2, cold: 0 });
    const done = store.open(running.task_id)!;
    expect(done.artifact!.content).toBe(`成果：跑${CANARY}`);
    expect(store.residentPlaintext()).toMatchObject({ warm: 1, cold: 1 });
    store.open(queued.task_id);
    store.dropPlaintext("os_lock");
    expect(store.residentPlaintext()).toMatchObject({ warm: 0, cold: 2 });
    expect(residentText(store)).not.toContain(CANARY);
    expect(store.open(queued.task_id)!.artifact!.content).toBe(`成果：排${CANARY}`);
  });

  it("memory off and memory close (shutdown) ask the task side to drop plaintext", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "nous-mem4c-memory-")); dirs.push(memoryDir);
    const { dataDir, box, docs } = seed(5);
    const { store } = open(dataDir, box);
    const h = harness({ dir: memoryDir, key: randomBytes(32), onPlaintextDrop: (reason) => store.dropPlaintext(reason), holdResults: (ids) => store.hold(ids) });
    harnesses.push(h);
    await enable(h, "George");
    store.open(docs[0]!.task.task_id);
    expect(store.residentPlaintext().warm).toBe(1);
    const token = await manage(h);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    expect((await h.call({ op: "setup", token, enabled: false, subject: { kind: "profile", profile: status.profiles[0]!.id }, allow: [] })).ok).toBe(true);
    expect(store.residentPlaintext()).toMatchObject({ warm: 0, indexBuilt: false });
    store.open(docs[1]!.task.task_id);
    store.searchProtected(query("晚餐"), all);
    expect(store.residentPlaintext()).toMatchObject({ warm: 1, indexBuilt: true });
    await h.close();
    expect(store.residentPlaintext()).toMatchObject({ warm: 0, indexBuilt: false });
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe.skipIf(!realLockAvailable)("MEM-4c wiring through startNous (what desktop/main.mjs calls)", () => {
  it("OS lock (dropPlaintext) and quit (close) drop decrypted content; the log has counts only", async () => {
    const root = mkdtempSync(join(tmpdir(), "nous-mem4c-core-")); dirs.push(root);
    const lines: string[] = [];
    const dropped: string[] = [];
    const port = await freePort();
    core = await startNous({
      envFile: null, dataDir: join(root, "data"), distDir: join(root, "no-dist"), fallbackPort: true, log: (l) => lines.push(l),
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(port) },
      tasks: { secretBox: fakeBox(randomBytes(32)), confirmDeleteBackups: async () => true, lockProvider: testLockProvider, onPlaintextDropped: (reason) => dropped.push(reason) },
    });
    const res = await fetch(`${core.url}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `查${CANARY}`, request_id: req() }) });
    expect(res.status).toBe(201);
    const created = await res.json() as Task;
    expect(created.protected).toBe(true);
    // 「停止任務」讓它馬上結束（模擬引擎每步要 1.8 秒）；已結束的任務內容留在記憶體（warm）。
    expect((await fetch(`${core.url}/api/tasks/${created.task_id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).ok).toBe(true);
    for (let i = 0; i < 200; i++) {
      const tasks = await (await fetch(`${core.url}/api/tasks`)).json() as Task[];
      if (tasks[0]?.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const got = await core.tasks!.handle({ op: "get", task_id: created.task_id }) as Extract<TasksResponse, { op: "get" }>;
    expect(got.task.title).toBe(`查${CANARY}`);
    core.tasks!.dropPlaintext("os_lock");
    expect(lines.some((l) => /已丟棄記憶體裡的解密內容（os_lock；任務 1/.test(l))).toBe(true);
    // 鎖定後再讀：從加密檔解密（內容相同）。
    const again = await core.tasks!.handle({ op: "get", task_id: created.task_id }) as Extract<TasksResponse, { op: "get" }>;
    expect(again.task.title).toBe(`查${CANARY}`);
    await core.close();
    core = null;
    expect(lines.some((l) => /已丟棄記憶體裡的解密內容（quit；任務 1/.test(l))).toBe(true);
    // 審查 M1：每次丟棄都通知主程序（再送給主視窗），只有原因。
    expect(dropped).toEqual(["os_lock", "quit"]);
    expect(lines.join("\n")).not.toContain(CANARY);
  }, 30_000);
});

describe.skipIf(!realLockAvailable)("MEM-4c RAM inverted index", () => {
  it("is built lazily on the first search, reused while warm, and rebuilt after a drop (unlock)", () => {
    const { dataDir, box } = seed(40);
    const { store } = open(dataDir, box);
    const first = stats();
    const a = store.searchProtected(query("晚餐 budget"), all, first);
    expect(first.built).toBe(true);
    expect(store.residentPlaintext().indexed).toBe(40);
    const second = stats();
    const b = store.searchProtected(query("晚餐 budget"), all, second);
    expect(second.built).toBe(false);
    expect(b).toEqual(a);
    store.dropPlaintext("os_lock");
    const third = stats();
    expect(store.searchProtected(query("晚餐 budget"), all, third)).toEqual(a);
    expect(third.built).toBe(true);
    // 索引裡只有折疊後的欄位，不留原文（大小寫已折疊）。
    const index = (store as unknown as { index: { docs: ({ fields: { folded: string }[] } | undefined)[] } }).index!;
    expect(index.docs.every((d) => !d || d.fields.every((f) => f.folded === f.folded.toLowerCase()))).toBe(true);
  });

  it("parity with the scan-based search (same items, ranking, snippets and paging), cold, warm and after a drop", async () => {
    const { dataDir, box, docs } = seed(160, { memory: (i) => i % 5 === 0, status: (i) => (i % 11 === 10 ? "cancelled" : i % 7 === 6 ? "failed" : "succeeded"), extra: (i) => (i % 40 === 0 ? "BUDGET 規劃 規划 晚餐規劃" : "") });
    const { store } = open(dataDir, box);
    // 一筆撤回、一筆刪除、一筆執行中（內容在記憶體、不在索引）。
    store.withdraw(docs[7]!.task.task_id);
    store.delete(docs[8]!.task.task_id);
    const exec = new GateExecutor();
    const runner = new TaskRunner(store, exec, 1);
    exec.hold();
    runner.submit({ title: "幫我規劃晚餐 budget（執行中）", request_id: req() });
    await new Promise((r) => setTimeout(r, 5));
    const inScope = (t: Pick<Task, "memory" | "task_id">) => t.memory !== true || t.task_id === docs[10]!.task.task_id;
    // 舊的逐筆掃描（MEM-4c 之前 task-ipc 的做法）：全部內容在記憶體、範圍外換外殼。
    const scan = (filters: ReturnType<typeof query>): HistoryPage => searchHistory([{ id: "tasks", protected: true, documents: () => store.documents().map((d) => (inScope(d.task) ? d : { task: shellOf(d.task), artifact: null })) }], filters);
    const queries: [string, Partial<HistoryQuery>][] = [
      ["晚餐", {}], ["budget", {}], ["BUDGET", {}], ["晚餐 budget", {}], ["幫我規劃", {}], ["规划", {}], ["餐", {}], ["晚餐規劃", {}],
      ["受保護的任務", {}], ["不存在的詞彙", {}], ["", {}], ["!!!", {}], ["a", {}], ["整理 假設", {}],
      ["晚餐", { status: "failed" }], ["budget", { mode: "claude" }], ["", { status: "cancelled" }], ["晚餐", { from: "2026-09-02", to: "2026-09-05" }],
      ["晚餐", { cursor: "20" }], ["幫我", { limit: 50, cursor: "50" }], ["", { cursor: "140" }],
    ];
    for (const phase of ["cold", "warm", "after drop"]) {
      if (phase === "after drop") store.dropPlaintext("os_lock");
      for (const [q, extra] of queries) {
        const filters = query(q, extra);
        const expected = scan(filters);
        const actual = store.searchProtected(filters, inScope);
        expect(actual, `${phase} ${q} ${JSON.stringify(extra)}`).toEqual(expected);
      }
    }
    exec.release!();
    await runner.idle();
  });

  it("delete and withdraw remove entries in the same synchronous step: a search that started before never returns them", async () => {
    const { dataDir, box, docs } = seed(20, { extra: (i) => (i === 4 || i === 5 ? CANARY : "") });
    const { store } = open(dataDir, box);
    const runner = new TaskRunner(store, new MockExecutor(1));
    let releaseScope: (() => void) | null = null;
    const memory = {
      redoProtected: vi.fn(async () => null),
      // 範圍判斷卡住，模擬搜尋已開始（await 中），這時撤回與刪除插進來。
      taskScope: async () => { await new Promise<void>((r) => { releaseScope = r; }); return () => true; },
    };
    const handle = createTaskIpc({ store, runner, memory, confirmDeleteBackups: async () => true });
    const before = store.searchProtected(query("犀牛蛋糕"), all);
    expect(before.items.map((i) => i.task_id).sort()).toEqual([docs[4]!.task.task_id, docs[5]!.task.task_id].sort());
    const pending = handle({ op: "search", query: { q: "犀牛蛋糕" } });
    await new Promise((r) => setTimeout(r, 0));
    store.withdraw(docs[4]!.task.task_id);
    store.delete(docs[5]!.task.task_id);
    releaseScope!();
    const page = (await pending as Extract<TasksResponse, { op: "search" }>).page;
    expect(page.total).toBe(0);
    expect(JSON.stringify(page)).not.toContain("犀牛");
    expect(residentText(store)).not.toContain(CANARY);
    // 撤回的任務仍以原句與固定句可以找到（和撤回前的規則相同），但成果內容不在。
    const kept = store.searchProtected(query(docs[4]!.task.title), all);
    expect(kept.items[0]).toMatchObject({ task_id: docs[4]!.task.task_id, artifact_id: null });
  });

  it("a withdrawal is hidden for the whole memory commit (hold), before the task side has propagated it", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "nous-mem4c-hold-")); dirs.push(memoryDir);
    const dataDir = mkdtempSync(join(tmpdir(), "nous-mem4c-hold-data-")); dirs.push(dataDir);
    const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider }); vaults.push(vault);
    const store = new TaskStore(dataDir, { vault });
    class FactsExecutor implements Executor {
      mode: ExecutorMode = "claude";
      async run(input: { title: string; facts?: readonly { text: string }[] }, reporter: Reporter): Promise<ExecutionResult> {
        reporter.planReady([{ title: "整理", domain: "language" }], "fixture-model");
        return { content: `${CANARY}：${input.facts?.map((f) => f.text).join("、") ?? ""}`, assumptions: [], capability_gaps: [], status: "complete", model: "fixture-model" };
      }
    }
    const runner = new TaskRunner(store, new FactsExecutor());
    let gate: Promise<void> | null = null;
    let open: (() => void) | null = null;
    let entered: (() => void) | null = null;
    const inCommit = new Promise<void>((r) => { entered = r; });
    const wrap = (s: MemoryStoreLike): MemoryStoreLike => new Proxy(s, {
      get(target, prop) {
        if (prop === "commit") return async (...args: Parameters<MemoryStoreLike["commit"]>) => { if (gate) { entered!(); await gate; } return target.commit(...args); };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const h = harness({
      dir: memoryDir, key: randomBytes(32), release: { task: true }, wrap,
      tasks: { sealed: () => store.sealed && store.vaultStatus().failure === null, mode: () => runner.mode, target: () => CLAUDE, submit: (input) => runner.submitProtected(input) },
      onResultsWithdrawn: (ids) => runner.revokeMemory(ids),
      holdResults: (ids) => store.hold(ids),
    });
    harnesses.push(h);
    await enable(h, "George");
    await h.turn("記住，我不吃香菜");
    const id = req();
    const turn = await h.turn("幫我規劃一週晚餐", id) as unknown as { chat: { text: string; memory_turn: string | null } };
    const { out } = await h.service.withChat({ nonce: turn.chat.memory_turn, requestId: id, lastUser: turn.chat.text, target: CLAUDE }, async (ctx) => ({ out: ctx.delegate ? await ctx.delegate() : null }));
    await runner.idle();
    const taskId = out!.task.task_id;
    const handle = createTaskIpc({ store, runner, memory: { redoProtected: async () => null, taskScope: (full) => h.service.taskScope(full) }, confirmDeleteBackups: async () => true });
    const search = async () => (await handle({ op: "search", query: { q: "犀牛蛋糕" } }) as Extract<TasksResponse, { op: "search" }>).page;
    expect((await search()).items.map((i) => i.task_id)).toEqual([taskId]);
    // 忘記那筆記憶：提交卡在寫快照的中間。
    const token = await manage(h);
    const list = await h.call({ op: "list", token }) as unknown as { facts: { id: string; revision: number }[] };
    gate = new Promise((r) => { open = r; });
    const forgetting = h.call({ op: "forget", id: list.facts[0]!.id, revision: list.facts[0]!.revision, token });
    await inCommit;
    expect(store.isHeld(taskId)).toBe(true);
    const during = await search();
    expect(during.total).toBe(0);
    const detail = await handle({ op: "get", task_id: taskId }) as Extract<TasksResponse, { op: "get" }>;
    expect(detail.artifact).toBeNull();
    expect(JSON.stringify([during, detail])).not.toContain("犀牛");
    expect(tasksForTarget(store, { taskTitleFilter: () => () => true }, null).find((t) => t.task_id === taskId)!.protected).toBe(true);
    open!();
    expect((await forgetting).ok).toBe(true);
    expect(store.isHeld(taskId)).toBe(false);
    expect((await search()).total).toBe(0);
    expect(store.get(taskId)).toMatchObject({ withdrawn: true, artifact_id: null });
  });

  it("person scope (D2): out-of-scope tasks are matched only as shells, never decrypted for the page, and get returns a shell", async () => {
    const { dataDir, box, docs } = seed(30, { memory: (i) => i % 3 === 0, extra: (i) => (i % 3 === 0 ? `${CANARY} 其他家人` : "") });
    const { store, vault } = open(dataDir, box);
    const inScope = (t: Pick<Task, "memory">) => t.memory !== true;
    const runner = new TaskRunner(store, new MockExecutor(1));
    const handle = createTaskIpc({ store, runner, memory: { redoProtected: async () => null, taskScope: async () => inScope }, confirmDeleteBackups: async () => true });
    const outOfScope = new Set(docs.filter((d) => d.task.memory).flatMap((d) => [d.task.task_id, d.artifact?.artifact_id].filter(Boolean) as string[]));
    await handle({ op: "search", query: { q: "晚餐" } }); // 建立索引（索引裡有全部內容，見文件）
    const read = vi.spyOn(vault, "read");
    const page = (await handle({ op: "search", query: { q: "犀牛蛋糕 其他家人" } }) as Extract<TasksResponse, { op: "search" }>).page;
    expect(page.total).toBe(0);
    const listed = (await handle({ op: "search", query: {} }) as Extract<TasksResponse, { op: "search" }>).page;
    expect(listed.total).toBe(30);
    expect(JSON.stringify(listed)).not.toContain("犀牛");
    const shells = listed.items.filter((i) => docs.find((d) => d.task.task_id === i.task_id)!.task.memory);
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.every((i) => i.title === "受保護的任務，請在 App 內查看" && i.snippet === null)).toBe(true);
    // 範圍外的任務只用外殼比對：搜尋固定句會找到它們（和 MEM-4a 的逐筆掃描相同）。
    expect((await handle({ op: "search", query: { q: "受保護的任務" } }) as Extract<TasksResponse, { op: "search" }>).page.total).toBe(10);
    const got = await handle({ op: "get", task_id: docs[0]!.task.task_id }) as Extract<TasksResponse, { op: "get" }>;
    expect(got).toMatchObject({ ok: true, artifact: null, task: { protected: true, title: "受保護的任務，請在 App 內查看" } });
    expect(read.mock.calls.map((c) => c[0]).filter((x) => outOfScope.has(x as string))).toEqual([]);
  });

  it("key unavailable while reloading: search, get and redo report it honestly (no empty page); files are untouched; recovers", async () => {
    const box = switchableBox();
    const { dataDir, docs } = seed(12, { box, extra: (i) => (i === 2 ? CANARY : "") });
    const { store } = open(dataDir, box);
    const runner = new TaskRunner(store, new MockExecutor(1));
    const handle = createTaskIpc({ store, runner, memory: null, confirmDeleteBackups: async () => true });
    const sealedDir = join(dataDir, "sealed");
    const snapshot = () => readdirSync(sealedDir).sort().map((n) => [n, readFileSync(join(sealedDir, n)).toString("base64")]);
    const before = snapshot();
    box.deny = true;
    expect(await handle({ op: "search", query: { q: "犀牛蛋糕" } })).toEqual({ ok: false, code: "unavailable", message: RELOAD_FAILED });
    expect(await handle({ op: "search", query: {} })).toEqual({ ok: false, code: "unavailable", message: RELOAD_FAILED });
    expect(await handle({ op: "get", task_id: docs[2]!.task.task_id })).toEqual({ ok: false, code: "unavailable", message: RELOAD_FAILED });
    expect(await handle({ op: "redo", task_id: docs[2]!.task.task_id, request_id: req() })).toEqual({ ok: false, code: "unavailable", message: RELOAD_FAILED });
    expect(runner.retry(docs[2]!.task.task_id, req(), { redo: true })).toBeNull();
    // 清單照實給外殼（不假裝有內容），模型清單也只有外殼。
    const list = await handle({ op: "list" }) as Extract<TasksResponse, { op: "list" }>;
    expect(list.tasks.every((t) => t.protected === true)).toBe(true);
    expect(store.residentPlaintext()).toMatchObject({ indexBuilt: false, warm: 0 });
    expect(snapshot()).toEqual(before);
    // 金鑰回來：照常。
    box.deny = false;
    const page = await handle({ op: "search", query: { q: "犀牛蛋糕" } }) as Extract<TasksResponse, { op: "search" }>;
    expect(page.page.items.map((i) => i.task_id)).toEqual([docs[2]!.task.task_id]);
    expect(await handle({ op: "get", task_id: docs[2]!.task.task_id })).toMatchObject({ ok: true, task: { title: docs[2]!.task.title } });
    // 頁面與核心的翻譯表都有這句（頁面依 t(message) 顯示「無法搜尋成果紀錄：…」）。
    expect((serverMessages as Record<string, string>)[RELOAD_FAILED]).toMatch(/could not be decrypted/i);
    expect((pageMessages as Record<string, string>)[RELOAD_FAILED]).toBe((serverMessages as Record<string, string>)[RELOAD_FAILED]);
  });

  it("model prompts: only the first TITLE_PEEK cold tasks are decrypted (task files only), cached in a small LRU, dropped with the rest", () => {
    const { dataDir, box, docs } = seed(30);
    const { store, vault } = open(dataDir, box);
    const read = vi.spyOn(vault, "read");
    const memory = { taskTitleFilter: () => (t: Pick<Task, "memory">) => t.memory !== true };
    const list = tasksForTarget(store, memory, null);
    const newest = [...docs].sort((a, b) => b.task.created_at.localeCompare(a.task.created_at)).slice(0, TITLE_PEEK).map((d) => d.task.task_id);
    for (const t of list) {
      const real = docs.find((d) => d.task.task_id === t.task_id)!.task;
      if (newest.includes(t.task_id)) expect(t.title).toBe(real.title);
      else expect(t.title).toBe("受保護的任務，請在 App 內查看");
    }
    expect(read.mock.calls.every((c) => String(c[0]).startsWith("task_"))).toBe(true);
    expect(read).toHaveBeenCalledTimes(TITLE_PEEK);
    tasksForTarget(store, memory, null);
    expect(read).toHaveBeenCalledTimes(TITLE_PEEK); // 快取命中
    expect(store.residentPlaintext().titles).toBe(TITLE_PEEK);
    expect(TITLE_CACHE_MAX).toBeGreaterThanOrEqual(TITLE_PEEK);
    store.dropPlaintext("os_lock");
    expect(store.residentPlaintext().titles).toBe(0);
  });

  it("canary: building the index, searching and reading never write plaintext to disk", async () => {
    const { dataDir, box, docs } = seed(25, { extra: (i) => (i % 5 === 0 ? CANARY : ""), titleExtra: (i) => (i === 1 ? CANARY : "") });
    const lines: string[] = [];
    const { store } = open(dataDir, box, { log: (l) => lines.push(l) });
    const runner = new TaskRunner(store, new MockExecutor(1));
    const handle = createTaskIpc({ store, runner, memory: null, confirmDeleteBackups: async () => true, log: (l) => lines.push(l) });
    await handle({ op: "search", query: { q: "犀牛蛋糕" } });
    await handle({ op: "search", query: {} });
    await handle({ op: "get", task_id: docs[0]!.task.task_id });
    await handle({ op: "list" });
    store.withdraw(docs[5]!.task.task_id);
    store.dropPlaintext("os_lock");
    await handle({ op: "search", query: { q: "犀牛蛋糕" } });
    const files: string[] = [];
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(dataDir);
    for (const f of files) {
      const raw = readFileSync(f);
      expect(raw.includes(Buffer.from("犀牛蛋糕")), f).toBe(false);
      expect(raw.includes(Buffer.from("canary")), f).toBe(false);
    }
    expect(lines.join("\n")).not.toMatch(/犀牛|canary/);
    // 搜尋的 log 只有筆數與耗時（Mac gate 量延遲用）。
    expect(lines.filter((l) => l.startsWith("tasks: 受保護搜尋（建立索引，解密 "))).toHaveLength(2);
  });

  it("perf (computed bounds): warm queries only score the candidates and decrypt at most the page; numbers for 500 and 2000 tasks", () => {
    const rows: string[] = [];
    for (const n of [500, 2000]) {
      const rare = (i: number) => i % 250 === 17;
      const { dataDir, box, docs } = seed(n, { extra: (i) => (rare(i) ? "獨角獸" : "") });
      // 稀有詞只在成果內容裡（失敗的任務沒有成果）。
      const hits = docs.filter((d, i) => rare(i) && d.artifact).length;
      const { store } = open(dataDir, box);
      const time = (fn: () => void, runs: number) => { const xs: number[] = []; for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); } xs.sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)]!; };
      // 舊做法：全部內容在記憶體、每次查詢複製所有任務再逐筆比對（CONTENT_CACHE 已暖）。
      const resident = docs.map((d) => ({ task: d.task, artifact: d.artifact }));
      const scan = (q: string) => searchHistory([{ id: "tasks", protected: true, documents: () => resident.map((d) => structuredClone(d)) }], query(q));
      scan("獨角獸");
      const scanRare = time(() => scan("獨角獸"), 5);
      const scanCommon = time(() => scan("晚餐 budget"), 5);
      // 較嚴的基準：同樣逐筆掃描，但不複製（只算比對本身）。
      const scanBare = (q: string) => searchHistory([{ id: "tasks", protected: true, documents: () => resident }], query(q));
      const bareRare = time(() => scanBare("獨角獸"), 5);
      const bareCommon = time(() => scanBare("晚餐 budget"), 5);
      const cold = stats();
      let t = performance.now();
      const first = store.searchProtected(query("獨角獸"), all, cold);
      const coldMs = performance.now() - t;
      const warm = stats();
      t = performance.now();
      const second = store.searchProtected(query("獨角獸"), all, warm);
      const warmOnce = performance.now() - t;
      const warmRare = time(() => store.searchProtected(query("獨角獸"), all), 5);
      const common = stats();
      store.searchProtected(query("晚餐 budget"), all, common);
      const warmCommon = time(() => store.searchProtected(query("晚餐 budget"), all), 5);
      // 計算出來的界線（不是牆鐘時間）。
      expect(first).toEqual(scan("獨角獸"));
      expect(first.total).toBe(hits);
      expect(cold.built).toBe(true);
      expect(cold.decrypted).toBe(n + docs.filter((d) => d.artifact).length + 2 * hits); // 建索引每筆解密一次，這一頁另外解密命中的任務與成果
      expect(warm.built).toBe(false);
      expect(warm.scored).toBe(hits); // 二字片段就是索引鍵：只精確比對真正的命中
      expect(warm.decrypted).toBeLessThanOrEqual(2 * Math.min(hits, 20));
      expect(second).toEqual(first);
      expect(common.decrypted).toBeLessThanOrEqual(2 * 20);
      expect(common.scored).toBeLessThanOrEqual(common.filtered);
      rows.push(`n=${n} hits=${hits} scan(rare)=${scanRare.toFixed(1)}ms scan(common)=${scanCommon.toFixed(1)}ms scanNoClone(rare)=${bareRare.toFixed(1)}ms scanNoClone(common)=${bareCommon.toFixed(1)}ms index cold=${coldMs.toFixed(1)}ms warm(first)=${warmOnce.toFixed(2)}ms warm(rare,median)=${warmRare.toFixed(2)}ms warm(common,median)=${warmCommon.toFixed(1)}ms scored(rare)=${warm.scored}/${n} scored(common)=${common.scored}/${n} decrypted(cold)=${cold.decrypted} decrypted(warm rare)=${warm.decrypted} decrypted(warm common)=${common.decrypted}`);
      store.dropPlaintext("quit");
    }
    console.log(`MEM-4c perf\n${rows.join("\n")}`);
  }, 180_000);
});

describe("MEM-4c ProtectedIndex (unit)", () => {
  it("candidates are a superset of substring matches (UTF-16 bigrams), removal is immediate, compaction keeps results", () => {
    const index = new ProtectedIndex();
    index.add("task_a", [{ field: "title", folded: "幫我規劃晚餐" }, { field: "content", folded: "budget planning 😀表" }]);
    index.add("task_b", [{ field: "content", folded: "airplane plan" }]);
    expect([...index.candidates(["規劃"]).keys()]).toEqual(["task_a"]);
    expect([...index.candidates(["plan"]).keys()].sort()).toEqual(["task_a", "task_b"]);
    expect([...index.candidates(["餐"]).keys()]).toEqual(["task_a"]);
    expect([...index.candidates(["😀"]).keys()]).toEqual(["task_a"]);
    expect([...index.candidates(["xyz"]).keys()]).toEqual([]);
    expect(index.candidates(["規劃", "plan"], 2).get("task_a")).toBe(2);
    expect(index.remove("task_a")).toBe(true);
    expect([...index.candidates(["規劃", "plan"]).keys()]).toEqual(["task_b"]);
    for (let i = 0; i < 600; i++) { index.add(`task_${i}`, [{ field: "title", folded: `第${i}號` }]); index.remove(`task_${i}`); }
    expect(index.size).toBe(1);
    expect([...index.candidates(["plan"]).keys()]).toEqual(["task_b"]);
  });
});

describe("MEM-4c browser build (no sealing) is unaffected", () => {
  it("plain TaskStore keeps content, dropPlaintext only clears the HIST-1 cache, task-ipc search uses the scan", async () => {
    const store = new TaskStore(null);
    const runner = new TaskRunner(store, new MockExecutor(1));
    const t = runner.submit({ title: `寫${CANARY}`, request_id: req() });
    await runner.idle();
    expect(store.dropPlaintext("os_lock")).toBe(0);
    expect(store.residentPlaintext()).toEqual({ warm: 0, cold: 0, indexed: 0, titles: 0, indexBuilt: false });
    expect(store.get(t.task_id)!.title).toBe(`寫${CANARY}`);
    const handle = createTaskIpc({ store, runner, memory: null, confirmDeleteBackups: async () => true });
    const page = (await handle({ op: "search", query: { q: "犀牛蛋糕" } }) as Extract<TasksResponse, { op: "search" }>).page;
    expect(page.items.map((i) => i.task_id)).toEqual([t.task_id]);
    expect(page.items[0]!.protected).toBe(false);
    expect(store.publicList()[0]!.title).toBe(`寫${CANARY}`);
  });

  it("the corpus fixture is deterministic", () => {
    expect(corpusDoc(3)).toEqual(corpusDoc(3));
  });
});

describe.skipIf(!realLockAvailable)("MEM-4c independent review regressions (reviewer's repro1.ts and findings)", () => {
  function freshStore(clock?: { now: number }, log?: (l: string) => void) {
    const dataDir = mkdtempSync(join(tmpdir(), "nous-mem4c-review-")); dirs.push(dataDir);
    const box = fakeBox(randomBytes(32));
    const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: box, lockProvider: testLockProvider }); vaults.push(vault);
    const store = new TaskStore(dataDir, { vault, ...(clock ? { clock: () => clock.now } : {}), ...(log ? { log } : {}) });
    return { dataDir, box, vault, store };
  }
  function failArtifacts(vault: SealedVault): { fail: boolean } {
    const flag = { fail: true };
    const write = vault.write.bind(vault);
    (vault as unknown as { write: SealedVault["write"] }).write = (id, value) => {
      if (flag.fail && id.startsWith("artifact_")) throw Object.assign(new Error("disk"), { code: "io" });
      return write(id, value);
    };
    return flag;
  }
  function finishWithArtifact(store: TaskStore, content: string): { taskId: string; artifactId: string } {
    const t = store.create({ title: `T${CANARY}`, request_id: req(), mode: "mock" });
    store.update(t.task_id, (x) => { x.status = "running"; });
    const a = store.addArtifact({ task_id: t.task_id, title: "T", content, mode: "mock", model: null, assumptions: [], capability_gaps: [], status: "complete" });
    return { taskId: t.task_id, artifactId: a.artifact_id, ...{ finish: () => store.update(t.task_id, (x) => { x.status = "succeeded"; x.finished_at = new Date().toISOString(); x.artifact_id = a.artifact_id; }) } } as never;
  }

  it("B1 (repro 1): artifact seal fails, task seal succeeds; the artifact is retried on the next update and survives a drop", () => {
    const { store, vault } = freshStore();
    const flag = failArtifacts(vault);
    const r = finishWithArtifact(store, `SECRET-ARTIFACT ${CANARY}`) as unknown as { taskId: string; artifactId: string; finish: () => void };
    expect(store.vaultStatus().unsealed).toBe(1);
    flag.fail = false;
    r.finish();
    expect(store.vaultStatus().unsealed).toBe(0);
    expect(vault.ids()).toContain(r.artifactId);
    store.dropPlaintext("os_lock");
    expect(store.open(r.taskId)!.artifact!.content).toBe(`SECRET-ARTIFACT ${CANARY}`);
  });

  it("B1: while the artifact still is not sealed, the task is never dropped; after a restart it is honestly missing (not a fake result)", () => {
    const { dataDir, box, store, vault } = freshStore();
    failArtifacts(vault);
    const r = finishWithArtifact(store, `SECRET-ARTIFACT ${CANARY}`) as unknown as { taskId: string; artifactId: string; finish: () => void };
    r.finish();
    expect(store.vaultStatus().unsealed).toBe(1); // 依任務計
    store.dropPlaintext("os_lock");
    expect(store.residentPlaintext()).toMatchObject({ cold: 0 });
    expect(store.open(r.taskId)!.artifact!.content).toBe(`SECRET-ARTIFACT ${CANARY}`);
    vault.close();
    const { store: again } = open(dataDir, box);
    const reopened = again.open(r.taskId)!;
    expect(reopened.task.artifact_id).toBe(r.artifactId);
    expect(reopened.artifact).toBeNull();
  });

  it("minor 1 (repro 2): a task cancelling because its memory was revoked is hidden from search, list, get and model titles", () => {
    const { store } = freshStore();
    const t = store.create({ title: "plan dinner", request_id: req(), mode: "mock", memory: true });
    store.update(t.task_id, (x) => { x.status = "running"; x.plan_ready = true; x.steps = [{ title: "use allergy peanut", status: "running", started_at: null, finished_at: null, output_chars: null, domain: null }]; });
    expect(store.searchProtected(query("peanut"), all).total).toBe(1);
    store.update(t.task_id, (x) => { x.status = "cancelling"; x.cancel_reason = "memory_revoked"; });
    expect(store.searchProtected(query("peanut"), all).total).toBe(0);
    expect(store.listFor(all).find((x) => x.task_id === t.task_id)!.protected).toBe(true);
    expect(store.open(t.task_id)).toMatchObject({ task: { protected: true }, artifact: null });
    expect(store.modelTasks(all)[0]!.title).toBe("受保護的任務，請在 App 內查看");
  });

  it("minor 2: status-only paths (cancel, revokeMemory, internal get) do not warm content or reset the idle timer", () => {
    const clock = { now: 7_000_000 };
    const { dataDir, box, docs } = seed(4);
    const { store, vault } = open(dataDir, box, { clock: () => clock.now });
    const runner = new TaskRunner(store, new MockExecutor(1));
    store.open(docs[0]!.task.task_id);
    clock.now += PLAINTEXT_IDLE_MS - 1;
    const read = vi.spyOn(vault, "read");
    const get = vi.spyOn(store, "get");
    expect(runner.cancel(docs[1]!.task.task_id)!.protected).toBe(true); // 已結束：回外殼，不解密
    runner.revokeMemory([`task_${randomUUID()}`]);
    expect(get).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    get.mockRestore();
    expect(store.get(docs[3]!.task.task_id)!.title).toBe(docs[3]!.task.title);
    expect(store.residentPlaintext().warm).toBe(1);
    clock.now += 2;
    expect(store.dropIfIdle()).toBe(true);
  });

  it("minor 3: redo while a memory commit holds the task says memory is updating (bilingual), not 'another family member'", async () => {
    const { dataDir, box, docs } = seed(2);
    const { store } = open(dataDir, box);
    const handle = createTaskIpc({ store, runner: new TaskRunner(store, new MockExecutor(1)), memory: null, confirmDeleteBackups: async () => true });
    const release = store.hold([docs[0]!.task.task_id]);
    expect(await handle({ op: "redo", task_id: docs[0]!.task.task_id, request_id: req() })).toEqual({ ok: false, code: "conflict", message: MEMORY_UPDATING });
    release();
    expect((serverMessages as Record<string, string>)[MEMORY_UPDATING]).toBe("Memory is updating; try again shortly");
    expect((pageMessages as Record<string, string>)[MEMORY_UPDATING]).toBe("Memory is updating; try again shortly");
  });

  it("minor 4: a corrupt artifact is decrypted and logged once per run, not on every search", () => {
    const { dataDir, box, docs } = seed(6);
    const victim = docs.find((d) => d.artifact)!;
    const file = join(dataDir, "sealed", `${victim.artifact!.artifact_id}.enc`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { ciphertext: string };
    raw.ciphertext = Buffer.from("broken").toString("base64");
    writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
    const lines: string[] = [];
    const { store, vault } = open(dataDir, box, { log: (l) => lines.push(l) });
    const read = vi.spyOn(vault, "read");
    for (let i = 0; i < 3; i++) { store.searchProtected(query("晚餐"), all); store.dropPlaintext("os_lock"); }
    expect(read.mock.calls.filter((c) => c[0] === victim.artifact!.artifact_id)).toHaveLength(0); // 啟動時已記下
    expect(lines.filter((l) => l.includes("成果檔讀不到")).length).toBeLessThanOrEqual(1);
    expect(store.open(victim.task.task_id)).toMatchObject({ task: { title: victim.task.title }, artifact: null });
  });

  it("minor 5: IPC list reads only task files through the title cache, and logs counts and time only", async () => {
    const { dataDir, box } = seed(10, { titleExtra: (i) => (i === 0 ? CANARY : "") });
    const lines: string[] = [];
    const { store, vault } = open(dataDir, box);
    const handle = createTaskIpc({ store, runner: new TaskRunner(store, new MockExecutor(1)), memory: null, confirmDeleteBackups: async () => true, log: (l) => lines.push(l) });
    const read = vi.spyOn(vault, "read");
    const first = await handle({ op: "list" }) as Extract<TasksResponse, { op: "list" }>;
    expect(first.tasks.some((t) => t.title.includes(CANARY))).toBe(true);
    expect(read.mock.calls.every((c) => String(c[0]).startsWith("task_"))).toBe(true);
    expect(read).toHaveBeenCalledTimes(10);
    await handle({ op: "list" });
    expect(read).toHaveBeenCalledTimes(10); // 第二次全部命中快取
    expect(lines.filter((l) => /^tasks: 受保護清單（10 筆，解密 (10|0)，\d+ ms）$/.test(l))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("犀牛");
  });

  it("nit: randomized parity with the scan (NFKC fullwidth, astral/emoji, digits, repeated terms)", () => {
    const { store } = freshStore();
    const r = rng(4242);
    const pieces = ["晚餐", "預算", "budget", "Budget", "ＢＵＤＧＥＴ", "２０２６", "2026", "😀", "𠀀字", "規划", "规劃", "A1", "x-ray", "café", "ｃａｆé", "表", "日本語", "plan", "PLAN"];
    const pick = () => pieces[Math.floor(r() * pieces.length)]!;
    for (let i = 0; i < 40; i++) {
      const t = store.create({ title: `${pick()}${pick()} ${pick()}`, request_id: req(), mode: (["claude", "chatgpt", "mock"] as const)[i % 3]! });
      store.update(t.task_id, (x) => { x.status = "running"; x.plan_ready = true; x.steps = [{ title: `${pick()} ${pick()}`, status: "done", started_at: null, finished_at: null, output_chars: null, domain: null }]; });
      if (i % 4 !== 3) {
        const a = store.addArtifact({ task_id: t.task_id, title: "x", content: Array.from({ length: 12 }, pick).join(r() < 0.5 ? " " : ""), mode: "mock", model: null, assumptions: [pick()], capability_gaps: [], status: "complete" });
        store.update(t.task_id, (x) => { x.status = "succeeded"; x.artifact_id = a.artifact_id; });
      } else store.update(t.task_id, (x) => { x.status = "failed"; x.error = "失敗"; });
    }
    store.dropPlaintext("os_lock");
    const scan = (filters: ReturnType<typeof query>) => searchHistory([{ id: "tasks", protected: true, documents: () => store.documents() }], filters);
    for (let k = 0; k < 120; k++) {
      const q = Array.from({ length: 1 + Math.floor(r() * 3) }, pick).join(r() < 0.5 ? " " : "") + (r() < 0.2 ? ` ${pick()} ${pick()}` : "");
      const filters = query(q, r() < 0.2 ? { limit: 5, cursor: String(Math.floor(r() * 3) * 5) } : {});
      expect(store.searchProtected(filters, all), q).toEqual(scan(filters));
    }
  });
});
