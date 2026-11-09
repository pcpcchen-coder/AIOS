<!-- bilingual: source=zh-TW -->

> [繁體中文](alarm-timer-2-2026-11-09.md) | [English](alarm-timer-2-2026-11-09.en.md)

# Alarms ALARM-2 (2026-11-09)

The second batch George asked for on 2026-11-09: alarms (one-off and repeating, snooze, missed-alarm handling, management in settings). It builds on [ALARM-1 timers and ring framework](alarm-timer-1-2026-11-09.en.md) (#133, merged into main `671826d`), on branch `claude/alarm-clock`.

**Evidence level:** Linux cloud unit and integration tests and headless Chromium only (fake clock, simulated realtime voice, simulated pages). **Nothing was run on the Mac or the Pi** (section 6).

<a id="1-沿用的-george-決定"></a>
## 1. George's decisions carried over

All of ALARM-1's "gentler" defaults still apply (ring only on the device where it was set, 30-second fade-in, auto-stop after 5 minutes, only mute Nous during a call, Mac keep-awake plus late ring within 30 minutes). Defaults used in this batch: 9-minute snooze; 30% minimum volume for alarms (timers have no minimum); time zone is the local (system) time zone from #96.

<a id="2-設計"></a>
## 2. Design

- **Data:** `alarms.json` moves to version 2, adding `alarms`, `snoozes` and `time_zone`. A version 1 (ALARM-1) file still loads and is upgraded on the next write. An alarm stores its wall-clock time (`hour`, `minute`); repeats store only the weekdays (0 = Sunday); a one-off stores its local date. `next_at` is the next ring computed by the core (epoch). At most 20 alarms.
- **Local time:** `shared/alarm-schedule.ts` converts a local date and time to epoch using the time zone. A time that does not exist when daylight saving starts (for example 02:30 US Eastern) moves to the same relative point after the skip (03:30); a time that repeats when it ends uses the first one. When the time zone changes (`time_zone` differs from the current one), every enabled alarm's next ring is recomputed.
- **After ringing:** a one-off alarm turns itself off (it is kept and can be turned on again); a repeating one schedules the next occurrence "after now", so after several days asleep it rings (or logs a miss) only once. Missed and late rules are the same as for timers (up to 30 minutes late it rings and says how late).
- **Snooze:** alarms only. Use the "Snooze 9 min" button on the ring screen, type or say during a call a whole sentence such as 「貪睡」「再睡一下」 (snooze, a bit more sleep), or the model calls `app.alarm.snooze`. Snoozing stops every ring on this page (a timer ringing at the same time stops too) and rings again on the same device after 9 minutes; a "Snoozed 8:59" countdown shows on demand in the bottom-right corner (`data-visibility-reason="alarm_snoozed"`). Turning off or deleting an alarm cancels its snooze.
- **On-demand countdown:** an alarm due within the hour shows "07:00 42:10" in the bottom-right corner (`alarm_soon`). It is not an alarm list; the list is only in settings.
- **Volume:** an alarm's final volume is max(this device's current conversation volume, 30%).
- **Mac keep-awake:** idle sleep is also prevented when an alarm is due within 12 hours or a snooze is pending. AlarmCenter recomputes this at every check, so an evening alarm for the next morning starts keeping the Mac awake 12 hours before.
- **System notification:** an alarm's notification title is "Alarm: “起床”" (wake up).

<a id="21-工具兩條即時語音路徑共用核心內建"></a>
### 2.1 Tools (shared by both realtime voice routes, built into the core)

| Tool | Effect |
|---|---|
| `app.alarm.set` | `time` (local 24-hour time), `repeat` (once, daily, weekdays, weekends, custom), `days` (for custom, for example `mon,wed,fri` or 「一三五」), `date` (one-off date; without it, the next time this clock time comes), `label` |
| `app.alarm.list` | Alarms (time, repeat, on or off, next ring) and snoozed ones |
| `app.alarm.enable` | Turn on or off (without deleting); turning on a past one-off alarm moves it to the next time this clock time comes |
| `app.alarm.delete` | Delete one or all |
| `app.alarm.snooze` | Snooze |
| `app.alarm.stop_ringing` | Stop; `cancel_snoozes` also cancels snoozes ("don't wake me again") |

An alarm can be found by name, time ("6:30") or ID; with several and none named, the result is `refused` with `data.candidates`. Both routes' instructions already contain today's date and time zone (`todayLine`); the speaking rule `ALARM_RULE` tells the model to turn "tomorrow" or "next Wednesday" into `date` and to ask when morning or evening is unclear.

<a id="22-設定頁"></a>
### 2.2 Settings page

The "Alarms and timers" section gains an "Alarms" list: each shows its time, name, repeat, next ring (shown in the core's time zone), an on/off switch and Delete. Below it a new alarm can be added (time; once, every day, weekdays or weekends; name). Repeats on chosen weekdays are set by voice. The list exists only in settings; it is not a permanent screen.

<a id="3-語音指令表"></a>
## 3. Voice command table

In `shared/voice-commands.ts` the section is renamed "Timers and alarms" and gains two alarm rows; "While a timer or alarm rings" gains snooze. README is generated by `npm run docs:commands` and the English README is translated to match.

| You can say | Result |
|---|---|
| 「明天早上 7 點叫我」「每個工作天 6:30 叫我」「週一三五晚上 9 點提醒我倒垃圾」 (wake me at 7 tomorrow; wake me at 6:30 every weekday; remind me to take out the trash at 9 pm Mon, Wed, Fri) | Sets an alarm |
| 「有哪些鬧鐘」「關掉明天的鬧鐘」「刪掉 6:30 的鬧鐘」 (which alarms are there; turn off tomorrow's alarm; delete the 6:30 alarm) | List, on/off, delete |
| While an alarm rings: 「貪睡」「再睡一下」 (snooze, a bit more sleep) | Matched locally (`matchRingSnooze`); rings again in 9 minutes |
| While an alarm rings: 「停」「我起來了」 (stop, I'm up) | Matched locally; stops |

<a id="4-測試"></a>
## 4. Tests

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx vitest run` | 170 files, 3161 passed, 5 skipped |
| `npm run build` | Passed (only the existing chunk-size warning) |

New `tests/alarm-clock.test.ts` (18 tests, fake clock): parsing times and repeat rules; the daylight-saving gap and overlap, a daily 07:00 alarm across the start of daylight saving (two rings 23 hours apart, both at local 07:00); weekday alarms skipping the weekend and crossing midnight; "7 tomorrow" ringing once and then turning off; a past time without a date meaning tomorrow, an explicit past date refused; weekday alarms; snooze ringing again after 9 minutes and cleared by stopping; timers cannot be snoozed; a Mac asleep through an alarm ringing 15 minutes late, three days asleep logging only one miss and scheduling the next one; restart restoring alarms and snoozes, reading an ALARM-1 version 1 file; recomputing on a time-zone change; on/off, deletion by time or name, asking when ambiguous; keeping the Mac awake only within 12 hours; both routes having `app__alarm__*` and the speaking rule; tools setting weekdays, chosen weekdays, a date, and rejecting bad input, the alarm ringing on the device that set it, snooze and cancelling snoozes; a fixture for the ChatGPT-plan route (`LiveToolCaller`); snooze and stop phrases; the minimum volume.

Changed existing test: the eighth exception in `tests/wake-flag-off.test.ts` adds the alarm fields and `app__alarm__*`.

**Headless Chromium (cloud):** the real core was started with a temporary settings directory whose `alarms.json` held a weekday alarm due in 8 seconds and an alarm that was off:

- A Pi-size page (1920×1080, `?terminal=rpi4`) rang, showing "Alarm: “起床”" with both "Stop" and "Snooze 9 min".
- Pressing "Snooze 9 min" removed the ring screen, the bottom-right corner showed "起床 貪睡 9:00" (`alarm_snoozed`), the core had 1 snooze, and the weekday alarm stayed on with its next ring scheduled.
- The settings page (Mac size) listed 2 alarms; adding "06:45 週末慢跑 (weekends)" gave the core one more alarm with `days` 0 and 6; deleting "倒垃圾" left 2.

Screenshots (headless, not on the real devices): [Pi alarm ringing](alarm-timer-2-2026-11-09/pi-alarm-ring-1920x1080-HEADLESS.png), [alarms in settings](alarm-timer-2-2026-11-09/alarm-settings-HEADLESS.png).

<a id="5-已知限制"></a>
## 5. Known limitations

- ALARM-1's limitations still apply: manual sleep or a closed lid stops the core; whether the Pi rings depends on the Mac; the wake word is paused while ringing, so without a call you cannot stop or snooze by voice; during a call the ringtone reaches the microphone.
- **Alarm times use the Mac's time zone:** if the Pi's browser time zone differs, alarms still ring by the Mac's time zone, and "next" in settings is shown in the Mac's time zone.
- Keep-awake starts only within 12 hours of an alarm: for a 7 am alarm set before 7 pm the previous evening, the Mac starts keeping awake at 7 pm. If it idle-sleeps before then, the missed rules apply on waking.
- Naming family members (saying "George, time to get up" while ringing) is not in this batch: nothing is recognized while ringing, so it needs its own design (suggested for later).
- Tool messages in API-key route subtitles: sentences with a time or name stay in Chinese in the English interface (as in ALARM-1).

<a id="6-回退與在家實測"></a>
## 6. Rollback and home test

**Rollback:** as in ALARM-1: turn off "Alarms and timers" in settings (tools disappear, nothing is scheduled or rings, alarms are kept); "Clear all" deletes timers, alarms, snoozes and the log; or delete `<configDir>/alarms.json`. After reverting this PR, the old version cannot read a version 2 `alarms.json`; it renames it to `alarms.json.unreadable` and starts empty (timers are cleared too).

**Home test:**

1. Update the Mac App and reload the Pi page. In settings, "Alarms and timers", check the "Alarms" list is empty.
2. On the **Pi**, set an alarm two minutes ahead by voice: for example at 21:10 say 「21:12 叫我」 (wake me at 21:12). Check that Nous confirms, settings shows the alarm with next ring today at 21:12, and, being within the hour, a countdown appears in the bottom-right corner.
3. When due: the Pi rings, the screen says "Alarm", and "Snooze 9 min" is there. Press snooze: "Snoozed 9:00" appears in the bottom-right corner. After 9 minutes it rings again; this time say 「我起來了」 (I'm up) during a call or press "Stop".
4. Say 「每個工作天 6:30 叫我」 and 「週一三五晚上 9 點提醒我倒垃圾」, ask 「有哪些鬧鐘」 (which alarms are there); in settings turn one off and delete another.
5. At night set the conversation volume to the minimum (10) and check the alarm still plays at no less than 30% (a timer plays at 10%).
6. Sleep: set an alarm 10 minutes ahead and let the Mac sleep for 15 minutes before waking it: within seconds of waking it rings and says 5 minutes late.
7. The next morning, check the weekday alarm really rings at 6:30 (only on the device that set it).

<a id="7-下一個-gate"></a>
## 7. Next gate

Adjust the defaults after the home results for both batches (ALARM-1 section 7, section 6 here) come back; evaluate family-member naming and "stop by voice without a call" separately.
