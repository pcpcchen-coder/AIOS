<!-- bilingual: source=zh-TW -->

> [繁體中文](01_Complete_Technical_Blueprint.md) | [English](01_Complete_Technical_Blueprint.en.md)

<a id="以-claude-為核心的認知作業系統完整技術藍圖與開發時程"></a>
# A cognitive operating system built around Claude: complete technical blueprint and development schedule

> **Reading guide, 2026-10-24**: See [implementation status](Current_Implementation_Status.en.md) for current code and gaps. See the [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) for value, dependencies, MVPs, and roadmaps. This document preserves early designs. It does not mean they are implemented or accepted. Product constraints and G0–G3 still follow [06](06_Ambient_Voice_Gaze_Experience.en.md), [07](07_Ambient_Implementation_and_Acceptance.en.md), and later explicit revisions. F0–F10 and Q0–Q4 in the new assessment do not replace those gates.
>
> The code baseline is `1f44c6b` (2026-10-23). The runnable prototype is in `prototype/ambient-shell`, using Node HTTP, SSE, TypeScript, Vite, and Electron. Tauri, React, a Python kernel, Agent SDK, long-term memory, and generated tools in this document are target designs. Model, price, market, star, and ecosystem figures reflect the original writing date. They were not rechecked in this update. Verify them before adoption.

> **Interaction specification update, 2026-09-16**: Ambient brain standby, no apps, voice first, webcam gaze selection, and on-demand presentation follow [06 experience specification](06_Ambient_Voice_Gaze_Experience.en.md) and [07 development and acceptance](07_Ambient_Implementation_and_Acceptance.en.md). The underlying designs remain here. Old schedules and interfaces are historical references. Where they conflict, 06–07 take precedence.

**A Cognitive OS is a personal knowledge and work management platform with Claude as its cognitive kernel. It does not control hardware. It lets AI operate on knowledge, memory, workflows, and multi-agent orchestration.** Based on research into 30+ open-source projects, papers, and industry frameworks, this blueprint lays out a technical path for a two-person team to deliver a demonstrable product in 12 months. Its central insight is that no current product supplies a complete OS abstraction layer. Claude Desktop is a shell, Notion a file system, and Dify a process builder, but nobody integrates them into an operating system. This is an unoccupied architectural layer in a **$14.89B market** (2025).

---

<a id="產品命名與定位"></a>
## Product naming and positioning

After extensive searches and conflict analysis, the proposed names rank as follows:

| Name | Origin | Advantages | Risks |
|------|------|------|------|
| **Nous** | Greek νοῦς (mind/intellect) | Short, memorable, philosophically rich. “Nous OS” sounds natural. | NousResearch exists but focuses on LLM research. |
| **Thymos** | Greek θυμός (will/drive) | No conflicts found. Conveys agency and willpower, with strong brand potential. | Unfamiliar, requiring market education. |
| **Meld** | English (merge/unify) | Short, usable as a verb, easy to pronounce, and suggests knowledge integration. | Generic, although no AI product conflict was found. |
| **Phren** | Greek φρήν (mind, root of phronesis) | Highly distinctive, with no conflicts found. | Meaning is not immediately clear. |
| **Anima** | Latin (soul/mind) | Aesthetic, humanistic, and culturally resonant. | Some use in games and animation. |
| **Kernel** | Direct OS metaphor | Intuitive for developers. “Claude is the kernel.” | Too generic. |

**Choose Nous or Thymos.** Nous resonates most with developers and knowledge workers. It is short enough for a CLI command (`nous run`) and meaningful enough for a brand story. This report uses **Nous** as the working name.

---

<a id="核心架構設計從傳統-os-到認知-os-的映射"></a>
## Core architecture: mapping a traditional OS to a cognitive OS

<a id="架構概念映射"></a>
### Architectural concept mapping

The mapping is a design blueprint rather than just a metaphor. Each layer has a corresponding implementation:

| Traditional OS concept | Nous Cognitive OS equivalent | Core technology |
|---|---|---|
| **Kernel** | Claude API (cognitive reasoning engine) | Anthropic Claude Opus/Sonnet 4.6, 1M context window |
| **Memory Management** | Memory kernel (three memory tiers) | PostgreSQL + pgvector / SQLite + sqlite-vec |
| **File System** | Knowledge base (semantic file system) | Markdown files + vector index + knowledge graph |
| **Process / Task** | Agent / Workflow | Claude Agent SDK + custom scheduler |
| **Scheduler** | Agent Orchestrator | Graph state machine + Temporal.io (durable execution) |
| **Shell** | Natural-language interface | React + TipTap + tldraw |
| **IPC** | Inter-agent communication protocols | MCP (tool layer) + A2A (agent layer) |
| **Driver** | Tool / Connector | MCP Servers (10,000+ ecosystem) |
| **User Space** | Specialist agent applications | Research, writing, coding, and other agents |

<a id="學術基礎"></a>
### Academic foundations

Three papers provide the theoretical foundation:

**AIOS** (Rutgers University, COLM 2025) gives the most rigorous definition of an LLM as an OS kernel. LLM instances become “LLM cores,” analogous to CPU cores. Agent scheduling corresponds to process scheduling, and context switching to OS process context switching. **CoALA** (TMLR 2024) connects LLM agents to classical cognitive architectures (ACT-R and Soar), providing a memory taxonomy of working, episodic, semantic, and procedural memory. **MemGPT** (arXiv:2310.08560, COLM 2025) introduces virtual memory management, treating the context window as RAM and external storage as disk.

<a id="競品分析的關鍵洞見"></a>
### Key findings from competitor analysis

Research into **30+ related projects** found:

Existing frameworks each cover part of the problem, but none integrates the full stack. **LangGraph** has the strongest graph state machines and checkpoint/time-travel debugging (126K+ GitHub stars), but no OS abstractions. **Claude Agent SDK** has the deepest MCP integration and a Brain/Hands separation, but no persistent memory layer. **Letta/MemGPT** has the OS metaphor and three-tier memory architecture, but addresses memory management rather than a whole OS. **CrewAI** has the most intuitive role-based agent abstraction (a minimal agent in ~35 lines), but lacks checkpoints and fine control. **Dify** (111K+ stars) has the best visual workflow UX, but serves “build AI apps for your users” rather than “AI manages your work.”

Useful patterns include Claude Agent SDK **lifecycle hooks** (18 interception events) and **advisor/executor model mixing** (60-70% token savings), LangGraph **reducer-based concurrent state merging** and **time-travel debugging**, OpenAI Swarm **Handoff-as-function-return** delegation, and Rivet **YAML graphs** for version-controlled agent logic.

---

<a id="模組-a記憶系統memory-kernel"></a>
## Module A: memory system (Memory Kernel)

Memory is Nous's central differentiator. **AI without memory is a tool. AI with memory is an assistant.**

<a id="三層記憶架構"></a>
### Three-tier memory architecture

Adapt MemGPT/Letta virtual memory for Claude's **1M token context window**:

**Tier 1: Working Memory** always resides in the context window, analogous to CPU cache. It contains the agent role (system prompt), core memory blocks (user preferences, identity, and important recent decisions), and current task context. Keep it below **~50K tokens** to leave room for dynamic content. Claude **prompt caching** charges once for writing, then 10% of the input price for subsequent reads.

**Tier 2: Dynamic/Retrieved Memory** enters context from external storage on demand, analogous to RAM. It includes RAG knowledge fragments, relevant conversation summaries, and task-related long-term memories. Use **composite scoring**: `Score = α × Recency + β × Importance + γ × Relevance(cosine)`. Recency decays exponentially (0.995/hour, reset on access). The LLM assigns Importance at creation (1-10). Relevance is cosine similarity to the current query.

**Tier 3: Archival/Persistent Memory** is long-term external database storage, analogous to disk. Separate **Episodic Memory** (raw conversation history stored by session, with progressive summary compression) from **Semantic Memory** (facts, entities, and relationships extracted from conversations and documents, stored structurally with metadata).

<a id="記憶操作機制"></a>
### Memory operations

**Memory creation** uses two paths. Passive extraction (Mem0 style) automatically extracts important conversation facts through ADD/UPDATE/DELETE/NOOP. Active access (MemGPT style) lets agents decide what to save through tool calls. Passive extraction maintains consistency. Active access handles cases requiring judgment.

**Forgetting** follows Ebbinghaus decay: `Recency_score = 0.995^(hours_since_creation)`. Successfully retrieved and used memories reset their decay timer and gain relevance. Mark memories below an `importance × recency` threshold for cleanup.

**Compression and consolidation** run in the background: raw conversation → session summary → fact extraction → compressed knowledge. An LLM arbitrates conflicting memories and creates temporal reflection summaries, such as “the user used React before November 2025, then switched to Vue.”

<a id="技術選型"></a>
### Technology choices

| Component | Recommendation | Reason |
|------|---------|------|
| Main database | SQLite + sqlite-vec (desktop) | No operations burden, ACID, vector search, single-file deployment |
| Vector index | sqlite-vec (SIMD accelerated) | 30MB memory footprint, KNN search, cos/L2/dot distances |
| Full-text search | SQLite FTS5 | Built in, no extra dependencies |
| Embedding model | OpenAI text-embedding-3-large | 3072 dimensions, highest quality, simple API |
| Context assembly | Claude prompt caching + custom code | Minimize token cost with native Claude features |

---

<a id="模組-b知識系統knowledge-base"></a>
## Module B: knowledge system (Knowledge Base)

<a id="攝取管線"></a>
### Ingestion pipeline

Use a **layered document strategy**. Firecrawl converts web content to clean Markdown. LlamaParse handles PDF/Office documents, including embedded images, complex tables, and handwriting. Index Markdown and plain text directly.

**Chunking** follows the largest 2026 benchmark (Vecta, Feb 2026): **recursive character splitting, 512 tokens, 15% overlap**. This simple approach achieved 69% accuracy, outperforming more expensive alternatives. Semantic chunking increased recall by 9% but produced fragments averaging 43 tokens, reducing answer quality. Add **contextual retrieval** later: prefix each chunk with its heading path and a short summary so it stands alone.

<a id="結構化與非結構化知識"></a>
### Structured and unstructured knowledge

Increase complexity gradually:

**Phase 1 (Month 3-4)**: Vector + keyword search. Embed document chunks into sqlite-vec and combine them with FTS5. Store metadata in SQLite tables (source, timestamp, confidence, and access count).

**Phase 2 (Month 7-8)**: Add a lightweight knowledge graph using SQLite entities and relationships tables with recursive CTE queries. Follow LazyGraphRAG: extract noun phrases with NLP to build a lightweight graph. Indexing costs **0.1%** of full GraphRAG (a 1000-fold reduction).

**Phase 3 (Month 11-12, if resources permit)**: Use Neo4j AuraDB Free for full graph queries, alongside three-mode retrieval (vectors + BM25 + graph traversal).

<a id="個人知識庫與工作知識庫分離"></a>
### Separate personal and work knowledge

Separate them directly in the file system:
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

Store knowledge as **Markdown files**, like Obsidian/Logseq, while SQLite indexes metadata, embeddings, and relationships. Users retain ownership because files remain readable and editable outside the app.

---

<a id="模組-cagent-編排系統agent-orchestrator"></a>
## Module C: agent orchestration (Agent Orchestrator)

<a id="多-agent-協作模式"></a>
### Multi-agent collaboration patterns

Nous supports four patterns, selected automatically by task complexity or explicitly by the user:

**Supervisor/Worker** (most common): A supervisor receives and decomposes a task, assigns specialist workers, and combines results. Implement it as a graph state machine with conditional supervisor edges routed by worker type.

**Handoff** (simple delegation): Follow OpenAI Swarm's minimal design. Returning another agent object from a function transfers control. This suits linear research → writing → proofreading pipelines.

**Swarm** (self-organization): Agents select and coordinate work by expertise without a central bottleneck. Suitable for exploration.

**Reflection** (quality assurance): A generator produces work, a critic assesses it, and a loop continues until quality meets the target. Use LangGraph's cyclic graph support.

<a id="sub-agent-生命週期管理"></a>
### Sub-agent lifecycle

Follow Claude Agent SDK `AgentDefinition`. Each sub-agent has its own system prompt, tools, and permissions. Its lifecycle is **create → initialize → execute → pause/resume → terminate**. Persist state through checkpoints.

**Persistence for long-running tasks** is a key architectural decision. **Temporal.io** is the recommended durable execution engine.

Temporal is the only durable workflow engine currently proven at large production scale (used by OpenAI Codex and Replit Agent 3). Its Workflow/Activity separation matches agent architecture: **Workflows** contain deterministic orchestration (agent decision loops), while **Activities** contain nondeterministic work (LLM calls, tools, and APIs). Temporal supplies automatic recovery, indefinite state persistence, human-in-the-loop signals, external state queries, and configurable retries.

**For a two-person team**, Temporal has a steep learning curve. Start **Phase 1 with SQLite checkpoints**, similar to LangGraph checkpointing. **Introduce Temporal in Phase 2 (Month 5-6)** for workflows that need durable long-running execution.

<a id="agent-間通訊協議"></a>
### Inter-agent communication

Use two protocols:

**MCP (Model Context Protocol)** handles agent → tool communication. An industry standard with **97M monthly SDK downloads** and 10,000+ servers, it is governed by the Linux Foundation's Agentic AI Foundation and supported by Anthropic, OpenAI, Google, and Microsoft.

**A2A (Agent-to-Agent Protocol)** handles agent → agent communication. Created by Google and supported by 150+ organizations, it describes capabilities with Agent Cards and supports asynchronous delegation. The protocols complement each other: MCP is “USB-C for AI,” and A2A is “HTTP for AI.”

<a id="工作流定義"></a>
### Workflow definitions

Use a **hybrid approach**. YAML/JSON defines topology and agent configuration, following Rivet's version-control-friendly YAML graphs. Python/TypeScript handles complex orchestration and conditional routing. This reflects CrewAI (YAML configuration + Python) and Microsoft Agent Framework (YAML → generated code).

---

<a id="模組-d工具連接器系統tool-runtime"></a>
## Module D: tools and connectors (Tool Runtime)

<a id="mcp-server-管理"></a>
### MCP server management

The MCP ecosystem contains **12,000+ servers**. Its official registry is `registry.modelcontextprotocol.io`. Add a **private registry layer**:

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

<a id="自定義工具開發框架"></a>
### Custom tool framework

Follow Claude Agent SDK `@tool` + `create_sdk_mcp_server()`. Custom tools run as **in-process MCP servers**, avoiding separate-process IPC overhead. Developers write a TypeScript/Python function and add a decorator to register an MCP tool.

<a id="沙盒與安全"></a>
### Sandboxing and security

The 2026 consensus is that Docker containers **cannot adequately isolate** untrusted AI-generated code. Use a **layered trust model**:

- **Trusted built-in tools** → hardened containers (Docker + seccomp).
- **Partly trusted third-party MCP servers** → gVisor (user-space kernel).
- **Untrusted AI-generated code** → WASM isolates (microsecond startup, capability-based sandbox).
- **Full shell requirements** → Firecracker microVMs (~125ms startup, full kernel isolation).

For a two-person team, start **Phase 1 with Docker + permission restrictions**. Introduce WASM isolation in Phase 2 as needed.

---

<a id="模組-eshell--人機介面"></a>
## Module E: shell and human interface

<a id="介面形態選擇"></a>
### Interface form

The comparison recommends a **Tauri desktop app (Rust shell + React frontend)**.

Key **Tauri 2.x advantages over Electron** are **3-10MB vs 100MB+** package size, **~30-40MB vs hundreds of MB** memory use, built-in capability security, and iOS/Android support in Tauri 2.0. More than 90% of the code can be TypeScript/React, Claude Code's strongest languages. Rust handles the native shell, largely through Tauri plugins.

Claude Code itself uses TypeScript + React (Ink), with **~90% of its code written by Claude Code**. This supports TypeScript + React as a strong distribution for AI pair programming.

<a id="介面設計"></a>
### Interface design

The latest shell is an **ambient brain desktop + temporary result surfaces**, described in [06](06_Ambient_Voice_Gaze_Experience.en.md).

- Standby displays only the animated brain. Users express needs by voice, select result regions with webcam gaze, and speak an action.
- Command Bar, Knowledge Panel, Agent Monitor, and Conversation Stream are on-demand capabilities rather than a permanent homepage.
- A Presentation Designer proposes presentations. A deterministic Presentation Policy checks the request source and visible scope.
- When users ask how work was done, show task steps, tool results, sources, and summaries. Technical traces remain in inspection tools.
- Voice and webcam selection of large regions are Alpha gates. TipTap/tldraw editing opens for the relevant task.

<a id="關鍵前端技術"></a>
### Frontend technologies

| Component | Recommendation | Reason |
|------|------|------|
| State management | Zustand + TanStack Query | Lightweight, TypeScript first |
| Rich-text editor | TipTap (ProseMirror based) | Best balance of developer experience and functionality, JSON/Markdown output |
| Canvas/whiteboard | tldraw SDK | React native, every element is a React component |
| LLM Streaming | Vercel AI SDK + custom SSE | Framework-independent streaming hooks |
| Markdown rendering | react-markdown + rehype/remark | Render AI responses |
| Styling | Tailwind CSS | Strongest Claude Code generation |

---

<a id="模組-f身份與安全"></a>
## Module F: identity and security

<a id="本地優先架構"></a>
### Local-first architecture

The core principle is **data never leaves the device unless the user explicitly enables sync**.

Store user data in local SQLite and Markdown. Keep API keys in native OS secure storage (macOS Keychain, Windows Credential Manager, Linux Secret Service), never plaintext configuration. Optionally encrypt SQLite with **SQLCipher** (transparent full-database encryption). Tauri's capability model requires explicit allowlists for every command/API.

<a id="權限模型"></a>
### Permission model

Three levels:

**System**: Control callable tools through `allowedTools`/`disallowedTools`. Allow reads by default. Writes/deletes require user confirmation, and destructive operations require a second confirmation.

**Agent**: Each agent has a separate scope. Research agents can read the web but cannot change local files. Writing agents can edit documents but cannot execute code.

**User**: On first tool use, show an authorization dialog and remember the choice. Sensitive actions (email, file deletion, and code execution) always require confirmation.

---

<a id="模組-g可觀測性與除錯"></a>
## Module G: observability and debugging

<a id="agent-行為追蹤"></a>
### Agent behavior tracing

Every operation produces structured **OpenTelemetry** logs (already used by Claude Desktop Enterprise). The trace chain is `User Request → Supervisor Decision → Agent Spawn → Tool Calls → Memory Operations → Response Assembly`.

<a id="token-消耗監控"></a>
### Token monitoring

Track input/output tokens per API call, prompt cache hit rate, cumulative cost per agent, and monthly trends in a live dashboard. Claude Agent SDK **advisor/executor model mixing** can save **60-70% of token costs**. Fast models (Haiku) handle routine work, and advanced models (Opus) intervene for deep reasoning.

<a id="除錯工具"></a>
### Debugging tools

Follow LangGraph **time-travel debugging**. Replay checkpoints, inspect state, and restart at any point. Record each agent step's inputs, outputs, and decision rationale as a timeline.

---

<a id="技術選型總覽"></a>
## Technology overview

<a id="完整技術堆疊"></a>
### Complete stack

| Layer | Choice | Reason |
|------|---------|------|
| **LLM** | Claude Opus 4.6 / Sonnet 4.6 | 1M context, compaction, highest MRCR v2 score 78.3% |
| **Main language** | TypeScript (~70%) | Claude Code uses TS+React, best on-distribution fit |
| **AI/ML language** | Python (~20%) | Full Anthropic SDK support, richest ML ecosystem |
| **Desktop shell** | Tauri 2.x (Rust ~10%) | 3MB package, 30MB memory, capability security |
| **Frontend framework** | React | Largest ecosystem, strongest Claude Code generation |
| **API layer** | tRPC v11 | No codegen, end-to-end type safety, TypeScript monorepos |
| **Main database** | SQLite (desktop) | No operations burden, ACID, single file, desktop standard |
| **Vector search** | sqlite-vec | SIMD acceleration, 30MB footprint, embedded in SQLite |
| **Full-text search** | SQLite FTS5 | Built in, no dependencies |
| **Embedding model** | OpenAI text-embedding-3-large | Highest quality, simple API |
| **Agent framework** | Claude Agent SDK + custom orchestrator | Deep MCP integration with an independent control layer |
| **Workflow engine** | Custom checkpoints → Temporal.io in Phase 2 | Gradual complexity |
| **Tool protocol** | MCP (Linux Foundation standard) | 97M monthly downloads, 12,000+ servers |
| **Monorepo** | pnpm workspaces | Simplest option, avoids over-engineering |
| **Build tools** | Bun (packaging) + Vite (development) | Claude Code uses Bun, best speed |
| **CI/CD** | GitHub Actions | Free for open source, AI review integration |

<a id="為何不選其他方案"></a>
### Reasons for rejecting alternatives

**Why not PostgreSQL?** A desktop app should not require users to install PostgreSQL. Use SQLite for desktop and consider PostgreSQL + pgvector for a future SaaS version.

**Why not Neo4j?** It is too complex for a local-first, single-user app. Use recursive SQLite CTEs and relationship tables for lightweight graphs, adding it in Phase 2 if needed.

**Why not LangGraph/LangChain?** Their dependency trees and learning curves are too large for two people. Borrow graph state machines and checkpointing, but implement a lightweight version with Claude Agent SDK.

**Why not Electron?** Its 100MB+ packages and high memory use compare poorly with Tauri. Claude Code itself validates the feasibility of TypeScript + React on Tauri.

<a id="預估月度基礎設施成本"></a>
### Estimated monthly infrastructure cost

| Item | Cost |
|------|------|
| Claude API (moderate use) | $50-200/month |
| OpenAI Embeddings API | $10-30/month |
| GitHub (CI/CD, hosting) | $0-20/month |
| Apple Developer Account | $99/year |
| **Total** | **~$70-260/month** |

---

<a id="產品差異化為何-nous-是os而非app"></a>
## Product differentiation: why Nous is an OS

<a id="與現有產品的本質差異"></a>
### Differences from existing products

**vs Claude Desktop / Cowork**: Claude Desktop is **session based**. Conversations start from scratch unless Projects are manually loaded. No persistent OS layer maintains cross-session state. Nous provides **growing memory and knowledge graphs**, first-class multi-agent orchestration, autonomous workflows beyond Routines, and cross-session learning.

**vs Cursor**: Cursor is a **coding IDE** ($500M ARR, June 2025). Nous is a **general knowledge-work OS** for research, writing, project management, and knowledge management. Cursor is a tool. Nous is a platform.

**vs Dify / LangGraph Studio**: These are **agent workflow builders** for creating AI apps for users. Nous instead has **AI manage your own work**. Dify = “Build AI apps for your users.” Nous = “AI manages your work.”

**vs Notion AI / Obsidian + AI**: These are **document-centered** tools with AI enhancements. They cannot proactively execute tasks, orchestrate agents, perceive other applications through MCP, or supply kernel abstractions for processes, memory, and I/O.

<a id="os-層vs應用層抽象"></a>
### OS-layer and application-layer abstractions

Nous's **OS abstractions** include memory management (forgetting, compression, recall), process scheduling (priorities, resources, context switching), unified I/O (MCP as a driver layer), and inter-process communication (agent protocols).

**Avoid rebuilding components**. Use Claude as the kernel, MCP for I/O, sqlite-vec for vector search, and TipTap for editing. Nous builds only the **integration layer** that assembles an OS.

---

<a id="12-個月開發時程"></a>
## 12-month development schedule

<a id="month-1-2奠基期"></a>
### Month 1-2: foundations

**Goal**: Complete the architectural prototype, verify technical feasibility, and establish development infrastructure.

**Month 1 deliverables**:
- Tauri 2.x + React desktop shell (windows, routing, tRPC).
- Claude Agent SDK integration (conversation streaming and tools).
- SQLite schemas (memory, knowledge, settings).
- CLAUDE.md and project conventions.
- Basic CLI (`nous chat`, `nous status`).
- **Demonstrable milestone**: A desktop app that talks to Claude and supports basic tool calls.

**Month 2 deliverables**:
- Context manager prototype (static/dynamic/conversation assembly).
- Prompt caching.
- Basic MCP management (2-3 built-in servers).
- Permission model v1 (tool authorization dialog).
- SQLite checkpoints.
- **Demonstrable milestone**: Conversations retain basic context across sessions and call MCP tools.

**Responsibilities**:
- Human: Architecture, Tauri setup, security model, UX.
- Claude Code: React components, tRPC routers, SQLite schemas, MCP code.

**Must-have**: Tauri shell, Claude SDK, SQLite, MCP connections.
**Nice-to-have**: CLI, multiple MCP servers.
**Risk**: Cross-platform WebView consistency. Test all three platforms early.
**Fallback**: Return to Electron if Tauri causes too many issues.

<a id="month-3-4mvp-記憶與知識系統"></a>
### Month 3-4: MVP memory and knowledge

**Goal**: Build a memory kernel and ingestion pipeline so the system remembers information.

**Month 3 deliverables**:
- Three memory tiers (Working/Dynamic/Archival).
- Passive fact extraction from conversations (Mem0 style).
- sqlite-vec integration.
- Embedding pipeline (text → OpenAI embedding → sqlite-vec).
- Composite retrieval scoring (Recency × Importance × Relevance).
- **Demonstrable milestone**: The next conversation remembers what you said.

**Month 4 deliverables**:
- Ingestion (Markdown, PDF, web → chunks → embeddings → index).
- Knowledge Panel (browse, search, filter).
- Active memory access (agent tools), forgetting (decay), and compression (background summaries).
- Separate episodic and semantic memory.
- **Demonstrable milestone**: Claude answers questions about imported documents accurately, with automatic memory management over time.

**Responsibilities**:
- Human: Memory architecture, scoring calibration, UX.
- Claude Code: Embedding pipeline, SQLite optimization, React UI, parsing.

**Must-have**: Three tiers, vector search, basic ingestion.
**Nice-to-have**: Compression, graph visualization.
**Risk**: Inconsistent memory quality. Create a 20-scenario evaluation benchmark and rerun it regularly.
**Fallback**: Integrate Mem0 SDK directly if a custom memory system is too complex.

<a id="month-5-6agent-編排與工具系統"></a>
### Month 5-6: agent orchestration and tools

**Goal**: Implement multi-agent collaboration and broad tool integration.

**Month 5 deliverables**:
- Supervisor/Worker orchestrator.
- Sub-agent lifecycle (create/run/pause/terminate).
- Inter-agent state transfer.
- 3-5 templates (research, writing, coding, summaries, scheduling).
- Agent Monitor (status, progress, interrupt).
- **Demonstrable milestone**: “Research X and write a report” automatically divides work among agents.

**Month 6 deliverables**:
- MCP manager UI (install/remove/configure).
- Custom tool framework (`@tool` → in-process MCP server).
- Gmail, GitHub, Notion, and Google Drive integrations through MCP.
- Workflow definitions v1 (YAML + TypeScript).
- Handoff pattern.
- **Demonstrable milestone**: “Organize today's email, answer urgent messages, and save summaries of the rest” completes automatically.

**Responsibilities**:
- Human: Agent architecture, tool permissions, workflow DSL.
- Claude Code: Orchestrator state machine, MCP, templates, UI.

**Must-have**: Basic multi-agent operation, MCP manager, 3+ external services.
**Nice-to-have**: Visual workflow editor, A2A.
**Risk**: Token costs can explode. Mix advisor/executor models (Haiku execution + Opus reasoning) and enforce budgets.
**Fallback**: Start with linear pipelines if orchestration is too complex.

<a id="month-7-8ui--shell-介面整合"></a>
### Month 7-8: UI and shell integration

**Goal**: Make the system pleasant as well as usable.

**Month 7 deliverables**:
- Full Dashboard redesign (Command Bar, Knowledge Panel, Agent Monitor, Conversation Stream).
- TipTap knowledge editing.
- Collapsible extended-thinking display.
- Dark/light themes.
- Keyboard shortcuts (global Cmd+K command bar).
- **Demonstrable milestone**: A polished desktop app with fluid AI interaction.

**Month 8 deliverables**:
- Lightweight entity-relationship graph visualization.
- tldraw canvas (visual thinking/knowledge maps).
- Token dashboard.
- Settings (API keys, agents, memory parameters).
- Automatic updates (Tauri updater plugin).
- **Demonstrable milestone**: A full second-brain experience combining knowledge visualization, AI operations, and tools.

**Responsibilities**:
- Human: UX/UI, visual quality, user tests.
- Claude Code: React polish, animations/transitions, tldraw, settings.

**Must-have**: Four-area Dashboard, rich-text editing, settings.
**Nice-to-have**: tldraw, graph visualization, dark theme.
**Risk**: Frontend work overruns. Prioritize the core workflow and defer visual details.
**Fallback**: Delay tldraw and graph visualization until after launch.

<a id="month-9-10整合測試與使用者試用"></a>
### Month 9-10: integration tests and user trials

**Goal**: Stabilize the system, collect feedback, and iterate rapidly.

**Month 9 deliverables**:
- End-to-end suite (100% core-flow coverage).
- Performance (startup < 3 seconds, first response token < 1 second).
- Memory stress tests (1000+ memories, 100+ documents).
- Security audit (key storage, permissions, sandbox effectiveness).
- Alpha packages (macOS .dmg, Windows .msi, Linux .AppImage).
- **Demonstrable milestone**: A stable version for 5-10 alpha testers.

**Month 10 deliverables**:
- Weekly alpha feedback collection and fixes.
- Feedback-based priorities.
- Start Getting Started and Architecture Guide documentation.
- Prepare a public GitHub repo and Discord server.
- Draft “Building an AI Operating System” blog series.
- **Demonstrable milestone**: Testers finish complete workflows without crashes.

**Responsibilities**:
- Human: Test coordination, interviews, priorities, docs/blog.
- Claude Code: Tests, bug fixes, optimization, documentation.

**Must-have**: Stable alpha, basic docs, feedback from 10 testers.
**Nice-to-have**: Automated test CI, performance benchmarks.
**Risk**: Feedback reveals architectural faults. Reserve 50% buffer for refactoring. If needed, narrow scope to memory and knowledge.
**Fallback**: Delay release one month to fix critical issues.

<a id="month-11-12打磨與發布"></a>
### Month 11-12: polish and release

**Goal**: Move from Alpha to Beta, build a community, and prepare public release.

**Month 11 deliverables**:
- Beta incorporating alpha feedback.
- Complete documentation site (Docusaurus or VitePress).
- Plugin/Agent SDK v1 for community agents and tools.
- Code signing/notarization (Apple notarization + Windows Authenticode).
- Open-source preparation (License, Contributing Guide, Code of Conduct).
- **Demonstrable milestone**: Installable Beta and full documentation site.

**Month 12 deliverables**:
- Public Beta (GitHub Release, website, community).
- Launch article/video (“Building Nous: The First Cognitive Operating System”).
- ProductHunt / Hacker News / Twitter launch strategy.
- Official Discord launch.
- Target 50-100 Beta users.
- Publish post-launch roadmap.
- **Demonstrable milestone**: A publicly downloadable Beta with an emerging active community.

**Responsibilities**:
- Human: Release strategy, community, marketing, PR/media.
- Claude Code: Docs, SDK, final fixes, automated packaging.

**Must-have**: Stable Beta, docs, public repo, basic community.
**Nice-to-have**: Plugin marketplace, demo video, 50+ users.
**Risk**: Timing and competition. Track Anthropic updates and maintain clear differentiation.
**Fallback**: Start with an invitation-only private beta if public release is premature.

---

<a id="發布與社群策略"></a>
## Release and community strategy

<a id="開源模式apache-20--open-core"></a>
### Open source: Apache 2.0 + Open Core

**Core engine** (Apache 2.0): kernel abstractions, memory, basic agents, MCP, CLI, and basic UI.

**Advanced features** (future commercial offering): collaboration, SSO/SAML, enterprise audits, analytics, and hosted cloud services.

This model has succeeded in AI open source, including Dify (Apache 2.0 + cloud), LangChain (MIT + LangSmith SaaS), and Langfuse (MIT + cloud). **Avoid BSL**. HashiCorp's license switch directly prompted OpenTofu, damaging community development prospects for a new project.

<a id="早期使用者招募策略"></a>
### Early user recruitment

Prioritize heavy Claude users → MCP developers → second-brain enthusiasts (Obsidian/Notion communities) → AI-native developers.

**Content marketing**: A “Building an AI OS” technical blog series on architecture and design philosophy, YouTube demos of real workflows, “How I replaced X tools with one Cognitive OS” case studies, and contributions to MCP ecosystem discussions.

**Community platforms**: Discord for real-time interaction (the AI open-source standard), GitHub Discussions for structured questions and feature requests, and X/Twitter for awareness.

---

<a id="風險評估與應對"></a>
## Risks and responses

<a id="技術風險"></a>
### Technical risks

**Claude API changes** (medium): Model/API updates can break integration. Isolate LLM calls behind adapters, test compatibility with the latest SDK, and consider alternative models later, although they are not a priority.

**MCP maturity** (low and falling): Linux Foundation governance, 97M monthly downloads, and support from major AI companies reduce risk, but server quality varies. Keep built-in core tools independent of third-party servers and create server quality ratings.

**SQLite scale** (low): sqlite-vec is sufficient for hundreds of thousands of documents. Abstract data storage for a future PostgreSQL + pgvector SaaS migration.

<a id="市場風險"></a>
### Market risks

**Anthropic's own products subsume the offering** (highest): Claude Desktop improvements, Cowork (GA March 2026), Routines, and MCP Apps narrow the gap. Focus on features Anthropic **will not build** (user-owned persistent memory/graphs, fully local-first operation, multi-agent orchestration, configurable OS abstractions). Position Nous as a layer above Claude: Claude is the kernel and Nous the complementary OS. Contribute to MCP for visibility and possible Anthropic interest, including its investment fund.

**Fast-moving competitors** (medium): OpenClaw grew from 9K to 188K stars in 60 days, demonstrating demand for open-source agents. A two-person team can respond through rapid iteration, releases, and community support.

<a id="執行風險"></a>
### Execution risks

**Scope for 2 people over 12 months** (highest): The full blueprint is extremely demanding. Apply **strict MVP discipline**:

**Essential core**: Claude kernel, three-tier memory, knowledge ingestion/retrieval, basic orchestration, MCP tools, desktop UI.

**Important but deferrable**: Knowledge graph visualization, tldraw, A2A, Temporal.io, and a visual workflow editor. Voice became an Alpha requirement on 2026-09-16. See 06–07.

**Post-v1**: Cloud sync, collaboration, plugin marketplace, mobile, enterprise features.

**Claude Code as a pair-programming multiplier** makes the schedule plausible. Its own TypeScript + React project demonstrates AI writing ~90% of code. Humans retain architecture and quality responsibility while Claude Code implements at scale. Encode decisions in CLAUDE.md, use Git worktrees for parallel work, and extend capabilities with Skills.

---

<a id="結論為什麼現在是對的時間"></a>
## Conclusion: why now

Three structural conditions make a Cognitive OS timely. **Claude's 1M context window + compaction** makes virtual memory management practical, allowing OS-like tiers without elaborate context manipulation. **MCP under Linux Foundation governance** makes tools a stable open infrastructure rather than vendor lock-in. **Knowledge workers waste 8.2 hours each week finding, recreating, and duplicating information**, a problem no product has addressed systematically at the OS layer.

Nous offers a **complete cognitive infrastructure layer**, making Claude a cognitive coprocessor that continuously manages knowledge, memory, and work, beyond better chat or workflow builders. AIOS, CoALA, and MemGPT identify this architectural gap, yet no mature product fills it. Twelve months with two people is difficult, but Claude Code's pair-programming multiplier and strict MVP discipline make the path realistic.
