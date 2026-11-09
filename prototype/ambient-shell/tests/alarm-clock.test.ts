import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlarmCenter, type SchedulerClock } from "../server/alarms.ts";
import { AlarmAdapter } from "../server/integrations/adapters/alarm.ts";
import { TimerAdapter } from "../server/integrations/adapters/timer.ts";
import { createIntegrations } from "../server/integrations/index.ts";
import { LiveToolCaller } from "../server/live-tool-caller.ts";
import { realtimeToolRules } from "../server/realtime.ts";
import type { CodexTurn } from "../server/codex-responses.ts";
import { matchRingSnooze, matchRingStop, ringPeakVolume } from "../shared/alarm.ts";
import { nextOccurrence, parseClock, repeatDays, repeatText, wallTime, wallToEpoch } from "../shared/alarm-schedule.ts";

// ALARM-2：鬧鐘（本機時區的牆上時間、單次與重複、跨日與夏令時間、貪睡、錯過、重啟、時區改變）與兩條語音路徑的工具 fixture。

class FakeClock implements SchedulerClock {
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(public t: number) {}
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
  }
  /** 前進到某個時刻（之間的計時器照順序觸發）。 */
  to(epoch: number): void {
    this.advance(epoch - this.t);
  }
  sleep(ms: number): void {
    this.t += ms;
  }
}

const TPE = "Asia/Taipei";
const NY = "America/New_York";
/** 台北的當地時間 → epoch。 */
const tpe = (date: string, hh: number, mm = 0) => wallToEpoch(date, hh, mm, TPE);

function make(start: number, opts: { tz?: { v: string }; dir?: string; connected?: Set<string> } = {}) {
  const clock = new FakeClock(start);
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "nous-alarm2-"));
  const rings: string[] = [];
  const awake: boolean[] = [];
  let n = 0;
  const tz = opts.tz ?? { v: TPE };
  const c = new AlarmCenter({ dir, clock, id: () => `k${++n}`, timeZone: () => tz.v, isConnected: (s) => opts.connected?.has(s) ?? false, onRingStart: (r) => rings.push(`${r.kind}:${r.label ?? ""}`), onAwakeChange: (v) => awake.push(v) });
  return { c, clock, dir, rings, awake, tz };
}

describe("local wall-clock math", () => {
  it("parses clock times and repeat rules", () => {
    expect(parseClock("7:05")).toEqual({ hour: 7, minute: 5 });
    expect(parseClock("24:00")).toBeNull();
    expect(repeatDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
    expect(repeatDays("custom", "一三五")).toEqual([1, 3, 5]);
    expect(repeatDays("custom", "mon, sat")).toEqual([1, 6]);
    expect(repeatDays("custom", "")).toBeNull();
    expect(repeatDays("hourly")).toBeNull();
    expect(repeatText([1, 2, 3, 4, 5])).toBe("工作日");
    expect(repeatText([1, 3, 5], "en")).toBe("Mon, Wed, Fri");
  });

  it("daylight saving: a skipped time moves past the gap, a repeated time uses the first one", () => {
    expect(new Date(wallToEpoch("2026-03-08", 2, 30, NY)).toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(new Date(wallToEpoch("2026-11-01", 1, 30, NY)).toISOString()).toBe("2026-11-01T05:30:00.000Z"); // first 01:30 (EDT)
    // 每天 07:00 的鬧鐘跨過夏令時間開始：前後兩天都在當地 07:00 響（間隔 23 小時）。
    const a = { hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], date: null };
    const sat = nextOccurrence(a, Date.UTC(2026, 2, 7, 0, 0), NY)!;
    const sun = nextOccurrence(a, sat, NY)!;
    expect(wallTime(sat, NY)).toMatchObject({ date: "2026-03-07", hour: 7 });
    expect(wallTime(sun, NY)).toMatchObject({ date: "2026-03-08", hour: 7 });
    expect(sun - sat).toBe(23 * 3600_000);
  });

  it("weekday alarms skip the weekend and cross midnight correctly in the local time zone", () => {
    const fri2330 = tpe("2026-11-13", 23, 30);
    const next = nextOccurrence({ hour: 6, minute: 30, days: [1, 2, 3, 4, 5], date: null }, fri2330, TPE)!;
    expect(wallTime(next, TPE)).toMatchObject({ date: "2026-11-16", hour: 6, minute: 30, weekday: 1 });
  });
});

describe("AlarmCenter alarms (fake clock, Asia/Taipei)", () => {
  it("'tomorrow at 7' rings once at local 07:00, then turns itself off", () => {
    const { c, clock, rings } = make(tpe("2026-11-09", 22, 0));
    const r = c.setAlarm({ time: "07:00", days: [], label: "起床" });
    expect(r).toMatchObject({ ok: true, alarm: { date: "2026-11-10", next_at: tpe("2026-11-10", 7) } });
    clock.to(tpe("2026-11-10", 7) - 1);
    expect(rings).toEqual([]);
    clock.advance(1);
    expect(rings).toEqual(["alarm:起床"]);
    expect(c.alarms()[0]).toMatchObject({ enabled: false, next_at: null });
  });

  it("an alarm for a time earlier than now (no date) means tomorrow; an explicit past date is refused", () => {
    const { c } = make(tpe("2026-11-09", 8, 0));
    expect(c.setAlarm({ time: "07:30", days: [] })).toMatchObject({ ok: true, alarm: { date: "2026-11-10" } });
    expect(c.setAlarm({ time: "09:00", days: [] })).toMatchObject({ ok: true, alarm: { date: "2026-11-09" } });
    expect(c.setAlarm({ time: "07:30", days: [], date: "2026-11-09" })).toMatchObject({ ok: false, code: "invalid" });
    expect(c.setAlarm({ time: "7am", days: [] })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("'every weekday at 6:30' rings Mon–Fri and skips the weekend", () => {
    const { c, clock, rings } = make(tpe("2026-11-13", 12, 0)); // 星期五中午
    c.setAlarm({ time: "06:30", days: [1, 2, 3, 4, 5] });
    clock.to(tpe("2026-11-16", 6, 29));
    expect(rings).toEqual([]);
    clock.to(tpe("2026-11-16", 6, 30));
    expect(rings).toHaveLength(1);
    c.stopRings("button");
    expect(c.alarms()[0]).toMatchObject({ enabled: true, next_at: tpe("2026-11-17", 6, 30) });
  });

  it("snooze: stops now, rings again after 9 minutes; stopping ends it; the snooze countdown is in the view", () => {
    const { c, clock, rings } = make(tpe("2026-11-09", 6, 0));
    c.setAlarm({ time: "06:30", days: [0, 1, 2, 3, 4, 5, 6], label: "起床" });
    clock.to(tpe("2026-11-09", 6, 30));
    expect(c.snoozeRings("voice")).toBe(1);
    expect(c.rings()).toEqual([]);
    expect(c.view("main").snoozes).toMatchObject([{ label: "起床", due_at: tpe("2026-11-09", 6, 39) }]);
    expect(c.recentLog().at(-1)).toMatchObject({ kind: "alarm", outcome: "snoozed", by: "voice" });
    clock.to(tpe("2026-11-09", 6, 39));
    expect(rings).toEqual(["alarm:起床", "alarm:起床"]);
    expect(c.stopRings("gesture")).toBe(1);
    expect(c.view("main").snoozes).toEqual([]);
    expect(c.alarms()[0]!.next_at).toBe(tpe("2026-11-10", 6, 30));
  });

  it("snooze only applies to alarms; a ringing timer has nothing to snooze", () => {
    const { c, clock } = make(tpe("2026-11-09", 6, 0));
    c.startTimer({ duration_s: 10 });
    clock.advance(10_000);
    expect(c.snoozeRings("button")).toBe(0);
    expect(c.rings()).toHaveLength(1);
  });

  it("Mac asleep through an alarm: within 30 minutes it rings late; a repeating alarm missed for hours is logged once and scheduled for next time", () => {
    const late = make(tpe("2026-11-09", 6, 0));
    late.c.setAlarm({ time: "06:30", days: [] });
    late.clock.sleep(45 * 60_000); // 06:45 醒來
    late.c.tick();
    expect(late.c.rings()[0]).toMatchObject({ kind: "alarm", late_ms: 15 * 60_000 });

    const missed = make(tpe("2026-11-09", 6, 0));
    missed.c.setAlarm({ time: "06:30", days: [0, 1, 2, 3, 4, 5, 6] });
    missed.clock.sleep(3 * 24 * 3600_000); // 睡了三天
    missed.c.tick();
    expect(missed.rings).toEqual([]);
    expect(missed.c.recentLog().filter((e) => e.outcome === "missed")).toHaveLength(1);
    expect(missed.c.alarms()[0]!.next_at).toBe(tpe("2026-11-12", 6, 30)); // 11-12 06:00 醒來：當天 06:30 照常
  });

  it("restart: alarms and snoozes come back from alarms.json, and an ALARM-1 (version 1) file still loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-alarm2-"));
    const first = make(tpe("2026-11-09", 6, 0), { dir });
    first.c.setAlarm({ time: "06:30", days: [1, 2, 3, 4, 5], label: "上班" });
    first.c.dispose();
    const second = make(tpe("2026-11-09", 6, 10), { dir });
    expect(second.c.alarms()).toMatchObject([{ label: "上班", time: "06:30", enabled: true, next_at: tpe("2026-11-09", 6, 30) }]);

    const v1 = mkdtempSync(join(tmpdir(), "nous-alarm2-"));
    writeFileSync(join(v1, "alarms.json"), JSON.stringify({ schema_version: 1, prefs: { ring_s: 120 }, timers: [{ id: "t_a1", label: "x", duration_ms: 60000, created_at: 0, origin: null, state: "paused", remaining_ms: 30000 }], rings: [], log: [], notice_cleared_at: 0 }));
    const old = make(tpe("2026-11-09", 6, 0), { dir: v1 });
    expect(old.c.prefs().ring_s).toBe(120);
    expect(old.c.timers()).toHaveLength(1);
    expect(old.c.alarms()).toEqual([]);
  });

  it("a time-zone change recomputes the next ring in the new local time", () => {
    const tz = { v: TPE };
    const { c, clock } = make(tpe("2026-11-09", 6, 0), { tz });
    c.setAlarm({ time: "07:00", days: [0, 1, 2, 3, 4, 5, 6] });
    expect(c.alarms()[0]!.next_at).toBe(tpe("2026-11-09", 7));
    tz.v = "Asia/Tokyo";
    clock.advance(30_000);
    expect(wallTime(c.alarms()[0]!.next_at!, "Asia/Tokyo")).toMatchObject({ hour: 7, minute: 0 });
  });

  it("review: an alarm already due when the time zone changes still rings late instead of vanishing", () => {
    const tz = { v: TPE };
    const { c, clock } = make(tpe("2026-11-09", 13, 0), { tz });
    c.setAlarm({ time: "14:00", days: [0, 1, 2, 3, 4, 5, 6] });
    clock.sleep(65 * 60_000); // 14:05 台北醒來，時區換成東京
    tz.v = "Asia/Tokyo";
    c.tick();
    expect(c.rings()[0]).toMatchObject({ kind: "alarm", late_ms: 5 * 60_000 });
  });

  it("review: a one-off whose local time has already passed in the new zone turns off and is logged as missed", () => {
    const tz = { v: TPE };
    const { c, clock } = make(tpe("2026-11-09", 12, 0), { tz });
    c.setAlarm({ time: "14:00", days: [] });
    tz.v = "Pacific/Kiritimati"; // UTC+14：台北 12:00 時當地已經過 18:00
    clock.advance(30_000);
    expect(c.alarms()[0]).toMatchObject({ enabled: false, next_at: null });
    expect(c.recentLog().at(-1)).toMatchObject({ kind: "alarm", outcome: "missed" });
  });

  it("review: adding an alarm right after a zone change still recomputes the older ones", () => {
    const tz = { v: TPE };
    const { c } = make(tpe("2026-11-09", 12, 0), { tz });
    c.setAlarm({ time: "20:00", days: [1, 2, 3, 4, 5] });
    tz.v = "America/Los_Angeles";
    c.setAlarm({ time: "21:00", days: [1, 2, 3, 4, 5] });
    const la = c.alarms().map((a) => wallTime(a.next_at!, "America/Los_Angeles"));
    expect(la.map((w) => w.hour)).toEqual([20, 21]);
  });

  it("review: turning the feature back on does not report alarms that passed while it was off", () => {
    const { c, clock } = make(tpe("2026-11-09", 6, 0));
    c.setAlarm({ time: "06:30", days: [0, 1, 2, 3, 4, 5, 6] });
    c.setAlarm({ time: "06:40", days: [] });
    c.updatePrefs({ enabled: false });
    clock.to(tpe("2026-11-09", 6, 50));
    c.updatePrefs({ enabled: true });
    expect(c.rings()).toEqual([]);
    expect(c.recentLog().filter((e) => e.outcome === "missed")).toEqual([]);
    expect(c.alarms()).toMatchObject([{ enabled: true, next_at: tpe("2026-11-10", 6, 30) }, { enabled: false, next_at: null }]);
  });

  it("review: deleting or turning off a ringing alarm stops its ring", () => {
    const { c, clock } = make(tpe("2026-11-09", 6, 0));
    c.setAlarm({ time: "06:30", days: [0, 1, 2, 3, 4, 5, 6], label: "a" });
    clock.to(tpe("2026-11-09", 6, 30));
    expect(c.rings()).toHaveLength(1);
    c.setAlarmEnabled("a", false);
    expect(c.rings()).toEqual([]);
    c.setAlarmEnabled("a", true);
    clock.to(tpe("2026-11-10", 6, 30));
    expect(c.rings()).toHaveLength(1);
    c.deleteAlarm("a");
    expect(c.rings()).toEqual([]);
    expect(c.recentLog().at(-1)).toMatchObject({ outcome: "stopped", by: "settings" });
  });

  it("turn off, turn on (a past one-off moves to its next time), delete by time or name, ambiguity", () => {
    const { c, clock } = make(tpe("2026-11-09", 6, 0));
    c.setAlarm({ time: "06:30", days: [], label: "吃藥" });
    c.setAlarm({ time: "08:00", days: [0, 6] });
    expect(c.setAlarmEnabled(undefined, false)).toMatchObject({ ok: false, code: "ambiguous" });
    expect(c.setAlarmEnabled("吃藥", false)).toMatchObject({ ok: true, alarm: { enabled: false, next_at: null } });
    clock.to(tpe("2026-11-09", 9, 0));
    expect(c.setAlarmEnabled("06:30", true)).toMatchObject({ ok: true, alarm: { enabled: true, date: "2026-11-10", next_at: tpe("2026-11-10", 6, 30) } });
    expect(c.deleteAlarm("8:00")).toMatchObject({ ok: true, deleted: [{ time: "08:00" }] });
    expect(c.deleteAlarm(undefined, true)).toMatchObject({ ok: true, deleted: [{ label: "吃藥" }] });
  });

  it("keeps the Mac awake when an alarm is within 12 hours (and only then)", () => {
    const { c, clock, awake } = make(tpe("2026-11-09", 12, 0));
    c.setAlarm({ time: "07:00", days: [] }); // 明天 07:00：19 小時後
    expect(c.awakeNeeded()).toBe(false);
    clock.to(tpe("2026-11-09", 19, 1));
    expect(c.awakeNeeded()).toBe(true);
    expect(awake.at(-1)).toBe(true);
  });
});

describe("app.alarm.* tools", () => {
  function setup(start: number) {
    const m = make(start, { connected: new Set(["rpi4"]) });
    const ail = createIntegrations({ enabled: false, services: [], soloistPort: 19090 }, () => undefined, undefined, {}, [
      { adapter: new TimerAdapter(m.c), enabled: () => m.c.enabled },
      { adapter: new AlarmAdapter(m.c), enabled: () => m.c.enabled },
    ])!;
    return { ...m, ail };
  }
  const call = (s: ReturnType<typeof setup>, tool: string, args: unknown, page?: string) => s.ail.dispatcher.execute({ tool, args: JSON.stringify(args), route: "api_key", actor: "agent", sessionId: "s", ...(page ? { page } : {}) });

  it("are offered on both routes with a speaking rule", () => {
    const s = setup(tpe("2026-11-09", 22, 0));
    const names = s.ail.registry.functionSpecs("live").map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["app__alarm__set", "app__alarm__list", "app__alarm__enable", "app__alarm__delete", "app__alarm__snooze", "app__alarm__stop_ringing"]));
    expect(s.ail.registry.functionSpecs("api_key").map((x) => x.name)).toEqual(names);
    expect(realtimeToolRules({ webSearch: false, mcp: [], home: false, integrations: (l) => s.ail.registry.functionSpecs("live", l) }).join("\n")).toContain("app__alarm__set");
  });

  it("set (weekdays, custom, date), list, refuse bad input; the alarm rings on the device that set it", async () => {
    const s = setup(tpe("2026-11-09", 22, 0));
    expect(await call(s, "app__alarm__set", { time: "06:30", repeat: "weekdays" }, "rpi4")).toMatchObject({ status: "confirmed", message: "已設定工作日 06:30 的鬧鐘。", data: { alarm: { next: "2026-11-10 06:30" } } });
    expect(await call(s, "app__alarm__set", { time: "21:00", repeat: "custom", days: "mon,wed", label: "倒垃圾" })).toMatchObject({ status: "confirmed", data: { alarm: { repeat: "週一、三" } } });
    expect(await call(s, "app__alarm__set", { time: "09:00", date: "2026-11-12" })).toMatchObject({ status: "confirmed", data: { alarm: { date: "2026-11-12" } } });
    expect(await call(s, "app__alarm__set", { time: "09:00", repeat: "custom" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(await call(s, "app__alarm__set", { time: "25:00" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect((await call(s, "app__alarm__list", {})).data).toMatchObject({ alarms: [{ time: "06:30" }, { label: "倒垃圾" }, { time: "09:00" }] });
    s.clock.to(tpe("2026-11-10", 6, 30));
    expect(s.c.rings()[0]).toMatchObject({ kind: "alarm", targets: ["rpi4"] });
    expect(await call(s, "app__alarm__snooze", {})).toMatchObject({ status: "confirmed", message: "好，9 分鐘後再叫。" });
    expect(await call(s, "app__alarm__stop_ringing", { cancel_snoozes: true })).toMatchObject({ status: "confirmed", data: { stopped: 0, snoozes_cancelled: 1 } });
  });

  it("live route: LiveToolCaller sets the alarm in the core", async () => {
    const s = setup(tpe("2026-11-09", 22, 0));
    const turns: CodexTurn[] = [
      { text: "", calls: [{ call_id: "c1", name: "app__alarm__set", arguments: '{"time":"07:00","date":"2026-11-10"}' }], citations: [], model: "fixture", replay: [] },
      { text: "好，明天 7 點叫你。", calls: [], citations: [], model: "fixture", replay: [] },
    ];
    const caller = new LiveToolCaller({
      responses: { turn: async () => turns.shift()! },
      caps: () => ({ webSearch: false, mcp: [], home: false, integrations: (l) => s.ail.registry.functionSpecs("live", l) }),
      host: { outstanding: 0, call: async () => ({ ok: false }) },
      tasks: () => [],
      approval: () => ({ open: false, resolvedAt: null }),
      integrations: { dispatcher: s.ail.dispatcher, sessionId: "s1", page: "main" },
    });
    const result = await caller.run({ id: "d1", text: "明天早上 7 點叫我", source: "voice", transcript: [] }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, tools: [{ name: "app__alarm__set", ok: true }] });
    expect(s.c.alarms()).toMatchObject([{ time: "07:00", date: "2026-11-10", next_at: tpe("2026-11-10", 7) }]);
  });
});

describe("page helpers for alarms", () => {
  it("snooze phrases are separate from stop phrases", () => {
    for (const x of ["貪睡", "再睡一下", "再睡五分鐘", "snooze", "晚點再叫我"]) expect(matchRingSnooze(x), x).toBe(true);
    for (const x of ["停", "我起來了", "幫我設鬧鐘"]) expect(matchRingSnooze(x), x).toBe(false);
    expect(matchRingStop("我起來了")).toBe(true);
  });

  it("alarms have a minimum volume; timers do not", () => {
    expect(ringPeakVolume(10, 30)).toBe(0.3);
    expect(ringPeakVolume(10, 0)).toBe(0.1);
    expect(ringPeakVolume(80, 30)).toBe(0.8);
  });
});
