// WK-00：四種 sherpa-onnx KWS 執行方式的統一介面（Node addon 與 npm 的 Node 用 wasm，各兩個版本）。
// 只在 Node 執行；瀏覽器頁另有 page.ts。音訊只在記憶體傳給引擎，這裡不讀寫任何音訊檔。
//
// 2.0.1 是 package.json 的 devDependency（精確版本）。1.13.8 刻意不放進 package.json：它的 Node addon 靜態連結了
// espeak-ng（GPL-3.0，TTS 前端），違反 CLAUDE.md 的授權規則（docs/validation/wk-00-spike-2026-10-29.md §授權）。
// 要比較 1.13.8 時，另外裝在 repo 外：npm i --prefix <repo 外資料夾> sherpa-onnx-node@1.13.8 sherpa-onnx@1.13.8，
// 再以 WAKE_SHERPA_V1_DIR=<該資料夾>/node_modules 指定。兩個版本的 addon 同名，不能在同一個程序載入，所以一次只載一個引擎。

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ModelPaths } from "./models.ts";

export type EngineId = "node@2.0.1" | "wasm@2.0.1" | "node@1.13.8" | "wasm@1.13.8";
export const ENGINE_IDS: readonly EngineId[] = ["node@2.0.1", "wasm@2.0.1", "node@1.13.8", "wasm@1.13.8"];

export interface Detection {
  keyword: string;
  tokens: string[];
  /** 每個發音單元的開始時間（秒，自串流開始）。 */
  timestamps: number[];
}

export interface SpotterOptions {
  threads: number;
  /** 引擎預設的觸發門檻與提升分數；關鍵詞行內的 `#`、`:` 優先。 */
  keywordsThreshold: number;
  keywordsScore: number;
  maxActivePaths: number;
  numTrailingBlanks: number;
}

export const DEFAULT_OPTIONS: SpotterOptions = { threads: 1, keywordsThreshold: 0.25, keywordsScore: 1.0, maxActivePaths: 4, numTrailingBlanks: 1 };

export interface Spotter {
  readonly engine: EngineId;
  /** 實際載入的套件版本（從套件的 package.json 讀）。 */
  readonly packageVersion: string;
  /** 送入 16 kHz 單聲道樣本，回傳這一塊解碼出的偵測。偵測後自動 reset 串流（上游範例的作法）。 */
  accept(samples: Float32Array): Detection[];
  /** 輸入結束：補 0.5 秒靜音並解完剩下的幀。 */
  finish(): Detection[];
  /** 換一段獨立的音訊前重建串流。 */
  restart(): void;
  free(): void;
}

interface RawResult {
  keyword: string;
  tokens?: string[];
  timestamps?: number[];
}

interface NodeStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}
interface NodeKws {
  createStream(): NodeStream;
  isReady(s: NodeStream): boolean;
  decode(s: NodeStream): void;
  reset(s: NodeStream): void;
  getResult(s: NodeStream): RawResult;
}
interface NodeModule {
  KeywordSpotter: new (config: unknown) => NodeKws;
}

interface WasmStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  inputFinished(): void;
  free(): void;
}
interface WasmKws {
  createStream(): WasmStream;
  isReady(s: WasmStream): boolean;
  decode(s: WasmStream): void;
  reset(s: WasmStream): void;
  getResult(s: WasmStream): RawResult;
  free(): void;
}
interface WasmModule {
  createKws(config: unknown): WasmKws;
}

const SAMPLE_RATE = 16000;

/** 依引擎找到套件的 require：2.0.1 從本專案 node_modules，1.13.8 從 WAKE_SHERPA_V1_DIR。 */
function requireFor(engine: EngineId): { req: NodeJS.Require; base: string } {
  if (engine.endsWith("@2.0.1")) return { req: createRequire(import.meta.url), base: join(import.meta.dirname, "..", "..", "node_modules") };
  const dir = process.env.WAKE_SHERPA_V1_DIR;
  if (!dir || !existsSync(dir)) throw new Error("1.13.8 needs WAKE_SHERPA_V1_DIR=<folder outside the repo>/node_modules (see engines.ts) / 需要設定 WAKE_SHERPA_V1_DIR");
  return { req: createRequire(join(dir, "noop.cjs")), base: dir };
}

function packageVersion(base: string, name: string): string {
  return (JSON.parse(readFileSync(join(base, name, "package.json"), "utf8")) as { version: string }).version;
}

function toDetection(r: RawResult): Detection {
  return { keyword: r.keyword, tokens: r.tokens ?? [], timestamps: r.timestamps ?? [] };
}

export function createSpotter(engine: EngineId, model: ModelPaths, keywordsText: string, options: SpotterOptions = DEFAULT_OPTIONS): Spotter {
  const { req, base } = requireFor(engine);
  const wanted = engine.split("@")[1]!;
  const kind = engine.startsWith("node@") ? "node" : "wasm";
  const pkg = kind === "node" ? "sherpa-onnx-node" : "sherpa-onnx";
  const version = packageVersion(base, pkg);
  if (version !== wanted) throw new Error(`${pkg} is ${version}, expected ${wanted}`);
  return kind === "node" ? nodeSpotter(engine, version, req(pkg) as NodeModule, model, keywordsText, options) : wasmSpotter(engine, version, req(pkg) as WasmModule, model, keywordsText, options);
}

function nodeSpotter(engine: EngineId, version: string, mod: NodeModule, model: ModelPaths, keywordsText: string, o: SpotterOptions): Spotter {
  const kws = new mod.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: { transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner }, tokens: model.tokens, numThreads: o.threads, provider: "cpu", debug: 0 },
    maxActivePaths: o.maxActivePaths,
    numTrailingBlanks: o.numTrailingBlanks,
    keywordsScore: o.keywordsScore,
    keywordsThreshold: o.keywordsThreshold,
    keywordsBuf: keywordsText,
    keywordsBufSize: Buffer.byteLength(keywordsText, "utf8"),
  });
  let stream = kws.createStream();
  const drain = (): Detection[] => {
    const found: Detection[] = [];
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r.keyword) {
        found.push(toDetection(r));
        kws.reset(stream);
      }
    }
    return found;
  };
  return {
    engine,
    packageVersion: version,
    accept(samples) {
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      return drain();
    },
    finish() {
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(SAMPLE_RATE / 2) });
      stream.inputFinished();
      return drain();
    },
    restart() {
      stream = kws.createStream();
    },
    free() {
      // Node addon 的物件由 GC 釋放
    },
  };
}

function wasmSpotter(engine: EngineId, version: string, mod: WasmModule, model: ModelPaths, keywordsText: string, o: SpotterOptions): Spotter {
  const kws = mod.createKws({
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
      tokens: model.tokens,
      provider: "cpu",
      modelType: "",
      numThreads: o.threads,
      debug: 0,
      modelingUnit: "",
      bpeVocab: "",
    },
    maxActivePaths: o.maxActivePaths,
    numTrailingBlanks: o.numTrailingBlanks,
    keywordsScore: o.keywordsScore,
    keywordsThreshold: o.keywordsThreshold,
    // keywords 是關鍵詞「檔案路徑」欄位；內容走 keywordsBuf（與 Node addon 相同），不寫暫存檔
    keywords: "",
    keywordsBuf: keywordsText,
    keywordsBufSize: Buffer.byteLength(keywordsText, "utf8"),
  });
  let stream = kws.createStream();
  const drain = (): Detection[] => {
    const found: Detection[] = [];
    while (kws.isReady(stream)) {
      kws.decode(stream);
      const r = kws.getResult(stream);
      if (r.keyword) {
        found.push(toDetection(r));
        kws.reset(stream);
      }
    }
    return found;
  };
  return {
    engine,
    packageVersion: version,
    accept(samples) {
      stream.acceptWaveform(SAMPLE_RATE, samples);
      return drain();
    },
    finish() {
      stream.acceptWaveform(SAMPLE_RATE, new Float32Array(SAMPLE_RATE / 2));
      stream.inputFinished();
      return drain();
    },
    restart() {
      stream.free();
      stream = kws.createStream();
    },
    free() {
      stream.free();
      kws.free();
    },
  };
}
