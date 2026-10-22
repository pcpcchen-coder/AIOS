# Candidate A: renderer distance input

This candidate uses the inherited parent model. No model diversity is claimed.

## Caller usage

The existing stereo controller remains the only distance-to-scale policy. Its same callback drives DOM zoom and the brain. There are no manual settings or persisted values.

```ts
const sense = new SenseController({
  ...hooks,
  setScale(scale) {
    document.documentElement.style.setProperty('--distance-scale', String(scale));
    brain.setDistanceScale(scale);
  },
});
brain.setState(nextVisualState); // Does not overwrite the last measured scale.
// Existing off/error/degraded/absence events already call setScale(1).
```

## Data shape and signatures

```ts
class Brain {
  private distanceScale = 1;
  setDistanceScale(scale: number): void { throw new Error('not implemented'); }
  private target(layout = this.state.layout): { cx: number; cy: number; r: number } {
    throw new Error('not implemented');
  }
}
```

`distanceScale` is renderer input, separate from frequently replaced `BrainVisualState`. `SenseController` owns conversion, bounds0.75–1.5, presence filtering and reset timing. The setter accepts this bounded scalar, keeps ordinary visual-state updates from resetting it, and refreshes the ambient CSS radius only when scale changes. A non-finite input can recover to1 without defining another distance-to-scale mapping. Do not introduce a generic settings store or new exported scale policy.

`target(layout)` is the one private geometry calculation. Constructor, animation and resize use it. Renderer state keeps the animated center/radius used by projection, labels, effects and hitTest. The public interface is one setter; callers never coordinate resize, target and hit geometry themselves.

## Geometry and fit policy

Requested radius is `min(width,height) * LAYOUT[layout].r * distanceScale`.

Center-layout center remains `(width/2,height*.47)`. Top-layout center is `(width/2,height*.12*distanceScale)`, matching the existing zoomed panel's physical center-height term.

Fit the radius to a conservative1.7-radius envelope around that center: the minimum of requested radius, horizontal room/1.7 and vertical room/1.7. The envelope exceeds1.62×1.018 orbital extent including breathing. It supplies its own edge clearance; an additional12px top margin would unnecessarily clip the requested factor in top mode. Effective radius can stop growing before scale1.5 on constrained displays. The existing distance value and DOM zoom remain unchanged. Document this visual fit cap rather than claiming exact1.5 rendered growth on every viewport.

Publish only the effective center-layout radius as `--brain-r` after construction, scale or viewport changes. Keep `--brain-top-r` at its unscaled base. Existing `.surface-root` parent zoom already multiplies its entire top position. Multiplying that variable again would compound the panel spacing. The top-layout brain center and radius both consume the factor exactly once.

Canvas remains full-viewport with existing DPR handling. Do not CSS-scale it, inverse-map clicks or change sensor measurement/filtering. HitTest keeps the same animated radius as drawing during transitions.

## Bounded surrounding layout

The ambient CTA and command positions consume effective `--brain-r`. Clamp their top positions against viewport-safe maxima. One CSS CTA anchor can serve the button and the aggregate activity text below it. Keep the known command form reserve at least120px on short landscapes, subject to actual bounding-box verification.

Use existing body view classes to place source text. Ambient source text belongs below the CTA, typing source text can occupy a top status row, and top/settings text can use one visual row with ellipsis while retaining complete DOM text. Existing conversation placement remains separate. Explicit status width prevents shrink-to-fit half-screen wrapping. Do not infer clearance from a single-line paragraph assumption.

Bound active canvas labels using measured text width and viewport margins, with minimum12px font. Retain the full source descriptions in the DOM. This handles growing-brain labels without introducing a label-placement engine.

The existing camera-driven parent zoom can widen a settings panel beyond a small screen even before this feature. Verify it, identify it as existing behavior if present, and avoid a general distance-UI redesign unless it prevents this task's controls from being used.

## Module map and ownership

- `main.ts` extends the existing setScale hook to call the renderer.
- `brain.ts` owns scale input, effective geometry, CSS ambient-radius publication and bounded labels.
- `style.css` keeps ambient controls reachable and leaves parent distance zoom intact.
- Focused tests assert native-visible radius/hit behavior, refresh persistence and reset events.

No server, camera pipeline, shared sensing contract, package, storage or manual controls need to change.

## Alternatives and red flags

A `distanceScale` field in `BrainVisualState` would require main to store it, call render on sensor events and pass it on every subsequent render. That makes a forgotten caller reset the graph while DOM zoom retains the last measurement. A dedicated setter hides that lifetime difference.

Reading CSS custom properties from each animation frame would make the renderer depend on a DOM string and add repeated computed-style work. A mutation observer adds another lifecycle. Neither improves ownership over the explicit callback.

The renderer's scalar is a consumed input, not a second distance policy. The only geometry calculation is private. The CSS radius is a derived output. No persistence, inverse coordinate path, extra boolean or second renderer is introduced. Model the Domain separates measured input from visual-state refresh; Laziness Protocol preserves existing projection and sensing lifecycles.

## Verification contract

Browser fixtures emit synthetic near1.5m, reference2m and far3m events through the real camera pipeline boundary and actual main/controller hook. Observe fresh native canvas frames, not only CSS variables. Verify default<far and near<default where uncapped, the stated fit cap, center/top alignment, repeated visual renders, resize/DPR, scaled click targets, six active labels and UI/status bounds.

Exercise present+null and off/error/degraded/true-to-false absence resets to1. Preserve the current60s absence semantics. Use labeled fixture screenshots and source/build hashes. Physical stereo accuracy and real camera permission/device behavior remain unverified by those fixtures.
