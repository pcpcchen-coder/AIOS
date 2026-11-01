// 家人聲音登記（SP-01）的錄音器：借麥克風 → AudioContext → 擷取 AudioWorklet（與常駐喚醒同一個）→ MessagePort 直送 speaker worker。
// 主執行緒只下「開始／結束這一段」的指令，拿回特徵與音量數字，碰不到音訊。
// 麥克風：常駐喚醒有開時向 WakeController 租用（KWS 暫停、結束後自動恢復，docs/17 §10.3）；沒有時自己開，約束與即時語音相同
// （AEC／NS／AGC 開著），之後通話中辨認時的聲音才會和登記時同樣處理。結束時一律停止麥克風、關閉 AudioContext、結束 worker。

import workletUrl from "../audio/capture-worklet.ts?worker&url";
import manifest from "../../shared/speaker-runtime.json" with { type: "json" };
import type { SpeakerModelVersion } from "../../shared/identity.ts";
import type { SegmentProblem, SpeakerRuntimeAssets, SpeakerWorkerRequest, SpeakerWorkerResponse } from "./protocol.ts";

export const SPEAKER_RUNTIME_ASSETS: SpeakerRuntimeAssets = {
  wasmPrefix: manifest.url_prefix,
  model: `${manifest.url_prefix}${manifest.files.find((f) => f.role === "speaker")!.name}`,
};

export interface SpeakerWorkerLike {
  postMessage(message: SpeakerWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SpeakerWorkerResponse>) => void) | null;
  terminate(): void;
}

/** 麥克風來源：租用常駐喚醒的串流，或自己開。 */
export interface MicSource {
  acquire(): Promise<MediaStream>;
  release(stream: MediaStream): void;
}

export const OWN_MICROPHONE: MicSource = {
  acquire: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
  release: (stream) => {
    for (const track of stream.getTracks()) track.stop();
  },
};

export interface SegmentResult {
  feature: number[] | null;
  problem: SegmentProblem | null;
  voiced_ms: number;
}

export interface VoiceRecorderDeps {
  mic: MicSource;
  createWorker: () => SpeakerWorkerLike;
  onLevel?: (rms: number) => void;
}

export class VoiceRecorder {
  private worker: SpeakerWorkerLike | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: SegmentResult) => void>();
  model: SpeakerModelVersion | null = null;

  constructor(private readonly deps: VoiceRecorderDeps) {}

  /** 載入模型並打開麥克風；失敗時已開的部分都會關掉再丟錯。 */
  async start(): Promise<void> {
    try {
      const worker = this.deps.createWorker();
      this.worker = worker;
      const ready = new Promise<void>((resolve, reject) => {
        worker.onmessage = (event) => {
          const msg = event.data;
          if (msg.type === "ready") {
            this.model = msg.model;
            resolve();
          } else if (msg.type === "error") {
            reject(new Error(msg.message));
          } else {
            this.onWorkerMessage(msg);
          }
        };
      });
      worker.postMessage({ type: "init", assets: SPEAKER_RUNTIME_ASSETS });
      await ready;
      worker.onmessage = (event) => this.onWorkerMessage(event.data);
      this.stream = await this.deps.mic.acquire();
      // 16 kHz 的 AudioContext：Chromium 會把麥克風轉成這個取樣率；不是的話 worker 自己轉。
      const ctx = new AudioContext({ sampleRate: 16000 });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      const source = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, "nous-wake-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
      this.node = node;
      const channel = new MessageChannel();
      worker.postMessage({ type: "port", sampleRate: ctx.sampleRate }, [channel.port2]);
      node.port.postMessage({ type: "port" }, [channel.port1]);
      source.connect(node);
      // 不接到喇叭：輸出接一個音量 0 的節點，只為了讓圖持續運轉。
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      if (ctx.state === "suspended") await ctx.resume();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /** 提示音（約 0.15 秒、880 Hz）：告訴念的人「現在開始」。在錄音窗開始前播完，不會被錄進去。 */
  chime(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.2, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.16);
  }

  /** 收一段 ms 毫秒的聲音並算特徵（至少要有 minVoicedMs 的人聲）。 */
  async record(ms: number, minVoicedMs: number, wait: (ms: number) => Promise<void> = (t) => new Promise((r) => setTimeout(r, t))): Promise<SegmentResult> {
    const worker = this.worker;
    if (!worker) return { feature: null, problem: "failed", voiced_ms: 0 };
    const id = this.nextId++;
    const result = new Promise<SegmentResult>((resolve) => this.pending.set(id, resolve));
    worker.postMessage({ type: "begin", id });
    await wait(ms);
    if (this.worker !== worker) {
      this.pending.delete(id);
      return { feature: null, problem: "failed", voiced_ms: 0 };
    }
    worker.postMessage({ type: "end", id, min_voiced_ms: minVoicedMs });
    return result;
  }

  private onWorkerMessage(msg: SpeakerWorkerResponse): void {
    if (msg.type === "level") this.deps.onLevel?.(msg.rms);
    else if (msg.type === "segment") {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve?.({ feature: msg.feature, problem: msg.problem, voiced_ms: msg.voiced_ms });
    }
  }

  /** 停止一切：worklet 不再送樣本、麥克風歸還、AudioContext 關閉、worker 結束；等待中的段落回 failed。 */
  stop(): void {
    this.node?.port.postMessage({ type: "stop" });
    this.node?.disconnect();
    this.node = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    if (this.stream) this.deps.mic.release(this.stream);
    this.stream = null;
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
    }
    this.worker = null;
    for (const resolve of this.pending.values()) resolve({ feature: null, problem: "failed", voiced_ms: 0 });
    this.pending.clear();
  }
}
