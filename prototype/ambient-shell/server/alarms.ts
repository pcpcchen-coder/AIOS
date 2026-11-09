import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALARM_WRITE_PATH, cleanLabel, DEFAULT_ALARM_PREFS, MAX_TIMERS, parseAlarmPrefsPatch, RING_LOG_MAX, RING_OUTCOMES, SCHEDULER_MAX_SLEEP_MS, STOP_SOURCES,
  TIMER_MAX_S, TIMER_MIN_S,
  type AlarmPrefs, type AlarmPrefsPatch, type AlarmsView, type RingLogEntry, type RingOutcome, type RingRecord, type StopSource, type TimerRecord, type TimerView,
} from "../shared/alarm.ts";

// ALARM-1（George 2026-11-09）：定時器與響鈴由核心保存與排程（configDir/alarms.json，只有這裡寫入）。
// - 排程只依「核心的時間」：每次最多睡 SCHEDULER_MAX_SLEEP_MS 就重新檢查，所以 Mac 睡眠後 setTimeout 晚到也會在醒來後
//   幾秒內發現；desktop/main.mjs 在 resume 時另外呼叫 tick()。晚了 late_ring_max_s 以內補響（記下晚了多久），超過只記錄錯過。
// - 重新啟動後讀回檔案再 tick()：到期的照上面的規則處理，還在響的鈴在自動停止時間之前繼續響。
// - 每個改變先寫檔才改記憶體（寫檔失敗丟錯，畫面與重新啟動後看到同一份）。

const SCHEMA_VERSION = 1;
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
  log?(line: string): void;
  id?(): string;
}

interface Stored {
  schema_version: number;
  prefs: Partial<AlarmPrefs>;
  timers: TimerRecord[];
  rings: RingRecord[];
  log: RingLogEntry[];
  notice_cleared_at: number;
}

export type TimerRefError = { ok: false; code: "none" | "ambiguous" | "not_found"; message: string; candidates?: string[] };
export type TimerOp<T = TimerRecord> = { ok: true; timer: T } | TimerRefError | { ok: false; code: "invalid" | "limit" | "disabled" | "state"; message: string };

export class AlarmCenter {
  private readonly path: string;
  private readonly clock: SchedulerClock;
  private state: Stored;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly options: AlarmCenterOptions) {
    this.path = join(options.dir, "alarms.json");
    this.clock = options.clock ?? realClock;
    this.state = this.read();
    this.tick();
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
      rings: prefs.enabled
        ? this.state.rings.map((r) => ({
            id: r.id, kind: r.kind, label: r.label, due_at: r.due_at, started_at: r.started_at, late_ms: r.late_ms,
            here: r.targets === "all" || r.targets.includes(source), auto_stop_at: r.started_at + prefs.ring_s * 1000, heard_by: [...r.heard_by],
          }))
        : [],
      notice,
      write_path: ALARM_WRITE_PATH,
    };
  }

  /** Mac App 要不要阻止系統閒置睡眠：有定時器在跑或正在響。 */
  awakeNeeded(): boolean {
    return this.enabled && (this.state.rings.length > 0 || this.state.timers.some((t) => t.state === "running"));
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
    this.commit({ ...this.state, timers: [], rings: [], log: [], notice_cleared_at: this.clock.now() });
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
  }

  private check(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const now = this.clock.now();
    const prefs = this.prefs();
    if (prefs.enabled) {
      const due = this.state.timers.filter((t) => t.state === "running" && t.ends_at <= now);
      const expired = this.state.rings.filter((r) => r.started_at + prefs.ring_s * 1000 <= now);
      if (due.length || expired.length) {
        const started: RingRecord[] = [];
        const log: RingLogEntry[] = expired.map((r) => this.logEntry(r, "auto_stopped", Math.min(now, r.started_at + prefs.ring_s * 1000)));
        for (const t of due) {
          if (t.state !== "running") continue;
          const late = now - t.ends_at;
          if (late > prefs.late_ring_max_s * 1000) {
            log.push({ at: now, kind: "timer", label: t.label, due_at: t.ends_at, outcome: "missed", late_ms: late, heard: false });
            this.options.log?.(`鬧鐘／定時器：${t.label ?? "定時器"} 錯過了（晚了 ${Math.round(late / 60000)} 分鐘，超過補響上限，不響）`);
            continue;
          }
          started.push({ id: this.newId("r"), kind: "timer", label: t.label, due_at: t.ends_at, started_at: now, late_ms: late < 2000 ? 0 : late, targets: this.targetsFor(t.origin), heard_by: [] });
        }
        const dueIds = new Set(due.map((t) => t.id));
        this.commit({
          ...this.state,
          timers: this.state.timers.filter((t) => !dueIds.has(t.id)),
          rings: [...this.state.rings.filter((r) => !expired.includes(r)), ...started],
          log: this.appendLog(this.state.log, log),
        });
        for (const r of expired) this.options.log?.(`鬧鐘／定時器：${r.label ?? "定時器"} 響了 ${prefs.ring_s} 秒沒人停，自動停止${r.heard_by.length ? "" : "（沒有畫面回報真的出聲）"}`);
        for (const r of started) {
          this.options.log?.(`鬧鐘／定時器：${r.label ?? "定時器"} 時間到，開始響（${r.targets === "all" ? "全部畫面" : r.targets.join("、")}${r.late_ms ? `；晚了 ${Math.round(r.late_ms / 1000)} 秒` : ""}）`);
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
  }

  private read(): Stored {
    const empty: Stored = { schema_version: SCHEMA_VERSION, prefs: {}, timers: [], rings: [], log: [], notice_cleared_at: 0 };
    if (!existsSync(this.path)) return empty;
    const log = this.options.log ?? console.warn;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") throw new Error("內容不是 JSON 物件");
      if (raw.schema_version !== SCHEMA_VERSION) throw new Error(`不支援的 schema_version：${String(raw.schema_version)}`);
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
        rings: list(raw.rings, parseRing, "響鈴"),
        log: list(raw.log, parseLog, "紀錄").slice(-RING_LOG_MAX),
        notice_cleared_at: typeof raw.notice_cleared_at === "number" && Number.isFinite(raw.notice_cleared_at) ? raw.notice_cleared_at : 0,
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
  if (!str(o.id) || !ID.test(o.id) || o.kind !== "timer" || !num(o.due_at) || !num(o.started_at) || !num(o.late_ms)) return null;
  const targets = o.targets === "all" ? "all" : Array.isArray(o.targets) && o.targets.every(str) ? (o.targets as string[]).slice(0, 8) : null;
  if (!targets) return null;
  const heard = Array.isArray(o.heard_by) ? (o.heard_by.filter(str) as string[]).slice(0, 8) : [];
  return { id: o.id, kind: "timer", label: cleanLabel(o.label), due_at: o.due_at, started_at: o.started_at, late_ms: o.late_ms, targets, heard_by: heard };
}

function parseLog(v: unknown): RingLogEntry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!num(o.at) || o.kind !== "timer" || !num(o.due_at) || !num(o.late_ms) || !(RING_OUTCOMES as readonly unknown[]).includes(o.outcome)) return null;
  const by = (STOP_SOURCES as readonly unknown[]).includes(o.by) ? (o.by as StopSource) : undefined;
  return { at: o.at, kind: "timer", label: cleanLabel(o.label), due_at: o.due_at, outcome: o.outcome as RingOutcome, late_ms: o.late_ms, ...(by ? { by } : {}), heard: o.heard === true };
}
