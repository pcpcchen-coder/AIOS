// 「矯正喚醒詞…」的 worker 邏輯（George 2026-11-01；純類別，tests/wake-calibration.test.ts 直接測，wake-worker.ts 只負責接上訊息）。
// 流程：AudioWorklet 的樣本塊 → 轉 16 kHz → 只在提示的錄音視窗（clip_begin～clip_end）內留在 worker 記憶體 → 用目前的設定
// 掃一次、回報有沒有偵測到；最後（sweep）用同一批錄音、每個候選另建一個偵測器掃一次，回報每段的結果。
// 對外只送出 WakeWorkerOut（started／load_error／clip／scan／sweep_done），每一則都先經 isWakeWorkerOut 檢查：
// 沒有型別陣列、ArrayBuffer 或樣本離開 worker。錄音視窗以外的樣本塊用過就以 0 覆寫；discard／close 以 0 覆寫並丟掉全部錄音。
// 不寫檔、不用本機儲存、不連網（引擎載入見 detector.ts）。

import {
  applyKeywordOverrides,
  isWakeWorkerOut,
  WAKE_CALIBRATION_MAX_CANDIDATES,
  WAKE_CALIBRATION_MAX_CLIPS,
  wakeKeywordsForGroup,
  type WakeKeywordConfig,
  type WakeKeywordOverrides,
  type WakeSweepCandidate,
  type WakeWorkerOut,
} from "../../shared/wake.ts";
import { WakeDetectorError, type WakeDetector, type WakeScanner } from "./detector.ts";
import { StreamResampler } from "./resample.ts";
import { SAMPLE_RATE } from "./ring.ts";

/** 一段錄音最長幾秒（提示視窗 5 秒；多的丟掉）。 */
export const MAX_CLIP_SECONDS = 8;
const MAX_CLIP_SAMPLES = MAX_CLIP_SECONDS * SAMPLE_RATE;

export class WakeCalibrationCore {
  private resampler: StreamResampler | null = null;
  private ready = false;
  private started = false;
  private closed = false;
  /** 已錄好的段落（16 kHz）；只在這個物件裡，discard／close 以 0 覆寫。 */
  private clips: Float32Array[] = [];
  /** 錄音視窗開著時的樣本塊。 */
  private recording: { parts: Float32Array[]; length: number } | null = null;
  /** 每次 discard／close 加一：進行中的比較看到不同就停下。 */
  private generation = 0;
  /** 目前設定（清單＋已套用的矯正值）的偵測器，第一段錄完時建立、close 時釋放。 */
  private current: WakeScanner | null = null;

  constructor(
    private readonly detector: WakeDetector,
    private readonly keywords: WakeKeywordConfig,
    private readonly overrides: WakeKeywordOverrides | null,
    private readonly post: (message: WakeWorkerOut) => void,
    /** 比較時每掃一段前後讓出執行緒（讓 discard／close 進得來）；測試注入立即完成的。 */
    private readonly pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
  ) {}

  /** 載入偵測器；失敗時送 load_error（不會送 started）。 */
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

  /** 一塊 AudioWorklet 樣本（worker 擁有這塊記憶體）。錄音視窗以外的不留；第一塊真的處理完才送 started。 */
  audio(chunk: Float32Array): void {
    try {
      if (!this.ready || !this.resampler) return;
      const pcm = this.resampler.push(chunk);
      const rec = this.recording;
      if (rec && rec.length + pcm.length <= MAX_CLIP_SAMPLES) {
        rec.parts.push(pcm);
        rec.length += pcm.length;
      } else pcm.fill(0);
      if (!this.started) {
        this.started = true;
        this.emit({ type: "started" });
      }
    } finally {
      chunk.fill(0);
    }
  }

  /** 開始一段錄音（叮聲之後）。上一段還開著就丟掉；段數到上限時不再錄。 */
  beginClip(): void {
    if (!this.ready) return;
    this.dropRecording();
    if (this.clips.length >= WAKE_CALIBRATION_MAX_CLIPS) return;
    this.recording = { parts: [], length: 0 };
  }

  /** 結束這段：合成一段、留在記憶體，用目前的設定（清單＋已套用的矯正值）掃一次，送出 clip。 */
  endClip(): void {
    const rec = this.recording;
    this.recording = null;
    if (!rec || !this.ready) return;
    const clip = new Float32Array(rec.length);
    let at = 0;
    for (const part of rec.parts) {
      clip.set(part, at);
      at += part.length;
      part.fill(0);
    }
    this.clips.push(clip);
    this.current ??= this.detector.scanner?.(applyKeywordOverrides(this.keywords, this.overrides)) ?? null;
    this.emit({ type: "clip", clip: this.clips.length - 1, keyword_index: scanWith(this.current, clip) });
  }

  /**
   * 比較：每個候選只留那一組關鍵詞、換成候選的值，掃 clips[i] 列出的段落，逐段送出 scan，最後送 sweep_done。
   * 不合法的輸入整份不做。discard／close 之後停下（不送 sweep_done）。
   */
  async sweep(candidates: readonly WakeSweepCandidate[], clips: readonly (readonly number[])[]): Promise<void> {
    if (!this.ready || candidates.length > WAKE_CALIBRATION_MAX_CANDIDATES || clips.length !== candidates.length) return;
    const generation = this.generation;
    for (let ci = 0; ci < candidates.length; ci++) {
      const c = candidates[ci]!;
      await this.pause();
      if (generation !== this.generation || !this.ready) return;
      const scanner = this.detector.scanner?.(wakeKeywordsForGroup(this.keywords, c.group, c)) ?? null;
      try {
        for (const k of clips[ci]!) {
          const clip = this.clips[k];
          if (!Number.isInteger(k) || !clip) continue;
          this.emit({ type: "scan", candidate: ci, clip: k, keyword_index: scanWith(scanner, clip) });
          await this.pause();
          if (generation !== this.generation || !this.ready) return;
        }
      } finally {
        scanner?.free();
      }
    }
    if (generation === this.generation && this.ready) this.emit({ type: "sweep_done" });
  }

  /** 以 0 覆寫並丟掉全部錄音（重新測試、取消）；進行中的比較停下。 */
  discard(): void {
    this.generation++;
    this.dropRecording();
    for (const clip of this.clips) clip.fill(0);
    this.clips = [];
  }

  /** 結束：丟掉全部錄音並釋放偵測器；之後的樣本一律丟掉。 */
  close(): void {
    this.closed = true;
    this.ready = false;
    this.discard();
    this.resampler?.reset();
    this.current?.free();
    this.current = null;
    this.detector.dispose();
  }

  /** 測試用：記憶體裡還留著幾個樣本（錄好的段落加上正在錄的）。 */
  get heldSamples(): number {
    return this.clips.reduce((n, c) => n + c.length, 0) + (this.recording?.length ?? 0);
  }

  private dropRecording(): void {
    for (const part of this.recording?.parts ?? []) part.fill(0);
    this.recording = null;
  }

  private emit(message: WakeWorkerOut): void {
    if (isWakeWorkerOut(message)) this.post(message);
  }
}

/** 掃一段；沒有偵測器（引擎不接受這組關鍵詞）或沒偵測到都是 -1。 */
function scanWith(scanner: WakeScanner | null, clip: Float32Array): number {
  const hit = scanner?.scan(clip) ?? null;
  return hit === null ? -1 : hit;
}
