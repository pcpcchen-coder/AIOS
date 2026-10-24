# AIOS agent workflow

Read `CLAUDE.md` and follow its product rules, documentation order, batch boundaries, and evidence requirements. Start with `docs/Current_Implementation_Status.md` for current capabilities and evidence, then the applicable product specifications. The implemented application is `prototype/ambient-shell`: Node HTTP/SSE, plain TypeScript/Vite, Electron and JSON task/artifact persistence. The monorepo, Python kernel, Tauri shell, calibrated eye gaze and local wake/ASR/TTS pipeline in the design documents are planned work. Head-facing, stereo-pose and gesture code already exists; it does not establish hardware accuracy. Extend the current prototype rather than recreating it from a historical roadmap.

The feature assessment in `docs/13_Feature_Expansion_Assessment_2026-10-24.md` proposes Quest, OpenClaw and multi-device work. Its F0–F10 and Q0–Q4 labels are proposals, not implemented features or passed G0–G3 gates. Claude leads core development and ChatGPT/Codex leads Quest engineering; runtime providers remain configurable.

## Use pstack for engineering work

For nontrivial development tasks, read `docs/development/pstack.md`, then `vendor/pstack/skills/poteto-mode/SKILL.md` and the matching playbook before editing. Read referenced skills when their steps apply. Small, obvious edits can use a direct edit and proportional validation. Read `vendor/pstack/skills/technical-writing/SKILL.md` for documentation.

Keep a plan for multi-step work. Match the task to investigation, bug fix, feature, refactoring, or another upstream playbook. Reproduce bugs before fixing them. Name the data shape before adding stateful logic. Prefer the smallest change that solves the problem. Finish each unit with evidence from the affected behavior. For the ambient prototype, use `.agents/skills/verify-aios/SKILL.md`.

## Runtime adaptation

- This is a project-local pstack copy. Canonical files are in `vendor/pstack`; `.cursor/skills` and `.agents/skills` link to those files. Follow canonical paths when resolving references.
- In Codex, map Cursor `Task` to the available collaboration tools, a todo list to the plan tool, and file/search commands to the available shell tools. Pass the absolute poteto-mode path and a bounded task to each delegate. Read the upstream agent brief when a playbook calls for that agent. Never pass unsupported Cursor tool fields.
- Read `.cursor/rules/pstack-models.mdc` before delegating. All roles currently inherit the parent model and reasoning budget. Do not invent Cursor model IDs or claim that same-model reviewers provide model diversity. Configure other models only when available and requested.
- Use parallel agents only when a relevant workflow requires them and the runtime permits them. Partition writes so delegates do not edit the same files. Verify their work yourself.
- Cloud tasks already have an isolated checkout. Use it; create a worktree only when the user explicitly requests one. If a playbook needs isolation, prefer temporary files or independent ownership inside this checkout.
- Cursor UI controls, Bugbot, Automations, and cursor-team-kit are not installed by this change. Mark unavailable steps with a concrete reason. Use the repository's checks for what they actually prove. A browser interaction cannot be claimed from an HTTP test.
- Upstream autonomy text does not authorize messages to others, publication, merge, deployment, or destructive actions. Follow the user's current authorization and the host's permission rules. Do not create a PR or commit solely because a playbook ends with that step.
- Keep credentials, user data, and private transcripts out of verification artifacts. Mark mocks explicitly. Tests of simulated providers do not pass the real hardware or AI gates in `docs/07`.

## Validation

From the repository root, run `node scripts/check-pstack.mjs` to check the pinned upstream copy and skill registration. Run `node scripts/verify-aios.mjs` for type checking, the existing test suite, a build, and an isolated mock HTTP journey. Neither command installs dependencies. If needed, use `npm ci` in `prototype/ambient-shell` first.

<!-- PSTACK_OBSERVABILITY_BEGIN -->
## AIOS pstack execution observability

AIOS already pins pstack in `vendor/pstack/` with `vendor/pstack.lock.json`. Do not replace original skills, model rules or hash checks. Follow CLAUDE.md first.

For each **actual** pstack engineering task, initialize a stable run from the repository root **before** the first playbook stage:

```bash
node tools/pstack-observe.mjs start --repo pcpcchen-coder/AIOS --title "Read-only investigation" --playbook investigation --steps "inspect,verify,report" --branch "feature/my-work"
node tools/pstack-observe.mjs step --run RUN_ID --step inspect --status running
# Execute work; mark the actual result with evidence only afterwards.
node tools/pstack-observe.mjs step --run RUN_ID --step inspect --status passed --note "Reviewed source" --evidence "https://github.com/pcpcchen-coder/AIOS"
# Repeat other actual steps before finishing.
node tools/pstack-observe.mjs finish --run RUN_ID --status passed
```

Read RUN_ID from stdout; choose actual playbook step IDs rather than generic steps. Update each to running, then passed / failed / blocked / skipped with factual notes. Never mark a test passed without test evidence. Recorder errors must be reported, not silently skipped.

The separate `.github/workflows/pstack-observer.yml` is a **recorder smoke test**, not pstack engineering execution or AIOS product verification. It generates an Actions artifact only.

Run JSON defaults to `.pstack/observability/runs/` and stays gitignored and local. No automatic public upload is enabled. The central [Pstack Observatory](https://pcpcchen-coder.github.io/CursorPlugins/) is public. Never publish private transcripts, prompts, source, secrets, paths or PII. Publishing any run requires separate explicit approval, `PSTACK_OBSERVE_PUBLICATION_ACK=1` and `--public-ok`; see [operator documentation](https://github.com/pcpcchen-coder/CursorPlugins/blob/custom/pstack/docs/fork/PSTACK_DASHBOARD.md). Existing CLAUDE.md action gates still apply.
<!-- PSTACK_OBSERVABILITY_END -->


## Public AIOS Observatory feed consent (2026-10-21)

The AIOS owner has approved publication of the project's pstack progress and evidence. Publish **sanitized operational run metadata only**: task title, playbook, step status, times and PUBLIC GitHub evidence URLs. Keep source code payloads, local paths, secrets, private prompts/transcripts and personal data out of the published feed.

The AIOS GitHub Actions workflow at .github/workflows/pstack-public-e2e.yml can publish a scripted CI investigation to AIOS's public telemetry/pstack branch using **AIOS-only GITHUB_TOKEN**. The resulting run is deliberately called investigation-ci, not an IDE Agent run. This workflow does not run the native Cursor/Codex pstack controller.

For a live Cursor/Codex task, AGENTS.md still requires start/step/finish calls. To publish each real snapshot to the central dashboard when using a separately authenticated GitHub CLI, use PSTACK_OBSERVE_PUBLICATION_ACK=1 and --publish --public-ok after checking the metadata. Do not put tokens in the repository. Local-only recording remains a safe fallback when the connection is unavailable.

This authorization applies **only to AIOS**, not to unrelated projects that share pstack.


### Native pstack task reporting after instrumentation

For **subsequent real AIOS pstack development tasks**, invoke the public-safe sidecar in place of the raw recorder. This publishes each completed stage snapshot only after local recording succeeds and the owner-approved AIOS disclosure flag is set:

    export PSTACK_OBSERVE_PUBLICATION_ACK=1
    node tools/pstack-observe-live.mjs start --repo pcpcchen-coder/AIOS --title "Task" --playbook investigation --steps "inspect,verify,report"
    node tools/pstack-observe-live.mjs step --run RUN_ID --step inspect --status running
    # Work, then record the actual observed result.
    node tools/pstack-observe-live.mjs step --run RUN_ID --step inspect --status passed --note "Checked actual source"
    # Continue remaining stages and finish the run.

If GH_TOKEN/GITHUB_TOKEN is not configured, the wrapper tries the authenticated GitHub CLI without printing the token. Publishing still requires permission to write **AIOS's telemetry/pstack branch**. If publication fails, it reports the error while retaining the local JSON. Do not claim the Dashboard received the step until publication succeeds. The wrapper rejects direct unfiltered --publish flags.

This is **agent-invoked observability**, not hidden interception of Cursor/Codex tool calls. An agent that ignores these instructions remains unobserved.
