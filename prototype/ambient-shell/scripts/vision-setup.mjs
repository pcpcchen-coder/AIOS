// 雙目鏡頭（docs/11）的本機視覺模型：把 MediaPipe 的 wasm 與模型放到 public/vision/，
// 由本機核心提供給頁面。執行期不連外：影像與推論都在本機。
// 用法：npm run vision:setup（需要網路下載兩個模型檔，約 30 MB；只需執行一次）。

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vision");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmOut = join(out, "wasm");
const modelsOut = join(out, "models");

// 官方模型下載位置（MediaPipe Solutions）；float16 latest。
const MODELS = {
  "pose_landmarker_full.task":
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
  "gesture_recognizer.task":
    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task",
};

if (!existsSync(wasmSrc)) {
  console.error("找不到 @mediapipe/tasks-vision，請先執行 npm ci。");
  process.exit(1);
}
mkdirSync(wasmOut, { recursive: true });
mkdirSync(modelsOut, { recursive: true });
for (const name of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, name), join(wasmOut, name));
console.log(`已複製 wasm 到 ${wasmOut}`);

for (const [name, url] of Object.entries(MODELS)) {
  const target = join(modelsOut, name);
  if (existsSync(target) && !process.argv.includes("--force")) {
    console.log(`已存在，略過：${name}`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`下載失敗（HTTP ${res.status}）：${url}`);
    process.exit(1);
  }
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  console.log(`已下載 ${name}`);
}
console.log("完成。在 .env 設定 NOUS_CAMERA=on 後執行 npm start。");
