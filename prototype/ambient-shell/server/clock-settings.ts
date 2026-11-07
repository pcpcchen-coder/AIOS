import { CLOCK_PREF_KEYS, CLOCK_WRITE_PATH, DEFAULT_CLOCK_PREFS, parseClockPatch, type ClockPrefs, type ClockPrefsPatch, type ClockSettingsView } from "../shared/clock.ts";
import { MAIN_SOURCE } from "../shared/terminal.ts";
import { PrefsFile } from "./prefs-file.ts";

// CLK-1（George 2026-11-07）：右上角時鐘與天氣的顯示設定（configDir/clock.json；只有這裡寫入）。
// 預設：Mac 主視窗關、終端機（Pi）開。只是畫面上的讀數，沒有隱私或費用疑慮：檔案讀不懂時退回預設。

export class ClockSettingsStore {
  private readonly file: PrefsFile<ClockPrefs>;

  constructor(private readonly options: { dir: string; onChange(): void; log?(message: string): void }) {
    this.file = new PrefsFile<ClockPrefs>({
      dir: options.dir,
      name: "clock.json",
      version: 1,
      parse: parseClockPatch,
      failClosed: {},
      unreadable: "右上角時鐘用預設值",
      log: options.log,
    });
  }

  prefs(): ClockPrefs {
    const saved = this.file.saved;
    return Object.fromEntries(CLOCK_PREF_KEYS.map((key) => [key, saved[key] ?? DEFAULT_CLOCK_PREFS[key]])) as unknown as ClockPrefs;
  }

  /** source：pageSource(X-Nous-Terminal)；Mac 主視窗看 main，終端機看 terminal。 */
  view(source: string = MAIN_SOURCE): ClockSettingsView {
    const prefs = this.prefs();
    return { enabled: source === MAIN_SOURCE ? prefs.main : prefs.terminal, prefs, write_path: CLOCK_WRITE_PATH };
  }

  /** 已驗證的 patch（呼叫端先用 parseClockPatch）：先寫檔，成功後才改記憶體並呼叫 onChange；寫檔失敗丟錯、記憶體不變。 */
  update(patch: ClockPrefsPatch): ClockPrefs {
    this.file.update(patch);
    this.options.onChange();
    return this.prefs();
  }
}
