<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s6-settings-routes-2026-11-10.md) | [English](architecture-s6-settings-routes-2026-11-10.en.md)

<a id="架構重整-s6設定寫入路由表2026-11-10"></a>
# Architecture restructuring S6: settings write route table (2026-11-10)

Companion document: §P2-6 and S6 in §3 of [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md). This batch only moves the duplicated settings write routes in `server/app.ts`; **the goal is zero behaviour change**. Everything here is type checking plus automated fixture / mock tests in a cloud container; **it is not a product gate and not Mac / Pi real-device acceptance**.

<a id="1-環境"></a>
## 1. Environment

- Branch `claude/arch-s6-settings-routes`, based on main `1b61d08` (which already contains architecture S1–S5). George approved S6–S9 on 2026-11-10.
- Linux cloud container, Node.js v22.23.4, vitest 5.0.3. `prototype/ambient-shell/node_modules` is a symlink to the main checkout and is not committed.
- No microphone, camera, Mac, Pi, home controller or TV; no real account of any kind. The engine is `MockExecutor`, and every settings file lives in a `mkdtempSync` temporary folder.

<a id="2-重整前的盤點"></a>
## 2. Inventory before the change

Before the change, `handleApi` had 13 `POST /api/settings/*` routes after `GET /api/settings`, with 5 other route groups in between (`GET /api/weather/now`, `/api/alarms/*`, `GET /api/home/overview`, `/api/memories/google/*` and `/api/memories/*`).

What the 13 have in common:

- Only `POST` is accepted and the path is matched in full. Host / Origin / Content-Type are checked first by the outermost `checkRequest` (not touched in this batch).
- Success: `200`, the body is the whole settings view `localizeSettings(settings.view(pageSource(X-Nous-Terminal)), normalizeLocale(X-Nous-Locale))`, with headers `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.
- Failure: throws `HttpError(status, message)`; the outermost handler answers `{ "error": localize(message, locale) }` with the same headers; a `500` is also sent to `console.error`.
- Side effects: the route itself does not broadcast. After a successful write the store's `update()` calls `onChange` (→ `notifySettings` → SSE `settings.updated`), once per successful write; nothing is restarted.
- The body is read by `readJson`: more than 16 KiB gives `413 body too large`, anything that is not a JSON object gives `400 body must be a JSON object`, and an empty body counts as `{}`.
- The double validation is untouched: the route parses the patch once, and `PrefsFile` validates key by key again the next time it reads the file.

Route by route (the check in the "store missing" column always happens before the body is read; messages are verbatim and are also the keys of the translation table):

| Path | Store missing | Body and format (400) | Refusal before the write | Store call | Write failure | Uniform? |
|---|---|---|---|---|---|---|
| `/api/settings/provider` | Not checked (always present) | `provider` is not `claude` / `chatgpt` / `mock` → `400 unknown provider` | None | `settings.select(provider)` | Any error → `409` with the error's own message (for example `尚未設定 ANTHROPIC_API_KEY，無法使用 Claude。`); there is no 500 mapping | No: its own handler function |
| `/api/settings/camera` | `409 鏡頭未設定` | `parseCameraPatch`; `CameraPatchError` → 400 with its message | `cameraEnable` is `main_process` and `active === true` → `403 鏡頭只能從 App 打開` (nothing is saved) | `camera.update(patch)` | `500 鏡頭設定沒有保存（無法寫入設定檔：<reason>）` | Uniform plus one "refusal before the write" |
| `/api/settings/camera-tuning` | No `faceTuning`, or `camera.view().enabled` is not true → `409 鏡頭未啟用` | With `reset === true` no other field is parsed; otherwise `calibrated` is removed and the rest goes through `parseFaceTuningPatch`; `FaceTuningError` (from parsing, or from the store checking the merged set) → 400 | None | `faceTuning.reset()`, or `faceTuning.update(patch, calibrated === true)` | `500 校正值沒有保存（無法寫入設定檔：<reason>）` | No: its own handler function |
| `/api/settings/voice` | `409 語音設定未設定` | `parseVoicePatch` / `VoicePatchError` | None | `voice.update(patch)` | `500 語音設定沒有保存（…）` | Uniform |
| `/api/settings/audio` | `409 聲音裝置設定未設定` | `parseAudioPatch` / `AudioPatchError` | None | `audio.update(patch)` | `500 聲音裝置設定沒有保存（…）` | Uniform |
| `/api/settings/wake` | The route does not exist (`NOUS_WAKE` off) → falls through to `404 not found` | `parseWakePatch` / `WakePatchError` | In order: `wake_listen === true` → `403 常駐喚醒聆聽只能從 App 選單列打開`; `voice_name_test === true` → `403 只憑聲音叫名字只能從 App 選單列打開` | `wake.update(patch)` | `500 常駐喚醒聆聽設定沒有保存（…）` | Uniform plus one "refusal before the write" |
| `/api/settings/clock` | The route does not exist → 404 | `parseClockPatch` / `ClockPatchError` | None | `clock.update(patch)` | `500 時鐘設定沒有保存（…）` | Uniform |
| `/api/settings/alarms` | The route does not exist → 404 | The route does not parse; `alarms.updatePrefs(body)` validates by itself, and `AlarmPatchError` → the fixed `400 鬧鐘與定時器的設定值不正確` (without the reason) | None | `alarms.updatePrefs(body)` | `console.warn`, then `500 定時器沒有保存（無法寫入設定檔）` (without the reason) | No: it shares one error-handling block with the nine `/api/alarms/*` action routes |
| `/api/settings/day-night` | The route does not exist → 404 | `parseDayNightPatch` / `DayNightPatchError` | None | `dayNight.update(patch)` | `500 日夜間設定沒有保存（…）` | Uniform |
| `/api/settings/home-corner` | The route does not exist → 404 | `parseHomeCornerPatch` / `HomeCornerPatchError` | None | `homeCorner.update(patch)` | `500 家中狀態設定沒有保存（…）` | Uniform |
| `/api/settings/proactive` | The route does not exist → 404 | `parseProactivePatch` / `ProactivePatchError` | None | `proactive.update(patch)`; a `ProactivePatchError` thrown by the store (after merging, the start is not before the end) is also 400 | `500 主動提醒設定沒有保存（…）` | Uniform plus "the store also throws format errors" |
| `/api/settings/memories` | The route does not exist → 404 | `parseMemoriesPatch` / `MemoriesPatchError` | None | `memories.update(patch)` | `500 回憶模式設定沒有保存（…）` | Uniform |
| `/api/settings/realtime` | `409 即時語音路徑設定未設定` | `parseRealtimePatch` / `RealtimePatchError` | None | `realtimePrefs.update(patch)` (only affects the next call that starts) | `500 即時語音設定沒有保存（…）` | Uniform |

Seven are fully uniform (voice, audio, clock, day-night, home-corner, memories, realtime); camera, wake and proactive each do one extra thing; provider, face tuning and alarms have logic of their own.

Noticed in passing and **not changed in this batch**: `校正值沒有保存（無法寫入設定檔：{0}）` is not in the English translation table, so the English interface receives Chinese for it (the other 10 sentences and the alarms one are translated). The new test records the current behaviour; adding the translation needs a separate batch.

<a id="3-做了什麼"></a>
## 3. What was done

| File | Content |
|---|---|
| `server/routes/settings.ts` (new, 227 lines) | The route table `ROUTES` (`Map<path, handler>`, 12 routes) and `findSettingsWrite(method, path)`. The uniform kind is produced by `patchRoute(spec)`: `store`, `missing` (a string = the 409 message, `null` = the route does not exist), `parse`, `PatchError`, `saveFailed`, plus two optional fields, `refuse` (camera, wake) and `storeValidates` (proactive). Provider and face tuning are their own handler functions in the table, moved as they were. The write-failure mapping is one function, `saveFailed(message, err)`. A handler only returns `true` (written) or `false` (the route does not exist in this assembly); it does not touch `req` / `res`, SSE or the locale. |
| `server/http-error.ts` (new, 6 lines) | `HttpError`, moved out of `app.ts` unchanged. This way `routes/settings.ts` does not have to import `app.ts` (which would add an import cycle). |
| `server/app.ts` | The 12 route blocks become two lines: when `findSettingsWrite(method, path)` finds a handler and it returns `true`, `sendSettings(req, res)`. The whole-settings response is one helper, `sendSettings(req, res, source?)`; the 18 identical expressions and the alarms one (which computes `source` itself) now use it. Unused imports are removed. The logic of `/api/settings/alarms` and of the other route groups is untouched. |

<a id="31-行數"></a>
### 3.1 Line counts

| File | Before (`wc -l`) | After |
|---|---|---|
| `server/app.ts` | 1,368 | 1,173 (−195) |
| `server/routes/settings.ts` | — | 227 |
| `server/http-error.ts` | — | 6 |
| Total | 1,368 | 1,406 (net +38) |

Numbers from `scripts/architecture-metrics.mjs` (its line count is 1 higher than `wc -l`): `app.ts` 1,369 → 1,174; `app.ts repeats: localizeSettings(settings.view(...))` x18 → x0, `same save error` x12 → x1; `app_ts_path_matches` 56 → 49; cross-layer imports 0 → 0; import cycles 4 → 4; modules without a direct test import 26 → 26. The x0 is because the helper spells it `settings.view(source)`, which the script's pattern does not match; the expression really still occurs once in `app.ts` (the helper itself). The x1 is the original alarms sentence; the other 11 sentences are now data in the table in `routes/settings.ts`.

<a id="32-與-23-3-原文的差異"></a>
### 3.2 Differences from the text of 23 §3

- **The table has 12 routes, not 13.** `/api/settings/alarms` shares one `saved()` with the nine `/api/alarms/*` action routes (fixed messages, no reason, `console.warn` first), and its body is validated by `AlarmCenter` itself. Moving it into the table would mean splitting that error handling into two copies or making the alarm action routes import the settings route table, so it stays in `app.ts` and only switches to `sendSettings`.
- **`app.ts` loses 195 lines; the three files together gain 38.** The extra lines are the table's types, comments, and the complete message string kept on every row (not split into "noun + shared ending", so the translation-table keys can still be found in the source).
- **The table is consulted in one place**: after `GET /api/settings`, which is where the first settings route used to be. The 12 routes used to be spread among 5 other route groups; merging them into one place does not change precedence, because all 12 are `POST` plus a full path and none of the routes in between can match those paths (`GET /api/weather/now`, `POST /api/settings/alarms` and the `/api/alarms/` prefix, `GET /api/home/overview`, `/api/memories/google/*`, `GET /api/memories/items`, the `/api/memories/media/` prefix). A handler for a route whose flag is off returns `false`, and the request falls all the way through to the final `404 not found` as before.
- **Three columns `path → store → parsePatch` are not enough**: the table also needs "409 or non-existent when the store is missing", the error class and the complete failure message; the two optional fields are used only by the three routes that need them.
- `sendSettings` is also used in 6 places that are not settings writes (`GET /api/settings`, Google Photos pick and cancel / clear, the two sign-in cancels, `welcome-ack`): the expression was identical character for character and is now a call.

<a id="4-驗證"></a>
## 4. Verification

<a id="41-新增的測試"></a>
### 4.1 New tests

`tests/settings-routes.test.ts` (19 tests, over real HTTP). It does not import any module that exists only after the change, so **it also runs on main before the change**. Two fixtures:

- The real core (`startNous`, `NOUS_WAKE=on`, `NOUS_CAMERA=on`, mock engine, temporary config folder): for each of the 12 routes a valid patch (200, the body equals the `GET /api/settings` that follows, the matching section changed, the settings file contains the patch); an invalid patch (400 with the verbatim message, settings and settings file unchanged); a settings file that cannot be written (a non-empty folder is placed where the settings file goes; for alarms the blocked path is `alarms.json.tmp`) giving 500 and "not saved"; provider 200 / 400 / 409; responses under `X-Nous-Terminal` and `X-Nous-Locale` equal the GET with the same header; GET on the same path is 404; face tuning reset / calibrated / merged-set check; face tuning 409 with `NOUS_CAMERA=off`; the two wake 403s and their order; the proactive window check.
- `createApp` with controllable stores (real stores behind a wrapper that records calls and can be told to throw `Error("disk full")` on every write): a valid patch calls only its own store once and `onChange` once; an invalid patch does not call the store; the 500 message on a write failure is compared verbatim (Chinese and `X-Nous-Locale: en`); the format check comes before the write; with no store provided the answer is 409 or 404, before the body is read; a body that is not a JSON object is 400; the 403 and its order under `cameraEnable: "main_process"`; accepted under `http` or when unset; reset goes through `reset()`.

The 12 routes in the table plus alarms, 13 in all, run through the same test table (alarms stays in `app.ts` and is verified the same way).

`tests/settings-route-table.test.ts` (4 tests, no HTTP, imports the new module directly): only `POST` and the full path match, and `/api/settings/alarms` is not in the table; with no store the flagged routes return `false` and the others throw 409, none reading the body; 400 / 500 / success and `this` for the uniform kind; a format error thrown by the store is 400 only for proactive.

<a id="42-新測試在重整前的-main-上通過"></a>
### 4.2 The new test passes on main before the change

1. The test was written first, without touching `server/`. At that point `git status --short` showed only `?? tests/settings-routes.test.ts`, `HEAD` was `1b61d08`, and the SHA-256 of `server/app.ts` was `11eb3f5b…`. `npx vitest run tests/settings-routes.test.ts`: **1 file, 19 tests passed**.
2. The same test after the change: **19 tests passed**.
3. After the change the test file gained only one type annotation (`as Record<string, string>[]`, needed for `tsc`). The final test file was then put into a clean copy extracted with `git archive 1b61d08` (no `server/routes/`, the same SHA-256 for `server/app.ts`) and run once more: **19 tests passed**, and `npx tsc --noEmit` passed too.

<a id="43-一次性的回應逐位元組比對沒有提交"></a>
### 4.3 One-off byte-for-byte response comparison (not committed)

The same test was copied to a temporary file with one line added to its HTTP client that writes every response (test name, URL, status code, the two headers, the raw body text) to a JSONL file; only the temporary folder path, the port, ISO timestamps and `server_now` were replaced by fixed text. It was run twice before the change to confirm the output is stable (the two runs were identical), then once after the change:

- **294 responses, 1,685,615 bytes, identical before and after under `cmp`** (SHA-256 `dcfe80bd…` for both).

The temporary test and the JSONL files are not in the repository and cannot be re-run directly later; the reproducible evidence is the tests in §4.1.

<a id="44-指令與結果"></a>
### 4.4 Commands and results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Pass |
| Unit and integration tests | `npx vitest run` | 178 test files passed; 3,332 of 3,337 tests passed, 5 skipped; about 67 s. That is 2 files and 23 tests more than the baseline (the two new test files). The skip count varies with the environment (an earlier run of the same code had 6) |
| Front-end build | `npx vite build` | Pass; the chunk larger than 500 kB warning remains (same as the baseline) |
| Desktop main process syntax | `node --check desktop/main.mjs` | Pass |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS |
| Bilingual documents | `node scripts/check-bilingual-docs.mjs` | Pass: 143 documents, 142 complete pairs, 1 inline |
| Whitespace | `git diff --check` | Pass |
| Architecture metrics | `node scripts/architecture-metrics.mjs` | See §3.1 |
| No existing test file modified | `git status --short` | Under `tests/` only the two new files |

The existing tests named in the task (`http`, `backend-i18n`, `camera-settings`, `camera-enable`, `audio-settings`, `wake-settings`, `clock-settings`, `voice-settings`, `day-night-mode`, `home-corner`, `memories-http`, `proactive-http`, `alarms`, `realtime-routes`, `service-mode`, `architecture`) are all part of the full suite and pass unmodified; the architecture guard test (0 cross-layer imports, no new import cycle) stays green.

Baseline: `npx vitest run` on the clean `git archive 1b61d08` copy gives 176 test files passed, 3,308 of 3,314 tests passed, 6 skipped.

<a id="5-限制"></a>
## 5. Limitations

- Fixture tests in a cloud container only; nothing was started on a Mac or a Pi, and none of these settings were changed through the real settings page or menu bar.
- Only two kinds of write failure were tested: a store throwing a fixed error, and a non-empty folder where the settings file (or its temporary file) goes. A full disk or missing permissions were not tested.
- `413 body too large` and `415` (Content-Type) were not tested route by route; they live in `readJson` and `checkRequest`, which this batch did not change.
- "Consulting the table in one place does not change precedence" comes from reading the code (§3.2), plus the tests for each path and for the 404s; not every possible path was enumerated.
- The byte-for-byte comparison in §4.3 is not committed; it covers the 294 requests the test sends, not every possible input.
- The second validation on read-back (`PrefsFile`) is untouched, and the two validators were not proved equivalent; that is the separate PR mentioned in 23 §3.
- The missing English translation for `校正值沒有保存…` (§2) is an existing gap and is kept as it is in this batch.
- A passing full suite is a code check only; it is not G0–G3 or any Mac / Pi gate.
