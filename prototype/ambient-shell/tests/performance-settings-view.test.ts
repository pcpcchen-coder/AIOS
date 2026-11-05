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
    codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory: noop, setPerformance: vi.fn(),
  };
}

function section(desktop: boolean, a = actions(), stats: { fps: number; drawMs: number } | null = null) {
  const root = views.renderSettings(settings, null, a, { desktop, performance: { profile: "balanced", stats } }) as unknown as El;
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
    expect(radios[1].textContent).toContain("最多每秒 20 格、標準解析度");
    expect(el!.textContent).toContain("只調整畫面，不影響對話的收音、播放與回應速度。");
    expect(el!.textContent).toContain("實測：—");
  });

  it("renders in English, including the measured readout", () => {
    setLocale("en");
    const { el, radios } = section(desktop, actions(), { fps: 19.6, drawMs: 4.21 });
    expect(el!.all().find((e) => e.tagName === "h3")?.textContent).toBe("Display performance on this device");
    expect(radios.map((r) => r.all().find((e) => e.tagName === "strong")?.textContent)).toEqual(["Full", "Balanced", "Light"]);
    expect(el!.textContent).toContain("Only the display changes; listening, playback and response speed are not affected.");
    expect(el!.textContent).toContain("Measured: 20 frames per second, 4.2 ms to draw each frame");
    expect(el!.textContent).not.toMatch(/\p{Script=Han}/u);
  });

  it("clicking a choice calls setPerformance with that profile", () => {
    const { radios, actions: a } = section(desktop);
    radios[2].click();
    radios[0].click();
    expect(a.setPerformance.mock.calls).toEqual([["light"], ["full"]]);
  });
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
  expect(el!.textContent).toContain("實測：每秒 12 格，每格繪製 12.0 毫秒");
  views.refreshPerformanceReadout(root as unknown as ParentNode, null);
  expect(el!.textContent).toContain("實測：—");
});

it("every new performance string has an English catalog entry", () => {
  const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
  const sources = [
    PERFORMANCE_TEXT.title, PERFORMANCE_TEXT.group, PERFORMANCE_TEXT.note, PERFORMANCE_TEXT.measured, PERFORMANCE_TEXT.noSample,
    ...Object.values(PERFORMANCE_TEXT.label), ...Object.values(PERFORMANCE_TEXT.detail),
  ];
  for (const source of sources) {
    expect(en[source], source).toBeTruthy();
    expect(en[source]).not.toMatch(/\p{Script=Han}/u);
  }
});
