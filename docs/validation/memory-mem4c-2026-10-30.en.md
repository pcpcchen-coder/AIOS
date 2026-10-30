<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem4c-2026-10-30.md) | [English](memory-mem4c-2026-10-30.en.md)

# MEM-4c search index for protected results and the in-memory plaintext lifecycle: cloud validation and Mac gate

Dated 2026-10-30, Asia/Taipei. The starting point is main `4b5de31` (which already contains MEM-0 to MEM-4b and HIST-1). The work was done on the separate worktree branch `claude/mem-4c` and was not committed, pushed, or merged. Every task, result, and memory item is synthetic data or a fictional canary.

**Batch status: the MEM-4c code and the parts that can be checked in the cloud (Linux) are complete; every Mac gate step is unexecuted and has not passed.** This does not show that Nous on real hardware already drops decrypted content after a lock, sleep, or idle period, and it says nothing about search latency on real hardware. The browser build has no encryption (it stays plaintext and keeps the HIST-1 scan) and is unaffected.

## 1. Scope

[MEM-4a §2.5 and §7](memory-mem4a-2026-10-30.en.md#25-in-app-results-history-part-of-mem-4c) left two things for MEM-4c:

1. **Plaintext lifecycle.** Since MEM-4a, the core held every task in plaintext in RAM while it ran, and the HIST-1 `CONTENT_CACHE` held folded result text. This batch stops finished (terminal) protected tasks and results from staying decrypted in core RAM: they are decrypted from the sealed files only when needed, and dropped on OS lock, sleep, idle, memory off, and App quit.
2. **RAM inverted index for protected results.** The in-App results history used to rescan every task in core RAM on each query. It now uses an inverted index that is built on the first authorized search, lives only in RAM, and is dropped together with the plaintext. Its results match the scan item for item.

This batch has no new owner decisions. Design choices and deviations are in §3; questions for George are in §6.

## 2. Design and implementation

### 2.1 Three states (`server/store.ts`, sealed mode only)

| State | Which tasks | What is in RAM |
| --- | --- | --- |
| Active (hot) | Queued, running, and cancelling tasks, plus tasks whose task file or result file could not be sealed (`unsealed`) | Full content (the executor needs it; `unsealed` content exists only in RAM, so dropping it would lose it) |
| Kept in RAM (warm) | Finished tasks that just finished or were recently read through an authorized path, at most `WARM_MAX` = 16 (least recently used dropped first) | Full content (task and result) |
| Dropped (cold) | All other finished tasks whose content is confirmed sealed | Only the shell (`shellOf`: status, times, engine, step count and states, brain `domain`, `memory`, IDs; title, step titles, and error replaced by fixed sentences), no result |

- Progress cards, the brain animation, and SSE all use shell fields, so dropping content does not affect them (the animation is still driven by real events).
- When a dropped task is needed, `loadContent` decrypts the task file and the result file and combines them with the shell through MEM-4a's `merge` (the shell's status is newer). `get`, IPC `get` (`TaskStore.open`), `redo`, and withdrawal put the task back into warm; the list, search, and model titles read without keeping.
- At startup the store still decrypts every file once to verify it, as in MEM-4a (review B1's unreadable, orphan, and interruption handling is unchanged), then drops everything immediately, so all finished tasks become cold.
- A dropped task is only a shell in RAM, so `seal` always skips it: the shell's fixed sentences are never written into a sealed file.
- `unsealed` is tracked per record ID (task `task_id` and result `artifact_id` separately; review B1): a successful write removes only that record, a task cannot be dropped while either the task or its result is still unwritten, and an unwritten result is retried on the task's next update. `vaultStatus().unsealed` counts tasks.

### 2.2 When content is dropped

`TaskStore.dropPlaintext(reason)` clears the warm content, the inverted index, the model title cache, and the HIST-1 `CONTENT_CACHE`; active tasks and `unsealed` tasks are left alone. The log records only the reason and counts.

| Trigger | Wiring | reason |
| --- | --- | --- |
| OS lock | `powerMonitor` `lock-screen` in `desktop/main.mjs` (the same event that suspends the current person in the memory layer) → `core.tasks.dropPlaintext` | `os_lock` |
| Sleep | `powerMonitor` `suspend` (newly wired; the memory layer does not use this event) | `suspend` |
| Idle | `PLAINTEXT_IDLE_MS` = 10 minutes since the last authorized access (IPC detail, search, and redo; startup also counts as a starting point); the core checks once a minute (`nous.ts`) and also before every authorized access. Task completion, cancellation, revoke propagation, internal core reads, and model titles do not restart the timer (review minor 2) | `idle` |
| Memory off | After `MemoryService.setup` switches memory off and the write succeeds → `onPlaintextDrop` | `memory_off` |
| Memory layer closed | `MemoryService.shutdown`, or the memory file being disabled after a failed write → `onPlaintextDrop` | `memory_closed` |
| App quit | `core.close()` (`will-quit`), before the sealed folder is closed | `quit` |

Why not reuse the memory layer's 30-minute idle (`MEMORY_IDLE_MS`): it only runs while a current person is selected, so it never fires when nobody is selected. This batch uses a separate 10 minutes (the same as the memory management screen's `MANAGE_IDLE_MS`). The timer runs once a minute, so the real maximum is about 11 minutes. Model titles (§2.4) do not extend the timer.

**The page is cleared too (review M1).** On every drop (whether or not the core had anything to drop), `TaskStore` notifies its subscribers; `nous.ts` passes this to the main process through `TasksInjection.onPlaintextDropped`, and the main process sends `tasks:plaintext-dropped` (only an allow-listed reason, no content; when the core is absent, the main process sends lock and sleep itself). The preload forwards only allow-listed reasons. When the page receives it (`applyPlaintextDrop`), it clears the `ProtectedTasks` real-title cache (replies to earlier requests are not written back), protected result content and errors, and the results history's results, snippets, detail page, and query text, and shows "Content hidden after lock; search again" (after idle or a memory setting change: "Content hidden after inactivity or a memory setting change; search again"); if a protected result is on screen, that view is collapsed (it only closes the view and never stops a task). Afterwards the page **no longer reads every task at once** (it does not call `loadAll`, at startup either); it reads back through IPC `get` only the progress cards on screen (the first 8 in progress order) and the foreground task.

### 2.3 Honest reporting when the key is unavailable

If the key is unavailable while reloading (for example, Keychain denies access after an unlock), `loadContent` throws `VaultError`, and IPC `search`, `get`, and `redo` return `{ ok: false, code: "unavailable", message: RELOAD_FAILED }` ("The encrypted task content could not be decrypted this time (key unavailable); it is still stored safely on this Mac. Please try again later."; the sentence is in both `server/messages.en.json` and `src/messages.en.json`). The screen shows "Could not search results history: …" or "Could not load this record: …". It **never returns an empty result** and never passes a shell off as content. This failure is temporary (recorded in `reloadFailed`; reading works again when the key comes back), and the sealed files stay byte-for-byte unchanged. A corrupt file or wrong permissions follow MEM-4a review B1 instead: the task is marked unreadable for this run, shown only as a shell, and never rewritten; an unreadable result file is remembered and not decrypted or logged again in this run (review minor 4). The list (IPC `list`) returns shells while the key is unavailable. A redo during a memory withdrawal commit returns "Memory is updating; try again shortly" (review minor 3).

### 2.4 Titles for models (`tasksForTarget` → `TaskStore.modelTasks`)

The rules are still MEM-4a's (the target must have memory consent; a task with memory also needs the same consent target and a person in scope). IPC `list` uses the same title cache and reads only task files (review minor 5), and logs one line with only the count, the number of decrypted files, and the time. For dropped tasks, only the first `TITLE_PEEK` = 8 in progress order (`sortForProgress`; status and times are in the shell) are considered. `get_tasks` shows 8, and the chat prompt and the realtime voice instructions show 6 each, so models never see the 9th and later entries anyway. Only those 8 **task files** are decrypted (results are not read), and they go into a title cache of at most `TITLE_CACHE_MAX` = 16. Everything else stays a shell. Chat does not extend the idle timer; the cache is cleared on every drop, after which each turn decrypts at most 8 small files again. A task that cannot be decrypted or read is given as a shell. Tasks being withdrawn, or cancelling because their memory was revoked (§2.6), are always shells.

### 2.5 RAM inverted index (`server/protected-index.ts`)

- **Building.** The index is built on the first authorized search (IPC `search` with a query). Each finished task whose content is sealed is decrypted once (without being kept), its fields are produced by the same `prepareFields` as HIST-1 (Markdown to plain text, `foldForSearch` simplified/traditional and lowercase folding), and only the **folded** fields are kept (no original text). The postings map UTF-16 single characters and adjacent character pairs to ascending arrays of integer IDs. Nothing is written to disk. A task that finishes while the index exists is added at completion, while its content is still at hand; a withdrawn task is re-added with its withdrawn content. Missing entries (for example, ones that could not be decrypted last time) are filled in on the next search.
- **Exactness.** Query terms (`queryTerms`: Chinese bigrams, single Han characters, English and number words) are substring matches over UTF-16. If a term occurs in a field, every adjacent character pair of the term also occurs in that field. The postings therefore give a superset of candidates, and `scoreFields` (split out of HIST-1's `scoreDocument`, the same code) then matches and ranks the candidates exactly on their folded fields. Chinese bigrams are themselves index keys, so their candidates are exactly the real hits. The "match at least half of the terms" rule prunes candidates by an upper-bound count first, which does not change results.
- **Snippets.** Snippets and title highlights need the original text, so only the hits on this page (20 by default) are decrypted, and their items are produced by `scoreHistoryDocument` (`cache=false`, which does not write `CONTENT_CACHE`) and then discarded. Protected content no longer enters `CONTENT_CACHE` at all.
- **Active tasks** are not in the index; they are matched directly each time (their content is in RAM).
- **Consistency.** Ranking, snippets, paging, filters, and the no-query list match the MEM-4a scan item for item (the parity test in §4 runs 21 queries cold, warm, and after a drop).

### 2.6 Scope (D2) and mutual exclusion with withdrawal and deletion

- **The menu-bar "all" scope also opens the memory file first (review M2).** Like the normal scope, `taskScope(full)` opens the memory file when memory was on last time; opening propagates results whose withdrawal was written to the snapshot before a crash but whose result file was not yet deleted, so later search and detail cannot show them. If memory was on last time but cannot be opened, memory-backed tasks are always shells.
- **Scope before decryption.** Other family members' memory-backed tasks (unless the history was opened from the menu-bar "Results history…"), tasks being withdrawn, tasks cancelling because their memory was revoked (`cancel_reason` is `memory_revoked` and not yet withdrawn; review minor 1), and unreadable tasks are matched and shown only as shells, as in MEM-4a; this page's snippets are decrypted only for tasks in scope. IPC `get` checks scope on the shell first and does not decrypt out-of-scope tasks. The index itself contains the folded content of every protected task (scope changes with the current person, so it cannot be built per person), but out-of-scope entries are never matched or returned.
- **Withdrawal and deletion.** `TaskStore.withdraw` and `delete` remove the entry from the index (`remove` is O(1)) and from the title cache at the start of the same synchronous step. IPC `search` is fully synchronous between awaiting the scope and returning, so a withdrawal or deletion cannot interleave with matching, and no later query can match the result content. A withdrawn task can still be found by the user's original sentence (the same rule as before withdrawal), but it has no result.
- **The memory commit gap (hold).** A memory-layer withdrawal first writes the snapshot (asynchronously) and only then propagates to the task side. To keep even one query in that gap from seeing the result, `MemoryService.commit` calls `holdResults` (`TaskStore.hold`) before writing the snapshot and releases it after the write and the propagation (or after a failed commit). Held tasks are treated as out of scope (shells) in search, detail, and model titles.

### 2.7 Interface (bilingual)

The new sentences (§2.2 and §2.3: key unavailable, memory updating, the two hidden-content notices, and "Press “Search” to load again.") are in the shared translation tables in both languages. The screen reuses the existing "Could not search results history: {0}" and "Could not load this record: {0}". There is no new Surface or button. The core log gains one "protected search" line that contains only whether the index was built, the number of decrypted files, the number of matched entries, the result count, and the time in ms (for measuring latency at the Mac gate). It contains no query text or content.

## 3. Design choices and deviations (recorded as they are)

1. **Idle uses its own 10 minutes** instead of the memory layer's 30-minute current-person idle (reason in §2.2).
2. **Startup still decrypts and verifies every file once**, then drops everything immediately; loading is not fully lazy. This keeps MEM-4a review B1's handling of unreadable files, orphans, and interruptions (reviewed behavior). The cost is that all plaintext is briefly in RAM at startup.
3. **The index keeps copies of the folded fields** (no original text and no positions), because substring matching must match the scan exactly; a set of bigrams alone cannot decide English words of three or more letters exactly. These copies are as sensitive as the content, so they are dropped with it.
4. **At most 16 warm tasks**: the screen reads the result card right after a task finishes, so it should not need another decryption immediately; beyond 16 the least recently used is dropped.
5. **Model titles decrypt only the first 8, cache 16, and do not extend the idle timer** (§2.4); not every task is decrypted on every turn.
6. **A hold was added** (not in the spec): it closes the asynchronous gap in the memory commit (§2.6).
7. **The sleep event is newly wired** (`powerMonitor` `suspend`); the memory layer itself still only listens to `lock-screen`, and its behavior is unchanged.
8. **The list (IPC `list`) returns shells when the key is unavailable** instead of an error; the page no longer calls it (it uses `get` only for the cards on screen). Detail, search, and redo report the error honestly.
9. **Out-of-scope content is also in the index** (§2.6), but it is replaced by shells before matching.
10. **Counts-only log lines were added** (one for search and one for the list, §2.7).
11. **The page loads lazily** (review M1): at startup and after an unlock it reads only the cards on screen, never every task's real content at once.

## 4. Cloud (Linux) validation

Node.js 22.22.0 in a 4-core cloud container. Real AES-256-GCM, real rename / fsync, and `flock(1)` as the test lock on Linux; only the data-key wrapping is fake (`fakeBox`, in-process AES; the production App uses safeStorage / Keychain). Executors are fakes or the mock engine; no model is called. The synthetic corpus is generated with fixed seeds by `tests/fixtures/protected-corpus.ts` (results of about 400–700 characters, mixed Chinese and English, with Markdown; every 7th task fails and has no result).

| Test file | Contents |
| --- | --- |
| `tests/protected-search.test.ts` (new, 18) | After a restart every task is a shell and is decrypted only when read; after an OS lock the canary is gone from RAM (task map, result map, title cache, index) and `CONTENT_CACHE` is empty, and a later read returns byte-for-byte identical content; 10-minute idle (injected clock; an authorized access restarts the timer; if the timer has not run yet, the next access drops first); warm cap of 16; running and queued tasks keep their content after lock, sleep, memory off, and idle and finish normally, then become warm and are dropped on lock; memory off and memory-layer close drop content; `tasks.dropPlaintext("os_lock")` and `close()` (quit) through `startNous`, with the log and a reload; lazy index build, reuse while warm, rebuild after a drop, folded fields only; **item-for-item parity with the scan** (160 tasks with memory, withdrawn, deleted, running, and out-of-scope tasks; 21 queries including simplified Chinese, single characters, phrases, filters, dates, paging, and no query; cold, warm, and after a drop); a withdrawal and a deletion inserted while a search is awaiting are not returned; **with the memory commit stalled while writing the snapshot**, search, detail, and model titles do not show the result being withdrawn; out-of-scope tasks are matched only as shells and are not decrypted for the page (`vault.read` is watched), and `get` returns a shell; **with the key unavailable**, search, the no-query list search, detail, and redo all return `RELOAD_FAILED`, the sealed files are byte-for-byte unchanged, everything recovers when the key returns, and both translation tables have the sentence; model titles decrypt only the first 8 task files, hit the cache, and are cleared on a drop; canary (after building the index, searching, reading, withdrawing, dropping, and searching again, no file under `data/` and no log line contains plaintext); **performance with computed bounds**; `ProtectedIndex` unit test (superset, O(1) removal, compaction); the browser build (no encryption) is unaffected |
| `tests/protected-search.test.ts` (review regressions, +8) | The reviewer's repro1: when the result write fails and the task write succeeds, the result is retried on the next update and reads back after a drop; while it still cannot be written the task is not dropped, and after a restart the result is honestly missing; a cancelling `memory_revoked` task is a shell in search, list, detail, and model titles; cancellation and revoke propagation only look at status (no decryption, no timer reset); redo during a hold says "memory is updating" (Chinese and English); a corrupt result file is read only once; the list goes through the title cache, reads only task files, and logs only counts; **randomized parity** (fullwidth NFKC, extension-plane Han and emoji, digits, repeated terms; 120 queries); `startNous`'s `onPlaintextDropped` receives `os_lock` and `quit` |
| `tests/memory-tasks.test.ts` (+1) | Review M2: after a crash with the withdrawal in the snapshot and the result file still present, the menu-bar "all" search and detail show no result, and the result file is deleted |
| `tests/history-surface.test.ts` (+3) | Review M1 (fake DOM): `want` reads only the given cards; after `applyPlaintextDrop`, `display` is the shell, late replies are not written back, protected result content is cleared, and only a protected result view is collapsed; `HistoryView.hideContent` clears results, snippets, detail, and the query, shows the bilingual notice, and recovers on a new search; `main.ts` no longer calls `loadAll` |
| `tests/tasks-ipc.test.ts` (+1) | The preload forwards only allow-listed reasons to the page |
| `tests/memory-ipc.test.ts`, `tests/identity-ipc.test.ts`, `tests/tasks-ipc.test.ts` (adjusted) | `main.mjs` wiring of `lock-screen`, `suspend`, and `onPlaintextDropped`; one more notification in the preload |
| `tests/fixtures/memory-service.ts`, `tests/fixtures/protected-corpus.ts` | The memory harness can take `holdResults` / `onPlaintextDrop`; the synthetic corpus and a helper that writes sealed files directly |

The performance test asserts computed bounds, not wall-clock limits: decrypted files on the cold query = tasks + results + 2 × hits on this page; on a warm rare-term query the number of exactly matched entries = the real hits; a warm query decrypts at most this page (2 × 20); results equal the scan. Times are printed, not asserted.

### Test results (actual output of this batch)

```text
npm run typecheck                      (no errors)
npx vitest run (run 1)                 Test Files  92 passed (92)
                                       Tests  1607 passed | 4 skipped (1611)
npx vitest run (run 2)                 Test Files  92 passed (92)
                                       Tests  1607 passed | 4 skipped (1611)
npx vite build                         ✓ built
node --check desktop/*.mjs (each)      (no errors)
node scripts/verify-aios.mjs           PASS (its full suite, run 3: 92 files, 1607 passed, 4 skipped)
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed
node scripts/check-pstack.mjs          pstack 0.15.29: ... verified.
git diff --check                       (no output)
```

The baseline main `4b5de31` has 91 test files, 1576 passed, 4 skipped; this batch adds 31 tests (18 in the first round and 13 review regressions; 1 new test file). The output above is from after the review fixes.

### 4.1 Measurements (Linux cloud container, three runs)

Numbers printed by `npx vitest run tests/protected-search.test.ts -t perf --silent=false`. Each "median" is the median of 5 queries within one run; the three runs are listed separately. The rare term "獨角獸" is placed in the result of 1 task in every 250 (2 hits for 500 tasks, 7 for 2000). The common query "晚餐 budget" has candidates in 393 of 500 and 1,570 of 2,000 tasks, because the synthetic vocabulary is small.

"Old path" is IPC `search` before MEM-4c: all content in RAM, every query copies all tasks and results and then scans them (with a warm `CONTENT_CACHE`). "Scan without copying" is a stricter baseline that counts only the scan itself.

| Item | 500 tasks (three runs) | 2000 tasks (three runs) |
| --- | --- | --- |
| Old path, rare term | 8.3 / 9.1 / 8.1 ms | 32.7 / 31.3 / 31.7 ms |
| Old path, common terms | 9.4 / 9.5 / 9.7 ms | 41.6 / 40.8 / 48.3 ms |
| Scan without copying, rare term | 2.8 / 2.8 / 2.7 ms | 15.1 / 10.7 / 9.2 ms |
| Scan without copying, common terms | 4.4 / 4.8 / 4.8 ms | 15.5 / 16.9 / 14.6 ms |
| Index, cold (decrypt everything + build + this page) | 148.7 / 195.4 / 151.4 ms | 629.9 / 554.6 / 578.1 ms |
| Index, warm, rare term (median, includes decrypting this page) | 1.14 / 1.77 / 1.71 ms | 2.64 / 2.38 / 2.53 ms |
| Index, warm, common terms (median, includes decrypting this page) | 5.2 / 8.7 / 5.8 ms | 8.2 / 9.2 / 9.7 ms |
| Entries matched exactly (rare / common) | 2 / 393 | 7 / 1,570 |
| Files decrypted (cold / warm rare / warm common) | 933 / 4 / 40 | 3,729 / 14 / 40 |

Computation (ratios within the same run): at 2000 tasks, a warm-index rare-term query is 12.4 / 13.2 / 12.5 times faster than the old path and 5.7 / 4.5 / 3.6 times faster than the scan without copying; a common-terms query is 5.1 / 4.4 / 5.0 times faster than the old path and 1.9 / 1.8 / 1.5 times faster than the scan without copying. **The cost is the cold query**: the first search after an unlock, wake, or idle drop decrypts everything (about 0.55–0.63 s for 2000 tasks), which is 19.3 / 17.7 / 18.2 times (17.7–19.3×) the old path's rare-term query and 15.1 / 13.6 / 12.0 times (12.0–15.1×) its common-terms query in the same run. The table was measured before the review fixes. After the fixes the test was rerun three times: the numbers of exactly matched entries and decrypted files are identical; at 2000 tasks the times are warm rare 3.81 / 3.62 / 2.33 ms, warm common 10.1 / 8.4 / 7.5 ms, cold 582.1 / 747.6 / 570.8 ms, and the old path in the same runs 46.5 / 47.8 / 34.0 ms (rare) and 34.5 / 52.5 / 46.7 ms (common). The container was more loaded then and the baseline slowed down too; the ratios are of the same order as in the table. The 3,729 decrypted files are 2,000 task files + 1,715 result files + 2 × 7 for the 7 hits on the page. These numbers use an in-process fake key wrapper; on the Mac each file adds one safeStorage decryption, and the cold-query time on the Mac has not been measured (§5 step 6).

## 5. Mac gate (none executed; no pass may be claimed)

Prerequisites: a signed App; tasks stored encrypted (MEM-4a's Mac steps done); some protected tasks in the data folder (at least one fictional task containing a canary); logging on.

1. **OS lock**: open a result in the App, press Control-Command-Q to lock, then unlock. The log shows "已丟棄記憶體裡的解密內容（os_lock；…）"; reopening the results history and that result shows correct content; record the "受保護搜尋（建立索引，…，N ms）" line of the first search after unlocking.
2. **Sleep**: sleep from the Apple menu (or close the laptop lid) and wake: the log shows `suspend` (and `os_lock` from the lock); content reads back normally afterwards.
3. **Idle**: search the results history once, then leave it untouched for 11 minutes: the log shows `idle`; the next search is "建立索引" (index built).
4. **Memory off**: switch memory off from the menu-bar "Memory…": the log shows `memory_off`.
5. **App quit**: Command-Q: the last log lines show `quit`.
6. **Latency**: record the ms, counts, and decrypted files of the first search after unlocking (cold) and the search right after it (warm); if 500 and 2000 tasks can be prepared, record each once. Also record the log line "受保護清單（N 筆，解密 M，X ms）" (protected list) if it appears. Compare with §4.1 and record honestly.
7. **Key unavailable**: in Keychain Access, change "Nous Safe Storage" to deny (or deny at the prompt), lock and unlock, then search and open a result: the screen shows "Could not search results history: The encrypted task content could not be decrypted this time (key unavailable)…" (Chinese in the Chinese interface), not an empty result; files in `sealed/` are byte-for-byte unchanged; everything recovers after allowing access again.
8. **Running task**: delegate a task that takes a while (Claude or ChatGPT) and lock while it runs: the task finishes normally with a correct result.
9. **Withdrawal**: while the results history shows a memory-backed result, forget that memory from "Memory…" and search the same term again: the result content no longer appears.
10. **Scope**: with person A as the current person, search a term from B's memory-backed result: only a shell appears; it becomes visible only after opening from the menu-bar "Results history…".
11. **Canary**: after the steps above, `grep -r` over `userData/data/` (excluding plaintext backups): no canary.
12. **The page is cleared too** (review M1): with the results history showing a protected snippet and a protected result open, lock and unlock: the result view is collapsed, the results history shows only "Content hidden after lock; search again" (Chinese in the Chinese interface), tasks continue, and progress cards read their titles back only for the cards on screen.

## 6. Unfinished items and next gate

- §5 steps 1–12, especially steps 1, 6, 7, and 12 (a real lock, latency on the real Mac, a Keychain denial, and clearing the page).
- Questions for George:
  1. Are 10 minutes of idle, 16 warm tasks, and the first 8 model titles / 16 cached titles acceptable?
  2. The first search after unlocking takes about 0.6 s at 2000 tasks (Linux, without safeStorage). Is that acceptable, or should the index be prebuilt in the background after unlocking (which brings plaintext back into RAM sooner)?
  3. Should the one-time verification at startup (§3 item 2) become truly lazy loading (this changes MEM-4a review B1's startup behavior and needs another review)?

## 7. Residual risks

- **Not a secure wipe.** Dropping only releases references; the JS heap and GC may keep string copies until they are overwritten, and V8 may keep strings in the young or old generation for a while. This is the same kind of limit as MEM-4a's "file deletion is not cryptographic erasure".
- **The index is a copy of the content.** It keeps folded fields (lowercase, simplified converted to traditional); while warm it is as sensitive as the decrypted content and also contains other family members' content (which is never returned).
- **Brief plaintext at startup.** Startup still decrypts and verifies every task once, then drops it immediately.
- **The list decrypts titles.** IPC `list` (which the page no longer calls) decrypts the task file of each in-scope task that is not in the title cache (not results), and puts the result in the title cache of at most 16.
- **Active and unsealed tasks.** The content of queued, running, cancelling, and `unsealed` tasks stays in RAM (the executor needs it; `unsealed` content would be lost if dropped).
- **Model titles.** Each turn decrypts at most 8 task files; the cache holds at most 16 and is cleared on every drop; the rules for which titles models see are unchanged.
- **Idle granularity.** The timer runs once a minute, so the real maximum is about 11 minutes.
- **Lock events.** Only `powerMonitor` `lock-screen` and `suspend` are used; whether a screen saver without a lock, or fast user switching, fires them is pending Mac verification.
- **Page caches.** The page clears them only when the notification arrives (review M1); before it arrives, or while the main window is not connected, the renderer still holds what it displayed, and the renderer's JS heap is not a secure wipe either. Titles on protected original-sentence cards (MEM-4b) are outside this clearing.
- **Unwritten results.** If a result file keeps failing to write, that task's content stays in RAM (it is never dropped), and after a restart the result is missing (only "could not load the result" is shown); this is MEM-4a's `unsealed` behavior.
- **Cold-query latency.** The first search after an unlock or idle drop decrypts everything; the time on the Mac has not been measured.
- **Withdrawal while the key is unavailable.** The task file cannot be re-encrypted then, so only the shell is updated and the result file is deleted; the task file still contains the pre-withdrawal step titles (merging uses the shell's fixed sentence, so they are not shown). This is the same situation as an unreadable task under MEM-4a review B1.

## 8. Independent review and fixes (2026-10-30)

The review found 1 blocker, 2 majors, 5 minors, and a few nits. All are fixed with regression tests (the two cases of the reviewer's `repro1.ts` are in `tests/protected-search.test.ts`).

| Item | Fix |
| --- | --- |
| B1 After a failed result write and a successful task write, a drop deleted the only copy | `unsealed` per record ID (task and result separately); dropping needs both written; an unwritten result is retried on the next update; `vaultStatus().unsealed` counts tasks |
| M1 Page caches were kept forever | Every drop sends a content-free `tasks:plaintext-dropped` through the main process (preload allow-list); the page clears its cache, result content, and the history results and detail, shows a bilingual notice, and collapses a protected result view; afterwards it reads back only the cards on screen and never calls `loadAll` |
| M2 The menu-bar "all" scope skipped opening the memory file | `taskScope(full)` also opens the memory file first (opening propagates withdrawals); if it cannot be opened, memory-backed tasks are always shells |
| minor 1 A cancelling `memory_revoked` task was still searchable | `hiddenNow`: while held, or `memory_revoked` and not yet withdrawn, search, list, detail, and model titles always show shells |
| minor 2 Unauthorized paths decrypted and reset the timer | `runner.cancel` and `revokeMemory` use `publicGet`; `get` does not keep content; only `open` (detail, redo) and search restart the timer; idle counts from startup |
| minor 3 Redo during a hold gave the wrong reason | Check the hold first and return "Memory is updating; try again shortly" (Chinese and English) |
| minor 4 A corrupt result file was reread on every search | It is remembered (at startup and on lazy load), read once, and logged once per run |
| minor 5 The list decrypted every task file each time | It goes through the title cache, reads only task files, and logs counts and time; the page no longer calls the list |
| nit | §4.1 gives the multiplier against both baselines; a randomized parity test was added |

## 9. Rerun

```sh
cd prototype/ambient-shell
npm ci
npx vitest run tests/protected-search.test.ts tests/task-vault.test.ts tests/memory-tasks.test.ts tests/tasks-ipc.test.ts tests/history-search.test.ts
npx vitest run tests/protected-search.test.ts -t perf --silent=false   # prints the numbers in §4.1
cd ../..
node scripts/verify-aios.mjs
```

Linux needs util-linux `flock`; without it the real-file tests are skipped, not reported as passed.
