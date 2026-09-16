# Nous 認知 OS — 開源元件對應表（Component Map）

> **2026-09-16 互動規格更新**：電子腦待機、無 App、語音優先、webcam 視線選取及按需呈現，依 [06 體驗規格](./06_Ambient_Voice_Gaze_Experience.md) 與 [07 開發驗收](./07_Ambient_Implementation_and_Acceptance.md)。本文其餘底層設計保留；舊時程與舊介面描述僅供歷史參考，衝突時以 06–07 為準。

> **目的**：把 12 個月藍圖中的每個自建模組，對應到社群已成熟的 OSS 專案，從「從零打造」轉為「整合 + 薄膠水層」，把時程壓縮到 3 個月。
>
> **策略分級**：
> - 🟢 **Integrate（整合）**：直接作為依賴函式庫使用，我們寫 adapter
> - 🟡 **Fork（分叉）**：fork 後深度客製化，作為核心骨架
> - 🔵 **Reference（參考）**：研究其設計模式，不直接使用
> - ⚫ **Standard（標準）**：業界協議 / 規範，一律遵循

---

## 🎯 頂層策略：站在 Khoj 肩上

**最激進也最有效的捷徑**：以 **Khoj** 作為專案起點。Khoj 已經是一個成熟的「self-hosted AI second brain」——有 Web/Desktop/Obsidian/Emacs 多端、文件攝取、語義搜尋、custom agents、排程自動化。我們要做的不是重建，而是**把它改造成 Claude-native 的 Cognitive OS**。

| 元件 | 專案 | URL | Stars | License | 策略 |
|---|---|---|---|---|---|
| **整體骨架候選** | khoj-ai/khoj | https://github.com/khoj-ai/khoj | 30K+ | AGPL-3.0 | 🟡 Fork 或深度參考 |

**⚠️ 注意**：Khoj 是 AGPL-3.0，若要商業化需評估。替代策略是「只借鑑架構」，用 MIT/Apache 的零件自己組。**本文件以後者為主軸**。

---

## 模組 A：記憶系統（Memory Kernel）

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 | 關鍵理由 |
|---|---|---|---|---|---|---|
| **Agent 記憶層（主選）** | letta-ai/letta | https://github.com/letta-ai/letta | 21.6K | Apache-2.0 | 🟢 Integrate | MemGPT 論文官方後繼，三層記憶（core/recall/archival）與 OS 隱喻完全對齊，Docker 一鍵啟動，提供 REST API + Python/TS SDK，自帶 ADE 圖形介面 |
| **輕量記憶層（備選）** | mem0ai/mem0 | https://github.com/mem0ai/mem0 | 48K | Apache-2.0 | 🟢 Integrate | 最大社群、API 最簡、3 層 scope（user/session/agent）、自動 conflict resolution、上手最快 |
| **記憶 + 知識混合層** | topoteretes/cognee | https://github.com/topoteretes/cognee | 15.1K | Apache-2.0 | 🔵 Reference | Graph + Vector 混合記憶，支援 NetworkX/FalkorDB/Neo4j；適合後期若要做 cognitive memory 升級 |
| **向量索引（嵌入式）** | asg017/sqlite-vec | https://github.com/asg017/sqlite-vec | 6K+ | Apache-2.0 | 🟢 Integrate | SIMD 加速、30MB footprint、直接嵌入 SQLite，桌面應用唯一正解 |
| **嵌入模型** | OpenAI API / BAAI/bge-m3 | https://huggingface.co/BAAI/bge-m3 | - | MIT | 🟢 Integrate | 雲端用 `text-embedding-3-large`，本地 fallback 用 bge-m3 |

### 🎯 本模組推薦組合
**Phase 1（Week 1-2）**：直接跑 **Letta Docker**，Nous 前端透過 Letta REST API 互動 → 省 6-8 週自建記憶層時間。

---

## 模組 B：知識系統（Knowledge Base）

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 | 關鍵理由 |
|---|---|---|---|---|---|---|
| **RAG + KG 引擎（主選）** | HKUDS/LightRAG | https://github.com/HKUDS/LightRAG | 32.8K | MIT | 🟢 Integrate | EMNLP 2025 論文，雙層檢索（向量 + 知識圖譜），自帶 Web UI、支援 Ollama 相容介面、可本地部署所有後端 |
| **文件解析器（通用）** | docling-project/docling | https://github.com/docling-project/docling | 30K+ | MIT | 🟢 Integrate | LF AI & Data Foundation 治理，IBM 出品，支援 PDF/DOCX/PPTX/XLSX/HTML/音訊/圖片，本地執行、適用 air-gapped 環境 |
| **文件 → Markdown** | microsoft/markitdown | https://github.com/microsoft/markitdown | 50K+ | MIT | 🟢 Integrate | Microsoft 出品，最輕量、API 最簡，適合大批通用檔案 |
| **Web 爬取轉 Markdown** | mendableai/firecrawl | https://github.com/mendableai/firecrawl | 25K+ | AGPL-3.0/MIT | 🟢 Integrate（Cloud API）| 從 URL 到乾淨 Markdown 最佳，有免費額度，自架版本為 AGPL |
| **PDF 高品質解析（備選）** | VikParuchuri/marker | https://github.com/VikParuchuri/marker | 25K+ | GPL-3.0 | 🔵 Reference | 若需 GPU 高準確率時；但 GPL 授權風險 |
| **知識圖譜建構（備選）** | microsoft/graphrag | https://github.com/microsoft/graphrag | 20K+ | MIT | 🔵 Reference | 如需完整 GraphRAG；LightRAG 通常已足夠 |

### 🎯 本模組推薦組合
- **Ingestion**：Docling（複雜 PDF）+ MarkItDown（通用檔案）+ Firecrawl（Web）
- **Indexing + Retrieval**：LightRAG（一次搞定 RAG + KG）
- 全程本地可跑,無須雲端依賴。

---

## 模組 C：Agent 編排系統（Agent Orchestrator）

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 | 關鍵理由 |
|---|---|---|---|---|---|---|
| **Agent 核心 SDK** | anthropics/claude-agent-sdk-python | https://github.com/anthropics/claude-agent-sdk-python | - | MIT | 🟢 Integrate | Anthropic 官方，深度 MCP 整合、subagents、hooks、permission 一等公民 |
| **Agent TS SDK** | anthropics/claude-agent-sdk-typescript | https://github.com/anthropics/claude-agent-sdk-typescript | - | MIT | 🟢 Integrate | 前端直接呼叫必備 |
| **多 Agent 編排（輕量）** | openai/swarm | https://github.com/openai/swarm | 20K+ | MIT | 🔵 Reference | Handoff-as-return 設計極簡；參考其哲學 |
| **圖狀態機（進階）** | langchain-ai/langgraph | https://github.com/langchain-ai/langgraph | 15K+ | MIT | 🔵 Reference | 參考其 checkpoint / time-travel debug 模式，**不直接依賴整個 LangChain** |
| **角色制 Agent（參考）** | crewAIInc/crewAI | https://github.com/crewAIInc/crewAI | 35K+ | MIT | 🔵 Reference | YAML 配置 Agent 模式值得學，本身依賴重 |
| **持久化工作流（後期）** | temporalio/temporal | https://github.com/temporalio/temporal | 13K+ | MIT | 🟢 Integrate（Phase 2）| 長時任務持久化,OpenAI Codex 與 Replit Agent 3 均用 |

### 🎯 本模組推薦組合
Claude Agent SDK（Python 後端 + TS 前端）作為唯一 agent 框架，其他只看 source 學設計。**絕對不要把 LangChain 拉進來**——依賴樹會毀了兩人團隊的進度。

---

## 模組 D：工具/連接器系統（Tool Runtime — MCP）

### MCP 核心基礎設施

| 元件職責 | OSS 專案 | GitHub | 策略 | 理由 |
|---|---|---|---|---|
| **MCP Registry（官方）** | modelcontextprotocol/registry | https://github.com/modelcontextprotocol/registry | ⚫ Standard | 社群驅動的 MCP 伺服器註冊中心，API 已凍結 v0.1 |
| **MCP Servers 參考實作** | modelcontextprotocol/servers | https://github.com/modelcontextprotocol/servers | 🟢 Integrate | 官方 reference servers |
| **GitHub MCP Registry** | github.com/mcp | https://github.com/mcp | ⚫ Standard | GitHub 官方 MCP 註冊表 |
| **Awesome MCP Servers 總清單** | punkpeye/awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | 🔵 Reference | 最完整社群清單 |
| **Awesome MCP（備選）** | appcypher/awesome-mcp-servers | https://github.com/appcypher/awesome-mcp-servers | 🔵 Reference | 另一個優質清單 |
| **MCP Gateway / Registry 自架** | toolsdk-ai/toolsdk-mcp-registry | https://github.com/toolsdk-ai/toolsdk-mcp-registry | 🔵 Reference | 4547+ MCP servers 自架 Registry |

### 必裝的 MCP Servers（首發內建）

| 用途 | MCP Server | GitHub | 備註 |
|---|---|---|---|
| 檔案系統 | @modelcontextprotocol/server-filesystem | modelcontextprotocol/servers | 官方 reference |
| Git/GitHub | github-mcp-server | https://github.com/github/github-mcp-server | GitHub 官方 |
| Gmail | gongrzhe/server-gmail-autoauth-mcp | GitHub 搜「gmail mcp」 | OAuth 自動授權 |
| Notion | makenotion/notion-mcp-server | https://github.com/makenotion/notion-mcp-server | Notion 官方 |
| Google Drive | google-gemini/gdrive-mcp-server | GitHub 搜「gdrive mcp」 | Google 生態 |
| 瀏覽器自動化 | executeautomation/playwright-mcp-server | https://github.com/microsoft/playwright-mcp | Microsoft 官方 |
| Slack | modelcontextprotocol/servers/slack | modelcontextprotocol/servers | 官方 reference |
| 網頁抓取 | mendableai/firecrawl-mcp-server | https://github.com/mendableai/firecrawl-mcp-server | Firecrawl 官方 |

### 🎯 本模組推薦組合
**不自建任何連接器**。所有整合透過 MCP，使用者可從官方 Registry 一鍵安裝。Nous 只做 **MCP Server Manager UI**（瀏覽、安裝、授權、稽核日誌）。

---

## 模組 E：Shell / 人機介面（UI）

### 桌面 Shell

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 |
|---|---|---|---|---|---|
| **桌面應用框架** | tauri-apps/tauri | https://github.com/tauri-apps/tauri | 80K+ | MIT/Apache-2.0 | 🟢 Integrate |
| **Tauri + shadcn 起手式** | agmmnn/tauri-ui | https://github.com/agmmnn/tauri-ui | 1K+ | MIT | 🟡 Fork |
| **Tauri v2 + React 19 模板** | kitlib/tauri-app-template | https://github.com/kitlib/tauri-app-template | - | - | 🔵 Reference |

### AI Chat UI 元件

2026-09-16 更新：下列元件用於按需展開的對話與成果；不將現成聊天範本直接當作首頁。電子腦、Voice Session、GazeProvider、FocusResolver 與 Presentation Policy 為新的 Shell 整合範圍。視線候選、校正限制與官方來源見 [06 §4](./06_Ambient_Voice_Gaze_Experience.md#4-webcam-視線互動)，正式依賴待 PoC 後決定。

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 |
|---|---|---|---|---|---|
| **AI Chat UI 主力** | assistant-ui/assistant-ui | https://github.com/assistant-ui/assistant-ui | 5K+ | MIT | 🟢 Integrate |
| **AI SDK（streaming）** | vercel/ai | https://github.com/vercel/ai | 10K+ | Apache-2.0 | 🟢 Integrate |
| **Vercel Chatbot 範本** | vercel/chatbot | https://github.com/vercel/chatbot | - | - | 🔵 Reference |

### 富文字 / 畫布 / Markdown

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 |
|---|---|---|---|---|---|
| **富文字編輯器** | ueberdosis/tiptap | https://github.com/ueberdosis/tiptap | 25K+ | MIT | 🟢 Integrate |
| **白板/畫布** | tldraw/tldraw | https://github.com/tldraw/tldraw | 35K+ | Apache-2.0（商用需授權）| 🟢 Integrate（需注意商用條款）|
| **Markdown 渲染** | remarkjs/react-markdown | https://github.com/remarkjs/react-markdown | 13K+ | MIT | 🟢 Integrate |
| **UI 元件庫** | shadcn-ui/ui | https://github.com/shadcn-ui/ui | 70K+ | MIT | 🟢 Integrate |

### 狀態管理 / 資料層

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 |
|---|---|---|---|---|---|
| **狀態管理** | pmndrs/zustand | https://github.com/pmndrs/zustand | 45K+ | MIT | 🟢 Integrate |
| **資料查詢** | TanStack/query | https://github.com/TanStack/query | 42K+ | MIT | 🟢 Integrate |
| **端到端類型 API** | trpc/trpc | https://github.com/trpc/trpc | 35K+ | MIT | 🟢 Integrate |

### 🎯 本模組推薦組合
**Fork `agmmnn/tauri-ui`** 作為起點 → 內嵌 `assistant-ui` 元件 → 用 shadcn/ui 建 Command Bar、Knowledge Panel、Agent Monitor → TipTap 做編輯，tldraw 做視覺化。省 **3-4 週 UI 框架搭建時間**。

---

## 模組 F：身份與安全

| 元件職責 | OSS 專案 | GitHub | 策略 | 理由 |
|---|---|---|---|---|
| **OS 原生 Keychain** | Tauri keyring plugin | https://github.com/tauri-apps/plugins-workspace | 🟢 Integrate | 跨平台統一 API（macOS Keychain / Windows Credential Manager / Linux Secret Service） |
| **SQLite 加密** | sqlcipher/sqlcipher | https://github.com/sqlcipher/sqlcipher | 🟢 Integrate | SQLite 透明全庫加密 |
| **OAuth 流程** | panva/openid-client | https://github.com/panva/openid-client | 🟢 Integrate | 處理第三方服務 OAuth |
| **Sandbox（進階）** | firecracker-microvm | https://github.com/firecracker-microvm/firecracker | 🔵 Reference | 後期若需執行 AI 生成程式碼 |

---

## 模組 G：可觀測性與除錯

| 元件職責 | OSS 專案 | GitHub | Stars | License | 策略 |
|---|---|---|---|---|---|
| **LLM 追蹤 / 評估主選** | langfuse/langfuse | https://github.com/langfuse/langfuse | 25K+ | MIT | 🟢 Integrate |
| **LLM 觀測備選** | Arize-ai/phoenix | https://github.com/Arize-ai/phoenix | 5K+ | Elastic v2 | 🔵 Reference |
| **OTel 自動埋點** | traceloop/openllmetry | https://github.com/traceloop/openllmetry | 6K+ | Apache-2.0 | 🟢 Integrate |

### 🎯 本模組推薦組合
Langfuse Docker 一鍵起來,Claude Agent SDK hooks 推送 span 過去,Token / 成本 / trace / eval 一站搞定。省 **2-3 週自建儀表板**。

---

## 完整依賴總覽表（Top of Mind）

| 層級 | 專案名 | GitHub | 角色 | 估省時間 |
|---|---|---|---|---|
| Shell | agmmnn/tauri-ui | https://github.com/agmmnn/tauri-ui | 桌面殼 + shadcn 起手式 | 3 週 |
| Shell | assistant-ui/assistant-ui | https://github.com/assistant-ui/assistant-ui | Chat UI primitives | 2 週 |
| Kernel | anthropics/claude-agent-sdk-* | https://github.com/anthropics | Agent 引擎 | 已含 |
| Memory | letta-ai/letta | https://github.com/letta-ai/letta | 三層記憶 OS | 8 週 |
| Knowledge | HKUDS/LightRAG | https://github.com/HKUDS/LightRAG | RAG + KG 雙引擎 | 6 週 |
| Ingestion | docling-project/docling | https://github.com/docling-project/docling | PDF/Office 解析 | 2 週 |
| Ingestion | microsoft/markitdown | https://github.com/microsoft/markitdown | 通用 → Markdown | 1 週 |
| Ingestion | mendableai/firecrawl | https://github.com/mendableai/firecrawl | Web 爬取 | 1 週 |
| Tools | modelcontextprotocol/registry | https://github.com/modelcontextprotocol/registry | MCP 發現 | 4 週 |
| Tools | modelcontextprotocol/servers | https://github.com/modelcontextprotocol/servers | 內建工具 | 2 週 |
| DB | asg017/sqlite-vec | https://github.com/asg017/sqlite-vec | 向量索引 | 2 週 |
| Obs | langfuse/langfuse | https://github.com/langfuse/langfuse | 追蹤 / 評估 | 3 週 |
| Editor | ueberdosis/tiptap | https://github.com/ueberdosis/tiptap | 富文字編輯 | 2 週 |
| Canvas | tldraw/tldraw | https://github.com/tldraw/tldraw | 畫布 | 3 週 |
| UI Kit | shadcn-ui/ui | https://github.com/shadcn-ui/ui | 元件庫 | 2 週 |
| State | pmndrs/zustand | https://github.com/pmndrs/zustand | 狀態 | - |
| API | trpc/trpc | https://github.com/trpc/trpc | 類型安全 | - |

**估省總時間**：~**41 週** → 12 個月時程壓縮至 **~3 個月** ✅

---

## 授權風險備忘

| 專案 | License | 風險 | 緩解 |
|---|---|---|---|
| Khoj | **AGPL-3.0** | 若 fork 整個應用，需開源所有衍生 | 不 fork,只借鑑架構 |
| Firecrawl 自架版 | AGPL-3.0 | 同上 | 改用其 Cloud API（MIT），或用備選 |
| Marker | GPL-3.0 | 同上 | 用 Docling（MIT）代替 |
| tldraw SDK | Apache-2.0 with watermark | 商用需購買 license | MVP 階段可接受浮水印；商業化時再授權 |
| Letta | Apache-2.0 | ✅ 安全 | — |
| LightRAG | MIT | ✅ 安全 | — |
| Docling | MIT | ✅ 安全 | — |
| MarkItDown | MIT | ✅ 安全 | — |
| Langfuse | MIT | ✅ 安全 | — |
| assistant-ui | MIT | ✅ 安全 | — |

**產品整體授權建議**：**Apache-2.0 + 避開所有 AGPL/GPL 依賴**,保留未來商業化彈性。

---

## 不使用清單（避免誘惑）

| 專案 | 為何不用 |
|---|---|
| LangChain | 依賴樹爆炸、學習曲線陡、兩人團隊負擔不起 |
| LlamaIndex | 同上,且與我們的輕量策略衝突 |
| Dify / Flowise | 定位是「建 AI 應用給別人用」,與 Nous 「AI 管理你的工作」相反 |
| AutoGen | Microsoft 生態、學習成本高、Claude 整合弱於 Claude Agent SDK |
| PostgreSQL + pgvector（Phase 1）| 桌面應用不該要求使用者裝 Postgres；Phase 2 若上雲再換 |
| Neo4j（Phase 1）| 對單使用者過重；LightRAG 已有 KG 能力 |
| Electron | 打包 100MB+、記憶體爆炸,被 Tauri 完勝 |

---

## 核心洞察

**藍圖中 80% 的模組都已有成熟 OSS 對應**。我們要做的是：

1. **選擇**：在每個模組選 1 個主力 + 1 個備選
2. **整合**：寫 adapter 層把它們串起來
3. **差異化**：把精力花在「整合邏輯」與「使用者體驗」—— 這才是 Nous 的核心價值
4. **不重建**：任何已有 10K+ stars 的成熟專案,都優先選擇整合而非自建

**Nous 的價值不在於發明新記憶系統或新 RAG,而在於把這些世界級的零件組裝成一個連貫的 Cognitive OS——並由 Claude 作為 kernel 統籌調度。**
