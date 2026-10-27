<!-- bilingual: source=zh-TW -->

> [繁體中文](family-id-00-spike-2026-10-24.md) | [English](family-id-00-spike-2026-10-24.en.md)

<a id="家人辨識-id-00 runtime-spike-與-adr-草案驗證"></a>
<a id="家人辨識-id-00runtime-spike-與-adr-草案驗證"></a>
# Family recognition ID-00: runtime spike and ADR draft validation

2026-10-24; branch `claude/family-id-00`, base `5af2c24` (plan14). Corresponds to ID-00 in [plan 14](../14_Family_Recognition_and_Greeting_Plan_2026-10.en.md) §9 and [ADR-0001 draft](../adr/ADR-0001-local-family-recognition.en.md).

**Every number here comes from cloud-container headless Chromium CPU/WASM, not Mac or AR0144 images.** Cosine is only a pipeline sanity check, not accuracy and not suitable for threshold selection. Recognition, enrollment, and named greetings are not implemented.

<a id="1-做了什麼"></a>
## 1. Work completed

| Item | Content |
|---|---|
| ADR draft | [`docs/adr/ADR-0001-local-family-recognition.md`](../adr/ADR-0001-local-family-recognition.en.md): lifecycle, keys, cloud voice, identity not authorization, model licensing, red-line mapping, open decisions |
| Model download | `prototype/ambient-shell/scripts/face-setup.mjs`, `npm run face:setup`: five models pinned to reviewed versions and SHA-256 checked in gitignored `spike/face/public/`. Not public/vision, which main build copies into product dist/Electron |
| Pre/postprocessing | Pure TS `spike/face/yunet.ts` decode/NMS/letterbox, `spike/face/sface.ts` five-point alignment/warpAffine/tensors/cosine, `spike/face/metrics.ts` median/p95/box comparison |
| Runtime | `spike/face/runtime.ts`: onnxruntime-web 1.30.0 WASM for YuNet/SFace; existing @mediapipe/tasks-vision1.1.1 for BlazeFace short/full |
| Spike page | spike/face/index.html/page.ts, separate vite.config.ts, npm run face:spike bound only to 127.0.0.1:5180. Not main entry and absent from main screen/menus |
| Measurement script | `prototype/ambient-shell/scripts/face-spike-bench.mjs`, npm run face:bench: builds spike to system temp, starts local static server, runs headless Chromium image mode, tests camera stop with fake camera. Output must be outside repo; screenshots off unless --screenshots |
| Verification tools | spike/face/tools/opencv-crosscheck.ts, included in spike typecheck; opencv-golden.py/opencv-reference.py/requirements.txt here, exact opencv-python-headless 5.0.0.93 and numpy 2.5.4. Not product code |
| Tests | tests/face-spike.test.ts 19; camera-privacy adds four spike-boundary checks |
| Typecheck | Separate spike/face/tsconfig.json; product tsconfig excludes spike. npm run typecheck runs both, so verify-aios checks spike too. Chosen instead of changing page.ts global window.faceSpike declaration so product type environment never sees spike globals while measurement page keeps its callable interface |

`onnxruntime-web` is a **devDependency**, exact 1.30.0 released 2026-09-14, spike-only and absent from main build/Electron. ID-01 adoption would move it to dependency and handle packaging. Transitive protobufjs 7.6.6 has install script node scripts/postinstall that only checks parent package.json version spelling and may warn, with no network/file writes. Nine @protobufjs/* packages are BSD-3-Clause, ADR §3.

<a id="這個-spike-不是什麼"></a>
### What the spike does not provide

- It is a local developer runtime-measurement page, not product UI, App launcher, or Dashboard. Static tests check no product references.
- No family enrollment, feature persistence, matched result, look-to-talk effects, or greeting changes.
- Camera “use current largest face as reference” keeps one vector only in page memory; camera stop, page close, and refresh clear it.

<a id="2-方法與計算方式"></a>
## 2. Method and calculations

**Frames:** each image is composed into a gray 1280×720 frame, matching one AR0144 eye. Original size fits the whole image proportionally at center. Target face widths 60/100/150 px first fit the image, measure largest face using **dynamic YuNet 2026 may**, then scale/recenter to target. `compose()` in page.ts prefers dynamic, falling back to 640 if unloaded. Reported actual face width is redetected after scaling by **YuNet 640 2023 mar**, so a few-pixel difference is possible, e.g. target 60 yields 60–70 px.

**Detectors:**

| Name | Model | Input processing |
|---|---|---|
| YuNet 640 | `face_detection_yunet_2023mar.onnx` | Fit 640×640, 1280×720→640×360 with bottom/right black padding; divide results by 0.5 to frame coordinates |
| YuNet dynamic | `face_detection_yunet_2026may.onnx` | Original size padded to multiples of 32, 1280×736 |
| MP short | `blaze_face_short_range.tflite` | MediaPipe FaceDetector IMAGE, CPU delegate, default threshold 0.5 |
| MP full | `blaze_face_full_range.tflite` | Same |

YuNet uses OpenCV Zoo example defaults, score 0.6/NMS 0.3/topK 5000, not calibrated project values.

**SFace:** largest YuNet-640 face aligned from five landmarks to 112×112; 128-D output L2-normalized. Cosine is the inner product of normalized vectors.

**Timing:** performance.now() around each call. YuNet total includes input-canvas drawing/pixel readback/tensor pre, inference, decode/NMS post. MediaPipe only exposes whole detect(). SFace includes alignment/tensor pre and inference; full-frame readback reported separately. Three warmups and 20 measured iterations per frame.

**Summary.md calculations:**

- For each frame, five images × four face sizes =20 frames, compute median/p95 over 20 iterations.
- p95 nearest-rank selects sorted ⌈0.95·n⌉, 19 th at n=20. Even-n median averages middle two. Both tested in face-spike.test.ts.
- Across frames report median of frame medians and maximum frame p95.
- Detection rate is frames with at least one face divided by five.
- Image person labels split cosine into same person, two pairs, and different people, eight pairs; report min/max.

**ONNX threads:** measure one and four. Measurement server sends COOP/COEP and crossOriginIsolated=true for multithread WASM. Container nproc=4. MediaPipe unaffected by this setting.

<a id="3-雲端量測結果"></a>
## 3. Cloud results

Linux x64 container, four vCPU, Node v22.22.0, Playwright 1.56.1 headless Chromium 141.0.7390.37. Raw [cloud-report.json](./family-id-00-spike-2026-10-24/cloud-report.json) and [cloud-summary.md](family-id-00-spike-2026-10-24/cloud-summary.en.md).

<a id="31-偵測兩種執行緒設定結果相同"></a>
### 3.1 Detection, identical for both thread settings

| Target width | YuNet 640 | YuNet dynamic | MP short | MP full | Actual YuNet-640 px | MP-short/YuNet-640 IoU |
|---|---|---|---|---|---|---|
| Original | 5/5 | 5/5 | 5/5 | 5/5 | 137–179 | 0.56–0.76 |
| 60 px | 5/5 | 5/5 | **0/5** | 5/5 | 60–70 | None |
| 100 px | 5/5 | 5/5, one extra false 12.6 px box, score 0.68 | **2/5**, boxes 179–200 px | 5/5 | 99–105 | **0.33–0.39** |
| 150 px | 5/5 | 5/5 | 5/5 | 5/5 | 148–162 | 0.60–0.75 |

- BlazeFace short input is only 128×128. A 100 px face shrunk from 1280×720 becomes about 10 px. All 60 px faces miss; detected 100 px boxes are roughly twice face width, IoU 0.33–0.39, not usable boxes.
- Full-range BlazeFace and both YuNets detect at 60–150 px.
- Even original/150 px BlazeFace boxes are wider; MP short is about 1.1–1.5 times YuNet, IoU 0.56–0.76. Different box definitions cannot be interchanged.

<a id="32-耗時ms 20-個畫格彙總"></a>
<a id="32-耗時ms20-個畫格彙總"></a>
### 3.2 Timing, ms, aggregated over 20 frames

All numbers come directly from [cloud-summary.md](family-id-00-spike-2026-10-24/cloud-summary.en.md), including pre/infer/post. Method §2.

| Item | One-thread median | One-thread worst p95 | Four-thread median | Four-thread worst p95 |
|---|---:|---:|---:|---:|
| YuNet 640 total | 58.6 | 101.5 | 30.7 | 57.2 |
| pre, resize/readback/tensor | 10.3 | 25.3 | 9.8 | 38.3 |
| infer | 47.4 | 82.4 | 19.0 | 32.9 |
| YuNet dynamic total | 130.7 | 203.2 | 64.1 | 111.1 |
| infer | 112.8 | 185.8 | 46.4 | 67.7 |
| MP short | 13.5 | 58.9 | 13.5 | 29.8 |
| MP full | 21.2 | 35.9 | 21.1 | 39.2 |
| SFace alignment/inference | 60.6 | 122.4 | 22.9 | 38.8 |
| infer | 59.6 | 121.4 | 21.9 | 37.7 |
| Full-frame readback | 2.6 | 6.4 | 2.6 | 7.2 |

Single model-load timings including download/compile: YuNet 640 361–384 ms, dynamic 26–30 after runtime initialized, MP short 398–450, MP full 154–166, SFace 195–256. Fixed load order includes runtime initialization in first model, preventing direct load-time comparisons.

**Interpretation:**

- YuNet 640 inference is about 81% of total at one thread, 47.4/58.6. Roughly ten-ms pre is mainly canvas resize and 640×640 Float 32 conversion; remeasure with workers/OffscreenCanvas.
- At 4 Hz, a recognition of YuNet 640+readback+SFace is about 30.7+2.6+22.9≈56 ms with four threads, 58.6+2.6+60.6≈122 ms with one. These are sequential main-thread spike times. Product uses worker and shares CPU with existing 80-ms Pose×2/gesture loop; **actual impact requires Mac measurements**.
- Four threads speed ONNX total medians about 1.9–2.6×: fixed 1.9, dynamic 2.0, SFace 2.6. MediaPipe unchanged as expected because it does not use ONNX threading. High-p95 frames scatter across groups; shared-container CPU noise partly contributes, without separate isolation.
- A full rerun for review differs from prior timings, e.g. four-thread YuNet 640 36.3/SFace28.8 ms, while detections/cosines are identical. Container fluctuations mean cloud numbers indicate magnitude only.

<a id="33-sface-cosinesanity-check"></a>
### 3.3 SFace cosine sanity check

| Target width | Same person, two pairs | Different people, eight pairs |
|---|---|---|
| Original | 0.728–0.748 | 0.082–0.212 |
| 60 px | 0.741–0.796 | 0.096–0.231 |
| 100 px | 0.726–0.760 | 0.070–0.232 |
| 150 px | 0.746–0.756 | 0.074–0.250 |

Only three people and five high-quality frontal official portraits. Strong separation indicates pipeline wiring, **not accuracy or threshold calibration**. Clean high-resolution downsampling explains no degradation at 60 px, unlike real blur/noise/light/profile.

<a id="34-鏡頭模式流程假鏡頭"></a>
### 3.4 Camera flow with fake camera

Chromium --use-fake-device-for-media-stream synthetic feed, no faces: nine samples before stop, zero YuNet faces. After stop/clear, no new inference for 1.5 seconds, display canvas all zero, state says camera stopped and frames/reference cleared. Repeated after adding MP full with same result. Proves stop/generation checks only, not camera detection/timing.

<a id="4-實作正確性"></a>
## 4. Implementation correctness

**Unit tests**, face-spike.test.ts, 19, no models: YuNet decode coordinates, score √(cls·obj), clamp [0,1], threshold, dimension mismatch; NMS retained indices equal cv::dnn::NMSBoxes including integer truncation/topK; letterbox reverse mapping; multiple-of-32 padding; similarity transform three point sets with no reflection from mirrored input; inverse; warpAffine max difference ≤1.5 from cv::warpAffine INTER_LINEAR, OpenCV five-bit fixed interpolation; BGR/RGB order; cosine; p95; boxes. [opencv-golden.py](./family-id-00-spike-2026-10-24/opencv-golden.py) generates tests/fixtures/face-spike-opencv-golden.json. NMS/warp goldens directly call OpenCV 5.0.0; **similarity golden is a line-by-line port of getSimilarityTransformMatrix using numpy/cv2.SVDecomp, not an OpenCV alignment API call**. Direct alignCrop evidence below supports end-to-end alignment.

**OpenCV cross-check**, [opencv-reference.py](./family-id-00-spike-2026-10-24/opencv-reference.py), spike/face/tools/opencv-crosscheck.ts, [output](./family-id-00-spike-2026-10-24/opencv-crosscheck-output.txt): same 1280×720 pixels, OpenCV 5 FaceDetectorYN 2026may/FaceRecognizerSF versus spike TS processing with Node onnxruntime-web.

- Five-image box IoU 1.0000, maximum landmark difference 0.000 px, score difference 0.0000.
- Spike 112×112 float alignment versus OpenCV alignCrop eight-bit: max absolute difference 0.50 per image, mean0.245–0.250, due to integer rounding.
- Same-face feature cosine spike/OpenCV 0.9999–1.0000.
- Maximum cosine difference over ten pairs 0.0031.

This proves implementation consistency, not recognition effectiveness.

**Unchecked path:** cross-check uses 2026 may original resolution. YuNet 640 2023 mar letterbox uses canvas drawImage resize with interpolation different from OpenCV resize; **not cross-checked**. All YuNet 640 detection/timing tables use it. Added to ID-01 tasks in ADR §10.

<a id="5-偵測器比較結論"></a>
## 5. Detector comparison conclusions

Cloud direction:

1. **BlazeFace short unsuitable for full 1280×720:** all 60 px misses, unusable 100 px boxes. Requires head-region crop and extra Pose dependency.
2. **YuNet640/BlazeFace full both cover 60–150 px:** YuNet directly supplies SFace five landmarks; BlazeFace only mouth center, requiring estimated corners.
3. **Timing:** full BlazeFace faster than YuNet 640, four-thread medians21.1/30.7 ms. SFace adds about 23 ms per recognition, reducing detector difference as total share.
4. **Dynamic YuNet** full-resolution inference takes about twice fixed 640 and adds one false 100 px box; no detection-rate benefit observed at 60–150. Not currently recommended.

**Cloud favors YuNet 640 as detector frontend, pending Mac data.** Check real AR0144 image detection, simultaneous sensing load, and stop-gesture impact, §7.

<a id="6-隱私檢查"></a>
## 6. Privacy checks

- Spike CSP `connect-src 'self' ws://127.0.0.1:5180`, latter only HMR. Playwright request events observed **no off-local requests** in image/fake-camera modes; report offOriginRequests arrays empty. CSP-blocked attempts never become request events, so console messages separately count blocked attempts.
- **Found built-in telemetry in @mediapipe/tasks-vision1.1.1:** every 60 seconds and on close POST protobuf to https://odml.pa.googleapis.com/v1/log. Code fields show task type/run mode/timing stats, no image observed. Image mode had four attempts, all CSP-blocked and unsent. Camera smoke ran seconds, below 60, zero.
- **Main app:** core-served npm start/Electron CSP connect-src self in server/app.ts, tested by sense-controller, inferred to block likewise but not directly observed on main page here. **Vite npm run dev:web lacks CSP and MediaPipe telemetry sends there.** Existing Pose/gesture issue, separate scope; never relax CSP.
- Existing src privacy checks in camera-privacy.test.ts unchanged; src denylist expansion separate. Four spike-only checks:
  - Recursively scan spike/face including tools, excluding public/dist. Only runtime.ts may getImageData. Forbid toDataURL/toBlob/convertToBlob/captureStream/createObjectURL/MediaRecorder/ImageCapture/readPixels/showSaveFilePicker/fetch/XMLHttpRequest/WebSocket/WebTransport/EventSource/sendBeacon/RTCPeerConnection/local storage APIs,/api/, and remote dynamic imports. Another test confirms patterns actually catch violations.
  - CSP connect-src only self plus port 5180.
  - No src/server/shared/desktop spike references, static/side-effect/dynamic import/require; no spike in main index.html/vite.config.ts.
  - Deliberate MediaRecorder in spike tool and require("../spike/…") in desktop/preload.cjs made tests fail, then restored.
- Test images stay out of Git, downloaded from Wikimedia Commons for measurement. API LicenseShortName must be public domain or CC 0.

| Local filename | Wikimedia page | API license | API author |
|---|---|---|---|
| biden_2021.jpg | [Joe Biden presidential portrait](https://commons.wikimedia.org/wiki/File:Joe_Biden_presidential_portrait.jpg) | Public domain | Adam Schultz |
| biden_2013.jpg | [Joe Biden official portrait 2013 (cropped) 2](https://commons.wikimedia.org/wiki/File:Joe_Biden_official_portrait_2013_(cropped)_2.jpg), redirected from Official portrait of Vice President Joe Biden.jpg | Public domain | The White House |
| harris_2021.jpg | [Kamala Harris Vice Presidential Portrait](https://commons.wikimedia.org/wiki/File:Kamala_Harris_Vice_Presidential_Portrait.jpg) | Public domain | Lawrence Jackson |
| harris_2017.jpg | [Senator Kamala Harris Official Portrait](https://commons.wikimedia.org/wiki/File:Senator_Kamala_Harris_Official_Portrait.jpg), redirected from Kamala Harris official photo.jpg | Public domain | Renee Bouchard |
| obama_2012.jpg | [President Barack Obama](https://commons.wikimedia.org/wiki/File:President_Barack_Obama.jpg) | Public domain | Pete Souza, White House |

Uses 1280-px thumbnails, hashes in cloud-report images/sources. US federal government works are public domain in the US; likeness/personality rights remain separate, so images serve measurement only, not repository/display assets.

<a id="7-限制"></a>
## 7. Limitations

- Cloud CPU, not Mac CPU/GPU; no MediaPipe GPU delegate, WebGPU, or Electron.
- No AR0144 blur/noise/exposure/wide-angle distortion/profile/glasses/multiple people.
- Five frontal portraits do not represent postures/populations.
- Sequential main-thread spike inference, not product workers or concurrent sensing.
- Only three people for cosine, insufficient false-match/threshold estimation.
- SFace training-data terms unresolved, ADR §3.
- Fixed 640 canvas-letterbox path not OpenCV-cross-checked; all fixed 640 numbers use it.
- Full-run timing varies up to about 20%, §3.2, magnitude only.

<a id="8-待-george-在-mac-上用-ar 0144-實測"></a>
<a id="8-待-george-在-mac-上用-ar0144-實測"></a>
## 8. George's pending Mac/AR0144 tests

**Preparation**

1. `cd prototype/ambient-shell && npm ci && npm run face:setup`.
2. Mount AR0144 above display facing user, docs/11 §6 A; mark ground distances0.8/1.0/1.5m.
3. Record Mac/chip/macOS/browser-or-Electron versions and lights on/off.

**A. Face widths/detection, spike only**

1. npm run face:spike, Chrome http://127.0.0.1:5180, threads 4, MediaPipe CPU, load models.
2. Camera-name contains CCB; open. Page first opens default camera for permission so names are readable, closes/switches to CCB if different; default may briefly light, as product openStereoCamera does. Expected CCB 2560×720; record actual otherwise.
3. At0.8/1.0/1.5m face front/left20°/right 20°, ten seconds each. Record JSON yunetFaces[].width, mediapipeFaces[].width, mediapipeFullFaces[].width, boxDiff, timingsLastN median/p95.
4. Repeat 1 m front with glasses and lights off separately.
5. Reload with GPU delegate, repeat 1 m front.
6. At 1 m front set largest face reference, move0.8/1.5m and record cosineToReference; record another family member 1 m too. Sanity only, no enrollment/persistence.
7. Stop/clear; verify cleared state and black view.

**B. Concurrent existing sensing**

1. Another window npm start with NOUS_CAMERA=on, camera/palm stop enabled.
2. Without spike, play long Nous reply and raise palm ten times at 1.5 m; record stops and latency by video/visual estimate.
3. Open spike camera concurrently on AR0144. If camera busy, record error as a result. Repeat ten palms.
4. Record browser CPU% in Activity Monitor both rounds.

**Record format:** one condition per row in new family-id-00-mac-YYYY-MM-DD.md here.

| Distance m | Pose | Light | Glasses | YuNet face px | MP short face px | MP full | IoU | YuNet median/p95 ms | MP short median/p95 ms | SFace median/p95 ms | Reference cosine | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

Separate stop-gesture record:

| Condition | Success/10 | Approximate palm-to-stop | Browser CPU% | Notes |
|---|---|---|---|---|
| Nous only | | | | |
| Nous plus spike | | | | |

Each camera sample runs YuNet 640, MP short, MP full, then SFace, about 4 Hz. JSON mediapipeFullFaces contains full-range results; visible boxes only YuNet/short.

<a id="9-重現"></a>
## 9. Reproduce

```bash
cd prototype/ambient-shell
npm ci
npm run face:setup
PLAYWRIGHT_MODULE=<playwright 模組路徑> npm run face:bench -- --output <repo 外的資料夾> --iterations 20 --warmup 3 --threads 1,4
# 只重算彙總：npm run face:bench -- --from-report <report.json> --output <repo 外的資料夾>
# 交叉核對：python -m venv <venv> && <venv>/bin/pip install -r ../../docs/validation/family-id-00-spike-2026-10-24/requirements.txt
#   <venv>/bin/python -I ../../docs/validation/family-id-00-spike-2026-10-24/opencv-reference.py <圖片> spike/face/public/models <輸出>
#   npx tsx spike/face/tools/opencv-crosscheck.ts <輸出> spike/face/public/models
```

Cloud used PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright/index.mjs and PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers. Image mode took 153 seconds at one thread,82 at four, plus download/build/camera smoke.

<a id="10-本批次驗證指令"></a>
## 10. Batch validation commands

Run2026-10-24 in cloud container, Node v22.22.0.

| Command | Result |
|---|---|
| npm run typecheck = tsc --noEmit && tsc --noEmit -p spike/face/tsconfig.json, prototype/ambient-shell | Both pass silently. Product tsconfig excludes spike except three pure modules imported by face-spike tests; spike config covers page/runtime/vite/tools |
| npx vitest run | 49 files,813 passes, original 790+face-spike 19+privacy 4 |
| npx vite build | Pass; dist only main assets, no spike/ONNX/WASM |
| npx vite build --config spike/face/vite.config.ts | Pass |
| node --check desktop/main.mjs | Pass |
| node scripts/verify-aios.mjs, root | PASS, types including spike/tests/build/isolated mock task/direct chat |
| git diff --check | Pass; untracked files separately checked by grep for trailing whitespace |
| node scripts/check-pstack.mjs | Pass,0.15.29,172 hashes,56 skills |
| npm run face:setup -- --force | Five pinned downloads and hashes pass |
| npm run face:bench -- --output <inside-repo path> | Rejects with exit 1 as designed |
| Full face:bench and OpenCV cross-check | §3/4; build temp removed, no screenshots |

<a id="11-下一個-gate"></a>
## 11. Next gate

ID-00 release condition is whether existing delay can yield usable samples/performance evidence. Cloud confirms runtime and reviewed model versions, weights/code licenses, with SFace training-data terms still unresolved, and OpenCV consistency. **Usable samples/performance still await Mac/AR0144 data in §8.** George then decides ADR §9 items before ID-01 enrollment/deletion/encrypted features/local recognition.
