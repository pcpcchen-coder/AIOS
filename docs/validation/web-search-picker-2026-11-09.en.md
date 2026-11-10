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
| Core search | The instructions in `server/web-search.ts` ask the search model to append a ```json block after the 120-character answer: up to 3 distinct sources, 2–5 key points each (40 characters or fewer, numbers verbatim). The parser accepts a ```json block or a trailing unfenced JSON array or object (`[…]`, `{"candidates":[…]}`, `{"results":[…]}`); the answer never contains the JSON (a trailing `[{`/`{"` block is removed even when it does not parse). **When citations exist, any candidate whose URL matches no citation is dropped** (the model may invent URLs; matching ignores `#`, a trailing slash, `www.` and `utm_*` parameters), and an empty title takes the citation's title; when all are dropped or no candidates can be parsed, the citations' titles and URLs are used with empty `points` and `summarized:false` — **no points are invented**. When the search returns no citations at all, the model's candidates are kept but marked `cited:false`, and the screen notes "URL not matched to a cited source" (「網址沒有經來源核對」) next to the site. Deduplicated by URL, at most 3 candidates and 5 points each. The API key route and the ChatGPT plan (Codex) route use the same parser |
| New tool | `show_search_result {index: 1..3}`: offered only when web search is available, right after `web_search`; registered in `REALTIME_TOOLS`, `HostToolName`, `HOST_TOOLS`, `HOST_TIMEOUT_MS` (5 s plus the reply margin; the slowest-tool ceiling is unchanged), `RealtimeToolName` and the command table `ASK_THE_AI`. New branch in the shared executor `executeRealtimeTool`: out of range or not an integer returns "沒有這一則" (no such result); an ended call (generation changed), no search yet in this call, or a page without the callback returns "還沒有查詢結果" (no search results yet) |
| Rules | `SEARCH_PICK_RULE` (shared by both routes): with two or more results, read the numbered titles first, ask which one, and do not read content yet; when the user picks, call `show_search_result` and read the points in order, one sentence each, starting with the point's own leading words, numbers verbatim. With exactly one result, `web_search` returns its points directly. The ChatGPT plan tool caller gets an exception: its final message may list the numbered titles or read the points (at most six short sentences); the voice layer gets a "read in order, do not rephrase" rule |
| Back to the model | `web_search`: `{ok, answer, candidates:[{n,title,host}], next}` (no points before the pick); with one result it adds `points`. `show_search_result`: `{ok, n, title, host, points}`, with a `note` when there is no summary. The output says "the screen shows / has listed" only when the screen really shows the results; when it does not (a confirmation card is open, no user utterance is available, or the call has ended) it says instead "畫面沒有顯示查詢結果，用說的告訴使用者" (the screen is not showing the results; tell the user by voice). When `answer` is empty, it does not ask for a one-sentence conclusion first |
| Page state | `SearchPanel` in `src/search-panel.ts` (a discriminated union of `candidates`/`reading`/`failed`) and `SearchPanelController` (pick, read-along, close timer). New Surface `search` (`show.search`, `user_request`). **The request id is tied to a user utterance:** every final user transcript (`onUserTranscript`, on both routes) registers a request id; opening the search panel (`web_search` results or `show_search_result`) consumes the latest unconsumed one, and reusing the already open panel consumes it too; when none is available the panel is not opened and the model is told the screen is not showing the results. When a search succeeds with no candidates at all, a previous search panel still open is closed (no blank card) and the model answers by voice. Every content change bumps a revision that is part of the render key (re-picking the same result re-renders). An open confirmation card is never replaced; results are kept and shown when the user later picks one. Dismissing or switching surfaces only stops the countdown, and results stay pickable; ending the call clears everything and closes the panel |
| Close timer | Only in `reading`/`failed`: **only playback that starts after entering counts** (speech already playing before the pick, such as "OK, let me look", does not); when that playback ends and the phase returns to idle (`listening`), count down N seconds. Playback starting again, the user speaking (`hearing`) or processing (`thinking`, e.g. a ChatGPT plan delegation still pending) cancels it and it restarts afterwards; dismissing or switching surfaces cancels it; when it fires, only the same panel (same `surface_id`) is closed. The 15 s no-playback fallback also runs only while idle (`listening`), not while processing. The candidate list never auto-closes |
| Setting | `search_close_s` "Seconds before closing search results": default 8, 3–60 s, step 1, presets 3/5/8/15/30/60; through `VOICE_PREFS` it automatically gets persistence, HTTP, the settings −/+ stepper, the macOS menu bar and SSE |
| Screen | `.surface--search` uses the docs/10 §2 tokens (`--fs-title` 108, `--fs-body` 76, `--fs-meta` 56, `--badge` 88; `--fs-anchor` and `--fs-hero` are also defined), shrinking with vw/vh in smaller windows; width `min(1700px, 100vw − 192px)`, leaving the bottom subtitle band. Candidate cards have an 88 px number badge and `data-selectable` (pointing only, no action); the point being read is fully lit, scaled 1.04 and glowing while the others drop to 35%; failure shows a coral border with "查詢失敗" (Search failed) and a fixed sentence per error category (timeout, unavailable, unauthorized, unreachable, other; in both languages, never the core's raw Chinese text); below 800 px width the 192 px safe area is dropped for a 16 px margin on each side; the lit point is scrolled into view (`scrollIntoView({block:"nearest"})`); an unsummarized result honestly shows "這則沒有摘要，只有來源" (No summary for this result, only the source) |
| Languages | New interface strings (including aria-labels), the setting label and hint, and the command table row all have English; a test checks the English has no Han characters |

<a id="2-跟讀的精確度限制"></a>
## 2. Read-along precision limits

- **Read-along pacing is an estimate gated by real playback events.** Transcript text arrives before the audio (the API key route's `response.output_audio_transcript.delta`, and a whole final transcript may arrive right as playback starts), so matching only considers the first "playback time × estimated rate" characters: Chinese 5.5 characters/s, English 15 characters/s (by interface language; punctuation included; **an estimate, not a measurement**). Playback time accumulates only while the phase is `speaking`, and only for playback that started after entering the reading view; during playback the match is re-evaluated every 250 ms so the lit point advances with playback time. When the real speech rate differs from the estimate, the highlight is somewhat early or late.
- **The ChatGPT plan route's "speaking" is about 0.6 s late.** That route detects `speaking` from remote audio level (RMS; 150 ms to start, 600 ms to end), with delay at both start and end; playback time and the close countdown start from that point too.
- **Forward only.** Within one reading the lit point never moves backwards, and the next point's key must appear after the current point's. Before any point is lit, only each point's leading words count (the conclusion sentence often repeats the points' numbers, so numbers alone do not start the highlight).
- **Cumulative partials from two sources.** On the ChatGPT plan route a partial may come from both the channel and the core: one that is a prefix of (or equal to) the accumulated text is ignored, one that extends it replaces it, anything else is appended. On the API key route, an incremental partial that happens to be a prefix of the accumulated text is also ignored (a few characters fewer, never counted twice).
- **The lit point only changes during playback**; outside playback the last lit point is kept.
- **No match, no highlight.** The keys are each point's leading characters (Chinese up to 6, stopping at a digit; English 12 letters) and sufficiently long numbers in the point (three or more digits, or a percentage); keys shared by two points are ignored. If the model rewrites the opening and also reads the numbers as Chinese words, nothing matches — then nothing lights up; there is no guessing.
- Simplified-Chinese transcripts are not converted (numbers can still match).

<a id="3-測試"></a>
## 3. Tests

| Command (`prototype/ambient-shell`) | Result |
|---|---|
| `npx tsc --noEmit` | Passed |
| `npx vitest run` | 173 files; 3254 passed, 5 skipped (after the fix round) |
| `npx vite build` | Passed |
| `node --check desktop/main.mjs` | Passed |
| Repo root `node scripts/verify-aios.mjs` | PASS |

New and changed tests: `tests/web-search.test.ts` (parsing: success, ```json block, trailing JSON, broken JSON falling back to citations, a trailing unfenced array or `{results}`, a broken trailing block still stripped, an invented URL dropped, falling back to citations when all are dropped, more than 3, URL dedupe; outputs to the model (including not shown and an empty answer); the forward-only and leading-words-only matcher options; read-along matcher with zh and en fixtures) and `tests/web-search-picker.test.ts` (consistent tool lists on both routes, timeout, rules; the executor's four cases; the ChatGPT plan route reaching the same executor through `LiveToolCaller`; close-timer phase sequences and the 15 s fallback (speech from before the pick does not count, `thinking` arms nothing); read-along advancing with estimated playback time (fake timers: a whole final transcript does not jump to the end, pauses do not accumulate, forward only, a conclusion's numbers do not start the highlight, zh and en rates) and cumulative partials from two sources; the revision; `show.search` and the presentation policy, request ids tied to user utterances (`UtteranceRequests`/`planSearchSurface`), auto-close only for the same surface, closing the old panel when there are no candidates, error classification; setting default and range; view and English). Existing tests were updated for the new tool and setting (the API key request baseline transform, tool lists, setting rows, menu bar); the `wake-flag-off` snapshot is not updated — the new setting is removed before comparison (the ninth exception).

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

The same script also confirms that a search without a user utterance (transcript) does not open the panel and the output to the model says the screen is not showing it; every later step first sends a SIMULATED user utterance through the real `onUserTranscript`. When the whole transcript arrives at playback start, point 1 lights first and point 2 only after more playback time (estimated rate). The failed panel really closes 8 s (the default) after `speaking → listening` (real timer).

<a id="5-沒有驗證的事"></a>
## 5. Not verified

- Real voice on both routes: whether the model follows the rule — reading the titles first, asking which one, calling `show_search_result` only after the pick, and reading the points in order without rephrasing.
- Whether real Codex (ChatGPT plan) and OpenAI Responses search output actually appends the JSON block; when it does not, the fallback is the citations (titles and URLs only).
- On the ChatGPT plan route, the real success rate of the voice layer delegating "the second one" and the tool caller resolving the number from the transcript.
- Real readability on the 18-inch screen at 2 m and the layout in the smaller Mac window (screenshots are 1920 × 1080 only).
- The time gap between the lit point and what is heard (not measured; the 5.5/15 estimated rates are not calibrated against real speech either).
- On the API key route the user transcript is asynchronous: if `show_search_result` is called before that utterance's transcript arrives and the search panel has already been closed, the panel does not open (the model is told the screen is not showing it). How often this happens in practice is not measured.
