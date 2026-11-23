// 家人聲音登記（SP-01）與喚醒時認聲音（SP-02a）的推論 worker（module worker）。產品程式中唯一算聲音特徵的地方。
// SP-02a：另一條 port 直接連到喚醒 worker，偵測到喚醒詞時那一段樣本從那裡進來（不經主執行緒），算完回 keyword。
// AudioWorklet 的樣本經 MessagePort 直接進來（主執行緒看不到音訊）→ 轉 16 kHz → begin/end 之間累積一段 →
// 音量判斷留下有人聲的部分（src/speaker/vad.ts）→ 80 維 fbank（src/speaker/fbank.ts）→ CAM++ → 192 維、L2 normalize。
// 回傳特徵與有聲毫秒數；錄音與中間張量用完以 0 覆寫。不寫檔、不連網（模型與 wasm 只從同源 /speaker-runtime/ 讀，
// JS 回應帶 connect-src 'self' 的 CSP）、不用本機儲存。onnxruntime-web 只用 wasm 後端、1 個執行緒。
// SP-00：onnxruntime-web 的 AveragePool（ceil_mode）與 PyTorch 語意相同，和 sherpa-onnx 原生算的特徵不同；
// 登記與辨認都在這裡算，所以結果自洽，不要混用其他工具算的特徵（docs/validation/sp-00-2026-11-01.md）。

import * as ort from "onnxruntime-web/wasm";
import manifest from "../../shared/speaker-runtime.json" with { type: "json" };
import type { SpeakerModelVersion } from "../../shared/identity.ts";
import { StreamResampler } from "../audio/resample.ts";
import { FBANK_BINS, normalizeEmbedding, speakerFbank } from "./fbank.ts";
import { VOICE_MIN_VOICED_MS } from "../../shared/identity.ts";
import type { SegmentProblem, SpeakerRuntimeAssets, SpeakerWorkerRequest, SpeakerWorkerResponse } from "./protocol.ts";
import { voicedSegments } from "./vad.ts";

const MODEL: SpeakerModelVersion = manifest.model_version;
/** 一段最多收幾秒（超過的丟掉；登記的提示最長約 6 秒）。 */
const MAX_SEGMENT_S = 10;
const KEYWORD_MIN_VOICED_MS = VOICE_MIN_VOICED_MS.keyword;
/** 喚醒詞片段最多收幾個樣本（喚醒 worker 送 1.6 秒；多的不收）。 */
const KEYWORD_MAX_SAMPLES = 3 * 16000;

interface Scope {
  postMessage(message: SpeakerWorkerResponse): void;
  onmessage: ((event: MessageEvent<SpeakerWorkerRequest>) => void) | null;
}
const scope = self as unknown as Scope;

let session: ort.InferenceSession | null = null;
let port: MessagePort | null = null;
let keywordPort: MessagePort | null = null;
let resampler: StreamResampler | null = null;
let recording: { id: number; chunks: Float32Array[]; length: number } | null = null;
let levelSum = 0;
let levelCount = 0;

async function init(assets: SpeakerRuntimeAssets): Promise<void> {
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = assets.wasmPrefix;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  session = await ort.InferenceSession.create(assets.model, { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 });
  scope.postMessage({ type: "ready", model: MODEL, load_ms: Math.round(performance.now() - t0) });
}

function onSamples(chunk: Float32Array): void {
  // 16 kHz 時 pcm 就是 chunk 本身：要等量完音量、決定收不收之後才能覆寫，否則收進來的全是 0。
  const pcm = resampler ? resampler.push(chunk) : chunk;
  if (pcm !== chunk) chunk.fill(0);
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i]! * pcm[i]!;
  levelSum += s;
  levelCount += pcm.length;
  if (levelCount >= 1600) {
    scope.postMessage({ type: "level", rms: Math.sqrt(levelSum / levelCount) });
    levelSum = 0;
    levelCount = 0;
  }
  if (recording && recording.length < MAX_SEGMENT_S * 16000) {
    recording.chunks.push(pcm);
    recording.length += pcm.length;
  } else {
    pcm.fill(0);
  }
}

function clearRecording(): void {
  for (const c of recording?.chunks ?? []) c.fill(0);
  recording = null;
}

/** 一段 16 kHz 樣本 → 音量判斷 → fbank → CAM++。all 用完以 0 覆寫。 */
async function embed(all: Float32Array, minVoicedMs: number): Promise<{ feature: number[] | null; problem: SegmentProblem | null; voiced_ms: number }> {
  const voiced = voicedSegments(all);
  all.fill(0);
  let features: Float32Array | null = null;
  try {
    if (voiced.voiced_ms < minVoicedMs) return { feature: null, problem: voiced.peak_rms < 0.01 ? "too_quiet" : "too_short", voiced_ms: voiced.voiced_ms };
    if (!session) throw new Error("模型尚未載入");
    const fb = speakerFbank(voiced.samples);
    features = fb.features;
    const out = await session.run({ x: new ort.Tensor("float32", features, [1, fb.frames, FBANK_BINS]) });
    const raw = out.embedding?.data as Float32Array | undefined;
    const emb = raw ? normalizeEmbedding(raw) : null;
    raw?.fill(0);
    const feature = emb ? Array.from(emb) : null;
    emb?.fill(0);
    return { feature, problem: feature ? null : "failed", voiced_ms: voiced.voiced_ms };
  } finally {
    voiced.samples.fill(0);
    features?.fill(0);
  }
}

async function end(id: number, minVoicedMs: number): Promise<void> {
  const t0 = performance.now();
  const rec = recording;
  recording = null;
  if (!rec || rec.id !== id) {
    scope.postMessage({ type: "segment", id, feature: null, problem: "failed", voiced_ms: 0, ms: 0 });
    return;
  }
  const all = new Float32Array(rec.length);
  let o = 0;
  for (const c of rec.chunks) {
    all.set(c, o);
    o += c.length;
    c.fill(0);
  }
  const r = await embed(all, minVoicedMs);
  scope.postMessage({ type: "segment", id, feature: r.feature, problem: r.problem, voiced_ms: r.voiced_ms, ms: Math.round(performance.now() - t0) });
}

/** SP-02a：喚醒 worker 送來的喚醒詞片段（已是 16 kHz）。 */
async function keyword(span: Float32Array): Promise<void> {
  const t0 = performance.now();
  const r = await embed(span, KEYWORD_MIN_VOICED_MS).catch(() => ({ feature: null, problem: "failed" as const, voiced_ms: 0 }));
  span.fill(0);
  scope.postMessage({ type: "keyword", feature: r.feature, problem: r.problem, voiced_ms: r.voiced_ms, ms: Math.round(performance.now() - t0) });
}

scope.onmessage = (event: MessageEvent<SpeakerWorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    init(msg.assets).catch((err: unknown) => scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }));
  } else if (msg.type === "port") {
    port?.close();
    port = event.ports[0] ?? null;
    resampler = msg.sampleRate === 16000 ? null : new StreamResampler(msg.sampleRate, 16000);
    if (port) port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
  } else if (msg.type === "begin") {
    clearRecording();
    recording = { id: msg.id, chunks: [], length: 0 };
  } else if (msg.type === "end") {
    end(msg.id, msg.min_voiced_ms).catch((err: unknown) => {
      scope.postMessage({ type: "segment", id: msg.id, feature: null, problem: "failed", voiced_ms: 0, ms: 0 });
      scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    });
  } else if (msg.type === "keyword_port") {
    keywordPort?.close();
    keywordPort = event.ports[0] ?? null;
    if (keywordPort) {
      keywordPort.onmessage = (e: MessageEvent<unknown>) => {
        const span = e.data;
        if (!(span instanceof Float32Array)) return;
        if (span.length === 0 || span.length > KEYWORD_MAX_SAMPLES) return void span.fill(0);
        void keyword(span);
      };
    }
  } else if (msg.type === "dispose") {
    clearRecording();
    port?.close();
    port = null;
    keywordPort?.close();
    keywordPort = null;
    void session?.release();
    session = null;
  }
};
