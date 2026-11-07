// 設定頁「這台裝置的畫面效能」：瀏覽器版與 macOS App 版都畫，中英文都有；點選項呼叫 setPerformance。
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/types.ts";
import { DEFAULT_CAMERA_PREFS } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import { setLocale } from "../src/i18n.ts";
import { PERFORMANCE_TEXT } from "../src/performance.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

class El {
  children: (El | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  disabled = false;
  selected = false;
  value = "";
  constructor(readonly tagName: string) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  append(...nodes: (El | string)[]) { this.children.push(...nodes); }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click() { for (const fn of this.listeners.get("click") ?? []) fn(); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(value: string) { this.children = [value]; }
  all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  querySelectorAll(selector: string): El[] {
    const attribute = /^\[(.+)\]$/.exec(selector)?.[1];
    return attribute ? this.all().filter((e) => e.attributes.has(attribute)) : [];
  }
}

let views: typeof import("../src/views.ts");
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
  views = await import("../src/views.ts");
});
afterEach(() => setLocale("zh-TW"));
afterAll(() => vi.unstubAllGlobals());

const settings: SettingsView = {
  schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬模式", available: true, detail: "未呼叫任何模型" }],
  chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
  camera: { enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS }, voice: DEFAULT_VOICE_PREFS,
};

function actions() {
  const noop = () => {};
  return {
    cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop, selectProvider: noop,
    chatgptLogin: noop, chatgptCancel: noop, chatgptLogout: noop, updateCamera: noop, openCameraPreview: noop, updateVoice: noop, updateRealtime: noop,
    codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory: noop, setPerformance: vi.fn(), setGpuDrawing: vi.fn(),
  };
}

type Renderer = { active: "canvas" | "webgl"; fallback: "unavailable" | "setup-failed" | "context-lost" | null };
function section(desktop: boolean, a = actions(), stats: { fps: number; drawMs: number } | null = null, gpu?: { on: boolean; renderer: Renderer | null }) {
  const performance = { profile: "balanced" as const, stats, ...(gpu ? { gpu: gpu.on, renderer: gpu.renderer } : {}) };
  const root = views.renderSettings(settings, null, a, { desktop, performance }) as unknown as El;
  const el = root.all().find((e) => e.getAttribute("class")?.includes("performance-settings"));
  const radios = el?.all().filter((e) => e.getAttribute("role") === "radio") ?? [];
  return { root, el, radios, actions: a };
}

describe.each([false, true])("settings performance section (desktop=%s)", (desktop) => {
  it("renders in Chinese with three choices, the fixed note and a dash before any sample", () => {
    const { el, radios } = section(desktop);
    expect(el).toBeDefined();
    expect(el!.all().find((e) => e.tagName === "h3")?.textContent).toBe("這台裝置的畫面效能");
    expect(el!.all().find((e) => e.getAttribute("role") === "radiogroup")?.getAttribute("aria-label")).toBe("畫面效能");
    expect(radios.map((r) => r.all().find((e) => e.tagName === "strong")?.textContent)).toEqual(["完整", "平衡", "省電"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios[1].textContent).toContain("最多每秒 20 格、1 倍解析度");
    expect(el!.textContent).toContain("只調整畫面，不改動對話的收音、播放與語音處理。");
    expect(el!.textContent).toContain("實測：—");
  });

  it("renders in English, including the measured readout", () => {
    setLocale("en");
    const { el, radios } = section(desktop, actions(), { fps: 19.6, drawMs: 4.21 });
    expect(el!.all().find((e) => e.tagName === "h3")?.textContent).toBe("Display performance on this device");
    expect(radios.map((r) => r.all().find((e) => e.tagName === "strong")?.textContent)).toEqual(["Full", "Balanced", "Light"]);
    expect(el!.textContent).toContain("Only the display changes; listening, playback and voice processing are not touched.");
    expect(el!.textContent).toContain("Measured: 20 frames per second, 4.2 ms of main-thread drawing per frame (excluding GPU and background blur)");
    expect(el!.textContent).not.toMatch(/\p{Script=Han}/u);
  });

  it("clicking a choice calls setPerformance with that profile", () => {
    const { radios, actions: a } = section(desktop);
    radios[2].click();
    radios[0].click();
    expect(a.setPerformance.mock.calls).toEqual([["light"], ["full"]]);
  });
});

describe.each([false, true])("GPU drawing switch (desktop=%s)", (desktop) => {
  const gpuButton = (el: El) => el.all().find((e) => e.tagName === "button" && e.getAttribute("aria-pressed") !== null)!;
  const renderer = (el: El) => el.all().find((e) => e.attributes.has("data-perf-renderer"))!.textContent;

  it("is drawn off by default (older callers without the field) with the Canvas readout, in Chinese", () => {
    const { el } = section(desktop);
    expect(el!.textContent).toContain("使用 GPU 繪製（WebGL）");
    expect(el!.textContent).toContain("預設關閉。");
    expect(gpuButton(el!).getAttribute("aria-pressed")).toBe("false");
    expect(gpuButton(el!).getAttribute("aria-label")).toBe("使用 GPU 繪製（WebGL）：關");
    expect(renderer(el!)).toBe("目前：一般繪製（Canvas）");
  });

  it.each([
    [true, { active: "webgl", fallback: null }, "目前：WebGL", "Current: WebGL"],
    [true, { active: "canvas", fallback: "unavailable" }, "此裝置沒有硬體 WebGL，已改用一般繪製", "This device has no hardware WebGL; using standard drawing instead"],
    [true, { active: "canvas", fallback: "setup-failed" }, "WebGL 初始化失敗，已改用一般繪製", "WebGL failed to start; using standard drawing instead"],
    [true, { active: "canvas", fallback: "context-lost" }, "WebGL 中斷，這次開啟期間改用一般繪製", "WebGL stopped working; using standard drawing until the page is reopened"],
    [false, { active: "canvas", fallback: null }, "目前：一般繪製（Canvas）", "Current: standard drawing (Canvas)"],
  ] as const)("on=%s shows the honest readout %#", (on, state, zh, en) => {
    const { el } = section(desktop, actions(), null, { on, renderer: state });
    expect(gpuButton(el!).getAttribute("aria-pressed")).toBe(String(on));
    expect(renderer(el!)).toBe(zh);
    setLocale("en");
    const english = section(desktop, actions(), null, { on, renderer: state }).el!;
    expect(renderer(english)).toBe(en);
    expect(english.textContent).toContain("Use GPU drawing (WebGL)");
    expect(gpuButton(english).getAttribute("aria-label")).toBe(`Use GPU drawing (WebGL): ${on ? "On" : "Off"}`);
    expect(english.textContent).not.toMatch(/\p{Script=Han}/u);
  });

  it("clicking the switch asks for the opposite state", () => {
    const a = actions();
    gpuButton(section(desktop, a, null, { on: false, renderer: null }).el!).click();
    gpuButton(section(desktop, a, null, { on: true, renderer: { active: "webgl", fallback: null } }).el!).click();
    expect(a.setGpuDrawing.mock.calls).toEqual([[true], [false]]);
  });
});

it("refreshPerformanceReadout also updates the renderer line when given a status (e.g. after context loss)", () => {
  const { root, el } = section(false, actions(), null, { on: true, renderer: { active: "webgl", fallback: null } });
  const line = () => el!.all().find((e) => e.attributes.has("data-perf-renderer"))!.textContent;
  views.refreshPerformanceReadout(root as unknown as ParentNode, null);
  expect(line()).toBe("目前：WebGL");
  views.refreshPerformanceReadout(root as unknown as ParentNode, null, { active: "canvas", fallback: "context-lost" });
  expect(line()).toBe("WebGL 中斷，這次開啟期間改用一般繪製");
});

it("without the performance option the section is not drawn (existing callers unchanged)", () => {
  for (const desktop of [false, true]) {
    const root = views.renderSettings(settings, null, actions(), { desktop }) as unknown as El;
    expect(root.textContent).not.toContain("這台裝置的畫面效能");
  }
});

it("refreshPerformanceReadout updates only the readout text", () => {
  const { root, el } = section(false);
  views.refreshPerformanceReadout(root as unknown as ParentNode, { fps: 11.9, drawMs: 12.04 });
  expect(el!.textContent).toContain("實測：每秒 12 格，每格主執行緒繪製 12.0 毫秒（不含 GPU 與背景模糊）");
  views.refreshPerformanceReadout(root as unknown as ParentNode, null);
  expect(el!.textContent).toContain("實測：—");
});

it("every new performance string has an English catalog entry", () => {
  const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
  const sources = [
    PERFORMANCE_TEXT.title, PERFORMANCE_TEXT.group, PERFORMANCE_TEXT.note, PERFORMANCE_TEXT.measured, PERFORMANCE_TEXT.noSample,
    ...Object.values(PERFORMANCE_TEXT.label), ...Object.values(PERFORMANCE_TEXT.detail),
    PERFORMANCE_TEXT.gpu, PERFORMANCE_TEXT.gpuNote, ...Object.values(PERFORMANCE_TEXT.renderer),
  ];
  for (const source of sources) {
    expect(en[source], source).toBeTruthy();
    expect(en[source]).not.toMatch(/\p{Script=Han}/u);
  }
});
