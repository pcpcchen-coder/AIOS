import { PrefsFile } from "./prefs-file.ts";

// 各個設定 store（configDir/<name>.json）共用的樣板：建立 PrefsFile、把保存的值疊在預設值上、寫檔後通知。
// 只收這三件每個 store 都一樣的事；view() 的形狀、update() 的規則與回傳值仍由各 store 自己寫。

export interface PrefsStoreOptions {
  /** configDir；不存在時以 0o700 建立。 */
  dir: string;
  /** 設定改變後呼叫（接到 notifySettings → SSE settings.updated）。 */
  onChange(): void;
  log?(message: string): void;
}

/** 每個 store 固定的部分；欄位意義見 PrefsFileOptions。schema_version 一律是 1。 */
export interface PrefsStoreSpec<S> {
  name: string;
  parse(input: unknown): Partial<S>;
  failClosed: Partial<S>;
  unreadable: string;
}

/** S：檔案裡保存的形狀；O：建構參數（多數 store 就是 PrefsStoreOptions）。 */
export class PrefsStore<S, O extends PrefsStoreOptions = PrefsStoreOptions> {
  protected readonly file: PrefsFile<S>;

  constructor(spec: PrefsStoreSpec<S>, protected readonly options: O) {
    this.file = new PrefsFile<S>({ dir: options.dir, version: 1, log: options.log, ...spec });
  }

  /** 依 keys 的順序，每個鍵取「保存的值 ?? 預設值」；defaults 多出來的鍵不會帶進結果。 */
  protected resolve<V>(keys: readonly (keyof V & keyof S)[], defaults: V): V {
    const saved = this.file.saved;
    return Object.fromEntries(keys.map((key) => [key, saved[key] ?? defaults[key]])) as unknown as V;
  }

  /** 先寫檔，成功後才改記憶體並呼叫 onChange；寫檔失敗丟錯、記憶體不變、不呼叫 onChange。 */
  protected commit(patch: Partial<S>): void {
    this.file.update(patch);
    this.options.onChange();
  }
}
