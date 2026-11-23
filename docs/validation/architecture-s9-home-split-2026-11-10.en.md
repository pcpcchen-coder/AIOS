<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s9-home-split-2026-11-10.md) | [English](architecture-s9-home-split-2026-11-10.en.md)

# Architecture restructuring S9: `home-bridge.ts` split into `server/home/` (2026-11-10)

Companion documents: §P1-4 and S9 in §3 of [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md); the feature specification is §6 of [12 Smart home integration](../12_SmartHome_Integration_Plan_2026-10.en.md). George approved S6–S9 on 2026-11-10. This batch only moves code; **the goal is zero behaviour change**. Everything here is type checking plus automated tests against a fake hub (fixture) in a cloud container; **it is not a product gate, and no real hub, air conditioner, infrared appliance or light was touched**.

## 1. Environment

- Branch `claude/arch-s9-home-split`, based on main `1b61d08`.
- Linux cloud container, Node.js v22.23.4, vitest 5.0.3. `prototype/ambient-shell/node_modules` is a symlink to the main checkout and is not committed.
- No home hub, AIFA air conditioner, infrared blaster, light, Mac or Pi; no real account or token. The tokens and devices in the tests are invented fixtures.

## 2. What was done

`prototype/ambient-shell/server/home-bridge.ts` (1,654 lines by `wc -l`) is split into 7 files in the folder `server/home/`; `server/home-bridge.ts` stays as an entry point that only re-exports (a barrel, 36 lines), so the import paths of the 4 importers (`server/app.ts`, `server/nous.ts`, `server/home-overview.ts`, `server/integrations/adapters/home.ts`) and of every test are unchanged, and those 4 files themselves are not modified.

The move was done by a one-off script that cuts and pastes by "line ranges of the old file" (not committed), not by hand, so function bodies, comments, strings and module-level constant values are verbatim. The `HomeBridge` class stays whole in `bridge.ts`; no method was turned into a free function and no `private` member was changed.

### 2.1 File map (old line numbers → new files)

Line counts are `wc -l`. Lines 1–5 of the old file are the header comment and lines 7–35 are imports.

| New file | Lines | Old line numbers | Contents |
|---|---|---|---|
| `server/home/types.ts` | 199 | 37, 49–72, 87–211, 550–589, 618 | `TIMEOUT_MS`, `H1B_TIMEOUTS_MS`, `COOLDOWN_WAIT_MS`, `UTTERANCE_MS`, `MIN_SEND_WINDOW_MS`; `HomeBridgeOptions`, `VoicePolicy`, `ControlRequest`, `HubMetric`, `HubDataStatus`, `IrKey`, `AifaClimateCaps`, `DeviceRoute`, `UnsupportedWhy`, `HubDevice`, `AifaListState`, `HubSnapshot`, `HomeBridgeErrorCode`, `HomeBridgeError`; `HubReply`, `ReplyMapper`, `ControllerReport`, `ClimateChange`, `ClimatePacket`, `Refusal` |
| `server/home/parse.ts` | 143 | 1517–1654 | `isRecord`, `str`, `num`, `dataStatus`, `TUYA_AIR_CON`, `UNSUPPORTED_TEXT`, `parseInfrared`, `routeOf`, `parseHome`, `reportedPowerValue`, `aifaId`, `parseCaps`, `parseAifa` |
| `server/home/readings.ts` | 92 | 213–230, 235–263, 477–514 | `METRICS`, `DATA_TEXT`, `norm`, `metricKey`, `splitMetric`, `clock`, `round`, `offline`, `report` |
| `server/home/aifa.ts` | 146 | 76–85, 667–766, 869–896 | `CLIMATE_DEFAULTS`, `NO_CLIMATE_TEXT`, `checkClimate`, `buildClimate`, `AC_OFF_TIMER_NOTE`, `AC_OFF_TIMER_NOTE_UNSURE`, `acOffTimerNote`, `reportedText`, `oneOf`, `parseReport`, `AIFA_STALE`, `AIFA_KEY_CONFLICT`, `aifaReply` |
| `server/home/infrared.ts` | 111 | 768–842, 898–926 | `keyNorm`, `IR_SYNONYMS`, `SYNONYM_SETS`, `MAX_KEY_LABELS`, `matchKey`, `irReply` |
| `server/home/commands.ts` | 348 | 73–75, 232–234, 265–475, 516–548, 591–603, 620–665, 844–867 | `AIFA_LIST_TTL_S`, `AIFA_STALE_MARGIN_S`, `WHOLE_HOME`, `TRAILING`; `ON` / `OFF`, `toBool`, `toNumber`, `isCommandName`, `parseCommand`, `word`, the air-conditioner word tables; `H1_COMMANDS`, `H1Command`, `isH1Command`, `toWire`; `names`, `Resolution`, `resolveTarget` and the rest of the name matching; `ROUTE_TAG`, `TAGGED_NOTE`, `TV_MOVED`, `LIVING_TV`, `isTvName`, `isTvDevice`, `ambiguous`; `AifaRef`, `Plan`, `planFor`; `commandsReply` |
| `server/home/bridge.ts` | 637 | 38–47, 605–616, 928–1515 | Constants only the class uses (`MAX_DEVICES`, `COMMAND_TIMEOUT_MS`, `REFRESH_TIMEOUT_MS`, `RATE_LIMIT`, `RATE_WINDOW_MS`, `CONFIRM_TTL_MS`, `MAX_PENDING`), `PendingCommand`, `Entry`, `class HomeBridge` (whole, 582 lines), `refusedConnection` |
| `server/home-bridge.ts` (entry point) | 36 | 1–4 (header comment) | Only `export … from "./home/*.ts"` |
| Total | 1,712 | | 58 lines more than the old file: each file's imports, a one-line header comment per file, and the entry point's re-exports |

Apart from blank lines, every line from 37 to 1654 of the old file appears in exactly one new file (§3.1).

### 2.2 Dependency direction (no cycles)

`types.ts` imports only `shared/home.ts`. The rest: `parse.ts` → `types`; `readings.ts` → `types`; `aifa.ts` → `parse`, `types`; `infrared.ts` → `parse`, `types`; `commands.ts` → `aifa`, `infrared`, `parse`, `readings`, `types`; `bridge.ts` → all of the above. The import cycles reported by `node scripts/architecture-metrics.mjs` are still the original 4; there is no new one.

### 2.3 Differences from 23 §3 and from the delegation's suggestion

- 23 §3 says `server/home/{hub-client,parse,commands,aifa,infrared,bridge}.ts`. There is no `hub-client.ts`: sending and reading (`post`, `refresh`, `snapshot`, `home` and so on) are `private` methods of `HomeBridge`, and this batch does not split the class. `types.ts` and `readings.ts` were added. So it is 1 file → the entry point plus 7 files, not the 1 file → 7 files in the original text.
- `HubReply`, `ControllerReport`, `ClimateChange`, `ClimatePacket` and `Refusal` live in `types.ts`, not in `aifa.ts`: `HubReply` uses `ControllerReport`, and `aifa.ts`, `infrared.ts`, `commands.ts` and `bridge.ts` all use `HubReply`; putting them in `aifa.ts` would create a type cycle.
- `norm` (name normalisation) lives in `readings.ts`, and the name matching and TV check in `commands.ts` import it; no separate file was created for one function.
- `UNSUPPORTED_TEXT` stays in `parse.ts` (it already sat next to the parsers), and `NO_CLIMATE_TEXT` and `AIFA_STALE` stay in `aifa.ts`; both `planFor` and `HomeBridge` use them.
- `commandsReply` (the H1 reply mapping) lives in `commands.ts`; `aifaReply` is in `aifa.ts` and `irReply` in `infrared.ts`.
- The comment on lines 519–523 of the old file (how candidate names are built) was already separated from `ambiguous()` by the TV section; the whole block 516–548 moved together, in the same order.

### 2.4 What is not a verbatim move (complete list)

1. **24 declarations gained `export`** (for use inside the folder only; the entry point does not re-export them): `TIMEOUT_MS`, `HubReply`, `ReplyMapper`, `Refusal` in `types.ts`; `isRecord`, `str`, `num`, `UNSUPPORTED_TEXT`, `aifaId` in `parse.ts`; `METRICS`, `norm`, `splitMetric` in `readings.ts`; `NO_CLIMATE_TEXT`, `checkClimate`, `acOffTimerNote`, `reportedText`, `parseReport`, `AIFA_STALE` in `aifa.ts`; `toWire`, `H1Command`, `isTvDevice`, `ambiguous`, `AifaRef`, `commandsReply` in `commands.ts`.
2. **Line 5 of the header comment changed in one place**: the old file said 「三條控制路徑都在這個檔案：…」 (all three control paths are in this file); after the split that sentence is no longer true, so the entry point says 「三條控制路徑都在 server/home/：…」; the rest is verbatim.
3. **8 comment lines were added**: a one-line header comment in each of the 7 new files, and one line in the entry point saying that it only re-exports.
4. The import and export statements (rewritten per file according to what it actually uses).

In the code itself (function bodies, constant values, strings, type definitions) not a single line differs.

## 3. Verification

### 3.1 Mechanical check that the move is verbatim (script not committed)

Method: the old file (`git show main:prototype/ambient-shell/server/home-bridge.ts`) and the 8 new files (the entry point plus `server/home/*.ts`) each have their import statements, `export { … } from` statements and blank lines removed; the remaining lines are compared as multisets.

| Item | Result |
|---|---|
| Lines left in the old file | 1,494 |
| Lines left in the new files in total | 1,502 |
| Only in the old file | 25 lines |
| Only in the new files | 33 lines |
| Of which pairs that differ only by a leading `export ` | 24 pairs (the 24 declarations listed in §2.4 item 1) |
| Only in the old file after removing those | 1 line: the old header line 5 |
| Only in the new files after removing those | 9 lines: the changed header line 5, plus the 8 comment lines of §2.4 item 3 |

That is, of the 1,494 lines, 1,469 are identical, 24 only gained `export `, and 1 is the comment of §2.4 item 2. This check compares multisets of lines and does not check their order; the order is guaranteed by "cut and paste by line range" (the order inside each range is unchanged) and is verified indirectly by type checking and the tests.

### 3.2 Export comparison

Using `tsx`, the old module (extracted to a temporary folder, with `shared/` symlinked to this branch) and the new entry point were each `import`ed and their `Object.keys()` compared:

- Value exports: 24 old, 24 new, the names exactly the same, none added and none missing; `typeof` is the same for each; the 9 constants that are not functions have the same `JSON.stringify`. The 24 are: `AC_OFF_TIMER_NOTE`, `AC_OFF_TIMER_NOTE_UNSURE`, `CLIMATE_DEFAULTS`, `COOLDOWN_WAIT_MS`, `H1B_TIMEOUTS_MS`, `HomeBridge`, `HomeBridgeError`, `IR_SYNONYMS`, `MIN_SEND_WINDOW_MS`, `TV_MOVED`, `UTTERANCE_MS`, `aifaReply`, `buildClimate`, `irReply`, `isTvName`, `keyNorm`, `matchKey`, `metricKey`, `parseAifa`, `parseCommand`, `parseHome`, `planFor`, `report`, `resolveTarget`.
- Type exports: the old file has 18 `export type` / `export interface` declarations, each matched by a `type` re-export in the entry point: `AifaClimateCaps`, `AifaListState`, `ClimateChange`, `ClimatePacket`, `ControlRequest`, `ControllerReport`, `DeviceRoute`, `HomeBridgeErrorCode`, `HomeBridgeOptions`, `HubDataStatus`, `HubDevice`, `HubMetric`, `HubSnapshot`, `IrKey`, `Plan`, `Resolution`, `UnsupportedWhy`, `VoicePolicy`. `npx tsc --noEmit` passes with the 4 importers and every test unmodified.
- `HomeBridgeError` is a single class object: the one the entry point exports is the same (`===`) as the one in `server/home/types.ts`, so `instanceof` in `app.ts`, `home-overview.ts` and `adapters/home.ts` holds as before; likewise `HomeBridge`.

### 3.3 One-off before/after replay comparison (not committed)

The verification criterion for S9 in 23 §3 is "the request sequence the fake hub receives is byte-identical". Method: a temporary `tsx` script with one in-process fake `fetch` (fixture data, no network) and fixed `now` / `newId` / `sleep` ran the same 44 steps against the old module and against the new entry point, recording the method, path, headers and body of every request and the result or thrown error of every step.

- Steps covered: queries (room, reading, whole home, not found); H1 `/commands` (power, brightness, colour temperature, candidates, invalid value, not configured, unsupported air conditioner, resend after 409 `state_stale`, 5xx, re-read after unconfirmed); AIFA (power off, temperature, fan up, out of range, heating, 429 cooldown, `/discover` after a stale list, a non-air-conditioner appliance); infrared (volume, power, a missing key, 429 cooldown, keys not synchronised); TV rerouting; confirmation card (needs confirmation, approve, approve again, unknown ID); policy off; 8 commands in a row to trigger the rate limit; 401, malformed data, not configured.
- Result: 44 steps and 105 requests on each side (`GET /api/v1/home` 37, `GET /api/v1/integrations/aifa` 37, `POST …/commands` 15, `POST …/refresh` 1, AIFA `power` 5, `status` 2, `climate` 2, `discover` 1, `POST …/infrared-commands` 5); distribution of result `status`: `confirmed` 12, `unconfirmed` 10, `refused` 13, `ok` 3, `ambiguous` 1, `not_found` 1, `needs_confirmation` 1, thrown `HomeBridgeError` 3.
- The "requests plus results" JSON is 25,179 characters on each side and **exactly the same** (the first 16 hex digits of the SHA-256 are `b8b8f6e22289c2fe` for both).

The script depends on the old code in a temporary folder and is not kept after the run; the reproducible evidence is the existing tests passing unmodified and the commands in §3.4.

### 3.4 Commands and results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Pass |
| Unit and integration tests | `npx vitest run` | 176 test files passed; 3,308 of 3,314 tests passed, 6 skipped; about 72 seconds (a second run after the docs were written: 3,309 passed, 5 skipped, about 101 seconds). No test was added or modified |
| The named existing tests among them | `npx vitest run tests/home-bridge.test.ts tests/integration-home-facade.test.ts tests/home-corner.test.ts tests/http.test.ts tests/realtime-*.test.ts` | 10 files, all 346 tests passed: `home-bridge` 96, `home-corner` 42, `http` 27, `integration-home-facade` 18, `realtime-bridge` 8, `realtime-cost-guard-core` 14, `realtime-cost-guard` 30, `realtime-local-commands` 30, `realtime-routes` 38, `realtime-voice` 43 |
| Architecture guard | `tests/architecture.test.ts` (part of the full suite above) | Pass: 0 cross-layer imports, no new cycle |
| Frontend build | `npx vite build` | Pass; the warning about chunks over 500 kB remains (same as the baseline) |
| Desktop main syntax | `node --check desktop/main.mjs` | Pass |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS |
| Bilingual docs | `node scripts/check-bilingual-docs.mjs` | Pass: 143 documents, 142 complete pairs, 1 inline |
| Whitespace | `git diff --check` | Pass |
| Existing test files unmodified | `git diff --stat main -- prototype/ambient-shell/tests` | No output |

`node scripts/architecture-metrics.mjs` (main → this branch):

| Metric | Before | After |
|---|---|---|
| Source files / lines | 246 / 67,693 | 253 / 67,758 |
| Files over 800 lines | 16 (including `server/home-bridge.ts`, which the script counts as 1,655) | 15 (`bridge.ts` is 637 lines and not on the list) |
| Cross-layer imports | 0 | 0 |
| Import cycles | 4 | the same 4 |
| Modules no test imports directly | 26 | 33 (the 7 extra ones are exactly `server/home/*.ts`: the tests still import through the `server/home-bridge.ts` entry point, and the code they cover has not shrunk) |

## 4. Limits

- **Fake hub fixture only**: the fake hub HTTP server in `tests/home-bridge.test.ts` and the fake `fetch` of §3.3. **No command was sent to the real home hub, an AIFA air conditioner, an infrared appliance or a light**, and nothing was started on a Mac or a Pi.
- George previously confirmed H1 light switching at home verbally; although this batch only moves code, **George should re-confirm light switching at home after the merge** (ideally also one AIFA air-conditioner command and one infrared key). Until then this record only means that the fixture tests pass.
- This is not a product gate; the device-by-device results and measurements for H1 and H1b in docs/12 are still missing.
- The mechanical check of §3.1 compares multisets of lines, not their order; neither the §3.1 nor the §3.3 script is committed, so they cannot be re-run directly later. The 44 steps of §3.3 were picked by hand and are not exhaustive.
- The 24 internal symbols the entry point does not re-export (§2.4) can still be imported directly from `server/home/*.ts` by other files; no file does so today, and no guard test prevents it.
- `bridge.ts` is still 637 lines and the `HomeBridge` class is not split; whether to split it further (for example extracting sending and reading) is left to a later batch.
- The number of skipped tests in the full suite depends on the environment (some tests use `describe.skipIf`).
