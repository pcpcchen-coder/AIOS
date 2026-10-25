// 家人辨識 worker 與頁面之間的訊息（src/sense/identity-worker.ts ↔ identity-client.ts）。
// 只有特徵向量與品質離開 worker；像素（ImageBitmap 轉移進去後）留在 worker，用完即關閉。

import type { FaceModelVersion, QualityReason } from "../../shared/identity.ts";

export interface FaceRuntimeAssets {
  /** onnxruntime 的 wasm 路徑前綴（同源，例如 /face-runtime/）。 */
  wasmPrefix: string;
  detector: string;
  recognizer: string;
}

export type WorkerRequest =
  | { type: "init"; assets: FaceRuntimeAssets }
  /** bitmap 以 transfer 交給 worker；頁面不留副本。 */
  | { type: "frame"; gen: number; bitmap: ImageBitmap }
  | { type: "dispose" };

export interface FrameResult {
  type: "result";
  gen: number;
  face_count: number;
  quality: QualityReason;
  /** 只有品質合格時才有：128 維、L2 normalize。 */
  feature?: Float32Array;
  /** 這一格在 worker 內的總耗時（毫秒）。 */
  ms: number;
}

export type WorkerResponse =
  | { type: "ready"; model: FaceModelVersion; load_ms: number }
  | FrameResult
  | { type: "error"; gen: number | null; message: string };
