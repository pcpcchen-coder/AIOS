<!-- bilingual: source=zh-TW -->

> [繁體中文](alarm-timer-3-2026-11-09.md) | [English](alarm-timer-3-2026-11-09.en.md)

# Countdown before it is due, ticks and ringtone choice ALARM-3 (2026-11-09)

George asked on 2026-11-09: "The alarm should start showing on screen when 30 seconds are left, have a beep every second for the last 10 seconds, and when it is due ring with an alarm sound (three sounds and a length) that I can set." It builds on [ALARM-1](alarm-timer-1-2026-11-09.en.md) and [ALARM-2](alarm-timer-2-2026-11-09.en.md) (main `53a3ded`), on branch `claude/alarm-countdown`.

**Evidence level:** cloud tests and headless Chromium. **Nothing was run on the Mac or the Pi**; how the three ringtones and the ticks actually sound needs a home check.

<a id="1-行為"></a>
## 1. Behaviour

- **30-second countdown:** 30 seconds before a timer, alarm or snooze is due, the centre of the screen shows "“泡麵” is almost due" (noodles) with the seconds in large digits (`data-visibility-reason="alarm_countdown"`). It does not block anything (no clicks, no focus); when it is due the ring screen takes over. Timers get it too (George said alarms; it is just as useful before a timer ends, and can be removed if unwanted).
- **Only on the device that will ring:** the core adds `here` to every timer, alarm and snooze in `settings.alarms` ("would it ring on this page if due now", from the current connections), and the page counts down only when `here` is true.
- **A tick every second for the last 10 seconds:** a short sound of about 60 ms at 1760 Hz, from the chosen speaker, at the same volume as alarms (conversation volume, at least 30%). The ticks at 10, 9 … 1 seconds are scheduled at once on the AudioContext clock, so they stay on time even when a background window's timers are throttled; nothing is scheduled at the due moment (the ringtone follows). The seconds turn amber for the last 10 seconds.
- **Wake guard:** during the countdown and while previewing a ringtone, wake detection is paused as well (the ticks cannot trigger the wake word); memories are put away; the processing cue pauses; a Pi screen turned off at night comes back on.
- **Three ringtones (synthesized locally, no external assets):**

| Ringtone | Sound | Loop |
|---|---|---|
| Classic beeps (default) | Four short beeps (alternating 1046.5 / 1318.5 Hz), then silence | 2 s |
| Soft chime | Three falling chime notes (1318.5, 1046.5, 784 Hz), slowly decaying | 3 s |
| Urgent pulse | Eight short 2093 Hz beeps (every 0.1 s), then a brief silence | 1.5 s |

- **Ring length:** 1, 3, 5 (default), 10 or 15 minutes: how long it rings once due; if nobody stops it, it stops by itself and this is logged (as in ALARM-1).
- **Settings page:** "Alarms and timers" gains a "Ringtone" part: each of the three ringtones has "Preview" (4 seconds, at this device's alarm volume) and "Use", plus a "Ring length" menu. The settings are saved in the core's `alarms.json` (`ring_tone`, `ring_s`) and shared by every device.

<a id="2-測試"></a>
## 2. Tests

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx vitest run` | 171 files, 3172 passed, 5 skipped |
| `npm run build` | Passed (only the existing chunk-size warning) |

New `tests/alarm-countdown.test.ts` (5 tests): the three ringtones and the default, an unknown ringtone refused; each ringtone's loop length, no clipping, starting silent, and its own rhythm (classic silent after four beeps, chime still decaying, pulse eight beeps); ringtone and length surviving a restart; tick timing (starting exactly 10 seconds before gives one tick at 0 … 9 seconds from now, joining late schedules only the rest, none at the due moment); `here` true only on the page that will ring, switching to every page when the device that set it disconnects. `tests/audio-privacy.test.ts` adds that the ticks also go through the sound output setting.

**Headless Chromium (cloud):** the real core with an `alarms.json` holding a timer due in 35 seconds and the ringtone set to soft chime, on a Pi-size (1920×1080) page:

- About 2 seconds after the page opened, the countdown appeared showing 30, "“泡麵” is almost due" and `alarm_countdown`.
- On entering the last 10 seconds it showed 10 and changed colour; the page scheduled 10 ticks (a count of 10 from intercepting `createOscillator`).
- When due, the ring screen appeared and the countdown disappeared; Esc stopped it.
- In settings, choosing "Urgent pulse" and "10 minutes" gave the core `ring_tone` `pulse` and `ring_s` 600; "Preview" could be pressed.

Screenshots (headless, not on the real devices): [countdown in the last 10 seconds](alarm-timer-3-2026-11-09/pi-countdown-final-1920x1080-HEADLESS.png), [ringtones in settings](alarm-timer-3-2026-11-09/settings-tones-HEADLESS.png).

<a id="3-已知限制"></a>
## 3. Known limitations

- The countdown updates once a second on the page, so it may appear up to 1 second late; the ticks are scheduled separately on the audio clock and are on time.
- The clock difference between the page and the Mac core is corrected (`server_now`), but the ring itself is pushed by the core, so on a slow network there may be a fraction of a second between "0" and the ringtone starting.
- The 30-second countdown and 10-second ticks are fixed (George's numbers) with no switch; a setting can be added if a countdown is not wanted.
- The ALARM-1 and ALARM-2 limitations still apply (manual Mac sleep, no voice stop without a call, and so on).

<a id="4-回退與在家實測"></a>
## 4. Rollback and home test

**Rollback:** turning off "Alarms and timers" in settings disables everything (including the countdown and ticks); choosing "Classic beeps" and "5 minutes" gives the previous behaviour. After reverting this PR, the old version treats `ring_tone` in `alarms.json` as an unknown setting and skips it (logged); everything else still loads.

**Home test:**

1. Update the Mac App and reload the Pi page. In settings, under "Ringtone", press "Preview" for each of the three, pick one with "Use", and set the length to 1 minute.
2. On the Pi say 「計時 1 分鐘」 (timer for 1 minute): 30 seconds before, the countdown appears; in the last 10 seconds there is a tick every second (Pi speaker); when due it switches to your ringtone and stops by itself after 1 minute.
3. Set a 1-minute timer in the Mac window: check the Pi neither counts down nor ticks (only the device that will ring).
4. Say the wake word during a countdown: check no call starts (wake is paused during the ticks).
5. Alarms: set an alarm 2 minutes ahead and check the same countdown and ticks; after snoozing, the countdown also appears before it rings again 9 minutes later.
