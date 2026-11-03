import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import type { CodexTurn, CodexTurnRequest } from "../server/codex-responses.ts";
import { MockAdapter, type MockScenario } from "../server/integrations/adapters/mock.ts";
import { createIntegrations, type Integrations } from "../server/integrations/index.ts";
import { LiveToolCaller } from "../server/live-tool-caller.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import type { RealtimeRoute, RouteCall } from "../server/realtime-routes.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { billingLine } from "../shared/realtime-route.ts";
import { ApprovalQueue, executeRealtimeTool, type ApprovalSink } from "../src/realtime-tools.ts";
import type { RealtimeCallbacks } from "../src/realtime.ts";

// AIL-1：整合層接到兩條即時語音路徑。live：LiveToolCaller 在核心執行；api_key：頁面轉交 POST /api/integrations/call。
// Codex、頁面、即時語音路徑與 Adapter 都是模擬（fixture／mock）。

function mockIntegrations(scenario: () => MockScenario = () => "normal"): Integrations {
  return createIntegrations({ enabled: true, services: ["mock"], soloistPort: 19090 }, () => undefined, { mock: () => new MockAdapter({ scenario, timeoutMs: 150 }) })!;
}

const turn = (partial: Partial<CodexTurn>): CodexTurn => ({ text: "", calls: [], citations: [], model: "gpt-fixture-codex", replay: [], ...partial });

describe("live route: LiveToolCaller runs app__ tools in the core", () => {
  function caller(turns: CodexTurn[], integrations: Integrations | null) {
    const requests: CodexTurnRequest[] = [];
    const hostCalls: string[] = [];
    const c = new LiveToolCaller({
      responses: { turn: async (req) => { requests.push({ ...req, input: [...req.input] }); return turns.shift()!; } },
      caps: () => ({ webSearch: false, mcp: [], home: false, ...(integrations ? { integrations: (l) => integrations.registry.functionSpecs("live", l) } : {}) }),
      host: { outstanding: 0, call: async (name) => { hostCalls.push(name); return { ok: true }; } },
      tasks: () => [],
      approval: () => ({ open: false, resolvedAt: null }),
      ...(integrations ? { integrations: { dispatcher: integrations.dispatcher, sessionId: "s1" } } : {}),
    });
    return { c, requests, hostCalls };
  }

  it("executes through the dispatcher, never via the page, and reports the real status", async () => {
    const ail = mockIntegrations();
    const { c, requests, hostCalls } = caller([
      turn({ calls: [{ call_id: "c1", name: "app__mock__toggle", arguments: '{"on":true}' }] }),
      turn({ text: "（模擬）開關已打開。" }),
    ], ail);
    const result = await c.run({ id: "d1", text: "測試整合層", source: "voice", transcript: [] }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, text: "（模擬）開關已打開。", tools: [{ name: "app__mock__toggle", ok: true }] });
    expect(hostCalls).toEqual([]);
    expect(requests[0]!.tools.map((t) => (t.type === "function" ? t.name : ""))).toContain("app__mock__toggle");
    const output = requests[1]!.input.find((i) => "type" in i && i.type === "function_call_output") as { output: string };
    expect(JSON.parse(output.output)).toMatchObject({ ok: true, status: "confirmed" });
  });

  it("a hung write tool ends the delegation as result-unknown, not failure", async () => {
    const ail = mockIntegrations(() => "hang");
    const { c } = caller([turn({ calls: [{ call_id: "c1", name: "app__mock__toggle", arguments: '{"on":true}' }] }), turn({ calls: [] }), turn({}), turn({})], ail);
    // 模型下一輪沒有說話：照工具輸出說。
    const result = await c.run({ id: "d1", text: "x", source: "voice", transcript: [] }, new AbortController().signal);
    expect(result.text).toMatch(/結果不明/);
  });

  it("a refused or unconfirmed integration result is never reported as done when the model says nothing", async () => {
    const ail = mockIntegrations(() => "unconfirmed");
    const { c } = caller([turn({ calls: [{ call_id: "c1", name: "app__mock__toggle", arguments: '{"on":true}' }] }), turn({})], ail);
    const result = await c.run({ id: "d1", text: "x", source: "voice", transcript: [] }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, text: "（模擬）已送出，沒有回讀確認。" });
    const refused = caller([turn({ calls: [{ call_id: "c1", name: "app__mock__toggle", arguments: '{"on":"yes"}' }] }), turn({})], mockIntegrations());
    const r2 = await refused.c.run({ id: "d1", text: "x", source: "voice", transcript: [] }, new AbortController().signal);
    expect(r2).toMatchObject({ ok: false, text: "參數不正確，沒有執行。" });
    expect(r2.text).not.toMatch(/處理好了/);
  });

  it("without integrations (flag off) an app__ call is not a tool on this route", async () => {
    const { c, requests, hostCalls } = caller([turn({ calls: [{ call_id: "c1", name: "app__mock__echo", arguments: '{"text":"x"}' }] }), turn({ text: "不能用" })], null);
    await c.run({ id: "d1", text: "x", source: "voice", transcript: [] }, new AbortController().signal);
    expect(hostCalls).toEqual([]);
    const output = requests[1]!.input.find((i) => "type" in i && i.type === "function_call_output") as { output: string };
    expect(JSON.parse(output.output)).toEqual({ ok: false, error: "這條路徑沒有這個工具：app__mock__echo" });
  });
});

describe("api_key route: the page forwards app__ calls to the core", () => {
  function callbacks(patch: Partial<RealtimeCallbacks>): RealtimeCallbacks {
    const noop = () => undefined;
    const reject = async () => ({ ok: false });
    return { onPhase: noop, onUserTranscript: noop, onAssistantTranscript: noop, onDelegate: reject, onGetTasks: reject, onWebSearch: reject, onHomeStatus: reject, onHomeControl: reject as never, onHomeConfirm: reject as never, onApprovalPrompt: noop, onApprovalResolved: noop, onToolActivity: noop, onClosed: noop, ...patch };
  }
  async function run(name: string, cb: RealtimeCallbacks) {
    const sink: ApprovalSink = { generation: () => 1, notify: () => undefined, addContext: () => undefined, resetIdle: () => undefined, pendingChanged: () => undefined };
    let delivered: Record<string, unknown> | null = null;
    await executeRealtimeTool(name, '{"text":"x"}', { callbacks: cb, approvals: new ApprovalQueue(cb, sink, 1000), generation: 1, stale: () => false, end: () => undefined, deliver: (o) => void (delivered = o) });
    return delivered;
  }

  it("forwards only names the core listed; otherwise unchanged 'unknown tool'", async () => {
    const forwarded: string[] = [];
    const cb = callbacks({ integrationTools: () => ["app__mock__echo"], onIntegrationTool: async (name) => { forwarded.push(name); return { ok: true, status: "confirmed", message: "core" }; } });
    expect(await run("app__mock__echo", cb)).toEqual({ ok: true, status: "confirmed", message: "core" });
    expect(await run("app__mock__toggle", cb)).toEqual({ ok: false, error: "未知的工具：app__mock__toggle" });
    expect(await run("app__mock__echo", callbacks({}))).toEqual({ ok: false, error: "未知的工具：app__mock__echo" });
    expect(forwarded).toEqual(["app__mock__echo"]);
  });
});

describe("HTTP /api/integrations/*", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  function fakeRoute(id: "live" | "api_key"): RealtimeRoute {
    return {
      id,
      readiness: () => ({ ready: true }),
      describe: () => ({ id, available: true, reason: null, billing_line: billingLine(id, "m"), model: "m", voice: "cove", voices: [], tools: "", detail: "fixture" }),
      baseInfo: () => ({ available: true, model: "m", detail: "fixture" }),
      async connect(): Promise<RouteCall> {
        return { route: id, answerSdp: "v=0 answer", model: "m", control: id === "live" ? { input: () => {} } : null, close: async () => {} };
      },
    };
  }

  async function app(integrations: Integrations | null, route: "live" | "api_key" = "api_key") {
    const store = new TaskStore(null);
    const dir = mkdtempSync(join(tmpdir(), "nous-ail-"));
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, realtimeRoutes: { [route]: fakeRoute(route) }, ...(integrations ? { integrations } : {}), port, devPort: 5173, distDir: null });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://localhost:${port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { base, post };
  }

  it("flag off: no routes (404) and no integrations field in settings", async () => {
    const a = await app(null);
    expect((await fetch(`${a.base}/api/integrations/status`)).status).toBe(404);
    expect((await a.post("/api/integrations/call", {})).status).toBe(404);
    const settings = (await (await fetch(`${a.base}/api/settings`)).json()) as Record<string, unknown>;
    expect("integrations" in settings).toBe(false);
  });

  it("flag on: status view, settings tool names, owner-checked call executed by the core", async () => {
    const a = await app(mockIntegrations());
    expect(await (await fetch(`${a.base}/api/integrations/status`)).json()).toEqual({ services: [expect.objectContaining({ service: "mock", mock: true, health: "available", reason: "ok", model_tools: 2 })] });
    const settings = (await (await fetch(`${a.base}/api/settings`)).json()) as { integrations: { tools: string[] } };
    expect(settings.integrations).toEqual({ tools: ["app__mock__echo", "app__mock__toggle"] });
    const start = (await (await a.post("/api/realtime/start", {})).json()) as { session_id: string; owner: string };
    expect((await a.post("/api/realtime/call", { sdp: "v=0 offer", session_id: start.session_id, owner: start.owner })).status).toBe(200);
    const body = { session_id: start.session_id, owner: start.owner, name: "app__mock__echo", arguments: '{"text":"hi"}' };
    expect((await a.post("/api/integrations/call", { ...body, owner: `${start.owner.slice(0, -1)}${start.owner.endsWith("A") ? "B" : "A"}` })).status).toBe(403);
    expect((await a.post("/api/integrations/call", { ...body, session_id: "../x" })).status).toBe(400);
    expect((await a.post("/api/integrations/call", { ...body, arguments: { text: "hi" } })).status).toBe(400);
    const res = await a.post("/api/integrations/call", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "confirmed", message: "（模擬）已回傳。", data: { mock: true, text: "hi" } });
    expect(await (await a.post("/api/integrations/call", { ...body, name: "app__mock__nope" })).json()).toMatchObject({ status: "refused", reason: "not_registered" });
  });
});
