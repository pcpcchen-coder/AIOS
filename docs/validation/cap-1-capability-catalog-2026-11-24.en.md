<!-- bilingual: source=zh-TW -->

> [繁體中文](cap-1-capability-catalog-2026-11-24.md) | [English](cap-1-capability-catalog-2026-11-24.en.md)

# CAP-1 capability catalog validation

Date: 2026-11-24 (Asia/Taipei). Branch: `claude/cap-1-capability-catalog`, based on `claude/amazing-babbage-us2i3o` (the [docs/24](../24_Capability_Catalog_and_Skills_2026-11.en.md) proposal, PR #151, not yet merged); main is `fd2198b`. The scope is CAP-1 from [24 §3.3](../24_Capability_Catalog_and_Skills_2026-11.en.md#33-batches), plus decision 3 (the `domain` field, data only) and decision 6 (the catalog can list the 9 page tools, data only) from [§6.1](../24_Capability_Catalog_and_Skills_2026-11.en.md#61-george-的決定2026-11-24).

**This whole batch is fixtures and type checks in a cloud container. It is not a product gate and not a Mac acceptance test.** There is no real voice and no real service. Voice behaviour, `/help/commands`, the settings screen and the tool JSON sent to the model are all unchanged; section 4 has the evidence.

## 1. Environment

| Item | Value |
|---|---|
| Machine | Linux cloud container (not a Mac, not a Pi) |
| Node | v22.23.5 |
| Install | `npm ci` in `prototype/ambient-shell` (from `package-lock.json`; no package added or upgraded) |
| External services | None connected; every Adapter dependency is a test double |

## 2. What was delivered

Paths are under `prototype/ambient-shell/`.

| Item | Content |
|---|---|
| Types | `server/integrations/contracts.ts`: `ToolCatalogInfo` (`summary`, at least one `examples` entry, optional `needs`, `domain`, optional `hidden`); `ToolDefinition.catalog` is required; `CatalogTool` (the part the static catalog needs, without `inputSchema`); `AdapterCatalog` (`id`, `service`, a human-facing service name `label`, `mock`, `builtin`, `tools`) |
| Tool data | All 32 tools in the 10 Adapter files have catalog data; the examples were written after reading each `execute()`. The mock tools (2) and the legacy Facade tools (`app.home.*`, 3) are marked `hidden` |
| Module-level constants | All 10 files export a `*_CATALOG`. `weather.ts` and `lg-tv.ts` used to build their definitions inside the `tools()` method; they moved to a module-level `TOOLS` (content unchanged). The `voice-relay.ts` schema depends on the speaker catalog, so only its configuration-free part moved, into `RELAY_TOOL_STATIC` |
| Page tools | `HOST_TOOL_CATALOG` in `server/integrations/catalog.ts`: the 9 tools in `HOST_TOOL_NAMES`, and the type allows none to be missing; examples come from `ASK_THE_AI`. `ASK_THE_AI` and `/help/commands` were not changed |
| Catalog | `staticCatalog()` (no configuration needed); `liveCatalog(registry)` (adds `configured` and the `CapabilityStatus` for both voice routes); `localizeCatalog()`; `checkCatalog()`; `catalogMarkdown()` |
| English | 127 new keys in `server/messages.en.json`, read through `localize()`; no separate English fields |
| Developer command | `npm run catalog -- --json | --check | --markdown` (optionally `--lang en`), in `scripts/catalog.ts` |
| Tests | `tests/capability-catalog.test.ts`, 23 cases; baselines `tests/fixtures/model-tools.baseline.json` and `tests/fixtures/commands-page.baseline.json`, with `scripts/write-model-tools-baseline.ts` that produces them |
| Docs | [How to add an Adapter or a tool](../development/adding-an-adapter.en.md) (both languages), this record (both languages), and the App Integration Layer row of [current implementation status](../Current_Implementation_Status.en.md) |

**Difference from 24 §3.3**: the proposal says `registry.catalog()`. The implementation is `liveCatalog(registry)` in `catalog.ts`: the catalog has to read all 10 Adapter modules, and putting it in `registry.ts` would make the registry import every Adapter, reversing the dependency direction. `registry.capabilities()` still has no callers; this batch did not touch it.

## 3. Commands and results

In `prototype/ambient-shell`:

| Command | Result |
|---|---|
| `npm run catalog -- --check` | `能力總表檢查通過：41 個工具（36 個列在給人看的表、5 個 hidden）` (catalog check passed: 41 tools, 36 in the human-facing table, 5 hidden), exit code 0 |
| `npm run typecheck` | 0 errors (`tsc` includes `tests/`) |
| `npx vitest run tests/capability-catalog.test.ts` | 1 file, 23 passed |
| `npx vitest run` | 181 files, 3,399 passed, 6 skipped (3,405 total) |

At the repo root:

| Command | Result |
|---|---|
| `node scripts/verify-aios.mjs` | PASS (type check; 181 files with 3,399 passed and 6 skipped; build; isolated mock HTTP flow with 8 checks). The Pi `ssh-keygen` dry run was skipped because the container does not have it installed; it was skipped before this change too |
| `node scripts/check-pstack.mjs` | Passed: `pstack 0.15.29: 172 upstream hashes, 56 skills in both clients, agents and model roles verified.` |
| `node scripts/check-bilingual-docs.mjs` | `--record` after reviewing both versions, then a rerun passed: 150 documents, 149 complete pairs, 1 inline policy |

## 4. Gate evidence

### 4.1 The tool JSON sent to the model is byte-for-byte identical

Method: first generate a baseline on **unchanged** code and commit it on its own (`0ef8773`), and only then change the code.

- `tests/fixtures/model-tools.ts` registers all 10 reviewed Adapters (with test doubles, all enabled) and produces 26 outputs:
  - `functionSpecs()`: the `api_key` and `live` routes × the `zh-TW` and `en` locales × the `fake` and `mac` modes of `voice_relay`, 8 outputs.
  - `buildRealtimeTools()` (the tool table in `server/realtime.ts`, including `REALTIME_TOOLS`, `home_status`/`home_control` and `recall_memory`): the same 8 combinations × with or without web search, 16 outputs; plus one per locale without the integration layer, 2 outputs.
  - 8 + 16 + 2 = 26.
- `tests/capability-catalog.test.ts` compares the current output with the baseline string by string; all 26 are identical.
- Another test checks that every function spec is exactly `{ type, name, description, parameters }`, where `description` and `parameters` are the original `description`/`descriptionEn` and `inputSchema`.
- After the catalog fields were added, the baseline was regenerated once and did not change (`git diff` showed no difference).

### 4.2 `/help/commands` and the README command table are unchanged

The new translation keys go into the shared translation table and could change English elsewhere. So **before** adding the translations, `tests/fixtures/commands-page.baseline.json` was generated separately (the Chinese and English pages from `renderCommandsPage`, plus `renderCommandsMarkdown()`) and committed on its own (`830d2f2`). After the translations were added, all 3 outputs are identical to the baseline.

Key collisions were also checked by hand: none of the 127 keys is in `shared/messages.en.json` or the previous `server/messages.en.json`. 「定時器」 (timer), 「鬧鐘」 (alarm) and 「貪睡」 (snooze) are already in `src/messages.en.json` or `desktop/messages.en.json`; the page and the desktop App load the server table first and then their own, so for the same key their own table wins and the screens do not change. 「再見」 (goodbye) appears in `LOCAL_GOODBYES` in `src/live-voice.ts` only for matching speech and is never translated.

### 4.3 The settings screen is unchanged

The settings screen's `integrations.tools` takes only the function names from `functionSpecs("api_key")`, which 4.1 covers. This batch did not change `server/app.ts`, `server/routes/settings.ts` or any file in `src/`.

### 4.4 The check fails when it should

`tests/capability-catalog.test.ts` plants one error at a time into `checkCatalog()` and confirms the matching problem is reported: a blank summary, no examples, a blank example, a summary without English, an example without English, needs without English, an invalid `domain`, two tools with the same ID, a page tool named like an integration tool's function name, a service name without English, and a mock or Facade tool not marked `hidden`.

## 5. How the numbers were calculated

| Number | How |
|---|---|
| 32 integration tools | The sum of `tools.length` over `ADAPTER_CATALOGS`; the test also requires it to equal 32. Cross-checked with the command from [24 §7](../24_Capability_Catalog_and_Skills_2026-11.en.md#7-數字的計算方式), `grep -rhoE '"app\.[a-z_]+\.[a-z_]+"' server/integrations/adapters | sort -u | wc -l`, which gives 32 |
| 9 page tools | The length of `HOST_TOOL_NAMES`; the test requires the catalog's page tools to equal it in order |
| 41 tools | 32 + 9, the output of `npm run catalog -- --check` |
| 5 hidden | `app.mock.echo`, `app.mock.toggle`, `app.home.status`, `app.home.control`, `app.home.confirm`, listed one by one in the test |
| 36 in the human-facing table | 41 − 5 |
| 127 translation keys | The difference in key count between the old and new `server/messages.en.json`: 788 − 661. 126 are catalog text (11 service names, 41 summaries, 65 distinct examples, 9 distinct needs) and 1 is the last line of `--markdown` |
| `domain` distribution | planning 17, visual 9, auditory 4, math 3, language 3, `null` 5; counted from the output of `npm run catalog -- --json` |
| 26 baseline outputs | See 4.1 |

## 6. What was not done (stated as it is)

- **Not a product gate and not a Mac acceptance test.** No real voice, and no real TV, calendar, Gmail, weather or speaker.
- `domain` is data and a check only; it is not wired to the brain-region animation (CAP-6).
- `ASK_THE_AI`, `TIMER_ASK` and `/help/commands` are not generated from the catalog yet (CAP-2, CAP-4). The TV, calendar, email and weather rows are still missing from the command table.
- The live catalog is only a function; there is no HTTP endpoint and the model does not see it (CAP-3).
- Page tools carry no capability status in the live catalog: it depends on the realtime voice route's capabilities (web search, the hub), which CAP-1 does not derive.
- No skills (SKL-*), no new permission or safety mechanism, no persistent UI; Spotify is still SP-2 BLOCKED with no tools.

## 7. For George to decide

- `domain: null` is used for appliance control (`home_control`, `app.home.control`), the appliance confirmation card and the mock tools: no region fits, so nothing lights up for those calls. If you want appliance control to light a region, tell us which one before CAP-6.
- Weather and home sensor values are in the math region (reading numbers and data); day/night mode and search results on screen are in the visual region. This is CAP-1's choice and can change before CAP-6 wires the animation.
