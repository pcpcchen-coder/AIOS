<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s4-fs-atomic-2026-11-10.md) | [English](architecture-s4-fs-atomic-2026-11-10.en.md)

<a id="架構重整-s4共用原子寫檔-helper2026-11-10"></a>
# Architecture restructuring S4: shared atomic-write helper (2026-11-10)

Companion document: [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md), §P1-3 and S4 in §3. This batch does one thing: it adds `writeAtomic` in `server/fs-atomic.ts` and moves the five simplest "write a temp file, then `renameSync`" callers onto it, **with no behaviour change**. **Everything here is automated tests in a Linux cloud container; it is not a product gate and not real-device acceptance.**

## 1. Environment

- Baseline: `3cc1401` on branch `claude/architecture-review-2026-11`; this batch is on branch `claude/arch-s4-fs-atomic`.
- Linux cloud container (running as root, umask 022), Node.js v22.23.4, vitest 5.0.3, TypeScript 7.0.2, Vite 8.3.4.
- No microphone, camera, Mac, Pi, home controller or TV; no real accounts. The pairing key and cost records are fixture values inside the tests.

## 2. What changed

| File | Change |
|---|---|
| `prototype/ambient-shell/server/fs-atomic.ts` | New. `writeAtomic(path, data, options)`: `data` is a string (UTF-8) or a `Uint8Array`; the steps are always mkdir (when asked) → write the temp file → chmod the temp file (when asked) → rename; a failure throws the original error |
| `server/providers.ts` | `writeJson` became the single line `writeAtomic(path, JSON.stringify(value, null, 2))` |
| `server/proactive.ts` | The inner try/catch in `ProactiveDailyLog.mark` became `writeAtomic(…, { mode: 0o600, removeTempOnError: true })`; `mkdirSync(this.options.dir, …)`, the later `chmodSync`, and the outer catch that only logs stay where they were. `ProactiveSettingsStore` (PrefsFile) in the same file is untouched |
| `server/voice-cost-log.ts` | `write` became `writeAtomic(…, { mode: 0o600, mkdir: 0o700, chmodTemp: true })`; the `slice` that keeps 500 records and the catch that only logs stay where they were |
| `server/lgtv/store.ts` | `writePairing` became `writeAtomic(…, { mode: 0o600, mkdir: 0o700, chmodTemp: true, tempSuffix: ".<pid>.tmp" })`; the later `chmodSync` on the final file (which throws on failure) stays where it was |
| `server/nous.ts` | `memoryEnabledHint().set` became `writeAtomic(…, { mode: 0o600, mkdir: true })` |
| `tests/fs-atomic.test.ts` | New, 26 tests |

The five source files total +18 / -32 lines (net -14). The options of `writeAtomic`:

| Option | Default | Effect |
|---|---|---|
| `mode` | Not given (Node's default 0o666, masked by umask) | Permissions when the temp file is created. If the temp file already exists, `writeFileSync` does not change its permissions |
| `tempSuffix` | `".tmp"` | Temp file name = target path + suffix |
| `mkdir` | Not created | `true`: `mkdirSync(dirname(path), { recursive: true })`; a number: the same with that `mode` |
| `chmodTemp` | Not done | `chmodSync(temp, mode)` before the rename; throws on failure |
| `removeTempOnError` | Not done (the temp file stays) | When the write, chmod or rename fails, `rmSync(temp, { force: true })` first and then throw the original error. A failed mkdir is not cleaned up (there is no temp file yet) |

No fsync, no `O_EXCL`, no random temp name: those belong to the durable writers (class D below) and are not put into this helper. Temp names were not unified: `lgtv/store.ts` keeps `.<pid>.tmp`, and the other four already used `.tmp`. The tests found by `grep -rn "\.tmp" tests` all belong to modules that were not migrated (`alarms`, `voice-settings` / `camera-settings` through `prefs-file.ts`, `memory-store`, `task-vault`, `identity-store`, `wake-runtime-manifest`).

No existing function was reused: `write` at `prefs-file.ts:97` is a private method of `PrefsFile` tied to its data format; `writeJsonAtomic` at `store.ts:1013` is a durable writer with fsync, `O_EXCL` and a random name, and using it for these five callers would change the temp name, the syncing behaviour and the cleanup on failure.

## 3. Semantics table

`grep -rn "renameSync" prototype/ambient-shell/server` finds 16 files at `3cc1401` (two more call sites in `memories-google.ts` move downloaded files and are not settings writes).

### 3.1 The five migrated callers (semantics before the move; identical after it)

| Caller | Temp name | Creates the parent directory | Temp file mode | Content | chmod temp before rename | chmod final file after rename | Temp file on failure | Errors |
|---|---|---|---|---|---|---|---|---|
| `providers.ts` `writeJson` (`settings.json`) | `.tmp` | No | Not specified (0o666 & ~umask) | `JSON.stringify(v, null, 2)`, no trailing newline | No | No | Left behind | Thrown |
| `proactive.ts` `ProactiveDailyLog.mark` (`proactive-log.json`) | `.tmp` | `mkdirSync(options.dir, recursive, 0o700)` (kept at the call site) | 0o600 | `JSON.stringify(v)` (no indentation), no trailing newline | No | Yes, failure swallowed | Removed, then rethrown | The outer catch only logs; nothing is thrown |
| `voice-cost-log.ts` `write` (`voice-cost.jsonl`) | `.tmp` | `dirname(file)`, recursive, 0o700 | 0o600 | The latest 500 lines joined with `\n`, one trailing `\n` | Yes (0o600); a failure lands in the catch | No | Left behind | The catch only logs; nothing is thrown |
| `lgtv/store.ts` `writePairing` (`lgtv.json`) | `.<pid>.tmp` | `dirname(file)`, recursive, 0o700 | 0o600 | `JSON.stringify(v, null, 2)`, no trailing newline | Yes (0o600); throws on failure | Yes; throws on failure | Left behind | Thrown |
| `nous.ts` `memoryEnabledHint().set` (`memory-enabled.json`) | `.tmp` | `dirname(file)`, recursive, Node's default mode | 0o600 | `JSON.stringify({ enabled })`, no trailing newline | No | No | Left behind | Thrown |

All five write a string as UTF-8, and none of them fsyncs.

### 3.2 The eleven that were not migrated

| File | Class | Semantics in short | Why not in this batch |
|---|---|---|---|
| `prefs-file.ts:97` | A | `.tmp`, `mkdir(dir, 0o700)`, 0o600, indent 2, temp removed then rethrown on failure, chmod on the final file afterwards (error swallowed) | Same shape as the daily log in `proactive.ts`, and `writeAtomic` can express it as is; but it is the shared write point of 11 stores and S5 (the PrefsFile store factory) is working in the same area, so it waits until after S5 |
| `alarms.ts:610` | A | Same as above | Explicitly excluded by the task; `alarms.test.ts:253` also depends on the name `alarms.json.tmp` |
| `codex-auth.ts:583` | A | Same as above (sign-in credentials) | Explicitly excluded by the task |
| `chatgpt-auth.ts:508` | B | `.tmp`, no directory creation, 0o600, indent 2, temp left behind on failure, chmod on the final file afterwards | Explicitly excluded by the task (sign-in credentials) |
| `integrations/voice-relay/store.ts:84` | B | `.<pid>.<Date.now()>.tmp`, `mkdir(dir, 0o700)`, 0o600, indent 2 **plus a trailing newline**, temp left behind on failure, thrown | Expressible with `tempSuffix`, but it is not one of the five named in the plan and has no direct test (23 §1.5); left for a later batch |
| `memories-google.ts:215` `save` | B | `.tmp`, no directory creation, 0o600, no indentation, temp left behind on failure, thrown | Expressible, but not one of the five named in the plan; the other two `renameSync` calls in the file (:124, :522) move downloaded files and have nothing to do with settings |
| `store.ts:1013` `writeJsonAtomic` | D | `.tmp-<uuid>`, `O_EXCL` + `O_NOFOLLOW`, 0o600, fsync of the file and the directory, unlink on failure | Durable writer, explicitly excluded by the task |
| `task-migration.ts:157` `writeDurable` | D | Same as above (Buffer) | Same as above |
| `sealed-vault.ts:119` | D | Same as above, plus checkpoint hooks and cleanup in `finally` | Same as above |
| `memory/store.ts:343` | D | Same as above, plus a writer-lock check and checkpoints | Same as above |
| `identity-store.ts:373` | D | Random name inside the directory, `"wx"`, fsync, temp removed on failure | Same as above |

A = same shape as the migrated `proactive.ts`; B = simple but each slightly different; D = durable (fsync, `O_EXCL`, random name). The task brief suggested `voice-cost-log.ts` might be awkward because of rotation: on inspection the rotation is just `slice(-500)` before the write, and the write itself is a plain mkdir → write → chmod → rename, so it was migrated.

## 4. Evidence that behaviour is unchanged

### 4.1 Side by side (old → new)

| Caller | Old (`3cc1401`) | New | Why it is the same |
|---|---|---|---|
| `providers.ts` | `writeFileSync(tmp, s)`; `renameSync(tmp, path)` | `writeAtomic(path, s)` | Without `mode` the helper calls exactly `writeFileSync(tmp, s)` (no options); `mkdir`, `chmodTemp` and `removeTempOnError` are not given, so no step is added |
| `proactive.ts` | `try { writeFileSync(tmp, s, { mode: 0o600 }); renameSync } catch { rmSync(tmp, { force: true }); throw }` | `writeAtomic(path, s, { mode: 0o600, removeTempOnError: true })` | The helper's try/catch is this very block; mkdir stays at the call site, before the helper, so on a mkdir failure neither version reaches rmSync |
| `voice-cost-log.ts` | `mkdirSync(dirname(file), { recursive: true, mode: 0o700 })`; `writeFileSync(tmp, s, { mode: 0o600 })`; `chmodSync(tmp, 0o600)`; `renameSync` | `writeAtomic(file, s, { mode: 0o600, mkdir: 0o700, chmodTemp: true })` | The same four steps in the same order with the same arguments; an error at any step lands in the same catch at the call site |
| `lgtv/store.ts` | Same as above with temp name `${file}.${process.pid}.tmp`; then `chmodSync(file, 0o600)` | `writeAtomic(file, s, { …, tempSuffix: \`.${process.pid}.tmp\` })`; then `chmodSync(file, 0o600)` | The temp name is `path + tempSuffix`, the same string; the final chmod is untouched |
| `nous.ts` | `mkdirSync(dirname(file), { recursive: true })`; `writeFileSync(tmp, s, { mode: 0o600 })`; `renameSync` | `writeAtomic(file, s, { mode: 0o600, mkdir: true })` | `mkdir: true` calls `mkdirSync(dirname(path), { recursive: true })` without a `mode` |

The string expressions the five callers pass in were not changed (check with `git diff 3cc1401 -- prototype/ambient-shell/server`).

### 4.2 Automated comparison

The second `describe` in `tests/fs-atomic.test.ts` reproduces the five old code blocks from `3cc1401` as `legacy` (the lines that write the file are verbatim, but not every block is one original function as it stood: `legacy.voiceCost` is the three methods `record()`, `lines()` and `write()` flattened into one; `legacy.proactive` keeps only the write section, without the log call and without the date and `Set` bookkeeping at the top of `mark()`), runs each of them and the current caller in its own fresh temp directory, and compares the two snapshots (directory mode, every file name, the content as hex, the file mode):

- Normal write, 5 tests: both sides are identical, and the directory holds exactly 1 file (no temp file left behind). Except for `providers.ts` (which never created directories), each starts from a subdirectory that does not exist yet, so the comparison also covers which mode the parent directory is created with.
- A stale 0o644 temp file is already there, 5 tests: both sides give the same result. The two callers with `chmodTemp` (`voice-cost-log.ts`, `lgtv/store.ts`) still end up at 0o600; `providers.ts` and `nous.ts` keep the temp file's 0o644 (as they did before the move); `proactive.ts` reaches 0o600 through its later chmod on the final file. The `voice-cost-log.ts` case writes only once (with two writes the second one creates the temp file afresh and the difference is invisible); with its `chmodTemp` temporarily removed this test fails, which was confirmed and then reverted.
- Target blocked by a non-empty directory (the rename fails), 5 tests: whether an error is thrown and the directory contents after the failure are the same on both sides (`proactive.ts` leaves no temp file and does not throw; `voice-cost-log.ts` leaves the temp file and does not throw; the other three leave the temp file and throw).

No existing test was modified: `voice-cost-log.test.ts`, `proactive.test.ts`, `proactive-calendar.test.ts`, `proactive-http.test.ts`, `integration-lg-tv.test.ts`, and the HTTP / integration tests that go through `ProviderManager.select` and `memoryEnabledHint`, all pass in the full run in section 5.

## 5. Verification results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Passed |
| New tests | `npx vitest run tests/fs-atomic.test.ts` | 1 file, 26 tests passed |
| Unit and integration tests | `npx vitest run` | 173 test files passed; 3,215 of 3,220 tests passed, 5 skipped; 60 s. The baseline is 172 files and 3,194 tests: the extra file and 26 tests are `fs-atomic.test.ts`. The run before the stale-temp cases were added gave 3,209 of 3,215 passed with 6 skipped; the skip count depends on the environment (see section 6) |
| Front-end build | `npx vite build` | Passed; warning that the `zh-tw-opencc` chunk exceeds 500 kB (same as the baseline) |
| Desktop main-process syntax | `node --check desktop/main.mjs` | Passed |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS |
| Bilingual documents | `node scripts/check-bilingual-docs.mjs` | Passed: 138 documents, 137 complete pairs, 1 inline |
| Whitespace | `git diff --check` | Passed |
| Metrics | `node scripts/architecture-metrics.mjs` | `own tmp+rename`: 16 files → 12 files (`providers`, `proactive`, `voice-cost-log`, `lgtv/store` and `nous` dropped out, `fs-atomic` came in; the 12 include the two shared helpers `prefs-file.ts` and `fs-atomic.ts`). Cross-layer imports 0, import cycles 4 and files over 800 lines 16 are all unchanged; server went from 102 to 103 files and from 30,844 to 30,871 lines |

## 6. Limits

- Run only in a Linux container (root, umask 022). macOS has the same permission semantics as Linux but was not measured; Windows has no POSIX permissions, the tests skip the mode assertions there, and nothing was run there.
- The skip count of the full run depends on the environment: two runs in the same container gave 6 and then 5 (`apikey-integration.test.ts` and others use `describe.skipIf(!realLockAvailable)`, and the baseline record noted the same effect); it is unrelated to this batch.
- Running as root means "permission denied" failures were not exercised; the failure cases use "target blocked by a non-empty directory" and "the parent is a regular file".
- The comparison uses one representative input per caller, not every input; "same content" additionally rests on section 4.1: the string expressions passed to the write were not changed.
- The paths where `chmodSync` fails (`voice-cost-log.ts`, `lgtv/store.ts`) are covered only by reading the code side by side, not by an automated test.
- Like the code it replaces, the helper does not fsync: durability across a crash is neither better nor worse.
- This batch does not touch the rest of 23 §P1-3 (page localStorage, duplicated defaults, the desktop copying shared).
- A green test run is only a code check against mocks and fixtures, not G0–G3 or any Mac / Pi gate.
