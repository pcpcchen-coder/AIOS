<!-- bilingual: source=zh-TW -->

> [繁體中文](menu-seconds-commands-2026-10-22.md) | [English](menu-seconds-commands-2026-10-22.en.md)

<a id="選單列秒數設定與語音指令表驗證"></a>
# Menu-bar duration settings and voice command table validation

2026-10-22; base `5572b91a26d156dee80db8a6aa2cae455c24b5a2`. This record accompanies menu-bar durations, voice idle durations, and the voice command table.

George requested duration settings in the menu bar (the macOS app's status icon and application menu), configurable idle durations, and a table of every voice command that opens from the menu bar.

<a id="做了什麼"></a>
## Changes

- Four durations: camera “seconds facing the screen before starting conversation” and “pause after conversation ends” (existing `CAMERA_PREFS`, now with menu choices), plus new voice idle `VOICE_PREFS`: voice mode 30–600 seconds in steps of 10, default 90; realtime voice 30–600 seconds in steps of 10, default 120. Stored in `~/.config/nous/voice.json`, updated through `POST /api/settings/voice`, effective immediately.
- The local core derives each duration menu row in `SettingsView.seconds` (label, current value, choices, disabled reason, write path). `desktop/main.mjs` renders those rows without defining keys, ranges, or choices itself.
- Voice command table: `shared/voice-commands.ts` is the single source for `GET /help/commands` (the app's read-only window) and the README command section.
- Page: changing idle duration restarts the countdown from now only when the value actually changes and voice is active. Settings gains a voice section; consent text uses current durations.

<a id="這個環境驗證了什麼"></a>
## What this environment validated

No Mac was available and Electron did not run. Everything below ran in a Linux development environment.

| Item | Method | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | Pass, including compile-time checks that table intent types, engines, confirmation decisions, and realtime tool names equal actual code types |
| Unit and HTTP tests | `npx vitest run` | 492 tests in 37 files pass (base: 353 tests in 32 files; includes 16 tests added after review fixes) |
| Table against matching rules | `tests/voice-commands.test.ts` | Every phrase goes through `matchCameraCommand`, `classify`, `matchApproval`, and `isStopWord`; applicable paths are derived from `LOCAL_ROUTING` and actual matches, then compared. Every camera rule, intent/engine, confirmation/cancellation verb, interruption word, and realtime tool must have a row |
| Tests detect drift | Temporarily corrupt the table (add a path, remove an interruption word, change a misconception row, add an intent), then run tests | Five tests fail and two compile errors occur; passes after restoration |
| README stays synchronized | `tests/commands-doc.test.ts` | Text between README markers must equal `renderCommandsMarkdown()`; regenerate with `npm run docs:commands` |
| Idle timer restarts | `tests/idle-settings.test.ts` with fake timers | Same value does not extend timeout; changed value counts its new duration from now; inactive mode does nothing and does not falsely report closure; next activation uses the new value; realtime replies still suspend the timer |
| Settings files | `tests/voice-settings.test.ts`; unchanged `tests/camera-settings.test.ts` still passes | Extracted shared `PrefsFile`; camera fail-closed behavior (invalid `active` or unreadable file → `false`) becomes the `failClosed` data option |
| Choice rules | `tests/prefs.test.ts` | Each duration spec's choices ascend, are unique, in range, on-step, include default, and pass the associated validator; missing current value is inserted with “（目前）” (“current”) |
| Real core | curl against `npx tsx server/index.ts` with mock engine, temporary settings directory, `NOUS_CAMERA=on` | `GET /api/settings` includes `voice` and four `seconds` rows; `voice_idle_s: 95` returns 400; `look_to_talk_s: 1.6` checks “1.6 秒（目前）” in the response; `realtime_idle_s: 300` persists to `voice.json` with mode 0600; command page displays current five minutes (default two); foreign Host returns 403 |
| Actual command-page rendering | Playwright Chromium, **JavaScript disabled** as in the app window, dark mode | Header CSP hash matches inline style, style applies; with camera not enabled, 12 rows show current-state notes; no console messages. Screenshot `menu-seconds-commands-2026-10-22/commands-page.png` |
| Settings voice section | Playwright Chromium opens built page, enters “設定” (“settings”), and presses “語音模式閒置多久自動關閉增加” (“increase voice-mode idle auto-close duration”) | 1 min 30 sec → 1 min 40 sec; `voice.json` stores 100. Screenshot `menu-seconds-commands-2026-10-22/settings-voice.png` |
| App main-process syntax | `node --check desktop/main.mjs` | Pass |
| Build and overall validation | `npx vite build`; `node scripts/verify-aios.mjs` from repository root | Pass |

Screenshots use a mock engine and temporary settings directory. They do not represent real accounts, microphones, or cameras.

<a id="指令表照實寫出的行為"></a>
## Behavior accurately recorded in the command table

These facts come from tested matching rules and routing read in `src/main.ts`, `src/voice.ts`, and `src/realtime.ts`.

- “結束對話” (“end conversation”), “開始語音對話” (“start voice conversation”), and “再見” (“goodbye”) are not local commands; only the AI interprets “goodbye” in realtime voice.
- “停” (“stop”) alone only interrupts speech in voice mode and is still sent to AI afterward; “stop” interrupts and then becomes stop-task. Interruption words use prefix matching. In voice mode, any phrase of at least two characters that does not resemble Nous's own audio also interrupts (`onresult` in `src/voice.ts`).
- Typed “取消” (“cancel”) means stop-task. Stopping a task replaces the foreground with progress or a notice; replacing a confirmation card counts as rejection (`leftConfirm` in `dispatch`), so the card is rejected and a task may also stop. Only spoken “cancel” in realtime voice is a plain rejection.
- Realtime camera commands containing “停止” (“stop”), such as disabling/enabling palm stop, also reject an open confirmation card; typing them does not.
- Realtime spoken camera commands execute locally, and the same phrase is still sent to AI. Realtime spoken “停止任務” (“stop task”), “進度如何” (“how is progress”), and “收起” (“collapse”) are not handled locally.
- “收起” (“collapse”) also ends voice mode or realtime voice without stopping tasks.
- Short phrases containing “狀況” (“status”) or “結果” (“result”) become progress or artifact queries (for example traffic conditions or match results). This is existing matcher behavior, accurately documented here without changing the rules.

`LOCAL_ROUTING` (which matcher runs on which path) is the table's only manually written routing fact. `tests/voice-commands.test.ts` checks source snippets to ensure realtime transcripts run only camera rules and approval phrases, and `handleCommand` runs camera rules before `classify`.

<a id="審查後的修正"></a>
## Review fixes

- Command table: corrected the claim that Esc stops tasks; it only interrupts speech or collapses the view. Added that typing progress/settings/results/engine-switch/stop-task while a confirmation card is open replaces and rejects it. Look-to-talk now notes prior realtime-voice consent is required. `LOCAL_ROUTING.typed.alsoSendsText` records that typed progress queries also reach `realtime.sendText`; tests isolate each `handleCommand` case.
- Durations within onStep tolerance (such as 90.000001) are stored at the grid value; menus no longer show both default and current entries.
- Extracted `idleTimeoutsMs`, which converts `settings.voice` to milliseconds for page idle timers, with tests.
- App: settings updates report a version through preload; main rereads settings so menus do not retain stale values. A command-window load superseded by ⌘R or reload (`ERR_ABORTED`) no longer closes the window. Reopening a minimized command window restores it. These changes received syntax checks only.

<a id="需要在真的-mac-上驗證"></a>
## Requires a real Mac

- Status-icon duration submenu: four items, section headings, checkmarks, current item, camera-disabled reason as the first item (macOS below 14.4 has no sublabel), immediate main-window settings update on selection, and error dialogs.
- Voice-command window: status-menu item, View → voice commands ⌘/, Help menu; opening it does not interrupt realtime speech; ⌘R refresh; automatic reload after core restart; navigation/new-window prevention; microphone/camera permission denial.
- After changing durations in window settings, immediately opening the status-menu duration submenu checks the new value.
- Pressing ⌘R during command-window load or restarting the core does not close that window; reopening after minimization restores it.
- During realtime voice, changing idle duration from two minutes to one ends the session about one minute later (requires `OPENAI_API_KEY`).

<a id="下一個-gate"></a>
## Next gate

Complete and screenshot the previous section using a packaged app on Mac before treating this feature as end-to-end complete.
