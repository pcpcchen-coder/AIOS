import { describe, expect, it } from "vitest";
import { KWS_FS_PATHS, kwsConfig, SherpaWasmDetector, WakeDetectorError } from "../src/audio/detector.ts";
import { createRuntimeNet, LOCKED_GLOBALS, NetworkLockedError, type WakeRuntimeNet } from "../src/audio/runtime-net.ts";
import { WakeWorkerCore } from "../src/audio/worker-core.ts";
import { WAKE_RUNTIME } from "../server/wake-runtime.ts";
import { WAKE_RELEASE_FILES, wakeKeywordsText, wakeRuntimeBlockers, type WakeRuntimeManifest, type WakeWorkerOut } from "../shared/wake.ts";
import type { KwsWasmFactoryOptions } from "../src/audio/detector.ts";
import { builtTestManifest, engineControls, FAKE_BYTES, fakeGlue, fakeScope, sha256, upstreamApiModule, type FakeEngineControls, type FakeKwsModule, type FakeScope } from "./fixtures/wake-wasm.ts";

// WK-01b 準備批次：SherpaWasmDetector 在 worker 裡的載入流程，對著**假的** Emscripten 模組（fixture）與上游 v2.0.1 的真
// sherpa-onnx-kws.js（經 scripts/wake-wasm.mjs 轉成 ES module）。這些測試只證明載入、雜湊、設定、事件對應與網路關閉的程式路徑；
// **不證明偵測可用**：沒有真的 wasm、沒有真的模型、沒有聲音。

interface Rig {
  scope: FakeScope;
  net: WakeRuntimeNet;
  controls: FakeEngineControls;
  seen: { options: KwsWasmFactoryOptions | null; module: FakeKwsModule | null };
  detector: SherpaWasmDetector;
}

const importTimeFetchLocked: boolean[] = [];

async function rig(options: { manifest?: WakeRuntimeManifest; bytes?: Record<string, Uint8Array | number>; glueFails?: boolean; badApi?: boolean } = {}): Promise<Rig> {
  importTimeFetchLocked.length = 0;
  const scope = fakeScope(options.bytes);
  const controls = engineControls();
  const seen: Rig["seen"] = { options: null, module: null };
  const api = options.badApi ? {} : await upstreamApiModule();
  const modules: Record<string, unknown> = { [`/wake-runtime/${WAKE_RELEASE_FILES.glue}`]: fakeGlue(controls, seen, options.glueFails), [`/wake-runtime/${WAKE_RELEASE_FILES.api}`]: api };
  const manifest = options.manifest ?? builtTestManifest();
  const net = createRuntimeNet(scope, manifest.url_prefix, manifest.files.map((f) => f.name), async (path) => {
    scope.imports.push(path);
    // 模擬第三方 module 的頂層程式：import 時網路全域必須已經關閉
    let fetchThrew = false;
    try {
      await scope.fetch("/wake-runtime/x");
    } catch (err) {
      fetchThrew = err instanceof NetworkLockedError;
    }
    importTimeFetchLocked.push(fetchThrew);
    if (!(path in modules)) throw new Error(`fixture: no module at ${path}`);
    return modules[path];
  });
  return { scope, net, controls, seen, detector: new SherpaWasmDetector(manifest, net) };
}

function expectLocked(r: Rig): void {
  expect(r.net.locked).toBe(true);
  for (const key of LOCKED_GLOBALS) expect(() => (r.scope as unknown as Record<string, () => unknown>)[key]!(), key).toThrow(NetworkLockedError);
}

/** 出貨的清單，但關鍵詞還在等 George 的數字（2026-10-31 WK-00 之前的狀態；出貨的清單已設定 Hello Nous）。 */
function pendingKeywords(): WakeRuntimeManifest {
  const m = structuredClone(WAKE_RUNTIME);
  m.keywords = { status: "pending_owner_numbers", model: null, keywords_score: null, keywords_threshold: null, entries: [] };
  return m;
}

describe("SherpaWasmDetector with a blocked manifest (built but keywords pending, or pending_first_build)", () => {
  it("reports runtime_missing (keywords pending) without touching the network, and locks the network anyway", async () => {
    const pending = pendingKeywords();
    expect(wakeRuntimeBlockers(pending)).toEqual(["keywords_pending"]);
    const scope = fakeScope();
    const net = createRuntimeNet(scope, pending.url_prefix, pending.files.map((f) => f.name), async () => {
      throw new Error("must not import");
    });
    await expect(new SherpaWasmDetector(pending, net).load()).rejects.toMatchObject({ reason: "runtime_missing" });
    expect(scope.requests).toEqual([]);
    expect(net.locked).toBe(true);
    await expect(net.bytes(WAKE_RELEASE_FILES.wasm)).rejects.toBeInstanceOf(NetworkLockedError);
  });

  it("the worker core turns that into load_error runtime_missing and never says started", async () => {
    const out: WakeWorkerOut[] = [];
    const core = new WakeWorkerCore(new SherpaWasmDetector(pendingKeywords(), null), (m) => out.push(m));
    await core.init(48_000);
    core.audio(new Float32Array(480));
    expect(out).toEqual([{ type: "load_error", reason: "runtime_missing" }]);
  });

  it("a pending_first_build manifest (constructed: no release hashes) also reports runtime_missing without touching the network", async () => {
    const pending = pendingKeywords();
    pending.status = "pending_first_build";
    pending.build.release_tag = null;
    pending.build.config_sha256 = null;
    for (const f of pending.files) if (f.source === "release") f.sha256 = "";
    expect(wakeRuntimeBlockers(pending)).toEqual(["pending_first_build", "hash_missing", "keywords_pending"]);
    const scope = fakeScope();
    const net = createRuntimeNet(scope, pending.url_prefix, pending.files.map((f) => f.name), async () => {
      throw new Error("must not import");
    });
    await expect(new SherpaWasmDetector(pending, net).load()).rejects.toMatchObject({ reason: "runtime_missing" });
    expect(scope.requests).toEqual([]);
    expect(net.locked).toBe(true);
  });
});

describe("SherpaWasmDetector load (fake wasm module, test manifest)", () => {
  it("loads: fetches only listed same-origin files, verifies hashes, passes wasmBinary, writes the model into MEMFS, then locks the network", async () => {
    const r = await rig();
    await r.detector.load();
    const manifest = builtTestManifest();
    const model = manifest.models.find((m) => m.id === "zh-en-3M")!;
    // 只讀需要的 7 個檔案，全部在 /wake-runtime/ 之下（同源相對路徑），沒有另一個模型的檔案
    expect(r.scope.requests.sort()).toEqual(
      [WAKE_RELEASE_FILES.wasm, WAKE_RELEASE_FILES.glue, WAKE_RELEASE_FILES.api, model.encoder, model.decoder, model.joiner, model.tokens].map((n) => `/wake-runtime/${n}`).sort(),
    );
    expect(r.scope.imports).toEqual([`/wake-runtime/${WAKE_RELEASE_FILES.glue}`, `/wake-runtime/${WAKE_RELEASE_FILES.api}`]);
    // 兩個第三方 module 的頂層程式執行時，fetch 等全域已經關閉（lockGlobals 在 import() 之前）
    expect(importTimeFetchLocked.splice(0)).toEqual([true, true]);
    // glue 收到核對過的 wasm 位元組，不自行下載；locateFile 只回傳檔名
    expect(sha256(r.seen.options!.wasmBinary)).toBe(sha256(FAKE_BYTES[WAKE_RELEASE_FILES.wasm]!));
    expect(r.seen.options!.locateFile("x.wasm")).toBe("x.wasm");
    // 模型寫進 Emscripten 記憶體檔案系統，引擎讀到的就是這些路徑
    expect(r.controls.seen!.fsFiles).toEqual(Object.values(KWS_FS_PATHS).sort());
    expect(sha256(r.seen.module!.FS.files.get(KWS_FS_PATHS.encoder)!)).toBe(sha256(FAKE_BYTES[model.encoder]!));
    expectLocked(r);
    await expect(r.net.bytes(WAKE_RELEASE_FILES.wasm)).rejects.toBeInstanceOf(NetworkLockedError);
    await expect(r.net.module(WAKE_RELEASE_FILES.api)).rejects.toBeInstanceOf(NetworkLockedError);
  });

  it("keywords come from the manifest's keyword config via keywordsBuf (as seen by the upstream struct layout)", async () => {
    const r = await rig();
    await r.detector.load();
    const text = "n ǔ s ī #0.2 @TEST_ONE\nHH EY1 N UW1 S :2 @TEST_TWO\n";
    expect(wakeKeywordsText(builtTestManifest().keywords)).toBe(text);
    const seen = r.controls.seen!;
    expect(seen.keywordsBuf).toBe(text);
    expect(seen.keywordsBufSize).toBe(new TextEncoder().encode(text).length);
    expect(seen.keywords).toBe("");
    expect(seen.keywordsScore).toBeCloseTo(1.5, 6);
    expect(seen.keywordsThreshold).toBeCloseTo(0.3, 6);
    expect(seen).toMatchObject({ sampleRate: 16_000, featureDim: 80, numThreads: 1, provider: "cpu", maxActivePaths: 4, numTrailingBlanks: 1, ...{ encoder: KWS_FS_PATHS.encoder, decoder: KWS_FS_PATHS.decoder, joiner: KWS_FS_PATHS.joiner, tokens: KWS_FS_PATHS.tokens } });
    expect(kwsConfig(builtTestManifest()).modelConfig.debug).toBe(0);
    // 出貨的清單（WK-00 Mac：Hello Nous 三種 Nous 念法，提升分數 1.5、門檻 0.15）
    const shipped = kwsConfig(WAKE_RUNTIME);
    expect(shipped.keywordsBuf).toBe("HH AH0 L OW1 N OW1 S @HELLO_NOUS_OW\nHH AH0 L OW1 N AW1 S @HELLO_NOUS_AW\nHH AH0 L OW1 N UW1 S @HELLO_NOUS_UW\n");
    expect(shipped.keywordsScore).toBe(1.5);
    expect(shipped.keywordsThreshold).toBe(0.15);
  });

  it("maps engine results to keyword_index only, ignores unknown keywords, resets after a hit and zero-fills the sample copy in the wasm heap", async () => {
    const r = await rig();
    await r.detector.load();
    r.controls.script.push("", "TEST_TWO", "SOMETHING_ELSE", "TEST_ONE");
    const chunk = () => new Float32Array(1600).fill(0.25);
    expect(r.detector.accept(chunk())).toBeNull();
    const heap = r.seen.module!.HEAPF32;
    const start = r.controls.lastSamplePtr / 4;
    expect([...heap.subarray(start, start + r.controls.lastSampleCount)].every((v) => v === 0)).toBe(true);
    expect(r.detector.accept(chunk())).toBe(1);
    expect(r.controls.resets).toBe(1);
    expect(r.detector.accept(chunk())).toBeNull(); // 不在清單上的關鍵詞：重設但不回報
    expect(r.controls.resets).toBe(2);
    expect(r.detector.accept(chunk())).toBe(0);
    // 經過 worker core：只送出 { type: "detected", keyword_index }
    const out: WakeWorkerOut[] = [];
    const r2 = await rig();
    const core = new WakeWorkerCore(r2.detector, (m) => out.push(m));
    await core.init(16_000);
    r2.controls.script.push("TEST_TWO");
    core.audio(new Float32Array(1600).fill(0.1));
    expect(out).toEqual([{ type: "started" }, { type: "detected", keyword_index: 1 }]);
    core.close();
    expect(r2.controls.destroyed).toEqual({ spotter: 1, stream: 1 });
    expect(r2.seen.module!.FS.files.size).toBe(0);
  });

  const failures: [string, Parameters<typeof rig>[0]][] = [
    ["a hash mismatch (wasm)", { bytes: { [WAKE_RELEASE_FILES.wasm]: new TextEncoder().encode("tampered") } }],
    ["a hash mismatch (glue JS, before import)", { bytes: { [WAKE_RELEASE_FILES.glue]: new TextEncoder().encode("tampered") } }],
    ["a missing file (HTTP 404)", { bytes: { "zh-en-3M.tokens.txt": 404 } }],
    ["a wasm instantiate failure", { glueFails: true }],
    ["an API module without createKws", { badApi: true }],
  ];
  for (const [what, options] of failures) {
    it(`reports runtime_load_failed on ${what} and still locks the network`, async () => {
      const r = await rig(options);
      await expect(r.detector.load()).rejects.toMatchObject({ reason: "runtime_load_failed" });
      expectLocked(r);
      expect(r.detector.accept(new Float32Array(160))).toBeNull();
      if (what.startsWith("a hash mismatch")) expect(r.scope.imports).toEqual([]);
    });
  }

  it("reports runtime_load_failed when the engine rejects the keywords (spotter handle 0) and cleans MEMFS", async () => {
    const r = await rig();
    r.controls.rejectSpotter = true;
    await expect(r.detector.load()).rejects.toBeInstanceOf(WakeDetectorError);
    expect(r.seen.module!.FS.files.size).toBe(0);
    expectLocked(r);
  });
});

describe("runtime-net (worker network boundary)", () => {
  it("only serves listed names under /wake-runtime/ and refuses everything once locked", async () => {
    const scope = fakeScope();
    const net = createRuntimeNet(scope, "/wake-runtime/", [WAKE_RELEASE_FILES.wasm, "../etc/passwd", "a/b.wasm"], async () => ({}));
    expect(() => createRuntimeNet(scope, "https://example.com/", [], async () => ({}))).toThrow();
    await expect(net.bytes("other.wasm")).rejects.toThrow(/not a listed/);
    await expect(net.bytes("../etc/passwd")).rejects.toThrow(/not a listed/);
    await expect(net.bytes("a/b.wasm")).rejects.toThrow(/not a listed/);
    await expect(net.module("other.mjs")).rejects.toThrow(/not a listed/);
    expect(await net.sha256(FAKE_BYTES[WAKE_RELEASE_FILES.wasm]!)).toBe(sha256(FAKE_BYTES[WAKE_RELEASE_FILES.wasm]!));
    expect(sha256(await net.bytes(WAKE_RELEASE_FILES.wasm))).toBe(sha256(FAKE_BYTES[WAKE_RELEASE_FILES.wasm]!));
    expect(scope.requests).toEqual([`/wake-runtime/${WAKE_RELEASE_FILES.wasm}`]);
    // 兩步：lockGlobals 之後 bytes() 拒絕、module() 仍可用；lockImports 之後 module() 也拒絕
    net.lockGlobals();
    net.lockGlobals(); // 可重複呼叫
    expect(net.locked).toBe(false);
    await expect(net.bytes(WAKE_RELEASE_FILES.wasm)).rejects.toBeInstanceOf(NetworkLockedError);
    await expect(net.module(WAKE_RELEASE_FILES.wasm)).resolves.toEqual({});
    net.lockImports();
    net.lock();
    expect(net.locked).toBe(true);
    await expect(net.module(WAKE_RELEASE_FILES.wasm)).rejects.toBeInstanceOf(NetworkLockedError);
    await expect(net.bytes(WAKE_RELEASE_FILES.wasm)).rejects.toBeInstanceOf(NetworkLockedError);
    for (const key of LOCKED_GLOBALS) {
      expect(() => (scope as unknown as Record<string, () => unknown>)[key]!(), key).toThrow(NetworkLockedError);
      // 不可寫、不可重新設定：第三方程式也換不回來
      expect(Object.getOwnPropertyDescriptor(scope, key)).toMatchObject({ writable: false, configurable: false });
      expect(() => {
        "use strict";
        (scope as unknown as Record<string, unknown>)[key] = () => "restored";
      }).toThrow(TypeError);
    }
    expect(scope.requests).toHaveLength(1);
  });
});
