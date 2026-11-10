<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-guard-2026-11-10.md) | [English](architecture-guard-2026-11-10.en.md)

# Architecture guard test S2 (2026-11-10)

Companion documents: step S2 in §3 of [23 Architecture review and restructuring plan](../23_Architecture_Review_2026-11.en.md); how the baseline numbers are computed is in [Measurements and baseline for the architecture review](architecture-review-2026-11-09.en.md). **This is static analysis plus automated tests in a cloud container. It is not a product gate and not real-device acceptance; it only shows that cross-layer imports and import cycles have not become worse than the baseline without someone noticing, and says nothing about whether any feature works.**

**Note added 2026-11-10 (George's decision):** the project is still in active development, so files are not limited to 800 lines for now; large files will be tidied later, together (S6–S14 in 23 §3). The "files over 800 lines" rule of the planned S2 has therefore been **removed from the guard test**, which now guards cross-layer imports and import cycles only. The metrics script still reports the number of files over 800 lines (16 on the baseline) for information only; it is not a limit and makes no test fail.

## 1. Scope

- Branch `claude/arch-s2-guard-test`, built on `3cc1401` of `claude/architecture-review-2026-11`; not yet merged to main.
- No product behaviour change, and no source file under `prototype/ambient-shell/{server,shared,src,desktop}` is touched.
- Changes: `scripts/architecture-metrics.mjs` (made importable), new `scripts/architecture-metrics.d.mts` (type declarations), new `prototype/ambient-shell/tests/architecture.test.ts`, this record and the index, and a note on row S2 of 23 §3.

## 2. The metrics script is now importable

- `collectImportGraph(shellDir)`: size and import graph only (file count, line count, files over 800 lines, fan-in/fan-out, cross-layer imports, import cycles). It needs only the layer directories and skips layers that do not exist, so it can measure a fake directory built for a test.
- `collectMetrics(shellDir)`: the above plus the review-specific numbers (route matches, file-writing styles, test classification and so on); it needs the complete `prototype/ambient-shell`.
- Also exported: `DEFAULT_SHELL_DIR`, `LAYERS`, `ALLOWED_IMPORTS`, `LINE_LIMIT` (800, used for reporting only).
- Command-line behaviour is unchanged: results are printed only when the file is executed directly (it compares `process.argv[1]` with the real path of the file); when imported it prints nothing and does nothing.
- Before/after comparison: `node scripts/architecture-metrics.mjs` and `--json` were run on the same sources before and after the refactor and compared byte for byte with `cmp`; both are identical (both runs were on 2026-11-10, so `measured_at` is the same too). After the test file was added, only the test-classification line differs (172 → 173 files, "pure" 65 → 66).

## 3. Guard rules

The test measures the prototype directory that contains the test file (the parent of `tests/`).

| Rule | Verdict | Allowlist |
|---|---|---|
| Cross-layer imports | Must be 0. Allowed directions: `server→{server,shared}`, `src→{src,shared}`, `desktop→{desktop,shared}`, `shared→shared` | None |
| Import cycles | A "cycle" here is a strongly connected component of the import graph (two or more files, type-only imports included). Every component found must be a subset of one allowlist entry: a component may shrink, split or disappear, but may not contain a file outside the allowlist. An extra import inside a component is not caught (see section 6) | 4 entries (below) |
| Allowlist caps | The cycle allowlist has at most `MAX_ALLOWED_CYCLES` (4) entries and `MAX_ALLOWED_CYCLE_FILES` (18) files. Adding an entry means bumping the constant too, so the change is visible in the diff | — |
| Not an empty measurement | All four layers are measured and there are more than 200 source files | — |

File size is outside the guard (see the note at the top).

The 4 allowed cycles (baseline `3cc1401`):

1. `shared/realtime-route.ts`, `shared/seconds-menu.ts`, `shared/types.ts`, `shared/voice-cost.ts`
2. `server/apikey-call.ts`, `server/codex-auth.ts`, `server/codex-responses.ts`, `server/live-tool-caller.ts`, `server/memory/live.ts`, `server/proactive-calendar.ts`, `server/realtime-routes.ts`, `server/web-search.ts`
3. `server/memories-google.ts`, `server/memories.ts`
4. `src/api.ts`, `src/realtime-session.ts`, `src/realtime-tools.ts`, `src/realtime.ts`

### 3.1 How to update the allowlist

- The cycle allowlist and the two cap constants live in `tests/architecture.test.ts`. The default is to remove entries, not add them.
- After breaking a cycle or moving a file out of a cycle, remove the matching entry in the same PR.
- When the test fails because of a new cycle, first consider changing the code: move shared types to `shared/`, split out a small module, break the cycle.
- **Conscious override** (feature convenience is the current priority, `CLAUDE.md` 2026-10-31): when breaking the cycle is not reasonable right now, a feature PR **may** add an entry, provided that (1) a one-line comment next to the entry gives the reason; (2) the matching cap constant is bumped in the same change; (3) the PR description mentions it. The purpose of this test is to make a regression something that is seen and decided, not to block features.
- Cross-layer imports have no allowlist (the baseline is 0). If an exception is really needed, add an allowlist for that rule in the same PR (one-line reason per entry), update this record, and mention it in the PR description.
- Every failure message states the rule, what to do, the override above and the path of this document.

## 4. Negative self-test (fixture)

The test builds a fake directory tree in the system temporary directory (a fixture, unrelated to product sources, created in `beforeAll` and deleted in `afterAll`) containing: `server/bad.ts` importing `src/page.ts` (cross-layer), and `shared/a.ts` and `shared/b.ts` importing each other (a cycle, one side type-only); the controls are an import in an allowed direction, and a `.d.ts` and a `*.test.ts` that must be excluded. It asserts that the metrics script reports exactly these two violations, and that the two guard rules, using the same functions, both flag them.

It was also checked by hand on the real sources (then reverted, not committed): appending `import type {} from "../server/store.ts";` to `shared/domain.ts` made `npx vitest run tests/architecture.test.ts` fail 2 of 7 tests — the cross-layer rule reported `shared/domain.ts -> server/store.ts`, and the cycle rule reported one new cycle of 11 files; the failure messages contain the rule, what to do, the override and the path of this document.

## 5. Verification results

Environment: Linux cloud container, Node.js v22, dependencies from the existing `node_modules` (vitest 5.0.3). No microphone, camera, Mac, Pi, home hub or TV.

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | Passed (re-run after the large-file rule was removed) |
| Guard test alone | `npx vitest run tests/architecture.test.ts` | 1 test file, 7 tests passed (re-run after the large-file rule was removed) |
| Unit and integration tests | `npx vitest run` | 173 test files passed; of 3,201 tests, 3,196 passed and 5 were skipped; 51 seconds (re-run after the large-file rule was removed; 1 file and 7 tests more than the baseline, which is this test; the skip count depends on the environment, see the baseline record) |
| Front-end build | `npx vite build` | Passed; the existing warning about a chunk over 500 kB is unchanged (run on the first commit `efb47bf`; only the test file and documents changed afterwards, so it was not re-run) |
| Desktop main syntax | `node --check desktop/main.mjs` | Passed (as above, run on `efb47bf`) |
| Isolated mock flow | `node scripts/verify-aios.mjs` | PASS (as above, run on `efb47bf`, when its test run was 173 files, 3,197 passed, 5 skipped). The rpi4 terminal kit dry-run printed a skip because the container has no `ssh-keygen`, so that part ran partially |
| Metrics script output | `node scripts/architecture-metrics.mjs`, `--json` | Byte-for-byte identical before and after the refactor |
| Bilingual documents | `node scripts/check-bilingual-docs.mjs` | Passed |
| Whitespace | `git diff --check` | Passed |

`scripts/verify-aios.mjs` runs `npm run test` in place inside `prototype/ambient-shell`; only the part that starts the server copies `server`, `shared` and `dist` to a temporary directory, so the test can find `../../../scripts/architecture-metrics.mjs`. The test uses a static import: if the script is missing, the whole test file fails to load and goes red instead of being skipped silently.

## 6. Limits

- File size is not guarded: any file may pass 800 lines or keep growing without failing a test (George's decision of 2026-11-10).
- Static analysis that finds relative-path imports with a regular expression, without parsing a syntax tree; text in a comment or string that looks like an import is counted too (it errs towards over-reporting), and non-relative imports are ignored.
- CommonJS `require()` is not seen (the only `.cjs` source is `desktop/preload.cjs`), so a cross-layer import or cycle made through `require()` goes undetected.
- The cycle check works on strongly connected components, not on individual edges or elementary cycles:
  - A new import, or a new elementary cycle, inside a component that is already allowlisted passes as long as its members stay within the entry.
  - After a component shrinks, it can grow back to the set recorded in the allowlist without being caught, until the entry is tightened.
  - Swapping one allowlist entry for another (same totals) does not trip the cap constants; it is only visible in the diff.
  - Type-only imports count as edges; a type-only cycle is harmless at runtime but still fails the test.
- So the accurate form of "no new cycle" is: no strongly connected component containing a file outside the allowlist has appeared.
- It does not measure runtime behaviour or the quality inside a module; passing does not mean the architecture is good, only that these two things have not become worse than the baseline without someone noticing.
- The override relies on the comment, the cap constants and the PR description to be seen; the test itself cannot check whether the reason is sound or whether the PR description mentions it.
- The test classification in §3.6 of the review record becomes 173 files, with the new test counted as "pure" (65 → 66); the review record itself holds the 2026-11-09 baseline numbers and was not changed.
- A green test run is only a code check on mock/fixture data, not G0–G3 or any Mac/Pi gate.
