<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-clock-weather-2026-11-07.md) | [English](pi-clock-weather-2026-11-07.en.md)

# Clock & weather corner CLK-1 (2026-11-07)

George's request (2026-11-07): the top-right corner of the Raspberry Pi screen shows the time, date, weekday, temperature and weather, well designed and with icons.

## Scope and product red lines

- This is an **ambient status corner** (a passive read-out like the status line at the top left and the camera indicator at the bottom right), not a Surface, Dashboard or App entry point: no buttons, it cannot be tapped (`pointer-events: none`), it takes no focus, and its scope is fixed to time, date, weekday and weather. No further information cards will be added to it.
- The container carries `data-visibility-reason="user_setting:clock_corner"`: it appears only when the user has switched the corner on in settings (one switch for the Mac window, one for the Pi terminal).
- Honesty: weather comes only from the core's `GET /api/weather/now` (Open-Meteo, CC BY 4.0). When it cannot be retrieved the corner says 「天氣暫時無法取得」 ("Weather is unavailable right now"); without a place it says 「設定天氣地點後顯示天氣」 ("Choose a weather place to show the weather"). It never draws guessed weather. Without a current temperature it shows only today's low/high and labels the condition 「今日」 ("Today"), never as the weather now.

## Defaults decided by George (2026-11-07)

| Item | Default |
| --- | --- |
| Mac window (main window, and browser pages without `?terminal=`) | Off |
| Pi terminal (pages with `?terminal=`) | On |
| While memories mode shows photos | The clock stays above the photos (z-index 6 > photos 5) on a dark backing `rgba(3,5,11,.55)` with a 14px radius |

Both switches live in the same `clock.json` on the Mac core. The Pi page's settings page also shows both switches, so the Mac window's clock can be switched off from the Pi too; a page opened in a plain browser on the Mac (without `?terminal=`) counts as the "Mac window".

## What was done

| Part | Content | Files (`prototype/ambient-shell/`) |
| --- | --- | --- |
| Weather data | The Open-Meteo request also asks for `current=temperature_2m,weather_code,is_day` (extra fields only; host and place unchanged). `parseCurrent` checks that the time is today, the temperature is within −60 to 60 and `is_day` is 0/1, otherwise `now: null`. The spoken greeting sentence is unchanged | `server/weather.ts`, `shared/proactive.ts` |
| Read-only API | `GET /api/weather/now`, no parameters: the place is the "Proactive briefing" weather place (chosen, or inferred from the system time zone), sharing the 30-minute cache with the greeting. The response has `time_zone`, `server_now`, `place` (name per `X-Nous-Locale`), `state` (ok/failed/none/no_place), `weather` and `attribution`. It does not depend on the "Say today's weather" switch | `weatherNowView` in `server/weather.ts`, `server/app.ts`, `server/nous.ts` |
| Settings | `configDir/clock.json` (`{main, terminal}`, only changed keys are stored); `settings.clock` gives `enabled` per page source; `POST /api/settings/clock` validates each key (400) | `server/clock-settings.ts`, `shared/clock.ts` |
| Menu bar and settings page | A "Clock & weather corner" section with two checkboxes, "Mac window" and "Pi terminal"; the settings page (Mac App and Pi/browser) has the same two switches and the data attribution | `desktop/settings-menu.mjs`, `desktop/main.mjs`, `src/views.ts` |
| Corner | 24-hour HH:mm time, date (Chinese 「11月7日 週六」, English "Sat, Nov 7"), weather row (icon + temperature + condition), second line "Taipei · 18°–26° · Rain 20%" | `src/clock-corner.ts`, `src/clock-feed.ts`, `src/style.css`, `src/main.ts`, `src/api.ts` |
| Icons | Hand-drawn 24×24 SVG, 1.6 stroke, round caps; 12 kinds (clear, mostly clear, partly cloudy, overcast, fog, drizzle, freezing rain, rain, heavy rain, showers, snow, thunderstorm); clear/mostly clear/partly cloudy/showers have a night version (moon). Where a cloud covers the sun, a mask cuts the sun away. Colours: sun `--amber`, moon `#c9d6ff`, cloud `#b8c7d9`, rain `--cyan`, snow `--text`, lightning `#ffd75c`, fog `--muted` | `src/weather-icons.ts` |
| Text | Both languages use the shared catalog `shared/messages.en.json`; Chinese and English condition names are in the WMO table in `shared/clock.ts` | `shared/clock.ts` |

### Time and time zone

- Time is always formatted in the time zone the core gives (the place's time zone; without a place, the Mac core's system time zone), **never the Pi's own time zone**.
- The core's time is anchored to the page's monotonic clock (`performance.now()`) at the midpoint of the request round trip: now = core time + monotonic time elapsed since. When the Pi wall clock is more than 60 s off it, the core time is used; within 60 s the wall clock is used (no network jitter). The comparison is redone on every redraw, so a later clock change on the Pi (a fake-hwclock → NTP jump) switches back to the wall clock at once and the offset is never applied twice. When the wall clock and the monotonic clock drift apart by more than 30 s between two redraws (sleep, time sync), the page re-syncs with the core at once.
- It rewrites only once a minute, aligned to the next whole minute (+50 ms), with no per-second timer, and writes only when the text changes. On becoming visible, gaining focus or `pageshow` it redraws and rereads at once, so stale time is not shown after sleep.
- Weather is read every 15 minutes (the core also caches for 30 minutes) and paused while the page is hidden. Each request waits at most 10 s (then it is aborted, and released even if the request ignores the abort) and the next read is always scheduled; a reload requested while a request is in flight (for example a language change, since the place name follows the language) runs right after it finishes.
- Until the core has answered once (time zone unknown), or after a failed request, there is no new data and it retries every 60 s.
- This scheduling and calculation is in `src/clock-feed.ts` (no DOM; tested in node with fake timers); `src/clock-corner.ts` only draws and handles events.

### Weather states

| Situation | Display |
| --- | --- |
| Current data | Icon + current temperature + condition; second line place, today's range, rain chance. "Current" comes from the core's 30-minute cache, so around sunrise and sunset the day/night icon (`is_day`) may switch up to about 30 minutes late |
| Data older than 45 minutes | An extra muted line "N min ago" |
| Reply without a current temperature | Today's "18°–26°" + the day icon; condition labelled "Today: clear" |
| Lookup failed or the core is unreachable | The page keeps its previous value with "N min ago", for at most 2 hours and the same day; after that only the muted "Weather is unavailable right now" |
| After midnight | Yesterday's range and the "Today" label disappear at once, whether the data came from the core or the page (the core's data must also be today's and under 2 hours old), and the page rereads at once |
| Open-Meteo keeps failing | After a failure the core does not query the same place again for 2 minutes (for the clock corner, the greeting and the tool alike) and returns any still-usable cached data or "not available" |
| No place | Muted "Choose a weather place to show the weather" |
| Unknown weather code | Temperature only, no icon or condition text |

### Layout

- Position: the text's top and right edges sit at `max(14px, 2vh)` and `max(16px, 1.6vw)` (the container itself is `top: calc(max(14px, 2vh) - 8px)`, `right: calc(max(16px, 1.6vw) - 12px)` with 8px/12px padding, so the memories-mode dark backing does not move the text), `z-index: 6`, right-aligned, tabular numerals, fixed minimum width.
- Sizes: time `clamp(2rem, 4.4vh, 3.6rem)`, weight 300; date `clamp(.85rem, 1.6vh, 1.15rem)`; icon `clamp(28px, 4.2vh, 46px)`; temperature `clamp(1.25rem, 2.6vh, 1.9rem)`; second line 0.9× the date size. Text shadow `0 1px 12px rgba(0,0,0,.6)`; no backdrop-filter (Pi performance).
- The voice status pill used to sit in the top-right corner too (`top: 14px`); with the clock it moves below the clock and aligns with the clock's right edge. The centred memory notice and brain-region activity text narrow by the clock's width (`--clock-reserve`, recomputed when the clock or the window width changes).
- During a conversation, a Surface or the typing bar the clock drops to 70% opacity.
- Small screens (width ≤ 900 or height ≤ 600): time and date on one line, weather reduced to icon and temperature, width ≤ 180px.
- Accessibility: the container has an `aria-label` (for example "Time, date, and weather: 09:05, Sat, Nov 7, 24°, Partly cloudy, Taipei · 18°–26° · Rain 20%") and no `aria-live` (minute changes are not announced); icons are `aria-hidden`. Under reduced motion the 300 ms weather fade is removed.

## Deviations from the plan

- `index.html` is unchanged: the corner is created dynamically in `src/clock-corner.ts` (like memories mode's `#memories`) and removed entirely when the setting is off.
- The rain text is 「降雨 20%」 / "Rain 20%" (the plan said 「雨 20%」) so it is not confused with the condition 「雨」 (rain).
- The second line starts with the place name (the API already provides it) so it is clear where the weather is for.
- Without a current temperature the condition gets 「今日」 / "Today:" (for example 「今日晴」 / "Today: clear") to make clear it is not the weather now.
- The voice pill sits 8px below the clock (measured from the clock's bottom edge) and aligns with the clock's right edge.

## Validation

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npx vitest run` (all) | 158 files passed; 2882 passed, 5 skipped (2887 total) |
| New tests in this batch | `tests/clock-format.test.ts`, `tests/weather-icons.test.ts`, `tests/weather-now-http.test.ts`, `tests/clock-settings.test.ts`, `tests/clock-feed.test.ts`: 38 tests |
| Updated tests | `tests/proactive.test.ts` (the request URL now has `current`, `parseForecast` has `now`); `tests/wake-flag-off.test.ts` (`settings.clock` is listed as the fifth deliberate exception not tied to a flag; with it removed the rest is byte-identical and the snapshot is not updated) |
| `npm run build` | Pass |

The tests cover fixed instants in the Taipei time zone (Chinese and English), date rollover at Taipei midnight vs UTC midnight, the wait until the next whole minute, clock skew (60 s threshold, monotonic anchor, no double correction after a later Pi time sync), no use of yesterday's data after midnight (core or page), every weather-row state, rounding and never showing −0°; icons for all 28 WMO codes, day/night, no icon for unknown codes; an invalid or other-day `current` block is dropped while today's daily values are kept; `weatherNowView` (ok, no current block, failure with a cache under 2 hours, failure without a cache, no place, name per language, no refetch within 30 minutes); HTTP through the real core entry (`startNous`): read-only GET, query parameters cannot choose a place or URL, POST is not a route, `settings.clock` gives `enabled` per `X-Nous-Terminal`, POST validation and English errors; `ClockFeed` (a hung request is released after 10 s and the next read is still scheduled, a language change during a request rereads after it, midnight rereads at once, a wall-clock jump re-syncs, pause and resume); the 2-minute cooldown after an Open-Meteo failure; `clock.json` defaults, saving, restart and a bad key; menu text matching the page, checkboxes sending the opposite value, and English translations.

### Screen check in headless Chromium (mock)

In the cloud container, Playwright's bundled Chromium opened the Pi page built by `vite build` (`/?terminal=pi`). The core used a **fake Open-Meteo reply (fixture, no network)**, place Taipei, in mock mode (no AI model called). Checked: 1920×1080 and 1280×720, Chinese and English, memories mode showing a photo (a bright test image), rain at night, no current temperature, a failed lookup, a thunderstorm on an 800×480 small screen, reduced opacity with the typing bar open, and the voice pill below the clock. Screenshots stayed in the development environment and are not in the repository. This is not a validation on a real Pi or with real weather.

## Steps on the real Pi (not done)

1. Update the core on the Mac (with this batch) and restart Nous.
2. Pi: `systemctl --user restart aios-kiosk.service`.
3. At 1920×1080 confirm: the time matches the Mac; the date and weekday are right; the weather matches [Open-Meteo](https://open-meteo.com/) for the same place; switch English / 繁體中文.
4. The clock stays readable while memories mode plays.
5. Start a voice conversation; the voice pill is below the clock without overlap.
6. Disconnect the Mac from the network for more than 2 hours (or use a fake clock): first "N min ago", then only "Weather is unavailable right now".
7. Untick "Pi terminal" in the menu bar; the clock disappears on the Pi.
8. Optional: 1280×720.
9. If the Pi and Mac times differ a lot: on the Mac, check that System Settings → General → Date & Time sets the time automatically; on the Pi run `timedatectl status` to confirm NTP is synchronised. When the page is more than 60 s off, it uses the Mac core's time.

## Rollback

- Untick "Pi terminal" under "Clock & weather corner" in the menu bar (or switch it off on the settings page) to hide it; no restart is needed.
- To remove the code, revert this PR; the extra `current` field in the Open-Meteo request is additive and the greeting's weather sentence is unaffected.

## Not done

- Not verified on a real Pi or Mac; real Open-Meteo replies not verified (fixture only).
- The page's corner component has no DOM unit test (the test environment has no DOM); it is covered by pure-function tests and the mock screen check in headless Chromium.
- Next gate: the real-Pi steps above.
