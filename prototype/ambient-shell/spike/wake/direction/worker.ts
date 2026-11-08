// 方向性診斷的偵測器 worker：每個變體（來源 × 門檻位移）一個。沿用產品的 SherpaWasmDetector、WakeWorkerCore 與
// runtime-net（同一份 shared/wake-runtime.json、同一個雜湊核對與載入後關閉網路），只把每行關鍵詞門檻加上 delta。
// 樣本從 worklet 的 MessagePort 進來；給主執行緒的只有 started／detected／load_error／closed 事件，不送樣本、不寫檔。
// 引擎檔案由 direction/vite.config.ts 從 npm run wake:setup -- --product 安裝的 wake-runtime/ 提供（只給清單上的檔名）。

import manifest from "../../../shared/wake-runtime.json" with { type: "json" };
import type { WakeRuntimeManifest, WakeWorkerOut } from "../../../shared/wake.ts";
import { SherpaWasmDetector } from "../../../src/audio/detector.ts";
import { createRuntimeNet, type NetScope } from "../../../src/audio/runtime-net.ts";
import { WakeWorkerCore } from "../../../src/audio/worker-core.ts";
import { offsetKeywords } from "./logic.ts";

type In = { type: "init"; sampleRate: number; delta: number } | { type: "close" };

interface Scope extends NetScope {
  postMessage(message: WakeWorkerOut): void;
  onmessage: ((event: MessageEvent<In>) => void) | null;
  close(): void;
}
const scope = self as unknown as Scope;

let core: WakeWorkerCore | null = null;
let port: MessagePort | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "init" && !core && Number.isFinite(message.sampleRate) && message.sampleRate > 0 && Number.isFinite(message.delta)) {
    port = event.ports[0] ?? null;
    const base = manifest as WakeRuntimeManifest;
    const runtime: WakeRuntimeManifest = { ...base, keywords: offsetKeywords(base.keywords, message.delta) };
    const net = createRuntimeNet(scope, runtime.url_prefix, runtime.files.map((f) => f.name));
    core = new WakeWorkerCore(new SherpaWasmDetector(runtime, net), (out) => scope.postMessage(out));
    if (port) port.onmessage = (e: MessageEvent<unknown>) => { if (e.data instanceof Float32Array) core?.audio(e.data); };
    void core.init(message.sampleRate);
  } else if (message?.type === "close") {
    core?.close();
    if (port) port.onmessage = null;
    port?.close();
    scope.postMessage({ type: "closed" });
    scope.close();
  }
};
