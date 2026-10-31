import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TASK_OPS as DESKTOP_OPS, deleteConfirmed, deleteTaskDialog, validateConfirmDeleteRequest, validateTasksRequest } from "../desktop/tasks-ipc.mjs";
import { localizeDialog, setNativeLocale, t as nativeT } from "../desktop/localization.mjs";
import { TASK_OPS } from "../shared/protected-tasks.ts";
import { createTaskIpc } from "../server/task-ipc.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { TaskRunner, type ExecutionResult, type Executor, type Reporter } from "../server/runner.ts";
import { SealedVault } from "../server/sealed-vault.ts";
import { TaskStore } from "../server/store.ts";
import { BACKUP_PREFIX } from "../server/task-migration.ts";
import { mergeLiveTask, ProtectedTasks, shellView, vaultNotice, WITHDRAWN_TEXT } from "../src/protected-tasks.ts";
import type { Task } from "../shared/types.ts";
import type { TasksResponse } from "../shared/protected-tasks.ts";
import { CLAUDE, enable, fakeBox, harness, req } from "./fixtures/memory-service.ts";
import { realLockAvailable, testLockProvider } from "./fixtures/memory-lock.ts";

// MEM-4a：加密任務的 IPC（desktop/tasks-ipc.mjs 的形狀過濾、server/task-ipc.ts 的核心處理、src/protected-tasks.ts 的畫面接線）。

const CANARY = "CANARY_IPC_TAPIR_6620";
const dirs: string[] = [], vaults: SealedVault[] = [];
afterEach(() => {
  for (const v of vaults.splice(0)) v.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("desktop/tasks-ipc.mjs shape filter", () => {
  it("has the same op list as the shared contract", () => {
    expect([...DESKTOP_OPS]).toEqual([...TASK_OPS]);
  });

  it("keeps only allowed fields and rejects bad shapes", () => {
    const id = `task_${randomUUID()}`;
    expect(validateTasksRequest({ op: "list", extra: 1 })).toEqual({ ok: true, request: { op: "list" } });
    expect(validateTasksRequest({ op: "get", task_id: id, title: "x" })).toEqual({ ok: true, request: { op: "get", task_id: id } });
    expect(validateTasksRequest({ op: "get", task_id: "../etc" }).ok).toBe(false);
    expect(validateTasksRequest({ op: "redo", task_id: id }).ok).toBe(false);
    expect(validateTasksRequest({ op: "redo", task_id: id, request_id: "req_fixture0001", title: "改寫" })).toEqual({ ok: true, request: { op: "redo", task_id: id, request_id: "req_fixture0001" } });
    expect(validateTasksRequest({ op: "search", query: { q: "晚餐", status: "succeeded", from: "2026-10-01", limit: 20, evil: true } })).toEqual({ ok: true, request: { op: "search", query: { q: "晚餐", status: "succeeded", from: "2026-10-01", limit: 20 } } });
    expect(validateTasksRequest({ op: "search", query: { status: "nope" } }).ok).toBe(false);
    expect(validateTasksRequest({ op: "delete_backups", confirm: true })).toEqual({ ok: true, request: { op: "delete_backups" } });
    expect(validateTasksRequest({ op: "write" }).ok).toBe(false);
    expect(validateTasksRequest(null).ok).toBe(false);
  });

  it("main.mjs checks the trusted sender and filters before the core; preload only invokes nous:tasks", () => {
    const main = readFileSync(join(import.meta.dirname, "../desktop/main.mjs"), "utf8");
    const handler = main.slice(main.indexOf('ipcMain.handle("nous:tasks"'));
    expect(handler).toMatch(/checkTrustedSender\(event, win, core\.url\)/);
    expect(handler).toMatch(/validateTasksRequest\(request\)/);
    expect(main).toMatch(/tasks: \{ secretBox, confirmDeleteBackups, excludeFromBackup: excludeFromTimeMachine, onPlaintextDropped: notifyPlaintextDropped \}/);
    expect(main).toMatch(/buttons: \["刪除明文備份", "取消"\], defaultId: 1, cancelId: 1/);
    const preload = readFileSync(join(import.meta.dirname, "../desktop/preload.cjs"), "utf8");
    const invoke = vi.fn();
    let exposed: Record<string, (r: unknown) => unknown> = {};
    new Function("require", "process", preload)(() => ({ contextBridge: { exposeInMainWorld: (_k: string, api: typeof exposed) => { exposed = api; } }, ipcRenderer: { invoke, send: vi.fn(), sendSync: vi.fn(() => "zh-TW"), on: vi.fn(), removeListener: vi.fn() } }), { argv: [] });
    exposed.tasks!({ op: "list" });
    expect(invoke).toHaveBeenCalledWith("nous:tasks", { op: "list" });
    const build = readFileSync(join(import.meta.dirname, "../desktop/scripts/build.mjs"), "utf8");
    expect(build).toContain('cpSync(join(desktop, "tasks-ipc.mjs"), join(out, "tasks-ipc.mjs"));');
  });
});

describe("F4 (HIST-1 Mac): the delete confirmation is a localized native dialog from the main process", () => {
  afterEach(() => setNativeLocale("zh-TW"));

  it("filters the request to kind task and a display title; anything else is refused", () => {
    expect(validateConfirmDeleteRequest({ kind: "task", title: "准备晚饭", task_id: "x", evil: 1 })).toEqual({ ok: true, request: { kind: "task", title: "准备晚饭" } });
    expect(validateConfirmDeleteRequest({ kind: "task", title: "a\u0000b\nc" })).toEqual({ ok: true, request: { kind: "task", title: "a b c" } });
    expect((validateConfirmDeleteRequest({ kind: "task", title: "長".repeat(900) }) as { request: { title: string } }).request.title).toHaveLength(500);
    for (const bad of [null, [], { kind: "memory", title: "x" }, { kind: "task" }, { kind: "task", title: "" }, { kind: "task", title: 3 }, { kind: "task", title: "  \n\u202e\u2028 " }]) expect(validateConfirmDeleteRequest(bad).ok).toBe(false);
    // 審查 minor 5：雙向控制字元與行／段分隔字元換成空白，頭尾去空白，依碼位截斷（不切開 emoji）。
    expect(validateConfirmDeleteRequest({ kind: "task", title: " 晚餐\u202egpj.exe\u2066x\u2069\u200e\u200fy\u2028z\u2029w " })).toEqual({ ok: true, request: { kind: "task", title: "晚餐 gpj.exe x y z w" } });
    const emoji = (validateConfirmDeleteRequest({ kind: "task", title: "😀".repeat(600) }) as { request: { title: string } }).request.title;
    expect([...emoji]).toHaveLength(500);
    expect(emoji).toBe("😀".repeat(500));
  });

  it("buttons are 刪除／取消 in Chinese and Delete／Cancel in English; cancel is the default and the Esc button", () => {
    const zh = localizeDialog(deleteTaskDialog("准备晚饭", nativeT));
    expect(zh.buttons).toEqual(["刪除", "取消"]);
    expect(zh.message).toBe("要永久刪除「准备晚饭」這筆任務與它的成果嗎？");
    expect(zh.detail).toBe("刪除後無法復原。");
    expect([zh.defaultId, zh.cancelId]).toEqual([1, 1]);
    setNativeLocale("en");
    const en = localizeDialog(deleteTaskDialog("准备晚饭", nativeT));
    expect(en.buttons).toEqual(["Delete", "Cancel"]);
    expect(en.message).toBe("Permanently delete the task “准备晚饭” and its result?");
    expect(en.detail).toBe("This cannot be undone.");
    expect(JSON.stringify(en)).not.toMatch(/OK/);
  });

  it("only the Delete button confirms: Cancel, closing the dialog or a failure deletes nothing", () => {
    expect(deleteConfirmed({ response: 0 })).toBe(true);
    expect(deleteConfirmed({ response: 1 })).toBe(false);
    expect(deleteConfirmed(undefined)).toBe(false);
    expect(deleteConfirmed(null)).toBe(false);
  });

  it("main.mjs checks the trusted sender before showing it; preload sends only kind and title; main.ts no longer uses window.confirm in the App", () => {
    const main = readFileSync(join(import.meta.dirname, "../desktop/main.mjs"), "utf8");
    const handler = main.slice(main.indexOf('ipcMain.handle("nous:confirm-delete"'), main.indexOf('ipcMain.handle("nous:memory"'));
    expect(handler).toMatch(/checkTrustedSender\(event, win, core\.url\)\) return \{ confirmed: false \}/);
    expect(handler).toMatch(/validateConfirmDeleteRequest\(request\)/);
    expect(handler).toMatch(/showMessage\(deleteTaskDialog\(checked\.request\.title, t\), parent\)/);
    expect(handler).toMatch(/catch \{\s*return \{ confirmed: false \};/);
    const preload = readFileSync(join(import.meta.dirname, "../desktop/preload.cjs"), "utf8");
    const invoke = vi.fn();
    let exposed: Record<string, (r: unknown) => unknown> = {};
    new Function("require", "process", preload)(() => ({ contextBridge: { exposeInMainWorld: (_k: string, api: typeof exposed) => { exposed = api; } }, ipcRenderer: { invoke, send: vi.fn(), sendSync: vi.fn(() => "zh-TW"), on: vi.fn(), removeListener: vi.fn() } }), { argv: [] });
    exposed.confirmDelete!({ title: "准备晚饭", task_id: "task_x", extra: true });
    expect(invoke).toHaveBeenCalledWith("nous:confirm-delete", { kind: "task", title: "准备晚饭" });
    const page = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
    const wiring = page.slice(page.indexOf("const historyView = new HistoryView("), page.indexOf("requestId: userRequest,"));
    expect(wiring).toMatch(/window\.nousDesktop\?\.confirmDelete\s*\?\s*window\.nousDesktop\.confirmDelete\(\{ title: subject\.title \}\)\.then\(\(r\) => r\?\.confirmed === true, \(\) => false\)/);
  });

  it("every native confirmation in main.mjs has translated buttons (no English fallback like OK)", () => {
    const main = readFileSync(join(import.meta.dirname, "../desktop/main.mjs"), "utf8");
    const labels = [...main.matchAll(/buttons: \[([^\]]+)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
    expect(labels.length).toBeGreaterThanOrEqual(10);
    setNativeLocale("en");
    for (const label of [...labels, ...deleteTaskDialog("x").buttons]) {
      const en = nativeT(label);
      expect(en, label).not.toBe(label);
      expect(/\p{Script=Han}/u.test(en), label).toBe(false);
    }
  });
});

describe("MEM-4c review M1: preload drop notice", () => {
  it("passes only allow-listed reasons (no content) from tasks:plaintext-dropped to the page", () => {
    const preload = readFileSync(join(import.meta.dirname, "../desktop/preload.cjs"), "utf8");
    const handlers = new Map<string, (event: unknown, payload: unknown) => void>();
    let exposed: Record<string, unknown> = {};
    new Function("require", "process", preload)(() => ({ contextBridge: { exposeInMainWorld: (_k: string, api: typeof exposed) => { exposed = api; } }, ipcRenderer: { invoke: vi.fn(), send: vi.fn(), sendSync: vi.fn(() => "zh-TW"), on: (ch: string, l: (e: unknown, p: unknown) => void) => handlers.set(ch, l), removeListener: vi.fn() } }), { argv: [] });
    const got: unknown[] = [];
    (exposed.onTasksPlaintextDropped as (cb: (r: unknown) => void) => () => void)((r) => got.push(r));
    const fire = handlers.get("tasks:plaintext-dropped")!;
    for (const reason of ["os_lock", "suspend", "idle", "memory_off", "memory_closed", "quit"]) fire({}, { reason, title: "x" });
    fire({}, { reason: "evil" });
    fire({}, null);
    expect(got).toEqual(["os_lock", "suspend", "idle", "memory_off", "memory_closed", "quit"]);
  });
});

describe.skipIf(!realLockAvailable)("server/task-ipc.ts (trusted main window only)", () => {
  function setup(seedPlaintext = false) {
    const dataDir = mkdtempSync(join(tmpdir(), "nous-task-ipc-")); dirs.push(dataDir);
    if (seedPlaintext) {
      const id = `task_${randomUUID()}`;
      writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([{ schema_version: "proto-0.1", task_id: id, request_id: "req_fixture0001", title: CANARY, status: "failed", mode: "mock", model: null, plan_ready: false, steps: [], created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", finished_at: null, error: null, artifact_id: null, retry_of: null }]));
    }
    const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider });
    vaults.push(vault);
    const store = new TaskStore(dataDir, { vault });
    const runner = new TaskRunner(store, new MockExecutor(1));
    const confirm = vi.fn(async () => true);
    const memory = { redoProtected: vi.fn(async () => null) };
    const handle = createTaskIpc({ store, runner, memory, confirmDeleteBackups: confirm });
    return { dataDir, store, runner, handle, confirm, memory };
  }

  it("list/get return the real content; search finds the real text; redo uses the core-held sentence", async () => {
    const { store, runner, handle, memory } = setup();
    const created = runner.submit({ title: `寫${CANARY}報告`, request_id: "req_fixture0001", origin: "user_sentence" });
    const rewritten = runner.submit({ title: "模型改寫的標題", request_id: "req_fixture0009" });
    await runner.idle();
    const list = await handle({ op: "list" }) as Extract<TasksResponse, { op: "list" }>;
    expect(list.tasks[0]!.title).toContain(CANARY);
    const got = await handle({ op: "get", task_id: created.task_id }) as Extract<TasksResponse, { op: "get" }>;
    expect(got.artifact!.content).toBeTypeOf("string");
    const found = await handle({ op: "search", query: { q: CANARY } }) as Extract<TasksResponse, { op: "search" }>;
    expect(found.page.items.map(i => i.task_id)).toEqual([created.task_id]);
    expect(found.page.items[0]!.protected).toBe(true);
    const redo = await handle({ op: "redo", task_id: created.task_id, request_id: "req_fixture0002" }) as Extract<TasksResponse, { op: "redo" }>;
    expect(memory.redoProtected).toHaveBeenCalledWith(expect.objectContaining({ title: `寫${CANARY}報告`, retryOf: created.task_id }));
    expect(redo).toMatchObject({ ok: true, memory_used: 0, task: { retry_of: created.task_id, title: `寫${CANARY}報告`, origin: "user_sentence" } });
    await runner.idle();
    // 審查 M2：不是使用者原句的任務（模型改寫、交辦卡）重做時不經記憶。
    memory.redoProtected.mockClear();
    const plain = await handle({ op: "redo", task_id: rewritten.task_id, request_id: "req_fixture0003" }) as Extract<TasksResponse, { op: "redo" }>;
    expect(memory.redoProtected).not.toHaveBeenCalled();
    expect(plain.task.origin).toBeUndefined();
    await runner.idle();
    expect(await handle({ op: "get", task_id: `task_${randomUUID()}` })).toMatchObject({ ok: false, code: "not_found" });
    expect(await handle({ op: "nope" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(store.publicList().every(t => !JSON.stringify(t).includes(CANARY))).toBe(true);
  });

  it("F3 (HIST-1 Mac): a RUNNING protected task's real title and steps reach the trusted window over IPC; SSE, /api and model shells stay shells", async () => {
    const { store, handle } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const executor: Executor = {
      mode: "chatgpt",
      async run(input: { title: string }, reporter: Reporter): Promise<ExecutionResult> {
        reporter.planReady([{ title: `列出食材${CANARY}`, domain: "planning" }, { title: "寫出步驟", domain: "language" }], "fixture-model");
        reporter.stepStarted(0);
        await gate;
        reporter.stepDone(0);
        return { content: `成果：${input.title}`, assumptions: [], capability_gaps: [], status: "complete", model: "fixture-model" };
      },
    } as Executor;
    const runner = new TaskRunner(store, executor, 1);
    const sse: Task[] = [];
    store.subscribe((t) => sse.push(t));
    const created = runner.submit({ title: `准备晚饭${CANARY}`, request_id: "req_fixture0005" });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.publicGet(created.task_id)!.status).toBe("running");
    const got = await handle({ op: "get", task_id: created.task_id }) as Extract<TasksResponse, { op: "get" }>;
    expect(got.ok).toBe(true);
    expect(got.task.protected).toBeUndefined();
    expect(got.task.title).toBe(`准备晚饭${CANARY}`);
    expect(got.task.steps.map((s) => s.title)).toEqual(expect.arrayContaining([`列出食材${CANARY}`, "寫出步驟"]));
    expect(JSON.stringify(got.task)).not.toContain("受保護");
    const list = await handle({ op: "list" }) as Extract<TasksResponse, { op: "list" }>;
    expect(list.tasks.find((t) => t.task_id === created.task_id)!.title).toBe(`准备晚饭${CANARY}`);
    // 對外的頻道（SSE、/api/tasks、/api/history 的來源）仍只有外殼。
    expect(sse.length).toBeGreaterThan(0);
    expect(JSON.stringify(sse)).not.toContain(CANARY);
    expect(JSON.stringify(store.publicList())).not.toContain(CANARY);
    expect(JSON.stringify(store.publicDocuments())).not.toContain(CANARY);
    // 執行中的任務內容一直在核心記憶體（MEM-4c：丟棄只針對已結束的任務），鎖定後仍讀得到。
    store.dropPlaintext("os_lock");
    const again = await handle({ op: "get", task_id: created.task_id }) as Extract<TasksResponse, { op: "get" }>;
    expect(again.task.title).toBe(`准备晚饭${CANARY}`);
    release();
    await runner.idle();
  });

  it("the plaintext backup is kept until the user confirms deletion on screen (native confirm)", async () => {
    const { dataDir, handle, confirm } = setup(true);
    const status = await handle({ op: "status" }) as Extract<TasksResponse, { op: "status" }>;
    expect(status.vault).toMatchObject({ mode: "sealed", migration: { ok: true, tasks: 1, artifacts: 0 } });
    expect(status.vault.backups).toHaveLength(1);
    confirm.mockResolvedValueOnce(false);
    expect(await handle({ op: "delete_backups" })).toMatchObject({ ok: false, code: "cancelled" });
    expect(readdirSync(dataDir).filter(n => n.startsWith(BACKUP_PREFIX))).toHaveLength(1);
    const done = await handle({ op: "delete_backups" }) as Extract<TasksResponse, { op: "delete_backups" }>;
    expect(done).toMatchObject({ ok: true, deleted: 1, vault: { backups: [] } });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(readdirSync(dataDir).some(n => n.startsWith(BACKUP_PREFIX))).toBe(false);
    expect(existsSync(join(dataDir, "artifacts.json"))).toBe(false);
  });
});

describe.skipIf(!realLockAvailable)("review M2: redo refuses tasks whose content could not be read", () => {
  it("an unreadable task (shell only) cannot be redone over IPC or HTTP retry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nous-task-ipc-m2-")); dirs.push(dataDir);
    const key = randomBytes(32);
    let vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(key), lockProvider: testLockProvider });
    const first = new TaskStore(dataDir, { vault });
    const t = first.create({ title: CANARY, request_id: "req_fixture0001", mode: "mock", origin: "user_sentence" });
    first.update(t.task_id, (x) => { x.status = "failed"; });
    vault.close();
    const store = new TaskStore(dataDir, { vault: null, failure: "key_unavailable" });
    const runner = new TaskRunner(store, new MockExecutor(1));
    const memory = { redoProtected: vi.fn(async () => null) };
    const handle = createTaskIpc({ store, runner, memory, confirmDeleteBackups: async () => true });
    expect(await handle({ op: "redo", task_id: t.task_id, request_id: "req_fixture0002" })).toMatchObject({ ok: false, code: "conflict" });
    expect(runner.retry(t.task_id, "req_fixture0003")).toBeNull();
    expect(memory.redoProtected).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(1);
    vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(key), lockProvider: testLockProvider });
    vaults.push(vault);
    expect(new TaskStore(dataDir, { vault }).get(t.task_id)!.title).toBe(CANARY);
  });
});

describe("src/protected-tasks.ts (renderer)", () => {
  const shell: Task = { schema_version: "proto-0.1", task_id: `task_${randomUUID()}`, request_id: "req_fixture0001", title: "受保護的任務，請在 App 內查看", status: "running", mode: "claude", model: null, plan_ready: true,
    steps: [{ title: "受保護的步驟", status: "running", started_at: null, finished_at: null, output_chars: 12, domain: "language" }], created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:01Z", finished_at: null, error: null, artifact_id: null, retry_of: null, protected: true };

  it("without IPC only the fixed placeholder is shown; with IPC the real title overlays the newer shell state", async () => {
    expect(new ProtectedTasks(null, () => {}).display(shell).title).toBe(shellView(shell).title);
    const real = { ...shell, title: CANARY, steps: [{ ...shell.steps[0]!, title: `步驟${CANARY}`, output_chars: 1 }], protected: undefined };
    const bridge = vi.fn(async (req: { op: string }) => req.op === "list" ? { ok: true as const, op: "list" as const, tasks: [real] } : { ok: false as const, code: "unavailable" as const, message: "x" });
    const changed = vi.fn();
    const p = new ProtectedTasks(bridge as never, changed);
    await p.loadAll();
    const shown = p.display(shell);
    expect(shown.title).toBe(CANARY);
    expect(shown.steps[0]).toMatchObject({ title: `步驟${CANARY}`, output_chars: 12 });
    expect(changed).toHaveBeenCalled();
    expect(p.display({ ...shell, protected: undefined, title: "一般" }).title).toBe("一般");
  });

  it("F3: mergeLiveTask keeps IPC content over shell updates, takes newer state, and leaves shells and plain tasks alone", () => {
    const real = { ...shell, title: CANARY, steps: [{ ...shell.steps[0]!, title: `步驟${CANARY}` }], protected: undefined };
    const update = { ...shell, status: "running" as const, steps: [{ ...shell.steps[0]!, status: "done" as const, output_chars: 40 }, { ...shell.steps[0]!, title: "下一步（display）" }], updated_at: "2026-10-30T00:00:09Z" };
    const merged = mergeLiveTask(real, update);
    expect(merged.protected).toBeUndefined();
    expect(merged.title).toBe(CANARY);
    expect(merged.steps.map((s) => [s.title, s.status, s.output_chars])).toEqual([[`步驟${CANARY}`, "done", 40], ["下一步（display）", "running", 12]]);
    expect(merged.updated_at).toBe("2026-10-30T00:00:09Z");
    expect(shellView(merged).title).toBe(CANARY); // 詳細頁的 shellView 不再換回固定句
    expect(mergeLiveTask(shell, update)).toBe(update); // 詳細頁本身是外殼（範圍外）：照舊
    const plain = { ...update, protected: undefined, title: "一般" };
    expect(mergeLiveTask(real, plain)).toBe(plain);
    expect(mergeLiveTask(real, { ...update, task_id: "task_other" }).title).toBe(shell.title);
  });

  it("F3 review M1/M2: liveContent reports which displayed fields are real; merge keeps base for placeholders and drops content on withdrawal", async () => {
    const real = { ...shell, title: CANARY, steps: [{ ...shell.steps[0]!, title: `步驟${CANARY}` }], error: null, protected: undefined };
    const bridge = vi.fn(async () => ({ ok: true as const, op: "get" as const, task: real, artifact: null }));
    const p = new ProtectedTasks(bridge as never, () => {});
    expect(p.liveContent(shell)).toEqual({ title: false, steps: [false], error: true });
    p.want([shell]);
    await new Promise((r) => setTimeout(r, 0));
    const twoSteps = { ...shell, steps: [...shell.steps, { ...shell.steps[0]! }] };
    expect(p.liveContent(twoSteps)).toEqual({ title: true, steps: [true, false], error: true });
    expect(p.liveContent({ ...shell, error: "受保護的錯誤說明，請在 App 內查看" }).error).toBe(false); // 快取裡還沒有錯誤
    expect(p.liveContent({ ...shell, protected: undefined })).toEqual({ title: true, steps: [true], error: true });
    const failed = { ...shell, status: "failed" as const, error: "x" };
    expect(mergeLiveTask(real, shellView(failed), { title: false, steps: [false], error: false }).error).toBe(shellView(failed).error); // base 沒有錯誤時只能顯示固定句
    expect(mergeLiveTask({ ...real, error: "真實" }, shellView(failed), { title: false, steps: [false], error: false }).error).toBe("真實");
    expect(mergeLiveTask(real, { ...failed, error: "較新的真實" }, { title: true, steps: [true], error: true }).error).toBe("較新的真實");
    const withdrawn = shellView({ ...failed, withdrawn: true });
    expect(mergeLiveTask(real, withdrawn)).toBe(withdrawn);
    const revoked = shellView({ ...shell, status: "cancelling", cancel_reason: "memory_revoked" });
    expect(mergeLiveTask(real, revoked)).toBe(revoked);
  });

  it("vaultNotice tells the truth for each state", () => {
    expect(vaultNotice(null)).toBeNull();
    expect(vaultNotice({ mode: "sealed", failure: null, migration: null, backups: [], unsealed: 0, unreadable: 0 })).toBeNull();
    expect(vaultNotice({ mode: "sealed", failure: null, migration: { ok: true, tasks: 2, artifacts: 1, backup: "plaintext-backup-2026-10-30" }, backups: ["plaintext-backup-2026-10-30"], unsealed: 0, unreadable: 0 })).toMatchObject({ canDelete: true });
    expect(vaultNotice({ mode: "plain_fallback", failure: null, migration: { ok: false, step: "verify" }, backups: [], unsealed: 0, unreadable: 0 })!.text).toContain("解密驗證");
    expect(vaultNotice({ mode: "plain_fallback", failure: "key_unavailable", migration: null, backups: [], unsealed: 0, unreadable: 0 })!.canDelete).toBe(false);
    expect(vaultNotice({ mode: "sealed", failure: "key_unavailable", migration: null, backups: [], unsealed: 1, unreadable: 0 })!.text).toContain("只留在這次執行的記憶體");
    expect(WITHDRAWN_TEXT).toBe("這份成果用到已忘記的記憶，內容已移除");
    // 審查 minor 8：平常啟動不自動出現；只有這次搬遷過，或使用者從選單列打開。
    const quiet = { mode: "sealed" as const, failure: null, migration: null, backups: ["plaintext-backup-2026-10-30"], unsealed: 0, unreadable: 0 };
    expect(vaultNotice(quiet)).toBeNull();
    expect(vaultNotice(quiet, true)).toMatchObject({ canDelete: true });
    expect(vaultNotice({ ...quiet, backups: [] }, true)).toEqual({ text: "沒有任務的明文備份。", canDelete: false });
  });
});

describe.skipIf(!realLockAvailable)("review minor 7 (George D2): person scope for list/get/search; voice_tasks follows route consent", () => {
  it("other people's memory-derived tasks are shells unless the history was opened from the macOS menu (userInitiated + all)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nous-task-ipc-scope-")); dirs.push(dataDir);
    const memDir = mkdtempSync(join(tmpdir(), "nous-task-ipc-scope-mem-")); dirs.push(memDir);
    const vault = SealedVault.open({ dir: join(dataDir, "sealed"), secretBox: fakeBox(randomBytes(32)), lockProvider: testLockProvider });
    vaults.push(vault);
    const store = new TaskStore(dataDir, { vault });
    const executor = { mode: "claude" as const, run: async (_input: unknown, reporter: { planReady: (s: { title: string; domain: "language" }[], m: string) => void }) => { reporter.planReady([{ title: "s", domain: "language" }], "m"); return { content: CANARY, assumptions: [], capability_gaps: [], status: "complete" as const, model: "m" }; } };
    const runner = new TaskRunner(store, executor as never);
    const h = harness({ dir: memDir, key: randomBytes(32), release: { task: true }, tasks: { sealed: () => store.sealed, mode: () => runner.mode, target: () => CLAUDE, submit: (input) => runner.submitProtected(input) } });
    try {
      await enable(h, "George");
      await h.turn("記住，我不吃香菜");
      const id = req();
      const t = await h.turn("幫我規劃一週晚餐", id) as unknown as { chat: { text: string; memory_turn: string } };
      const mem = (await h.service.withChat({ nonce: t.chat.memory_turn, requestId: id, lastUser: t.chat.text, target: CLAUDE }, async (ctx) => ctx.delegate!()))!;
      const plain = runner.submit({ title: `一般${CANARY}`, request_id: req() });
      await runner.idle();
      const clock = { now: 1_000_000 };
      const handle = createTaskIpc({ store, runner, memory: h.service, confirmDeleteBackups: async () => true, now: () => clock.now });
      const titleOf = async (req: Record<string, unknown>, ctx?: { userInitiated?: boolean }) => {
        const res = await handle(req, ctx) as Extract<TasksResponse, { op: "list" }>;
        return Object.fromEntries(res.tasks.map(x => [x.task_id, x.title]));
      };
      // 本次人物是 George：自己的帶記憶任務看得到。
      expect((await titleOf({ op: "list" }))[mem.task.task_id]).toBe("幫我規劃一週晚餐");
      // 換成 Amy：George 的帶記憶任務只剩外殼；一般任務照樣看得到。
      await enable(h, "Amy");
      const asAmy = await titleOf({ op: "list" });
      expect(asAmy[mem.task.task_id]).toBe("受保護的任務，請在 App 內查看");
      expect(asAmy[plain.task_id]).toBe(`一般${CANARY}`);
      expect(await handle({ op: "get", task_id: mem.task.task_id })).toMatchObject({ ok: true, artifact: null, task: { protected: true } });
      const found = await handle({ op: "search", query: { q: "晚餐" } }) as Extract<TasksResponse, { op: "search" }>;
      expect(found.page.items.find(i => i.task_id === mem.task.task_id)?.snippet ?? null).toBeNull();
      // all 但沒有選單點擊：仍是外殼。
      expect((await titleOf({ op: "list", all: true }))[mem.task.task_id]).toBe("受保護的任務，請在 App 內查看");
      // 選單列點擊（主程序核對 10 秒時間窗後帶 userInitiated）：10 分鐘內帶 all 的請求看得到。
      expect((await titleOf({ op: "list", all: true }, { userInitiated: true }))[mem.task.task_id]).toBe("幫我規劃一週晚餐");
      expect(await handle({ op: "get", task_id: mem.task.task_id, all: true })).toMatchObject({ artifact: { content: CANARY } });
      expect((await titleOf({ op: "list" }))[mem.task.task_id]).toBe("受保護的任務，請在 App 內查看");
      clock.now += 11 * 60_000;
      expect((await titleOf({ op: "list", all: true }))[mem.task.task_id]).toBe("受保護的任務，請在 App 內查看");
      await titleOf({ op: "list", all: true }, { userInitiated: true });
      handle.closeSessions();
      expect((await titleOf({ op: "list", all: true }))[mem.task.task_id]).toBe("受保護的任務，請在 App 內查看");
      expect(await handle({ op: "redo", task_id: mem.task.task_id, request_id: req() })).toMatchObject({ ok: false, code: "conflict" });
      // voice_tasks：沒有 codex 同意（也沒有 live 目標）時全部外殼。
      const voice = await handle({ op: "voice_tasks", route: "live" }) as Extract<TasksResponse, { op: "voice_tasks" }>;
      expect(voice.tasks.every(x => x.protected === true)).toBe(true);
      expect(validateTasksRequest({ op: "voice_tasks", route: "other" }).ok).toBe(false);
      expect(validateTasksRequest({ op: "list", all: "yes" }).ok).toBe(false);
    } finally {
      await h.close();
    }
  });
});

describe("MEM-4b protected delegation card over IPC", () => {
  it("filters card ops to an opaque card ID (and a request ID for the click); extra fields are dropped", () => {
    const card = `dc_${"a".repeat(24)}`;
    expect(validateTasksRequest({ op: "card_title", card, title: "偽造的標題" })).toEqual({ ok: true, request: { op: "card_title", card } });
    expect(validateTasksRequest({ op: "card_delegate", card, request_id: "req_fixture01", title: "偽造的標題" })).toEqual({ ok: true, request: { op: "card_delegate", card, request_id: "req_fixture01" } });
    expect(validateTasksRequest({ op: "card_title", card: "dc_short" })).toMatchObject({ ok: false });
    expect(validateTasksRequest({ op: "card_delegate", card })).toMatchObject({ ok: false });
  });

  it("the page takes the card title only from IPC and clicks through IPC; the SSE card event has no title", () => {
    const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
    const block = main.slice(main.indexOf('case "delegate_card"'), main.indexOf('case "delegated"'));
    expect(block).toContain("protectedTasks.cardTitle(card)");
    expect(block).toContain("delegateCard(card)");
    expect(block).not.toContain("event.title");
    expect(main).toContain("protectedTasks.cardDelegate(card, requestId)");
    // 受保護交辦的任務完成時照即時語音的任務通知。
    expect(main.slice(main.indexOf('case "delegated"'))).toContain("realtimeTaskIds.add(task.task_id)");
  });
});
