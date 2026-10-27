<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-distance-2026-10-22.md) | [English](brain-distance-2026-10-22.en.md)

<a id="電子腦雙目距離縮放驗證"></a>
# Brain stereo-distance scaling validation

2026-10-22; base `16dc63cafd949a0e195d94e693afd3ba0d823d1d`. This record accompanies the brain distance-scaling feature.

> **Partially superseded 2026-10-23:** George decided that the ambient brain should grow as the user approaches, up to a user-configured maximum, instead of following D ÷ 2 m below. The top thumbnail and text scaling stay unchanged. See [brain proximity-zoom validation](brain-proximity-zoom-2026-10-23.en.md) for the new rules, measurements, and screenshots. Ambient radii below are historical measurements.

The brain now receives the existing `SenseController.setScale` distance factor. Ambient and top graphics, halos, projection, and click areas share the actual radius; task and conversation updates retain the factor. Null distance events, departure, and camera off/error/degraded use the controller's existing resets. `starting` retains the latest factor; the existing 60-second departure decision is unchanged.

<a id="距離與畫面量測"></a>
## Distance and display measurements

The factor remains `clamp(round(D / 2 × 100) / 100, 0.75, 1.5)`. Radius is additionally limited by available viewport space, including halo and breathing-animation bounds. These measurements directly observe native Canvas drawing in Chromium at 1280 × 900 with reduced motion.

| Simulated distance | Controller factor | Actual radius |
| --- | --- | --- |
| 1.5 m | 0.75 | 135 px |
| 2 m | 1 | 180 px |
| 3 m | 1.5 | 248.824 px, viewport-limited |
| Camera off | 1 | 180 px |

Each observation waits for two stable native drawing frames after its request and records frame IDs and timestamps. On phones and short landscape viewports, the top source row maintains a 6 px gap from the panel at all three distances.

<a id="變更檔案"></a>
## Changed files

| File | Purpose |
| --- | --- |
| `prototype/ambient-shell/src/main.ts` | Existing distance callback also notifies Brain |
| `prototype/ambient-shell/src/brain.ts` | Separate distance input, radius limits, label bounds, and CSS radius publication |
| `prototype/ambient-shell/src/style.css` | Entry, input, and source-row positions follow effective radius; panel distance scaling remains applied once |
| `prototype/ambient-shell/tests/brain-distance.test.ts` | 18 new drawing and controller behavior tests |
| `prototype/ambient-shell/tests/brain-regions.test.ts` | Updated existing renderer DOM fixture |
| `scripts/verify-distance-brain-browser.mjs` | Synthetic-distance browser validation on the real built page |
| `prototype/ambient-shell/README.md`, `docs/11_Stereo_Camera_Interaction_2026-10.md` | Scaling behavior and limitations |
| This record and `evidence/brain-distance-2026-10-22/` | Designs, review, measurements, and original screenshots |

<a id="pstack-流程"></a>
## pstack workflow

Followed the Feature playbook: how → architect → checkpoint → implement → verify → review → report. After comparing two independent designs, independent judgment selected `Brain.setDistanceScale`: distance and ordinary visual snapshots have different update lifetimes, and the controller remains the sole distance-policy source. The checkpoint assigned one code owner, with separate browser, documentation, and review owners. Every role inherited the parent model; no model diversity was claimed.

Model the Domain preserves input lifetime; Laziness Protocol extends existing geometry and resets; Test Behavior Not Implementation checks visible drawing and click results; Prove It Works exercises the built page. New-comment review required no deletion or suppression rules. Commit and PR steps were skipped because neither was requested. Native Cursor UI tools were unavailable, so Chromium/Playwright validated the actual page.

[Design A](evidence/brain-distance-2026-10-22/design-a.md), [design B](evidence/brain-distance-2026-10-22/design-b.md), [judgment](evidence/brain-distance-2026-10-22/judgment.md), [independent review](evidence/brain-distance-2026-10-22/review.md), and [plan](evidence/brain-distance-2026-10-22/plan.md).

The [pstack run](https://github.com/pcpcchen-coder/AIOS/blob/telemetry/pstack/observability/public/runs/run-20261022010402-0fb7c0.json) published de-identified stage metadata through the project-approved sidecar. After the initial default transport failed, Git transport succeeded. No source code or private conversation was published.

<a id="驗證結果"></a>
## Validation results

- `node scripts/check-pstack.mjs`: upstream integrity and skill registration pass.
- `node scripts/verify-aios.mjs`: type checking, 307 tests in 32 files, build, isolated mock task HTTP, and text-chat journey pass. [Test output](./evidence/brain-distance-2026-10-22/test-output.txt), [HTTP report](./evidence/brain-distance-2026-10-22/mock-http-report.json).
- Independent review separately ran 35 relevant tests in three files, all passing. Both that run and the full suite precede the final CSS-spacing fix; the app was rebuilt afterward and every browser case ran against the final assets.
- Six Chromium groups pass with no page errors: distance and SSE refresh, null and sensor resets, top graphic and single panel scaling, desktop/phone/short landscape/resize/DPR2, six-region labels and complete input, actual clicks, and the “鏡頭關掉” (“camera off”) command. [Raw measurement report](./evidence/brain-distance-2026-10-22/report.json).
- Browser checks found that the near-distance source row initially overlapped the panel by about 1.42 px. Shared panel-position calculation fixed it and final cases pass. Existing far-distance settings-panel CSS zoom overflow remains, including an offscreen close button on some screens. The report retains its bounds; Esc closes it. This batch did not change that pre-existing issue.

The final browser report includes per-file source/shared/dist hashes, actual returned asset hashes, and hashes before/after the synthetic pipeline substitution. They match the workspace, and source/dist did not change during validation. Original JSON retains the temporary output paths used then; all same-named PNGs were copied into the evidence directory beside this record.

| Input | SHA-256 |
| --- | --- |
| Frontend source set | `6ad0c29e7016b10715183119bb42b3c333bcce4996b9c32b18ef43c583d57bbe` |
| dist set | `90ffda33c32c8aa6e82705d7aa26dcfacda4e9e2774200e698edfdcce9e05318` |
| Browser script | `963d1367239fbc4520d22a606de72732df08f703d52bb1827ccb67db433786d1` |

<a id="畫面證據"></a>
### Visual evidence

Every image is labeled fixture; accounts, events, and distances are synthetic inputs. No raw camera images appear.

| Far-distance ambient | Default restored after camera off |
| --- | --- |
| ![Far-distance brain](./evidence/brain-distance-2026-10-22/far-distance-fixture.png) | ![Brain after camera off](./evidence/brain-distance-2026-10-22/camera-off-reset-fixture.png) |

[Phone six regions](./evidence/brain-distance-2026-10-22/active-390x844-far-fixture.png), [short-landscape six regions](./evidence/brain-distance-2026-10-22/active-844x390-far-fixture.png), [phone top graphic](./evidence/brain-distance-2026-10-22/top-390x844-far-fixture.png).

<a id="啟動與重現"></a>
## Start and reproduce

```bash
cd prototype/ambient-shell
npm ci
npm start
```

Open `http://localhost:8787`. To use a physical camera, follow the prototype README: set `NOUS_CAMERA=on` in `.env`, first run `npm run vision:setup`, and ensure the camera setting is on. This batch did not change environment variables, download models, or open physical devices.

To reproduce automated checks, run from the repository root:

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/usr/bin/chromium \
  node scripts/verify-distance-brain-browser.mjs --output /tmp/aios-distance-check
```

The browser script requires available Playwright and Chromium and uses dist from the previous step. This cloud environment used Node 24.19.0 and Chromium 154.0.8037.57.

<a id="未完成與下一個-gate"></a>
## Remaining work and next gate

This run substitutes only the external `SensePipeline` module and provides simulated APIs. The actual main app, controller, Canvas, and pointer events execute. Physical stereo processing, distance accuracy, real accounts, voice, and touch were not validated. Reduced motion validates final geometry; source review covers normal animation interpolation.

The next gate follows `docs/11` §7 after calibrating physical stereo equipment: test 1.5/2/3 m, stability while moving, and camera-interruption reset. This record does not change formal hardware or AI gate status. Existing settings-panel overflow on small screens needs separate work.
