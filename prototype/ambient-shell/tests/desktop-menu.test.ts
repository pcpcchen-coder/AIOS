// macOS App 選單列「鏡頭與語音設定」子選單（desktop/settings-menu.mjs，純函式，不載入 Electron）
// 與選單指令對到頁面動作（src/desktop-command.ts）。Electron 實際畫出的選單沒有在這裡執行。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WAKE_SILENCE_S as MENU_DEFAULT_SILENCE, isWakeReport as menuIsWakeReport, settingsMenu, WAKE_MENU_TEXT, WAKE_SILENCE_OPTIONS_S as MENU_SILENCE_OPTIONS, WAKE_REASON_LABEL as MENU_REASON_LABEL, WAKE_STATE_LABEL as MENU_STATE_LABEL, WAKE_STATE_REASONS as MENU_STATE_REASONS, type MenuItemTemplate } from "../desktop/settings-menu.mjs";
import { setNativeLocale, t as nativeT } from "../desktop/localization.mjs";
import { WAKE_COMMANDS } from "../src/audio/controller.ts";
import { DEFAULT_WAKE_SILENCE_S, parseWakePatch, WAKE_REASON_LABEL, WAKE_SILENCE_OPTIONS_S, WAKE_STATE_LABEL, WAKE_STATE_REASONS, WAKE_TEXT, type WakeReport } from "../shared/wake.ts";
import { DESKTOP_COMMANDS, runDesktopCommand } from "../src/desktop-command.ts";
import { CAMERA_DISABLED_REASON, CAMERA_OFF_PREVIEW_REASON, cameraPreviewDisabledReason, describeMenuPrefs, VOICE_UNSAVED_REASON } from "../shared/menu-prefs.ts";
import { DEFAULT_CAMERA_PREFS, type CameraSettings } from "../shared/sense.ts";
import type { SettingsView } from "../shared/types.ts";
import { BROWSER_IDENTITY_STATUS, type IdentityStatus } from "../shared/identity.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";

const enabledCamera: CameraSettings = {
  enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS,
};
const realtime = { available: true, model: "gpt-realtime", detail: "OPENAI_API_KEY 已設定" };

/** 核心組 SettingsView 的同一套推導（server/app.ts）。 */
function view(camera: CameraSettings | undefined, voiceWritable = true): SettingsView {
  return {
    schema_version: "proto-0.1",
    provider: "mock",
    providers: [],
    chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
    ...(camera ? { camera } : {}),
    voice: DEFAULT_VOICE_PREFS,
    seconds: describeMenuPrefs({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable, realtime }),
    camera_preview_disabled_reason: cameraPreviewDisabledReason(camera),
  };
}

function build(settings: SettingsView | null) {
  const command = vi.fn();
  const setMenuPref = vi.fn();
  const items = settingsMenu(settings, { command, setMenuPref });
  const labels = items.map((i) => (i.type === "separator" ? "----" : i.label));
  const find = (label: string) => items.find((i) => i.label === label) as MenuItemTemplate;
  return { items, labels, find, command, setMenuPref };
}

describe("settingsMenu（鏡頭與語音設定）", () => {
  it("before the core answers: one disabled 「讀取中…」", () => {
    expect(build(null).items).toEqual([{ label: "讀取中…", enabled: false }]);
  });

  it("CAMERA_PREFS order with checkboxes; 顯示鏡頭畫面 is the last camera item, before the voice header; no 更多設定…", () => {
    const m = build(view(enabledCamera));
    expect(m.labels).toEqual([
      "鏡頭與手勢",
      "鏡頭",
      "看著說話",
      "面向螢幕幾秒後開始對話：1.5 秒",
      "對話結束後暫停：10 秒",
      "看著說話時先打招呼",
      "打招呼時稱呼認出的家人",
      "手掌停止播報",
      "靠近時電子腦放大倍率：2 倍",
      "顯示鏡頭畫面",
      "----",
      "語音",
      "語音模式閒置多久自動關閉：1 分 30 秒",
      "即時語音閒置多久自動結束：2 分鐘",
      "每通即時語音最長多久：20 分鐘",
    ]);
    expect(m.labels.some((l) => l?.includes("更多設定"))).toBe(false);
    for (const label of ["鏡頭", "看著說話", "看著說話時先打招呼", "打招呼時稱呼認出的家人", "手掌停止播報"]) {
      expect(m.items.filter((i) => i.label === label)).toHaveLength(1);
      expect(m.find(label)).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    }
    expect(m.find("顯示鏡頭畫面")).toMatchObject({ enabled: true, sublabel: undefined });
  });

  it("a checkbox writes the opposite of the core's value (not Electron's toggled state)", () => {
    const m = build(view({ ...enabledCamera, stop_gesture: false }));
    expect(m.find("手掌停止播報").checked).toBe(false);
    m.find("手掌停止播報").click!();
    m.find("看著說話").click!();
    expect(m.setMenuPref.mock.calls.map(([row, value]) => [row.key, row.write_path, value])).toEqual([
      ["stop_gesture", "/api/settings/camera", true],
      ["look_to_talk", "/api/settings/camera", false],
    ]);
  });

  it("顯示鏡頭畫面 sends the camera-preview command, which the page routes to openCameraPreview", () => {
    const m = build(view(enabledCamera));
    m.find("顯示鏡頭畫面").click!();
    expect(m.command).toHaveBeenCalledWith("camera-preview");
    const cameraPreview = vi.fn();
    const noop = () => {};
    expect(runDesktopCommand("camera-preview", { voice: noop, progress: noop, settings: noop, type: noop, cameraPreview, family: noop, familyCalibrate: noop, memory: noop, history: noop, vault: noop })).toBe(true);
    expect(cameraPreview).toHaveBeenCalledOnce();
  });

  it("camera not enabled: every camera item is disabled, and the reason is a disabled item under the header (no sublabel needed)", () => {
    for (const camera of [{ ...enabledCamera, enabled: false }, undefined]) {
      const m = build(view(camera));
      expect(m.labels.slice(0, 2)).toEqual(["鏡頭與手勢", CAMERA_DISABLED_REASON]);
      expect(m.items[1]).toEqual({ label: CAMERA_DISABLED_REASON, enabled: false });
      for (const label of ["鏡頭", "看著說話", "看著說話時先打招呼", "打招呼時稱呼認出的家人", "手掌停止播報"]) {
        expect(m.find(label)).toMatchObject({ type: "checkbox", enabled: false, sublabel: CAMERA_DISABLED_REASON });
      }
      const seconds = m.items.find((i) => i.label?.startsWith("面向螢幕幾秒後開始對話"))!;
      expect(seconds.submenu!.filter((o) => o.type === "radio").every((o) => o.enabled === false)).toBe(true);
      expect(m.find("顯示鏡頭畫面")).toMatchObject({ enabled: false, sublabel: CAMERA_DISABLED_REASON });
      // 語音的分段沒有停用原因。
      expect(m.labels.slice(m.labels.indexOf("語音"), m.labels.indexOf("語音") + 2)).toEqual(["語音", "語音模式閒置多久自動關閉：1 分 30 秒"]);
    }
  });

  it("camera switched off by the user: 顯示鏡頭畫面 disabled with 「鏡頭目前關閉」, the switches stay usable and say why they do nothing", () => {
    const m = build(view({ ...enabledCamera, active: false }));
    expect(m.labels[1]).toBe("鏡頭");
    expect(m.find("顯示鏡頭畫面")).toMatchObject({ enabled: false, sublabel: CAMERA_OFF_PREVIEW_REASON });
    expect(CAMERA_OFF_PREVIEW_REASON).toMatch(/^鏡頭目前關閉/);
    expect(m.find("鏡頭")).toMatchObject({ checked: false, enabled: true });
    for (const label of ["看著說話", "看著說話時先打招呼", "打招呼時稱呼認出的家人", "手掌停止播報"]) {
      expect(m.find(label)).toMatchObject({ enabled: true, sublabel: "鏡頭目前關閉，這個開關暫時用不到" });
    }
  });

  it("a voice group that cannot be saved gets its own reason item under its header", () => {
    const m = build(view(enabledCamera, false));
    const at = m.labels.indexOf("語音");
    expect(m.items[at + 1]).toEqual({ label: VOICE_UNSAVED_REASON, enabled: false });
  });

  it("家人辨識… is the last camera item; the click goes through openFamily (which records the click time), never a bare command", () => {
    const ready: IdentityStatus = { available: true, disabled_reason: null, limited_reason: null };
    const settings = { ...view(enabledCamera), identity: ready };
    const command = vi.fn();
    const openFamily = vi.fn();
    const items = settingsMenu(settings, { command, setMenuPref: vi.fn(), openFamily });
    const labels = items.map((i) => (i.type === "separator" ? "----" : i.label));
    expect(labels.slice(labels.indexOf("顯示鏡頭畫面"), labels.indexOf("顯示鏡頭畫面") + 3)).toEqual(["顯示鏡頭畫面", "家人辨識…", "----"]);
    const family = items.find((i) => i.label === "家人辨識…")!;
    expect(family).toMatchObject({ enabled: true, sublabel: undefined });
    family.click!();
    expect(openFamily).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
    // 姓名不會出現在選單：settings.identity 只有 available、disabled_reason、limited_reason。
    expect(JSON.stringify(items)).not.toMatch(/person_id|name/);
    expect(Object.keys(ready).sort()).toEqual(["available", "disabled_reason", "limited_reason"]);
  });

  it("家人辨識… shows the core's reasons: disabled with a gray explanation line (browser, no encryption); limited stays enabled with a sublabel", () => {
    const browser = settingsMenu({ ...view(enabledCamera), identity: BROWSER_IDENTITY_STATUS }, { command: vi.fn(), setMenuPref: vi.fn(), openFamily: vi.fn() });
    expect(browser.find((i) => i.label === "家人辨識…")).toMatchObject({ enabled: false, sublabel: "瀏覽器版不可用（只在 macOS App 提供）" });
    expect(browser.find((i) => i.label === "家人辨識：瀏覽器版不可用（只在 macOS App 提供）")).toEqual({ label: "家人辨識：瀏覽器版不可用（只在 macOS App 提供）", enabled: false });
    const noKey: IdentityStatus = { ...BROWSER_IDENTITY_STATUS, disabled_reason: "此 Mac 無法加密保存（safeStorage 不可用），家人辨識停用" };
    expect(settingsMenu({ ...view(enabledCamera), identity: noKey }, { command: vi.fn(), setMenuPref: vi.fn() }).find((i) => i.label === "家人辨識…")).toMatchObject({ enabled: false, sublabel: noKey.disabled_reason });
    for (const limited_reason of ["辨識模型未安裝（npm run face:setup -- --product）；只能查看與刪除", "鏡頭未啟用或已關閉；只能查看與刪除", "辨識模型雜湊不符，已停用新增與試認；只能查看與刪除"]) {
      const st: IdentityStatus = { available: true, disabled_reason: null, limited_reason };
      const item = settingsMenu({ ...view(enabledCamera), identity: st }, { command: vi.fn(), setMenuPref: vi.fn() }).find((i) => i.label === "家人辨識…");
      expect(item).toMatchObject({ enabled: true, sublabel: limited_reason });
    }
  });

  it("without settings.identity from the core 家人辨識… is not drawn", () => {
    expect(build(view(enabledCamera)).labels).not.toContain("家人辨識…");
  });

  it("without camera_preview_disabled_reason from the core the item is not drawn", () => {
    const settings = view(enabledCamera);
    delete settings.camera_preview_disabled_reason;
    expect(build(settings).labels).not.toContain("顯示鏡頭畫面");
  });
});

describe("runDesktopCommand", () => {
  it("routes each menu command to its page action, ignores unknown ones", () => {
    const calls: string[] = [];
    const handlers = {
      voice: () => calls.push("voice"),
      progress: () => calls.push("progress"),
      settings: () => calls.push("settings"),
      type: () => calls.push("type"),
      cameraPreview: () => calls.push("cameraPreview"),
      family: () => calls.push("family"),
      familyCalibrate: () => calls.push("familyCalibrate"),
      memory: () => calls.push("memory"),
      history: () => calls.push("history"),
      vault: () => calls.push("vault"),
    };
    for (const c of DESKTOP_COMMANDS) expect(runDesktopCommand(c, handlers)).toBe(true);
    expect(runDesktopCommand("more-settings", handlers)).toBe(false);
    expect(calls).toEqual(["voice", "progress", "settings", "type", "cameraPreview", "family", "familyCalibrate", "memory", "history", "vault"]);
  });

  it("every command(...) the Electron main program and the menu template send is one the page knows", () => {
    const sources = ["desktop/main.mjs", "desktop/settings-menu.mjs"].map((p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")).join("\n");
    const sent = [...new Set([...sources.matchAll(/command\("([^"]+)"\)/g)].map((m) => m[1]))].sort();
    expect(sent).toEqual([...DESKTOP_COMMANDS].sort());
  });
});

// WK-01a 常駐喚醒聆聽（George 2026-10-31 D3：「通話中辨認說話者」先放停用的一列）。
describe("settingsMenu: 喚醒詞 section (only when the core sends settings.wake)", () => {
  function wakeBuild(listen: boolean, report: WakeReport | null, silence = 5, voiceTest = false, speaker = false, offset = 0) {
    const command = vi.fn();
    const wakeCommand = vi.fn();
    const setWakeListen = vi.fn();
    const setVoiceNameTest = vi.fn();
    const setMenuPref = vi.fn();
    const settings = { ...view(enabledCamera), wake: { wake_listen: listen, device_id: null, wake_silence_s: silence, voice_name_test: voiceTest, speaker_in_call: speaker, wake_threshold_offset: offset, runtime: "missing" as const } };
    const items = settingsMenu(settings, { command, setMenuPref, setWakeListen, setVoiceNameTest, wakeReport: report, wakeCommand });
    const find = (label: string) => items.find((i) => i.label === label) as MenuItemTemplate;
    return { items, find, command, wakeCommand, setWakeListen, setVoiceNameTest, setMenuPref };
  }

  it("without settings.wake nothing is added (flag off)", () => {
    const plain = build(view(enabledCamera));
    expect(plain.labels).not.toContain("喚醒詞");
    expect(JSON.stringify(plain.items)).not.toMatch(/喚醒|說話者/);
  });

  it("draws header, device-event status, the switch, pause, 「通話中辨認說話者」, then the voice-only naming test switch", () => {
    const { items, find } = wakeBuild(true, { state: "listening_local", reason: null });
    const start = items.findIndex((i) => i.label === "喚醒詞");
    expect(items[start - 1]).toEqual({ type: "separator" });
    expect(items.slice(start).map((i) => i.label)).toEqual(["喚醒詞", "喚醒聆聽：本機聆聽中", "常駐喚醒聆聽", "喚醒後等你開口：5 秒", "喚醒詞門檻：預設（0）", "暫停聆聽（到這次結束）", "通話中辨認說話者", "只憑聲音也叫名字（測試）"]);
    expect(find("喚醒詞").enabled).toBe(false);
    expect(find("喚醒聆聽：本機聆聽中").enabled).toBe(false);
    expect(find("常駐喚醒聆聽")).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    const speaker = find("通話中辨認說話者");
    expect(speaker).toMatchObject({ label: "通話中辨認說話者", type: "checkbox", checked: false, enabled: true, sublabel: "通話中每段話在本機比對聲音；只用來問要不要用你的記憶，換人只記錄" });
  });

  it("「喚醒詞門檻」 (George 2026-11-08) lists the five offsets like the settings page and writes wake_threshold_offset through setMenuPref", async () => {
    const { WAKE_THRESHOLD_OFFSETS: shared } = await import("../shared/wake.ts");
    const { WAKE_THRESHOLD_OFFSETS: menu, WAKE_THRESHOLD_LABEL } = await import("../desktop/settings-menu.mjs");
    expect(menu).toEqual([...shared]);
    // 和設定頁（src/views.ts 的 WAKE_THRESHOLD_TEXT.options）同一組文字；tests/wake-threshold.test.ts 另核對設定頁那一組
    const viewsSrc = (await import("node:fs")).readFileSync(new URL("../src/views.ts", import.meta.url), "utf8");
    for (const label of Object.values(WAKE_THRESHOLD_LABEL)) expect(viewsSrc).toContain(`"${label}"`);
    expect(Object.keys(WAKE_THRESHOLD_LABEL).sort()).toEqual(menu.map(String).sort());
    const off = wakeBuild(false, null, 5, false, false, -0.05);
    const row = off.find("喚醒詞門檻：稍微容易（−0.05）");
    expect(row.sublabel).toBe("數字越小越容易喚醒，也越容易被電視或聊天誤觸；設定頁也能改，所有裝置共用");
    const radios = (row.submenu as MenuItemTemplate[]).filter((i) => i.type === "radio");
    expect(radios.map((i) => [i.label, i.checked])).toEqual([["更容易喚醒（−0.10）", false], ["稍微容易（−0.05）", true], ["預設（0）", false], ["稍微嚴格（+0.05）", false], ["更不容易誤觸（+0.10）", false]]);
    radios[4]!.click!();
    expect(off.setMenuPref).toHaveBeenCalledWith({ key: "wake_threshold_offset", kind: "threshold", label: "喚醒詞門檻", write_path: "/api/settings/wake" }, 0.1);
    // 不在選項裡的值（不該發生）顯示成預設
    expect(wakeBuild(false, null, 5, false, false, 0.3).find("喚醒詞門檻：預設（0）")).toBeTruthy();
  });

  it("「通話中辨認說話者」 (SP-02b) is a plain checkbox written through setMenuPref to /api/settings/wake, without a dialog", () => {
    const off = wakeBuild(true, null);
    off.find("通話中辨認說話者").click!();
    expect(off.setMenuPref).toHaveBeenCalledWith({ key: "speaker_in_call", kind: "bool", label: "通話中辨認說話者", write_path: "/api/settings/wake" }, true);
    const on = wakeBuild(false, null, 5, false, true);
    expect(on.find("通話中辨認說話者").checked).toBe(true);
    on.find("通話中辨認說話者").click!();
    expect(on.setMenuPref).toHaveBeenCalledWith(expect.objectContaining({ key: "speaker_in_call" }), false);
  });

  it("the voice-only naming test switch (SP-02a) shows the core's value and asks the main process for the opposite", () => {
    const off = wakeBuild(true, null);
    expect(off.find("只憑聲音也叫名字（測試）")).toMatchObject({ type: "checkbox", checked: false, enabled: true, sublabel: "喚醒時認不出臉，聲音認出就叫名字；門檻未校準，可能叫錯人" });
    off.find("只憑聲音也叫名字（測試）").click!();
    expect(off.setVoiceNameTest).toHaveBeenCalledWith(true);
    const on = wakeBuild(false, null, 5, true);
    expect(on.find("只憑聲音也叫名字（測試）").checked).toBe(true);
    on.find("只憑聲音也叫名字（測試）").click!();
    expect(on.setVoiceNameTest).toHaveBeenCalledWith(false);
    expect(on.setMenuPref).not.toHaveBeenCalled();
  });

  it("the switch asks the main process to write the opposite of the core's value; pause/resume go to the page without opening the window", () => {
    const on = wakeBuild(true, { state: "listening_local", reason: null });
    on.find("常駐喚醒聆聽").click!();
    expect(on.setWakeListen).toHaveBeenCalledWith(false);
    on.find("暫停聆聽（到這次結束）").click!();
    expect(on.wakeCommand).toHaveBeenCalledWith("wake-pause");
    expect(on.command).not.toHaveBeenCalled();
    const paused = wakeBuild(true, { state: "paused", reason: "user_pause" });
    expect(paused.find("喚醒聆聽：已暫停").sublabel).toBe("暫停到這次結束；App 重開後會自動恢復，要長期停止請關掉開關");
    paused.find("繼續聆聽").click!();
    expect(paused.wakeCommand).toHaveBeenCalledWith("wake-resume");
    const off = wakeBuild(false, null);
    off.find("常駐喚醒聆聽").click!();
    expect(off.setWakeListen).toHaveBeenCalledWith(true);
    expect(off.find("暫停聆聽（到這次結束）").enabled).toBe(false);
    expect(off.find("喚醒聆聽：未開啟")).toBeDefined();
  });

  it("「喚醒後等你開口」 lists every option with the current one checked and writes the picked value to /api/settings/wake", () => {
    const { find, setMenuPref } = wakeBuild(false, null, 10);
    const row = find("喚醒後等你開口：10 秒");
    expect(row.sublabel).toBe("喚醒後這麼久沒聽到聲音就結束這通；Nous 說話時不算");
    const radios = (row.submenu as MenuItemTemplate[]).filter((i) => i.type === "radio");
    expect(radios.map((i) => i.label)).toEqual(["3 秒", "5 秒（預設）", "8 秒", "10 秒", "15 秒", "20 秒"]);
    expect(radios.filter((i) => i.checked).map((i) => i.label)).toEqual(["10 秒"]);
    // 聆聽關著也能先選好
    expect(radios.every((i) => i.enabled)).toBe(true);
    radios[0].click!();
    expect(setMenuPref).toHaveBeenCalledWith(expect.objectContaining({ key: "wake_silence_s", write_path: "/api/settings/wake" }), 3);
    // 每個選項核心都收（不會被 400 拒絕）
    for (const n of MENU_SILENCE_OPTIONS) expect(parseWakePatch({ wake_silence_s: n })).toEqual({ wake_silence_s: n });
  });

  it("before the page reports, the status line does not claim a device state (「尚未回報」, or 「未開啟」 when off)", () => {
    const on = wakeBuild(true, null);
    expect(on.find("喚醒聆聽：尚未回報")).toBeDefined();
    expect(on.items.some((i) => i.label === "喚醒聆聽：準備中")).toBe(false);
    expect(on.find("暫停聆聽（到這次結束）").enabled).toBe(false);
    expect(wakeBuild(false, null).find("喚醒聆聽：未開啟")).toBeDefined();
  });

  it("the status line shows errors honestly and ignores reports outside the allowlist", () => {
    const err = wakeBuild(true, { state: "error", reason: "runtime_missing" });
    expect(err.find("喚醒聆聽：無法使用").sublabel).toBe("喚醒引擎尚未安裝，沒有開啟麥克風");
    expect(err.find("暫停聆聽（到這次結束）").enabled).toBe(false);
    const forged = wakeBuild(true, { state: "listening_local", reason: "sleep" } as unknown as WakeReport);
    expect(forged.items.some((i) => i.label === "喚醒聆聽：本機聆聽中")).toBe(false);
    expect(menuIsWakeReport({ state: "listening_local", reason: null })).toBe(true);
    expect(menuIsWakeReport({ state: "__proto__", reason: null })).toBe(false);
  });

  it("the menu's copies of states, reasons and text match shared/wake.ts", () => {
    expect(MENU_STATE_REASONS).toEqual(WAKE_STATE_REASONS);
    expect(MENU_STATE_LABEL).toEqual(WAKE_STATE_LABEL);
    expect(MENU_REASON_LABEL).toEqual(WAKE_REASON_LABEL);
    for (const key of ["group", "statusPrefix", "listen", "listenNote", "silence", "silenceNote", "pause", "resume", "speaker", "speakerNote", "voiceNameTest", "voiceNameTestNote", "notReported"] as const) expect(WAKE_MENU_TEXT[key]).toBe(WAKE_TEXT[key]);
    expect(MENU_SILENCE_OPTIONS).toEqual([...WAKE_SILENCE_OPTIONS_S]);
    expect(MENU_DEFAULT_SILENCE).toBe(DEFAULT_WAKE_SILENCE_S);
  });

  it("is fully translated in English (the wake word Hello Nous is English already)", () => {
    setNativeLocale("en");
    try {
      const settings = { ...view(enabledCamera), wake: { wake_listen: true, device_id: null, wake_silence_s: 5, voice_name_test: false, speaker_in_call: false, wake_threshold_offset: 0, runtime: "missing" as const } };
      for (const report of [null, ...Object.entries(WAKE_STATE_REASONS).flatMap(([state, reasons]) => reasons.map((reason) => ({ state, reason }) as WakeReport))]) {
        const items = settingsMenu(settings, { command: vi.fn(), setMenuPref: vi.fn(), wakeReport: report, translate: nativeT });
        const start = items.findIndex((i) => i.label === "Wake word");
        expect(start).toBeGreaterThan(0);
        const texts = items.slice(start).flatMap((i) => [i.label, i.sublabel]).filter((x): x is string => typeof x === "string");
        expect(texts.filter((x) => /\p{Script=Han}/u.test(x))).toEqual([]);
      }
      const items = settingsMenu(settings, { command: vi.fn(), setMenuPref: vi.fn(), translate: nativeT });
      expect(items.find((i) => i.label === "Recognise speaker during calls")).toMatchObject({ enabled: true, sublabel: "Each utterance in a call is compared on this Mac; used only to ask whether to use your memory, and a change of speaker is only logged" });
      expect(items.find((i) => i.label === "Always-on wake listening")?.sublabel).toBe("Detects “Hello Nous” or “Hey Nous” only on this Mac");
      for (const text of Object.values(WAKE_TEXT)) expect(nativeT(text), text).not.toBe(text);
    } finally {
      setNativeLocale("zh-TW");
    }
  });

  it("every wake command the main program or the menu sends is one the page handles", () => {
    const sources = ["desktop/main.mjs", "desktop/settings-menu.mjs"].map((p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")).join("\n");
    // "wake-runtime" 是引擎資料夾名稱，不是指令
    const sent = [...new Set([...sources.matchAll(/"(wake-[a-z]+)"/g)].map((m) => m[1]))].filter((c) => c !== "wake-runtime").sort();
    expect(sent).toEqual([...WAKE_COMMANDS].sort());
    // 打開前一定先顯示原生說明；關掉時先叫頁面停止收音再保存
    const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
    const handler = main.slice(main.indexOf("async function setWakeListen"), main.indexOf("function rebuildMenu"));
    expect(handler.indexOf("showMessage(")).toBeGreaterThan(0);
    // 審查 M2：開關只經同一行程的 core.wake（不經 HTTP），頁面腳本無法略過原生說明
    expect(handler.indexOf("showMessage(")).toBeLessThan(handler.indexOf("core.wake.setListen(value)"));
    expect(handler.indexOf('notifyPage("wake-off")')).toBeLessThan(handler.indexOf("core.wake.setListen(value)"));
    expect(handler).toMatch(/defaultId: 1, cancelId: 1/);
    expect(main).not.toMatch(/\/api\/settings\/wake/);
  });
});

// 聲音輸入／輸出（George 2026-11-01）：「聲音」分段。清單與狀態句只來自頁面回報（preload 與 main.mjs 都整理過）。
describe("settings menu: 聲音 (input / output devices)", async () => {
  const menu = await import("../desktop/settings-menu.mjs");
  const shared = await import("../shared/audio-devices.ts");
  const audio = (patch: Partial<import("../shared/audio-devices.ts").AudioPrefs> = {}) => ({ prefs: { ...shared.DEFAULT_AUDIO_PREFS, ...patch }, write_path: "/api/settings/audio" as const });
  const report = (patch: Partial<import("../shared/audio-devices.ts").AudioReport> = {}, prefs = shared.DEFAULT_AUDIO_PREFS) => {
    const base = {
      inputs: [{ id: "mic-mac", label: "MacBook Pro Microphone" }, { id: "mic-usb", label: "USB Mic" }],
      outputs: [{ id: "spk-mac", label: "MacBook Pro Speakers" }, { id: "spk-bt", label: "JBL Flip" }],
      default_input: "MacBook Pro Microphone", default_output: "MacBook Pro Speakers",
      input_in_use: null, output_in_use: null, input_fallback: false, output_fallback: false, labels: true, ...patch,
    };
    return { ...base, input_status: shared.inputStatus(prefs, base), output_status: shared.outputStatus(prefs, base) };
  };
  const section = (items: MenuItemTemplate[]) => items.slice(items.findIndex((i) => i.label === "聲音" || i.label === "Sound") - 1);

  it("uses the same text as shared/audio-devices.ts", () => {
    for (const [key, value] of Object.entries(menu.AUDIO_TEXT)) expect(value, key).toBe((shared.AUDIO_TEXT as Record<string, string>)[key]);
  });

  it("is drawn only when the core provides settings.audio; radio submenus start with the system default (now: X), then devices, then status rows", () => {
    const setAudio = vi.fn();
    expect(settingsMenu(view(enabledCamera), { command: vi.fn(), setMenuPref: vi.fn() }).some((i) => i.label === "聲音")).toBe(false);
    const prefs = shared.DEFAULT_AUDIO_PREFS;
    const items = section(settingsMenu({ ...view(enabledCamera), audio: audio() }, { command: vi.fn(), setMenuPref: vi.fn(), setAudio, audioReport: report({ input_in_use: { id: null, label: "MacBook Pro Microphone" } }, prefs) }));
    expect(items.map((i) => (i.type === "separator" ? "----" : i.label))).toEqual([
      "----", "聲音", "聲音輸入：系統預設", "使用中：MacBook Pro Microphone", "聲音輸出：系統預設", "播放時使用：MacBook Pro Speakers", "處理中音效",
    ]);
    const input = items[2]!.submenu!;
    expect(input.map((i) => [i.label, i.type, i.checked, i.enabled])).toEqual([
      ["系統預設（目前：MacBook Pro Microphone）", "radio", true, true],
      ["MacBook Pro Microphone", "radio", false, true],
      ["USB Mic", "radio", false, true],
      [undefined, "separator", undefined, undefined],
      ["藍牙耳機當麥克風會切到低音質通話模式；建議麥克風留在 Mac、聲音輸出選藍牙喇叭", undefined, undefined, false],
      ["按下說話與系統朗讀（語音模式、校準陌生聲音）一律用 Mac 的系統輸入／輸出", undefined, undefined, false],
    ]);
    input[2]!.click!();
    items[4]!.submenu![2]!.click!();
    items[4]!.submenu![0]!.click!();
    expect(setAudio.mock.calls).toEqual([
      [{ input_device_id: "mic-usb", input_label: "USB Mic" }],
      [{ output_device_id: "spk-bt", output_label: "JBL Flip" }],
      [{ output_device_id: null, output_label: null }],
    ]);
    expect(items.filter((i) => i.enabled === false && i.label !== "聲音").every((i) => !i.click)).toBe(true);
  });

  it("a missing chosen device stays listed (checked, disabled) and the status row says the default is used for now", () => {
    const prefs = { ...shared.DEFAULT_AUDIO_PREFS, output_device_id: "spk-gone", output_label: "Bose SoundLink" };
    const items = section(settingsMenu({ ...view(enabledCamera), audio: audio(prefs) }, { command: vi.fn(), setMenuPref: vi.fn(), setAudio: vi.fn(), audioReport: report({ output_fallback: true }, prefs) }));
    expect(items[4]!.label).toBe("聲音輸出：Bose SoundLink");
    expect(items[4]!.submenu!.find((i) => i.label === "Bose SoundLink（目前找不到）")).toMatchObject({ type: "radio", checked: true, enabled: false });
    expect(items[5]!.label).toBe("找不到「Bose SoundLink」，暫用系統預設");
  });

  it("before a report: only the system default and the saved choice, status 尚未回報; without labels it says to allow the microphone", () => {
    const items = section(settingsMenu({ ...view(enabledCamera), audio: audio({ input_device_id: "mic-usb", input_label: "USB Mic" }) }, { command: vi.fn(), setMenuPref: vi.fn() }));
    expect(items[2]!.submenu!.slice(0, 2).map((i) => [i.label, i.checked])).toEqual([["系統預設", false], ["USB Mic（尚未回報）", true]]);
    expect(items[3]!.label).toBe("尚未回報");
    const noLabels = report({ inputs: [{ id: "mic-1", label: "" }], labels: false, default_input: null });
    const unlabeled = section(settingsMenu({ ...view(enabledCamera), audio: audio() }, { command: vi.fn(), setMenuPref: vi.fn(), audioReport: noLabels }));
    expect(unlabeled[2]!.submenu![1]!.label).toBe("未命名的麥克風 1");
    expect(unlabeled.at(-1)!.label).toBe("授權麥克風後才會列出裝置名稱");
  });

  it("「處理中音效」 is a checkbox showing the core's value (default on) that writes the opposite through setAudio", () => {
    const setAudio = vi.fn();
    const row = (prefs: Partial<typeof shared.DEFAULT_AUDIO_PREFS>) =>
      section(settingsMenu({ ...view(enabledCamera), audio: audio(prefs) }, { command: vi.fn(), setMenuPref: vi.fn(), setAudio, audioReport: report() })).find((i) => i.label === "處理中音效")!;
    const on = row({});
    expect(on).toMatchObject({ type: "checkbox", checked: true, sublabel: "背景任務執行中輕聲提示；Nous 說話或你開口時暫停" });
    on.click!();
    const off = row({ processing_cue: false });
    expect(off.checked).toBe(false);
    off.click!();
    expect(setAudio.mock.calls).toEqual([[{ processing_cue: false }], [{ processing_cue: true }]]);
    // 沒有回報、沒有裝置名稱時也在（「授權麥克風…」仍是最後一列）
    const unlabeled = section(settingsMenu({ ...view(enabledCamera), audio: audio() }, { command: vi.fn(), setMenuPref: vi.fn(), audioReport: report({ labels: false }) }));
    expect(unlabeled.at(-2)!.label).toBe("處理中音效");
  });

  it("English: interface text translated, device names unchanged", () => {
    setNativeLocale("en");
    try {
      const prefs = { ...shared.DEFAULT_AUDIO_PREFS, output_device_id: "spk-bt", output_label: "JBL Flip" };
      const items = section(settingsMenu({ ...view(enabledCamera), audio: audio(prefs) }, { command: vi.fn(), setMenuPref: vi.fn(), translate: nativeT, audioReport: report({ output_in_use: { id: "spk-bt", label: "JBL Flip" }, input_fallback: false }, prefs) }));
      expect(items.map((i) => i.label).filter(Boolean)).toEqual(["Sound", "Sound input: System default", "No microphone is open right now", "Sound output: JBL Flip", "In use: JBL Flip", "Processing sound"]);
      expect(items.at(-1)!.sublabel).toBe("A soft cue while a background task is running; pauses while Nous speaks or you talk");
      expect(items[2]!.submenu![0]!.label).toBe("System default (now: MacBook Pro Microphone)");
      const texts = (list: MenuItemTemplate[]): string[] => list.flatMap((i) => [i.label ?? "", ...(i.submenu ? texts(i.submenu) : [])]);
      expect(texts(items).filter((x) => /\p{Script=Han}/u.test(x))).toEqual([]);
    } finally {
      setNativeLocale("zh-TW");
    }
  });
});
