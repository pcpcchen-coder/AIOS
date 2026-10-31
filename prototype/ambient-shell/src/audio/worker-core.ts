// 常駐喚醒聆聽的 worker 邏輯（WK-01a；純類別，tests/wake-logic.test.ts 直接測，wake-worker.ts 只負責接上訊息）。
// 流程：AudioWorklet 的樣本塊 → 轉 16 kHz → 2 秒環形緩衝 → 偵測器。對外只送出 WakeWorkerOut（started／detected／load_error），
// 每一則都先經 isWakeWorkerOut 檢查：沒有型別陣列、ArrayBuffer 或樣本離開 worker。用過的樣本塊以 0 覆寫。

import { isWakeWorkerOut, type WakeWorkerOut } from "../../shared/wake.ts";
import { WakeDetectorError, type WakeDetector } from "./detector.ts";
import { StreamResampler } from "./resample.ts";
import { AudioRing, SAMPLE_RATE } from "./ring.ts";

export class WakeWorkerCore {
  private readonly ring = new AudioRing();
  private resampler: StreamResampler | null = null;
  private ready = false;
  private started = false;
  private closed = false;

  constructor(
    private readonly detector: WakeDetector,
    private readonly post: (message: WakeWorkerOut) => void,
  ) {}

  /** 載入偵測器；失敗時送 load_error（不會送 started，主執行緒因此不會顯示「本機聆聽中」）。 */
  async init(sampleRate: number): Promise<void> {
    this.resampler = new StreamResampler(sampleRate, SAMPLE_RATE);
    try {
      await this.detector.load();
    } catch (err) {
      this.emit({ type: "load_error", reason: err instanceof WakeDetectorError ? err.reason : "runtime_load_failed" });
      this.close();
      return;
    }
    if (!this.closed) this.ready = true;
  }

  /** 一塊 AudioWorklet 樣本（worker 擁有這塊記憶體）。第一塊真的處理完才送 started。 */
  audio(chunk: Float32Array): void {
    try {
      if (!this.ready || !this.resampler) return;
      const pcm = this.resampler.push(chunk);
      this.ring.push(pcm);
      const keyword = this.detector.accept(pcm);
      pcm.fill(0);
      if (!this.started) {
        this.started = true;
        this.emit({ type: "started" });
      }
      if (keyword !== null) {
        this.detector.reset();
        this.emit({ type: "detected", keyword_index: keyword });
      }
    } finally {
      chunk.fill(0);
    }
  }

  /** 清空環形緩衝與解碼狀態（停用、暫停、鎖定、睡眠、錯誤、通話中）。 */
  clear(): void {
    this.ring.clear();
    this.resampler?.reset();
    this.detector.reset();
  }

  /** 結束：清空並釋放偵測器；之後的樣本一律丟掉。 */
  close(): void {
    this.closed = true;
    this.ready = false;
    this.clear();
    this.detector.dispose();
  }

  /** 測試用：緩衝是否已以 0 覆寫且沒有樣本。 */
  get ringCleared(): boolean {
    return this.ring.length === 0 && this.ring.isZeroed();
  }

  private emit(message: WakeWorkerOut): void {
    if (isWakeWorkerOut(message)) this.post(message);
  }
}
