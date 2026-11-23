// HOME-1（George 2026-11-07）：左上角家中狀態。核心的整理（GET /api/home/overview）、快取、設定（home-corner.json）、
// 選單列、頁面要畫的內容（兩種語言）、排程與角落的 DOM。假中控（fixture）：欄位照武陵居中控 GET /api/v1/home 與
// GET /integrations/aifa 的回應，設備、房間與讀值都是虛構的，不代表真實家裡。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeCornerSettingsStore } from "../server/home-corner-settings.ts";
import { HomeBridge, HomeBridgeError, parseAifa, parseHome, type HubSnapshot } from "../server/home-bridge.ts";
import { HOME_OVERVIEW_AFTER_CONTROL_TTL_MS, HomeOverview, overviewFromSnapshot, type HomeOverviewSource } from "../server/home-overview.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import {
  DEFAULT_HOME_CORNER_PREFS,
  HOME_CORNER_TEXT,
  HomeCornerPatchError,
  homeCornerModel,
  parseHomeCornerPatch,
  type HomeClimateReading,
  type HomeCornerSettingsView,
  type HomeOverviewView,
} from "../shared/home-corner.ts";
import { HOME_CORNER_TEXT as MENU_TEXT, homeCornerMenu, settingsMenu } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";
import type { SettingsView } from "../shared/types.ts";
import { HomeFeed } from "../src/home-feed.ts";

const NOW_S = 1_794_031_800; // 2026-11-07 06:10 UTC
const NOW_MS = NOW_S * 1000;

const metric = (key: string, label: string, unit: string, precision: number, value: number | null) => ({ key, code: key, label, unit, precision, group: "environment", value, alarm: false });
const sensor = (id: string, room: string, status: string, receivedAgoS: number, metrics: ReturnType<typeof metric>[]) => ({
  id,
  name: `${id} 感測器`,
  kind: "sensor",
  placement: { room_id: room },
  state: { available: true, fresh: status === "live" },
  telemetry: { metrics, status, received_at: NOW_S - receivedAgoS, source_label: "Tuya 區網" },
});
const light = (id: string, name: string, state: Record<string, unknown>, kind = "light", extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind,
  placement: { room_id: "living" },
  configured: true,
  state: { available: true, fresh: true, ...state },
  telemetry: null,
  ...extra,
});

const HOME = {
  layout: { rooms: [{ id: "living", name: "客廳" }, { id: "study", name: "書房" }] },
  devices: [
    sensor("th-live", "living", "live", 120, [metric("temperature", "溫度", "°C", 1, 26.53), metric("humidity", "濕度", "%", 0, 62.4)]),
    sensor("th-stale", "study", "stale", 3 * 3600, [metric("temperature", "溫度", "°C", 1, 30.1), metric("co2", "二氧化碳", "ppm", 0, 812)]),
    light("l1", "客廳主燈", { values: { power: true } }),
    light("l2", "客廳立燈", { values: { power: false } }),
    light("l3", "書桌燈", { values: { power: true }, fresh: false }),
    light("l6", "餐桌燈", { values: { power: true }, fresh: false, age_seconds: 600 }),
    light("l4", "床頭燈", {}),
    light("l5", "走廊燈", { power: true, available: false }),
    light("p1", "延長線", { power: true, values: {} }, "switch", { config: { cloud_category: "cz" } }),
    // 冷氣（Tuya kt）匯入成 kind switch：不是可開關的插座，不算進數量。
    light("kt", "客房冷氣", { power: true }, "switch", { config: { cloud_category: "kt" } }),
    light("ir", "電視", {}, "remote", { infrared: { keys: [], ready: false }, config: { infrared_virtual: true } }),
  ],
  server_time: NOW_S,
};

const AIFA = {
  connected: true,
  queried_at: NOW_S - 600,
  items: [
    {
      id: "hub1",
      online: true,
      matched_device_id: null,
      children: [
        { id: "c1", name: "主臥冷氣", type: "0", sub_type: "0", capabilities: null },
        { id: "c2", name: "書房冷氣", type: "0", sub_type: "0", capabilities: null },
      ],
    },
  ],
};

function snapshot(home: unknown = HOME, aifa: unknown = AIFA): HubSnapshot {
  const h = parseHome(home);
  const a = parseAifa(aifa, h.devices);
  return { ...h, devices: [...h.devices, ...a.devices], aifa: a.aifa };
}

describe("overview from the hub snapshot", () => {
  it("counts on/off from the hub's state.values.power (legacy state.power too); offline, unreported or older-without-age devices are unknown; older readings carry their age", () => {
    const view = overviewFromSnapshot(snapshot(), NOW_MS, 0);
    expect(view.switches).toEqual([
      { group: "light", total: 6, on: 2, unknown: 3, on_names: ["客廳主燈", "餐桌燈"], oldest_age_s: 600 },
      { group: "switch", total: 1, on: 1, unknown: 0, on_names: ["延長線"], oldest_age_s: null },
    ]);
  });

  it("shows the oldest age of a not-fresh reading next to the counts", () => {
    const view = { configured: true as const, state: "ok" as const, server_now: NOW_S, climate: [],
      switches: [{ group: "light" as const, total: 3, on: 2, unknown: 0, on_names: ["客廳主燈", "餐桌燈"], oldest_age_s: 600 }] };
    const zh = homeCornerModel({ view, coreDown: false, locale: "zh-TW" });
    const en = homeCornerModel({ view, coreDown: false, locale: "en" });
    expect(JSON.stringify(zh)).toContain("最舊的讀值 10 分鐘前");
    expect(JSON.stringify(en)).toContain("oldest reading");
  });

  it("picks the live sensor first, keeps the stale one only for a key the live one lacks (tagged as another sensor), and ages from the hub clock", () => {
    const view = overviewFromSnapshot(snapshot(), NOW_MS, 30);
    expect(view.climate).toEqual([
      { key: "temperature", sensor: 0, value: 26.53, unit: "°C", precision: 1, room: "客廳", status: "live", age_s: 150 },
      { key: "humidity", sensor: 0, value: 62.4, unit: "%", precision: 0, room: "客廳", status: "live", age_s: 150 },
      { key: "co2", sensor: 1, value: 812, unit: "ppm", precision: 0, room: "書房", status: "stale", age_s: 3 * 3600 + 30 },
    ]);
  });

  it("a missing reading is null (never 0) and marked missing", () => {
    const home = { ...HOME, devices: [sensor("th", "living", "live", 60, [metric("temperature", "溫度", "°C", 1, null)])] };
    expect(overviewFromSnapshot(snapshot(home), NOW_MS, 0).climate).toEqual([{ key: "temperature", sensor: 0, value: null, unit: "°C", precision: 1, room: "客廳", status: "missing", age_s: 60 }]);
  });

  it("air conditioners are not part of the overview (George 2026-11-07)", () => {
    const view = overviewFromSnapshot(snapshot(), NOW_MS, 0);
    expect(Object.keys(view).sort()).toEqual(["climate", "configured", "server_now", "state", "switches"]);
    expect(JSON.stringify(view)).not.toMatch(/冷氣/);
  });

  it("names are capped at 4 and the response has no device ids, tokens or hub addresses", () => {
    const many = { ...HOME, devices: Array.from({ length: 7 }, (_, i) => light(`id-${i}`, `燈${i}`, { power: true })) };
    const view = overviewFromSnapshot(snapshot(many, { connected: false, items: [] }), NOW_MS, 0);
    expect(view.switches[0]).toMatchObject({ total: 7, on: 7, on_names: ["燈0", "燈1", "燈2", "燈3"] });
    expect(JSON.stringify(view)).not.toMatch(/id-\d|hub1|aifa:/);
  });
});

function fakeSource(read: () => Promise<HubSnapshot>, available = true) {
  const state = { reads: 0, changes: 0 };
  const source: HomeOverviewSource = {
    available,
    get changes() {
      return state.changes;
    },
    readSnapshot: () => {
      state.reads++;
      return read();
    },
  };
  return { source, state };
}

describe("HomeOverview cache", () => {
  it("not configured → {configured:false} without calling the hub", async () => {
    const { source, state } = fakeSource(async () => snapshot(), false);
    expect(await new HomeOverview({ source }).view()).toEqual({ configured: false });
    expect(state.reads).toBe(0);
  });

  it("one hub request in flight, cached 30 s, re-read after a control or after the TTL", async () => {
    let now = NOW_MS;
    let release: () => void = () => {};
    const { source, state } = fakeSource(() => new Promise((r) => (release = () => r(snapshot()))));
    const overview = new HomeOverview({ source, now: () => now });
    const both = Promise.all([overview.view(), overview.view()]);
    release();
    const [a, b] = await both;
    expect(state.reads).toBe(1);
    expect(a).toEqual(b);
    now += 29_000;
    const cached = (await overview.view()) as Extract<HomeOverviewView, { state: "ok" }>;
    expect(state.reads).toBe(1);
    expect(cached.climate[0].age_s).toBe(120 + 29);
    state.changes++;
    const after = overview.view();
    release();
    await after;
    expect(state.reads).toBe(2);
    now += 31_000;
    const late = overview.view();
    release();
    await late;
    expect(state.reads).toBe(3);
  });

  it("a read that started before a control finished is not reused: the next view waits for it and reads again; that post-control result is cached only 5 s", async () => {
    let now = NOW_MS;
    const resolvers: (() => void)[] = [];
    const { source, state } = fakeSource(() => new Promise((r) => resolvers.push(() => r(snapshot()))));
    const overview = new HomeOverview({ source, now: () => now });
    const before = overview.view();
    state.changes++;
    let afterDone = false;
    const after = overview.view().then(() => (afterDone = true));
    expect(state.reads).toBe(1);
    resolvers[0]();
    await before;
    await new Promise((r) => setTimeout(r, 0));
    expect(state.reads).toBe(2);
    expect(afterDone).toBe(false);
    resolvers[1]();
    await after;
    now += HOME_OVERVIEW_AFTER_CONTROL_TTL_MS - 1;
    await overview.view();
    expect(state.reads).toBe(2);
    now += 2;
    const followup = overview.view();
    resolvers[2]();
    await followup;
    expect(state.reads).toBe(3);
    now += 20_000;
    await overview.view();
    expect(state.reads).toBe(3);
  });

  it("unreachable hub: an honest error code, also cached so a down hub is not hammered", async () => {
    let now = NOW_MS;
    const errors = [
      new HomeBridgeError("武陵居中控沒有回應（逾時）。", 502, { code: "timeout" }),
      new HomeBridgeError("x", 502, { code: "auth" }),
      new HomeBridgeError("x", 502, { code: "bad_response" }),
      new HomeBridgeError("x", 502, { code: "unreachable" }),
      new Error("boom"),
    ];
    const { source, state } = fakeSource(async () => {
      throw errors[state.reads - 1];
    });
    const overview = new HomeOverview({ source, now: () => now });
    const codes: unknown[] = [];
    for (let i = 0; i < errors.length; i++) {
      const view = await overview.view();
      expect(await overview.view()).toEqual(view);
      codes.push((view as { error: string }).error);
      expect(view).toMatchObject({ configured: true, state: "unreachable", server_now: now });
      now += 30_000;
    }
    expect(codes).toEqual(["timeout", "auth", "bad_response", "unreachable", "unreachable"]);
    expect(state.reads).toBe(errors.length);
  });
});

/** 假中控：GET /home、GET /integrations/aifa，POST …/status 回控制器狀態，POST …/power、…/climate 回已送出；記下每個請求。 */
function fakeHubFetch(opts: { home?: () => Response; status?: (path: string) => Response | Promise<Response>; aifa?: unknown } = {}) {
  const calls: { method: string; path: string }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    if (path === "/api/v1/home") return opts.home?.() ?? Response.json(HOME);
    if (path === "/api/v1/integrations/aifa") return Response.json(opts.aifa ?? AIFA);
    if (method === "POST" && path.endsWith("/status")) return opts.status?.(path) ?? Response.json({ status: { power: true, mode: "dry", temperature: 25, fan: "low", swing: "auto", feature: "normal" } });
    if (method === "POST" && /\/(power|climate)$/.test(path)) return Response.json({ id: "a1", status: "unconfirmed", message: "已透過 AIFA 連線送出", controller_status: null });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("HomeBridge read side for the corner", () => {
  it("parses state.power, sends only GETs for the snapshot, and maps errors to codes", async () => {
    const hub = fakeHubFetch();
    const bridge = new HomeBridge({ url: "http://hub.test", token: "t", fetch: hub.fetch });
    const snap = await bridge.readSnapshot();
    expect(snap.devices.find((d) => d.name === "客廳主燈")?.power).toBe(true);
    expect(snap.devices.find((d) => d.name === "床頭燈")?.power).toBeNull();
    expect(hub.calls.every((c) => c.method === "GET")).toBe(true);
    const down = new HomeBridge({ url: "http://hub.test", token: "t", fetch: fakeHubFetch({ home: () => new Response("", { status: 401 }) }).fetch });
    await expect(down.readSnapshot()).rejects.toMatchObject({ code: "auth" });
    const odd = new HomeBridge({ url: "http://hub.test", token: "t", fetch: fakeHubFetch({ home: () => Response.json({ nope: 1 }) }).fetch });
    await expect(odd.readSnapshot()).rejects.toMatchObject({ code: "bad_response" });
  });

  it("reading the corner never asks the hub for an air conditioner's status (no background /status reads)", async () => {
    const hub = fakeHubFetch();
    const bridge = new HomeBridge({ url: "http://hub.test", token: "t", fetch: hub.fetch });
    const overview = new HomeOverview({ source: bridge });
    await overview.view();
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.calls.some((c) => c.path.endsWith("/status"))).toBe(false);
    expect(hub.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

const ok = (over: Partial<Extract<HomeOverviewView, { state: "ok" }>> = {}): HomeOverviewView => ({
  ...overviewFromSnapshot(snapshot(), NOW_MS, 0),
  ...over,
});

describe("corner content (zh / en)", () => {
  it("data: the living-room temperature and humidity, the study's stale CO₂ on its own line with its room and age, lights and unknown counts; no air conditioner line", () => {
    const zh = homeCornerModel({ view: ok(), coreDown: false, locale: "zh-TW" });
    expect(zh).toMatchObject({ kind: "data", temp: "26.5°", humidity: "62%", climateRoom: "客廳", climateDetail: null, climateOther: ["書房 CO₂ 812 ppm · 3 小時前"], refreshing: false });
    expect(zh.lines.map((l) => [l.icon, l.text, l.extra, l.detail, l.qualifier, l.active])).toEqual([
      ["bulb", "燈 2／6 開著", "3 個未知", "客廳主燈、餐桌燈", "最舊的讀值 10 分鐘前", true],
      ["plug", "插座開關 1／1 開著", null, "延長線", null, true],
    ]);
    expect(zh.label.startsWith("家中狀態：26.5°，濕度 62%，客廳，書房 CO₂ 812 ppm · 3 小時前")).toBe(true);
    const en = homeCornerModel({ view: ok(), coreDown: false, locale: "en" });
    expect(en.climateOther).toEqual(["書房 CO₂ 812 ppm · 3 h ago"]);
    expect(en.lines.map((l) => [l.text, l.extra])).toEqual([["Lights 2/6 on", "3 unknown"], ["Plugs & switches 1/1 on", null]]);
    expect(en.label).toMatch(/^Home status: 26\.5°, Humidity 62%/);
  });

  it("readings from different sensors are never merged: each carries its own room and age; same-sensor extras stay with the main line", () => {
    const r = (key: HomeClimateReading["key"], sensor: number, value: number, room: string, status: HomeClimateReading["status"], age_s: number): HomeClimateReading => ({
      key,
      sensor,
      value,
      unit: key === "temperature" ? "°C" : key === "humidity" ? "%" : key === "co2" ? "ppm" : "µg/m³",
      precision: key === "temperature" ? 1 : 0,
      room,
      status,
      age_s,
    });
    const view = ok({
      climate: [r("temperature", 0, 24, "客廳", "stale", 2 * 3600), r("humidity", 1, 55, "書房", "live", 60), r("co2", 0, 700, "客廳", "stale", 2 * 3600), r("pm25", 2, 12, "主臥", "snapshot", 15 * 60)],
    });
    const zh = homeCornerModel({ view, coreDown: false, locale: "zh-TW" });
    expect(zh).toMatchObject({ temp: "24.0°", humidity: null, climateRoom: "客廳", climateDetail: "CO₂ 700 ppm · 2 小時前" });
    expect(zh.climateOther).toEqual(["書房 濕度 55%", "主臥 PM2.5 12 µg/m³ · 15 分鐘前"]);
    expect(homeCornerModel({ view, coreDown: false, locale: "en" }).climateOther).toEqual(["書房 Humidity 55%", "主臥 PM2.5 12 µg/m³ · 15 min ago"]);
  });

  it("refreshing: a 「更新中…」 note and the flag, only while there is data", () => {
    expect(homeCornerModel({ view: ok(), coreDown: false, locale: "zh-TW", refreshing: true })).toMatchObject({ refreshing: true, refreshNote: "更新中…" });
    expect(homeCornerModel({ view: ok(), coreDown: false, locale: "en", refreshing: true }).label).toMatch(/^Home status: Updating…, 26\.5°/);
  });

  it("no reported switch at all → 「—」, not 0", () => {
    const view = ok({ switches: [{ group: "light", total: 8, on: 0, unknown: 8, on_names: [], oldest_age_s: null }], climate: [] });
    expect(homeCornerModel({ view, coreDown: false, locale: "zh-TW" }).lines.map((l) => l.text)).toEqual(["燈 —／8"]);
    expect(homeCornerModel({ view, coreDown: false, locale: "en" }).lines.map((l) => l.text)).toEqual(["Lights —/8"]);
  });

  it("missing temperature is 「—」 with no age", () => {
    const view = ok({ climate: [{ key: "temperature", sensor: 0, value: null, unit: "°C", precision: 1, room: "客廳", status: "missing", age_s: 30 }] });
    expect(homeCornerModel({ view, coreDown: false, locale: "zh-TW" })).toMatchObject({ temp: "—", humidity: null, climateRoom: "客廳", climateDetail: null, climateOther: [] });
  });

  it.each([
    [{ configured: false } as HomeOverviewView, false, "智慧家庭未設定", null, "Smart home not set up", null],
    [{ configured: true, state: "unreachable", error: "timeout", server_now: NOW_MS } as HomeOverviewView, false, "讀不到中控", "中控沒有回應（逾時）", "Can't reach the home controller", "The controller did not respond (timeout)"],
    [{ configured: true, state: "unreachable", error: "auth", server_now: NOW_MS } as HomeOverviewView, false, "讀不到中控", "中控拒絕了權杖", "Can't reach the home controller", "The controller rejected the token"],
    [null, true, "讀不到中控", "核心沒有回應", "Can't reach the home controller", "The core is not responding"],
    [ok({ climate: [], switches: [] }), false, "中控沒有可顯示的設備", null, "No devices to show from the controller", null],
  ])("note %#: one muted line, no numbers", (view, coreDown, zhNote, zhDetail, enNote, enDetail) => {
    const zh = homeCornerModel({ view, coreDown, locale: "zh-TW" });
    expect(zh).toMatchObject({ kind: "note", note: zhNote, noteDetail: zhDetail, temp: null, lines: [] });
    expect(homeCornerModel({ view, coreDown, locale: "en" })).toMatchObject({ note: enNote, noteDetail: enDetail });
  });

  it("nothing yet → nothing drawn", () => {
    expect(homeCornerModel({ view: null, coreDown: false, locale: "zh-TW" }).kind).toBe("none");
  });

  it("every corner and settings string has an English translation", () => {
    for (const source of Object.values(HOME_CORNER_TEXT)) {
      const values = source.includes("{1}") ? ["1", "2"] : source.includes("{0}") ? ["1"] : [];
      expect(translate(source, "en", ...values), source).not.toMatch(/[一-鿿]/u);
    }
    for (const source of ["家中狀態設定必須是 JSON 物件", "未知的家中狀態設定：x", "家中狀態設定沒有保存", "家中狀態設定沒有保存：x", "家中狀態設定沒有保存（無法寫入設定檔：x）"]) {
      expect(translate(source, "en"), source).not.toMatch(/[一-鿿]/u);
    }
  });
});

describe("HomeFeed schedule", () => {
  function timers() {
    const list: { fn: () => void; ms: number; done: boolean }[] = [];
    return {
      list,
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms, done: false };
        list.push(t);
        return t;
      },
      clearTimer: (h: unknown) => {
        if (h) (h as { done: boolean }).done = true;
      },
      fire: (ms: number) => list.filter((t) => !t.done && t.ms === ms).forEach((t) => ((t.done = true), t.fn())),
    };
  }

  it("refreshes every 60 s, one request at a time, a re-read requested mid-flight runs right after", async () => {
    const t = timers();
    const resolvers: ((v: HomeOverviewView) => void)[] = [];
    let updates = 0;
    const feed = new HomeFeed({ fetchOverview: () => new Promise((r) => resolvers.push(r)), onUpdate: () => updates++, setTimer: t.setTimer, clearTimer: t.clearTimer });
    feed.resume();
    void feed.load();
    expect(resolvers).toHaveLength(1);
    resolvers[0]({ configured: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolvers).toHaveLength(2);
    resolvers[1](ok());
    await new Promise((r) => setTimeout(r, 0));
    expect(updates).toBe(2);
    expect(feed.model("zh-TW").kind).toBe("data");
    t.fire(60_000);
    expect(resolvers).toHaveLength(3);
    feed.pause();
    resolvers[2](ok());
    await new Promise((r) => setTimeout(r, 0));
    expect(t.list.filter((x) => !x.done && x.ms === 60_000)).toHaveLength(0);
  });

  it("after a control: re-read now and once more 8 s later; pause cancels the follow-up", async () => {
    const t = timers();
    const resolvers: ((v: HomeOverviewView) => void)[] = [];
    const feed = new HomeFeed({ fetchOverview: () => new Promise((r) => resolvers.push(r)), onUpdate: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer });
    feed.resume();
    resolvers[0](ok());
    await new Promise((r) => setTimeout(r, 0));
    feed.afterControl();
    expect(resolvers).toHaveLength(2);
    resolvers[1](ok());
    await new Promise((r) => setTimeout(r, 0));
    t.fire(8_000);
    expect(resolvers).toHaveLength(3);
    resolvers[2](ok());
    await new Promise((r) => setTimeout(r, 0));
    feed.afterControl();
    feed.pause();
    t.fire(8_000);
    expect(resolvers).toHaveLength(4);
  });

  it("refreshing only while a re-read is in flight and the numbers on screen are over 2 minutes old", async () => {
    const t = timers();
    let now = NOW_MS;
    const resolvers: ((v: HomeOverviewView) => void)[] = [];
    const feed = new HomeFeed({ fetchOverview: () => new Promise((r) => resolvers.push(r)), onUpdate: () => {}, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => now });
    feed.resume();
    expect(feed.refreshing).toBe(false);
    resolvers[0](ok());
    await new Promise((r) => setTimeout(r, 0));
    now += 60_000;
    void feed.load();
    expect(feed.refreshing).toBe(false);
    resolvers[1](ok());
    await new Promise((r) => setTimeout(r, 0));
    now += 3 * 60_000;
    void feed.load();
    expect(feed.refreshing).toBe(true);
    expect(feed.model("zh-TW")).toMatchObject({ refreshing: true, refreshNote: "更新中…", temp: "26.5°" });
    resolvers[2](ok());
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.model("zh-TW").refreshing).toBe(false);
  });

  it("a stuck or failed core request ends as 「讀不到中控」 and drops the old numbers", async () => {
    const t = timers();
    let first = true;
    const feed = new HomeFeed({
      fetchOverview: () => (first ? ((first = false), Promise.resolve(ok())) : new Promise<HomeOverviewView>(() => {})),
      onUpdate: () => {},
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    feed.resume();
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.model("zh-TW").temp).toBe("26.5°");
    t.fire(60_000);
    t.fire(15_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(feed.model("zh-TW")).toMatchObject({ kind: "note", note: "讀不到中控", temp: null });
  });
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-home-corner-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("home-corner.json", () => {
  it("defaults mirror the clock: Mac window off, Pi terminal on; enabled follows the page source", () => {
    const store = new HomeCornerSettingsStore({ dir: root, onChange: () => {} });
    expect(DEFAULT_HOME_CORNER_PREFS).toEqual({ main: false, terminal: true });
    expect(store.view("main")).toEqual({ enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/home-corner" });
    expect(store.view("pi").enabled).toBe(true);
  });

  it("validates patches, saves only changed keys and survives a restart", () => {
    for (const bad of [{ main: "on" }, { terminal: 1 }, { home: true }, [], null]) expect(() => parseHomeCornerPatch(bad)).toThrow(HomeCornerPatchError);
    let changes = 0;
    const store = new HomeCornerSettingsStore({ dir: root, onChange: () => changes++ });
    expect(store.update({ terminal: false })).toEqual({ main: false, terminal: false });
    expect(changes).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "home-corner.json"), "utf8"))).toEqual({ schema_version: 1, prefs: { terminal: false } });
    expect(new HomeCornerSettingsStore({ dir: root, onChange: () => {} }).view("pi").enabled).toBe(false);
  });
});

const settingsView = (over: Partial<HomeCornerSettingsView["prefs"]> = {}): HomeCornerSettingsView => ({ enabled: false, prefs: { ...DEFAULT_HOME_CORNER_PREFS, ...over }, write_path: "/api/settings/home-corner" });

describe("menu bar section", () => {
  it("uses the same text as the page", () => {
    expect(MENU_TEXT).toEqual(HOME_CORNER_TEXT);
  });

  it("two checkboxes that send the opposite value; English labels; only when the core sends settings.home_corner", () => {
    const patches: unknown[] = [];
    const items = homeCornerMenu(settingsView(), { setHomeCorner: (p) => patches.push(p) });
    expect(items.map((i) => i.label ?? i.type)).toEqual(["separator", "左上角家中狀態", "Mac 視窗", "Pi 終端機"]);
    expect(items[2]).toMatchObject({ type: "checkbox", checked: false });
    expect(items[3]).toMatchObject({ type: "checkbox", checked: true });
    (items[2].click as () => void)();
    (items[3].click as () => void)();
    expect(patches).toEqual([{ main: true }, { terminal: false }]);
    const en = homeCornerMenu(settingsView(), { translate: (s: string, ...v: unknown[]) => translate(s, "en", ...v) });
    expect(en.slice(1).map((i) => i.label)).toEqual(["Home status corner", "Mac window", "Pi terminal"]);
    const base = { seconds: [] } as unknown as SettingsView;
    const labels = (s: SettingsView) => settingsMenu(s, { command: () => {}, setMenuPref: () => {} }).map((i) => i.label);
    expect(labels(base)).not.toContain("左上角家中狀態");
    expect(labels({ ...base, home_corner: settingsView() })).toContain("左上角家中狀態");
  });
});

describe("CLK-1 date size", () => {
  it("the date is larger than before but smaller than the time at every viewport height", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const rule = (selector: string, from = 0) => {
      const i = css.indexOf(`\n${selector} {`, from);
      expect(i, selector).toBeGreaterThan(-1);
      return css.slice(i, css.indexOf("}", i));
    };
    const clampOf = (block: string) => {
      const m = block.match(/font-size: clamp\(([\d.]+)rem, ([\d.]+)vh, ([\d.]+)rem\)/);
      expect(m, block).not.toBeNull();
      return { min: Number(m![1]) * 16, vh: Number(m![2]), max: Number(m![3]) * 16 };
    };
    const time = clampOf(rule(".clock-time"));
    const date = clampOf(rule(".clock-date"));
    const px = (c: typeof time, h: number) => Math.min(c.max, Math.max(c.min, (c.vh * h) / 100));
    for (let h = 300; h <= 3000; h += 10) expect(px(date, h), `${h}px tall`).toBeLessThan(px(time, h));
    expect(px(date, 1080)).toBeGreaterThan(Math.min(1.15 * 16, Math.max(0.85 * 16, 1.6 * 10.8)));
    const small = css.slice(css.indexOf("@media (max-width: 900px), (max-height: 600px) {\n  .clock-corner"));
    const remOf = (selector: string) => Number(small.slice(small.indexOf(`  ${selector} {`)).match(/font-size: ([\d.]+)rem/)![1]);
    expect(remOf(".clock-date")).toBeLessThan(remOf(".clock-time"));
  });
});

describe("HOME-1 CSS", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** 每條規則的選擇器與內容（@media 的內層規則也算；不處理巢狀以外的寫法）。 */
  const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].trim().split(/,\s*/), body: m[2] }));
  const smallStart = css.indexOf("@media (max-width: 900px), (max-height: 600px) {\n  .home-corner");
  const small = css.slice(smallStart, css.indexOf("\n}\n", smallStart));

  it("small screens drop rooms, device names and other sensors, never a reading's age, the qualifier or 「更新中…」", () => {
    expect(smallStart).toBeGreaterThan(-1);
    const hiddenSmall = rules(small).filter((r) => /display:\s*none/.test(r.body)).flatMap((r) => r.selectors);
    expect(hiddenSmall).toEqual(expect.arrayContaining([".home-climate-room", ".home-climate-other", ".home-line-detail"]));
    const kept = [".home-climate-detail", ".home-climate-meta", ".home-line-qualifier", ".home-refresh"];
    const hiddenAnywhere = rules(css).filter((r) => /display:\s*none|visibility:\s*hidden/.test(r.body)).flatMap((r) => r.selectors);
    for (const cls of kept) expect(hiddenAnywhere.filter((sel) => sel.split(/\s+/).at(-1)!.startsWith(cls)), cls).toEqual([]);
  });

  it("an open Surface hides the corner (it sits above .surface-root) instead of only dimming it", () => {
    const zOf = (selector: string) => Number(rules(css).find((r) => r.selectors.includes(selector) && /z-index/.test(r.body))!.body.match(/z-index:\s*(\d+)/)![1]);
    expect(zOf(".home-corner")).toBeGreaterThan(zOf(".surface-root"));
    const hide = rules(css).find((r) => r.selectors.includes("body.has-surface .home-corner"))!;
    expect(hide.selectors).toEqual(["body.has-surface .home-corner"]);
    expect(hide.body).toMatch(/opacity:\s*0;/);
    expect(hide.body).toMatch(/visibility:\s*hidden;/);
  });
});

// ───────── 角落的 DOM（最小的假 document：只實作 HomeCorner 用到的部分） ─────────

class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  className = "";
  hidden = false;
  innerHTML = "";
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  private text = "";
  readonly classList = {
    add: (c: string) => (this.className = [...new Set([...this.className.split(" ").filter(Boolean), c])].join(" ")),
    remove: (c: string) => (this.className = this.className.split(" ").filter((x) => x && x !== c).join(" ")),
    toggle: (c: string, on: boolean) => (on ? this.classList.add(c) : this.classList.remove(c)),
  };
  id = "";
  constructor(readonly tag: string) {}
  append(...nodes: FakeEl[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: FakeEl[]) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  get textContent(): string {
    return this.text + this.children.filter((c) => !c.hidden).map((c) => c.textContent).join("|");
  }
  set textContent(v: string) {
    this.text = v;
  }
  getBoundingClientRect() {
    return { right: 240, bottom: 200, left: 4, top: 4 };
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}

describe("HomeCorner on the page", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, window: g.window };
  afterEach(() => {
    g.document = saved.document;
    g.window = saved.window;
  });

  async function setup(fetchOverview: () => Promise<HomeOverviewView>) {
    const body = new FakeEl("body");
    const style = new Map<string, string>();
    const listeners = new Map<string, () => void>();
    const doc = {
      body,
      visibilityState: "visible",
      documentElement: { style: { getPropertyValue: (k: string) => style.get(k) ?? "", setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) } },
      createElement: (tag: string) => new FakeEl(tag),
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: () => {},
    };
    g.document = doc;
    g.window = { addEventListener: () => {}, removeEventListener: () => {} };
    const { HomeCorner } = await import("../src/home-corner.ts");
    const corner = new HomeCorner({ fetchOverview, locale: () => "zh-TW" });
    const setVisibility = (state: "visible" | "hidden") => {
      doc.visibilityState = state;
      listeners.get("visibilitychange")?.();
    };
    return { corner, body, style, setVisibility };
  }
  const byClass = (root: FakeEl, cls: string) => root.all().filter((e) => e.className.split(" ").includes(cls));

  it("mounts only when the setting is on, with the visibility reason, no buttons, and unmounts when off", async () => {
    const { corner, body, style } = await setup(async () => ok());
    expect(body.children).toHaveLength(0);
    corner.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    const root = body.children[0];
    expect(root.dataset.visibilityReason).toBe("user_setting:home_corner");
    expect(root.hidden).toBe(false);
    expect(root.dataset.state).toBe("data");
    expect(root.all().some((e) => e.tag === "button" || e.tag === "a" || e.tag === "input")).toBe(false);
    expect(root.textContent).toContain("26.5°");
    expect(root.textContent).toContain("燈 2／6 開著 · 3 個未知");
    expect(root.getAttribute("aria-label")).toMatch(/^家中狀態：/);
    expect(body.className).toContain("has-home-corner");
    expect(style.get("--home-reserve")).toBe("256px");
    corner.setEnabled(false);
    expect(body.children).toHaveLength(0);
    expect(body.className).not.toContain("has-home-corner");
    expect(style.has("--home-reserve")).toBe(false);
  });

  it("stale data keeps its age and the oldest-reading qualifier in their own elements (not the ones small screens drop)", async () => {
    const stale = overviewFromSnapshot(snapshot({ ...HOME, devices: HOME.devices.filter((d) => d.id !== "th-live") }), NOW_MS, 0);
    const { corner, body } = await setup(async () => stale);
    corner.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    const root = body.children[0];
    expect(byClass(root, "home-temp")[0].textContent).toBe("30.1°");
    expect(byClass(root, "home-climate-room")[0].textContent).toBe("書房");
    expect(byClass(root, "home-climate-meta")[0]).toMatchObject({ hidden: false, textContent: "CO₂ 812 ppm · 3 小時前" });
    expect(byClass(root, "home-line-qualifier").map((e) => e.textContent)).toEqual(["最舊的讀值 10 分鐘前"]);
    expect(byClass(root, "home-line-detail").map((e) => e.textContent)).toEqual(["客廳主燈、餐桌燈", "延長線"]);
  });

  it("back from hidden with numbers over 2 minutes old: dimmed and 「更新中…」 until the new read lands", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW_MS);
      let release: (v: HomeOverviewView) => void = () => {};
      let first = true;
      const { corner, body, setVisibility } = await setup(() => (first ? ((first = false), Promise.resolve(ok())) : new Promise((r) => (release = r))));
      corner.setEnabled(true);
      await new Promise((r) => setTimeout(r, 0));
      const root = body.children[0];
      setVisibility("hidden");
      vi.setSystemTime(NOW_MS + 10 * 60_000);
      setVisibility("visible");
      expect(root.className).toContain("home-corner--refreshing");
      expect(byClass(root, "home-refresh")[0]).toMatchObject({ hidden: false, textContent: "更新中…" });
      expect(root.getAttribute("aria-label")).toMatch(/^家中狀態：更新中…/);
      release(ok());
      await new Promise((r) => setTimeout(r, 0));
      expect(root.className).not.toContain("home-corner--refreshing");
      expect(byClass(root, "home-refresh")[0].hidden).toBe(true);
      corner.setEnabled(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [{ configured: false } as HomeOverviewView, "智慧家庭未設定"],
    [{ configured: true, state: "unreachable", error: "unreachable", server_now: 0 } as HomeOverviewView, "讀不到中控|連不上中控"],
  ])("note state %#: a single muted line, no numbers", async (view, text) => {
    const { corner, body } = await setup(async () => view);
    corner.setEnabled(true);
    await new Promise((r) => setTimeout(r, 0));
    const root = body.children[0];
    expect(root.dataset.state).toBe("note");
    expect(root.textContent).toBe(text);
  });
});

// ───────── HTTP：GET /api/home/overview 與 settings.home_corner（假中控 HTTP 伺服器） ─────────

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

describe("HTTP", () => {
  let core: NousHandle | null = null;
  let hub: Server | null = null;
  afterEach(async () => {
    await core?.close();
    core = null;
    await new Promise((r) => (hub ? hub.close(r) : r(null)));
    hub = null;
  });

  async function boot(smarthome: string) {
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const config = join(root, "config");
    mkdirSync(config, { recursive: true });
    const logs: string[] = [];
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: config, NOUS_PROVIDER: "mock", PORT: String(await freePort()), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", SMARTHOME_URL: smarthome, SMARTHOME_TOKEN: smarthome ? "hub-token" : "" },
      log: (l: string) => logs.push(l),
    });
    return { url: core.url, logs };
  }

  it("not configured: {configured:false}; settings.home_corner per page; toggles saved; other methods are not routes", async () => {
    const { url } = await boot("");
    expect(await (await fetch(`${url}/api/home/overview`)).json()).toEqual({ configured: false });
    const settings = async (terminal?: string) => (await (await fetch(`${url}/api/settings`, { headers: terminal ? { "x-nous-terminal": terminal } : {} })).json()) as SettingsView;
    expect((await settings()).home_corner).toEqual({ enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/home-corner" });
    expect((await settings("pi")).home_corner?.enabled).toBe(true);
    const post = (body: unknown) => fetch(`${url}/api/settings/home-corner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const saved = (await (await post({ main: true })).json()) as SettingsView;
    expect(saved.home_corner).toMatchObject({ enabled: true, prefs: { main: true, terminal: true } });
    expect((await post({ main: "yes" })).status).toBe(400);
    expect((await fetch(`${url}/api/home/overview`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  });

  it("with a fake hub: the sanitized overview, the token stays in the core, and nothing is logged with device names", async () => {
    const seen: { method: string; url: string; auth: string | undefined }[] = [];
    hub = createHttpServer((req: IncomingMessage, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      const body = req.url === "/api/v1/home" ? HOME : req.url === "/api/v1/integrations/aifa" ? AIFA : { status: null };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => hub!.listen(0, "127.0.0.1", r));
    const { url, logs } = await boot(`http://127.0.0.1:${(hub.address() as AddressInfo).port}`);
    const res = await fetch(`${url}/api/home/overview`, { headers: { "x-nous-terminal": "pi" } });
    const text = await res.text();
    const view = JSON.parse(text) as Extract<HomeOverviewView, { state: "ok" }>;
    expect(view).toMatchObject({ configured: true, state: "ok" });
    expect(view.switches[0]).toMatchObject({ group: "light", on: 2, on_names: ["客廳主燈", "餐桌燈"] });
    expect(text).not.toContain("hub-token");
    expect(text).not.toContain("127.0.0.1");
    await fetch(`${url}/api/home/overview`);
    expect(seen.filter((r) => r.url === "/api/v1/home")).toHaveLength(1);
    expect(seen.every((r) => r.auth === "Bearer hub-token")).toBe(true);
    expect(logs.join("\n")).not.toMatch(/客廳主燈|延長線|主臥冷氣/);
  });
});
