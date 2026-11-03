# RPi 4 Remote Terminal — Test Report

Date: __________  
Tester: __________  
Branch / commit: `experiment/rpi4-remote-terminal` / __________

## Environment

| Item | Value |
|---|---|
| Pi 4 RAM | |
| Pi OS / kernel / architecture | |
| Chromium version | |
| Mac mini / macOS | |
| AIOS Node version | |
| Connection (Ethernet/Wi-Fi) | |
| Display | |
| USB microphone | |
| Speaker | |
| USB camera | |

## Checklist

- [ ] Phase 0 Mac baseline passes
- [ ] Phase 1 SSH forwarding works
- [ ] Phase 1 UI and text Agent work
- [ ] Phase 2 Pi microphone works
- [ ] Phase 2 Pi speaker works
- [ ] Phase 2 10-minute Realtime works
- [ ] Phase 2 30-minute Realtime works
- [ ] Phase 2 Mac peripherals remain unused
- [ ] Phase 3 camera preview works
- [ ] Phase 3 wake word works / explicitly not supported
- [ ] Phase 3 speaker/face identity works / explicitly not supported
- [ ] Phase 3 camera + voice coexist

## Measurements

| Scenario | Pi CPU | Pi RAM | Pi Temp | Throttled? | Mac CPU | Audio glitches | Notes |
|---|---|---|---|---|---|---|---|
| Idle 5 min | | | | | | | |
| Realtime 10 min | | | | | | | |
| Realtime 30 min | | | | | | | |
| Camera + Realtime 10 min | | | | | | | |

Wake word: successes ___ / 20; false triggers ___ / 20 negative utterances.  
Audio: first response delay ___ s; dropouts ___; reconnections ___.

## Defects

| ID | Repro steps | Expected | Actual | Severity | Evidence |
|---|---|---|---|---|---|
| | | | | | |

## Decision

- [ ] GO: proceed to Pi terminal launcher
- [ ] CONDITIONAL: fix specific compatibility gaps
- [ ] NO-GO: revisit architecture

Reasoning: __________

Security / privacy issues: __________

Next actions: __________
