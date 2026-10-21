import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAMERA_PREF_KEYS,
  parseCameraPatch,
  type CameraInstall,
  type CameraPrefs,
  type CameraPrefsPatch,
  type CameraSettings,
} from "../shared/sense.ts";

// 鏡頭的使用者設定（configDir/camera.json）。這個檔案只有這裡寫入；ProviderManager 的 settings.json 不受影響。
// 優先順序：使用者保存的值 > .env（只有 NOUS_LOOK_TO_TALK）> CAMERA_PREFS 預設。

const FILE = "camera.json";
const FILE_VERSION = 1;

/** 只存使用者改過的鍵，讓之後改 .env 仍能影響沒動過的設定。 */
interface CameraFile {
  schema_version: typeof FILE_VERSION;
  prefs: CameraPrefsPatch;
}

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
  private readonly file: string;
  private saved: CameraPrefsPatch;

  constructor(private readonly options: CameraSettingsStoreOptions) {
    this.file = join(options.dir, FILE);
    this.saved = this.readSaved();
  }

  /** install 永遠來自 .env；使用者設定 = base 疊上保存的值。 */
  view(): CameraSettings {
    const { enabled, label, left_first, screen_width_mm, screen_offset_mm } = this.options.base;
    const install: CameraInstall = { enabled, label, left_first, screen_width_mm, screen_offset_mm };
    const prefs = Object.fromEntries(CAMERA_PREF_KEYS.map((key) => [key, this.saved[key] ?? this.options.base[key]])) as unknown as CameraPrefs;
    return { ...install, ...prefs };
  }

  /** 套用已驗證的 patch（呼叫端先用 parseCameraPatch）：寫檔後呼叫 onChange。同樣的 patch 再送一次，檔案內容不變。 */
  update(patch: CameraPrefsPatch): CameraSettings {
    this.saved = { ...this.saved, ...patch };
    this.write({ schema_version: FILE_VERSION, prefs: this.saved });
    this.options.onChange();
    return this.view();
  }

  /** 讀不到、版本不符或內容不合法時當作沒有保存，記一行 log，不讓核心啟動失敗。 */
  private readSaved(): CameraPrefsPatch {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CameraFile>;
      if (data.schema_version !== FILE_VERSION) throw new Error(`不支援的 schema_version：${String(data.schema_version)}`);
      return parseCameraPatch(data.prefs);
    } catch (err) {
      (this.options.log ?? console.warn)(`忽略 ${this.file}（${(err as Error).message}），改用 .env 與預設值`);
      return {};
    }
  }

  private write(data: CameraFile): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows 不支援 POSIX 權限
    }
  }
}
