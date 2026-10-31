<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

# 驗證紀錄索引

2026-10-26 新增：[中英文文件與 App／網頁驗證](bilingual-2026-10-26.md)，涵蓋文件同步、介面切換與保存、對話語言及隔離 mock 畫面測試。

更新日期：2026-10-31（加入 HIST-1 與 ID-02 的 Mac 實機紀錄）。2026-10-30 加入家庭記憶 MEM-2、MEM-3、MEM-4a、MEM-4b、MEM-4c、MEM-5a、MEM-5b 與成果紀錄 HIST-1；這些批次都已合併到 main，Mac gate 未執行。2026-10-29 加入 WK-00 喚醒詞 spike 與家庭記憶 MEM-1。本目錄保留每次驗證的原始日期、方法與限制。舊紀錄不因新文件更新而升格為實機通過；後續結果以新增紀錄或明確補記呈現。

| 紀錄 | 證據範圍與限制 |
|---|---|
| [成果紀錄 HIST-1：Mac 實機](history-hist1-mac-2026-10-31.md) | 2026-10-31，Mac mini、App `9c67e65`、ad-hoc 簽章、mock 引擎：主要放行條件成立（選單、Surface、`/history`、原生刪除對話框、收起不取消）；第 3b 步不通過（「晚餐」找不到「晚饭」），另有 F1（即時語音接走本機指令）、F3、F4 與 N1；F2（3b）、F3、F4 已在 PR #61 修正，只有 Linux 自動測試，待 Mac 重驗；F1、N1 與「14 筆／15 筆」差異未處理 |
| [家人辨識 ID-02：Mac 實機](family-id-02-mac-2026-10-31.md) | 2026-10-31，部分完成、未放行：ChatGPT 方案校正後稱名 4/4、稱名關閉兩路通過、兩路時序；API key 改句（F1）、兩路先開口（F2、F10）不通過；手掌停止次數不足；需要第二個人的第 2、4、5 步與第 7 步未做。測試中的修正已合併（PR #57、#58），F11 只加強指示（PR #60），F1、F2、F7、F10 的修正（PR #62）只有 fixture，待 Mac 重驗；F3、F8、F11 未解 |
| [喚醒詞 WK-00 spike](wk-00-spike-2026-10-29.md) | sherpa-onnx 1.13.8／2.0.1 的 Node 與 Node wasm KWS、兩個模型、三個候選詞在雲端容器的 CPU、記憶體、即時率與公開語料每小時誤報；TTS 合成正例 0/300 命中，原因未定（合成語音或「哈囉」的發音單元），0 誤報與 0 命中同時出現，不能解讀成誤報低；瀏覽器 wasm 未自建；Mac 客廳的家人正例與電視負例待測 |
| [常駐喚醒聆聽 WK-01a](wk-01a-2026-10-31.md) | `AudioFrontEnd`、擷取 worker、偏好與自動恢復、自我觸發防護、提示音、選單列「喚醒詞」段（「通話中辨認說話者」為停用列），旗標 `NOUS_WAKE` 預設關閉、關閉時逐位元組相同；**沒有喚醒引擎**，偵測器照實回報 `runtime_missing`、不開麥克風；fixture 與假時鐘的雲端測試；Mac gate 未執行 |
| [成果紀錄 HIST-1](history-hist1-2026-10-30.md) | 2026-10-30：一般任務與成果的成果紀錄（`GET /api/history` 記憶體內搜尋、篩選、分頁、片段標示；App 內按需 Surface 與獨立網頁 `/history`；經原生確認的刪除、沿用重試的重做）；Linux 上的單元、HTTP、假 DOM 與 Vite 建置測試，500 筆合成任務的延遲；審查時另有雲端 headless Chromium 的操作與截圖（截圖不在 repo），Mac 驗證未執行；加密與受保護成果在 MEM-4a、MEM-4c |
| [家庭記憶 MEM-2](memory-mem2-2026-10-30.md) | 2026-10-30：ChatGPT 方案即時語音的記憶（新通話只帶釘選、codex 獨立同意、`recall_memory`、用說的確認記住／更正／忘記與殘餘風險、撤銷、停播回報與強制靜音、重建、交辦封鎖）；Linux 上真 AES-GCM、假 sideband、真 HTTP／SSE 與 FakePeer 的測試與 canary；主要放行條件（錄音證明沒有晚到的舊聲音）與 Mac 第 0–11 步全部未執行 |
| [家庭記憶 MEM-3](memory-mem3-2026-10-30.md) | 2026-10-30：OpenAI API key 即時語音的記憶（預設關閉，`NOUS_MEMORY_ROUTES` 打開；核心用 call ID 開 API key 旁路當唯一控制面、只認旁路的語音辨識逐字稿、`session.update` 帶入、旁路接不上就不帶記憶、`openai_realtime` 獨立同意、停播回報加 hangup 兩道停止、重建走同一路徑）；Linux 上假的 GA 伺服器、真 HTTP／SSE、FakePeer 與真 AES-GCM 的測試、請求快照與 canary；第 8 節的決定都是預設、等 George 確認；線路探測 P1–P5 與 Mac 第 0–15 步全部未執行 |
| [家庭記憶 MEM-4a](memory-mem4a-2026-10-30.md) | 2026-10-30：macOS App 加密全部任務與成果（`data/sealed/` 一筆一檔、AES-256-GCM、safeStorage 包裝；`tasks.json` 只留外殼），舊明文在 App 內搬遷一次、備份保留到使用者確認刪除；所有對外頻道只給外殼，真實內容只經 IPC；背景任務自動帶記憶（預設關閉，`NOUS_MEMORY_ROUTES` 的 `task`）與撤銷傳播（忘記、更正、撤回同意、刪除人物、關閉記憶）；Linux 上真 AES-GCM、真 rename／fsync、flock 測試鎖、假執行器、真 HTTP／SSE 的測試與 canary；Mac 第 1–11 步全部未執行 |
| [家庭記憶 MEM-4b](memory-mem4b-2026-10-30.md) | 2026-10-30：語音交辦自動帶記憶（跟著 `NOUS_MEMORY_ROUTES` 的 `task`，API key 另外要 `api_key`；關閉時和 MEM-4a 逐位元組相同）。核心記下合格的使用者語音原句（排除回音、確認詞、記憶指令、打字、確認卡的回答），`delegate_task` 綁到那一句（ASR grace 2 秒、30 秒時窗、同世代、用一次、和模型描述的相似度），標題與查詢是原句，經 `voice_heard` 走受保護交辦；API key 依 `response.created` 的觸發項目綁定；受保護原句卡（SSE 只有 ID、IPC 取標題與點擊）；短肯定自動用前一句（George 選 C）。雲端測試：新增 34 個（含獨立審查的回歸），全套 1576 passed、4 skipped。Mac gate 第 1–12 步未執行 |
| [家庭記憶 MEM-4c](memory-mem4c-2026-10-30.md) | 2026-10-30：受保護成果的明文生命週期與 RAM 倒排索引。已結束的受保護任務在核心記憶體只留外殼、要用時才解密（最多 16 筆留在記憶體），OS 鎖定、睡眠、閒置 10 分鐘、關閉記憶與結束 App 時丟棄解密內容、索引與快取；排隊與執行中的任務保留內容；App 內成果紀錄的索引和逐筆掃描逐筆相同，撤回與刪除同步移除（記憶提交期間 hold），範圍在解密前套用，金鑰不可用照實回報。畫面在丟棄時也清掉自己的快取（獨立審查 M1）。雲端測試：新增 31 個（含獨立審查的回歸），全套 1607 passed、4 skipped；500／2000 筆合成任務的冷暖量測（暖查詢 2000 筆 2.4–9.7 ms，舊做法 31–48 ms；冷查詢 0.55–0.63 秒）。丟棄不是安全抹除。Mac gate 第 1–12 步未執行 |
| [家庭記憶 MEM-5b](memory-mem5b-2026-10-30.md) | 2026-10-30：工作決定（`work_summary`）連到任務與連鎖撤銷，預設關閉（`NOUS_MEMORY_ROUTES` 的 `work_summary`＋任務加密保存）。打字「記住這次選了方案 B」先出選擇卡（最近 24 小時成功、沒有撤回、在範圍內的受保護任務最多 5 個，標題只經 IPC），點選才保存使用者原話與 `derivedFrom`；依賴的記憶被忘記或更正而撤回成果時一起忘記（同一次提交做到固定點，兩跳已測），任務已不存在時由對帳忘記；記憶關閉、撤回同意只撤回成果、保留工作決定（獨立審查 M1）；讀不到的任務不清；模型只收到原話（canary 測試）。決定全部待 George 確認；雲端測試通過，Mac gate 第 1–10 步未執行 |
| [家庭記憶 MEM-5a](memory-mem5a-2026-10-30.md) | 2026-10-30：記憶建議（候選提案）、離線指標與最小的家庭協同，預設關閉（`NOUS_MEMORY_ROUTES` 的 `suggest`＋記憶管理的開關）。打字聊天的一般段落用固定規則找第一人稱穩定偏好，只在記憶體，回覆完成後在下方出現一行，按「記住」才保存；全家共用的新事實記下「由誰記下」（不是身分驗證）；快照 version 4 只在用到時寫。和規則一起寫的 202 句 precision 62/62、誤報 0、recall 62/71（不是獨立評估集）；30 句 holdout 9/9；審查者 76 句對抗集修正前 19.6%、修正後 11/11（依它調整，不獨立）；修正 `SENSITIVE` 的 PIN 控制字元。決定全部待 George 確認；雲端測試通過，Mac gate 第 1–8 步未執行 |
| [家庭記憶 MEM-1](memory-mem1-2026-10-29.md) | 2026-10-29：桌面版一般文字聊天的記憶閉環；Linux 上真 AES-GCM、測試鎖（flock）與真 SIGKILL 的服務、HTTP、IPC、畫面替身與 canary 測試，30 組中文查詢召回 24/24；Mac gate（正式簽章 Keychain、真 lockf、效能、臉部候選、OS 鎖定、截圖、真帳號）全部未執行 |
| [家庭記憶 MEM-0](memory-mem0-2026-10-26.md) | 核心私有快照、來源與撤銷的隔離測試；真程序崩潰及 macOS 原生鎖；打包 Electron 44.9.3 真 Keychain 的 1,000 筆虛構記憶跨程序讀回；正式簽章、拒絕、聲音與產品接線待驗 |
| [三項小決定](small-decisions-2026-10-25.md) | 電子腦放大置中（假 Canvas、合成距離與 Chromium 截圖）、關冷氣說定時、預設模式自動（假中控）；Mac 與真冷氣待驗 |
| [家人辨識 ID-02](family-id-02-2026-10-25.md) | 看著說話時同步辨識、互動綁定、核心組句與兩路稱名問候的 fixture（合成特徵、假取樣器、假 WebRTC 與 sideband）：問候前 6 個條件、先開口／打字取消、換人／多人／過期／刪除、fallback 一次、名稱注入、log 無姓名；門檻未校準；實際音訊、時序與同時運作的負擔待 Mac |
| [家人辨識 ID-01](family-id-01-2026-10-25.md) | 登記、刪除、加密保存、畫面內試認的單元與整合測試（假 SecretBox＋真 AES-GCM、IPC 過濾）、產品 worker 對 OpenCV 交叉核對、headless Chromium UI 與 CSP；假鏡頭完整流程因雲端無 GPU 未完成；門檻未校準；Mac、safeStorage、Electron IPC 待測 |
| [家人辨識 ID-00 spike](family-id-00-spike-2026-10-24.md) | YuNet／MediaPipe／SFace 在雲端 headless Chromium 的 CPU／WASM 量測、OpenCV 交叉核對；公有領域肖像，cosine 只是 sanity check；Mac＋AR0144 待測 |
| [本次實作盤點](implementation-review-2026-10-24.md) | 主線程式檢視、790 項測試、型別、建置與隔離 mock HTTP；未做真模型／硬體驗收 |
| [live 語音](live-voice-2026-10-23.md) | fixture 為主；§4 有 Mac log、溫度查詢口頭結果；其他及計費待驗 |
| [看著說話問候](look-to-talk-greet-2026-10-23.md) | fake 計時器與兩路狀態；600 ms 為估計，真鏡頭與語音待驗 |
| [選單設定集中](menu-settings-consolidate-2026-10-23.md) | 型別、測試與語法；Electron 實際選單操作待驗 |
| [選單秒數與指令表](menu-seconds-commands-2026-10-22.md) | 資料、指令與假頁面驗證；原生視窗及選單待驗 |
| [電子腦靠近放大](brain-proximity-zoom-2026-10-23.md) | 假 Canvas／合成距離與截圖；非 AR0144 實測 |
| [距離 UI](brain-distance-2026-10-22.md) | fixture 與建置畫面驗證；真實距離／可讀性待驗 |
| [鏡頭預覽](camera-preview-2026-10-21.md) | 合成雙目影像、真 MediaPipe／Chromium；非實體雙目校正 |
| [六區動畫](brain-regions-2026-10-20.md) | 應用事件與 fixture 視覺驗證；不是模型內部活動 |
| [一般對話](chatgpt-conversation-2026-10-20.md) | 假帳號／語音與瀏覽器流程；不能替代真帳號及音訊驗收 |
| [智慧家庭 H0](smarthome-h0-2026-10-21.md) | 查詢與假中控；後續口頭查溫度結果見 live 語音 §4 |
| [智慧家庭 H1](smarthome-h1-2026-10-22.md) | 控制、冪等與示例中控；家中開關燈口頭結果見 docs/12 狀態 |
| [智慧家庭 H1b](smarthome-h1b-2026-10-22.md) | AIFA／IR fixture 與未設定認證的真中控失敗路徑；真設備待驗 |

「真實中控程式」不必然有真實設備與帳號；「真瀏覽器」也可能在帳號、相機或音訊邊界使用 fixture。判讀時要讀每份紀錄的完整限制。

目前總覽見 [實作狀態](../Current_Implementation_Status.md)，擴充提案見 [功能評估](../13_Feature_Expansion_Assessment_2026-10-24.md)。

2026-10-30 另有 [Mac 實機驗收手冊](mac-acceptance-runbook-2026-10-30.md)：把 HIST-1、MEM-1、ID-02、MEM-2、MEM-3、WK-00 尚未執行的 Mac 步驟整理成一份依序執行的清單。它只是整理，不是驗證結果；每一步以各自的來源紀錄為準。
