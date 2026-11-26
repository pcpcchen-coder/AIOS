<!-- bilingual: source=zh-TW -->

> [繁體中文](duck-voice-terminal-2026-11-26.md) | [English](duck-voice-terminal-2026-11-26.en.md)

<a id="duck-2-鴨子當語音終端鴨子的喚醒--頁面開始對話頁面的語音狀態--鴨子驗證"></a>
# DUCK-2 validation: the duck as a voice terminal (the duck's wake → the page starts a conversation, the page's voice state → the duck)

Date: 2026-11-26, Asia/Taipei. Branch: `claude/duck-voice-terminal` (based on main `265cbee`). Follows [DUCK-1](duck-link-2026-11-26.en.md).

The user's decision on 2026-11-26: the duck's voice conversation goes through "Chromium on the duck's Raspberry Pi opening the Nous page (`?terminal=duck`)", the same as the existing Pi terminal — audio capture, playback and the WebRTC connection to the cloud model are all in that page, and the core does not handle audio. This batch adds two things the core could not do before:

1. **When the duck detects the wake word locally, have that page start a conversation.** (Before this there was no way at all to tell a page to start a conversation.)
2. **The page reports the real voice state (listening, thinking, speaking) to the core**, and the core turns it into the duck's interaction state (presence) — the "speaking" state that DUCK-1 lacked now has a source.

**This is not a hardware acceptance test, and it is not a real-voice acceptance test.** The server side is fixture tests (a fake voice path, a fake duck, and `fetch` standing in for the page). The page-side changes have only been type-checked and built, and **have not been run in any browser**; there is no microphone, no voice model and no real duck. Everything is behind the `NOUS_DUCK` flag (off by default); when the flag is off, behavior is the same as before.

<a id="1-做了什麼"></a>
## 1. What was done

| Part | Contents | Files |
|---|---|---|
| Wake → start a conversation | When the core receives the duck-link `wake_word` event, it sends a new event `voice.request` (`action: "start"`, `source: "wake_word"`, one-time token `duck_wake`) on the SSE stream of the duck terminal page. On receiving it, the page follows the same rules as its own wake trigger and starts realtime voice as `wake_word` | `server/nous.ts`, `server/app.ts` (`requestVoice`), `shared/types.ts`, `src/main.ts` (`onDuckWake`) |
| Wake token | `DuckWakeGate`: a one-time token issued by the core (within 15 seconds, only for that page, used once). When `POST /api/realtime/start` carries a valid token, the call is treated as `wake_word`, and **`NOUS_WAKE=on` is not required** | `server/duck/wake-gate.ts`, `shared/duck-terminal.ts`, `server/app.ts`, `src/api.ts` |
| Voice state reporting | New route `POST /api/realtime/phase` (exists only when `NOUS_DUCK=on`): the duck terminal's page reports `connecting`/`listening`/`hearing`/`thinking`/`speaking` every time the state changes. The core checks the owner and then hands it to DUCK-1's presence bridge | `server/app.ts`, `server/duck/session-bridge.ts`, `src/main.ts`, `src/api.ts` |
| Page settings for the duck terminal | `settings.duck = { terminal: true }` appears only for the page whose origin equals `NOUS_DUCK_TERMINAL`. This page: reports the voice state; **does not start its own wake listening** (the wake is detected by the duck, which avoids two detectors competing for the same microphone) | `server/app.ts`, `shared/types.ts`, `src/main.ts` |
| End when nobody speaks | A call started by the duck's wake also has the "end if nobody makes a sound" timer (5 seconds by default); this page has no wake controller and does not load `src/audio`, so it uses a timer that looks only at the call's phase (once upstream judges that the user has started speaking it stops counting) and touches no audio | `src/main.ts`, `src/duck-wake-watch.ts` |
| Setting | `NOUS_DUCK_TERMINAL`: the terminal ID of the duck terminal page, default `duck` | `server/config.ts`, `.env.example` |

Not touched: the voice session itself (the rules of `RealtimeSessions`, the two paths, cost records, memory), the wake engine and keywords, and audio device selection. The core still does not handle any audio.

<a id="2-既有的限制怎麼套用在鴨子的喚醒"></a>
## 2. How the existing limits apply to the duck's wake

| Existing rule | For the duck's wake |
|---|---|
| `source: "wake_word"` is accepted only when `NOUS_WAKE=on` | One more condition: it is also accepted when it carries a valid token the core has just issued. Reason: `NOUS_WAKE` governs "this page running its own wake listening"; the duck's wake is detected by the duck, and the evidence is the event on duck-link, not the page's say-so. No token, a used token, an expired token, or a token not issued to this page: treated as `user`, the same as before |
| Calls started by a wake are limited to 3 per 60 seconds | **Still applies**, and they are counted together with the wakes the page detects itself (the same counter in `RealtimeSessions.start`). When the limit is exceeded the core returns a refusal, and the page shows the reason and does not start |
| Only one live call and one api_key call at a time | Unchanged. A `voice.request` received during a call is ignored by the page |
| A call started by a wake always greets | Unchanged (it is simply a `wake_word` call). The voice evidence for family recognition (`wake_id`) is not available here: the audio of the wake is on the duck and is not handed to the page |
| The consent notice for realtime voice | Unchanged; it is stored in that browser's localStorage. **The duck has no screen on which to press consent**: when consent has not yet been given, the duck's wake only makes the page show the consent notice and does not start a conversation. Consent must first be given once on that browser profile by some other means (explained in the Nous Duck repo's terminal startup document) |
| No call is started by a wake while ringing | Unchanged |

Wake word: on 2026-11-26 the user decided the duck uses 「Hello 鴨子」 ("Hello duck") and 「Hey 鴨子」 ("Hey duck"), detected on the duck itself (a duck-side setting). AIOS's own keywords (「Hello Nous」「Hey Nous」) are unchanged; the core only sees "the duck says it was woken" and neither knows nor needs to know which word it was. The duck terminal page does not start the page's built-in wake listening (even with `NOUS_WAKE=on`), so that page starts a call only because of the duck's `wake_word` event, never because someone said "Hey Nous".

<a id="3-旗標啟用與回退"></a>
## 3. Flags, enabling and rollback

```bash
# .env
NOUS_DUCK=on
# NOUS_DUCK_TERMINAL=duck       # 鴨子終端頁面的終端 ID（預設 duck）
NOUS_AIL=on                     # 要讓模型叫鴨子做動作才需要（DUCK-1）
NOUS_AIL_SERVICES=duck
```

Duck side: the browser on the Pi opens `http://localhost:<the core's port>/?terminal=duck` (through the SSH tunnel; the port must be the same as the core's); duckd connects to `/duck-link`. At startup the core's log prints this page URL.

Rollback: remove `NOUS_DUCK`. No settings file or data file is written. When `NOUS_DUCK` is off: `voice.request` is not sent, `/api/realtime/start` does not recognize `duck_wake`, there is no `/api/realtime/phase` (404), and `settings` has no `duck` — `tests/duck-terminal.test.ts` has one item confirming this.

<a id="4-驗證"></a>
## 4. Validation

```bash
cd prototype/ambient-shell
TZ=UTC npx vitest run tests/duck-terminal.test.ts
npm run typecheck
```

`tests/duck-terminal.test.ts` (17 items, all fixtures):

| Category | Contents |
|---|---|
| `DuckWakeGate` | Token format; usable only once, only by that page, and void after expiry; a new wake for the same page voids the old token; a wrong format is always refused |
| `DuckWakeWatch` | Counts down while listening, pauses while thinking or speaking, restarts on listening, fires only once; the user speaking, typing or the call ending stops it for good |
| `NOUS_DUCK_TERMINAL` | Default `duck`; an invalid terminal ID (including `main`) raises an error at startup |
| Page state → presence (fake clock) | When a page reports, the duck gets a real `speaking`, in the same order as things happened; once a page has reported, core-side delegation only toggles `working` and no longer forces a switch back to `listening`; reports for a session the core does not recognize (already ended or never started) are ignored |
| HTTP (fake voice path) | `voice.request` is sent only to the duck terminal's SSE stream and carries the token issued by the core; a valid token makes the call a `wake_word` call (`NOUS_WAKE` not required) and can be used only once; no token, a made-up token, and a token issued to another page all start as an ordinary `user` call; the existing limit of 3 per minute still takes effect for the duck's wake; `/api/realtime/phase` accepts only the owner, forwards only the duck terminal's reports, and accepts only recognized state names; when the flag is off none of these exist |
| Core wiring (`startNous`, fake duck) | The fake duck sends a `wake_word` event → the SSE stream of `?terminal=duck` receives `voice.request`; other duck events do not; when the terminal page is not connected the log truthfully writes 「沒有開始對話」 ("no conversation was started"); `NOUS_DUCK_TERMINAL` decides which page is the duck's |

In addition: for the results of `TZ=UTC node scripts/verify-aios.mjs` and `node scripts/check-bilingual-docs.mjs`, see the PR description.

<a id="5-沒有驗證的事"></a>
## 5. What was not validated

- **The page-side code has not been executed in a browser** (`onDuckWake`, state reporting, the duck terminal not starting wake listening, the nobody-speaks timer). Type-checking and build only.
- A real duck, a real microphone and speaker, a real voice model; the part on the duck side that turns a local wake into the duck-link `wake_word` event (in the Nous Duck repo).
- Headless Chromium on the Pi 4 acquiring the XVF3800, echo cancellation, and the load of running alongside the duck's other programs.
- The delay between the duck hearing the wake word and the page starting to capture audio (event → SSE → start → WebRTC connection), and whether words the user has already spoken during that time get lost.
- The behavior of each of the two voice paths (the tests use a fake api_key path); inside the macOS App.

<a id="6-使用者要怎麼試"></a>
## 6. How the user can try it

The duck side needs to be ready first (the Nous Duck repo's voice field-test document). On the Nous side:

1. Using code that includes this branch, start a Nous with the flags above turned on (start a separate development instance or update the one you normally use; that is for you to decide and carry out, and you handle the keys and `.env` yourself). The log will contain 「鴨子：duck-link 已開在…；語音終端頁面：http://localhost:<埠>/?terminal=duck」 ("Duck: duck-link is open at…; voice terminal page: http://localhost:<port>/?terminal=duck").
2. Have the browser on the duck's Pi open that URL (through the tunnel). That browser profile must already have consented to realtime voice and allowed the microphone.
3. The duck's duckd connects (log: 「鴨子：鴨子已連線」 ("Duck: the duck is connected")), and the duck's wake service starts.
4. Say the wake word to the duck. Expected log: 「鴨子：聽到喚醒詞，已請終端頁面（duck）開始對話（1 個頁面）」 ("Duck: heard the wake word, asked the terminal page (duck) to start a conversation (1 page)"), followed by one `wake_word` realtime voice call; the duck's interaction state is, in order, woken, listening, thinking, **speaking**, listening, standby.
5. After 5 seconds with nobody speaking, the call ends by itself.

These steps have **not been run by anyone**.
