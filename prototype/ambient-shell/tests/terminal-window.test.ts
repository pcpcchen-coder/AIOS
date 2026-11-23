// WIN-1（George 2026-11-23）：Pi 設定裡的「離開全螢幕／回到全螢幕」。核心只記最近一次請求（60 秒內有效）；設定頁照實寫狀態。
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TerminalDisplay } from "../server/terminal-display.ts";
import { isWindowMode, TERMINAL_WINDOW_TEXT, WINDOW_REQUEST_FRESH_MS, windowModeFromSearch } from "../shared/terminal-window.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

describe("window request in the core", () => {
  it("is per terminal, kept for 60 s, then null so the Pi keeps its own saved mode", () => {
    let now = 0;
    const d = new TerminalDisplay({ now: () => now });
    expect(d.view("rpi4").window).toBeNull();
    d.requestWindow("rpi4", "window");
    expect(d.view("rpi4").window).toBe("window");
    expect(d.view("other").window).toBeNull();
    now = WINDOW_REQUEST_FRESH_MS - 1;
    expect(d.view("rpi4").window).toBe("window");
    d.requestWindow("rpi4", "kiosk");
    expect(d.view("rpi4").window).toBe("kiosk");
    now += WINDOW_REQUEST_FRESH_MS;
    expect(d.view("rpi4")).toEqual({ screen: "on", fresh: false, window: null });
  });

  it("reads the page mode from the URL the Pi kit opens", () => {
    expect(windowModeFromSearch("?terminal=rpi4")).toBe("kiosk");
    expect(windowModeFromSearch("?terminal=rpi4&display=window")).toBe("window");
    expect(isWindowMode("window") && isWindowMode("kiosk") && !isWindowMode("maximized")).toBe(true);
  });
});

describe("settings section", () => {
  class El {
    children: (El | string)[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, (() => void)[]>();
    disabled = false;
    constructor(readonly tagName: string) {}
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    append(...nodes: (El | string)[]) { this.children.push(...nodes); }
    addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    click() { for (const fn of this.listeners.get("click") ?? []) fn(); }
    get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  }
  let views: typeof import("../src/views.ts");
  beforeAll(async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
    views = await import("../src/views.ts");
  });
  afterAll(() => vi.unstubAllGlobals());
  const buttons = (el: El) => el.all().filter((e) => e.tagName === "button");

  it("full screen → 離開全螢幕 asks for window; window → 回到全螢幕 asks for kiosk", () => {
    const calls: string[] = [];
    const actions = { setTerminalWindow: (m: string) => calls.push(m) } as never;
    const kiosk = views.renderTerminalWindowSettings({ current: "kiosk", status: null }, actions) as unknown as El;
    expect(kiosk.textContent).toContain(TERMINAL_WINDOW_TEXT.nowKiosk);
    expect(buttons(kiosk).map((b) => b.textContent)).toEqual([TERMINAL_WINDOW_TEXT.exit]);
    buttons(kiosk)[0]!.click();
    const win = views.renderTerminalWindowSettings({ current: "window", status: null }, actions) as unknown as El;
    expect(buttons(win).map((b) => b.textContent)).toEqual([TERMINAL_WINDOW_TEXT.enter]);
    buttons(win)[0]!.click();
    expect(calls).toEqual(["window", "kiosk"]);
  });

  it("says honestly what happened after the click", () => {
    const sent = views.renderTerminalWindowSettings({ current: "kiosk", status: { kind: "sent" } }, { setTerminalWindow: () => {} } as never) as unknown as El;
    expect(sent.textContent).toContain(TERMINAL_WINDOW_TEXT.pending);
    expect(buttons(sent)[0]!.disabled).toBe(true);
    const none = views.renderTerminalWindowSettings({ current: "kiosk", status: { kind: "no_response" } }, { setTerminalWindow: () => {} } as never) as unknown as El;
    expect(none.textContent).toContain(TERMINAL_WINDOW_TEXT.noResponse);
    const err = views.renderTerminalWindowSettings({ current: "kiosk", status: { kind: "error", message: "boom" } }, { setTerminalWindow: () => {} } as never) as unknown as El;
    expect(err.textContent).toContain("沒有送出：boom");
  });

  it("every string has an English entry", () => {
    const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const source of Object.values(TERMINAL_WINDOW_TEXT)) {
      expect(en[source], source).toBeTruthy();
      expect(en[source]).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
