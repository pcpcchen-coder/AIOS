<!-- bilingual: source=zh-TW -->

> [繁體中文](web-search-picker-2026-11-09.md) | [English](web-search-picker-2026-11-09.en.md)

<a id="即時語音查詢結果編號挑選重點跟讀與自動收起2026-11-09"></a>
# Realtime voice search results: numbered pick, key-point read-along and auto-close (2026-11-09)

Design approved by George on 2026-11-09: web search → the screen lists 3 numbered candidates → the assistant reads the titles and asks which one → the user says "the second one" (「第二個」) → the assistant calls the new tool `show_search_result` → the screen shows that result's key points while the assistant reads them in order, and the point being read lights up → after speech really ends, the panel closes after the number of seconds the user set. Both realtime voice routes (API key and ChatGPT plan) share the same executor and page callbacks. Branch `claude/web-search-picker` (based on main `416a1ab`).

**Evidence level:** unit tests, fixtures and headless Chromium screenshots (the search response and voice events are all **SIMULATED**). **Real voice on both routes and the real Codex/OpenAI search output format were not verified.**

<a id="1-做了什麼"></a>
## 1. What was built

| Part | Content |
|---|---|
| Data shape | `shared/web-search.ts`: `SearchCandidate {n, title, url, host, points, summarized}`; `WebSearchResult` gains `candidates`; pure functions `parseCandidates` (separates the answer from the candidates), `matchSpokenPoint` (read-along) and `searchToolOutput`/`pickToolOutput` (what goes back to the model) |
| Core search | The instructions in `server/web-search.ts` ask the search model to append a ```json block after the 120-character answer: up to 3 distinct sources, 2–5 key points each (40 characters or fewer, numbers verbatim). The parser accepts a ```json block or trailing JSON; the answer never contains the JSON (it is removed even when broken). When no candidates can be parsed, the citations' titles and URLs are used with empty `points` and `summarized:false` — **no points are invented**. Deduplicated by URL (ignoring `#` and a trailing slash), at most 3 candidates and 5 points each. The API key route and the ChatGPT plan (Codex) route use the same parser |
| New tool | `show_search_result {index: 1..3}`: offered only when web search is available, right after `web_search`; registered in `REALTIME_TOOLS`, `HostToolName`, `HOST_TOOLS`, `HOST_TIMEOUT_MS` (5 s plus the reply margin; the slowest-tool ceiling is unchanged), `RealtimeToolName` and the command table `ASK_THE_AI`. New branch in the shared executor `executeRealtimeTool`: out of range or not an integer returns "沒有這一則" (no such result); an ended call (generation changed), no search yet in this call, or a page without the callback returns "還沒有查詢結果" (no search results yet) |
| Rules | `SEARCH_PICK_RULE` (shared by both routes): with two or more results, read the numbered titles first, ask which one, and do not read content yet; when the user picks, call `show_search_result` and read the points in order, one sentence each, starting with the point's own leading words, numbers verbatim. With exactly one result, `web_search` returns its points directly. The ChatGPT plan tool caller gets an exception: its final message may list the numbered titles or read the points (at most six short sentences); the voice layer gets a "read in order, do not rephrase" rule |
| Back to the model | `web_search`: `{ok, answer, candidates:[{n,title,host}], next}` (no points before the pick); with one result it adds `points`. `show_search_result`: `{ok, n, title, host, points}`, with a `note` when there is no summary |
| Page state | `SearchPanel` in `src/search-panel.ts` (a discriminated union of `candidates`/`reading`/`failed`) and `SearchPanelController` (pick, read-along, close timer). New Surface `search` (`show.search`, `user_request`, with a request id registered when results arrive). An open confirmation card is never replaced; results are kept and shown when the user later picks one. Dismissing or switching surfaces only stops the countdown, and results stay pickable; ending the call clears everything and closes the panel |
| Close timer | Only in `reading`/`failed`: after playback (phase `speaking`) ends, count down N seconds; playback starting again or the user speaking (`hearing`) cancels it and it restarts afterwards; dismissing or switching surfaces cancels it; when it fires, only the same panel (same `surface_id`) is closed. If no playback happens within 15 s of entering reading, the countdown starts anyway. The candidate list never auto-closes |
| Setting | `search_close_s` "Seconds before closing search results": default 8, 3–60 s, step 1, presets 3/5/8/15/30/60; through `VOICE_PREFS` it automatically gets persistence, HTTP, the settings −/+ stepper, the macOS menu bar and SSE |
| Screen | `.surface--search` uses the docs/10 §2 tokens (`--fs-title` 108, `--fs-body` 76, `--fs-meta` 56, `--badge` 88; `--fs-anchor` and `--fs-hero` are also defined), shrinking with vw/vh in smaller windows; width `min(1700px, 100vw − 192px)`, leaving the bottom subtitle band. Candidate cards have an 88 px number badge and `data-selectable` (pointing only, no action); the point being read is fully lit, scaled 1.04 and glowing while the others drop to 35%; failure shows a coral border with "沒有查到" (Nothing found) and the real error; an unsummarized result honestly shows "這則沒有摘要，只有來源" (No summary for this result, only the source) |
| Languages | New interface strings (including aria-labels), the setting label and hint, and the command table row all have English; a test checks the English has no Han characters |

<a id="2-跟讀的精確度限制"></a>
## 2. Read-along precision limits

- **Text runs ahead of audio.** On the API key route, `response.output_audio_transcript.delta` usually arrives before the audio plays, so the lit point can be slightly ahead of what is heard.
- **The ChatGPT plan route's "speaking" is about 0.6 s late.** That route detects `speaking` from remote audio level (RMS), with delay at both start and end; the close countdown starts from that point too.
- **The lit point only changes during playback**; outside playback the last lit point is kept.
- **No match, no highlight.** The keys are each point's leading characters (Chinese up to 6, stopping at a digit; English 12 letters) and sufficiently long numbers in the point (three or more digits, or a percentage); keys shared by two points are ignored. If the model rewrites the opening and also reads the numbers as Chinese words, nothing matches — then nothing lights up; there is no guessing.
- Simplified-Chinese transcripts are not converted (numbers can still match).

<a id="3-測試"></a>
## 3. Tests

| Command (`prototype/ambient-shell`) | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | 173 files; 3232 passed, 5 skipped |
| `npx vite build` | Passed |
| `node --check desktop/main.mjs` | Passed |
| Repo root `node scripts/verify-aios.mjs` | PASS |

New and changed tests: `tests/web-search.test.ts` (parsing: success, ```json block, trailing JSON, broken JSON falling back to citations, more than 3, URL dedupe; outputs to the model; read-along matcher with zh and en fixtures) and `tests/web-search-picker.test.ts` (consistent tool lists on both routes, timeout, rules; the executor's four cases; the ChatGPT plan route reaching the same executor through `LiveToolCaller`; close-timer phase sequences and the 15 s fallback; read-along changing only during playback, cumulative partials; `show.search` and the presentation policy; setting default and range; view and English). Existing tests were updated for the new tool and setting (the API key request baseline transform, tool lists, setting rows, menu bar); the `wake-flag-off` snapshot is not updated — the new setting is removed before comparison (the ninth exception).

<a id="4-截圖全部-simulated"></a>
## 4. Screenshots (all SIMULATED)

`node scripts/verify-search-panel-browser.mjs` (run `npx vite build` first; when Playwright is not a project dependency, point `PLAYWRIGHT_MODULE` at an installed `index.mjs`) drives the real built page: `page.route` returns SIMULATED search results and the page's realtime callbacks are called directly, at 1920 × 1080 with deviceScaleFactor 2. A "SIMULATED" label sits in the top-right corner and the query also contains SIMULATED.

| File | Content |
|---|---|
| [`search-candidates.zh-TW.png`](../screenshots/web-search-picker/search-candidates.zh-TW.png) | Three numbered candidates |
| [`search-reading-point2.zh-TW.png`](../screenshots/web-search-picker/search-reading-point2.zh-TW.png) | Result 1's key points, point 2 lit |
| [`search-reading-unsummarized.zh-TW.png`](../screenshots/web-search-picker/search-reading-unsummarized.zh-TW.png) | The result without a summary |
| [`search-failed.zh-TW.png`](../screenshots/web-search-picker/search-failed.zh-TW.png) | Search failed (SIMULATED timeout) |
| [`settings-search-close.zh-TW.png`](../screenshots/web-search-picker/settings-search-close.zh-TW.png) | The "查詢結果收起秒數" setting (the mock core has no realtime voice, so the hint adds "realtime voice currently unavailable") |
| [`search-reading-point2.en.png`](../screenshots/web-search-picker/search-reading-point2.en.png) | English interface, point 2 lit |

The same script also confirms that the failed panel really closes 8 s (the default) after `speaking → listening` (real timer).

<a id="5-沒有驗證的事"></a>
## 5. Not verified

- Real voice on both routes: whether the model follows the rule — reading the titles first, asking which one, calling `show_search_result` only after the pick, and reading the points in order without rephrasing.
- Whether real Codex (ChatGPT plan) and OpenAI Responses search output actually appends the JSON block; when it does not, the fallback is the citations (titles and URLs only).
- On the ChatGPT plan route, the real success rate of the voice layer delegating "the second one" and the tool caller resolving the number from the transcript.
- Real readability on the 18-inch screen at 2 m and the layout in the smaller Mac window (screenshots are 1920 × 1080 only).
- The time gap between the lit point and what is heard (not measured).
