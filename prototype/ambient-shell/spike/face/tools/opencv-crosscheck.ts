// 驗證工具，非產品程式（ID-00，docs/validation/family-id-00-spike-2026-10-24.md §4）。
// 同一批像素，比較 spike 的 TS 前後處理（onnxruntime-web 的 Node 版）與 OpenCV FaceDetectorYN／FaceRecognizerSF：
// 偵測框、5 點、分數、alignCrop 對齊影像與 SFace 特徵。參考資料由 docs/validation/family-id-00-spike-2026-10-24/opencv-reference.py 產生。
// 用法（在 prototype/ambient-shell）：npx tsx spike/face/tools/opencv-crosscheck.ts <reference 輸出資料夾> spike/face/public/models

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-web";
import { iou } from "../metrics.ts";
import { cosineSimilarity, l2Normalize, rgbaToChw, similarityTransform, SFACE_SIZE, warpAffineToChw } from "../../../src/sense/face/sface.ts";
import { padToDivisor, postProcessYuNet, YUNET_STRIDES } from "../../../src/sense/face/yunet.ts";

interface Reference {
  opencv: string;
  frame: [number, number];
  /** 每張圖：OpenCV 回傳的 15 欄人臉列（x, y, w, h, 5 點, score）與 SFace 特徵 */
  results: Record<string, { faces: number[][]; features: number[][] }>;
}

const [dir, models] = process.argv.slice(2);
if (!dir || !models) throw new Error("usage: opencv-crosscheck.ts <reference dir> <models dir>");
const ref = JSON.parse(readFileSync(join(dir, "ref.json"), "utf8")) as Reference;
const [W, H] = ref.frame;
const opts = { logSeverityLevel: 3 as const };
const yunet = await ort.InferenceSession.create(join(models, "face_detection_yunet_2026may.onnx"), opts);
const sface = await ort.InferenceSession.create(join(models, "face_recognition_sface_2021dec.onnx"), opts);
const pick = (out: ort.InferenceSession.OnnxValueMapType, name: string): Float32Array => out[name]!.data as Float32Array;

const mine: Record<string, Float32Array> = {};
const theirs: Record<string, number[]> = {};
console.log(`OpenCV ${ref.opencv}, frame ${W}x${H}`);
for (const [name, r] of Object.entries(ref.results)) {
  const rgba = new Uint8Array(readFileSync(join(dir, `${name}.rgba`)));
  const pw = padToDivisor(W);
  const ph = padToDivisor(H);
  const padded = new Uint8Array(pw * ph * 4);
  for (let y = 0; y < H; y++) padded.set(rgba.subarray(y * W * 4, (y + 1) * W * 4), y * pw * 4);
  const out = await yunet.run({ input: new ort.Tensor("float32", rgbaToChw(padded, pw, ph, "bgr"), [1, 3, ph, pw]) });
  const faces = postProcessYuNet(YUNET_STRIDES.map((s) => ({ cls: pick(out, `cls_${s}`), obj: pick(out, `obj_${s}`), bbox: pick(out, `bbox_${s}`), kps: pick(out, `kps_${s}`) })), pw, ph);
  const cv = r.faces[0]!;
  const f = faces[0]!;
  const lmDiff = Math.max(...f.landmarks.map((p, i) => Math.hypot(p.x - cv[4 + 2 * i]!, p.y - cv[5 + 2 * i]!)));

  // 對齊影像：OpenCV alignCrop 的 112×112 BGR 位元組 vs spike 的 warpAffineToChw（RGB 浮點）。
  const chw = warpAffineToChw(rgba, W, H, similarityTransform(f.landmarks));
  const aligned = new Uint8Array(readFileSync(join(dir, `${name}.aligned.bgr`)));
  const plane = SFACE_SIZE * SFACE_SIZE;
  let maxDiff = 0;
  let sumDiff = 0;
  for (let i = 0; i < plane; i++)
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(chw[c * plane + i]! - aligned[i * 3 + (2 - c)]!);
      maxDiff = Math.max(maxDiff, d);
      sumDiff += d;
    }

  const feat = l2Normalize((await sface.run({ data: new ort.Tensor("float32", chw, [1, 3, SFACE_SIZE, SFACE_SIZE]) })).fc1!.data as Float32Array);
  mine[name] = feat;
  theirs[name] = r.features[0]!;
  console.log(
    `${name}: faces mine=${faces.length} cv=${r.faces.length} IoU=${iou(f.box, { x: cv[0]!, y: cv[1]!, width: cv[2]!, height: cv[3]! }).toFixed(4)} ` +
      `maxLandmarkDiffPx=${lmDiff.toFixed(3)} scoreDiff=${Math.abs(f.score - cv[14]!).toFixed(4)} ` +
      `alignedMaxAbsDiff=${maxDiff.toFixed(2)} alignedMeanAbsDiff=${(sumDiff / (plane * 3)).toFixed(3)} cos(mine,cv)=${cosineSimilarity(feat, r.features[0]!).toFixed(4)}`,
  );
}
const names = Object.keys(mine);
for (let i = 0; i < names.length; i++)
  for (let j = i + 1; j < names.length; j++) {
    const a = names[i]!;
    const b = names[j]!;
    console.log(`${a} × ${b}: mine=${cosineSimilarity(mine[a]!, mine[b]!).toFixed(4)} opencv=${cosineSimilarity(theirs[a]!, theirs[b]!).toFixed(4)}`);
  }
