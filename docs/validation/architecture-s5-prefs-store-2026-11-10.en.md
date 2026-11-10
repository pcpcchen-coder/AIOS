<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s5-prefs-store-2026-11-10.md) | [English](architecture-s5-prefs-store-2026-11-10.en.md)

# Architecture restructuring S5: shared base for settings stores (2026-11-10)

Companion document: §P1-3 and S5 in §3 of [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md). This batch only moves duplicated boilerplate; **the goal is zero behaviour change**. Everything here is type checking plus automated fixture / mock tests in a cloud container; **it is not a product gate and not Mac / Pi real-device acceptance**.

## 1. Environment

- Branch `claude/arch-s5-prefs-store`, based on `3cc1401` of `claude/architecture-review-2026-11` (main `416a1ab` plus the architecture review documents).
- Linux cloud container, Node.js v22.23.4, vitest 5.0.3, TypeScript 7.0.2, Vite 8.3.4. `prototype/ambient-shell/node_modules` is a symlink to the main checkout and is not committed.
- No microphone, camera, Mac, Pi, hub or TV; no real account of any kind.

## 2. What was done

Added `prototype/ambient-shell/server/prefs-store.ts` (41 lines): a base class `PrefsStore<S, O>` holding only the three things that were word-for-word identical across the 11 stores.

| Member | What it does | Boilerplate it replaces |
|---|---|---|
| `constructor(spec, options)` | Builds the `PrefsFile` from `spec` (`name`, `parse`, `failClosed`, `unreadable`) plus `options.dir`, `options.log` and `version: 1` | The 10-line `new PrefsFile({...})` and the `private readonly file` field in every store |
| `protected resolve(keys, defaults)` | In the order of `keys`, takes "saved value `??` default" for each key | `Object.fromEntries(KEYS.map((key) => [key, saved[key] ?? DEFAULTS[key]])) as unknown as P` |
| `protected commit(patch)` | Calls `this.file.update(patch)` and then `this.options.onChange()` | Those two lines in every `update()` |

There are no hooks and no option switches. The shape of `view()`, the rules and return value of `update()`, and any extra methods stay in each store. `prefs-file.ts` was not modified, so reading, per-key validation, fail closed, atomic writes, the 0600 mode and the log strings are still the same code.

**Difference from the wording in 23 §3**: the plan described a `createPrefsStore(spec, file, defaults)` factory with a one-line export left in each file. After reading all 11 stores, only 2 of them (`voice`, `memories`) have a `view()` / `update()` with no logic of their own; a factory covering the other 9 would need several hooks. So this became a base class with two helpers, and each store keeps its own class.

### 2.1 Store-by-store inventory

In common: every constructor takes `dir`, `onChange()` and `log?`; `schema_version` is always 1; every `update()` is "write the file first, and only after it succeeds update memory and call `onChange`", **without comparing whether the value changed — every successful write calls it once**; a failed write throws and does not call `onChange`. "Unreadable" has no state field of its own: `PrefsFile` logs one line (`無法讀取 <path>（<reason>），<unreadable>`) and applies `failClosed`, and the file is left in place, not overwritten, until the next `update()`.

| Store (file) | Settings file | Extra constructor args | Source of defaults | `failClosed` | `unreadable` string | `view()` | `update()` and other methods |
|---|---|---|---|---|---|---|---|
| `ClockSettingsStore` (`clock-settings.ts`) | `clock.json` | None | `DEFAULT_CLOCK_PREFS` | `{}` | 右上角時鐘用預設值 | `view(source)` returns `{ enabled, prefs, write_path }`, where `enabled` depends on whether the source is main or terminal; also has `prefs()` | `update()` returns `prefs()` (not `view()`) |
| `HomeCornerSettingsStore` (`home-corner-settings.ts`) | `home-corner.json` | None | `DEFAULT_HOME_CORNER_PREFS` | `{}` | 左上角家中狀態用預設值 | Same as clock | Same as clock |
| `VoiceSettingsStore` (`voice-settings.ts`) | `voice.json` | None | `DEFAULT_VOICE_PREFS` | `{}` | 語音閒置秒數用預設值 | Saved values over defaults | Writes directly, returns `view()` |
| `MemoriesSettingsStore` (`memories.ts`) | `memories.json` | None | `DEFAULT_MEMORIES_PREFS` | `{ enabled: false }` | 回憶模式保持關閉 | Saved values over defaults | Writes directly, returns `view()` |
| `AudioSettingsStore` (`audio-settings.ts`) | `audio.json` | None | `DEFAULT_AUDIO_PREFS` | `{ ...DEFAULT_AUDIO_PREFS }` | 聲音輸入與輸出都用系統預設 | Saved values over defaults | When a device id is set back to `null`, the matching label is written as `null` too |
| `WakeSettingsStore` (`wake-settings.ts`) | `wake.json` | None (only constructed when `NOUS_WAKE=on`) | `DEFAULT_WAKE_PREFS` | `{ wake_listen: false, device_id: null, voice_name_test: false, speaker_in_call: false }` | 常駐喚醒聆聽保持關閉 | Saved values over defaults | While the switch is off (or is being turned off), `device_id` is written as `null` |
| `RealtimeSettingsStore` (`realtime-settings.ts`) | `realtime.json` | `defaults` (from `.env`) | `options.defaults` | `{}` | 即時語音的路徑偏好用預設值 | `{ ...defaults, ...saved }` (a spread, not per-key `??`) | Writes directly, returns `view()` |
| `CameraSettingsStore` (`camera-settings.ts`) | `camera.json` | `base` (`loadConfig().camera`) | `options.base` | `{ active: false }` | 鏡頭保持關閉；其他設定用 .env 與預設值 | Install settings (always from `.env`) plus saved values over `base` | Writes directly, returns `view()` |
| `FaceTuningStore` (`face-tuning-settings.ts`) | `face-tuning.json` | `now?()` | `DEFAULT_FACE_TUNING` | `{}` | 人臉辨識校正值用預設 | Adds `customized` and `calibrated_at`; if the set as a whole is unreasonable, the whole set falls back to defaults | `update(patch, calibrated)` first checks the merged set and records the time when `calibrated`; `reset()` uses `file.replace({})` |
| `DayNightSettingsStore` (`day-night-settings.ts`) | `day-night.json` | `now?` | `DEFAULT_DAY_NIGHT_PREFS` | `{}` | 日夜間模式用預設值 | `{ prefs, override, saved, core_mode, write_path }`; also has `prefs()`, `override()`, `coreMode()` | An `override` of day / night computes its end time from `scope`, and `auto` is written as `null`; the stored shape has one more key, `override`, than the prefs |
| `ProactiveSettingsStore` (`proactive.ts`) | `proactive.json` | None | `DEFAULT_PROACTIVE_PREFS` | `{}` | 主動提醒用預設值 | Saved values over defaults; when start ≥ end the window falls back to defaults | First checks the merged window; if invalid, throws `ProactivePatchError` and does not write |

### 2.2 Migration result and line counts

All 11 were migrated. The base only provides construction and two helpers, so the change in every store is replacing the same few lines with one line; no option was added for any single store.

| Store | Migrated | Base members used | What stays in the store | Lines (before → after, `wc -l`) |
|---|---|---|---|---|
| `clock-settings.ts` | Yes | Construction, `resolve`, `commit` | `view(source)`, `update()` returning `prefs()` | 40 → 28 |
| `home-corner-settings.ts` | Yes | Construction, `resolve`, `commit` | Same as above | 40 → 28 |
| `voice-settings.ts` | Yes | Construction, `resolve`, `commit` | No extra logic | 39 → 27 |
| `memories.ts` (`MemoriesSettingsStore`) | Yes | Construction, `resolve`, `commit` | No extra logic | 254 → 242 |
| `audio-settings.ts` | Yes | Construction, `resolve`, `commit` | Label cleared together with the id | 49 → 37 |
| `wake-settings.ts` | Yes | Construction, `resolve`, `commit` | No microphone recorded while the switch is off | 48 → 36 |
| `realtime-settings.ts` | Yes | Construction, `commit` | `view()` is still `{ ...defaults, ...saved }`. It was not switched to `resolve`: a spread and per-key `??` are not guaranteed identical for a saved `null` or for key order, and proving it is not worth saving one line | 41 → 30 |
| `camera-settings.ts` | Yes | Construction, `resolve`, `commit` | Merging the install settings with `base` | 58 → 46 |
| `face-tuning-settings.ts` | Yes | Construction, `resolve`, `commit` | Whole-set check, `calibrated_at`, and `reset()` calling `this.file.replace({})` directly | 85 → 74 |
| `day-night-settings.ts` | Yes | Construction, `commit` | `prefs()` still spells out each key (`shared/day-night.ts` has no key list, and none was added for this), plus all of the manual-override logic | 76 → 66 |
| `proactive.ts` (`ProactiveSettingsStore`) | Yes | Construction, `resolve`, `commit` | Window check | 323 → 311 |
| Total | 11 / 11 | | | 1,053 → 925 (−128); with the 41 lines of `prefs-store.ts`, net −87 |

Unchanged from the outside for every store: exported class and type names, constructor arguments, public method signatures, and every user-visible string (`unreadable` and the error messages are byte-identical; `server/messages.en.json` was not modified). The only TypeScript-level difference is that `file` and `options` went from `private` to `protected` (they are held by the base class); no public member was added.

## 3. Verification

### 3.1 New tests

`tests/prefs-store.test.ts`, 21 tests, all in `mkdtempSync` temporary directories:

- `PrefsStore` (using a minimal store defined in the test, 16 tests): defaults when there is no file, key order following `keys`, no file created; the JSON written by `update` compared character by character (2-space indent, no trailing newline), file mode 0600, directory mode 0700, no `.tmp` left behind; sending the same patch again leaves the file unchanged but still calls `onChange`; a saved `null` counts as not saved; `resolve` does not carry extra keys from `defaults`; per-key validation (bad keys dropped and logged, keys present in `failClosed` take the `failClosed` value, the rest are used); all 6 kinds of unreadable file fail closed, log one line and **do not overwrite the file**; the first `update` after an unreadable file writes `failClosed` with the patch on top; with `failClosed` set to `{}` it falls back to defaults; a failed write throws, leaves memory unchanged and does not call `onChange`; without `log` it uses `console.warn`; and the bytes, mode and log string written by the real `ClockSettingsStore`.
- Direct `PrefsFile` tests (5 tests; no test imported this module directly before): `path` and an empty `saved`; `update` merging and `schema_version`, with a version mismatch treated as unreadable; `replace` swapping the whole content and copying the object passed in; `saved` being a copy of `failClosed` when unreadable; and an existing file with a wider mode being brought back to 0600 after a write.

The expected file contents were derived from the pre-refactor code: `JSON.stringify({ schema_version: 1, prefs }, null, 2)`, `writeFileSync(tmp, …, { mode: 0o600 })`, `renameSync`, `chmodSync(path, 0o600)`.

### 3.2 One-off before/after comparison (not committed)

The pre-refactor `server/` and `shared/` were extracted into a temporary directory with `git archive HEAD`, and a temporary vitest test fed the same inputs to the 11 stores before and after the refactor, comparing: the `JSON.stringify` result of every read method, the return value of every `update` / `reset` or the class and message of the error thrown, the log strings (with the temporary path replaced by a fixed word), the full text and mode of the settings file, the running count of `onChange` calls, and what a freshly constructed store reads back.

- Starting files: 7–8 kinds per store (no file, 4 kinds of unreadable content, 2–3 kinds of content mixing valid and invalid keys).
- Write sequences: 2–5 steps per store, including writes that get rejected (the face-tuning distance range, the proactive time window).
- Result: all 11 stores identical, **1,450** observations compared in total (the test accumulates `before.length` and prints it); the only errors thrown were the two expected ones ("辨識的最遠距離要比最近距離遠至少 0.3 m" and "時段的開始要早於結束").

That test depends on the old code in a temporary directory, was deleted after running, and is not in the repo; the reproducible evidence is the tests in §3.1 and the existing tests passing without modification.

### 3.3 Commands and results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Passed |
| Unit and integration tests | `npx vitest run` | 173 test files passed; 3,210 of 3,215 tests passed, 5 skipped; 50 s. That is 1 file and 21 tests more than the baseline (exactly `tests/prefs-store.test.ts`). The skip count depends on the environment (the baseline record shows 6 or 5) |
| Front-end build | `npx vite build` | Passed; the warning about a chunk over 500 kB remains (same as the baseline) |
| Desktop main syntax | `node --check desktop/main.mjs` | Passed |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS |
| Bilingual documents | `node scripts/check-bilingual-docs.mjs` | Passed: 138 documents, 137 complete pairs, 1 inline |
| Whitespace | `git diff --check` | Passed |
| No existing test file modified | `git diff --stat` | Under `tests/`, only the new `prefs-store.test.ts` |

The existing tests listed for S5 in 23 §3 (`audio-` / `camera-` / `clock-` / `voice-` / `wake-settings`, `camera-prefs`, `prefs`, `day-night-mode`, `home-corner`, `memories-http`, `memories-google`, `proactive`, `proactive-calendar`, `apikey-integration`, `live-integration`, `http`, `backend-i18n`) are all part of the full run above and pass without modification.

## 4. Limits

- Fixture tests in a cloud container only; the app was not started on a Mac or Pi against real `~/.config/nous/*.json` files. The settings file format did not change and no data migration is needed, but that conclusion comes from tests and reading the code, not from observation on a real device.
- The comparison in §3.2 was not committed and cannot be re-run directly later; its input combinations were hand-picked, not exhaustive.
- In the repo's existing tests, `face-tuning.json` is still covered only indirectly through `http.test.ts`; this batch did not add a dedicated test for it.
- The `.tmp` clean-up path after a failed `PrefsFile` write was tested with only one kind of failure (`.tmp` already being a directory).
- This batch does not address the other items in 23 §P1-3: the 13 settings routes in `app.ts` (S6), the 15 modules that write files without `prefs-file.ts` (S4), or the second validation on read-back.
- A fully green test run is only a code check; it is not G0–G3 or any Mac / Pi gate.
