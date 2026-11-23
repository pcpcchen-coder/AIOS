<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-voice-default-2026-11-02.md) | [English](memory-voice-default-2026-11-02.en.md)

# 記憶預設選人（用說的問，沒說不要就用）驗證

日期：2026-11-02，Asia/Taipei。分支：`claude/memory-voice-default`（基於 main `6412ea0`）。範圍：George 2026-11-02 的要求——選擇要用誰的記憶時不跳卡片讓人點，Nous 用說的問「我要用 George 的記憶，好嗎？」，使用者沒有說不要就用 George 的記憶；適用於鏡頭（臉）或聲音已經認出 George 的時候。前面的規則見 [16 §4](../16_Nous_Memory_Layer_Design_2026-10-26.md#4-人物綁定與使用同意)、[17 §9.2](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md#92-身分只提出候選核心選定人物)、[MEM-2 驗證](memory-mem2-2026-10-30.md) 與 [SP-02b 驗證](sp-02b-2026-11-01.md)。

**這不是實機驗收。** 以下測試全部在雲端容器以 fixture（假 sideband、假 GA 伺服器、假時鐘與假計時器、假 DOM）執行，不是 Mac、不是麥克風、不是真的鏡頭。家人辨識與聲音的門檻仍未校準；選定本次人物仍只是「這次用誰的偏好」的歸屬選擇，**不是身分驗證或授權**，也不產生寫入記憶所需的來源票證。

## 1. George 的決定（2026-11-02）

| # | 決定 | 本批的做法 |
|---|---|---|
| D1 | 不出卡片讓人點；用說的問，沒說不要就用 | 即時語音不再送 `memory_card`（臉部候選卡）。核心送一句「（記憶確認）「我要用 George 的記憶，好嗎？」」給模型照念（不能稱名時是「我要用你的記憶，好嗎？」），頁面只顯示一行「即將用 George 的記憶」與「不是我」按鈕 |
| D2 | 選定的時間：先到者為準 | (a) 問句念完並播完之後，使用者的下一句（不是否定、不是回音）——**在核心處理那一句之前**選定，所以核心對那一句的處理（記憶指令、受保護交辦）用 George 的世代；但即時語音模型可能已經依音訊自動回應（semantic_vad 早於逐字稿），**那一句的語音回覆不一定用到 George 的記憶，從下一輪起才確定用到**；(b) 問句念完並播完後 8 秒（`DEFAULT_SELECT_MS`）；(c) 問句一直沒被念出（沒有相符的助理逐字稿）時，送出後 12 秒（`DEFAULT_BACKSTOP_MS`） |
| D3 | 打字聊天有臉的候選時直接選定 | `process()` 直接選定，那一句接著用 George 的記憶送聊天；回條「本次人物：George（鏡頭認出）」；頁面顯示一行「正在用 George 的記憶」與「不是我」（不擋聊天） |
| D4 | 說不要之後 | 只用全家共用的記憶，Nous 說「好，這次只用全家共用的記憶。」；這次互動不再問（同一個辨識決策、這一通都不再問） |
| D5 | 之後可以復原 | 新的記憶指令 `unselect`：說或打「不是我」「不要用我的記憶」「改用全家共用的記憶」「not me」… → 改回全家共用，回條「已改用全家共用的記憶」 |
| D6 | 沒有這條路徑的同意 | 什麼都不念；畫面那一行照樣顯示，送出後 8 秒選定，除非按了「不是我」 |
| D7 | 收起 | 只把那一行藏起來，選定照常；停止通話（通話結束）才會在選定前取消 |
| D8 | 保留 MEM-4a 撤銷與世代、SP-02a 臉聲融合 | 選定一律經 `answerLiveCandidate` 重新核對；換人一律走 `select()`／`replacePresence()`（換世代、撤銷帶著記憶的通話並重建） |

## 2. 這次覆寫了哪些舊規則

- **SP-02b G3**（[SP-02b 驗證 §1](sp-02b-2026-11-01.md#1-george-的決定2026-11-01)）：「臉沒認出、通話中的聲音認出時，要問『這次用 George 的偏好嗎？』，一定等確認」改成 D1／D2：問句換成「我要用 George 的記憶，好嗎？」，沒有說不要就選定。聲音候選的提出條件（臉沒有反對、前一段話沒有指向別人、60 秒內、整通最多一次）不變。
- **17 §9.2 的「一定要確認」**（[17 §9.2](../17_Wake_Word_and_Speaker_Recognition_Plan_2026-10.md#92-身分只提出候選核心選定人物)）：表中 `confirmed(P)`、`face_only(P)`、`voice_only(P)` 的「短確認，確認後讀 P」改成「說一次，沒有說不要就讀 P」。`conflict`、`voice_multi`、`voice_weak`、`none` 仍只讀全家共用、不提出候選。寫入規則不變：選定之後，明確「記住」才寫入，而且仍需要來源票證（身分結果不能產生或替代票證）。
- **16 §4 的「簡短確認」與「只有說『我是 George』或在可信主視窗選人物才能選定」**：加註 2026-11-02 的例外（臉或聲音已認出時預設選定）。17 與 16 的原文保留，16 §4 加了更新註記；17 本身沒有改（規劃文件），以本紀錄為準。

## 3. 設計

### 3.1 即時語音（ChatGPT 方案與 API key 兩條路徑）

- 開場：看著說話或喚醒開始的通話，問候之後（或使用者先開口時第一句之前）呼叫 `afterGreeting()`；有臉的候選就 `propose()`。通話中：SP-02b 的聲音候選經 `offerVoiceCandidate()` → `voiceCandidate()` → `propose()`，整通最多一次。
- `propose()`：建立 live 來源的 `face_candidate` 卡（只在核心記憶體，頁面不顯示成卡片）；有同意時 `say()` 送問句；SSE 送 `{ kind: "memory_default", card, phase: "proposed" }`（**只有不透明的卡片 ID**，人物名由可信主視窗經 IPC `card_view` 取）；開始計時。
- 計時器（預設 `setTimeout`，測試注入假計時器）到期時排進同一個佇列，和使用者逐字稿依序處理；到期時再用 `now()` 核對，提早叫醒不會提早選定。助理音訊結束的時間只會往後延，選定時間跟著延。
- 使用者的每一句（`handleUser`，在確認卡處理之後、一般處理之前）：
  - 回音（被最近的助理逐字稿或核心送出的句子包含）：不算。
  - 開口時間早於問句送出：不算回答。
  - 「我是 Y」：不用這位候選（不念全家共用那句），交給既有的 parser 選 Y；Y 不存在或同名時照常補上目前範圍的記憶。
  - 整句否定（`declinesDefault`，見 3.3）或 `unselect`：**送出之後隨時有效，可以搶話**；改用全家共用，這次互動不再問。
  - 有用語音問、問句已念完並播完（`readyAt` 沿用 MEM-2：有音訊結束事件用它，否則問句逐字稿後 1.8 秒）、開口在那之後：先選定、補上 George 的釘選記憶，再照常處理這一句（記憶指令、交辦）。模型對這一句的語音回覆可能在逐字稿到達之前就開始了，不一定用到剛補上的記憶。SP-02b 通話中途的聲音候選：這通如果已經帶著全家共用的釘選記憶，選定 George 會換世代，boundary 撤銷這通並重建（第一句「好，已經更新了。」），不是在原通話裡無縫切換。只是「好」「是」這類回答時選定就好，不當成一般的話，也不能當交辦原句（MEM-4b）。
  - 在問句播完之前說的一般的話：照常處理（只用全家共用），繼續等。
- 選定：`selectDefault()` → `MemoryService.answerLiveCandidate(card, true)`。回 `ok`：SSE `phase: "selected"`，補上記憶；回 `mismatch_face`（只有鏡頭：候選換成另一位家人）：「鏡頭看到的是另一位家人，這次只用全家共用的記憶」；回 `mismatch_voice`（聲音參與：候選或那張卡來自聲音，或卡片建立之後通話中的聲音指向別人）：「鏡頭和聲音不一致，這次只用全家共用的記憶」；回 `expired`（卡片、世代或辨識決策已失效）：「候選已失效，這次只用全家共用的記憶」；後兩者都 `phase: "declined"` 並補上全家共用的記憶。
- SP-02a：選定之前，通話中的聲音認出的是和臉的候選不同的家人時，`IdentityService` 呼叫 `voiceDisagrees()`，記憶預設選人作廢（同上「鏡頭和聲音不一致」）。聲音樣本通常比那一句的逐字稿晚到，所以**預設選定之後 10 秒內**（`DEFAULT_GRACE_MS`）聽到另一位家人的聲音也會改回全家共用、念不一致的固定句、這次互動不再問；之後照 SP-02b G2 只記 log。選定的 await 期間收到不一致時，核心依先後回 `mismatch_voice` 或在選定後立刻復原，頁面不會先顯示「正在用」。畫面有多張臉時（候選有效期間內），不用、也不提聲音候選。
- 通話結束（`close()`）或記憶撤銷（`cleanup()`）：取消計時器、不選定。換人（`presenceChanged()`）：候選作廢。
- 沒有同意（`speakable()` 為 false）：不念任何句子；語音的「好」「不要」都不算（沒有問）；只有明說的 `unselect`（「不是我」）和畫面上的「不是我」算；送出後 8 秒選定。

### 3.2 打字聊天

`MemoryService.process()`：打字、從第一段開始、本次人物沒有選定（含暫停）、這句話沒有「我是 X」也沒有 `unselect`、這個辨識決策還沒用過（`faceCandidate()` 的「每個決策一次」）時直接 `select()`。**只用臉的候選**（`memoryFaceCandidate()`，不退回通話中的聲音），所以回條的「（鏡頭認出）」一定是真的鏡頭；有臉的候選、這句話是「不是我」時＝說不要（不送聊天、回條「這次只用全家共用的記憶」），回條「本次人物：{0}（鏡頭認出）」，`MemoryTurnView.auto_selected = true`；這一句接著依 George 的範圍處理（`memory_turn` 綁選定後的世代）。

### 3.3 否定與復原的比對

- `declinesDefault(text, name)`（`server/memory/live.ts`）：轉繁體、去掉空白與標點、英文小寫，再去掉句尾「了／啦／喔／哦／啊／呀／吧」與「謝謝」；整句是「不、不要、不用、不是、不對、不好、不行、不可以、別、算了、等一下、等等、先不要、不是我、換人、no、nope、no thanks、not me、that's not me、don't、wait、hold on…」之一，或「我不是／不是／I'm not ＋問句裡的名字」「不要用／別用／不用＋（我的｜名字的）＋記憶／偏好」，或 `unselectPhrase`。審查後另外算否定：重複的否定（「不要不要」「不用不用」「no no」）；句首否定後面有停頓再接別的話（中文是空白或標點，例如「不要，用全家的」「不，我是說…」；英文要有標點，例如「No, use the household memory」，所以「no problem」不算）；「please don't」；提到全家共用記憶的句子（「全家共用」「用全家的」「全家的記憶／偏好／就好／好了」「household memory／only」；「全家的晚餐吃什麼」這種一般問句不算）。句首否定緊接動詞、沒有停頓（「不要開燈」「不用擔心這個」）仍是一般的要求，會選定。
- `unselect`（`server/memory/parse.ts` 的新段落）：整段是「不是我」「那不是我」「不要用我的記憶」「別用我的偏好」「不用我的記憶」「換人」「改用／只用／用全家共用的記憶（就好）」「not me」「that's not me」「don't use my memory」「use household／shared memory」之一。只有已選定本次人物時才是指令（打字：改回全家共用並清除用過記憶的歷史；語音：同上，帶著記憶的通話撤銷並重建）；沒有選定時原句照樣交給聊天。
- 不算的近似句（測試）：「不是我做的」「不要開燈」「不是我說的」「我不是很餓」「不要太辣」「等一下再開燈」「換人來做」「不要用我的電腦」「not me too」「no problem」……這些是一般的話，問句播完之後說出來會選定 George 並照常處理。

### 3.4 頁面

- `src/memory-view.ts` 的 `PresenceNotice`（沿用 `SuggestionPrompt` 的做法）：一行文字＋「不是我」，`data-visibility-reason="user_request"`，固定在畫面上方（`#presence-notice`），不是 Surface、不擋聊天。
- 即時語音：`memory_default` proposed → 經 `card_view` 取人物名，顯示「即將用 George 的記憶」；按「不是我」＝`card_answer`（`decline`），核心不選定、補上全家共用、這次不再問，回條「這次只用全家共用的記憶」。selected → 重讀本次人物，顯示「正在用 George 的記憶」；按「不是我」＝`select`（全家共用，帶這個世代的 `select_card`）。declined → 收掉。
- 打字聊天：turn 帶 `auto_selected` 時顯示「正在用 George 的記憶」。
- 收起（Esc、說「收起」）只藏起這一行，藏起的狀態保留到下一次新的提出（選定後也不會跳出來）；selected 只把等選定的那一行換成「正在用」，名字取自那張卡；本次人物是別人（例如「我是 Y」）時收掉，由一般回條說明；本次人物世代改變時收掉；通話結束時，還在等選定的那一行收掉（已選定的照舊顯示到世代改變）。
- 所有新文字都在共用翻譯表（`server/messages.en.json`、`src/messages.en.json`）。
- 臉部候選卡的型別（`MemoryCardView` 的 `face_candidate`）與畫面保留，只是不再由這兩個流程打開。

## 4. 交付內容

路徑都在 `prototype/ambient-shell/`。

| 檔案 | 內容 |
|---|---|
| `server/memory/live.ts` | `propose()`、`selectDefault()`、`declineDefault()`、`noDefault()`、`candidateMismatch()`、計時器（`timer` 選項）、`declinesDefault()`、`DEFAULT_SELECT_MS`／`DEFAULT_BACKSTOP_MS`、新問句與固定句；`handleUser` 的第 2 步改寫；`CandidateAnswer` |
| `server/memory/service.ts` | `answerLiveCandidate` 回 `ok`／`expired`／`mismatch_face`／`mismatch_voice`；說不要的紀錄（`DEFAULT_DECLINE_MS`）；選定後 10 秒的聲音寬限（`DEFAULT_GRACE_MS`）；改路徑的暫存（`carryDefault`／`takeCarriedDefault`）；打字聊天預設選定與 `auto_selected`；`unselect` 段落（打字與語音）；`voiceDisagrees()`；選全家共用時這次不再預設選人；臉部候選拒絕的回條 |
| `server/memory/parse.ts` | `unselect` 段落與 `unselectPhrase()` |
| `server/identity-service.ts` | 通話中的聲音和問候時認出的臉（或本次人物）不同時呼叫 `voiceDisagrees()`（記憶層判斷是否在 10 秒寬限內）；多張臉時不提、也不回傳聲音候選；`memoryCandidate()` 帶 `source`；只有臉的 `memoryFaceCandidate()` |
| `server/live-route.ts`、`server/nous.ts` | `close("fallback")` 時 `handOff()`；把 `memoryFaceCandidate()` 接給記憶層 |
| `shared/realtime-route.ts`、`shared/memory.ts` | `memory_default` 事件；`MemoryTurnView.auto_selected` |
| `src/memory-view.ts`、`src/main.ts`、`index.html`、`src/style.css` | `PresenceNotice` 與接線（SSE 事件、turn、收起、通話結束、世代改變） |
| `src/live-voice.ts`、`src/realtime.ts` | 轉交 `memory_default`；proposed 會結束靜音（問句要聽得到） |
| `server/messages.en.json`、`src/messages.en.json` | 新文字的英文 |

## 5. 自動測試

| 測試檔 | 涵蓋 |
|---|---|
| `tests/memory-live.test.ts` | 否定比對與近似句；問句念完 8 秒選定並補上記憶；音訊結束事件延後時窗；12 秒後備；下一句在處理之前選定（確認問句記在 George 名下）；搶在問句播完之前的話不選定；「好」不被當成問候的回音；整句否定可搶話、只用全家共用、念一次、不再問（同一通與同一互動的下一通）；「不是我做的」「不要開燈」選定、「我不是 George」「不是我」不選定；「我是 X」取代預設；重新核對（換成另一位家人→不一致、新的決策→失效）；`voiceDisagrees()`；通話結束不選定；沒有同意時不念、畫面「不是我」、8 秒選定；SP-02b 聲音候選（問一次、沒有名字、開場候選等待中不問）；之後說「不是我」改回全家共用、撤銷重建、不再問 |
| `tests/memory-apikey.test.ts` | API key 路徑：問句是核心的 `response.create`、沒有 `memory_card`、下一句選定並補上記憶（system item）；搶話的「不是我」只用全家共用並念一次 |
| `tests/apikey-integration.test.ts` | 真 HTTP／SSE＋假 GA：SSE 的 `memory_default` 只有 `card`、`kind`、`phase`，不含名字；「不是我」→ declined |
| `tests/live-integration.test.ts` | 真 HTTP／SSE＋假 sideband：問句送到 sideband、SSE 只有卡片 ID、沒有 `memory_card`、「不要」→ 全家共用的固定句 |
| `tests/memory-voice-delegation.test.ts` | 問句後說的要求先選定，受保護交辦帶 George 的記憶；單獨的「好」只選定、不能當交辦原句 |
| `tests/memory-chat.test.ts` | 打字聊天預設選定後，同一句經 `/api/chat` 帶著 George 的記憶送到引擎 |
| `tests/memory-service.test.ts` | 打字預設選定（取代舊的 M04 卡片測試）：沒有卡片、`auto_selected`、回條、`memory_turn`；「不是我」改回全家共用、同一個決策不再選；沒有選定時「不是我」是一般聊天；新的決策再選、`select` 全家共用復原；暫停時也預設選定、請求快取清除 |
| `tests/memory-parse.test.ts` | `unselect` 的中英文說法；近似句「不是我做的」「不要開燈」「不是我說的」「換人來做」「不要用我的電腦」「not me too」等是一般聊天 |
| `tests/identity-wake-voice.test.ts` | 已選定時另一位家人的聲音交給記憶層判斷（`voiceDisagrees`）；多張臉時不提、也不回傳聲音候選；`memoryFaceCandidate()` 不退回聲音 |
| `tests/memory-view.test.ts` | `PresenceNotice`：等選定的一行與 `card_answer` decline；選定後的一行與 `select` 全家共用；收起只藏起來；世代改變與通話結束收掉；失效時顯示核心的原因；英文介面；瀏覽器版不顯示 |

更新的舊測試（不刪覆蓋）：memory-live 的「face candidate by voice」整組改成新行為（問句、計時、否定、重新核對、SP-02b 三項都保留）；memory-apikey 的臉部候選改成預設選人；memory-service 的 M04 與 Minor 6/7/10 改成打字預設選定。

結果見 §7。

## 6. 殘餘風險與未做的事

- **旁人或電視的一句話**：問句播完之後，任何不是否定的話都會讓 George 被選定（D2 的 (a)）；8 秒沒人說話也會選定。選定只影響這次用誰的偏好，不寫入記憶；隨時可以說或按「不是我」。
- **否定的白名單是固定的**：「不要」「不是我」這類整句才算；「呃…不要好了」「我想想」等不在清單內的說法會被當成一般的話而選定。Mac 試用時收集漏掉的說法。
- **模型可能另外回應**：使用者說「不要」時，即時語音模型也聽得到，可能另外說一句；核心只送它固定句，不改 instructions。
- **打字「不是我」的誤判**：已選定人物時，整句打「不是我」（例如回答別的問題）也會改回全家共用；沒有選定時不受影響。
- **「這次互動」的範圍**：說不要（或「不是我」、不一致、復原預設選定）之後，核心記下這位家人 10 分鐘（`DEFAULT_DECLINE_MS`），跨重建、新的通話、改路徑與 SP-02b 都不再問；認出另一位家人或選定任何一位家人時清掉。一般的選單改回全家共用（不是在復原預設選定）不記。10 分鐘是暫定值，不是由鏡頭判斷的「互動結束」。
- **12 秒後備不管有沒有聽到**：問句一直沒被念出（例如模型沒照念、或播放被打斷）時，12 秒後照樣選定，使用者可能根本沒聽到問題；畫面上那一行與之後的「不是我」是唯一的提示。
- **「換人」「Not me」在已選定時一律改回全家共用**：不管是不是預設選定的、也不管句子是在回答什麼。
- **改路徑的接續**：`LiveCall.close("fallback")` 會把還在等選定的候選交給下一通，但目前的程式只在連線階段（問候之前）改路徑，那時還不會有候選；這條路只有單元測試。
- **聲音與臉不一致**只在通話中的聲音（SP-02b 開著）比對到另一位家人時偵測；門檻未校準。
- 17 §9.2 選定之後逐句聲音撤銷的規則沒有實作（SP-02b G2 照舊只記 log）。
- 頁面那一行的位置與樣式沒有在 Mac 上看過。

## 7. 驗證結果

在雲端容器（Linux、Node.js 22）執行，另一個 agent 同時在旁邊的 worktree 跑測試（負載較高）：

- `npm run typecheck`：通過。
- `npx vitest run`（審查修正之後）：119 個測試檔、2,251 項通過、5 項略過、0 失敗。本批觸及的 10 個測試檔由 248 項變成 277 項（memory-live 37→51、memory-parse 45→47、memory-view 14→19、memory-voice-delegation 27→29、memory-apikey 35→36、memory-chat 7→8、apikey-integration 5→6、live-integration 10→11、memory-service 43→44、identity-wake-voice 25→26；舊的候選卡測試改寫，沒有刪除覆蓋）。
- `npm run build`：通過（只有既有的 chunk 大小警告）。
- repo 根目錄：`node scripts/verify-aios.mjs` PASS（型別檢查、2,251 項通過、5 項略過、build、mock 流程）；`git diff --check` 沒有問題；`node scripts/check-bilingual-docs.mjs`（沒有 `--record`）只回報 5 組改過的文件還沒記錄指紋（16、目前實作、驗證索引、本紀錄、SP-02b），要在翻譯審閱後才 `--record`。

## 8. Mac 試用步驟（未執行）

前提：macOS App、家庭記憶已開、George 的記憶檔已連結到家人辨識、有一兩筆釘選的記憶（例如「不吃香菜」）、本次人物選「全家共用」。

1. 看著螢幕開始即時語音（ChatGPT 方案）：問候之後應聽到「我要用 George 的記憶，好嗎？」，畫面上方出現「即將用 George 的記憶｜不是我」，**沒有卡片**。
2. 不說話等 8 秒：那一行變成「正在用 George 的記憶」，狀態列「本次人物：George · 記憶 N 筆」。問「晚餐吃什麼？」應避開香菜。
3. 重新開始一通，問句播完後直接說「記住，我不喝咖啡」：應立刻選定，確認問句說「記在 George 名下」（核心對這一句的處理已經用 George）。模型對這一句的語音回覆不一定已經用到 George 的記憶；接著問「晚餐吃什麼？」，這一輪應避開香菜。
4. 重新開始一通，在問句還沒念完時說「不要」：應聽到「好，這次只用全家共用的記憶。」，本次人物維持全家共用；這一通與同一次互動不再問。
5. 說「不是我做的」「不要開燈」（問句播完之後）：應被當成一般的話，George 被選定。
6. 選定之後說「不是我」：本次人物改回全家共用，通話重建（第一句「好，已經更新了。」）。
7. 在記憶管理撤回 ChatGPT 方案即時語音的同意後重做第 1 步：不應聽到任何問句，畫面那一行照樣出現；按「不是我」不選定；不按則 8 秒後選定。
8. 打字聊天（看著螢幕，問候之後）：輸入「晚餐吃什麼」，回答下方應有「本次人物：George（鏡頭認出）」，畫面上方有「正在用 George 的記憶｜不是我」；按「不是我」改回全家共用。
9. 說「收起」：那一行藏起來，本次人物不變。
10. 打開「通話中辨認說話者」，不看螢幕開始通話，說幾句話：聲音認出後聽到「我要用 George 的記憶，好嗎？」，之後同第 2–4 步。
11. API key 路徑（`NOUS_MEMORY_ROUTES` 列出 `api_key`）重做第 1–4 步。
12. 英文介面重做第 1、8 步，確認問句、那一行與按鈕都是英文，名字照原樣。

## 9. 獨立審查後的修正（2026-11-02）

| # | 問題 | 修正與測試 |
|---|---|---|
| 1 | 聲音樣本比逐字稿晚到，可能選錯人；選定的 await 期間收到不一致會被漏掉 | 預設選定後 10 秒內聲音指向另一位家人 → 改回全家共用、念不一致句、這次不再問；await 期間的不一致依先後回 `mismatch_voice` 或選定後立刻復原，頁面不先顯示「正在用」。兩種先後都有測試（memory-live） |
| 2 | 文件說觸發的那一句的回覆已經用 George 的記憶，不正確 | §1 D2、§3.1、Mac 第 3 步改寫：核心對那一句的處理用新世代，模型的語音回覆不一定；SP-02b 中途選定會撤銷重建 |
| 3 | 打字聊天可能用到通話中的聲音候選，回條卻寫「鏡頭認出」 | `memoryFaceCandidate()`，打字只用臉（memory-service） |
| 4 | 說不要只在這一通有效 | 核心記下 10 分鐘，跨重建、新通話、改路徑與 SP-02b（memory-live、memory-service） |
| 5 | 只有鏡頭換人也說「鏡頭和聲音不一致」 | 分成 `mismatch_face`「鏡頭看到的是另一位家人…」與 `mismatch_voice`（memory-live） |
| 6 | 沒有選定、有臉的候選時打「不是我」被當成一般聊天 | 當成說不要（memory-service） |
| 7 | 換人或撤銷時頁面那一行可能留著 | `presenceChanged()`／`cleanup()` 送 `declined`（memory-live） |
| 8 | 收起後選定時那一行又跳出來；選定時重讀可能顯示別人 | 收起保留到下一次新的提出；名字取自那張卡；本次人物是別人時收掉（memory-view） |
| 9 | 改路徑時還在等選定的候選被默默丟掉 | `handOff()` 交給下一通（同一張卡、同一個時間、不重問）（memory-live；見 §6 的限制） |
| 10 | 多張臉時仍可能用聲音候選 | 多臉時不提、也不用聲音候選（identity-wake-voice） |
| 11 | 漏掉的否定說法 | 重複否定、句首否定加停頓、please don't、提到全家共用都算；「不要開燈」仍是一般要求（memory-live） |
