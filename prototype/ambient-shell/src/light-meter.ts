import { LIGHT_SAMPLE_MS } from "../shared/day-night.ts";
import type { LightWorkerRequest, LightWorkerResponse } from "./sense/light-worker.ts";

// VOL-2：每 LIGHT_SAMPLE_MS 從感測管線取一格（SensePipeline.sampleFrame；鏡頭沒開或畫面不正常時是 null，這次就跳過），
// 轉移給亮度 worker（src/sense/light-worker.ts），只拿回平均亮度一個數字。同時最多一格在處理；停止時結束 worker。

export interface LightWorkerLike {
  postMessage(message: LightWorkerRequest, transfer: Transferable[]): void;
  onmessage: ((event: { data: LightWorkerResponse }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface LightMeterDeps {
  sampleFrame(): Promise<ImageBitmap | null>;
  createWorker(): LightWorkerLike;
  onLuma(luma: number): void;
  setInterval?(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval?(id: ReturnType<typeof setInterval>): void;
  now?(): number;
}

/** worker 這麼久沒有回覆就換一個（不讓一次卡住停掉之後每一次量測）。 */
export const LIGHT_REPLY_MS = 10_000;

export class LightMeter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private worker: LightWorkerLike | null = null;
  private busy = false;
  private busySince = 0;
  private nextId = 1;

  constructor(private readonly deps: LightMeterDeps) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = (this.deps.setInterval ?? setInterval)(() => void this.tick(), LIGHT_SAMPLE_MS) as ReturnType<typeof setInterval>;
    void this.tick();
  }

  stop(): void {
    if (this.timer !== null) (this.deps.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }

  /** 量一次（測試直接呼叫）。 */
  async tick(): Promise<void> {
    if (this.timer === null) return;
    const now = (this.deps.now ?? Date.now)();
    if (this.busy) {
      if (now - this.busySince < LIGHT_REPLY_MS) return;
      this.worker?.terminate();
      this.worker = null;
    }
    this.busy = true;
    this.busySince = now;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await this.deps.sampleFrame();
      if (!bitmap || this.timer === null) {
        bitmap?.close();
        this.busy = false;
        return;
      }
      const worker = (this.worker ??= this.deps.createWorker());
      const id = this.nextId++;
      worker.onmessage = (event) => {
        if (event.data.id !== id) return;
        this.busy = false;
        if (event.data.type === "luma" && Number.isFinite(event.data.luma) && this.timer !== null) this.deps.onLuma(event.data.luma);
      };
      // 載入失敗或 worker 內未處理的錯誤：這次不算讀值，下一次換一個新的 worker。
      worker.onerror = () => {
        if (this.worker === worker) this.worker = null;
        worker.terminate();
        this.busy = false;
      };
      worker.postMessage({ type: "frame", id, bitmap }, [bitmap]);
    } catch {
      bitmap?.close();
      this.busy = false;
    }
  }
}
