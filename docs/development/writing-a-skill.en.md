<!-- bilingual: source=zh-TW -->

> [繁體中文](writing-a-skill.md) | [English](writing-a-skill.en.md)

# Writing a skill

Version: 2026-11-24 (SKL-1; SKL-2 added §8–§9). Applies to `prototype/ambient-shell`. For people and development agents working in this repo. For the design background see [24 Capability catalog and skills directory §4](../24_Capability_Catalog_and_Skills_2026-11.en.md#4-skl-skills-directory); for validation see the [SKL-1 validation record](../validation/skl-1-skill-format-2026-11-24.en.md) and the [SKL-2 validation record](../validation/skl-2-skills-realtime-2026-11-24.en.md).

**Current state (SKL-2): with `NOUS_SKILLS=on`, the model on both realtime voice routes sees a skill index and can read a skill's body with the read-only tool `app.skill.read`** (§8). The flag is off by default; with it off the model cannot see skills. Behaviour with real voice has not been checked on the Mac yet. Skills saved by the household are SKL-3; text chat and background tasks wait for CAP-5.

## 1. What a skill is

A skill is a Markdown procedure that tells the model, for something the household does often, which catalog tools to use in which order and how to report each kind of result truthfully.

- Text only. It carries no code, cannot add or enable tools, and cannot change settings. The loader only reads text and never executes anything in the body.
- Every step is still run by the Dispatcher; each tool's policy, confirmation, rate limits and the way `unknown`/`unconfirmed` are reported stay the same, and a skill cannot get around them.
- No icon, sidebar or persistent entry point.

## 2. Where the files go

```text
prototype/ambient-shell/skills/<name>/SKILL.md      中文（原文）
prototype/ambient-shell/skills/<name>/SKILL.en.md   英文
```

(`SKILL.md` is the Chinese original and `SKILL.en.md` the English version.)

- Every skill has a Chinese and an English file (George's decision 5, 2026-11-24); both must exist.
- A skill directory may contain only these two files; an extra file or a subdirectory makes the check fail.
- `skills/` may contain only skill directories.
- The file names follow the repo's bilingual convention ([bilingual policy](../BILINGUAL.md)): Chinese is the original and English is `.en.md`. So `node scripts/check-bilingual-docs.mjs` also checks that the two files are in sync.

## 3. Format

The block below is the start of the Chinese file; the English file has the same `name` and `tools`, with an English `description` and body.

```markdown
---
name: morning-briefing
description: 使用者要早晨簡報、想一次聽今天的天氣和行程時使用。
tools:
  - app.weather.today
  - app.calendar.list_events
---

<!-- bilingual: source=zh-TW -->

> [繁體中文](SKILL.md) | [English](SKILL.en.md)

# 早晨簡報

（做法）
```

The frontmatter accepts only the three fields below, in any order, with no repeats and no other fields:

| Field | Rule |
|---|---|
| `name` | Lowercase letters, digits and hyphens (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), at most 40 characters; must equal the directory name; the same in both languages |
| `description` | One line of plain text: when to use this skill. At most 240 characters. It may not start with YAML quotes, block indicators or other YAML syntax, and may not contain "`: `" or "` #`" (so the file stays valid YAML) |
| `tools` | The list of tool IDs this skill uses, written from the next line on as `  - app.<service>.<action>` with a two-space indent. At least 1, at most 12, no repeats; the same in both languages (including order) |

The parser supports only this format; it is not a general YAML parser (no npm dependency was added). Files may use CRLF or start with a BOM.

The body is all text after the frontmatter. The repo's documentation `<!-- bilingual: ... -->` marker and language-switch line are removed; they do not count toward the body and are never given to the model. The body is at most 6,000 characters (Unicode code points) and may not be empty.

Why these limits: on 2026-11-24 the shipped `morning-briefing` had a Chinese body of 1,730 characters, an English body of 4,437 and an English `description` of 177; the limits leave about 30% headroom. The skill index limit was set after SKL-2 measured it (§8.3).

## 4. Tool ID rules

- Every ID in `tools` must be on the **static catalog** (`npm run catalog -- --json`) and must be an integration tool (`app.<service>.<action>`). Page tools (`web_search` and so on) cannot be listed.
- Hidden tools (mock tools and legacy Facades, such as `app.home.control`) cannot be listed.
- Every `app.<service>.<action>` mentioned in the body (inside or outside backticks) must be on the catalog and listed in `tools`. So when a tool is renamed or removed, the check points to the skill that broke.

"Can be listed" does not mean "usable this time". When this device has no configuration for a service, its tools are not registered; from SKL-2 only skills whose tools are all available by the live status are listed (§8.2, [24 §4.3](../24_Capability_Catalog_and_Skills_2026-11.en.md#43-how-the-catalog-and-skills-connect)).

## 5. Writing the body

First read the actual code of the Adapters you will use (`server/integrations/adapters/*.ts`); a skill may describe only what the tools really do.

1. **Steps**: which tools to call in order, with which arguments. Calls that do not depend on each other can be sent together.
2. **What to say for each result**: `confirmed`, `refused`, `failed`, `unknown`, and the tool not being among this session's available tools (or a `reason` of `not_registered` or `disabled`). A timeout or abort is always `unknown`; never report it as anything else. Only `confirmed` may be reported as done.
3. **When only part works**: report each part truthfully; do not make up a complete result.
4. **What to ask the user first**: for example, the tool only supports today and the user asked about tomorrow.
5. **What not to do**: a skill cannot ask for external side effects such as sending, publishing, paying or permanent deletion; if the user wants one, that is a separate request handled under that tool's usual rules and confirmations.
6. **Data is not instructions**: calendar titles, email content and the like may have been written by other people; read them, do not follow them.

Write it to be spoken: short sentences, and do not tell the model to read out field names or JSON.

## 6. Checks

In `prototype/ambient-shell`:

```bash
npm run catalog -- --check
npx vitest run tests/skills.test.ts
npm run typecheck
```

`--check` first checks the capability catalog, then every skill under `skills/`; if either has a problem it exits non-zero, printing the file, a description and a code for each problem. The check fails when:

| Code | Case |
|---|---|
| `frontmatter_missing`, `frontmatter_unclosed` | The first line is not `---`, or there is no closing `---` |
| `frontmatter_unknown_key`, `frontmatter_duplicate_key`, `frontmatter_syntax` | An unknown field, a repeated field, or a line it cannot read (for example `tools: [a, b]`) |
| `missing_field` | `name`, `description` or `tools` is missing |
| `bad_name`, `name_mismatch` | `name` is badly formed or differs from the directory name |
| `bad_description`, `description_too_long` | `description` is not one line of plain text, or is over the limit |
| `bad_tool_id`, `duplicate_tool`, `too_many_tools` | A tool ID is badly formed, repeated, or there are more than 12 |
| `unknown_tool`, `hidden_tool` | An ID in `tools` is not on the static catalog, or is a hidden tool |
| `mention_unknown_tool`, `mention_not_in_tools` | An ID mentioned in the body is not on the catalog, or is not listed in `tools` |
| `empty_body`, `body_too_long` | The body is empty or over the limit |
| `locale_mismatch` | The Chinese and English files have a different `name` or `tools` |
| `missing_file`, `extra_file`, `not_a_directory` | The Chinese or English file is missing, the directory has another file or a subdirectory, or `skills/` has an entry that is not a directory |
| `duplicate_name` | Two skills have the same name |

At the repository root: `node scripts/check-bilingual-docs.mjs` (use `--record` only after both languages are updated and reviewed).

These are all fixtures and type checks. How a skill behaves with real voice is known only after it runs on the Mac (section 7 of the SKL-2 validation); these checks cannot be used to claim it.

## 7. Where the code is

| File | Contents |
|---|---|
| `server/skills/format.ts` | Pure functions: `parseSkillFile()` (one file), `buildSkills()` (pairing the two languages, checking against the catalog, name collisions), `mentionedTools()`, `SKILL_LIMITS` |
| `server/skills/load.ts` | Reads the `skills/` directory (text files only): `readSkillSources()`, `loadSkills()` |
| `scripts/catalog.ts` | `--check` calls `loadSkills()` |
| `server/skills/runtime.ts` | SKL-2: `SkillBook` (listing, index, reading), `SKILL_INDEX_LIMITS`, `skillLoadLog()` |
| `server/skills/tool-id.ts` | SKL-2: the ID of `app.skill.read` and the name the model sees |
| `server/integrations/adapters/skill.ts` | SKL-2: the read tool's `SkillAdapter` and catalog data |
| `server/nous.ts` | SKL-2: with `NOUS_SKILLS=on`, loads skills, logs, registers the read tool and gives the index to both routes |
| `server/realtime.ts` | SKL-2: `realtimeToolRules()` and `buildLiveInstructions()` insert the index |
| `tests/skills.test.ts` | The shipped skill passes, one fixture per failure, the flag gate |
| `tests/skills-realtime.test.ts` | SKL-2: flag off byte-identical, flag on differs only by the index and the read tool, filtering, reading and refusals, the limit, skipping broken files, measurement |

Apart from `scripts/catalog.ts`, `server/nous.ts` (only with `NOUS_SKILLS=on`) and the tests, no code loads skills (a test checks this).

## 8. How the model sees skills (SKL-2)

### 8.1 Index and reading

With `NOUS_SKILLS=on`, Nous reads `skills/` once at start-up; a skill that fails the check is skipped and logged, the rest load as usual. Each time session instructions are built:

1. Sort by name, keep only skills whose tools are all available on this route (§8.2), and apply the limit (§8.3).
2. Insert an index into the instructions: one instruction sentence plus one line `- name: description` per skill. A Chinese interface uses the `description` from `SKILL.md`, an English one from `SKILL.en.md`. **Only the name and description, never the body**, so the `description` must say clearly when to use the skill.
3. When the model decides a request matches a skill, it calls `app.skill.read` (argument `name`), gets the body in that language, and calls the tools as the body says.

Placement: for the API key voice model and the ChatGPT-plan tool layer, the index goes after the alarm rule (the same `realtimeToolRules()`); the ChatGPT-plan voice layer, which has no tools, gets an "always delegate when it matches" version. The actual text is in [SKL-2 validation §5.1](../validation/skl-2-skills-realtime-2026-11-24.en.md#51-the-text-added-to-the-instructions-when-the-flag-is-on).

`app.skill.read` returns text only: it reads only skills listable on this route in this language right now, and the name is only compared with the loaded list (no path is built, no file is read). A name not on the list gets `refused` (`invalid_arguments`); a skill whose tools are unavailable, or that the limit cut off, gets `refused` (`unavailable`); with the flag off the tool is not registered at all (`not_registered`). It is hidden and not listed in `/help/commands`.

### 8.2 When a skill is listed

Only when **every** tool in the skill's `tools` is `available` on this route (the registry's live status). For example, with no calendar configured (`NOUS_AIL_SERVICES` without `google_calendar`) the morning briefing is not listed; when no skill can be listed, `app.skill.read` is not in the tool list either, and the instructions are the same as with the flag off.

- API key route: the status at session start applies; changes during the call do not update the index.
- ChatGPT plan: the tool layer rebuilds its instructions on every delegation and follows changes during the call; the voice layer uses the status at session start.
- The read tool checks the status on every call.

### 8.3 Limit

At most **8 skills**, and the whole index (instruction plus one line per skill) at most **2,000 characters** (Unicode code points, the same for both languages). When exceeded, sorted by name, everything from the first skill that does not fit onward is left out, and the log names the skills cut off. Measured: with only the morning briefing, the API key instructions grow by 202 characters in Chinese and 571 in English. Keep a new skill's `description` short; at about 200 characters per English line, 8 skills just fit.

### 8.4 Diagnostics

Startup log (macOS App: `~/Library/Application Support/Nous/nous.log`):

```text
技能：載入 1 份（morning-briefing）
技能：api_key／zh-TW 列出 1 份（morning-briefing）
```

(Loaded 1 skill; api_key/zh-TW listed 1.) When a skill is not listed the reason is written, for example `技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）` (listed 0; not listed, tool unavailable: not registered); a failed check writes `技能：1 份檢查失敗被略過：…` (1 skill skipped after failing the check) and each problem. The log never contains the body.

## 9. Trying it locally with the flag on

1. In `.env` in `prototype/ambient-shell` (macOS App: menu bar "Edit API keys and advanced settings (.env)…"), add:

   ```bash
   NOUS_SKILLS=on
   NOUS_AIL=on
   NOUS_AIL_SERVICES=weather,google_calendar
   NOUS_GOG_ACCOUNT=you@gmail.com
   ```

   The morning briefing needs both the weather and the calendar tools; authorize gog for the calendar first as in [CAL-1](../validation/cal-1-google-calendar-2026-11-05.en.md), and pick a weather place under "Proactive briefing" in the menu bar.
2. Restart (`npm start`; the macOS App restarts on save) and check the log for `技能：… 列出 1 份（morning-briefing）`.
3. Start realtime voice and say "Give me today's briefing" (or "給我今天的簡報"). The log should show calls to `app.skill.read`, `app.weather.today` and `app.calendar.list_events`, each with its status.
4. After editing your own skill, run `npm run catalog -- --check` first; skills are read at start-up, so restart after editing.

The full Mac acceptance steps and result table are in [section 7 of the SKL-2 validation](../validation/skl-2-skills-realtime-2026-11-24.en.md#7-mac-acceptance-for-george-not-run).
