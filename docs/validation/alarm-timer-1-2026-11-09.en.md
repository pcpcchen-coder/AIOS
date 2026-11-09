<!-- bilingual: source=zh-TW -->

> [繁體中文](alarm-timer-1-2026-11-09.md) | [English](alarm-timer-1-2026-11-09.en.md)

# Timers and ring framework ALARM-1 (2026-11-09)

On 2026-11-09 George asked for "alarms" and "timers". Following George's decision this is split into two batches: this batch, ALARM-1, is timers plus the ring framework; ALARM-2 is alarms (one-off and repeating, snooze, missed-alarm handling, management in settings). Branch `claude/alarm-timer`, based on main `f00285b`.

**Evidence level:** Linux cloud unit and integration tests and headless Chromium only (fake clock, simulated realtime voice, simulated pages). **Nothing was run on the Mac or the Pi.** Actual sound from the speakers, Bluetooth speakers, Mac sleep, notifications and palm stop all need a home test (section 7).

<a id="1-george-的決定2026-11-09"></a>
## 1. George's decisions (2026-11-09)

| Question | Decision |
|---|---|
| Batches | Two: ALARM-1 timers plus ring framework; ALARM-2 alarms |
| Ring defaults | "Gentler": ring only on the device where it was set (every screen if that device is offline); 30-second fade-in; stop by itself after 5 minutes with nobody responding, and log it; during a call, do not hang up, only mute Nous. The 30% minimum volume for alarms is left to ALARM-2; timers follow this device's conversation volume (day/night) |
| Mac sleep | Keep awake plus late ring: while a timer runs or rings, the Mac App prevents idle system sleep (the display can still turn off); if the Mac still sleeps (manual sleep, lid closed), after waking it rings anything up to 30 minutes late and says how late, and only logs older ones as missed |
| How it is enabled | Built into the core plus a settings switch: no `NOUS_AIL` needed; tools are named `app.timer.*` and exist on both realtime voice routes; a settings switch "Alarms and timers" (on by default) |

<a id="2-設計"></a>
## 2. Design

<a id="21-資料與排程核心"></a>
### 2.1 Data and scheduling (core)

- `AlarmCenter` in `server/alarms.ts` is the only writer. It saves to `<configDir>/alarms.json` (0600, tmp plus rename; the file is written before memory changes). Contents: settings, timers, rings in progress, and the last 50 ring log entries.
- Timer types are split by state: a running timer has only `ends_at` (core time), a paused one only `remaining_ms`. At most 10 at once, 1 second to 24 hours long, names up to 40 characters.
- Scheduling looks only at core time (epoch milliseconds). The scheduler never sleeps longer than 30 seconds before checking again, so when Mac sleep delays `setTimeout`, it notices within 30 seconds of waking; the Mac App also checks immediately on `powerMonitor` `resume` and `unlock-screen`.
- When a timer is due: under 2 seconds late counts as on time; up to 30 minutes late it rings and records how late; later than that it does not ring and the log says "missed".
- Where it rings: if the page that set the timer (the Mac main window `main` or a terminal ID such as `rpi4`) is online, only there; if it is offline (Pi disconnected, heartbeat timed out) or unknown, every screen rings. "Online" means the page has an SSE stream, and a terminal must also have sent a heartbeat within 25 seconds.
- After 5 minutes (`ring_s`, 30–1800) with nobody stopping it, ringing stops by itself; the log says "auto-stopped" and records whether any page reported actually playing it.
- Restart: the file is read back and checked again. Due timers follow the late rules above; a ring in progress keeps ringing until its auto-stop time. An unreadable file starts empty and the original is renamed to `alarms.json.unreadable`.

<a id="22-工具兩條即時語音路徑共用"></a>
### 2.2 Tools (shared by both realtime voice routes)

`server/integrations/adapters/timer.ts` is a built-in adapter of the integration layer: `createIntegrations` gained a `builtins` parameter, and with `NOUS_AIL` off the integration layer contains only this adapter. The settings switch is read on every lookup: when off, the tools are not in the list and a call already in progress returns `refused disabled`.

| Tool | Effect |
|---|---|
| `app.timer.start` | `duration_s` (1–86400), `label` (optional); records the page that started this realtime call |
| `app.timer.list` | Time left on each timer |
| `app.timer.pause` / `resume` / `extend` / `cancel` | By name or ID; may be omitted when there is only one; with several, returns `refused` plus `data.candidates` so the model asks which one |
| `app.timer.stop_ringing` | Stops ringing |

The page that started the call: on the API-key route `/api/integrations/call` looks it up from the session (`RealtimeSessions.pageOf`); on the ChatGPT-plan route `LiveToolCaller` passes `SessionContext.page`. The speaking rule `TIMER_RULE` is added to both routes' instructions only when the timer tools are present.

<a id="23-響鈴頁面"></a>
### 2.3 Ringing (page)

- `src/alarm-sound.ts`: WebAudio synthesizes a 2-second loop locally (four short beeps alternating 1046.5 Hz and 1318.5 Hz, 110 ms each, then 1.2 seconds of silence), put in an `AudioBuffer` played with `loop`. No files, no network, no external assets. The fade-in is `AudioParam` automation from 15% to full, not JS timers, so a throttled background window does not cut the sound. The sound is routed to the device chosen under "Sound output" first (waiting at most 1 second; otherwise the system default plays it).
- Volume: a timer's final volume equals this device's current conversation volume (day/night, VOL-2), at least 10%.
- `src/alarm-ring.ts`: decides from `settings.alarms` (pushed by the core over SSE) whether this page rings; after a reload or when joining late, the fade-in continues from where it is. After it starts playing it reports to the core (`/api/alarms/ack`, `playing` true or false from the `AudioContext` state).
- Ring screen (`data-visibility-reason="alarm_ringing"`): large clock, "“Noodles” is done", a late note, and "Stop". Stopping: the button, Esc or Space, raising an open palm, typing or saying during a call a whole sentence such as 「停」「好了」「知道了」「關掉」, or the model calling `app.timer.stop_ringing`. Stopping silences every screen.
- Countdown (`data-visibility-reason="timer_running"`): while timers exist, the bottom-right corner shows the 3 ending soonest, with paused ones marked "Paused". With no timers it is removed; it is not a permanent list.
- When ringing stops by itself or a timer is missed, a one-line note shows on demand at the bottom of the screen (`alarm_missed_or_auto_stopped`); "Got it" clears it.
- While ringing: wake detection is paused the whole time (`WakeGuard` gains an `alarm` source, so the ringtone cannot trigger the wake word); memories are put away; the processing cue pauses; a call in progress is not hung up, but Nous's remote audio is muted and browser speech synthesis is paused, both restored after stopping; when the Pi screen is off at night (DN-3), ringing counts as "busy" and the screen turns on.
- Mac App (`desktop/main.mjs`): when the Mac should ring too (`targets` includes `main` or everything) it posts a system notification (with the system alert sound, as a backup when the main window is hidden or the page did not play). While a timer runs or rings it holds `powerSaveBlocker("prevent-app-suspension")` against idle sleep (separate from the one used by service mode).

<a id="3-語音指令表"></a>
## 3. Voice command table

`shared/voice-commands.ts` gains a section "Timers (realtime, model decides, no guarantee)" and the control "While a timer rings"; README is generated by `npm run docs:commands` and the English README is translated to match.

| You can say | Result |
|---|---|
| 「計時 10 分鐘」「泡麵 3 分鐘」「5 分鐘後叫我」 (timer for 10 minutes, noodles 3 minutes, wake me in 5 minutes) | Starts a timer (can be named; several at once) |
| 「泡麵還剩多久」「有哪些定時器」 (how long is left on the noodles, which timers are there) | Says the time left |
| 「暫停泡麵」「繼續」「再加 5 分鐘」「取消雞蛋的定時器」「全部取消」 (pause the noodles, resume, add 5 minutes, cancel the egg timer, cancel all) | Pause, resume, extend, cancel |
| While ringing: 「停」「好了」「知道了」「關掉」 (stop, OK, got it, turn it off) | Matched locally (`matchRingStop`) without waiting for the model; works when typed or during a call |

**Assessment: a local "start a timer" command that skips the model.** After the wake word the conversation is a realtime voice call, and there is no local speech recognition; a local rule could only serve typing and push-to-talk. Not done in this batch, so the same sentence does not behave differently on different paths. Only "stop while ringing" is a fixed local phrase.

<a id="4-測試"></a>
## 4. Tests

| Command | Result |
|---|---|
| `npm ci` | Passed |
| `npm run typecheck` | Passed |
| `npx vitest run` | 169 files, 3143 passed, 5 skipped |
| `npm run build` | Passed (only the existing chunk-size warning) |

New `tests/alarms.test.ts` (28 tests, fake clock): rings on time and only on the device that set it, rings everywhere when the Pi is disconnected, several timers and operations by name (with candidates), ranges and the 10-timer limit, auto-stop after 5 minutes with a notice, stop log, a late ring after 20 minutes of sleep that records how late, a missed log after 2 hours of sleep, noticing within 30 seconds without a resume event, restart recovery (paused, late ring, restart while ringing), an unreadable file, daylight saving (a 1-hour timer started 01:30 US Eastern on 2026-03-08 rings at wall-clock 03:30), turning off and on, clear all, a write failure during a scheduled check not throwing and retrying in 10 seconds, extending past 24 hours in total being refused; with `NOUS_AIL` off the "App integrations" status lists no services; with `NOUS_AIL` off both routes have `app__timer__*`; fixtures for the ChatGPT-plan route (`LiveToolCaller`) and the API-key route (`/api/integrations/call` with `X-Nous-Terminal: rpi4`); HTTP settings, stop, ack, clear; stop phrases, countdown format, volume and fade-in, ringtone waveform, wake guard.

Changed existing tests: `tests/wake-flag-off.test.ts` adds an eighth deliberate exception (`settings.alarms`, and `settings.integrations` listing only `app__timer__*`); everything else is still byte-identical. `tests/audio-privacy.test.ts` adds the ringtone to "every place that makes sound goes through the sound output setting".

**Headless Chromium (cloud, `--autoplay-policy=no-user-gesture-required`):** the real core was started with a temporary settings directory whose `alarms.json` held three timers (one due in 9 seconds), and two pages were opened at Mac size (1440×900) and Pi size (1920×1080, `?terminal=rpi4`):

- The bottom-right countdown appeared with `data-visibility-reason="timer_running"`.
- When due, both pages showed the ring screen; the core's `heard_by` was `["main","rpi4"]` (both pages' `AudioContext` were running; the cloud has no speakers, so this does not show it is audible).
- Esc on the Pi page removed the ring screen on both pages; the core had 0 `rings` and logged `停止 1 個響鈴（key）` (1 ring stopped, by key); the other two timers remained.
- After switching to English and reloading, the countdown showed `Timer` and `Paused`.

Screenshots (headless, not on the real devices): [Pi 1920×1080 ringing](alarm-timer-1-2026-11-09/pi-ring-1920x1080-HEADLESS.png), [Mac 1440×900 ringing](alarm-timer-1-2026-11-09/mac-ring-1440x900-HEADLESS.png), [Mac countdown](alarm-timer-1-2026-11-09/mac-countdown-1440x900-HEADLESS.png).

<a id="41-獨立審查與修正"></a>
### 4.1 Independent review and fixes

Another agent read the diff and listed 8 findings, all fixed (the 7th was already changed before the review):

| Finding | Fix |
|---|---|
| A page that loads while already ringing (reload, late ring) creates its wake controller afterwards, without the guard | The `alarm` guard is applied when the controller is created and after it is turned off and on; a wake detection while ringing never starts a call (backstop) |
| A write failure during a scheduled check threw out of the timer, crashing the core or stopping the scheduler | `tick()` catches it, logs it and retries in 10 seconds |
| With `NOUS_AIL` off, settings showed an "App integrations" section with a single untranslated `timer` row | Built-in tools are left out of the status; the section is not drawn when `settings.integrations.builtin_only`; stale comments updated |
| The ringing mute and live voice's own mute overwrote each other | Combined: `liveAudio.muted = live voice wants it || ringing`; a new call follows the same rule |
| New strings lacked English | Added the fixed tool messages and HTTP errors; settings errors are now a fixed sentence |
| A superseded ringtone reported "could not play" | No report when superseded; when sound plays, every ring ringing on this page is reported together |
| A Pi-only ring also posted a Mac notification | Notify only when the Mac should ring too |
| Extending could exceed 24 hours | Refused |

<a id="5-已知限制"></a>
## 5. Known limitations

- **Mac sleep:** only idle sleep is prevented. Manual sleep, a closed lid or a forced sleep from power settings still stops the core, and nothing rings before waking. `pmset schedule wake` is not used (it needs an administrator password).
- **The Pi rings only if the Mac runs:** scheduling is in the Mac core. If the Mac sleeps or Nous is not running, the Pi does not ring either. If the SSH tunnel between Pi and Mac drops, the Pi page cannot get the ring, and the core switches to ringing on every screen (the Mac main window rings).
- **Stopping by voice only during a call:** the wake word is paused for the whole ring (so the ringtone cannot trigger it); without a call, use the palm, "Stop" or a key.
- **Playing sound needs browser permission:** the Pi kiosk has `--autoplay-policy=no-user-gesture-required`; Electron allows it by default. In a plain browser (ordinary Chrome) without a user gesture it may not play; the page reports `playing: false` and the core logs it.
- **During a call the ringtone reaches the microphone:** per George's decision the call is not hung up, so the ringtone may be sent to the realtime model (billed as usual); Nous's answers are muted while ringing.
- Time zones and daylight saving: timers count only elapsed time (epoch) and are not affected by the time zone; local alarm times and daylight saving are left to ALARM-2 (using the local time zone from #96).
- Naming family members (who stopped it, whose timer) is not in this batch.
- On the API-key route the subtitle shows the tool message: sentences containing a name or length (for example 「已開始『泡麵』3 分鐘的定時器。」, "started the 3-minute 'noodles' timer") stay in Chinese in the English interface (the same existing approach as the LG TV); what Nous says aloud is answered by the model in the interface language.

<a id="6-回退"></a>
## 6. Rollback

- **Turn the feature off:** Settings, "Alarms and timers", "Off". The tools disappear from both routes, any ringing stops and is logged, and nothing is scheduled or rings. Existing timers are kept and work again when turned back on (late ones follow the missed rule).
- **Clear the data:** "Clear all" in settings (or `POST /api/alarms/clear`) deletes every timer, ring and log entry; alternatively, after quitting Nous, delete `<configDir>/alarms.json` (Mac App default `~/.config/nous/alarms.json`, or `NOUS_CONFIG_DIR`).
- **Code rollback:** revert this PR; a leftover `alarms.json` does not affect the old version.

<a id="7-在家實測步驟mac-與-pi"></a>
## 7. Home test steps (Mac and Pi)

1. Update the Mac App and the Pi (reloading the Pi page is enough; the Pi package did not change). In settings, confirm "Alarms and timers" is "On".
2. Wake Nous on the **Pi** and say 「泡麵 1 分鐘」 (noodles, 1 minute). Check that Nous says it started, the Pi shows a "泡麵 0:59" countdown in the bottom-right corner, and the Mac window does not ring.
3. When it is due: the Pi speaker fades up from quiet, the screen shows the large clock and "“泡麵” is done"; the Mac neither rings nor shows a notification. Press "Stop".
4. In the **Mac** window start two timers: 「計時 2 分鐘」「雞蛋 3 分鐘」 (timer 2 minutes, eggs 3 minutes). Ask 「還剩多久」 (how long is left), say 「暫停雞蛋」「再加 1 分鐘」「取消雞蛋」 (pause the eggs, add 1 minute, cancel the eggs), and check the countdown follows.
5. Try stopping while ringing: raise an open palm (camera and palm stop on); next time press Esc; another time say 「好了」 (OK) during a call.
6. Ignore a ring: after 5 minutes it stops by itself, a note appears at the bottom saying it stopped by itself; press "Got it".
7. Sleep: start a 3-minute timer, put the Mac to sleep from the Apple menu for 5 minutes, then wake it; check it rings within a few seconds and the screen says 2 minutes late. Also check that the Mac does not idle-sleep by itself while a timer runs.
8. Ringing during a call: start a 1-minute timer and keep talking to Nous; when due, Nous's voice is muted and the call stays up; after stopping, Nous is audible again.
9. Pi disconnected: start a 2-minute timer on the Pi, unplug the Pi's network; when due, the Mac main window rings.
10. With a Bluetooth speaker selected, check the ringtone comes out of the selected speaker.

<a id="8-下一個-gate"></a>
## 8. Next gate

ALARM-2: alarms (one-off and repeating, local time zone and daylight saving, 9-minute snooze, 30% minimum volume, missed-alarm handling, management in settings). Adjust the defaults after the ALARM-1 home results (section 7) come back.
