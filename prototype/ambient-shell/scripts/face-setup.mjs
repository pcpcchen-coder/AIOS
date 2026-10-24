// ID-00 人臉 spike（docs/14、docs/adr/ADR-0001）的模型與 runtime 檔案。只給 spike 頁使用，不接進產品流程。
// 放在 spike/face/public/（不進 git），不放 public/vision/：後者會被 vite build 複製進產品 dist 與 Electron 包。
// 用法：npm run face:setup（約 40 MB，需要網路）；已有本機副本時：npm run face:setup -- --from <資料夾>。
// 每個檔案都核對 SHA-256；不符就刪掉並以非 0 結束，不留下未驗證的模型。

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "spike", "face", "public");
const modelsOut = join(out, "models");

// 網址釘在查核過的版本（Hugging Face revision、GitHub commit、MediaPipe 版本 1），雜湊為 2026-10-24 實際下載結果。
const MODELS = [
  {
    name: "face_detection_yunet_2023mar.onnx",
    url: "https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    license: "MIT（OpenCV Zoo face_detection_yunet/LICENSE）",
  },
  {
    name: "face_detection_yunet_2026may.onnx",
    url: "https://media.githubusercontent.com/media/opencv/opencv_zoo/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/face_detection_yunet/face_detection_yunet_2026may.onnx",
    sha256: "ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0",
    license: "MIT（同上；2023mar 改成動態輸入尺寸的重新匯出）",
  },
  {
    name: "face_recognition_sface_2021dec.onnx",
    url: "https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    license: "Apache-2.0（OpenCV Zoo face_recognition_sface/LICENSE）",
  },
  {
    name: "blaze_face_short_range.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    sha256: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
    license: "Apache-2.0（MediaPipe BlazeFace short range 模型卡）",
  },
  {
    name: "blaze_face_full_range.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite",
    sha256: "3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b",
    license: "Apache-2.0（MediaPipe BlazeFace full range 模型卡）",
  },
];

/** onnxruntime-web 只用 CPU（wasm）後端；由 ort.env.wasm.wasmPaths 指到這裡。 */
const ORT_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fromIndex = process.argv.indexOf("--from");
const fromDir = fromIndex < 0 ? null : process.argv[fromIndex + 1];
const force = process.argv.includes("--force");

const ortSrc = join(root, "node_modules", "onnxruntime-web", "dist");
const mpSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
if (!existsSync(ortSrc) || !existsSync(mpSrc)) {
  console.error("找不到 onnxruntime-web 或 @mediapipe/tasks-vision，請先執行 npm ci。");
  process.exit(1);
}
mkdirSync(modelsOut, { recursive: true });
mkdirSync(join(out, "ort"), { recursive: true });
mkdirSync(join(out, "mediapipe-wasm"), { recursive: true });
for (const name of ORT_FILES) copyFileSync(join(ortSrc, name), join(out, "ort", name));
for (const name of readdirSync(mpSrc)) copyFileSync(join(mpSrc, name), join(out, "mediapipe-wasm", name));
console.log("已複製 onnxruntime-web 與 MediaPipe wasm。");

let failed = false;
for (const model of MODELS) {
  const target = join(modelsOut, model.name);
  if (existsSync(target) && !force && sha256(readFileSync(target)) === model.sha256) {
    console.log(`已存在且雜湊相符，略過：${model.name}`);
    continue;
  }
  let buf;
  if (fromDir) {
    const local = join(fromDir, model.name);
    if (!existsSync(local)) {
      console.error(`--from 資料夾沒有 ${model.name}`);
      failed = true;
      continue;
    }
    buf = readFileSync(local);
  } else {
    const res = await fetch(model.url);
    if (!res.ok) {
      console.error(`下載失敗（HTTP ${res.status}）：${model.url}`);
      failed = true;
      continue;
    }
    buf = Buffer.from(await res.arrayBuffer());
  }
  const got = sha256(buf);
  if (got !== model.sha256) {
    rmSync(target, { force: true });
    console.error(`SHA-256 不符：${model.name}\n  預期 ${model.sha256}\n  實際 ${got}`);
    failed = true;
    continue;
  }
  writeFileSync(target, buf);
  console.log(`已${fromDir ? "複製" : "下載"}並核對 ${model.name}（${buf.length} bytes，${model.license}）`);
}
if (failed) process.exit(1);
console.log("完成。啟動 spike 頁：npm run face:spike（只在 127.0.0.1，不接進主畫面）。");
