<!-- bilingual: source=zh-TW -->

> [繁體中文](15_Companion_Mode_Spec_2026-10-24.md) | [English](15_Companion_Mode_Spec_2026-10-24.en.md)

<a id="companion-mode自然陪聊模式功能規格"></a>
# Companion Mode feature specification

> Status: **Design proposal / not implemented** · Version: 0.1 · Date: 2026-10-24 · Applies to: `prototype/ambient-shell` (Node HTTP/SSE + TypeScript/Vite + Electron). This document **does not establish implementation or passed hardware acceptance**.
>
> Related: [current status](Current_Implementation_Status.en.md) · [06 interaction specification](06_Ambient_Voice_Gaze_Experience.en.md) · [07 acceptance rules](07_Ambient_Implementation_and_Acceptance.en.md) · [development batches](development/companion-mode-implementation-plan.en.md)

<a id="1-產品目標與邊界"></a>
## 1. Product goals and boundaries

Companion Mode is an **optional voice interaction mode** in AIOS. While watching an LG G3 television or YouTube, gaming, or doing housework, users can comment naturally. AIOS decides whether someone in the room is speaking and whether to join in, then responds briefly at an appropriate moment. Users need not say a wake word before every sentence. Television dialogue, advertisements, and the AI's own playback must not create an automatic conversation loop.

- **Required**: User-controlled enable/disable, saved settings, local-speaker candidate assessment, low-interference responses, mutual exclusion with existing voice modes, clear capture / billing status, fail-closed behavior, and measurable hardware tests.
- **Excluded from version one**: Third-party raw-audio access to LG's built-in television microphone, DRM screen capture, television-image understanding, formal voiceprint authentication, always-on cloud streaming of raw audio, proactive smart-home control, or purchases.
- **Equipment**: LG G3 continues playing independently. A separate Mac mini microphone (prioritize XVF3800 validation) listens to the living room. Mac / external speakers answer. Television images and reference audio are optional later additions. Version one **must not pretend to see the television screen**.
- **Code foundation**: Existing `src/voice.ts`, `src/realtime.ts`, `src/live-voice.ts`, `src/main.ts`, `server/voice-settings.ts`, `server/realtime-settings.ts`, and `server/prefs-file.ts`. Mainline code determines actual integration and limits.

This differs from existing “Start voice conversation.” Existing modes start a foreground session explicitly. Companion Mode adds **local speech awareness and engagement assessment**. Changing only an LLM system prompt does not complete it.

<a id="2-使用者體驗"></a>
## 2. User experience

1. Add **Companion Mode** under “Camera and voice settings” in the macOS App menu bar. Put an immediately toggleable **Enable Companion Mode** checkbox at the top. The browser uses the existing on-demand settings view. Add no permanent sidebar / home Dashboard.
2. When the user enables it, first obtain explicit capture consent and OS microphone permission, then show “Listening” based on actual device events. The user can disable it anytime.
3. “The plot just took a sudden turn. I don't believe him” → identify a local comment → answer in one or two sentences according to activation and cooldown rules. Without program context, do not invent characters, scenes, or plot.
4. Television characters shouting “Run!”, advertisements, and the AI's own TTS should be treated as non-user or low confidence, with **no automatic response**. If quality is insufficient, remain silent and suggest wake-word mode.
5. Disabling immediately stops Companion-owned capture, inference queues, playback, and new replies. Existing background tasks remain. Do not accidentally terminate voice sessions manually started by the user.

<a id="21-模式與可操作設定"></a>
### 2.1 Mode and configurable settings

| Key | Type / options | Default | Meaning for the user |
|---|---|---|---|
| `enabled` | boolean | `false` | **Sole master switch**. When off, do not capture, recognize, or proactively respond. Restart must not silently activate it |
| `activation` | `wake` / `natural` / `active` | `natural` | Reply after wake / reply to natural comments or questions / occasionally join discussion proactively |
| `verbosity` | `short` / `normal` / `long` | `short` | Brief (one or two sentences) / normal / detailed. Explicit in-depth questions may exceed the limit |
| `cooldown_seconds` | integer, 5–60, step=5 | `15` | Minimum interval between **nonurgent automatic AI utterances**. Rules may allow direct explicit questions to bypass the interval |

- UI is in Traditional Chinese. APIs and persistence use the English enums above. `active` does not mean unlimited interruption. Without reliable context and evidence of local speech, do not comment proactively. Add a hard limit such as “at most one unsolicited utterance per ten minutes,” rather than rely only on model restraint.
- `activation=natural` may start formal interaction only after local VAD/ASR and sound-source protections pass. When prerequisites are absent, show why it is unavailable. Do not secretly upload television audio or claim natural mode is available.
- `activation=active` needs stricter context data and event-source protection. The first batch may label it “experimental / unavailable.” Do not silently degrade it to another mode.
- Start `cooldown_seconds` after **the previous reply finishes playback**. Setting changes immediately affect subsequent decisions. The off switch still interrupts the current reply.

<a id="22-啟用與真正收音是兩回事"></a>
### 2.2 Enabled preference and actual capture are separate

Keep persistent preferences separate from runtime state, following CLAUDE.md's requirement that device events determine state:

- On first installation, `enabled=false`. No microphone permission means no capture.
- On `false → true`, save settings first, then attempt capture only after capture consent and OS permission. If this fails, keep the enabled preference but show “permission missing / not capturing.” **Do not show Listening**.
- On cold start with saved `enabled=true`, enter only `armed` (enabled, waiting for “Start Companion”). **Do not open the microphone automatically**. This conservative behavior prevents inadvertent background capture. After explicit activation within the same run, capture may continue while the Electron window is hidden, but menu-bar and system microphone indicators must remain visible.
- On `true → false`, immediately force-stop the Companion session, revoke derived candidates, and prevent stale callbacks and TTS. Prioritize stopping capture even if stopping or file writes fail. Show save failures so the user knows restart may restore an unexpected value. “Pause Companion” may be offered separately but does not replace the master switch.
- Provide **Start / Stop Companion** shortcuts, visible only for `enabled=true`, so pausing does not require repeated preference changes. `stop` leaves `enabled` unchanged. `disable` saves false.

State machine: `disabled → armed → requesting_permission → listening → evaluating → responding → listening`. Any enabled state may enter `paused` / `error` or `disabled`. `enabled=false` overrides all states. Page unload, OS microphone revocation, audio interruption, or core disconnection fails closed. UI and tests must not infer capture from a checkbox.

<a id="3-架構與資料流"></a>
## 3. Architecture and data flow

```text
LG G3  ──(原電視播放；MVP 不讀取畫面)────────┐
                                            │ 客廳聲音
XVF3800／Mac 麥克風 ──► local capture ──────┘
     │
     ▼
本機 VAD → TV/AI 音訊排除與聲源信心 → 本地 ASR
     │                │
     │                └── 低信心／電視台詞 → discard
     ▼
Engagement Policy（啟用？授權？接話模式？冷卻？）
     │
     ├── 不接話 → discard / 不上傳
     └── 允許 → 已核准的文字片段送既有 AIOS 模型路由
                       │
                       ▼
                回答約束 + TTS
                       │
                       ▼
                Mac／外接喇叭
```

**Critical isolation**: Companion's background detection processes audio locally only. Unapproved raw audio and transcripts must not reach the cloud. Existing WebRTC Realtime transmits audio for the whole session and **cannot become an always-on natural-conversation recognizer without architectural changes**. The recommended MVP is local detection + local ASR + text to an already authorized model route only after policy approval. Reuse available text-response and TTS capabilities. Cloud ASR / Realtime requires separate explicit consent and renewed privacy and cost review.

AEC (acoustic echo cancellation) and sound-direction estimation are supporting features only. Without independent television reference audio, separation of nearby viewers from television sound is not guaranteed. Use **negative tests** to decide when `natural` is allowed. With high false triggering, offer explicit `wake` mode for the user to select. A prompt saying “ignore television sound” is insufficient.

<a id="31-事件與所有權"></a>
### 3.1 Events and ownership

- Only one component owns microphone / playback at a time. `companion`, `voice_conversation`, `realtime`, and `push_to_talk` cannot run two capture streams simultaneously. Manually starting another voice mode first pauses Companion, retains `enabled`, and shows the reason. Do not automatically resume capture afterward. Require explicit start again.
- Every `start` creates `session_id` + `epoch`. Sound-source assessment, LLM replies, and TTS must match the current epoch. Disable / pause increments epoch so old asynchronous results cannot revive, speak, or submit tools.
- Recognizable controls such as “turn off Companion” and “stop listening” go first to **local deterministic intent**, avoiding LLM dependence. UI, menu, and keyboard shortcuts must hard-stop even offline.
- Automatic chat must not use Agent tools to control devices, send messages, or write external systems. Explicit requests for external work return to the existing Action Gate and human confirmation. Comments without work authorization may only receive a spoken response.

<a id="4-持久設定api-與-ui-契約提議非既有端點"></a>
## 4. Persistent settings, API, and UI contracts (proposed, not existing endpoints)

Reuse `PrefsFile` atomic writes, field-by-field validation, and single-writer ownership. Add `configDir/companion.json` (`schema_version=1`, recommended mode 0600). Return preferences and **separate** runtime state in `GET /api/settings`.

```json
{
  "schema_version": 1,
  "prefs": {
    "enabled": false,
    "activation": "natural",
    "verbosity": "short",
    "cooldown_seconds": 15
  }
}
```

Proposed endpoints / events:

| Interface | Purpose | Validation and response |
|---|---|---|
| `GET /api/settings` | Add `companion.prefs` and `companion.runtime` | No audio or transcripts. Report actual capture state only |
| `POST /api/settings/companion` | Partially update four preference keys | Validate types, enums, and 5–60 in steps of 5. Unknown keys / out-of-range values return 400. Broadcast `settings.updated` only after success |
| `POST /api/companion/start` | Request activation after enablement and microphone consent | Check session owner, exclusion, permissions, and capabilities. Start never bypasses platform authorization |
| `POST /api/companion/stop` | Stop current Companion session | Repeated stop is safe and affects only owned sessions. Immediately abort local processing |
| SSE `companion.state` | `armed/listening/evaluating/responding/paused/error` | Real device/session events. Never infer fake events from toggles |

API example:

```http
POST /api/settings/companion
Content-Type: application/json

{"enabled":true,"activation":"natural","verbosity":"short","cooldown_seconds":15}
```

**Note**: This is an unimplemented API draft. Before implementation, use existing localhost / Host / Origin protections in `server/app.ts` to decide start/stop ownership checks and permissions. Disabling with `enabled=false` must synchronously block new audio processing in the UI first, and server write failures must still be reported explicitly.

<a id="41-ui-位置"></a>
### 4.1 UI placement

- macOS Electron: Reuse `desktop/settings-menu.mjs` and the rule that settings primarily live in the menu bar. Make the master checkbox directly visible. Use radio submenus for the other three settings, with **Start / Stop** and actual “Listening / Awaiting start / Unavailable” status. Existing `seconds-menu.ts` supports bool/seconds/factor, not enums. Add a tested enum row or separate Companion menu builder. **Do not disguise enums as seconds fields**.
- Browser: Show the same four fields and state in the existing **on-demand** settings view. Add no permanent settings panel.
- Reply display: Initially reuse captions and audio. Persistent text Surfaces require verified `visibility_reason`. Do not bypass `src/presentation-policy.ts` or present proactive background display as existing capability.
- Accessibility: Keyboard-operable labeled switches, readily accessible hard stop, and redraw from server-confirmed settings after updates. Failures must not leave false checked states.

<a id="5-engagement-policy-與-prompt"></a>
## 5. Engagement Policy and prompt

Models handle semantics and expression only. Deterministic local code decides these gates:

1. `enabled===true`, runtime is actually `listening`, capture has explicit consent, and audio belongs to the current session.
2. VAD / speech-source checks exclude television dialogue, AI TTS, and environmental noise. Low confidence never goes to the cloud.
3. Local ASR produces a candidate utterance. `wake` accepts explicit wake only. `natural` considers local comments / questions only. `active` additionally requires reliable, nonfabricated current context.
4. `cooldown_seconds` has elapsed and playback does not conflict. **Direct explicit questions** may bypass ordinary cooldown, but still satisfy steps 1–3 and safety rules.
5. Only approved text and context **actually available** go to the model. Unknown television titles and images remain unknown. For spoiler risk, prefer silence or respond only to known events.

Proposed model-output contract (final decision remains with the local gate):

```json
{
  "should_respond": true,
  "reply_text": "這個轉折真的很突然，我也有點意外。",
  "context_source": "user_speech_only",
  "spoiler_risk": "low",
  "confidence": 0.87
}
```

Suggested system prompt:

> You are a friend chatting naturally beside the user. Base engagement only on authorized user utterances. Prefer one or two sentences. Avoid interruptions and unnecessary long explanations. Without video images, subtitles, or plot data, never claim to see or hear a specific scene. Do not spoil plot that has not appeared. If a candidate is unclear or offers nothing worth answering, output no response. Do not activate microphones, change modes, or invoke side-effect tools yourself.

<a id="6-安全隱私與成本"></a>
## 6. Safety, privacy, and costs

- **Off by default, user-stoppable**: Turning off cuts Companion-owned MediaStream tracks and cancels timers, ASR / LLM pending work, and playback. The local side stops accepting new Companion replies. UI may briefly show “Stopping” during local shutdown, never “Listening.”
- **No hidden capture**: Actual capture events determine status. Both macOS system indicators and the App menu bar identify capture. Corrupt, missing, or incompatible settings fail closed to `enabled=false`.
- **Local first**: Raw background audio, untriggered speech, and television dialogue are not saved, logged, traced, or sent to cloud. Keep only deidentified statistical counts, such as triggers and false positives. Transcript recording requires a separate explicit opt-in.
- **Cloud and costs**: If approved text goes to cloud models, reuse AIOS route and billing explanations. Do not claim ChatGPT OAuth means free Realtime or silently enable paid audio streams. Without a valid provider or local inference service, show unavailable rather than fabricate replies.
- **Permission scope**: Affect only the owned Companion session. Disabling it cannot cancel unrelated background tasks. Full exit, disconnected speakers, expired accounts, network loss, and OS sleep/wake fail closed and require explicit recovery.
- **Family setting**: Explain that other people may be audible. Do not create family voiceprints or record others' conversations by default. Future FamilyRecorder integration requires independent consent and data isolation.

<a id="7-工程驗收未執行"></a>
## 7. Engineering acceptance (not executed)

| ID | Scenario | Required observable result |
|---|---|---|
| CM-01 | First install / unreadable settings / invalid schema | `enabled=false`. No microphone request or session |
| CM-02 | User enables but denies microphone permission | No capture. Show reason. Never show listening |
| CM-03 | Enable, disable, restart, revisit page | Preferences persist. Cold start only arms without capture. Capture starts only after another start |
| CM-04 | Disable master switch at any stage | Immediately prevent new input and old replies. Target owned capture / playback stop within 1 second |
| CM-05 | Disable after audio trigger but before model reply | Epoch discards old results. No revival or late audio |
| CM-06 | Manually start Realtime while Companion runs | One mic owner only. Companion pauses. No simultaneous recognition / TTS |
| CM-07 | Change four settings with valid, out-of-range, and invalid enum values | Valid settings persist and UI matches. Invalid values return 400 without changing other preferences |
| CM-08 | Discuss a playing program without program information | No false image claims, invented dialogue, or spoilers |
| CM-09 | Television, ads, and AI speech | No unsolicited response or TTS loop. Retain inspectable **nonaudio** decision statistics |
| CM-10 | Nearby comments, cooldown changes, direct questions | Follow cooldown policy. Direct questions still pass source and authorization gates |
| CM-11 | Offline, reload, hidden window, sleep/wake | Unexpected recovery never auto-captures. UI reflects real session state |
| CM-12 | Spoken “turn off Companion” or menu hard stop | Local stop independent of LLM / cloud. Background tasks continue |

Proposed hardware thresholds (**test targets, not achieved values**):

- In a quiet room at normal distance, at least 18 of 20 local comments are correctly recognized and handled by policy. Zero erroneous replies after the user disables the mode.
- At low, medium, and high television volumes, with at least 2 continuous hours of only television dialogue and advertisements, **fewer than 1 false proactive response per 2 hours**. Record microphone-only and TV-reference tests separately.
- Target p50 ≤2.5 seconds from an allowed short comment to AI speech start. Report device, route, and sample count.
- In negative cases such as permission denial, connection failure, and disabling during playback, zero untriggered audio uploads and zero uncontrolled restarts.

Keep unit / fixture, browser UI, Electron menu, actual XVF3800, and television playback tests distinct. `node scripts/verify-aios.mjs` verifies only the code paths it covers. It cannot establish natural-companion hardware gates.

<a id="8-不在本批次完成的擴充"></a>
## 8. Extensions outside this batch

- LG webOS control, channel / program information, and television short messages.
- AEC on TV optical / HDMI audio and echo-reference timing alignment.
- Television images, subtitles, and proactive comments with real scene context.
- Family personalization, voiceprints, long-term viewing memory, and continuous companionship across devices.

See [Companion Mode development batches](development/companion-mode-implementation-plan.en.md) for implementation steps, test scope, and delivery standards.
