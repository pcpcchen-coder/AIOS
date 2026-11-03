<!-- bilingual: source=zh-TW -->

> [繁體中文](service-mode-2026-11-03.md) | [English](service-mode-2026-11-03.en.md)

# Mac service mode (serving the Pi terminal) validation

Date: 2026-11-03. Branch `claude/service-mode` (based on main `a2ac54b`). Status: **code and Linux cloud automated tests complete; not verified on a real Mac or a real Pi.**

## Request (George, 2026-11-03)

Add a service mode to the App on the Mac mini. Once entered:

- Hide the Mac brain and stop the Mac's local microphone, wake listening and camera.
- Keep the core, sign-ins and background tasks running so the Pi can keep working.
- Show "Service mode: Pi connected / disconnected" in the Mac menu bar.
- Provide "Return to Mac use" to switch back to local use.

"Pi connected" must reflect the terminal's actual connection and heartbeat, not just the service mode switch.

## Approach

| Part | Behaviour |
|---|---|
| Pi heartbeat | The Pi kiosk opens `http://localhost:<AIOS_PORT>/?terminal=rpi4`. Only when the page is not the App main window (no `nousDesktop`) and the URL carries a valid `terminal`, it sends `POST /api/terminal/heartbeat` once at once and then every 10 s; failures are silent and retried on the next tick |
| Core decision | `server/terminal-presence.ts` keeps each terminal's last heartbeat in memory only. A terminal is "connected" only with a heartbeat in the last 25 s; on expiry a timer switches it to "disconnected" and notifies the App main process. Nothing is written to disk, no IP is recorded, and the log records only connect and disconnect transitions. `http-guard.ts` is unchanged |
| Why not SSE connection state | The Pi connects through SSH forwarding. When the Pi loses power or network, the forwarded connection on the Mac side may stay open for a long time and SSE writes still succeed, so it is no proof that the Pi is online |
| Entering service mode | Menu bar item "Enter service mode (for the Pi)". Saved in `desktop.json` (the App stays in service mode after a restart); hides the main window; tells the page to end realtime voice, voice mode and press-to-talk, pause always-on wake listening with a new pause reason `service`, and stop the camera pipeline. The main window's microphone and camera permissions are always denied, and so is `nous:camera-enable` |
| While in service mode | Shortcuts, Dock clicks, a second launch and menu items that open the main window do nothing (show brain, voice, typing, progress, sign-in / account settings, results history, memory, family recognition, show camera view, and so on). The wake listening and camera switches are disabled and marked "Paused in service mode (setting unchanged)". Engine choice, Codex browser sign-in, realtime voice settings and `.env` stay usable. The core, existing sign-ins and background tasks continue |
| Menu bar | The top line is "Service mode: Pi connected" or "Service mode: Pi disconnected", taken only from the core's heartbeat state; the menu is rebuilt on every state change. A note line and "Return to Mac use" follow. The active task count badge is unchanged |
| Preventing sleep | In service mode a `powerSaveBlocker` (`prevent-app-suspension`) stops App Nap and system idle sleep from pausing the core; the display can still turn off. Released on Return to Mac use |
| Return to Mac use | Saves `serviceMode: false`, tells the page to release the `service` pause (wake resumes per its saved preference, the camera reopens if its setting is on), and shows the main window |

Every completed page load (startup, core restart, reload) re-sends the current state (enter or exit) to the page, so clicking "Return to Mac use" during a load is not lost. Each menu bar rebuild reads the terminal state directly from the core.

Every new interface string has English through `t()` and `desktop/messages.en.json` / `shared/messages.en.json`.

## Automated tests (Linux cloud)

| Check | Result |
|---|---|
| `tests/service-mode.test.ts` (13 tests) | Heartbeat and expiry with a fake clock; HTTP route (invalid id 400, non-JSON 415, valid 200); log records only transitions and no IP; page heartbeat (fake timers and fake fetch: nothing sent inside the App or without the parameter, keeps going after a failure); menu bar template (connection state comes only from the heartbeat, service mode shows "Return to Mac use" and hides the brain and voice items, normal mode shows the enter item); English coverage; preload accepts only `enter` / `exit` |
| 3 new tests in `tests/audio-front-end.test.ts` | Priority and release of the `service` pause, turning the preference off during service mode, `controller.service` |
| Existing tests | Updated source-string assertions in `camera-enable`, `history-surface` and `identity-ipc` |
| All | `npm run typecheck` passes; `npx vitest run` 133 files, 2440 passed, 5 skipped; `npm run build` passes; `node scripts/verify-aios.mjs` PASS; `bash terminals/rpi4/tests/dry-run.sh` 104 checks pass |

## Not verified

- The Electron App itself: menu bar rendering, window hiding, permission denial and IPC behaviour on a Mac. These have only unit tests and static source checks.
- The Pi sending heartbeats through the SSH tunnel, and how long it takes to switch to "disconnected" after the link drops.
- Menu sublabel display on macOS 14.4 and later.

## Known limitations

- In service mode the wake listening and camera switches are fully disabled, so they cannot be turned off while in service mode either; return to Mac use first.
- The page-side (`src/main.ts`) enter and exit handling has no behavioural test; the `main.mjs` wiring has only source-string checks.
- If the Pi page leaves the URL carrying `?terminal=rpi4` (for example a full-page ChatGPT sign-in redirect), heartbeats stop and the menu bar shows "disconnected" (it can only under-report, never falsely report connected). Reopening the kiosk restores it.

## Mac gate (for George to run)

1. Open the App and choose "Enter service mode (for the Pi)" in the menu bar. The brain hides; the menu bar shows "Service mode: Pi disconnected" (while the Pi is off).
2. Say "Hello Nous": the Mac must not wake. Press Alt+Command+N and Alt+Command+V: no brain and no voice. The Mac microphone and camera indicators must be off.
3. Start the Pi (kiosk). Within 30 s the menu bar changes to "Service mode: Pi connected". Submit a task and start a realtime call on the Pi and confirm they work.
4. Unplug the Pi network cable or shut down the Pi: after about 15–25 s it changes to "Service mode: Pi disconnected" (expiry is 25 s after the last heartbeat and heartbeats come every 10 s, so 15–25 s after unplugging, plus timer slack); after reconnecting it returns to "connected" within 30 s.
5. Quit and reopen the App: still in service mode, and the brain does not appear.
6. Choose "Return to Mac use": the brain appears; always-on wake listening and the camera resume per their saved settings; "Hello Nous" wakes the Mac.
7. Record PASS / FAIL and timing for each step in the [Pi test report](../experiments/RPI4_REMOTE_TERMINAL_REPORT.md).
