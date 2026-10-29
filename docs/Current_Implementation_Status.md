<!-- bilingual: source=zh-TW -->

> [繁體中文](Current_Implementation_Status.md) | [English](Current_Implementation_Status.en.md)

# 目前實作、驗證與缺口

更新日期：2026-10-29，Asia/Taipei（本次只加入喚醒詞與音色辨認的規劃列，核對程式基準 [`876eeaa`](https://github.com/pcpcchen-coder/AIOS/commit/876eeaaf7697cf4a3847e0687430c536f4a1d9a7)）。上次全面核對為 2026-10-24，程式基準：[`1f44c6b`](https://github.com/pcpcchen-coder/AIOS/commit/1f44c6b384d8819e99c5d5a7689069119adf6d53)。本次更新只調整文件，不變更產品能力或宣稱 G0–G3 通過。2026-10-25 另依家人辨識 ID-01 分支（`claude/family-id-01`）更新「已登記家人辨識」一列，同日再依 ID-02 分支（`claude/family-id-02`，尚未合併）更新同一列；這不是 G0–G3 的實機驗收。2026-10-29 加入喚醒詞與音色辨認一列，只標規劃、未實作。

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
| JSON 任務與成果保存 | 有 | 保存、重啟中斷、重試已測 | 重啟未完任務標 failed；retry 建新任務整單重跑；成果目前固定 version 1 |
| 瀏覽器語音、WebRTC 雙路徑 | 有 | 各種假語音／端點／sideband 已測 | Codex live 有部分 Mac log 與查溫度口頭結果；完整流程及計費未驗收 |
| 在場、頭向、名目距離、張掌、手臂三區 | 有 | 合成點／假鏡頭／合成影像已測 | 非眼動；名目雙目幾何，尚無真校正與準確率紀錄 |
| 智慧家庭 H0、H1 | 有 | 假中控與示例程式路徑已測 | 開關燈有口頭回報；不能外推所有設備已驗 |
| 智慧家庭 H1b：AIFA／IR | 有 | fixture、失敗及時間預算已測 | 真冷氣／IR 尚待實測；結果只報送出／未知，不宣稱設備已變化 |
| MCP | API key 即時語音可配置 | 確認相關邏輯已測 | ChatGPT live 路徑無 MCP；不是完整本地 MCP host |
| 通用 Action Gate | 部分確認機制 | 局部已測 | HomeBridge H1 預設 allow；H2 設備政策尚未接入，不是所有操作都出確認卡 |
| Quest、多裝置、OpenClaw worker | 無 | 無 | 擴充評估，不是已實作能力 |
| 已登記家人辨識與稱名問候 | ID-01：登記、刪除、加密保存、本機辨識（macOS App 選單列打開的「家人辨識」畫面內試認）。ID-02：看著說話的面向等待期間同步辨識（只在停留與連線期間取樣，不做背景常駐辨識），語音就緒＋600 ms 後由核心決定稱不稱名，從固定清單隨機挑一句短的開場（例如「George，我在」「嗨，George」「早安」，依本機時段、避開上一次），API key 與 ChatGPT 方案兩條路徑都用核心挑的句子；交辦給 Codex 的逐字稿遮掉開場那一則；設定「打招呼時稱呼認出的家人」預設開、可關；偵測器定案 YuNet 2023mar 640 | 證據規則、名稱驗證、加密保存（假 SecretBox＋真 AES-GCM）、核心 session／登記／刪除／比對、IPC 過濾、隱私靜態檢查；產品 worker 對 OpenCV 交叉核對；ID-02 的 fixture：問候決策的 6 個條件、兩路送出的文字、先開口／打字取消、換人／多人／過期／刪除、fallback 一次、名稱注入、log 無姓名（合成特徵、假取樣器、假 WebRTC 與 sideband） | [14 規劃](14_Family_Recognition_and_Greeting_Plan_2026-10.md)；[ADR-0001 草案](adr/ADR-0001-local-family-recognition.md)；[ID-00 spike](validation/family-id-00-spike-2026-10-24.md)、[ID-01 驗證](validation/family-id-01-2026-10-25.md)、[ID-02 驗證](validation/family-id-02-2026-10-25.md)。George 口頭回報 ID-01 在 Mac 上登記、試認與手掌停止正常（repo 內沒有數字）；**ID-02 未在 Mac 實測**（兩路實際聽到的句子、模型是否照念、時序與同時運作的負擔）；**門檻未校準**（George 決定先稱名，照實標示）；API key 路徑組好的短句會短暫經過 renderer；瀏覽器版不辨識、只說「我在」 |
| 長期記憶、知識圖譜、技能晉升 | MEM-0 已有核心私有加密快照、回條、來源 capability 與隔離撤銷模組；產品個人／家人偏好記憶未啟用 | 真 AES-GCM、原生跨 process 鎖、SIGKILL 復原、來源及整通 lease fixture；打包 Electron 44.9.3 真 Keychain 的 1,000 筆虛構記憶跨程序讀回通過 | [16 家庭記憶設計](16_Nous_Memory_Layer_Design_2026-10-26.md)、[ADR-0002](adr/ADR-0002-nous-family-memory.md)、[MEM-0 證據](validation/memory-mem0-2026-10-26.md)。正式簽章／拒絕、實體停播、性能與 MEM-1／MEM-2 產品閉環待驗；沒有向兩路語音或背景任務注入記憶 |
| 本機喚醒詞、常駐聆聽、家人音色辨認 | **無**（規劃、未實作）。目前收音只在按鈕、看著說話或連續語音模式明確啟動時發生，Web Speech 與兩條即時語音都把音訊交給雲端；`src/voice.ts` 註明不做背景喚醒 | 無 | [17 喚醒詞與音色辨認規劃](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md)（2026-10-29）：喚醒詞候選、sherpa-onnx 引擎建議與訓練資料授權風險、講者模型比較、臉聲融合、便利性限制不是授權、記憶人物規則；WK-00～WK-03、SP-00～SP-03 均未開始 |

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

2026-10-29 新增的 [本機喚醒詞與家人音色辨認規劃](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md) 只是規劃，未實作：沒有喚醒、常駐收音或聲紋程式，沒有錄音，也沒有家人聲音資料。它建議以 sherpa-onnx 本機偵測喚醒詞、未喚醒音訊只留在記憶體的 2 秒環形緩衝，聲音與臉綁同一個 `person_id`，臉聲一致才稱名，並把身分只當成記憶人物候選。喚醒後先播本機提示音、沒有人聲就自動結束，因為誤喚醒會開一次付費通話。喚醒詞、模型授權風險等 9 項待 George 決定（各附建議預設）；另開 ADR-0003 屬工程流程，直接採用。

正式產品規則仍由 [CLAUDE.md](../CLAUDE.md)、[06](06_Ambient_Voice_Gaze_Experience.md)、[07](07_Ambient_Implementation_and_Acceptance.md) 及有明確日期的專題決定規範。不要因本文件或測試全綠將 G0–G3 改為通過。01–05 與 08 保留歷史設計、當時選型和排程；其舊版本、價格與外部生態資料未在本次全面重新查證。

文件更新時維持四種狀態：有程式、自動化／fixture、實機證據、未實作提案。沒有證據就保留待驗，並連到對應來源。
