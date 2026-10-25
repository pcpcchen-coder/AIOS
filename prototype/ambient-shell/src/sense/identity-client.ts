// 家人辨識的取樣器（頁面端）：在「家人辨識」畫面（ID-01），以及看著說話的面向等待期間（ID-02，src/sense/identity-ambient.ts）運作；
// 不做背景持續辨識。
// - 最多 4 Hz（兩次取樣至少相隔 SAMPLE_INTERVAL_MS）、同時最多一個推論；推論還沒回來就不取下一格（不排隊）。
//   每 POLL_MS 檢查一次，推論一回來、間隔也到了就立刻取下一格，不必等下一個 250 ms 整點，
//   讓相鄰畫格的間隔盡量貼近推論時間（證據與登記規則要求相鄰兩格不超過 500 ms）。
// - 世代：start／stop 都加一，晚到的舊世代結果一律丟掉；stop 會結束 worker（模型、畫布與暫存都跟著釋放）。
// - 取樣出口在 SensePipeline.sampleFrame()：把左眼畫格做成 ImageBitmap 轉移給 worker，頁面不留副本。

import manifest from "../../shared/face-runtime.json" with { type: "json" };
import type { FaceModelVersion, QualityReason } from "../../shared/identity.ts";
import type { FaceRuntimeAssets, WorkerRequest, WorkerResponse } from "./identity-protocol.ts";

export const SAMPLE_INTERVAL_MS = 250;
export const POLL_MS = 50;

/** 畫格來源：鏡頭沒在運作時回 null。 */
export interface FrameSource {
  sampleFrame(): Promise<ImageBitmap | null>;
}

/** Worker 的最小介面（測試用假的）。 */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/** 頁面收到的一格（時間是頁面時鐘；比對與證據在核心，以核心時鐘為準）。 */
export interface ClientFrame {
  gen: number;
  t: number;
  face_count: number;
  quality: QualityReason;
  feature?: Float32Array;
}

export type ClientState =
  | { kind: "loading" }
  | { kind: "ready"; model: FaceModelVersion }
  | { kind: "no_camera" }
  | { kind: "error"; message: string };

export interface IdentityClientOptions {
  source: FrameSource;
  createWorker: () => WorkerLike;
  onFrame: (frame: ClientFrame) => void;
  onState: (state: ClientState) => void;
  assets?: FaceRuntimeAssets;
  now?: () => number;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  /**
   * 下一個取樣世代。家人辨識畫面給一個在整個畫面期間單調遞增的計數器，換新的 client 也不會從 0 重來，
   * 核心的證據就不會把新 client 的畫格接到舊 client 的世代上。未提供時用 client 自己的計數。
   */
  generation?: () => number;
  clearInterval?: (handle: unknown) => void;
}

export const FACE_RUNTIME_ASSETS: FaceRuntimeAssets = {
  wasmPrefix: manifest.url_prefix,
  detector: `${manifest.url_prefix}${manifest.files.find((f) => f.role === "detector")!.name}`,
  recognizer: `${manifest.url_prefix}${manifest.files.find((f) => f.role === "recognizer")!.name}`,
};

export class IdentityClient {
  private worker: WorkerLike | null = null;
  private timer: unknown = null;
  private gen = 0;
  private ready = false;
  private inFlight = false;
  /** 正在 worker 裡的那一格的世代：舊世代的結果回來時也要清掉 inFlight，才不會卡住（pause 後重新開始取樣）。 */
  private inFlightGen: number | null = null;
  /** 每次取樣加一：被暫停的那次取樣回來時，只有它仍是最新一次才清 inFlight。 */
  private sampleToken = 0;
  private lastSampleAt: number | null = null;
  private readonly now: () => number;

  constructor(private readonly options: IdentityClientOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  get generation(): number {
    return this.gen;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 開始取樣；已在運作時不重複。 */
  start(): void {
    if (this.timer !== null) return;
    this.gen = this.nextGeneration();
    // pause() 之後 worker 裡可能還有上一個世代的一格：等它回來（receive 會清 inFlight）再取下一格，同時最多一個推論。
    if (this.inFlightGen === null) this.inFlight = false;
    this.lastSampleAt = null;
    if (!this.worker) {
      this.ready = false;
      const worker = this.options.createWorker();
      worker.onmessage = (event) => this.receive(event.data);
      worker.onerror = (event) => this.options.onState({ kind: "error", message: event.message || "辨識 worker 發生錯誤" });
      this.worker = worker;
      this.options.onState({ kind: "loading" });
      worker.postMessage({ type: "init", assets: this.options.assets ?? FACE_RUNTIME_ASSETS });
    }
    const every = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = every(() => void this.tick(), POLL_MS);
  }

  /**
   * 暫停取樣但保留 worker（模型留在記憶體，下次 start() 不必冷啟動；ID-02 看著說話的「模型在功能啟用後預載」）。
   * 世代加一：還在 worker 裡的那一格回來時被丟掉。
   */
  pause(): void {
    this.gen = this.nextGeneration();
    if (this.timer !== null) (this.options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
  }

  /** 停止取樣並結束 worker；晚到的結果因世代不同被丟掉。 */
  stop(): void {
    this.pause();
    this.inFlight = false;
    this.inFlightGen = null;
    this.ready = false;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
      this.worker = null;
    }
  }

  private nextGeneration(): number {
    const next = this.options.generation ? this.options.generation() : this.gen + 1;
    return next > this.gen ? next : this.gen + 1;
  }

  private async tick(): Promise<void> {
    if (!this.ready || this.inFlight || !this.worker) return;
    const now = this.now();
    if (this.lastSampleAt !== null && now - this.lastSampleAt < (this.options.intervalMs ?? SAMPLE_INTERVAL_MS)) return;
    this.lastSampleAt = now;
    const gen = this.gen;
    const token = ++this.sampleToken;
    this.inFlight = true;
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await this.options.source.sampleFrame();
    } catch {
      bitmap = null;
    }
    if (gen !== this.gen || !this.worker) {
      bitmap?.close();
      // 取畫格期間被暫停或換世代：這一格沒送進 worker，下一次 start() 可以直接取樣。
      if (this.sampleToken === token && this.inFlightGen === null) this.inFlight = false;
      return;
    }
    if (!bitmap) {
      this.inFlight = false;
      this.options.onState({ kind: "no_camera" });
      this.options.onFrame({ gen, t: this.now(), face_count: 0, quality: "no_frame" });
      return;
    }
    this.inFlightGen = gen;
    this.worker.postMessage({ type: "frame", gen, bitmap }, [bitmap]);
  }

  private receive(msg: WorkerResponse): void {
    if (msg.type === "ready") {
      this.ready = true;
      this.options.onState({ kind: "ready", model: msg.model });
      return;
    }
    if (msg.gen !== null && msg.gen === this.inFlightGen) {
      this.inFlight = false;
      this.inFlightGen = null;
    }
    if (msg.type === "error") {
      if (msg.gen !== null && msg.gen !== this.gen) return;
      this.inFlight = false;
      this.options.onState({ kind: "error", message: msg.message });
      return;
    }
    if (msg.gen !== this.gen) {
      msg.feature?.fill(0);
      return;
    }
    this.options.onFrame({ gen: msg.gen, t: this.now(), face_count: msg.face_count, quality: msg.quality, ...(msg.feature ? { feature: msg.feature } : {}) });
  }
}
