// WK-01b 準備批次的測試替身。**只在測試使用，永久標示為 fixture**：假的 Emscripten 模組與假的 sherpa-onnx C API，
// 不是真的 wasm、不做任何語音辨識，通過這些測試不代表偵測可用（docs/validation/wk-01b-prep-2026-10-31.md）。
// 用途：讓上游 v2.0.1 的 sherpa-onnx-kws.js（tests/fixtures/wake-wasm/ 的原檔，經 scripts/wake-wasm.mjs esmApi 轉成
// ES module）在 Linux 上跑一遍，核對 SherpaWasmDetector 傳進去的設定（含 keywordsBuf）在 C 結構裡的位置與內容。
// 結構位移照上游 wasm/kws/sherpa-onnx-wasm-main-kws.cc 的 static_assert：特徵 8 bytes、模型 68 bytes、之後 7 個 4 bytes 欄位。

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { esmApi } from "../../scripts/wake-wasm.mjs";
import type { KwsWasmFactoryOptions } from "../../src/audio/detector.ts";
import type { NetScope } from "../../src/audio/runtime-net.ts";
import { WAKE_RUNTIME } from "../../server/wake-runtime.ts";
import type { WakeRuntimeManifest } from "../../shared/wake.ts";

export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** 假 C API 收到的關鍵詞偵測設定（從假 heap 讀回來）。 */
export interface SpotterConfigSeen {
  sampleRate: number;
  featureDim: number;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  numThreads: number;
  provider: string;
  maxActivePaths: number;
  numTrailingBlanks: number;
  keywordsScore: number;
  keywordsThreshold: number;
  keywords: string;
  keywordsBuf: string;
  keywordsBufSize: number;
  fsFiles: string[];
}

export interface FakeKwsModule {
  FS: { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void; files: Map<string, Uint8Array> };
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  [key: string]: unknown;
}

export interface FakeEngineControls {
  /** 下一次 getResult 依序回傳的 keyword（"" 表示沒有）。 */
  script: string[];
  /** 建立 spotter 時回傳 0（例如關鍵詞發音單元不在模型 tokens 裡）。 */
  rejectSpotter: boolean;
  seen: SpotterConfigSeen | null;
  accepted: number;
  resets: number;
  destroyed: { spotter: number; stream: number };
  /** 每次 acceptWaveform 時樣本暫存位址（用來檢查用過後被 0 覆寫）。 */
  lastSamplePtr: number;
  lastSampleCount: number;
}

/** 假的 Emscripten 模組（fixture）：小型 heap、bump allocator、記憶體檔案系統與上游 C API 的假實作。 */
export function fakeKwsModule(controls: FakeEngineControls): FakeKwsModule {
  const heap = new ArrayBuffer(1 << 20);
  const HEAPU8 = new Uint8Array(heap);
  const HEAPF32 = new Float32Array(heap);
  const dv = new DataView(heap);
  let next = 16;
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const malloc = (n: number): number => {
    const p = next;
    next += (n + 7) & ~7;
    if (next > heap.byteLength) throw new Error("fake heap exhausted");
    return p;
  };
  const str = (ptr: number): string => {
    let end = ptr;
    while (HEAPU8[end]) end++;
    return new TextDecoder().decode(HEAPU8.subarray(ptr, end));
  };
  let pending = 0;
  return {
    FS: {
      files,
      writeFile: (path, data) => void files.set(path, data.slice()),
      unlink: (path) => {
        if (!files.delete(path)) throw new Error("ENOENT");
      },
    },
    HEAPU8,
    HEAPF32,
    _malloc: malloc,
    _free: () => {},
    lengthBytesUTF8: (s: string) => enc.encode(s).length,
    stringToUTF8: (s: string, ptr: number, max: number) => {
      const b = enc.encode(s).subarray(0, max - 1);
      HEAPU8.set(b, ptr);
      HEAPU8[ptr + b.length] = 0;
    },
    UTF8ToString: str,
    setValue: (ptr: number, value: number, type: string) => (type === "float" ? dv.setFloat32(ptr, value, true) : dv.setInt32(ptr, value, true)),
    getValue: (ptr: number) => dv.getInt32(ptr, true),
    _CopyHeap: (src: number, n: number, dst: number) => HEAPU8.copyWithin(dst, src, src + n),
    _SherpaOnnxCreateKeywordSpotter: (ptr: number) => {
      const i32 = (off: number) => dv.getInt32(ptr + off, true);
      const f32 = (off: number) => dv.getFloat32(ptr + off, true);
      controls.seen = {
        sampleRate: i32(0),
        featureDim: i32(4),
        encoder: str(i32(8)),
        decoder: str(i32(12)),
        joiner: str(i32(16)),
        tokens: str(i32(32)),
        numThreads: i32(36),
        provider: str(i32(40)),
        maxActivePaths: i32(76),
        numTrailingBlanks: i32(80),
        keywordsScore: f32(84),
        keywordsThreshold: f32(88),
        keywords: str(i32(92)),
        keywordsBuf: str(i32(96)),
        keywordsBufSize: i32(100),
        fsFiles: [...files.keys()].sort(),
      };
      return controls.rejectSpotter ? 0 : 1;
    },
    _SherpaOnnxCreateKeywordStream: () => 2,
    _SherpaOnnxOnlineStreamAcceptWaveform: (_h: number, _sr: number, p: number, n: number) => {
      controls.accepted++;
      controls.lastSamplePtr = p;
      controls.lastSampleCount = n;
      pending++;
    },
    _SherpaOnnxIsKeywordStreamReady: () => (pending > 0 ? 1 : 0),
    _SherpaOnnxDecodeKeywordStream: () => void pending--,
    _SherpaOnnxGetKeywordResult: () => {
      const json = JSON.stringify({ keyword: controls.script.shift() ?? "", timestamps: [] });
      const bytes = enc.encode(json);
      const jsonPtr = malloc(bytes.length + 1);
      HEAPU8.set(bytes, jsonPtr);
      HEAPU8[jsonPtr + bytes.length] = 0;
      const r = malloc(32);
      dv.setInt32(r + 24, jsonPtr, true);
      return r;
    },
    _SherpaOnnxDestroyKeywordResult: () => {},
    _SherpaOnnxResetKeywordStream: () => void controls.resets++,
    _SherpaOnnxDestroyOnlineStream: () => void controls.destroyed.stream++,
    _SherpaOnnxDestroyKeywordSpotter: () => void controls.destroyed.spotter++,
  };
}

export function engineControls(): FakeEngineControls {
  return { script: [], rejectSpotter: false, seen: null, accepted: 0, resets: 0, destroyed: { spotter: 0, stream: 0 }, lastSamplePtr: 0, lastSampleCount: 0 };
}

let apiModule: Promise<unknown> | null = null;
/** 上游 v2.0.1 sherpa-onnx-kws.js 經建置工具轉成的 ES module（真的上游程式，不是替身）。 */
export function upstreamApiModule(): Promise<unknown> {
  apiModule ??= (() => {
    const text = esmApi(readFileSync(join(import.meta.dirname, "wake-wasm", "sherpa-onnx-kws.v2.0.1.js.txt"), "utf8")) as string;
    const file = join(mkdtempSync(join(tmpdir(), "nous-wake-api-")), "sherpa-onnx-kws.mjs");
    writeFileSync(file, text);
    return import(pathToFileURL(file).href);
  })();
  return apiModule;
}

/** 假的 release 與模型位元組（fixture；不是 wasm、不是模型）。 */
export const FAKE_BYTES: Readonly<Record<string, Uint8Array>> = Object.fromEntries(
  WAKE_RUNTIME.files.map((f) => [f.name, new TextEncoder().encode(`fixture bytes for ${f.name}`)]),
);

/**
 * 測試用的「已建置、關鍵詞已設定」清單：雜湊是上面假位元組的雜湊，關鍵詞是明確標示的 TEST_ 項目。
 * **不是**任何真的建置結果或 George 的決定。
 */
export function builtTestManifest(): WakeRuntimeManifest {
  const m = structuredClone(WAKE_RUNTIME);
  m.status = "built";
  m.build.release_tag = "wake-runtime-2.0.1-000000000000";
  m.build.config_sha256 = "0".repeat(64);
  for (const f of m.files) f.sha256 = sha256(FAKE_BYTES[f.name]!);
  m.keywords = {
    status: "configured",
    model: "zh-en-3M",
    keywords_score: 1.5,
    keywords_threshold: 0.3,
    entries: [
      { id: "TEST_ONE", tokens: "n ǔ s ī", boost: null, threshold: 0.2 },
      { id: "TEST_TWO", tokens: "HH EY1 N UW1 S", boost: 2, threshold: null },
    ],
  };
  return m;
}

export interface FakeScope extends NetScope {
  requests: string[];
  imports: string[];
}

/** 假的 worker 範圍：fetch 從 FAKE_BYTES（或覆寫）回應同源路徑，其他一律 404。 */
export function fakeScope(overrides: Record<string, Uint8Array | number> = {}): FakeScope {
  const requests: string[] = [];
  const scope: FakeScope = {
    requests,
    imports: [],
    fetch: async (input) => {
      requests.push(input);
      const name = input.startsWith("/wake-runtime/") ? input.slice("/wake-runtime/".length) : null;
      const body = name === null ? undefined : (overrides[name] ?? FAKE_BYTES[name]);
      if (typeof body === "number") return { ok: false, status: body, arrayBuffer: async () => new ArrayBuffer(0) };
      if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => body.slice().buffer };
    },
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    WebTransport: class {},
    importScripts: () => {},
    crypto: globalThis.crypto as unknown as NetScope["crypto"],
  };
  return scope;
}

/** 假 glue：記下傳入的選項，回傳假 Emscripten 模組。 */
export function fakeGlue(controls: FakeEngineControls, seen: { options: KwsWasmFactoryOptions | null; module: FakeKwsModule | null }, fail = false) {
  return {
    default: async (options: KwsWasmFactoryOptions) => {
      seen.options = options;
      if (fail) throw new Error("fixture: wasm instantiate failed");
      seen.module = fakeKwsModule(controls);
      return seen.module;
    },
  };
}
