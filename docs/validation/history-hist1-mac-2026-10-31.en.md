<!-- bilingual: source=zh-TW -->

> [繁體中文](history-hist1-mac-2026-10-31.md) | [English](history-hist1-mac-2026-10-31.en.md)

# HIST-1 results history: Mac acceptance record (2026-10-31)

Run per [Mac acceptance runbook](mac-acceptance-runbook-2026-10-30.en.md) §4 and [HIST-1 §5](history-hist1-2026-10-30.en.md).

## Environment

| Item | Value |
|---|---|
| Mac | Mac mini (Mac18,5), Apple M6, 32 GB |
| macOS | 27.0.1 (26A434) |
| Electron | 44.9.3 |
| App build commit | `9c67e65` |
| Signing | ad-hoc (`Signature=adhoc`, no `Nous Local Signing`); HIST-1 does not need a formal signature |
| Engine | mock, switched through the local API; see note N1 |
| Operator | Step 1 and steps 6–9 were operated by Claude through computer use while George watched; steps 2–5 by George |

## Results

| Step | Expected | Actual | Evidence | Result | Notes |
|---|---|---|---|---|---|
| 1 | 3–5 tasks, one Simplified title, one stopped | Created 「准备晚饭」, 「整理本週會議紀錄」, 「寫一封感謝客戶的信」 (succeeded) and 「規劃週末家庭行程」 (cancelled) | `/api/tasks` status | Pass | Created through the local API; `/api/tasks` only shows 「受保護的任務，請在 App 內查看」 (expected MEM-4a behaviour) |
| 2 | Both menu items, both views open, `/history` searchable | George: both items present, both views opened, browser search works | George's own screenshots (contain real older tasks; not committed) | Pass | — |
| 3a | 「搜尋成果 晚飯」 finds the Simplified title, with highlight | Found 「准备晚饭」 with highlight | log `受保護搜尋（建立索引…比對 1／15，結果 1，10 ms）` | Pass | First attempt ran with look-to-talk on; typing and speech were taken by realtime voice (see F1); redone with it off |
| 3b | 「找之前關於晚餐的成果」 finds it | History opened with 0 results | log `比對 0／15，結果 0` (3 times) | **Fail** | See F2 |
| 3c | 「成果紀錄」 opens history | Listed all 15 | log `結果 15` | Pass | — |
| 3d | 「看結果」 opens only the latest result | Opened a single result | George's observation | Pass | — |
| 4 | Progress card shows 「另有 N 個較早的任務未列出」 and 「搜尋全部成果」, which opens history | Both present; opened history | George's observation; N=8 when Claude repeated it | Pass | Must be typed; saying 「進度如何」 in realtime voice does not open the card (F1) |
| 5 | Detail page shows six fields; 重做 switches to a new task | Six fields present; redo created `task_7b9a357e` (`retry_of` 准备晚饭) | `05-detail-page-mock.jpg`; log `重做（帶記憶 0 筆）` | Pass | The redo ran on ChatGPT (N1) |
| 6a | Running task has no delete button | No delete or redo; shows 「執行中的任務要先停止，才能重做或刪除。」 | `F3-running-task-detail-placeholder.jpg` | Pass | F3 found on the same screen |
| 6b | Delete shows a macOS native dialog; cancel keeps it; confirm removes it; title not in `data/` | Native sheet; still present after Cancel; after OK gone from the API, `tasks.json` and `sealed/`, title not found in `data/` (outside the plaintext backup folder) | `06-native-delete-dialog.jpg`; API and file checks | Pass | Buttons in English (F4); `data/` is now `tasks.json` + `sealed/` + `plaintext-backup-*`, so the runbook's "two JSON files" is outdated |
| 7 | 「收起」 and Esc only close the view; running tasks continue | Esc and typed 「收起」 only closed the view; both running tasks completed | `07-after-collapse.jpg`; task created 08:29:09, succeeded 08:29:20 | Pass | — |
| 8 | Record the two `[history perf]` lines | Search: 500 tasks × ~3k chars, median 1.9–2.1 ms, worst 8.2–8.3 ms; HTTP: 500 tasks, median 5.1 ms, worst 17.4 ms | `vitest --reporter=verbose` | Done | The HTTP line only printed when `history-http.test.ts` ran alone |
| 9 | Save screenshots under `docs/validation/` | 4 screenshots with fictional data only in `history-hist1-mac-2026-10-31/` | That folder | Done | List views contain George's real older task titles and were left out per the runbook |

## Findings

- **F1: realtime voice (ChatGPT plan) takes over local commands.** With look-to-talk on, facing the screen starts voice automatically; spoken 「進度如何」 and 「看結果」 were transcribed as Simplified (「进度如何」, 「看结果」) and answered by the model through `get_tasks` instead of opening the progress card or result view. Runbook step 4 "say 「進度如何」" does not hold on this route. Turn look-to-talk off and type during acceptance.
- **F2: 「晚餐」 does not find 「晚饭／晚飯」.** Search treats 晚餐 and 晚飯 as different words. Runbook step 3 lists 「找之前關於晚餐的成果」 as a phrase that should match; George to decide whether to change the example or support near-synonyms.
- **F3: a running protected task shows placeholder text in the App.** On the detail page and the progress card, the title, original request and every step of a running task read 「受保護的任務，請在 App 內查看」 and 「受保護的步驟」, while the history list shows 「准备晚饭」 and the detail page is correct once the task completes.
- **F4: the delete confirmation buttons are in English.** The message is Chinese but the buttons read "Cancel" / "OK"; they should be 「取消」 / 「刪除」.

## Notes

- **N1:** After switching the engine to mock through the local API, typing an ordinary chat message in the App switched it back to ChatGPT (the App's `prepareConversation` does this when the engine was not chosen from the App menu). The redo in step 5 therefore ran on ChatGPT `gpt-6.1-sol`. The runbook's "use the mock engine (`NOUS_PROVIDER=mock`)" does not stay in effect in the App.
- When the history view read 「共 14 筆」, `/api/tasks` returned 15; one task is not listed and has not been identified yet.
- `~/Library/Application Support/Nous` was fully backed up before acceptance (`~/Nous-backup-20261031-080317`).

## Conclusion

HIST-1's main release condition (menu, Surface, `/history`, native delete dialog and collapse work on a Mac) holds. Step 3b fails (F2), and F1, F3 and F4 remain open.

## Fixes for the Mac findings (2026-10-31, branch `claude/hist1-mac-fixes`)

These fixes were verified only by automated tests on Linux and **have not been re-accepted on a Mac**. The result rows above stay as they were and are not changed to passed because of this. F1 (live voice takes over local commands) and N1 (the mock engine is switched back to ChatGPT in the App) were not changed this time.

| Finding | Cause | Fix | Tests |
|---|---|---|---|
| F2: 「晚餐」 does not find 「晚飯／晚饭」 | Search only folded Simplified and Traditional characters; 「晚餐」 and 「晚飯」 are different characters | George chose synonym support. `server/search-terms.ts` adds a small, explicitly listed synonym table (晚餐／晚飯／dinner, 午餐 (lunch), 早餐 (breakfast), 會議／開會／meeting, 計畫／計劃／規劃／plan, 行程／日程／itinerary, 郵件／電郵／信件／email, 報告／report; 「行程」 (itinerary) and 「計畫」 (plan) are separate groups). It expands only the query terms, never the stored text, and folding is unchanged; plaintext search (`server/history.ts`) and the protected RAM index (`server/protected-index.ts`, never written to disk) use the same computation. A synonym hit counts as a hit but scores half of the original term. Ranking compares coverage, then the number of query terms with an exact hit, then the score (the same in both search paths), so at equal coverage the result with more exact hits always ranks first. Synonym hits are highlighted in snippets and titles too; plaintext search ranks first and builds highlights and snippets only for the current page (as MEM-4c does). The whole-word rule applies only to English synonyms; the original query term still uses substring matching. A one-character word is expanded only for a standalone 「信」 (letter) term, and it is never used as a synonym of another word. Chinese synonyms use substring matching and can match across word boundaries; the known cases 「離開會場」, 「每日程式」 and 「法規劃分」 are excluded, but other cross-word matches can still occur (a known limitation). | `tests/history-search.test.ts` (「找之前關於晚餐的成果」 finds 「准备晚饭」, dinner finds 晚餐, an exact match outranks a synonym match, no false expansion), `tests/protected-search.test.ts` (the MEM-4c randomized parity test and the 160-task parity test now include synonyms) |
| F3: running protected tasks show placeholders in the App | The core already returned the real content of running tasks over IPC; the problem was on screen. (1) When the detail page received a shell update over SSE, it replaced the real task read over IPC with the shell; the on-screen `display` result still carried the `protected` flag, so the detail page's `shellView` turned the title and steps back into the fixed text. (2) The progress card's redraw key did not include titles, so after IPC returned the real content the key did not change and the card kept the placeholders from its first draw. After completion the detail page reloads because `artifact_id` changes, which is why it looked correct afterwards. | `mergeLiveTask` in `src/protected-tasks.ts`: shell updates only change status, step status, times and character counts, and keep the real title, original request, step titles and error. The detail page also keeps the last task read over IPC unchanged (placeholder text is never written into it), and `ProtectedTasks.liveContent` reports which displayed fields are real. The detail is read again when new steps are planned, when the task finishes (a failed or stopped task without a result keeps `artifact_id` unchanged), when an error appears, and on withdrawal or memory revocation; on withdrawal or memory revocation the page shows only the shell at once and keeps no real step titles or error. `progressStructureKey` in `src/views.ts` now includes the title and step titles. Outward channels (SSE, `/api`, the browser `/history`) still get shells only; out-of-scope tasks are still shells. | `tests/history-surface.test.ts`, `tests/tasks-ipc.test.ts` (a running task over IPC has real content, SSE and `/api` are shells, a running task is still readable after a lock) |
| F4: the delete confirmation buttons are English | The App used `window.confirm`, whose Electron buttons are always the system's "Cancel／OK" and cannot be changed | Switched to `dialog.showMessageBox` in the main process: a new IPC `nous:confirm-delete` (trusted-sender check, shape filter, carries only the title for display), with buttons 「刪除」 and 「取消」 through the shared translation table, "Delete" and "Cancel" in English; Cancel is the default and the cancel button; Cancel, closing the dialog or a failure deletes nothing, and nothing is deleted if the detail page switched to another task or back to the list while the dialog was open. The display title has control characters, bidirectional controls and line/paragraph separators replaced, is refused if empty after trimming, and is truncated to 500 code points. The other native confirmations (family data, memory, deleting the plaintext backup, restart) already used `showMessageBox`; a test confirms every button has an English translation. The browser version (no IPC) still uses the browser's confirm box, whose button text the browser decides. | `tests/tasks-ipc.test.ts`, `tests/history-surface.test.ts`, `tests/identity-ipc.test.ts` |

The runbook ([Mac acceptance runbook](mac-acceptance-runbook-2026-10-30.en.md) §4) is updated too: the prerequisites now describe N1, and step 6 now checks `data/` as it is with encrypted storage (`tasks.json` + `sealed/` + `plaintext-backup-*`) and states the button text.

### To re-verify on the Mac

1. Step 3b: type 「找之前關於晚餐的成果」; results history finds 「准备晚饭」 with 「晚饭」 highlighted; in the English UI, "search past results for dinner" finds it too. The result count in the log line `受保護搜尋（…）` (protected search) is not 0.
2. F3: submit a task that runs for a while and open its detail page and progress card while it runs; the title, original request and every step show real text, and they do not turn back into 「受保護的…」 (protected …) as the steps advance.
3. F4: when deleting, the buttons are 「刪除」 and 「取消」 in the Chinese UI and "Delete" and "Cancel" in the English UI; Cancel deletes nothing and only Delete deletes; check `data/` as in runbook step 6.
4. F3 transitions: after a running task fails (no result), the detail page shows the real error text and does not stay on 「受保護的錯誤說明…」 (protected error text); after a memory-derived result is withdrawn, the detail page immediately shows only the shell and the withdrawal note.
5. F4: switching to another task or back to the list while the dialog is open, then pressing Delete, deletes nothing.
6. The difference between "14 in total" and the 15 tasks from `/api/tasks` in the notes is still unexplained and was not handled this time.
7. Existing behavior (not changed this time): switching the current person does not clear an open detail page automatically; it is cleared only when the core drops decrypted content (lock, idle, turning memory off, and so on) or when the user closes it.
