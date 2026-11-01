<!-- bilingual: source=zh-TW -->

> [繁體中文](audio-devices-2026-11-01.md) | [English](audio-devices-2026-11-01.en.md)

<a id="聲音輸入輸出裝置選擇驗證"></a>
# Validation: choosing the sound input and output devices

Date: 2026-11-01, Asia/Taipei. Branch: `claude/audio-devices` (based on main `58af745`). Purpose: let George choose, from the menu bar and the in-page settings, which microphone Nous uses and which speaker it plays through, for example a Bluetooth speaker.

**This is not hardware acceptance.** All tests below ran in a cloud container with fixtures (fake MediaDevices, fake playback elements with `setSinkId`, fake clocks); **not on a Mac, not with a real microphone, not with a Bluetooth speaker**. The Electron menu was tested only as a pure template function and was not run. The Mac steps in section 7 have not been run.

<a id="1-george-的決定2026-11-01"></a>
## 1. George's decisions (2026-11-01)

| # | Decision | What this batch does |
|---|---|---|
| 1 | System read-aloud (`speakText` in voice mode, SP-03a calibration stranger voices) stays on the macOS system output; Web Speech recognition for push-to-talk and voice mode stays on the system input; both interfaces show a hint | Browsers do not let `speechSynthesis` or Web Speech choose a device, so they are unchanged. The bottom of both menu bar submenus and the “Sound” section of the in-page settings say “Push-to-talk and system read-aloud (voice mode, stranger voices in calibration) always use the Mac's system input/output” |
| 2 | When the chosen microphone is missing (wake start or automatic resume, calls, family voice enrollment), fall back to the system default microphone with an honest caption and status; switch back when it returns (wake re-opens while idle) | `openMic`: exact deviceId → device with the same name → system default (`fallback`). Caption and status “Can't find “X”; using the system default for now” (once per choice). When `devicechange` shows it again, `input_returned` fires and always-on listening re-opens while idle. This deliberately replaces the former rule “no switching to another microphone” in `src/audio/front-end.ts`; its comment, item 5 of section 3 in the [WK-01a validation](wk-01a-2026-10-31.en.md), and the “Failure” row of [ADR-0003](../adr/ADR-0003-local-wake-and-voice-recognition.en.md) are revised to match |
| 3 | Changing the microphone during a call takes effect from the next call (caption “from the next call”); changing the speaker applies immediately | Changing “Sound input” during a call: the page captions ““X” will be used from the next call”, and always-on listening switches its source only after the last lease is returned. Changing “Sound output”: `audioDevices` immediately calls `setSinkId` on the playing `<audio>` elements and on the earcon's `AudioContext` |

<a id="2-交付內容"></a>
## 2. Deliverables

All paths are under `prototype/ambient-shell/`.

| File | Contents |
|---|---|
| `shared/audio-devices.ts` (new) | `AudioPrefs`, `parseAudioPatch` (four keys; deviceId is visible ASCII up to 256 characters, names up to 128 characters without control characters), `DEVICE_ID` (moved from `shared/wake.ts`), the sanitizing rules for the page report `sanitizeAudioMenuReport` (at most 24 devices per kind, allowlisted status lines), and the status lines `inputStatus`/`outputStatus` and text shared by both interfaces |
| `server/audio-settings.ts` (new) | `AudioSettingsStore`: `configDir/audio.json` (`PrefsFile`, 0600, atomic writes). `null` = system default; an unreadable file means all `null`. Not tied to any flag. The old `device_id` in `wake.json` is **not migrated**: WK-01a always opened the system default when switched on, so that value was just the default microphone at the time, and migrating it would pin every path to that microphone |
| `server/app.ts`, `server/nous.ts`, `shared/types.ts` | `GET /api/settings` gains `audio: { prefs, write_path: "/api/settings/audio" }`; `POST /api/settings/audio` validates, saves, and broadcasts `settings.updated` through `onChange` |
| `src/audio-devices.ts` (new) | The only place in the renderer that calls `getUserMedia({ audio })` (`openMic`) and the only place that calls `setSinkId` (`applySink`). `AudioDevices`: preferences, the `enumerateDevices` + `devicechange` roster, open tracks and playback elements; “in use” comes only from `track.getSettings().deviceId` and the element's `sinkId`. With the system default the constraints are exactly as before and `setSinkId` is not called |
| `src/audio/front-end.ts`, `controller.ts`, `earcon.ts`, `index.ts` | Always-on listening no longer opens the microphone itself; it uses the `MicOpener` injected by `main.ts` (`src/audio/` is still loaded only with `NOUS_WAKE=on` and still does not import the new file). `reopen()`: re-opens while idle and waits for the last lease during a call. When a chosen microphone's track ends, it re-opens once (falling back to the system default if missing); when the system default microphone ends it still goes to `error device_ended`. The earcon goes through the injected `output.sink(ctx)`: tones are scheduled only once the sink resolves (waiting at most 1 s), the timer starts after scheduling, and the `AudioContext` closes only after both tones, so a slow Bluetooth sink does not clip them; cancel works at any time. `device_id` is no longer saved (`saveDeviceId` removed) |
| `src/realtime.ts`, `src/main.ts`, `src/speaker/recorder.ts` | The microphone for both realtime routes and for family voice enrollment goes through `audioDevices.openInput()`; the remote `<audio>` element goes through `audioDevices.sink()`; the enrollment “start now” chime opens its own short-lived `AudioContext`, routes it to the output and releases it after the beep (the capture `AudioContext` is never registered as an output). Captions: microphone not found, speaker ““X” disconnected; playing through the system default instead”, “Playing through “X” again”, and “from the next call”. A device chosen before permission (no name) gets its name once the roster has names (the patch carries the deviceId too; done only on success, retried 30 s after a failure). “In use” updates as soon as a microphone track is stopped |
| `src/views.ts` | The “Sound” section of the settings screen (both the browser version and the account page inside the App): two drop-downs (first item “System default (now: X)”), the device in use, and two hints; before permission “Device names appear after you allow microphone access” |
| `desktop/settings-menu.mjs`, `desktop/main.mjs`, `desktop/preload.cjs` | A “Sound” section in the menu bar's “Camera and voice settings”: two radio submenus “Sound input: …” and “Sound output: …” (system default first, then the devices, then the two hints), each followed by a disabled status row (“In use: X” or “Can't find “X”; using the system default for now”). The preload forwards only the sanitized roster (≤24 per kind, ASCII id ≤256, name ≤128, allowlisted status lines) and `main.mjs` sanitizes again; a click POSTs to `write_path` |
| `src/messages.en.json`, `shared/messages.en.json`, `desktop/messages.en.json` | English for the new interface text and error messages; device names are not translated |

<a id="3-設計"></a>
## 3. Design

<a id="31-麥克風"></a>
### 3.1 Microphone

- Order: `deviceId: { exact }` → a listed device with the same name (when the deviceId changed) → the system default without a deviceId (`fallback: true`). Other errors, such as denied permission, are passed on and no other device is tried.
- Used by: both realtime routes (opened directly with the flag off; leased from always-on listening with the flag on), always-on listening, and family voice enrollment.
- Status line: “In use: X” while a microphone is open (X from the track's actual deviceId); “Can't find “X”; using the system default for now” when the chosen device is missing; “No microphone is open right now” otherwise. A checked item means only the saved choice. Before the page reports the device list, the chosen device is shown as “X (not reported yet)”, not as missing.

<a id="32-聲音輸出"></a>
### 3.2 Sound output

- `applySink`: no `setSinkId` call for the system default (a new element is already `""`); only an element previously routed elsewhere is set back to `""`. A chosen device that is not in the roster is not tried; a device with the same name is used instead, otherwise the system default.
- Targets: the realtime remote audio (the `<audio>` of both routes), the wake earcon's `AudioContext`, and the family voice enrollment chime. Capture graphs connect a zero-gain node to `destination`; they make no sound and are out of scope.
- “The missing microphone is back” is announced once, only when it goes from absent to present, debounced by 500 ms (plugging a device often fires `devicechange` in bursts); while it stays listed without being switched back, it is not announced again. Roster reads carry a generation number and late stale results are dropped. `output_fallback` is computed from all live playback elements (any one on the system default counts).
- Bluetooth speaker disconnect: `devicechange` re-reads the roster and re-applies; playing elements fall back to the system default with the caption ““X” disconnected; playing through the system default instead”; on reconnect they switch back with “Playing through “X” again”. The browser cannot tell whether a device is Bluetooth, so the caption does not say “Bluetooth”. A speaker that was simply off when the App started does not count as disconnected (no caption; the status says it cannot be found).

<a id="33-不能選裝置的部分"></a>
### 3.3 What cannot choose a device

`speechSynthesis` (voice-mode read-aloud, SP-03a calibration stranger voices) and Web Speech recognition (push-to-talk, voice mode) use the macOS system default inside Chromium; the web APIs cannot target a device. Both interfaces say so. To send them to the Bluetooth speaker as well, change the system output in macOS System Settings → Sound.

<a id="34-藍牙耳機當麥克風"></a>
### 3.4 A Bluetooth headset as the microphone

Opening a Bluetooth headset's microphone makes macOS switch it to the HFP call mode, which noticeably lowers sound quality and also affects playback on the same headset. The hint recommends keeping the microphone on the Mac and choosing the Bluetooth speaker as output; the choice is not blocked.

<a id="35-旗標關閉"></a>
### 3.5 Flag off

`settings.audio` is not tied to any flag and is always present; it is the second deliberate exception to the `tests/wake-flag-off.test.ts` snapshots (the first is F6 cost records). The test removes the `audio` field before comparing; everything else is still byte-identical and the snapshots were not updated.

<a id="4-與規劃不同之處"></a>
## 4. Differences from the plan

1. Always-on listening follows the “Sound input” setting, whose default is the system default: reacquiring after Web Speech or after waking uses the system default instead of the previous deviceId as an exact constraint. The old `device_id` in `wake.json` is not migrated (independent review m2: WK-01a always opened the system default when switched on, so that value was just the default microphone at the time; migrating it would pin every path to that microphone). To fix a particular microphone, choose it under “Sound input”.
2. While wake listening, an unplugged chosen microphone is re-opened once with the system default (decision 2 extended to unplugging while listening); when the system default microphone ends, the old `device_ended` stays.
3. The in-page “Sound” section is also drawn on the account page inside the App (which otherwise keeps settings in the menu bar), because this request asks for both interfaces.
4. The two status lines in the menu bar are computed by the page and passed through `reportState` (only allowlisted sentences); the menu bar does not recompute them, so the two interfaces cannot disagree.
5. The disconnect caption is always ““X” disconnected; playing through the system default instead”, because whether a device is Bluetooth cannot be determined reliably.

<a id="5-測試"></a>
## 5. Tests

Run in `prototype/ambient-shell/`.

| File (cases) | Contents |
|---|---|
| `tests/audio-devices.test.ts` (27, new) | `openMic`: system-default constraints identical to before (realtime, and enrollment with `video: false`), exact, recovery by name, fallback to the system default when missing, no fallback on permission errors; `applySink`: no call for the default, choose and switch back, back to the default when not listed, honest report without support; `AudioDevices`: aliases removed from the roster, in-use only from the track and sinkId, output change applied immediately, Bluetooth disconnect and reconnect, a missing microphone reported once and its return, no names before permission, at most 24 per kind, no disconnect caption at App start, the “back” announcement debounced and sent once per burst, a late stale roster dropped, `output_fallback` over all elements, in-use updated as soon as a track stops; earcon: tones only after the sink resolves, closed only after the tones, played on the default after waiting 1 s, cancel; the enrollment chime registers only its own short-lived context; `labelBackfill`; `sanitizeAudioReport` and the status lines |
| `tests/audio-settings.test.ts` (6, new) | `parseAudioPatch`; `audio.json` defaults, 0600, names cleared when choosing the default, unreadable means `null`; `/api/settings/audio` validation, saving and `settings.updated`; with `NOUS_WAKE=on` the old `wake.json` `device_id` is not migrated and no `audio.json` is created |
| `tests/audio-front-end.test.ts` (41, previously 37) | Microphones now open through a real `AudioDevices` (fake MediaDevices); new: fallback to the system default when missing, re-open while idle when it returns, a microphone change during a call waits for the lease to be returned, re-open after unplugging while listening; the controller follows “Sound input” and no longer saves `device_id` |
| `tests/audio-privacy.test.ts` (13) | Only `src/audio-devices.ts` calls `getUserMedia({ audio })` (each line pinned); every sounding `new Audio()`/`destination` goes through `audioDevices.sink` or the injected earcon output; `setSinkId` only in `src/audio-devices.ts`; the preload “Sound” report equals what `shared` and `settings-menu.mjs` produce |
| `tests/desktop-menu.test.ts` (29, previously 24) | “Sound” section: text equal to `shared`, drawn only when the core provides `audio`, radio order and the patches sent on click, a missing choice still listed and disabled, no report yet and no names, English translates interface text but not device names |
| `tests/settings-view.test.ts` (18, previously 13) | Browser and App: two drop-downs, a missing choice still listed, in-use and hints; a choice sends the id and name, the system default sends `null`; the hint before permission; “not reported yet” before the list is read; English |
| `tests/wake-flag-off.test.ts` (5) | With `settings.audio` removed, byte-identical to the base `9778b41` snapshots; separately checks that `audio` holds the defaults |

See section 9 for the full-suite result.

<a id="6-現在不能驗證的"></a>
## 6. What cannot be verified yet

- Whether Electron 44 on macOS needs extra permission for `HTMLMediaElement.setSinkId` and `AudioContext.setSinkId` (the current permission check handler allows `media`; `Permissions-Policy` does not restrict `speaker-selection`).
- When Chromium fires `devicechange` after a Bluetooth speaker disconnects, and whether a playing element is briefly silent before it is re-applied.
- Whether `enumerateDevices` inside the App returns names before microphone permission.
- Echo: whether realtime echo cancellation still works with a Bluetooth speaker (higher latency).

<a id="7-mac-步驟"></a>
## 7. Mac steps (not run yet)

1. Turn on the Bluetooth speaker and pair it in System Settings → Bluetooth; confirm macOS can play through it. Keep the macOS system output on the Mac speakers.
2. Start the App, open “Camera and voice settings” in the menu bar, and confirm the “Sound” section at the end; the “Sound input” and “Sound output” submenus list the Mac microphone, the Mac speakers and the Bluetooth speaker (readable names), with “System default (now: …)” first.
3. Choose the Bluetooth speaker under “Sound output”. Start realtime voice; Nous's replies should come from the Bluetooth speaker and the status row should read “In use: <speaker name>”. Switch back to the system default during the call; replies should immediately come from the Mac speakers.
4. Echo check: output on the Bluetooth speaker, microphone on the Mac, speaker in its usual place. Say something and let Nous answer; confirm Nous does not take its own reply as the user speaking (it does not answer itself and is not interrupted). Note the distance between the speaker and the Mac.
5. Turn off the Bluetooth speaker during playback: caption ““<name>” disconnected; playing through the system default instead”, the sound moves to the Mac speakers, and the status reads “Can't find “<name>”; using the system default for now”. Turn the speaker on again: caption “Playing through “<name>” again”.
6. Open the in-page settings (the “Accounts and sign-in” page inside the App, or the browser settings) and confirm the “Sound” section's two drop-downs, the device in use and the two hints; after changing a choice the menu bar follows.
7. With a USB microphone: choose it under “Sound input”, then choose another one during a call; ““…” will be used from the next call” should appear and this call should not switch; the next call uses the new one. Unplug the chosen microphone and start a call: caption “Can't find “…”; using the system default for now” and the call works; after plugging it back in, the next call uses it again. With `NOUS_WAKE=on`, wake listening switches back while idle.
8. Voice mode (Web Speech) and the SP-03a calibration stranger voices still speak through the macOS system output, as the hint says.
9. The wake earcon (`NOUS_WAKE=on`) plays on the chosen output.

<a id="8-風險與限制"></a>
## 8. Risks and limitations

- Choices are saved by deviceId; Chromium deviceIds are usually stable per origin, and a changed id is recovered by the saved name. With two devices of the same name, the first in the roster is used.
- Bluetooth speaker latency may weaken echo cancellation; step 4 of section 7 must confirm it on the Mac.
- System read-aloud and Web Speech do not follow the choice (George's decision 1).

<a id="9-結果與下一個-gate"></a>
## 9. Results and next gate

Cloud container: `npm run typecheck` passes; `npx vitest run` passes 2222 cases in 119 files, with 5 skipped (existing environment-dependent cases that run only on macOS, with installed models, or with a usable file lock); `npm run build` passes. Next gate: the Mac steps in section 7, especially Bluetooth playback, disconnect and reconnect, and the echo check.
