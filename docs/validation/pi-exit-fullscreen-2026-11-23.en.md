<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-exit-fullscreen-2026-11-23.md) | [English](pi-exit-fullscreen-2026-11-23.en.md)

# "Exit full screen" in the Pi settings, WIN-1 (2026-11-23)

On 2026-11-23 George asked for an "Exit full screen" option in the Pi settings.

## Why the page cannot do it alone

Chromium on the Pi runs with `--kiosk`. JavaScript in the page cannot leave kiosk full screen or close and reopen the browser, and the core on the Mac cannot reach the Pi's Chromium either. So this uses the same route as DN-3 (turning the screen off at night).

## What was done

1. **Settings page**: terminal pages such as the Pi get a new section, "Full screen on this Pi".
   - It shows the current mode, "Now: full screen" or "Now: window", based on whether the URL has `display=window`.
   - A single button toggles between "Exit full screen" and "Back to full screen".
   - The Mac window does not have this section.
2. **Core**: a new `POST /api/terminal/window {terminal, mode}`, where `mode` is `kiosk` or `window`.
   - The core keeps only the latest request, in memory, valid for 60 seconds.
   - The `GET /api/terminal/display?terminal=rpi4` that the Pi already reads gains a `window` field, which is `null` when there is no request or it has expired.
3. **Pi kit**:
   - `aios-display` already reads the core every 2 seconds. When the `window` it reads differs from what the Pi has saved, it writes `~/.config/aios-terminal/window-mode` and queues `systemctl --user --no-block restart aios-kiosk.service` (without waiting for the old Chromium to stop, so the night screen loop never stalls). The same request never restarts it twice; if even queuing fails, the saved mode is put back so it keeps matching the screen.
   - `aios-kiosk` reads this file:
     - full screen uses `--kiosk`;
     - window mode uses `--start-maximized` instead and adds `&display=window` to the URL, so the page knows it is in a window.
   - The file on the Pi is the persistent setting, so the last choice is kept after a reboot.
4. **Honest feedback**:
   - After the click, settings show "Sent; the Pi will reopen the screen in a few seconds…" and the button is disabled.
   - Restarting Chromium reloads the page. If the page is still there after 20 seconds, the text changes to "The Pi did not respond: make sure the Pi kit is updated…".
   - A failed send shows "Not sent: reason".

## Before using it

This change touches the Pi kit's `aios-kiosk`, `aios-display` and `lib/common.sh`, so **the kit on the Pi must be updated**: pull the new repo and run `bash install.sh` on the Pi. Without the update, pressing the button shows "The Pi did not respond".

## Known limits

- Switching restarts Chromium, so a voice conversation in progress is cut off. Camera and microphone permissions live in the same profile and do not need to be granted again.
- In window mode, closing the window makes `aios-kiosk.service` (`Restart=always`) reopen it after about 3 seconds. To close it for good, run `systemctl --user stop aios-kiosk.service`.
- A browser page opened elsewhere with `?terminal=rpi4` also shows this section and really switches the Pi; that page does not reload, so after 20 seconds it wrongly shows "The Pi did not respond".
- When the core on the Mac restarts, the in-memory request is lost; the Pi keeps the mode in its file and is not switched back.

## Tests

- `tests/terminal-window.test.ts` (5 tests):
  - the core's request is per terminal, valid for 60 s, and `null` once expired;
  - the mode is read from the URL;
  - the settings button's direction and the three states after a click (sent with the button disabled, Pi did not respond, send failed);
  - English translations.
- `tests/day-night-mode.test.ts`:
  - the `window` field over HTTP;
  - `POST /api/terminal/window` returns 200 when valid and 400 for a bad mode or terminal.
- `terminals/rpi4/tests/dry-run.sh` (149 checks, 18 new):
  - nothing happens without a request;
  - a window request is saved and restarts the kiosk once, and the same request does not restart it again;
  - window mode Chromium has no `--kiosk`, with `--start-maximized` and `display=window`;
  - a full-screen request switches back to `--kiosk`;
  - when the restart cannot be queued, the saved mode is put back;
  - shellcheck is clean.
- **Headless Chromium (mock core):**
  - The Pi page's settings show the section: "Now: full screen" on the full-screen page and "Now: window" with `display=window`.
  - After the click, the core's `window` holds the matching value and settings show "Sent…".
  - The Mac page has no such section, and there are no JS errors.
- `npm run typecheck`, `npx vitest run`, `npm run build` and `node scripts/verify-aios.mjs` all pass.

## Not yet verified

- Not tried on a real Pi.
- To check:
  1. After updating the kit, press "Exit full screen"; within a few seconds Nous becomes a window with a title bar and settings say "Now: window".
  2. Press "Back to full screen" and it returns to full screen.
  3. After a reboot the last choice is kept.
