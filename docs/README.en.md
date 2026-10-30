<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

<a id="nous-文件索引"></a>
# Nous documentation index

Updated 2026-10-30 with the cloud verification entries for family memory MEM-2 (ChatGPT plan realtime voice) and MEM-3 (OpenAI API key realtime voice, memory off by default); neither Mac gate has been run. The 2026-10-29 update added the local wake word and family voice recognition plan (unimplemented), and the same day the WK-00 wake-word spike validation, the ADR-0003 draft, and the cloud verification entry for family memory MEM-1, now merged into main (Mac gate not run). The 2026-10-26 update added the family memory design and MEM-0 isolated verification entry points. The product direction is “idle electronic brain → voice request → actual work → results on demand → point and ask follow-up questions.” A Node / TypeScript / Electron prototype exists. Formal G0–G3 acceptance still requires evidence for each item.

<a id="先讀目前狀態再讀產品規則"></a>
## Read current status before product rules

| Document | Purpose and authority |
|---|---|
| [Current implementation and verification](Current_Implementation_Status.en.md) | Current entry point: actual directories, implemented capabilities, pending acceptance, gaps, tests, and hardware evidence |
| [13 Feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) | Ideas for Quest, OpenClaw, realtime voice, sensing, and multiple devices. F0–F10 and Q0–Q4 are not thereby implemented |
| [14 Family recognition and named greetings](14_Family_Recognition_and_Greeting_Plan_2026-10.en.md) | Recognize during the existing facing delay and use a name only after interaction. Code exists for the ID-00 spike, ID-01 enrollment / trial recognition, and ID-02 look-to-talk named greetings. ID-02 has cloud fixtures only and uncalibrated thresholds |
| [ADR-0001 Local family recognition (draft)](adr/ADR-0001-local-family-recognition.en.md) | Data lifecycle, keys, cloud voice, identity distinct from authorization, model licensing checks, and decisions pending George |
| [15 Companion Mode specification](15_Companion_Mode_Spec_2026-10-24.en.md) | **Unimplemented proposal**: optional natural companionship, four preferences, background capture permission and actual state, privacy, voice ownership, and acceptance |
| [16 Nous family memory layer design](16_Nous_Memory_Layer_Design_2026-10-26.en.md) | Design contract. MEM-0 has [isolated foundation verification](validation/memory-mem0-2026-10-26.en.md); MEM-1 (people, explicit save / correct / forget, and Claude / ChatGPT access in ordinary desktop text chat) is complete in code and cloud tests, see [MEM-1 validation](validation/memory-mem1-2026-10-29.en.md); MEM-2 (recall, spoken-confirmation remember / correct / forget, revocation, and rebuild on ChatGPT plan realtime voice) is complete in code and cloud tests, see [MEM-2 validation](validation/memory-mem2-2026-10-30.en.md); MEM-3 (the same memory rules on OpenAI API key realtime voice, a core sideband, two stops, and cross-route consistency, with memory off by default) is complete in code and cloud tests, see [MEM-3 validation](validation/memory-mem3-2026-10-30.en.md); none of the three Mac gates has been run. MEM-4 is split into HIST-1 (results history for ordinary tasks, complete in code and cloud tests, see [HIST-1 validation](validation/history-hist1-2026-10-30.en.md), Mac verification not run), MEM-4a (encryption of all tasks in the macOS App, automatic memory for background tasks (off by default), and revoke propagation, complete in code and cloud tests, see [MEM-4a validation](validation/memory-mem4a-2026-10-30.en.md), Mac gate not run), and MEM-4c (only in-App search of encrypted tasks through IPC is done) |
| [ADR-0002 Family memory (draft)](adr/ADR-0002-nous-family-memory.en.md) | Encrypted snapshots versus SQLite. First-version shared ordinary family preferences, cloud consent, background tasks, and private memory boundaries |
| [ADR-0003 Local wake word and voice recognition (draft)](adr/ADR-0003-local-wake-and-voice-recognition.en.md) | Draft delivered with WK-00: supersedes ADR-0001 "no background always-on recognition", countermeasures for wake events the core cannot verify, residual risk, gallery v2, sherpa-onnx pinned to 2.0.x (1.13.8 statically links GPL espeak-ng), and the license review table; no product implementation |
| [17 Local wake word and family voice recognition](17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.en.md) | **Planned, unimplemented** (2026-10-29): wake word candidates and recommendation, license comparison of engines and speaker models, privacy and capture indicators for always-on local listening, voice enrollment, face-voice fusion, convenience limits that are not authorization, memory person rules aligned with 16; George decided all nine items on 2026-10-29 (including automatic resume of always-on listening after reopen and voice-only named greetings after calibration) |
| [06 Electronic brain, voice, and gaze experience](06_Ambient_Voice_Gaze_Experience.en.md) | Product rules, presentation policy, and behavior requirements. Keep target architecture separate from current state |
| [07 Development and acceptance plan](07_Ambient_Implementation_and_Acceptance.en.md) | Formal contracts, gates, and acceptance methods. Planned directories are not existing code directories |
| [10 Distance UI](10_Distance_UI_18inch_2026-10.en.md) | 18-inch and distance UI specification. Distance zoom exists in the prototype; readability needs hardware checks |
| [11 Stereo camera interaction](11_Stereo_Camera_Interaction_2026-10.en.md) | Head facing, distance estimation, stop gesture, three-region pointing, and settings are implemented. This is not eye tracking; stereo is uncalibrated |
| [12 Smart home](12_SmartHome_Integration_Plan_2026-10.en.md) | H0, H1, H1b have code and some verbal home reports. H2–H4 are unimplemented |

<a id="歷史藍圖與決策"></a>
## Historical blueprints and decisions

| Document | How to read it |
|---|---|
| [01 Complete technical blueprint](01_Complete_Technical_Blueprint.en.md) | Seven-module target architecture and original 12-month plan. Not the current capability table |
| [02 OSS component map](02_OSS_Component_Map.en.md) | Integration strategy and choices at the time. Recheck versions, prices, and licenses before adoption |
| [03 Three-month roadmap](03_3Month_Accelerated_Roadmap.en.md) | Old weekly schedule, not current progress or committed dates |
| [04 Generative interaction](04_Generative_Interaction_System.en.md) | Foundational interaction design. 06–07 override old permanent dashboard / sidebar descriptions |
| [05 Progress and next steps](05_Progress_and_Next_Steps.en.md) | Original progress snapshot and requirement evolution |
| [08 October 2026 consolidation](08_Consolidation_and_Update_2026-10.en.md) | Historical status, ADR proposals, and old schedule from 2026-10-07. “No code yet” at that time is not today's state |

Number 09, “Spoken Brief,” references an external Project document that is not included in this repository. This index does not claim the repository contains it.

<a id="執行開發與證據"></a>
<a id="中英文版本與介面"></a>
## Bilingual documents and interface

Use the language links at the top of every document. Follow the [bilingual policy](BILINGUAL.md) when adding or updating either version. [App/web language support](development/localization.en.md) covers switching, persistence, English commands, and maintenance. The [validation record](validation/bilingual-2026-10-26.en.md) distinguishes code/UI evidence from pending hardware checks.

<a id="執行開發與證據"></a>
## Run, develop, and review evidence

- [Root setup entry point](../SETUP.en.md), [prototype usage](../prototype/ambient-shell/README.en.md), [installation guide](../prototype/ambient-shell/INSTALL.en.md), and [macOS desktop guide](../prototype/ambient-shell/desktop/README.en.md).
- [Development rules](../CLAUDE.en.md), [Agent workflow](../AGENTS.md), and [pstack guide](development/pstack.en.md).
- [Companion Mode implementation batches](development/companion-mode-implementation-plan.en.md): CM-P1–P4, Agent prompts, acceptance, and reporting format (unimplemented).
- [Conversation module design](development/chatgpt-conversation-design.en.md) and [six-region animation](development/brain-regions.en.md), each describing its own batch.
- [Validation record index](validation/README.en.md), distinguishing fixtures, verbal user reports, code tests in each batch, and pending hardware checks.

Current implementation follows the code and corresponding verification records. Product rules follow CLAUDE.md, 06–07, and explicitly dated topic decisions. Feature assessments do not automatically change rules or pass gates. When documents disagree, check date, scope, and evidence first. Preserve history and correct the current entry point.
