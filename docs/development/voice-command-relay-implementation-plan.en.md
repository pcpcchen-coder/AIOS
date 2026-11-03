<!-- bilingual: source=zh-TW -->

> [繁體中文](voice-command-relay-implementation-plan.md) | [English](voice-command-relay-implementation-plan.en.md)

# VCR-0 to VCR-4: Voice Command Relay Development, Lookup, Voice Calibration and Acceptance

Date: 2026-11-03. Status: **engineering handoff for Claude Code; this PR contains only documentation; implementation and hardware testing have not happened**. First read [specification 19](../19_Voice_Command_Relay_Design_2026-11.en.md), [CLAUDE.md](../../CLAUDE.en.md), [current status](../Current_Implementation_Status.en.md) and the [bilingual policy](../BILINGUAL.md). Extend the actual AIL-1 in main. Do not recreate the Integration Registry, Dispatcher, Policy or HomeBridge.

## 0. Engineering boundaries and repository changes

Suggested **new paths, not assumed to exist**:

```text
prototype/ambient-shell/
  shared/voice-relay.ts
  server/integrations/voice-relay/
    target-registry.ts
    intent-catalog.ts
    command-catalog.ts
    command-resolver.ts
    voice-profile-store.ts
    voice-resolver.ts
    policy.ts
    relay-orchestrator.ts
    tts-engine.ts
    output-router.ts
    adapters/
      google.ts
      apple.ts
      amazon.ts
      xiaomi.ts
  server/integrations/adapters/voice-relay.ts
  tests/voice-relay-catalog.test.ts
  tests/voice-relay-voices.test.ts
  tests/voice-relay-audio.test.ts
  tests/voice-relay-routes.test.ts
  tests/voice-relay-policy.test.ts
```

Suggested configuration location: Nous's protected `configDir/voice-relay/` (`devices.json`, `voice-profiles.json`, `commands.json`, `trials.json`) without credentials or captured private audio. Built-in reviewed vendor templates and test fixtures may be versioned in the repo; physical household devices and chosen voices belong in user config and must not be committed with personal names, IP addresses or audio recordings. Use versioned JSON and a schema initially, not a database. Multi-user ownership segregation is a later batch.

Minimal modifications of existing files:

| Path | Change |
|---|---|
| `server/integrations/index.ts` | Register approved `voice_relay` in `KNOWN_ADAPTERS`, using existing AIL flags and `NOUS_AIL_SERVICES` |
| `server/integrations/contracts.ts` | Reuse `IntegrationAdapter` / `ToolDefinition`, do not duplicate a tool abstraction |
| `server/integrations/policy.ts` | Check permitted downstream service/action rather than only `app.spotify.*` |
| `server/integrations/schema.ts` | First batch's flat JSON Schema supports `target_id`, `intent_id` and curated slots, without `raw_text` |
| `server/config.ts`, `server/nous.ts` | Introduce default-off `NOUS_VCR=off`, data path and output node dependency; ignore model-supplied file paths |
| `src/realtime-tools.ts`, `server/live-tool-caller.ts` | Prefer existing AIL routing; both voice paths must use one Adapter, with no extra hard-coded switch |
| Electron / Pi audio frontend | Independent physical output control and `jobId` acknowledgment; only actual playback can produce `unconfirmed` |
| `src/` and shared `i18n` | Localized contextual device/voice diagnostics; no dashboard |

## 1. VCR-0: Pure Command Catalog and Voice Profile logic (first)

Build **three canonical catalogs**:
1. `intent catalog`: `intentId`, slot schema, risk class and route support.
2. `brand command catalog`: vendor/assistant/model/locale/version/intent/candidate templates/wake word/test and policy state.
3. `tts voice profile catalog`: engine, voiceId, modelId/version, locale, rate/pitch/gain, wake pause, output node/device, measured stats. Device rows reference both catalogs instead of duplicating phrases.

Conceptual API:

```ts
type ResolveResult =
  | {
      kind: "resolved";
      targetId: string;
      intentId: string;
      templateId: string;
      catalogVersion: number;
      voiceProfileId: string;
      spokenText: string;
      outputNode: string;
      outputDeviceId: string;
    }
  | {
      kind: "refused";
      reason: "unknown_target" | "unsupported_intent" | "not_reviewed" |
              "policy_blocked" | "invalid_slots" | "tts_unavailable";
    };

interface VoiceProfile {
  id: string;
  engine: "macos_say" | "browser_speech" | "local_tts";
  voiceId: string;
  modelId?: string;
  modelVersion?: string;
  locale: string;
  rate: number;
  pitch: number;
  gainDb: number;
  wakeToCommandPauseMs: number;
  leadSilenceMs: number;
  tailSilenceMs: number;
}
```

The resolver must be **deterministic**: validate target/intent/slots → lookup command by device override, then model+locale, assistant+locale, vendor+locale, explicitly compatible generic → verify policy and test status → resolve chosen voice profile → verify output node → generate speakable text. Reject missing or ambiguous same-priority matches instead of asking the LLM to guess. Multiple candidate phrases and voices may coexist, but exactly one formally selected candidate is active.

For comparing candidates, a **user-clicked diagnostic mode** may specify `candidateTemplateId` or `candidateVoiceId`; never expose these fields in the model's ToolDefinition. Read-only preview must not emit sound.

## 2. VCR-1: Fake TTS, Fake Output and Adapter

Register a `VoiceRelayAdapter` through existing AIL. Suggested tool IDs:
- `app.voice_relay.send_intent`, `effect: reversible_write`, initially `api_key`/`live` only, flat schema `target_id`, `intent_id`, `genre`, `device`, `percent` etc. All slots are curated. **Do not** expose arbitrary `spoken_text`, `wake_phrase` or `voice_id` input.
- `app.voice_relay.capabilities` (optional, read-only), only low-risk executable intents and registered target IDs, no sensitive home labels.
- `app.voice_relay.preview` (optional, read-only), command/template IDs and configuration health only; no audio or personal device labels to the model.

With Fake TTS and Fake Output, check that each target resolves its own phrase and voice. The real `execute()` must not claim a fake output is a real third-party action. Fixtures and replay must be visibly marked mock. Reuse existing `ToolResult`:
- Proven no playback: `refused` or `failed`.
- Playback interruption, timeout or lost callback: `unknown`; never auto-retry.
- Selected speaker actually finished the audio: `unconfirmed`; say “Voice command sent, but its execution is unconfirmed.”
- TTS `synthesisComplete` alone is not speaker `audioFinished`.
- `confirmed` requires independent downstream device readback, absent from this batch.

## 3. VCR-2: Mac physical playback, voice switching and visible diagnostics

First validate local macOS `say` or existing speech capabilities. **Never** concatenate model input into a shell command. Use an allowlisted executable with argument arrays and no shell (or preferably a trusted native API). Provide `listVoices(outputNode)` for supported voice IDs, locales, engine/version. If the selected voice is missing, return unsupported explicitly rather than changing voices silently. All audio must go to the **configured outputDeviceId**. If `say` cannot bind a specific device, build an output mechanism that can; do not claim a device was selected when it was not.

Suggested contextual VCR test UI, opened only via explicit settings or user request: choose target, inspect selected command pack/template, choose TTS engine/voice/rate/pitch/gain/wake pause, select physical output, click “Preview text,” “Test wake word,” “Test full command,” “Record result,” or “Use this profile.” No sound without the explicit test action. Explain audio output on first use. Localize all UI and accessibility text in both languages.

Test mode still prohibits high-risk intents, non-user-initiated use, speaker-identity impersonation and unapproved downstream service integrations. Change only one experimental variable at a time when comparing voice quality.

## 4. VCR-3: Raspberry Pi 4 remote Output Node

The separate `experiment/rpi4-remote-terminal` branch proposes Pi Chromium remote operation but **does not prove a Pi output agent is implemented**. Use authenticated SSH or an existing bound frontend connection with WebSocket/SSE and same-origin acknowledgments; do not expose a raw Core HTTP listener to LAN. For `pi_living`, Pi renderer must confirm selected output is real and emit `audioStarted`, `audioFinished`, `audioFailed`, tagged by `jobId`, `outputNode` and session-bound nonce. A Mac TTS callback does not prove Pi hardware playback.

When speaking relay commands, prevent Nous's own microphone from interpreting “Ok Google” as a new user utterance. Preserve existing user interruption and stop-voice behavior. Queue behind active Realtime replies instead of overlapping two speakers. Never recursively feed a third-party assistant's response to Nous as trustworthy execution proof.

This batch proves physical output routing, not readiness of Apple/Amazon/Xiaomi. Spotify-related downstream use remains subject to the Policy Gate.

## 5. VCR-4: Multi-brand packs and A/B evidence

Every vendor uses the same Catalog contract. Only data and explicitly needed auxiliary renderers vary; do not hard-code `if google / else alexa` in the model-facing tool. Begin with the household Google Home Mini; for Siri/HomePod, Alexa and XiaoAI, ship only disabled `candidate` templates until measured. The [hardware experiment plan](../experiments/VOICE_COMMAND_RELAY_TEST_PLAN.en.md) defines measurement.

The following must work **by changing config/catalog data alone**:
- Same intent with different command syntax/wake word per brand.
- Two models of one vendor with distinct templates.
- Different English and Chinese commands on one model.
- Each target independently selects TTS engine, voiceId, rate, pitch, gain, pause.
- Switch candidate voice, restore previous selection, fail without audio when a voice is unavailable.
- Save human-entered recognition trials and evidence, compare success rates, and trace selection decisions.

## 6. Gates, tests and rollback

| Gate | Deliverable | Objective validation |
|---|---|---|
| VCR-0 | Intent/Brand/Voice catalogs, overrides, lookup | Deterministic precedence, version validation, conflicts/misses refused, independent vendor/voice selection |
| VCR-1 | Fake TTS/Output and Adapter | Identical api_key/live schemas; tools absent when off; mock never becomes a real success claim |
| VCR-2 | Mac physical output and diagnostic UI | User chooses installed voice/device; first-run explanation; playback complete but device outcome unknown→`unconfirmed` |
| VCR-3 | Real Pi output/ack | Correct Pi speaker, no wrong Mac/Pi endpoint, disconnect/timeout→`unknown`, echo and replay protection |
| VCR-4 | Multi-brand packs and A/B measurements | At least two brand command fixtures for one intent and two independently tested voice profiles |

Suggested commands for every implementation batch:

```bash
node scripts/check-pstack.mjs
node scripts/check-bilingual-docs.mjs
node scripts/verify-aios.mjs
git diff --check
```

This PR only adds documentation; **these product verification commands have not been executed**. Each implementation should follow pstack start/step/finish in its isolated branch with truthful evidence, without interfering with other Agents on main. Rollback: `NOUS_VCR=off`, stop emitting relay audio, preserve HomeBridge and AIL. A disabled VCR must not interfere with normal Nous voice chat.

## 7. Ready-to-paste Claude Code task

> Read `CLAUDE.md`, `AGENTS.md`, `docs/19_Voice_Command_Relay_Design_2026-11.md`, and this plan. Inspect current AIL-1 and HomeBridge in main. Implement VCR-0 first without recreating Registry/Dispatcher/HomeBridge. Build multi-candidate command catalogs indexed by vendor/model/locale/intent, deterministic overrides and lookups, and per-target TTS voice profiles covering engine, voiceId, modelVersion, rate, pitch, gain, pause, output node/device, and measurement scores. Start with resolvers, JSON schema validation, fixtures and bilingual docs, followed by Fake Output; physical Mac/Pi audio is a later batch. Preserve the downstream Spotify policy gate. No arbitrary raw_command. Audio finished means only unconfirmed. Each batch reports tests, changes, untested hardware gaps and next gate. Do not merge without review.
