<!-- bilingual: source=zh-TW -->

> [繁體中文](look-to-talk-greet-2026-10-23.md) | [English](look-to-talk-greet-2026-10-23.en.md)

<a id="看著說話打招呼驗證"></a>
# Look-to-talk greeting validation

2026-10-23; base `0cf32115ed073131ba50fff16bde113e55f6538d`. This record accompanies “greet first when look-to-talk starts.” Review fixes (base `d1239a4`) appear at the end. Decisions below already describe the corrected behavior.

<a id="決定"></a>
## Decisions

George: “After the camera starts realtime voice, proactively greet once. Implement this and remember a switch in settings.”

- New camera setting `look_to_talk_greet`, “看著說話時先打招呼” (“greet first during look-to-talk”): boolean, on by default. In Camera and gestures it is indented immediately after the two look-to-talk durations. Voice can change it with “關閉打招呼”, “打招呼關掉”, “打開打招呼”, or “打招呼打開” (disable/enable greeting). Changes apply immediately. Old `camera.json` without this key uses on. The macOS menu bar displays durations and factors, not camera switches, so this batch did not add it there.
- Only conversations started by look-to-talk greet. `SenseController.startTalk` calls `startRealtime("look_to_talk")`. Buttons, voice commands, typing, and starts after consent use `"user"` and do not greet.
- Every look-to-talk start creates a `GreetingOnce` (`src/realtime-session.ts`). It reads settings only at send time (`take()`): enabling while connecting permits a greeting; disabling prevents it. Live-to-API-key fallback shares this object across sessions, allowing at most one greeting in the whole conversation.
- After session readiness, wait `GREETING_SETTLE_MS` = 600 ms before sending, as with the OpenClaw FaceTime `talk-driver.ts` greeting wait timer.
  - **API-key path:** 600 ms after `session.created`, send `{"type":"response.create","response":{"instructions":LOOK_TO_TALK_GREETING}}`. This adds only instructions for that turn, with no fake user message.
  - **ChatGPT-plan path:** wait until microphone, peer connection, and `session.started` have all arrived, then 600 ms. The page sends `POST /api/realtime/input`, `kind: "greeting"`. The core ignores page-provided text and appends fixed `LIVE_GREETING_TEXT` (`shared/sense.ts`, “（開場）” plus `LOOK_TO_TALK_GREETING`) as one `session.context.append` on channel `speakable`, without “（系統通知）”. `buildLiveInstructions` adds an instruction that content starting with “（開場）” should produce only one natural greeting and an offer to help, never read or paraphrase that content. The core marks sent only after actually sending on an open sideband, at most once per session. This matches OpenClaw `extensions/openai/realtime-quicksilver-bridge.ts`'s `triggerGreeting` (`sendContext(instructions, "speakable")`).
- Reason for 600 ms: a user already speaking needs time to generate evidence that cancels the greeting. Audio must reach the server and pass VAD or transcription before events return, at least a network round trip plus detection, around hundreds of milliseconds. 600 ms leaves margin while the greeting still starts within roughly a second of readiness. OpenClaw FaceTime waits 100 ms only for media routing to stabilize. **600 ms is an unmeasured estimate.** Home checks 1 and 4 record whether it works well.
- Speech, typing, collapse, or session end before the wait finishes prevents a greeting.
  - API key observes `input_audio_buffer.speech_started`, `sendText`, and `stop`/teardown.
  - ChatGPT plan observes user transcripts, including partial ones, `sendText`, and `stop`/teardown.
- Text typed while realtime voice is connecting (`sendText` on either path) first cancels the greeting, then queues. On connection (API key: `session.created`; ChatGPT plan: listening), queued text is merged into one message. On live-to-API-key fallback it transfers as `unsentText` and sends after the next session connects. Connection failure or collapse discards the queued text without sending.
- Honesty: `LOOK_TO_TALK_GREETING` in `shared/sense.ts` asks for one brief Traditional Chinese greeting and an offer to help, such as “我在，有什麼需要幫忙的嗎？” (“I'm here. What can I help with?”). It explicitly says the model cannot see the scene and must not claim to see the user or mention appearance, expression, clothing, or surroundings. Look-to-talk only detects that the user faces the screen; no image goes to the model.
- `LOOK_TO_TALK_GREETING` is 332 bytes. ChatGPT-plan `LIVE_GREETING_TEXT` is 344 bytes including “（開場）”, below `APPEND_MAX_BYTES` 500, so it uses one append (`Buffer.byteLength`, tested ≤ 500).

<a id="自動檢查fixture"></a>
## Automated checks with fixtures

`tests/look-greeting.test.ts` uses fake WebRTC, a fake core, and Vitest fake timers. Greeting tests in `tests/live-route.test.ts` use a fake sideband. **All are fixtures:** they prove which event is sent when, not that the model actually greets, what it says, or how it sounds.

| Scenario | Fixture result |
| --- | --- |
| Default on; directly after look-to-talk durations; booleans only | Pass |
| Old `camera.json` missing the key → on; stored false retained | Pass |
| Voice enable/disable; “打招呼” alone, negatives, and questions are not commands | Pass |
| “（開場）” marker: `LIVE_GREETING_TEXT` = marker plus greeting, ≤ 500 bytes; `buildLiveInstructions` includes the instruction | Pass |
| Look-to-talk creates object even when setting off; enabling while connecting → `take()` sends | Pass |
| API key: no send before `session.created`; no send at 599 ms, one instructions-bearing `response.create` at 600 ms, no `conversation.item.create` | Pass |
| API key: manual start sends nothing after `session.created`, unchanged from before | Pass |
| API key: disable setting while waiting → no send | Pass |
| API key: real order `session.created` → `speech_started` during wait → no send | Pass |
| API key: type during wait → typed turn only; collapse during wait → timer cleared, no send | Pass |
| API key: type while connecting, including before microphone acquisition → initially no send; merged message after `session.created`, no greeting | Pass |
| ChatGPT plan: all three readiness signals, no send at 599 ms, `greeting` at 600 ms with `LIVE_GREETING_TEXT`; duplicate started does not resend | Pass |
| ChatGPT plan: manual start or disabled setting → no send | Pass |
| ChatGPT plan: user transcript before listening → no send | Pass |
| ChatGPT plan: real order listening → partial user transcript during wait → no send | Pass |
| ChatGPT plan: typing during wait → only `user_text`; collapse → cleared timer, no send | Pass |
| ChatGPT plan: typing while connecting → initially no send; `user_text` after listening, no greeting | Pass |
| Live-to-API-key fallback: live does not send; API key sends once after billing notice; reusing object in another session does not send | Pass |
| Live-to-API-key fallback: queued live text transfers to API-key session and sends after `session.created` | Pass |
| Core: `greeting` sends fixed `LIVE_GREETING_TEXT`, speakable, at most once per session | Pass |
| Core: page-provided greeting text ignored | Pass |
| Core: non-open sideband does not mark sent; later retry sends once | Pass |

| Command in `prototype/ambient-shell` | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass |
| `npx vitest run` | 752 tests in 46 files pass (before batch: 727 in 45; initial delivery added 15, review fixes added 10) |
| `npx vite build` | Pass |
| `node --check desktop/main.mjs` | Pass |
| Repository root `node scripts/verify-aios.mjs` | PASS |
| Repository root `git diff --check` | Pass |

Existing API-key realtime tests (`tests/realtime-voice.test.ts`) are unchanged. Two existing tests changed.

- `tests/camera-prefs.test.ts` adds one key to the defaults list.
- `tests/idle-settings.test.ts` compares `main.ts` source strings; the realtime constructor now also receives `greeting`.

<a id="尚未驗證george-家中實測"></a>
## Not yet validated: George's home tests

Real voice, cameras, and both paths remain untested. Perform each step once with realtime route “API key” and once with “ChatGPT plan.”

1. **Greeting on:** enable “看著說話時先打招呼”. Stand facing the screen, let look-to-talk start automatically, and stay silent. Expected: about 0.6 seconds after the indicator becomes listening, Nous says one greeting, for example “我在，有什麼需要幫忙的嗎？”, once only. It must not mention seeing you, your appearance, or surroundings. Record exact words and seconds from listening to speech.
   - For ChatGPT plan, also check that Nous gives one greeting **without reading or paraphrasing “（開場）” or the greeting instructions**, such as “you are Nous,” “the user just faced the screen,” or “opening.”
2. **Greeting off:** say “關閉打招呼” or turn off the setting. Say goodbye to end the conversation, wait for cooldown, then look at the screen again. Expected: starts automatically but Nous does not speak first.
3. **Button start does not greet:** enable the setting and press start voice conversation or ⌥⌘V. Expected: Nous does not speak first.
4. **Immediate speech cancels greeting:** enable the setting and, as look-to-talk starts while still connecting, ask “新竹天氣如何” (“what is the weather in Hsinchu?”). Expected: direct answer without a greeting. Repeat by speaking immediately after listening, within 0.6 seconds; same expectation. If you speak later than 0.6 seconds, the greeting may already be sent and ordinary interruption applies. Record whether greeting and user speech overlap.
6. **Typing while connecting:** enable the setting and submit “新竹天氣如何” while look-to-talk is still connecting. Expected: no greeting; Nous answers after connecting.
5. **Fallback greets only once**, when feasible: choose automatic route and make ChatGPT plan unavailable, for example logged out or quota exhausted. After look-to-talk starts, expect the billing notice, then one greeting without a second greeting.

<a id="審查修正2026-10-23基底-d1239a4"></a>
## Review fixes (2026-10-23, base `d1239a4`)

Review found five issues, each with a regression failing on `d1239a4`. In a `d1239a4` worktree with only the new constants added and no behavior changes, new tests produced 16 failures: 11 newly written tests (one replaces an old “speech or typing first” test) plus five existing tests with changed expectations, a net addition of 10.

1. **“User speaks first, so no greeting” did not actually work:** the API-key path sent `response.create` synchronously inside `session.created`; ChatGPT plan sent as soon as all three readiness signals arrived. Server `speech_started`/transcripts arrive later. The old test emitted `speech_started` before `session.created`, an order the server does not produce. Both paths now wait `GREETING_SETTLE_MS` = 600 ms after readiness (reason above); `speech_started`, user transcripts including partial ones, `sendText`, and `stop`/teardown cancel the timer. Tests use real order: ready, then speech during wait → no send; silence → no send at 599 ms, send at 600 ms.
2. **ChatGPT-plan greeting lacked a marker and explanation:** the model could read the entire instructions. Added “（開場）” to `LIVE_GREETING_TEXT` and an explanatory line to `buildLiveInstructions`. API key already uses per-turn `instructions`, unchanged. Home test 1 now checks that instructions are not read aloud.
3. **Core forwarded arbitrary page greeting text:** for `kind === "greeting"`, core now ignores page text and sends only `LIVE_GREETING_TEXT`; owner, kind, and length checks remain. `greeted` is set only after actual send on an open sideband. Non-open sideband does not mark it, so later retry works without duplicate sends.
4. **Typing while connecting:** old code returned before `skip()` on both paths, so typing neither canceled the greeting nor survived. On API key, if the data channel existed but was not open, it could also leave `responding` stuck true. Chosen solution is **queueing**, safer than adding only `skip()` because typed text no longer disappears silently. `sendText` cancels the greeting first; connecting text queues and merges into one message after readiness; live-to-API-key fallback transfers it via `unsentText`. Connection failure or collapse does not send queued text; normal closure reasons remain visible.
5. **Enabling the setting while connecting:** old `greetingFor` created no object if disabled at start, so later enabling could not greet. Every look-to-talk start now creates the object; `take()` reads the setting at send time.

Unresolved: 600 ms is unmeasured. Overlap when the user speaks after sending the greeting, and whether the model actually reads “（開場）”, require home testing.
