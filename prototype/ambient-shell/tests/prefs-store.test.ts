import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClockSettingsStore } from "../server/clock-settings.ts";
import { PrefsFile } from "../server/prefs-file.ts";
import { PrefsStore, type PrefsStoreOptions } from "../server/prefs-store.ts";

// S5：PrefsStore（各設定 store 共用的樣板）與 PrefsFile 的直接測試。全部用暫存資料夾的 fixture，不碰真實的 configDir。
// 「預期的檔案內容」是照重整前各 store 的寫法推出來的：JSON.stringify({ schema_version: 1, prefs }, null, 2)、結尾沒有換行、權限 0600。

interface DemoPrefs {
  on: boolean;
  level: number;
  label: string | null;
}

const DEMO_KEYS = ["on", "level", "label"] as const;
const DEMO_DEFAULTS: DemoPrefs = { on: true, level: 3, label: null };

/** 逐鍵驗證；不認得或不合法的鍵丟錯（與 shared/ 各 parse*Patch 同一個約定）。 */
function parseDemo(input: unknown): Partial<DemoPrefs> {
  const out: Partial<DemoPrefs> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === "on" && typeof value === "boolean") out.on = value;
    else if (key === "level" && typeof value === "number" && value >= 0 && value <= 9) out.level = value;
    else if (key === "label" && (value === null || typeof value === "string")) out.label = value;
    else throw new Error(`${key} 不合法`);
  }
  return out;
}

/** 最小的 store：和 voice／memories 一樣，view() 是保存值疊預設值、update() 寫檔後回 view()。 */
class DemoStore extends PrefsStore<DemoPrefs> {
  constructor(options: PrefsStoreOptions, failClosed: Partial<DemoPrefs> = { on: false }) {
    super({ name: "demo.json", parse: parseDemo, failClosed, unreadable: "示範設定保持關閉" }, options);
  }

  view(): DemoPrefs {
    return this.resolve(DEMO_KEYS, DEMO_DEFAULTS);
  }

  update(patch: Partial<DemoPrefs>): DemoPrefs {
    this.commit(patch);
    return this.view();
  }

  /** defaults 帶多餘的鍵時（camera 的 base 就是這樣），結果只有 keys 列出的鍵。 */
  onlyLevel(): { level: number } {
    return this.resolve<{ level: number }>(["level"], { ...DEMO_DEFAULTS, level: 7 });
  }
}

/** 這個測試建立的暫存資料夾；每項測試結束後全部刪掉。 */
const created: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nous-prefs-store-"));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function make(dir: string, failClosed?: Partial<DemoPrefs>) {
  const logs: string[] = [];
  let changes = 0;
  const store = new DemoStore({ dir, onChange: () => changes++, log: (m) => logs.push(m) }, failClosed);
  return { store, logs, changes: () => changes };
}

function text(prefs: unknown): string {
  return JSON.stringify({ schema_version: 1, prefs }, null, 2);
}

describe("PrefsStore", () => {
  it("沒有檔案：全部是預設值、鍵的順序照 keys、不建立檔案也不記 log", () => {
    const dir = join(tmp(), "nested");
    const { store, logs, changes } = make(dir);
    expect(JSON.stringify(store.view())).toBe('{"on":true,"level":3,"label":null}');
    expect(existsSync(dir)).toBe(false);
    expect(logs).toEqual([]);
    expect(changes()).toBe(0);
  });

  it("update：只寫改過的鍵、位元組與權限和重整前相同、每次都呼叫 onChange 一次", () => {
    const root = tmp();
    const dir = join(root, "nested");
    const { store, changes } = make(dir);
    expect(store.update({ level: 5 })).toEqual({ on: true, level: 5, label: null });
    const file = join(dir, "demo.json");
    // 逐字比對：2 個空白縮排、結尾沒有換行。
    expect(readFileSync(file, "utf8")).toBe('{\n  "schema_version": 1,\n  "prefs": {\n    "level": 5\n  }\n}');
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(dir)).toEqual(["demo.json"]);
    expect(changes()).toBe(1);

    // 同樣的 patch 再送一次：檔案不變，但 onChange 仍然呼叫（重整前就是每次都通知，不比較有沒有變）。
    store.update({ level: 5 });
    expect(readFileSync(file, "utf8")).toBe(text({ level: 5 }));
    expect(changes()).toBe(2);

    // 後來的鍵接在後面；重新建立 store 讀到同一份。
    store.update({ on: false, label: "書房" });
    expect(readFileSync(file, "utf8")).toBe(text({ level: 5, on: false, label: "書房" }));
    expect(changes()).toBe(3);
    expect(make(dir).store.view()).toEqual({ on: false, level: 5, label: "書房" });
  });

  it("保存的 null 視同沒有保存（?? 預設值）", () => {
    const dir = tmp();
    writeFileSync(join(dir, "demo.json"), text({ label: null, level: 0, on: false }));
    expect(make(dir).store.view()).toEqual({ on: false, level: 0, label: null });
  });

  it("resolve 只帶 keys 列出的鍵；defaults 多出來的鍵不會進結果", () => {
    const dir = tmp();
    const { store } = make(dir);
    expect(store.onlyLevel()).toEqual({ level: 7 });
    store.update({ level: 2, on: false });
    expect(store.onlyLevel()).toEqual({ level: 2 });
  });

  it("逐鍵驗證：壞掉的鍵丟掉並記 log，在 failClosed 裡的鍵用 failClosed 的值，其餘照用；讀取不改檔案", () => {
    const dir = tmp();
    const file = join(dir, "demo.json");
    const before = text({ on: "yes", level: 99, label: "客廳", made_up: 1 });
    writeFileSync(file, before);
    const { store, logs, changes } = make(dir);
    // on 不合法 → failClosed 的 false（不是預設的 true）；level 不合法且不在 failClosed → 預設 3；label 照用。
    expect(store.view()).toEqual({ on: false, level: 3, label: "客廳" });
    expect(logs).toEqual([`${file} 有 3 項設定被忽略（on 不合法；level 不合法；made_up 不合法），其餘照用`]);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(changes()).toBe(0);
  });

  it.each([
    ["不是 JSON", "{oops", /^無法讀取 .*demo\.json（.+），示範設定保持關閉$/],
    ["不是物件", "null", /（內容不是 JSON 物件），示範設定保持關閉$/],
    ["版本不符", JSON.stringify({ schema_version: 2, prefs: { on: true } }), /（不支援的 schema_version：2），示範設定保持關閉$/],
    ["沒有版本", JSON.stringify({ prefs: { on: true } }), /（不支援的 schema_version：undefined），示範設定保持關閉$/],
    ["prefs 是陣列", JSON.stringify({ schema_version: 1, prefs: [] }), /（prefs 不是物件），示範設定保持關閉$/],
    ["沒有 prefs", JSON.stringify({ schema_version: 1 }), /（prefs 不是物件），示範設定保持關閉$/],
  ])("檔案讀不懂（%s）：fail closed、記一筆 log、不覆寫檔案", (_name, content, message) => {
    const dir = tmp();
    const file = join(dir, "demo.json");
    writeFileSync(file, content);
    const { store, logs, changes } = make(dir);
    expect(store.view()).toEqual({ on: false, level: 3, label: null });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(message);
    expect(readFileSync(file, "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual(["demo.json"]);
    expect(changes()).toBe(0);
  });

  it("讀不懂之後的第一次 update：寫出 failClosed 疊上 patch（使用者明確改了才覆寫）", () => {
    const dir = tmp();
    const file = join(dir, "demo.json");
    writeFileSync(file, "{oops");
    const { store, changes } = make(dir);
    expect(store.update({ level: 4 })).toEqual({ on: false, level: 4, label: null });
    expect(readFileSync(file, "utf8")).toBe(text({ on: false, level: 4 }));
    expect(changes()).toBe(1);
  });

  it("failClosed 是 {}：讀不懂時退回預設", () => {
    const dir = tmp();
    writeFileSync(join(dir, "demo.json"), "[]");
    const { store, logs } = make(dir, {});
    expect(store.view()).toEqual(DEMO_DEFAULTS);
    expect(logs).toHaveLength(1);
  });

  it("寫入 .tmp 就失敗（.tmp 已經是資料夾）：丟錯、記憶體不變、不呼叫 onChange、原本的設定檔不變", () => {
    const dir = tmp();
    const { store, changes } = make(dir);
    store.update({ level: 5 });
    // demo.json.tmp 已經是資料夾：writeFileSync 會失敗（不靠權限，root 執行也成立）。
    mkdirSync(join(dir, "demo.json.tmp"));
    writeFileSync(join(dir, "demo.json.tmp", "keep"), "x");
    expect(() => store.update({ level: 6 })).toThrow();
    expect(store.view().level).toBe(5);
    expect(changes()).toBe(1);
    expect(readFileSync(join(dir, "demo.json"), "utf8")).toBe(text({ level: 5 }));
    // PrefsFile 的清理是 rmSync(tmp, { force: true })：刪不掉資料夾時原本的寫檔錯誤被這個錯誤取代；資料夾還在。
    expect(existsSync(join(dir, "demo.json.tmp", "keep"))).toBe(true);
  });

  it("renameSync 失敗（設定檔的位置是非空資料夾）：丟出 rename 的錯誤、.tmp 檔被清掉、記憶體不變、不呼叫 onChange", () => {
    const dir = tmp();
    const { store, changes } = make(dir);
    // 建好 store 之後才把 demo.json 變成非空資料夾：.tmp 寫得進去，rename 蓋不過去（不靠權限，root 執行也成立）。
    mkdirSync(join(dir, "demo.json"));
    writeFileSync(join(dir, "demo.json", "keep"), "x");
    let thrown: NodeJS.ErrnoException | null = null;
    try {
      store.update({ level: 6 });
    } catch (err) {
      thrown = err as NodeJS.ErrnoException;
    }
    // 丟出來的是 renameSync 的錯誤（清理成功，沒有被別的錯誤取代）。
    expect(thrown?.syscall).toBe("rename");
    // PrefsFile 的清理 rmSync(tmp, { force: true }) 把剛寫好的 .tmp 檔刪掉：資料夾裡只剩原本那個擋路的資料夾。
    expect(readdirSync(dir)).toEqual(["demo.json"]);
    expect(existsSync(join(dir, "demo.json.tmp"))).toBe(false);
    expect(readdirSync(join(dir, "demo.json"))).toEqual(["keep"]);
    expect(store.view()).toEqual(DEMO_DEFAULTS);
    expect(changes()).toBe(0);
  });

  it("沒有傳 log 時用 console.warn（PrefsFile 的預設）", () => {
    const dir = tmp();
    writeFileSync(join(dir, "demo.json"), "{oops");
    const seen: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void seen.push(args[0]);
    try {
      new DemoStore({ dir, onChange: () => {} });
    } finally {
      console.warn = original;
    }
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain("示範設定保持關閉");
  });

  it("已遷移的真實 store（ClockSettingsStore）：寫出的位元組、權限與 log 字串和重整前相同", () => {
    const dir = tmp();
    const logs: string[] = [];
    let changes = 0;
    const file = join(dir, "clock.json");
    writeFileSync(file, "{oops");
    const store = new ClockSettingsStore({ dir, onChange: () => changes++, log: (m) => logs.push(m) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^無法讀取 .*clock\.json（.+），右上角時鐘用預設值$/);
    expect(store.prefs()).toEqual({ main: false, terminal: true });
    expect(store.update({ main: true })).toEqual({ main: true, terminal: true });
    expect(readFileSync(file, "utf8")).toBe('{\n  "schema_version": 1,\n  "prefs": {\n    "main": true\n  }\n}');
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(changes).toBe(1);
  });
});

describe("PrefsFile", () => {
  function file(dir: string, failClosed: Partial<DemoPrefs> = {}) {
    const logs: string[] = [];
    const f = new PrefsFile<DemoPrefs>({ dir, name: "demo.json", version: 3, parse: parseDemo, failClosed, unreadable: "用預設值", log: (m) => logs.push(m) });
    return { f, logs };
  }

  it("path 是 dir/name；沒有檔案時 saved 是 {}", () => {
    const dir = tmp();
    const { f, logs } = file(dir);
    expect(f.path).toBe(join(dir, "demo.json"));
    expect(f.saved).toEqual({});
    expect(logs).toEqual([]);
  });

  it("update 合併並回傳新的 saved；schema_version 用傳入的版本", () => {
    const dir = tmp();
    const { f } = file(dir);
    expect(f.update({ level: 1 })).toEqual({ level: 1 });
    expect(f.update({ on: false })).toEqual({ level: 1, on: false });
    expect(f.saved).toEqual({ level: 1, on: false });
    expect(readFileSync(f.path, "utf8")).toBe('{\n  "schema_version": 3,\n  "prefs": {\n    "level": 1,\n    "on": false\n  }\n}');
    // 另一個版本的讀者把它當成讀不懂。
    const other = new PrefsFile<DemoPrefs>({ dir, name: "demo.json", version: 1, parse: parseDemo, failClosed: { on: false }, unreadable: "用預設值", log: () => {} });
    expect(other.saved).toEqual({ on: false });
  });

  it("replace 整份換掉（{} 是還原預設），不和原本的合併；之後改傳入的物件不影響 saved", () => {
    const dir = tmp();
    const { f } = file(dir);
    f.update({ level: 1, label: "a" });
    const next: Partial<DemoPrefs> = { on: false };
    expect(f.replace(next)).toEqual({ on: false });
    next.level = 9;
    expect(f.saved).toEqual({ on: false });
    expect(readFileSync(f.path, "utf8")).toBe('{\n  "schema_version": 3,\n  "prefs": {\n    "on": false\n  }\n}');
    f.replace({});
    expect(readFileSync(f.path, "utf8")).toBe('{\n  "schema_version": 3,\n  "prefs": {}\n}');
    expect(file(dir).f.saved).toEqual({});
  });

  it("讀不懂時 saved 是 failClosed 的複本（之後的 update 不會改到傳入的 failClosed）", () => {
    const dir = tmp();
    writeFileSync(join(dir, "demo.json"), "{oops");
    const failClosed: Partial<DemoPrefs> = { on: false };
    const { f, logs } = file(dir, failClosed);
    expect(f.saved).toEqual({ on: false });
    expect(f.saved).not.toBe(failClosed);
    f.update({ on: true });
    expect(failClosed).toEqual({ on: false });
    expect(logs).toHaveLength(1);
  });

  it("權限比 0600 寬的既有檔案，寫入後收回 0600", () => {
    if (process.platform === "win32") return;
    const dir = tmp();
    writeFileSync(join(dir, "demo.json"), JSON.stringify({ schema_version: 3, prefs: { level: 2 } }));
    chmodSync(join(dir, "demo.json"), 0o644);
    const { f } = file(dir);
    expect(f.saved).toEqual({ level: 2 });
    f.update({ level: 3 });
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  });
});
