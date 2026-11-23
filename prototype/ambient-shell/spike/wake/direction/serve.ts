// 方向性診斷頁的 /wake-runtime/ 對應（direction/vite.config.ts 的開發伺服器用）：只接受 shared/wake-runtime.json
// 清單上的檔名，對到 npm run wake:setup -- --product 安裝的 prototype/ambient-shell/wake-runtime/；其他一律 null（404）。
// 和產品核心（server/wake-runtime.ts）一樣**每次讀取都核對 SHA-256**，不符也是 404：worker 先以 bytes() 核對、再以 import()
// 重新讀取同一路徑，「核對後才執行」靠的是伺服器每次讀取都再核對（src/audio/detector.ts 的註解）。

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import manifest from "../../../shared/wake-runtime.json" with { type: "json" };

const HASHES = new Map(manifest.files.map((f) => [f.name, f.sha256]));

/** 請求路徑 → 磁碟上的檔案；不是 /wake-runtime/<清單上的檔名> 時 null。 */
export function runtimeFileFor(pathname: string, runtimeDir: string): string | null {
  const m = (pathname.split("?")[0] ?? "").match(/^\/wake-runtime\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
  if (!m || !HASHES.has(m[1]!)) return null;
  return join(runtimeDir, m[1]!);
}

/** 讀出清單上的檔案並核對雜湊；不在清單、檔案不在或雜湊不符時 null。 */
export function readVerifiedRuntime(pathname: string, runtimeDir: string): Buffer | null {
  const file = runtimeFileFor(pathname, runtimeDir);
  if (!file || !existsSync(file)) return null;
  const name = basename(file);
  const bytes = readFileSync(file);
  return createHash("sha256").update(bytes).digest("hex") === HASHES.get(name) ? bytes : null;
}

export function contentTypeFor(file: string): string {
  if (file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** 頁面與 worker 腳本共用的 CSP（開發伺服器對每個回應都送，worker 也受限制；meta 只管頁面本身）。 */
export const DIRECTION_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws://127.0.0.1:5184; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' mediastream:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
