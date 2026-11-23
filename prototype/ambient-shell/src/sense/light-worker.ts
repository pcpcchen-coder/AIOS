// VOL-2：環境亮度 worker。頁面把左眼畫格（SensePipeline.sampleFrame 的 ImageBitmap）轉移進來，這裡縮成 64×36、
// 讀像素算平均亮度後立刻關閉畫格，只回傳一個數字。不保存、不上傳、不記錄任何影像（camera-privacy 測試把讀像素限在這裡
// 與家人辨識 worker）。

import { frameLuma } from "../../shared/day-night.ts";

export const LIGHT_W = 64;
export const LIGHT_H = 36;

export type LightWorkerRequest = { type: "frame"; id: number; bitmap: ImageBitmap };
export type LightWorkerResponse = { type: "luma"; id: number; luma: number } | { type: "error"; id: number; message: string };

let canvas: OffscreenCanvas | null = null;

function measure(bitmap: ImageBitmap): number {
  try {
    canvas ??= new OffscreenCanvas(LIGHT_W, LIGHT_H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d canvas unavailable");
    ctx.drawImage(bitmap, 0, 0, LIGHT_W, LIGHT_H);
    const luma = frameLuma(ctx.getImageData(0, 0, LIGHT_W, LIGHT_H).data);
    ctx.clearRect(0, 0, LIGHT_W, LIGHT_H);
    return luma;
  } finally {
    bitmap.close();
  }
}

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<LightWorkerRequest>) => void) | null; postMessage(m: LightWorkerResponse): void };
scope.onmessage = (e) => {
  const req = e.data;
  if (req?.type !== "frame") return;
  try {
    scope.postMessage({ type: "luma", id: req.id, luma: measure(req.bitmap) });
  } catch (err) {
    scope.postMessage({ type: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
