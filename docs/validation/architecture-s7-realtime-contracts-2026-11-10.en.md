<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s7-realtime-contracts-2026-11-10.md) | [English](architecture-s7-realtime-contracts-2026-11-10.en.md)

# Architecture restructuring S7: realtime contracts and the ApiKeyRoute move (2026-11-10)

Companion document: §P2-7 and S7 in §3 of [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md); the guard rules are in [Architecture guard test S2](architecture-guard-2026-11-10.en.md). This batch only moves declarations; **the goal is zero behaviour change**. Everything here is type checking, static measurement, and automated fixture / mock tests in a cloud container; **it is not a product gate and not Mac / Pi real-device acceptance; no real realtime voice call was made**.

## 1. Environment and scope

- Branch `claude/arch-s7-realtime-contracts`, based on main `1b61d08`; not merged, not pushed. George approved S6–S9 on 2026-11-10.
- Linux cloud container, Node.js v22.23.4, vitest 5.0.3, esbuild 0.28.2. `prototype/ambient-shell/node_modules` is a symlink to the main checkout and is not committed. No microphone, camera, Mac, Pi, OpenAI or ChatGPT connection.
- 2 new files: `server/realtime-contracts.ts` (176 lines), `server/apikey-route.ts` (70 lines).
- 8 source files modified: `server/realtime-routes.ts` (1,275 → 1,083 lines), `server/apikey-call.ts`, `server/codex-auth.ts`, `server/live-route.ts`, `server/live-tool-caller.ts`, `server/memory/live.ts`, `server/web-search.ts`, `shared/web-search.ts`. The first four small files and `memory/live.ts` each change only one import path line.
- 1 test file modified: `tests/architecture.test.ts`, only its allowlist, cap constants and comments. No other test file was modified.
- `server/app.ts` and `server/nous.ts` are **not modified**: when `createApp` gets no `realtimeRoutes` it still does `new ApiKeyRoute(...)` itself, and its import path is still `./realtime-routes.ts` (see section 7 for the differences from the plan).

## 2. The cycle before the move: 8 files, 15 edges

Baseline: main `1b61d08`. A "cycle" is a strongly connected component of the import graph. The table lists every import inside the component (file names omit `server/`).

| # | From | To | Values (runtime) | Type-only |
|---|---|---|---|---|
| 1 | `realtime-routes` | `apikey-call` | `connectApiKey` | `ApiKeyBridge` |
| 2 | `realtime-routes` | `proactive-calendar` | — | `CallFollowUp` |
| 3 | `realtime-routes` | `memory/live` | — | `LiveMemoryPort` |
| 4 | `realtime-routes` | `web-search` | `WEB_SEARCH_TIMEOUT_MS` | — |
| 5 | `apikey-call` | `realtime-routes` | `RouteStartError` | `CallCloseReason`, `RouteCall`, `SessionContext` |
| 6 | `apikey-call` | `proactive-calendar` | `SCHEDULE_MARKER` | `CallFollowUp` |
| 7 | `apikey-call` | `memory/live` | `delegatePolicy`, `MAX_RECALLS` | `LiveCallPort`, `LiveMemoryPort`, `RevokeWhy` |
| 8 | `codex-auth` | `realtime-routes` | — | `Readiness` |
| 9 | `codex-responses` | `codex-auth` | `CodexUnauthorized`, `NOUS_ORIGINATOR` | `CodexAuth` |
| 10 | `live-tool-caller` | `codex-responses` | `CodexError` | `CodexInputItem`, `CodexResponses`, `CodexToolSpec`, `FunctionToolSpec` |
| 11 | `live-tool-caller` | `memory/live` | `delegatePolicy`, `DELEGATE_ONCE_OUTPUT`, `exactVoiceConfirm`, `MAX_RECALLS` | `VoiceDelegatePort` |
| 12 | `live-tool-caller` | `realtime-routes` | `HOST_TIMEOUT_MS`, `HostGone` | `ApprovalSnapshot`, `ToolHost` |
| 13 | `memory/live` | `live-tool-caller` | — | `LiveCallerMemory` |
| 14 | `proactive-calendar` | `memory/live` | `CONFIRM_AFTER_MS`, `ECHO_WINDOW_MS`, `exactYesNo`, `normalizeSpoken`, `readsQuestion` | — |
| 15 | `web-search` | `codex-responses` | `CodexError` | `CodexResponses` |

The runtime cycle is edges 1 and 5 (`realtime-routes` ↔ `apikey-call`, values in both directions). The other back-edges into `realtime-routes` or `live-tool-caller` (edges 8 and 13) are type-only.

## 3. The edges after the move

| # | After | Note |
|---|---|---|
| 1 | `realtime-routes` → `apikey-route` (re-exports the value `ApiKeyRoute` and the type `ApiKeyRouteOptions`); `apikey-route` → `apikey-call` (value `connectApiKey`, type `ApiKeyBridge`) | `realtime-routes` no longer imports `apikey-call` directly |
| 2 | `apikey-route` → `proactive-calendar` (type `CallFollowUp`) | Follows `ApiKeyRouteOptions` |
| 3 | `apikey-route` → `memory/live` (type `LiveMemoryPort`) | Follows `ApiKeyRouteOptions` |
| 4 | `realtime-contracts` → `shared/web-search` (value `WEB_SEARCH_TIMEOUT_MS`); `web-search` → `shared/web-search` (the same constant, still re-exported) | `realtime-routes` no longer imports `web-search` |
| 5 | `apikey-call` → `realtime-contracts` (the same 4 names) | **Back-edge gone** |
| 8 | `codex-auth` → `realtime-contracts` (type `Readiness`) | **Back-edge gone** |
| 12 | `live-tool-caller` → `realtime-contracts` (the original 4 names plus the type `LiveCallerMemory`) | **Back-edge gone** |
| 13 | `memory/live` → `realtime-contracts` (type `LiveCallerMemory`) | **Back-edge gone** |
| 6, 7, 9, 10, 11, 14, 15 | Unchanged | — |
| New | `realtime-routes` → `realtime-contracts` (imports what it uses itself and re-exports all 12 names) | — |
| New | `live-route` → `realtime-contracts` (the same 8 names it used to import from `realtime-routes`; `live-route` was never in the cycle) | Route modules depend only on the contracts |

`realtime-contracts.ts` imports only `shared/` and no `server/` module, so no edge can lead from it back to an upper layer. `apikey-route.ts` does not import `realtime-routes.ts`. The direction is `realtime-routes` → `apikey-route` → `apikey-call` → `realtime-contracts`.

## 4. Which declarations moved

All are verbatim moves (comments included); a script compared them line by line: every line in the new files other than imports and the file header appears in the pre-move source files, and every pre-move line of `realtime-routes.ts` is still in one of the three files (only the 4 import lines that are no longer needed are gone).

| Declaration | Kind | From | To | Re-exported from the old location |
|---|---|---|---|---|
| `Readiness`, `CallCloseReason` | type | `realtime-routes.ts` | `realtime-contracts.ts` | Yes |
| `ApprovalSnapshot`, `SessionContext`, `RealtimeRoute`, `RouteCall`, `LiveControl`, `ToolHost` | interface | `realtime-routes.ts` | `realtime-contracts.ts` | Yes |
| `RouteStartError`, `HostGone` | class | `realtime-routes.ts` | `realtime-contracts.ts` | Yes (the same class object, `instanceof` unchanged) |
| `HOST_REPLY_MARGIN_MS`, `HOST_TIMEOUT_MS` | const | `realtime-routes.ts` | `realtime-contracts.ts` | Yes |
| `ApiKeyRouteOptions` | interface | `realtime-routes.ts` | `apikey-route.ts` | Yes |
| `ApiKeyRoute` | class | `realtime-routes.ts` | `apikey-route.ts` | Yes |
| `LiveCallerMemory` | interface | `live-tool-caller.ts` | `realtime-contracts.ts` | Yes (`export type`) |
| `WEB_SEARCH_TIMEOUT_MS` | const (30_000) | `server/web-search.ts` | `shared/web-search.ts` | Yes |

Left in `realtime-routes.ts`: `EnforcedEndReason`, `CORE_CAP_GRACE_MS`, `ALIVE_TIMEOUT_MS`, `unknownOutput`, `hostTimeoutOutput`, `planStart`, `planFallback`, `FallbackRequired`, `SessionError`, `RealtimeSessions` and so on (used only by the session owner and `app.ts`; lower-level modules do not need them).

Why `WEB_SEARCH_TIMEOUT_MS` moved too: the `web_search` entry of `HOST_TIMEOUT_MS` needs it. If the contracts file imported `server/web-search.ts`, the import graph would keep a 4-file cycle `realtime-contracts` → `web-search` → `codex-responses` → `codex-auth` → `realtime-contracts` (the last hop is the `Readiness` type). The constant's value and comment are unchanged, and `server/web-search.ts` still exports the same name.

## 5. Measurement: the cycle list before and after

Command: `node scripts/architecture-metrics.mjs` (at the repo root).

Before (main `1b61d08`): `import cycles: 4`

```
shared/realtime-route.ts <-> shared/types.ts <-> shared/voice-cost.ts
server/apikey-call.ts <-> server/codex-auth.ts <-> server/codex-responses.ts <-> server/live-tool-caller.ts <-> server/memory/live.ts <-> server/proactive-calendar.ts <-> server/realtime-routes.ts <-> server/web-search.ts
server/memories-google.ts <-> server/memories.ts
src/api.ts <-> src/realtime-session.ts <-> src/realtime-tools.ts <-> src/realtime.ts
```

After: `import cycles: 3`

```
shared/realtime-route.ts <-> shared/types.ts <-> shared/voice-cost.ts
server/memories-google.ts <-> server/memories.ts
src/api.ts <-> src/realtime-session.ts <-> src/realtime-tools.ts <-> src/realtime.ts
```

The 8-file server component is gone entirely (not just smaller). Other numbers: source files 246 → 248; cross-layer imports still 0; files over 800 lines still 16 (`realtime-routes.ts` has 1,083 lines and is still on that list; for information only, not a limit).

The guard test's allowlist was tightened to match: the server entry was deleted; the shared entry lost `shared/seconds-menu.ts`, which no longer exists (S3 renamed it to `menu-prefs.ts` and it left the cycle). `MAX_ALLOWED_CYCLES` 4 → 3, `MAX_ALLOWED_CYCLE_FILES` 18 → 9. If these 8 files grow back into any cycle, the test fails.

## 6. Verification results

| Check | Command (location) | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` (`prototype/ambient-shell`) | Pass, no output |
| Unit and integration tests | `npx vitest run` (same) | 176 test files passed; 3,314 tests in total, run twice: the first run had 3,308 passed and 6 skipped (68 s), the rerun after the documents were written had 3,309 passed and 5 skipped, with no failures in either (the skip count depends on the environment, see the baseline record). Apart from the allowlist and caps in `architecture.test.ts`, no existing test file was modified |
| Frontend build | `npx vite build` (same) | Pass; the existing chunk-over-500-kB warning is unchanged |
| Desktop main syntax | `node --check desktop/main.mjs` (same) | Pass |
| Desktop core bundle | Bundled `server/nous.ts` to a temp file outside the repo with the same esbuild options as `desktop/scripts/build.mjs` (`bundle`, `platform: node`, `format: esm`, `target: node24`, the same banner) | esbuild 0.28.2, 0 warnings, 0 errors; `node --check` passes; after importing the file `typeof startNous` is `function`; `RouteStartError`, `HostGone` and `ApiKeyRoute` each have exactly one definition in the bundle. `desktop/node_modules` does not exist, so `build.mjs` itself was not run (it also calls vite and copies Electron files) |
| Load order | `npx tsx -e "import('./server/nous.ts').then(m=>console.log(typeof m.startNous))"` (same) | Prints `function` |
| Isolated mock flow | `node scripts/verify-aios.mjs` (repo root) | PASS. The rpi4 terminal kit dry-run is a partial run (the report notes the skip), the same as in earlier records |
| Metrics script | `node scripts/architecture-metrics.mjs` (repo root) | Cycles 4 → 3 (see section 5) |
| Bilingual docs | `node scripts/check-bilingual-docs.mjs` (repo root) | Pass |
| Whitespace | `git diff --check` (repo root) | Pass |

## 7. Differences from the plan

- The plan says "`app.ts` no longer does `new ApiKeyRoute`, `nous.ts` injects it". This batch **did not do that**: tests rely on the default when `createApp` gets no `realtimeRoutes`, so, following the risk note in the plan, the default stays and only the class moved. `app.ts` and `nous.ts` are unmodified and still import `ApiKeyRoute` from `./realtime-routes.ts`.
- The plan estimated about 60 fewer lines in `realtime-routes.ts`; it is 192 fewer (1,275 → 1,083), because the contract declarations moved out as well.
- The plan mentions only `realtime-routes` ↔ `apikey-call`. Two more verbatim moves of the same kind were made, otherwise the 8-file component would only shrink rather than disappear: `LiveCallerMemory` (the type back-edge `memory/live` → `live-tool-caller`) and `WEB_SEARCH_TIMEOUT_MS` (see section 4). The latter touches `shared/web-search.ts` (one more constant).
- The import path in `live-route.ts` also changed to the contracts file (one line). It was never in the cycle; this only makes both route modules depend on the contracts alone.

## 8. Limitations

- Only fixture / mock tests and static measurement in a cloud container. No Mac, Pi, microphone or speaker, no connection to OpenAI or ChatGPT, and **no real realtime voice call was made** (neither the API key route nor the ChatGPT plan route). The basis for "zero behaviour change" is: the declarations are line-for-line identical, type checking passes, and existing tests pass unchanged; it is not a real-device observation.
- The desktop App was not actually packaged or launched; only the single esbuild bundle of the core was verified to build, parse and import.
- `realtime-routes.ts` still re-exports `ApiKeyRoute`, so importing `realtime-routes.ts` still loads `apikey-route.ts` and `apikey-call.ts` (one direction, no cycle). Removing that dependency means changing the imports in `app.ts`, `nous.ts` and tests, which is left to a later batch.
- The metrics script finds relative imports with regular expressions and counts type-only imports as edges; the limitations are those of section 6 of the [guard test record](architecture-guard-2026-11-10.en.md). The precise meaning of "the cycle is gone" is: these 8 files no longer belong to any strongly connected component of two or more files.
- The other 3 cycles (the shared type cycle, `memories` ↔ `memories-google`, the 4-file page cycle) were not addressed.
- Not G0–G3 or any Mac / Pi gate; it does not change the status of any "to be implemented" item in the README.
