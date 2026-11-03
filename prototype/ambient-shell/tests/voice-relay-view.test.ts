// VCR-2：設定頁「語音中繼（實驗）」診斷區（src/views.ts renderVoiceRelay）。
// 測試環境沒有 DOM，用最小的假 document；檢視資料是虛構的 fixture（聲音、喇叭、模板都不是從真的 Mac 讀到的）。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../shared/types.ts";
import { summarizeTrials, type RelayTrial, type VoiceRelayTargetView, type VoiceRelayView } from "../shared/voice-relay.ts";
import { setLocale } from "../src/i18n.ts";

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
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  fire(type: string) { this.listeners.get(type)?.forEach((cb) => cb()); }
  get textContent(): string { return this.children.map((node) => (typeof node === "string" ? node : node.textContent)).join(""); }
  all(): El[] { return this.children.flatMap((node) => (typeof node === "string" ? [] : [node, ...node.all()])); }
}

let views: typeof import("../src/views.ts");
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
  views = await import("../src/views.ts");
});
afterEach(() => setLocale("zh-TW"));
afterAll(() => vi.unstubAllGlobals());

const HAN = /\p{Script=Han}/u;
const buttons = (root: El) => root.all().filter((e) => e.tagName === "button");
const byText = (root: El, text: string) => buttons(root).filter((b) => b.textContent === text);

function recorder() {
  const calls: [string, unknown[]][] = [];
  const handler = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => void calls.push([name, args]) });
  return { calls, actions: { voiceRelay: handler } as never };
}

const output = {
  voices: [{ id: "Samantha", locale: "en-US" }, { id: "Alex", locale: "en-US" }, { id: "Meijia", locale: "zh-TW" }],
  devices: [{ id: "91", name: "MacBook Pro Speakers" }, { id: "120", name: "USB Audio Device" }],
  checked_at: 1_793_000_000_000,
  error: null,
};

const trial = (id: string, wake: RelayTrial["wake"], command: RelayTrial["command"]): RelayTrial => ({
  id, targetId: "google_mini_1", templateId: "en_next", templateVersion: 1, voiceProfileId: "mac_samantha_enus_1", at: "2026-11-03T00:00:00Z",
  kind: "positive", wake, command, evidence: "visual", review: "reviewed",
});

const target: VoiceRelayTargetView = {
  id: "google_mini_1",
  locale: "en-US",
  enabled: true,
  output_device_id: "91",
  music_service: "spotify",
  voice_profile_id: "mac_samantha_enus_1",
  profiles: [
    { id: "mac_samantha_enus_1", voice_id: "Samantha", locale: "en-US", rate: 1, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300, selected: true, editable: true, available: true },
    { id: "mac_alex_enus_2", voice_id: "Alex", locale: "en-US", rate: 0.9, gain_db: -3, pause_ms: 900, lead_ms: 300, tail_ms: 300, selected: false, editable: true, available: false },
  ],
  intents: [
    {
      intent_id: "music.next",
      slots: [],
      templates: [
        { template_id: "en_next", version: 1, text: "next song", wake: "Hey Google", status: "approved", selected_default: true, adopted: true, policy_blocked: false },
        { template_id: "en_next_alt", version: 1, text: "skip this song", wake: "Hey Google", status: "candidate", selected_default: false, adopted: false, policy_blocked: false },
      ],
    },
    {
      intent_id: "music.play_genre",
      slots: ["genre"],
      templates: [{ template_id: "en_genre", version: 1, text: "play {genre} music", wake: "Hey Google", status: "approved", selected_default: true, adopted: false, policy_blocked: true }],
    },
  ],
  // 2 次正向：一次有喚醒但命令錯、一次沒喚醒 → 喚醒 1/2、命令 0/1、整體 0/2。
  trials: summarizeTrials([trial("t_1", "WAKE_OK", "WRONG_COMMAND"), trial("t_2", "NO_WAKE", "NO_COMMAND")]),
  devices: [],
};

const view = (targets: VoiceRelayTargetView[], extra: Partial<VoiceRelayView> = {}): VoiceRelayView => ({ mode: "mac", mock: false, restart_required: false, output, targets, ...extra });
const panel = (v: VoiceRelayView | null, extra: Partial<import("../src/views.ts").VoiceRelayPanelState> = {}) => ({ ...views.emptyVoiceRelayPanel(), view: v, ...extra });

describe("voice relay diagnostics: create form", () => {
  it("renders the Google Home Mini form in both languages and submits the chosen values", () => {
    const { calls, actions } = recorder();
    setLocale("zh-TW");
    const zh = views.renderVoiceRelay(panel(view([]), { createLocale: "en-US" }), actions) as unknown as El;
    expect(zh.getAttribute("aria-label")).toBe("語音中繼");
    expect(zh.textContent).toContain("語音中繼（實驗）");
    expect(zh.textContent).toContain("模式：Mac 喇叭實際發聲");
    expect(zh.textContent).toContain("播放成功只代表聲音已送出，不代表音箱照做。");
    expect(zh.textContent).toContain("新增 Google Home Mini");
    expect(zh.textContent).toContain("Spotify 或「不知道」");
    // en-US 只列英文聲音
    const voiceSelect = zh.all().find((e) => e.tagName === "select" && e.getAttribute("aria-label") === "聲音")!;
    expect(voiceSelect.all().map((o) => o.getAttribute("value"))).toEqual(["Samantha", "Alex"]);
    const device = zh.all().find((e) => e.tagName === "select" && e.getAttribute("aria-label") === "喇叭")!;
    device.value = "120";
    voiceSelect.value = "Alex";
    const music = zh.all().find((e) => e.tagName === "select" && e.getAttribute("aria-label") === "音樂服務")!;
    music.value = "apple_music";
    byText(zh, "新增")[0]!.fire("click");
    expect(calls).toContainEqual(["createTarget", [{ locale: "en-US", output_device_id: "120", voice_id: "Alex", music_service: "apple_music" }]]);
    const locale = zh.all().find((e) => e.tagName === "select" && e.getAttribute("aria-label") === "語言")!;
    locale.value = "zh-TW";
    locale.fire("change");
    expect(calls).toContainEqual(["setCreateLocale", ["zh-TW"]]);

    setLocale("en");
    const en = views.renderVoiceRelay(panel(view([], { mode: "fake", mock: true, restart_required: true }), { createLocale: "en-US" }), actions) as unknown as El;
    expect(en.getAttribute("aria-label")).toBe("Voice relay");
    expect(en.textContent).toContain("Mode: simulated; no sound is made");
    expect(en.textContent).toContain("restart Nous");
    expect(en.textContent).toContain("Add Google Home Mini");
    expect(en.textContent).not.toMatch(HAN);
    for (const e of en.all()) for (const v of e.attributes.values()) expect(v).not.toMatch(HAN);
  });

  it("disables the create button when no voice exists for the chosen language", () => {
    const { actions } = recorder();
    const el = views.renderVoiceRelay(panel(view([], { output: { ...output, voices: [] } })), actions) as unknown as El;
    expect(byText(el, "新增")[0]!.disabled).toBe(true);
    expect(el.textContent).toContain("這個語言沒有可用的聲音。");
  });

  it("says the status is unavailable when the core does not reply", () => {
    setLocale("en");
    const el = views.renderVoiceRelay({ ...views.emptyVoiceRelayPanel(), error: true }, recorder().actions) as unknown as El;
    expect(el.textContent).toContain("Could not get the voice relay status");
  });
});

describe("voice relay diagnostics: one target", () => {
  it("shows template status chips and English text without Han characters", () => {
    const { actions } = recorder();
    setLocale("zh-TW");
    const zh = views.renderVoiceRelay(panel(view([target])), actions) as unknown as El;
    for (const chip of ["已採用", "候選", "政策封鎖", "模型使用中", "這台機器沒有這個聲音"]) expect(zh.textContent).toContain(chip);
    setLocale("en");
    const en = views.renderVoiceRelay(panel(view([target])), actions) as unknown as El;
    for (const text of ["Adopted", "Candidate", "Blocked by policy", "Used by the model", "Test wake word", "Test full command", "Adopt this", "Stop using", "Preview text"]) expect(en.textContent).toContain(text);
    expect(en.textContent).not.toMatch(HAN);
    for (const e of en.all()) for (const v of e.attributes.values()) expect(v).not.toMatch(HAN);
  });

  it("calls play, preview, adopt and unadopt with the chosen voice; policy-blocked disables playback", () => {
    const { calls, actions } = recorder();
    const el = views.renderVoiceRelay(panel(view([target]), { chosen: { google_mini_1: "mac_alex_enus_2" } }), actions) as unknown as El;
    const rows = el.all().filter((e) => e.getAttribute("data-template"));
    const row = (id: string) => rows.find((r) => r.getAttribute("data-template") === id)!;
    byText(row("en_next_alt"), "測試整句")[0]!.fire("click");
    byText(row("en_next_alt"), "測試喚醒")[0]!.fire("click");
    byText(row("en_next_alt"), "預覽文字")[0]!.fire("click");
    byText(row("en_next_alt"), "採用這組")[0]!.fire("click");
    byText(row("en_next"), "取消採用")[0]!.fire("click");
    const base = { target_id: "google_mini_1", intent_id: "music.next", template_id: "en_next_alt", voice_profile_id: "mac_alex_enus_2" };
    expect(calls).toEqual([
      ["play", [{ ...base, part: "full" }]],
      ["play", [{ ...base, part: "wake" }]],
      ["preview", [base]],
      ["adopt", [{ target_id: "google_mini_1", intent_id: "music.next", template_id: "en_next_alt", template_version: 1, voice_profile_id: "mac_alex_enus_2" }]],
      ["unadopt", [{ target_id: "google_mini_1", template_id: "en_next", template_version: 1 }]],
    ]);
    const blocked = row("en_genre");
    expect(byText(blocked, "測試整句")[0]!.disabled).toBe(true);
    expect(byText(blocked, "測試喚醒")[0]!.disabled).toBe(true);
    expect(byText(blocked, "採用這組")[0]!.disabled).toBe(true);
    // 預覽不會發聲：被封鎖時仍可看拒絕原因；帶上 genre 參數。
    byText(blocked, "預覽文字")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["preview", [{ target_id: "google_mini_1", intent_id: "music.play_genre", template_id: "en_genre", voice_profile_id: "mac_alex_enus_2", slots: { genre: "pop" } }]]);
    expect(byText(row("en_next_alt"), "測試整句")[0]!.disabled).toBe(false);
  });

  it("disables every button while an action is in flight (no double playback)", () => {
    const el = views.renderVoiceRelay(panel(view([target]), { busy: true }), recorder().actions) as unknown as El;
    for (const label of ["測試整句", "測試喚醒", "採用這組", "儲存聲線", "停用"]) for (const b of byText(el, label)) expect(b.disabled).toBe(true);
  });

  it("chooses a test voice, saves edited profile values and toggles the target", () => {
    const { calls, actions } = recorder();
    const el = views.renderVoiceRelay(panel(view([target])), actions) as unknown as El;
    byText(el, "選為試聽用")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["chooseProfile", ["google_mini_1", "mac_alex_enus_2"]]);
    const rate = el.all().filter((e) => e.getAttribute("aria-label") === "語速")[0]!;
    rate.value = "1.25";
    byText(el, "儲存聲線")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["saveProfile", [{ target_id: "google_mini_1", id: "mac_samantha_enus_1", voice_id: "Samantha", rate: 1.25, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300 }]]);
    byText(el, "新增候選聲線")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["saveProfile", [{ target_id: "google_mini_1", voice_id: "Samantha", rate: 1, gain_db: 0, pause_ms: 800, lead_ms: 300, tail_ms: 300 }]]);
    byText(el, "停用")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["setEnabled", ["google_mini_1", false]]);
  });

  it("shows trial summaries with N/A and 未測試, computed from summarizeTrials", () => {
    const [s] = target.trials;
    expect(views.relayTrialSummaryText(s)).toBe("喚醒 1/2、命令 0/1、整體 0/2");
    expect(views.relayTrialSummaryText(undefined)).toBe("未測試");
    const noWake = summarizeTrials([trial("t_3", "NO_WAKE", "NO_COMMAND")])[0];
    expect(views.relayTrialSummaryText(noWake)).toBe("喚醒 0/1、命令 N/A、整體 0/1");
    const pendingOnly = summarizeTrials([{ ...trial("t_4", "WAKE_OK", "COMMAND_OK"), review: "pending" }])[0];
    expect(views.relayTrialSummaryText(pendingOnly)).toBe("未測試");
    const el = views.renderVoiceRelay(panel(view([target])), recorder().actions) as unknown as El;
    expect(el.textContent).toContain("試驗：喚醒 1/2、命令 0/1、整體 0/2");
    expect(el.textContent).toContain("試驗：未測試");
    setLocale("en");
    expect(views.relayTrialSummaryText(noWake)).toBe("Wake 0/1, command N/A, overall 0/1");
  });
});

describe("voice relay diagnostics: results are never reported as success", () => {
  const played = { target_id: "google_mini_1", intent_id: "music.next" as const, template_id: "en_next_alt", template_version: 1, voice_profile_id: "mac_samantha_enus_1", part: "full" as const, status: "unconfirmed" as const, reason: null };

  it("an unconfirmed full play says sent-but-unconfirmed and offers the trial recorder", () => {
    const { calls, actions } = recorder();
    const el = views.renderVoiceRelay(panel(view([target]), { played, trial: { wake: "WAKE_OK", command: "WRONG_COMMAND", evidence: "human_confirmed" } }), actions) as unknown as El;
    expect(el.textContent).toContain("已發出語音命令，結果未確認");
    for (const status of el.all().filter((e) => e.getAttribute("role") === "status")) expect(status.textContent).not.toMatch(/成功|完成/u);
    byText(el, "沒喚醒")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["setTrial", [{ wake: "NO_WAKE", command: "NO_COMMAND" }]]);
    byText(el, "記錄結果")[0]!.fire("click");
    expect(calls.at(-1)).toEqual(["recordTrial", [{ target_id: "google_mini_1", template_id: "en_next_alt", template_version: 1, voice_profile_id: "mac_samantha_enus_1", kind: "positive", wake: "WAKE_OK", command: "WRONG_COMMAND", evidence: "human_confirmed" }]]);
    setLocale("en");
    const en = views.renderVoiceRelay(panel(view([target]), { played, trial: { wake: null, command: null, evidence: "visual" } }), actions) as unknown as El;
    expect(en.textContent).toContain("Voice command sent; result not confirmed");
    expect(byText(en, "Record result")[0]!.disabled).toBe(true);
    expect(en.textContent).not.toMatch(HAN);
  });

  it("refusals, failures and wake-only plays use fixed sentences without a trial recorder", () => {
    const { actions } = recorder();
    const refused = views.renderVoiceRelay(panel(view([target]), { played: { ...played, status: "refused", reason: "not_reviewed" } }), actions) as unknown as El;
    expect(refused.textContent).toContain("沒有播放：這組說法還沒有採用");
    expect(byText(refused, "記錄結果")).toHaveLength(0);
    const failed = views.renderVoiceRelay(panel(view([target]), { played: { ...played, status: "failed" } }), actions) as unknown as El;
    expect(failed.textContent).toContain("播放失敗，沒有發出聲音");
    const wake = views.renderVoiceRelay(panel(view([target]), { played: { ...played, part: "wake" } }), actions) as unknown as El;
    expect(wake.textContent).toContain("已播出喚醒詞，結果未確認");
    expect(byText(wake, "記錄結果")).toHaveLength(0);
    const preview = views.renderVoiceRelay(panel(view([target]), { preview: { target_id: "google_mini_1", intent_id: "music.play_genre", template_id: "en_genre", result: { kind: "refused", reason: "policy_blocked" } } }), actions) as unknown as El;
    expect(preview.textContent).toContain("不會播放：政策不允許");
    setLocale("en");
    const resolved = views.renderVoiceRelay(panel(view([target]), { preview: { target_id: "google_mini_1", intent_id: "music.next", template_id: "en_next_alt", result: { kind: "resolved", template_id: "en_next_alt", level: "diagnostic", voice_profile_id: "mac_samantha_enus_1", wake: "Hey Google", command: "skip this song", spoken: "Hey Google, skip this song", output_device_id: "91", test_status: "NOT_TESTED" } } }), actions) as unknown as El;
    expect(resolved.textContent).toContain("Will say: Hey Google, skip this song");
    expect(resolved.textContent).not.toMatch(HAN);
  });
});

describe("voice relay diagnostics in the settings page", () => {
  const settings: SettingsView = {
    schema_version: "proto-0.1", provider: "mock", providers: [{ id: "mock", label: "模擬模式", available: true, detail: "未呼叫任何模型" }],
    chatgpt: { signed_in: true, email: null, plan_usage: true, needs_reauth: false, welcome_ack: true, pending_login: false, last_error: null },
  };
  const noop = () => {};
  const base = { cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop, selectProvider: noop, chatgptLogin: noop, chatgptCancel: noop, chatgptLogout: noop, updateCamera: noop, openCameraPreview: noop, updateVoice: noop, updateRealtime: noop, codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory: noop };
  const has = (el: El) => el.all().some((e) => e.getAttribute("aria-label") === "語音中繼");

  it.each([false, true])("is drawn only when settings.voice_relay is true (desktop=%s)", (desktop) => {
    const state = panel(view([target]));
    expect(has(views.renderSettings(settings, null, base, { desktop, voiceRelay: state }) as unknown as El)).toBe(false);
    expect(has(views.renderSettings({ ...settings, voice_relay: false }, null, base, { desktop, voiceRelay: state }) as unknown as El)).toBe(false);
    expect(has(views.renderSettings({ ...settings, voice_relay: true }, null, base, { desktop, voiceRelay: null }) as unknown as El)).toBe(false);
    expect(has(views.renderSettings({ ...settings, voice_relay: true }, null, base, { desktop, voiceRelay: state }) as unknown as El)).toBe(true);
  });
});
