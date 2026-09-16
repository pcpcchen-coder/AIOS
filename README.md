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

## 使用體驗（2026-09-16 更新）

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

## 專案狀態

🟡 **設計階段（Pre-Alpha）** — Repo 目前是設計文件；2026-09-16 已補充互動規格，尚無可執行 Shell、語音或視線實作。

**已完成**：
- ✅ 完整 12 個月技術藍圖（7 大模組架構）
- ✅ OSS 元件對應表（利用社群力量壓縮 41 週開發時間）
- ✅ 3 個月加速路徑（週級行動計畫）
- ✅ 生成式互動系統設計（無固定 UI 的終極形態）
- ✅ 進度彙總與下一階段規劃
- ✅ 電子腦桌面、無 App、語音＋視線互動規格
- ✅ 開發批次、資料契約、Agent prompt 與可手算驗收案例（待實作驗證）

**進行中**：
- 🚧 敘事文件與定位聲明
- 🚧 Week 1 PR 清單
- 🚧 CLAUDE.md 開發者憲法

**未來**：
- ⏳ G0：電子腦 Shell 與按需呈現政策
- ⏳ G1：真實語音 → Agent → 成果閉環
- ⏳ G2：webcam 校正與看＋說操作
- ⏳ G3：硬體、故障、效能驗收後邀請 Alpha 使用者

原 3 個月路線保留作歷史參考；新增語音與視線工作依上述 gate 重新估工。

---

## 文件導覽

所有設計文件位於 [`docs/`](./docs) 目錄。**先讀 06–07 掌握最新產品方向**，再讀 01–05 的基礎設計與歷史規劃。

| # | 文件 | 內容 | 適合誰讀 |
|---|---|---|---|
| **01** | [完整技術藍圖](./docs/01_Complete_Technical_Blueprint.md) | 7 大模組架構、技術選型、12 個月時程 | 想理解全貌者 |
| **02** | [OSS 元件對應表](./docs/02_OSS_Component_Map.md) | 每個模組對應的社群開源專案 | 想快速實作者 |
| **03** | [3 個月加速路徑](./docs/03_3Month_Accelerated_Roadmap.md) | 週級行動計畫 | 開發者 |
| **04** | [生成式互動系統](./docs/04_Generative_Interaction_System.md) | 無固定 UI 的動態生成設計 | 想理解終極形態者 |
| **05** | [進度彙總與規劃](./docs/05_Progress_and_Next_Steps.md) | 專案快照與最新需求增補 | 想加入專案者 |
| **06** | [電子腦、語音與視線體驗](./docs/06_Ambient_Voice_Gaze_Experience.md) | 最新產品規格、狀態機、呈現政策與架構 | 產品與開發者 |
| **07** | [開發與驗收計畫](./docs/07_Ambient_Implementation_and_Acceptance.md) | 目錄、契約、prompt、批次、驗收案例 | 實作者與驗收者 |

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

## 技術棧（規劃中）

- **Kernel**: Claude Opus / Sonnet 4.6（Anthropic）
- **Memory Layer**: [Letta](https://github.com/letta-ai/letta)（MemGPT 官方後繼）
- **Knowledge Layer**: [LightRAG](https://github.com/HKUDS/LightRAG)（雙層檢索 + 知識圖譜）
- **Agent Framework**: [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)
- **Desktop Shell**: [Tauri 2.x](https://github.com/tauri-apps/tauri) + React
- **UI Components**: [assistant-ui](https://github.com/assistant-ui/assistant-ui) + [shadcn/ui](https://github.com/shadcn-ui/ui)（用於暫態成果／按需對話，不作常駐聊天首頁）
- **Voice / Gaze**: 以 adapter 隔離實作；語音引擎與視線模型須經硬體 PoC，尚未鎖定
- **Observability**: [Langfuse](https://github.com/langfuse/langfuse)
- **Tool Protocol**: [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol)

完整清單見 [OSS 元件對應表](./docs/02_OSS_Component_Map.md)。

---

## 團隊

- **@pcpcchen-coder** — 主要開發者、架構決策
- **Claude Code** — AI Pair Programmer

## 授權

計畫採用 **Apache-2.0**（設計文件目前為 All Rights Reserved，正式開源後轉為 Apache-2.0）。

## 聯絡

專案處於設計階段，暫不接受 PR。歡迎透過 GitHub Issues 討論架構決策。

---

_「作業系統的歷史是『降低人與電腦互動成本』的歷史。從指令列到 GUI 到觸控，每一代都把更多認知負擔從人類轉移到系統。Nous 是這個方向的下一步——連『學習 App』這個認知負擔都由 AI 承擔。」_
