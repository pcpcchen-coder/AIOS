// WK-00：結果報告（JSON）。報告只含數字與文字，**不含音訊**：寫入前檢查，遇到型別陣列、ArrayBuffer、
// 或很長的數字陣列（看起來像樣本）就拒絕。這是 spike/wake 唯一可以寫檔的地方（tests/wake-privacy.test.ts 檢查）。
// 預設寫到 repo 外（系統暫存資料夾下的 aios-wake-spike/）；也可寫到 repo 內 gitignore 的 spike/wake/results/。

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** 超過這個長度的純數字陣列視為可能的音訊樣本。報告裡的時間戳、分桶與延遲清單都遠小於此。 */
export const MAX_NUMERIC_ARRAY = 2048;

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
export const RESULTS_IN_REPO = resolve(import.meta.dirname, "results");

export function defaultOutputDir(): string {
  return join(tmpdir(), "aios-wake-spike");
}

/** 回傳路徑違規說明；可以寫入時回傳 null。repo 內只允許 spike/wake/results/。 */
export function outputDirProblem(dir: string): string | null {
  const abs = resolve(dir);
  const rel = relative(REPO_ROOT, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) return null;
  const inResults = relative(RESULTS_IN_REPO, abs);
  if (inResults === "" || (!inResults.startsWith("..") && !isAbsolute(inResults))) return null;
  return `output inside the repo must be under ${RESULTS_IN_REPO} (gitignored) / repo 內只能寫到 spike/wake/results/`;
}

/** 遞迴檢查物件裡沒有音訊形狀的資料；回傳第一個違規的路徑，沒有則 null。 */
export function findAudioLike(value: unknown, path = "$"): string | null {
  if (value === null || typeof value !== "object") return null;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)) return path;
  if (Array.isArray(value)) {
    if (value.length > MAX_NUMERIC_ARRAY && value.every((v) => typeof v === "number")) return path;
    for (let i = 0; i < value.length; i++) {
      const hit = findAudioLike(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    const hit = findAudioLike(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

/** 寫出 JSON 報告並回傳路徑。音訊形狀的資料或 repo 內未忽略的路徑會丟錯。 */
export function writeReport(dir: string, name: string, report: object): string {
  const problem = outputDirProblem(dir);
  if (problem) throw new Error(problem);
  const audio = findAudioLike(report);
  if (audio) throw new Error(`refusing to write audio-like data at ${audio} / 報告不得含音訊`);
  if (!/^[\w.-]+\.json$/.test(name)) throw new Error(`report name must be a plain .json file name: ${name}`);
  mkdirSync(dir, { recursive: true });
  const file = join(resolve(dir), name);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}
