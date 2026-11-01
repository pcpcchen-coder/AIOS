// SP-02a 喚醒時認聲音的頁面端（docs/17 §4.1、§4.3）：常駐喚醒聆聽開著時保留一個 speaker worker（模型載入一次）。
// - 喚醒詞片段：喚醒 worker 偵測到時經 keywordPort() 給的 port 直接送進 speaker worker（主執行緒碰不到樣本），算完回特徵。
// - 連線前的話：喚醒開始通話時（attach）向 WakeController 租一份麥克風，接到 speaker worker 收音；問候決策前（finish）
//   結束這一段、算特徵，最多等 FINISH_BUDGET_MS，然後一律停止收音、歸還麥克風。只留在本機，不送雲端（§14 ⑦）。
// 兩段特徵都以 voice_probe 送給核心（綁這次的 wake_id）；核心的回應只有 ok，頁面不知道認成誰。
// 不寫檔、不連網、不用本機儲存；送給核心的只有 192 維特徵、有聲毫秒數與片段種類。

import { VOICE_MIN_VOICED_MS, type IdentityRequest, type SpeakerModelVersion, type VoiceSegment } from "../../shared/identity.ts";
import type { SpeakerWorkerLike } from "./recorder.ts";
import type { SpeakerRuntimeAssets, SpeakerWorkerResponse } from "./protocol.ts";

/** 喚醒詞片段的特徵最多等多久才配對到這次喚醒（偵測到 → 提示音約 0.35 秒 → 開始通話）。 */
export const KEYWORD_MAX_AGE_MS = 5000;
/** 問候決策前等連線前那段話的特徵最多多久（不為了等聲音延後問候，§4.4）。 */
export const FINISH_BUDGET_MS = 250;

export interface WakeVoiceDeps {
  createWorker: () => SpeakerWorkerLike;
  assets: SpeakerRuntimeAssets;
  model: SpeakerModelVersion;
  /** 送給核心（家人辨識的 IPC）；回應不用。 */
  send: (request: IdentityRequest) => Promise<unknown>;
  /** 向常駐喚醒租一份麥克風、歸還。 */
  lease: () => Promise<MediaStream>;
  release: (stream: MediaStream) => void;
  /** 串流接到 worker（recorder.ts 的 tapStream）。 */
  tap: (stream: MediaStream, worker: SpeakerWorkerLike) => Promise<{ stop(): void }>;
  now: () => number;
  wait?: (ms: number) => Promise<void>;
}

interface Keyword {
  feature: number[] | null;
  voiced_ms: number;
  at: number;
}

interface Attached {
  wakeId: string;
  keywordSent: boolean;
  stream: MediaStream | null;
  tap: { stop(): void } | null;
  segment: number | null;
  done: boolean;
}

export class WakeVoice {
  private worker: SpeakerWorkerLike | null = null;
  private ready = false;
  private keyword: Keyword | null = null;
  private attached: Attached | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (r: { feature: number[] | null; voiced_ms: number }) => void>();

  constructor(private readonly deps: WakeVoiceDeps) {}

  /** 建立 worker、載入模型（背景進行；失敗就整個停用，喚醒照常）。 */
  start(): void {
    if (this.worker) return;
    const worker = this.deps.createWorker();
    this.worker = worker;
    worker.onmessage = (event) => this.onMessage(event.data);
    worker.postMessage({ type: "init", assets: this.deps.assets });
  }

  /** 給喚醒 worker 的喚醒詞 port（每次建立喚醒 worker 都要一條新的）；worker 不可用時回 null（喚醒 worker 就不複製）。 */
  keywordPort(): MessagePort | null {
    if (!this.worker) return null;
    const channel = new MessageChannel();
    this.worker.postMessage({ type: "keyword_port" }, [channel.port2]);
    return channel.port1;
  }

  /** 喚醒開始了一通電話：送出這次喚醒的喚醒詞特徵（到了就送），並開始收連線前的話。 */
  async attach(wakeId: string): Promise<void> {
    this.cancel();
    if (!this.worker || !this.ready) return;
    const a: Attached = { wakeId, keywordSent: false, stream: null, tap: null, segment: null, done: false };
    this.attached = a;
    this.sendKeyword();
    try {
      const stream = await this.deps.lease();
      if (this.attached !== a || a.done) {
        this.deps.release(stream);
        return;
      }
      a.stream = stream;
      a.tap = await this.deps.tap(stream, this.worker);
      if (this.attached !== a || a.done) return this.stopTap(a);
      a.segment = this.nextId++;
      this.worker.postMessage({ type: "begin", id: a.segment });
    } catch {
      this.stopTap(a);
    }
  }

  /** 問候決策前：結束連線前那段話、送出特徵（最多等 FINISH_BUDGET_MS），然後停止收音、歸還麥克風。 */
  async finish(wakeId: string): Promise<void> {
    const a = this.attached;
    if (!a || a.wakeId !== wakeId || a.done) return;
    a.done = true;
    const worker = this.worker;
    const id = a.segment;
    if (worker && id !== null) {
      const result = new Promise<{ feature: number[] | null; voiced_ms: number } | null>((resolve) => this.pending.set(id, resolve));
      worker.postMessage({ type: "end", id, min_voiced_ms: VOICE_MIN_VOICED_MS.utterance });
      const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const r = await Promise.race([result, wait(FINISH_BUDGET_MS).then(() => null)]);
      this.pending.delete(id);
      if (r) await this.probe(wakeId, "utterance", r.feature, r.voiced_ms);
    }
    this.stopTap(a);
    if (this.attached === a) this.attached = null;
  }

  /** 通話沒開成、被取消或已經結束：停止收音、歸還麥克風，丟掉還沒用的喚醒詞特徵。 */
  cancel(): void {
    const a = this.attached;
    this.attached = null;
    if (a) {
      a.done = true;
      this.stopTap(a);
    }
  }

  dispose(): void {
    this.cancel();
    this.keyword = null;
    if (this.worker) {
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
    }
    this.worker = null;
    this.ready = false;
    for (const resolve of this.pending.values()) resolve({ feature: null, voiced_ms: 0 });
    this.pending.clear();
  }

  private stopTap(a: Attached): void {
    a.tap?.stop();
    a.tap = null;
    if (a.stream) this.deps.release(a.stream);
    a.stream = null;
  }

  private onMessage(msg: SpeakerWorkerResponse): void {
    if (msg.type === "ready") this.ready = true;
    else if (msg.type === "error" && !this.ready) this.dispose();
    else if (msg.type === "keyword") {
      this.keyword = { feature: msg.feature, voiced_ms: msg.voiced_ms, at: this.deps.now() };
      this.sendKeyword();
    } else if (msg.type === "segment") {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve?.({ feature: msg.feature, voiced_ms: msg.voiced_ms });
    }
  }

  /** 喚醒詞特徵與這次喚醒都到了才送（先到的等另一個）；太舊的特徵不配給這次喚醒。 */
  private sendKeyword(): void {
    const a = this.attached;
    const k = this.keyword;
    if (!a || a.keywordSent || !k) return;
    this.keyword = null;
    if (this.deps.now() - k.at > KEYWORD_MAX_AGE_MS) return;
    a.keywordSent = true;
    void this.probe(a.wakeId, "keyword", k.feature, k.voiced_ms);
  }

  private async probe(wakeId: string, segment: VoiceSegment, feature: number[] | null, voicedMs: number): Promise<void> {
    try {
      await this.deps.send({ op: "voice_probe", wake_id: wakeId, segment, voiced_ms: Math.max(0, Math.round(voicedMs)), model: this.deps.model, ...(feature ? { feature } : {}) });
    } catch {
      // 送不到就算了：問候照 ID-02 規則
    }
  }
}
