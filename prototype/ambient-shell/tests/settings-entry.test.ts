// SET-1（George 2026-11-07）：Pi 終端頁面右下角的設定按鈕。只在終端頁面出現；點一下打開設定、再點一下收起；中英文標籤。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_ENTRY_TEXT, SettingsEntry, settingsEntryEnabled } from "../src/settings-entry.ts";

class El {
  children: El[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  type = "";
  className = "";
  title = "";
  constructor(readonly tagName: string) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  append(...nodes: El[]) { this.children.push(...nodes); }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click() { for (const fn of this.listeners.get("click") ?? []) fn(); }
}
const doc = { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) } as unknown as Document;

describe("settingsEntryEnabled", () => {
  it("only on a terminal page without the App preload", () => {
    expect(settingsEntryEnabled({ search: "?terminal=rpi4", desktop: false })).toBe(true);
    expect(settingsEntryEnabled({ search: "", desktop: false })).toBe(false);
    expect(settingsEntryEnabled({ search: "?terminal=rpi4", desktop: true })).toBe(false);
    expect(settingsEntryEnabled({ search: "?terminal=rpi4&terminal=rpi4", desktop: false })).toBe(false);
    expect(settingsEntryEnabled({ search: "?terminal=../x", desktop: false })).toBe(false);
  });
});

describe("SettingsEntry", () => {
  it("opens the settings surface, then closes it; label and pressed state follow", () => {
    let open = false;
    const calls: string[] = [];
    const host = new El("body");
    const entry = new SettingsEntry({
      isOpen: () => open,
      open: () => { calls.push("open"); open = true; },
      close: () => { calls.push("close"); open = false; },
      t: (s) => s,
      doc,
      host: host as unknown as HTMLElement,
    });
    const b = entry.button as unknown as El;
    expect(host.children).toEqual([b]);
    expect(b.className).toBe("settings-entry");
    expect(b.getAttribute("data-visibility-reason")).toBe("user_request:terminal_settings_entry");
    expect(b.getAttribute("aria-label")).toBe(SETTINGS_ENTRY_TEXT.open);
    expect(b.getAttribute("aria-pressed")).toBe("false");
    b.click();
    expect(b.getAttribute("aria-label")).toBe(SETTINGS_ENTRY_TEXT.close);
    expect(b.getAttribute("aria-pressed")).toBe("true");
    b.click();
    expect(calls).toEqual(["open", "close"]);
    // 設定畫面被別處收起（Esc、說「收起」）：render 時 refresh 跟上。
    open = true;
    entry.refresh();
    expect(b.title).toBe(SETTINGS_ENTRY_TEXT.close);
  });

  it("labels go through the translator and have English entries", () => {
    const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const source of Object.values(SETTINGS_ENTRY_TEXT)) {
      expect(en[source], source).toBeTruthy();
      expect(en[source]).not.toMatch(/\p{Script=Han}/u);
    }
    const entry = new SettingsEntry({ isOpen: () => false, open: () => {}, close: () => {}, t: (s) => en[s] ?? s, doc, host: new El("body") as unknown as HTMLElement });
    expect(entry.button.getAttribute("aria-label")).toBe("Open settings");
  });

  it("the stylesheet moves the camera dot and preview out of the button's corner", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toMatch(/body\.has-settings-entry \.sensor-indicator \{ right: 64px; \}/);
    expect(css).toMatch(/body\.has-settings-entry \.sensor-preview \{ bottom: 56px; \}/);
  });
});
