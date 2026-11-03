<!-- bilingual: source=en -->

> [繁體中文](RPI4_REMOTE_TERMINAL_TEST_PLAN.zh-TW.md) | [English](RPI4_REMOTE_TERMINAL_TEST_PLAN.md)

# Raspberry Pi 4 Remote Terminal — Weekend Test Plan

Status: **experiment / not yet hardware-verified**. Updated 2026-11-03 to use the RPI-1 Pi terminal kit.  
Kit: [`terminals/rpi4/`](../../terminals/rpi4/README.en.md) (install, services, `aios-doctor`, uninstall).  
Architecture (George, 2026-11-03): **Mac mini runs the Nous App + Raspberry Pi 4 Chromium terminal**.  
Goal: move screen, microphone, speaker, and later camera to the Pi while the Agent, realtime backend and data stay in the Nous App core on the Mac mini.

## Scope / non-goals

- No migration of the AIOS backend to ARM64.
- No change to core behaviour, `server/http-guard.ts`, secrets, or the core's loopback-only listener.
- Memory, encrypted result content and family recognition reach only the App main window over IPC; the Pi page sees the outer shell only. Camera (strict `main_process` mode) and wake listening can only be turned on from the App menu on the Mac. These are documented limitations, not test failures; see the kit's [known limitations](../../terminals/rpi4/README.en.md#known-limitations).
- Do not expose the core to the LAN or disable `server/http-guard.ts`.

## Hardware and prerequisites

- Mac mini: Nous App installed and working (sign-in, text, realtime voice), Remote Login on for your account only.
- RPi 4: Raspberry Pi OS **64-bit Desktop**, preferably wired Ethernet, active cooling, reliable power.
- RPi: HDMI monitor, USB microphone, speaker/headset; USB camera only in phase 3; a mouse for the one-time microphone permission prompt.
- Both machines on a trusted LAN. Record Pi RAM (2/4/8 GB), OS, browser version, microphone/camera models.
- Do **not** commit `.env`, OAuth credentials, `terminal.conf`, SSH keys, personal audio/video, or private IP addresses.

## Phase 0 — Mac mini runs the Nous App

1. Open the Nous App on the Mac and confirm sign-in, a text request and a short realtime call work on the Mac itself before blaming the Pi.
2. Pin the core port: in `~/Library/Application Support/Nous/.env` set `PORT=8787`, restart the App. Do not also run `npm start` from a checkout; it would take 8787 and the App would fall back to another port.
3. Confirm the actual core port:

```bash
grep 'Nous 原型已啟動' "$HOME/Library/Application Support/Nous/nous.log" | tail -n 1
lsof -nP -iTCP -sTCP:LISTEN -a -c Nous
```

4. Note the SSH host fingerprint for the Pi installer:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

5. Keep the Mac awake for the whole test. The core listens on `127.0.0.1` by design.

**Pass:** App works on the Mac; the log URL shows the port you will put in the Pi config.

## Phase 1 — Pi kit install, tunnel and kiosk (P0)

On the Pi, as the desktop user:

```bash
cd AIOS/terminals/rpi4
bash install.sh
aios-doctor
```

1. Answer the prompts (Mac user, Mac hostname or IP, Mac core port from Phase 0, SSH port). Type `yes` at the fingerprint prompt only if it matches Phase 0 step 4.
2. `aios-doctor` should show PASS for config, SSH key, tunnel service, local port, core `/api/settings` and page `/`. Record the full output.
3. Set Desktop Autologin and turn off Screen Blanking in `sudo raspi-config`, then reboot. The kiosk opens `http://localhost:<port>` full screen after login.
4. Kill the tunnel once (`systemctl --user kill aios-tunnel.service`) and unplug the Pi network cable for 30 s once; record how long until the page works again.

**Pass:** page loads in the kiosk after reboot without typing anything, UI reacts, settings and text Agent work, no 403 Host/Origin errors, tunnel recovers by itself. **Fail:** blank page, browser JS exceptions, cross-origin/403 errors, kiosk never opens, reconnect loops. Record screenshots with secrets removed.

Why this works: the browser sees localhost (secure context for getUserMedia); SSH forwards Pi `127.0.0.1:<port>` to Mac `127.0.0.1:<port>`; the HTTP guard accepts `localhost:<port>` only when `<port>` is the core's actual port, which is why both ends share `AIOS_PORT`. The tunnel is not a feature parity guarantee.

## Phase 2 — Pi audio and cloud Realtime (P0)

1. In Raspberry Pi OS, select the Pi-connected USB microphone and speaker as system input/output. `aios-doctor` should list both.
2. In the kiosk, grant microphone permission for `http://localhost:<port>` once with the mouse. The kit uses no flag that auto-grants it.
3. Test speaker output, mic level, and the AIOS audio-device selection on the Pi page.
4. On the Mac, choose "Enter service mode (for the Pi)" in the menu bar, so the Mac does not listen or take the call slot. Within 30 s the menu bar should read "Service mode: Pi connected". Run the Mac gate in the [service mode validation](../validation/service-mode-2026-11-03.en.md).
5. Start a Realtime conversation on the Pi. Talk continuously for 10 min, then 30 min.
6. Verify AI replies play on the **Pi**, not the Mac; disconnect/reconnect three times.
7. Concurrency check: while the Pi is in a call, try to start a call on the Mac window; record what happens. Expected from code reading: on the ChatGPT plan route, or on the API key route with memory rules, the second start is refused as busy (`session_busy`); on the API key route without memory, the second call silently ends the first. Then reverse the roles once.
8. Run a normal Mac desktop workload at the same time and note noticeable interference.

**Pass:** Pi mic captured, Pi speaker outputs, cues play without a click, 30-min conversation without persistent dropout; no accidental Mac mic/speaker use. **Observe:** initial response latency, glitch count, CPU, temperature, memory.

Note: cloud model compute remains remote; local audio capture/encoding and the browser UI consume Pi CPU. Voice authentication/session creation remains in the Mac core.

## Phase 3 — Camera, wake word, identity (P1, optional)

1. Attach a USB camera to the Pi; `aios-doctor` lists it (or run `v4l2-ctl --list-devices`).
2. Try to turn on the camera from the Pi page (the doctor ignores the Pi's built-in codec nodes, so it lists only real cameras). Expected from code: refused (HTTP 403) because the App core uses strict camera mode. Record PASS / FAIL / NOT SUPPORTED, and do not bypass it.
3. Check whether wake controls appear on the Pi page. Expected: wake can only be turned on from the App menu and listens on the Mac's microphone. Record the outcome.
4. Check memory and family recognition on the Pi page. Expected: not available in the browser page. Record the outcome.
5. Only if something above unexpectedly works, test it properly: 20 wake attempts plus 20 negative utterances; camera + voice for 10 min.

**Pass:** each item recorded explicitly as PASS / FAIL / NOT SUPPORTED. No downgrade of privacy or plaintext fallback. These gaps belong to RPI-2 (trusted terminal pairing).

## Observability

Pi:
```bash
aios-doctor
uname -m
free -h
uptime
vcgencmd measure_temp
vcgencmd get_throttled
top
journalctl --user -u aios-tunnel.service -u aios-kiosk.service -n 100
```

Mac:
```bash
top -l 1 -o cpu | head -n 20
lsof -nP -iTCP -sTCP:LISTEN -a -c Nous
```

Use the [report template](RPI4_REMOTE_TERMINAL_REPORT.md). Take readings at idle, during Realtime, and during camera+Realtime. Record tunnel disconnections and reconnect behavior. Do not treat these targets as measured facts.

### Suggested acceptance targets

| Metric | Target |
|---|---|
| Page | Kiosk opens after reboot and accepts text requests |
| Audio | 30 min conversation, no persistent glitches |
| Mac peripheral isolation | No Mac microphone/camera/speaker captured by Pi session |
| Pi temperature | No sustained thermal throttling |
| Pi memory | No OOM; peak ideally below 85% |
| Stability | 2 h active session plus 8 h idle (if convenient); tunnel recovers alone |
| Security | Core stays loopback-only; SSH host verification intact |

## Troubleshooting

- **`aios-doctor` FAIL on core `/api/settings`:** is the Nous App open, is the Mac awake, and does `AIOS_PORT` in `~/.config/aios-terminal/terminal.conf` equal the port in the Mac log? After editing, run `systemctl --user restart aios-tunnel.service aios-kiosk.service`.
- **403 host/origin:** the Pi local port differs from the core's actual port. Fix `AIOS_PORT`; do not disable the guard.
- **Tunnel service keeps restarting:** `journalctl --user -u aios-tunnel.service`. "Host key verification failed" means the Mac host key changed; re-run `install.sh` and compare fingerprints again. "Permission denied" means the key is not in the Mac's `authorized_keys`; re-run without `--skip-copy-id`.
- **Kiosk does not open after login:** check Desktop Autologin, `~/.config/autostart/aios-kiosk.desktop`, and `systemctl --user status aios-kiosk.service`. Run `aios-session-start` from a desktop terminal to test.
- **Mic/camera absent:** check Raspberry Pi OS device selection and Chromium site permissions (the dedicated profile is `~/.local/share/aios-terminal/chromium-profile`).
- **Realtime fails but text works:** separate auth/session/network errors from microphone permission failures and from "busy" (another call on the Mac); check the Mac log.
- **Audio glitches under camera load:** stop vision inference, repeat audio test, compare Pi CPU/temperature.
- **Mac sleeping:** remote UI loses the core; treat an always-on Mac as a prerequisite, not a Pi issue.

## Rollback

On the Pi run `bash uninstall.sh` (add `--purge` to delete the config, key and Chromium profile). It prints how to remove the apt packages and the line holding this Pi's public key from the Mac's `~/.ssh/authorized_keys`. On the Mac, turn off Remote Login and comment `PORT` out of `.env` again if you want the previous state. No core code, security policy or main branch behaviour changes.

## Next engineering decision

If Phases 1–2 pass: start RPI-2 trusted terminal pairing (see the [draft](../../terminals/rpi4/README.en.md#rpi-2-draft)) for the features that only reach the App main window. If tunnel or kiosk behaviour fails: fix the kit. Do not start a full ARM64 backend port by default.

See [`RPI4_REMOTE_TERMINAL_REPORT.md`](RPI4_REMOTE_TERMINAL_REPORT.md) for the result log.
