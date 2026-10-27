<!-- bilingual: source=zh-TW -->

> [繁體中文](03_3Month_Accelerated_Roadmap.md) | [English](03_3Month_Accelerated_Roadmap.en.md)

<a id="nous-認知-os--3-個月加速開發時程"></a>
# Nous Cognitive OS: three-month accelerated development schedule

> **Reading guide, 2026-10-24**: See [implementation status](Current_Implementation_Status.en.md) for code and gaps, and the [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) for value, dependencies, MVPs, and roadmaps. This document preserves early designs, not implementation or acceptance claims. Product constraints and G0–G3 follow [06](06_Ambient_Voice_Gaze_Experience.en.md), [07](07_Ambient_Implementation_and_Acceptance.en.md), and later explicit revisions. F0–F10 and Q0–Q4 do not replace those gates.
>
> The code baseline is `1f44c6b` (2026-10-23). The runnable prototype in `prototype/ambient-shell` uses Node HTTP, SSE, TypeScript, Vite, and Electron. Tauri, React, a Python kernel, Agent SDK, long-term memory, and generated tools are target designs. Model, price, market, star, and ecosystem figures reflect the original writing date. They were not rechecked here. Verify before adoption.

> **Historical update, 2026-10-07**: The estimated PR-00 + G0–G3 schedule is in [08 §6](08_Consolidation_and_Update_2026-10.en.md#6-重新排程). Section 3.3 P1 records the judgment revising the Letta REST API approach at that time. External states were not rechecked here. Unchecked items below are an old plan and cannot establish today's progress.

> **Interaction update, 2026-09-16**: Ambient brain standby, no apps, voice first, webcam gaze selection, and on-demand presentation follow [06 experience specification](06_Ambient_Voice_Gaze_Experience.en.md) and [07 development and acceptance](07_Ambient_Implementation_and_Acceptance.en.md). Underlying designs remain. Old schedules and interfaces are historical. 06–07 take precedence where they conflict.

> **Philosophy**: Integrate mature OSS rather than rebuild infrastructure. Focus on adapters and distinctive UX to move from **12 months → 3 months**.
>
> **Team**: 1 human + Claude Code (pair programmer).
> **Delivery target**: **Alpha Release for 5-10 early users**.
> **Outside scope**: Public Beta, App Store distribution, and a full plugin marketplace (Month 4+).

---

<a id="2026-09-16-排程修訂"></a>
## Schedule revision, 2026-09-16

Voice, on-demand presentation, and large-region webcam selection are now core requirements. Follow G0–G3 in [07](07_Ambient_Implementation_and_Acceptance.en.md): shell/policy → real voice tasks → gaze fusion → Alpha acceptance. Cut knowledge graph UI, whiteboards, and public release work first to make room for hardware verification.

The weekly breakdown below remains a reference for underlying work, not a fixed 12-week promise. Chat, knowledge, cost, and workflow views appear only on demand.

<a id="-原-3-個月的總體節奏"></a>
## 🎯 Original three-month cadence

```
Month 1: Assemble ────── 把所有零件裝起來，跑通端到端 demo
Month 2: Integrate ───── 整合所有元件，補上 Agent 編排與 MCP
Month 3: Polish ──────── UX 打磨、測試、打包、Alpha 釋出
```

**Every Friday**: Human review, demo, and next-week planning.
**Every day**: Claude Code implementation and human architecture decisions.
**Every two weeks**: Public updates (Twitter / Blog / Discord) to build a community.

---

<a id="month-1assemble-組裝期week-1-4"></a>
## Month 1 | Assemble (Week 1-4)

**Goal**: Assemble Letta, LightRAG, Claude Agent SDK, Tauri, and assistant-ui into a minimal end-to-end loop: import document → converse → remember → ask again.

---

<a id="week-1--基礎設施與骨架"></a>
### Week 1: infrastructure and framework

**Must-have deliverables**:
- [ ] Fork `agmmnn/tauri-ui` as the desktop framework.
- [ ] Create a monorepo (pnpm workspaces).
  ```
  nous/
    apps/desktop/       # Tauri + React 前端
    apps/kernel/        # Python FastAPI 後端
    packages/shared/    # 共用 types (tRPC)
    packages/agents/    # Claude Agent SDK 封裝
    docker/             # Letta + LightRAG + Langfuse
  ```
- [ ] Write `CLAUDE.md` (architecture decisions, conventions, prohibitions).
- [ ] Start Letta, LightRAG, and Langfuse with Docker Compose.
- [ ] Run a basic Claude API conversation (TS SDK).
- [ ] New priorities: ambient brain shell, state events, Presentation Policy (07 PR-01–02).

**Nice-to-have**:
- GitHub Actions CI (lint/test).
- Claude Code Skills for working in this repo.

**Responsibilities**:
- **Human**: Tauri, architecture, Docker Compose, CLAUDE.md.
- **Claude Code**: Monorepo initialization, tauri-ui cleanup, package.json dependencies.

**Risks / Fallbacks**:
- Tauri 2 WebView issues → test macOS first and defer Windows.
- Slow Letta Docker startup → Mem0 Python SDK fallback.

---

<a id="week-2--記憶層整合"></a>
### Week 2: memory integration

**Must-have deliverables**:
- [ ] Kernel creates agents and sends messages through Letta REST API.
- [ ] Frontend displays agent core memory (persona + human block).
- [ ] Cross-session memory (close and reopen the app; Claude remembers your name).
- [ ] assistant-ui message stream, streaming, Markdown.
- [ ] Langfuse records every LLM call.

**Integration references**:
- Letta SDK: https://github.com/letta-ai/letta
- assistant-ui: https://github.com/assistant-ui/assistant-ui
- Langfuse integration: https://langfuse.com/docs

**Responsibilities**:
- **Human**: Letta vs Mem0 decision, memory schema, conversation verification.
- **Claude Code**: Letta client wrapper, assistant-ui, Langfuse instrumentation.

**Demonstrable milestone**: 💬 **A Claude desktop conversation app that remembers you across sessions.**

---

<a id="week-3--知識層整合"></a>
### Week 3: knowledge integration

**Must-have deliverables**:
- [ ] Add LightRAG to Docker Compose.
- [ ] Ingestion: Docling (PDF/Office), MarkItDown (general), Firecrawl API (web).
- [ ] Upload → chunk → embed → store in LightRAG.
- [ ] Connect LightRAG dual-level retrieval to Claude as a retrieval tool.
- [ ] Prototype knowledge browser listing ingested documents.

**Integration references**:
- LightRAG: https://github.com/HKUDS/LightRAG
- Docling: https://github.com/docling-project/docling
- MarkItDown: https://github.com/microsoft/markitdown

**Responsibilities**:
- **Human**: Ingestion architecture, knowledge schema, chunking.
- **Claude Code**: Parser wrappers, LightRAG client, upload UI.

**Demonstrable milestone**: 📚 **Upload PDFs and get accurate answers grounded in their content.**

---

<a id="week-4--端到端閉環"></a>
### Week 4: end-to-end loop

**Must-have deliverables**:
- [ ] User question → Letta memory context + LightRAG knowledge context → Claude → answer + memory update.
- [ ] Claude Agent SDK `@tool` definitions for `search_knowledge` and `recall_memory`.
- [ ] First-use tool authorization dialog.
- [ ] Installable Alpha (unsigned is acceptable).

**Nice-to-have**:
- Two-minute Week 4 Twitter demo to build awareness.

**Month 1 milestone**: 🎉 **Desktop app, persistent memory, retrieval, and tools work end to end.**

---

<a id="month-2integrate-整合期week-5-8"></a>
## Month 2 | Integrate (Week 5-8)

**Goal**: Add orchestration, MCP tools, and complete UI so the system becomes practical.

---

<a id="week-5--agent-編排與-sub-agents"></a>
### Week 5: orchestration and sub-agents

**Must-have deliverables**:
- [ ] Enable Claude Agent SDK sub-agents (`AgentDefinition`).
- [ ] Three built-in specialists:
  - **Research Agent** (search, read, summarize).
  - **Writer Agent** (long-form writing/editing).
  - **Summarizer Agent** (meetings/documents).
- [ ] Supervisor routes by user intent.
- [ ] Prototype Agent Monitor with active agents, progress, interruption.

**Integration references**:
- Claude Agent SDK docs: https://docs.claude.com/en/docs/claude-code/sdk

**Responsibilities**:
- **Human**: Roles, system prompts, routing.
- **Claude Code**: Agent classes, UI, multi-agent status streaming.

**Demonstrable milestone**: 🤖 **“Research X and write a report” triggers collaborative agents.**

---

<a id="week-6--mcp-工具生態"></a>
### Week 6: MCP tool ecosystem

**Must-have deliverables**:
- [ ] MCP manager backend starts, stops, and manages STDIO/HTTP servers.
- [ ] Registry browser, one-click installation, authorization UI.
- [ ] Five built-ins: filesystem, github, gmail, notion, playwright (browser).
- [ ] Audit log records agent, time, and tool.

**Integration references**:
- MCP Registry: https://github.com/modelcontextprotocol/registry
- MCP Servers: https://github.com/modelcontextprotocol/servers
- GitHub MCP: https://github.com/github/github-mcp-server
- Notion MCP: https://github.com/makenotion/notion-mcp-server
- Playwright MCP: https://github.com/microsoft/playwright-mcp

**Responsibilities**:
- **Human**: Server lifecycle, permissions, audits.
- **Claude Code**: Client pool, registry API, install flow.

**Demonstrable milestone**: 🔌 **“Check today's GitHub PR status” automatically calls GitHub MCP.**

---

<a id="week-7--知識-ui-與個人化工作流"></a>
### Week 7: knowledge UI and personal workflows

**Must-have deliverables**:
- [ ] On-demand Knowledge Surface with search, filters, previews, delete. Closing returns to the brain.
- [ ] LightRAG graph visualization (embedded Web UI or re-rendered).
- [ ] Personal/work separation (UI + SQLite namespaces).
- [ ] Folder-watching ingestion daemon.
- [ ] Cmd+K Command Bar search and commands.

**Responsibilities**:
- **Human**: UX, interactions, visual decisions.
- **Claude Code**: Components, shortcuts, background work.

**Demonstrable milestone**: 🔍 **A complete second-brain experience with search, browsing, and graph visualization.**

---

<a id="week-8--可觀測性與持久化"></a>
### Week 8: observability and persistence

**Must-have deliverables**:
- [ ] Langfuse tracing, tokens, costs, and agent graphs.
- [ ] On-demand daily/monthly/per-agent token and cost queries.
- [ ] Long-task persistence with SQLite checkpoints, without Temporal.
- [ ] Conversation replay, editing, retry from any point.
- [ ] On-demand task rationale, sources, execution summary.

**Integration references**:
- Langfuse: https://github.com/langfuse/langfuse

**Responsibilities**:
- **Human**: Dashboard metrics, checkpoint schema.
- **Claude Code**: Hooks, dashboard UI, replay.

**Month 2 milestone**: 🏗️ **Complete OS framework with memory, knowledge, agents, tools, and tracing.**

---

<a id="month-3polish-打磨與釋出week-9-12"></a>
## Month 3 | Polish and release (Week 9-12)

**Goal**: Improve usability and prepare an Alpha for early users.

---

<a id="week-9--ux-精修與多模態"></a>
### Week 9: UX and multimodality

**Must-have deliverables**:
- [ ] TipTap knowledge editor.
- [ ] Dark/light themes.
- [ ] Check spacing, typography, and color tokens throughout.
- [ ] Complete keyboard shortcuts.
- [ ] Startup < 3 seconds.
- [ ] First conversation token < 1 second.

**Nice-to-have**:
- tldraw knowledge-map whiteboard.

Voice is now mandatory in G1 (wake, STT, TTS, interruption, fallback), rather than a Week 9 nice-to-have.

**Integration references**:
- TipTap: https://github.com/ueberdosis/tiptap
- tldraw: https://github.com/tldraw/tldraw

**Responsibilities**:
- **Human**: UX details, visual quality, tests with 2-3 friends.
- **Claude Code**: TipTap, themes, animation optimization.

---

<a id="week-10--安全與設定"></a>
### Week 10: security and settings

**Must-have deliverables**:
- [ ] Move API keys into native storage through Tauri keyring.
- [ ] Full settings: keys, models, memory, agent configuration.
- [ ] System/agent/user permission levels.
- [ ] Export all memory, knowledge, and settings into one .nous backup.
- [ ] Restore from backup.

**Integration references**:
- Tauri keyring plugin: https://github.com/tauri-apps/plugins-workspace

**Responsibilities**:
- **Human**: Security review, UX.
- **Claude Code**: Keyring, settings, backups.

---

<a id="week-11--穩定性與打包"></a>
### Week 11: stability and packaging

**Must-have deliverables**:
- [ ] Playwright E2E core-flow coverage.
- [ ] Stress tests (1000+ memories, 100+ documents).
- [ ] Crash reporting (Sentry or custom).
- [ ] Tauri auto-updater.
- [ ] macOS .dmg (Alpha can be unnotarized).
- [ ] Windows .msi.
- [ ] Linux .AppImage.

**Nice-to-have**:
- Apple notarization with a Developer Account.
- Windows signing ($400+/year, can wait).

**Responsibilities**:
- **Human**: Scenarios, package configuration, crash priorities.
- **Claude Code**: Playwright scripts, fixes, CI/CD packaging.

---

<a id="week-12--文件社群alpha-釋出"></a>
### Week 12: documentation, community, Alpha

**Must-have deliverables**:
- [ ] README with installation, quick start, architecture.
- [ ] `docs/` Getting Started, Architecture, Privacy, FAQ.
- [ ] One-page landing site (GitHub Pages or Vercel).
- [ ] Blog: “Building Nous in 3 Months: A Cognitive OS on Claude.”
- [ ] Discord and GitHub Discussions.
- [ ] Five-minute walkthrough video.
- [ ] **Private Alpha** for 5-10 early users through Twitter DM/personal contacts.

**Nice-to-have**:
- Test Hacker News/Product Hunt interest with a working framework.
- Twitter launch post.

**Responsibilities**:
- **Human**: Docs, community, marketing/PR, invitations.
- **Claude Code**: Documentation framework, website, final fixes.

**Month 3 milestone**: 🚀 **Private Alpha with 5-10 actual users and feedback collection.**

---

<a id="-3-個月-vs-12-個月的取捨"></a>
## 📊 Three-month vs 12-month tradeoffs

| Feature | 12 months | 3 months | Reason for reduction |
|---|---|---|---|
| Custom three-tier memory | ✅ Fully custom | ❌ Letta | Saves 6-8 weeks |
| Custom knowledge graph | ✅ SQLite → Neo4j | ❌ LightRAG | Saves 4-6 weeks |
| Custom parsing | ✅ Layered formats | ❌ Docling + MarkItDown | Saves 2-3 weeks |
| Custom chat UI | ✅ Custom components | ❌ assistant-ui | Saves 2-3 weeks |
| Custom Tauri shell | ✅ Configure from scratch | ❌ Fork tauri-ui | Saves 1-2 weeks |
| Custom MCP connectors | Some built-ins | ❌ Official servers | Saves 3-4 weeks |
| Custom observability dashboard | ✅ | ❌ Langfuse | Saves 2-3 weeks |
| Temporal.io | Phase 2 | ❌ SQLite checkpoints | Saves 2 weeks |
| tldraw | ✅ | 🟡 Nice-to-have | Non-core |
| Voice | ✅ | ✅ Required in new G1 | Main interaction channel |
| Webcam gaze | Absent from original schedule | ✅ Large regions in new G2 | Replaces mouse pointing in the core flow |
| Brain + on-demand surfaces | Absent from original schedule | ✅ Required in new G0 | Default experience |
| Cloud sync | ✅ | ❌ Month 4+ | Non-core |
| Mobile | ✅ | ❌ Month 6+ | Non-core |
| Plugin marketplace | ✅ | ❌ Month 6+ | Non-core |
| Full Beta | ✅ | 🟡 Alpha | Smaller scope |
| Commercial preparation | ✅ | ❌ Month 4+ | Non-core |

---

<a id="-關鍵成功因子"></a>
## 🔥 Success factors

<a id="1-嚴守整合優先紀律"></a>
### 1. Enforce integration first
When tempted to build something, **search GitHub first**. Build only if no mature project with >5K⭐ can meet the need.

<a id="2-claude-code-效能倍增"></a>
### 2. Multiply productivity with Claude Code
- **CLAUDE.md** specifies decisions, prohibitions, and conventions.
- **Git worktrees** support concurrent feature branches.
- **Skills system** provides repo skills such as `add-mcp-server` and `create-agent-template`.
- **Clear task size**: Give one PR-sized task at a time, not “build the entire agent system.”

<a id="3-每週五-demo-day"></a>
### 3. Friday Demo Day
Every Friday afternoon:
1. Record a 2-3 minute demo, even if rough.
2. Post to Twitter/personal communities.
3. Write a dev log (Notion/Blog).
4. Review progress and revise next week's plan.

Build public momentum before the Month 3 Alpha.

<a id="4-砍-scope-比加-scope-重要"></a>
### 4. Cut scope before adding it
Ask weekly whether Alpha users will actually use a feature. If not, defer it immediately.

<a id="5-alpha-使用者是真實回饋來源"></a>
### 5. Alpha users provide real feedback
After Week 12, interview two users weekly. Their problems, rather than assumptions, determine Month 4.

---

<a id="-高風險區與應對"></a>
## ⚠️ High risks and responses

| Risk | Probability | Impact | Response |
|---|---|---|---|
| Unstable/slow Letta API | Medium | High | Switch to Mem0 if issues remain at Week 2. |
| Slow LightRAG indexing | Medium | Medium | Use sqlite-vec + FTS5 without KG. |
| Tauri cross-platform bugs | Medium | Medium | macOS + Windows first, Linux later. |
| Uneven MCP quality | High | Medium | Ship only five officially maintained servers. |
| Similar Anthropic releases (Claude Cowork updates) | Medium | High | Differentiate with local-first persistent memory and multi-agent OS abstractions. Contribute to MCP. |
| Lower Claude Code productivity | Low | High | Cut features and preserve the core loop. |
| Day jobs reduce available time | High | High | Enforce 20-25 hours/week minimum or replan. |

---

<a id="-3-個月後的狀態"></a>
## 🎯 Expected state after three months

**Alpha Nous should have**:

✅ Desktop app (macOS + Windows + Linux).
✅ Claude conversations with cross-session memory.
✅ Document-based personal knowledge with Claude retrieval.
✅ Three collaborating specialists (research, writing, summaries).
✅ 5+ MCP integrations (files, GitHub, Gmail, Notion, browser).
✅ Token and cost dashboard.
✅ Basic security (OS keychain, audits).
✅ Public GitHub readiness, docs, Discord, 5-10 Alpha users.

**This is already a differentiated product**, sufficient to:
- Gain attention on Hacker News/Twitter/Product Hunt.
- Attract early contributors.
- Demonstrate a third-party Claude OS layer to Anthropic's ecosystem.
- Support Month 4-6 public Beta and commercial exploration.

---

<a id="-後續路線圖-post-alpha-month-4"></a>
## 📌 Post-Alpha roadmap (Month 4+)

- Month 4: Feedback-led iteration and public Beta.
- Month 5-6: Plugin SDK, agent marketplace, optional cloud sync.
- Month 7+: Commercial exploration (open core + hosted cloud/enterprise).

Plan these after Alpha feedback. **Do not optimize problems that do not yet exist.**

---

**Final reminder**: This schedule is aggressive but feasible. Success depends on **discipline**: no expanding scope, reinventing infrastructure, perfectionism, or isolated development.

Every Friday ask: **“If I had to demo this to a friend today, what would make me proudest and most embarrassed?”** The answer sets next week's priorities.
