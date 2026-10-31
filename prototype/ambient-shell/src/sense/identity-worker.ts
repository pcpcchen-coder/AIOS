// 家人辨識的推論 worker（module worker；ADR-0001 §2.1）。產品程式中唯一允許讀回像素（getImageData）的檔案。
// 一格：ImageBitmap（左眼 1280×720，頁面轉移進來）→ 讀像素 → YuNet 2023mar 640（OpenCV 同款縮放）→ 品質 →
// SFace 對齊與特徵。回傳 { gen, face_count, quality, feature?, metrics? }；像素、張量與臉框都不離開 worker，用完即丟
// （metrics 只在「校正人臉辨識」要求時帶出，是大小、角度與亮度等數字，不含座標）。
// 不寫檔、不連網（模型與 wasm 只從同源 /face-runtime/ 讀，JS 回應帶 connect-src 'self' 的 CSP）、不用本機儲存。
// onnxruntime-web 只用 wasm 後端、1 個執行緒，避免和既有 80 ms 感測迴圈搶 CPU（Mac 實測見驗證紀錄）。

import * as ort from "onnxruntime-web/wasm";
import manifest from "../../shared/face-runtime.json" with { type: "json" };
import type { FaceModelVersion } from "../../shared/identity.ts";
import { l2Normalize, similarityTransform, warpAffineToChw } from "./face/sface.ts";
import { assessQuality, meanLuma, QUALITY_DEFAULTS } from "./face/quality.ts";
import { letterboxToChw, planLetterbox, postProcessYuNet, toSourceCoords, YUNET_DEFAULTS, YUNET_STRIDES, type YuNetStrideOutput } from "./face/yunet.ts";
import type { FaceRuntimeAssets, FrameOptions, WorkerRequest, WorkerResponse } from "./identity-protocol.ts";

const MODEL: FaceModelVersion = manifest.model_version;
const INPUT = 640;

interface Scope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}
const scope = self as unknown as Scope;

let detector: ort.InferenceSession | null = null;
let recognizer: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;
let canvas: OffscreenCanvas | null = null;

async function init(assets: FaceRuntimeAssets): Promise<void> {
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = assets.wasmPrefix;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  const options: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 };
  detector = await ort.InferenceSession.create(assets.detector, options);
  recognizer = await ort.InferenceSession.create(assets.recognizer, options);
  scope.postMessage({ type: "ready", model: MODEL, load_ms: Math.round(performance.now() - t0) });
}

async function frame(gen: number, bitmap: ImageBitmap, options: FrameOptions = {}): Promise<void> {
  const t0 = performance.now();
  let rgba: Uint8ClampedArray | null = null;
  try {
    if (!detector || !recognizer) throw new Error("模型尚未載入");
    const w = bitmap.width;
    const h = bitmap.height;
    canvas ??= new OffscreenCanvas(w, h);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d canvas unavailable");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    rgba = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);

    const lb = planLetterbox(w, h, INPUT, INPUT);
    const input = new ort.Tensor("float32", letterboxToChw(rgba, w, h, lb, "bgr"), [1, 3, INPUT, INPUT]);
    const out = await detector.run({ input });
    const pick = (name: string): Float32Array => out[name]!.data as Float32Array;
    const outputs: YuNetStrideOutput[] = YUNET_STRIDES.map((s) => ({ cls: pick(`cls_${s}`), obj: pick(`obj_${s}`), bbox: pick(`bbox_${s}`), kps: pick(`kps_${s}`) }));
    const faces = postProcessYuNet(outputs, INPUT, INPUT, YUNET_DEFAULTS).map((f) => toSourceCoords(f, lb.scale));
    for (const t of Object.values(out)) t.dispose();
    input.dispose();

    const pixels = rgba;
    const quality = assessQuality(faces, w, h, (box) => meanLuma(pixels, w, h, box), { ...QUALITY_DEFAULTS, ...options.quality });
    let feature: Float32Array | undefined;
    if (quality.reason === "ok" && quality.face) {
      const data = new ort.Tensor("float32", warpAffineToChw(rgba, w, h, similarityTransform(quality.face.landmarks)), [1, 3, 112, 112]);
      const res = await recognizer.run({ data });
      feature = l2Normalize(res.fc1!.data as Float32Array);
      res.fc1!.dispose();
      data.dispose();
    }
    const metrics = options.metrics && quality.metrics ? { metrics: quality.metrics } : {};
    const message: WorkerResponse = { type: "result", gen, face_count: faces.length, quality: quality.reason, ms: Math.round(performance.now() - t0), ...(feature ? { feature } : {}), ...metrics };
    scope.postMessage(message, feature ? [feature.buffer] : []);
  } catch (err) {
    scope.postMessage({ type: "error", gen, message: err instanceof Error ? err.message : String(err) });
  } finally {
    try {
      bitmap.close();
    } catch {
      // 已關閉
    }
    rgba?.fill(0);
  }
}

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "init") {
    loading ??= init(msg.assets).catch((err: unknown) => {
      loading = null;
      scope.postMessage({ type: "error", gen: null, message: `辨識模型載入失敗：${err instanceof Error ? err.message : String(err)}` });
    });
  } else if (msg.type === "frame") {
    void frame(msg.gen, msg.bitmap, msg.options);
  } else if (msg.type === "dispose") {
    void detector?.release();
    void recognizer?.release();
    detector = recognizer = null;
    canvas = null;
  }
};
