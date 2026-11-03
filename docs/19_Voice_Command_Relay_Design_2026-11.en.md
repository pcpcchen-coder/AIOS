<!-- bilingual: source=zh-TW -->

> [繁體中文](19_Voice_Command_Relay_Design_2026-11.md) | [English](19_Voice_Command_Relay_Design_2026-11.en.md)

# 19 | Nous Voice Command Relay (VCR): Multi-brand TTS Command Transport

Date: 2026-11-03 (Asia/Taipei). Status: **design proposal, unimplemented, without hardware acceptance**. Implementation: [VCR development and acceptance plan](development/voice-command-relay-implementation-plan.en.md). Measurements: [VCR hardware experiment](experiments/VOICE_COMMAND_RELAY_TEST_PLAN.en.md). This specification does not claim a Google Home Mini, Siri/HomePod, Amazon Alexa or XiaoAI speaker currently understands synthetic Nous speech.

## 1. Product decision and scope

**Treat audible TTS as an experimental output transport to another voice-enabled device.** Nous recognizes an intent, resolves a command template for the target vendor, model and language, selects the target's TTS voice profile (engine, voice ID, rate, volume and wake-word pause), and plays through an explicitly configured physical speaker near the third-party device. This is a **one-way driver**: audio played does not mean the wake word was recognized or that the downstream action succeeded.

**Two independent lookup tables are mandatory:**
1. `Command Catalog`: different syntax for the same intent across Google, Siri, Alexa and XiaoAI; includes versioning and overrides.
2. `TTS Voice Profiles`: configurable, replaceable and A/B-testable TTS engine, voice and prosody **per target device**; pick a winner only from actual hardware measurements, not by guessing from a voice name.

The first batch is limited to read-only template preview, manually triggered experiments and low-risk music or lighting commands. Do not allow arbitrary text-to-command, payments, smart locks, security systems, shopping, account changes or irreversible deletion. Commands requiring speaker identity (Voice Match or personal requests) must not try to bypass identity checks with impersonation or voice cloning. **Relaying Spotify voice-control commands through another speaker does not automatically remove Spotify's policy restrictions**; Spotify-targeted uses stay blocked until the applicable permission is established.

## 2. Integration with actual AIOS code

At review time, `main` already has `prototype/ambient-shell/server/integrations/{registry,dispatcher,policy,contracts,index}.ts`, `shared/integrations.ts` and both Realtime API-key and ChatGPT live voice tool routes. `server/home-bridge.ts` remains the established SmartHomeAI integration. **VCR is new**; register it through the existing `IntegrationAdapter` and do not build another Registry/Dispatcher or rewrite HomeBridge.

```text
User voice/typed -> Nous intent -> AIL Tool Registry / Dispatcher
                                  |
                    VoiceRelayAdapter (app.voice_relay.*)
                                  |
                   Target Registry -> Command Resolver
                                      |          |
                                Brand Catalog  Device Overrides
                                      |
                          TTS Profile Resolver / Engine
                                      |
                       Output Node (Mac or Pi 4) speaker
                                      | acoustic wave
                                      v
               Google Home | Apple HomePod | Amazon Echo | XiaoAI
                                      |
                           3rd-party service/device
```

Initially `app.voice_relay.send_intent` is offered via the existing AIL `supportedRoutes` for `api_key` and `live` only. Ordinary text chat and background tasks require separate caller integrations before being declared supported. Start with `NOUS_VCR=off`, and never advertise an executable tool if no physical output is configured. Provide only contextual testing/settings UI, never a launcher, fixed dashboard or replacement chat home page.

## 3. Target Registry

Every **physical device** has its own profile rather than blindly inheriting the vendor's settings:

| Field | Example | Rule |
|---|---|---|
| `targetId` | `living_google_mini` | Stable unique local ID; the model cannot invent new IDs |
| `vendor` | `google` / `apple` / `amazon` / `xiaomi` | Reviewed enumeration, extensible |
| `model` | `home_mini` / `homepod_mini` / `echo_dot` / `xiaoai_speaker` | Used in template precedence |
| `assistant` | `google_assistant` / `siri` / `alexa` / `xiaoai` | Distinguish assistant generations |
| `locale` | `zh-TW` / `en-US` / `zh-CN` | Actual target assistant language, independent of Nous UI locale |
| `outputNode` | `mac_local` / `pi_living` | Host physically emitting the command |
| `outputDeviceId` | OS audio device ID | Bind an actual sound output; no invisible default device fallback |
| `commandPack` | `google.home_mini.zh-TW.v1` | Reviewed command pack and version |
| `ttsProfileId` | `google_zh_voice_a` | Chosen voice and TTS settings |
| `enabled` / `policy` | `false` / `experimental` | Device enablement and downstream-use policies |

Before enabling, require a target configuration, a connected output node, at least one tested template and TTS profile. Otherwise return `unavailable` or `refused` without speaking through another speaker. New targets must only require registered target + pack + voice profile, not prompt edits.

## 4. **Vendor-specific command tables and lookup (mandatory)**

### 4.1 Vendor-neutral Intent Registry

| Intent ID | Validated slot types | Initial scope |
|---|---|---|
| `music.next`, `music.pause`, `music.resume` | None | Basic media transport |
| `music.play_genre` | `genre` (curated enum) | Genre |
| `music.play_artist` | `artist` (locally approved entity) | Only when downstream policy permits |
| `light.power` | `device` (registered appliance), `on` (boolean) | Paired low-risk light |
| `light.brightness` | `device`, `percent` (0–100) | Only when supported |
| `assistant.timer` | `seconds` (default 1–3600 integer) | Test by platform; never assume common support |

**Prohibit** an unrestricted `raw_command` model argument. Do not convert arbitrary phrases into service or appliance names. Add new intents in test mode to the curated catalog, then release explicitly.

### 4.2 Command Template Catalog and fields

`catalogId`, `vendor`, `assistant`, `modelMatch`, `locale`, `intent`, `templateId`, `version`, `wakePhrase`, `utteranceTemplate`, `ttsProfileHint`, `slotSchema`, `supported`, `riskClass`, `downstreamService`, `policy`, `source`, `testedOn`, `testResult`.

- The same `(vendor, assistant, model, locale, intent)` can have **multiple candidate templates** but exactly one `selectedTemplateId`. The model must not randomly choose unverified variants.
- Resolution order: **explicit device override → model + locale → assistant + locale → vendor + locale → explicitly compatible generic**. Without an approved match return `unsupported`; never guess a similar brand or switch to English silently.
- A lookup returns `{targetId, intent, templateId, catalogVersion, voiceProfileId, source, testStatus}` for audit, excluding private slot values.
- Strict slots: approved display names for device/artist/genre, no arbitrary SSML injection, control characters, embedded wake words, newlines or multi-command chaining. Bound numbers and times. The LLM cannot edit templates.
- Command language follows the actual assistant setting, not the Nous interface language.
- Apply the Policy Gate to the **downstream purpose and provider**. Calling `app.voice_relay.*` must not bypass a restriction on `app.spotify.*`.

### 4.3 Candidate matrix (**requires hardware validation**)

| Intent | Google Home `zh-TW` | Siri/HomePod `zh-TW` | Alexa `en-US` | XiaoAI `zh-CN` |
|---|---|---|---|---|
| `music.next` | `下一首歌` | `下一首` | `next track` | `下一首` |
| `music.pause` | `暫停音樂` | `暫停播放` | `pause music` | `暂停播放` |
| `music.resume` | `繼續播放` | `繼續播放` | `resume music` | `继续播放` |
| `light.power:on` | `打開{device}` | `打開{device}` | `turn on {device}` | `打开{device}` |
| `music.play_genre` | `播放{genre}音樂` | `播放{genre}音樂` | `play {genre} music` | `播放{genre}音乐` |
| Wake-word candidate | `Ok Google` / `Hey Google` | `嘿 Siri` / `Siri` (subject to configuration) | `Alexa` (possibly customized) | `小愛同學` |

These are **fixtures and test candidates**, not a manufacturer certification. Test every device, locale, firmware, assistant mode, media provider and personalization setting. A command string naming Spotify does not lift downstream restrictions; `supported=false` and `policy=blocked` override every string.

### 4.4 Illustrative JSON (conceptual; Claude must validate schema)

```json
{
  "version": 1,
  "targets": [
    {
      "id": "living_google_mini",
      "vendor": "google",
      "assistant": "google_assistant",
      "model": "home_mini",
      "locale": "zh-TW",
      "outputNode": "pi_living",
      "outputDeviceId": "usb_speaker_1",
      "ttsProfileId": "google_zh_a",
      "enabled": false
    }
  ],
  "commandPacks": [
    {
      "id": "google.home_mini.zh-TW.v1",
      "vendor": "google",
      "assistant": "google_assistant",
      "modelMatch": "home_mini",
      "locale": "zh-TW",
      "entries": [
        {
          "intent": "music.next",
          "templateId": "music.next.zh.tw.1",
          "wakePhrase": "Ok Google",
          "utteranceTemplate": "下一首歌",
          "supported": "candidate",
          "policy": "review_required",
          "downstreamService": "configured_music_service"
        }
      ]
    }
  ],
  "deviceOverrides": {
    "living_google_mini": {
      "music.next": "music.next.zh.tw.1"
    }
  }
}
```

**The sample is not enabled**. `candidate` and `review_required` cannot execute through the product tool. Validate data version, unique keys, templates, slots, provenance and policy in the core. Distinguish test candidates from released commands; the LLM must not change either state.

## 5. **TTS model / voice lookup, switching and comparison (mandatory)**

TTS is not one global voice. Each target device chooses a **Voice Profile**, and even two models from the same vendor may require different profiles. Each device can retain multiple candidates and one selected profile. Keep TTS engine selection separate from intent reasoning.

| Voice Profile field | Meaning |
|---|---|
| `id` | e.g. `google_zh_a`, `alexa_en_b` |
| `engine` | `macos_say`, `browser_speech`, `local_tts`, or future permitted provider |
| `voiceId`, `modelId`, `modelVersion` | Concrete installed voice/model and version |
| `locale` | Must match the command output; do not silently switch language when missing |
| `rate`, `pitch`, `gainDb` | Adjustable, bounded prosody and volume |
| `wakeToCommandPauseMs` | Wake/command separation, initially try 600–1000 ms; not guaranteed |
| `leadSilenceMs`, `tailSilenceMs` | Protect against truncating wake or command audio |
| `outputSampleRateHz`, `format` | Output-node compatible audio encoding |
| `outputNode`, `outputDeviceId` | Final playback location / physical sound device |
| `testedAt`, `recognitionStatsId` | Most recent measurement; mark untested honestly |

Resolution order: **device-specific selected profile → reviewed default for `(vendor, assistant, model, locale)` → explicitly enabled compatible fallback**. On missing voices, unreachable output, or sound-device contention, fail closed; never silently play out of the Mac's default speakers.

**Measure voice quality rather than guessing.** Build an A/B matrix varying TTS engine × voice × rate × wake pause × speaker distance/volume/noise. Record:
- `wakeRate = wakeDetected / trials` (observed target wakeup, not an audio-finished callback).
- `commandRate = correctCommand / wakeDetected` (`N/A` if denominator is zero).
- `endToEndRate = correctCommand / trials`.
- `falseTriggerRate` from separately defined negative/no-intent trials, not inferred from success rate.
- Device model/firmware, assistant locale, TTS engine/version, voice ID, output route, distance, volume, noise, date, and evidence type (human observation / independent device state API). **An LLM listening to its own output is not success evidence.**

In v1, the user selects a candidate voice in a contextual test page, triggers playback manually, enters PASS/FAIL/NOT TESTED, and **manually selects** the preferred profile after enough trials. Any future automatic selection requires predeclared sample-size and uncertainty criteria and must avoid adverse side effects.

## 6. Audio ownership, echo prevention and multi-node operation

- Pi 4 is a physical audio frontend; Mac mini is the Nous Core. Synthesis can be local or remote, but **the output node must acknowledge the actual audio lifecycle**. Do not assume Mac `say` outputs through a Pi speaker.
- Minimum experiment: explicitly triggered Mac-local output. For Pi, use the existing authenticated SSH or audio frontend channel and play the selected TTS output on the Pi renderer/worker. A new protocol should identify `jobId`, `targetId`, `outputNode`, `audioStarted`, `audioFinished`, `audioFailed`, timeout and cancellation. Only `audioFinished` indicates **audible-command playback finished**.
- Suppress/pause Nous's own wake/ASR ingestion of relay audio while VCR plays; retain existing user interruption and stop-voice behavior. Avoid recursively treating the downstream assistant's speech as a new Nous command.
- Only one relay command may be emitted per acoustic zone at a time. Wake and command may be synthesized separately for a known pause. Do not retry an unknown side effect automatically.
- Do not speak the normal Nous response over the same output during a relay. Initially, choose the physical output speaker and distance manually, documenting acoustic feedback and interruption behavior.

## 7. Outcome semantics and policy boundary

**Never translate `audioFinished` to AIL `confirmed`**. Report:
- `refused`: unknown command, unsupported target, missing voice/device, policy block, or missing required approval (no audio emitted).
- `failed`: proven no complete command was played (e.g. failed synthesis or playback before start).
- `unknown`: disconnect or timeout, uncertain whether speech completed or downstream command executed.
- `unconfirmed`: observed full command emitted by the selected output node, but no downstream receipt; user-facing message: “Voice command sent; execution is not confirmed.”
- `confirmed`: only with an independent, trusted readback verifying the actual downstream action; VCR v1 has no such confirmation.
- Keep AIL `reversible_write` actions idempotent at the request level. High-risk intents stay unsupported in VCR v1.

Spotify Developer Policy's voice-assistant restriction must be evaluated based on **downstream service and actual use**, not merely whether the new tool name avoids `app.spotify.*`. Apple, Amazon, Xiaomi and Google also have device, personalization and use restrictions. This design is a technical experiment, not permission for public product deployment.

## 8. Official references and update rules

Verify current commands, supported markets, assistant generations and terms before enabling a vendor pack; candidate phrases are never hardware proof:
- [Google Home voice-control documentation](https://support.google.com/googlehome/answer/7207759?hl=zh-Hant) and [music](https://support.google.com/googlehome/answer/7030379?hl=zh-Hant).
- [Apple Siri on HomePod (Taiwan)](https://support.apple.com/zh-tw/guide/homepod/apd414437fc9/homepod).
- [Amazon Alexa Help](https://www.amazon.com/gp/help/customer/display.html?nodeId=202199210) (verify specific device and market).
- [XiaoAI Open Platform](https://developers.xiaoai.mi.com/) (verify device and market).
- [Spotify Developer Policy](https://developer.spotify.com/policy), especially voice-enabled control in III.3.

VCR remains an optional transport within AIL. Separately versioned vendor command tables and TTS profiles let Nous add brands and improve measured voice recognition without changing tool names or the reasoning layer.
