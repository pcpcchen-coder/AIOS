<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-settings-entry-2026-11-07.md) | [English](pi-settings-entry-2026-11-07.en.md)

# Pi settings button SET-1 (2026-11-07)

George asked on 2026-11-07 for a settings button in the bottom-right corner of the Pi screen. One mouse click should open the Pi's settings, and every setting must be reachable from it.

## What was done

- **The button**: `src/settings-entry.ts`, a round gear button (40×40 px) in the bottom-right corner.
  - One click opens the settings page; another click closes it.
  - While the settings page is open, the button turns green and its label changes from "Open settings" to "Close settings" (「打開設定」／「收起設定」).
  - When settings are closed some other way (Esc, saying 「收起」), the button state follows.
- **Only on Pi terminal pages**: it appears only without the App preload and with exactly one valid `?terminal=` in the URL. The Mac App has a menu bar, so its window has no such button.
- **Layout**: the camera status dot moves left to `right: 64px`, and the camera preview moves up to `bottom: 56px`, so neither covers the button.
- **The settings content is unchanged**: it is the existing settings page. On the Pi all 11 sections are visible:
  - AI engine (with language), realtime voice, voice, camera and gestures (including "Show camera view"), sound;
  - voice volume on this device, display performance on this device;
  - proactive reminders, top-right clock and weather, top-left home status, memories mode.
  - Family enrolment and memory management were already Mac App only and are not on the Pi.

## Known behavior

- Clicking the gear while a confirmation card is open replaces it with settings, just like saying 「設定」, so the card counts as rejected and the external action does not run.
- On very narrow screens (under about 780 px wide), the longest subtitles can extend under the button, which then covers the end of the line.

## Relation to the product red lines

CLAUDE.md's red lines forbid App icons, App launchers and persistent sidebars. This button is a persistent entry point that George asked for, so its scope is kept small:

- it is a single settings button that opens no App and lists no features;
- it appears only on Pi terminal pages;
- it carries `data-visibility-reason="user_request:terminal_settings_entry"`, recording why it is on screen.

## Tests

- `tests/settings-entry.test.ts` (4 tests):
  - appears only on terminal pages (not in the App, not with a missing or repeated `terminal`, not with an invalid ID);
  - clicking opens and closes; label and pressed state; it follows when closed elsewhere;
  - Chinese and English labels; the CSS clears the bottom-right corner.
- **Headless Chromium (mock core, simulation mode):**
  - Pi page (`?terminal=rpi4`) at 1920×1080: the button is at (1868, 1032), size 40×40.
  - Pi page at 1024×600: the button is at (972, 552).
  - Clicking opens settings and the label becomes 「收起設定」; another click closes them.
  - The settings page lists the 11 section headings above; after switching to English the label is "Close settings".
  - The Mac page (no `terminal`) has no button, and the page has no JS errors.
  - Screenshots stayed in the development environment and are not in the repo.
- `npm run typecheck`, `npx vitest run` (163 files, 3017 passed, 5 skipped), `npm run build` and `node scripts/verify-aios.mjs` all pass.

## Not yet verified

Not tried on a real Pi. To check: click the gear in the bottom-right corner with the mouse and the settings open; click again and they close; a touch screen can tap it too.
