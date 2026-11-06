// MEMO-1／MEMO-2：選單列「回憶模式」、設定頁（瀏覽器／Pi 版與 macOS App 版）與英文翻譯。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEMORIES_TEXT as MENU_TEXT, memoriesMenu, settingsMenu } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";
import { DEFAULT_MEMORIES_PREFS, formatCacheSize, MEMORIES_GOOGLE_PATHS, MEMORIES_GOOGLE_REASON, MEMORIES_TEXT, type MemoriesGoogleView, type MemoriesSettingsView } from "../shared/memories.ts";
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

// ───────────── MEMO-2：Google 相簿（選單列與設定頁；view 是 mock 的設定資料） ─────────────

const googleView = (over: Partial<MemoriesGoogleView> = {}): MemoriesGoogleView => ({
  available: true, unavailable_reason: null, phase: "idle", picker_uri: null, expires_at: null, progress: null, error: null,
  photos: 40, videos: 2, bytes: 350 * 1024 ** 2, cap_bytes: 2 * 1024 ** 3, paths: MEMORIES_GOOGLE_PATHS, ...over,
});
const withGoogle = (g: Partial<MemoriesGoogleView> = {}) => view({ google: googleView(g) });

describe("menu bar: open memories folder", () => {
  it("appears right after the folder status only when the App gives a handler, and clicking calls it", () => {
    let opened = 0;
    const items = memoriesMenu(view(), { openMemoriesFolder: () => void opened++ });
    const at = items.findIndex((i) => i.label === "打開回憶資料夾");
    expect(at).toBeGreaterThan(0);
    expect(items[at - 1]!.enabled).toBe(false);
    items[at]!.click!();
    expect(opened).toBe(1);
    expect(memoriesMenu(view(), {}).some((i) => i.label === "打開回憶資料夾")).toBe(false);
    expect(memoriesMenu(view(), { openMemoriesFolder: () => undefined, translate: en }).some((i) => i.label === "Open memories folder")).toBe(true);
    expect(en("無法打開回憶資料夾")).toBe("Could not open the memories folder");
  });
});

describe("menu bar: Google Photos", () => {
  it("cache size reads the same in the menu and the shared formatter; small caches keep one decimal", () => {
    for (const bytes of [0, 480_000, 9.94 * 1024 ** 2, 350 * 1024 ** 2, 1.5 * 1024 ** 3]) {
      const label = memoriesMenu(withGoogle({ bytes }), { memoriesGoogle: () => undefined }).slice(7)[0]!.label;
      expect(label).toContain(`（${formatCacheSize(bytes)} / 2 GB）`);
    }
    expect([480_000, 350 * 1024 ** 2, 1.5 * 1024 ** 3].map(formatCacheSize)).toEqual(["0.5 MB", "350 MB", "1.5 GB"]);
  });

  it("status, pick and clear when idle; cancel only while busy; actions go to memoriesGoogle", () => {
    const calls: string[] = [];
    const items = memoriesMenu(withGoogle(), { memoriesGoogle: (a) => calls.push(a) }).slice(7);
    expect(items.map((i) => [i.label, i.enabled])).toEqual([
      ["Google 相簿：照片 40 張、影片 2 段（350 MB / 2 GB）", false],
      ["從 Google 相簿挑選…", true],
      ["清除 Google 快取…", true],
    ]);
    items[1]!.click!();
    items[2]!.click!();
    const busy = memoriesMenu(withGoogle({ phase: "downloading", progress: { done: 3, total: 10, skipped: 1 } }), { memoriesGoogle: (a) => calls.push(a) }).slice(7);
    expect(busy.map((i) => [i.label, i.enabled])).toEqual([
      ["Google 相簿：照片 40 張、影片 2 段（350 MB / 2 GB）", false],
      ["正在下載 3/10", false],
      ["從 Google 相簿挑選…", false],
      ["取消挑選", true],
      ["清除 Google 快取…", true],
    ]);
    busy[3]!.click!();
    expect(calls).toEqual(["pick", "clear", "cancel"]);
  });

  it("unavailable, failed and empty cache", () => {
    const off = memoriesMenu(withGoogle({ available: false, unavailable_reason: "Mac 上找不到 gog", photos: 0, videos: 0, bytes: 0 }), { memoriesGoogle: () => {} }).slice(7);
    expect(off.map((i) => [i.label, i.enabled])).toEqual([["Google 相簿不可用：Mac 上找不到 gog", false], ["從 Google 相簿挑選…", false], ["清除 Google 快取…", false]]);
    const failed = memoriesMenu(withGoogle({ phase: "failed", error: MEMORIES_GOOGLE_REASON.auth }), { memoriesGoogle: () => {} }).slice(7);
    expect(failed[1]!.label).toBe(MEMORIES_GOOGLE_REASON.auth);
    expect(memoriesMenu(view(), {})).toHaveLength(7);
  });

  it("English has no CJK in any phase", () => {
    for (const s of Object.values(MEMORIES_GOOGLE_REASON)) expect(translate(s, "en"), s).not.toBe(s);
    const phases: Partial<MemoriesGoogleView>[] = [
      {}, { phase: "starting" }, { phase: "waiting_pick", picker_uri: "https://photos.google.com/x", expires_at: 0 }, { phase: "downloading", progress: { done: 1, total: 2, skipped: 0 } },
      { phase: "done", progress: { done: 2, total: 2, skipped: 1 } }, { phase: "cancelled" }, { phase: "failed", error: MEMORIES_GOOGLE_REASON.timeout },
      { available: false, unavailable_reason: MEMORIES_GOOGLE_REASON.noAccount }, { bytes: 1.5 * 1024 ** 3 },
    ];
    for (const g of phases) expect(JSON.stringify(memoriesMenu(withGoogle(g), { translate: en, memoriesGoogle: () => {} }))).not.toMatch(/\p{Script=Han}/u);
    expect(memoriesMenu(withGoogle({ bytes: 1.5 * 1024 ** 3 }), { translate: en })[7]!.label).toBe("Google Photos: 40 photos and 2 videos (1.5 GB / 2 GB)");
  });
});

describe.each([false, true])("settings page: Google Photos (desktop=%s)", (desktop) => {
  const google = (g: Partial<MemoriesGoogleView>, a = { ...actions(), memoriesGoogle: vi.fn(), openExternal: vi.fn() }) => {
    const { el } = section(desktop, withGoogle(g), a);
    return { el: el.all().find((e) => e.getAttribute("class") === "memories-google")!, actions: a };
  };
  const buttons = (el: El) => el.all().filter((e) => e.tagName === "button");

  it("idle: status, pick and clear (clear needs a second click), the two explanations", () => {
    const { el, actions: a } = google({});
    expect(el.textContent).toContain("Google 相簿：照片 40 張、影片 2 段（350 MB / 2 GB）");
    expect(el.textContent).toContain("不能自動同步整本相簿");
    expect(el.textContent).toContain("沒有地點，只顯示時間");
    const [pick, clear] = buttons(el);
    expect([pick!.textContent, clear!.textContent]).toEqual(["從 Google 相簿挑選…", "清除 Google 快取"]);
    pick!.emit("click");
    clear!.emit("click");
    expect(clear!.textContent).toBe("再按一次確認清除");
    expect(a.memoriesGoogle.mock.calls).toEqual([["pick"]]);
    clear!.emit("click");
    expect(a.memoriesGoogle.mock.calls).toEqual([["pick"], ["clear"]]);
  });

  it("waiting: QR image from the core, the URL as text, hint, expiry, cancel; open-in-browser only on the Mac", () => {
    const uri = "https://photos.google.com/picker/mock";
    const { el, actions: a } = google({ phase: "waiting_pick", picker_uri: uri, expires_at: new Date(2026, 10, 6, 14, 5).getTime() });
    const img = el.all().find((e) => e.tagName === "img")!;
    expect(img.getAttribute("src")).toBe("/api/memories/google/qr.svg");
    expect(img.getAttribute("alt")).toBe("Google 相簿挑選連結的 QR code");
    expect(el.all().find((e) => e.tagName === "code")!.textContent).toBe(uri);
    expect(el.textContent).toContain("用手機掃描");
    expect(el.textContent).toContain("連結在 14:05 前有效");
    const labels = buttons(el).map((b) => b.textContent);
    expect(labels).toEqual(desktop ? ["在瀏覽器開啟", "從 Google 相簿挑選…", "取消", "清除 Google 快取"] : ["從 Google 相簿挑選…", "取消", "清除 Google 快取"]);
    expect(buttons(el).find((b) => b.textContent === "從 Google 相簿挑選…")!.disabled).toBe(true);
    buttons(el).find((b) => b.textContent === "取消")!.emit("click");
    if (desktop) buttons(el)[0]!.emit("click");
    expect(a.memoriesGoogle.mock.calls).toEqual([["cancel"]]);
    expect(a.openExternal.mock.calls).toEqual(desktop ? [[uri]] : []);
  });

  it("progress, error, unavailable; English has no CJK", () => {
    expect(google({ phase: "downloading", progress: { done: 3, total: 9, skipped: 0 } }).el.textContent).toContain("正在下載 3/9");
    expect(google({ phase: "failed", error: MEMORIES_GOOGLE_REASON.timeout }).el.textContent).toContain("挑選逾時");
    const off = google({ available: false, unavailable_reason: MEMORIES_GOOGLE_REASON.noAccount });
    expect(off.el.textContent).toContain("Google 相簿不可用：沒有設定 Google 帳號（NOUS_GOG_ACCOUNT）");
    expect(buttons(off.el)[0]!.disabled).toBe(true);
    setLocale("en");
    for (const g of [{}, { phase: "waiting_pick" as const, picker_uri: "https://photos.google.com/x", expires_at: 0 }, { phase: "failed" as const, error: MEMORIES_GOOGLE_REASON.auth }, { phase: "done" as const, progress: { done: 1, total: 1, skipped: 0 } }]) {
      const { el } = google(g);
      expect(el.textContent).not.toMatch(/\p{Script=Han}/u);
      expect(JSON.stringify(el.all().map((e) => [...e.attributes.values()]))).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
