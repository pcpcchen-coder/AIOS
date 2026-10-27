<!-- bilingual: source=zh-TW -->

> [繁體中文](live-voice-2026-10-23.md) | [English](live-voice-2026-10-23.en.md)

<a id="即時語音chatgpt-方案路徑gpt-live-1-codex可切換的-api-key-路徑2026-10-23"></a>
# Realtime voice: ChatGPT-plan path (gpt-live-1-codex) plus switchable API-key path (2026-10-23)

Batch: add a second realtime-voice path in `prototype/ambient-shell`. Nous performs its own Codex login and uses `gpt-live-1-codex` through `chatgpt.com/backend-api/codex/realtime/calls` and `wss://api.openai.com/v1/live/{callId}`, as OpenClaw does. The original `OPENAI_API_KEY` (`gpt-realtime`) path remains switchable.

**Scope: development results are fixtures; §4 separately contains partial home hardware records.** Development had no ChatGPT account, microphone, or speakers and called no real OpenAI endpoints. George's Mac login/call/sideband have logs; successful temperature query after a fix has only verbal confirmation. Other cases and billing remain unverified. On 2026-10-24 only this overview was corrected; original tests/results below remain without upgrading partial success to full acceptance. See [implementation status](../Current_Implementation_Status.en.md).

<a id="1-用假端點測了什麼fixture"></a>
## 1. Fake-endpoint checks: fixtures

All are Vitest. Fixtures include scripted fake chatgpt.com/auth.openai.com fetch (`tests/fixtures/fake-chatgpt.ts`), fake sideband (`tests/fixtures/fake-sideband.ts`), fake page, WebRTC, and clock. Fake sideband is a handwritten WebSocket-upgrade server that actually handshakes with Node 22's built-in `WebSocket`. Fixture contents do not represent OpenAI-server behavior.

| File | Tests | Coverage |
|---|---:|---|
| `tests/frameless.test.ts` | 6 | Frameless event parsing (`session.updated` is not start, no `session.closed`), fatal errors, append chunks ≤500 bytes without splitting characters, 1,800-character total with `[truncated]` |
| `tests/realtime-routes.test.ts` | 16 | `billingLine`; full `planStart` matrix, three preferences × three live states × two key states; auto silently uses key when never signed in; `planFallback`; confirmation window begins only on spoken answer, expired card treated closed; preference changes do not alter ongoing session; one live session at a time; owner credentials; tool calls only to owner's stream; stream closure immediately ends session/rejects pending tools and permits immediate restart after refresh; side-effect timeout reports unknown/check; sideband closure rejects pending calls; auto fallback only at start; configuration errors never switch to billed route |
| `tests/codex-auth.test.ts` | 12 | Auth URL parameters, client_id, callback 127.0.0.1:1455, S256, `codex_cli_simplified_flow`, `originator=nous`; port 1455 busy →1457, both busy →device code; Codex `/cancel`; state mismatch rejected; missing account ID rejected without file; mode 0600; five concurrent refresh calls do one refresh and persist rotated refresh token first; 401 refresh/retry then second 401 needs sign-in; reused refresh token needs sign-in; logout during refresh/exchange drops result, does not persist, revokes obtained token; JSON/string/inspect token `[redacted]`; sentinel contents/mtime in `~/.codex/auth.json` unchanged |
| `tests/live-route.test.ts` | 16 | Call URL/query/headers: Bearer, account ID, `OpenAI-Alpha: quicksilver=v2`, three distinct UUIDs, `originator: nous`, no OpenAI-Beta; model omitted unless `NOUS_LIVE_MODEL`; actual fake-server sideband headers/URL, no `session.update`; mappings for 400 session.model, voice-related 403, usage-limit 429 with reset minutes, 5xx; errors omit token/account/JWT; Location/session-id parsing; five sideband failures return no answer; delegation once, ≤500-byte `delegation.context.append`, sequential delegations, empty input not heard; fatal error ends auth, sideband drop connection_lost with no later append; session.close once; still-processing uses session.context.append without delegation ID; caller exception still ends speakable plus failed; confirmation state captured at enqueue |
| `tests/live-tool-caller.test.ts` | 25 | Budget §2; same tool table/rules as key path; unconfirmed control never says on; max two host calls/delegation; timeout unknown handed to model; budget overrun says not completed/time exceeded, pending side effect unknown/check even if lower layer ignores abort; usage/login failure accurate; end_conversation; exact anchored confirmation/cancel only when card open or answered within eight seconds, intercepted as speakable without model/tools; five review-probe requests reach Codex in all card states; definite side-effect result clears unknown; turn exhaustion uses executed outputs; Codex Responses request shape store:false/parallel_tool_calls:false/headers and 429; model-list read included in turn deadline, shared cache, web query inside HOST_TIMEOUT_MS.web_search |
| `tests/live-voice.test.ts` | 24 | Listening requires microphone/peer/session.started; replying from remote volume only; no GA events required; data-channel/core transcripts dedup by item ID, without ID pair same transcript from opposite source only, repeated user phrase within ten seconds remains valid; card reports deadline/outcome and retries POST once; every startup await cancellable by Esc/collapse/departure; ignore channel delegation.created; report card to core before tool result; spoken/button confirmation; second home call busy while card open; shared web_search/delegate callbacks; finish goodbye before close; local goodbye fallback; typing/tool_unknown; core closed tears peer down and displays/speaks cause without route switch; Esc mutes only; region pulses only actual tool callback, source-checked; notice before mic; fallback closes live mic, speaks notice, opens key; refusal reason accurate |
| `tests/live-integration.test.ts` | 6 | Core ↔ real SSE ↔ fake page: delegation → realtime.host → credentialed page `/api/realtime/web-search` using Codex quota → host-result → speakable append; duplicate call_id dropped; wrong owner 403; refresh closes stream/sideband with session.close, no later append, immediate new start; sideband drop closed connection_lost to page; route change leaves active session; approval requires timeout_ms/outcome; **token check:** concatenate all HTTP responses, SSE frames, console/logs and search access/refresh/account ID/OPENAI_API_KEY/client secret/SECRET markers, all zero matches |

API-key regressions: `tests/realtime-voice.test.ts` (33), `tests/realtime-bridge.test.ts` (8), `tests/http.test.ts` including :222-249 realtime routes, `tests/sense-controller.test.ts` CSP `connect-src 'self'`, `tests/prefs.test.ts`, `tests/idle-settings.test.ts`, and source checks in `tests/voice-commands.test.ts`. **None of these files changed**, all pass. `tests/prefs.test.ts:148` needs no change because `describeSeconds` reads only `RealtimeBaseInfo` fields.

This run: 691 tests in 44 files, all passing after review. Initial version had 667, adding 81; before work 586 in 37 files. Review added 24 and rewrote four older confirmation/planStart tests.

Node 22 `WebSocket` custom headers: fake server receives Authorization/account/OpenAI-Alpha/session-id in the live-route “attaches the sideband…” test, so no `ws` package or new dependency is needed.

<a id="2-時間預算的算式"></a>
## 2. Time-budget calculations

Constants live in `server/realtime-routes.ts`, `server/live-tool-caller.ts`, and `server/live-route.ts`. Tests calculate from constants rather than hardcoded numbers.

**Maximum waiting for answer SDP**, `ANSWER_BOUND_MS`:

| Step | Milliseconds |
|---|---:|
| Create call, `LIVE_TIMEOUTS_MS.call` | 30,000 |
| Five sideband attempts, 15,000 each | 75,000 |
| Waits 200·2^n for n=0..3: 200+400+800+1,600 | 3,000 |
| **Total** | **108,000** |

Normal call creation takes about 1–3 seconds plus about 0.5 second sideband. Core returns answer only after sideband connects.

**Host-tool page-response deadlines**, `HOST_TIMEOUT_MS`: home_control 62 s (home-bridge `UTTERANCE_MS` 60 plus two); web_search 32 s (`WEB_SEARCH_TIMEOUT_MS` 30 plus `HOST_REPLY_MARGIN_MS` two); home_status 20; delegate_task ten; get_tasks/end_conversation five each. Side-effect home_control/delegate_task timeouts return `status: unknown`, result unknown/check; other tools return `ok:false`.

**Delegation limit**, `DELEGATION_BUDGET_MS`:

```
maxTurns × turnTimeoutMs + maxHostCalls × max(HOST_TIMEOUT_MS) + marginMs
= 3 × 20,000 + 2 × 62,000 + 3,000
= 60,000 + 124,000 + 3,000
= 187,000 ms（187 秒）
```

`maxTurns = 3` covers AC-on-26: power, temperature, result. `maxHostCalls = 2` permits two tool calls; a third never executes and is reported accurately. Overrun says not completed/187-second timeout; a sent side effect with no reportable result says unknown/check. After ten seconds, only if a tool really remains active on page, one still-processing notice is sent.

**Model-list lookup belongs inside each turn deadline.** Without `NOUS_LIVE_AGENT_MODEL`, first turn reads `/models`. `CodexResponses.turn()` timing starts at lookup and covers list/connect/stream, so delegation needs no extra allowance. ChatGPT-plan web search uses 30 seconds including lookup, leaving two seconds within page's 32-second wait. Delegation/search share one model cache and query once. Previously lookup had separate 30 seconds, allowing 30+30=60 versus page 32.

**Session maximum:** earlier of server `session.expires_at` and 30 minutes. One live session per core.

<a id="審查修正2026-10-23"></a>
## Review fixes (2026-10-23)

Independent review found ten issues, each with regression tests failing on old code. Replacing server/src/shared with `77e332d` while retaining new tests produces 27 failures including every new test.

1. **Approval phrases swallowed ordinary requests:** `approvalGuard` now uses anchored `exactApproval` in `shared/approval.ts`, whole punctuation-stripped phrase exactly confirm/cancel, only while card open or answered within eight seconds. With no card, confirmation goes to Codex instead of local nothing-to-confirm. Page `matchApproval` unchanged.
2. **Startup could not cancel:** `openRealtime(deps, signal)` checks after each await; `stopRealtime` from close/Esc/departure aborts and clears `realtimeStarting`. Already-started session stops immediately, no fallback startup. Departure during startup also stops.
3. **Pending refresh revived logout:** `CodexAuth` login generation increments on logout/new login. Refresh/exchange checks generation after await, drops stale result without persistence, best-effort revokes obtained refresh token.
4. **Key-only users heard every fallback notice:** auto plus live not_logged_in silently starts key. Previously configured but unavailable needs_reauth/usage_limit/upstream error still announces. Explicit live still refuses with reason.
5. **Still-processing used wrong channel:** now `session.context.append` without delegation ID, matching OpenClaw sendSessionContext. Every delegation ends speakable `delegation.context.append`, including intercepted approval; OpenClaw runDelegation uses speakable on success/failure and no commentary-only completion example exists, so `DelegationResult` is speakable only.
6. **Honest approval window:** capture card state/time when delegation enqueues. Page open reports own timeout, resolved reports outcome; only said_approve/said_reject start answer window, not timeout/collapse. Failed POST retries once; after repeated failure core treats card closed on expiry.
7. **Unknown-result flag:** definite side-effect result, not status unknown, clears unknown. Turn exhaustion reports executed outputs rather than not completed/unknown; later failure first reports executed result.
8. **Caller exceptions stuck page:** delegate catches, sends speakable failure and failed event, clears thinking and resumes idle timer.
9. **Dedup removed real repeats:** item-ID behavior stays; without ID each source stores one copy, only pairing another source's same transcript. User repeating confirmation within ten seconds remains valid.
10. **Model lookup outside deadline:** §2; codex/codexSearch share `CodexModelCache`; lookup inside turn; web deadline derived 30+2=32, delegation stays 187 seconds.

<a id="3-george-的家中測試mac桌面-app"></a>
## 3. George's home testing: Mac desktop app

**Preparation**

- Nous built from this commit.
- Codex CLI **not required**. OpenClaw may remain installed. Nous owns its login and uses 1457 if OpenClaw is midway through login on 1455.
- `.env` includes `OPENAI_API_KEY` for step eight.
- Record `ls -la ~/.codex 2>/dev/null` before and after.
- Open <https://platform.openai.com/usage>, screenshot current Realtime, Responses, and web-search usage.
- Confirmation flow is fixture-only: before H2 all devices are allow and home tests show no cards. Step four tests no-card phrases only.

Save `~/Library/Application Support/Nous/nous.log` at every step (paths/billing only, no tokens), plus video/screenshots.

| Step | Action | Expected | Record |
|---|---|---|---|
| 1 | Menu → realtime → ChatGPT-plan Codex sign-in | Browser consent then signed-in indication; settings `<email> · <plan>`, menu ChatGPT-plan Codex quota/gpt-live-1-codex; `~/.config/nous/codex-credentials.json` mode 600; no create/change in `~/.codex` | Screenshot, stat, before/after ls |
| 2 | Auto route → start voice conversation | Engine shows ChatGPT-plan quota/gpt-live-1-codex and delegation backend; listening only after microphone indicator; no fake greeting | Video, seconds to listening; acceptance of originator nous or exact rejection |
| 3 | Living-room light on | Controlling subtitle then sent/unconfirmed or ✓ confirmed; speech matches status; physical light changes | Video, home_control log line |
| 4 | No card: confirm execution | Ordinary Codex request says nothing to confirm, no controller command. Also “stop playing music” and “don't turn on lights, check living-room temperature” must remain requests, never generic nothing-to-confirm | Video, controller logs |
| 5 | Will it rain in Hsinchu today? | Web-search/source subtitles and numeric answer | Video |
| 6 | Report comparing three telecom tariffs → progress query → wait | Same task UI as key path, progress below brain, planning region driven by actual step domain, artifact and spoken completion | Video |
| 7 | Goodbye | Goodbye finishes, conversation-ended text, session.close log | Log |
| 8 | Sign out realtime → auto → start | Key-only configuration starts silently with no fallback notice; engine key billing/gpt-realtime, original key behavior. Then explicit ChatGPT-plan start refuses with reason, platform usage does **not** grow | Video, before/after platform usage |
| 9 | Only if feasible, exhaust plan quota | Limit/reset-minutes plus manage usage; auto announces and switches key | Screenshot |
| 10 | During plan call select API key | Ongoing call remains plan; menu says in progress, next key/gpt-realtime; next start uses key | Video |
| 11 | Refresh plan call with ⌘R | Immediate end; start again immediately without already-active error | Video |

**Home questions**, not blockers for this commit:

- Does server accept `originator: nous`? Show rejection honestly; do not impersonate Codex CLI unless George chooses it.
- Does `/models?client_version=…` return models? Hardware confirmed `0.1.0` returns empty; default changed to `0.162.1`, §4. If still empty set `NOUS_LIVE_AGENT_MODEL` or `NOUS_CODEX_CLIENT_VERSION` in `.env` and record value.
- Does browser data channel send frameless transcripts? Otherwise page uses core-forwarded `realtime.live transcript` and still shows subtitles. Record which.
- Is `SPEAKING_RMS = 0.02` useful for actual replying indication?

**Billing evidence**

- During steps 2–7, this key's Realtime/Responses/web-search usage at platform.openai.com must show **no increase**. Compare before/after screenshots spanning test time.
- ChatGPT usage at <https://chatgpt.com/settings/usage>, Codex, shows activity in the same interval.

**Requirements to mark README complete**

- Steps 1–8 and 11 pass on George's Mac using real endpoints.
- Billing evidence holds.
- §4 filled from that run.
- Confirmation flow labeled fixture-only.
- If step nine not reached, record not reached.

<a id="4-真實結果george-家中測試"></a>
## 4. Real results: George's home tests

| Step | Result | Evidence |
|---|---|---|
| Codex login, call creation, sideband | Normal, nous.log records started gpt-live-1-codex | George's 2026-10-23 nous.log |
| Voice delegation | Normal, received living-room temperature query delegation | Same log |
| Temperature delegation execution | **Failed:** empty Codex model list, bad_request. `/models` sent Nous version client_version=0.1.0. Default changed to 0.162.1, same as OpenClaw; retest pending | Same log; fix/regression tests/codex-client-version.test.ts |
| Execution after fix | Normal: Codex route answers controller temperature, George verbally says it works | 2026-10-23 verbal report, no screenshot/timing |
| Other steps | Not run | — |
| Billing evidence | Not run | — |

Same log also records unhandled sideband events `session.input_audio.append`, `turn.created`, `turn.delta`, `delegation.context.appended`, and `session.usage.updated`. They do not affect functionality; recorded only for now.

Before this section was filled, all ChatGPT-plan conclusions came from fixtures and did not establish real voice, accounts, or billing behavior.
