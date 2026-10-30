<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem4b-2026-10-30.md) | [English](memory-mem4b-2026-10-30.en.md)

# MEM-4b voice delegation carries memory automatically: cloud validation and Mac gate

Dates are 2026-10-30, Asia/Taipei. The starting point is main `a5c7df3` (which already contains MEM-0 to MEM-4a and HIST-1). The work was done on the separate worktree branch `claude/mem-4b`; nothing was committed, pushed or merged. Every person, account, task and memory item is fictional canary test data.

**Status of this batch: the MEM-4b code and the cloud (Linux) checks are done; the Mac gate has not been run and has not passed.** Voice delegation with memory follows the existing flags: it is on only when `NOUS_MEMORY_ROUTES` lists `task` (the API key route also needs `api_key`). No new flag was added. With the flags off, behaviour is byte-identical to MEM-4a. This batch does not show that Nous can safely delegate memory-carrying tasks by voice on real hardware.

## 1. Owner decisions (George, 2026-10-30)

1. **The two voice routes have different conditions.** ChatGPT-plan realtime voice (live): protected delegation runs whenever memory is on and the call is not passive (not set up, off, unavailable, route not released, or another call in use). **Codex consent is not required**, because the sentence is user speech that the core parsed from the sideband itself, not memory handed to the voice model. OpenAI API key realtime voice: only when the call has memory rules (the sideband is connected, which means `openai_realtime` consent exists). Without consent no sideband is opened, which keeps the MEM-3 guarantee that the request does not change by a single byte.
2. **The original-sentence card becomes protected.** The core holds the sentence on the card. SSE carries only an opaque card ID (`delegate_card`), and the trusted main window fetches the title over IPC. Clicking "Delegate" counts as a direct confirmation (via `confirmation`) and goes through the MEM-4a protected delegation (with memory, subject to the flags, consent and sealed storage). With the flags off, the card is exactly as today: `delegate_blocked` carries the title, and the click creates a memory-free task over HTTP.
3. **When the last sentence is only a short affirmative (option C).** If the model delegates right after an affirmative word (a whitelist: "好" (OK), "對" (right), "可以" (sure)…), the core automatically binds to the immediately previous sentence (eligible, unused, within the window, the same session and epoch, and the model actually asked in between). That sentence becomes the title and no card is shown. Otherwise the call falls back to the card (memory-carrying calls) or delegates as before. The risk of "好" binding the previous sentence is described in §7.

## 2. Design and implementation

### 2.1 Sentences the core keeps (`server/memory/live.ts`)

- `LiveMemoryBinding` gains `heard`: the last 8 user sentences (Traditional Chinese), each stored as `{text, at, speechStart, itemId, session, epoch, used, eligible}`. The session and epoch come from `MemoryService.voiceStamp()`, which records the current person at that moment.
- A sentence is written only in `handleUser`, after classification. Assistant speech never goes through this path, so it can never become the sentence. Only ordinary sentences whose `voiceTurn` result is `none` are eligible. The following are always recorded as ineligible (`eligible: false`):
  - echoes (`isEcho`);
  - confirmation phrases such as "確認記住" (confirm remember);
  - a "yes/no" answer to a face candidate;
  - a "cancel" for a pending voice card;
  - memory commands;
  - self-introductions such as "我是 X" (I am X), even when the current person does not change (review minor 1);
  - "確認執行" (confirm) or "取消" (cancel) spoken while a page approval card is open.
- Typed input (live `input user_text`, or a `typed` user item on the API key sideband) makes every earlier sentence ineligible.
- The list is cleared when the call is revoked or ends.

### 2.2 Binding (`binding.delegate`)

1. Await the queue, so finals that have not been processed yet are handled first.
2. Find the sentence:
   - live works by order: the last sentence whose speech started no later than the tool arrival;
   - API key works by the triggering item (§2.4).
   If a sentence has started (its speech start is no later than the tool arrival) but its final has not arrived, wait at most `ASR_GRACE_MS` (2 s, a named constant to calibrate on the Mac). If it still has not arrived, there is no trusted sentence; the core does not fall back to an older one.
3. The sentence must be eligible, within `DELEGATE_WINDOW_MS` (30 s), have the same session and epoch as now, and be unused. A used sentence returns `delegate_once`, so the same sentence is never delegated twice.
4. Negation or hesitation ("不" (no), "不要" (don't), "不用" (no need), "算了" (forget it), "等一下" (wait), "取消" (cancel), no, wait, don't, stop…): no delegation this time and no look-back (review M1). Short affirmatives (§1 item 3, only the affirmative whitelist): look only at the immediately previous sentence, which must be eligible, unused, within the window, of the same epoch, not itself an affirmative or negation, and followed by an assistant transcript before the affirmative (the model actually asked); no sentence is ever skipped (review M2). Any other short sentence (for example "寫首詩", write a poem) is an ordinary sentence and becomes its own title, still subject to the similarity check in step 6.
5. Mark the sentences as used.
6. If the character-bigram Dice coefficient between the model's description and the sentence (both normalized) is below `DELEGATE_ARG_MATCH` (0.1, a named constant to calibrate on the Mac), they are treated as not matching (§2.3).
7. `MemoryService.delegateVoice` goes through MEM-4a's `delegateProtected`:
   - check the session and epoch;
   - `observeVoiceUtterance` (the new via `voice_heard`), then `issueDelegation` / `consumeDelegation`;
   - retrieve by the sentence (the task engine's claude/chatgpt consent, 8 items, 4 KB);
   - write the dependency index first, then `TaskPort.submit` (`origin: user_sentence`).
   While a face candidate is still pending, only the household scope is used.

### 2.3 Three-state policy

`voiceDelegateDecision` has three results:

- `protected`: the core creates a protected delegation;
- `run`: the page delegates as before, without memory;
- `card`: the protected original-sentence card is shown.

It is `protected` only when released and bound to a trusted sentence. When binding fails (ASR gap, timeout, person change, `sealed()` false, Dice mismatch, or no eligible sentence before a short affirmative):

- a memory-carrying call gets the card;
- a call without memory keeps delegating through the page, without memory.

The old two-state `delegatePolicy` is kept for the flags-off case, and its output is byte-identical (snapshot test).

### 2.4 API key route (`server/apikey-call.ts`, `shared/realtime-ga.ts`)

- `parseGaEvent`'s `function_call` carries `response_id`.
- On `response.created`, the sideband records the item that triggered the response:
  - Every `response.create` the core sends carries `response.metadata.nous_trigger` (its own event_id), which upstream echoes in the response object of `response.created`; attribution follows this tag, not the order of sending (review minor 4). A follow-up after a tool result keeps the original sentence; a line the core wants spoken gets null.
  - Any other response gets the latest input if that was a microphone-committed (`committed`) item, or null if it was typed.
- `function_call` uses `response_id` to find the triggering item and binds only to that item's speech-recognition transcript. A typed trigger, a transcript with no `committed`, or an unknown `response_id` has no trusted sentence.
- `delegate_task` is already a core tool that the page skips; protected delegation never calls `ToolHost`.

### 2.5 Output, logs and the page

- The voice model gets the fixed `{ok:true, status:"delegated", engine, note:"已開始處理，完成會通知"}` ("started, you will be notified when it is done"), with no title and no counts. A second call in the same delegation returns `delegate_once`. Task titles shown to voice models still follow MEM-4a's `taskTitleFilter`.
- Only the length of the model's description is logged; logs never contain the sentence or the description.
- The live "delegation received" log records only lengths when the call carries memory or protected voice delegation is released (`delegatePort()` is not null); with the flags off it is byte-identical to before (review minor 2).
- New `LiveCoreEvent`s:
  - `{kind:"delegated", task}`: `task` is a shell (`TaskPort.publicGet`) with no counts. The page treats it like the text chat's `delegatedTask`; if the task is not finished yet it is added to `realtimeTaskIds` (so completion is announced), and if SSE already reported it finished, the page announces it at once (review minor 7);
  - `{kind:"delegate_card", card}`: only the card ID.
- The tasks IPC gains two ops (`desktop/tasks-ipc.mjs` accepts only card IDs of `dc_` plus 24 hex characters and drops extra fields):
  - `card_title`: fetch the card title;
  - `card_delegate`: the click. The card is one-time, valid for 10 minutes, and bound to the session and epoch of the person present when it was created: a person or epoch change (`replacePresence`) voids it, and both the click and the title request return `not_found` with "這張卡片已失效（可能換了人物或超過時間）；請再說一次" (This card is no longer valid (the person may have changed or it timed out); please say it again) (review M3). When protected delegation is not possible, the core creates a memory-free task from the sentence it holds, as with the MEM-4a card; the response carries `memory: "unavailable"` and the page shows "這次沒有帶記憶" (Memory wasn't used this time) (review minor 3).

### 2.6 Flags

- Requires `routeEnabled("task")` and `routeEnabled(route)`; the API key route also needs `api_key` listed in `NOUS_MEMORY_ROUTES`, and the route must not be disabled. No new flag.
- With the flags off, `delegatePort()` is null, and the live tool caller, the API key sideband and the page all follow the MEM-4a path.

### 2.7 Interface (bilingual)

New page-visible text: "這次沒有帶記憶" (Memory wasn't used this time), and the existing "這張卡片已失效（可能換了人物或超過時間）；請再說一次" (This card is no longer valid (the person may have changed or it timed out); please say it again) is added to `src/messages.en.json` (it was previously only in the core's table). The card reuses the existing `memoryView.showDelegate`. The fixed sentences returned to the model are model instructions, like the MEM-2/3 delegation sentences, and do not go through the translation table.

## 3. Deviations from the plan or decisions (recorded as they are)

1. **A call without memory that cannot bind a sentence still delegates through the page (`run`) and shows no card.** This includes the Dice mismatch case and the case with no eligible sentence before a short affirmative. The plan said "fall back to the card". Here the card appears only for memory-carrying calls, because in a call without memory the model's description contains no memory, so letting the page delegate as in M15 is enough.
2. **On the API key route, the follow-up response after a tool result keeps the original triggering item**, for example `recall_memory` followed by `delegate_task`. The plan said "a core-triggered `response.create` has no trusted ASR". Here only lines the core wants spoken are treated as having no trusted ASR. Reason: the follow-up answers the same user utterance, so it is as trustworthy as the original response. Core requests are matched by a `response.metadata` tag, not by order.
3. **The card click has no native click token** (review minor 8): the results history `historyClick` applies only to native menu-bar clicks. The delegation card lives in the main-window page, the main process cannot see that click, and there is no cheap equivalent. The trust boundary is the same as for memory-card clicks (the trusted main window's IPC), and it is listed as a residual risk (§7).
4. **The card title and click go through the tasks IPC** (`card_title`, `card_delegate`), not through the memory IPC's `card_view` / `card_answer`. Reason: the tasks IPC already serves the full content of protected tasks and redo.
5. The grace wait happens only when a sentence has started and its final has not arrived. On live, if there is no sign of speech at all (no `speech_started`, no partial transcript), the core does not wait.
6. "The renderer only handles media" remains deferred (not in this batch).

## 4. Cloud (Linux) validation

Node.js 22. Real AES-256-GCM memory snapshots and encrypted task files; `flock(1)` as the test lock on Linux. The executor is fake (no model calls). live uses a fake LiveCall or a fake sideband (real HTTP/SSE); API key uses a fake GA server (real WebSocket).

| Test file | Coverage |
| --- | --- |
| `tests/memory-voice-delegation.test.ts` (new, 26) | Byte-for-byte snapshot of `delegatePolicy` with the flags off; the three-state table; the affirmative whitelist and the negation/hesitation list; the fixed sentence. live: the title and query are the ASR sentence, the executor gets memory, the page gets only a shell, no codex consent needed; logs record only lengths (the canary never appears); exclusions: echo, assistant speech, confirmation phrases, memory commands, typed input, "確認執行" while an approval card is open; window expiry, use-once and a person change (epoch change) all fall back; a late ASR within grace still binds, after grace it does not; a short affirmative binds to the immediately previous sentence (after the model asked), and with none the call gets the card (no card when there is no title); Dice mismatch → protected card (SSE has only the ID, IPC gives the title, a click delegates with memory, one-time); `sealed` false → no protected delegation (the card click creates a memory-free task); forget after delegation → `memory_revoked`, while a person change or the call ending does not stop it; with the flags off there is no `delegatePort` and the card is unchanged. API key: the committed → response.created → function_call binding, and the page never sees the tool call; a late transcript (within grace); a typed trigger and a transcript without committed are not trusted; a recall_memory → delegate_task continuation binds back to the original item via metadata; overlapping page and core responses are attributed by the tag; without `openai_realtime` consent there is no sideband and no protected delegation. Review regressions (reviewer probes P1–P5): P1 "不要／等一下／算了／不用" (no / wait / forget it / no need) never delegates and never looks back; P2 a short request is its own title, and an English description that does not match gives a card titled with that sentence; P3 used sentences are never skipped and nothing binds unless the model asked; P4 the card is void after a person change (not_found); P5 "我是 George" (I am George) is ineligible; minor 2 the log records only lengths |
| `tests/memory-boundary.test.ts` (+2) | `voice_heard` tickets: mismatched text is rejected, tickets are one-time, and a newer input invalidates them; `voice_heard` cannot be exchanged for a memory-write ticket (`issueParsed` and the literal grammar both refuse) |
| `tests/live-tool-caller.test.ts` (+2) | Protected: the page is never called, the fixed sentence is returned, a second call in the same delegation returns `delegate_once`, and the canary appears in neither logs nor output; `run` still goes through the page; `card` returns the card output and skips the old memory branch; a typed trigger carries `fallbackTitle` |
| `tests/live-integration.test.ts` (+1) | End to end (fake sideband, real SSE, encrypted tasks): the task title is the ASR sentence; SSE has only the shell and `delegated`, with no `realtime.host`; the tool result sent to Codex is the fixed sentence; the model's description is not in SSE, tasks, or the log lines of the core's delegation handling |
| `tests/apikey-integration.test.ts` (+1) | End to end (fake GA, real SSE, encrypted tasks): committed → response.created → function_call; the title is the ASR sentence; the page gets only a shell and no tool call; the fixed sentence; neither the sentence nor the description appears in SSE, logs or HTTP responses |
| `tests/tasks-ipc.test.ts` (+2) | Shape filtering for `card_title` / `card_delegate` (extra fields, such as a forged title, are dropped); the page takes the card title only from IPC, the click goes through IPC, and `delegated` is added to `realtimeTaskIds` while the task is unfinished |

The existing `memory-live`, `memory-apikey`, `memory-tasks`, `task-redaction`, `memory-canary` and other tests pass unchanged (evidence that the flags-off behaviour did not change). The MEM-4b scenarios are kept in the new file so the existing MEM-2/3 fixtures are not modified.

### Test results (actual output of this batch)

```text
npm run typecheck                      (no errors)
npx vitest run                         Test Files  91 passed (91)
                                       Tests  1576 passed | 4 skipped (1580)
npx vite build                         ✓ built
node --check desktop/*.mjs             (no errors)
node scripts/verify-aios.mjs           PASS
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed
node scripts/check-pstack.mjs          pstack 0.15.29: ... verified.
git diff --check                       (no output)
```

The base, main `a5c7df3`, has 90 test files, 1542 passed and 4 skipped. This batch adds 34 tests: 26 in the new file (including 8 regressions from the independent review), plus 2 + 2 + 1 + 1 + 2 in existing files.

## 5. Mac gate (none of it has been run; it cannot be claimed as passed)

Prerequisites: `NOUS_MEMORY_ROUTES=task` (plus `api_key` for the API key route), tasks stored encrypted, memory on, and the task engine (Claude or ChatGPT) allowed.

1. **Calibrate grace:** at least 10 runs for each arrival order, recording the gap between the ASR final and the delegation (live `delegation.created`, API key `function_call`). The two orders are "ASR first, delegation second" and "delegation first, ASR second". Set `ASR_GRACE_MS` from the distribution, and record honestly how often the gap exceeds it.
2. **ASR title quality:** 10 delegations each in Chinese and English; record how the task title (the ASR sentence) differs from what the user actually said; record how often Dice falls below `DELEGATE_ARG_MATCH` and a card appears, and calibrate the threshold from that.
3. **Echo while the model speaks:** while the model reads back a delegation confirmation and the user is silent, confirm that no task is created from the model's speech.
4. **TV or bystander:** play a delegation-like sentence on TV; if the model delegates because of it, record which sentence was bound (a known risk, see §7).
5. **Short affirmative:** "幫我規劃晚餐" (plan dinner for me) → the model asks "Shall I delegate it?" → "好" (OK): the title is the first sentence. "不要" (don't), "等一下" (wait) and "算了" (forget it) never delegate. Saying only "好" (with no request before it) gives a card or a normal delegation. Insert a different request in between and record which sentence is bound.
6. **No-consent cases:** live without codex consent can still do protected delegation; API key without `openai_realtime` consent has no sideband and follows M15.
7. **Keychain refusal:** when the task key is unavailable (`sealed` false), there is no protected delegation, and the screen and voice say so honestly.
8. **Forget and person change after delegation:** forgetting the memory item while the task runs stops it with `memory_revoked`; a person change or ending the call lets it continue.
9. **The completion announcement leaks nothing:** on completion, the voice announcement uses only the shell or the consent-based title; a recording confirms that no other family member's memory-carrying title is spoken.
10. **P2 committed/item_id mapping:** on the API key sideband, the `item_id` of `input_audio_buffer.committed`, the `response.id` of `response.created` and the `response_id` of `response.function_call_arguments.done` all match. If any of them fails, protected delegation on the API key route is not released.
11. **Protected original-sentence card:** in a memory-carrying call whose description does not match, the card appears with its title fetched over IPC (an SSE capture has no sentence); clicking "Delegate" carries memory; with the flags off the card is the same as in MEM-4a.

## 6. Unfinished items and the next gate

- "The renderer only handles media" (moving tools and greetings on the API key route into the core as well) remains deferred.
- `ASR_GRACE_MS`, `DELEGATE_ARG_MATCH` and the affirmative and negation word lists are uncalibrated initial values.
- Next gate: Mac steps 1–11 in §5, especially steps 1, 4, 5 and 10.

## 7. Residual risks

- **"好" (OK) binds the previous sentence (the known cost of George's decision 3 = C):** when the user says "好", "對" or "可以", the core takes the immediately previous sentence, spoken before the model asked, as the title. That sentence may be about something else, or may have come from a TV or a bystander, and the user's "好" may be answering a different question. Dice only rejects sentences that are completely unrelated to the model's description. A wrong guess gives the task the wrong sentence as its title, but it is still something actually spoken on the user's side, not a model rewrite; memory is retrieved by that sentence. Negation and hesitation ("不要", "等一下"…) never delegate.
- **TV or bystanders:** any human voice that reaches ASR can become the sentence (the same limitation as MEM-2's spoken confirmation).
- **ASR typos:** the title is the ASR sentence, so typos are not "fixed" by the model. This is a deliberate trade-off (memory-influenced rewrites must not enter titles).
- **API key response attribution:** core requests are attributed by their `response.metadata` tag. If upstream does not echo the metadata (to confirm in Mac step 10), the core's response is treated as a page or VAD response and attributed to the latest microphone item (still the user's speech).
- **The page's "（系統通知）" (system notice) counts as typed:** on the API key route, notices the page sends are `input_text` user items, which the sideband treats as typing, making all earlier sentences ineligible. This is a false negative in the safe direction (later delegations fall back to the card or a normal delegation; the wrong sentence is never used).
- **Card click:** there is no click token the main process can see (§3 item 3); if script were injected into the main-window page, it could click "Delegate" on the user's behalf (the same trust boundary as memory-card clicks).
- **Order-based binding (live):** live has no item mapping and relies only on order, the window, speech start and use-once. If the model delegates very late, a sentence spoken in between may be taken as the sentence (bounded by the 30-second window).
- **The model may phrase things its own way:** after the fixed sentence the model should say "started"; if it rephrases, what it says may differ from the title (the core's title is authoritative).
- MEM-4a's residual risks (web search may carry memory, deletion is not secure erasure, the core's memory holds plaintext) still apply.

## 8. Rerun

```sh
cd prototype/ambient-shell
npm ci
npx vitest run tests/memory-voice-delegation.test.ts tests/memory-boundary.test.ts tests/live-tool-caller.test.ts tests/live-integration.test.ts tests/apikey-integration.test.ts tests/tasks-ipc.test.ts
cd ../..
node scripts/verify-aios.mjs
```

Linux needs `flock` from util-linux; without it the real-file tests are skipped rather than reported as passing.

## 9. Independent review and fixes (2026-10-30)

The review found 0 blockers, 3 majors, 8 minors and some nits. The reviewer's probes (P1–P5) were added to `tests/memory-voice-delegation.test.ts` as regression tests.

| Item | Fix |
| --- | --- |
| M1 the short-affirmative test was too broad | Only the affirmative whitelist counts; a new negation/hesitation list means no delegation this time; any other short sentence is ordinary (still subject to the similarity check). The former §3 deviation ("under 4 characters also counts") was removed. |
| M2 the look-back skipped used or ineligible sentences | Only the immediately previous sentence is considered (eligible, unused, within the window, same epoch), and an assistant transcript must lie between the two; otherwise the card (memory-carrying calls) or a normal delegation. |
| M3 the protected card was not bound to the person | The card records the session and epoch; a person or epoch change voids it, and the click and title request return `not_found` with the existing fixed sentence; `replacePresence` clears all cards. |
| minor 1 | Only a `voiceTurn` result of `none` is eligible; "我是 X" (I am X) is always ineligible. |
| minor 2 | With protected voice delegation released, the live "delegation received" log records only lengths; unchanged with the flags off. |
| minor 3 | When a card click falls back to a memory-free task, IPC returns `memory: "unavailable"` and the page shows "這次沒有帶記憶" (Memory wasn't used this time). |
| minor 4 | The core's `response.create` carries `response.metadata.nous_trigger`, and attribution follows the tag echoed by upstream; continuation and overlap tests were added. |
| minor 5 | §7 records that the page's "（系統通知）" (system notice) counts as typed (a false negative in the safe direction). |
| minor 6 | Waiting on the queue is also bounded by the grace deadline (`Promise.race`). |
| minor 7 | If the task is already finished when `delegated` arrives, completion is announced at once. |
| minor 8 | There is no cheap native click token for the card click; recorded in §3 and §7. |
| nit | Typed triggers pass `itemId: null` explicitly; SSE `delegated` no longer carries `memory_used`; `waitHeard` removes its waiter on timeout; a single `DELEGATE_CARD` regex (`shared/protected-tasks.ts`); the unused `released` parameter was removed from the three-state policy. |
