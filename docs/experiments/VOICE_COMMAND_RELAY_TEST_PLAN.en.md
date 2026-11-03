<!-- bilingual: source=zh-TW -->

> [繁體中文](VOICE_COMMAND_RELAY_TEST_PLAN.md) | [English](VOICE_COMMAND_RELAY_TEST_PLAN.en.md)

# VCR Voice Relay: Multi-brand Command Template × TTS Voice Experiment

Planned for 2026-11-07–08; status: **everything NOT TESTED; no recognition measurements exist**. See [design 19](../19_Voice_Command_Relay_Design_2026-11.en.md) and the [development plan](../development/voice-command-relay-implementation-plan.en.md). The initially available device is the owner's Google Home Mini; **Siri/HomePod, Alexa/Echo and XiaoAI are unverified candidates**. Spotify relay voice control remains subject to platform policies and is not an enabled product feature.

## A. Prerequisites

- Verify the target's voice-assistant locale, firmware, assistant type and media integrations. **First speak the identical command yourself** to establish a human-voice baseline. A command that fails for a human is not an informative TTS recognition test.
- Prepare an explicitly bound Mac or Raspberry Pi 4 TTS speaker at a safe distance; record distance, speaker volume and background noise for each trial.
- macOS `say` can test installed voice IDs. Its hardware routing and volume behavior need separate verification; **selecting a voice does not prove that the intended sound device is being used**.
- Do not test purchases, locks, alarms, passwords, shopping, personalized messages, Voice Match impersonation, or other actions that cannot safely be repeated. Restrict tests to low-risk commands with valid use permissions.
- Do not record audio, household voice samples, family accounts or personal playlists. Commit only de-identified measurements.

## B. Brand/command cross-check (fill after testing)

| Target / Vendor | Assistant locale | Intent | Template ID | Wake phrase tested? | Human baseline | TTS outcome |
|---|---|---|---|---|---|---|
| Google Home Mini / Google | zh-TW | `music.next` | `google.next.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |
| Google Home Mini / Google | zh-TW | `music.pause` | `google.pause.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |
| HomePod / Apple | zh-TW | `music.next` | `apple.next.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |
| Echo / Amazon | en-US | `music.next` | `amazon.next.en1` | NOT TESTED | NOT TESTED | NOT TESTED |
| XiaoAI / Xiaomi | zh-CN | `music.next` | `xiaomi.next.zh1` | NOT TESTED | NOT TESTED | NOT TESTED |

Each new candidate phrase needs its own `templateId` and version without overwriting existing measurements. Keep intent slots consistent when comparing two brands.

## C. Voice/prosody A/B matrix (fill after testing)

| Trial | Target | TTS engine | Voice ID / model version | Rate | Pitch | Gain | Wake pause | Distance | Trials | Wake OK | Command OK |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Google Mini | `macos_say` | To select | baseline | baseline | baseline | 600 ms | To measure | 0 | 0 | 0 |
| B | Google Mini | `macos_say` | Different voice | baseline | baseline | baseline | 600 ms | Same as A | 0 | 0 | 0 |
| C | Google Mini | `macos_say` | Voice A | baseline | baseline | baseline | 1000 ms | Same as A | 0 | 0 | 0 |
| D | Alexa (not owned) | TBD | TBD | baseline | baseline | baseline | TBD | To measure | 0 | 0 | 0 |

Start with **10 trials** per combination. Before selecting a default voice, consider **30+ trials** per candidate in both quiet and noisy environments. These are internal experimental goals, not statistically proven confidence or vendor guarantees. When testing voiceId, hold the phrase, distance, volume, rate and gap constant. When testing pause, fix the voice.

### Measurement formulas

```text
wakeRate       = wakeDetected / trials
commandRate    = correctCommand / wakeDetected    # when wakeDetected = 0 -> N/A
endToEndRate   = correctCommand / trials
falseWakeRate  = falseWake / negativeTrials        # when negativeTrials = 0 -> N/A
```

`correctCommand` must reflect a human-observed or independently measured action, not just Nous's declaration. Mark each trial as `WAKE_OK`, `COMMAND_OK`, `WRONG_COMMAND`, `NO_WAKE` or `UNKNOWN`. The `commandOK` count cannot exceed `wakeOK`. Retain raw counts, denominator and evidence provenance, not only a percentage.

## D. Real execution and failure scenarios

- [ ] Establish the actual device's baseline using a human-spoken command, with success/failure.
- [ ] Test wake word with TTS voice A 10 times at fixed distance, rate and pause.
- [ ] Test the same wake word with voice B 10 times, and compare.
- [ ] Test a fixed permitted low-risk command with A/B, such as harmless lighting/timer control not tied to a restricted third-party use.
- [ ] Change only `wakeToCommandPauseMs` to see whether the complete command recognition improves.
- [ ] Verify fail-closed behavior for missing target, missing voiceId, wrong locale and offline output node, with no accidental audio on another speaker.
- [ ] With Nous Realtime active, verify relay audio is not consumed as a new Nous user request.
- [ ] Validate Pi `jobId` start/end callbacks at Mac; disconnect during playback and verify `unknown` with no automatic retry.
- [ ] Change device selectedTemplateId and selectedVoiceProfileId; verify **data-only command and voice switching**, without source changes.
- [ ] Even after TTS success, AIL must return `unconfirmed`, not `confirmed`, without a separate downstream readback.

## E. Defect log and handoff

| Issue ID | Target / voice / template | Steps | Expected | Actual | Evidence | Priority |
|---|---|---|---|---|---|---|
| TBD | | | | | | |

| Gate | Status |
|---|---|
| Fake Catalog and Voice Profile tests | NOT TESTED |
| Mac real playback with selected voice | NOT TESTED |
| Google Home Mini wake + command | NOT TESTED |
| Pi 4 remote audio and acknowledgment | NOT TESTED |
| Multi-brand template lookup fixtures | NOT TESTED |
| Manual decision on default voice | PENDING |

**Suggested acceptance**: at least two candidate TTS voices tested 10 times for the same allowed low-risk intent; correct command pack resolves for each target; actual voice/output selections take effect; no fabricated success or automatic resend; raw counts support the reported rates. First validate feasibility; never treat a 9/10 recommendation as an already achieved service level.

**Rollback**: disable VCR, restore the target's previously selected voice, stop emitting relay audio, and keep Nous Core and HomeBridge unchanged. Retain de-identified trials only; do not store private speech or identities.
