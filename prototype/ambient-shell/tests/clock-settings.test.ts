// CLK-1（George 2026-11-07）：右上角時鐘的顯示設定（clock.json）、選單列「右上角時鐘與天氣」與兩種語言的文字。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClockSettingsStore } from "../server/clock-settings.ts";
import { CLOCK_TEXT, ClockPatchError, DEFAULT_CLOCK_PREFS, parseClockPatch, type ClockSettingsView } from "../shared/clock.ts";
import { CLOCK_TEXT as MENU_TEXT, clockMenu, settingsMenu } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";
import type { SettingsView } from "../shared/types.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-clock-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("clock.json", () => {
  it("defaults: Mac window off, Pi terminal on; enabled follows the page source", () => {
    const store = new ClockSettingsStore({ dir: root, onChange: () => {} });
    expect(DEFAULT_CLOCK_PREFS).toEqual({ main: false, terminal: true });
    expect(store.view("main")).toEqual({ enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/clock" });
    expect(store.view("pi").enabled).toBe(true);
    expect(store.view().enabled).toBe(false);
  });

  it("validates patches, saves only changed keys, survives a restart and ignores a bad key", () => {
    expect(parseClockPatch({ main: true })).toEqual({ main: true });
    for (const bad of [{ main: "on" }, { terminal: 1 }, { clock: true }, [], null, "x"]) expect(() => parseClockPatch(bad)).toThrow(ClockPatchError);
    let changes = 0;
    const store = new ClockSettingsStore({ dir: root, onChange: () => changes++ });
    expect(store.update({ main: true })).toEqual({ main: true, terminal: true });
    expect(changes).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "clock.json"), "utf8"))).toEqual({ schema_version: 1, prefs: { main: true } });
    expect(new ClockSettingsStore({ dir: root, onChange: () => {} }).view("main").enabled).toBe(true);
    writeFileSync(join(root, "clock.json"), JSON.stringify({ schema_version: 1, prefs: { main: "yes", terminal: false } }));
    const logs: string[] = [];
    expect(new ClockSettingsStore({ dir: root, onChange: () => {}, log: (l) => logs.push(l) }).prefs()).toEqual({ main: false, terminal: false });
    expect(logs.join("")).toContain("被忽略");
  });
});

const view = (over: Partial<ClockSettingsView["prefs"]> = {}): ClockSettingsView => ({ enabled: false, prefs: { ...DEFAULT_CLOCK_PREFS, ...over }, write_path: "/api/settings/clock" });

describe("menu bar section", () => {
  it("uses the same text as the page (the .mjs cannot import the .ts table)", () => {
    expect(MENU_TEXT).toEqual(CLOCK_TEXT);
  });

  it("two checkboxes that send the opposite value", () => {
    const patches: unknown[] = [];
    const items = clockMenu(view(), { setClock: (p) => patches.push(p) });
    expect(items.map((i) => i.label ?? i.type)).toEqual(["separator", "右上角時鐘與天氣", "Mac 視窗", "Pi 終端機"]);
    expect(items[2]).toMatchObject({ type: "checkbox", checked: false });
    expect(items[3]).toMatchObject({ type: "checkbox", checked: true });
    (items[2].click as () => void)();
    (items[3].click as () => void)();
    expect(patches).toEqual([{ main: true }, { terminal: false }]);
  });

  it("is translated in English and appears in the settings menu only when the core sends settings.clock", () => {
    const en = clockMenu(view({ main: true }), { translate: (s: string, ...v: unknown[]) => translate(s, "en", ...v) });
    expect(en.slice(1).map((i) => i.label)).toEqual(["Clock & weather corner", "Mac window", "Pi terminal"]);
    expect(en[2].sublabel).toBe("Show the time, date, and weather in the top-right corner of the Nous window on the Mac");
    const base = { seconds: [] } as unknown as SettingsView;
    const labels = (s: SettingsView) => settingsMenu(s, { command: () => {}, setMenuPref: () => {} }).map((i) => i.label);
    expect(labels(base)).not.toContain("右上角時鐘與天氣");
    expect(labels({ ...base, clock: view() })).toContain("右上角時鐘與天氣");
  });

  it("every corner and settings string has an English translation", () => {
    for (const source of Object.values(CLOCK_TEXT)) {
      const values = source.includes("{0}") ? ["X"] : [];
      expect(translate(source, "en", ...values), source).not.toMatch(/[一-鿿]/u);
    }
    for (const source of ["時鐘設定必須是 JSON 物件", "未知的時鐘設定：x", "main 必須是 true 或 false", "時鐘設定沒有保存", "時鐘設定沒有保存：x", "時鐘設定沒有保存（無法寫入設定檔：x）"]) {
      expect(translate(source, "en"), source).not.toMatch(/[一-鿿]/u);
    }
  });
});
