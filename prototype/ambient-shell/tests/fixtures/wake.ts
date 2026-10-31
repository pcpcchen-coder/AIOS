// 常駐喚醒聆聽（WK-01a）的測試替身。**只在測試使用，永久標示為 fixture**：不代表真的麥克風、真的引擎或真的偵測能力
// （docs/17 §13.3 最後一段：fixture 通過不能代替實機結果）。產品程式不得引用這個檔案（tests/audio-privacy.test.ts 檢查）。

import type { WakeDetector } from "../../src/audio/detector.ts";
import type { EarconPlayback, EarconPlayer } from "../../src/audio/earcon.ts";
import type { CaptureDeps, CaptureEvents, CaptureGraph, MediaDevicesLike } from "../../src/audio/front-end.ts";

/** 假時鐘：測試自己推進，沒有牆鐘斷言。 */
export class FakeClock {
  t = 0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** 假偵測器（fixture）：送進第 n 塊時回報指定的關鍵詞編號；記下收到幾個樣本，但不保存樣本。 */
export class FakeDetector implements WakeDetector {
  chunks = 0;
  samples = 0;
  resets = 0;
  disposed = false;
  constructor(
    private readonly options: { failLoad?: "runtime_missing" | "runtime_load_failed" | "throw"; detectOnChunk?: number; keyword?: number } = {},
  ) {}
  async load(): Promise<void> {
    const fail = this.options.failLoad;
    if (fail === "throw") throw new Error("boom");
    if (fail) {
      const { WakeDetectorError } = await import("../../src/audio/detector.ts");
      throw new WakeDetectorError(fail);
    }
  }
  accept(samples: Float32Array): number | null {
    this.chunks++;
    this.samples += samples.length;
    return this.chunks === this.options.detectOnChunk ? (this.options.keyword ?? 0) : null;
  }
  reset(): void {
    this.resets++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

type Listener = () => void;

/** 假的 MediaStreamTrack：只有 readyState、stop、clone、ended 事件與 deviceId。 */
export class FakeTrack {
  readyState: "live" | "ended" = "live";
  stopped = false;
  private readonly listeners: Listener[] = [];
  constructor(readonly deviceId: string, readonly origin: FakeTrack | null = null) {}
  getSettings(): { deviceId: string } {
    return { deviceId: this.deviceId };
  }
  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }
  clone(): FakeTrack {
    return new FakeTrack(this.deviceId, this);
  }
  addEventListener(type: string, listener: Listener): void {
    if (type === "ended") this.listeners.push(listener);
  }
  /** 模擬拔除：瀏覽器送 ended（stop() 本身不會送）。 */
  unplug(): void {
    this.readyState = "ended";
    for (const listener of this.listeners) listener();
  }
}

export class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  clone(): FakeStream {
    return new FakeStream(this.tracks.map((t) => t.clone()));
  }
}

/** 假的 navigator.mediaDevices：記下每次 getUserMedia 的約束；可設定錯誤、可用裝置與延遲。 */
export class FakeMediaDevices implements MediaDevicesLike {
  calls: MediaStreamConstraints[] = [];
  streams: FakeStream[] = [];
  devices = ["mic-a", "mic-b"];
  defaultDevice = "mic-a";
  failWith: string | null = null;
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** 讓下一次 getUserMedia 停在等待，直到 open()。 */
  hold(): void {
    this.gate = new Promise((resolve) => (this.release = resolve));
  }
  open(): void {
    this.release?.();
    this.gate = null;
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.calls.push(constraints);
    if (this.gate) await this.gate;
    if (this.failWith) throw Object.assign(new Error(this.failWith), { name: this.failWith });
    const audio = constraints.audio as { deviceId?: { exact?: string } };
    const wanted = audio?.deviceId?.exact;
    if (wanted !== undefined && !this.devices.includes(wanted)) throw Object.assign(new Error("Overconstrained"), { name: "OverconstrainedError" });
    const stream = new FakeStream([new FakeTrack(wanted ?? this.defaultDevice)]);
    this.streams.push(stream);
    return stream as unknown as MediaStream;
  }

  /** 目前還沒停止的 track（含複製品）。 */
  liveTracks(): FakeTrack[] {
    return this.streams.flatMap((s) => s.tracks).filter((t) => !t.stopped && t.readyState === "live");
  }
}

/** 假的擷取圖：記下 connect／stop；測試以 started()、detected()、failed() 模擬 worker 事件。 */
export class FakeCapture implements CaptureDeps {
  connects = 0;
  stops = 0;
  graphs: { events: CaptureEvents; stopped: boolean; stream: MediaStream }[] = [];
  failConnect = false;

  async connect(stream: MediaStream, events: CaptureEvents): Promise<CaptureGraph> {
    this.connects++;
    if (this.failConnect) throw new Error("addModule failed");
    const graph = { events, stopped: false, stream };
    this.graphs.push(graph);
    return {
      stop: () => {
        if (graph.stopped) return;
        graph.stopped = true;
        this.stops++;
      },
    };
  }

  get last(): { events: CaptureEvents; stopped: boolean; stream: MediaStream } | undefined {
    return this.graphs.at(-1);
  }

  get active(): number {
    return this.graphs.filter((g) => !g.stopped).length;
  }
}

/** 假提示音：測試決定播完或被取消。 */
export class FakeEarcon implements EarconPlayer {
  plays: { finish(): void; cancelled: boolean }[] = [];
  play(): EarconPlayback {
    let settle: (played: boolean) => void = () => {};
    const done = new Promise<boolean>((resolve) => (settle = resolve));
    const entry = {
      cancelled: false,
      finish: () => settle(true),
    };
    this.plays.push(entry);
    return {
      done,
      cancel: () => {
        entry.cancelled = true;
        settle(false);
      },
    };
  }
}

/** 等所有 microtask 跑完（非同步的開始流程）。 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
