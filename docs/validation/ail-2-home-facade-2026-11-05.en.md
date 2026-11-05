<!-- bilingual: source=zh-TW -->

> [繁體中文](ail-2-home-facade-2026-11-05.md) | [English](ail-2-home-facade-2026-11-05.en.md)

# AIL-2 home Facade and shared gog module validation

Date: 2026-11-05 (Asia/Taipei). Branch: `claude/ail-2-home-facade` (based on main `190aa83`). Scope: AIL-2 in [18 §6](../18_App_Integration_Layer_and_Spotify_2026-11.en.md), the HomeBridge Facade, whose gate is "no difference in H0/H1/H1b regression". On 2026-11-05 George asked for this batch first, with Gmail sending tidied into the same structure, followed by Google Calendar.

**Nothing here has run on a Mac or the real Wuling home hub.** The regression tests use a fake hub (fixture); all devices and readings are made up.

## 1. What changed

| Item | Contents |
|---|---|
| Home devices go through the integration layer | With `NOUS_AIL=on`, `home` in `NOUS_AIL_SERVICES` and the hub configured, `/api/home/status`, `/api/home/control` and `/api/home/confirm` call the new `home` Adapter (`server/integrations/adapters/home.ts`) through the Dispatcher, which then calls HomeBridge. Without `home` listed, or without a configured hub, the calls go directly to HomeBridge as before |
| How behavior stays the same | HomeBridge's result is placed unchanged in `data.legacy` and returned to the page as-is; a HomeBridgeError keeps its status code and message. Confirmation cards, busy and `needs_confirmation` are still handled by the page's ApprovalQueue. HomeBridge's own device policy, rate limit (6 commands a minute), time budget (60 s per utterance), read-back and confirmation are unchanged |
| The model's tools are unchanged | New `legacyName`: the Facade tools (`app.home.status`, `app.home.control`, `app.home.confirm`) accept only the new `page` route (the page forwarding through local HTTP) and never appear in the model's tool list. The model still sees the original `home_status` and `home_control` from `server/realtime.ts`, byte for byte |
| What the integration layer adds | The same enablement settings, argument validation, audit records (only tool ID, route, status and milliseconds; no target, command or value), and on-demand health in the settings page's "App integrations" (one hub snapshot read, no commands sent) |
| Relaxed limits apply only to the Facade | `legacyName` tools may use the new `scalar` parameter type (string, number or boolean, for `value`) and a time limit of up to 90 s; the Dispatcher adds no rate limit and allows results up to 256 KB. Model tools keep 60 s, 30 calls a minute and 4 KB, and cannot use `scalar` |
| Shared gog module | How gog is run (spawn, no shell, SIGTERM/SIGKILL, where to find gog, account format) moved from the Gmail Adapter to `server/integrations/gog/runner.ts`, shared by Gmail and the upcoming Google Calendar. Gmail sending is unchanged, and the old exports are kept |
| HomeBridge | Only a `probe()` was added (one snapshot read for the health check); nothing else changed |

## 2. Regression tests (fixtures)

New test file `tests/integration-home-facade.test.ts`, 18 tests. The core method: the same requests run once with the Facade on and once with it off (direct calls as before), each against an identical fake hub with fixed IDs and time. For every step, the HTTP status code and response body, and every request sent to the hub (method, path, idempotency key, body), must be exactly equal.

| Scenario | Result |
|---|---|
| H0 queries: room, device, reading, empty reading, missing reading, not found, ambiguous name, whole home | Identical; with the Facade on, each of the 7 requests has a Dispatcher audit record, proving it went through the integration layer |
| H1 control: confirmed, numeric or string values, invalid value, unknown command, not found, room level (asks which device) | Identical |
| H1 hub states: stale device state (409), hub did not reply (may or may not have run) | Identical |
| H1 confirmation card: needs confirmation, approve, approve again (same result), decline, expired, unknown ID | Identical; all 5 confirmations went through the Dispatcher |
| H1 device policy with voice control off | Identical (refused, nothing sent) |
| H1b AIFA air conditioner swing, temperature, off; infrared volume key and power | Identical (one-way, `unconfirmed`) |
| Rate limit | HomeBridge still refuses the 7th command; 35 queries in a row all succeed, proving the integration layer adds no limit |
| Hub errors: token rejected, unreachable | Same status codes and messages |
| Edge values: `value` null, 0, empty string, false; target and command with surrounding spaces; a reading that is only spaces or not a string; English-page error bodies | Identical |
| HomeBridge throws an unexpected (programming) error | Same 500 and message |
| Input validation and unconfigured hub | Same 400/409; with no hub configured the Facade is not registered |
| The integration layer's own safety timeout (HomeBridge never finishes; the test shortens the limit) | Control returns 504 "unclear whether it ran", in English for an English page; queries return 502 |
| Model tools | With the Facade on, the tool lists for both routes, the realtime instructions and the ChatGPT plan route's tool list are byte-identical to the Facade-off case in both languages; the settings `integrations.tools` is empty; a model call to `app__home__control` is refused (route not supported) and the hub receives nothing |
| Audit | Records contain no device names, commands, values or tokens |
| Adapter unit | Status mapping, health checks (not configured, available, unreachable, timeout, token rejected, bad format, other errors), raw results and HomeBridgeError passed back unchanged, other errors become "result unknown" for control, `scalar` and 90 s are Facade-only; `legacyName` tools may only use `page`, and `page` is only for `legacyName` tools |

The existing H0/H1/H1b tests in `tests/home-bridge.test.ts` and `tests/http.test.ts` still pass unchanged.

Commands and results (2026-11-05, Linux cloud, Node.js 22):

- `npm run typecheck`: pass.
- `npx vitest run`: 135 files, 2,473 passed and 5 skipped.
- `node scripts/verify-aios.mjs`: PASS; `git diff --check`: pass.

## 3. Independent review and fixes

An independent review by the same model (not a cross-model review) found no blockers. Fixed: English for the 504 message; an unexpected HomeBridge error returns the original 500 again (no longer 502/504); the Registry enforces that `legacyName` tools use only `page` and that `page` is only for `legacyName` tools; the health check now separates timeout, token rejected and bad format; tests for edge values, English error bodies, unexpected errors and the safety timeout were added. Not changed: the 502/504 that appear only when the integration layer's safety limit (45 s for queries, 80 s for control) is reached are responses that did not exist before the Facade; they are recorded in section 5.

## 4. Validation steps on the Mac (not yet run)

1. Add `home` to `NOUS_AIL_SERVICES` in `.env` (for example `home,gmail_gog`) and restart Nous.
2. The settings page's "App integrations" should show "Wuling home devices (hub): Available".
3. Following the hardware steps in the [H1 validation](smarthome-h1-2026-10-22.en.md) and [H1b validation](smarthome-h1b-2026-10-22.en.md), on each of the two realtime voice routes: ask for the living room temperature, turn a light on and off, say "confirm execute" and "cancel" for a device that needs confirmation, set the air conditioner temperature, and press the TV volume key. Results should match the behavior without `home`.
4. Nous's log should gain lines like "integration layer: … app.home.control page → …" that contain no device names or values.
5. Roll back: remove `home` from `NOUS_AIL_SERVICES` and restart to return to direct calls.

## 5. Limits and open items

- Nothing has run on a Mac or the real hub.
- The page's calls to the home API carry no session, so the audit can only record `page` and cannot tell which voice route was used.
- Only when the integration layer itself misbehaves (for example, HomeBridge not finishing within 80 s) does the Facade return an error that did not exist before: 502 for queries and 504 for control, saying it is unclear whether the command ran. HomeBridge always finishes within 60 s on its own, so this should not happen in normal use.
- Confirmation cards remain in the page; the integration layer's `external_commit` confirmation card is still not connected.

## 6. Next gate

Only after George completes section 4 on the Mac can we claim "home devices behave the same on real hardware through the integration layer". The next batch is Google Calendar (CAL-1).
