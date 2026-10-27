<!-- bilingual: source=zh-TW -->

> [繁體中文](small-decisions-2026-10-25.md) | [English](small-decisions-2026-10-25.en.md)

<a id="三項小決定的實作與驗證"></a>
# Implementation and validation of three small decisions

2026-10-25; base `96297c0`; Linux cloud environment, Node.js 22.22.0. George decided three previously raised questions. This record describes their implementation, including independent-review fixes (George changed the brain decision to “truly centered” that same day). G0–G3 acceptance status is unchanged.

| # | Question | George's decision |
| --- | --- | --- |
| 1 | On a 16:9 display the brain can grow only about 2.14× ([proximity zoom validation](brain-proximity-zoom-2026-10-23.en.md), remaining work) | To grow further, move the brain to the exact screen center without leaving the viewport. Its body may use the full window height and extend behind the start-voice button, hint, subtitles, and conversation status, while keeping the button clickable |
| 2 | Turning an AIFA air conditioner off makes the controller cancel its timer | Have AI say this |
| 3 | Adjusting temperature while AC is off cannot read the controller's remembered mode and defaults to cooling | Default to automatic, regardless of season |

<a id="1-電子腦放大時移到畫面正中間"></a>
## 1. Move the enlarged brain to the exact screen center

<a id="214-倍從哪裡來"></a>
### Where 2.14× comes from

The ambient brain center is fixed at 47% height (`LAYOUT.center.cy = 0.47`); 1× radius is min(width, height) × 0.2. The body must stay inside the viewport, using 1.1 R above and below (`ZOOM_FIT_EXTENT.body.y`). At 1920×1080, center is 507.6 px and upper room is 507.6 ÷ 1.1 = 461.5 px, or 2.14 times 216 px. The upper edge is the constraint.

<a id="為什麼最多約-256-倍"></a>
### Why the maximum is about 2.56×

Measured body extent is 1.07 R upward and 0.78 R downward ([proximity zoom validation](brain-proximity-zoom-2026-10-23.en.md), review fixes). With margin, use 1.1 R upward and 0.85 R downward, matching `HIT_EXTENT`. Body bounding height is 1.95 R, with its visual center at cy − 0.125 R.

Using full window height gives R ≤ h ÷ 1.95: 553.8 px at 1920×1080, or 2.56×. The box then touches top/bottom and its visual center is h ÷ 2. A 3× body box is 1.95 × 0.6 h = 1.17 h tall, or 1.11 h using measured extents alone, so 3× cannot fit any landscape viewport completely.

<a id="做法"></a>
### Method

`brainGeometry` and `zoomCenter` in `src/brain.ts`:

1. If zoom fits at the original location, radius and center stay unchanged, preserving the original rule through 2×.
2. Otherwise radius is capped at min(cx ÷ 1.25, h ÷ 1.95). Center moves with enlargement: t = (R − original-location limit) ÷ (maximum R − original-location limit), visual center = h ÷ 2 − (h ÷ 2 − original visual center) × (1 − t)². At t = 1 it is exactly centered.
3. Use (1 − t)² rather than a straight line. A line would slide along the top edge because the box already touches top at the original-location limit. This curve separates the upper edge at intermediate factors by up to about 21 px on a 1080-high display, then smoothly stops at center. Box edges are also clamped inside the viewport.
4. Width-limited portrait viewports keep their previous limit and position. A real progress ring also prevents movement: task subtitles sit below it and the complete ring must fit.

Radius and center are continuous functions of zoom, which comes only from measured distance events and settings (`SenseController` → `setBrainZoom`). `Brain.step()` applies existing easing, k = min(1, dt × 5) per frame, to both. Walking away reduces zoom and retraces the path. Without distance events there is no movement.

`--brain-cy` eases and publishes to CSS along with `--brain-r`. Subtitles, command line, start-voice button, and conversation status replace `47vh + k × --brain-r` with `var(--brain-cy, 47vh) + k × --brain-r`. By the time centering starts, these elements already reach their existing lowest positions (`100dvh − 120/140/160/170px`, unchanged in this batch). The first version's JS `ZOOM_BOTTOM_RESERVE_PX`, copied from CSS's 140 px, was removed; no constant needs JS/CSS synchronization.

“Larger when farther” text scaling (docs/10 §2) is unaffected: text, panels, and top thumbnail remain × D ÷ 2.0 m. With a panel, the brain uses `layout: "top"` and does not apply proximity zoom/centering.

<a id="數字程式算出"></a>
### Calculated numbers

Produced by `npx tsx scripts/brain-zoom-table.ts` in `prototype/ambient-shell`, calling `brainGeometry`. At 1920×1080 with maximum 3×, centering begins at 1.42 m and reaches the limit within 1.01 m, calculated by a 1 cm distance sweep.

| Distance | Factor, maximum 3 | Actual radius | Center / visual center |
| --- | --- | --- | --- |
| 3 m, 2.5 m | 1 | 216.0 px (1.00×) | 507.6 / 480.6 px |
| 1.55 m | 2 | 432.0 px (2.00×) | 507.6 / 453.6 px |
| 1.42 m | 2.14 | 462.2 px (2.14×) | 509.2 / 451.4 px |
| 1.3 m | 2.26 | 488.2 px (2.26×) | 555.5 / 494.5 px |
| 1.2 m | 2.37 | 511.9 px (2.37×) | 585.4 / 521.5 px |
| 1.1 m | 2.47 | 533.5 px (2.47×) | 602.3 / 535.6 px |
| Within 1.01 m | 2.57–3 | 553.8 px (2.56×, viewport-limited) | 609.2 / 540.0 px |

At maximum 2× behavior is entirely unchanged: 432 px radius and 507.6 px center at 0.6 m.

Actual reachable factor when requesting 3×:

| Viewport | 1× radius | Before | Now | Visual center / window center | With real progress ring |
| --- | --- | --- | --- | --- | --- |
| 1920×1080 | 216.0 px | 2.14× | 2.56× | 540.0 / 540.0 px | 1.57× |
| 1512×982 | 196.4 px | 2.14× | 2.56× | 491.0 / 491.0 px | 1.57× |
| 1440×900 | 180.0 px | 2.14× | 2.56× | 450.0 / 450.0 px | 1.57× |
| 2560×1440 | 288.0 px | 2.14× | 2.56× | 720.0 / 720.0 px | 1.57× |
| 1366×768 | 153.6 px | 2.14× | 2.56× | 384.0 / 384.0 px | 1.57× |
| 1280×900 | 180.0 px | 2.14× | 2.56× | 450.0 / 450.0 px | 1.57× |
| 390×844 | 78.0 px | 2.00× | 2.00× | 377.2 / 422.0 px, no movement | 1.67× |
| 844×390 | 78.0 px | 2.14× | 2.56× | 195.0 / 195.0 px | 1.57× |

<a id="和按鈕字幕的重疊chromium-量測simulated"></a>
### Button/subtitle overlap: Chromium measurements, SIMULATED

Case `proximity-zoom-centered-max-3` in `scripts/verify-distance-brain-browser.mjs`: 1920×1080, maximum 3×, 0.6 m, reduced motion. The brain does not sway; this measures one pose. Unit tests measure normal-motion extents. Chromium 141.0.7390.37.

| Item | Measurement |
| --- | --- |
| 3 m | Center 507.6 px, radius 216 px |
| 0.6 m | Center 609.23 px, radius 553.85 px; visual center 540.00 px; CSS `--brain-cy` 609.23 px, `--brain-r` 553.85 px |
| Particle extent, 775 particles | Top 41.4 px, bottom 1012.8 px |
| Start-voice button | 940–984 px, background `rgba(9, 16, 30, 0.74)`, z-index 4; two particles in its box |
| `elementFromPoint` at button center | Button itself; actual click reaches button (capture phase's first target is `start-conversation`), then opens settings because fixture is logged out; brain returns to top |
| “Click brain to start…” hint | 997–1015 px, no background; two particles in box |
| Task subtitle, FIXTURE sample | 920–970 px, no background; 17 particles in box |
| Conversation status, FIXTURE sample | 923–941 px, no background; one particle in box |
| Return to 3 m | Center 507.6 px, radius 216 px |

Subtitles/status do not coexist with a centered brain in this fixture: a task progress ring prevents centering and conversation opens a Surface. The case directly displays FIXTURE sample text only to measure CSS positions and particle overlap, not to represent a real simultaneous workflow.

Readability from screenshot inspection, not measurement: the translucent button background keeps text clear. Hint, subtitle, and status have no background and overlay brainstem/cerebellum particles and links. Particle counts are low, 1–17 in each box; text is visible but busier than without zoom. In the sample screenshot, subtitle, status, and button overlap one another because all three have reached their lowest positions, 920, 923, and 940 px. Those positions were not changed here; they already overlapped when shown together.

| Ambient, 0.6 m, maximum 3× | Sample subtitle/status | After button click |
| --- | --- | --- |
| ![Ambient](./small-decisions-2026-10-25/brain-zoom-max-3-centered-at-0.6m-SIMULATED.png) | ![Samples](./small-decisions-2026-10-25/brain-zoom-max-3-centered-caption-status-samples-SIMULATED.png) | ![After button](./small-decisions-2026-10-25/brain-zoom-max-3-centered-after-button-click-SIMULATED.png) |

Screenshots have a yellow SIMULATED label at the bottom; distances are synthetic events with no camera images. Reproduce:

```bash
cd prototype/ambient-shell && npx vite build && cd ../..
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chrome \
  node scripts/verify-distance-brain-browser.mjs --case proximity-zoom-centered-max-3 --output /tmp/aios-zoom-center \
  --screenshots docs/validation/small-decisions-2026-10-25
```

<a id="測試"></a>
### Tests

Three additions to `tests/brain-distance.test.ts`:

- Maximum: 2× unchanged; at 3×, R = 1080 ÷ 1.95, visual center 540 px, box touches top/bottom. 1366×768 also centers; 390×844 does not move; progress ring prevents movement.
- Intermediate factors: sweep 1920×1080, 1366×768, and 844×390 every 0.005×. Radius/center are monotonic; per step radius changes <2 px and center <0.3% viewport height; stays inside viewport. Beyond original-location limit, upper edge leaves top by more than 2% of viewport height instead of sliding against it; final visual center is h ÷ 2. At 1.2/1.5/2× center remains 47%.
- Renderer with normal motion: no distance event means no movement; at 0.6 m first frame moves partly, then eases to target; CSS `--brain-cy`/`--brain-r` follow drawing and click area follows new center. Over 300 frames particles stay inside viewport and vertical midpoint is within 3% of 540 px. Return to 3 m restores position.

Existing viewport-bound tests (maximum 3×, multiple viewports, with/without progress ring, particles inside viewport) pass unchanged.

<a id="2-關冷氣時說出會取消定時"></a>
## 2. Say that turning AC off cancels timers

The source is George's description of fixed controller behavior. AIOS cannot inspect controller code or read AC timers, so it speaks without claiming to know whether a timer exists.

`server/home-bridge.ts`: for AIFA AC `power false`, add a result `note` according to controller reply. `note` contains only the sentence to speak.

| Controller reply | `note` |
| --- | --- |
| Sent, `unconfirmed`/`one_way` | `AC_OFF_TIMER_NOTE`: “If this air conditioner has a timer, the controller also cancels it when powering off. Set it again if needed.” |
| No controller reply, may have received, `no_reply` | `AC_OFF_TIMER_NOTE_UNSURE`: “If the controller executed this power-off and this air conditioner has a timer, that timer is also canceled. Set it again if needed.” |
| Failure, 200 `failed`; not sent; power on; IR appliance | None |

Prohibited claims live in model tool rules `realtimeToolRules` (`server/realtime.ts`, shared by API-key voice and ChatGPT-plan executor): if AC-off note mentions timers, AIOS cannot read timers and must not say a timer definitely existed/was canceled or that the AC is already off. The same rules already require reading notes.

`homeControlLine` subtitle stays “⏳ 客廳 冷氣 關閉：已送出，請確認” (“living room AC off: sent, please confirm”).

No reminder on 200 `failed`: controller reports no off command sent, so timers should be unaffected. Whether it still cancels a timer in that situation needs George's hardware test below.

<a id="行為改變no_reply-的系統通知帶附加事實"></a>
### Behavior change: `no_reply` system notices include additional facts

After a confirmation card, `homeControlNotice` in `shared/home.ts` turns results into system notices. Previously only `one_way` and `cloud_no_reply` appended `factsText`; `no_reply` did not. Now it does, so the no-controller-reply timer reminder is spoken. Scope extends beyond AC off: AIFA-setting `no_reply` notices now include sent settings and defaults used; infrared `no_reply` notices include toggle-button explanations. Realtime paths taking result JSON directly already see these fields, unchanged.

<a id="測試-1"></a>
### Tests

Two additions to `tests/home-bridge.test.ts`:

- AC off: sent note equals `AC_OFF_TIMER_NOTE`, notice includes it, subtitle unchanged. Neither reminder contains “must not say” or “AIOS”; prohibitions belong to `realtimeToolRules`. No reply uses `AC_OFF_TIMER_NOTE_UNSURE`, included in notice. 200 `failed`, 409 not-sent, AC on, and IR television off do not mention timers.
- `ac_temperature` plus `no_reply`: notice includes “sent settings: cooling mode, 26 degrees, low fan, automatic swing,” without timers.

<a id="3-冷氣關著時模式預設改成自動"></a>
## 3. Default off-AC mode to automatic

`CLIMATE_DEFAULTS.mode` changes from `"cool"` to `"auto"`. If capabilities omit automatic, use the first available mode, preserving the existing fallback. Defaults remain listed in `defaults_used`; model says controller did not report mode and automatic was used. Reported mode takes priority over defaults.

`sent_settings` prefixes mode with “模式” (“mode”): instead of ambiguous “cooling, 26 degrees, low fan, automatic swing,” it says “cooling mode, 26 degrees, low fan, automatic swing.”

Documentation strings changed in `shared/voice-commands.ts` for the 26-degree command defaults and `home_control` AC-off timer explanation; README command table regenerated with `npm run docs:commands`; README AIFA section; docs/12 AIFA settings/power; `shared/home.ts` `sent_settings` comment. H1b validation and docs/11 retain original text with a dated 2026-10-25 addition.

Tests change three existing expectations in `tests/home-bridge.test.ts` (off-AC 26 degrees, unreadable `/status`, `buildClimate` default list: cooling → automatic, sent `mode` → `auto`). Also checks automatic default, fallback to cooling when automatic unavailable with disclosure, and reported mode precedence. Prefixing `sent_settings` changes four home-bridge expectations plus one `buildClimate.text`, one `tests/http.test.ts`, and one `tests/realtime-voice.test.ts` fixture result passed verbatim to the model.

<a id="自動檢查"></a>
## Automated checks

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` in `prototype/ambient-shell` | Pass |
| `npx vitest run` | 795 tests in 48 files pass, previously 790 |
| `npx vite build` | Pass |
| `node --check desktop/main.mjs` | Pass |
| Repository root `node scripts/verify-aios.mjs` | PASS |
| `git diff --check` | Pass |
| `scripts/verify-distance-brain-browser.mjs`, all cases | Eight cases pass, SIMULATED |

<a id="什麼是-fixture什麼是真的"></a>
## Fixtures and real evidence

| Item | Status |
| --- | --- |
| Centered-zoom geometry, easing, hit area, button clicks | Unit tests and real Chromium page; distance events and APIs are fixtures |
| Subtitle/status overlap with brain | Actual Chromium CSS; FIXTURE sample text |
| AC-off timer wording/default mode | Fake controller fixture; no real AC or spoken model |
| Controller cancels timer on AC off | Behavior supplied by George; controller code not read and no hardware test here |
| macOS app and physical stereo camera | Not run |

<a id="george-在-mac家裡的測試步驟"></a>
## George's Mac/home test steps

Brain:

1. After update, `npm start` or reopen macOS app; camera dot at bottom right is green.
2. Menu-bar duration/zoom settings → proximity brain zoom maximum → **3×**.
3. Start around 3 m, then slowly approach 2 m, 1.4 m, 1.2 m, 1 m, and 0.6 m, pausing 2–3 seconds each. Growth starts within 2.5 m; downward movement starts around 1.4 m; maximum around 1 m fills nearly all height with apparent center at screen center. Lower brain extends behind start-voice button/hint.
4. At maximum press start voice conversation. It must activate the button rather than count as a brain click. Check hint readability.
5. Return to 3 m; original size/position should return in a little over half a second.
6. Select **2×** and repeat step 3. No movement is needed at 2×.
7. Report maximum size, smoothness of centering, and button/hint readability over the brain.

Air conditioner, following [H1b steps](smarthome-h1b-2026-10-22.en.md#george-家裡的實機驗證步驟):

1. Set an AC timer in AIFA app/controller, say turn AC on, then turn AC off. Nous should give the conditional timer-cancellation reminder, not claim the AC is already off or the timer definitely canceled. Record whether controller/AIFA timer was actually canceled: ____.
2. Without a timer, say turn AC off again. Same reminder is expected because AIOS does not know whether a timer exists. Report if redundant; conditional reminders based on real timer presence require controller-provided timer information.
3. On AC-off failure, for example disconnected AIFA account and failure subtitle, Nous does not mention timers. Check whether the timer was canceled anyway: ____. If so, failure results also need a reminder.
4. With AC off, request 26 degrees. Nous must disclose default automatic mode and that setting it does not mean powering on. Then power on and record actual panel mode/temperature; some ACs show no setpoint or a different number in automatic mode: mode ____, temperature ____.

<a id="未完成與疑慮"></a>
## Remaining work and concerns

- Brain: full 3× cannot fit landscape viewports; about 2.56× is the geometric maximum. Brainstem/cerebellum sit behind controls at maximum; George must assess background-free text readability on hardware.
- Subtitle, status, and button overlap at lowest positions, 920/923/940 px; pre-existing and unchanged. They rarely coexist in real flows, but every combination was not validated.
- Timers: AIOS does not know timer presence and reminds on every AIFA AC-off. Unknown whether controller cancels timers on 200 `failed` too.
- Adding facts to `no_reply` system notices affects AIFA settings and infrared as described above.
- Hardware: macOS app, perceived movement under stereo distance, real AC, and real model speech remain unvalidated.
- Formal hardware/AI gate status is unchanged. Next gate is George's Mac/home testing, docs/11 §7 V1 and docs/12 H1b.
