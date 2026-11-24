<!-- bilingual: source=zh-TW -->

> [繁體中文](adding-an-adapter.md) | [English](adding-an-adapter.en.md)

# How to add an Adapter or a tool

Version: 2026-11-24 (CAP-1). Applies to `prototype/ambient-shell`. For people and development agents working in this repo. Design background is in [18 App Integration Layer](../18_App_Integration_Layer_and_Spotify_2026-11.en.md) and [24 Capability catalog and skills directory](../24_Capability_Catalog_and_Skills_2026-11.en.md); this batch's validation is in the [CAP-1 validation record](../validation/cap-1-capability-catalog-2026-11-24.en.md).

All paths below are under `prototype/ambient-shell/`.

## 1. Decide which kind of tool it is

| | Integration tool (recommended) | Page tool |
|---|---|---|
| Name | `app.<service>.<action>`; the model sees `app__<service>__<action>` | Its own name, listed in `HOST_TOOL_NAMES` in `shared/realtime-route.ts` |
| Who runs it | The core Dispatcher (the same on both realtime voice routes) | The page's tool executor |
| What to change | One Adapter file, `index.ts`, `catalog.ts`, the translation table | The 5 steps listed in section 6 |

Make every new service an integration tool. Keep page tools for work that must run in the page (for example, search results on screen).

## 2. Add a new Adapter

1. Add `server/integrations/adapters/<name>.ts`. Declare `const TOOLS: readonly ToolDefinition[]` at **module level**; do not build it inside the `tools()` method. The static catalog must read these definitions without creating the Adapter: when configuration is missing the factory returns `null`, and the running registry never sees that Adapter.
2. Fill in every field of each tool:
   - For the model: `description` (Chinese) and `descriptionEn`, `inputSchema`, `effect`, `enabled`, `timeoutMs`, `supportedRoutes`.
   - For people: `catalog`, written as described in section 4. `catalog` is required; `tsc` fails without it.
3. Export the static descriptor from the same file:

   ```ts
   export const EXAMPLE_CATALOG: AdapterCatalog = { id: "example", service: "example", label: "範例服務", mock: false, tools: TOOLS };
   ```

   `id` and `service` must equal the Adapter class's `id` and `service` (a test compares them). Set `mock` to `true` (always a mock), `false`, or `"config"` (depends on configuration; for example, `voice_relay` is a mock when `NOUS_VCR=fake`).
4. When a tool's schema depends on configuration (for example, the speaker `enum` in `voice_relay`), declare the configuration-free part as a `CatalogTool` constant inside `tools: [...]`, and have `tools()` add the schema to build the full definition. Follow `RELAY_TOOL_STATIC` in `adapters/voice-relay.ts`.
5. Implement `IntegrationAdapter` in the class: `tools()` returns `TOOLS`; `health()` returns only fixed reason codes; `execute()` always returns results through `toolResult()`. Only a confirmed readback is `confirmed`; sent without a readback is `unconfirmed`; a timeout or unknown outcome is `unknown`.
6. Add a factory to `KNOWN_ADAPTERS` in `server/integrations/index.ts`. Return `null` when configuration is missing, and use `log` to say which setting is missing. Built-in tools that do not go through `NOUS_AIL_SERVICES` (timer, alarm) are passed in through `createIntegrations`'s `builtins` instead, with `builtin: true` in their static descriptor.
7. Add `EXAMPLE_CATALOG` to `ADAPTER_CATALOGS` in `server/integrations/catalog.ts`. If you forget, `tests/capability-catalog.test.ts` fails: it requires the list to equal `KNOWN_ADAPTERS` plus `timer` and `alarm`.
8. Add English for the service name, each `summary`, each example and each `needs` to `server/messages.en.json`. The key is the Chinese source text.
   - First make sure the same text is not in `src/messages.en.json` or `desktop/messages.en.json`. The page and the desktop App load the server table first and then their own, so for the same key their own table wins.
   - Also do not let a new key happen to equal text elsewhere in the UI that is looked up for translation but was deliberately left untranslated.
9. Tests:
   - Write fixture tests for the Adapter itself (a fake external service, no network).
   - Add an instance of the Adapter to `modelToolAdapters()` in `tests/fixtures/model-tools.ts`.
   - The model will see a new tool, so `tests/fixtures/model-tools.baseline.json` must change. In `prototype/ambient-shell`, run `npx tsx scripts/write-model-tools-baseline.ts --model-tools` to regenerate it, and say in the PR that the change is deliberate. Do not rerun it when you only change catalog text; then the test's job is to prove that what the model sees did not change.
10. Run the checks in section 5.

## 3. Add a tool to an existing Adapter

Add an entry to that Adapter's `TOOLS` with every field from section 2 step 2 and its English translations, then regenerate the model-tool baseline as in section 2 step 9 and run the checks in section 5. The Registry rejects IDs outside the Adapter's service, duplicate IDs, unsupported schemas, and invalid timeouts or routes.

## 4. Writing the catalog fields

| Field | Rule |
|---|---|
| `summary` | One sentence: what the tool does for the user. Address the user as "you" and do not write instructions for the model (that is what `description` is for). State limits as they are, for example "the TV does not report playback state" or "the result is at most sent, unconfirmed" |
| `examples` | At least one. Read what `execute()` actually does first: each must be something a user would really say and the tool can really do. Do not guess from the tool name. Page-tool examples come from `ASK_THE_AI` in `shared/voice-commands.ts` (a test compares them) |
| `needs` | Preconditions, such as environment variables to set or pairing first. Leave it out when there are none; do not write an empty string |
| `domain` | The brain region a real tool call should light (George's decision 3 of 2026-11-24; the animation wiring is CAP-6). The value is a region ID from `shared/domain.ts`, or an explicit `null`, meaning no region applies and nothing lights up for the call |
| `hidden` | Mock tools and legacy Facade tools must have `hidden: true` and are left out of the human-facing table. The check rejects any that are not marked |

How `domain` is currently assigned (CAP-1's choice; it can be revised before CAP-6 wires the animation):

| Region | Used for |
|---|---|
| `language` | Text and conversation: sending email, answering after a web search, ending the conversation |
| `math` | Reading numbers and data: weather, home sensor values |
| `art` | No tools yet |
| `auditory` | Sound: TV volume and mute, how loudly Nous speaks, voice relay |
| `visual` | The screen: TV power, input, apps, playback; search results on screen; day/night mode |
| `planning` | Time and arrangements: timers, alarms, calendar, delegated tasks |
| `null` | No fitting region: appliance control, mock tools, the confirmation card |

Brain regions are symbolic categories, not the model's neural activity. `domain` is only data; nothing may light up without a real tool call.

## 5. Checks before delivery

In `prototype/ambient-shell`:

```bash
npm run catalog -- --check
npm run catalog -- --markdown
npm run catalog -- --json
npm run typecheck
npx vitest run tests/capability-catalog.test.ts
```

`--check` fails on a missing summary or example, missing English, an invalid `domain`, an ID collision, or a mock/Facade tool not marked hidden; `--markdown` prints the human-facing table and `--json` the static catalog, and both accept `--lang en` for English.

At the repo root: `node scripts/verify-aios.mjs`, `node scripts/check-bilingual-docs.mjs`.

`--check` and `tests/capability-catalog.test.ts` share `checkCatalog()`. These are fixtures and type checks; they cannot be used to claim real voice or a real service has been validated.

## 6. Add a page tool

Follow the 4 steps in "what to change when adding a page tool" in the [S8 validation record](../validation/architecture-s8-tool-names-2026-11-10.en.md), then add a fifth:

5. Add an entry to `HOST_TOOL_CATALOG` in `server/integrations/catalog.ts` (the type requires an entry for every name in `HOST_TOOL_NAMES`, so `tsc` fails if one is missing). Take the examples from the sentences you put in `ASK_THE_AI`, and add the English to `server/messages.en.json`.

In CAP-1, `/help/commands` is still generated from `ASK_THE_AI` and `TIMER_ASK`; generating it from the catalog is CAP-2 and CAP-4 work.

## 7. What not to do

- Do not load third-party code dynamically; Adapters are registered only in code. The model has no way to add, enable or configure a tool.
- Spotify voice control is still SP-2 BLOCKED: the Registry rejects every `app.spotify.*` tool.
- `external_commit` needs a confirmation each time; the confirmation card is not wired yet, so it is currently always refused. The only exception is listed in `CONFIRMATION_EXEMPT_TOOLS` in `server/integrations/policy.ts` (sending email to yourself, George's decision of 2026-11-04). Do not add an exception for a new tool unless the user explicitly decides so.
- Do not add an App launcher, icon, persistent sidebar or Dashboard for a tool.
- Catalog fields must not reach the model's schema. `functionSpecs()` takes only `description` and `inputSchema`, and a test compares the output byte for byte.
