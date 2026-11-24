<!-- bilingual: source=zh-TW -->

> [繁體中文](24_Capability_Catalog_and_Skills_2026-11.md) | [English](24_Capability_Catalog_and_Skills_2026-11.en.md)

# Nous 24 — Capability catalog and skills directory (2026-11)

Version: v0.1 · Date: 2026-11-24 (Asia/Taipei) · Status: **George answered the 6 decisions on 2026-11-24 ([§6.1](#61-george-的決定2026-11-24)) and agreed to start with CAP-1; this document itself changes no product code**. Baseline: main `fd2198b` (after PR #150). This document borrows two mechanisms from [Omarchy](https://omarchy.org/), compares them with the existing Nous code, and proposes two groups of batches: CAP (capability catalog) and SKL (skills directory). CAP and SKL are new batch labels introduced here. They do not change the gates in `docs/07`, F0–F10 in `docs/13`, or any ADR. Development follows [CLAUDE.md](../CLAUDE.en.md), the [current implementation status](Current_Implementation_Status.en.md), [18 App Integration Layer](18_App_Integration_Layer_and_Spotify_2026-11.en.md), and the [bilingual policy](BILINGUAL.md).

## 0. One-page summary

- Nous already has a tool registry: `prototype/ambient-shell/server/integrations/registry.ts` (AIL-1). So this proposal does not design from zero. It closes three gaps.
- **Gap 1: the registry only speaks to the model.** Each tool has a `description` for the model, but no one-line summary for people and no "you can say this" examples. The voice command table (`/help/commands`) is therefore written by hand elsewhere: `ASK_THE_AI` in `shared/voice-commands.ts` lists only the 9 page tools, and `TIMER_ASK` hand-writes 5 rows for timers and alarms. The TV, calendar, mail, weather, and voice relay tools are not in the table.
- **Gap 2: there is no machine-readable catalog.** `IntegrationRegistry.capabilities(route)` is written but has no caller. The settings view receives tool names only. No single list says "what Nous can do now, and why an item is unavailable" for people, the model, and development agents to share.
- **Gap 3: there are no skills.** `docs/06` describes "remember this way of doing it" to save a skill, and the status document says skill promotion does not exist. The code has no data structure for skills (searching `server`, `shared`, and `src` for `skill`／`技能` returns nothing).
- **Proposal**:
  - **CAP**: add the human summary and examples to each tool definition, and have the registry produce one catalog. Generate the voice command table from it. Add a check that fails when something is missing.
  - **SKL**: a skill is a Markdown procedure that only describes "how to use catalog tools to do something this household does often". It adds no tools, carries no code, and changes no permissions. The check confirms that every tool a skill mentions is in the catalog.
- **Recommended order**: CAP-1 → CAP-2 → SKL-1 → SKL-2 → CAP-3 → SKL-3. The skill check needs the catalog, so CAP-1 comes first.
- George answered the 6 open items on 2026-11-24. See [§6.1](#61-george-的決定2026-11-24).

## 1. The two Omarchy mechanisms

These are facts read from the `quattro` branch of `omacom/omarchy` on 2026-11-24. The parts not read are listed at the end of this section. This proposal borrows the approach only and copies no code.

### 1.1 Command catalog

- There is no separate manifest file. The header comments of each `omarchy-*` executable in `bin/` are its data: `omarchy:summary=`, `omarchy:args=`, `omarchy:examples=`, `omarchy:group=`, `omarchy:hidden=true`, `omarchy:requires-sudo=true`, and others.
- The dispatcher `bin/omarchy` scans these files, reads the comments in the first 80 lines, and builds the catalog.
- `omarchy commands --json` outputs each command's `route`, `group`, `name`, `summary`, `args`, `examples`, `aliases`, `hidden`, and `requires_sudo`.
- `omarchy commands --check` fails on: a route collision, a missing explicit `summary`, a `hidden`／`requires-sudo` value that is not `true`, and a malformed `subcommand`.
- Menu nodes live in another file (`default/omarchy/omarchy-menu.jsonc`). Each node's `action` is one shell command line, and most call the same `omarchy-*` executables directly. The documents read do not say that menu `action` values are checked against the catalog.

### 1.2 Skills

- Skills shipped with the system live in `default/agents/skills/<name>/SKILL.md`. The frontmatter has only two fields, `name` and `description`.
- The main skill, `omarchy`, contains rules and procedures: edit only `~/.config/` and never the system directory; prefer `omarchy <group> <action>`; find commands with `omarchy commands --json`; confirm before certain actions. Details are split into topic files in the same directory, linked from `SKILL.md`.
- `bin/omarchy-agent-skills-link` symlinks each skill directory into the skills directory of each agent tool. When the user has a directory with the same name, the user's wins.
- `agents/skills/*.md` at the repo root is a different thing: task guides for **agents that develop Omarchy** (for example, how to write command metadata comments and how to write a migration). They have no frontmatter and are indexed by `AGENTS.md`.

### 1.3 Not verified

- The manual says 7 skills ship. Only the `SKILL.md` of `omarchy` was read. The other 6 and the topic files were not read.
- The `bin/` file listing was truncated on the page, so not every command was seen.
- No real sample of `omarchy commands --json` output was found. The fields were read from the jq filter in `bin/omarchy`.

### 1.4 What to borrow and what not to

| Omarchy | Nous equivalent | Decision |
|---|---|---|
| Data lives in each command's own file header | Data lives in each tool's own `ToolDefinition` | Borrow. No separate manifest file |
| `commands --json` | The registry produces catalog JSON | Borrow |
| `commands --check` | A test and a check script | Borrow |
| `hidden=true` | Mock tools and Facade tools are left out of the table for people | Borrow |
| Menu written separately, not checked against the catalog | The voice command table is **generated directly from the catalog** | Improve: one source, nothing left out |
| Skill = Markdown + `name`／`description` | The same, plus a `tools` field listing the tools it uses | Borrow and extend |
| A user skill with the same name wins | The same | Borrow (SKL-3) |
| Task guides for development agents | One bilingual how-to, "How to add an Adapter" | Borrow (in CAP-1) |
| App launcher, system menu, keyboard first | None | **Do not borrow**; it breaks the product red lines |
| A CLI for users to type | None | Do not borrow. The `npm run catalog` below is a development tool only |
| Dynamic plugin installation | None | Do not borrow. Adapters are still registered in code only (`docs/18` §4) |

## 2. Current state of Nous

All paths are under `prototype/ambient-shell/`.

| Item | Location | Current state |
|---|---|---|
| Tool registry | `server/integrations/registry.ts` | Checks the ID, schema, `effect`, time limit, and routes at registration. `listTools(route)` and `functionSpecs(route, locale)` produce the list for the model |
| Tool definition | `server/integrations/contracts.ts` `ToolDefinition` | `id`, `description`, `descriptionEn`, `inputSchema`, `effect`, `enabled`, `timeoutMs`, `supportedRoutes`, `legacyName`. **No summary or examples for people** |
| Reviewed Adapters | `server/integrations/index.ts` `KNOWN_ADAPTERS` | 8: `mock`, `home`, `spotify_soloist`, `voice_relay`, `google_calendar`, `weather`, `lg_tv`, `gmail_gog`; plus the timers and alarms built into the core |
| Tool IDs | `server/integrations/adapters/*.ts` | 32 distinct `app.<service>.<action>` strings: alarm 6, calendar 2, home 3, mail 1, mock 2, timer 7, tv 9, voice_relay 1, weather 1 (for the method, see [§7](#7-數字的計算方式)) |
| Page tools | `shared/realtime-route.ts` `HOST_TOOL_NAMES` | 9 (`web_search`, `delegate_task`, `home_status`, and others), outside the registry, with their own name list and time limits |
| Diagnostic list | `IntegrationRegistry.capabilities(route)` | Implemented, with no caller |
| Voice command table | `shared/voice-commands.ts`, `server/commands-page.ts` | Tests verify the local fixed phrases sentence by sentence. The "you can ask the AI" section is the hand-written `ASK_THE_AI` (9 page tools) and `TIMER_ASK` (5 rows) |
| Settings view | settings in `server/app.ts` | Only `integrations.tools`: the list of tool function names |
| Text chat and background tasks | `server/claude-executor.ts`, `server/chatgpt-executor.ts` | Web search only; not connected to the registry (already recorded in `docs/18` §2) |
| Skills | None | No data structure, no loading, no saving |

One detail of how Adapters are built affects the design: when configuration is missing, the factory returns `null` and that Adapter is not registered. So **the running registry only knows the services configured this time**. It cannot answer "what can Nous connect to in total".

## 3. CAP: capability catalog

### 3.1 Where the data lives

Add it to `ToolDefinition`, next to `description` and `effect`. Whoever adds a tool writes everything in one place and does not edit a second file.

```ts
// 提案草稿，不是已存在的型別。
interface ToolCatalogInfo {
  /** 給人看的一句話：這個工具做什麼。 */
  summary: string;
  /** 可以這樣說（至少一句）。 */
  examples: readonly [string, ...string[]];
  /** 前提，例如「需要電視已配對」。沒有就不寫。 */
  needs?: string;
  /** 不列在給人看的表（模擬工具、Facade 工具）。 */
  hidden?: true;
}
```

The first comment says this is a proposal draft, not an existing type. The field comments mean, in order: a one-line summary for people of what the tool does; things you can say (at least one); a precondition such as "the TV must be paired", omitted when there is none; and not listed in the table for people (mock tools and Facade tools).

Each Adapter also gains a service name for people (for example, "living room TV"), which corresponds to Omarchy's group descriptions.

Chinese is the source text. English reuses the existing shared translation catalog and `localize()` (`server/localization.ts`), with no second set of English fields. The check confirms that every sentence has English.

### 3.2 Two catalogs

| | Static catalog | Live catalog |
|---|---|---|
| Question it answers | Which tools does the Nous code define in total | Which are available now, on this device and this route, and why the others are not |
| Source | The tool definitions of every reviewed Adapter, with no configuration needed | The running registry plus health status |
| Use | The check, the documents, and matching skill tool IDs | The "current" notes in the voice command table, and the model's answer to "what can you do" |

The static catalog needs each Adapter to hand over its tool definitions without configuration. CAP-1 must confirm, one by one, whether all 10 existing Adapter files can do that. For those that cannot, first move the definitions into module-level constants.

The shape of one entry (illustration; CAP-1 settles the field names):

```json
{
  "id": "app.tv.volume",
  "wire": "app__tv__volume",
  "adapter": "lg_tv",
  "effect": "reversible_write",
  "routes": ["api_key", "live"],
  "summary": "…",
  "examples": ["…"],
  "mock": false,
  "status": { "api_key": "available", "live": "available" }
}
```

`status` appears only in the live catalog. Its values reuse the existing `CapabilityStatus`.

### 3.3 Batches

| Batch | Deliverable | Gate |
|---|---|---|
| CAP-0 (this document) | Bilingual proposal | Documents link to each other, the bilingual check passes, no product code changed |
| CAP-1 | The `ToolCatalogInfo` fields; summaries and examples for every existing tool; `registry.catalog()`; `npm run catalog -- --json／--check／--markdown`; the bilingual how-to "How to add an Adapter" | The check fails on a missing summary, missing examples, missing English, or an ID collision. **The tool JSON sent to the model is byte-identical to before the change** (compared by a test). Everything is fixture-based; this is not a product gate |
| CAP-2 | In `/help/commands` and the prototype README, the integration-tool part of the "you can ask the AI" section is generated from the catalog; `TIMER_ASK` is generated from the catalog; unavailable rows show the reason from the live status | Rows for the TV, calendar, mail, and weather appear in the table; mock tools and Facades do not; the rows of the 9 existing page tools do not change |
| CAP-3 | A built-in read-only tool (working name `app.nous.capabilities`): when asked "what can you do" or "why can't you turn on the TV", the model answers from the live catalog, including the reason something is unavailable | Fixture tests. On the Mac, ask by real voice once about an available service and once about an unavailable one; the answers match the settings view |
| CAP-4 (George agreed 2026-11-24) | The 9 page tools also have catalog data, and `ASK_THE_AI` is generated from the catalog | The tool definitions the model sees do not change; the rows and order of the command table do not change |
| CAP-6 (George agreed 2026-11-24) | Tool calls drive brain regions: when the page receives a real tool-call event, it lights the region given by that tool's `domain` in the catalog and labels the source as a tool call | Fixtures; nothing lights without a tool call; mock tools are labelled mock; one real voice trial on the Mac. The CLAUDE.md rule is relaxed to match |
| CAP-5 (separate proposal) | Text chat and background tasks connect to the registry | Outside this proposal. `docs/18` §2 already says it needs its own batch |

**CAP-2 status note (2026-11-24)**: implemented on branch `claude/cap-2-commands-from-catalog`. "Timers and alarms" is generated from the catalog (one row per tool, 13 rows), the integration tools are in a new "App integrations" section (14 rows), and the 9 page tools in "ask the AI" are untouched (CAP-4); unavailable rows show the reason from the live catalog. Cloud fixtures and type checks, not a product gate; see the [CAP-2 validation](validation/cap-2-commands-from-catalog-2026-11-24.en.md).

CAP-1 and CAP-2 change no voice behavior. They change only the help page and development tools. The first things a user notices are CAP-2 (the command table becomes complete) and CAP-3 (you can ask Nous directly what it can do).

### 3.4 How CAP-3 is presented

The answer to "what can you do" is spoken first. When a screen is needed, it appears only because the user asked this time. Its `visibility_reason` is this question, and it closes after reading according to the existing setting. **No permanent capability list, icon wall, or home page.**

## 4. SKL: skills directory

### 4.1 What a skill is

A skill is a Markdown file that tells the model "for this thing the household does often, which tools to use in which order, and what to do in each situation".

- A skill is **text only**. It cannot add a tool, cannot enable a disabled tool, carries no code, and cannot change settings.
- The Dispatcher still runs every step in a skill. Policy, confirmation cards, rate limits, and the way `unknown`／`unconfirmed` are reported all stay the same. A skill cannot bypass confirmation.
- A skill creates no icon, sidebar, or permanent entry point. The model uses it only when the user makes a request.

### 4.2 File format

```text
prototype/ambient-shell/skills/<name>/SKILL.md
<data-dir>/skills/<name>/SKILL.md
```

The first line is a skill that ships with the code and is reviewed in a PR. The second line is a skill saved by the household (SKL-3), in the Nous data directory; it wins on a name clash.

```markdown
---
name: movie-night
description: 使用者說要看電影、看片、電影時間時使用。
tools:
  - app.tv.power
  - app.tv.launch_app
  - app.home.control
---

（做法：步驟、每一步失敗時怎麼說、哪些事要先問使用者）
```

The `description` above means "use when the user says they want to watch a movie, watch something, or have movie time". The body placeholder means "procedure: the steps, what to say when each step fails, and what to ask the user first".

`name` and `description` match the skill format of Omarchy and of the agent tools. `tools` is a field Nous adds: it lists the tool IDs this skill uses. The skill name and tool combination above only illustrate the format. They are not decided content.

SKL-3 settles the real path of the household data directory, based on `server/config.ts`.

### 4.3 How the catalog and skills connect

- **Check**: every `app.<service>.<action>` in a skill's `tools` field and body must be in the static catalog. When a tool is renamed or removed, the check names the skill that broke. Omarchy's menu has no such cross-check.
- **Listing**: a skill appears in the skill index given to the model only when **all** of its `tools` are available on that route. When the TV is not paired, the model does not see a skill that needs the TV, so it does not promise something it cannot do.
- **Loading**: the model first sees only the index (the `name` and `description` of each skill). When it decides to use one, it reads the body with a read-only tool (working name `app.skill.read`). How much text the index takes and how many skills it lists at once are measured in SKL-2 before any number is set.

### 4.4 Batches

| Batch | Deliverable | Gate |
|---|---|---|
| SKL-1 | Format, parser, and check (part of `npm run catalog -- --check`); 1 shipped skill (morning briefing, one file per language); the flag `NOUS_SKILLS` is off by default, and **the model cannot see them yet** | Fixtures: the check fails on bad frontmatter, a name that differs from the directory, a tool ID that does not exist, and a body that is too long |
| SKL-2 | Both realtime voice routes: the skill index enters the session instructions; `app.skill.read`; filtering by available tools | Fixtures. With the flag off, the tool list and instructions are byte-identical. On the Mac, run the shipped skill once by real voice and record the real result of every step |
| SKL-3 | "Remember this way of doing it": the model drafts → the screen shows the name and steps → the file is written after the user confirms; list and forget by voice; the household's skill wins on a name clash | Fixtures. On the Mac, save one, use it once, and forget it once. Nothing is written without confirmation |

**SKL-1 status note (2026-11-24)**: implemented on branch `claude/skl-1-skill-format`. The format is `skills/<name>/SKILL.md` (Chinese) and `SKILL.en.md` (English), with only `name`, `description` and `tools` in the frontmatter; the parser and check are in `server/skills/` and part of `npm run catalog -- --check`, with a fixture for each of the 24 failure codes; one shipped skill, "morning briefing" (only the weather and calendar read tools). **The model cannot see skills yet**; no code reads `NOUS_SKILLS` in this batch, and SKL-2 will use it. Cloud fixtures and type checks, not a product gate and not a Mac acceptance test; see the [SKL-1 validation](validation/skl-1-skill-format-2026-11-24.en.md) and [Writing a skill](development/writing-a-skill.en.md).

Realtime voice comes first because those two routes already have a tool loop that goes through the registry. Text chat and background tasks wait for CAP-5.

### 4.5 Candidates for the first shipped skills

Combinations that existing tools can already do:

| Candidate | Services used | Description |
|---|---|---|
| Movie time | TV, home devices | Turn on the TV, open a chosen app, set the lights |
| Morning briefing | Weather, calendar | Say today's weather and schedule together |
| Before going out | Home devices, calendar | Check the lights and air conditioner, and remind about the next event |
| Cooking timers | Timers | Set several timers for one dish at once |

On 2026-11-24 George decided that SKL-1 starts with one skill, the morning briefing. These are candidates only. How far each one really works is known only after SKL-2 runs on the Mac.

## 5. Check against the product red lines and honesty rules

| Rule | How this proposal handles it |
|---|---|
| No App launcher, permanent sidebar, or Dashboard | Neither the catalog nor skills have a permanent screen. `/help/commands` is the existing help page that the user opens deliberately |
| Every Surface has a `visibility_reason` | The CAP-3 answer and the SKL-3 confirmation screen are both triggered by the current request |
| External side effects go through the Action Gate | A skill changes no tool's `effect` or confirmation method. `external_commit` is currently always refused, and this proposal does not touch it |
| Generated UI must not get a shell or the file system | A skill is text only. In SKL-3 the core writes the file and decides the path and file name. The model supplies only the name and body, with length and character limits |
| Mocks must be labelled | Every catalog entry carries `mock`. Mock tools are not listed in the table for people |
| No fake success | The live catalog reports what is unavailable and why. A skill is listed only when all its tools are available |
| The model cannot enable a tool by itself | Unchanged. Enabling still comes only from the core configuration |
| Feature convenience comes first at this stage | Both groups of batches exist to make adding features faster and to tell people what they can say. They add no permission mechanism |

Spotify voice control is still SP-2 BLOCKED. This proposal does not change that.

SKL-3 has one property to be aware of: a saved skill is "text that future model sessions will follow". So SKL-3 always shows the content first and saves only after the user confirms, and a skill cannot do anything the existing tools cannot do.

<a id="6-待-george-決定"></a>
## 6. For George to decide

1. **Batches and order**: do you agree with the CAP／SKL split and "CAP-1 → CAP-2 → SKL-1 → SKL-2 → CAP-3 → SKL-3"?
2. **First skills**: which two of the candidates in §4.5, or something else?
3. **Brain-region link**: should a "tool call" become a new source for the brain-region animation (each tool marked with a `domain` in the catalog)? CLAUDE.md currently says the source can only be a task step's `domain` or the conversation topic classification. This would be a rule change, so the default is not to do it.
4. **Skills saved by the household**: one shared set for the whole family, or one set per person (connected to family recognition)? The recommendation is to start with one shared set.
5. **Bilingual shipped skills**: `SKILL.md` is a procedure for the model. The recommendation is to provide files in both languages, as `.agents/skills/verify-aios` does, and have the model read the one that matches the interface language.
6. **The 9 page tools** (CAP-4): should they also enter the catalog? Then the command table has a single source, but `shared/voice-commands.ts` and its tests must change.

<a id="61-george-的決定2026-11-24"></a>
### 6.1 George's decisions (2026-11-24)

| Item | Decision | Effect on the batches |
|---|---|---|
| 1 Batches and order | Agreed | Follow CAP-1 → CAP-2 → SKL-1 → SKL-2 → CAP-3 → SKL-3. CAP-4 and CAP-6 come after these; their order is set later |
| 2 First skills | Start with the morning briefing | SKL-1 ships 1 skill, not the 2 written earlier |
| 3 Brain-region link | Yes | `ToolCatalogInfo` gains a `domain` field (CAP-1 only stores and checks the data). Wiring the animation is CAP-6. In CLAUDE.md, the sources listed under the owner-specified design requirements now include tool calls |
| 4 Skills saved by the household | One shared set first | SKL-3 does not connect to family recognition |
| 5 Bilingual shipped skills | Yes | Each skill has one file per language |
| 6 The 9 page tools | Include them | CAP-1 first makes the catalog able to list these 9 tools (data). Generating `ASK_THE_AI` from the catalog is CAP-4 |

The boundary for item 3: the source of a lit region must be a real tool-call event, not internal model activity. Nothing lights without a call.

<a id="7-數字的計算方式"></a>
## 7. How the numbers were calculated

- **32 tool IDs**: run `grep -rhoE '"app\.[a-z_]+\.[a-z_]+"' server/integrations/adapters | sort -u | wc -l` in `prototype/ambient-shell`. On 2026-11-24 at main `fd2198b` the result was 32. This counts strings, not runtime registrations. Once CAP-1 builds the static catalog, that catalog is the reference.
- **8 reviewed Adapters**: `KNOWN_ADAPTERS` in `server/integrations/index.ts` has 8 keys.
- **9 page tools**: `HOST_TOOL_NAMES` in `shared/realtime-route.ts` has 9 elements.
- **`capabilities()` has no caller**: `grep -rn "\.capabilities(" server src tests --include=*.ts` returns nothing after removing the unrelated `options.capabilities()` in `live-route.ts`.
- **No skill code**: `grep -rniE "skill|技能" server shared src --include=*.ts -l` returns nothing.

## 8. Sources (checked 2026-11-24)

Omarchy, the `quattro` branch of `omacom/omarchy`, MIT license:

- [repo](https://github.com/omacom/omarchy), [website](https://omarchy.org/)
- `bin/omarchy` (dispatch and catalog), `bin/omarchy-agent-skills-link` (skill linking)
- `agents/skills/command-metadata.md` (command metadata comments)
- `default/agents/skills/omarchy/SKILL.md` (shipped skill)
- `default/omarchy/omarchy-menu.jsonc`, `docs/menu.md` (menu)
- `manual/14-omarchy-cli.md`, `manual/17-ai.md`, `AGENTS.md`

Nous: the files listed in §2 of this document, plus [18](18_App_Integration_Layer_and_Spotify_2026-11.en.md), [23](23_Architecture_Review_2026-11.en.md), the [S8 validation record](validation/architecture-s8-tool-names-2026-11-10.en.md), and [06](06_Ambient_Voice_Gaze_Experience.en.md).
