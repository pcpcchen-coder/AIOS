// CLK-1（George 2026-11-07）：右上角時鐘的天氣（GET /api/weather/now）與 Open-Meteo 的 current 區塊。
// 假時鐘、假 Open-Meteo 回應（fixture，不連網）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startNous, type NousHandle } from "../server/nous.ts";
import { parseCurrent, parseForecast, WeatherService, weatherNowView, WEATHER_FAILURE_COOLDOWN_MS, WEATHER_TTL_MS } from "../server/weather.ts";
import type { WeatherNowView } from "../shared/clock.ts";
import type { SettingsView } from "../shared/types.ts";

/** 2026-11-07 14:10 台北。 */
const NOW = Date.parse("2026-11-07T06:10:00Z");
const TODAY = "2026-11-07";
const MIN = 60_000;

/** 假的 Open-Meteo 回覆（欄位形狀照官方文件 /v1/forecast 的 current、daily、hourly）。 */
function fixtureBody(opts: { date?: string; current?: Record<string, unknown> | null } = {}) {
  const date = opts.date ?? TODAY;
  const hours = Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, "0")}:00`);
  return {
    ...(opts.current === null ? {} : { current: opts.current ?? { time: `${date}T14:00`, interval: 900, temperature_2m: 23.6, weather_code: 61, is_day: 1 } }),
    daily: { time: [date], weather_code: [63], temperature_2m_max: [26.4], temperature_2m_min: [18.2] },
    hourly: { time: hours, precipitation_probability: hours.map((_, h) => (h >= 13 && h <= 16 ? 70 : 10)) },
  };
}

function fakeFetch(body: () => unknown | Error) {
  const urls: string[] = [];
  const f = (async (url: string | URL) => {
    urls.push(String(url));
    const b = body();
    if (b instanceof Error) throw b;
    return new Response(JSON.stringify(b), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, urls };
}

describe("Open-Meteo current block", () => {
  it("parses the current temperature, code and day/night", () => {
    expect(parseCurrent(fixtureBody(), TODAY)).toEqual({ time: `${TODAY}T14:00`, temp_c: 23.6, code: 61, is_day: true });
    expect(parseForecast(fixtureBody(), "taipei", TODAY, 1)?.now).toEqual({ time: `${TODAY}T14:00`, temp_c: 23.6, code: 61, is_day: true });
    expect(parseCurrent(fixtureBody({ current: { time: `${TODAY}T22:00`, temperature_2m: 19, weather_code: 0, is_day: 0 } }), TODAY)?.is_day).toBe(false);
  });

  it("drops an invalid or other-day current block but keeps today's daily values", () => {
    for (const current of [
      { time: "2026-11-06T23:45", temperature_2m: 20, weather_code: 0, is_day: 0 },
      { time: `${TODAY}T14:00`, temperature_2m: 99, weather_code: 0, is_day: 1 },
      { time: `${TODAY}T14:00`, temperature_2m: "warm", weather_code: 0, is_day: 1 },
      { time: `${TODAY}T14:00`, temperature_2m: 20, weather_code: 0, is_day: "yes" },
      { temperature_2m: 20, weather_code: 0, is_day: 1 },
    ]) {
      expect(parseCurrent(fixtureBody({ current }), TODAY)).toBeNull();
      const parsed = parseForecast(fixtureBody({ current }), "taipei", TODAY, 1);
      expect(parsed?.now).toBeNull();
      expect(parsed?.min_c).toBe(18.2);
    }
    expect(parseForecast(fixtureBody({ current: null }), "taipei", TODAY, 1)?.now).toBeNull();
    // 不認得的代碼：氣溫照用，代碼 null（角落不畫圖示）。
    expect(parseCurrent(fixtureBody({ current: { time: `${TODAY}T14:00`, temperature_2m: 20, weather_code: 1.5, is_day: 1 } }), TODAY)?.code).toBeNull();
  });
});

describe("weatherNowView (shared cache with the greeting)", () => {
  const rig = (body: () => unknown | Error) => {
    const clock = { now: NOW };
    const f = fakeFetch(body);
    const service = new WeatherService({ fetch: f.fetch, now: () => clock.now });
    const read = (locale: "zh-TW" | "en" = "zh-TW", place: "taipei" | null = "taipei") => weatherNowView({ service, place, locale, now: () => clock.now, systemTimeZone: "Europe/London" });
    return { clock, urls: f.urls, read };
  };

  it("ok: current temperature and code, today's range and highest rain chance, the place's time zone and label per locale", async () => {
    const r = rig(() => fixtureBody());
    expect(await r.read()).toEqual({
      time_zone: "Asia/Taipei",
      server_now: NOW,
      place: { id: "taipei", label: "台北" },
      state: "ok",
      weather: { date: TODAY, code: 61, is_day: true, temp_c: 23.6, min_c: 18.2, max_c: 26.4, rain_percent: 70, fetched_at: NOW },
      attribution: "Open-Meteo.com（CC BY 4.0）",
    } satisfies WeatherNowView);
    expect((await r.read("en")).place).toEqual({ id: "taipei", label: "Taipei" });
    // 30 分鐘快取內不再查。
    r.clock.now += WEATHER_TTL_MS - 1;
    await r.read();
    expect(r.urls).toHaveLength(1);
  });

  it("missing current block: temp_c null with the daily code and the day icon", async () => {
    const r = rig(() => fixtureBody({ current: null }));
    expect((await r.read()).weather).toMatchObject({ code: 63, is_day: true, temp_c: null, min_c: 18.2, max_c: 26.4 });
  });

  it("failed refresh with a cache under 2 hours keeps serving it (the page shows its age); without one, weather is null and state failed", async () => {
    let fail = false;
    const r = rig(() => (fail ? new Error("offline") : fixtureBody()));
    await r.read();
    fail = true;
    r.clock.now += WEATHER_TTL_MS + 10 * MIN;
    const kept = await r.read();
    expect(kept.state).toBe("ok");
    expect(kept.weather?.fetched_at).toBe(NOW);
    expect(r.urls).toHaveLength(2);
    r.clock.now = NOW + 2 * 60 * MIN + 1;
    const gone = await r.read();
    expect(gone).toMatchObject({ state: "failed", weather: null, time_zone: "Asia/Taipei" });

    const never = rig(() => new Error("offline"));
    expect(await never.read()).toMatchObject({ state: "failed", weather: null, place: { id: "taipei" } });
  });

  it("no place: no lookup, the core's system time zone, state no_place", async () => {
    const r = rig(() => fixtureBody());
    expect(await r.read("zh-TW", null)).toEqual({ time_zone: "Europe/London", server_now: NOW, place: null, state: "no_place", weather: null, attribution: "Open-Meteo.com（CC BY 4.0）" });
    expect(r.urls).toEqual([]);
  });
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let root: string;
let core: NousHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-clock-http-"));
});
afterEach(async () => {
  await core?.close();
  core = null;
  rmSync(root, { recursive: true, force: true });
});

async function boot(fetched: string[]): Promise<NousHandle> {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "proactive.json"), JSON.stringify({ schema_version: 1, prefs: { place: "taipei" } }));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  core = await startNous({
    envFile: null,
    dataDir: join(root, "data"),
    distDir: dist,
    fallbackPort: true,
    overrides: { NOUS_CONFIG_DIR: config, NOUS_PROVIDER: "mock", PORT: String(await freePort()), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", SMARTHOME_URL: "", SMARTHOME_TOKEN: "" },
    log: () => {},
    weatherFetch: (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(JSON.stringify(fixtureBody({ date: today, current: { time: `${today}T14:00`, temperature_2m: 21.4, weather_code: 2, is_day: 1 } })), { status: 200 });
    }) as typeof fetch,
  });
  return core;
}

describe("GET /api/weather/now and settings.clock over HTTP", () => {
  it("read-only weather for the corner, label per X-Nous-Locale, one Open-Meteo request within the TTL; other methods are not routes", async () => {
    const fetched: string[] = [];
    const h = await boot(fetched);
    const zh = (await (await fetch(`${h.url}/api/weather/now`, { headers: { "x-nous-terminal": "pi" } })).json()) as WeatherNowView;
    expect(zh).toMatchObject({ time_zone: "Asia/Taipei", place: { id: "taipei", label: "台北" }, state: "ok", weather: { code: 2, temp_c: 21.4, min_c: 18.2, max_c: 26.4, rain_percent: 70 } });
    expect(Math.abs(zh.server_now - Date.now())).toBeLessThan(5_000);
    const en = (await (await fetch(`${h.url}/api/weather/now`, { headers: { "x-nous-locale": "en" } })).json()) as WeatherNowView;
    expect(en.place?.label).toBe("Taipei");
    expect(fetched).toHaveLength(1);
    expect(new URL(fetched[0]).origin).toBe("https://api.open-meteo.com");
    // 查詢參數不能指定地點或網址。
    await fetch(`${h.url}/api/weather/now?latitude=0&longitude=0&url=https://evil.example/`);
    expect(fetched).toHaveLength(1);
    const post = await fetch(`${h.url}/api/weather/now`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.ok).toBe(false);
  });

  it("settings.clock: Mac window off and terminal on by default; POST saves valid patches, refuses bad ones with 400", async () => {
    const h = await boot([]);
    const main = (await (await fetch(`${h.url}/api/settings`)).json()) as SettingsView;
    expect(main.clock).toEqual({ enabled: false, prefs: { main: false, terminal: true }, write_path: "/api/settings/clock" });
    const pi = (await (await fetch(`${h.url}/api/settings`, { headers: { "x-nous-terminal": "pi" } })).json()) as SettingsView;
    expect(pi.clock?.enabled).toBe(true);

    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${h.url}/api/settings/clock`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const saved = await post({ main: true, terminal: false });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SettingsView).clock).toEqual({ enabled: true, prefs: { main: true, terminal: false }, write_path: "/api/settings/clock" });
    const piAfter = (await (await fetch(`${h.url}/api/settings`, { headers: { "x-nous-terminal": "pi" } })).json()) as SettingsView;
    expect(piAfter.clock?.enabled).toBe(false);
    for (const bad of [{ main: "yes" }, { weather: true }, [], null]) expect((await post(bad)).status).toBe(400);
    const en = await post({ terminal: 1 }, { "x-nous-locale": "en" });
    expect(((await en.json()) as { error: string }).error).toBe("terminal must be true or false");
  });
});

describe("failure cooldown", () => {
  it("does not ask Open-Meteo again for 2 minutes after a failure, then retries", async () => {
    const clock = { now: NOW };
    const f = fakeFetch(() => new Error("offline"));
    const service = new WeatherService({ fetch: f.fetch, now: () => clock.now });
    expect(await service.refresh("taipei")).toBeNull();
    for (let i = 0; i < 5; i++) await service.refresh("taipei");
    expect(f.urls).toHaveLength(1);
    clock.now += WEATHER_FAILURE_COOLDOWN_MS - 1;
    await service.refresh("taipei");
    expect(f.urls).toHaveLength(1);
    clock.now += 1;
    await service.refresh("taipei");
    expect(f.urls).toHaveLength(2);
    // 另一個地點不受影響。
    await service.refresh("tainan");
    expect(f.urls).toHaveLength(3);
  });
});
