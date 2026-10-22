# Distance brain design cross-judgment

Choose A, the dedicated renderer distance input. Both candidates use the inherited parent model; this is independent review, not model diversity.

Scores are qualitative, from0–2 per stated criterion.

| Criterion | A | B |
| --- | ---: | ---: |
| One existing distance policy and reset path | 2 | 2 |
| Sensor-input lifetime survives unrelated state updates | 2 | 2 |
| Actual renderer, hit targeting and DPR stay coherent | 2 | 2 |
| No doubled top CSS zoom and bounded viewport fit | 1 | 1 |
| Minimum scope and no manual preferences | 2 | 1 |
| Total | 9 | 8 |

A connects the existing SenseController hook to one renderer setter. It preserves the measured input without making sensor events rerender unrelated DOM or requiring every visual snapshot producer to carry another field. B is coherent when its field is required everywhere, but adds a main-owned scalar and render calls for no additional user behavior in this narrow task. Do not combine the two APIs.

Model the Domain favors keeping the measured input separate from frequently replaced task/audio visual state. Laziness Protocol favors A's existing callback boundary and smaller caller change.

Both candidates already agree on the useful geometry details, so no graft is required. Scale top-layout center and radius once, retain the unscaled top CSS radius within the already-zoomed panel, and publish only the effective ambient radius. Keep the existing distance conversion, reset semantics, sensor filtering and privacy boundaries.

No proven design blocker prevents implementation. The viewport-fit score remains1 until the actual built Canvas, native click area, active labels and surrounding controls are checked. Prove It Works requires fresh native frames rather than a scale variable alone. The existing far-phone panel-width overflow is baseline parent-CSS behavior; report it separately instead of silently widening this feature into a distance-UI redesign.

Accept A only with regression proof that ordinary setState refreshes retain the last distance and that null/off/error/degraded/absence events reset both DOM and brain through the real controller hook. Screen-fit caps may limit effective Canvas growth without changing the existing DOM distance factor; report that distinction plainly.
