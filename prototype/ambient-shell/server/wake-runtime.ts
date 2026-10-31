import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../shared/wake-runtime.json" with { type: "json" };
import type { WakeRuntimeState } from "../shared/wake.ts";

// 常駐喚醒聆聽的本機引擎檔案（shared/wake-runtime.json；WK-01a 清單為空，WK-01b 才放入自建 wasm 與雜湊）。
// 與 face-runtime.ts 同樣的規則：只提供清單上的檔名、每次讀取都核對 SHA-256，其他路徑一律 404。
// 只有 NOUS_WAKE=on 時 app.ts 才會呼叫這裡；旗標關閉時 /wake-runtime/ 一律 404。

export interface WakeRuntimeFile {
  name: string;
  role: "runtime" | "model" | "keywords";
  sha256: string;
}

export const WAKE_RUNTIME_FILES: readonly WakeRuntimeFile[] = manifest.files as WakeRuntimeFile[];
export const WAKE_RUNTIME_PREFIX: string = manifest.url_prefix;

export interface WakeRuntimeCheck {
  state: WakeRuntimeState;
  /** 缺少或雜湊不符的檔名（只有檔名，不含路徑）。 */
  problems: string[];
}

/**
 * 逐一核對雜湊。清單是空的（WK-01a）時一律 missing：沒有引擎就不能宣稱可以偵測。資料夾沒設定時是 not_configured。
 */
export function checkWakeRuntime(dir: string | null | undefined, files: readonly WakeRuntimeFile[] = WAKE_RUNTIME_FILES): WakeRuntimeCheck {
  if (files.length === 0) return { state: "missing", problems: [] };
  if (!dir) return { state: "not_configured", problems: [] };
  const missing: string[] = [];
  const mismatch: string[] = [];
  for (const file of files) {
    const path = join(dir, file.name);
    if (!existsSync(path)) {
      missing.push(file.name);
      continue;
    }
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) mismatch.push(file.name);
  }
  if (mismatch.length > 0) return { state: "hash_mismatch", problems: mismatch };
  if (missing.length > 0) return { state: "missing", problems: missing };
  return { state: "ok", problems: [] };
}

/** /wake-runtime/ 之後的檔名若在清單上，回傳完整路徑；否則 null（不接受子資料夾、.. 或其他檔案）。 */
export function wakeRuntimePath(dir: string | null | undefined, pathname: string, files: readonly WakeRuntimeFile[] = WAKE_RUNTIME_FILES): string | null {
  if (!dir || !pathname.startsWith(WAKE_RUNTIME_PREFIX)) return null;
  const name = pathname.slice(WAKE_RUNTIME_PREFIX.length);
  return files.some((f) => f.name === name) ? join(dir, name) : null;
}

/** 讀出清單上的檔案並在這次讀取時核對雜湊；不在清單、不存在或不符都回 null。 */
export function readVerifiedWakeRuntime(path: string, files: readonly WakeRuntimeFile[] = WAKE_RUNTIME_FILES): Buffer | null {
  const name = path.split(/[\\/]/).at(-1);
  const file = files.find((f) => f.name === name);
  if (!file || !existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex") === file.sha256 ? buf : null;
}
