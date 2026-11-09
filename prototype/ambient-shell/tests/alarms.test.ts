import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlarmCenter, type SchedulerClock } from "../server/alarms.ts";
import { createApp } from "../server/app.ts";
import { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import type { CodexTurn } from "../server/codex-responses.ts";
import { TimerAdapter } from "../server/integrations/adapters/timer.ts";
import { createIntegrations, type Integrations } from "../server/integrations/index.ts";
import { LiveToolCaller } from "../server/live-tool-caller.ts";
import { MockExecutor } from "../server/mock-executor.ts";
import { ProviderManager } from "../server/providers.ts";
import { buildLiveInstructions, realtimeToolRules } from "../server/realtime.ts";
import type { RealtimeRoute, RouteCall } from "../server/realtime-routes.ts";
import { TaskRunner } from "../server/runner.ts";
import { TaskStore } from "../server/store.ts";
import { formatCountdown, matchRingStop, ringGainAt, ringPeakVolume, spokenDuration, type AlarmsView } from "../shared/alarm.ts";
import { billingLine } from "../shared/realtime-route.ts";
import { WakeGuard } from "../src/audio/guard.ts";
import { ringCycleSamples } from "../src/alarm-sound.ts";

// ALARM-1：定時器與響鈴。假時鐘（排程、多定時器、跨夏令時間、重啟恢復、睡眠錯過、自動停止）、
// 兩條即時語音路徑的工具 fixture（live：LiveToolCaller 在核心執行；api_key：頁面轉交 /api/integrations/call），以及頁面用的純函式。

/** 假時鐘：setTimeout 只登記，advance() 依時間順序觸發；sleep() 模擬 Mac 睡眠（時間前進但計時器不觸發）。 */
class FakeClock implements SchedulerClock {
  t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  constructor(start = Date.UTC(2026, 10, 9, 0, 0, 0)) {
    this.t = start;
  }
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
  sleep(ms: number): void {
    this.t += ms;
  }
  pending(): number {
    return this.timers.size;
  }
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nous-alarm-"));
  dirs.push(d);
  return d;
}

function center(options: { dir?: string; clock?: FakeClock; connected?: Set<string>; rings?: string[]; logs?: string[] } = {}) {
  const clock = options.clock ?? new FakeClock();
  const dir = options.dir ?? tmp();
  let n = 0;
  const rings = options.rings ?? [];
  const logs = options.logs ?? [];
  const c = new AlarmCenter({
    dir,
    clock,
    id: () => `x${++n}${Math.floor(clock.t / 1000) % 1000}`,
    isConnected: (s) => options.connected?.has(s) ?? false,
    onRingStart: (r) => rings.push(r.label ?? "(none)"),
    log: (l) => logs.push(l),
  });
  return { c, clock, dir, rings, logs };
}

describe("AlarmCenter (fake clock)", () => {
  it("rings exactly when a timer ends, only on the device that set it when that device is online", () => {
    const { c, clock, rings } = center({ connected: new Set(["rpi4"]) });
    const r = c.startTimer({ duration_s: 180, label: "  泡麵 ", origin: "rpi4" });
    expect(r).toMatchObject({ ok: true, timer: { label: "泡麵", state: "running" } });
    clock.advance(179_999);
    expect(c.rings()).toEqual([]);
    clock.advance(1);
    expect(rings).toEqual(["泡麵"]);
    expect(c.rings()[0]).toMatchObject({ label: "泡麵", late_ms: 0, targets: ["rpi4"] });
    expect(c.view("rpi4").rings[0]!.here).toBe(true);
    expect(c.view("main").rings[0]!.here).toBe(false);
    expect(c.timers()).toEqual([]);
  });

  it("rings on every screen when the device that set it is offline (Pi disconnected)", () => {
    const { c, clock } = center({ connected: new Set(["main"]) });
    c.startTimer({ duration_s: 60, origin: "rpi4" });
    clock.advance(60_000);
    expect(c.rings()[0]!.targets).toBe("all");
    expect(c.view("main").rings[0]!.here).toBe(true);
  });

  it("runs several timers at once; pause, resume, extend and cancel by name; asks which one when ambiguous", () => {
    const { c, clock } = center();
    c.startTimer({ duration_s: 600, label: "泡麵" });
    c.startTimer({ duration_s: 300, label: "雞蛋" });
    expect(c.pause(undefined)).toMatchObject({ ok: false, code: "ambiguous", candidates: ["泡麵", "雞蛋"] });
    expect(c.pause("泡")).toMatchObject({ ok: true, timer: { state: "paused", remaining_ms: 600_000 } });
    clock.advance(100_000);
    expect(c.resume(undefined)).toMatchObject({ ok: true, timer: { label: "泡麵", state: "running", ends_at: clock.t + 600_000 } });
    expect(c.extend("雞蛋", 120)).toMatchObject({ ok: true, timer: { duration_ms: 420_000 } });
    expect(c.cancel("咖啡")).toMatchObject({ ok: false, code: "not_found", candidates: ["泡麵", "雞蛋"] });
    expect(c.cancel("雞蛋")).toMatchObject({ ok: true, cancelled: [{ label: "雞蛋" }] });
    expect(c.timers().map((t) => t.label)).toEqual(["泡麵"]);
    expect(c.cancel(undefined, true)).toMatchObject({ ok: true, cancelled: [{ label: "泡麵" }] });
    clock.advance(3_600_000);
    expect(c.rings()).toEqual([]);
  });

  it("refuses out-of-range lengths and more than 10 timers", () => {
    const { c } = center();
    expect(c.startTimer({ duration_s: 0 })).toMatchObject({ ok: false, code: "invalid" });
    expect(c.startTimer({ duration_s: 86_401 })).toMatchObject({ ok: false, code: "invalid" });
    for (let i = 0; i < 10; i++) expect(c.startTimer({ duration_s: 60 + i }).ok).toBe(true);
    expect(c.startTimer({ duration_s: 60 })).toMatchObject({ ok: false, code: "limit" });
  });

  it("a ring nobody stops ends by itself after ring_s and is logged and shown as a notice", () => {
    const { c, clock } = center();
    c.startTimer({ duration_s: 10, label: "茶" });
    clock.advance(10_000);
    const ringId = c.rings()[0]!.id;
    expect(c.ack(ringId, "main", true)).toBe(true);
    clock.advance(299_999);
    expect(c.rings()).toHaveLength(1);
    clock.advance(1);
    expect(c.rings()).toEqual([]);
    expect(c.recentLog().at(-1)).toMatchObject({ label: "茶", outcome: "auto_stopped", heard: true });
    expect(c.view("main").notice).toMatchObject({ outcome: "auto_stopped" });
    c.clearNotice();
    expect(c.view("main").notice).toBeNull();
  });

  it("stopping records who stopped it and silences every screen", () => {
    const { c, clock } = center();
    c.startTimer({ duration_s: 5 });
    c.startTimer({ duration_s: 5, label: "b" });
    clock.advance(5_000);
    expect(c.rings()).toHaveLength(2);
    expect(c.stopRings("gesture")).toBe(2);
    expect(c.rings()).toEqual([]);
    expect(c.recentLog().map((e) => [e.outcome, e.by])).toEqual([["stopped", "gesture"], ["stopped", "gesture"]]);
    expect(c.view("main").notice).toBeNull();
  });

  it("Mac sleep: a timer that ended while asleep rings late (with how late) when the core wakes, within 30 minutes", () => {
    const { c, clock } = center();
    c.startTimer({ duration_s: 600, label: "烤箱" });
    clock.sleep(20 * 60_000); // 睡了 20 分鐘：計時器沒有觸發
    expect(c.rings()).toEqual([]);
    c.tick(); // App 收到 powerMonitor resume
    expect(c.rings()[0]).toMatchObject({ label: "烤箱", late_ms: 10 * 60_000 });
  });

  it("Mac sleep longer than the catch-up window: logged as missed, never rings", () => {
    const { c, clock, rings } = center();
    c.startTimer({ duration_s: 60, label: "洗衣" });
    clock.sleep(2 * 3600_000);
    clock.advance(30_000); // 沒有 resume 事件也會在 30 秒內自己發現
    expect(rings).toEqual([]);
    expect(c.recentLog().at(-1)).toMatchObject({ label: "洗衣", outcome: "missed", heard: false });
    expect(c.view("main").notice).toMatchObject({ outcome: "missed" });
  });

  it("never sleeps longer than 30 s between checks, so a late wake-up is noticed without a resume event", () => {
    const { c, clock } = center();
    c.startTimer({ duration_s: 3600 });
    expect(clock.pending()).toBe(1);
    clock.sleep(3600_000 + 5_000);
    clock.advance(30_000);
    expect(c.rings()).toHaveLength(1);
  });

  it("restart: timers and ringing state come back from alarms.json; overdue timers follow the late rules", () => {
    const dir = tmp();
    const clock = new FakeClock();
    const first = center({ dir, clock });
    first.c.startTimer({ duration_s: 600, label: "長" });
    first.c.startTimer({ duration_s: 60, label: "短" });
    first.c.pause("長");
    first.c.dispose();
    clock.sleep(5 * 60_000); // 核心停了 5 分鐘
    const second = center({ dir, clock });
    expect(second.c.timers()).toMatchObject([{ label: "長", state: "paused", remaining_ms: 600_000 }]);
    expect(second.c.rings()[0]).toMatchObject({ label: "短", late_ms: 4 * 60_000 });
    second.c.dispose();
    clock.sleep(10 * 60_000); // 響到一半又重啟，超過 5 分鐘：自動停止並記錄
    const third = center({ dir, clock });
    expect(third.c.rings()).toEqual([]);
    expect(third.c.recentLog().at(-1)).toMatchObject({ label: "短", outcome: "auto_stopped" });
  });

  it("an unreadable alarms.json starts empty and keeps the original aside", () => {
    const dir = tmp();
    writeFileSync(join(dir, "alarms.json"), "{not json");
    const logs: string[] = [];
    const { c } = center({ dir, logs });
    expect(c.timers()).toEqual([]);
    expect(existsSync(join(dir, "alarms.json.unreadable"))).toBe(true);
    expect(logs.join("\n")).toMatch(/無法讀取/);
  });

  it("timers count real elapsed time across a daylight-saving change (epoch based, not wall clock)", () => {
    // 2026-03-08 02:00 美東跳到 03:00；01:30 開始的 1 小時定時器在真實的 1 小時後（牆上時鐘 03:30）響。
    const start = Date.UTC(2026, 2, 8, 6, 30);
    const clock = new FakeClock(start);
    const { c } = center({ clock });
    c.startTimer({ duration_s: 3600 });
    clock.advance(3600_000 - 1);
    expect(c.rings()).toEqual([]);
    clock.advance(1);
    expect(c.rings()[0]!.due_at).toBe(start + 3600_000);
    expect(new Date(c.rings()[0]!.due_at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })).toBe("03:30:00");
  });

  it("turning the feature off stops ringing (logged), hides timers and refuses changes; turning it back on keeps them", () => {
    const { c, clock } = center();
    c.startTimer({ duration_s: 5, label: "a" });
    c.startTimer({ duration_s: 600, label: "b" });
    clock.advance(5_000);
    c.updatePrefs({ enabled: false });
    expect(c.rings()).toEqual([]);
    expect(c.recentLog().at(-1)).toMatchObject({ outcome: "stopped", by: "settings" });
    expect(c.view("main")).toMatchObject({ timers: [], rings: [] });
    expect(c.startTimer({ duration_s: 5 })).toMatchObject({ ok: false, code: "disabled" });
    expect(c.awakeNeeded()).toBe(false);
    c.updatePrefs({ enabled: true });
    expect(c.view("main").timers.map((t) => t.label)).toEqual(["b"]);
    expect(c.awakeNeeded()).toBe(true);
  });

  it("a write failure during a scheduled check does not throw out of the timer; it logs and retries in 10 s", () => {
    const { c, clock, dir, logs } = center();
    c.startTimer({ duration_s: 5, label: "x" });
    // 暫存檔的位置被資料夾占住：寫檔一定失敗（root 也一樣）。
    mkdirSync(join(dir, "alarms.json.tmp"));
    expect(() => clock.advance(5_000)).not.toThrow();
    expect(c.rings()).toEqual([]);
    expect(logs.join("\n")).toMatch(/沒辦法保存/);
    rmSync(join(dir, "alarms.json.tmp"), { recursive: true });
    clock.advance(10_000);
    expect(c.rings()[0]).toMatchObject({ label: "x", late_ms: 10_000 });
  });

  it("extending past 24 hours in total is refused", () => {
    const { c } = center();
    c.startTimer({ duration_s: 86_000 });
    expect(c.extend(undefined, 1_000)).toMatchObject({ ok: false, code: "invalid" });
    expect(c.extend(undefined, 400)).toMatchObject({ ok: true });
  });

  it("clearAll removes timers, rings and the log but keeps settings", () => {
    const { c, clock, dir } = center();
    c.updatePrefs({ ring_s: 60 });
    c.startTimer({ duration_s: 5 });
    c.startTimer({ duration_s: 50 });
    clock.advance(5_000);
    c.clearAll();
    expect(c.view("main")).toMatchObject({ timers: [], rings: [], notice: null, prefs: { ring_s: 60 } });
    expect(JSON.parse(readFileSync(join(dir, "alarms.json"), "utf8"))).toMatchObject({ timers: [], rings: [], log: [], prefs: { ring_s: 60 } });
  });
});

describe("app.timer.* tools (built in; no NOUS_AIL)", () => {
  function ail(c: AlarmCenter): Integrations {
    return createIntegrations({ enabled: false, services: [], soloistPort: 19090 }, () => undefined, undefined, {}, [{ adapter: new TimerAdapter(c), enabled: () => c.enabled }])!;
  }

  it("are offered on both voice routes even with NOUS_AIL off, and disappear when the feature is turned off", () => {
    const { c } = center();
    const a = ail(c);
    const names = a.registry.functionSpecs("api_key").map((s) => s.name);
    expect(names).toEqual(["app__timer__cancel", "app__timer__extend", "app__timer__list", "app__timer__pause", "app__timer__resume", "app__timer__start", "app__timer__stop_ringing"]);
    expect(a.registry.functionSpecs("live").map((s) => s.name)).toEqual(names);
    expect(realtimeToolRules({ webSearch: false, mcp: [], home: false, integrations: (l) => a.registry.functionSpecs("live", l) }).join("\n")).toContain("app__timer__start");
    c.updatePrefs({ enabled: false });
    expect(a.registry.functionSpecs("live")).toEqual([]);
  });

  it("with NOUS_AIL off the integration layer is built-in only and the status panel lists no services", async () => {
    const { c } = center();
    const a = ail(c);
    expect(a.builtinOnly).toBe(true);
    expect(await a.status.view()).toEqual({ services: [] });
  });

  it("tells the live voice layer to hand off a timer request only when the timer tool is available", () => {
    const { c } = center();
    const a = ail(c);
    const caps = { mcp: [], integrations: () => a.registry.functionSpecs("live") };
    const instructions = buildLiveInstructions([], new Date(), caps);
    expect(instructions).toMatch(/計時一分鐘.*一律交辦/);
    expect(instructions).toContain("等核心回報成功才說已設定");
    c.updatePrefs({ enabled: false });
    expect(buildLiveInstructions([], new Date(), caps)).not.toContain("計時一分鐘");
  });

  it("start records the page that started the call; list reports remaining time; refused results carry candidates", async () => {
    const { c } = center();
    const a = ail(c);
    const start = await a.dispatcher.execute({ tool: "app__timer__start", args: '{"duration_s":180,"label":"泡麵"}', route: "live", actor: "agent", sessionId: "s", page: "rpi4" });
    expect(start).toMatchObject({ ok: true, status: "confirmed", message: "已開始「泡麵」3 分鐘的定時器。", data: { timer: { label: "泡麵", remaining_s: 180 } } });
    expect(c.view("rpi4").timers).toHaveLength(1);
    await a.dispatcher.execute({ tool: "app__timer__start", args: '{"duration_s":60}', route: "live", actor: "agent", sessionId: "s" });
    const list = await a.dispatcher.execute({ tool: "app__timer__list", args: "{}", route: "api_key", actor: "agent", sessionId: "s" });
    expect(list).toMatchObject({ status: "confirmed", data: { timers: [{ label: "泡麵", remaining: "3 分鐘" }, { label: null, remaining: "1 分鐘" }], ringing: 0 } });
    const pause = await a.dispatcher.execute({ tool: "app__timer__pause", args: "{}", route: "live", actor: "agent", sessionId: "s" });
    expect(pause).toMatchObject({ ok: false, status: "refused", data: { candidates: ["泡麵", expect.stringMatching(/^t_/)] } });
    expect(await a.dispatcher.execute({ tool: "app__timer__start", args: '{"duration_s":0}', route: "live", actor: "agent", sessionId: "s" })).toMatchObject({ status: "refused", reason: "invalid_arguments" });
  });

  it("stop_ringing stops what is ringing; reports honestly when nothing is", async () => {
    const { c, clock } = center();
    const a = ail(c);
    expect(await a.dispatcher.execute({ tool: "app__timer__stop_ringing", args: "{}", route: "live", actor: "agent", sessionId: "s" })).toMatchObject({ status: "confirmed", message: "現在沒有在響的定時器。" });
    c.startTimer({ duration_s: 1 });
    clock.advance(1_000);
    expect(await a.dispatcher.execute({ tool: "app__timer__stop_ringing", args: "{}", route: "live", actor: "agent", sessionId: "s" })).toMatchObject({ status: "confirmed", data: { stopped: 1 } });
    expect(c.recentLog().at(-1)).toMatchObject({ outcome: "stopped", by: "tool" });
  });

  it("live route: LiveToolCaller runs the timer in the core with the call's page", async () => {
    const { c } = center({ connected: new Set(["rpi4"]) });
    const a = ail(c);
    const turns: CodexTurn[] = [
      { text: "", calls: [{ call_id: "c1", name: "app__timer__start", arguments: '{"duration_s":600,"label":"麵"}' }], citations: [], model: "fixture", replay: [] },
      { text: "好，10 分鐘。", calls: [], citations: [], model: "fixture", replay: [] },
    ];
    const caller = new LiveToolCaller({
      responses: { turn: async () => turns.shift()! },
      caps: () => ({ webSearch: false, mcp: [], home: false, integrations: (l) => a.registry.functionSpecs("live", l) }),
      host: { outstanding: 0, call: async () => ({ ok: false }) },
      tasks: () => [],
      approval: () => ({ open: false, resolvedAt: null }),
      integrations: { dispatcher: a.dispatcher, sessionId: "s1", page: "rpi4" },
    });
    const result = await caller.run({ id: "d1", text: "計時 10 分鐘", source: "voice", transcript: [] }, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, text: "好，10 分鐘。", tools: [{ name: "app__timer__start", ok: true }] });
    expect(c.timers()).toMatchObject([{ label: "麵", state: "running" }]);
  });
});

describe("HTTP: api_key route forwarding, settings.alarms and /api/alarms/*", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  function fakeRoute(): RealtimeRoute {
    return {
      id: "api_key",
      readiness: () => ({ ready: true }),
      describe: () => ({ id: "api_key", available: true, reason: null, billing_line: billingLine("api_key", "m"), model: "m", voice: "cove", voices: [], tools: "", detail: "fixture" }),
      baseInfo: () => ({ available: true, model: "m", detail: "fixture" }),
      async connect(): Promise<RouteCall> {
        return { route: "api_key", answerSdp: "v=0 answer", model: "m", control: null, close: async () => {} };
      },
    };
  }

  async function app() {
    const { c, clock } = center({ connected: new Set(["rpi4"]) });
    const integrations = createIntegrations({ enabled: false, services: [], soloistPort: 19090 }, () => undefined, undefined, {}, [{ adapter: new TimerAdapter(c), enabled: () => c.enabled }])!;
    const store = new TaskStore(null);
    const dir = tmp();
    const auth = new ChatGPTAuth({ dir, callbackPort: 0, onChange: () => {} });
    const providers = new ProviderManager({ claude: null, chatgpt: new ChatGPTExecutor(auth, { model: null }), mock: new MockExecutor(1), auth, dir, preferred: "mock", onChange: () => {} });
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const server = createApp({ store, runner: new TaskRunner(store, providers), settings: providers, auth, chat: providers, realtimeRoutes: { api_key: fakeRoute() }, integrations, alarms: c, port, devPort: 5173, distDir: null });
    servers.push(server);
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://localhost:${port}`;
    const post = (path: string, body: unknown, terminal?: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(terminal ? { "X-Nous-Terminal": terminal } : {}) }, body: JSON.stringify(body) });
    const alarms = async (terminal?: string) => ((await (await fetch(`${base}/api/settings`, { headers: terminal ? { "X-Nous-Terminal": terminal } : {} })).json()) as { alarms: AlarmsView }).alarms;
    return { c, clock, post, alarms, base };
  }

  it("a timer started from the Pi's call rings on the Pi page only; stop and ack come back through /api/alarms", async () => {
    const a = await app();
    const start = (await (await a.post("/api/realtime/start", {}, "rpi4")).json()) as { session_id: string; owner: string };
    expect((await a.post("/api/realtime/call", { sdp: "v=0 offer", session_id: start.session_id, owner: start.owner }, "rpi4")).status).toBe(200);
    const res = await a.post("/api/integrations/call", { session_id: start.session_id, owner: start.owner, name: "app__timer__start", arguments: '{"duration_s":30,"label":"茶"}' }, "rpi4");
    expect(await res.json()).toMatchObject({ ok: true, status: "confirmed" });
    expect((await a.alarms("rpi4")).timers).toMatchObject([{ label: "茶", state: "running" }]);
    a.clock.advance(30_000);
    const pi = await a.alarms("rpi4");
    const mac = await a.alarms();
    expect(pi.rings).toMatchObject([{ label: "茶", here: true }]);
    expect(mac.rings).toMatchObject([{ label: "茶", here: false }]);
    expect((await a.post("/api/alarms/ack", { ring_id: pi.rings[0]!.id, playing: true }, "rpi4")).status).toBe(200);
    expect(a.c.rings()[0]!.heard_by).toEqual(["rpi4"]);
    const stopped = (await (await a.post("/api/alarms/stop", { by: "gesture" }, "rpi4")).json()) as { alarms: AlarmsView };
    expect(stopped.alarms.rings).toEqual([]);
    expect(a.c.recentLog().at(-1)).toMatchObject({ outcome: "stopped", by: "gesture", heard: true });
  });

  it("ALARM-3: a page connecting or leaving re-pushes settings so other pages' countdown (here) stays right", async () => {
    const a = await app();
    const base = a.base;
    const events = async (terminal: string | null, ctl: AbortController) => {
      const res = await fetch(`${base}/api/events${terminal ? `?terminal=${terminal}` : ""}`, { signal: ctl.signal });
      const reader = res.body!.getReader();
      const seen: string[] = [];
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            seen.push(new TextDecoder().decode(value));
          }
        } catch {
          // 中止
        }
      })();
      return seen;
    };
    const pi = new AbortController();
    const seen = await events("rpi4", pi);
    await new Promise((r) => setTimeout(r, 400));
    const before = seen.join("").split("settings.updated").length;
    const mac = new AbortController();
    await events(null, mac);
    await new Promise((r) => setTimeout(r, 500));
    expect(seen.join("").split("settings.updated").length).toBeGreaterThan(before);
    const mid = seen.join("").split("settings.updated").length;
    mac.abort();
    await new Promise((r) => setTimeout(r, 500));
    expect(seen.join("").split("settings.updated").length).toBeGreaterThan(mid);
    pi.abort();
  });

  it("settings: adding a one-off alarm keeps its date; a repeating one ignores it", async () => {
    const a = await app();
    expect((await a.post("/api/alarms/alarms/add", { time: "07:00", repeat: "once", date: "2030-01-02", label: "x" })).status).toBe(200);
    expect((await a.post("/api/alarms/alarms/add", { time: "07:00", repeat: "weekdays", date: "2030-01-02" })).status).toBe(200);
    expect(a.c.alarms().map((x) => [x.date, x.days.length])).toEqual([["2030-01-02", 0], [null, 5]]);
    expect((await a.post("/api/alarms/alarms/add", { time: "07:00", repeat: "custom" })).status).toBe(400);
  });

  it("settings: turn off and on, reject bad values, clear all", async () => {
    const a = await app();
    expect((await a.post("/api/settings/alarms", { ring_s: 5 })).status).toBe(400);
    expect((await a.post("/api/settings/alarms", { nope: 1 })).status).toBe(400);
    const off = (await (await a.post("/api/settings/alarms", { enabled: false })).json()) as { alarms: AlarmsView; integrations: { tools: string[] } };
    expect(off.alarms.prefs.enabled).toBe(false);
    expect(off.integrations.tools).toEqual([]);
    await a.post("/api/settings/alarms", { enabled: true });
    a.c.startTimer({ duration_s: 100 });
    const cancel = (await (await a.post("/api/alarms/timers/cancel", { id: a.c.timers()[0]!.id })).json()) as { alarms: AlarmsView };
    expect(cancel.alarms.timers).toEqual([]);
    a.c.startTimer({ duration_s: 100 });
    expect(((await (await a.post("/api/alarms/clear", {})).json()) as { alarms: AlarmsView }).alarms.timers).toEqual([]);
    expect((await a.post("/api/alarms/nope", {})).status).toBe(404);
  });
});

describe("page helpers", () => {
  it("stop words: only a whole sentence that means stop, in Chinese or English", () => {
    for (const s of ["停", "停止", "好了", "知道了", "關掉", "關掉鬧鐘", "別響了！", "Nous 停", "我起來了", "stop", "OK", "turn it off", "停止定時器"]) expect(matchRingStop(s), s).toBe(true);
    for (const s of ["", "停車場在哪裡", "幫我把燈關掉", "好了沒有啊我們要出門了", "stop the music please", "計時 3 分鐘"]) expect(matchRingStop(s), s).toBe(false);
  });

  it("countdown and spoken lengths", () => {
    expect(formatCountdown(179_001)).toBe("3:00");
    expect(formatCountdown(500)).toBe("0:01");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
    expect(spokenDuration(180_000)).toBe("3 分鐘");
    expect(spokenDuration(3_900_000)).toBe("1 小時 5 分鐘");
    expect(spokenDuration(45_000, "en")).toBe("45 seconds");
  });

  it("volume follows the device's conversation volume and fades up from 15% over the ramp", () => {
    expect(ringPeakVolume(60)).toBe(0.6);
    expect(ringPeakVolume(5)).toBe(0.1);
    expect(ringPeakVolume(20, 30)).toBe(0.3);
    expect(ringGainAt(0, 30, 0.6)).toBeCloseTo(0.09);
    expect(ringGainAt(15_000, 30, 0.6)).toBeCloseTo(0.345);
    expect(ringGainAt(60_000, 30, 0.6)).toBe(0.6);
    expect(ringGainAt(0, 0, 0.6)).toBe(0.6);
  });

  it("ringtone: a 2 s loop of four short beeps then silence, no clipping, starts and ends at zero", () => {
    const rate = 48_000;
    const s = ringCycleSamples(rate);
    expect(s.length).toBe(2 * rate);
    expect(Math.max(...s.map(Math.abs))).toBeLessThanOrEqual(0.5);
    expect(s[0]).toBe(0);
    const loud = (from: number, to: number) => s.slice(from * rate, to * rate).some((v) => Math.abs(v) > 0.1);
    expect([loud(0, 0.11), loud(0.2, 0.31), loud(0.4, 0.51), loud(0.6, 0.71)]).toEqual([true, true, true, true]);
    expect(loud(0.72, 2)).toBe(false);
  });

  it("the wake guard drops detections while a ring is playing (the ringtone never wakes Nous)", () => {
    let t = 0;
    const g = new WakeGuard(() => t);
    g.begin("alarm");
    expect(g.check()).toBe("alarm");
    g.end("alarm");
    t = 10;
    expect(g.check()).toBeNull();
  });
});
