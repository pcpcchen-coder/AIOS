<!-- bilingual: source=zh-TW -->

> [繁體中文](history-hist1-2026-10-30.md) | [English](history-hist1-2026-10-30.en.md)

<a id="hist-1-成果紀錄一般任務的可搜尋閱讀器雲端驗證與-mac-驗證步驟"></a>
# HIST-1 results history (a searchable reader for ordinary tasks): cloud verification and Mac verification steps

Dated 2026-10-30, Asia/Taipei. The starting point is main `b54c3af` (which already contains MEM-1, MEM-2 [PR #47], and MEM-3 [PR #48]); the work is on branch `claude/mem-4` and has not been committed, pushed, or merged. All test data is fictional.

**Batch status: the HIST-1 code and the parts verifiable in the cloud (Linux) are complete; Mac verification (screenshots, menu, native confirmation dialog, latency with a real data folder) has not been run.** Results history covers only plaintext ordinary tasks and results. Task and result encryption, search over protected results, and memory in background tasks are not implemented (MEM-4a, MEM-4c). View behaviour is verified with fake-DOM unit tests and HTTP tests; the same day's independent review also drove `/history` and the App Surface in an ordinary browser in the cloud with Playwright (headless Chromium, Chinese and English; see the screenshot list in section 8), but nothing was operated inside the macOS App or Electron, so the native dialog and menu still need Mac verification.

<a id="1-擁有者決定george2026-10-30"></a>
## 1. Owner decisions (George, 2026-10-30)

- Build the reader in both forms: (a) an on-demand Surface in the App main window; (b) a standalone `/history` web page that opens in an ordinary browser.
- Order: the reader first (ordinary tasks, HIST-1), then memory safety (MEM-4a: encryption, revocation, automatic memory in background tasks), and finally search over protected results (MEM-4c). The API must let a later protected source merge in.
- The reader may delete, but only after native (or explicit) confirmation.
- The other MEM-4 decisions (encrypt all tasks with a one-time migration, on revocation delete content but keep the shell and allow redo, a person switch does not abort, work_summary moves to MEM-5) belong to later batches and are not implemented here.

<a id="2-設計"></a>
## 2. Design

<a id="21-搜尋-api"></a>
### 2.1 Search API

`GET /api/history?q&status&mode&from&to&cursor&limit`

| Parameter | Meaning |
| --- | --- |
| `q` | Query text, at most 200 characters; empty = list everything (newest first) |
| `status` | Task status; several may be comma-separated (`succeeded`, `failed`, `cancelled`, `running`, `queued`, `cancelling`) |
| `mode` | Engine: `claude`, `chatgpt`, `mock` (comma-separated allowed) |
| `from`, `to` | `YYYY-MM-DD` (a whole local day; `to` includes that day; nonexistent dates such as `2026-13-45` or `2026-02-31` return 400) or a full ISO time; compared with the assignment time |
| `cursor` | The previous page's `next_cursor` (opaque string) |
| `limit` | 1–50, default 20 |

Malformed values return 400 instead of being guessed; error messages are Chinese source strings translated to English through the shared catalog (for example “The start date is after the end date”, “Invalid date”, “Task not found”). The date fields in the view also keep the start date from being after the end date. The response is `{ items, total, next_cursor, sources }`; each `item` has `task_id`, `artifact_id`, `title` (the user's original sentence), `status`, `mode`, `model`, times, `source` (currently only `"tasks"`), `protected` (always `false` in HIST-1), `score`, `title_matches`, and `snippet` (`field`, `text`, `matches`, `truncated_start`, `truncated_end`).

There is also `GET /api/history/:taskId` (one record: task, result, source) and `POST /api/history/:taskId/delete` (see 2.4).

<a id="22-比對與排序"></a>
### 2.2 Matching and ranking

- The matching approach was extracted from memory retrieval (`server/memory/retrieve.ts`) into the shared `server/search-terms.ts`: Simplified-to-Traditional folding, Chinese two-character fragments, and English words. Memory retrieval now uses the same functions with unchanged behaviour (all existing memory tests pass). The memory Simplified-to-Traditional table (`server/memory/parse.ts`) is unchanged, because voice memory also uses it before saving; search has its own supplementary table (common task characters, one-to-one only), and one-to-many characters such as 划/劃 and 发/發/髮 fold the Traditional forms to the shared character (`劃→划`, `發, 髮→发`). Both sides are folded, so matching is consistent, and only matching is affected; no original text changes.
- Search-box query terms: each run of Han characters is split into two-character fragments (a single Han character is a term on its own); English and number words need at least 2 characters; everything is folded to Traditional and lower case. Text is folded character by character without changing its length, so match positions can be marked directly on the original text (including Simplified originals).
- Fields matched: task title (weight 3), result content (plain text with Markdown syntax removed, weight 2; only paired emphasis markers are removed, so underscores in identifiers such as `ANTHROPIC_API_KEY` stay; every pattern has a length bound, so pathological content cannot make the regular expressions quadratic), step titles and assumptions / capability gaps (weight 1). When the whole query appears in a field, that field's weight × 2 is added.
- With two or more query terms, at least half must match, to avoid noise from a single fragment.
- Ranking: fraction of query terms matched → weighted score → assignment time, newest first → `task_id`. Pages hold 20 items.
- A snippet is centred on the first match with about 120 characters on each side (`HISTORY_SNIPPET_RADIUS`) and never splits a surrogate pair; adjacent fragments (“香菜”, “菜湯”) merge into one highlight. Snippets prefer result content, then steps, then notes; when only the title matches, the start of the result is shown.

<a id="23-不寫索引不記查詢"></a>
### 2.3 No index written, no query logged

Each query takes a snapshot from `TaskStore` and matches it in core memory; no index file is created or written, and the data folder still contains only `tasks.json` and `artifacts.json` (tested). The plain text and folded form of result content are reused from core memory (keyed by `artifact_id`, version, and content length, at most 5,000 entries), never written to disk, and dropped when the task is deleted. The core does not log query text: the search route has no logging, and a test intercepts every `console.*` call to confirm that a query canary never appears.

<a id="24-刪除"></a>
### 2.4 Deletion

- The page first shows a native confirmation (`window.confirm`: a system dialog in the macOS App, the browser's confirmation box in a browser). Only after the user confirms does it send `POST /api/history/:id/delete`, whose body must contain `request_id` and `confirm: true`; otherwise the core returns 400 and deletes nothing.
- A running task (queued, running, or cancelling) returns 409 “A running task cannot be deleted; stop the task first”; such tasks have no delete or redo button in the view.
- Deletion removes both the task and its result, rewriting `artifacts.json` first and then `tasks.json` (an interruption can leave only a task without its result, never a result without its task; loading also drops results whose task is missing), and broadcasts `{ type: "task.deleted", task_id, artifact_id }` over SSE; every page drops it from its lists, and a view showing that result is closed by the presentation policy.
- Deletion only rewrites the JSON files; it is not secure erasure, and old copies in Time Machine or other backups are unaffected.

<a id="25-重做"></a>
### 2.5 Redo

Redo reuses the existing retry: with `redo: true`, `POST /api/tasks/:id/retry` also accepts a succeeded task, creating a new task and recording `retry_of` as before. Without `redo` behaviour is unchanged (a succeeded task still returns 409). In the App, redo switches to the new task's foreground progress; the standalone page shows “Assigned again. Check progress in the main Nous view.”

<a id="26-app-內的-surface"></a>
### 2.6 The Surface in the App

- New `SurfaceKind` `"history"` and event `show.history`; `visibility_reason` is always `user_request` and `request_id` is the typed text, speech, button press, or menu click that opened it (a real request registered by `userRequest()`).
- Presentation policy (`src/presentation-policy.ts`): a history Surface whose reason is not `user_request` is rejected, and so is one whose `request_id` is not among this session's user requests. Tests cover a missing request_id, an unknown request_id, and the five other visibility reasons.
- The view has a search box, filters (status, engine, start and end date), a result list (matches in titles and snippets marked with `<mark>`), “Load more”, and a detail view. The detail view reuses the artifact view's `artifactSections` (split out of `renderArtifact`; result Markdown is still sanitized by DOMPurify) and adds “Source” (original request, status, engine, assigned and finished times), steps, errors, redo, and delete.
- User sentences, snippets, steps, and model output are built from text nodes and DOM-created `<mark>` elements, never `innerHTML`; only result content goes through `renderMarkdown` (sanitized). Tests use XSS canaries (`<img onerror>`, `<script>`, `<b>`, `<i>`) to confirm none becomes an element.
- The detail view has “Back to search results” at both the top and the bottom. When the App receives SSE `task.updated`, it updates that item's status in the list and an open detail view (reloading when a result appears), so the redo / delete buttons stay current. With a query or any filter and no results, the view says “No matching tasks or results.” rather than that there are no tasks. The Surface's accessible label follows the interface language.
- “Dismiss” only calls dismiss (it only closes the view and cancels no task). While results history is open, look-to-talk cannot auto-start a conversation over it (`blocksAutoTalk`). Input fields in a view now receive their own keystrokes, so typing does not open the command bar (one more condition in the global key handler in `src/main.ts`, which also applies to the family recognition name field).

<a id="27-入口都是按需"></a>
### 2.7 Entry points (all on demand)

1. Say or type “找之前關於晚餐的成果”, “搜尋成果 香菜”, “查找以前的成果裡有沒有香菜”, “找之前做過的晚餐結果”, “成果紀錄”, “搜尋全部成果”, or in English “search past results for dinner”, “Search my results for budget”, “results history”. The phrase must start or end with these fixed forms (`matchHistory` in `src/intent.ts`). If the query reads like an assignment (it contains 然後, 接著, 幫我, 一份, 整理成, and similar), it does not count and the whole sentence goes to the AI, for example “找成果，然後寫一份報告” and “搜尋成果：幫我整理成一份新報告”. 結果 counts only together with 做過 / 交辦過, so “查詢之前的考試結果” and “搜尋之前的比賽結果” do not open results history (such short sentences still open the latest result under the existing rule; see the command table's ambiguities). English needs my / past / previous or similar; “search results for flights to Tokyo” is an ordinary question. Saying only “成果”, “看結果”, “給我看成果”, or “show results” still opens only the latest result (`result`), and “show results about the election” is still delegated as a task.
2. The progress view has a “Search all results” button near “N earlier tasks not listed” (shown only when there are tasks).
3. The macOS menu bar item “Results history…” (`command("history")`) opens the Surface in the App; “Open results history in browser” opens the core's `/history?lang=<current language>` in the system browser.
4. When the App runs in an ordinary browser, the bottom of the results history Surface has an “Open results history in a new tab” link; the macOS App does not show it (the main window does not open tabs).

No model tool can open results history: the realtime tool list has no such tool (tested), and `src/realtime-tools.ts` never dispatches `show.history` (tested). The command table (`shared/voice-commands.ts`, `/help/commands`, README) gained a row, and `REPLACES_CONFIRM_CARD` and the “ambiguities” section were updated to match.

<a id="28-獨立網頁-history"></a>
### 2.8 The standalone `/history` page

- Vite multi-page build: `history.html` → `src/history-page.ts`, sharing `HistoryView`, `src/api.ts`, `src/style.css`, and the same translation table with the App; `dist/history.html` references only same-origin external scripts under `/assets/` and has no inline script.
- The core serves `dist/history.html` at `GET /history` (or `/history/`) with stricter headers than the main page: the main page's CSP with the camera off (`default-src 'self'`, `connect-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'`, and so on, without `wasm-unsafe-eval`) plus `form-action 'none'`, and a `Permissions-Policy` that allows neither camera nor microphone. `/` and other unknown paths are still the main page, and the main page's HTML has no resident link to `/history`.
- The page has a language switch (English / 繁體中文) and accepts `?lang=en|zh-TW` and `?q=` parameters. Both change only this page's language and do not write the shared language preference (so the browser version of the App on the same local address does not switch); the page still starts in the saved language. The language switch has no voice-related hint (this page has no voice). It does not subscribe to SSE: after another page deletes or adds a task, a new search is needed to see it.

<a id="29-驗證與來源保護瀏覽器怎麼通過"></a>
### 2.9 Authentication and origin protection (how a browser gets through)

The local core currently has no token; every `/api` route is protected by `server/http-guard.ts`:

- Every request's `Host` must be `localhost` or `127.0.0.1` with the core's or the Vite dev server's port (blocks DNS rebinding).
- A non-GET/HEAD request that carries `Origin` must name a host on the same list, and its `Content-Type` must be `application/json` (a cross-site simple request cannot send that without a preflight, and the core returns no CORS headers).
- Responses carry no CORS headers, so scripts on other sites cannot read them.

`/api/history`, `/api/history/:id`, and the delete route go through the same check; tests compare them one by one with `/api/tasks` and the retry route for the same 403 / 415 results. An ordinary browser opening `http://127.0.0.1:<port>/history` sends a local Host and Origin, so it works under the existing model without a new token. The cost is the same as for the main page: other local programs on the same computer that can reach localhost can also read it (this is the existing trust boundary, not something HIST-1 adds).

<a id="210-可插拔來源"></a>
### 2.10 Pluggable sources

`searchHistory(sources, query)` in `server/history.ts` takes `HistorySource[]` (`id`, `protected`, `documents()`); by default the core has only `{ id: "tasks", protected: false }`, and `createApp`'s `historySources` can add more. MEM-4c protected results will merge in as a `protected: true` source in the same ranking and pagination; the response's `sources` lists which sources were queried. A test already uses a fake protected source to confirm merging and labelling.

<a id="3-變更檔案"></a>
## 3. Files changed

| File | Content |
| --- | --- |
| `prototype/ambient-shell/server/search-terms.ts` (new) | Shared matching: `bigrams`, `words`, `foldForSearch`, `queryTerms` |
| `prototype/ambient-shell/server/history.ts` (new) | Query parsing, Markdown to plain text, matching, ranking, snippets, pagination, pluggable sources |
| `prototype/ambient-shell/shared/history.ts` (new) | Types, constants, `historySearchPath`, `isDeletable` shared by core and page |
| `prototype/ambient-shell/src/history-view.ts` (new) | The view shared by the App Surface and the standalone page (search, filters, snippet highlighting, detail, redo, delete) |
| `prototype/ambient-shell/src/history-page.ts`, `history.html` (new) | The standalone `/history` page |
| `prototype/ambient-shell/server/app.ts` | Three `/api/history` routes, `task.deleted` broadcast, `redo` on retry, the `/history` static page, `historySources` |
| `prototype/ambient-shell/server/store.ts` | `documents()`, `delete()`, `subscribeDeleted()` |
| `prototype/ambient-shell/server/runner.ts` | `retry(..., { redo })` |
| `prototype/ambient-shell/server/memory/retrieve.ts`, `server/memory/parse.ts` | Use the shared matching; `toTraditional` replaces in one pass, `toTraditionalChar`; table contents unchanged |
| `prototype/ambient-shell/server/page-headers.ts` | `historyPageHeaders` for `/history` |
| `prototype/ambient-shell/src/i18n.ts` | `useLocale` (changes this page only, not saved) |
| `prototype/ambient-shell/shared/types.ts` | `task.deleted` added to `ServerEvent` |
| `prototype/ambient-shell/src/main.ts` | Results history intent, button, menu command, Surface, and `task.deleted`; view input fields do not open the command bar |
| `prototype/ambient-shell/src/intent.ts` | The `history` intent and `matchHistory` |
| `prototype/ambient-shell/src/shell-state.ts`, `src/presentation-policy.ts`, `src/desktop-command.ts` | The `history` Surface, policy, and menu command |
| `prototype/ambient-shell/src/views.ts`, `src/api.ts`, `src/style.css` | Progress card button, `artifactSections`, shared helpers, API client, styles |
| `prototype/ambient-shell/desktop/main.mjs` | Menu bar items “Results history…” and “Open results history in browser” |
| `prototype/ambient-shell/shared/voice-commands.ts`, `README.md`, `README.en.md` | Command table row and explanatory paragraphs |
| `prototype/ambient-shell/src/messages.en.json`, `server/messages.en.json`, `desktop/messages.en.json` | English for the new copy |
| `prototype/ambient-shell/vite.config.ts` | Multi-page build (`index.html`, `history.html`) |
| `prototype/ambient-shell/tests/history-*.test.ts` (4 new) and fixtures in 3 existing tests | Tests |
| `scripts/verify-aios.mjs` | The isolated mock flow also checks `/api/history` and `/history` |
| `docs/…` | This document, the current implementation status, design document 16, indexes |

<a id="4-測試結果linuxnodejs-22220"></a>
## 4. Test results (Linux, Node.js 22.22.0)

In `prototype/ambient-shell`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npx vitest run` | 86 test files; 1469 passed, 4 skipped (existing skips). HIST-1 adds 4 files and 66 tests (56 before the review) |
| `npx vite build` | Passed; produces `dist/index.html` and `dist/history.html` |
| `node --check desktop/*.mjs` | Passed |

At the repository root, the output of `node scripts/verify-aios.mjs`, `node scripts/check-bilingual-docs.mjs`, `node scripts/check-pstack.mjs`, and `git diff --check` is recorded in the delivery report.

Coverage of the new HIST-1 tests:

| File | Covers |
| --- | --- |
| `tests/history-search.test.ts` | Shared matching (memory retrieval unchanged), length-preserving folding, query terms; Traditional/Simplified both ways, two-character fragments, English case, numbers; steps and notes; the half-match threshold; ranking (fraction, weight, time); ±120-character snippets and offsets; highlight positions on Simplified originals and merged adjacent fragments; Markdown removal, identifier underscores kept, a 200 ms bound on pathological Markdown; surrogate pairs; Traditional sentences saved by voice memory are not rewritten; empty query newest first, 20-item pages and cursor; status, engine, and date filters; malformed parameters (including nonexistent dates and Chinese errors); merging several sources; 500-task performance |
| `tests/history-http.test.ts` | Search, detail, 404, Chinese and English error messages; no index written and no query logged (canary); the same Host / Origin / content-type protection as `/api/tasks` and the retry route; no model tool; deletion requires `request_id` and `confirm: true`; refusing a running task (Chinese and English errors); after deletion neither memory nor disk has it, SSE `task.deleted`, still absent after reload; the result file is written before the task file and orphan results are dropped on load; redo; 500-task performance through HTTP |
| `tests/history-surface.test.ts` | Presentation policy (missing or unknown request_id and every other visibility_reason rejected), `show.history` and dismiss; intent positives and negatives (including “成果” still opening the latest, plus the assignment sentences and 結果 sentences from the review); menu command and menu bar item; progress card button (Chinese and English); every `main.ts` entry point is a user request and no model tool opens it; `<mark>` highlighting and bad offsets; XSS canaries never become elements and only sanitized result content uses `innerHTML`; cancelling the native confirmation deletes nothing; running tasks have no delete or redo; no Chinese left in the English interface; empty-result text with filters; `task.updated` updating the list and detail view; the accessible label following the language and the top back button; a failed search is reported honestly |
| `tests/history-page.test.ts` | Builds with the Vite API into a temporary folder: `history.html` exists with only same-origin external scripts; the core serves it at `/history` with the main page's CSP plus `form-action 'none'` and no camera or microphone, while `/` and unknown paths are still the main page; the main page does not link to `/history` |

<a id="41-搜尋延遲"></a>
### 4.1 Search latency

Synthetic data: 500 tasks, each result about 3,000 characters (mixed Chinese and English, repeated sentences), plus 3 step titles; 5 queries, 3 rounds each, taking the median and the worst. Why these bounds: interactive search uses 300 ms as the median threshold from pressing search to seeing results, relaxed to a 1,000 ms worst case for slower CI machines; both numbers are written in the tests.

| Measurement | Median | Worst | Bound |
| --- | --- | --- | --- |
| Calling `searchHistory` directly (`tests/history-search.test.ts`) | 8.9 ms | 65.3 ms | median < 300 ms, worst < 1,000 ms |
| Through HTTP `GET /api/history` (`tests/history-http.test.ts`, including the `TaskStore` snapshot) | 26.4 ms | 46.1 ms | Same |

The numbers come from one output of the whole suite running in parallel after the review fixes and vary with machine load. The tests run a warm-up query first, so the table shows the case where result plain text is already in memory; the first query after the core starts must convert every result, separately measured at about 121 ms (the same 500 tasks, including JIT warm-up), with later identical queries at about 7–16 ms. Before the review, without the in-memory reuse, the medians were 62 ms (direct) and 88 ms (HTTP); with the first character-by-character folding (results were then about 2,000 characters each) the median was 172 ms. There is no index: matching still scans all text each time, so larger data (thousands of tasks or more) needs to be measured again. Pathological Markdown (50,000 “[” and similar) took 1.76 s before the review; after the fix the test bound is 200 ms.

<a id="5-mac-驗證步驟未執行"></a>
## 5. Mac verification steps (not run)

1. Build and open the macOS App (see `prototype/ambient-shell/desktop/README.en.md`) and assign 3–5 tasks with the mock engine (including one whose title contains Simplified characters, such as “准备晚饭”, and one that fails or is stopped).
2. Menu bar: confirm the items “成果紀錄…” and “在瀏覽器打開成果紀錄” exist (“Results history…” and “Open results history in browser” in the English interface). Click “Results history…” and take a screenshot of the Surface; click “Open results history in browser”, confirm the system browser opens `http://127.0.0.1:<port>/history?lang=…` and can search, and take a screenshot.
3. Type “搜尋成果 晚飯” (Traditional query for a Simplified title), “找之前關於晚餐的成果”, and “成果紀錄”, and confirm matches are highlighted; “看結果” still opens only the latest result.
4. Progress view: say “進度如何” and confirm the “Search all results” button is near “N earlier tasks not listed” and opens results history.
5. Detail view: confirm original request, engine, times, assumptions, capability gaps, and steps; press “Redo” and confirm the view switches to the new task's progress.
6. Deletion: press “Delete” and confirm a native macOS dialog appears; Cancel deletes nothing; then confirm, the task leaves the list, and neither JSON file in the App data folder (menu bar “Settings and data → Open tasks and artifacts folder”, i.e. `data/` under Electron `userData`) contains the task any more (check the title with `grep`). Confirm a running task has no delete button.
7. Dismiss: inside results history say or type “收起” or press Esc, and confirm only the view closes while running tasks continue.
8. Latency: on the Mac run `cd prototype/ambient-shell && npx vitest run tests/history-search.test.ts tests/history-http.test.ts --reporter=verbose` and record the two `[history perf]` lines; to measure the real App, put a 500-task test data folder (not real data) in the App's data location, restart, and time from pressing search to seeing results.
9. Save screenshots in a new folder under `docs/validation/` and add the results to this document (both languages); screenshots must not contain real personal data.

<a id="6-未完成與限制"></a>
## 6. Not done and limitations

- Encryption, protected results and revocation (MEM-4a), search over protected results (MEM-4c), and memory in background tasks are not implemented; `tasks.json` and `artifacts.json` are still plaintext.
- Simplified-to-Traditional folding uses only a fixed table (not a full conversion); Simplified characters missing from the table do not match their Traditional forms (and vice versa). Of the one-to-many characters, only 划/劃 and 发/發/髮 are handled.
- Matching is substring matching on folded text plus two-character fragments, with no synonyms, stemming, or typo tolerance.
- The standalone page does not subscribe to SSE; deletions or additions elsewhere appear only after a new search. Deletion is not secure erasure, and old copies in backups and APFS snapshots are unaffected. If the original task in a redo or retry chain is deleted, `retry_of` still keeps its ID.
- Browser operation was run only during the review, in cloud headless Chromium (section 8); this batch's automated tests are still fake-DOM and HTTP tests, and `scripts/verify-aios.mjs` does not drive a browser (to avoid adding flakiness). The native macOS dialog and menu have not been tested.
- In the full suite, one test in `tests/identity-service.test.ts` fails intermittently (it replaces the first ciphertext character with `A`, which leaves the file intact when that character is already `A`); it is unrelated to HIST-1 and was not changed in this batch.

<a id="7-下一個-gate"></a>
## 7. Next gate

George completes section 5 on the Mac and confirms HIST-1 can be merged; only then does MEM-4a start (task and result encryption, one-time migration, revocation propagation, automatic memory in background tasks), followed by MEM-4c, which brings protected results into the same search.

<a id="8-獨立審查與修正2026-10-30"></a>
## 8. Independent review and fixes (2026-10-30)

The same day's independent review found no blockers, 2 majors, 8 minors, and some nits, all fixed on this branch (not committed):

| Item | Problem | Fix |
| --- | --- | --- |
| M1 | The intent treated ordinary sentences as results history (“找成果，然後寫一份報告”, “查詢之前的考試結果”, “search results for flights to Tokyo”, and others), while “查找以前的成果裡有沒有香菜” was missed | See 2.7: assignment sentences do not count, 結果 needs 做過 / 交辦過, English needs my / past; “…成果裡有沒有…” added; positives and negatives are in the tests |
| M2 | Characters added to the memory table for search (划→劃, 发→發) rewrote sentences saved by voice memory (划船→劃船, 头发→头發) | Memory table restored; the search supplement moved to `search-terms.ts`, with one-to-many characters folded in reverse; memory regression test added |
| m1 | `markdownToPlain` was quadratic on pathological content (50,000 “[” took 1.76 s) | Every pattern is length-bounded and result plain text is reused from memory; pathological performance test added |
| m2 | Markdown removal stripped every underscore (`ANTHROPIC_API_KEY` → `ANTHROPICAPIKEY`) | Only paired emphasis markers are removed |
| m3 | Nonexistent dates (`2026-13-45`, `2026-02-31`) were accepted | Year, month, and day are checked; 400 |
| m4 | With filters, an empty result said there were no tasks yet | With a query or filter it says no match |
| m5 | Search and detail errors were in English | Chinese source strings added to the catalog; date fields keep start no later than end |
| m6 | Deletion rewrote the two files non-atomically | Result file first, then task file; orphan results dropped on load |
| m7 | This document said there was no browser and no screenshots | Now describes the review's Playwright verification and screenshot list (this section); Mac verification is still not run |
| m8 | The App detail view did not follow `task.updated` | `historyView.taskUpdated(task)` |
| nit | `/history` headers, accessible-label translation, `?lang=` changing the App's language, the language hint, a back button at the top of the detail view | See 2.6 and 2.8 |

The review's cloud browser verification (Playwright, headless Chromium, an isolated mock core with fictional data; not the macOS App and not this batch's automated tests) drove the `/history` list, search, the list and detail of an XSS test task (no `img` / `script` element was injected), the English interface, the status filter, phone width (390×844), and the results history Surface of the App in an ordinary browser (opening by typing, typing in the search box without opening the command bar, detail, dismiss, deletion after confirmation, redo, the progress card button). Screenshot file names are below; the files stay in the review's scratch folder and are not in the repository:

- `/history`: `history-list-zh.png`, `history-list-en.png`, `history-search-zh.png`, `history-search-en.png`, `history-xss-list-zh.png`, `history-xss-list-en.png`, `history-detail-xss-zh.png`, `history-detail-xss-en.png`, `history-mobile-zh.png`, `history-mobile-en.png`
- App Surface: `app-history-surface-zh.png`, `app-history-surface-en.png`, `app-history-detail-zh.png`, `app-history-detail-en.png`, `app-history-after-delete-en.png`, `app-after-redo-en.png`

These screenshots show the version before the review fixes; no new screenshots were taken after the fixes.
