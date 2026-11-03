import { describe, expect, it } from "vitest";
import { MockAdapter, MOCK_TOOLS, type MockScenario } from "../server/integrations/adapters/mock.ts";
import type { ToolDefinition } from "../server/integrations/contracts.ts";
import { IntegrationDispatcher, type AuditEntry, type DispatchRequest } from "../server/integrations/dispatcher.ts";
import { MAX_RESULT_DATA_BYTES, RateLimiter } from "../server/integrations/policy.ts";
import { IntegrationRegistry } from "../server/integrations/registry.ts";
import { IntegrationStatusBoard } from "../server/integrations/status.ts";
import { toolResult } from "../shared/integrations.ts";

// AIL-1（docs/18 §7）：Dispatcher 的拒絕、逾時、中止、結果驗證與稽核紀錄。Adapter 是模擬（mock）。

function setup(options: { scenario?: MockScenario; enabled?: string[]; extra?: ToolDefinition[]; timeoutMs?: number; limiter?: RateLimiter } = {}) {
  let scenario: MockScenario = options.scenario ?? "normal";
  const mock = new MockAdapter({ scenario: () => scenario, ...(options.extra ? { extraTools: options.extra } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const registry = new IntegrationRegistry({ enabled: new Set(options.enabled ?? ["mock"]) });
  registry.register(mock);
  const audit: AuditEntry[] = [];
  const dispatcher = new IntegrationDispatcher(registry, { audit: (e) => audit.push(e), ...(options.limiter ? { limiter: options.limiter } : {}) });
  const run = (patch: Partial<DispatchRequest>) => dispatcher.execute({ tool: "app__mock__echo", args: { text: "hi" }, route: "api_key", actor: "agent", sessionId: "s1", ...patch });
  return { mock, registry, dispatcher, audit, run, setScenario: (s: MockScenario) => void (scenario = s) };
}

describe("IntegrationDispatcher refusals (nothing executed)", () => {
  it("unregistered, disabled, wrong route", async () => {
    const a = setup();
    expect(await a.run({ tool: "app__mock__missing" })).toMatchObject({ ok: false, status: "refused", reason: "not_registered" });
    expect(await a.run({ tool: "home_control" })).toMatchObject({ status: "refused", reason: "not_registered" });
    expect(await a.run({ route: "text" })).toMatchObject({ status: "refused", reason: "route_not_supported" });
    const off = setup({ enabled: [] });
    expect(await off.run({})).toMatchObject({ status: "refused", reason: "disabled" });
    expect(a.mock.requests).toHaveLength(0);
    expect(off.mock.requests).toHaveLength(0);
  });

  it("invalid arguments: not JSON, extra keys, missing, wrong type, too long", async () => {
    const a = setup();
    for (const args of ["{not json", { text: "hi", extra: 1 }, {}, { text: 3 }, { text: "x".repeat(201) }, [], null]) {
      const result = await a.run({ args });
      expect(result, JSON.stringify(args)).toMatchObject({ ok: false, status: "refused", reason: "invalid_arguments" });
      // 錯誤訊息不回顯參數值。
      expect(result.message).not.toContain("xxxx");
    }
    expect(a.mock.requests).toHaveLength(0);
    expect(await a.run({ args: '{"text":"ok"}' })).toMatchObject({ ok: true, status: "confirmed" });
  });

  it("external_commit always needs confirmation; AIL-1 has no card yet so it is refused, not run", async () => {
    const commit = { ...MOCK_TOOLS[0]!, id: "app.mock.send" as const, effect: "external_commit" as const };
    const a = setup({ extra: [commit] });
    expect(await a.run({ tool: "app.mock.send" })).toMatchObject({ ok: false, status: "refused", reason: "confirmation_unavailable" });
    expect(a.mock.requests).toHaveLength(0);
  });

  it("rate limit per adapter", async () => {
    const a = setup({ limiter: new RateLimiter(2, () => 0) });
    await a.run({});
    await a.run({});
    expect(await a.run({})).toMatchObject({ status: "refused", reason: "rate_limited" });
    expect(a.mock.requests).toHaveLength(2);
  });
});

describe("IntegrationDispatcher execution", () => {
  it("passes a request-id (idempotency key) and returns confirmed results", async () => {
    const a = setup();
    expect(await a.run({ tool: "app.mock.toggle", args: { on: true } })).toMatchObject({ ok: true, status: "confirmed", data: { mock: true, on: true } });
    expect(a.mock.switchOn).toBe(true);
    expect(a.mock.requests[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("timeout and abort are unknown (never inferred as not executed)", async () => {
    const a = setup({ scenario: "hang", timeoutMs: 100 });
    expect(await a.run({ tool: "app.mock.toggle", args: { on: true } })).toMatchObject({ ok: false, status: "unknown", reason: "timeout" });
    expect(await a.run({})).toMatchObject({ status: "unknown", reason: "timeout" });
    const b = setup({ scenario: "hang" });
    const controller = new AbortController();
    const pending = b.run({ signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ status: "unknown", reason: "aborted" });
    // 呼叫前就已中止：確定沒有送出（refused），即使 Adapter 會立刻成功也不執行。
    const c = setup();
    const pre = new AbortController();
    pre.abort();
    expect(await c.run({ tool: "app.mock.toggle", args: { on: true }, signal: pre.signal })).toMatchObject({ ok: false, status: "refused", reason: "aborted" });
    expect(c.mock.requests).toHaveLength(0);
    expect(c.mock.switchOn).toBe(false);
  });

  it("adapter errors: read → failed, write → unknown; malformed results → failed", async () => {
    const a = setup({ scenario: "throw" });
    expect(await a.run({})).toMatchObject({ status: "failed", reason: "adapter_error" });
    expect(await a.run({ tool: "app.mock.toggle", args: { on: false } })).toMatchObject({ status: "unknown", reason: "adapter_error" });
    a.setScenario("bad_result");
    expect(await a.run({})).toMatchObject({ ok: false, status: "failed", reason: "invalid_result" });
    a.setScenario("unconfirmed");
    expect(await a.run({ tool: "app.mock.toggle", args: { on: true } })).toMatchObject({ ok: false, status: "unconfirmed" });
  });

  it("drops oversized data and keeps only contract fields", async () => {
    const registry = new IntegrationRegistry({ enabled: new Set(["mock"]) });
    const mock = new MockAdapter();
    mock.execute = async () => ({ ...toolResult("confirmed", "big", { data: "x".repeat(MAX_RESULT_DATA_BYTES + 1) }), token: "secret" }) as never;
    registry.register(mock);
    const result = await new IntegrationDispatcher(registry).execute({ tool: "app.mock.echo", args: { text: "a" }, route: "live", actor: "agent", sessionId: "s" });
    expect(result).toEqual({ ok: true, status: "confirmed", message: "big" });
  });

  it("audit entries carry no arguments, data or tokens", async () => {
    const a = setup();
    await a.run({ args: { text: "SECRET-CONTENT" } });
    await a.run({ tool: "app__nope__x", args: { text: "SECRET-CONTENT" } });
    expect(a.audit).toHaveLength(2);
    expect(JSON.stringify(a.audit)).not.toContain("SECRET-CONTENT");
    expect(a.audit[0]).toMatchObject({ tool: "app.mock.echo", adapter: "mock", effect: "read", route: "api_key", status: "confirmed" });
    expect(Object.keys(a.audit[0]!).sort()).toEqual(["adapter", "effect", "ms", "reason", "requestId", "route", "status", "tool"]);
  });

  it("handles() only answers for tools available on that route", () => {
    const a = setup();
    expect(a.dispatcher.handles("app__mock__echo", "api_key")).toBe(true);
    expect(a.dispatcher.handles("app__mock__echo", "text")).toBe(false);
    expect(a.dispatcher.handles("web_search", "api_key")).toBe(false);
  });
});

describe("IntegrationStatusBoard", () => {
  it("reports health, never turns a timeout, error or inconsistent report into available, and caches briefly", async () => {
    let calls = 0;
    let report: unknown = { health: "available", reason: "ok" };
    const mock = new MockAdapter({ health: () => { calls++; return report as never; } });
    const registry = new IntegrationRegistry({ enabled: new Set(["mock"]) });
    registry.register(mock);
    let now = 0;
    const board = new IntegrationStatusBoard(registry, { now: () => now, timeoutMs: 50 });
    expect((await board.view()).services).toEqual([{ service: "mock", mock: true, health: "available", reason: "ok", checked_at: 0, model_tools: 2 }]);
    await board.view();
    expect(calls).toBe(1);
    now = 10_000;
    report = { health: "available", reason: "timeout" };
    expect((await board.view()).services[0]).toMatchObject({ health: "unknown", reason: "bad_reply" });
    now = 20_000;
    report = new Promise(() => undefined);
    expect((await board.view()).services[0]).toMatchObject({ health: "unknown", reason: "timeout" });
    now = 30_000;
    report = Promise.reject(new Error("boom"));
    expect((await board.view()).services[0]).toMatchObject({ health: "unknown", reason: "error" });
  });

  it("an adapter that is registered but not enabled is not_configured and not probed", async () => {
    let probed = false;
    const registry = new IntegrationRegistry({ enabled: new Set() });
    registry.register(new MockAdapter({ health: () => { probed = true; return { health: "available", reason: "ok" }; } }));
    expect((await new IntegrationStatusBoard(registry).view()).services[0]).toMatchObject({ health: "unavailable", reason: "not_configured", model_tools: 0, checked_at: null });
    expect(probed).toBe(false);
  });
});
