# Nous — Cognitive Operating System with Claude as Kernel

> **一個以 Claude 作為認知核心的作業系統。不是給人操作硬體，而是讓 AI 操作知識、記憶、工作流與多 Agent 編排。**

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
| Shell | 自然語言介面 + 生成式 UI |
| IPC | MCP + A2A 協議 |
| Driver | Tool / MCP Connectors |

**核心命題**：當 AI 成為認知的協處理器，我們需要的不是「更好的 App」，而是一個能讓 AI 管理你的知識、記憶、工作流的**完整基礎設施層**。

---

## 專案狀態

🟡 **設計階段（Pre-Alpha）** — 完整技術藍圖已完成，即將進入實作。

**已完成**：
- ✅ 完整 12 個月技術藍圖（7 大模組架構）
- ✅ OSS 元件對應表（利用社群力量壓縮 41 週開發時間）
- ✅ 3 個月加速路徑（週級行動計畫）
- ✅ 生成式互動系統設計（無固定 UI 的終極形態）
- ✅ 進度彙總與下一階段規劃

**進行中**：
- 🚧 敘事文件與定位聲明
- 🚧 Week 1 PR 清單
- 🚧 CLAUDE.md 開發者憲法

**未來**：
- ⏳ Week 1 開工，開始實作 Alpha
- ⏳ Month 3 Private Alpha 釋出（5-10 位早期使用者）

---

## 文件導覽

所有設計文件位於 [`docs/`](./docs) 目錄。建議按以下順序閱讀：

| # | 文件 | 內容 | 適合誰讀 |
|---|---|---|---|
| **01** | [完整技術藍圖](./docs/01_Complete_Technical_Blueprint.md) | 7 大模組架構、技術選型、12 個月時程 | 想理解全貌者 |
| **02** | [OSS 元件對應表](./docs/02_OSS_Component_Map.md) | 每個模組對應的社群開源專案 | 想快速實作者 |
| **03** | [3 個月加速路徑](./docs/03_3Month_Accelerated_Roadmap.md) | 週級行動計畫 | 開發者 |
| **04** | [生成式互動系統](./docs/04_Generative_Interaction_System.md) | 無固定 UI 的動態生成設計 | 想理解終極形態者 |
| **05** | [進度彙總與規劃](./docs/05_Progress_and_Next_Steps.md) | 專案全景快照 + 下一步 | 想加入專案者 |

---

## 核心設計原則

1. **意圖優於應用（Intent over Application）** — 使用者不選 App，只表達意圖；AI 為當次需求生成工具與呈現
2. **本地優先（Local-First）** — 資料在你的裝置上，你完全擁有
3. **記憶即差異（Memory as Moat）** — 沒有記憶的 AI 是工具，有記憶的 AI 是助手
4. **暫態預設、持久為例外（Ephemeral by Default）** — UI 為當次互動而生，被重複使用才晉升為持久技能
5. **整合優先、避免重造（Integrate First）** — 站在 41+ 個成熟 OSS 專案的肩膀上

---

## 技術棧（規劃中）

- **Kernel**: Claude Opus / Sonnet 4.6（Anthropic）
- **Memory Layer**: [Letta](https://github.com/letta-ai/letta)（MemGPT 官方後繼）
- **Knowledge Layer**: [LightRAG](https://github.com/HKUDS/LightRAG)（雙層檢索 + 知識圖譜）
- **Agent Framework**: [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)
- **Desktop Shell**: [Tauri 2.x](https://github.com/tauri-apps/tauri) + React
- **UI Components**: [assistant-ui](https://github.com/assistant-ui/assistant-ui) + [shadcn/ui](https://github.com/shadcn-ui/ui)
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
