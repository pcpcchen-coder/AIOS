import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";

// HIST-1：獨立網頁 /history 是建置產物（vite 多頁），由核心提供；不是預設頁，主畫面不連過去。

const root = fileURLToPath(new URL("..", import.meta.url));
let outDir = "";
let server: Server | null = null;
let base = "";

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "nous-history-build-"));
  await build({ root, configFile: join(root, "vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const dir = mkdtempSync(join(tmpdir(), "nous-history-page-"));
  const store = new TaskStore(null);
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
  server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, port, devPort: 5173, distDir: outDir });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  if (server) await new Promise((r) => server!.close(r));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("/history standalone page build output", () => {
  it("builds history.html next to index.html with only external same-origin scripts", () => {
    expect(existsSync(join(outDir, "index.html"))).toBe(true);
    expect(existsSync(join(outDir, "history.html"))).toBe(true);
    const html = readFileSync(join(outDir, "history.html"), "utf8");
    expect(html).toContain('id="history-root"');
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/src="\/assets\/[^"]+\.js"/);
      expect(body!.trim()).toBe("");
    }
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("is served at /history with the main page CSP plus stricter limits, and is not the default route", async () => {
    const history = await fetch(`${base}/history`);
    expect(history.status).toBe(200);
    expect(await history.text()).toContain('id="history-root"');
    const main = await fetch(`${base}/`);
    const mainHtml = await main.text();
    expect(mainHtml).toContain('id="brain"');
    expect(mainHtml).not.toContain("history-root");
    for (const header of ["x-content-type-options", "referrer-policy"]) {
      expect(history.headers.get(header), header).toBe(main.headers.get(header));
    }
    // 比主畫面更嚴：同樣的 CSP 再加 form-action 'none'；不用鏡頭、麥克風，不編譯 wasm。
    const csp = history.headers.get("content-security-policy")!;
    expect(csp).toBe(`${main.headers.get("content-security-policy")}; form-action 'none'`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("wasm-unsafe-eval");
    expect(history.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    // 未知路徑仍回主畫面（SPA fallback 照舊），不是成果紀錄。
    expect(await (await fetch(`${base}/somewhere`)).text()).toContain('id="brain"');
  });

  it("the main page does not link to /history from anything resident", () => {
    const index = readFileSync(join(root, "index.html"), "utf8");
    expect(index).not.toContain("/history");
  });
});
