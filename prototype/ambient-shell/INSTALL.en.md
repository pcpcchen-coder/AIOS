<!-- bilingual: source=zh-TW -->

> [繁體中文](INSTALL.md) | [English](INSTALL.en.md)

<a id="安裝與執行指南本機"></a>
# Local installation and startup guide

Use this guide to start the current Node.js prototype. Download, dependency installation, and account authorization times vary with your network and device. See [current implementation](../../docs/Current_Implementation_Status.en.md) for capabilities and validation scope, and the [feature expansion assessment](../../docs/13_Feature_Expansion_Assessment_2026-10-24.en.md) for future plans.

> On macOS, the [v0.1.0 preview](https://github.com/pcpcchen-coder/AIOS/releases/tag/nous-desktop-v0.1.0) offers `Nous-0.1.0-mac-arm64.zip`. This existing prebuilt artifact has not been checked for the latest main features as of 2026-10-23. To use current source, start it below or build it using the [macOS packaging guide](desktop/README.en.md#自己打包).

<a id="0-需要的東西"></a>
## 0. Requirements

| Item | Version / description |
|---|---|
| Node.js | 22.12 or later (LTS recommended) |
| Git | Any recent version |
| Browser | Chrome or Edge (voice input is available only in these browsers) |
| AI account or API key | Claude needs `ANTHROPIC_API_KEY`. ChatGPT text engine and Codex realtime voice have separate logins. API realtime voice needs `OPENAI_API_KEY`. Without them, you can still explicitly select mock mode |

<a id="1-安裝-nodejs-與-git"></a>
## 1. Install Node.js and Git

### macOS

1. Download the **LTS** macOS installer (`.pkg`) from <https://nodejs.org> and double-click to install.
2. For Git, open Terminal and enter `git --version`. If prompted to install developer tools, click Install.

### Windows

1. Download the **LTS** Windows installer (`.msi`) from <https://nodejs.org> and proceed with Next.
2. Download Git from <https://git-scm.com/download/win> and install with default options.
3. **Reopen** PowerShell or Command Prompt after installation so the new commands take effect.

<a id="確認"></a>
### Verify

```bash
node --version   # 應顯示 v22.12.0 或更新
npm --version
git --version
```

<a id="2-下載程式碼"></a>
## 2. Download the code

Choose a project location, such as your home directory, then run:

```bash
git clone https://github.com/pcpcchen-coder/AIOS.git
cd AIOS/prototype/ambient-shell
```

The public repository can be downloaded directly. Configure GitHub write authorization through root `SETUP.md` when you need to submit or push changes.

If already cloned, preserve local changes before updating main:

```bash
cd AIOS
git checkout main
git pull --ff-only
cd prototype/ambient-shell
```

<a id="3-安裝套件"></a>
## 3. Install dependencies

```bash
npm ci
```

Confirm that installation finishes successfully without `npm ERR!`. The security audit summary is separate from installation success. `0 vulnerabilities` does not prove the prototype starts. After startup, verify the service message and page below.

<a id="4-選擇-ai-引擎"></a>
## 4. Choose an AI engine

Copy the configuration template:

| System | Command |
|---|---|
| macOS / Linux | `cp .env.example .env` |
| Windows PowerShell | `Copy-Item .env.example .env` |
| Windows Command Prompt | `copy .env.example .env` |

Nous supports three engines. Say “設定” (settings) on screen to switch later:

- **ChatGPT account login**: After startup, click the brain or Start voice conversation, select **Continue with ChatGPT**, sign in with your own account in the new tab, and consent. Return to Nous, select the voice entry again, and consent to capture. Login does not start the microphone. Credentials live in `~/.config/nous/`. The existing Sign in with ChatGPT preview requires inference authorization. Successful real-account verification has not been completed for this version, and compatibility with all plans is not guaranteed.
- **Claude (API key, usage billed)**: Enter a key in `.env` (obtain it from <https://console.anthropic.com>):

```
ANTHROPIC_API_KEY=sk-ant-...
```

- **Mock**: Explicitly select it in Settings for development checks. The UI labels mock mode, and no model is called. An unauthenticated ChatGPT conversation entry asks for login instead of silently substituting mock responses.

Git excludes `.env`, so it is not uploaded.

<a id="即時語音模式選填像-chatgpt-語音模式"></a>
### Realtime voice (optional, similar to ChatGPT voice mode)

For direct speech-to-speech conversation with interruption, configure either or both routes:

**A. ChatGPT plan (Codex login, `gpt-live-1-codex`, uses the plan's Codex allowance, no API key required)**

1. After startup, say or type “設定” and select **Sign in with ChatGPT plan (Codex)** under Realtime voice. In the macOS App this is on the Accounts and sign-in page. Alternatively use the macOS menu bar **Realtime voice → ChatGPT plan (Codex) sign-in…**.
2. The browser opens `auth.openai.com`. Sign in to your ChatGPT account and consent. The completion page reports ChatGPT plan (Codex) signed in, and settings shows your email and plan.
3. No Codex CLI installation is required. This login is separate from the AI engine's **Continue with ChatGPT**. Nous **does not read or modify Codex CLI's `~/.codex`**, and does not sign Codex CLI or OpenClaw out.
4. Callback ports: Codex login accepts only 1455 and 1457. If 1455 is occupied, for example by OpenClaw, Codex, or Continue with ChatGPT login, it uses 1457. If both are occupied, it uses a **device code**. Enter the code shown in settings at the opened `auth.openai.com/codex/device` page. You can also select Sign in with device code directly.

**B. OpenAI API key (`gpt-realtime`, usage billed, voice costs more than text)**: Enter a key in `.env` (obtain it from <https://platform.openai.com/api-keys>):

```
OPENAI_API_KEY=sk-...
```

Save and rerun `npm start`.

**Choose the route** in Settings → Realtime voice (browser), or App menu **Realtime voice → Route**. Options are **Automatic** (default: try ChatGPT plan first, then API key if unavailable, first announcing “This time uses OpenAI API key (usage billed): reason”), **ChatGPT plan** (report the real reason if unavailable, never switch to API billing), and **API key**. No `.env` change or restart is required. Changes affect only the next start. Settings, the menu bar, and the line below the input show the route and billing, such as “ChatGPT plan (Codex allowance) · gpt-live-1-codex” or “OpenAI API key billing · gpt-realtime.” Startup also prints this line without tokens.

After selecting Start voice conversation:

- Speech connects directly to speech without browser speech recognition. Conversation continues, and it stops to listen when you speak.
- Longer work becomes a background task. **Tasks still use the engine chosen above**, such as the ChatGPT plan, on both voice routes. Progress, result views, and spoken completion notices are the same.
- Ask “進度如何” (how is progress) for real status, or “新竹今天會下雨嗎” (will it rain in Hsinchu today) for web search. ChatGPT plan uses Codex allowance; API key uses that same key.
- Click the upper-right indicator, press Esc, or stay silent for a while to end. The default is two minutes, adjustable in App menu Camera and voice settings or browser Settings. For “再見” or “結束對話,” the AI decides whether to end, without a guarantee each time. On the ChatGPT plan route, a standalone “再見” also ends after the farewell finishes.
- Tokens and API keys stay in the local core and are not sent to the browser.
- The ChatGPT plan route has no remote MCP; switch to API key for MCP. Esc only mutes the current spoken response. Only one ChatGPT plan realtime conversation can run at a time. Reload immediately ends it, after which another can start.

Without either route configured, Start voice conversation uses the existing browser speech recognition + ChatGPT text response + computer speech mode.

> The AI engine's Continue with ChatGPT (Sign in with ChatGPT) login cannot be used for realtime voice (real checks returned OpenAI server_error). Plan-based realtime voice requires Codex login here. Codex realtime voice has home Mac login, call, and sideband logs; temperature queries after the fix have verbal success reports only. Full journeys, other tools, and billing reconciliation remain unfinished. See [realtime voice verification §4](../../docs/validation/live-voice-2026-10-23.en.md#4-真實結果george-家中測試). These results do not verify the Continue with ChatGPT text engine.

<a id="雙目鏡頭選填waveshare-ar0144"></a>
### Stereo camera (optional, Waveshare AR0144)

1. Mount the camera above the 18-inch display, facing your sitting or standing position, and connect USB to this computer. macOS lists it as `CCB Camera`.
2. Download local vision models once, about 30 MB:

   ```sh
   npm run vision:setup
   ```

3. Add `NOUS_CAMERA=on` to `.env`, save, and rerun `npm start`. Allow camera permission when asked.

A camera status dot appears in the lower-right corner. Facing the display for about 1.5 seconds automatically starts realtime voice if you previously consented. Raise an open palm during speech to stop playback. Say “鏡頭關掉” to disable it. Images are processed only on this computer, without saving or upload.

- **Preview**: Say “顯示鏡頭畫面” or click the lower-right dot to see two small tiles: left-eye live video and left / right differences. Use them to check alignment. Say “收起鏡頭畫面” or click the dot again to dismiss.
- **Adjust**: Say “鏡頭設定.” Camera and gestures lets you toggle the camera, look-to-talk, greet first during look-to-talk (defaults on and asks how to help after connection), and palm stop. Adjust facing delay (0.5–5 seconds), post-conversation pause (3–60 seconds), and proximity brain zoom (1–3 times, default 2). Changes apply without restart.
- **Proximity zoom**: Beyond 2.5 m the brain keeps its ordinary size. It grows as you approach, reaching the configured factor within 0.6 m (1 means no zoom). Brain region labels scale with it. Panel and subtitle text follow docs/10 instead, growing at greater distance.
- “鏡頭關掉” is remembered across restarts. Say “打開鏡頭” to enable it again.

These views and settings have not been verified with the physical camera.

<a id="常駐喚醒聆聽選填wk-01a尚無喚醒引擎"></a>
### Always-on wake listening (optional, WK-01a, no wake engine yet)

After you add `NOUS_WAKE=on` to `.env` and restart, the macOS App's menu bar “Camera and voice settings” gains a final “Wake word” section: the “Always-on wake listening” switch (off by default; an explanation appears before it turns on), the current state, “Pause listening (until this session ends)”, and a disabled “Recognise speaker during calls” row (available after SP-02).

**It does not detect 「哈囉努斯」 yet**: the wake engine arrives in WK-01b, so after you turn it on the state reads “Unavailable: The wake engine is not installed yet; the microphone was not opened”, and the microphone stays closed. Without `NOUS_WAKE`, everything behaves as before. See [WK-01a validation](../../docs/validation/wk-01a-2026-10-31.en.md).

<a id="武陵居中控選填"></a>
### Wuling home controller (optional)

Realtime voice can query home sensors and devices, for example living-room temperature, study CO₂, or main-light connectivity. It can also control one device, such as turning off a light, setting a desk lamp to 60%, or color temperature to 3000K. Configure realtime voice above first.

1. Ensure the Wuling controller is running (default `http://127.0.0.1:8788`).
2. Create a Nous token in the controller's System integration page.
3. Add to `.env`:

   ```
   SMARTHOME_URL=http://127.0.0.1:8788
   SMARTHOME_TOKEN=剛剛建立的權杖
   ```

   If the controller moves to another computer, replace `127.0.0.1` with its LAN IP.

4. Rerun `npm start`. The terminal reports Wuling controller configured.

Report readings exactly as the controller does. Missing readings are “no reading”; cloud snapshots or expired data include their timestamp.

Control results follow controller readback. Say completed only when the device confirms. “Sent, unconfirmed” means the controller sent it without device confirmation; check the physical response. Note:

- Control one device at a time. A request for all lights in a room asks which device.
- AIFA air conditioners support power, temperature, mode, fan, and swing. Infrared appliances such as TVs and fans support one remote key at a time. Neither has readback. Nous says sent, please verify. Sync infrared keys in the controller's IR controller first; link an AIFA account for AIFA air conditioners. Non-AIFA air conditioners (Tuya, Home Assistant) and wireless buttons do not yet support voice control.
- Devices must be integrated into the controller first. When status is stale, Nous asks the controller to reread once before sending. If still unavailable, it reports not sent.
- At most six control commands per minute.
- H1 defaults all devices to `allow` and sends directly. Device-specific confirmation / disabled policy wiring awaits H2. The current home-control flow is not a complete Action Gate.

The token stays in the local core, not the browser or OpenAI.

<a id="5-啟動"></a>
## 5. Start

```bash
npm start
```

This line indicates that the local service started:

```
Nous 原型已啟動：http://localhost:8787
```

Open <http://localhost:8787> in Chrome or Edge and confirm the brain and settings render. This checks local startup only. Test accounts, models, microphone, camera, and home devices separately.

In a managed environment requiring an HTTPS proxy, follow that environment's configuration and use `NODE_USE_ENV_PROXY=1 npm start` where applicable. Login callbacks and microphones still require a device able to connect to the same local core. Starting a cloud service does not verify local audio.

Press `Ctrl + C` in the terminal to stop. Next time, return to `AIOS/prototype/ambient-shell` and run `npm start`.

<a id="6-怎麼用"></a>
## 6. Usage

| Action | Result |
|---|---|
| Click the brain or Start voice conversation | Follow prompts to sign in to your ChatGPT account; capture starts only after explicit voice activation |
| Press Space or type, then Enter | Continue the same conversation, including without a microphone |
| Speak during playback or press Esc | Stop the current reply and speech, then listen |
| Type “進度如何” | List progress for all tasks |
| Type “看結果” | Open the most recently completed result |
| Type “停止任務” | Stop running tasks |
| Type “設定” / “改用 ChatGPT” | Switch the AI engine or sign in / out of ChatGPT |
| Click End conversation, type “收起,” or press Esc when not speaking | Stop capture, generation, and playback. Existing background tasks continue |
| Microphone button | Push to talk; first asks consent to browser cloud recognition |
| Say / type “開啟語音模式” or click the sound-wave button | Browser voice conversation, with interruption while it speaks, for example “停” or direct speech. Longer work becomes tasks. Headphones recommended. Say “關閉語音模式” to end. Default idle timeout is 1 minute 30 seconds, adjustable |
| Click Start voice conversation with an available realtime route (ChatGPT plan login or `OPENAI_API_KEY`) | Direct speech-to-speech with interruption; work goes to the current engine. The upper-right indicator shows listening / speaking and ends on click. The AI decides whether “再見” ends the conversation |

For complete voice and typed commands, local versus AI handling, and common misunderstandings, see the [README command table](README.en.md#語音與打字指令表). With the core running, open <http://localhost:8787/help/commands>, or use Voice command table (⌘/) in the macOS menu.

<a id="7-常見問題"></a>
## 7. Troubleshooting

| Symptom | Action |
|---|---|
| `node: command not found` / not recognized as a command | Install Node.js correctly or reopen the terminal after installation |
| `npm ci` gives `EBADENGINE` or vitest errors | Upgrade Node to 22.12 or later |
| `EADDRINUSE: address already in use 127.0.0.1:8787` | Stop the previous `npm start`, or add `PORT=8790` to `.env` and open <http://localhost:8790> |
| Frontend not built | Use `npm start` rather than `npm run dev:server` |
| Red local-core connection-lost message | Restart the stopped `npm start` process |
| Task reports invalid / unauthorized API key (401) | Check that `.env` key is complete without extra spaces, then rerun `npm start` |
| API rate limit exceeded (429) | Wait and retry |
| No microphone button | Use Chrome or Edge, which support speech recognition |
| Continue with ChatGPT opens no tab | Allow localhost popups and try again |
| No client_id issued / plan usage not authorized after login | Allow ChatGPT plan usage on consent, then select Reauthorize in settings |
| ChatGPT task reached usage limit | Select Manage usage to view plan / Nous limits in ChatGPT settings |
| OpenAI API unreachable on a proxy network | Start with `NODE_USE_ENV_PROXY=1`, for example `NODE_USE_ENV_PROXY=1 npm start`, so Node uses `HTTPS_PROXY` |
| Home temperature query cannot connect to Wuling controller | Start the controller and check `SMARTHOME_URL` address / port |
| Controller rejects token (401) | Token was revoked or entered incorrectly. Create another under System integration, update `SMARTHOME_TOKEN`, and restart |
| Microphone permission denied | Use the address-bar permission control to allow the microphone and reload |
| Realtime voice says `OPENAI_API_KEY` invalid / unauthorized (401) | Check the complete `.env` key without extra spaces and restart |
| Realtime voice has insufficient credit or rate limit (429) | Check API balance at <https://platform.openai.com/settings/organization/billing> |
| Realtime voice unavailable in settings | Neither route works: no ChatGPT plan (Codex) login and no `.env` `OPENAI_API_KEY`, or no restart after setting it. Actual reasons are listed |
| ChatGPT plan route not signed in | Settings → Realtime voice → Sign in with ChatGPT plan (Codex) |
| ChatGPT plan login expired | Refresh token was rejected, possibly revoked elsewhere. Sign in again |
| Login has no ChatGPT account ID | The account lacks a ChatGPT workspace / plan. Use an account with a plan |
| ChatGPT plan allowance exhausted, resets in about N minutes | Wait for Codex reset or Manage usage. In Automatic with an API key, the next start switches to API key with advance notice |
| ChatGPT plan rejects realtime voice (403) | Account, plan, or voice is rejected; the server does not say which. Try default cove or check that the plan supports Codex |
| `NOUS_LIVE_MODEL` value rejected | Remove `NOUS_LIVE_MODEL` from `.env` (default sends no model) and restart |
| Cannot connect to chatgpt.com / api.openai.com or sideband | Network or proxy may block it. On a company network, try `NODE_USE_ENV_PROXY=1 npm start` |
| ChatGPT plan control connection lost; realtime voice ended | No mid-call route switch. Select Start voice conversation again |
| Another ChatGPT plan realtime conversation is active | End it in the other tab / App window first |
| Both 1455 and 1457 occupied; device-code login selected | OpenClaw or Codex may be logging in. Enter the displayed code on the opened page, or close the other login |
| Home command result unknown, please verify | No controller result arrived within the deadline. The device may or may not have acted; check it |

<a id="8-資料存放位置"></a>
## 8. Data locations

- Tasks and artifacts: `prototype/ambient-shell/data/`, local JSON. Unfinished tasks become failed on restart. Retry creates a new task and reruns it entirely without checkpoints.
- Ordinary conversation history: current page memory only. Cleared by reload, engine / account switch, or logout. No persistence or cross-device sync.
- ChatGPT credentials and engine choice: `~/.config/nous/` (Windows `C:\Users\你的帳號\.config\nous\`). To fully unlink, sign out in settings, then disconnect Nous in ChatGPT settings.
- Camera / gesture preferences: `~/.config/nous/camera.json`, changed fields only, no images. Delete and restart to return to `.env` and defaults.
- ChatGPT plan (Codex) voice credentials: `~/.config/nous/codex-credentials.json`, mode 0600. Remove through Settings → Realtime voice → Sign out (realtime voice). This deletes the file and attempts remote token revocation. Nous does not read or change Codex CLI's `~/.codex`.
- Realtime route and ChatGPT-plan voice: `~/.config/nous/realtime.json`, changed fields only. Deletion returns to `.env` `NOUS_REALTIME_ROUTE` / `NOUS_LIVE_VOICE` or defaults (Automatic, cove).
- Voice idle timeouts: `~/.config/nous/voice.json`, changed fields only. Delete and restart to use defaults (browser voice 1 minute 30 seconds; realtime 2 minutes).
- To clear records: stop `npm start`, delete `data`, then restart.
