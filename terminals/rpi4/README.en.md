<!-- bilingual: source=zh-TW -->

> [繁體中文](README.md) | [English](README.en.md)

# Raspberry Pi 4 terminal kit (RPI-1)

Status: **kit available, not verified on a real Pi** (2026-11-03). The scripts have only run in a Linux container through a dry-run test with fake `systemctl`, `ssh`, `apt-get` and similar commands, plus shellcheck. Installation, boot autostart, audio and camera on a Pi have no test record yet.

## What this is

The Mac mini keeps running the **Nous App** (Electron). The Agent, the realtime voice backend and all data stay in the App core on the Mac. The Raspberry Pi 4 is only a terminal: screen, microphone, speaker, and later a camera.

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

Other options: `--skip-apt` (no packages), `--skip-copy-id` (public key already on the Mac), `--help`. Re-running the installer converges to the same state without duplicating entries.

### Boot straight into the terminal screen

1. `sudo raspi-config` → System Options → Boot / Auto Login → **Desktop Autologin**.
2. `sudo raspi-config` → Display Options → Screen Blanking → off, so the screen does not go dark.
3. Reboot. After desktop login, the autostart entry runs `aios-session-start`, which passes `DISPLAY` / `WAYLAND_DISPLAY` to systemd and starts `aios-kiosk.service`. The kiosk waits until `http://localhost:<AIOS_PORT>/api/settings` answers before opening Chromium.

`aios-kiosk.service` is not enabled at boot because it needs a desktop session. The Raspberry Pi OS Wayland desktop does not reliably start `graphical-session.target`, so the desktop autostart entry triggers it instead. Both services use `Restart=always`, so a crash restarts them.

### Chromium flags

The kiosk uses `--kiosk --app=http://localhost:<AIOS_PORT>`, a dedicated profile (`~/.local/share/aios-terminal/chromium-profile`), and `--autoplay-policy=no-user-gesture-required` so cues and replies play without a click first. The kit does **not** use `--use-fake-ui-for-media-stream` or any other flag that auto-grants camera or microphone access. The first time the microphone is used, Chromium asks once; click "Allow" with a mouse. The choice is stored in the dedicated profile.

## Diagnostics

```bash
aios-doctor
```

Each check prints `PASS`, `WARN`, `FAIL` or `SKIP`; the exit code is 1 if anything fails. Checks: config file, SSH key and known_hosts, `aios-tunnel.service`, whether the Pi local port is listening, the core `GET /api/settings` (the core has no `/api/health`; the response body is never printed), the page `GET /`, whether the Mac SSH port is reachable, `aios-kiosk.service`, Chromium, microphones (`arecord -l`), speakers (`aplay -l`), cameras (`v4l2-ctl --list-devices`, none is only a WARN), temperature (WARN from 70 °C, FAIL from 80 °C), `vcgencmd get_throttled` (current under-voltage or throttling is a FAIL, occurred since boot is a WARN), available memory (WARN below 15%), and the default network route. Output follows `LANG`; set `AIOS_LANG=en` or `AIOS_LANG=zh-TW` to choose.

## Daily operation

```bash
systemctl --user status aios-tunnel.service aios-kiosk.service
systemctl --user restart aios-tunnel.service aios-kiosk.service
journalctl --user -u aios-tunnel.service -u aios-kiosk.service -n 100
```

If the Mac core port changes, edit `AIOS_PORT` in `~/.config/aios-terminal/terminal.conf` and restart both services.

## Uninstall and rollback

```bash
bash uninstall.sh
bash uninstall.sh --purge
```

`uninstall.sh` disables and removes both services, the autostart entry, the command links and the installed scripts, and turns linger back off if the installer turned it on. The config, key and Chromium profile stay unless you pass `--purge`. It does not remove apt packages and does not touch the Mac: it prints the command to remove the packages and how to delete the `aios-terminal@<Pi hostname>` line from the Mac's `~/.ssh/authorized_keys`. To roll back the Mac, turn off Remote Login in Sharing and comment `PORT` out of `.env` again.

<a id="known-limitations"></a>
## Known limitations (not fixed in RPI-1)

- **Memory, encrypted results and family recognition reach only the App main window.** That content travels only over the Electron main window's IPC; SSE and `/api/*` carry only the outer shell. The Pi browser page can submit tasks, see progress shells and use realtime voice, but cannot see protected result content and has no memory or family recognition features.
- **The camera is in strict mode.** The App core starts with `cameraEnable: "main_process"`: a page sending `active: true` over HTTP always gets 403. The camera can only be turned on from the App menu on the Mac, and that turns on the Mac main window's camera flow. The Pi page cannot turn on a camera over HTTP.
- **Wake listening can only be turned on from the App menu**, and it listens on the microphone used by the Mac main window, not the Pi microphone.
- **The Mac main window and the Pi page connect to the same core at the same time** (from reading the code, not confirmed on hardware):
  - SSE: the core broadcasts through a client map, so both pages receive the same task and settings events and update their own screens.
  - Realtime voice: the core allows only one call at a time (ChatGPT plan and API key routes alike). While one side is in a call, starting on the other side returns "busy" (`session_busy`, HTTP 409). Each call belongs to the page that started it, and reply audio plays only on that page.
  - Always-on wake or "look to talk" on the Mac may start a call from the Mac while the Pi is in use, taking the only call slot.
  - The forced mute on memory revocation applies only to the Mac main window.
  - Recommendation: while using the Pi, turn off always-on wake listening and the camera from the App menu on the Mac, minimise or hide the Mac window, and do not start voice from the Mac.
- The Pi runs no Agent and stores no task data. If the Mac sleeps or the App quits, the Pi screen has no core to reach; the kiosk waits until the core returns.

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
