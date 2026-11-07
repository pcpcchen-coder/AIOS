<!-- bilingual: source=zh-TW -->

> [繁體中文](day-night-volume-2026-11-07.md) | [English](day-night-volume-2026-11-07.en.md)

# Day/night voice volume VOL-2 (2026-11-07)

George asked on 2026-11-07 to judge brightness from the camera so the day and night volumes differ. At night Nous must not disturb anyone; during the day it must be loud enough to hear.

This batch follows [VOL-1 voice volume](voice-volume-2026-11-07.en.md).

## What was done

- **Two volumes.** The "day volume" keeps the VOL-1 value (default 100), and a new "night volume" defaults to 40. Both are stored in this device's page, one set for the Mac main window and one for the Pi terminal.
- **How it decides (`shared/day-night.ts`, pure functions):**
  - Within night hours (default 22:00–07:00, adjustable), the night volume is used.
  - Outside night hours, if the camera sees a dark room, the night volume is also used.
  - Otherwise the day volume is used.
  - When the period changes, audio that is playing switches to the other volume at once.
- **Why "bright" cannot turn night into day.** Cameras adjust exposure automatically, so a lit room still looks bright at night; treating brightness as daytime would make Nous loud late at night. The camera can only turn day into night (for example when the lights go off), never the reverse.
- **How brightness is measured:**
  - While the camera is on and "Use camera brightness" is on, one frame is taken from the sense pipeline every 30 seconds and transferred to a new light worker (`src/sense/light-worker.ts`).
  - The worker scales the frame down to 64×36, computes the Rec. 601 mean brightness (0–255), closes the frame at once, and returns only one number.
  - No image is saved, uploaded or logged.
  - Thresholds and hysteresis:
    - Below 40 for 1 minute in a row counts as dark, and above 55 for 1 minute counts as bright. Values in between keep the current judgement, so switching a light or someone walking past does not flip it back and forth.
    - With no reading for 90 seconds (camera off or picture not OK), brightness is unknown and only the hours count.
    - While brightness is unknown, one bright reading decides at once, but dark still needs 1 minute: the first frame after the camera starts can be black or stale, and one frame must not switch to night.
    - Right after the camera starts, before the first frame is drawn, the sampling exit returns no frame (found in review, fixed).
  - The thresholds are not calibrated on real hardware; the settings page shows the measured value for tuning.
- **The privacy boundary changed.** `tests/camera-privacy.test.ts` now allows pixel reads in two files instead of one: the family recognition worker and the new light worker. Only one mean brightness number leaves the worker, which still meets "raw webcam images must not be written to files, traces or sent out".
- **By voice:**
  - `set_voice_volume` gains a `period` argument (`day`/`night`), filled only when the user names it, as in 「晚上的音量調到 30」 ("set the night volume to 30"). Without it, the volume in use now changes.
  - The result carries `period` and `in_use_now`. When the changed volume is not the one in use, a `note` says it applies in that period.
- **Settings page, "Voice volume on this device":**
  - A top line says honestly which volume is in use and why: "Using the day volume now", "Using the night volume now: within night hours (22:00–07:00)" or "Using the night volume now: the camera sees a dark room".
  - Day and night each have a row with the three buttons, and the row in use is marked.
  - "Night starts/Night ends" pick whole hours; the same hour for both means no night hours.
  - A "Use camera brightness" toggle (on by default).
  - A camera brightness readout such as "Camera brightness: 22 (dark)", or an honest line when the camera is off, not measured yet, or not used.
  - Everything is in Chinese and English.

## Known limits

- **Mac App main window:** when the App's main process handles the camera, the page's sense pipeline may have no frames, so only the hours count (the settings page says "camera off or not measured yet"). On the Pi terminal page the camera runs in the page, so brightness can be measured.
- The 40/55 thresholds are estimates and have not been calibrated under the lighting in George's home.
- Day/night is recalculated every minute, so a period boundary can be up to 1 minute late.

## Tests

- `tests/day-night-volume.test.ts` (17 tests):
  - Night hours: across midnight, within one day, start equal to end.
  - Prefs parsing and decision rules: hours win, dark turns day into night, bright cannot change night, camera judgement turned off.
  - Brightness hysteresis, in-between values, stale readings, and the mean brightness formula.
  - Saving and switching the two volumes; `period` and `note` in the tool result.
  - Measurement schedule: no measurement without a frame, the frame is transferred, no overlap, a stuck or failed-to-load worker is replaced, nothing is reported after stop, errors are not readings.
- `tests/voice-volume.test.ts`: the settings page now has two rows, the night reason and camera reading are shown honestly, the hour selects and toggle call the setting, and the English catalog is complete.
- **Real browser check (headless Chromium, the built `light-worker` file):**
  - All black → 0, all white → 255, (30,30,30) → 30, (200,100,50) → 124.2 (= 0.299×200 + 0.587×100 + 0.114×50).
  - After the transfer the page's frame has width 0, so the page keeps no copy.
- `npm run typecheck`, `npx vitest run` (162 files, 3012 passed, 5 skipped), `npm run build` and `node scripts/verify-aios.mjs` all pass.

## Not yet verified

- Not tried on a real Pi or Mac.
- To check:
  1. With the Pi camera on, the settings page shows "Camera brightness: N".
  2. During the day, turn the lights off for more than 1 minute; it changes to "Using the night volume now: the camera sees a dark room" and Nous speaks more quietly.
  3. One minute after the lights are back on, the day volume returns.
  4. After 22:00 the night volume is always used.
  5. Note the measured brightness with the lights on and off and report it so the thresholds can be calibrated.
