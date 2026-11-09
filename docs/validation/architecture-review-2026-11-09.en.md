<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-review-2026-11-09.md) | [English](architecture-review-2026-11-09.en.md)

# Measurements and baseline for the architecture review (2026-11-09)

Companion document: [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md). This record only explains how the numbers were computed, at which commit, and what the baseline verification returned. **Everything here is static analysis plus automated tests in a cloud container; it is not a product gate and not real-device acceptance.**

## 1. Environment

- Baseline: main `416a1ab` (after PR #138), branch `claude/architecture-review-2026-11`.
- Linux cloud container, Node.js v22.23.4, dependencies installed in `prototype/ambient-shell` with `npm ci` (vitest 5.0.3, TypeScript 7.0.2, Vite 8.3.4).
- No microphone, camera, Mac, Pi, hub or TV; no real accounts.

## 2. Baseline verification (on main, before any doc change)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | passed, 2.5 s |
| Unit and integration tests | `npx vitest run` | 172 test files passed; 3,188 tests passed, 6 skipped; 54 s |
| Front-end build | `npx vite build` | passed; warning: the `zh-tw-opencc` chunk is 1,070 kB, above 500 kB |
| Desktop main syntax | `node --check desktop/main.mjs` | passed |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS, 66 s (typecheck, tests, build, isolated mock task and chat HTTP) |
| Bilingual docs | `node scripts/check-bilingual-docs.mjs` | passed: 135 documents, 134 complete pairs, 1 inline |
| Whitespace | `git diff --check` | passed |

## 3. Metrics script

`node scripts/architecture-metrics.mjs` (add `--json` for the full JSON). Read-only: it reads only `prototype/ambient-shell/{server,shared,src,desktop}` and `tests/`, runs nothing, fetches nothing and writes nothing. Excluded: `.d.ts` / `.d.mts`, `*.test.ts`, `node_modules`, `dist`, `desktop/scripts/` (build scripts).

### 3.1 Size and large files

| Layer | Files | Lines |
|---|---|---|
| server | 102 | 30,844 |
| src | 92 | 25,626 |
| shared | 38 | 7,721 |
| desktop | 9 | 2,696 |
| Total | 241 | 66,887 |

Lines are `text.split("\n").length` (this counts the trailing empty line, so it is one more than `wc -l`). Over 800 lines: 16 files, listed in 23 §1.1.

### 3.2 Import graph

- Only relative imports are followed (`import … from "./x.ts"`, `import("./x.ts")`, `import "./x.ts"`, `export … from`), including type-only imports. Resolution order: the literal string, `.ts`, `.mts`, `.mjs`, `.js→.ts`, `/index.ts`.
- Allowed directions: `server→{server,shared}`, `src→{src,shared}`, `desktop→{desktop,shared}`, `shared→shared`. **Cross-layer violations: 0**.
- Cycles are found with Tarjan's strongly connected components. Result: **4 cycles**:
  1. `shared/realtime-route.ts` ↔ `shared/seconds-menu.ts` ↔ `shared/types.ts` ↔ `shared/voice-cost.ts` (all type-only)
  2. `server/apikey-call.ts` ↔ `server/codex-auth.ts` ↔ `server/codex-responses.ts` ↔ `server/live-tool-caller.ts` ↔ `server/memory/live.ts` ↔ `server/proactive-calendar.ts` ↔ `server/realtime-routes.ts` ↔ `server/web-search.ts` (includes runtime values: `realtime-routes.ts:36` ↔ `apikey-call.ts:7`)
  3. `server/memories-google.ts` ↔ `server/memories.ts` (one side type-only)
  4. `src/api.ts` ↔ `src/realtime-session.ts` ↔ `src/realtime-tools.ts` ↔ `src/realtime.ts` (`api.ts:22` is a value import, the rest type-only)
- Highest fan-out: `src/main.ts` 67, `server/nous.ts` 62, `server/app.ts` 51, `src/views.ts` 27, `src/api.ts` 22. Highest fan-in: `shared/i18n.mjs` 40, `shared/types.ts` 37, `shared/identity.ts` 26, `shared/realtime-route.ts` 24, `shared/sense.ts` 23.

### 3.3 HTTP routes: 85 (counted by hand, line by line)

The script only counts the `path === "/api/…"`, `path.startsWith(…)` and `path.match(/^\/api…/)` matches in `app.ts`, which is not the number of routes (one line can hold several verbs or sub-paths). The 85 come from listing every match of `grep -nE "path ===|path\.match|startsWith\(" server/app.ts` inside `handleApi` (404-1053), with these rules:
- Each sub-path in the alarm block (527-569) counts as one route (9 routes).
- GET and POST on `/api/terminal/display` count as two; `/api/tasks/:id/(cancel|retry)` counts as two.
- Voice relay in `server/integrations/voice-relay/routes.ts`: the `GET` plus 9 `case` branches count as 10.
- 5 non-API dispatches: `/help/commands`, `/face-runtime/*`, `/speaker-runtime/*`, `/wake-runtime/*`, static pages.
- The `/commands`, `/infrared-commands` and `/aifa/discover` strings in `realtime-routes.ts`, `live-route.ts`, `home-bridge.ts` and `memory/` are outbound hub URLs, not routes.

### 3.4 Settings file writers

- Server files that call `renameSync` themselves: 16 (`alarms`, `chatgpt-auth`, `codex-auth`, `identity-store`, `integrations/voice-relay/store`, `lgtv/store`, `memories-google`, `memory/store`, `nous`, `prefs-file`, `proactive`, `providers`, `sealed-vault`, `store`, `task-migration`, `voice-cost-log`).
- Server files that import `prefs-file.ts`: 11 (`audio-`, `camera-`, `clock-`, `day-night-`, `face-tuning-`, `home-corner-`, `realtime-`, `voice-`, `wake-settings`, `memories`, `proactive`). `proactive.ts` is in both lists: its settings use PrefsFile, its daily log is written by hand.
- `server/app.ts`: `localizeSettings(settings.view(pageSource` appears 18 times; the error string "not saved (cannot write settings file" appears 12 times.

### 3.5 The two realtime page classes

`src/realtime.ts` and `src/live-voice.ts` share 13 same-named `private` methods: `cancelGreetTimer`, `close`, `greetIfPending`, `handle`, `onCore`, `onHostCall`, `quietLocalCommand`, `scheduleGreeting`, `setPhase`, `skipGreeting`, `stopEarlySpeech`, `teardown`, `watchEarlySpeech` (regular expression `^\s+private\s+(async\s+)?name\(`). Same name does not mean same body; the ones compared line by line in 23 §P1-2 are the four greeting methods, the two early-speech methods, `onCore` and `onHostCall`.

### 3.6 Test classification

172 `tests/*.test.ts`, first matching class wins (matched against the whole file):

| Order | Class | Regular expression | Files |
|---|---|---|---|
| 1 | Desktop | `\.\./desktop/` | 25 |
| 2 | Server HTTP | `server/app\.ts` or `node:http"` | 23 |
| 3 | Page DOM | `globalThis\.document`, `document\.createElement`, `HTMLElement`, `createElement`, or `readFileSync(…src|index.html|history.html|style.css)` | 29 |
| 4 | Fixture | `\./fixtures/` or `\./fixtures\.ts` | 30 |
| 5 | Pure | everything else | 65 |

Without the precedence rule: 22 files import `server/app.ts` and 52 files use fixtures. `package.json` has no `jsdom` / `happy-dom`; no test uses `@vitest-environment`.

### 3.7 Source modules not imported directly by any test (26)

`desktop/main.mjs`, `desktop/preload.cjs`, `server/index.ts`, `server/integrations/schema.ts`, `server/integrations/voice-relay/routes.ts`, `server/integrations/voice-relay/store.ts`, `server/lgtv/config.ts`, `server/prefs-file.ts`, `server/sideband.ts`, `shared/identity-validate.mjs`, `shared/memory-validate.mjs`, `src/alarm-ring.ts`, `src/audio/capture-worklet.ts`, `src/audio/capture.ts`, `src/audio/index.ts`, `src/audio/wake-worker.ts`, `src/brain-canvas.ts`, `src/brain-frame.ts`, `src/clock-corner.ts`, `src/format.ts`, `src/history-page.ts`, `src/home-icons.ts`, `src/icons.ts`, `src/main.ts`, `src/sense/identity-worker.ts`, `src/sense/light-worker.ts`.

Method: resolve the relative imports of `tests/*.test.ts`, `tests/fixtures.ts` and `tests/fixtures/*.ts` to source paths, take the union, and subtract it from the source list. "Direct import" only: many modules are tested indirectly through other modules (for example `prefs-file.ts` through the 11 stores; `identity-validate.mjs` through `desktop/identity-ipc.mjs`), and some tests check by reading the source text (`wake-threshold`, `audio-privacy`, `camera-privacy`).

## 4. How the doc drift was checked

Every row of the 23 §P1-5 table was checked with `grep -n` at the baseline commit, finding both the document sentence and the corresponding code (or confirming the file does not exist). The 9 missing validation index entries come from `ls docs/validation/*.md | grep -v '\.en\.md'` (81 records excluding the README) compared with the table in `docs/validation/README.md` (69 rows).

## 5. Limits

- Static analysis only; runtime behaviour is not measured. "Duplication" of same-named methods and similar blocks is a human reading judgement; the number counts same names only.
- Line numbers drift with later PRs; re-running the script refreshes the numbers, but the line references in 23 need manual updates.
- The green baseline is a mock / fixture code check, not G0–G3 or any Mac / Pi gate.
