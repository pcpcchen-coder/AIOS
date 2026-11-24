<!-- bilingual: source=zh-TW -->

> [繁體中文](writing-a-skill.md) | [English](writing-a-skill.en.md)

# Writing a skill

Version: 2026-11-24 (SKL-1). Applies to `prototype/ambient-shell`. For people and development agents working in this repo. For the design background see [24 Capability catalog and skills directory §4](../24_Capability_Catalog_and_Skills_2026-11.en.md#4-skl-skills-directory); for this batch's validation see the [SKL-1 validation record](../validation/skl-1-skill-format-2026-11-24.en.md).

**Current state: the model cannot see skills yet.** SKL-1 only provides the format, the parser and the check, plus one shipped skill, "morning briefing". Putting a skill index into the session instructions and the read-only tool `app.skill.read` are SKL-2; skills saved by the household are SKL-3. No code reads the `NOUS_SKILLS` flag (off by default) in SKL-1; SKL-2 will use it.

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

Why these limits: on 2026-11-24 the shipped `morning-briefing` had a Chinese body of 1,730 characters, an English body of 4,437 and an English `description` of 177; the limits leave about 30% headroom. How many skills the index lists at once and how much text it takes will be decided after SKL-2 measures it.

## 4. Tool ID rules

- Every ID in `tools` must be on the **static catalog** (`npm run catalog -- --json`) and must be an integration tool (`app.<service>.<action>`). Page tools (`web_search` and so on) cannot be listed.
- Hidden tools (mock tools and legacy Facades, such as `app.home.control`) cannot be listed.
- Every `app.<service>.<action>` mentioned in the body (inside or outside backticks) must be on the catalog and listed in `tools`. So when a tool is renamed or removed, the check points to the skill that broke.

"Can be listed" does not mean "usable this time". When this device has no configuration for a service, its tools are not registered; SKL-2 will list only the skills whose tools are all available on the live catalog ([24 §4.3](../24_Capability_Catalog_and_Skills_2026-11.en.md#43-how-the-catalog-and-skills-connect)).

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

These are all fixtures and type checks. How a skill behaves with real voice is known only after SKL-2 runs it on the Mac; these checks cannot be used to claim it.

## 7. Where the code is

| File | Contents |
|---|---|
| `server/skills/format.ts` | Pure functions: `parseSkillFile()` (one file), `buildSkills()` (pairing the two languages, checking against the catalog, name collisions), `mentionedTools()`, `SKILL_LIMITS` |
| `server/skills/load.ts` | Reads the `skills/` directory (text files only): `readSkillSources()`, `loadSkills()` |
| `scripts/catalog.ts` | `--check` calls `loadSkills()` |
| `tests/skills.test.ts` | The shipped skill passes, one fixture per failure, and the gates for the flag and "the model cannot see it" |

In SKL-1, apart from `scripts/catalog.ts` and the tests, no code imports `server/skills/` (a test checks this), so the model, the session instructions and `/help/commands` never see skills.
