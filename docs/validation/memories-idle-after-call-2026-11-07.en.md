<!-- bilingual: source=zh-TW -->

> [繁體中文](memories-idle-after-call-2026-11-07.md) | [English](memories-idle-after-call-2026-11-07.en.md)

# Resume memories after an automatic call end

Date: 2026-11-07, Asia/Taipei. The user reported that the Pi stayed idle long after a conversation without starting the slideshow and confirmed that the text input remained open.

## Cause and fix

The realtime `onClosed` callback in `src/main.ts` always dispatched `input.open`. Normal automatic endings from the idle or call-duration guard therefore opened an empty input. `memoriesBusy()` treats `shell.listening` as busy, clearing the idle start time on every check.

A diagnostic invocation of the actual callback on the Pi reproduced `busy`: the other eleven busy conditions were false, and only input was true. The diagnostic used a synthetic call-end event without opening a microphone or calling a model.

The fix applies only to automatic `idle`/`max_duration` endings: close only the empty input with `input.close` when there is no draft or open Surface, returning to ambient when no other work remains. This preserves the foreground task and its expected result presentation; `dismiss` would clear that ownership. Existing call cleanup and the reason subtitle remain. Real errors retain input recovery; user drafts and open views are preserved. Camera-facing conditions, voice billing guards, and media permissions are unchanged.

This batch also records the previously deployed Pi-only 1.5x brain baseline. Only a page without the desktop bridge and with `terminal=rpi4` uses enlargement; the Mac default remains 1. Geometry, hit testing, and caption placement share the radius. The existing 500-record disk-write test retains its assertions with a 15-second Mac time budget.

## Regression evidence

`scripts/verify-memories-idle-close.mjs` starts an isolated mock core and synthetic PNG and loads the real built frontend. A temporary, non-pausing CDP breakpoint invokes the actual module `onClosed`, followed by input and memories-state observations. No production test API is added. The harness uses no private photos, real account, microphone, or model.

| Scenario | Before | After |
|---|---|---|
| Idle auto-end without a draft or Surface | Input open, `busy` | Input closed, then `showing` after idle |
| Duration-limit auto-end without a draft or Surface | Input open, `busy` | Input closed, then `showing` after idle |
| Real error | Input recovery available | Same behavior |
| User draft | Draft retained, slideshow blocked | Same behavior |
| User has settings open | View retained, slideshow blocked | Same behavior |
| Foreground task is running | Task can finish, but empty input opens | Only input closes; task ownership and completion presentation remain |

The original two automatic-end cases fail before the fix. Afterward, all six pass with zero page errors. The fixture advances a fake clock past the configured idle period; this is not a hardware performance measurement. The same product fix also passes types, the existing full suite, build, and isolated mock HTTP. Pi scaling has a separate geometry/hit test.

### Rerun

Install prototype and desktop development dependencies, then build the App contents:

```bash
npm ci --prefix prototype/ambient-shell
npm ci --prefix prototype/ambient-shell/desktop
npm run build --prefix prototype/ambient-shell/desktop
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium node scripts/verify-memories-idle-close.mjs --output /tmp/memories-idle-report.json
```

Install Playwright separately. Without `CHROMIUM_PATH`, its own browser is used. `--web /path/to/older/web` checks an older bundle while still requiring the current built desktop core. The script fails if it cannot locate the callback in a build; an unexecuted case is not a pass.

## Specific Pi verification and deployment limits

The fixed App is installed on the Mac core, and Pi reloads the same new frontend asset. After the actual Pi main program receives a synthetic `idle` end event, the empty input remains closed. With a real clock and the existing 60-second idle setting, `showing` is observed at about 70 seconds and media decode readiness at about 76 seconds. Diagnostics read boolean state only, without reading image content, filenames, URLs, captions, or saving private screenshots. These instrumented timings are not a performance benchmark or end-to-end validation of a new real voice conversation.

Temporary diagnostics, the localhost debugging port, and forwarding are removed. The original kiosk launcher hash is unchanged; kiosk and tunnel remain active, and the device reports no throttling. A complete pre-update App backup is retained. Private media and sign-in settings are excluded from the repository.
