<!-- bilingual: source=zh-TW -->

> [繁體中文](brain-regions.md) | [English](brain-regions.en.md)

<a id="擴充電子腦功能區"></a>
# Extend the electronic brain's functional regions

This document preserves the design and validation scope of the six-region merge batch. Its voice description mainly covered browser STT, text streaming, and TTS. It does not accept later realtime voice or camera interaction. See [current implementation status](../Current_Implementation_Status.en.md), [realtime voice validation](../validation/live-voice-2026-10-23.en.md), and [feature expansion assessment](../13_Feature_Expansion_Assessment_2026-10-24.en.md) for the latest scope.

This batch merges `17147ef` from `claude/blissful-rubin-rbtgtk`, preserves ChatGPT voice and text conversation, and expands language, mathematics, and art from three regions to six by adding auditory, visual, and planning regions.

<a id="判讀動畫"></a>
## Interpret animation

A lit region represents current application activity or content classification. The display identifies the source, such as “Visual region · topic classification,” “Auditory region · microphone capture,” or simulated task steps. This is not internal neural activity and does not imply complete human senses.

Task planning lights the planning region. Subsequent activity follows the running step's `domain`. Concurrent background tasks may activate different regions. Terminated tasks no longer contribute activity.

Voice and text share one `ConversationSession`. Only the valid conversation currently awaiting a reply supplies topic activity. After reply completion, the language region may continue reflecting actual computer speech playback. Capture is determined separately by browser audio-start/end events, never inferred from opening an input or toggling voice mode.

The visual region may show an image-related conversation topic. Without a camera stream or image analysis, do not display it as currently watching. Unknown topics can remain neutral rather than force classification for animation. Later camera pipelines emit presence, head-facing, palm-stop, and arm-pointing events. These still are not eye-gaze tracking. Distance uses nominal stereo parameters without complete hardware calibration. Such events also do not establish that the model understands camera content.

<a id="維持一份設定"></a>
## Maintain one configuration

IDs, names, colors, and classification information for all six domains live in `prototype/ambient-shell/shared/domain.ts`. Model-planning enums, prompts, and frontend display derive from that configuration.

Activity is projected from state owned by conversations, tasks, and audio. There is no second `chatDomain` or separate activity lifecycle. This applies Model the Domain by replacing scattered conditions with one configuration and source-bearing activity data.

The design comparison selected centralized configuration plus pure state projection, adding real audio events and simulated-source labels. It introduced no generic activity repository or multi-topic analysis engine. Concurrent tasks, conversations, and audio already express multi-region activity.

<a id="驗證來源"></a>
## Validation sources

Run `node scripts/verify-aios.mjs` from the repo root for type checking, tests, build, and isolated mock HTTP journeys. Browser validation operates the actual built page, using fixtures only at account, model, and audio-service boundaries. Screenshots and reports must identify mock scope, never claiming actual account, microphone, speaker, or camera validation.

With Playwright and Chromium installed, run `node scripts/verify-regions-browser.mjs --output /tmp/aios-region-verification`. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can point to existing installations. Build first and do not modify sources or rebuild during validation, so source and asset hashes in the report describe the same version.
