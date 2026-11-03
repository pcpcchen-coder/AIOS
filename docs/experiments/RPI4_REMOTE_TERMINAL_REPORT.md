<!-- bilingual: source=en -->

> [繁體中文](RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md) | [English](RPI4_REMOTE_TERMINAL_REPORT.md)

# RPi 4 Remote Terminal — Test Report

Template for the [weekend test plan](RPI4_REMOTE_TERMINAL_TEST_PLAN.md). Until filled in from a real Pi run, nothing here is a result.

Date: __________  
Tester: __________  
Branch / commit: __________ (kit in `terminals/rpi4/`)

## Environment

| Item | Value |
|---|---|
| Pi 4 RAM | |
| Pi OS / kernel / architecture | |
| Chromium version | |
| Mac mini / macOS | |
| Nous App version | |
| Core port (from Mac log) | |
| Connection (Ethernet/Wi-Fi) | |
| Display | |
| USB microphone | |
| Speaker | |
| USB camera | |

## Checklist

- [ ] Phase 0 Nous App works on the Mac; core port confirmed
- [ ] Phase 1 `install.sh` completed; host fingerprint matched
- [ ] Phase 1 `aios-doctor` all core checks PASS (attach output)
- [ ] Phase 1 kiosk opens after reboot without typing
- [ ] Phase 1 UI and text Agent work
- [ ] Phase 1 tunnel recovers after kill and after 30 s cable unplug
- [ ] Phase 2 Pi microphone works
- [ ] Phase 2 Pi speaker works; cues play without a click
- [ ] Phase 2 10-minute Realtime works
- [ ] Phase 2 30-minute Realtime works
- [ ] Phase 2 Mac peripherals remain unused
- [ ] Phase 2 concurrent call from Mac window: message recorded
- [ ] Phase 3 camera from Pi page: PASS / FAIL / NOT SUPPORTED
- [ ] Phase 3 wake word on Pi: PASS / FAIL / NOT SUPPORTED
- [ ] Phase 3 memory and family recognition on Pi: PASS / FAIL / NOT SUPPORTED

## aios-doctor output

Paste the full output at idle, with private IP addresses and user names removed.

## Measurements

| Scenario | Pi CPU | Pi RAM | Pi Temp | Throttled? | Mac CPU | Audio glitches | Notes |
|---|---|---|---|---|---|---|---|
| Idle 5 min | | | | | | | |
| Realtime 10 min | | | | | | | |
| Realtime 30 min | | | | | | | |
| Camera + Realtime 10 min | | | | | | | |

Tunnel recovery: after kill ___ s; after cable unplug ___ s.  
Wake word (only if supported): successes ___ / 20; false triggers ___ / 20 negative utterances.  
Audio: first response delay ___ s; dropouts ___; reconnections ___.

## Defects

| ID | Repro steps | Expected | Actual | Severity | Evidence |
|---|---|---|---|---|---|
| | | | | | |

## Decision

- [ ] GO: start RPI-2 trusted terminal pairing
- [ ] CONDITIONAL: fix specific kit or compatibility gaps
- [ ] NO-GO: revisit architecture

Reasoning: __________

Security / privacy issues: __________

Next actions: __________
