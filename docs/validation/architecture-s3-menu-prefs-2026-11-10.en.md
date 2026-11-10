<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s3-menu-prefs-2026-11-10.md) | [English](architecture-s3-menu-prefs-2026-11-10.en.md)

# Architecture restructuring S3: `shared/seconds-menu.ts` renamed to `shared/menu-prefs.ts` (2026-11-10)

Companion document: [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md) §P2-7, §P3-11, and S3 in §3. **A pure rename plus type moves with no behaviour change; everything here is static checks and automated tests in a cloud container; it is not a product gate and not real-device acceptance.**

## 1. Environment

- Baseline: `3cc1401` on branch `claude/architecture-review-2026-11`; this batch is on branch `claude/arch-s3-menu-prefs`, not yet merged.
- Linux cloud container, Node.js v22.23.4; dependencies reuse the baseline `node_modules` (vitest 5.0.3, TypeScript 7.0.2, Vite 8.3.4).
- No microphone, camera, Mac, Pi, home controller, or TV; no real accounts; the Electron App was not launched.

## 2. What moved

- `git mv prototype/ambient-shell/shared/seconds-menu.ts prototype/ambient-shell/shared/menu-prefs.ts`; the file header notes the rename from `seconds-menu.ts`.
- Import paths changed to `menu-prefs.ts`: source files `server/app.ts`, `src/terminal-camera.ts`, `shared/voice-commands.ts`, `desktop/settings-menu.d.mts`; tests `prefs`, `desktop-menu`, `settings-view`, `http`, `backend-i18n`, `desktop-i18n`, `service-mode` (7 `*.test.ts` files, only the import line changed). The comment in `desktop/settings-menu.mjs` and the prototype README structure tree (Chinese and English) follow the new file name.
- New file `shared/menu-prefs-types.ts` (types only): `CameraSecondsKey`, `SecondsKey`, `FactorKey`, `CameraBoolKey`, `MenuNumberKey`, `MenuPrefKey`, `MenuPrefOption`, `MenuRowFields` (not exported), `MenuNumberSetting`, `MenuBoolSetting`, `MenuPrefSetting`, `SecondsOption`, `SecondsSetting` moved in unchanged; `menu-prefs.ts` re-exports them unchanged with `export type { … } from "./menu-prefs-types.ts"`, so no other importer has to change.
- `shared/types.ts` now imports `MenuPrefSetting` from `menu-prefs-types.ts` (the only existing importer whose import source changed).
- Not changed: exported identifiers (`describeMenuPrefs`, `describeSeconds`, `SecondsSetting`, `SecondsSource`, `SettingsView.seconds`, and so on), the three disabled-reason strings, function bodies, HTTP and SSE content. Historical validation records and the problem descriptions in docs/15 and docs/23 keep the old file name; docs/23 only gains dated notes at §P3-11 and the S3 row.

### Why the types did not go into `shared/prefs.ts` as planned

The plan said "move the `MenuPrefSetting` type into `shared/prefs.ts`". The keys of this type family are derived from `typeof CAMERA_PREFS` (`shared/sense.ts`) and `VoicePrefs` (`shared/voice-prefs.ts`), and both of those files import `prefs.ts`; moving the types into `prefs.ts` would add a cycle between `prefs.ts` and `sense.ts`, `voice-prefs.ts`. A separate types-only file achieves the same goal (`types.ts` no longer imports `menu-prefs.ts`) without adding a cycle.

## 3. Import cycles: before and after

Command: `node scripts/architecture-metrics.mjs` (read-only; includes type-only imports).

Before (`3cc1401`), 4 cycles; the shared one was:

```
shared/realtime-route.ts <-> shared/seconds-menu.ts <-> shared/types.ts <-> shared/voice-cost.ts
```

After, still 4 cycles; the shared one has one member fewer:

```
shared/realtime-route.ts <-> shared/types.ts <-> shared/voice-cost.ts
```

The other three are unchanged:

```
server/apikey-call.ts <-> server/codex-auth.ts <-> server/codex-responses.ts <-> server/live-tool-caller.ts <-> server/memory/live.ts <-> server/proactive-calendar.ts <-> server/realtime-routes.ts <-> server/web-search.ts
server/memories-google.ts <-> server/memories.ts
src/api.ts <-> src/realtime-session.ts <-> src/realtime-tools.ts <-> src/realtime.ts
```

`menu-prefs.ts` still imports `RealtimeBaseInfo` from `types.ts` (one direction), and `types.ts` no longer imports it, so it has left the cycle.

**The remaining `types.ts` ↔ `realtime-route.ts` ↔ `voice-cost.ts` cycle was not addressed:** `realtime-route.ts` takes `Task` from `types.ts` (which drags along `TaskStep`, `TaskStatus`, `ExecutorMode`, `ErrorAction`, and the rest of that family), `types.ts` takes `RealtimeRouteFields` and `RealtimeServerEvent` from `realtime-route.ts`; `voice-cost.ts` takes `RouteId` (derived from the constant `ROUTE_IDS`), and `realtime-route.ts` takes `VoiceUsage`. Fully breaking it means moving the `Task` type family or splitting `realtime-route.ts`, which is beyond "move two or three type declarations", so it is left for a later batch.

The other numbers from the metrics script change only because there is one more file: source files 241 → 242, shared 38 → 39 files, modules without a direct test import 26 → 27 (the extra one is the types-only `shared/menu-prefs-types.ts`). Cross-layer imports are still 0 and files over 800 lines are still 16.

## 4. Evidence of no behaviour change

- Tests are unchanged apart from import paths and all pass (see §5). Tests that call `describeMenuPrefs` / `describeSeconds` directly: `tests/prefs.test.ts` (24 references, covering each row's key, options, labels, disabled reasons, and the `describeSeconds` filter), `desktop-menu.test.ts`, `settings-view.test.ts`, `backend-i18n.test.ts`, `desktop-i18n.test.ts`, `service-mode.test.ts`; `http.test.ts` checks them indirectly through `SettingsView.seconds` from `/api/settings` and `isNumberRow`.
- One-off comparison (script deleted after use, not committed): the `seconds-menu.ts` from `3cc1401` and the new `menu-prefs.ts` were loaded side by side; for 48 inputs (8 camera settings × 3 realtime states × 2 voice-writable states), `describeMenuPrefs` and `describeSeconds` were each called (96 outputs) plus `cameraPreviewDisabledReason`, and the SHA-256 of the JSON serialization is identical (`15ccccafe87c4213…`); the two modules' runtime export name lists are identical (7 names).
- `tests/__snapshots__/` contains only `wake-flag-off.test.ts.snap` and does not embed the old file name; `desktop/scripts/`, `scripts/`, `package.json`, `tsconfig*.json`, `vite.config.ts`, and `spike/` do not reference the old file name.

## 5. Commands and results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Passed |
| Type check (with spikes) | `npm run typecheck` | Passed (three tsconfigs: main project, `spike/face`, `spike/wake`) |
| Unit and integration tests | `npx vitest run` | 172 test files passed; 3,188 of 3,194 tests passed, 6 skipped; 53 s (same file and test counts as the baseline) |
| Frontend build | `npx vite build` | Passed; same chunk-over-500 kB warning as the baseline |
| Desktop main syntax | `node --check desktop/main.mjs` | Passed |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS |
| Bilingual docs | `node scripts/check-bilingual-docs.mjs` | Passed (rerun after `--record`) |
| Whitespace | `git diff --check` | Passed |
| Import cycles | `node scripts/architecture-metrics.mjs` | See §3 |

## 6. Limits

- The Electron App was not launched and the menu bar was not viewed on a Mac; menu-bar rendering is covered only by the existing tests such as `desktop-menu.test.ts`.
- The one-off comparison in §4 is not part of the test suite; the lasting guarantee is the existing tests.
- The shared type cycle only shrank, it did not disappear; there are still 4 cycles.
- Identifiers that keep "seconds" (`SettingsView.seconds`, `describeSeconds`, `SecondsSetting`, and so on) are API names and were not changed in this batch.
