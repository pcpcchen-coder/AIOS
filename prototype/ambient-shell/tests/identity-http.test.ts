// 家人辨識與本機核心的 HTTP 邊界：settings.identity 只有狀態（不含姓名、person_id）、身分資料沒有 HTTP 路由、
// JS 回應帶 worker 用的 CSP、.mjs 的 MIME、/face-runtime/ 只提供清單上的檔名。也從 startNous 走一次注入的 identity.handle。
// SecretBox 與原生確認都是替身；Electron IPC 沒有在這裡執行。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, scriptHeaders } from "../server/app.ts";
import { pageHeaders } from "../server/page-headers.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { checkFaceRuntime, FACE_MODEL_VERSION, FACE_RUNTIME_FILES, faceRuntimePath } from "../server/face-runtime.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { BROWSER_IDENTITY_STATUS, IDENTITY_BROWSER_REASON } from "../shared/identity.ts";
import type { SettingsView } from "../shared/types.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

/** npm run face:setup -- --product 裝好的檔案（有才測 200 的路徑）。 */
const INSTALLED = join(import.meta.dirname, "..", "face-runtime");

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let root: string;
let server: Server | null = null;
let core: NousHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-identity-http-"));
});
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  await core?.close();
  server = null;
  core = null;
  rmSync(root, { recursive: true, force: true });
});

/** 只有前端與 /face-runtime/ 的最小核心（createApp），identity 狀態可選。 */
async function startApp(options: { faceRuntimeDir?: string | null; identity?: { status(): typeof BROWSER_IDENTITY_STATUS } } = {}) {
  const port = await freePort();
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  writeFileSync(join(dist, "assets", "identity-worker-abc.js"), "postMessage(1);");
  writeFileSync(join(dist, "assets", "chunk.mjs"), "export {};");
  const store = new TaskStore(null);
  const auth = new ChatGPTAuth({ dir: root, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(5), auth, dir: root, preferred: "mock", onChange: () => {} });
  server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: dist, ...options });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  return `http://localhost:${port}`;
}

describe("HTTP boundary", () => {
  it("browser version: settings.identity says unavailable, with no names or ids", async () => {
    const base = await startApp();
    const view = (await (await fetch(`${base}/api/settings`)).json()) as SettingsView;
    expect(view.identity).toEqual(BROWSER_IDENTITY_STATUS);
    expect(view.identity?.disabled_reason).toBe(IDENTITY_BROWSER_REASON);
  });

  it("SSE hello and settings only carry the three menu fields for identity (no counts or generations)", async () => {
    const base = await startApp({ identity: { status: () => ({ available: true, disabled_reason: null, limited_reason: null }) } });
    const res = await fetch(`${base}/api/events`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const hello = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
    expect(Object.keys(hello.settings.identity).sort()).toEqual(["available", "disabled_reason", "limited_reason"]);
  });

  it("there is no identity API over HTTP", async () => {
    const base = await startApp();
    for (const path of ["/api/identity", "/api/identity/probe", "/api/family", "/api/family/list", "/api/gallery"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
      const post = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "list" }) });
      expect(post.status, path).toBe(404);
    }
  });

  it("JavaScript responses carry a worker CSP (same-origin only, wasm allowed) without loosening the page CSP", async () => {
    const base = await startApp();
    const js = await fetch(`${base}/assets/identity-worker-abc.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const csp = js.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(scriptHeaders()["Content-Security-Policy"]);
    expect(csp).toMatch(/(^|; )connect-src 'self'(;|$)/);
    expect(csp).toMatch(/(^|; )script-src 'self' 'wasm-unsafe-eval'(;|$)/);
    expect(csp).not.toMatch(/https?:|\*|unsafe-inline|'unsafe-eval'/);
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toBe(pageHeaders(false)["Content-Security-Policy"]);
    expect(page.headers.get("content-security-policy")).not.toMatch(/wasm-unsafe-eval/);
  });

  it(".mjs is served as JavaScript with the worker CSP", async () => {
    const base = await startApp();
    const mjs = await fetch(`${base}/assets/chunk.mjs`);
    expect(mjs.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(mjs.headers.get("content-security-policy")).toMatch(/connect-src 'self'/);
  });

  it("/face-runtime/ serves only the manifest's files, verifies the hash on every read (503 when it does not match), never other paths or a SPA fallback", async () => {
    const dir = join(root, "face-runtime");
    mkdirSync(dir);
    for (const f of FACE_RUNTIME_FILES) writeFileSync(join(dir, f.name), `fake ${f.name}`);
    writeFileSync(join(dir, "secret.txt"), "nope");
    const base = await startApp({ faceRuntimeDir: dir });
    // 啟動後才被換掉的檔案（這裡是假的內容）：每次讀取都核對，不送出去
    for (const f of FACE_RUNTIME_FILES) expect((await fetch(`${base}/face-runtime/${f.name}`)).status, f.name).toBe(503);
    for (const path of ["/face-runtime/secret.txt", "/face-runtime/", "/face-runtime/../face-runtime/secret.txt", "/face-runtime/sub/ort-wasm-simd-threaded.mjs"]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    expect((await fetch(`${base}/face-runtime/ort-wasm-simd-threaded.mjs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(405);
    expect(faceRuntimePath(null, "/face-runtime/ort-wasm-simd-threaded.mjs")).toBeNull();
  });

  it.skipIf(!existsSync(INSTALLED) || checkFaceRuntime(INSTALLED).state !== "ok")("/face-runtime/ with the installed, verified files: 200 with the right MIME and CSP", async () => {
    const base = await startApp({ faceRuntimeDir: INSTALLED });
    const mjs = await fetch(`${base}/face-runtime/ort-wasm-simd-threaded.mjs`);
    expect(mjs.status).toBe(200);
    expect(mjs.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(mjs.headers.get("content-security-policy")).toMatch(/connect-src 'self'/);
    expect((await fetch(`${base}/face-runtime/ort-wasm-simd-threaded.wasm`)).headers.get("content-type")).toBe("application/wasm");
    expect((await fetch(`${base}/face-runtime/face_detection_yunet_2023mar.onnx`)).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("checkFaceRuntime reports missing files and hash mismatches by file name only", () => {
    expect(checkFaceRuntime(null)).toEqual({ state: "not_configured", problems: [] });
    expect(checkFaceRuntime(join(root, "none"))).toMatchObject({ state: "missing" });
    const dir = join(root, "bad");
    mkdirSync(dir);
    writeFileSync(join(dir, FACE_RUNTIME_FILES[0]!.name), "tampered");
    const check = checkFaceRuntime(dir);
    expect(check).toEqual({ state: "hash_mismatch", problems: [FACE_RUNTIME_FILES[0]!.name] });
  });
});

describe("startNous with the identity injection (what desktop/main.mjs passes)", () => {
  it("exposes identity.handle to the main process only, reports status in settings without names, and logs without identity data", async () => {
    const lines: string[] = [];
    const confirms: unknown[] = [];
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: join(root, "no-dist"),
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", NOUS_CAMERA: "on", PORT: String(await freePort()) },
      identity: {
        dir: join(root, "identity"),
        secretBox: fakeSecretBox(),
        confirm: async (r) => {
          confirms.push(r);
          return true;
        },
        modelDir: join(root, "face-runtime-missing"),
      },
      log: (l) => lines.push(l),
    });
    expect(core.identity).toBeDefined();
    const settings = async () => ((await (await fetch(`${core!.url}/api/settings`)).json()) as SettingsView).identity!;
    expect(await settings()).toEqual({ available: true, disabled_reason: null, limited_reason: expect.stringMatching(/模型未安裝/) });
    // 啟動時不碰 gallery：還沒建資料夾、沒呼叫 SecretBox
    expect(existsSync(join(root, "identity"))).toBe(false);
    expect((await fetch(`${core.url}/face-runtime/ort-wasm-simd-threaded.mjs`)).status).toBe(404); // 沒過核對就不提供
    // 從選單列打開 → 列表（模型沒裝：只能查看與刪除）
    expect(await core.identity!.handle({ op: "open_session" }, { userInitiated: false })).toMatchObject({ ok: false, code: "not_user_initiated" });
    const opened = await core.identity!.handle({ op: "open_session" }, { userInitiated: true });
    expect(opened).toMatchObject({ ok: true, people: [] });
    const session = opened.ok && "session" in opened ? opened.session : "";
    const enrolled = await core.identity!.handle(
      {
      op: "enroll",
      session,
      name: "George",
      minor: false,
      guardian_confirmed: false,
      consent: true,
      model: FACE_MODEL_VERSION,
      samples: Array.from({ length: 6 }, (_, i) => Array.from(near(unitFeature(1), i + 1))),
      },
      {},
    );
    expect(enrolled).toMatchObject({ ok: false, code: "unavailable" });
    expect(confirms).toEqual([]);
    const text = JSON.stringify(await settings());
    expect(text).not.toMatch(/George|person_id|fam_/);
    expect(lines.join("\n")).toMatch(/家人辨識：可用（模型 missing/);
    expect(existsSync(join(root, "identity"))).toBe(true); // 第一次開 session 才建
    expect(lines.join("\n")).not.toMatch(/George/);
  });

  it("without the injection (npm start) there is no identity handle and the status is the browser one", async () => {
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: join(root, "no-dist"),
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()) },
      log: () => {},
    });
    expect(core.identity).toBeUndefined();
    const view = (await (await fetch(`${core.url}/api/settings`)).json()) as SettingsView;
    expect(view.identity).toEqual(BROWSER_IDENTITY_STATUS);
  });
});
