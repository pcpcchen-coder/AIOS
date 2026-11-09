import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALARM_AWAKE_MS, ALARM_WRITE_PATH, cleanLabel, DEFAULT_ALARM_PREFS, MAX_ALARMS, MAX_TIMERS, parseAlarmPrefsPatch, RING_KINDS, RING_LOG_MAX, RING_OUTCOMES, SCHEDULER_MAX_SLEEP_MS, STOP_SOURCES,
  TIMER_MAX_S, TIMER_MIN_S,
  type AlarmPrefs, type AlarmPrefsPatch, type AlarmRecord, type AlarmsView, type AlarmView, type RingKind, type RingLogEntry, type RingOutcome, type RingRecord, type SnoozeRecord, type StopSource, type TimerRecord, type TimerView,
} from "../shared/alarm.ts";
import { formatClock, isLocalDate, nextDateFor, nextOccurrence, parseClock } from "../shared/alarm-schedule.ts";
import { systemTimeZone } from "./local-date.ts";

// ALARM-1（George 2026-11-09）：定時器與響鈴由核心保存與排程（configDir/alarms.json，只有這裡寫入）。
// - 排程只依「核心的時間」：每次最多睡 SCHEDULER_MAX_SLEEP_MS 就重新檢查，所以 Mac 睡眠後 setTimeout 晚到也會在醒來後
//   幾秒內發現；desktop/main.mjs 在 resume 時另外呼叫 tick()。晚了 late_ring_max_s 以內補響（記下晚了多久），超過只記錄錯過。
// - 重新啟動後讀回檔案再 tick()：到期的照上面的規則處理，還在響的鈴在自動停止時間之前繼續響。
// - 每個改變先寫檔才改記憶體（寫檔失敗丟錯，畫面與重新啟動後看到同一份）。
// ALARM-2：鬧鐘（牆上時鐘的時間，本機時區；單次或重複）與貪睡。鬧鐘響過：單次的自動關掉、重複的算下一次（從現在之後，
// 錯過很多次也只補一次）。錯過規則和定時器相同。時區改變（Mac 換時區）時重算每個鬧鐘的下一次。

const SCHEMA_VERSION = 2;
const NOTICE_MAX_AGE_MS = 12 * 3600_000;
const RETRY_MS = 10_000;

export interface SchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface AlarmCenterOptions {
  dir: string;
  clock?: SchedulerClock;
  /** 這個頁面來源現在有沒有連上（Mac 主視窗有 SSE；終端機另外要有新的心跳）。 */
  isConnected?(source: string): boolean;
  /** 狀態改變（推給畫面）。 */
  onChange?(): void;
  /** 開始響鈴（Mac App 用它發系統通知當備援）。 */
  onRingStart?(ring: RingRecord): void;
  /** Mac App：要不要阻止閒置睡眠改變時（有定時器在跑、正在響、貪睡中，或 12 小時內有鬧鐘）。 */
  onAwakeChange?(needed: boolean): void;
  /** 本機時區（預設系統時區，#96）。 */
  timeZone?(): string;
  log?(line: string): void;
  id?(): string;
}

interface Stored {
  schema_version: number;
  prefs: Partial<AlarmPrefs>;
  timers: TimerRecord[];
  alarms: AlarmRecord[];
  snoozes: SnoozeRecord[];
  rings: RingRecord[];
  log: RingLogEntry[];
  notice_cleared_at: number;
  /** 算 next_at 時用的時區；和現在不同就重算。 */
  time_zone: string | null;
}

export type AlarmRefError = { ok: false; code: "none" | "ambiguous" | "not_found"; message: string; candidates?: string[] };
export type AlarmOp = { ok: true; alarm: AlarmRecord } | AlarmRefError | { ok: false; code: "invalid" | "limit" | "disabled"; message: string };

export type TimerRefError = { ok: false; code: "none" | "ambiguous" | "not_found"; message: string; candidates?: string[] };
export type TimerOp<T = TimerRecord> = { ok: true; timer: T } | TimerRefError | { ok: false; code: "invalid" | "limit" | "disabled" | "state"; message: string };

export class AlarmCenter {
  private readonly path: string;
  private readonly clock: SchedulerClock;
  private state: Stored;
  private timer: unknown = null;
  private disposed = false;
  private awake = false;

  constructor(private readonly options: AlarmCenterOptions) {
    this.path = join(options.dir, "alarms.json");
    this.clock = options.clock ?? realClock;
    this.state = this.read();
    this.tick();
  }

  /** 算鬧鐘用的本機時區。 */
  timeZone(): string {
    return this.options.timeZone?.() ?? systemTimeZone();
  }

  /** 核心的時間（測試用假時鐘）。 */
  now(): number {
    return this.clock.now();
  }

  prefs(): AlarmPrefs {
    return { ...DEFAULT_ALARM_PREFS, ...this.state.prefs };
  }

  get enabled(): boolean {
    return this.prefs().enabled;
  }

  updatePrefs(patch: AlarmPrefsPatch): AlarmPrefs {
    const parsed = parseAlarmPrefsPatch(patch);
    const turningOff = parsed.enabled === false && this.enabled;
    const next: Stored = { ...this.state, prefs: { ...this.state.prefs, ...parsed } };
    if (turningOff) {
      // 關閉：正在響的停掉並記錄；定時器保留（重新打開後照常，晚了就照錯過規則）。
      const now = this.clock.now();
      next.log = this.appendLog(next.log, next.rings.map((r) => this.logEntry(r, "stopped", now, "settings")));
      next.rings = [];
    }
    this.commit(next);
    return this.prefs();
  }

  view(source: string): AlarmsView {
    const now = this.clock.now();
    const prefs = this.prefs();
    const notice = this.notice(now);
    return {
      prefs,
      server_now: now,
      timers: prefs.enabled ? this.state.timers.map(timerView) : [],
      alarms: this.state.alarms.map(alarmView),
      snoozes: prefs.enabled ? this.state.snoozes.map((z) => ({ id: z.id, label: z.label, due_at: z.due_at })) : [],
      rings: prefs.enabled
        ? this.state.rings.map((r) => ({
            id: r.id, kind: r.kind, alarm_id: r.alarm_id ?? null, label: r.label, due_at: r.due_at, started_at: r.started_at, late_ms: r.late_ms,
            here: r.targets === "all" || r.targets.includes(source), auto_stop_at: r.started_at + prefs.ring_s * 1000, heard_by: [...r.heard_by],
          }))
        : [],
      notice,
      time_zone: this.timeZone(),
      write_path: ALARM_WRITE_PATH,
    };
  }

  /** Mac App 要不要阻止系統閒置睡眠：有定時器在跑、正在響、貪睡中，或 12 小時內有鬧鐘。 */
  awakeNeeded(): boolean {
    const now = this.clock.now();
    return this.enabled && (this.state.rings.length > 0 || this.state.snoozes.length > 0 || this.state.timers.some((t) => t.state === "running")
      || this.state.alarms.some((a) => a.enabled && a.next_at !== null && a.next_at - now <= ALARM_AWAKE_MS));
  }

  alarms(): AlarmView[] {
    return this.state.alarms.map(alarmView);
  }

  /** 新增鬧鐘。time「07:00」；days 空＝單次（date 不給就是下一次的這個時間）。 */
  setAlarm(input: { time: unknown; days: number[]; date?: unknown; label?: unknown; origin?: string | null }): AlarmOp {
    if (!this.enabled) return { ok: false, code: "disabled", message: "鬧鐘與定時器已在設定關閉。" };
    const clock = parseClock(input.time);
    if (!clock) return { ok: false, code: "invalid", message: "時間要像 07:00（24 小時制）。" };
    if (this.state.alarms.length >= MAX_ALARMS) return { ok: false, code: "limit", message: `最多 ${MAX_ALARMS} 個鬧鐘。` };
    const now = this.clock.now();
    const tz = this.timeZone();
    let date: string | null = null;
    if (!input.days.length) {
      if (input.date !== undefined && input.date !== null && input.date !== "") {
        if (!isLocalDate(input.date)) return { ok: false, code: "invalid", message: "日期要像 2026-11-10。" };
        date = input.date;
      } else date = nextDateFor(clock.hour, clock.minute, now, tz);
    }
    const base = { hour: clock.hour, minute: clock.minute, days: [...input.days], date };
    const next_at = nextOccurrence(base, now, tz);
    if (next_at === null) return { ok: false, code: "invalid", message: "這個時間已經過了。" };
    const alarm: AlarmRecord = { id: this.newId("a"), label: cleanLabel(input.label), ...base, enabled: true, next_at, created_at: now, origin: input.origin ?? null };
    this.commit({ ...this.state, alarms: [...this.state.alarms, alarm], time_zone: tz });
    return { ok: true, alarm };
  }

  /** 開或關一個鬧鐘。打開單次鬧鐘時，日期已過就改成下一次的這個時間。 */
  setAlarmEnabled(ref: unknown, enabled: boolean): AlarmOp {
    if (!this.enabled) return { ok: false, code: "disabled", message: "鬧鐘與定時器已在設定關閉。" };
    const found = this.resolveAlarm(ref, enabled ? false : true);
    if (!found.ok) return found;
    const now = this.clock.now();
    const tz = this.timeZone();
    let next: AlarmRecord = { ...found.alarm, enabled, next_at: null };
    if (enabled) {
      const date = next.days.length ? null : (next.date && nextOccurrence(next, now, tz) !== null ? next.date : nextDateFor(next.hour, next.minute, now, tz));
      next = { ...next, date, next_at: nextOccurrence({ ...next, date }, now, tz) };
    }
    // 關掉時一併取消它的貪睡。
    const snoozes = enabled ? this.state.snoozes : this.state.snoozes.filter((z) => z.alarm_id !== next.id);
    this.commit({ ...this.state, alarms: this.state.alarms.map((a) => (a.id === next.id ? next : a)), snoozes, time_zone: tz });
    return { ok: true, alarm: next };
  }

  /** 刪除一個或全部鬧鐘（連同貪睡）。 */
  deleteAlarm(ref: unknown, all = false): { ok: true; deleted: AlarmView[] } | AlarmRefError | { ok: false; code: "disabled"; message: string } {
    if (!this.enabled) return { ok: false, code: "disabled", message: "鬧鐘與定時器已在設定關閉。" };
    if (all) {
      const deleted = this.state.alarms.map(alarmView);
      if (deleted.length || this.state.snoozes.length) this.commit({ ...this.state, alarms: [], snoozes: this.state.snoozes.filter((z) => z.alarm_id === null) });
      return { ok: true, deleted };
    }
    const found = this.resolveAlarm(ref, null);
    if (!found.ok) return found;
    this.commit({ ...this.state, alarms: this.state.alarms.filter((a) => a.id !== found.alarm.id), snoozes: this.state.snoozes.filter((z) => z.alarm_id !== found.alarm.id) });
    return { ok: true, deleted: [alarmView(found.alarm)] };
  }

  /**
   * 貪睡：正在響的鬧鐘停下來，snooze_s 秒後再響；同時在響的定時器一起停（定時器沒有貪睡）。回傳貪睡了幾個鬧鐘。
   */
  snoozeRings(by: StopSource): number {
    const rings = this.state.rings;
    const alarms = rings.filter((r) => r.kind === "alarm");
    if (!alarms.length) return 0;
    const now = this.clock.now();
    const due = now + this.prefs().snooze_s * 1000;
    const snoozes: SnoozeRecord[] = alarms.map((r) => ({ id: this.newId("z"), alarm_id: r.alarm_id ?? null, label: r.label, due_at: due, origin: r.targets === "all" ? null : (r.targets[0] ?? null) }));
    const log = rings.map((r) => this.logEntry(r, r.kind === "alarm" ? "snoozed" : "stopped", now, by));
    this.commit({ ...this.state, rings: [], snoozes: [...this.state.snoozes, ...snoozes], log: this.appendLog(this.state.log, log) });
    this.options.log?.(`鬧鐘／定時器：貪睡 ${alarms.length} 個鬧鐘，${Math.round(this.prefs().snooze_s / 60)} 分鐘後再響（${by}）`);
    return alarms.length;
  }

  /** 取消貪睡（「不用再叫我了」）。 */
  cancelSnoozes(): number {
    const n = this.state.snoozes.length;
    if (n) this.commit({ ...this.state, snoozes: [] });
    return n;
  }

  timers(): TimerView[] {
    return this.state.timers.map(timerView);
  }

  rings(): readonly RingRecord[] {
    return this.state.rings;
  }

  startTimer(input: { duration_s: number; label?: unknown; origin?: string | null }): TimerOp {
    if (!this.enabled) return { ok: false, code: "disabled", message: "鬧鐘與定時器已在設定關閉。" };
    const s = input.duration_s;
    if (!Number.isFinite(s) || s < TIMER_MIN_S || s > TIMER_MAX_S) return { ok: false, code: "invalid", message: `長度要在 ${TIMER_MIN_S} 秒到 24 小時之間。` };
    if (this.state.timers.length >= MAX_TIMERS) return { ok: false, code: "limit", message: `最多同時 ${MAX_TIMERS} 個定時器。` };
    const now = this.clock.now();
    const duration_ms = Math.round(s * 1000);
    const timer: TimerRecord = { id: this.newId("t"), label: cleanLabel(input.label), duration_ms, created_at: now, origin: input.origin ?? null, state: "running", ends_at: now + duration_ms };
    this.commit({ ...this.state, timers: [...this.state.timers, timer] });
    return { ok: true, timer };
  }

  pause(ref: unknown): TimerOp {
    return this.modify(ref, "running", (t, now) => (t.state === "running" ? { ...t, state: "paused", remaining_ms: Math.max(0, t.ends_at - now) } : t), "沒有在跑的定時器可以暫停。");
  }

  resume(ref: unknown): TimerOp {
    return this.modify(ref, "paused", (t, now) => (t.state === "paused" ? { ...stripState(t), state: "running", ends_at: now + t.remaining_ms } : t), "沒有暫停中的定時器。");
  }

  extend(ref: unknown, addS: number): TimerOp {
    if (!Number.isFinite(addS) || addS < TIMER_MIN_S || addS > TIMER_MAX_S) return { ok: false, code: "invalid", message: "延長的時間要在 1 秒到 24 小時之間。" };
    const add = Math.round(addS * 1000);
    const found = this.resolve(ref, null, "現在沒有定時器。");
    if (found.ok && found.timer.duration_ms + add > TIMER_MAX_S * 1000) return { ok: false, code: "invalid", message: "延長後會超過 24 小時。" };
    return this.modify(ref, null, (t) => (t.state === "running" ? { ...t, ends_at: t.ends_at + add, duration_ms: t.duration_ms + add } : { ...t, remaining_ms: t.remaining_ms + add, duration_ms: t.duration_ms + add }), "現在沒有定時器。");
  }

  /** 取消一個（ref）或全部（all）。回傳取消掉的定時器。 */
  cancel(ref: unknown, all = false): { ok: true; cancelled: TimerView[] } | TimerRefError | { ok: false; code: "disabled"; message: string } {
    if (!this.enabled) return { ok: false, code: "disabled", message: "鬧鐘與定時器已在設定關閉。" };
    if (all) {
      const cancelled = this.state.timers.map(timerView);
      if (cancelled.length) this.commit({ ...this.state, timers: [] });
      return { ok: true, cancelled };
    }
    const found = this.resolve(ref, null, "現在沒有定時器。");
    if (!found.ok) return found;
    this.commit({ ...this.state, timers: this.state.timers.filter((t) => t.id !== found.timer.id) });
    return { ok: true, cancelled: [timerView(found.timer)] };
  }

  /** 停止正在響的鈴（全部）。回傳停了幾個。 */
  stopRings(by: StopSource): number {
    const rings = this.state.rings;
    if (!rings.length) return 0;
    const now = this.clock.now();
    this.commit({ ...this.state, rings: [], log: this.appendLog(this.state.log, rings.map((r) => this.logEntry(r, "stopped", now, by))) });
    this.options.log?.(`鬧鐘／定時器：停止 ${rings.length} 個響鈴（${by}）`);
    return rings.length;
  }

  /** 頁面回報這個鈴真的在出聲（或沒辦法出聲）。只記錄，不影響排程。 */
  ack(ringId: string, source: string, playing: boolean, reason?: string): boolean {
    const ring = this.state.rings.find((r) => r.id === ringId);
    if (!ring) return false;
    if (!playing) {
      this.options.log?.(`鬧鐘／定時器：${source} 沒辦法出聲（${(reason ?? "unknown").slice(0, 80)}）`);
      return true;
    }
    if (ring.heard_by.includes(source)) return true;
    this.commit({ ...this.state, rings: this.state.rings.map((r) => (r.id === ringId ? { ...r, heard_by: [...r.heard_by, source] } : r)) });
    return true;
  }

  clearNotice(): void {
    this.commit({ ...this.state, notice_cleared_at: this.clock.now() });
  }

  /** 回退：清掉所有定時器、響鈴與紀錄（設定保留）。 */
  clearAll(): void {
    this.commit({ ...this.state, timers: [], alarms: [], snoozes: [], rings: [], log: [], notice_cleared_at: this.clock.now() });
  }

  recentLog(): readonly RingLogEntry[] {
    return this.state.log;
  }

  /** 檢查到期與自動停止，再排下一次檢查。Mac 醒來時由 App 呼叫；平常由自己的計時器呼叫。 */
  tick(): void {
    if (this.disposed) return;
    try {
      this.check();
    } catch (err) {
      // 寫檔失敗（磁碟滿、權限）：不讓排程或整個核心掛掉；狀態沒變，10 秒後再試（照實記 log，不假裝已開始響）。
      this.options.log?.(`鬧鐘／定時器：檢查到期時沒辦法保存（${(err as Error).message}），10 秒後再試`);
      if (this.timer !== null) this.clock.clearTimeout(this.timer);
      this.timer = this.clock.setTimeout(() => this.tick(), RETRY_MS);
      return;
    }
    this.schedule();
    this.syncAwake();
  }

  private check(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const now = this.clock.now();
    const prefs = this.prefs();
    if (prefs.enabled) {
      const tz = this.timeZone();
      // 時區改變（或舊檔沒有記時區）：重算每個開著的鬧鐘的下一次。
      let alarms = this.state.alarms;
      let tzChanged = false;
      if (this.state.time_zone !== tz && alarms.length) {
        alarms = alarms.map((a) => (a.enabled ? { ...a, next_at: nextOccurrence(a, now, tz) } : a));
        tzChanged = true;
        this.options.log?.(`鬧鐘／定時器：時區是 ${tz}，重算鬧鐘的下一次`);
      }
      const due = this.state.timers.filter((t) => t.state === "running" && t.ends_at <= now);
      const dueAlarms = alarms.filter((a) => a.enabled && a.next_at !== null && a.next_at <= now);
      const dueSnoozes = this.state.snoozes.filter((z) => z.due_at <= now);
      const expired = this.state.rings.filter((r) => r.started_at + prefs.ring_s * 1000 <= now);
      if (due.length || dueAlarms.length || dueSnoozes.length || expired.length || tzChanged) {
        const started: RingRecord[] = [];
        const log: RingLogEntry[] = expired.map((r) => this.logEntry(r, "auto_stopped", Math.min(now, r.started_at + prefs.ring_s * 1000)));
        const late = (kind: RingKind, label: string | null, dueAt: number, origin: string | null, alarmId: string | null) => {
          const lateMs = now - dueAt;
          if (lateMs > prefs.late_ring_max_s * 1000) {
            log.push({ at: now, kind, label, due_at: dueAt, outcome: "missed", late_ms: lateMs, heard: false });
            this.options.log?.(`鬧鐘／定時器：${label ?? (kind === "alarm" ? "鬧鐘" : "定時器")} 錯過了（晚了 ${Math.round(lateMs / 60000)} 分鐘，超過補響上限，不響）`);
            return;
          }
          started.push({ id: this.newId("r"), kind, alarm_id: alarmId, label, due_at: dueAt, started_at: now, late_ms: lateMs < 2000 ? 0 : lateMs, targets: this.targetsFor(origin), heard_by: [] });
        };
        for (const a of dueAlarms) late("alarm", a.label, a.next_at!, a.origin, a.id);
        for (const z of dueSnoozes) late("alarm", z.label, z.due_at, z.origin, z.alarm_id);
        const dueAlarmIds = new Set(dueAlarms.map((a) => a.id));
        // 響過的鬧鐘：單次的關掉；重複的算現在之後的下一次（錯過好幾次也只補一次）。
        alarms = alarms.map((a) => {
          if (!dueAlarmIds.has(a.id)) return a;
          if (!a.days.length) return { ...a, enabled: false, next_at: null };
          return { ...a, next_at: nextOccurrence(a, now, tz) };
        });
        const dueSnoozeIds = new Set(dueSnoozes.map((z) => z.id));
        for (const t of due) if (t.state === "running") late("timer", t.label, t.ends_at, t.origin, null);
        const dueIds = new Set(due.map((t) => t.id));
        this.commit({
          ...this.state,
          alarms,
          snoozes: this.state.snoozes.filter((z) => !dueSnoozeIds.has(z.id)),
          time_zone: tz,
          timers: this.state.timers.filter((t) => !dueIds.has(t.id)),
          rings: [...this.state.rings.filter((r) => !expired.includes(r)), ...started],
          log: this.appendLog(this.state.log, log),
        });
        for (const r of expired) this.options.log?.(`鬧鐘／定時器：${r.label ?? (r.kind === "alarm" ? "鬧鐘" : "定時器")} 響了 ${prefs.ring_s} 秒沒人停，自動停止${r.heard_by.length ? "" : "（沒有畫面回報真的出聲）"}`);
        for (const r of started) {
          this.options.log?.(`鬧鐘／定時器：${r.label ?? (r.kind === "alarm" ? "鬧鐘" : "定時器")} 時間到，開始響（${r.targets === "all" ? "全部畫面" : r.targets.join("、")}${r.late_ms ? `；晚了 ${Math.round(r.late_ms / 1000)} 秒` : ""}）`);
          this.options.onRingStart?.(r);
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- 內部 ----

  private schedule(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    const now = this.clock.now();
    const prefs = this.prefs();
    let next = now + SCHEDULER_MAX_SLEEP_MS;
    if (prefs.enabled) {
      for (const t of this.state.timers) if (t.state === "running") next = Math.min(next, t.ends_at);
      for (const r of this.state.rings) next = Math.min(next, r.started_at + prefs.ring_s * 1000);
      for (const a of this.state.alarms) if (a.enabled && a.next_at !== null) next = Math.min(next, a.next_at);
      for (const z of this.state.snoozes) next = Math.min(next, z.due_at);
    }
    this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, next - now));
  }

  /** 建立的那台在線就只在那台響；不在線（Pi 斷線）或不知道是誰建立的，每個畫面都響。 */
  private targetsFor(origin: string | null): string[] | "all" {
    if (!origin || !this.options.isConnected) return "all";
    return this.options.isConnected(origin) ? [origin] : "all";
  }

  private modify(ref: unknown, want: TimerRecord["state"] | null, change: (t: TimerRecord, now: number) => TimerRecord, emptyMessage: string): TimerOp {
    if (!this.enabled) return { ok: false, code: "disabled", message: "鬧鐘與定時器已在設定關閉。" };
    const found = this.resolve(ref, want, emptyMessage);
    if (!found.ok) return found;
    const now = this.clock.now();
    const next = change(found.timer, now);
    this.commit({ ...this.state, timers: this.state.timers.map((t) => (t.id === next.id ? next : t)) });
    return { ok: true, timer: next };
  }

  /**
   * 找定時器：ref 是 ID 或名字（完全相同優先，其次包含）。沒給 ref 時，符合狀態的只有一個才用它，
   * 多個要問使用者是哪一個（回傳候選名字）。
   */
  private resolve(ref: unknown, want: TimerRecord["state"] | null, emptyMessage: string): { ok: true; timer: TimerRecord } | TimerRefError {
    const pool = this.state.timers.filter((t) => want === null || t.state === want);
    if (!pool.length) return { ok: false, code: "none", message: emptyMessage };
    const text = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (!text) {
      if (pool.length === 1) return { ok: true, timer: pool[0]! };
      return { ok: false, code: "ambiguous", message: "有好幾個定時器，請說是哪一個。", candidates: pool.map(describe) };
    }
    const byId = pool.find((t) => t.id === text);
    if (byId) return { ok: true, timer: byId };
    const exact = pool.filter((t) => (t.label ?? "").toLowerCase() === text);
    const partial = exact.length ? exact : pool.filter((t) => t.label && (t.label.toLowerCase().includes(text) || text.includes(t.label.toLowerCase())));
    if (partial.length === 1) return { ok: true, timer: partial[0]! };
    if (partial.length > 1) return { ok: false, code: "ambiguous", message: "有好幾個定時器符合，請說是哪一個。", candidates: partial.map(describe) };
    return { ok: false, code: "not_found", message: `找不到叫「${String(ref).slice(0, 40)}」的定時器。`, candidates: pool.map(describe) };
  }

  /** 找鬧鐘：ID、名字（完全相同優先，其次包含）或時間（「07:00」「7:00」）。沒給 ref 時只有一個才用它。 */
  private resolveAlarm(ref: unknown, wantEnabled: boolean | null): { ok: true; alarm: AlarmRecord } | AlarmRefError {
    const pool = this.state.alarms.filter((a) => wantEnabled === null || a.enabled === wantEnabled);
    const describeAlarm = (a: AlarmRecord) => `${formatClock(a.hour, a.minute)}${a.label ? ` ${a.label}` : ""}`;
    if (!pool.length) return { ok: false, code: "none", message: wantEnabled === false ? "沒有關著的鬧鐘。" : wantEnabled ? "沒有開著的鬧鐘。" : "現在沒有鬧鐘。" };
    const text = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (!text) {
      if (pool.length === 1) return { ok: true, alarm: pool[0]! };
      return { ok: false, code: "ambiguous", message: "有好幾個鬧鐘，請說是哪一個。", candidates: pool.map(describeAlarm) };
    }
    const byId = pool.find((a) => a.id === text);
    if (byId) return { ok: true, alarm: byId };
    const clock = parseClock(text);
    const byTime = clock ? pool.filter((a) => a.hour === clock.hour && a.minute === clock.minute) : [];
    const exact = pool.filter((a) => (a.label ?? "").toLowerCase() === text);
    const partial = byTime.length ? byTime : exact.length ? exact : pool.filter((a) => a.label && (a.label.toLowerCase().includes(text) || text.includes(a.label.toLowerCase())));
    if (partial.length === 1) return { ok: true, alarm: partial[0]! };
    if (partial.length > 1) return { ok: false, code: "ambiguous", message: "有好幾個鬧鐘符合，請說是哪一個。", candidates: partial.map(describeAlarm) };
    return { ok: false, code: "not_found", message: `找不到「${String(ref).slice(0, 40)}」這個鬧鐘。`, candidates: pool.map(describeAlarm) };
  }

  private notice(now: number): RingLogEntry | null {
    for (let i = this.state.log.length - 1; i >= 0; i--) {
      const e = this.state.log[i]!;
      if (e.at <= this.state.notice_cleared_at || now - e.at > NOTICE_MAX_AGE_MS) return null;
      if (e.outcome === "auto_stopped" || e.outcome === "missed") return e;
    }
    return null;
  }

  private logEntry(r: RingRecord, outcome: RingOutcome, at: number, by?: StopSource): RingLogEntry {
    return { at, kind: r.kind, label: r.label, due_at: r.due_at, outcome, late_ms: r.late_ms, ...(by ? { by } : {}), heard: r.heard_by.length > 0 };
  }

  private appendLog(log: RingLogEntry[], add: RingLogEntry[]): RingLogEntry[] {
    if (!add.length) return log;
    return [...log, ...add].slice(-RING_LOG_MAX);
  }

  private newId(prefix: string): string {
    return `${prefix}_${(this.options.id ?? (() => randomBytes(5).toString("hex")))()}`;
  }

  private commit(next: Stored): void {
    this.write(next);
    this.state = next;
    if (!this.disposed) this.schedule();
    this.options.onChange?.();
    this.syncAwake();
  }

  /** 12 小時內有鬧鐘會隨時間改變，所以每次檢查與每個改變都重算一次。 */
  private syncAwake(): void {
    const needed = this.awakeNeeded();
    if (needed === this.awake) return;
    this.awake = needed;
    this.options.onAwakeChange?.(needed);
  }

  private read(): Stored {
    const empty: Stored = { schema_version: SCHEMA_VERSION, prefs: {}, timers: [], alarms: [], snoozes: [], rings: [], log: [], notice_cleared_at: 0, time_zone: null };
    if (!existsSync(this.path)) return empty;
    const log = this.options.log ?? console.warn;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") throw new Error("內容不是 JSON 物件");
      // ALARM-1 的檔案（版本 1）沒有鬧鐘與貪睡：照讀，下次寫入時升到版本 2。
      if (raw.schema_version !== SCHEMA_VERSION && raw.schema_version !== 1) throw new Error(`不支援的 schema_version：${String(raw.schema_version)}`);
      const prefs: Partial<AlarmPrefs> = {};
      for (const [k, v] of Object.entries((raw.prefs as Record<string, unknown>) ?? {})) {
        try {
          Object.assign(prefs, parseAlarmPrefsPatch({ [k]: v }));
        } catch (err) {
          log(`${this.path}：設定 ${k} 被忽略（${(err as Error).message}）`);
        }
      }
      const list = <T>(value: unknown, parse: (v: unknown) => T | null, what: string): T[] => {
        if (!Array.isArray(value)) return [];
        const out: T[] = [];
        for (const v of value) {
          const p = parse(v);
          if (p) out.push(p);
          else log(`${this.path}：一筆${what}讀不懂，略過`);
        }
        return out;
      };
      return {
        schema_version: SCHEMA_VERSION,
        prefs,
        timers: list(raw.timers, parseTimer, "定時器").slice(0, MAX_TIMERS),
        alarms: list(raw.alarms, parseAlarm, "鬧鐘").slice(0, MAX_ALARMS),
        snoozes: list(raw.snoozes, parseSnooze, "貪睡"),
        rings: list(raw.rings, parseRing, "響鈴"),
        log: list(raw.log, parseLog, "紀錄").slice(-RING_LOG_MAX),
        notice_cleared_at: typeof raw.notice_cleared_at === "number" && Number.isFinite(raw.notice_cleared_at) ? raw.notice_cleared_at : 0,
        time_zone: typeof raw.time_zone === "string" ? raw.time_zone.slice(0, 64) : null,
      };
    } catch (err) {
      log(`無法讀取 ${this.path}（${(err as Error).message}），定時器從空的開始；原檔留在 alarms.json.unreadable`);
      try {
        renameSync(this.path, `${this.path}.unreadable`);
      } catch {
        // 改名失敗：下次寫入會蓋掉
      }
      return empty;
    }
  }

  private write(data: Stored): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows 不支援 POSIX 權限
    }
  }
}

function stripState(t: TimerRecord): Omit<TimerRecord, "state" | "ends_at" | "remaining_ms"> {
  const { id, label, duration_ms, created_at, origin } = t;
  return { id, label, duration_ms, created_at, origin };
}

function timerView(t: TimerRecord): TimerView {
  return { id: t.id, label: t.label, state: t.state, duration_ms: t.duration_ms, ends_at: t.state === "running" ? t.ends_at : null, remaining_ms: t.state === "paused" ? t.remaining_ms : null };
}

function describe(t: TimerRecord): string {
  return t.label ?? t.id;
}

const ID = /^[a-z]_[a-z0-9]{1,32}$/;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";

function parseTimer(v: unknown): TimerRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !ID.test(o.id) || !num(o.duration_ms) || !num(o.created_at)) return null;
  const base = { id: o.id, label: cleanLabel(o.label), duration_ms: o.duration_ms, created_at: o.created_at, origin: str(o.origin) ? o.origin.slice(0, 32) : null };
  if (o.state === "running" && num(o.ends_at)) return { ...base, state: "running", ends_at: o.ends_at };
  if (o.state === "paused" && num(o.remaining_ms) && o.remaining_ms >= 0) return { ...base, state: "paused", remaining_ms: o.remaining_ms };
  return null;
}

function parseRing(v: unknown): RingRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !ID.test(o.id) || !(RING_KINDS as readonly unknown[]).includes(o.kind) || !num(o.due_at) || !num(o.started_at) || !num(o.late_ms)) return null;
  const targets = o.targets === "all" ? "all" : Array.isArray(o.targets) && o.targets.every(str) ? (o.targets as string[]).slice(0, 8) : null;
  if (!targets) return null;
  const heard = Array.isArray(o.heard_by) ? (o.heard_by.filter(str) as string[]).slice(0, 8) : [];
  return { id: o.id, kind: o.kind as RingKind, alarm_id: str(o.alarm_id) && ID.test(o.alarm_id) ? o.alarm_id : null, label: cleanLabel(o.label), due_at: o.due_at, started_at: o.started_at, late_ms: o.late_ms, targets, heard_by: heard };
}

function parseLog(v: unknown): RingLogEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!num(o.at) || !(RING_KINDS as readonly unknown[]).includes(o.kind) || !num(o.due_at) || !num(o.late_ms) || !(RING_OUTCOMES as readonly unknown[]).includes(o.outcome)) return null;
  const by = (STOP_SOURCES as readonly unknown[]).includes(o.by) ? (o.by as StopSource) : undefined;
  return { at: o.at, kind: o.kind as RingKind, label: cleanLabel(o.label), due_at: o.due_at, outcome: o.outcome as RingOutcome, late_ms: o.late_ms, ...(by ? { by } : {}), heard: o.heard === true };
}

function alarmView(a: AlarmRecord): AlarmView {
  return { id: a.id, label: a.label, time: formatClock(a.hour, a.minute), days: [...a.days], date: a.date, enabled: a.enabled, next_at: a.next_at };
}

function parseAlarm(v: unknown): AlarmRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !ID.test(o.id) || !num(o.hour) || !num(o.minute) || !num(o.created_at) || typeof o.enabled !== "boolean") return null;
  if (!Number.isInteger(o.hour) || o.hour < 0 || o.hour > 23 || !Number.isInteger(o.minute) || o.minute < 0 || o.minute > 59) return null;
  if (!Array.isArray(o.days) || !o.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) return null;
  const days = [...new Set(o.days as number[])].sort((a, b) => a - b);
  const date = isLocalDate(o.date) ? o.date : null;
  if (!days.length && !date) return null;
  return { id: o.id, label: cleanLabel(o.label), hour: o.hour, minute: o.minute, days, date: days.length ? null : date, enabled: o.enabled, next_at: num(o.next_at) ? o.next_at : null, created_at: o.created_at, origin: str(o.origin) ? o.origin.slice(0, 32) : null };
}

function parseSnooze(v: unknown): SnoozeRecord | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !ID.test(o.id) || !num(o.due_at)) return null;
  return { id: o.id, alarm_id: str(o.alarm_id) && ID.test(o.alarm_id) ? o.alarm_id : null, label: cleanLabel(o.label), due_at: o.due_at, origin: str(o.origin) ? o.origin.slice(0, 32) : null };
}
