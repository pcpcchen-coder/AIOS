<!-- bilingual: source=zh-TW -->

> [繁體中文](wake-threshold-2026-11-08.md) | [English](wake-threshold-2026-11-08.en.md)

# Wake word threshold adjustment (settings page, 2026-11-08)

George asked on 2026-11-08 whether users can adjust the wake word threshold and, if so, to add a threshold adjustment to the settings page.

## 1. Before

The threshold **could not** be adjusted. It lives in the `keywords` of `shared/wake-runtime.json`: the three Hello Nous lines use the global threshold 0.15 (boost 1.5), and the three Hey Nous lines use their own 0.25 (boost 1.0). The wake worker (`src/audio/wake-worker.ts`) reads that manifest directly to build the sherpa-onnx keyword configuration, and no preference or setting changed it. For where the numbers come from, see the [WK-00 Mac trial](wk-00-mac-2026-10-31.en.md).

## 2. What changed

The settings page has a new "Wake word threshold" section where you choose a **threshold adjustment**. The value is added to every keyword line's threshold (including the global one); boosts are unchanged:

| Option | Adjustment | Hello Nous | Hey Nous |
|---|---|---|---|
| Wakes more easily | −0.10 | 0.05 | 0.15 |
| Slightly easier | −0.05 | 0.10 | 0.20 |
| **Default** | **0** | **0.15** | **0.25** |
| Slightly stricter | +0.05 | 0.20 | 0.30 |
| Fewer false wakes | +0.10 | 0.25 | 0.35 |

(Calculation: threshold + adjustment, clamped to 0.01–0.99 and rounded to two decimals; checked in `tests/wake-threshold.test.ts`.)

A higher sherpa-onnx threshold is harder to trigger, so a lower value wakes more easily and also false-wakes more easily. The limits are ±0.10 based on the WK-00 Mac measurements: Hello Nous dropped to 6/10 offline at 0.25 (+0.10); Hey Nous had already dropped to 6/10 at 1.0/0.30 (+0.05); and Hey Nous was triggered by "Hey nurse" at boost 1.5 with threshold 0.15. The −0.10 option (Hey Nous at boost 1.0 with threshold 0.15; Hello Nous at 0.05, below the lowest tested value of 0.10) **has not been measured**, and false wakes may rise noticeably. Values further out are not offered.

| Item | How |
|---|---|
| Storage | A new `wake_threshold_offset` field in the core's `wake.json` (`shared/wake.ts`), accepting only one of the five options; an unreadable value in the file falls back to 0 (the product thresholds) |
| Display | `settings.wake` in `/api/settings` now carries `thresholds`, the effective threshold per wake phrase computed by the core from the manifest; the settings page shows it as "Current thresholds: Hello Nous 0.15, Hey Nous 0.25" |
| Applying | Capture (`src/audio/capture.ts`) passes the adjustment in the worker's init; the worker accepts only one of the five options and otherwise uses the product thresholds (`offsetKeywords`) |
| When it takes effect | Changing it while listening rebuilds the capture with the new threshold: immediately when idle, after the call ends during a call (like a change of sound input, `AudioFrontEnd.reopen`). Changed while listening is off, it applies the next time listening is turned on |
| Where | The settings screen of the browser version and the Pi page, and the macOS App's settings page, whenever the core has wake enabled (`NOUS_WAKE=on`, so `settings.wake` exists). The macOS App menu bar's “Wake word” section also has a “Wake word threshold: …” submenu (added the same day at George's request) with the same five options, writing the same setting. All devices connected to the same core share one value |
| Bilingual | Options, note and error message are in `src/messages.en.json` |
| Rollback | Choosing "Default (0)" restores the original thresholds; an older `wake.json` without the field also means 0 |

The direction diagnostic page (`spike/wake/direction/`) now uses the same `offsetKeywords` (imported from `shared/wake.ts`) for its threshold offsets, so both compute the same way.

## 3. How to choose

- It often fails to wake: try "Slightly easier (−0.05)" first.
- The TV or conversation often false-wakes it: try "Slightly stricter (+0.05)".
- To find the best value: use the [direction diagnostic page](wake-direction-2026-11-08.en.md). It runs the thresholds +0.10, +0.05, 0 and −0.05 at once, so you can see at which value the missed tries would hit and at which value the false wakes disappear.

## 4. Verification

| Item | Result |
|---|---|
| `tests/wake-threshold.test.ts` (8 tests) | Only the five options are accepted; storage and the fallback to 0; the effective thresholds for the five values (table above); `kwsConfig`'s global threshold and boost; the worker accepts only listed values and capture passes the setting at init; changing it while listening rebuilds the capture, while the same value or listening off does not; the settings page shows five options, the selected value and the current thresholds, sends only on a real change, is disabled without the action, has complete English translations, and both settings pages include the section |
| Menu bar (`tests/desktop-menu.test.ts`) | “Wake word threshold: …” comes after “Wait after waking”; the five options match `shared/wake.ts` and the settings page, with the current value checked; choosing one writes `wake_threshold_offset` through `setMenuPref`; the English menu is fully translated; a value outside the options shows as the default |
| Existing tests | `wake-settings` (`settings.wake` now has `thresholds`), `audio-privacy` (the capture init line updated verbatim) and others updated; see the PR for the `node scripts/verify-aios.mjs` result |
| Headless Chromium | Started the core with `NOUS_WAKE=on` and the mock engine, opened the Pi page (`?terminal=rpi4`) and pressed the gear: the settings page showed "Wake word threshold" at 0 with Hello Nous 0.15 and Hey Nous 0.25; after choosing "Slightly easier (−0.05)", `wake.json` stored `-0.05` and the page showed Hello Nous 0.10 and Hey Nous 0.20 |

## 5. Not verified

- Not tried on the Mac, the Pi or the eMeet; the real wake and false-wake rates at each value need the diagnostic page or everyday use.
- The cloud headless Chromium setup had no engine files (`runtime: not_configured`), so the worker was not seen detecting with the new threshold; applying it in the worker is covered by static tests and the `kwsConfig` test. The direction diagnostic page uses the same `offsetKeywords` and was earlier run in headless Chromium with the real engine at ±0.05 and +0.10.
