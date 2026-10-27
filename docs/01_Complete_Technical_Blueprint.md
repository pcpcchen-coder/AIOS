<!-- bilingual: source=zh-TW -->

> [繁體中文](01_Complete_Technical_Blueprint.md) | [English](01_Complete_Technical_Blueprint.en.md)

# 以 Claude 為核心的認知作業系統：完整技術藍圖與開發時程

> **2026-10-24 閱讀導覽**：目前程式與缺口以 [實作現況](Current_Implementation_Status.md) 為準；新功能的價值、依賴、MVP 與 roadmap 見 [功能擴充評估](13_Feature_Expansion_Assessment_2026-10-24.md)。本文保留早期設計，不代表已實作或已通過驗收。產品紅線與 G0–G3 仍依 [06](06_Ambient_Voice_Gaze_Experience.md)、[07](07_Ambient_Implementation_and_Acceptance.md) 及後續明確修訂執行；新評估中的 F0–F10、Q0–Q4 不取代這些 gate。
>
> 程式基準為 `1f44c6b`（2026-10-23）。可執行原型位於 `prototype/ambient-shell`，採 Node HTTP、SSE、TypeScript、Vite 與 Electron。本文的 Tauri、React、Python kernel、Agent SDK、長期記憶及生成工具等屬目標設計；模型、價格、市場、stars 與外部生態數據是原始撰寫時的資料，本次未重新查證，採用前須另查。

> **2026-09-16 互動規格更新**：電子腦待機、無 App、語音優先、webcam 視線選取及按需呈現，依 [06 體驗規格](06_Ambient_Voice_Gaze_Experience.md) 與 [07 開發驗收](07_Ambient_Implementation_and_Acceptance.md)。本文其餘底層設計保留；舊時程與舊介面描述僅供歷史參考，衝突時以 06–07 為準。

**認知作業系統（Cognitive OS）是一個以 Claude 作為「認知核心」的個人知識與工作管理平台，它不操控硬體，而是讓 AI 操作知識、記憶、工作流與多 Agent 編排。** 這份藍圖基於對 30+ 個開源專案、學術論文與業界框架的深入研究，為兩人團隊設計了一條可在 12 個月內交付可展示產品的技術路徑。核心洞見是：當前市場上沒有任何產品提供完整的「OS 層抽象」——Claude Desktop 是 Shell、Notion 是檔案系統、Dify 是 Process Builder，但沒有人把它們整合成一個作業系統。這是一個 **$14.89B 市場**（2025 年）中尚未被佔據的架構層級。

---

## 產品命名與定位

經過大量搜尋與衝突分析，以下是按推薦度排序的命名建議：

| 名稱 | 來源 | 優勢 | 風險 |
|------|------|------|------|
| **Nous** | 希臘語 νοῦς（心智/理智） | 短、有記憶點、哲學深度，「Nous OS」自然好聽 | NousResearch 存在但定位不同（LLM 研究） |
| **Thymos** | 希臘語 θυμός（意志/驅動力） | 完全無衝突、傳達能動性與意志力、極具品牌潛力 | 較冷門，需要教育市場 |
| **Meld** | 英語（融合、統一） | 短、動詞化、傳達知識融合意象、好發音 | 較通用，但無 AI 產品衝突 |
| **Phren** | 希臘語 φρήν（心智，phronesis 詞根） | 極度獨特、無任何衝突 | 不容易直覺理解 |
| **Anima** | 拉丁語（靈魂/心智） | 美感、人文感、跨文化共鳴 | 遊戲/動畫領域有少量使用 |
| **Kernel** | 直接 OS 隱喻 | 開發者直覺理解、「Claude 就是 Kernel」 | 過於通用 |

**建議選擇 Nous 或 Thymos**。Nous 對開發者/知識工作者最具共鳴——短到可以當 CLI 命令（`nous run`），足夠有深度作為品牌故事。以下報告暫以 **Nous** 作為產品代稱。

---

## 核心架構設計：從傳統 OS 到認知 OS 的映射

### 架構概念映射

這個映射不是隱喻，而是設計藍圖。每一層都有對應的技術實現：

| 傳統 OS 概念 | Nous 認知 OS 對應 | 核心技術 |
|---|---|---|
| **Kernel** | Claude API（認知推理引擎） | Anthropic Claude Opus/Sonnet 4.6，1M context window |
| **Memory Management** | 記憶核心（三層記憶架構） | PostgreSQL + pgvector / SQLite + sqlite-vec |
| **File System** | 知識庫（語義檔案系統） | Markdown 檔案 + 向量索引 + 知識圖譜 |
| **Process / Task** | Agent / Workflow | Claude Agent SDK + 自建排程器 |
| **Scheduler** | Agent Orchestrator | 圖狀態機 + Temporal.io（持久化執行） |
| **Shell** | 自然語言介面 | React + TipTap + tldraw |
| **IPC** | Agent 間通訊協議 | MCP（工具層）+ A2A（Agent 層） |
| **Driver** | Tool / Connector | MCP Servers（10,000+ 生態系） |
| **User Space** | 專業 Agent 應用 | 研究 Agent、寫作 Agent、程式 Agent 等 |

### 學術基礎

這個架構不是憑空設計。三篇關鍵學術論文提供了理論基礎：

**AIOS**（Rutgers 大學，COLM 2025）提出了最嚴謹的「LLM 作為 OS Kernel」定義——LLM 實例被抽象為「LLM cores」（類比 CPU cores），agent 排程類比 process scheduling，context switching 類比 OS 的 process context switching。**CoALA 框架**（TMLR 2024）連結了 LLM Agent 與經典認知架構（ACT-R、Soar），提供了記憶分類學（working、episodic、semantic、procedural）。**MemGPT 論文**（arXiv:2310.08560，COLM 2025）首創「虛擬記憶管理」概念，將 context window 類比為 RAM，外部儲存類比為 disk。

### 競品分析的關鍵洞見

研究了 **30+ 個相關專案**後，關鍵發現如下：

現有框架各據一方但無人整合全棧。**LangGraph** 擁有最佳的圖狀態機與 checkpoint/time-travel 除錯（126K+ GitHub stars），但沒有 OS 層抽象。**Claude Agent SDK** 有最深的 MCP 整合與「Brain/Hands 分離」架構，但沒有持久化記憶層。**Letta/MemGPT** 有正確的 OS 隱喻與三層記憶架構，但只限於記憶管理而非完整 OS。**CrewAI** 有最直覺的角色制 Agent 抽象（~35 行建最小 Agent），但缺乏 checkpoint 與精細控制。**Dify**（111K+ stars）有最好的視覺化工作流 UX，但面向的是「幫你的用戶建 AI App」而非「AI 管理你的工作」。

最具啟發性的設計模式包括：Claude Agent SDK 的 **lifecycle hooks**（18 個事件攔截點）與 **advisor/executor 模型混合**（節省 60-70% token）；LangGraph 的 **reducer-based 並發狀態合併**與 **time-travel debugging**；OpenAI Swarm 的 **Handoff-as-function-return** 極簡委派模式；Rivet 的 **YAML 圖格式**實現版本控制下的 Agent 邏輯。

---

## 模組 A：記憶系統（Memory Kernel）

記憶系統是 Nous 最核心的差異化——**沒有記憶的 AI 只是工具，有記憶的 AI 才是助手**。

### 三層記憶架構

借鑑 MemGPT/Letta 的虛擬記憶模型，但針對 Claude 的 **1M token context window** 重新設計：

**第一層：工作記憶（Working Memory）** 始終存在於 context window 中，類比 CPU cache。包含 agent 角色定義（system prompt）、核心記憶塊（使用者偏好、身份資訊、近期重要決策）、當前任務上下文。大小控制在 **~50K tokens** 以內，確保留出充足空間給動態內容。利用 Claude 的 **prompt caching** 功能，寫入成本只付一次，後續讀取僅 10% input 價格。

**第二層：動態記憶（Dynamic/Retrieved Memory）** 按需從外部儲存檢索注入 context，類比 RAM。包含 RAG 檢索的知識片段、相關對話歷史摘要、任務相關的長期記憶。使用**複合評分**檢索：`Score = α × Recency + β × Importance + γ × Relevance(cosine)`，其中 Recency 使用指數衰減（0.995/小時，存取時重設）、Importance 由 LLM 在建立時評分（1-10）、Relevance 為與當前查詢的餘弦相似度。

**第三層：持久記憶（Archival/Persistent Memory）** 外部資料庫中的長期儲存，類比 disk。分為 **Episodic Memory**（對話歷史——原始對話以會話為單位儲存，漸進式摘要壓縮）與 **Semantic Memory**（知識——從對話與文件中提取的事實、實體、關係，結構化儲存帶 metadata）。

### 記憶操作機制

**記憶建立**採用雙軌策略：被動提取（Mem0 風格，自動從對話中抽取重要事實，走 ADD/UPDATE/DELETE/NOOP 四操作管線）+ 主動存取（MemGPT 風格，Agent 透過工具呼叫主動決定儲存什麼）。被動提取確保一致性，主動存取處理需要判斷力的場景。

**記憶遺忘**使用 Ebbinghaus 衰減模型：`Recency_score = 0.995^(hours_since_creation)`。被成功檢索並使用的記憶重設衰減計時器並提升相關性分數。低於 `importance × recency` 閾值的記憶被標記為待清理。

**記憶壓縮與整合**透過背景任務執行：原始對話 → 會話摘要 → 事實提取 → 壓縮知識。衝突記憶由 LLM 仲裁合併，生成時序反思摘要（例如「使用者在 2025 年 11 月前使用 React，之後轉向 Vue」）。

### 技術選型

| 元件 | 推薦技術 | 理由 |
|------|---------|------|
| 主資料庫 | SQLite + sqlite-vec（桌面版）| 零運維、ACID、向量搜尋、單檔案部署 |
| 向量索引 | sqlite-vec（SIMD 加速）| 30MB 記憶體佔用，支援 KNN 搜尋，cos/L2/dot 距離 |
| 全文搜尋 | SQLite FTS5 | 內建，零額外依賴 |
| 嵌入模型 | OpenAI text-embedding-3-large | 3072 維度，品質最佳，簡單 API |
| 上下文組裝 | Claude prompt caching + 自建 | 利用 Claude 原生功能最小化 token 成本 |

---

## 模組 B：知識系統（Knowledge Base）

### 攝取管線

文件處理採用**分層策略**：Web 內容透過 Firecrawl 轉為乾淨 Markdown；PDF/Office 文件透過 LlamaParse 處理（支援嵌入圖片、複雜表格、手寫內容）；Markdown/純文字直接索引。

**切塊策略**基於 2026 年最大規模基準測試（Vecta, Feb 2026）的結論：**遞迴字元切割，512 tokens，15% overlap**。這個看似簡單的方案以 69% 準確率勝過所有更昂貴的替代方案。語義切塊雖提高 recall 9%，但產生過小片段（平均 43 tokens），反而降低 LLM 回答品質。進階優化為**上下文檢索**：在每個切塊前加上標題路徑與簡短摘要，讓切塊自包含。

### 結構化與非結構化知識

採用**漸進式複雜度**策略：

**Phase 1（Month 3-4）**：向量搜尋 + 關鍵字搜尋。所有文件切塊後嵌入至 sqlite-vec，搭配 FTS5 全文搜尋。metadata 存於 SQLite 表（來源、時間戳、信心度、存取次數）。

**Phase 2（Month 7-8）**：加入輕量知識圖譜。使用 SQLite 表模擬圖結構（entities 表 + relationships 表 + recursive CTEs 查詢）。LazyGraphRAG 風格：用 NLP 名詞短語提取建構輕量圖譜，索引成本僅為完整 GraphRAG 的 **0.1%**（1000 倍降低）。

**Phase 3（Month 11-12，如有餘力）**：Neo4j AuraDB Free 提供完整圖查詢，搭配三模態搜尋（向量 + BM25 + 圖遍歷）。

### 個人知識庫與工作知識庫分離

檔案系統層面直接分離：
```
~/.nous/
  knowledge/
    personal/    # 個人筆記、學習、興趣
    work/        # 專案文件、會議記錄、技術文件
    shared/      # 跨領域參考資料
  memory/
    episodic.db  # 對話歷史
    semantic.db  # 提取的知識事實
```

知識文件以 **Markdown 檔案**儲存（類似 Obsidian/Logseq 模式），SQLite 索引 metadata、嵌入與關係。這保留了使用者的資料主權——檔案在 App 外也可讀可編輯。

---

## 模組 C：Agent 編排系統（Agent Orchestrator）

### 多 Agent 協作模式

Nous 支援四種編排模式，根據任務複雜度自動選擇或由使用者指定：

**Supervisor/Worker 模式**（最常用）：一個 Supervisor Agent 接收任務、分解、分派給專業 Worker Agent，匯整結果。實現為圖狀態機，Supervisor 節點的條件邊依 Worker 類型路由。

**Handoff 模式**（簡單委派）：借鑑 OpenAI Swarm 的極簡設計——一個函式回傳另一個 Agent 物件即完成控制權轉移。適合線性流程如「研究 → 寫作 → 校對」。

**Swarm 模式**（自組織）：Agent 根據專業度自我選擇與協調，無中央瓶頸。適合探索性任務。

**Reflection 模式**（品質保證）：Generator Agent 產出 → Critic Agent 評估 → 迴圈至品質達標。利用 LangGraph 的循環圖支援。

### Sub-Agent 生命週期管理

借鑑 Claude Agent SDK 的 `AgentDefinition`：每個 Sub-Agent 有獨立的 system prompt、工具清單、權限模型。生命週期為：**建立 → 初始化 → 執行 → 暫停/恢復 → 終止**。Agent 狀態透過 checkpoint 機制持久化。

**長時間任務持久化**是關鍵架構決策。推薦 **Temporal.io** 作為持久化執行引擎：

Temporal 是目前唯一經過大規模生產驗證的持久化工作流引擎（OpenAI Codex 與 Replit Agent 3 均使用 Temporal）。其 Workflow/Activity 分離完美對應 Agent 架構：**Workflows**（確定性編排邏輯——Agent 決策迴圈）vs **Activities**（非確定性工作——LLM 呼叫、工具執行、API 請求）。Temporal 提供自動故障恢復、無限時長狀態持久化、Human-in-the-loop Signal、外部狀態查詢，以及可配置重試策略。

**對兩人團隊的考量**：Temporal 的學習曲線較陡。建議 **Phase 1 使用簡單的 SQLite checkpoint 機制**（類似 LangGraph 的 checkpointing），**Phase 2（Month 5-6）再引入 Temporal** 處理真正需要持久化的長時間工作流。

### Agent 間通訊協議

採用雙協議棧：

**MCP（Model Context Protocol）** 處理 Agent → 工具通訊。MCP 已是業界標準，**97M 月度 SDK 下載量**，10,000+ 伺服器，由 Linux Foundation 旗下 Agentic AI Foundation 治理，Anthropic、OpenAI、Google、Microsoft 均支援。

**A2A（Agent-to-Agent Protocol）** 處理 Agent → Agent 通訊。Google 建立，150+ 組織支持，使用 Agent Cards 描述能力，支援非同步任務委派。MCP 與 A2A 天然互補：MCP 是「AI 的 USB-C」，A2A 是「AI 的 HTTP」。

### 工作流定義

採用**混合方案**：YAML/JSON 定義工作流拓撲與 Agent 配置（版本控制友善，借鑑 Rivet 的 YAML 圖格式）；Python/TypeScript 程式碼處理複雜編排邏輯與條件路由。這反映了 CrewAI（YAML config + Python code）與 Microsoft Agent Framework（YAML → code 生成）的業界趨勢。

---

## 模組 D：工具/連接器系統（Tool Runtime）

### MCP Server 管理

MCP 目前的生態系包含 **12,000+ 伺服器**，官方 Registry 在 `registry.modelcontextprotocol.io`。Nous 建立**私有 Registry 層**：

```
MCP Server Manager
├── Registry（發現與註冊）
│   ├── 內建伺服器（檔案系統、瀏覽器、終端機）
│   ├── 社群伺服器（從官方 Registry 安裝）
│   └── 自定義伺服器（使用者開發）
├── Connection Pool（連線管理）
│   ├── STDIO 本地伺服器（子程序管理）
│   └── Streamable HTTP 遠端伺服器（HTTP 連線池）
├── Permission Engine（權限引擎）
│   ├── Tool Annotations（readOnly/destructive/idempotent 標記）
│   ├── allowedTools / disallowedTools 清單
│   └── canUseTool 回呼函式（逐工具決策）
└── Audit Logger（稽核日誌）
```

### 自定義工具開發框架

借鑑 Claude Agent SDK 的 `@tool` decorator + `create_sdk_mcp_server()` 模式：自定義工具作為 **in-process MCP server** 運行，消除獨立程序的 IPC 開銷。開發者只需用 TypeScript/Python 寫一個函式，加上裝飾器即自動註冊為 MCP 工具。

### 沙盒與安全

2026 年的共識是 Docker 容器**不足以**隔離不受信任的 AI 生成程式碼。Nous 採用**分層信任模型**：

- **受信任的內建工具** → 硬化容器（Docker + seccomp）
- **半受信任的第三方 MCP 伺服器** → gVisor（用戶空間核心）
- **不受信任的 AI 生成程式碼** → WASM isolates（微秒級啟動、capability-based sandbox）
- **完整 shell 需求** → Firecracker microVMs（~125ms 啟動，完整核心隔離）

對於兩人團隊的務實策略：**Phase 1 用 Docker + 權限限制**，Phase 2 按需引入 WASM 隔離。

---

## 模組 E：Shell / 人機介面

### 介面形態選擇

經過比較分析，建議採用 **Tauri 桌面應用（Rust shell + React 前端）**：

**Tauri 2.x 優於 Electron** 的關鍵指標：打包大小 **3-10MB vs 100MB+**、記憶體佔用 **~30-40MB vs 數百 MB**、內建 capability-based 安全模型、Tauri 2.0 支援 iOS/Android。最關鍵的是：Tauri 讓你 90%+ 的程式碼寫在 TypeScript/React（Claude Code 最擅長的語言），Rust 只處理 native shell 部分（多數由 Tauri plugins 處理）。

Claude Code 本身就是用 TypeScript + React（Ink 框架）構建的，**~90% 的程式碼由 Claude Code 自己撰寫**。這驗證了 TypeScript + React 作為「AI pair programming 最佳分佈」的地位。

### 介面設計

最新 Shell 形態為 **Ambient 電子腦桌面 + 暫態成果 Surface**，詳見 [06](06_Ambient_Voice_Gaze_Experience.md)。

- 待機只有電子腦動態視覺；使用者以語音表達需求，以 webcam 視線選定成果區塊，再說出動作。
- Command Bar、Knowledge Panel、Agent Monitor、Conversation Stream 是可按需叫出的能力，不作常駐首頁。
- 呈現由 Presentation Designer 提案，確定性 Presentation Policy 檢查需求來源與可見範圍。
- 使用者詢問執行依據時，呈現任務步驟、工具結果、來源與摘要；技術 trace 保留於檢查功能。
- 語音與 webcam 大區塊選取列入新版 Alpha gate；TipTap／tldraw 等編輯能力按任務叫出。

### 關鍵前端技術

| 元件 | 推薦 | 理由 |
|------|------|------|
| 狀態管理 | Zustand + TanStack Query | 輕量、TypeScript-first |
| 富文字編輯 | TipTap（基於 ProseMirror）| 最佳 DX/功能平衡，JSON/Markdown 輸出 |
| 畫布/白板 | tldraw SDK | React 原生，每個元素都是 React component |
| LLM Streaming | Vercel AI SDK + 自定義 SSE | 框架無關的 streaming hooks |
| Markdown 渲染 | react-markdown + rehype/remark | AI 回應渲染 |
| 樣式 | Tailwind CSS | Claude Code 生成最佳 |

---

## 模組 F：身份與安全

### 本地優先架構

Nous 的核心設計原則是**資料永不離開設備，除非使用者明確啟用同步**：

所有使用者資料儲存於本地 SQLite 資料庫與 Markdown 檔案。API keys 存於 OS 原生安全儲存（macOS Keychain、Windows Credential Manager、Linux Secret Service），絕不以明文存入配置檔。SQLite 資料庫可選啟用 **SQLCipher** 加密（透明全庫加密）。Tauri 的 capability-based 安全模型要求每個命令/API 都必須明確允許清單。

### 權限模型

三層權限：

**系統層**：哪些工具 Agent 可以呼叫（`allowedTools`/`disallowedTools`）。讀取操作預設允許，寫入/刪除操作需要使用者確認，destructive 操作需要二次確認。

**Agent 層**：每個 Agent 有獨立的權限範圍。研究 Agent 可讀網頁但不可修改本地檔案。寫作 Agent 可修改文件但不可執行程式碼。

**使用者層**：首次使用新工具時彈出授權對話框，記住選擇。敏感操作（發送郵件、刪除檔案、執行程式碼）始終需要確認。

---

## 模組 G：可觀測性與除錯

### Agent 行為追蹤

每個 Agent 操作產生結構化日誌，使用 **OpenTelemetry** 格式（Claude Desktop Enterprise 版已採用）。追蹤鏈為：`User Request → Supervisor Decision → Agent Spawn → Tool Calls → Memory Operations → Response Assembly`。

### Token 消耗監控

建立即時儀表板追蹤：每次 API 呼叫的 input/output tokens、prompt cache hit rate、每個 Agent 的累計成本、月度成本趨勢。利用 Claude Agent SDK 的 **advisor/executor 模型混合**模式可節省 **60-70% token 成本**：快速模型（Haiku）執行常規操作，高階模型（Opus）僅在需要深度推理時介入。

### 除錯工具

借鑑 LangGraph 的 **time-travel debugging**：每個 checkpoint 可回放、檢查狀態、從任意點重新執行。Agent 執行的每一步都記錄輸入/輸出/決策理由，可視覺化為時間線。

---

## 技術選型總覽

### 完整技術堆疊

| 層級 | 技術選擇 | 理由 |
|------|---------|------|
| **LLM** | Claude Opus 4.6 / Sonnet 4.6 | 1M context、compaction、MRCR v2 最高分 78.3% |
| **主語言** | TypeScript (~70%) | Claude Code 自身用 TS+React 建構，「on-distribution」最佳 |
| **AI/ML 語言** | Python (~20%) | Anthropic SDK 完整支援，ML 生態最豐富 |
| **桌面 Shell** | Tauri 2.x (Rust ~10%) | 3MB 打包、30MB 記憶體、capability-based 安全 |
| **前端框架** | React | 最大生態系、Claude Code 生成品質最佳 |
| **API 層** | tRPC v11 | 零 codegen、端到端類型安全、TypeScript monorepo 專用 |
| **主資料庫** | SQLite（桌面） | 零運維、ACID、單檔案部署、桌面應用標準 |
| **向量搜尋** | sqlite-vec | SIMD 加速、30MB footprint、嵌入 SQLite |
| **全文搜尋** | SQLite FTS5 | 內建、零依賴 |
| **嵌入模型** | OpenAI text-embedding-3-large | 品質最佳、簡單 API |
| **Agent 框架** | Claude Agent SDK + 自建 Orchestrator | 最深 MCP 整合 + 自建控制層避免鎖定 |
| **工作流引擎** | 自建 checkpoint → Phase 2 引入 Temporal.io | 漸進複雜度 |
| **工具協議** | MCP（Linux Foundation 標準） | 97M 月下載量、12,000+ 伺服器 |
| **Monorepo** | pnpm workspaces | 最簡方案，不過度工程化 |
| **構建工具** | Bun（打包）+ Vite（開發）| Claude Code 使用 Bun，速度最佳 |
| **CI/CD** | GitHub Actions | 免費開源、AI code review 整合 |

### 為何不選其他方案

**為何不用 PostgreSQL？** 桌面應用不適合要求使用者安裝 PostgreSQL。SQLite 是桌面版的正確選擇。未來 SaaS 版可遷移到 PostgreSQL + pgvector。

**為何不用 Neo4j？** 對本地優先的單使用者應用過於複雜。用 SQLite 的遞迴 CTE + 關係表模擬輕量圖查詢，Phase 2 再按需引入。

**為何不用 LangGraph/LangChain？** 依賴樹過大、學習曲線最陡。兩人團隊應保持精簡。借鑑其設計模式（graph-based state machine、checkpointing），但用 Claude Agent SDK + 自建輕量版實現。

**為何不用 Electron？** 打包 100MB+、記憶體佔用高。Tauri 在每個指標上都優於 Electron，且 Claude Code 自身驗證了 TypeScript + React 在 Tauri 上的可行性。

### 預估月度基礎設施成本

| 項目 | 成本 |
|------|------|
| Claude API（中度使用） | $50-200/月 |
| OpenAI Embeddings API | $10-30/月 |
| GitHub（CI/CD、託管） | $0-20/月 |
| Apple Developer Account | $99/年 |
| **總計** | **~$70-260/月** |

---

## 產品差異化：為何 Nous 是「OS」而非「App」

### 與現有產品的本質差異

**vs Claude Desktop / Cowork**：Claude Desktop 是**會話制**——每次對話從零開始，除非手動載入 Projects。沒有跨會話持久的「作業系統層」維護狀態。Nous 提供的是**持續成長的記憶與知識圖譜**、多 Agent 編排作為一等公民、超越 Routines 的自主工作流自動化、跨會話學習。

**vs Cursor**：Cursor 是 **IDE**——程式碼專用（$500M ARR，2025 年 6 月）。Nous 是**通用知識工作作業系統**，涵蓋研究、寫作、專案管理、知識管理。Cursor 是工具，Nous 是平台。

**vs Dify / LangGraph Studio**：這些是 **Agent 工作流建構器**——幫你為你的使用者建 AI 應用。Nous 不是建工作流給別人用，而是 **AI 主動管理你的工作**。Dify = 「Build AI apps for your users」；Nous = 「AI manages your work」。

**vs Notion AI / Obsidian + AI**：這些是**以文件為中心**的工具加上 AI 增強。它們無法主動執行任務、編排多 Agent、跨應用感知（MCP）、或提供 kernel 層抽象管理程序/記憶/I/O。

### 「OS 層」vs「應用層」抽象

**OS 層抽象**是 Nous 獨有的：記憶管理（自動遺忘/壓縮/召回）、程序排程（Agent 優先順序、資源分配、context switching）、統一 I/O（MCP 作為通用驅動程式層）、跨程序通訊（Agent 間協議）。

**避免重造輪子的策略**：不重建 Claude（用它作為 kernel）、不重建 MCP（用它作為 I/O 標準）、不重建向量搜尋（用 sqlite-vec）、不重建文件編輯器（用 TipTap）。Nous 只建構**黏合層**——把這些元件組裝成 OS。

---

## 12 個月開發時程

### Month 1-2：奠基期

**目標**：完成架構原型，驗證核心技術可行性，建立開發基礎設施。

**Month 1 交付物**：
- Tauri 2.x + React 桌面 shell（基本視窗、路由、tRPC 通訊）
- Claude Agent SDK 整合（基本對話 streaming、工具呼叫）
- SQLite schema 設計（記憶表、知識表、設定表）
- CLAUDE.md + 專案慣例文件建立
- 基本 CLI 介面（`nous chat`、`nous status`）
- **可展示里程碑**：一個能與 Claude 對話的桌面應用，支援基本工具呼叫

**Month 2 交付物**：
- Context window 管理器原型（三層組裝：static/dynamic/conversation）
- Prompt caching 整合
- 基本 MCP server 管理（連接 2-3 個內建伺服器）
- 權限模型 v1（工具存取授權對話框）
- SQLite checkpoint 機制原型
- **可展示里程碑**：對話跨 session 保持基本上下文，可呼叫 MCP 工具

**分工**：
- 人類：架構決策、Tauri 配置、安全模型設計、UX 決策
- Claude Code：React 元件開發、tRPC router 撰寫、SQLite schema 實現、MCP 整合程式碼

**Must-have**：Tauri shell、Claude SDK 整合、SQLite 基礎、MCP 連接
**Nice-to-have**：CLI 介面、多 MCP 伺服器
**風險點**：Tauri 跨平台 WebView 一致性→ 提早在三平台測試
**Fallback**：若 Tauri 問題過多，退回 Electron

### Month 3-4：MVP 記憶與知識系統

**目標**：建立記憶核心與知識攝取管線，讓系統「記得住東西」。

**Month 3 交付物**：
- 三層記憶架構實現（Working/Dynamic/Archival）
- 被動記憶提取管線（從對話自動提取事實，Mem0 風格）
- sqlite-vec 向量搜尋整合
- 嵌入管線（文字 → OpenAI embedding → sqlite-vec 儲存）
- 複合評分檢索系統（Recency × Importance × Relevance）
- **可展示里程碑**：與系統對話後，下次對話它記得你說過什麼

**Month 4 交付物**：
- 文件攝取管線（Markdown、PDF、網頁 → 切塊 → 嵌入 → 索引）
- Knowledge Panel UI（知識庫瀏覽、搜尋、篩選）
- 記憶操作：主動存取（Agent 工具呼叫）、遺忘（衰減）、壓縮（背景摘要）
- Episodic vs Semantic memory 分離
- **可展示里程碑**：匯入一組文件後，Claude 能準確回答相關問題；記憶隨時間自動管理

**分工**：
- 人類：記憶架構設計、評分算法調校、UX 設計
- Claude Code：嵌入管線實現、SQLite 查詢優化、React UI 元件、文件解析整合

**Must-have**：三層記憶、向量搜尋、基本文件攝取
**Nice-to-have**：記憶壓縮、知識圖視覺化
**風險點**：記憶品質不穩定 → 建立評估基準（準備 20 個測試場景，定期回歸測試）
**Fallback**：若自建記憶系統太複雜，直接整合 Mem0 SDK

### Month 5-6：Agent 編排與工具系統

**目標**：實現多 Agent 協作與豐富的工具整合。

**Month 5 交付物**：
- Agent Orchestrator 核心（Supervisor/Worker 模式）
- Sub-Agent 生命週期管理（建立/執行/暫停/終止）
- Agent 間狀態傳遞機制
- 3-5 個內建 Agent 模板（研究、寫作、程式碼、摘要、排程）
- Agent Monitor UI（狀態面板、進度指示、中斷按鈕）
- **可展示里程碑**：「幫我研究 X 並寫成報告」觸發多 Agent 自動分工協作

**Month 6 交付物**：
- MCP Server 管理器 UI（安裝/移除/設定）
- 自定義工具開發框架（`@tool` decorator → in-process MCP server）
- 整合主流服務（Gmail、GitHub、Notion、Google Drive via MCP servers）
- 工作流定義 v1（YAML 配置 + TypeScript 程式碼）
- Handoff 模式實現
- **可展示里程碑**：「幫我整理今天的郵件，回覆緊急的，其他摘要存到知識庫」自動完成

**分工**：
- 人類：Agent 架構設計、工具權限策略、工作流 DSL 設計
- Claude Code：Orchestrator 狀態機實現、MCP 整合、Agent 模板撰寫、UI 開發

**Must-have**：基本多 Agent、MCP 管理器、3+ 外部服務整合
**Nice-to-have**：視覺化工作流編輯器、A2A 協議支援
**風險點**：多 Agent token 成本爆炸 → 使用 advisor/executor 模型混合（Haiku 執行 + Opus 推理）；建立成本預算機制
**Fallback**：若 Orchestrator 過於複雜，先僅支援線性 pipeline 模式

### Month 7-8：UI / Shell 介面整合

**目標**：打磨使用者體驗，讓系統不只「能用」而且「好用」。

**Month 7 交付物**：
- 完整 Dashboard 重設計（Command Bar、Knowledge Panel、Agent Monitor、Conversation Stream 四區佈局）
- TipTap 富文字編輯器整合（知識撰寫/編輯）
- Extended thinking 展示（可摺疊思考過程區塊）
- 深色/淺色主題
- 快捷鍵系統（Cmd+K 全域指令列）
- **可展示里程碑**：視覺上精緻的桌面應用，流暢的 AI 互動體驗

**Month 8 交付物**：
- 輕量知識圖譜視覺化（實體關係圖）
- tldraw 畫布整合（視覺化思考/知識地圖）
- Token 消耗儀表板
- 設定面板（API key 管理、Agent 配置、記憶參數）
- 自動更新機制（Tauri updater plugin）
- **可展示里程碑**：完整的「第二大腦」體驗——知識視覺化 + AI 操作 + 工具整合

**分工**：
- 人類：UX/UI 設計、視覺品質把關、使用者測試
- Claude Code：React 元件精修、動畫/過渡效果、tldraw 整合、設定面板

**Must-have**：Dashboard 四區佈局、rich text 編輯、設定面板
**Nice-to-have**：tldraw 畫布、知識圖視覺化、深色主題
**風險點**：前端開發時間超出預期 → 優先保證核心流程順暢，視覺細節後補
**Fallback**：tldraw 和知識圖視覺化推遲到 post-launch

### Month 9-10：整合測試與使用者試用

**目標**：穩定系統、收集回饋、快速迭代。

**Month 9 交付物**：
- 端到端整合測試套件（核心流程 100% 覆蓋）
- 效能優化（啟動時間 < 3 秒、對話回應 < 1 秒首 token）
- 記憶系統壓力測試（1000+ 記憶項目、100+ 文件的場景）
- 安全稽核（API key 儲存、權限模型、sandbox 有效性）
- Alpha 版本打包（macOS .dmg + Windows .msi + Linux .AppImage）
- **可展示里程碑**：可交付給 5-10 位 alpha 測試者的穩定版本

**Month 10 交付物**：
- Alpha 測試回饋收集與快速修正（每週迭代）
- 基於回饋的優先順序調整
- 文件撰寫開始（Getting Started、Architecture Guide）
- 社群基礎建設（GitHub repo 公開準備、Discord 伺服器建立）
- Blog 文章草稿：「Building an AI Operating System」系列
- **可展示里程碑**：Alpha 測試者能完成完整工作流程而不崩潰

**分工**：
- 人類：測試協調、使用者訪談、優先順序決策、文件/blog 撰寫
- Claude Code：測試程式碼、bug 修復、效能優化、文件生成

**Must-have**：穩定 alpha 版、基本文件、10 位測試者回饋
**Nice-to-have**：自動化測試 CI、效能基準
**風險點**：Alpha 回饋指向根本性架構問題 → 預留 50% buffer 時間用於重構；若問題過大，縮小 scope 到記憶+知識系統核心
**Fallback**：延後 1 個月發布，優先修復關鍵問題

### Month 11-12：打磨與發布

**目標**：從 Alpha 到 Beta，建立社群，準備公開發布。

**Month 11 交付物**：
- Beta 版本（基於 Alpha 回饋的改進版）
- 完整文件網站（Docusaurus 或 VitePress）
- Plugin/Agent SDK v1（社群可開發自定義 Agent 與工具）
- 程式碼簽署與公證（Apple notarization + Windows Authenticode）
- 開源準備（License 文件、Contributing Guide、Code of Conduct）
- **可展示里程碑**：可安裝的 Beta 版本 + 完整文件網站

**Month 12 交付物**：
- 公開 Beta 發布（GitHub Release + 官網 + 社群）
- 發布文章/影片（「Building Nous: The First Cognitive Operating System」）
- ProductHunt / Hacker News / Twitter 發布策略
- Discord 社群正式上線
- 50-100 位 Beta 使用者目標
- Post-launch 路線圖公佈
- **可展示里程碑**：公開可下載的 Beta 版，活躍的社群開始形成

**分工**：
- 人類：發布策略、社群管理、行銷內容、PR/媒體接觸
- Claude Code：文件生成、SDK 實現、最終 bug 修復、自動化打包流程

**Must-have**：穩定 Beta、文件、公開 repo、基本社群
**Nice-to-have**：Plugin marketplace、影片 demo、50+ 使用者
**風險點**：發布時機與市場競爭 → 及時關注 Anthropic 產品更新，確保差異化清晰
**Fallback**：若未準備好公開，先以 private beta（邀請制）發布

---

## 發布與社群策略

### 開源模式：Apache 2.0 + Open Core

**核心引擎**（Apache 2.0 開源）：kernel 抽象、記憶系統、基本 Agent 框架、MCP 整合層、CLI 介面、基本 UI。

**進階功能**（未來商業化）：多人協作、SSO/SAML、企業級稽核日誌、進階分析、託管雲端服務。

這個模式在 AI 開源社群最為成功，Dify（Apache 2.0 + cloud）、LangChain（MIT + LangSmith SaaS）、Langfuse（MIT + cloud）均採用。**不建議 BSL**——HashiCorp 的 BSL 切換直接催生了 OpenTofu fork，對新專案的社群建設有害。

### 早期使用者招募策略

目標群體優先順序：Claude 深度使用者 → MCP 開發者 → 「第二大腦」愛好者（Obsidian/Notion 社群）→ AI-native 開發者。

**內容行銷**：「Building an AI OS」技術 blog 系列（架構決策、設計哲學）；YouTube demo 展示真實工作流；「How I replaced X tools with one Cognitive OS」案例研究；在 MCP 生態討論中建立思想領袖地位。

**社群平台**：Discord（即時互動，AI 開源社群的標準選擇）+ GitHub Discussions（結構化 Q&A 與功能請求）+ X/Twitter（傳播與認知度）。

---

## 風險評估與應對

### 技術風險

**Claude API 變動**（中等風險）：Anthropic 更新模型與 API 可能破壞現有整合。應對：抽象 LLM 呼叫層為獨立模組，設計 adapter pattern；維護與最新 SDK 版本的相容性測試；考慮未來加入備選模型支援（雖然不是優先項）。

**MCP 生態成熟度**（低風險，持續降低）：MCP 已獲 Linux Foundation 治理、97M 月下載量，所有主要 AI 公司支持。但個別 MCP server 品質參差不齊。應對：內建核心工具不依賴第三方 MCP server；建立 MCP server 品質評級系統。

**SQLite 規模限制**（低風險）：sqlite-vec 對數十萬文件綽綽有餘。應對：設計資料層抽象，未來可遷移到 PostgreSQL + pgvector（SaaS 版本）。

### 市場風險

**被 Anthropic 官方產品覆蓋**（最高風險）：Claude Desktop 持續增強功能——Cowork（2026 年 3 月 GA）、Routines、MCP Apps 不斷縮小差距。應對策略有三：聚焦 Anthropic **不會建的**功能（使用者擁有的持久記憶/知識圖譜、完全本地優先、多 Agent 編排、可自定義 OS 層抽象）；定位為「Claude 之上的層」而非競爭者——Claude 是 kernel，Nous 是 OS，兩者互補；透過 MCP 貢獻與生態參與保持能見度，可能吸引 Anthropic 注意（Anthropic 有投資基金）。

**競品快速崛起**（中等風險）：OpenClaw 60 天從 9K 到 188K stars 的爆發式成長證明市場對開源 AI 代理有巨大需求。應對：速度是兩人團隊的優勢——快速迭代、快速發布、快速回應社群。

### 執行風險

**2 人 12 個月的 Scope 控制**（最高風險）：這份藍圖的完整範圍對兩人團隊極為緊張。應對策略為**嚴格的 MVP 思維**：

**絕對必要的核心功能**（沒有這些不算 OS）：Claude 作為 kernel + 記憶系統（三層）+ 知識攝取與檢索 + 基本 Agent 編排 + MCP 工具整合 + 桌面 UI。

**重要但可延後的功能**：知識圖譜視覺化、tldraw 畫布、A2A 協議支援、Temporal.io 整合、視覺化工作流編輯器。語音介面已於 2026-09-16 更新為 Alpha 必要項，見 06–07。

**Post-v1 的功能**：雲端同步、多人協作、Plugin marketplace、移動端支援、企業功能。

**Claude Code 作為 pair programmer 的效能倍增器**是這個時程可行的前提。Claude Code 自身驗證了 TypeScript + React 專案中 AI 可撰寫 ~90% 的程式碼。關鍵是人類維持架構決策與品質把關，Claude Code 負責大量實現工作。利用 CLAUDE.md 編碼架構決策、Git worktree 實現平行工作流、Skills 系統擴展能力。

---

## 結論：為什麼現在是對的時間

認知作業系統的時機已到。三個結構性條件同時成熟：**Claude 的 1M context window + compaction** 讓「虛擬記憶管理」首次變得實際可行——不再需要精密的 context window 雜技，而是可以像真正的 OS 一樣管理記憶層級。**MCP 成為 Linux Foundation 治理的開放標準**意味著工具整合層不再是單一廠商鎖定，而是穩定的產業基礎設施。**知識工作者每週浪費 8.2 小時在尋找、重建與重複資訊**的痛點，至今沒有任何產品以 OS 層級的系統化方式解決。

Nous 的獨特定位不在於做「更好的 AI Chat」或「更好的工作流建構器」，而在於提供一個**完整的認知基礎設施層**——讓 Claude 不只是你的對話夥伴，而是你的認知協處理器，持續管理你的知識、記憶與工作流。這是一個學術論文已經指明方向（AIOS、CoALA、MemGPT），但尚無人實現為成熟產品的架構空白。兩人團隊 12 個月的挑戰極大，但 Claude Code 作為 pair programmer 的效能倍增效應——以及嚴格的 MVP 紀律——讓這條路徑具有現實可行性。
