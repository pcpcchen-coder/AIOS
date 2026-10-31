import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNous, type NousHandle } from "../server/nous.ts";
import { setNativeLocale, t } from "../desktop/localization.mjs";
import { sameOrigin } from "../desktop/trusted-sender.mjs";
import type { SettingsView } from "../shared/types.ts";

// App 裡鏡頭只能從主程序打開（同 WK-01a 審查 M2 的常駐喚醒聆聽）：App 以 cameraEnable: "main_process" 啟動核心，
// HTTP 的 active: true 是 403（tests/http.test.ts），打開只由主程序在原生說明之後經同一行程的 NousHandle.camera；
// 頁面只能經 nous:camera-enable 請主程序問使用者。終端機／瀏覽器版（預設 "http"）照舊經 HTTP 打開（使用者 2026-10-31 決定）。

const app = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(app, path), "utf8");

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe("NousHandle.camera (core, same process)", () => {
  let root: string;
  let core: NousHandle | null = null;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nous-camera-enable-"));
  });
  afterEach(async () => {
    await core?.close();
    core = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("setActive(true) persists camera.json and notifies settings.updated; HTTP cannot do the same", async () => {
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_CAMERA: "on", OPENAI_API_KEY: "" },
      cameraEnable: "main_process",
      log: () => {},
    });
    const handle = core;
    const post = (body: unknown) => fetch(`${handle.url}/api/settings/camera`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ active: false })).status).toBe(200);
    expect((await post({ active: true })).status).toBe(403);
    let view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.camera).toMatchObject({ active: false, enable_via: "app" });

    const controller = new AbortController();
    const events = await fetch(`${handle.url}/api/events`, { signal: controller.signal });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
      const [frame, ...rest] = buffer.split("\n\n");
      buffer = rest.join("\n\n");
      return JSON.parse(frame!.replace(/^data: /, ""));
    };
    expect(await next()).toMatchObject({ type: "hello" });

    expect(handle.camera).toBeDefined();
    handle.camera!.setActive(true);
    expect(await next()).toMatchObject({ type: "settings.updated", settings: { camera: { active: true } } });
    controller.abort();
    view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.camera?.active).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "config", "camera.json"), "utf8")).prefs).toEqual({ active: true });
  });
});

describe("NousHandle.camera.isActive (read live from the store)", () => {
  let root: string;
  let core: NousHandle | null = null;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nous-camera-active-"));
  });
  afterEach(async () => {
    await core?.close();
    core = null;
    rmSync(root, { recursive: true, force: true });
  });
  async function boot(camera: "on" | "off"): Promise<NousHandle> {
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: join(root, "dist"),
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_CAMERA: camera, OPENAI_API_KEY: "" },
      cameraEnable: "main_process",
      log: () => {},
    });
    return core;
  }

  // 審查 2026-10-31：刻意釘住目前的行為。NOUS_CAMERA=on 而且沒有 camera.json 時 active 預設為開，第一次啟動就會開鏡頭並給
  // 影像權限、不經原生說明（安裝者在 .env 明確選擇）。George 2026-10-31 決定維持現狀；要改時這個測試要跟著改。
  it("pins the current first-launch default: enabled and no saved camera.json → active (no dialog)", async () => {
    const handle = await boot("on");
    expect(handle.camera!.isActive()).toBe(true);
  });

  it("is false when the camera is not enabled (NOUS_CAMERA off), even with active saved as on", async () => {
    const handle = await boot("off");
    handle.camera!.setActive(true);
    expect(handle.camera!.isActive()).toBe(false);
  });

  it("follows the saved active value immediately when enabled", async () => {
    const handle = await boot("on");
    handle.camera!.setActive(false);
    expect(handle.camera!.isActive()).toBe(false);
    handle.camera!.setActive(true);
    expect(handle.camera!.isActive()).toBe(true);
    // HTTP 關掉也立即反映（權限處理器不靠主程序輪詢的 settings）
    await fetch(`${handle.url}/api/settings/camera`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(handle.camera!.isActive()).toBe(false);
  });
});

describe("desktop main: the media permission gives camera video only while the core's camera is on", () => {
  const main = read("desktop/main.mjs");

  it("the request handler checks mediaTypes for video and asks core.camera.isActive() live; the check handler stays unchanged", () => {
    const start = main.indexOf("session.defaultSession.setPermissionRequestHandler(");
    const handler = main.slice(start, main.indexOf("});", start));
    expect(handler).toMatch(/permission === "media" && allowMedia\(details\.requestingUrl\) && \(!wantsVideo\(details\) \|\| cameraAllowed\(\)\)/);
    const allowed = main.slice(main.indexOf("function cameraAllowed"), main.indexOf("async function setCameraActive"));
    expect(allowed).toMatch(/core\?\.camera\?\.isActive\(\) === true/);
    expect(allowed).not.toMatch(/settings\?\./);
    expect(main).toMatch(/session\.defaultSession\.setPermissionCheckHandler\(\(_wc, permission, origin\) => permission === "media" && allowMedia\(`\$\{origin\}\/`\)\);/);
  });

  it("wantsVideo fails closed: video, unknown or missing media types count as video; audio-only does not", () => {
    const source = main.slice(main.indexOf("function wantsVideo"), main.indexOf("/**", main.indexOf("function wantsVideo")));
    const wantsVideo = new Function(`${source}; return wantsVideo;`)() as (details: unknown) => boolean;
    expect(wantsVideo({ mediaTypes: ["audio"] })).toBe(false);
    expect(wantsVideo({ mediaTypes: ["video"] })).toBe(true);
    expect(wantsVideo({ mediaTypes: ["audio", "video"] })).toBe(true);
    expect(wantsVideo({ mediaTypes: ["screen"] })).toBe(true);
    expect(wantsVideo({ mediaTypes: [] })).toBe(true);
    expect(wantsVideo({})).toBe(true);
    expect(wantsVideo(undefined)).toBe(true);
  });

  it("the only camera getUserMedia in src/ is the sense pipeline, which runs only while the core reports the camera on", () => {
    const callers = ["src/main.ts", "src/sense/pipeline.ts", "src/realtime.ts"].filter((file) => /getUserMedia\([^)]*video|getUserMedia\(constraints/.test(read(file)));
    expect(callers).toEqual(["src/sense/pipeline.ts"]);
    expect(read("src/sense/controller.ts")).toMatch(/return !!camera\?\.enabled && camera\.active && !offPending && !failed;/);
    expect(read("src/main.ts")).toMatch(/if \(cameraShouldRun\(settings\?\.camera, cameraOffPending, cameraFailed\)\) void startCamera\(\);/);
  });
});

describe("review fixes (2026-10-31)", () => {
  const main = read("desktop/main.mjs");
  const page = read("src/main.ts");

  it("media permission compares exact origins (5173 is not 51730); both handlers use the same helper", () => {
    expect(sameOrigin("http://localhost:5173/", "http://localhost:5173")).toBe(true);
    expect(sameOrigin("http://localhost:5173/index.html", "http://localhost:5173")).toBe(true);
    expect(sameOrigin("http://localhost:51730/", "http://localhost:5173")).toBe(false);
    expect(sameOrigin("http://localhost:5173.evil.test/", "http://localhost:5173")).toBe(false);
    expect(sameOrigin("https://localhost:5173/", "http://localhost:5173")).toBe(false);
    expect(sameOrigin("http://127.0.0.1:5173/", "http://localhost:5173")).toBe(false);
    expect(sameOrigin("not a url", "http://localhost:5173")).toBe(false);
    expect(sameOrigin(undefined, "http://localhost:5173")).toBe(false);
    expect(main).toMatch(/const allowMedia = \(url\) => Boolean\(core && sameOrigin\(url, core\.url\)\);/);
    expect(main).not.toMatch(/allowMedia = \(url\) => [^\n]*startsWith/);
    expect(main).toMatch(/setPermissionCheckHandler\(\(_wc, permission, origin\) => permission === "media" && allowMedia\(/);
  });

  it("camera and wake dialogs attach to the window only while it is visible (otherwise app-modal)", () => {
    const helper = main.slice(main.indexOf("function dialogParent"), main.indexOf("}", main.indexOf("function dialogParent")));
    expect(helper).toMatch(/win && !win\.isDestroyed\(\) && win\.isVisible\(\) \? win : undefined/);
    const camera = main.slice(main.indexOf("async function confirmCameraEnable"), main.indexOf("async function setWakeListen"));
    const wake = main.slice(main.indexOf("async function setWakeListen"), main.indexOf("function rebuildMenu"));
    for (const body of [camera, wake]) {
      expect(body).toMatch(/\}, dialogParent\(\)\)\);|, dialogParent\(\)\)\);/);
      expect(body).not.toMatch(/win && !win\.isDestroyed\(\) \? win : undefined/);
    }
  });

  it("an enable requested by the page reports errors to the page only; the menu still gets the native error box", () => {
    const set = main.slice(main.indexOf("async function setCameraActive"), main.indexOf("let cameraEnabling"));
    const confirm = main.slice(main.indexOf("async function confirmCameraEnable"), main.indexOf("async function setWakeListen"));
    expect(set).toMatch(/async function setCameraActive\(value, \{ fromPage = false \} = \{\}\)/);
    expect(set).toMatch(/if \(!result\.ok && result\.reason === "error" && !fromPage\) showError\("鏡頭沒有打開", result\.message\);/);
    expect(confirm).not.toMatch(/showError\(/);
    expect(main).toMatch(/return await setCameraActive\(true, \{ fromPage: true \}\);/);
    // 選單列：setMenuPref 不帶 fromPage
    expect(main).toMatch(/await setCameraActive\(true\);\n\s*return;/);
  });

  it("after a successful enable the main process tells the page, which clears an unsaved local turn-off unless a turn-off is still in flight", () => {
    const confirm = main.slice(main.indexOf("async function confirmCameraEnable"), main.indexOf("async function setWakeListen"));
    expect(confirm.indexOf('notifyPage("camera-enabled")')).toBeGreaterThan(confirm.indexOf("core.camera.setActive(true)"));
    expect(confirm.indexOf('notifyPage("camera-enabled")')).toBeGreaterThan(confirm.lastIndexOf('reason: "error"'));
    const listener = page.slice(page.indexOf('window.addEventListener("nous:command"'), page.indexOf("runDesktopCommand(command"));
    expect(listener).toMatch(/if \(command === "camera-enabled"\) \{\n\s*cameraEnabledByApp\(\);\n\s*return;/);
    const rule = page.slice(page.indexOf("function cameraEnabledByApp"), page.indexOf("// 鏡頭畫面"));
    expect(rule).toMatch(/if \(cameraOffInFlight === 0\) cameraOffPending = false;/);
    const update = page.slice(page.indexOf("async function updateCameraPrefs"), page.indexOf("async function enableCamera"));
    expect(update).toMatch(/cameraOffPending = true;\n\s*cameraOffInFlight\+\+;/);
    expect(update).toMatch(/\} finally \{\n\s*if \(patch\.active === false\) cameraOffInFlight--;/);
    // 核心推送的設定本身不撤銷「關掉但沒保存」（只有核心回報 active=false 時清掉，和以前相同）
    expect(page).toMatch(/if \(value\.camera && !value\.camera\.active\) cameraOffPending = false;/);
  });
});

describe("who starts the core decides the camera mode", () => {
  it("the App starts the core in the strict main_process mode; the terminal/browser server keeps the default (http)", () => {
    const main = read("desktop/main.mjs");
    const start = main.slice(main.indexOf("core = await startNous({"), main.indexOf("});", main.indexOf("core = await startNous({")));
    expect(start).toMatch(/cameraEnable: "main_process",/);
    expect(read("server/index.ts")).not.toMatch(/cameraEnable/);
    expect(read("server/nous.ts")).toMatch(/cameraEnable: options\.cameraEnable \?\? "http",/);
  });
});

describe("desktop main: the camera is turned on only after the native explanation", () => {
  const main = read("desktop/main.mjs");
  const enable = main.slice(main.indexOf("async function setCameraActive"), main.indexOf("async function setWakeListen"));

  it("shows a question dialog (cancel is the default) before core.camera.setActive(true), never HTTP", () => {
    expect(enable.length).toBeGreaterThan(100);
    const dialog = enable.indexOf("showMessage(");
    expect(dialog).toBeGreaterThan(0);
    expect(dialog).toBeLessThan(enable.indexOf("core.camera.setActive(true)"));
    expect(enable).toMatch(/buttons: \["開啟", "取消"\],\s*defaultId: 1,\s*cancelId: 1/);
    expect(enable.indexOf("if (response !== 0)")).toBeLessThan(enable.indexOf("core.camera.setActive(true)"));
    // 開啟的那一條路不經 HTTP；main.mjs 任何地方都不 POST active: true
    const code = main.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/active: true/);
    expect(main).not.toMatch(/\{ \[row\.key\]: true \}/);
  });

  it("the menu's camera switch routes 「打開」 through setCameraActive before any HTTP write", () => {
    const pref = main.slice(main.indexOf("async function setMenuPref"), main.indexOf("async function setCameraActive"));
    expect(pref).toMatch(/row\.write_path === "\/api\/settings\/camera" && row\.key === "active" && value === true/);
    expect(pref.indexOf("await setCameraActive(true)")).toBeLessThan(pref.indexOf("api(row.write_path"));
  });

  it("nous:camera-enable checks the trusted sender first, takes no arguments, and answers only ok/reason/message", () => {
    const start = main.indexOf('ipcMain.handle("nous:camera-enable"');
    expect(start).toBeGreaterThan(0);
    const handler = main.slice(start, main.indexOf("\n});", start));
    expect(handler).toMatch(/ipcMain\.handle\("nous:camera-enable", async \(event\) =>/);
    expect(handler.indexOf("checkTrustedSender(event, win, core.url)")).toBeGreaterThan(0);
    expect(handler.indexOf("checkTrustedSender(event, win, core.url)")).toBeLessThan(handler.indexOf("setCameraActive(true, { fromPage: true })"));
    expect(handler).toMatch(/reason: "unavailable"/);
    expect(handler).toMatch(/reason: "error"/);
    expect(enable).toMatch(/reason: "cancelled"/);
  });

  it("the dialog text is fully translated", () => {
    setNativeLocale("en");
    try {
      expect(t("要打開鏡頭嗎？")).toBe("Turn on the camera?");
      const detail = /detail: "([^"]+)"/.exec(enable)![1]!;
      expect(t(detail)).not.toMatch(/\p{Script=Han}/u);
      expect(t("開啟")).toBe("Turn on");
      expect(t("取消")).toBe("Cancel");
      expect(t("鏡頭沒有打開")).not.toMatch(/\p{Script=Han}/u);
    } finally {
      setNativeLocale("zh-TW");
    }
  });
});

describe("preload: cameraEnable carries nothing from the page", () => {
  it("invokes nous:camera-enable without arguments, whatever the page passes", () => {
    const exposed: Record<string, (...args: unknown[]) => unknown> = {};
    const invoke = vi.fn(async () => ({ ok: true }));
    runInNewContext(read("desktop/preload.cjs"), {
      require: () => ({
        contextBridge: { exposeInMainWorld: (_name: string, api: typeof exposed) => Object.assign(exposed, api) },
        ipcRenderer: { invoke, send: vi.fn(), sendSync: vi.fn(() => "zh-TW"), on: vi.fn(), removeListener: vi.fn() },
      }),
      process: { argv: [] },
    });
    expect(typeof exposed.cameraEnable).toBe("function");
    void exposed.cameraEnable!({ active: true, look_to_talk: false }, "extra");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(["nous:camera-enable"]);
  });
});

describe("renderer (static): in App mode the page never POSTs active: true to /api/settings/camera", () => {
  const main = read("src/main.ts");

  it("api.updateCamera is called only in updateCameraPrefs, after the App-mode active: true branch has returned", () => {
    const fn = main.slice(main.indexOf("async function updateCameraPrefs"), main.indexOf("async function enableCamera"));
    expect([...main.matchAll(/api\.updateCamera\(/g)]).toHaveLength(1);
    const branch = fn.indexOf('if (patch.active === true && settings?.camera?.enable_via === "app")');
    expect(branch).toBeGreaterThan(0);
    // 這一支把 active 拿掉，其他鍵另外送，最後交給 enableCamera（IPC）
    expect(fn.slice(branch, fn.indexOf("return enableCamera();"))).toMatch(/const \{ active: _active, \.\.\.rest \} = patch;/);
    expect(fn.indexOf("return enableCamera();")).toBeLessThan(fn.indexOf("api.updateCamera(patch)"));
  });

  it("enableCamera asks the App over IPC and never starts the camera before the core has saved", () => {
    const fn = main.slice(main.indexOf("async function enableCamera"), main.indexOf("/** 語音閒置秒數（設定畫面"));
    expect(fn).toMatch(/desktop\.cameraEnable\(\)/);
    expect(fn).not.toMatch(/api\.updateCamera|fetch\(/);
    expect(fn).toMatch(/已取消開啟鏡頭/);
    // 取消或失敗時直接回訊息，不改 cameraOffPending／cameraFailed，也不 syncCamera
    const failureStart = fn.indexOf("if (!result?.ok)");
    const success = fn.indexOf("cameraEnabledByApp();");
    expect(failureStart).toBeGreaterThan(0);
    expect(success).toBeGreaterThan(failureStart);
    expect(fn.slice(failureStart, success)).not.toMatch(/syncCamera|cameraFailed|cameraOffPending/);
    // 成功後讀核心的設定（applySettings → syncCamera 依核心保存的 active 決定）
    expect(success).toBeLessThan(fn.indexOf("applySettings(await api.getSettings())"));
  });

  it("no source under src/ sends active: true to the camera settings route", () => {
    const api = read("src/api.ts");
    expect(api).toMatch(/updateCamera: \(patch: CameraPrefsPatch\) => call<SettingsView>\("POST", "\/api\/settings\/camera", patch\)/);
    for (const file of ["src/main.ts", "src/api.ts", "src/views.ts"]) {
      const lines = read(file).split("\n").filter((line) => /\/api\/settings\/camera["`]/.test(line) && /active:\s*true/.test(line));
      expect(lines, file).toEqual([]);
    }
  });

  it("new page messages are translated", async () => {
    const { translate } = await import("../shared/i18n.mjs");
    await import("../src/i18n.ts");
    for (const source of ["這個版本的 App 不能從頁面打開鏡頭；請用選單列打開", "已取消開啟鏡頭", "鏡頭不能打開：App 的鏡頭功能不可用", "鏡頭沒有打開", "鏡頭沒有打開：EACCES"]) {
      expect(translate(source, "en"), source).not.toMatch(/\p{Script=Han}/u);
    }
  });
});
