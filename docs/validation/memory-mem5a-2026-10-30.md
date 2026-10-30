<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem5a-2026-10-30.md) | [English](memory-mem5a-2026-10-30.en.md)

# MEM-5a 記憶建議、離線指標與家庭協同（最小）：雲端驗證與 Mac gate

日期為 2026-10-30，Asia/Taipei。起點是 main `7fc7d09`（已含 MEM-0 至 MEM-4c 與 HIST-1），在獨立 worktree 分支 `claude/mem-5a` 實作，沒有提交、推送或合併。全部人物、句子與記憶內容都是虛構的合成資料或 canary。

**本批狀態：MEM-5a 的程式與雲端（Linux）可驗部分已完成；Mac gate 全部未執行、未通過。** 功能預設關閉：`NOUS_MEMORY_ROUTES` 要列出 `suggest`，使用者還要在選單列「記憶…」的記憶管理裡開啟「記憶建議」，兩者都開才會提出建議。不能據此宣稱 Nous 已經「越用越懂」：候選只來自固定規則，每一筆都要使用者按「記住」才保存。

George 睡覺前授權用**保守預設**完成所有 MEM 工作。§3 列出的每一個產品決定都是預設，**全部待 George 確認**。

同日的獨立審查（§10）沒有 blocker，但有 5 個 major：審查者自己寫的 76 句對抗集上，修正前 precision 只有 19.6%、誤記率 80.4%，65 句不該提的有 63.1% 被提出。本文件是修正後的版本；修正前後的數字都照實列在 §4。

## 1. 範圍

依 [16 §4](../16_Nous_Memory_Layer_Design_2026-10-26.md#4-人物綁定與使用同意)（自動建議首版關閉）、[§8](../16_Nous_Memory_Layer_Design_2026-10-26.md#8-忘記換人與晚到回覆)（禁止從成果自動抽取）、[§11](../16_Nous_Memory_Layer_Design_2026-10-26.md#11-分批實作與放行)（候選只在記憶體、24 小時或對話結束丟棄、未確認不參與回答、不從待機音訊、電視或模型學習、只在使用者主動開啟的對話中提出）與 [ADR-0002](../adr/ADR-0002-nous-family-memory.md)（自動整理只在後續 opt-in 批次提出候選）：

1. **候選偵測**（新檔 `server/memory/suggest.ts`）：只用固定規則，不呼叫模型。
2. **何時提出**：可信主視窗打字的一輪處理完之後，每輪最多 1 筆。
3. **只在記憶體**：候選、被拒絕的 key 與頻率計數都不寫檔。
4. **呈現**：回覆下方一行「要記住『我不吃香菜』嗎？［記住］［不用］」，不是新的 Surface。
5. **寫入**：只有按「記住」才寫入，`source.kind` 是 `"suggestion"`。
6. **頻率**：每輪 1 筆、每個世代每小時 3 筆、每 24 小時 10 筆；按「不用」的 key 24 小時內不再提。
7. **家庭協同（最小）**：建議不提全家共用；旗標開著時全家共用的新事實記下 `source.by`；只在查看記憶時顯示「全家共用・由 X 記下・日期」，並說明這不是身分驗證；不推播；轉述照舊拒絕；未成年不提。
8. **旗標**：`NOUS_MEMORY_ROUTES` 新增 `suggest`；`settings.suggestions` 改成布林值。
9. **快照 version 4**：見 §2.6。
10. **離線指標**：見 §4。

不在本批：`work_summary` 的行為（MEM-5b；本批只先放進快照格式；2026-10-30 補記：已在 [MEM-5b](memory-mem5b-2026-10-30.md) 實作，預設關閉）、轉述成別人的記憶、任何自動生效的記憶、從語音提出建議。

## 2. 設計與實作

### 2.1 候選規則（`server/memory/suggest.ts`）

`analyzeSuggestion(text)` 對**整個打字的一輪**（和 `MemoryService.maybeSuggest` 走同一個函式；審查 M1、m3）回傳第一個合格的候選，或不提的原因；`suggestFrom(text)` 只回候選。比對前把彎引號（’）換成直引號、全形小問號（﹖）換成問號，保存的值照使用者打的原樣（審查 M3）。順序：

0. **這一輪要全部是一般聊天**：`parseMemoryText` 的段落裡有明示記憶指令（`command`）或「今天／這次」的要求（`temporal`）就不提。
1. **整輪排除**（所有段落一起看，任何一句、任何一處命中就整輪不提；審查 M1）：`parse.ts` 匯出的引文、玩笑、假設、敏感資料（含連續長數字）、第三人（`THIRD_SPEAKER`、`THIRD_HELPER`、`EN_THIRD`），加上英文轉述（said、told…）、中文的「跟他／告訴她／他覺得」、不確定（`UNCERTAIN`）、健康詞（過敏、藥、懷孕、病、醫生、血壓、不耐、減肥、allergic、medication、pregnant、diet…）、過去式（以前、曾經、之前、小時候、本來（不含「本來就」）、used to、didn't、liked…）、`TEMPORARY`（「今天不要…」）與附加問句（對吧、是不是、right?）。審查後另加：反諷與玩笑（才怪、呵呵、哈哈、XD、lol、haha、said no one、oh great、表情符號）、不確定（應該、我想、我覺得、來著、I think、I guess）、健康詞補充（疹、抗生素、維他命、喉嚨、腫、meds、vitamin、throat、swell、rash、blood sugar…）、**特殊類別**（宗教、政治、成癮與戒斷：穆斯林、清真、齋戒、拜拜、觀音、教會、民進黨、國民黨、選舉、戒酒、戒毒、Lent、Ramadan、halal、kosher、Muslim、church、Fox News、politics、recovery、rehab、sober…；`special`）、**代打與框架**（要我跟你說、幫 X 打、代替、在打字、翻成、翻譯、造句、角色扮演、假裝、「我 N 歲」、年級、作業、here、this is、for my、translate、pretend、role-play、grade、years old；`framing`；審查 M2）。任何子句以第三人開頭（`THIRD_SUBJECT`、`EN_THIRD_SUBJECT`）或只是稱呼（「…啦，媽媽」）就整輪不提；任何**不是問句**的子句有時效詞也整輪不提（「我不喝咖啡。這週而已。」）。
2. **切子句**：依逗號、分號與「但是／可是／不過」、but 切開；頓號不切（「我不吃香菜、洋蔥」是同一個偏好）。
3. **子句句型**：
   - 中文：「我」開頭（前面可以有「以後」），接著副詞（都、很、最、比較、一向、從來、真的…），再接偏好動詞：不吃、不喝、不碰、很少吃、喜歡、不喜歡、討厭、受不了、偏好、愛吃、愛喝、愛看、愛聽、習慣、怕、吃素、是素食者；「吃／喝／用／聽／看」只有在「都、只、習慣」之後才算（「我吃牛肉」不是偏好）。「我們」「我家」「我媽」不會對上句型。
   - 英文：`I` 開頭（前面可以有 from now on），副詞之後接 don't/never eat、drink、like、love、prefer、enjoy、hate、dislike、can't stand、avoid；eat、drink、go to bed 等只有在 always、usually、only、never 之後才算；另認 `I'm (a) vegetarian/vegan`。`I'd`、`I'll`、`I want`、`I need`、`I'm …` 是要求或狀態，不提。
4. **子句排除**：**候選必須是這一輪的第一個子句，或前面只有問句或請求句**（「我爸要我跟你說，我不吃豬肉」、"Oh great, I love soggy fries" 都不提；`context`；審查 M2）；問句（問號、﹖、嗎、呢、吧、什麼、是不是、怎麼…）、段落以問號結尾而候選是那段最後一個子句（"I don't eat pork?"）、受詞是指示詞或代名詞（這道菜、那家、你、it、this、that…）、**受詞不是短名詞片語**（中文超過 12 字、英文超過 4 個詞，或含因為、所以、的話、直到、到月底、為止、until、during、since、because、unless、on my、when、after、before…；`clause`／`too_long`；審查 M3）、結尾的「了」（「我不吃了」「我不吃辣了」；只有「以後都…了」是明確的長期決定）、下一個子句像同一串列舉（"I don't eat pork, beef or lamb"、「我不吃豬肉，牛肉」：只記前半會記錯，整句不提）。
5. **主題**：內容要落在固定主題詞庫的 food、comfort、reply_style、schedule、media；naming 與 other（人名、關係、顏色、寵物…）一律不提。
6. **要保存的值**：和明示「記住…」相同：中文去掉開頭的「我」，英文保留整個子句；`topic`、`key` 用 `parse.ts` 的 `topicOf`、`keyOf`。

`suggestFrom` 是確定性的。`suggestionBodies(text)` 把它轉成來源票證的比對內容（`op: "suggest"`、`part: 0`、`scope: "subject"`）。時效詞的判斷因此從「只看候選所在的子句」改成「整輪所有不是問句的子句」（「我不吃香菜，今天晚餐吃什麼？」仍會提，因為第二個子句是問句）。

### 2.2 何時提出（`MemoryService.maybeSuggest`）

在 `process()` 最後、只有打字那一輪（`via` typed、從第 0 段開始）而且有要送聊天的文字時才看；用整輪原句呼叫 `suggestFrom`（審查 M1）。不提的情況：

- `NOUS_MEMORY_ROUTES` 沒有 `suggest`，或 `settings.suggestions` 不是 `true`，或記憶關閉；
- 這一輪有任何不是一般聊天（`chat`）的段落，也就是有明示的記憶指令、「我是 X」或「今天／這次」的要求；
- 這個世代有還開著的記憶卡；
- 沒有選定人物（包括暫停）、本次人物是未成年；
- 找不到合格的句子；值超過 512 字或記憶已滿；
- 已經有相同或相關的記憶：本人或全家共用的有效記憶裡有同一個 `key` 或相同內容（相同鍵但相反的說法也算衝突，不提）；
- 這位人物這個 `key` 24 小時內按過「不用」；
- 超過頻率（§2.4）。

來源只有 chat 段落：語音（`voiceTurn` 走另一條路，不呼叫 `maybeSuggest`）、任務成果與模型回覆都不會進來。

### 2.3 只在記憶體（`SuggestionBook`）

候選（卡片 ID、核心保存的整輪原句、候選內容、人物、世代、request_id、建立時間）、被拒絕的 key 與頻率計數只在核心記憶體。同時只留一張候選，而且**只屬於提出它的那一輪**：每一個新的打字的一輪開始時（`turn()`，重送同一個 request_id 除外），上一輪沒回答的建議作廢（`dropPending`，不算拒絕；審查 m1，16 §11）。丟棄時機：

| 觸發 | 接線 |
| --- | --- |
| 24 小時 | 每次存取時清掉過期項目 |
| 換世代（換人、暫停、閒置 30 分鐘、OS 鎖定、主視窗導覽、更正、忘記、撤回同意、刪除家人） | `replacePresence` → `suggestions.clear()` |
| 關閉記憶、記憶層關閉、記憶檔寫入失敗而停用 | MEM-4c 的 `dropPlaintext` 一併清 |
| 關閉記憶建議 | `suggestionsOp` |
| 核心關閉 | `shutdown` |

`clear()` 丟掉候選與被拒絕的 key，保留頻率計數（只有時間與世代，沒有內容），讓每天的上限跨世代有效。未確認的候選不在 `MemoryData.facts`，所以不會進檢索、`ContextFact` 或模型 payload。log 只有「記憶建議 1 筆（主題 food）」、略過的原因與「記住 → saved」這類結果，沒有內容。

### 2.4 頻率

每輪 1 筆（結構上只回一筆）；同一個世代 1 小時內最多 3 筆；不論世代，24 小時內最多 10 筆；按「不用」的 `profileId + key` 24 小時內不再提。計數在提出時加一，不管後來有沒有按。

### 2.5 呈現與寫入

- `MemoryTurnView` 新增 `suggestion: { card } | null`。turn 的回應只有卡片 ID（`mc_` 格式），內容只經既有的 `card_view` IPC（`{ kind: "suggestion", card, text, value, subject_name }`）。沒有 SSE 事件。
- 不擋聊天：頁面照常送出這一輪的聊天（帶 `memory_turn`）；回覆串流**完成**（`complete`）之後，`SuggestionPrompt`（`src/memory-view.ts`）才經 `card_view` 取內容，在同一個回覆下方加一行「要記住『我不吃香菜』嗎？［記住］［不用］」（英文 “Remember “I don't eat cilantro”? [Remember] [No thanks]”）。這一行帶 `data-request-id`（同一輪）與 `data-visibility-reason="user_request"`，在對話 Surface 裡面，不是新的常駐 Surface；回覆出錯或被打斷時不出現；換世代時收掉。
- 按「記住」：`card_answer` 的 `confirm`。核心再核對一次（旗標、設定與記憶都還開著、不是未成年、還沒有相同或相關的記憶、世代與人物沒變、沒過期），用卡片上保存的整輪原句 `observeConfirmation` 取得直接輸入，`issueParsed` 以 `suggestionBodies` 重新解析，必須和命令完全相同才發票證，寫入 `source.kind: "suggestion"`、記在本次人物名下、沒有期限。成功後那一行換成核心的回條（「記在 George 名下了：不吃香菜」）。
- 按「不用」：`decline`。記下被拒絕的 key（24 小時、只在記憶體），什麼都不寫，那一行消失。
- 一張卡只能回答一次。不會自動套用任何建議。
- 審查 n3：沒有改成要求 `userInitiated`。核心的 `userInitiated` 只代表「10 秒內點過選單列」，頁面上的按鈕點擊在 IPC 這一層無法和頁面腳本區分；這張卡和其他記憶卡一樣，信任邊界是 IPC 發送者檢查（主視窗主框架）加上頁面只轉送使用者的點擊。

### 2.6 快照 version 4（`server/memory/store.ts`）

| 欄位 | version 2／3 | version 4 |
| --- | --- | --- |
| `settings.suggestions` | 只能是 `false` | 布林值 |
| `fact.source.kind` | `explicit`、`voice_confirmed` | 另加 `suggestion` |
| `fact.source.by` | 沒有 | `string \| null`；只有全家共用的事實可以不是 null，而且必須是既有人物 |
| `fact.kind` | `preference`、`note` | 另加 `work_summary`（MEM-5b 才有行為） |
| `fact.derivedFrom` | 沒有 | `{ taskId } \| null`；只有 `work_summary` 可以不是 null |

- 記憶體裡一律是 version 4 的形狀（`normalizeSnapshot` 為舊檔補 `by: null`、`derivedFrom: null`，加在最後）。
- 寫入時由 `diskForm` 決定版本：有 version 4 才有的內容（建議開關是 `true`、`suggestion` 來源、不是 null 的 `by`、`work_summary` 或 `derivedFrom`）才寫 4；否則有受保護成果（或曾以 3 寫過）寫 3、其他寫 2，拿掉 `by`、`derivedFrom`（與 version 2 的 `results`），欄位順序和 MEM-4c 逐位元組相同（§5 的對照測試用 MEM-4c 的 store 做同一個操作，解密後的明文完全相同）。
- version 4 **不是單向的**：那些內容都移除後（關掉建議、忘記或更正那幾筆、刪除記下的人），下一次寫入照 2／3 寫，舊版 App 又讀得到。這和 version 3 不同（3 一旦寫過就不回 2）。
- 審查 n2：從 4 回到舊版本時，沒有受保護成果就直接寫 2（跳過 3）。這是安全的：3 只多了 `results`，沒有 `results` 時 2 就是完整的內容，舊版 App 兩者都讀得到。
- 審查 n1：「逐位元組相同」指的是**快照**（解密後的明文與版本）。IPC 的形狀在旗標關閉時也變了：`MemoryTurnView` 多了 `suggestion: null`、`MemoryFactView` 多了 `by_name: null`、`MemoryStatusView` 多了 `suggestions`。
- 審查 m4：在 MEM-5b 之前，`work_summary` 雖然能存，但檢索（`retrieve.ts`）不送給模型，清單、查看卡與聊天的更正／忘記目標也不列（`shownKind`），避免日後從 MEM-5b 降回本版時被送出或標錯。
- **舊版 App 讀到 version 4**：MEM-4c 以前的 store 只認 1、2、3，讀到 4 會當成損壞（`corrupt`），記憶停用（畫面顯示「記憶檔損壞或被改動，無法解密；不會覆寫成空的記憶」），**不會覆寫**檔案。§5 用 `7fc7d09` 原樣的 store 驗證了這一點。降回舊版前要先關掉建議，並忘記或更正 `suggestion` 來源與帶 `by` 的事實（或接受舊版停用記憶）。

### 2.7 家庭協同（最小）

- 建議只記在本次人物名下，從不提全家共用。
- 旗標 `suggest` 開著時，全家共用的新事實（聊天或語音的「改記全家共用」、聊天裡對全家共用記憶的更正）記下 `source.by`：當時選定的本次人物，沒有選定時是 null。旗標關閉時一律 null（快照照 2／3 寫）。
- 審查 M5：**記憶管理的新增與修改一律記 null**（管理畫面不代表本次人物在說話）；**本次人物是未成年時也記 null**。
- 只在查看記憶時顯示（「你記得我什麼？」卡與記憶管理）：「全家共用・由 George 記下・2026/10/30 10:00」，清單下方一行「「由誰記下」只是記下當時選定的本次人物，不是身分驗證。」中英都有。
- 不推播、不通知其他家人；轉述（「媽媽不喝咖啡，幫她記住」）照舊拒絕；未成年不提建議。
- 刪除人物時，全家共用事實上「由這個人記下」的 `by` 一併清成 null（刪除人物也刪除這個關聯）。

### 2.8 旗標與設定

- `server/config.ts`：`NOUS_MEMORY_ROUTES` 的白名單加 `suggest`，`memoryRoutes.suggest` 預設 `false`；`server/nous.ts` 傳給 `MemoryService`（`suggest` 選項）並在啟動 log 寫出狀態。
- 新 IPC op `suggestions`（`{ enabled, token }`，`desktop/memory-ipc.mjs` 與 `shared/memory.ts`）：只有記憶管理的權杖能用；開啟還要旗標，否則回「記憶建議目前沒有開放（需要 NOUS_MEMORY_ROUTES 列出 suggest）」；關閉時丟掉記憶體裡的候選。`setup`（開關記憶、改同意）保留建議設定。
- 記憶管理顯示「記憶建議：已關閉（預設）。［開啟記憶建議］」與說明；旗標沒開時顯示「記憶建議：沒有開放（NOUS_MEMORY_ROUTES 沒有列出 suggest）。」，如果之前開過（設定還是 `true`）仍會有「關閉記憶建議」按鈕，讓降回舊版前能先關掉（審查 m2）。首次設定卡上的第四個選項仍是停用的勾選框，文字改成「自動提出記憶建議（預設關閉；要用時請在選單列「記憶…」開啟）」。
- `MemoryStatusView.suggestions`：`{ available, enabled }`（記憶檔沒載入時沒有這個欄位）。

### 2.9 介面文字（雙語）

新的頁面文字在 `src/messages.en.json`，核心的固定句型在 `server/messages.en.json`：建議那一行與按鈕、無障礙標籤「記憶建議」、`title` 提示「只有按「記住」才會保存；不會自動記住。」、來源「記憶建議（按了記住）」、「全家共用・由 {0} 記下・{1}」與說明、記憶管理的開關與說明、核心回條（審查 n4：那一行保存固定句型，換語言時重新翻譯；好，不記這一句；記憶建議已關閉，這次沒有保存；已經有相關的記憶，這次沒有保存：{0}；已開啟／已關閉記憶建議；沒有開放）。`tests/memory-view.test.ts` 檢查英文介面沒有殘留中文（使用者的話除外）。

## 3. 設計決定（全部待 George 確認）

| # | 決定（保守預設） | 理由 | 待 George 確認 |
| --- | --- | --- | --- |
| D1 | 只提固定主題詞庫（food、comfort、reply_style、schedule、media）的句子；人名、關係、顏色、寵物、naming 一律不提 | 16 §1：不推測性格或家人關係；寧可少提 | 待 George 確認 |
| D2 | 整輪排除（審查 M1 之後從「整段」改成「整輪」）：任何一處有第三人、轉述、引文、假設、玩笑或反諷、不確定、敏感、健康、特殊類別、代打框架、過去或附加問句，整輪都不提 | 避免記錯人或記錯意思 | 待 George 確認 |
| D3 | 時效詞看整輪所有不是問句的子句；問句子句裡的時效詞不算（「我不吃香菜，今天晚餐吃什麼？」會提「不吃香菜」，「我不喝咖啡。這週而已。」不提） | 最常見的用法照樣可用，跨句的時效說明不會漏掉 | 待 George 確認 |
| D4 | 結尾的「了」不提（只有「以後都…了」可以）；肯定的「吃／喝」只有在「都、只、習慣」之後才算；英文 eat、drink 只有在 always、usually、only、never 之後才算 | 「我不吃了」「我吃牛肉」不是穩定偏好 | 待 George 確認 |
| D5 | 下一個子句像同一串列舉時整句不提 | 只記前半會記錯 | 待 George 確認 |
| D6 | 要保存的值和明示「記住…」相同（中文去掉開頭的「我」，英文整句）；那一行顯示使用者打的那一句 | 保留原話（16 §5） | 待 George 確認 |
| D7 | 相同 `key` 或相同內容（本人或全家共用）就不提，包括相反的說法；英文的 `key` 比較粗（例如 `food:Idon`），會多擋一些 | 衝突交給使用者用「更正…」，建議不碰 | 待 George 確認 |
| D8 | 同時只留一張候選；新的一輪的建議讓上一張作廢（不算拒絕） | 那一行只跟著那一輪的回覆 | 待 George 確認 |
| D9 | 換世代時連被拒絕的 key 一起丟（依照指示）；所以換人或更正之後，按過「不用」的同一句可能再被提一次，由頻率上限約束 | 隱私優先：被拒絕的 key 也有內容 | 待 George 確認 |
| D10 | 頻率計數在提出時加一；計數只在記憶體，重新啟動歸零 | 不寫檔 | 待 George 確認 |
| D11 | 那一行只在回覆**完成**後出現；出錯或被打斷不出現；按「不用」後那一行直接消失；按「記住」後換成回條；不額外確認 | 不擋聊天；點擊本身就是直接確認 | 待 George 確認 |
| D12 | 那一行只寫「要記住『…』嗎？」，沒有寫記在誰名下（名字在回條與 `card_view` 的 `subject_name`） | 照指定的文字 | 待 George 確認 |
| D13 | 旗標關閉時記憶管理不能開建議；可以隨時關；記憶關閉再打開時建議設定保留；首次設定卡不提供這個選項 | 兩者都開才生效，開啟要管理權杖 | 待 George 確認 |
| D14 | `by` 只在旗標開著時、只為全家共用的事實記下；聊天裡更正全家共用的事實時 `by` 改成更正的人（旗標關閉時清成 null）；記憶管理的新增與修改、本次人物是未成年時一律 null（審查 M5）；刪除人物時清掉 | 「最後一次在聊天裡寫的人」比較符合查看時的意義；管理畫面與未成年不掛名 | 待 George 確認 |
| D15 | version 4 只在有 version 4 的內容時寫，內容移除後回到 2／3（不像 version 3 是單向的） | 讓舊版 App 盡量讀得到 | 待 George 確認 |
| D16 | 建議來的記憶送給模型時 `ContextFact.source` 是 `"suggestion"` | 照實標示來源 | 待 George 確認 |
| D17 | 健康詞包含 diet、weight、減肥；過去式包含 before、once | 寧可少提 | 待 George 確認 |
| D18 | 摘錄（`excerpt`）是整輪原句（≤240 字），否則是值 | 和明示記住相同 | 待 George 確認 |
| D19 | 候選必須是這一輪的第一個子句，或前面只有問句或請求句（審查 M2） | 前面的陳述常常改變是誰在說或為什麼說 | 待 George 確認 |
| D20 | 代打、轉達、翻譯、角色扮演、造句、作業、年齡（「我五歲」）與 here、this is、for my 這類框架，整輪不提；宗教、政治、成癮與戒斷也整輪不提（審查 M2、M3） | 避免記錯人、記下特殊類別資料、或替未成年家人記 | 待 George 確認 |
| D21 | 受詞上限中文 12 字、英文 4 個詞，含條件、原因或期間的詞就不提（審查 M3） | 只記短的偏好，不讓原因或期間（可能是健康或宗教）進到值裡 | 待 George 確認 |
| D22 | 建議只屬於提出它的那一輪：下一輪開始就作廢（審查 m1） | 16 §11：對話結束就丟 | 待 George 確認 |
| D23 | MEM-5b 之前不列出、不檢索 `work_summary`（審查 m4） | 規則在 MEM-5b | 待 George 確認 |
| D24 | 「記住」不要求 `userInitiated`（審查 n3，做不到；理由見 §2.5） | 和其他記憶卡同一個信任邊界 | 待 George 確認 |

## 4. 離線指標

### 4.1 測試集

- `tests/fixtures/memory-candidates.zh.json`（123 句，45 句應該提）與 `tests/fixtures/memory-candidates.en.json`（79 句，26 句應該提）。每句標註：應不應該提、期望的值、歸屬（self／third／household／none）、時效（stable／today／temporary／past）與負例類別。
- **誠實說明：這兩份是和規則一起寫的，不是獨立的評估集。** 標註是「應該怎麼做」，不是照規則的輸出改的（所以有 9 句應該提卻沒提），但同一個作者同時寫規則與句子，precision 100% 主要反映的是規則涵蓋了作者想得到的情況。
- **Holdout**：`tests/fixtures/memory-candidates.holdout.json`（30 句，9 句應該提），在 `suggest.ts` 還不存在時寫好，之後沒有修改（SHA-256 `b0a6414599d61a4f80adafaab7295306c716d524c93f1b2a3220aa9ab4331b8e`，寫完時、規則第一次定稿後與審查修正後各算一次，都相同）。第一次定稿後跑了一次；審查修正改了規則，所以又跑了一次（結果相同）。holdout 也是同一個作者寫的，只有 30 句，不能當成獨立評估。
- **對抗集（審查 m3）**：`tests/fixtures/memory-candidates.adversarial.json`，審查者的 76 句（11 句應該提），標註照抄審查者 `probe.ts` 的期望值與類別（歸屬：代打、轉達、翻譯、角色扮演標為 third；類別含 sensitive、health、religion 的算特殊類別）。**修正前**（審查報告，逐段流程）：提出 51、正確 10，precision 10/51＝19.6%，誤記率 41/51＝80.4%，65 句不該提的有 41 句（63.1%）被提出。之後規則是**依這個集合調整的，所以它已經不是獨立的評估集**。

### 4.2 定義（計算在 `tests/memory-suggest.test.ts` 的 `metrics`）

- proposals＝有提出候選的句子數。
- correct＝應該提、值逐字相同、歸屬是本人、時效是 stable（候選一律記在本次人物名下、沒有期限）。
- **precision＝correct／proposals**。
- **false-memory rate＝（不該提卻提了＋提了但值、人物或期限錯）／proposals**。
- recall＝correct／應該提（只報告，不設門檻）。
- 每個負例類別的誤報數；人物錯置＝提了但歸屬不是本人。
- 特殊類別外洩＝標註含 sensitive、health、religion、politics 的負例被提出的次數。
- 門檻：zh、en 與合併 precision ≥ 95%，每個類別誤報 0，人物錯置 0；對抗集 precision ≥ 90%、人物錯置 0、特殊類別外洩 0（審查 m3）。全部用和服務相同的整輪流程（`suggestFrom`）計算。

### 4.3 結果（`npx vitest run tests/memory-suggest.test.ts -t "reports the computed" --silent=false` 印出的數字）

| 集合 | 句數 | 應該提 | 提出 | 正確 | precision | false-memory rate | recall | 人物錯置 | 類別誤報 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zh | 123 | 45 | 42 | 42 | 42/42＝100% | 0/42＝0% | 42/45＝93.3% | 0 | 全部 0（15 類） |
| en | 79 | 26 | 20 | 20 | 20/20＝100% | 0/20＝0% | 20/26＝76.9% | 0 | 全部 0（15 類） |
| zh＋en | 202 | 71 | 62 | 62 | 62/62＝100% | 0/62＝0% | 62/71＝87.3% | 0 | 全部 0 |
| holdout（分開報告） | 30 | 9 | 9 | 9 | 9/9＝100% | 0/9＝0% | 9/9＝100% | 0 | 全部 0（9 類） |
| 對抗集，修正前（審查報告） | 76 | 11 | 51 | 10 | 10/51＝19.6% | 41/51＝80.4% | 10/11 | 有 | 41 句誤報 |
| 對抗集，修正後（已依它調整，不獨立） | 76 | 11 | 11 | 11 | 11/11＝100% | 0/11＝0% | 11/11＝100% | 0 | 全部 0；特殊類別外洩 0 |

負例類別：third_party、household、quote、hypothetical、joke、sensitive、health、past、temporal、question、uncertain、deictic、request、off_topic、not_preference。

漏掉的 9 句（recall 的缺口，都是不提，不是提錯）：「我都十一點睡覺」「我早上都喝拿鐵」（副詞位置不在句型內）、「我不吃豬肉，牛肉」與 "I don't eat pork, beef or lamb"（列舉，D5）、"I love sushi"、"I hate onions"、"I usually go to bed at 11"、"I avoid caffeine"（英文主題詞庫沒有這些詞，D1）、"I keep the AC at 26 degrees"（動詞不在句型內）。

zh、en 與 holdout 的數字在修正前後相同（新的排除沒有擋掉任何應該提的句子）。逐句結果見 §9 附錄。

## 5. 雲端（Linux）驗證

Node.js 22，雲端容器。真 AES-256-GCM、真 rename／fsync、Linux 上用 `flock(1)` 當測試鎖；只有資料金鑰的包裝是假的（`fakeBox`，正式 App 是 safeStorage／Keychain）。不呼叫任何模型。

| 測試檔 | 內容 |
| --- | --- |
| `tests/memory-suggest.test.ts`（新，49；審查後 92） | 指標（§4，各集合的門檻與計算出的數字；holdout 分開報告）；fixture 標註完整；確定性（同一句兩次結果相同、票證內容固定）；32 個負例逐一對應原因（第三人、轉述、引文、假設、玩笑、敏感、不確定、健康、過去、時效、問句、指示詞、要求、主題外、列舉、全家）；`SuggestionBook` 的每小時／每天上限、24 小時拒絕、`clear` 保留計數、只留最新一張與 24 小時過期；服務：打字一輪提出、turn 只有卡片 ID、`card_view` 取內容、聊天照常帶 `memory_turn`、按「記住」寫入 `source.kind: "suggestion"`、快照寫成 4、卡片一次性、記住後不再提；按「不用」快照明文逐位元組不變、同一個 key 不再提、其他句子照常；服務層的頻率（每輪 1、每世代每小時 3、換世代後每天 10）；旗標關閉不能開也不提、設定沒開、沒有選人、暫停、未成年、即時語音（`voiceTurn` 不產生候選）、同一輪有明示記憶指令、開著記憶卡、關閉建議（候選作廢）、記憶關閉；已有相同或衝突（本人與全家共用）；**canary**：turn 的 `suggestion` 欄位、`withChat` 的 `ContextFact`、磁碟快照明文（關閉後再解密）與全部 log 都沒有 canary，只有 `card_view` 有；24 小時過期、OS 鎖定與忘記換世代後卡片失效、失效的卡寫不進去；`by`：旗標開著時全家共用的新增記下「George」、查看卡與管理清單顯示、個人事實沒有、刪除 George 後清掉並寫回 2；旗標關閉時沒有 `by`、快照是 2、明文沒有 `"by"`、`"derivedFrom"` |
| 審查回歸（`tests/memory-suggest.test.ts`） | 對抗集門檻與數字；42 個新的負例對應原因（跨句玩笑、反諷、轉述、時效、明示指令、代打、翻譯、角色扮演、年齡、稱呼、前面有陳述、受詞的條件與期間、特殊類別、健康、表情符號、應該吧、﹖、受詞太長）；彎引號保存原樣；服務層整輪判斷與下一輪作廢（作廢不算拒絕、按記住後摘錄是整輪原句）；`by`：記憶管理的新增記 null、聊天選「改記全家共用」記 George、未成年時 null |
| `tests/memory-parse.test.ts`（＋3，審查 M4） | 中英的 PIN、SSN 句子拒絕；spinach、pineapple、shopping、piano lessons 不被誤判；`parse.ts` 沒有控制字元 |
| `tests/memory-retrieve.test.ts`（＋1，審查 m4） | `work_summary` 不送給模型 |
| `tests/memory-store.test.ts`（＋5） | version 4 來回（建議開關、建議來源、`by`、`work_summary` 與 `derivedFrom`）；version 4 的驗證（`derivedFrom` 只能在 `work_summary`、taskId 格式、`by` 必須是既有人物而且只在全家共用、未知來源）都回 conflict 且不寫檔；竄改（信封版本 4→3、4→5、密文改一個位元）一律 corrupt 且不覆寫；**沒有 version 4 內容時，和 MEM-4c 原樣的 store（`tests/fixtures/memory-store-7fc7d09.ts`）做同一個操作，version 2 與 3 的解密明文逐位元組相同**；version 3 開建議變 4（results 保留）、**MEM-4c 的 store 讀 version 4 回 corrupt、檔案逐位元組不變**、關掉建議回到 3、舊版又讀得到 |
| `tests/memory-view.test.ts`（＋4，假 DOM；審查 m2、n4 加在既有測試裡） | 建議那一行只在同一輪的回覆完成後出現、先經 `card_view` 取內容、`data-request-id` 與 `user_request`、中英文字與按鈕、`title` 提示、按「記住」送 `confirm` 並顯示回條、按「不用」送 `decline` 並消失、`clear` 後不顯示、瀏覽器版不顯示；「全家共用・由 George 記下・日期」與不是身分驗證的說明（中英）；記憶管理的開關要權杖、旗標沒開時照實說沒有開放（中英）、旗標沒開但建議還開著時有「關閉記憶建議」；回條換語言時重新翻譯 |
| `tests/memory-ipc.test.ts`（調整） | `suggestions` op 只收 `enabled` 與 `token`，沒有權杖或型別不對就拒絕 |
| `tests/apikey-route.test.ts`（調整） | `NOUS_MEMORY_ROUTES` 的 `suggest` 預設關閉、可以和其他值一起列出 |
| `tests/memory-retrieve.test.ts`、`tests/memory-service.test.ts`、`tests/memory-store.test.ts`、`tests/memory-view.test.ts`（調整） | 測試資料補上 `by`、`derivedFrom`、`by_name` 與 `suggestion` 欄位 |
| `tests/fixtures/memory-service.ts`、`tests/fixtures/memory-store-7fc7d09.ts` | harness 可接 `suggest` 與 `log`；MEM-4c 原樣的 store（當作舊版 App，不要修改） |

時間相關的斷言都用注入的時鐘，沒有牆鐘上限。

### 測試結果（本批實際輸出）

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

基準 main `7fc7d09` 是 92 個測試檔、1607 passed、4 skipped；本批新增 105 個測試（第一輪 58 個：新測試檔 49、store 5、畫面 4；審查回歸 47 個：建議 43、parse 3、檢索 1）。以上是審查修正後的實際輸出。

## 6. Mac gate（全部未執行，不能宣稱通過）

前提：簽章過的 App；MEM-1 的 Mac 步驟已做；`.env` 的 `NOUS_MEMORY_ROUTES` 加上 `suggest`；虛構人物 George（另一位 Amy 用來測換人）；log 開著。

1. **開啟流程**：啟動 log 有「記憶建議已放行（NOUS_MEMORY_ROUTES，另需在「記憶…」開啟；Mac gate 尚未通過）」。打開選單列「記憶…」：顯示「記憶建議：已關閉（預設）。」按「開啟記憶建議」，回條是「已開啟記憶建議…」。去掉 `suggest` 重啟：記憶管理顯示「沒有開放」，沒有開啟按鈕。
2. **單行建議**：選定 George，打字「我不吃香菜，晚餐吃什麼？」：回覆串流期間沒有任何建議；回覆完成後在同一則回覆下方出現一行「要記住『我不吃香菜』嗎？［記住］［不用］」，不是新的畫面、不擋下一輪。截圖中英文介面各一張。按「記住」：那一行換成「記在 George 名下了：不吃香菜」；「你記得我什麼？」顯示來源「記憶建議（按了記住）」。另一句按「不用」：那一行消失，同一句再說一次不再出現。
3. **不該出現的情況**：即時語音說同一句；未選人物；把 George 標成未成年；同一輪說「記住我不喝咖啡。我不吃洋蔥」；說「我媽不吃辣」「我以前不吃香菜」「我今天不想吃辣」「我對花生過敏」「我不吃香菜。開玩笑的。」「我爸要我跟你說，我不吃豬肉」「我不吃牛肉因為我拜觀音」：都沒有建議。另外說「我不吃洋蔥」出現建議後不回答，再打下一句：上一則的建議消失。
4. **保存**：結束 App 再開：按「記住」的那筆仍在、建議設定仍開著；之前沒回答的建議沒有了。
5. **家庭協同**：選定 George，在記憶管理新增一筆全家共用：「你記得我什麼？」與記憶管理顯示「全家共用・由 George 記下・日期」與「不是身分驗證」的說明（中英）；Amy 的畫面沒有任何推播或通知。刪除 George 的記憶檔後那筆不再顯示「由 George 記下」。
6. **一週實際計數**：照常使用一週，每天記錄 log 的「記憶建議 1 筆」「記住 →」「不用」與「略過（頻率上限…）」筆數（`grep -c`），另外人工記下每一筆提錯的建議（記錯人、記錯意思、不該記的）。算出接受率＝記住／提出、誤提數。照實記錄，交給 George 決定是否擴大或關閉。
7. **舊版 App 讀 version 4**：先複製一份 `userData/memory/`（含 `store.v1.enc`）並記下 `shasum -a 256`。用 main `7fc7d09` 建的 App 打開這份資料：記憶不可用（畫面顯示記憶檔損壞或被改動、不會覆寫），`store.v1.enc` 的 SHA-256 不變。回到 MEM-5a 的 App 照常可用。再關掉建議並忘記建議來的與帶 `by` 的那幾筆（或用沒有 `suggest` 的設定更正它們），確認檔案回到 version 2／3 後舊版又能讀。
8. **canary**：用一句含 canary 的話觸發建議後按「不用」，`grep -r` 掃 log 與 `userData/`：沒有 canary（快照本來就加密，這一步主要看 log）。

## 7. 未完成項目與下一個 gate

- §6 第 1–8 步，特別是第 2 步（實際畫面）、第 6 步（一週真實計數）與第 7 步（舊版 App）。
- MEM-5b（`work_summary`）：快照格式已經在 version 4 裡，行為下一批做。（2026-10-30 補記：已在 [MEM-5b](memory-mem5b-2026-10-30.md) 實作，Mac gate 未執行；MEM-5b 起 `shownKind` 與 `retrieve.ts` 會列出並依同意送出 `work_summary`，D23 的限制只在 MEM-5a 這一版。）
- 給 George 的問題：§3 的 D1–D24；以及要不要把英文主題詞庫擴大（目前英文 recall 76.9%）。

## 8. 殘餘風險

- **測試集不是獨立的。** 202 句的 fixture 與 30 句的 holdout 都是同一個作者寫的；審查者的 76 句對抗集在修正前只有 19.6% precision，修正時又依它調整，所以修正後的 100% 也不代表真實使用時的精確率。下一個沒看過的對抗集很可能再找到漏洞。第 6 步的一週計數才是第一份真實資料。
- **recall 低是刻意的**，英文更低（主題詞庫小）。
- **（已修正，審查 M4）** 原本這裡寫錯了：`parse.ts` 的 `SENSITIVE` 從 MEM-1 起在 `pin`、`ssn` 兩側是字面的 0x08 控制字元，不是 `\b`，所以「記住我的 PIN 是 4821」反而會被存成一筆記憶，spinach 這類字也沒有被誤判。本批改成真正的 `\b`，加上中英測試與「`parse.ts` 沒有控制字元」的檢查。舊版本已經存下的這類記憶不會被自動刪除，需要使用者自己檢查。
- **規則仍然是詞表**：新的說法（新的反諷、方言、錯字、沒有列出的宗教或健康詞）可能漏掉排除而被提出；每一筆仍要使用者按「記住」才保存，畫面上那一行也會照實顯示要記的那一句。
- **整輪排除讓 recall 再降一些**：同一輪裡任何一處有排除詞（例如在別的子句提到「醫生」或「這週」）就整輪不提。
- **打字的人不一定是本次人物。** 客人或其他家人在 George 選定時打「我不吃豬肉」，按下「記住」就記在 George 名下；那一行沒有寫名字（D12），回條才有。
- **使用者貼上的別人的話**（沒有引號）會被當成第一人稱。
- **`by` 來自自稱的身分**：「我是 X」就能成為記下的人；畫面已說明不是身分驗證。
- **version 4 讓舊版 App 停用記憶**（不覆寫）；帶 `by` 的全家共用事實會讓檔案一直維持 4，直到它被忘記、更正（旗標關閉時）或記下的人被刪除。
- **頁面的 DOM** 在回答或換世代前留著那一句（renderer 的記憶體，不是安全抹除）。
- **換世代會丟掉被拒絕的 key**（D9），之後可能再提一次同一件事；每天 10 筆的上限仍然有效，但重新啟動會歸零。
- **英文的 `key` 很粗**（D7），會比中文多擋一些建議，但不會提錯。

## 9. 附錄：逐句結果（審查修正後的規則）

欄位：#、句子、標註（歸屬／時效）、期望（值或負例類別）、實際（值或不提的原因）、判定（OK、MISS＝應該提卻沒提、FP＝不該提卻提了）。由 `tests/memory-suggest.test.ts` 同一套規則產生。

### 9.1 zh（123 句）

| # | 句子 | 標註 | 期望 | 實際 | 判定 |
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

### 9.2 en（79 句）

| # | 句子 | 標註 | 期望 | 實際 | 判定 |
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

### 9.3 holdout（30 句，規則定稿前寫好）

| # | 句子 | 標註 | 期望 | 實際 | 判定 |
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

### 9.4 對抗集（審查者的 76 句；已依它調整，不獨立）

| # | 句子 | 標註 | 期望 | 實際 | 判定 |
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

## 10. 獨立審查與修正（2026-10-30）

審查沒有 blocker，有 5 個 major、4 個 minor 與 4 個 nit；全部處理（n3 照實說明做不到）。

| 項目 | 修正 |
| --- | --- |
| M1 跨句的排除失效（「我不吃香菜。開玩笑的。」會提） | 改成整輪判斷：`analyzeSuggestion` 對整個打字的一輪做全部排除，服務與離線指標走同一個函式；卡片保存整輪原句，來源票證也用整輪重新解析 |
| M2 代打或框架開頭會記錯人（「我爸要我跟你說，我不吃豬肉」） | 候選必須是第一個子句或前面只有問句、請求句（`context`）；新增整輪的 `framing` 類別（要我跟你說、幫 X 打、代替、在打字、翻成、翻譯、造句、角色扮演、假裝、我 N 歲、年級、here、this is、for my、translate、pretend、role-play…）；稱呼子句；對抗集量人物錯置（0） |
| M3 值沒有長度與語法上限，特殊類別資料進到值裡 | 受詞中文 ≤12 字、英文 ≤4 詞，含因為、所以、的話、直到、到月底、until、during、since、because、unless、on my… 就不提；補反諷（才怪、呵呵、XD、lol、haha、表情符號）、不確定（應該吧、我想、I think）；﹖當問號；宗教、政治、成癮整輪排除（`special`），健康詞補充；彎引號 |
| M4 `SENSITIVE` 的 PIN 是字面 0x08 | 改成 `\b`（`pin`、`ssn` 共 4 個字元；檢查過整個 repo 的原始碼沒有其他控制字元）；中英 PIN／SSN 拒絕、spinach 等不誤判的測試；更正 §8 |
| M5 記憶管理的新增記下目前人物（含未成年） | 記憶管理的新增與修改一律 `by: null`；`byFor` 在本次人物是未成年時回 null；測試 |
| m1 沒回答的建議跨輪留著 | 每個新的一輪開始時 `dropPending`（不算拒絕） |
| m2 旗標關閉時無法關掉建議 | `!available && enabled` 時仍顯示「關閉記憶建議」 |
| m3 指標要走服務的流程、加入對抗集 | 指標用 `suggestFrom`（整輪）；新增 `memory-candidates.adversarial.json` 與門檻；修正前後的數字都列在 §4 |
| m4 `work_summary` 可能被送出或標錯 | `retrieve.ts` 只送 preference、note；清單、查看卡與更正／忘記目標也只列這兩種（`shownKind`） |
| n1 | §2.6 說明「逐位元組相同」指快照，不是 IPC 的形狀 |
| n2 | §2.6 說明從 4 直接回到 2（跳過 3）是安全的 |
| n3 | 做不到，理由見 §2.5（`userInitiated` 只代表選單列點擊） |
| n4 | `SuggestionPrompt` 保存固定句型，換語言時重新翻譯 |
