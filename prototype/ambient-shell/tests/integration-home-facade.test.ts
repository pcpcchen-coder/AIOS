import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { HomeBridge, HomeBridgeError, type HomeBridgeOptions } from "../server/home-bridge.ts";
import { HOME_TOOL, HomeAdapter, homeStatusOf, type HomeBridgePort } from "../server/integrations/adapters/home.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { IntegrationRegistry } from "../server/integrations/registry.ts";
import { liveCallerTools } from "../server/live-tool-caller.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { buildRealtimeInstructions, buildRealtimeTools } from "../server/realtime.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";

// AIL-2：家電 Facade 的回歸測試。同一組請求在「整合層 Facade 開著」與「關著（原本直接呼叫 HomeBridge）」各跑一次，
// 比對 HTTP 狀態碼、回應內容與送到中控的每一個請求，必須完全相同（H0 查詢、H1 控制與確認卡、H1b AIFA／紅外線、錯誤與限速）。
// 中控是假的（fixture），設備與讀值是虛構的。

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const NOW_S = 1_792_560_000;
const caps = { modes: ["auto", "cool", "dry"], fan_modes: ["auto", "low", "medium", "high"], swing_modes: ["auto", "fixed_1", "fixed_2", "fixed_3", "fixed_4", "fixed_5"], features: ["normal"], min_temperature: 17, max_temperature: 30 };

type HubMode = "normal" | "unauthorized" | "unreachable" | "stale" | "no_reply";

/** 假中控：記下每個請求（方法、路徑、idempotency key、內容）。 */
function fakeHub(mode: () => HubMode) {
  const seen: string[] = [];
  const hubFetch = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push(`${init.method ?? "GET"} ${url.replace("http://hub.fixture", "")} ${headers.get("idempotency-key") ?? ""} ${init.body ?? ""}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const m = mode();
    if (m === "unreachable") throw new TypeError("fetch failed");
    if (m === "unauthorized") return json({ error: "unauthorized" }, 401);
    if (url.endsWith("/api/v1/home")) {
      return json({
        layout: { rooms: [{ id: "living", name: "客廳" }, { id: "study", name: "書房" }] },
        devices: [
          { id: "th", name: "溫濕度計", placement: { room_id: "living" }, state: { available: true, fresh: true }, telemetry: { metrics: [{ key: "temperature", label: "溫度", unit: "°C", precision: 1, value: 26.5 }, { key: "humidity", label: "濕度", unit: "%", precision: 0, value: 61 }], status: "live", received_at: NOW_S - 90, source_label: "fixture" } },
          { id: "desk", name: "書桌燈", placement: { room_id: "study" }, configured: true, state: { available: true, fresh: true } },
          { id: "lamp", name: "客廳主燈", placement: { room_id: "living" }, configured: true, state: { available: true, fresh: true } },
          { id: "ir-tv", name: "電視", kind: "remote", configured: false, config: { infrared_virtual: true }, infrared: { keys: [{ key: "Vol+", key_id: 2, label: "Vol+" }, { key: "Power", key_id: 1, label: "Power" }], ready: true } },
        ],
        server_time: NOW_S,
      });
    }
    if (url.endsWith("/api/v1/integrations/aifa")) {
      return json({ connected: true, queried_at: NOW_S - 100, items: [{ id: "h1", online: true, children: [{ id: "c1", name: "冷氣", type: "0", sub_type: "0", device_code: "173", capabilities: caps }] }] });
    }
    if (url.endsWith("/status")) return json({ sent: false, status: { power: true, mode: "cool", temperature: 25, fan: "low", swing: "auto", feature: "normal" } });
    if (url.endsWith("/climate") || url.endsWith("/power")) return json({ id: "a", status: "unconfirmed", message: "已透過 AIFA 連線送出（fixture）", controller_status: null });
    if (url.endsWith("/infrared-commands")) return json({ id: "i", status: "unconfirmed", transport_status: "accepted_by_cloud", message: "Tuya 已接受紅外線指令（fixture）" });
    if (url.endsWith("/commands")) {
      if (m === "stale") return json({ error: "state_stale" }, 409);
      if (m === "no_reply") throw new TypeError("socket hang up");
      return json({ id: "c", status: "confirmed", message: "設備回讀已確認" });
    }
    return json({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { fetch: hubFetch, seen };
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** 一個 Nous 核心（facade 開或關）＋它自己的假中控與 HomeBridge（確定性的 ID 與時間）。 */
async function core(facade: boolean, opts: { configured?: boolean; mode?: () => HubMode; policy?: HomeBridgeOptions["policyFor"] } = {}) {
  const hub = fakeHub(opts.mode ?? (() => "normal"));
  let n = 0;
  let clock = NOW_S * 1000;
  const bridge = new HomeBridge({
    url: opts.configured === false ? null : "http://hub.fixture",
    token: opts.configured === false ? null : "hub-secret",
    fetch: hub.fetch,
    newId: () => `id${++n}`,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ...(opts.policy ? { policyFor: opts.policy } : {}),
  });
  const audit: string[] = [];
  const ail = facade ? createIntegrations({ enabled: true, services: ["home"], soloistPort: 19090 }, (l) => audit.push(l), undefined, { home: bridge }) : null;
  const store = new TaskStore(null);
  const dir = mkdtempSync(join(tmpdir(), "nous-home-facade-"));
  const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
  const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
  const port = await freePort();
  const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, home: bridge, ...(ail ? { integrations: ail } : {}), port, devPort: 5173, distDir: null });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://localhost:${port}`;
  const post = async (path: string, body: unknown, locale?: string) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(locale ? { "X-Nous-Locale": locale } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { post, hub, ail, audit, base, advance: (ms: number) => void (clock += ms) };
}

type Step = [path: string, body: unknown, locale?: string] | ["advance", number];

/** 同一組步驟在 facade 關、開各跑一次：每一步的狀態碼與內容、中控收到的請求都要相同。 */
async function sameBothWays(steps: Step[], opts: Parameters<typeof core>[1] = {}) {
  const run = async (facade: boolean) => {
    const c = await core(facade, opts);
    const out: unknown[] = [];
    for (const [path, body, locale] of steps) {
      if (path === "advance") c.advance(body as number);
      else out.push(await c.post(path, body, locale));
    }
    return { out, hub: c.hub.seen, ail: c.ail, audit: c.audit.filter((l) => l.includes("app.home.")) };
  };
  const before = await run(false);
  const after = await run(true);
  expect(after.out).toEqual(before.out);
  expect(after.hub).toEqual(before.hub);
  expect(JSON.stringify(after.out)).not.toContain("hub-secret");
  return { before, after };
}

describe("AIL-2 home Facade: HTTP responses and hub traffic identical with and without the integration layer", () => {
  it("H0 status: room, device, metric, unknown metric, not found, ambiguous", async () => {
    const { after } = await sameBothWays([
      ["/api/home/status", { target: "客廳", metric: "temperature" }],
      ["/api/home/status", { target: "溫濕度計" }],
      ["/api/home/status", { target: "客廳", metric: "" }],
      ["/api/home/status", { target: "客廳", metric: "pm25" }],
      ["/api/home/status", { target: "陽台" }],
      ["/api/home/status", { target: "燈" }],
      ["/api/home/status", { target: "全家" }],
    ]);
    expect((after.out[0] as { body: { status: string } }).body.status).toBe("ok");
    // 真的經過整合層：Facade 已註冊、可用，七個請求各有一筆 Dispatcher 稽核；關著時一筆都沒有。
    expect(after.ail!.registry.status(HOME_TOOL.status, "page")).toBe("available");
    expect(after.audit).toHaveLength(7);
    expect(after.audit.every((l) => l.includes("app.home.status page →"))).toBe(true);
  });

  it("H1 control: confirmed, invalid value, not found, room-level ambiguity", async () => {
    await sameBothWays([
      ["/api/home/control", { target: "書桌燈", command: "brightness", value: "60" }],
      ["/api/home/control", { target: "書桌燈", command: "power", value: true }],
      ["/api/home/control", { target: "書桌燈", command: "brightness", value: 60 }],
      ["/api/home/control", { target: "書桌燈", command: "brightness", value: "200" }],
      ["/api/home/control", { target: "書桌燈", command: "teleport" }],
      ["/api/home/control", { target: "陽台燈", command: "power", value: true }],
      ["/api/home/control", { target: "客廳", command: "power", value: false }],
    ]);
  });

  it("H1 hub states: stale device (409) and no reply (unconfirmed, maybe executed)", async () => {
    await sameBothWays([["/api/home/control", { target: "書桌燈", command: "power", value: true }]], { mode: () => "stale" });
    await sameBothWays([["/api/home/control", { target: "書桌燈", command: "power", value: true }]], { mode: () => "no_reply" });
  });

  it("H1 confirmation card: needs_confirmation, approve, repeat approve (same result), decline, expired, unknown id", async () => {
    const policy: HomeBridgeOptions["policyFor"] = () => "confirm";
    const { after } = await sameBothWays([
      ["/api/home/control", { target: "書桌燈", command: "power", value: false }],
      ["/api/home/confirm", { confirm_id: "home_id2", approve: true }],
      ["/api/home/confirm", { confirm_id: "home_id2", approve: true }],
      ["/api/home/control", { target: "客廳主燈", command: "power", value: true }],
      ["/api/home/confirm", { confirm_id: "home_id4", approve: false }],
      ["/api/home/control", { target: "客廳主燈", command: "power", value: true }],
      ["advance", 120_000],
      ["/api/home/confirm", { confirm_id: "home_id6", approve: true }],
      ["/api/home/confirm", { confirm_id: "home_nope", approve: true }],
    ], { policy });
    expect((after.out[0] as { body: { status: string } }).body.status).toBe("needs_confirmation");
    expect(after.audit.filter((l) => l.includes("app.home.confirm"))).toHaveLength(5);
    expect((after.out[1] as { body: { status: string } }).body.status).toBe("confirmed");
  });

  it("H1 voice policy off: refused, nothing sent", async () => {
    await sameBothWays([["/api/home/control", { target: "書桌燈", command: "power", value: true }]], { policy: () => "off" });
  });

  it("H1b AIFA air conditioner and infrared keys (one-way, unconfirmed)", async () => {
    await sameBothWays([
      ["/api/home/control", { target: "冷氣", command: "ac_swing", value: "fixed_3" }],
      ["/api/home/control", { target: "冷氣", command: "ac_temperature", value: "26" }],
      ["/api/home/control", { target: "冷氣", command: "power", value: false }],
      ["/api/home/control", { target: "電視", command: "press", value: "volume_up" }],
      ["/api/home/control", { target: "電視", command: "power", value: true }],
    ]);
  });

  it("HomeBridge's own rate limit (7th command in a minute) is unchanged; the integration layer adds no limit (35 status queries)", async () => {
    const control = Array.from({ length: 8 }, (): Step => ["/api/home/control", { target: "書桌燈", command: "power", value: true }]);
    const { after } = await sameBothWays(control);
    expect((after.out[6] as { body: { status: string; reason: string } }).body).toMatchObject({ status: "refused", reason: "rate_limited" });
    const status = Array.from({ length: 35 }, (): Step => ["/api/home/status", { target: "書房" }]);
    const { after: s } = await sameBothWays(status);
    expect(s.out.every((r) => (r as { status: number }).status === 200)).toBe(true);
  });

  it("hub errors map to the same HTTP status and message: token rejected (401→502), unreachable (502)", async () => {
    await sameBothWays([["/api/home/status", { target: "客廳" }], ["/api/home/control", { target: "書桌燈", command: "power", value: true }]], { mode: () => "unauthorized" });
    await sameBothWays([["/api/home/status", { target: "客廳" }], ["/api/home/control", { target: "書桌燈", command: "power", value: true }]], { mode: () => "unreachable" });
  });

  it("edge values pass through unchanged: value null / 0 / \"\" / false, metric with spaces, English error bodies", async () => {
    await sameBothWays([
      ["/api/home/control", { target: "書桌燈", command: "power", value: null }],
      ["/api/home/control", { target: "書桌燈", command: "brightness", value: 0 }],
      ["/api/home/control", { target: "書桌燈", command: "brightness", value: "" }],
      ["/api/home/control", { target: "書桌燈", command: "power", value: false }],
      ["/api/home/control", { target: "  書桌燈  ", command: " power ", value: "true" }],
      ["/api/home/status", { target: "客廳", metric: "   " }],
      ["/api/home/status", { target: "客廳", metric: 5 }],
      ["/api/home/status", { target: "客廳" }, "en"],
      ["/api/home/control", { target: "x".repeat(101), command: "power" }, "en"],
    ]);
    await sameBothWays([["/api/home/status", { target: "客廳" }, "en"], ["/api/home/control", { target: "書桌燈", command: "power", value: true }, "en"]], { mode: () => "unauthorized" });
  });

  it("an unexpected (non-HomeBridgeError) throw keeps the original 500 and message", async () => {
    const policy: HomeBridgeOptions["policyFor"] = () => {
      throw new Error("policy bug (fixture)");
    };
    const { after } = await sameBothWays([["/api/home/control", { target: "書桌燈", command: "power", value: true }]], { policy });
    expect(after.out[0]).toEqual({ status: 500, body: { error: "policy bug (fixture)" } });
  });

  it("input validation and not-configured hub are unchanged (400 / 409), and the Facade is not registered without a hub", async () => {
    const steps: Step[] = [
      ["/api/home/status", { target: "" }],
      ["/api/home/status", { target: "x".repeat(101) }],
      ["/api/home/control", { target: "書桌燈" }],
      ["/api/home/control", { target: "書桌燈", command: "power", value: { on: true } }],
      ["/api/home/control", { target: "書桌燈", command: "power", value: "x".repeat(41) }],
      ["/api/home/confirm", { confirm_id: "home_x" }],
      ["/api/home/confirm", { confirm_id: "other", approve: true }],
    ];
    await sameBothWays(steps);
    const { after } = await sameBothWays([...steps, ["/api/home/status", { target: "客廳" }], ["/api/home/control", { target: "書桌燈", command: "power", value: true }], ["/api/home/confirm", { confirm_id: "home_x", approve: true }]], { configured: false });
    expect(after.ail!.registry.adapters()).toEqual([]);
  });
});

describe("AIL-2 home Facade: model-facing tools and settings unchanged", () => {
  it("home_status/home_control stay the original definitions; no app__home tool reaches either route; settings tool list has none", async () => {
    const c = await core(true);
    const integrations = (l: "zh-TW" | "en") => c.ail!.registry.functionSpecs("api_key", l);
    const live = (l: "zh-TW" | "en") => c.ail!.registry.functionSpecs("live", l);
    const caps = { webSearch: true, mcp: [], home: true, taskWebSearch: true };
    for (const locale of ["zh-TW", "en"] as const) {
      expect(JSON.stringify(buildRealtimeTools({ ...caps, integrations }, locale))).toBe(JSON.stringify(buildRealtimeTools(caps, locale)));
      expect(JSON.stringify(liveCallerTools({ ...caps, integrations: live }, locale))).toBe(JSON.stringify(liveCallerTools(caps, locale)));
      expect(buildRealtimeInstructions([], new Date(0), { ...caps, integrations }, locale)).toBe(buildRealtimeInstructions([], new Date(0), caps, locale));
    }
    const settings = (await (await fetch(`${c.base}/api/settings`)).json()) as { integrations?: { tools: string[] } };
    expect(settings.integrations).toEqual({ tools: [] });
    expect(c.ail!.registry.modelToolCount("home")).toBe(0);
    // 模型就算用 app__ 名稱也叫不到（只接受 page 路徑）。
    expect(await c.ail!.dispatcher.execute({ tool: "app__home__control", args: { target: "書桌燈", command: "power" }, route: "live", actor: "agent", sessionId: "s" })).toMatchObject({ status: "refused", reason: "route_not_supported" });
    expect(c.hub.seen).toEqual([]);
  });

  it("audit lines carry no target, command or value", async () => {
    const lines: string[] = [];
    const hub = fakeHub(() => "normal");
    const bridge = new HomeBridge({ url: "http://hub.fixture", token: "hub-secret", fetch: hub.fetch, newId: () => "k" });
    const ail = createIntegrations({ enabled: true, services: ["home"], soloistPort: 19090 }, (l) => lines.push(l), undefined, { home: bridge })!;
    const r = await ail.dispatcher.execute({ tool: HOME_TOOL.control, args: { target: "書桌燈", command: "brightness", value: "60" }, route: "page", actor: "agent", sessionId: "page" });
    expect(r.status).toBe("confirmed");
    expect(lines.join("\n")).toMatch(/app\.home\.control page → confirmed/);
    // 稽核行帶隨機 request-id（8 位十六進位）與毫秒數，可能剛好含「60」：先拿掉這兩個欄位再檢查參數有沒有外洩。
    const scrubbed = lines.map((l) => l.replace(/^整合層：[0-9a-f]{8} /, "整合層：<id> ").replace(/ \d+ ms$/, " <n> ms"));
    expect(scrubbed.join("\n")).not.toMatch(/書桌燈|brightness|60|hub-secret/);
  });
});

describe("AIL-2 home Facade: the integration layer's own safety timeout", () => {
  it("a HomeBridge that never finishes: control → 504 'unclear whether it ran' (English page gets English), status → 502", async () => {
    class HangingBridge extends HomeBridge {
      override control(): Promise<never> {
        return new Promise(() => undefined);
      }
      override status(): Promise<never> {
        return new Promise(() => undefined);
      }
    }
    const bridge = new HangingBridge({ url: "http://hub.fixture", token: "hub-secret", fetch: fakeHub(() => "normal").fetch });
    const ail = createIntegrations({ enabled: true, services: ["home"], soloistPort: 19090 }, () => undefined, { home: (_c, _l, d) => new HomeAdapter(d.home!, { control: 150, status: 150 }) }, { home: bridge })!;
    const store = new TaskStore(null);
    const dir = mkdtempSync(join(tmpdir(), "nous-home-hang-"));
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const port = await freePort();
    const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, home: bridge, integrations: ail, port, devPort: 5173, distDir: null });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const post = (path: string, body: unknown, locale?: string) => fetch(`http://localhost:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(locale ? { "X-Nous-Locale": locale } : {}) }, body: JSON.stringify(body) });
    const zh = await post("/api/home/control", { target: "書桌燈", command: "power", value: true });
    expect(zh.status).toBe(504);
    expect(await zh.json()).toEqual({ error: "武陵居中控沒有在時限內回覆，不確定有沒有執行，請看一下設備。" });
    const en = await post("/api/home/control", { target: "書桌燈", command: "power", value: true }, "en");
    expect(await en.json()).toEqual({ error: "The Wuling home hub did not reply in time; it is unclear whether the command ran, so please check the device." });
    const status = await post("/api/home/status", { target: "客廳" }, "en");
    expect(status.status).toBe(502);
    expect(((await status.json()) as { error: string }).error).toMatch(/did not reply in time/);
  });
});

describe("HomeAdapter unit", () => {
  const port = (patch: Partial<HomeBridgePort>): HomeBridgePort => ({
    available: true,
    probe: async () => undefined,
    status: async () => ({ ok: true, status: "not_found", target: "x" }),
    control: async () => ({ ok: true, status: "refused", reason: "invalid_value", message: "m" }),
    confirm: async () => ({ ok: true, status: "refused", reason: "expired", message: "m" }),
    ...patch,
  });

  it("maps HomeBridge statuses for audit; only ok/confirmed count as confirmed", () => {
    expect(homeStatusOf({ ok: true, status: "ok", scope: "s", devices: [], truncated: false })).toBe("confirmed");
    expect(homeStatusOf({ ok: true, status: "unconfirmed", why: "one_way", action: "a", message: "m", device: "d", room: null } as never)).toBe("unconfirmed");
    expect(homeStatusOf({ ok: true, status: "needs_confirmation", confirm_id: "home_1", action: "a", expires_in_s: 90, device: "d", room: null })).toBe("needs_confirmation");
    expect(homeStatusOf({ ok: true, status: "ambiguous", candidates: [] })).toBe("refused");
    expect(homeStatusOf({ ok: true, status: "failed", reason: "device", action: "a", message: "m", device: "d", room: null } as never)).toBe("failed");
  });

  it("health: not configured / reachable / rejected / other errors", async () => {
    expect(await new HomeAdapter(port({ available: false })).health()).toEqual({ health: "unavailable", reason: "not_configured" });
    expect(await new HomeAdapter(port({})).health()).toEqual({ health: "available", reason: "ok" });
    expect(await new HomeAdapter(port({ probe: async () => { throw new HomeBridgeError("無法連線到武陵居中控，請確認中控有在執行、位址正確。", 502); } })).health()).toEqual({ health: "unavailable", reason: "connection_refused" });
    expect(await new HomeAdapter(port({ probe: async () => { throw new HomeBridgeError("武陵居中控沒有回應（逾時）。", 502); } })).health()).toEqual({ health: "unknown", reason: "timeout" });
    expect(await new HomeAdapter(port({ probe: async () => { throw new HomeBridgeError("武陵居中控拒絕了權杖（401），請到中控「系統接入」重新核發後更新 SMARTHOME_TOKEN。", 502); } })).health()).toEqual({ health: "unavailable", reason: "error" });
    expect(await new HomeAdapter(port({ probe: async () => { throw new HomeBridgeError("武陵居中控回傳的資料格式不符，無法讀取。", 502); } })).health()).toEqual({ health: "unknown", reason: "bad_reply" });
    expect(await new HomeAdapter(port({ probe: async () => { throw new HomeBridgeError("x", 409); } })).health()).toEqual({ health: "unavailable", reason: "not_configured" });
    expect(await new HomeAdapter(port({ probe: async () => { throw new Error("boom"); } })).health()).toEqual({ health: "unknown", reason: "error" });
  });

  it("legacy results and HomeBridgeError pass through untouched; other errors are left to the dispatcher (control → unknown)", async () => {
    const legacy = { ok: true as const, status: "confirmed" as const, action: "開啟", message: "設備回讀已確認", device: "書桌燈", room: "書房" };
    const a = new HomeAdapter(port({ control: async () => legacy }));
    expect(await a.execute(HOME_TOOL.control, { target: "書桌燈", command: "power", value: true })).toEqual({ ok: true, status: "confirmed", message: "home", data: { legacy } });
    const e = new HomeAdapter(port({ status: async () => { throw new HomeBridgeError("無法連線到武陵居中控", 502); } }));
    expect(await e.execute(HOME_TOOL.status, { target: "客廳" })).toMatchObject({ status: "failed", data: { http_error: { status: 502, message: "無法連線到武陵居中控" } } });
    const registry = new IntegrationRegistry({ enabled: new Set(["home"]) });
    registry.register(new HomeAdapter(port({ control: async () => { throw new Error("boom"); } })));
    const { IntegrationDispatcher } = await import("../server/integrations/dispatcher.ts");
    expect(await new IntegrationDispatcher(registry).execute({ tool: HOME_TOOL.control, args: { target: "a", command: "b" }, route: "page", actor: "agent", sessionId: "page" })).toMatchObject({ status: "unknown", reason: "adapter_error" });
  });

  it("registry: legacy tools may use scalar and up to 90 s; model tools may not", async () => {
    const r = new IntegrationRegistry({ enabled: new Set(["home"]) });
    r.register(new HomeAdapter(port({})));
    expect(r.functionSpecs("api_key")).toEqual([]);
    const { MockAdapter, MOCK_TOOLS } = await import("../server/integrations/adapters/mock.ts");
    const scalarModelTool = { ...MOCK_TOOLS[0]!, id: "app.mock.scalar" as const, inputSchema: { type: "object" as const, properties: { v: { type: "scalar" as const } }, additionalProperties: false as const } };
    const r2 = new IntegrationRegistry({ enabled: new Set(["mock"]) });
    expect(() => r2.register(new MockAdapter({ extraTools: [scalarModelTool] }))).toThrow(/scalar/);
    // legacyName ⇔ 只走 page：模型工具不能借 page 路徑，legacy 工具也不能開放給語音路徑。
    const pageModelTool = { ...MOCK_TOOLS[0]!, id: "app.mock.page" as const, supportedRoutes: ["page"] as const };
    expect(() => new IntegrationRegistry({ enabled: new Set(["mock"]) }).register(new MockAdapter({ extraTools: [pageModelTool as never] }))).toThrow(/page/);
    const legacyOnLive = { ...MOCK_TOOLS[0]!, id: "app.mock.legacy" as const, legacyName: "legacy_tool", supportedRoutes: ["live"] as const };
    expect(() => new IntegrationRegistry({ enabled: new Set(["mock"]) }).register(new MockAdapter({ extraTools: [legacyOnLive as never] }))).toThrow(/page/);
    const slowModelTool = { ...MOCK_TOOLS[0]!, id: "app.mock.slow" as const, timeoutMs: 80_000 };
    expect(() => new IntegrationRegistry({ enabled: new Set(["mock"]) }).register(new MockAdapter({ extraTools: [slowModelTool] }))).toThrow(/timeoutMs/);
  });
});
