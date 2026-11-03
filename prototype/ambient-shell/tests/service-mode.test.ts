// 服務模式（George 2026-11-03）：終端機心跳（核心）、Pi 頁面的心跳送出、App 選單列範本與 preload 的列舉值。
// Electron 實際畫出的選單與視窗沒有在這裡執行。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPresence } from "../server/terminal-presence.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { TERMINAL_HEARTBEAT_MS, TERMINAL_STALE_MS, type TerminalStatus } from "../shared/terminal.ts";
import { startTerminalHeartbeat } from "../src/terminal-heartbeat.ts";
import { localizeMenu, setNativeLocale, t as nativeT } from "../desktop/localization.mjs";
import { SERVICE_TEXT, serviceTray, settingsMenu, type MenuItemTemplate } from "../desktop/settings-menu.mjs";
import { describeMenuPrefs } from "../shared/seconds-menu.ts";
import { DEFAULT_CAMERA_PREFS, type CameraSettings } from "../shared/sense.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";
import type { SettingsView } from "../shared/types.ts";

function fakeTimers() {
  let now = 1_000;
  const timers: { run: () => void; at: number; cancelled: boolean }[] = [];
  return {
    now: () => now,
    timer: (run: () => void, ms: number) => {
      const entry = { run, at: now + ms, cancelled: false };
      timers.push(entry);
      return () => { entry.cancelled = true; };
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
    advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.at <= now) t.run();
        else timers.push(t);
      }
    },
  };
}

describe("TerminalPresence (heartbeat only, injected clock)", () => {
  it("connects on a heartbeat, stays while heartbeats arrive, and disconnects by itself once stale", () => {
    const clock = fakeTimers();
    const changes: TerminalStatus[] = [];
    const p = new TerminalPresence({ now: clock.now, timer: clock.timer, onChange: (s) => changes.push(s) });
    expect(p.status()).toEqual({ connected: false, terminals: [] });
    expect(clock.pending()).toBe(0); // 沒有終端機時不排計時器
    p.heartbeat("rpi4");
    expect(changes).toEqual([{ connected: true, terminals: [{ id: "rpi4", last_seen_ms_ago: 0 }] }]);
    for (let i = 0; i < 5; i++) {
      clock.advance(TERMINAL_HEARTBEAT_MS);
      p.heartbeat("rpi4");
    }
    expect(changes).toHaveLength(1); // 同一組終端機不重複通知
    clock.advance(TERMINAL_STALE_MS - 1);
    expect(p.status()).toEqual({ connected: true, terminals: [{ id: "rpi4", last_seen_ms_ago: TERMINAL_STALE_MS - 1 }] });
    clock.advance(1);
    expect(changes.at(-1)).toEqual({ connected: false, terminals: [] });
    expect(p.status().connected).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  it("notifies when the set of fresh terminals changes and keeps the oldest expiry", () => {
    const clock = fakeTimers();
    const changes: TerminalStatus[] = [];
    const p = new TerminalPresence({ now: clock.now, timer: clock.timer, onChange: (s) => changes.push(s) });
    p.heartbeat("rpi4");
    clock.advance(10_000);
    p.heartbeat("kitchen");
    expect(changes.map((s) => s.terminals.map((t) => t.id))).toEqual([["rpi4"], ["kitchen", "rpi4"]]);
    clock.advance(TERMINAL_STALE_MS - 10_000);
    expect(changes.at(-1)).toMatchObject({ connected: true, terminals: [{ id: "kitchen" }] });
    clock.advance(10_000);
    expect(changes.at(-1)).toEqual({ connected: false, terminals: [] });
  });

  it("dispose cancels the expiry timer", () => {
    const clock = fakeTimers();
    const onChange = vi.fn();
    const p = new TerminalPresence({ now: clock.now, timer: clock.timer, onChange });
    p.heartbeat("rpi4");
    p.dispose();
    expect(clock.pending()).toBe(0);
    clock.advance(TERMINAL_STALE_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("POST /api/terminal/heartbeat through startNous", () => {
  let core: NousHandle | null = null;
  let root: string | null = null;
  afterEach(async () => {
    await core?.close();
    core = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("validates the id, reports presence to the handle and the change callback, and logs only transitions without IPs", async () => {
    root = mkdtempSync(join(tmpdir(), "nous-terminal-"));
    const lines: string[] = [];
    const changes: TerminalStatus[] = [];
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: join(root, "no-dist"),
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()) },
      log: (l) => lines.push(l),
      onTerminalChange: (s) => changes.push(s),
    });
    const beat = (body: unknown, type = "application/json") =>
      fetch(`${core!.url}/api/terminal/heartbeat`, { method: "POST", headers: { "Content-Type": type }, body: JSON.stringify(body) });
    expect(core.terminals.status()).toEqual({ connected: false, terminals: [] });
    for (const bad of [{}, { terminal: "" }, { terminal: "RPI4" }, { terminal: "-pi" }, { terminal: "a".repeat(33) }, { terminal: 4 }, { terminal: "pi 4" }]) {
      expect((await beat(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await beat({ terminal: "rpi4" }, "text/plain")).status).toBe(415); // http-guard 照舊
    expect(core.terminals.status().connected).toBe(false);
    const ok = await beat({ terminal: "rpi4" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect((await beat({ terminal: "rpi4" })).status).toBe(200);
    expect(core.terminals.status()).toMatchObject({ connected: true, terminals: [{ id: "rpi4" }] });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ connected: true });
    const log = lines.filter((l) => l.includes("終端機"));
    expect(log).toEqual(["終端機已連線：rpi4"]);
    expect(log.join("\n")).not.toMatch(/127\.0\.0\.1|::1|localhost/);
  });
});

describe("terminal heartbeat sender (Pi page)", () => {
  afterEach(() => vi.useRealTimers());

  it("sends at once and every 10 s with a valid ?terminal=, and keeps ticking after a failure", async () => {
    vi.useFakeTimers();
    const send = vi.fn<(id: string) => Promise<unknown>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
    const stop = startTerminalHeartbeat({ desktop: false, search: "?terminal=rpi4", send });
    expect(stop).toBeTypeOf("function");
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TERMINAL_HEARTBEAT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(TERMINAL_HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls.every(([id]) => id === "rpi4")).toBe(true);
    stop!();
    await vi.advanceTimersByTimeAsync(TERMINAL_HEARTBEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("goes through the page's API helper: JSON POST to /api/terminal/heartbeat with the locale header", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const { api } = await import("../src/api.ts");
      const stop = startTerminalHeartbeat({ desktop: false, search: "?lang=en&terminal=rpi4", send: (id) => api.terminalHeartbeat(id) });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(path).toBe("/api/terminal/heartbeat");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "Content-Type": "application/json", "X-Nous-Locale": expect.any(String) });
      expect(JSON.parse(String(init.body))).toEqual({ terminal: "rpi4" });
      stop!();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends nothing in the Mac App window, without the parameter, or with an invalid id", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => ({ ok: true }));
    for (const [desktop, search] of [[true, "?terminal=rpi4"], [false, ""], [false, "?terminal="], [false, "?terminal=RPi4"], [false, "?terminal=../x"], [false, `?terminal=${"a".repeat(33)}`]] as const) {
      expect(startTerminalHeartbeat({ desktop, search, send }), `${desktop} ${search}`).toBeNull();
    }
    await vi.advanceTimersByTimeAsync(TERMINAL_HEARTBEAT_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });
});

const camera: CameraSettings = { enabled: true, label: "CCB Camera", left_first: true, screen_width_mm: 398, screen_offset_mm: 0, ...DEFAULT_CAMERA_PREFS };
function settings(): SettingsView {
  return {
    schema_version: "proto-0.1", provider: "mock", providers: [],
    chatgpt: { signed_in: false, email: null, plan_usage: false, needs_reauth: false, welcome_ack: false, pending_login: false, last_error: null },
    camera, voice: DEFAULT_VOICE_PREFS,
    seconds: describeMenuPrefs({ camera, voice: DEFAULT_VOICE_PREFS, voiceWritable: true, realtime: { available: true, model: "fixture", detail: "fixture" } }),
    camera_preview_disabled_reason: null,
    identity: { available: true, disabled_reason: null, limited_reason: null },
    wake: { wake_listen: true, device_id: null, wake_silence_s: 5, voice_name_test: false, speaker_in_call: false, runtime: "ok" },
  };
}
function texts(items: MenuItemTemplate[]): string[] {
  return items.flatMap((item) => [item.label, item.sublabel, ...(item.submenu ? texts(item.submenu) : [])].filter((x): x is string => typeof x === "string"));
}

describe("service mode tray (desktop/settings-menu.mjs)", () => {
  const handlers = () => ({ showWindow: vi.fn(), command: vi.fn(), enterService: vi.fn(), exitService: vi.fn() });

  it("service mode: the first line comes only from terminal presence; 返回 Mac 使用; no brain or voice items", () => {
    const h = handlers();
    for (const [terminal, line] of [[{ connected: true }, "服務模式：Pi 已連線"], [{ connected: false }, "服務模式：Pi 已斷線"], [null, "服務模式：Pi 已斷線"]] as const) {
      const tray = serviceTray({ serviceMode: true, terminal, voiceOn: true, ...h });
      expect(tray.head[0]).toEqual({ label: line, enabled: false });
      expect(tray.actions).toEqual([]);
      const labels = texts(tray.head);
      for (const hidden of ["顯示電子腦", "開始語音對話", "結束語音對話", "打字對話", "看進度", SERVICE_TEXT.enter]) expect(labels).not.toContain(hidden);
      tray.head.find((i) => i.label === "返回 Mac 使用")!.click!();
    }
    expect(h.exitService).toHaveBeenCalledTimes(3);
    expect(h.showWindow).not.toHaveBeenCalled();
    expect(h.command).not.toHaveBeenCalled();
  });

  it("normal mode: the usual actions plus 「進入服務模式（給 Pi 使用）」 and no status line", () => {
    const h = handlers();
    const tray = serviceTray({ serviceMode: false, terminal: { connected: true }, voiceOn: false, ...h });
    expect(tray.head).toEqual([]);
    expect(tray.actions.map((i) => i.label)).toEqual(["顯示電子腦", "開始語音對話", "打字對話", "看進度", "進入服務模式（給 Pi 使用）"]);
    expect(texts(tray.actions).some((x) => x.startsWith("服務模式："))).toBe(false);
    tray.actions.at(-1)!.click!();
    expect(h.enterService).toHaveBeenCalledOnce();
    tray.actions[1]!.click!();
    expect(h.command).toHaveBeenCalledWith("voice");
  });

  it("settings submenu in service mode: camera and wake switches disabled with a paused note, saved values unchanged", () => {
    const write = vi.fn();
    const setWakeListen = vi.fn();
    const items = settingsMenu(settings(), { command: vi.fn(), setMenuPref: write, setWakeListen, openFamily: vi.fn(), servicePaused: true });
    expect(items[0]).toEqual({ label: SERVICE_TEXT.settingsPaused, enabled: false });
    const find = (label: string) => items.find((i) => i.label === label)!;
    expect(find("鏡頭")).toMatchObject({ type: "checkbox", checked: true, enabled: false, sublabel: SERVICE_TEXT.paused });
    expect(find("常駐喚醒聆聽")).toMatchObject({ type: "checkbox", checked: true, enabled: false, sublabel: SERVICE_TEXT.paused });
    expect(find("暫停聆聽（到這次結束）").enabled).toBe(false);
    expect(find("顯示鏡頭畫面").enabled).toBe(false);
    expect(find("家人辨識…")).toMatchObject({ enabled: false, sublabel: SERVICE_TEXT.needsWindow });
    // 其他設定照常可改（只改偏好，不開麥克風或鏡頭）
    expect(find("看著說話").enabled).toBe(true);
    const normal = settingsMenu(settings(), { command: vi.fn(), setMenuPref: write, setWakeListen, openFamily: vi.fn() });
    expect(normal.find((i) => i.label === "鏡頭")).toMatchObject({ enabled: true });
    expect(normal.find((i) => i.label === "常駐喚醒聆聽")).toMatchObject({ enabled: true });
    expect(normal.some((i) => i.label === SERVICE_TEXT.settingsPaused)).toBe(false);
  });

  it("every new string is translated in English", () => {
    setNativeLocale("en");
    try {
      const h = handlers();
      const all = [
        ...localizeMenu(serviceTray({ serviceMode: true, terminal: { connected: true }, ...h }).head),
        ...localizeMenu(serviceTray({ serviceMode: true, terminal: { connected: false }, ...h }).head),
        ...localizeMenu(serviceTray({ serviceMode: false, ...h }).actions),
        ...settingsMenu(settings(), { command: vi.fn(), setMenuPref: vi.fn(), setWakeListen: vi.fn(), openFamily: vi.fn(), servicePaused: true, wakeReport: { state: "paused", reason: "service" }, translate: nativeT }),
      ];
      expect(texts(all).filter((x) => /\p{Script=Han}/u.test(x))).toEqual([]);
      for (const text of Object.values(SERVICE_TEXT)) expect(nativeT(text), text).not.toBe(text);
      expect(nativeT("服務模式：Pi 已連線")).toBe("Service mode: Pi connected");
      expect(nativeT("服務模式：Pi 已斷線")).toBe("Service mode: Pi disconnected");
      expect(nativeT("返回 Mac 使用")).toBe("Return to Mac use");
    } finally {
      setNativeLocale("zh-TW");
    }
  });
});

describe("service mode wiring (desktop/main.mjs, preload.cjs)", () => {
  const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");

  it("preload forwards only enter/exit and reads the state at load", () => {
    let bridge!: { initialService: boolean; onService(cb: (kind: string) => void): () => void };
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipc = {
      sendSync: vi.fn((channel: string) => (channel === "nous:get-service" ? true : "zh-TW")), send: vi.fn(), invoke: vi.fn(),
      on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => listeners.set(channel, callback)),
      removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    };
    runInNewContext(readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8"), {
      require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name: string, exposed: typeof bridge) => { bridge = exposed; } } }),
      process: { argv: [] },
    });
    expect(bridge.initialService).toBe(true);
    const got = vi.fn();
    const off = bridge.onService(got);
    for (const kind of ["enter", "exit", "show", { kind: "enter" }, null]) listeners.get("nous:service")?.({}, kind);
    expect(got.mock.calls).toEqual([["enter"], ["exit"]]);
    off();
    expect(listeners.has("nous:service")).toBe(false);
  });

  it("main.mjs: media is denied, the window never shows, and commands are no-ops while in service mode; status comes from the core", () => {
    expect(main).toMatch(/callback\(permission === "media" && !prefs\.serviceMode && /);
    const show = main.slice(main.indexOf("function showWindow()"), main.indexOf("function toggleWindow()"));
    expect(show).toMatch(/if \(prefs\.serviceMode\) return;/);
    const command = main.slice(main.indexOf("function command(name)"), main.indexOf("function notifyPage(name)"));
    expect(command.indexOf("if (prefs.serviceMode) return;")).toBeLessThan(command.indexOf("showWindow()"));
    expect(main).toMatch(/if \(!prefs\.startHidden && !prefs\.serviceMode\) win\.show\(\);/);
    expect(main).toMatch(/did-finish-load[\s\S]{0,80}if \(prefs\.serviceMode\) notifyService\("enter"\)/);
    expect([...main.matchAll(/notifyService\("(\w+)"\)/g)].map((m) => m[1]).sort()).toEqual(["enter", "enter", "exit"]);
    // 狀態句只來自核心的終端機心跳
    expect(main).toMatch(/onTerminalChange: \(status\) => \{\s*terminalStatus = status;\s*rebuildMenu\(\);/);
    expect(main).toMatch(/serviceTray\(\{ serviceMode: prefs\.serviceMode, terminal: terminalStatus,/);
    const exit = main.slice(main.indexOf("function exitServiceMode()"));
    expect(exit.indexOf("savePrefs({ serviceMode: false })")).toBeLessThan(exit.indexOf("showWindow()"));
  });
});
