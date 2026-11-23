import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.ts";
import {
  CALENDAR_LIMITS,
  CALENDAR_TOOL,
  cleanMultiline,
  cleanText,
  EVENTS_NOTE,
  instantToRfc3339,
  eventRange,
  findEventId,
  GoogleCalendarAdapter,
  localToRfc3339,
  parseEvents,
  parseStart,
} from "../server/integrations/adapters/google-calendar.ts";
import type { GogRunner } from "../server/integrations/gog/runner.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { decide } from "../server/integrations/policy.ts";
import { LiveToolCaller, liveCallerTools } from "../server/live-tool-caller.ts";
import { buildRealtimeTools } from "../server/realtime.ts";
import type { CodexTurn, CodexTurnRequest } from "../server/codex-responses.ts";

// CAL-1：用 gog 讀寫自己的 Google 日曆。雲端沒有 gog 與 Google：用注入的假 runner 與一支假的 gog 腳本（真的 spawn、不經 shell）。
// 帳號、行程都是虛構的。gog --json 的輸出形狀是假設的（官方文件沒寫），需在 Mac 上核對。

const ACCOUNT = "self@example.test";
const ctx = (signal = new AbortController().signal) => ({ actor: "agent" as const, route: "live" as const, sessionId: "s", requestId: "r", signal });

function fakeRunner(reply: { code: number | null; stdout: string } | Error) {
  const calls: { file: string; args: string[] }[] = [];
  const run: GogRunner = async (file, args) => {
    calls.push({ file, args });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { run, calls };
}
const adapter = (reply: Parameters<typeof fakeRunner>[0], opts: { now?: () => number; timeZone?: string } = {}) => {
  const r = fakeRunner(reply);
  return { a: new GoogleCalendarAdapter({ account: ACCOUNT, gogPath: "/opt/fake/gog", run: r.run, ...opts }), calls: r.calls };
};

describe("time handling", () => {
  it("parses only real dates and 24-hour local times", () => {
    expect(parseStart("2026-11-06")).toEqual({ allDay: true, y: 2026, m: 11, d: 6 });
    expect(parseStart("2026-11-06T15:30")).toEqual({ allDay: false, y: 2026, m: 11, d: 6, h: 15, mi: 30 });
    for (const bad of ["2026-02-30", "2026-13-01", "2026-11-06T24:00", "2026-11-06T09:60", "2026/11/06", "tomorrow", "1999-01-01", "2026-11-06T15:30:00", "2026-11-06T15:30+08:00"]) {
      expect(parseStart(bad), bad).toBeNull();
    }
  });

  it("converts local time to RFC3339 with the zone's real offset (Taipei +08:00, DST zones switch)", () => {
    expect(localToRfc3339(2026, 11, 6, 15, 30, "Asia/Taipei")).toBe("2026-11-06T15:30:00+08:00");
    expect(localToRfc3339(2026, 1, 15, 9, 0, "America/New_York")).toBe("2026-01-15T09:00:00-05:00");
    expect(localToRfc3339(2026, 7, 15, 9, 0, "America/New_York")).toBe("2026-07-15T09:00:00-04:00");
    expect(localToRfc3339(2026, 7, 15, 9, 0, "Asia/Kolkata")).toBe("2026-07-15T09:00:00+05:30");
  });

  it("duration is real elapsed time across a DST change (New York 2026-11-01: 00:30 + 120 min = 01:30 EST)", () => {
    const r = eventRange(parseStart("2026-11-01T00:30")!, 120, "America/New_York");
    expect(r).toEqual({ from: "2026-11-01T00:30:00-04:00", to: "2026-11-01T01:30:00-05:00", allDay: false });
    expect(Date.parse(r.to) - Date.parse(r.from)).toBe(120 * 60_000);
    expect(instantToRfc3339(Date.parse("2026-03-08T07:00:00Z"), "America/New_York")).toBe("2026-03-08T03:00:00-04:00");
  });

  it("event range: duration, crossing midnight, all-day end is the next day (month/year rollover)", () => {
    expect(eventRange(parseStart("2026-11-06T15:30")!, 60, "Asia/Taipei")).toEqual({ from: "2026-11-06T15:30:00+08:00", to: "2026-11-06T16:30:00+08:00", allDay: false });
    expect(eventRange(parseStart("2026-11-06T23:30")!, 90, "Asia/Taipei")).toEqual({ from: "2026-11-06T23:30:00+08:00", to: "2026-11-07T01:00:00+08:00", allDay: false });
    expect(eventRange(parseStart("2026-12-31")!, 60, "Asia/Taipei")).toEqual({ from: "2026-12-31", to: "2027-01-01", allDay: true });
  });

  it("cleanText removes control and bidi characters", () => {
    // 換行與 C1 控制字元變成空白；零寬與雙向覆寫字元直接拿掉。
    expect(cleanText("a\nb\u202ec\u0085d\u200be", 50)).toBe("a bc de");
    expect(cleanMultiline("第一行\r\n第二行\u202e\n\n\n\n第三行\u0000", 100)).toBe("第一行\n第二行\n\n第三行");
    expect(cleanText("x".repeat(300), 10)).toHaveLength(10);
  });
});

describe("parsing gog output (shapes are assumptions until checked on the Mac)", () => {
  it("finds events in several shapes; Google API start/end objects; skips items without a start", () => {
    const api = JSON.stringify({ events: [{ id: "e1", summary: "牙醫", start: { dateTime: "2026-11-06T15:00:00+08:00" }, end: { dateTime: "2026-11-06T16:00:00+08:00" }, location: "台北" }, { summary: "國定假日", start: { date: "2026-11-07" }, end: { date: "2026-11-08" } }, { summary: "壞資料" }] });
    expect(parseEvents(api)).toEqual([
      { summary: "牙醫", start: "2026-11-06T15:00:00+08:00", end: "2026-11-06T16:00:00+08:00", all_day: false, location: "台北" },
      { summary: "國定假日", start: "2026-11-07", end: "2026-11-08", all_day: true },
    ]);
    expect(parseEvents(JSON.stringify([{ title: "t", start: "2026-11-06T09:00" }]))).toEqual([{ summary: "t", start: "2026-11-06T09:00", end: null, all_day: false }]);
    expect(parseEvents(JSON.stringify({ items: [{ start: { date: "2026-11-06" } }] }))).toEqual([{ summary: "", start: "2026-11-06", end: null, all_day: true, no_title: true }]);
    expect(parseEvents(JSON.stringify({ count: 0, results: [] }))).toEqual([]);
    expect(parseEvents("not json")).toBeNull();
    expect(parseEvents(JSON.stringify({ nothing: true }))).toBeNull();
  });

  it("finds an event id at the top level or under event", () => {
    expect(findEventId('{"id":"abc123def"}')).toBe("abc123def");
    expect(findEventId('{"event":{"id":"abc123def","htmlLink":"x"}}')).toBe("abc123def");
    expect(findEventId('{"eventId":"zz99"}')).toBe("zz99");
    expect(findEventId('{"id":"has space"}')).toBeNull();
    expect(findEventId("created")).toBeNull();
  });
});

describe("list_events", () => {
  it("always read-only, fixed account and primary calendar, one range flag; returns trimmed events", async () => {
    const { a, calls } = adapter({ code: 0, stdout: JSON.stringify({ events: [{ summary: "牙醫", start: { dateTime: "2026-11-06T15:00:00+08:00" }, end: { dateTime: "2026-11-06T16:00:00+08:00" } }] }) });
    const r = await a.execute(CALENDAR_TOOL.list, { range: "today" }, ctx());
    expect(r).toEqual({ ok: true, status: "confirmed", message: "這是查到的行程。", data: { range: "today", time_zone: "Asia/Taipei", note: EVENTS_NOTE, events: [{ summary: "牙醫", start: "2026-11-06T15:00:00+08:00", end: "2026-11-06T16:00:00+08:00", all_day: false }], truncated: false } });
    expect(calls[0]!.args).toEqual(["calendar", "events", "primary", "--readonly", `--account=${ACCOUNT}`, "--tz=Asia/Taipei", "--max=21", "--json", "--today"]);
    for (const [range, flag] of [["tomorrow", "--tomorrow"], ["week", "--week"]] as const) {
      await a.execute(CALENDAR_TOOL.list, { range }, ctx());
      expect(calls.at(-1)!.args.at(-1)).toBe(flag);
    }
    // 指定一天：當地 00:00 到隔天 00:00（帶時差），跨月跨年也對；不依賴 gog 的 --days。
    await a.execute(CALENDAR_TOOL.list, { range: "date", date: "2026-12-31" }, ctx());
    expect(calls.at(-1)!.args.slice(-2)).toEqual(["--from=2026-12-31T00:00:00+08:00", "--to=2027-01-01T00:00:00+08:00"]);
    expect(calls.every((c) => c.args.includes("--readonly"))).toBe(true);
  });

  it("bad date → refused without running gog; empty → 'no events'; non-zero / unreadable / missing gog → failed", async () => {
    const { a, calls } = adapter({ code: 0, stdout: "[]" });
    expect(await a.execute(CALENDAR_TOOL.list, { range: "date" }, ctx())).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await a.execute(CALENDAR_TOOL.list, { range: "date", date: "2026-02-30" }, ctx())).toMatchObject({ status: "refused" });
    expect(calls).toHaveLength(0);
    expect(await a.execute(CALENDAR_TOOL.list, { range: "today" }, ctx())).toMatchObject({ status: "confirmed", message: "這段時間沒有行程。", data: { events: [] } });
    expect(await adapter({ code: 2, stdout: "" }).a.execute(CALENDAR_TOOL.list, { range: "today" }, ctx())).toMatchObject({ status: "failed", reason: "adapter_error" });
    expect(await adapter({ code: 0, stdout: "<html>" }).a.execute(CALENDAR_TOOL.list, { range: "today" }, ctx())).toMatchObject({ status: "failed", reason: "invalid_result" });
    expect(await adapter(Object.assign(new Error("x"), { code: "ENOENT" })).a.execute(CALENDAR_TOOL.list, { range: "today" }, ctx())).toMatchObject({ status: "failed", reason: "unavailable" });
  });

  it("keeps the data under the dispatcher's 4 KB: at most 20 events, shorter if titles are long, and says so", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ summary: `會議 ${i} ${"長".repeat(100)}`, location: "地".repeat(100), start: { dateTime: "2026-11-06T09:00:00+08:00" }, end: { dateTime: "2026-11-06T10:00:00+08:00" } }));
    const r = await adapter({ code: 0, stdout: JSON.stringify(many) }).a.execute(CALENDAR_TOOL.list, { range: "week" }, ctx());
    const data = r.data as { events: { summary: string; location?: string }[]; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(data.events.length).toBeLessThanOrEqual(20);
    // 整包資料（含 range、time_zone、note、truncated）都在上限內。
    expect(Buffer.byteLength(JSON.stringify(r.data), "utf8")).toBeLessThanOrEqual(CALENDAR_LIMITS.dataBytes);
    expect(data.events[0]!.summary.length).toBeLessThanOrEqual(120);
    expect(data.events[0]!.location!.length).toBeLessThanOrEqual(80);
    expect(r.message).toBe("找到的行程比較多，只列出前面幾個。");
  });
});

describe("create_event", () => {
  it("timed event: RFC3339 with offset, --tz, no attendees; confirmed only with an id", async () => {
    const { a, calls } = adapter({ code: 0, stdout: '{"id":"evt12345","htmlLink":"https://example.test"}' });
    const r = await a.execute(CALENDAR_TOOL.create, { summary: "牙醫", start: "2026-11-06T15:30", duration_min: 45, location: "台北", description: "帶健保卡" }, ctx());
    expect(r).toEqual({ ok: true, status: "confirmed", message: "行程已加到你的 Google 日曆。", data: { start: "2026-11-06T15:30:00+08:00", end: "2026-11-06T16:15:00+08:00", all_day: false, time_zone: "Asia/Taipei" } });
    expect(calls[0]!.args).toEqual(["calendar", "create", "primary", `--account=${ACCOUNT}`, "--summary=牙醫", "--from=2026-11-06T15:30:00+08:00", "--to=2026-11-06T16:15:00+08:00", "--tz=Asia/Taipei", "--location=台北", "--description=帶健保卡", "--json"]);
    expect(calls[0]!.args.join(" ")).not.toMatch(/attendee|send-updates/);
  });

  it("all-day event, default 60 minutes, flag-like titles stay literal", async () => {
    const { a, calls } = adapter({ code: 0, stdout: '{"id":"evt12345"}' });
    await a.execute(CALENDAR_TOOL.create, { summary: "放假", start: "2026-12-31" }, ctx());
    expect(calls[0]!.args).toEqual(["calendar", "create", "primary", `--account=${ACCOUNT}`, "--summary=放假", "--from=2026-12-31", "--to=2027-01-01", "--all-day", "--json"]);
    await a.execute(CALENDAR_TOOL.create, { summary: "--attendees=other@example.test", start: "2026-11-06T09:00" }, ctx());
    expect(calls[1]!.args).toContain("--summary=--attendees=other@example.test");
    expect(calls[1]!.args).toContain("--to=2026-11-06T10:00:00+08:00");
  });

  it("no id → unconfirmed; non-zero → unknown (may exist, do not recreate); missing gog → failed; bad start → refused", async () => {
    expect(await adapter({ code: 0, stdout: "ok" }).a.execute(CALENDAR_TOOL.create, { summary: "a", start: "2026-11-06T09:00" }, ctx())).toMatchObject({ status: "unconfirmed" });
    expect(await adapter({ code: 1, stdout: "" }).a.execute(CALENDAR_TOOL.create, { summary: "a", start: "2026-11-06T09:00" }, ctx())).toMatchObject({ status: "unknown", reason: "adapter_error" });
    expect(await adapter(Object.assign(new Error("x"), { spawnFailed: true })).a.execute(CALENDAR_TOOL.create, { summary: "a", start: "2026-11-06T09:00" }, ctx())).toMatchObject({ status: "failed", reason: "unavailable" });
    const { a, calls } = adapter({ code: 0, stdout: "{}" });
    expect(await a.execute(CALENDAR_TOOL.create, { summary: "a", start: "明天三點" }, ctx())).toMatchObject({ status: "refused" });
    expect(await a.execute(CALENDAR_TOOL.create, { summary: "\n", start: "2026-11-06" }, ctx())).toMatchObject({ status: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("at most 10 new events a minute", async () => {
    let now = 0;
    const { a, calls } = adapter({ code: 0, stdout: '{"id":"evt12345"}' }, { now: () => now });
    for (let i = 0; i < 10; i++) expect((await a.execute(CALENDAR_TOOL.create, { summary: "x", start: "2026-11-06T09:00" }, ctx())).status).toBe("confirmed");
    expect(await a.execute(CALENDAR_TOOL.create, { summary: "x", start: "2026-11-06T09:00" }, ctx())).toMatchObject({ status: "refused", reason: "rate_limited" });
    expect(calls).toHaveLength(10);
    now = 60_001;
    expect((await a.execute(CALENDAR_TOOL.create, { summary: "x", start: "2026-11-06T09:00" }, ctx())).status).toBe("confirmed");
  });

  it("a different configured time zone is used for both conversion and --tz", async () => {
    const { a, calls } = adapter({ code: 0, stdout: '{"id":"evt12345"}' }, { timeZone: "America/New_York" });
    await a.execute(CALENDAR_TOOL.create, { summary: "x", start: "2026-07-15T09:00" }, ctx());
    expect(calls[0]!.args).toContain("--from=2026-07-15T09:00:00-04:00");
    expect(calls[0]!.args).toContain("--tz=America/New_York");
  });
});

describe("real spawn against a fake gog script (no shell)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nous-fake-gog-cal-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "gog");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "seen.jsonl"))}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { process.stdout.write("gog fake\\n"); process.exit(0); }
if (args[1] === "events") { process.stdout.write(JSON.stringify({ events: [{ summary: "fixture", start: { date: "2026-11-06" } }] })); process.exit(0); }
if (args[1] === "create") { process.stdout.write(JSON.stringify({ id: "fakeEvt1" })); process.exit(0); }
process.exit(9);
`,
  );
  chmodSync(script, 0o755);

  it("a busy week with more than 64 KB of gog output is still read (2 MB limit for listing)", async () => {
    const big = join(dir, "gog-big");
    writeFileSync(big, `#!/usr/bin/env node
const events = Array.from({ length: 21 }, (_, i) => ({ summary: "e" + i, description: "x".repeat(10000), start: { dateTime: "2026-11-06T09:00:00+08:00" } }));
process.stdout.write(JSON.stringify({ events }));
`);
    chmodSync(big, 0o755);
    const r = await new GoogleCalendarAdapter({ account: ACCOUNT, gogPath: big }).execute(CALENDAR_TOOL.list, { range: "week" }, ctx());
    expect(r).toMatchObject({ status: "confirmed", data: { truncated: true } });
    expect((r.data as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it("list and create run gog with literal argv; health runs --version", async () => {
    const a = new GoogleCalendarAdapter({ account: ACCOUNT, gogPath: script });
    expect(await a.execute(CALENDAR_TOOL.list, { range: "today" }, ctx())).toMatchObject({ status: "confirmed", data: { events: [{ summary: "fixture", all_day: true }] } });
    const title = "$(touch pwned); `id`";
    expect(await a.execute(CALENDAR_TOOL.create, { summary: title, start: "2026-11-06T09:00" }, ctx())).toMatchObject({ status: "confirmed" });
    expect(await a.health(new AbortController().signal)).toEqual({ health: "available", reason: "ok" });
    const seen = readFileSync(join(dir, "seen.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(seen[1]).toContain(`--summary=${title}`);
  });
});

describe("CAL-1 through config, policy and the integration layer", () => {
  it("config: account from NOUS_GOG_ACCOUNT or NOUS_MAIL_SELF, time zone validated, read only when google_calendar is listed", () => {
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "mock", NOUS_GOG_ACCOUNT: "junk" }).ail.calendar).toBeUndefined();
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "google_calendar", NOUS_MAIL_SELF: ACCOUNT }).ail.calendar).toEqual({ account: ACCOUNT, gogPath: null, timeZone: "Asia/Taipei" });
    expect(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "google_calendar", NOUS_GOG_ACCOUNT: "other@example.test", NOUS_MAIL_SELF: ACCOUNT, NOUS_CALENDAR_TZ: "Europe/London" }).ail.calendar).toEqual({ account: "other@example.test", gogPath: null, timeZone: "Europe/London" });
    expect(() => loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "google_calendar", NOUS_GOG_ACCOUNT: "junk" })).toThrow(/NOUS_GOG_ACCOUNT/);
    expect(() => loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "google_calendar", NOUS_MAIL_SELF: ACCOUNT, NOUS_CALENDAR_TZ: "Mars/Base" })).toThrow(/NOUS_CALENDAR_TZ/);
  });

  it("creating on your own calendar runs without a card (reversible_write); external_commit still needs one", () => {
    expect(decide("reversible_write", CALENDAR_TOOL.create)).toEqual({ kind: "run" });
    expect(decide("external_commit", "app.calendar.invite" as never)).toEqual({ kind: "confirm" });
  });

  it("registered only with an account; both tools reach both routes with the same schema; account never reaches the model", async () => {
    const lines: string[] = [];
    expect(createIntegrations({ enabled: true, services: ["google_calendar"], soloistPort: 19090, calendar: { account: null, gogPath: "/g", timeZone: "Asia/Taipei" } }, (l) => lines.push(l))!.registry.adapters()).toEqual([]);
    expect(lines.join("\n")).toMatch(/NOUS_GOG_ACCOUNT/);
    const { run, calls } = fakeRunner({ code: 0, stdout: '{"events":[]}' });
    const ail = createIntegrations({ enabled: true, services: ["google_calendar"], soloistPort: 19090, calendar: { account: ACCOUNT, gogPath: "/g", timeZone: "Asia/Taipei" } }, () => undefined, {
      google_calendar: (c) => new GoogleCalendarAdapter({ account: c.calendar!.account!, gogPath: "/g", run }),
    })!;
    const apiKey = buildRealtimeTools({ webSearch: false, mcp: [], integrations: (l) => ail.registry.functionSpecs("api_key", l) }).filter((t) => String(t.name).startsWith("app__"));
    const live = liveCallerTools({ webSearch: false, mcp: [], integrations: (l) => ail.registry.functionSpecs("live", l) }).filter((t) => t.type === "function" && t.name.startsWith("app__"));
    expect(apiKey.map((t) => t.name)).toEqual(["app__calendar__create_event", "app__calendar__list_events"]);
    expect(live.map((t) => (t.type === "function" ? [t.name, t.parameters] : null))).toEqual(apiKey.map((t) => [t.name, t.parameters]));
    expect(JSON.stringify(apiKey)).not.toContain(ACCOUNT);
    expect(await ail.dispatcher.execute({ tool: "app__calendar__list_events", args: '{"range":"today"}', route: "api_key", actor: "agent", sessionId: "s" })).toMatchObject({ status: "confirmed" });
    // 模型多塞帳號或日曆：Schema 拒絕，不執行。
    expect(await ail.dispatcher.execute({ tool: "app__calendar__list_events", args: { range: "today", calendar: "other" }, route: "api_key", actor: "agent", sessionId: "s" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await ail.dispatcher.execute({ tool: "app__calendar__create_event", args: { summary: "x", start: "2026-11-06T09:00", attendees: "a@example.test" }, route: "api_key", actor: "agent", sessionId: "s" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(calls).toHaveLength(1);
  });

  it("ChatGPT plan route: the delegation reads the calendar in the core and relays the result", async () => {
    const { run } = fakeRunner({ code: 0, stdout: JSON.stringify({ events: [{ summary: "牙醫", start: { dateTime: "2026-11-06T15:00:00+08:00" } }] }) });
    const ail = createIntegrations({ enabled: true, services: ["google_calendar"], soloistPort: 19090, calendar: { account: ACCOUNT, gogPath: "/g", timeZone: "Asia/Taipei" } }, () => undefined, {
      google_calendar: () => new GoogleCalendarAdapter({ account: ACCOUNT, gogPath: "/g", run }),
    })!;
    const turns: CodexTurn[] = [
      { text: "", calls: [{ call_id: "c1", name: "app__calendar__list_events", arguments: '{"range":"today"}' }], citations: [], model: "m", replay: [] },
      { text: "你今天下午三點看牙醫。", calls: [], citations: [], model: "m", replay: [] },
    ];
    const requests: CodexTurnRequest[] = [];
    const hostCalls: string[] = [];
    const caller = new LiveToolCaller({
      responses: { turn: async (req) => { requests.push({ ...req, input: [...req.input] }); return turns.shift()!; } },
      caps: () => ({ webSearch: false, mcp: [], integrations: (l) => ail.registry.functionSpecs("live", l) }),
      host: { outstanding: 0, call: async (name) => { hostCalls.push(name); return { ok: true }; } },
      tasks: () => [],
      approval: () => ({ open: false, resolvedAt: null }),
      integrations: { dispatcher: ail.dispatcher, sessionId: "s" },
    });
    const result = await caller.run({ id: "d1", text: "我今天有什麼行程", source: "voice", transcript: [] }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, text: "你今天下午三點看牙醫。" });
    expect(hostCalls).toEqual([]);
    const output = requests[1]!.input.find((i) => "type" in i && i.type === "function_call_output") as { output: string };
    expect(JSON.parse(output.output)).toMatchObject({ status: "confirmed", data: { events: [{ summary: "牙醫" }] } });
  });
});
