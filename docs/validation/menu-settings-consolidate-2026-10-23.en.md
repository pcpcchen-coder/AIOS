<!-- bilingual: source=zh-TW -->

> [繁體中文](menu-settings-consolidate-2026-10-23.md) | [English](menu-settings-consolidate-2026-10-23.en.md)

<a id="macos-app-設定集中到選單列驗證"></a>
# macOS app settings consolidated into the menu bar: validation

2026-10-23; base `3df6c4bbd37569898b7343ea085b954fb1834764` (branch `claude/menu-settings-consolidate`). Includes fixes after independent review.

George's decision: macOS app settings primarily live in the menu bar. The browser version, which has no menu bar, retains its complete settings page.

<a id="做了什麼"></a>
## Changes

- **Menu-bar “鏡頭與語音設定” (“camera and voice settings”), formerly duration and zoom settings:**
  - Added four camera checkboxes: camera, look-to-talk, greet first during look-to-talk, and palm-stop speech. `CAMERA_PREFS` orders them among durations and zoom, so look-to-talk is immediately followed by its two durations and greeting. Section title changes from Camera to Camera and gestures to avoid duplicating the first switch's name.
  - Show camera view moves to the end of the camera section, before Voice. It sends `command("camera-preview")`; page `runDesktopCommand` (`src/desktop-command.ts`) dispatches to `actions.openCameraPreview`.
  - If any row has a disabled reason, a gray explanatory item appears below that section heading, so systems below macOS 14.4 without sublabel can still show the reason.
  - Removed More settings….
- **Switch row representation:** `SettingsView.seconds` retains its old field name but becomes a `kind`-discriminated union: `seconds`/`factor` use `MenuNumberSetting` with `options`; `bool` uses `MenuBoolSetting` with `value: boolean`, `value_label` on/off, and no `options`. Common fields are `key`, `group`, `group_label`, `label`, `disabled_reason`, `note`, and `write_path`. Core derives them from `CAMERA_PREFS` (`describeMenuPrefs` in `shared/seconds-menu.ts`).
  - Disabled: every camera row is disabled with `CAMERA_DISABLED_REASON` if the camera is not enabled or has no settings source.
  - Notes: unavailable realtime voice adds “requires realtime voice (currently unavailable)” to look-to-talk, matching the settings page. If look-to-talk is off, greeting says that look-to-talk is currently off and this switch is temporarily unused. If camera is off (`active: false`), the other three switches say the camera is currently off and the switch is temporarily unused; this takes priority, consistent with the zoom-row note. These notes do not disable switches.
  - Core also derives preview availability through `SettingsView.camera_preview_disabled_reason` (`cameraPreviewDisabledReason`): not enabled → `CAMERA_DISABLED_REASON`; camera off → “camera is currently off; check Camera before showing its view”; otherwise `null`.
  - Write: `POST /api/settings/camera` sends `{ [key]: !value }`, negating the core value rather than Electron's toggled state. Success applies the response directly. Failure shows an error such as “look-to-talk was not saved” and rereads settings, as `setMenuPref` does.
- **Pure menu template:** extracted `desktop/settings-menu.mjs` without loading Electron, with types in `settings-menu.d.mts`; `desktop/main.mjs` imports it, and `desktop/scripts/build.mjs` copies it into the app. Main and template render only from `kind`, `group`, and core-supplied reasons, without reading setting key names.
- **App settings page contains accounts only:** `renderSettings(settings, message, actions, { desktop })`; `src/main.ts` passes `{ desktop: !!window.nousDesktop }`.
  - Title “帳號與登入” (“accounts and sign-in”). Only ChatGPT engine account (signing in; account/reauthorize/manage usage/use another account/sign out; needs_reauth sign-in; Continue with ChatGPT when logged out; welcome, message, last_error, current-engine line) and realtime Codex account (status, both route states, sign-in/device code, signed-in/sign-out, sign-in button, last_error). Sign-in says “opened in browser,” because the app uses the system browser rather than a new tab.
  - Footer lists locations separately: engine switching in AI engine; realtime route and voice in Realtime voice; camera switches, durations, and zoom in Camera and voice settings.
  - Does not render engine choices, realtime route/voice buttons, Voice durations, or the Camera and gestures section.
  - **Browser UI is unchanged except renaming the voice-section note** from macOS duration/zoom menu to macOS Camera and voice settings. Code only extracts account sections into functions; child order is tested.
- **Settings-command reply**, `settingsReply` in `src/intent.ts`: browser unchanged (“these are AI engine and camera settings” or “these are AI engine settings”). App “設定” points to accounts/sign-in and the Nous menu-bar icon for camera, durations, and engine; camera-settings phrases point to Camera and voice settings; engine/model-setting phrases point to AI engine. App has no browser voice mode; when voice mode is off, subtitles show directly. Command-table settings row matches this explanation.
- **Core and AI wording:** two API-key-route instructions (`server/realtime.ts`, `server/live-tool-caller.ts`) now direct users to settings, or the macOS Realtime voice menu. Sign-in/reauthorization wording in `server/live-route.ts` and `server/chatgpt-auth.ts` still says settings because the app accounts page supports those actions.
- Other menus: realtime submenu adds Accounts and sign-in…; application View → AI engine settings (⌘,) becomes Accounts and sign-in…; AI engine submenu keeps Sign-in/account settings….
- Page-to-app settings notification, the `reportState` settings version string, is unchanged. Voice or typed camera switch changes still trigger menu rereads.
- Documentation and strings in `desktop/README.md`, `README.md`, `INSTALL.md`, and `shared/voice-commands.ts` describe the correct app/browser version. README command table regenerated with `npm run docs:commands`.

<a id="在-linux-驗證了什麼"></a>
## Linux validation

No Mac was available and Electron did not run.

| Item | Method | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | Pass |
| Unit and HTTP tests | `npx vitest run` | 790 tests in 48 files pass (base 752 in 46; two files and 38 tests added: `settings-view` 12, `desktop-menu` 10, `intent` 8, `prefs` 6, `http` 1, `live-tool-caller` 1) |
| Switch-row derivation | `tests/prefs.test.ts` | Row order equals `CAMERA_PREFS`; switch values/labels/`value_label`/notes match spec; all disabled when not enabled or source missing; notes for unavailable realtime, look-to-talk off, camera off; three `cameraPreviewDisabledReason` cases; `describeSeconds` still returns durations only |
| New `/api/settings` fields | `tests/http.test.ts` | Without camera: keys/order of nine rows and disabled preview reason. With `NOUS_CAMERA=on`: four switch values/write paths and available preview. Camera off: correct preview reason. `POST {look_to_talk:false}` response matches `camera.json` |
| Menu template | `tests/desktop-menu.test.ts`, directly runs pure `desktop/settings-menu.mjs` using real `describeMenuPrefs` output, not Electron | Full order, preview at camera-section end before Voice, no More settings; checkbox submits inverse core value; disabled explanation, camera rows/numeric choices disabled when unavailable; preview disabled with camera off while switches remain usable; voice save failure explanation; no preview row if core omits the field |
| Menu-command routing | `tests/desktop-menu.test.ts` | Every `runDesktopCommand` command reaches its action, including `camera-preview`; unknown commands do nothing; every `command("…")` emitted by main/template is known to the page |
| Two settings-page versions | `tests/settings-view.test.ts`, fake DOM implementing only views' createElement/setAttribute/append/addEventListener and substituted DOMPurify | Browser top-level child order (title, message, error, engines, realtime, engine explanation, Voice, Camera and gestures, footer; welcome/account when signed in), all engine/route/voice/−/+/switch/preview controls, new-tab sign-in wording. App has only two account sections and explanation in asserted order, with all three menu names, no duplicate settings, correctly wired account buttons, opened-in-browser wording |
| Settings replies | `tests/intent.test.ts` | Every settings-table phrase preserves browser reply and points app users to the correct menu; table lists same locations |
| AI instructions | `tests/live-tool-caller.test.ts` | Executor and ChatGPT-plan voice with MCP include instruction to switch route to API key in settings or macOS Realtime voice menu |
| Real core, first round | curl against `npx tsx server/index.ts`, mock engine, temporary settings, `NOUS_CAMERA=on`, no OpenAI key | Correct `seconds` order/notes; `POST {look_to_talk:false}` response and file agree; `{look_to_talk:"no"}` returns 400. Corrected `camera_preview_disabled_reason` checked by `tests/http.test.ts` against the same `createApp` |
| App syntax | `node --check desktop/main.mjs`, `node --check desktop/settings-menu.mjs` | Pass; main received **syntax checks only** |
| Build and overall validation | `npx vite build`; repository root `node scripts/verify-aios.mjs`; `git diff --check` | Pass |

Mock engine, temporary settings, and fake DOM results do not represent real accounts, cameras, or macOS menu behavior.

<a id="待-george-在-mac-實測"></a>
## George's pending Mac tests

1. **Menu checkboxes:** set `.env` `NOUS_CAMERA=on` and restart, rebuilding with `npm run build` because app contents now include `settings-menu.mjs`. Camera and voice settings → Camera and gestures order is Camera, Look-to-talk, two durations, Greet first, Palm-stop speech, Zoom, Show camera view, then Voice. Uncheck look-to-talk, reopen menu: stays unchecked, `~/.config/nous/camera.json` contains `"look_to_talk": false`, and duration/greeting sublabels on macOS 14.4+ say look-to-talk is off. Facing screen no longer starts realtime voice. Re-enable and test all four switches.
2. **Save failure:** temporarily make `camera.json` unwritable, for example replace it with a same-named directory. Toggle a switch: error dialog says it was not saved; reopening shows actual persisted state. Restore afterward.
3. **Disabled state:** remove `NOUS_CAMERA=on` and restart. Gray reason under Camera and gestures explains enabling it in `.env`; all four switches, camera durations/zoom, and preview are disabled. With no Codex login or OpenAI key, look-to-talk note says realtime voice is currently unavailable.
4. **Camera off:** uncheck Camera; preview disables with camera-off note. Other three switches remain operable with temporarily-unused notes.
5. **Preview:** while camera runs, choose Show camera view; window displays two small images.
6. **Voice-to-menu synchronization:** say or type “關閉看著說話” (“disable look-to-talk”). Next menu opening shows unchecked without restarting the menu-bar app.
7. **App settings accounts only:** open AI engine → account settings, Realtime voice → Accounts and sign-in…, or ⌘,. Title Accounts and sign-in; only ChatGPT and realtime Codex accounts with status/both routes; footer lists other menu locations. No engine list, route/voice buttons, voice durations, or camera/gestures. Logged-out ChatGPT shows Continue with ChatGPT; clicking says opened in browser. Login, logout, and device-code login work.
8. **Settings commands:** type settings, camera settings, and switch engine. Account page opens; subtitles point respectively to the overall menu bar, Camera and voice settings, and AI engine.
9. **Browser stays complete:** run `npm start`, open `http://localhost:8787` in Chrome, say/type settings. Engine choices, realtime route/voice, voice durations, camera/gestures, and preview remain. Reply stays “這是 AI 引擎與鏡頭設定。” and behavior matches before.
10. More settings… no longer appears in the submenu.

<a id="未完成與疑慮"></a>
## Remaining work and concerns

- Electron rendering, checkbox clicks, disabled items, sublabels, explanatory items, and main-to-page `camera-preview` have not run on macOS. `main.mjs` received only `node --check`; pure functions tested menu templates and command routing.
- Menu bar offers preset choices only; the app has no −/+. Off-menu values require editing `camera.json`/`voice.json` or browser settings.
- Disabled reasons appear in both section explanatory items and each item's sublabel, duplicating text on macOS 14.4+.
