<!-- bilingual: source=zh-TW -->

> [繁體中文](02_OSS_Component_Map.md) | [English](02_OSS_Component_Map.en.md)

<a id="nous-認知-os--開源元件對應表component-map"></a>
# Nous Cognitive OS: open-source component map

> **Reading guide, 2026-10-24**: See [implementation status](Current_Implementation_Status.en.md) for current code and gaps. See the [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) for value, dependencies, MVPs, and roadmaps. This document preserves early designs rather than implemented or accepted capabilities. Product constraints and G0–G3 follow [06](06_Ambient_Voice_Gaze_Experience.en.md), [07](07_Ambient_Implementation_and_Acceptance.en.md), and later explicit revisions. F0–F10 and Q0–Q4 do not replace those gates.
>
> The code baseline is `1f44c6b` (2026-10-23). The runnable prototype is in `prototype/ambient-shell`, using Node HTTP, SSE, TypeScript, Vite, and Electron. Tauri, React, a Python kernel, Agent SDK, long-term memory, and generated tools are target designs. Model, price, market, star, and ecosystem figures reflect the original writing date and were not rechecked in this update. Verify them before adoption.

> **Historical update, 2026-10-07**: See [08 §4.5 and §5](08_Consolidation_and_Update_2026-10.en.md) for the assessments and proposed changes to Letta, Langfuse, voice, and gaze candidates at that time. Those external states were not rechecked here. Proposals in 08 are not approved ADRs. This component map is not an installed dependency list.

> **Interaction specification update, 2026-09-16**: Ambient brain standby, no apps, voice first, webcam gaze selection, and on-demand presentation follow [06 experience specification](06_Ambient_Voice_Gaze_Experience.en.md) and [07 development and acceptance](07_Ambient_Implementation_and_Acceptance.en.md). Underlying designs remain. Old schedules and interfaces are historical references. 06–07 take precedence where they conflict.

> **Purpose**: Map every custom module in the 12-month blueprint to mature community OSS. Replace building from scratch with integration and a thin adapter layer to shorten delivery to 3 months.
>
> **Strategy levels**:
> - 🟢 **Integrate**: Use a dependency directly and write an adapter.
> - 🟡 **Fork**: Customize a fork as the core framework.
> - 🔵 **Reference**: Study patterns without taking a direct dependency.
> - ⚫ **Standard**: Follow industry protocols and specifications.

---

<a id="-頂層策略站在-khoj-肩上"></a>
## 🎯 Top-level strategy: build on Khoj

The most aggressive shortcut is **Khoj** as the starting point. This mature self-hosted AI second brain already has Web/Desktop/Obsidian/Emacs clients, ingestion, semantic search, custom agents, and scheduled automation. Transform it into a **Claude-native Cognitive OS** rather than rebuilding it.

| Component | Project | URL | Stars | License | Strategy |
|---|---|---|---|---|---|
| **Overall framework candidate** | khoj-ai/khoj | https://github.com/khoj-ai/khoj | 30K+ | AGPL-3.0 | 🟡 Fork or study deeply |

**⚠️ Note**: Khoj uses AGPL-3.0, requiring assessment before commercialization. An alternative is to borrow only its architecture and assemble MIT/Apache components. **This document follows that alternative.**

---

<a id="模組-a記憶系統memory-kernel"></a>
## Module A: memory system (Memory Kernel)

| Responsibility | OSS project | GitHub | Stars | License | Strategy | Main reason |
|---|---|---|---|---|---|---|
| **Agent memory (primary)** | letta-ai/letta | https://github.com/letta-ai/letta | 21.6K | Apache-2.0 | 🟢 Integrate | Official MemGPT successor. Three tiers (core/recall/archival) match the OS metaphor. One-command Docker startup, REST API, Python/TS SDKs, ADE GUI. |
| **Lightweight memory (alternative)** | mem0ai/mem0 | https://github.com/mem0ai/mem0 | 48K | Apache-2.0 | 🟢 Integrate | Largest community, simplest API, user/session/agent scopes, automatic conflict resolution, fastest onboarding. |
| **Combined memory and knowledge** | topoteretes/cognee | https://github.com/topoteretes/cognee | 15.1K | Apache-2.0 | 🔵 Reference | Graph + vector memory, NetworkX/FalkorDB/Neo4j support, possible later cognitive-memory upgrade. |
| **Embedded vector index** | asg017/sqlite-vec | https://github.com/asg017/sqlite-vec | 6K+ | Apache-2.0 | 🟢 Integrate | SIMD, 30MB footprint, embedded SQLite, the desktop choice. |
| **Embedding model** | OpenAI API / BAAI/bge-m3 | https://huggingface.co/BAAI/bge-m3 | - | MIT | 🟢 Integrate | Cloud `text-embedding-3-large`, local bge-m3 fallback. |

<a id="-本模組推薦組合"></a>
### 🎯 Recommended combination
**Phase 1 (Week 1-2)**: Run **Letta Docker** and connect Nous through its REST API. Saves 6-8 weeks of custom memory work.

---

<a id="模組-b知識系統knowledge-base"></a>
## Module B: knowledge system (Knowledge Base)

| Responsibility | OSS project | GitHub | Stars | License | Strategy | Main reason |
|---|---|---|---|---|---|---|
| **RAG + KG engine (primary)** | HKUDS/LightRAG | https://github.com/HKUDS/LightRAG | 32.8K | MIT | 🟢 Integrate | EMNLP 2025 paper, vector + knowledge graph retrieval, Web UI, Ollama-compatible interfaces, all backends deployable locally. |
| **General document parser** | docling-project/docling | https://github.com/docling-project/docling | 30K+ | MIT | 🟢 Integrate | IBM project under LF AI & Data. PDF/DOCX/PPTX/XLSX/HTML/audio/images, local and air-gapped operation. |
| **Documents → Markdown** | microsoft/markitdown | https://github.com/microsoft/markitdown | 50K+ | MIT | 🟢 Integrate | Microsoft, lightweight, simple API, suitable for general files in bulk. |
| **Web → Markdown** | mendableai/firecrawl | https://github.com/mendableai/firecrawl | 25K+ | AGPL-3.0/MIT | 🟢 Integrate (Cloud API) | Best clean Markdown from URLs, free quota. Self-hosted version is AGPL. |
| **High-quality PDF parsing (alternative)** | VikParuchuri/marker | https://github.com/VikParuchuri/marker | 25K+ | GPL-3.0 | 🔵 Reference | For GPU-based high accuracy, with GPL licensing risk. |
| **Knowledge graph builder (alternative)** | microsoft/graphrag | https://github.com/microsoft/graphrag | 20K+ | MIT | 🔵 Reference | For full GraphRAG if needed. LightRAG is usually sufficient. |

<a id="-本模組推薦組合-1"></a>
### 🎯 Recommended combination
- **Ingestion**: Docling (complex PDFs), MarkItDown (general files), Firecrawl (web).
- **Indexing + Retrieval**: LightRAG for both RAG and KG.
- The whole pipeline can run locally without cloud dependencies.

---

<a id="模組-cagent-編排系統agent-orchestrator"></a>
## Module C: agent orchestration (Agent Orchestrator)

| Responsibility | OSS project | GitHub | Stars | License | Strategy | Main reason |
|---|---|---|---|---|---|---|
| **Core agent SDK** | anthropics/claude-agent-sdk-python | https://github.com/anthropics/claude-agent-sdk-python | - | MIT | 🟢 Integrate | Official Anthropic SDK, deep MCP, first-class subagents, hooks, and permissions. |
| **Agent TS SDK** | anthropics/claude-agent-sdk-typescript | https://github.com/anthropics/claude-agent-sdk-typescript | - | MIT | 🟢 Integrate | Needed for direct frontend calls. |
| **Lightweight multi-agent orchestration** | openai/swarm | https://github.com/openai/swarm | 20K+ | MIT | 🔵 Reference | Minimal Handoff-as-return design. Study its approach. |
| **Advanced graph state machine** | langchain-ai/langgraph | https://github.com/langchain-ai/langgraph | 15K+ | MIT | 🔵 Reference | Borrow checkpoint/time-travel patterns. **Do not depend on all of LangChain.** |
| **Role-based agents (reference)** | crewAIInc/crewAI | https://github.com/crewAIInc/crewAI | 35K+ | MIT | 🔵 Reference | YAML agent configuration is useful, but dependencies are heavy. |
| **Durable workflows (later)** | temporalio/temporal | https://github.com/temporalio/temporal | 13K+ | MIT | 🟢 Integrate (Phase 2) | Durable long-running tasks, used by OpenAI Codex and Replit Agent 3. |

<a id="-本模組推薦組合-2"></a>
### 🎯 Recommended combination
Use Claude Agent SDK (Python backend + TS frontend) as the only agent framework. Read other projects for design ideas. **Do not introduce LangChain**. Its dependency tree would overwhelm the two-person schedule.

---

<a id="模組-d工具連接器系統tool-runtime--mcp"></a>
## Module D: tools and connectors (Tool Runtime, MCP)

<a id="mcp-核心基礎設施"></a>
### MCP infrastructure

| Responsibility | OSS project | GitHub | Strategy | Reason |
|---|---|---|---|---|
| **Official MCP Registry** | modelcontextprotocol/registry | https://github.com/modelcontextprotocol/registry | ⚫ Standard | Community server registry, API frozen at v0.1. |
| **Reference MCP servers** | modelcontextprotocol/servers | https://github.com/modelcontextprotocol/servers | 🟢 Integrate | Official reference servers. |
| **GitHub MCP Registry** | github.com/mcp | https://github.com/mcp | ⚫ Standard | Official GitHub registry. |
| **Awesome MCP Servers** | punkpeye/awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | 🔵 Reference | Most complete community list. |
| **Awesome MCP (alternative)** | appcypher/awesome-mcp-servers | https://github.com/appcypher/awesome-mcp-servers | 🔵 Reference | Another quality list. |
| **Self-hosted gateway/registry** | toolsdk-ai/toolsdk-mcp-registry | https://github.com/toolsdk-ai/toolsdk-mcp-registry | 🔵 Reference | Self-hosted registry of 4547+ servers. |

<a id="必裝的-mcp-servers首發內建"></a>
### Required launch MCP servers

| Purpose | MCP Server | GitHub | Notes |
|---|---|---|---|
| File system | @modelcontextprotocol/server-filesystem | modelcontextprotocol/servers | Official reference |
| Git/GitHub | github-mcp-server | https://github.com/github/github-mcp-server | Official GitHub |
| Gmail | gongrzhe/server-gmail-autoauth-mcp | Search GitHub for “gmail mcp” | Automatic OAuth authorization |
| Notion | makenotion/notion-mcp-server | https://github.com/makenotion/notion-mcp-server | Official Notion |
| Google Drive | google-gemini/gdrive-mcp-server | Search GitHub for “gdrive mcp” | Google ecosystem |
| Browser automation | executeautomation/playwright-mcp-server | https://github.com/microsoft/playwright-mcp | Official Microsoft |
| Slack | modelcontextprotocol/servers/slack | modelcontextprotocol/servers | Official reference |
| Web retrieval | mendableai/firecrawl-mcp-server | https://github.com/mendableai/firecrawl-mcp-server | Official Firecrawl |

<a id="-本模組推薦組合-3"></a>
### 🎯 Recommended combination
**Build no connectors ourselves.** Use MCP for every integration and one-click installation from the official registry. Nous builds only the **MCP Server Manager UI** for discovery, installation, authorization, and audit logs.

---

<a id="模組-eshell--人機介面ui"></a>
## Module E: shell and human interface (UI)

<a id="桌面-shell"></a>
### Desktop shell

| Responsibility | OSS project | GitHub | Stars | License | Strategy |
|---|---|---|---|---|---|
| **Desktop framework** | tauri-apps/tauri | https://github.com/tauri-apps/tauri | 80K+ | MIT/Apache-2.0 | 🟢 Integrate |
| **Tauri + shadcn starter** | agmmnn/tauri-ui | https://github.com/agmmnn/tauri-ui | 1K+ | MIT | 🟡 Fork |
| **Tauri v2 + React 19 template** | kitlib/tauri-app-template | https://github.com/kitlib/tauri-app-template | - | - | 🔵 Reference |

<a id="ai-chat-ui-元件"></a>
### AI chat UI components

2026-09-16 update: Use these for on-demand conversations and results. Do not make a ready-made chat template the homepage. The brain, Voice Session, GazeProvider, FocusResolver, and Presentation Policy are new shell integration responsibilities. See [06 §4](06_Ambient_Voice_Gaze_Experience.en.md#4-webcam-視線互動) for gaze candidates, calibration limitations, and official sources. Choose dependencies after a PoC.

| Responsibility | OSS project | GitHub | Stars | License | Strategy |
|---|---|---|---|---|---|
| **Primary AI chat UI** | assistant-ui/assistant-ui | https://github.com/assistant-ui/assistant-ui | 5K+ | MIT | 🟢 Integrate |
| **AI SDK (streaming)** | vercel/ai | https://github.com/vercel/ai | 10K+ | Apache-2.0 | 🟢 Integrate |
| **Vercel Chatbot template** | vercel/chatbot | https://github.com/vercel/chatbot | - | - | 🔵 Reference |

<a id="富文字--畫布--markdown"></a>
### Rich text, canvas, and Markdown

| Responsibility | OSS project | GitHub | Stars | License | Strategy |
|---|---|---|---|---|---|
| **Rich-text editor** | ueberdosis/tiptap | https://github.com/ueberdosis/tiptap | 25K+ | MIT | 🟢 Integrate |
| **Whiteboard/canvas** | tldraw/tldraw | https://github.com/tldraw/tldraw | 35K+ | Apache-2.0 (commercial license required) | 🟢 Integrate (check commercial terms) |
| **Markdown rendering** | remarkjs/react-markdown | https://github.com/remarkjs/react-markdown | 13K+ | MIT | 🟢 Integrate |
| **UI library** | shadcn-ui/ui | https://github.com/shadcn-ui/ui | 70K+ | MIT | 🟢 Integrate |

<a id="狀態管理--資料層"></a>
### State and data

| Responsibility | OSS project | GitHub | Stars | License | Strategy |
|---|---|---|---|---|---|
| **State management** | pmndrs/zustand | https://github.com/pmndrs/zustand | 45K+ | MIT | 🟢 Integrate |
| **Data queries** | TanStack/query | https://github.com/TanStack/query | 42K+ | MIT | 🟢 Integrate |
| **End-to-end typed API** | trpc/trpc | https://github.com/trpc/trpc | 35K+ | MIT | 🟢 Integrate |

<a id="-本模組推薦組合-4"></a>
### 🎯 Recommended combination
**Fork `agmmnn/tauri-ui`**, embed `assistant-ui`, build Command Bar, Knowledge Panel, and Agent Monitor with shadcn/ui, then add TipTap editing and tldraw visualization. Saves **3-4 weeks of UI setup**.

---

<a id="模組-f身份與安全"></a>
## Module F: identity and security

| Responsibility | OSS project | GitHub | Strategy | Reason |
|---|---|---|---|---|
| **Native OS keychain** | Tauri keyring plugin | https://github.com/tauri-apps/plugins-workspace | 🟢 Integrate | Unified API for macOS Keychain, Windows Credential Manager, and Linux Secret Service. |
| **SQLite encryption** | sqlcipher/sqlcipher | https://github.com/sqlcipher/sqlcipher | 🟢 Integrate | Transparent full-database encryption. |
| **OAuth** | panva/openid-client | https://github.com/panva/openid-client | 🟢 Integrate | Third-party service OAuth. |
| **Advanced sandbox** | firecracker-microvm | https://github.com/firecracker-microvm/firecracker | 🔵 Reference | For later execution of AI-generated code. |

---

<a id="模組-g可觀測性與除錯"></a>
## Module G: observability and debugging

| Responsibility | OSS project | GitHub | Stars | License | Strategy |
|---|---|---|---|---|---|
| **Primary LLM tracing/evaluation** | langfuse/langfuse | https://github.com/langfuse/langfuse | 25K+ | MIT | 🟢 Integrate |
| **Alternative LLM observability** | Arize-ai/phoenix | https://github.com/Arize-ai/phoenix | 5K+ | Elastic v2 | 🔵 Reference |
| **Automatic OTel instrumentation** | traceloop/openllmetry | https://github.com/traceloop/openllmetry | 6K+ | Apache-2.0 | 🟢 Integrate |

<a id="-本模組推薦組合-5"></a>
### 🎯 Recommended combination
Start Langfuse Docker and push spans from Claude Agent SDK hooks. Tokens, cost, tracing, and evaluation are covered together. Saves **2-3 weeks of dashboard development**.

---

<a id="完整依賴總覽表top-of-mind"></a>
## Complete dependency overview (Top of Mind)

| Layer | Project | GitHub | Role | Estimated time saved |
|---|---|---|---|---|
| Shell | agmmnn/tauri-ui | https://github.com/agmmnn/tauri-ui | Desktop shell + shadcn starter | 3 weeks |
| Shell | assistant-ui/assistant-ui | https://github.com/assistant-ui/assistant-ui | Chat UI primitives | 2 weeks |
| Kernel | anthropics/claude-agent-sdk-* | https://github.com/anthropics | Agent engine | Included |
| Memory | letta-ai/letta | https://github.com/letta-ai/letta | Three-tier memory OS | 8 weeks |
| Knowledge | HKUDS/LightRAG | https://github.com/HKUDS/LightRAG | RAG + KG | 6 weeks |
| Ingestion | docling-project/docling | https://github.com/docling-project/docling | PDF/Office parsing | 2 weeks |
| Ingestion | microsoft/markitdown | https://github.com/microsoft/markitdown | General files → Markdown | 1 week |
| Ingestion | mendableai/firecrawl | https://github.com/mendableai/firecrawl | Web crawling | 1 week |
| Tools | modelcontextprotocol/registry | https://github.com/modelcontextprotocol/registry | MCP discovery | 4 weeks |
| Tools | modelcontextprotocol/servers | https://github.com/modelcontextprotocol/servers | Built-in tools | 2 weeks |
| DB | asg017/sqlite-vec | https://github.com/asg017/sqlite-vec | Vector index | 2 weeks |
| Obs | langfuse/langfuse | https://github.com/langfuse/langfuse | Tracing/evaluation | 3 weeks |
| Editor | ueberdosis/tiptap | https://github.com/ueberdosis/tiptap | Rich-text editing | 2 weeks |
| Canvas | tldraw/tldraw | https://github.com/tldraw/tldraw | Canvas | 3 weeks |
| UI Kit | shadcn-ui/ui | https://github.com/shadcn-ui/ui | Component library | 2 weeks |
| State | pmndrs/zustand | https://github.com/pmndrs/zustand | State | - |
| API | trpc/trpc | https://github.com/trpc/trpc | Type safety | - |

**Estimated total saved**: ~**41 weeks**, reducing 12 months to **~3 months** ✅

---

<a id="授權風險備忘"></a>
## Licensing risk notes

| Project | License | Risk | Mitigation |
|---|---|---|---|
| Khoj | **AGPL-3.0** | Forking the app requires releasing derivatives. | Borrow architecture only. |
| Self-hosted Firecrawl | AGPL-3.0 | Same as above. | Use Cloud API (MIT) or an alternative. |
| Marker | GPL-3.0 | Same as above. | Replace with Docling (MIT). |
| tldraw SDK | Apache-2.0 with watermark | Commercial license purchase required. | Accept watermark in MVP, license commercially later. |
| Letta | Apache-2.0 | ✅ Safe | — |
| LightRAG | MIT | ✅ Safe | — |
| Docling | MIT | ✅ Safe | — |
| MarkItDown | MIT | ✅ Safe | — |
| Langfuse | MIT | ✅ Safe | — |
| assistant-ui | MIT | ✅ Safe | — |

**Overall recommendation**: **Apache-2.0 + avoid all AGPL/GPL dependencies** to preserve future commercial flexibility.

---

<a id="不使用清單避免誘惑"></a>
## Do not use

| Project | Reason |
|---|---|
| LangChain | Excessive dependencies and learning curve for two people. |
| LlamaIndex | Same, and conflicts with the lightweight strategy. |
| Dify / Flowise | Build AI apps for others rather than have AI manage your work. |
| AutoGen | Microsoft-oriented, costly to learn, weaker Claude integration than Claude Agent SDK. |
| PostgreSQL + pgvector (Phase 1) | Desktop users should not install Postgres. Reconsider for cloud in Phase 2. |
| Neo4j (Phase 1) | Too heavy for one user. LightRAG already supports KG. |
| Electron | 100MB+ packages and excessive memory, outperformed by Tauri. |

---

<a id="核心洞察"></a>
## Core insight

**Mature OSS already covers 80% of the blueprint's modules.** Our work is:

1. **Choose** one primary and one alternative per module.
2. **Integrate** them through adapters.
3. **Differentiate** through integration logic and user experience, Nous's core value.
4. **Do not rebuild** mature projects with 10K+ stars when integration is possible.

**Nous's value is assembling these components into a coherent Cognitive OS coordinated by Claude as kernel, rather than inventing a new memory system or RAG.**
