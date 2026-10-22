# Stereo distance and brain sizing

## Overview

The current stereo pipeline already produces one bounded distance scale and resets it when sensing is unavailable. `main.ts` applies that scale to DOM content only. The brain uses a full-viewport Canvas and an independent animated radius, so it currently ignores distance.

## How it works

`src/sense/processor.ts:46–61` triangulates the nose and shoulders from both eyes, takes their depth median, and passes it through `PresenceTracker`. The tracker in `src/sense/trackers.ts:7–60` requires500ms for entry, holds presence for60s after missing detections, keeps9 distance samples, and reports changes of at least10cm. Missing new depth can retain the prior median; it does not immediately reset every frame.

`src/sense/controller.ts:42–45` maps distance to `clamp(distanceM/2,0.75,1.5)`, with null mapped to1. `SenseController.handle` calls the existing `setScale` hook for present events atline68. It calls `setScale(1)` when presence transitions tofalse at64, or a sensor state is neither `ok` nor `starting` at82–88. Thus `off`, `error` and `degraded` already reset; `starting` intentionally does not.

`src/main.ts:479` currently implements that hook by writing only `--distance-scale`. `syncCamera` at517–527 starts/stops the pipeline, whose callback passes every event to `sense.handle`. `SensePipeline.stop` at118–125 emits `sensor:off` followed by absent presence; failed startup emits `sensor:error` at111–114. A real camera off/error/degraded event therefore reaches the same reset hook as distance changes.

`src/brain.ts:194–196` computes center and radius from viewport and `LAYOUT` only. The animation at418–422 moves `cx`, `cy` and `radius` toward that target. All node projection, effects, labels and rings consume the animated radius at434–480. `hitTest` at190–191 uses the same animated radius, so updating the target radius keeps click geometry aligned without a CSS transform or inverse pointer mapping.

## DOM placement and native CSS evidence

`src/style.css:13–14` defines separate base ambient and top radii. Ambient captions, command, start button and status use `--brain-r` at80,125,853,867. The settings/progress surface uses `--brain-top-r` in its top and max-height calculations at248–276. `.surface-root` and `.subtitle` receive `zoom:var(--distance-scale,1)` at982–985.

An isolated native Chromium probe at1280×900 used those exact surface rules. It did not alter the application or repository.

| Configuration | Physical panel top | Physical width |
| --- | ---: | ---: |
| scale1, original base radius |217.34px|780px|
| scale1.5, original base radius |326.02px|1170px|
| scale1.5 and top CSS radius multiplied1.5 again |394.53px|1170px|

The original top calculation is `.12×900 + .07×900×1.45 +18 =217.35`. Physical top atscale1.5 is that whole expression multiplied1.5. Blindly multiplying `--brain-top-r` again compounds the radius term.

A narrow coherent integration can keep that top CSS radius at its original base, apply the existing scale to both top-layout brain center-height and radius, and keep center-layout height at47vh. Then the top brain and zoomed panel maintain the existing gap. `--brain-r` is ambient-only, so its separate use can track scaled ambient radius without scaling the top panel twice.

## Where things live

- `src/sense/processor.ts`, `trackers.ts`, `controller.ts` own measurement, stability and the existing scale/reset policy.
- `src/main.ts` owns the scale hook connecting sensing to DOM and brain.
- `src/brain.ts` owns animated geometry and click targeting.
- `src/style.css` owns the ambient controls and already-zoomed content panel.

## Gotchas and bounded next change

Connect the existing hook to a renderer distance-scale input and keep its value across ordinary `setState` renders. Reuse the existing0.75–1.5 range and reset events. Do not reintroduce localStorage or manual zoom controls.

At center scale1.5, an unbounded radius is30% of the smaller viewport dimension. Orbits reach1.62R at `brain.ts:564`, plus1.8% breathing at438. A conservative envelope can extend above the viewport because centerheight remains47%. Verify actual visible geometry or explicitly constrain fitting; do not infer it from the percentage alone.

Active labels at349–380 sit outside the brain and have no viewport clamp. Growing the radius can clip labels on narrow screens. Ambient controls use the old fixed offsets and may overlap the enlarged brain or leave short viewports unless their sizing follows the effective geometry. Top controls already have parent zoom, so measure real bounds before changing their placement.

Verify normal and top layouts, near/nominal/far distances, null/off/error/degraded reset, ordinary state refresh, resize, the actual Canvas radius and click target. Browser fixtures can simulate sensor events at the external sensing boundary but cannot prove AR0144 accuracy or physical camera behavior.

No low-quota warning or percentage was observable during this read-only grounding.
