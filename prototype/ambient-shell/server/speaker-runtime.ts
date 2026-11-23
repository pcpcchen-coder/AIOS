import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../shared/speaker-runtime.json" with { type: "json" };
import type { SpeakerModelVersion } from "../shared/identity.ts";

// 家人聲音辨認（SP-01）的本機講者模型與 onnxruntime wasm（shared/speaker-runtime.json）。只由 npm run speaker:setup 安裝到
// App 的資料夾；不在 git、不在前端 dist、也不在 release zip。與 face-runtime 分開核對：少了講者模型只停用聲音，不影響臉。
// 核心只提供清單上的檔名（GET /speaker-runtime/<檔名>），其他路徑一律 404。

export interface SpeakerRuntimeFile {
  name: string;
  role: "speaker" | "runtime";
  sha256: string;
}

export const SPEAKER_RUNTIME_FILES: readonly SpeakerRuntimeFile[] = manifest.files as SpeakerRuntimeFile[];
export const SPEAKER_RUNTIME_PREFIX: string = manifest.url_prefix;
/** 目前的講者模型與前處理版本；聲音特徵帶著它，版本不同的特徵不參與比對、要重新登記。 */
export const SPEAKER_MODEL_VERSION: SpeakerModelVersion = manifest.model_version;

export type SpeakerRuntimeState = "ok" | "missing" | "hash_mismatch" | "not_configured";

export interface SpeakerRuntimeCheck {
  state: SpeakerRuntimeState;
  /** 缺少或雜湊不符的檔名（只有檔名，不含路徑）。 */
  problems: string[];
}

/** 逐一核對雜湊；資料夾沒設定時是 not_configured（瀏覽器版）。 */
export function checkSpeakerRuntime(dir: string | null | undefined): SpeakerRuntimeCheck {
  if (!dir) return { state: "not_configured", problems: [] };
  const missing: string[] = [];
  const mismatch: string[] = [];
  for (const file of SPEAKER_RUNTIME_FILES) {
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

/** 讀出清單上的檔案並在這次讀取時核對雜湊；不在清單、不存在或不符都回 null。 */
export function readVerifiedSpeakerRuntime(path: string): Buffer | null {
  const name = path.split(/[\\/]/).at(-1);
  const file = SPEAKER_RUNTIME_FILES.find((f) => f.name === name);
  if (!file || !existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex") === file.sha256 ? buf : null;
}

/** /speaker-runtime/ 之後的檔名若在清單上，回傳完整路徑；否則 null（不接受子資料夾、.. 或其他檔案）。 */
export function speakerRuntimePath(dir: string | null | undefined, pathname: string): string | null {
  if (!dir || !pathname.startsWith(SPEAKER_RUNTIME_PREFIX)) return null;
  const name = pathname.slice(SPEAKER_RUNTIME_PREFIX.length);
  return SPEAKER_RUNTIME_FILES.some((f) => f.name === name) ? join(dir, name) : null;
}
