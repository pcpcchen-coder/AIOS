import type { TtsEngine } from "../../../shared/voice-relay.ts";

// VCR-0／VCR-1（fake）／VCR-2（mac）：輸出端介面。FakeRelayOutput（mock）：不合成、不發聲，只記錄工作並依情境回傳收據；
// MacSayOutput（mac-say.ts）：Mac 的 say 實際從喇叭發聲（沒有在真的 Mac 上驗證過）。Pi 喇叭（VCR-3）尚未實作。
// 收據只說「合成完成／開始播／播完」；就算播完也只代表聲音送出了，不代表音箱照做（結果最多 unconfirmed）。

export type RelaySegment = { kind: "silence"; ms: number } | { kind: "speech"; part: "wake" | "command"; text: string };

export interface RelayJob {
  jobId: string;
  targetId: string;
  outputNode: string;
  outputDeviceId: string;
  engine: TtsEngine;
  voiceId: string;
  modelId?: string;
  segments: RelaySegment[];
  rate: number;
  pitch: number;
  gainDb: number;
}

export interface PlaybackReceipt {
  jobId: string;
  outputNode: string;
  outputDeviceId: string;
  synthesisComplete: boolean;
  audioStarted: boolean;
  audioFinished: boolean;
  failure?: "synthesis_failed" | "device_unavailable" | "start_failed" | "interrupted";
  mock: boolean;
}

/** 診斷畫面用：輸出端現在有哪些聲音與喇叭（fake 是示範清單）。 */
export interface RelayInventory {
  voices: { id: string; locale: string }[];
  devices: { id: string; name: string }[];
  checkedAt: number | null;
  error: string | null;
}

export interface RelayOutput {
  readonly mock: boolean;
  inventory?(): RelayInventory;
  /** 重新讀聲音與喇叭清單（mac）。 */
  refresh?(): Promise<void>;
  voiceAvailable(node: string, engine: TtsEngine, voiceId: string): boolean;
  /** 播一次；不重試。收據可能缺漏或對不上（呼叫端要驗證）。 */
  play(job: RelayJob, signal: AbortSignal): Promise<PlaybackReceipt>;
}

export type FakeScenario = "finished" | "synthesis_failed" | "device_unavailable" | "synthesis_only" | "timeout_mid" | "interrupted" | "receipt_lost" | "wrong_job" | "wrong_device";

export interface FakeRelayOutputOptions {
  voices: { node: string; engine: TtsEngine; voiceId: string; locale?: string }[];
  /** 診斷畫面列出的假喇叭（沒有實體裝置）。 */
  devices?: { id: string; name: string }[];
  scenario?: () => FakeScenario;
}

/** 假輸出（mock）：沒有實體喇叭發聲。 */
export class FakeRelayOutput implements RelayOutput {
  readonly mock = true;
  /** 收到的工作（測試確認播了幾次、播了什麼）。 */
  readonly jobs: RelayJob[] = [];

  constructor(private readonly options: FakeRelayOutputOptions) {}

  inventory(): RelayInventory {
    const voices = new Map<string, string>();
    for (const v of this.options.voices) if (!voices.has(v.voiceId)) voices.set(v.voiceId, v.locale ?? "");
    return { voices: [...voices].map(([id, locale]) => ({ id, locale })), devices: [...(this.options.devices ?? [])], checkedAt: null, error: null };
  }

  voiceAvailable(node: string, engine: TtsEngine, voiceId: string): boolean {
    return this.options.voices.some((v) => v.node === node && v.engine === engine && v.voiceId === voiceId);
  }

  async play(job: RelayJob, signal: AbortSignal): Promise<PlaybackReceipt> {
    this.jobs.push(structuredClone(job));
    const base = { jobId: job.jobId, outputNode: job.outputNode, outputDeviceId: job.outputDeviceId, mock: true };
    const scenario = this.options.scenario?.() ?? "finished";
    switch (scenario) {
      case "finished":
        return { ...base, synthesisComplete: true, audioStarted: true, audioFinished: true };
      case "synthesis_failed":
        return { ...base, synthesisComplete: false, audioStarted: false, audioFinished: false, failure: "synthesis_failed" };
      case "device_unavailable":
        return { ...base, synthesisComplete: true, audioStarted: false, audioFinished: false, failure: "device_unavailable" };
      case "synthesis_only":
        return { ...base, synthesisComplete: true, audioStarted: false, audioFinished: false };
      case "interrupted":
        return { ...base, synthesisComplete: true, audioStarted: true, audioFinished: false, failure: "interrupted" };
      case "receipt_lost":
        return undefined as unknown as PlaybackReceipt;
      case "wrong_job":
        return { ...base, jobId: `${job.jobId}-other`, synthesisComplete: true, audioStarted: true, audioFinished: true };
      case "wrong_device":
        return { ...base, outputDeviceId: `${job.outputDeviceId}-other`, synthesisComplete: true, audioStarted: true, audioFinished: true };
      case "timeout_mid":
        // 已開始播放，但一直沒有播完；中止後丟錯。
        await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
        throw new Error("fake playback aborted mid-way");
    }
  }
}
