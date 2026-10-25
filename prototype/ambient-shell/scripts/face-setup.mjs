// 人臉模型與 runtime 檔案（docs/14、docs/adr/ADR-0001）。兩種用法：
//
// 1. ID-00 spike（預設）：5 個模型與 wasm 放到 spike/face/public/（不進 git），只給 spike 頁使用。
//    npm run face:setup（約 40 MB，需要網路）；已有本機副本時：npm run face:setup -- --from <資料夾>。
// 2. ID-01 產品（--product）：只裝 shared/face-runtime.json 列的 YuNet 2023mar、SFace 與 onnxruntime 的 wasm／mjs，
//    放到 face-runtime/（不進 git）；在 macOS 上另外複製到 ~/Library/Application Support/Nous/face-runtime/，
//    App 的核心從那裡核對雜湊並提供（/face-runtime/）。不放 public/：那會進瀏覽器版 dist 與 release zip。
//    npm run face:setup -- --product [--from <資料夾>] [--dest <資料夾>]
//
// 每個檔案都核對 SHA-256；不符就刪掉並以非 0 結束，不留下未驗證的模型。

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

if (process.argv.includes("--product")) {
  process.exit(await setupProduct());
}

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

/** --product：產品用的模型與 runtime（shared/face-runtime.json）。回傳結束碼。 */
async function setupProduct() {
  const manifest = JSON.parse(readFileSync(join(root, "shared", "face-runtime.json"), "utf8"));
  const destIndex = process.argv.indexOf("--dest");
  const dests = destIndex >= 0 ? [resolve(process.argv[destIndex + 1])] : [join(root, "face-runtime")];
  // macOS App 的核心從 userData（~/Library/Application Support/Nous）讀；開發用 electron build/app 也是同一個資料夾。
  if (destIndex < 0 && process.platform === "darwin") dests.push(join(homedir(), "Library", "Application Support", "Nous", "face-runtime"));
  const ortDir = join(root, "node_modules", "onnxruntime-web", "dist");
  let failed = false;
  const verified = new Map();
  for (const file of manifest.files) {
    const existing = join(dests[0], file.name);
    if (!force && existsSync(existing) && sha256(readFileSync(existing)) === file.sha256) {
      verified.set(file.name, readFileSync(existing));
      console.log(`已存在且雜湊相符：${file.name}`);
      continue;
    }
    let buf;
    if (file.package) {
      const local = join(ortDir, file.name);
      if (!existsSync(local)) {
        console.error(`找不到 ${local}，請先執行 npm ci。`);
        failed = true;
        continue;
      }
      buf = readFileSync(local);
    } else if (fromDir) {
      const local = join(fromDir, file.name);
      if (!existsSync(local)) {
        console.error(`--from 資料夾沒有 ${file.name}`);
        failed = true;
        continue;
      }
      buf = readFileSync(local);
    } else {
      const res = await fetch(file.url);
      if (!res.ok) {
        console.error(`下載失敗（HTTP ${res.status}）：${file.url}`);
        failed = true;
        continue;
      }
      buf = Buffer.from(await res.arrayBuffer());
    }
    const got = sha256(buf);
    if (got !== file.sha256) {
      console.error(`SHA-256 不符：${file.name}\n  預期 ${file.sha256}\n  實際 ${got}`);
      failed = true;
      continue;
    }
    verified.set(file.name, buf);
    console.log(`已核對 ${file.name}（${buf.length} bytes，${file.license}）`);
  }
  if (failed) {
    console.error("有檔案沒有通過核對，沒有安裝任何檔案。");
    return 1;
  }
  for (const dest of dests) {
    mkdirSync(dest, { recursive: true });
    for (const [name, buf] of verified) writeFileSync(join(dest, name), buf);
    console.log(`已安裝到 ${dest}`);
  }
  console.log("完成。家人辨識只在 macOS App 提供；App 啟動時核心會再核對一次雜湊（選單列「家人辨識…」會顯示結果）。");
  return 0;
}
