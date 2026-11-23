<!-- bilingual: source=zh-TW -->

> [繁體中文](home-corner-2026-11-07.md) | [English](home-corner-2026-11-07.en.md)

# Home status corner HOME-1 and a larger date (2026-11-07)

> **Later change on 2026-11-07:** the corner no longer shows air conditioners and no longer reads their controller reports in the background; see the [follow-up record](day-night-badge-2026-11-07.en.md). The air-conditioner parts below describe the implementation at that time.

George's request on 2026-11-07: (1) make the date in the top-right clock larger, but still smaller than the time; (2) add a block in the top-left corner of the screen (above the brain) that shows the home's current switches, device use, indoor temperature and so on — "I want a smart-home feel".

## Scope and product red lines

- This is an **ambient status corner** of the same kind as the top-right clock ([CLK-1](pi-clock-weather-2026-11-07.en.md)): a passive read-out, not a Surface, Dashboard or App entry point. It has no buttons, cannot be tapped (`pointer-events: none`), cannot control anything and never takes focus. Its scope is fixed to indoor readings, light and plug counts, and the air conditioner; no other cards will be added.
- The container carries `data-visibility-reason="user_setting:home_corner"`: it appears only when the user turned the corner on in settings (one switch for the Mac window, one for the Pi terminal); when turned off it is removed from the page entirely.
- Read-only: the core only reads the Wuling home controller's snapshot. It sends no control commands and writes nothing to the controller. Air-conditioner controller reports use the controller's `POST …/status` (documented by the controller as a read: no body, no cooldown, not counted in the control rate limit).
- Honest: every number comes from what the controller reports. A switch the controller does not report shows "—", a sensor without a reading shows "—", never 0 or a guess; snapshots, stale data or readings older than 10 minutes show their age (on small screens too); readings from different sensors are never merged, each carries its own room and age; an unconfigured controller says 「智慧家庭未設定」 ("Smart home not set up"), and an unreachable one says 「讀不到中控」 ("Can't reach the home controller") with the reason, without keeping old numbers.

## Larger date (a CLK-1 adjustment)

| Item | Before | Now |
| --- | --- | --- |
| Date `.clock-date` | `clamp(.85rem, 1.6vh, 1.15rem)` (shared `--clock-date-size` with the weather text) | `clamp(1.15rem, 2.4vh, 1.9rem)` (its own size) |
| Time `.clock-time` | `clamp(2rem, 4.4vh, 3.6rem)` | Unchanged |
| Weather condition, second line | `--clock-date-size` | Unchanged |
| Small screens (width ≤ 900 or height ≤ 600) date | `0.8rem` (time `1.5rem`) | `0.95rem` (time unchanged) |

The date's minimum, height ratio and maximum are each smaller than the time's (1.15 < 2 rem, 2.4 < 4.4 vh, 1.9 < 3.6 rem), so the date is smaller than the time at every screen height. `tests/home-corner.test.ts` reads both `clamp` values from `src/style.css` and checks every 10 px from 300 to 3000 px tall; at 1080 px tall the date is 25.92 px and the time 47.52 px (headless Chromium measured the same values).

## Defaults

| Item | Default | Reason |
| --- | --- | --- |
| Mac window (main window and pages without `?terminal=`) | Off | Same as the top-right clock |
| Pi terminal (pages with `?terminal=`) | On | Same as the top-right clock (the clock is on by default on the Pi, and the request was to follow the clock). With no controller configured the Pi shows just one muted line, 「智慧家庭未設定」, which can be turned off in the menu bar or settings page |

Both switches are stored in the Mac core's `configDir/home-corner.json` (only changed keys; an unreadable file falls back to the defaults). The Pi page's settings screen shows both switches too.

## Data sources and shaping

`GET /api/home/overview` (no parameters; GET follows the existing local Host check) is built by the core's `HomeOverview` from the `HomeBridge` snapshot (`GET /api/v1/home` and `GET /api/v1/integrations/aifa`, the same reads as the voice home status tool):

| Part | How it is computed |
| --- | --- |
| Indoor readings | One device each for temperature, humidity, CO₂ and PM2.5: live first, then snapshot, stale, missing; within a level, the one the controller received most recently. Returns the value, unit, precision, room, status, age and `sensor` (a sensor number within this response, not a device id; readings from the same device share it). Age = the controller's `server_time` − when the controller received the reading, still increasing while cached; when the controller omits `server_time`, `parseHome` falls back to the Mac's time and the age is then affected by the clock difference between the two. A missing reading is `value: null` |
| Lights and plugs | Devices on the H1 control path: `kind` `light` counts as a light; `switch`, `plug`, `outlet`, `socket` count as plugs & switches (a Tuya air conditioner imported as `switch` does not count, nor do infrared appliances). **On/off comes only from the controller's `/home` `state.values.power` (boolean; the SmartHomeAI observation format, with the older `state.power` also accepted)**, and only when the device is online (`available: true`). The controller marks only readings under 90 s as `fresh`; older readings are still used, but the same line shows "oldest reading N min ago" from the controller's `state.age_seconds`, and a reading of unknown age counts as unknown. Up to 4 names of devices that are on |
| Air conditioner | AIFA air conditioners (up to 3): shows only the **controller report** (the settings the controller remembers, not the air conditioner's own state), and only when under 2 hours old; otherwise "—". Reports come from three places: `controller_status` returned when an air conditioner is controlled by voice, the status read before changing AC settings, and a background `POST …/status` from this corner. Background reads cover only the first 3 ACs the corner draws, and only those the AIFA list does not mark offline; one AC at a time; an AC read, voice-controlled or being read within the last 5 minutes is skipped; when a voice control needs a status read for an AC whose background read is in flight, it waits for that result instead of sending a second request; a failure leaves no new report |
| Cache | 30 s (both success and failure are cached, so a down controller is not hammered); only one snapshot request at a time; after any home control finishes, the next request re-reads, and a request that started before the control finished is not reused (it waits for it, then reads again); a result read after a control is cached for only 5 s. The page re-reads right away when a home control returns a result, and once more 8 s later (the controller may update on/off state slightly later) |
| Errors | Not configured → `{"configured": false}`; unreachable → `state: "unreachable"` with `error` (`timeout`, `unreachable`, `auth`, `bad_response`), without the controller's own text |
| Nothing leaks | The response has no device ids, token, controller address or raw response; device names are at most 24 characters; nothing is logged |

Response shape (the values are fixtures):

```json
{
  "configured": true,
  "state": "ok",
  "server_now": 1794053839043,
  "climate": [
    { "key": "temperature", "sensor": 0, "value": 25.8, "unit": "°C", "precision": 1, "room": "客廳", "status": "live", "age_s": 90 },
    { "key": "humidity", "sensor": 0, "value": 61, "unit": "%", "precision": 0, "room": "客廳", "status": "live", "age_s": 90 },
    { "key": "co2", "sensor": 1, "value": 812, "unit": "ppm", "precision": 0, "room": "書房", "status": "stale", "age_s": 10800 }
  ],
  "switches": [
    { "group": "light", "total": 6, "on": 3, "unknown": 1, "on_names": ["客廳主燈", "客廳立燈", "書桌燈"] },
    { "group": "switch", "total": 2, "on": 1, "unknown": 0, "on_names": ["延長線"] }
  ],
  "ac": [
    { "name": "客廳冷氣", "room": null, "power": true, "mode": "cool", "temperature": 26, "age_s": 60 }
  ]
}
```

## The corner

| Situation | Screen |
| --- | --- |
| Data | Thermometer icon with a large temperature, droplet icon with humidity (only readings from the temperature's sensor); a muted line such as "客廳 · CO₂ 640 ppm" (same sensor); readings from other sensors get one line per sensor with their own room and age, such as "書房 CO₂ 812 ppm · 3 h ago"; below a divider, one line per group: "Lights 3/6 on · 1 unknown" (names of the lights that are on underneath), "Plugs & switches 1/2 on", "客廳冷氣 On · 26° Cool" ("Controller report · 1 min ago" underneath) |
| All switches unknown | "Lights —/8" |
| A sensor has no reading | "—" |
| Snapshot, stale, or older than 10 minutes | Muted "N min ago" or "N h ago" (drawn on small screens too) |
| Back from the background with data on screen over 2 minutes old, re-read not finished | Numbers dimmed with an "Updating…" line on top, restored when the read lands |
| No AC report within 2 hours | "客廳冷氣 —" |
| Controller not configured | One muted line, 「智慧家庭未設定」 ("Smart home not set up") |
| Controller unreachable | 「讀不到中控」 ("Can't reach the home controller") plus a reason line (timeout, cannot connect, token rejected, error response); old numbers are not shown |
| The core does not answer (the page request fails or times out after 15 s) | "Can't reach the home controller" · "The core is not responding" |
| The controller has nothing to show | "No devices to show from the controller" |

- Style: a translucent dark card with 16 px rounded corners (gradient `rgba(14,26,48,.5)` → `rgba(6,11,22,.38)`, thin border `rgba(110,210,255,.14)`, `backdrop-filter: blur(10px)`); when "Display performance on this device" turns off background blur (`perf-no-blur`) it uses a solid dark backing instead. Icons are hand-drawn 24×24 SVGs (stroke 1.6, round caps, drawn like the weather icons): thermometer `--amber`, droplet `--cyan`; a light that is on glows yellow `#ffd75c`, plugs `--mint`, the AC `--cyan`, and grey when everything is off or unknown.
- Position: `top: calc(max(14px, 2vh) - 8px)`, `left: calc(max(16px, 1.6vw) - 12px)`, `z-index: 6` (above `.surface-root`'s 4, so it is hidden entirely while a Surface is open, see below); when the mock-mode or disconnected status line appears, the card moves below it (`top: 48px`). The centred memory notice and brain-region text subtract both the clock's and this corner's width (`--home-reserve`). On the Pi 4 page it is enlarged 1.5× like the clock (`transform-origin: top left`).
- Fades to 70% opacity while a conversation or the typing bar is open; hidden entirely while a Surface is open (`opacity: 0`, `visibility: hidden`), so it never covers a Surface (on a 1280-wide Pi at 1.5× the corner reaches a Surface's top-left); the backing darkens in memories mode.
- Small screens (width ≤ 900 or height ≤ 600): drops only rooms, device names and the other-sensor lines; reading ages, "Snapshot", "Stale data" and the AC's "Controller report · N min ago" are still drawn, so old data never looks live; "· 1 unknown" wraps as one piece instead of breaking inside words.
- Schedule: reads every 60 s while visible and pauses while the page is hidden; re-reads on returning to the foreground, focus or `pageshow`. A request waits at most 15 s and the next one is always scheduled; a re-read requested mid-flight runs right after; when a home control returns a result it re-reads right away and once more 8 s later. This lives in `src/home-feed.ts` (no DOM).
- Accessibility: the container has an `aria-label` (for example 「家中狀態：25.8°，濕度 61%，客廳 · CO₂ 640 ppm，燈 3／6 開著 · 1 個未知 · …」), no `aria-live`; icons are `aria-hidden`.
- The Pi page goes through the same Mac core API (over the tunnel) and never talks to the controller directly; the token stays in the Mac core.

## How to turn it on

- **Mac**: menu bar "Camera and voice settings" → "Home status corner" → check "Mac window"; or in the settings page, "Home status corner" → set "Mac window" to On.
- **Pi**: on by default. To turn it off, uncheck "Pi terminal" in the Mac menu bar, or press "Pi terminal" in the settings page on the Pi.
- The controller must first be configured in the Mac `.env` with `SMARTHOME_URL` and `SMARTHOME_TOKEN` (same as voice home control).

## What changed

| Part | Files (`prototype/ambient-shell/`) |
| --- | --- |
| Types, text, defaults and screen content (pure functions) | `shared/home-corner.ts` |
| Settings file `home-corner.json` | `server/home-corner-settings.ts` |
| Shaping and cache | `server/home-overview.ts` |
| Read-only snapshot entry point, `state.values.power`, error codes, recording and background reading of AC reports | `server/home-bridge.ts` |
| Routes `GET /api/home/overview`, `POST /api/settings/home-corner`, `settings.home_corner` | `server/app.ts`, `server/nous.ts`, `shared/types.ts` |
| Corner, schedule, icons | `src/home-corner.ts`, `src/home-feed.ts`, `src/home-icons.ts`, `src/main.ts`, `src/api.ts`, `src/style.css` |
| Settings page (browser and Mac App paths) | `src/views.ts` |
| Menu bar | `desktop/settings-menu.mjs`, `desktop/settings-menu.d.mts`, `desktop/main.mjs` |
| English | `shared/messages.en.json` |
| Date size | `src/style.css` |

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npx vitest run` (all) | 160 files passed; 2978 passed, 5 skipped (2983 total) |
| New tests in this batch | 44 in `tests/home-corner.test.ts` (including 11 added by the review fixes); 2 added to `tests/settings-view.test.ts` |
| Updated tests | `tests/wake-flag-off.test.ts`: `settings.home_corner` is listed as the sixth deliberate exception not tied to the flag; with it removed the rest is byte-identical and the snapshot is not updated |
| `npm run build` | Passed |

The tests cover: switches count only devices that are online and report `state.values.power` (or the older `state.power`); a reading that is not fresh needs `age_seconds` and shows the oldest age (offline, unreported or of unknown age count as unknown); Tuya air conditioners and infrared appliances are excluded; indoor readings prefer live, use a stale device only for a kind the live one lacks, and age by the controller clock plus cache time; a missing reading is `null`, not 0; AC reports are used only within 2 hours; at most 4 names and no ids in the response; no controller call when unconfigured; two concurrent requests read once, 30 s cache, re-read after a control and after expiry; error codes and their caching when unreachable; the snapshot uses only GET; AC reports are read one at a time, not again within 5 minutes, and a failure leaves no report; background reads cover only displayed, not-offline ACs and skip one voice-controlled in the last 5 minutes; a voice control's status read shares an in-flight background read for the same AC; a snapshot request started before a control is not reused and the post-control result is cached for only 5 s; the page re-reads 8 s after a control; "Updating…" when coming back with data over 2 minutes old; readings from different sensors each carry their own room and age (the study's CO₂ is never labelled as the living room); the small-screen CSS never hides reading ages or "Controller report"; with a Surface open the corner has `opacity: 0` and `visibility: hidden`; every screen state in Chinese and English; the schedule (60 s, re-read mid-flight, pause, timeout says unreachable and drops old numbers); the corner DOM (mounted only when enabled, `data-visibility-reason`, no buttons, removed with its CSS variable when off, both muted-line states); `home-corner.json` defaults, validation, saving and restart; menu bar text matches the page, checkboxes send the opposite value, English; switches on both settings paths; the date is smaller than the time at every height; and through the real core entry point (`startNous`) with a fake controller HTTP server: unconfigured, `settings.home_corner` per `X-Nous-Terminal`, saving and 400, POST is not an overview route, token and controller address never in the response, one controller read within 30 s, no device names in the log.

### Headless Chromium screen check (mock)

In the cloud container, Playwright's bundled Chromium opened the page after `vite build`, with the core using a **fake controller (a fixture HTTP server with invented devices and readings)** and fake Open-Meteo replies, in mock mode. Checked: Mac window 1920×1080 (Chinese and English), the Pi 4 page (`?terminal=rpi4`) at 1920×1080, 1280×720 and 1024×600, controller not configured, and controller unreachable (English). The measured corner box does not overlap the clock or the status line, nor the brain's nodes; at 1080 px tall the date is 25.92 px and the time 47.52 px.

After the review fixes, the same Chromium (the Playwright already installed in `/opt/node-tools`; nothing else installed) looked at the Pi 4 page again with a fake controller that has only a 3-hour-old stale temperature and CO₂ (study) and a live humidity from another sensor (living room). At 1024×600 the corner draws 「30.1°」, 「CO₂ 812 ppm · 3 小時前」, 「主臥冷氣 開 · 26° 冷氣」 and 「控制器回報 · 1 分鐘前」, dropping the room, the light names and the living-room humidity line; at 1280×720 it also draws 「書房 · CO₂ 812 ppm · 3 小時前」, 「客廳 濕度 61%」 and the light names. With `has-surface` added to the page, the corner's computed style is `opacity: 0`, `visibility: hidden`. Screenshots stay in the development environment and are not in the repo. This is not a validation on a Pi, Mac or real controller.

## Limits

- **On/off field (corrected 2026-11-07).** The first version read `state.power`, and George saw every light and plug show "—". After checking SmartHomeAI's `backend/adapters.py` (`observation()` puts readings in `values`) and `public()` in `backend/app.py`, it now reads `state.values.power`. For a multi-gang Tuya switch, `values.power` is the controller's first configured gang (`power_dps[0]`) and says nothing about the other gangs.
- The air conditioner shows only the controller report (settings the controller remembers), not whether the unit is really running; the screen labels it "Controller report". The background read goes through the controller to the AIFA cloud, only for the ACs on screen that are not offline (at most 3), at most once per 5 minutes per AC.
- Each reading shows one sensor (the live, most recent one), not a whole-home average; readings not from the temperature's sensor get their own line with their own room.
- When the controller omits `server_time`, reading ages are computed with the Mac's time and are affected by the clock difference between the two.
- Not validated on a Pi, Mac or real controller.

## Pi/Mac hardware steps (not done)

1. Update the Mac core (with this batch) and restart Nous; on the Pi: `systemctl --user restart aios-kiosk.service`.
2. The card appears in the Pi's top-left corner, and temperature/humidity match the same sensor in the controller's web page; the top-right date is larger than before and still smaller than the time.
3. Switch a light by voice: the light count in the corner follows within a minute (if it always shows "—", note the `state` fields in the controller's `/home` and report the on/off field name).
4. Turn the AC on by voice: the AC line shows "On" and "Controller report · N min ago".
5. Stop the controller: the card changes to "Can't reach the home controller" without old numbers; it returns within a minute after recovery.
6. Start a voice conversation: the card fades and does not cover subtitles; open a Surface: the card hides and returns after it closes; with the mock-mode status line shown, the card sits below it.
7. Check "Mac window" in the Mac menu bar: the corner appears in the Mac window; uncheck "Pi terminal": it disappears on the Pi.

## Rollback

- Turn off both "Home status corner" switches in the menu bar or settings page to hide it, no restart needed.
- To remove the code, revert this PR; HomeBridge only gains a read-only entry point and recording, and voice status and control behave as before.

## Not done

- Confirming the on/off field on the real controller; Pi and Mac hardware validation.
- Next gate: the hardware steps above.
