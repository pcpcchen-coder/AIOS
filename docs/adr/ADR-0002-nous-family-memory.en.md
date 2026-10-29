<!-- bilingual: source=zh-TW -->

> [繁體中文](ADR-0002-nous-family-memory.md) | [English](ADR-0002-nous-family-memory.en.md)

<a id="adr-0002nous-家庭記憶由本機核心管理"></a>
# ADR-0002: The local Nous core manages family memory

Status: **MEM-0 isolated implementation started at the user's request; product release is not approved**. Date: 2026-10-26. Baseline: `ca7a8fe`. After initial design delivery, a separate implementation conversation delivered the core-private foundation, still disconnected from product routes. See [16 family memory layer design](../16_Nous_Memory_Layer_Design_2026-10-26.en.md) for behavior, fields, wiring, and acceptance, and [MEM-0 validation](../validation/memory-mem0-2026-10-26.en.md) for actual differences.

<a id="問題與現況"></a>
## Problem and current state

Ordinary Nous chat has only page context, and live calls do not load previous content. Tasks and artifacts persist, without preference extraction or retrieval. Family recognition stores only names, face features, and related metadata, for addressing people only. Direct Codex-backend use does not access Codex App / CLI memory.

Nous must therefore own people, sources, corrections, and revocation, then supply necessary excerpts to the current model. Providers cannot maintain incompatible household truths independently.

<a id="呼叫端的用法"></a>
## Caller usage

- With a current person selected, an explicit “remember that I don't eat cilantro” invokes `memory.change`, which validates the core source ticket and persists before returning a success receipt.
- New-conversation adapters use `memory.withContext` for permitted excerpts. On correction, forgetting, or person switch, the service aborts outputs holding old content.
- “What do you remember about me?” uses `memory.inspect` for an on-demand list. It also queries operation results after interruptions.

For voice, `withContext` lasts until the entire call ends, not merely the connection handshake. Models receive compact facts, never person permissions, source tickets, or storage formats.

<a id="建議形狀"></a>
## Proposed shape

One `MemoryService` owns policy and writes. A private `store` handles encryption, atomic replacement, and deduplication. Persist one encrypted snapshot, rebuilding local indexes only in memory. Each write atomically commits facts, versions, consent, and operation receipts without body text.

Version one serves a single Mac with at most 1,000 ordinary memories, without a persistent data service. Profiles and face enrollment use different IDs. Spoken self-identification selects ownership of household-shared preferences and grants no private access.

Initially provide explicit remember, correct, forget, and on-demand inspection. Automatic organization proposes candidates only in later opt-in batches. Do not store full conversations, unawakened audio, or raw images initially. Data is encrypted locally. Authorized use still sends necessary excerpts to the current model, so transmission consent needs a separate explanation.

<a id="方案比較與綜合決定"></a>
## Alternatives and combined decision

Two independent designs were compared and cross-checked by another review seat using the same model. This is independent design review, not cross-model diversity or a performance experiment.

| Option | Complexity it hides | Added cost and limits | Decision |
| --- | --- | --- | --- |
| A: Encrypted aggregate snapshot + in-memory retrieval | One commit for facts, receipts, and revocation version, without a second persistent index | Full rewrite per update. Must handle single writer, capacity, and failure recovery | Initial foundation |
| B: SQLite transactions + encrypted fields + in-memory retrieval | Clear multi-table atomic updates, operations, and dependencies | Runtime / Electron packaging, migrations, WAL, and encrypted-field policy expand verification | Reevaluate when volume or dependencies require it |
| Historical: Plaintext Markdown + FTS5 | Direct human editing and rebuildable full-text index | Personal data spreads into bodies, indexes, and backups. Files and indexes remain dual state requiring consistency | Not the initial default. Markdown only for explicit export |
| External memory service / framework | May provide storage or retrieval | Cannot replace Nous person attribution, source authorization, call revocation, or sharing policy | Not selected initially. No new claim about specific third-party versions |

Cross-review rated personal privacy, reliable updates, actual integration, MVP experience, and maintenance cost from 0–4 each. A scored 17/20 and B 16/20. Scores record judgment and have no statistical meaning. A wins because data is currently small, single-writer ownership is appropriate, and encrypted-storage experience already exists. SQLite integration costs do not yet justify themselves.

Adopt persistent receipt queries, revocation versions, and derived-source dependencies from B, within A's same snapshot, without another writable source. Five review findings are now in document 16's contract: whole-call lifecycle, tickets bound to actual commands, receipts without leftover body text, no memory copied by model delegation into plaintext tasks, and real presentation reasons for clarification cards.

<a id="接受的取捨"></a>
## Accepted tradeoffs

- Initial personal preferences are grouped by person but usable throughout the household. Individual secret spaces need separate authentication. Face calibration is incomplete and gains no broader authorization role.
- Snapshots are easier to audit, but capacity, write times, and Keychain behavior must first be measured on target Mac. Do not claim larger-volume suitability without evidence.
- Local forgetting clears active memories, sources, and affected context. It does not guarantee erasure of provider-received data, exports, or APFS / system backups.
- API-key voice receives no memory before reliable disconnect, playback stop, and reconstruction pass. Live-route results cannot substitute.
- Existing TaskStore is plaintext. Initial memory is excluded from background tasks, and memory-bearing model summaries or transcripts cannot become task titles. Task memory waits for protected artifact storage.
- Initial text retrieval does not guarantee complete semantic recall. Identify gaps with Chinese tests before deciding on vector or SQLite indexes.

<a id="歷史提案與遷移"></a>
## Historical proposals and migration

“ADR-001 memory layer” in 08 was a historical task name, not an implemented memory ADR. Existing `ADR-0001` now covers family recognition. This document uses `ADR-0002` to avoid confusion.

No old memory database currently needs migration. A future snapshot-to-SQLite change first supplies a versioned, integrity-checked, recoverable one-way migration. Switch the sole writer only after confirming the new database. Never allow simultaneous edits to old and new stores. Migrate people, consent, versions, deletion tombstones, and deduplication state, not just memory bodies.

Retain historical content in 01–03, 08, and 13, linking this proposal from status and indexes. Revise against current code and tests before adoption. This design is not an approved product capability.

<a id="待證明與下一步"></a>
## Unproven items and next step

MEM-0 first confirms secure-storage interfaces in packaged Electron, single-writer recovery, source tickets, and actual revocation on both voice routes. Capacity has isolated evidence below. The 50 ms retrieval and 300 ms write budgets remain unmeasured targets.

2026-10-26 MEM-0 isolated addendum: Verified packaged Electron 44.9.3 interfaces, snapshots / native locks, crash recovery, 1,000-item capacity, and source / revocation contracts. A separately packaged App passed encrypted-snapshot storage and cross-process restart readback with real Keychain. Formal Nous signing, actual denial, performance, and physical voice remain pending. Full product service and profile-management interfaces are not integrated. Operation IDs now use a UUIDv7 shape with an immutable time prefix, preventing altered-time replay of the same ID after receipt eviction. This batch's record contains reasons and evidence.

Whether private memory belongs in near-term scope, and how voice sources avoid false writes from television or bystanders, remain product and hardware questions. Version one limits scope to household-usable data and confirmation when unclear. The next acceptance-testable implementation after MEM-0 is the single-person loop of explicit saving, restart retrieval, correction, and forgetting.

MEM-1 addendum, 2026-10-29. That loop is implemented for ordinary desktop text chat (`server/memory/service.ts`, `parse.ts`, `retrieve.ts`); cloud tests pass, the Mac gate has not been run, and product release is still not approved. Differences from the shape in this ADR: the snapshot version is now 2 while the file name stays `store.v1.enc`; the store adds a test-only `lockProvider`, and production still uses only macOS lockf; edit and forget in memory management obtain tickets through the MEM-0 literal grammar, while chat writes use `issueParsed`, in which the core re-parses the original sentence; consent is stored per service + account, separately for a person and the household; a turn that used memory may not delegate, and the user decides with the original sentence instead. Saying “I am X” is enough to view and edit X's household-usable data; this is grouping by person, not identity verification. SourceTicket is a core self-check; the real security boundary is the IPC sender check plus the page only forwarding what the user typed. Item-by-item differences, the 30 queries, and the Mac gate are in [MEM-1 validation](../validation/memory-mem1-2026-10-29.en.md).
