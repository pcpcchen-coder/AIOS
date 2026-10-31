import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 一個使用者設定檔（configDir/<name>.json）：只存使用者改過的鍵、原子寫入（tmp + rename、0600）、逐鍵驗證讀回。
// camera.json、voice.json 各有一個，各自只有一個寫入者（CameraSettingsStore、VoiceSettingsStore）。

/** 只存使用者改過的鍵，讓之後改 .env 或預設值仍能影響沒動過的設定。 */
interface PrefsFileData<P> {
  schema_version: number;
  prefs: Partial<P>;
}

export interface PrefsFileOptions<P> {
  /** configDir；不存在時以 0o700 建立。 */
  dir: string;
  name: string;
  version: number;
  /** 邊界驗證；每個鍵分開呼叫，不合法時丟錯。 */
  parse(input: unknown): Partial<P>;
  /**
   * 讀不懂時強制的值（fail closed）：檔案整個讀不懂時整份套用；某個鍵不合法而它在這裡時，套用這裡的值。
   * 鏡頭是 { active: false }（不猜成開）；語音是 {}（退回預設沒有安全疑慮）。
   */
  failClosed: Partial<P>;
  /** 檔案整個讀不懂時，log 說明接下來怎麼辦（「鏡頭保持關閉；…」）。 */
  unreadable: string;
  log?(message: string): void;
}

export class PrefsFile<P> {
  readonly path: string;
  private current: Partial<P>;

  constructor(private readonly options: PrefsFileOptions<P>) {
    this.path = join(options.dir, options.name);
    this.current = this.read();
  }

  /** 保存的使用者設定（不含預設值）。 */
  get saved(): Partial<P> {
    return this.current;
  }

  /**
   * 套用已驗證的 patch：先寫檔，成功後才改記憶體。寫檔失敗時丟出錯誤、記憶體不變
   * （畫面與重新啟動後看到的是同一份）。同樣的 patch 再送一次，檔案內容不變。
   */
  update(patch: Partial<P>): Partial<P> {
    const next = { ...this.current, ...patch };
    this.write({ schema_version: this.options.version, prefs: next });
    this.current = next;
    return next;
  }

  /** 整份換掉（還原預設時傳 {}）：一樣先寫檔，成功後才改記憶體。 */
  replace(next: Partial<P>): Partial<P> {
    this.write({ schema_version: this.options.version, prefs: next });
    this.current = { ...next };
    return this.current;
  }

  /**
   * 每個鍵分開驗證：不認得或不合法的鍵丟掉並記 log，其餘照用（壞掉一個鍵不會把其他保存的值一起丟掉）。
   * 檔案存在卻讀不懂（無法讀取、不是 JSON、版本不符、沒有 prefs 物件）時套用 failClosed。
   */
  private read(): Partial<P> {
    if (!existsSync(this.path)) return {};
    const log = this.options.log ?? console.warn;
    let prefs: Record<string, unknown>;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Partial<PrefsFileData<P>> | null;
      if (!data || typeof data !== "object") throw new Error("內容不是 JSON 物件");
      if (data.schema_version !== this.options.version) throw new Error(`不支援的 schema_version：${String(data.schema_version)}`);
      if (!data.prefs || typeof data.prefs !== "object" || Array.isArray(data.prefs)) throw new Error("prefs 不是物件");
      prefs = data.prefs as Record<string, unknown>;
    } catch (err) {
      log(`無法讀取 ${this.path}（${(err as Error).message}），${this.options.unreadable}`);
      return { ...this.options.failClosed };
    }
    const saved: Record<string, unknown> = {};
    const failClosed = this.options.failClosed as Record<string, unknown>;
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(prefs)) {
      try {
        Object.assign(saved, this.options.parse({ [key]: value }));
      } catch (err) {
        dropped.push((err as Error).message);
        if (Object.hasOwn(failClosed, key)) saved[key] = failClosed[key];
      }
    }
    if (dropped.length) log(`${this.path} 有 ${dropped.length} 項設定被忽略（${dropped.join("；")}），其餘照用`);
    return saved as Partial<P>;
  }

  private write(data: PrefsFileData<P>): void {
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
