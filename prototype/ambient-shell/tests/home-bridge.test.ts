import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseHttpUrl } from "../server/config.ts";
import { HomeBridge, HomeBridgeError, metricKey, parseCommand, parseHome, report, resolveTarget, type HomeBridgeOptions, type VoicePolicy } from "../server/home-bridge.ts";
import { buildRealtimeInstructions, buildRealtimeTools, HOME_CONTROL_TOOL } from "../server/realtime.ts";
import { HOME_COMMANDS, homeControlLine, homeControlNotice, homeStatusLine, type HomeControlResult, type HomeStatusResult } from "../shared/home.ts";

// 假中控（fixture）：欄位名稱照武陵居中控 GET /api/v1/home 的實際回應，設備與讀值是虛構的，不代表真實家裡。

const TOKEN = "hub-token-fixture";
const NOW = 1_792_560_000; // 2026-10-21 05:20 UTC = 13:20 Asia/Taipei

const metric = (key: string, label: string, unit: string, precision: number, value: number | string | null) => ({
  key,
  code: key,
  label,
  unit,
  precision,
  group: "environment",
  value,
  alarm: false,
});

const HOME = {
  schema_version: 1,
  name: "武陵居",
  layout: {
    rooms: [
      { id: "living", name: "客廳", color: "#cfba9b", polygon: [] },
      { id: "study", name: "書房（示例）", color: "#afc2c4", polygon: [] },
      { id: "master", name: "主臥", color: "#ccc", polygon: [] },
    ],
  },
  devices: [
    {
      id: "th-1",
      name: "溫濕度計",
      kind: "sensor",
      aliases: [],
      placement: { room_id: "living", x: 0.3, y: 0.4, z: 1, confirmed: true },
      state: { available: true, fresh: true, observed_at: NOW - 120, age_seconds: 120 },
      telemetry: {
        metrics: [metric("temperature", "溫度", "°C", 1, 26.53), metric("humidity", "濕度", "%", 0, 62)],
        status: "live",
        received_at: NOW - 120,
        source_label: "Tuya 區網",
      },
    },
    {
      id: "light-main",
      name: "客廳主燈",
      kind: "light",
      aliases: ["客廳燈"],
      placement: { room_id: "living" },
      state: { available: true, fresh: true },
      telemetry: null,
    },
    { id: "light-floor", name: "客廳立燈", kind: "light", placement: { room_id: "living" }, state: { available: false, fresh: false }, telemetry: null },
    {
      id: "air-1",
      name: "空氣感測器",
      kind: "sensor",
      placement: { room_id: "study" },
      state: { available: null, fresh: false },
      telemetry: {
        metrics: [metric("co2", "二氧化碳", "ppm", 0, null), metric("pm25", "PM2.5", "μg/m³", 0, 12)],
        status: "snapshot",
        received_at: NOW - 600,
        source_label: "Tuya 雲端快照",
      },
    },
    {
      id: "dh-1",
      name: "除濕機",
      kind: "dehumidifier",
      placement: null,
      state: { available: true, fresh: false },
      telemetry: { metrics: [metric("humidity", "濕度", "%", 0, 55)], status: "stale", received_at: NOW - 7200, source_label: "LG ThinQ" },
    },
    {
      id: "new-sensor",
      name: "新感測器",
      kind: "sensor",
      placement: { room_id: "master" },
      state: { available: null, fresh: false },
      telemetry: { metrics: [metric("temperature", "溫度", "°C", 1, null)], status: "missing", received_at: null, source_label: "尚無讀值" },
    },
  ],
  server_time: NOW,
};

interface HubRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Reply {
  status: number;
  body: unknown;
  /** 模擬中控回讀很慢：延遲這麼久才回覆。 */
  delayMs?: number;
}

interface Hub {
  url: string;
  requests: HubRequest[];
  close(): Promise<void>;
}

const hubs: Server[] = [];
afterEach(async () => {
  await Promise.all(
    hubs.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise((r) => s.close(r));
    }),
  );
});

async function fakeHub(handler?: (req: HubRequest) => Reply | undefined, home: unknown = HOME): Promise<Hub> {
  const requests: HubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const seen: HubRequest = { method: req.method ?? "GET", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(seen);
      const reply =
        handler?.(seen) ??
        (req.headers.authorization !== `Bearer ${TOKEN}`
          ? { status: 401, body: { detail: { code: "authentication_required" } } }
          : req.url === "/api/v1/home"
            ? { status: 200, body: home }
            : { status: 404, body: {} });
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  hubs.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

const bridge = (url: string | null, token: string | null = TOKEN) => new HomeBridge({ url, token, timeZone: "Asia/Taipei" });
const home = parseHome(HOME);

describe("HomeBridge.status against a fake hub", () => {
  it("reads a room's temperature with the hub's time, freshness and source", async () => {
    const hub = await fakeHub();
    const result = await bridge(hub.url).status("客廳", "temperature");
    expect(result).toEqual({
      ok: true,
      status: "ok",
      scope: "客廳",
      truncated: false,
      devices: [
        {
          device: "溫濕度計",
          room: "客廳",
          online: "在線",
          data: "即時",
          time: "13:18",
          minutes_ago: 2,
          source: "Tuya 區網",
          readings: [{ name: "溫度", value: 26.5, unit: "°C" }],
        },
      ],
    });
    expect(hub.requests[0].url).toBe("/api/v1/home");
    expect(hub.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps a missing value as null and labels a snapshot, never turning it into 0 or live", async () => {
    const hub = await fakeHub();
    const result = await bridge(hub.url).status("書房", "co2");
    expect(result).toMatchObject({ status: "ok", devices: [{ data: "快照", time: "13:10", readings: [{ name: "二氧化碳", value: null }] }] });
    expect(homeStatusLine(result)).toBe("書房（示例） 空氣感測器：二氧化碳沒有讀值（快照 13:10）");
  });

  it("returns ambiguous candidates instead of guessing which light", async () => {
    const hub = await fakeHub();
    expect(await bridge(hub.url).status("客廳的燈")).toEqual({ ok: true, status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] });
  });

  it("says not_found and no_such_reading plainly", async () => {
    const hub = await fakeHub();
    expect(await bridge(hub.url).status("車庫")).toEqual({ ok: true, status: "not_found", target: "車庫" });
    expect(await bridge(hub.url).status("主臥", "co2")).toEqual({ ok: true, status: "no_such_reading", scope: "主臥", metric: "二氧化碳" });
  });

  it("never puts the token in what goes back to the browser or the model", async () => {
    const hub = await fakeHub();
    const raw = JSON.stringify(await bridge(hub.url).status("全家"));
    expect(raw).not.toContain(TOKEN);
    expect(bridge(hub.url).detail).not.toContain(TOKEN);
  });

  it("explains a rejected token, an unreachable hub, a hub error and a malformed reply", async () => {
    const hub = await fakeHub();
    await expect(bridge(hub.url, "wrong").status("客廳")).rejects.toThrow(/401/);

    const down = await fakeHub();
    await down.close();
    await expect(bridge(down.url).status("客廳")).rejects.toThrow(/無法連線到武陵居中控/);

    const broken = await fakeHub(() => ({ status: 500, body: {} }));
    await expect(bridge(broken.url).status("客廳")).rejects.toThrow(/HTTP 500/);

    const odd = await fakeHub(() => ({ status: 200, body: { items: [] } }));
    const err = await bridge(odd.url).status("客廳").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomeBridgeError);
    expect((err as HomeBridgeError).message).toContain("格式不符");
  });

  it("is unavailable until both SMARTHOME_URL and SMARTHOME_TOKEN are set", async () => {
    expect(bridge(null).available).toBe(false);
    expect(bridge("http://127.0.0.1:8788", null).detail).toBe("未設定 SMARTHOME_TOKEN");
    await expect(bridge(null).status("客廳")).rejects.toMatchObject({ status: 409 });
  });
});

describe("resolveTarget (deterministic name matching until the hub has /resolve)", () => {
  const scope = (target: string) => {
    const r = resolveTarget(home, target);
    return r.kind === "match" ? { scope: r.scope, ids: r.devices.map((d) => d.id), metric: r.metric } : r.kind;
  };

  it("matches whole home, exact names and aliases, rooms, and room + device", () => {
    expect(scope("全家")).toMatchObject({ scope: "全家", ids: HOME.devices.map((d) => d.id) });
    expect(scope("客廳燈")).toEqual({ scope: "客廳主燈", ids: ["light-main"], metric: null });
    expect(scope("客廳")).toEqual({ scope: "客廳", ids: ["th-1", "light-main", "light-floor"], metric: null });
    expect(scope("書房")).toMatchObject({ scope: "書房（示例）", ids: ["air-1"] });
    expect(scope("客廳的溫濕度計")).toMatchObject({ ids: ["th-1"] });
  });

  it("takes the reading out of the target (「客廳溫度」)", () => {
    expect(scope("客廳溫度")).toEqual({ scope: "客廳", ids: ["th-1", "light-main", "light-floor"], metric: "temperature" });
    expect(scope("家裡的濕度")).toMatchObject({ scope: "全家", metric: "humidity" });
  });

  it("reports ambiguity and misses instead of picking one", () => {
    expect(scope("燈")).toBe("ambiguous");
    expect(scope("車庫")).toBe("not_found");
  });
});

describe("review regressions", () => {
  const dev = (id: string, name: string, room: string, telemetry: unknown = null) => ({
    id,
    name,
    placement: { room_id: room },
    state: { available: true, fresh: true },
    telemetry,
  });
  const tele = (metrics: unknown[], status = "live", received_at = NOW - 60) => ({ metrics, status, received_at, source_label: "fixture" });
  const house = parseHome({
    layout: {
      rooms: [
        { id: "m", name: "主臥" },
        { id: "mb", name: "主臥浴室" },
        { id: "m2", name: "主臥室" },
        { id: "court", name: "中庭" },
        { id: "inner", name: "內室" },
      ],
    },
    devices: [
      dev("dh-m", "除濕機", "m"),
      dev("dh-mb", "除濕機", "mb"),
      dev("ac-m2", "冷氣", "m2"),
      dev("court-light", "中庭燈", "court"),
      dev("court-sensor", "感測器", "court", tele([metric("temperature", "溫度", "°C", 1, 20)])),
      dev("inner-sensor", "人體感測", "inner", tele([metric("motion", "人體感應", "", 0, true as unknown as number)], "estimated")),
      dev("old", "舊溫度計", "inner", tele([metric("temperature", "溫度", "°C", 1, 18)], "stale", NOW - 3 * 86400)),
    ],
    server_time: NOW,
  });
  const ids = (target: string) => {
    const r = resolveTarget(house, target);
    return r.kind === "match" ? r.devices.map((d) => d.id) : r.kind;
  };

  it("prefers the longest room name in the target", () => {
    expect(ids("主臥浴室除濕機")).toEqual(["dh-mb"]);
    expect(ids("主臥浴室的除濕機")).toEqual(["dh-mb"]);
    expect(ids("主臥除濕機")).toEqual(["dh-m"]);
    expect(ids("主臥室冷氣")).toEqual(["ac-m2"]);
  });

  it("keeps leading 中／內 in names and matches the room first", () => {
    expect(ids("中庭")).toEqual(["court-light", "court-sensor"]);
    expect(ids("內室")).toEqual(["inner-sensor", "old"]);
    expect(resolveTarget(house, "中庭溫度")).toMatchObject({ kind: "match", scope: "中庭", metric: "temperature" });
  });

  it("adds the date to readings that are not from today", () => {
    const r = report(house, house.devices.find((d) => d.id === "old")!, null, "Asia/Taipei");
    expect(r).toMatchObject({ data: "過期資料", time: "10/18 13:20", minutes_ago: 4320 });
  });

  it("keeps boolean readings and labels an unknown hub status with values as stale", () => {
    const r = report(house, house.devices.find((d) => d.id === "inner-sensor")!, null, "Asia/Taipei");
    expect(r).toMatchObject({ data: "過期資料", readings: [{ name: "人體感應", value: true }] });
    expect(homeStatusLine({ ok: true, status: "ok", scope: "內室", truncated: false, devices: [r] })).toContain("人體感應：是");
  });

  it("does not fall back to every reading when the metric is unknown", async () => {
    const hub = await fakeHub();
    expect(await bridge(hub.url).status("客廳", "noise")).toEqual({ ok: true, status: "no_such_reading", scope: "客廳", metric: "noise" });
  });
});

describe("metric names", () => {
  it("accepts the tool enum and the spoken words", () => {
    expect(metricKey("temperature")).toBe("temperature");
    expect(metricKey("溫度")).toBe("temperature");
    expect(metricKey("溼度")).toBe("humidity");
    expect(metricKey("CO2")).toBe("co2");
    expect(metricKey("風速")).toBeNull();
  });
});

describe("homeStatusLine", () => {
  it("shows live readings with their time, and device state for non-sensors", () => {
    const ok: HomeStatusResult = {
      ok: true,
      status: "ok",
      scope: "客廳",
      truncated: false,
      devices: [
        { device: "溫濕度計", room: "客廳", online: "在線", data: "即時", time: "13:18", minutes_ago: 2, source: null, readings: [{ name: "溫度", value: 26.5, unit: "°C" }] },
        { device: "客廳主燈", room: "客廳", online: "在線", data: null, time: null, minutes_ago: null, source: null, readings: [] },
      ],
    };
    expect(homeStatusLine(ok)).toBe("客廳 溫濕度計：溫度 26.5 °C（13:18）；客廳 客廳主燈：在線");
    expect(homeStatusLine({ ok: true, status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] })).toBe("要查哪一個：客廳主燈、客廳立燈");
  });
});

describe("realtime session with the hub configured", () => {
  it("offers home_status and home_control only when the hub is configured, with the control rules", () => {
    const names = buildRealtimeTools({ webSearch: false, mcp: [], home: true }).map((t) => t.name);
    expect(names).toContain("home_status");
    expect(names).toContain("home_control");
    expect(buildRealtimeTools({ webSearch: false, mcp: [] }).map((t) => t.name)).not.toContain("home_control");
    const text = buildRealtimeInstructions([], new Date(), { webSearch: false, mcp: [], home: true });
    expect(text).toContain("home_status");
    expect(text).toContain("home_control");
    expect(text).not.toContain("不能開關或調整家電");
    expect(text).toContain("冷氣溫度");
    expect(text).toContain("不要說成功");
    expect(buildRealtimeInstructions([], new Date(), { webSearch: false, mcp: [] })).not.toContain("home_");
  });

  it("the tool's command enum is HOME_COMMANDS and says air-con and IR are not supported yet", () => {
    expect(HOME_CONTROL_TOOL.parameters.properties.command.enum).toEqual([...HOME_COMMANDS]);
    expect(HOME_CONTROL_TOOL.description).toMatch(/冷氣溫度/);
    expect(HOME_CONTROL_TOOL.description).toMatch(/紅外線/);
  });
});

describe("SMARTHOME_URL", () => {
  it("accepts http(s) on loopback or LAN and rejects credentials in the URL", () => {
    expect(parseHttpUrl("http://127.0.0.1:8788/", "SMARTHOME_URL")).toBe("http://127.0.0.1:8788");
    expect(parseHttpUrl(" http://192.168.1.20:8788 ", "SMARTHOME_URL")).toBe("http://192.168.1.20:8788");
    expect(parseHttpUrl("", "SMARTHOME_URL")).toBeNull();
    expect(() => parseHttpUrl("ftp://hub", "SMARTHOME_URL")).toThrow(/http/);
    expect(() => parseHttpUrl("http://user:pw@hub:8788", "SMARTHOME_URL")).toThrow(/帳號密碼/);
  });
});

// ───────── home_control（docs/12 H1）：假中控照中控 POST /devices/{id}/commands 的實際行為回覆 ─────────

const dev = (id: string, name: string, room: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: "light",
  aliases: [],
  placement: room ? { room_id: room } : null,
  configured: true,
  can_control: true,
  state: { available: true, fresh: true, commands: ["power", "brightness", "temperature", "color"] },
  telemetry: null,
  ...extra,
});

const CONTROL_HOME = {
  layout: { rooms: [{ id: "living", name: "客廳" }, { id: "study", name: "書房" }] },
  devices: [
    dev("light-main", "客廳主燈", "living", { aliases: ["客廳燈"] }),
    dev("light-floor", "客廳立燈", "living"),
    dev("desk", "書桌燈", "study"),
    // 上一次回讀逾時：中控標成過期、commands 清空（can_control false），但送出後由中控決定，不在 AIOS 先拒絕。
    dev("bedside", "床頭燈", null, { can_control: false, state: { available: true, fresh: false, commands: [] } }),
    dev("speaker", "音響", null, { kind: "speaker", configured: false, can_control: false }),
    dev("ir-tv", "電視", null, { kind: "remote", infrared: { keys: [], ready: false, one_way: true }, config: { infrared_virtual: true } }),
  ],
  server_time: NOW,
};

const confirmedBody = (command: string) => ({ id: "hub-cmd-1", device_id: "x", requested_at: NOW, command, status: "confirmed", message: "設備回讀已確認" });
const isCommand = (r: HubRequest) => r.method === "POST" && r.url.endsWith("/commands");
const isRefresh = (r: HubRequest) => r.method === "POST" && r.url.endsWith("/refresh");

/** 假中控：GET /home 回 CONTROL_HOME；控制與重新讀取交給 onCommand／onRefresh（第 n 次，從 1 起算）。 */
async function controlHub(onCommand: (r: HubRequest, n: number) => Reply = (r) => ({ status: 200, body: confirmedBody(JSON.parse(r.body).command) }), onRefresh: (r: HubRequest) => Reply = () => ({ status: 200, body: {} })) {
  let commands = 0;
  const hub = await fakeHub((r) => {
    if (r.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { detail: { code: "authentication_required" } } };
    if (isCommand(r)) return onCommand(r, ++commands);
    if (isRefresh(r)) return onRefresh(r);
    return undefined;
  }, CONTROL_HOME);
  return { ...hub, commands: () => hub.requests.filter(isCommand), refreshes: () => hub.requests.filter(isRefresh) };
}

let clock = 0;
let ids = 0;
function controller(url: string, extra: Partial<HomeBridgeOptions> = {}) {
  clock = 1_000_000;
  ids = 0;
  return new HomeBridge({ url, token: TOKEN, now: () => clock, newId: () => `id${++ids}`, commandTimeoutMs: 150, ...extra });
}

describe("HomeBridge.control against a fake hub", () => {
  it("sends one command with an Idempotency-Key and reports a confirmed readback", async () => {
    const hub = await controlHub();
    const result = await controller(hub.url).control({ target: "客廳主燈", command: "power", value: "false" });
    expect(result).toEqual({ ok: true, status: "confirmed", device: "客廳主燈", room: "客廳", action: "關閉", message: "設備回讀已確認" });
    expect(homeControlLine(result)).toBe("✓ 客廳主燈 關閉：已確認");
    const [post] = hub.commands();
    expect(post.url).toBe("/api/v1/devices/light-main/commands");
    expect(JSON.parse(post.body)).toEqual({ command: "power", value: false });
    expect(post.headers["idempotency-key"]).toBe("nous_id1");
    expect(String(post.headers["idempotency-key"]).length).toBeLessThanOrEqual(128);
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("parses brightness and colour temperature, sending Kelvin as the hub's temperature", async () => {
    const hub = await controlHub();
    const b = controller(hub.url);
    expect(await b.control({ target: "書桌燈", command: "brightness", value: "60%" })).toMatchObject({ status: "confirmed", action: "亮度 60%" });
    expect(await b.control({ target: "書桌燈", command: "color_temperature", value: "3000K" })).toMatchObject({ status: "confirmed", action: "色溫 3000 K" });
    expect(hub.commands().map((r) => JSON.parse(r.body))).toEqual([
      { command: "brightness", value: 60 },
      { command: "temperature", value: 3000 },
    ]);
    // 「26 度」不是色溫：在本機就拒絕，不送到中控。
    expect(await b.control({ target: "書桌燈", command: "color_temperature", value: "26" })).toMatchObject({ status: "refused", reason: "invalid_value", message: expect.stringContaining("冷氣溫度") });
    expect(hub.commands()).toHaveLength(2);
  });

  it("never reports unconfirmed (or a stored accepted record) as success", async () => {
    const hub = await controlHub((r, n) => ({
      status: 200,
      body: { id: "c", command: JSON.parse(r.body).command, status: n === 1 ? "unconfirmed" : "accepted", message: n === 1 ? "易微聯雲端狀態已符合設定；請確認實體反應" : "指令已接受，正在執行與回讀" },
    }));
    const b = controller(hub.url);
    const first = await b.control({ target: "書桌燈", command: "power", value: true });
    expect(first).toMatchObject({ status: "unconfirmed", why: "hub_unverified", message: "易微聯雲端狀態已符合設定；請確認實體反應" });
    expect(homeControlLine(first)).toBe("⏳ 書房 書桌燈 開啟：已送出、未確認");
    expect(homeControlNotice(first)).toContain("不要說成功");
    expect(await b.control({ target: "書桌燈", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "hub_unverified" });
  });

  it("passes the hub's failure message through", async () => {
    const hub = await controlHub(() => ({ status: 200, body: { id: "c", status: "failed", message: "控制未成功，請檢查設備連線與設定" } }));
    const result = await controller(hub.url).control({ target: "書桌燈", command: "power", value: true });
    expect(result).toMatchObject({ status: "failed", reason: "device", message: "控制未成功，請檢查設備連線與設定" });
    expect(homeControlLine(result)).toBe("✕ 書房 書桌燈 開啟：失敗（控制未成功，請檢查設備連線與設定）");
  });

  it("retries a timed-out command once with the same key and body, and uses the stored result", async () => {
    const hub = await controlHub((_r, n) => ({ status: 200, body: confirmedBody("brightness"), delayMs: n === 1 ? 400 : 0 }));
    const result = await controller(hub.url).control({ target: "客廳主燈", command: "brightness", value: 60 });
    expect(result).toMatchObject({ status: "confirmed" });
    const [a, b] = hub.commands();
    expect(hub.commands()).toHaveLength(2);
    expect(b.headers["idempotency-key"]).toBe(a.headers["idempotency-key"]);
    expect(b.body).toBe(a.body);
  });

  it("two timeouts mean it may or may not have happened: unconfirmed/no_reply, never success", async () => {
    const hub = await controlHub(() => ({ status: 200, body: confirmedBody("power"), delayMs: 400 }));
    const result = await controller(hub.url).control({ target: "客廳主燈", command: "power", value: false });
    expect(result).toMatchObject({ status: "unconfirmed", why: "no_reply", message: "中控沒有回覆，不確定有沒有執行，請看一下設備" });
    expect(homeControlLine(result)).not.toContain("✓");
    expect(hub.commands()).toHaveLength(2);
  });

  it("a refused connection was never received: failed/hub_unreachable; after a timeout it stays no_reply", async () => {
    const hub = await controlHub(() => ({ status: 200, body: confirmedBody("power"), delayMs: 400 }));
    const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const downAfterHome = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw refused();
      return fetch(url, init);
    }) as typeof fetch;
    expect(await controller(hub.url, { fetch: downAfterHome }).control({ target: "客廳主燈", command: "power", value: false })).toMatchObject({
      status: "failed",
      reason: "hub_unreachable",
      message: "無法連線到武陵居中控，指令沒有送出",
    });

    let posts = 0;
    const slowThenDown = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && ++posts === 2) throw refused();
      return fetch(url, init);
    }) as typeof fetch;
    expect(await controller(hub.url, { fetch: slowThenDown }).control({ target: "客廳主燈", command: "power", value: false })).toMatchObject({ status: "unconfirmed", why: "no_reply" });
  });

  it("a 409 for the same key with a different body is an internal error, not retried, without the token", async () => {
    const hub = await controlHub(() => ({ status: 409, body: { detail: "這個 Idempotency-Key 已用於不同指令" } }));
    const result = await controller(hub.url).control({ target: "書桌燈", command: "power", value: true });
    expect(result).toMatchObject({ status: "failed", reason: "internal", message: "AIOS 內部錯誤：指令編號重複，沒有執行" });
    expect(hub.commands()).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("state_stale: refreshes the device once, then resends with the same key", async () => {
    const hub = await controlHub((_r, n) => (n === 1 ? { status: 409, body: { detail: { code: "state_stale", message: "狀態尚未確認，請先重新讀取設備" } } } : { status: 200, body: confirmedBody("power") }));
    const result = await controller(hub.url).control({ target: "客廳主燈", command: "power", value: true });
    expect(result).toMatchObject({ status: "confirmed" });
    expect(hub.requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual([
      "/api/v1/devices/light-main/commands",
      "/api/v1/devices/light-main/refresh",
      "/api/v1/devices/light-main/commands",
    ]);
    const [a, b] = hub.commands();
    expect(b.headers["idempotency-key"]).toBe(a.headers["idempotency-key"]);
    expect(hub.refreshes()[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a device whose last readback timed out (commands: []) is still sent, refreshed and resent — never called unsupported", async () => {
    const hub = await controlHub((_r, n) => (n === 1 ? { status: 409, body: { detail: { code: "state_stale" } } } : { status: 200, body: confirmedBody("power") }));
    const result = await controller(hub.url).control({ target: "床頭燈", command: "power", value: false });
    expect(result).toMatchObject({ status: "confirmed", device: "床頭燈" });
    expect(hub.commands()).toHaveLength(2);
    expect(hub.refreshes()).toHaveLength(1);
  });

  it("still stale after the refresh, or the refresh failed: not sent, said honestly", async () => {
    const stale = { status: 409, body: { detail: { code: "state_stale" } } };
    const hub = await controlHub(() => stale);
    const result = await controller(hub.url).control({ target: "床頭燈", command: "power", value: false });
    expect(result).toMatchObject({ status: "refused", reason: "not_ready", message: expect.stringContaining("狀態還沒更新") });
    expect(hub.commands()).toHaveLength(2);
    expect(hub.refreshes()).toHaveLength(1);

    const broken = await controlHub(() => stale, () => ({ status: 500, body: {} }));
    expect(await controller(broken.url).control({ target: "床頭燈", command: "power", value: false })).toMatchObject({ status: "refused", reason: "not_ready" });
    expect(broken.commands()).toHaveLength(1);
  });

  it("the stale → refresh → resend counts once against the rate limit", async () => {
    const hub = await controlHub((_r, n) => (n === 1 ? { status: 409, body: { detail: { code: "state_stale" } } } : { status: 200, body: confirmedBody("power") }));
    const b = controller(hub.url);
    expect(await b.control({ target: "客廳主燈", command: "power", value: true })).toMatchObject({ status: "confirmed" });
    for (let i = 0; i < 5; i++) expect(await b.control({ target: "書桌燈", command: "power", value: true })).toMatchObject({ status: "confirmed" });
    expect(await b.control({ target: "書桌燈", command: "power", value: false })).toMatchObject({ status: "refused", reason: "rate_limited" });
  });

  it("not configured: refused before sending when the hub says so in /home, and when the hub answers 409", async () => {
    const hub = await controlHub(() => ({ status: 409, body: { detail: { code: "not_configured", message: "請先完成設備認證接入" } } }));
    const b = controller(hub.url);
    expect(await b.control({ target: "音響", command: "volume", value: 40 })).toMatchObject({ status: "refused", reason: "not_configured", device: "音響" });
    expect(hub.commands()).toHaveLength(0);
    expect(await b.control({ target: "書桌燈", command: "power", value: true })).toMatchObject({ status: "refused", reason: "not_configured", message: expect.stringContaining("沒有送出") });
  });

  it("unsupported: the hub's 422 unsupported_command, and IR devices refused without sending (H1b)", async () => {
    const hub = await controlHub(() => ({ status: 422, body: { detail: { code: "unsupported_command", message: "實際設備尚未提供這項控制能力" } } }));
    const b = controller(hub.url);
    expect(await b.control({ target: "書桌燈", command: "volume", value: 30 })).toMatchObject({ status: "refused", reason: "unsupported" });
    expect(await b.control({ target: "電視", command: "power", value: true })).toMatchObject({ status: "refused", reason: "unsupported", message: expect.stringContaining("紅外線") });
    expect(hub.commands()).toHaveLength(1);
  });

  it("a value the hub rejects (422 string detail) is refused with the hub's message", async () => {
    const hub = await controlHub(() => ({ status: 422, body: { detail: "數值必須在 0 到 100 之間" } }));
    expect(await controller(hub.url).control({ target: "書桌燈", command: "brightness", value: 50 })).toMatchObject({
      status: "refused",
      reason: "invalid_value",
      message: "中控不接受這個數值：數值必須在 0 到 100 之間",
    });
  });

  it("asks which one for several matches, a room (even with one device) or the whole home (H3), and says not_found", async () => {
    const hub = await controlHub();
    const b = controller(hub.url);
    expect(await b.control({ target: "客廳的燈", command: "power", value: false })).toEqual({ ok: true, status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] });
    expect(await b.control({ target: "客廳", command: "power", value: false })).toEqual({ ok: true, status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] });
    expect(await b.control({ target: "全家", command: "power", value: false })).toMatchObject({ status: "ambiguous" });
    // 書房只有一台書桌燈：說「書房」仍是房間指令，先問，不直接控制。
    expect(await b.control({ target: "書房", command: "power", value: false })).toEqual({ ok: true, status: "ambiguous", candidates: ["書房的書桌燈"] });
    expect(await b.control({ target: "書房的書桌燈", command: "power", value: false })).toMatchObject({ status: "confirmed", device: "書桌燈" });
    expect(await b.control({ target: "陽台燈", command: "power", value: true })).toEqual({ ok: true, status: "not_found", target: "陽台燈" });
    expect(hub.commands()).toHaveLength(1);
  });

  it("rate limit: the 7th command within a minute is not sent; a minute later it is", async () => {
    const hub = await controlHub();
    const b = controller(hub.url);
    for (let i = 0; i < 6; i++) {
      clock += 1_000;
      expect(await b.control({ target: "書桌燈", command: "brightness", value: 10 * i })).toMatchObject({ status: "confirmed" });
    }
    const limited = await b.control({ target: "書桌燈", command: "power", value: false });
    expect(limited).toMatchObject({ status: "refused", reason: "rate_limited", retry_after_s: 55 });
    expect(hub.commands()).toHaveLength(6);
    clock += 61_000;
    expect(await b.control({ target: "書桌燈", command: "power", value: false })).toMatchObject({ status: "confirmed" });
  });

  it("explains an unset hub, a rejected token and an unknown command without calling the hub", async () => {
    await expect(new HomeBridge({ url: null, token: null }).control({ target: "書桌燈", command: "power", value: true })).rejects.toMatchObject({ status: 409 });
    const hub = await controlHub();
    await expect(new HomeBridge({ url: hub.url, token: "wrong" }).control({ target: "書桌燈", command: "power", value: true })).rejects.toThrow(/401/);
    expect(await controller(hub.url).control({ target: "書桌燈", command: "temperature", value: 26 })).toMatchObject({ status: "refused", reason: "invalid_value" });
    expect(hub.commands()).toHaveLength(0);
  });
});

describe("HomeBridge confirm path (test-only policyFor)", () => {
  const policy = (p: VoicePolicy) => ({ policyFor: () => p });

  it("returns needs_confirmation without sending; approving sends once with the key minted at control time", async () => {
    const hub = await controlHub();
    const b = controller(hub.url, policy("confirm"));
    const asked = await b.control({ target: "書桌燈", command: "power", value: false });
    expect(asked).toEqual({ ok: true, status: "needs_confirmation", confirm_id: "home_id2", device: "書桌燈", room: "書房", action: "關閉", expires_in_s: 60 });
    expect(hub.commands()).toHaveLength(0);

    const [first, second] = await Promise.all([b.confirm("home_id2", true), b.confirm("home_id2", true)]);
    expect(first).toMatchObject({ status: "confirmed", device: "書桌燈" });
    expect(second).toEqual(first);
    expect(await b.confirm("home_id2", true)).toEqual(first);
    // 執行之後才到的拒絕也拿到同一個結果，不會說成沒有執行。
    expect(await b.confirm("home_id2", false)).toEqual(first);
    expect(hub.commands()).toHaveLength(1);
    expect(hub.commands()[0].headers["idempotency-key"]).toBe("nous_id1");
  });

  it("rejecting forgets the card; a later approve, an unknown id and an expired card all send nothing", async () => {
    const hub = await controlHub();
    const b = controller(hub.url, policy("confirm"));
    const asked = (await b.control({ target: "書桌燈", command: "power", value: false })) as Extract<HomeControlResult, { status: "needs_confirmation" }>;
    expect(await b.confirm(asked.confirm_id, false)).toMatchObject({ status: "refused", reason: "declined", message: "沒有確認，書桌燈關閉沒有執行。" });
    expect(await b.confirm(asked.confirm_id, true)).toMatchObject({ status: "refused", reason: "expired" });
    expect(await b.confirm("home_nope", true)).toMatchObject({ status: "refused", reason: "expired" });

    const late = (await b.control({ target: "書桌燈", command: "power", value: true })) as Extract<HomeControlResult, { status: "needs_confirmation" }>;
    clock += 90_000;
    expect(await b.confirm(late.confirm_id, true)).toMatchObject({ status: "refused", reason: "expired" });
    expect(hub.commands()).toHaveLength(0);
  });

  it("policy off: voice_disabled, nothing sent", async () => {
    const hub = await controlHub();
    expect(await controller(hub.url, policy("off")).control({ target: "書桌燈", command: "power", value: true })).toMatchObject({ status: "refused", reason: "voice_disabled" });
    expect(hub.commands()).toHaveLength(0);
  });
});

describe("home_control never leaks the token", () => {
  it("the token is only in the Authorization header, never in a result, a body or the bridge detail", async () => {
    const hub = await controlHub((_r, n) => (n === 1 ? { status: 409, body: { detail: { code: "state_stale" } } } : { status: 200, body: confirmedBody("power") }));
    const b = controller(hub.url, { policyFor: (d) => (d.id === "desk" ? "confirm" : "allow") });
    const results = [
      await b.control({ target: "客廳主燈", command: "power", value: true }),
      await b.control({ target: "書桌燈", command: "power", value: true }),
      await b.confirm("home_id3", true),
      await b.control({ target: "電視", command: "power", value: true }),
      await b.control({ target: "客廳", command: "power", value: true }),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(b.detail).not.toContain(TOKEN);
    expect(b.detail).toContain("查詢與控制");
    for (const r of hub.requests) {
      expect(r.body).not.toContain(TOKEN);
      expect(r.url).not.toContain(TOKEN);
    }
    const tools = JSON.stringify(buildRealtimeTools({ webSearch: true, mcp: [], home: true }));
    expect(tools).not.toContain(TOKEN);
  });
});

describe("parseCommand", () => {
  it("accepts the spoken forms of each value and rejects out-of-range ones", () => {
    expect(parseCommand("power", "on")).toEqual({ command: "power", value: true });
    expect(parseCommand("power", "關")).toEqual({ command: "power", value: false });
    expect(parseCommand("brightness", "60")).toEqual({ command: "brightness", value: 60 });
    expect(parseCommand("brightness", 101)).toHaveProperty("error");
    expect(parseCommand("volume", "40%")).toEqual({ command: "volume", value: 40 });
    expect(parseCommand("color_temperature", 3000)).toEqual({ command: "color_temperature", kelvin: 3000 });
    expect(parseCommand("color_temperature", "9500")).toHaveProperty("error");
    expect(parseCommand("color", "#ffaa00")).toEqual({ command: "color", value: "#FFAA00" });
    expect(parseCommand("color", "orange")).toHaveProperty("error");
    expect(parseCommand("mute", true)).toEqual({ command: "mute", value: true });
    expect(parseCommand("pause", null)).toEqual({ command: "pause" });
    expect(parseCommand("cover", "close")).toEqual({ command: "cover", value: "close" });
    expect(parseCommand("cover", "half")).toHaveProperty("error");
    expect(parseCommand("temperature", 26)).toHaveProperty("error");
  });
});
