# Candidate B: distance in the complete visual snapshot

Same inherited model as the other candidate. No model diversity claimed.

## Caller-first usage

A measured presence event sets one main-owned distance factor. The next complete visual snapshot carries that factor together with layout, conversation and task activity. Ordinary task/audio refreshes include the same current factor. Existing controller reset events set it back to1.

```ts
let sensedScale = 1;
const sense = new SenseController({
  ...existingHooks,
  setScale(scale) {
    sensedScale = scale;
    document.documentElement.style.setProperty("--distance-scale", String(scale));
    render();
  },
});
function render() {
  brain.setState({ ...existingVisualFields, distanceScale: sensedScale });
}
```

## Types and ownership

```ts
export interface BrainVisualState {
  // Existing fields remain required as today.
  distanceScale: number;
}
interface BrainTarget { cx: number; cy: number; r: number }
function brainTarget(width: number, height: number, state: BrainVisualState): BrainTarget {
  throw new Error("not implemented");
}
```

`SenseController` retains the D/2m,0.75–1.5 policy and reset semantics. Main owns the latest sensor factor. `Brain` owns only its complete visual snapshot plus interpolated geometry. Make the field required, including the initial state, so an ordinary setState cannot silently default distance back to1. No localStorage or UI preference exists.

Model the Domain favors this shape when every rendering input belongs in one snapshot. The renderer does not import the sensing controller or read CSS on each frame. The input is already bounded by the internal controller; no new distance mapping policy belongs in the renderer.

## Geometry applied once

For center layout, keep `cy=.47H` and request `r=.2*min(W,H)*distanceScale`. Fit only the actual Canvas radius if needed, using a conservative1.7R orbit envelope that covers current1.62R orbits and1.8% breathing. Preserve the requested sensor factor for DOM scaling. Projection, rings, pulses and hitTest continue consuming the same animated radius.

For top layout, request both `cy=.12H*distanceScale` and `r=.07*min(W,H)*distanceScale`. Existing parent CSS zoom already scales the panel top. Keep `--brain-top-r` at its baseline value inside that zoomed panel; multiplying it again produces the double-positioning proved in ground.md. Apply only a screen-fit cap when the actual orbit would leave the viewport. Do not introduce an independent pointer transform.

The renderer can publish its effective ambient radius as `--brain-r` when distance/state/viewport changes, deriving it from the same target function. The top CSS radius remains unscaled because it is consumed inside CSS zoom. This explicit distinction is smaller than a generic layout/preferences subsystem.

## Bounded layout policy

Ambient CTA and command positions follow effective ambient radius and retain viewport-safe maxima. A shared CTA anchor lets activity status sit below it with explicit90vw/760px width. Typing status can occupy the top area, while top/settings status uses one visual row with complete DOM text retained. Preserve conversation's existing dedicated placement.

Canvas labels keep their existing minimum font and clamp measured text placement to viewport bounds. Do not shrink text merely to hide overflow. Verify far scale with six simultaneous regions on phone portrait and landscape.

Existing CSS zoom may itself make panel width/max-height exceed a phone viewport at1.5. This is a measurement gate, not a reason to change the distance policy. If actual bounds prove controls inaccessible, compensate the panel's available viewport width/height once in its existing CSS rules, without multiplying the renderer radius twice or rebuilding presentation state.

## Comparison with a dedicated setter

| Shape | Benefit | Cost |
| --- | --- | --- |
| Complete snapshot | One renderer update path; required field prevents hidden defaulting; state fixtures describe the whole picture. | Adds main scalar and render invocation to sensor events; every snapshot producer/test must include scale. |
| Dedicated setDistanceScale | Existing sensor hook directly updates renderer without rerendering unrelated DOM. | Renderer has a second state input, and future setState implementations must preserve it deliberately. |

Both are valid. Candidate B is preferable if the project wants all visual inputs modeled in BrainVisualState. For this narrowly scoped feature, Laziness Protocol may favor the dedicated setter because the existing sensor hook is already the boundary and distance need not rebuild unrelated views. Do not graft both APIs together.

## Verification and red flags

Browser proof must inject at the camera-pipeline boundary and run actual main/controller wiring. Observe two fresh native Canvas frames, then compare near1.5m/reference2m/far3m geometry, click targeting, top/center layouts, resize and repeated unrelated renders. Null, absence, off, error and degraded events must recover1. Starting preserves the existing controller policy. Test published CSS geometry separately from already-zoomed panel physical bounds.

Prove It Works requires real built-page screenshots and native pointer/Canvas observations. Fixtures do not prove AR0144 accuracy or real camera behavior. No quota percentage or low-limit warning was visible.

Red-flag screening: one main scalar and required complete snapshots avoid two independent writers; one target calculation avoids duplicated radius policy. A setter plus snapshot field would create two competing ways to update the same value. A generic preference store, second distance conversion or CSS-scale pointer mapping would widen the interface without earning its cost.
