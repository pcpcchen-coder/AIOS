---
name: verify-aios
description: Verify the AIOS ambient-shell prototype with its existing tests, typecheck, build, and an isolated mock HTTP task journey. Use after changing the prototype or checking development readiness.
---

# Verify AIOS

Run from the repository root with Node.js 22.12 or later. Install dependencies with `npm ci` in `prototype/ambient-shell` only if they are missing.

```bash
node scripts/verify-aios.mjs
```

The command runs type checking, the existing test suite, and the frontend build. It then copies the real server entry point, shared modules, and built frontend into a fresh temporary directory. Dependencies are linked, configuration and task data are isolated, and no project `.env` or login credentials are copied. The child process has no Anthropic key and starts with the mock provider on a free loopback port.

Read the printed `report.json` and logs. Passing requires built HTML, an active mock provider, HTTP task creation, completion, an explicitly labeled partial mock artifact, and matching persisted JSON. It also sends a direct mock chat request and requires text deltas plus a terminal event without an extra background task. Inspect `data/` beside the report for the persisted result. Cleanup stops only the child it started and deletes the runtime copy. Logs and report remain in the printed directory after cleanup.

If the command fails, read the corresponding log, fix setup issues, and retry only after a diagnosis or change. Do not weaken assertions or replace behavior checks with a port check. Existing test names describe coverage of cancellation, retry, state transitions, HTTP guards, and provider contracts.

This proves the mock API journey and the behavior covered by the current tests. It does not prove browser rendering, voice input, TTS, gaze, or a successful real AI request. Use a browser and physical devices for those checks. Do not claim the gates in `docs/07` passed from this command.
