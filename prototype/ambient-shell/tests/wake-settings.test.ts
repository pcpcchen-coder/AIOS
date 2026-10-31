import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { pageHeaders } from "../server/page-headers.ts";
import { checkWakeRuntime, readVerifiedWakeRuntime, WAKE_RUNTIME_FILES, wakeRuntimePath, type WakeRuntimeFile } from "../server/wake-runtime.ts";
import { WakeSettingsStore } from "../server/wake-settings.ts";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import type { SettingsView } from "../shared/types.ts";

// WK-01a 常駐喚醒聆聽的偏好（configDir/wake.json，fail closed）、旗標開啟時的路由與標頭、引擎檔案的雜湊清單。

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let root: string;
let core: NousHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-wake-settings-"));
});
afterEach(async () => {
  await core?.close();
  core = null;
  rmSync(root, { recursive: true, force: true });
});

describe("WakeSettingsStore: wake.json fails closed", () => {
  const store = (dir = root, log: string[] = []) => new WakeSettingsStore({ dir, onChange: () => {}, log: (m) => log.push(m) });

  it("defaults to off with no device", () => {
    expect(store().view()).toEqual({ wake_listen: false, device_id: null });
  });

  it("saves, reloads, and clears the device when turned off (late device reports are not kept)", () => {
    const a = store();
    a.update({ wake_listen: true });
    a.update({ device_id: "mic-a" });
    expect(store().view()).toEqual({ wake_listen: true, device_id: "mic-a" });
    a.update({ wake_listen: false });
    expect(store().view()).toEqual({ wake_listen: false, device_id: null });
    a.update({ device_id: "mic-b" });
    expect(store().view()).toEqual({ wake_listen: false, device_id: null });
    expect(JSON.parse(readFileSync(join(root, "wake.json"), "utf8"))).toEqual({ schema_version: 1, prefs: { wake_listen: false, device_id: null } });
  });

  it("unreadable file, wrong version or a bad value never turns listening on or keeps an unvalidated device", () => {
    const cases: [string, { wake_listen: boolean; device_id: string | null }][] = [
      ["not json", { wake_listen: false, device_id: null }],
      [JSON.stringify({ schema_version: 2, prefs: { wake_listen: true, device_id: "mic-a" } }), { wake_listen: false, device_id: null }],
      [JSON.stringify({ schema_version: 1, prefs: { wake_listen: "yes", device_id: "mic-a" } }), { wake_listen: false, device_id: "mic-a" }],
      [JSON.stringify({ schema_version: 1, prefs: { wake_listen: true, device_id: 5 } }), { wake_listen: true, device_id: null }],
    ];
    for (const [body, want] of cases) {
      writeFileSync(join(root, "wake.json"), body);
      const log: string[] = [];
      expect(store(root, log).view(), body).toEqual(want);
      expect(log.length, body).toBeGreaterThan(0);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed write throws and keeps the previous value in memory", () => {
    const dir = join(root, "ro");
    mkdirSync(dir);
    const s = store(dir);
    chmodSync(dir, 0o500);
    try {
      expect(() => s.update({ wake_listen: true })).toThrow();
      expect(s.view()).toEqual({ wake_listen: false, device_id: null });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("wake runtime manifest (D2: built from the 2026-10-31 release, keywords pending; hash-verified like face-runtime)", () => {
  it("the shipped list is built but keywords are pending, so the runtime is missing (only keywords_pending) and unverified bytes are never served (schema details: tests/wake-runtime-manifest.test.ts)", () => {
    expect(WAKE_RUNTIME_FILES.length).toBeGreaterThan(0);
    expect(checkWakeRuntime(root)).toEqual({ state: "missing", problems: ["keywords_pending"] });
    expect(wakeRuntimePath(root, "/wake-runtime/anything.wasm")).toBeNull();
    // release 檔現在有雜湊，所以路徑對得上清單；但內容不符雜湊就不提供（伺服器另外以 runtime 狀態把關，見 NOUS_WAKE=on 的 404 測試）
    expect(wakeRuntimePath(root, "/wake-runtime/sherpa-onnx-wasm-kws-main.wasm")).toBe(join(root, "sherpa-onnx-wasm-kws-main.wasm"));
    expect(readVerifiedWakeRuntime(join(root, "sherpa-onnx-wasm-kws-main.wasm"))).toBeNull();
    writeFileSync(join(root, "sherpa-onnx-wasm-kws-main.wasm"), "unverified");
    expect(readVerifiedWakeRuntime(join(root, "sherpa-onnx-wasm-kws-main.wasm"))).toBeNull();
  });

  it("serves only listed files whose SHA-256 matches", () => {
    const body = Buffer.from("fixture wasm bytes");
    const files: WakeRuntimeFile[] = [{ name: "engine.wasm", role: "runtime", sha256: createHash("sha256").update(body).digest("hex") }];
    expect(checkWakeRuntime(root, files).state).toBe("missing");
    expect(checkWakeRuntime(null, files).state).toBe("not_configured");
    writeFileSync(join(root, "engine.wasm"), body);
    expect(checkWakeRuntime(root, files).state).toBe("ok");
    expect(wakeRuntimePath(root, "/wake-runtime/engine.wasm", files)).toBe(join(root, "engine.wasm"));
    expect(wakeRuntimePath(root, "/wake-runtime/../engine.wasm", files)).toBeNull();
    expect(readVerifiedWakeRuntime(join(root, "engine.wasm"), files)).toEqual(body);
    writeFileSync(join(root, "engine.wasm"), "tampered");
    expect(checkWakeRuntime(root, files)).toEqual({ state: "hash_mismatch", problems: ["engine.wasm"] });
    expect(readVerifiedWakeRuntime(join(root, "engine.wasm"), files)).toBeNull();
  });
});

describe("NOUS_WAKE=on", () => {
  async function boot(): Promise<NousHandle> {
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const runtimeDir = join(root, "wake-runtime");
    mkdirSync(runtimeDir);
    writeFileSync(join(runtimeDir, "engine.wasm"), "not listed");
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_WAKE: "on", NOUS_CAMERA: "off", OPENAI_API_KEY: "" },
      wakeRuntimeDir: runtimeDir,
      log: () => {},
    });
    return core;
  }

  it("the flag is off unless exactly on", () => {
    expect(loadConfig({}).wake).toBe(false);
    expect(loadConfig({ NOUS_WAKE: "1" }).wake).toBe(false);
    expect(loadConfig({ NOUS_WAKE: " ON " }).wake).toBe(true);
  });

  it("the served page gets 'wasm-unsafe-eval' only when wake is on AND the runtime is ok", async () => {
    const dist = join(root, "dist-app");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const port = await freePort();
    const store = new TaskStore(null);
    const auth = new ChatGPTAuth({ dir: root, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(5), auth, dir: root, preferred: "mock", onChange: () => {} });
    let runtime: "ok" | "missing" = "ok";
    const wake = { view: () => ({ wake_listen: false, device_id: null }), update: () => ({ wake_listen: false, device_id: null }), runtime: () => runtime };
    const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: dist, wake });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const csp = async () => (await fetch(`http://localhost:${port}/`)).headers.get("content-security-policy");
      expect(await csp()).toBe(pageHeaders(false, true)["Content-Security-Policy"]);
      runtime = "missing";
      expect(await csp()).toBe(pageHeaders(false)["Content-Security-Policy"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("/wake-runtime/ is 404 for every file (model files with pinned hashes included) unless the runtime is ok", async () => {
    const dist = join(root, "dist-app");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const runtimeDir = join(root, "wake-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    // 模型檔已有雜湊（WK-00 釘住）；內容不符，所以如果真的走到提供那一步會是 503，而不是 404
    const model = WAKE_RUNTIME_FILES.find((f) => f.role === "model")!;
    expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(runtimeDir, model.name), "not the model");
    const port = await freePort();
    const store = new TaskStore(null);
    const auth = new ChatGPTAuth({ dir: root, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(5), auth, dir: root, preferred: "mock", onChange: () => {} });
    let runtime: "ok" | "missing" = "missing";
    const wake = { view: () => ({ wake_listen: false, device_id: null }), update: () => ({ wake_listen: false, device_id: null }), runtime: () => runtime };
    const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: dist, wake, wakeRuntimeDir: runtimeDir });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    try {
      const get = async (name: string) => (await fetch(`http://localhost:${port}/wake-runtime/${name}`)).status;
      expect(checkWakeRuntime(runtimeDir)).toEqual({ state: "missing", problems: ["keywords_pending"] }); // 關鍵詞等 George 的數字
      expect(await get(model.name)).toBe(404);
      for (const f of WAKE_RUNTIME_FILES) expect(await get(f.name), f.name).toBe(404);
      // 對照：runtime 是 ok 時同一個檔案會走到雜湊核對（不符 → 503），證明 404 來自 runtime 的閘門
      runtime = "ok";
      expect(await get(model.name)).toBe(503);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("CSP adds only 'wasm-unsafe-eval' (like the camera); the microphone policy is unchanged", () => {
    expect(pageHeaders(false, true)).toEqual({ ...pageHeaders(false), "Content-Security-Policy": pageHeaders(true)["Content-Security-Policy"] });
    expect(pageHeaders(false, true)["Permissions-Policy"]).toBe(pageHeaders(false)["Permissions-Policy"]);
  });

  it("settings carry wake (off, runtime missing); with the runtime missing the page CSP stays exactly as with the flag off", async () => {
    const handle = await boot();
    const view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.wake).toEqual({ wake_listen: false, device_id: null, runtime: "missing" });
    const page = await fetch(`${handle.url}/`);
    expect(page.headers.get("content-security-policy")).toBe(pageHeaders(false)["Content-Security-Policy"]);
    const post = (body: unknown) => fetch(`${handle.url}/api/settings/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ wake_listen: "yes" })).status).toBe(400);
    expect((await post({ speaker: true })).status).toBe(400);
  });

  // 審查 M2：頁面（任何本機頁面腳本）不能略過原生說明自己打開；只有 App 主程序經 NousHandle.wake 能打開。
  it("the page cannot turn listening on over HTTP; the main process can (NousHandle.wake); the page may record the device or turn it off", async () => {
    const handle = await boot();
    const post = (body: unknown) => fetch(`${handle.url}/api/settings/wake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const denied = await post({ wake_listen: true });
    expect(denied.status).toBe(403);
    expect((await post({ wake_listen: true, device_id: "mic-a" })).status).toBe(403);
    let view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.wake?.wake_listen).toBe(false);
    expect(existsSync(join(root, "config", "wake.json"))).toBe(false);
    expect(handle.wake).toBeDefined();
    handle.wake!.setListen(true);
    view = (await (await fetch(`${handle.url}/api/settings`)).json()) as SettingsView;
    expect(view.wake).toEqual({ wake_listen: true, device_id: null, runtime: "missing" });
    const recorded = (await (await post({ device_id: "mic-a" })).json()) as SettingsView;
    expect(recorded.wake).toEqual({ wake_listen: true, device_id: "mic-a", runtime: "missing" });
    const off = (await (await post({ wake_listen: false })).json()) as SettingsView;
    expect(off.wake).toEqual({ wake_listen: false, device_id: null, runtime: "missing" });
    expect(existsSync(join(root, "config", "wake.json"))).toBe(true);
    // 引擎清單是 built 但關鍵詞未定（runtime missing）：資料夾裡的檔案也不提供
    expect((await fetch(`${handle.url}/wake-runtime/engine.wasm`)).status).toBe(404);
    expect((await fetch(`${handle.url}/wake-runtime/`)).status).toBe(404);
  });
});
