// 常駐喚醒聆聽的偵測器介面（WK-01a）。worker 只透過這個介面呼叫偵測器；偵測器只回傳關鍵詞編號，不回傳任何音訊。
// WK-01a 產品裡唯一的實作是 SherpaWasmDetector 的佔位版：引擎檔案（自建 sherpa-onnx KWS wasm 與關鍵詞檔）要等 WK-01b
// 才由 GitHub Actions 建置並寫進 shared/wake-runtime.json，所以這裡照實回報 runtime_missing，不假裝偵測。
// 測試用的假偵測器只在 tests/fixtures/（產品程式不得引用）。

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
}

export interface WakeRuntimeAssets {
  /** 同源前綴（/wake-runtime/）。 */
  prefix: string;
  /** shared/wake-runtime.json 列出的檔名；WK-01a 為空。 */
  files: readonly string[];
}

/**
 * sherpa-onnx KWS wasm 偵測器（ADR-0003 §2.6）。WK-01a 只有介面與照實的失敗：清單是空的就是 runtime_missing；
 * 清單有檔案但這一版還不會載入（WK-01b 才接上），回報 runtime_load_failed。兩種情況都不會產生偵測事件。
 */
export class SherpaWasmDetector implements WakeDetector {
  constructor(private readonly assets: WakeRuntimeAssets) {}

  async load(): Promise<void> {
    if (this.assets.files.length === 0) throw new WakeDetectorError("runtime_missing");
    throw new WakeDetectorError("runtime_load_failed");
  }

  accept(): number | null {
    return null;
  }

  reset(): void {}

  dispose(): void {}
}
