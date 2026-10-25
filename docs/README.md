# Nous 文件索引

更新日期：2026-10-24。產品方向是「電子腦待機 → 語音提出需求 → 實際工作 → 按需成果 → 指向並追問」。目前已有 Node／TypeScript／Electron 原型，正式 G0–G3 驗收狀態仍需逐項證據。

## 先讀目前狀態，再讀產品規則

| 文件 | 用途與效力 |
|---|---|
| [目前實作與驗證](./Current_Implementation_Status.md) | 現行入口：實際目錄、已實作／待驗收／缺口、測試與實機證據 |
| [13 功能擴充評估](./13_Feature_Expansion_Assessment_2026-10-24.md) | Quest、OpenClaw、即時語音、感測與多裝置的構想；F0–F10、Q0–Q4 均未因此實作 |
| [14 家人辨識與稱名問候](./14_Family_Recognition_and_Greeting_Plan_2026-10.md) | 利用既有面向 delay 同步辨識，互動後才稱名；ID-00 spike、ID-01 登記與試認、ID-02 看著說話時稱名問候已有程式（ID-02 只有雲端 fixture 驗證，門檻未校準） |
| [ADR-0001 本機家人辨識（草案）](./adr/ADR-0001-local-family-recognition.md) | 資料生命週期、金鑰、雲端語音與身分非授權的邊界；模型授權查核；待 George 決定事項 |
| [06 電子腦、語音與視線體驗](./06_Ambient_Voice_Gaze_Experience.md) | 產品規則、呈現政策與行為要求；目標架構須與現況分開 |
| [07 開發與驗收計畫](./07_Ambient_Implementation_and_Acceptance.md) | 正式契約、gate、驗收方法；規劃目錄不是現存程式目錄 |
| [10 遠距 UI](./10_Distance_UI_18inch_2026-10.md) | 18 吋與遠距畫面規格，距離縮放已有原型實作，實機可讀性待驗 |
| [11 雙目鏡頭互動](./11_Stereo_Camera_Interaction_2026-10.md) | 頭向、距離估計、停止手勢、三區指向及設定已實作；非眼動，雙目未校正 |
| [12 智慧家庭](./12_SmartHome_Integration_Plan_2026-10.md) | H0、H1、H1b 有程式；部分家中口頭紀錄；H2–H4 待實作 |

## 歷史藍圖與決策

| 文件 | 閱讀方式 |
|---|---|
| [01 完整技術藍圖](./01_Complete_Technical_Blueprint.md) | 七模組目標架構與原 12 個月方案；不能當成目前能力表 |
| [02 OSS 元件對應](./02_OSS_Component_Map.md) | 整合策略與當時選型；版本、價格、授權採用前另查 |
| [03 三個月路線](./03_3Month_Accelerated_Roadmap.md) | 舊週級排程；不代表目前進度或承諾日期 |
| [04 生成式互動](./04_Generative_Interaction_System.md) | 基礎互動設計；06–07 覆蓋舊常駐 Dashboard／側欄敘述 |
| [05 進度與下一步](./05_Progress_and_Next_Steps.md) | 原始進度快照及需求演進 |
| [08 2026-10 匯總](./08_Consolidation_and_Update_2026-10.md) | 2026-10-07 歷史現況、ADR 提案與舊排程；「當時尚無程式」不是今日現況 |

編號 09「Spoken Brief 交辦單」是既有 Project 外部文件參照，未隨 repo 提供。此索引沒有宣稱 repo 已包含該文件。

## 執行、開發與證據

- [根目錄設定入口](../SETUP.md)、[原型操作說明](../prototype/ambient-shell/README.md)、[安裝指南](../prototype/ambient-shell/INSTALL.md)、[macOS 桌面指南](../prototype/ambient-shell/desktop/README.md)。
- [開發規則](../CLAUDE.md)、[Agent 工作流程](../AGENTS.md)、[pstack 指南](./development/pstack.md)。
- [對話模組設計](./development/chatgpt-conversation-design.md)、[六區動畫](./development/brain-regions.md)，各自說明所涵蓋批次。
- [驗證紀錄索引](./validation/README.md)，區分 fixture、使用者口頭回報、本次程式測試與待實機事項。

目前實作以程式及對應驗證紀錄為準。產品規則以 CLAUDE.md、06–07 及明確日期的專題決定為依據；新功能評估不自動修改既有規則或讓 gate 通過。若新舊文件不一致，先核對其日期、作用範圍與證據，保留歷史內容並更正現況入口。
