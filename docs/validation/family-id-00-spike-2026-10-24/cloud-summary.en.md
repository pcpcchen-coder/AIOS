<!-- bilingual: source=zh-TW -->

> [繁體中文](cloud-summary.md) | [English](cloud-summary.en.md)

CLOUD CONTAINER CPU/WASM (headless Chromium) — not a Mac / AR0144 measurement; cosine is a sanity check, not accuracy

## onnxruntime threads=1, crossOriginIsolated=true
Model load ms: yunet_fixed640 384、yunet_dynamic 26、mediapipe_short 450、mediapipe_full 166、sface 256; errors: {}

| Item | Median of frame medians, ms | Maximum frame p95, ms | Frames |
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

| Target face width, px | YuNet 640 | YuNet dynamic | MP short | MP full | YuNet640 actual face width | MP short versus YuNet640 IoU |
|---|---|---|---|---|---|---|
| Original size | 5/5 | 5/5 | 5/5 | 5/5 | 137–179 | 0.56–0.76 (5 images) |
| 60 | 5/5 | 5/5 | 0/5 | 5/5 | 60–70 | No pairs |
| 100 | 5/5 | 5/5 (includes extra boxes) | 2/5 | 5/5 | 99–105 | 0.33–0.39 (2 images) |
| 150 | 5/5 | 5/5 | 5/5 | 5/5 | 148–162 | 0.60–0.75 (5 images) |

| Target face width, px | Same-person cosine | Different-person cosine |
|---|---|---|
| 60 | 0.741–0.796 (2 pairs) | 0.096–0.231 (8 pairs) |
| 100 | 0.726–0.760 (2 pairs) | 0.070–0.232 (8 pairs) |
| 150 | 0.746–0.756 (2 pairs) | 0.074–0.250 (8 pairs) |
| Original size | 0.728–0.748 (2 pairs) | 0.082–0.212 (8 pairs) |

## onnxruntime threads=4, crossOriginIsolated=true
Model load ms: yunet_fixed640 361、yunet_dynamic 30、mediapipe_short 398、mediapipe_full 154、sface 195; errors: {}

| Item | Median of frame medians, ms | Maximum frame p95, ms | Frames |
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

| Target face width, px | YuNet 640 | YuNet dynamic | MP short | MP full | YuNet640 actual face width | MP short versus YuNet640 IoU |
|---|---|---|---|---|---|---|
| Original size | 5/5 | 5/5 | 5/5 | 5/5 | 137–179 | 0.56–0.76 (5 images) |
| 60 | 5/5 | 5/5 | 0/5 | 5/5 | 60–70 | No pairs |
| 100 | 5/5 | 5/5 (includes extra boxes) | 2/5 | 5/5 | 99–105 | 0.33–0.39 (2 images) |
| 150 | 5/5 | 5/5 | 5/5 | 5/5 | 148–162 | 0.60–0.75 (5 images) |

| Target face width, px | Same-person cosine | Different-person cosine |
|---|---|---|
| 60 | 0.741–0.796 (2 pairs) | 0.096–0.231 (8 pairs) |
| 100 | 0.726–0.760 (2 pairs) | 0.070–0.232 (8 pairs) |
| 150 | 0.746–0.756 (2 pairs) | 0.074–0.250 (8 pairs) |
| Original size | 0.728–0.748 (2 pairs) | 0.082–0.212 (8 pairs) |

Camera-mode flow check (fake camera): {"device":"Chromium fake video capture (synthetic pattern, no face) — flow check only","loopSamples":9,"yunetFacesOnFakeFeed":0,"noInferenceAfterStop":true,"viewCleared":true,"status":"鏡頭已停止；畫格與參考特徵已清除","offOriginRequests":[],"cspBlockedRequests":[],"consoleErrors":["INFO: Created TensorFlow Lite XNNPACK delegate for CPU.","INFO: Created TensorFlow Lite XNNPACK delegate for CPU."]}

Image mode: off-origin requests observed by Playwright 0; CSP-blocked connection attempts 4 ["https://odml.pa.googleapis.com/v1/log"]
Camera mode: off-origin requests 0; CSP-blocked attempts 0
