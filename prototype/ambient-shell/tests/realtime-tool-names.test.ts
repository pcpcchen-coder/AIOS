import { mkdtempSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { HOME_ARG_MAX } from "../shared/home.ts";
import { ASK_THE_AI, commandSections, type RealtimeToolName } from "../shared/voice-commands.ts";
import { HOST_TOOL_NAMES, SIDE_EFFECT_TOOLS, type HostToolName } from "../shared/realtime-route.ts";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import type { CodexTurn, CodexTurnRequest } from "../server/codex-responses.ts";
import { HomeBridge } from "../server/home-bridge.ts";
import { HomeAdapter } from "../server/integrations/adapters/home.ts";
import type { IntegrationFunctionSpec } from "../server/integrations/contracts.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { buildCallerInstructions, liveCallerTools, LiveToolCaller } from "../server/live-tool-caller.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { buildRealtimeInstructions, buildRealtimeTools, HOME_CONTROL_TOOL, HOME_STATUS_TOOL, realtimeToolRules, REALTIME_TOOLS, RECALL_MEMORY_TOOL, type RealtimeCapabilities } from "../server/realtime.ts";
import { HOST_TIMEOUT_MS, type ToolHost } from "../server/realtime-routes.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";

// 架構批次 S8（docs/23 §3）：即時語音工具名單與家電參數長度上限改成單一來源。這個檔的第一部分是「特徵測試」：
// 期望值（inline 與 tests/__snapshots__/realtime-tool-names.test.ts.snap）是在重構前的 main（1b61d08）上產生並通過的，
// 重構後必須一個位元組都不變。Codex Responses、頁面與中控都是假的（fixture），沒有真實通話，也不是產品 gate。
// 第二部分（檔尾「單一來源」）是重構後加的：每份名單都要和 shared/realtime-route.ts 的 HOST_TOOL_NAMES 一致，
// 只在一個地方加工具會在這裡（或編譯期）失敗。

/** 重構前六份名單各自的順序（2026-11-10 從 main 1b61d08 抄下）。 */
const CANONICAL = ["web_search", "show_search_result", "delegate_task", "get_tasks", "end_conversation", "home_status", "home_control", "set_voice_volume", "set_day_night"];
const TIMEOUT_KEY_ORDER = ["home_control", "home_status", "web_search", "show_search_result", "delegate_task", "get_tasks", "end_conversation", "set_voice_volume", "set_day_night"];
const ASK_ORDER = ["end_conversation", "set_voice_volume", "set_day_night", "get_tasks", "web_search", "show_search_result", "delegate_task", "home_status", "home_control"];
const MODEL_ORDER = ["web_search", "show_search_result", "delegate_task", "get_tasks", "set_voice_volume", "set_day_night", "end_conversation", "home_status", "home_control"];

const MCP: RealtimeCapabilities["mcp"] = [{ server_label: "notes", server_url: "https://mcp.example.com/sse", server_description: "筆記（fixture）", require_approval: "always" }];
const INTEGRATIONS = (): readonly IntegrationFunctionSpec[] => [
  { type: "function", name: "app__mock__echo", description: "（模擬）fixture", parameters: { type: "object", properties: { text: { type: "string", maxLength: 20 } }, required: ["text"], additionalProperties: false } },
];

/** 代表性的能力組合：上網、家電、記憶、整合、MCP 各自開關。 */
const CONFIGS: Record<string, RealtimeCapabilities> = {
  minimal: { webSearch: false, mcp: [] },
  web: { webSearch: true, mcp: [], taskWebSearch: true },
  home: { webSearch: false, mcp: [], home: true },
  memory: { webSearch: false, mcp: [], memory: true },
  integrations: { webSearch: false, mcp: [], integrations: INTEGRATIONS },
  mcp: { webSearch: false, mcp: MCP },
  everything: { webSearch: true, mcp: MCP, taskWebSearch: true, home: true, memory: true, integrations: INTEGRATIONS, night: true, calendarBriefing: true },
};
const NOW = new Date("2026-11-10T04:00:00Z");

describe("特徵：模型看到的工具表與規則文字（重構前後逐位元組相同）", () => {
  it("工具的名稱與順序", () => {
    expect(REALTIME_TOOLS.map((t) => t.name)).toEqual(MODEL_ORDER.slice(0, 7));
    expect(buildRealtimeTools({ webSearch: true, home: true, mcp: [] }).map((t) => t.name)).toEqual(MODEL_ORDER);
    expect(buildRealtimeTools(CONFIGS.everything!).map((t) => t.name ?? t.server_label)).toEqual([...MODEL_ORDER, "recall_memory", "app__mock__echo", "notes"]);
    expect(buildRealtimeTools(CONFIGS.minimal!).map((t) => t.name)).toEqual(["delegate_task", "get_tasks", "set_voice_volume", "set_day_night", "end_conversation"]);
    expect(RECALL_MEMORY_TOOL.name).toBe("recall_memory");
  });

  it.each(Object.keys(CONFIGS))("buildRealtimeTools／liveCallerTools 的 JSON：%s", (key) => {
    const caps = CONFIGS[key]!;
    expect(JSON.stringify(buildRealtimeTools(caps))).toMatchSnapshot("buildRealtimeTools zh-TW");
    expect(JSON.stringify(buildRealtimeTools(caps, "en"))).toMatchSnapshot("buildRealtimeTools en");
    expect(JSON.stringify(liveCallerTools(caps))).toMatchSnapshot("liveCallerTools zh-TW");
    expect(JSON.stringify(liveCallerTools(caps, "en"))).toMatchSnapshot("liveCallerTools en");
  });

  it.each(Object.keys(CONFIGS))("realtimeToolRules 與兩條路徑的說明文字：%s", (key) => {
    const caps = CONFIGS[key]!;
    expect(realtimeToolRules(caps)).toMatchSnapshot("realtimeToolRules");
    expect(buildRealtimeInstructions([], NOW, caps)).toMatchSnapshot("buildRealtimeInstructions");
    expect(buildCallerInstructions(caps, [], NOW)).toMatchSnapshot("buildCallerInstructions");
  });

  it("家電工具的 schema 沒有長度上限（上限只在本機 API 與整合層 Facade）", () => {
    expect(JSON.stringify(HOME_STATUS_TOOL)).not.toContain("maxLength");
    expect(JSON.stringify(HOME_CONTROL_TOOL)).not.toContain("maxLength");
  });
});

describe("特徵：核心的名單（順序看得到的地方）", () => {
  it("HOST_TIMEOUT_MS 的鍵、順序與數值", () => {
    expect(Object.keys(HOST_TIMEOUT_MS)).toEqual(TIMEOUT_KEY_ORDER);
    expect(HOST_TIMEOUT_MS).toEqual({ home_control: 62_000, home_status: 20_000, web_search: 32_000, show_search_result: 7_000, delegate_task: 10_000, get_tasks: 5_000, end_conversation: 5_000, set_voice_volume: 5_000, set_day_night: 10_000 });
    expect([...SIDE_EFFECT_TOOLS]).toEqual(["home_control", "delegate_task"]);
  });

  it("ASK_THE_AI 的鍵順序＝指令表「可以問 AI」的列順序", () => {
    expect(Object.keys(ASK_THE_AI)).toEqual(ASK_ORDER);
    const ask = commandSections(null).find((s) => s.id === "ask")!;
    expect(ask.rows.map((r) => r.id)).toEqual(ASK_ORDER.map((name) => `ai-${name}`));
    expect(ask.rows).toMatchSnapshot("commands doc ask rows");
  });
});

// HOST_TOOLS 是 server/live-tool-caller.ts 的模組內常數（沒有匯出），只用在 includes()：順序看不到，成員看得到。
describe("特徵：LiveToolCaller 的 HOST_TOOLS 成員（由行為觀察）", () => {
  const CAPS: RealtimeCapabilities = { webSearch: true, mcp: [], taskWebSearch: true, home: true };
  const turn = (partial: Partial<CodexTurn>): CodexTurn => ({ text: "", calls: [], citations: [], model: "gpt-fixture-codex", replay: [], ...partial });

  async function callOnce(name: string) {
    const turns = [turn({ calls: [{ call_id: "c1", name, arguments: "{}" }] }), turn({ text: "好" })];
    const requests: CodexTurnRequest[] = [];
    const hostCalls: string[] = [];
    const host: ToolHost = { outstanding: 0, call: async (tool) => (hostCalls.push(tool), { ok: true }) };
    const responses = { turn: async (req: CodexTurnRequest) => (requests.push({ ...req, input: [...req.input] }), turns.shift()!) };
    const c = new LiveToolCaller({ responses, caps: () => CAPS, host, tasks: () => [], approval: () => ({ open: false, resolvedAt: null }), now: () => NOW.getTime() });
    await c.run({ id: "d1", text: "x", source: "voice", transcript: [] }, new AbortController().signal);
    const output = requests[1]!.input.find((i) => "type" in i && i.type === "function_call_output") as { output: string };
    return { hostCalls, output: JSON.parse(output.output) as Record<string, unknown> };
  }

  it.each(CANONICAL)("%s 會交給頁面執行", async (name) => {
    expect((await callOnce(name)).hostCalls).toEqual([name]);
  });

  it.each(["recall_memory", "home_confirm", "app__mock__echo", "no_such_tool"])("%s 不是頁面工具：不呼叫頁面，照實回報", async (name) => {
    const { hostCalls, output } = await callOnce(name);
    expect(hostCalls).toEqual([]);
    expect(output).toEqual({ ok: false, error: `這條路徑沒有這個工具：${name}` });
  });
});

describe("特徵：頁面的工具執行器（src/realtime-tools.ts）", () => {
  it("每個工具名稱各有一個分支", () => {
    const source = readFileSync(new URL("../src/realtime-tools.ts", import.meta.url), "utf8");
    const branches = [...source.matchAll(/\bname === "([a-z_]+)"/g)].map((m) => m[1]!);
    expect([...new Set(branches)].sort()).toEqual([...CANONICAL].sort());
  });
});

// ─────────────────────────── 家電參數長度上限 ───────────────────────────

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** 空的假中控（沒有任何設備）：通過長度檢查的請求會得到 not_found，沒通過的在送出前就被擋下。 */
function bridge(seen: string[]) {
  const hubFetch = (async (url: string) => {
    seen.push(url.replace("http://hub.fixture", ""));
    if (url.endsWith("/api/v1/home")) return new Response(JSON.stringify({ layout: { rooms: [] }, devices: [], server_time: 1_792_560_000 }), { status: 200 });
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as unknown as typeof fetch;
  let n = 0;
  return new HomeBridge({ url: "http://hub.fixture", token: "hub-secret", fetch: hubFetch, newId: () => `id${++n}`, now: () => 1_792_560_000_000, sleep: async () => {} });
}

async function core(facade: boolean) {
  const seen: string[] = [];
  const home = bridge(seen);
  const ail = facade ? createIntegrations({ enabled: true, services: ["home"], soloistPort: 19090 }, () => {}, undefined, { home }) : null;
  const store = new TaskStore(null);
  const dir = mkdtempSync(join(tmpdir(), "nous-tool-names-"));
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
  const port = await freePort();
  const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, home, ...(ail ? { integrations: ail } : {}), port, devPort: 5173, distDir: null });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://localhost:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { post, seen };
}

const x = (n: number) => "燈".repeat(n);
/** 剛好在上限與超過一個字的請求。 */
const LIMIT_CASES: [string, string, Record<string, unknown>][] = [
  ["status target 100", "/api/home/status", { target: x(100) }],
  ["status target 101", "/api/home/status", { target: x(101) }],
  ["status metric 40", "/api/home/status", { target: "客廳", metric: "m".repeat(40) }],
  ["status metric 41", "/api/home/status", { target: "客廳", metric: "m".repeat(41) }],
  ["control target 100", "/api/home/control", { target: x(100), command: "power", value: true }],
  ["control target 101", "/api/home/control", { target: x(101), command: "power", value: true }],
  ["control command 40", "/api/home/control", { target: "客廳主燈", command: "c".repeat(40) }],
  ["control command 41", "/api/home/control", { target: "客廳主燈", command: "c".repeat(41) }],
  ["control value 40", "/api/home/control", { target: "客廳主燈", command: "color", value: "v".repeat(40) }],
  ["control value 41", "/api/home/control", { target: "客廳主燈", command: "color", value: "v".repeat(41) }],
];

describe("特徵：家電參數長度上限（/api/home/status、/api/home/control 與整合層 Facade 的 schema）", () => {
  it("Facade 的 inputSchema", () => {
    expect(JSON.stringify(new HomeAdapter(bridge([])).tools().map((t) => ({ id: t.id, inputSchema: t.inputSchema })))).toMatchSnapshot("home adapter schemas");
  });

  it.each([false, true])("狀態碼、回應內容與有沒有送到中控（Facade %s）", async (facade) => {
    const { post, seen } = await core(facade);
    const results: Record<string, unknown> = {};
    for (const [label, path, body] of LIMIT_CASES) {
      const before = seen.length;
      const res = await post(path, body);
      results[label] = { ...res, reachedHub: seen.length > before };
    }
    expect(results).toMatchSnapshot("home limits");
    // 超過上限的一律 400，而且沒有送到中控
    for (const label of ["status target 101", "status metric 41", "control target 101", "control command 41", "control value 41"]) {
      expect(results[label]).toMatchObject({ status: 400, reachedHub: false });
    }
    expect(results["status target 101"]).toMatchObject({ body: { error: "target or metric is too long" } });
    expect(results["control command 41"]).toMatchObject({ body: { error: "target or command is too long" } });
    expect(results["control value 41"]).toMatchObject({ body: { error: "value must be a short string, a number or a boolean" } });
  });
});

// ─────────────────────────── 單一來源（重構後加入） ───────────────────────────

describe("單一來源：每份名單都和 HOST_TOOL_NAMES 一致", () => {
  const names = [...HOST_TOOL_NAMES].sort();

  it("HOST_TOOL_NAMES 的內容與順序沒有變，名稱不重複", () => {
    expect([...HOST_TOOL_NAMES]).toEqual(CANONICAL);
    expect(new Set(HOST_TOOL_NAMES).size).toBe(HOST_TOOL_NAMES.length);
  });

  it("編譯期：RealtimeToolName、HOST_TIMEOUT_MS 的鍵、工具 schema 的名稱都是 HostToolName", () => {
    expectTypeOf<RealtimeToolName>().toEqualTypeOf<HostToolName>();
    expectTypeOf<keyof typeof HOST_TIMEOUT_MS>().toEqualTypeOf<HostToolName>();
    expectTypeOf<(typeof REALTIME_TOOLS)[number]["name"] | (typeof HOME_STATUS_TOOL)["name"] | (typeof HOME_CONTROL_TOOL)["name"]>().toEqualTypeOf<HostToolName>();
  });

  it("執行期：逾時表、指令表、模型工具表的名稱集合相同", () => {
    expect(Object.keys(HOST_TIMEOUT_MS).sort()).toEqual(names);
    expect(Object.keys(ASK_THE_AI).sort()).toEqual(names);
    expect(buildRealtimeTools({ webSearch: true, home: true, mcp: [] }).map((t) => t.name as string).sort()).toEqual(names);
    expect(liveCallerTools({ webSearch: true, home: true, mcp: [] }).map((t) => (t.type === "function" ? t.name : "")).sort()).toEqual(names);
    // 頁面執行器的分支名稱在上面的「特徵：頁面的工具執行器」比對（對 CANONICAL，而 CANONICAL 等於 HOST_TOOL_NAMES）。
    for (const name of SIDE_EFFECT_TOOLS) expect(HOST_TOOL_NAMES).toContain(name);
  });

  it("保留的差異：recall_memory（核心執行）、整合層與 MCP 不在名單裡", () => {
    expect(HOST_TOOL_NAMES as readonly string[]).not.toContain(RECALL_MEMORY_TOOL.name);
    const extra = buildRealtimeTools(CONFIGS.everything!).map((t) => (t.name ?? t.server_label) as string).filter((n) => !(HOST_TOOL_NAMES as readonly string[]).includes(n));
    expect(extra).toEqual(["recall_memory", "app__mock__echo", "notes"]);
  });

  it("家電參數長度上限只有一份（shared/home.ts HOME_ARG_MAX），Facade 的 schema 引用它", () => {
    expect(HOME_ARG_MAX).toEqual({ target: 100, metric: 40, command: 40, value: 40 });
    const [status, control] = new HomeAdapter(bridge([])).tools();
    expect(status!.inputSchema.properties).toMatchObject({ target: { maxLength: HOME_ARG_MAX.target }, metric: { maxLength: HOME_ARG_MAX.metric } });
    expect(control!.inputSchema.properties).toMatchObject({ target: { maxLength: HOME_ARG_MAX.target }, command: { maxLength: HOME_ARG_MAX.command }, value: { maxLength: HOME_ARG_MAX.value } });
    for (const file of ["../server/app.ts", "../server/integrations/adapters/home.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).toContain("HOME_ARG_MAX.target");
    }
  });
});
