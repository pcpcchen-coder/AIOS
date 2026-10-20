# AIOS agent workflow

Read `CLAUDE.md` and follow its product rules, documentation order, batch boundaries, and evidence requirements. The implemented application is `prototype/ambient-shell`. The monorepo, Tauri shell, gaze, and local voice pipeline in the design documents are planned work.

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
