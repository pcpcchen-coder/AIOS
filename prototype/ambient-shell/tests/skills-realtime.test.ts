import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Locale } from "../shared/i18n.mjs";
import type { CapabilityStatus, IntegrationRoute } from "../shared/integrations.ts";
import type { SettingsView } from "../shared/types.ts";
import type { AlarmCenter } from "../server/alarms.ts";
import { GoogleCalendarAdapter } from "../server/integrations/adapters/google-calendar.ts";
import { SKILL_CATALOG, SkillAdapter } from "../server/integrations/adapters/skill.ts";
import { TimerAdapter } from "../server/integrations/adapters/timer.ts";
import { WeatherAdapter } from "../server/integrations/adapters/weather.ts";
import { staticCatalog } from "../server/integrations/catalog.ts";
import type { IntegrationAdapter } from "../server/integrations/contracts.ts";
import { IntegrationDispatcher } from "../server/integrations/dispatcher.ts";
import { MAX_READ_DATA_BYTES, MAX_RESULT_DATA_BYTES } from "../server/integrations/policy.ts";
import { IntegrationRegistry, RegistryError } from "../server/integrations/registry.ts";
import { buildCallerInstructions, liveCallerTools } from "../server/live-tool-caller.ts";
import { startNous, type NousHandle } from "../server/nous.ts";
import { buildLiveInstructions, buildRealtimeInstructions, buildRealtimeTools, realtimeToolRules, type RealtimeCapabilities } from "../server/realtime.ts";
import type { Skill } from "../server/skills/format.ts";
import { loadSkills } from "../server/skills/load.ts";
import { SKILL_INDEX_LIMITS, SkillBook, skillLoadLog } from "../server/skills/runtime.ts";
import { SKILL_READ_TOOL, SKILL_READ_WIRE } from "../server/skills/tool-id.ts";
import type { WeatherService } from "../server/weather.ts";

// SKL-2（docs/24 §4.3）：技能接上兩條即時語音路徑。全部是 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收。
// 字數一律用 Unicode code point（[...text].length）計算，和 SKILL_LIMITS 相同。

const unused = new Proxy({}, { get: () => { throw new Error("不應該用到這個依賴"); } });
const len = (text: string) => [...text].length;
const NOW = new Date("2026-11-24T00:00:00.000Z");
const LOCALES: Locale[] = ["zh-TW", "en"];
const shipped = loadSkills();
const briefing = shipped.skills.find((s) => s.name === "morning-briefing")!;

/** 和 server/nous.ts 相同的組裝：內建的定時器＋（有開時）技能讀取，加上這次要的 Adapter。 */
function setup(options: { adapters?: IntegrationAdapter[]; skills?: readonly Skill[] | null; limits?: { count: number; chars: number } } = {}) {
  const logs: string[] = [];
  const registry = new IntegrationRegistry({ enabled: { has: (id) => id !== "skill" || !!book?.anyListed() } });
  const book = options.skills === null ? null : new SkillBook({ skills: options.skills ?? shipped.skills, status: (id, route) => registry.status(id, route), log: (l) => logs.push(l), ...(options.limits ? { limits: options.limits } : {}) });
  registry.register(new TimerAdapter(unused as AlarmCenter));
  if (book) registry.register(new SkillAdapter(book));
  for (const a of options.adapters ?? []) registry.register(a);
  const dispatcher = new IntegrationDispatcher(registry);
  const caps = (route: "api_key" | "live"): RealtimeCapabilities => ({ webSearch: true, mcp: [], home: false, integrations: (l) => registry.functionSpecs(route, l), ...(book ? { skills: (l, m) => book.indexLines(route, l, m) } : {}) });
  return { registry, book, dispatcher, caps, logs };
}
const weather = () => new WeatherAdapter({ service: unused as WeatherService, place: () => null });
const calendar = () => new GoogleCalendarAdapter({ account: "someone@example.com", gogPath: "/usr/local/bin/gog" });
const both = () => [weather(), calendar()];

/** 一條路徑的三份說明：API key 語音模型、ChatGPT 方案的工具執行層、ChatGPT 方案沒有工具的語音層。 */
function instructions(caps: RealtimeCapabilities, locale: Locale) {
  return {
    api_key: buildRealtimeInstructions([], NOW, caps, locale),
    caller: buildCallerInstructions(caps, [], NOW, locale),
    voice: buildLiveInstructions([], NOW, { mcp: [], ...(caps.integrations ? { integrations: caps.integrations } : {}), ...(caps.skills ? { skills: caps.skills } : {}) }, locale),
  };
}
const without = (caps: RealtimeCapabilities): RealtimeCapabilities => {
  const { skills: _skills, ...rest } = caps;
  return { ...rest, integrations: (l) => (caps.integrations?.(l) ?? []).filter((s) => s.name !== SKILL_READ_WIRE) };
};

describe("gate: NOUS_SKILLS off changes nothing", () => {
  it("without a skill book the instructions of all three layers equal a build with no skills at all (both routes, both locales)", () => {
    const off = setup({ skills: null, adapters: both() });
    for (const locale of LOCALES) {
      for (const route of ["api_key", "live"] as const) {
        const caps = off.caps(route);
        expect(caps.skills).toBeUndefined();
        const a = instructions(caps, locale);
        const b = instructions({ webSearch: true, mcp: [], home: false, integrations: caps.integrations! }, locale);
        expect(a).toEqual(b);
        expect(JSON.stringify(a)).not.toContain(SKILL_READ_WIRE);
        expect(off.registry.functionSpecs(route, locale).map((s) => s.name)).not.toContain(SKILL_READ_WIRE);
      }
    }
  });

  it("an empty index (flag on, nothing listable) adds no line to any instructions", () => {
    const { caps, registry } = setup({ adapters: [weather()] });
    for (const locale of LOCALES) for (const route of ["api_key", "live"] as const) {
      expect(instructions(caps(route), locale)).toEqual(instructions(without(caps(route)), locale));
      expect(registry.functionSpecs(route, locale).map((s) => s.name)).not.toContain(SKILL_READ_WIRE);
    }
  });

  it("the Dispatcher refuses app.skill.read when the flag is off (not registered) with a clear reason", async () => {
    const { dispatcher } = setup({ skills: null, adapters: both() });
    const r = await dispatcher.execute({ tool: SKILL_READ_WIRE, args: { name: "morning-briefing" }, route: "api_key", actor: "agent", sessionId: "s" });
    expect(r).toMatchObject({ ok: false, status: "refused", reason: "not_registered" });
  });
});

describe("gate: NOUS_SKILLS on adds only the read tool and the index", () => {
  it("tool JSON: the only difference is app__skill__read (both routes, both locales); every other spec is byte-identical", () => {
    const on = setup({ adapters: both() });
    const off = setup({ skills: null, adapters: both() });
    for (const route of ["api_key", "live"] as const) for (const locale of LOCALES) {
      const a = on.registry.functionSpecs(route, locale);
      const b = off.registry.functionSpecs(route, locale);
      expect(JSON.stringify(a.filter((s) => s.name !== SKILL_READ_WIRE))).toBe(JSON.stringify(b));
      expect(a.filter((s) => s.name === SKILL_READ_WIRE)).toHaveLength(1);
      const t1 = buildRealtimeTools(on.caps(route), locale) as { name?: string }[];
      const t0 = buildRealtimeTools(off.caps(route), locale);
      expect(JSON.stringify(t1.filter((t) => t.name !== SKILL_READ_WIRE))).toBe(JSON.stringify(t0));
      expect(liveCallerTools(on.caps("live"), locale).map((t) => (t.type === "function" ? t.name : ""))).toContain(SKILL_READ_WIRE);
    }
  });

  it("instructions: removing exactly the index lines gives back the flag-off text (three layers, both locales)", () => {
    const { caps, book } = setup({ adapters: both() });
    for (const locale of LOCALES) for (const route of ["api_key", "live"] as const) {
      const on = instructions(caps(route), locale);
      const off = instructions(without(caps(route)), locale);
      const tool = book!.indexLines(route, locale, "tool");
      const delegate = book!.indexLines(route, locale, "delegate");
      expect(tool).toHaveLength(2);
      const strip = (text: string, lines: string[]) => text.split("\n").filter((l) => !lines.includes(l)).join("\n");
      expect(strip(on.api_key, tool)).toBe(off.api_key);
      expect(strip(on.caller, tool)).toBe(off.caller);
      expect(strip(on.voice, delegate)).toBe(off.voice);
      for (const line of tool) expect(on.api_key.split("\n")).toContain(line);
    }
  });

  it("both routes get the same index (same lines in the API key instructions and the live tool layer)", () => {
    const { caps } = setup({ adapters: both() });
    for (const locale of LOCALES) {
      const rules = (route: "api_key" | "live") => realtimeToolRules(caps(route), locale);
      expect(rules("api_key")).toEqual(rules("live"));
    }
  });

  it("index text: header plus one line per listed skill, each in the interface language, with the skill's own description", () => {
    const { book } = setup({ adapters: both() });
    const zh = book!.indexLines("api_key", "zh-TW", "tool");
    expect(zh[0]).toBe("家裡常做的事有寫好的做法（技能），列在下面。使用者的請求符合其中一項時，先呼叫 app__skill__read（name 照下面的名稱）讀內文，再照內文做；內文裡的每一步仍要用對應的工具完成，只說工具真的回傳的內容。下面沒有列出的做法就是目前不能用，不要假裝有。");
    expect(zh[1]).toBe(`- morning-briefing：${briefing.locales["zh-TW"].description}`);
    const en = book!.indexLines("api_key", "en", "tool");
    expect(en[0]).toMatch(/^Some common household requests have written procedures \(skills\)/);
    expect(en[1]).toBe(`- morning-briefing: ${briefing.locales.en.description}`);
    expect(en.join("\n")).not.toMatch(/\p{Script=Han}/u);
    expect(book!.indexLines("live", "zh-TW", "delegate")[0]).toBe("家裡常做的事有寫好的做法，使用者的請求符合下面其中一項時一律交辦（連同使用者的原話）：");
    // 索引只有名稱與說明：沒有內文。
    for (const locale of LOCALES) expect(book!.indexLines("api_key", locale, "tool").join("\n")).not.toContain(briefing.locales[locale].body.slice(0, 40));
  });
});

describe("measured: how much the index adds (only morning-briefing, both tools available)", () => {
  // 2026-11-24 量測。改了索引文字或技能說明時，這裡的數字跟著變，要一起更新驗證紀錄（docs/validation/skl-2-skills-realtime-2026-11-24.md）。
  const MEASURED = {
    "zh-TW": { api_key: 202, caller: 202, voice: 113, header: 132, item: 68 },
    en: { api_key: 571, caller: 571, voice: 339, header: 369, item: 200 },
  } as const;

  for (const locale of LOCALES) {
    it(`${locale}: added code points are computed from the real instructions`, () => {
      const { caps, book } = setup({ adapters: both() });
      const added = (route: "api_key" | "live") => {
        const on = instructions(caps(route), locale);
        const off = instructions(without(caps(route)), locale);
        return { api_key: len(on.api_key) - len(off.api_key), caller: len(on.caller) - len(off.caller), voice: len(on.voice) - len(off.voice) };
      };
      const [header, item] = book!.indexLines("api_key", locale, "tool");
      const m = MEASURED[locale];
      expect({ ...added("api_key"), header: len(header!), item: len(item!) }).toEqual({ api_key: m.api_key, caller: added("live").caller, voice: added("live").voice, header: m.header, item: m.item });
      expect(added("live")).toEqual({ api_key: m.api_key, caller: m.caller, voice: m.voice });
      // 加的字數＝指示＋一行技能＋兩個換行（說明以換行連接）。
      expect(m.api_key).toBe(m.header + m.item + 2);
    });
  }

  it("the limit (8 skills, 2,000 code points) fits 8 skills the size of morning-briefing in either language", () => {
    expect(SKILL_INDEX_LIMITS).toEqual({ count: 8, chars: 2_000 });
    // 整段索引＝指示＋每份一行（各加一個換行）。en：369 + 8 × (200 + 1) = 1,977 ≤ 2,000；zh：132 + 8 × 69 = 684。
    expect(MEASURED.en.header + 8 * (MEASURED.en.item + 1)).toBe(1_977);
    expect(MEASURED["zh-TW"].header + 8 * (MEASURED["zh-TW"].item + 1)).toBe(684);
    expect(MEASURED.en.header + 8 * (MEASURED.en.item + 1)).toBeLessThanOrEqual(SKILL_INDEX_LIMITS.chars);
  });
});

describe("listing follows the live registry status", () => {
  it("calendar not configured: morning-briefing is not listed, the read tool is not offered, and the log says why", () => {
    const { book, registry, logs } = setup({ adapters: [weather()] });
    const listing = book!.listing("api_key", "zh-TW");
    expect(listing.listed).toEqual([]);
    expect(listing.unavailable).toEqual([{ name: "morning-briefing", tools: [{ id: "app.calendar.list_events", status: null }] }]);
    expect(book!.indexLines("api_key", "zh-TW", "tool")).toEqual([]);
    expect(registry.status(SKILL_READ_TOOL, "api_key")).toBe("disabled");
    expect(logs).toContain("技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）");
  });

  it("a registered but disabled tool also keeps the skill out", () => {
    const status = new Map<string, CapabilityStatus>([["app.weather.today", "available"], ["app.calendar.list_events", "disabled"]]);
    const book = new SkillBook({ skills: shipped.skills, status: (id) => status.get(id) ?? null });
    expect(book.listing("live", "en").unavailable[0]!.tools).toEqual([{ id: "app.calendar.list_events", status: "disabled" }]);
    status.set("app.calendar.list_events", "available");
    expect(book.listing("live", "en").listed.map((s) => s.name)).toEqual(["morning-briefing"]);
  });

  it("the live tool layer rebuilds its instructions per delegation, so it follows status changes during a call; API key uses the status at session start", () => {
    const status = new Map<string, CapabilityStatus>([["app.weather.today", "available"], ["app.calendar.list_events", "available"]]);
    const book = new SkillBook({ skills: shipped.skills, status: (id) => status.get(id) ?? null });
    const caps: RealtimeCapabilities = { webSearch: false, mcp: [], skills: (l, m) => book.indexLines("live", l, m) };
    expect(buildCallerInstructions(caps, [], NOW)).toContain("- morning-briefing：");
    status.set("app.calendar.list_events", "disabled");
    expect(buildCallerInstructions(caps, [], NOW)).not.toContain("- morning-briefing：");
  });

  it("logs each route and locale once per change, not on every rebuild", () => {
    const { book, logs } = setup({ adapters: both() });
    for (let i = 0; i < 3; i++) book!.indexLines("live", "zh-TW", "tool");
    expect(logs.filter((l) => l.startsWith("技能：live／zh-TW"))).toEqual(["技能：live／zh-TW 列出 1 份（morning-briefing）"]);
  });
});

describe("app.skill.read through the registry and Dispatcher", () => {
  const call = (dispatcher: IntegrationDispatcher, args: unknown, route: IntegrationRoute = "api_key", locale?: Locale) =>
    dispatcher.execute({ tool: SKILL_READ_WIRE, args, route, actor: "agent", sessionId: "s", ...(locale ? { locale } : {}) });

  it("returns the body in the session's language (zh-TW default, en when the session is English); data is not dropped by the 4 KiB default", async () => {
    const { dispatcher } = setup({ adapters: both() });
    for (const route of ["api_key", "live"] as const) {
      const zh = await call(dispatcher, { name: "morning-briefing" }, route);
      expect(zh).toMatchObject({ ok: true, status: "confirmed", data: { name: "morning-briefing", locale: "zh-TW", tools: ["app.weather.today", "app.calendar.list_events"], body: briefing.locales["zh-TW"].body } });
      const en = await call(dispatcher, JSON.stringify({ name: "morning-briefing" }), route, "en");
      expect(en).toMatchObject({ status: "confirmed", data: { locale: "en", body: briefing.locales.en.body } });
      // 英文內文 4,437 字，超過一般工具的 4 KiB data 上限；resultDataMaxBytes 讓它照樣交回。
      expect(Buffer.byteLength(JSON.stringify(en.data))).toBeGreaterThan(MAX_RESULT_DATA_BYTES);
    }
  });

  it("refuses a name that is not loaded, a path-like name, and a name over 40 characters; nothing is read from disk", async () => {
    const { dispatcher } = setup({ adapters: both() });
    expect(await call(dispatcher, { name: "movie-night" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await call(dispatcher, { name: "../morning-briefing" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await call(dispatcher, { name: "morning-briefing/SKILL.md" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await call(dispatcher, { name: "x".repeat(41) })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await call(dispatcher, {})).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await call(dispatcher, { name: "morning-briefing", extra: 1 })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
  });

  it("refuses a loaded skill whose tools are unavailable on this route, naming the tools", async () => {
    const status = new Map<string, CapabilityStatus>([["app.weather.today", "available"], ["app.calendar.list_events", "available"]]);
    const book = new SkillBook({ skills: shipped.skills, status: (id) => status.get(id) ?? null });
    status.set("app.calendar.list_events", "disabled");
    const r = book.read("morning-briefing", "api_key", "zh-TW");
    expect(r).toMatchObject({ status: "refused", reason: "unavailable", data: { name: "morning-briefing", unavailable_tools: ["app.calendar.list_events"] } });
    expect(r.message).toContain("app.calendar.list_events");
    expect(book.read("morning-briefing", "api_key", "en").message).toMatch(/^The skill morning-briefing is not available right now/);
  });

  it("is refused as disabled when the read tool is registered but nothing is listable (the flag is on, the calendar is missing)", async () => {
    const { dispatcher } = setup({ adapters: [weather()] });
    expect(await call(dispatcher, { name: "morning-briefing" })).toMatchObject({ status: "refused", reason: "disabled" });
  });

  it("has full catalog data, is hidden from /help/commands, is read-only, built in, and has no brain region", () => {
    const entry = staticCatalog().find((e) => e.id === SKILL_READ_TOOL)!;
    expect(entry).toMatchObject({ wire: "app__skill__read", kind: "integration", group: "skill", builtin: true, effect: "read", routes: ["api_key", "live"], hidden: true, domain: null, mock: false });
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(entry.examples.length).toBeGreaterThan(0);
    expect(entry.needs).toContain("NOUS_SKILLS=on");
    expect(SKILL_CATALOG.tools.map((t) => t.id)).toEqual([SKILL_READ_TOOL]);
  });

  it("only a read tool may raise its data limit, and only up to 32 KiB", () => {
    const def = (patch: object): IntegrationAdapter => ({
      id: "x", service: "x", version: 1, mock: false, health: async () => ({ health: "available", reason: "ok" }), execute: async () => { throw new Error("no"); },
      tools: () => [{ id: "app.x.y", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false }, effect: "read", enabled: true, timeoutMs: 1000, supportedRoutes: ["api_key"], catalog: { summary: "s", examples: ["e"], domain: null }, ...patch }],
    });
    const reg = () => new IntegrationRegistry({ enabled: { has: () => true } });
    expect(() => reg().register(def({ resultDataMaxBytes: MAX_READ_DATA_BYTES }))).not.toThrow();
    expect(() => reg().register(def({ resultDataMaxBytes: MAX_READ_DATA_BYTES + 1 }))).toThrow(RegistryError);
    expect(() => reg().register(def({ resultDataMaxBytes: MAX_READ_DATA_BYTES, effect: "reversible_write" }))).toThrow(RegistryError);
  });
});

describe("index limit and truncation", () => {
  const fake = (name: string, description = `${name} 的說明`): Skill => ({ name, tools: ["app.weather.today"], locales: { "zh-TW": { description, body: "內文" }, en: { description: `About ${name}`, body: "body" } } });
  const all = () => "available" as const;

  it("lists at most 8 by name order; the rest are truncated and logged", () => {
    const names = ["j", "i", "h", "g", "f", "e", "d", "c", "b", "a"].map((n) => `skill-${n}`);
    const logs: string[] = [];
    const book = new SkillBook({ skills: names.map((n) => fake(n)), status: all, log: (l) => logs.push(l) });
    const listing = book.listing("api_key", "zh-TW");
    expect(listing.listed.map((s) => s.name)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => `skill-${n}`));
    expect(listing.truncated).toEqual(["skill-i", "skill-j"]);
    expect(book.indexLines("api_key", "zh-TW", "tool")).toHaveLength(9);
    expect(logs.at(-1)).toContain("超過索引上限（8 份／2000 字）沒列：skill-i、skill-j");
    expect(book.read("skill-j", "api_key", "zh-TW")).toMatchObject({ status: "refused", reason: "unavailable" });
    expect(book.read("skill-a", "api_key", "zh-TW")).toMatchObject({ status: "confirmed" });
  });

  it("stops at the first skill that does not fit the character limit (no skipping ahead) and never exceeds it", () => {
    const book = new SkillBook({ skills: [fake("a-long", "長".repeat(200)), fake("b-short"), fake("c-short")], status: all, limits: { count: 8, chars: 250 } });
    const listing = book.listing("api_key", "zh-TW");
    expect(listing.listed).toEqual([]);
    expect(listing.truncated).toEqual(["a-long", "b-short", "c-short"]);
    const fits = new SkillBook({ skills: [fake("b-short"), fake("c-short"), fake("d-short")], status: all, limits: { count: 8, chars: 180 } });
    const lines = fits.indexLines("api_key", "zh-TW", "tool");
    expect(len(lines.join("\n"))).toBeLessThanOrEqual(180);
    expect(fits.listing("api_key", "zh-TW").truncated.length).toBeGreaterThan(0);
  });
});

describe("a broken skill file is skipped and logged; startup goes on", () => {
  it("loads the good skill, skips the bad one, and the log names both", () => {
    const root = mkdtempSync(join(tmpdir(), "nous-skl2-"));
    try {
      for (const name of ["morning-briefing", "broken"]) mkdirSync(join(root, name));
      for (const file of ["SKILL.md", "SKILL.en.md"]) writeFileSync(join(root, "morning-briefing", file), readFileSync(join(import.meta.dirname, "..", "skills", "morning-briefing", file), "utf8"));
      writeFileSync(join(root, "broken", "SKILL.md"), "# 沒有 frontmatter\n");
      const { skills, problems } = loadSkills(root);
      expect(skills.map((s) => s.name)).toEqual(["morning-briefing"]);
      const lines = skillLoadLog(skills, problems);
      expect(lines[0]).toBe("技能：載入 1 份（morning-briefing）");
      expect(lines[1]).toBe("技能：1 份檢查失敗被略過：broken");
      expect(lines.slice(2).every((l) => l.startsWith("技能：✗ broken/"))).toBe(true);
      const book = new SkillBook({ skills, status: () => "available" });
      expect(book.listing("api_key", "en").listed.map((s) => s.name)).toEqual(["morning-briefing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the real core (startNous): NOUS_SKILLS wiring", () => {
  let root: string | null = null;
  let core: NousHandle | null = null;
  afterEach(async () => {
    await core?.close();
    core = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address() as AddressInfo;
    await new Promise((r) => s.close(r));
    return port;
  }

  async function boot(env: Record<string, string>): Promise<{ tools: string[]; logs: string[] }> {
    root = mkdtempSync(join(tmpdir(), "nous-skl2-core-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
    const logs: string[] = [];
    core = await startNous({
      envFile: null,
      dataDir: join(root, "data"),
      distDir: dist,
      fallbackPort: true,
      overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", SMARTHOME_URL: "", SMARTHOME_TOKEN: "", NOUS_GOG_PATH: "/nonexistent/gog", NOUS_GOG_ACCOUNT: "someone@example.com", ...env },
      log: (l) => logs.push(l),
      weatherFetch: (async () => new Response("{}", { status: 503 })) as typeof fetch,
    });
    const view = (await (await fetch(`${core.url}/api/settings`)).json()) as SettingsView;
    return { tools: view.integrations?.tools ?? [], logs };
  }
  const AIL = { NOUS_AIL: "on", NOUS_AIL_SERVICES: "weather,google_calendar" };

  it("off (default): no skill is read, no read tool, no skill log line", async () => {
    const { tools, logs } = await boot(AIL);
    expect(tools).toContain("app__calendar__list_events");
    expect(tools).not.toContain(SKILL_READ_WIRE);
    expect(logs.filter((l) => l.startsWith("技能："))).toEqual([]);
  });

  it("on, weather and calendar registered: the read tool is offered and the log records loading and listing per route and locale", async () => {
    const { tools, logs } = await boot({ ...AIL, NOUS_SKILLS: "on" });
    expect(tools).toContain(SKILL_READ_WIRE);
    const skill = logs.filter((l) => l.startsWith("技能："));
    expect(skill).toEqual([
      "技能：載入 1 份（morning-briefing）",
      "技能：api_key／zh-TW 列出 1 份（morning-briefing）",
      "技能：api_key／en 列出 1 份（morning-briefing）",
      "技能：live／zh-TW 列出 1 份（morning-briefing）",
      "技能：live／en 列出 1 份（morning-briefing）",
    ]);
  });

  it("on, calendar not configured: the skill is not listed and the read tool is not offered", async () => {
    const { tools, logs } = await boot({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "weather", NOUS_SKILLS: "on" });
    expect(tools).toContain("app__weather__today");
    expect(tools).not.toContain(SKILL_READ_WIRE);
    expect(logs).toContain("技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）");
  });
});
