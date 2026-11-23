// LUX-1（George 2026-11-09）：鏡頭亮暗門檻可以在設定頁調整，每台裝置各自保存。
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  brightOptions, darkOptions, DEFAULT_LUMA_THRESHOLDS, INITIAL_LIGHT, LIGHT_HOLD_MS, nextLight, parseLumaThresholds, validLumaThresholds,
} from "../shared/day-night.ts";
import { loadLumaThresholds, LUMA_THRESHOLDS_KEY, saveLumaThresholds, VOICE_VOLUME_TEXT } from "../src/voice-volume.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("thresholds", () => {
  it("defaults stay 95/115; validation needs integers 5–250 with dark at least 5 below bright", () => {
    expect(DEFAULT_LUMA_THRESHOLDS).toEqual({ dark: 95, bright: 115 });
    expect(validLumaThresholds({ dark: 60, bright: 65 })).toBe(true);
    for (const bad of [{ dark: 60, bright: 64 }, { dark: 0, bright: 100 }, { dark: 50, bright: 251 }, { dark: 50.5, bright: 100 }, { dark: "50", bright: 100 }, null]) {
      expect(validLumaThresholds(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(parseLumaThresholds({ dark: 100, bright: 90 })).toEqual(DEFAULT_LUMA_THRESHOLDS);
  });

  it("options keep the gap and move in steps of 5", () => {
    expect(darkOptions(115).at(0)).toBe(5);
    expect(darkOptions(115).at(-1)).toBe(110);
    expect(brightOptions(95).at(0)).toBe(100);
    expect(brightOptions(95).at(-1)).toBe(250);
    expect(darkOptions(115).every((v) => v % 5 === 0)).toBe(true);
  });

  it("nextLight follows custom thresholds (a 70/90 Mac camera: 80 is in the gap, 65 goes dark after a minute)", () => {
    const th = { dark: 70, bright: 90 };
    let s = nextLight(INITIAL_LIGHT, 100, 0, th);
    expect(s.level).toBe("bright");
    s = nextLight(s, 80, 30_000, th);
    expect(s.level).toBe("bright");
    s = nextLight(s, 65, 60_000, th);
    s = nextLight(s, 65, 60_000 + LIGHT_HOLD_MS, th);
    expect(s.level).toBe("dark");
    // 預設門檻下 80 已經算暗（George 的 Pi 實測關燈值）。
    expect(nextLight(nextLight(INITIAL_LIGHT, 80, 0), 80, LIGHT_HOLD_MS).level).toBe("dark");
  });

  it("saved per device; bad saved values fall back; invalid saves throw and keep the old value", () => {
    const storage = memoryStorage();
    expect(loadLumaThresholds(storage)).toEqual(DEFAULT_LUMA_THRESHOLDS);
    saveLumaThresholds({ dark: 70, bright: 90 }, storage);
    expect(JSON.parse(storage.data.get(LUMA_THRESHOLDS_KEY)!)).toEqual({ dark: 70, bright: 90 });
    expect(loadLumaThresholds(storage)).toEqual({ dark: 70, bright: 90 });
    expect(() => saveLumaThresholds({ dark: 90, bright: 90 }, storage)).toThrow();
    expect(loadLumaThresholds(storage)).toEqual({ dark: 70, bright: 90 });
    expect(loadLumaThresholds(memoryStorage({ [LUMA_THRESHOLDS_KEY]: "{bad" }))).toEqual(DEFAULT_LUMA_THRESHOLDS);
  });

  it("every new string has English", () => {
    const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const source of [...Object.values(VOICE_VOLUME_TEXT.thresholds), "門檻沒有保存：{0}", "門檻不合法：算暗要比算亮至少低 5"]) {
      expect(en[source], source).toBeTruthy();
      expect(en[source]).not.toMatch(/\p{Script=Han}/u);
    }
  });
});

describe("settings page", () => {
  class El {
    children: (El | string)[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, (() => void)[]>();
    disabled = false;
    selected = false;
    value = "";
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
  const panel = (over: Record<string, unknown> = {}) => ({
    day: 100, night: 40, decision: { mode: "day", reason: "day", camera: false },
    prefs: { night_start_h: 22, night_end_h: 7, use_camera: true, night_effects: true, screen_off: true },
    light: { luma: 82, level: "dark" }, thresholds: { dark: 95, bright: 115 }, ...over,
  });

  it("two selects send the new pair, options keep the gap, reset restores 95/115", () => {
    const calls: unknown[] = [];
    const section = views.renderVoiceVolumeSettings(panel({ thresholds: { dark: 70, bright: 90 } }) as never, { setLumaThresholds: (v: unknown) => calls.push(v) } as never) as unknown as El;
    const dark = section.all().find((e) => e.attributes.has("data-luma-dark"))!;
    const bright = section.all().find((e) => e.attributes.has("data-luma-bright"))!;
    const values = (sel: El) => sel.all().filter((e) => e.tagName === "option").map((o) => Number(o.attributes.get("value")));
    expect(values(dark).at(-1)).toBe(85);
    expect(values(bright).at(0)).toBe(75);
    expect(dark.all().find((o) => o.attributes.has("selected"))?.attributes.get("value")).toBe("70");
    dark.value = "60";
    for (const fn of dark.listeners.get("change") ?? []) fn();
    bright.value = "100";
    for (const fn of bright.listeners.get("change") ?? []) fn();
    section.all().find((e) => e.attributes.has("data-luma-reset"))!.click();
    expect(calls).toEqual([{ dark: 60, bright: 90 }, { dark: 70, bright: 100 }, { dark: 95, bright: 115 }]);
    const atDefault = views.renderVoiceVolumeSettings(panel() as never, { setLumaThresholds: () => {} } as never) as unknown as El;
    expect(atDefault.all().find((e) => e.attributes.has("data-luma-reset"))!.disabled).toBe(true);
    expect(atDefault.textContent).toContain("鏡頭亮度：82（暗）");
  });

  it("no thresholds in the state means no selects", () => {
    const section = views.renderVoiceVolumeSettings(panel({ thresholds: undefined }) as never, {} as never) as unknown as El;
    expect(section.all().some((e) => e.attributes.has("data-luma-dark"))).toBe(false);
  });
});
