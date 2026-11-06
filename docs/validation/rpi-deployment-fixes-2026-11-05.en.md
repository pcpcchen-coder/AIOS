<!-- bilingual: source=zh-TW -->

> [繁體中文](rpi-deployment-fixes-2026-11-05.md) | [English](rpi-deployment-fixes-2026-11-05.en.md)

# Pi deployment fixes and hardware validation

Date: 2026-11-05, Asia/Taipei. This record covers the evening's deployment integration, fixes, and observations on one device. Upstream supplies the display-performance menu and Pi identity API; this batch fixes their integration with Pi-local camera preferences, service mode, and actual sampling cadence. Historical cloud-validation records retain their original verdicts.

## Test setup and data scope

- Raspberry Pi 4, 64-bit Debian/Raspberry Pi OS desktop, Chromium kiosk, and the Mac Nous core through SSH loopback forwarding.
- USB CCB stereo camera, capture index 0. The other video node carries metadata, not a second capture stream.
- USB EMEET OfficeCore M0 Plus microphone/speaker. The previous voice enrolment used a reSpeaker on the Mac.
- Raw images, recordings, voice feature vectors, family enrolment data, accounts, keys, and private deployment settings are excluded from the repo. This record contains only code, status metadata, and user confirmations.

## Code fixes

| Problem | Final behavior |
|---|---|
| The Pi page inherited the Mac global camera switch | `terminal-camera.ts` owns local preferences only with no App preload and exactly one valid `terminal=<id>` parameter. It stores them under `nous.terminal.<id>.camera.v1` in that Chromium profile's `localStorage` (existing `rpi4` data keeps working), initially off. The core still supplies installation enablement, label, and geometry. The Pi switch does not call the global enable API; the native Mac restriction remains. A failed off-state save still stops capture in the current page |
| Chromium had permission but hung during camera enumeration | The kiosk adds `--disable-features=WebRtcPipeWireCamera`. PipeWire audio, the existing profile, and Chromium permission prompts remain. No automatic media-permission flag is used |
| The Mac camera being off made Pi recognition report `ready=false` | Core camera eligibility follows the source page. GET/POST settings responses and SSE hello/settings.updated retain the source. Mac management keeps main-window rules, and switching the Pi-local camera off still stops face recognition |
| Pi sampling starts at least 500 ms apart, while the core reset evidence beyond 500 ms | Terminal ambient evidence uses a 2000 ms maximum gap and freshness limit. Mac/management retain 500/1000 ms. Three same-person frames in the same scope remain required. Person changes, quality failures, multiple faces, or track/epoch/gallery changes still reset evidence. Similarity thresholds are not lowered |
| Voice added the assistant name when nobody was recognised | Chinese and English instructions distinguish Hello/Hey Nous as addressing the assistant, not a user introduction. Opening names come only from the core's sentence. `live:greeting_mismatch` records deviations with normalized exact equality; existing permissive conversation filtering remains. The marker contains no sentence, name, or audio and does not block already-played audio. Interruptions, paraphrases, or transcript typography differences such as fullwidth versus ASCII characters can also trigger it. Prompt changes are not deterministic audio enforcement |

SSE terminal names remain source markers, not a new pairing or authentication mechanism. Model, encryption, management-session, and native Mac enablement checks remain.

### Post-review fixes

- Naming preferences follow the Pi: the Pi-local look-to-talk, greet-on-look and naming preferences previously had no effect on the core, which still read the Mac's `camera.json`. The Pi page now adds `page` to the `POST /api/terminal/identity` envelope (not to the request shape shared with the Mac IPC): four booleans for the three preferences the page actually applies and whether its camera is really running. Extra keys, missing keys or wrong types return 400. The core decides each terminal's ambient recognition and naming from that terminal's latest report; a terminal that has not reported is treated as all preferences off and camera inactive. The Mac main window keeps using `camera.json`. The page sends a report when its preferences or camera state change, and resends it with each heartbeat so it recovers after a core restart.
- Camera state is no longer assumed available: a terminal's `settings.identity` and `ambient_status` previously only checked whether the Mac camera feature was enabled, so they claimed readiness while the Pi camera was off. They now require that terminal's report to say its camera is running, and a change in that state triggers a settings update.
- The terminal id is no longer hard-coded to `rpi4`: any single valid terminal id can own local camera preferences, each stored separately.
- Memory naming also follows the asking page: whether a voice-call memory confirmation question includes the person's name previously always read the Mac's `camera.json`. It is now decided by the page the call is on: the Mac main window still reads `camera.json`, a terminal reads its own latest page report, and no report means no name. Fixture tests cover Pi off with Mac on, Pi on with Mac off, and no report.
- The tests are fixtures (synthetic features, fake clock, fake fetch): no naming when the Pi turns naming off while the Mac has it on; naming allowed when the Pi has it on while the Mac has it off; no report means not ready and no naming; a camera that is off limits status; the Mac is unaffected by terminal reports; envelope validation; and a `kitchen` id alongside existing `rpi4` data. Not yet retested on the Pi hardware.

## Observations on the tested device

| Check | Evidence and result |
|---|---|
| Basic camera and voice operation | The user confirmed camera preview, starting voice by facing the screen, replies through EMEET, and camera off/reopen. This is head-facing activation, not calibrated eye tracking |
| Service mode | The Mac menu showed Pi connected, with an actual `rpi4` page heartbeat at the core. After service mode was restored, local Mac capture paused while the Pi continued using its own peripherals |
| Face naming | The user heard the enrolled member's name. The core greeting decision was `ok`, with 6 continuous frames spanning 8347 ms and the latest frame 1500 ms old. Earlier `not_eligible`, `collecting`, and `stale` outcomes remain recorded failures, not retroactive passes |
| Actual Pi sampling | A same-track, single-face, `quality=ok` pair was captured 1405 ms apart, exceeding the former 500 ms limit. The 2000 ms policy is a bounded device setting, not a measured optimum or accuracy calibration |
| Greeting misaddressed with the assistant name | The user originally heard the assistant name appended to an unnamed template. After the change, a wake-only test while looking away confirmed that the assistant name was no longer used to address the user. This observation does not guarantee verbatim output in every future turn |
| Mac EMEET voice self-test | After the same USB EMEET re-recorded five wake-word and three reading segments for the existing member on the Mac, the user confirmed both wake-word and short-sentence self-tests identified the target |
| Pi voice-only naming | After EMEET returned to the Pi, the user looked away, said only the wake word, and confirmed the target's spoken name. The core reported keyword `matched`, `voice_only_test` fusion, 0 face-evidence frames, and an `ok` greeting. The pre-greeting utterance was `too_short`; this does not establish in-call voice matching, other members, or other microphones |
| Display settings | All three profiles switched and persisted after reload. The device was left on Light; the default remains Balanced. A 1280×720/60 Hz trial gave no user-perceived speedup, so the original 1920×1080/about 55.758 Hz mode was restored. There is no publishable speedup number |
| Automated checks | The last pre-deployment `node scripts/verify-aios.mjs` run passed with 146 files, 2688 passed tests, and 3 skipped, including typecheck, build, and an isolated mock HTTP journey. These are not hardware-accuracy evidence |
| Pre-publication kit check | Kit dry-run and shellcheck were rerun in a Linux/Pi environment with fake commands, with 103 checks passing. This test did not reinstall packages or operate real services |
| Publication checkout checks | Full verification passed again in the final checkout with 146 test files, 2686 passed tests, and 5 skipped. Unlike the pre-deployment run, `dist` and `desktop/build/app` did not exist when tests started, so two optional artifact checks skipped. After building the App, `wake-privacy` passed 9 tests with 1 skip because `public` was absent. The static voice-enrolment test now uses `fileURLToPath` to handle URL encoding in Chinese paths; product runtime behavior is unchanged |
| Device health | `aios-doctor` reached 16 PASS checks. Other readings included temperature WARNs at about 53–72°C, with observed `get_throttled` at `0x0`. This is not a long-duration stress or thermal acceptance test |

## Voice re-enrolment procedure

Successful naming after moving from enrolment with a different microphone to the actual EMEET supports checking the enrolment device first. Cross-microphone accuracy was not measured, so device differences cannot be treated as the only possible cause. Thresholds were not lowered to remove `unknown` results.

1. Back up encrypted family data. The current flow replaces that member's voice enrolment rather than adding a second simultaneous device template. Face data remains.
2. Pause the Pi kiosk and wake listening, temporarily connect EMEET to the Mac, then choose Return to Mac use.
3. Select the USB EMEET explicitly in Nous Sound input, avoiding reSpeaker or the Bluetooth entry.
4. Open Family recognition from the native Mac menu. Select the existing member, have that person complete five wake-word and three reading segments, and confirm saving. Run Test voice afterward.
5. Return EMEET to the Pi and restore the original sound-device preferences. Enabling wake from off requires the native Mac menu and explanation confirmation; HTTP enablement returns 403.
6. Return the Mac to service mode, start the Pi kiosk, and verify the Pi's actual EMEET input and heartbeat.
7. Test voice-only naming while looking away, then test look-to-talk separately. Match core voice/face evidence sources with the name actually heard. A spoken reply alone does not establish identification.

## Operational adjustments and limits

The [kit guide](../../terminals/rpi4/README.en.md) lists installation and service commands. On the tested desktop, `Ctrl+Alt+Delete` opens the shutdown menu and `Ctrl+Alt+T` opens a terminal. Use `systemctl --user stop aios-kiosk.service` to pause full screen and `start` to resume. The service restart policy reopens a window closed only with `Alt+F4`.

Tunnel boot startup, desktop autologin, and kiosk desktop autostart are configured. The last reboot test was 2026-11-03 and was not repeated this evening. Operation after resolution changes, page restarts, and camera off/reopen was observed; this does not establish support for every freshly installed OS image.

Cold model startup, insufficient/stale samples, or multiple faces can still produce unnamed greetings. Voice naming uses the existing test switch and uncalibrated thresholds. This record does not measure stranger false matches, multiple users, multiple microphones, or long-term behavior. Accounts, encrypted family files, private device identifiers, recordings, raw vectors, and local deployment backups remain on the original devices and are not part of this repo change.
