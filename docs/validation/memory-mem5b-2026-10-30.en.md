<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem5b-2026-10-30.md) | [English](memory-mem5b-2026-10-30.en.md)

# MEM-5b work decisions (work_summary) linked to tasks with cascading revocation: cloud validation and Mac gate

Date: 2026-10-30, Asia/Taipei. The starting point is main `d0ff7bb` (which already contains MEM-0 to MEM-5a and HIST-1). The work was done on the separate worktree branch `claude/mem-5b`; nothing was committed, pushed or merged. All people, task titles, sentences and memory content are fictional synthetic data or canaries.

**Status of this batch: the code and the parts that can be checked in the cloud (Linux) are complete; none of the Mac gate has been run or passed.** The feature is off by default: `NOUS_MEMORY_ROUTES` must list `work_summary`, and tasks must really be stored encrypted (MEM-4a's sealed mode with a working key). The choice card appears only when both hold. With the flag off, behaviour is exactly the same as MEM-5a.

Before going to sleep, George authorized finishing all MEM work with **conservative defaults**. Every product decision listed in §3 is a default and is **pending George's confirmation**.

The same-day independent review found no blockers, 1 major (the cascade was too broad) and 7 minors; this document is the fixed version, and the fixes are listed in §8.

## 1. Scope

Today's gap: "記住這次選了方案 B" ("remember this time I chose plan B") is saved as a permanent plain note "這次選了方案 B", linked to no task, and it is not removed when the task is deleted or its result is withdrawn. Following [16 §5](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#5-寫入更正與來源) (`derived_from`), [§8](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#8-忘記換人與晚到回覆) ("later summaries require full dependencies and are removed when their source is forgotten"), [§11](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#11-分批實作與放行) and [ADR-0002](../adr/ADR-0002-nous-family-memory.en.md):

1. **Trigger**: the `work_summary` flag (added to the `NOUS_MEMORY_ROUTES` whitelist, off by default) plus `tasks.sealed()`. Only explicit memory commands typed in the trusted main window count: "記住 + 這次/剛剛/上次/剛才 + 選/決定/採用/定了/用…" and English "remember I chose / we decided / I went with …". Every `parse.ts` exclusion still applies (third party, quotes, hypotheticals, jokes, sensitive data, uncertainty, questions, today); minors are refused.
2. **Choice card**: at most 5 protected tasks that finished successfully in the last 24 hours, are not withdrawn, are in the current person's scope (D2's `taskScope`) and whose content can be read; plus "只記成一般筆記" (just save as a regular memory) and "取消" (cancel). Task titles travel only over IPC (the turn/card_answer responses), never over SSE. A click counts as direct confirmation, and the ticket binds the epoch, the person and the original sentence. With no eligible task, it falls back to a plain note as today and says so honestly.
3. **The fact**: `kind: "work_summary"`, value = the user's own words (no model summary, no task title or result), `derivedFrom: { taskId }`, no expiry. Retrieval follows the normal consent rules; the model receives only the user's words.
4. **Cascading revocation** (after review M1 and m7): (a) when a result is withdrawn because a memory it used was forgotten, corrected or expired, or its person was deleted, the work decisions linked to those tasks are forgotten in the same commit, to a fixed point; turning memory off, revoking consent or a dependency-index overflow only withdraws the results and **keeps** the work decisions (reversible actions do not delete the user's own words); (b) deleting a task (HIST-1's HTTP delete, which carries no memory ticket) does not change memory directly: retrieval excludes the fact at once, and the reconcile forgets it in one commit when the memory file opens and on the trusted main window's next turn/list; (c) the reconcile only purges tasks that no longer exist (`missing`); unreadable tasks are not purged.
5. **Reader**: the memory list (`memory-view`) gets a "工作決定" (work decision) filter and link labels; results history (`history-view`, `history-search`) is unchanged.
6. **Privacy**: logs carry counts only; canary tests confirm titles and results are absent from the snapshot, `ContextFact`, model payloads, SSE and logs.

Not in this batch: creating work decisions from voice (saying "記住這次選了 B" in realtime voice still produces MEM-2's voice card and a plain note), model summaries, automatic extraction from results (still prohibited by 16 §8), and household work decisions.

## 2. Design and implementation

### 2.1 Parsing (`workDecision` in `server/memory/parse.ts`)

It only looks at `remember` segments that `parseMemoryText` already accepted (so third party, quotes, hypotheticals, jokes, sensitive data, uncertainty and questions were already excluded in `content()`), and only when `expires` is `none` ("記住今天…", remember for today, does not count) and parse judged it a `note` (review m2: a sentence judged a preference, such as "這次決定不要加辣" (this time I decided no chilli), goes to the plain remember with its conflict check, as with the flag off). Chinese: the value starts with an optional "我/我們" (I/we), then "這次/這一次/剛剛/剛才/上次/上一次" (this time / just now / last time), then "選了/選擇了/選擇/選/決定了/決定/採用了/採用/定了/用了/用" (chose / decided / adopted / settled / used) and at least one more character. English: an optional this time / just now / last time, then I or we, then chose, picked, selected, decided (on/to), went with, settled on, opted for or used, followed by an object. Review m1 also excludes: used to (a past habit), picked up (collecting someone, lifting something), and objects nothing/anything/none/it; in Chinese, "用了很久/好久/一下" (used for a long time / a moment), "這次用中文/英文" (use Chinese/English this time, a reply style) and "這次選了" with nothing chosen. Other phrasings that slip through still show the choice card, where the user can pick "just save as a regular memory". "記住媽媽這次選了 B" (remember mum chose B this time) is not a work decision (it does not start in the first person) and is handled as MEM-1 does today; "幫媽媽記住她這次選了 B" and "remember he chose plan B" are still refused as third party.

### 2.2 Trigger and choice card (the remember branch of `MemoryService.process`)

Order: no person selected → the existing clarify card (household/cancel, saved as a plain note); the current person is a minor → the existing "minor" receipt; `workSummaryOn()` (flag + a task port with `scopedList` + `tasks.sealed()`) and `workDecision(seg)` → `workChoices()`:

- Scope uses `scopeNow()` (the same D2 rule as `taskScope(false)`: tasks without memory, and memory tasks for the household or the current person).
- The task port's `scopedList` (`memoryTaskViews` in `server/store.ts`, shared by nous.ts and the tests) follows the trusted-main-window list rule (`listFor`); out-of-scope, being withdrawn (`hiddenNow`) or unreadable (`contentMissing`) tasks are always shells (`protected: true`). Review m3: the scope predicate passed in first filters on fields the shell already has (scope, succeeded, not withdrawn, no `cancel_reason`, within 24 hours), so ineligible tasks are never decrypted.
- It keeps only non-shell tasks with `status: "succeeded"`, no `withdrawn`, no `cancel_reason` and a `finished_at` within 24 hours (no later than now plus one minute), newest first, at most 5 (`WORK_CHOICES_MAX`, `WORK_CHOICE_WINDOW_MS` in `shared/memory.ts`).

With eligible work → a `work_summary` card (`MemoryCardView`: `value`, `subject_name`, `tasks[{task_id,title,finished_at}]`, `options ["task","note","cancel"]`) and processing stops; card state lives only in the core (`CardState.work_summary`: the segment, the person when the card was issued and the listed task IDs). No eligible work → the receipt "最近 24 小時沒有可以連結的已完成工作，改用一般記住處理" (no work finished in the last 24 hours to link to, so this is handled as a regular memory; status `not_found`; review m4: it does not announce the outcome in advance), then the normal flow continues (already remembered, conflict clarify, or save), whose result is the next receipt.

Review m5: the turn's request_id cache does not keep task titles (they are stored as empty strings); when the same request_id is replayed, titles are fetched again from the current tasks only while the card is still valid (deleted or no-longer-eligible work is not listed), and no work is listed once the card is invalid. The cache is cleared when memory is turned off, when the memory layer closes and when the reconcile forgets something.

The card exists only in the IPC responses to turn and card_answer (main window main frame, page from the local core); SSE carries neither the card nor its content. The screen is the existing memory Surface (`data-visibility-reason="user_request"`, same request_id).

### 2.3 Answering (`work_summary` in `cardAnswer`)

- The shared checks still apply: the card exists, has not expired (2 minutes) and the epoch has not changed (switching person, suspending, correcting and forgetting all change the epoch); the card is single-use (it is removed before processing, so choosing the wrong task also uses it up).
- Then: minors, and the current person must still be the one the card was issued for.
- `note`: a memory with the same key and the same sentence that is not a work decision already present → `unchanged`; otherwise `writeRemember` (today's plain remember, including the source ticket). Because work decisions only accept sentences parse judged `note`, the normal flow's preference-conflict check cannot arise here (review m2).
- `task`: `task` must be one of those listed on the card; `writeWorkSummary` re-checks at click time the flag, sealing, memory being on and that the work is still eligible (not deleted, not withdrawn, in scope, within 24 hours); the same work with the same sentence → `unchanged`; capacity, length and excerpt limits match a plain remember.
- Source ticket: `observeConfirmation(the card's original sentence)` + `issueParsed`; the reparse uses `workSummaryBodies(taskId, part)`: part `part` of the original sentence must still be a work decision, and the command fields (`op: "work_summary"`, value, topic, key, `task`, `scope: "subject"`) must match exactly. The task ID can only be one listed on the core's card and clicked by the user.
- Write: `kind: "work_summary"`, `profileId` the current person, `source.kind: "explicit"`, `excerpt` the original sentence (≤240 characters, otherwise the value), `by: null`, `expiresAt: null`, `derivedFrom: { taskId }`. Receipt: "記在 {0} 名下的工作決定了：{1}" (saved as {0}'s work decision: {1}).

### 2.4 Retrieval and the model

`retrieve.ts` adds `work_summary` to the valid kinds; every other rule (person scope, household, expiry, consent, relevance, 8 facts / 4 KB) is unchanged; `ContextFact` has only `text` (the words), `source`, `at` and `expires`. Before its three call sites (`withChat`, `voiceContext`, `delegateProtected`), `MemoryService.usableFacts` excludes work decisions whose task no longer exists (`taskState` is `missing`); those whose task still exists with a withdrawn result are used as normal (review M1); when the task port cannot tell, nothing is excluded. `shownKind` adds `work_summary`: the list, "what do you remember about me?" and chat correct/forget targets all see it.

### 2.5 Cascading revocation

- **(a) The source memory is gone (fixed point)**: `withdrawalCauses` splits MEM-4a's withdrawals into two causes: `forgotten` (a memory it used was deleted, by forgetting or expiry, or changed revision, by correction, or its person was deleted) and `reversible` (memory turned off, consent revoked). `settleWithdrawals` (called by `commit`, and testable on its own) deletes only the work decisions linked to `forgotten` tasks (tombstones) → computes withdrawals again (results that used those work decisions are withdrawn too, also with cause `forgotten`) → until nothing new. Each round needs at least one newly withdrawn result for another round to happen, so the number of rounds is bounded by the dependency index size; there is also a hard limit of `results.length + 1`. The log only says "(withdrew N protected results)(also forgot M work decisions, K rounds)". When work decisions were forgotten, the epoch changes after a successful commit.
- **(b) Reversible withdrawals (review M1)**: turning memory off, revoking consent and active results dropped because the dependency index is over its limit only withdraw the results (the result content is deleted as in MEM-4a); work decisions are **not forgotten**, and the epoch and conversation history are not changed. With memory off or without consent, retrieval sends nothing anyway; after turning it back on, the work decisions are listed and retrieved as usual.
- **(c) Task deletion and the reconcile (review m7)**: deleting from results history (both the App and the web page use HTTP `/api/history/:id/delete`) carries no memory ticket and need not come from the trusted main window, so the deletion itself does not touch the memory file. `usableFacts` keeps it out of retrieval at once; `reconcileWork` forgets work decisions linked to tasks that no longer exist in one commit when the memory file opens and on the trusted main window's next `turn` and `list` (inside the mutex), changing the epoch; the log says "工作決定連帶忘記 N 筆（任務已不存在）" (also forgot N work decisions, task no longer exists). When `tasks.sealed()` is false (not sealed or the key is unavailable) it never purges (logging the skip when the file opens); tasks whose content cannot be read (decryption failure, a corrupt file) are still listed, count as existing and are **not purged** (consistent with MEM-4a B1). Only `missing` is purged: a withdrawn result with the task still present is not.
- **(d) Crash**: if the process dies after the deletion is written and before the reconcile, the work decision is still in the memory file but is never retrieved, and the next reconcile on open or on turn/list forgets it.

Revocation and the reconcile ignore the flag: after the flag is turned off, existing work decisions are still forgotten by the rules above.

### 2.6 Snapshot

No new version is needed: MEM-5a's version 4 can already store `kind: "work_summary"` and `derivedFrom`. With a work decision present it writes 4; after all are forgotten it writes 3 (with a dependency index) or 2 by content, as MEM-5a's `diskForm` does. With the flag off or no work decision, the file written is byte-identical to MEM-5a (the existing comparison in `tests/memory-store.test.ts` still passes).

### 2.7 Screen (`src/memory-view.ts`)

- Choice card: title "要連到哪一個工作？" (which work should this link to?), the words to remember, recently finished work (title, finish time, "連到這個工作" / link to this work), the note "只保存你說的這句話，連到你選的工作；不會保存工作的標題或成果。這個工作被刪除，或它用到的記憶被忘記或更正時，這筆工作決定也會一起忘記；關閉記憶或撤回同意不會刪除它。" (only your own words are saved, linked to the work you choose; the work's title and result are not saved; if that work is deleted, or a memory it used is forgotten or corrected, this work decision is forgotten too; turning memory off or withdrawing consent does not delete it), "只記成一般筆記" and "取消". Each "連到這個工作" button has the accessible label "連到：{title}" (linked to: {title}).
- List: work decisions are labelled "工作決定 · 連到：{title}" (work decision · linked to: {title}; the title only when the task is in the current scope), "工作決定 · 連到的工作不在目前範圍內" (the linked work is outside the current scope) or "工作決定 · 連到的工作已不存在" (the linked work no longer exists). `MemoryFactView` adds `kind` and `work: { task_id, title, state }`; the core resolves the title through `scopedList` for `list`, `card_view` and the inspect card, over IPC only.
- Memory manager: a "類別：" (type) drop-down (all / work decisions) that only filters the screen; each time the manager opens it resets to "all". The results history screen and search are unchanged.

### 2.8 Interface copy (bilingual)

New page strings are in `src/messages.en.json` (17 entries) and the core's fixed sentences in `server/messages.en.json` (6 entries). `tests/memory-view.test.ts` checks that the English card has no Chinese apart from the user's words and the task title; `tests/memory-work-summary.test.ts` checks that every new core sentence has an English translation with no Chinese characters.

## 3. Design decisions (all pending George's confirmation)

| # | Decision (conservative default) | Reason | Pending George's confirmation |
| --- | --- | --- | --- |
| W1 | The `work_summary` flag is off by default and separate from `task`; `tasks.sealed()` is also required (sealed mode with a working key) | Plaintext or RAM-only tasks have no reliable delete and withdrawal | Pending George's confirmation |
| W2 | Created only from an explicit typed "記住" in the trusted main window; realtime voice still gives a plain note; additions in the memory manager are unchanged | Voice has a different confirmation flow and card; a later batch can look at it | Pending George's confirmation |
| W3 | Only for a selected current person who is not a minor; with nobody selected the existing household/cancel clarify card appears (plain note); no household work decisions and no `by` | Work decisions are personal; the scope rule (D2) is per person | Pending George's confirmation |
| W4 | At most 5 on the card: succeeded, finished within 24 hours, not withdrawn or being withdrawn, readable, in D2 scope; newest first; includes tasks without memory and delegations whose titles the model rewrote (not only `origin: "user_sentence"`) | The user checks the title on the card; restricting to the user's own sentence would exclude most delegations | Pending George's confirmation |
| W5 | No eligible work: save a plain note as today, plus an honest receipt | Do not let the user think it was linked | Pending George's confirmation |
| W6 | A click is direct confirmation; the card is single-use (choosing the wrong work uses it up); flag, sealing and eligibility are re-checked at click time; bound to epoch and person | Consistent with the other memory cards | Pending George's confirmation |
| W7 | Value = the user's words (the leading "我" removed as for a plain remember); no expiry; `source.kind` is `explicit`; the excerpt is the whole original sentence | 16 §5 keeps the original words; expiry rules wait for George | Pending George's confirmation |
| W8 | Same work and same sentence → already remembered; the same work may have different sentences | One piece of work can have several decisions | Pending George's confirmation |
| W9 | "只記成一般筆記" saves today's plain remember; work decisions only accept sentences parse judged `note`, so preference sentences still go through the plain remember and its conflict check (review m2); the already-remembered check ignores a work decision with the same words | The same as with the flag off | Pending George's confirmation |
| W10 | Retrieval follows the normal consent rules; work decisions whose task no longer exists are excluded first; those whose task still exists with a withdrawn result are used as normal (review M1) | 16 §7; not used between the deletion and the reconcile | Pending George's confirmation |
| W11 | Chat and the memory manager can correct or forget a work decision; a correction keeps the task link | What is corrected is the wording, not the work | Pending George's confirmation |
| W12 | (Changed after review M1) Cascade only when the source is really forgotten: a memory it used was forgotten, corrected or expired, or its person was deleted, to a fixed point; **turning memory off, revoking consent and a dependency-index overflow only withdraw results and keep the work decisions**, with no epoch change | 16 §8 clears only "when their sources are forgotten"; reversible actions do not delete the user's own words | Pending George's confirmation |
| W13 | The epoch changes after a cascade (used conversation history is cleared) | Consistent with forgetting | Pending George's confirmation |
| W14 | The reconcile purges only tasks that no longer exist (`missing`); never when the task side is not sealed or the key is unavailable; never tasks that cannot be read | MEM-4a B1: unreadable must not be treated as deleted; withdrawal is not deletion (review M1) | Pending George's confirmation |
| W15 | Task titles in the list are shown only when in the current scope; when the manager views another person it only says "outside the current scope" | D2 | Pending George's confirmation |
| W16 | The "work decision" filter is only in the memory manager; results history gets none | Per the instruction not to touch history-view/history-search | Pending George's confirmation |
| W17 | Cascading revocation and the reconcile ignore the flag and are always on | Revocation is a safety rule, not a feature | Pending George's confirmation |
| W18 | (Review m7) Task deletion (HTTP, no memory ticket) does not change memory directly; work decisions are forgotten when the memory file opens and on the trusted main window's next turn/list, and retrieval excludes them until then | Memory writes come only from the core's own rules and trusted main window actions | Pending George's confirmation |
| W19 | (Review m1) Fixed exclusions in both languages: used to, picked up, objects nothing/anything/none/it; "用了很久/一下", "這次用中文/英文", "這次選了" | Fewer false choice cards; ones that slip through can still pick "just save as a regular memory" | Pending George's confirmation |

## 4. Cloud (Linux) validation

Node.js 22 in a cloud container. Real AES-256-GCM memory snapshots and sealed task files, real rename/fsync, and `flock(1)` as the test lock on Linux; only the wrapping of the data key is fake (`fakeBox`). The executor is fake; no model is called.

| Test file | Content |
| --- | --- |
| `tests/memory-work-summary.test.ts` (new, 32; 13 added after the review) | Parsing positives (5 Chinese, 4 English) and negatives (preference, today, third-party opening, third-party refusal, hypothetical, joke, uncertain, question, sensitive, no "記住"; review m1/m2: used to, picked up, selected nothing, decided on it, 用了很久, 這次用中文, 這次選了, a preference sentence); flag off = plain note and snapshot version 2; flag on but not sealed = plain note; no eligible work = plain note + honest receipt; the choice card lists only succeeded, within 24 hours, not withdrawn, in scope, at most 5, newest first, titles over IPC; choosing work not on the card is refused; after the click `kind`, value, `derivedFrom`, no expiry, version 4, and no title or result canary in the snapshot; single-use card; same sentence and work returns `unchanged`; work deleted before the click returns `not_found`; "just save as a regular memory" and "cancel"; switching person invalidates the card and another person cannot see George's memory task; minors refused, nobody selected goes to the clarify card; model payloads (the `ContextFact`s in `withChat` and the memory the task executor receives) contain only the words, no title, result or task ID, and the logs and the SSE sources (`TaskStore.subscribe`/`subscribeDeleted`) contain no canary; deleting a task does not change the memory file, the next turn reconciles first and forgets 2 facts in one commit with content-free tombstones, and that turn's retrieval does not see them; `list` also reconciles first; **race**: deleting the task at different points after the click never leaves a linked work decision behind; **a two-hop fixed point** (forget "不吃香菜" → T1 withdrawn → W1 forgotten → T2 withdrawn → W2 forgotten, one revision, log "2 facts, 2 rounds", written back as version 3); a `settleWithdrawals` unit test: for 5 hops the round count equals the hop count and stays within results + 1, and turning memory off or revoking consent forgets nothing; **review M1** (regression tests made from the reviewer's probes P1 and P2): turning memory off only withdraws the result, both work decisions remain and are retrieved again after turning memory back on; revoking consent keeps them; a dependency-index overflow keeps them without an epoch change; probe P3: "remember I used to like tea" gets no card; probe P4 (review m3): the card does not decrypt titles of tasks outside 24 hours; realtime voice still gives a plain note with the flag on; review m5: no titles in the request_id cache, fetched again on replay, dropped after deletion; a work decision with the same words does not block "just save as a regular memory"; **a crash between delete and commit**: retrieval excludes it first and the reconcile after restart forgets it; no purge when the task key changes or tasks are not sealed; a single corrupt task file (correct key) keeps the task present, is not purged, and is labelled out of scope; list link labels (title in scope, none out of scope); version 4 only while a work decision exists, back to 2 after it is deleted; IPC filter; every new sentence has English |
| `tests/memory-view.test.ts` (+2, fake DOM) | The choice card's title, work, button order, the button's accessible label "連到：{title}", `task` choice, `user_request`, same request_id, in both languages; the list's "linked to: …" and "no longer exists" labels and the manager filter, in both languages |
| `tests/memory-retrieve.test.ts` (1 changed) | MEM-5a's "`work_summary` is never sent" became "sent under the normal rules, only the words, no task ID; not sent without consent" |
| `tests/apikey-route.test.ts` (adjusted) | `work_summary` in `NOUS_MEMORY_ROUTES` is off by default and can be listed with other values |
| `tests/fixtures/memory-service.ts` | The harness accepts `workSummary` |

Time-based logic uses the injected clock (the tests set it to the current time because task finish times are real); there are no wall-clock limit assertions.

### Test results (actual output of this batch)

```text
npm run typecheck                      (no errors)
npx vitest run (run 1)                 Test Files  94 passed (94)
                                       Tests  1746 passed | 4 skipped (1750)
npx vitest run (run 2)                 Test Files  94 passed (94)
                                       Tests  1746 passed | 4 skipped (1750)
npx vite build                         ✓ built
node --check desktop/*.mjs desktop/*.cjs (each)   (no errors)
node scripts/verify-aios.mjs           PASS (its full suite, run 3: 94 files, 1746 passed, 4 skipped)
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed (after --record)
node scripts/check-pstack.mjs          pstack 0.15.29: 172 upstream hashes, 56 skills in both clients, agents and model roles verified.
git diff --check                       (no output)
```

Baseline main `d0ff7bb` has 93 test files, 1712 passed, 4 skipped; this batch adds 34 tests (32 in the new test file, 13 of them after the review; 2 for the screen) and changes 1 test in `tests/memory-retrieve.test.ts` to the new rule. This is the actual output after the review fixes.

## 5. Mac gate (none executed; no pass may be claimed)

Prerequisites: a signed App; the MEM-1 and MEM-4a Mac steps done (tasks stored encrypted); `work_summary` added to `NOUS_MEMORY_ROUTES` in `.env` (plus `task` for step 6); fictional people George and Amy; logging on.

1. **Flag**: the start-up log contains "工作決定已放行（NOUS_MEMORY_ROUTES，Mac gate 尚未通過）" (work decisions released). Remove `work_summary`, restart, select George and type "記住這次選了方案 B": the receipt is "記在 George 名下了：這次選了方案 B" with no choice card (same as MEM-5a).
2. **Choice card**: put the flag back. Delegate two small pieces of work and let them finish, then type "記住這次選了方案 B": the memory Surface shows "要連到哪一個工作？", both titles and finish times, "只記成一般筆記" and "取消". Take one screenshot in each language. Press "連到這個工作": the receipt is "記在 George 名下的工作決定了：這次選了方案 B"; "what do you remember about me?" shows "工作決定 · 連到：{title}".
3. **No eligible work**: with fresh data (or after 24 hours), the same sentence: the first receipt says "最近 24 小時沒有可以連結的已完成工作，改用一般記住處理", then the normal save receipt.
4. **Scope**: switch to Amy: George's memory task is not on Amy's card; viewing George's list in the memory manager, the entry linked to George's memory task only says "連到的工作不在目前範圍內".
5. **Reconcile after deletion**: delete the work linked in step 2 in "Results history…" (native confirmation): the log shows no memory change yet; type another sentence (or open "what do you remember about me?"): the log has "工作決定連帶忘記 1 筆（任務已不存在）" and that work decision disappears from the memory list.
6. **Withdraw cascade (`task` on too)**: remember "我不吃香菜", delegate "幫我規劃一週晚餐" (with memory); when it finishes, link "記住這次選了第二份菜單" to it; then delegate "把第二份菜單寫成採買清單" (which uses that work decision) and link one more when it finishes. Forget "不吃香菜" in the memory manager: both results are withdrawn and both work decisions disappear; the log has "連帶忘記工作決定 2 筆，2 輪".
6a. **Reversible withdrawals forget nothing (review M1)**: redo the first half of step 6 (one memory task with one linked work decision) and turn memory off in the memory manager: the result is withdrawn and the log has no "連帶忘記工作決定"; turn memory back on: the work decision is still in the list. Revoking George's consent for Claude behaves the same.
7. **Reconcile after restart**: link a work decision and quit the App; reopen it, delete that work on the `/history` web page and quit the App straight away; reopen it and type a sentence: the log has "工作決定連帶忘記 1 筆（任務已不存在）" and the entry is gone from the list.
8. **Unreadable is not purged**: deny access to the tasks' Keychain item (or use MEM-4a's key-denial step), open the App and type: the log has "工作決定對帳略過" and the work decision remains.
9. **Older App**: copy `userData/memory/` and record `shasum -a 256`. Open it with an App built from main `d0ff7bb` (MEM-5a): memory works (it understands version 4) and the list does not show work decisions; with no writes the file's SHA-256 is unchanged.
10. **Canary**: delegate work whose title contains a canary, link a work decision, then ask a related question; `grep -r` the log and `userData/`: no canary in the log; the memory file is encrypted.

## 6. Unfinished items and the next gate

- §5 steps 1–10 (including 6a), especially step 2 (the real screen), steps 6 and 6a (withdrawal and keeping) and steps 5 and 7 (the reconcile).
- Work decisions from realtime voice, an expiry for work decisions and household work decisions: none were done; they wait for George.
- Questions for George: W1–W19 in §3.

## 7. Residual risks

- **Low recall is deliberate**: only fixed patterns ("這次/剛剛/上次 + 選/決定…") count; "記住方案 B 比較好" and "記住我們最後用 Postgres" are still plain notes. The positive and negative test cases were written by this batch's author and the reviewer; they are not an independent evaluation set; the exclusions (W19) are a fixed list, and new phrasings (for example "剛剛用了很多錢", just spent a lot of money) can still show the card.
- **Scope of the cascade (W12, narrowed after review M1)**: forgetting, correcting or expiring a memory or deleting a person still forgets the work decisions of work that used it, and several hops can forget several entries at once, irreversibly. Turning memory off, revoking consent and overflow only withdraw results and keep the work decisions, which then link to tasks whose results were removed.
- **Task deletion does not change memory directly (W18)**: between the deletion and the next memory open or trusted turn/list, the work decision is still in the encrypted file but is never retrieved or sent. Nothing is reconciled while the task side is not sealed or the key is unavailable, and if memory is never used it is never cleared.
- **Interaction with MEM-4c**: the choice card and the list link labels decrypt finished tasks' task files (not results) through `listFor` to get titles, which go into MEM-4c's title cache; they are dropped on MEM-4c's schedule.
- **The person typing is not necessarily the current person**: "我是 X" (I am X) is enough to save a work decision under X (a self-claimed identity, not verification).
- **Titles may be model-rewritten** (W4): the user sees the task's title on the card, which may not be their own sentence; only the user's words from this turn are saved.
- **Downgrading to MEM-5a**: the older version reads version 4 but neither shows nor sends work decisions and has no cascade; tasks deleted while on the older version are reconciled when MEM-5b runs again.
- **The page DOM** keeps task titles until the card is handled (renderer memory, not secure erasure).

## 8. Independent review and fixes (2026-10-30)

The same-day independent review found no blockers; 1 major, 7 minors and several nits are fixed. The reviewer's probes P1–P4 became regression tests in `tests/memory-work-summary.test.ts`.

| Item | Fix |
| --- | --- |
| M1 the cascade was too broad (turning memory off, revoking consent or overflow permanently forgot the user's own words) | `withdrawalCauses` separates causes; `settleWithdrawals` cascades only for `forgotten`; reversible withdrawals only withdraw results with no epoch change; the reconcile purges only `missing`; `usableFacts` excludes only `missing`; the card note, W12, §7 and the 16 §8 note were updated together |
| m1 English false positives (used to, picked up, selected nothing) | Negative lookaheads and object exclusions; Chinese "用了很久", "這次用中文" and "這次選了" are excluded too (W19) |
| m2 preference sentences and "just save as a regular memory" | `workDecision` requires `kind === "note"`; the note path's already-remembered check ignores work decisions |
| m3 the card decrypted unnecessary tasks | The scope predicate first filters on shell fields (scope, succeeded, not withdrawn, no `cancel_reason`, within 24 hours) |
| m4 the receipt announced the outcome in advance | Now "…，改用一般記住處理" (handled as a regular memory); the next receipt has the result |
| m5 the request_id cache kept task titles | Stored with empty titles and fetched again on replay; cleared when memory is turned off, when the memory layer closes and on reconcile |
| m6 test gaps | Added voice, memory off/consent/overflow, the round bound, the race, English negatives and a single corrupt task file |
| m7 HTTP deletion changed memory without a memory ticket | The `subscribeDeleted` link is removed; the reconcile on open and on the trusted main window's turn/list handles it (W18) |
| nit | The `shellOf` comment moved back; the duplicate `hiddenNow` filter removed (`listFor` already handles it); the accessible label "連到：{title}" on "link to this work"; the overflow path no longer changes the epoch |
