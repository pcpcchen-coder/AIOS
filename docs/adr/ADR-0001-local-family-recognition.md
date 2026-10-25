# ADR-0001：本機家人辨識的資料生命週期與 runtime

狀態：**草案（Proposed）**；George 已於 2026-10-25 決定 §9 大部分項目，偵測器與 SFace 訓練資料風險仍待決。日期：2026-10-24，2026-10-25 依 ID-01 實作修訂 §2.1、§2.2、§10。批次：[14 規劃](../14_Family_Recognition_and_Greeting_Plan_2026-10.md) 的 ID-00、ID-01。

ID-00 是不接進產品流程的 runtime spike（`prototype/ambient-shell/spike/face/`，量測見 [驗證紀錄](../validation/family-id-00-spike-2026-10-24.md)）。ID-01（2026-10-25，分支 `claude/family-id-01`）實作了登記、刪除、加密保存、本機辨識（只在選單列打開的「家人辨識」畫面內）與品質、失效狀態，只有雲端驗證，**沒有 Mac 實機結果、門檻未校準、沒有稱名問候**，見 [ID-01 驗證紀錄](../validation/family-id-01-2026-10-25.md)。

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
- 登記特徵（gallery）不交給 renderer。renderer 只送出當次特徵，核心回傳狀態（matched 才帶 person ID）。這樣生成 UI 或前端錯誤無法讀到全部家人的特徵。

#### 2.1.1 核心持有資料與邏輯、IPC 只做傳輸（2026-10-25，ID-01 採用）

比較過兩個方案：

| | 方案 A：核心持有（採用） | 方案 B：主程序（`desktop/main.mjs`）自己持有 |
|---|---|---|
| gallery、比對、證據規則、名稱驗證 | 核心（`server/identity-service.ts`、`identity-store.ts`，TypeScript）。核心本來就跑在 Electron 主程序（`main.mjs` 以 `import(server.mjs)` 呼叫 `startNous`） | 寫在 `main.mjs` 或旁邊的 `.mjs`，沒有型別 |
| 測試 | vitest 直接測核心（假 SecretBox＋真 AES-GCM、假時鐘、log spy） | 要模擬 Electron 才測得到，Linux 雲端只能 `node --check` |
| 設定與選單列 | 核心算出 `settings.identity`（只有狀態與人數），選單列與頁面讀同一份 | 主程序另外組狀態，和核心的設定是兩份 |
| IPC 面 | 一個通道 `nous:identity`，op 白名單、形狀過濾，轉給 `core.identity.handle` | 每個功能一個通道，邏輯和傳輸混在一起 |
| 缺點 | 核心重啟時 session 失效，畫面要從選單列重開 | — |

做法：

- `startNous` 多一個選項 `identity: { dir, secretBox, excludeFromBackup, confirm, modelDir }`。只有 macOS App 注入；瀏覽器版（`npm start`）沒有注入，`settings.identity` 回報「瀏覽器版不可用」。
  - `secretBox`：`main.mjs` 以 `safeStorage` 實作，只在 `darwin` 且 `isEncryptionAvailable()`（且不是 `basic_text` 後端）時 `available()`。
  - `confirm`：原生確認對話框（`dialog.showMessageBox`）。核心在登記（同意文字；未成年時要勾家長確認）、刪除與清除全部時呼叫，回 true 才寫檔；renderer 無法偽造。這是 CLAUDE.md「永久刪除須經 Action Gate 與當次明確確認」的實作。
- **身分資料不走 loopback HTTP**。`server/app.ts` 沒有任何傳特徵、person ID 或姓名的路由；`GET /api/settings`（與 SSE 的 `hello`、`settings.updated`）的 `identity` 只有選單需要的 `available`、`disabled_reason`、`limited_reason`（鏡頭與模型造成的限制）。人數、世代、gallery 狀態只經 IPC 給已開 session 的頁面（審查 2026-10-25）。
- **薄 IPC**：preload 只多一個 `nousDesktop.identity(request)`（`ipcRenderer.invoke("nous:identity")`）。主程序的處理器先檢查 `event.sender === win.webContents`、`event.senderFrame === sender.mainFrame`、frame 網址以核心網址開頭，再以純函式 `desktop/identity-ipc.mjs` 過濾 op 白名單與欄位形狀（多的欄位丟掉），然後交給核心。語意驗證（特徵正規化、名稱、人數、一致性）由核心負責。
- **管理 session**：只有使用者在選單列點「家人辨識…」後 10 秒內，主視窗本機核心的頁面才能開（主程序記錄點擊時間，`open_session` 時一次性消耗）；沒點選單時語音或頁面腳本自己開會被拒（`not_user_initiated`）。一次只有一個 session；畫面收起、閒置 10 分鐘、開滿 15 分鐘、主視窗 `did-navigate`（含重新載入）或 `render-process-gone`（主程序呼叫 `closeSessions`）、核心關閉（`shutdown`）都會失效。probe、登記、刪除都要有效 session，每個 session 每秒最多 6 次請求。
- **核心重啟與並行**：核心關閉時先進入關閉狀態，等待中的原生確認回來後一律不寫；會改資料的操作（登記、刪除、清除）同時只能有一個，避免疊出多個對話框或用到過期的去重資料；寫入前核對磁碟上的 `gallery_version` 與記憶體相同，不同就拒絕（`stale_gallery`），不拿舊資料覆蓋。
- **ID-01 沒有背景持續辨識**：辨識只在「家人辨識」畫面內的「試認」與登記取樣時運作。看著說話時同步辨識與稱名屬於 ID-02，原本「只在鏡頭運作且看著說話啟用時接受」的條件到 ID-02 再接。
- **比對在核心**：回應不含相似度分數。每位家人的分數取該人各樣本 cosine 的最大值；最高分 ≥ `match` 且領先第二名 ≥ `margin` 才算這一格指向此人，分數接近是 ambiguous，低於門檻是 unknown。只比對模型與前處理版本（detector／recognizer／align／preproc）都相符的家人，不符的標 `needs_reenroll`。之後再經證據規則（`shared/identity.ts` 的 `decideIdentity`）：同一取樣世代內至少 3 格、跨至少 500 ms、全部指向同一人，最新一格不超過 1 秒；**「不認得」與「兩位分不清」也要同樣的證據才回，之前一律是中性的 collecting**，單一格不能拿來探測某張臉是否已登記（審查 2026-10-25）；相鄰兩格斷開超過 500 ms，或世代、`epoch`、`gallery_version` 改變就清空；多張臉一律 ambiguous，不挑最大的臉；品質不足是 unavailable。
- 威脅面照實保留：renderer 內任何程式（含生成 UI 若越界）在 session 內都能呼叫 probe；拿一張臉連續送 3 格以上，仍可從穩定結果推測它是否已登記。對策是 session 只能由使用者點選單列開啟、時長上限、限速、回應不含分數、gallery 相關結果要累積證據才回、重複登記只回「可能已登記」不回是哪一位。生成 UI 本來就不得接觸 preload API（CLAUDE.md 紅線）。
- 刪除、清除與收起畫面時：核心清掉證據並遞增 `epoch`；頁面停止取樣、結束 worker（模型與暫存一併釋放）、丟掉記憶體中的樣本，取樣世代加一，晚到的結果因世代不符被丟掉。
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

**登記**：只能在已解鎖、可管理的本機設定由使用者明確開始，選擇姓名並提供多角度樣本（14 §5）。不接受對鏡頭說「我是 George」覆蓋。登記時只保存特徵，不保存照片。每一位被登記的人都要本人在場、聽過說明並同意，不能由他人代為登記；本人可以隨時要求刪除。未成年家人可以登記：本人在場，並由家長（George）在登記時確認同意（2026-10-25 決定，§9）。

**特徵保存**：每位家人一筆記錄，包含 `person_id`、可口語化的名稱、多個特徵向量、`model_id`（例如 `sface-2021dec@0ba9fbfa…`）、`detector_id`、對齊方式版本、建立與更新時間、`gallery_version`。特徵視為敏感識別資料，不能當成匿名資料。換模型或改前處理時，舊特徵不可混用，必須重新登記；不做跨模型轉換。

**比對**：只與 `active` 且 `model_id` 相符的記錄比對。門檻需用登記以外的保留樣本與陌生人校準，不直接採用 OpenCV 範例的 0.363（14 §4）。

**停用／刪除**：

- 停用：記錄保留但不參與比對，`gallery_version` 遞增。
- 刪除：從加密檔移除該人所有特徵與名稱，並**輪換資料金鑰（crypto-erasure）**：產生新的資料金鑰，以新金鑰重新加密剩下的記錄，原子替換檔案，再把舊金鑰的 Buffer 清零。`gallery_version` 與金鑰世代（`key_generation`）遞增。不留「已刪除但可還原」的副本。
- **包裝後的金鑰與密文放在同一個檔**（2026-10-25，ID-01）：`userData/identity/gallery.v1.json`（0600，資料夾 0700）內含 `wrapped_key`、`nonce`、`tag`、`ciphertext` 與檔頭；AES-256-GCM、每次隨機 nonce，AAD 綁住檔頭（含 `wrapped_key`）。每次寫入（登記、刪除）都換新資料金鑰；寫入順序是 tmp（0600）→ fsync → rename → fsync 資料夾，啟動時清掉中斷留下的 tmp。同一個檔的好處是金鑰與密文一起原子替換，不會出現「新密文配舊金鑰」的中間狀態；代價是快照裡的舊檔同時帶著當時的包裝金鑰（見下方備份與快照）。
- **第一次開 session 才載入**：啟動與 `GET /api/settings` 都不碰 Keychain、不建資料夾、不跑 `tmutil`（審查 2026-10-25）。safeStorage 啟動後才變成可用時，也是先載入既有 gallery 才允許寫入，不會用只含新成員的資料覆蓋。
- 解不開分兩種：**`key_unavailable`**（SecretBox 解不開資料金鑰，例如沒有允許鑰匙圈）可重試，畫面說明允許鑰匙圈或重新啟動，不提供清除；**`corrupt`**（格式不符、tag 不是 16 位元組、GCM 驗證失敗、內容損壞）**不覆寫、不退回明文**，只提供經原生確認的「清除全部家人資料」。包裝金鑰本身被改時也會表現為 `key_unavailable`。
- 載入時逐一檢查特徵（128 維、有限值、‖v‖≈1）；不合格的人照實標為壞資料，列表看得到、可以刪除，但不參與比對。
- **沒有防回滾**：有人用較舊的 gallery 檔整個替換現有檔時，只要舊檔仍能用同一把應用程式金鑰解開就會被接受（例如被刪的人又回來）。寫入前的 `gallery_version` 核對只防止同一台機器上兩個核心互相覆蓋，不防替換檔案。
- 殘餘風險（照實記錄）：`safeStorage` 的應用程式金鑰不輪換，Time Machine 或 APFS 本機快照中的舊 gallery 檔理論上仍可用同一台 Mac 解開（`tests/identity-store.test.ts` 以替身照實重現）；`safeStorage` 以字串進出，資料金鑰的 base64 字串與解密後的 JSON 字串留在 V8 heap 直到被回收，無法主動清零。
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
| `onnxruntime-web` | 1.30.0（精確版本；ID-00 為 devDependency，ID-01 起為 dependency） | MIT | `npm view onnxruntime-web@1.30.0 license` 與各套件 `package.json` | 傳遞依賴：`onnxruntime-common` 1.30.0 MIT、`long` 5.3.2 Apache-2.0、`flatbuffers` 25.9.23 Apache-2.0、`protobufjs` 7.6.6 BSD-3-Clause、`platform` 1.3.6 MIT、`guid-typescript` 1.0.9 ISC，以及 `protobufjs` 的 9 個 `@protobufjs/*`（aspromise、base64、codegen、eventemitter、fetch、float、path、pool、utf8）皆 BSD-3-Clause。`protobufjs` 7.6.6 有 install script（lock 中 `hasInstallScript: true`，執行 `node scripts/postinstall`）；讀過內容，只比對上層 `package.json` 的版本寫法並可能印出警告，不連網、不寫檔 |

權重與程式的授權已查核：沒有 AGPL、GPL 或 NC 授權。MediaPipe 模型卡的「身分辨識範圍外」不是授權限制，而是官方對用途的聲明：若選 BlazeFace 當偵測前端再接 SFace，等於把它用在模型卡排除的場景。這是傾向選 YuNet 的理由之一（§6）。

`onnxruntime-web` 在 ID-00 是 devDependency。ID-01 改為 dependency：worker 的 JS 打包進前端（約 57 kB），14 MB 的 wasm 與兩個模型則不打包，只由 `npm run face:setup -- --product` 安裝到 App 的資料夾（§10）。

## 4. 前後處理的出處

spike 的 TypeScript 模組逐項對照 OpenCV 官方實作（opencv/opencv commit `048f050d`）：

- YuNet：`modules/objdetect/src/face_detect.cpp` 的 `postProcess`（stride 8／16／32、anchor-free 解碼、分數 √(cls·obj)）與 `padWithDivisor`；NMS 依 `modules/dnn/src/nms.cpp` 的 `NMSBoxes`。
- SFace：`modules/objdetect/src/face_recognize.cpp` 的 `alignCrop`（5 點 similarity transform 到 112×112 範本，`warpAffine` INTER_LINEAR）、`feature`（RGB、0–255、NCHW）與 `match`（L2 normalize 後內積）。

雲端交叉核對：同一批像素下，spike 的 YuNet 2026may 解碼結果與 OpenCV 5.0.0 `FaceDetectorYN` 相比，5 張圖的框 IoU 為 1.0000、5 點差 0.000 px、分數差 0.0000；SFace 特徵與 OpenCV `FaceRecognizerSF` 的 cosine 為 0.9999–1.0000。這只證明實作與 OpenCV 一致，不證明辨識準確率。

## 5. 對既有防護的改動

- `tests/camera-privacy.test.ts` 原本禁止 `src/` 任何讀回像素的 API，這條不變。新增一段遞迴掃描 `spike/face/`：只允許 `runtime.ts` 呼叫 `getImageData`，並禁止匯出、錄影、網路、遠端動態 import 與本機儲存 API；另檢查 `src/`、`server/`、`shared/`、`desktop/` 不以任何形式（含動態與副作用 import）引用 spike、主程式入口不含 spike。
- 正式實作（ID-01）的推論 worker 需要同類例外，已限制在單一檔案：`src/` 的 `getImageData` 只准 `sense/identity-worker.ts`，`createImageBitmap` 只准 `sense/pipeline.ts` 的取樣出口；`src/` 全面另禁 `MediaRecorder`、`ImageCapture`、`readPixels`、`convertToBlob`、`showSaveFilePicker`；worker 與其輔助模組另禁網路、本機儲存與 `/api/`（`tests/camera-privacy.test.ts`）。

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
| 每個 Surface 必須帶可驗證的 `visibility_reason` | 辨識本身不產生 Surface；認出熟人不浮出任何畫面（14 I1）。ID-01 的「家人辨識」畫面只由選單列「鏡頭與語音設定 → 家人辨識…」開啟，`visibility_reason` 為 `user_request`，Presentation Policy 照常檢查；不是 launcher 或常駐畫面 |
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

2026-10-25 在分支 `claude/family-id-01` 的處理（雲端驗證，見 [ID-01 驗證紀錄](../validation/family-id-01-2026-10-25.md)）：

- [x] `onnxruntime-web` 改為 dependency（精確 1.30.0）。前端改用它的「外部 wasm」版本（Vite 條件 `onnxruntime-web-use-extern-wasm`），wasm 與模型**不進 dist、不進 release zip**，只由 `npm run face:setup -- --product` 安裝到 App 的資料夾，核心核對雜湊後從 `/face-runtime/` 提供。JS 回應加上 worker 用的 CSP（`connect-src 'self'`、`'wasm-unsafe-eval'`），頁面的 CSP 不放寬；雲端 headless Chromium 確認 worker 內 `fetch` 外部網址與 `eval` 被擋。Electron 中的實際行為待 Mac 驗證。
- [x] preload 的身分 API、主程序的發送者與形狀檢查、核心的限速與世代檢查（§2.1.1）。Electron 的 `ipcMain`／`contextBridge` 實際執行待 Mac 驗證。
- [x] 審查（2026-10-25）修正：刪除先寫檔成功才清零特徵；載入時驗證特徵；gallery 相關結果要累積證據才回；session 時長上限與導覽／重新載入／renderer 結束時關閉；核心關閉與並行寫入的保護；金鑰與檔案損壞分開；gallery 延後到第一次開 session 載入；`authTagLength` 16；settings 只給選單欄位；`/face-runtime/` 每次讀取核對雜湊；寫檔用 `writeFileSync(fd)`。
- [x] YuNet 640 的 letterbox 改成自寫的 OpenCV `cv::resize`（INTER_LINEAR、8 位元定點）移植，縮小時與 `cv2.resize` 逐像素相同（`tests/face-letterbox.test.ts`）；產品 worker 對 OpenCV `FaceDetectorYN`（2023mar、640）＋`FaceRecognizerSF` 的雲端交叉核對：臉數一致、特徵 cosine 0.99993–0.99996。
- [x] 推論移到 module worker（`src/sense/identity-worker.ts`，產品中唯一能讀像素的檔案）。雲端 1 執行緒的單格耗時另見驗證紀錄；**與既有感測迴圈同時跑的影響只能在 Mac 上量**。
- [ ] 門檻校準（`CALIBRATED = false`）：需要家人自願的保留樣本與陌生人（ID-03）。
- [ ] Mac＋AR0144 實測：safeStorage／Keychain 提示、`tmutil isexcluded`、IPC、登記與試認、停止手勢與 CPU、Electron 中的 worker CSP、刪除後重啟（驗證紀錄 §6）。
- [ ] 每位家人的「停用」（保留但不比對）延到之後；ID-01 只有刪除。
