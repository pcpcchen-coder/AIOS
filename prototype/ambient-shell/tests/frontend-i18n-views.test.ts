import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsView, Task } from "../shared/types.ts";
import { DEFAULT_CAMERA_PREFS } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import { setLocale } from "../src/i18n.ts";
import { classify } from "../src/intent.ts";
import { matchCameraCommand } from "../src/sense/controller.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));
class ElementFixture {
  children: (ElementFixture | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  selected = false;
  checked = false;
  value = "";
  innerHTML = "";
  constructor(readonly tagName: string) {}
  setAttribute(key: string, value: string) { this.attributes.set(key, value); if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value; }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  append(...nodes: (ElementFixture | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (ElementFixture | string)[]) { this.children = nodes; }
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  get textContent(): string { return this.children.map(node => typeof node === "string" ? node : node.textContent).join(""); }
  set textContent(value: string) { this.children = [value]; }
  all(): ElementFixture[] { return this.children.flatMap(node => typeof node === "string" ? [] : [node, ...node.all()]); }
}
let views: typeof import("../src/views.ts");
const originalDocument = globalThis.document;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new ElementFixture(tag), createElementNS: (_ns: string, tag: string) => new ElementFixture(tag) });
  views = await import("../src/views.ts");
});
afterEach(() => setLocale("zh-TW"));
afterAll(() => { vi.unstubAllGlobals(); if (originalDocument) globalThis.document = originalDocument; });
const noop = () => {};
const actions = { cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop, selectProvider: noop, chatgptLogin: noop, chatgptCancel: noop, chatgptLogout: noop, updateCamera: noop, openCameraPreview: noop, updateVoice: noop, updateRealtime: noop, codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory: noop };
const settings: SettingsView = {
  schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬模式", available: true, detail: "未呼叫任何模型" }],
  chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
  camera: { enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS }, voice: DEFAULT_VOICE_PREFS,
};
const task: Task = { schema_version: "proto-0.1", task_id: "task_fixture", request_id: "req_fixture", title: "設定", status: "succeeded", mode: "mock", model: null, plan_ready: true, steps: [{ title: "取消", status: "done", started_at: null, finished_at: null, output_chars: null }], created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z", finished_at: "2026-10-26T00:00:00Z", error: null, artifact_id: "artifact_fixture", retry_of: null };

describe("English and Chinese App/web views", () => {
  it.each(["設定", "小明 秒", "小明 倍"])("preserves family enrollment draft %s and minor state across a language change", async name => {
    setLocale("zh-TW");
    const { FamilyView } = await import("../src/family-view.ts");
    const family = new FamilyView({
      bridge: { identity: async () => ({ ok: true, op: "open_session", session: "ids_fixture", people: [], status: { state: "ready", limited_reason: null, count: 0, max: 8, needs_reenroll: 0, damaged: 0, gallery_version: 1, epoch: 1, models: "ok", backup_exclusion: "excluded", calibrated: false, naming_notice_seen: true } }) },
      source: { sampleFrame: async () => null },
      createWorker: () => { throw new Error("No camera is used in this UI fixture"); },
      model: { detector: "d", recognizer: "r", align: "a", preproc: "p" }, dismiss: () => {},
    });
    family.open();
    await new Promise(resolve => setTimeout(resolve, 0));
    const element = family.element as unknown as ElementFixture;
    const add = element.all().find(el => el.tagName === "button" && el.textContent === "新增家人");
    add?.listeners.get("click")?.forEach(callback => callback());
    const input = element.all().find(el => el.getAttribute("aria-label") === "家人的名稱")!;
    const minor = element.all().find(el => el.tagName === "input" && el.getAttribute("type") === "checkbox")!;
    input.value = name;
    input.listeners.get("input")?.forEach(callback => callback());
    minor.checked = true;
    minor.listeners.get("change")?.forEach(callback => callback());
    setLocale("en");
    expect(element.all().find(el => el.getAttribute("aria-label") === "Family member name")?.value).toBe(name);
    expect(element.all().find(el => el.tagName === "input" && el.getAttribute("type") === "checkbox")?.checked).toBe(true);
    const next = element.all().find(el => el.tagName === "button" && el.textContent === "Next");
    next?.listeners.get("click")?.forEach(callback => callback());
    expect(element.all().find(el => el.tagName === "h3")?.textContent).toBe(`Add family member: ${name}`);
    family.close();
  });

  it.each([false, true])("provides the language control in browser/desktop=%s and switches back", desktop => {
    setLocale("en");
    const english = views.renderSettings(settings, null, actions, { desktop }) as unknown as ElementFixture;
    const selector = english.all().find(el => el.getAttribute("id") === "interface-language");
    expect(selector?.getAttribute("aria-label")).toBe("Interface language");
    expect(selector?.children.map(node => typeof node === "string" ? node : node.textContent)).toEqual(["繁體中文", "English"]);
    expect(english.textContent).toContain(desktop ? "Accounts and sign-in" : "AI engine");
    expect(english.textContent).not.toContain("語音模式閒置多久自動關閉");
    selector!.value = "zh-TW";
    selector!.listeners.get("change")?.forEach(callback => callback());
    const chinese = views.renderSettings(settings, null, actions, { desktop }) as unknown as ElementFixture;
    expect(chinese.textContent).toContain(desktop ? "帳號與登入" : "AI 引擎");
  });

  it("translates task chrome while preserving task and step titles that equal UI keys", () => {
    setLocale("en");
    const progress = views.renderProgress([task], null, actions) as unknown as ElementFixture;
    expect(progress.textContent).toContain("Task progress");
    expect(progress.all().find(el => el.getAttribute("class") === "task-title")?.textContent).toBe("設定");
    expect(progress.all().find(el => el.getAttribute("class") === "step-title")?.textContent).toBe("取消");
    expect(progress.textContent).toContain("Completed");
  });

  it("accepts exact English controls and leaves natural-language tasks and negatives unchanged", () => {
    expect(classify("please show progress")).toEqual({ kind: "progress" });
    expect(classify("open settings")).toEqual({ kind: "settings" });
    expect(classify("turn off voice mode")).toEqual({ kind: "voice_off" });
    expect(classify("use Claude")).toEqual({ kind: "use_provider", provider: "claude" });
    for (const text of ["write a status report", "do not stop task", "show results about the election", "tell me about settings"]) expect(classify(text)).toEqual({ kind: "task", text });
    expect(matchCameraCommand("turn off camera")).toMatchObject({ set: { active: false } });
    expect(matchCameraCommand("show camera preview")).toEqual({ preview: true });
    expect(matchCameraCommand("don't turn off camera")).toBeNull();
    expect(matchCameraCommand("how do I turn off camera?")).toBeNull();
  });
});
