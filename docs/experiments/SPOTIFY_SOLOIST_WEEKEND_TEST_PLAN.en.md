<!-- bilingual: source=zh-TW -->

> [繁體中文](SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.md) | [English](SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.en.md)

# SP-0 | Spotify Soloist × Raspberry Pi 4 Weekend Test Plan

Dates: planned for 2026-11-07–08 (Asia/Taipei). Status: **not tested; every checkbox starts open**. This plan validates the official Spotify Connect player and local diagnostics on the Pi; **Nous does not voice-control Spotify**. Architecture: [AIL / Spotify](../18_App_Integration_Layer_and_Spotify_2026-11.en.md). The existing Pi Chromium + Mac Nous proposal lives on the separate unmerged branch `experiment/rpi4-remote-terminal` (`docs/experiments/RPI4_REMOTE_TERMINAL_TEST_PLAN.md`), not in main.

## A. Prerequisites and cautions

- Raspberry Pi 4 with preferably Raspberry Pi OS 64-bit Desktop, reliable power/cooling, speakers (USB/HDMI/3.5 mm depending on hardware), Ethernet or trusted Wi-Fi. The Mac mini runs the existing AIOS Core.
- Owner's Spotify Premium Family account, access to [Spotify for Developers](https://developer.spotify.com/), an official Soloist API Key, and a Spotify app on a phone or desktop. Family members have individual accounts; this trial uses only the owner's account.
- Obtain the matching `arm64` (Pi 64-bit) or `arm32` (32-bit OS) build from [official Downloads and updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates). Builds expire 90 days from their **build date**. Never commit or redistribute the binary.
- Spotify Developer Policy prohibits unauthorized voice control of Spotify. This trial uses the Spotify app to manually select a device and start playback; CLI/WS is for read-only status and connection observation. **Do not expose Soloist as Nous model tools or send track metadata to an LLM.**
- Soloist WebSocket has **no built-in auth or TLS**; bind only to Pi loopback. SSH forwarding must also bind on Mac loopback, with no LAN endpoint.
- Never commit Spotify API keys, session data, IP addresses, accounts, playlists or identifying screenshots. Soloist `--api-key` appears in the process command line; avoid sharing `ps`, service definitions and diagnostics. Secure credential management for a future unattended service is out of scope.

## B. Phase SP-0.1: Pi base environment

```bash
uname -m
cat /etc/os-release
free -h
vcgencmd measure_temp
vcgencmd get_throttled
pactl info || true
```

Record: Pi 4 RAM ____ GB; OS ____; architecture ____; audio device ____; initial temp ____°C; throttled ____.

- [ ] Pi OS, sound output, and network are functional.
- [ ] Mac Nous continues to work unchanged; no modifications to product code on `main`.

## C. Phase SP-0.2: Start Soloist, pair via phone, output on Pi

1. Generate your own Soloist API Key in the official Spotify developer portal. Download the appropriate ARM build, extract into a Pi-only test directory, and verify the executable is named `soloist`. Run the following in **the directory containing the executable**. Do not copy actual secrets into example commands.
2. Enter the key interactively in Pi Terminal (input hidden). This trial uses an interactive shell, not an automatic systemd service.
3. Start Soloist with loopback WebSocket for read-only observation; audio should play through the Pi speaker.

```bash
chmod +x ./soloist
./soloist --version
read -rsp "Soloist API Key: " SOLOIST_API_KEY; echo
./soloist --device-name "Nous Pi Test" --api-key "$SOLOIST_API_KEY" --ws 127.0.0.1:9090
```

4. In the Spotify app on a phone or desktop on the same trusted LAN, manually find **Nous Pi Test**, select it and start music. If it fails, check [Getting started](https://developer.spotify.com/documentation/soloist) and [Authentication](https://developer.spotify.com/documentation/soloist/concepts/authentication).
5. In **another** Pi terminal, run only read-only diagnostics from the directory containing the same Soloist executable:

```bash
./soloist ctl status
./soloist ctl now
./soloist ctl now --json
ss -ltn | grep 9090
```

- [ ] The Spotify phone/desktop app discovers the Pi device.
- [ ] Playback initiated manually in the Spotify app is audible on the **Pi**, not the Mac.
- [ ] `soloist ctl status` works; `now --json` reflects playback; no playlist/account outputs are committed.
- [ ] Restart Soloist and recover using official pairing; never report false success while disconnected.
- [ ] Stop Soloist after testing, and clear the key shell variable when no further tests are needed.

```bash
unset SOLOIST_API_KEY
```

## D. Phase SP-0.3: Bidirectional Mac/Pi SSH tunnel (optional)

The existing Pi Chromium → Mac Nous route uses SSH **local `-L` forwarding**. If the Mac Core later needs to observe Pi Soloist, add **remote `-R` forwarding** in the same SSH connection. First ensure Soloist is listening on Pi loopback 9090; then run from the Pi:

```bash
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8787:127.0.0.1:8787 \
  -R 127.0.0.1:19090:127.0.0.1:9090 \
  <mac-username>@<mac-lan-ip>
```

Pi Chromium opens `http://localhost:8787` per the prior Pi test branch. Verify that the Mac has its SSH-forwarded loopback port 19090. **Do not** let a browser or model directly access this port; do not connect it to Nous tools in this phase.

```bash
nc -z 127.0.0.1 19090
```

- [ ] Pi Chromium can still access Nous through `localhost:8787` (existing Pi plan).
- [ ] Mac `127.0.0.1:19090` forwards through SSH to Pi `127.0.0.1:9090`, with no external 9090/19090 exposure.
- [ ] After SSH disconnects, the Mac observation endpoint becomes unavailable; Pi Soloist can continue independently if online.
- [ ] Mac SSH server permits remote forwarding for the authenticated user; keep SSH host-key verification and AIOS HTTP guard enabled.

## E. Measurements, failures, and acceptance

| Scenario | Pi CPU | Pi RAM | Pi temp | Throttle | Audio issue | Notes |
|---|---|---|---|---|---|---|
| Soloist idle for 5 min | | | | | | |
| Manually playing from Spotify app for 15 min | | | | | | |
| Nous in Pi Chromium + Soloist for 15 min | | | | | | |
| Network disconnect/recovery and Soloist restart | | | | | | |

Required failure records: invalid API Key, device missing from Spotify app, wrong audio output, occupied WS port, broken forwarding, undervoltage/thermal throttling, expired Soloist build. Differentiate "not executed," "unknown," and "confirmed"; do not guess.

**SP-0 PASS**: official ARM build launches on Pi 4, Spotify app discovers it and manually plays through the Pi speakers for 15 minutes, local status works, Mac/Nous remains unaffected, WS stays loopback-only, and no secrets are disclosed. **SP-0 does not prove Spotify voice control is allowed or implemented**.

**Rollback**: stop Spotify Soloist on Pi (Ctrl+C), stop the SSH tunnel (Ctrl+C), and close Pi test Chromium. Retain the original Mac Core and Pi terminal setup; do not delete Spotify accounts. If a full Soloist reset is desired, first inspect the official data/cache locations and remove manually.

## F. Weekend results template (fill only after hardware testing)

| Item | Result |
|---|---|
| SP-0.1 Environment | NOT TESTED |
| SP-0.2 Pairing, playback, CLI | NOT TESTED |
| SP-0.3 Bidirectional SSH | NOT TESTED |
| CPU / RAM / temperature measurements | NOT TESTED |
| Acceptance decision | PENDING |
| Failures / follow-up issues | Not entered |

Next gate: if SP-0 passes, start **AIL-1 (shared Registry + fake Adapter)**; separately consider **SP-1 (read-only local health and mock)**. **SP-2 Spotify voice control remains BLOCKED pending written authorization or an officially permitted path**. Save sanitized hardware evidence in separate bilingual `docs/validation/` records before claiming hardware acceptance.
