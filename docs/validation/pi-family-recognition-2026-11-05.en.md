<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-family-recognition-2026-11-05.md) | [English](pi-family-recognition-2026-11-05.en.md)

# Family recognition (face and voice) and memory person UI on the Pi terminal: validation

Date: 2026-11-05. Branch `claude/pi-family-recognition` (based on main `6072f6c`). Status: **code and Linux cloud automated tests complete (including the fixes from the same-day review); Pi, stereo camera, real models and enrolled family members not tested.**

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
| Memory channel | `POST /api/terminal/memory`. Accepts only `status`, `suspend`, `select` (without a management token), and `card_view` / `card_answer` (face candidate cards only; the answer can only be "decline"). Responses pick fields from an allow-list: status carries only the memory state (ready and so on), the current person, and each person's ID and name; `select` / `card_answer` also carry receipts and the "clear history" flag. Memory content, cards, chat, suggestions, fact counts, minor and face-link flags, service accounts and consents, and the suggestion switch are never sent. Typed chat with memory, memory suggestions and management stay Mac-only |
| Terminal name | Requests carry the kiosk URL's `terminal` (for example `rpi4`); terminal pages also send an `X-Nous-Terminal: <name>` header on every API request (missing or invalid means the Mac main window, `main`; `main` cannot be a terminal name). Both only keep each page's recognition and memory candidates apart and are not security: any local HTTP client on the Mac (not only pages) can call these routes with any name (George chose "always allow") |
| Per-page state | The core keeps each page's sampling evidence, latest face match, wake voice, in-call voice, multi-face time and rate limits separately, for up to 8 pages; beyond that it drops the least recently used terminal, never the Mac main window. All terminals together also share one rate limit (sampling 6 per second, wake voice 4 per second, in-call voice 2 per second, the same as the core-wide limits before this change), so switching names does not get around it; malformed requests neither create a page nor use up the limit. The wake window that relaxes the look-to-talk settings applies only to the page that started that wake call. The greeting rate limit and "one greeting per interaction" stay shared across the core. While the Mac's family recognition management screen is open, recognition pauses on every page (existing rule) |
| Memory candidates | The memory default person uses only the asking page's own recognition: typed chat on the Mac looks only at the Mac camera's candidate; a realtime voice call looks only at the page that started it (the core learns this from the header on `/api/realtime/start`). A face seen on the Pi never selects a person for the Mac, and the other way round |
| Memory person | The core has one current person and remembers which page selected it. Camera events (several faces, tracking lost) and a disagreeing in-call voice from another page do not suspend or undo it; the page that selected it still can. Idle for 30 minutes, computer lock and deleting a family member apply to every page. A new content-free SSE event `memory.presence_changed` tells every page; the Pi then rereads status, shows "Using X's memory", and offers saying or tapping "Not me" and picking a person |
| Pi page | Face recognition for look-to-talk, greeting by name, voice recognition at wake, in-call voice recognition and the memory person UI all use the new channels. Typed and spoken chat on the Pi does not use memory, so conversation replies say "No memory used" and show no person; the realtime voice line follows the core's per-call memory status (the same rules as the Mac). The family recognition screen and memory management show "Do this in the Nous App on the Mac" on the Pi |
| Camera | No new way to turn it on: after the Mac menu turns the camera on, the Pi page opens the Pi camera itself (finding the same model by `NOUS_CAMERA_LABEL`). Chromium on the Pi asks once and George clicks "Allow"; the kit still uses no auto-grant flags |
| Pi performance | Terminal pages analyse camera frames every 160 ms (Mac 80 ms) and sample faces 2 times per second (Mac 4), putting conversation fluency first |
| Packaging | The Mac App runs `.mjs`, so the validators live in `shared/*.mjs`, re-exported by `desktop/identity-ipc.mjs` and `memory-ipc.mjs`; the App build now bundles these two files with esbuild |

Every new interface string has English (`src/messages.en.json`, `server/messages.en.json`).

## Automated tests (Linux cloud)

| Check | Result |
|---|---|
| `tests/terminal-identity.test.ts` (37 tests) | Allowed requests reach the core with `userInitiated: false` and the terminal name; other requests 403; invalid terminal name 400; malformed requests 400 with the same message as IPC; a core without family recognition 404; evidence from two pages neither satisfies nor overwrites the other; memory candidates look only at the asking page (a Pi face selects no one for Mac typed chat or calls, and the other way round; the same page still selects); suspends and disagreeing voices from another page leave the current person alone; switching names does not get around the combined rate limit; the Mac's evidence is never pushed out; the wake window applies only to the same page; realtime sessions remember the page that started them; terminal page API requests carry `X-Nous-Terminal`; the memory channel returns only allow-listed fields, and the Pi's "About to use / Using X's memory" and "Not me" still render from the projected responses; Pi conversation replies say "No memory used"; the SSE event makes the page reread status; channel choice on the page (App uses IPC, Pi uses HTTP, plain browser has none); terminal page camera and sampling intervals |
| Updated tests | `camera-privacy` (the only recognition URL and the allowed list are pinned), `family-view`, `memory-view` (terminal notes in Chinese and English), `sense-pipeline` (160 ms), `family-greeting` (multi-face suspend carries the page source) |
| All | `npm run typecheck` passes; `npx vitest run` 141 files, 2607 passed, 5 skipped; `npm run build` passes; `node scripts/verify-aios.mjs` PASS |

## Not verified

- Actual recognition, greeting by name, voice recognition at wake and in-call voice recognition on the Pi.
- Whether the Pi camera label matches the Mac's `NOUS_CAMERA_LABEL`; the Chromium camera permission prompt.
- Whether conversation stays fluent on a Pi 4 with 160 ms camera analysis and 2 face samples per second.
- Whether voices enrolled with the Mac microphone are recognised through the Pi microphone.
- The packaged App (the two esbuild-bundled files).
- Whether memory candidates and suspends stay apart as described above when the Mac and the Pi are used at the same time (automated tests only).

## Known limitations

- There is still one "current person" for the whole core: once the Pi selects George, typed chat on the Mac also uses George's memory, and Mac camera events do not suspend it; to change it, pick a person on the Mac or press "Not me". Idle for 30 minutes and computer lock still suspend it.
- `X-Nous-Terminal` and `terminal` are only page labels: any local program can send any name, so they only keep recognition and memory candidates apart and do not restrict access.
- The main.ts wiring (which component uses which channel) is still checked by tests that read the source, not run in a real browser.

## Pi test steps (for George)

1. Put the Mac in service mode and turn on the camera and always-on wake listening from the Mac menu.
2. The Pi kiosk asks for the camera the first time; click "Allow".
3. Look at the Pi screen and speak 10 times: record correct names, wrong names and no name, and whether "Using X's memory" appears.
4. Without looking at the screen, say "Hello Nous" 10 times: record how often you are named from voice (naming from voice alone is still limited by the existing calibration rule).
5. During a call, have another family member speak: record whether a voice candidate is proposed.
6. Say "Not me": confirm it switches back to the shared household memory.
7. Hold a 10-minute call and record dropouts and latency compared with the camera off; record `top` and temperature too.
8. Put the results in the [Pi test report](../experiments/RPI4_REMOTE_TERMINAL_REPORT.md).
