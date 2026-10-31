<!-- bilingual: source=zh-TW -->

> [繁體中文](ADR-0003-local-wake-and-voice-recognition.md) | [English](ADR-0003-local-wake-and-voice-recognition.en.md)

# ADR-0003：本機喚醒與聲音辨識

狀態：**草案（WK-00 交付）；2026-10-31 起 WK-01a 部分實作**：常駐喚醒聆聽的底層（`AudioFrontEnd`、擷取 worker、偏好、自動恢復、自我觸發防護、提示音、旗標 `NOUS_WAKE` 預設關閉）已在分支 `claude/wk-01` 實作，**真正的喚醒引擎尚未接上**（WK-01b），產品偵測器照實回報 `runtime_missing`、不開麥克風；Mac gate 未執行，見 [WK-01a 驗證](../validation/wk-01a-2026-10-31.md)。§2.1 的條文已寫進 ADR-0001。gallery v2、`voice_probe` 與音色辨認仍未實作。日期：2026-10-29，Asia/Taipei。依據：[17 本機喚醒詞與家人音色辨認規劃](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md) §11.2；工程證據：[WK-00 spike 驗證](../validation/wk-00-spike-2026-10-29.md)。另開本 ADR 屬工程流程決定，直接採用並通知 George（17 §14「另行通知」），不列為待決事項。

本 ADR 只定規則與邊界。WK-00 只交付不接產品的 spike（`prototype/ambient-shell/spike/wake/`）。2026-10-31 起，WK-01a 已加入 `AudioFrontEnd` 與喚醒 worker（`src/audio/`，旗標 `NOUS_WAKE` 預設關閉），但 worker 裡**沒有真正的 KWS 引擎**（WK-01b）；gallery v2 與 `voice_probe` 仍不存在。

## 1. 背景

ADR-0001 處理的是鏡頭與臉部特徵，且明定「沒有背景常駐辨識」。喚醒詞需要**常駐開著麥克風**，這是新的紅線面：未喚醒音訊不得寫檔、進 trace 或外傳（CLAUDE.md）。聲音也是新的生物特徵，要與臉部共用同一個 `person_id` 與加密 gallery。兩者各有模型訓練資料的授權風險，與 ADR-0001 的 SFace 待決項分開追蹤比較清楚。

## 2. 決定（草案）

### 2.1 取代與更新 ADR-0001 的條文

1. **取代** [ADR-0001 §2.1.1](ADR-0001-local-family-recognition.md#211-核心持有資料與邏輯ipc-只做傳輸2026-10-25id-01-採用) 中「沒有背景常駐辨識」那一條。新規則：
   - 常駐喚醒偵測是背景常駐**收音**，只在 renderer 本機執行 KWS；未喚醒音訊只在 `AudioFrontEnd` 的 2 秒環形緩衝與 KWS worker 記憶體（17 §5.2）。
   - 音色辨認**不是**常駐：只在已喚醒的互動內（喚醒片段、喚醒後到連線前的話語），或使用者另外開啟「通話中辨認說話者」時，在通話期間的同一串流分支上進行（17 §10.3）。
   - 臉部辨識維持 ADR-0001 的規則，不因常駐收音而變成常駐辨識。
2. **更新** [ADR-0001 §2.4](ADR-0001-local-family-recognition.md#24-雲端語音) 的稱名與雲端揭露說明：稱名可能由臉、聲音或兩者共同決定；名字出現在雲端的範圍與 ADR-0001 §2.4.1 相同（只有核心組好的短句），聲音特徵、音訊片段與家人名單不上傳。
3. ADR-0001 本身的文字**留到實作批次（WK-01／SP-01）再改**，本草案不先修改 ADR-0001。（2026-10-31：WK-01a 已把第 1、2 點寫進 ADR-0001 §2.1.1 與 §2.4。）本 ADR 採用後、ADR-0001 改寫前，兩份 ADR 衝突時以本 ADR 對「常駐收音」與「聲音」的規定為準，其餘以 ADR-0001 為準；草案階段兩者都不改變產品行為。

### 2.2 喚醒事件無法由核心驗證

KWS 在 renderer 執行，核心收到的「偵測到喚醒詞」只是 renderer 的說法。頁面腳本可以假造喚醒事件，或自行呼叫 `/api/realtime/start`（source 為 `wake_word`）開一次真的通話。核心不嘗試證明喚醒是真的，而是限制後果，對策比照 ID-02：

| 對策 | 規則 |
|---|---|
| 限速 | `wake_word` 開始的通話每分鐘最多 3 次（與 ADR-0001 的 `greeting` 限速相同）；超過時暫停聆聽並顯示原因（17 §5.7） |
| 可見 | 沿用既有的即時語音指示與計費說明；每次 `wake_word` 通話記入 F6 費用紀錄（路徑、連線秒數、是否因無人聲自動結束、usage，缺資料標「未知」） |
| `voice_probe` | 新 op，送出聲音特徵，比照 `ambient_probe`：不需要管理 session，但**回應不含任何結果**、被拒時不說原因；每秒最多 4 次、同時最多一個待處理；只在常駐聆聽或「通話中辨認說話者」開啟，且家人辨識管理畫面沒開時接受 |
| `greeting` | 只接受核心在 `/api/realtime/start`（source 為 `wake_word`）發出、尚未使用、對應語音工作階段真的連上且仍在進行、連上後 20 秒內的互動 ID，比照 ID-02 的 `claimGreeting`；頁面自編的 ID 只得到不含名字的問候 |
| 開關（2026-10-31，WK-01a 審查） | 「常駐喚醒聆聽」只能由 App 主程序在原生說明之後打開：主程序在同一個行程直接呼叫核心的 `NousHandle.wake.setListen`，不經 HTTP、也沒有 preload API。`POST /api/settings/wake` 收到 `wake_listen: true` 一律 403；頁面只能記下真的在聽的麥克風（`device_id`）或關掉（關掉一定安全）。瀏覽器版因此不能打開常駐聆聽。`POST /api/settings/camera` 有同一類問題（頁面腳本可以打開鏡頭），列為另一個已知事項，本批不改 |

### 2.3 殘餘風險如何擴大

ADR-0001 §2.1.1 已記錄：頁面腳本可以真的開一次看著說話的通話，再送合成或取得的臉部特徵，在 API key 路徑從 IPC 回應讀到含名字的短句。加入聲音後：

1. 頁面腳本可以從錄音算出聲音特徵送給 `voice_probe`，同一類名字外洩多了一個輸入來源；限速與「`greeting` 只回組好的短句」維持不變。
2. **新增一類風險**：renderer 內的程式可以用假喚醒反覆開付費通話。靠限速、可見指示與費用紀錄控制，無法完全消除。
3. 常駐麥克風開著時，renderer 內任何程式理論上都能讀到 `AudioFrontEnd` 的音訊。這與今天核心網址頁面本來就有 `media` 權限相同，但暴露時間從「通話期間」擴大到「常駐期間」。生成 UI 仍不得接觸 preload API、核心 HTTP 或音訊模組（CLAUDE.md 紅線），並以 `tests/audio-privacy.test.ts` 靜態檢查（WK-01 新增；WK-00 的 spike 已有對應的 `tests/wake-privacy.test.ts`）。
4. 誤喚醒會把客廳聲音經 WebRTC 送到雲端語音供應商，直到通話結束；本機提示音、無人聲自動結束與限速只能縮短、不能消除（17 §5.7）。
5. 聲音可被錄音或模仿；本 ADR 不提供防重播或活體偵測（17 §7.4），所以身分**不是**授權，外部副作用仍須 Action Gate 與當次確認（ADR-0001 §2.5）。
6. **跨次執行的暴露時間**：依 §2.4 的自動恢復，偏好開著時，App 重開、睡眠或鎖定回來都會再開麥克風。使用者可能不記得它還在聽，暴露時間從「這次執行」延長到「直到關掉開關」。緩解只有 §2.4 的恢復字幕、選單列狀態、電子腦上的最小聆聽圖示與首次開啟時的說明，無法消除。

### 2.4 常駐聆聽的自動恢復（George 2026-10-29 決定）

依 [17 §14 ③](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md#14-george-的決定2026-10-29)、§5.8 與 §5.3（與原建議「冷啟動只進 `armed`」不同）：

| 規則 | 內容 |
|---|---|
| 觸發 | 偏好為開、本次執行沒有按「暫停聆聽」時，App 啟動與系統睡眠或螢幕鎖定回來後自動恢復。「登入 macOS 時自動開 App」不屬本功能 |
| 狀態以裝置事件為準 | 先進 `armed`，`getUserMedia` 成功、收到 track `live` 且 AudioWorklet 開始處理後才進 `listening_local`，只有這時顯示「本機聆聽中」 |
| 恢復提示 | 每次成功恢復，主視窗顯示一次性字幕（走既有字幕元件與共用翻譯表，中英雙語），選單列狀態同步；主視窗沒顯示時以選單列為準，下次顯示主視窗補一次字幕 |
| 失敗 | 權限被拒、找不到上次的麥克風、模型載入或雜湊失敗一律進 `error`，字幕與選單列寫原因；不改用其他麥克風、不顯示聆聽、不在背景反覆重試 |
| 首次說明 | 第一次打開開關時的說明寫明「App 重開與睡眠回來後會自動恢復，直到你關掉這個開關」（17 §5.8） |
| 暫停 | 「暫停聆聽」只到本次執行結束；暫停期間睡眠或鎖定回來不恢復，App 重開後會恢復。要長期停止須關選單列開關，畫面照實說明 |
| 與 15 的差異 | [15 §2.2](../15_Companion_Mode_Spec_2026-10-24.md#22-啟用與真正收音是兩回事) 與 §3.1 的 Companion 冷啟動只進 `armed`、其他語音模式結束後不自動恢復收音，因為它會把通過 gate 的內容送往模型。常駐喚醒只在本機偵測，所以刻意採不同規則（17 §5.3）；通話中關掉偏好時，結束後不恢復 |

跨次執行的暴露時間列為殘餘風險（§2.3 第 6 點）。

### 2.5 gallery v2

| 項目 | 規則 |
|---|---|
| 檔案 | `userData/identity/gallery.v2.json`；加密方式沿用 v1：AES-256-GCM、`safeStorage` 包裝的資料金鑰、每次寫入換新金鑰、AAD 綁檔頭、tmp → fsync → rename → fsync 資料夾 |
| 人物記錄 | 每人一個 `person_id`，可以有臉、聲音或兩者（17 §14 ④ 允許只登記聲音）。`face`：沿用 v1 欄位（`model_id`、`detector_id`、特徵陣列）。`voice`：`speaker_model_id`（例如 `campplus-zh-cn-16k-common@<sha256>`）、前處理版本、每次登記的特徵陣列、登記用的麥克風名稱、有效語音秒數、登記時間 |
| 文字相關模板 | 登記時念 5 次喚醒詞，另存為 `voice.keyword_templates`（同一 `speaker_model_id`）；只用於喚醒片段比對（17 §4.4） |
| 校準狀態 | 兩個布林值 `calibrated_keyword`、`calibrated_utterance`，存在 gallery 的設定區（不是每人一份），記錄校準報告的日期、樣本數，以及校準時的 `speaker_model_id`、前處理版本與主要麥克風；報告完成前一律為 false，false 時只有聲音的證據**不稱名**（17 §13.3 S6、S12）。**換 `speaker_model_id`、前處理版本或主要麥克風時，兩者都重設為 false**，重新校準前不稱名 |
| 換模型 | 每筆特徵記模型版本；換模型或前處理時必須重新登記，不做跨模型轉換；不符的特徵不參與比對 |
| 遷移 v1 → v2 | 第一次以 v2 寫入時：解開 v1、把每人的特徵放到 `face`、`voice` 留空，以新資料金鑰寫 v2，成功後刪 v1 並遞增 `key_generation`；v1 讀不開（`corrupt`）時不遷移、不覆寫，照 ADR-0001 提供「清除全部家人資料」 |
| 刪除 | 「刪除聲音」只移除 `voice`；「刪除整個人」移除整筆。兩者都輪換資料金鑰（crypto-erasure）、遞增世代、清掉核心快取並撤銷候選與 `GreetingDecision`；記憶的處理依 17 §9.4 與 §14 ⑨ |
| 殘餘風險 | 與 ADR-0001 §2.2 相同：Time Machine／APFS 快照中的舊檔、V8 heap 的字串、沒有防回滾 |

ADR-0001 §2.4 的稱名說明在實作時補上「也可能依聲音認出」；登記同意文字要寫明聲音可被錄音或模仿、只用於稱呼、個人化與便利性限制、不是安全驗證（17 §11.3）。

### 2.6 喚醒引擎與版本

- 採用 sherpa-onnx KWS（Apache-2.0），開放詞彙，不需錄樣本或訓練（17 §6）。
- **鎖定 2.0.x**，目前為 2.0.1，精確版本。WK-00 查到 1.13.8 的 npm 原生套件（`sherpa-onnx-node` 1.13.8 所帶的 `sherpa-onnx-<平台>` 1.13.8）把 espeak-ng（GPL-3.0）靜態連結進 `libsherpa-onnx-c-api`，作為 TTS 前端；2.0.x 已移除 espeak-ng。依 CLAUDE.md「不引入 AGPL／GPL／NC 依賴」，**1.13.8 不得成為專案依賴**，WK-00 只在 repo 外安裝它做效能比較。自建的 KWS-only wasm（上游 `build-wasm-simd-kws.sh` 關閉 TTS）不含 espeak-ng。
- 模型候選：`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`（中英）與 `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`（中文）。WK-00 的雲端數字見驗證文件；定案要等 Mac 客廳的 W5、W6。
- 執行位置採 17 §10.3 方案 A（renderer 的 AudioWorklet＋wasm）。npm 的 `sherpa-onnx` 套件是 Node 專用 wasm（以 NODERAWFS 存取檔案系統，在瀏覽器會直接丟錯），瀏覽器版必須以上游腳本自建；WK-00 未能在雲端自建（見驗證文件）。若自建 wasm 在 Mac 的 Electron 達不到 17 §5.6 的放行條件，再重新評估方案 B，並另行設計如何維持單一麥克風擁有者。

## 3. 授權查核表（2026-10-29）

已核對的二進位平台：`linux-x64`（安裝後實際執行）與 `darwin-arm64`（以 `npm pack` 下載 2.0.1 與 1.13.8 的平台套件，只做字串搜尋，沒有執行）。

| 項目 | 授權 | 查核方式 | 風險與處置 |
|---|---|---|---|
| `sherpa-onnx-node` 2.0.1、`sherpa-onnx`（wasm）2.0.1、平台套件 `sherpa-onnx-*` 2.0.1 | Apache-2.0 | npm metadata、上游 LICENSE；二進位檔字串搜尋不到 espeak-ng 函式 | 可用；devDependency，精確版本 |
| 2.0.1 內含的第三方程式（依 v2.0.1 標籤的 `cmake/`） | onnxruntime MIT；kaldi-native-fbank、kaldi-decoder、openfst、simple-sentencepiece Apache-2.0；nlohmann/json、utf8proc MIT；hclust-cpp BSD-2-Clause（實際讀過 LICENSE）；eigen MPL-2.0；asio BSL-1.0；websocketpp BSD-3-Clause；portaudio MIT | 上游 CMake 的來源網址；只有 hclust-cpp 逐字讀過 LICENSE，其餘依各專案公開授權 | 無 GPL／NC；eigen 的 MPL-2.0 是檔案層級的弱 copyleft，不改其原始碼即無額外義務 |
| `sherpa-onnx-node` 1.13.8 與平台套件 1.13.8 | 標示 Apache-2.0，**但靜態連結 espeak-ng（GPL-3.0）** | v1.13.8 標籤有 `cmake/espeak-ng-for-piper.cmake`、`SHERPA_ONNX_ENABLE_TTS` 預設 ON；linux-x64 的 `libsherpa-onnx-c-api.so` 與 darwin-arm64 的 `libsherpa-onnx-c-api.dylib` 都含 `espeak_Initialize` 等符號 | **不得作為依賴**；只在 repo 外比較 |
| `sherpa-onnx`（Node wasm）1.13.8 | Apache-2.0 | `.wasm` 內含 espeak-ng 錯誤訊息字串，搜尋不到 espeak 函式符號（wasm 符號已剝除，無法確認未連結） | 同樣不採用；結論相同 |
| KWS 模型 wenetspeech-3.3M | 模型卡 Apache-2.0；訓練資料 WenetSpeech 條款矛盾（17 §6.2） | 壓縮檔內 README | George 2026-10-29 接受並記錄（17 §14 ②） |
| KWS 模型 zh-en-3M | 壓縮檔內沒有授權檔或訓練資料說明 | 壓縮檔內容 | 同上 |
| 講者模型（SP-00 起） | 見 17 §7.1 | — | 同上；SP-00 再實際查核 |
| WK-00 評估用 TTS 與語料（不進產品） | vits-icefall-zh-aishell3：資料 AISHELL-3 Apache-2.0；vits-melo-tts-zh_en：MIT；AISHELL-1：Apache-2.0；LibriSpeech：CC BY 4.0 | OpenSLR 93／33／12 頁面、壓縮檔內 LICENSE | 只下載到 repo 外或 gitignore 的資料夾，不 commit |
| sox（Mac 實測擷取麥克風用） | GPL-2.0-or-later | — | 使用者另以 Homebrew 安裝的獨立程式，經管線把 PCM 交給 spike；不在 package.json、不連結、不散布。產品（WK-01）以 `AudioFrontEnd` 在 renderer 擷取，不用 sox |

## 4. 與 CLAUDE.md 紅線對照

| 紅線 | 本 ADR 的處理 |
|---|---|
| 原始 webcam 影像與未喚醒音訊不得寫檔、進 trace 或外傳 | 未喚醒音訊只在 2 秒環形緩衝與 KWS worker；IPC 只傳事件與特徵向量；trace 只記時間、關鍵詞編號、是否過門檻（17 §5.2） |
| 注視只選定目標，不觸發副作用 | 喚醒詞只開一次通話，不提交、不刪除；外部副作用仍走 Action Gate |
| 外部副作用須 Action Gate 與當次確認 | 聲音身分不是授權（§2.3 第 5 點） |
| 生成 UI 不得取得 shell、檔案系統、MCP token 或任意網路 | 生成 UI 不得接觸 `AudioFrontEnd`、preload 或核心 HTTP；靜態測試 |
| 收音狀態以裝置事件為準 | 只有 track `live` 且 AudioWorklet 開始處理後才顯示「本機聆聽中」（17 §5.1）；自動恢復也先進 `armed`，並顯示一次性恢復字幕（§2.4） |
| 不引入 AGPL／GPL／NC 依賴 | 鎖 sherpa-onnx 2.0.x；1.13.8 排除（§2.6） |

## 5. 後果

- 常駐收音成為新的長時間暴露面；以限速、可見指示、費用紀錄與靜態測試控制。
- gallery 從 v1 升到 v2，需要一次遷移與測試；舊快照風險不變。
- 瀏覽器版 KWS 需要自建 wasm，增加一個建置步驟與一份要追蹤的二進位檔雜湊。
- 依賴 sherpa-onnx 2.0.x 這條新大版本線（2.0.0 為 2026-10-23 發布），升版需單獨 PR 並重跑 WK-00 量測。

## 6. 待證明與下一步

- W5、W6、W11（家人 30 次喚醒、電視 8 小時、與鏡頭同時的 CPU 與 80 ms 迴圈）只能在 Mac 客廳量，步驟見驗證文件。
- 在 Mac 上依上游腳本自建 KWS wasm，並在 Electron 44.9.3 確認視窗隱藏時 AudioWorklet 是否持續運作。
- 雲端合成正例對完整候選詞 0/300 命中、原因未定；家人實測要同時跑替代念法「哈囉努斯(hā-lóu)」與子詞「努斯」，判斷是合成語音還是「哈囉」的發音單元，喚醒詞的發音單元定案前不進 WK-01 的關鍵詞檔。
- SP-00 講者模型 spike 與授權查核。
- ~~WK-01 實作時把本 ADR 的 §2.1 條文寫進 ADR-0001，並建立 `tests/audio-privacy.test.ts`。~~ 2026-10-31 WK-01a 已完成這兩項。
- WK-01b：依 George 的 Mac WK-00 結果，由 GitHub Actions 自建 KWS wasm、寫入雜湊清單與關鍵詞檔，`SherpaWasmDetector` 真正載入（17 §14.1）。
