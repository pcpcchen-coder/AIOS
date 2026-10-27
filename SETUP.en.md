<!-- bilingual: source=zh-TW -->

> [繁體中文](SETUP.md) | [English](SETUP.en.md)

<a id="安裝驗證與協作入口"></a>
# Installation, verification, and contribution entry point

Updated 2026-10-24. AIOS has an executable Nous prototype. The repository contains more than design documents.

<a id="執行本機原型"></a>
## Run the local prototype

Requires Node.js 22.12 or later, npm, and Git.

```bash
git clone https://github.com/pcpcchen-coder/AIOS.git
cd AIOS/prototype/ambient-shell
npm ci
npm start
```

Open `http://localhost:8787`. The kernel binds only to the local address. Without a configured model, you can start with the explicitly labeled mock mode. Claude API configuration, ChatGPT engine login, and Codex login for realtime voice are separate settings. Choose them using the [complete installation guide](prototype/ambient-shell/INSTALL.en.md).

The macOS [desktop guide](prototype/ambient-shell/desktop/README.en.md) covers the existing preview release and building your own package. A prebuilt release does not necessarily contain the latest code on main. Quest and other LAN devices cannot currently connect directly to this localhost service.

<a id="更新既有-checkout"></a>
## Update an existing checkout

First check that the working directory has no uncommitted changes you need to preserve, then update main. On a feature branch, follow that branch's workflow first. Do not overwrite existing changes.

```bash
git status
git switch main
git pull --ff-only
cd prototype/ambient-shell
npm ci
```

Restart the running application to load new sources. See the installation guide for account, configuration, and task data locations. Downloading the repository again is not a substitute for data migration.

<a id="驗證開發環境"></a>
## Verify the development environment

After installing the prototype dependencies, run from the repository root:

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
git diff --check
```

The first command checks the pinned pstack version. The second runs type checks, tests, a build, and an isolated mock HTTP journey. These tests do not establish acceptance of real models, voice, cameras, or Quest. See [current implementation and verification](docs/Current_Implementation_Status.en.md).

<a id="參與變更"></a>
## Contribute changes

Read [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.en.md), and the [documentation index](docs/README.en.md) first. Extend the existing `prototype/ambient-shell`. Do not build a second application from an old blueprint.

Use a separate branch, commit scoped changes and corresponding evidence, then push the branch and open a PR. Do not version `.env`, login credentials, raw audio or video, private traces, or task data. Pushing requires a GitHub login with permission. Use configured authentication and keep tokens out of documentation.

Documentation changes must distinguish current implementation, pending hardware validation, and unimplemented ideas. See the [feature expansion assessment](docs/13_Feature_Expansion_Assessment_2026-10-24.en.md) for new architecture and feature proposals. Preserve original dates and fixture labels in historical verification records.

<a id="找到正確的下一步"></a>
## Find the right next step

- To use the prototype, read its installation and desktop guides.
- To check what exists, read current implementation and verification. Do not infer completion from an old roadmap.
- To decide expansion priorities, read F0–F10 and Q0–Q4 in the feature assessment.
- For formal Alpha acceptance, follow docs/06–07 and the relevant topic-specific validation. A passing test suite cannot replace a gate.
