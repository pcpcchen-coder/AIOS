import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 共用的「先寫暫存檔、再 rename」（docs/23 §3 S4）。
// 只給簡單的設定檔與紀錄檔用：不 fsync、暫存檔名固定（同一個檔同時只有一個寫入者）。
// 需要 fsync、O_EXCL 或隨機暫存檔名的 durable 寫法（sealed-vault.ts、memory/store.ts、store.ts 的 writeJsonAtomic）不走這裡。
// 每個選項預設都是「不做」，呼叫者只開自己原本就有的步驟，寫出的位元組、權限與失敗行為才會和搬過來之前相同。

export interface WriteAtomicOptions {
  /** 建立暫存檔時的權限（照 umask 遮罩）。不給就用 Node 預設 0o666。暫存檔已存在時不會改它的權限，要保證權限請加 chmodTemp。 */
  mode?: number;
  /** 暫存檔名＝目標路徑＋這個字尾。預設 ".tmp"。 */
  tempSuffix?: string;
  /** 先 mkdir -p 目標的上層資料夾：true 用 Node 預設權限，數字是新資料夾的權限。不給就不建（上層不在時丟 ENOENT）。 */
  mkdir?: boolean | number;
  /** rename 之前把暫存檔 chmod 成 mode（不看 umask；失敗會丟出）。要同時給 mode。 */
  chmodTemp?: boolean;
  /** 寫入、chmod 或 rename 失敗時先刪暫存檔再丟出原本的錯。不給就留著暫存檔。 */
  removeTempOnError?: boolean;
}

/**
 * 把 data 寫到 `${path}${tempSuffix}` 再 rename 成 path。字串用 UTF-8，不加換行。
 * 步驟固定是：mkdir（有要求時）→ 寫暫存檔 → chmod 暫存檔（有要求時）→ rename。
 * 任何一步失敗都丟出原本的錯；mkdir 失敗時還沒有暫存檔，不做清理。
 */
export function writeAtomic(path: string, data: string | Uint8Array, options: WriteAtomicOptions = {}): void {
  const { mode, mkdir } = options;
  if (mkdir !== undefined && mkdir !== false) mkdirSync(dirname(path), mkdir === true ? { recursive: true } : { recursive: true, mode: mkdir });
  const tmp = `${path}${options.tempSuffix ?? ".tmp"}`;
  try {
    if (mode === undefined) writeFileSync(tmp, data);
    else writeFileSync(tmp, data, { mode });
    if (options.chmodTemp && mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    if (options.removeTempOnError) rmSync(tmp, { force: true });
    throw err;
  }
}
