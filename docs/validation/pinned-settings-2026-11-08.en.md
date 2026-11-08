<!-- bilingual: source=zh-TW -->

> [繁體中文](pinned-settings-2026-11-08.md) | [English](pinned-settings-2026-11-08.en.md)

# Settings pinned on top, text 1.5× larger (2026-11-08)

George reported on 2026-11-08 that the settings opened from the bottom-right gear sometimes closed by themselves, as if the brain wanted to come back. He asked:

1. that settings stay on top and close only when he clicks "收起" (Close);
2. that the settings text be 1.5 times larger.

## Why settings closed by themselves

Reading the code found several sources that close any view. On the Pi the likely ones are:

- **The camera decides the person has left**: after 60 seconds without seeing anyone, presence closes the view and ends realtime voice.
- **A wake word or starting realtime voice**: views are closed before a call starts.
- Others: Esc, saying 「收起」, sending a typed chat, or another view (progress, results) appearing.

Which one fired on the Pi has not been confirmed; the change below blocks all of them.

## What was done

- **Pinning**: a new pure function, `keepPinnedSettings` in `src/shell-state.ts`. After the user opens settings, other events still update tasks, listening and voice state, but the view returns to the same settings card (same `surface_id`, no redraw).
- **How to close**: only the "收起" button at the bottom of settings or the bottom-right gear unpin it (`closeSettings`, the only place in main.ts that clears the pin). Esc, saying 「收起」, the person leaving, a wake word or starting voice do not close it.
- **Confirmation cards are the exception**: a confirmation card for an external action (for example a home command that needs confirmation) may cover settings for a while; when it ends, settings come back. Blocking it too would let it time out and count as rejected.
- **Text 1.5× larger**: the settings view uses `zoom: 1.5`, so text, buttons and spacing grow together. The frame widens to the screen (up to 1200 px), and the height limit is divided by 1.5 so the enlarged view still fits and scrolls. Only settings change; other views are unchanged.

## Tests

- `tests/pinned-settings.test.ts` (6 tests):
  - a dismiss keeps the same settings card;
  - progress does not replace settings while task state still updates;
  - a confirmation card may cover settings, which come back afterwards;
  - without the pin, behavior is as before;
  - in main.ts only `closeSettings` clears the pin;
  - the CSS for 1.5× and the height limit.
- **Headless Chromium (mock core, Pi page at 1920×1080 and 1024×600):**
  - the gear opens settings; the heading is 20 px × zoom 1.5;
  - the frame is 1200×780 at 1920×1080 and 983×425 at 1024×600, both on screen;
  - Esc does not close it, and neither does clicking the lower part of the screen;
  - "收起" closes it; the gear opens it again and closes it again;
  - no JS errors on the page.
- `npm run typecheck`, `npx vitest run` (165 files, 3051 passed, 5 skipped), `npm run build` and `node scripts/verify-aios.mjs` all pass.

## Known limits

- On small screens such as 1024×600 the enlarged settings show less at a time and need scrolling.
- The bottom-right gear covers a small corner of the settings card; scrolling brings any covered button into reach.
- Not confirmed on a real Pi.
