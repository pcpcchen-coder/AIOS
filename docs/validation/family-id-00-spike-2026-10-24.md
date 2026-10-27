<!-- bilingual: source=zh-TW -->

> [繁體中文](family-id-00-spike-2026-10-24.md) | [English](family-id-00-spike-2026-10-24.en.md)

# 家人辨識 ID-00：runtime spike 與 ADR 草案驗證

2026-10-24；分支 `claude/family-id-00`，基底 `5af2c24`（14 規劃）。對應 [14 規劃](../14_Family_Recognition_and_Greeting_Plan_2026-10.md) §9 的 ID-00 與 [ADR-0001 草案](../adr/ADR-0001-local-family-recognition.md)。

**這份紀錄的數字全部來自雲端容器的 headless Chromium（CPU／WASM），不是 Mac，也不是 AR0144 畫面。** cosine 只是確認管線有接對的 sanity check，不是準確率，也不能拿來定門檻。辨識、登記與稱名問候都沒有實作。

## 1. 做了什麼

| 項目 | 內容 |
|---|---|
| ADR 草案 | [`docs/adr/ADR-0001-local-family-recognition.md`](../adr/ADR-0001-local-family-recognition.md)：資料生命週期、金鑰、雲端語音、身分非授權、模型授權查核、紅線對照、待決事項 |
| 模型下載 | `prototype/ambient-shell/scripts/face-setup.mjs`（`npm run face:setup`）：5 個模型釘在查核過的版本並核對 SHA-256，放到 `spike/face/public/`（gitignore）。不放 `public/vision/`，因為那裡會被主程式 build 複製進產品 dist 與 Electron 包 |
| 前後處理 | `spike/face/yunet.ts`（解碼、NMS、letterbox）、`spike/face/sface.ts`（5 點對齊、warpAffine、張量、cosine）、`spike/face/metrics.ts`（中位數、p95、框比較），純 TS |
| Runtime | `spike/face/runtime.ts`：`onnxruntime-web` 1.30.0（wasm 後端）跑 YuNet 與 SFace；既有 `@mediapipe/tasks-vision` 1.1.1 跑 BlazeFace short／full range |
| Spike 頁 | `spike/face/index.html`、`page.ts`，獨立 Vite 設定 `spike/face/vite.config.ts`（`npm run face:spike`，只綁 127.0.0.1:5180）。不是主程式的 entry，不出現在主畫面或選單 |
| 量測腳本 | `prototype/ambient-shell/scripts/face-spike-bench.mjs`（`npm run face:bench`）：把 spike 頁建置到系統暫存資料夾、啟動本機靜態伺服器、headless Chromium 跑圖片模式，另用假鏡頭檢查鏡頭模式的停止流程。`--output` 必須在 repo 外；截圖預設不存（`--screenshots` 才存） |
| 驗證工具 | `spike/face/tools/opencv-crosscheck.ts`（納入 spike 的型別檢查）；本目錄的 `opencv-golden.py`、`opencv-reference.py` 與 `requirements.txt`（精確鎖 opencv-python-headless 5.0.0.93、numpy 2.5.4）。都是驗證工具，非產品程式 |
| 測試 | `tests/face-spike.test.ts`（19 項）；`tests/camera-privacy.test.ts` 新增 4 項 spike 邊界檢查 |
| 型別檢查 | spike 用獨立的 `spike/face/tsconfig.json`，產品 `tsconfig.json` 不再納入 `spike/`；`npm run typecheck` 依序跑兩者，所以 `verify-aios` 也會檢查 spike。選這個做法而不是改掉 `page.ts` 的全域 `window.faceSpike` 宣告，是為了讓產品程式的型別環境完全看不到 spike 的全域擴充，spike 頁仍保留給量測腳本呼叫的介面 |

`onnxruntime-web` 加為 **devDependency**（精確版本 1.30.0，2026-09-14 發布）。只有 spike 使用；主程式 build 與 Electron 包不含它。ID-01 若採用，再改為 dependency 並處理桌面打包。它帶進的 `protobufjs` 7.6.6 有 install script（`node scripts/postinstall`）；內容只檢查上層 `package.json` 的版本寫法並可能印警告，不連網、不寫檔。另有 9 個 `@protobufjs/*` 子套件，皆 BSD-3-Clause（ADR §3）。

### 這個 spike 不是什麼

- 不是產品畫面、App launcher 或 Dashboard。它是開發者在本機量測 runtime 的工具頁，沒有被產品程式引用（靜態測試檢查）。
- 不登記家人、不保存特徵、不產生 `matched` 結果、不影響看著說話或問候。
- 鏡頭模式下按「以目前最大臉為參考」只把一個特徵向量留在頁面記憶體；停止鏡頭、關頁或重新整理即清除。

## 2. 方法與計算方式

**畫格**：每張圖片放進 1280×720 灰底畫格（與 AR0144 單眼解析度相同）。「原尺寸」是整張等比置中；臉寬 60／100／150 px 是先把整張圖等比置入，用 **YuNet 動態版（2026may）** 量出最大臉的框寬，再依此縮放圖片使臉寬約為目標值、臉置中（`page.ts` 的 `compose()` 優先用動態版，未載入時才用 640 版）。表中「實際臉寬」則是縮放後由 **YuNet 640（2023mar）** 重新偵測的框寬，所以兩者可能差幾個 px（例如目標 60 px 時量到 60–70 px）。

**偵測器**：

| 名稱 | 模型 | 輸入處理 |
|---|---|---|
| YuNet 640 | `face_detection_yunet_2023mar.onnx` | 等比縮進 640×640（1280×720 → 640×360，右下補黑），結果除以 0.5 回到畫格座標 |
| YuNet 動態 | `face_detection_yunet_2026may.onnx` | 原尺寸補到 32 的倍數（1280×736） |
| MP short | `blaze_face_short_range.tflite` | MediaPipe FaceDetector，IMAGE 模式、CPU delegate、預設門檻 0.5 |
| MP full | `blaze_face_full_range.tflite` | 同上 |

YuNet 門檻用 OpenCV Zoo 範例預設（分數 0.6、NMS 0.3、topK 5000），不是本專案的校準值。

**SFace**：以 YuNet 640 的最大臉 5 點對齊到 112×112，輸出 128 維並 L2 normalize。cosine 為兩個 normalize 後向量的內積。

**計時**：`performance.now()` 包住每次呼叫。YuNet 的總時間包含畫到輸入畫布、讀像素、轉張量（pre）、推論（infer）與解碼＋NMS（post）。MediaPipe 只能量整次 `detect()`。SFace 包含對齊與轉張量（pre）及推論；整張畫格讀像素另列 `frame_readback`。每個畫格先跑 3 次暖機，再量 20 次。

**彙總**（腳本 `summary.md` 的算法）：

- 每個畫格（5 張圖 × 4 種臉寬＝20 格）先算 20 次的中位數與 p95。
- p95 用 nearest-rank：排序後取第 ⌈0.95·n⌉ 個，n＝20 時是第 19 個。中位數在 n 為偶數時取中間兩個平均。這兩個公式在 `tests/face-spike.test.ts` 有測。
- 跨畫格報「畫格中位數的中位數」與「畫格 p95 的最大值」。
- 偵測率＝至少偵測到一張臉的畫格數 ÷ 5。
- cosine 依圖片的人物標記分成同一人（2 對）與不同人（8 對），報最小到最大。

**onnxruntime 執行緒**：分別以 1 與 4 執行緒量測。量測伺服器送 COOP／COEP，頁面 `crossOriginIsolated=true`，多執行緒 wasm 才可用。容器 `nproc`＝4。MediaPipe 不受這個設定影響。

## 3. 雲端量測結果

環境：Linux x64 容器、4 vCPU、Node v22.22.0、Playwright 1.56.1 的 headless Chromium 141.0.7390.37。原始輸出見 [`cloud-report.json`](./family-id-00-spike-2026-10-24/cloud-report.json) 與 [`cloud-summary.md`](family-id-00-spike-2026-10-24/cloud-summary.md)。

### 3.1 偵測（兩種執行緒設定結果相同）

| 臉寬目標 | YuNet 640 | YuNet 動態 | MP short | MP full | YuNet 640 實際臉寬 px | MP short 與 YuNet 640 的 IoU |
|---|---|---|---|---|---|---|
| 原尺寸 | 5/5 | 5/5 | 5/5 | 5/5 | 137–179 | 0.56–0.76 |
| 60 px | 5/5 | 5/5 | **0/5** | 5/5 | 60–70 | 無 |
| 100 px | 5/5 | 5/5，1 張多一個 12.6 px 的誤框（分數 0.68） | **2/5**，框寬 179–200 px | 5/5 | 99–105 | **0.33–0.39** |
| 150 px | 5/5 | 5/5 | 5/5 | 5/5 | 148–162 | 0.60–0.75 |

- BlazeFace short range 的輸入只有 128×128。1280×720 畫格縮進去後，100 px 的臉只剩約 10 px，因此 60 px 全數漏掉；100 px 時偵測到的 2 張框寬是臉寬的約 2 倍，IoU 只有 0.33–0.39，不能當作可用的臉框。
- BlazeFace full range 與 YuNet 兩版在 60–150 px 都有偵測。
- 即使在原尺寸與 150 px，BlazeFace 框也比 YuNet 寬（MP short 寬度約為 YuNet 的 1.1–1.5 倍），IoU 0.56–0.76。兩者框的定義不同，不能互換使用。

### 3.2 耗時（ms，20 個畫格彙總）

下表所有數字直接取自腳本產出的 [`cloud-summary.md`](family-id-00-spike-2026-10-24/cloud-summary.md)（含 `.pre`、`.infer`、`.post` 分段），計算方式見 §2。

| 項目 | 1 執行緒：中位數 | 1 執行緒：最差 p95 | 4 執行緒：中位數 | 4 執行緒：最差 p95 |
|---|---:|---:|---:|---:|
| YuNet 640（全程） | 58.6 | 101.5 | 30.7 | 57.2 |
| 　pre（縮放＋讀像素＋轉張量） | 10.3 | 25.3 | 9.8 | 38.3 |
| 　infer | 47.4 | 82.4 | 19.0 | 32.9 |
| YuNet 動態（全程） | 130.7 | 203.2 | 64.1 | 111.1 |
| 　infer | 112.8 | 185.8 | 46.4 | 67.7 |
| MP short | 13.5 | 58.9 | 13.5 | 29.8 |
| MP full | 21.2 | 35.9 | 21.1 | 39.2 |
| SFace（對齊＋推論） | 60.6 | 122.4 | 22.9 | 38.8 |
| 　infer | 59.6 | 121.4 | 21.9 | 37.7 |
| 整張畫格讀像素 | 2.6 | 6.4 | 2.6 | 7.2 |

模型載入（含下載與編譯，單次）：YuNet 640 361–384 ms、YuNet 動態 26–30 ms（同一 runtime 已初始化後）、MP short 398–450 ms、MP full 154–166 ms、SFace 195–256 ms。載入順序固定，先載入者包含 runtime 初始化，因此不同模型的載入時間不能直接比較。

**這些數字代表什麼**：

- YuNet 640 的推論約佔全程 81%（1 執行緒 47.4／58.6）。pre 約 10 ms 主要是 canvas 縮放與把 640×640 像素轉成 Float32；換到 worker 或 OffscreenCanvas 時要重量。
- 以 4 Hz 取樣、「YuNet 640＋讀像素＋SFace」為一次辨識計：4 執行緒約 30.7＋2.6＋22.9 ≈ 56 ms，1 執行緒約 58.6＋2.6＋60.6 ≈ 122 ms。這是在 spike 頁主執行緒上連續執行的時間；產品要放在 worker，且必須與既有 80 ms 感測迴圈（Pose×2＋手勢）共用 CPU，**實際影響只能在 Mac 上量**。
- 4 執行緒讓 ONNX 模型的全程中位數快約 1.9–2.6 倍（YuNet 640 1.9、YuNet 動態 2.0、SFace 2.6）；MediaPipe 不變（預期，它不用 onnxruntime 的執行緒）。p95 偏高的畫格散在各組，容器 CPU 共享的雜訊佔一部分，未另行隔離。
- 這次為了回應審查重跑一次，數字與先前一輪（例如 YuNet 640 4 執行緒 36.3 ms、SFace 28.8 ms）有差異，偵測結果與 cosine 則完全相同。差異反映容器環境的波動，雲端數字只能看量級。

### 3.3 SFace cosine（sanity check）

| 臉寬目標 | 同一人（2 對） | 不同人（8 對） |
|---|---|---|
| 原尺寸 | 0.728–0.748 | 0.082–0.212 |
| 60 px | 0.741–0.796 | 0.096–0.231 |
| 100 px | 0.726–0.760 | 0.070–0.232 |
| 150 px | 0.746–0.756 | 0.074–0.250 |

只有 3 個人、5 張高畫質正面官方肖像。同一人兩組之間的差距大，表示管線有接對；**這不是準確率，也不能用來定門檻**。60 px 沒有變差，是因為縮小的是乾淨的高解析照片，沒有實機的模糊、雜訊、光線與側臉。

### 3.4 鏡頭模式流程（假鏡頭）

Chromium `--use-fake-device-for-media-stream` 的合成畫面（無人臉）：停止前累計 9 次取樣，YuNet 回報 0 張臉；按「停止並清除」後 1.5 秒內沒有新的推論結果，顯示畫布全為 0，狀態為「鏡頭已停止；畫格與參考特徵已清除」。鏡頭模式加入 MP full 後重跑一次，結果相同。這只證明停止流程與世代檢查有效，不代表任何鏡頭的偵測或耗時。

## 4. 實作正確性

**單元測試**（`tests/face-spike.test.ts`，19 項，不載入模型）：YuNet 解碼（座標、分數 √(cls·obj)、夾到 [0,1]、門檻、尺寸不符時報錯）、NMS 與 `cv::dnn::NMSBoxes` 的保留索引一致（含整數截斷與 topK）、letterbox 座標回推、padding 到 32 的倍數、similarity transform（3 組點，含鏡射輸入時不產生反射）、反矩陣、warpAffine 與 `cv::warpAffine` INTER_LINEAR 的最大差 ≤ 1.5（OpenCV 用 5 位元定點插值）、BGR／RGB 通道順序、cosine、p95 與框比較。產生器為 [`opencv-golden.py`](./family-id-00-spike-2026-10-24/opencv-golden.py)，結果存於 `tests/fixtures/face-spike-opencv-golden.json`：NMS 與 warpAffine 的 golden 直接呼叫 OpenCV 5.0.0；**similarity 的 golden 是 OpenCV `getSimilarityTransformMatrix` 演算法的逐行移植（numpy＋`cv2.SVDecomp`），不是呼叫 OpenCV 對齊 API**。端到端的對齊結果由下方交叉核對以 OpenCV `alignCrop` 直接佐證。

**與 OpenCV 交叉核對**（[`opencv-reference.py`](./family-id-00-spike-2026-10-24/opencv-reference.py)、`prototype/ambient-shell/spike/face/tools/opencv-crosscheck.ts`，輸出 [`opencv-crosscheck-output.txt`](./family-id-00-spike-2026-10-24/opencv-crosscheck-output.txt)）：同一批 1280×720 像素，OpenCV 5.0.0 的 `FaceDetectorYN`（2026may 模型）與 `FaceRecognizerSF` 對照 spike 的 TS 前後處理（onnxruntime-web 的 Node 版）：

- 5 張圖的偵測框 IoU 1.0000，5 點最大差 0.000 px，分數差 0.0000。
- 對齊影像：spike 的 112×112 浮點輸出與 OpenCV `alignCrop` 的 8 位元輸出相比，每張最大絕對差 0.50、平均 0.245–0.250（差異來自 OpenCV 輸出取整到整數）。
- 同一張臉的 SFace 特徵，spike 與 OpenCV 的 cosine 為 0.9999–1.0000。
- 10 組配對的 cosine，spike 與 OpenCV 最大差 0.0031。

這只證明實作與 OpenCV 一致，不證明辨識效果。

**沒有核對的路徑**：交叉核對用的是 2026may 原尺寸輸入。YuNet 640（2023mar）的 letterbox 以 canvas `drawImage` 縮放，插值與 OpenCV `resize` 不同，**這條路徑沒有對 OpenCV 核對**；量測表中 YuNet 640 的偵測與耗時都走這條路徑。列入 ADR §10 的 ID-01 待辦。

## 5. 偵測器比較結論

雲端數據的方向：

1. **BlazeFace short range 不適合 1280×720 全畫格**。60 px 全漏、100 px 框不可用。要用它只能先裁出頭部區域，額外依賴 Pose 的位置。
2. **YuNet 640 與 BlazeFace full range 都能涵蓋 60–150 px**。YuNet 直接提供 SFace 需要的 5 點；BlazeFace 只有嘴巴中心，接 SFace 要再推估兩個嘴角。
3. **耗時**：BlazeFace full range 比 YuNet 640 快（4 執行緒中位數 21.1 vs 30.7 ms）。辨識每次還要加 SFace 約 23 ms，因此偵測器差距佔一次辨識的比例不大。
4. **YuNet 動態版**全解析度推論約是 640 版的 2 倍時間，100 px 時還多出一個誤框；60–150 px 範圍內沒有看到偵測率的好處。目前不建議用。

**結論：雲端傾向 YuNet 640 作為偵測前端，但需 Mac 數據才能定案。** Mac 上要確認 AR0144 真實畫質下的偵測率、與既有感測同時跑的耗時，以及對停止手勢的影響（§7）。

## 6. 隱私檢查

- spike 頁 CSP 為 `connect-src 'self' ws://127.0.0.1:5180`（後者只給 `npm run face:spike` 開發伺服器的 HMR）。Playwright 以 `request` 事件觀察：圖片模式與假鏡頭模式**都沒有觀察到離開本機的請求**（`cloud-report.json` 的 `offOriginRequests` 與 `cameraSmoke.offOriginRequests` 皆為空）。這個觀察的意義有限：被 CSP 擋下的連線在瀏覽器內就被拒絕，不會成為 `request` 事件，所以另以主控台訊息統計「被 CSP 擋下的連線嘗試」。
- **發現：`@mediapipe/tasks-vision` 1.1.1 內建用量紀錄**，每 60 秒（以及關閉時）以 `POST https://odml.pa.googleapis.com/v1/log` 送 protobuf。程式碼中的欄位是任務類型、執行模式與耗時統計，沒有看到影像。本次圖片模式共有 4 次這類連線嘗試，全部被 CSP 擋下、沒有送出；假鏡頭模式只跑約數秒，未到 60 秒的送出週期，記錄為 0 次。
- **主程式的情況**：經本機核心提供頁面時（`npm start` 與 Electron，`server/app.ts`）CSP 是 `connect-src 'self'`（`tests/sense-controller.test.ts` 有檢查），推論同樣會擋下，但這次沒有在主程式頁面實際觀察。**Vite 開發伺服器（`npm run dev:web`）目前沒有設定 CSP，這時 MediaPipe 的用量紀錄會送出**。這是既有 Pose／手勢管線的問題，不在本批次範圍，另案處理；CSP 不可放寬。
- `tests/camera-privacy.test.ts` 原有的 `src/` 檢查一字未動（`src/` 的禁止清單另案再補）。新增 4 項只針對 spike：
  - 遞迴掃描 `spike/face/`（含 `tools/`，略過 `public/`、`dist/`），只允許 `runtime.ts` 使用 `getImageData`；禁止 `toDataURL`、`toBlob`、`convertToBlob`、`captureStream`、`createObjectURL`、`MediaRecorder`、`ImageCapture`、`readPixels`、`showSaveFilePicker`、`fetch`、`XMLHttpRequest`、`WebSocket`、`WebTransport`、`EventSource`、`sendBeacon`、`RTCPeerConnection`、本機儲存 API、`/api/` 與動態 import 遠端網址。另有一項確認這些樣式真的會被抓到。
  - spike 頁的 CSP `connect-src` 只能是 `'self'` 加 5180 埠。
  - `src/`、`server/`、`shared/`、`desktop/` 不以任何形式引用 spike（靜態、副作用、動態 `import()` 與 `require`）；主程式 `index.html` 與 `vite.config.ts` 不含 spike。
  - 以故意加入 `MediaRecorder`（spike 工具檔）與 `require("../spike/…")`（`desktop/preload.cjs`）的方式確認測試會失敗，之後已還原。
- 測試圖片不進 git，量測時從維基共享資源下載，授權由 API 回傳的 `LicenseShortName` 檢查必須是公有領域或 CC0。

| 檔案（本地名稱） | 維基共享資源頁 | 授權（API） | 作者（API） |
|---|---|---|---|
| `biden_2021.jpg` | [Joe Biden presidential portrait](https://commons.wikimedia.org/wiki/File:Joe_Biden_presidential_portrait.jpg) | Public domain | Adam Schultz |
| `biden_2013.jpg` | [Joe Biden official portrait 2013 (cropped) 2](https://commons.wikimedia.org/wiki/File:Joe_Biden_official_portrait_2013_(cropped)_2.jpg)（查詢名稱 `Official portrait of Vice President Joe Biden.jpg` 轉址至此） | Public domain | The White House |
| `harris_2021.jpg` | [Kamala Harris Vice Presidential Portrait](https://commons.wikimedia.org/wiki/File:Kamala_Harris_Vice_Presidential_Portrait.jpg) | Public domain | Lawrence Jackson |
| `harris_2017.jpg` | [Senator Kamala Harris Official Portrait](https://commons.wikimedia.org/wiki/File:Senator_Kamala_Harris_Official_Portrait.jpg)（查詢名稱 `Kamala Harris official photo.jpg` 轉址至此） | Public domain | Renee Bouchard |
| `obama_2012.jpg` | [President Barack Obama](https://commons.wikimedia.org/wiki/File:President_Barack_Obama.jpg) | Public domain | Pete Souza（White House） |

使用的是 1280 px 寬縮圖，SHA-256 記在 `cloud-report.json` 的 `images` 與 `sources`。美國聯邦政府作品在美國屬公有領域；肖像權與人格權仍另外存在，因此只用於量測，不放進 repo、不作展示。

## 7. 限制

- 雲端容器 CPU，不是 Mac 的 CPU／GPU；沒有測 MediaPipe GPU delegate、WebGPU 或 Electron。
- 沒有 AR0144：沒有真實的模糊、雜訊、曝光、廣角畸變、側臉、眼鏡或多人。
- 偵測率只有 5 張正面肖像；不代表任何姿勢或族群的表現。
- 推論在 spike 頁主執行緒依序執行，不是產品將用的 worker 架構，也沒有和既有感測迴圈同時跑。
- cosine 樣本只有 3 個人，不能估誤認率或定門檻。
- SFace 訓練資料的條款未查清（ADR §3）。
- YuNet 640 的 letterbox 路徑（canvas 縮放）沒有對 OpenCV 核對（§4）；表中 YuNet 640 的數字都走這條路徑。
- 兩次完整量測之間耗時差異可達約 20%（§3.2），雲端數字只能看量級。

## 8. 待 George 在 Mac 上用 AR0144 實測

**準備**

1. `cd prototype/ambient-shell && npm ci && npm run face:setup`。
2. AR0144 裝在螢幕上緣、面向使用者（同 docs/11 §6 方案 A），量好與使用者的地面距離標記 0.8、1.0、1.5 m。
3. 記錄 Mac 型號、晶片、macOS 版本、瀏覽器或 Electron 版本、室內光線（開燈／關燈）。

**A. 臉寬與偵測（只開 spike 頁）**

1. `npm run face:spike`，用 Chrome 開 `http://127.0.0.1:5180`，執行緒填 4、MediaPipe delegate 先選 CPU，按「載入模型」。
2. 「鏡頭名稱包含」維持 `CCB`，按「開鏡頭」。頁面會先開系統預設鏡頭取得權限（裝置名稱要有權限才讀得到），若預設不是 CCB 再關掉、改開 CCB，所以預設鏡頭可能短暫亮起（做法同產品的 `openStereoCamera`）。狀態列應顯示 CCB 與 2560×720；若不是，記錄實際名稱與尺寸。
3. 依序站在 0.8、1.0、1.5 m，各正面、左轉約 20°、右轉約 20° 各停 10 秒。每個位置記錄下方 JSON 的 `yunetFaces[].width`、`mediapipeFaces[].width`、`mediapipeFullFaces[].width`、`boxDiff`、`timingsLastN`（中位數與 p95）。
4. 戴眼鏡、關燈各重複一次 1.0 m 正面。
5. MediaPipe delegate 改 GPU 後重新載入，重做 1.0 m 正面一次。
6. 1.0 m 正面時按「以目前最大臉為參考」，再到 0.8、1.5 m 看 `cosineToReference`。換另一位家人站到 1.0 m 時也記錄。這只是 sanity check，不登記、不保存。
7. 按「停止並清除」，確認狀態列顯示已清除、畫面變黑。

**B. 與既有感測迴圈同時跑**

1. 另一個視窗用 `npm start`（`.env` 設 `NOUS_CAMERA=on`）開主程式，鏡頭開啟，「手掌停止播報」開著。
2. 先不開 spike 頁，讓 Nous 播報一段較長的回答，在 1.5 m 舉手掌 10 次，記錄停止成功次數與舉手到停止的時間（錄影或目測）。
3. 開 spike 頁並開鏡頭（兩個頁面同時使用 AR0144；若出現「鏡頭被其他程式占用」，記錄錯誤即可，這本身是結果），重複 10 次舉手。
4. 兩輪都記錄活動監視器中瀏覽器的 CPU 百分比。

**記錄格式**（每列一個條件，貼回本目錄新增 `family-id-00-mac-YYYY-MM-DD.md`）：

| 距離 m | 姿勢 | 光線 | 眼鏡 | YuNet 臉寬 px | MP short 臉寬 px | MP full | IoU | YuNet 中位數／p95 ms | MP short 中位數／p95 ms | SFace 中位數／p95 ms | cosine 對參考 | 備註 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|

停止手勢另記：

| 條件 | 成功／10 | 舉手到停止（約） | 瀏覽器 CPU % | 備註 |
|---|---|---|---|---|
| 只開 Nous | | | | |
| Nous＋spike | | | | |

鏡頭模式每次取樣依序跑 YuNet 640、MP short、MP full 與 SFace（約 4 Hz），JSON 的 `mediapipeFullFaces` 是 full range 結果；畫面上的框只畫 YuNet 與 MP short。

## 9. 重現

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

本次在雲端用 `PLAYWRIGHT_MODULE=/opt/node-tools/node_modules/playwright/index.mjs`、`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`。圖片模式 1 執行緒 153 秒、4 執行緒 82 秒，另加下載、建置與假鏡頭檢查。

## 10. 本批次驗證指令

2026-10-24 於雲端容器、Node v22.22.0 執行：

| 指令 | 結果 |
|---|---|
| `npm run typecheck`＝`tsc --noEmit && tsc --noEmit -p spike/face/tsconfig.json`（prototype/ambient-shell） | 兩者都通過，無輸出。產品 `tsconfig.json` 不含 `spike/`（只經 `tests/face-spike.test.ts` 帶入 3 個純函式模組）；spike 自己的設定涵蓋 `page.ts`、`runtime.ts`、`vite.config.ts` 與 `tools/` |
| `npx vitest run` | 49 個測試檔、813 項通過（原 790 項＋`face-spike` 19 項＋spike 隱私邊界 4 項） |
| `npx vite build` | 通過；`dist/` 只有主程式資產，沒有 spike 頁、ONNX 模型或 onnxruntime wasm |
| `npx vite build --config spike/face/vite.config.ts` | 通過 |
| `node --check desktop/main.mjs` | 通過 |
| `node scripts/verify-aios.mjs`（根目錄） | PASS（型別含 spike、測試、建置、隔離 mock 任務與直接對話 HTTP） |
| `git diff --check` | 通過；新增的未追蹤檔另以 grep 確認沒有行尾空白 |
| `node scripts/check-pstack.mjs` | 通過（pstack 0.15.29，172 個上游雜湊、56 個技能） |
| `npm run face:setup -- --force` | 5 個模型從釘選網址下載並核對 SHA-256 通過 |
| `npm run face:bench -- --output <repo 內路徑>` | 依設計拒絕並以 1 結束 |
| `npm run face:bench`（完整量測）與 `spike/face/tools/opencv-crosscheck.ts` | 見 §3、§4；建置暫存資料夾已刪除，沒有存截圖 |

## 11. 下一個 gate

ID-00 的放行條件是「現有 delay 內可否取得可用樣本及效能證據」。雲端已確認 runtime、模型版本、權重與程式授權已查核（SFace 訓練資料條款仍未查清）、實作與 OpenCV 一致；**可用樣本與效能仍待 §8 的 Mac＋AR0144 數據**。之後 George 決定 ADR §9 各項，才進 ID-01（登記／刪除、加密特徵、本機辨識）。
