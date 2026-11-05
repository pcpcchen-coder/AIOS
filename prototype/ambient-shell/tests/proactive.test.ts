// PRO-1（George 2026-11-05）：主動提醒（招呼後接今天的天氣）。假時鐘、假 Open-Meteo 回應（fixture，不連網）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProactiveBriefing, ProactiveDailyLog, ProactiveSettingsStore } from "../server/proactive.ts";
import { forecastUrl, parseForecast, WeatherService, WEATHER_TTL_MS } from "../server/weather.ts";
import { WeatherAdapter, WEATHER_TOOL } from "../server/integrations/adapters/weather.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { GreetingPicker } from "../server/greeting-picker.ts";
import { liveGreetingSource } from "../server/nous.ts";
import {
  appendBriefing,
  briefingKeys,
  DEFAULT_PROACTIVE_PREFS,
  parseProactivePatch,
  PROACTIVE_TEXT,
  ProactivePatchError,
  weatherPlace,
  weatherSentence,
  WEATHER_PLACES,
  type WeatherToday,
} from "../shared/proactive.ts";
import { strictGreetingInstructions } from "../shared/sense.ts";
import { PROACTIVE_TEXT as MENU_TEXT, proactiveMenu, settingsMenu } from "../desktop/settings-menu.mjs";
import { translate } from "../shared/i18n.mjs";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-proactive-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 2026-11-05 07:30 台北（UTC+8）。 */
const MORNING = Date.parse("2026-11-04T23:30:00Z");
const TZ = "Asia/Taipei";
const HOUR = 3_600_000;

/** 假的 Open-Meteo 回覆（fixture；欄位形狀照官方文件 /v1/forecast）。 */
function fixtureBody(date = "2026-11-05", opts: { code?: number; min?: number; max?: number; rain?: (h: number) => number } = {}) {
  const hours = Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, "0")}:00`);
  return {
    daily: { time: [date], weather_code: [opts.code ?? 2], temperature_2m_max: [opts.max ?? 27.6], temperature_2m_min: [opts.min ?? 21.8] },
    hourly: { time: hours, precipitation_probability: hours.map((_, h) => (opts.rain ? opts.rain(h) : h >= 13 && h <= 16 ? 60 : 10)) },
  };
}

function fakeFetch(body: () => unknown | Error) {
  const urls: string[] = [];
  const f = (async (url: string | URL) => {
    urls.push(String(url));
    const b = body();
    if (b instanceof Error) throw b;
    return new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, urls };
}

const sample = (over: Partial<WeatherToday> = {}): WeatherToday => ({ place: "taipei", date: "2026-11-05", code: 2, min_c: 21.8, max_c: 27.6, rain: { part: "afternoon", percent: 60 }, fetched_at: MORNING, ...over });

describe("weather sentence (deterministic template)", () => {
  it("George's example: city, condition, low–high, afternoon rain and umbrella", () => {
    expect(weatherSentence(sample(), "zh-TW")).toBe("今天台北多雲，22 到 28 度，下午降雨機率 60%，記得帶傘");
    expect(weatherSentence(sample(), "en")).toBe("Today in Taipei: partly cloudy, 22 to 28°C, 60% chance of rain this afternoon; take an umbrella.");
  });

  it("rain under 30% is not mentioned; 30–49% is mentioned without the umbrella; unknown WMO code drops the condition", () => {
    expect(weatherSentence(sample({ rain: { part: "morning", percent: 20 } }), "zh-TW")).toBe("今天台北多雲，22 到 28 度");
    expect(weatherSentence(sample({ rain: { part: "evening", percent: 40 } }), "zh-TW")).toBe("今天台北多雲，22 到 28 度，晚上降雨機率 40%");
    expect(weatherSentence(sample({ code: 1234, rain: null }), "zh-TW")).toBe("今天台北，22 到 28 度");
    expect(weatherSentence(sample({ code: 1234, rain: null }), "en")).toBe("Today in Taipei: 22 to 28°C.");
  });

  it("appendBriefing joins the greeting and the briefing with locale punctuation, and keeps the greeting alone when there is none", () => {
    expect(appendBriefing("早安，George", "今天台北多雲，22 到 28 度", "zh-TW")).toBe("早安，George。今天台北多雲，22 到 28 度");
    expect(appendBriefing("Good morning, George", "Today in Taipei: clear, 20 to 25°C.", "en")).toBe("Good morning, George. Today in Taipei: clear, 20 to 25°C.");
    expect(appendBriefing("我在", null, "zh-TW")).toBe("我在");
  });

  it("the API key instructions with the longest briefing stay under the page's 1,000-character limit", () => {
    const longest = sample({ code: 95, rain: { part: "afternoon", percent: 100 }, place: "new_taipei", min_c: -10, max_c: 35 });
    for (const locale of ["zh-TW", "en"] as const) {
      const text = strictGreetingInstructions(appendBriefing(locale === "en" ? "Good afternoon, Christopher" : "午安，Christopher", weatherSentence(longest, locale), locale), locale);
      expect(text.length).toBeLessThanOrEqual(1_000);
    }
  });
});

describe("Open-Meteo client (fake responses; no network)", () => {
  it("the URL is the fixed host with only the listed place's coordinates and time zone", () => {
    const url = new URL(forecastUrl(weatherPlace("kaohsiung")!));
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.pathname).toBe("/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "22.63", longitude: "120.30", daily: "weather_code,temperature_2m_max,temperature_2m_min", hourly: "precipitation_probability", timezone: "Asia/Taipei", forecast_days: "1",
    });
  });

  it("parses today's daily values and the part of the day with the highest hourly rain chance", () => {
    expect(parseForecast(fixtureBody(), "taipei", "2026-11-05", 1)).toEqual({ place: "taipei", date: "2026-11-05", code: 2, min_c: 21.8, max_c: 27.6, rain: { part: "afternoon", percent: 60 }, fetched_at: 1 });
    expect(parseForecast(fixtureBody("2026-11-05", { rain: (h) => (h === 7 ? 80 : 5) }), "taipei", "2026-11-05", 1)?.rain).toEqual({ part: "morning", percent: 80 });
  });

  it("refuses data that is not today's, missing or impossible temperatures, and non-objects", () => {
    expect(parseForecast(fixtureBody("2026-11-04"), "taipei", "2026-11-05", 1)).toBeNull();
    expect(parseForecast({ daily: { time: ["2026-11-05"], temperature_2m_max: [20] } }, "taipei", "2026-11-05", 1)).toBeNull();
    expect(parseForecast(fixtureBody("2026-11-05", { min: 30, max: 20 }), "taipei", "2026-11-05", 1)).toBeNull();
    expect(parseForecast("nope", "taipei", "2026-11-05", 1)).toBeNull();
    // 沒有逐時資料：只是不念降雨。
    const body = fixtureBody();
    delete (body as { hourly?: unknown }).hourly;
    expect(parseForecast(body, "taipei", "2026-11-05", 1)?.rain).toBeNull();
  });

  it("caches for 30 minutes, dedupes concurrent refreshes, and refetches after the TTL", async () => {
    const clock = { now: MORNING };
    const f = fakeFetch(() => fixtureBody());
    const svc = new WeatherService({ fetch: f.fetch, now: () => clock.now });
    expect(svc.current("taipei")).toBeNull();
    const [a, b] = await Promise.all([svc.refresh("taipei"), svc.refresh("taipei")]);
    expect(a).toEqual(b);
    expect(f.urls).toHaveLength(1);
    clock.now += WEATHER_TTL_MS - 1;
    await svc.refresh("taipei");
    expect(f.urls).toHaveLength(1);
    clock.now += 2;
    await svc.refresh("taipei");
    expect(f.urls).toHaveLength(2);
    expect(svc.status("taipei")).toEqual({ state: "ok", at: clock.now });
  });

  it("a failed lookup returns null and records failed (no fake data); stale or other-place data is not used", async () => {
    const clock = { now: MORNING };
    let fail = false;
    const svc = new WeatherService({ fetch: fakeFetch(() => (fail ? new Error("offline") : fixtureBody())).fetch, now: () => clock.now });
    await svc.refresh("taipei");
    expect(svc.current("taipei")).not.toBeNull();
    expect(svc.current("tainan")).toBeNull();
    clock.now += 2 * HOUR + 1;
    expect(svc.current("taipei")).toBeNull();
    fail = true;
    expect(await svc.refresh("taipei")).toBeNull();
    expect(svc.status("taipei").state).toBe("failed");
  });
});

describe("settings (proactive.json)", () => {
  it("defaults: on, weather on, 5–11, place from the system time zone", () => {
    const store = new ProactiveSettingsStore({ dir: root, onChange: () => {} });
    expect(store.view()).toEqual(DEFAULT_PROACTIVE_PREFS);
    expect(DEFAULT_PROACTIVE_PREFS).toEqual({ enabled: true, weather: true, start_hour: 5, end_hour: 11, place: null });
  });

  it("validates keys, hours from the fixed options, listed places, and start before end", () => {
    expect(parseProactivePatch({ enabled: false, place: "taichung", start_hour: 6, end_hour: 10 })).toEqual({ enabled: false, place: "taichung", start_hour: 6, end_hour: 10 });
    expect(parseProactivePatch({ place: null })).toEqual({ place: null });
    for (const bad of [{ enabled: "yes" }, { start_hour: 3 }, { end_hour: 15 }, { place: "https://evil.example" }, { url: "x" }, [], null]) {
      expect(() => parseProactivePatch(bad)).toThrow(ProactivePatchError);
    }
    let changes = 0;
    const store = new ProactiveSettingsStore({ dir: root, onChange: () => changes++ });
    expect(() => store.update({ start_hour: 9, end_hour: 9 })).toThrow("時段的開始要早於結束");
    expect(changes).toBe(0);
    expect(store.update({ place: "hualien", end_hour: 12 })).toMatchObject({ place: "hualien", end_hour: 12 });
    expect(changes).toBe(1);
    expect(new ProactiveSettingsStore({ dir: root, onChange: () => {} }).view().place).toBe("hualien");
  });
});

interface Rig {
  briefing: ProactiveBriefing;
  settings: ProactiveSettingsStore;
  weather: WeatherService;
  clock: { now: number };
  fetched: string[];
  fail: { on: boolean };
  log: string[];
}

async function rig(options: { timeZone?: string; prefetch?: boolean } = {}): Promise<Rig> {
  const clock = { now: MORNING };
  const fail = { on: false };
  const f = fakeFetch(() => (fail.on ? new Error("offline") : fixtureBody(new Date(clock.now + 8 * HOUR).toISOString().slice(0, 10))));
  const weather = new WeatherService({ fetch: f.fetch, now: () => clock.now });
  const settings = new ProactiveSettingsStore({ dir: root, onChange: () => {} });
  const log: string[] = [];
  const briefing = new ProactiveBriefing({ settings, weather, log: new ProactiveDailyLog({ dir: root }), now: () => clock.now, timeZone: options.timeZone ?? TZ, logLine: (l) => log.push(l) });
  if (options.prefetch !== false) await weather.refresh("taipei");
  return { briefing, settings, weather, clock, fetched: f.urls, fail, log };
}

const PERSON = "fam_0123456789abcdef01234567";
const OTHER = "fam_76543210fedcba9876543210";

describe("once per person per day, in the morning window", () => {
  it("recognised person: weather on the first greeting only after it is committed; the second greeting the same day is plain", async () => {
    const r = await rig();
    const first = r.briefing.compose(PERSON, "zh-TW");
    expect(first?.sentence).toBe("今天台北多雲，22 到 28 度，下午降雨機率 60%，記得帶傘");
    // 沒有送出（使用者先開口）：不算說過。
    expect(r.briefing.compose(PERSON, "zh-TW")).not.toBeNull();
    r.briefing.commit(first!);
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    // 另一位家人今天還沒聽過。
    expect(r.briefing.compose(OTHER, "en")?.sentence).toMatch(/^Today in Taipei/);
    // 這台裝置今天已說過：沒認出是誰的招呼不再說。
    expect(r.briefing.compose(null, "zh-TW")).toBeNull();
  });

  it("unrecognised: this device's first time today; a recognised person afterwards still gets theirs", async () => {
    const r = await rig();
    const b = r.briefing.compose(null, "zh-TW")!;
    r.briefing.commit(b);
    expect(r.briefing.compose(null, "zh-TW")).toBeNull();
    expect(r.briefing.compose(PERSON, "zh-TW")).not.toBeNull();
  });

  it("only within the window (5–11 local by default; configurable); a new day starts over", async () => {
    const r = await rig();
    r.clock.now = Date.parse("2026-11-04T20:59:00Z"); // 04:59 台北
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    r.clock.now = Date.parse("2026-11-05T03:00:00Z"); // 11:00 台北（結束不含）
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    r.settings.update({ end_hour: 12 });
    await r.weather.refresh("taipei");
    r.briefing.commit(r.briefing.compose(PERSON, "zh-TW")!);
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    r.clock.now = Date.parse("2026-11-05T23:30:00Z"); // 隔天 07:30
    await r.weather.refresh("taipei");
    expect(r.briefing.compose(PERSON, "zh-TW")?.sentence).toContain("今天台北");
  });

  it("master switch or weather switch off → greeting only (the rollback)", async () => {
    const r = await rig();
    r.settings.update({ enabled: false });
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    r.settings.update({ enabled: true, weather: false });
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
  });

  it("weather not in the cache: skip this time (not marked), kick a lookup, and say it on the next greeting", async () => {
    const r = await rig({ prefetch: false });
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    expect(r.log).toContain("主動提醒：天氣還沒取到，這次只打招呼");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.fetched).toHaveLength(1);
    expect(r.briefing.compose(PERSON, "zh-TW")).not.toBeNull();
  });

  it("lookup failure: never invents weather", async () => {
    const r = await rig({ prefetch: false });
    r.fail.on = true;
    await r.weather.refresh("taipei");
    expect(r.briefing.compose(PERSON, "zh-TW")).toBeNull();
    expect(r.briefing.view().weather.state).toBe("failed");
  });

  it("no place: a non-Taiwan system time zone infers nothing until one is chosen", async () => {
    const r = await rig({ timeZone: "Europe/Berlin" });
    r.clock.now = Date.parse("2026-11-05T07:30:00Z"); // 08:30 Berlin
    expect(r.briefing.place()).toBeNull();
    expect(r.briefing.view()).toMatchObject({ place: null, weather: { state: "no_place", at: null } });
    expect(r.briefing.compose(null, "en")).toBeNull();
    r.settings.update({ place: "taipei" });
    expect(r.briefing.place()).toEqual({ id: "taipei", auto: false });
  });

  it("prefetch only looks up inside (or 30 minutes before) the window", async () => {
    const r = await rig({ prefetch: false });
    r.clock.now = Date.parse("2026-11-05T06:00:00Z"); // 14:00 台北
    r.briefing.prefetch();
    expect(r.fetched).toHaveLength(0);
    r.clock.now = Date.parse("2026-11-04T20:40:00Z"); // 04:40 台北
    r.briefing.prefetch();
    expect(r.fetched).toHaveLength(1);
  });

  it("the daily log keeps only the date and who was briefed (no weather content), 0600", async () => {
    const r = await rig();
    r.briefing.commit(r.briefing.compose(PERSON, "zh-TW")!);
    const file = join(root, "proactive-log.json");
    const raw = readFileSync(file, "utf8");
    expect(JSON.parse(raw)).toEqual({ schema_version: 1, date: "2026-11-05", keys: [`person:${PERSON}`, "device"] });
    expect(raw).not.toMatch(/台北|度|rain|%/);
    if (process.platform !== "win32") expect((await import("node:fs")).statSync(file).mode & 0o777).toBe(0o600);
    // 重新啟動後讀回；看不懂的鍵丟掉。
    writeFileSync(file, JSON.stringify({ schema_version: 1, date: "2026-11-05", keys: [`person:${PERSON}`, "../../etc"] }));
    const again = new ProactiveDailyLog({ dir: root });
    expect([...again.done("2026-11-05")]).toEqual([`person:${PERSON}`]);
    expect(again.done("2026-11-06").size).toBe(0);
  });

  it("briefingKeys: the pure rule", () => {
    expect(briefingKeys(PERSON, new Set())).toEqual([`person:${PERSON}`, "device"]);
    expect(briefingKeys(PERSON, new Set(["device"]))).toEqual([`person:${PERSON}`, "device"]);
    expect(briefingKeys(null, new Set([`person:${PERSON}`]))).toEqual(["device"]);
    expect(briefingKeys(null, new Set(["device"]))).toBeNull();
  });
});

describe("live fallback greeting (no family decision: browser version or timed out)", () => {
  it("adds the weather once per device per day, only when the greeting is really sent (use=false drops it)", async () => {
    const r = await rig();
    const source = liveGreetingSource(() => null, new GreetingPicker({ random: () => 0, now: () => r.clock.now, timeZone: TZ }), r.briefing);
    const dropped = source("int_0000000000000001", "rt_1", "zh-TW", false);
    expect(dropped.sentence).not.toContain("今天台北");
    const sent = source("int_0000000000000002", "rt_2", "zh-TW");
    expect(sent.sentence).toMatch(/^[^。]+。今天台北多雲，22 到 28 度，下午降雨機率 60%，記得帶傘$/);
    expect(sent.text).toContain(`「${sent.sentence}」`);
    expect(source("int_0000000000000003", "rt_3", "zh-TW").sentence).not.toContain("今天台北");
  });
});

describe("AIL adapter app.weather.today (read-only, no arguments)", () => {
  it("registers only with the core's weather cache; no parameters reach the model", () => {
    const svc = new WeatherService({ fetch: fakeFetch(() => fixtureBody()).fetch, now: () => MORNING });
    const config = { enabled: true, services: ["weather"], soloistPort: 1 };
    expect(createIntegrations(config, () => {}, undefined, {})?.registry.functionSpecs("api_key")).toEqual([]);
    const ail = createIntegrations(config, () => {}, undefined, { weather: { service: svc, place: () => "taipei" } })!;
    expect(ail.registry.functionSpecs("live")).toEqual([
      expect.objectContaining({ name: "app__weather__today", parameters: { type: "object", properties: {}, additionalProperties: false } }),
    ]);
  });

  it("returns today's data with the source; refuses without a place; failed when Open-Meteo fails", async () => {
    let fail = false;
    let place: "taipei" | null = "taipei";
    const svc = new WeatherService({ fetch: fakeFetch(() => (fail ? new Error("down") : fixtureBody())).fetch, now: () => MORNING });
    const adapter = new WeatherAdapter({ service: svc, place: () => place });
    const ctx = { actor: "agent" as const, route: "live" as const, sessionId: "rt", requestId: "req", signal: new AbortController().signal };
    expect(await adapter.execute(WEATHER_TOOL, {}, ctx)).toMatchObject({
      ok: true, status: "confirmed", data: { place: "台北", date: "2026-11-05", condition: "多雲", low_c: 22, high_c: 28, rain: { part: "afternoon", percent: 60 }, source: "Open-Meteo.com（CC BY 4.0）" },
    });
    expect(await adapter.health()).toEqual({ health: "available", reason: "ok" });
    place = null;
    expect(await adapter.execute(WEATHER_TOOL, {}, ctx)).toMatchObject({ ok: false, status: "refused" });
    place = "taipei";
    fail = true;
    const failing = new WeatherAdapter({ service: new WeatherService({ fetch: fakeFetch(() => new Error("down")).fetch, now: () => MORNING }), place: () => place });
    expect(await failing.execute(WEATHER_TOOL, {}, ctx)).toMatchObject({ ok: false, status: "failed", reason: "unavailable" });
  });
});

describe("menu bar and translations", () => {
  it("the menu text table matches the shared one", () => {
    expect(MENU_TEXT).toEqual(PROACTIVE_TEXT);
  });

  it("every new string has an English translation (no CJK left in the English menu)", async () => {
    const r = await rig();
    const view = r.briefing.view();
    for (const source of [...Object.values(PROACTIVE_TEXT), ...WEATHER_PLACES.map((p) => p.zh)]) {
      expect(translate(source, "en")).not.toBe(source);
    }
    const en = (s: string, ...v: unknown[]) => translate(s, "en", ...v);
    const items = proactiveMenu(view, { setProactive: () => {}, translate: en });
    expect(JSON.stringify(items)).not.toMatch(/[一-鿿]/);
  });

  it("the section: master switch, weather switch, window, place, status; clicks POST the patch", async () => {
    const r = await rig();
    const patches: unknown[] = [];
    const items = proactiveMenu(r.briefing.view(), { setProactive: (p) => patches.push(p) });
    expect(items.map((i) => i.label)).toEqual([undefined, "主動提醒", "早上招呼後主動提醒", "說今天的天氣", "時段開始：5 點", "時段結束：11 點", "天氣地點：依系統時區（台北）", "天氣：已取得今天的資料"]);
    items[2]!.click!();
    items[6]!.submenu!.find((i) => i.label === "高雄")!.click!();
    // 結束 ≤ 開始的選項停用。
    expect(items[4]!.submenu!.filter((i) => i.enabled === false).map((i) => i.label)).toEqual([]);
    expect(items[5]!.submenu!.filter((i) => i.enabled === false).map((i) => i.label)).toEqual([]);
    expect(patches).toEqual([{ enabled: false }, { place: "kaohsiung" }]);
    const full = settingsMenu({ seconds: [], proactive: r.briefing.view() } as never, { command: () => {}, setMenuPref: () => {}, setProactive: () => {} });
    expect(full.some((i) => i.label === "主動提醒")).toBe(true);
  });

  it("existsSync guard: no daily log is written before anything is said", async () => {
    await rig();
    expect(existsSync(join(root, "proactive-log.json"))).toBe(false);
  });
});

// ─────────────── 招呼決策（server/identity-service.ts）：兩條路徑 ───────────────
import { GalleryStore } from "../server/identity-store.ts";
import { IdentityService } from "../server/identity-service.ts";
import type { FaceModelVersion, IdentityResponse } from "../shared/identity.ts";
import { fakeSecretBox, near, unitFeature } from "./fixtures/identity.ts";

const MODEL: FaceModelVersion = { detector: "yunet-2023mar@8f2383e4", recognizer: "sface-2021dec@0ba9fbfa", align: "opencv-aligncrop-5pt@048f050d", preproc: "yunet640-cvlinear-bgr-v1" };
const GEORGE = unitFeature(1);
const iid = (n: number) => `int_${n.toString(16).padStart(16, "0")}`;
const sid = (interaction: string) => `rt_${interaction.slice(4)}`;

async function identityRig() {
  const r = await rig();
  const claims = new Map<string, { route: "api_key" | "live"; session_id: string }>();
  const svc = new IdentityService({
    claimGreeting: (i) => {
      const c = claims.get(i) ?? null;
      claims.delete(i);
      return c;
    },
    store: new GalleryStore({ dir: join(root, "identity"), secretBox: fakeSecretBox() }),
    confirm: async () => true,
    camera: () => true,
    ambient: () => ({ look_to_talk: true, look_to_talk_greet: true, look_to_talk_greet_name: true }),
    runtime: { state: "ok", problems: [] },
    model: MODEL,
    picker: new GreetingPicker({ random: () => 0, now: () => r.clock.now, timeZone: TZ }),
    briefing: r.briefing,
    now: () => r.clock.now,
    log: () => {},
  });
  const opened = await svc.handle({ op: "open_session" }, { userInitiated: true });
  if (!opened.ok || !("session" in opened)) throw new Error(JSON.stringify(opened));
  const samples = Array.from({ length: 6 }, (_, i) => Array.from(near(GEORGE, i + 1)));
  const enrolled = await svc.handle({ op: "enroll", session: opened.session, name: "George", minor: false, guardian_confirmed: false, consent: true, model: MODEL, samples });
  if (!enrolled.ok || !("people" in enrolled)) throw new Error(JSON.stringify(enrolled));
  await svc.handle({ op: "close_session", session: opened.session });
  const see = async (track: number) => {
    r.clock.now += 30_000;
    for (let i = 0; i < 3; i++) {
      r.clock.now += 250;
      await svc.handle({ op: "ambient_probe", track, model: MODEL, face_count: 1, quality: "ok", feature: Array.from(near(GEORGE, (r.clock.now % 997) + 1, 0.03)) });
    }
  };
  const greet = async (n: number, track: number, route: "api_key" | "live", claim = true): Promise<string | null> => {
    if (!claim) r.clock.now += 30_000; // 問候決策每分鐘最多 3 次（認人的那幾次由 see 推進時鐘）
    if (claim) claims.set(iid(n), { route, session_id: sid(iid(n)) });
    const res: IdentityResponse = await svc.handle({ op: "greeting", interaction: iid(n), track, eligible: true, route });
    if (!res.ok || res.op !== "greeting") throw new Error(JSON.stringify(res));
    return res.text;
  };
  return { ...r, svc, see, greet };
}

const WEATHER_ZH = "今天台北多雲，22 到 28 度，下午降雨機率 60%，記得帶傘";

describe("greeting decision + briefing (both voice paths)", () => {
  it("API key: the first named morning greeting carries the weather inside the strict instructions; the next one is the greeting only", async () => {
    const c = await identityRig();
    await c.see(1);
    const first = await c.greet(1, 1, "api_key");
    expect(first).toMatch(new RegExp(`「[^」。]*George[^」。]*。${WEATHER_ZH}」`));
    expect(first).toContain("這一輪不是使用者的請求");
    await c.see(2);
    const second = await c.greet(2, 2, "api_key");
    expect(second).toMatch(/「[^」]*George[^」]*」/);
    expect(second).not.toContain("今天台北");
  });

  it("live: composed at the decision, committed only when the sideband really takes it; a dropped greeting (user spoke first) is not counted", async () => {
    const c = await identityRig();
    await c.see(1);
    expect(await c.greet(1, 1, "live")).toBeNull();
    // 使用者先開口：live-route 用 use=false 丟掉，不算說過。
    expect(c.svc.takeLiveGreeting(iid(1), sid(iid(1)), false)).not.toBeNull();
    await c.see(2);
    expect(await c.greet(2, 2, "live")).toBeNull();
    const taken = c.svc.takeLiveGreeting(iid(2), sid(iid(2)));
    expect(taken?.sentence).toMatch(new RegExp(`^[^。]*George[^。]*。${WEATHER_ZH}$`));
    expect(taken?.text).toContain(`「${taken?.sentence}」`);
    expect(taken?.named).toBe(true);
    // 改路徑（live → API key）時 GreetingOnce 整次只打一次招呼；就算再決策一次，今天也已經說過，不會重複天氣。
    await c.see(3);
    expect(await c.greet(3, 3, "api_key")).not.toContain("今天台北");
  });

  it("not recognised (stranger, no claim): only the device rule applies, and it is used once", async () => {
    const c = await identityRig();
    const plain = await c.greet(1, 9, "api_key", false);
    expect(plain).toContain(`。${WEATHER_ZH}」`);
    expect(plain).not.toContain("George");
    expect(await c.greet(2, 9, "api_key", false)).not.toContain("今天台北");
    // George 今天還沒聽過自己的：仍會說。
    await c.see(3);
    expect(await c.greet(3, 3, "api_key")).toMatch(new RegExp(`George[^」。]*。${WEATHER_ZH}」`));
  });
});

describe("review fixes", () => {
  it("status is per place and per day: another place or yesterday's data is not 'ok'; a failed refresh with usable cache stays 'ok' (the greeting still uses it)", async () => {
    const clock = { now: MORNING };
    let fail = false;
    const svc = new WeatherService({ fetch: fakeFetch(() => (fail ? new Error("x") : fixtureBody())).fetch, now: () => clock.now });
    await svc.refresh("taipei");
    expect(svc.status("taipei").state).toBe("ok");
    expect(svc.status("kaohsiung").state).toBe("none");
    clock.now += WEATHER_TTL_MS + 1;
    fail = true;
    await svc.refresh("taipei");
    expect(svc.current("taipei")).not.toBeNull();
    expect(svc.status("taipei").state).toBe("ok");
    clock.now = Date.parse("2026-11-05T21:00:00Z"); // 隔天 05:00 台北
    expect(svc.status("taipei").state).toBe("failed");
  });

  it("an aborted caller does not abort the shared lookup for other waiters", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = (async () => {
      await gate;
      return new Response(JSON.stringify(fixtureBody()), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new WeatherService({ fetch: f, now: () => MORNING });
    const ac = new AbortController();
    const tool = svc.refresh("taipei", ac.signal);
    const greeting = svc.refresh("taipei");
    ac.abort();
    expect(await tool).toBeNull();
    release();
    expect(await greeting).not.toBeNull();
    expect(svc.status("taipei").state).toBe("ok");
  });

  it("live: a greeting + weather that would not fit one 500-byte sideband append drops the weather and does not record it", async () => {
    const r = await rig();
    // 很長的英文招呼：用 GreetingPicker 不會出現，這裡直接用 plainLive 的保底以外的方式模擬：把地點換成最長的、天氣最長的情況。
    const long = "x".repeat(400);
    const picker = { plainLive: (_l?: unknown, extra: string | null = null) => ({ id: "p0", sentence: extra ? `${long}. ${extra}` : long, text: `（開場）${extra ? `${long}. ${extra}` : long}` }) } as unknown as GreetingPicker;
    const source = liveGreetingSource(() => null, picker, r.briefing);
    expect(source("int_0000000000000001", "rt_1", "en").sentence).toBe(long);
    expect(r.briefing.compose(null, "en")).not.toBeNull(); // 沒有記成說過
  });

  it("API key: recorded only when the call reports the greeting turn started (spoken), not at the decision", async () => {
    const c = await identityRig();
    // 替換通知：記下 spoken，晚一點才呼叫（模擬旁路看到 response.created）。
    const pending: (() => void)[] = [];
    (c.svc as unknown as { options: { apiKeyGreeted: unknown } }).options.apiKeyGreeted = (_s: string, _n: boolean, spoken?: () => void) => spoken && pending.push(spoken);
    await c.see(1);
    expect(await c.greet(1, 1, "api_key")).toContain(WEATHER_ZH);
    expect(pending).toHaveLength(1);
    // 頁面丟掉了問候（使用者先開口）：沒有 spoken，今天仍會說。
    await c.see(2);
    expect(await c.greet(2, 2, "api_key")).toContain(WEATHER_ZH);
    pending[1]!();
    await c.see(3);
    expect(await c.greet(3, 3, "api_key")).not.toContain("今天台北");
  });
});
