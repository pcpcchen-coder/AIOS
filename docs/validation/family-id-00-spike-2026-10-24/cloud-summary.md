<!-- bilingual: source=zh-TW -->

> [繁體中文](cloud-summary.md) | [English](cloud-summary.en.md)

CLOUD CONTAINER CPU/WASM (headless Chromium) — not a Mac / AR0144 measurement; cosine is a sanity check, not accuracy

## onnxruntime threads=1, crossOriginIsolated=true
模型載入 ms：yunet_fixed640 384、yunet_dynamic 26、mediapipe_short 450、mediapipe_full 166、sface 256；錯誤：{}

| 項目 | 畫格中位數的中位數 ms | 畫格 p95 的最大值 ms | 畫格數 |
|---|---:|---:|---:|
| yunet_fixed640.total | 58.6 | 101.5 | 20 |
| yunet_fixed640.pre | 10.3 | 25.3 | 20 |
| yunet_fixed640.infer | 47.4 | 82.4 | 20 |
| yunet_fixed640.post | 0.2 | 4.5 | 20 |
| yunet_dynamic.total | 130.7 | 203.2 | 20 |
| yunet_dynamic.pre | 15.5 | 54.9 | 20 |
| yunet_dynamic.infer | 112.8 | 185.8 | 20 |
| yunet_dynamic.post | 1.6 | 5.3 | 20 |
| mediapipe_short.total | 13.5 | 58.9 | 20 |
| mediapipe_full.total | 21.2 | 35.9 | 20 |
| sface.total | 60.6 | 122.4 | 20 |
| sface.pre | 1.0 | 1.8 | 20 |
| sface.infer | 59.6 | 121.4 | 20 |
| sface.post | 0.0 | 0.0 | 20 |
| frame_readback | 2.6 | 6.4 | 20 |

| 臉寬目標 px | YuNet 640 | YuNet 動態 | MP short | MP full | YuNet640 實際臉寬 | MP short 與 YuNet640 IoU |
|---|---|---|---|---|---|---|
| 原尺寸 | 5/5 | 5/5 | 5/5 | 5/5 | 137–179 | 0.56–0.76（5 張） |
| 60 | 5/5 | 5/5 | 0/5 | 5/5 | 60–70 | 無配對 |
| 100 | 5/5 | 5/5（含多框） | 2/5 | 5/5 | 99–105 | 0.33–0.39（2 張） |
| 150 | 5/5 | 5/5 | 5/5 | 5/5 | 148–162 | 0.60–0.75（5 張） |

| 臉寬目標 px | 同一人 cosine | 不同人 cosine |
|---|---|---|
| 60 | 0.741–0.796（2 對） | 0.096–0.231（8 對） |
| 100 | 0.726–0.760（2 對） | 0.070–0.232（8 對） |
| 150 | 0.746–0.756（2 對） | 0.074–0.250（8 對） |
| 原尺寸 | 0.728–0.748（2 對） | 0.082–0.212（8 對） |

## onnxruntime threads=4, crossOriginIsolated=true
模型載入 ms：yunet_fixed640 361、yunet_dynamic 30、mediapipe_short 398、mediapipe_full 154、sface 195；錯誤：{}

| 項目 | 畫格中位數的中位數 ms | 畫格 p95 的最大值 ms | 畫格數 |
|---|---:|---:|---:|
| yunet_fixed640.total | 30.7 | 57.2 | 20 |
| yunet_fixed640.pre | 9.8 | 38.3 | 20 |
| yunet_fixed640.infer | 19.0 | 32.9 | 20 |
| yunet_fixed640.post | 0.3 | 6.2 | 20 |
| yunet_dynamic.total | 64.1 | 111.1 | 20 |
| yunet_dynamic.pre | 15.4 | 65.1 | 20 |
| yunet_dynamic.infer | 46.4 | 67.7 | 20 |
| yunet_dynamic.post | 0.8 | 7.4 | 20 |
| mediapipe_short.total | 13.5 | 29.8 | 20 |
| mediapipe_full.total | 21.1 | 39.2 | 20 |
| sface.total | 22.9 | 38.8 | 20 |
| sface.pre | 1.0 | 2.0 | 20 |
| sface.infer | 21.9 | 37.7 | 20 |
| sface.post | 0.0 | 0.0 | 20 |
| frame_readback | 2.6 | 7.2 | 20 |

| 臉寬目標 px | YuNet 640 | YuNet 動態 | MP short | MP full | YuNet640 實際臉寬 | MP short 與 YuNet640 IoU |
|---|---|---|---|---|---|---|
| 原尺寸 | 5/5 | 5/5 | 5/5 | 5/5 | 137–179 | 0.56–0.76（5 張） |
| 60 | 5/5 | 5/5 | 0/5 | 5/5 | 60–70 | 無配對 |
| 100 | 5/5 | 5/5（含多框） | 2/5 | 5/5 | 99–105 | 0.33–0.39（2 張） |
| 150 | 5/5 | 5/5 | 5/5 | 5/5 | 148–162 | 0.60–0.75（5 張） |

| 臉寬目標 px | 同一人 cosine | 不同人 cosine |
|---|---|---|
| 60 | 0.741–0.796（2 對） | 0.096–0.231（8 對） |
| 100 | 0.726–0.760（2 對） | 0.070–0.232（8 對） |
| 150 | 0.746–0.756（2 對） | 0.074–0.250（8 對） |
| 原尺寸 | 0.728–0.748（2 對） | 0.082–0.212（8 對） |

鏡頭模式流程檢查（假鏡頭）：{"device":"Chromium fake video capture (synthetic pattern, no face) — flow check only","loopSamples":9,"yunetFacesOnFakeFeed":0,"noInferenceAfterStop":true,"viewCleared":true,"status":"鏡頭已停止；畫格與參考特徵已清除","offOriginRequests":[],"cspBlockedRequests":[],"consoleErrors":["INFO: Created TensorFlow Lite XNNPACK delegate for CPU.","INFO: Created TensorFlow Lite XNNPACK delegate for CPU."]}

圖片模式：離開本機的請求（Playwright 觀察）0；被 CSP 擋下的連線嘗試 4 ["https://odml.pa.googleapis.com/v1/log"]
鏡頭模式：離開本機的請求 0；被 CSP 擋下 0
