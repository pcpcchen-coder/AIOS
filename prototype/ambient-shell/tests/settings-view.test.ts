// 設定畫面（src/views.ts renderSettings）：macOS App 內（有 window.nousDesktop）只畫帳號與登入，
// 瀏覽器版畫完整設定畫面。測試環境沒有 DOM，用最小的假 document（只實作 views 用到的 createElement、
// setAttribute、append、addEventListener 與文字；DOMPurify 換成替身）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/types.ts";
import { describeMenuPrefs } from "../shared/seconds-menu.ts";
import { DEFAULT_CAMERA_PREFS } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import type { RealtimeInfo } from "../shared/types.ts";
import { BROWSER_IDENTITY_STATUS } from "../shared/identity.ts";

// DOMPurify 在沒有 window 時沒有 addHook；設定畫面不經過 sanitize（只有成果會），換成不做事的替身。
vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

class FakeElement {
  readonly children: (FakeElement | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  disabled = false;
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get("click") ?? []) fn();
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  /** 深度優先列出所有子元素。 */
  all(): FakeElement[] {
    return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()]));
  }
}

let views: typeof import("../src/views.ts");
const realDocument = (globalThis as { document?: unknown }).document;

beforeAll(async () => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
  };
  views = await import("../src/views.ts");
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = realDocument;
});

const realtime: RealtimeInfo = {
  available: true,
  model: "gpt-live-1-codex",
  detail: "ChatGPT 方案已登入",
  preference: "auto",
  route: "live",
  billing: "chatgpt_plan",
  billing_line: "ChatGPT 方案（Codex 額度）",
  routes: [
    { id: "live", available: true, reason: null, billing_line: "ChatGPT 方案（Codex 額度）", model: "gpt-live-1-codex", voice: "cove", voices: ["cove", "marin"], tools: "上網查詢", detail: "已登入" },
    { id: "api_key", available: false, reason: "no_api_key", billing_line: "OpenAI API key（依用量計費）", model: "gpt-realtime", voice: "marin", voices: [], tools: "上網查詢、MCP", detail: "未設定 OPENAI_API_KEY" },
  ],
  live_account: { signed_in: false, email: null, plan: null, needs_reauth: false, pending: null, last_error: "上次登入逾時" },
  active: null,
} as RealtimeInfo;

function view(patch: Partial<SettingsView> = {}): SettingsView {
  const camera = { enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS };
  return {
    schema_version: "proto-0.1",
    provider: "mock",
    providers: [
      { id: "chatgpt", label: "ChatGPT", available: false, detail: "尚未登入 ChatGPT" },
      { id: "claude", label: "Claude", available: false, detail: "未設定 ANTHROPIC_API_KEY" },
      { id: "mock", label: "模擬", available: true, detail: "固定的示範回覆" },
    ],
    chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: "ChatGPT 登入失敗：使用者取消" },
    realtime,
    camera,
    voice: DEFAULT_VOICE_PREFS,
    seconds: describeMenuPrefs({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime }),
    ...patch,
  };
}

function actions() {
  const noop = () => {};
  return {
    cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop,
    selectProvider: vi.fn(), chatgptLogin: vi.fn(), chatgptCancel: vi.fn(), chatgptLogout: vi.fn(),
    updateCamera: vi.fn(), openCameraPreview: vi.fn(), updateVoice: vi.fn(), updateRealtime: vi.fn(),
    codexLogin: vi.fn(), codexCancel: vi.fn(), codexLogout: vi.fn(),
  };
}

function render(settings: SettingsView, desktop: boolean | undefined, a = actions()) {
  const el = views.renderSettings(settings, "已保存", a, desktop === undefined ? undefined : { desktop }) as unknown as FakeElement;
  const buttons = el.all().filter((e) => e.tagName === "button");
  const headings = el.all().filter((e) => e.tagName === "h2" || e.tagName === "h3").map((e) => e.textContent);
  const button = (label: string) => buttons.find((b) => b.textContent === label);
  return { el, text: el.textContent, buttons: buttons.map((b) => b.textContent), headings, button, actions: a };
}

describe("renderSettings in the browser (no nousDesktop): full settings screen, unchanged", () => {
  it.each([undefined, false])("desktop=%s renders the engine list, realtime routes and voices, voice seconds and camera sections", (desktop) => {
    const r = render(view(), desktop);
    expect(r.headings).toEqual(["AI 引擎", "即時語音", "語音", "鏡頭與手勢"]);
    // 引擎清單：未登入的 ChatGPT 在清單裡給 Continue with ChatGPT；模擬是使用中。
    expect(r.text).toContain("使用中");
    expect(r.buttons).toContain("Continue with ChatGPT");
    expect(r.text).toContain("新交辦的任務會用目前選擇的引擎");
    // 即時語音的路徑與聲音按鈕。
    for (const label of ["cove", "marin"]) expect(r.buttons).toContain(label);
    expect(r.el.all().some((e) => e.getAttribute("aria-label") === "即時語音路徑")).toBe(true);
    // 語音秒數的 −／+ 與鏡頭的開關、顯示鏡頭畫面。
    expect(r.el.all().some((e) => e.getAttribute("aria-label")?.endsWith("減少"))).toBe(true);
    expect(r.el.all().filter((e) => e.getAttribute("aria-pressed") !== null)).toHaveLength(4);
    expect(r.buttons).toContain("顯示鏡頭畫面");
    expect(r.text).toContain("macOS App 在選單列「鏡頭與語音設定」調整");
    expect(r.text).not.toContain(views.DESKTOP_SETTINGS_NOTE);
    // 帳號：message、last_error、Codex 登入照舊。
    expect(r.text).toContain("已保存");
    expect(r.text).toContain("ChatGPT 登入失敗：使用者取消");
    expect(r.buttons).toContain("用 ChatGPT 方案登入（Codex）");
    expect(r.text).toContain("上次登入逾時");
  });
});

/** 最上層子元素：標籤、class，section 加上標題，用來比對順序。 */
function outline(el: FakeElement): string[] {
  return el.children.map((c) => {
    if (typeof c === "string") return `"${c}"`;
    const title = c.tagName === "section" ? c.all().find((e) => e.tagName === "h3")?.textContent : undefined;
    return `${c.tagName}.${c.getAttribute("class") ?? ""}${title ? `「${title}」` : ""}`;
  });
}

describe("renderSettings in the browser: child order is unchanged", () => {
  it("header, message, error, engine list, realtime, engine note, voice, camera, footer", () => {
    expect(outline(render(view(), false).el)).toEqual([
      "header.surface-header",
      "p.notice",
      "p.error-text",
      "ul.provider-list",
      "section.camera-settings「即時語音」",
      "p.muted small",
      "section.camera-settings「語音」",
      "section.camera-settings「鏡頭與手勢」",
      "footer.surface-footer",
    ]);
    const signedIn = view({ provider: "chatgpt", chatgpt: { signed_in: true, email: "g@example.com", plan_usage: true, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null } });
    expect(outline(render(signedIn, false).el)).toEqual([
      "header.surface-header",
      "p.notice",
      "div.welcome",
      "ul.provider-list",
      "div.account",
      "section.camera-settings「即時語音」",
      "p.muted small",
      "section.camera-settings「語音」",
      "section.camera-settings「鏡頭與手勢」",
      "footer.surface-footer",
    ]);
  });

  it("family recognition: one line saying the browser version cannot do it (no buttons); nothing when the core does not report it", () => {
    const r = render(view({ identity: BROWSER_IDENTITY_STATUS }), false);
    expect(r.text).toContain("家人辨識：瀏覽器版不可用（只在 macOS App 提供）");
    expect(outline(r.el).slice(-2)).toEqual(["p.muted small", "footer.surface-footer"]);
    expect(r.buttons.some((b) => b.includes("家人"))).toBe(false);
    expect(render(view(), false).text).not.toContain("家人辨識");
    // App 內的帳號頁不畫這一行（入口在選單列）
    expect(render(view({ identity: BROWSER_IDENTITY_STATUS }), true).text).not.toContain("家人辨識");
  });

  it("pending login still says 「新分頁」 in the browser", () => {
    expect(render(view({ chatgpt: { ...view().chatgpt, pending_login: true } }), false).text).toContain("已在新分頁開啟 ChatGPT 登入");
  });
});

describe("renderSettings in the macOS App (nousDesktop): accounts only", () => {
  it("renders only the account sections and the note that other settings are in the menu bar", () => {
    const r = render(view(), true);
    expect(r.headings).toEqual(["帳號與登入", "ChatGPT（AI 引擎）", "即時語音（ChatGPT 方案（Codex）帳號）"]);
    expect(r.text).toContain(views.DESKTOP_SETTINGS_NOTE);
    // 逐項指出在選單列的哪裡。
    for (const where of ["「AI 引擎」", "「即時語音」", "「鏡頭與語音設定」"]) expect(views.DESKTOP_SETTINGS_NOTE).toContain(where);
    expect(outline(r.el)).toEqual([
      "header.surface-header",
      "p.notice",
      "p.error-text",
      "section.camera-settings「ChatGPT（AI 引擎）」",
      "section.camera-settings「即時語音（ChatGPT 方案（Codex）帳號）」",
      "p.muted small",
      "footer.surface-footer",
    ]);
    expect(r.text).toContain("已保存");
    expect(r.text).toContain("ChatGPT 登入失敗：使用者取消");
    expect(r.text).toContain("目前的引擎：模擬");
  });

  it("does not render what the menu bar already has: engine choice, realtime route and voice buttons, voice seconds, camera and gestures", () => {
    const r = render(view(), true);
    expect(r.buttons).not.toContain("改用");
    expect(r.text).not.toContain("使用中");
    expect(r.text).not.toContain("新交辦的任務會用目前選擇的引擎");
    expect(r.el.all().some((e) => e.getAttribute("role") === "radiogroup")).toBe(false);
    for (const label of ["cove", "marin", "−", "+", "顯示鏡頭畫面"]) expect(r.buttons).not.toContain(label);
    expect(r.el.all().some((e) => e.getAttribute("aria-pressed") !== null)).toBe(false);
    expect(r.headings).not.toContain("語音");
    expect(r.headings).not.toContain("鏡頭與手勢");
    expect(r.text).not.toContain("安裝（.env）");
  });

  it("keeps the realtime status line and the route list as status", () => {
    const r = render(view(), true);
    expect(r.text).toContain("下次開始：ChatGPT 方案（Codex 額度）");
    expect(r.text).toContain("不可用：未設定 OPENAI_API_KEY");
    const active = render(view({ realtime: { ...realtime, active: { session_id: "s1", route: "live", billing_line: "ChatGPT 方案（Codex 額度）" } } }), true);
    expect(active.text).toContain("進行中：ChatGPT 方案（Codex 額度）");
  });

  it("signed out of ChatGPT: a Continue with ChatGPT button (the browser has it in the engine list)", () => {
    const r = render(view(), true);
    r.button("Continue with ChatGPT")!.click();
    expect(r.actions.chatgptLogin).toHaveBeenCalledWith("auto");
  });

  it("signed in: account, re-authorize when plan usage is missing, usage, other account, sign out; welcome when using the plan", () => {
    const signedIn = render(view({ chatgpt: { signed_in: true, email: "g@example.com", plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null } }), true);
    expect(signedIn.text).toContain("ChatGPT 帳號：g@example.com（未授權使用方案額度）");
    expect(signedIn.buttons).toEqual(expect.arrayContaining(["重新授權", "使用其他帳號", "登出 ChatGPT"]));
    expect(signedIn.buttons).not.toContain("Continue with ChatGPT");
    expect(signedIn.el.all().some((e) => e.tagName === "a" && e.textContent === "管理用量")).toBe(true);
    signedIn.button("使用其他帳號")!.click();
    expect(signedIn.actions.chatgptLogin).toHaveBeenCalledWith("new");
    signedIn.button("登出 ChatGPT")!.click();
    expect(signedIn.actions.chatgptLogout).toHaveBeenCalled();

    const welcome = render(view({ provider: "chatgpt", chatgpt: { signed_in: true, email: "g@example.com", plan_usage: true, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null } }), true);
    expect(welcome.text).toContain("你正在使用 ChatGPT 方案");
    expect(welcome.buttons).not.toContain("重新授權");
  });

  it("pending login and needs_reauth keep their own buttons", () => {
    const pending = render(view({ chatgpt: { ...view().chatgpt, pending_login: true } }), true);
    expect(pending.buttons).toContain("取消登入");
    // App 的登入頁由系統瀏覽器打開，不是新分頁。
    expect(pending.text).toContain("已在瀏覽器開啟 ChatGPT 登入");
    expect(pending.text).not.toContain("新分頁");
    expect(pending.buttons).not.toContain("Continue with ChatGPT");
    const reauth = render(view({ chatgpt: { ...view().chatgpt, needs_reauth: true } }), true);
    expect(reauth.buttons).toContain("重新登入 ChatGPT");
    expect(reauth.buttons).not.toContain("Continue with ChatGPT");
  });

  it("Codex account for realtime voice: sign-in buttons, device code, signed-in sign-out, last_error", () => {
    const out = render(view(), true);
    expect(out.buttons).toEqual(expect.arrayContaining(["用 ChatGPT 方案登入（Codex）", "用裝置代碼登入"]));
    expect(out.text).toContain("上次登入逾時");
    out.button("用裝置代碼登入")!.click();
    expect(out.actions.codexLogin).toHaveBeenCalledWith("device");

    const device = render(view({ realtime: { ...realtime, live_account: { ...realtime.live_account!, pending: { method: "device", user_code: "ABCD-1234", verification_url: "https://auth.openai.com/codex/device" } } } }), true);
    expect(device.text).toContain("到 https://auth.openai.com/codex/device 輸入代碼：ABCD-1234");
    expect(device.buttons).toContain("取消登入");

    const signedIn = render(view({ realtime: { ...realtime, live_account: { signed_in: true, email: "g@example.com", plan: "plus", needs_reauth: false, pending: null, last_error: null } } }), true);
    expect(signedIn.text).toContain("即時語音用的 ChatGPT 方案：g@example.com · plus");
    signedIn.button("登出（即時語音）")!.click();
    expect(signedIn.actions.codexLogout).toHaveBeenCalled();
  });

  it("without realtime info the page still renders the ChatGPT account", () => {
    const r = render(view({ realtime: undefined }), true);
    expect(r.headings).toEqual(["帳號與登入", "ChatGPT（AI 引擎）"]);
  });
});
