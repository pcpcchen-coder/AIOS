# ADR-0001：本機家人辨識的資料生命週期與 runtime

狀態：**草案（Proposed）**，尚待 George 決定 §9 各項。日期：2026-10-24。批次：[14 規劃](../14_Family_Recognition_and_Greeting_Plan_2026-10.md) 的 ID-00。

本 ADR 只定義邊界與候選做法。程式只有不接進產品流程的 runtime spike（`prototype/ambient-shell/spike/face/`），沒有家人登記、特徵保存、辨識結果或稱名問候。spike 量測見 [驗證紀錄](../validation/family-id-00-spike-2026-10-24.md)。

編號說明：這是本 repo `docs/adr/` 的第一份 ADR。[08](../08_Consolidation_and_Update_2026-10.md) 提到的 ADR-001–005 是當時的提案標籤，沒有在 repo 建檔；[11](../11_Stereo_Camera_Interaction_2026-10.md) 引用的 ADR-0002、ADR-0005 屬於另一個 repo（this-is-yourX）。三者不是同一個編號序列。

## 1. 背景

14 規劃要在使用者靠近並以「看著說話」啟動互動時，若已可靠認出主動登記的家人，就說「George，我在」；認不出就說「我在」。辨識與既有面向 delay 同步進行，不延長等待（14 §2）。

這需要三樣目前沒有的東西：

1. 本機的人臉偵測、對齊與特徵模型，能在 Electron renderer 內跑，不阻塞既有 80 ms 感測迴圈。
2. 一套敏感識別資料的保存與刪除規則。臉部特徵即使不是照片，仍可用來識別個人。
3. 跟 CLAUDE.md 紅線一致的資料流：原始影像不寫檔、不進 trace、不外傳；身分不能變成授權。

現有原型只用 MediaPipe Pose 與手勢模型，`numPoses: 1`，不能證明畫面只有一人（14 §5），也沒有人臉框或臉部關鍵點輸出。

## 2. 決定（草案）

### 2.1 管線

```
AR0144 左眼 1280×720（沿用 SensePipeline 已開的串流，不第二次開鏡頭）
  │ 只在 renderer 記憶體
  ▼
人臉偵測（YuNet 或 MediaPipe Face Detector，§6 依 spike 數據）→ 臉數、框、5 點
  │ 品質檢查：單一臉、臉寬 ≥ 起點 100 px、分數、正面程度
  ▼
SFace 對齊（5 點 similarity transform → 112×112）→ 128 維特徵，L2 normalize
  │ 只有特徵向量離開推論 worker；像素張量用完即丟
  ▼
核心比對（Electron 主程序，經 IPC，不走 HTTP）
  │ 解密登記特徵只在記憶體；cosine 對每位家人取最大值
  ▼
IdentityObservation { state: matched | unknown | ambiguous | unavailable,
                      person_id?（只有 matched）, track_generation, observed_at, model_version, gallery_version }
```

- 推論放在 renderer 的專用 worker，原因是像素已經在 renderer；把影像經 IPC 送到主程序反而多一條影像通道。
- 登記特徵（gallery）不交給 renderer。renderer 只送出當次特徵，核心回傳狀態與 person ID。這樣生成 UI 或前端錯誤無法讀到全部家人的特徵。
- **IPC 是新的攻擊面**，需要在 ID-01 明確設計：
  - Web Worker 不能直接呼叫 Electron IPC。特徵向量由 worker `postMessage` 給 renderer 主執行緒，再經 preload 以 `contextBridge` 暴露的**新** API（例如 `nous.identity.match(feature, trackGeneration)`）送到主程序。目前 `desktop/preload.cjs` 沒有這個 API，需要新增。
  - 這個 API 只接受固定長度（128）的 Float32 向量與整數世代，回傳 `IdentityObservation`；不提供列出家人、讀取 gallery、讀名稱以外欄位或匯出的功能。
  - 威脅面：renderer 內任何程式（含生成 UI 若越界）都能呼叫這個 API，可藉反覆查詢推測某張臉是否已登記。對策是主程序端限速（與 4 Hz 取樣相符）、只在鏡頭運作且看著說話啟用時接受、回應不含相似度數值。生成 UI 本來就不得接觸 preload API（CLAUDE.md 紅線），此 API 也不例外。
- 刪除、停用、關鏡頭時，主程序除了清自己的狀態，也要通知 renderer：worker 取消進行中的推論、丟棄暫存的特徵與候選，並遞增 renderer 端的追蹤世代。
- 第一版上限 2–5 位登記家人（14 §5）；超過上限拒絕新登記，不自動覆蓋。
- 每次取樣約 4 Hz、同時最多一個待處理推論；結果帶追蹤世代，世代不符一律丟棄（14 §3、§4）。

### 2.2 資料生命週期

| 階段 | 存在哪裡 | 保存多久 | 規則 |
|---|---|---|---|
| 原始畫格 | renderer 記憶體（既有畫布） | 單次推論 | 不寫檔、不進 trace、不上雲、不送核心。讀出的像素只做成推論張量，推論後即釋放 |
| 對齊後 112×112 張量 | 推論 worker 記憶體 | 單次推論 | 同上；登記流程也不保存對齊後影像 |
| 當次特徵 | worker → renderer 主執行緒 → IPC → 核心記憶體 | 比對完成即丟 | 不記 log；trace 只記狀態與耗時 |
| 登記特徵（gallery） | 核心，加密檔 | 直到使用者刪除或停用 | 見 §2.3 |
| 辨識結果 | 核心記憶體，綁追蹤世代 | 約 1 秒新鮮度（14 §4） | 只有 `matched` 帶 person ID；換人、關鏡頭、追蹤斷開即撤銷 |

**trace 與 log**：任何 trace、log、錯誤回報、SSE 事件與驗證證據都不得包含特徵向量、`person_id`、姓名或相似度數值。只允許記錄狀態（`matched`／`unknown`／`ambiguous`／`unavailable`）、耗時、模型版本與世代。除錯需要更多資訊時，在本機記憶體內檢視，不落盤。

**登記**：只能在已解鎖、可管理的本機設定由使用者明確開始，選擇姓名並提供多角度樣本（14 §5）。不接受對鏡頭說「我是 George」覆蓋。登記時只保存特徵，不保存照片。每一位被登記的人都要本人在場、聽過說明並同意，不能由他人代為登記；本人可以隨時要求刪除。未成年家人能否登記、由誰同意、是否另設限制，列為 §9 待決，決定前不支援。

**特徵保存**：每位家人一筆記錄，包含 `person_id`、可口語化的名稱、多個特徵向量、`model_id`（例如 `sface-2021dec@0ba9fbfa…`）、`detector_id`、對齊方式版本、建立與更新時間、`gallery_version`。特徵視為敏感識別資料，不能當成匿名資料。換模型或改前處理時，舊特徵不可混用，必須重新登記；不做跨模型轉換。

**比對**：只與 `active` 且 `model_id` 相符的記錄比對。門檻需用登記以外的保留樣本與陌生人校準，不直接採用 OpenCV 範例的 0.363（14 §4）。

**停用／刪除**：

- 停用：記錄保留但不參與比對，`gallery_version` 遞增。
- 刪除：從加密檔移除該人所有特徵與名稱，並**輪換資料金鑰（crypto-erasure）**：產生新的資料金鑰，以新金鑰重新加密剩下的記錄，原子替換檔案與包裝後的金鑰，再把舊金鑰從記憶體清零並刪除其包裝檔。`gallery_version` 遞增，並記錄目前的金鑰世代（`key_generation`）。不留「已刪除但可還原」的副本。
- 兩者都要立即：清掉核心記憶體中的解密 gallery 快取；撤銷所有指向該 person ID 的候選與 `GreetingDecision`；遞增追蹤世代，讓晚到的推論與比對結果因世代不符被拒絕。
- 關鏡頭、sensor degraded、模型錯誤：同樣清除候選並遞增世代（14 §3、I5、I8、I9）。
- 備份與快照：Time Machine 與 APFS 本機快照會保留**舊的加密檔**。只輪換金鑰還不夠：若舊的「包裝後資料金鑰」也在同一份快照裡，而 Keychain 中包裝它的應用程式金鑰仍在，舊 gallery 仍可被解開。因此：
  - 資料金鑰的存放處要能真正被刪除且不跟著檔案快照走。用 `safeStorage` 時包裝後的金鑰必然是 `userData` 裡的檔案，只能以 Time Machine 排除（`tmutil addexclusion`）降低風險，APFS 本機快照仍可能保留。直接把資料金鑰存成 Keychain 項目（僅限本機、不同步）可以在輪換時刪除該項目，是較完整的 crypto-erasure；George 於 2026-10-25 決定先採 `safeStorage`（見 §9）。
  - 設定畫面的刪除說明要寫清楚：刪除後新的資料無法還原；在此之前已存在的系統備份與快照中，舊資料是否仍可解開取決於上述金鑰存放方式。
  - 加密檔本身也加入 Time Machine 排除，減少舊密文副本。

### 2.3 加密金鑰

- **候選：Electron `safeStorage`**。桌面版的核心本來就跑在 Electron 主程序（`desktop/main.mjs` 載入 `server.mjs`），可以直接呼叫。macOS 上 `safeStorage` 以 Keychain 中的應用程式金鑰加密。做法：產生隨機資料金鑰，以 `safeStorage.encryptString` 包裝後存檔；gallery 用該資料金鑰以 AES-256-GCM 加密。每次刪除人物時輪換資料金鑰（§2.2），檔頭記錄 `key_generation`。
- **替代：資料金鑰直接存為 macOS Keychain 項目**（`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`、不同步 iCloud）。輪換時刪除舊項目，舊快照中的密文即使留存也沒有可用的金鑰。需要原生模組與簽章流程；2026-10-25 決定暫不採用（§9）。
- `safeStorage.isEncryptionAvailable()` 為 false 時，不建立 gallery，辨識功能顯示為不可用，不退回明文。
- **瀏覽器版（`npm start` + 一般瀏覽器）沒有同等保護**：核心是純 Node 程序，沒有 Keychain 綁定。這個模式下明示關閉辨識，原有對話與看著說話照常運作。
- 2026-10-25 George 決定採 `safeStorage`，不加 Keychain 原生模組（§9）。

### 2.4 雲端語音

- 雲端只會收到最後的短句文字，例如「George，我在」。不上傳影像、特徵、相似度或其他家人的名單。
- 提供「辨識開啟，但不在雲端語音稱名」選項：仍可在本機辨識，但問候一律用「我在」。
- 名稱由核心從受管理的人物檔案取出，限制長度並拒絕控制字元、標記與指令內容（14 §6、I11）。客戶端傳來的任意文字不能變成名稱。

### 2.5 身分不作授權依據

辨識結果只用於稱呼。它不能解鎖私人資料、不能放行 Action Gate、不能代替當次明確確認、不能切換帳號或模型憑證。照片、影片、螢幕都可能騙過模型；本 ADR 不包含活體或防偽。

## 3. 模型與授權（2026-10-24 實際查核）

| 元件 | 版本與來源 | 授權 | 查核方式 | 注意事項 |
|---|---|---|---|---|
| YuNet | `face_detection_yunet_2023mar.onnx`，Hugging Face `opencv/face_detection_yunet` revision `3cc26e7f`；SHA-256 `8f2383e4…52fa4` | MIT（Copyright 2020 Shiqi Yu） | 讀取該 revision 的 `LICENSE` 與 README「All files in this directory are licensed under MIT」 | 輸入固定 1×3×640×640 |
| YuNet 動態版 | `face_detection_yunet_2026may.onnx`，OpenCV Zoo commit `48b10fa5`（GitHub LFS）；SHA-256 `ebafce4e…0f0` | MIT（同目錄同一 LICENSE） | OpenCV Zoo README：由 2023mar 重新匯出、高寬改為動態 | 可直接吃 1280×736；spike 一併量測 |
| SFace | `face_recognition_sface_2021dec.onnx`，Hugging Face `opencv/face_recognition_sface` revision `3d708243`；SHA-256 `0ba9fbfa…e79` | Apache-2.0 | 讀取 `LICENSE` 全文與 README「licensed under Apache 2.0 License」 | 訓練資料：SFace 論文與上游 README 說明以 CASIA-WebFace、VGGFace2、MS-Celeb-1M 實驗，OpenCV Zoo 未載明這個 ONNX 用哪一組。模型權重授權是 Apache-2.0，但訓練資料的來源與條款未能查清，列為 §9 待決風險 |
| MediaPipe BlazeFace short range | `blaze_face_short_range.tflite`，`mediapipe-models/face_detector/…/float16/1/`；SHA-256 `b4578f35…152f` | Apache-2.0 | 官方模型卡（2021-06-09）「LICENSED UNDER Apache License, Version 2.0」 | 模型卡把「超過 2 m 的人」與「任何形式的監控或身分辨識」列為範圍外 |
| MediaPipe BlazeFace full range | `blaze_face_full_range.tflite`，同上路徑 `/float16/1/`；SHA-256 `3698b18f…181b` | Apache-2.0 | 官方 full range 模型卡 | 範圍外同樣列出身分辨識；適用距離寫到 5 m |
| `@mediapipe/tasks-vision` | 1.1.1（既有依賴） | Apache-2.0 | 既有 | |
| `onnxruntime-web` | 1.30.0（精確版本，devDependency） | MIT | `npm view onnxruntime-web@1.30.0 license` 與各套件 `package.json` | 傳遞依賴：`onnxruntime-common` 1.30.0 MIT、`long` 5.3.2 Apache-2.0、`flatbuffers` 25.9.23 Apache-2.0、`protobufjs` 7.6.6 BSD-3-Clause、`platform` 1.3.6 MIT、`guid-typescript` 1.0.9 ISC，以及 `protobufjs` 的 9 個 `@protobufjs/*`（aspromise、base64、codegen、eventemitter、fetch、float、path、pool、utf8）皆 BSD-3-Clause。`protobufjs` 7.6.6 有 install script（lock 中 `hasInstallScript: true`，執行 `node scripts/postinstall`）；讀過內容，只比對上層 `package.json` 的版本寫法並可能印出警告，不連網、不寫檔 |

權重與程式的授權已查核：沒有 AGPL、GPL 或 NC 授權。MediaPipe 模型卡的「身分辨識範圍外」不是授權限制，而是官方對用途的聲明：若選 BlazeFace 當偵測前端再接 SFace，等於把它用在模型卡排除的場景。這是傾向選 YuNet 的理由之一（§6）。

`onnxruntime-web` 目前是 devDependency，因為只有 spike 使用，主程式 build 與 Electron 包都不含它。ID-01 若採用 YuNet 或 SFace，需改為 dependency，並在桌面打包中確認 wasm 檔案與 CSP。

## 4. 前後處理的出處

spike 的 TypeScript 模組逐項對照 OpenCV 官方實作（opencv/opencv commit `048f050d`）：

- YuNet：`modules/objdetect/src/face_detect.cpp` 的 `postProcess`（stride 8／16／32、anchor-free 解碼、分數 √(cls·obj)）與 `padWithDivisor`；NMS 依 `modules/dnn/src/nms.cpp` 的 `NMSBoxes`。
- SFace：`modules/objdetect/src/face_recognize.cpp` 的 `alignCrop`（5 點 similarity transform 到 112×112 範本，`warpAffine` INTER_LINEAR）、`feature`（RGB、0–255、NCHW）與 `match`（L2 normalize 後內積）。

雲端交叉核對：同一批像素下，spike 的 YuNet 2026may 解碼結果與 OpenCV 5.0.0 `FaceDetectorYN` 相比，5 張圖的框 IoU 為 1.0000、5 點差 0.000 px、分數差 0.0000；SFace 特徵與 OpenCV `FaceRecognizerSF` 的 cosine 為 0.9999–1.0000。這只證明實作與 OpenCV 一致，不證明辨識準確率。

## 5. 對既有防護的改動

- `tests/camera-privacy.test.ts` 原本禁止 `src/` 任何讀回像素的 API，這條不變。新增一段遞迴掃描 `spike/face/`：只允許 `runtime.ts` 呼叫 `getImageData`，並禁止匯出、錄影、網路、遠端動態 import 與本機儲存 API；另檢查 `src/`、`server/`、`shared/`、`desktop/` 不以任何形式（含動態與副作用 import）引用 spike、主程式入口不含 spike。
- 正式實作（ID-01）的推論 worker 會需要同類例外。屆時應把允許範圍限制在單一檔案，並以同樣方式檢查，不把整個前端放寬。

## 6. 偵測器選擇

依 spike 數據決定，雲端結果見 [驗證紀錄 §3](../validation/family-id-00-spike-2026-10-24.md#3-雲端量測結果)。雲端只能提供方向，**最終選擇需要 Mac＋AR0144 實測**。

目前的傾向（待 Mac 數據確認）：**YuNet 2023mar（640×640）作為偵測前端**。理由：

1. SFace 的對齊需要雙眼與兩個嘴角共 5 點。YuNet 直接輸出這 5 點；BlazeFace 只有嘴巴中心，接 SFace 需要另外推估嘴角，多一個未驗證的誤差來源。
2. 雲端 1280×720 畫格中，臉寬約 60 與 100 px 時 BlazeFace short range 大多偵測不到或框偏大（輸入只有 128×128）；YuNet 兩版與 BlazeFace full range 都能偵測。
3. BlazeFace 模型卡把身分辨識列為範圍外。

反方理由：BlazeFace 在雲端的單次耗時較低，且已有 tasks-vision 依賴。若 Mac 上 YuNet 拖慢既有感測迴圈或停止手勢，再重新評估（例如 full range 加嘴角推估，或只在 ROI 上跑 YuNet）。

## 7. 與 CLAUDE.md 紅線逐條對照

| 紅線 | 本 ADR 的處理 |
|---|---|
| 不建立 App launcher、App 圖示、常駐側欄、首頁 Dashboard、預設聊天主頁 | 辨識沒有新畫面。spike 頁是開發者工具，獨立 Vite 設定、只綁 127.0.0.1，不是主程式的 entry，不在主畫面或選單出現 |
| 每個 Surface 必須帶可驗證的 `visibility_reason` | 辨識本身不產生 Surface；認出熟人不浮出任何畫面（14 I1）。日後的登記與刪除畫面由使用者在設定中開啟，沿用 `user_request` |
| 注視只選定目標，不觸發副作用；眨眼不是點擊 | 辨識只產生稱呼候選，不觸發展開、提交或刪除。問候仍由既有的看著說話啟動條件觸發 |
| 「收起」只關視圖，「停止任務」才取消 | 不改變；收起時取消尚未送出的問候（14 §3 條件 6） |
| 外部副作用須經 Action Gate 與當次明確確認 | 身分不作授權依據（§2.5），不能代替確認 |
| 生成 UI 不得取得 shell、檔案系統、MCP token 或任意網路 | gallery 與金鑰只在核心；renderer 推論 worker 拿不到 gallery。生成 UI 無法存取辨識結果以外的資料 |
| 原始 webcam 影像與未喚醒音訊不得寫檔、進 trace 或外傳 | §2.2：原始畫格與對齊影像只在記憶體，不寫檔、不進 trace、不上雲；登記也不存照片；trace 也不記 person ID、姓名或相似度。spike 以 CSP `connect-src 'self'` 與靜態測試限制；雲端量測中 Playwright 沒有觀察到離開本機的請求，MediaPipe 的用量紀錄連線被 CSP 擋下（驗證紀錄 §6） |
| mock、fixture、replay 必須明確標示 | spike 頁與驗證紀錄標明是雲端 CPU／WASM 數字、cosine 只是 sanity check |
| 動畫只能由真實事件驅動 | 辨識不驅動腦區動畫；若日後讓視覺區亮起，來源須是真實推論事件並標明，不在沒有影像輸入時宣稱正在觀看 |

## 8. 後果

- 好處：身分資料留在本機並可刪除；renderer 拿不到 gallery；兩條語音路徑共用同一個受限名稱來源。
- 代價：多一個 wasm runtime（onnxruntime-web 約 14 MB wasm）與約 39 MB 的 SFace 模型；瀏覽器版不能用辨識。
- 風險：SFace 訓練資料條款未查清；雲端耗時不代表 Mac；BlazeFace 與 YuNet 在 AR0144 實際畫質下的表現未知；cosine 門檻尚無校準資料。
- 既有依賴的發現：`@mediapipe/tasks-vision` 1.1.1 內建用量紀錄，會嘗試 POST 到 `odml.pa.googleapis.com/v1/log`（程式中可見的欄位是任務類型與耗時統計，沒有影像）。spike 頁的 CSP 會擋下，spike 量測已觀察到被擋。主程式只有經本機核心提供頁面時（`npm start` 與 Electron）才帶 CSP `connect-src 'self'`；**Vite 開發伺服器（`npm run dev:web`）目前沒有 CSP，這時用量紀錄會送出**。這是既有問題，另案處理。正式實作不得放寬 CSP，詳見驗證紀錄 §6。

## 9. George 的決定與仍待決事項

2026-10-25 George 已決定：

- 金鑰（原第 3 項）：採 Electron `safeStorage`，不另做 Keychain 原生模組。已知限制照實保留：包裝後的資料金鑰是 `userData` 裡的檔案，Time Machine 或 APFS 本機快照中的舊 gallery 可能仍解得開（§2.2）。ID-01 仍做刪除時輪換金鑰，並以 `tmutil addexclusion` 把 gallery 與包裝金鑰排除在 Time Machine 之外以降低風險；刪除說明要告訴使用者這個限制。
- 雲端稱名（原第 4 項）：預設稱名；設定裡可以關掉。雲端只收到姓名短句，不收臉部影像、特徵或家人名單。
- 登記入口與瀏覽器版（原第 5、6 項）：入口放在 macOS App 選單列「鏡頭與語音設定」裡的「家人辨識…」，多角度樣本起點 5–10 張（ID-01 實測後再調）。瀏覽器版不支援辨識，明示「辨識不可用」，原有對話與看著說話照常。
- 未成年家人（原第 7 項）：可以登記，由家長（George）在登記時確認同意；規則與成人相同：只用於稱呼、不作授權、可隨時刪除。

仍待決：

1. 偵測器：在 Mac 實測後選 YuNet（目前傾向）或 MediaPipe full range。實測步驟見驗證紀錄 §8。
2. SFace 訓練資料風險是否可接受，或要求先換成訓練資料條款清楚的模型。

## 10. ID-01 待辦（已知、不需 George 決定）

- `onnxruntime-web` 改為 dependency，並在桌面打包中確認 wasm 檔案與 CSP。
- 新增 preload `contextBridge` 身分比對 API、主程序限速與世代檢查（§2.1）。
- YuNet 640 的 letterbox 路徑用 canvas 縮放，與 OpenCV `resize` 的插值不同，**spike 沒有對 OpenCV 核對這條路徑**（交叉核對用的是 2026may 原尺寸路徑）。若採用 YuNet 640，需補一次核對或改用自寫的縮放。
- 推論改到 worker，並以 OffscreenCanvas 或 `VideoFrame` 重量 pre 耗時。
