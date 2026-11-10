// 設定畫面（src/views.ts renderSettings）：macOS App 內（有 window.nousDesktop）只畫帳號與登入，
// 瀏覽器版畫完整設定畫面。測試環境沒有 DOM，用最小的假 document（只實作 views 用到的 createElement、
// setAttribute、append、addEventListener 與文字；DOMPurify 換成替身）。
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/types.ts";
import { describeMenuPrefs } from "../shared/menu-prefs.ts";
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
    codexLogin: vi.fn(), codexCancel: vi.fn(), codexLogout: vi.fn(), openHistory: vi.fn(),
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
    expect(r.el.all().filter((e) => e.getAttribute("aria-pressed") !== null)).toHaveLength(5);
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

// 聲音輸入／輸出（George 2026-11-01）：瀏覽器版與 App 內的設定頁都有兩個下拉選單、使用中的裝置與兩句提示。
describe("renderSettings: 聲音 (input / output devices)", () => {
  const audio = { prefs: { input_device_id: null, input_label: null, output_device_id: "spk-bt", output_label: "JBL Flip", processing_cue: true }, write_path: "/api/settings/audio" as const };
  const report = {
    inputs: [{ id: "mic-mac", label: "MacBook Pro 麥克風" }, { id: "mic-usb", label: "" }],
    outputs: [{ id: "spk-mac", label: "MacBook Pro 揚聲器" }],
    default_input: "MacBook Pro 麥克風", default_output: "MacBook Pro 揚聲器",
    input_in_use: { id: null, label: "MacBook Pro 麥克風" }, output_in_use: { id: null, label: "MacBook Pro 揚聲器" },
    input_fallback: false, output_fallback: true, labels: true,
  };
  const renderAudio = (desktop: boolean, a: ReturnType<typeof actions> & { updateAudio?: (patch: unknown) => void } = actions()) => {
    const el = views.renderSettings(view({ audio }), null, a, { desktop, audio: report }) as unknown as FakeElement;
    const section = el.all().find((e) => e.tagName === "section" && e.all().some((h) => h.tagName === "h3" && h.textContent === "聲音"))!;
    const selects = section.all().filter((e) => e.tagName === "select") as (FakeElement & { value?: string })[];
    return { el, section, selects, text: section.textContent };
  };

  it.each([false, true])("desktop=%s: two selects with the system default first, in-use lines and both hints", (desktop) => {
    const r = renderAudio(desktop);
    expect(r.selects.map((s) => s.getAttribute("aria-label"))).toEqual(["聲音輸入", "聲音輸出"]);
    const options = (s: FakeElement) => s.all().filter((e) => e.tagName === "option").map((o) => [o.getAttribute("value"), o.textContent, o.getAttribute("selected") !== null]);
    expect(options(r.selects[0]!)).toEqual([
      ["", "系統預設（目前：MacBook Pro 麥克風）", true],
      ["mic-mac", "MacBook Pro 麥克風", false],
      ["mic-usb", "未命名的麥克風 2", false],
    ]);
    // 選定的藍牙喇叭不在清單裡：仍列出來並選著，狀態照實說暫用系統預設
    expect(options(r.selects[1]!)).toEqual([
      ["", "系統預設（目前：MacBook Pro 揚聲器）", false],
      ["spk-mac", "MacBook Pro 揚聲器", false],
      ["spk-bt", "JBL Flip（目前找不到）", true],
    ]);
    expect(r.text).toContain("使用中：MacBook Pro 麥克風");
    expect(r.text).toContain("找不到「JBL Flip」，暫用系統預設");
    expect(r.text).toContain("藍牙耳機當麥克風會切到低音質通話模式；建議麥克風留在 Mac、聲音輸出選藍牙喇叭");
    expect(r.text).toContain("按下說話與系統朗讀（語音模式、校準陌生聲音）一律用 Mac 的系統輸入／輸出");
  });

  it("choosing a device sends its id and name; choosing the system default sends null for both", () => {
    const updateAudio = vi.fn();
    const r = renderAudio(true, { ...actions(), updateAudio });
    const change = (select: FakeElement & { value?: string }, value: string) => {
      select.value = value;
      for (const fn of select.listeners.get("change") ?? []) fn();
    };
    change(r.selects[0]!, "mic-mac");
    change(r.selects[1]!, "");
    change(r.selects[0]!, ""); // 已經是系統預設：不送
    expect(updateAudio.mock.calls).toEqual([
      [{ input_device_id: "mic-mac", input_label: "MacBook Pro 麥克風" }],
      [{ output_device_id: null, output_label: null }],
    ]);
  });

  it("「處理中音效」 row (George 2026-11-02): an on/off button with the note; clicking writes the opposite; English", async () => {
    const updateAudio = vi.fn();
    const r = renderAudio(true, { ...actions(), updateAudio });
    expect(r.text).toContain("處理中音效");
    expect(r.text).toContain("背景任務執行中輕聲提示；Nous 說話或你開口時暫停");
    const toggle = r.section.all().find((e) => e.tagName === "button" && e.getAttribute("aria-label") === "處理中音效：開")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    for (const fn of toggle.listeners.get("click") ?? []) fn();
    expect(updateAudio.mock.calls).toEqual([[{ processing_cue: false }]]);
    const off = views.renderSettings(view({ audio: { ...audio, prefs: { ...audio.prefs, processing_cue: false } } }), null, { ...actions(), updateAudio }, { desktop: false, audio: report }) as unknown as FakeElement;
    const offButton = off.all().find((e) => e.tagName === "button" && e.getAttribute("aria-label") === "處理中音效：關")!;
    expect(offButton.getAttribute("aria-pressed")).toBe("false");
    for (const fn of offButton.listeners.get("click") ?? []) fn();
    expect(updateAudio.mock.calls.at(-1)).toEqual([{ processing_cue: true }]);
    const { setLocale } = await import("../src/i18n.ts");
    setLocale("en");
    try {
      const en = views.renderSettings(view({ audio }), null, actions(), { desktop: true, audio: report }) as unknown as FakeElement;
      expect(en.textContent).toContain("Processing sound");
      expect(en.textContent).toContain("A soft cue while a background task is running; pauses while Nous speaks or you talk");
      expect(en.all().some((e) => e.tagName === "button" && e.getAttribute("aria-label") === "Processing sound: On")).toBe(true);
    } finally {
      setLocale("zh-TW");
    }
  });

  it("before microphone permission it says names appear after allowing the microphone; English keeps device names", async () => {
    const { setLocale } = await import("../src/i18n.ts");
    const el = views.renderSettings(view({ audio }), null, actions(), { desktop: true, audio: { ...report, labels: false } }) as unknown as FakeElement;
    expect(el.textContent).toContain("授權麥克風後才會列出裝置名稱");
    setLocale("en");
    try {
      const en = views.renderSettings(view({ audio }), null, actions(), { desktop: true, audio: report }) as unknown as FakeElement;
      expect(en.textContent).toContain("In use: MacBook Pro 麥克風");
      expect(en.textContent).toContain("Can't find “JBL Flip”; using the system default for now");
      expect(en.textContent).toContain("System default (now: MacBook Pro 揚聲器)");
      expect(en.textContent).not.toContain("藍牙");
    } finally {
      setLocale("zh-TW");
    }
  });
});

describe("renderSettings: 聲音 before the device list is read", () => {
  it("shows the chosen device as 尚未回報 (not 找不到) and in English as not reported yet", async () => {
    const audio = { prefs: { input_device_id: "mic-usb", input_label: "USB Mic", output_device_id: null, output_label: null, processing_cue: true }, write_path: "/api/settings/audio" as const };
    const empty = { inputs: [], outputs: [], default_input: null, default_output: null, input_in_use: null, output_in_use: null, input_fallback: false, output_fallback: false, labels: false };
    const options = (el: FakeElement) => el.all().filter((e) => e.tagName === "option").map((o) => o.textContent);
    const el = views.renderSettings(view({ audio }), null, actions(), { desktop: true, audio: empty }) as unknown as FakeElement;
    expect(options(el)).toContain("USB Mic（尚未回報）");
    expect(options(el).some((o) => o.includes("找不到"))).toBe(false);
    const { setLocale } = await import("../src/i18n.ts");
    setLocale("en");
    try {
      const en = views.renderSettings(view({ audio }), null, actions(), { desktop: true, audio: empty }) as unknown as FakeElement;
      expect(options(en)).toContain("USB Mic (not reported yet)");
    } finally {
      setLocale("zh-TW");
    }
  });
});

describe("renderSettings: 左上角家中狀態 (HOME-1)", () => {
  const homeCorner = { enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/home-corner" as const };

  it.each([false, true])("desktop=%s: one switch per page that saves the opposite value; absent when the core does not send it", async (desktop) => {
    const a = { ...actions(), updateHomeCorner: vi.fn() };
    const r = render(view({ home_corner: homeCorner }), desktop, a);
    expect(r.headings).toContain("左上角家中狀態");
    const section = r.el.all().find((e) => e.getAttribute("class")?.includes("home-corner-settings"))!;
    const toggles = section.all().filter((e) => e.tagName === "button");
    expect(toggles.map((b) => b.getAttribute("aria-label"))).toEqual(["Mac 視窗：關", "Pi 終端機：開"]);
    toggles[0].click();
    toggles[1].click();
    expect(a.updateHomeCorner.mock.calls).toEqual([[{ main: true }], [{ terminal: false }]]);
    expect(render(view(), desktop).headings).not.toContain("左上角家中狀態");
    const { setLocale } = await import("../src/i18n.ts");
    setLocale("en");
    try {
      const en = render(view({ home_corner: homeCorner }), desktop);
      expect(en.headings).toContain("Home status corner");
      expect(en.text).toContain("Shows only what the Wuling home controller reports");
    } finally {
      setLocale("zh-TW");
    }
  });
});
