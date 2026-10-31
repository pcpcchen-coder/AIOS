<!-- bilingual: source=zh-TW -->

> [繁體中文](mac-acceptance-runbook-2026-10-30.md) | [English](mac-acceptance-runbook-2026-10-30.en.md)

# Mac acceptance runbook (2026-10-30)

Date: 2026-10-30, Asia/Taipei. Code baseline: main [`36996d9`](https://github.com/pcpcchen-coder/AIOS/commit/36996d9f22c01080c7bc1175564b362b05ef44f2).

This runbook gathers the pending Mac steps of six batches, which are spread across their own evidence records, into one checklist that can be followed in order, so George can schedule them on the Mac in one pass. **It is a consolidation, not a new validation result.** When this runbook was written, every Mac step in the table below was still unexecuted. The existence of this runbook does not mark any batch as passed.

Rules:

- The **source evidence record** governs the full wording, commands, and pass criteria of each step. If a summary here disagrees with its source, follow the source and report that this runbook needs a correction.
- Use fictional people and preferences only (for example George, Amy, "I don't eat cilantro"). Screenshots and recordings must not contain real personal data.
- Record failures, what the model actually said, and every deviation from the expectation. Reading the log alone is not a pass; the actual result must be heard or seen.
- Write results into new records (see §11) and commit Chinese and English versions together. Do not rewrite the cloud results in the original evidence records.

## 1. Overview

| Order | Batch | Source steps | Main release condition | Special equipment or conditions | Length (rough estimate, not measured) |
|---|---|---|---|---|---|
| 1 | Results history HIST-1 | [HIST-1 §5](history-hist1-2026-10-30.en.md#5-mac-verification-steps-not-run) steps 1–9 | Menu items, Surface, `/history`, native delete dialog, and dismissal work on the Mac | None; uses the mock engine | Short |
| 2 | Text-chat memory MEM-1 | [MEM-1 §4](memory-mem1-2026-10-29.en.md#4-mac-gate-none-run-must-not-be-claimed-as-passed) steps 1–10 | Keychain allow and deny with a properly signed App, real `lockf` dual cores, consistency after SIGKILL | Signed App; real Claude and ChatGPT accounts (step 8) | Medium |
| 3 | Family name greeting ID-02 | [ID-02 §5](family-id-02-2026-10-25.en.md#5-georges-pending-mac-tests) steps 1–10 | On both voice routes, the opening line actually heard is from the list, with no added words and no guessed names | Camera; at least one enrolled family member; one stranger or unenrolled person | Medium |
| 4 | ChatGPT-plan voice memory MEM-2 | [MEM-2 §4](memory-mem2-2026-10-30.en.md#4-mac-test-steps-all-unexecuted-no-pass-may-be-claimed) steps 0–11 | **Step 5 recording proves no late old audio after revocation** | Recording rig (§3); a second playback device; Codex sign-in | Long |
| 5 | API key voice memory MEM-3 | [MEM-3 §5](memory-mem3-2026-10-30.en.md#5-mac-test-steps-none-run-must-not-be-claimed-as-passed) steps 0–15 | **Wire probes P1 and P2 hold**, and the step 5 recording as in MEM-2 | Same as MEM-2; a real `OPENAI_API_KEY` (billed) | Long |
| 6 | Wake word spike WK-00 | [WK-00 §7](wk-00-spike-2026-10-29.en.md#7-mac-test-steps-for-george) steps 1–6 | Family positives produce hits; TV negatives run for at least 8 hours | `sox`; family members; TV running overnight | Long (includes 8 unattended hours) |
| 7 (added 2026-10-30) | Voice delegation with memory MEM-4b | [MEM-4b §5](memory-mem4b-2026-10-30.en.md#5-mac-gate-none-of-it-has-been-run-it-cannot-be-claimed-as-passed) steps 1–11 | Calibrate the ASR grace and similarity threshold; on the API key route committed / item_id / response_id match; record short-affirmative and TV bindings honestly | Same as MEM-2/MEM-3; tasks stored encrypted; `NOUS_MEMORY_ROUTES` includes `task` | Medium |
| 8 (added 2026-10-30) | Protected-result search and plaintext lifecycle MEM-4c | [MEM-4c §5](memory-mem4c-2026-10-30.en.md#5-mac-gate-none-executed-no-pass-may-be-claimed) steps 1–12 | The log shows a drop on a real lock, sleep, idle, memory off, and App quit; the latency of the first and second search after unlocking is recorded honestly; on a Keychain denial the screen shows the error honestly, not an empty result; the page is also cleared after a lock | Tasks stored encrypted (MEM-4a); some fictional protected tasks; 500 / 2000 tasks if possible | Short to medium |
| 9 (added 2026-10-30) | Memory suggestions and family collaboration MEM-5a | [MEM-5a §6](memory-mem5a-2026-10-30.en.md#6-mac-gate-none-executed-no-pass-may-be-claimed) steps 1–8 | The real screen of the one-line suggestion under the reply (Chinese and English); saving only on "Remember" and still there after a restart; one week of real counts recorded honestly; an older App reading version 4 disables memory and leaves the file unchanged | `suggest` in `NOUS_MEMORY_ROUTES`; fictional people George and Amy; an older App built from main `7fc7d09` (step 7) | Short (step 6 takes a week) |
| 10 (added 2026-10-30) | Work decisions linked to tasks MEM-5b | [MEM-5b §5](memory-mem5b-2026-10-30.en.md#5-mac-gate-none-executed-no-pass-may-be-claimed) steps 1–10 | The real choice card (Chinese and English); saving only on a click, and the same as MEM-5a with the flag off; work decisions disappear on the reconcile after deletion and on two-hop withdrawal, and are kept when memory is turned off; unreadable tasks are not purged | Tasks stored encrypted (MEM-4a); `work_summary` in `NOUS_MEMORY_ROUTES` (plus `task` for step 6); fictional people George and Amy; an older App built from main `d0ff7bb` (step 9) | Short to medium |

## 2. Why this order

1. **HIST-1 first.** It is the shortest and needs no special equipment. HIST-1 §7 also states that "George completes §5 on the Mac" is the gate before starting MEM-4a. Another conversation is working on the memory layer right now, so the sooner this step happens, the better. (HIST-1 was merged to main through PR #50, but its Mac verification has not been run.)
2. **MEM-1 second.** MEM-2 and MEM-3 build on MEM-1's Keychain, file lock, and memory management screen. If those foundations fail on the Mac, the voice memory steps mean nothing.
3. **ID-02 third.** It verifies look to talk and family recognition. The "face candidate" steps of MEM-1 step 5, MEM-2 step 2, and MEM-3 step 2 use the same chain. Confirming recognition and greetings first makes later failures easier to attribute to the right layer.
4. **MEM-2, then MEM-3.** Both use the same recording rig, so doing them on the same day is recommended. If wire probe P1 or P2 in MEM-3 step 0 fails, MEM-3 is not released and steps 1–15 need not continue (record the result and stop).
5. **MEM-4b after MEM-3 (added 2026-10-30).** It reuses the MEM-2 and MEM-3 voice routes and MEM-4a's task encryption; if those prerequisites fail on the Mac, MEM-4b results mean nothing. MEM-4a's own Mac steps are in [MEM-4a §5](memory-mem4a-2026-10-30.en.md#5-mac-gate-none-executed-no-pass-may-be-claimed); this runbook does not consolidate them separately.
6. **MEM-5a after MEM-1 (added 2026-10-30).** It uses only ordinary text chat and the memory manager, so steps 1–5 can be done on the same day as MEM-1; step 6 needs a week of normal use; step 7 needs a separately built older App from main `7fc7d09`.
7. **MEM-4c after MEM-4a's Mac steps (added 2026-10-30).** It builds on MEM-4a's task encryption; steps 1–5 only need locking, sleeping, waiting, and reading the log, so they can be done on the same day as other batches.
8. **MEM-5b after MEM-4a and MEM-5a (added 2026-10-30).** It builds on task encryption (MEM-4a) and the memory cards; step 6 also needs memory in background tasks (`task`); step 7 deletes work from `/history` and quits the App straight away.
9. **WK-00 independently.** It is a command-line spike not wired into the product and can be scheduled separately. The 8-hour TV negative run suits an unattended evening.

## 3. Shared preparation (once)

### 3.1 Record this Mac

Put at the top of each result record: Mac model, chip, macOS version, Electron version (the App's About menu or `desktop/package.json`), the commit used to build the App (`git rev-parse --short HEAD`), and the signing identity (`codesign -dv --verbose=2 Nous.app 2>&1 | grep Authority`).

### 3.2 Build the App

Follow "Build your own package" in [`desktop/README.en.md`](../../prototype/ambient-shell/desktop/README.en.md):

```bash
cd prototype/ambient-shell
npm ci
cd desktop
npm ci
npm run package
```

MEM-1 step 1 requires a **properly signed** App: first create the `Nous Local Signing` certificate as described under the desktop README's "Stable signing and local permissions" section, then package, and confirm that the terminal shows the fixed identity. Note ad-hoc signed results as such in the record; they are not evidence for proper signing. ID-02 needs the family recognition models:

```bash
cd prototype/ambient-shell
npm run face:setup -- --product
```

### 3.3 Isolate data

All App data lives in `~/Library/Application Support/Nous/` (`.env`, `data/`, `memory/`, `identity/`, `nous.log`). The App has no setting to move this location, so isolate by backing up and restoring:

```bash
ditto ~/Library/Application\ Support/Nous ~/Nous-backup-$(date +%Y%m%d)
```

- Quit Nous before backing up. All data during acceptance is fictional; after everything is done and Nous is quit, decide whether to restore the backup.
- MEM-1 requires "do not read the existing gallery". To leave enrolled family members untouched during the MEM batches, move `identity/` to the backup location first; enroll fictional or consenting family members before ID-02.
- Core settings and test-only flags go in `~/Library/Application Support/Nous/.env` (openable from the menu bar); the core watches the file for changes. Remove test-only flags at the end of each batch.

### 3.4 Log

```bash
tail -f ~/Library/Application\ Support/Nous/nous.log
```

Keywords per batch: for MEM-2 and MEM-3, revocation sent, `stopped`, `forceSilence`, hangup, and new call started; for ID-02, the greeting decision (「問候決策」); for MEM-3, the sideband attached message (「旁路已接上」). By design the log contains neither memory content nor names; seeing either is a canary failure and must be recorded.

### 3.5 Recording rig (MEM-2, MEM-3)

As in MEM-2 step 0: install BlackHole 2ch, create a Multi-Output Device in Audio MIDI Setup (speakers plus BlackHole), and record BlackHole with Audacity; also record with a phone nearby. Prepare another device that can play recorded phrases to simulate a TV or another person (for example "記住，我喜歡吃辣" and "確認記住").

## 4. Batch 1: HIST-1 results history

Prerequisites: the App from §3.2, using the mock engine (`NOUS_PROVIDER=mock`).

> Note (N1 from the 2026-10-31 Mac acceptance): the mock engine does not necessarily stay selected in the App. After the engine is switched to mock through the local API, typing one ordinary chat line in the App can make the App's `prepareConversation` switch the engine back to ChatGPT automatically (it does this when the engine was not chosen from the App menu), and tasks submitted or redone afterwards then really call the model. This behavior has not been changed. Before each submission, check the engine line (or `/api/settings`) to confirm it is still "Mock"; if it was switched back, record honestly which engine the task actually used.

- [ ] 1. Submit 3–5 tasks, including one whose title contains Simplified Chinese ("准备晚饭") and one that fails or is stopped.
- [ ] 2. The menu bar has "Results history…" and "Open results history in browser" (Chinese UI: 「成果紀錄…」 and 「在瀏覽器打開成果紀錄」). Open both and take screenshots; the browser URL is `http://127.0.0.1:<port>/history?lang=…` and search works.
- [ ] 3. Type 「搜尋成果 晚飯」 (Traditional query for Simplified text), 「找之前關於晚餐的成果」, and 「成果紀錄」; matches are highlighted. 「看結果」 still opens only the most recent result.
- [ ] 4. Say 「進度如何」; the "Search all results" button appears near "N earlier tasks not listed", and clicking it opens results history.
- [ ] 5. The detail page shows the original request, engine, time, assumptions, capability gaps, and steps; "Redo" switches to the new task's progress.
- [ ] 6. "Delete" shows a native macOS dialog whose buttons are "Delete" and "Cancel" (Chinese UI: 「刪除」 and 「取消」); Cancel does not delete; after confirming, the task leaves the list. With encrypted storage (MEM-4a), `data/` holds `tasks.json` (shells only, no titles), `sealed/` (one encrypted file `<id>.enc` per task and per result), and `plaintext-backup-*` (the plaintext backup from before migration, kept until the user confirms deletion), so a `grep` for the title cannot prove deletion. Instead confirm that neither `/api/tasks` nor `tasks.json` has that `task_id`, and that `sealed/` has neither `<task_id>.enc` nor its result's `<artifact_id>.enc`. Old task titles that were already in `plaintext-backup-*` before migration are outside the scope of this step. Running tasks have no delete button.
- [ ] 7. Say or type 「收起」, or press Esc: only the view closes and running tasks continue.
- [ ] 8. Latency: run `npx vitest run tests/history-search.test.ts tests/history-http.test.ts --reporter=verbose` and record the two `[history perf]` lines.
- [ ] 9. Save screenshots in a new folder under `docs/validation/`.

## 5. Batch 2: MEM-1 text-chat memory

Prerequisites: a properly signed App; the memory folder starts empty.

- [ ] 1. **Keychain (main):** the system prompt appears on first memory use; after allowing, quitting and reopening reads the data back. Separately press "Deny": memory is disabled, no plaintext is created, and ordinary chat continues.
- [ ] 2. **Dual cores (main):** open two cores on the same userData; the second shows "another Nous core is using memory".
- [ ] 3. **SIGKILL (main):** force-quit during a write; after reopening, receipts and data agree.
- [ ] 4. Performance: with 1,000 valid memories, warm retrieval p95 ≤50 ms and durable write p95 ≤300 ms; also record first unlock and full waiting time, without hiding Keychain prompt time in an average.
- [ ] 5. Face candidate: after an enrolled linked family member is recognized and types, "Use X's preferences this time?" appears and selection only happens on confirmation; it pauses when several people are in view, the person leaves, or the camera stops; it does not pause for merely turning the head or looking at the keyboard.
- [ ] 6. Lock and unlock the OS: the current person pauses and an in-progress reply stops.
- [ ] 7. Screenshots: first-run setup, clarification card, person creation, list (edit / forget / pin), memory management, and the family deletion checkbox dialog, in both Chinese and English.
- [ ] 8. Real Claude and real ChatGPT accounts: retrieve the same memory once on each service; after switching accounts without consent, nothing is sent.
- [ ] 9. Time Machine exclusion result; `nous.log` canary scan.
- [ ] 10. With memory off, launch, status checks, and ordinary chat cause no Keychain prompt and do not create `userData/memory`.

## 6. Batch 3: ID-02 family name greeting

Prerequisites: set `NOUS_CAMERA=on` in `.env`; enroll George in "Family recognition…" (another family member is better); turn on look to talk, "Greet first during look to talk", and "Use recognized family names in greetings". Open the DevTools console for `[看著說話時序]` and watch `nous.log` for greeting decisions. **Do every item once on each route** (set "Realtime voice route" to API key first, then to ChatGPT plan).

- [ ] 1. **Name greeting (main):** walk from 2 m to 1.0 m, face the screen, and stay silent. After about 0.6 seconds, a listed line containing the name is heard exactly once. Repeat 3 times and record whether each differs from the previous one. Record the full line heard, the caption, and the log reason (expected `ok`). **If the model adds words, changes words, guesses a name, or repeats, mark that route as failed.**
- [ ] 2. Stranger or unenrolled person: only a nameless line such as 「我在」 is heard; the log shows `unknown` (or `collecting` / `no_evidence`).
- [ ] 3. Speaking first cancels: say 「新竹天氣如何」 immediately; no greeting, direct answer. Repeat once by typing while connecting.
- [ ] 4. Person change: George turns away and another person approaches within 1 second; George is not named.
- [ ] 5. Several people within 1 m: no name; log `multi_face`.
- [ ] 6. Turn off "Use recognized family names in greetings": only a nameless line; log `naming_off`; Activity Monitor shows no extra recognition load.
- [ ] 7. Delete George and reopen Nous: only a nameless line.
- [ ] 8. Timing: at least 5 runs per route, take the median, and record each stage in milliseconds relative to facing confirmation; compare "interaction started" with naming on and off (should be equal).
- [ ] 9. Concurrent load: raise a palm to stop 10 times before the greeting and 10 times during an answer; record successes and Renderer / GPU CPU%.
- [ ] 10. Whether a Keychain prompt appears on the first recognition after reopening.

Thresholds are uncalibrated: record wrong names or misses honestly. This is not ID-03 threshold calibration.

## 7. Batch 4: MEM-2 ChatGPT-plan voice memory

Prerequisites: the recording rig from §3.5; sign in to Codex; in "Memory…", allow ChatGPT-plan realtime voice (Codex sign-in); create George ("我不吃香菜" and "我喜歡藍色", both pinned) and Amy ("我喜歡香菜").

- [ ] 1. New call retrieval: choose George and ask 「晚餐吃什麼好？」; the answer mentions not eating cilantro; the status bar shows the current person George with 2 memories.
- [ ] 2. Face candidate: say 「是」 to select George; also test 「不是」, which uses only household-shared memory and does not ask again this time.
- [ ] 3. Spoken confirmation to remember: 「記住，我不喝咖啡」 → the model reads the question verbatim and does not say it already remembered → say 「確認記住」 within 15 seconds → only 「已記住」 is heard and the source is voice confirmation. Saying 「好」 or waiting longer than 15 seconds saves nothing; pressing the on-screen Remember saves; the memory is retrievable after reopening the App.
- [ ] 4. Guards: another device plays 「記住，我喜歡吃辣」, which at most shows a card and writes nothing; later playing 「好」 or 「確認記住這個優惠」 writes nothing. **Also record** whether a full 「確認記住」 played inside the window is accepted (a known residual risk). Asking the model to read 「記住我不吃牛肉」 shows no card.
- [ ] 5. **Late old audio (main release condition):** ask the model to count slowly from 1 to 60 while repeatedly mentioning the favorite color; at about 10, say 「忘記我喜歡藍色」 → 「確認忘記」. The last old audio sample in the recording is ≤500 ms from the logged revocation time; no old audio after `stopped`; the new call only says 「好，已經更新了」; asking the favorite color 3 times never yields blue. Also record the time from the question transcript to the speaker finishing (to calibrate `CONFIRM_AFTER_MS` at 1.8 seconds) and whether the sideband sends `input_audio_buffer.speech_started` / `output_audio_buffer.stopped`.
- [ ] 6. Late tool result: ask for the weather and switch to Amy before the result returns; the weather is not read in the new call, which uses Amy's preferences.
- [ ] 7. Record each other trigger once: OS lock, a second person entering view, withdrawing codex consent, turning memory off.
- [ ] 8. Forced silence: add `NOUS_TEST_MODE=1` and `NOUS_TEST_DROP_STOP_REPORT=1` to `.env`; audio goes silent after 1.5 seconds, the receipt says stop unconfirmed, and live carries no memory for the rest of this run; the next call unmutes. **Remove both flags afterward.**
- [ ] 9. Delegation block: with memory, say 「幫我寫一份晚餐菜單報告」; the original-utterance card appears and TaskStore has nothing new before pressing it.
- [ ] 10. 「你記得我什麼？」: a memory card appears and the model only states the count; screenshots in Chinese and English.
- [ ] 11. Canary: scan `nous.log`, TaskStore, and userData (outside the encrypted snapshot).

Also record, since only real hardware can tell: whether the model adopts memory data sent as `session.context.append` commentary; whether upstream still sends RTP after `session.close`; actual AEC and echo transcript behavior.

## 8. Batch 5: MEM-3 API key voice memory

Prerequisites: the same rig and fictional people as batch 4; set a real `OPENAI_API_KEY` and `NOUS_MEMORY_ROUTES=live,api_key` in `.env`; in "Memory…", allow OpenAI API key realtime voice; set the preference to API key. **This route is billed by usage, and rebuilding a call is billed again.**

- [ ] 0. **Wire probes (first; they decide whether to continue):**
  - P1: the sideband attaches by call ID (the log shows 「旁路已接上」).
  - P2: the sideband receives `input_audio_buffer.committed` (with an `item_id` matching the transcript), `conversation.item.input_audio_transcription.completed`, `response.output_audio_transcript.done`, `response.function_call_arguments.done`, `output_audio_buffer.started/stopped`, and `error` pointing back to a core `event_id`.
  - P3: the sideband `session.update` takes effect (asking 「你知道我不吃什麼嗎」 is answered correctly).
  - P4: RTP stops after hangup; record changes to `peer.connectionState`.
  - P5: whether the page data channel receives `session.created` / `session.updated` and echoed instructions.
  - **If P1 or P2 fails, MEM-3 is not released; record and stop**, then evaluate option ② of MEM-3 plan 2(b) (the renderer handles media only).
- [ ] 1–11. Same as batch 4 steps 1–11, except: the status bar shows 3 memories; the consent target is `openai_realtime`; after forced silence, API key carries no memory while live still may; the canary also confirms that content echoed under P5 was neither stored nor forwarded by the page.
- [ ] 12. Hangup only: `NOUS_TEST_MODE=1` plus `NOUS_TEST_RENDERER_IGNORE_REVOKE=1`; record how long until silence after hangup and whether the 1.5-second forced silence takes effect. **Remove the flags afterward.**
- [ ] 13. Fallback: make live fail (sign out of Codex) → switch to API key; the billing notice is spoken; memory is carried only with `openai_realtime` consent; the status bar shows the reason.
- [ ] 14. Cross-route: remember 「我不喝咖啡」 on live → ask 「我喝什麼」 on API key; forget on API key → ask 3 times on live.
- [ ] 15. Separate release: remove `NOUS_MEMORY_ROUTES`; the API key route shows that memory is not enabled for this route, the log shows no sideband opened, and memory management does not list API key realtime voice.

Main release condition: P1 and P2 hold, and the step 5 recording proves no late old audio after revocation. The 11 defaults in MEM-3 §3 still await George's confirmation; decide them together after the hardware tests.

## 8a. Supplementary batch: MEM-4b voice delegation with memory (added 2026-10-30)

Prerequisites: the same rig and fictional people as batches 4 and 5; tasks stored encrypted (MEM-4a); `NOUS_MEMORY_ROUTES=task` in `.env` (`task,api_key` for the API key route); memory on, with the task engine (Claude or ChatGPT) allowed. The full conditions for every step are in [MEM-4b §5](memory-mem4b-2026-10-30.en.md#5-mac-gate-none-of-it-has-been-run-it-cannot-be-claimed-as-passed).

- [ ] 1. Calibrate grace: at least 10 runs each of "ASR first, delegation second" and "delegation first, ASR second"; record the distribution of the gap.
- [ ] 2. ASR title quality: 10 sentences each in Chinese and English; record how titles differ from what was said, and how often similarity falls below the threshold and a card appears.
- [ ] 3. Echo while the model speaks: no task may be created from the model's speech.
- [ ] 4. A TV or bystander says something that sounds like a delegation: record which sentence is bound.
- [ ] 5. Short affirmatives: "幫我規劃晚餐" (plan dinner for me) → the model asks → "好" (OK); only "好"; a different request inserted in between; "不要" (don't) and "等一下" (wait) never delegate.
- [ ] 6. No consent: live without codex consent can still do protected delegation; API key without `openai_realtime` consent follows M15.
- [ ] 7. Keychain refusal (tasks not stored encrypted): no protected delegation.
- [ ] 8. Forget after delegation: the task stops with `memory_revoked`; a person change or ending the call: the task continues.
- [ ] 9. Record the completion announcement: no other family member's memory-carrying title is spoken.
- [ ] 10. API key P2 mapping: the `item_id` of `committed`, the `response.id` of `response.created` and the `response_id` of `function_call` match; if not, protected delegation on the API key route is not released.
- [ ] 11. Protected original-sentence card: an SSE capture contains no sentence; "Delegate" carries memory; with the flags off the card is the same as in MEM-4a.

Main release criteria: the mapping and timing in steps 1 and 10 hold; wrong guesses in steps 4 and 5 are recorded honestly, and George decides whether to accept them.

## 8b. Supplementary batch: MEM-4c protected-result search and plaintext lifecycle (added 2026-10-30)

Prerequisites: a signed App; tasks stored encrypted (MEM-4a); some fictional protected tasks in the data folder (at least one with a canary); logging on. The full conditions for every step are in [MEM-4c §5](memory-mem4c-2026-10-30.en.md#5-mac-gate-none-executed-no-pass-may-be-claimed).

- [ ] 1. OS lock, then unlock: the log shows an `os_lock` drop; content reads back normally; record the ms of the first search after unlocking.
- [ ] 2. Sleep, then wake: the log shows `suspend`.
- [ ] 3. 11 minutes of idle: the log shows `idle`; the next search rebuilds the index.
- [ ] 4. Memory off: the log shows `memory_off`.
- [ ] 5. App quit: the log shows `quit`.
- [ ] 6. Latency: record cold and warm once each (500 and 2000 tasks if possible).
- [ ] 7. Keychain denial: the screen shows the error honestly (Chinese and English), not an empty result; `sealed/` is unchanged; everything recovers after allowing access.
- [ ] 8. A running task finishes normally after a lock.
- [ ] 9. After forgetting the memory, the result content is no longer found by search.
- [ ] 10. Scope: other family members' memory-backed results show only shells and become visible only after opening from the menu-bar "Results history…".
- [ ] 11. Canary scan of `userData/data/`.
- [ ] 12. The page is cleared too: lock and unlock with the results history and a result view open; the result view is collapsed, the results history shows only the hidden-content notice (Chinese and English), and tasks continue.

Main release criteria: the drops of steps 1–5 all appear in the log; step 7 is not an empty result; the numbers of step 6 are recorded honestly, and George decides whether to accept them.

## 8c. Supplementary batch: MEM-5a memory suggestions and family collaboration (added 2026-10-30)

Prerequisites: a signed App; the MEM-1 Mac steps done; `suggest` in `NOUS_MEMORY_ROUTES` in `.env`; fictional people George and Amy; logging on. The full conditions for every step are in [MEM-5a §6](memory-mem5a-2026-10-30.en.md#6-mac-gate-none-executed-no-pass-may-be-claimed).

- [ ] 1. Enable flow: the startup log states that memory suggestions are released; the memory manager shows "off (default)"; press "Turn on memory suggestions"; without `suggest` it shows "not available".
- [ ] 2. Single-line suggestion: for "我不吃香菜，晚餐吃什麼？" one line appears under that same reply only after it completes (screenshots in Chinese and English); "Remember" turns it into the receipt and the list shows the suggestion source; after "No" it disappears and the same sentence does not bring it back.
- [ ] 3. Where it must not appear: live voice, no person selected, a minor, an explicit memory command in the same turn, a third party, the past, today, an allergy, a cross-sentence joke, a proxy, religion; an unanswered suggestion disappears on the next turn.
- [ ] 4. Persistence: after a restart, the fact saved with "Remember" is still there and the setting is still on; unanswered suggestions are gone.
- [ ] 5. Family collaboration: a household addition shows "Household · noted by George · date" and the not-identity-verification note (Chinese and English); Amy gets no push; after deleting George it is no longer shown.
- [ ] 6. One week of real counts: `grep -c` daily for proposals, Remember, No and rate-limit lines; note every wrong suggestion by hand; compute the acceptance rate.
- [ ] 7. An older App (main `7fc7d09`) reading version 4: memory is disabled and the SHA-256 of `store.v1.enc` is unchanged; after returning to 2／3 the older App can read it again.
- [ ] 8. Canary: trigger a suggestion and press "No"; no canary in the logs or `userData/`.

Main release criteria: the real screen of step 2 and "saved only on Remember"; the unchanged file in step 7; the numbers of step 6 recorded honestly, with George deciding whether to expand, keep or turn it off.

## 8d. Supplementary batch: MEM-5b work decisions linked to tasks (added 2026-10-30)

Prerequisites: a signed App; the MEM-1 and MEM-4a Mac steps done (tasks stored encrypted); `work_summary` in `NOUS_MEMORY_ROUTES` in `.env` (plus `task` for step 6); fictional people George and Amy; logging on. The full conditions for every step are in [MEM-5b §5](memory-mem5b-2026-10-30.en.md#5-mac-gate-none-executed-no-pass-may-be-claimed).

- [ ] 1. Flag: the start-up log says work decisions are released; without `work_summary`, "記住這次選了方案 B" is still a plain note with no choice card.
- [ ] 2. Choice card: after two pieces of work finish, the same sentence shows "要連到哪一個工作？" and both titles (screenshots in both languages); after a click the receipt is a work decision and the list shows "工作決定 · 連到：…".
- [ ] 3. No eligible work: first an honest receipt, then a plain note.
- [ ] 4. Scope: George's memory task is not on Amy's card; George's list only says "outside the current scope".
- [ ] 5. Reconcile after deletion: delete the work in "Results history…" and type another sentence; the work decision disappears and the log says "任務已不存在" (task no longer exists).
- [ ] 6. Two-hop withdrawal: after forgetting "不吃香菜" both results are withdrawn and both work decisions disappear; the log says "2 筆，2 輪" (2 facts, 2 rounds).
- [ ] 6a. Turn memory off or revoke consent: the result is withdrawn, the work decision is kept and is still there after turning memory back on.
- [ ] 7. Reconcile after restart: delete the work from `/history` and quit the App straight away; after reopening and typing, the log says "任務已不存在" (task no longer exists).
- [ ] 8. Unreadable is not purged: with the tasks' Keychain denied, the log says "對帳略過" (reconcile skipped) and the work decision remains.
- [ ] 9. The older App (main `d0ff7bb`) understands the file and does not show work decisions; with no writes the file's SHA-256 is unchanged.
- [ ] 10. Canary: link a work decision to work whose title contains a canary; no canary in the log.

Main release criteria: the real screen of step 2 and "saved only on a click"; the cascading revocation of steps 5–7 and the keeping in 6a; no wrongful purge in step 8.

## 9. Batch 6: WK-00 wake word spike

Use the commands in [WK-00 §7](wk-00-spike-2026-10-29.en.md#7-mac-test-steps-for-george); this section only lists the order and the points to watch.

- [ ] 1. Install: `npm ci`, `npm run wake:setup`, `brew install sox`; allow microphone access for Terminal.
- [ ] 2. Check microphone and CPU: say 「哈囉努斯」 several times; each detection prints one JSON line.
- [ ] 3. Family positives: **do a 5-trial dry run per person first** (cloud synthetic positives hit 0/300, cause undetermined), then 30 trials per person; one round quiet and one with the TV on, one round per model; also run the two diagnostic rounds 「哈囉努斯(hā-lóu)」 and the subword 「努斯」. Use codes (A, B, C) for `--person`, never names.
- [ ] 4. TV negatives: run under `caffeinate -i` for at least 8 hours, counting only and not recording; if false alarms are frequent, note on paper roughly what was being said. Run the other model on another day.
- [ ] 5. Alongside the camera pipeline: record CPU with Nous idle for 10 minutes, then run `listen` at the same time for another 10 minutes, doing a few palm stops meanwhile.
- [ ] 6. (Optional) Build the browser wasm yourself.

Fill the numbers into the record table in WK-00 §7. By design audio is not written to files, and reports go to `$TMPDIR/aios-wake-spike/` outside the repository.

## 10. Steps that can be combined

| Shared content | Appears in | Suggestion |
|---|---|---|
| Face candidate "Use X's preferences this time?" | MEM-1 step 5, MEM-2 step 2, MEM-3 step 2 | Do these after ID-02 passes, so a failure is easier to attribute to recognition or the memory layer |
| Keychain prompt timing | MEM-1 steps 1 and 10, ID-02 step 10 | Observe them during the same App relaunch and record which feature triggers first |
| Canary scan | MEM-1 step 9, MEM-2 step 11, MEM-3 step 11 | Scan after each batch, not only at the end |
| Recording rig | MEM-2, MEM-3 | Do both on the same day and set up the rig once |

## 11. Recording results

Add one record per batch named `<batch>-mac-YYYY-MM-DD.md` and `.en.md` (for example `history-hist1-mac-2026-11-02.md`), with screenshots in a folder of the same name. Put reciprocal language links at the top of both, and run `node scripts/check-bilingual-docs.mjs` before committing. Use at least one row per step:

| Step | Expected | Actual | Evidence (screenshot / recording / log timestamp) | Pass / fail / not run | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

Do not put recordings in the repository (they may contain household audio); write the measured time differences and how they were measured instead. Then update the matching rows of [implementation status](../Current_Implementation_Status.en.md). Only when a batch's main release condition passes may it stop being described as "Mac gate not run".

## 12. Limits of this runbook

- It only consolidates steps from existing evidence records. It adds or relaxes no pass criteria, and none of its steps has been run on a Mac.
- The "Length" column is a rough estimate from step counts and whether recordings or overnight runs are needed. It was not measured and is not a scheduling commitment.
- If a source evidence record changes later (for example, when MEM-4a merges and changes the memory flow), the source governs and this runbook must be corrected to match.
- Remove test-only flags (`NOUS_TEST_MODE`, `NOUS_TEST_DROP_STOP_REPORT`, `NOUS_TEST_RENDERER_IGNORE_REVOKE`) afterward; do not treat `api_key` in `NOUS_MEMORY_ROUTES` as an everyday setting before the MEM-3 Mac gate passes.
