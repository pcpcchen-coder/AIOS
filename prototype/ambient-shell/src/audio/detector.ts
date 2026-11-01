// 常駐喚醒聆聽的偵測器介面（WK-01a）與 sherpa-onnx KWS wasm 偵測器（WK-01b 準備批次）。worker 只透過這個介面呼叫偵測器；
// 偵測器只回傳關鍵詞編號，不回傳任何音訊。
// SherpaWasmDetector 的載入順序（ADR-0003 §2.6、docs/17 §10.3 方案 A）：
//   1. 清單（shared/wake-runtime.json）有任何阻擋理由（pending_first_build、沒有雜湊、關鍵詞未定）→ runtime_missing，不連網。
//   2. 從同源 /wake-runtime/ 讀 wasm、兩個 JS 與選定模型的 4 個檔案，逐一核對 SHA-256；任一不符 → runtime_load_failed。
//   3. 位元組都讀完之後、import() 任何第三方 module 之前，先覆蓋 worker 的網路全域（runtime-net.ts 的 lockGlobals），
//      所以 module 的頂層程式執行時已不能 fetch／XHR／WebSocket 等；再以 import() 載入兩個（已核對的）ES module，
//      然後 lockImports。失敗時兩者都關閉。之後才以 wasmBinary 初始化 Emscripten 模組（glue 不自行下載任何東西）。
//   4. 模型寫進 Emscripten 的記憶體檔案系統；關鍵詞來自清單的 keywords，經 keywordsBuf 傳入（不讀檔）。
//      使用者以「矯正喚醒詞…」套用的門檻（wake.json 的 keyword_overrides，主執行緒在 init 帶進 worker）蓋過每一行的提升分數與門檻。
// 矯正（scan）：同一個已載入的引擎，每個候選另建一個偵測器掃 worker 記憶體裡的錄音段，用完就釋放並以 0 覆寫 wasm 裡的樣本。
// 第一次 CI 建置與 George 的數字之前，第 1 步就停下：產品照實回報 runtime_missing，不假裝偵測。
// 測試用的假偵測器只在 tests/fixtures/（產品程式不得引用）。

import { applyKeywordOverrides, WAKE_RELEASE_FILES, wakeKeywordsText, wakeRuntimeBlockers, type WakeKeywordConfig, type WakeKeywordOverrides, type WakeRuntimeManifest } from "../../shared/wake.ts";
import type { WakeRuntimeNet } from "./runtime-net.ts";

export type DetectorFailure = "runtime_missing" | "runtime_load_failed";

export class WakeDetectorError extends Error {
  constructor(readonly reason: DetectorFailure) {
    super(reason);
  }
}

export interface WakeDetector {
  /** 載入引擎；失敗時丟 WakeDetectorError。 */
  load(): Promise<void>;
  /** 餵 16 kHz 單聲道樣本；偵測到喚醒詞時回傳關鍵詞編號，否則 null。不得保存或轉送樣本。 */
  accept(samples: Float32Array): number | null;
  /** 清掉解碼狀態（每次偵測後、清空緩衝時）。 */
  reset(): void;
  dispose(): void;
  /**
   * 矯正：用 keywords 另建一個偵測器（同一個已載入的引擎），之後每段錄音各開一個串流掃。不改常駐偵測的設定；
   * 引擎沒載入或關鍵詞不被接受時 null。用完要 free()。
   */
  scanner?(keywords: WakeKeywordConfig): WakeScanner | null;
}

export interface WakeScanner {
  /** 掃一段 16 kHz 錄音，回傳第一個偵測到的清單編號，沒有時 null。不保存、不轉送樣本。 */
  scan(clip: Float32Array): number | null;
  free(): void;
}

// ───────────── 上游 sherpa-onnx v2.0.1 wasm/kws 的介面（只列用到的部分） ─────────────

/** Emscripten 模組（-sMODULARIZE -sEXPORT_ES6，EXPORTED_RUNTIME_METHODS 含 FS 與 HEAPF32）。 */
export interface KwsWasmModule {
  FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  HEAPF32: Float32Array;
}

export interface KwsWasmFactoryOptions {
  wasmBinary: Uint8Array;
  locateFile(path: string): string;
  print(text: string): void;
  printErr(text: string): void;
}

export interface KwsStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
  /** 上游 Stream 的樣本暫存（wasm heap 位址與長度）；用來在用過後以 0 覆寫。 */
  pointer: number | null;
  n: number;
}

export interface KwsSpotter {
  handle: number;
  createStream(): KwsStream;
  isReady(stream: KwsStream): boolean;
  decode(stream: KwsStream): void;
  reset(stream: KwsStream): void;
  getResult(stream: KwsStream): { keyword?: string };
  free(): void;
}

export interface KwsConfig {
  featConfig: { samplingRate: number; featureDim: number };
  modelConfig: {
    transducer: { encoder: string; decoder: string; joiner: string };
    tokens: string;
    provider: "cpu";
    modelType: string;
    numThreads: number;
    debug: number;
    modelingUnit: string;
    bpeVocab: string;
  };
  maxActivePaths: number;
  numTrailingBlanks: number;
  keywordsScore: number;
  keywordsThreshold: number;
  keywords: string;
  keywordsBuf: string;
  keywordsBufSize: number;
}

interface GlueModule {
  default: (options: KwsWasmFactoryOptions) => Promise<KwsWasmModule>;
}
interface ApiModule {
  createKws: (module: KwsWasmModule, config: KwsConfig) => KwsSpotter;
}

const SAMPLE_RATE = 16_000;
/** scan：每次送進引擎的樣本數（0.1 秒）與段落後面補的靜音（讓結尾的喚醒詞也解碼完）。 */
const SCAN_CHUNK = 1600;
const SCAN_TAIL = new Float32Array(SAMPLE_RATE / 2);
/** Emscripten 記憶體檔案系統裡的模型路徑（不是磁碟）。 */
export const KWS_FS_PATHS = { encoder: "/wake-encoder.onnx", decoder: "/wake-decoder.onnx", joiner: "/wake-joiner.onnx", tokens: "/wake-tokens.txt" } as const;
const silent = (): void => {};

/** 依清單產生上游 createKws 的設定（純函式，測試直接檢查）。keywords 預設是清單的關鍵詞（矯正值由呼叫端先蓋上）。 */
export function kwsConfig(manifest: WakeRuntimeManifest, keywords: WakeKeywordConfig = manifest.keywords): KwsConfig {
  const k = keywords;
  const text = wakeKeywordsText(k);
  return {
    featConfig: { samplingRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: KWS_FS_PATHS.encoder, decoder: KWS_FS_PATHS.decoder, joiner: KWS_FS_PATHS.joiner },
      tokens: KWS_FS_PATHS.tokens,
      provider: "cpu",
      modelType: "",
      numThreads: 1,
      debug: 0,
      modelingUnit: "",
      bpeVocab: "",
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: k.keywords_score ?? 1,
    keywordsThreshold: k.keywords_threshold ?? 0.25,
    keywords: "",
    keywordsBuf: text,
    keywordsBufSize: new TextEncoder().encode(text).length,
  };
}

/**
 * sherpa-onnx KWS wasm 偵測器（ADR-0003 §2.6）。只在 worker 執行；net 是 runtime-net.ts（測試傳假的）。
 * 載入失敗一律照實回報：清單未就緒是 runtime_missing，其餘（下載、雜湊、初始化、關鍵詞不被模型接受）是 runtime_load_failed。
 */
export class SherpaWasmDetector implements WakeDetector {
  private module: KwsWasmModule | null = null;
  private api: ApiModule | null = null;
  private spotter: KwsSpotter | null = null;
  private stream: KwsStream | null = null;

  constructor(
    private readonly manifest: WakeRuntimeManifest,
    private readonly net: WakeRuntimeNet | null,
    /** 「矯正喚醒詞…」套用的門檻（null＝清單的值）。 */
    private readonly overrides: WakeKeywordOverrides | null = null,
  ) {}

  async load(): Promise<void> {
    if (wakeRuntimeBlockers(this.manifest).length > 0 || !this.net) {
      this.net?.lock();
      throw new WakeDetectorError("runtime_missing");
    }
    const net = this.net;
    try {
      const model = this.manifest.models.find((m) => m.id === this.manifest.keywords.model);
      if (!model) throw new Error("keywords.model is not a listed model");
      const verified = async (name: string): Promise<Uint8Array> => {
        const file = this.manifest.files.find((f) => f.name === name);
        if (!file) throw new Error("not listed");
        const bytes = await net.bytes(name);
        if ((await net.sha256(bytes)) !== file.sha256) throw new Error("hash mismatch");
        return bytes;
      };
      const wasmBinary = await verified(WAKE_RELEASE_FILES.wasm);
      const models = {
        encoder: await verified(model.encoder),
        decoder: await verified(model.decoder),
        joiner: await verified(model.joiner),
        tokens: await verified(model.tokens),
      };
      // 先核對 JS 的位元組，再以 import() 載入同一路徑。import() 會重新讀取：真正「核對後才執行」的保證來自核心每次讀取都再核對
      // 雜湊（readVerifiedWakeRuntime），而 worker 的 CSP 不允許 blob:，所以不能改成執行這裡核對過的位元組。
      await verified(WAKE_RELEASE_FILES.glue);
      await verified(WAKE_RELEASE_FILES.api);
      // 位元組都讀完了：在任何第三方 module 的頂層程式執行之前，先關閉網路全域。
      net.lockGlobals();
      const glue = (await net.module(WAKE_RELEASE_FILES.glue)) as Partial<GlueModule>;
      const api = (await net.module(WAKE_RELEASE_FILES.api)) as Partial<ApiModule>;
      net.lockImports();
      if (typeof glue.default !== "function" || typeof api.createKws !== "function") throw new Error("unexpected module shape");
      const mod = await glue.default({ wasmBinary, locateFile: (path) => path, print: silent, printErr: silent });
      this.module = mod;
      for (const key of Object.keys(KWS_FS_PATHS) as (keyof typeof KWS_FS_PATHS)[]) mod.FS.writeFile(KWS_FS_PATHS[key], models[key]);
      const spotter = api.createKws(mod, kwsConfig(this.manifest, applyKeywordOverrides(this.manifest.keywords, this.overrides)));
      if (!spotter || !spotter.handle) throw new Error("keyword spotter was not created");
      this.api = api as ApiModule;
      this.spotter = spotter;
      this.stream = spotter.createStream();
    } catch {
      this.dispose();
      throw new WakeDetectorError("runtime_load_failed");
    } finally {
      net.lock();
    }
  }

  accept(samples: Float32Array): number | null {
    const { spotter, stream, module } = this;
    if (!spotter || !stream || !module) return null;
    let hit: number | null = null;
    stream.acceptWaveform(SAMPLE_RATE, samples);
    // 上游把樣本複製到 wasm heap；送進引擎後以 0 覆寫那一塊。
    this.zeroSamples();
    while (spotter.isReady(stream)) {
      spotter.decode(stream);
      const keyword = spotter.getResult(stream).keyword;
      if (keyword) {
        const index = this.manifest.keywords.entries.findIndex((e) => e.id === keyword);
        spotter.reset(stream);
        if (index >= 0 && hit === null) hit = index;
      }
    }
    return hit;
  }

  scanner(keywords: WakeKeywordConfig): WakeScanner | null {
    const { module, api } = this;
    if (!module || !api || keywords.entries.length === 0) return null;
    let spotter: KwsSpotter | null = null;
    try {
      spotter = api.createKws(module, kwsConfig(this.manifest, keywords));
    } catch {
      spotter = null;
    }
    if (!spotter || !spotter.handle) return null;
    const own = spotter;
    const entries = this.manifest.keywords.entries;
    let freed = false;
    return {
      scan: (clip) => {
        if (freed || this.module !== module) return null;
        let stream: KwsStream | null = null;
        let hit: number | null = null;
        try {
          const s = own.createStream();
          stream = s;
          const feed = (samples: Float32Array) => {
            s.acceptWaveform(SAMPLE_RATE, samples);
            zeroStream(module, s);
            while (own.isReady(s)) {
              own.decode(s);
              const keyword = own.getResult(s).keyword;
              if (!keyword) continue;
              own.reset(s);
              const index = entries.findIndex((e) => e.id === keyword);
              if (index >= 0 && hit === null) hit = index;
            }
          };
          for (let i = 0; i < clip.length && hit === null; i += SCAN_CHUNK) feed(clip.subarray(i, i + SCAN_CHUNK));
          if (hit === null) feed(SCAN_TAIL);
          return hit;
        } catch {
          return null;
        } finally {
          zeroStream(module, stream);
          stream?.free();
        }
      },
      free: () => {
        if (freed) return;
        freed = true;
        if (this.module === module) own.free();
      },
    };
  }

  reset(): void {
    if (this.spotter && this.stream) this.spotter.reset(this.stream);
  }

  dispose(): void {
    const { module, stream, spotter } = this;
    this.zeroSamples();
    stream?.free();
    spotter?.free();
    if (module) {
      for (const path of Object.values(KWS_FS_PATHS)) {
        try {
          module.FS.unlink(path);
        } catch {
          // 寫入前就失敗時檔案不存在
        }
      }
    }
    this.stream = null;
    this.spotter = null;
    this.api = null;
    this.module = null;
  }

  private zeroSamples(): void {
    zeroStream(this.module, this.stream);
  }
}

/** 上游把樣本複製到 wasm heap；送進引擎後以 0 覆寫那一塊。 */
function zeroStream(module: KwsWasmModule | null, stream: KwsStream | null): void {
  if (module && stream?.pointer) module.HEAPF32.fill(0, stream.pointer / 4, stream.pointer / 4 + stream.n);
}
