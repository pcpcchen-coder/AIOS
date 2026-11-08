// 方向性診斷的 AudioWorklet：以 channelCountMode "max"、channelInterpretation "discrete" 接上來源，收到的就是
// 真正送進 Web Audio 的每一個聲道（不混音）。做兩件事：
// 1. 約每 100 ms 把「每聲道 RMS（dBFS）與峰值」這幾個數字送給主執行緒（node.port），第一則也報實際聲道數。
// 2. 每個偵測器一條 MessagePort（主執行緒交來）：依該偵測器的來源（產品混音、全部平均、單一聲道）取樣本，
//    累積約 100 ms 一塊、轉移給那個偵測器的 worker。不保存、不轉檔、不送樣本到主執行緒。收到 stop 後清空、不再送出。

import { Chunker, peak, pickSource, type Source } from "./logic.ts";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

interface Route {
  source: Source;
  port: MessagePort;
  chunker: Chunker;
}

class DirectionProcessor extends AudioWorkletProcessor {
  private routes: Route[] = [];
  private stopped = false;
  private readonly levelEvery = Math.round(sampleRate / 10);
  private levelN = 0;
  private sumSq: number[] = [];
  private peaks: number[] = [];

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type?: string; sources?: Source[] }>) => {
      const data = event.data;
      if (data?.type === "routes" && Array.isArray(data.sources) && !this.stopped) {
        this.clearRoutes();
        const size = Math.round(sampleRate / 10);
        this.routes = data.sources.flatMap((source, i) => {
          const port = event.ports[i];
          if (!port) return [];
          return [{ source, port, chunker: new Chunker(size, (full) => port.postMessage(full, [full.buffer])) }];
        });
      } else if (data?.type === "stop") {
        this.stopped = true;
        this.clearRoutes();
      }
    };
  }

  private clearRoutes(): void {
    for (const r of this.routes) {
      r.chunker.stop();
      r.port.close();
    }
    this.routes = [];
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    this.levels(input);
    for (const r of this.routes) {
      const picked = pickSource(input, r.source);
      r.chunker.push(picked);
      picked.fill(0);
    }
    return true;
  }

  private levels(input: Float32Array[]): void {
    if (this.sumSq.length !== input.length) {
      this.sumSq = input.map(() => 0);
      this.peaks = input.map(() => 0);
      this.levelN = 0;
    }
    input.forEach((ch, i) => {
      this.sumSq[i]! += ch.reduce((s, x) => s + x * x, 0);
      this.peaks[i] = Math.max(this.peaks[i]!, peak(ch));
    });
    this.levelN += input[0]!.length;
    if (this.levelN < this.levelEvery) return;
    const rms = this.sumSq.map((s) => {
      const r = Math.sqrt(s / this.levelN);
      return r > 0 ? 20 * Math.log10(r) : -Infinity;
    });
    this.port.postMessage({ type: "levels", channels: input.length, rmsDb: rms.map((x) => (Number.isFinite(x) ? x : -120)), peaks: [...this.peaks] });
    this.levelN = 0;
    this.sumSq = input.map(() => 0);
    this.peaks = input.map(() => 0);
  }
}

registerProcessor("nous-wake-direction", DirectionProcessor);
