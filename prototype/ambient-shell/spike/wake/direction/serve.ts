// 方向性診斷頁的 /wake-runtime/ 對應（direction/vite.config.ts 的開發伺服器用）：只接受 shared/wake-runtime.json
// 清單上的檔名，對到 npm run wake:setup -- --product 安裝的 prototype/ambient-shell/wake-runtime/；其他一律 null（404）。
// 雜湊由 worker 內的 SherpaWasmDetector 逐一核對（不符就 runtime_load_failed），這裡不另外核對。

import { join } from "node:path";
import manifest from "../../../shared/wake-runtime.json" with { type: "json" };

const LISTED = new Set(manifest.files.map((f) => f.name));

/** 請求路徑 → 磁碟上的檔案；不是 /wake-runtime/<清單上的檔名> 時 null。 */
export function runtimeFileFor(pathname: string, runtimeDir: string): string | null {
  const m = (pathname.split("?")[0] ?? "").match(/^\/wake-runtime\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
  if (!m || !LISTED.has(m[1]!)) return null;
  return join(runtimeDir, m[1]!);
}

export function contentTypeFor(file: string): string {
  if (file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
