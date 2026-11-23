<!-- bilingual: source=zh-TW -->

> [繁體中文](18_App_Integration_Layer_and_Spotify_2026-11.md) | [English](18_App_Integration_Layer_and_Spotify_2026-11.en.md)

# 18 | Nous App Integration Layer and Spotify / Pi 4 Design

Date: 2026-11-03 (Asia/Taipei). Status: **design proposal; no implementation, no real Spotify hardware validation, and no authorization to provide Spotify voice control**. This document is not a claim of shipped product capabilities. Development follows [CLAUDE.md](../CLAUDE.en.md), [current implementation status](Current_Implementation_Status.en.md), [smart home H0–H4](12_SmartHome_Integration_Plan_2026-10.en.md), and the [bilingual policy](BILINGUAL.md). The [Soloist weekend test plan](experiments/SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.en.md) is separate. The prior Pi terminal plan lives on the unmerged `experiment/rpi4-remote-terminal` branch at `docs/experiments/RPI4_REMOTE_TERMINAL_TEST_PLAN.md`.

## 1. Goals, decision, and non-goals

George has Spotify Premium Family and plans to use a Raspberry Pi 4 as a remote terminal with display, microphone, speakers, and camera, while the Mac mini retains the Nous core. Future goals include controlling Spotify through Nous and connecting more applications.

Propose a **Nous App Integration Layer (AIL)** in the existing Node/TypeScript core: a tool registration/execution boundary independent of the model provider and client device. Preserve HomeBridge, introduce an Adapter contract and mock tests, then validate independent Spotify playback via Soloist on the Pi. **Nous voice control of Spotify remains disabled unless Spotify provides applicable written authorization or an officially permitted integration path.**

Non-goals: moving the entire backend to the Pi, rewriting HomeBridge, delegating arbitrary app actions to the renderer, exposing MCP/Spotify WebSocket publicly, feeding Spotify audio to an LLM, building an App launcher or homepage Dashboard, or treating Premium Family as an exemption from API terms.

## 2. Current implementation mapping (main branch)

| Existing location | Current responsibility | AIL recommendation |
|---|---|---|
| `server/realtime.ts` | Shared tool definitions across realtime voice routes; `buildRealtimeTools` derives web/home/mcp/memory capabilities | Have Registry provide enabled and authorized tool specs; migrate incrementally |
| `server/live-tool-caller.ts` | Codex tool orchestration for ChatGPT-plan live route; fixed `HOST_TOOLS` allowlist; MCP removed | Gradually consume the shared Registry allowlist; retain call/time budgets |
| `src/realtime-tools.ts` | Common renderer `executeRealtimeTool` for API key and live paths, with `home_status` and `home_control` branches | Execute new integrations in the core; renderer only relays requests and displays results/approval |
| `shared/realtime-route.ts` | `HostToolName`, `SIDE_EFFECT_TOOLS`, timeout/unknown-result contract | Introduce versioned `IntegrationToolId`/`EffectClass` while maintaining a compatibility mapping |
| `server/app.ts`, `server/nous.ts` | HomeBridge HTTP endpoints, service composition, settings | Inject IntegrationRegistry into the core; expose only essential authenticated local operations |
| `server/home-bridge.ts` | Smart home bridge, outcome handling, approval logic | Wrap with a facade without weakening read-back or approval guarantees |
| `server/config.ts` | `.env`, MCP, smart home config | Add app enablement, authorization, diagnostics; never trust a model-provided URL |

Important difference: API-key Realtime supports remote MCP; the ChatGPT-plan live route does not support remote MCP but does use local function tools. Thus **core-local Adapters and a shared Registry** fit both routes better than wiring Spotify directly to remote MCP. Ordinary typed chat and background tasks do not yet have the same function execution loop and are not automatically supported by this proposal.

## 3. Proposed architecture

```text
Pi 4 (Chromium/UI/mic/camera/speaker) --- SSH local forwarding ---> Mac mini Nous Core
                                                                    |
OpenAI API key Realtime / ChatGPT live -> common tool registry ------+
                                                                    |
                           Integration Dispatcher + Policy/Status/Audit
                             |             |              |
                        Home Adapter    Spotify Adapter  Future Adapters
                             |             |              |
                         HomeBridge   Local Soloist     Calendar / Mail
                                         |
                         SSH reverse tunnel (loopback only)
                                         |
                               Pi 4 Soloist + audio output
```

**Soloist streams and outputs music on the Pi independently**. Nous voice WebRTC audio is also captured/played by Pi Chromium, but the two are separate processes requiring separate audio routing and no unauthorized mixing with speech. The AIOS Core stays bound to Mac `127.0.0.1`; the Pi terminal SSH `-L` and Soloist management SSH `-R` tunnels run in opposite directions. Soloist WebSocket is bound to Pi `127.0.0.1`, and the Mac receives the forwarded endpoint only on its own loopback. No LAN API port is exposed.

## 4. Adapter contract (proposal, not existing files)

Suggested additions:

```text
prototype/ambient-shell/
  server/integrations/
    registry.ts
    dispatcher.ts
    contracts.ts
    policy.ts
    status.ts
    adapters/
      home.ts
      spotify-soloist.ts
      mock.ts
  shared/
    integrations.ts
  tests/
    integration-registry.test.ts
    integration-dispatcher.test.ts
    integration-spotify-mock.test.ts
```

Illustrative types: tool IDs follow `app.<service>.<action>`. Never turn model-supplied strings into URLs, shell commands, or file paths.

```ts
type EffectClass = "read" | "reversible_write" | "external_commit";
type ToolResult = {
  ok: boolean;
  status: "confirmed" | "unconfirmed" | "unknown" | "needs_confirmation" | "refused" | "failed";
  message: string;
  data?: unknown;
};
interface IntegrationAdapter {
  id: string;
  version: number;
  tools(): readonly ToolDefinition[];
  health(): Promise<{ available: boolean; reason?: string }>;
  execute(toolId: string, args: unknown, ctx: ExecutionContext): Promise<ToolResult>;
}
interface ToolDefinition {
  id: string;
  description: string;
  inputSchema: unknown;
  effect: EffectClass;
  enabled: boolean;
  timeoutMs: number;
}
interface ExecutionContext {
  actor: "user" | "agent";
  sessionId: string;
  requestId: string;
  signal: AbortSignal;
}
```

This is a sketch, not a final schema. Implement with validated schemas and strict discriminated unions; `data` must hold only minimally necessary and safe-to-return information. Add `supportedRoutes` (api_key/live/text/background) and `capabilityStatus` (available/disabled/unsupported/authorization_required), then dynamically expose only actually available authorized tools. **The model cannot set `enabled` to true.**

### Execution sequence

1. Registry registers approved Adapters and checks unique IDs, schemas, versions, enabled state, source support, and quotas.
2. Dispatcher validates the call and arguments, checks policy and whether this action requires user confirmation, and emits a nonsensitive request ID.
3. The core executes the Adapter against configured trusted local endpoints with timeouts, cancellation and throttling. Side-effecting actions use request IDs or idempotency keys.
4. Reuse ApprovalQueue for confirmation. For actions requiring explicit consent, only the user can confirm. Existing HomeBridge H1/H1b semantics remain unchanged; do not require confirmation for every home command.
5. Return normalized results. Only `confirmed` means completed; report `unconfirmed` or `unknown` faithfully and never infer failure from timeout. Audit adapter, duration and result without credentials, playlist-private data or raw transcripts.
6. The renderer shows contextual, on-demand results only; no permanent app list or dashboard.

Do not install arbitrary runtime plugins in the first batch. Register reviewed Adapters explicitly in code. Later, MCP can be a transport inside an Adapter, rather than a mandatory transport for every app.

## 5. Spotify Adapter: separate technical possibility from permitted use

| Function | Technical candidate | Decision for this phase |
|---|---|---|
| Use Pi as a Spotify Connect player | Official Soloist ARM64/ARM32; manual pairing via Spotify app | **Eligible for manual testing now** |
| Soloist local `status` / `now` | `soloist ctl` or loopback WebSocket | **Eligible for isolated local observation tests**; do not automatically feed metadata to a cloud model |
| Manual UI play/pause/volume | Official Soloist local control | Check approved local-integration scenarios; do not connect tests to Nous voice |
| Nous voice control of Spotify | Web API or Soloist command | **Authorization pending; disabled by default** |
| Artist/playlist search and remote device control | Spotify Web API with OAuth | Research is possible, but a voice-control integration remains restricted; Development Mode owner must have Premium and supports up to 5 authorized users |
| Receive/rebroadcast raw Spotify audio | Not used | Unsupported; Soloist plays directly without exposing raw stream to Nous |

Spotify Developer Policy (effective 2025-05-15), section III.3, prohibits voice-enabled Spotify control apps; official Compliance Tips also flag Voice-Control as a prohibited use case. **Spotify Premium Family is a subscription entitlement, not an exemption from developer policy**. Do not bypass the intended product-use restriction by switching to Soloist WebSocket, Mac keyboard simulation, or another transport. Until Spotify grants written permission or a permitted integration path, `app.spotify.play`, `pause`, `search_and_play` and similar actions must not be exposed to Nous voice routes. If the policy or permissions change, record the review date, official link and permission evidence before proceeding.

Family members each have their own Spotify account. The first experiment uses a single owner account and a single Soloist device; there is no automatic household account switching or cross-account library indexing. Keep authorization information and Soloist sessions local. Any future OAuth flow should use least privilege, PKCE/secure storage, and explicit disconnect.

Official Spotify Soloist supports Linux ARM64/ARM32, Spotify Connect, an opt-in local WebSocket interface and `soloist ctl`. Linux playback primarily uses PipeWire with PulseAudio fallback. Builds expire **90 days after their build date**, requiring an updated binary. Do not redistribute the official binary or commit it. Soloist WebSocket lacks built-in authentication, TLS, Origin and CSRF controls, so it must remain loopback-only, never exposed to LAN.

### Device and audio ownership

- "Play on Pi" and "Play on Mac" are distinct output targets. A single account does not imply concurrent playback on both.
- Pi Chromium mic/TTS and Soloist music have distinct audio paths; test outputs and feedback prevention. Verify Spotify content-mixing restrictions; do not overlap Nous speech with Spotify audio on the same output by default.
- When the Pi, SSH tunnel, Soloist session or device ownership changes, return unavailable/unknown, never fabricated success.

## 6. Future applications and capability roadmap

| Adapter | Initial capability | Authorization/risk |
|---|---|---|
| `home` | Reuse HomeBridge query and control | Preserve one-way `unconfirmed` outcomes, device policies and fixed confirmation phrases |
| `spotify-soloist` | Local device health and manual experiment; voice functions off | Developer Policy voice-control gate; local WS loopback |
| `calendar` (provider TBD) | Read events and availability | OAuth read scope; create/update/cancel follow side-effect policy |
| `mail` (provider TBD) | Search messages and draft | Send requires an Action Gate and explicit same-turn confirmation |
| `video` (provider TBD) | Open permitted videos/playlists | Distinguish local player control from provider API authorization |
| `mcp` (optional) | Reviewed transport to external tools | Do not treat an unknown remote MCP as a trusted local Adapter |

### Implementation batches and gates

| Batch | Deliverable | Gate |
|---|---|---|
| AIL-0 (this PR) | Bilingual architecture, Spotify restrictions, weekend test checklist | Cross-linked docs, no main runtime change, no implied hardware validation |
| AIL-1 | Registry, Dispatcher, fake Adapter, normalized results; default-off flag | Same tool schema in api_key/live; illegal/disabled/timeout/cancel tests |
| AIL-2 | HomeBridge facade and gradual route migration | No regression for H0/H1/H1b; identical approval and unknown semantics |
| SP-0 (weekend) | Official Soloist on Pi, manual Spotify Connect, Pi audio, loopback WS/CLI observation | Pi hardware measurement report; no Nous voice tool |
| SP-1 | Local Spotify Adapter health and mock, voice disabled | Unauthorized functions absent from model tools; no secret leaks |
| SP-2 (blocked) | Implement any specifically authorized Spotify voice actions | Written permission/approved terms first, then real voice and failure-path validation |
| AIL-3 | Add second non-Spotify Adapter (e.g., Calendar) to test extensibility | No extra model-core switch or renderer branch needed |

## 7. Acceptance, rollback, and pending items

Run the [SP-0 weekend test plan](experiments/SPOTIFY_SOLOIST_WEEKEND_TEST_PLAN.en.md) and mark each step PASS/FAIL/NOT TESTED. Record sanitized Pi OS, CPU/RAM/temperature, device discovery and audio path evidence. A successful CLI demo is **not** proof that Nous can voice-control Spotify.

AIL-1 should at least test: duplicate tool IDs, malformed schema, a disabled service requested by a model, consistent behavior across routes, no credentials in the renderer, disconnects, unknown side effects after timeout, cancellation, single-use approval, secret-free logs and no HomeBridge regression.

Rollback: AIL starts off and retains the existing HomeBridge behavior. Stopping Soloist on the Pi reverses the experiment without stopping Nous. Do not modify production credentials or expose a local API on the weekend. **This design does not enable any Spotify, Calendar, or other App connection.**

## 8. Official references (checked 2026-11-03)

- [Spotify Developer Policy](https://developer.spotify.com/policy) — voice-control prohibition in III.3.
- [Spotify Compliance Tips](https://developer.spotify.com/compliance-tips) — Voice-Control restrictions.
- [Official Spotify Soloist docs](https://developer.spotify.com/documentation/soloist) — features, startup, API key.
- [Soloist Overview](https://developer.spotify.com/documentation/soloist/concepts/overview) — local WS, PipeWire, 90-day lifetime.
- [Soloist Basic Integration](https://developer.spotify.com/documentation/soloist/howtos/basic-integration) — loopback and CLI.
- [Soloist Downloads and Updates](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates) — ARM binary and updates.
- [Spotify Development Mode](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) — Premium app owner, 5 authorized users.
