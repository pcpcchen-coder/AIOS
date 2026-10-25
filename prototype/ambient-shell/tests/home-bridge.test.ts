import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseHttpUrl } from "../server/config.ts";
import {
  AC_OFF_TIMER_NOTE,
  AC_OFF_TIMER_NOTE_UNSURE,
  buildClimate,
  CLIMATE_DEFAULTS,
  COOLDOWN_WAIT_MS,
  H1B_TIMEOUTS_MS,
  HomeBridge,
  HomeBridgeError,
  IR_SYNONYMS,
  keyNorm,
  matchKey,
  metricKey,
  MIN_SEND_WINDOW_MS,
  parseAifa,
  parseCommand,
  parseHome,
  report,
  resolveTarget,
  UTTERANCE_MS,
  type HomeBridgeOptions,
  type VoicePolicy,
} from "../server/home-bridge.ts";
import { buildRealtimeInstructions, buildRealtimeTools, HOME_CONTROL_TOOL, realtimeToolRules } from "../server/realtime.ts";
import { AC_FANS, AC_FEATURES, AC_MODES, AC_SWINGS, HOME_COMMANDS, homeControlLine, homeControlNotice, homeStatusLine, IR_INTENTS, type HomeControlResult, type HomeStatusResult } from "../shared/home.ts";

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

/** 中控沒有連結 AIFA 帳號時 GET /integrations/aifa 的回覆（backend/aifa.py account_view）。 */
const AIFA_NOT_CONNECTED = { connected: false, queried_at: null, items: [], error: null, read_only: false, supports_ac_power: true, compatibility_api: true };

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
            : req.url === "/api/v1/integrations/aifa"
              ? { status: 200, body: AIFA_NOT_CONNECTED }
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
    expect(text).toContain("ac_temperature");
    expect(text).toContain("one_way");
    expect(text).toContain("控制器回報");
    expect(text).toContain("busy");
    expect(text).toContain("不要說成功");
    // 審查修正：同名候選帶路徑時，模型要照抄候選名稱（含括號）當 target。
    expect(text).toContain("target 照候選名稱一字不差填（包括「（AIFA）」「（紅外線遙控）」）");
    expect(buildRealtimeInstructions([], new Date(), { webSearch: false, mcp: [] })).not.toContain("home_");
  });

  it("the tool's command enum is HOME_COMMANDS and says AIFA air-con and IR keys are sent but never confirmed (H1b)", () => {
    expect(HOME_CONTROL_TOOL.parameters.properties.command.enum).toEqual([...HOME_COMMANDS]);
    expect(HOME_CONTROL_TOOL.description).toMatch(/AIFA 冷氣/);
    expect(HOME_CONTROL_TOOL.description).toMatch(/紅外線家電/);
    expect(HOME_CONTROL_TOOL.description).toMatch(/不會確認/);
    // 設定溫度不叫 temperature（中控 /commands 的 temperature 是燈的色溫）。
    expect(HOME_COMMANDS).not.toContain("temperature");
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
    // 中控匯入 Tuya 時只認得感應器、窗簾、閘道與遙控器，冷氣（kt／ktkzq）會變成 kind switch，原類別留在 config.cloud_category。
    dev("tuya-kt", "客房冷氣", null, { kind: "switch", adapter: "tuya", config: { cloud_category: "kt" } }),
    dev("tuya-ktkzq", "冷氣控制器", null, { kind: "switch", adapter: "tuya", config: { cloud_category: "ktkzq" } }),
    dev("ha-climate", "主臥空調", null, { kind: "switch", adapter: "homeassistant", config: { entity_id: "climate.master_bedroom" } }),
    dev("aifa-ac", "書房分離式", null, { kind: "other", config: { external_provider: "aifa" } }),
    dev("tuya-wxkg", "無線按鈕", null, { kind: "remote", adapter: "tuya", config: { cloud_category: "wxkg", infrared_virtual: false } }),
    dev("tuya-cz", "延長線", null, { kind: "switch", adapter: "tuya", config: { cloud_category: "cz" } }),
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

  it("unsupported: the hub's 422 unsupported_command; an IR device whose keys are not synced is not_ready without sending (H1b)", async () => {
    const hub = await controlHub(() => ({ status: 422, body: { detail: { code: "unsupported_command", message: "實際設備尚未提供這項控制能力" } } }));
    const b = controller(hub.url);
    expect(await b.control({ target: "書桌燈", command: "volume", value: 30 })).toMatchObject({ status: "refused", reason: "unsupported" });
    expect(await b.control({ target: "電視", command: "power", value: true })).toMatchObject({ status: "refused", reason: "not_ready", message: expect.stringContaining("同步") });
    expect(hub.commands()).toHaveLength(1);
  });

  it("air-cons the hub can hold (Tuya kt/ktkzq, Home Assistant climate.*, the AIFA controller) are refused without sending; a wireless button is not called IR", async () => {
    const hub = await controlHub();
    const b = controller(hub.url);
    for (const target of ["客房冷氣", "冷氣控制器", "主臥空調"]) {
      expect(await b.control({ target, command: "power", value: true })).toMatchObject({ status: "refused", reason: "unsupported", device: target, message: `${target}是冷氣，但不是透過 AIFA 連接，目前不能用語音控制。` });
    }
    // 中控設備裡的 AIFA 控制器本身不是冷氣；冷氣是 GET /integrations/aifa 的子設備（H1b）。
    expect(await b.control({ target: "書房分離式", command: "power", value: true })).toMatchObject({ status: "refused", reason: "unsupported", message: "書房分離式是 AIFA 控制器本身；要控制冷氣，請說 AIFA App 裡的冷氣名稱。" });
    const button = await b.control({ target: "無線按鈕", command: "power", value: true });
    expect(button).toMatchObject({ status: "refused", reason: "unsupported", message: "無線按鈕這類設備（遙控器、無線按鈕）目前還不能用語音控制。" });
    expect(JSON.stringify(button)).not.toMatch(/紅外線|冷氣/);
    expect(hub.commands()).toHaveLength(0);
    // 其他 Tuya 類別（cz 插座）照常送出。
    expect(await b.control({ target: "延長線", command: "power", value: true })).toMatchObject({ status: "confirmed" });
    expect(hub.commands()).toHaveLength(1);
  });

  it("only the hub's device_not_found 404 means not_found; any other 404 (an older hub's route) is an honest error", async () => {
    const gone = await controlHub(() => ({ status: 404, body: { detail: { code: "device_not_found", message: "找不到這台設備" } } }));
    expect(await controller(gone.url).control({ target: "書桌燈", command: "power", value: true })).toEqual({ ok: true, status: "not_found", target: "書桌燈" });
    const old = await controlHub(() => ({ status: 404, body: { detail: "Not Found" } }));
    const err = await controller(old.url).control({ target: "書桌燈", command: "power", value: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomeBridgeError);
    expect((err as HomeBridgeError).message).toContain("HTTP 404");
    expect((err as HomeBridgeError).message).toContain("沒有送出");
    expect(old.commands()).toHaveLength(1);
  });

  it("one same-key resend per control() call: a timeout then state_stale, or state_stale then a timeout, stop after two POSTs", async () => {
    const stale = { status: 409, body: { detail: { code: "state_stale" } } };
    const timedOutThenStale = await controlHub((_r, n) => (n === 1 ? { status: 200, body: confirmedBody("power"), delayMs: 400 } : stale));
    expect(await controller(timedOutThenStale.url).control({ target: "床頭燈", command: "power", value: false })).toMatchObject({ status: "refused", reason: "not_ready" });
    expect(timedOutThenStale.commands()).toHaveLength(2);
    expect(timedOutThenStale.refreshes()).toHaveLength(0);

    const staleThenTimedOut = await controlHub((_r, n) => (n === 1 ? stale : { status: 200, body: confirmedBody("power"), delayMs: 400 }));
    expect(await controller(staleThenTimedOut.url).control({ target: "床頭燈", command: "power", value: false })).toMatchObject({ status: "unconfirmed", why: "no_reply" });
    expect(staleThenTimedOut.commands()).toHaveLength(2);
    expect(staleThenTimedOut.refreshes()).toHaveLength(1);
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
    expect(asked).toEqual({ ok: true, status: "needs_confirmation", confirm_id: "home_id2", device: "書桌燈", room: "書房", action: "關閉", expires_in_s: 90 });
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

// ───────── H1b：AIFA 冷氣與紅外線家電。假中控照 SmartHomeAI backend/app.py、aifa.py、infrared.py 的回覆格式（fixture）─────────

const AIFA_CAPS = {
  modes: ["auto", "cool", "dry"],
  fan_modes: ["auto", "low", "medium", "high"],
  swing_modes: ["auto", "fixed_1", "fixed_2", "fixed_3", "fixed_4", "fixed_5"],
  features: ["normal", "sleep", "turbo", "energy_saving"],
  min_temperature: 17,
  max_temperature: 30,
  timer_supported: false,
};

/** GET /integrations/aifa（account_view）；queriedAt 是中控時鐘的秒數。 */
const aifaList = (queriedAt: number | null = NOW - 3600, extra: unknown[] = []) => ({
  connected: true,
  queried_at: queriedAt,
  items: [
    {
      id: "hub1",
      name: "客廳 AIFA",
      mac: "aa:bb:cc:dd:ee:01",
      online: true,
      matched_device_id: "aifa-box",
      children: [
        { id: "c1", name: "冷氣", type: "0", sub_type: "0", device_code: "173", capabilities: AIFA_CAPS },
        { id: "c2", name: "書房冷氣", type: "0", sub_type: "0", device_code: "210", capabilities: null },
        { id: "c3", name: "AIFA 機上盒", type: "1", sub_type: "0", device_code: "5", capabilities: null },
      ],
    },
    { id: "hub2", name: "主臥 AIFA", mac: "aa:bb:cc:dd:ee:02", online: null, matched_device_id: null, children: [{ id: "c9", name: "主臥冷氣", type: "0", sub_type: "0", device_code: "173", capabilities: AIFA_CAPS }] },
    ...extra,
  ],
  error: null,
  read_only: false,
  supports_ac_power: true,
  compatibility_api: true,
});

const irKeys = (...labels: string[]) => labels.map((label, i) => ({ key: label.replace(/\s+/g, "_"), key_id: i + 1, label }));
const irDevice = (id: string, name: string, room: string | null, keys: ReturnType<typeof irKeys>, ready = true) =>
  dev(id, name, room, {
    kind: "remote",
    category: "紅外線家電",
    configured: false,
    can_control: false,
    config: { infrared_virtual: true, gateway_id: "wnykq-1", infrared_remote_id: id },
    state: { available: null, fresh: false },
    infrared: { keys, ready, queried_at: NOW - 600, controller_id: "blaster", controller_name: "紅外線控制器", error: null, one_way: true },
  });

const H1B_HOME = {
  layout: { rooms: [{ id: "living", name: "客廳" }, { id: "study", name: "書房" }] },
  devices: [
    dev("light-main", "客廳主燈", "living"),
    dev("desk", "書桌燈", "study"),
    // MAC 對到 AIFA 控制器的中控設備（給房間用）；它自己不是冷氣。
    dev("aifa-box", "AIFA 盒子", "living", { kind: "other", configured: false }),
    irDevice("ir-tv", "電視", "living", irKeys("Power", "Vol+", "Vol-", "Mute", "CH+", "頻道減")),
    irDevice("ir-fan", "電風扇", "study", irKeys("PowerOn", "PowerOff", "Speed", "Timer")),
    irDevice("ir-proj", "投影機", null, irKeys("Power"), false),
    irDevice("ir-box", "機上盒", null, [...irKeys("Power"), { key: "VolumeUp", key_id: 7, label: "音量加" }, { key: "Vol_up", key_id: 8, label: "Vol+" }]),
    irDevice("ir-ac", "客房空調遙控", null, irKeys("Power", "Temp+", "Temp-", "Mode", "Fan")),
    dev("blaster", "紅外線控制器", null, { kind: "remote", config: { cloud_category: "wnykq" }, infrared: null }),
  ],
  server_time: NOW,
};

const STATUS_ON = { power: true, mode: "cool", temperature: 24, fan: "low", swing: "auto", feature: "normal", received_at: NOW, source: "aifa-controller-reported", physical_feedback: false };
const STATUS_OFF = { power: false, mode: null, temperature: null, fan: "high", swing: "fixed_2", feature: "normal", received_at: NOW, source: "aifa-controller-reported", physical_feedback: false };
const AIFA_SENT = { status: 200, body: { id: "a1", status: "unconfirmed", message: "已透過 AIFA 連線送出；控制器狀態不代表冷氣實際反應，請現場確認", controller_status: { ...STATUS_ON, temperature: 26 } } };
const IR_SENT = { status: 200, body: { id: "i1", device_id: "ir-tv", command: "infrared", requested_at: NOW, status: "unconfirmed", transport_status: "accepted_by_cloud", message: "Tuya 已接受紅外線指令；家電不回傳狀態，請確認實際反應" } };

const isAifaSend = (r: HubRequest) => r.method === "POST" && /\/children\/[^/]+\/(power|climate)$/.test(r.url);
const isAifaStatus = (r: HubRequest) => r.method === "POST" && r.url.endsWith("/status");
const isDiscover = (r: HubRequest) => r.method === "POST" && r.url === "/api/v1/integrations/aifa/discover";
const isIr = (r: HubRequest) => r.method === "POST" && r.url.endsWith("/infrared-commands");

interface H1bHubOptions {
  aifa?: () => Reply;
  status?: (n: number) => Reply;
  discover?: (n: number) => Reply;
  send?: (r: HubRequest, n: number) => Reply;
  ir?: (r: HubRequest, n: number) => Reply;
  commands?: (r: HubRequest, n: number) => Reply;
  home?: unknown;
}

async function h1bHub(o: H1bHubOptions = {}) {
  const n = { status: 0, discover: 0, send: 0, ir: 0, commands: 0 };
  const hub = await fakeHub((r) => {
    if (r.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { detail: { code: "authentication_required" } } };
    if (r.url === "/api/v1/integrations/aifa") return o.aifa?.() ?? { status: 200, body: aifaList() };
    if (isDiscover(r)) return o.discover?.(++n.discover) ?? { status: 200, body: aifaList(NOW) };
    if (isAifaStatus(r)) return o.status?.(++n.status) ?? { status: 200, body: { sent: false, status: STATUS_ON } };
    if (isAifaSend(r)) return o.send?.(r, ++n.send) ?? AIFA_SENT;
    if (isIr(r)) return o.ir?.(r, ++n.ir) ?? IR_SENT;
    if (isCommand(r)) return o.commands?.(r, ++n.commands) ?? { status: 200, body: confirmedBody(JSON.parse(r.body).command) };
    return undefined;
  }, o.home ?? H1B_HOME);
  const only = (f: (r: HubRequest) => boolean) => () => hub.requests.filter(f);
  return { ...hub, sends: only(isAifaSend), statuses: only(isAifaStatus), discovers: only(isDiscover), irs: only(isIr), commands: only(isCommand), posts: only((r) => r.method === "POST") };
}

let sleeps: number[] = [];
const SHORT = { aifaStatus: 150, aifaDiscover: 150, aifaSend: 150, aifaRetry: 150, irSend: 150, irRetry: 150 };
/** 假時鐘：冷卻等待只推進時鐘，不真的等。 */
function h1bController(url: string, extra: Partial<HomeBridgeOptions> = {}) {
  sleeps = [];
  return controller(url, {
    timeoutsMs: SHORT,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...extra,
  });
}

describe("H1b: AIFA air-cons merged from GET /integrations/aifa", () => {
  it("adds AIFA children with the room of matched_device_id; no room when unmatched; never says online", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    const ac = await b.status("冷氣");
    expect(ac).toMatchObject({ status: "ok", devices: [{ device: "冷氣", room: "客廳", online: "狀態未知", data: null }] });
    expect(await b.status("主臥冷氣")).toMatchObject({ devices: [{ device: "主臥冷氣", room: null, online: "狀態未知" }] });
    expect(hub.requests.filter((r) => r.method === "GET").map((r) => r.url).sort()).toEqual(["/api/v1/home", "/api/v1/home", "/api/v1/integrations/aifa", "/api/v1/integrations/aifa"]);
  });

  it("review: an offline AIFA child is said with the time of the list it came from, never as offline now", async () => {
    const list = aifaList(NOW - 3600);
    const hub2 = list.items[1] as Record<string, unknown>;
    const offline = { ...list, items: [list.items[0], { ...hub2, online: false }] };
    const hub = await h1bHub({ aifa: () => ({ status: 200, body: offline }) });
    const b = h1bController(hub.url, { timeZone: "Asia/Taipei" });
    const r = await b.status("主臥冷氣");
    expect(r).toMatchObject({ status: "ok", devices: [{ device: "主臥冷氣", online: "上次讀取 AIFA 清單時離線（12:20）" }] });
    expect(homeStatusLine(r)).toBe("主臥冷氣：上次讀取 AIFA 清單時離線（12:20）");
    // 清單沒有讀取時間：不知道是什麼時候的離線，說狀態未知。
    const untimed = await h1bHub({ aifa: () => ({ status: 200, body: { ...offline, queried_at: null } }) });
    expect(await h1bController(untimed.url).status("主臥冷氣")).toMatchObject({ devices: [{ online: "狀態未知" }] });
    // 中控自己的設備照舊：離線就是離線。
    expect(await b.status("書桌燈")).toMatchObject({ devices: [{ device: "書桌燈" }] });
    expect(report(parseHome(HOME), parseHome(HOME).devices.find((d) => d.id === "light-floor")!, null).online).toBe("離線");
  });

  it("an unreadable AIFA list (500, 404, timeout, bad body) never breaks lights; 「冷氣」 is not_found with a note", async () => {
    // 逾時（8 秒）太慢，最後另外用會丟 TimeoutError 的 fetch 測。
    for (const aifa of [() => ({ status: 500, body: {} }), () => ({ status: 404, body: { detail: "Not Found" } }), () => ({ status: 200, body: { items: "x" } })]) {
      const hub = await h1bHub({ aifa });
      const b = h1bController(hub.url);
      expect(await b.control({ target: "客廳主燈", command: "power", value: false })).toMatchObject({ status: "confirmed" });
      const missing = await b.control({ target: "冷氣", command: "power", value: true });
      expect(missing).toEqual({ ok: true, status: "not_found", target: "冷氣", note: "AIFA 冷氣清單讀不到" });
      expect(homeControlLine(missing)).toBe("家裡找不到「冷氣」（AIFA 冷氣清單讀不到）");
      expect(hub.sends()).toHaveLength(0);
    }
    const hub = await h1bHub();
    const failingAifa = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/integrations/aifa")) throw new DOMException("timed out", "TimeoutError");
      return fetch(url, init);
    }) as typeof fetch;
    expect(await h1bController(hub.url, { fetch: failingAifa }).control({ target: "客廳主燈", command: "power", value: true })).toMatchObject({ status: "confirmed" });
  });

  it("an AIFA account that is not connected: no note, plain not_found", async () => {
    const hub = await h1bHub({ aifa: () => ({ status: 200, body: AIFA_NOT_CONNECTED }) });
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "power", value: true })).toEqual({ ok: true, status: "not_found", target: "冷氣" });
  });

  it("a child that is not code 173 supports power only (climate refused before any request); a non-AC child is refused", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    expect(await b.control({ target: "書房冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "one_way" });
    expect(await b.control({ target: "書房冷氣", command: "ac_temperature", value: "26" })).toMatchObject({ status: "refused", reason: "unsupported", message: expect.stringContaining("只確認了開關") });
    expect(await b.control({ target: "AIFA 機上盒", command: "power", value: true })).toMatchObject({ status: "refused", reason: "unsupported", message: "AIFA 機上盒是 AIFA 的非冷氣家電，目前不能用語音控制。" });
    expect(hub.sends()).toHaveLength(1);
    expect(hub.statuses()).toHaveLength(0);
  });
});

describe("H1b: AIFA power and climate", () => {
  it("power: body is exactly {power}, with an Idempotency-Key; the result is one_way, never confirmed; the controller report is labelled", async () => {
    const hub = await h1bHub();
    const result = await h1bController(hub.url).control({ target: "冷氣", command: "power", value: "true" });
    expect(result).toEqual({
      ok: true,
      status: "unconfirmed",
      why: "one_way",
      device: "冷氣",
      room: "客廳",
      action: "開啟",
      message: "已透過 AIFA 連線送出；控制器狀態不代表冷氣實際反應，請現場確認",
      controller_reported: "控制器回報：開、冷氣、26 度、風量低、擺風自動",
    });
    expect(homeControlLine(result)).toBe("⏳ 客廳 冷氣 開啟：已送出，請確認");
    expect(homeControlNotice(result)).toContain("不要說成功");
    expect(homeControlNotice(result)).toContain("不是冷氣的實際狀態");
    const [post] = hub.sends();
    expect(post.url).toBe("/api/v1/integrations/aifa/devices/hub1/children/c1/power");
    expect(JSON.parse(post.body)).toEqual({ power: true });
    expect(post.headers["idempotency-key"]).toBe("nous_id1");
    expect(hub.statuses()).toHaveLength(0);
  });

  it("「26 度」 with the AC on: reads /status first and keeps the reported mode, fan, swing and feature", async () => {
    const hub = await h1bHub({ status: () => ({ status: 200, body: { sent: false, status: { ...STATUS_ON, feature: "sleep" } } }) });
    const result = await h1bController(hub.url).control({ target: "冷氣", command: "ac_temperature", value: "26度" });
    expect(result).toMatchObject({ status: "unconfirmed", why: "one_way", action: "設定 26 度", sent_settings: "模式冷氣、26 度、風量低、擺風自動、睡眠" });
    expect(result).not.toHaveProperty("defaults_used");
    expect(result).not.toHaveProperty("note");
    expect(homeControlLine(result)).toBe("⏳ 客廳 冷氣 設定 26 度：已送出，請確認");
    expect(hub.posts().map((r) => r.url)).toEqual(["/api/v1/integrations/aifa/devices/hub1/children/c1/status", "/api/v1/integrations/aifa/devices/hub1/children/c1/climate"]);
    expect(hub.statuses()[0].body).toBe("");
    expect(JSON.parse(hub.sends()[0].body)).toEqual({ mode: "cool", temperature: 26, fan: "low", swing: "auto", feature: "sleep" });
  });

  it("「26 度」 with the AC off: mode comes from the defaults (自動, George 2026-10-25), said out loud, and it does not claim the AC turns on", async () => {
    const hub = await h1bHub({ status: () => ({ status: 200, body: { sent: false, status: STATUS_OFF } }) });
    const result = await h1bController(hub.url).control({ target: "冷氣", command: "ac_temperature", value: 26 });
    expect(JSON.parse(hub.sends()[0].body)).toEqual({ mode: "auto", temperature: 26, fan: "high", swing: "fixed_2", feature: "normal" });
    expect(result).toMatchObject({ status: "unconfirmed", why: "one_way", sent_settings: "模式自動、26 度、風量高、擺風固定 2", defaults_used: ["模式：自動"], note: expect.stringContaining("不代表會開機") });
    expect(homeControlNotice(result)).toContain("預設值：模式：自動");
    expect(JSON.stringify(result)).not.toMatch(/已開|已經開/);
  });

  it("「改除濕」 with the AC off: temperature 26 from the defaults (the C1 bug), fan and swing from the report", async () => {
    const hub = await h1bHub({ status: () => ({ status: 200, body: { sent: false, status: STATUS_OFF } }) });
    const result = await h1bController(hub.url).control({ target: "冷氣", command: "ac_mode", value: "除濕" });
    expect(JSON.parse(hub.sends()[0].body)).toEqual({ mode: "dry", temperature: 26, fan: "high", swing: "fixed_2", feature: "normal" });
    expect(result).toMatchObject({ action: "模式改成除濕", defaults_used: ["溫度：26 度"] });
  });

  it("status unreadable (timeout or error): every field from the defaults, all disclosed", async () => {
    for (const status of [() => ({ status: 200, body: {}, delayMs: 400 }), () => ({ status: 409, body: { detail: "AIFA 控制連線未完成，沒有送出開關指令" } })]) {
      const hub = await h1bHub({ status });
      const result = await h1bController(hub.url).control({ target: "冷氣", command: "ac_swing", value: "fixed_3" });
      expect(JSON.parse(hub.sends()[0].body)).toEqual({ mode: "auto", temperature: 26, fan: "auto", swing: "fixed_3", feature: "normal" });
      expect(result).toMatchObject({ defaults_used: ["風量：自動", "模式：自動", "溫度：26 度", "特殊功能：一般"], note: expect.stringContaining("讀不到控制器的開關狀態") });
    }
  });

  it("風量調小 steps down from the reported fan; unknown or auto fan, or already lowest, is refused without a climate send", async () => {
    const hub = await h1bHub({ status: () => ({ status: 200, body: { sent: false, status: { ...STATUS_ON, fan: "medium" } } }) });
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "ac_fan", value: "down" })).toMatchObject({ status: "unconfirmed", action: "風量調小", sent_settings: "模式冷氣、24 度、風量低、擺風自動" });

    for (const [fan, message] of [["auto", "不知道目前風量，請說低、中、高或自動"], [null, "不知道目前風量"], ["low", "已經是最低"]] as const) {
      const h = await h1bHub({ status: () => ({ status: 200, body: { sent: false, status: { ...STATUS_ON, fan } } }) });
      expect(await h1bController(h.url).control({ target: "冷氣", command: "ac_fan", value: "調小" })).toMatchObject({ status: "refused", reason: "invalid_value", message: expect.stringContaining(message) });
      expect(h.sends()).toHaveLength(0);
    }
  });

  it("heat, fan-only and 35 °C are refused locally, with no request to the hub", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    expect(await b.control({ target: "冷氣", command: "ac_mode", value: "heat" })).toMatchObject({ status: "refused", reason: "invalid_value", message: "這台冷氣用語音只能設自動、冷氣或除濕，沒有暖氣和送風。" });
    expect(await b.control({ target: "冷氣", command: "ac_mode", value: "送風" })).toMatchObject({ status: "refused", reason: "invalid_value" });
    expect(await b.control({ target: "冷氣", command: "ac_temperature", value: "35" })).toMatchObject({ status: "refused", reason: "invalid_value", message: "冷氣溫度要在 17 到 30 度之間（整數），指令沒有送出。" });
    expect(await b.control({ target: "冷氣", command: "ac_temperature", value: "25.5" })).toMatchObject({ status: "refused", reason: "invalid_value" });
    expect(hub.posts()).toHaveLength(0);
  });

  it("200 failed is failed/device with the hub's message; a stored accepted record is no_reply", async () => {
    const failed = await h1bHub({ send: () => ({ status: 200, body: { id: "a", status: "failed", message: "AIFA 控制連線未完成，沒有送出開關指令", controller_status: null } }) });
    const result = await h1bController(failed.url).control({ target: "冷氣", command: "power", value: false });
    expect(result).toMatchObject({ status: "failed", reason: "device", message: "AIFA 控制連線未完成，沒有送出開關指令" });
    expect(homeControlLine(result)).toBe("✕ 客廳 冷氣 關閉：失敗（AIFA 控制連線未完成，沒有送出開關指令）");

    const accepted = await h1bHub({ send: () => ({ status: 200, body: { id: "a", status: "accepted", message: "AIFA 指令處理中" } }) });
    expect(await h1bController(accepted.url).control({ target: "冷氣", command: "power", value: false })).toMatchObject({ status: "unconfirmed", why: "no_reply" });
  });

  it("409 strings: not owned → not_ready with the hub text; idempotency conflict → internal; only the latter says AIOS 內部錯誤", async () => {
    const notOwned = await h1bHub({ send: () => ({ status: 409, body: { detail: "找不到已授權的 AIFA 冷氣" } }) });
    const r1 = await h1bController(notOwned.url).control({ target: "冷氣", command: "power", value: true });
    expect(r1).toMatchObject({ status: "refused", reason: "not_ready", message: "中控回覆「找不到已授權的 AIFA 冷氣」，指令沒有送出。" });
    expect(notOwned.sends()).toHaveLength(1);
    expect(JSON.stringify(r1)).not.toContain("AIOS 內部錯誤");

    const conflict = await h1bHub({ send: () => ({ status: 409, body: { detail: "相同指令識別碼不可用於不同內容" } }) });
    expect(await h1bController(conflict.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "failed", reason: "internal", message: expect.stringContaining("AIOS 內部錯誤") });
    expect(conflict.sends()).toHaveLength(1);
  });

  it("the 2 s cooldown (429): waits once and resends with the same key; a second 429 is rate_limited, never a 502", async () => {
    const cooldown = { status: 429, body: { detail: "請稍候兩秒再操作" } };
    const once = await h1bHub({ send: (_r, n) => (n === 1 ? cooldown : AIFA_SENT) });
    expect(await h1bController(once.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "one_way" });
    expect(sleeps).toEqual([COOLDOWN_WAIT_MS.aifa]);
    const [a, b] = once.sends();
    expect(b.headers["idempotency-key"]).toBe(a.headers["idempotency-key"]);
    expect(b.body).toBe(a.body);

    const twice = await h1bHub({ send: () => cooldown });
    const limited = await h1bController(twice.url).control({ target: "冷氣", command: "power", value: true });
    expect(limited).toMatchObject({ status: "refused", reason: "rate_limited", retry_after_s: 2 });
    expect(twice.sends()).toHaveLength(2);
  });

  it("a slow AIFA send: the same-key resend returns the stored record; two timeouts are no_reply; a later 409 after a timeout is not「沒有送出」", async () => {
    const slow = await h1bHub({ send: (_r, n) => ({ ...AIFA_SENT, delayMs: n === 1 ? 400 : 0 }) });
    expect(await h1bController(slow.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "one_way" });
    expect(new Set(slow.sends().map((r) => r.headers["idempotency-key"])).size).toBe(1);

    const silent = await h1bHub({ send: () => ({ ...AIFA_SENT, delayMs: 400 }) });
    const r = await h1bController(silent.url).control({ target: "冷氣", command: "power", value: true });
    expect(r).toMatchObject({ status: "unconfirmed", why: "no_reply" });
    expect(homeControlLine(r)).toContain("不確定");

    const thenStale = await h1bHub({ send: (_r, n) => (n === 1 ? { ...AIFA_SENT, delayMs: 400 } : { status: 409, body: { detail: "找不到已授權的 AIFA 冷氣" } }) });
    expect(await h1bController(thenStale.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "no_reply" });
    expect(thenStale.sends()).toHaveLength(2);
  });

  it("no_reply notices now carry the send facts (2026-10-25 behaviour change): an ac_temperature with no hub reply says what was sent", async () => {
    // 原本 no_reply 的系統通知不帶附加事實；為了讓關冷氣的定時說明在確認卡之後也念到，改成接上 factsText，
    // 所以 AIFA 設定與紅外線的 no_reply 通知也會帶「送出的設定」「用了預設值」「按的是切換鍵」等。
    const silent = await h1bHub({ status: () => ({ status: 200, body: { sent: false, status: STATUS_ON } }), send: () => ({ ...AIFA_SENT, delayMs: 400 }) });
    const r = await h1bController(silent.url).control({ target: "冷氣", command: "ac_temperature", value: 26 });
    expect(r).toMatchObject({ status: "unconfirmed", why: "no_reply", sent_settings: "模式冷氣、26 度、風量低、擺風自動" });
    const notice = homeControlNotice(r);
    expect(notice).toContain("中控沒有回覆，不確定有沒有執行；請使用者看一下設備，不要說成功。");
    expect(notice).toContain("送出的設定：模式冷氣、26 度、風量低、擺風自動。");
    expect(notice).not.toContain("定時");
  });

  it("「關冷氣」 says the hub cancels the AC's timer (George 2026-10-25): the note is only the sentence for the user; the don'ts are in the tool rules", async () => {
    // 已送出：中控執行了關機，照中控做法定時會被取消；不知道原本有沒有定時。
    const hub = await h1bHub();
    const off = await h1bController(hub.url).control({ target: "冷氣", command: "power", value: false });
    expect(off).toMatchObject({ status: "unconfirmed", why: "one_way", action: "關閉", note: AC_OFF_TIMER_NOTE });
    expect(AC_OFF_TIMER_NOTE).toBe("如果這台冷氣有設定定時，中控關機時會一併取消，需要的話請重新設定。");
    expect(homeControlNotice(off)).toContain(AC_OFF_TIMER_NOTE);
    expect(homeControlLine(off)).toBe("⏳ 客廳 冷氣 關閉：已送出，請確認");
    expect(JSON.parse(hub.sends()[0].body)).toEqual({ power: false });
    // 不能說的話在工具規則裡（API key 路徑與 ChatGPT 方案路徑共用 realtimeToolRules），不在 note。
    for (const note of [AC_OFF_TIMER_NOTE, AC_OFF_TIMER_NOTE_UNSURE]) expect(note).not.toMatch(/不能說|AIOS/);
    const rules = realtimeToolRules({ webSearch: false, home: true, mcp: [] }).join("");
    expect(rules).toContain("關冷氣的 note 提到定時時：AIOS 讀不到定時，不能說確實有定時被取消，也不能說冷氣已經關了。");

    // 開冷氣不提定時。
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "power", value: true })).not.toHaveProperty("note");

    // 中控沒有回覆：加上「如果中控有執行這次關機」；確認卡之後的系統通知也帶上。
    const silent = await h1bHub({ send: () => ({ ...AIFA_SENT, delayMs: 400 }) });
    const unsure = await h1bController(silent.url).control({ target: "冷氣", command: "power", value: false });
    expect(unsure).toMatchObject({ status: "unconfirmed", why: "no_reply", note: AC_OFF_TIMER_NOTE_UNSURE });
    expect(AC_OFF_TIMER_NOTE_UNSURE).toContain("如果中控有執行這次關機");
    expect(homeControlNotice(unsure)).toContain(AC_OFF_TIMER_NOTE_UNSURE);

    // 失敗、沒有送出：中控沒有關機，不說。
    const failed = await h1bHub({ send: () => ({ status: 200, body: { id: "a", status: "failed", message: "AIFA 控制連線未完成，沒有送出開關指令", controller_status: null } }) });
    const r1 = await h1bController(failed.url).control({ target: "冷氣", command: "power", value: false });
    expect(r1).toMatchObject({ status: "failed" });
    expect(JSON.stringify(r1)).not.toContain("定時");
    const notOwned = await h1bHub({ send: () => ({ status: 409, body: { detail: "找不到已授權的 AIFA 冷氣" } }) });
    const r2 = await h1bController(notOwned.url).control({ target: "冷氣", command: "power", value: false });
    expect(r2).toMatchObject({ status: "refused" });
    expect(JSON.stringify(r2)).not.toContain("定時");

    // 紅外線家電的關機不是中控的 AIFA 路徑，不提定時。
    const ir = await h1bController(hub.url).control({ target: "電視", command: "power", value: false });
    expect(ir).toMatchObject({ key: "Power" });
    expect(JSON.stringify(ir)).not.toContain("定時");
  });
});

describe("H1b: the AIFA list older than 24 h", () => {
  const old = () => ({ status: 200, body: aifaList(NOW - 86_000) });

  it("discovers exactly once, then sends", async () => {
    const hub = await h1bHub({ aifa: old });
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "one_way" });
    expect(hub.posts().map((r) => r.url)).toEqual(["/api/v1/integrations/aifa/discover", "/api/v1/integrations/aifa/devices/hub1/children/c1/power"]);
  });

  it("discover fails (409): not_ready, nothing sent; discover finds the AC gone: not_ready, nothing sent", async () => {
    const failed = await h1bHub({ aifa: old, discover: () => ({ status: 409, body: { detail: "AIFA 連線或回覆未完成，請稍後再試" } }) });
    expect(await h1bController(failed.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "refused", reason: "not_ready", message: expect.stringContaining("AIFA 連線或回覆未完成") });
    expect(failed.sends()).toHaveLength(0);

    const gone = await h1bHub({ aifa: old, discover: () => ({ status: 200, body: { ...aifaList(NOW), items: [] } }) });
    expect(await h1bController(gone.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "refused", reason: "not_ready", message: expect.stringContaining("找不到冷氣") });
    expect(gone.sends()).toHaveLength(0);
  });

  it("discover 429 (someone refreshed < 60 s ago): sends anyway and lets the hub decide; a stale 409 is then not_ready with retry_after_s 60", async () => {
    const cooling = { status: 429, body: { detail: "AIFA 清單同步至少相隔 60 秒" } };
    const ok = await h1bHub({ aifa: old, discover: () => cooling });
    expect(await h1bController(ok.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "one_way" });

    const stale = await h1bHub({ aifa: old, discover: () => cooling, send: () => ({ status: 409, body: { detail: "請先重新讀取 AIFA 家電清單" } }) });
    const r = await h1bController(stale.url).control({ target: "冷氣", command: "power", value: true });
    expect(r).toMatchObject({ status: "refused", reason: "not_ready", retry_after_s: 60, message: expect.stringContaining("請先重新讀取 AIFA 家電清單") });
    expect(stale.sends()).toHaveLength(1);
    expect(stale.discovers()).toHaveLength(1);
  });

  it("a stale 409 on a fresh-looking list (hub clock edge): discover once, resend with the same key", async () => {
    const hub = await h1bHub({ send: (_r, n) => (n === 1 ? { status: 409, body: { detail: "請先重新讀取 AIFA 家電清單" } } : AIFA_SENT) });
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed", why: "one_way" });
    expect(hub.posts().map((r) => r.url.split("/").pop())).toEqual(["power", "discover", "power"]);
    const [a, b] = hub.sends();
    expect(b.headers["idempotency-key"]).toBe(a.headers["idempotency-key"]);
  });

  it("climate on an old list: discover, status, climate — in that order", async () => {
    const hub = await h1bHub({ aifa: old });
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "ac_temperature", value: "26" })).toMatchObject({ status: "unconfirmed" });
    expect(hub.posts().map((r) => r.url.split("/").pop())).toEqual(["discover", "status", "climate"]);
  });
});

describe("H1b: Tuya IR appliances", () => {
  it("「打開電視」 presses the Power toggle: one_way, the key named, never 已開", async () => {
    const hub = await h1bHub();
    const result = await h1bController(hub.url).control({ target: "電視", command: "power", value: true });
    expect(result).toEqual({
      ok: true,
      status: "unconfirmed",
      why: "one_way",
      device: "電視",
      room: "客廳",
      action: "按下「Power」鍵",
      message: "Tuya 已接受紅外線指令；家電不回傳狀態，請確認實際反應",
      key: "Power",
      toggle: true,
    });
    expect(homeControlLine(result)).toBe("⏳ 客廳 電視 按下「Power」鍵：已送出，請確認（這是切換鍵）");
    expect(homeControlNotice(result)).toContain("不能說開了、關了");
    const [post] = hub.irs();
    expect(post.url).toBe("/api/v1/devices/ir-tv/infrared-commands");
    expect(JSON.parse(post.body)).toEqual({ key: "Power", key_id: 1 });
    expect(post.headers["idempotency-key"]).toBe("nous_id1");
    expect(hub.commands()).toHaveLength(0);
  });

  it("「大聲一點」 is press volume_up → Vol+; 「頻道減」 and mute find their keys; configured:false does not block an IR device", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    expect(await b.control({ target: "電視", command: "press", value: "volume_up" })).toMatchObject({ status: "unconfirmed", why: "one_way", key: "Vol+", action: "按下「Vol+」鍵" });
    expect(await b.control({ target: "電視", command: "press", value: "channel_down" })).toMatchObject({ key: "頻道減" });
    expect(await b.control({ target: "電視", command: "mute", value: true })).toMatchObject({ key: "Mute" });
    expect(hub.irs().map((r) => JSON.parse(r.body))).toEqual([{ key: "Vol+", key_id: 2 }, { key: "頻道減", key_id: 6 }, { key: "Mute", key_id: 4 }]);
  });

  it("「電風扇開／關」 prefer discrete PowerOn/PowerOff (not a toggle); a named key matches exactly, then by a unique part", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    const on = await b.control({ target: "電風扇", command: "power", value: true });
    expect(on).toMatchObject({ key: "PowerOn" });
    expect(on).not.toHaveProperty("toggle");
    expect(await b.control({ target: "電風扇", command: "power", value: false })).toMatchObject({ key: "PowerOff" });
    expect(await b.control({ target: "電風扇", command: "press", value: "timer" })).toMatchObject({ key: "Timer" });
    expect(await b.control({ target: "電風扇", command: "press", value: "fan_speed" })).toMatchObject({ key: "Speed" });
    expect(await b.control({ target: "電風扇", command: "press", value: "Spe" })).toMatchObject({ key: "Speed" });
  });

  it("a missing key is refused listing the real keys; two different keys for one intent ask which", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    const missing = await b.control({ target: "電風扇", command: "press", value: "oscillate" });
    expect(missing).toMatchObject({ status: "refused", reason: "unsupported", message: "電風扇沒有「擺頭」鍵，指令沒有送出；有：PowerOn、PowerOff、Speed、Timer。" });
    expect(await b.control({ target: "機上盒", command: "press", value: "volume_up" })).toMatchObject({ status: "refused", reason: "invalid_value", message: expect.stringContaining("「音量加」、「Vol+」") });
    expect(hub.irs()).toHaveLength(0);
  });

  it("keys not synced (ready:false) → not_ready without a request; the IR blaster itself and absolute volume are refused", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    expect(await b.control({ target: "投影機", command: "power", value: true })).toMatchObject({ status: "refused", reason: "not_ready", message: expect.stringContaining("按「同步」") });
    expect(await b.control({ target: "紅外線控制器", command: "power", value: true })).toMatchObject({ status: "refused", reason: "unsupported", message: "紅外線控制器是紅外線控制器本身，請說要控制的家電名稱，例如電視。" });
    expect(await b.control({ target: "電視", command: "volume", value: 30 })).toMatchObject({ status: "refused", reason: "unsupported", message: expect.stringContaining("大聲一點") });
    expect(hub.posts()).toHaveLength(0);
  });

  it("an IR air-con remote only presses keys: ac_temperature is refused, Temp+ can be pressed", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    expect(await b.control({ target: "客房空調遙控", command: "ac_temperature", value: "26" })).toMatchObject({ status: "refused", reason: "unsupported", message: expect.stringContaining("只能按它的遙控鍵") });
    expect(await b.control({ target: "客房空調遙控", command: "press", value: "temp 加" })).toMatchObject({ key: "Temp+" });
    expect(hub.sends()).toHaveLength(0);
    expect(hub.irs()).toHaveLength(1);
  });

  it("review: an intent never falls back to part of a key name — 音量▲／頻道▼ beside Up／Down; no volume key is refused, not Up", async () => {
    const home = {
      ...H1B_HOME,
      devices: [
        ...H1B_HOME.devices,
        irDevice("ir-tv2", "臥室電視", null, irKeys("Power", "Up", "Down", "音量▲", "音量▼", "頻道▲", "頻道▼")),
        irDevice("ir-ac3", "窗型冷氣", null, irKeys("Power", "Up", "Down", "Mode")),
      ],
    };
    const hub = await h1bHub({ home });
    const b = h1bController(hub.url);
    expect(await b.control({ target: "臥室電視", command: "press", value: "volume_up" })).toMatchObject({ status: "unconfirmed", key: "音量▲" });
    expect(await b.control({ target: "臥室電視", command: "press", value: "volume_down" })).toMatchObject({ key: "音量▼" });
    expect(await b.control({ target: "臥室電視", command: "press", value: "channel_up" })).toMatchObject({ key: "頻道▲" });
    expect(await b.control({ target: "臥室電視", command: "press", value: "頻道減" })).toMatchObject({ key: "頻道▼" });
    const refused = { status: "refused", reason: "unsupported", message: "窗型冷氣沒有「音量加」鍵，指令沒有送出；有：Power、Up、Down、Mode。" };
    expect(await b.control({ target: "窗型冷氣", command: "press", value: "volume_up" })).toMatchObject(refused);
    expect(await b.control({ target: "窗型冷氣", command: "press", value: "音量加" })).toMatchObject(refused);
    expect(hub.irs().map((r) => JSON.parse(r.body).key)).toEqual(["音量▲", "音量▼", "頻道▲", "頻道▼"]);
  });

  it("review: IR mute is a toggle — mute true and false press the same key, and nothing says 已靜音／已取消靜音", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    for (const value of [true, false]) {
      const r = await b.control({ target: "電視", command: "mute", value });
      expect(r).toMatchObject({ status: "unconfirmed", why: "one_way", key: "Mute", action: "按下「Mute」鍵", toggle: true });
      expect(homeControlLine(r)).toBe("⏳ 客廳 電視 按下「Mute」鍵：已送出，請確認（這是切換鍵）");
      for (const text of [homeControlLine(r), homeControlNotice(r), JSON.stringify(r)]) {
        expect(text).not.toContain("已靜音");
        expect(text).not.toContain("已取消靜音");
      }
    }
    expect(await b.control({ target: "電視", command: "press", value: "mute" })).toMatchObject({ key: "Mute", toggle: true });
    expect(hub.irs().map((r) => JSON.parse(r.body))).toEqual([{ key: "Mute", key_id: 4 }, { key: "Mute", key_id: 4 }, { key: "Mute", key_id: 4 }]);
  });

  it("hub replies: ir_cooldown waits once and resends with the same key; unknown → cloud_no_reply; failed; ir_keys_required; ir_key_unsupported", async () => {
    const cooled = await h1bHub({ ir: (_r, n) => (n === 1 ? { status: 429, body: { detail: { code: "ir_cooldown", message: "請稍候一秒再按下一個按鍵" } } } : IR_SENT) });
    expect(await h1bController(cooled.url).control({ target: "電視", command: "press", value: "volume_up" })).toMatchObject({ why: "one_way" });
    expect(sleeps).toEqual([COOLDOWN_WAIT_MS.infrared]);
    expect(new Set(cooled.irs().map((r) => r.headers["idempotency-key"])).size).toBe(1);

    const unknown = await h1bHub({ ir: () => ({ status: 200, body: { ...IR_SENT.body, transport_status: "unknown", message: "紅外線送出結果不明，請確認家電反應；不會自動重送" } }) });
    const r = await h1bController(unknown.url).control({ target: "電視", command: "press", value: "volume_up" });
    expect(r).toMatchObject({ status: "unconfirmed", why: "cloud_no_reply" });
    expect(homeControlLine(r)).toBe("? 客廳 電視 按下「Vol+」鍵：雲端沒有回覆，不確定有沒有送出（中控不會自動重送）");
    expect(unknown.irs()).toHaveLength(1);

    const cases: [Reply, Record<string, unknown>][] = [
      [{ status: 200, body: { ...IR_SENT.body, status: "failed", transport_status: undefined, message: "Tuya 未接受紅外線指令" } }, { status: "failed", reason: "device", message: "Tuya 未接受紅外線指令" }],
      [{ status: 409, body: { detail: { code: "ir_keys_required", message: "請先同步控制器的家電與按鍵" } } }, { status: "refused", reason: "not_ready" }],
      [{ status: 422, body: { detail: { code: "ir_key_unsupported", message: "此家電尚未提供這個按鍵" } } }, { status: "refused", reason: "unsupported" }],
      [{ status: 409, body: { detail: { code: "ir_not_authorized", message: "此控制器尚未由 Tuya 帳號授權" } } }, { status: "refused", reason: "not_configured" }],
      [{ status: 200, body: { ...IR_SENT.body, status: "accepted", transport_status: undefined } }, { status: "unconfirmed", why: "no_reply" }],
    ];
    for (const [reply, expected] of cases) {
      const hub = await h1bHub({ ir: () => reply });
      expect(await h1bController(hub.url).control({ target: "電視", command: "press", value: "volume_up" })).toMatchObject(expected);
      expect(hub.irs()).toHaveLength(1);
    }
  });
});

describe("H1b: shared rules across routes", () => {
  it("name clashes are tagged by route, and the tagged answer picks that device", async () => {
    const home = { ...H1B_HOME, devices: [...H1B_HOME.devices, irDevice("ir-ac2", "冷氣", "living", irKeys("Power"))] };
    const hub = await h1bHub({ home });
    const b = h1bController(hub.url);
    const asked = await b.control({ target: "冷氣", command: "power", value: true });
    expect(asked).toEqual({ ok: true, status: "ambiguous", candidates: ["客廳的冷氣（紅外線遙控）", "客廳的冷氣（AIFA）"], note: expect.stringContaining("一字不差") });
    expect(await b.control({ target: "客廳的冷氣（AIFA）", command: "power", value: true })).toMatchObject({ status: "unconfirmed", action: "開啟" });
    expect(await b.control({ target: "冷氣（紅外線遙控）", command: "power", value: true })).toMatchObject({ status: "unconfirmed", key: "Power" });
    expect(hub.sends()).toHaveLength(1);
    expect(hub.irs()).toHaveLength(1);
  });

  it("review: an AIFA 冷氣 with no room beside an IR 冷氣 in 客廳 is tagged by route and can be picked by repeating the tag", async () => {
    const home = { ...H1B_HOME, devices: [...H1B_HOME.devices, irDevice("ir-ac2", "冷氣", "living", irKeys("Power"))] };
    const list = aifaList();
    const hub2 = list.items[1] as { children: Record<string, unknown>[] };
    const roomless = { ...list, items: [{ ...hub2, children: [{ ...hub2.children[0], name: "冷氣" }] }] };
    const hub = await h1bHub({ home, aifa: () => ({ status: 200, body: roomless }) });
    const b = h1bController(hub.url);
    const asked = { ok: true, status: "ambiguous", candidates: ["客廳的冷氣（紅外線遙控）", "冷氣（AIFA）"], note: expect.stringContaining("一字不差") };
    expect(await b.control({ target: "冷氣", command: "power", value: true })).toEqual(asked);
    expect(await b.status("冷氣")).toEqual(asked);
    expect(await b.control({ target: "冷氣（AIFA）", command: "power", value: true })).toMatchObject({ status: "unconfirmed", action: "開啟", device: "冷氣", room: null });
    expect(await b.control({ target: "客廳的冷氣（紅外線遙控）", command: "power", value: true })).toMatchObject({ status: "unconfirmed", key: "Power", room: "客廳" });
    // 模型自己加上房間時，路徑仍以括號為準，不會按到紅外線的冷氣。
    expect(await b.control({ target: "客廳的冷氣（AIFA）", command: "power", value: true })).toMatchObject({ status: "unconfirmed", action: "開啟", room: null });
    expect(hub.sends().map((r) => r.url)).toEqual(Array(2).fill("/api/v1/integrations/aifa/devices/hub2/children/c9/power"));
    expect(hub.irs()).toHaveLength(1);
  });

  it("review: the rate slot is taken just before the first control POST — three refusals that never POST, then six sends all go out", async () => {
    let lists = 0;
    const hub = await h1bHub({
      // 第一句話時清單已超過 24 小時，重新讀取失敗；之後是新的清單。
      aifa: () => ({ status: 200, body: aifaList(lists++ === 0 ? NOW - 86_000 : NOW - 3600) }),
      discover: () => ({ status: 409, body: { detail: "AIFA 連線或回覆未完成，請稍後再試" } }),
      status: (n) => ({ status: 200, body: { sent: false, status: { ...STATUS_ON, fan: n === 1 ? "auto" : "low" } } }),
    });
    const b = h1bController(hub.url);
    expect(await b.control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "refused", reason: "not_ready" });
    expect(await b.control({ target: "冷氣", command: "ac_fan", value: "down" })).toMatchObject({ status: "refused", reason: "invalid_value", message: expect.stringContaining("不知道目前風量") });
    expect(await b.control({ target: "冷氣", command: "ac_fan", value: "down" })).toMatchObject({ status: "refused", reason: "invalid_value", message: expect.stringContaining("已經是最低") });
    expect(hub.sends()).toHaveLength(0);
    for (let i = 0; i < 3; i++) expect(await b.control({ target: "書桌燈", command: "power", value: i % 2 === 0 })).toMatchObject({ status: "confirmed" });
    expect(await b.control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed" });
    expect(await b.control({ target: "冷氣", command: "ac_temperature", value: "26" })).toMatchObject({ status: "unconfirmed" });
    expect(await b.control({ target: "電視", command: "press", value: "volume_up" })).toMatchObject({ status: "unconfirmed" });
    // 仍是每個意圖一次：第 7 個送出的意圖不送。
    const before = hub.posts().length;
    expect(await b.control({ target: "電視", command: "press", value: "volume_down" })).toMatchObject({ status: "refused", reason: "rate_limited" });
    expect(hub.posts()).toHaveLength(before);
  });

  it("「冷氣26度」 is never a status metric, and ac_temperature never reaches /commands or becomes colour temperature", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    expect(await b.control({ target: "書桌燈", command: "ac_temperature", value: "26" })).toMatchObject({ status: "refused", reason: "unsupported", message: expect.stringContaining("不是 AIFA 冷氣或紅外線家電") });
    expect(await b.control({ target: "冷氣", command: "temperature", value: "26" })).toMatchObject({ status: "refused", reason: "invalid_value" });
    expect(hub.commands()).toHaveLength(0);
    const snapshot = { ...parseHome(H1B_HOME), devices: [...parseHome(H1B_HOME).devices, ...parseAifa(aifaList(), parseHome(H1B_HOME).devices).devices] };
    expect(resolveTarget(snapshot, "冷氣26度")).toMatchObject({ kind: "match", metric: null, devices: [{ id: "aifa:hub1:c1" }] });
  });

  it("one rate limit for all routes: 3 lights + 2 AC + 1 IR, then the 7th is refused with no request", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url);
    for (let i = 0; i < 3; i++) expect(await b.control({ target: "書桌燈", command: "power", value: i % 2 === 0 })).toMatchObject({ status: "confirmed" });
    expect(await b.control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "unconfirmed" });
    expect(await b.control({ target: "冷氣", command: "ac_temperature", value: "26" })).toMatchObject({ status: "unconfirmed" });
    expect(await b.control({ target: "電視", command: "press", value: "volume_up" })).toMatchObject({ status: "unconfirmed" });
    const before = hub.posts().length;
    expect(await b.control({ target: "電視", command: "press", value: "volume_up" })).toMatchObject({ status: "refused", reason: "rate_limited" });
    expect(hub.posts()).toHaveLength(before);
  });

  it("confirm cards work on AIFA and IR: the card names the matched key; approve sends once; reject sends nothing", async () => {
    const hub = await h1bHub();
    const b = h1bController(hub.url, { policyFor: () => "confirm" });
    const card = await b.control({ target: "電視", command: "press", value: "volume_up" });
    expect(card).toMatchObject({ status: "needs_confirmation", action: "按下「Vol+」鍵", device: "電視" });
    const id = (card as Extract<HomeControlResult, { status: "needs_confirmation" }>).confirm_id;
    const [x, y] = await Promise.all([b.confirm(id, true), b.confirm(id, true)]);
    expect(x).toMatchObject({ status: "unconfirmed", why: "one_way", key: "Vol+" });
    expect(y).toEqual(x);
    expect(hub.irs()).toHaveLength(1);

    const ac = (await b.control({ target: "冷氣", command: "ac_temperature", value: "26" })) as Extract<HomeControlResult, { status: "needs_confirmation" }>;
    expect(ac).toMatchObject({ status: "needs_confirmation", action: "設定 26 度" });
    expect(hub.statuses()).toHaveLength(0);
    expect(await b.confirm(ac.confirm_id, false)).toMatchObject({ status: "refused", reason: "declined", message: "沒有確認，冷氣設定 26 度沒有執行。" });
    const again = (await b.control({ target: "冷氣", command: "ac_temperature", value: "26" })) as Extract<HomeControlResult, { status: "needs_confirmation" }>;
    expect(await b.confirm(again.confirm_id, true)).toMatchObject({ status: "unconfirmed", sent_settings: "模式冷氣、26 度、風量低、擺風自動" });
    expect(hub.posts().map((r) => r.url.split("/").pop())).toEqual(["infrared-commands", "status", "climate"]);
  });

  it("invariant: no AIFA or IR result is ever confirmed (even if a hub said so), and the token never appears", async () => {
    const hub = await h1bHub({
      send: () => ({ status: 200, body: { ...AIFA_SENT.body, status: "confirmed" } }),
      ir: () => ({ status: 200, body: { ...IR_SENT.body, status: "confirmed" } }),
    });
    const b = h1bController(hub.url);
    const results = [
      await b.control({ target: "冷氣", command: "power", value: true }),
      await b.control({ target: "冷氣", command: "ac_mode", value: "dry" }),
      await b.control({ target: "電視", command: "power", value: false }),
      await b.control({ target: "電風扇", command: "press", value: "Speed" }),
      await b.control({ target: "投影機", command: "power", value: true }),
      await b.control({ target: "書房冷氣", command: "ac_fan", value: "low" }),
    ];
    for (const r of results) {
      expect(r.status).not.toBe("confirmed");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(homeControlLine(r)).not.toContain("✓");
    }
    for (const r of hub.requests) expect(r.body).not.toContain(TOKEN);
  });
});

describe("H1b: time budget (fake clock)", () => {
  const T = H1B_TIMEOUTS_MS;
  const sum = (...ms: number[]) => ms.reduce((a, b) => a + b, 0);

  it("the nominal worst cases are the sums of the constants; the deadline caps every route at 60 s", () => {
    // 算法寫在 docs/validation/smarthome-h1b-2026-10-22.md；這裡只加常數，不寫死總和以外的數字。
    const routes = {
      aifaClimateStale: sum(T.snapshot, T.aifaDiscover, T.aifaStatus, T.aifaSend, T.aifaRetry),
      aifaClimate: sum(T.snapshot, T.aifaStatus, T.aifaSend, T.aifaRetry),
      aifaPower: sum(T.snapshot, T.aifaSend, T.aifaRetry),
      aifaPowerStale: sum(T.snapshot, T.aifaDiscover, T.aifaSend, T.aifaRetry),
      ir: sum(T.snapshot, T.irSend, T.irRetry),
    };
    expect(routes).toEqual({ aifaClimateStale: 83_000, aifaClimate: 58_000, aifaPower: 36_000, aifaPowerStale: 61_000, ir: 34_000 });
    expect(UTTERANCE_MS).toBe(60_000);
    for (const nominal of Object.values(routes)) expect(Math.min(nominal, UTTERANCE_MS)).toBeLessThanOrEqual(60_000);
    // H1 的 /commands 最壞 8 + 16 + 15 + 16 = 55 秒，deadline 不會截到它（H1 不變）。
    expect(sum(T.snapshot, 16_000, 15_000, 16_000)).toBeLessThan(UTTERANCE_MS);
    expect(MIN_SEND_WINDOW_MS).toBe(5_000);
  });

  it("a stale climate whose steps all run to their timeouts: the resend is skipped and the total stays ≤ 60 s (no_reply)", async () => {
    let start = 0;
    const hub = await h1bHub({
      aifa: () => ({ status: 200, body: aifaList(NOW - 86_000) }),
      discover: () => ((clock += T.aifaDiscover), { status: 200, body: aifaList(NOW) }),
      status: () => ((clock += T.aifaStatus), { status: 200, body: { sent: false, status: STATUS_ON } }),
      // AIOS 這時只剩 13 秒，第一次送出的逾時被截成 13 秒（假時鐘推進的是 AIOS 等的時間）。
      send: () => ((clock += UTTERANCE_MS - T.aifaDiscover - T.aifaStatus), { status: 503, body: {} }),
    });
    const b = h1bController(hub.url);
    start = clock;
    const r = await b.control({ target: "冷氣", command: "ac_temperature", value: "26" });
    // 讀清單沒有推進時鐘；25 + 22 + 第一次送出截成剩下的 13 秒 = 60 秒，之後不到 5 秒不再送。
    expect(r).toMatchObject({ status: "unconfirmed", why: "no_reply" });
    expect(hub.sends()).toHaveLength(1);
    expect(clock - start).toBeLessThanOrEqual(UTTERANCE_MS);
  });

  it("the deadline before the first POST: refused not_ready (「沒有送出」), no POST", async () => {
    const hub = await h1bHub({
      aifa: () => ({ status: 200, body: aifaList(NOW - 86_000) }),
      discover: () => ((clock += 40_000), { status: 200, body: aifaList(NOW) }),
      status: () => ((clock += 17_000), { status: 200, body: { sent: false, status: STATUS_ON } }),
    });
    const r = await h1bController(hub.url).control({ target: "冷氣", command: "ac_temperature", value: "26" });
    expect(r).toMatchObject({ status: "refused", reason: "not_ready", message: expect.stringContaining("沒有送出") });
    expect(hub.sends()).toHaveLength(0);
  });

  it("a cooldown with no time left for the resend: rate_limited, one POST", async () => {
    const hub = await h1bHub({ send: () => ((clock += 56_000), { status: 429, body: { detail: "請稍候兩秒再操作" } }) });
    expect(await h1bController(hub.url).control({ target: "冷氣", command: "power", value: true })).toMatchObject({ status: "refused", reason: "rate_limited", retry_after_s: 2 });
    expect(hub.sends()).toHaveLength(1);
  });
});

describe("H1b: pure helpers", () => {
  it("keyNorm treats ＋/加 as +, keeps a trailing -, and drops spaces, _ and inner -", () => {
    expect(keyNorm("Vol ＋")).toBe("vol+");
    expect(keyNorm("音量加")).toBe(keyNorm("音量+"));
    expect(keyNorm("Vol-")).toBe("vol-");
    expect(keyNorm("CH_UP")).toBe("chup");
    expect(keyNorm("power-on")).toBe("poweron");
    // 審查修正：U+2212 減號、全形＋／－、▲／▼。
    expect(keyNorm("Vol −")).toBe(keyNorm("Vol-"));
    expect(keyNorm("音量－")).toBe("音量-");
    expect(keyNorm("Vol＋")).toBe("vol+");
    expect(keyNorm("音量▲")).toBe(keyNorm("音量+"));
    expect(keyNorm("頻道 ▼")).toBe(keyNorm("頻道-"));
    expect(keyNorm("CH▼")).toBe("ch-");
  });

  it("review: keys sharing key_id 0 (the hub's default) are still told apart by key — 「vol」 asks which", () => {
    const keys = [
      { key: "Vol+", key_id: 0, label: "Vol+" },
      { key: "Vol-", key_id: 0, label: "Vol-" },
    ];
    const r = matchKey("電視", keys, { command: "press", intent: null, spoken: "vol" });
    expect(r).toEqual({ refuse: "invalid_value", message: "電視有好幾個可能的鍵：「Vol+」、「Vol-」；要按哪一個？指令沒有送出。" });
    // 同一個鍵列兩次仍是同一個鍵。
    expect(matchKey("電視", [keys[0], { ...keys[0] }], { command: "press", intent: "volume_up", spoken: "volume_up" })).toEqual({ key: keys[0], toggle: false });
  });

  it("every IR intent has a non-empty synonym row, with no bare mode words", () => {
    for (const intent of IR_INTENTS) expect(IR_SYNONYMS[intent].length).toBeGreaterThan(0);
    const all = Object.values(IR_SYNONYMS).flat().map(keyNorm);
    for (const bare of ["auto", "on", "off", "低", "中", "高", "自動"]) expect(all).not.toContain(bare);
  });

  it("buildClimate fills from the report, then the defaults, and lists each default", () => {
    const caps = { minC: 17, maxC: 30, modes: [...AC_MODES], fans: [...AC_FANS], swings: [...AC_SWINGS], features: [...AC_FEATURES] };
    expect(buildClimate({ command: "ac_temperature", celsius: 22 }, null, caps)).toEqual({
      packet: { mode: "auto", temperature: 22, fan: "auto", swing: "auto", feature: "normal" },
      text: "模式自動、22 度、風量自動、擺風自動",
      defaultsUsed: ["風量：自動", "模式：自動", "擺風：自動", "特殊功能：一般"],
    });
    // 模式預設是自動，不分季節（George 2026-10-25）；這台不支援自動時才退到它的第一個模式。
    expect(CLIMATE_DEFAULTS.mode).toBe("auto");
    expect(buildClimate({ command: "ac_temperature", celsius: 22 }, null, { ...caps, modes: ["cool", "dry"] })).toMatchObject({ packet: { mode: "cool" }, defaultsUsed: expect.arrayContaining(["模式：冷氣"]) });
    // 控制器有回報模式時照回報，不用預設。
    expect(buildClimate({ command: "ac_temperature", celsius: 22 }, { power: true, mode: "cool", temperature: 25, fan: "low", swing: "auto", feature: "normal" }, caps)).toMatchObject({ packet: { mode: "cool" }, defaultsUsed: [] });
    expect(buildClimate({ command: "ac_fan", value: "up" }, { power: true, mode: "dry", temperature: 25, fan: "high", swing: "auto", feature: "turbo" }, caps)).toEqual({ error: "風量已經是最高，指令沒有送出。" });
  });

  it("parseCommand accepts the spoken air-con and key words", () => {
    expect(parseCommand("ac_temperature", "26°C")).toEqual({ command: "ac_temperature", celsius: 26 });
    expect(parseCommand("ac_mode", "冷氣")).toEqual({ command: "ac_mode", value: "cool" });
    expect(parseCommand("ac_mode", "暖氣")).toHaveProperty("error");
    expect(parseCommand("ac_fan", "調小")).toEqual({ command: "ac_fan", value: "down" });
    expect(parseCommand("ac_swing", "固定3")).toEqual({ command: "ac_swing", value: "fixed_3" });
    expect(parseCommand("press", "volume_up")).toEqual({ command: "press", intent: "volume_up", spoken: "volume_up" });
    expect(parseCommand("press", "音量加")).toEqual({ command: "press", intent: "volume_up", spoken: "音量加" });
    expect(parseCommand("press", "Input")).toEqual({ command: "press", intent: null, spoken: "Input" });
    expect(parseCommand("press", "")).toHaveProperty("error");
  });

  it("matchKey picks the toggle only when there is no discrete key", () => {
    const keys = [{ key: "Power", key_id: 1, label: "電源" }];
    expect(matchKey("電視", keys, { command: "power", value: false })).toEqual({ key: keys[0], toggle: true });
    expect(matchKey("電視", [], { command: "power", value: false })).toMatchObject({ refuse: "unsupported", message: expect.stringContaining("沒有同步到任何遙控按鍵") });
  });
});
