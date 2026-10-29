// WK-00：模型路徑（scripts/wake-setup.mjs 安裝到 spike/wake/models/，不進 git、不進 dist）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "./models.json" with { type: "json" };
import type { ModelId } from "./keywords.ts";

export type Precision = "int8" | "fp32";

export interface ModelPaths {
  id: ModelId;
  precision: Precision;
  dir: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export const MODELS_DIR = join(import.meta.dirname, "models");

export function modelPaths(id: ModelId, precision: Precision = "int8", root = MODELS_DIR): ModelPaths {
  const entry = manifest.kws.find((m) => m.id === id);
  if (!entry) throw new Error(`unknown model ${id}`);
  const dir = join(root, entry.dir);
  const paths: ModelPaths = {
    id,
    precision,
    dir,
    encoder: join(dir, entry.encoder[precision]),
    decoder: join(dir, entry.decoder[precision]),
    joiner: join(dir, entry.joiner[precision]),
    tokens: join(dir, "tokens.txt"),
  };
  const missing = [paths.encoder, paths.decoder, paths.joiner, paths.tokens].filter((p) => !existsSync(p));
  if (missing.length) throw new Error(`model files missing (run npm run wake:setup / 請先執行 npm run wake:setup): ${missing.join(", ")}`);
  return paths;
}

export function tokensText(paths: ModelPaths): string {
  return readFileSync(paths.tokens, "utf8");
}

export function ttsDir(id: "aishell3" | "melo-zh-en", root = MODELS_DIR): string {
  const entry = manifest.tts.find((t) => t.id === id);
  if (!entry) throw new Error(`unknown TTS model ${id}`);
  const dir = join(root, "tts", entry.dir);
  if (!existsSync(join(dir, "model.onnx"))) throw new Error(`TTS model missing (run npm run wake:setup -- --tts): ${dir}`);
  return dir;
}
