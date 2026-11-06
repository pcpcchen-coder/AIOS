<!-- bilingual: source=zh-TW -->

> [繁體中文](realtime-cost-guard-2026-11-06.md) | [English](realtime-cost-guard-2026-11-06.en.md)

<a id="即時語音費用防護驗證"></a>
# Validation: realtime voice cost guard

Date: 2026-11-06. Branch `claude/realtime-cost-guard` (based on main `bc3d99e`). Status: **code and Linux cloud fixture tests done; not verified on the Mac App or on the Raspberry Pi kiosk.**

<a id="問題"></a>
## Problem

George, 2026-11-06: realtime voice keeps billing and does not stop. Both the Mac App and the Pi kiosk need the fix (Chromium on the Pi opens `http://localhost:8787`, tunnelled over SSH to the Mac App's core, with no `window.nousDesktop`). There were four causes:

1. The idle timer restarted on upstream speech-start events (`input_audio_buffer.speech_started`, the ChatGPT route's `speech.started`, partial transcripts) and on every reply end. With a TV or other people talking, the call never went idle.
2. No per-call limit, neither in the page nor in the core.
3. Screen lock, sleep, a page in the background, or a Pi page that disappeared did not end the call. The core ended calls only when the SSE stream closed, and the Pi's SSH tunnel can keep that connection open. For API key calls without a side channel the core could not even hang up (`close` was empty).
4. Call duration and usage were not visible.

<a id="做法"></a>
## Design

<a id="1-閒置只算真的使用者一輪"></a>
### 1. Idle counts only real user turns

The new `CallGuard` in `src/call-guard.ts` is shared by both routes (`RealtimeVoice` in `src/realtime.ts`, `LiveVoice` in `src/live-voice.ts`).

| Event | Before | Now |
|---|---|---|
| Speech-start events (`speech_started`, `speech.started`) | Restarted the timer | **Ignored** |
| Partial user transcripts (ChatGPT route) | Restarted the timer | **Ignored** |
| Final user transcript | API key: ignored; ChatGPT route: counted | Counted on both; empty text or a prompt echo (`isPromptEcho`) is ignored |
| Typing, tool results from the core, finished delegations, spoken approval answers | Mostly counted | Counted |
| Tool results on the API key route | Not counted | Counted only for tools called by a response that answered a real user turn (or a response still answering one); tools called by a noise-triggered response do not extend the call |
| Reply end (`response.done`, remote audio going quiet) | Counted every time | Only the **first** one after a real user turn counts (a credit, used once). The ChatGPT route has no `response.done`: for a reply to a real turn, each pause re-arms the timer without using the credit, and the reply ends (credit used) when the assistant's final transcript has arrived and the audio stops; a later speech-start event voids the credit |
| Replying, searching, waiting for a confirmation, tools running | Re-armed at expiry | Unchanged |

A reply triggered by noise therefore cannot extend the call indefinitely. The idle length is still the "Realtime voice idle timeout" setting (default 120 s); its hint now reads "Counts from your last transcribed sentence, typing, or Nous's reply to you".

<a id="2-每通上限頁面與核心都執行"></a>
### 2. Per-call limit (enforced by the page and by the core)

- New setting `realtime_max_call_s` (`voice.json`): default 1200 s (20 minutes), range 300–3600 s in 60 s steps, menu options 10/20/30/60 minutes, **no "unlimited"**. "Maximum length of each realtime voice call" appears in the menu bar's "Camera and voice settings" and in the "Voice" section of the page settings.
- Page: counted from connection. 60 s before the limit a caption says "The call is nearly {n} minutes long and will end automatically in one minute" and the processing cue sounds once; at the limit the call ends with "Realtime voice ended: the call reached its time limit." and cost record `end_reason: "max_duration"`. Talking does not extend it. Changing the setting during a call re-counts from the connection time.
- Core: `RealtimeSessions` starts a timer at connection. If the call is still running at **limit + 30 s**, the core ends it: it sends SSE `realtime.live` `closed{reason:"max_duration"}` to the page, writes the cost record, and calls `call.close("enforced")`. At expiry it re-reads the setting: a limit raised during the call is honoured; a lowered limit is enforced by the page, and the core keeps the value from connection time as the last line of defence.
- Hang-up: `close("enforced")` on the API key route always sends OpenAI `POST /realtime/calls/{id}/hangup`. API key calls without a side channel (`plainApiKeyCall`) now keep the call ID (in the core only, never given to the page) and hang up once on `page_gone` or `enforced`. The ChatGPT route still sends `session.close`.
- SSE drop: for an API key call without a side channel (media flows directly between the page and OpenAI) that **has already checked in**, a dropped event stream (a Wi-Fi blip, the Pi's autossh reconnecting) no longer hangs up at once: the core only forgets that stream; a page that is still there keeps checking in, and a page that is really gone is ended and hung up by the 45 s check-in timeout (`client_lost`). Calls that never checked in, memory-carrying API key calls and ChatGPT route calls still end at once (`page_gone`).

<a id="3-鎖定睡眠背景頁面失聯的頁面"></a>
### 3. Lock, sleep, background pages, lost pages

New module `src/call-lifecycle.ts` (the main program only forwards events to it).

| Situation | Mac App (has `window.nousDesktop`) | Browser and Pi (no `nousDesktop`) |
|---|---|---|
| Screen lock | Page ends the call (`os_lock`); core `endAll("os_lock", "app")` ends only calls started by the App window (the page sends `app: true` at start) | Not applicable (calls from a plain browser on the Mac are not affected either) |
| Sleep | Page ends the call (`suspend`); core `endAll("suspend")` ends every call (the core is about to sleep too) | Not applicable |
| Window hidden or collapsed | **Keeps the call** (George's default: the App lives in the menu bar) | Ends after more than 30 s in the background (`hidden`); coming back within 30 s keeps it. The timer belongs to each call: it is cancelled when the call ends, and a call started while hidden counts from its start |
| Tab closed, reload, navigation (`pagehide`) | Keeps the call (the App window does not leave this way) | Ends at once; `/api/realtime/end` is sent with `keepalive` |
| Check-in | `POST /api/realtime/alive` every 15 s, waiting at most 10 s each (a stalled request does not block later check-ins) | Same |
| Core says the call no longer exists (`alive` returns 404) | Waits 1.5 s so the core's `closed` event (for example a rebuild after a memory revocation, or the core's own end reason) arrives first; only if it is still the same open call does it end the local side with "The local core already ended this realtime voice call." | Same |

Core check-in rule: **after the first check-in**, 45 s without another ends the call (`client_lost`): the core sends `closed{client_lost}`, writes the cost record, and hangs up. Old pages that never check in are not ended by this rule. When a check-in fails with a network error the page does not end the call itself; idle and the limit still apply.

Ending only the App window's calls on lock is a deliberate deviation from the architect's plan (which said `endAll`): locking the Mac means the person at the Mac left, and should not hang up someone else's call on the kitchen Pi or a call from a plain browser on the Mac. The App window sends `app: true` to `/api/realtime/start` (reported by the page; it only decides what lock ends and is not authorization). On sleep the core itself stops, and an unattended call must not keep running, so every call ends.

Whether the end reason is spoken: the App window stays silent when lock or sleep ends the call (nobody is at the Mac); the Pi and browsers speak it (for example when Mac sleep ends a Pi call, people near the Pi hear why).

<a id="4-顯示通話時間與約略-tokens"></a>
### 4. Showing call duration and approximate tokens

- Page (visible on the Mac and on the Pi): the realtime indicator at the top right adds "3:07 / 20:00 · ~3,400 tokens", updated every second; the ChatGPT route shows "ChatGPT plan: usage unknown"; on the API key route only the time is shown until the first `response.done`. Hovering explains "Tokens are the page's sum of response.done usage (approximate), not a bill". The "Active" line in the realtime settings shows the same text (a snapshot of the core's latest settings).
- Mac menu bar: "Realtime voice: … (active) · 3:07 / 20:00 · ~3,400 tokens · Voice Listening"; calls started on the Pi are prefixed with "Terminal rpi4 · ". The data come from the new `started_at`, `max_call_s`, `usage` and `page` fields in the core's `settings.realtime.active`; the menu updates on the existing 15 s settings re-read (the plan asked for an extra 30 s refresh during calls; the existing 15 s re-read is already more frequent, so none was added).
- Tokens: on the API key route each check-in carries the call's summed usage (`parseVoiceUsage` keeps only known numeric fields and caps them); the core stores it on the session, and the cost record uses the latest check-in when the page is gone.

<a id="費用紀錄"></a>
### Cost record

`PAGE_END_REASONS` gains `idle`, `max_duration`, `hidden`, `os_lock` and `suspend` (`client_lost` is recorded only by the core and not accepted from pages). `end_reason` prefers the page's reason and otherwise uses the core's own reason. When the page's reason arrives after the core has already ended the call, it replaces only the core's generic reasons (`ended`, `page_gone`); the core's own reasons (`max_duration`, `client_lost`, `os_lock`, `suspend`, `connection_lost`, and so on) are kept as recorded.

<a id="pi-的行為"></a>
## Pi behaviour

- The Pi's Chromium kiosk has no `window.nousDesktop`, so browser rules apply: more than 30 s in the background or a closed page ends the call; the page checks in with the Mac core over the SSH tunnel every 15 s.
- **Turning off the Pi's monitor (or a screensaver) does not put the page in the background** and does not end the call; idle, the per-call limit and the core's check-in rule cover that case. The [Pi kit guide](../../terminals/rpi4/README.en.md) already recommends turning off screen blanking.
- If the SSH tunnel drops, check-ins stop reaching the core; after 45 s the core ends the call and hangs up (API key) or sends `session.close` (ChatGPT route). When the SSE stream closes: API key calls without a side channel that already checked in are left to the 45 s check-in timeout; everything else still ends at once (`page_gone`).
- Locking the Mac does not end a Pi call; Mac sleep does.
- Pi calls appear in the Mac menu bar as "Terminal rpi4 · time / limit · usage".

<a id="預設值"></a>
## Defaults

| Item | Value | Where |
|---|---|---|
| Idle | 120 s (setting 30–600 s) | `shared/voice-prefs.ts` `realtime_idle_s` |
| Per-call limit | 20 minutes (setting 5–60 minutes, no unlimited) | `shared/voice-prefs.ts` `realtime_max_call_s` |
| Warning before the limit | 60 s | `src/call-guard.ts` `CALL_WARN_BEFORE_MS` |
| Core grace | limit + 30 s | `server/realtime-routes.ts` `CORE_CAP_GRACE_MS` |
| Background end (browser and Pi) | 30 s | `src/call-lifecycle.ts` `HIDDEN_END_MS` |
| Check-in interval | 15 s | `src/call-lifecycle.ts` `ALIVE_INTERVAL_MS` |
| Lost-client threshold | 45 s after the first check-in | `server/realtime-routes.ts` `ALIVE_TIMEOUT_MS` |

<a id="自動測試linux-雲端全部-fixture"></a>
## Automated tests (Linux cloud, all fixtures)

| File | Coverage |
|---|---|
| `tests/realtime-cost-guard.test.ts` (new, 30 tests) | Added: pauses inside a long ChatGPT route reply do not let idle expire and the final transcript ends the reply; tool results from a noise response on the API key route do not extend, those from a real turn do; the App window ends silently on lock or sleep while the Pi and browsers speak the reason; the hidden timer per call (back-to-back calls, a call started hidden); a 404 waits 1.5 s and does not end a call that ended or was rebuilt meanwhile; a stalled check-in is aborted after 10 s and does not block the next. Earlier: `CallGuard`: noise replies do not extend, the credit is used once, busy re-arms, the limit ignores busy, 20-minute default with a 60 s early warning, changing the limit mid-call, `stop()`. `RealtimeVoice`: only `speech_started` ends at idle (`idle`); empty and prompt-echo transcripts and the reply they trigger do not extend, a real sentence does; typing counts; limit warning and end (`max_duration`). `LiveVoice`: `speech.started` and partial transcripts do not extend, `end("idle")`; a noise reply does not extend, a real sentence plus its reply does; the limit; the core's `closed{max_duration / client_lost / os_lock}` ends the page side without calling `/end`. `CallLifecycle`: 30 s in the background, `pagehide` with keepalive, a hidden App window keeps the call, lock and sleep end it, nothing happens without a call, check-ins only once connected, 404 ends the local side, network errors do not. Display text, limit conversion, `parsePageEndReason`, English translations without Chinese characters |
| `tests/realtime-cost-guard-core.test.ts` (new, 14 tests) | Added: a checked-in API key call without a side channel survives an SSE reconnect and is ended by the 45 s check-in timeout; never-checked-in calls and the ChatGPT route still end at once with `page_gone`; lock ends only the App window (not the Pi or a plain browser). Earlier: Core limit on both routes (limit + 30 s, SSE `closed`, `enforced`, cost record `max_duration`); raising the limit mid-call; a page that ends first records its own reason and usage; never checking in is not ended; 45 s after a check-in ends with `client_lost` and keeps the latest usage; the ChatGPT route ignores usage, owner check, 404 after the end; lock ends only the main window, sleep ends all; a late page reason replaces only generic reasons; `plainApiKeyCall` hangs up once only on `page_gone`/`enforced`, `connectApiKey` without memory keeps the call ID without exposing it; menu bar text (both routes, Pi, English); `POST /api/realtime/alive` owner check, usage filtering, and the limit from `voice.json` |
| Updated existing tests | The new setting adds a settings row: expected values in `prefs`, `voice-settings`, `http`, `desktop-menu`, `idle-settings`, `live-voice`; the `wake-flag-off` snapshot (one more `voice` key and one more menu row, an intended change); the `wake-call` source checks (`/end` now carries keepalive and LiveVoice's reason); `prefs` gains a test for the limit's range |

Overall: `npm run typecheck` passes; `npx vitest run` 148 files, 2746 tests passed, 5 skipped (one test is skipped depending on the environment, and 6 skipped has also been seen; main before the change was 146 files, 2699 passed, 6 skipped); `npm run build` passes.

<a id="mac-手動驗證步驟未執行"></a>
## Mac manual steps (not run)

1. Menu bar "Camera and voice settings" → "Voice": "Maximum length of each realtime voice call: 20 min" is listed; change it to 10 minutes and the same row in the page settings follows.
2. Start realtime voice on the API key route: the indicator at the top right shows "0:0x / 10:00", and "~N tokens" after the first reply; within 15 s the menu bar's "Realtime voice" line shows the same time and usage.
3. Leave a TV or a recorded conversation playing without talking to Nous: after the default 120 s (you can set idle to 1 minute first) the call ends with the no-speech caption; the last line of `voice-cost.jsonl` has `end_reason` `idle`. A TV line that is transcribed counts as a turn; this is a known limit and can keep the call alive until the per-call limit.
4. Set the limit to 5 minutes and keep talking to Nous: the warning caption and cue at minute 4, the end at minute 5, record `max_duration`.
5. Collapse the window during a call: the call continues. Lock the screen: the call ends; after unlocking the caption reads "Realtime voice ended because the screen locked.", record `os_lock`. Sleep and wake: record `suspend`.
6. Repeat steps 2 and 4 on the ChatGPT route: the indicator shows "ChatGPT plan: usage unknown".
7. Check the OpenAI usage page: no realtime usage keeps accumulating after steps 3–5 end (tokens shown are only the page's approximate numbers, not a bill).

<a id="pi-手動驗證步驟未執行"></a>
## Pi manual steps (not run)

1. Put the Mac App in service mode and start realtime voice on the Pi kiosk: the Pi's indicator shows time and usage; the Mac menu bar shows "Terminal rpi4 · …".
2. Switch to another window or minimize Chromium on the Pi for more than 30 s: the call ends, record `hidden`; returning within 30 s keeps it.
3. During a call, unplug the Pi's network or stop the SSH tunnel (`systemctl --user stop aios-tunnel`): the Mac core ends the call within about 45 s (or at once when SSE closes), record `client_lost` or `page_gone`; OpenAI usage stops growing.
4. Turn off the Pi's monitor: the call does **not** end because of that; it ends only by idle or the limit.
5. Lock the Mac: the Pi call continues. Put the Mac to sleep: the Pi call ends, record `suspend`.
6. Reload the Pi page: the call ends at once (`hidden`, sent with keepalive).

<a id="誠實的限制"></a>
## Honest limits

- TV or bystander speech that speech recognition transcribes still counts as a turn; the page cannot tell who spoke. **The per-call limit is the backstop.**
- Tokens are the page's sum of the usage in `response.done`, **not a bill**: input audio before a response finishes is not included, and pricing is not modelled; the cost record's `cost` is still always `unknown`.
- The ChatGPT route has no usage data; it always shows usage unknown and nothing is estimated.
- The menu bar time updates only on the core settings re-read (every 15 s); the page indicator updates every second.
- On the ChatGPT route the end of a reply is taken from the assistant's final transcript; if the upstream sends none, the credit stays until the next speech-start event, and until then a pause in a noise-triggered reply can re-arm the timer once more.
- The warning sound reuses the processing cue; if the browser has suspended the AudioContext (no user gesture) it is silent and only the caption shows.
- The core ends ChatGPT route calls with the side channel's `session.close`; if the side channel is already gone there is no other hang-up (the upstream connection has ended too).
- API key calls without a side channel: an SSE drop before the first check-in (within 15 s of connecting) still hangs up at once; after a check-in, an SSE drop can leave up to about 45 s more billing before the core hangs up (a page that is still there continues normally, but the core cannot send it events). Memory-carrying API key calls and ChatGPT route calls still end at once when SSE drops.
- Not verified on Mac or Pi hardware; lock and sleep events are fixtures only.

<a id="回復"></a>
## Rollback

- Revert this branch's commit. The extra `realtime_max_call_s` key in `voice.json` is unknown to older builds: they skip it with a log line and keep the other settings.
- To loosen without reverting: set the limit to 60 minutes and idle to 600 s (they cannot be turned off).

<a id="變更的檔案"></a>
## Changed files

`prototype/ambient-shell/`: `src/call-guard.ts` (new), `src/call-lifecycle.ts` (new), `shared/call-meter.ts` (new), `src/realtime.ts`, `src/live-voice.ts`, `src/realtime-session.ts`, `src/main.ts`, `src/api.ts`, `src/views.ts`, `shared/voice-prefs.ts`, `shared/voice-cost.ts`, `shared/realtime-route.ts`, `shared/messages.en.json`, `server/realtime-routes.ts`, `server/apikey-call.ts`, `server/live-route.ts`, `server/app.ts`, `server/nous.ts`, `desktop/main.mjs`, `desktop/settings-menu.mjs`, `desktop/settings-menu.d.mts`, `desktop/messages.en.json`, `shared/seconds-menu.ts`, `shared/voice-commands.ts` (one more voice-command row, "Each realtime voice call reaches its limit"), `README.md`/`README.en.md` (voice idle table and command table), plus the tests listed above.
