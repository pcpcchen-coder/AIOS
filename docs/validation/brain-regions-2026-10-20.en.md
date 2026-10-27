<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-regions-2026-10-20.md) | [English](brain-regions-2026-10-20.en.md)

<a id="六腦區合併驗證"></a>
# Six-region brain merge validation

Validation ran on 2026-10-20, 15:33–15:34 Asia/Taipei. This batch merged `17147efa` from `claude/blissful-rubin-rbtgtk` into the existing ChatGPT conversation version `e3b1e5f` and expanded it to six functional regions. The brain still uses the same renderer.

<a id="結果"></a>
## Results

| Check | Result |
| --- | --- |
| `node scripts/check-pstack.mjs` | 172 upstream file hashes, 56 skill links for both clients, and role configuration pass. |
| `node scripts/verify-aios.mjs` | Type checking, 178 tests in 20 files, production build, and isolated mock HTTP journey pass. |
| Chromium browser validation | Nine scenarios pass, zero browser errors. Operates the actual built page; source and build hashes remain unchanged throughout. |
| Independent review | No provable correctness defect found; 55 separately run focused tests pass. |

The [mock HTTP report](brain-regions-2026-10-20/unit-and-http-report.json) records task creation, completed steps, persistence, explicitly simulated artifacts, and direct-chat SSE with a terminal event. These checks do not call real models.

<a id="瀏覽器情境"></a>
## Browser scenarios

The [browser report](brain-regions-2026-10-20/browser-report.json) contains request records, source and asset hashes, and these scenarios' results.

1. Speech does not start before login and microphone consent.
2. Each of six task domains lights its matching region and clears it on termination.
3. Each of six conversation topics is classified and displays its source.
4. Late old responses do not overwrite the current conversation or relight old topics.
5. Listening and speaking follow audio start, end, error, and restart events; stale callbacks are invalidated.
6. Push-to-talk also lights regions from actual audio events and clears them on error.
7. Background tasks, conversation topics, and listening can appear together; collapsing conversation retains background tasks.
8. Switching engines or resetting the account clears conversation activity while retaining background tasks.
9. Voice and typing share history; a stream without a terminal event displays an error.

Screenshot paths in the report retain their runtime `/tmp` locations. Original PNGs with the same names are saved in the `brain-regions-2026-10-20` directory beside this document.

| Region | Actual node count | Original screenshot |
| --- | ---: | --- |
| Language | 76 | [Language region](brain-regions-2026-10-20/partition-language-fixture.png) |
| Mathematics | 118 | [Math region](brain-regions-2026-10-20/partition-math-fixture.png) |
| Art | 97 | [Art region](brain-regions-2026-10-20/partition-art-fixture.png) |
| Auditory | 45 | [Auditory region](brain-regions-2026-10-20/partition-auditory-fixture.png) |
| Visual | 141 | [Visual region](brain-regions-2026-10-20/partition-visual-fixture.png) |
| Planning | 93 | [Planning region](brain-regions-2026-10-20/partition-planning-fixture.png) |

Counts come from classifying nodes in the same actual renderer, excluding the neutral cerebellum and brainstem. The [multiple-sources screenshot](brain-regions-2026-10-20/simultaneous-sources-fixture.png) shows task, topic, and listening activity together. The [visual-topic screenshot](brain-regions-2026-10-20/visual-topic-fixture.png) shows the topic-classification source.

<a id="對應版本與重跑方式"></a>
## Versions and rerun instructions

SHA-256 values recorded in the browser report follow. File hashing and aggregation are defined in `scripts/verify-regions-browser.mjs`.

| Directory | SHA-256 |
| --- | --- |
| `prototype/ambient-shell/src` | `9b23ba5ebed85b35e8aac6b19492e5dba7a92928fad459b3582e9ac20801d8cc` |
| `prototype/ambient-shell/shared` | `2d498de6998ba971974de2f3f968364c4bce3c1e46948841052959398933654c` |
| `prototype/ambient-shell/dist` | `ed7fc05ffe18fbdfaa91386fc54e914513e97c67e62803cdd99a2e484df71e23` |

Run `node scripts/verify-aios.mjs` from the repository root. If Playwright and Chromium are installed, also run `node scripts/verify-regions-browser.mjs --output /tmp/aios-regions-check`. Use `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` to specify existing installations.

To start the prototype, run `npm start` in `prototype/ambient-shell`. Changes are concentrated in `shared/domain.ts`, planner/executor domain propagation, `src/region-activity.ts`, brain rendering, conversation and audio events, and the associated tests and validation scripts. See the [brain-region integration design](../development/brain-regions.en.md).

<a id="尚未通過的實機檢查"></a>
## Hardware checks not yet passed

Browser validation uses fixtures only at account, model SSE, and browser speech API boundaries. Every screenshot is labeled simulated. This proves interface event handling and rendering. It does not validate a real OAuth account, model service, microphone, audio hardware, or camera. The six regions illustrate functional classification, not neural activity measurements.

The next gate uses the user's own ChatGPT account to test login, continuous speech, interruption, text fallback, and error recovery. The visual region currently displays relevant topics only; there is no camera or image-analysis pipeline yet. Earlier [ChatGPT conversation validation](chatgpt-conversation-2026-10-20.en.md) remains a historical record of the pre-merge version; this document records the current six-region version.
