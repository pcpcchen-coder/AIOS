<!-- bilingual: source=zh-TW -->

> [繁體中文](sp-1-soloist-health-2026-11-03.md) | [English](sp-1-soloist-health-2026-11-03.en.md)

# SP-1 Spotify Soloist local health validation

Date: 2026-11-03 (Asia/Taipei). Branch: `claude/sp-1-soloist-health` (based on main `d1d50be`, after AIL-1 #86 was merged). Scope: SP-1 in [18 §6](../18_App_Integration_Layer_and_Spotify_2026-11.en.md). Weekend prerequisites are in the [SP-0 test plan](../experiments/SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.en.md).

**This batch has no Spotify voice control and no model tools.** Spotify Developer Policy III.3 forbids unauthorized voice-control integrations, so SP-2 stays BLOCKED: the Registry still refuses every `app.spotify.*` tool, and the Soloist Adapter's tool list is empty. Nous only checks whether the "Spotify player on the Pi" is usable when you open the settings page.

**Nothing here has run on a Pi, a Mac or a real Soloist.** The tests below ran in a Linux cloud container: some with an injected fake WebSocket, some against a fake Soloist WebSocket server implemented locally in Node (RFC 6455 handshake). Message formats follow the official WebSocket API documentation. The device and track names are made up.

## 1. Deliverables

All paths are under `prototype/ambient-shell/`.

| File | Contents |
|---|---|
| `server/integrations/adapters/spotify-soloist.ts` (new) | `SpotifySoloistAdapter`: connects only to `ws://127.0.0.1:<port>`; the host is fixed and the port comes only from core configuration. After connecting it sends `get_auth_state` and reads only the two booleans `logged_in` and `is_active` from `auth_state`. Events such as `playback_state` are neither parsed nor stored; `device_name` is not read; no playback command is ever sent. The tool list is empty, and any execution request returns refused |
| `server/integrations/index.ts` | `spotify_soloist` is added to the reviewed Adapters; its factory receives only core configuration |
| `server/config.ts` | `NOUS_SPOTIFY_SOLOIST_PORT` (1024–65535, default 19090). Only numbers are accepted; URLs and other values are rejected |
| `src/views.ts`, `src/main.ts`, `src/messages.en.json` | An "App integrations" section on the settings page (browser and macOS App versions): checked once when the settings page opens (not again within 30 s), with a "Check again" button, in both languages. There is no background polling and no persistent dashboard |
| `server/messages.en.json` | English for the refusal message |

### Decision rules (official WebSocket API, checked 2026-11-03)

| Situation | Display |
|---|---|
| Cannot connect (Pi offline, SSH tunnel down, Soloist not running, or the build expired and exited with code 10) | Unavailable: cannot connect |
| Connection drops after connecting but before reporting | Status unknown: the connection dropped before it reported |
| No `auth_state` within the time limit (2.5 s; the status page also has a 3 s cap) | Status unknown: no reply within the time limit |
| `auth_state` fields have the wrong types | Status unknown: the reply could not be understood |
| `logged_in` is false | Unavailable: Soloist is not signed in to Spotify |
| Signed in but `is_active` is false (official definition: Soloist is not the Connect device currently in use) | Unavailable: signed in, but not the Spotify playback device currently in use |
| The runtime has no WebSocket (a problem on the Nous side) | Status unknown: an error occurred while checking (not reported as the Pi being offline) |
| Both are true | Available: connected |

An expired Soloist exits immediately, so all Nous sees is "cannot connect". It cannot tell an expired build from one that was never started, so both are honestly reported as "cannot connect".

## 2. Tests (fixtures)

New test file `tests/integration-spotify-mock.test.ts`, 9 tests:

- Only the two booleans of `auth_state` are read; `playback_state`, oversized messages and binary messages are all skipped.
- Only `ws://127.0.0.1:19090` is contacted, only one `get_auth_state` is sent, and the connection is closed afterwards; the result contains none of the made-up track or device names.
- An error before connecting is unavailable; a drop after connecting, no reply, or an abort is status unknown; an error while constructing the WebSocket is unavailable; a runtime without WebSocket is status unknown (not reported as the Pi being offline).
- Port range checks: `ws://10.0.0.5:9090` and `22` are both rejected.
- Against the local fake Soloist server through Node's global WebSocket: signed in and the active playback device is available; signed out is unavailable (a `playback_state` in between is skipped); nothing listening is unavailable.
- Through the integration layer: zero model tools on both routes; the tool JSON contains no "spotify"; `app__spotify__play` returns `not_registered`; the status page shows the actual check with `model_tools: 0`.
- Settings page text in Chinese and English and the "Check again" button; status unknown never shows "Available"; a failed query honestly says the status could not be retrieved.

Commands and results (2026-11-03, Linux cloud, Node.js 22):

- `npm run typecheck`: pass.
- `npx vitest run`: 124 files, 2,324 passed and 5 skipped.
- `node scripts/verify-aios.mjs`: PASS; `git diff --check`: pass.

## 3. Independent review and fixes

An independent review by the same model (not a cross-model review) raised 7 items, and 5 were fixed:

- **Important**: the settings page's re-render condition did not include the integration status, so the page never updated after the query returned and stayed on "Checking…". The integration status is now part of that condition. This code is in `src/main.ts` and no automated test covers it, so step 4 of the weekend run must confirm it by eye.
- The bilingual documents and the status table were completed.
- The `is_active` false text now follows the official definition (not the playback device currently in use) instead of guessing that playback moved elsewhere.
- A runtime without WebSocket now returns "status unknown" instead of reporting the Pi as offline.
- A re-check clears the old error text.

Not fixed: the `get_auth_state` command format is inferred from the official command shape (`type: "command"`); even if it is wrong the result is unaffected, because the official documentation says `auth_state` is sent on connect. The test gaps (abort against the real server, messages that arrive after settling) are covered by the tests with an injected fake WebSocket.

## 4. Weekend validation steps on the Pi and Mac (not yet run)

Prerequisite: finish SP-0.2 first (Soloist on the Pi started with `--ws 127.0.0.1:9090`, and this Pi selected by hand in the Spotify App).

1. **Forward the Soloist port to the Mac (without changing the RPI-1 kit).** The Pi terminal kit's `aios-tunnel.service` only does `-L`. For the weekend test, open a separate `-R`-only connection on the Pi that reuses the kit's key and verified host key:

   ```bash
   source ~/.config/aios-terminal/terminal.conf
   ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
     -o UserKnownHostsFile="$HOME/.config/aios-terminal/known_hosts" -o IdentitiesOnly=yes \
     -i "$HOME/.config/aios-terminal/id_ed25519" -p "$AIOS_SSH_PORT" \
     -R 127.0.0.1:19090:127.0.0.1:9090 "$AIOS_MAC_USER@$AIOS_MAC_HOST"
   ```

   If the key file names differ from these, use whatever `install.sh` actually wrote. To forward automatically at boot, ask the RPI-1 side to add `-R 127.0.0.1:19090:127.0.0.1:9090` to the `autossh` arguments in `bin/aios-tunnel` (so one connection does both `-L` and `-R`); this batch does not change that kit. The Mac's sshd defaults to `GatewayPorts no`, so `-R` binds only to the Mac's loopback; do not open it to the network.
2. **Confirm on the Mac that the port is loopback only**: `lsof -nP -iTCP:19090 -sTCP:LISTEN` should show only `127.0.0.1:19090`.
3. **Enable SP-1**: add `NOUS_AIL=on` and `NOUS_AIL_SERVICES=spotify_soloist` to Nous's `.env` (and `NOUS_SPOTIFY_SOLOIST_PORT` if the port is not 19090), then restart Nous.
4. **Check the status**: say or type "settings" to open the settings page and look at the "App integrations" section. Record the display and PASS/FAIL for each case:
   - a. The Spotify App is playing to the Pi: should be "Available: Connected".
   - b. The Spotify App moves playback to the phone: should be "Unavailable: signed in, but not the Spotify playback device currently in use".
   - c. Stop Soloist on the Pi (Ctrl+C), then press "Check again": should be "Unavailable: cannot connect".
   - d. Stop the SSH connection from step 1, then press "Check again": should be "Unavailable: cannot connect".
   - e. Unplug the Pi's network: should be "Unavailable" or "Status unknown", never "Available".
5. **Confirm nothing leaks**: Nous's log may contain only "integration layer" status codes, with no API key, track, playlist or device name; the realtime voice tool list contains no Spotify tool (ask by voice "play some music" and Nous should honestly say it cannot control Spotify).
6. **Roll back**: remove `NOUS_AIL` from `.env` or set it to `off`, restart Nous, and stop the SSH connection from step 1.

## 5. Limits and open items

- Nothing has run on a Pi, Mac or real Soloist; none of the steps in section 4 have been done.
- "Soloist expired" cannot be told apart from "not started"; both show "cannot connect".
- `is_active` false always shows "Unavailable": a Pi on standby that has not yet been chosen as the playback device shows this too. This is the conservative choice, because the Pi really is not the playback device at that moment.
- The status appears only on the settings page (no voice query, no persistent bar).
- SP-2 (Spotify voice control) stays BLOCKED until written authorization or an officially allowed route exists.

## 6. Next gate

Run section 4 on the weekend and keep a de-identified record. Only after it passes can we claim "the Mac can see the status of Soloist on the Pi". AIL-2 (HomeBridge Facade) can start in parallel.
