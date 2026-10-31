<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

# Nous macOS App

The current desktop package uses Electron and a local Node.js core. Tauri, Quest clients, and cross-device synchronization are unimplemented. See [current implementation](../../../docs/Current_Implementation_Status.en.md) for status and verification scope, and the [feature expansion assessment](../../../docs/13_Feature_Expansion_Assessment_2026-10-24.en.md) for plans.

This packages the Nous electronic brain as a macOS App with a built-in local core, so no terminal is needed. The Nous menu-bar icon provides common actions and settings. Most App settings live in the menu bar. The window's settings page contains only Accounts and sign-in, for the ChatGPT engine account and the ChatGPT plan (Codex) account used for realtime voice. The browser version, started from a terminal without a menu bar, retains the complete settings page.

![App icon](./assets/icon-1024.png)

<a id="安裝"></a>
## Installation

1. The [v0.1.0 preview](https://github.com/pcpcchen-coder/AIOS/releases/tag/nous-desktop-v0.1.0) offers `Nous-0.1.0-mac-arm64.zip` for Apple Silicon. This existing prebuilt artifact has not been checked for the latest main features as of 2026-10-23. To use current source, build it below. For the zip, extract and drag `Nous.app` into Applications.
2. The default build uses local ad-hoc signing without Apple notarization. If macOS blocks an App whose source you have verified, use Open Anyway at the bottom of System Settings → Privacy & Security, or run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Nous.app
   ```

3. Choose a realtime voice route. In the Realtime voice menu, sign in with ChatGPT plan (Codex), or choose Enter OpenAI API key… to open the configuration. Paste the key after `OPENAI_API_KEY=` and save; the App restarts the core to apply it. See [realtime voice verification](../../../docs/validation/live-voice-2026-10-23.en.md) for the tested scope of the separate login / billing routes.
4. On the first voice conversation, allow the macOS microphone permission request.

<a id="選單列圖示"></a>
## Menu-bar icon

| Item | Purpose |
|---|---|
| First three status lines | Current engine; realtime route and billing, for example “ChatGPT plan (Codex allowance) · gpt-live-1-codex,” with a separate active-call marker; voice state; active task count |
| Show brain (⌥⌘N) | Show / hide the window using a global shortcut |
| Start / end voice conversation (⌥⌘V) | Realtime voice global shortcut |
| Type a message, View progress | Open the corresponding view |
| AI engine | Switch the work engine between ChatGPT, Claude, and mock. Sign-in / account settings… opens Accounts and sign-in in the window |
| Realtime voice | Route (Automatic / ChatGPT plan / API key, next start without restart); ChatGPT plan (Codex) login; voice for that route; ChatGPT plan usage; API-key model (`gpt-realtime` or `gpt-realtime-mini`, billed at current OpenAI rates) and voice (changes restart the core); Accounts and sign-in… for logout / device-code login; API key entry; OpenAI usage |
| Concurrent tasks | 2 / 4 / 6 / 8 |
| Camera and voice settings | Camera and gestures: camera, look-to-talk, facing delay, post-conversation pause, greet first, use recognized family names, palm stop, and proximity brain zoom (1, 1.5, 2, 2.5, 3 times; default 2), followed by Show camera preview. Voice: browser-voice idle timeout and realtime idle timeout. Toggles are checkboxes; timeouts and zoom show preset radio choices, with an extra Current item for values set by voice or browser − / + controls. Changes save and apply without core restart. Failure shows the reason and rereads persisted values. Voice / typed settings changes notify the App to refresh the menu. Without `NOUS_CAMERA=on`, camera toggles, times, zoom, and preview are disabled. Reasons appear below the section heading (also visible before macOS 14.4), in sublabels (macOS 14.4+), and first in numeric submenus. When the camera toggle is off, preview is disabled with its reason while other controls remain editable but say they have no effect until the camera is on. If realtime voice is unavailable, look-to-talk says it requires realtime voice. Order, labels, choices, and write paths come from the core's `GET /api/settings` `seconds`, without hard-coded setting keys in the menu |
| Family recognition… (last camera item) | Opens family list, enrollment, deletion, trial recognition labeled uncalibrated, and data explanation. Only the main-window local-core page can open a single-use management session within 10 seconds after this menu click. Voice or page scripts cannot open it independently. Session ends on dismiss, 10 minutes idle, 15 minutes total, reload, or navigation. Enrollment / deletion require native confirmation; minors require parental confirmation. The core provides disable reasons. Without safeStorage encryption, it is disabled. Missing / hash-mismatched models or a disabled camera still permit viewing / deletion. Data loads only on first opening, not at startup, to avoid early Keychain access. Key failures explain retry, allowing Keychain or restarting, rather than asking to clear data. Outside this view, recognition runs only during look-to-talk (ID-02: with named greetings on, samples during facing wait and greets “George, I'm here” or “I'm here”), never continuously in the background. See [ID-01](../../../docs/validation/family-id-01-2026-10-25.en.md) and [ID-02](../../../docs/validation/family-id-02-2026-10-25.en.md) |
| Wake word (last section of Camera and voice settings; appears only with `NOUS_WAKE=on` in `.env`; WK-01a) | A “Wake listening: …” status line (Listening locally / Starting / In a call / Paused / Microphone handed over / Unavailable / Off, driven only by device events the page reports; “Not reported yet” before the page reports), the “Always-on wake listening” switch (off by default; every off → on switch first shows a native explanation and saves only after “Turn on”, and it can be turned on only here, never by the page itself; turning off stops capture first and then saves, explaining any save failure), “Pause listening (until this session ends)” / “Resume listening” (not saved to the settings file; listening resumes after the App reopens), and a disabled “Recognise speaker during calls” row (not clickable; available after SP-02). Listening stops on sleep and lock and resumes per the preference on wake and unlock. The wake word is the English “Hello Nous”: engine files are installed by `npm run wake:setup -- --product` into `~/Library/Application Support/Nous/wake-runtime/`, never in the App bundle; without them, the state after turning it on is “Unavailable: The wake engine is not installed yet; the microphone was not opened”. A wake plays an earcon, greets you and starts realtime voice, ending after about 5 seconds without speech (WK-02); see [INSTALL](../INSTALL.en.md) |
| Voice command table | Opens a read-only table of local commands, contexts, misunderstandings, AI questions, nonvoice actions, and current timeouts. Generated from settings when opened, with a footer timestamp. Refresh with ⌘R after changes. Does not interrupt a conversation |
| Settings and data | Edit `.env`, open task / artifact folder, restart core, ChatGPT usage, microphone permissions, logs |
| Always on top, Show Dock icon, Open at login, Start with menu-bar icon only | Apply immediately when checked |

The View menu also contains Voice command table (⌘/), as does Help.

The core generates the command-table window at `GET /help/commands`. The page has no script and permits only its own styles through CSP. The window has no preload, enables sandbox, disables JavaScript, uses a separate in-memory session, denies every permission including camera and microphone, and blocks navigation / new windows. Core restart reloads it. The core's `GET /api/settings` `seconds` owns timeout choices, ranges, and labels, without a second copy in the App.

> **Not yet verified on a real Mac** (see [`docs/validation/menu-settings-consolidate-2026-10-23.md`](../../../docs/validation/menu-settings-consolidate-2026-10-23.en.md)): Settings consolidation on 2026-10-23, including Camera and voice settings checkboxes, preview, and accounts-only window settings, received only Electron syntax checks with `node --check`, without execution.
>
> **Not yet verified on a real Mac** (see [`docs/validation/menu-seconds-commands-2026-10-22.md`](../../../docs/validation/menu-seconds-commands-2026-10-22.en.md)): The Camera and voice settings submenu, formerly Timeouts and zoom and including zoom rows added 2026-10-23, and the command-table Electron window received Linux `node --check` only. Untested items include submenu rendering, selection and saving, menu refresh after browser / voice setting changes, command-table ⌘R / core-restart reload and restore from minimize, denied microphone / camera permissions, and blocked navigation / new windows. Core-generated `seconds` and `/help/commands` data were tested on Linux.

The monochrome template icon adapts to light / dark menu bars. Voice adds a solid lower-right dot like a recording indicator; running tasks add a count. Closing the window keeps Nous in the menu bar and background tasks running. Quit Nous (⌘Q) ends the App.

<a id="檔案放在哪裡"></a>
## File locations

| Content | Location |
|---|---|
| Configuration, including API keys | `~/Library/Application Support/Nous/.env` |
| App preferences (model, voice, window) | `~/Library/Application Support/Nous/desktop.json` |
| Tasks and artifacts | `~/Library/Application Support/Nous/data/` |
| ChatGPT credentials | `~/.config/nous/`, shared with terminal mode |
| Camera preferences | `~/.config/nous/camera.json`, shared with terminal mode; camera toggles, delays, and brain zoom from Camera and voice settings |
| Voice idle timeouts | `~/.config/nous/voice.json`, shared with terminal mode |
| Encrypted family recognition data | `~/Library/Application Support/Nous/identity/gallery.v1.json`, directory 0700, file 0600, excluded from Time Machine. Encrypted face features and names only, no photos. safeStorage wraps the data key with the Keychain application key. Each enrollment / deletion rotates the data key |
| Recognition models and runtime | `~/Library/Application Support/Nous/face-runtime/`, installed with `npm run face:setup -- --product`, outside the App bundle |
| Logs | `~/Library/Application Support/Nous/nous.log` |

`app.asar` contains code, frontend, and icons only. No `.env`, task data, credentials, family data, or recognition models.

> **Family recognition**: George verbally reported ID-01 enrollment, trial recognition, and palm stop worked on Mac; the repo contains no measured numbers. See [ID-01 verification](../../../docs/validation/family-id-01-2026-10-25.en.md) §6 for safeStorage, `tmutil`, and worker CSP checks. ID-02 named greetings have cloud fixtures only; actual audio on both routes awaits [ID-02 verification](../../../docs/validation/family-id-02-2026-10-25.en.md) §5. Thresholds are uncalibrated and may misname or miss people.

<a id="與終端機版的差別"></a>
## Differences from terminal mode

- App voice uses realtime voice, requiring ChatGPT plan (Codex) login or `OPENAI_API_KEY`. Electron lacks Chrome cloud speech recognition, so without either only typing works. Terminal mode in Chrome can still use the older browser speech mode.
- Default port is 8787. If occupied, for example by terminal mode, another free port is chosen automatically.
- ChatGPT login opens the system browser because Google and other login pages block embedded windows, then returns to the App.

<a id="自己打包"></a>
## Build your own package

Requires macOS, Node.js 22.12 or later, and Xcode Command Line Tools (`swift`, `iconutil`, `codesign`).

```bash
cd prototype/ambient-shell
npm ci
cd desktop
npm ci
npm run icons    # 重新產生圖示（已附在 assets/，改了 scripts/make-icons.swift 才需要）
cd .. && npm run face:setup -- --product && cd desktop   # 選用：家人辨識的模型（約 53 MB，裝到 ~/Library/Application Support/Nous/face-runtime/）
npm start        # 開發：組好內容後直接用 Electron 開
npm run package  # 打包成 release/Nous-darwin-arm64/Nous.app 與 zip
```

`scripts/build.mjs` builds the frontend with Vite, bundles the core `server/nous.ts` into `server.mjs` with esbuild, and assembles `build/app`. `scripts/package.mjs` uses `@electron/packager` (Electron 44.9.3), signs, and creates a zip.

<a id="固定簽章與本機權限"></a>
### Stable signing and local permissions

Without a certificate, packaging uses ad-hoc signing. The designated requirement can change after rebuild; inspect it with `codesign -d -r- Nous.app`. macOS may treat the updated package as a different App and ask again for camera / microphone permissions. Check system permissions if camera startup stalls.

Packaging supports a stable self-signed certificate to retain the same local signing identity. Whether camera / microphone permission survives still needs validation on your Mac, installation location, and update flow. To create the certificate:

1. Open Keychain Access → Certificate Assistant → Create a Certificate….
2. Name it `Nous Local Signing`, choose Self Signed Root as identity type and Code Signing as certificate type, then Create.
3. Run `npm run package` again. The terminal reports signing with `Nous Local Signing` and a stable identity.

Switching to stable signing may ask for permissions once again. Check identity and actual capture permissions on each update; persistence is not guaranteed in every environment. Set `NOUS_SIGN_IDENTITY="憑證名稱" npm run package` for another certificate, such as Xcode Apple Development. The self-signed certificate is meaningful only on your own Mac. Inspect a downloaded preview's signature separately; your local certificate cannot guarantee installation on other computers.
