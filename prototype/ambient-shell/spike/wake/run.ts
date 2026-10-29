// WK-00：把一段記憶體中的音訊依固定大小分塊送進引擎（模擬即時串流），記錄偵測時間與每塊解碼耗時。

import type { Detection, Spotter } from "./engines.ts";

export const SAMPLE_RATE = 16000;

export interface TimedDetection extends Detection {
  /** 偵測事件發生時已送進引擎的音訊長度（秒，自 offset 起算）。 */
  at: number;
}

export interface FeedResult {
  detections: TimedDetection[];
  /** 每一塊 accept() 的牆鐘耗時（毫秒）。 */
  chunkMs: number[];
}

/**
 * 依 chunkMs（預設 100 ms，與即時麥克風的塊大小相近）把 samples 送進 spotter；offsetSeconds 是這段音訊在整個串流中的起點。
 * 不呼叫 finish()：連續串流由呼叫端決定何時結束。
 */
export function feed(spotter: Spotter, samples: Float32Array, offsetSeconds = 0, chunkMs = 100): FeedResult {
  const chunk = Math.max(1, Math.round((SAMPLE_RATE * chunkMs) / 1000));
  const detections: TimedDetection[] = [];
  const times: number[] = [];
  for (let i = 0; i < samples.length; i += chunk) {
    const part = samples.subarray(i, Math.min(samples.length, i + chunk));
    const t0 = performance.now();
    const found = spotter.accept(part);
    times.push(performance.now() - t0);
    const at = offsetSeconds + (i + part.length) / SAMPLE_RATE;
    for (const d of found) detections.push({ ...d, at });
  }
  return { detections, chunkMs: times };
}
