import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DuckLinkHub } from "../server/duck/link.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import type { IntegrationStatusView } from "../shared/integrations.ts";
import { MockDuck } from "./fixtures/mock-duck.ts";

// DUCK-1：核心啟動時的接線。NOUS_DUCK 關閉（預設）時 /duck-link 不存在、duck adapter 不註冊；
// 打開後標示 mock 的假鴨子連得進來、整合狀態看得到它是模擬。假鴨子（fixture），不是實機驗證。

let core: NousHandle | null = null;
let duck: MockDuck | null = null;
let root: string | null = null;

afterEach(async () => {
  duck?.disconnect();
  await core?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  core = duck = root = null;
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function boot(env: Record<string, string>): Promise<{ handle: NousHandle; logs: string[] }> {
  root = mkdtempSync(join(tmpdir(), "nous-duck-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  const logs: string[] = [];
  core = await startNous({
    envFile: null,
    dataDir: join(root, "data"),
    distDir: dist,
    fallbackPort: true,
    overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), NOUS_CAMERA: "off", OPENAI_API_KEY: "", NOUS_WAKE: "off", ...env },
    log: (line) => logs.push(line),
  });
  return { handle: core, logs };
}

function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number | "open" | "error"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => {
      ws.terminate();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? "error"));
    ws.on("error", () => resolve("error"));
  });
}

const until = async (ok: () => boolean | Promise<boolean>, ms = 3_000) => {
  const start = Date.now();
  while (!(await ok())) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("NOUS_DUCK off (default)", () => {
  it("has no /duck-link endpoint and registers no duck adapter even when listed", async () => {
    const { handle, logs } = await boot({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "duck" });
    expect(await upgradeStatus(`ws://127.0.0.1:${handle.port}/duck-link`)).not.toBe("open");
    const status = (await (await fetch(`${handle.url}/api/integrations/status`)).json()) as IntegrationStatusView;
    expect(status.services.map((s) => s.service)).not.toContain("duck");
    expect(logs.some((l) => l.includes("duck 需要 NOUS_DUCK=on"))).toBe(true);
    expect(logs.some((l) => l.includes("duck-link 已開"))).toBe(false);
  });
});

describe("NOUS_DUCK on", () => {
  it("accepts a duck on /duck-link, rejects browser origins and other paths, and reports the mock duck in integration status", async () => {
    const { handle, logs } = await boot({ NOUS_DUCK: "on", NOUS_AIL: "on", NOUS_AIL_SERVICES: "duck" });
    const url = `ws://127.0.0.1:${handle.port}/duck-link`;
    expect(logs.some((l) => l.includes("duck-link 已開"))).toBe(true);
    expect(await upgradeStatus(url, { Origin: `http://127.0.0.1:${handle.port}` })).toBe(403);
    expect(await upgradeStatus(`ws://127.0.0.1:${handle.port}/other`)).toBe(404);
    expect(await upgradeStatus(url, { Host: `127.0.0.1:${handle.port + 1}` })).toBe(403);

    const statusOf = async () => ((await (await fetch(`${handle.url}/api/integrations/status`)).json()) as IntegrationStatusView).services.find((s) => s.service === "duck");
    expect(await statusOf()).toMatchObject({ mock: false, model_tools: 6 });

    duck = new MockDuck({ url, stateIntervalMs: 50 });
    await duck.connect();
    await until(() => logs.some((l) => l.includes("鴨子已連線")));
    // 健康狀態有 5 秒快取；等它反映「已連線、對面是模擬」。
    await until(async () => (await statusOf())?.health === "available", 8_000);
    expect(await statusOf()).toMatchObject({ mock: true, health: "available", reason: "ok", model_tools: 6 });
    // 既有的 HTTP 路由不受影響。
    expect((await fetch(`${handle.url}/api/settings`)).status).toBe(200);
  }, 15_000);

  it("is not registered as an adapter unless listed in NOUS_AIL_SERVICES, but the endpoint still works", async () => {
    const { handle } = await boot({ NOUS_DUCK: "on" });
    expect(await upgradeStatus(`ws://127.0.0.1:${handle.port}/duck-link`)).toBe("open");
    const res = await fetch(`${handle.url}/api/integrations/status`);
    const services = res.ok ? ((await res.json()) as IntegrationStatusView).services.map((s) => s.service) : [];
    expect(services).not.toContain("duck");
  });
});

describe("through the real Dispatcher (fixture duck)", () => {
  it("runs an enabled duck tool by wire name, refuses a not-yet-enabled one as disabled, and never reaches the duck for it", async () => {
    const hub = new DuckLinkHub({ port: 0, heartbeatMs: 40 });
    const port = await hub.start();
    duck = new MockDuck({ url: `ws://127.0.0.1:${port}/duck-link`, stateIntervalMs: 50, speed: 10 });
    try {
      await duck.connect();
      await until(() => hub.snapshot().state !== null);
      const ail = createIntegrations({ enabled: true, services: ["duck"], soloistPort: 19090 }, () => undefined, undefined, { duck: hub })!;
      // 模型看到的只有第一階段的六個工具。
      expect(ail.registry.functionSpecs("live").map((t) => t.name).sort()).toEqual(["app__duck__express", "app__duck__gesture", "app__duck__look", "app__duck__status", "app__duck__stop", "app__duck__track"]);
      const signal = new AbortController().signal;
      const look = await ail.dispatcher.execute({ tool: "app__duck__look", args: { head_yaw: 0.2, duration_s: 0.5 }, route: "live", actor: "agent", sessionId: "s1", signal });
      expect(look).toMatchObject({ ok: true, status: "confirmed", data: { mock: true, reached: true } });
      expect(look.message.startsWith("（模擬）")).toBe(true);
      const before = duck.received.length;
      const walk = await ail.dispatcher.execute({ tool: "app__duck__walk", args: { duration_s: 1 }, route: "live", actor: "agent", sessionId: "s1", signal });
      expect(walk).toMatchObject({ ok: false, status: "refused", reason: "disabled" });
      expect(duck.received.length).toBe(before);
      const bad = await ail.dispatcher.execute({ tool: "app__duck__look", args: { head_yaw: "left" }, route: "api_key", actor: "agent", sessionId: "s1", signal });
      expect(bad).toMatchObject({ status: "refused", reason: "invalid_arguments" });
      // status 的 data 要留在 Dispatcher 的大小上限內（超過會被整個丟掉）。
      const status = await ail.dispatcher.execute({ tool: "app.duck.status", args: {}, route: "live", actor: "agent", sessionId: "s1", signal });
      expect(status.status).toBe("confirmed");
      expect(status.data).toBeDefined();
    } finally {
      await hub.stop();
    }
  });
});
