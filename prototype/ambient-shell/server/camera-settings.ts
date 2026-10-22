import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

  /**
   * 套用已驗證的 patch（呼叫端先用 parseCameraPatch）：先寫檔，成功後才改記憶體並呼叫 onChange。
   * 寫檔失敗時丟出錯誤、記憶體不變（畫面與重新啟動後看到的是同一份）。同樣的 patch 再送一次，檔案內容不變。
   */
  update(patch: CameraPrefsPatch): CameraSettings {
    const next = { ...this.saved, ...patch };
    this.write({ schema_version: FILE_VERSION, prefs: next });
    this.saved = next;
    this.options.onChange();
    return this.view();
  }

  /**
   * 每個鍵分開驗證：不認得或不合法的鍵丟掉並記 log，其餘照用（壞掉一個鍵不會把保存的「關掉」一起丟掉）。
   * 檔案存在卻讀不懂（無法讀取、不是 JSON、版本不符、沒有 prefs 物件）時，鏡頭保持關閉（active: false），
   * 不退回預設的「開」；使用者說「打開鏡頭」或在設定打開時會覆寫這個檔案。
   */
  private readSaved(): CameraPrefsPatch {
    if (!existsSync(this.file)) return {};
    const log = this.options.log ?? console.warn;
    let prefs: Record<string, unknown>;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CameraFile> | null;
      if (!data || typeof data !== "object") throw new Error("內容不是 JSON 物件");
      if (data.schema_version !== FILE_VERSION) throw new Error(`不支援的 schema_version：${String(data.schema_version)}`);
      if (!data.prefs || typeof data.prefs !== "object" || Array.isArray(data.prefs)) throw new Error("prefs 不是物件");
      prefs = data.prefs as Record<string, unknown>;
    } catch (err) {
      log(`無法讀取 ${this.file}（${(err as Error).message}），鏡頭保持關閉；其他設定用 .env 與預設值`);
      return { active: false };
    }
    const saved: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(prefs)) {
      try {
        Object.assign(saved, parseCameraPatch({ [key]: value }));
      } catch (err) {
        dropped.push((err as Error).message);
        // 保存的「鏡頭」值不合法時不猜成開。
        if (key === "active") saved.active = false;
      }
    }
    if (dropped.length) log(`${this.file} 有 ${dropped.length} 項設定被忽略（${dropped.join("；")}），其餘照用`);
    return saved as CameraPrefsPatch;
  }

  private write(data: CameraFile): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows 不支援 POSIX 權限
    }
  }
}
