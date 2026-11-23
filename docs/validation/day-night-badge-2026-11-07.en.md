<!-- bilingual: source=zh-TW -->

> [繁體中文](day-night-badge-2026-11-07.md) | [English](day-night-badge-2026-11-07.en.md)

# Brightness thresholds calibrated, day/night badge, no air conditioner in the top-left corner (2026-11-07)

On 2026-11-07 George measured the camera brightness on the Pi: about **130** with the lights on and about **80** with them off. He also asked:

1. to add a day mode / night mode icon in the top-right block;
2. to stop showing air conditioners in the top-left home status.

## 1. Brightness thresholds (VOL-2 calibration)

- The estimated thresholds were "below 40 is dark, above 55 is bright". With George's measurements, 80 with the lights off would never count as dark, because the camera adjusts exposure automatically and the picture does not get very dark.
- They are now **below 95 is dark, above 115 is bright**: each is 15 away from a measured value, and the 20 in between is a hysteresis band where the current judgement is kept.
- The rules are unchanged:
  - night hours always use the night volume;
  - during the day, it must stay dark for 1 minute before the night volume is used;
  - after the lights come on, it must stay bright for 1 minute before the day volume returns.
- This is one set of measurements (one Pi, one room); daylight and overcast readings have not been measured.

## 2. Day/night badge in the top-right corner

- The clock corner has a new line below the date and above the weather: a sun with 「日間模式」 or a moon with 「夜間模式」 ("Day mode"/"Night mode" in English). The icons reuse the clear-day and clear-night weather SVGs.
- It shows **which voice volume is in use now** (the VOL-2 decision), not the weather or sunrise/sunset.
- Hovering shows the reason: "Using the day volume now", "Using the night volume now: within night hours (22:00–07:00)" or "Using the night volume now: the camera sees a dark room".
- It is recalculated every minute from the hours, and updates at once when the camera reading changes. The text follows the interface language.
- With the clock corner turned off, the line is not visible, but the voice volume still switches.

## 3. No air conditioner in the top-left corner

- `GET /api/home/overview` no longer returns air conditioners (the `ac` field is removed); the corner shows only indoor readings, lights and plugs.
- **The core no longer reads air-conditioner controller reports in the background.** Before, each AC got a `POST …/status` at most every 5 minutes; now there are none.
- Voice control of air conditioners is unchanged: read the settings once before control, send, and report the real result. HomeBridge loses only the background read and the report cache that existed for the corner.
- The settings page and menu bar notes now say "Show indoor temperature and humidity and the lights and plugs that are on".

## Tests

- `tests/day-night-volume.test.ts` gains a test with George's values: 130 with the lights on is bright, 80 with them off is dark after a minute, and an in-between 105 does not flip it.
- `tests/home-corner.test.ts`:
  - the overview has only `climate` and `switches`, with no air conditioner in it;
  - reading the corner sends no `/status` to the hub, only GETs;
  - the Chinese and English corner expectations drop the AC lines;
  - three old background-read tests are removed.
- **Headless Chromium (mock core, Pi page):**
  - 1920×1080 in the daytime: 「☀ 日間模式」 appears below the date, with the title "Using the day volume now".
  - 1024×600 with night hours set to 00:00–23:00: 「🌙 夜間模式」 appears, with the title "Using the night volume now: within night hours (00:00–23:00)".
  - No JS errors on the page.
- `npm run typecheck`, `npx vitest run` (163 files, 3015 passed, 5 skipped), `npm run build` and `node scripts/verify-aios.mjs` all pass.

## Not yet verified

- The new thresholds have not been confirmed on the Pi:
  - after the lights are off for a minute, the top-right shows "Night mode" and Nous speaks more quietly;
  - a minute after the lights come back on, it returns to "Day mode".
- Daylight readings have not been measured.
