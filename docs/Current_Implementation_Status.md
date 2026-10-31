<!-- bilingual: source=zh-TW -->

> [繁體中文](Current_Implementation_Status.md) | [English](Current_Implementation_Status.en.md)

# 目前實作、驗證與缺口

更新日期：2026-10-29，Asia/Taipei（本次只加入喚醒詞與音色辨認的規劃列，核對程式基準 [`876eeaa`](https://github.com/pcpcchen-coder/AIOS/commit/876eeaaf7697cf4a3847e0687430c536f4a1d9a7)）。上次全面核對為 2026-10-24，程式基準：[`1f44c6b`](https://github.com/pcpcchen-coder/AIOS/commit/1f44c6b384d8819e99c5d5a7689069119adf6d53)。本次更新只調整文件，不變更產品能力或宣稱 G0–G3 通過。2026-10-25 另依家人辨識 ID-01 分支（`claude/family-id-01`）更新「已登記家人辨識」一列，同日再依 ID-02 分支（`claude/family-id-02`，尚未合併）更新同一列；這不是 G0–G3 的實機驗收。2026-10-29 加入喚醒詞與音色辨認一列，只標規劃、未實作；同日依 WK-00 分支（`claude/wk-00`，基於 PR #44）補上不接產品的喚醒詞 spike 與 ADR-0003 草案。同日 MEM-1（原分支 `claude/mem-1`，基於 `2af1aa7`）經 PR #45 合併到 main（[`a769af5`](https://github.com/pcpcchen-coder/AIOS/commit/a769af5d13602be215b6ef48a5089f2a38c5fb25)），據此更新「長期記憶」一列：程式與雲端測試完成，Mac gate 未執行。2026-10-30 依 MEM-2 分支（`claude/mem-2`，基於 main `9c8e80b`，尚未提交與合併）再更新同一列：ChatGPT 方案即時語音的記憶程式與雲端測試完成，Mac gate 未執行。同日依 MEM-3 分支（`claude/mem-3`，基於 `claude/mem-2` `658b97a`，尚未提交與合併）再更新同一列：OpenAI API key 即時語音的記憶程式與雲端測試完成、預設關閉，Mac gate 未執行。**更正（2026-10-30）**：MEM-2 與 MEM-3 之後已分別經 PR #47（[`6e73a18`](https://github.com/pcpcchen-coder/AIOS/commit/6e73a1811ed578e17df182af14b83e44927bd8ab)）與 PR #48（[`b54c3af`](https://github.com/pcpcchen-coder/AIOS/commit/b54c3af8caf89a9196fd70de32bd86739b6acc47)）合併到 main，上述「尚未合併」已過時，「長期記憶」一列已改正；兩者的 Mac gate 仍未執行。同日依 HIST-1 分支（`claude/mem-4`，基於 main `b54c3af`，尚未提交與合併）更新「JSON 任務與成果保存」一列：一般任務與成果的成果紀錄（App 內按需 Surface＋獨立網頁 `/history`）程式與雲端測試完成，Mac 驗證未執行。同日依 MEM-4a 分支（`claude/mem-4a`，基於 main `368235a`，尚未提交與合併）更新「JSON 任務與成果保存」與「長期記憶」兩列：macOS App 加密全部任務並一次性搬遷明文、背景任務自動帶記憶（預設關閉）與撤銷傳播的程式與雲端測試完成，Mac gate 未執行。同日依 MEM-4b 分支（`claude/mem-4b`，基於 main `a5c7df3`，尚未提交與合併）再更新「長期記憶」一列：語音交辦自動帶記憶的程式與雲端測試完成、跟著既有旗標預設關閉，Mac gate 未執行。同日依 MEM-5b 分支（`claude/mem-5b`，基於 main `d0ff7bb`，尚未提交與合併）再更新同一列：工作決定連到任務與連鎖撤銷的程式與雲端測試完成、預設關閉，Mac gate 未執行。

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

| 能力 | 有程式 | 自動化／fixture | 實機與未完成界線 |
|---|---|---|---|
| 六區電子腦、按需成果、收起不取消 | 有 | 已測 | 動畫對應應用事件，不是模型內部神經活動 |
| Claude／ChatGPT／mock 任務 | 有 | 請求、串流與錯誤路徑已測 | 完整真模型成功與工具工作仍需逐場景證據 |
| JSON 任務與成果保存 | 有；HIST-1（分支 `claude/mem-4`，尚未合併）加入成果紀錄：`GET /api/history` 在記憶體內搜尋一般任務與成果（簡繁對照、中文二字片段、英文詞；不寫索引、不記查詢文字），篩選、20 筆分頁、片段標示；App 內按需 Surface（說「搜尋成果 香菜」、進度卡「搜尋全部成果」、選單列「成果紀錄…」）與獨立網頁 `/history`；經原生確認的刪除與沿用重試的重做 | 保存、重啟中斷、重試已測；HIST-1 的搜尋、排序、分頁、篩選、刪除（含拒絕執行中任務）、與其他 /api 相同的本機保護、呈現政策、意圖、轉義與 500 筆效能已測（[HIST-1 證據](validation/history-hist1-2026-10-30.md)） | 重啟未完任務標 failed；retry 建新任務整單重跑；成果目前固定 version 1。成果紀錄只涵蓋明文的一般任務；加密、受保護成果搜尋與記憶帶入任務在 MEM-4a、MEM-4c；Mac 截圖與選單驗證未執行。MEM-4a（分支 `claude/mem-4a`，尚未合併）：macOS App 的任務與成果改為加密保存（`data/sealed/` 一筆一檔、AES-256-GCM、safeStorage 包裝；`tasks.json` 只留外殼、沒有 `artifacts.json`），舊明文在 App 內搬遷一次、備份保留到使用者確認刪除；SSE、`/api/tasks`、`/api/history` 只看到外殼，`/api/artifacts` 404，真實內容只經可信主視窗的 IPC（App 內成果紀錄經 IPC 搜尋）；瀏覽器版照舊明文。雲端測試見 [MEM-4a 證據](validation/memory-mem4a-2026-10-30.md)，Mac gate 未執行。MEM-4c（分支 `claude/mem-4c`，尚未合併）：已結束的受保護任務不再一直解密留在核心記憶體（鎖定、睡眠、閒置 10 分鐘、關閉記憶、結束 App 時丟棄），App 內成果紀錄改用只在記憶體的倒排索引；見 [MEM-4c 證據](validation/memory-mem4c-2026-10-30.md)，Mac gate 未執行 |
| 瀏覽器語音、WebRTC 雙路徑 | 有 | 各種假語音／端點／sideband 已測 | Codex live 有部分 Mac log 與查溫度口頭結果；完整流程及計費未驗收 |
| 在場、頭向、名目距離、張掌、手臂三區 | 有 | 合成點／假鏡頭／合成影像已測 | 非眼動；名目雙目幾何，尚無真校正與準確率紀錄 |
| 智慧家庭 H0、H1 | 有 | 假中控與示例程式路徑已測 | 開關燈有口頭回報；不能外推所有設備已驗 |
| 智慧家庭 H1b：AIFA／IR | 有 | fixture、失敗及時間預算已測 | 真冷氣／IR 尚待實測；結果只報送出／未知，不宣稱設備已變化 |
| MCP | API key 即時語音可配置 | 確認相關邏輯已測 | ChatGPT live 路徑無 MCP；不是完整本地 MCP host |
| 通用 Action Gate | 部分確認機制 | 局部已測 | HomeBridge H1 預設 allow；H2 設備政策尚未接入，不是所有操作都出確認卡 |
| Quest、多裝置、OpenClaw worker | 無 | 無 | 擴充評估，不是已實作能力 |
| 已登記家人辨識與稱名問候 | ID-01：登記、刪除、加密保存、本機辨識（macOS App 選單列打開的「家人辨識」畫面內試認）。ID-02：看著說話的面向等待期間同步辨識（只在停留與連線期間取樣，不做背景常駐辨識），語音就緒＋600 ms 後由核心決定稱不稱名，從固定清單隨機挑一句短的開場（例如「George，我在」「嗨，George」「早安」，依本機時段、避開上一次），API key 與 ChatGPT 方案兩條路徑都用核心挑的句子；交辦給 Codex 的逐字稿遮掉開場那一則；設定「打招呼時稱呼認出的家人」預設開、可關；偵測器定案 YuNet 2023mar 640 | 證據規則、名稱驗證、加密保存（假 SecretBox＋真 AES-GCM）、核心 session／登記／刪除／比對、IPC 過濾、隱私靜態檢查；產品 worker 對 OpenCV 交叉核對；ID-02 的 fixture：問候決策的 6 個條件、兩路送出的文字、先開口／打字取消、換人／多人／過期／刪除、fallback 一次、名稱注入、log 無姓名（合成特徵、假取樣器、假 WebRTC 與 sideband） | [14 規劃](14_Family_Recognition_and_Greeting_Plan_2026-10.md)；[ADR-0001 草案](adr/ADR-0001-local-family-recognition.md)；[ID-00 spike](validation/family-id-00-spike-2026-10-24.md)、[ID-01 驗證](validation/family-id-01-2026-10-25.md)、[ID-02 驗證](validation/family-id-02-2026-10-25.md)。George 口頭回報 ID-01 在 Mac 上登記、試認與手掌停止正常（repo 內沒有數字）；**ID-02 未在 Mac 實測**（兩路實際聽到的句子、模型是否照念、時序與同時運作的負擔）；**門檻未校準**（George 決定先稱名，照實標示）；API key 路徑組好的短句會短暫經過 renderer；瀏覽器版不辨識、只說「我在」 |
| 長期記憶、知識圖譜、技能晉升 | MEM-0 核心私有加密快照、回條、來源 capability 與隔離撤銷；MEM-1（PR #45，已合併到 main）在 macOS App 的一般文字聊天加入人物 profile、首次同意設定（預設關閉）、明示記住／更正／忘記、記憶卡與記憶管理、回條、Claude／ChatGPT 同一處注入；瀏覽器版明示不可用。MEM-2（PR #47，已合併到 main）在 ChatGPT 方案即時語音加入：新通話只帶釘選的記憶（獨立同意鍵 codex）、`recall_memory`、用說的確認記住／更正／忘記（George 2026-10-30 決定，殘餘風險是電視或旁人說出確認詞時可能誤存）、撤銷時停播回報與強制靜音、重建新通話、帶記憶時交辦改出原句卡。MEM-3（PR #48，已合併到 main）在 OpenAI API key 即時語音加入同一套記憶規則，**預設關閉**（`NOUS_MEMORY_ROUTES` 列出 `api_key` 才打開）：核心用 call ID 開 API key 旁路作為唯一控制面，只認旁路的語音辨識逐字稿，記憶經旁路 `session.update` 帶入，旁路接不上就不帶記憶；獨立同意鍵 `openai_realtime`；撤銷時停播回報加核心 hangup。知識圖譜與技能晉升沒有 | MEM-0 證據之外，MEM-1 在 Linux 以真 AES-GCM、測試鎖（flock）與真 SIGKILL 跑 M01–M18 可測部分，30 組中文查詢召回 24/24、錯人 0；MEM-2 在 Linux 以假 sideband、真 HTTP／SSE 與 FakePeer 驗證記憶包、同意、語音確認正反例、撤銷表、晚到結果與 canary；MEM-3 以假的 GA 伺服器（真 HTTP 與 WebSocket）驗證記憶沒開時請求完全不變、lease → session.update → ack → answer 的順序、旁路失敗、兩道停止、跨路徑一致性、fallback 與 canary；三者 Mac gate 全部未執行 | [16 家庭記憶設計](16_Nous_Memory_Layer_Design_2026-10-26.md)、[ADR-0002](adr/ADR-0002-nous-family-memory.md)、[MEM-0 證據](validation/memory-mem0-2026-10-26.md)、[MEM-1 證據](validation/memory-mem1-2026-10-29.md)、[MEM-2 證據](validation/memory-mem2-2026-10-30.md)、[MEM-3 證據](validation/memory-mem3-2026-10-30.md)。MEM-1：正式簽章 Keychain／拒絕、真 lockf 雙核心、效能、臉部候選、OS 鎖定、UI 截圖與真帳號 M02 待驗。MEM-2：主要放行條件是用錄音證明撤銷後沒有晚到的舊聲音（Mac 第 0–11 步）；commentary 是否被模型採用、`session.close` 後是否仍有 RTP 待真機確認。MEM-3：旁路能不能用 call ID 接上、收得到哪些事件（Mac 線路探測 P1–P5，P1 或 P2 不成立就不放行）與撤銷後的錄音（Mac 第 0–15 步）待驗；第 8 節的決定都是預設、等 George 確認。背景任務不注入記憶：MEM-4 依 George 2026-10-30 決定分成 HIST-1（一般任務的成果紀錄，見上方 JSON 一列）、MEM-4a（任務與成果加密、撤銷、背景任務自動帶記憶）與 MEM-4c（受保護成果搜尋）。MEM-4a（分支 `claude/mem-4a`，尚未合併）程式與雲端測試完成、Mac gate 未執行：背景任務帶記憶**預設關閉**（`NOUS_MEMORY_ROUTES` 列出 `task`），打開時一般文字聊天的交辦改走受保護交辦（使用者原句、8 筆／4 KB、claude／chatgpt 同意、先寫依賴索引），撤銷傳播讓執行中的任務停止、已完成的成果刪除加密檔；見 [MEM-4a 證據](validation/memory-mem4a-2026-10-30.md)。MEM-4b（分支 `claude/mem-4b`，尚未合併）程式與雲端測試完成、Mac gate 未執行：同一個旗標打開時（API key 另外要 `api_key`），即時語音的交辦也改走受保護交辦——標題與檢索查詢是核心自己記下的語音辨識原句（不是模型的改寫），模型只拿到固定句；綁不到可信原句時帶記憶的通話出受保護原句卡（SSE 只有卡片 ID，標題與點擊經 IPC），沒帶記憶的照常交辦；最後一句只是「好」這類肯定詞時自動用緊接的前一句（模型問過之後；George 選 C，猜錯風險照實記錄），否定或猶豫不交辦；同日依獨立審查修正（3 個 major、8 個 minor）；見 [MEM-4b 證據](validation/memory-mem4b-2026-10-30.md)。MEM-4c（分支 `claude/mem-4c`，尚未合併）程式與雲端測試完成、Mac gate 未執行：已結束的受保護任務在核心記憶體只留外殼、要用時才解密（最多 16 筆留在記憶體），OS 鎖定、睡眠、閒置 10 分鐘、關閉記憶與結束 App 時丟棄；App 內成果紀錄改用只在記憶體的倒排索引（和逐筆掃描逐筆相同、撤回與刪除同步移除、範圍在解密前套用、金鑰不可用照實回報）；頁面收到通知後也清掉自己的快取（獨立審查 M1）；丟棄不是安全抹除；見 [MEM-4c 證據](validation/memory-mem4c-2026-10-30.md)。MEM-5a（分支 `claude/mem-5a`，尚未合併）程式與雲端測試完成、Mac gate 未執行：記憶建議**預設關閉**（`NOUS_MEMORY_ROUTES` 列出 `suggest`，而且在記憶管理開啟），打字聊天的一般段落用固定規則找第一人稱穩定偏好，只在記憶體，回覆完成後在下方出現一行「要記住『…』嗎？［記住］［不用］」，按「記住」才保存（`source.kind` `suggestion`）；全家共用的新事實記下「由誰記下」（不是身分驗證）；快照 version 4 只在用到時寫，舊版 App 讀到會停用記憶、不覆寫；和規則一起寫的 202 句 precision 62/62、誤報與人物錯置 0、recall 62/71（不是獨立評估集），規則定稿前寫好的 30 句 holdout 9/9；獨立審查的 76 句對抗集修正前 precision 19.6%，修正後 11/11（依它調整，不再獨立），同時修正 MEM-1 起 `SENSITIVE` 的 PIN 規則（字面控制字元，PIN 會被存下）；所有決定待 George 確認；見 [MEM-5a 證據](validation/memory-mem5a-2026-10-30.md)。MEM-5b（分支 `claude/mem-5b`，尚未提交與合併）程式與雲端測試完成、Mac gate 未執行：工作決定**預設關閉**（`NOUS_MEMORY_ROUTES` 列出 `work_summary`，而且任務確實加密保存），打字「記住這次選了方案 B」先出選擇卡（最近 24 小時成功、沒有撤回、在範圍內的受保護任務最多 5 個，標題只經 IPC），點選才保存使用者原話並連到那個任務（`derivedFrom`）；它用到的記憶被忘記、更正或過期而撤回成果時一起忘記（同一次提交做到固定點），任務已不存在時由對帳忘記；記憶關閉、撤回同意只撤回成果、保留工作決定（獨立審查 M1）；讀不到的任務不清；沒有可選的工作照舊記成一般筆記並照實告知；記憶管理可以只看工作決定；所有決定待 George 確認；見 [MEM-5b 證據](validation/memory-mem5b-2026-10-30.md) |
| 本機喚醒詞、常駐聆聽、家人音色辨認 | **WK-01a 底層（2026-10-31，分支 `claude/wk-01`，未合併；旗標 `NOUS_WAKE` 預設關閉）**：`src/audio/` 的 `AudioFrontEnd`、擷取 worker、偏好與自動恢復、自我觸發防護、提示音、選單列「喚醒詞」段（「通話中辨認說話者」為停用列）。**沒有喚醒引擎**：偵測器照實回報 `runtime_missing`、不開麥克風、不會偵測；沒有音色辨認。旗標關閉時與之前相同。以下為 WK-01a 之前的說明：目前收音只在按鈕、看著說話或連續語音模式明確啟動時發生，Web Speech 與兩條即時語音都把音訊交給雲端；`src/voice.ts` 註明不做背景喚醒。WK-00 只加了不接產品的 spike：`spike/wake/`（Node CLI、瀏覽器頁、雲端離線評估）、`scripts/wake-setup.mjs`、devDependency `sherpa-onnx-node`／`sherpa-onnx` 2.0.1 | WK-00 雲端數字：[驗證](validation/wk-00-spike-2026-10-29.md)（CPU、記憶體、即時率、公開語料誤報；合成正例 0/300 命中、原因未定，0 誤報與 0 命中同時出現，不能解讀成誤報低；瀏覽器 wasm 未自建；Mac 未測）；`tests/wake-spike.test.ts`、`tests/wake-privacy.test.ts`；WK-01a：[驗證](validation/wk-01a-2026-10-31.md)（fixture 與假時鐘的雲端測試；Mac gate 未執行） | [17 喚醒詞與音色辨認規劃](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md)（2026-10-29）：喚醒詞候選、sherpa-onnx 引擎建議與訓練資料授權風險、講者模型比較、臉聲融合、便利性限制不是授權、記憶人物規則；WK-00 已交付雲端 spike 與 [ADR-0003 草案](adr/ADR-0003-local-wake-and-voice-recognition.md)，其 Mac 實測待 George；WK-01a 已實作（Mac 未驗），WK-01b～WK-03、SP-00～SP-03 未開始 |

一般對話歷史存在目前頁面記憶體，重新載入會清除。已保存任務與成果不因此消失。兩者的生命週期不能混用。

2026-10-26 另核對 main `ca7a8fe`：一般對話保留最多九組問答，live 新通話不恢復前次逐字稿；家人辨識只供稱名，沒有偏好欄位。Nous 直連 Codex 後端不等於使用 Codex App／CLI 的記憶庫。設計交付後已另開 MEM-0 實作批次，只有隔離基礎與探針，未新增產品記憶能力。

## 目前執行流程與邊界

背景任務是 HTTP 提交 → TaskRunner → ProviderManager／executor → Artifact → SSE。Claude executor 做規劃、逐步內容生成與彙整，可配置搜尋，尚未提供任意本機檔案或 shell 工具。

即時語音工具仍有 renderer 參與分派與呼叫。live session 綁定擁有者的 SSE 連線，頁面斷線會結束通話。因此「工作跨裝置接續」需要服務端工作狀態、去重、配對與事件恢復，不能只複製頁面。

核心只綁 `127.0.0.1`，Host／Origin 只允許本機。Quest 的 localhost 是 Quest 自己；對外連線需要另外設計有認證的 HTTPS 裝置入口，不直接放寬既有防護。

Presentation Policy 目前只允許可核對的 `user_request` 與 `action_confirmation`。訂閱提醒、自動背景浮現、永久空間任務牆尚未支援。注視只選定，不能視為當次操作授權。

OpenClaw 是部分語音協議、常數與實作做法的參考來源，沒有 Gateway 或 agent run adapter。新 worker 應和模型 provider 分開建模。

## 中英文文件與介面（2026-10-26）

App 與網頁已加入繁體中文／English 切換與保存，包含原生選單、設定、狀態、無障礙文字及新對話／任務語言。原有 58 份專案文件已完整提供雙語；後續 Agent 須依雙語規範同步更新。此批次 69 個測試檔、1,086 項通過、1 項原有跳過，另完成隔離 mock 核心的 5 項網頁及 3 項 Electron 語言流程；既有 9 項瀏覽器回歸通過。真模型與實體英語音訊尚待驗收，沒有發布或替換正式 App。見[語言指南](development/localization.md)及[本次證據](validation/bilingual-2026-10-26.md)。

## 最新可核對的驗證

2026-10-24 於 Node.js 22.23.3 執行既有 `scripts/verify-aios.mjs`：48 個測試檔、790 項測試通過，型別檢查、Vite build、隔離 mock 任務／成果保存及直接對話 HTTP 流程通過。pstack 固定版本檢查也通過。[本次驗證紀錄](validation/implementation-review-2026-10-24.md)。

這次沒有執行真實模型推論、操作家電、啟動 Quest，或量測實體相機、麥克風與喇叭。程式測試不提升硬體完成度。

既有 [live 語音紀錄 §4](validation/live-voice-2026-10-23.md#4-真實結果george-家中測試) 記載 Mac 登入、通話、sideband 正常；模型清單修正後的溫度查詢只有使用者口頭成功回報，沒有截圖或秒數。原型的 Continue with ChatGPT／Sign in with ChatGPT 是另一條登入，不能拿 Codex live 結果替它驗收。

## 下一步與文件效力

本次 [功能擴充評估](13_Feature_Expansion_Assessment_2026-10-24.md) 建議先做共用能力政策、可回復任務、裝置配對，再完成 Quest 空間成果與 OpenClaw 受限 worker。F0–F10 是功能建議，Q0–Q4 是建議驗收階段；本次只交付其中的文件盤點，F0 所提產品 CI 尚未新增。

新增的 [家人辨識與稱名問候規劃](14_Family_Recognition_and_Greeting_Plan_2026-10.md) 將近距離辨識與既有看著說話的等待同步進行；認出熟人仍保持安靜，啟動互動且語音就緒後才稱名。辨識不延長等待，失敗用通用問候。ID-00 已交付 ADR 草案與不接進產品的 runtime spike（雲端 CPU／WASM 量測）；ID-01 已有登記、刪除、加密保存與畫面內試認的程式，George 在 Mac 上試過；ID-02 已有看著說話時同步辨識與兩路稱名問候的程式，只有雲端 fixture 驗證、門檻未校準；ID-03（真機與保留樣本驗收、門檻校準）仍是規劃。這些都不構成能力完成或身分授權。

2026-10-29 新增的 [本機喚醒詞與家人音色辨認規劃](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md) 只是規劃，未實作：沒有喚醒、常駐收音或聲紋程式，沒有錄音，也沒有家人聲音資料。它建議以 sherpa-onnx 本機偵測喚醒詞、未喚醒音訊只留在記憶體的 2 秒環形緩衝，聲音與臉綁同一個 `person_id`，臉聲一致才稱名，並把身分只當成記憶人物候選。喚醒後先播本機提示音、沒有人聲就自動結束，因為誤喚醒會開一次付費通話。George 已於 2026-10-29 決定 9 項（喚醒詞「哈囉努斯」等）；與原建議不同的是：偏好開著時 App 重開與睡眠回來後自動恢復常駐聆聽（收音指示仍以裝置事件為準並有恢復提示），以及門檻校準完成後可只憑聲音稱名問候（校準前只說不含名字的句子）。另開 ADR-0003 屬工程流程，直接採用。以上都仍是規劃、未實作。同日的 WK-00 spike 只在雲端容器量測 sherpa-onnx KWS（見[驗證](validation/wk-00-spike-2026-10-29.md)），並發現 1.13.8 的原生套件靜態連結 GPL-3.0 的 espeak-ng，所以只採 2.0.1；家人正例、電視負例與 Mac CPU 都還沒量。

正式產品規則仍由 [CLAUDE.md](../CLAUDE.md)、[06](06_Ambient_Voice_Gaze_Experience.md)、[07](07_Ambient_Implementation_and_Acceptance.md) 及有明確日期的專題決定規範。不要因本文件或測試全綠將 G0–G3 改為通過。01–05 與 08 保留歷史設計、當時選型和排程；其舊版本、價格與外部生態資料未在本次全面重新查證。

文件更新時維持四種狀態：有程式、自動化／fixture、實機證據、未實作提案。沒有證據就保留待驗，並連到對應來源。
