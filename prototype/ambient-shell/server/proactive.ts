import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locale } from "../shared/i18n.mjs";
import {
  briefingKeys,
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
import { PrefsFile } from "./prefs-file.ts";
import { chunkForAppend } from "../shared/frameless.ts";

/** ChatGPT 方案路徑的整段招呼放得進一段 session.context.append（「（開場）」標記只在第一段）。 */
export function fitsLiveAppend(text: string): boolean {
  return chunkForAppend(text).length === 1;
}
import type { WeatherService } from "./weather.ts";

// PRO-1（George 2026-11-05）：主動提醒（招呼後接今天的天氣）。
// - 設定：configDir/proactive.json（只有 ProactiveSettingsStore 寫入）。
// - 每日紀錄：configDir/proactive-log.json，只有今天的日期和誰已經說過（person:<id> 或 device），不存天氣內容；換日整份換掉。
// - 核心決定要說什麼（shared/proactive.ts 的模板＋快取裡的資料），模型只照念。天氣不在快取裡（查不到、還沒查好）就這次不說、
//   也不記成已說，下一次招呼再試。

export class ProactiveSettingsStore {
  private readonly file: PrefsFile<ProactivePrefs>;

  constructor(private readonly options: { dir: string; onChange(): void; log?(message: string): void }) {
    this.file = new PrefsFile<ProactivePrefs>({
      dir: options.dir,
      name: "proactive.json",
      version: 1,
      parse: parseProactivePatch,
      // 讀不懂時退回預設（主動說天氣沒有隱私疑慮；總開關仍可關）。
      failClosed: {},
      unreadable: "主動提醒用預設值",
      log: options.log,
    });
  }

  view(): ProactivePrefs {
    const saved = this.file.saved;
    const prefs = Object.fromEntries(PROACTIVE_PREF_KEYS.map((key) => [key, saved[key] ?? DEFAULT_PROACTIVE_PREFS[key]])) as unknown as ProactivePrefs;
    // 檔案被手改成開始 ≥ 結束：時段退回預設（不猜使用者的意思）。
    if (prefs.start_hour >= prefs.end_hour) return { ...prefs, start_hour: DEFAULT_PROACTIVE_PREFS.start_hour, end_hour: DEFAULT_PROACTIVE_PREFS.end_hour };
    return prefs;
  }

  /** 先驗證合併後的時段，再寫檔；失敗丟錯、記憶體不變。 */
  update(patch: ProactivePrefsPatch): ProactivePrefs {
    const next = { ...this.view(), ...patch };
    if (next.start_hour >= next.end_hour) throw new ProactivePatchError("時段的開始要早於結束");
    this.file.update(patch);
    this.options.onChange();
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
      this.keys = new Set(data.keys.filter((k): k is string => typeof k === "string" && /^(device|person:fam_[0-9a-f]{24})$/.test(k)));
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
}

/** 招呼決策用到的兩個方法（IdentityService、live 保底）。 */
export interface BriefingPort {
  compose(personId: string | null, locale: Locale): PendingBriefing | null;
  commit(b: PendingBriefing): void;
}

export interface ProactiveBriefingOptions {
  settings: { view(): ProactivePrefs };
  log: ProactiveDailyLog;
  weather: WeatherService;
  now?: () => number;
  /** 未指定時用這台電腦的時區（同招呼的時段）。 */
  timeZone?: string;
  logLine?: (line: string) => void;
}

export class ProactiveBriefing implements BriefingPort {
  private readonly now: () => number;

  constructor(private readonly options: ProactiveBriefingOptions) {
    this.now = options.now ?? Date.now;
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

  private active(prefs: ProactivePrefs): boolean {
    return prefs.enabled && prefs.weather && inWindow(localHour(this.now(), this.options.timeZone), prefs);
  }

  /**
   * 招呼前預先取天氣（看著說話或喚醒開始時、核心啟動時）：在時段內、開關開著、有地點才查。不等結果。
   * 時段開始前 30 分鐘也先查，早上第一次招呼就有資料。
   */
  prefetch(): void {
    const prefs = this.options.settings.view();
    if (!prefs.enabled || !prefs.weather) return;
    const soon = localHour(this.now() + 30 * 60_000, this.options.timeZone);
    if (!inWindow(localHour(this.now(), this.options.timeZone), prefs) && !inWindow(soon, prefs)) return;
    const place = this.place(prefs);
    if (place) void this.options.weather.refresh(place.id);
  }

  /**
   * 招呼句後面要接的一句（確定性的模板），或 null。personId：認出並稱名的家人（沒稱名就當沒認出）。
   * 這裡不記紀錄：真的送出時呼叫 commit（使用者先開口、問候沒送出時，今天之後的招呼仍會說）。
   * 天氣不在快取裡時順便再查一次（給下一次招呼）。
   */
  compose(personId: string | null, locale: Locale): PendingBriefing | null {
    const prefs = this.options.settings.view();
    if (!this.active(prefs)) return null;
    const place = this.place(prefs);
    if (!place) return null;
    const today = localToday(new Date(this.now()), this.timeZone());
    const keys = briefingKeys(personId, this.options.log.done(today));
    if (!keys) return null;
    const weather = this.options.weather.current(place.id);
    if (!weather) {
      void this.options.weather.refresh(place.id);
      this.options.logLine?.("主動提醒：天氣還沒取到，這次只打招呼");
      return null;
    }
    return { sentence: weatherSentence(weather, locale), today, keys, person: personId !== null };
  }

  /** 問候真的送出：記下今天說過（同一份只記一次也沒關係，鍵是集合）。 */
  commit(b: PendingBriefing): void {
    this.options.log.mark(b.today, b.keys);
    this.options.logLine?.(`主動提醒：招呼後接天氣（${b.person ? "認出的家人" : "這台裝置"}今天第一次）`);
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
      attribution: WEATHER_ATTRIBUTION,
      write_path: "/api/settings/proactive",
    };
  }
}
