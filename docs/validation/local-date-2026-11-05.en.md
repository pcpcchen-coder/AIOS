<!-- bilingual: source=zh-TW -->

> [繁體中文](local-date-2026-11-05.md) | [English](local-date-2026-11-05.en.md)

# "Today's date" now uses the local time zone: validation

Date: 2026-11-05 (Asia/Taipei). Branch: `claude/local-date-fix` (based on main `80b5fb4`). George asked for this fix on 2026-11-05 and also confirmed that new Google Calendar events need no confirmation.

**Nothing here has run on a Mac.** These are fixed-time tests in a Linux cloud container.

## 1. The problem

The "today's date" given to the models used `toISOString().slice(0, 10)`, which is the UTC date. Between 00:00 and 08:00 Taiwan time it was the previous day, so the model was a day off when converting "tomorrow" or "next Wednesday"; this was most visible when reading the calendar or scheduling events.

## 2. The fix

New `server/local-date.ts`: "today" always uses the local system time zone. Nous's core runs on the Mac at home, so the system time zone is the user's time zone. The line in the instructions is now "今天日期：2026-11-05（星期四，Asia/Taipei）。" (today's date, weekday and time zone); the added weekday and time zone help the model convert "next Wednesday".

Changed places:

| Location | Purpose |
|---|---|
| `server/realtime.ts` | Instructions for API key realtime voice and ChatGPT plan realtime voice |
| `server/live-tool-caller.ts` | Instructions for the ChatGPT plan route's tool runner |
| `server/chat.ts` | System instructions for ordinary text chat |
| `server/prompts.ts` | Default date for background task planning and each step (date only, same format) |

`tests/apikey-route.test.ts` has a test that "without memory, the request equals the 658b97a snapshot byte for byte"; before comparing it replaces the date line with `<DATE>`. Only its normalization rule was updated to recognize the new date format; the snapshot itself is unchanged and everything else is still byte-identical.

## 3. Tests

New test file `tests/local-date.test.ts`, 4 tests:

- 2026-11-04T17:00Z (1 a.m. on 11-05 in Taipei): the old code said 11-04; the new code says 2026-11-05 (Thursday).
- A year boundary (Taipei 2027-01-01), a zone behind UTC (Los Angeles is still Saturday 11-07), and UTC itself.
- The system time zone is a valid IANA name.
- The instructions for both realtime routes (Chinese and English), the ChatGPT plan route and ordinary text chat all contain the same local date line, exactly once each; background task planning and steps use the local date.

Commands and results (2026-11-05, Linux cloud, Node.js 22):

- `npm run typecheck`: pass.
- `npx vitest run`: 137 files, 2,498 passed and 5 skipped.
- `node scripts/verify-aios.mjs`: PASS; `git diff --check`: pass.

## 4. No confirmation for Google Calendar events

George confirmed on 2026-11-05 that new events show no confirmation card (`reversible_write`; only on your own calendar, no invitees, can be deleted). The code already behaved this way; this change only records the decision in a code comment and in the [CAL-1 validation](cal-1-google-calendar-2026-11-05.en.md).

## 5. Check on the Mac (not yet run)

Between 00:00 and 08:00 Taiwan time, start a realtime voice call and ask "what is today's date and weekday" and "what's on my calendar tomorrow"; the dates should be Taiwan's today and tomorrow.
