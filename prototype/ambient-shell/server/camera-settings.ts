import {
  CAMERA_PREF_KEYS,
  parseCameraPatch,
  type CameraInstall,
  type CameraPrefs,
  type CameraPrefsPatch,
  type CameraSettings,
} from "../shared/sense.ts";
import { PrefsFile } from "./prefs-file.ts";

// 鏡頭的使用者設定（configDir/camera.json）。這個檔案只有這裡寫入；ProviderManager 的 settings.json 不受影響。
// 優先順序：使用者保存的值 > .env（只有 NOUS_LOOK_TO_TALK）> CAMERA_PREFS 預設。

export interface CameraSettingsStoreOptions {
  /** loadConfig().camera：安裝設定 + 由 .env 與預設算出的使用者設定。 */
  base: CameraSettings;
  /** configDir；不存在時以 0o700 建立。 */
  dir: string;
  /** 設定改變後呼叫（接到 notifySettings → SSE settings.updated）。 */
  onChange(): void;
  log?(message: string): void;
}

export class CameraSettingsStore {
  private readonly file: PrefsFile<CameraPrefs>;

  constructor(private readonly options: CameraSettingsStoreOptions) {
    this.file = new PrefsFile<CameraPrefs>({
      dir: options.dir,
      name: "camera.json",
      version: 1,
      parse: parseCameraPatch,
      // 保存的「鏡頭」值不合法、或檔案讀不懂時，不猜成開；使用者說「打開鏡頭」或在設定打開時會覆寫這個檔案。
      failClosed: { active: false },
      unreadable: "鏡頭保持關閉；其他設定用 .env 與預設值",
      log: options.log,
    });
  }

  /** install 永遠來自 .env；使用者設定 = base 疊上保存的值。 */
  view(): CameraSettings {
    const { enabled, label, left_first, screen_width_mm, screen_offset_mm } = this.options.base;
    const install: CameraInstall = { enabled, label, left_first, screen_width_mm, screen_offset_mm };
    const saved = this.file.saved;
    const prefs = Object.fromEntries(CAMERA_PREF_KEYS.map((key) => [key, saved[key] ?? this.options.base[key]])) as unknown as CameraPrefs;
    return { ...install, ...prefs };
  }

  /**
   * 套用已驗證的 patch（呼叫端先用 parseCameraPatch）：先寫檔，成功後才改記憶體並呼叫 onChange。
   * 寫檔失敗時丟出錯誤、記憶體不變。同樣的 patch 再送一次，檔案內容不變。
   */
  update(patch: CameraPrefsPatch): CameraSettings {
    this.file.update(patch);
    this.options.onChange();
    return this.view();
  }
}
