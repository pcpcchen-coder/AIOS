// 家人聲音登記（SP-01）的 worker 訊息（src/speaker/worker.ts ↔ recorder.ts）。
// 麥克風樣本由 AudioWorklet 經 MessagePort 直接送進 worker，頁面主執行緒看不到音訊；離開 worker 的只有聲音特徵
// （192 維、L2 normalize）、有聲毫秒數與音量數字。錄音在算完特徵後以 0 覆寫。

import type { SpeakerModelVersion } from "../../shared/identity.ts";

export interface SpeakerRuntimeAssets {
  /** onnxruntime 的 wasm 路徑前綴（同源，例如 /speaker-runtime/）。 */
  wasmPrefix: string;
  model: string;
}

export type SpeakerWorkerRequest =
  | { type: "init"; assets: SpeakerRuntimeAssets }
  /** AudioWorklet 的輸出 port（transfer）與 AudioContext 的取樣率；worker 自己轉成 16 kHz。 */
  | { type: "port"; sampleRate: number }
  /** 開始收這一段（之前收到的樣本丟掉）。 */
  | { type: "begin"; id: number }
  /** 結束這一段並算特徵；min_voiced_ms 是這一段至少要有多少人聲。 */
  | { type: "end"; id: number; min_voiced_ms: number }
  /**
   * SP-02a：喚醒 worker 的喚醒詞片段 port（transfer）。偵測到喚醒詞時那一段 16 kHz 樣本直接從這裡進來，worker 算完回 keyword。
   * 新的 port 取代舊的（喚醒 worker 每次重建都會給一條新的）。
   */
  | { type: "keyword_port" }
  | { type: "dispose" };

export type SegmentProblem = "too_short" | "too_quiet" | "failed";

export type SpeakerWorkerResponse =
  | { type: "ready"; model: SpeakerModelVersion; load_ms: number }
  /** 約每 100 ms 一次的音量（0–1 的 RMS），給畫面的音量條用。 */
  | { type: "level"; rms: number }
  | { type: "segment"; id: number; feature: number[] | null; problem: SegmentProblem | null; voiced_ms: number; ms: number }
  /** SP-02a：喚醒詞片段的特徵（喚醒 worker 送來一段就回一則）。 */
  | { type: "keyword"; feature: number[] | null; problem: SegmentProblem | null; voiced_ms: number; ms: number }
  | { type: "error"; message: string };
