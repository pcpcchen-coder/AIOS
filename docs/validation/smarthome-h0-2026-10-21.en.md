<!-- bilingual: source=zh-TW -->

> [繁體中文](smarthome-h0-2026-10-21.md) | [English](smarthome-h0-2026-10-21.en.md)

<a id="武陵居家電狀態查詢-h0-驗證"></a>
# Wuling Residence home-device status query H0 validation

Date: 2026-10-21. Platform: Linux cloud environment, Node.js 22.22.0. Corresponds to batch H0 in [docs/12](../12_SmartHome_Integration_Plan_2026-10.en.md). This validates the prototype and does not change G0–G3 acceptance status.

<a id="結果"></a>
## Results

| Check | Result | Scope |
| --- | --- | --- |
| `npx vitest run` | Pass | Added `tests/home-bridge.test.ts`: fake-controller HTTP queries, missing values, snapshots, candidates, not found, token errors, offline controller, HTTP 500, malformed format, token non-disclosure, name matching, reading names, and tools available only when the controller is configured. `http.test.ts` adds `/api/home/status`; `realtime-voice.test.ts` adds `home_status` tool calls. |
| Real controller code | Pass | Runs SmartHomeAI's FastAPI controller on the same machine with example configuration, queried using the controller master token. |
| Real server entry point | Pass | Starts `server/index.ts` with `SMARTHOME_URL` and `SMARTHOME_TOKEN`; `POST /api/home/status` returns controller readings, and startup messages and responses contain no token. |
| `node scripts/verify-aios.mjs` | Pass | Types, all tests, frontend build, isolated mock task and direct-chat HTTP journeys. |
| `node scripts/check-pstack.mjs` | Pass | pstack pinned version and skill links. |

<a id="真實中控程式的查詢"></a>
## Queries against real controller code

The controller is [SmartHomeAI](https://github.com/pcpcchen-coder/SmartHomeAI)'s `backend/app.py`, started with `WULING_POLL=0` and a temporary data directory, loading `assets/example-seed.json`. The example configuration has no readings, so an “示例空氣感測器” (“example air sensor”) was added to the living room with one **fixture reading**: temperature 26.5 °C, humidity 62%, no carbon-dioxide value, source labeled Tuya LAN. No real device measured this reading.

| Query | `homeStatusLine` subtitle |
| --- | --- |
| Living room plus temperature | Living room (example), example air sensor: temperature 26.5 °C (14:29) |
| Living-room temperature | Living room (example), example air sensor: temperature 26.5 °C (14:29) |
| Entire home | Living room (example), example light: unknown state; example dehumidifier: no humidity reading; living room (example), example air sensor: temperature 26.5 °C, humidity 62 %, no carbon-dioxide reading (14:29) |
| Example light | Example light: unknown state |
| Study | Study (example) has no devices |
| Garage | Cannot find “garage” at home |
| Living room plus co2 | Living room (example), example air sensor: no carbon-dioxide reading (14:29) |
| Incorrect token | Wuling Residence controller rejected the token (401). Reissue it in the controller's “系統接入” (“system integration”) page and update SMARTHOME_TOKEN. |

Missing values stay `null`; subtitles say “no reading.” The example light has no observations, so its state is “unknown,” not online or offline.

The table queries were made within one minute of inserting the reading. After review fixes, the query was repeated after more than 90 seconds. The controller had marked that same reading `stale` under its own 90-second freshness rule. The subtitle then said “temperature 26.5 °C (stale data 14:29)” instead of treating it as current.

<a id="審查修正"></a>
## Review fixes

Independent review found six issues. All were fixed with regression tests (`review regressions` in `tests/home-bridge.test.ts`).

1. When a sentence contained several room names, the first match was selected; “master-bedroom bathroom dehumidifier” selected the master-bedroom unit. Matching now chooses the longest room name and searches the entire home if the device is not found in that room.
2. Leading “中” and “內” were removed as filler, so “中庭” and “內室” could not be found. Only trailing “的、裡、裡面、內” are removed now, and the original string is matched first.
3. Old readings from days ago displayed only a time and could be described as today's data. A date is added for other days, and the model is instructed to use `minutes_ago` to state age.
4. An unknown reading name fell back to all readings in the room. It now returns `no_such_reading`.
5. Boolean controller readings, such as occupancy `true`, were treated as missing. They are retained and subtitles show yes/no.
6. Future controller status values could say “no reading” while listing a reading. If a reading exists, they are now labeled stale.

Controller requests also use `redirect: "error"`, so a redirect cannot forward the token elsewhere.

<a id="尚未驗證"></a>
## Not yet validated

- **Hardware voice:** no OpenAI API key, microphone, or speaker was available, so realtime `home_status` calls and the model's spoken rendering have not been tested physically. Tool calls were tested only through fake WebRTC data channels.
- **George's home controller and devices:** the LIFX or Tuya lights, infrared air conditioner, and temperature/humidity sensors in docs/12 §7 are not connected yet.
- **Scoped tokens:** the controller does not yet offer scopes such as `devices:read` (controller P0-1). This run used a controller master token. Real use should switch to a scoped token.
- **Display:** only a one-line subtitle exists. The large-number anchor display in docs/12 §3 is not implemented.

<a id="實機驗證步驟"></a>
## Hardware validation steps

1. With the controller running, create a Nous token in “系統接入” (“system integration”).
2. Set `OPENAI_API_KEY`, `SMARTHOME_URL`, and `SMARTHOME_TOKEN` in Nous's `.env`. Run `npm start` and check that the terminal says the Wuling Residence controller is configured and realtime voice is available.
3. Press “開始語音對話” (“start voice conversation”) and ask, in order: “客廳現在幾度” (“what is the living-room temperature?”), “全家的濕度” (“humidity throughout the home”), “車庫溫度” (“garage temperature”), and “把客廳燈關掉” (“turn off the living-room light”).
4. Expected: the first two answers use controller numbers and timestamps; the garage answer says it was not found; the light command says home-device control is not available yet. Record results here.
