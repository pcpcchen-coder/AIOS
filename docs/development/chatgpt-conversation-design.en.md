<!-- bilingual: source=zh-TW -->

> [繁體中文](chatgpt-conversation-design.md) | [English](chatgpt-conversation-design.en.md)

<a id="電子腦-chatgpt-對話設計"></a>
# Electronic-brain ChatGPT conversation design

This document records the browser STT, streamed text, and TTS conversation batch from 2026-10-20. API-key Realtime and Codex live routes were added later. Do not infer latest voice capabilities or acceptance from this document. See [current implementation status](../Current_Implementation_Status.en.md), [feature expansion assessment](../13_Feature_Expansion_Assessment_2026-10-24.en.md), and [2026-10-23 realtime voice validation](../validation/live-voice-2026-10-23.en.md).

The Continue with ChatGPT text engine and Codex realtime voice use different login flows. Actual authorization and inference for the former are unverified. The latter has partial login/call logs from the home Mac and a verbal report of successful temperature queries after a fix, without complete end-to-end or billing acceptance. The following preserves the original design and test coverage.

<a id="需求與範圍"></a>
## Requirements and scope

Users converse through the electronic brain using their signed-in ChatGPT account. Voice is primary, with interruption anytime and text as a fallback in the same conversation. The brain remains the main visual, with login, settings, and replies appearing only as needed.

Extend `prototype/ambient-shell`, reusing account login, streamed `/api/chat`, and background tasks. Voice uses browser recognition and computer speech. Real ChatGPT authorization, model replies, and physical microphone/speaker behavior require separate validation.

<a id="使用方式"></a>
## Usage

Click the brain or explicitly start conversation. Show existing ChatGPT settings when login is needed. After login, the user starts voice again and consents to capture. OAuth callbacks never start the microphone automatically.

Voice and text both call `ConversationSession.send`. Text continues the same history after microphone disablement or denial. Interruption aborts current generation and playback. Closing conversation stops foreground capture, generation, and playback while background tasks continue.

<a id="狀態與責任"></a>
## State and responsibility

`src/conversation.ts` solely owns history, current reply, cancellation, and visibility. Preserve user/assistant pairs. Before submission, remove the oldest complete turns by UTF-8 byte count. Main connects input, account settings, views, and audio only.

Before a new turn, invalidate the old turn, then cancel transport and audio. Every asynchronous callback must belong to the current turn. An interrupted partial reply may remain, labeled interrupted. Old-request finalizers never append history. Engine or account changes clear old conversation. History exists only in page memory and clears on reload or logout. It differs from tasks and artifacts persisted in `data/`.

`VoiceConversation` retains audio-device responsibility. Brain conversation state derives from actual capture, waiting for a model, and real speech-playback events. Enqueueing TTS does not mean playback started. Background-task progress is computed separately from task state.

Current replies carry real `request_id` and `visibility_reason=user_request`. Late chunks cannot reopen a dismissed view. Settings, progress, and artifact views retain Shell and Presentation Policy.

Streams end only after completion or error events. Early EOF and model `response.incomplete` show failed or incomplete state, never success.

<a id="設計比較與選擇"></a>
## Design comparison and selection

Two independent designs both selected a single conversation module. Reviewer and implementer inherited the same model. This comparison is not cross-model consensus.

| Option | Core structure | Tradeoff |
| --- | --- | --- |
| A, adopted | One `ConversationSession` managing turns and side effects | Small interface directly owns history, cancellation, and streaming. |
| B | Same session plus an internal event-transition function | More explicit events, but this scale does not need another transition layer. |

Adopt A with two constraints from B: explicit microphone activation after login, and suppression of old conversations when another local view opens. Retain the Shell reducer rather than combine background tasks and temporary chat in one state machine.

This applies pstack Model the Domain and Laziness Protocol. Under Prove It Works, validation separately records unit tests, browser operation of the actual built page, mocked external services, and incomplete real-account/hardware testing.
