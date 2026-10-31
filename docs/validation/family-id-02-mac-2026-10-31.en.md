<!-- bilingual: source=zh-TW -->

> [繁體中文](family-id-02-mac-2026-10-31.md) | [English](family-id-02-mac-2026-10-31.en.md)

# ID-02 family greeting by name: Mac acceptance record (2026-10-31, partial)

Run per [Mac acceptance runbook](mac-acceptance-runbook-2026-10-30.en.md) §6 and [ID-02 §5](family-id-02-2026-10-25.en.md). Only George was present in this round, so steps 2, 4 and 5 (which need a second person) and step 7 (deleting a family member) are scheduled for later. Problems found during the test were fixed on the spot and merged as PR #57 and #58.

## Environment

| Item | Value |
|---|---|
| Mac | Mac mini (Mac18,5), Apple M6, 32 GB |
| macOS | 27.0.1 (26A434) |
| Electron | 44.9.3 |
| App build commit | `9c67e65` at the start; fixes `29f4238`, `162d842` (PR #57); calibration `7cc99f6` (PR #58); final install `9fff86d` (main) |
| Signing | ad-hoc until about 01:30Z; then the fixed identity `Nous Local Signing` (certificate created by George) |
| Enrolled family | 2 (including George); thresholds uncalibrated |
| Method | Claude read page subtitles and `[看著說話時序]` through computer use and DevTools (`--remote-debugging-port`), plus `問候決策` in `nous.log`; George moved, spoke and reported the sentences he heard |
| Time | 2026-10-31 00:33–03:12Z (Taiwan 08:33–11:12); ChatGPT plan steps 3, 6 and 9 at 02:56–03:07Z |

## Results

Routes: "API key" = OpenAI API key (gpt-realtime-mini); "ChatGPT plan" = gpt-live-1-codex.

| Step | Route | Expected | Actual | Evidence | Result | Notes |
|---|---|---|---|---|---|---|
| 1 Named opening | API key | A listed named sentence, said once, nothing added | 9 tries: `ok` 4 (3 verbatim, e.g. "George，我在。", "George，你好"; 1 became "好的，我明白了，我會照您說的來：George，我在。"); `not_eligible` 4 ("你好", "我在"; one became "好的，我明白了。那麼我們就接下來可以開始。"); no decision 2 | `問候決策` 00:33–00:41Z | **Fail** | The model rewrote or added words twice (F1); for `not_eligible` see F4 |
| 1 Named opening | ChatGPT plan | Same | Before calibration only 5 of 27 decisions named George (mostly `not_eligible`, `no_face`, `quality`; never `unknown`); after applying calibration all 4 named him with listed sentences ("嗨，George", "我在這，George", "George，我在。", "早安，George。"), each with 18–20 consecutive good frames; the first look after an App restart also named him | `問候決策` 01:37–02:39Z | Pass (after calibration) | Result after fixing F4 and F5; no rewriting seen |
| 2 Stranger | Both | Only "我在", log `unknown`／`collecting`／`no_evidence` | — | — | Not done | Needs a second person; scheduled later |
| 3 Speak first | API key | No greeting, a direct answer, no `問候決策` | Spoken 5 times: 2 answered directly (no decision); 3 said "我在" or "嗨，我在" first. Typed twice: both answered directly | 00:42–00:49Z | **Partly failed** | Speech during "connecting" is not heard (F2) |
| 3 Speak first | ChatGPT plan | Same | Spoken 4 times, the greeting played every time ("早安。", "George，你好。", "George，我在。"). Speech during "connecting" was not heard; once the user spoke after voice ready and before the greeting decision, and the greeting still played | 02:56–02:59Z | **Fail** | F2, F10; George finds it acceptable. Typed variant not done |
| 4 Person switch | Both | George is never said | — | — | Not done | Needs a second person |
| 5 Several people | Both | No name, log `multi_face` | — | — | Not done | Needs a second person; two faces were briefly seen twice during measurements |
| 6 Naming off | API key | Only "我在"-style sentences, log `naming_off`, no extra recognition | 2 × `naming_off` with 0 evidence frames; said "你好。" and "嗨，我在" | 00:49–00:50Z | Pass | |
| 6 Naming off | ChatGPT plan | Same | 4 × `naming_off` with 0 evidence frames; said "午安。", "我在。", "嗨，我在。", "我在。" | 03:00–03:02Z | Pass | |
| 7 Delete George | Both | Only "我在" after restart | — | — | Not done | Ask George first (backup in `~/Nous-backup-20261031-080317`) |
| 8 Timing | Both | Median of ≥ 5 per route; compare naming on and off | API key (51): interaction start 2823 ms, voice ready 5047 ms, greeting decision 5676 ms, first audio 6494 ms. ChatGPT plan (54): 2826 / 4576 / 5198 / 6575 ms. With naming off, interaction start was 2725–2826 ms, no different from naming on | `[看著說話時序]`, facing confirmed = 0 | Done | Occasional outliers when the voice connection was slow (longest first audio about 30 s) |
| 9 Palm stop | API key | 10 before the greeting, 10 during an answer; record CPU | Before the fix it never stopped. After the fix, 5 of 5 raises during an answer stopped it, in about 0.2–1.0 s; the before-greeting set was not repeated. CPU (2 s samples, average): GPU about 31%, Renderer about 17% | Palm score and wrist height logged through a DevTools breakpoint; `ps` samples | Partly passed | Cause and fix in F6; only 5 tries |
| 9 Palm stop | ChatGPT plan | Same | George reports both sets worked. The log confirms one stop during an answer (subtitle "已靜音這段回覆"); the before-greeting set is not visible in the log, and those two sessions greeted as usual. CPU (2 s samples, 149): GPU average 32% (max 44%), Renderer average 19% (max 37%) | George's report; page subtitles; `ps` samples | Partly passed | Fewer than the runbook's 10 + 10; the App was quit and restarted during the test |
| 10 Keychain | — | Note whether Keychain prompts on the first recognition after a restart | The ad-hoc build prompted after every rebuild; after switching to fixed signing it prompted once more on the first rebuild with code changes, then no more prompts on restart, family data loaded within 3 s and George was named on the first look | George's report; `identity: 已載入` | Done | See F8 |

## Findings

- **F1: on the API key route the model rewrites or adds to the sentence.** In 2 of 9 tries it did not say the given sentence: once it prefixed "好的，我明白了，我會照您說的來：", once it replaced it with "好的，我明白了。那麼我們就接下來可以開始。". Under ID-02 §5 this fails the route. Not seen on the ChatGPT plan in this round.
- **F2: speech during "connecting" is lost.** The microphone opens only when voice is ready (about +5 s); anything said while "connecting" is not heard, so the greeting still plays. Typing is not affected.
- **F3: background noise is taken as speech.** Noise is transcribed as words such as "被談", "Hej, lovs." or "对。", which makes Nous think the user spoke first (no greeting) or cuts an answer short. Transcripts are often in Simplified Chinese (same as HIST-1 F1).
- **F4: a brief head turn reset recognition (fixed, PR #57 `162d842`).** Turning away for a moment during an interaction started a new tracking generation, dropped the evidence and led to `not_eligible`. Turning away for less than 0.8 s no longer resets it; calibration can adjust this. The core still names only from the latest fresh frame, so a different person cannot inherit the name.
- **F5: when standing, the face was out of frame (new calibration feature, PR #58 `7cc99f6`).** Per-frame logging showed seated positions (0.8–1.0 m) were mostly good while standing (1.3–1.7 m) was `no_face` on every frame. There was not a single `unknown` all round, so the issue is camera angle and distance range, not the match threshold. After adding "Calibrate face recognition", the applied values were: farthest 1.85 m, glance grace 1500 ms, turned-face tolerance 0.29; the next 4 looks all named George.
- **F6: palm stop never fired (fixed, PR #57 `29f4238`).** A hand raised high scored only 0.60–0.68 for an open palm (threshold 0.7); a palm in front of the face scored enough (0.70–0.72) but the wrist was about 30 px below the shoulder, so each pose missed one condition. The code also ignored the palm while "connecting". Fix: threshold 0.55, the wrist may sit up to about a quarter shoulder-width below the shoulder, and a palm while "connecting" ends the voice session.
- **F7: a palm during a lookup stops the speech, but the result is still read out later.** For example, after "我查一下" is stopped, the search result arrives and is answered anyway.
- **F8: the first recognition right after launch may not name.** Family data loads on first use; at 00:33 it was not yet loaded when the decision was made (`not_eligible`, 0 frames). After switching to fixed signing, the 02:39 restart loaded it within 3 s and named George on the first look; keep observing.
- **F10: on the ChatGPT plan route, speaking first does not cancel the greeting.** When the user spoke after voice ready but before the greeting decision (within about 0.6 s), the greeting still played; the API key route skips the greeting in the same situation.
- **F11: an open voice session picks up other people's conversation at home.** During step 9 the voice session took in nearby people talking (private matters, not recorded here); the model answered them and introduced itself as "ChatGPT" in Simplified Chinese. Once look-to-talk opens voice it listens until the session ends, so nearby conversation is sent to the cloud and answered. To evaluate: whether to end automatically when nobody is talking to the screen, and the model's self-introduction and Traditional Chinese output.
- **F9: the test tooling caused one blank page.** With a DevTools breakpoint attached, the main window once became `about:blank`; restarting the App fixed it. Cause unknown; not seen in normal use.

## Fixed along the way

- The progress menu kept scaling with distance and jumped around, making it hard to use: the text scale is now frozen while a view is open (PR #57).
- The live voice state was not obvious: while "connecting" the brain shows an amber dashed ring; once connected its regions light up in their colours with a mint ring (PR #57).

## Conclusion

ID-02 **cannot be released yet**: the API key route rewrites the sentence (F1); on both routes speech while connecting is lost (F2), and on the ChatGPT plan route speaking first does not cancel the greeting (F10); steps 2, 4, 5 and 7 are not done. After calibration, naming on the ChatGPT plan route is steady (4/4), the opening sentences stay within the list, and turning naming off works. Palm stop and the head-turn reset are fixed and merged. F11 (voice picking up other people's conversation) is a new privacy concern to evaluate separately. Next round: steps 2, 4 and 5 with a second person; step 7, deleting George (with his consent first); a retest of step 1 on the API key route; and palm stop on both routes up to 10 + 10.
