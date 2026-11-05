<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-family-recognition-2026-11-05.md) | [English](pi-family-recognition-2026-11-05.en.md)

# Family recognition (face and voice) and memory person UI on the Pi terminal: validation

Date: 2026-11-05. Branch `claude/pi-family-recognition` (based on main `6072f6c`). Status: **code and Linux cloud automated tests complete; Pi, stereo camera, real models and enrolled family members not tested.**

## Request and decisions (George, 2026-11-05)

Family recognition must work on the RPi, with both camera and voice. George's decisions:

1. The Pi uses the same stereo camera model as the Mac.
2. Always allow the Pi; no switch and no pairing.
3. Build the "Using X's memory" and "Not me" UI in this batch.

## Approach

| Part | Behaviour |
|---|---|
| Where it runs | Face (YuNet + SFace) and voice (CAM++) features were already computed in the page, with models served by URL from the Mac core. The Pi page computes features and sends them to the Mac core for matching; **only feature numbers travel, never frames or audio**. Matching and encrypted storage stay in the Mac core, and the page never receives scores |
| Recognition channel | `POST /api/terminal/identity` with `{terminal, request}`. Accepts only `ambient_status`, `ambient_probe`, `greeting`, `voice_probe`, `call_voice`; everything else (management screen, listing names, enrolment, deletion, calibration, voice tests) returns 403. Validation uses the same code as the Mac IPC (`shared/identity-validate.mjs`) with identical error messages. The core handles it with `userInitiated: false` |
| Memory channel | `POST /api/terminal/memory`. Accepts only `status`, `suspend`, `select` (without a management token), and `card_view` / `card_answer` (face candidate cards only; the answer can only be "decline"). Responses drop card, chat and suggestion content, so no memory text is sent. Typed chat with memory, memory suggestions and management stay Mac-only |
| Terminal name | Requests carry the kiosk URL's `terminal` (for example `rpi4`), used only to keep Mac and Pi recognition state apart, not as security. In principle any browser page on the Mac with `?terminal=` could call it too (George chose "always allow") |
| Per-page state | The core keeps each page's sampling evidence, latest face match, wake voice, in-call voice, multi-face time and rate limits separately, for up to 8 pages. The greeting rate limit and "one greeting per interaction" stay shared across the core. While the Mac's family recognition management screen is open, recognition pauses on every page (existing rule) |
| Memory person | The core has one current person. A new content-free SSE event `memory.presence_changed` tells every page; the Pi then rereads status, shows "Using X's memory", and offers saying or tapping "Not me" and picking a person |
| Pi page | Face recognition for look-to-talk, greeting by name, voice recognition at wake, in-call voice recognition and the memory person UI all use the new channels. The family recognition screen and memory management show "Do this in the Nous App on the Mac" on the Pi |
| Camera | No new way to turn it on: after the Mac menu turns the camera on, the Pi page opens the Pi camera itself (finding the same model by `NOUS_CAMERA_LABEL`). Chromium on the Pi asks once and George clicks "Allow"; the kit still uses no auto-grant flags |
| Pi performance | Terminal pages analyse camera frames every 160 ms (Mac 80 ms) and sample faces 2 times per second (Mac 4), putting conversation fluency first |
| Packaging | The Mac App runs `.mjs`, so the validators live in `shared/*.mjs`, re-exported by `desktop/identity-ipc.mjs` and `memory-ipc.mjs`; the App build now bundles these two files with esbuild |

Every new interface string has English (`src/messages.en.json`, `server/messages.en.json`).

## Automated tests (Linux cloud)

| Check | Result |
|---|---|
| `tests/terminal-identity.test.ts` (22 tests) | Allowed requests reach the core with `userInitiated: false` and the terminal name; other requests 403; invalid terminal name 400; malformed requests 400 with the same message as IPC; a core without family recognition 404; evidence from two pages neither satisfies nor overwrites the other; the memory channel accepts only the listed operations and returns no memory content; the SSE event makes the page reread status; channel choice on the page (App uses IPC, Pi uses HTTP, plain browser has none); terminal page camera and sampling intervals |
| Updated tests | `camera-privacy` (the only recognition URL and the allowed list are pinned), `family-view`, `memory-view` (terminal notes in Chinese and English), `sense-pipeline` (160 ms) |
| All | `npm run typecheck` passes; `npx vitest run` 141 files, 2592 passed, 5 skipped; `npm run build` passes; `node scripts/verify-aios.mjs` PASS |

## Not verified

- Actual recognition, greeting by name, voice recognition at wake and in-call voice recognition on the Pi.
- Whether the Pi camera label matches the Mac's `NOUS_CAMERA_LABEL`; the Chromium camera permission prompt.
- Whether conversation stays fluent on a Pi 4 with 160 ms camera analysis and 2 face samples per second.
- Whether voices enrolled with the Mac microphone are recognised through the Pi microphone.
- The packaged App (the two esbuild-bundled files).

## Pi test steps (for George)

1. Put the Mac in service mode and turn on the camera and always-on wake listening from the Mac menu.
2. The Pi kiosk asks for the camera the first time; click "Allow".
3. Look at the Pi screen and speak 10 times: record correct names, wrong names and no name, and whether "Using X's memory" appears.
4. Without looking at the screen, say "Hello Nous" 10 times: record how often you are named from voice (naming from voice alone is still limited by the existing calibration rule).
5. During a call, have another family member speak: record whether a voice candidate is proposed.
6. Say "Not me": confirm it switches back to the shared household memory.
7. Hold a 10-minute call and record dropouts and latency compared with the camera off; record `top` and temperature too.
8. Put the results in the [Pi test report](../experiments/RPI4_REMOTE_TERMINAL_REPORT.md).
