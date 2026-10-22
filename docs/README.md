# Nous 設計文件

最新產品方向：**電子腦動態桌布 → 語音提出需求 → AI Agents 完成工作 → 按需呈現 → 看＋說繼續操作**。

先讀 08（2026-10 現況與修正），再讀 06–07，最後依需要查閱既有核心架構。Repo 目前仍為設計階段，文件中的工作批次與驗收項目尚未完成實作。

| 檔案 | 內容 | 定位 |
|---|---|---|
| [08_Consolidation_and_Update_2026-10.md](./08_Consolidation_and_Update_2026-10.md) | 完整進度、決策日誌 v2、生態變化、架構修正提案、gate 時程 | 最新現況與規劃基線 |
| [10_Distance_UI_18inch_2026-10.md](./10_Distance_UI_18inch_2026-10.md) | 18 吋遠距（2 m）畫面 × 語音設計：字級、狀態四重編碼、視線限制、9 個狀態畫面 | 設計提案，待實機驗證 |
| [11_Stereo_Camera_Interaction_2026-10.md](./11_Stereo_Camera_Interaction_2026-10.md) | AR0144 雙目鏡頭的遠距互動：在場與距離、面向螢幕、停止手勢、手臂指向；本機處理 | 設計提案，待實測 |
| [12_SmartHome_Integration_Plan_2026-10.md](./12_SmartHome_Integration_Plan_2026-10.md) | 武陵居智慧家電整合（AIOS 端）：HomeBridge、home_status／home_control 語音工具、中控逐台語音控制設定（允許／需確認／關閉）、批次 H0–H4 | 規劃；H0、H1 已在原型實作（待實機驗證），對應 SmartHomeAI `docs/AIOS接入規劃.md` |
| [06_Ambient_Voice_Gaze_Experience.md](./06_Ambient_Voice_Gaze_Experience.md) | 電子腦、無 App、語音、視線、按需呈現與狀態架構 | 最新產品規格 |
| [07_Ambient_Implementation_and_Acceptance.md](./07_Ambient_Implementation_and_Acceptance.md) | 目錄、契約、prompt、開發批次、驗收與量測 | 最新執行依據 |
| [01_Complete_Technical_Blueprint.md](./01_Complete_Technical_Blueprint.md) | 核心架構與原 12 個月藍圖 | 基礎設計 |
| [02_OSS_Component_Map.md](./02_OSS_Component_Map.md) | 開源元件對應表 | 選型參考，採用前驗證 |
| [03_3Month_Accelerated_Roadmap.md](./03_3Month_Accelerated_Roadmap.md) | 原週級工作拆解與新 gate 對照 | 歷史排程參考 |
| [04_Generative_Interaction_System.md](./04_Generative_Interaction_System.md) | 意圖、生成式呈現、技能持久化 | 基礎互動設計，已補充新方向 |
| [05_Progress_and_Next_Steps.md](./05_Progress_and_Next_Steps.md) | 原始進度快照與 2026-09-16 增補 | 專案脈絡 |

## 閱讀路徑

- 只有 10 分鐘：08 §0 一頁摘要，再看 06 的產品定義與使用情境。
- 理解架構：06 → 01 → 04 → 02。
- 開始實作：根目錄 `CLAUDE.md` → 08 §6 → 06 → 07。
- 了解決策演進：05，再對照 06–07。

優先順序：08 的已決項 > 06–07 > 01–05。08 標為「提案」的架構修正（記憶層、MCP Apps Surface、Tasks、觀測）需經 ADR／spike 確認後才改寫原文件。06–07 對 Shell、輸入、呈現政策及 Alpha 驗收的定義，優先於舊文件的常駐 Dashboard、技能側欄、語音延後與固定發布月份。
