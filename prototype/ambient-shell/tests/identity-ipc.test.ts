// 家人辨識的 IPC 過濾（desktop/identity-ipc.mjs，純函式）與 preload 暴露的 API。Electron 本身沒有在這裡執行：
// ipcMain.handle、contextBridge 與真正的 webContents／frame 物件只能在 Mac 上驗證（驗證紀錄 family-id-01 §6）。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkIdentitySender, MENU_CLICK_WINDOW_MS, MenuClickWindow, validateIdentityRequest } from "../desktop/identity-ipc.mjs";

const SESSION = `ids_${"a".repeat(32)}`;
const MODEL = { detector: "d", recognizer: "r", align: "a", preproc: "p" };
const feature = () => Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0));

describe("checkIdentitySender", () => {
  const core = "http://localhost:8787";
  const mainFrame = { url: `${core}/` };
  const webContents = { mainFrame };
  const win = { webContents, isDestroyed: () => false };

  it("accepts only the main window's main frame showing the local core page", () => {
    expect(checkIdentitySender({ sender: webContents, senderFrame: mainFrame }, win, core)).toBe(true);
    expect(checkIdentitySender({ sender: webContents, senderFrame: { url: core } }, { ...win, webContents: { mainFrame: { url: core } } }, core)).toBe(false); // frame 物件不同
  });

  it("rejects other windows, iframes, navigated or look-alike origins, destroyed windows and missing data", () => {
    const other = { mainFrame: { url: `${core}/` } };
    expect(checkIdentitySender({ sender: other, senderFrame: other.mainFrame }, win, core)).toBe(false); // 指令表等其他視窗
    expect(checkIdentitySender({ sender: webContents, senderFrame: { url: `${core}/` } }, win, core)).toBe(false); // iframe
    for (const url of ["https://evil.example/", "http://localhost:87870/", "http://localhost:8787.evil.example/", "file:///etc/passwd", ""]) {
      const frame = { url };
      expect(checkIdentitySender({ sender: { mainFrame: frame }, senderFrame: frame }, { webContents: { mainFrame: frame } }, core), url).toBe(false);
    }
    expect(checkIdentitySender({ sender: webContents, senderFrame: mainFrame }, { ...win, isDestroyed: () => true }, core)).toBe(false);
    expect(checkIdentitySender({ sender: webContents, senderFrame: mainFrame }, null, core)).toBe(false);
    expect(checkIdentitySender({ sender: webContents, senderFrame: mainFrame }, win, "")).toBe(false);
    expect(checkIdentitySender(null, win, core)).toBe(false);
  });
});

describe("validateIdentityRequest", () => {
  it("whitelists ops and strips unknown fields", () => {
    expect(validateIdentityRequest({ op: "open_session", extra: 1 })).toEqual({ ok: true, request: { op: "open_session" } });
    expect(validateIdentityRequest({ op: "list", session: SESSION, gallery: true })).toEqual({ ok: true, request: { op: "list", session: SESSION } });
    for (const op of ["export", "dump", "read_gallery", "__proto__", "constructor", 1, null]) {
      expect(validateIdentityRequest({ op, session: SESSION }), String(op)).toMatchObject({ ok: false });
    }
    for (const bad of [null, undefined, "open_session", [], 42]) expect(validateIdentityRequest(bad)).toMatchObject({ ok: false });
  });

  it("requires a well-formed session for everything except open_session", () => {
    for (const op of ["close_session", "list", "clear_all", "ack_naming"]) {
      expect(validateIdentityRequest({ op })).toMatchObject({ ok: false });
      expect(validateIdentityRequest({ op, session: "ids_short" })).toMatchObject({ ok: false });
      expect(validateIdentityRequest({ op, session: SESSION })).toEqual({ ok: true, request: { op, session: SESSION } });
    }
  });

  it("probe: integers, a model, and an optional 128-number feature", () => {
    const base = { op: "probe", session: SESSION, gen: 3, face_count: 1, quality: "ok", model: MODEL };
    expect(validateIdentityRequest({ ...base, feature: feature(), score: 0.9 })).toEqual({ ok: true, request: { ...base, feature: feature() } });
    expect(validateIdentityRequest(base)).toEqual({ ok: true, request: base });
    expect(validateIdentityRequest({ ...base, feature: feature().slice(1) })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, feature: [...feature().slice(1), Number.NaN] })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, feature: [...feature().slice(1), "1"] })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, gen: 1.5 })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, face_count: -1 })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, model: { ...MODEL, align: "" } })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, quality: "" })).toMatchObject({ ok: false });
  });

  it("enroll: booleans, a bounded name string and 1–10 samples (the core checks 5–10, names and normalization)", () => {
    const base = { op: "enroll", session: SESSION, name: "George", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples: [feature(), feature()] };
    expect(validateIdentityRequest(base)).toEqual({ ok: true, request: base });
    expect(validateIdentityRequest({ ...base, samples: Array.from({ length: 11 }, feature) })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, samples: [] })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, samples: [feature(), [1, 2]] })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, consent: "yes" })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, name: 5 })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, name: "x".repeat(257) })).toMatchObject({ ok: false });
  });

  it("ID-02 ambient_status / ambient_probe: no session; track, model and an optional feature; extra fields (session, person_id, name) dropped", () => {
    expect(validateIdentityRequest({ op: "ambient_status", session: SESSION })).toEqual({ ok: true, request: { op: "ambient_status" } });
    const base = { op: "ambient_probe", track: 4, face_count: 1, quality: "ok", model: MODEL };
    expect(validateIdentityRequest({ ...base, feature: feature(), session: SESSION, person_id: `fam_${"0".repeat(24)}`, name: "George" })).toEqual({ ok: true, request: { ...base, feature: feature() } });
    expect(validateIdentityRequest({ ...base, track: -1 })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, feature: [1, 2] })).toMatchObject({ ok: false });
    expect(validateIdentityRequest({ ...base, model: null })).toMatchObject({ ok: false });
  });

  it("ID-02 greeting: interaction ID format, integer track, boolean eligible, route api_key|live; any page text (name, prompt) is dropped", () => {
    const base = { op: "greeting", interaction: `int_${"a".repeat(16)}`, track: 2, eligible: true, route: "live" };
    expect(validateIdentityRequest({ ...base, name: "George", text: "請說 George 你好", person_id: `fam_${"0".repeat(24)}` })).toEqual({ ok: true, request: base });
    expect(validateIdentityRequest({ ...base, route: "api_key" })).toMatchObject({ ok: true });
    for (const bad of [{ interaction: "George" }, { interaction: `int_${"a".repeat(15)}` }, { track: 1.5 }, { eligible: "true" }, { route: "tts" }]) {
      expect(validateIdentityRequest({ ...base, ...bad }), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it("delete needs a well-formed person id", () => {
    const id = `fam_${"0".repeat(24)}`;
    expect(validateIdentityRequest({ op: "delete", session: SESSION, person_id: id })).toEqual({ ok: true, request: { op: "delete", session: SESSION, person_id: id } });
    expect(validateIdentityRequest({ op: "delete", session: SESSION, person_id: "../gallery" })).toMatchObject({ ok: false });
  });
});

describe("MenuClickWindow（點擊後 10 秒）", () => {
  it("is valid once within 10 s of the menu click, never without a click", () => {
    const w = new MenuClickWindow();
    expect(w.consume(1000)).toBe(false); // 沒點過（語音、頁面腳本自己開）
    w.mark(1000);
    expect(w.consume(1000 + MENU_CLICK_WINDOW_MS)).toBe(true);
    expect(w.consume(1000 + MENU_CLICK_WINDOW_MS)).toBe(false); // 一次有效
    w.mark(5000);
    expect(w.consume(5000 + MENU_CLICK_WINDOW_MS + 1)).toBe(false); // 過期
    w.mark(9000);
    expect(w.consume(8000)).toBe(false); // 時間倒退
  });
});

describe("Electron wiring (static)", () => {
  const preload = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");

  it("preload exposes only the named app and locale capabilities, and identity only invokes nous:identity", async () => {
    const exposed: Record<string, Record<string, unknown>> = {};
    const invoke = vi.fn();
    const send = vi.fn();
    const sendSync = vi.fn(() => "zh-TW");
    const require = (name: string) => {
      expect(name).toBe("electron");
      return { contextBridge: { exposeInMainWorld: (key: string, api: Record<string, unknown>) => (exposed[key] = api) }, ipcRenderer: { invoke, send, sendSync, on: vi.fn(), removeListener: vi.fn() } };
    };
    new Function("require", preload)(require);
    expect(Object.keys(exposed)).toEqual(["nousDesktop"]);
    expect(Object.keys(exposed.nousDesktop!).sort()).toEqual(["confirmDelete", "identity", "initialLocale", "memory", "onLocaleChange", "onMemoryChange", "onPower", "onTasksPlaintextDropped", "openExternal", "reportState", "tasks"]);
    (exposed.nousDesktop!.identity as (r: unknown) => unknown)({ op: "open_session" });
    expect(invoke).toHaveBeenCalledWith("nous:identity", { op: "open_session" });
    expect(send).not.toHaveBeenCalled();
    expect(sendSync).toHaveBeenCalledExactlyOnceWith("nous:get-locale");
  });

  it("main.mjs checks the sender and the request shape before handing it to the core, and only open_session consumes the click", () => {
    const handler = main.slice(main.indexOf('ipcMain.handle("nous:identity"'));
    expect(handler).toMatch(/checkIdentitySender\(event, win, core\.url\)/);
    expect(handler).toMatch(/validateIdentityRequest\(request\)/);
    expect(handler).toMatch(/op === "open_session" \? familyClick\.consume\(Date\.now\(\)\) : false/);
    expect(handler.indexOf("checkIdentitySender")).toBeLessThan(handler.indexOf("core.identity.handle"));
    // 點擊只在選單列的「家人辨識…」與「校正人臉辨識…」（同一個 openFamily）記錄，記下之後才交給頁面
    expect([...main.matchAll(/familyClick\.mark\(/g)]).toHaveLength(1);
    expect(main).toMatch(/function openFamily\(mode\) \{\n {2}familyClick\.mark\(Date\.now\(\)\);\n {2}if \(mode === "calibrate"\) command\("family-calibrate"\);\n {2}else command\("family"\);/);
  });

  it("safeStorage is only offered on macOS and never with the basic_text backend; confirm requires the parent checkbox for a minor", () => {
    expect(main).toMatch(/process\.platform !== "darwin" \|\| !safeStorage\.isEncryptionAvailable\(\)/);
    expect(main).toMatch(/getSelectedStorageBackend\(\) === "basic_text"/);
    expect(main).toMatch(/return response === 0 && \(!minor \|\| checkboxChecked === true\);/);
    expect(main).toMatch(/execFile\("tmutil", \["addexclusion", dir\]/);
  });
});
