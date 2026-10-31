// 常駐喚醒聆聽的 module worker（WK-01a；WK-01b 準備批次接上真的載入）。檔名刻意不含引擎名稱（tests/wake-privacy.test.ts 檢查建置產物）。
// 輸入：主執行緒的 init（取樣率、引擎檔名清單）與一個 MessagePort（AudioWorklet 的樣本塊從這裡進來）；clear／close。
// 輸出：只有 WakeWorkerOut 事件（worker-core.ts 檢查；close 之後另送 closed），不送出樣本。不寫檔、不用本機儲存。
// 網路：只有載入引擎時經 runtime-net.ts 讀同源 /wake-runtime/ 的清單檔案；讀完位元組後、import 第三方 module 之前先關閉網路全域，import 完再禁止 import()；失敗時兩者都關閉。

import manifest from "../../shared/wake-runtime.json" with { type: "json" };
import { SherpaWasmDetector } from "./detector.ts";
import { createRuntimeNet, type NetScope } from "./runtime-net.ts";
import { WakeWorkerCore } from "./worker-core.ts";
import type { WakeRuntimeManifest, WakeWorkerOut } from "../../shared/wake.ts";

type WakeWorkerIn = { type: "init"; sampleRate: number } | { type: "clear" } | { type: "close" };

interface Scope extends NetScope {
  postMessage(message: WakeWorkerOut): void;
  onmessage: ((event: MessageEvent<WakeWorkerIn>) => void) | null;
  close(): void;
}
const scope = self as unknown as Scope;

let core: WakeWorkerCore | null = null;
let port: MessagePort | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  if (message?.type === "init" && !core && Number.isFinite(message.sampleRate) && message.sampleRate > 0) {
    port = event.ports[0] ?? null;
    const runtime = manifest as WakeRuntimeManifest;
    const net = createRuntimeNet(scope, runtime.url_prefix, runtime.files.map((f) => f.name));
    core = new WakeWorkerCore(new SherpaWasmDetector(runtime, net), (out) => scope.postMessage(out));
    if (port) port.onmessage = (e: MessageEvent<unknown>) => { if (e.data instanceof Float32Array) core?.audio(e.data); };
    void core.init(message.sampleRate);
  } else if (message?.type === "clear") {
    core?.clear();
  } else if (message?.type === "close") {
    // 先以 0 覆寫環形緩衝並釋放偵測器，再告訴主執行緒可以結束 worker（主執行緒最多等 100 ms）。
    core?.close();
    if (port) port.onmessage = null;
    port?.close();
    const closed: WakeWorkerOut = { type: "closed" };
    scope.postMessage(closed);
    scope.close();
  }
};
