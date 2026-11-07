<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

# 驗證紀錄索引

2026-10-26 新增：[中英文文件與 App／網頁驗證](bilingual-2026-10-26.md)，涵蓋文件同步、介面切換與保存、對話語言及隔離 mock 畫面測試。

更新日期：2026-11-07（加入右上角時鐘與天氣 CLK-1；加入電子腦 WebGL 繪製方案 B）。2026-11-06（加入回憶模式 MEMO-1、MEMO-2）。2026-11-02（加入記憶預設選人：用說的問、沒說不要就用；加入背景處理中的電子腦與處理中音效）。2026-11-01（加入聲音輸入／輸出裝置選擇；加入喚醒詞 WK-00 的 Mac 試跑：改用 Hello Nous、App 內可喚醒）。2026-10-31（加入 HIST-1 與 ID-02 的 Mac 實機紀錄、喚醒引擎 WK-01b 準備批次，以及 WK-02 喚醒接上即時語音）。2026-10-30 加入家庭記憶 MEM-2、MEM-3、MEM-4a、MEM-4b、MEM-4c、MEM-5a、MEM-5b 與成果紀錄 HIST-1；這些批次都已合併到 main，Mac gate 未執行。2026-10-29 加入 WK-00 喚醒詞 spike 與家庭記憶 MEM-1。本目錄保留每次驗證的原始日期、方法與限制。舊紀錄不因新文件更新而升格為實機通過；後續結果以新增紀錄或明確補記呈現。

| 紀錄 | 證據範圍與限制 |
|---|---|
| [右上角時鐘與天氣 CLK-1](pi-clock-weather-2026-11-07.md) | 2026-11-07：Pi 畫面右上角顯示時間、日期、星期、氣溫與天氣（環境狀態角落，不能點，不是 Surface）；時間用核心給的時區，Pi 時鐘差超過 60 秒時改用核心時間；天氣經唯讀的 `GET /api/weather/now`（Open-Meteo，和招呼共用快取），查不到照實說；手繪 SVG 天氣圖示（含夜晚版）；設定「Mac 視窗」預設關、「Pi 終端機」預設開；回憶模式時留在照片上方加深色底；fixture 測試與無頭 Chromium 的 mock 畫面檢查；**Pi 與 Mac 實機、真實天氣未驗證** |
| [回憶模式 MEMO-2：Google 相簿來源](memories-google-2026-11-06.md) | 2026-11-06：經 gog 的 Photos Picker（token 留在 gog 的鑰匙圈）建立挑選連結；Mac 選單列用瀏覽器打開、設定頁（Mac 與 Pi）顯示 QR code；挑選完成後下載到 Mac 快取（2 GB 上限、先刪最早挑的、可清除），每次最多 300 項；Mac 用 sips 把 HEIC 轉成長邊 2048 px 的 JPEG；Google 照片只有時間沒有地點；Pi 只經核心取用；假 gog 與假時鐘的測試，無頭 Chromium 開 Pi 頁面配 mock gog 的實測；**真實 Google 帳號、Mac 與 Pi 未驗證** |
| [回憶模式 MEMO-1](memories-mode-2026-11-06.md) | 2026-11-06：設定可開關（選單列與設定頁，Mac 與 Pi）；電子腦閒置 60 秒後（可設定）照片與影片從電子腦浮現輪播、每張 8 秒、影片預設靜音；喚醒詞、面向鏡頭、交辦、通話、點照片立即收起，工作結束再閒置才恢復；照片下方依 EXIF／影片建立時間與 GPS 顯示「三年前在新竹」（固定城市表、25 公里內、不連網、座標不離開核心）；來源是 Mac 本機資料夾；Google 官方限制查核（Library API 讀不到既有相簿、Picker 不能持續同步、Ambient API 只給合作夥伴）；fixture 測試與無頭 Chromium 的 mock 頁面實測；**Mac 與 Pi 實機未驗證，Google 來源是 MEMO-2** |
| [即時語音費用防護](realtime-cost-guard-2026-11-06.md) | 2026-11-06：閒置只算真的使用者一輪（開口事件、未完成逐字稿、雜音觸發的回覆不再延長）；每通上限預設 20 分鐘（5–60 分鐘、沒有不限），前 1 分鐘提醒，頁面與核心（上限＋30 秒、掛斷）都執行；App 鎖定或睡眠結束、視窗收起不結束；瀏覽器與 Pi 背景超過 30 秒或關頁結束；每 15 秒報到，第一次報到後 45 秒沒報到由核心結束（`client_lost`）；頁面與選單列顯示通話時間與約略 tokens（頁面回報，不是帳單；ChatGPT 方案用量不明）；電視台詞被轉成逐字稿仍算一輪；fixture 的雲端測試，**Mac 與 Pi 實機未驗證** |
| [電子腦 WebGL 繪製（方案 B）](brain-webgl-2026-11-07.md) | 2026-11-07：設定新增「使用 GPU 繪製（WebGL）」開關（和完整／平衡／省電分開，每台裝置預設關閉，立即生效）；狀態與繪製分開，Canvas 版和 main 逐像素相同；WebGL 1 繪製粒子、連線、光暈、光環與光脈衝，區名畫在上層 2D 畫布；沒有硬體 WebGL、只有軟體 WebGL 或 context lost 時自動改回 Canvas，「目前」一行照實說；無頭 Chromium（x86、SwiftShader 軟體 WebGL、強制允許）每格主執行緒 step＋draw 中位數 −31% 到 −39%（完整 0.570→0.350 ms，5 次），含等 GPU 畫完反而慢約 3 倍（軟體 GL）；畫面比對 16×9 亮度格子相關係數 0.997–1.000、區名與光脈衝相同；**Pi 硬體 GPU 上未驗證** |
| [電子腦 Canvas 每格成本優化](brain-canvas-perf-2026-11-06.md) | 2026-11-06：粒子顏色改用 `globalAlpha`、依顏色分組設 `fillStyle`，光脈衝與連線不再每格建字串或陣列；無頭 Chromium（x86、SwiftShader）每格主執行緒 step＋draw 中位數三檔都約 −60%（完整 1.600→0.620 ms，5 次），含點陣化 −7% 到 −15%；與舊版像素比對看得到的差異最多 2/255、0.109% 像素；**相對量測，Pi 上未量** |
| [Pi 部署修正與實機驗證](rpi-deployment-fixes-2026-11-05.md) | 2026-11-05：Pi 本機鏡頭、來源辨識狀態、證據時間窗與問候指示修正；指定 Pi 4 的臉部稱名與 EMEET 純聲紋喚醒稱名通過使用者確認及核心 metadata 核對；不是其他裝置、長時間穩定度或誤辨率驗證 |
| [Pi 家人辨識與記憶選人畫面](pi-family-recognition-2026-11-05.md) | 2026-11-05：Pi 用自己的鏡頭與麥克風算特徵、經終端通道送 Mac 核心比對；只開放辨識與記憶選人操作，登記與管理仍在 Mac。只有 Linux 雲端 fixture，Pi 實機未驗證 |
| [主動提醒 PRO-2：早上問要不要念行程](pro-2-2026-11-05.md) | 2026-11-05：認出 George 時，天氣後接今天的行程：有行程先問「要不要我念今天的行程？」，整句說好（問句念完後、回音不算）才經 CAL-1 讀出（最多 5 個）；沒有行程直接說「今天沒有排行程」；說不要或 20 秒沒回答不念、今天不再問；行程只在記憶體；念行程時點亮規劃區；假 CAL-1 與兩條路徑 fixture 的雲端測試；**Mac 與真實 Google 日曆未驗證** |
| [主動提醒 PRO-1：招呼後說天氣](pro-1-2026-11-05.md) | 2026-11-05：每人每天早上（本機 5–11 點，可設定）第一次打招呼時，核心在招呼句後接一句今天的天氣（Open-Meteo，CC BY 4.0，12 個固定城市、快取 30 分鐘、看著說話或喚醒開始時先查）；沒認出時用「這台裝置今天第一次」；問候真的送出才記、每日紀錄只有日期與鍵；選單列與設定頁「主動提醒」；AIL 唯讀工具 `app.weather.today`；假時鐘與假 Open-Meteo 的雲端測試；**Mac 與真實 Open-Meteo 未驗證** |
| [本機日期修正](local-date-2026-11-05.md) | 2026-11-05：給模型的「今天日期」改用本機時區並附星期幾（兩條即時語音、ChatGPT 方案工具層、文字對話、背景任務）；台北凌晨不再差一天；Google 日曆行程不用確認（George 確認）；固定時刻的雲端測試 |
| [Google 日曆 CAL-1](cal-1-google-calendar-2026-11-05.md) | 2026-11-05：`google_calendar` Adapter：查行程（gog `--readonly`，最多 20 筆、3.5 KB）與新增行程（當地時間換 RFC3339、整天行程、不邀請人、每分鐘 10 個、不出確認卡）；帳號只來自設定；假 gog 與真 spawn 的雲端測試；**Mac 與真實 Google 日曆未驗證** |
| [家電 Facade AIL-2](ail-2-home-facade-2026-11-05.md) | 2026-11-05：`/api/home/*` 經整合層的 `home` Facade 呼叫 HomeBridge（`legacyName`、`page` 路徑、`scalar`）；Facade 開關兩路逐筆比對 HTTP 回應與中控請求，H0／H1／H1b 完全相同；模型工具逐位元組不變；gog 共用模組；**Mac 與真實中控未驗證** |
| [用 gog 寄信給自己 MAIL-1](mail-1-gog-self-2026-11-04.md) | 2026-11-04：`gmail_gog` Adapter 與模型工具 `app.mail.send_to_self`（只有主旨與內文，收件人只來自 `NOUS_MAIL_SELF`）；不經 shell、內文走 stdin；依 George 的決定不出確認卡、每分鐘最多 5 封；非 0 結束回結果不明；假 gog 與真 spawn 的雲端測試；附「更簡單做法」比較；**Mac 與真實 Gmail 未驗證** |
| [這台裝置的畫面效能](pi-performance-2026-11-05.md) | 2026-11-05：設定畫面的完整／平衡／省電，只調電子腦繪製與背景模糊，不碰聲音與語音；Pi 預設平衡、顯示實測每秒格數。只有 Linux 雲端 fixture，Pi 上的改善未量測 |
| [Mac 服務模式](service-mode-2026-11-03.md) | 2026-11-03：服務模式隱藏電子腦、停止 Mac 麥克風、喚醒與鏡頭；選單列依 Pi 頁面心跳顯示已連線／已斷線。只有 Linux 雲端 fixture，Mac 與 Pi 實機未驗證 |
| [記憶預設選人](memory-voice-default-2026-11-02.md) | 2026-11-02：臉或聲音已認出家人時不出卡片；即時語音說一次「我要用 George 的記憶，好嗎？」，問句念完後的下一句、念完 8 秒或送出 12 秒（先到者）就選定，整句否定隨時有效、只用全家共用、這次不再問；打字聊天直接選定並顯示「正在用 X 的記憶｜不是我」；新的 `unselect`（「不是我」）；沒有同意時不念、8 秒選定；覆寫 SP-02b G3 與 17 §9.2 的確認要求；fixture 與假計時器的雲端測試；**Mac 試用未執行** |
| [電子腦「處理中」與處理中音效](brain-processing-cue-2026-11-02.md) | 2026-11-02：只有 `running` 任務（和核心連著時）與通話中進行中的即時語音查詢（最多 30 秒）算處理中；電子腦青色呼吸、狀態列「背景處理中」；聲納聲最大增益 0.05（−26.02 dBFS）、開始 20 秒、新步驟 6 秒（每 15 秒最多一次）、每個任務 60 秒；說話（加 1.5 秒）、收音、通話中、視窗隱藏時不響；「處理中音效」開關（`audio.json`，預設開）；喚醒防護 `cue`；假時鐘與假 AudioContext 的雲端測試；**Mac 步驟（音量、藍牙、自動播放）未執行** |
| [聲音輸入／輸出裝置選擇](audio-devices-2026-11-01.md) | 2026-11-01：選單列與頁面設定的「聲音」段（麥克風、喇叭，`audio.json`）；麥克風找不到時暫用系統預設並說明、回來時換回去；通話中換麥克風下一通起生效、換喇叭立即生效；喇叭中斷改由系統預設播放；`wake.json` 舊的 `device_id` 不搬（常駐聆聽跟著聲音輸入，預設＝系統預設）；系統朗讀與 Web Speech 照舊用系統裝置；fixture 的雲端測試；**Mac 步驟（藍牙喇叭、回音）未執行** |
| [成果紀錄 HIST-1：Mac 實機](history-hist1-mac-2026-10-31.md) | 2026-10-31，Mac mini、App `9c67e65`、ad-hoc 簽章、mock 引擎：主要放行條件成立（選單、Surface、`/history`、原生刪除對話框、收起不取消）；第 3b 步不通過（「晚餐」找不到「晚饭」），另有 F1（即時語音接走本機指令）、F3、F4 與 N1；F2（3b）、F3、F4 已在 PR #61 修正，只有 Linux 自動測試，待 Mac 重驗；F1、N1 與「14 筆／15 筆」差異未處理 |
| [家人辨識 ID-02：Mac 實機](family-id-02-mac-2026-10-31.md) | 2026-10-31，部分完成、未放行：ChatGPT 方案校正後稱名 4/4、稱名關閉兩路通過、兩路時序；API key 改句（F1）、兩路先開口（F2、F10）不通過；手掌停止次數不足；需要第二個人的第 2、4、5 步與第 7 步未做。測試中的修正已合併（PR #57、#58），F11 只加強指示（PR #60），F1、F2、F7、F10 的修正（PR #62）只有 fixture，待 Mac 重驗；F3、F8、F11 未解 |
| [喚醒詞 WK-00：Mac 試跑](wk-00-mac-2026-10-31.md) | 2026-10-31，只有 George：「哈囉努斯」兩個模型都認不出（即時 0/20、離線 116 組最多 1/10），改用英文 Hello Nous（zh-en-3M、提升分數 1.5、門檻 0.15）：離線 9/10、命令列即時 7/10、只說 Hello 0/6；修正擷取 AudioWorklet 只送第一塊的 bug（F6，#72）後 App 內 4/4 喚醒。其他家人、8 小時電視負例未做 |
| [喚醒詞 WK-00 spike](wk-00-spike-2026-10-29.md) | sherpa-onnx 1.13.8／2.0.1 的 Node 與 Node wasm KWS、兩個模型、三個候選詞在雲端容器的 CPU、記憶體、即時率與公開語料每小時誤報；TTS 合成正例 0/300 命中，原因未定（合成語音或「哈囉」的發音單元），0 誤報與 0 命中同時出現，不能解讀成誤報低；瀏覽器 wasm 未自建；Mac 客廳的家人正例與電視負例待測 |
| [喚醒引擎 WK-01b 準備批次](wk-01b-prep-2026-10-31.md) | GitHub Actions 建置 sherpa-onnx v2.0.1 KWS wasm 的 workflow（emsdk 4.0.23、只建 KWS、GPL espeak-ng／piper 檢查、pull_request 不發布）、`wake:setup -- --product`、清單格式、worker 真的載入路徑與 worker 網路關閉（在 import 任何第三方 module 之前就關閉網路全域）；**workflow 尚未執行**，清單仍是 `pending_first_build`，關鍵詞與門檻等 George 的 Mac 數字；fixture（假 wasm 模組）的雲端測試，不證明偵測可用 |
| [鏡頭只能由主程序打開](camera-enable-main-only-2026-10-31.md) | 2026-10-31：App 以嚴格模式啟動核心，`POST /api/settings/camera` 的 `active: true` 回 403，鏡頭只由主程序在原生說明之後打開（選單列、設定畫面、說或打「打開鏡頭」都經同一個說明框），鏡頭關著時主程序不給頁面鏡頭影像權限；終端機／瀏覽器版依使用者決定照舊可以從頁面打開，殘餘風險是頁面腳本仍可打開鏡頭、只靠瀏覽器權限提示把關；Linux 上的 HTTP、靜態與假 Electron 測試；Mac 手動核對未執行 |
| [Voice Command Relay VCR-2：Mac 實播與診斷](vcr-2-2026-11-03.md) | `NOUS_VCR=mac`：`/usr/bin/say`（參數陣列、不經 shell）實際從指定喇叭播出，喇叭以名稱記錄、每次播放前重讀；設定頁「語音中繼（實驗）」按需顯示（新增 Google Home Mini、聲線調整、預覽、測試喚醒／整句、紀錄結果、採用）；模型只播已採用的說法，最多 `unconfirmed`；依 George 決定不做回音抑制與首次確認；假 `say` 執行器、真 HTTP 伺服器與 headless Chromium 的雲端測試；**沒有在 Mac 上執行過** |
| [Voice Command Relay VCR-0＋VCR-1（假輸出）](vcr-0-2026-11-03.md) | 跨品牌命令三層資料（意圖、品牌命令包、設備目標）與每台音箱的 TTS 聲線設定、確定性解析優先序、明確拒絕原因、A/B 辨識率公式；`voice_relay` Adapter（`NOUS_VCR` 預設 off，`fake` 才啟用）只有假輸出（mock），播完最多 `unconfirmed`；Spotify 下游一律 `policy_blocked`；只有 Google Home Mini 候選模板（待實測）；fixture 的雲端測試；**沒有實體播音、沒有辨識率數據** |
| [Spotify Soloist 本機健康 SP-1](sp-1-soloist-health-2026-11-03.md) | `spotify_soloist` Adapter 只讀 Soloist `auth_state` 的兩個布林值（經 SSH `-R` 到 Mac loopback），設定頁「App 整合」按需顯示；沒有模型工具（SP-2 BLOCKED）；本機假 Soloist WebSocket 伺服器的雲端測試；含週末 Pi／Mac 步驟，尚未實測 |
| [App Integration Layer AIL-1](ail-1-2026-11-03.md) | 整合層的 Registry、Dispatcher、政策、按需狀態與模擬 Adapter（`NOUS_AIL` 預設關閉）；兩條即時語音路徑由核心執行；Spotify 工具一律拒絕註冊；沒有真實 App；fixture 與 mock 的雲端測試，沒有 Mac 驗證 |
| [喚醒接上即時語音 WK-02](wk-02-2026-10-31.md) | `wake_word` 開始來源、每個滾動 60 秒 3 次的限速（暫停聆聽、時間到自動恢復）、喚醒後一律問候（稱名照「打招呼時稱呼認出的家人」）、沉默 5 秒自動結束（音量門檻，不是 VAD）、F6 費用紀錄（`voice-cost.jsonl`，記錄所有通話、不綁喚醒開關、費用一律未知）、Companion `activation=wake` 契約、`NSMicrophoneUsageDescription` 改寫；**引擎未接上，產品不會觸發**；fixture 與假時鐘的雲端測試；Mac gate 未執行 |
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
