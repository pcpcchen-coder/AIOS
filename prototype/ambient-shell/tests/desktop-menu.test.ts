// macOS App 選單列「鏡頭與語音設定」子選單（desktop/settings-menu.mjs，純函式，不載入 Electron）
// 與選單指令對到頁面動作（src/desktop-command.ts）。Electron 實際畫出的選單沒有在這裡執行。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isWakeReport as menuIsWakeReport, settingsMenu, WAKE_MENU_TEXT, WAKE_REASON_LABEL as MENU_REASON_LABEL, WAKE_STATE_LABEL as MENU_STATE_LABEL, WAKE_STATE_REASONS as MENU_STATE_REASONS, type MenuItemTemplate } from "../desktop/settings-menu.mjs";
import { setNativeLocale, t as nativeT } from "../desktop/localization.mjs";
import { WAKE_COMMANDS } from "../src/audio/controller.ts";
import { WAKE_REASON_LABEL, WAKE_STATE_LABEL, WAKE_STATE_REASONS, WAKE_TEXT, type WakeReport } from "../shared/wake.ts";
import { DESKTOP_COMMANDS, runDesktopCommand } from "../src/desktop-command.ts";
import { CAMERA_DISABLED_REASON, CAMERA_OFF_PREVIEW_REASON, cameraPreviewDisabledReason, describeMenuPrefs, VOICE_UNSAVED_REASON } from "../shared/seconds-menu.ts";
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
  function wakeBuild(listen: boolean, report: WakeReport | null) {
    const command = vi.fn();
    const wakeCommand = vi.fn();
    const setWakeListen = vi.fn();
    const settings = { ...view(enabledCamera), wake: { wake_listen: listen, device_id: null, runtime: "missing" as const } };
    const items = settingsMenu(settings, { command, setMenuPref: vi.fn(), setWakeListen, wakeReport: report, wakeCommand });
    const find = (label: string) => items.find((i) => i.label === label) as MenuItemTemplate;
    return { items, find, command, wakeCommand, setWakeListen };
  }

  it("without settings.wake nothing is added (flag off)", () => {
    const plain = build(view(enabledCamera));
    expect(plain.labels).not.toContain("喚醒詞");
    expect(JSON.stringify(plain.items)).not.toMatch(/喚醒|說話者/);
  });

  it("draws header, device-event status, the switch, pause, and the disabled 「通話中辨認說話者」 row last", () => {
    const { items, find } = wakeBuild(true, { state: "listening_local", reason: null });
    const start = items.findIndex((i) => i.label === "喚醒詞");
    expect(items[start - 1]).toEqual({ type: "separator" });
    expect(items.slice(start).map((i) => i.label)).toEqual(["喚醒詞", "喚醒聆聽：本機聆聽中", "常駐喚醒聆聽", "暫停聆聽（到這次結束）", "通話中辨認說話者"]);
    expect(find("喚醒詞").enabled).toBe(false);
    expect(find("喚醒聆聽：本機聆聽中").enabled).toBe(false);
    expect(find("常駐喚醒聆聽")).toMatchObject({ type: "checkbox", checked: true, enabled: true });
    const speaker = find("通話中辨認說話者");
    expect(speaker).toEqual({ label: "通話中辨認說話者", type: "checkbox", checked: false, enabled: false, sublabel: "SP-02 之後才能使用" });
    expect(speaker.click).toBeUndefined();
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
    for (const key of ["group", "statusPrefix", "listen", "listenNote", "pause", "resume", "speaker", "speakerNote", "notReported"] as const) expect(WAKE_MENU_TEXT[key]).toBe(WAKE_TEXT[key]);
  });

  it("is fully translated in English, keeping 「哈囉努斯」 as is", () => {
    setNativeLocale("en");
    try {
      const settings = { ...view(enabledCamera), wake: { wake_listen: true, device_id: null, runtime: "missing" as const } };
      for (const report of [null, ...Object.entries(WAKE_STATE_REASONS).flatMap(([state, reasons]) => reasons.map((reason) => ({ state, reason }) as WakeReport))]) {
        const items = settingsMenu(settings, { command: vi.fn(), setMenuPref: vi.fn(), wakeReport: report, translate: nativeT });
        const start = items.findIndex((i) => i.label === "Wake word");
        expect(start).toBeGreaterThan(0);
        const texts = items.slice(start).flatMap((i) => [i.label, i.sublabel]).filter((x): x is string => typeof x === "string");
        expect(texts.filter((x) => /\p{Script=Han}/u.test(x.replaceAll("哈囉努斯", "")))).toEqual([]);
      }
      const items = settingsMenu(settings, { command: vi.fn(), setMenuPref: vi.fn(), translate: nativeT });
      expect(items.find((i) => i.label === "Recognise speaker during calls")).toMatchObject({ enabled: false, sublabel: "Available after SP-02" });
      expect(items.find((i) => i.label === "Always-on wake listening")?.sublabel).toBe("Detects “哈囉努斯” only on this Mac");
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
