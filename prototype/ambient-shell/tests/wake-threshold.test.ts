// 喚醒詞門檻調整（George 2026-11-08；docs/validation/wake-threshold-2026-11-08.md）：偏好的邊界驗證、核心保存與
// settings.wake.thresholds、worker 套用調整值、聆聽中改了就重建擷取、設定頁的選項。偵測器與麥克風都是 fixture。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import manifest from "../shared/wake-runtime.json" with { type: "json" };
import {
  DEFAULT_WAKE_PREFS,
  effectiveWakeThresholds,
  offsetKeywords,
  parseWakePatch,
  WAKE_THRESHOLD_OFFSETS,
  wakeKeywordsText,
  type WakeKeywordConfig,
  type WakeRuntimeManifest,
  type WakeSettingsView,
} from "../shared/wake.ts";
import { WakeSettingsStore } from "../server/wake-settings.ts";
import { kwsConfig } from "../src/audio/detector.ts";
import { WakeController, type WakeHost } from "../src/audio/controller.ts";
import { FakeCapture, FakeClock, FakeEarcon, FakeMediaDevices, flush } from "./fixtures/wake.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

const keywords = manifest.keywords as WakeKeywordConfig;
const app = join(import.meta.dirname, "..");

describe("threshold offset preference", () => {
  it("accepts only the five options; default is 0 (the product thresholds)", () => {
    expect(WAKE_THRESHOLD_OFFSETS).toEqual([-0.1, -0.05, 0, 0.05, 0.1]);
    expect(DEFAULT_WAKE_PREFS.wake_threshold_offset).toBe(0);
    for (const v of WAKE_THRESHOLD_OFFSETS) expect(parseWakePatch({ wake_threshold_offset: v })).toEqual({ wake_threshold_offset: v });
    for (const bad of [0.2, -0.15, 0.07, "0.05", null, Number.NaN]) expect(() => parseWakePatch({ wake_threshold_offset: bad })).toThrow();
  });

  it("the store keeps a valid value and falls back to 0 for an unreadable one", () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-threshold-"));
    const store = new WakeSettingsStore({ dir, onChange: () => {} });
    expect(store.update({ wake_threshold_offset: -0.05 }).wake_threshold_offset).toBe(-0.05);
    expect(new WakeSettingsStore({ dir, onChange: () => {} }).view().wake_threshold_offset).toBe(-0.05);
    const file = join(dir, "wake.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.prefs.wake_threshold_offset = 0.3;
    writeFileSync(file, JSON.stringify(saved));
    expect(new WakeSettingsStore({ dir, onChange: () => {} }).view().wake_threshold_offset).toBe(0);
  });
});

describe("thresholds with the offset", () => {
  it("shifts Hello Nous (global 0.15) and Hey Nous (0.25 per line) by the offset, boosts unchanged", () => {
    expect(effectiveWakeThresholds(keywords, 0)).toEqual([{ phrase: "HELLO_NOUS", threshold: 0.15 }, { phrase: "HEY_NOUS", threshold: 0.25 }]);
    expect(effectiveWakeThresholds(keywords, -0.1)).toEqual([{ phrase: "HELLO_NOUS", threshold: 0.05 }, { phrase: "HEY_NOUS", threshold: 0.15 }]);
    expect(effectiveWakeThresholds(keywords, 0.1)).toEqual([{ phrase: "HELLO_NOUS", threshold: 0.25 }, { phrase: "HEY_NOUS", threshold: 0.35 }]);
    const shifted = offsetKeywords(keywords, 0.05);
    expect(kwsConfig({ ...(manifest as unknown as WakeRuntimeManifest), keywords: shifted }).keywordsThreshold).toBe(0.2);
    expect(kwsConfig({ ...(manifest as unknown as WakeRuntimeManifest), keywords: shifted }).keywordsScore).toBe(1.5);
    expect(wakeKeywordsText(shifted)).toContain("HH EY1 N OW1 S :1 #0.3 @HEY_NOUS_OW");
    // 0 不改任何東西（同一個物件）
    expect(offsetKeywords(keywords, 0)).toBe(keywords);
  });

  it("the worker accepts only a listed offset and otherwise uses the product thresholds; capture passes the setting at init", () => {
    const worker = readFileSync(join(app, "src/audio/wake-worker.ts"), "utf8");
    expect(worker).toMatch(/\(WAKE_THRESHOLD_OFFSETS as readonly unknown\[\]\)\.includes\(message\.thresholdOffset\) \? \(message\.thresholdOffset as number\) : 0/);
    expect(worker).toMatch(/keywords: offsetKeywords\(base\.keywords, offset\)/);
    expect(readFileSync(join(app, "src/audio/capture.ts"), "utf8")).toMatch(/thresholdOffset: thresholdOffset\(\)/);
    expect(readFileSync(join(app, "src/audio/index.ts"), "utf8")).toMatch(/browserCapture\(keywordPort, \(\) => controller\.thresholdOffset\)/);
  });
});

describe("WakeController: changing the offset rebuilds the capture", () => {
  const view = (listen: boolean, offset: number): WakeSettingsView => ({ ...DEFAULT_WAKE_PREFS, wake_listen: listen, wake_threshold_offset: offset, runtime: "ok" });
  const make = () => {
    const clock = new FakeClock();
    const media = new FakeMediaDevices();
    const capture = new FakeCapture();
    const host: WakeHost = { now: clock.now, runtime: () => "ok", caption: () => {}, visible: () => true, onVisible: () => () => {}, state: () => {}, newId: () => "w" };
    const c = new WakeController(host, { mic: { open: () => media.getUserMedia({ audio: true }), preferred: () => false }, capture, earcon: new FakeEarcon() });
    return { c, capture };
  };

  it("while listening: a new worker graph is built with the new offset; same offset or listening off does nothing extra", async () => {
    const { c, capture } = make();
    expect(c.thresholdOffset).toBe(0);
    c.applySettings(view(false, 0));
    c.applySettings(view(true, 0));
    await flush();
    capture.last!.events.started();
    expect(capture.connects).toBe(1);
    c.applySettings(view(true, -0.05));
    await flush();
    expect(c.thresholdOffset).toBe(-0.05);
    expect(capture.connects).toBe(2);
    expect(capture.graphs[0]!.stopped).toBe(true);
    c.applySettings(view(true, -0.05));
    await flush();
    expect(capture.connects).toBe(2);
    c.applySettings(view(false, -0.05));
    c.applySettings(view(false, 0.1));
    await flush();
    expect(capture.connects).toBe(2);
    expect(c.thresholdOffset).toBe(0.1);
    c.dispose();
  });
});

describe("settings page: 喚醒詞門檻", () => {
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
    fire(type: string) { for (const fn of this.listeners.get(type) ?? []) fn(); }
    get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  }
  let views: typeof import("../src/views.ts");
  beforeAll(async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
    views = await import("../src/views.ts");
  });
  afterAll(() => vi.unstubAllGlobals());

  const wake = (offset: number): WakeSettingsView => ({ ...DEFAULT_WAKE_PREFS, wake_threshold_offset: offset, runtime: "ok", thresholds: effectiveWakeThresholds(keywords, offset) });

  it("shows five options with the saved one selected and the effective thresholds; choosing another saves it", () => {
    const calls: unknown[] = [];
    const section = views.renderWakeThresholdSettings(wake(-0.05), { updateWake: (p: unknown) => calls.push(p) } as never) as unknown as El;
    const select = section.all().find((e) => e.tagName === "select")!;
    const options = select.children as El[];
    expect(options.map((o) => o.attributes.get("value"))).toEqual(["-0.1", "-0.05", "0", "0.05", "0.1"]);
    expect(options.filter((o) => o.selected).map((o) => o.attributes.get("value"))).toEqual(["-0.05"]);
    expect(section.textContent).toContain("目前門檻：Hello Nous 0.10、Hey Nous 0.20");
    expect(select.disabled).toBe(false);
    select.value = "0.1";
    select.fire("change");
    select.value = "-0.05";
    select.fire("change");
    expect(calls).toEqual([{ wake_threshold_offset: 0.1 }]);
  });

  it("without the action the select is disabled; every visible string has an English translation", () => {
    const section = views.renderWakeThresholdSettings(wake(0), {} as never) as unknown as El;
    expect(section.all().find((e) => e.tagName === "select")!.disabled).toBe(true);
    const en = JSON.parse(readFileSync(join(app, "src/messages.en.json"), "utf8")) as Record<string, string>;
    const text = views.WAKE_THRESHOLD_TEXT;
    for (const s of [text.title, text.label, text.current, text.note, ...Object.values(text.options), "喚醒設定沒有保存：{0}"]) expect(en[s], s).toBeTruthy();
  });

  it("both settings pages (browser and macOS App) include the section when settings.wake exists", () => {
    const src = readFileSync(join(app, "src/views.ts"), "utf8");
    expect(src.match(/settings\.wake && renderWakeThresholdSettings\(settings\.wake, actions\)/g)).toHaveLength(2);
    expect(readFileSync(join(app, "src/main.ts"), "utf8")).toMatch(/updateWake\(patch\) \{\s+const requestId = userRequest\(\);\s+void api\.updateWake\(patch\)/);
  });
});
