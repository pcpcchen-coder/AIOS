<!-- bilingual: source=zh-TW -->

> [繁體中文](ADR-0003-local-wake-and-voice-recognition.md) | [English](ADR-0003-local-wake-and-voice-recognition.en.md)

<a id="adr-0003本機喚醒與聲音辨識"></a>
# ADR-0003: Local wake word and voice recognition

Status: **Draft (delivered with WK-00); partly implemented by WK-01a since 2026-10-31**: the always-on wake listening foundation (`AudioFrontEnd`, capture worker, preferences, automatic resume, self-trigger protection, earcon, flag `NOUS_WAKE` off by default) is implemented on branch `claude/wk-01`. **The real wake engine is not connected yet** (WK-01b); the product detector honestly reports `runtime_missing` and does not open the microphone. The Mac gate has not been run; see [WK-01a validation](../validation/wk-01a-2026-10-31.en.md). The §2.1 clauses are now written into ADR-0001. Gallery v2, `voice_probe`, and voice recognition are still unimplemented. Date: 2026-10-29, Asia/Taipei. Basis: [plan 17, local wake word and family voice recognition](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.en.md) §11.2. Engineering evidence: [WK-00 spike validation](../validation/wk-00-spike-2026-10-29.en.md). Opening this ADR is an engineering-process decision, adopted directly with George notified (plan 17 §14, "notified separately"). It is not a pending decision.

This ADR only sets rules and boundaries. WK-00 delivers only a spike that is not wired into the product (`prototype/ambient-shell/spike/wake/`). Since 2026-10-31, WK-01a has added `AudioFrontEnd` and the wake worker (`src/audio/`, flag `NOUS_WAKE` off by default), but the worker has **no real KWS engine** (WK-01b); gallery v2 and `voice_probe` still do not exist.

<a id="1-背景"></a>
## 1. Background

ADR-0001 covers the camera and face features and states that there is "no background always-on recognition". A wake word needs **an always-open microphone**, which is a new red-line surface: un-woken audio must not be written to files, enter traces, or leave the device (CLAUDE.md). Voice is also a new biometric that must share the same `person_id` and encrypted gallery as the face. Each has its own model training-data license risk, which is easier to track separately from the SFace open item in ADR-0001.

<a id="2-決定草案"></a>
## 2. Decision (draft)

<a id="21-取代與更新-adr-0001-的條文"></a>
### 2.1 Clauses of ADR-0001 that are superseded or updated

1. **Supersedes** the "no background always-on recognition" clause in [ADR-0001 §2.1.1](ADR-0001-local-family-recognition.en.md#211-核心持有資料與邏輯ipc-只做傳輸2026-10-25id-01-採用). New rules:
   - Always-on wake detection is background always-on **audio capture**. KWS runs only locally in the renderer. Un-woken audio exists only in the 2-second ring buffer of `AudioFrontEnd` and in KWS worker memory (plan 17 §5.2).
   - Voice recognition is **not** always on. It runs only inside a woken interaction (the wake segment and speech after the wake word until the connection is up), or during a call on the same stream branch when the user separately enables "recognize the speaker during calls" (plan 17 §10.3).
   - Face recognition keeps the ADR-0001 rules. Always-on audio capture does not make it always-on recognition.
2. **Updates** the naming and cloud-disclosure text in [ADR-0001 §2.4](ADR-0001-local-family-recognition.en.md#24-雲端語音): a name may be chosen from the face, the voice, or both. Names reach the cloud only as in ADR-0001 §2.4.1 (only the short sentence composed by the core). Voice features, audio segments, and the family list are not uploaded.
3. The text of ADR-0001 itself **will be edited in the implementation batches (WK-01/SP-01)**. This draft does not edit ADR-0001 first. Once this ADR is adopted and until ADR-0001 is rewritten, if the two ADRs conflict, this ADR governs always-on capture and voice, and ADR-0001 governs everything else. At the draft stage neither changes product behavior. (2026-10-31: WK-01a has written items 1 and 2 into ADR-0001 §2.1.1 and §2.4.)

<a id="22-喚醒事件無法由核心驗證"></a>
### 2.2 The core cannot verify wake events

KWS runs in the renderer, so a "wake word detected" message received by the core is only the renderer's claim. A page script can forge wake events or call `/api/realtime/start` (source `wake_word`) itself to open a real call. The core does not try to prove that a wake was genuine. It limits the consequences, following ID-02:

| Countermeasure | Rule |
|---|---|
| Rate limit | At most 3 calls started by `wake_word` per minute (same as the ADR-0001 `greeting` limit). Beyond that, listening pauses and the reason is shown (plan 17 §5.7) |
| Visibility | Reuse the existing live-voice indicator and billing explanation. Every `wake_word` call is entered in the F6 cost record (path, connected seconds, whether it ended automatically because no voice was heard, usage; missing data is marked "unknown") |
| `voice_probe` | A new op that submits a voice feature, modeled on `ambient_probe`: no management session needed, but **the response contains no result** and a rejection gives no reason. At most 4 per second with at most one pending. Accepted only while always-on listening or "recognize the speaker during calls" is on and the family recognition management screen is closed |
| `greeting` | Accepts only an interaction ID issued by the core at `/api/realtime/start` (source `wake_word`) that is unused, whose voice session actually connected and is still active, within 20 seconds of connecting, as with ID-02 `claimGreeting`. An ID invented by the page gets only a greeting without a name |
| Switch (2026-10-31, WK-01a review) | “Always-on wake listening” can be turned on only by the App main process after the native explanation: the main process calls the core's `NousHandle.wake.setListen` directly in the same process, not over HTTP and with no preload API. `POST /api/settings/wake` always answers 403 to `wake_listen: true`; the page can only record the microphone that actually listened (`device_id`) or turn listening off (turning off is always safe). The browser version therefore cannot turn always-on listening on. `POST /api/settings/camera` has the same class of issue (page scripts can turn the camera on); it is tracked as a separate known item and not changed in this batch |

<a id="23-殘餘風險如何擴大"></a>
### 2.3 How residual risk grows

ADR-0001 §2.1.1 already records that a page script can open a real look-to-talk call, submit a synthesized or obtained face feature, and read a short sentence containing a name from the IPC response on the API key path. With voice added:

1. A page script can compute voice features from a recording and send them to `voice_probe`, adding one more input for the same kind of name leak. The rate limit and "`greeting` returns only the composed short sentence" stay in place.
2. **A new kind of risk**: code in the renderer can open paid calls repeatedly with fake wakes. The rate limit, visible indicator, and cost record control it but cannot eliminate it.
3. While the always-on microphone is open, any code in the renderer could in principle read `AudioFrontEnd` audio. That matches today's `media` permission for the core-URL page, but exposure grows from "during a call" to "always on". Generated UI still must not touch preload APIs, core HTTP, or the audio module (CLAUDE.md red line), checked statically by `tests/audio-privacy.test.ts` (added in WK-01; the WK-00 spike already has the corresponding `tests/wake-privacy.test.ts`).
4. A false wake sends living-room sound to the cloud voice provider over WebRTC until the call ends. The local chime, automatic end without voice, and the rate limit shorten this but cannot eliminate it (plan 17 §5.7).
5. Voices can be recorded or imitated. This ADR provides no replay or liveness detection (plan 17 §7.4), so identity is **not** authorization. External side effects still require the Action Gate and confirmation each time (ADR-0001 §2.5).
6. **Exposure across runs**: with the automatic resume in §2.4, while the preference is on, the microphone reopens after the App relaunches and after sleep or screen lock. Users may forget that it is still listening, so exposure grows from "this run" to "until the switch is turned off". The only mitigations are the resume caption, menu bar status, minimal listening icon on the electronic brain, and the first-enable explanation in §2.4; they cannot eliminate it.

<a id="24-常駐聆聽的自動恢復george-2026-10-29-決定"></a>
### 2.4 Automatic resume of always-on listening (George's decision, 2026-10-29)

Per [plan 17 §14 ③](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.en.md#14-george-的決定2026-10-29), §5.8, and §5.3 (different from the original recommendation that a cold start only enters `armed`):

| Rule | Content |
|---|---|
| Trigger | When the preference is on and "pause listening" was not pressed in this run, listening resumes automatically after the App starts and after system sleep or screen lock. "Open the App at macOS login" is not part of this feature |
| State follows device events | Enter `armed` first. Only after `getUserMedia` succeeds, the track is `live`, and the AudioWorklet starts processing does the state become `listening_local`, and only then is "listening locally" shown |
| Resume notice | Every successful resume shows a one-time caption in the main window (existing caption component and shared localization catalog, Chinese and English) and updates the menu bar status. If the main window is hidden, the menu bar is authoritative and the caption appears the next time the main window is shown |
| Failure | Denied permission, a missing previous microphone, or a model load or hash failure all go to `error`, with the reason in the caption and menu bar. No switching to another microphone, no listening indicator, no repeated background retries |
| First-enable explanation | The explanation shown when the switch is first turned on says it "resumes automatically after the App reopens and after sleep, until you turn this switch off" (plan 17 §5.8) |
| Pause | "Pause listening" lasts only until this run ends. While paused, returning from sleep or lock does not resume; relaunching the App does. Stopping long term requires turning off the menu bar switch, and the screen says so |
| Difference from plan 15 | In [plan 15 §2.2](../15_Companion_Mode_Spec_2026-10-24.en.md#22-啟用與真正收音是兩回事) and §3.1, Companion only enters `armed` at cold start and does not resume capture after other voice modes, because it sends gated content to a model. Always-on wake detection is local only, so the rule deliberately differs (plan 17 §5.3). If the user turns the preference off during a call, listening does not resume afterward |

Exposure across runs is a residual risk (§2.3 item 6).

<a id="25-gallery-v2"></a>
### 2.5 Gallery v2

| Item | Rule |
|---|---|
| File | `userData/identity/gallery.v2.json`. Encryption follows v1: AES-256-GCM, a data key wrapped by `safeStorage`, a new key on every write, AAD bound to the header, tmp → fsync → rename → fsync directory |
| Person record | One `person_id` per person, with a face, a voice, or both (plan 17 §14 ④ allows voice-only enrollment). `face`: the v1 fields (`model_id`, `detector_id`, feature array). `voice`: `speaker_model_id` (for example `campplus-zh-cn-16k-common@<sha256>`), preprocessing version, feature arrays per enrollment, the enrollment microphone name, effective speech seconds, and enrollment time |
| Text-dependent templates | The 5 wake-word utterances spoken at enrollment are stored as `voice.keyword_templates` (same `speaker_model_id`) and used only to match the wake segment (plan 17 §4.4) |
| Calibration state | Two booleans, `calibrated_keyword` and `calibrated_utterance`, stored in the gallery settings section (not per person) with the calibration report date, sample counts, and the `speaker_model_id`, preprocessing version, and main microphone used for calibration. Both are false until the report exists. While false, voice-only evidence **does not produce a name** (plan 17 §13.3 S6, S12). **Changing the `speaker_model_id`, preprocessing version, or main microphone resets both to false**, and no name is used until recalibration |
| Model change | Every feature records its model version. A model or preprocessing change requires re-enrollment; no cross-model conversion. Mismatched features are not compared |
| Migration v1 → v2 | On the first v2 write: open v1, move each person's features to `face`, leave `voice` empty, write v2 with a new data key, delete v1 after success, and increment `key_generation`. If v1 cannot be opened (`corrupt`), do not migrate or overwrite; offer "clear all family data" as in ADR-0001 |
| Deletion | "Delete voice" removes only `voice`; "delete person" removes the whole record. Both rotate the data key (crypto-erasure), increment generations, clear the core cache, and revoke candidates and `GreetingDecision`. Memory handling follows plan 17 §9.4 and §14 ⑨ |
| Residual risk | Same as ADR-0001 §2.2: old files in Time Machine/APFS snapshots, strings in the V8 heap, no rollback protection |

During implementation, the ADR-0001 §2.4 naming text gains "may also be recognized by voice". The enrollment consent text must say that a voice can be recorded or imitated and is used only for naming, personalization, and convenience limits, not as security verification (plan 17 §11.3).

<a id="26-喚醒引擎與版本"></a>
### 2.6 Wake engine and version

- Adopt sherpa-onnx KWS (Apache-2.0), open vocabulary, no recorded samples or training needed (plan 17 §6).
- **Pin 2.0.x**, currently 2.0.1, as an exact version. WK-00 found that the 1.13.8 npm native package (`sherpa-onnx-<platform>` 1.13.8 pulled in by `sherpa-onnx-node` 1.13.8) statically links espeak-ng (GPL-3.0) into `libsherpa-onnx-c-api` as its TTS frontend. 2.0.x removed espeak-ng. Under the CLAUDE.md rule "no AGPL/GPL/NC dependencies", **1.13.8 must not become a project dependency**. WK-00 installs it only outside the repository for performance comparison. A self-built KWS-only wasm (the upstream `build-wasm-simd-kws.sh` turns TTS off) does not contain espeak-ng.
- Model candidates: `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` (Chinese and English) and `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` (Chinese). WK-00 cloud numbers are in the validation record. The final choice waits for W5 and W6 in the Mac living room.
- Runtime location follows plan 17 §10.3 option A (AudioWorklet plus wasm in the renderer). The npm `sherpa-onnx` package is a Node-only wasm (it uses NODERAWFS for file access and throws immediately in a browser), so a browser build must be self-built with the upstream script. WK-00 could not self-build it in the cloud (see the validation record). If a self-built wasm in Electron on the Mac cannot meet the plan 17 §5.6 release criteria, re-evaluate option B and design separately how to keep a single microphone owner.

<a id="3-授權查核表2026-10-29"></a>
## 3. License review (2026-10-29)

Binary platforms checked: `linux-x64` (installed and actually run) and `darwin-arm64` (2.0.1 and 1.13.8 platform packages downloaded with `npm pack`, string search only, not run).

| Item | License | How checked | Risk and handling |
|---|---|---|---|
| `sherpa-onnx-node` 2.0.1, `sherpa-onnx` (wasm) 2.0.1, platform packages `sherpa-onnx-*` 2.0.1 | Apache-2.0 | npm metadata and upstream LICENSE; no espeak-ng functions found by string search of the binaries | Usable; devDependency, exact version |
| Third-party code inside 2.0.1 (per `cmake/` at tag v2.0.1) | onnxruntime MIT; kaldi-native-fbank, kaldi-decoder, openfst, simple-sentencepiece Apache-2.0; nlohmann/json, utf8proc MIT; hclust-cpp BSD-2-Clause (LICENSE actually read); eigen MPL-2.0; asio BSL-1.0; websocketpp BSD-3-Clause; portaudio MIT | Source URLs in upstream CMake. Only the hclust-cpp LICENSE was read verbatim; the rest follow each project's published license | No GPL/NC. Eigen's MPL-2.0 is file-level weak copyleft and adds no obligation unless its source is modified |
| `sherpa-onnx-node` 1.13.8 and platform packages 1.13.8 | Labeled Apache-2.0, **but statically link espeak-ng (GPL-3.0)** | Tag v1.13.8 has `cmake/espeak-ng-for-piper.cmake` with `SHERPA_ONNX_ENABLE_TTS` defaulting to ON; both `libsherpa-onnx-c-api.so` on linux-x64 and `libsherpa-onnx-c-api.dylib` on darwin-arm64 contain symbols such as `espeak_Initialize` | **Must not be a dependency**; compared only outside the repository |
| `sherpa-onnx` (Node wasm) 1.13.8 | Apache-2.0 | The `.wasm` contains espeak-ng error-message strings; no espeak function symbols found (wasm symbols are stripped, so linkage cannot be ruled out) | Also not adopted; same conclusion |
| KWS model wenetspeech-3.3M | Model card Apache-2.0; WenetSpeech training-data terms contradict each other (plan 17 §6.2) | README inside the archive | George accepted and recorded this risk on 2026-10-29 (plan 17 §14 ②) |
| KWS model zh-en-3M | No license file or training-data statement in the archive | Archive contents | Same as above |
| Speaker models (from SP-00) | See plan 17 §7.1 | — | Same as above; SP-00 checks them in practice |
| TTS and corpora used for WK-00 evaluation (not in the product) | vits-icefall-zh-aishell3: AISHELL-3 data Apache-2.0; vits-melo-tts-zh_en: MIT; AISHELL-1: Apache-2.0; LibriSpeech: CC BY 4.0 | OpenSLR 93/33/12 pages and the LICENSE inside the archive | Downloaded only outside the repository or into gitignored folders; never committed |
| sox (microphone capture for Mac tests) | GPL-2.0-or-later | — | A standalone program the user installs with Homebrew, piping PCM into the spike. Not in package.json, not linked, not distributed. The product (WK-01) captures in the renderer through `AudioFrontEnd` and does not use sox |

<a id="4-與-claudemd-紅線對照"></a>
## 4. CLAUDE.md red-line comparison

| Red line | Handling in this ADR |
|---|---|
| Raw webcam images and un-woken audio must not be written to files, enter traces, or leave the device | Un-woken audio exists only in the 2-second ring buffer and the KWS worker. IPC carries only events and feature vectors. Traces record only time, keyword index, and whether the threshold was crossed (plan 17 §5.2) |
| Gaze only selects targets and triggers no side effects | The wake word only opens a call; it submits and deletes nothing. External side effects still go through the Action Gate |
| External side effects need the Action Gate and confirmation each time | Voice identity is not authorization (§2.3 item 5) |
| Generated UI must not get shell, file system, MCP tokens, or arbitrary network | Generated UI must not touch `AudioFrontEnd`, preload, or core HTTP; static tests |
| Capture state follows device events | "Listening locally" is shown only after the track is `live` and the AudioWorklet starts processing (plan 17 §5.1); automatic resume also enters `armed` first and shows a one-time resume caption (§2.4) |
| No AGPL/GPL/NC dependencies | Pin sherpa-onnx 2.0.x; exclude 1.13.8 (§2.6) |

<a id="5-後果"></a>
## 5. Consequences

- Always-on capture becomes a new long-duration exposure surface, controlled by the rate limit, visible indicators, the cost record, and static tests.
- The gallery moves from v1 to v2, which needs a one-time migration and its tests. The old-snapshot risk is unchanged.
- Browser KWS needs a self-built wasm, adding a build step and a binary hash to track.
- The project depends on the new sherpa-onnx 2.0.x major line (2.0.0 was released on 2026-10-23). Upgrades need their own PR and a WK-00 re-measurement.

<a id="6-待證明與下一步"></a>
## 6. Still to prove and next steps

- W5, W6, and W11 (30 family wakes, 8 hours of TV, CPU and the 80 ms loop together with the camera) can only be measured in the Mac living room; steps are in the validation record.
- Self-build the KWS wasm on the Mac with the upstream script and confirm in Electron 44.9.3 whether the AudioWorklet keeps running while the window is hidden.
- In the cloud, synthetic positives scored 0/300 hits on the full candidates for an undetermined reason. Family testing must also run the alternative pronunciation 「哈囉努斯(hā-lóu)」 and the sub-word 「努斯」 to tell whether synthetic speech or the pronunciation units for 「哈囉」 are at fault; the wake word's pronunciation units are not written into the WK-01 keyword file until settled.
- SP-00 speaker-model spike and license review.
- ~~During WK-01, write the §2.1 clauses of this ADR into ADR-0001 and create `tests/audio-privacy.test.ts`.~~ WK-01a completed both on 2026-10-31.
- WK-01b: based on George's Mac WK-00 results, self-build the KWS wasm with GitHub Actions, write the hash manifest and keyword file, and make `SherpaWasmDetector` actually load (17 §14.1).
