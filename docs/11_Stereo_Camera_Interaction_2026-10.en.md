<!-- bilingual: source=zh-TW -->

> [繁體中文](11_Stereo_Camera_Interaction_2026-10.md) | [English](11_Stereo_Camera_Interaction_2026-10.en.md)

<a id="nous-11--雙目鏡頭的遠距互動設計ar0144"></a>
# Nous 11: stereo-camera distant interaction design (AR0144)

Version v0.3 · Date 2026-10-21 · Status: four uses implemented in `prototype/ambient-shell/src/sense/`. v0.3 adds preview/settings. Values still derive from vendor specifications, without calibration or physical measurement.

> 2026-10-24 comparison: [Current implementation](Current_Implementation_Status.en.md) is the project entry point. Facing means head direction, not eyes. Real calibration has not replaced `AR0144_NOMINAL`. Distance/pointing/stop percentages are acceptance targets, not fixture-proven results. Quest head/hand and wearable fusion are [later ideas in 13](13_Feature_Expansion_Assessment_2026-10-24.en.md), not capabilities of this camera code.
Related: 06 §4, 10, this-is-yourX `stereo_camera/`, ADR-0002/0005.

---

<a id="0-一頁摘要"></a>
## 0. One-page summary

- **Hardware available**: Waveshare AR0144 Stereo USB Camera (A), documented in [this-is-yourX](https://github.com/pcpcchen-coder/this-is-yourX/tree/main/stereo_camera). Dual global shutter, 1280×720 per eye, 52 mm baseline, 65° horizontal FOV, driverless UVC, macOS device `CCB Camera`.
- **Scenario**: Users 1.5–3 m away cannot reach screen/keyboard. Camera supplements voice as a hands-free channel.
- **At 2 m** (§1): Face ~75 px, eyes ~15 px, hand ~95 px. One disparity pixel represents ~77 mm depth.
- **Conclusions**:
  1. **Eye gaze is infeasible** at ~15 px. The webcam gaze assumed in 06 does not work at this distance.
  2. **Head direction only indicates facing**. Left/right screen halves differ by ~5.7°, insufficient for target selection.
  3. **Four feasible uses**: Presence/distance, facing, stop gesture, left/center/right arm pointing (pending tests).
- **Decisions**:
  - Spoken numbers primary, arm pointing secondary.
  - External actions still require fixed spoken phrases. Gestures/pointing cannot cause side effects.
  - Local images only, despite Realtime API image support (CLAUDE.md, ADR-0002).
- **Pending George's decision**: Amazing Hand planned this camera 0.4–0.6 m diagonally above the hand. Nous needs it above the screen facing users. One mounting cannot serve both. Moving requires recalibration (ADR-0005). See §6.

---

<a id="1-幾何2-m-處鏡頭看得到多少"></a>
## 1. Geometry at 2 m

Use ADR-0005 f≈1005 px (65° FOV, 1280 px eye), B=52 mm. Disparity d=f·B/Z, depth resolution ΔZ≈Z²/(f·B).

| Distance | Disparity | Depth change per px | Coverage W×H | mm/px | Face | Eyes | Palm |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1.0 m | 52 px | 19 mm | 1.27 × 0.79 m | 1.0 | 151 px | 30 px | 191 px |
| 1.5 m | 35 px | 43 mm | 1.91 × 1.18 m | 1.5 | 100 px | 20 px | 127 px |
| **2.0 m** | **26 px** | **77 mm** | **2.55 × 1.58 m** | **2.0** | **75 px** | **15 px** | **95 px** |
| 2.5 m | 21 px | 120 mm | 3.19 × 1.97 m | 2.5 | 60 px | 12 px | 76 px |
| 3.0 m | 17 px | 172 mm | 3.82 × 2.36 m | 3.0 | 50 px | 10 px | 64 px |

Assume face 150 mm, eye region 30 mm, palm length 190 mm. Head angles for half of an 18-inch screen: 7.6° at 1.5 m, 5.7° at 2.0 m, 4.6° at 2.5 m.

<a id="2-互動通道可行性與用途"></a>
## 2. Interaction channels

| Channel | Feasibility at 2 m | Use | Side effects? |
|---|---|---|---|
| **Presence/distance** | High, large body, ±8 cm sufficient | Wake visuals at 0.5–4 m, measured-distance type scaling (10 §2), hide private content on departure | No |
| **Facing screen** | Medium, 75 px face | Facing + speech addresses Nous, reducing wake words. No new views when turned away, use voice. | No |
| **Stop gesture**, open palm | Medium, 95 px hand | Interrupt/pause TTS, like “stop” | No, playback only |
| **Arm pointing** | Pending, shoulder/wrist 3D ray | Select left/center/right in ≤3 columns, selection only (06 §4.4) | No |
| Eye gaze | Infeasible, ~15 px eyes | — | — |
| Identity | Technically feasible, near quality needs tests | [14](14_Family_Recognition_and_Greeting_Plan_2026-10.en.md) planned on 2026-10-24, then unimplemented. Requires ADR, registration consent, local boundaries. | Never authorization |

**Arm estimate**: Wrist ~600 mm ahead of shoulder (~300 px at 2 m), moving ±60 mm (~30 px) to point at screen edges. ±77 mm depth noise gives ~±0.7° angle error, below 5.7° for a half-screen. Three zones are theoretically distinguishable but require §7 V3 measurements.

<a id="3-與既有規則的對應"></a>
## 3. Existing rules

- **06 §4.4** becomes **pointing selects, speech acts**. Highlight after 450 ms stability, without expansion/submission/deletion.
- **10 §5** external actions use fixed speech (`src/approval.ts`). Gesture, pointing, nodding are not confirmation.
- **10 §2** measured type scales D÷2.0 m, clamped to 1.5–3 m. Beyond that use voice rather than enlarge.
- **Brain graphic**: ~~Same distance scaling for standby/top thumbnail radius, halos, hit area.~~
  - **2026-10-23, George**: Standby now **grows on approach** rather than following text. 1× beyond 2.5 m, configured maximum within 0.6 m, linear between. “Brain zoom on approach” is 1–3× in 0.1 steps, default 2, in settings/macOS menu. Shape, halo, orbits, region names, hit areas scale together. Smoothing time constant ~0.2 s (~0.55 s to 95% at 30 fps), driven only by measured distance/settings. Shape, or real progress ring when present, bounds fitting; ~2.14× maximum at 16:9, with faint outer orbits permitted outside. Reason: approaching implies interaction. Old 0.75–1× at 1.5–2 m shrank the brain on approach and was imperceptible to George.
  - **2026-10-25, George**: Replace the 2.14× limit. If it cannot fit in place, smoothly move to screen center and use full window height. Lower edge may sit behind the voice-start button, hints, captions; button remains clickable above Canvas. Landscape maximum ~2.56× (h÷1.95), visually centered at maximum. ≤2× unchanged. No movement with real progress ring. 3× still cannot fully fit landscape. See [small decisions](validation/small-decisions-2026-10-25.en.md).
  - Text/panels and top thumbnail retain D÷2.0 m. The panel follows the thumbnail, so enlarging it would cover content.
  - Ordinary renders retain scales. Null distance, off/error/degraded camera, or departure resets both to 1×. Apply panel CSS distance scaling once. See [validation](validation/brain-proximity-zoom-2026-10-23.en.md).
- **AC-08**: Unplugging, denial, darkness clears focus/presence. Numbers still complete tasks.

<a id="4-架構"></a>
## 4. Architecture

```
AR0144（2560×720 MJPG 併排）
   │ 只在本機
   ▼
SensePipeline（Electron 隱藏視窗或 Worker，TypeScript）
   ├─ 切左右 1280×720 → 載入 ADR-0005 的雙目校正
   ├─ MediaPipe Tasks Vision（Apache-2.0）：左右各自偵測臉、手、姿勢關鍵點
   ├─ 關鍵點三角化 → 3D（不做全畫面稠密深度，ADR-0005）
   ├─ 只輸出事件，不輸出影像
   └─ 使用者要求時：把縮小的左眼畫面與左右眼差異直接畫到本頁兩個畫布（不交出串流）
        presence { distance_m, confidence }
        attention { facing_screen }
        gesture { kind: "stop" }
        pointing { zone: "left" | "center" | "right", stable_ms }
        sensor { state: "ok" | "degraded" | "off" }
   ▼
Nous Shell（既有狀態機）：PointerProvider 取代 06 的 GazeProvider 介面
```

- **TypeScript** follows CLAUDE.md. MediaPipe Web runs in Electron without a separate Python service.
- **Privacy**:
  - Never save images, trace them, or send to Realtime/cloud.
  - Only listed events leave SensePipeline.
  - Exception: On “show camera,” pipeline draws ~256×144 previews directly into two page canvases. No MediaStream exposure or pixel readback. Static checks prohibit `getImageData`, `toDataURL`, `toBlob`, `captureStream`, `createObjectURL`. No saving/tracing/upload. Preview is human-only, AI does not analyze it, and the visual brain region does not light because of it.
  - AI image inspection needs a separate ADR and per-image consent.
- **Host policy**: Relax `app.ts` `Permissions-Policy: camera=()` only for SensePipeline origins, never generated UI.
- **Indicator**: Minimal active-camera status (06 `sensor_status`). “Camera off” releases immediately.

<a id="5-畫面回饋延續-10-的遠距-ui"></a>
## 5. Feedback (10's distant UI)

- **Presence**: Brain fades in on approach, returns to standby after ~60 s absence.
- **Facing**: One outer ring segment lights to acknowledge being addressed.
- **Pointing**: 1.04× card, bright border, “Pointed,” like S06.
- **Stop gesture**: Playback and brain pulses stop immediately.
- **Status**: Bottom-right dot, green active, amber starting/degraded, red error, hidden off. Device `sensor` events drive dot/preview, not configuration switches.
- **Preview v0.3**: Voice, status dot, or settings opens “Live image (left)” and “Left/right difference,” the absolute difference, with doubled nearby edges and dark distant backgrounds. **Not depth**. Unmirrored, camera's actual orientation. Available while active/degraded; degraded says interrupted. Dismiss by voice, dot, ×, off/error/restart/departure. Dismissal does not disable camera. Never persist; reload starts closed. Mark `data-visibility-reason="user_request"` and request ID.
- **Settings v0.3**: Camera/gestures controls camera, look-to-talk, facing duration 0.5–5 s default 1.5, post-conversation pause 3–60 s default 10, palm stop. Save locally in `camera.json`. Spoken camera off persists across reconnect/restart.
- **Greeting on look-to-talk**, George 2026-10-23: Greet once after camera-started live voice. `look_to_talk_greet` defaults on, after duration in settings, voice-toggleable. Only `startRealtime("look_to_talk")` greets, not buttons, commands, typing, or consent flow. Wait for real readiness (API key `session.created`; ChatGPT mic/peer/`session.started`), then `GREETING_SETTLE_MS`=600 ms, matching OpenClaw FaceTime `talk-driver.ts`. This delay is an unmeasured estimate. API key sends `response.create` with per-turn `instructions`, no fake user message. ChatGPT sends core `session.context.append` speakable like OpenClaw quicksilver `triggerGreeting`. Core ignores renderer text and uses fixed `LIVE_GREETING_TEXT` from `shared/sense.ts`, prefixed “（開場）”; `buildLiveInstructions` instructs greeting only without reading the prefix. Count sent only after actual open-sideband send, once/session. Speech during waiting (API `input_audio_buffer.speech_started`, ChatGPT partial/final user transcript), typing, dismissal, or session end cancels greeting. Create one greeting object for each look-to-talk start; read the setting at send time so enabling during connection works. Share the object across two sessions when changing paths, preserving greeting after billing notice and once/start. Queue connection-time typing, combine after readiness, transfer to API session on path change, discard on failure/dismissal. Instructions allow “I'm here, how can I help?” only. Facing is all the camera tells it; models cannot see the image or claim to see/describe people/environment. See `docs/validation/look-to-talk-greet-2026-10-23.md`.

<a id="6-鏡頭給誰用已決定先給-nous2026-10-21"></a>
## 6. Camera allocation (decided: Nous first, 2026-10-21)

| Option | Setup | Cost |
|---|---|---|
| A. Nous first | Above 18-inch screen, facing user, §7 tests | Delay Amazing Hand vision Phase B–D or old webcam |
| B. Amazing Hand first | ADR-0005 mount, Nous voice only | Delay Nous camera |
| C. Buy another | One each, independently calibrated | Extra hardware, separate calibrations/settings |

George chose **A**. Revisit a second camera for Amazing Hand later.

<a id="實作對照v02"></a>
### Implementation mapping (v0.2)

| Module | Content |
|---|---|
| `shared/sense.ts` | Events/settings, single `CAMERA_PREFS` list of defaults/ranges/labels/validation, events only leaving pipeline |
| `server/camera-settings.ts` | `<configDir>/camera.json`, changed keys only; saved > `.env` `NOUS_LOOK_TO_TALK` > defaults |
| `src/sense/geometry.ts` | Triangulation, ray/screen intersection, head direction, raised palm |
| `src/sense/trackers.ts` | Presence 0.5 s/departure 60 s, facing hysteresis 0.3 s, stop 0.3 s +2 s cooldown, point 450 ms/clear 1 s, look-to-talk default 1.5 s total (0.3 +1.2), cooldown 10 s |
| `src/sense/processor.ts` | Per-frame landmarks → events |
| `src/sense/pipeline.ts` | Camera, split eyes, local MediaPipe Pose/gestures wasm, requested preview |
| `src/sense/controller.ts` | Events → shell, text scale, proximity brain zoom (2026-10-23), look-to-talk, optional stop, point highlight, departure dismissal/reject pending actions, voice camera commands |

See prototype README stereo section and INSTALL.

<a id="7-驗證計畫建議併入-g2取代-06-的-webcam-三區驗證"></a>
## 7. Validation plan (G2, replacing 06's webcam regions)

| # | Item | Method | Initial threshold |
|---|---|---|---|
| V1 | Distance | Marks at 1.5/2.0/2.5/3.0 m | <10% error |
| V2 | Facing | Six people, varied head poses | ≥90% accuracy |
| V3 | Three arm zones | 2 m, 30 trials each left/center/right | ≥90%, otherwise two zones/voice |
| V4 | Stop | Raise during speech, ordinary-motion false triggers | ≥95% triggers, <1 false/hour |
| V5 | Privacy | Packet/filesystem inspection | No image upload/save |
| V6 | Failure | Unplug, cover, lights off | Degraded within 1 s, voice unaffected |

Record measurements in `docs/validation/` with experiment IDs. Preserve revisions when thresholds change.

<a id="來源"></a>
## Sources

- [this-is-yourX stereo_camera README](https://github.com/pcpcchen-coder/this-is-yourX/tree/main/stereo_camera)
- this-is-yourX ADR-0005 (camera choice/spec/calibration/depth) and ADR-0002 (local-only policy).
- [Waveshare AR0144 Stereo USB Camera (A)](https://www.waveshare.com/ar0144-stereo-usb-camera-a.htm)
- 10_Distance_UI_18inch (distant typography/display, PR #10).
