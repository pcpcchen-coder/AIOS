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
