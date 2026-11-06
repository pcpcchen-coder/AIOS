// MEMO-1：選單列「回憶模式」、設定頁（瀏覽器／Pi 版與 macOS App 版）與英文翻譯。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEMORIES_TEXT as MENU_TEXT, memoriesMenu, settingsMenu } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";
import { DEFAULT_MEMORIES_PREFS, MEMORIES_TEXT, type MemoriesSettingsView } from "../shared/memories.ts";
import type { SettingsView } from "../shared/types.ts";
import { setLocale } from "../src/i18n.ts";
import "../server/localization.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

const view = (over: Partial<MemoriesSettingsView> = {}): MemoriesSettingsView => ({
  prefs: { ...DEFAULT_MEMORIES_PREFS, enabled: true },
  source: { kind: "folder", state: "ok", photos: 12, videos: 3 },
  dwell_options: [5, 8, 12, 20],
  idle_options: [30, 60, 180, 300],
  write_path: "/api/settings/memories",
  ...over,
});
const en = (s: string, ...v: unknown[]) => translate(s, "en", ...v);

describe("menu bar", () => {
  it("the menu text table matches the shared one", () => {
    expect(MENU_TEXT).toEqual(MEMORIES_TEXT);
  });

  it("the section: switch, video sound, dwell, idle, source status; clicks send the patch", () => {
    const patches: unknown[] = [];
    const items = memoriesMenu(view(), { setMemories: (p) => patches.push(p) });
    expect(items.map((i) => i.label)).toEqual([undefined, "回憶模式", "閒置時播放回憶", "影片播放聲音", "每張停留：8 秒", "閒置多久開始：1 分鐘", "照片來源：Mac 上的回憶資料夾，照片 12 張、影片 3 段"]);
    expect(items[5]!.submenu!.map((i) => i.label)).toEqual(["30 秒", "1 分鐘", "3 分鐘", "5 分鐘"]);
    items[2]!.click!();
    items[3]!.click!();
    items[4]!.submenu!.find((i) => i.label === "20 秒")!.click!();
    items[5]!.submenu!.find((i) => i.label === "5 分鐘")!.click!();
    expect(patches).toEqual([{ enabled: false }, { video_sound: true }, { dwell_s: 20 }, { idle_s: 300 }]);
    const full = settingsMenu({ seconds: [], memories: view() } as never, { command: () => {}, setMenuPref: () => {}, setMemories: () => {} });
    expect(full.some((i) => i.label === "回憶模式")).toBe(true);
    expect(settingsMenu({ seconds: [] } as never, { command: () => {}, setMenuPref: () => {} }).some((i) => i.label === "回憶模式")).toBe(false);
  });

  it("when off, the other rows are disabled; source states have their own lines", () => {
    const items = memoriesMenu(view({ prefs: DEFAULT_MEMORIES_PREFS, source: { kind: "folder", state: "empty", photos: 0, videos: 0 } }), {});
    expect(items.slice(3, 6).map((i) => i.enabled)).toEqual([false, false, false]);
    expect(items[6]!.label).toBe("資料夾是空的：把照片放進 Mac 的回憶資料夾");
    expect(memoriesMenu(view({ source: { kind: "folder", state: "missing", photos: 0, videos: 0 } }), {})[6]!.label).toBe("找不到回憶資料夾");
  });

  it("every string has English and the English menu has no CJK", () => {
    for (const source of Object.values(MEMORIES_TEXT)) expect(translate(source, "en"), source).not.toBe(source);
    for (const state of ["ok", "empty", "missing", "failed"] as const) {
      const items = memoriesMenu(view({ source: { kind: "folder", state, photos: 2, videos: 1 } }), { translate: en });
      expect(JSON.stringify(items)).not.toMatch(/\p{Script=Han}/u);
    }
    expect(memoriesMenu(view(), { translate: en })[6]!.label).toBe("Source: the memories folder on the Mac, 12 photos and 3 videos");
  });
});

// ───────────── 設定頁（假 DOM；Pi 頁面沒有 window.nousDesktop，也要能切換與顯示） ─────────────

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
  emit(type: string) { for (const fn of this.listeners.get(type) ?? []) fn(); }
  get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
  set textContent(value: string) { this.children = [value]; }
  all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  querySelectorAll(): El[] { return []; }
}

let views: typeof import("../src/views.ts");
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
  views = await import("../src/views.ts");
});
afterEach(() => setLocale("zh-TW"));
afterAll(() => vi.unstubAllGlobals());

const settings = (memories: MemoriesSettingsView): SettingsView => ({
  schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬模式", available: true, detail: "未呼叫任何模型" }],
  chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
  memories,
});

function actions() {
  const noop = () => {};
  return {
    cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop, selectProvider: noop,
    chatgptLogin: noop, chatgptCancel: noop, chatgptLogout: noop, updateCamera: noop, openCameraPreview: noop, updateVoice: noop, updateRealtime: noop,
    codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory: noop, updateMemories: vi.fn(),
  };
}

function section(desktop: boolean, memories = view(), a = actions()) {
  const root = views.renderSettings(settings(memories), null, a, { desktop }) as unknown as El;
  const el = root.all().find((e) => e.getAttribute("class")?.includes("memories-settings"));
  return { el: el!, actions: a };
}

describe.each([false, true])("settings page section (desktop=%s)", (desktop) => {
  it("renders the toggles, selects and source status; changing them calls updateMemories", () => {
    const { el, actions: a } = section(desktop);
    expect(el.all().find((e) => e.tagName === "h3")?.textContent).toBe("回憶模式");
    const buttons = el.all().filter((e) => e.getAttribute("aria-pressed") !== null);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["閒置時播放回憶：開", "影片播放聲音：關"]);
    buttons[0]!.emit("click");
    buttons[1]!.emit("click");
    const selects = el.all().filter((e) => e.tagName === "select");
    expect(selects.map((s) => s.getAttribute("aria-label"))).toEqual(["每張停留", "閒置多久開始"]);
    selects[1]!.value = "180";
    selects[1]!.emit("change");
    expect(a.updateMemories.mock.calls).toEqual([[{ enabled: false }], [{ video_sound: true }], [{ idle_s: 180 }]]);
    expect(el.textContent).toContain("照片來源：Mac 上的回憶資料夾，照片 12 張、影片 3 段");
  });

  it("English: no CJK left", () => {
    setLocale("en");
    const { el } = section(desktop);
    expect(el.textContent).toContain("Play memories when idle");
    expect(el.textContent).toContain("Source: the memories folder on the Mac, 12 photos and 3 videos");
    expect(el.textContent).not.toMatch(/\p{Script=Han}/u);
    expect(JSON.stringify(el.all().map((e) => [...e.attributes.values()]))).not.toMatch(/\p{Script=Han}/u);
  });
});

it("without settings.memories the section is not drawn", () => {
  const s = settings(view());
  delete s.memories;
  const root = views.renderSettings(s, null, actions(), { desktop: false }) as unknown as El;
  expect(root.textContent).not.toContain("回憶模式");
});
