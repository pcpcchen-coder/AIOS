<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

# Raspberry Pi 4 terminal kit (RPI-1)

Status: **deployment and hardware evidence are available for one Pi 4** (2026-11-05). SSH forwarding, kiosk, USB audio, camera preview, look-to-talk, face naming, and voice-only wake naming were confirmed. These observations do not establish support for other hardware or long-term stability. Boot autostart was last tested on 2026-11-03, not repeated this evening. See the [deployment fixes and hardware record](../../docs/validation/rpi-deployment-fixes-2026-11-05.en.md).

## What this is

The Mac mini keeps running the **Nous App** (Electron). The Agent, the realtime voice backend and all data stay in the App core on the Mac. The Raspberry Pi 4 is only a terminal, using its own screen, microphone, speaker, and camera.

```text
Pi Chromium ──http://localhost:<AIOS_PORT>──> Pi 127.0.0.1:<AIOS_PORT>
   ──SSH local forward (autossh)──> Mac 127.0.0.1:<AIOS_PORT> ──> Nous App core
```

- The core listens only on `127.0.0.1` and is not exposed to the LAN. The Pi reaches the Mac loopback through SSH forwarding.
- Chromium on the Pi opens `http://localhost`, a secure context, so `getUserMedia` (microphone, camera) is available.
- `server/http-guard.ts` accepts only `localhost:<actual core port>` and `127.0.0.1:<actual core port>`. Therefore **the Pi local port must equal the Mac core port**. The kit uses one setting, `AIOS_PORT`, for both ends. Do not disable or loosen this check to get a connection.

Kit contents:

| File | Purpose |
|---|---|
| `install.sh` | One-step install: packages, config file, SSH key, host fingerprint verification, systemd --user services, desktop autostart |
| `uninstall.sh` | Uninstall and roll back; `--purge` also removes the config, key and Chromium profile |
| `terminal.conf.example` | Config template with no private values |
| `bin/aios-tunnel` | autossh tunnel (run by `aios-tunnel.service`) |
| `bin/aios-kiosk` | Waits for the core, then opens Chromium full screen (run by `aios-kiosk.service`) |
| `bin/aios-session-start` | On desktop login, hands the display environment to systemd and starts `aios-kiosk.service` |
| `bin/aios-doctor` | Diagnostics with one PASS / WARN / FAIL / SKIP line per check |
| `systemd/`, `autostart/` | User services and the desktop autostart entry |
| `tests/dry-run.sh` | Dry-run test with fake commands that runs in a container; CI and `scripts/verify-aios.mjs` run it |

## Mac preparation

1. Open the Nous App and confirm it works on the Mac (sign-in, text, realtime voice).
2. Turn on Remote Login: System Settings → General → Sharing → Remote Login, allowing only your own account.
3. Pin the core port. Edit `~/Library/Application Support/Nous/.env`, change `# PORT=8787` to `PORT=8787`, then restart the App. If 8787 is already taken when the App starts (for example by a separate `npm start`), the core silently switches to another free port (`fallbackPort` in `server/nous.ts`).
4. Find the actual core port with either command:

```bash
grep 'Nous 原型已啟動' "$HOME/Library/Application Support/Nous/nous.log" | tail -n 1
lsof -nP -iTCP -sTCP:LISTEN -a -c Nous
```

The first prints `http://localhost:<port>` (the log line is in Chinese and means "Nous prototype started"). `lsof` may also list 1455, used for ChatGPT sign-in; trust the URL in the log. If the port is not 8787, find what holds 8787:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

5. Note the Mac's SSH host fingerprint; the installer asks you to compare it:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

6. Keep the Mac awake during tests (System Settings → Energy, or run `caffeinate -d`).

## Pi installation

Requirements: Raspberry Pi OS **64-bit Desktop**, an HDMI display, a USB microphone and a speaker. Wired Ethernet, active cooling and a reliable power supply are recommended.

Put the repository (or just the `terminals/rpi4` folder) on the Pi and run, as the desktop user (not root):

```bash
cd AIOS/terminals/rpi4
bash install.sh
```

The installer:

1. Installs `chromium` (`chromium-browser` on older images), `autossh`, `openssh-client`, `v4l-utils`, `alsa-utils` and `curl` with `sudo apt-get`.
2. Asks for the Mac user, Mac hostname or IP, Mac core port and SSH port, and writes `~/.config/aios-terminal/terminal.conf` (mode 600).
3. Creates a dedicated SSH key, `~/.config/aios-terminal/id_ed25519`. It has no passphrase because autossh must connect unattended.
4. Fetches the Mac host key with `ssh-keyscan` and shows its fingerprint. **Type `yes` only if it is identical to the fingerprint from Mac step 5.** On success it writes the dedicated `~/.config/aios-terminal/known_hosts`. Every later connection uses `StrictHostKeyChecking=yes`; the kit never uses `StrictHostKeyChecking=no`.
5. Adds the public key to the Mac with `ssh-copy-id` (asks for the Mac password once), then verifies a password-less login.
6. Installs `aios-tunnel.service` and `aios-kiosk.service` into `~/.config/systemd/user/`, the autostart entry into `~/.config/autostart/aios-kiosk.desktop`, and command links into `~/.local/bin/`.
7. Runs `sudo loginctl enable-linger` so user services start at boot (only if it was off; it records that the installer turned it on so uninstall turns it back off).
8. Starts `aios-tunnel.service` and enables it at boot.

For an unattended install (for example after reflashing), use environment variables and `--non-interactive`. Get the fingerprint from the Mac beforehand:

```bash
AIOS_MAC_USER=george AIOS_MAC_HOST=mac-mini.local AIOS_PORT=8787 \
AIOS_MAC_HOSTKEY_SHA256='SHA256:...' bash install.sh --non-interactive
```

Other options: `--skip-apt` (no packages), `--skip-copy-id` (public key already on the Mac), `--help`. Re-running the installer converges to the same state without duplicating entries; if the port or host changed, the installer restarts the tunnel (and the kiosk if it is running), so the new settings apply immediately.

### Boot straight into the terminal screen

1. `sudo raspi-config` → System Options → Boot / Auto Login → **Desktop Autologin**.
2. `sudo raspi-config` → Display Options → Screen Blanking → off, so the screen does not go dark.
3. Reboot. After desktop login, the autostart entry runs `aios-session-start`, which passes `DISPLAY` / `WAYLAND_DISPLAY` to systemd and starts `aios-kiosk.service`. The kiosk waits until `http://localhost:<AIOS_PORT>/api/settings` answers before opening Chromium.

`aios-kiosk.service` is not enabled at boot because it needs a desktop session. The Raspberry Pi OS Wayland desktop does not reliably start `graphical-session.target`, so the desktop autostart entry triggers it instead. Both services use `Restart=always`, so a crash restarts them.

### Chromium flags

The kiosk uses `--kiosk --app=http://localhost:<AIOS_PORT>/?terminal=rpi4` (`terminal=rpi4` makes the page send the core a heartbeat every 10 s, which the Mac menu bar uses to show whether the Pi is connected), a dedicated profile (`~/.local/share/aios-terminal/chromium-profile`), and `--autoplay-policy=no-user-gesture-required` so cues and replies play without a click first. The kit does **not** use `--use-fake-ui-for-media-stream` or any other flag that auto-grants camera or microphone access. The first time the microphone is used, Chromium asks once; click "Allow" with a mouse. The choice is stored in the dedicated profile.

`--disable-features=WebRtcPipeWireCamera` avoids the camera-enumeration hang observed with Wayland/Chromium. It changes only the camera backend, keeps PipeWire audio, and does not grant media permission.

## Diagnostics

```bash
aios-doctor
```

Each check prints `PASS`, `WARN`, `FAIL` or `SKIP`; the exit code is 1 if anything fails. Checks: config file, SSH key and known_hosts, `aios-tunnel.service`, whether the Pi local `127.0.0.1:<port>` is listening, the core `GET /api/settings` (the core has no `/api/health`; the response body is never printed), the page `GET /`, whether the Mac SSH port is reachable, `aios-kiosk.service`, Chromium, microphones (`arecord -l`), speakers (`aplay -l`), cameras (`v4l2-ctl --list-devices`, excluding the Pi's built-in bcm2835 / rpivid codec nodes; none is only a WARN), temperature (WARN from 70 °C, FAIL from 80 °C), `vcgencmd get_throttled` (current under-voltage or throttling is a FAIL, occurred since boot is a WARN), available memory (WARN below 15%), and the default network route. Output follows `LANG`; set `AIOS_LANG=en` or `AIOS_LANG=zh-TW` to choose.

<a id="service-mode"></a>
## Mac service mode

While using the Pi, choose "Enter service mode (for the Pi)" in the Mac menu bar: the Mac brain hides, the Mac's microphone, always-on wake and camera stop (settings unchanged), and the core, sign-ins and background tasks keep serving the Pi. The App stays in service mode after a restart. The top of the menu bar menu shows "Service mode: Pi connected" or "Service mode: Pi disconnected"; this follows only the Pi page's heartbeat (connected only with a heartbeat in the last 25 s), not the service mode switch. Choose "Return to Mac use" to switch back; wake and camera resume per their saved settings. The original design and acceptance steps are in the [service mode validation](../../docs/validation/service-mode-2026-11-03.en.md). Service mode and Pi heartbeat were confirmed on the tested Mac/Pi combination on 2026-11-05; see the [hardware record](../../docs/validation/rpi-deployment-fixes-2026-11-05.en.md). The original cloud-test verdict remains unchanged.

<a id="display-performance"></a>
<a id="settings-entry"></a>
## Settings button

The Pi page has a gear button in the bottom-right corner. Click it once with the mouse to open this Pi's settings and again to close them; the camera status dot sits to its left. The settings page holds every setting available on this Pi: AI engine, realtime voice, voice, camera and gestures (including "Show camera view"), sound, voice volume, display performance, proactive reminders, clock and weather, home status, and memories mode. Family enrolment and memory management remain in the Mac App only. The Mac has a menu bar, so the Mac window has no such button. See the [validation record](../../docs/validation/pi-settings-entry-2026-11-07.en.md).

## Display performance

If the Pi display is not smooth, open "Settings" → "Display performance on this device" on the Pi page and choose "Full", "Balanced" or "Light". It changes only brain animation and background blur, without changing listening, playback, or voice-processing logic. Actual conversation fluency still shares the CPU and memory load. The choice is stored in the Pi's browser, and the Pi defaults to "Balanced". The same section shows the measured frames per second and draw time per frame. Details are in the [display performance validation](../../docs/validation/pi-performance-2026-11-05.en.md) (**improvement on a real Pi not measured**). This session confirmed switching all three options and persistence after reload; the tested device was left on Light. A 1280×720/60 Hz resolution trial gave no user-perceived improvement, so the original 1920×1080/about 55.758 Hz mode was restored. See the [hardware record](../../docs/validation/rpi-deployment-fixes-2026-11-05.en.md).

## Memories mode

On the Pi page, "Settings" → "Memories mode" switches it on or off (the same setting the Mac menu bar writes). When on, the Pi plays photos and videos from the Mac memories folder after it has been idle for a while; it fetches them from the Mac core over the SSH tunnel and never connects to Google directly. While showing, the brain uses the light render budget and at most one video plays at a time; H.264 videos and photos exported at "Large" size are recommended. Saying the wake word, facing the camera or tapping the photo collapses them at once. Details are in the [memories mode validation](../../docs/validation/memories-mode-2026-11-06.en.md) (**not verified on a real Pi**).

Google Photos (MEMO-2): on the Pi page, "Settings" → "Memories" → "Pick from Google Photos…" shows a QR code; scan it with a phone and pick in Google's screen. Photos download to the Mac cache and the Pi reads them only through the Mac core. Run `gog auth add account --services photospicker` on the Mac first. See the [MEMO-2 validation](../../docs/validation/memories-google-2026-11-06.en.md) (**not verified with a real account**).

## Clock & weather corner

By default the top-right corner of the Pi screen shows the time, date, weekday, temperature and weather (a read-out only; it cannot be tapped). Time uses the time zone the Mac core gives (the weather place's time zone, or the Mac's system time zone without a place), not the Pi's own time zone; when the Pi clock is more than 60 s off the Mac, the page uses the Mac core's time, but it is still worth confirming with `timedatectl status` that the Pi's NTP is synchronised. Weather comes from the Mac core over the SSH tunnel (Open-Meteo, place as the "Proactive briefing" weather place); the Pi never connects to Open-Meteo directly. When it cannot be retrieved the corner says so (「天氣暫時無法取得」, "Weather is unavailable right now"). Switch it off with "Clock & weather corner" → "Pi terminal" in the Mac menu bar or the settings page. Details are in the [clock & weather validation](../../docs/validation/pi-clock-weather-2026-11-07.en.md) (**not verified on a real Pi**).

<a id="realtime-cost-guard"></a>
## Realtime voice cost guard

Since 2026-11-06 ([validation](../../docs/validation/realtime-cost-guard-2026-11-06.en.md), **cloud fixtures only, not verified on a Pi**): the Pi page has no Mac App power events, so on the Pi realtime voice ends when the page is in the background for more than 30 s (switching to another window, minimizing Chromium) or the page is closed or reloaded; after a period without speech (menu bar "Realtime voice idle timeout", default 2 minutes); or at the per-call limit (default 20 minutes, with a warning 1 minute before). The page checks in with the Mac core over the tunnel every 15 s; if the tunnel drops, the core ends the call and hangs up within 45 s. **Turning off the Pi monitor does not end the call** (Chromium does not go into the background), so keep screen blanking off as recommended above and rely on idle and the limit. Locking the Mac does not end a Pi call; Mac sleep does. The Pi's top-right indicator and the Mac menu bar both show call time and approximate tokens (page-reported, not a bill).

## Daily operation

```bash
systemctl --user status aios-tunnel.service aios-kiosk.service
systemctl --user restart aios-tunnel.service aios-kiosk.service
journalctl --user -u aios-tunnel.service -u aios-kiosk.service -n 100
```

If the Mac core port changes, edit `AIOS_PORT` in `~/.config/aios-terminal/terminal.conf` and restart both services.

On the tested Raspberry Pi OS/labwc desktop, `Ctrl+Alt+Delete` opens the shutdown menu and `Ctrl+Alt+T` opens a terminal. Stop the service to leave the Nous kiosk. `Alt+F4` alone causes it to reopen because the service restarts it.

```bash
systemctl --user stop aios-kiosk.service
# Resume Nous after desktop adjustments.
systemctl --user start aios-kiosk.service
```

Stopping kiosk manually does not disable autostart at the next desktop login. Shut down through the shutdown menu before moving the Pi, then wait for the display and activity LED to stop before disconnecting power.

## Uninstall and rollback

```bash
bash uninstall.sh
bash uninstall.sh --purge
```

`uninstall.sh` disables and removes both services, the autostart entry, the command links and the installed scripts, and turns linger back off if the installer turned it on. The config, key and Chromium profile stay unless you pass `--purge`. It does not remove apt packages and does not touch the Mac: it prints the command to remove the packages and the command that deletes the line containing this Pi's public key from the Mac's `~/.ssh/authorized_keys` (matched by key content, not the comment, because every Pi defaults to the hostname `raspberrypi`). To roll back the Mac, turn off Remote Login in Sharing and comment `PORT` out of `.env` again.

<a id="known-limitations"></a>
## Known limitations and device boundaries

- **Encrypted result content and memory management reach only the App main window.** That content travels only over the Electron main window's IPC; SSE and `/api/*` carry only the outer shell. The Pi page can submit tasks, see progress shells and use realtime voice, but cannot see protected result content, manage memory or use memory in typed chat.
- **Family recognition runs on the Pi; enrolment stays on the Mac.** The Pi page computes features with its own camera and microphone and sends them to the Mac core through `/api/terminal/identity`. Enrolment, deletion, and calibration remain in the Mac App. Face naming and voice-only naming while looking away and saying the wake word were confirmed on this device; see the [hardware record](../../docs/validation/rpi-deployment-fixes-2026-11-05.en.md). The [original Pi recognition validation](../../docs/validation/pi-family-recognition-2026-11-05.en.md) keeps its cloud-fixture scope.
- **Pi camera preferences apply only to that Pi.** With no App preload and exactly one `terminal=rpi4` parameter, `terminal-camera.ts` saves camera preferences in that Chromium profile's `localStorage`, initially off. Users can switch the Pi camera locally, with Chromium still requesting permission. The core still supplies installation enablement, camera label, and geometry. Native Mac enablement and HTTP `active: true` returning 403 remain. The Pi-local switch does not call the global enable API or require the Mac camera to be on.
- **Recognition availability follows the source page.** Pi recognition is no longer blocked by the Mac camera's off state. HTTP settings responses and SSE initial/update events retain the source. Switching the Pi-local camera off still stops face recognition. Terminal ambient evidence uses a 2000 ms gap and freshness limit, while Mac/management retain 500/1000 ms. Three same-person frames remain required, without lower similarity thresholds.
- **Test voice enrolment with the microphone that will be used.** In this session, enrolment from the Mac reSpeaker repeatedly returned `unknown` on the Pi EMEET. Re-enrolling and self-testing with the same USB EMEET on the Mac, then returning it to the Pi, produced successful voice-only wake naming. Back up encrypted family data first. The existing flow replaces that person's voice enrolment; it does not add a second simultaneous device template. See the [procedure and evidence](../../docs/validation/rpi-deployment-fixes-2026-11-05.en.md).
- **The wake listening switch is only in the Mac App menu**, but each page listens with its own microphone (corrected 2026-11-05): the switch is stored in the core and pushed to every page through settings events, so the Pi page then detects "Hello Nous" / "Hey Nous" locally on the Pi with the Pi microphone and starts the call on the Pi after waking. From 2026-11-05 the Pi page also recognises voices at wake through `/api/terminal/identity` (see family recognition above).
- **The Mac main window and the Pi page connect to the same core at the same time** (from reading the code, not confirmed on hardware):
  - SSE: task events are broadcast to both pages; settings events project identity status for their source, and each page updates independently.
  - Realtime voice depends on the route:
    - While a ChatGPT plan call is active, any call started from the other side is refused; the start response is HTTP 200 with `ok: false` and "busy" (`session_busy`).
    - While an API key call with memory rules is active, the same refusal applies.
    - While an API key call without memory is active, starting another API key call from the other side makes the core **end the existing call** without any busy message; starting a ChatGPT plan call from the other side may run both calls at once.
    - Each call belongs to the page that started it, and reply audio plays only on that page.
  - When the Mac is not in service mode, the Mac and the Pi both listen for the wake word, so one utterance may wake both and they compete for the same call; "look to talk" on the Mac may also start a call from the Mac.
  - The forced mute on memory revocation applies only to the Mac main window.
  - Recommendation: while using the Pi, put the Mac in [service mode](#service-mode) so the Mac does not listen, wake or start voice.
- The Pi runs no Agent and stores no task data. If the Mac sleeps or the App quits, the Pi screen has no core to reach. The kiosk waits for the core only before it opens Chromium; once Chromium is open it does not exit by itself, so recovery relies on the page's own reconnection, or run `systemctl --user restart aios-kiosk.service`.
- **Bluetooth is not supported yet.** The eMeet M0 Plus is connected by USB cable today; the plan for Bluetooth (call-mode audio quality, pairing, diagnostics and a field checklist) is in the [RPI-BT plan](../../docs/experiments/RPI4_BLUETOOTH_EMEET_PLAN.en.md) and is not implemented.
- The `aios-doctor` speakers check only looks for playback devices. A Pi with HDMI connected always has an HDMI audio device, so PASS does not mean a USB speaker is connected or selected as output; read the device names in the output.

<a id="rpi-2-draft"></a>
## RPI-2 draft plan: trusted Pi terminal pairing (not implemented)

Goal: after George explicitly pairs a Pi, give the Pi page the features that today reach only the App main window, without loosening `http-guard.ts` or making the core listen on the LAN.

1. **Pairing code.** George chooses "Pair terminal…" in the Mac App menu. The core creates a one-time 6-digit pairing code (for example valid for 2 minutes and void after 5 wrong tries), and the Mac window shows the code and a terminal name field. After the Pi page enters the code, the core asks George to confirm once more in a native dialog on the Mac.
2. **Revocable terminal credential.** After pairing, the core issues a random terminal credential (stored only as a hash, bound to the terminal name and creation time). The Pi keeps it in the kiosk's dedicated profile. Every request or SSE connection carries the credential. The App menu lists paired terminals and can revoke each one; revocation immediately closes that terminal's SSE and call.
3. **Permissions through the core.** Granted item by item as George chooses, all off by default:
   - Memory: let a paired terminal read and write memory over core HTTP (instead of IPC), keeping the consent, current-person, revocation and stop-playback rules; the stop-playback mute must instead notify that terminal's page.
   - Encrypted results: the core decrypts on a paired terminal's request and answers only that terminal, keeping the MEM-4c plaintext lifecycle.
   - Camera: after confirmation on the Mac, let the terminal turn on its own camera, with frames analysed only inside the Pi browser; the red line that raw frames are never written to disk or sent out stays.
   - Wake: after confirmation on the Mac, let the terminal turn on always-on wake listening with the Pi microphone.
4. **Coordinating the main window and terminals.** Decide which device captures and speaks at any moment (for example the last device with someone present wins), so the two sides do not start voice at once.
5. **Decisions for George:**
   - Whether terminals may use memory and encrypted results, or only the camera and wake.
   - How long a pairing code is valid, and whether credentials expire periodically.
   - Who wins when the Mac main window and the Pi both detect presence.
   - Whether family recognition (face, voice) runs on the Pi, and whether its models and runtimes move to the Pi.
   - Whether it is acceptable to keep the terminal credential in the Pi kiosk profile (a lost Pi must be revoked from the Mac).
