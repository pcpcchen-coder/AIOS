<!-- bilingual: source=zh-TW -->

> [繁體中文](light-thresholds-2026-11-09.md) | [English](light-thresholds-2026-11-09.en.md)

# Camera dark/bright thresholds setting LUX-1 (2026-11-09)

George asked on 2026-11-09 for a settings interface to adjust the threshold values the camera uses to decide dark and bright.

## Behaviour

- Under the "Camera brightness" reading in the settings page's "Conversation volume on this device", two drop-downs are added:
  - **Dark below**: default 95;
  - **Bright above**: default 115.
- Between them is a gap where nothing switches. The rules are the same as VOL-2:
  - in the daytime it must be dark for 1 minute in a row to count as night;
  - after the lights come on, it must be bright for 1 minute in a row to count as day.
- Options run from 5 to 250 in steps of 5; "dark" is always at least 5 below "bright" (the drop-downs list only valid values).
- "Reset thresholds (95/115)" restores the defaults in one press; the button is disabled when they are already the defaults.
- **Saved per device** (`nous.light-thresholds.v1` in the page's `localStorage`): the Mac and Pi cameras expose differently, so this is not shared through the core. Unreadable or invalid values fall back to the defaults.
- After a change, the latest reading is judged again: "bright" is settled at once; "dark" still needs 1 minute in a row.
- How to set them (the settings page explains this too):
  1. Read the "Camera brightness" number once with the lights on and once with them off;
  2. set "Dark below" above the lights-off value and "Bright above" below the lights-on value;
  3. leave a gap between them where nothing switches.
  - Example: George's Pi reads about 130 with the lights on and about 80 with them off, which is how the 95/115 defaults were chosen.

## Fixed along the way

- The settings page used to re-render only when the core's settings changed, so changes kept on this device only (such as "Quieter" or a threshold) did not show right away.
- This device's volumes, mode and thresholds now count towards re-rendering too. The brightness number, which changes every 30 s, does not, so an open drop-down is not closed by a re-render.

## Implementation

- `shared/day-night.ts`:
  - `LumaThresholds`, `DEFAULT_LUMA_THRESHOLDS`, `validLumaThresholds`, `parseLumaThresholds`;
  - `darkOptions`/`brightOptions`: build the drop-down options;
  - `nextLight` takes a thresholds argument (default 95/115).
- `src/voice-volume.ts`: `loadLumaThresholds`, `saveLumaThresholds` (throws and saves nothing when invalid) and the interface text.
- `src/views.ts`: the two drop-downs and the reset.
- `src/main.ts`: measurement uses this device's thresholds; a change triggers a fresh judgement; settings page re-render key.
- English: `src/messages.en.json`.

## Tests

- `tests/light-thresholds.test.ts` (7 tests):
  - defaults 95/115;
  - valid range and gap;
  - options in steps of 5 that keep the gap;
  - with custom 70/90, 80 falls in the gap and 65 counts as dark after a minute;
  - save, reload, bad values falling back, invalid values not saved;
  - the values the two drop-downs send, their option bounds, and reset;
  - nothing shown without threshold state;
  - every new string has English.
- Headless Chromium (mock core, Pi page 1024×600):
  - in the settings page, choosing 70 for "dark" makes the "bright" options start at 75 right away;
  - choosing 90 then leaves `localStorage` at `{"dark":70,"bright":90}`, which survives a reload;
  - no JS errors.
- `npm run typecheck`, `npx vitest run` (171 files, 3174 passed, 5 skipped) and `npm run build` all pass.

## Not yet verified

- The thresholds have not been adjusted on a real Pi or Mac, and switching with the lights after a change has not been confirmed.

## Rollback

Press "Reset thresholds (95/115)" to return to the thresholds calibrated in VOL-2.

## George's steps to try at home

1. On the Pi, open the settings page with the camera on, and note the "Camera brightness" number with the lights on and off.
2. Adjust the two thresholds as described above.
3. During the day hours, turn the lights off for 1 minute: the top-right badge turns to "Night mode", because the camera sees a dark room.
4. Turn the lights on for 1 minute: it goes back to "Day mode".
