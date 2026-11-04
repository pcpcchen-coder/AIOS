<!-- bilingual: source=zh-TW -->

> [繁體中文](mail-1-gog-self-2026-11-04.md) | [English](mail-1-gog-self-2026-11-04.en.md)

# MAIL-1 email to myself with gog: validation

Date: 2026-11-04 (Asia/Taipei). Branch: `claude/mail-1-gog-self` (based on main `8eb53b2`). It builds on the [18 App Integration Layer](../18_App_Integration_Layer_and_Spotify_2026-11.en.md).

**George's decisions (2026-11-04)**: send Gmail with [gog](https://github.com/steipete/gogcli) (MIT); the recipient and the sender are both George; **sending to himself never needs confirmation, it just sends**. The product red line requires per-send confirmation for "send" actions by default. This is an exception George explicitly chose, it applies only to the single tool `app.mail.send_to_self`, and it is recorded in `CONFIRMATION_EXEMPT_TOOLS` in `server/integrations/policy.ts`. Every other tool that sends, publishes or pays still needs confirmation.

**Nothing here has run on a Mac, real gog or Gmail.** The cloud has no gog, so tests use an injected fake runner and a fake gog script (a real `spawn`, no shell). All addresses are made up. The official README does not document the output fields of `gog gmail send --json` (checked 2026-11-04), so the message ID field names are matched leniently and must be confirmed on the Mac.

## 1. Deliverables

All paths are under `prototype/ambient-shell/`.

| File | Contents |
|---|---|
| `server/integrations/adapters/gmail-gog.ts` (new) | The `gmail_gog` Adapter with one model tool, `app.mail.send_to_self`, whose only parameters are `subject` and `body`, with no recipient. It runs `gog gmail send --account=<self> --to=<self> --subject=<subject> --body-file=- --json` with a `spawn` argument array and no shell; every flag is written as `--flag=value`; the body goes through stdin and never appears in the process arguments; stderr is neither read nor logged; control characters such as newlines are removed from the subject to prevent header injection. Results: `confirmed` only when the exit code is 0 and a message ID is found; exit code 0 without an ID is `unconfirmed`; a non-zero exit is `unknown` (gog may fail after Gmail has accepted the message, so Nous must not say it was not sent, and a resend is avoided); gog failing to start is `failed`; timeout (30 s) or abort becomes `unknown` through the Dispatcher, with SIGTERM first and SIGKILL if the child is still running after 2 s. Because there is no confirmation card, at most 5 emails per minute are allowed. The health check runs `gog --version` |
| `server/integrations/policy.ts`, `dispatcher.ts` | `CONFIRMATION_EXEMPT_TOOLS`: each entry states who, when and why; `decide` lets through only the tool IDs on that list |
| `server/integrations/index.ts` | `gmail_gog` is added to the reviewed Adapters. Without `NOUS_MAIL_SELF`, or when gog cannot be found, it is not registered and the reason is logged |
| `server/config.ts` | `NOUS_MAIL_SELF` (must be an email) and `NOUS_GOG_PATH` (must be absolute, optional; when omitted, `/opt/homebrew/bin/gog` and `/usr/local/bin/gog` are tried) are read only when `NOUS_AIL_SERVICES` lists `gmail_gog` |
| `src/views.ts`, `src/messages.en.json`, `server/messages.en.json` | The settings page's "App integrations" section adds "Email to myself (Gmail, gog)", noting that "Available" only means gog runs and that Gmail sign-in shows in the result of sending; both languages |

Your address never appears in the model's tool list, and result messages contain neither the address nor the body.

## 2. Tests (fixtures)

New test file `tests/integration-mail-gog.test.ts`, 15 tests:

- Newlines, C1 control characters and bidi override characters are removed from the subject (a `Bcc:` injection has no effect); length is capped; body line endings are normalized.
- Arguments are always `--flag=value`; a subject written as `--to=other@…` stays subject text, and the recipient is always the configured self.
- The message ID is found in several JSON shapes; non-JSON output or an ID containing spaces is not accepted.
- An ID gives `confirmed`; the body goes only through stdin, not the arguments; the result contains neither the address nor the body.
- No ID gives `unconfirmed`; non-zero gives `unknown`; gog missing or not executable gives `failed`; an abort is left to the Dispatcher (which returns `unknown`); a subject that is empty after cleaning is refused.
- At most 5 emails a minute: the 6th is refused without calling gog, and sending resumes after a minute.
- Real spawn: a non-zero exit is `unknown`; a fake gog that ignores SIGTERM is killed with SIGKILL after an abort, leaving no stray process.
- Health check: runs gives available; missing gives unavailable; non-zero gives status unknown.
- **A real spawn of a fake gog script**: `$(touch pwned)`, backticks and `;` in the subject arrive verbatim as an argument (no shell involved); `$HOME` in the body arrives verbatim on stdin.
- Policy: only `app.mail.send_to_self` is exempt; other `external_commit` tools still need confirmation.
- Configuration: the address is not read unless `gmail_gog` is listed; an invalid address or gog path is an error.
- Through the integration layer: no address means no registration; the model sees only `subject` and `body`; the Dispatcher runs it without a card; an extra `to` argument from the model is rejected by the schema and nothing runs.

Commands and results (2026-11-04, Linux cloud, Node.js 22):

- `npm run typecheck`: pass.
- `npx vitest run`: 134 files, 2,455 passed and 5 skipped.
- `node scripts/verify-aios.mjs`: PASS; `git diff --check`: pass.

## 3. Setup and validation steps on the Mac (not yet run)

1. **Install gog**: `brew install openclaw/tap/gogcli` (as written in the official README; if that fails, try `brew install steipete/tap/gogcli`).
2. **Create a Google OAuth client** (once): in Google Cloud Console create a project, enable the Gmail API, create an OAuth client of type "Desktop app", download `client_secret_….json`, then run `gog auth credentials set ~/Downloads/client_secret_*.json`.
3. **Authorize sending only** (least privilege): `gog auth add <your Gmail> --services gmail --gmail-scope send`.
4. **Check the format by hand once**: first run `gog gmail send --help` and confirm that `--account`, `--to`, `--subject`, `--body-file` and `--json` exist. Then run:
   `echo test | gog gmail send --account=<your Gmail> --to=<your Gmail> --subject=MAIL-1-test --body-file=- --json`
   Note the name of the message ID field in the output (only the field name, not the content). If it is not one of `id`, `messageId` or `message_id`, tell me and I will change the matching rule.
5. **Configure Nous**: add `NOUS_AIL=on`, `NOUS_AIL_SERVICES=gmail_gog` (append with a comma if other services are already listed) and `NOUS_MAIL_SELF=<your Gmail>` to `.env`. If gog is not in a Homebrew location, also add `NOUS_GOG_PATH=<output of which gog>`. Then restart Nous.
6. **Check the status**: open the settings page; "App integrations" should show "Email to myself (Gmail, gog): Available".
7. **Send by voice**: on each of the two realtime voice routes, say "email me a reminder to bring an umbrella tomorrow"; confirm the email arrives and that Nous says "The email was sent to your Gmail".
8. **Failure path**: unplug the network and ask again; Nous must not say it was sent, and should say it failed or the result is unknown.
9. **Confirm nothing leaks**: Nous's log contains only "integration layer" status codes, with no address, subject or body.
10. **Roll back**: remove `gmail_gog` from `NOUS_AIL_SERVICES` and restart. To revoke Google access, run `gog auth remove <your Gmail>` or remove it under "Third-party access" in your Google Account.

## 4. Independent review and fixes

An independent review by the same model (not a cross-model review) found no blockers, 2 medium and 6 low items. Fixed: a non-zero exit changed from `failed` to `unknown` (so Nous never says it was not sent and the model does not resend); the bilingual status documents were updated; SIGKILL after a grace period on abort; any failure to start is `failed`; C1 control and bidi override characters are removed; a limit of 5 emails a minute; an unused constant was removed; real-spawn tests for a non-zero exit and an abort, and a test that `decide` is unchanged for other effects, were added. Not changed: configuration errors and log lines are Chinese only, matching the existing Adapters.

## 5. Is there a simpler way to email myself?

| Approach | Setup cost | Can Nous confirm it was sent? | Notes |
|---|---|---|---|
| **gog (this batch)** | One Google Cloud OAuth client (about 10–15 minutes) plus `gog auth add` | Yes: only a message ID counts as sent | Reliable; the token stays in the keychain and Nous never touches it |
| macOS Mail app (AppleScript) | Almost none if Mail is already signed in to your Gmail; you must allow Nous to control Mail | No: it only knows the message was handed to Mail, so the best result is `unconfirmed` | Least setup, but you have to check yourself whether it went out |
| Gmail SMTP plus an app password | Turn on 2-Step Verification, create an app password and put it in `.env` | Yes (the server replies 250) | This project adds no packages, so an SMTP client would have to be written; the password is long-lived and riskier than OAuth |
| No email: save it as a Nous result, or write it to Reminders/Notes | Results history already exists; Reminders needs a new Adapter | Yes | Simplest if the goal is just "note it down for myself" |

**Recommendation**: to actually receive an email, gog is the simplest approach that can also confirm the result, and the setup is one-time. If you mainly use the Mac Mail app and do not want to set up Google Cloud, an AppleScript version could be added, but Nous could only say "handed to Mail". If you only want to note things down, Nous results or Reminders are more direct.

## 6. Limits and open items

- Nothing has run on a Mac, real gog or Gmail; section 3 has not been done.
- The message ID field names are an assumption and must be checked in step 4 of section 3.
- It can only send to yourself: no attachments, HTML, replies or reading mail.
- The health check only confirms that gog runs, not that Gmail is signed in.
- On timeout, abort or an error reported by gog, the email may already have been sent; Nous will only say "result unknown, please check".

## 7. Next gate

Only after George completes section 3 on the Mac and keeps a de-identified record can we claim "Nous can email George by voice".
