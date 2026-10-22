# Independent distance scaling review

Result: no proven correctness defects found in the reviewed change against `16dc63c`. This is a read-only review; repository files were not edited.

## Reviewed behavior

- The existing SenseController distance factor and null/absence/off/error/degraded reset paths now drive the Brain setter through the real main.ts hook. Starting preserves the previous factor as before.
- Distance is stored separately from visual snapshots and survives ordinary setState updates.
- Top-layout center and radius receive the factor once; the existing parent CSS zoom retains its original input variable.
- Geometry clamps the requested radius using the 1.7 orbit fit extent. The current 1.62 orbit envelope including 1.018 breathing remains inside that extent.
- Projection and public hitTest both use the actual animated radius. Resize retains the distance factor, and DPR affects backing resolution rather than CSS geometry.
- New canvas label clamps and DOM activity placements preserve source text and avoid the checked viewport/control boundaries.
- Known baseline far-phone settings-panel width overflow under the pre-existing parent CSS zoom is outside this change and is not reported as a new defect.

## Independent validation

Executed from prototype/ambient-shell:

`npx vitest run tests/brain-distance.test.ts tests/sense-controller.test.ts tests/brain-regions.test.ts`

Result: 3 files passed, 35 tests passed (945 ms). These tests exercise actual draw geometry, public hitTest, reset paths, snapshot preservation, top layout, viewport fit, resize and DPR. Prove It Works informed running these tests; Test Behavior, Not Implementation informed checking visible geometry and public hit outcomes.

The browser harness was reviewed as source, including native Canvas observation, the external pipeline fixture boundary, asset hashing, reset/resize/DPR/hit-area cases, and DOM/source-label checks. I did not independently execute that harness or inspect its screenshots. Physical stereo accuracy, live account/AI behavior and microphone/speaker behavior are not established by this review. The browser harness uses reduced motion for deterministic geometry; non-reduced interpolation was inspected in source.

## Scoped comment audit

Only newly added comments were in scope. None were found in the reviewed production/test additions or new browser harness. No comments were deleted, restored or rewritten; no deletions or MUST KILL flags are recommended. Existing comments were left untouched. No new suppression comments or constraint encodings were found. Audit reruns: 0.

## Reviewed SHA-256

- prototype/ambient-shell/src/brain.ts: `8d8768e2eaa5db9fe9497bb1eda2b52835105c9a2502c917a8b6b4a6ec805f61`
- prototype/ambient-shell/src/main.ts: `08d6db650879bbc7b7ab99b17966e94f1c55de1b23e11dcc18304202b9b2e8f7`
- prototype/ambient-shell/src/style.css: `d73dadb8efafb2547b316590ed4c9a0b3e5e1b92c423a0b448bada2707edb753`
- prototype/ambient-shell/tests/brain-distance.test.ts: `f906e8a5de66bb2f279397c98d73ba39524d15d7053345c7edbd1a88f885b4c7`
- prototype/ambient-shell/tests/brain-regions.test.ts: `d6b22a66cb2d4e50332c1373f0371c648338ab3d5ddd2fdaa770cb1ba78ebd95`
- scripts/verify-distance-brain-browser.mjs: `6f50537e4c5efb347e26f59b2a729a81cdf76a1035d54da0016daae471b2e40e`

Production and focused-test hashes match the final owner source. The browser script changed during the original review; its current contents were read again at the listed hash. A final CSS-only follow-up was reviewed after browser verification exposed a 1.42px near-distance top-status overlap. The shared --surface-top anchor now preserves the three existing panel-position/height formulas, and top status uses that anchor times the distance factor minus 24px. Its explicit 18px line-height leaves a 6px gap before the panel at every tested factor. No further proven issue was found. Other reviewed hashes are unchanged. The focused test result above predates this CSS-only follow-up; no additional tests or browser runs were performed by this reviewer.


## Final browser-harness timestamp follow-up

Reviewed the final complete harness at SHA-256 `963d1367239fbc4520d22a606de72732df08f703d52bb1827ccb67db433786d1`; this supersedes its earlier hash above. Native ellipse observation records performance.now() after invoking the real Canvas method. Each geometry request records its starting frame and a timestamp in the same browser performance clock. Polling excludes observations at or before either request marker and excludes repeated frames, then requires a second fresh distinct frame with stable radius and center. Returned evidence includes both stable-frame timestamps and the request markers. The timestamp checks therefore reinforce freshness without replacing real drawing or changing app state. No proven issue or new comments found. No production/test edits or additional test runs were performed by this reviewer. The parent reports all six final browser groups passed; this follow-up independently reviews the harness source only.
