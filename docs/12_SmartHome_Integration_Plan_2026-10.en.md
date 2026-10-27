<!-- bilingual: source=zh-TW -->

> [繁體中文](12_SmartHome_Integration_Plan_2026-10.md) | [English](12_SmartHome_Integration_Plan_2026-10.en.md)

<a id="nous-12--武陵居智慧家電整合規劃aios-端"></a>
# Nous 12: Wuling Residence smart-home integration plan (AIOS)

Version v0.5 · Date 2026-10-22 · Status: H0/H1/H1b implemented in the prototype. George verbally confirmed H1 light switching at home. H1b awaits hardware tests. H2–H4 not started. v0.2 adds George's four decisions (§8), v0.4 records H1 correction to §1 item 5, v0.5 adds AIFA AC and Tuya infrared.

> 2026-10-24 comparison: See [project status](Current_Implementation_Status.en.md) and [feature assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md). H1 executes directly by default; H2 device policy is not connected. Existing cards do not mean all devices require confirmation. Verbal home light reports/live temperature queries do not pass H1b, billing, or complete hardware acceptance. Quest spatial binding is later F8.
Counterpart: SmartHomeAI [`docs/AIOS接入規劃.md`](https://github.com/pcpcchen-coder/SmartHomeAI/blob/main/docs/AIOS接入規劃.md), required hub interfaces.
Related: 10 distant UI, 11 camera, live tools/approval (`prototype/ambient-shell/src/realtime.ts`, `src/approval.ts`).

---

<a id="0-一頁摘要"></a>
## 0. One-page summary

- **Goal**: Hands-free control/status from 1.5–3 m in front of an 18-inch screen: lights off, AC 26 degrees, humidity.
  - Lights, outlets, audio, curtains use general H1.
  - AIFA i-Ctrl AC power/temperature/mode/fan/swing uses H1b.
  - Tuya IR TV/fans use one remote key per H1b call.
- **Ownership**:
  - **SmartHomeAI hub**: Devices, states, commands, readback, tokens, per-device voice policy.
  - **AIOS**: Voice, name-resolution dialogue, cards, UI, presence. **Integration belongs in AIOS**.
- **Connection decided**: Local core calls LAN REST v1/SSE with scoped tokens.
  - **No OpenAI Realtime remote MCP**. That would expose home control publicly for OpenAI access.
- **Voice tools**: `home_status`, `home_control`, proxied by local core.
- **Per-device policy in hub**:
  - `allow`, default for all, executes directly.
  - `confirm`, card and fixed “確認執行” (“Confirm execution”).
  - `off`, refuses and explains.
- **Truthful outcomes**:
  - Only `confirmed` permits “turned off.”
  - `unconfirmed` means “sent, please verify.” AIFA/IR have no readback and never return `confirmed`.
  - Report `failed` as failure.

---

<a id="1-架構"></a>
## 1. Architecture

```
George（遠處）
  │ 語音（OpenAI Realtime，WebRTC）
  ▼
AIOS 前端（電子腦、確認卡）
  │ function call：home_status / home_control
  ▼
AIOS 本機核心 HomeBridge（新）── REST v1 + SSE，Bearer 範圍權杖 ──► 武陵居中控 :8788
  │                                                          （設備轉接器、回讀、稽核）
  └─ 權杖只在本機核心；不進瀏覽器、不進 OpenAI
```

**HomeBridge**, `server/home-bridge.ts`, has these responsibilities:

1. **Configuration**: `.env` `SMARTHOME_URL` and `SMARTHOME_TOKEN`, the AIOS-specific hub integration token.
   - Same Mac now: `SMARTHOME_URL=http://127.0.0.1:8788`.
   - Later use a LAN address such as `http://192.168.1.x:8788` without code changes. No fixed address or assumption of shared data/master token files.
2. **Cache** device/room lists (`GET /home`, `/devices`, later `/rooms`).
3. **Name resolution**:
   - Use `GET /resolve` once supplied (hub P0-3).
   - Until then deterministic local name/alias/room matching, exact before substring.
4. **Commands**: `POST /devices/{id}/commands` with AIOS-generated `Idempotency-Key`. Reuse on timeout retry.
5. **Results**: Subscribe `GET /events`, SSE Last-Event-ID replay.
   - Turn `command.result` (hub P0-4) into speech.
   - Until available, proposed polling `GET /commands/{id}`.
   - **H1 correction, 2026-10-22**: Actual hub POST is synchronous, waiting 0.4 s then readback up to 14 s for `confirmed`/`unconfirmed`/`failed`. Reposting identical content/key returns the recorded result, waiting if still running, without reexecution. Therefore H1 does not poll `/commands/{id}`. One same-key retry acts as polling even if the first response/command ID was lost. Two missing replies mean uncertain execution, never success. SSE remains H2 for future asynchronous behavior.
6. **Voice policy**:
   - Read hub `voice: "allow" | "confirm" | "off"` (P0-2).
   - **Edit only in hub**. No separate AIOS policy/risk classification.
   - Until implemented, treat all devices as `allow`, George's default.

<a id="2-即時語音的工具"></a>
## 2. Live voice tools

```jsonc
// 查狀態與感測值（不改變任何東西）
{ "name": "home_status",
  "parameters": { "target": "客廳 / 客廳主燈 / 全家", "metric": "temperature | humidity | co2 | power | …（可省略）" } }

// 控制一台設備（房間指令是 H3）
{ "name": "home_control",
  "parameters": { "target": "客廳主燈 / 冷氣 / 電視",
                  "command": "power | brightness | color_temperature | color | volume | mute | play | pause | stop | cover
                              | ac_temperature | ac_mode | ac_fan | ac_swing | press",
                  "value": "true / 60 / 3000 / #FFAA00 / 26 / dry / down / fixed_3 / volume_up …" } }
```

- `color_temperature` is light kelvin, renamed `temperature` only at the hub. AC Celsius is deliberately `ac_temperature`.
- `ac_mode`: `auto`/`cool`/`dry`. AIFA code 173 has no heat/fan-only. `ac_fan`: `auto`/`low`/`medium`/`high`/`up`/`down`. `ac_swing`: `auto`/`fixed_1`–`fixed_5`.
- `press` sends one IR key. Value is intent (`power`, `volume_up`, `volume_down`, `mute`, `channel_up`, `channel_down`, `fan_speed`, `oscillate`) or spoken key name. Bridge resolves synchronized real keys; model never sees IDs. IR power/mute are key presses too.

Model responses must follow returned data without filling gaps:

| Situation | Return | Speech |
|---|---|---|
| Multiple names | `{ status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] }` | Ask main vs floor lamp, two numbered cards, “first” works. |
| Missing | `{ status: "not_found" }` | No device with this name. |
| `confirm` | `{ status: "needs_confirmation", confirm_id }` | Brief action, request “確認執行.” |
| `off` | `{ status: "voice_disabled" }` | Voice control disabled. |
| Confirmed | `{ status: "confirmed", message }` | Main living-room light is off. |
| Unconfirmed | `{ status: "unconfirmed", why, message }` | Sent, please check response. |
| AC/IR H1b sent | `{ status: "unconfirmed", why: "one_way", key?, toggle?, sent_settings?, defaults_used?, controller_reported?, note? }` | Sent, verify. Name key. Toggle never implies on/off. Say controller-reported, disclose defaults. |
| IR cloud silent | `{ status: "unconfirmed", why: "cloud_no_reply" }` | No cloud reply, uncertain whether sent. |
| Failure | `{ status: "failed", message }` | Actual reason. |
| Missing reading | `value: null` | No reading, never zero. |

**Confirmation** reuses PR #9:
- **Only `confirm` devices**.
- Amber card with action/device/room/value.
- `src/approval.ts` requires fixed “確認執行.” “Yes” is insufficient. Cancel, 60-second timeout, dismissal send nothing.
- Extend the MCP-only `mcp_approval_request` queue for HomeBridge `needs_confirmation`. Local core executes confirmation without OpenAI.

<a id="3-畫面延續-10-的遠距規則"></a>
## 3. Display (10's distant rules)

- **Status**: Screen 05 anchor style, large number/room, e.g. living room 26.5°/62%, timestamp. Old data marked snapshot rather than live.
- **Results**: Device plus large ✓ confirmed /⏳ sent /✕ failed, dismiss after 3 s without buttons.
- **Room commands**: Per-device results rather than “all succeeded.”
- **Details**: Readbacks, sources, times emailed, not on the 18-inch screen (10 §5).

<a id="4-與雙目鏡頭11的整合"></a>
## 4. Stereo integration (11)

- Apply distance type scaling to appliance status.
- Arms select screen candidates only, not physical appliances. Camera coordinates do not map appliances to hub floor plans. Plan that separately.
- Stop gesture stops speech only, never appliance control.

<a id="5-安全與隱私"></a>
## 5. Security and privacy

- **Tokens**: Hub scopes `devices:read`, `telemetry:read`, `commands:write`, `events:read` (P0-1). No vendor credentials, configuration writes, or token management.
  - Before scopes exist, full tokens may validate example devices only, explicitly labeled in README.
- **Storage**: `.env`, core only, never browser, traces, or OpenAI session configuration.
- **No public internet** access or OpenAI remote MCP exposure.
- **Rate**: Bridge max six commands/minute against accidental repeated speech. Hub policy supersedes after P1-3.
- **George's confirmation decision**: Direct appliance control by default, per-device confirm/off in hub. CLAUDE.md lists sending, publication, payment, permanent deletion as current-confirmation red lines; appliance control is not included. `confirm` devices retain fixed spoken confirmation.

<a id="6-工作批次aios-端"></a>
## 6. AIOS work batches

| Batch | Content | Dependencies | Completion |
|---|---|---|---|
| H0 | Bridge/config, read-only status, local resolution, fake hub | Existing REST | Speak living-room temperature, true value/time, missing stays missing |
| H1 | Direct control, key, synchronous readback, same-key retry, test-triggered confirmation | H0 | Example device controls/reporting, unconfirmed never success |
| H1b | AIFA power/temp/mode/fan/swing, one Tuya IR key, never confirmed | H1, existing hub endpoints | Real AC 26/on, TV on/volume. Say sent/verify, honest missing-key/stale-list refusal |
| H2 | Scoped token, voice policy, resolve, command.result SSE | Hub P0-1–P0-4 | allow direct, confirm fixed phrase, off refused, numbered ambiguity, live results |
| H3 | Room groups, per-device results | Hub P1-2 | Real distant voice turns off room lights |
| H4 optional | Background multi-step agent through local hub MCP | Hub P3 | Same scopes/policy as voice |

Every batch delivers files, tests, hardware evidence, gaps under CLAUDE.md.

**H1b implementation, 2026-10-22**: Same `home_control` and `server/home-bridge.ts`. `control` → `planFor` → `sendCommands` (unchanged H1)/`sendAifa`/`sendIr` → `commandsReply`/`aifaReply`/`irReply`.

- **Routing** is decided once per device while reading:
  - `commands`: unchanged H1 POST.
  - `aifa`: AC exists only in `GET /integrations/aifa` children (`type "0"`, `sub_type "0"`). Read/merge alongside `/home` every time. Room comes only from `matched_device_id`, absent if unmatched. List failure does not block lights; missing AC explains unavailable AIFA list. `online` may be 24 hours old: never say currently online. Offline includes list-read time, e.g. last list at 12:20. Without timestamp, state unknown.
  - `infrared`: `config.infrared_virtual`, ignore always-false `configured`, use `infrared.ready`.
  - `unsupported`: Non-AIFA AC (Tuya `kt`/`ktkzq`, HA `climate.*`), AIFA controller itself, IR controller `wnykq` (ask appliance name), wireless buttons, non-AC AIFA.
  - IR checked first. IR AC refuses `ac_temperature`, supports `press` only.
- **AIFA power**: `POST …/children/{c}/power {"power":bool}`. Hub shutdown also cancels that AC's timers. George 2026-10-25 requires spoken `note` after `one_way` or possible delivery `no_reply`: if a timer exists, hub shutdown cancels it and it must be reset. With no reply, qualify “if the hub executed shutdown.” AIOS cannot read timers, claim a timer definitely canceled, or claim AC off. `realtimeToolRules` enforces both. No note after failure/non-send.
- **AIFA settings**: `/climate` requires full mode/temp/fan/swing. First `POST …/status` reads controller memory; fill missing fields with auto mode (George 2026-10-25, all seasons, formerly cool), 26°, auto fan/swing, normal feature if absent. `defaults_used` lists defaults for spoken disclosure. Preserve reported sleep/turbo.
  - Off AC reports null mode/temp, so dry uses default 26°. Note settings do not imply power-on.
  - “AC on at 26” is two calls, power then temperature, report both.
  - Fan up/down moves one reported step. Auto/missing refuses and asks low/medium/high/auto. Report existing min/max honestly.
  - Follow device `capabilities`: 17–30°, auto/cool/dry. Non-173 supports power only; refuse settings before send.
- **IR keys**: `POST /devices/{id}/infrared-commands {key, key_id}`, one press, never repeated presses. Select during `control()` so card names the actual key, e.g. Vol+.
  - Normalize NFKC, lowercase, Chinese plus/minus to +/- , minus −→-, ▲→+, ▼→-, remove spaces/underscores. Match intent synonyms exactly, then exact key name, **no substrings** for intent. volume_up cannot match navigation Up, which may change AC temperature. Find dedicated on/off first, then power toggle. Power/mute are toggles: say pressed Power, never on/off/muted/unmuted; `mute false` presses the same key. Other phrases are key names: exact, then unique substring. Multiple distinct `(key,key_id)` pairs, with default ID 0, ask which. Missing lists up to eight real keys. Exclude auto/low/on/high synonyms deliberately because they may be AC modes.
  - Unsynced or >24-hour keys refuse. Ask hub IR-controller Sync. AIOS never syncs because hub failure clears keys.
- **Outcomes**: AIFA/IR have no readback, never `confirmed`. `one_way`: sent/verify. `cloud_no_reply`: IR cloud silent, uncertain, hub does not retry automatically. `no_reply`: hub silent/still processing. `controller_reported` is remembered configuration, not actual AC state. HTTP 200 `failed` is failure.
- **AIFA list freshness**: Older than 24 h minus 10 min, or hub 409 refresh request, triggers one `POST /integrations/aifa/discover` per command, then send/retry with same key. Discovery failure means not sent. Discovery 429 due to another read within one minute still proceeds; hub decides. If still stale, `not_ready`, `retry_after_s: 60`. Recheck device existence afterward.
- **Retries**: Max two POSTs with same key/content. One retry shared among timeout/5xx/network, cooldown 429 (AIFA global 2 s, IR/controller 1 s; rejected before key recording, safe waits 2.2/1.2 s), and stale-list 409 after discovery. Second cooldown returns `rate_limited`. If first might have arrived, disregard a later “not sent” and report uncertainty.
- **Time**: `UTTERANCE_MS` 60 s caps every step. Do not start POST with <5 s left. Before first means not sent; after means uncertain. Timeouts: list 8 s, status 22 s, discovery 25 s, AIFA send16+retry12, IR send16+retry10. See validation for worst-case arithmetic. H1 `/commands` worst55 s remains within budget.
- **Shared limits**: Six/minute across routes, count once just before first control POST. Refused before POST (discovery failure, incomplete settings, minimum already reached, insufficient time), discovery/status/retries do not count. Test `policyFor` works on all routes. Ambiguous AIFA/IR candidates always include route, e.g. AC (AIFA), living-room AC (IR remote); result `note` instructs exact candidate names because AIFA often lacks room. Follow parenthesized route even if name matches another route.

See [H1b validation](validation/smarthome-h1b-2026-10-22.en.md): fake hub, timing budgets, real hub program in example configuration without AIFA/Tuya credentials, with fixture lists/keys. Still missing home voice hardware tests and actual IR key names.

**H1 implementation, 2026-10-22**: `HomeBridge.control`/`confirm`, `POST /api/home/control`, `/api/home/confirm`, realtime tool, cards/caption anchors.

- Commands: power, brightness, light kelvin `color_temperature`→hub `temperature`, color, volume, mute, play/pause/stop, curtains. **At H1, AC/IR were unsupported**, later added by H1b. `/home` fields identify AIFA/Tuya `kt`/`ktkzq`/HA `climate.*` and IR, refusing as unsupported. Other remotes such as Tuya `wxkg` report unsupported class rather than mislabel AC/IR. Tool descriptions/model instructions agree on H1 limitations for AC power/temp, IR, wireless buttons.
- One device only. Room/whole-home requests return `ambiguous` even if one device, pending H3.
- Only `confirmed` succeeds. `unconfirmed` has `hub_unverified` or `no_reply` after two timeouts. `failed` gives reason. `refused` means not sent due to incomplete integration/stale state/unsupported/value/rate/policy/no confirmation/expired card. `accepted`, `sent`, unknown hub statuses remain unconfirmed.
- Hub 409 `state_stale` after readback timeout triggers one `POST /devices/{id}/refresh` then same-key retry. 409 precedes key recording, so no double execution. Persistent failure says stale/not sent. Do not pre-reject from `can_control`/`state.commands`, which is empty after timeout and could falsely imply unsupported.
- Time: `/home`8 s, each POST16 s, refresh15 s, one retry shared across failures/stale. Worst8+16+15+16=55 s, confirmed card omits home reread, worst47. Initial speech acknowledges hub processing; caption says controlling device.
- Cards connected but no H1 device triggers except test-only `policyFor`, unavailable through `.env`/config. H2 reads hub `voice`. Answers go to core, not OpenAI; results become system notices. Confirmation ID is single-use, device/command-bound, expires90 s. Card countdown min(60,`expires_in_s`). If MCP/home card open/queued, drop new home card, return `busy`, ask answer existing then repeat.

See [H1 validation](validation/smarthome-h1-2026-10-22.en.md): fake hub and real example hub, no real devices. Status above adds verbal home light confirmation, without changing original test scope. Complete device-by-device results, measurements, and §3 large icons remain missing.

**H0 implementation, 2026-10-21**: `prototype/ambient-shell/server/home-bridge.ts` config, `GET /api/v1/home`, local matching/readings, `POST /api/home/status`, live tool/caption anchors. Every query fetches hub data, without reading cache. See [H0](validation/smarthome-h0-2026-10-21.en.md), later home temperature logs/verbal reports in [live voice §4](validation/live-voice-2026-10-23.en.md#4-真實結果george-家中測試). Full measurements and §3 numeric anchors remain missing.

<a id="7-測試"></a>
## 7. Tests

- **Fake hub**:
  - Node HTTP `/devices`, `/commands`, `/events`.
  - confirmed/unconfirmed/failed, timeout, same-key retry409, SSE replay.
  - H1b list/discover/status/power/climate/IR endpoints; stale lists, cooldown429, 200 failed, 409 strings, cloud silence, missing keys, fake-clock60 s. No AC/IR confirmed.
- **Voice**:
  - RealtimeVoice fake channel for tools/cards/fixed phrases/cancel/timeout.
  - “Yes” must not send.
- **Privacy**: No token in frontend, OpenAI session body, logs.
- **Hardware, George**:
  - At least one LIFX/Tuya light with readback.
  - AIFA power/temp/mode/fan, one-way unconfirmed.
  - IR TV/fan keys only, one-way unconfirmed. IR AC keys only, no temperature setting.
  - Temperature/humidity sensor with value/time.

<a id="8-george-的決定2026-10-21"></a>
## 8. George's decisions (2026-10-21)

1. **Deployment**: Same Mac now. Later only `SMARTHOME_URL` IP changes (§1).
2. **Confirmation**: Direct by default, per-device confirm later (§1 item6, §2).
3. **High-risk devices**: Voice allowed, per-device off later. Combine items2/3 in **hub settings**, not AIOS (P0-2).
4. **Home events while nobody is home**: Deferred.
