// 家人辨識 worker 與頁面之間的訊息（src/sense/identity-worker.ts ↔ identity-client.ts）。
// 只有特徵向量與品質離開 worker；像素（ImageBitmap 轉移進去後）留在 worker，用完即關閉。
// 「校正人臉辨識」要求時（metrics: true）另外帶出單張臉的量測值（大小、角度、亮度、碰到哪一邊），不含座標或關鍵點。

import type { FaceModelVersion, QualityReason } from "../../shared/identity.ts";
import type { FaceMetrics, QualityOptions } from "./face/quality.ts";

/** 每一格的選項：品質門檻（看著說話用校正值；登記與試認用預設）與是否回傳量測值。 */
export interface FrameOptions {
  quality?: Partial<QualityOptions>;
  metrics?: boolean;
}

export interface FaceRuntimeAssets {
  /** onnxruntime 的 wasm 路徑前綴（同源，例如 /face-runtime/）。 */
  wasmPrefix: string;
  detector: string;
  recognizer: string;
}

export type WorkerRequest =
  | { type: "init"; assets: FaceRuntimeAssets }
  /** bitmap 以 transfer 交給 worker；頁面不留副本。 */
  | { type: "frame"; gen: number; bitmap: ImageBitmap; options?: FrameOptions }
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
  /** 只在 options.metrics 而且畫面裡剛好一張臉時才有。 */
  metrics?: FaceMetrics;
}

export type WorkerResponse =
  | { type: "ready"; model: FaceModelVersion; load_ms: number }
  | FrameResult
  | { type: "error"; gen: number | null; message: string };
