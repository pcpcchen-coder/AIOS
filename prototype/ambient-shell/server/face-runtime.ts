import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../shared/face-runtime.json" with { type: "json" };
import type { FaceModelVersion } from "../shared/identity.ts";

// 家人辨識的本機模型與 onnxruntime wasm（shared/face-runtime.json）。只由 npm run face:setup -- --product 安裝到
// App 的資料夾；不在 git、不在前端 dist、也不在 release zip。核心啟動時核對 SHA-256，結果寫進 settings.identity。
// 核心只提供清單上的檔名（GET /face-runtime/<檔名>），其他路徑一律 404。

export interface FaceRuntimeFile {
  name: string;
  role: "detector" | "recognizer" | "runtime";
  sha256: string;
}

export const FACE_RUNTIME_FILES: readonly FaceRuntimeFile[] = manifest.files as FaceRuntimeFile[];
export const FACE_RUNTIME_PREFIX: string = manifest.url_prefix;
/** 目前的模型與前處理版本；登記特徵帶著它，版本不同的特徵不參與比對。 */
export const FACE_MODEL_VERSION: FaceModelVersion = manifest.model_version;

export type FaceRuntimeState = "ok" | "missing" | "hash_mismatch" | "not_configured";

export interface FaceRuntimeCheck {
  state: FaceRuntimeState;
  /** 缺少或雜湊不符的檔名（只有檔名，不含路徑）。 */
  problems: string[];
}

/** 逐一核對雜湊；資料夾沒設定時是 not_configured（瀏覽器版）。 */
export function checkFaceRuntime(dir: string | null | undefined): FaceRuntimeCheck {
  if (!dir) return { state: "not_configured", problems: [] };
  const missing: string[] = [];
  const mismatch: string[] = [];
  for (const file of FACE_RUNTIME_FILES) {
    const path = join(dir, file.name);
    if (!existsSync(path)) {
      missing.push(file.name);
      continue;
    }
    const got = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (got !== file.sha256) mismatch.push(file.name);
  }
  if (mismatch.length > 0) return { state: "hash_mismatch", problems: mismatch };
  if (missing.length > 0) return { state: "missing", problems: missing };
  return { state: "ok", problems: [] };
}

/**
 * 讀出清單上的檔案並在這次讀取時核對雜湊（啟動時核對過、之後檔案被換掉也擋得住）；不在清單、不存在或不符都回 null。
 */
export function readVerifiedFaceRuntime(path: string): Buffer | null {
  const name = path.split(/[\\/]/).at(-1);
  const file = FACE_RUNTIME_FILES.find((f) => f.name === name);
  if (!file || !existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex") === file.sha256 ? buf : null;
}

/** /face-runtime/ 之後的檔名若在清單上，回傳完整路徑；否則 null（不接受子資料夾、.. 或其他檔案）。 */
export function faceRuntimePath(dir: string | null | undefined, pathname: string): string | null {
  if (!dir || !pathname.startsWith(FACE_RUNTIME_PREFIX)) return null;
  const name = pathname.slice(FACE_RUNTIME_PREFIX.length);
  return FACE_RUNTIME_FILES.some((f) => f.name === name) ? join(dir, name) : null;
}
