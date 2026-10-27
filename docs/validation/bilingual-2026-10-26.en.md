<!-- bilingual: source=zh-TW -->

> [繁體中文](bilingual-2026-10-26.md) | [English](bilingual-2026-10-26.en.md)

<a id="中英文文件與-app網頁驗證"></a>
# Bilingual documentation and App/web verification

Date: 2026-10-26, Asia/Taipei. The owner requested English repository documentation, a standing bilingual requirement for subsequent agents, and bilingual App/web implementation. Existing uncommitted family memory work was preserved. This record does not accept memory, cameras, home devices, or real voice.

<a id="文件覆蓋與後續規則"></a>
## Documentation coverage and standing rules

All 58 existing project Markdown documents have complete Traditional Chinese and English versions. Chinese originals retain their paths with `.en.md` companions. Originally English Agent, skill, and evidence documents have `.zh-TW.md` companions. The new language guide and this record are also paired, plus one complete inline bilingual policy. Original code examples, commands, and evidence fences remain byte-identical. Prose, tables, limitations, and historical status are fully translated. Local Markdown links and section anchors in English documents were checked.

`AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/bilingual.mdc` record the owner's requirement. The [bilingual policy](../BILINGUAL.md), `scripts/check-bilingual-docs.mjs`, failure-case tests, and a GitHub Actions check were added. The check detects missing versions, broken language links, changed fences, and unreviewed content changes. Fingerprints do not replace human translation review.

Third-party `vendor/pstack` and registered symlinks remain unchanged. Pinned verification passed for 172 upstream hashes and 56 skills in each of two clients. Raw logs, JSON evidence, dependency manifests, and HTML design mockups are not rewritten; their project explanations are bilingual.

<a id="程式與畫面結果"></a>
## Code and UI results

- Full `node scripts/verify-aios.mjs` passed: 69 test files, 1,086 tests passed, one existing skip, type checks, frontend build, and isolated mock HTTP task / artifact / direct-conversation journeys.
- Five documentation-checker failure-case tests passed, covering missing translations, source-only edits, changed code examples, missing language links, orphaned translations, and incomplete inline policies.
- `scripts/verify-bilingual-ui.mjs` completed five journeys in the real built page with an isolated local mock core: Chinese / English settings and accessible copy, persistence after reload, switching without task cancellation or user-text changes, roundtrip switching and English commands, and readonly English help security headers. English settings and progress were checked for missed Chinese copy, preserving intentional bilingual language controls and user text.
- `scripts/verify-bilingual-desktop.mjs` used the real Electron development build with temporary `userData` and configuration for three journeys: native menu / renderer synchronization without reload, renderer choices saved to native preferences, and persistence after reload. Production App data was neither used nor modified.
- All nine existing `scripts/verify-regions-browser.mjs` regression journeys passed. The first pre-change run had two timeouts because the input was not focused. The harness now clicks empty canvas before Enter, without removing or weakening its assertions.
- English and Traditional Chinese macOS permission resources passed `plutil`, and desktop development content built successfully. Actual system permission prompts were not triggered to verify their language.

<a id="審查後修正"></a>
## Review fixes

Independent review and the full suite found issues that were fixed with regression coverage: locale for delayed ordinary-chat delegation, browser recognition restart and TTS locale, unsent family name and minor checkbox retention, double translation of transcripts and names, and late native settings responses. Only a generic greeting helper without a name parameter is exposed to the renderer. The existing privacy assertion that named sentences are composed only in the core still passes.

Locale IPC accepts only the main window, main frame, and exact local-core origin. Tests explicitly whitelist the added readonly locale field and change subscription; family management continues through its existing identity IPC. English confirmation must name an action. `yes` / `okay` do not authorize one. Rejection takes priority, and unconfirmed devices are not translated into success.

<a id="證據與未驗證範圍"></a>
## Evidence and remaining scope

See [summary.json](./evidence/bilingual-2026-10-26/summary.json). Every screenshot is labeled fixture / mock, without a real account, audio, or camera feed.

| View | Traditional Chinese | English |
|---|---|---|
| Web settings | [Chinese](./evidence/bilingual-2026-10-26/web-zh-TW.png) | [English](./evidence/bilingual-2026-10-26/web-en.png) |
| App accounts and settings | [Chinese](./evidence/bilingual-2026-10-26/app-zh-TW.png) | [English](./evidence/bilingual-2026-10-26/app-en.png) |

This batch did not publish, push, or install a new production App. Older downloads do not acquire the feature automatically. Real English recognition and speech quality, model response language, AR0144, family-recognition accuracy, and home-device outcomes need separate acceptance. These tests do not pass G0–G3. See the [language guide](../development/localization.en.md) for use and builds.
