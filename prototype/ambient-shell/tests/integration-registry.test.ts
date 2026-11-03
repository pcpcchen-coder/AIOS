import { describe, expect, it } from "vitest";
import { fromWireName, isIntegrationToolId, isToolResult, toolResult, toWireName } from "../shared/integrations.ts";
import { parseAil } from "../server/config.ts";
import { MOCK_TOOLS, MockAdapter } from "../server/integrations/adapters/mock.ts";
import type { IntegrationAdapter, ToolDefinition } from "../server/integrations/contracts.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { SPOTIFY_VOICE_CONTROL_GATE } from "../server/integrations/policy.ts";
import { IntegrationRegistry } from "../server/integrations/registry.ts";
import { buildCallerInstructions, liveCallerTools } from "../server/live-tool-caller.ts";
import { buildRealtimeInstructions, buildRealtimeTools, INTEGRATION_RULE, realtimeToolRules } from "../server/realtime.ts";

// AIL-1（docs/18 §6–§7）：Registry、工具 ID、旗標關閉逐位元組相同。Adapter 都是模擬（mock）。

const ON = new Set(["mock"]);
const tool = (patch: Partial<ToolDefinition>): ToolDefinition => ({ ...MOCK_TOOLS[0]!, ...patch });
const adapter = (patch: Partial<IntegrationAdapter> & { list?: ToolDefinition[] }): IntegrationAdapter => {
  const base = new MockAdapter();
  return { id: patch.id ?? "mock", service: patch.service ?? "mock", version: patch.version ?? 1, mock: true, tools: () => patch.list ?? MOCK_TOOLS, health: base.health.bind(base), execute: base.execute.bind(base) };
};

describe("tool IDs and wire names", () => {
  it("maps app.<service>.<action> to app__<service>__<action> and back, rejecting anything else", () => {
    expect(toWireName("app.spotify.player_status")).toBe("app__spotify__player_status");
    expect(fromWireName("app__spotify__player_status")).toBe("app.spotify.player_status");
    for (const bad of ["app.Spotify.play", "app.spotify", "app.spo__tify.play", "spotify.play", "app.spotify.play.now", "app.1x.play", `app.${"a".repeat(40)}.${"b".repeat(30)}`]) {
      expect(isIntegrationToolId(bad), bad).toBe(false);
    }
    for (const bad of ["home_control", "app__x", "app__x__y__z", "app.x.y", "app___x__y"]) expect(fromWireName(bad), bad).toBeNull();
    // OpenAI 函式名稱只接受 [A-Za-z0-9_-]{1,64}。
    expect(toWireName("app.mock.echo")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("toolResult derives ok from status: only confirmed is ok", () => {
    for (const status of ["unconfirmed", "unknown", "needs_confirmation", "refused", "failed"] as const) expect(toolResult(status, "x").ok).toBe(false);
    expect(toolResult("confirmed", "x").ok).toBe(true);
    expect(isToolResult({ ok: true, status: "unconfirmed", message: "x" })).toBe(false);
    expect(isToolResult({ ok: false, status: "confirmed", message: "x" })).toBe(false);
    expect(isToolResult({ ok: false, status: "failed", message: "x", reason: "made_up" })).toBe(false);
  });
});

describe("IntegrationRegistry", () => {
  it("rejects duplicate adapters and duplicate tool IDs", () => {
    const r = new IntegrationRegistry({ enabled: ON });
    r.register(adapter({}));
    expect(() => r.register(adapter({}))).toThrow(/重複註冊/);
    const r2 = new IntegrationRegistry({ enabled: ON });
    expect(() => r2.register(adapter({ list: [tool({}), tool({})] }))).toThrow(/重複/);
  });

  it("rejects bad IDs, foreign services, bad versions, timeouts, routes and unsupported schemas", () => {
    const cases: [Partial<IntegrationAdapter> & { list?: ToolDefinition[] }, RegExp][] = [
      [{ id: "Bad" }, /Adapter ID/],
      [{ version: 0 }, /版本/],
      [{ list: [tool({ id: "app.other.echo" })] }, /不屬於/],
      [{ list: [tool({ id: "app.mock.Echo" as never })] }, /工具 ID 不合法/],
      [{ list: [tool({ timeoutMs: 60_001 })] }, /timeoutMs/],
      [{ list: [tool({ timeoutMs: 10 })] }, /timeoutMs/],
      [{ list: [tool({ supportedRoutes: [] })] }, /supportedRoutes/],
      [{ list: [tool({ supportedRoutes: ["sms" as never] })] }, /supportedRoutes/],
      [{ list: [tool({ effect: "delete" as never })] }, /effect/],
      [{ list: [tool({ description: " " })] }, /說明/],
      [{ list: [tool({ inputSchema: { type: "object", properties: {}, additionalProperties: true } as never })] }, /additionalProperties/],
      [{ list: [tool({ inputSchema: { type: "object", properties: { x: { type: "object" } }, additionalProperties: false } as never })] }, /型別不支援/],
      [{ list: [tool({ inputSchema: { type: "object", properties: {}, required: ["x"], additionalProperties: false } })] }, /required/],
      [{ list: [tool({ inputSchema: { type: "object", properties: {}, additionalProperties: false, oneOf: [] } as never })] }, /不支援 oneOf/],
    ];
    for (const [patch, error] of cases) {
      const r = new IntegrationRegistry({ enabled: ON });
      expect(() => r.register(adapter(patch)), String(error)).toThrow(error);
      // 整個拒絕：沒有留下部分註冊。
      expect(r.adapters()).toHaveLength(0);
      expect(r.listTools("api_key")).toEqual([]);
    }
  });

  it("refuses any app.spotify.* tool while the Spotify voice-control gate is blocked (docs/18 §5, SP-2)", () => {
    expect(SPOTIFY_VOICE_CONTROL_GATE).toBe("blocked");
    for (const action of ["play", "pause", "search_and_play", "player_status"]) {
      const r = new IntegrationRegistry({ enabled: new Set(["spotify_soloist"]) });
      const spotify = adapter({ id: "spotify_soloist", service: "spotify", list: [tool({ id: `app.spotify.${action}` as never })] });
      expect(() => r.register(spotify)).toThrow(/Spotify 語音控制未取得授權/);
    }
  });

  it("lists tools only for enabled adapters, enabled tools and supported routes; the model has no way to enable a tool", () => {
    const r = new IntegrationRegistry({ enabled: new Set<string>() });
    r.register(adapter({}));
    expect(r.listTools("api_key")).toEqual([]);
    expect(r.status("app.mock.echo", "api_key")).toBe("disabled");
    const r2 = new IntegrationRegistry({ enabled: ON });
    r2.register(adapter({ list: [tool({}), tool({ id: "app.mock.off", enabled: false }), tool({ id: "app.mock.text_only", supportedRoutes: ["text"] })] }));
    expect(r2.listTools("api_key").map((t) => t.id)).toEqual(["app.mock.echo"]);
    expect(r2.status("app.mock.off", "api_key")).toBe("disabled");
    expect(r2.status("app.mock.text_only", "live")).toBe("unsupported");
    expect(r2.status("app.mock.nope" as never, "live")).toBeNull();
    // 定義在註冊時複製並凍結：之後改 Adapter 的物件、或改回傳的定義都不會打開工具。
    const listed = r2.listTools("api_key")[0]!;
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => {
      (listed as { enabled: boolean }).enabled = false;
    }).toThrow();
    expect(Object.keys(IntegrationRegistry.prototype).filter((k) => /enable|set/i.test(k))).toEqual([]);
  });

  it("produces the same schema for the same tool on api_key and live", () => {
    const r = new IntegrationRegistry({ enabled: ON });
    r.register(new MockAdapter());
    const caps = { webSearch: false, mcp: [], home: false };
    const apiKey = buildRealtimeTools({ ...caps, integrations: (l) => r.functionSpecs("api_key", l) }).filter((t) => String(t.name).startsWith("app__"));
    const live = liveCallerTools({ ...caps, integrations: (l) => r.functionSpecs("live", l) }).filter((t) => t.type === "function" && t.name.startsWith("app__"));
    expect(apiKey.map((t) => t.name)).toEqual(["app__mock__echo", "app__mock__toggle"]);
    expect(live.map((t) => (t.type === "function" ? [t.name, t.parameters] : null))).toEqual(apiKey.map((t) => [t.name, t.parameters]));
    expect(r.functionSpecs("api_key", "en")[0]!.description).toMatch(/^\(Mock\)/);
  });
});

describe("flag off: byte-identical tools and instructions", () => {
  const variants = [
    { webSearch: true, mcp: [], home: true, taskWebSearch: true },
    { webSearch: false, mcp: [{ server_label: "x", server_url: "https://x.example", require_approval: "always" as const }], home: false },
    { webSearch: true, mcp: [], home: true, memory: true },
  ];
  it("no integrations / empty integrations change nothing (tools, rules, instructions, caller instructions)", () => {
    const now = new Date("2026-11-03T00:00:00Z");
    for (const caps of variants) {
      for (const locale of ["zh-TW", "en"] as const) {
        const empty = { ...caps, integrations: () => [] };
        expect(JSON.stringify(buildRealtimeTools(empty, locale))).toBe(JSON.stringify(buildRealtimeTools(caps, locale)));
        expect(realtimeToolRules(empty)).toEqual(realtimeToolRules(caps));
        expect(buildRealtimeInstructions([], now, empty, locale)).toBe(buildRealtimeInstructions([], now, caps, locale));
        expect(buildCallerInstructions(empty, [], now, locale)).toBe(buildCallerInstructions(caps, [], now, locale));
        expect(JSON.stringify(buildRealtimeTools(caps, locale))).not.toContain("app__");
      }
    }
  });

  it("with integrations the rule appears once and the tools come after home/memory, before MCP", () => {
    const r = new IntegrationRegistry({ enabled: ON });
    r.register(new MockAdapter());
    const caps = { webSearch: true, mcp: [{ server_label: "x", server_url: "https://x.example", require_approval: "always" as const }], home: true, integrations: (l: "zh-TW" | "en") => r.functionSpecs("api_key", l) };
    const names = buildRealtimeTools(caps).map((t) => (t.type === "mcp" ? "mcp" : String(t.name)));
    expect(names.slice(-3)).toEqual(["app__mock__echo", "app__mock__toggle", "mcp"]);
    expect(realtimeToolRules(caps).filter((line) => line === INTEGRATION_RULE)).toHaveLength(1);
  });

  it("NOUS_AIL defaults off; services only parse when on; createIntegrations returns null when off and skips unknown adapters", () => {
    expect(parseAil(undefined, "mock")).toEqual({ enabled: false, services: [] });
    expect(parseAil("on", " Mock, mock ,")).toEqual({ enabled: true, services: ["mock"] });
    expect(() => parseAil("on", "../evil")).toThrow(/不合法/);
    expect(createIntegrations({ enabled: false, services: ["mock"] })).toBeNull();
    const lines: string[] = [];
    const ail = createIntegrations({ enabled: true, services: ["mock", "unknown_app"] }, (l) => lines.push(l))!;
    expect(ail.registry.adapters().map((a) => a.id)).toEqual(["mock"]);
    expect(lines.join("\n")).toMatch(/unknown_app 不是已審核的 Adapter/);
    expect(createIntegrations({ enabled: true, services: [] })!.registry.listTools("api_key")).toEqual([]);
  });
});
