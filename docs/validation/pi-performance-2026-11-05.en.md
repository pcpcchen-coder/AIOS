<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-performance-2026-11-05.md) | [English](pi-performance-2026-11-05.en.md)

# Per-device display performance setting (Pi terminal) validation

Date: 2026-11-05. Branch `claude/pi-performance` (based on main `190aa83`). Status: **code and Linux cloud automated tests complete; FPS and CPU improvement on a real Pi not measured.**

## Request (George, 2026-11-05)

The RPi works but has performance problems. Add a settings interface, used on the RPi device, to tune performance. Tuning must not affect conversation fluency.

## Approach

Judging from the code, the page's main load is the display: the Canvas 2D brain (`src/brain.ts`) and the interface's CSS background blur (`backdrop-filter`). The setting changes only these two; listening, playback, realtime voice, speech recognition, cues, the processing sound, SSE and the heartbeat are untouched.

The settings screen gains "Display performance on this device" with three choices:

| Choice | Frames per second cap | Resolution cap (devicePixelRatio) | Light pulse cap | Glow | Background blur |
|---|---|---|---|---|---|
| Full | 30 | 2 | 70 | Full | On |
| Balanced | 20 | 1 | 40 | Full | Off |
| Light | 12 | 0.75 | 20 | Simplified (no `shadowBlur`, half the node glow, smaller pulse sprites) | Off |

- "Full" equals the previous rendering. The system "reduce motion" setting still gives the previous ~10 frames per second.
- Every choice keeps region lighting, light pulses and region names (the brain requirement in CLAUDE.md).
- With background blur off, the backgrounds behind text become more opaque so text stays legible.
- The choice is stored in that device's browser `localStorage` (`nous.performance.v1`), so each device remembers its own and nothing is sent to the core. When unset, a Pi kiosk page with a valid `?terminal=` defaults to "Balanced"; everything else (including the Mac App) defaults to "Full", so Mac behaviour is unchanged.
- A choice applies immediately without a reload.
- The same section shows the brain's measured numbers: frames per second and milliseconds per frame over the last ~2 s (timing `step` plus `draw` with `performance.now()`), labelled "Measured". It refreshes once per second while the settings screen is open.
- Frames per second is a cap. On a 60 Hz display a frame can only change on a display refresh, so "Light" runs at about 10 frames per second; the measured number shows the real value.

Every new interface string has English through `src/messages.en.json`.

## Automated tests (Linux cloud)

| Check | Result |
|---|---|
| `tests/performance.test.ts` (15 tests) | Choice table, defaults for each URL and inside the App, save and reload, invalid stored values, `localStorage` throwing, applying; import check: runtime imports of `src/performance.ts` and `src/brain.ts` reach no audio, realtime, speech, wake, processing sound, heartbeat, API or `main` module |
| `tests/brain-performance.test.ts` (8 tests) | Fake rAF: Full, Balanced and Light stay at or under 30 / 20 / 12 frames per second and within 5% of the cap; reduce motion stays at 10; canvas size follows the resolution cap live; pulse caps and trimming on switch; in Light the active region still draws its name, light pulses and region glow, without `shadowBlur` |
| `tests/performance-settings-view.test.ts` (9 tests) | The section shows in both the browser and App settings screens, in Chinese and English; clicking a choice calls apply; the measured readout updates; every new string has English |
| All | `npm run typecheck` passes; `npx vitest run` 137 files, 2487 passed, 5 skipped; `npm run build` passes; `node scripts/verify-aios.mjs` PASS |

## Not verified

- Actual frames per second, CPU and temperature improvement on a Pi 4 are not measured.
- Not viewed in a real browser: text legibility without blur and the look of the simplified glow.
- Persistence of `localStorage` in the Pi kiosk's dedicated profile is untested.
- "Does not affect conversation fluency" is supported only by code structure (only rendering changed, import check), not by measurement.

## Pi test steps (for George)

1. On the Pi page, say or tap "Settings", find "Display performance on this device", and note the current choice (should be "Balanced" the first time) and the measured numbers.
2. Choose "Full", "Balanced" and "Light" in turn, one minute each, noting measured frames per second and milliseconds per frame; meanwhile run `top` and `vcgencmd measure_temp` on the Pi and note Chromium CPU and temperature.
3. Pick the smoothest choice, hold a 10-minute realtime call, and record dropouts, latency and response speed compared with before.
4. Reboot the Pi and confirm the choice is kept.
5. Put the results in the notes column of the measurement table in the [Pi test report](../experiments/RPI4_REMOTE_TERMINAL_REPORT.md).
