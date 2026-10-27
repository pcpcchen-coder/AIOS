---
name: verify-aios
description: Verify the AIOS ambient-shell prototype with its existing tests, typecheck, build, and an isolated mock HTTP task journey. Use after changing the prototype or checking development readiness.
---

<!-- bilingual: source=en -->

> [繁體中文](SKILL.zh-TW.md) | [English](SKILL.md)

# Verify AIOS

Run from the repository root with Node.js 22.12 or later. Install dependencies with `npm ci` in `prototype/ambient-shell` only if they are missing.

```bash
node scripts/verify-aios.mjs
```

The command runs type checking, the existing test suite, and the frontend build. It then copies the real server entry point, shared modules, and built frontend into a fresh temporary directory. Dependencies are linked, configuration and task data are isolated, and no project `.env` or login credentials are copied. The child process has no Anthropic key and starts with the mock provider on a free loopback port.

Read the printed `report.json` and logs. Passing requires built HTML, an active mock provider, HTTP task creation, completion, an explicitly labeled partial mock artifact, and matching persisted JSON. It also sends a direct mock chat request and requires text deltas plus a terminal event without an extra background task. Inspect `data/` beside the report for the persisted result. Cleanup stops only the child it started and deletes the runtime copy. Logs and report remain in the printed directory after cleanup.

If the command fails, read the corresponding log, fix setup issues, and retry only after a diagnosis or change. Do not weaken assertions or replace behavior checks with a port check. Existing test names describe coverage of cancellation, retry, state transitions, HTTP guards, and provider contracts.

This proves the mock API journey and the behavior covered by the current tests. It does not prove browser rendering, voice input, TTS, gaze, or a successful real AI request. Use a browser and physical devices for those checks. Do not claim the gates in `docs/07` passed from this command.

For the six-region UI, build the prototype first and run `node scripts/verify-regions-browser.mjs --output /tmp/aios-region-verification` from the repository root. This optional harness requires an existing Playwright installation and Chromium. Set `PLAYWRIGHT_MODULE` to an installed module entry and `CHROMIUM_PATH` to the browser executable if they are not discoverable. It drives the real built page with explicit account/API/speech fixtures, checks actual partition counts and source labels, and retains labeled screenshots plus exact source/build hashes. It does not use account credentials. Read its report and keep fixture evidence distinct from hardware validation.
