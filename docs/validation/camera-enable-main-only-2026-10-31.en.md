<!-- bilingual: source=zh-TW -->

> [繁體中文](camera-enable-main-only-2026-10-31.md) | [English](camera-enable-main-only-2026-10-31.en.md)

<a id="app-裡鏡頭只能由主程序打開驗證"></a>
# In the App, only the main process can turn the camera on: validation

Date: 2026-10-31, Asia/Taipei. Branch: `claude/camera-enable-main-only` (based on main `2c7104b`, not yet committed or merged). Origin: the known item listed in [WK-01a validation §8, review M2](wk-01a-2026-10-31.en.md#8-獨立審查後的修正2026-10-31) — `POST /api/settings/camera` accepted `{active:true}` from any page script, so the camera could be turned on without the user seeing any explanation.

**This is not hardware acceptance.** All tests below ran in a Linux cloud container using HTTP, static source checks, and fake Electron objects — **not a Mac, not a real camera, and no real native dialog**. The manual check on the Mac has not been run (§6).

<a id="1-問題"></a>
## 1. Problem

The WK-01a review fix M2 changed always-on wake listening so that HTTP answers 403 to `wake_listen: true`, and only the App main process can turn it on after a native explanation dialog, through the same-process `NousHandle.wake.setListen`. The camera's `POST /api/settings/camera` had the same class of issue: any script on the page could send `{active:true}` and turn the camera on without the user seeing an explanation.

<a id="2-設計"></a>
## 2. Design

The user decided during this batch: **the browser version must still be able to turn the camera on.** So whoever starts the core picks the mode:

| Mode | Used by | `active: true` on `POST /api/settings/camera` | `settings.camera.enable_via` | How the camera is turned on |
|---|---|---|---|---|
| `"main_process"` (strict) | macOS App (`startNous({ cameraEnable: "main_process" })` in `desktop/main.mjs`) | 403 “鏡頭只能從 App 打開” (English: “The camera can be turned on only from the App”); the whole request is rejected and nothing is saved | `"app"` | Native explanation in the main process → user presses “Turn on” → same-process `NousHandle.camera.setActive(true)` |
| `"http"` (default) | Terminal / browser version (`server/index.ts`, `npm start`) | 200 as before | Field absent (`/api/settings` is byte-identical to before) | Over HTTP as before; guarded by the browser's own camera permission prompt and the bottom-right indicator dot |

In both modes `active: false` and all other keys keep working; validation runs before the 403 (`active: "yes"` is still 400); 409 for no camera and 500 for a failed write are unchanged.

- **Core** (`server/nous.ts`): `NousOptions.cameraEnable?: "main_process" | "http"` (default `"http"`) is passed to `createApp`; `NousHandle.camera.setActive(value)` calls `CameraSettingsStore.update({ active })`: it writes `camera.json` first and only then pushes `settings.updated` through `onChange`; a failed write throws and leaves the setting unchanged.
- **HTTP** (`server/app.ts`): when `cameraEnable === "main_process"` and the parsed patch has `active === true`, answer 403; in strict mode `settings.camera` also carries `enable_via: "app"`.
- **App main process** (`desktop/main.mjs`): `setCameraActive(value)`. Turning on first shows a native question dialog (`開啟`/`取消`, i.e. “Turn on”/“Cancel”; both the default and the cancel button are “Cancel”) explaining that camera images are processed only on this Mac and are never saved or uploaded, that the dot at the bottom-right of the screen shows the real state, and that it can be turned off at any time from the menu bar or by saying “turn off the camera”. Only “Turn on” calls `core.camera.setActive(true)`, rereads settings, and then sends `camera-enabled` to the page through `nous:command`. If saving fails, an enable started from the menu bar shows a native error box, while one requested by the page over IPC returns the error to the page only and shows no extra box (so the same error is not reported twice). The dialog is attached to the main window (as a sheet) only while that window exists and is visible; otherwise it is app-modal, because a sheet on a hidden window cannot be seen and would leave the shared wait hanging (the always-on wake listening dialog is handled the same way). A request that arrives while the dialog is open shares the same dialog and result instead of stacking a second one. Turning off keeps the existing HTTP path. The menu bar “Camera” checkbox (`setMenuPref`) routes “on” to `setCameraActive` instead of HTTP.
- **Camera video permission** (`desktop/main.mjs`, added after review): the HTTP 403 alone was not enough. `setPermissionRequestHandler` used to grant the `media` permission to any request from the core origin, so a page script could call `navigator.mediaDevices.getUserMedia({ video: true })` directly and get the webcam regardless of `active` in `camera.json`, even without `NOUS_CAMERA=on`. Now, when a `media` request's `details.mediaTypes` contains `"video"` (or is missing, empty, or has an unknown value, which counts as video — fail closed), it needs both `allowMedia(url)` and `core.camera.isActive()`; microphone-only requests (`["audio"]`) are unchanged. `NousHandle.camera.isActive()` reads the store live every time (`enabled && active`) instead of the main process's polled `settings`, which can be stale. `setPermissionCheckHandler` is unchanged: it only answers synchronous permission queries (`navigator.permissions.query`, whether `enumerateDevices` reveals device names) and does not open the camera by itself; the `getUserMedia` call that actually obtains video always goes through the request handler (concluded from the Electron documentation, not tested on the Mac).
- **Same origin only**: `allowMedia` now uses `sameOrigin(url, core.url)` from `desktop/trusted-sender.mjs` (parse, then compare origins) instead of a prefix check, so `http://localhost:5173` no longer accepts `http://localhost:51730`; the request and check handlers share the same `allowMedia`.
- **The page lifts an unsaved local turn-off**: if the page turned the camera off but saving failed, this window keeps it off with `cameraOffPending`. The settings the core pushes cannot show “the user later turned it on deliberately from the menu bar” (when the turn-off was not saved the core is still on, so the value does not change), so after a successful enable the main process sends `camera-enabled`, and the page's `cameraEnabledByApp()` clears `cameraOffPending` and `cameraFailed` and calls `syncCamera`. While this window's turn-off POST is still in flight (`cameraOffInFlight > 0`) it does not clear it, and the result of that turn-off reaching the core decides. Settings pushed by the core still clear `cameraOffPending` only when they report `active=false` (as before), so an unrelated settings update never turns the camera back on.
- **Every legitimate camera start happens after the core has saved**: the only video `getUserMedia` in `src/` is in `src/sense/pipeline.ts`, started only by `syncCamera` → `startCamera` while `cameraShouldRun` (`enabled && active`, from the settings the core reports) holds. “Show camera view” opens only while the camera is already running and otherwise says “鏡頭沒有在運作，無法顯示鏡頭畫面。” (“The camera is not running, so the camera view cannot be shown.”); family recognition and calibration only sample from the same pipeline and have no `getUserMedia` of their own. So these entry points need no change and are not blocked by the new permission check.
- **IPC**: `ipcMain.handle("nous:camera-enable")` first checks `checkTrustedSender` (main window, main frame, page from the local core), then runs `setCameraActive(true)`; it answers `{ ok: true }` or `{ ok: false, reason: "cancelled" | "unavailable" | "error", message? }`. `desktop/preload.cjs` exposes `nousDesktop.cameraEnable()` with no arguments (whatever the page passes is not sent).
- **Page** (`updateCameraPrefs` in `src/main.ts`): only when `settings.camera.enable_via === "app"` and the patch has `active: true`, it removes `active`, saves the other keys over HTTP as usual, and hands the camera to `nousDesktop.cameraEnable()`. On success it rereads settings and renders; on cancel it returns “已取消開啟鏡頭” (“Turning on the camera was cancelled”); on failure it returns the reason. The camera is not started locally before the core has saved (`syncCamera` only follows the `active` value reported by the core), and cancel or failure does not touch `cameraOffPending`/`cameraFailed`, so the camera is never left running. If the setting is already on, it does not ask again and only retries a failed start. Without `enable_via` it uses HTTP as before.
- All new interface copy is in the shared localization catalogs: `desktop/messages.en.json` (dialog), `shared/messages.en.json` (403 message), `src/messages.en.json` (page messages).

<a id="3-行為表"></a>
## 3. Behaviour table

| Entry point | App (strict mode) | Terminal / browser version (default mode) |
|---|---|---|
| Menu bar “Camera” checkbox | Native explanation → turns on only after “Turn on”; unchanged on cancel | Not applicable (no menu bar) |
| “Camera” switch in the page's settings view | The same native explanation through `nousDesktop.cameraEnable()`; on cancel the settings view shows “Turning on the camera was cancelled” | Turns on over HTTP as before; the browser shows its camera permission prompt the first time |
| Saying or typing “打開鏡頭” / “turn on the camera” | Same as above (native explanation); the subtitle shows the result or “Turning on the camera was cancelled” | Turns on over HTTP as before |
| “打開鏡頭” in a realtime voice transcript | Goes through the same `handleCameraCommand`, so same as above | Turns on over HTTP as before |
| Page script calls `POST {active:true}` directly | 403, nothing saved | **Can still turn it on** (the user's decision; see residual risk in §5) |
| Page script calls `getUserMedia({ video: true })` directly | While the camera setting is off (or without `NOUS_CAMERA=on`) the main process denies the permission and no video is obtained; while it is on the permission is granted. Note: with `NOUS_CAMERA=on` and no `camera.json` yet, the camera setting defaults to on (first launch without the native explanation; see §5) | Decided by the browser's own permission prompt (unchanged) |
| Page script calls `nousDesktop.cameraEnable()` | Only brings up the native explanation; the user must press “Turn on” | Does not exist |
| First launch (`NOUS_CAMERA=on`, no `camera.json` yet) | The camera defaults to on, runs, and gets video permission **without the native explanation** (the installer turned it on in `.env`; George 2026-10-31: keep as is) | Defaults to on as before |
| Turning the camera off (any entry point) | As before: released locally at once, then saved | As before |

<a id="4-測試"></a>
## 4. Tests

In `prototype/ambient-shell/`:

| File | Content |
|---|---|
| `tests/http.test.ts` (2 added) | Default mode: `{active:true, look_to_talk:false}` is 200 and settings carry no `enable_via`. Strict mode: `settings.camera.enable_via === "app"`; `active:true` is 403 (Chinese and English messages); `{active:true, look_to_talk:false}` is 403 and `camera.json` is byte-for-byte unchanged; `active:"yes"` is 400; `look_to_talk:false` and `active:false` are 200; after turning on through the store, settings report on |
| `tests/camera-enable.test.ts` (new, 21) | Review fixes: unit tests for `sameOrigin` (5173 vs 51730, `5173.evil.test`, https, 127.0.0.1, bad URL) and both permission handlers using `allowMedia`; the camera and always-on wake listening dialogs both use `dialogParent()` (which needs `win.isVisible()`); an enable requested by the page shows no native error box while one from the menu bar does; after a successful enable `camera-enabled` is sent and the page clears `cameraOffPending` only when no turn-off is in flight, while core pushes still clear it only on `active=false`. Pins the current first-launch default: `isActive()` is true when enabled with no `camera.json`. `isActive`: false with `NOUS_CAMERA` off even when saved as on; when enabled it follows the saved value (including an HTTP turn-off) immediately. Permission: the request handler checks `wantsVideo(details)` and `cameraAllowed()` (asks `core.camera.isActive()` directly, never `settings`), and the check handler is unchanged; `wantsVideo` returns true for video, unknown, empty, or missing types and false only for `["audio"]`; the only video `getUserMedia` in `src/` is in the pipeline, started only while `cameraShouldRun`. Core: in strict mode HTTP is 403, and `NousHandle.camera.setActive(true)` writes `camera.json` and pushes `settings.updated`. The App starts the core with `cameraEnable: "main_process"`, `server/index.ts` passes nothing, and the core default is `"http"`. Main process: `setCameraActive` calls `showMessage(` (`defaultId: 1, cancelId: 1`) before `core.camera.setActive(true)`; main.mjs code never sends `active: true`; the menu bar camera switch goes to `setCameraActive` first; `nous:camera-enable` calls `checkTrustedSender` first and takes no arguments; the dialog is fully translated to English. Preload: `cameraEnable(...)` only calls `invoke("nous:camera-enable")`, whatever the page passes. Page (static): `api.updateCamera(` appears once and after the App-mode branch; `enableCamera` does not use HTTP; cancel/failure does not change the camera state flags; new messages have English |
| `tests/identity-ipc.test.ts` (1 changed) | `cameraEnable` added to the list of names exposed by preload |

**Test gap**: the page's strict-mode branch (`updateCameraPrefs` / `enableCamera` / `cameraEnabledByApp`) has static source checks only and no unit test that runs it, because `src/main.ts` is a single large file that drives the DOM directly and cannot be loaded on its own cheaply. “The camera stays off after cancel” and “an in-flight turn-off is not overridden” rely on the Mac check in §6.

Results (Linux cloud container, Node.js 22): `npm run typecheck` passed; `npx vitest run` 107 test files, 2,038 passed and 5 skipped; `npm run build` passed.

<a id="5-風險與限制"></a>
## 5. Risks and limitations

- **Residual risk in the browser version (the user's decision)**: the terminal / browser version still lets the page turn the camera on over HTTP, so a local page script can still turn the camera on, guarded only by the browser's own camera permission prompt (and, afterwards, the on-screen indicator dot). Once the browser remembers the permission it does not prompt again. This was the user's choice on 2026-10-31, not an omission of this batch.
- **First-launch default (George 2026-10-31: keep as is)**: with `NOUS_CAMERA=on` and no `camera.json` yet, `active` defaults to on (the default in `shared/sense.ts` and `server/config.ts`), so the App turns the camera on at first launch and the main process grants video permission to the page (including a page script's own `getUserMedia({ video: true })`) **without the native explanation**. The user decided to keep this behaviour: `NOUS_CAMERA=on` in `.env` is the installer's explicit choice, so first launch shows no extra native confirmation; this remains a residual item. A test pins this behaviour so any change has to be deliberate.
- Residual risk in the App: while the camera setting is on (including the first launch above), a page script can call `getUserMedia({ video: true })` itself and get video (the pipeline is normally running then and the indicator shows on). If the user later turns the camera off, the pipeline stops, but a stream the script obtained earlier is not revoked by the main process; it lasts until the script stops it or the page reloads. That the permission handler is asked on every `getUserMedia` call (Electron does not persist permission decisions) is based on the documentation and was not tested on the Mac.
- Strict mode protects only turning on. Turning off is always safe, so any page script can still turn the camera off or change other camera settings (for example look-to-talk).
- The App's `nous:camera-enable` lets the page request the explanation dialog; a page script can request it repeatedly (only one dialog exists at a time), but it cannot turn the camera on unless the user presses “Turn on”.
- This batch does not change `server/index.ts`; any other code that calls `startNous` without `cameraEnable` gets the permissive mode.
- Typings: `desktop/trusted-sender.d.mts` gains `sameOrigin`; `desktop/main.mjs` has no declaration file, and the public type of `preload.cjs` is `DesktopBridge` in `src/main.ts` (now with `cameraEnable?`).
- This batch does not change `isLocal`, used for main-window navigation and external links (`desktop/main.mjs` still uses the `url.startsWith(core.url)` prefix check). It is unrelated to the camera permission but has the same port-prefix issue, and is left for another batch.

<a id="6-未驗證mac-手動核對待執行"></a>
## 6. Not verified: manual check on the Mac (pending)

On the Mac, with the App built from this branch:

1. Menu bar → “Camera and voice settings” → uncheck “Camera” and confirm the bottom-right indicator dot shows off.
2. Check “Camera” again: the native dialog “Turn on the camera?” should appear with “Cancel” as the default button. Press “Cancel”: the dot stays off and the checkbox stays unchecked.
3. Check it once more and press “Turn on”: the dot turns on and the checkbox is checked.
4. With the camera off, press the “Camera” switch in the page's settings view: the same dialog should appear; on “Cancel” the settings view shows “Turning on the camera was cancelled” and the camera stays off.
5. Say or type “打開鏡頭”: the same dialog; after “Turn on” the subtitle shows “正在開啟鏡頭（狀態看右下角指示點）。” and the dot turns on.
6. During realtime voice, say “打開鏡頭”: the same dialog.
7. Switch to English and repeat step 2: the dialog title is “Turn on the camera?” and the buttons are “Turn on” / “Cancel”.
8. In the App's developer tools run `fetch("/api/settings/camera",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"active":true}'})`: it should answer 403 and the camera stays off.
9. With the camera off, run `navigator.mediaDevices.getUserMedia({video:true})` in the App's developer tools: it should be rejected (NotAllowedError) and neither the indicator dot nor the Mac's green light comes on; after turning the camera on the same line succeeds. `getUserMedia({audio:true})` is unaffected.
10. Close the main window (the App stays in the menu bar), then check “Camera” in the menu bar: the explanation should appear as an app-modal dialog (not attached to the invisible window); after “Cancel”, checking it again shows it again. Check the always-on wake listening switch the same way.
11. Make saving fail while saying “關掉鏡頭” in the page (for example, temporarily replace `camera.json` with a folder of the same name) and confirm the camera is off in this window (the core is still on and the menu bar is still checked); after restoring `camera.json`, say “打開鏡頭”: the explanation should appear, and after “Turn on” the camera runs again.
12. Start the browser version with `npm start`: the settings view's “Camera” switch and “打開鏡頭” still turn the camera on (the browser may show a permission prompt).

<a id="7-下一個-gate"></a>
## 7. Next gate

George checks §6 on the Mac; after it passes, change the matching note in [the current implementation document](../Current_Implementation_Status.en.md) to “checked on the Mac”.
