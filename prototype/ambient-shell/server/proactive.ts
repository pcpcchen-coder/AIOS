import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locale } from "../shared/i18n.mjs";
import {
  briefingKeys,
  CALENDAR_ASK,
  CALENDAR_EMPTY,
  joinBriefing,
  type TodayEvent,
  defaultPlaceFor,
  DEFAULT_PROACTIVE_PREFS,
  inWindow,
  parseProactivePatch,
  ProactivePatchError,
  PROACTIVE_PREF_KEYS,
  WEATHER_ATTRIBUTION,
  END_HOUR_OPTIONS,
  START_HOUR_OPTIONS,
  WEATHER_PLACES,
  weatherPlace,
  weatherSentence,
  type ProactivePrefs,
  type ProactivePrefsPatch,
  type ProactiveSettingsView,
  type WeatherPlaceId,
} from "../shared/proactive.ts";
import { localHour } from "../shared/sense.ts";
import { localToday, systemTimeZone } from "./local-date.ts";
import { PrefsStore } from "./prefs-store.ts";
import { chunkForAppend } from "../shared/frameless.ts";

/** ChatGPT 方案路徑的整段招呼放得進一段 session.context.append（「（開場）」標記只在第一段）。 */
export function fitsLiveAppend(text: string): boolean {
  return chunkForAppend(text).length === 1;
}
import type { WeatherService } from "./weather.ts";
import { CalendarAsk, CalendarToday, type CalendarReader, type CallFollowUp } from "./proactive-calendar.ts";

// PRO-1（George 2026-11-05）：主動提醒（招呼後接今天的天氣）。
// - 設定：configDir/proactive.json（只有 ProactiveSettingsStore 寫入）。
// - 每日紀錄：configDir/proactive-log.json，只有今天的日期和誰已經說過（person:<id> 或 device），不存天氣內容；換日整份換掉。
// - 核心決定要說什麼（shared/proactive.ts 的模板＋快取裡的資料），模型只照念。天氣不在快取裡（查不到、還沒查好）就這次不說、
//   也不記成已說，下一次招呼再試。

export class ProactiveSettingsStore extends PrefsStore<ProactivePrefs> {
  constructor(options: { dir: string; onChange(): void; log?(message: string): void }) {
    // 讀不懂時退回預設（主動說天氣沒有隱私疑慮；總開關仍可關）。
    super({ name: "proactive.json", parse: parseProactivePatch, failClosed: {}, unreadable: "主動提醒用預設值" }, options);
  }

  view(): ProactivePrefs {
    const prefs = this.resolve(PROACTIVE_PREF_KEYS, DEFAULT_PROACTIVE_PREFS);
    // 檔案被手改成開始 ≥ 結束：時段退回預設（不猜使用者的意思）。
    if (prefs.start_hour >= prefs.end_hour) return { ...prefs, start_hour: DEFAULT_PROACTIVE_PREFS.start_hour, end_hour: DEFAULT_PROACTIVE_PREFS.end_hour };
    return prefs;
  }

  /** 先驗證合併後的時段，再寫檔；失敗丟錯、記憶體不變。 */
  update(patch: ProactivePrefsPatch): ProactivePrefs {
    const next = { ...this.view(), ...patch };
    if (next.start_hour >= next.end_hour) throw new ProactivePatchError("時段的開始要早於結束");
    this.commit(patch);
    return this.view();
  }
}

/** 今天已經主動說過的對象（只有日期與鍵）。 */
export class ProactiveDailyLog {
  readonly path: string;
  private date: string | null = null;
  private keys = new Set<string>();

  constructor(private readonly options: { dir: string; log?(message: string): void }) {
    this.path = join(options.dir, "proactive-log.json");
    this.read();
  }

  done(today: string): ReadonlySet<string> {
    return this.date === today ? this.keys : new Set();
  }

  /** 記下今天說過的鍵；寫檔失敗只記 log（下次重啟可能多說一次天氣，不影響招呼）。 */
  mark(today: string, keys: readonly string[]): void {
    if (this.date !== today) {
      this.date = today;
      this.keys = new Set();
    }
    for (const k of keys) this.keys.add(k);
    try {
      mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ schema_version: 1, date: today, keys: [...this.keys] }), { mode: 0o600 });
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
    } catch (err) {
      this.options.log?.(`主動提醒：每日紀錄沒有寫入（${(err as Error).message}）`);
    }
  }

  private read(): void {
    if (!existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { schema_version?: unknown; date?: unknown; keys?: unknown };
      if (data.schema_version !== 1 || typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Array.isArray(data.keys)) throw new Error("格式不對");
      this.date = data.date;
      this.keys = new Set(data.keys.filter((k): k is string => typeof k === "string" && /^(device|(person|calendar):fam_[0-9a-f]{24})$/.test(k)));
    } catch (err) {
      this.options.log?.(`主動提醒：每日紀錄讀不懂（${(err as Error).message}），當成今天還沒說過`);
    }
  }
}

/** 組好、還沒送出的主動提醒。 */
export interface PendingBriefing {
  sentence: string;
  today: string;
  keys: readonly string[];
  person: boolean;
  /** 說了哪幾段（只給 log）。 */
  parts: readonly ("weather" | "calendar_ask" | "calendar_empty")[];
  locale: Locale;
  /** PRO-2：問了「要不要我念今天的行程？」：送出後要聽回答（行程只在記憶體裡）。 */
  ask: { events: readonly TodayEvent[] } | null;
  /** 組成的各段（fitBriefing 放不下時拿掉其中一段）。 */
  segments: readonly Segment[];
}

interface Segment {
  part: PendingBriefing["parts"][number];
  text: string;
  keys: readonly string[];
  ask?: { events: readonly TodayEvent[] };
}

function assemble(segments: readonly Segment[], base: Pick<PendingBriefing, "today" | "person" | "locale">): PendingBriefing | null {
  const sentence = joinBriefing(segments.map((x) => x.text), base.locale);
  if (!sentence) return null;
  return { ...base, sentence, keys: [...new Set(segments.flatMap((x) => x.keys))], parts: segments.map((x) => x.part), ask: segments.find((x) => x.ask)?.ask ?? null, segments };
}

/**
 * 整段放不下時（例如 ChatGPT 方案一段 append 500 bytes）依序試：全部、拿掉天氣、拿掉行程；都放不下回 null。
 * 拿掉的那段不記成說過。
 */
export function fitBriefing(b: PendingBriefing, fits: (sentence: string) => boolean): PendingBriefing | null {
  if (fits(b.sentence)) return b;
  for (const drop of ["weather", "calendar"] as const) {
    const rest = b.segments.filter((x) => (drop === "weather" ? x.part !== "weather" : x.part === "weather"));
    if (rest.length === b.segments.length || !rest.length) continue;
    const next = assemble(rest, b);
    if (next && fits(next.sentence)) return next;
  }
  return null;
}

/** 這次問候的對象：認出並稱名的家人（personId、name），以及這條路徑的核心聽不聽得到回答（listens）。 */
export interface BriefingSubject {
  personId: string | null;
  name?: string | null;
  listens?: boolean;
}

/** 招呼決策用到的方法（IdentityService、live 保底）。 */
export interface BriefingPort {
  compose(subject: BriefingSubject | string | null, locale: Locale): PendingBriefing | null;
  /** 問候真的送出：記下今天說過；有行程問句時開始聽這通的回答（sessionId 是這通工作階段；spoken 是整段招呼）。 */
  commit(b: PendingBriefing, call?: { sessionId: string; spoken: string }): void;
}

export interface ProactiveBriefingOptions {
  settings: { view(): ProactivePrefs };
  log: ProactiveDailyLog;
  weather: WeatherService;
  /** PRO-2：讀今天的行程（CAL-1）；沒有設定 google_calendar 時為 null。 */
  calendar?: CalendarReader | null;
  /** PRO-2：行事曆擁有者的家人名稱（認出這位才問行程；George 2026-11-05：George）。 */
  calendarOwner?: string;
  now?: () => number;
  /** 未指定時用這台電腦的時區（同招呼的時段）。 */
  timeZone?: string;
  logLine?: (line: string) => void;
}

export const DEFAULT_CALENDAR_OWNER = "George";
const ASKS_KEEP = 8;

export class ProactiveBriefing implements BriefingPort {
  private readonly now: () => number;
  readonly calendar: CalendarToday;
  private readonly asks = new Map<string, CalendarAsk>();

  constructor(private readonly options: ProactiveBriefingOptions) {
    this.now = options.now ?? Date.now;
    this.calendar = new CalendarToday({ read: options.calendar ?? null, now: this.now, today: () => localToday(new Date(this.now()), this.timeZone()), log: options.logLine });
  }

  private timeZone(): string {
    return this.options.timeZone ?? systemTimeZone();
  }

  /** 實際使用的地點：選的，或依系統時區推的。 */
  place(prefs: ProactivePrefs = this.options.settings.view()): { id: WeatherPlaceId; auto: boolean } | null {
    if (prefs.place) return { id: prefs.place, auto: false };
    const auto = defaultPlaceFor(this.timeZone());
    return auto ? { id: auto, auto: true } : null;
  }

  private inWindowNow(prefs: ProactivePrefs, aheadMs = 0): boolean {
    return inWindow(localHour(this.now() + aheadMs, this.options.timeZone), prefs);
  }

  private isOwner(name: string | null | undefined): boolean {
    const owner = (this.options.calendarOwner ?? DEFAULT_CALENDAR_OWNER).trim().toLowerCase();
    return !!name && !!owner && name.trim().toLowerCase() === owner;
  }

  /**
   * 招呼前預先取天氣與行程（看著說話或喚醒開始時）：在時段內（或開始前 30 分鐘）、開關開著才查。不等結果。
   */
  prefetch(): void {
    const prefs = this.options.settings.view();
    if (!prefs.enabled || (!this.inWindowNow(prefs) && !this.inWindowNow(prefs, 30 * 60_000))) return;
    const place = prefs.weather ? this.place(prefs) : null;
    if (place) void this.options.weather.refresh(place.id);
    if (prefs.calendar && this.calendar.connected) void this.calendar.refresh();
  }

  /**
   * 招呼句後面要接的話（確定性的模板），或 null：天氣（每人每天一次）、PRO-2 行程（只有行程擁有者：有行程問一句、
   * 沒有行程直接說「今天沒有排行程」；每天一次）。這裡不記紀錄：真的送出時呼叫 commit。資料不在快取裡時順便再查一次。
   */
  compose(subject: BriefingSubject | string | null, locale: Locale): PendingBriefing | null {
    const who: BriefingSubject = typeof subject === "object" && subject !== null ? subject : { personId: subject };
    const personId = who.personId;
    const prefs = this.options.settings.view();
    if (!prefs.enabled || !this.inWindowNow(prefs)) return null;
    const today = localToday(new Date(this.now()), this.timeZone());
    const done = this.options.log.done(today);
    const segments: Segment[] = [];
    const place = prefs.weather ? this.place(prefs) : null;
    const weatherKeys = place ? briefingKeys(personId, done) : null;
    if (place && weatherKeys) {
      const weather = this.options.weather.current(place.id);
      if (weather) segments.push({ part: "weather", text: weatherSentence(weather, locale), keys: weatherKeys });
      else {
        void this.options.weather.refresh(place.id);
        this.options.logLine?.("主動提醒：天氣還沒取到，這次不說天氣");
      }
    }
    const calKey = personId ? `calendar:${personId}` : null;
    if (prefs.calendar && calKey && this.isOwner(who.name) && this.calendar.connected && !done.has(calKey)) {
      const events = this.calendar.current();
      if (events === null) {
        void this.calendar.refresh();
        this.options.logLine?.("主動提醒：行程還沒讀到，這次不提行程");
      } else if (events.length === 0) {
        segments.push({ part: "calendar_empty", text: locale === "en" ? CALENDAR_EMPTY.en : CALENDAR_EMPTY.zh, keys: [calKey] });
      } else if (who.listens === true) {
        segments.push({ part: "calendar_ask", text: locale === "en" ? CALENDAR_ASK.en : CALENDAR_ASK.zh, keys: [calKey], ask: { events } });
      } else {
        this.options.logLine?.("主動提醒：這通的核心聽不到回答（API key 路徑沒有旁路），不問行程");
      }
    }
    return assemble(segments, { today, person: personId !== null, locale });
  }

  commit(b: PendingBriefing, call?: { sessionId: string; spoken: string }): void {
    this.options.log.mark(b.today, b.keys);
    this.options.logLine?.(`主動提醒：招呼後接 ${b.parts.join("＋")}（${b.person ? "認出的家人" : "這台裝置"}）`);
    if (!b.ask || !call) return;
    this.asks.set(call.sessionId, new CalendarAsk({ greeting: call.spoken, events: b.ask.events, locale: b.locale, startedAt: this.now(), log: this.options.logLine }));
    while (this.asks.size > ASKS_KEEP) this.asks.delete(this.asks.keys().next().value!);
  }

  /** 這通還在等行程回答的對話（LiveCall、ApiKeyCall 把語音事件交給它）；沒有回 null。 */
  followUp(sessionId: string): CallFollowUp | null {
    const ask = this.asks.get(sessionId);
    if (!ask) return null;
    if (!ask.open(this.now())) {
      this.asks.delete(sessionId);
      return null;
    }
    return ask;
  }

  view(): ProactiveSettingsView {
    const prefs = this.options.settings.view();
    const place = this.place(prefs);

    return {
      prefs,
      place: place ? { ...place, label: weatherPlace(place.id)!.zh } : null,
      places: WEATHER_PLACES.map((p) => ({ id: p.id, label: p.zh })),
      start_hours: START_HOUR_OPTIONS,
      end_hours: END_HOUR_OPTIONS,
      weather: place ? this.options.weather.status(place.id) : { state: "no_place", at: null },
      calendar: { state: this.calendar.state() },
      attribution: WEATHER_ATTRIBUTION,
      write_path: "/api/settings/proactive",
    };
  }
}
