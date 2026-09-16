# Nous 設計文件

最新產品方向：**電子腦動態桌布 → 語音提出需求 → AI Agents 完成工作 → 按需呈現 → 看＋說繼續操作**。

先讀 06–07，再依需要查閱既有核心架構。Repo 目前仍為設計階段，文件中的工作批次與驗收項目尚未完成實作。

| 檔案 | 內容 | 定位 |
|---|---|---|
| [06_Ambient_Voice_Gaze_Experience.md](./06_Ambient_Voice_Gaze_Experience.md) | 電子腦、無 App、語音、視線、按需呈現與狀態架構 | 最新產品規格 |
| [07_Ambient_Implementation_and_Acceptance.md](./07_Ambient_Implementation_and_Acceptance.md) | 目錄、契約、prompt、開發批次、驗收與量測 | 最新執行依據 |
| [01_Complete_Technical_Blueprint.md](./01_Complete_Technical_Blueprint.md) | 核心架構與原 12 個月藍圖 | 基礎設計 |
| [02_OSS_Component_Map.md](./02_OSS_Component_Map.md) | 開源元件對應表 | 選型參考，採用前驗證 |
| [03_3Month_Accelerated_Roadmap.md](./03_3Month_Accelerated_Roadmap.md) | 原週級工作拆解與新 gate 對照 | 歷史排程參考 |
| [04_Generative_Interaction_System.md](./04_Generative_Interaction_System.md) | 意圖、生成式呈現、技能持久化 | 基礎互動設計，已補充新方向 |
| [05_Progress_and_Next_Steps.md](./05_Progress_and_Next_Steps.md) | 原始進度快照與 2026-09-16 增補 | 專案脈絡 |

## 閱讀路徑

- 只有 10 分鐘：06 的產品定義、資訊揭露與使用情境。
- 理解架構：06 → 01 → 04 → 02。
- 開始實作：06 → 07 → 03 中相關底層工作。
- 了解決策演進：05，再對照 06–07。

06–07 對 Shell、輸入、呈現政策及 Alpha 驗收的定義，優先於舊文件的常駐 Dashboard、技能側欄、語音延後與固定發布月份。其他核心架構繼續沿用。
