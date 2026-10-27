<!-- bilingual: source=zh-TW -->

> [繁體中文](localization.md) | [English](localization.en.md)

<a id="app-與網頁的中英文支援"></a>
# Chinese and English support in the App and web interface

Date: 2026-10-26. This batch adds Traditional Chinese and English to the existing `prototype/ambient-shell`, without building a second App. See the [bilingual policy](../BILINGUAL.md) for documentation requirements and the [validation record](../validation/bilingual-2026-10-26.en.md) for verified scope.

<a id="切換語言"></a>
## Change the language

- Web: type “設定” or `settings`, then select 繁體中文 or English under Language / 語言.
- macOS App: use 語言 / Language in the menu bar or App menu, or change it on Accounts and sign-in.
- The default is Traditional Chinese. Web preferences use the current origin's `localStorage` (`nous.locale`). The App uses its own `desktop.json` and retains the choice after reload or a core port change.
- The interface updates immediately without reloading the main window, cancelling tasks, or rewriting existing conversations, artifacts, names, or device names. App and web share the frontend. Separate browser origins retain independent preferences; this does not add cross-device synchronization.
- New conversations and delegated work use the language selected at start. Active voice, replies, delayed delegation, and failure retries retain their original language. Changing the interface does not change them to another language.
- macOS selects the language of microphone and camera permission descriptions. Packages provide `en.lproj` and `zh-Hant.lproj`. The in-app preference does not override system prompt language.

<a id="英文指令"></a>
## English commands

Fixed English commands must be complete short phrases. Existing Chinese commands remain valid.

| Purpose | English examples |
|---|---|
| Open settings | `settings`, `open settings` |
| View progress / results | `show progress`, `show results` |
| Stop a task / dismiss a view | `stop task`, `dismiss` |
| Enable / disable voice | `turn on voice mode`, `turn off voice mode` |
| Select an engine | `use Claude`, `use ChatGPT`, `use mock` |
| Camera preview | `show camera preview`, `hide camera preview` |
| Camera and sensing toggles | `turn off camera`, `enable look to talk`, `disable palm stop` |
| Answer the current confirmation card | `confirm execution`, `cancel action` |

`yes`, `okay`, and `confirm` alone do not authorize an action. Negative or rejecting content is not approval. Expired, dismissed, or replaced confirmation cards still do not execute. Existing routing differences between realtime speech and typing remain. The full table is available locally at `/help/commands?lang=en`. It preserves exact Chinese command examples and translates their explanations.

<a id="維護翻譯"></a>
## Maintain translations

`shared/i18n.mjs` provides browser-independent locale normalization and translation. `shared/messages.en.json` holds shared statuses, units, and settings copy. Frontend, server, and native desktop each have `messages.en.json` and use the same formatter. `src/i18n.ts` manages preferences and change notifications. Native packaging embeds shared and server copy together with its wrapper.

Add the full Traditional Chinese source and English value together. Use `{0}`, `{1}`, and similar placeholders for dynamic values. Append translated results directly to text nodes without translating the entire result again. Preserve user input, model responses, names, device names, and artifact content. Do not localize by scanning the whole DOM and replacing arbitrary text.

`X-Nous-Locale` accepts known languages only and falls back to Traditional Chinese for unknown values. Each request, task, and realtime session owns its locale. Do not use a global variable to switch every user's language. Language grants no additional tools or identity permissions. Core origin, owner, confirmation, and privacy checks still apply.

Update both document versions together. After review, run `node scripts/check-bilingual-docs.mjs --record`, then `node scripts/check-bilingual-docs.mjs`. Full development verification remains `node scripts/verify-aios.mjs`. Actual UI checks use `scripts/verify-bilingual-ui.mjs` and `scripts/verify-bilingual-desktop.mjs`, requiring built frontend / desktop content and installed Playwright, with Chrome and Electron respectively.

This batch does not install or replace the user's production App or publish a release. Build current source through the [desktop guide](../../prototype/ambient-shell/desktop/README.en.md) to use the new behavior. Real English recognition, speech quality, model language adherence, home devices, and cameras need separate hardware checks. Automated fixtures do not pass G0–G3.
