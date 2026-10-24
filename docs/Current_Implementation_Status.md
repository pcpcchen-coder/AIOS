# 目前實作、驗證與缺口

更新日期：2026-10-24，Asia/Taipei。程式基準：[`1f44c6b`](https://github.com/pcpcchen-coder/AIOS/commit/1f44c6b384d8819e99c5d5a7689069119adf6d53)。本次更新只調整文件，不變更產品能力或宣稱 G0–G3 通過。

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
| [`docs/validation/`](./validation/) | 各批次證據及限制，見 [索引](./validation/README.md) |

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
| 長期記憶、知識圖譜、技能晉升 | 無完整實作 | 無完整驗收 | 保存任務／成果不等於長期個人記憶 |

一般對話歷史存在目前頁面記憶體，重新載入會清除。已保存任務與成果不因此消失。兩者的生命週期不能混用。

## 目前執行流程與邊界

背景任務是 HTTP 提交 → TaskRunner → ProviderManager／executor → Artifact → SSE。Claude executor 做規劃、逐步內容生成與彙整，可配置搜尋，尚未提供任意本機檔案或 shell 工具。

即時語音工具仍有 renderer 參與分派與呼叫。live session 綁定擁有者的 SSE 連線，頁面斷線會結束通話。因此「工作跨裝置接續」需要服務端工作狀態、去重、配對與事件恢復，不能只複製頁面。

核心只綁 `127.0.0.1`，Host／Origin 只允許本機。Quest 的 localhost 是 Quest 自己；對外連線需要另外設計有認證的 HTTPS 裝置入口，不直接放寬既有防護。

Presentation Policy 目前只允許可核對的 `user_request` 與 `action_confirmation`。訂閱提醒、自動背景浮現、永久空間任務牆尚未支援。注視只選定，不能視為當次操作授權。

OpenClaw 是部分語音協議、常數與實作做法的參考來源，沒有 Gateway 或 agent run adapter。新 worker 應和模型 provider 分開建模。

## 最新可核對的驗證

2026-10-24 於 Node.js 22.23.3 執行既有 `scripts/verify-aios.mjs`：48 個測試檔、790 項測試通過，型別檢查、Vite build、隔離 mock 任務／成果保存及直接對話 HTTP 流程通過。pstack 固定版本檢查也通過。[本次驗證紀錄](./validation/implementation-review-2026-10-24.md)。

這次沒有執行真實模型推論、操作家電、啟動 Quest，或量測實體相機、麥克風與喇叭。程式測試不提升硬體完成度。

既有 [live 語音紀錄 §4](./validation/live-voice-2026-10-23.md#4-真實結果george-家中測試) 記載 Mac 登入、通話、sideband 正常；模型清單修正後的溫度查詢只有使用者口頭成功回報，沒有截圖或秒數。原型的 Continue with ChatGPT／Sign in with ChatGPT 是另一條登入，不能拿 Codex live 結果替它驗收。

## 下一步與文件效力

本次 [功能擴充評估](./13_Feature_Expansion_Assessment_2026-10-24.md) 建議先做共用能力政策、可回復任務、裝置配對，再完成 Quest 空間成果與 OpenClaw 受限 worker。F0–F10 是功能建議，Q0–Q4 是建議驗收階段；本次只交付其中的文件盤點，F0 所提產品 CI 尚未新增。

正式產品規則仍由 [CLAUDE.md](../CLAUDE.md)、[06](./06_Ambient_Voice_Gaze_Experience.md)、[07](./07_Ambient_Implementation_and_Acceptance.md) 及有明確日期的專題決定規範。不要因本文件或測試全綠將 G0–G3 改為通過。01–05 與 08 保留歷史設計、當時選型和排程；其舊版本、價格與外部生態資料未在本次全面重新查證。

文件更新時維持四種狀態：有程式、自動化／fixture、實機證據、未實作提案。沒有證據就保留待驗，並連到對應來源。
