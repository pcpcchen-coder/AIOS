// 常駐喚醒聆聽的 module worker（WK-01a；WK-01b 準備批次接上真的載入）。檔名刻意不含引擎名稱（tests/wake-privacy.test.ts 檢查建置產物）。
// 輸入：主執行緒的 init（取樣率、模式、已套用的矯正值、門檻調整值）與一個 MessagePort（AudioWorklet 的樣本塊從這裡進來）；clear／close。
// SP-02a：init 可另帶第二個 MessagePort，另一端在 speaker worker（src/speaker/worker.ts）；偵測到喚醒詞時只把那一段樣本轉移過去。
// 「矯正喚醒詞…」（mode: "calibrate"）另有 clip_begin／clip_end／sweep／discard；錄音只留在這個 worker 的記憶體（calibration-core.ts），不交給 speaker worker。
// 輸出：給主執行緒的只有 WakeWorkerOut 事件（worker-core.ts／calibration-core.ts 檢查；close 之後另送 closed），不送出樣本。不寫檔、不用本機儲存。
// 門檻的順序：清單 → 矯正值（keyword_overrides，蓋過那一組的提升分數與門檻）→ 門檻調整值（wake_threshold_offset，加在每一行上）。
// 矯正時「目前設定」與每個候選也加上同一個調整值，所以表格量到的就是套用後實際的行為。
// 網路：只有載入引擎時經 runtime-net.ts 讀同源 /wake-runtime/ 的清單檔案；讀完位元組後、import 第三方 module 之前先關閉網路全域，import 完再禁止 import()；失敗時兩者都關閉。

import manifest from "../../shared/wake-runtime.json" with { type: "json" };
import { WakeCalibrationCore } from "./calibration-core.ts";
import { SherpaWasmDetector, type WakeDetector } from "./detector.ts";
import { createRuntimeNet, type NetScope } from "./runtime-net.ts";
import { WakeWorkerCore } from "./worker-core.ts";
import { applyKeywordOverrides, offsetKeywords, parseKeywordOverrides, parseSweepCandidates, WAKE_THRESHOLD_OFFSETS, type WakeKeywordOverrides, type WakeRuntimeManifest, type WakeWorkerOut } from "../../shared/wake.ts";

type WakeWorkerIn =
  | { type: "init"; sampleRate: number; mode?: unknown; overrides?: unknown; thresholdOffset?: number }
  | { type: "clear" }
  | { type: "close" }
  | { type: "clip_begin" }
  | { type: "clip_end" }
  | { type: "sweep"; candidates: unknown; clips: unknown }
  | { type: "discard" };

interface Scope extends NetScope {
  postMessage(message: WakeWorkerOut): void;
  onmessage: ((event: MessageEvent<WakeWorkerIn>) => void) | null;
  close(): void;
}
const scope = self as unknown as Scope;

let core: WakeWorkerCore | null = null;
let calibration: WakeCalibrationCore | null = null;
let port: MessagePort | null = null;
let keywordPort: MessagePort | null = null;

/** 矯正值不合法就當成沒有（用清單的值），不猜。 */
function overridesOf(value: unknown): WakeKeywordOverrides | null {
  try {
    return value === undefined ? null : parseKeywordOverrides(value);
  } catch {
    return null;
  }
}

/** sweep 的段落清單：每個候選一串段落編號（整數）。 */
function clipLists(value: unknown, n: number): number[][] | null {
  if (!Array.isArray(value) || value.length !== n) return null;
  return value.every((list) => Array.isArray(list) && list.every((k) => Number.isInteger(k) && k >= 0)) ? (value as number[][]) : null;
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "init" && !core && !calibration && Number.isFinite(message.sampleRate) && message.sampleRate > 0) {
    port = event.ports[0] ?? null;
    // 門檻調整值只接受設定的選項之一，其他（含沒有給）一律用產品原本的門檻。
    const offset = (WAKE_THRESHOLD_OFFSETS as readonly unknown[]).includes(message.thresholdOffset) ? (message.thresholdOffset as number) : 0;
    const base = manifest as WakeRuntimeManifest;
    const overrides = overridesOf(message.overrides);
    // 常駐偵測用的關鍵詞：矯正值先蓋上，再加門檻調整值（偵測器因此不用再套一次矯正值）。
    const runtime: WakeRuntimeManifest = { ...base, keywords: offsetKeywords(applyKeywordOverrides(base.keywords, overrides), offset) };
    const net = createRuntimeNet(scope, runtime.url_prefix, runtime.files.map((f) => f.name));
    const detector = new SherpaWasmDetector(runtime, net);
    const post = (out: WakeWorkerOut) => scope.postMessage(out);
    if (message.mode === "calibrate") {
      // 矯正：「目前設定」與每個候選都經這個包裝加上同一個調整值再建掃描用的偵測器。
      const shifted: WakeDetector = {
        load: () => detector.load(),
        accept: (samples) => detector.accept(samples),
        reset: () => detector.reset(),
        dispose: () => detector.dispose(),
        scanner: (keywords) => detector.scanner(offsetKeywords(keywords, offset)),
      };
      const cal = new WakeCalibrationCore(shifted, base.keywords, overrides, post);
      calibration = cal;
      if (port) port.onmessage = (e: MessageEvent<unknown>) => { if (e.data instanceof Float32Array) cal.audio(e.data); };
      void cal.init(message.sampleRate);
    } else {
      keywordPort = event.ports[1] ?? null;
      const toSpeaker = keywordPort ? (span: Float32Array) => keywordPort?.postMessage(span, [span.buffer]) : null;
      const listen = new WakeWorkerCore(detector, post, toSpeaker);
      core = listen;
      if (port) port.onmessage = (e: MessageEvent<unknown>) => { if (e.data instanceof Float32Array) listen.audio(e.data); };
      void listen.init(message.sampleRate);
    }
  } else if (message?.type === "clear") {
    core?.clear();
  } else if (message?.type === "clip_begin") {
    calibration?.beginClip();
  } else if (message?.type === "clip_end") {
    calibration?.endClip();
  } else if (message?.type === "sweep") {
    const candidates = parseSweepCandidates(message.candidates);
    const clips = candidates ? clipLists(message.clips, candidates.length) : null;
    if (candidates && clips) void calibration?.sweep(candidates, clips);
  } else if (message?.type === "discard") {
    calibration?.discard();
  } else if (message?.type === "close") {
    // 先以 0 覆寫環形緩衝（矯正：全部錄音）並釋放偵測器，再告訴主執行緒可以結束 worker（主執行緒最多等 100 ms）。
    core?.close();
    calibration?.close();
    if (port) port.onmessage = null;
    port?.close();
    keywordPort?.close();
    const closed: WakeWorkerOut = { type: "closed" };
    scope.postMessage(closed);
    scope.close();
  }
};
