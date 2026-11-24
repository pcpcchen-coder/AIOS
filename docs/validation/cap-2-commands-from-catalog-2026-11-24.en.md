<!-- bilingual: source=zh-TW -->

> [繁體中文](cap-2-commands-from-catalog-2026-11-24.md) | [English](cap-2-commands-from-catalog-2026-11-24.en.md)

<a id="cap-2-語音指令表改由能力總表產生驗證"></a>
# CAP-2 voice command table generated from the capability catalog: validation

Date: 2026-11-24 (Asia/Taipei). Branch: `claude/cap-2-commands-from-catalog`, based on main at `c365f7d` (CAP-1, PR #152 merged). The scope is CAP-2 from [24 §3.3](../24_Capability_Catalog_and_Skills_2026-11.en.md#33-batches).

**This whole batch is fixtures and type checks in a cloud container. It is not a product gate and not a Mac acceptance test.** There is no real voice and no real service. Voice behaviour, the tool JSON sent to the model and the settings screen are unchanged; in `/help/commands` and the prototype README only the "Timers and alarms" section is rewritten and an "App integrations" section is added.

<a id="1-環境"></a>
## 1. Environment

| Item | Value |
|---|---|
| Machine | Linux cloud container (not a Mac, not a Pi) |
| Node | v22.23.5 |
| Install | `npm ci` in `prototype/ambient-shell` (no package added or upgraded) |
| External services | None; Adapter dependencies are test doubles |

<a id="2-交付內容"></a>
## 2. What was delivered

Paths are under `prototype/ambient-shell/`.

| Item | Content |
|---|---|
| Data flow | `shared/voice-commands.ts` adds `CatalogToolRow` (only the fields it needs; `CatalogEntry` from `server/integrations/catalog.ts` matches it structurally), and `commandSections(ctx, catalog)` and `renderCommandsMarkdown(catalog)` gain a parameter. `shared/` still does not import `server/` (the layering in [23](../23_Architecture_Review_2026-11.en.md)): the server passes the catalog in |
| Page | On every `/help/commands` request `server/app.ts` builds the live catalog with `liveCatalog(registry)` and passes it to `renderCommandsPage(view, catalog, now, locale)`; without an integration layer (tests only) it uses an empty registry and every row is marked "Currently: not configured" |
| README | `scripts/write-commands-doc.ts` passes `staticCatalog()`; `npm run docs:commands` regenerated the command section (committed) |
| "Timers and alarms" | The hand-written `TIMER_ASK` (5 rows) is removed; the section is generated from the catalog's `timer` and `alarm` (`builtin`) tools, one row per tool, 13 rows |
| "App integrations" (new section) | Every other non-hidden integration tool, one row per tool, 14 rows: voice relay 1, Google Calendar 2, weather 1, living-room TV 9, Gmail (to yourself) 1. The 5 hidden tools (`app.mock.*` 2, `app.home.*` Facades 3) are not listed |
| Columns | Both sections use "Service / Ask / Possible AI action / Conditions": service name, examples, `summary`, and "requires realtime and" + `needs` |
| Unavailable marks | In order: realtime unavailable → "Currently: realtime voice is unavailable"; tool not registered (missing configuration) → "Currently: not configured"; the `CapabilityStatus` on the route the next call will use (`RealtimeRouteFields.route`): `disabled` → "Currently: turned off", `unsupported` → "Currently: not supported on this voice route", `authorization_required` → "Currently: authorization required". It reuses the page's existing `unmet` style (greyed row, label in the first cell); the README is not marked |
| Catalog data | `CatalogEntry` gains `builtin` (from `AdapterCatalog.builtin`). The timer and alarm `summary`/examples gain information that used to exist only in `TIMER_ASK` (see section 4) |
| English | `server/messages.en.json` goes from 788 to 792 keys: 11 added, 7 removed (text used only by the old `TIMER_ASK`), 3 rewritten (timer and alarm summaries). The conditions cell is built from `需要即時語音，{0}` plus the translation of `needs` itself |
| Tests | New `tests/commands-from-catalog.test.ts` with 14 tests; `tests/fixtures/commands-page.baseline.json` regenerated; `tests/fixtures/commands-page.pre-cap-2.json` is the output before CAP-2 (the `c365f7d` baseline copied unchanged), used to prove the other sections are byte-identical |

<a id="3-指令與結果"></a>
## 3. Commands and results

In `prototype/ambient-shell`:

| Command | Result |
|---|---|
| `npm run catalog -- --check` | `能力總表檢查通過：41 個工具（36 個列在給人看的表、5 個 hidden）` (catalog check passed: 41 tools, 36 on the human table, 5 hidden) |
| `npm run docs:commands` | First "已更新 README.md 的指令表" (README updated), afterwards "README.md 的指令表已是最新" (already up to date) |
| `npx vitest run tests/commands-from-catalog.test.ts` | 1 file, 14 tests passed |
| `npx vitest run` | 182 files, 3,414 tests passed, 5 skipped |

Repo root:

| Command | Result |
|---|---|
| `node scripts/verify-aios.mjs` | PASS (type check, tests, build, isolated mock HTTP flow) |
| `node scripts/check-pstack.mjs` | See the PR description (output of the last run before delivery) |
| `node scripts/check-bilingual-docs.mjs` | `--record` after reviewing both versions, then a passing re-run; output in the PR description |

<a id="4-gate-的證據"></a>
## 4. Gate evidence

<a id="41-本機固定語句與-9-個頁面工具的列逐字不變"></a>
### 4.1 Local fixed phrases and the 9 page-tool rows are byte-identical

`tests/commands-from-catalog.test.ts` compares the three current outputs (Chinese page, English page, README) with `commands-page.pre-cap-2.json`: both sides drop the catalog-generated sections (the page's `<section id="timers">`/`<section id="apps">`; in the README, from "#### 定時器與鬧鐘" up to "#### 不用說話"), and the remaining strings are byte-identical. So the camera, conversation and screens, tasks, external action confirmation, barge-in, common misunderstandings, "ask the AI" (the 9 `ASK_THE_AI` rows and their order) and no-speech sections, as well as the page header, styles and the style hash the CSP uses, are unchanged. The test also checks the dropped part is not empty (the text differs before and after removal), so the comparison cannot pass vacuously. The "ask the AI" row snapshot in `tests/realtime-tool-names.test.ts` still passes.

<a id="42-送給模型的工具-json-逐字不變"></a>
### 4.2 The tool JSON sent to the model is byte-identical

CAP-1's `tests/fixtures/model-tools.baseline.json` (26 outputs) was not regenerated, and the comparison in `tests/capability-catalog.test.ts` still passes. Catalog fields never enter function specs (a CAP-1 test).

<a id="43-新的列hidden標註兩種語言"></a>
### 4.3 New rows, hidden tools, marks, both languages

| Test | What it confirms |
|---|---|
| every non-hidden integration tool has exactly one row | 27 rows = 32 integration tools − 5 hidden; the 5 hidden tools are not on the page |
| TV, calendar, mail, weather and the voice relay appear | TV, calendar, mail, weather and the voice relay are in "App integrations"; timers and alarms appear only in their own section |
| cells are service, examples, summary and needs | Each cell comes straight from the catalog |
| what the old hand-written TIMER_ASK said is still on the table | See 4.4 |
| unavailable rows are marked from the live state (6 tests) | The README is not marked; realtime unavailable wins; not registered = not configured; registered but off = turned off; enabled = no mark; `unsupported`/`authorization_required` depend on the next route (no mark when the other, available route is next); the page uses the existing `unmet` style in both languages |
| both languages (2 tests) | On the English page every row's service, summary, conditions and mark contain no Chinese characters (examples deliberately keep the exact Chinese input phrases, like the existing "ask the AI" section, as the page header explains); both section titles and intros are English; the Chinese page and the README use the same rows |

<a id="44-timer_ask-前後差異"></a>
### 4.4 `TIMER_ASK` before and after

The old 5 rows each covered several tools. Now there is one row per tool, with a "Service" column splitting them into 7 timer rows and 6 alarm rows, so you can see what each tool does; the "stop ringing" and "snooze" tools, which were not listed before, now appear too. Where the information in the old text went:

| Information in the old `TIMER_ASK` | Where it is now |
|---|---|
| 「5 分鐘後叫我」 (wake me in 5 minutes) | Example of `app.timer.start` (added) |
| Rings on the device where it was set, on every screen if that device is offline, countdown in the bottom-right corner | Summary of `app.timer.start` (added) |
| 「繼續」 (resume) | Example of `app.timer.resume` (added) |
| 「全部取消」 (cancel all) | The existing `app.timer.cancel` example 「定時器全部取消」 |
| With several and none named, the AI asks | Section intro (true for both timers and alarms: `server/alarms.ts` returns `ambiguous` for both) |
| Alarms can be named, use this Mac's time zone, ring at local time across daylight-saving changes, show a countdown within the hour | Summary of `app.alarm.set` (added) |
| Alarms can also be managed in settings | Summary of `app.alarm.list` (added) |
| Survive a restart; ring up to 30 minutes late after sleep | Section intro (wording unchanged) |
| Condition "“Alarms and timers” on in settings (on by default)" | Every row's conditions cell (previously only on the two "set" rows; in fact every tool is registered only while it is on) |
| "(ALARM-2)" | Removed: an internal batch label that means nothing to users |

Changing a summary does not change what the model sees: catalog fields do not enter function specs (4.2).

<a id="45-基準檔前後-diff"></a>
### 4.5 Baseline diff before and after

| Output | Before → after (characters) | Catalog-generated rows |
|---|---|---|
| Chinese page | 19,140 → 24,698 | 5 (`timer-0`…`timer-4`) → 27 (`cap-app.*`) |
| English page | 29,856 → 38,776 | 5 → 27 |
| README | 9,282 → 11,933 | 5 → 27 (Markdown table rows) |

Replaced: the 5 rows `timer-0` to `timer-4` (now 13 `cap-app.timer.*`/`cap-app.alarm.*` rows), the "Timers and alarms" intro (two sentences appended) and that section's columns (a "Service" column added). Added: the `apps` section and its 14 rows. Everything else is unchanged (4.1).

<a id="46-截圖fixture"></a>
### 4.6 Screenshots (fixture)

[Chinese](cap-2-commands-from-catalog-2026-11-24/commands-zh-TW-FIXTURE.png), [English](cap-2-commands-from-catalog-2026-11-24/commands-en-FIXTURE.png): headless Chromium opening the HTML file produced by `renderCommandsPage`, cropped to the "Timers and alarms" and "App integrations" sections. The settings are a fixture: realtime available (API key route), with only the timer, alarm and weather registered and every other service unconfigured, so those rows are marked "Currently: not configured". This is not a screenshot of a real running Nous.

<a id="5-分層與產品紅線"></a>
## 5. Layering and product red lines

- `shared/voice-commands.ts` imports only `shared/` (`CapabilityStatus` from `shared/integrations.ts`, `RouteId` from `shared/realtime-route.ts`); the architecture guard tests pass.
- `/help/commands` is still a read-only page the user opens deliberately: no script, and the CSP is not relaxed (the style did not change, so the hash is the same). No permanent UI, launcher or Dashboard was added.
- Voice behaviour is unchanged: no matching rule, tool definition or route was changed.

<a id="6-沒有做的事照實寫"></a>
## 6. What was not done (stated plainly)

- **Not a product gate and not a Mac acceptance test.** No real voice, and no real TV, calendar, Gmail, weather or speaker.
- The 9 page tools in "ask the AI" are still generated from `ASK_THE_AI` (CAP-4). The model cannot ask the catalog yet (CAP-3). `domain` is not wired to the brain-region animation (CAP-6). No skills (SKL-*), no Spotify change, no new permission or safety mechanism.
- "Stop ringing" and "snooze" are both local fixed phrases (the `ring-stop` row under "no speech") and model tools; both places list them as they are, without merging.
- At narrow widths the service column wraps (for example 「定時器」); the CSS was not changed, because changing the style would change the CSP hash and the output of the other sections.

<a id="7-數字的計算方式"></a>
## 7. How the numbers were computed

| Number | How |
|---|---|
| 27 rows | Static catalog `kind === "integration" && !hidden`: 32 − 5; also asserted by a test |
| 13 / 14 rows | The 27 rows split by `builtin`: timer 7 + alarm 6; voice_relay 1 + google_calendar 2 + weather 1 + lg_tv 9 + gmail_gog 1 |
| 788 → 792 translation keys | Key count of `git show c365f7d:prototype/ambient-shell/server/messages.en.json` and of the current file; 788 − 7 + 11 = 792 (the 3 rewritten keys do not change the count) |
| Characters and rows (4.5) | `node` reads both baselines: characters are `length`; page rows are matches of `data-row="(timer-\d\|cap-…)"`; for the README, the data rows of the two section tables are counted |
