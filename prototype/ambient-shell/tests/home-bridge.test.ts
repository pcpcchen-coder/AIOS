import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseHttpUrl } from "../server/config.ts";
import { HomeBridge, HomeBridgeError, metricKey, parseHome, report, resolveTarget } from "../server/home-bridge.ts";
import { buildRealtimeInstructions, buildRealtimeTools } from "../server/realtime.ts";
import { homeStatusLine, type HomeStatusResult } from "../shared/home.ts";

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

interface Hub {
  url: string;
  requests: IncomingMessage[];
  close(): Promise<void>;
}

const hubs: Server[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function fakeHub(handler?: (req: IncomingMessage) => { status: number; body: unknown }): Promise<Hub> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    const reply =
      handler?.(req) ??
      (req.headers.authorization !== `Bearer ${TOKEN}`
        ? { status: 401, body: { detail: { code: "authentication_required" } } }
        : req.url === "/api/v1/home"
          ? { status: 200, body: HOME }
          : { status: 404, body: {} });
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
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
  it("offers home_status only when the hub is configured and says it cannot control devices yet", () => {
    expect(buildRealtimeTools({ webSearch: false, mcp: [], home: true }).map((t) => t.name)).toContain("home_status");
    expect(buildRealtimeTools({ webSearch: false, mcp: [] }).map((t) => t.name)).not.toContain("home_status");
    const text = buildRealtimeInstructions([], new Date(), { webSearch: false, mcp: [], home: true });
    expect(text).toContain("home_status");
    expect(text).toContain("不能開關或調整家電");
    expect(buildRealtimeInstructions([], new Date(), { webSearch: false, mcp: [] })).not.toContain("home_status");
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
