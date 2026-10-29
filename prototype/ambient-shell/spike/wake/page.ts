// WK-00 瀏覽器頁：AudioWorklet 擷取 → 16 kHz → 2 秒環形緩衝 → 自建 sherpa-onnx KWS wasm（若有）。
// 開發工具，不是產品畫面。docs/validation/wk-00-spike-2026-10-29.md。
// 隱私：音訊只在記憶體；不錄音（沒有 MediaRecorder）、不轉檔、不建立 blob 網址、不連外，停止時清空緩衝。
// 狀態以裝置事件為準（docs/17 §5.1）：收到 track live 且 worklet 送來第一包樣本後才顯示「本機聆聽中」。

import { resample } from "./audio.ts";
import { buildKeywordsText, candidateById, parseKeywordSpec, type ModelId } from "./keywords.ts";
import { AudioRing } from "./ring-buffer.ts";
import { estimateKeywordSeconds } from "./stats.ts";
import workletUrl from "./capture-worklet.ts?worker&url";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusEl = $<HTMLSpanElement>("status");
const out = $<HTMLPreElement>("out");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");

type State = "off" | "armed" | "listening_local" | "error";
const STATE_TEXT: Record<State, string> = {
  off: "關閉 / off",
  armed: "取得麥克風中 / acquiring microphone",
  listening_local: "本機聆聽中 / listening locally",
  error: "無法使用 / unavailable",
};

function setState(state: State, detail = ""): void {
  statusEl.dataset.state = state;
  statusEl.textContent = detail ? `${STATE_TEXT[state]} — ${detail}` : STATE_TEXT[state];
}

function log(line: string): void {
  out.textContent = `${line}\n${out.textContent ?? ""}`.slice(0, 20000);
}

// 自建 wasm 的 glue（上游 wasm/kws 的 sherpa-onnx-kws.js 與 sherpa-onnx-wasm-kws-main.js）以全域變數溝通。
interface KwsStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
}
interface Kws {
  createStream(): KwsStream;
  isReady(s: KwsStream): boolean;
  decode(s: KwsStream): void;
  reset(s: KwsStream): void;
  getResult(s: KwsStream): { keyword: string; timestamps?: number[] };
  free(): void;
}
declare global {
  interface Window {
    Module?: Record<string, unknown>;
    createKws?: (module: unknown, config: unknown) => Kws;
  }
}

/**
 * 上游 wasm/kws/assets/README.md 要求的檔名（模型在建置時打包進 .data）。固定用 wenetspeech 的 epoch-12 檔名：
 * 若自建時放的是 zh-en 模型（epoch-13），要照這組檔名改名後再建置，否則載入會失敗。
 */
const ASSET_FILES = {
  encoder: "./encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
  decoder: "./decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
  joiner: "./joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
  tokens: "./tokens.txt",
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`missing ${src}`));
    document.head.append(s);
  });
}

let wasmModule: Record<string, unknown> | null = null;

/** 載入自建 wasm；沒有就照實回報，頁面仍可量擷取管線（不宣稱在偵測）。 */
async function loadKws(): Promise<Record<string, unknown> | null> {
  if (wasmModule) return wasmModule;
  try {
    await loadScript("./kws-wasm/sherpa-onnx-kws.js");
    const ready = new Promise<void>((resolve) => {
      window.Module = { locateFile: (p: string) => `./kws-wasm/${p}`, onRuntimeInitialized: () => resolve() };
    });
    await loadScript("./kws-wasm/sherpa-onnx-wasm-kws-main.js");
    await ready;
    wasmModule = window.Module ?? null;
    return wasmModule;
  } catch {
    return null;
  }
}

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  node: AudioWorkletNode;
  ring: AudioRing;
  kws: Kws | null;
  kwsStream: KwsStream | null;
  audioMs: number;
  decodeMs: number;
}
let session: Session | null = null;

async function start(): Promise<void> {
  startBtn.disabled = true;
  setState("armed");
  const model = $<HTMLSelectElement>("model").value as ModelId;
  const threshold = Number($<HTMLInputElement>("threshold").value);
  let keywordsText: string;
  try {
    keywordsText = buildKeywordsText(parseKeywordSpec($<HTMLInputElement>("keywords").value), model);
  } catch (e) {
    setState("error", e instanceof Error ? e.message : String(e));
    startBtn.disabled = false;
    return;
  }
  const mod = await loadKws();
  let kws: Kws | null = null;
  if (mod && window.createKws) {
    kws = window.createKws(mod, {
      featConfig: { samplingRate: 16000, featureDim: 80 },
      modelConfig: { transducer: { encoder: ASSET_FILES.encoder, decoder: ASSET_FILES.decoder, joiner: ASSET_FILES.joiner }, tokens: ASSET_FILES.tokens, provider: "cpu", modelType: "", numThreads: 1, debug: 0, modelingUnit: "", bpeVocab: "" },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.0,
      keywordsThreshold: threshold,
      keywords: "",
      keywordsBuf: keywordsText,
      keywordsBufSize: new TextEncoder().encode(keywordsText).length,
    });
  } else log("未找到自建 KWS wasm，只量擷取管線，不會偵測 / self-built KWS wasm not found: capture pipeline only, no detection");

  try {
    // 與即時語音相同的處理約束（docs/17 §10.3）
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") throw new Error("audio track is not live / 音軌不是 live");
    track.addEventListener("ended", () => stop("麥克風已中斷 / microphone ended"));
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "wk00-capture");
    ctx.createMediaStreamSource(stream).connect(node);
    const s: Session = { stream, ctx, node, ring: new AudioRing(), kws, kwsStream: kws ? kws.createStream() : null, audioMs: 0, decodeMs: 0 };
    session = s;
    let first = true;
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (session !== s) return;
      // AudioContext 剛好是 16 kHz 時 resample 回傳同一個陣列，所以原始塊等用完再一起清
      const pcm = resample(ev.data, ctx.sampleRate, 16000);
      if (first) {
        first = false;
        setState("listening_local", kws ? "" : "沒有 KWS / no KWS");
        stopBtn.disabled = false;
      }
      s.ring.push(pcm);
      s.audioMs += (pcm.length / 16000) * 1000;
      if (s.kws && s.kwsStream) {
        const t0 = performance.now();
        s.kwsStream.acceptWaveform(16000, pcm);
        while (s.kws.isReady(s.kwsStream)) {
          s.kws.decode(s.kwsStream);
          const r = s.kws.getResult(s.kwsStream);
          if (r.keyword) {
            const est = estimateKeywordSeconds(r.timestamps ?? []);
            log(`${new Date().toISOString()}  ${candidateById(r.keyword)?.label ?? r.keyword}  score=null  len≈${est === null ? "?" : est.toFixed(2)}s  load=${((s.decodeMs / Math.max(1, s.audioMs)) * 100).toFixed(1)}%`);
            s.kws.reset(s.kwsStream);
          }
        }
        s.decodeMs += performance.now() - t0;
      }
      pcm.fill(0);
      if (pcm !== ev.data) ev.data.fill(0);
    };
  } catch (e) {
    setState("error", e instanceof Error ? e.message : String(e));
    startBtn.disabled = false;
  }
}

function stop(reason = ""): void {
  const s = session;
  session = null;
  if (s) {
    for (const t of s.stream.getTracks()) t.stop();
    s.node.port.onmessage = null;
    s.node.disconnect();
    void s.ctx.close();
    s.ring.clear();
    s.kwsStream?.free();
    log(`停止 / stopped${reason ? `: ${reason}` : ""}；解碼負載 / decode load ${((s.decodeMs / Math.max(1, s.audioMs)) * 100).toFixed(1)}%`);
  }
  setState("off");
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", () => stop());
window.addEventListener("pagehide", () => stop());
