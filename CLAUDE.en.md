<!-- bilingual: source=zh-TW -->

> [繁體中文](CLAUDE.md) | [English](CLAUDE.en.md)

<a id="claudemd--nous-開發規則-v012026-10-07"></a>
# CLAUDE.md: Nous development rules v0.1 (2026-10-07)

For development agents working in this repository, including Claude Code. Product specifications are governed by `docs/06`, `docs/07`, and explicitly dated topic decisions. See [`docs/Current_Implementation_Status.md`](docs/Current_Implementation_Status.en.md) for current implementation and evidence. `docs/08` is a historical planning snapshot from 2026-10-07 and must not be treated as today's status.

This project uses the pstack development workflow. Before a nontrivial change, read the project adaptations in [`AGENTS.md`](AGENTS.md) and the [usage guide](docs/development/pstack.en.md), then follow the relevant playbook.

<a id="中英文文件與介面2026-10-26-使用者要求"></a>
## Bilingual documentation and interface (owner requirement, 2026-10-26)

Every new or updated project document must provide complete Traditional Chinese and English versions in the same change, with synchronized language links. New or changed App and web copy, including menus, hints, errors, and accessible labels, must support both languages through the shared localization catalog. Every subsequent agent must follow [the bilingual policy](./docs/BILINGUAL.md). Run `node scripts/check-bilingual-docs.mjs` before delivery and use `--record` to update the pairing record only after reviewing the translations. A summary is not a full translation.

**English requirement:** Every agent must deliver complete Traditional Chinese and English documentation in the same change, and support both languages in new or changed App/web interface copy. Follow [the bilingual policy](./docs/BILINGUAL.md), review both versions, and run `node scripts/check-bilingual-docs.mjs` before delivery.

<a id="開工前"></a>
## Before starting

1. Read `README.md`, `docs/Current_Implementation_Status.md`, `docs/06`, `docs/07`, and relevant topic documents. Read `docs/08` and 01–05 only when you need historical decisions.
2. Check for code already added by others. Extend the existing structure instead of rebuilding it.
3. Work on one verifiable batch at a time. PR-xx in 07 and PR-00 / S1–S4 in 08 are original planning labels. Compare them with existing code first. Do not rebuild from an old prompt. Feature labels F0–F10 / Q0–Q4 remain proposals and do not automatically change gates or ADRs.

The current implementation is `prototype/ambient-shell`: Node HTTP and SSE, framework-free TypeScript / Vite, Electron, and JSON persistence. Claude uses the Anthropic Messages SDK. The implementation has not migrated to Python, Tauri, or the full Agent SDK. Camera head-facing and gesture code exists, but this is not eye-tracking calibration. Claude leads core development and ChatGPT / Codex leads the Quest direction. This division must not restrict runtime model providers.

<a id="現階段優先順序2026-10-31-使用者要求"></a>
## Current priority (owner requirement, 2026-10-31)

The system is used only at home for now: **convenience and features come first**, and permission and security hardening is deferred. Pick feature work for the next batch; do not add extra permission or security hardening on your own (for example the general Action Gate / F1, or tightening the main window URL check) unless the owner asks. The product boundaries below still apply.

<a id="產品紅線違反即不合格"></a>
## Product boundaries (violations fail acceptance)

- Do not create an App launcher, App icons, a permanent sidebar, a homepage dashboard, or a default chat homepage.
- Every Surface must carry a verifiable `visibility_reason`. Do not show it without a valid reason.
- Gaze selects a target only. It does not expand, submit, delete, or cause any side effect. A blink is not a click.
- Dismiss closes the view without cancelling its task. Only Stop task cancels it.
- External side effects, including sending, publishing, payment, and permanent deletion, require an Action Gate and explicit confirmation for that action.
- Generated UI must not receive direct shell access, filesystem access, MCP tokens, or arbitrary network access.
- Do not write raw webcam frames or audio captured before wake to files or traces, or send them elsewhere.

<a id="使用者指定的設計要求必須保留"></a>
## Required owner-specified design

- The electronic brain must include at least Language, Mathematics, Art, Hearing, Vision, and Planning regions. Current content and real application events must drive animations in the corresponding regions, including illumination, light pulses, and region names.
- Only real events may drive this mapping: task-step `domain` tags or conversation-topic classification. Do not describe it as internal neural activity of the model.
- Capture and playback states must follow device events. A mode toggle does not mean audio capture is active. Visual topic classification must name its source. Without image input or analysis, do not claim that the application is watching.
- The prototype implementation is in `prototype/ambient-shell/shared/domain.ts` and `src/brain.ts`. The production Presence animation must retain this requirement.

<a id="誠實規則"></a>
## Honesty

- Label mocks, fixtures, and replays explicitly. Do not use them to claim real voice, gaze, or Agent capabilities.
- Report real tool failures, timeouts, and missing data. Do not show false success.
- Drive animations only from real events. Do not fabricate progress.
- Calculate quantities before stating them. Record the calculation in tests or `docs/validation/`.

<a id="技術慣例"></a>
## Technical conventions

- TypeScript is the current prototype's main language. If the planned Python kernel is adopted, place Python in `apps/kernel` then. Do not describe that path as already existing.
- When a cross-language kernel is adopted, share versioned JSON Schema. `packages/shared/schemas` does not exist yet. Do not assume Python can use tRPC.
- Do not hard-code model IDs. Obtain them through configuration or a Models API.
- Users authenticate with API keys. Do not integrate claude.ai login.
- Pin dependency versions. sqlite-vec is pre-v1, and upgrades require a separate PR.
- Do not add LangChain, LlamaIndex, or dependencies licensed under AGPL, GPL, or NC terms.

<a id="交付格式"></a>
## Delivery format

For every batch, provide changed files, startup commands, test results, screenshots or measurement evidence, unfinished work, and the next gate. Change README entries from pending to complete only when a real end-to-end journey passes the corresponding gate.

<a id="commit"></a>
## Commits

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- One PR corresponds to one batch. Do not include unrelated refactoring.
