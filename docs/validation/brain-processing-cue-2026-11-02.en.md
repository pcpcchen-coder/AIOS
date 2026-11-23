<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-processing-cue-2026-11-02.md) | [English](brain-processing-cue-2026-11-02.en.md)

<a id="電子腦處理中與處理中音效驗證"></a>
# Validation: the electronic brain's “processing” state and the processing sound

Date: 2026-11-02, Asia/Taipei. Branch: `claude/brain-processing-cue` (based on main `6412ea0`). Purpose: George asked that while background work is being processed, the electronic brain shows the “thinking” processing state (node lighting) and a search sound plays at the same time.

**This is not hardware acceptance.** All tests below ran in a cloud container with fixtures (fake clocks, fake timers, a fake AudioContext, fake menus and a fake DOM); **not on a Mac, no real sound was played, and the real visuals were not seen**. The Electron menu was tested only as a pure template function and was not run. None of the Mac steps in section 8 have been run.

<a id="1-george-的決定2026-11-02"></a>
## 1. George's decisions (2026-11-02)

| # | Decision | What this batch does |
|---|---|---|
| P1 | Any background task that is **actually running** has sound; a realtime web search still in flight also counts | The source is `processingSource()`: tasks with `status === "running"` (`task:<id>`) plus in-flight realtime searches (`search:<id>`, a monotonic id per search, released by `webSearchFromRealtime` in `finally` or after 30 s). Queued (`queued`) and cancelling (`cancelling`) tasks do not count; tasks do not count while the core connection is down; searches do not count after the call ends |
| P2 | A soft sonar ping, peak gain 0.05 | Sine 1100→820 Hz, 180 ms, and a 35% echo 260 ms later at 880→700 Hz; see section 4 |
| P3 | 20 s at the start of an episode; 6 s again each time a new step starts running (at most once per 15 s); at most 60 s per task, then visual only | `CUE_TIMING` (`src/processing-cue.ts`); see section 5 |
| P4 | During a realtime voice call: visual only, no sound | Paused while `callOn` (`realtime.on || realtimeStarting`) |
| P5 | A “處理中音效” (Processing sound) switch in the menu and the settings, default on, stored with the sound settings | `processing_cue` in `audio.json` (default `true`); a checkbox in the menu bar's “Sound” section and an on/off button in the in-page “Sound” settings |
| P6 | Pause while Nous speaks (plus a 1.5 s tail), while the microphone is capturing, and while the window is hidden | See section 6 |
| P7 | Stop when no task is running or the switch is off; “收起” (dismiss) does not stop it | The source looks only at task status, not at the view; dismiss only closes the view |
| P8 | The sound goes to the chosen sound output (`audioDevices.sink`/`release`) | `browserProcessingSound` calls `output.sink(ctx)` before sounding and `release` after fading out; static check in `tests/audio-privacy.test.ts` |
| P9 | One more wake guard source, `cue`: no wake word is accepted during each ping | `GuardSource` in `src/audio/guard.ts` gains `cue`; begin on each ping, end 450 ms later |

<a id="2-交付內容"></a>
## 2. Delivered

All paths are under `prototype/ambient-shell/`.

| File | Contents |
|---|---|
| `src/processing-cue.ts` (new) | `processingSource()` (tasks, search ids, connection, call), `CUE_TIMING`, `ProcessingCue` (scheduling: windows, re-arming, per-task start window and cap, pause, stop; injectable clock) |
| `src/processing-sound.ts` (new) | `browserProcessingSound()`: one AudioContext per episode, a master gain node, fades, the sonar tone and echo; nothing is scheduled while the AudioContext is not running (`ping()` returns `false`); `PING_SPEC`, `gainToDb()` |
| `src/brain.ts` | `BrainVisualState.processing`; `processingHold()`, `processingEnergy()`, `PROCESSING_TINT`; the faint ring of `cuePing()` |
| `src/main.ts` | Creates `processingCue` (injecting the sound output and the wake guard); `syncProcessingCue()` runs from `render()`, on speech start/end and on `visibilitychange`; step starts in `firePulses` call `rearm()`; realtime search counter; the status line says “背景處理中” (Working in background) while the conversation is idle; `canvas.dataset.processing` |
| `src/audio/guard.ts`, `src/audio/controller.ts` | Guard source and drop reason `cue` |
| `shared/audio-devices.ts`, `server/audio-settings.ts` | `AudioPrefs.processing_cue` (default `true`), `parseAudioPatch` accepts only booleans; `AUDIO_TEXT.processingCue`/`processingCueNote` |
| `desktop/settings-menu.mjs` | The “處理中音效” checkbox (with a note) at the end of the “Sound” section; a click writes the opposite value |
| `src/views.ts` | The “處理中音效” on/off button in the in-page “Sound” settings (`aria-pressed`, `aria-label`) |
| `shared/messages.en.json` | English for the new text |
| Tests | `tests/processing-cue.test.ts` (new), `brain-regions`, `region-activity`, `wake-logic`, `audio-settings`, `desktop-menu`, `settings-view`, `audio-privacy`, `wake-flag-off` |

<a id="3-什麼算處理中唯一來源"></a>
## 3. What counts as “processing” (the single source)

| State | Brain “processing” | Processing sound |
|---|---|---|
| Task `running` (including planning), with the core connected | Yes | Per sections 5 and 6 |
| Core event stream disconnected (task states on screen may be stale) | Tasks do not count | Tasks do not count |
| Task `queued`, `cancelling`, `succeeded`, `failed`, `cancelled` | No | No |
| A realtime web search still in flight while the call is still on | Yes (at most 30 s; a request that never returns stops counting after 30 s) | No (a call is visual only) |
| A search that returns after the call ended | No | No |
| None of the above | No | No |

The brain's look depends only on the source, not on the sound: with the switch off, during a call, or while speaking, “processing” is still shown. Region lighting and light pulses (language, math, art, auditory, visual, planning) still come only from task step `domain` tags and conversation topics; “processing” lights no region by itself and does not represent neural activity inside the model.

Visuals:

- A cyan tint held between 0.35 and 0.55, breathing slowly (0.45 ± 0.1, 2 s period; fixed at 0.45 with reduced motion). A success (mint) or failure (amber) flash that is brighter takes over first, fades to this level, then returns to cyan.
- While the conversation is idle or listening, energy is at least 0.65 (the same as “thinking”). While Nous speaks or on error, those looks win.
- Each time a ping is actually scheduled (the AudioContext is running), a faint cyan ring expands from 1.1 R to 1.5 R (not drawn with reduced motion; cleared on the next frame when not processing).
- While the conversation is idle, the status line honestly says “背景處理中” (Working in background).

<a id="4-聲音規格"></a>
## 4. Sound specification

| Item | Value |
|---|---|
| Main tone | Sine, frequency gliding exponentially from 1100 Hz to 820 Hz over 180 ms; 10 ms attack (linear to peak gain), then exponential decay to 0.0001 |
| Echo | 260 ms after the main tone starts; 35% of the main gain; 880 → 700 Hz, 180 ms |
| Peak gain | 0.05 (echo 0.0175) |
| Fade in/out | The master gain fades in over 1 s when sound starts; fades out over 0.4 s on pause or stop, and the sound output is released only after the fade |
| Interval | One ping every 2.4 s |
| AudioContext | One per episode; created only when sound is first needed, closed when the episode ends or the switch is turned off. While the browser suspends it (no user gesture), nothing is scheduled and `resume()` is tried once: tones scheduled on a suspended timeline would all sound together on resume, so they are not scheduled at all. Such a ping also draws no ring, takes no wake guard and uses no task allowance |
| Sound output | `audioDevices.sink(ctx)` before sounding (after 1 s without an answer it plays on the system default); `release` after the pause fade, so “In use” appears only while it is really sounding |

Gain converted to dBFS (`20·log10(gain)`, computed in `tests/processing-cue.test.ts`):

| Sound | Gain | dBFS |
|---|---|---|
| Processing sound, main tone | 0.05 | −26.02 |
| Processing sound, echo | 0.0175 | −35.14 |
| Wake earcon (for comparison, `src/audio/earcon.ts`) | 0.18 | −14.89 |

The processing sound is about 11 dB quieter than the wake earcon. How loud it actually sounds depends on the Mac and speaker volume; it has not been measured on a Mac.

<a id="5-次數與時間上限"></a>
## 5. Count and time limits

Windows run on wall-clock time; time keeps running during a pause and missed pings are not made up later. Each ping (that actually sounds) charges 2.4 s to every source that still has allowance at that moment. When a pause ends less than 2.4 s after the last ping, the next ping waits until 2.4 s have passed.

| Rule | Value | Computed pings (fake-clock tests) |
|---|---|---|
| Episode start (no source → source) | 20 s | 0, 2.4, …, 19.2 s: ⌊20 ÷ 2.4⌋ + 1 = 9 pings |
| A new step starts running (a real step event in `firePulses`) | 6 s | 3 pings (0, 2.4, 4.8 s) |
| Another task starts running mid-episode | That task's own 20 s start window (outside the 15 s limit, and it does not use up a re-arm) | 9 pings; also when the earlier task has used its 60 s and the last re-arm was only 5 s ago |
| Gap between re-arms | at least 15 s | A second re-arm within 15 s does not extend; one that falls inside the current window and extends nothing does not count |
| Per-task cap | 60 s | ⌈60 ÷ 2.4⌉ = 25 pings, then visual only; a new task has its own allowance |
| Realtime search | No window | Only happens during a call, and a call has no sound |

<a id="6-暫停與停止"></a>
## 6. Pause and stop

| Situation | Processing sound | Brain “processing” |
|---|---|---|
| Nous speaking (`speakText`, voice-mode reply playback, conversation “speaking”) | Paused; waits another 1.5 s after speech ends (same as the wake guard's `SPEECH_TAIL_MS`) | The speaking look wins |
| Microphone capturing (push-to-talk, voice mode, realtime voice) | Paused | Unchanged |
| During a realtime voice call (including connecting) | No sound | Unchanged |
| Main window hidden (`visibilityState === "hidden"`) | Paused | Unchanged |
| Window or task allowance used up | Stays visual only | Unchanged |
| “處理中音效” switched off | Stopped (AudioContext closed) | Unchanged |
| No running source | Stopped (AudioContext closed, wake guard ended immediately) | Ends |
| Core disconnected | Tasks do not count; stops if only tasks were running | Ends if only tasks were running |
| AudioContext suspended by the browser | Nothing scheduled (no backlog that sounds all at once on resume) | Unchanged |
| “收起” (dismiss) | Not affected | Not affected (dismiss does not cancel tasks) |

When a pause reason ends while still inside a window, the sound fades in again; it pings at once if 2.4 s have passed since the last ping, otherwise when they have. Always-on wake listening stays on in the background and does not count as “capturing”; it is protected by the wake guard `cue` instead: `begin("cue")` at the start of each ping and `end("cue")` 450 ms later (main tone plus echo is 440 ms); wake words detected in between are dropped.

<a id="7-測試結果雲端容器fixture"></a>
## 7. Test results (cloud container, fixtures)

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npx vitest run` | 120 test files passed; 2257 tests passed, 5 skipped (2262 total; re-run after the review fixes) |
| `npm run build` | Passed (only the existing chunk-size warning) |
| `node scripts/check-bilingual-docs.mjs`, `node scripts/verify-aios.mjs`, `git diff --check` | See the delivery report |

New or changed tests:

- `tests/processing-cue.test.ts`: the source counts only `running` tasks and in-flight searches, searches use monotonic ids, tasks do not count while disconnected, searches do not count after the call, the 30 s search limit; 9 pings in 20 s; 3 pings in 6 s and the 15 s limit; a new task gets its own 20 s (including when another task is capped and it starts inside the 15 s gap); the 25-ping cap per task; no double ping after a pause; with a suspended AudioContext no ring, no guard and no allowance used; stop when nothing runs and a fresh start; switch off; pause during a call, while capturing and while hidden; speech plus the 1.5 s tail; the 450 ms wake guard; with a fake AudioContext: sink before scheduling, frequencies and gains, fades, release and close, play after 1 s when sink never answers, nothing scheduled while suspended and only one resume attempt, no errors without WebAudio; gain to dBFS.
- `tests/brain-regions.test.ts`: breathing range and reduced motion, speaking/error win, a success flash fades back to cyan, cyan fades normally when not processing, the ring is kept only while processing (also when the first ping happens before `setState({ processing: true })`), never with reduced motion.
- `tests/region-activity.test.ts`: processing and region focus use the same real source; processing lights no region by itself.
- `tests/wake-logic.test.ts`: the guard source `cue`.
- `tests/audio-settings.test.ts`: `processing_cue` accepts only booleans, defaults on, saves and survives a restart, HTTP route; a malformed `processing_cue` in `audio.json` resets only that key to the default (on) and keeps the device choices (`PrefsFile` validates each key separately).
- `tests/desktop-menu.test.ts`, `tests/settings-view.test.ts`: the menu checkbox and the page button, writing the opposite value, English (including the button's accessible label `Processing sound: On`).
- `tests/audio-privacy.test.ts`: the sounding places gain one `processing-sound.ts` line, which sinks before scheduling, with `audioDevices` injected.
- `tests/wake-flag-off.test.ts`: `settings.audio` gains `processing_cue: true` (with the flag off everything else is still byte-identical).

<a id="8-mac-步驟尚未執行"></a>
## 8. Mac steps (not run yet)

1. Open the App, give it a task that runs for more than 30 s, and dismiss the view. Check that the brain breathes cyan and, with the conversation idle, the status line says “背景處理中” (Working in background); for the first 20 s there is a soft sonar ping about every 2.4 s, then visuals only.
2. When the task moves to the next step, check that it pings again for about 6 s (3 pings); another step change within 15 s does not ping.
3. Let Nous read something aloud and check that there is no ping while it speaks and for 1.5 s after. None during push-to-talk either.
4. Start realtime voice and give it a task or let it search the web: check that there are visuals only and no ping.
5. Hide the window (for example switch to another App in full screen) and check that it does not ping; when it comes back inside a window, pinging resumes.
6. In the menu bar, “Camera and voice settings → Sound”, uncheck “處理中音效” (Processing sound): check that the pings stop at once and the visuals stay; the button in the in-page settings shows “Off” too. Check it again.
7. Set “Sound output” to a Bluetooth speaker and check that the pings come out of it; while pinging, the status shows that speaker as “In use”, and about 0.5 s after stopping it returns to “Plays through”.
8. With always-on wake listening on, let the pings play: check that they do not trigger it.
9. Check that Electron's AudioContext can sound in a background window or without a user gesture (the browser may suspend it).
10. Judge subjectively whether 0.05 (about −26 dBFS) is soft enough yet audible at home volume.

<a id="9-與規劃的差異"></a>
## 9. Differences from the plan

| Plan | This batch | Reason |
|---|---|---|
| Sound in `src/audio/processing-cue.ts` | In `src/processing-sound.ts` (scheduling in `src/processing-cue.ts`) | `src/audio/` is loaded by dynamic import only when `NOUS_WAKE=on` (checked by `tests/audio-privacy.test.ts`); the processing sound is not tied to a flag |
| Cyan “≥ 0.35, breathing ± 0.1” | 0.45 ± 0.1 (0.35–0.55), fixed 0.45 with reduced motion | So the lowest point is exactly 0.35 |
| One AudioContext per episode, sunk | One AudioContext per episode, but sunk only while actually sounding and released after the pause fade | “In use” appears only while it really sounds (device state follows events) |
| A new step re-arms | Another task starting mid-episode gets its own 20 s start window (outside the 15 s limit) | The plan did not cover tasks joining mid-episode; the review judged that a different task should get its own start window. The 60 s per-task cap still applies |
| An in-flight search counts | Only while the call is still on, at most 30 s; tasks do not count while disconnected | Review: a search returning after the call, or stale task states while disconnected, must not drive animation or sound |

<a id="10-未完成與限制"></a>
## 10. Not done and limitations

- Not heard or seen on a Mac; loudness, AudioContext autoplay limits and Bluetooth latency await section 8.
- Windows run on wall-clock time: if Nous is speaking when an episode starts, those 20 s may pass with no ping.
- While the browser suspends the AudioContext (no user gesture) there is no sound, only visuals; sound may start only after the first user interaction, to be checked on a Mac.
- “Nous speaking” covers only local speech synthesis, voice-mode reply playback and the conversation “speaking” state; sound from other Apps does not count.
- Always-on wake listening does not pause the sound (it is always listening); only the wake guard drops detections during each ping.
