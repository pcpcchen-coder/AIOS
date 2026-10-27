<!-- bilingual: source=zh-TW -->

> [繁體中文](ADR-0001-local-family-recognition.md) | [English](ADR-0001-local-family-recognition.en.md)

<a id="adr-0001本機家人辨識的資料生命週期與-runtime"></a>
# ADR-0001: Local family recognition data lifecycle and runtime

Status: **Proposed**. George decided most items in §9 on 2026-10-25. The detector is finalized (YuNet 2023mar 640), while SFace training-data risk remains undecided. Date: 2026-10-24. Sections §2.1, §2.2, and §10 were revised for ID-01 on 2026-10-25. The same day, ID-02 revised §2.1.1, §2.4, §6, §9 and added §11. Batches: ID-00, ID-01, ID-02 in [plan 14](../14_Family_Recognition_and_Greeting_Plan_2026-10.en.md).

ID-00 is a runtime spike disconnected from product flows (`prototype/ambient-shell/spike/face/`, measurements in the [validation record](../validation/family-id-00-spike-2026-10-24.en.md)). ID-01 (2026-10-25, branch `claude/family-id-01`) implements enrollment, deletion, encrypted storage, local recognition only inside the menu-opened “Family recognition” screen, and quality / invalidation states. It has cloud validation only, **no Mac hardware results, uncalibrated thresholds, and no named greetings**. See [ID-01 validation](../validation/family-id-01-2026-10-25.en.md). George tested ID-01 on Mac on 2026-10-25: enrollment, trial recognition, and palm stop worked. This was verbal reporting, without numerical repo evidence. ID-02 (2026-10-25, branch `claude/family-id-02`) integrates look-to-talk: concurrent recognition during facing wait, interaction binding, a core-selected opening from a fixed list (such as “George, I'm here,” “Good morning, George,” or “I'm here”), and core-controlled content on both voice routes. **Only cloud fixture validation exists. Thresholds remain uncalibrated. Actual audio (14 I12) awaits Mac tests.** See [ID-02 validation](../validation/family-id-02-2026-10-25.en.md) and §11.

Numbering: This is the first ADR in this repo's `docs/adr/`. ADR-001–005 in [08](../08_Consolidation_and_Update_2026-10.en.md) were proposal labels, without repo files. ADR-0002 and ADR-0005 referenced by [11](../11_Stereo_Camera_Interaction_2026-10.en.md) belong to another repo (this-is-yourX). These are separate numbering sequences.

<a id="1-背景"></a>
## 1. Background

Plan 14 calls for “George, I'm here” when a reliably recognized, voluntarily enrolled family member approaches and starts interaction through look-to-talk, or “I'm here” when unknown. Recognition runs concurrently with the existing facing delay without extending it (14 §2).

This requires three currently missing pieces:

1. Local face detection, alignment, and feature models running in the Electron renderer without blocking the existing 80 ms sensing loop.
2. Storage and deletion rules for sensitive identifying data. Face features can identify people even without photographs.
3. Data flow consistent with CLAUDE.md red lines: raw images never reach files, traces, or external services. Identity never becomes authorization.

The prototype currently uses MediaPipe Pose and gesture models with `numPoses: 1`. That cannot prove only one person is visible (14 §5), and provides no face boxes or landmarks.

<a id="2-決定草案"></a>
## 2. Decision (proposed)

<a id="21-管線"></a>
### 2.1 Pipeline

```
AR0144 左眼 1280×720（沿用 SensePipeline 已開的串流，不第二次開鏡頭）
  │ 只在 renderer 記憶體
  ▼
人臉偵測（YuNet 或 MediaPipe Face Detector，§6 依 spike 數據）→ 臉數、框、5 點
  │ 品質檢查：單一臉、臉寬 ≥ 起點 100 px、分數、正面程度
  ▼
SFace 對齊（5 點 similarity transform → 112×112）→ 128 維特徵，L2 normalize
  │ 只有特徵向量離開推論 worker；像素張量用完即丟
  ▼
核心比對（Electron 主程序，經 IPC，不走 HTTP）
  │ 解密登記特徵只在記憶體；cosine 對每位家人取最大值
  ▼
IdentityObservation { state: matched | unknown | ambiguous | unavailable,
                      person_id?（只有 matched）, track_generation, observed_at, model_version, gallery_version }
```

- Inference runs in a dedicated renderer worker because pixels already live there. Sending images to main over IPC would add another image channel.
- Enrollment features (gallery) never reach the renderer. The renderer sends current features, and the core returns state, with person ID only for matched. Generated UI or frontend errors therefore cannot read every family's features.

<a id="211-核心持有資料與邏輯ipc-只做傳輸2026-10-25id-01-採用"></a>
#### 2.1.1 Core owns data and logic; IPC transports only (adopted for ID-01, 2026-10-25)

Two options were compared:

| | Option A: Core-owned (adopted) | Option B: Main process (`desktop/main.mjs`) owns it separately |
|---|---|---|
| Gallery, matching, evidence rules, name validation | Core TypeScript (`server/identity-service.ts`, `identity-store.ts`). The core already runs in Electron main (`main.mjs` imports `server.mjs` and invokes `startNous`) | Untyped code in `main.mjs` or adjacent `.mjs` |
| Tests | vitest directly tests the core with fake SecretBox + real AES-GCM, fake clocks, and log spies | Requires Electron mocks. Linux cloud can only run `node --check` |
| Settings and menu | Core computes `settings.identity` (state and count only), shared by menu and page | Main assembles separate state from core settings |
| IPC surface | One `nous:identity` channel, op allowlist and shape filtering, forwarding to `core.identity.handle` | One channel per feature, mixing transport and logic |
| Drawback | Core restart invalidates sessions; reopen the screen through the menu | — |

Implementation:

- Add `identity: { dir, secretBox, excludeFromBackup, confirm, modelDir }` to `startNous`. Only macOS App injects it. Browser (`npm start`) does not, and `settings.identity` says “unavailable in browser.”
  - `secretBox`: `main.mjs` implements through `safeStorage`. `available()` requires `darwin`, `isEncryptionAvailable()`, and a backend other than `basic_text`.
  - `confirm`: Native `dialog.showMessageBox`. The core invokes it for enrollment consent (including parental confirmation for minors), deletion, and clear-all. Files are written only after true. Renderers cannot forge it. This implements CLAUDE.md's Action Gate and explicit current confirmation for permanent deletion.
- **Identity data does not use loopback HTTP.** `server/app.ts` has no feature, person-ID, or name routes. `identity` in `GET /api/settings`, SSE `hello`, and `settings.updated` contains only menu fields `available`, `disabled_reason`, and `limited_reason` (camera/model restrictions). Counts, generations, and gallery state reach session-open pages only through IPC (2026-10-25 review).
- **Thin IPC**: Preload adds only `nousDesktop.identity(request)` through `ipcRenderer.invoke("nous:identity")`. Main checks `event.sender === win.webContents`, `event.senderFrame === sender.mainFrame`, and a frame URL beginning with the core URL. Pure `desktop/identity-ipc.mjs` then filters allowed ops and field shapes, dropping extra fields before forwarding to core. Semantic validation, including normalization, names, count, and consistency, belongs to core.
- **Management session**: Only within 10 seconds after the user clicks “Family recognition…” in the menu may the main window's local-core page open a session. Main records the click and consumes it once at `open_session`. Voice or page scripts opening without a menu click get `not_user_initiated`. Only one session exists. Dismissal, 10 minutes idle, 15 minutes open, main-window `did-navigate` including reload, `render-process-gone` through `closeSessions`, or core `shutdown` invalidates it. Probe, enrollment, and deletion require a valid session, limited to 6 requests per second per session.
- **Core restart and concurrency**: Shutdown first enters a closing state. Pending native confirmations never write afterward. Enrollment, deletion, and clear-all permit only one mutation at a time, avoiding stacked dialogs and stale deduplication. Before writes, disk `gallery_version` must match memory or reject `stale_gallery` rather than overwrite with old data.
- **No persistent background recognition**: ID-01 recognition runs only during trial recognition or enrollment sampling in its screen. ID-02 adds look-to-talk recognition (§11), sampling only during facing dwell and from interaction start until greeting decision. Absence, looking away, leaving near range, or camera-off stops it. Core accepts `ambient_probe`, `ambient_status`, and `greeting` without a management session only when look-to-talk, greet-first, and named-family-greeting settings are all on, the camera is on, model hashes match, and management UI is closed. `greeting` additionally requires a core-issued interaction ID bound to a genuinely connected voice session (§2.4.1).
- **Matching in core**: Responses contain no similarity scores. A person's score is the maximum cosine over their samples. The best score must meet `match` and lead the second by `margin` for that frame to identify a person. Close scores are ambiguous, low scores unknown. Match only compatible model and preprocessing versions (detector / recognizer / align / preproc), marking incompatible people `needs_reenroll`. Evidence rules in `shared/identity.ts` `decideIdentity` then require at least 3 frames over at least 500 ms in the same sampling generation, all identifying the same person, with the newest within 1 second. **Unknown and ambiguous results require the same evidence; until then return neutral collecting.** A single frame cannot probe enrollment (2026-10-25 review). Clear on interframe gaps over 500 ms or generation, `epoch`, or `gallery_version` change. Multiple faces are always ambiguous, without selecting the largest. Insufficient quality is unavailable.
- Record the threat surface honestly:
  - Management session (ID-01): Any renderer code, including generated UI if it crosses its boundary, can probe during a session. Repeatedly sending a face for 3 or more frames can still reveal enrollment through stable results. Mitigations are menu-initiated sessions, duration caps, rate limits, no scores, accumulated evidence for gallery-related responses, and duplicate enrollment returning only “may already be enrolled,” without naming whom.
  - Look-to-talk (ID-02, after independent review fixes on 2026-10-25): `ambient_probe` requires no session but returns no results or rejection reasons. `ambient_status` reports only sampling availability. Only `greeting` can return names, accepting only an interaction ID **issued by core at `/api/realtime/start` with look_to_talk source, unused, bound to a genuinely connected voice session (API key: SDP exchanged; live: sideband connected), still active, within 20 seconds of connection**. Limit 2 per second and 3 per minute. Invented page IDs get only “I'm here.” Before review, `ambient_probe` plus `greeting` could map arbitrary features to names, effectively a sessionless lookup.
  - **Residual risk**: Page scripts can call `/api/realtime/start` with look_to_talk themselves, genuinely starting realtime voice (microphone on, “Realtime voice” indicator, route-dependent billing), then submit synthetic or externally obtained features. API-key IPC can return a composed sentence with a name, at most once per session and 3 times per minute. ChatGPT-plan pages do not receive the sentence directly, but spoken transcripts return as captions. Removing this API-key exposure requires core-sent `response.create` (§11). Generated UI is already forbidden from preload APIs and core HTTP by CLAUDE.md.
- On deletion, clear-all, or screen dismissal, core clears evidence and increments `epoch`. The page stops sampling, terminates workers and model/temp data, drops in-memory samples, and increments sampling generation. Mismatched late results are discarded.
- Initial enrollment limit is 2–5 family members (14 §5). Reject excess enrollment without automatic replacement.
- Sample about 4 Hz, at most one pending inference. Results carry tracking generation, and mismatches are discarded (14 §3, §4).

<a id="22-資料生命週期"></a>
### 2.2 Data lifecycle

| Stage | Location | Retention | Rule |
|---|---|---|---|
| Raw frames | Renderer memory in existing canvas | One inference | No files, traces, cloud, or core transport. Convert read pixels only into inference tensors and release afterward |
| Aligned 112×112 tensor | Inference-worker memory | One inference | Same rules. Enrollment does not retain aligned images either |
| Current features | Worker → renderer main thread → IPC → core memory | Until matching completes | No logs. Traces contain only state and duration |
| Enrolled features (gallery) | Core encrypted file | Until user deletion or disablement | See §2.3 |
| Recognition results | Core memory, bound to tracking generation | About 1-second freshness (14 §4) | Only `matched` carries person ID. Revoke on person replacement, camera-off, or tracking break |

**Traces and logs**: No trace, log, error report, SSE event, or validation evidence may include vectors, `person_id`, names, or similarity values. Only state (`matched` / `unknown` / `ambiguous` / `unavailable`), duration, model version, and generation may be logged. Inspect extra debugging information in local memory without writing files.

**Enrollment**: Explicit user initiation from unlocked, administrable local settings, with chosen name and multiple-angle samples (14 §5). Saying “I am George” to the camera cannot overwrite enrollment. Save features only, never photos. Every enrolled person must be present, hear the explanation, and consent, without enrollment by proxy. They may request deletion anytime. Minors may enroll while present, with parent George confirming consent during enrollment (decision on 2026-10-25, §9).

**Feature storage**: One record per family member includes `person_id`, speakable name, multiple feature vectors, `model_id` such as `sface-2021dec@0ba9fbfa…`, `detector_id`, alignment version, creation/update times, and `gallery_version`. Treat features as sensitive identifying data, not anonymous. Model or preprocessing changes require reenrollment. Do not mix old features or transform across models.

**Matching**: Only `active` records with matching `model_id`. Calibrate thresholds with held-out non-enrollment samples and strangers rather than directly using OpenCV's example 0.363 (14 §4).

**Disable / delete**:

- Disable retains records without matching and increments `gallery_version`.
- Delete removes all features and names for that person from the encrypted file and **rotates the data key (crypto-erasure)**. Generate a new key, reencrypt remaining records, atomically replace the file, then zero the old key Buffer. Increment `gallery_version` and `key_generation`. Keep no recoverable deleted copy.
- **Wrapped key and ciphertext share one file** (ID-01, 2026-10-25): `userData/identity/gallery.v1.json` (0600, directory 0700) contains `wrapped_key`, `nonce`, `tag`, `ciphertext`, and header. AES-256-GCM uses random nonces, with AAD binding the header including `wrapped_key`. Every enrollment/deletion write rotates the key. Write tmp (0600) → fsync → rename → directory fsync. Startup clears interrupted tmp files. A single file atomically replaces key and ciphertext together, avoiding a new-ciphertext/old-key intermediate state. The cost is that snapshots also retain the old wrapped key (see backups below).
- **Load only at first session open**: Startup and `GET /api/settings` touch neither Keychain, directories, nor `tmutil` (2026-10-25 review). If safeStorage becomes available later, load the existing gallery before permitting writes, avoiding replacement with only newly added members.
- Distinguish unlock failures: **`key_unavailable`** means SecretBox cannot unwrap the key, such as denied Keychain access. Allow retry, explain permission/restart, and offer no clear action. **`corrupt`** means invalid format, tag not 16 bytes, GCM failure, or corrupt content. **Never overwrite or fall back to plaintext**. Offer only native-confirmed clear-all. A modified wrapped key also appears as `key_unavailable`.
- Validate each loaded vector: 128 dimensions, finite values, ‖v‖≈1. Mark invalid people as corrupt data, visible and deletable but excluded from matching.
- **No rollback protection**: Replacing the gallery with an old complete file is accepted if the same application key still unlocks it, potentially restoring deleted people. Prewrite `gallery_version` checks prevent two local cores overwriting each other, not file replacement.
- Residual risks: The safeStorage application key does not rotate. Old galleries in Time Machine or APFS snapshots may still decrypt on the same Mac, reproduced with a substitute in `tests/identity-store.test.ts`. safeStorage uses strings, leaving base64 data keys and decrypted JSON in the V8 heap until garbage collection, without explicit zeroing.
- Both disable and delete immediately clear decrypted core gallery caches, revoke candidates and `GreetingDecision` for that person, and increment tracking generation so late inference/match results are rejected.
- Camera-off, degraded sensors, and model errors also clear candidates and increment generation (14 §3, I5, I8, I9).
- Backups and snapshots retain **old encrypted files**. Key rotation alone is insufficient if snapshots also retain wrapped data keys and Keychain retains the application wrapping key. Old galleries can still decrypt. Therefore:
  - Data keys ideally reside somewhere truly deletable outside file snapshots. safeStorage necessarily places wrapped keys in `userData`; Time Machine exclusion (`tmutil addexclusion`) reduces risk, while APFS local snapshots may persist. Direct local-only, nonsynced Keychain data-key items can be deleted on rotation for stronger crypto-erasure. George selected safeStorage initially on 2026-10-25 (§9).
  - Deletion explanations must state that new data cannot restore deleted entries, while recoverability in preexisting backups and snapshots depends on the key-storage method above.
  - Exclude encrypted files themselves from Time Machine too, reducing old ciphertext copies.

<a id="23-加密金鑰"></a>
### 2.3 Encryption keys

- **Candidate: Electron `safeStorage`**. Desktop core already runs in Electron main (`desktop/main.mjs` loads `server.mjs`) and can call it directly. On macOS, safeStorage encrypts with an application key in Keychain. Generate a random data key, wrap with `safeStorage.encryptString`, save it, and encrypt the gallery with AES-256-GCM. Rotate data keys on person deletion (§2.2), recording `key_generation` in the header.
- **Alternative: Store data keys directly in macOS Keychain items**, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, without iCloud synchronization. Delete old items during rotation, leaving old-snapshot ciphertext without a usable key. Requires native modules and signing. Deferred by the 2026-10-25 decision (§9).
- If `safeStorage.isEncryptionAvailable()` is false, create no gallery, show recognition unavailable, and do not fall back to plaintext.
- **Browser (`npm start` + ordinary browser) lacks equivalent protection**: Core is plain Node without Keychain binding. Explicitly disable recognition there, retaining conversation and look-to-talk.
- George selected safeStorage without a native Keychain module on 2026-10-25 (§9).

<a id="24-雲端語音"></a>
### 2.4 Cloud voice

- **The greeting itself** sends just one short sentence such as “George, I'm here,” without images, features, similarities, or lists of other family members. Once spoken, however, the name can appear in cloud context like other conversation content: model transcripts, ChatGPT-plan delegation requests to Codex with recent transcripts (§2.4.1), and possibly model-written task titles (table below). Do not claim cloud receives only the sentence.
- **Disclosure and consent (independent review, 2026-10-25)**: Data explanations and enrollment consent in Family recognition state that named greetings send names in a short sentence to the cloud voice provider (ChatGPT plan or OpenAI API key), switchable off in settings. A one-time notice records “seen” in `identity/cloud-naming-notice.v1.json` (version/time only, no names, unencrypted, 0600). Write only after saving enrollment consent or pressing “I understand” in Family recognition (`ack_naming`, requiring management session). **No named greeting until seen** (`notice_unseen`), only “I'm here.” Existing ID-01 enrollees who have not seen it get the notice and button when opening the screen.
- “Address recognized family members in greetings” (`look_to_talk_greet_name` in camera.json, default on, George 2026-10-25): when off, greetings say “I'm here,” and look-to-talk does no recognition because naming is ID-02's sole recognition purpose. This setting is new in ID-02; ID-01 never saved naming preferences. If disabled after decision but before live consumption, core substitutes “I'm here” without restoring the name.
- Core obtains names from managed profiles, validates enrollment `parseFamilyName`, then `speakableName`: letters, combining marks, digits, and common name spaces, middle dots, periods, apostrophes, and hyphens only. A denylist rejects instruction-like words (ignore, instructions, system, prompt, and Chinese equivalents). This is best effort, not complete protection. Invalid names fall back to “I'm here” (14 §6, I11). Arbitrary client text cannot become names or content.
- **Choose openings from a fixed list** (George requested variation on 2026-10-25): `GREETING_TEMPLATES` in `shared/sense.ts`. Named: “George, I'm here,” “Hi, George,” “George, hello,” “I'm here, George,” plus local-time “Good morning / afternoon / evening, George.” Unnamed: “I'm here,” “Hi, I'm here,” “Hello,” and time-specific greetings. Use this computer's timezone, as in `server/home-bridge.ts`: morning 5–11, afternoon 11–18, evening after 18 (avoid the Chinese goodnight farewell), none at 0–4. Core `server/greeting-picker.ts` chooses randomly, avoids the previous template in memory, and logs template IDs only. All are short statements, not questions or freely generated text. Names still pass `speakableName`. Put the chosen sentence into fixed instructions requiring verbatim delivery, no additions, questions, guessed names, or claims to see the user. Models may still rewrite. Instructions alone cannot pass acceptance; inspect actual transcripts and audio (14 §6, I12).

<a id="241-姓名出現在哪些行程id-022026-10-25"></a>
#### 2.4.1 Processes where names appear (ID-02, 2026-10-25)

| Location | API-key route | ChatGPT-plan (live) route |
|---|---|---|
| Core (`startNous` inside Electron main) | Read gallery name, validate, compose | Same, plus temporarily retain composed text in memory, consumed once within 3 seconds for the same interaction |
| IPC response → renderer page | **Yes**: `greeting` returns current `instructions` including “George, I'm here.” Page immediately submits through `response.create` over WebRTC data channel, without saving or logging | **No**: IPC returns `text: null`. Page then posts `kind: "greeting"` to `/api/realtime/input`, containing only interaction ID |
| Loopback HTTP | Not involved | Interaction ID only. Core retrieves the sentence bound to that live session and sends through sideband. Page text is never the content |
| Voice provider | `response.create` instructions | `session.context.append` speakable |
| Renderer captions | Model transcript through `onAssistantTranscript` displays “Nous: George, I'm here,” already audible to the user, same on both routes | Same |
| Delegated Codex request | No corresponding context: model calls tools itself; `delegate_task` carries title only, no transcripts | **The greeting entry is masked** (George 2026-10-25): `LiveCall` records the core sentence. If the first subsequent assistant transcript matches it, including punctuation variation or interrupted prefix through `isGreetingTurn`, mark it `greeting` in the buffer. `requestText` skips it when appending the latest 8 entries. **Only that greeting entry** is masked. User-provided names (“write a letter for George”) and names in later model answers remain and reach Codex (OpenAI). If the first reply differs, no greeting tag is applied |
| Task titles and persistence | **No additional handling**: Models may put conversational names, such as user-provided names outside greetings, in `delegate_task` titles. Tasks persist as local JSON and go to the execution engine | Same, with Codex choosing titles |
| Logs / traces | Core logs decision reasons, generation, and evidence counts only. Page `[看著說話時序]` timing contains milliseconds only. Existing ChatGPT-plan delegation logs include the first 40 request characters as `preview`, potentially containing user/model-provided names | Same |

**API-key tradeoff**: Keeping names entirely outside the renderer requires core access to that WebRTC call's control plane, via an additional server-side OpenAI Realtime WebSocket, to send `response.create`. Currently only the page has a data channel. Core exchanges SDP without a call ID and cannot verify that connection in cloud. Allowing both sides to submit `response.create` also requires redesigning responding state and interruption cancellation. ID-02 instead **composes the full sentence in core and returns only composed instructions**. Pages receive no person_id, scores, or other-family list, but the sentence briefly enters renderer memory. A script must genuinely open a look-to-talk voice session before obtaining a name; `greeting` accepts only a core-issued, actually connected interaction ID (§2.1.1 threat surface). The same sentence also appears in captions, and generated UI cannot access preload APIs (CLAUDE.md). Core submission removes this exposure later (§11), requiring Mac tests.

- `ambient_probe` returns no results, including matched / unknown, and no rejection reasons. `ambient_status` reports only sampling availability. Neither can probe a face's enrollment or whether family members exist. `greeting` decides once per interaction ID, at most 2 per second and 3 per minute, including names only with valid core evidence, a genuinely connected bound session, and the seen cloud-naming notice.

<a id="25-身分不作授權依據"></a>
### 2.5 Identity is not authorization

Recognition is for addressing people only. It cannot unlock private data, pass Action Gates, replace explicit current confirmation, switch accounts, or change model credentials. Photos, videos, and screens can fool the model. This ADR includes neither liveness nor anti-spoofing.

<a id="3-模型與授權2026-10-24-實際查核"></a>
## 3. Models and licensing (actually reviewed on 2026-10-24)

| Component | Version and source | License | Review method | Notes |
|---|---|---|---|---|
| YuNet | `face_detection_yunet_2023mar.onnx`, Hugging Face `opencv/face_detection_yunet` revision `3cc26e7f`; SHA-256 `8f2383e4…52fa4` | MIT (Copyright 2020 Shiqi Yu) | Read that revision's `LICENSE` and README statement that all files in the directory are MIT licensed | Fixed input 1×3×640×640 |
| Dynamic YuNet | `face_detection_yunet_2026may.onnx`, OpenCV Zoo commit `48b10fa5` (GitHub LFS); SHA-256 `ebafce4e…0f0` | MIT (same directory license) | OpenCV Zoo README says reexported from 2023mar with dynamic height/width | Accepts 1280×736 directly, also measured in spike |
| SFace | `face_recognition_sface_2021dec.onnx`, Hugging Face `opencv/face_recognition_sface` revision `3d708243`; SHA-256 `0ba9fbfa…e79` | Apache-2.0 | Read full `LICENSE` and README licensing statement | SFace paper and upstream README describe CASIA-WebFace, VGGFace2, and MS-Celeb-1M experiments. OpenCV Zoo does not identify the dataset used for this ONNX. Weights are Apache-2.0, but training-data origins and terms remain unclear, recorded as an undecided risk in §9 |
| MediaPipe BlazeFace short range | `blaze_face_short_range.tflite`, `mediapipe-models/face_detector/…/float16/1/`; SHA-256 `b4578f35…152f` | Apache-2.0 | Official model card dated 2021-06-09 states Apache License Version 2.0 | Model card places people beyond 2 m and any surveillance or identity recognition out of scope |
| MediaPipe BlazeFace full range | `blaze_face_full_range.tflite`, same `/float16/1/` path; SHA-256 `3698b18f…181b` | Apache-2.0 | Official full-range model card | Identity recognition is also out of scope. Stated range up to 5 m |
| `@mediapipe/tasks-vision` | 1.1.1 (existing dependency) | Apache-2.0 | Existing | |
| `onnxruntime-web` | Exact 1.30.0, devDependency in ID-00, dependency from ID-01 | MIT | `npm view onnxruntime-web@1.30.0 license` and package manifests | Transitive dependencies: `onnxruntime-common` 1.30.0 MIT, `long` 5.3.2 Apache-2.0, `flatbuffers` 25.9.23 Apache-2.0, `protobufjs` 7.6.6 BSD-3-Clause, `platform` 1.3.6 MIT, `guid-typescript` 1.0.9 ISC, and nine BSD-3-Clause `@protobufjs/*` packages (aspromise, base64, codegen, eventemitter, fetch, float, path, pool, utf8). `protobufjs` 7.6.6 has `hasInstallScript: true`, running `node scripts/postinstall`. Reviewed code only checks parent package version syntax and may warn, without network or file writes |

Weights and code licenses were checked: none are AGPL, GPL, or NC. The MediaPipe card's identity-recognition exclusion is a stated usage scope, not a license restriction. BlazeFace before SFace would nevertheless use it in a scenario the card excludes, one reason to prefer YuNet (§6).

`onnxruntime-web` was an ID-00 devDependency, becoming a dependency in ID-01. Worker JS is bundled into the frontend (about 57 kB). The 14 MB wasm and both models are not bundled, installed only into the App data directory by `npm run face:setup -- --product` (§10).

<a id="4-前後處理的出處"></a>
## 4. Preprocessing and postprocessing sources

The spike's TypeScript modules were checked item by item against official OpenCV implementation, opencv/opencv commit `048f050d`:

- YuNet: `postProcess` in `modules/objdetect/src/face_detect.cpp`, including strides 8 / 16 / 32, anchor-free decoding, score √(cls·obj), and `padWithDivisor`. NMS follows `NMSBoxes` in `modules/dnn/src/nms.cpp`.
- SFace: `alignCrop` in `modules/objdetect/src/face_recognize.cpp`, using a five-point similarity transform to the 112×112 template and `warpAffine` INTER_LINEAR; `feature` uses RGB, 0–255, NCHW; `match` uses an inner product after L2 normalization.

Cloud cross-check: With identical pixels, spike YuNet 2026may decoding versus OpenCV 5.0.0 `FaceDetectorYN` produced box IoU 1.0000, five-point differences 0.000 px, and score differences 0.0000 on five images. SFace feature cosine against OpenCV `FaceRecognizerSF` was 0.9999–1.0000. This establishes implementation agreement with OpenCV, not recognition accuracy.

<a id="5-對既有防護的改動"></a>
## 5. Changes to existing protections

- `tests/camera-privacy.test.ts` originally prohibits all pixel-readback APIs in `src/`, and that rule remains. Add recursive scanning of `spike/face/`, permitting `getImageData` only in `runtime.ts`, while prohibiting export, recording, network, remote dynamic import, and local-storage APIs. Also ensure `src/`, `server/`, `shared/`, and `desktop/` never import the spike in any form, including dynamic or side-effect imports, and main entry points exclude it.
- Production ID-01 needs a similar exception limited to one file: `src/` permits `getImageData` only in `sense/identity-worker.ts` and `createImageBitmap` only at the sampling outlet in `sense/pipeline.ts`. All `src/` additionally prohibits `MediaRecorder`, `ImageCapture`, `readPixels`, `convertToBlob`, and `showSaveFilePicker`. Worker and helpers additionally prohibit network, local storage, and `/api/` (`tests/camera-privacy.test.ts`).

<a id="6-偵測器選擇"></a>
## 6. Detector selection

Decide from spike data. Cloud results are in [validation §3](../validation/family-id-00-spike-2026-10-24.en.md#3-雲端量測結果). Cloud gives direction only. **Final selection requires Mac + AR0144 testing.**

**Finalized 2026-10-25: YuNet 2023mar (640×640) detection frontend**, after George's Mac ID-01 test showed successful enrollment, trial recognition, and palm stop. Reasons:

1. SFace alignment needs five points including both eyes and both mouth corners. YuNet outputs those directly. BlazeFace has only mouth center, requiring unverified corner estimation before SFace.
2. In cloud 1280×720 frames with roughly 60 and 100 px face widths, short-range BlazeFace mostly misses faces or returns oversized boxes because input is only 128×128. Both YuNet versions and full-range BlazeFace detect them.
3. BlazeFace model cards exclude identity recognition from scope.

Counterargument: BlazeFace has lower cloud per-inference duration, and tasks-vision is already a dependency. ID-02 also runs recognition during look-to-talk. If concurrent Mac execution slows sensing or stop gestures (ID-02 validation §5 measurements), reevaluate options such as full-range plus mouth-corner estimation or YuNet on an ROI only.

<a id="7-與-claudemd-紅線逐條對照"></a>
## 7. CLAUDE.md red-line comparison

| Red line | Treatment in this ADR |
|---|---|
| No App launcher, App icons, permanent sidebar, home Dashboard, or default chat homepage | Recognition adds no screen. The spike page is a developer tool with separate Vite config, bound only to 127.0.0.1, outside main entries, UI, and menus |
| Every Surface carries verifiable `visibility_reason` | Recognition itself creates no Surface, and familiar recognition opens no view (14 I1). ID-01 Family recognition opens only from menu “Camera and voice settings → Family recognition…”, with `user_request` checked by Presentation Policy. It is neither launcher nor permanent view |
| Gaze selects only, with no side effects; blinking is not clicking | Recognition creates address candidates without expanding, submitting, or deleting. Existing look-to-talk activation still triggers greetings |
| Hide closes views; Stop task cancels | Unchanged. Hiding cancels unsent greetings (14 §3 condition 6) |
| External side effects require Action Gate and explicit current confirmation | Identity is not authorization (§2.5) and cannot replace confirmation |
| Generated UI cannot obtain shell, filesystem, MCP tokens, or arbitrary network | Gallery and keys stay in core. Renderer inference workers never receive the gallery. Generated UI cannot access data beyond recognition results |
| Raw webcam images and unawakened audio never enter files, traces, or external services | §2.2 keeps raw/aligned images only in memory, without files, traces, cloud, or enrollment photos. Traces exclude person IDs, names, and similarities. Spike CSP `connect-src 'self'` and static checks constrain it. Cloud Playwright observed no nonlocal requests; CSP blocked MediaPipe usage logging (validation §6) |
| Label mocks, fixtures, and replay | Spike and validation explicitly identify cloud CPU / WASM measurements and cosine as sanity checks only |
| Animation follows real events only | Recognition does not drive brain-region animation. Later visual-region activity must identify actual inference events and cannot claim viewing without image input |

<a id="8-後果"></a>
## 8. Consequences

- Benefits: Identity data remains local and deletable. Renderers cannot obtain gallery features. Both voice routes share one restricted name source.
- Costs: Another wasm runtime (about 14 MB for onnxruntime-web) and roughly 39 MB SFace model. Browser recognition is unavailable.
- Risks: SFace training-data terms remain unclear. Cloud timings do not represent Mac. BlazeFace / YuNet performance on actual AR0144 quality is unknown. Cosine thresholds lack calibration data.
- Existing dependency finding: `@mediapipe/tasks-vision` 1.1.1 includes usage reporting, attempting POST to `odml.pa.googleapis.com/v1/log`. Visible code fields are task type and duration statistics, without images. Spike CSP blocks it, observed during measurements. Main pages have CSP `connect-src 'self'` only when served by local core (`npm start` and Electron). **Vite development server (`npm run dev:web`) currently lacks CSP and usage reporting is sent there.** This is an existing issue for separate work. Production implementation must not relax CSP. See validation §6.

<a id="9-george-的決定與仍待決事項"></a>
## 9. George's decisions and remaining questions

Decisions on 2026-10-25:

- Key storage (original item 3): Use Electron safeStorage without a native Keychain module. Retain limitations honestly: wrapped keys are `userData` files and old gallery snapshots in Time Machine / APFS may still decrypt (§2.2). ID-01 still rotates deletion keys and uses `tmutil addexclusion` for gallery and wrapped keys to reduce risk. Explain the limitation in deletion UI.
- Cloud naming (original item 4): Named greetings default on and can be disabled. Cloud receives the name sentence, without face images, features, or family lists.
- Enrollment entry and browser (original items 5/6): Place “Family recognition…” in macOS App “Camera and voice settings.” Start with 5–10 multi-angle samples, adjusting after ID-01 measurement. Browser explicitly shows recognition unavailable, retaining conversation and look-to-talk.
- Minors (original item 7): May enroll with parent George confirming consent. Same rules as adults: addressing only, no authorization, deletable anytime.

Further decisions after Mac ID-01 testing on 2026-10-25:

- **Detector finalized (original pending item 1): YuNet 2023mar 640** (§6). MediaPipe Face Detector is no longer a candidate, while spike measurements remain.
- **Enable naming before calibration**: ID-02 named greetings need not wait for calibrated thresholds. Use ID-01 starting values (`match` 0.5, `margin` 0.08), deferring tools and held-out samples to ID-03. Replace “no naming before calibration” with naming independent of `calibrated`, while all observations, `GreetingDecision`, logs, and documents honestly state `calibrated: false` / “thresholds uncalibrated.” Wrong or missing names remain possible. Identity only addresses people; wrong names authorize nothing (§2.5).
- Cloud naming defaults on and is switchable off, reaffirming original item 4, implemented in ID-02 as “Address recognized family members in greetings.” Browser has no recognition and look-to-talk says only “I'm here.”

Still undecided:

1. Whether SFace training-data risk is acceptable, or a model with clear training-data terms must replace it first.

<a id="10-id-01-待辦已知不需-george-決定"></a>
## 10. ID-01 tasks (known; no George decision required)

Work on branch `claude/family-id-01` on 2026-10-25, with cloud validation in [ID-01 record](../validation/family-id-01-2026-10-25.en.md):

- [x] Move `onnxruntime-web` to exact dependency 1.30.0. Use external-wasm frontend build through Vite condition `onnxruntime-web-use-extern-wasm`. wasm and models **never enter dist or release zips**. Install into App data only with `npm run face:setup -- --product`. Core verifies hashes and serves `/face-runtime/`. JS responses have worker CSP (`connect-src 'self'`, `'wasm-unsafe-eval'`), without relaxing page CSP. Headless cloud Chromium confirms external worker `fetch` and `eval` are blocked. Actual Electron behavior awaits Mac verification.
- [x] Preload identity API, main sender/shape checks, core rate/generation checks (§2.1.1). Actual Electron `ipcMain` / `contextBridge` execution awaits Mac.
- [x] Review fixes on 2026-10-25: zero features only after successful deletion write; validate loaded vectors; accumulate evidence for gallery-dependent results; session caps and closure on navigation/reload/renderer exit; shutdown and concurrency guards; separate unavailable keys from corrupt files; delay gallery loading until first session; `authTagLength` 16; menu-only settings; hash-check every `/face-runtime/` read; write using `writeFileSync(fd)`.
- [x] Replace YuNet 640 letterbox with a port of OpenCV `cv::resize` (INTER_LINEAR, 8-bit fixed point), pixel-identical downscaling to `cv2.resize` in `tests/face-letterbox.test.ts`. Cloud cross-check of product worker against OpenCV `FaceDetectorYN` (2023mar, 640) + `FaceRecognizerSF`: same face counts and feature cosine 0.99993–0.99996.
- [x] Move inference to module worker `src/sense/identity-worker.ts`, the only production pixel reader. Cloud single-thread timings are in validation. **Concurrent impact on existing sensing can be measured only on Mac.**
- [ ] Threshold calibration (`CALIBRATED = false`) requires voluntary family held-out samples and strangers (ID-03).
- [ ] Mac + AR0144 tests: safeStorage / Keychain prompts, `tmutil isexcluded`, IPC, enrollment/trial recognition, stop gestures and CPU, Electron worker CSP, restart after deletion (validation §6).
- [ ] Per-person disablement, retaining without matching, is deferred. ID-01 supports deletion only.

<a id="11-id-02看著說話時同步辨識與稱名問候2026-10-25"></a>
## 11. ID-02: Concurrent look-to-talk recognition and named greetings (2026-10-25)

Branch `claude/family-id-02`, based on main including ID-00 / ID-01. Cloud fixture validation is in the [ID-02 record](../validation/family-id-02-2026-10-25.en.md).

- **Existing `look_to_talk` only**: After each event and tick, `SenseController` reports `SenseSnapshot` (presence, facing, distance, camera-device ok, and active facing dwell). `src/sense/identity-ambient.ts` samples only during dwell with present + near (0.6–1.5 m; unknown distance excluded) + facing + camera ok. It reuses `IdentityClient` at ≤4 Hz with at most one inference in the worker. Look-to-talk timing never reads it. `startTalk` fires on schedule. Cold/slow recognition does not delay it, and greeting falls back to “I'm here.” Buttons, voice commands, and `user` after consent create no greeting object, retaining 2026-10-23 rules.
- **Tracking generation**: Page increments on absence, looking away, leaving near range, non-ok camera, disabled settings, or recognition errors. `startRealtime` creates an interaction ID bound to the current generation. Core evidence separates generations too. Multiple faces or two different family members within one generation suppress names throughout. PresenceTracker's 60-second absence rule does not retain identity.
- **Separate greeting lifecycle**: `GreetingOnce` becomes `pending → deciding → sent／skipped`. `take(route)` happens only at voice readiness +600 ms, then asks core over IPC. Speech, typing, or dismissal during decision marks skipped and prevents sending the returned content. Once sent, never resend even if status is unknown. Live→API-key fallback shares the same object, and core permits one decision per interaction ID.
- **Core GreetingDecision** (`shared/identity.ts`): Interaction ID, person_id or null, tracking generation, gallery version, evidence time, decision time, reason, and `calibrated:false`. Apply 14 §3: page supplies `eligible` (same interaction/generation, still near/facing, no multiple faces or errors, still enabled); core checks generation, no mixed person, ≥3 frames over ≥500 ms, newest ≤1 second, person existing and matchable, unchanged gallery (deletion/clear also remove evidence and pending sentences), naming still enabled, and `speakableName`. Any failure removes the name. Discard evidence after decision; late inference cannot carry into later interactions.
- **Two routes**: See §2.4.1. API-key IPC returns composed instructions. Live submits only interaction ID; core (`greeting` option in `server/live-route.ts` → `liveGreetingSource` in `server/nous.ts` → `IdentityService.takeLiveGreeting`, bound to live-session ID) retrieves the sentence and sends sideband, otherwise “I'm here.”
- **Core-issued interaction IDs (independent review fix, 2026-10-25)**: Page posts `source: "look_to_talk"` to `/api/realtime/start`. `RealtimeSessions` issues single-use `interaction`, reused on route fallback. Successful `call()` records bound session and connection time. `IdentityService` uses `greetingClaims` → `RealtimeSessions.claimGreeting` to resolve the session, accepting only core-issued, unused, genuinely connected, active, route-matching IDs within 20 seconds (`no_session` otherwise). Page-local keys bind tracking generation only.
- **One-time notice**: See §2.4. No naming before acknowledgement (`notice_unseen`).
- **Opening change**: All look-to-talk greetings change from 2026-10-23 openings such as “I'm here, how can I help?” to one core-selected short sentence (§2.4). Both macOS App routes use core selection. Live without family recognition (browser) still selects from unnamed templates. Only browser API-key or failed decisions use page-fixed “I'm here,” without page-side selection.
- **Mask greetings**: Recent transcripts delegated to Codex omit the opening greeting entry (§2.4.1).
- **Gallery loading**: `ambient_status` neither loads gallery nor touches Keychain, checking file presence only. First `ambient_probe` loads it. Thus initial look-to-talk recognition with enrolled people may show a Keychain prompt, unless already permitted in management UI.
- **Logs**: Core logs one greeting-decision line containing route, reason, generation, N frames / M ms evidence, latest K ms ago, template ID, and uncalibrated status, without sentence content. Sampling does not log each result. Page prints one `[看著說話時序]` millisecond line in DevTools for Mac comparison of facing → presence → interaction → voice readiness → decision → first audio.

Remaining work:

- [ ] Mac tests (ID-02 validation §5): actually hear one listed sentence on both routes, such as “Hi, George”; inspect model additions/guessed names, speech-first cancellation, person changes, multiple people, timing, concurrent CPU / stop gestures. **A route that adds speech, guesses names, or repeats cannot pass**, and requires fixed-text TTS (14 §6).
- [ ] Core-sent API-key `response.create` through the server control connection for that WebRTC call, keeping composed sentences out of the renderer (§2.4.1 tradeoff; independent review #1(c), outside ID-02).
- [x] Enrollment previews spoken names, such as “George, I'm here” and “Hi, George.” Unspeakable names, instruction-like sentences, or more than three segments are flagged during enrollment (independent review 2026-10-25).
- [x] Delegation masks the greeting transcript (George 2026-10-25). Task titles receive no special handling, stated in §2.4.1.
- [ ] Threshold calibration and held-out samples (ID-03).
