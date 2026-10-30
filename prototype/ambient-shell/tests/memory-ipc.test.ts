import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_OPS as IPC_OPS, validateMemoryRequest } from "../desktop/memory-ipc.mjs";
import { checkIdentitySender } from "../desktop/identity-ipc.mjs";
import { checkTrustedSender } from "../desktop/trusted-sender.mjs";
import { MEMORY_OPS } from "../shared/memory.ts";

// desktop/memory-ipc.mjs：發送者、op 白名單與形狀過濾（語意由核心驗證）。Electron 本身只做靜態檢查。

const P = "profile_0123456789abcdef";
const F = "mem_0123456789abcdef";
const C = "mc_0123456789abcdef01234567";
const T = "mm_" + "a".repeat(32);

describe("memory IPC filter", () => {
  it("has the same op whitelist as the core and shares the trusted-sender check with identity", () => {
    expect([...IPC_OPS]).toEqual([...MEMORY_OPS]);
    expect(checkIdentitySender).toBe(checkTrustedSender);
    const mainFrame = { url: "http://localhost:8787/" };
    const webContents = { mainFrame };
    const win = { webContents, isDestroyed: () => false };
    expect(checkTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, "http://localhost:8787")).toBe(true);
    expect(checkTrustedSender({ sender: webContents, senderFrame: { url: "http://localhost:8787/" } }, win, "http://localhost:8787")).toBe(false);
    expect(checkTrustedSender({ sender: webContents, senderFrame: { ...mainFrame, url: "http://localhost:87870/" } }, { webContents: { mainFrame: { url: "http://localhost:87870/" } } }, "http://localhost:8787")).toBe(false);
  });

  it("keeps only allowed fields per op", () => {
    expect(validateMemoryRequest({ op: "turn", text: "記住我不吃香菜", request_id: "req_abcdef12", subject: "profile_x", extra: 1 })).toEqual({ ok: true, request: { op: "turn", text: "記住我不吃香菜", request_id: "req_abcdef12" } });
    expect(validateMemoryRequest({ op: "setup", enabled: true, subject: { kind: "name", name: "George", profileId: "x" }, allow: [{ provider: "claude", account: "fp0000claude0001", allowed: true }] }))
      .toEqual({ ok: true, request: { op: "setup", enabled: true, subject: { kind: "name", name: "George" }, allow: [{ provider: "claude", account: "fp0000claude0001" }] } });
    // MEM-3：openai_realtime（OpenAI API key 即時語音）的同意鍵含底線；大寫或開頭不是字母的仍拒絕。
    expect(validateMemoryRequest({ op: "setup", enabled: true, subject: { kind: "household" }, allow: [{ provider: "openai_realtime", account: "fp000openairt001" }] }))
      .toEqual({ ok: true, request: { op: "setup", enabled: true, subject: { kind: "household" }, allow: [{ provider: "openai_realtime", account: "fp000openairt001" }] } });
    expect(validateMemoryRequest({ op: "setup", enabled: true, subject: { kind: "household" }, allow: [{ provider: "_openai", account: "fp000openairt001" }] })).toMatchObject({ ok: false });
    expect(validateMemoryRequest({ op: "card_answer", card: C, choice: "household", ticket: "forged" })).toEqual({ ok: true, request: { op: "card_answer", card: C, choice: "household" } });
    expect(validateMemoryRequest({ op: "edit", id: F, revision: 3, value: "不吃香菜", token: T, subject: P })).toEqual({ ok: true, request: { op: "edit", id: F, revision: 3, value: "不吃香菜", token: T } });
    expect(validateMemoryRequest({ op: "edit", id: null, value: "喜歡恐龍", subject: P, token: T })).toEqual({ ok: true, request: { op: "edit", id: null, value: "喜歡恐龍", subject: P, token: T } });
    expect(validateMemoryRequest({ op: "suspend", reason: "multi_face" })).toEqual({ ok: true, request: { op: "suspend", reason: "multi_face" } });
    // MEM-5a：記憶建議的開關只有記憶管理（token）能送；多的欄位丟掉。
    expect(validateMemoryRequest({ op: "suggestions", enabled: true, token: T, card: C })).toEqual({ ok: true, request: { op: "suggestions", enabled: true, token: T } });
    expect(validateMemoryRequest({ op: "suggestions", enabled: true })).toMatchObject({ ok: false });
    expect(validateMemoryRequest({ op: "suggestions", enabled: "yes", token: T })).toMatchObject({ ok: false });
    expect(validateMemoryRequest({ op: "list", manage: true })).toEqual({ ok: true, request: { op: "list", manage: true } });
    expect(validateMemoryRequest({ op: "select", profile: P, card: C, extra: 1 })).toEqual({ ok: true, request: { op: "select", profile: P, card: C } });
    expect(validateMemoryRequest({ op: "setup", enabled: false, subject: { kind: "household" }, allow: [], token: T })).toEqual({ ok: true, request: { op: "setup", enabled: false, subject: { kind: "household" }, allow: [], token: T } });
    expect(validateMemoryRequest({ op: "forget", all: true, subject: null, token: T, id: F })).toEqual({ ok: true, request: { op: "forget", all: true, subject: null, token: T } });
    expect(validateMemoryRequest({ op: "profile_minor", profile: P, minor: true, token: T })).toEqual({ ok: true, request: { op: "profile_minor", profile: P, minor: true, token: T } });
    // MEM-2：SSE 只送卡片 ID，內容只經 card_view；語音卡上的「記住／更正／忘記」是 confirm。
    expect(validateMemoryRequest({ op: "card_view", card: C, text: "偷帶內容", token: T })).toEqual({ ok: true, request: { op: "card_view", card: C } });
    expect(validateMemoryRequest({ op: "card_answer", card: C, choice: "confirm" })).toEqual({ ok: true, request: { op: "card_answer", card: C, choice: "confirm" } });
  });

  it.each([
    null, [], { op: "drop_all" }, { op: "turn", text: "", request_id: "req_abcdef12" }, { op: "turn", text: "x".repeat(2001), request_id: "req_abcdef12" },
    { op: "setup", enabled: "yes", subject: { kind: "household" }, allow: [] }, { op: "setup", enabled: true, subject: { kind: "person", profileId: P }, allow: [] },
    { op: "card_answer", card: C, choice: "approve_all" }, { op: "select", profile: "George" }, { op: "suspend", reason: "user_said_so" },
    { op: "suspend", reason: "select" }, { op: "edit", id: F, value: "x" }, { op: "forget", id: F, revision: 0 }, { op: "pin", id: F, revision: 1, pinned: "yes" },
    { op: "profile_delete", profile: P }, { op: "link_face", profile: P, person: "George", token: T }, { op: "receipt", operation_id: "not-a-uuid" },
    { op: "forget", all: true, subject: null }, { op: "profile_minor", profile: P, minor: "yes", token: T }, { op: "select", profile: P, card: "anything" },
    { op: "card_view" }, { op: "card_view", card: "mc_short" }, { op: "card_view", card: 42 },
  ])("rejects %j", (req) => {
    expect(validateMemoryRequest(req).ok).toBe(false);
  });
});

describe("Electron wiring for memory (static)", () => {
  const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");

  it("checks the sender and shape before the core; only list manage consumes the 「記憶…」 click", () => {
    const handler = main.slice(main.indexOf('ipcMain.handle("nous:memory"'));
    expect(handler).toMatch(/checkTrustedSender\(event, win, core\.url\)/);
    expect(handler).toMatch(/validateMemoryRequest\(request\)/);
    expect(handler).toMatch(/op === "list" && checked\.request\.manage === true \? memoryClick\.consume\(Date\.now\(\)\) : false/);
    expect(handler.indexOf("checkTrustedSender")).toBeLessThan(handler.indexOf("core.memory.handle"));
    expect([...main.matchAll(/memoryClick\.mark\(/g)]).toHaveLength(1);
    expect(main).toMatch(/function openMemory\(\) \{\n {2}memoryClick\.mark\(Date\.now\(\)\);\n {2}command\("memory"\);/);
  });

  it("revokes on OS lock and main-window navigation; injects safeStorage-backed memory and native confirms", () => {
    expect(main).toMatch(/powerMonitor\.on\("lock-screen", \(\) => \{\s*core\?\.memory\?\.suspendAll\(\);\s*if \(core\?\.tasks\) core\.tasks\.dropPlaintext\("os_lock"\);\s*else notifyPlaintextDropped\("os_lock"\);\s*\}\)/);
    // MEM-4c：睡眠也丟棄已結束受保護任務的解密內容。
    expect(main).toMatch(/powerMonitor\.on\("suspend", \(\) => \(core\?\.tasks \? core\.tasks\.dropPlaintext\("suspend"\) : notifyPlaintextDropped\("suspend"\)\)\)/);
    // MEM-4c 審查 M1：只送白名單裡的原因、不含內容。
    expect(main).toMatch(/win\.webContents\.send\("tasks:plaintext-dropped", \{ reason \}\)/);
    expect(main).toMatch(/did-navigate", \(\) => \{ core\?\.identity\?\.closeSessions\(\); core\?\.memory\?\.closeSessions\(\); core\?\.tasks\?\.closeSessions\(\); \}/);
    expect(main).toMatch(/render-process-gone", \(\) => \{ core\?\.identity\?\.closeSessions\(\); core\?\.memory\?\.closeSessions\(\); core\?\.tasks\?\.closeSessions\(\); \}/);
    // MEM-4a：記憶與任務加密共用同一個 safeStorage secretBox。
    expect(main).toMatch(/const secretBox = createMemorySecretBox\(\{ safeStorage, ready: \(\) => app\.isReady\(\) \}\)/);
    expect(main).toMatch(/memory: \{\n\s+dir: memoryDir,\n\s+secretBox,/);
    expect(main).toMatch(/confirm: confirmMemory/);
    expect(main).toMatch(/checkboxChecked: memory\.defaultDelete === true/);
    expect(main).toMatch(/onPresence: \(\) => \{ if \(win && !win\.isDestroyed\(\)\) win\.webContents\.send\("nous:memory-changed"\); \}/);
  });

  it("preload only invokes nous:memory", () => {
    const invoke = vi.fn();
    let exposed: Record<string, (r: unknown) => unknown> = {};
    new Function("require", "process", preload)(() => ({ contextBridge: { exposeInMainWorld: (_k: string, api: typeof exposed) => { exposed = api; } }, ipcRenderer: { invoke, send: vi.fn(), sendSync: vi.fn(() => "zh-TW"), on: vi.fn(), removeListener: vi.fn() } }), { argv: [] });
    exposed.memory!({ op: "status" });
    expect(invoke).toHaveBeenCalledWith("nous:memory", { op: "status" });
    expect(typeof exposed.onMemoryChange).toBe("function");
  });
});
