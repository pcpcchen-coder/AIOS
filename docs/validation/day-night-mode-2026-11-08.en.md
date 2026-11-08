<!-- bilingual: source=zh-TW -->

> [繁體中文](day-night-mode-2026-11-08.md) | [English](day-night-mode-2026-11-08.en.md)

# Day/night mode DN-1: inventory, design and first batch (2026-11-08)

On 2026-11-08 George asked to turn VOL-2's "day/night volume" into a full day/night mode. This document covers:
- an inventory of what exists;
- the overall design and George's decisions;
- the first batch (B1) and the second batch (B2, section 7): implementation, tests and how to roll them back.

## 1. Inventory (main @ 1a66fb9)

| Item | Current state |
| --- | --- |
| Decision rules | `shared/day-night.ts` (pure functions): inside the night hours (default 22:00–07:00) it is night. Outside them, camera readings below 95 for 1 minute in a row also count as night; it takes readings above 115 for 1 minute in a row to count as bright again. "Bright" never turns the night hours back into day. Recomputed every minute; brightness is sampled every 30 s, and after 90 s without a reading only the hours count |
| What it affects | Only two things: the conversation volume (day default 100, night default 40), and the sun "Day mode" or moon "Night mode" badge under the top-right clock |
| Mac and Pi | Each **page** decides on its own, and the settings live in that page's `localStorage`, so the Mac main window and the Pi Chromium decide separately and do not share settings. The Pi camera is off by default, so the Pi usually goes by the hours only. The core (server) does not know whether it is day or night |
| Settings | The settings page has the day volume, night volume, night start/end hours and use-camera. The `set_voice_volume` voice tool can name a `period` but only changes the volume |
| Missing | Manual switching and temporary overrides; a Mac menu bar item; none of these follow day/night yet: the screen, the processing sound, memories mode, the wake threshold, proactive reminders, the Pi screen |
| Known limits | The proactive reminder window (default 05–11) overlaps the night hours between 05 and 07; the brightness thresholds come from readings on one Pi in one room; the Pi screen stays on only because Screen Blanking is turned off |

## 2. Design and George's decisions (2026-11-08)

| Question | George's decision | Batch |
| --- | --- | --- |
| Pi physical screen | **Turn the screen fully off late at night**, back on at wake or touch | B3 (Pi package) |
| Processing sound | **Off at night** (the brain still shows processing) | B1 |
| Nous's speaking tone | **Quiet and brief at night** (changes the tone only; the voice itself is not guaranteed to get softer) | B2 (needs the core to know the mode) |
| Proactive reminders | Unchanged ("silent at night" was not chosen) | — |
| Wake threshold | Unchanged | — |
| Memories mode | **Paused at night** | B1 |
| Manual switching | **Move the mode into the core and share it**; switchable from the settings page, the menu bar and voice commands, including temporary overrides such as "stay in day mode tonight" | B2 |
| Screen | The whole screen dims at night, with a fade of about 3 s | B1 |

## 3. First batch B1: night behaviour in the page

### Behaviour table

| Behaviour | Day | Night ("also apply" on) | Night ("also apply" off = rollback) |
| --- | --- | --- | --- |
| Conversation volume | Day volume | Night volume | Night volume |
| Screen | Unchanged | A 45% black layer over the whole screen, fading in over about 3 s; 25% while the settings page is open; 0.4 s with reduced motion | Unchanged |
| Processing ping | Per the "Sound" setting | Silent; the brain still shows processing | Per the "Sound" setting |
| Memories mode | Per its setting | Does not start; stops if playing | Per its setting |
| Top-right badge | Sun "Day mode" | Moon "Night mode"; the tooltip adds "Screen dimmed, processing sound muted, memories paused" | Moon "Night mode" |

### Implementation

- `shared/day-night.ts`:
  - `DayNightPrefs` gains `night_effects` (on by default; falls back to the default when unreadable);
  - a new pure function `nightEffects(mode, prefs)` returns `{ dim, muteProcessingCue, pauseMemories }`, all false in the day or when the setting is off.
- `src/main.ts`: when the decision changes, it sets `data-day-night` and `data-night-dim` on `body` and recomputes the processing sound and memories mode:
  - processing sound: `enabled` gains one more condition, so it is silent at night;
  - memories mode: `enabled` gains one more condition, so it does not play at night;
  - the top-right tooltip gains one line.
- `src/style.css`: `body::after` lays a semi-transparent black layer that takes no clicks.
- The settings page's "Conversation volume on this device" gains a toggle: "At night, also dim the screen, mute the processing sound and pause memories".
- English for the new strings is in `src/messages.en.json`.
- The brain's region animations still come only from real events; they just look darker. No fake events or animations.
- This batch does **not** separately lower the brain's animation intensity (frame rate or pulse amplitude); it only lowers the brightness.

### Rollback

Turn off "At night, also dim the screen, mute the processing sound and pause memories" on the settings page to return to VOL-2 behaviour: at night only the conversation volume changes. The setting lives in each device's page, so the Mac and the Pi are turned off separately.

## 4. Tests

- `tests/day-night-volume.test.ts`:
  - `nightEffects` returns all three as true at night with the setting on, and all false in the day or with it off;
  - the default and the handling of unreadable values;
  - a fake clock at 23:00, and at 14:00 with a fake "dark" reading, both apply the effects; 14:00 with a "bright" reading does not;
  - the existing save and reload tests now include `night_effects`.
- `tests/voice-volume.test.ts`: the settings toggle shows the right `aria-pressed` and sends `{ night_effects: false/true }`; every new string has English.
- Headless Chromium (mock core; night hours set to 00:00–23:00 to simulate night and 00:00–00:00 to simulate day), with no JS errors on any page:

  | Screen | `data-day-night` | `data-night-dim` | Layer opacity |
  | --- | --- | --- | --- |
  | Mac 1920×1080 day | day | off | 0 |
  | Mac 1920×1080 night | night | on | 0.45 |
  | Pi 1024×600 day | day | off | 0 |
  | Pi 1024×600 night | night | on | 0.45 |
  | Pi 1024×600 night, toggle off | night | off | 0 |

- `npm run typecheck`, `npx vitest run` (167 files, 3092 passed, 6 skipped) and `npm run build` all pass.

## 5. Not yet verified

- The amount of dimming and the fade have not been seen on a real Mac or Pi; 45% is an estimate.
- It has not been confirmed on real hardware that the processing sound stays silent and memories mode does not start at night (unit tests and code paths only).
- Turning off the Pi screen (B3) is not done yet; see section 7 for the scope and validation of B2.

## 6. George's steps to try at home

1. On both the Mac and the Pi, open the settings page's "Conversation volume on this device" and check that "At night, also dim the screen…" is on.
2. Temporarily set the night start to the current hour and the end to the next hour. Within about a minute the screen should fade darker over about 3 s, and the top-right badge should turn into the moon "Night mode".
3. At night, start a background task: the brain shows processing, but there is no sonar ping.
4. Leave it idle longer than the memories idle time: memories mode does not play.
5. Turn the toggle off: the screen fades back right away, memories and the processing sound return, and only the volume stays at night level.
6. Set the night hours back to 22:00–07:00.

## 7. Second batch B2: shared core mode, manual switching and a quiet tone (2026-11-08)

### Behaviour

| Item | Behaviour |
| --- | --- |
| Shared settings | The night hours, use-camera, "also apply" and the manual switch live in the core's `configDir/day-night.json` and reach every page through `settings.day_night`; the Mac main window and the Pi change together. **Camera brightness is still measured by each page** and only affects that device |
| Moving old settings | When the core has saved nothing yet and a page has settings saved by VOL-2, the page sends them to the core once; from then on the core decides. If two devices had different settings, the one opened first wins |
| Conversation volume | The day and night volumes are still saved per device (unchanged) |
| Manual switch | "It's daytime now" and "Switch to night" last until the next boundary of the night hours (switching to night at 15:00 lasts until 22:00, after which the hours keep it night anyway); "Stay in day mode tonight" lasts until tonight's night hours end (07:00 the next day by default); "Automatic" cancels at once. A manual switch beats the hours and the camera, and goes back to automatic when it ends |
| Entry points | Four buttons at the top of the settings page's "Conversation volume on this device"; a "Day/night mode" section in the Mac menu bar with a status line and four radios; the realtime voice tool `set_day_night` ("switch to night mode", "it's daytime now", "stay in day mode tonight", "back to automatic") |
| Top-right badge | When manual, it shows "Manual: staying in night mode until 22:00" |
| Quiet tone | When the core decides it is night (hours or manual switch), the instructions at the start of each realtime call gain "speak softly and slowly, with shorter sentences". Only the tone changes, not the voice or volume; switching mid-call does not change that call; **each device's camera is not considered** |
| Unchanged | Proactive reminders and the wake threshold (George chose to keep them) |

### Implementation

- `shared/day-night.ts`:
  - `nextScheduledChange`, `overrideUntil` and `activeOverride` (local time, pure functions);
  - `decideDayNight` gains a manual-switch argument and the `manual` reason;
  - new `parseDayNightPatch` and `DayNightSettingsView`, plus the voice tool's argument and result functions.
- `server/day-night-settings.ts`: the only writer of `day-night.json`; a broken key is dropped and logged.
- `server/app.ts`: adds `settings.day_night` and `POST /api/settings/day-night` (validated, 400 on bad bodies).
- `server/realtime.ts`:
  - the new `set_day_night` tool (both paths) with its rule `DAY_NIGHT_RULE`;
  - the new `NIGHT_TONE_RULE` (only with `caps.night`; otherwise the instructions are byte-identical to before).
- `src/main.ts`:
  - pages follow the core's settings;
  - they recompute when new settings arrive;
  - the voice tool goes from the page to the core, and returns a real error when the core lacks the feature.
- `desktop/settings-menu.mjs`, `desktop/main.mjs`: the menu bar section.
- Strings in both languages: `src/messages.en.json`, `desktop/messages.en.json`, `shared/messages.en.json`; one more row in the command table of `README.md`/`README.en.md`.

### Rollback

- Say "back to automatic" or press "Automatic": cancels the manual switch.
- Turn off "At night, also dim the screen, mute the processing sound and pause memories": back to volume-only switching. From B2 on this toggle lives in the core, so turning it off once applies to both the Mac and the Pi.
- To go back to before B1 completely: delete `configDir/day-night.json` and revert this batch. Pages then return to their own saved settings.

### Tests

- `tests/day-night-mode.test.ts` (17 tests):
  - boundaries and end times on a fake clock (15:30, 23:10, "tonight" at 21:00, no night hours);
  - the manual switch winning and expiring;
  - patch validation;
  - `day-night.json` saving, expiry, reopening and broken keys;
  - `startNous` HTTP (shared, 400, automatic);
  - the tool's presence, arguments, output and page executor;
  - the quiet tone appearing only at night and being byte-identical once removed;
  - menu bar text matching the page, the patches the radios send, an expired switch showing automatic, and English containing no Chinese.
- `tests/voice-volume.test.ts`: the four settings buttons, `aria-pressed` on the current one, and none without the core.
- Deliberate exceptions to existing snapshots:
  - `apikey-route`'s tool list gains `set_day_night` and its instructions gain `DAY_NIGHT_RULE`;
  - the `realtime-bridge` tool lists;
  - `settings.day_night` in `wake-flag-off` (the seventh exception).
- Headless Chromium (mock core):
  - a Pi page opened with old page settings (21–06) leaves the core saving 21–06;
  - after the core switches to night, both the Pi and Mac pages become `night` and dim, and the badge says "Manual: staying in night mode until 21:00";
  - pressing "Automatic" in the Pi settings page brings the Mac page back to `day`;
  - no JS errors.
- `npm run typecheck`, `npx vitest run` (168 files, 3111 passed, 5 skipped) and `npm run build` all pass.

### Not yet verified (B2)

- Switching together, the menu bar and voice commands have not been tried on a real Mac and Pi.
- Whether the model really calls `set_day_night` as described, and whether the quiet tone sounds different, have not been tried with real realtime voice.

### George's steps to try at home (B2)

1. Open Nous on both the Mac and the Pi. In the Mac menu bar's "Day/night mode", choose "Switch to night": both screens dim within about 3 s, and the badge shows until when.
2. Press "Automatic" in the Pi settings page: both go back to deciding by the hours.
3. In realtime voice, say 「切到夜間模式」 (switch to night mode), then 「恢復自動」 (back to automatic): Nous says the mode and until when, and the screen follows.
4. Around 9 pm, say 「今晚維持日間」 (stay in day mode tonight): it stays day until 07:00 the next day, and the menu bar shows "Stay in day mode tonight" selected.
5. Start a realtime call during the night hours and listen for a softer, shorter tone.
