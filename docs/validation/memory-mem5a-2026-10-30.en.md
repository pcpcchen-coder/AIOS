<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem5a-2026-10-30.md) | [English](memory-mem5a-2026-10-30.en.md)

# MEM-5a memory suggestions, offline metrics and minimal family collaboration: cloud validation and Mac gate

Date: 2026-10-30, Asia/Taipei. The starting point is main `7fc7d09` (which already contains MEM-0 to MEM-4c and HIST-1). The work was done on the separate worktree branch `claude/mem-5a`; nothing was committed, pushed or merged. All people, sentences and memory content are fictional synthetic data or canaries.

**Status of this batch: the code and the parts that can be checked in the cloud (Linux) are complete; none of the Mac gate has been run or passed.** The feature is off by default: `NOUS_MEMORY_ROUTES` must list `suggest`, and the user must also turn on "memory suggestions" in the memory manager opened from "Memory…" in the menu bar. Suggestions are made only when both are on. This does not support a claim that Nous "learns you over time": candidates come only from fixed rules, and every one is saved only when the user presses "Remember".

Before going to sleep, George authorized finishing all MEM work with **conservative defaults**. Every product decision listed in §3 is a default and is **pending George's confirmation**.

The same-day independent review (§10) found no blockers but 5 majors: on the reviewer's own 76-sentence adversarial set, precision before the fixes was only 19.6%, the false-memory rate 80.4%, and 63.1% of the 65 should-not-propose sentences were proposed. This document describes the fixed version; the numbers before and after are both listed in §4.

## 1. Scope

Following [16 §4](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#4-人物綁定與使用同意) (automatic suggestions are off in the first version), [§8](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#8-忘記換人與晚到回覆) (no automatic extraction from results), [§11](../16_Nous_Memory_Layer_Design_2026-10-26.en.md#11-分批實作與放行) (candidates live only in RAM, are dropped at the end of the conversation or after 24 hours, never take part in answers while unconfirmed, are never learned from standby audio, TV or the model, and are offered only in a conversation the user started) and [ADR-0002](../adr/ADR-0002-nous-family-memory.en.md) (automatic curation only proposes candidates in a later opt-in batch):

1. **Candidate detection** (new file `server/memory/suggest.ts`): fixed rules only, no model calls.
2. **When to propose**: after a typed turn from the trusted main window has been processed, at most 1 per turn.
3. **RAM only**: candidates, rejected keys and rate counters are never written to disk.
4. **Presentation**: one line under the reply, "Remember 'I don't eat cilantro'? [Remember] [No]"; not a new Surface.
5. **Writing**: only a click on "Remember" writes, with `source.kind` `"suggestion"`.
6. **Rate limits**: 1 per turn, 3 per hour per epoch, 10 per 24 hours; a key the user declined is not proposed again for 24 hours.
7. **Family collaboration (minimal)**: suggestions never propose household facts; while the flag is on, new household facts record `source.by`; "Household · noted by X · date" is shown only when viewing memory, with a note that this is not identity verification; no push or notification; relayed statements are still refused; no suggestions for minors.
8. **Flags**: `NOUS_MEMORY_ROUTES` gains `suggest`; `settings.suggestions` becomes a boolean.
9. **Snapshot version 4**: see §2.6.
10. **Offline metrics**: see §4.

Not in this batch: the behaviour of `work_summary` (MEM-5b; this batch only adds it to the snapshot format), memories relayed for someone else, any memory applied automatically, and suggestions from voice.

## 2. Design and implementation

### 2.1 Candidate rules (`server/memory/suggest.ts`)

`analyzeSuggestion(text)` takes **the whole typed turn** (the same function as `MemoryService.maybeSuggest`; review M1, m3) and returns the first eligible candidate, or the reason for not proposing; `suggestFrom(text)` returns only the candidate. Before matching, curly apostrophes (’) become straight ones and the small full-width question mark (﹖) becomes a question mark; the saved value keeps what the user typed (review M3). Order:

0. **The turn must be ordinary chat only**: if `parseMemoryText` finds an explicit memory command (`command`) or a "today / this time" request (`temporal`), nothing is proposed.
1. **Whole-turn exclusions** (all segments are read together; a hit in any sentence means nothing in the turn is proposed; review M1): the quote, joke, hypothetical, sensitive-data (including long digit runs) and third-party (`THIRD_SPEAKER`, `THIRD_HELPER`, `EN_THIRD`) rules exported from `parse.ts`, plus English reported speech (said, told…), Chinese "跟他／告訴她／他覺得", uncertainty (`UNCERTAIN`), health terms (過敏, 藥, 懷孕, 病, 醫生, 血壓, 不耐, 減肥, allergic, medication, pregnant, diet…), past tense (以前, 曾經, 之前, 小時候, 本來 (but not 本來就), used to, didn't, liked…), `TEMPORARY` ("今天不要…") and tag questions (對吧, 是不是, right?). Added after the review: sarcasm and jokes (才怪, 呵呵, 哈哈, XD, lol, haha, said no one, oh great, emoji), uncertainty (應該, 我想, 我覺得, 來著, I think, I guess), more health terms (疹, 抗生素, 維他命, 喉嚨, 腫, meds, vitamin, throat, swell, rash, blood sugar…), **special categories** (religion, politics, addiction and abstinence: 穆斯林, 清真, 齋戒, 拜拜, 觀音, 教會, 民進黨, 國民黨, 選舉, 戒酒, 戒毒, Lent, Ramadan, halal, kosher, Muslim, church, Fox News, politics, recovery, rehab, sober…; `special`), and **proxy and framing** (要我跟你說, 幫 X 打, 代替, 在打字, 翻成, 翻譯, 造句, 角色扮演, 假裝, "我 N 歲", 年級, 作業, here, this is, for my, translate, pretend, role-play, grade, years old; `framing`; review M2). If any clause starts with a third person (`THIRD_SUBJECT`, `EN_THIRD_SUBJECT`) or is only a form of address ("…啦，媽媽"), nothing in the turn is proposed; nor if any clause that is **not a question** contains a temporal word ("我不喝咖啡。這週而已。").
2. **Clauses**: split on commas, semicolons, 但是／可是／不過 and "but"; the enumeration comma 、 is not split ("我不吃香菜、洋蔥" is one preference).
3. **Clause patterns**:
   - Chinese: starts with 我 (optionally after 以後), then adverbs (都, 很, 最, 比較, 一向, 從來, 真的…), then a preference verb: 不吃, 不喝, 不碰, 很少吃, 喜歡, 不喜歡, 討厭, 受不了, 偏好, 愛吃, 愛喝, 愛看, 愛聽, 習慣, 怕, 吃素, 是素食者. Plain 吃／喝／用／聽／看 count only after 都, 只 or 習慣 ("我吃牛肉" is not a preference). 我們, 我家 and 我媽 never match the pattern.
   - English: starts with `I` (optionally after "from now on"), then adverbs, then don't/never eat, drink, like, love, prefer, enjoy, hate, dislike, can't stand or avoid; eat, drink, go to bed and similar count only after always, usually, only or never; `I'm (a) vegetarian/vegan` is also accepted. `I'd`, `I'll`, `I want`, `I need` and `I'm …` are requests or states and are not proposed.
4. **Clause exclusions**: **the candidate must be the first clause of the turn, or be preceded only by question or request clauses** ("我爸要我跟你說，我不吃豬肉" and "Oh great, I love soggy fries" are not proposed; `context`; review M2); a question (question mark, ﹖, 嗎, 呢, 吧, 什麼, 是不是, 怎麼…); a segment that ends with a question mark when the candidate is its last clause ("I don't eat pork?"); a demonstrative or pronoun object (這道菜, 那家, 你, it, this, that…); **an object that is not a short noun phrase** (over 12 characters in Chinese or 4 words in English, or containing 因為, 所以, 的話, 直到, 到月底, 為止, until, during, since, because, unless, on my, when, after, before…; `clause`／`too_long`; review M3); a trailing 了 ("我不吃了", "我不吃辣了"; only "以後都…了" is a clear long-term decision); a following clause that looks like the same enumeration ("I don't eat pork, beef or lamb", "我不吃豬肉，牛肉": saving only the first half would be wrong, so the sentence is not proposed).
5. **Topic**: the content must fall in the fixed topic lexicon's food, comfort, reply_style, schedule or media; naming and other (names, relationships, colours, pets…) are never proposed.
6. **Value to save**: the same as an explicit "remember…": Chinese drops the leading 我, English keeps the whole clause; `topic` and `key` come from `topicOf` and `keyOf` in `parse.ts`.

`suggestFrom` is deterministic. `suggestionBodies(text)` turns it into the source-ticket comparison body (`op: "suggest"`, `part: 0`, `scope: "subject"`). The temporal check therefore changed from "only the candidate's own clause" to "every non-question clause of the turn" ("我不吃香菜，今天晚餐吃什麼？" is still proposed because the second clause is a question).

### 2.2 When a suggestion is made (`MemoryService.maybeSuggest`)

Only at the end of `process()`, only for the typed turn (`via` typed, starting at segment 0), and only when there is chat text to send; `suggestFrom` is called with the whole turn (review M1). No suggestion when:

- `NOUS_MEMORY_ROUTES` does not list `suggest`, `settings.suggestions` is not `true`, or memory is off;
- the turn has any segment that is not ordinary chat (`chat`), that is, an explicit memory command, "我是 X" or a "today / this time" request;
- a memory card is still open in this epoch;
- no person is selected (including suspended), or the current person is a minor;
- no eligible sentence is found, the value exceeds 512 characters, or memory is full;
- a related memory already exists: an active fact of the person or the household with the same `key` or the same content (the same key with the opposite meaning is a conflict and is also not proposed);
- this person declined this `key` within 24 hours;
- a rate limit is reached (§2.4).

The only source is the chat segment: voice (`voiceTurn` takes another path and never calls `maybeSuggest`), task results and model replies never reach it.

### 2.3 RAM only (`SuggestionBook`)

Candidates (card ID, the whole turn the core holds, the candidate, person, epoch, request_id, creation time), rejected keys and rate counters live only in core RAM. Only one candidate is kept at a time, and it **belongs only to the turn that made it**: when each new typed turn starts (`turn()`, except a replay of the same request_id), the previous turn's unanswered suggestion is discarded (`dropPending`, not counted as declined; review m1, 16 §11). Drop points:

| Trigger | Wiring |
| --- | --- |
| 24 hours | expired entries are removed on every access |
| Epoch change (switching person, suspension, 30 minutes idle, OS lock, main-window navigation, correction, forgetting, consent revocation, deleting a family member) | `replacePresence` → `suggestions.clear()` |
| Memory off, memory-layer close, memory disabled after a failed write | cleared together with MEM-4c's `dropPlaintext` |
| Memory suggestions turned off | `suggestionsOp` |
| Core shutdown | `shutdown` |

`clear()` drops candidates and rejected keys and keeps the rate counters (time and epoch only, no content), so the daily limit holds across epochs. Unconfirmed candidates are not in `MemoryData.facts`, so they never reach retrieval, `ContextFact` or a model payload. Logs contain only "記憶建議 1 筆（主題 food）" (1 memory suggestion, topic food), the reason for skipping, and outcomes such as "記住 → saved", never content.

### 2.4 Rate limits

1 per turn (structurally only one is returned); at most 3 within one hour in the same epoch; at most 10 within 24 hours across epochs; a declined `profileId + key` is not proposed again for 24 hours. The counter increases when a suggestion is made, whether or not it is answered.

### 2.5 Presentation and writing

- `MemoryTurnView` gains `suggestion: { card } | null`. The turn response carries only the card ID (`mc_` format); the content goes only through the existing `card_view` IPC (`{ kind: "suggestion", card, text, value, subject_name }`). There is no SSE event.
- It does not block chat: the page sends the turn's chat as usual (with `memory_turn`). Only after the reply stream **completes** (`complete`) does `SuggestionPrompt` (`src/memory-view.ts`) fetch the content through `card_view` and add one line under that same reply: "要記住『我不吃香菜』嗎？［記住］［不用］" (English: “Remember “I don't eat cilantro”? [Remember] [No thanks]”). The line carries `data-request-id` (the same turn) and `data-visibility-reason="user_request"` and lives inside the conversation Surface; it is not a new resident Surface. It does not appear when the reply fails or is interrupted, and it is removed on an epoch change.
- "Remember" sends `card_answer` with `confirm`. The core checks again (flag, setting and memory still on, not a minor, no same or related memory yet, same epoch and person, not expired), takes a direct input with `observeConfirmation` on the whole turn stored with the card, re-parses with `suggestionBodies` in `issueParsed`, issues the ticket only if the result matches the command exactly, and writes `source.kind: "suggestion"` under the current person with no expiry. The line then shows the core's receipt ("Saved for George: 不吃香菜").
- "No" sends `decline`. The rejected key is recorded (24 hours, RAM only), nothing is written, and the line disappears.
- A card can be answered only once. No suggestion is ever applied automatically.
- Review n3: confirmation was not changed to require `userInitiated`. In the core, `userInitiated` only means "the menu bar was clicked within 10 seconds"; at the IPC layer a click on a page button cannot be told apart from page script. Like every other memory card, the trust boundary is the IPC sender check (main window, main frame) plus the page forwarding only the user's clicks.

### 2.6 Snapshot version 4 (`server/memory/store.ts`)

| Field | version 2／3 | version 4 |
| --- | --- | --- |
| `settings.suggestions` | `false` only | boolean |
| `fact.source.kind` | `explicit`, `voice_confirmed` | plus `suggestion` |
| `fact.source.by` | absent | `string \| null`; may be non-null only on household facts and must name an existing person |
| `fact.kind` | `preference`, `note` | plus `work_summary` (behaviour comes in MEM-5b) |
| `fact.derivedFrom` | absent | `{ taskId } \| null`; may be non-null only for `work_summary` |

- In RAM everything has the version 4 shape (`normalizeSnapshot` adds `by: null` and `derivedFrom: null` to older files, appended last).
- On write, `diskForm` picks the version: version 4 only when version-4-only content exists (suggestions `true`, a `suggestion` source, a non-null `by`, a `work_summary` or a `derivedFrom`); otherwise version 3 if there are protected results (or it was written as 3 before) and version 2 for the rest, removing `by` and `derivedFrom` (and version 2's `results`), byte-identical in field order to MEM-4c (the comparison test in §5 performs the same operation with the MEM-4c store and the decrypted plaintexts are identical).
- Version 4 is **not one-way**: once that content is gone (suggestions off, those facts forgotten or corrected, the noting person deleted), the next write goes back to 2／3 and an older App can read the file again. This differs from version 3 (once written, 3 never returns to 2).
- Review n2: when the file leaves version 4 and there are no protected results, it goes straight to 2 (skipping 3). This is safe: 3 only adds `results`, and without results version 2 holds the complete content; older Apps read both.
- Review n1: "byte-identical" refers to the **snapshot** (the decrypted plaintext and the version). The IPC shape changes even with the flag off: `MemoryTurnView` gains `suggestion: null`, `MemoryFactView` gains `by_name: null`, and `MemoryStatusView` gains `suggestions`.
- Review m4: until MEM-5b, `work_summary` can be stored but retrieval (`retrieve.ts`) never sends it to a model, and the lists, the inspect card and chat correct／forget targets do not include it (`shownKind`), so it is neither sent nor mislabelled after a later rollback from MEM-5b.
- **An older App reading version 4**: stores before MEM-5a accept only 1, 2 and 3. They treat 4 as corrupt (`corrupt`), disable memory (the screen shows "The memory file is damaged or was changed and cannot be decrypted; it will not be overwritten with an empty memory") and **do not overwrite** the file. §5 verifies this with the unchanged store from `7fc7d09`. Before downgrading, turn suggestions off and forget or correct the `suggestion`-sourced facts and the facts with `by` (or accept that the older version disables memory).

### 2.7 Family collaboration (minimal)

- Suggestions are saved only under the current person and never propose household facts.
- While the `suggest` flag is on, new household facts (choosing "save for household" in chat or voice, correcting a household fact in chat) record `source.by`: the person selected at that time, or null when none is selected. With the flag off it is always null (the snapshot stays version 2／3).
- Review M5: **additions and edits from the memory manager always record null** (the manager does not mean the current person is speaking), and **so does a current person who is a minor**.
- It is shown only when viewing memory (the "你記得我什麼？" card and the memory manager): "Household · noted by George · 2026/10/30 10:00", with a line under the list: "“Noted by” only records the person selected at that time; it is not identity verification." Both languages are provided.
- No push or notification to other family members; relayed statements ("媽媽不喝咖啡，幫她記住") are still refused; no suggestions for minors.
- When a person is deleted, `by` on household facts that this person noted is cleared to null (deleting a person also deletes this link).

### 2.8 Flags and settings

- `server/config.ts`: the `NOUS_MEMORY_ROUTES` whitelist gains `suggest`, and `memoryRoutes.suggest` defaults to `false`; `server/nous.ts` passes it to `MemoryService` (option `suggest`) and logs the state at startup.
- New IPC op `suggestions` (`{ enabled, token }`, in `desktop/memory-ipc.mjs` and `shared/memory.ts`): only the memory manager's token may use it; turning it on also needs the flag, otherwise the reply is "Memory suggestions are not available (NOUS_MEMORY_ROUTES must list suggest)"; turning it off drops the candidates in RAM. `setup` (memory on/off, consent changes) keeps the suggestions setting.
- The memory manager shows "Memory suggestions: off (default). [Turn on memory suggestions]" with an explanation; without the flag it shows "Memory suggestions: not available (NOUS_MEMORY_ROUTES does not list suggest).", and if suggestions were turned on before (the setting is still `true`) a "Turn off memory suggestions" button is still shown so they can be turned off before downgrading (review m2). The fourth option on the first-time setup card remains a disabled checkbox, now worded "Suggest memories automatically (off by default; turn it on from “Memory…” in the menu bar)".
- `MemoryStatusView.suggestions`: `{ available, enabled }` (absent while the memory file is not loaded).

### 2.9 Interface copy (bilingual)

New page copy is in `src/messages.en.json` and the core's fixed sentences are in `server/messages.en.json`: the suggestion line and buttons, the accessible label "記憶建議" (Memory suggestion), the `title` hint "只有按「記住」才會保存；不會自動記住。" (Saved only if you press “Remember”; nothing is remembered automatically.), the source "記憶建議（按了記住）", "全家共用・由 {0} 記下・{1}" with its note, the manager switch and explanation, and the core receipts (review n4: the line keeps the fixed sentences and re-translates them when the language changes; OK, I won't remember that; memory suggestions are off, nothing was saved; a related memory already exists: {0}; memory suggestions on/off; not available). `tests/memory-view.test.ts` checks that the English interface contains no leftover Chinese (other than the user's own words).

## 3. Design decisions (all pending George's confirmation)

| # | Decision (conservative default) | Reason | Pending George's confirmation |
| --- | --- | --- | --- |
| D1 | Only sentences in the fixed topic lexicon (food, comfort, reply_style, schedule, media) are proposed; names, relationships, colours, pets and naming never are | 16 §1: no guessing about personality or family relationships; fewer suggestions are better than wrong ones | Pending George's confirmation |
| D2 | Whole-turn exclusion (changed from whole-segment after review M1): a third party, reported speech, quote, hypothetical, joke or sarcasm, uncertainty, sensitive data, health, a special category, proxy framing, past tense or tag question anywhere means nothing in the turn is proposed | Avoids saving for the wrong person or with the wrong meaning | Pending George's confirmation |
| D3 | Temporal words are checked in every non-question clause of the turn; a temporal word inside a question clause does not count ("我不吃香菜，今天晚餐吃什麼？" proposes "不吃香菜"; "我不喝咖啡。這週而已。" does not) | The most common use still works, and temporal remarks in another sentence are not missed | Pending George's confirmation |
| D4 | A trailing 了 is not proposed (except "以後都…了"); positive 吃／喝 count only after 都, 只 or 習慣; English eat and drink only after always, usually, only or never | "我不吃了" and "我吃牛肉" are not stable preferences | Pending George's confirmation |
| D5 | When the next clause looks like the same enumeration, nothing is proposed | Saving only the first half would be wrong | Pending George's confirmation |
| D6 | The value saved is the same as an explicit "remember…" (Chinese drops the leading 我, English keeps the clause); the line shows the sentence as typed | Keeps the user's own words (16 §5) | Pending George's confirmation |
| D7 | No suggestion when the same `key` or the same content exists (the person's or the household's), including the opposite statement; English keys are coarse (for example `food:Idon`) and block a few more | Conflicts are left to the user's "更正…"; suggestions do not touch them | Pending George's confirmation |
| D8 | Only one candidate at a time; a new turn's suggestion discards the previous one (not counted as declined) | The line belongs to that turn's reply only | Pending George's confirmation |
| D9 | On an epoch change the rejected keys are dropped too (as instructed), so after switching person or correcting, a declined sentence may be proposed once more, bounded by the rate limits | Privacy first: rejected keys contain content too | Pending George's confirmation |
| D10 | The rate counter increases when a suggestion is made; counters live only in RAM and reset on restart | Nothing is written to disk | Pending George's confirmation |
| D11 | The line appears only after the reply **completes**; not on errors or interruptions; after "No" the line disappears; after "Remember" it shows the receipt; there is no extra confirmation | Does not block chat; the click itself is the direct confirmation | Pending George's confirmation |
| D12 | The line reads only "Remember '…'?" without naming the person (the name appears in the receipt and in `card_view`'s `subject_name`) | Follows the specified wording | Pending George's confirmation |
| D13 | Without the flag the manager cannot turn suggestions on; they can be turned off at any time; the setting is kept when memory is turned off and on again; the first-time setup card does not offer it | Both must be on, and turning it on needs the manager token | Pending George's confirmation |
| D14 | `by` is recorded only while the flag is on and only for household facts; correcting a household fact in chat sets `by` to the corrector (cleared to null with the flag off); additions and edits from the memory manager, and a minor as the current person, always give null (review M5); deleting the person clears it | "Who last wrote it in chat" matches what viewers expect; the manager and minors are never named | Pending George's confirmation |
| D15 | Version 4 is written only while version-4 content exists and returns to 2／3 once it is gone (unlike the one-way version 3) | Lets older Apps read the file whenever possible | Pending George's confirmation |
| D16 | Memories saved from a suggestion are sent to models with `ContextFact.source` `"suggestion"` | States the source honestly | Pending George's confirmation |
| D17 | Health terms include diet, weight and 減肥; past tense includes before and once | Fewer suggestions are better than wrong ones | Pending George's confirmation |
| D18 | The excerpt is the whole turn (≤240 characters), otherwise the value | Same as an explicit remember | Pending George's confirmation |
| D19 | The candidate must be the first clause of the turn, or be preceded only by question or request clauses (review M2) | A preceding statement often changes who is speaking or why | Pending George's confirmation |
| D20 | Proxy, relaying, translation, role play, sentence-making exercises, homework, age ("我五歲") and framings such as here, this is and for my block the whole turn; so do religion, politics, addiction and abstinence (review M2, M3) | Avoids saving for the wrong person, saving special-category data, or saving for a minor | Pending George's confirmation |
| D21 | Objects are limited to 12 Chinese characters or 4 English words, and an object containing a condition, reason or period is not proposed (review M3) | Saves only short preferences and keeps reasons or periods (possibly health or religion) out of the value | Pending George's confirmation |
| D22 | A suggestion belongs only to the turn that made it and is discarded when the next turn starts (review m1) | 16 §11: dropped when the conversation ends | Pending George's confirmation |
| D23 | Until MEM-5b, `work_summary` is neither listed nor retrieved (review m4) | Its rules come in MEM-5b | Pending George's confirmation |
| D24 | "Remember" does not require `userInitiated` (review n3, not feasible; reason in §2.5) | The same trust boundary as other memory cards | Pending George's confirmation |

## 4. Offline metrics

### 4.1 Test sets

- `tests/fixtures/memory-candidates.zh.json` (123 sentences, 45 should be proposed) and `tests/fixtures/memory-candidates.en.json` (79 sentences, 26 should be proposed). Each sentence is labelled with whether it should be proposed, the expected value, attribution (self／third／household／none), timing (stable／today／temporary／past) and the negative category.
- **Honest statement: these two sets were written alongside the rules and are not an independent evaluation set.** The labels say what should happen, not what the rules output (which is why 9 sentences that should be proposed are not), but the same author wrote the rules and the sentences, so the 100% precision mostly shows that the rules cover the cases the author could think of.
- **Holdout**: `tests/fixtures/memory-candidates.holdout.json` (30 sentences, 9 should be proposed) was written while `suggest.ts` did not yet exist and has not been edited since (SHA-256 `b0a6414599d61a4f80adafaab7295306c716d524c93f1b2a3220aa9ab4331b8e`, computed when written, after the rules were first finalized and after the review fixes, identical each time). It was run once after the first finalization; the review fixes changed the rules, so it was run again (same result). The holdout was written by the same author and has only 30 sentences, so it cannot count as an independent evaluation either.
- **Adversarial set (review m3)**: `tests/fixtures/memory-candidates.adversarial.json`, the reviewer's 76 sentences (11 should be proposed), with expected values and categories copied from the reviewer's `probe.ts` (attribution: proxy, relaying, translation and role play are labelled third; categories mentioning sensitive, health or religion count as special categories). **Before the fixes** (review report, per-segment flow): 51 proposals, 10 correct, precision 10/51 = 19.6%, false-memory rate 41/51 = 80.4%, and 41 of the 65 should-not-propose sentences (63.1%) were proposed. The rules were then **tuned against this set, so it is no longer an independent evaluation set**.

### 4.2 Definitions (computed by `metrics` in `tests/memory-suggest.test.ts`)

- proposals = sentences for which a candidate was proposed.
- correct = should be proposed, the value matches exactly, attribution is self and timing is stable (candidates are always saved under the current person with no expiry).
- **precision = correct / proposals**.
- **false-memory rate = (negatives proposed + proposals with the wrong value, person or expiry) / proposals**.
- recall = correct / sentences that should be proposed (reported only, no threshold).
- False positives per negative category; person misattribution = a proposal whose attribution is not self.
- Special-category leak = negatives whose label mentions sensitive, health, religion or politics that were proposed.
- Thresholds: precision ≥ 95% for zh, en and combined, 0 false positives in every category and 0 person misattributions; on the adversarial set precision ≥ 90%, 0 person misattributions and 0 special-category leaks (review m3). Everything is computed with the same whole-turn flow as the service (`suggestFrom`).

### 4.3 Results (numbers printed by `npx vitest run tests/memory-suggest.test.ts -t "reports the computed" --silent=false`)

| Set | Sentences | Should propose | Proposed | Correct | Precision | False-memory rate | Recall | Person misattribution | Category false positives |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zh | 123 | 45 | 42 | 42 | 42/42 = 100% | 0/42 = 0% | 42/45 = 93.3% | 0 | all 0 (15 categories) |
| en | 79 | 26 | 20 | 20 | 20/20 = 100% | 0/20 = 0% | 20/26 = 76.9% | 0 | all 0 (15 categories) |
| zh + en | 202 | 71 | 62 | 62 | 62/62 = 100% | 0/62 = 0% | 62/71 = 87.3% | 0 | all 0 |
| holdout (reported separately) | 30 | 9 | 9 | 9 | 9/9 = 100% | 0/9 = 0% | 9/9 = 100% | 0 | all 0 (9 categories) |
| adversarial, before the fixes (review report) | 76 | 11 | 51 | 10 | 10/51 = 19.6% | 41/51 = 80.4% | 10/11 | yes | 41 false positives |
| adversarial, after the fixes (tuned against it, not independent) | 76 | 11 | 11 | 11 | 11/11 = 100% | 0/11 = 0% | 11/11 = 100% | 0 | all 0; 0 special-category leaks |

Negative categories: third_party, household, quote, hypothetical, joke, sensitive, health, past, temporal, question, uncertain, deictic, request, off_topic, not_preference.

The 9 misses (the recall gap; all are omissions, none is a wrong proposal): "我都十一點睡覺" and "我早上都喝拿鐵" (adverb position outside the pattern), "我不吃豬肉，牛肉" and "I don't eat pork, beef or lamb" (enumerations, D5), "I love sushi", "I hate onions", "I usually go to bed at 11" and "I avoid caffeine" (words missing from the English topic lexicon, D1), and "I keep the AC at 26 degrees" (verb outside the pattern).

The zh, en and holdout numbers are the same before and after the fixes (the new exclusions block no sentence that should be proposed). Per-sentence results are in the appendix (§9).

## 5. Cloud (Linux) validation

Node.js 22 in a cloud container. Real AES-256-GCM, real rename／fsync, and `flock(1)` as the test lock on Linux; only the data-key wrapping is fake (`fakeBox`; the production App uses safeStorage／Keychain). No model is called.

| Test file | Coverage |
| --- | --- |
| `tests/memory-suggest.test.ts` (new, 49; 92 after the review) | Metrics (§4: the threshold for each set and the computed numbers, with the holdout reported separately); complete fixture labels; determinism (the same sentence twice gives the same result, fixed ticket body); 32 negatives each mapped to its reason (third party, reported speech, quote, hypothetical, joke, sensitive, uncertain, health, past, temporal, question, demonstrative, request, off topic, enumeration, household); `SuggestionBook` hourly／daily limits, 24-hour decline, `clear` keeping counters, only the newest candidate kept and 24-hour expiry; service: a typed turn proposes, the turn carries only the card ID, `card_view` returns the content, chat still carries `memory_turn`, "Remember" writes `source.kind: "suggestion"`, the snapshot becomes 4, the card works once, and no further suggestion after saving; "No" leaves the snapshot plaintext byte-for-byte unchanged, the same key is not proposed again, other sentences still are; service-level rate limits (1 per turn, 3 per hour per epoch, 10 per day across epochs); no suggestion with the flag off (cannot be enabled either), with the setting off, with no person selected, while suspended, for a minor, for live voice (`voiceTurn` creates no candidate), with an explicit memory command in the same turn, with an open memory card, after turning suggestions off (candidate discarded), or with memory off; existing same or conflicting facts (own and household); **canary**: the turn's `suggestion` field, `withChat`'s `ContextFact`, the decrypted snapshot on disk (also after close) and all logs contain no canary; only `card_view` does; 24-hour expiry and card invalidation after OS lock and a forget-driven epoch change, and an invalid card cannot write; `by`: with the flag on, a household addition records "George", shown on the inspect card and in the manager list, absent on personal facts, cleared after deleting George and written back as version 2; with the flag off, no `by`, snapshot version 2, and the plaintext has no `"by"` or `"derivedFrom"` |
| Review regressions (`tests/memory-suggest.test.ts`) | Adversarial thresholds and numbers; 42 new negatives mapped to their reasons (cross-sentence joke, sarcasm, reported speech, temporal, explicit command, proxy, translation, role play, age, form of address, a preceding statement, conditions and periods in the object, special categories, health, emoji, 應該吧, ﹖, long objects); curly apostrophes kept as typed; whole-turn judgement and next-turn discard in the service (a discard is not a decline; after saving, the excerpt is the whole turn); `by`: a manager addition records null, choosing "save for household" in chat records George, a minor gives null |
| `tests/memory-parse.test.ts` (+3, review M4) | Chinese and English PIN／SSN sentences are refused; spinach, pineapple, shopping and piano lessons are not misflagged; `parse.ts` contains no control characters |
| `tests/memory-retrieve.test.ts` (+1, review m4) | `work_summary` is never sent to a model |
| `tests/memory-store.test.ts` (+5) | Version 4 round trip (suggestion setting, suggestion source, `by`, `work_summary` and `derivedFrom`); version 4 validation (`derivedFrom` only on `work_summary`, taskId format, `by` must be an existing person and only on household facts, unknown source) all return conflict without writing; tampering (envelope version 4→3, 4→5, one flipped ciphertext bit) is always corrupt and never overwritten; **without version 4 content, performing the same operation with the unchanged MEM-4c store (`tests/fixtures/memory-store-7fc7d09.ts`) gives byte-identical decrypted plaintext for versions 2 and 3**; version 3 becomes 4 when suggestions are turned on (results kept), **the MEM-4c store returns corrupt on version 4 and the file stays byte-for-byte unchanged**, turning suggestions off returns to 3, and the older store can read it again |
| `tests/memory-view.test.ts` (+4, DOM stand-in; review m2 and n4 added inside existing tests) | The suggestion line appears only after the same turn's reply completes, fetches the content through `card_view` first, carries `data-request-id` and `user_request`, Chinese and English text and buttons, the `title` hint; "Remember" sends `confirm` and shows the receipt, "No" sends `decline` and disappears, nothing after `clear`, nothing in the browser build; "Household · noted by George · date" with the not-identity-verification note (both languages); the manager switch needs the token and states honestly when it is not available (both languages), and offers "Turn off memory suggestions" when the flag is off but suggestions are still on; the receipt is re-translated when the language changes |
| `tests/memory-ipc.test.ts` (adjusted) | The `suggestions` op keeps only `enabled` and `token` and is refused without a token or with the wrong type |
| `tests/apikey-route.test.ts` (adjusted) | `suggest` in `NOUS_MEMORY_ROUTES` is off by default and can be listed with other values |
| `tests/memory-retrieve.test.ts`, `tests/memory-service.test.ts`, `tests/memory-store.test.ts`, `tests/memory-view.test.ts` (adjusted) | Test data gains the `by`, `derivedFrom`, `by_name` and `suggestion` fields |
| `tests/fixtures/memory-service.ts`, `tests/fixtures/memory-store-7fc7d09.ts` | The harness accepts `suggest` and `log`; the unchanged MEM-4c store (stands in for the older App; do not edit) |

Time-dependent assertions use an injected clock; there are no wall-clock limits.

### Test results (actual output of this batch)

```text
npm run typecheck                      (no errors)
npx vitest run (run 1)                 Test Files  93 passed (93)
                                       Tests  1712 passed | 4 skipped (1716)
npx vitest run (run 2)                 Test Files  93 passed (93)
                                       Tests  1712 passed | 4 skipped (1716)
npx vite build                         ✓ built
node --check desktop/*.mjs (each)      (no errors)
node scripts/verify-aios.mjs           PASS (its full suite, run 3: 93 files, 1712 passed, 4 skipped)
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed
node scripts/check-pstack.mjs          pstack 0.15.29: 172 upstream hashes, 56 skills in both clients, agents and model roles verified.
git diff --check                       (no output)
```

The baseline main `7fc7d09` has 92 test files, 1607 passed and 4 skipped; this batch adds 105 tests (58 in the first round: 49 in the new test file, 5 for the store, 4 for the view; 47 review regressions: 43 for suggestions, 3 for the parser, 1 for retrieval). These are the actual outputs after the review fixes.

## 6. Mac gate (none executed; no pass may be claimed)

Prerequisites: a signed App; the MEM-1 Mac steps done; `suggest` added to `NOUS_MEMORY_ROUTES` in `.env`; the fictional person George (another person, Amy, for switching); logging on.

1. **Enable flow**: the startup log contains "記憶建議已放行（NOUS_MEMORY_ROUTES，另需在「記憶…」開啟；Mac gate 尚未通過）" (memory suggestions released; must also be turned on in "Memory…"; Mac gate not passed). Open "Memory…" from the menu bar: it shows "Memory suggestions: off (default)." Press "Turn on memory suggestions"; the receipt is "Memory suggestions are on…". Remove `suggest` and restart: the manager shows "not available" and has no turn-on button.
2. **Single-line suggestion**: with George selected, type "我不吃香菜，晚餐吃什麼？": no suggestion while the reply streams; after the reply completes, one line appears under that same reply, "要記住『我不吃香菜』嗎？［記住］［不用］", not a new view and not blocking the next turn. Take one screenshot each in the Chinese and English interface. Press "Remember": the line becomes "Saved for George: 不吃香菜"; "你記得我什麼？" shows the source "memory suggestion (you pressed Remember)". For another sentence press "No": the line disappears and saying the same sentence again shows nothing.
3. **Where it must not appear**: the same sentence over live voice; no person selected; George marked as a minor; "記住我不喝咖啡。我不吃洋蔥" in one turn; "我媽不吃辣", "我以前不吃香菜", "我今天不想吃辣", "我對花生過敏", "我不吃香菜。開玩笑的。", "我爸要我跟你說，我不吃豬肉", "我不吃牛肉因為我拜觀音": no suggestion in any of these. Also, after "我不吃洋蔥" shows a suggestion, do not answer it and type the next turn: the earlier suggestion disappears.
4. **Persistence**: quit and reopen the App: the fact saved with "Remember" is still there and the suggestions setting is still on; earlier unanswered suggestions are gone.
5. **Family collaboration**: with George selected, add a household fact in the memory manager: "你記得我什麼？" and the manager show "Household · noted by George · date" and the not-identity-verification note (both languages); Amy receives no push or notification. After deleting George's memory profile, that fact no longer shows "noted by George".
6. **One week of real counts**: use the App normally for a week and record daily the number of log lines "記憶建議 1 筆", "記住 →", "不用" and "略過（頻率上限…）" (`grep -c`), and note by hand every wrong suggestion (wrong person, wrong meaning, something that should not be saved). Compute the acceptance rate = Remember / proposed and the number of wrong suggestions. Record them as they are; George decides whether to expand or turn it off.
7. **An older App reading version 4**: first copy `userData/memory/` (including `store.v1.enc`) and record `shasum -a 256`. Open that copy with an App built from main `7fc7d09`: memory is unavailable (the screen says the memory file is damaged or was changed and will not be overwritten), and the SHA-256 of `store.v1.enc` is unchanged. The MEM-5a App still works. Then turn suggestions off and forget the facts from suggestions and those with `by` (or correct them with `suggest` removed), confirm the file is back to version 2／3, and confirm the older App can read it again.
8. **Canary**: trigger a suggestion with a sentence containing a canary, press "No", and `grep -r` the logs and `userData/`: no canary (the snapshot is encrypted anyway; this step is mainly about logs).

## 7. Unfinished items and the next gate

- Mac steps 1–8 in §6, especially step 2 (the real screen), step 6 (one week of real counts) and step 7 (the older App).
- MEM-5b (`work_summary`): the snapshot format is already in version 4; the behaviour comes in the next batch.
- Questions for George: D1–D24 in §3, and whether to enlarge the English topic lexicon (English recall is currently 76.9%).

## 8. Residual risks

- **The test sets are not independent.** The 202-sentence fixtures and the 30-sentence holdout were written by the same author; the reviewer's 76-sentence adversarial set had 19.6% precision before the fixes, and the rules were then tuned against it, so the 100% after the fixes does not mean real-world precision either. The next unseen adversarial set will likely find more gaps. The one-week count in step 6 will be the first real data.
- **Low recall is deliberate**, and lower for English (small topic lexicon).
- **(Fixed, review M4)** This item was wrong before: since MEM-1, `SENSITIVE` in `parse.ts` had literal 0x08 control characters around `pin` and `ssn` instead of `\b`, so "記住我的 PIN 是 4821" was actually saved as a memory, and words like spinach were never misflagged. This batch uses a real `\b` and adds Chinese and English tests plus a check that `parse.ts` contains no control characters. Such memories already saved by older versions are not deleted automatically; users need to check them.
- **The rules are still word lists**: new phrasings (new sarcasm, dialect, typos, unlisted religious or health terms) can slip past the exclusions and be proposed; each one still needs a click on "Remember", and the line shows exactly the sentence to be saved.
- **Whole-turn exclusion lowers recall further**: any excluded word anywhere in the turn (for example "doctor" or "this week" in another clause) blocks the whole turn.
- **The person typing may not be the current person.** If a guest or another family member types "我不吃豬肉" while George is selected and presses "Remember", it is saved under George; the line does not name the person (D12), only the receipt does.
- **Text pasted from someone else** (without quotation marks) is treated as first person.
- **`by` comes from a self-declared identity**: saying "我是 X" makes X the noting person; the screen states that this is not identity verification.
- **Version 4 makes older Apps disable memory** (without overwriting); a household fact with `by` keeps the file at 4 until it is forgotten, corrected (with the flag off) or the noting person is deleted.
- **The page DOM** holds the sentence until it is answered or the epoch changes (renderer memory, not a secure wipe).
- **An epoch change drops the rejected keys** (D9), so the same thing may be proposed once more; the 10-per-day limit still applies, but it resets on restart.
- **English keys are coarse** (D7): they block a few more suggestions than Chinese, but never cause a wrong proposal.

## 9. Appendix: per-sentence results (rules after the review fixes)

Columns: #, sentence, labels (attribution／timing), expected (value or negative category), actual (value or reason for not proposing), verdict (OK, MISS = should have been proposed but was not, FP = proposed but should not have been). Generated with the same rules as `tests/memory-suggest.test.ts`.

### 9.1 zh (123 sentences)

| # | Sentence | Labels | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | 我不吃香菜 | self/stable | `不吃香菜` | `不吃香菜` | OK |
| 2 | 我不吃香菜，晚餐吃什麼好？ | self/stable | `不吃香菜` | `不吃香菜` | OK |
| 3 | 我不喝咖啡 | self/stable | `不喝咖啡` | `不喝咖啡` | OK |
| 4 | 我不喝牛奶，有什麼早餐推薦 | self/stable | `不喝牛奶` | `不喝牛奶` | OK |
| 5 | 我喜歡吃辣 | self/stable | `喜歡吃辣` | `喜歡吃辣` | OK |
| 6 | 我很喜歡日式料理 | self/stable | `很喜歡日式料理` | `很喜歡日式料理` | OK |
| 7 | 我討厭洋蔥 | self/stable | `討厭洋蔥` | `討厭洋蔥` | OK |
| 8 | 我最討厭吃苦瓜 | self/stable | `最討厭吃苦瓜` | `最討厭吃苦瓜` | OK |
| 9 | 我習慣早睡 | self/stable | `習慣早睡` | `習慣早睡` | OK |
| 10 | 我習慣七點起床 | self/stable | `習慣七點起床` | `習慣七點起床` | OK |
| 11 | 我都喝無糖的茶 | self/stable | `都喝無糖的茶` | `都喝無糖的茶` | OK |
| 12 | 我只喝黑咖啡 | self/stable | `只喝黑咖啡` | `只喝黑咖啡` | OK |
| 13 | 我吃素 | self/stable | `吃素` | `吃素` | OK |
| 14 | 我是素食者 | self/stable | `是素食者` | `是素食者` | OK |
| 15 | 我不吃海鮮 | self/stable | `不吃海鮮` | `不吃海鮮` | OK |
| 16 | 我怕熱，冷氣要開幾度？ | self/stable | `怕熱` | `怕熱` | OK |
| 17 | 我怕辣 | self/stable | `怕辣` | `怕辣` | OK |
| 18 | 我喜歡簡短的回答 | self/stable | `喜歡簡短的回答` | `喜歡簡短的回答` | OK |
| 19 | 我比較喜歡詳細一點的解釋 | self/stable | `比較喜歡詳細一點的解釋` | `比較喜歡詳細一點的解釋` | OK |
| 20 | 我不喜歡太長的回覆 | self/stable | `不喜歡太長的回覆` | `不喜歡太長的回覆` | OK |
| 21 | 我喜歡聽爵士音樂 | self/stable | `喜歡聽爵士音樂` | `喜歡聽爵士音樂` | OK |
| 22 | 我愛看電影 | self/stable | `愛看電影` | `愛看電影` | OK |
| 23 | 我不太喜歡恐怖電影 | self/stable | `不太喜歡恐怖電影` | `不太喜歡恐怖電影` | OK |
| 24 | 我以後都不喝含糖飲料了 | self/stable | `以後都不喝含糖飲料` | `以後都不喝含糖飲料` | OK |
| 25 | 以後我都不吃宵夜 | self/stable | `以後我都不吃宵夜` | `以後我都不吃宵夜` | OK |
| 26 | 我一向不吃牛肉 | self/stable | `一向不吃牛肉` | `一向不吃牛肉` | OK |
| 27 | 我真的很討厭香菜 | self/stable | `真的很討厭香菜` | `真的很討厭香菜` | OK |
| 28 | 我不吃香菜、洋蔥 | self/stable | `不吃香菜、洋蔥` | `不吃香菜、洋蔥` | OK |
| 29 | 我偏好清淡的口味 | self/stable | `偏好清淡的口味` | `偏好清淡的口味` | OK |
| 30 | 我很少喝酒 | self/stable | `很少喝酒` | `很少喝酒` | OK |
| 31 | 我不碰辣椒 | self/stable | `不碰辣椒` | `不碰辣椒` | OK |
| 32 | 我愛喝奶茶，推薦一家店吧 | self/stable | `愛喝奶茶` | `愛喝奶茶` | OK |
| 33 | 我喜歡冷氣開 26 度 | self/stable | `喜歡冷氣開 26 度` | `喜歡冷氣開 26 度` | OK |
| 34 | 我喜歡燈光暗一點 | self/stable | `喜歡燈光暗一點` | `喜歡燈光暗一點` | OK |
| 35 | 我不喜歡太甜的飲料 | self/stable | `不喜歡太甜的飲料` | `不喜歡太甜的飲料` | OK |
| 36 | 我都十一點睡覺 | self/stable | `都十一點睡覺` | — (no_match) | MISS |
| 37 | 我早上都喝拿鐵 | self/stable | `早上都喝拿鐵` | — (no_match) | MISS |
| 38 | 我不愛吃青菜 | self/stable | `不愛吃青菜` | `不愛吃青菜` | OK |
| 39 | 我喜歡看棒球 | self/stable | `喜歡看棒球` | `喜歡看棒球` | OK |
| 40 | 我從來不喝汽水 | self/stable | `從來不喝汽水` | `從來不喝汽水` | OK |
| 41 | 我不吃豬肉，可以推薦晚餐嗎？ | self/stable | `不吃豬肉` | `不吃豬肉` | OK |
| 42 | 我討厭吵的餐廳 | self/stable | `討厭吵的餐廳` | `討厭吵的餐廳` | OK |
| 43 | 我不吃豬肉，牛肉 | self/stable | `不吃豬肉，牛肉` | — (list) | MISS |
| 44 | 我喜歡條列式的回答 | self/stable | `喜歡條列式的回答` | `喜歡條列式的回答` | OK |
| 45 | 我不吃早餐 | self/stable | `不吃早餐` | `不吃早餐` | OK |
| 46 | 我媽不吃辣 | third/stable | — (third_party) | — (third_party) | OK |
| 47 | 我老公不喝咖啡，晚餐煮什麼 | third/stable | — (third_party) | — (third_party) | OK |
| 48 | 我兒子討厭青椒 | third/stable | — (third_party) | — (third_party) | OK |
| 49 | 他不吃香菜 | third/stable | — (third_party) | — (third_party) | OK |
| 50 | 她說她不喝酒 | third/stable | — (third_party) | — (third_party) | OK |
| 51 | 朋友說我不吃辣 | third/stable | — (third_party) | — (third_party) | OK |
| 52 | 我跟他說我不吃牛肉 | third/stable | — (third_party) | — (third_party) | OK |
| 53 | 我女兒喜歡草莓 | third/stable | — (third_party) | — (third_party) | OK |
| 54 | 我朋友都不吃海鮮 | third/stable | — (third_party) | — (third_party) | OK |
| 55 | 我同事喜歡喝拿鐵 | third/stable | — (third_party) | — (third_party) | OK |
| 56 | 我的貓不吃魚 | third/stable | — (third_party) | — (no_match) | OK |
| 57 | 我男朋友不吃香菜 | third/stable | — (third_party) | — (no_match) | OK |
| 58 | 我們家不吃牛肉 | household/stable | — (household) | — (no_match) | OK |
| 59 | 我們都喜歡吃辣 | household/stable | — (household) | — (no_match) | OK |
| 60 | 全家都不喝酒 | household/stable | — (household) | — (no_match) | OK |
| 61 | 我家都習慣早睡 | household/stable | — (household) | — (no_match) | OK |
| 62 | 「我不吃香菜」是他常說的話 | third/stable | — (quote) | — (quote) | OK |
| 63 | 她寫說"我不喝咖啡" | third/stable | — (quote) | — (quote) | OK |
| 64 | 如果我不吃早餐會怎樣 | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 65 | 假設我不喝咖啡，要怎麼提神 | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 66 | 萬一我不喜歡這道菜怎麼辦 | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 67 | 開玩笑的，我不吃飯 | self/stable | — (joke) | — (joke) | OK |
| 68 | 我討厭吃東西，騙你的 | self/stable | — (joke) | — (joke) | OK |
| 69 | 我喜歡用信用卡付款 | self/stable | — (sensitive) | — (sensitive) | OK |
| 70 | 我的密碼是我喜歡的食物 | self/stable | — (sensitive) | — (sensitive) | OK |
| 71 | 我對花生過敏 | self/stable | — (health) | — (health) | OK |
| 72 | 我不吃藥 | self/stable | — (health) | — (health) | OK |
| 73 | 我有糖尿病，不吃甜的 | self/stable | — (health) | — (health) | OK |
| 74 | 我懷孕了，不喝咖啡 | self/temporary | — (health) | — (health) | OK |
| 75 | 醫生說我不能吃辣 | self/stable | — (health) | — (health) | OK |
| 76 | 我在吃藥，不能喝酒 | self/temporary | — (health) | — (health) | OK |
| 77 | 我乳糖不耐，不喝牛奶 | self/stable | — (health) | — (health) | OK |
| 78 | 我在減肥，不吃宵夜 | self/temporary | — (health) | — (health) | OK |
| 79 | 我以前不吃香菜 | self/past | — (past) | — (past) | OK |
| 80 | 我曾經很喜歡喝可樂 | self/past | — (past) | — (past) | OK |
| 81 | 我小時候討厭青椒 | self/past | — (past) | — (past) | OK |
| 82 | 我之前習慣晚睡 | self/past | — (past) | — (past) | OK |
| 83 | 我本來不喝咖啡，現在會喝了 | self/past | — (past) | — (past) | OK |
| 84 | 我今天不想吃辣 | self/today | — (temporal) | — (temporal) | OK |
| 85 | 我最近不喝咖啡 | self/temporary | — (temporal) | — (temporal) | OK |
| 86 | 我這週不吃甜的 | self/temporary | — (temporal) | — (temporal) | OK |
| 87 | 我現在不想喝茶 | self/temporary | — (temporal) | — (temporal) | OK |
| 88 | 我不吃了 | self/temporary | — (temporal) | — (temporal) | OK |
| 89 | 我不喝了，謝謝 | self/temporary | — (temporal) | — (temporal) | OK |
| 90 | 我先不吃宵夜 | self/temporary | — (temporal) | — (temporal) | OK |
| 91 | 我這陣子喜歡喝綠茶 | self/temporary | — (temporal) | — (temporal) | OK |
| 92 | 我暫時不喝酒 | self/temporary | — (temporal) | — (temporal) | OK |
| 93 | 今晚不要辣 | self/today | — (temporal) | — (temporal) | OK |
| 94 | 我不吃辣了 | self/temporary | — (temporal) | — (temporal) | OK |
| 95 | 我今晚想吃火鍋 | self/today | — (temporal) | — (temporal) | OK |
| 96 | 我喜歡香菜嗎 | self/stable | — (question) | — (question) | OK |
| 97 | 我不吃香菜對吧？ | self/stable | — (question) | — (question) | OK |
| 98 | 我是不是不喝咖啡？ | self/stable | — (question) | — (no_match) | OK |
| 99 | 我喜歡吃什麼？ | self/stable | — (question) | — (question) | OK |
| 100 | 我習慣幾點睡？ | self/stable | — (question) | — (off_topic) | OK |
| 101 | 我不吃牛肉嗎？ | self/stable | — (question) | — (question) | OK |
| 102 | 我好像不喜歡香菜 | self/stable | — (uncertain) | — (uncertain) | OK |
| 103 | 我可能不吃辣 | self/stable | — (uncertain) | — (uncertain) | OK |
| 104 | 我大概習慣早睡 | self/stable | — (uncertain) | — (uncertain) | OK |
| 105 | 我喜歡這道菜 | self/temporary | — (deictic) | — (deictic) | OK |
| 106 | 我不喜歡那家餐廳 | self/stable | — (deictic) | — (deictic) | OK |
| 107 | 我喜歡你推薦的歌 | self/stable | — (deictic) | — (deictic) | OK |
| 108 | 我討厭這部電影 | self/stable | — (deictic) | — (deictic) | OK |
| 109 | 我想吃拉麵 | self/temporary | — (request) | — (uncertain) | OK |
| 110 | 我要一杯咖啡 | self/temporary | — (request) | — (request) | OK |
| 111 | 我想喝珍奶 | self/temporary | — (request) | — (uncertain) | OK |
| 112 | 我需要早點睡 | self/temporary | — (request) | — (request) | OK |
| 113 | 我喜歡小美 | self/stable | — (off_topic) | — (off_topic) | OK |
| 114 | 我討厭下雨天 | self/stable | — (off_topic) | — (off_topic) | OK |
| 115 | 我喜歡藍色 | self/stable | — (off_topic) | — (off_topic) | OK |
| 116 | 我怕狗 | self/stable | — (off_topic) | — (off_topic) | OK |
| 117 | 我習慣用左手 | self/stable | — (off_topic) | — (off_topic) | OK |
| 118 | 我吃過晚餐了 | self/past | — (not_preference) | — (no_match) | OK |
| 119 | 我在吃飯 | self/temporary | — (not_preference) | — (request) | OK |
| 120 | 晚餐吃什麼好 | none/stable | — (not_preference) | — (no_match) | OK |
| 121 | 我吃了一碗麵 | self/past | — (not_preference) | — (no_match) | OK |
| 122 | 幫我找附近的咖啡店 | none/stable | — (not_preference) | — (no_match) | OK |
| 123 | 你喜歡吃什麼？ | none/stable | — (not_preference) | — (no_match) | OK |

### 9.2 en (79 sentences)

| # | Sentence | Labels | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | I don't eat cilantro | self/stable | `I don't eat cilantro` | `I don't eat cilantro` | OK |
| 2 | I don't eat cilantro, what should I cook tonight? | self/stable | `I don't eat cilantro` | `I don't eat cilantro` | OK |
| 3 | I don't drink coffee | self/stable | `I don't drink coffee` | `I don't drink coffee` | OK |
| 4 | I do not drink alcohol | self/stable | `I do not drink alcohol` | `I do not drink alcohol` | OK |
| 5 | I like spicy food | self/stable | `I like spicy food` | `I like spicy food` | OK |
| 6 | I really like Japanese food | self/stable | `I really like Japanese food` | `I really like Japanese food` | OK |
| 7 | I love sushi | self/stable | `I love sushi` | — (off_topic) | MISS |
| 8 | I prefer short answers | self/stable | `I prefer short answers` | `I prefer short answers` | OK |
| 9 | I prefer detailed replies | self/stable | `I prefer detailed replies` | `I prefer detailed replies` | OK |
| 10 | I hate onions | self/stable | `I hate onions` | — (off_topic) | MISS |
| 11 | I'm vegetarian | self/stable | `I'm vegetarian` | `I'm vegetarian` | OK |
| 12 | I'm a vegan | self/stable | `I'm a vegan` | `I'm a vegan` | OK |
| 13 | I always drink tea in the morning | self/stable | `I always drink tea in the morning` | `I always drink tea in the morning` | OK |
| 14 | I usually go to bed at 11 | self/stable | `I usually go to bed at 11` | — (off_topic) | MISS |
| 15 | I never drink soda | self/stable | `I never drink soda` | `I never drink soda` | OK |
| 16 | I can't stand spicy food | self/stable | `I can't stand spicy food` | `I can't stand spicy food` | OK |
| 17 | I avoid caffeine | self/stable | `I avoid caffeine` | — (off_topic) | MISS |
| 18 | I like my coffee black | self/stable | `I like my coffee black` | `I like my coffee black` | OK |
| 19 | I enjoy jazz music | self/stable | `I enjoy jazz music` | `I enjoy jazz music` | OK |
| 20 | I love watching movies | self/stable | `I love watching movies` | `I love watching movies` | OK |
| 21 | I don't like long answers | self/stable | `I don't like long answers` | `I don't like long answers` | OK |
| 22 | From now on I don't drink soda | self/stable | `From now on I don't drink soda` | `From now on I don't drink soda` | OK |
| 23 | I keep the AC at 26 degrees | self/stable | `I keep the AC at 26 degrees` | — (no_match) | MISS |
| 24 | I like the lights dim | self/stable | `I like the lights dim` | `I like the lights dim` | OK |
| 25 | I don't eat pork, beef or lamb | self/stable | `I don't eat pork, beef or lamb` | — (list) | MISS |
| 26 | I prefer concise replies, can you help me plan dinner? | self/stable | `I prefer concise replies` | `I prefer concise replies` | OK |
| 27 | My mom doesn't eat pork | third/stable | — (third_party) | — (third_party) | OK |
| 28 | My husband hates cilantro | third/stable | — (third_party) | — (third_party) | OK |
| 29 | She doesn't drink coffee | third/stable | — (third_party) | — (third_party) | OK |
| 30 | My friend said I don't like spicy food | third/stable | — (third_party) | — (third_party) | OK |
| 31 | I told her I don't eat beef | third/stable | — (third_party) | — (third_party) | OK |
| 32 | They like tea | third/stable | — (third_party) | — (third_party) | OK |
| 33 | My kids love pizza | third/stable | — (third_party) | — (third_party) | OK |
| 34 | We don't eat beef at home | household/stable | — (household) | — (no_match) | OK |
| 35 | Our family likes spicy food | household/stable | — (household) | — (no_match) | OK |
| 36 | "I don't eat meat," he said | third/stable | — (quote) | — (quote) | OK |
| 37 | If I don't drink coffee, I get tired | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 38 | What if I stop eating sugar? | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 39 | Suppose I like tea | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 40 | I hate food, just kidding | self/stable | — (joke) | — (joke) | OK |
| 41 | I only eat chocolate, jk | self/stable | — (joke) | — (joke) | OK |
| 42 | I like my password to be food related | self/stable | — (sensitive) | — (sensitive) | OK |
| 43 | My PIN is my favorite coffee | self/stable | — (sensitive) | — (sensitive) | OK |
| 44 | I'm allergic to peanuts | self/stable | — (health) | — (health) | OK |
| 45 | I don't eat gluten because of my doctor | self/stable | — (health) | — (health) | OK |
| 46 | I take medication so I don't drink alcohol | self/stable | — (health) | — (health) | OK |
| 47 | I'm pregnant so no coffee | self/temporary | — (health) | — (health) | OK |
| 48 | I'm on a diet, no snacks | self/temporary | — (health) | — (health) | OK |
| 49 | I used to drink coffee | self/past | — (past) | — (past) | OK |
| 50 | I didn't like spicy food as a kid | self/past | — (past) | — (past) | OK |
| 51 | I liked tea back then | self/past | — (past) | — (past) | OK |
| 52 | Before, I never ate fish | self/past | — (past) | — (past) | OK |
| 53 | I don't want coffee today | self/today | — (temporal) | — (temporal) | OK |
| 54 | I'm not eating sugar this week | self/temporary | — (temporal) | — (temporal) | OK |
| 55 | I don't feel like tea right now | self/temporary | — (temporal) | — (temporal) | OK |
| 56 | Lately I don't drink coffee | self/temporary | — (temporal) | — (temporal) | OK |
| 57 | For now I don't eat meat | self/temporary | — (temporal) | — (temporal) | OK |
| 58 | I don't like spicy food at the moment | self/temporary | — (temporal) | — (temporal) | OK |
| 59 | I don't drink coffee tonight | self/today | — (temporal) | — (temporal) | OK |
| 60 | Do I like coffee? | self/stable | — (question) | — (no_match) | OK |
| 61 | I don't eat pork, right? | self/stable | — (question) | — (question) | OK |
| 62 | What do I like to eat? | self/stable | — (question) | — (no_match) | OK |
| 63 | I like tea? | self/stable | — (question) | — (question) | OK |
| 64 | I think maybe I like tea | self/stable | — (uncertain) | — (uncertain) | OK |
| 65 | I probably don't eat pork | self/stable | — (uncertain) | — (uncertain) | OK |
| 66 | I like this song | self/temporary | — (deictic) | — (deictic) | OK |
| 67 | I love you | self/stable | — (deictic) | — (deictic) | OK |
| 68 | I don't like that restaurant | self/stable | — (deictic) | — (deictic) | OK |
| 69 | I hate it | self/stable | — (deictic) | — (deictic) | OK |
| 70 | I'd like a coffee | self/temporary | — (request) | — (request) | OK |
| 71 | I want pizza tonight | self/today | — (request) | — (temporal) | OK |
| 72 | I need a nap | self/temporary | — (request) | — (request) | OK |
| 73 | I'll have the salad | self/temporary | — (request) | — (request) | OK |
| 74 | I like blue | self/stable | — (off_topic) | — (off_topic) | OK |
| 75 | I hate Mondays | self/stable | — (off_topic) | — (off_topic) | OK |
| 76 | I love my dog | self/stable | — (off_topic) | — (off_topic) | OK |
| 77 | I had pasta for lunch | self/past | — (not_preference) | — (no_match) | OK |
| 78 | What's for dinner? | none/stable | — (not_preference) | — (no_match) | OK |
| 79 | Do you like coffee? | none/stable | — (not_preference) | — (no_match) | OK |

### 9.3 holdout (30 sentences, written before the rules were finalized)

| # | Sentence | Labels | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | 我不吃牛肉，今晚有什麼推薦的餐廳？ | self/stable | `不吃牛肉` | `不吃牛肉` | OK |
| 2 | 我很喜歡喝無糖綠茶 | self/stable | `很喜歡喝無糖綠茶` | `很喜歡喝無糖綠茶` | OK |
| 3 | 我習慣晚上十一點睡覺 | self/stable | `習慣晚上十一點睡覺` | `習慣晚上十一點睡覺` | OK |
| 4 | 我討厭太甜的甜點 | self/stable | `討厭太甜的甜點` | `討厭太甜的甜點` | OK |
| 5 | 我老婆不吃辣，幫我想個菜單 | third/stable | — (third_party) | — (uncertain) | OK |
| 6 | 我們家都不吃豬肉 | household/stable | — (household) | — (no_match) | OK |
| 7 | 我對蝦子過敏 | self/stable | — (health) | — (health) | OK |
| 8 | 我以前很愛喝可樂 | self/past | — (past) | — (past) | OK |
| 9 | 我最近不喝咖啡 | self/temporary | — (temporal) | — (temporal) | OK |
| 10 | 我今天不想吃飯 | self/today | — (temporal) | — (temporal) | OK |
| 11 | 如果我不吃早餐會怎樣？ | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 12 | 我喜歡香菜嗎？ | self/stable | — (question) | — (question) | OK |
| 13 | 開玩笑的，我最喜歡吃苦瓜 | self/stable | — (joke) | — (joke) | OK |
| 14 | 他說我不喝牛奶 | third/stable | — (third_party) | — (third_party) | OK |
| 15 | 我喜歡這部電影 | self/temporary | — (deictic) | — (deictic) | OK |
| 16 | 我在懷孕，不能喝酒 | self/temporary | — (health) | — (health) | OK |
| 17 | 我不吃了，好飽 | self/temporary | — (temporal) | — (temporal) | OK |
| 18 | 我比較喜歡簡短的回答 | self/stable | `比較喜歡簡短的回答` | `比較喜歡簡短的回答` | OK |
| 19 | 我怕冷，冷氣開幾度好？ | self/stable | `怕冷` | `怕冷` | OK |
| 20 | 我曾經吃素三年 | self/past | — (past) | — (past) | OK |
| 21 | I don't eat pork, any dinner ideas? | self/stable | `I don't eat pork` | `I don't eat pork` | OK |
| 22 | I prefer short answers | self/stable | `I prefer short answers` | `I prefer short answers` | OK |
| 23 | I love spicy food | self/stable | `I love spicy food` | `I love spicy food` | OK |
| 24 | My husband hates mushrooms | third/stable | — (third_party) | — (third_party) | OK |
| 25 | I'm allergic to shellfish | self/stable | — (health) | — (health) | OK |
| 26 | I used to drink a lot of coffee | self/past | — (past) | — (past) | OK |
| 27 | I'm not drinking coffee this week | self/temporary | — (temporal) | — (temporal) | OK |
| 28 | Do I like tea? | self/stable | — (question) | — (no_match) | OK |
| 29 | If I stopped eating sugar, would I lose weight? | self/stable | — (hypothetical) | — (hypothetical) | OK |
| 30 | I'd like a cup of tea now | self/temporary | — (temporal) | — (temporal) | OK |

### 9.4 Adversarial set (the reviewer's 76 sentences; tuned against, not independent)

| # | Sentence | Labels | Expected | Actual | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | 我不吃香菜才怪 | self/stable | — (sarcasm) | — (joke) | OK |
| 2 | 我超愛吃榴槤的啦（才怪） | self/stable | — (sarcasm) | — (joke) | OK |
| 3 | 我最喜歡吃苦瓜呵呵 | self/stable | — (sarcasm) | — (joke) | OK |
| 4 | 我最喜歡吃苦瓜XD | self/stable | — (sarcasm) | — (joke) | OK |
| 5 | 我不吃辣。才怪。 | self/stable | — (sarcasm) | — (joke) | OK |
| 6 | 我不吃香菜。開玩笑的。 | self/stable | — (joke-cross-sentence) | — (joke) | OK |
| 7 | 我不是不吃牛肉 | self/stable | — (negation) | — (no_match) | OK |
| 8 | 我沒有不喜歡咖啡 | self/stable | — (negation) | — (no_match) | OK |
| 9 | 我不是討厭香菜，只是今天不想吃 | self/stable | — (negation) | — (temporal) | OK |
| 10 | 我不吃香菜。我媽說的。 | third/stable | — (other-cross-sentence) | — (third_party) | OK |
| 11 | 我爸要我跟你說，我不吃豬肉 | third/stable | — (other) | — (framing) | OK |
| 12 | 幫我爸打的，我不吃豬肉 | third/stable | — (other) | — (framing) | OK |
| 13 | 爸爸在打字，我不吃豬肉 | third/stable | — (other) | — (framing) | OK |
| 14 | 代替我媽回答，我不吃牛肉 | third/stable | — (other) | — (framing) | OK |
| 15 | 我女朋友不吃辣 | third/stable | — (other) | — (no_match) | OK |
| 16 | 我兒子不吃青椒 | third/stable | — (other) | — (third_party) | OK |
| 17 | 幫我翻成英文，我不吃香菜 | third/stable | — (quote/translate) | — (framing) | OK |
| 18 | 假裝你是我，我不吃香菜 | third/stable | — (roleplay) | — (framing) | OK |
| 19 | 我們來玩角色扮演，我不吃香菜 | third/stable | — (roleplay) | — (framing) | OK |
| 20 | 老師要我們造句，我不喜歡吃蔬菜 | third/stable | — (minor/quote) | — (framing) | OK |
| 21 | 我五歲，我不喜歡吃青菜 | self/stable | — (minor) | — (framing) | OK |
| 22 | 我不愛吃青菜啦，媽媽 | self/stable | — (minor) | — (third_party) | OK |
| 23 | 我不吃辣的話就點別的 | self/stable | — (conditional) | — (clause) | OK |
| 24 | 我不吃澱粉直到婚禮結束 | self/temporary | — (temporary) | — (clause) | OK |
| 25 | 我不吃澱粉到月底 | self/temporary | — (temporary) | — (clause) | OK |
| 26 | 我不吃肉，這個月在齋戒 | self/temporary | — (temporary) | — (special) | OK |
| 27 | 我不喝酒，這週在吃抗生素 | self/temporary | — (temporary/health) | — (health) | OK |
| 28 | 我不喝咖啡。這週而已。 | self/temporary | — (temporary-cross-sentence) | — (temporal) | OK |
| 29 | 我不吃香菜（應該吧） | self/stable | — (uncertain) | — (uncertain) | OK |
| 30 | 我不吃什麼來著 | self/stable | — (question) | — (uncertain) | OK |
| 31 | 我不吃香菜﹖ | self/stable | — (question/fullwidth) | — (question) | OK |
| 32 | 我不吃蝦，吃了會起疹子 | self/stable | — (health) | — (health) | OK |
| 33 | 我不喝酒，正在戒酒 | self/stable | — (health) | — (special) | OK |
| 34 | 我不吃牛肉因為我拜觀音 | self/stable | — (sensitive-religion) | — (special) | OK |
| 35 | 我討厭看民進黨的新聞 | self/stable | — (sensitive-politics) | — (special) | OK |
| 36 | 我不吃生魚片，因為我在備孕 | self/stable | — (health) | — (health) | OK |
| 37 | 我不吃香菜，晚餐有什麼推薦 | self/stable | `不吃香菜` | `不吃香菜` | OK |
| 38 | 我都不喝含糖飲料 | self/stable | `都不喝含糖飲料` | `都不喝含糖飲料` | OK |
| 39 | 我不吃ＰＯＲＫ | self/stable | `不吃ＰＯＲＫ` | `不吃ＰＯＲＫ` | OK |
| 40 | 我不吃 beef | self/stable | `不吃 beef` | `不吃 beef` | OK |
| 41 | 我很討厭香菜！ | self/stable | `很討厭香菜` | `很討厭香菜` | OK |
| 42 | 我一向不喝咖啡 | self/stable | `一向不喝咖啡` | `一向不喝咖啡` | OK |
| 43 | 以後我都不吃牛肉了 | self/stable | `以後我都不吃牛肉` | `以後我都不吃牛肉` | OK |
| 44 | Oh great, I love soggy fries | self/stable | — (sarcasm) | — (joke) | OK |
| 45 | I absolutely love cold coffee 🙄 | self/stable | — (sarcasm) | — (joke) | OK |
| 46 | I love burnt toast, said no one ever | self/stable | — (sarcasm) | — (joke) | OK |
| 47 | I don't eat pork. Just kidding. | self/stable | — (joke-cross-sentence) | — (joke) | OK |
| 48 | I don't hate coffee | self/stable | — (negation) | — (no_match) | OK |
| 49 | I never said I like coffee | self/stable | — (negation) | — (third_party) | OK |
| 50 | For my dad, I don't eat pork | third/stable | — (other) | — (framing) | OK |
| 51 | Dad here, I don't eat pork | third/stable | — (other) | — (framing) | OK |
| 52 | This is Amy, I don't eat pork | third/stable | — (other) | — (framing) | OK |
| 53 | Translate this, I don't eat pork | third/stable | — (quote/translate) | — (framing) | OK |
| 54 | My sister texted me. I hate onions. | third/stable | — (other-cross-sentence) | — (third_party) | OK |
| 55 | Pretend you're me, I hate onions | third/stable | — (roleplay) | — (hypothetical) | OK |
| 56 | I'm in 2nd grade, I hate vegetables | self/stable | — (minor) | — (framing) | OK |
| 57 | I don't eat after 8pm until my wedding | self/temporary | — (temporary) | — (clause) | OK |
| 58 | I don't eat sugar until Christmas | self/temporary | — (temporary) | — (clause) | OK |
| 59 | I don't drink coffee. Not this week anyway. | self/temporary | — (temporary-cross-sentence) | — (temporal) | OK |
| 60 | I don't eat meat during Lent | self/temporary | — (temporary/religion) | — (special) | OK |
| 61 | I never drink alcohol on my meds | self/stable | — (health) | — (health) | OK |
| 62 | I don't drink alcohol since I'm in recovery | self/stable | — (health) | — (special) | OK |
| 63 | I avoid sugar for my blood sugar | self/stable | — (health) | — (framing) | OK |
| 64 | I don't eat peanuts, they make my throat swell | self/stable | — (health) | — (health) | OK |
| 65 | I always take my vitamins at 9 | self/stable | — (health) | — (health) | OK |
| 66 | I don't eat pork because I'm Muslim | self/stable | — (sensitive-religion) | — (special) | OK |
| 67 | I never watch Fox News | self/stable | — (sensitive-politics) | — (special) | OK |
| 68 | I don't eat pork right | self/stable | — (question) | — (question) | OK |
| 69 | I like coffee, don't I | self/stable | — (question) | — (question) | OK |
| 70 | I don't eat pork lol | self/stable | — (joke) | — (joke) | OK |
| 71 | I don't eat spicy food unless my wife cooks | third/stable | — (conditional/other) | — (clause) | OK |
| 72 | Ｉ don't eat pork | self/stable | — (fullwidth) | — (no_match) | OK |
| 73 | I don't eat cilantro, any dinner ideas? | self/stable | `I don't eat cilantro` | `I don't eat cilantro` | OK |
| 74 | I never drink soda | self/stable | `I never drink soda` | `I never drink soda` | OK |
| 75 | I prefer short answers | self/stable | `I prefer short answers` | `I prefer short answers` | OK |
| 76 | I don’t eat pork | self/stable | `I don’t eat pork` | `I don’t eat pork` | OK |

## 10. Independent review and fixes (2026-10-30)

The review found no blockers, 5 majors, 4 minors and 4 nits; all were addressed (n3 is explained as not feasible).

| Item | Fix |
| --- | --- |
| M1 cross-sentence exclusions failed ("我不吃香菜。開玩笑的。" was proposed) | Whole-turn judgement: `analyzeSuggestion` applies every exclusion to the whole typed turn, and the service and the offline metrics use the same function; the card stores the whole turn and the source ticket re-parses the whole turn |
| M2 proxy or framing prefixes caused misattribution ("我爸要我跟你說，我不吃豬肉") | The candidate must be the first clause or be preceded only by question or request clauses (`context`); a new whole-turn `framing` category (要我跟你說, 幫 X 打, 代替, 在打字, 翻成, 翻譯, 造句, 角色扮演, 假裝, 我 N 歲, 年級, here, this is, for my, translate, pretend, role-play…); form-of-address clauses; misattribution measured on the adversarial set (0) |
| M3 values had no length or syntax bounds, so special-category data leaked into values | Objects ≤12 Chinese characters or ≤4 English words, and none containing 因為, 所以, 的話, 直到, 到月底, until, during, since, because, unless, on my…; more sarcasm (才怪, 呵呵, XD, lol, haha, emoji) and uncertainty (應該吧, 我想, I think); ﹖ as a question mark; religion, politics and addiction excluded for the whole turn (`special`), more health terms; curly apostrophes |
| M4 the PIN in `SENSITIVE` was a literal 0x08 | Real `\b` (4 characters around `pin` and `ssn`; no other control characters in the repository's source); tests for refusing Chinese and English PIN／SSN and for not misflagging spinach and similar words; §8 corrected |
| M5 manager additions recorded the current person (including a minor) | Manager additions and edits always record `by: null`; `byFor` returns null when the current person is a minor; tests |
| m1 an unanswered suggestion survived later turns | `dropPending` at the start of each new turn (not a decline) |
| m2 suggestions could not be turned off with the flag off | "Turn off memory suggestions" is still shown when `!available && enabled` |
| m3 metrics should use the service's flow and include the adversarial set | Metrics use `suggestFrom` (whole turn); new `memory-candidates.adversarial.json` with thresholds; numbers before and after are listed in §4 |
| m4 `work_summary` might be sent or mislabelled | `retrieve.ts` sends only preference and note; lists, the inspect card and correct／forget targets also include only those two (`shownKind`) |
| n1 | §2.6 states that "byte-identical" refers to the snapshot, not the IPC shape |
| n2 | §2.6 explains that going from 4 straight to 2 (skipping 3) is safe |
| n3 | Not feasible; reason in §2.5 (`userInitiated` only means a menu-bar click) |
| n4 | `SuggestionPrompt` keeps the fixed sentences and re-translates them when the language changes |
