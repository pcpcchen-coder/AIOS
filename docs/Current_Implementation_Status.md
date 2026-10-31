<!-- bilingual: source=zh-TW -->

> [繁體中文](Current_Implementation_Status.md) | [English](Current_Implementation_Status.en.md)

# 目前實作、驗證與缺口

更新日期：2026-11-01，Asia/Taipei。喚醒詞那一列與「下一步」核對 main [`595f052`](https://github.com/pcpcchen-coder/AIOS/commit/595f052)（PR #72 合併後）；其他各列沿用 2026-10-31 對 main [`9778b41`](https://github.com/pcpcchen-coder/AIOS/commit/9778b4100cb18fec458ba653ff7ad9f9247f7277)（PR #62 合併後）的核對。本次只更新文件，不變更產品能力，也不宣稱 G0–G3 通過。本頁只記今日現況；各批次的歷次更新與更正可用 `git log -- docs/Current_Implementation_Status.md` 查到，每批的證據與限制見[驗證紀錄索引](validation/README.md)。

AIOS 已有可執行的 Nous 桌面原型。先使用或延伸 [`prototype/ambient-shell`](../prototype/ambient-shell)，再依具體需求採用目標架構。Claude 是核心開發主力，ChatGPT／Codex 負責 Quest 工程方向；執行時的模型由設定與能力決定，不按裝置綁定供應商。

## 實際目錄與技術棧

| 路徑 | 已有責任 |
|---|---|
| [`prototype/ambient-shell/src/`](../prototype/ambient-shell/src/) | 無框架 TypeScript／Vite 前端、Canvas 電子腦、Shell、成果與語音 |
| [`server/`](../prototype/ambient-shell/server/) | Node HTTP＋SSE、模型路由、任務排程、JSON 保存、帳號與家電橋接 |
| [`shared/`](../prototype/ambient-shell/shared/) | `proto-0.1` 型別、進度、設定、感測與語音契約 |
| [`src/sense/`](../prototype/ambient-shell/src/sense/) | 左右影像、MediaPipe、幾何、濾波與感測事件 |
| [`desktop/`](../prototype/ambient-shell/desktop/) | Electron macOS 殼、選單列、打包及簽章流程 |
| [`tests/`](../prototype/ambient-shell/tests/) | 單元與整合測試，包含 fixture；不等同硬體驗收 |
| [`docs/validation/`](./validation/) | 各批次證據及限制，見 [索引](validation/README.md) |

目前沒有 `apps/kernel` Python 核心、Tauri／React 正式殼、Claude Agent SDK 封裝、版本化跨語言 JSON Schema 套件或 Quest 建置專案。Anthropic Messages SDK 是現有依賴；它不等於完整 Agent SDK 工具執行環境。

## 能力與證據層級

下表的「有程式」都指已合併到 main 的程式。「Mac」指 George 家中 Mac mini 的實機紀錄；沒有 Mac 紀錄的項目一律寫未執行。

| 能力 | 有程式 | 自動化／fixture | 實機與未完成界線 |
|---|---|---|---|
| 六區電子腦、按需成果、收起不取消 | 有。#57 加入：即時語音「連線中」外圈琥珀色虛線、接通後腦區亮起與薄荷綠外圈；成果、進度、設定畫面開著時字級固定，不跟著距離跳動 | 已測 | 動畫對應應用事件，不是模型內部神經活動。#57 的畫面改動是在 ID-02 Mac 驗收中發現並修正，修正後沒有獨立的 Mac 紀錄 |
| Claude／ChatGPT／mock 任務 | 有 | 請求、串流與錯誤路徑已測 | 完整真模型成功與工具工作仍需逐場景證據。HIST-1 Mac 發現 N1：在 App 裡用本機 API 切成 mock 引擎後，App 會自動切回 ChatGPT，未修 |
| 任務與成果保存（加密）、成果紀錄 | 有。macOS App 的任務與成果一律加密保存（MEM-4a，#52：`data/sealed/` 一筆一檔、AES-256-GCM、safeStorage 包裝；`tasks.json` 只留外殼；舊明文搬遷一次，備份留到使用者確認刪除）。SSE 與 `/api/*` 只給外殼，真實內容只經可信主視窗的 IPC；瀏覽器版仍是明文。MEM-4c（#54）：已結束的受保護任務要用時才解密，OS 鎖定、睡眠、閒置 10 分鐘、關閉記憶、結束 App 時丟棄。成果紀錄 HIST-1（#50）：App 內按需 Surface（說或打「搜尋成果 …」、進度卡「搜尋全部成果」、選單列「成果紀錄…」）與網頁 `/history`；簡繁折疊搜尋，#61 起另有一張小近義詞表；篩選、分頁、經原生確認的刪除、沿用重試的重做；App 內搜尋用只在 RAM 的倒排索引 | 保存、重啟中斷、重試；HIST-1、MEM-4a、MEM-4c 的 Linux 雲端測試（[HIST-1](validation/history-hist1-2026-10-30.md)、[MEM-4a](validation/memory-mem4a-2026-10-30.md)、[MEM-4c](validation/memory-mem4c-2026-10-30.md)）；#61 的修正（近義詞、執行中受保護任務的顯示、中文刪除按鈕）只有 Linux 自動測試 | **HIST-1 Mac**（[紀錄](validation/history-hist1-mac-2026-10-31.md)，2026-10-31，App `9c67e65`、ad-hoc 簽章）：主要放行條件成立（選單、Surface、`/history`、原生刪除對話框、收起不取消）。第 3b 步「晚餐」找不到「晚饭」不通過；F3 執行中受保護任務顯示占位文字、F4 刪除按鈕是英文；這三項已在 #61 修正，**待 Mac 重驗**。未修：F1（「看著說話」開著時，ChatGPT 方案即時語音把「進度如何」「看結果」等本機指令接走）、N1（見上一列）；畫面「共 14 筆」與 `/api/tasks` 15 筆不一致，尚未查明。同一輪在 Mac 上看到 `tasks.json`＋`sealed/`＋明文備份與受保護搜尋的 log，但這不是 MEM-4a／MEM-4c 的 Mac gate，兩者的 gate 都未執行。其他限制：重啟時未完成的任務標 failed；retry 建新任務整單重跑；成果固定 version 1；丟棄不是安全抹除 |
| 瀏覽器語音、WebRTC 雙路徑 | 有。#60：兩條即時語音路徑的指示加上自稱 Nous、不回應旁人之間的對話、逐字稿是簡體也用繁體回答。#62：連線中與問候送出前用本機麥克風音量判斷使用者已開口（`NOUS_EARLY_SPEECH_RMS`，未校準，不保存聲音）；手掌停止改成「停止回覆」，API key 路徑晚到的工具結果只交回、不念；ChatGPT 方案預設只靜音（見下方待決定） | 各種假語音／端點／sideband 已測；#60、#62 有請求快照與 fixture 測試 | Codex live 有部分 Mac log 與查溫度口頭結果；ID-02 Mac 一輪兩條路徑都有實際通話與時序紀錄（見家人辨識一列）。#60、#62 的模型行為（是否照念、是否不回應旁人）待 Mac 驗證。完整流程及計費未驗收 |
| 在場、頭向、名目距離、張掌、手臂三區 | 有。#57：張掌門檻降到 0.55、手腕可略低於肩、「連線中」舉手直接結束語音；面向中斷 0.8 秒內不重置辨識追蹤。#58：「校正人臉辨識」（選單列或家人辨識畫面，最多三個位置），建議的近距離範圍、面向容許、轉頭寬限、最小臉部與側臉容許存在 `face-tuning.json`，不改比對門檻與證據規則 | 合成點／假鏡頭／合成影像已測 | 非眼動；名目雙目幾何，沒有雙目校正與準確率紀錄（「校正人臉辨識」不是雙目校正）。ID-02 Mac 第 9 步：修正後回答中舉手 5 次全停，ChatGPT 方案另有口頭回報，都未達 10＋10 次 |
| 智慧家庭 H0、H1 | 有 | 假中控與示例程式路徑已測 | 開關燈有口頭回報；不能外推所有設備已驗 |
| 智慧家庭 H1b：AIFA／IR | 有 | fixture、失敗及時間預算已測 | 真冷氣／IR 尚待實測；結果只報送出／未知，不宣稱設備已變化 |
| MCP | API key 即時語音可配置 | 確認相關邏輯已測 | ChatGPT live 路徑無 MCP；不是完整本地 MCP host |
| 通用 Action Gate | 部分確認機制 | 局部已測 | HomeBridge H1 預設 allow；H2 設備政策尚未接入，不是所有操作都出確認卡 |
| Quest、多裝置、OpenClaw worker | 無 | 無 | 擴充評估，不是已實作能力 |
| 已登記家人辨識與稱名問候 | 有。ID-01：登記、刪除、加密保存、家人辨識畫面內試認。ID-02：看著說話的面向等待期間同步辨識（不做背景常駐辨識），語音就緒＋600 ms 後由核心決定稱不稱名、從固定清單挑短句，兩條語音路徑都用核心的句子；「打招呼時稱呼認出的家人」預設開、可關；偵測器 YuNet 2023mar 640。之後合併的 Mac 修正：#57 轉頭寬限、#58 人臉校正、#62 API key 路徑嚴格版招呼（F1）、連線中先開口取消招呼（F2）、ChatGPT 方案先開口略過招呼（F10） | 證據規則、名稱驗證、加密保存、核心 session／登記／刪除／比對、IPC 過濾、隱私靜態檢查；ID-02 問候決策與兩路 fixture（[ID-01](validation/family-id-01-2026-10-25.md)、[ID-02](validation/family-id-02-2026-10-25.md)）；#57、#58、#62 的 fixture 測試 | ID-01：George 口頭回報 Mac 上正常，repo 內沒有數字。**ID-02 Mac**（[紀錄](validation/family-id-02-mac-2026-10-31.md)，2026-10-31）**部分完成、未放行**：ChatGPT 方案套用校正後稱名 4/4、句子都在清單內；稱名關閉兩路通過；時序已記（API key 51 次、ChatGPT 方案 54 次）。不通過：API key 第 1 步 9 次中改句 2 次（F1）、兩路「先開口」（F2、F10）；手掌停止次數不足。#62 的修正只有 fixture，**待 Mac 重驗**。仍未解：F3 環境雜音被當成說話；F8 剛開 App 的第一次辨識可能叫不出名字，待觀察；F11 語音開著時會收進旁人對話並送到雲端，#60 只加強指示，沒有靜音或提早結束。需要第二個人的第 2、4、5 步，以及要先徵得同意的第 7 步（刪除 George）未做。門檻未校準；瀏覽器版不辨識，只說「我在」。見 [14 規劃](14_Family_Recognition_and_Greeting_Plan_2026-10.md)、[ADR-0001 草案](adr/ADR-0001-local-family-recognition.md) |
| 長期記憶、知識圖譜、技能晉升 | 記憶有，限 macOS App（瀏覽器版明示不可用）；MEM-0～MEM-5b 都已合併（#45、#47、#48、#52–#56）。記憶要使用者首次同意才開（預設關閉）。同意後可用：一般文字聊天的人物、明示記住／更正／忘記、記憶卡與記憶管理（MEM-1）；ChatGPT 方案即時語音只帶釘選記憶、`recall_memory`、用說的確認、撤銷時停播與重建（MEM-2，獨立同意）。以下另需 `NOUS_MEMORY_ROUTES` 列出才開，**預設關閉**：`api_key`（MEM-3，API key 即時語音經核心旁路）、`task`（MEM-4a 背景任務與 MEM-4b 語音交辦自動帶記憶，含撤銷傳播）、`suggest`（MEM-5a 記憶建議，另需在記憶管理開啟）、`work_summary`（MEM-5b 工作決定連到任務與連鎖撤銷）。知識圖譜與技能晉升沒有 | 全部只有 Linux 雲端：真 AES-GCM、flock 測試鎖、真 SIGKILL、假 sideband／假 GA 伺服器、FakePeer、真 HTTP／SSE 與 canary。MEM-1 30 組中文查詢召回 24/24、錯人 0；MEM-5a 和規則一起寫的 202 句 precision 62/62、recall 62/71（不是獨立評估集），30 句 holdout 9/9。證據：[MEM-0](validation/memory-mem0-2026-10-26.md)、[MEM-1](validation/memory-mem1-2026-10-29.md)、[MEM-2](validation/memory-mem2-2026-10-30.md)、[MEM-3](validation/memory-mem3-2026-10-30.md)、[MEM-4a](validation/memory-mem4a-2026-10-30.md)、[MEM-4b](validation/memory-mem4b-2026-10-30.md)、[MEM-4c](validation/memory-mem4c-2026-10-30.md)、[MEM-5a](validation/memory-mem5a-2026-10-30.md)、[MEM-5b](validation/memory-mem5b-2026-10-30.md) | **MEM-1～MEM-5b 的 Mac gate 全部未執行**，不能宣稱 Mac 通過。MEM-0 另有打包 Electron 真 Keychain 的 1,000 筆讀回；正式簽章與拒絕未驗。主要的 Mac 放行條件：MEM-2 以錄音證明撤銷後沒有晚到的舊聲音；MEM-3 的旁路線路探測 P1–P5（P1 或 P2 不成立就不放行）；其他見各證據的 Mac gate 一節與 [Mac 實機驗收手冊](validation/mac-acceptance-runbook-2026-10-30.md)。多項設計預設待 George 確認（見下方待決定）。設計見 [16](16_Nous_Memory_Layer_Design_2026-10-26.md)、[ADR-0002](adr/ADR-0002-nous-family-memory.md) |
| 本機喚醒詞、常駐聆聽、家人音色辨認 | **喚醒詞「Hello Nous」可用（旗標 `NOUS_WAKE` 預設關閉）**：WK-01a 底層（`src/audio/` 的 `AudioFrontEnd` 麥克風租用與歸還、AudioWorklet→worker 擷取與 2 秒記憶體環形緩衝、偏好與自動恢復、自我觸發防護、合成提示音、選單列「喚醒詞」段）、WK-01b 引擎（GitHub Actions 建置的 sherpa-onnx v2.0.1 KWS wasm，`npm run wake:setup -- --product` 安裝並核對雜湊，App 執行時不下載）、WK-02 觸發後的通話（`wake_word` 開始即時語音、喚醒後一律問候、每分鐘 3 次限速並自動恢復、沉默 5 秒結束、F6 費用紀錄）。關鍵詞依 WK-00 Mac 試跑改為英文 Hello Nous（zh-en-3M，Nous 收 nose／nows／noose，提升分數 1.5、門檻 0.15；中文「哈囉努斯」模型認不出）。#72 另修正擷取 AudioWorklet 只送出第一塊聲音、喚醒永遠不觸發的 bug。沒有音色辨認。旗標關閉時與之前逐位元組相同，唯一刻意的例外是 F6 費用紀錄（George 2026-10-31「一律記錄，不綁喚醒開關」）。WK-00 另有不接產品的 spike（`spike/wake/`） | WK-00 雲端數字：[驗證](validation/wk-00-spike-2026-10-29.md)（TTS 合成正例 0/300）；WK-01a：[驗證](validation/wk-01a-2026-10-31.md)；WK-01b 準備：[驗證](validation/wk-01b-prep-2026-10-31.md)（release `wake-runtime-2.0.1-5961b4196003`）；WK-02：[驗證](validation/wk-02-2026-10-31.md)（fixture）；擷取 worklet 以真的 `structuredClone` 轉移測試（`tests/wake-capture-worklet.test.ts`） | **WK-00 Mac 試跑**（[紀錄](validation/wk-00-mac-2026-10-31.md)，2026-10-31，只有 George）：哈囉努斯 0/20、離線 116 組最多 1/10；Hello Nous 離線 9/10、命令列即時 7/10、只說 Hello 0/6；**App 內 4/4 喚醒**（ChatGPT 方案路徑，`voice-cost.jsonl` 的 `source: wake_word`）。未做：其他家人（W5）、8 小時電視負例（W6）、與鏡頭同時的 CPU、API key 路徑與限速的 Mac 驗證（W12 其餘）。WK-03、SP-00～SP-03 未開始。規劃見 [17](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md)、[ADR-0003 草案](adr/ADR-0003-local-wake-and-voice-recognition.md) |

一般對話歷史存在目前頁面記憶體，重新載入會清除。已保存任務與成果不因此消失。兩者的生命週期不能混用。

2026-10-26 核對 main `ca7a8fe` 時：一般對話保留最多九組問答，live 新通話不恢復前次逐字稿；家人辨識只供稱名，沒有偏好欄位；記憶只有 MEM-0 的隔離基礎。之後加入的記憶能力見上表「長期記憶」一列。Nous 直連 Codex 後端不等於使用 Codex App／CLI 的記憶庫。

## 待決定

以下是已合併程式採用的預設或開關，都**待 George 確認**；確認前照現狀運作，不視為定案。

- MEM-5a 設計決定 D1–D24：[MEM-5a 證據 §3](validation/memory-mem5a-2026-10-30.md)。
- MEM-5b 設計決定 W1–W19：[MEM-5b 證據 §3](validation/memory-mem5b-2026-10-30.md)。
- MEM-4c 的常數（閒置 10 分鐘、warm 16 筆、模型標題前 8 筆／快取 16 筆）、解鎖後是否預先建索引、啟動時是否改成真正延遲載入：[MEM-4c 證據 §6](validation/memory-mem4c-2026-10-30.md)。
- MEM-3 規劃第 8 節採用的預設：[MEM-3 證據 §3](validation/memory-mem3-2026-10-30.md)。
- `NOUS_PALM_QUIET_DELEGATION`（預設關閉）：打開時，ChatGPT 方案路徑手掌停止那一輪的交辦結果改用 commentary 送回、不念；這種結束交辦的方式沒有在上游驗證過，Mac 第 5 步通過前不要打開或改預設。見 [ID-02 Mac 紀錄](validation/family-id-02-mac-2026-10-31.md)的 F7 一節。

## 目前執行流程與邊界

背景任務是 HTTP 提交 → TaskRunner → ProviderManager／executor → Artifact → SSE。Claude executor 做規劃、逐步內容生成與彙整，可配置搜尋，尚未提供任意本機檔案或 shell 工具。

即時語音工具仍有 renderer 參與分派與呼叫。live session 綁定擁有者的 SSE 連線，頁面斷線會結束通話。因此「工作跨裝置接續」需要服務端工作狀態、去重、配對與事件恢復，不能只複製頁面。

核心只綁 `127.0.0.1`，Host／Origin 只允許本機。Quest 的 localhost 是 Quest 自己；對外連線需要另外設計有認證的 HTTPS 裝置入口，不直接放寬既有防護。

鏡頭開關（2026-10-31，分支 `claude/camera-enable-main-only`，尚未合併）：macOS App 以嚴格模式啟動核心，`POST /api/settings/camera` 收到 `active: true` 回 403，鏡頭只由主程序在原生說明之後打開，鏡頭設定關著時主程序也不把鏡頭影像權限給頁面的 `getUserMedia`；終端機／瀏覽器版依使用者決定照舊可以從頁面打開，頁面腳本仍可打開鏡頭、只靠瀏覽器權限提示把關。只有 Linux 自動測試，Mac 手動核對未執行，見[驗證](validation/camera-enable-main-only-2026-10-31.md)。

Presentation Policy 目前只允許可核對的 `user_request` 與 `action_confirmation`。訂閱提醒、自動背景浮現、永久空間任務牆尚未支援。注視只選定，不能視為當次操作授權。

OpenClaw 是部分語音協議、常數與實作做法的參考來源，沒有 Gateway 或 agent run adapter。新 worker 應和模型 provider 分開建模。

## 中英文文件與介面（2026-10-26）

App 與網頁已加入繁體中文／English 切換與保存，包含原生選單、設定、狀態、無障礙文字及新對話／任務語言。原有 58 份專案文件已完整提供雙語；後續 Agent 須依雙語規範同步更新。此批次 69 個測試檔、1,086 項通過、1 項原有跳過，另完成隔離 mock 核心的 5 項網頁及 3 項 Electron 語言流程；既有 9 項瀏覽器回歸通過。真模型與實體英語音訊尚待驗收，沒有發布或替換正式 App。見[語言指南](development/localization.md)及[本次證據](validation/bilingual-2026-10-26.md)。

## 最新可核對的驗證

2026-10-31 於 main `9778b41`（Linux 雲端容器、Node.js 22.22.0）執行 `scripts/verify-aios.mjs`：型別檢查、96 個測試檔 1,822 項通過與 4 項跳過、Vite build、隔離 mock 任務／成果保存及直接對話 HTTP 流程都通過。這是 mock 與 fixture 的程式檢查，不是實機驗收。PR #43 起，GitHub Actions 的 [`aios-product-ci.yml`](../.github/workflows/aios-product-ci.yml) 在每個 PR 與 main 上執行同一支 mock 驗證與 pstack 檢查。

2026-10-31 的兩份 Mac 紀錄見上表：[HIST-1 Mac](validation/history-hist1-mac-2026-10-31.md)（主要放行條件成立，修正待重驗）與 [ID-02 Mac](validation/family-id-02-mac-2026-10-31.md)（部分完成、未放行）。其餘批次沒有 Mac 紀錄。

2026-10-24 的全面盤點（48 個測試檔、790 項）見[當時的驗證紀錄](validation/implementation-review-2026-10-24.md)。

既有 [live 語音紀錄 §4](validation/live-voice-2026-10-23.md#4-真實結果george-家中測試) 記載 Mac 登入、通話、sideband 正常；模型清單修正後的溫度查詢只有使用者口頭成功回報，沒有截圖或秒數。原型的 Continue with ChatGPT／Sign in with ChatGPT 是另一條登入，不能拿 Codex live 結果替它驗收。

## 下一步與文件效力

**目前批次：WK-01**（George 2026-10-31 選定，分成 a／b）。WK-01a（本機喚醒的基礎：麥克風租用、狀態、偏好與自動恢復、緩衝、提示音、防自我觸發，旗標 `NOUS_WAKE` 預設關閉）已實作，見 [WK-01a 驗證](validation/wk-01a-2026-10-31.md)；WK-01b 接上 sherpa-onnx wasm（由 GitHub Actions 建置）與關鍵詞：2026-10-31 George 在 Mac 試跑後，關鍵詞定為英文 Hello Nous（[WK-00 Mac 試跑](validation/wk-00-mac-2026-10-31.md)，#72），App 內喚醒 4/4。WK-02（接上兩條語音路徑）已實作，ChatGPT 方案路徑已在 Mac 上由喚醒開始通話。下一步是 WK-03（Mac 實測 W1–W12），最優先的是其他家人的念法（W5）與 8 小時電視誤觸發（W6）。

**待 Mac 重驗與待補的實機步驟**：HIST-1 第 3b 步與 F3、F4 的修正；ID-02 的 F1、F2、F7、F10 修正，以及需要第二個人的第 2、4、5 步與第 7 步；MEM-1～MEM-5b 的 Mac gate；未修的 HIST-1 F1、N1、14／15 筆差異與 ID-02 F3、F8、F11。順序見 [Mac 實機驗收手冊](validation/mac-acceptance-runbook-2026-10-30.md)。

[功能擴充評估](13_Feature_Expansion_Assessment_2026-10-24.md) 建議先做共用能力政策、可回復任務、裝置配對，再完成 Quest 空間成果與 OpenClaw 受限 worker。F0–F10 是功能建議，Q0–Q4 是建議驗收階段。F0 的產品 CI 已有 mock 版本（上一節），其餘仍是提案。

[家人辨識與稱名問候規劃](14_Family_Recognition_and_Greeting_Plan_2026-10.md)：ID-00、ID-01、ID-02 已有程式，ID-02 的 Mac 驗收部分完成、未放行（見上表）；ID-03（真機與保留樣本驗收、門檻校準）仍是規劃。這些都不構成能力完成或身分授權。

[本機喚醒詞與家人音色辨認規劃](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md)（2026-10-29）：建議以 sherpa-onnx 本機偵測喚醒詞、未喚醒音訊只留在記憶體的 2 秒環形緩衝，聲音與臉綁同一個 `person_id`，臉聲一致才稱名，身分只當成記憶人物候選。喚醒後先播本機提示音、沒有人聲就自動結束，因為誤喚醒會開一次付費通話。George 已於 2026-10-29 決定 9 項（喚醒詞「哈囉努斯」等；2026-10-31 WK-00 Mac 試跑後改為英文 Hello Nous）；與原建議不同的是：偏好開著時 App 重開與睡眠回來後自動恢復常駐聆聽（收音指示仍以裝置事件為準並有恢復提示），以及門檻校準完成後可只憑聲音稱名問候（校準前只說不含名字的句子）。WK-00 發現 sherpa-onnx 1.13.8 的原生套件靜態連結 GPL-3.0 的 espeak-ng，所以只採 2.0.1。產品內已有喚醒與常駐收音（旗標關閉時不啟用，見上表），沒有聲紋程式。

正式產品規則仍由 [CLAUDE.md](../CLAUDE.md)、[06](06_Ambient_Voice_Gaze_Experience.md)、[07](07_Ambient_Implementation_and_Acceptance.md) 及有明確日期的專題決定規範。不要因本文件或測試全綠將 G0–G3 改為通過。01–05 與 08 保留歷史設計、當時選型和排程；其舊版本、價格與外部生態資料未在本次全面重新查證。

文件更新時維持四種狀態：有程式、自動化／fixture、實機證據、未實作提案。沒有證據就保留待驗，並連到對應來源。
