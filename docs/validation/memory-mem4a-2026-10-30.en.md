<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem4a-2026-10-30.md) | [English](memory-mem4a-2026-10-30.en.md)

# MEM-4a task encryption, automatic memory for background tasks, and revoke propagation: cloud validation and Mac gate

Dated 2026-10-30, Asia/Taipei. The starting point is main `368235a` (which already contains MEM-0 to MEM-3 and HIST-1). The work was done on the separate worktree branch `claude/mem-4a` and was not committed, pushed, or merged. Every person, account, task, and memory item is a fictional canary.

**Batch status: the MEM-4a code and the parts that can be checked in the cloud (Linux) are complete; every Mac gate step is unexecuted and has not passed.** Task encryption is always on in the macOS App; automatic memory for background tasks is **off by default** (it is enabled only when `NOUS_MEMORY_ROUTES` lists `task`). This does not show that Nous on real hardware already encrypts tasks safely or lets background tasks use memory safely. The browser build has no safeStorage / Keychain, so it stays plaintext and does not migrate.

## 1. Owner decisions (George, 2026-10-30)

1. **The macOS App encrypts all tasks**, not only tasks that use memory: `tasks.json` (titles are the user's original sentence, step titles, errors) and `artifacts.json` (content, assumptions, capability gaps). The existing plaintext is migrated once, inside the App, reversibly: read the plaintext → encrypt and write → decrypt and verify every record → move the originals to `userData/data/plaintext-backup-<date>/` (0700) → keep the backup until the user confirms deletion on screen. Any failure leaves the plaintext untouched and is reported honestly. The browser build neither encrypts nor migrates.
2. **Background tasks carry memory automatically**, with no extra card button: a delegation from a turn that used memory, or any delegation while memory is on, goes through a protected delegation (retrieval through the same MemoryService with 8 facts / 4 KB; consent reuses the task engine's claude / chatgpt consent (Q4-A); the person comes from the current presence; the source ticket comes from the direct user input). Executor input gains `facts?`, and the system prompt gains the memoryBlock. The mock engine gets no memory. The release flag is `task` in `NOUS_MEMORY_ROUTES`, off by default; when it is off, behavior is the same as M15. The title can only be the user's original sentence. Web search is allowed (Q4-A); see §7 for the residual risk.
3. **Revoke propagation (Q3-A)**: forgetting, correcting, consent revocation, person deletion, and turning memory off all propagate to the results that used those memories: the result content is deleted (the decision called it crypto-shred; the implementation deletes the encrypted file, see §2.1), and a shell remains with the fixed text "This result used memory that has since been forgotten, so its content was removed" and "Redo". A running task whose dependencies are revoked stops (reason `memory_revoked`), produces no result, and late output is dropped. Switching person or going idle does **not** abort running tasks. Redo retrieves the current memory again and never reuses old dependencies.

## 2. Design and implementation

### 2.1 Encrypted storage (`server/sealed-vault.ts`)

- One file per record, under `userData/data/sealed/`: the task `task_<uuid>.enc` (the user's original sentence, step titles, errors) and the result `artifact_<uuid>.enc` (content, assumptions, capability gaps).
- Each file has its own random data key, AES-256-GCM; the data key is wrapped by the same safeStorage secretBox as memory and stored in the file header. The AAD binds format, version, kind, and ID: a renamed or modified file does not decrypt.
- Files are 0600 and the directory is 0700; writes go unique temp file → fsync → rename → directory fsync (the same as `server/memory/store.ts`). Deletion is file deletion: that data key exists only in that file, so Nous itself cannot decrypt it afterwards; but this is not a cryptographic erase (crypto-shred), see §7.
- Single writer: `writer.lock` in the directory uses the same BSD lock as the memory file (macOS `/usr/bin/lockf`; Linux tests use `flock(1)`). The only caller is TaskStore (synchronous calls in the core, which cannot interleave); Electron also holds a single-instance lock.
- **Why not the memory file's lock or `userData/memory/results/` (unlike the plan)**: the owner decided to encrypt every task, so task encryption must work whether or not memory is on; the memory file opens only when the user uses memory (tasks must not touch it). Using `data/sealed/` also keeps everything where the menu-bar item "Open tasks and results folder" points. The dependency index (which result used which memory items) is still written only by MemoryService through the memory file's writer lock and mutex.

### 2.2 TaskStore sealed mode (`server/store.ts`)

- `tasks.json` holds only protected shells: `protected: true`, ID, status, timestamps, engine, step count and status, and the brain `domain` (the brain animation is still driven by real events). Titles, step titles, and errors are replaced with fixed bilingual text ("Protected task — view it in the Nous app", "Protected step", "Protected error details — view them in the Nous app"). Sealed mode has no `artifacts.json`.
- The encrypted file is written only on creation, plan completion, status change, errors, result creation, and withdrawal; step progress only changes the shell. (The plan said "on plan completion and terminal states"; this batch also writes on creation so the original sentence is not lost after a crash.)
- The outward methods `publicList` / `publicGet` / `publicArtifact` / `publicDocuments` and `subscribe` always return shells; the full content from `list` / `get` / `getArtifact` / `documents` goes only to the core (executors) and the trusted main window's IPC.
- Restart: the shells decide which tasks exist and their status, and the encrypted files supply the content; running tasks are honestly marked failed; encrypted files without a shell (orphans from an interrupted delete or withdrawal) and result files left over from withdrawn tasks are deleted.
- Hardening (all builds): JSON files are 0600 with a unique temp name, and the file and directory are fsynced; stale temp files are deleted on load. The format is unchanged.
- Key unavailable or lock held: if plaintext already exists, this session stays plaintext (`plain_fallback`, the originals are untouched and migration is retried next time); if there is no plaintext, shells are still written, and new task content stays in memory only, counted and reported.

### 2.3 Plaintext migration (`server/task-migration.ts`)

Steps `read → encrypt → verify → backup → switch`. The backup is a byte-for-byte copy with fsync followed by a comparison (not a rename: after a rename, a crash would leave no `tasks.json`). `switch` first atomically replaces `tasks.json` with shells and then deletes `artifacts.json`; if that deletion fails, `tasks.json` is restored from the backup. Any failed step removes the encrypted files and backup folder written in this attempt, leaves the plaintext originals byte-identical, and keeps this session in plaintext. Migrating again after an interrupted run (where `tasks.json` is already shells and `artifacts.json` still exists) is safe. Backup folders are detected by name and are never deleted automatically, even across restarts; after the user presses "Delete plaintext backup" on screen, the main process shows a native confirmation first (the page cannot forge it), and deletion happens only after "Delete plaintext backup" is chosen there. Deletion only removes files and is not a secure wipe (see §7).

### 2.4 Every outward channel gets shells only

| Channel | In sealed mode |
| --- | --- |
| SSE (`hello`, `task.updated`) | Shells |
| `GET /api/tasks`, `POST /api/tasks`, retry / cancel responses | Shells |
| `GET /api/artifacts/:id` | 404 |
| `GET /api/history`, `/api/history/:id` (the `/history` page) | Shells, `protected: true`, no result and no snippet; the screen shows "Protected task — view it in the Nous app" |
| Chat prompt (the task lines in `chat.ts`) | Real titles only when memory is on and this service account has memory consent for the current person or the household; memory-derived tasks additionally need the dependency index's consent target to be this account and a household or current-person subject (review minor 1); everything else is a shell |
| Realtime instructions (both routes), `get_tasks`, voice completion notices | The same rule as the chat prompt (George, 2026-10-30): live checks `codex` consent and API key checks `openai_realtime` consent; without consent everything is a shell. Instructions come from `RealtimeSessions.tasks(route)`; the page gets `get_tasks` from the core through IPC `voice_tasks`; voice completion notices still use shells |
| Core log | Counts, steps, and status only |
| Trusted main window (macOS App) | Through the IPC channel `nous:tasks`: `list`, `get` (result content), `search`, `redo`, `status`, `delete_backups` |

When local speech synthesis reads a completion notice, it reads the real on-screen title (no model is involved).

### 2.5 In-App results history (part of MEM-4c)

The in-App results history Surface searches the real content of encrypted tasks through the IPC `search` op (in-memory matching in the core, as in HIST-1; the protected source has `protected: true`), and the detail page uses IPC `get`; deletion still uses HTTP (task ID only). The `/history` page and `/api/history` only have shells. What remains for MEM-4c is a RAM inverted index for protected results, discarding it on lock or close, and removing entries inside the same mutex as revocation (today every query rematches from core memory, with no extra index).

### 2.6 Protected delegation (automatic memory for background tasks)

- It exists only when `NOUS_MEMORY_ROUTES` contains `task` (the boundary release table entry `task`, default false), memory is on, and the turn carries a `memory_turn` issued to the trusted main window; when `MemoryContext.delegate` is null, everything behaves as M15.
- After the model emits a delegation marker, at the end of the stream the core, inside the MemoryService mutex: checks the session and epoch → observes the direct input for this turn's original sentence and issues and consumes a one-time source ticket (`issueDelegation` / `consumeDelegation`) → retrieves for the original sentence (current person plus household, the task engine's consent, 8 facts, 4 KB) → if memory was used, writes the dependency index into the memory snapshot first → and only then creates the task (`TaskRunner.submitProtected`). The page receives a `delegated` event (a shell) and no `delegate` or `delegate_blocked`; if the dependency index cannot be written, it falls back to the original-sentence card (M15).
- The title is always the user's original sentence (the text of the core-verified `memory_turn`), never the model's rewrite. The mock engine carries no memory; without consent or relevant memory the task is still delegated, but without memory and without dependencies.
- The executors' (Claude, ChatGPT) system prompt ends with the memoryBlock and a line saying web searches must not include personal preferences or family details from memory; without memory the system prompt is byte-identical to before.
- Redo and retry (App) go through IPC `redo`: the core uses its own saved original sentence and, when released, retrieves the current memory again; HTTP retry still carries no memory.

### 2.7 Dependency index (memory snapshot v3)

The snapshot gains `results: [{id, taskId, subject, deps: [{factId, revision}], target: {provider, account}, createdAt, state}]`, with no content. In memory there is always a `results` field; **on disk it becomes version 3 only when the first protected result is created**, and until then it is written as version 2 with the same fields and order as MEM-3 (checked field by field in tests). Older Apps treat version 3 as corrupt and disable memory (without overwriting it); to roll back to an older App, turn off the `task` flag first, and no protected result may have been created yet.

### 2.8 Revoke propagation

Every operation that changes memory goes through `MemoryService.commit`, and the same commit uses `withdrawals(before, after)` to decide which results to withdraw: memory turned off; the person deleted; any dependency deleted or its revision changed (forget, correct, expiry); consent for that service account no longer holding for the dependency's scope. Withdrawn entries become `withdrawn` (with `deps` and the person cleared), and the task side is notified only after the snapshot write succeeds:

- Queued: stopped, `cancel_reason: memory_revoked`;
- Running: marked cancelling and aborted; any later progress or result from the executor is dropped, ending as `cancelled` + `memory_revoked` with no result;
- Finished: the encrypted result file is deleted, step titles are replaced with fixed text, `withdrawn: true`, and the user's original sentence, the shell, and Redo remain.

When the memory file opens, withdrawn results are propagated again (covering a crash after the snapshot write and before the result file was deleted); TaskStore also removes orphans on load. Switching person, suspension, idling, and OS lock are not part of the withdrawal rules.

### 2.9 Interface (bilingual, shared translation tables)

The migration result and plaintext-backup notice ("Delete plaintext backup", "Later"), the native confirmation dialog, migration failure step names, the shell texts, the withdrawn text, the `memory_revoked` explanation, Redo, and IPC errors are all in `src/messages.en.json`, `server/messages.en.json`, or `desktop/messages.en.json`. The notice is not a Surface (like the delegation card, it is a small prompt); "Later" only hides it for this session.

## 3. Deviations from the plan or the decisions (recorded as they are)

1. The encrypted files live in `userData/data/sealed/`, not `userData/memory/results/`, and do not share the memory file's writer lock (reasons in §2.1).
2. The task's encrypted file is also written on creation (the plan only said plan completion and terminal states), so the original sentence survives a crash.
3. Delegations from realtime voice (ChatGPT plan and API key) that carry memory were **not** changed to protected delegation; they still show the M15 original-sentence card (`delegatePolicy` is unchanged). A voice source ticket has to be built from sideband / side-channel transcripts, which is a larger scope that George decided on 2026-10-30 to leave for the next batch (MEM-4b); "Delegate" on that card still creates a task without memory.
4. Whether a model sees real task titles: memory is on, and that target has memory consent for the current person or the household; memory-derived tasks additionally need the same consent target and an in-scope person. Realtime voice follows the consent for its route (George's decision of 2026-10-30, replacing the earlier "realtime voice always gets shells").
5. The App touches the Keychain at startup (to open tasks and to migrate), unlike the memory layer's "open only on use"; this follows directly from "encrypt all tasks".
6. When the key is unavailable and plaintext exists, this session stays plaintext (`plain_fallback`) with a notice (the plaintext was already there; nothing new is written as plaintext); without plaintext, new task content stays in memory only with a notice, and plaintext is never written (confirmed by George, 2026-10-30). In both states there is no protected delegation (review M1).
7. An expired memory item is removed on the next commit and also withdraws the results that used it (not in the plan, but the same rule as "dependency deleted").
8. "Retry" in the App also goes through the IPC redo (re-retrieving memory when released); HTTP retry is unchanged.

## 4. Cloud (Linux) validation

Node.js 22.22.0. Real AES-256-GCM, real rename / fsync, with `flock(1)` as the test lock on Linux; only the data key wrapping is fake (the production App uses safeStorage / Keychain). Executors and chat engines are fakes and call no model.

| Test file | Content |
| --- | --- |
| `tests/task-vault.test.ts` (new, 28) | 0600 / 0700, round trip, no plaintext; AAD (renamed or tampered files do not decrypt); a new key on every write, deletion deletes the file; refusal without a key, with a second writer, or with wrong permissions; a crash before rename leaves only a temp file that the next open removes; JSON hardening (0600, unique temp file); the browser build's format is unchanged; sealed-mode shells, no `artifacts.json`, reload after restart, running marked failed, orphan cleanup, key unavailable, deleting both encrypted files; a successful migration (backup 0700, byte-identical, kept until deleted) and a failure at each of `read` / `encrypt` / `verify` / `backup` / `switch` leaving the plaintext byte-identical with no encrypted files and no backup; no migration when the key is unavailable; review B1 (Keychain refusal, one undecryptable file, 0644, a corrupt file: nothing deleted or rewritten, readable next time), minor 2 (withdraw writes the shell first), M4a (memory-off hint withdraws on load), M3 (failure after the switch, and the reviewer's probe 2) |
| `tests/memory-tasks.test.ts` (new, 26) | Protected delegation: retrieval for the original sentence, the executor receives memory (without IDs), the dependency index is written first (snapshot v3); the memory block in the system prompt; 8 facts / 4 KB; no memory for the mock engine; no memory without consent; flag off behaves as M15 and the snapshot stays version 2 with the MEM-3 field order; each of six revoke paths (forget, correct, consent revocation, person deletion, memory off, forget all) deletes the result file and leaves a shell; revoked while running, with the late result dropped; switching person, idling, and OS lock do not abort; an unrelated forget has no effect; redo retrieves again and never reuses old dependencies; leftover result files are removed when memory reopens after a crash; a delegation racing a forget never leaves an active result pointing at forgotten memory; the `withdrawals` rule table; log and file canary; review M1 (no delegation unless actually encrypted), M4b (index overflow withdraws), minor 3 (expiry sweep), minor 4 (no memory if the account changed), a stronger concurrency assertion |
| `tests/task-redaction.test.ts` (new, 7) | SSE, `/api/tasks`, `/api/artifacts` (404), `/api/history`, `/api/history/:id`, and files on disk contain no canary; realtime voice and chat get real titles or shells by target consent, person, and consent target (`tasksForTarget`); a service account without consent sees only shells in the chat prompt and one with consent sees real titles; protected delegation over `/api/chat` (the page receives only a shell, no model rewrite, the executor receives memory); flag off behaves as M15; the browser build is unaffected |
| `tests/tasks-ipc.test.ts` (new, 9) | IPC shape filter and op list match; the main process checks the sender before filtering, preload only invokes `nous:tasks`, the packaging script copies the new file; core `list` / `get` / `search` / `redo`; the plaintext backup is kept until the user confirms (cancelling the native confirmation deletes nothing); renderer overlay logic and notice text; review M2 (only tasks whose title is the user's own sentence use memory on redo; unreadable tasks cannot be redone), minor 7 (person scope, menu click and 10-minute window, `voice_tasks`), minor 8 (the notice appears only on the migration run or when opened manually) |
| `tests/history-surface.test.ts` (+3) | A withdrawn result shows the fixed text and Redo (Chinese and English), the `memory_revoked` explanation; on the `/history` page a protected item shows only the fixed text with no snippet; in the App a withdrawn detail keeps the original sentence and offers Redo |
| Existing test changes | `tests/apikey-route.test.ts` (`task` in `NOUS_MEMORY_ROUTES`), `tests/identity-ipc.test.ts` (preload has one more entry, `tasks`), `tests/memory-ipc.test.ts` (memory and tasks share the secretBox) |

### Test results (actual output of this batch)

```text
npm run typecheck                      (no errors)
npx vitest run                         Test Files  90 passed (90)
                                       Tests  1542 passed | 4 skipped (1546)
npx vite build                         ✓ built
node --check desktop/*.mjs             (no errors)
node scripts/verify-aios.mjs           PASS
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed
node scripts/check-pstack.mjs          pstack 0.15.29: ... verified.
git diff --check                       (no output)
```

The baseline main `368235a` has 86 test files, 1469 passed, 4 skipped (this batch adds 73 tests). On the first run of `node scripts/verify-aios.mjs`, the existing HIST-1 performance test (`tests/history-search.test.ts:162`, 200 ms limit) timed out under load; the rerun PASSED. That test is not new in this batch.

## 5. Mac gate (none executed; no pass may be claimed)

1. First launch of an App with existing plaintext data: after Keychain approval the migration succeeds; `data/` holds only the shell `tasks.json`, `sealed/`, and `plaintext-backup-<date>/`; the migration notice appears; `grep -r` confirms `data/` (excluding the backup) has no original sentence or result text.
2. Keychain denied: stays plaintext, originals untouched, honest notice; migration happens only after approval and a restart.
3. Force-quit in the middle of migration (once per step): after restart the plaintext is intact, or the migration has completed; no half state.
4. Press "Delete plaintext backup" → native confirmation: Cancel deletes nothing; Confirm removes the folder; the limits around Time Machine exclusion and existing snapshots are stated honestly.
5. Progress cards, the result view, and the in-App results history show real titles and content; a separate browser at `http://127.0.0.1:<port>/history` and `/api/tasks`, `/api/artifacts/<id>` sees only shells or 404.
6. `NOUS_MEMORY_ROUTES=task`: once each with Claude and ChatGPT, a delegated result reflects memory; the mock engine carries none; no consent carries none.
7. Forget the memory item while the task runs: the task stops within seconds, shows the `memory_revoked` explanation, and has no result; forget after completion: the result disappears, the shell and Redo remain, and the encrypted result file is deleted.
8. Switching person, 30 minutes idle, OS lock: running protected tasks still complete.
9. An older App opening a version 3 memory snapshot: memory is disabled and the file is not overwritten (George accepted this rollback limit on 2026-10-30).
10. safeStorage read-back in a packaged and signed build, and the two-core lock (a second core cannot write `sealed/`).
11. Restart after migration with the Keychain refusing access (or with changed permissions): tasks show only shells, the key notice appears, and the files in `sealed/` are byte-identical; after allowing access and restarting again, every original sentence and result comes back.

## 6. Unfinished items and next gate

- Protected delegation for realtime voice (see §3 item 3).
- The rest of MEM-4c: a RAM inverted index for protected results that is discarded on lock; today in-App search rematches in core memory every time.
- Sourced work summaries (work_summary) and automatic curation are in MEM-5.
- Next gate: Mac steps 1–11 in §5, especially steps 1, 3, 5, 7, and 11.

## 7. Residual risks

- **Deletion is not a secure wipe**: deleting a file only removes that file and its data key; existing Time Machine backups, local APFS snapshots, or not-yet-overwritten disk blocks may still hold the old file, and the application key does not rotate, so they could theoretically still be decrypted. A deleted plaintext backup may likewise remain in snapshots.
- **Web search**: web search is allowed (Q4-A). The model may write memory content into search queries, which go to the same service account's search (Claude or ChatGPT); the system prompt warns against it but cannot guarantee it.
- **Core memory**: while the core runs, its memory holds every task in plaintext (executors and the App screens need it); encryption only protects files on disk.
- **Trusted main window**: real content reaches the main window through IPC; a script injected into the main window page could read it (the same trust boundary as the memory IPC).
- **Titles visible to models**: a service account with memory consent sees real task titles in the chat prompt.
- **Rollback**: once the memory snapshot is version 3, older Apps disable memory (accepted by George, 2026-10-30).
- **The dependency index lives in the memory file**: if the memory file is corrupted or deleted, the index is lost with it, and later revoke propagation cannot find those results (they stay encrypted but are not removed by a forget); only the "memory off" hint withdraws all memory-derived results on the next start.
- **Results history cache**: HIST-1's `CONTENT_CACHE` keeps folded result plaintext in core memory (never written to disk) and is cleared on deletion and withdrawal.
- **Character counts in shells**: shells keep each step's `output_chars` (the App's progress and counts need it), so outsiders can see output length but not content.
- **Keychain at startup**: the App needs Keychain approval at startup; otherwise it stays plaintext (when plaintext exists) or keeps content in memory only.

## 8. Independent review and fixes (2026-10-30)

The review found 1 blocker, 4 majors, 8 minors, and several nits; George also made decisions the same day (with the key unavailable, keep content in memory only and never write plaintext; realtime voice gets titles by route consent; protected delegation for realtime voice moves to MEM-4b; older Apps being unable to read version 3 is accepted; the in-App list follows the D2 person scope). The fixes below all have regression tests (the reviewer's probe scenarios are folded into `tests/task-vault.test.ts`):

| Item | Fix |
| --- | --- |
| B1 unreadable treated as orphan, deleted, and rewritten as a shell | An unreadable task keeps its ID and is tracked as unreadable; it is never sealed, rewritten, or deleted, and only the shell changes. On key refusal or wrong permissions, orphan cleanup is skipped entirely and the reason recorded. `SealedVault.open` wraps and unwraps a key once (it does not open when the Keychain refuses decryption). |
| M1 protected delegation in plaintext fallback | Without `TaskPort.sealed()` (sealed mode and no key trouble) there is no protected delegation; the original-sentence card is shown. |
| M3 a failure after the switch deleted encrypted files and the backup | After the shells are written, the encrypted files and the backup are never deleted; if removing `artifacts.json` fails, `tasks.json` is restored from the backup via an O_EXCL temp file, fsync, rename, and directory fsync. An interrupted migration reuses a backup with identical content instead of creating `-2`. |
| M2 redo issued a ticket for arbitrary text | New field `origin: "user_sentence"` (protected delegation, or a `POST /api/tasks` explicitly marked as typed); only such tasks re-retrieve memory on redo, others redo normally; tasks whose content cannot be read cannot be redone. |
| M4 withdrawal durability | (a) the memory-off hint withdraws all memory-derived results when tasks load; (b) an active entry pushed out by the index limit is withdrawn too; (c) a corrupt memory file losing the index is listed as a residual risk. |
| minor 1 | Memory-derived tasks give real titles only to the same consent target with an in-scope person; realtime voice follows the same rule. |
| minor 2 | Deletion and withdrawal write the shell first, then delete encrypted files; leftovers from an interruption are removed by orphan cleanup on load. |
| minor 3 | Every minute (and on each operation) the core checks for expired dependencies and, if any, commits once so running tasks stop at once. |
| minor 4 | Before running, the core checks that the task engine's current account is still the consent target; otherwise no memory is carried. |
| minor 5 | "crypto-shred" is now called file deletion, with a note that it is not a cryptographic erase. |
| minor 6 | `sealed/` and plaintext backup folders are excluded from Time Machine (failures are only logged). |
| minor 7 | The in-App list, detail, and search show real content for tasks without memory and for household or current-person memory tasks; other family members' memory tasks are shells unless opened from the menu-bar "Results history…" (within 10 seconds of the click, then valid for 10 minutes, revoked on main-window navigation). |
| minor 8 | The migration notice appears automatically only on the migration run (or when encryption is unavailable); otherwise it is opened from the menu-bar "Delete plaintext backup…". |
| nits | "Only finished tasks can be redone" now uses a Chinese source string with a translation; the migration notice no longer shows misleading counts; the `POST /api/tasks` response is the shell directly; the concurrency test assertion is stronger; `output_chars` is kept (see §7). |

## 9. Rerun

```sh
cd prototype/ambient-shell
npm ci
npx vitest run tests/task-vault.test.ts tests/memory-tasks.test.ts tests/task-redaction.test.ts tests/tasks-ipc.test.ts tests/history-surface.test.ts
cd ../..
node scripts/verify-aios.mjs
```

Linux needs `flock` from util-linux; without it the real-file tests are skipped rather than pretending to pass.
