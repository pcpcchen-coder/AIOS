<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-voice-default-2026-11-02.md) | [English](memory-voice-default-2026-11-02.en.md)

# Memory voice default (ask by voice, use unless the user says no) validation

Date: 2026-11-02, Asia/Taipei. Branch: `claude/memory-voice-default` (based on main `6412ea0`). Scope: George's request of 2026-11-02 — when choosing whose memory to use, do not pop up a card to click; Nous asks by voice, “I'll use George's memory, OK?” (「我要用 George 的記憶，好嗎？」), and uses George's memory unless the user says no; this applies whenever the camera (face) or the voice already identifies George. Earlier rules: [16 §4](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#4-人物綁定與使用同意), [17 §9.2](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.en.md#92-身分只提出候選核心選定人物), [MEM-2 validation](memory-mem2-2026-10-30.en.md), and [SP-02b validation](sp-02b-2026-11-01.en.md).

**This is not hardware acceptance.** All tests below ran in the cloud container with fixtures (fake sideband, fake GA server, fake clock and fake timers, fake DOM), not on the Mac, not with a microphone, and not with a real camera. Family recognition and voice thresholds remain uncalibrated. Selecting the current person is still only an ownership choice of “whose preferences this time”; it is **not identity verification or authorization**, and it never creates the source ticket that writing memory requires.

## 1. George's decisions (2026-11-02)

| # | Decision | What this batch does |
|---|---|---|
| D1 | No card to click; ask by voice and use unless the user says no | Realtime voice no longer sends a `memory_card` (face candidate card). The core sends one sentence for the model to read verbatim, “（記憶確認）「我要用 George 的記憶，好嗎？」” (“I'll use your memory, OK?” when the name may not be spoken), and the page shows only one line, “About to use George's memory”, with a “Not me” button |
| D2 | When to select: whichever comes first | (a) the user's next sentence after the question was read and finished playing (not a no, not an echo) — selected **before the core processes that sentence**, so the core-side handling of that sentence (memory commands, protected delegation) uses George's generation; however, the realtime model may already be answering from the audio (semantic_vad runs ahead of the transcript), so **the spoken reply to that sentence may not use George's memory; from the next turn on it does**; (b) 8 s after the question finished playing (`DEFAULT_SELECT_MS`); (c) 12 s after it was sent (`DEFAULT_BACKSTOP_MS`) if the question was never read (no matching assistant transcript) |
| D3 | Typed chat with a face candidate selects at once | `process()` selects directly and the sentence continues to chat with George's memory; receipt “Current person: George (recognized by the camera)”; the page shows one line, “Using George's memory”, with “Not me” (non-blocking) |
| D4 | After a no | Household-shared memory only; Nous says “OK, I'll only use the shared household memory this time.”; no re-ask for the rest of the interaction (neither for the same recognition decision nor in this call) |
| D5 | Undo later | A new memory command `unselect`: saying or typing 「不是我」, 「不要用我的記憶」, 「改用全家共用的記憶」, “not me”, … switches back to household-shared memory with the receipt “Switched to the shared household memory” |
| D6 | No consent for the route | Nothing is spoken; the screen line still appears and the person is selected 8 s after it was sent unless “Not me” is pressed |
| D7 | Collapse (收起) | Only hides the line; selection proceeds. Only ending the call cancels before selection |
| D8 | Keep MEM-4a revocation and generations, and SP-02a face/voice fusion | Selection always goes through the `answerLiveCandidate` re-checks; every person change goes through `select()` / `replacePresence()` (new generation, revoke and rebuild a call carrying memory) |

## 2. Which earlier rules this overrides

- **SP-02b G3** ([SP-02b validation §1](sp-02b-2026-11-01.en.md#1-georges-decisions-2026-11-01)): “when the face is not recognized but in-call voice is, ask ‘Use George's preferences this time?’ and always wait for confirmation” becomes D1 / D2: the question is now “I'll use George's memory, OK?” and the person is selected unless the user says no. The conditions for raising a voice candidate (the face does not disagree, the previous utterance does not point to someone else, within 60 s, at most once per call) are unchanged.
- **17 §9.2's “always confirm”** ([17 §9.2](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.en.md#92-身分只提出候選核心選定人物)): for `confirmed(P)`, `face_only(P)`, and `voice_only(P)`, “brief confirmation; read P after confirmation” becomes “say once; read P unless the user says no”. `conflict`, `voice_multi`, `voice_weak`, and `none` still read household-shared memory only and raise no candidate. Write rules are unchanged: after selection, only an explicit “remember” writes, and it still needs a source ticket (identity results cannot create or replace tickets).
- **16 §4's “brief confirmation” and “only ‘I am George’ or selection in the trusted main window establishes `selected`”**: a 2026-11-02 exception note was added (default selection when the face or voice already identifies the person). The original text of 17 and 16 is kept; 16 §4 has an update note; 17 itself (a planning document) was not changed, and this record takes precedence.

## 3. Design

### 3.1 Realtime voice (both the ChatGPT plan and API key routes)

- Opening: for calls started by look-to-talk or wake, `afterGreeting()` runs after the greeting (or before the first sentence when the user speaks first); with a face candidate it calls `propose()`. During a call: SP-02b's voice candidate goes through `offerVoiceCandidate()` → `voiceCandidate()` → `propose()`, at most once per call.
- `propose()`: creates a live-origin `face_candidate` card (only in core memory; the page does not show it as a card); with consent, `say()` sends the question; SSE sends `{ kind: "memory_default", card, phase: "proposed" }` (**only an opaque card ID**; the trusted main window fetches the person's name through IPC `card_view`); the timer starts.
- The timer (default `setTimeout`; tests inject fake timers) queues onto the same queue as user transcripts and is processed in order; when it fires it re-checks with `now()`, so an early wake-up never selects early. The assistant audio-done time only moves later, and the selection time moves with it.
- Each user sentence (`handleUser`, after the confirmation-card step and before ordinary processing):
  - Echo (contained in a recent assistant transcript or a core-sent sentence): ignored.
  - Speech that started before the question was sent: not an answer.
  - “I am Y” (「我是 Y」): drops this candidate (without the household sentence) and lets the existing parser select Y; if Y does not exist or has a duplicate name, the current scope's memory is attached as usual.
  - A whole-sentence no (`declinesDefault`, see 3.3) or `unselect`: **valid any time after the question was sent, including talking over it**; household-shared memory only, no re-ask this interaction.
  - Asked by voice, question read and finished playing (`readyAt` as in MEM-2: the audio-done event when present, otherwise 1.8 s after the question transcript), and the speech started after that: select first, attach George's pinned memory, then process the sentence as usual (memory commands, delegation). The model's spoken reply to this sentence may have started before the transcript arrived and may not use the newly attached memory. For an SP-02b mid-call voice candidate: if the call already carries household-shared pinned memory, selecting George changes the generation, so the boundary revokes and rebuilds the call (first sentence 「好，已經更新了。」); it is not a seamless switch inside the original call. A bare answer such as 「好」 or 「是」 only selects; it is not treated as an ordinary sentence and cannot become a delegation source sentence (MEM-4b).
  - An ordinary sentence before the question finished playing: processed as usual (household only), still waiting.
- Selection: `selectDefault()` → `MemoryService.answerLiveCandidate(card, true)`. `ok`: SSE `phase: "selected"` and memory attached; `mismatch_face` (camera only: the candidate is now another family member): “The camera sees a different family member; only the shared household memory is used this time”; `mismatch_voice` (voice involved: the candidate or the card came from voice, or in-call voice pointed to someone else after the card was created): “The camera and the voice don't match; only the shared household memory is used this time”; `expired` (card, generation, or recognition decision no longer valid): “The candidate is no longer valid; only the shared household memory is used this time”. Both of the latter send `phase: "declined"` and attach household-shared memory.
- SP-02a: if, before selection, in-call voice matches a family member different from the face candidate, `IdentityService` calls `voiceDisagrees()` and the default is cancelled (the same “camera and voice don't match” notice). Voice samples usually arrive after the sentence's transcript, so another family member's voice **within 10 s after a default selection** (`DEFAULT_GRACE_MS`) also switches back to household-shared memory, says the mismatch line, and stops asking for this interaction; after that, SP-02b G2 applies (log only). If the mismatch arrives while the selection is awaiting the core, the core returns `mismatch_voice` or undoes the selection right after, depending on order, and the page never shows “Using …” first. With several faces in view (within the candidate window), voice candidates are neither raised nor used.
- Call end (`close()`) or memory revocation (`cleanup()`): the timer is cancelled and nothing is selected. Person change (`presenceChanged()`): the candidate is dropped.
- No consent (`speakable()` false): nothing is spoken; spoken 「好」 or 「不要」 does not count (nothing was asked); only an explicit `unselect` (「不是我」) and the on-screen “Not me” count; selected 8 s after it was sent.

### 3.2 Typed chat

`MemoryService.process()`: for typed input processed from the first segment, with no selected person (including suspended), no “I am X” and no `unselect` in the sentence, and a recognition decision not used yet (the “once per decision” rule of `faceCandidate()`), it calls `select()` directly. **Only a face candidate is used** (`memoryFaceCandidate()`, never falling back to in-call voice), so “(recognized by the camera)” in the receipt is always the camera; with a face candidate, a sentence that is 「不是我」 is a no (not sent to chat; receipt “Only the shared household memory is used this time”) with the receipt “Current person: {0} (recognized by the camera)” and sets `MemoryTurnView.auto_selected = true`; the sentence then continues in George's scope (`memory_turn` binds to the post-selection generation).

### 3.3 Matching no and undo

- `declinesDefault(text, name)` (`server/memory/live.ts`): converts to Traditional Chinese, removes spaces and punctuation, lowercases English, then strips trailing 了／啦／喔／哦／啊／呀／吧 and 謝謝. The whole sentence must be one of 不、不要、不用、不是、不對、不好、不行、不可以、別、算了、等一下、等等、先不要、不是我、換人, no, nope, no thanks, not me, that's not me, don't, wait, hold on…; or 「我不是／不是／I'm not ＋ the name in the question」; or 「不要用／別用／不用 ＋（我的｜name 的）＋ 記憶／偏好」; or `unselectPhrase`. After review these also count as a no: repeated negation (「不要不要」「不用不用」, “no no”); a leading negation followed by a pause and more words (in Chinese a space or punctuation, for example 「不要，用全家的」「不，我是說…」; in English punctuation is required, for example “No, use the household memory”, so “no problem” does not count); “please don't”; and a sentence asking for household memory (「全家共用」「用全家的」「全家的記憶／偏好／就好／好了」, “household memory/only”; an ordinary question such as 「全家的晚餐吃什麼」 does not count). A leading negation directly followed by a verb with no pause (「不要開燈」「不用擔心這個」) stays an ordinary request and selects.
- `unselect` (a new segment in `server/memory/parse.ts`): the whole segment is one of 「不是我」「那不是我」「不要用我的記憶」「別用我的偏好」「不用我的記憶」「換人」「改用／只用／用全家共用的記憶（就好）」, “not me”, “that's not me”, “don't use my memory”, “use household / shared memory”. It is a command only when a current person is selected (typed: switch back to household-shared memory and clear history that used memory; voice: the same, and a call carrying memory is revoked and rebuilt); without a selected person the sentence goes to chat unchanged.
- Near-misses that do not count (tested): 「不是我做的」「不要開燈」「不是我說的」「我不是很餓」「不要太辣」「等一下再開燈」「換人來做」「不要用我的電腦」, “not me too”, “no problem”… These are ordinary sentences; said after the question finished playing, they select George and are processed as usual.

### 3.4 Page

- `PresenceNotice` in `src/memory-view.ts` (following the `SuggestionPrompt` pattern): one line of text plus “Not me”, `data-visibility-reason="user_request"`, fixed at the top of the screen (`#presence-notice`); it is not a Surface and does not block chat.
- Realtime voice: `memory_default` proposed → fetch the person's name through `card_view` and show “About to use George's memory”; “Not me” = `card_answer` (`decline`): the core does not select, attaches household-shared memory, does not ask again, and returns the receipt “Only the shared household memory is used this time”. selected → re-read the current person and show “Using George's memory”; “Not me” = `select` (household-shared, with this generation's `select_card`). declined → the line is removed.
- Typed chat: when the turn carries `auto_selected`, show “Using George's memory”.
- Collapse (Esc, saying 「收起」) only hides the line, and it stays hidden until the next new proposal (it does not reappear on selection); selected only turns the waiting line into “Using …”, with the name from that card; if the current person is someone else (for example after 「我是 Y」) the line is removed and the ordinary receipt explains; a change of the current-person generation removes it; when the call ends, a line still waiting for selection is removed (a selected line stays until the generation changes).
- All new copy is in the shared catalogs (`server/messages.en.json`, `src/messages.en.json`).
- The face candidate card type (`face_candidate` in `MemoryCardView`) and its view are kept; these two flows just no longer open it.

## 4. Deliverables

All paths are under `prototype/ambient-shell/`.

| File | Contents |
|---|---|
| `server/memory/live.ts` | `propose()`, `selectDefault()`, `declineDefault()`, `noDefault()`, `candidateMismatch()`, the timer (`timer` option), `declinesDefault()`, `DEFAULT_SELECT_MS` / `DEFAULT_BACKSTOP_MS`, the new question and fixed sentences; step 2 of `handleUser` rewritten; `CandidateAnswer` |
| `server/memory/service.ts` | `answerLiveCandidate` returns `ok` / `expired` / `mismatch_face` / `mismatch_voice`; the decline record (`DEFAULT_DECLINE_MS`); the 10 s voice grace after selection (`DEFAULT_GRACE_MS`); the route hand-off store (`carryDefault` / `takeCarriedDefault`); typed-chat default selection and `auto_selected`; the `unselect` segment (typed and voice); `voiceDisagrees()`; choosing household-shared ends default selection for this interaction; the receipt for declining a face candidate |
| `server/memory/parse.ts` | The `unselect` segment and `unselectPhrase()` |
| `server/identity-service.ts` | When in-call voice differs from the face recognized at greeting (or from the current person), calls `voiceDisagrees()` (the memory layer decides whether it is within the 10 s grace); with several faces no voice candidate is raised or returned; `memoryCandidate()` carries `source`; face-only `memoryFaceCandidate()` |
| `server/live-route.ts`, `server/nous.ts` | `handOff()` on `close("fallback")`; `memoryFaceCandidate()` wired to the memory layer |
| `shared/realtime-route.ts`, `shared/memory.ts` | The `memory_default` event; `MemoryTurnView.auto_selected` |
| `src/memory-view.ts`, `src/main.ts`, `index.html`, `src/style.css` | `PresenceNotice` and its wiring (SSE event, turn, collapse, call end, generation change) |
| `src/live-voice.ts`, `src/realtime.ts` | Forward `memory_default`; proposed ends quiet mode (the question must be audible) |
| `server/messages.en.json`, `src/messages.en.json` | English for the new copy |

## 5. Automated tests

| Test file | Coverage |
|---|---|
| `tests/memory-live.test.ts` | No matching and near-misses; selection 8 s after the question finished, with memory attached; the audio-done event moving the window; the 12 s backstop; the next sentence selects before being processed (the confirmation question is filed under George); speech before the question finished does not select; 「好」 is not mistaken for an echo of the greeting; a whole-sentence no may talk over, keeps household only, is said once, and is not asked again (same call and the next call in the same interaction); 「不是我做的」「不要開燈」 select while 「我不是 George」「不是我」 do not; “I am X” replaces the default; re-checks (another family member → mismatch, a new decision → expired); `voiceDisagrees()`; call end selects nothing; no consent: nothing spoken, on-screen “Not me”, selection at 8 s; SP-02b voice candidate (asked once, no name, not asked while the opening candidate is pending); a later spoken 「不是我」 switches back to household, revokes and rebuilds, no re-ask |
| `tests/memory-apikey.test.ts` | API key route: the question is a core `response.create`, no `memory_card`, the next sentence selects and attaches memory (system item); a talked-over 「不是我」 keeps household only and is said once |
| `tests/apikey-integration.test.ts` | Real HTTP / SSE plus a fake GA server: the SSE `memory_default` carries only `card`, `kind`, and `phase`, no name; 「不是我」 → declined |
| `tests/live-integration.test.ts` | Real HTTP / SSE plus a fake sideband: the question goes to the sideband, SSE carries only a card ID, no `memory_card`, 「不要」 → the household fixed sentence |
| `tests/memory-voice-delegation.test.ts` | A request said after the question selects first, so the protected delegation carries George's memory; a bare 「好」 only selects and cannot become a delegation source sentence |
| `tests/memory-chat.test.ts` | After typed default selection, the same sentence reaches the engine through `/api/chat` with George's memory |
| `tests/memory-service.test.ts` | Typed default selection (replacing the old M04 card test): no card, `auto_selected`, receipt, `memory_turn`; 「不是我」 switches back to household and the same decision is not selected again; without a selected person 「不是我」 is ordinary chat; a new decision selects again and `select` household undoes it; default selection also while suspended, request cache cleared |
| `tests/memory-parse.test.ts` | Chinese and English `unselect` phrasings; near-misses 「不是我做的」「不要開燈」「不是我說的」「換人來做」「不要用我的電腦」, “not me too”, and others stay ordinary chat |
| `tests/identity-wake-voice.test.ts` | With a selected person, another family member's voice is passed to the memory layer to judge (`voiceDisagrees`); with several faces no voice candidate is raised or returned; `memoryFaceCandidate()` never falls back to voice |
| `tests/memory-view.test.ts` | `PresenceNotice`: the waiting line and `card_answer` decline; the selected line and `select` household; collapse only hides; generation change and call end remove it; an expired card shows the core's reason; English UI; nothing in the browser version |

Updated earlier tests (no coverage deleted): the whole “face candidate by voice” group in memory-live now covers the new behavior (question, timing, no, re-checks, and the three SP-02b cases are all kept); memory-apikey's face candidate test now covers the voice default; memory-service's M04 and Minor 6/7/10 now cover typed default selection.

Results: see §7.

## 6. Residual risks and work not done

- **A bystander or the TV**: after the question finishes playing, any sentence that is not a no selects George (D2 (a)); 8 s of silence also selects. Selection only affects whose preferences are used this time and writes no memory; “not me” can be said or pressed at any time.
- **The no list is fixed**: only whole sentences such as 「不要」「不是我」 count; phrasings outside the list (for example 「呃…不要好了」「我想想」) are treated as ordinary sentences and select. Collect missed phrasings during the Mac trial.
- **The model may respond as well**: when the user says 「不要」, the realtime model hears it too and may add a sentence; the core only sends its fixed sentence and does not change instructions.
- **Typed 「不是我」 misread**: with a selected person, typing exactly 「不是我」 (for example as an answer to something else) also switches back to household-shared memory; nothing changes without a selected person.
- **Scope of “this interaction”**: after a no (or 「不是我」, a mismatch, or undoing a default selection), the core remembers that family member for 10 minutes (`DEFAULT_DECLINE_MS`), across rebuilds, new calls, route changes, and SP-02b, and does not ask again; it is cleared when another family member is recognized or any family member is selected. An ordinary menu switch to household-shared memory (not undoing a default selection) is not recorded. 10 minutes is a provisional value, not a camera-based “end of interaction”.
- **The 12 s backstop selects whether or not the question was heard**: if the question is never read (for example the model did not read it, or playback was interrupted), selection still happens after 12 s, and the user may never have heard the question; the screen line and a later “not me” are the only cues.
- **「換人」 / “Not me” while someone is selected always reverts** to household-shared memory, whether or not the selection was a default and whatever the sentence was answering.
- **Route hand-off**: `LiveCall.close("fallback")` passes a waiting candidate to the next call, but the current code only changes route during connection (before the greeting), when no candidate exists yet; this path has unit tests only.
- **Voice/face disagreement** is detected only when in-call voice (SP-02b switched on) matches another family member; thresholds are uncalibrated.
- 17 §9.2's per-utterance voice revocation after selection is not implemented (SP-02b G2 still only logs).
- The position and style of the screen line have not been seen on the Mac.

## 7. Verification results

Run in the cloud container (Linux, Node.js 22) while another agent was running tests in a sibling worktree (higher load):

- `npm run typecheck`: passed.
- `npx vitest run` (after the review fixes): 119 test files, 2,251 passed, 5 skipped, 0 failed. The 10 test files touched by this batch went from 248 to 277 tests (memory-live 37→51, memory-parse 45→47, memory-view 14→19, memory-voice-delegation 27→29, memory-apikey 35→36, memory-chat 7→8, apikey-integration 5→6, live-integration 10→11, memory-service 43→44, identity-wake-voice 25→26; the old candidate-card tests were rewritten, with no coverage deleted).
- `npm run build`: passed (only the existing chunk-size warning).
- At the repo root: `node scripts/verify-aios.mjs` PASS (type checks, 2,251 passed, 5 skipped, build, mock flows); `git diff --check` clean; `node scripts/check-bilingual-docs.mjs` (without `--record`) only reports that 5 changed document pairs have no recorded fingerprints yet (16, current status, validation index, this record, SP-02b); `--record` should run after translation review.

## 8. Mac trial steps (not run)

Prerequisites: the macOS App, family memory on, George's memory profile linked to family recognition, one or two pinned memories (for example 「不吃香菜」, no cilantro), and the current person set to household-shared.

1. Start realtime voice while looking at the screen (ChatGPT plan): after the greeting you should hear 「我要用 George 的記憶，好嗎？」, and the top of the screen shows “About to use George's memory | Not me”, **with no card**.
2. Stay silent for 8 s: the line changes to “Using George's memory” and the status line shows “Current person: George · N memories”. Asking 「晚餐吃什麼？」 should avoid cilantro.
3. Start a new call and, right after the question finishes, say 「記住，我不喝咖啡」: George should be selected at once and the confirmation question should say it is filed under George (the core's handling of this sentence already uses George). The model's spoken reply to this sentence may not use George's memory yet; then ask 「晚餐吃什麼？」, and that turn should avoid cilantro.
4. Start a new call and say 「不要」 before the question finishes: you should hear 「好，這次只用全家共用的記憶。」, the current person stays household-shared, and neither this call nor the same interaction asks again.
5. Say 「不是我做的」 or 「不要開燈」 (after the question finishes): they should be treated as ordinary sentences and George is selected.
6. After selection, say 「不是我」: the current person switches back to household-shared and the call is rebuilt (first sentence 「好，已經更新了。」).
7. Withdraw the ChatGPT plan realtime voice consent in memory management and repeat step 1: no question should be spoken, the screen line still appears; pressing “Not me” does not select; otherwise the person is selected after 8 s.
8. Typed chat (looking at the screen, after the greeting): type 「晚餐吃什麼」; below the answer you should see “Current person: George (recognized by the camera)”, and the top of the screen shows “Using George's memory | Not me”; pressing “Not me” switches back to household-shared.
9. Say 「收起」: the line is hidden and the current person does not change.
10. Turn on “Speaker recognition during calls”, start a call without looking at the screen, and say a few sentences: once the voice is recognized you hear 「我要用 George 的記憶，好嗎？」; then as in steps 2–4.
11. Repeat steps 1–4 on the API key route (`NOUS_MEMORY_ROUTES` lists `api_key`).
12. Repeat steps 1 and 8 with the English interface and check that the question, the line, and the button are in English and the name is unchanged.

## 9. Fixes after independent review (2026-11-02)

| # | Issue | Fix and tests |
|---|---|---|
| 1 | The voice sample arrives after the transcript, so the wrong person could be selected; a mismatch during the selection await could be missed | Another family member's voice within 10 s after a default selection → back to household-shared memory, mismatch line, no re-ask; a mismatch during the await yields `mismatch_voice` or an immediate undo depending on order, and the page never shows “Using …” first. Both orders tested (memory-live) |
| 2 | The doc claimed the triggering sentence's reply already uses George's memory, which is false | §1 D2, §3.1, and Mac step 3 rewritten: the core's handling of that sentence uses the new generation, the model's spoken reply may not; an SP-02b mid-call selection revokes and rebuilds |
| 3 | Typed chat could use an in-call voice candidate while the receipt says “recognized by the camera” | `memoryFaceCandidate()`; typed chat uses the face only (memory-service) |
| 4 | A no only lasted for that call | The core remembers it for 10 minutes, across rebuilds, new calls, route changes, and SP-02b (memory-live, memory-service) |
| 5 | A camera-only change also said “camera and voice don't match” | Split into `mismatch_face` (“The camera sees a different family member…”) and `mismatch_voice` (memory-live) |
| 6 | Typing 「不是我」 with no selection and a face candidate went to chat | Treated as a no (memory-service) |
| 7 | The page line could stick after a person change or revocation | `presenceChanged()` / `cleanup()` send `declined` (memory-live) |
| 8 | After collapsing, the line reappeared on selection; the re-read could show someone else | Hidden until the next new proposal; the name comes from the card; removed if the current person is someone else (memory-view) |
| 9 | A waiting candidate was silently dropped on route change | `handOff()` passes it to the next call (same card and deadline, no re-ask) (memory-live; see the limitation in §6) |
| 10 | Voice candidates could still be used with several faces in view | Not raised and not used with several faces (identity-wake-voice) |
| 11 | Missed ways of saying no | Repeated negation, a leading negation with a pause, “please don't”, and any mention of household memory count; 「不要開燈」 stays an ordinary request (memory-live) |
