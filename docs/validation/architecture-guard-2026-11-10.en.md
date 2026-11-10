<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-guard-2026-11-10.md) | [English](architecture-guard-2026-11-10.en.md)

# Architecture guard test S2 (2026-11-10)

Companion documents: step S2 in §3 of [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md); how the baseline numbers are computed is in [Measurements and baseline for the architecture review](architecture-review-2026-11-09.en.md). **This is static analysis plus automated tests in a cloud container. It is not a product gate and not real-device acceptance; it only shows that layering and size have not become worse than the baseline, and says nothing about whether any feature works.**

## 1. Scope

- Branch `claude/arch-s2-guard-test`, built on `3cc1401` of `claude/architecture-review-2026-11`; not yet merged to main.
- No product behaviour change, and no source file under `prototype/ambient-shell/{server,shared,src,desktop}` is touched.
- Changes: `scripts/architecture-metrics.mjs` (made importable), new `scripts/architecture-metrics.d.mts` (type declarations), new `prototype/ambient-shell/tests/architecture.test.ts`, this record and the index, and a note on row S2 of 23 §3.

## 2. The metrics script is now importable

- `collectImportGraph(shellDir)`: size and import graph only (file count, line count, files over 800 lines, fan-in/fan-out, cross-layer imports, import cycles). It needs only the layer directories and skips layers that do not exist, so it can measure a fake directory built for a test.
- `collectMetrics(shellDir)`: the above plus the review-specific numbers (route matches, file-writing styles, test classification and so on); it needs the complete `prototype/ambient-shell`.
- Also exported: `DEFAULT_SHELL_DIR`, `LAYERS`, `ALLOWED_IMPORTS`, `LINE_LIMIT` (800).
- Command-line behaviour is unchanged: results are printed only when the file is executed directly (it compares `process.argv[1]` with the real path of the file); when imported it prints nothing and does nothing.
- Before/after comparison: `node scripts/architecture-metrics.mjs` and `--json` were run on the same sources before and after the refactor and compared byte for byte with `cmp`; both are identical (both runs were on 2026-11-10, so `measured_at` is the same too).

## 3. Guard rules

The test measures the prototype directory that contains the test file (the parent of `tests/`).

| Rule | Verdict | Allowlist |
|---|---|---|
| Cross-layer imports | Must be 0. Allowed directions: `server→{server,shared}`, `src→{src,shared}`, `desktop→{desktop,shared}`, `shared→shared` | None |
| Import cycles | Every cycle found (a strongly connected component, type-only imports included) must be a subset of one allowlist entry: a cycle may shrink, split or disappear, but may not grow, and no new cycle may appear | 4 entries (below) |
| Files over 800 lines | Each one must be in the allowlist; new files and all other files must stay at 800 lines or fewer | 16 files (below) |
| Allowlist size | The cycle allowlist has at most 4 entries and 18 files; the large-file allowlist has at most 16 entries and no duplicates | — |
| Not an empty measurement | All four layers are measured and there are more than 200 source files | — |

The 4 allowed cycles (baseline `3cc1401`):

1. `shared/realtime-route.ts`, `shared/seconds-menu.ts`, `shared/types.ts`, `shared/voice-cost.ts`
2. `server/apikey-call.ts`, `server/codex-auth.ts`, `server/codex-responses.ts`, `server/live-tool-caller.ts`, `server/memory/live.ts`, `server/proactive-calendar.ts`, `server/realtime-routes.ts`, `server/web-search.ts`
3. `server/memories-google.ts`, `server/memories.ts`
4. `src/api.ts`, `src/realtime-session.ts`, `src/realtime-tools.ts`, `src/realtime.ts`

The 16 allowed large files (baseline line counts in parentheses are for reference only and take no part in the verdict): `src/main.ts` (4,211), `server/memory/service.ts` (2,613), `src/views.ts` (2,028), `server/identity-service.ts` (1,684), `server/home-bridge.ts` (1,655), `desktop/main.mjs` (1,523), `server/app.ts` (1,369), `server/memory/live.ts` (1,361), `server/realtime-routes.ts` (1,275), `src/family-view.ts` (1,259), `src/realtime.ts` (1,080), `server/store.ts` (1,029), `src/live-voice.ts` (884), `src/brain.ts` (873), `src/memory-view.ts` (836), `server/live-route.ts` (811). Lines are counted with `text.split("\n").length` (one more than `wc -l`).

### 3.1 The choice made for the large-file rule

Only allowlist membership is checked; **there is no cap on how much an allowlisted file may still grow**. Reason: the current priority is feature convenience (`CLAUDE.md`, 2026-10-31), and ordinary feature work still touches `src/main.ts` and `server/app.ts`; a per-file line cap would make everyday feature PRs fail in CI. Slimming these large files is the job of S6–S14 in 23 §3.

### 3.2 How to update the allowlists

- Both allowlists live in `tests/architecture.test.ts`, and **entries may only be removed, never added**.
- After breaking a cycle, moving a file out of a cycle, or splitting a large file down to 800 lines or fewer, remove the matching entry in the same PR.
- When the test fails because of a new cycle or a new large file, change the code (move shared types to `shared/`, split out a small module) instead of adding an entry. Adding an entry is stopped by the "allowlist size" rule.

## 4. Negative self-test (fixture)

The test builds a fake directory tree in the system temporary directory (a fixture, unrelated to product sources, deleted when the test ends) containing: `server/bad.ts` importing `src/page.ts` (cross-layer), `shared/a.ts` and `shared/b.ts` importing each other (a cycle, one side type-only), and an 801-line `src/huge.ts`; the controls are a file of exactly 800 lines, an import in an allowed direction, and a `.d.ts` and a `*.test.ts` that must be excluded. It asserts that the metrics script reports exactly these three violations, and that the three guard rules, using the same functions, all flag them.

It was also checked once by hand on the real sources (then reverted, not committed): appending `import type {} from "../server/store.ts";` to `shared/domain.ts` made `npx vitest run tests/architecture.test.ts` fail 2 of 8 tests — the cross-layer rule reported `shared/domain.ts -> server/store.ts`, and the cycle rule reported one new cycle of 11 files.

## 5. Verification results

Environment: Linux cloud container, Node.js v22, dependencies from the existing `node_modules` (vitest 5.0.3). No microphone, camera, Mac, Pi, home hub or TV.

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Passed |
| Guard test alone | `npx vitest run tests/architecture.test.ts` | 1 test file, 8 tests passed |
| Unit and integration tests | `npx vitest run` | 173 test files passed; of 3,202 tests, 3,196 passed and 6 were skipped; 54 seconds (1 file and 8 tests more than the baseline, which is this test) |
| Front-end build | `npx vite build` | Passed; the existing warning about a chunk over 500 kB is unchanged |
| Desktop main syntax | `node --check desktop/main.mjs` | Passed |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS; its test run was 173 files, 3,197 passed, 5 skipped (the skip count depends on the environment, see the baseline record). The rpi4 terminal kit dry-run printed a skip because the container has no `ssh-keygen`, so that part ran partially |
| Metrics script output | `node scripts/architecture-metrics.mjs`, `--json` | Byte-for-byte identical before and after the refactor |
| Bilingual documents | `node scripts/check-bilingual-docs.mjs` | Passed |
| Whitespace | `git diff --check` | Passed |

`scripts/verify-aios.mjs` runs `npm run test` in place inside `prototype/ambient-shell`; only the part that starts the server copies `server`, `shared` and `dist` to a temporary directory, so the test can find `../../../scripts/architecture-metrics.mjs`. The test uses a static import: if the script is missing, the whole test file fails to load and goes red instead of being skipped silently.

## 6. Limits

- Static analysis that finds relative-path imports with a regular expression, without parsing a syntax tree; text in a comment or string that looks like an import is counted too (it errs towards over-reporting), and non-relative imports are ignored.
- It does not measure runtime behaviour or the quality inside a module; passing does not mean the architecture is good, only that it is no worse than the baseline.
- Allowlisted large files can keep growing (see 3.1). If an allowlisted file drops to 800 lines or fewer and its entry is not removed, growing back later is not caught.
- The test classification in §3.6 of the review record becomes 173 files, and the new test is counted under "server HTTP" (23 → 24) by the "file text contains `server/app.ts`" rule although it starts no server; this is a limit of the regular-expression classification, and the classification rule was not changed.
- A green test run is only a code check on mock/fixture data, not G0–G3 or any Mac/Pi gate.
