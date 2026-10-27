<!-- bilingual: source=zh-TW -->

> [繁體中文](pstack.md) | [English](pstack.en.md)

<a id="使用-pstack-開發-aios"></a>
# Develop AIOS with pstack

> 2026-10-24: Read [current implementation and validation](../Current_Implementation_Status.en.md) before choosing a workflow. A Node / Electron prototype exists. Recorder verification in this guide is not a product gate. See [13 feature assessment](../13_Feature_Expansion_Assessment_2026-10-24.en.md) for estimates and Quest/OpenClaw responsibilities.

This project pins pstack 0.15.29 at `cursor/plugins` commit `88d47514b82e7c44f00f2b2a72ff6dd12158038c`. Official skills and MIT license live in `vendor/pstack`. Version and file hashes are in `vendor/pstack.lock.json`.

<a id="開始工作"></a>
## Start work

1. Open a new Cursor or Codex session at repo root to rediscover project skills. Cursor uses `.cursor/skills`, Codex `.agents/skills`, both linking the same official files.
2. Provide a goal and observable completion criteria. For example, in Cursor, `/poteto-mode Fix progress updates continuing after task cancellation. Reproduce first, then verify cancellation and retry.` In Codex use `$poteto-mode` plus the request. If skills are not listed, explicitly ask to read `vendor/pstack/skills/poteto-mode/SKILL.md`.
3. Follow the selected playbook for understanding, design, implementation, review, and verification. Explain skipped steps. Product red lines and gates retain CLAUDE.md and docs/06–08 definitions.
4. Run these checks from root, then review the diff.

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
git diff --check
```

Verification requires Node.js 22.12+ and installed prototype dependencies. If missing, run `npm ci` in `prototype/ambient-shell`. It checks types, runs existing tests, builds the frontend, then starts the actual server entry from a temporary copy, submits a mock task, and retrieves the artifact. Task data and engine configuration are isolated, without project `.env` or login credentials. Reports, logs, and persistence evidence remain after removing the server copy. Output shows evidence locations.

This verifies only the mock HTTP path. UI interaction, real AI, microphones, speakers, and webcams need separate real tests. These results cannot pass G0–G3.

<a id="調整模型"></a>
## Configure models

Edit matching roles in `.cursor/rules/pstack-models.mdc`. Confirm names and reasoning levels from available runtime models first. Default `inherit-parent` preserves session model and reasoning budget. Independent same-model review is not cross-model review.

Official `/setup-pstack` defaults to the user's home directory and asks about budget/models. To use it here, explicitly target this project's rules and confirm choices before writing. This integration ran no global setup and selected no paid model plan.

<a id="更新官方技能"></a>
## Update official skills

1. Select an official repo commit and review changes and licensing.
2. Copy that commit's complete `pstack/` into `vendor/pstack`, preserving local adapters and `verify-aios`. Do not edit official skills directly.
3. Update commit, version, and every SHA-256 in `vendor/pstack.lock.json`, synchronizing added/removed links in both skill directories.
4. Run the checks above and confirm rediscovery in the actual client.

Local files and verification scripts can be checked in cloud. Cursor menus, global plugin installation, and native-exclusive features need Cursor verification. Benny Automations source is preserved but disabled. Integration does not automatically commit, push, create PRs, merge, or publish.

<a id="observatoryaios-pstack-執行監控"></a>
## Observatory: AIOS pstack execution monitoring

Original pstack 0.15.29, `vendor/pstack.lock.json`, and existing Skills stay unchanged. `tools/pstack-observe.mjs` separately records runs and steps. See AGENTS.md observability instructions.

- Dashboard: https://pcpcchen-coder.github.io/CursorPlugins/
- Local data: `.pstack/observability/runs/*.json`, gitignored and not public by default.
- AIOS CI: `.github/workflows/pstack-observer.yml` runs recorder tests and `scripts/check-pstack.mjs`, producing a downloadable smoke Run Artifact.
- CI smoke establishes recorder operation only, **not** actual pstack Agent feature development or product-gate acceptance.
- Real tasks require agents to invoke `start`, `step` from running to terminal status, and `finish` with actual evidence and failure reasons. No invocation means no observation.
- Public content requires separate explicit user authorization before `publish --public-ok` under [central documentation](https://github.com/pcpcchen-coder/CursorPlugins/blob/custom/pstack/docs/fork/PSTACK_DASHBOARD.md). Nothing is public by default.


### Public cross-repo Observatory E2E

The AIOS owner approved public **sanitized** pstack workflow metadata. The workflow .github/workflows/pstack-public-e2e.yml runs an actual recorder with a scripted, read-only CI investigation, validates the pinned pstack files and recorder tests, exports a filtered snapshot to the public telemetry/pstack branch and stores an evidence artifact. The CI run is labelled investigation-ci and must not be confused with Cursor/Codex pstack Agents executing development tasks.

Source feed: https://github.com/pcpcchen-coder/AIOS/tree/telemetry/pstack/observability/public

Dashboard: https://pcpcchen-coder.github.io/CursorPlugins/

The Dashboard fetches the source feed directly. It requires no cross-repository PAT, and polls about every 60 seconds while the browser tab is visible. GitHub/CDN caching may delay a response. Actual native Agent-run coverage still requires agents to invoke the recorder for each playbook step. Running the workflow does not imply AIOS UI, microphone, camera or other real hardware gates passed.


#### Live native-agent reporting

AIOS has a safe wrapper at tools/pstack-observe-live.mjs. It calls the existing Recorder first, then runs scripts/pstack-public-export.mjs with its public-safe field projection. Export PSTACK_OBSERVE_PUBLICATION_ACK=1 in the running agent environment; ensure GitHub CLI authentication has Contents:write to **AIOS**. Every start/step/finish then updates the public telemetry branch. If credentials or connectivity are unavailable, JSON remains local and the error is explicit. Other repositories remain opt-in.

The exporter has two transports, chosen by `PSTACK_PUBLISH_TRANSPORT` (`auto` by default). `api` writes through the GitHub REST contents API with `GH_TOKEN`; GitHub Actions uses this. `git` clones `telemetry/pstack` from the workspace's `origin`, commits the filtered files and pushes, using the workspace's own Git credentials. `auto` uses the API when a token exists and falls back to `git` when GitHub refuses it with 401 or 403, or when no token exists. Claude Code cloud sessions need the fallback: their GitHub proxy refuses REST content writes but accepts `git push`. Both transports write the same public projection and index.

The workflow is **not** hooked directly into IDE process events; the AIOS Agent must actually call this wrapper. Tests run without an acknowledgment flag so they never publish.
