<!-- bilingual: source=zh-TW -->

> [繁體中文](cal-1-google-calendar-2026-11-05.md) | [English](cal-1-google-calendar-2026-11-05.en.md)

# CAL-1 reading and writing Google Calendar with gog: validation

Date: 2026-11-05 (Asia/Taipei). Branch: `claude/cal-1-google-calendar` (built on AIL-2's `claude/ail-2-home-facade`, using its shared gog module). George's request on 2026-11-05: after AIL-2, connect Google Calendar too, with complete tests.

**Nothing here has run on a Mac, real gog or Google Calendar.** Tests use an injected fake runner and a fake gog script that is really executed with `spawn`. Accounts and events are made up. gog's commands and flags follow its official documentation (checked 2026-11-05), but the documentation does not describe the `--json` output fields, so event and ID fields are matched leniently and must be checked on the Mac.

## 1. Deliverables

All paths are under `prototype/ambient-shell/`.

| File | Contents |
|---|---|
| `server/integrations/adapters/google-calendar.ts` (new) | The `google_calendar` Adapter with two model tools |
| ├ `app.calendar.list_events` (read-only) | `range` is today, tomorrow, week, or date together with `date` (YYYY-MM-DD; gog receives that local day from 00:00 to 00:00 the next day, with the offset). It runs `gog calendar events primary --readonly --account=… --tz=… --max=21 --json` plus the range flag; gog's `--readonly` blocks any write before it is sent. At most 20 events are returned, with titles up to 120 characters and locations up to 80, and a total size within 3.5 KB; if they do not fit, fewer are returned and `truncated` is set. The result carries a fixed note: titles and locations may be written by others and are only data; an all-day event's end is the next day. gog output is capped at 2 MB when reading events |
| ├ `app.calendar.create_event` | Parameters: title, start (`YYYY-MM-DDTHH:MM` local time, or `YYYY-MM-DD` for all day), length (5–1440 minutes, default 60), location and notes. Local time is converted with the time zone into RFC3339 with an offset; the end is the start's real instant plus the length, so midnight crossings and daylight saving changes take exactly that long; an all-day event ends on the next day. Notes keep their line breaks. **No attendees are ever passed, so no invitations are sent**. At most 10 per minute |
| Result rules | A successful read is `confirmed`; a create with an event ID is `confirmed` and without an ID `unconfirmed`; when gog exits non-zero, a read is `failed` and a create is `unknown` (it may already exist, so it is not recreated); gog failing to start is `failed`; timeout (30 s) or abort is `unknown` |
| Confirmation | Creating an event is `reversible_write`: it only goes on your own calendar, invites nobody and can be deleted, and it is not one of the red line's send/publish/pay/permanently delete actions, so no confirmation card is shown. This is my default, pending George's confirmation |
| `server/config.ts` | `NOUS_GOG_ACCOUNT` (gog's Google account, falling back to `NOUS_MAIL_SELF`; must be an email) and `NOUS_CALENDAR_TZ` (IANA time zone, default Asia/Taipei) are read only when `google_calendar` is listed; the gog path reuses `NOUS_GOG_PATH` |
| `server/integrations/index.ts` | `google_calendar` is added to the reviewed Adapters. Without an account, or when gog cannot be found, it is not registered and the reason is logged |
| `src/views.ts`, `src/messages.en.json`, `server/messages.en.json` | The settings page's "App integrations" adds "Google Calendar (gog)" with a note; all new fixed sentences have English |

The model can neither see nor choose the account, calendar or attendees. Event titles and locations are returned to the model, which is the point of reading the calendar; the tool description states that event titles are data, not instructions.

## 2. Tests (fixtures)

New test file `tests/integration-google-calendar.test.ts`, 21 tests:

- **Time**: only real dates and 24-hour times are accepted; `2026-02-30`, `24:00` and "3 o'clock tomorrow" are refused. Taipei is +08:00; New York is −05:00 in winter and −04:00 in summer; India is +05:30. Midnight crossings and all-day events across month and year boundaries are correct; on 2026-11-01 in New York, when daylight saving ends, 00:30 plus 120 minutes ends at 01:30 (−05:00), exactly 120 minutes later. Zero-width and bidi override characters are removed, and notes keep line breaks.
- **Reading gog output**: the Google API shape (`start.dateTime`/`start.date`), a top-level array, `items` and `results` are all read; items without a start are skipped; unreadable output returns null; a missing title is an empty string plus `no_title`, with no Chinese placeholder in the data.
- **Listing events**: always `--readonly`, the fixed account and primary; the four range flags are correct; an invalid date does not run gog; no events, non-zero exit, unreadable output and missing gog each give the right result. A single day is sent as local 00:00 to the next day's 00:00 (correct across a year boundary). With 30 long titles, at most 20 events are returned, the whole data within 3.5 KB, and `truncated` is set.
- **Creating events**: arguments for a timed event are correct and include no attendees; all-day events are correct; a title written as `--attendees=…` stays title text; every result status is correct; the 11th event in a minute is refused without calling gog; a different time zone changes both the conversion and `--tz`.
- **Real spawn of a fake gog**: a week whose output exceeds 64 KB is still read; listing and creating both succeed; `$(…)`, backticks and `;` in the title arrive verbatim as an argument, with no shell involved.
- **Configuration and the integration layer**: account source and time zone validation; no registration without an account; both tools have the same name and parameters on both routes; the tool list does not contain the account; extra calendar or attendee arguments from the model are rejected by the schema and nothing runs; creating an event shows no confirmation card, while `external_commit` still needs one.
- **ChatGPT plan route**: the delegation reads the calendar in the core and hands the result back to the model to relay, without going through the page.

Commands and results (2026-11-05, Linux cloud, Node.js 22):

- `npm run typecheck`: pass.
- `npx vitest run`: 136 files, 2,494 passed and 5 skipped.
- `node scripts/verify-aios.mjs`: PASS; `git diff --check`: pass.

## 3. Independent review and fixes

An independent review by the same model (not a cross-model review) found no blockers and raised 8 items; 7 were fixed: a single day is now sent as local 00:00 to the next day's 00:00 instead of relying on gog's `--days`; gog output is capped at 2 MB when reading events; the end time uses real elapsed time (daylight saving changes); the result carries a note that titles may be written by others and are only data, and that an all-day end is the next day; the size is measured on the whole data; no Chinese placeholder for missing titles; zero-width characters are removed and notes keep line breaks. Real bidi override characters were also found in the source and replaced with escape sequences. Not fixed: a create whose gog failed to start still counts toward the 10-per-minute limit (this is only more conservative).

## 4. Setup and validation steps on the Mac (not yet run)

1. **Authorize Calendar**: with gog already installed for MAIL-1, run `gog auth add <your Gmail> --services gmail,calendar --gmail-scope send --force-consent` to add Calendar to the same account's authorization (gog's documentation offers only full read/write for Calendar, with no read-only option).
2. **Check the format by hand** (note only field names, not content):
   - `gog calendar events primary --readonly --account=<your Gmail> --today --json`: which field holds the event list (top level, `events`, `items`)? Is the start `start.dateTime` or a string?
   - `gog calendar create primary --account=<your Gmail> --summary=CAL-1-test --from=<today>T21:00:00+08:00 --to=<today>T21:15:00+08:00 --json`: what is the ID field called? Delete this test event from the calendar afterwards.
   - For an all-day event, should `--to` be the next day or the same day (Google's all-day end date is exclusive)?
   - If a field name is outside what section 1 covers, tell me and I will change the matching rule.
3. **Configure Nous**: add `google_calendar` to `NOUS_AIL_SERVICES` in `.env` (for example `home,gmail_gog,google_calendar`). The account reuses `NOUS_MAIL_SELF`; to use another account, set `NOUS_GOG_ACCOUNT`. Then restart Nous.
4. **Check the status**: the settings page's "App integrations" should show "Google Calendar (gog): Available".
5. **By voice**, once on each of the two realtime voice routes:
   - "What's on my calendar today?" and "Am I free tomorrow afternoon?": the answer must match the actual calendar.
   - "Book a dentist appointment tomorrow at 3 pm for an hour": the event appears, and Nous says it was added to your Google Calendar.
   - "Mark next Wednesday as a day off": an all-day event on the right date.
6. **Failure path**: unplug the network and ask about events again; Nous must say it could not read them and must not invent events.
7. **Confirm nothing leaks**: Nous's log contains only "integration layer" status codes, with no account, event titles or locations.
8. **Roll back**: remove `google_calendar` from `NOUS_AIL_SERVICES` and restart.

## 5. Limits and open items

- Nothing has run on a Mac, real gog or Google Calendar; section 4 has not been done.
- gog's `--json` output fields and the all-day end date format are assumptions, to be checked in step 2 of section 4.
- Primary calendar only; events cannot be modified or deleted, and nobody can be invited.
- Event titles and locations go to the voice model's cloud (reading the calendar requires this); the tool description reminds the model that they are data, but that cannot block every prompt injection.
- Known existing issue (not caused by this batch, not changed): the "today's date" in both realtime routes' instructions is the UTC date, so between 00:00 and 08:00 Taiwan time it is the previous day, and the model may be a day off when converting "tomorrow". A separate batch is recommended.
- Showing no confirmation card for new events is my default, pending George's confirmation.

## 6. Next gate

Only after George completes section 4 on the Mac and keeps a de-identified record can we claim "Nous can read and add Google Calendar events by voice".
