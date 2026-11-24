<!-- bilingual: source=zh-TW -->

> [繁體中文](skl-2-skills-realtime-2026-11-24.md) | [English](skl-2-skills-realtime-2026-11-24.en.md)

# SKL-2 skills on both realtime voice routes: validation

Date: 2026-11-24 (Asia/Taipei). Branch: `claude/skl-2-skills-realtime`, based on main at `c853078` (SKL-1, PR #154 merged). Scope is SKL-2 in [24 §4.4](../24_Capability_Catalog_and_Skills_2026-11.en.md#44-batches): a skill index in the session instructions of both realtime voice routes, the read-only tool `app.skill.read`, and filtering by available tools, switched by `NOUS_SKILLS`.

**Everything done in the cloud for this batch is fixtures and type checks. It is not a product gate and not Mac acceptance.** The SKL-2 gate also requires "run the morning briefing once on the Mac with real voice and record the real result of every step": **not done; it waits for George to run it on the Mac.** The steps and an empty result table are in [section 7](#7-mac-acceptance-for-george-not-run).

## 1. Environment

| Item | Value |
|---|---|
| Machine | Linux cloud container (not a Mac, not a Pi) |
| Node | v22.23.5 |
| Install | `npm ci` in `prototype/ambient-shell` (no package added or upgraded) |
| External services | None contacted: the weather and calendar Adapters use test doubles; the `startNous` tests use a fake Open-Meteo reply and a gog path that does not exist (never called) |

## 2. What was delivered

Paths are under `prototype/ambient-shell/`.

| Item | Content |
|---|---|
| Flag | Only `NOUS_SKILLS=on` turns it on (off by default); `server/config.ts` reads it into `config.skills`. When it is off, `server/nous.ts` reads no skill directory and registers no read tool; the tool list, instructions and `/help/commands` are the same as before |
| Skill index and reading | `SkillBook` in `server/skills/runtime.ts`: `listing()` (filters by the registry's live status, sorts by name, applies the limit), `indexLines()` (the index section of the session instructions), `read()` (what the read tool returns), `skillLoadLog()` (startup diagnostics). Both routes share this one implementation ([23 §P1-2](../23_Architecture_Review_2026-11.en.md)) |
| Read tool | `app.skill.read` (the model sees `app__skill__read`), the `SkillAdapter` in `server/integrations/adapters/skill.ts`, a core built-in `BuiltinAdapter` like the timer, going through the registry and the Dispatcher. `effect: read`, both voice routes, 1 s timeout; the name and ID constants are in `server/skills/tool-id.ts` |
| Instruction wiring | `server/realtime.ts`: `RealtimeCapabilities.skills` (the index, bound to a route). `realtimeToolRules()`, the rules shared by the API key voice model and the ChatGPT-plan tool layer, inserts the index after the alarm rule and before the voice volume rule. The ChatGPT-plan voice layer, which has no tools (`buildLiveInstructions()`), gets an "always delegate when it matches" index after the alarm sentence |
| Language | The read tool returns the text in the interface language, so `ExecutionContext` and `DispatchRequest` gain a `locale`. On the API key route the core supplies the session's language (new `RealtimeSessions.localeOf()`; the page cannot choose it); on the ChatGPT plan `LiveToolCaller` supplies it |
| Data limit | The normal limit on a result's `data` is 4,096 bytes; the 4,437-character English body does not fit. `ToolDefinition.resultDataMaxBytes` lets a read-only tool declare a larger limit, up to `MAX_READ_DATA_BYTES` = 32,768 (the 6,000-character body limit × 3 bytes per Chinese character = 18,000, still in range with JSON escaping). The registry rejects it on a non-`read` tool or out of range |
| Catalog | `SKILL_CATALOG` is added to `ADAPTER_CATALOGS`: summary, example "給我今天的簡報" ("Give me today's briefing"), `needs`, `domain: null`, `hidden: true`, `builtin: true`; English is in `server/messages.en.json` |
| Tests | New `tests/skills-realtime.test.ts`, 26 tests; 2 added to `tests/integration-routes.test.ts` (both routes pass the language to the Adapter); 2 SKL-1 tests that pinned "not used until SKL-2" and 3 catalog counts updated (see §4.5) |
| Docs | This record, the validation index, [current implementation status](../Current_Implementation_Status.en.md), the SKL-2 note in [24](../24_Capability_Catalog_and_Skills_2026-11.en.md), [writing a skill](../development/writing-a-skill.en.md) §8–§9, the prototype README directory notes, `.env.example`; Traditional Chinese and English |

### 2.1 Decisions and reasons

- **Name settled as `app.skill.read`**: keeps the docs/24 working name; it follows the existing `app.<service>.<action>` with service `skill`.
- **Not listed in `/help/commands` (hidden)**: users do not "call" this tool; the model decides to read from the index. `/help/commands` lists what users can say. The catalog still has the full data (visible in `npm run catalog -- --json`).
- **`domain: null`**: reading a procedure is not user content, so the call lights no brain region; the actual weather and calendar calls in the skill are the real events (CAP-6 animates them by their own `domain`).
- **The read tool appears only when a skill can be listed**: `SkillAdapter`'s `enabled()` is "at least one skill is listable on some voice route in some language". So with no calendar configured, the tool list is the same as with the flag off: the model sees neither the read tool nor an index.
- **The read tool does not bring in the integration rules**: when `realtimeToolRules()` decides whether to add the integration-layer rules, it leaves out `app__skill__read`. Otherwise, with the integration layer and timers both off, turning the flag on would add the integration rules (text that is not the index).
- **When filtering happens**: the API key route builds its instructions when the session starts (once for the client secret, once for the memory `session.update`), so the status at that moment applies; changes during the call do not update the index. The ChatGPT-plan tool layer rebuilds its instructions on every delegation (`LiveToolCaller.run()` calls `caps()` each time), so it follows changes during the call; its voice layer is built when the session starts. The read tool checks the live status on every call and refuses a skill that can no longer be used.

## 3. Commands and results

In `prototype/ambient-shell`:

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npx vitest run tests/skills-realtime.test.ts` | 1 file, 26 passed |
| `npx vitest run` | 184 files; last run 3,487 passed, 5 skipped (3,492 total); the run before, 3,486 passed and 6 skipped |
| `npm run catalog -- --check` | `能力總表檢查通過：42 個工具（36 個列在給人看的表、6 個 hidden）` (catalog check passed: 42 tools, 36 in the human-facing table, 6 hidden), `技能檢查通過：1 份出貨技能（morning-briefing），中英文各一份` (skill check passed: 1 shipped skill, Chinese and English), exit code 0 |
| `npm run docs:commands` | `README.md 的指令表已是最新` (README command table already up to date; the read tool is hidden, so the table did not change) |

Skips depend on environment conditions and can differ by one between runs (before any change this container also skipped 6); they were not added by this batch, and nothing failed.

Repo root:

| Command | Result |
|---|---|
| `node scripts/verify-aios.mjs` | PASS (type check, 184 test files, build, isolated mock HTTP flow; final numbers before delivery are in the PR description) |
| `node scripts/check-pstack.mjs` | Pass; output in the PR description |
| `node scripts/check-bilingual-docs.mjs` | `--record` after reviewing both versions, rerun passes; output in the PR description |

## 4. Gate evidence

### 4.1 Flag off: byte-for-byte unchanged

| Test | What it confirms |
|---|---|
| CAP-1/CAP-2 baselines in `tests/capability-catalog.test.ts` | `model-tools.baseline.json` (26 tool JSON outputs) and `commands-page.baseline.json` (`/help/commands` in both languages and the README command table) are identical. **The baseline files were not regenerated** |
| `without a skill book the instructions of all three layers equal a build with no skills at all` | Both routes × both languages: the three instructions (API key voice model, ChatGPT-plan tool layer, ChatGPT-plan voice layer) equal those with no skills at all, and `app__skill__read` does not appear |
| `the Dispatcher refuses app.skill.read when the flag is off` | Not registered: `refused`, `reason: not_registered` |
| `off (default): no skill is read, no read tool, no skill log line` (real `startNous`) | With weather and calendar in the integration layer, `/api/settings` has no `app__skill__read`, and the log has no line starting with "技能：" |
| `SKL-2: NOUS_SKILLS only sets config.skills` | Only the `skills` field of the configuration differs |

There is no baseline file for instruction text yet, so the evidence that "instructions are unchanged" is: the same code gives the same output for "no skills" and "flag off", and `server/realtime.ts` adds a section only when `caps.skills` exists (otherwise it spreads an empty array).

### 4.2 Flag on: the only differences are the read tool and the index

| Test | What it confirms |
|---|---|
| `tool JSON: the only difference is app__skill__read` | With weather and calendar registered, both routes × both languages: `functionSpecs()` and `buildRealtimeTools()` without `app__skill__read` are byte-identical to no skills; there is exactly one `app__skill__read`; the ChatGPT-plan tool layer's tool list has it too |
| `instructions: removing exactly the index lines gives back the flag-off text` | Removing the index lines from each of the three instructions gives exactly the no-skills text |
| `both routes get the same index` | The rule sections for the API key route and the ChatGPT-plan tool layer are identical |
| `index text` | The full Chinese instruction and one line `- name：description` per skill (description verbatim from `SKILL.md`); the English version comes from `SKILL.en.md` and has no Han characters; the index has no body text |

### 4.3 Filtering by available tools

| Test | What it confirms |
|---|---|
| `calendar not configured` | Only weather registered: the morning briefing is not listed, the index is empty (instructions completely unchanged), the read tool is `disabled` (not in the tool list), and the log says "工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）" (not listed, tool unavailable: app.calendar.list_events not registered) |
| `a registered but disabled tool also keeps the skill out` | A registered but `disabled` tool also keeps it out; back to `available`, it is listed |
| `the live tool layer rebuilds its instructions per delegation` | The ChatGPT-plan tool layer's instructions follow status changes |
| `on, calendar not configured` (real `startNous`) | `NOUS_SKILLS=on` with weather only: no read tool in the tool list, and the log records the reason |

### 4.4 The read tool

| Test | What it confirms |
|---|---|
| `returns the body in the session's language` | Both routes: a Chinese session gets the body of `SKILL.md`, an English one `SKILL.en.md`; `data` has `name`, `locale`, `tools`, `body`. The English `data` is over 4,096 bytes and still comes back intact |
| `refuses a name that is not loaded, a path-like name, and a name over 40 characters` | `movie-night`, `../morning-briefing`, `morning-briefing/SKILL.md`, 41 characters, no `name`, an extra argument: all `refused`, `invalid_arguments`. The name is only compared, as an exact string, with the loaded list and is never turned into a path |
| `refuses a loaded skill whose tools are unavailable on this route` | `refused`, `reason: unavailable`; the message and `data.unavailable_tools` name the unavailable tools (one sentence in each language) |
| `is refused as disabled when the read tool is registered but nothing is listable` | `refused`, `disabled` |
| `has full catalog data, is hidden from /help/commands` | In the catalog: `effect: read`, `builtin`, `hidden`, `domain: null`, both routes, with a summary, an example and `needs` |
| `only a read tool may raise its data limit` | 32,768 is accepted; 32,769 or a non-`read` tool fails to register |
| `SKL-2: the core passes the session's interface language to the Adapter` / `passes the caller's interface language` | API key: a session started with `x-nous-locale: en` gives the Adapter `en` (a `locale` in the request body has no effect); ChatGPT plan: `LiveToolCaller`'s language reaches the Adapter |

The read tool returns text only: `SkillBook.read()` takes the body from the skills already loaded in memory; it reads no file and runs nothing in the body. Skills cannot add or enable tools or change settings. Every step in the body is still the model calling the matching tool, through the Dispatcher and the existing policy.

### 4.5 Existing tests that changed

All are places SKL-1 explicitly marked "SKL-2 will change this", or counts derived from the catalog; none are baseline files:

- `tests/skills.test.ts`: "no code reads `NOUS_SKILLS` in SKL-1" became "it only sets `config.skills`"; "only `scripts/catalog.ts` imports the skill modules" became "`scripts/catalog.ts` and `server/nous.ts`", and `app.skill.read` in the catalog must be hidden, builtin and read.
- `tests/capability-catalog.test.ts`: one more built-in Adapter, `skill`; integration tools 32→33, hidden 5→6.
- `tests/commands-from-catalog.test.ts`: hidden tools 5→6; `app.skill.read` is not on the page.

## 5. Measurement: how much the index adds, and the limit

Method: build the instructions with and without the index from the same code and the same capabilities, and subtract their Unicode code point counts (`[...text].length`, as in `SKILL_LIMITS`). Only the morning briefing, with weather and calendar both available. The test `measured: how much the index adds` recomputes and checks these numbers on every run.

| Instructions | Chinese | English |
|---|---:|---:|
| API key voice model session instructions | **+202** | **+571** |
| ChatGPT-plan tool layer (each delegation) | +202 | +571 |
| ChatGPT-plan voice layer (delegate index) | +113 | +339 |
| of which: the instruction line | 132 | 369 |
| of which: the morning briefing line | 68 | 200 |

202 = 132 + 68 + 2 newlines; 571 = 369 + 200 + 2. For comparison: the API key instructions used for the measurement (web search on, home off, no integration tools, no tasks) are 1,394 characters in Chinese and 1,596 with the index; in English 1,607 → 2,178.

**Limit (`SKILL_INDEX_LIMITS`): at most 8 skills at a time, and the whole index (instruction plus one line per skill, joined by newlines) at most 2,000 characters, the same for both languages.** Reason: English is longer; 8 skills as long as the morning briefing come to 369 + 8 × (200 + 1) = 1,977 characters, which just fits; in Chinese the same 8 come to 132 + 8 × 69 = 684. The `description` limit is 240 characters, so the longest line is about 284 characters; skills that long reach the character limit at about 5.

**When over the limit**: sorted by name, everything from the first skill that does not fit onward is left out (shorter ones are not squeezed in later, so the result is predictable), and the log says "超過索引上限（8 份／2000 字）沒列：…" (over the index limit (8 skills / 2000 characters), not listed: …). The read tool also refuses a truncated skill (`unavailable`), so the model and the index agree. Tests: `lists at most 8 by name order`, `stops at the first skill that does not fit`.

### 5.1 The text added to the instructions when the flag is on

Chinese interface, API key voice model and ChatGPT-plan tool layer (inserted after the alarm rule). In English: "Common household requests have written procedures (skills), listed below. When a request matches one, first call app__skill__read (name as listed) to read the body, then follow it; every step in the body still uses the matching tool, and say only what the tools actually returned. A procedure not listed below is not available right now; do not pretend it exists." The skill line is the morning briefing's Chinese `description`.

```text
家裡常做的事有寫好的做法（技能），列在下面。使用者的請求符合其中一項時，先呼叫 app__skill__read（name 照下面的名稱）讀內文，再照內文做；內文裡的每一步仍要用對應的工具完成，只說工具真的回傳的內容。下面沒有列出的做法就是目前不能用，不要假裝有。
- morning-briefing：使用者要早晨簡報、想一次聽今天的天氣和行程時使用（例如「給我今天的簡報」「今天天氣和行程怎樣」）。
```

Chinese interface, ChatGPT-plan voice layer (no tools). In English: "Common household requests have written procedures; when a request matches one below, always delegate it (with the user's own words):"

```text
家裡常做的事有寫好的做法，使用者的請求符合下面其中一項時一律交辦（連同使用者的原話）：
- morning-briefing：使用者要早晨簡報、想一次聽今天的天氣和行程時使用（例如「給我今天的簡報」「今天天氣和行程怎樣」）。
```

The same two sections in an English interface (the skill description comes from `SKILL.en.md`):

```text
Some common household requests have written procedures (skills), listed below. When a request matches one, first call app__skill__read with that name to read the procedure, then follow it; every step still goes through the matching tool, and say only what the tools actually returned. A procedure that is not listed is not available right now; do not pretend it exists.
- morning-briefing: Use when the user asks for a morning briefing or wants today's weather and schedule together (for example "give me today's briefing" or "what's the weather and my schedule today").
```

```text
Some common household requests have written procedures; when a request matches one below, always delegate it (with the user's own words):
- morning-briefing: Use when the user asks for a morning briefing or wants today's weather and schedule together (for example "give me today's briefing" or "what's the weather and my schedule today").
```

## 6. Diagnostic log

With `NOUS_SKILLS=on`, the startup log (macOS App: `~/Library/Application Support/Nous/nous.log`; `npm start`: the terminal) records what actually happened:

```text
技能：載入 1 份（morning-briefing）
技能：api_key／zh-TW 列出 1 份（morning-briefing）
技能：api_key／en 列出 1 份（morning-briefing）
技能：live／zh-TW 列出 1 份（morning-briefing）
技能：live／en 列出 1 份（morning-briefing）
```

(Loaded 1 skill; then, per route and language, "listed 1 (morning-briefing)".) This is the output of the real `startNous` test with weather and calendar registered. With no calendar it is `技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）` (listed 0; not listed, tool unavailable: … not registered). After that, each time instructions are built (a call starts; each ChatGPT-plan delegation) a line is written only if the result differs from the previous one. A broken skill file logs `技能：N 份檢查失敗被略過：…` (N skills skipped after failing the check) and each problem (`技能：✗ file (code) message`); only that skill is skipped and Nous starts as usual (test `loads the good skill, skips the bad one`). If reading the skill directory itself throws, one line is logged and there are no skills this time. The log never contains skill body text.

## 7. Mac acceptance (for George, not run)

**Status: NOT TESTED.** The cloud has no Mac, microphone or real account, so this section has no results. Afterwards, fill in the table in 7.4 and add it, with log excerpts, to this record (or a new Mac record).

### 7.1 Preparation

1. Weather: the integration layer must list `weather`; pick a weather place under "Proactive briefing" in the menu bar (without one, weather returns `refused`, which is another case to record).
2. Calendar: gog has Calendar authorized as in [CAL-1](cal-1-google-calendar-2026-11-05.en.md); ideally today's Google Calendar has 1–2 events to check against.
3. At least one realtime voice route works (ChatGPT plan or `OPENAI_API_KEY`). Running both once is recommended, because they are wired differently (on the API key route the voice model calls tools itself; on the ChatGPT plan the tool layer does).

### 7.2 `.env` (macOS App: menu bar "Edit API keys and advanced settings (.env)…", the core restarts on save; with `npm start`, restart after editing)

```bash
NOUS_SKILLS=on
NOUS_AIL=on
NOUS_AIL_SERVICES=weather,google_calendar
NOUS_GOG_ACCOUNT=you@gmail.com
```

Keep any other services already in `NOUS_AIL_SERVICES` and add these two; set `NOUS_GOG_ACCOUNT` to your own Gmail (it falls back to `NOUS_MAIL_SELF`); `NOUS_GOG_PATH=/opt/homebrew/bin/gog` is needed only if gog is not found.

### 7.3 Three cases

**Case A: both tools available.**

1. After start-up, find the lines starting with `技能：` in `~/Library/Application Support/Nous/nous.log`; they should be the 5 lines in §6 (`列出 1 份（morning-briefing）`).
2. Start realtime voice and say "給我今天的簡報" (English interface: "Give me today's briefing").
3. Expected: first today's weather (place, condition, low to high; rain only from 30%, an umbrella reminder from 50%), then today's events (time and title, at most 5); only what the tools returned.
4. Record this call's tool calls from the log: on the API key route `整合層：xxxxxxxx app.skill.read api_key → confirmed`, `app.weather.today api_key → …`, `app.calendar.list_events api_key → …`; on the ChatGPT plan there are also lines like `即時語音（ChatGPT 方案）：整合工具 app__skill__read → confirmed`. Record the order, each status and the milliseconds.
5. Check: does the weather match Open-Meteo / the weather corner? Do the events match Google Calendar? Did it say anything the tools did not give (feels-like temperature, tomorrow's weather)?
6. Extra (optional): once in each interface language; say "tomorrow's briefing" and see whether it first says weather is only available for today.

**Case B: calendar not configured (the skill should not be listed).**

1. Remove `google_calendar` from `NOUS_AIL_SERVICES` (keep only `weather`) and restart.
2. The log should have `技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）` (one line for each other route and language as well), and **no** `app.skill.read` call at all.
3. Say "給我今天的簡報". Expected: the model does not claim to have a morning briefing procedure and does not call `app.skill.read`; it may give just the weather (with the weather tool) or say truthfully that the schedule cannot be read / the calendar is not connected. It **must not** make up events.
4. Record what the model actually said and which tool calls are in the log.

**Case C: flag off.**

1. Set `NOUS_SKILLS=off` in `.env` (or delete the line), add the calendar back, restart.
2. The log has **no** line starting with `技能：` and no `app.skill.read` call.
3. Say "給我今天的簡報". Expected: behaviour as before SKL-2 (the model may or may not decide to call weather and calendar by itself; this is the baseline, record it as it is).

### 7.4 Result table (for George to fill in)

| Case | Route | Interface language | "技能：" log lines | Tool calls (order, status, ms) | What the model actually said (summary) | Consistent with tool results? | Result |
|---|---|---|---|---|---|---|---|
| A both available | API key | Chinese | | | | | NOT TESTED |
| A both available | ChatGPT plan | Chinese | | | | | NOT TESTED |
| A both available | (either) | English | | | | | NOT TESTED |
| B no calendar | (either) | Chinese | | | | | NOT TESTED |
| C flag off | (either) | Chinese | | | | | NOT TESTED |

Do not paste real event titles or family names into the repo; a summary such as "2 events, times and titles match the calendar" is enough.

## 8. Limits and what was not done

- **Mac acceptance was not done** (section 7): whether the model actually reads the skill, follows it, and how it sounds is completely unknown.
- On the API key route the index reflects the session start; tool status changes during the call do not update it (the read tool still refuses by the current status).
- Text chat and background tasks are not connected to skills (that waits for CAP-5).
- No SKL-3 (remember this procedure, saving, a household skill directory), CAP-3, CAP-4 or CAP-6; Spotify untouched; no persistent UI, launcher or dashboard; no new permission or safety mechanism.
- The session-instruction rules are still mostly Chinese (existing design); in an English session only the index instruction and the skill descriptions are English.
- The limit is set from the one current skill; if skills are often truncated once there are more, measure again and adjust.

## 9. Next gate

1. **SKL-2 Mac acceptance** (section 7), run by George. Until it passes, skills cannot be claimed to work with real voice.
2. Following the order in [24](../24_Capability_Catalog_and_Skills_2026-11.en.md), next is CAP-3 (the model can query the catalog), then SKL-3.
