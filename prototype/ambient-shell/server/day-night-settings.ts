import {
  activeOverride, DAY_NIGHT_WRITE_PATH, DayNightPatchError, decideDayNight, DEFAULT_DAY_NIGHT_PREFS, overrideUntil, parseDayNightPatch, parseStoredOverride,
  type DayNightOverride, type DayNightPatch, type DayNightPrefs, type DayNightSettingsView,
} from "../shared/day-night.ts";
import { PrefsFile } from "./prefs-file.ts";

// DN-2（George 2026-11-08）：日夜間模式的共用設定與手動切換（configDir/day-night.json；只有這裡寫入）。
// Mac 主視窗與 Pi 頁面都讀這一份；鏡頭亮度仍由各頁面自己量。檔案讀不懂時退回預設（沒有隱私或費用疑慮）。

type Stored = DayNightPrefs & { override: DayNightOverride | null };

function parseStoredKey(input: unknown): Partial<Stored> {
  const o = input as Record<string, unknown>;
  const out: Partial<Stored> = {};
  for (const [key, value] of Object.entries(o ?? {})) {
    if (key === "override") out.override = parseStoredOverride(value);
    else Object.assign(out, parseDayNightPatch({ [key]: value }));
  }
  return out;
}

export class DayNightSettingsStore {
  private readonly file: PrefsFile<Stored>;
  private readonly now: () => number;

  constructor(private readonly options: { dir: string; onChange(): void; log?(message: string): void; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.file = new PrefsFile<Stored>({
      dir: options.dir,
      name: "day-night.json",
      version: 1,
      parse: parseStoredKey,
      failClosed: {},
      unreadable: "日夜間模式用預設值",
      log: options.log,
    });
  }

  prefs(): DayNightPrefs {
    const saved = this.file.saved;
    return {
      night_start_h: saved.night_start_h ?? DEFAULT_DAY_NIGHT_PREFS.night_start_h,
      night_end_h: saved.night_end_h ?? DEFAULT_DAY_NIGHT_PREFS.night_end_h,
      use_camera: saved.use_camera ?? DEFAULT_DAY_NIGHT_PREFS.use_camera,
      night_effects: saved.night_effects ?? DEFAULT_DAY_NIGHT_PREFS.night_effects,
    };
  }

  override(): DayNightOverride | null {
    return activeOverride(this.file.saved.override, this.now());
  }

  /** 核心的判斷：時段＋手動（不含鏡頭）。 */
  coreMode(): DayNightSettingsView["core_mode"] {
    const now = this.now();
    return decideDayNight(new Date(now).getHours(), null, this.prefs(), this.override(), now).mode;
  }

  view(): DayNightSettingsView {
    return { prefs: this.prefs(), override: this.override(), saved: Object.keys(this.file.saved).length > 0, core_mode: this.coreMode(), write_path: DAY_NIGHT_WRITE_PATH };
  }

  /** 已驗證的 patch（parseDayNightPatch）：override day／night 依 scope（預設 now）算出結束時間；auto 取消。先寫檔才改記憶體。 */
  update(patch: DayNightPatch): DayNightSettingsView {
    const { override, scope, ...prefs } = patch;
    const next: Partial<Stored> = { ...prefs };
    if (override === "auto") next.override = null;
    else if (override) next.override = { mode: override, until: overrideUntil(this.now(), scope ?? "now", { ...this.prefs(), ...prefs }), scope: scope ?? "now" };
    this.file.update(next);
    this.options.onChange();
    return this.view();
  }
}

export { DayNightPatchError };
