import { DEFAULT_HOME_CORNER_PREFS, HOME_CORNER_PREF_KEYS, HOME_CORNER_WRITE_PATH, parseHomeCornerPatch, type HomeCornerPrefs, type HomeCornerPrefsPatch, type HomeCornerSettingsView } from "../shared/home-corner.ts";
import { MAIN_SOURCE } from "../shared/terminal.ts";
import { PrefsFile } from "./prefs-file.ts";

// HOME-1（George 2026-11-07）：左上角家中狀態的顯示設定（configDir/home-corner.json；只有這裡寫入）。
// 預設同右上角時鐘：Mac 主視窗關、終端機（Pi）開。只是畫面上的讀數，不能控制：檔案讀不懂時退回預設。

export class HomeCornerSettingsStore {
  private readonly file: PrefsFile<HomeCornerPrefs>;

  constructor(private readonly options: { dir: string; onChange(): void; log?(message: string): void }) {
    this.file = new PrefsFile<HomeCornerPrefs>({
      dir: options.dir,
      name: "home-corner.json",
      version: 1,
      parse: parseHomeCornerPatch,
      failClosed: {},
      unreadable: "左上角家中狀態用預設值",
      log: options.log,
    });
  }

  prefs(): HomeCornerPrefs {
    const saved = this.file.saved;
    return Object.fromEntries(HOME_CORNER_PREF_KEYS.map((key) => [key, saved[key] ?? DEFAULT_HOME_CORNER_PREFS[key]])) as unknown as HomeCornerPrefs;
  }

  /** source：pageSource(X-Nous-Terminal)；Mac 主視窗看 main，終端機看 terminal。 */
  view(source: string = MAIN_SOURCE): HomeCornerSettingsView {
    const prefs = this.prefs();
    return { enabled: source === MAIN_SOURCE ? prefs.main : prefs.terminal, prefs, write_path: HOME_CORNER_WRITE_PATH };
  }

  /** 已驗證的 patch：先寫檔，成功後才改記憶體並呼叫 onChange；寫檔失敗丟錯、記憶體不變。 */
  update(patch: HomeCornerPrefsPatch): HomeCornerPrefs {
    this.file.update(patch);
    this.options.onChange();
    return this.prefs();
  }
}
