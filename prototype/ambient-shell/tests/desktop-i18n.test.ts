import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { getNativeLocale, isLocale, languageMenu, localizeDialog, localizeMenu, setNativeLocale, t, trustedLocaleSender } from "../desktop/localization.mjs";
import { settingsMenu } from "../desktop/settings-menu.mjs";
import { describeMenuPrefs } from "../shared/seconds-menu.ts";
import { DEFAULT_CAMERA_PREFS, type CameraSettings } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import type { SettingsView } from "../shared/types.ts";

const camera: CameraSettings = { enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS };
function settings(): SettingsView {
  return {
    schema_version: "proto-0.1", provider: "mock", providers: [],
    chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
    camera, voice: DEFAULT_VOICE_PREFS,
    seconds: describeMenuPrefs({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime: { available: true, model: "fixture", detail: "fixture" } }),
    camera_preview_disabled_reason: null,
  };
}
function texts(items: { label?: string; sublabel?: string; submenu?: unknown[] }[]): string[] {
  return items.flatMap(item => [item.label, item.sublabel, ...(item.submenu ? texts(item.submenu as typeof items) : [])].filter((value): value is string => typeof value === "string"));
}
afterEach(() => setNativeLocale("zh-TW"));

describe("native bilingual UI", () => {
  it("translates core-derived settings, units and hints without changing command values", () => {
    setNativeLocale("en");
    const write = vi.fn();
    const source = settings();
    const menu = settingsMenu(source, { command: vi.fn(), setMenuPref: write, translate: t });
    expect(texts(menu).filter(text => /\p{Script=Han}/u.test(text))).toEqual([]);
    expect(menu.some(item => item.label === "Browser voice idle timeout: 1 min 30 sec")).toBe(true);
    menu.find(item => item.label === "Camera")?.click?.();
    expect(write).toHaveBeenCalledWith(source.seconds?.find(row => row.key === "active"), false);
    const zoom = menu.find(item => item.label === "Maximum brain zoom when nearby: 2×");
    expect(zoom?.submenu?.some(item => item.label === "2× (default)")).toBe(true);
    expect(source.seconds?.find(row => row.key === "active")?.label).toBe("鏡頭");
  });

  it("keeps Chinese defaults and translates nested copy without changing callbacks or ids", () => {
    const click = vi.fn();
    const source = [{ label: "設定與資料", submenu: [{ label: "看進度", click, id: "progress" }] }];
    expect(localizeMenu(source)).toEqual(source);
    setNativeLocale("en");
    expect(localizeMenu(source)[0].submenu?.[0]).toMatchObject({ label: "View progress", id: "progress", click });
    expect(source[0].label).toBe("設定與資料");
    expect(t("ChatGPT 方案（Codex 額度）· fixture-model")).toBe("ChatGPT plan (Codex allowance) · fixture-model");
  });

  it("preserves family names and destructive confirmation defaults", () => {
    setNativeLocale("en");
    const options = { type: "warning", buttons: ["永久刪除", "取消"], defaultId: 1, cancelId: 1, message: "要永久刪除「設定」的家人資料嗎？" };
    const localized = localizeDialog(options);
    expect(localized.message).toBe("Permanently delete family data for “設定”?");
    expect(localized.buttons).toEqual(["Delete permanently", "Cancel"]);
    expect(localized.defaultId).toBe(1);
    expect(localized.cancelId).toBe(1);
    expect(options.message).toBe("要永久刪除「設定」的家人資料嗎？");
  });

  it("offers only the two supported locales", () => {
    const change = vi.fn();
    const menu = languageMenu("en", change);
    expect(menu.label).toBe("語言 / Language");
    expect(menu.submenu.map(item => [item.label, item.checked])).toEqual([["繁體中文", false], ["English", true]]);
    menu.submenu[0].click();
    expect(change).toHaveBeenCalledWith("zh-TW");
    expect(isLocale("en")).toBe(true);
    expect(isLocale("en; do something")).toBe(false);
    setNativeLocale("invalid");
    expect(getNativeLocale()).toBe("zh-TW");
  });

  it("requires the main window, main frame, exact core origin and application page for locale IPC", () => {
    const mainFrame = { url: "http://127.0.0.1:8787/?fixture=1" };
    const webContents = { mainFrame };
    const win = { webContents, isDestroyed: () => false };
    const event = { sender: webContents, senderFrame: mainFrame };
    expect(trustedLocaleSender(event, win, "http://127.0.0.1:8787")).toBe(true);
    for (const url of ["http://127.0.0.1:87870/", "http://127.0.0.1:8787.evil.invalid/", "http://evil.invalid/", "http://127.0.0.1:8787/help/commands", "file:///tmp/index.html"]) {
      mainFrame.url = url;
      expect(trustedLocaleSender(event, win, "http://127.0.0.1:8787"), url).toBe(false);
    }
    mainFrame.url = "http://127.0.0.1:8787/";
    expect(trustedLocaleSender({ ...event, sender: {} }, win, "http://127.0.0.1:8787")).toBe(false);
    expect(trustedLocaleSender({ ...event, senderFrame: { url: mainFrame.url } }, win, "http://127.0.0.1:8787")).toBe(false);
    expect(trustedLocaleSender(event, { ...win, isDestroyed: () => true }, "http://127.0.0.1:8787")).toBe(false);
  });
});

interface Bridge {
  initialLocale: string;
  onLocaleChange(callback: (locale: string) => void): () => void;
  reportState(state: unknown): void;
}
function preload(savedLocale: unknown) {
  let bridge!: Bridge;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ipc = {
    sendSync: vi.fn(() => savedLocale), send: vi.fn(), invoke: vi.fn(),
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => listeners.set(channel, callback)),
    removeListener: vi.fn((channel: string) => listeners.delete(channel)),
  };
  const code = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  runInNewContext(code, {
    require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name: string, exposed: Bridge) => { bridge = exposed; } } }),
    process: { argv: ["electron", "--nous-locale=en"] },
  });
  return { bridge, ipc, listeners };
}

describe("native renderer locale bridge", () => {
  it("uses current stored locale instead of stale launch arguments and whitelists updates", () => {
    const { bridge, ipc, listeners } = preload("zh-TW");
    expect(bridge.initialLocale).toBe("zh-TW");
    expect(ipc.sendSync).toHaveBeenCalledWith("nous:get-locale");
    const changed = vi.fn();
    const unsubscribe = bridge.onLocaleChange(changed);
    listeners.get("nous:locale-changed")?.({}, "en");
    listeners.get("nous:locale-changed")?.({}, "malicious");
    expect(changed.mock.calls).toEqual([["en"]]);
    unsubscribe();
    expect(listeners.has("nous:locale-changed")).toBe(false);
    bridge.reportState({ voice: "off", activeTasks: 2, settings: "fixture", locale: "en", unexpected: "ignored" });
    expect(ipc.send).toHaveBeenLastCalledWith("nous:state", { voice: "off", activeTasks: 2, settings: "fixture", locale: "en" });
    bridge.reportState({ locale: "invalid" });
    expect(ipc.send.mock.calls.at(-1)?.[1]).not.toHaveProperty("locale");
  });
});

describe("native localization packaging", () => {
  it("bundles shared and native catalogs without a source-tree dependency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-native-locale-"));
    try {
      const output = join(dir, "localization.mjs");
      await build({ entryPoints: [fileURLToPath(new URL("../desktop/localization.mjs", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
      const code = `import {setNativeLocale,t} from ${JSON.stringify(pathToFileURL(output).href)}; setNativeLocale('en'); console.log(t('鏡頭與語音設定')); console.log(t('1 分 30 秒（預設）'));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(["Camera and voice settings", "1 min 30 sec (default)"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it.skipIf(process.platform !== "darwin")("provides valid English and Traditional Chinese macOS permission resources", () => {
  for (const language of ["en", "zh-Hant"]) {
    const file = fileURLToPath(new URL(`../desktop/assets/${language}.lproj/InfoPlist.strings`, import.meta.url));
    const result = spawnSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const descriptions = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.keys(descriptions).sort()).toEqual(["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]);
    expect(/\p{Script=Han}/u.test(descriptions.NSMicrophoneUsageDescription)).toBe(language === "zh-Hant");
    expect(/\p{Script=Han}/u.test(descriptions.NSCameraUsageDescription)).toBe(language === "zh-Hant");
    expect(descriptions.NSMicrophoneUsageDescription).toMatch(language === "en" ? /selected voice service until the conversation ends/ : /選用的語音服務，直到對話結束/);
    expect(descriptions.NSMicrophoneUsageDescription).toMatch(language === "en" ? /always-on wake listening, to detect "Hello Nous" on this Mac only; that audio stays in memory and is not saved or uploaded/ : /常駐喚醒聆聽，也只在這台 Mac 本機偵測「哈囉努斯」，偵測時的聲音只留在記憶體、不保存也不上傳/);
    expect(descriptions.NSCameraUsageDescription).toMatch(language === "en" ? /without saving or upload/ : /不保存也不上傳/);
  }
});

// WK-02：NSMicrophoneUsageDescription 說明常駐喚醒聆聽（任何平台都檢查文字；plutil 只在 macOS 上的測試）。
it("the microphone permission text covers always-on wake listening in both languages and matches the packaged Info.plist", () => {
  const strings = (language: string) => {
    const text = readFileSync(new URL(`../desktop/assets/${language}.lproj/InfoPlist.strings`, import.meta.url), "utf8");
    const match = /^"NSMicrophoneUsageDescription" = "((?:[^"\\]|\\.)*)";$/m.exec(text);
    return match![1]!.replace(/\\"/g, '"');
  };
  const en = strings("en");
  const zh = strings("zh-Hant");
  expect(en).toBe('Nous uses the microphone for voice conversations and, if you turn on always-on wake listening, to detect "Hello Nous" on this Mac only; that audio stays in memory and is not saved or uploaded. After the wake word or when you start a conversation, audio is sent to your selected voice service until the conversation ends.');
  expect(zh).toBe("Nous 使用麥克風進行語音對話；若開啟常駐喚醒聆聽，也只在這台 Mac 本機偵測「哈囉努斯」，偵測時的聲音只留在記憶體、不保存也不上傳。喚醒或開始對話後，音訊會傳送至你選用的語音服務，直到對話結束。");
  expect(/\p{Script=Han}/u.test(en)).toBe(false);
  const pkg = readFileSync(new URL("../desktop/scripts/package.mjs", import.meta.url), "utf8");
  expect(pkg).toContain(`NSMicrophoneUsageDescription: '${en}',`);
});
