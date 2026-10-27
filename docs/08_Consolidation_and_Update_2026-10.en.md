<!-- bilingual: source=zh-TW -->

> [繁體中文](08_Consolidation_and_Update_2026-10.md) | [English](08_Consolidation_and_Update_2026-10.en.md)

<a id="nous--2026-10-匯總與更新規劃基線-v02"></a>
# Nous: October 2026 consolidation and update (planning baseline v0.2)

Version v0.2 · Snapshot 2026-10-07 · Historical authority clarification updated 2026-10-24. This preserves the October 7 inventory/proposals, not today's code. Architectural changes still require spikes/ADRs. This documentation cleanup does not approve any proposal.

> **Reading guide, 2026-10-24**: The repo now has runnable `prototype/ambient-shell` at baseline `1f44c6b` (2026-10-23). See [implementation status](Current_Implementation_Status.en.md) for code/gaps and [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) for priorities/Quest. The Node HTTP/SSE, TypeScript, Vite, Electron prototype has multiple engines, dual voice, tasks/artifacts, and sensing. These do not pass G0–G3.
>
> Sections 0–9 remain a **2026-10-07 historical snapshot**. Zero implementation, not started/undecided labels, character counts, two commits, prices, external states, and 14-day schedule refer only to then. External data was not rechecked. Do not rebuild PR-00/01 from these tables today. Extend existing code and fill acceptance/integration gaps. F0–F10 and Q0–Q4 do not replace existing gates.

> Historical reading order on 2026-10-07: this document (status/corrections then) → [06](06_Ambient_Voice_Gaze_Experience.en.md)/[07](07_Ambient_Implementation_and_Acceptance.en.md) (product/acceptance) → 01–05 (foundation/history). Conflict precedence then was **08 approved decisions > 06–07 > 01–05**. Proposals in 08 do not override documents before their ADRs pass.

---

<a id="0-2026-10-07-一頁摘要"></a>
## 0. One-page summary for 2026-10-07

1. **Progress then**: Seven designs and two commits in 33 days (2026-09-04 → 10-07), **zero implementation as of October 7**. The original Alpha schedule would be in Week 5, but Week 1 had not begun. This does not describe the October 24 runnable prototype.
2. **Product converged**: Brain standby → spoken request → agents → on-demand results → look-and-speak. No apps/permanent Dashboard.
3. **Four architectural ecosystem changes**: Letta V1 server retired, invalidating 02/03's memory route. MCP 2026-07-28 becomes stateless with **Apps** sandbox UI and **Tasks**. Anthropic memory converges on path-addressed Markdown. Third-party Agent SDK products need API keys rather than claude.ai login quotas.
4. **Proposed corrections**: Local Markdown + SQLite memory, MCP Apps-compatible surfaces, MCP Tasks alignment, local OTel with optional Langfuse export.
5. **New estimate**: Gates instead of weeks. Starting 2026-10-12 at 20–25 hours/week gives G3 around **2027-01-24**, an estimate with G2 hardware gaze as the main uncertainty.

---

<a id="1-時間線"></a>
## 1. Timeline

| Date | Event | Output |
|---|---|---|
| Early 2026-09 | OS specifically for Claude | Cognitive OS, general product, 12 months |
| Early 2026-09 | Research | 01: seven modules, nine OS mappings, 12 months |
| Early 2026-09 | OSS strategy | 02 component map, 03 accelerated roadmap |
| Early 2026-09 | No fixed UI | 04 generative interaction |
| 2026-09-04 | Initial commit `dcecb59` | 01–05, README, SETUP, .gitignore |
| 2026-09-16 | Interaction update `3ff01ee` | 06/07, override notices in 01–05 |
| 2026-09-22 | Claude Opus 5.5 release | Section 4 |
| 2026-10-07 | Consolidation | 08, CLAUDE.md, README/docs index |

---

<a id="2-2026-10-07-現況盤點"></a>
## 2. Inventory as of 2026-10-07

<a id="21-文件清單2026-10-07-實算"></a>
### 2.1 Documents (counted 2026-10-07)

Python counts Unicode characters excluding whitespace. CJK means unified Chinese/Japanese/Korean ideographs.

| Document | Non-whitespace characters | Role | Authority then |
|---|---:|---|---|
| 01 blueprint | 18,100 | Seven modules, choices, 12 months | Foundation valid, shell/schedule/models outdated |
| 02 OSS map | 10,838 | Integration first | Strategy valid, Letta/Langfuse deployment needs correction (§5) |
| 03 roadmap | 8,940 | Weekly plan | Superseded by 07 gates, underlying-work reference |
| 04 generative interaction | 11,672 | Intent, six layers, promotion | Valid, suggest MCP Apps for Runtime B |
| 05 progress v1 | 14,664 | Early September | Historical |
| 06 brain/voice/gaze | 7,819 | Product specification | **Current specification** |
| 07 development/acceptance | 7,837 | Contracts, prompts, PR-01–08, AC-01–18 | **Current execution basis** |
| **01–07 total** | **79,870** | — | CJK 28,016 |

**Correction**: A prior conversation called 01–04 “about 85,000 characters.” POSIX-locale `wc -m` had measured **bytes**. The actual inventory was **49,550 non-whitespace characters**, including 15,282 CJK characters.

<a id="22-已完成"></a>
### 2.2 Completed

- Positioning, Nous naming, OS mapping, seven modules, 17 decisions (01).
- OSS strategy/license exclusions (02).
- Intent, graph, profile, Designer, runtime, promotion (04).
- Brain, no apps, voice, gaze, on-demand disclosure, separate shell/task (06).
- JSON contracts, prompts, PR-01–08, G0–G3, AC-01–18, calculable fixture, measurements (07).
- Magic Moment effectively chosen: 07 §6.1 comparison → look at B/change cost → save/recall.

<a id="23-當時尚未完成"></a>
### 2.3 Incomplete then

| Item | Source | Status |
|---|---|---|
| Runnable code | 03, 07 | Not started October 7. Prototype exists today. See status for monorepo/Tauri/Python. |
| `CLAUDE.md` | 05 priority 4 | **v0.1 added here** |
| Pitch/personas/positioning | 05 priority 1 | Not started |
| Trademark/domain | 05 P0 | Not started |
| Repo disclosure timing | 05 P0 | Undecided |
| Hardware list | 07 §1 | Unrecorded |
| Voice/gaze PoC | 06 §4, 07 PR-03/05 | Not started |

---

<a id="3-決策日誌-v2"></a>
## 3. Decision log v2

<a id="31-沿用01-的-17-項"></a>
### 3.1 Original 17 decisions

| # | Decision | Status |
|---|---|---|
| D1 | Cognitive rather than Agentic OS | Retained |
| D2 | General product | Retained |
| D3 | Three-month Alpha | **Replaced by D20** |
| D4 | Nous | Retained, trademark unchecked |
| D5 | Claude kernel | Retained, models in §4.1 |
| D6 | Tauri 2.x | Retained, WebView sensor-permission spike needed |
| D7 | Letta memory | **Pending change, P1** |
| D8 | LightRAG | Retained, deferred until after G1 |
| D9 | Claude Agent SDK | Retained, authorization restrictions §4.2 |
| D10 | TypeScript primary | Retained |
| D11 | SQLite + sqlite-vec | Retained, sqlite-vec pre-v1 |
| D12 | Apache-2.0 | Retained |
| D13 | tauri-ui fork | Reference only, brain needs no dashboard framework |
| D14 | assistant-ui | On-demand conversation/tool components, no homepage |
| D15 | Langfuse | **Pending change, P5** |
| D16 | Generated dynamic UI | Retained, detailed by 06 |
| D17 | Khoj reference only | Retained |

<a id="32-2026-09-16-新增已決"></a>
### 3.2 Approved additions, 2026-09-16

| # | Decision | Basis |
|---|---|---|
| D18 | Brain only at rest, no apps/icons/launcher/sidebar/Dashboard | 06 §1–2 |
| D19 | Voice required G1, large-region webcam gaze G2 | 06 §3–4 |
| D20 | G0–G3 instead of fixed 12 weeks | 07 §5 |
| D21 | Deterministic Policy, `visibility_reason` per Surface | 06 §2.2 |
| D22 | Look points, speech acts. Gaze/blink is not authorization. | 06 §4.4 |
| D23 | Separate, independently persistent shell/task state | 06 §5 |
| D24 | Temporary Surface, versioned durable Artifact | 06 §2.3 |
| D25 | Arbitrary React/Python disabled before sandbox acceptance | 06 §6 |
| D26 | Background promotion candidates, on-demand suggestions, no widget | 04, 06 |

<a id="33-2026-10-07-提案待-adr"></a>
### 3.3 Proposals awaiting ADR, 2026-10-07

| # | Proposal | Reason | Verification |
|---|---|---|---|
| P1 | Local path-addressed Markdown memory + SQLite FTS5/sqlite-vec + versions; Mem0 fallback | Letta V1 retired, Anthropic uses paths, readable/exportable files | ADR-001 + 20 memory regressions |
| P2 | **MCP Apps-compatible host**, `ui://`, sandbox iframe, default-deny CSP, declared permissions | Align 04 Manifest/06 controlled renderer, support third-party tool UI | S4 |
| P3 | Align tasks with MCP Tasks (`taskId`, polling, input updates, reconnect) | Similar state machine, less custom protocol | ADR-003 |
| P4 | MCP 2026-07-28 client (stateless, `server/discover`, OAuth 2.1) | New spec conflicts with session model | Contract tests |
| P5 | Local OTel JSONL/SQLite, optional Langfuse export, not bundled | Local desktop should not bundle server observability; Langfuse remains MIT/self-hostable | ADR-005 |
| P6 | sherpa-onnx wake/VAD/streaming ASR/TTS + Breeze-ASR-25 final transcription | One local dependency for G1, Taiwan Mandarin/code-switching | S2 |
| P7 | MediaPipe Face Landmarker + custom personal calibration regression; GazeFollower/WebGazer research only | CC BY-NC-SA and GPLv3/no update guarantee | S3 |
| P8 | Opus 5.5 planning/hard reasoning, Sonnet workers, fast intent model. Dynamic Models API, no fixed names. | Three model generations in six months | Cost benchmark |
| P9 | LightRAG after G1. G1 uses 07 fixture controlled calculator. | Reduce early dependencies | Schedule |

---

<a id="4-生態變化2026-06--2026-10與影響"></a>
## 4. Ecosystem changes (2026-06 → 2026-10)

<a id="41-anthropic-模型"></a>
### 4.1 Anthropic models

| Date | Event | Impact |
|---|---|---|
| 2026-09-01 | Fable 5.1/Mythos 5.1, 1M context, $10/$50 per MTok | High-cost top tier, not default |
| 2026-09-22 | **Opus 5.5**, 1M context, 128k output, $4/$20 per MTok. 20% below Opus 5 $5/$25; official total runtime cost claim about 40% lower. | Replace 01's 4.6 planner |
| 2026-09-28 | Sonnet 5.5, 1M context | Worker candidate, official pricing governs |
| 2026-09-30 | Sonnet 4.5 deprecation, retirement 2026-11-30 | Supports dynamic model selection |

**Updated cost estimate**: 30K input + 3K output per task, no caching, 600 tasks/month.

| Model | Per task | 600/month |
|---|---:|---:|
| Opus 5.5 ($4/$20) | $0.18 | $108 |
| Sonnet 5 ($2/$10) | $0.09 | $54 |
| Fable 5.1 ($10/$50) | $0.45 | $270 |

Prompt cache reduces costs substantially. Measure actual use at G1. The original $70–260/month remains broadly plausible.

### 4.2 Claude Agent SDK

- Claude Code-style tools, hooks, subagents, MCP, permissions, sessions (resume/fork), skills/plugins in Python and TypeScript.
- **Restriction**: Unapproved third-party products cannot offer claude.ai login/quota. Users need API keys or Nous billing. This constrains business/onboarding.
- Branding: “Nous, Powered by Claude” is allowed. Do not use “Claude Code” or mimic its visuals.
- Managed Agents supplies hosted loops, self-hosted sandboxes, memory stores. Future cloud option, without changing local-first Alpha.

<a id="43-記憶的業界收斂"></a>
### 4.3 Industry convergence on memory

Managed Agents memory stores use path-organized text files such as `/preferences/formatting.md`, mounted as directories and read/written with file tools. Every change creates an immutable version. Limit 100 kB/file and 10,000 files/store. This supports P1 and Markdown + SQLite/data sovereignty in 01.

### 4.4 MCP 2026-07-28

- No initialize handshake, per-request `_meta`, stateless, no session ID. Discovery becomes `server/discover`.
- HTTP+SSE planned for deprecation, Streamable HTTP replaces it, stdio remains.
- OAuth 2.1/OIDC required, Dynamic Client Registration planned for deprecation.
- **MCP Apps**: sandbox HTML/JS UI, iframe-host postMessage JSON-RPC, CSP `default-src 'none'`, `_meta.ui.permissions`.
- **Tasks**: long-running `taskId`, polling/resumption.
- Roots, Sampling, Logging planned for deprecation, removal no earlier than 2027-07-28.

<a id="45-oss-元件狀態"></a>
### 4.5 OSS status

| Component | September record | October verification | Action |
|---|---|---|---|
| Letta | 21.6K⭐, Docker/REST memory | ~25K⭐, main repo archived, V1 retired, development moved to `letta-code` harness/App Server/WebSocket/OpenAI API | **Remove primary choice**, P1 |
| Mem0 | 48K⭐ alternative | 66.7K⭐, Apache-2.0, self-hosted, Anthropic | P1 fallback |
| LightRAG | 32.8K⭐ | 39.3K⭐, MIT, Docling/MinerU, rebuild graph on delete, reranker, Langfuse | Retain/defer P9 |
| sqlite-vec | 6K+⭐ | 8.2K⭐, Apache-2.0/MIT, pre-v1, DiskANN/IVF | Pin version |
| assistant-ui | 5K+⭐ | 11.4K⭐, MIT, tools/embedded approvals | On-demand only |
| Langfuse | 25K+⭐, Docker | Acquired by ClickHouse 2026-01, official MIT/self-hosted/roadmap continuity | Optional P5 |
| sherpa-onnx | — | Local KWS, VAD, streaming/non-streaming ASR, TTS, macOS/Windows/Linux/Tauri | Candidate P6 |
| Breeze-ASR-25 | — | MediaTek, Whisper-large-v2 fine-tune, Apache-2.0, Taiwan Mandarin/code-switching, whisper.cpp GGML/faster-whisper conversions | Candidate P6 |
| GazeFollower | — | Webcam gaze v1.1.0 (2026-09-16), **CC BY-NC-SA 4.0** | Reference only |
| WebGazer | Listed in 06 | GPLv3, no guaranteed updates from 2026-02-24 | Reference only |

<a id="46-競爭環境"></a>
### 4.6 Competition

| Competitor | Capabilities | Overlap |
|---|---|---|
| Claude app | Path-based cross-chat memory, Artifacts/typed outputs, scheduling, computer use, Chrome | High: memory, generated results, background work |
| Windows 11 Copilot | Wake, Vision, Agent Workspace Insider, agent-driven Windows discussion | Medium: OS voice agents |
| MCP Apps | Standard in-conversation UI | Medium: surfaces |

**Positioning revision**: Memory and generated UI alone no longer differentiate. Focus on:

1. **App-free Ambient Shell**. Brain standby and look-and-speak core flows.
2. **User-owned local memory**. Readable/editable/exportable Markdown independent of one cloud.
3. **Trust as architecture**. Deterministic Policy/Action Gate independent of models. Gaze is not consent, mocks are not capability. Direct link to “Trustworthy Control.”
4. **Claude-native, dynamic models**. SDK/MCP improve with Anthropic rather than compete.

---

<a id="5-更新後的元件對應只列差異"></a>
## 5. Updated component map (differences only)

| Module | Original (02) | Proposal | Status |
|---|---|---|---|
| A memory | Letta Docker/REST | `~/.nous/memory/**/*.md`, SQLite FTS5/sqlite-vec, version table, Mem0 fallback | P1 |
| B knowledge | LightRAG before G1 | After G1 | P9 |
| C orchestration | Claude Agent SDK | Same, MCP Tasks state | P3 |
| D tools | Official MCP servers | Same, 2026-07-28 client | P4 |
| E shell | tauri-ui/assistant-ui homepage | Tauri brain, MCP Apps host, on-demand assistant-ui | D18, P2 |
| E voice | Undecided | sherpa-onnx + Breeze-ASR-25 (whisper.cpp) | P6 |
| E gaze | Undecided | MediaPipe + custom calibration | P7 |
| G observability | Langfuse Docker | Local OTel, optional export | P5 |

---

<a id="6-重新排程"></a>
## 6. Rescheduling

> These are October 7 estimates, not current startup instructions/promises. Inventory `prototype/ambient-shell` first. Keeping/migrating architecture needs a decision. Hardware gates need measurements.

<a id="61-新增前置批次與-spike"></a>
### 6.1 Prerequisites and spikes

| Batch | Content | Acceptance |
|---|---|---|
| **PR-00** | pnpm monorepo, empty `packages/shared/schemas`, lint/test CI, validation template, hardware record | Green CI, recorded hardware |
| S1 | Tauri WebView sensor permissions, macOS first | Reproducible allow/deny/revoke |
| S2 | sherpa-onnx wake/Breeze latency and accuracy | 30 samples, 07 §6.4 |
| S3 | MediaPipe three regions | At least one person/30 trials, 07 §6.3 |
| S4 | MCP Apps `ui://` in Tauri | Sandbox/CSP/postMessage roundtrip |

S1 during PR-00, S2 early G1, S3 early G2, S4 during G0.

<a id="62-gate-時程估計"></a>
### 6.2 Gate estimates

Assumes Monday 2026-10-12 start, 20–25 hours/week, Claude Code primary implementation. Estimates, not promises.

| Gate | Content (07 batches) | Weeks | Estimated dates |
|---|---|---:|---|
| PR-00 | Framework, CI, S1 | 1 | 2026-10-12 → 10-18 |
| G0 | PR-01–02 brain, shell, contracts, Policy, S4 | 2 | 10-19 → 11-01 |
| G1 | PR-03–04 real voice/agent/results, S2 | 4 | 11-02 → 11-29 |
| G2 | PR-05–06 calibration, regions, fusion, S3 | 5 | 11-30 → 2027-01-03 |
| G3 | PR-07–08 external actions, dedup, lock, hardware | 3 | 2027-01-04 → 01-24 |

If G2 fails, use the already defined numbered-voice fallback (06 §4.5) for a “voice Alpha” while continuing gaze research.

---

<a id="7-開放問題更新"></a>
## 7. Updated open questions

| Priority | Question | Status | Suggestion |
|---|---|---|---|
| P0 | Nous trademark/domain | Unchecked | Before start, Thymos alternative |
| P0 | Public repo timing | Undecided | After visible G0 demo |
| P0 | Target hardware | Unrecorded | PR-00 `docs/validation/hardware.md` |
| P0 | ADR-001 memory | New | First week, affects PR-02 contracts |
| P1 | Keys/billing | New (§4.2) | Bring your own key for Alpha |
| P1 | Platform | macOS in 06 | Retain |
| P1 | Alpha candidates | Not started | Recruit after G1 |
| P2 | Discord/public disclosure | Undecided | Decide when G0 repo opens |
| P2 | Narrative | Not started | Four differentiators in §4.6 |

---

<a id="8-2026-10-07-當時計畫的接下來-14-天"></a>
## 8. The next 14 days as planned on 2026-10-07

1. Trademark/domain check.
2. ADR-001 deciding P1 vs Mem0.
3. Record machine/OS/mic/camera/display/scaling.
4. Then planned PR-00 + S1, followed by PR-01–02. Today, inventory the prototype under 07 §4.3 and extend one acceptance gap.
5. First 30-second brain → listening → result demo after G0. Fixtures allowed if labeled mock.

---

<a id="9-2026-10-07-更新內容"></a>
## 9. Changes made on 2026-10-07

- Add `docs/08_Consolidation_and_Update_2026-10.md`.
- Add root `CLAUDE.md` v0.1 with agent rules/prohibitions.
- Update README status/stack/document table.
- Update docs index/reading order.
- Add correction notices to 02/03 without changing their bodies.

---

<a id="來源查閱日期-2026-10-07"></a>
## Sources (accessed 2026-10-07)

- [Claude Platform release notes](https://platform.claude.com/docs/en/release-notes/overview.md)
- [Anthropic Releases Claude Opus 5.5 — Thurrott](https://thurrott.com/a-i/anthropic/341913/anthropic-releases-claude-opus-5-5)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk)
- [Managed Agents memory stores](https://platform.claude.com/docs/managed-agents/memory)
- [MCP 2026-07-28: What's changing — AAIF](https://aaif.io/blog/mcp-2026-07-28-whats-changing-and-how-to-migrate)
- [MCP Apps: the iframe is the agent — DEV](https://dev.to/rcsxplatform/mcp-apps-the-iframe-is-the-agent-40k9)
- [letta-ai/letta](https://github.com/letta-ai/letta), [Letta App Server quickstart](https://docs.letta.com/platform/app-server/quickstart)
- [mem0ai/mem0](https://github.com/mem0ai/mem0)
- [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG)
- [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)
- [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui)
- [Langfuse joins ClickHouse](https://langfuse.com/blog/joining-clickhouse)
- [sherpa-onnx README](https://cdn.jsdelivr.net/gh/k2-fsa/sherpa-onnx@master/README.md)
- [Breeze-ASR-25 — Hugging Face](https://huggingface.co/MediaTek-Research/Twister)
- [GazeFollower — PyPI](https://pypi.org/project/gazefollower)
- [Microsoft hints at a future AI agent-driven Windows — Redmond](https://redmondmag.com/blogs/generationai/2026/01/microsoft-hints-at-a-future-ai-agent-driven-windows.aspx)
