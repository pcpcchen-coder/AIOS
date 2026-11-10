<!-- bilingual: source=zh-TW -->

> [繁體中文](23_Architecture_Review_2026-11.md) | [English](23_Architecture_Review_2026-11.en.md)

# Nous 23 — Architecture review and restructuring plan (2026-11)

Version: v0.1 · Date: 2026-11-09 · Status: **proposal; no code moves until George approves**. This document only surveys and plans; no product code was changed. The numbers come from [`scripts/architecture-metrics.mjs`](../scripts/architecture-metrics.mjs); the method and output are in the [validation record](validation/architecture-review-2026-11-09.en.md). Baseline: main `416a1ab` (after PR #138).

Line numbers refer to the baseline commit and will drift; use file and function names as the anchor.

## 0. One-page summary

- The prototype `prototype/ambient-shell` now has 241 source files and 66,887 lines (server 30,844, src 25,626, shared 7,721, desktop 2,696). It is no longer the small prototype planned in 2026-10. Every check is green on the baseline: typecheck, 172 test files with 3,188 of 3,194 tests passing and 6 skipped (the skip count is environment-dependent: 3,189 / 5 when the local file lock is available), the Vite build, `verify-aios`, and the bilingual check.
- The layering itself is clean: `server`, `src` and `desktop` import only `shared`, and there are **zero cross-layer imports**. The problems are inside each layer: 16 files over 800 lines, 4 import cycles, and the same thing written in two or three places.
- The five largest problems, ordered by the cost of leaving them:
  1. `src/main.ts` is 4,211 lines, imports 67 modules and mixes 12 responsibilities; every feature batch edits it.
  2. The two realtime voice paths duplicate each other: 13 same-named private methods on the page (`src/realtime.ts` / `src/live-voice.ts`), and separate implementations of `recall_memory` / `delegate_task` in the core (`server/apikey-call.ts` / `server/live-tool-caller.ts`). Every voice fix has to be made twice.
  3. Settings and data files are written in scattered ways: 11 stores go through `prefs-file.ts`, 15 other modules besides `prefs-file.ts` do their own tmp+rename (several of them are task, memory and identity data files rather than settings), plus page localStorage and `desktop.json`; four defaults are declared in two places.
  4. `server/home-bridge.ts` (1,655 lines) holds the hub `/commands` path, the AIFA air conditioner, the infrared path and the parsers in one file; it has only 4 importers, so splitting it is cheap.
  5. The docs lag the code: the root README, the prototype README, `docs/11` and `docs/12` still say memory, encrypted storage, family recognition and the wake word are "not implemented" or "pending PoC"; `docs/validation/README.md` is missing 9 records. Under the CLAUDE.md reading order, later agents are misled by these sentences first.
- The plan is S0 (this document) plus 14 steps (§3, 15 rows in all). Each is a small PR that can be merged alone, changes no behaviour and keeps every test green. Low-risk work (doc sync, renames, shared helpers) comes first; splitting `app.ts` and `main.ts` comes last.

## 1. Current architecture

### 1.1 Size

| Layer | Files | Lines | Largest file |
|---|---|---|---|
| `server/` (local core, Node http + SSE) | 102 | 30,844 | `memory/service.ts` 2,613 |
| `src/` (page, Vite, framework-free TypeScript) | 92 | 25,626 | `main.ts` 4,211 |
| `shared/` (contracts shared by page, core and desktop) | 38 | 7,721 | `identity.ts` 629 |
| `desktop/` (Electron macOS shell) | 9 | 2,696 | `main.mjs` 1,523 |
| `tests/` | 172 test files | — | — |

The 16 files over 800 lines: `src/main.ts` 4,211, `server/memory/service.ts` 2,613, `src/views.ts` 2,028, `server/identity-service.ts` 1,684, `server/home-bridge.ts` 1,655, `desktop/main.mjs` 1,523, `server/app.ts` 1,369, `server/memory/live.ts` 1,361, `server/realtime-routes.ts` 1,275, `src/family-view.ts` 1,259, `src/realtime.ts` 1,080, `server/store.ts` 1,029, `src/live-voice.ts` 884, `src/brain.ts` 873, `src/memory-view.ts` 836, `server/live-route.ts` 811.

### 1.2 Module map

```
desktop/main.mjs ──(dynamic import of the bundled server.mjs)──▶ server/nous.ts startNous ──▶ server/app.ts createApp (the only HTTP server)
      │  HTTP fetch to 127.0.0.1 (settings, tasks; polled every 15 s)                  │
      │  IPC: identity / memory / tasks / camera-enable / confirm-delete               │ SSE /api/events
      ▼                                                                                ▼
BrowserWindow ── loads index.html ──▶ src/main.ts (page composition root) ◀── EventSource ── the page calls /api/* only through src/api.ts
                                          │
                                          └── shared/* (types, preference specs, route contract, i18n, command table)
```

**server/ subsystems** (responsibility → main files)

| Subsystem | Files | Responsibility |
|---|---|---|
| HTTP core | `app.ts`, `nous.ts`, `index.ts`, `http-guard.ts`, `page-headers.ts`, `localization.ts`, `config.ts` | Every route is an `if (method && path)` chain in `handleApi` (`app.ts:404-1053`); `nous.ts` is the composition root that builds every store and service and wires `onChange → notify()` to `server.notifySettings` (`nous.ts:570`) |
| Delegation and execution | `runner.ts`, `store.ts`, `providers.ts`, `claude-executor.ts`, `chatgpt-executor.ts`, `mock-executor.ts`, `prompts.ts`, `chat.ts`, `history.ts`, `sealed-vault.ts`, `protected-index.ts`, `task-migration.ts`, `task-ipc.ts` | HTTP submit → `TaskRunner` → `ProviderManager` / executor → Artifact → SSE `task.updated`; the macOS App encrypts tasks and results in `data/sealed/` |
| Realtime voice, API-key path | `realtime.ts` (`RealtimeBridge` plus **the tool table and rules shared by both paths**), `apikey-call.ts` (core sideband: only `recall_memory` / `delegate_task` run in the core), `realtime-routes.ts` (`RealtimeSessions`, the `RealtimeRoute` interface, `planStart`, `ApiKeyRoute`), `realtime-settings.ts`, `sideband.ts`, `web-search.ts`, `voice-cost-log.ts` | The page talks to OpenAI directly over WebRTC; tools run in the page (`src/realtime-tools.ts`) and POST back to the core |
| Realtime voice, ChatGPT-plan path | `live-route.ts` (`LiveRoute` / `LiveCall`), `live-tool-caller.ts` (Codex Responses tool loop), `codex-responses.ts`, `codex-auth.ts`, `chatgpt-auth.ts` | Tools run in the core: `app__*` goes straight to the integration Dispatcher; the other HOST_TOOLS go to the page over SSE `realtime.host` and come back via `/api/realtime/host-result` |
| HomeBridge (the home hub) | `home-bridge.ts`, `home-overview.ts`, `home-corner-settings.ts`, `integrations/adapters/home.ts` (AIL-2 Facade) | Name matching, reading normalisation, `/commands`, AIFA air conditioner, infrared, confirmation queue, 6 commands per minute |
| Integration layer (AIL) | `integrations/{index,registry,dispatcher,policy,schema,status,contracts}.ts`, `adapters/{timer,alarm,weather,home,lg-tv,gmail-gog,google-calendar,spotify-soloist,voice-relay,mock}.ts`, `voice-relay/*`, `lgtv/*`, `gog/runner.ts` | Tool registration, policy, on-demand status; `config.ts` imports three adapters directly |
| Memory (family memory) | `memory/{service,live,store,parse,boundary,suggest,retrieve}.ts` | macOS App only, over IPC; `memory/live.ts` also provides spoken confirmation and `delegatePolicy` to both voice paths |
| Memories mode (photos) | `memories.ts`, `memories-google.ts`, `memories-meta.ts` | Same word, different feature from "memory" |
| Identity, face, voice, wake | `identity-service.ts`, `identity-store.ts`, `greeting-picker.ts`, `face-runtime.ts`, `speaker-runtime.ts`, `wake-runtime.ts`, `terminal-routes.ts` | The three `*-runtime.ts` files are near-identical (hash check, served under `/…-runtime/`) |
| Settings files | `prefs-file.ts` and 11 PrefsFile stores (9 `*-settings.ts` plus `memories.ts`, `proactive.ts`); 15 other modules write their own files | See §1.4 |
| Proactive, alarms, weather | `proactive.ts`, `proactive-calendar.ts`, `alarms.ts`, `weather.ts`, `local-date.ts` | `alarms.json` is scheduled by the core |
| Terminal (Pi) | `terminal-presence.ts`, `terminal-display.ts`, `terminal-routes.ts`; `shared/terminal.ts` | The core listens on loopback only; the Pi comes in through an SSH tunnel |

**src/ subsystems**

| Subsystem | Files | Notes |
|---|---|---|
| Composition root | `main.ts` (4,211 lines), `shell-state.ts`, `presentation-policy.ts`, `api.ts`, `intent.ts`, `desktop-command.ts` | The 12 responsibilities of `main.ts` are listed under §2 problem 1 |
| Views | `views.ts` (2,028 lines: Surfaces, 13 `render*Settings`, panel state types, text tables), `settings-entry.ts`, `performance.ts`, `voice-volume.ts` | |
| Brain | `brain.ts` (state and orchestration), `brain-canvas.ts`, `brain-webgl.ts`, `brain-frame.ts`, `region-activity.ts`, `processing-cue.ts`, `processing-sound.ts` | The six-region animation is driven only by `domain` events (CLAUDE.md requirement) |
| Realtime voice page layer | `realtime.ts` (`RealtimeVoice`, API key), `live-voice.ts` (`LiveVoice`, Codex), `realtime-session.ts` (the `RealtimeSession` seam, `openRealtime`), `realtime-tools.ts` (tool executor and approval queue shared by both paths), `call-guard.ts`, `call-lifecycle.ts`, `early-speech.ts`, `voice-command.ts`, `echo.ts`, `voice.ts`, `conversation.ts` | |
| Sensing (camera) | `sense/{controller,pipeline,processor,trackers,geometry,identity-ambient,identity-client,identity-worker,light-worker}.ts`, `sense/face/*`, `light-meter.ts`, `face-calibration*.ts` | Only the worker can read pixels |
| Audio front end, wake, speaker | `audio/*` (`AudioFrontEnd`, `WakeController`, sherpa wasm), `audio-devices.ts`, `speaker/*` | |
| Memory, history, family views | `family-view.ts` (1,259), `memory-view.ts` (836), `history-view.ts`, `protected-tasks.ts`, `memories.ts` (photos), `identity-bridge.ts` | |
| Corners and alarms | `home-corner.ts`, `clock-corner.ts`, `alarm-ring.ts` (471 lines, no direct test), `alarm-sound.ts` | |
| Terminal (Pi) | `terminal-camera.ts`, `terminal-heartbeat.ts`, `screen-reporter.ts` | |

**shared/**: `types.ts` (fan-in 37), `i18n.mjs` (40), `identity.ts` (26), `realtime-route.ts` (24) and `sense.ts` (23) are the contracts most modules depend on. `prefs.ts` defines the preference-spec engine; `CAMERA_PREFS` in `sense.ts`, `VOICE_PREFS` in `voice-prefs.ts`, and `day-night.ts`, `wake.ts`, `alarm.ts`, `clock.ts`, `home-corner.ts`, `memories.ts`, `proactive.ts`, `audio-devices.ts` each hold their own defaults and write-path constants.

**desktop/**: `main.mjs` starts the core inside the same Node process (`startCore`, `main.mjs:141`), reads and writes settings over HTTP, serves the page over IPC, and sends `nous:command` to the page with `executeJavaScript` (`main.mjs:602` → `src/main.ts:3607`). `settings-menu.mjs` (785 lines) is a pure menu template; because it cannot load `.ts`, it copies shared constants and five text tables (its own comments at `settings-menu.mjs:15,184,311,379,408,455,499,544,753` say so).

### 1.3 Data flows

**A. Realtime voice, API-key path**

```
page POST /api/realtime/start → RealtimeSessions.planStart picks the route → StartDecision{route:"api_key"}
page RealtimeVoice (src/realtime.ts) WebRTC ⇄ OpenAI Realtime (oai-events data channel)
    tool calls run in the page: src/realtime-tools.ts executeRealtimeTool → POST /api/home/*, /api/integrations/call, /api/realtime/web-search
core ApiKeyCall (server/apikey-call.ts) opens the sideband WebSocket (server/sideband.ts)
    only recall_memory / delegate_task run in the core; memory/live.ts decides memory and delegation policy
    events return to the page over SSE realtime.live{kind: briefing|hold|closed|memory_*|delegate_*}
```

**B. Realtime voice, ChatGPT-plan (Codex live) path**

```
page POST /api/realtime/start → StartDecision{route:"live"} → LiveRoute.start (server/live-route.ts, chatgpt.com /backend-api/codex/realtime/calls)
page LiveVoice (src/live-voice.ts): the WebRTC data channel only receives frameless events; text goes out via POST /api/realtime/input
core LiveToolCaller (server/live-tool-caller.ts) runs the Codex Responses tool loop:
    recall_memory / delegate_task in the core; app__* straight to IntegrationDispatcher;
    the other HOST_TOOLS (home_*, web_search, end_conversation, …) via SSE realtime.host → page executes → POST /api/realtime/host-result
```

Shared by both paths: the tool schemas and rule text in `server/realtime.ts` (`buildRealtimeTools`, `realtimeToolRules`), the event contract in `shared/realtime-route.ts`, the page tool executor in `src/realtime-tools.ts`, local commands in `src/voice-command.ts`, and the time limits in `src/call-guard.ts`.

**C. Delegation and tool execution**

```
POST /api/tasks (or voice delegate_task) → TaskStore (tasks.json; encrypted in data/sealed/ inside the App) → TaskRunner (concurrency cap 4)
   → ProviderManager picks claude / chatgpt / mock → executor plans, generates step by step, summarises → Artifact (artifacts.json)
   → store.subscribe → SSE task.updated / task.deleted → page renderProgress / renderArtifact (shown only on user_request)
```

**D. HomeBridge (hub)**

```
voice home_status / home_control (or a typed command)
  → API-key path: page → POST /api/home/{status,control,confirm}; live path: core → SSE realtime.host → page → the same /api/home/*
  → app.ts homeCall (app.ts:1080): through the adapters/home.ts Facade when NOUS_AIL lists home, otherwise HomeBridge directly
  → HomeBridge.control → planFor picks the route: commands (POST /api/v1/devices/{id}/commands)
                                                 aifa_power / aifa_climate (/integrations/aifa/…)
                                                 ir_key (/infrared-commands)
  → commands that need confirmation go to pending (90 s, at most 8) → page confirmation card → POST /api/home/confirm
Top-left home status: GET /api/home/overview → HomeOverview (30 s cache) → read-only, not a Surface
```

**E. Stereo camera sensing**

```
getUserMedia (gated by the main process inside the App) → SensePipeline (MediaPipe, /vision/*) → trackers / geometry (head pose, nominal distance, open palm, arm)
  → SenseController events → main.ts: Shell state, brain zoom, look-to-talk
  → identity-worker (the only reader of pixels) → IdentityClient → core identity-service (IPC only; the Pi via /api/terminal/identity)
  → light-worker: one brightness number every 30 s → day-night (night volume, night mode)
Raw frames are never written to disk, traced or sent out (CLAUDE.md red line).
```

**F. Settings and preferences**

```
write: page src/api.ts POST /api/settings/{provider,camera,camera-tuning,voice,audio,wake,clock,alarms,day-night,home-corner,proactive,memories,realtime}
       desktop main.mjs uses the same HTTP; the Pi's camera settings stay in page localStorage (terminal-camera.ts)
store: 11 PrefsFile stores (camera/voice/audio/wake/face-tuning/clock/home-corner/day-night/realtime/proactive/memories .json)
       + 15 modules that write their own files (alarms, providers settings.json, two credentials files, identity, memory, sealed vault, voice relay, lgtv, voice-cost.jsonl, proactive-log, …)
       + page localStorage (a second copy of day-night / luma / volume, performance, locale, Web Speech consent)
       + desktop.json (locale, realtimeModel / realtimeVoice fed to the core as environment variables, maxConcurrent, window bounds)
broadcast: each store's onChange → nous.ts notify() → app.ts notifyAll → SSE settings.updated (rendered per Mac / terminal source)
read: GET /api/settings → app.ts settings.view() aggregates → localizeSettings (repeated 18 times in app.ts)
```

### 1.4 External interfaces

**HTTP routes: 85** (80 under `/api/*` plus 5 non-API dispatches), all in `server/app.ts` except the 10 voice-relay routes in `server/integrations/voice-relay/routes.ts:57-126`. The counting method is in the validation record.

| Group | Routes | Location |
|---|---|---|
| Settings | `GET /api/settings`; `POST /api/settings/{provider,camera,camera-tuning,voice,audio,wake,clock,alarms,day-night,home-corner,proactive,memories,realtime}` | `app.ts:406-679` |
| Alarms | `POST /api/alarms/{stop,ack,notice/clear,timers/cancel,clear,snooze,alarms/add,alarms/enable,alarms/delete}` | `app.ts:527-569` |
| Weather and home | `GET /api/weather/now`, `GET /api/home/overview`, `POST /api/home/{status,control,confirm}` | `app.ts:509,586,937-957` |
| Photo memories | `POST /api/memories/google/{pick,cancel,clear}`, `GET …/qr.svg`, `GET /api/memories/items`, `GET /api/memories/media/:id` | `app.ts:637-662` |
| Chat | `POST /api/chat` (stream) | `app.ts:683`, `streamChat` 1110 |
| Realtime | `POST /api/realtime/{start,call,input,approval,host-result,stopped,playback,stop-reply,alive,end,web-search}`, `GET /api/realtime/cost-records` | `app.ts:684-894` |
| Terminal | `POST /api/terminal/{heartbeat,identity,memory}`, `GET/POST /api/terminal/display` | `app.ts:816-842` |
| Integrations | `GET /api/integrations/status`, `POST /api/integrations/call`; voice relay `GET /api/voice-relay` plus 9 POSTs | `app.ts:852-891`, `voice-relay/routes.ts` |
| Auth | `POST /api/auth/codex/{login,cancel,logout}`, `POST /api/auth/chatgpt/{login,cancel,logout,welcome-ack}` | `app.ts:916-981` |
| Tasks and history | `GET/POST /api/tasks`, `POST /api/tasks/:id/{cancel,retry}`, `GET /api/artifacts/:id`, `GET /api/history`, `GET /api/history/:id`, `POST /api/history/:id/delete`, `GET /api/events` (SSE) | `app.ts:986-1038` |
| Non-API | `GET /help/commands`, `/face-runtime/*`, `/speaker-runtime/*`, `/wake-runtime/*`, static pages (`/history` → `history.html`) | `app.ts:375-393` |

**SSE events (`/api/events`, type `shared/types.ts:208-217`)**: `hello` (`app.ts:1221`), `task.updated` (350), `task.deleted` (354), `settings.updated` (`notifyAll` 1205), `memory.presence_changed` (1243), `realtime.host` (`realtime-routes.ts:1201`), `realtime.live` (`realtime-routes.ts:752,1114,1156,1193`; the `kind` list is in `shared/realtime-route.ts:250-283`, emitted by `live-route.ts`, `apikey-call.ts` and `memory/live.ts`). The page uses only an anonymous `onmessage` and dispatches on `type` in `src/main.ts:2728` `onServerEvent`. SSE frames `data: …\n\n` are assembled by hand in five places in `app.ts` (296 realtime sideband, 346 `broadcast`, 1125 `streamChat`, 1209 `notifyAll`, 1222 `hello`), with the keep-alive at 366. `/api/chat` has its own per-request stream events (delta, delegate, delegate_blocked, delegated, memory_notice, memory_revoked, done, error).

**Settings files (configDir)**

| Through `prefs-file.ts` (per-key validation, tmp+rename, 0600, broadcast on change) | Own file handling |
|---|---|
| `camera.json`, `voice.json`, `audio.json`, `wake.json`, `face-tuning.json`, `clock.json`, `home-corner.json`, `day-night.json`, `realtime.json`, `proactive.json`, `memories.json` | `alarms.json` (`alarms.ts:615`), provider `settings.json` (`providers.ts:172`), `chatgpt-credentials.json`, `codex-credentials.json`, `proactive-log.json`, `memory-enabled.json` (`nous.ts:687`), `voice-cost.jsonl`, `memories/google/index.json`, voice relay `config.json` / `trials.json`, `lgtv.json`, identity `gallery.v1.json` and two more, memory `store.v1.enc`, `data/sealed/*.enc`, `tasks.json` / `artifacts.json` |

`desktop.json` is managed by `desktop/main.mjs:25` alone; the core does not know it.

### 1.5 Test coverage

| Class (first match wins) | Files | Notes |
|---|---|---|
| Desktop (imports `../desktop/`) | 25 | Electron module logic; no real Electron window |
| Server HTTP (`server/app.ts` or `node:http`) | 23 | Really starts `createApp` with `MockExecutor`; the fake hub, fake TV and fake OpenAI sideband live here |
| Page DOM | 29 | **No jsdom / happy-dom installed**; tests hand-roll fake elements with `vi.stubGlobal("document", …)` or read `src/*.ts`, `index.html`, `style.css` as text |
| Fixture / replay | 30 | `tests/fixtures/*`: fake-sideband, fake-chatgpt, apikey, … |
| Pure functions | 65 | shared and pure logic |

- 26 source modules are not imported directly by any test (list in the validation record). The ones with logic are `src/alarm-ring.ts` (471 lines), `src/clock-corner.ts`, `server/prefs-file.ts` (only tested indirectly through the 11 stores) and `server/sideband.ts` (replaced by a fixture). `src/main.ts` and `desktop/main.mjs` can only be exercised by browser scripts anyway.
- Every external service is faked, and labelled as such (Anthropic fake fetch, OpenAI sideband fixture, Codex / ChatGPT fake servers, fake hub, fake webOS TV, fake Soloist, fake gog, fake Open-Meteo). Only `day-night-volume.test.ts` and `wake-wasm-build.test.ts` use fakes without a mock / fixture label at the top.
- The six browser scripts `scripts/verify-*.mjs` all run the mock provider and are outside vitest.
- Real-device evidence exists only in some records and is always partial: Mac (HIST-1, ID-02, WK-00, SP-00 / 02a / 02b, live-voice §4, the MEM-0 keychain probe), Pi 4 (`rpi-deployment-fixes`, `memories-idle-after-call`, the brightness readings in `day-night-badge`), and the spoken confirmation of the home light switch (H1). The other 60-odd records are fixture, mock or headless Chromium. No record can move G0–G3 to passed.

## 2. Architecture problems, in priority order

Each item carries evidence and the cost of not fixing it. P1 is being paid now; P2 should be handled before the next feature batch; P3 is incidental or optional.

### P1-1　`src/main.ts` is a 4,211-line composition root and catch-all

- Evidence: imports 67 modules (highest fan-out in the repo); sections are listed in the validation record: DOM references (`main.ts:166-376`), realtime orchestration (432-1009), settings application and audio devices (1010-1265), camera lifecycle (1545-1901), `*FromRealtime` tool handlers (2477-2593), the SSE reducer `onServerEvent` (2728), typed commands `handleCommand` (2865), the `actions: ViewActions` object with 35 members (3071-3330), `render` (3419), Electron `nous:command` (3607). It uses `document.body.dataset` as shared state (1616-1617, 1760, 3563).
- Cost of leaving it: every feature batch edits this file, so two parallel branches conflict; no test can import `main.ts` directly (§1.5), so regressions are caught only by headless Chromium scripts; a new agent must read 4,000 lines before touching anything.

### P1-2　Each realtime voice path is written twice

- Page layer: `src/realtime.ts` and `src/live-voice.ts` share 13 same-named private methods (`skipGreeting` / `cancelGreetTimer` / `scheduleGreeting` / `greetIfPending` 558-591 vs 392-424; `watchEarlySpeech` / `stopEarlySpeech` 961-985 vs 707-731 differ by two lines; `onCore` 857 vs 542 handle the same set of `LiveCoreEvent`; `onHostCall` 896 vs 636; `CallGuard` and `ApprovalQueue` construction 262-275 vs 156-174). `quietLocalCommand` is done two different ways (`response.cancel` vs mute timers).
- Core layer: `recall_memory` / `delegate_task` are implemented in `apikey-call.ts:308-345` and again in `live-tool-caller.ts:220-266`, both calling `delegatePolicy` and `MAX_RECALLS`; the calendar follow-up is in `apikey-call.ts:188-195` and `live-route.ts:503-507`.
- The tool name list is declared four times: `shared/realtime-route.ts:171 HostToolName`, `shared/voice-commands.ts:75 RealtimeToolName`, `live-tool-caller.ts:84 HOST_TOOLS`, the keys of `realtime-routes.ts:186-195 HOST_TIMEOUT_MS`; home-tool argument limits three times (`realtime.ts:97-140`, the `adapters/home.ts` schema, `app.ts:941-951`).
- Cost of leaving it: every voice fix is made twice, and only one path can be tested at home at a time (the Mac records show the API-key and ChatGPT-plan results drifting apart repeatedly); a new tool means four lists, and missing one yields "unknown tool" on one path.

### P1-3　Settings and preferences live in four kinds of place

- Evidence: 11 stores use `prefs-file.ts` (the shared helper writes at `prefs-file.ts:100`); 15 other modules each do their own tmp+rename (`alarms.ts:615`, `providers.ts:172`, `chatgpt-auth.ts:511`, `codex-auth.ts:588`, `proactive.ts:106`, `nous.ts:687`, `voice-cost-log.ts:54`, `identity-store.ts:388`, `memories-google.ts:219`, `task-migration.ts:158`, `sealed-vault.ts:123`, `memory/store.ts:347`, `store.ts:1013`, `voice-relay/store.ts:84`, `lgtv/store.ts:39`); the comment at `sealed-vault.ts:11` says it is "the same as memory/store.ts". `clock-settings.ts` and `home-corner-settings.ts` differ only in comments, the `unreadable` message string and import order once the domain word is renamed.
- The page keeps a second copy: `DAY_NIGHT_KEY` / `LUMA_THRESHOLDS_KEY` in `src/voice-volume.ts` (:10-12) in localStorage; `main.ts:1588 dayNightPrefs()` reads the core first and falls back to localStorage, with migration code at `:1649`.
- Defaults written twice: the call limit `src/call-guard.ts:12 DEFAULT_MAX_CALL_MS` vs `shared/voice-prefs.ts`; `gpt-realtime` / `marin` in `desktop/main.mjs:61-62` and `server/config.ts:136-137`; `maxConcurrent 4` in `desktop/main.mjs` and `server/runner.ts:57`; the `REALTIME_ROUTES` labels in `desktop/main.mjs:53` and `shared/realtime-route.ts:15`.
- The desktop copies shared: `WAKE_STATE_REASONS` (`settings-menu.mjs:19`), `WAKE_THRESHOLD_OFFSETS` (:88), `DEFAULT_WAKE_SILENCE_S` (:99), the audio sanitizer (:229), `formatCallClock` (:761), five text tables; `preload.cjs:10,26-62` copies again.
- Cost of leaving it: changing one default means finding four places, held together only by "the copies stay in sync" comparison tests (the `settings-menu.mjs` comments say so); a cross-device setting like night mode already carries "one copy in the core, one in the page" transition code.

### P1-4　`server/home-bridge.ts`: 1,655 lines, three paths in one file

- Evidence: constants 37-86, types 87-212, reading normalisation 214-283, command parsing 285-392, target matching 393-477, `planFor` 626, AIFA 667-767, infrared 768-843, three reply mappers 844-927, `class HomeBridge` 928-1511 (`sendCommands` 1142, `sendAifa` 1159, `sendIr` 1242, `discoverAifa` 1425, `home` 1484), parsers 1512-1654. The only importers are `app.ts:18`, `nous.ts:29`, `home-overview.ts:9`, `adapters/home.ts:3` and 4 tests.
- Cost of leaving it: H2–H4 (`docs/12` §6) will pile device policy and room commands into the same file; AIFA / infrared changes touch the `/commands` path that H1 already verified by voice at home. The good news: few importers, mostly pure functions, and `home-bridge.test.ts` covers all three paths with a fake hub, so the split is low risk.

### P1-5　Docs disagree with the code

| Document | Says | Code |
|---|---|---|
| root `README.md:79,124,155` | long-term memory missing; doc 16 "not yet enabled in the product" | `server/memory/*`, `desktop/memory-ipc.mjs`; MEM-0 to 5b merged |
| root `README.md:125,160` | speaker recognition still planned; sherpa-onnx pending PoC | `src/speaker/*`, `server/speaker-runtime.ts`; `package.json` sherpa-onnx 2.0.1, `src/audio/wake-worker.ts` |
| root `README.md:82` | 48 test files, 790 tests | 172 files, 3,188 tests |
| `prototype/ambient-shell/README.md:217` | the visual region has "no camera or image analysis pipeline" | `src/sense/*`, `light-worker.ts` |
| prototype `README.md:377,471,480` | encrypted storage "not implemented (MEM-4a, 4c)", "no memory layer", "data stored as plaintext JSON" | `server/sealed-vault.ts`, `protected-index.ts`, `task-migration.ts` |
| prototype `README.md:395-451` structure tree | no `server/memory/`, `server/integrations/`, `server/lgtv/`, `src/audio/`, `src/speaker/`, alarms, memories | all exist |
| prototype `README.md:401-402` | `brain.ts` is the Canvas 2D renderer; Shell states lack `confirming` | drawing is in `brain-canvas.ts` / `brain-webgl.ts`; `shell-state.ts:6` has `confirming` |
| `docs/Current_Implementation_Status.md:102` | the camera-enable branch "not yet merged" | `server/app.ts:159,430` is on main |
| `docs/Current_Implementation_Status.md:114` | 96 test files | 172 |
| `docs/11:54,97` | identity recognition "not implemented"; `app.ts` `Permissions-Policy: camera=()` needs loosening | `identity-*`, `identity-service.ts`; `page-headers.ts:14` already gives `camera=(self)` per the camera setting |
| `docs/12:109,182` | the confirmation queue serves MCP only; readings are not cached | `src/realtime-tools.ts:192` already serves HomeBridge; `home-overview.ts:18` caches 30 s; the AIL-2 Facade and the TV hand-off when `lg_tv` is on (`home-bridge.ts:525 TV_MOVED`) are also missing |
| `docs/06:9`, `docs/07:11` | local wake is still target design | implemented behind the `NOUS_WAKE` flag |
| `docs/README.md:21,27,28` | 17, 18, 19 planned / not implemented | SP-0x, AIL-1, VCR-0 / 2 have code |
| `docs/validation/README.md` | 69 rows | 81 records; missing `day-night-badge`, `day-night-volume`, `pi-settings-entry`, `pinned-settings`, `sp-00`, `sp-02a`, `sp-02b`, `sp-03a`, `voice-volume` |
| `shared/seconds-menu.ts` | the name says "seconds" | the content is seconds / factor / bool menu rows (the header at :2 admits it) |
| `shared/realtime-route.ts` | the name suggests it holds `RealtimeRoute` | the `RealtimeRoute` interface is at `server/realtime-routes.ts:85`; this file holds only the wire contract |

- Cost of leaving it: CLAUDE.md tells agents to read the README and the status document first; reading "no memory layer" or "plaintext JSON" leads to wrong design decisions or rebuilding what exists.

### P2-6　`server/app.ts`: a 1,369-line hand-written route chain

- Evidence: 85 routes in one `if` chain; `localizeSettings(settings.view(pageSource(…)))` repeated 18 times; the same "not saved (cannot write settings file…)" try/catch repeated 12 times (436-679); validation runs twice (`app.ts` parses the patch, `PrefsFile.parse` re-validates on read); SSE frames assembled by hand in five places; `app.ts:285` does `new ApiKeyRoute` itself (the composition root should be `nous.ts`); `app.ts:1083-1086` reads the Home adapter's private result fields `data.legacy` / `data.http_error` / `data.rethrow`.
- Cost of leaving it: every new settings file adds about 25 near-identical lines to `app.ts`; route order determines behaviour (an earlier `startsWith` swallows later routes) with no test guaranteeing it.

### P2-7　Four import cycles

- Runtime cycle: `realtime-routes.ts:36` imports `connectApiKey` (`apikey-call.ts`) and `apikey-call.ts:7` imports the value `RouteStartError` back; the strongly connected component has 8 files (`apikey-call`, `codex-auth`, `codex-responses`, `live-tool-caller`, `memory/live`, `proactive-calendar`, `realtime-routes`, `web-search`).
- Type-only cycles: `shared/types.ts:5,7` ↔ `seconds-menu.ts:7` ↔ `realtime-route.ts:4-5` ↔ `voice-cost.ts:5`; `src/api.ts:22` ↔ `realtime-session.ts:6` ↔ `realtime.ts:7,9-10` ↔ `realtime-tools.ts:4`; `memories.ts:22` ↔ `memories-google.ts:18`.
- Cost of leaving it: type cycles are harmless at runtime but show that `shared/types.ts` is both the bottom layer and dependent on upper layers; the runtime cycle gives esbuild bundling order and vitest module initialisation a chance to hit `undefined`. It has not happened yet, which is luck.

### P2-8　Modules reach into other modules' internals

- `codex-responses.ts:1` takes `readSse` from the task executor `chatgpt-executor.ts:274`; `proactive-calendar.ts:5` takes `exactYesNo` / `normalizeSpoken` / `readsQuestion` and two constants from `memory/live.ts`; `search-terms.ts:4` uses the Simplified-to-Traditional conversion in `memory/parse.ts`; `config.ts` imports three adapters; `integrations/index.ts:1,9` imports `../config` and `../lgtv/youtube`.
- Cost of leaving it: changing the memory module touches the calendar follow-up; turning memory off (`NOUS_MEMORY_ROUTES`) still loads all of `memory/live.ts`.

### P2-9　Duplicated small helpers

- `normalizeSpoken` three times with different semantics (`live-route.ts:118`, `memory/live.ts:241`, `voice-relay/catalog.ts:47`); `hostOf` (`codex-responses.ts:339`, `web-search.ts:185`); the OAuth callback page and constants (`chatgpt-auth.ts:27-35,545`, `codex-auth.ts:30-34,645`); the `face-` / `speaker-` / `wake-runtime.ts` triplets; `app.ts:1328-1368` already has a shared `serveVerifiedRuntime`, but only the speaker route uses it, and `serveFaceRuntime` and `serveWakeRuntime` still each copy the same body; two command grammars on the page, `intent.ts` and `voice-command.ts`.
- Cost of leaving it: a spoken-matching rule changed in one place and missed in two; adding a file type to the runtime hash check means three edits.

### P3-10　Test infrastructure

- No DOM environment, so 29 page tests each hand-roll a fake `document`; `alarm-ring.ts` (471 lines) has no direct test; two tests use fakes without a label. Vite emits `zh-tw-opencc` as a single 1,070 kB chunk (build warning).
- Cost of leaving it: what is most missing for splitting `main.ts` is a test that can import page modules; the infrastructure has to come before the split can be safe.

### P3-11　Naming

- `shared/seconds-menu.ts` (§P1-5), `shared/realtime-route.ts`, "memories = photo memories" vs "memory = family memory", `settings.json` which only holds the provider.
- Cost of leaving it: low; but renaming is cheapest now while importers are few (`seconds-menu`: 5 source files plus 7 tests).

## 3. Restructuring plan

Principles: one PR per step, **no behaviour change** (HTTP responses, SSE, settings file formats and page output byte-identical), all tests green, a validation record attached; no features; no change to the CLAUDE.md red lines or gates; lowest risk first. Each step follows pstack (how → architect → checkpoint → implement → verify → independent review → fix → PR). Verification always runs `npx tsc --noEmit`, `npx vitest run`, `npx vite build`, `node --check desktop/main.mjs`, `node scripts/verify-aios.mjs`, `node scripts/check-bilingual-docs.mjs` and `git diff --check`, plus the step's own before/after comparison.

| Step | PR content | Files touched | Risk | Before/after evidence |
|---|---|---|---|---|
| S0 | **This document and the metrics script** (this PR): `docs/23`, `scripts/architecture-metrics.mjs`, the validation record, index entries | Docs and one read-only script | None | Full verification green |
| S1 | **Doc sync**: fix every sentence in the §P1-5 table; index the 9 missing validation records; complete the prototype README structure tree | `README.md`, `prototype/ambient-shell/README.md`, `docs/Current_Implementation_Status.md`, `docs/11`, `docs/12`, `docs/README.md`, `docs/validation/README.md` (all with .en) | None | Bilingual check plus manual check of each sentence against the code |
| S2 | **Architecture guard test**: `tests/architecture.test.ts` reuses the logic of `scripts/architecture-metrics.mjs` to lock in: zero cross-layer imports, no more than the current 4 import cycles (allowlist), no more than the current 16 files over 800 lines (allowlist that can only shrink). **Note added 2026-11-10:** implemented on branch `claude/arch-s2-guard-test` (not yet merged); the cycle rule is "every cycle must be a subset of one of the existing 4", and large files are checked for allowlist membership only, with no cap on how much an allowlisted file may still grow; see the [validation record](validation/architecture-guard-2026-11-10.en.md) | 1 new test; the script becomes an importable module | Low | The test passes on the baseline; a deliberate cross-layer import makes it fail |
| S3 | **Rename `shared/seconds-menu.ts` → `shared/menu-prefs.ts`**, and move the `MenuPrefSetting` type into `shared/prefs.ts` to break the shared type cycle | 5 source files (including `desktop/settings-menu.d.mts`) and 7 tests change import paths | Low | `tsc` green; `describeMenuPrefs` output snapshot identical |
| S4 | **Shared atomic-write helper**: `server/fs-atomic.ts` offers `writeAtomic(path, data, mode)`; the 5 simplest callers switch first (`providers.ts`, the log in `proactive.ts`, `voice-cost-log.ts`, `lgtv/store.ts`, memory-enabled in `nous.ts`); the durable write in `sealed-vault.ts` / `memory/store.ts` stays and is assessed in a second PR | 1 new file plus 5 files about -10 lines each | Low | Existing store tests; the written files are byte-identical |
| S5 | **PrefsFile store factory**: `createPrefsStore(spec, file, defaults)` in `server/prefs-store.ts` replaces the identical template in the 11 PrefsFile stores (9 `*-settings.ts` plus `memories.ts`, `proactive.ts`); each file keeps a one-line export to preserve import paths | 11 files slimmed | Low | Existing tests pass unchanged: `audio-` / `camera-` / `clock-` / `voice-` / `wake-settings`, `camera-prefs`, `prefs`, `day-night-mode`, `home-corner`, `memories-http`, `memories-google`, `proactive`, `proactive-calendar`, `apikey-integration`, `live-integration` (`face-tuning.json` is covered only indirectly through `/api/settings/camera-tuning` in `http.test.ts`); `settings.view()` JSON identical |
| S6 | **`app.ts` settings route table**: the 13 `/api/settings/*` routes become one table (path → store → parsePatch), removing the 18 localize lines and the 12 error templates; the second validation on read-back in `PrefsFile.parse` stays until a test proves the two validators equivalent, then a separate PR removes it | `app.ts` about -200 lines; new `server/routes/settings.ts` | Medium-low | `http.test.ts` and `backend-i18n.test.ts` unchanged; error text, status codes and response JSON compared byte for byte |
| S7 | **Break the runtime cycle and move `ApiKeyRoute`**: contracts such as `RouteStartError` / `RouteCall` / `SessionContext` / `HostGone` move to `server/realtime-contracts.ts`; `ApiKeyRoute` moves from `realtime-routes.ts:1232` to `server/apikey-route.ts` (mirroring `live-route.ts`); `app.ts:285` no longer does `new ApiKeyRoute`, `nous.ts` injects it (risk: `createApp` currently defaults to building `ApiKeyRoute` when `realtimeRoutes` is absent; confirm no test relies on that default before switching to injection, otherwise keep the default and only move it) | `realtime-routes.ts` -60, `apikey-call.ts`, `app.ts`, `nous.ts` | Medium-low | `realtime-routes.test.ts`, `apikey-route.test.ts`, `live-integration.test.ts` pass unchanged; the metrics script shows cycles 4 → 3 |
| S8 | **Single source for the tool list**: `HOST_TOOLS`, the keys of `HOST_TIMEOUT_MS` and `RealtimeToolName` are all derived from `HostToolName` in `shared/realtime-route.ts`; home argument limits keep only the `adapters/home.ts` schema, referenced by `realtime.ts` and `app.ts` | 4 files | Low | Tool schema JSON and the `realtimeToolRules` text byte-identical (add a snapshot test) |
| S9 | **Split `home-bridge.ts` into a folder**: `server/home/{hub-client,parse,commands,aifa,infrared,bridge}.ts`; `home-bridge.ts` becomes a re-export barrel so the 4 importers and the tests keep their paths | 1 file → 7 files, pure moves | Medium-low | `home-bridge.test.ts`, `integration-home-facade.test.ts`, `home-corner.test.ts` unchanged; the request sequence the fake hub receives is byte-identical |
| S10 | **Shared base for the two page paths**: extract `src/voice-path-shared.ts` (greeting timing, early-speech detection, `CallGuard` / `ApprovalQueue` construction, `LiveCoreEvent` memory handling) for `RealtimeVoice` and `LiveVoice`; each class keeps its connection and audio differences | `realtime.ts`, `live-voice.ts` about -150 lines each | Medium | `realtime-voice.test.ts`, `live-voice.test.ts`, `realtime-local-commands.test.ts`, `id02-mac-fixes.test.ts` unchanged; event-sequence fixtures identical on both paths |
| S11 | **Shared core tools for the two paths**: merge the core handling of `recall_memory` / `delegate_task` into `server/core-tools.ts`, called by both `apikey-call.ts` and `live-tool-caller.ts`; the calendar follow-up likewise | 3 files | Medium | `memory-apikey`, `memory-live`, `live-tool-caller`, `proactive-calendar` tests unchanged |
| S12 | **The desktop stops copying shared**: move the constants and text tables copied in `settings-menu.mjs` / `preload.cjs` into `shared/*.mjs` plus `.d.mts` (the existing `shared/i18n.mjs`, `identity-validate.mjs` pattern), re-exported from the `.ts` side; delete the "copies stay in sync" tests | `shared/` +3 files, 3 `desktop/` files, `shared/wake.ts` and others | Medium-low | `desktop-menu`, `desktop-i18n`, `wake-*` tests; menu template JSON identical |
| S13 | **Group the remaining `app.ts` routes**: `server/routes/{realtime,alarms,home,auth,tasks,terminal,memories}.ts` plus `server/sse-hub.ts` (one place that builds SSE frames); `app.ts` keeps only dispatch and static files | Several PRs, one group each | Medium | The HTTP tests for each group unchanged; route order fixed by a table and tested |
| S14 | **Extract from `src/main.ts` in batches** (lowest coupling first, one PR each): (a) `onServerEvent` → `src/server-events.ts`; (b) `handleCommand` → `src/command-router.ts`; (c) realtime orchestration and `*FromRealtime` → `src/realtime-orchestrator.ts`; (d) camera lifecycle → `src/camera-lifecycle.ts`; (e) wake lifecycle → `src/wake-lifecycle.ts`; (f) settings application → `src/apply-settings.ts`. Do S2 and the P3-10 DOM test infrastructure first (assess adding happy-dom to devDependencies, pinned) | `main.ts` 4,211 → target under 1,500 | Medium-high | Each step runs the six `scripts/verify-*.mjs` browser scripts plus the new module tests; screenshots compared in headless Chromium |

Out of scope: the Python core, Tauri and the monorepo (`docs/07` §2) remain plans; any permission or security hardening (the CLAUDE.md priority of 2026-10-31); any behaviour change; `server/memory/service.ts` (2,613 lines) and `identity-service.ts` (1,684 lines) are large but have concentrated importers and full fixture tests, so they stay untouched until the MEM / ID Mac gates pass.

## 4. For George to decide

1. Do you agree with the order in §3? The suggestion is to release at least S1–S5 first (docs, guard test, rename, two helpers); none of those five touch behaviour.
2. The new name in S3: `shared/menu-prefs.ts`, or something you prefer?
3. For S14, should `happy-dom` be added for page tests (devDependency, pinned)? The split works without it, but then each step can only regress through browser scripts.
4. Should the two large files `memory/service.ts` and `identity-service.ts` be scheduled? The current recommendation is not yet.

## 5. Relationship to the formal specs

This document does not change the product rules or the G0–G3 gates in `docs/06` and `docs/07`, and promotes nothing from "to be implemented" to done. `docs/08` remains a historical snapshot. S1 only makes the docs say what the code really has and what has really been verified; items without real-device evidence stay "fixture" or "unverified".
