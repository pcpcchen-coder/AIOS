<!-- bilingual: source=zh-TW -->

> [繁體中文](05_Progress_and_Next_Steps.md) | [English](05_Progress_and_Next_Steps.en.md)

<a id="nous-認知-os--完整進度彙總與下一階段規劃"></a>
# Nous Cognitive OS: complete progress review and next-stage planning

> **Reading guide, 2026-10-24**: This is a historical September 2026 design snapshot. Read [implementation status](Current_Implementation_Status.en.md) for today's code, completion boundaries, and gaps, and the [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) for priorities. “Current,” “next,” percentages, and months below refer to the original snapshot, not today's schedule or progress. External model, price, market, and project figures were not rechecked here.
>
> At code baseline `1f44c6b` (2026-10-23), the repo already has a runnable `prototype/ambient-shell`, voice paths, task/artifact persistence, sensing, and Electron. Their existence does not pass G0–G3 or establish complete long-term memory, calibrated eye tracking, or agent orchestration.

> **Interaction update, 2026-09-16**: Ambient brain standby, no apps, voice first, webcam gaze pointing, and on-demand results follow [06](06_Ambient_Voice_Gaze_Experience.en.md) and [07](07_Ambient_Implementation_and_Acceptance.en.md). Underlying designs remain. Old schedules/interfaces are historical. 06–07 take precedence where they conflict.

> **Purpose**: Review all thinking, decisions, and deliverables since project inception, then identify areas to deepen and expand.
>
> **Milestone at this snapshot**: Four core design documents completed. The project has moved from concept to executable blueprint and is ready to start implementation.

---

<a id="2026-09-16-歷史增補"></a>
## Historical addendum, 2026-09-16

- **New baseline**: Animated brain wallpaper, no apps, voice first, webcam gaze pointing, on-demand results. See [06](06_Ambient_Voice_Gaze_Experience.en.md).
- **Completed documents**: Contracts, prompts, eight work batches, hand-calculable cases, hardware acceptance. See [07](07_Ambient_Implementation_and_Acceptance.en.md).
- **Implementation then incomplete**: No runnable desktop, voice, gaze, or agent E2E tests on 2026-09-16. This no longer describes today's prototype.
- **Next step then**: PR-01–02, followed by G1/G2. Today, inspect the prototype and acceptance gaps before starting. Do not rebuild existing brain/task flows.
- **Revised decisions**: Voice is no longer deferred. Permanent dashboards/skill sidebars become on-demand surfaces. Re-estimate the 12-week schedule.

<a id="part-1從啟動到現在的完整軌跡"></a>
## Part 1 | Complete trajectory

<a id="11-專案起源"></a>
### 1.1 Project origin

**George's original proposition**:
> Human interaction with hardware began at hardware and firmware, then combined them into an OS for people to operate. But that OS is for people! I want an OS specifically for Claude!

The breakthrough is moving AI from the application layer into the OS kernel. Existing products such as Claude Desktop, Cursor, and ChatGPT occupy the app layer. Nobody builds the OS layer.

<a id="12-方向收斂的三次關鍵選擇"></a>
### 1.2 Three decisions that narrowed the direction

**Choice 1**: Agentic OS, Cognitive OS, or a combination.
- **Decision**: **Cognitive OS**.
- **Reason**: Claude operates knowledge, memory, and workflows as kernel, rather than hardware. This deeper abstraction is a market gap.

**Choice 2**: Personal workstation, EMS edge, or general product.
- **Decision**: **General product**.
- **Reason**: Address the large knowledge-worker market without a domain restriction.

**Choice 3**: Sprint, steady development, or long-term effort.
- **Decision**: First **12 months**, then **3-month Alpha** through OSS integration.
- **Reason**: Two people, Claude Code pair programming, and strict MVP discipline can achieve it.

<a id="13-四份核心文件的演進"></a>
### 1.3 Evolution of the four documents

```
文件 1: Cognitive OS 完整藍圖 (12 個月)
    ↓
文件 2: OSS 元件對應表
    ↓  (發現社群已有 80% 的模組)
文件 3: 3 個月加速路徑
    ↓  (壓縮時程的具體計畫)
文件 4: 生成式互動系統
    ↓  (揭露 UI 的終極形態——無固定 UI)
```

---

<a id="part-2已完成的四份核心設計文件詳細盤點"></a>
## Part 2 | Detailed inventory of four completed designs

<a id="-文件-1cognitive-os-完整技術藍圖與-12-個月開發時程"></a>
### 📄 Document 1: complete Cognitive OS blueprint and 12-month schedule

**Role**: The project's comprehensive constitution, architecture decisions, and theory.

<a id="11-產品命名候選6-個"></a>
#### 1.1 Six naming candidates
| Name | Origin | Rating |
|---|---|---|
| **Nous** | Greek νοῦς (mind/intellect) | ⭐⭐⭐⭐⭐ Primary |
| Thymos | Greek θυμός (will) | ⭐⭐⭐⭐ Alternative |
| Meld | English (merge) | ⭐⭐⭐ |
| Phren | Greek φρήν (mind) | ⭐⭐⭐ |
| Anima | Latin (soul) | ⭐⭐⭐ |
| Kernel | OS metaphor | ⭐⭐ |

**Final choice: Nous**. Short, philosophically meaningful, suitable for CLI commands (`nous run`).

<a id="12-os-抽象層級映射9-層對應"></a>
#### 1.2 Nine OS abstraction mappings
| Traditional OS | Nous Cognitive OS | Implementation |
|---|---|---|
| Kernel | Claude API | Anthropic Claude Opus/Sonnet 4.6 |
| Memory | Three memory tiers | SQLite + sqlite-vec |
| File System | Semantic knowledge base | Markdown + vector index |
| Process | Agent/Workflow | Claude Agent SDK |
| Scheduler | Agent Orchestrator | Graph state machine + Temporal |
| Shell | Natural language | React + TipTap + tldraw |
| IPC | MCP + A2A | Industry standards |
| Driver | Tool/Connector | MCP Servers |
| User Space | Specialist agents | Research/writing/coding |

<a id="13-學術基礎3-篇關鍵論文"></a>
#### 1.3 Three academic foundations
- **AIOS** (Rutgers, COLM 2025): rigorous LLM-as-kernel definition.
- **CoALA** (TMLR 2024): links LLM agents to ACT-R/Soar cognitive architectures.
- **MemGPT** (arXiv:2310.08560, COLM 2025): virtual memory management.

<a id="14-七大核心模組設計"></a>
#### 1.4 Seven core modules

**Module A: Memory Kernel**
- Working (~50K tokens in context), Dynamic (retrieved), Archival (persistent).
- Composite score: `Score = α×Recency + β×Importance + γ×Relevance`.
- Passive extraction (Mem0) + active access (MemGPT).
- Ebbinghaus forgetting: `Recency = 0.995^hours`.

**Module B: Knowledge Base**
- Firecrawl (web), LlamaParse (PDF), direct Markdown indexing.
- Recursive character chunks, 512 tokens, 15% overlap (2026 benchmark winner).
- Vector search → lightweight graph → full GraphRAG.
- File-system separation of personal/work knowledge.

**Module C: Agent orchestration**
- Supervisor/Worker, Handoff, Swarm, Reflection.
- Lifecycle: create → run → pause → terminate.
- Temporal.io durability in Phase 2.
- MCP tools + A2A inter-agent communication.

**Module D: Tools/connectors**
- MCP Registry + private layer.
- `@tool` + in-process MCP server.
- Layered trust: Docker (built-ins), gVisor (third party), WASM (generated code), Firecracker (shell).

**Module E: Shell/human interface**
- Tauri 2.x (3-10MB vs Electron 100MB+).
- Brain standby with on-demand Command Bar, knowledge, progress, conversation, and results.
- Voice intent, calibrated webcam pointing, spoken action confirmation.
- TipTap rich text + tldraw canvas.

**Module F: Identity/security**
- Local first.
- System/agent/user permissions.
- Native keychain + SQLCipher.

**Module G: Observability**
- OpenTelemetry traces.
- Advisor/Executor mixing saves 60-70% tokens.
- Time-travel debugging.

<a id="15-技術選型總覽"></a>
#### 1.5 Stack overview
| Layer | Technology |
|---|---|
| LLM | Claude Opus/Sonnet 4.6 |
| Languages | TypeScript (~70%) + Python (~20%) + Rust (~10%) |
| Desktop | Tauri 2.x |
| Frontend | React + shadcn/ui |
| API | tRPC v11 |
| DB | SQLite + sqlite-vec + FTS5 |
| Agent | Claude Agent SDK + custom orchestrator |
| Monorepo | pnpm workspaces |
| CI | GitHub Actions |

<a id="16-月度成本估算"></a>
#### 1.6 Monthly cost estimate
- Claude API: $50-200/month.
- Embeddings: $10-30/month.
- Other: $0-30/month.
- **Total: $70-260/month**.

<a id="17-12-個月時程6-階段"></a>
#### 1.7 Six phases over 12 months
1. Month 1-2: Foundations (Tauri, Claude SDK, SQLite).
2. Month 3-4: MVP memory/knowledge.
3. Month 5-6: Orchestration/tools.
4. Month 7-8: UI/shell.
5. Month 9-10: Integration/Alpha.
6. Month 11-12: Polish/Beta.

<a id="18-風險評估"></a>
#### 1.8 Risks
- **Highest**: Anthropic products (Claude Desktop/Cowork) cover the offering.
- **Response**: Persistent memory, local-first, multi-agent OS abstractions, positioned as a layer above Claude rather than a competitor.

---

<a id="-文件-2oss-元件對應表"></a>
### 📄 Document 2: OSS component map

**Role**: Map custom modules to mature community projects and shift to integration.

<a id="21-策略分級"></a>
#### 2.1 Strategy levels
- 🟢 Integrate dependencies directly.
- 🟡 Fork and customize deeply.
- 🔵 Reference design patterns.
- ⚫ Follow industry standards.

<a id="22-頂層策略發現"></a>
#### 2.2 Top-level finding
**Khoj** (30K+ stars, AGPL-3.0) is a complete self-hosted second brain with 70% feature overlap. Because AGPL has strong derivative obligations, **borrow its architecture without forking**.

<a id="23-模組對應的關鍵發現"></a>
#### 2.3 Main component findings

**Memory**:
- **Letta** (21.6K⭐, Apache-2.0): official MemGPT successor, three tiers align with the OS metaphor.
- Mem0 (48K⭐, Apache-2.0): largest community, simplest API, alternative.
- Cognee (15.1K⭐): graph + vector, later upgrade candidate.

**Knowledge**:
- **LightRAG** (32.8K⭐, MIT): EMNLP 2025, vector + KG retrieval, Web UI.
- **Docling** (30K+⭐, MIT): IBM, LF AI governance, all major formats.
- **MarkItDown** (50K+⭐, MIT): Microsoft, lightweight.

**Orchestration**:
- **Claude Agent SDK** (Python + TS): official Anthropic, sole framework choice.
- LangGraph, CrewAI, and Swarm are design references only.

**Tools**:
- **Official MCP Registry**, API frozen at v0.1.
- **GitHub MCP Registry**, github.com/mcp.
- 4547+ community servers.

**UI**:
- Fork **agmmnn/tauri-ui** (saves 3 weeks).
- **assistant-ui** (5K⭐, MIT), chat primitives.
- **shadcn/ui** (70K+⭐), components.
- **TipTap** (25K+⭐), rich text.
- **tldraw** (35K+⭐), canvas with commercial licensing, watermark acceptable for MVP.

**Observability**:
- **Langfuse** (25K+⭐, MIT): Docker, token/trace/eval coverage.

<a id="24-估計節省時間"></a>
#### 2.4 Estimated time savings
| Module | Weeks saved |
|---|---|
| Shell | 3 |
| Chat UI | 2 |
| Memory | 8 |
| Knowledge | 6 |
| Ingestion | 3-4 |
| MCP tools | 6 |
| Vector index | 2 |
| Observability | 3 |
| Editor | 2 |
| Canvas | 3 |
| **Total** | **~41 weeks** |

**This makes 12 months → 3 months possible.**

<a id="25-授權風險矩陣"></a>
#### 2.5 License risk matrix
| Project | License | Risk | Mitigation |
|---|---|---|---|
| Khoj | AGPL-3.0 | High (derivative obligations) | Do not fork. |
| Self-hosted Firecrawl | AGPL-3.0 | High | Cloud API. |
| Marker | GPL-3.0 | High | Docling. |
| tldraw SDK | Apache + watermark | Medium | Commercial license later. |
| Letta/LightRAG/Docling/MarkItDown/Langfuse | MIT/Apache | ✅ | — |

**Product license: Apache-2.0, avoiding AGPL/GPL.**

<a id="26-不使用清單避免誘惑"></a>
#### 2.6 Excluded projects
| Project | Reason |
|---|---|
| LangChain | Excessive dependencies |
| LlamaIndex | Conflicts with lightweight strategy |
| Dify/Flowise | Opposite positioning |
| AutoGen | Weak Claude integration |
| PostgreSQL | Unsuitable for desktop |
| Neo4j | Too heavy for one user |
| Electron | Outperformed by Tauri |

---

<a id="-文件-33-個月加速路徑"></a>
### 📄 Document 3: three-month accelerated roadmap

**Role**: Actionable weekly plan.

<a id="31-三個月節奏"></a>
#### 3.1 Three-month cadence
```
Month 1: Assemble ─── 組裝五大引擎,跑通 E2E
Month 2: Integrate ── 補完 Agent 編排與 MCP
Month 3: Polish ───── UX 打磨,Alpha 釋出
```

<a id="32-month-1week-1-4assemble"></a>
#### 3.2 Month 1 (Week 1-4): Assemble

**Week 1: Infrastructure**
- Fork agmmnn/tauri-ui.
- Monorepo (apps/desktop, apps/kernel, packages/shared, packages/agents, docker/).
- Docker Compose with Letta, LightRAG, Langfuse.
- CLAUDE.md.

**Week 2: Memory**
- Letta REST API.
- assistant-ui stream.
- Langfuse instrumentation.
- **Milestone: Claude with cross-session memory**.

**Week 3: Knowledge**
- Docling, MarkItDown, Firecrawl.
- LightRAG dual-level retrieval.
- Knowledge browser.
- **Milestone: PDF imports and accurate Claude answers**.

**Week 4: End-to-end**
- Letta + LightRAG + Claude.
- `@tool` definitions.
- Authorization dialog.
- **Month 1 milestone: working E2E flow**.

<a id="33-month-2week-5-8integrate"></a>
#### 3.3 Month 2 (Week 5-8): Integrate

**Week 5: Orchestration**. Research/Writer/Summarizer agents and supervisor routing.
**Week 6: MCP**. Server Manager and filesystem/github/gmail/notion/playwright.
**Week 7: Knowledge UI**. Panel, graph, personal/work separation, Command Bar.
**Week 8: Observability**. Full Langfuse, token dashboard, checkpoints.

<a id="34-month-3week-9-12polish"></a>
#### 3.4 Month 3 (Week 9-12): Polish

**Week 9: UX**. TipTap, themes, shortcuts, performance.
**Week 10: Security**. Keyring, settings, three permission levels, backups.
**Week 11: Stability**. E2E, stress tests, cross-platform packaging.
**Week 12: Release**. Docs, landing page, blog, Discord, **Private Alpha for 5-10 people**.

<a id="35-3-個月-vs-12-個月取捨15-項功能決策"></a>
#### 3.5 Three-month vs 12-month tradeoffs (15 feature decisions)
Cut custom memory, graph, parsing, chat UI, Tauri shell, MCP connectors, observability dashboard, Temporal.io, cloud sync, mobile, marketplace, and commercial preparation.

Keep the core loop (memory + knowledge + agents + MCP + UI). On 2026-09-16, brain standby, voice, and webcam gaze became Alpha gates. Replan the old weeks below.

<a id="36-五個成功因子"></a>
#### 3.6 Five success factors
1. Integration first.
2. Claude Code productivity (CLAUDE.md, worktrees, skills).
3. Friday demos and public development.
4. Cut scope before adding.
5. Alpha users provide real feedback.

---

<a id="-文件-4生成式互動系統設計"></a>
### 📄 Document 4: generative interaction design

**Role**: Nous's eventual **non-fixed UI**, with AI generating tools and presentation for each intent.

<a id="41-典範轉移"></a>
#### 4.1 Paradigm shift
| Dimension | Application centered (old) | Intent centered (new) |
|---|---|---|
| Learning | People learn apps | AI learns people |
| UI lifetime | Permanent | Temporary |
| Designer | Human | AI for this interaction |
| Capability limits | App-defined | All composable capabilities |
| Presentation | Fixed | Dynamic |

<a id="42-五大設計原則"></a>
#### 4.2 Five principles
1. **Intent over Application**: Ask goals, not tools.
2. **Presentation is a Design Deliverable**: Design how content is perceived.
3. **Tool as Answer**: Generate tools for complex questions.
4. **Cognitive Fit**: Multimedia learning, cognitive load, personal profiles.
5. **Ephemeral by Default**: Avoid UI growth.

<a id="43-六層系統架構"></a>
#### 4.3 Six-layer architecture
```
L1: 意圖理解層 (Intent Parser)
L2: 能力圖譜 + 認知輪廓 + 情境記憶(三源輸入)
L3: 呈現設計師 Agent (Presentation Designer)
L4: 生成執行層 (Generative Runtime)
L5: 呈現層 (Rendering Surface)
L6: 晉升管線 (Skill Promotion)
```

<a id="44-六個核心子系統"></a>
#### 4.4 Six subsystems

**Intent Parser**: Structured goal_type, domain, deliverable, audience, expected_form.

**Capability Graph**: Structured hardware/tools/APIs across Hardware, Software, External, Knowledge, Memory.

**Cognitive Profile**: modality_preference, density, disclosure, expertise, time_preferences.
- First 10 interactions offer choices.
- Observe reading/scrolling/clicks.
- Ask once every 20 interactions.
- Load formula: `load = complexity × density - modality_match - expertise + interaction_cost`.

**Presentation Designer**: Central sub-agent producing presentation_mode, primary_artifact, disclosure_layers, interaction_affordances, adaptability.

**Generative Runtime paths**:
- A: Text/Markdown content.
- B: React/SVG in sandboxes.
- C: Complete Python/TS + UI + schedule.

**Skill Promotion Pipeline**:
```
ephemeral → (used ≥3 times) → candidate → (user confirms) → persistent → (60 days unused) → archived
```

<a id="45-三個互動流程範例"></a>
#### 4.5 Three interaction examples
1. Contract risk → interactive risk map.
2. “Organize recent status” → clarification → Kanban.
3. Three repeated PR reports → scheduled skill.

<a id="46-信任與安全四機制"></a>
#### 4.6 Four trust mechanisms
- Layered sandboxing by content type.
- Capability Manifest permissions.
- Langfuse traceability.
- Text fallback on failure.

<a id="47-四階段實作路徑"></a>
#### 4.7 Four implementation phases
- **Phase 0 (Month 1-3 Alpha)**: Profile prototype and Artifacts-style generation.
- **Phase 1 (Month 4-6 Beta)**: Intent Parser and Designer v1.
- **Phase 2 (Month 7-12 v1.0)**: Profile learning and tool synthesis.
- **Phase 3 (Year 2)**: Marketplace and deeper hardware.

<a id="48-與-nous-核心的關係"></a>
#### 4.8 Relationship to the core
Generative interaction is the **presentation/interaction layer** above the architecture:
```
生成式互動系統 ← 新增
    ↓
Agent/MCP/權限
    ↓
記憶 + 知識
    ↓
Claude
```

---

<a id="part-3關鍵架構決策總表decision-log"></a>
## Part 3 | Architecture decision log

| # | Decision | Choice | Rejected | Reason |
|---|---|---|---|---|
| 1 | OS nature | Cognitive OS | Agentic/combined | Market gap, OS abstraction |
| 2 | Market | General product | Personal/EMS | Larger TAM |
| 3 | Schedule | 3-month Alpha | 12-month Beta | OSS savings |
| 4 | Name | Nous | Thymos/Meld/others | Short, meaningful |
| 5 | Kernel | Claude API | Multiple models | Deep integration |
| 6 | Desktop | Tauri 2.x | Electron | 3MB vs 100MB |
| 7 | Memory | Letta | Mem0/custom | OS alignment |
| 8 | Knowledge | LightRAG | Custom/GraphRAG | Dual retrieval + MIT |
| 9 | Agent | Claude Agent SDK | LangGraph/CrewAI | Lightweight + deep MCP |
| 10 | Language | TypeScript 70% | Python led | Claude Code strength |
| 11 | Database | SQLite + sqlite-vec | PostgreSQL | Desktop, no operations |
| 12 | License | Apache-2.0 | BSL/AGPL | Community friendly |
| 13 | Starter | agmmnn/tauri-ui fork | Custom shell | Saves 3 weeks |
| 14 | Chat UI | assistant-ui | Custom | Saves 2 weeks |
| 15 | Observability | Langfuse | Custom dashboard | Saves 3 weeks |
| 16 | UI | Generated dynamic UI | Fixed Dashboard | Intent centered |
| 17 | Khoj | Reference only | Whole-app fork | AGPL risk |

---

<a id="part-4當前狀態快照"></a>
## Part 4 | Status at this snapshot

<a id="41-已確定的核心定位"></a>
### 4.1 Established positioning

**Nous is**:
- A Cognitive OS with Claude kernel.
- Intent-centered generated tools/presentation.
- Local first with user-owned data.
- Apache-2.0 open source with future open core.

**Nous is not**:
- Better Claude Desktop without memory.
- Dify-style workflow building for others.
- A coding IDE like Cursor.
- Document-centered Obsidian plus AI.

<a id="42-待決策的開放問題"></a>
### 4.2 Open decisions

**P0 (before Week 1)**:
1. ⚠️ Finalize **Nous**, including trademark availability in target markets.
2. ⚠️ Register domain/GitHub organization: `nous.ai`, `getnous.com`, or `nous-os.dev`?
3. ⚠️ Public repo on Day 1 or Month 3?

**P1 (before Month 1)**:
4. Letta Cloud or self-hosted only?
5. macOS → Windows → Linux or simultaneous platforms?
6. At least 20 Alpha candidates to select 5-10.

**P2 (before Month 2)**:
7. When to open Discord.
8. Public-development disclosure boundaries.
9. Apply for Anthropic developer acceleration or Claude foundation funding?

<a id="43-風險監控儀表板"></a>
### 4.3 Risk dashboard

| Risk | Probability | Impact | Status |
|---|---|---|---|
| Anthropic coverage | Medium | Very high | 🟡 Monitor Cowork/Routines |
| Letta performance | Medium | High | 🟢 Mem0 fallback |
| LightRAG indexing | Medium | Medium | 🟢 sqlite-vec fallback |
| Tauri platform bugs | Medium | Medium | 🟡 macOS first |
| Day jobs reduce time | High | High | 🔴 Largest risk, needs discipline |
| Claude Code productivity | Low | High | 🟢 Feasibility established |
| License compliance | Low | Medium | 🟢 Exclusion list created |

---

<a id="part-5下一階段發想與規劃"></a>
## Part 5 | Next-stage ideas and planning

The completed foundation suggests the following areas to deepen and expand.

<a id="51-戰略層why--what需要深化的四個主題"></a>
### 5.1 Strategy (Why & What): four topics

<a id="511-敘事與定位文件narrative-doc"></a>
#### 5.1.1 Narrative Doc
**Why**: All four documents describe how. A top-level why narrative supports Hacker News, fundraising decks, and contributor recruitment.

**Deliverables**:
- **Elevator pitch**, within 25 words.
- **Why/What/How**, 100 words each.
- **Positioning map** against Claude Desktop, Cursor, Obsidian.
- **Five concrete user personas**.

<a id="512-最小可傳達價值minimum-communicable-value"></a>
#### 5.1.2 Minimum Communicable Value
**Why**: Alpha users must understand the product in a five-minute demo. Identify one compelling scenario.

**Deliverables**:
- **Three candidate Magic Moments**.
- Choose one main demo flow.
- A two-minute imagined demo script, even before implementation.

**Candidates**:
1. **Claude remembers you**: Mention a thesis, then relevant recall two weeks later.
2. **Generated for me**: A quarterly review becomes an interactive dashboard rather than text.
3. **Growing tools**: After three repetitions, AI suggests a persistent skill.

<a id="513-與可信任的控制的敘事連結"></a>
#### 5.1.3 Connect to “Trustworthy Control”
**Why**: This professional intellectual foundation gives Nous a distinctive philosophy.

**Deliverables**:
- Blog: “Why building an AI OS and studying AI trust are the same work.”
- A trust dashboard concept exposing AI decisions.

<a id="514-商業化路徑早期勾勒"></a>
#### 5.1.4 Early commercialization outline
**Why**: Architecture affects future business even though Alpha is not commercial.

**Deliverables**:
- **Three tiers**: Community (free/open), Pro (hosted), Enterprise (SSO/compliance/support).
- **Pricing anchors** vs Claude Pro $20, Cursor Pro $20, Notion AI $10.
- **Anthropic collaboration** possibilities: investment, MCP ecosystem, licensing.

---

<a id="52-技術層how需要深化的五個領域"></a>
### 5.2 Technology (How): five areas

<a id="521-記憶系統的深度設計"></a>
#### 5.2.1 Memory deep dive

**Available**: Three tiers, Letta integration, composite retrieval.

**Missing**:
- **Quality benchmark**, 20 scenarios for old preferences, cross-topic recall, conflicts.
- **Memory visualization**, a Memory Inspector.
- **Editing rights** to edit/delete/merge memories, central to privacy and trust.

**Deliverable**: Nous Memory Deep-Dive.

<a id="522-生成式-ui-的具體實作技術選型"></a>
#### 5.2.2 Concrete generative UI choices

**Available**: Architecture concept and Artifacts approach.

**Missing**:
- **Execution location**: iframe, WebView, local React renderer?
- **Streaming protocol** for structure first, content later.
- **Consistency** when reading/writing memory and knowledge.
- **Error handling** for broken generated UI.

**Deliverable**: Generative UI Technical Spec v0.1.

<a id="523-agent-模板庫的第一批設計"></a>
#### 5.2.3 Initial agent templates

**Available**: Research/Writer/Summarizer concepts.

**Missing**: Exact prompts, tools, permissions, failure handling.

**Deliverable**: Three complete Agent Specifications for Week 5.

<a id="524-資料持久化與遷移策略"></a>
#### 5.2.4 Persistence and migration

**Available**: Local SQLite.

**Missing**:
- Formal first **table schemas**.
- Exact single-file **`.nous` backup format**.
- **Future multi-device sync** support in schemas.
- **Version migration** strategy.

**Deliverable**: Nous Data Architecture Spec.

<a id="525-可觀測性的第一版儀表板設計"></a>
#### 5.2.5 First observability dashboard

**Available**: Langfuse and token dashboard concepts.

**Missing**: The actual user-facing design.

**Deliverables**:
- Token/Cost wireframe with five key metrics.
- Agent Trace Visualizer concept.
- On-demand “how work was done” inspection of rationale, sources, tools, and execution summary.

---

<a id="53-執行層when--who需要拓展的三個系統"></a>
### 5.3 Execution (When & Who): three systems

<a id="531-week-1-具體-pr-清單"></a>
#### 5.3.1 Week 1 PR list

**Why**: Weekly detail is insufficient. Claude Code needs PR-sized tasks.

**Deliverable**: `Week_01_PR_Checklist.md` with 8-12 independent PRs, each naming:
- Goals, acceptance, estimated time.
- Files, APIs, dependencies.
- Human or Claude Code ownership.

<a id="532-開發者工作流devloop"></a>
#### 5.3.2 DevLoop

**Why**: Two people need an efficient collaboration rhythm.

**Deliverables**:
- **Daily rhythm**, such as morning tests/review and afternoon co-design.
- **Weekly rhythm**, Monday planning, Wednesday check, Friday demo.
- **Full CLAUDE.md template**, decisions, conventions, prohibitions, tests.
- **Git workflow**, branches, commits, releases.

<a id="533-社群與內容策略"></a>
#### 5.3.3 Community and content

**Why**: Build public momentum from Day 1 rather than Month 3.

**Deliverables**:
- **12-week content calendar**, weekly tweet, fortnightly blog, monthly demo.
- **Early follower list**, 100 heavy Claude users' Twitter handles.
- **GitHub README template** before public code.
- **Discord structure**, channels, roles, onboarding.

---

<a id="54-哲學層需要持續思考的三個根本問題"></a>
### 5.4 Philosophy: three continuing questions

These have no immediate answers but shape the long term.

<a id="541-認知主權是什麼"></a>
#### 5.4.1 What is cognitive sovereignty?
User ownership of memory and knowledge concerns ethics and power as well as technology.
- Can users understand how memories are used?
- Who is responsible when AI makes decisions?
- Is local first a value or marketing?

<a id="542-當-ui-消失人類學到什麼"></a>
#### 5.4.2 What do people learn when UI disappears?
If people no longer learn tools, might they lose capabilities?
- Can we work without AI?
- How does “skill” change?
- Should Nous deliberately preserve situations requiring human initiative?

<a id="543-nous-與可信任的控制的張力"></a>
#### 5.4.3 Tension with “Trustworthy Control”
Research controls AI, while Nous grants it more power. How can these agree?
- Is surface control surrendered in exchange for deeper control?
- Can Nous demonstrate trustworthy AI control?
- How is trust designed into a product rather than asserted?

---

<a id="part-6立即行動建議next-7-days"></a>
## Part 6 | Recommended actions for the next seven days

Five priorities follow from this review:

<a id="-優先-1完成敘事層narrative"></a>
### 🥇 Priority 1: narrative
**Deliverable**: Three-page `Nous_Narrative.md` with pitch, Why/What/How, map, five personas.
**Reason**: Foundation for communication and checking purpose.

<a id="-優先-2決定-magic-moment"></a>
### 🥈 Priority 2: Magic Moment
**Deliverable**: Choose one of three scenarios and write a two-minute script.
**Reason**: A target experience guides technical decisions.

<a id="-優先-3week-1-pr-checklist"></a>
### 🥉 Priority 3: Week 1 PR checklist
**Deliverable**: 8-12 immediately executable Claude Code tasks.
**Reason**: Bridges planning and implementation.

<a id="-優先-4claudemd-模板"></a>
### 🏅 Priority 4: CLAUDE.md
**Deliverable**: Full project constitution defining Claude Code behavior and style.
**Reason**: Output quality depends directly on it.

<a id="-優先-5domain--商標初查"></a>
### 🏅 Priority 5: domain and trademark check
**Deliverable**: Check Nous availability and register domain/GitHub organization.
**Reason**: Delay increases cost and narrows options.

---

<a id="part-712-週後的理想狀態願景錨點"></a>
## Part 7 | Ideal state after 12 weeks

**Desired Alpha Release Day**:

**Product**:
- 10 users, each using it at least three times.
- One unsolicited report of changed working habits.
- Stable core flows without major crashes.

**Community**:
- Public repo with >500⭐ after Hacker News.
- >50 active Discord members.
- One widely shared “Building Nous” Part 1 blog.
- One merged outside PR.

**Personal**:
- Stronger conviction from seeing user delight.
- Internalized, consistently productive Claude Code collaboration.
- Clear Month 4-6 plan based on feedback.

**Philosophy**:
- A user discusses a changed view of AI.
- Intuitive understanding of intent-centered OS beyond documents.
- A clearer connection between Nous and “Trustworthy Control.”

---

<a id="結語nous-現在在哪裡"></a>
## Closing: where is Nous now?

**In two weeks**, the project moved from an idea to a concrete blueprint. Four documents cover:
- **Concept**: Cognitive OS definition/philosophy.
- **Architecture**: Seven modules.
- **Tactics**: OSS strategy compressing 41 weeks into 12.
- **Vision**: Generative UI.

**Action is the missing part**. From Week 1 Day 1, take a demonstrable step daily. Starting a Docker container or Tauri Hello World moves Nous toward reality.

Ideas become powerful through implementation. Claude as kernel becomes real only when it runs.

**Ready to execute?**

---

> This is “progress snapshot v1.” Implementation will diverge from it. Update monthly as a historical record.
