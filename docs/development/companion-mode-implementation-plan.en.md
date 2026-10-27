<!-- bilingual: source=zh-TW -->

> [繁體中文](companion-mode-implementation-plan.md) | [English](companion-mode-implementation-plan.en.md)

<a id="實作-companion-modeaios-原型開發交辦與驗收"></a>
# Implement Companion Mode (AIOS prototype development assignment and acceptance)

> Document type: **How-to / development-batch plan, not executed** · 2026-10-24 · Based on [Companion Mode specification](../15_Companion_Mode_Spec_2026-10-24.en.md).
>
> Before work, read [status](../Current_Implementation_Status.en.md), [AGENTS.md](../../AGENTS.md), [CLAUDE.md](../../CLAUDE.en.md), and [pstack guide](pstack.en.md). The existing prototype is `prototype/ambient-shell`. Do not assume the old Python kernel, Tauri, or existing local ASR.

<a id="交付原則"></a>
## Delivery principles

Split into four independent PRs. Each batch has an operable path, contract/error tests, negative cases, evidence, and rollback. **A settings screen does not establish natural companionship.** Until sound-source exclusion and local ASR pass, `natural` and `active` must show unavailable.

Follow pstack engineering. The executing agent must actually invoke recorder start/step/finish locally. This document supplies assignment steps only and does not claim the recorder captured this documentation task.

<a id="批次-cm-p1偏好主開關與強制停止"></a>
## Batch CM-P1: Preferences, master switch, and forced stop

**Goal:** Users explicitly enable/disable Companion Mode and save four settings. Disabled mode has no background capture, stale replies, or delayed playback.

Expected new/modified locations, with final filenames determined by the actual prototype:

| Path | Expected change |
|---|---|
| `shared/companion-prefs.ts` | `CompanionPrefs`, defaults, enums, strict parsing/validation |
| `server/companion-settings.ts` | `PrefsFile` writes `companion.json`; read errors fail closed |
| `server/nous.ts`, `server/app.ts` | Settings persistence, `GET /api/settings`, `POST /api/settings/companion`, `settings.updated` |
| `src/api.ts`, `src/main.ts` | Read/update preferences, actual runtime, UI rollback on failure |
| `desktop/settings-menu.mjs` | Menu-bar master checkbox, three setting groups, availability/state, start/stop |
| `src/views.ts` | Browser on-demand settings, no permanent fields |
| `tests/companion-settings.test.ts` | Boundaries, persistence, corruption, read/write failures, `settings.updated` |

**Execution order:**

1. Define four settings and parsing in `shared`, rejecting unknown keys and validating individual patches and enums.
2. Integrate `PrefsFile`. Missing `enabled` or incompatible versions default false. One writer; update UI only after save.
3. Build a minimal pure state machine `disabled / armed / requesting_permission / listening / evaluating / responding / paused / error`, separating preferences from capture events.
4. Add macOS menu and browser on-demand UI. Show **actual capture**, never fake listening from a checkbox.
5. Implement idempotent `start / stop / disable` and hard-stop callbacks first. Start may currently report “local sensing pipeline is not available,” without fabricating listening.
6. Cover disabling mid-transition, save failure, cold-start `armed`, duplicates, and stale session epochs.

**P1 acceptance:** Four settings save and reload; the switch is a real safety master; failures are visible; capture never starts without authorization. This batch **does not provide natural companionship**.

<a id="批次-cm-p2本機收音聲源判斷與語音候選"></a>
## Batch CM-P2: Local capture, source assessment, and speech candidates

**Goal:** Do not upload background audio. With TV sound present, forward only candidates attributable to local viewers to policy.

1. Build a capture adapter using existing `src/voice.ts` and `src/realtime.ts` as interface references. **Two components cannot own the microphone simultaneously.**
2. Integrate local VAD and ASR. Measure macOS M6 latency/memory for candidate implementations. Do not assume system dictation is offline.
3. Provide `source=human / tv / self_tts / unknown`, confidence, device state, and epoch per candidate. Conservatively reject unknown.
4. If XVF3800 USB mic and DOA/AEC data are available, wrap in an adapter. Without TV reference audio, explicitly lower source confidence, without claiming validated AEC.
5. Retain only deidentified decision metrics. Discard unapproved audio and transcripts locally.

**P2 acceptance:** Fixed TV/human negative scenarios with actual LG G3 playback; no TV automatic triggers; report ordinary-comment detection and false positives; verifiable no-upload/no-storage evidence. Disable `natural` if quality fails.

<a id="批次-cm-p3策略層現有-llm-路由與語音回答"></a>
## Batch CM-P3: Policy, existing LLM routes, and spoken replies

**Goal:** Respond only when eligible, briefly, without spoilers or false image claims.

1. Build deterministic `engagement-policy` for enabled, session owner, source, activation, cooldown, and playback conflicts.
2. Send approved text through existing `streamChat` or controlled inference routes. Never bypass local gates with always-on WebRTC raw audio.
3. Add restricted Companion system prompt and JSON decision response. Model `should_respond` never overrides the local off switch or tool permissions.
4. Reuse TTS/captions and suppress candidates during AI playback to avoid AI chatting with itself.
5. Cancel inference and TTS on epoch change, preventing delayed ghost replies.
6. Explain provider permissions and fees through existing UI. Explicitly report logged-out/offline failures.

**P3 acceptance:** Measurably different `wake` and `natural` behavior; `short/normal/long` lengths follow policy; test 5, 15, and 60-second cooldowns; no new TTS after stop; no pretending to watch unknown characters/images.

<a id="批次-cm-p4lg-g3-客廳整合與長時間實測"></a>
## Batch CM-P4: LG G3 living-room integration and extended testing

**Goal:** Reliable use with real TV playback and hidden Mac mini windows.

1. Test everyday LG G3 sources at low/medium/high volumes in quiet/noisy rooms. Do not assume third-party LG G3 apps can access the built-in mic.
2. Validate XVF3800 far-field capture, TV false triggers, AI-TTS retriggering, cooldown, and user interruption.
3. Validate hidden Electron windows, macOS sleep/wake, USB mic unplugging, network loss, and revoked permissions.
4. Record p50/p95 latency, response rates, TV false positives, and raw-audio egress. Publish only **deidentified** results.
5. If TV optical reference audio is available, create a separate AEC sub-batch. Do not make optical equipment an MVP dependency.

**P4 acceptance:** Meet CM-01–CM-12 with hardware evidence. Announce natural companionship only when false triggers beat proposed thresholds. Record each provider/output device separately. Mock success never equals hardware success.

<a id="自動化驗證命令"></a>
## Automated verification commands

Run from the repo root:

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
git diff --check
```

Add settings, state-machine, API, UI, and session-race tests covering off switches with late callbacks, permission denied, ownership conflicts, save failures, and invalid values. If Node 22.12+ or `npm ci` is missing locally, explicitly explain unexecuted checks. Web UI and actual television/microphone results require manual testing, beyond these scripts.

<a id="開發-agent-可直接使用的任務-prompt"></a>
## Ready-to-use development Agent prompt

```text
請依 AIOS repo 的 AGENTS.md、CLAUDE.md、pstack 規範工作。
先讀 docs/Current_Implementation_Status.md、
docs/15_Companion_Mode_Spec_2026-10-24.md 與本開發批次。

本次只執行「CM-P1：偏好、主開關與強制停止」：
- 在 prototype/ambient-shell 現有 Node/TypeScript/Electron 上增量實作。
- enabled 預設 false，損毀設定 fail-closed。
- activation = wake|natural|active，default natural；
  verbosity = short|normal|long，default short；
  cooldown_seconds = 5..60 step 5，default 15。
- macOS 選單列與瀏覽器按需設定都可切換。
- 開關關閉必須立即停止 Companion 擁有的 session、取消晚到播報；
  不得取消既有背景任務或獨立語音會話。
- 有偏好、正在聆聽、已暫停等狀態須分開。
- 本批沒有真正音訊來源判別和本地 ASR，請明示不可用，
  不要用 mock 偽裝 Companion 可以自然陪聊。
- 補自動化測試和清楚的錯誤／拒絕權限路徑。
- 不新增常駐 Dashboard、啟動器或新的應用殼。
- 回報變更檔案、指令、實際測試結果、未完成、下一個 gate。
```

<a id="狀態回報格式"></a>
## Status reporting format

After each batch, complete and upload a `docs/validation/` record including at least commit SHA, code scope, test commands and actual output, mock use, real microphone/TV models and conditions, CM-xx acceptance table, failures/unperformed work, and effects on existing Realtime/ChatGPT-plan routes. Update README completion only with corresponding evidence.
