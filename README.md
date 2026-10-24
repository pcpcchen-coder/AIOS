# Nous — Cognitive Operating System with Claude as Kernel

> **平時是高科技感的電子腦動態桌布；說出需求，AI Agents 完成工作，成果才浮現。以語音操作、webcam 視線指向，不需要挑選或開啟 App。**

---

## 這是什麼？

**Nous** 是一個實驗性的認知作業系統（Cognitive OS）設計專案。它借鑑作業系統的核心概念——kernel、memory management、file system、scheduler、shell——但把它們重新映射到 AI 時代：

| 傳統 OS | Nous 認知 OS |
|---|---|
| Kernel（CPU 指令） | Claude API（認知推理） |
| Memory Management | 三層記憶架構（Working / Dynamic / Archival） |
| File System | 語義知識庫 + 知識圖譜 |
| Process / Task | Agent / Workflow |
| Scheduler | Agent Orchestrator |
| Shell | 電子腦待機 + 語音／視線互動 + 按需生成成果 |
| IPC | MCP + A2A 協議 |
| Driver | Tool / MCP Connectors |

**核心命題**：當 AI 成為認知的協處理器，我們需要的不是「更好的 App」，而是一個能讓 AI 管理你的知識、記憶、工作流的**完整基礎設施層**。

---

## 目標使用體驗

以下是產品方向。已實作能力與待驗證事項以後面的現況表及現況文件為準，校正眼動與完整 Agent 工具工作尚未因此實現。

**提出需求 → AI Agents 解決問題 → 呈現成果 → 看向內容並用語音追問 → 收起後回到電子腦。**

- **平時安靜**：只有神經網路／粒子電子腦的動態桌布，沒有 App 圖示、常駐聊天框、側欄或 Dashboard。
- **資訊按需浮現**：只顯示當前需求的成果、必要澄清／確認、使用者訂閱的提醒；細節與進度叫出才顯示。
- **語音優先**：用自然語言提出需求、調整參數、要求重算、保存或收起成果。
- **視線指向**：webcam 經校正估計注視區塊；「看向目標＋說出動作」完成操作。第一階段驗證大區塊，不預設具備滑鼠像素級精度。
- **成果可喚回**：畫面消失不等於成果刪除；技能存於背景能力庫，以需求喚起。
- **可復原**：鏡頭不可用時改用語音編號；保留文字、鍵盤及滑鼠作設定與可及性備援。

首版是現有 OS 上的桌面 Shell，原生桌布嵌入另行驗證。Agents 依可用能力、資料與授權完成需求；能力不足時明確說明，不承諾任意任務皆能成功。

詳見 [06 體驗與架構規格](./docs/06_Ambient_Voice_Gaze_Experience.md) 及 [07 開發任務、prompt 與驗收](./docs/07_Ambient_Implementation_and_Acceptance.md)。

---

## 專案狀態（2026-10-24）

**Pre-Alpha，已有可執行原型。** 實作集中在 [`prototype/ambient-shell`](./prototype/ambient-shell)：Node HTTP＋SSE、TypeScript＋Vite、Electron 桌面殼與本機 JSON 保存。Python kernel、Tauri、Claude Agent SDK 與完整 monorepo 仍是設計選項，不代表現有程式架構。

| 領域 | 現況 | 驗證界線 |
|---|---|---|
| 電子腦與任務 | 六區事件動畫、按需成果、佇列、取消、重試與成果保存 | 原型已實作；不是正式 G0–G3 通過聲明 |
| 模型與語音 | Claude／ChatGPT／模擬；瀏覽器語音與 WebRTC 即時語音雙路徑 | Mac 的 Codex live 登入、通話及溫度查詢有部分實機紀錄；完整流程與計費尚未驗收 |
| 鏡頭與手勢 | 在場、名目距離、頭向、張掌停止播報、手臂三區指向、靠近放大 | 頭向不是眼動；雙目未實測校正，準確率與硬體驗收待做 |
| 家電 | H0 查詢、H1 一般控制、H1b AIFA／紅外線 | 開關燈有口頭實機紀錄；H1b 待實機；H2 設備政策、H3 房間群控、H4 背景 MCP 尚未實作 |
| 保存與安全 | JSON 任務／成果、呈現政策、部分工具確認機制 | 未完任務重啟後失敗；缺 checkpoint、完整成果版本、通用 Action Gate 與長期記憶 |
| Quest／OpenClaw | 已完成本次功能評估 | 沒有 Quest 客戶端或 OpenClaw agent adapter；語音參考 OpenClaw 不等於已整合 agent |

本次基準 `1f44c6b` 的 48 個測試檔、790 項測試、型別檢查、建置與隔離 mock HTTP 流程通過。這些結果不替代真模型、麥克風、Quest、相機與家電驗收。詳見 [現況與證據](./docs/Current_Implementation_Status.md)。

接下來的建議順序是：現況與產品 CI → 共用能力／Action Gate → 可回復任務與成果版本 → 裝置配對 → Quest 空間成果 → OpenClaw 受限 worker 與語音接力。這是尚待實作的擴充路線，不改寫既有 gate 驗收結果。完整 MVP、風險、工時與驗收見 [功能擴充評估](./docs/13_Feature_Expansion_Assessment_2026-10-24.md)。

## 執行原型

需要 Node.js 22.12 以上。

```bash
git clone https://github.com/pcpcchen-coder/AIOS.git
cd AIOS/prototype/ambient-shell
npm ci
npm start
```

開啟 `http://localhost:8787`。核心只接受本機連線，Quest 無法直接連這個 localhost。未設定模型與帳號時可使用明示的模擬模式；模型與語音設定見 [安裝指南](./prototype/ambient-shell/INSTALL.md)。macOS 有 [預覽版下載與自行打包說明](./prototype/ambient-shell/desktop/README.md)，既有 Release 不保證包含 main 最新功能。

開發驗證從 repo 根目錄執行：

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
```

---

## 文件導覽

開發流程使用 [pstack 專案指南](./docs/development/pstack.md)，Agent 規則見 [AGENTS.md](./AGENTS.md)。

文件位於 [`docs/`](./docs)。**先讀現況與證據，再讀 06–07 的產品規則及 10–12 的專題更新**。08 是 2026-10-07 的歷史快照，01–05 的舊排程與選型不是當前實作。完整閱讀路徑見 [文件索引](./docs/README.md)。

| # | 文件 | 內容 | 適合誰讀 |
|---|---|---|---|
| **現況** | [目前實作與驗證](./docs/Current_Implementation_Status.md) | 程式目錄、能力、證據層級、缺口與驗證方式 | 所有人，先讀 |
| **13** | [功能擴充評估](./docs/13_Feature_Expansion_Assessment_2026-10-24.md) | Quest、OpenClaw、語音、感測、多裝置的優先序與 roadmap | 規劃與協作開發 |
| **14** | [家人辨識與稱名問候規劃](./docs/14_Family_Recognition_and_Greeting_Plan_2026-10.md) | 面向等待期間同步辨識，互動開始後才說「George，我在」；辨識尚未實作。ID-00 有 [ADR-0001 草案](./docs/adr/ADR-0001-local-family-recognition.md) 與不接進產品的 [runtime spike 紀錄](./docs/validation/family-id-00-spike-2026-10-24.md) | 核心與感測開發者 |
| **01** | [完整技術藍圖](./docs/01_Complete_Technical_Blueprint.md) | 7 大模組架構、技術選型、12 個月時程 | 想理解全貌者 |
| **02** | [OSS 元件對應表](./docs/02_OSS_Component_Map.md) | 每個模組對應的社群開源專案 | 想快速實作者 |
| **03** | [3 個月加速路徑](./docs/03_3Month_Accelerated_Roadmap.md) | 週級行動計畫 | 開發者 |
| **04** | [生成式互動系統](./docs/04_Generative_Interaction_System.md) | 無固定 UI 的動態生成設計 | 想理解終極形態者 |
| **05** | [進度彙總與規劃](./docs/05_Progress_and_Next_Steps.md) | 專案快照與最新需求增補 | 想加入專案者 |
| **06** | [電子腦、語音與視線體驗](./docs/06_Ambient_Voice_Gaze_Experience.md) | 最新產品規格、狀態機、呈現政策與架構 | 產品與開發者 |
| **07** | [開發與驗收計畫](./docs/07_Ambient_Implementation_and_Acceptance.md) | 目錄、契約、prompt、批次、驗收案例 | 實作者與驗收者 |
| **08** | [2026-10 匯總與更新](./docs/08_Consolidation_and_Update_2026-10.md) | 10 月初決策、生態研究及舊時程快照 | 歷史決策參考 |
| **10–12** | [專題文件](./docs/README.md) | 遠距 UI、雙目互動與智慧家庭的設計及實作對照 | 對應功能開發者 |

---

## 核心設計原則

1. **意圖優於應用（Intent over Application）** — 使用者不選 App，只表達意圖；AI 為當次需求生成工具與呈現
2. **本地優先（Local-First）** — 資料在你的裝置上，你完全擁有
3. **記憶即差異（Memory as Moat）** — 沒有記憶的 AI 是工具，有記憶的 AI 是助手
4. **暫態呈現、成果可留存（Ephemeral UI, Durable Artifacts）** — UI 為當次互動而生；保存成果與持久技能不新增常駐入口
5. **整合優先、避免重造（Integrate First）** — 優先整合既有 OSS 與工具能力
6. **語音表達、視線指向（Voice + Gaze）** — 指向與執行分離，無滑鼠也能走完核心流程
7. **安靜預設、按需呈現（Quiet by Default）** — 使用者要看的資訊才出現，收起即回電子腦

---

## 技術棧

目前執行的是 Node.js HTTP＋SSE、無框架 TypeScript 前端、Vite、Electron、Anthropic Messages SDK、MediaPipe 與本機 JSON。型別標記為 `proto-0.1`。以下是既有設計文件中的目標選型，須經獨立決策與驗證才採用；這次文件更新沒有遷移技術棧。

- **Kernel**: Claude Opus 5.5（規劃）＋ Sonnet 系列（worker），型號經 Models API 取得、不寫死
- **Memory Layer**: 提案改為本地 Markdown 記憶檔 + SQLite FTS5／sqlite-vec 索引；[Mem0](https://github.com/mem0ai/mem0) 備援（原選 Letta 的 V1 server 已退役，見 08）
- **Knowledge Layer**: [LightRAG](https://github.com/HKUDS/LightRAG)（雙層檢索 + 知識圖譜；G1 後接入）
- **Agent Framework**: [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)
- **Desktop Shell**: [Tauri 2.x](https://github.com/tauri-apps/tauri) + React
- **Result Surface**: 提案為 MCP Apps 相容 host（`ui://`、沙盒 iframe、CSP 預設拒絕）；[assistant-ui](https://github.com/assistant-ui/assistant-ui) + [shadcn/ui](https://github.com/shadcn-ui/ui) 只作按需元件
- **Voice**: 候選 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（喚醒、VAD、ASR、TTS）+ [Breeze-ASR-25](https://huggingface.co/MediaTek-Research/Twister)（台灣華語），待 PoC
- **Gaze**: 候選 MediaPipe Face Landmarker + 自建校正，待 PoC
- **Observability**: 本地 OpenTelemetry；[Langfuse](https://github.com/langfuse/langfuse) 為可選匯出
- **Tool Protocol**: [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol) 2026-07-28 規格（含 Apps、Tasks 擴充）

選型演進見 [02 OSS 元件對應表](./docs/02_OSS_Component_Map.md) 與 [08 §5](./docs/08_Consolidation_and_Update_2026-10.md#5-更新後的元件對應只列差異)。

---

## 團隊

- **@pcpcchen-coder** — 主要開發者、架構決策
- **Claude Code** — AI Pair Programmer
- **開發分工方向** — Claude 主力負責 AIOS 核心，ChatGPT／Codex 負責 Quest 端；執行時仍依模型與能力設定選路徑，不按裝置綁定供應商

## 授權

計畫採用 **Apache-2.0**（設計文件目前為 All Rights Reserved，正式開源後轉為 Apache-2.0）。

## 聯絡

專案處於原型開發階段。功能與架構討論使用 GitHub Issues，變更以可檢閱 PR 與對應驗證證據追蹤；本次文件更新不代表所有規劃已承諾實作或已通過驗收。

---

_「作業系統的歷史是『降低人與電腦互動成本』的歷史。從指令列到 GUI 到觸控，每一代都把更多認知負擔從人類轉移到系統。Nous 是這個方向的下一步——連『學習 App』這個認知負擔都由 AI 承擔。」_
