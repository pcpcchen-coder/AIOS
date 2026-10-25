// ID-00 spike：瀏覽器內的模型執行（onnxruntime-web wasm＋MediaPipe Tasks Vision）。不接進產品流程。
// 影像只在記憶體：從本頁畫布讀出像素做成張量，推論完即丟；不寫檔、不進 trace、不送網路。
// 模型與 wasm 由 npm run face:setup 放到 spike/face/public/，執行期只從同源載入。

import * as ort from "onnxruntime-web/wasm";
import {
  padToDivisor,
  planLetterbox,
  postProcessYuNet,
  toSourceCoords,
  YUNET_DEFAULTS,
  YUNET_STRIDES,
  type FaceBox,
  type YuNetFace,
  type YuNetStrideOutput,
} from "./yunet.ts";
import { l2Normalize, rgbaToChw, similarityTransform, warpAffineToChw } from "./sface.ts";

export const SPIKE_ASSETS = {
  ort: "/ort/",
  mediapipeWasm: "/mediapipe-wasm",
  yunetFixed: "/models/face_detection_yunet_2023mar.onnx",
  yunetDynamic: "/models/face_detection_yunet_2026may.onnx",
  sface: "/models/face_recognition_sface_2021dec.onnx",
  blazeShort: "/models/blaze_face_short_range.tflite",
  blazeFull: "/models/blaze_face_full_range.tflite",
};

export type YuNetVariant = "fixed640" | "dynamic";
export type MediaPipeVariant = "short" | "full";

/** 一次偵測的計時（毫秒），分段量測；total 包含讀像素與前後處理。 */
export interface StageTiming {
  total: number;
  pre?: number;
  infer?: number;
  post?: number;
}

export interface DetectResult<F> {
  faces: F[];
  timing: StageTiming;
}

export interface MediaPipeFace {
  box: FaceBox;
  score: number;
}

const now = (): number => performance.now();

export function configureOrt(numThreads: number): void {
  ort.env.wasm.wasmPaths = SPIKE_ASSETS.ort;
  ort.env.wasm.numThreads = numThreads;
  ort.env.logLevel = "error";
}

export function ortThreads(): number {
  return ort.env.wasm.numThreads ?? 1;
}

async function createSession(url: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(url, { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 });
}

/** 2d context；willReadFrequently 讓瀏覽器把畫布留在 CPU，讀像素較快。 */
export function context2d(canvas: HTMLCanvasElement | OffscreenCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("2d canvas unavailable");
  return ctx;
}

export class YuNetRunner {
  private readonly scratch = new OffscreenCanvas(1, 1);
  private constructor(
    readonly variant: YuNetVariant,
    private readonly session: ort.InferenceSession,
  ) {}

  static async load(variant: YuNetVariant): Promise<{ runner: YuNetRunner; loadMs: number }> {
    const t0 = now();
    const session = await createSession(variant === "fixed640" ? SPIKE_ASSETS.yunetFixed : SPIKE_ASSETS.yunetDynamic);
    return { runner: new YuNetRunner(variant, session), loadMs: now() - t0 };
  }

  /** 2023mar：等比縮進 640×640 左上角、右下補黑；2026may：原尺寸補到 32 的倍數（同 OpenCV padWithDivisor）。 */
  async detect(frame: HTMLCanvasElement | OffscreenCanvas): Promise<DetectResult<YuNetFace>> {
    const t0 = now();
    const fw = frame.width;
    const fh = frame.height;
    const lb = this.variant === "fixed640" ? planLetterbox(fw, fh, 640, 640) : { inputW: padToDivisor(fw), inputH: padToDivisor(fh), scale: 1, drawnW: fw, drawnH: fh };
    this.scratch.width = lb.inputW;
    this.scratch.height = lb.inputH;
    const ctx = context2d(this.scratch);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, lb.inputW, lb.inputH);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(frame, 0, 0, fw, fh, 0, 0, lb.drawnW, lb.drawnH);
    const rgba = ctx.getImageData(0, 0, lb.inputW, lb.inputH).data;
    const input = new ort.Tensor("float32", rgbaToChw(rgba, lb.inputW, lb.inputH, "bgr"), [1, 3, lb.inputH, lb.inputW]);
    const t1 = now();
    const out = await this.session.run({ input });
    const t2 = now();
    const pick = (name: string): Float32Array => out[name]!.data as Float32Array;
    const outputs: YuNetStrideOutput[] = YUNET_STRIDES.map((s) => ({ cls: pick(`cls_${s}`), obj: pick(`obj_${s}`), bbox: pick(`bbox_${s}`), kps: pick(`kps_${s}`) }));
    const faces = postProcessYuNet(outputs, lb.inputW, lb.inputH, YUNET_DEFAULTS).map((f) => toSourceCoords(f, lb.scale));
    for (const t of Object.values(out)) t.dispose();
    input.dispose();
    const t3 = now();
    return { faces, timing: { total: t3 - t0, pre: t1 - t0, infer: t2 - t1, post: t3 - t2 } };
  }

  release(): Promise<void> {
    return this.session.release();
  }
}

export class SFaceRunner {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(): Promise<{ runner: SFaceRunner; loadMs: number }> {
    const t0 = now();
    const session = await createSession(SPIKE_ASSETS.sface);
    return { runner: new SFaceRunner(session), loadMs: now() - t0 };
  }

  /** rgba 為整個畫格的像素（呼叫端讀一次即可給多張臉共用）。回傳 L2 normalize 後的 128 維特徵。 */
  async embed(rgba: Uint8ClampedArray, width: number, height: number, face: YuNetFace): Promise<{ feature: Float32Array; timing: StageTiming }> {
    const t0 = now();
    const chw = warpAffineToChw(rgba, width, height, similarityTransform(face.landmarks));
    const data = new ort.Tensor("float32", chw, [1, 3, 112, 112]);
    const t1 = now();
    const out = await this.session.run({ data });
    const t2 = now();
    const fc1 = out.fc1!;
    const feature = l2Normalize(fc1.data as Float32Array);
    fc1.dispose();
    data.dispose();
    const t3 = now();
    return { feature, timing: { total: t3 - t0, pre: t1 - t0, infer: t2 - t1, post: t3 - t2 } };
  }

  release(): Promise<void> {
    return this.session.release();
  }
}

interface MpDetector {
  detect(image: HTMLCanvasElement | OffscreenCanvas): { detections: { boundingBox?: { originX: number; originY: number; width: number; height: number }; categories: { score: number }[] }[] };
  close(): void;
}

export class MediaPipeRunner {
  private constructor(
    readonly variant: MediaPipeVariant,
    private readonly detector: MpDetector,
  ) {}

  static async load(variant: MediaPipeVariant, delegate: "CPU" | "GPU"): Promise<{ runner: MediaPipeRunner; loadMs: number }> {
    const t0 = now();
    const vision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(SPIKE_ASSETS.mediapipeWasm);
    const detector = (await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: variant === "short" ? SPIKE_ASSETS.blazeShort : SPIKE_ASSETS.blazeFull, delegate },
      runningMode: "IMAGE",
      // MediaPipe 預設值（minDetectionConfidence 0.5、minSuppressionThreshold 0.3），不是本專案的校準值。
      minDetectionConfidence: 0.5,
      minSuppressionThreshold: 0.3,
    })) as unknown as MpDetector;
    return { runner: new MediaPipeRunner(variant, detector), loadMs: now() - t0 };
  }

  detect(frame: HTMLCanvasElement | OffscreenCanvas): DetectResult<MediaPipeFace> {
    const t0 = now();
    const result = this.detector.detect(frame);
    const faces = result.detections
      .filter((d) => d.boundingBox)
      .map((d) => ({
        box: { x: d.boundingBox!.originX, y: d.boundingBox!.originY, width: d.boundingBox!.width, height: d.boundingBox!.height },
        score: d.categories[0]?.score ?? 0,
      }));
    return { faces, timing: { total: now() - t0 } };
  }

  close(): void {
    this.detector.close();
  }
}

/** 讀出整個畫格的像素（給 SFace 對齊）；只存在記憶體，呼叫端用完即丟。 */
export function readFrame(frame: HTMLCanvasElement | OffscreenCanvas): { rgba: Uint8ClampedArray; ms: number } {
  const t0 = now();
  const rgba = context2d(frame).getImageData(0, 0, frame.width, frame.height).data;
  return { rgba, ms: now() - t0 };
}
