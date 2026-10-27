<!-- bilingual: source=zh-TW -->

> [繁體中文](smarthome-h1b-2026-10-22.md) | [English](smarthome-h1b-2026-10-22.en.md)

<a id="武陵居家電控制-h1b-驗證aifa-冷氣紅外線家電"></a>
# Wuling Residence H1b device-control validation: AIFA AC and infrared appliances

Date: 2026-10-22. Platform: Linux cloud, Node.js 22.22.0. Corresponds to H1b in [docs/12](../12_SmartHome_Integration_Plan_2026-10.en.md), extending `home_control` to AIFA AC and Tuya IR appliances. Prototype validation does not change G0–G3 acceptance status.

**This document contains no results from real AC or real infrared appliances.** Fake-controller tests are fixtures. Real controller code has no AIFA account or Tuya cloud credentials; AC lists/IR keys are fixtures written into its database, so only failure, not-sent, and cooldown retry paths are reachable. George's home steps are at the end, with no results recorded yet.

<a id="結果"></a>
## Results

| Check | Result | Scope |
| --- | --- | --- |
| `npx vitest run` | Pass, 586 tests: 580 before review fixes, 537 before H1b | H1b added 43: home-bridge 41, HTTP one, realtime-voice one; review adds six home-bridge tests. See below. |
| Real controller code | Pass for refusal, failure, cooldown paths only | SmartHomeAI FastAPI example configuration plus fixture AIFA list/IR keys. No AIFA account or Tuya credentials, so no vendor receives commands. |
| `npx tsc --noEmit`, `npx vite build`, `node --check desktop/main.mjs`, `node scripts/verify-aios.mjs`, `git diff --check` | Pass | |

<a id="假中控測試fixture"></a>
## Fake-controller tests: fixtures

Node HTTP fake controller uses fictional devices, lists, keys, and replies. Formats follow controller `backend/app.py`, `aifa.py`, and `infrared.py`: AIFA string errors (409 refresh list first, authorized AC not found, same ID cannot identify different content; 429 wait two seconds), success 200 `unconfirmed` plus `controller_status`; IR `{code, message}` errors `ir_cooldown`, `ir_keys_required`, `ir_key_unsupported`, `ir_not_authorized`, success 200 `unconfirmed` plus `transport_status`. Injected `sleep` advances a fake clock rather than waiting.

`tests/home-bridge.test.ts`:

- **Merged AIFA list:** AC room comes from controller device matched by `matched_device_id`, otherwise none. Query says state unknown, not online; offline includes list-fetch time, review item six. List 500/404/malformed/timeout still permits light control; AC gives `not_found` plus unavailable-list note. Unlinked account says only not found. AC setting code other than 173 permits power only; settings reject before send or `/status` read. Non-AC AIFA appliances refuse accurately.
- **Power:** exact `{"power":true}` with `Idempotency-Key`; `unconfirmed`/`one_way`, subtitle sent/please confirm. `controller_reported` says controller reports on, cooling, 26 degrees, low fan, automatic swing; system notice clarifies this is not physical AC state.
- **Settings:**
  - “26 degrees” with AC on first POSTs `/status` without body, then `/climate` with five fields `{mode, temperature, fan, swing, feature}`. Mode/fan/swing follow controller, sleep feature retained.
  - With AC off, 26 degrees uses cooling default, `defaults_used: ["模式：冷氣"]`; note says this setting does not mean power-on; no “already on” result.
  - Off AC, switch to dry: default temperature 26 degrees, correcting candidate design one's missing temperature default.
  - `/status` timeout/409 uses all defaults, listing four in `defaults_used`.
  - Fan down changes medium to low; automatic/unknown/already-low refuses `/climate` and explains.
  - Heating, fan-only, 35 degrees, 25.5 degrees refuse locally without requests.
- **Controller replies:** 200 `failed` → `failed`/`device` with reason; recorded but processing `accepted` → `no_reply`. Authorized AIFA AC not found 409 → `not_ready` with original message; only same-key/different-content is internal AIOS error.
- **429 cooldown:** wait once 2.2 seconds, resend same key/content → `one_way`; repeated 429 → `rate_limited`, `retry_after_s: 2`, two POSTs, not 502.
- **Slow replies:** timeout then recorded result → `one_way`, same key. Two timeouts → `no_reply`; timeout then 409 also `no_reply`, never not-sent because controller checks list before recorded-key matching.
- **List older than 24 hours:** one `/discover` before send. Discover 409 or device absent after refresh → `not_ready`, no send. Discover 429 still sends; if controller still says stale → `not_ready`, `retry_after_s: 60`. Apparently fresh list but stale 409 → one refresh and same-key retry. Settings order: discover → status → climate.
- **Infrared:**
  - TV on presses `Power`, `{key:"Power", key_id:1}`, `toggle: true`; subtitle says key sent/please confirm and toggle key. IR `configured:false` still sends.
  - Louder, `press volume_up`, presses `Vol+`; `channel_down` presses channel-minus; `mute` presses `Mute`.
  - Fan on/off prefers separate `PowerOn`/`PowerOff`, not toggle. Exact `timer` and uniquely contained `Spe` choose correct keys.
  - Missing oscillation key → `unsupported`, lists PowerOn/PowerOff/Speed/Timer without send. Two keys for one intent, such as volume-plus and Vol+, ask which.
  - Unsynchronized `ready:false` → `not_ready`, no request. IR hub itself asks for appliance name. Numeric volume asks user to say louder.
  - IR AC remote rejects `ac_temperature`; `press "temp 加"` presses `Temp+`.
  - `ir_cooldown` waits 1.2 seconds once and same-key retries. `transport_status: unknown` → `cloud_no_reply`, subtitle says cloud did not reply, uncertain sent, controller will not automatically retry. Tuya rejection → `failed`; keys-required → `not_ready`; key-unsupported → `unsupported`; not-authorized → `not_configured`.
- **Shared rules:**
  - Same-named AIFA/IR AC candidates include room and route, “客廳的冷氣（紅外線遙控）” and “客廳的冷氣（AIFA）”; answering with either selects it.
  - Target “冷氣26度” does not become a reading query; `ac_temperature` to a light does not reach `/commands`; `temperature` is not a command.
  - Shared six-per-minute limit across three paths: three lights, two AC, one IR; seventh sends no request.
  - Test-only `policyFor` confirmation: IR card says press Vol+; simultaneous approvals send once. AC card does not read `/status` before approval; rejection sends nothing, approval reads status then sends.
  - Even fixture AIFA/IR `confirmed` never becomes AIOS `confirmed`. Results/payloads never contain token.
- Other checks: `keyNorm` maps 加→+ and preserves trailing -, every IR intent has synonyms without ambiguous auto/on/low/high words, `buildClimate` defaults, and `parseCommand` phrases.

`tests/http.test.ts`: `/api/home/control` with `ac_swing fixed_3` and `press volume_up` causes status/climate/infrared-command POSTs in sequence; responses contain no token. Two H1 tests gain `GET /api/v1/integrations/aifa`, read with `/home` every time. `tests/realtime-voice.test.ts`: `ac_temperature` call and `one_way` result pass unchanged to model, then request speech.

Only these H1 expectations changed: IR TV `ready:false` unsupported → not-ready; Tuya `kt`/`ktkzq` and Home Assistant AC refusal says AC not connected through AIFA; controller's AIFA hub says controller itself; tool/model wording. Fake controller additionally answers unlinked-account `GET /integrations/aifa`.

<a id="審查修正"></a>
## Review fixes

Independent review of `7a7f70a` found six issues, all fixed with one `review:` regression each in home-bridge, plus four changed existing expectations. Reverting `server/` and `shared/` to pre-fix code makes all ten fail.

1. **Intent fell through to substring matching and wrong keys:** absent a synonym, `press volume_up` searched normalized `volumeup` by containment and selected navigation `Up`/`Down`, potentially temperature on an IR AC. Known intents now match only synonyms/exact names, never substrings; otherwise refuse and list actual keys. `keyNorm` maps ▲/△ to +, ▼/▽ to -, U+2212 − to -, while NFKC already handles fullwidth signs. Thus 音量▲/頻道▼/Vol − match existing 音量+/頻道-/Vol- without extra synonyms; none is bare +/-. Tests select correct volume/channel keys on bedroom TV with Power/Up/Down/音量▲/音量▼/頻道▲/頻道▼. A window AC with Power/Up/Down/Mode refuses volume_up and 音量加, lists keys, and sends no IR request.
2. **Roomless AIFA AC could not be selected:** living-room IR AC and roomless AIFA AC produced living-room AC/AC candidates without route tags because names differed. Repeating AC returned both forever. All AIFA/IR clarification candidates now carry routes, with note requiring `target` copied exactly including （AIFA）/（紅外線遙控）. `home_status` and ambiguous `home_control` model instructions agree. Explicit parenthesized route overrides a name that otherwise matches another path. Tests select AIFA `c9` with either 冷氣（AIFA） or 客廳的冷氣（AIFA）; IR-qualified candidate presses Power.
3. **Shared `key_id` hid ambiguity:** same-key detection used only `key_id`, whose default is 0, so Vol+/Vol- both 0 made “vol” select Vol+. It now uses `key` plus `key_id`. Two 0-ID keys ask which; duplicate identical key still counts once.
4. **IR mute is a toggle:** `mute false` pressed same key as true without toggle flag. Any mute key selection (`mute`, `press mute`, exact key name) now sets `toggle: true`. Generic toggle subtitle and system/model instructions explain each press toggles once and prohibit claims of on/off/muted/unmuted. Both booleans press `{key:"Mute", key_id:4}`, toggle true; subtitle/notice/result contain no already-muted/unmuted claim.
5. **Refusals without POST consumed rate slots:** limit was recorded at entry, including failed discover, unknown current fan, already-low, or insufficient budget without send. It now records immediately before first control POST (`postTwice`, or H1 before `sendCommands`), once per intent. Same-key/cooldown/refresh retries, `/discover`, `/status` do not count. Test three no-POST refusals then three lights/two AC/one IR all send; seventh sent intent is limited without requests. Tradeoff: rate-limited AC settings can still read `/status`, a non-control operation.
6. **Historical AIFA offline reported as current:** `online:false` may come from a list up to 24 hours old, but status said offline. Now says offline when AIFA list was last read at 12:20, with date for other days; unknown if no timestamp. Native controller devices unchanged. Tests check one-hour-old 12:20 master-bedroom AC, null timestamp unknown, and native living-room lamp still offline.

docs/12 H1b and prototype README IR sections were updated accordingly.

<a id="時間預算"></a>
## Time budgets

`H1B_TIMEOUTS_MS` in `server/home-bridge.ts`: list read eight seconds, `/home` and AIFA concurrently; `/status` 22; `/discover` 25; AIFA send 16 plus retry 12; IR send 16 plus retry 10. Home-bridge budget tests sum constants and check the 60-second `UTTERANCE_MS` cap.

| Scenario | Calculation | Nominal worst | Actual cap |
| --- | --- | --- | --- |
| AIFA settings, stale list | 8 + 25 + 22 + 16 + 12 | 83 s | 60 s |
| AIFA settings | 8 + 22 + 16 + 12 | 58 s | 58 s |
| AIFA power | 8 + 16 + 12 | 36 s | 36 s |
| AIFA power, stale list | 8 + 25 + 16 + 12 | 61 s | 60 s |
| Infrared | 8 + 16 + 10 | 34 s | 34 s |
| H1 `/commands`, unchanged | 8 + 16 + 15 + 16 | 55 s | 55 s |

- Each timeout is min(own constant, remaining time). `/status` reserves five seconds for sending. Less than `MIN_SEND_WINDOW_MS` five seconds means no new POST: `not_ready`/not sent if none yet, `no_reply`/uncertain if already sent once.
- Cooldown path is shorter: first 429 nearly immediate, wait 2.2 s or IR 1.2 s, then 16 s send.
- `confirm()` does not reread lists; 60 seconds begins at approval.
- Fake-clock tests: stale-list settings consume discover 25 s, status 22 s, first send capped to remaining 13 s and returns 503; no retry, `no_reply`, total 60 s. Discover 40 plus status 17 leaves three, `not_ready`, no POST. Cooldown 429 after 56 s → `rate_limited`, one POST.
- H1 `/commands` worst 55 s is under 60, so deadline is not applied to H1 and `sendCommands` stays unchanged.

<a id="真實中控程式"></a>
## Real controller code

SmartHomeAI `90a3168` `backend/app.py`, `WULING_POLL=0`, temporary directory, example seed, master token. **No AIFA account or Tuya cloud credentials:** AC receives no packets and IR never reaches Tuya. Every row records real `HomeBridge.control` requests/results.

<a id="沒有寫入任何-fixture示例配置本身"></a>
### Example configuration without inserted fixtures

| Phrase | Controller request/reply | Result/subtitle |
| --- | --- | --- |
| AC power true | GET home/AIFA → `connected:false`, no AC | `not_found`, no linked-account note |
| Example light ac_temperature 26 | Lists only, no POST | `refused`/`unsupported`: not AIFA AC/IR, cannot set 26, not sent |
| Example light power false | H1 commands POST → 409 stale, refresh 200, same-key POST 409 | `refused`/`not_ready`, same as H1 |
| TV press volume_up | Lists only | `not_found` |

<a id="寫入-fixture-的-aifa-清單與紅外線按鍵不是任何真實設備"></a>
### Fixture AIFA list and IR keys, no real devices

`seed_h1b.py` inserts one AIFA AC named 冷氣 with setting code 173, one `wnykq` IR hub, one IR TV with Power/Vol+/Vol-, and a Tuya device authorization list. AIFA token/Tuya cloud credentials remain unset.

List read one hour ago:

| Phrase | Controller request/reply | Result/subtitle |
| --- | --- | --- |
| AC power true | POST `…/children/fixture-ac/power {"power":true}` → 200 failed, link AIFA Smart account first | AC on fails with account-link reason |
| AC ac_temperature 26 | POST status → 409 unlinked account; use defaults. POST `…/climate {"mode":"cool","temperature":26,"fan":"auto","swing":"auto","feature":"normal"}` → 200 failed | Set 26 fails, no sent-settings/default fields on failure |
| TV power true | POST `/devices/ir-fixture-tv/infrared-commands {"key":"Power","key_id":1}` → 200 failed, Tuya credentials unset | Power key failure with that reason |
| TV press volume_up immediately after | POST → **429 `ir_cooldown`**, controller records send time before Tuya; wait 1.2 s, same-key POST → 200 failed | Vol+ failure, total 1219 ms |
| TV mute true | Lists only, no POST | No mute key; lists Power/Vol+/Vol- |
| Fixture IR controller power true | Lists only | Hub itself; asks for appliance name such as TV |

List read 25 hours ago, beyond controller 24-hour limit:

| Phrase | Controller request/reply | Result/subtitle |
| --- | --- | --- |
| AC power true | POST discover → 409 link account first, no send | `not_ready`, list older than 24 h, refresh failed, not sent, use controller AIFA page |
| AC power false within one minute | Discover 429, AIFA sync minimum 60 s including failed attempt; still POST power → 409 refresh list first | `not_ready`, `retry_after_s: 60`, not sent, retry after one minute |
| AC ac_mode dry within one minute | Discover 429; status 409 stale; climate 409 stale | Same as above |

With list 23.9 hours old, beyond AIOS's 24 h minus 10 min but within controller 24 h: AC power true first discovers → 409 no account, refresh failure prevents send, `not_ready`. Within one minute, set 26: discover 429, status 409, then climate accepted against the list but 200 failed for missing account. This group ran before the final two wording changes (refusal wording and omit settings from failure); request order/status unchanged. Both tables above were rerun after changes.

curl confirms same-key/same-body power POST twice returns same result/id; same-key/different-body → 409 same command ID cannot identify different content; missing `Idempotency-Key` → 422 provide unique ID. AIOS always includes it.

Every result was checked for token absence.

**Real paths not reached:** AIFA successful send `unconfirmed` plus `controller_status`; AIFA two-second cooldown, recorded only on packet send and unreachable without account; real `/status` settings; successful discover; IR `accepted_by_cloud`/`unknown`; slow replies/timeouts. These have only fake-controller tests.

<a id="尚未驗證"></a>
## Not yet validated

- **Real AC/IR appliances:** all above are fixtures.
- **Controller continuation after AIOS disconnects:** controller uses Starlette `BaseHTTPMiddleware`; cross-review inferred from code that handling is not canceled. Same-key retry assumes this, without measurement.
- **Controller remembered settings after physical remote use:** `/status` may remain old; results say controller reports only.
- **Hardware voice:** whether model splits AC-on-26 into two calls, discloses defaults, or wrongly says toggle already off remains untested.
- **George's IR key names:** synonyms use common Tuya names; verify with the table below.

<a id="2026-10-25-補記"></a>
## Addition, 2026-10-25

George made two decisions and code changed. Surrounding text retains its 2026-10-22 wording.

- If off-AC mode cannot be read, default is now **automatic** in every season, previously cooling. Above `defaults_used: ["模式：冷氣"]` and real-controller `"mode":"cool"` are now `["模式：自動"]` and `"mode":"auto"`. `sent_settings` prefixes mode, such as automatic mode, 26 degrees, high fan, fixed swing 2.
- On AIFA AC off, Nous conditionally explains the controller also cancels any timer and asks to reset if needed. Expected results for AC-off step 3 and default-mode step 4 change accordingly; see [three small decisions](small-decisions-2026-10-25.en.md#george-在-mac家裡的測試步驟).

<a id="george-家裡的實機驗證步驟"></a>
## George's home hardware steps

1. Controller running, integration token in Nous `.env` as completed in H1. AIFA account linked and list read today. Sync IR hub and confirm TV/fan keys synchronized.
2. `npm start`; terminal reports configured query/control controller and available realtime voice.
3. Start voice conversation; wait for each reply before next phrase.
   - **AC**
     1. “開冷氣” (“AC on”): initial acknowledgment, sent/please-confirm subtitle, no already-on claim. Actual AC on: ____.
     2. “冷氣調 26 度” with AC on: sent setting-26 subtitle; Nous may mention controller mode/fan. Panel: ____.
     3. “關冷氣”: sent/please-confirm off subtitle. Actual off: ____.
     4. “冷氣調 26 度” with AC off: disclose default cooling mode and no power-on implication. Did AC turn on itself: ____; controller docs do not specify, record honestly.
     5. “冷氣改除濕” after turning on: mode dry subtitle. Panel: ____.
     6. “冷氣風量調小”: step down from low/medium/high, or unknown current fan if automatic, asking for low/medium/high/auto. Result: ____.
     7. “開冷氣 26 度”: expect two calls, power/settings, two subtitle lines. Result: ____.
   - **TV/fan**
     1. TV on: Power-key sent subtitle with toggle warning, using actual home key name; no TV-already-on claim. Actual: ____.
     2. TV louder: Vol+ or equivalent, one step. Result: ____.
     3. Fan on: distinct on key if available; otherwise Power with toggle disclosure. Result: ____.
     4. Request missing TV key, such as oscillation: says missing and lists available keys, no send. Result: ____.
4. Record subtitle, Nous words, physical response, especially AC-on seconds from end of speech to subtitle and whether off-AC setting powers on.

<a id="george-家的紅外線按鍵名稱待記錄"></a>
## George's home IR key names, pending

Read every appliance's synchronized key `label` in controller IR page; record below with Nous's actual selection. Report missing/wrong matches so `IR_SYNONYMS` in `server/home-bridge.ts` can be extended.

| Appliance | All controller key names | Key chosen for “on” | Key chosen for “louder”/“fan speed” | Unmatched phrases |
| --- | --- | --- | --- | --- |
| TV | | | | |
| Fan | | | | |
| Other | | | | |

<a id="george-家裡的實機結果"></a>
## George's home hardware results

Not yet recorded.
