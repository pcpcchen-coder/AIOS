<!-- bilingual: source=zh-TW -->

> [繁體中文](Current_Implementation_Status.md) | [English](Current_Implementation_Status.en.md)

<a id="目前實作驗證與缺口"></a>
# Current implementation, verification, and gaps

Updated 2026-10-24, Asia/Taipei. Code baseline: [`1f44c6b`](https://github.com/pcpcchen-coder/AIOS/commit/1f44c6b384d8819e99c5d5a7689069119adf6d53). This update changes documentation only. It does not change product capabilities or declare G0–G3 passed. On 2026-10-25, the registered-family recognition row was updated from the ID-01 branch (`claude/family-id-01`), then again from ID-02 (`claude/family-id-02`, not yet merged). This is not hardware acceptance for G0–G3.

AIOS has an executable Nous desktop prototype. Use or extend [`prototype/ambient-shell`](../prototype/ambient-shell) first, then adopt the target architecture for concrete needs. Claude leads core development and ChatGPT / Codex leads Quest engineering. Runtime model selection follows settings and capabilities rather than binding providers to devices.

<a id="實際目錄與技術棧"></a>
## Actual directories and stack

| Path | Existing responsibility |
|---|---|
| [`prototype/ambient-shell/src/`](../prototype/ambient-shell/src/) | Framework-free TypeScript / Vite frontend, Canvas brain, Shell, results, and voice |
| [`server/`](../prototype/ambient-shell/server/) | Node HTTP + SSE, model routing, task scheduling, JSON persistence, accounts, and home bridge |
| [`shared/`](../prototype/ambient-shell/shared/) | `proto-0.1` types, progress, settings, sensing, and voice contracts |
| [`src/sense/`](../prototype/ambient-shell/src/sense/) | Left / right images, MediaPipe, geometry, filtering, and sensor events |
| [`desktop/`](../prototype/ambient-shell/desktop/) | Electron macOS shell, menu bar, packaging, and signing |
| [`tests/`](../prototype/ambient-shell/tests/) | Unit and integration tests including fixtures. These are not hardware acceptance |
| [`docs/validation/`](./validation/) | Batch-specific evidence and limitations. See the [index](validation/README.en.md) |

There is no `apps/kernel` Python core, production Tauri / React shell, Claude Agent SDK wrapper, versioned cross-language JSON Schema package, or Quest build project. The Anthropic Messages SDK is an existing dependency, distinct from a full Agent SDK tool runtime.

<a id="能力與證據層級"></a>
## Capabilities and evidence levels

| Capability | Code exists | Automation / fixtures | Hardware and remaining boundary |
|---|---|---|---|
| Six-region brain, on-demand results, dismiss without cancelling | Yes | Tested | Animations represent application events, not internal model neural activity |
| Claude / ChatGPT / mock tasks | Yes | Requests, streams, and errors tested | Full real-model success and tool work need scenario-specific evidence |
| JSON task / artifact persistence | Yes | Persistence, restart interruption, and retry tested | Unfinished tasks become failed on restart. Retry creates a new task and reruns everything. Artifacts currently stay at version 1 |
| Browser speech and two WebRTC routes | Yes | Fake speech, endpoint, and sideband cases tested | Codex live has some Mac logs and verbal temperature-query success. Full journeys and billing remain unaccepted |
| Presence, head facing, nominal distance, open palm, three arm regions | Yes | Synthetic points, fake cameras, and synthetic images tested | Not eye tracking. Nominal stereo geometry without real calibration or accuracy records |
| Smart home H0, H1 | Yes | Fake controller and example-code routes tested | Light control has verbal reports. Do not generalize them to every device |
| Smart home H1b: AIFA / IR | Yes | Fixtures, failures, and time budgets tested | Real air conditioning / IR needs checks. Report sent / unknown, not confirmed device change |
| MCP | Configurable for API-key realtime voice | Confirmation logic tested | No MCP on ChatGPT live. Not a complete local MCP host |
| General Action Gate | Partial confirmation mechanisms | Partly tested | HomeBridge H1 defaults to allow. H2 device policy is not connected. Not every action shows a confirmation card |
| Quest, multiple devices, OpenClaw worker | No | None | Expansion assessment, not implemented capability |
| Registered family recognition and named greetings | ID-01: enrollment, deletion, encrypted storage, local trial recognition inside Family recognition opened from the macOS menu bar. ID-02: recognition runs concurrently during look-to-talk facing wait, sampling only during dwell and connection rather than continuously in the background. At voice readiness + 600 ms, the core decides whether to use a name and randomly chooses a short opener from a fixed list, such as “George, I'm here,” “Hi, George,” or “Good morning,” based on local time and avoiding the previous one. API key and ChatGPT plan routes use the core's selected sentence. The opener is redacted from transcripts handed to Codex. “Use recognized family names in greetings” defaults on and can be disabled. Detector finalized as YuNet 2023mar 640 | Evidence rules, name validation, encrypted storage (fake SecretBox + real AES-GCM), core session / enrollment / deletion / matching, IPC filtering, static privacy checks; product worker cross-checked against OpenCV. ID-02 fixtures cover six greeting conditions, text sent by both routes, cancellation on user speech / typing, person change / multiple people / expired evidence / deletion, one fallback, name injection, and no names in logs (synthetic features, fake sampler, fake WebRTC and sideband) | [14 Plan](14_Family_Recognition_and_Greeting_Plan_2026-10.en.md); [Draft ADR-0001](adr/ADR-0001-local-family-recognition.en.md); [ID-00 spike](validation/family-id-00-spike-2026-10-24.en.md), [ID-01 verification](validation/family-id-01-2026-10-25.en.md), [ID-02 verification](validation/family-id-02-2026-10-25.en.md). George verbally reported Mac enrollment, trial recognition, and palm stop worked for ID-01 (no numbers in repo). **ID-02 has not been tested on Mac** for actual sentences heard on either route, model adherence, timing, and concurrent load. **Thresholds are uncalibrated**; George chose to use names first with honest labeling. The API-key route's composed short sentence briefly passes through the renderer. Browser mode does not recognize people and says only “I'm here” |
| Long-term memory, knowledge graph, skill promotion | MEM-0 has core-private encrypted snapshots, receipts, source capabilities, and isolated revocation modules. Product personal / family preference memory is not enabled | Real AES-GCM, native cross-process lock, SIGKILL recovery, source and whole-call lease fixtures. A packaged Electron 44.9.3 probe passed real Keychain cross-process readback of 1,000 fictional memories | [16 Family memory design](16_Nous_Memory_Layer_Design_2026-10-26.en.md), [ADR-0002](adr/ADR-0002-nous-family-memory.en.md), [MEM-0 evidence](validation/memory-mem0-2026-10-26.en.md). Production signing / denial, physical playback stop, performance, and MEM-1 / MEM-2 product journeys need checks. No memory injection into either voice route or background tasks |

Ordinary conversation history exists in current page memory and is cleared on reload. Saved tasks and artifacts survive. Do not confuse their lifecycles.

A further check on 2026-10-26 against main `ca7a8fe` found ordinary conversations retain at most nine question-answer pairs, new live calls do not restore prior transcripts, and family recognition is only for names, with no preference fields. Nous connecting directly to the Codex backend does not use the Codex App / CLI memory store. After design delivery, a separate MEM-0 implementation batch began, containing isolated foundations and probes only, without new product memory capability.

<a id="目前執行流程與邊界"></a>
## Runtime flow and boundaries

Background tasks follow HTTP submission → TaskRunner → ProviderManager / executor → Artifact → SSE. The Claude executor plans, generates content step by step, and synthesizes results, with optional search. It does not provide arbitrary local file or shell tools.

Realtime voice tools still involve renderer dispatch and invocation. A live session belongs to its owner's SSE connection, and disconnect ends the call. Cross-device continuation therefore requires server task state, deduplication, pairing, and event recovery. Copying the page is insufficient.

The core binds only to `127.0.0.1`, with local-only Host / Origin checks. Quest's localhost means Quest itself. Remote access needs a separately designed authenticated HTTPS device endpoint rather than loosening current guards.

Presentation Policy currently permits only verifiable `user_request` and `action_confirmation`. Subscribed reminders, automatic background surfaces, and a permanent spatial task wall are unsupported. Gaze selects only and does not authorize an action.

OpenClaw supplies references for some voice protocols, constants, and implementation approaches. There is no Gateway or agent-run adapter. Model new workers separately from model providers.

<a id="最新可核對的驗證"></a>
<a id="中英文文件與介面2026-10-26"></a>
## Bilingual documentation and interface (2026-10-26)

App and web now support saved Traditional Chinese / English selection, including native menus, settings, status, accessible copy, and language for new conversations and tasks. All 58 existing project documents have complete bilingual versions; subsequent agents must synchronize them under the bilingual policy. This batch passed 69 test files and 1,086 tests with one existing skip, plus five web and three Electron language journeys using an isolated mock core. All nine existing browser regression journeys passed. Real-model and physical English audio acceptance remain pending, and no production App was released or replaced. See the [language guide](development/localization.en.md) and [batch evidence](validation/bilingual-2026-10-26.en.md).

<a id="最新可核對的驗證"></a>
## Latest verifiable checks

On 2026-10-24, existing `scripts/verify-aios.mjs` ran under Node.js 22.23.3: 48 test files and 790 tests passed, along with type checks, Vite build, isolated mock task / artifact persistence, and direct-conversation HTTP journeys. The pinned pstack check also passed. See [this verification record](validation/implementation-review-2026-10-24.en.md).

This run did not perform real model inference, operate home devices, start Quest, or measure physical cameras, microphones, or speakers. Code tests do not increase hardware completion.

Existing [live voice record §4](validation/live-voice-2026-10-23.en.md#4-真實結果george-家中測試) records working Mac login, calls, and sideband. After the model-list fix, temperature queries have only verbal success reports, without screenshots or timing. The prototype's Continue with ChatGPT / Sign in with ChatGPT is a separate login and cannot be accepted from Codex live results.

<a id="下一步與文件效力"></a>
## Next steps and document authority

The [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) recommends shared capability policy, resumable tasks, and device pairing first, followed by Quest spatial results and a restricted OpenClaw worker. F0–F10 are suggested features and Q0–Q4 are proposed acceptance stages. This batch delivered a documentation inventory only. Product CI proposed by F0 has not been added.

The [family recognition and named greeting plan](14_Family_Recognition_and_Greeting_Plan_2026-10.en.md) runs close-range recognition during the existing look-to-talk wait. Recognizing a familiar person remains silent. Use a name only after interaction starts and voice is ready. Recognition adds no wait; failure gets a generic greeting. ID-00 delivered a draft ADR and a runtime spike outside the product (cloud CPU / WASM measurements). ID-01 has enrollment, deletion, encrypted persistence, and trial recognition code, tried by George on Mac. ID-02 has concurrent look-to-talk recognition and named greetings on both routes, with cloud fixtures only and uncalibrated thresholds. ID-03 hardware / held-out-sample acceptance and threshold calibration remain planned. None of this establishes completed capability or identity-based authorization.

Formal product rules still follow [CLAUDE.md](../CLAUDE.en.md), [06](06_Ambient_Voice_Gaze_Experience.en.md), [07](07_Ambient_Implementation_and_Acceptance.en.md), and explicitly dated topic decisions. Do not mark G0–G3 passed because of this document or green tests. 01–05 and 08 preserve historical designs, choices, and schedules. Old versions, prices, and external ecosystem information were not comprehensively rechecked in this update.

Maintain four states in documentation: code exists, automated / fixture evidence, hardware evidence, and unimplemented proposal. Without evidence, leave validation pending and link the source.
