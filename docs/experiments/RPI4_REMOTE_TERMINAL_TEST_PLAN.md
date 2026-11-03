# Raspberry Pi 4 Remote Terminal — Weekend Test Plan

Status: **experiment / not yet hardware-verified**  
Branch: `experiment/rpi4-remote-terminal`  
Architecture: **Mac mini AIOS Core + Raspberry Pi 4 Chromium Terminal**  
Goal: Move screen, microphone, speaker, and camera to the Pi while keeping Agent/Realtime backend/data on Mac mini.

## Scope / non-goals

- No migration of the full AIOS backend to ARM64.
- No modification to `main`, security guard, secrets, or existing production behavior.
- First verify existing browser mode; native macOS Electron features (secure memory IPC, native permissions, always-on wake lifecycle) are **not assumed** to work remotely.
- Do not expose AIOS directly to LAN or disable `server/http-guard.ts`.

## Hardware and prerequisites

- Mac mini: AIOS checkout, Node.js >=22.12, AIOS dependencies installed, existing authentication configured.
- RPi 4: Raspberry Pi OS **64-bit Desktop**, Chromium, OpenSSH client, preferably wired Ethernet, active cooling, reliable power.
- RPi: HDMI monitor, USB microphone, speaker/headset; USB camera only in phase 3.
- Both machines on a trusted LAN. Record Pi RAM (2/4/8 GB), OS, browser version, microphone/camera models.
- Do **not** commit `.env`, OAuth credentials, personal audio/video, or private IP addresses.

## Phase 0 — Mac mini baseline

On Mac mini:

```bash
cd /path/to/AIOS/prototype/ambient-shell
node --version
npm ci
npm start
```

Verify `http://localhost:8787` on Mac mini. Verify existing AIOS login/API/Realtime behavior before blaming Pi. Keep Mac awake during test; avoid running a second AIOS instance on port 8787. The core listens on `127.0.0.1` by design.

## Phase 1 — Pi browser + SSH local forwarding (P0)

On Pi:

```bash
sudo apt update
sudo apt install -y chromium-browser openssh-client
# On images where the Chromium package name differs, check apt search chromium.
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8787:127.0.0.1:8787 \
  <mac-username>@<mac-lan-ip>
```

Open **on Pi**:

```bash
chromium-browser --user-data-dir="$HOME/.config/aios-terminal-test" \
  --app=http://localhost:8787
```

If `chromium-browser` is unavailable, use `chromium`. SSH login must be explicitly trusted; prefer SSH keys and verify host fingerprint. Avoid `StrictHostKeyChecking=no`.

**Pass:** page loads, UI reacts, settings and text Agent work, HTTP API calls do not fail with 403 Host/Origin errors. **Fail:** blank page, browser JS exceptions, cross-origin/403 errors, disconnect loops. Record screenshots with secrets removed.

Why this works: browser sees localhost (secure context for getUserMedia); SSH tunnel forwards to Mac localhost; current HTTP guard accepts localhost hosts/origins. Tunnel is not a feature parity guarantee.

## Phase 2 — Pi audio and cloud Realtime (P0)

1. In Raspberry Pi OS, select Pi-connected USB microphone and speaker as system input/output.
2. In Pi Chromium, grant microphone permission for `http://localhost:8787` only after confirming local source.
3. Test speaker output, mic level, and AIOS audio-device selection.
4. Start a Realtime conversation. Talk continuously for 10 min, then 30 min.
5. Verify AI replies play on **Pi**, not Mac; disconnect/reconnect three times.
6. Run simultaneously a normal Mac desktop workload and note noticeable interference.

**Pass:** Pi mic captured, Pi speaker outputs, 30-min conversation without persistent dropout; no accidental Mac mic/speaker use. **Observe:** initial response latency, glitch count, CPU, temperature, memory.

Note: cloud model compute remains remote; local audio capture/encoding and browser UI consume Pi CPU. Voice authentication/session creation remains on Mac Core.

## Phase 3 — Camera, wake word, identity (P1, optional)

1. Attach USB camera to Pi; check `lsusb`, `v4l2-ctl --list-devices` (install `v4l-utils` if needed).
2. Grant camera permission in Chromium; test preview at 640x480 and 2–5 inference FPS.
3. Check if browser-mode wake word controls/runtime are actually exposed and functional; **do not** assume macOS Electron wake lifecycle is present.
4. Test 20 wake attempts from varied positions and 20 negative utterances; log misses and false positives.
5. Only if browser feature supports it, test speaker/face recognition; document missing native IPC/secure memory functionality rather than bypassing controls.
6. Test simultaneous camera + voice for 10 min; temporarily disable camera inference to isolate audio glitches.

**Pass:** camera preview, no persistent audio interruption, wake/identity outcomes explicitly recorded as PASS / FAIL / NOT SUPPORTED. No downgrade of privacy or plaintext fallback.

## Observability

Pi:
```bash
uname -m
free -h
uptime
vcgencmd measure_temp
vcgencmd get_throttled
top
```

Mac:
```bash
top -l 1 -o cpu | head -n 20
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

Use the provided report template. Take readings at idle, during Realtime, and during camera+Realtime. Record tunnel disconnections and reconnect behavior. Do not treat these targets as measured facts.

### Suggested acceptance targets

| Metric | Target |
|---|---|
| Page | Renders and accepts text requests |
| Audio | 30 min conversation, no persistent glitches |
| Mac peripheral isolation | No Mac microphone/camera/speaker captured by Pi session |
| Pi temperature | No sustained thermal throttling |
| Pi memory | No OOM; peak ideally below 85% |
| Stability | 2 h active session plus 8 h idle (if convenient) |
| Security | Core stays loopback-only; SSH host verification intact |

## Troubleshooting

- **Port already in use on Pi:** choose another Pi-local port (e.g. 18787), but note that AIOS `http-guard.ts` currently allows only configured localhost ports. Use the default 8787 for the initial test.
- **403 host/origin:** inspect Host/Origin and ensure URL is `localhost:8787`; do not disable guard.
- **Mic/camera absent:** check Raspberry Pi OS device selection and Chromium site permissions; test browser `navigator.mediaDevices` availability.
- **Realtime fails but text works:** separate auth/session/network errors from microphone permission failures; check browser console and Mac logs.
- **Audio glitches under camera load:** stop vision inference, repeat audio test, compare Pi CPU/temperature.
- **SSH drops:** confirm Mac remains awake, LAN stability, and SSH server enabled; do not use insecure public port forwarding.
- **Mac sleeping:** remote UI will lose Core; treat always-on Mac as a prerequisite, not an RPi issue.

## Rollback

On Pi close Chromium and stop the SSH command with Ctrl+C. On Mac stop AIOS with Ctrl+C. No production files, security policy, system services, or main branch are changed. Remove optional Pi Chromium test profile only if no data needs retaining.

## Next engineering decision

If Phases 1–2 pass: build a managed Pi terminal launcher (SSH reconnect, kiosk startup, device diagnostics, health status). If camera/wake/identity fail: open narrowly scoped compatibility tasks; do not start a full ARM64 backend port by default.

See `docs/experiments/RPI4_REMOTE_TERMINAL_REPORT.md` for the result log.
