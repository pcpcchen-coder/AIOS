<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem5b-2026-10-30.md) | [English](memory-mem5b-2026-10-30.en.md)

# MEM-5b 工作決定（work_summary）連到任務與連鎖撤銷：雲端驗證與 Mac gate

日期為 2026-10-30，Asia/Taipei。起點是 main `d0ff7bb`（已含 MEM-0 至 MEM-5a 與 HIST-1），在獨立 worktree 分支 `claude/mem-5b` 實作，沒有提交、推送或合併。全部人物、任務標題、句子與記憶內容都是虛構的合成資料或 canary。

**本批狀態：MEM-5b 的程式與雲端（Linux）可驗部分已完成；Mac gate 全部未執行、未通過。** 功能預設關閉：`NOUS_MEMORY_ROUTES` 要列出 `work_summary`，而且任務要確實加密保存（MEM-4a 的加密模式、金鑰沒有問題），兩者都成立才會出選擇卡。旗標關閉時行為和 MEM-5a 完全相同。

George 睡覺前授權用**保守預設**完成所有 MEM 工作。§3 列出的每一個產品決定都是預設，**全部待 George 確認**。

同日的獨立審查沒有 blocker，有 1 個 major（連鎖撤銷範圍太大）與 7 個 minor；本文件是修正後的版本，修正內容見 §8。

## 1. 範圍

今天的缺口：「記住這次選了方案 B」被存成一筆永久的一般筆記「這次選了方案 B」，沒有連到任何任務，任務刪掉或成果撤回時也不會跟著清除。依 [16 §5](../16_Nous_Memory_Layer_Design_2026-10-26.md#5-寫入更正與來源)（`derived_from`）、[§8](../16_Nous_Memory_Layer_Design_2026-10-26.md#8-忘記換人與晚到回覆)（「後續摘要須記錄完整依賴；來源被忘記時同步清除」）、[§11](../16_Nous_Memory_Layer_Design_2026-10-26.md#11-分批實作與放行) 與 [ADR-0002](../adr/ADR-0002-nous-family-memory.md)：

1. **觸發**：旗標 `work_summary`（`NOUS_MEMORY_ROUTES` 白名單新增，預設關閉）加上 `tasks.sealed()`。只認可信主視窗打字的明示記憶指令：「記住＋這次／剛剛／上次／剛才＋選／決定／採用／定了／用…」與英文「remember I chose / we decided / I went with …」。沿用 `parse.ts` 的所有排除（第三人、引文、假設、玩笑、敏感、不確定、問句、今天）；未成年拒絕。
2. **選擇卡**：最多 5 個最近 24 小時成功完成、沒有撤回、在本次人物範圍內（D2 的 `taskScope`）、讀得到內容的受保護任務；另有「只記成一般筆記」與「取消」。任務標題只經 IPC（turn／card_answer 的回應），不經 SSE。點選算直接確認，票證綁世代、人物與原句。沒有可選的工作時照舊記成一般筆記，並照實告知。
3. **事實**：`kind: "work_summary"`，值＝使用者原話（不經模型摘要，不含任務標題或成果），`derivedFrom: { taskId }`，不設期限。檢索照一般同意規則；模型只收到原話。
4. **連鎖撤銷**（審查 M1、m7 之後）：(a) 依賴的記憶被忘記、更正、過期或人物被刪除而撤回成果時，連到那些任務的工作決定在同一次提交裡忘記，做到固定點；記憶關閉、撤回同意、依賴索引超過上限只撤回成果、**保留**工作決定（可以回頭的動作不刪使用者的原話）；(b) 任務被刪除（HIST-1 的 HTTP 刪除，沒有記憶票證）不直接改記憶：檢索前先排除，記憶檔開啟時與可信主視窗的下一次 turn／list 對帳時一次提交忘記；(c) 對帳只清任務已不存在（`missing`）的，讀不到的任務不清。
5. **閱讀器**：記憶清單（`memory-view`）加「工作決定」篩選與連結標籤；不動成果紀錄（`history-view`、`history-search`）。
6. **隱私**：log 只記筆數；canary 測試確認標題與成果不在快照、`ContextFact`、模型 payload、SSE 與 log。

不在本批：從語音建立工作決定（即時語音的「記住這次選了 B」照舊出 MEM-2 的語音卡、記成一般筆記）、模型摘要、從成果自動抽取（16 §8 仍禁止）、全家共用的工作決定。

## 2. 設計與實作

### 2.1 解析（`server/memory/parse.ts` 的 `workDecision`）

只看 `parseMemoryText` 已經接受的 `remember` 段落（所以第三人、引文、假設、玩笑、敏感、不確定與問句已經在 `content()` 排除），而且 `expires` 是 `none`（「記住今天…」不算）、parse 判成 `note`（審查 m2：判成偏好的，例如「這次決定不要加辣」，和旗標關閉時一樣交給一般記住與衝突確認）。中文：值開頭是可有可無的「我／我們」，接「這次／這一次／剛剛／剛才／上次／上一次」，再接「選了／選擇了／選擇／選／決定了／決定／採用了／採用／定了／用了／用」與至少一個字。英文：可有可無的 this time／just now／last time，接 I 或 we，再接 chose、picked、selected、decided（on／to）、went with、settled on、opted for、used，而且後面要有受詞。審查 m1 另外排除：used to（以前習慣）、picked up（接人、拿起）、受詞是 nothing／anything／none／it；中文的「用了很久／好久／一下」（時間長短）、「這次用中文／英文」（回覆方式）、沒有說選了什麼的「這次選了」。其他漏網的說法仍會出選擇卡，使用者可以選「只記成一般筆記」。「記住媽媽這次選了 B」不是工作決定（開頭不是第一人稱），照 MEM-1 的現狀處理；「幫媽媽記住她這次選了 B」「remember he chose plan B」照舊以第三人拒絕。

### 2.2 觸發與選擇卡（`MemoryService.process` 的 remember 分支）

順序：沒有選定人物 → 照舊出澄清卡（全家共用／取消，記成一般筆記）；本次人物是未成年 → 照舊回「未成年」；`workSummaryOn()`（旗標＋任務端有 `scopedList`＋`tasks.sealed()`）而且 `workDecision(seg)` → `workChoices()`：

- 範圍用 `scopeNow()`（和 `taskScope(false)` 同一條 D2 規則：沒有用到記憶的任務、全家共用或本次人物的帶記憶任務）。
- 任務端的 `scopedList`（`server/store.ts` 的 `memoryTaskViews`，nous.ts 與測試共用）照可信主視窗清單的規則（`listFor`），範圍外、撤回中（`hiddenNow`）或讀不到內容（`contentMissing`）的一律給外殼（`protected: true`）。審查 m3：傳進去的範圍條件先用外殼上就有的欄位（範圍、成功、沒有撤回、沒有 `cancel_reason`、24 小時內）篩選，不合格的任務不解密。
- 只留 `status: "succeeded"`、沒有 `withdrawn`、沒有 `cancel_reason`、`finished_at` 在 24 小時內（不晚於現在加 1 分鐘）、不是外殼的任務，依完成時間新到舊最多 5 個（`WORK_CHOICES_MAX`、`WORK_CHOICE_WINDOW_MS`，在 `shared/memory.ts`）。

有可選的工作 → 出 `work_summary` 卡（`MemoryCardView`：`value`、`subject_name`、`tasks[{task_id,title,finished_at}]`、`options ["task","note","cancel"]`）並停下；卡片狀態只存在核心（`CardState.work_summary`：段落、出卡時的人物、列出的任務 ID）。沒有可選的工作 → 回條「最近 24 小時沒有可以連結的已完成工作，改用一般記住處理」（`not_found`；審查 m4：不預先宣告結果），接著走原本的一般流程（已記得、衝突澄清或保存），結果在下一條回條。

審查 m5：turn 的 request_id 快取不保存工作標題（存成空字串）；同一個 request_id 重送時，卡片仍有效才依目前的任務重新取得標題（已刪除或不再可選的不列），卡片失效時不列任何工作。記憶關閉、記憶層關閉與對帳忘記時快取一起清掉。

卡片只在 turn 與 card_answer 的 IPC 回應裡（主視窗主框架、本機核心頁面），SSE 沒有這張卡或它的內容。畫面是既有的記憶 Surface（`data-visibility-reason="user_request"`，同一個 request_id）。

### 2.3 回答（`cardAnswer` 的 `work_summary`）

- 共同檢查沿用：卡片存在、沒過期（2 分鐘）、世代沒變（換人、暫停、更正、忘記都換世代）；卡片一次性（先刪再處理，選錯工作也會用掉這張卡）。
- 再檢查未成年、本次人物仍是出卡時那位。
- `note`：已經有同一個鍵與同一句、而且不是工作決定的記憶 → `unchanged`；否則 `writeRemember`（和今天一樣的一般記住，含來源票證）。因為工作決定只認 parse 判成 `note` 的句子，一般流程的偏好衝突確認在這裡不會發生（審查 m2）。
- `task`：`task` 必須是卡上列出的其中一個；`writeWorkSummary` 在按下時重新核對旗標、加密保存、記憶開著、這個工作仍可選（沒刪、沒撤回、在範圍內、24 小時內），已有同一工作同一句 → `unchanged`；容量、長度、摘錄上限與一般記住相同。
- 來源票證：`observeConfirmation(卡片原句)`＋`issueParsed`；重新解析用 `workSummaryBodies(taskId, part)`：原句第 part 段必須仍是工作決定，命令欄位（`op: "work_summary"`、值、主題、鍵、`task`、`scope: "subject"`）必須完全相同。任務 ID 只能來自核心卡片上列出、使用者點選的那一個。
- 寫入：`kind: "work_summary"`、`profileId` 本次人物、`source.kind: "explicit"`、`excerpt` 原句（≤240 字，否則值）、`by: null`、`expiresAt: null`、`derivedFrom: { taskId }`。回條「記在 {0} 名下的工作決定了：{1}」。

### 2.4 檢索與送模型

`retrieve.ts` 的有效類別加入 `work_summary`，其餘規則（人物範圍、household、期限、同意、相關性、8 筆／4 KB）不變；`ContextFact` 只有 `text`（原話）、`source`、`at`、`expires`。`MemoryService.usableFacts` 在三個呼叫點（`withChat`、`voiceContext`、`delegateProtected`）之前先排除連到的任務已不存在（`taskState` 是 `missing`）的工作決定；任務還在、只是成果撤回的照常（審查 M1）；任務端不知道時照常。`shownKind` 加入 `work_summary`：清單、「你記得我什麼？」、聊天的更正／忘記目標都看得到它。

### 2.5 連鎖撤銷

- **(a) 依賴的記憶沒了（固定點）**：`withdrawalCauses` 把 MEM-4a 的撤回分成兩種原因：`forgotten`（依賴的記憶被刪——忘記或過期——或版本變了——更正——或人物被刪除）與 `reversible`（記憶關閉、同意撤回）。`settleWithdrawals`（`commit` 呼叫，可單獨測試）只把 `forgotten` 的任務連到的工作決定刪掉（墓碑）→ 再算一次撤回（用到那些工作決定的成果也撤回，原因同樣是 `forgotten`）→ 直到沒有新的。每一輪至少多撤回一筆成果才有下一輪，所以輪數不超過依賴索引筆數；另設上限 `results.length + 1`。log 只寫「（撤回受保護成果 N 筆）（連帶忘記工作決定 M 筆，K 輪）」。有連帶忘記時提交成功後換世代。
- **(b) 可以回頭的撤回（審查 M1）**：記憶關閉、撤回同意、依賴索引超過上限而丟掉的有效成果，只撤回成果（成果內容照 MEM-4a 刪除），**不忘記**工作決定，也不換世代、不清對話歷史。記憶關閉或沒有同意時，檢索本來就不送；重新開啟後工作決定照常列出與檢索。
- **(c) 任務刪除與對帳（審查 m7）**：成果紀錄的刪除（App 與網頁都是 HTTP `/api/history/:id/delete`）沒有記憶票證、也不一定來自可信主視窗，所以刪除本身不碰記憶檔。`usableFacts` 立刻讓它不被檢索；`reconcileWork` 在記憶檔開啟時、以及可信主視窗的下一次 `turn` 與 `list`（互斥區內）把連到已不存在任務的工作決定在一次提交裡忘記、換世代，log「工作決定連帶忘記 N 筆（任務已不存在）」。`tasks.sealed()` 是 false（沒有加密保存或金鑰不可用）時一律不清（開檔時 log 照實寫略過）；讀不到內容（解密失敗、檔案損壞）的任務仍在清單上，算存在，**不清**（和 MEM-4a B1 一致）。只有 `missing` 才清：成果撤回、任務還在的不清。
- **(d) 當機**：刪除寫完、對帳之前當機，記憶檔裡還有那筆工作決定，但不會被檢索，下一次開檔或 turn／list 的對帳會忘記它。

撤銷與對帳不看旗標：旗標關掉之後，既有的工作決定照樣依上面的規則忘記。

### 2.6 快照

不需要新版本：MEM-5a 的 version 4 已經能存 `kind: "work_summary"` 與 `derivedFrom`。有工作決定時寫 4；全部忘記後依內容寫回 3（有依賴索引）或 2，和 MEM-5a 的 `diskForm` 相同。旗標關閉或沒有工作決定時，寫入的檔案和 MEM-5a 逐位元組相同（`tests/memory-store.test.ts` 既有的對照仍通過）。

### 2.7 畫面（`src/memory-view.ts`）

- 選擇卡：標題「要連到哪一個工作？」、要記住的原話、最近完成的工作（標題、完成時間、「連到這個工作」）、說明「只保存你說的這句話，連到你選的工作；不會保存工作的標題或成果。這個工作被刪除，或它用到的記憶被忘記或更正時，這筆工作決定也會一起忘記；關閉記憶或撤回同意不會刪除它。」、「只記成一般筆記」、「取消」。每個「連到這個工作」按鈕的無障礙標籤是「連到：{標題}」。
- 清單：工作決定標「工作決定 · 連到：{標題}」（只在任務屬於目前範圍時有標題）、「工作決定 · 連到的工作不在目前範圍內」或「工作決定 · 連到的工作已不存在」。`MemoryFactView` 新增 `kind` 與 `work: { task_id, title, state }`，標題由核心在 `list`、`card_view`、查看卡時經 `scopedList` 解出，只經 IPC。
- 記憶管理：「類別：」下拉選單（全部／工作決定），只篩選畫面；每次打開記憶管理回到「全部」。成果紀錄畫面與搜尋沒有改。

### 2.8 介面文字（雙語）

新的頁面文字在 `src/messages.en.json`（17 條），核心的固定句型在 `server/messages.en.json`（6 條）。`tests/memory-view.test.ts` 檢查英文卡片除了使用者的話與任務標題之外沒有中文；`tests/memory-work-summary.test.ts` 檢查每一條新的核心句型都有英文、而且英文裡沒有中文字。

## 3. 設計決定（全部待 George 確認）

| # | 決定（保守預設） | 理由 | 待 George 確認 |
| --- | --- | --- | --- |
| W1 | 旗標 `work_summary` 預設關閉、和 `task` 分開；另外要求 `tasks.sealed()`（加密模式、金鑰沒有問題） | 連到明文或只在記憶體的任務沒有可靠的刪除與撤回 | 待 George 確認 |
| W2 | 只從可信主視窗打字的明示「記住」建立；即時語音照舊是一般筆記；記憶管理的新增照舊 | 語音的確認流程與卡片不同，下一批再看 | 待 George 確認 |
| W3 | 只給選定、不是未成年的本次人物；沒選人時照舊出全家共用／取消的澄清卡（記成一般筆記）；工作決定不做全家共用、不記 `by` | 工作決定是個人的；範圍規則（D2）也是依人物 | 待 George 確認 |
| W4 | 卡上最多 5 個：成功、24 小時內完成、沒有撤回或撤回中、讀得到、在 D2 範圍內；新到舊；包含沒有帶記憶的任務，也包含標題是模型改寫的交辦（不只 `origin: "user_sentence"`） | 使用者自己在卡上核對標題；只限原句會讓大多數交辦都不能選 | 待 George 確認 |
| W5 | 沒有可選的工作：照舊記成一般筆記，加一條照實的回條 | 不讓使用者以為已連結 | 待 George 確認 |
| W6 | 點選算直接確認；卡片一次性（選錯工作也會用掉）；按下時重新核對旗標、加密與可選性；綁世代與人物 | 和其他記憶卡一致 | 待 George 確認 |
| W7 | 值＝原話（和一般記住一樣去掉開頭的「我」）；不設期限；`source.kind` 是 `explicit`；摘錄是整句原句 | 16 §5 保留原話；期限的規則等 George | 待 George 確認 |
| W8 | 同一個工作、同一句 → 已經記得；同一個工作可以有不同的句子 | 一個工作可以有多個決定 | 待 George 確認 |
| W9 | 「只記成一般筆記」照今天的一般記住保存；工作決定只認 parse 判成 `note` 的句子，偏好句照舊走一般記住與衝突確認（審查 m2）；已記得的判斷不把同句的工作決定算進去 | 和旗標關閉時相同 | 待 George 確認 |
| W10 | 檢索照一般同意規則；連到的任務已不存在的先排除；成果撤回、任務還在的照常（審查 M1） | 16 §7；刪除與對帳之間不讓它被用 | 待 George 確認 |
| W11 | 聊天與記憶管理可以更正或忘記工作決定；更正保留原本的任務連結 | 更正的是說法，不是工作 | 待 George 確認 |
| W12 | （審查 M1 後改）只有來源真的被忘記時才連帶忘記：依賴的記憶被忘記、更正、過期或人物被刪除，做到固定點；**關閉記憶、撤回同意、依賴索引超過上限只撤回成果，保留工作決定**，也不換世代 | 16 §8「來源被忘記時」才清；可以回頭的動作不刪使用者的原話 | 待 George 確認 |
| W13 | 連帶忘記後換世代（用過的對話歷史清空） | 和忘記一致 | 待 George 確認 |
| W14 | 對帳只清任務已不存在（`missing`）的；任務端沒有加密保存或金鑰不可用時一律不清；讀不到內容的任務不清 | MEM-4a B1：不能把讀不到當成已刪除；撤回不是刪除（審查 M1） | 待 George 確認 |
| W15 | 清單上的任務標題只在目前範圍內才顯示；記憶管理看其他人物時也只顯示「不在目前範圍內」 | D2 | 待 George 確認 |
| W16 | 「工作決定」篩選只在記憶管理；成果紀錄不加 | 依指示不碰 history-view／history-search | 待 George 確認 |
| W17 | 連鎖撤銷與對帳不看旗標，一直開著 | 撤銷是安全規則，不是功能 | 待 George 確認 |
| W18 | （審查 m7）任務刪除（HTTP，沒有記憶票證）不直接改記憶；記憶檔開啟時與可信主視窗的下一次 turn／list 對帳時才忘記，在那之前檢索先排除 | 記憶的寫入只來自核心自己的規則與可信主視窗的動作 | 待 George 確認 |
| W19 | （審查 m1）中英的固定排除：used to、picked up、受詞 nothing／anything／none／it；「用了很久／一下」「這次用中文／英文」「這次選了」 | 降低誤出卡片；漏網的仍可以選「只記成一般筆記」 | 待 George 確認 |

## 4. 雲端（Linux）驗證

Node.js 22，雲端容器。真 AES-256-GCM 的記憶快照與任務加密檔、真 rename／fsync、Linux 上用 `flock(1)` 當測試鎖；只有資料金鑰的包裝是假的（`fakeBox`）。執行器是假的，不呼叫任何模型。

| 測試檔 | 內容 |
| --- | --- |
| `tests/memory-work-summary.test.ts`（新，32；審查後加 13） | 解析正例（中 5、英 4）與負例（偏好、今天、第三人開頭、第三人拒絕、假設、玩笑、不確定、問句、敏感、沒有「記住」；審查 m1／m2：used to、picked up、selected nothing、decided on it、用了很久、這次用中文、這次選了、偏好句）；旗標關閉＝一般筆記、快照 version 2；旗標開但沒加密＝一般筆記；沒有可選的工作＝一般筆記＋照實回條；選擇卡只列成功、24 小時內、沒有撤回、範圍內，最多 5 個、新到舊，標題經 IPC；選不在卡上的工作被拒；點選後 `kind`、值、`derivedFrom`、沒有期限、version 4，快照沒有標題或成果 canary；卡片一次性；同一句同一工作回 `unchanged`；按下時任務已刪除回 `not_found`；「只記成一般筆記」與「取消」；換人後卡片失效、另一位人物看不到 George 帶記憶的任務；未成年拒絕、沒選人走澄清卡；模型 payload（`withChat` 的 `ContextFact` 與任務執行器收到的記憶）只有原話、沒有標題、成果或任務 ID，log 與 SSE 來源（`TaskStore.subscribe`／`subscribeDeleted`）沒有 canary；刪除任務不改記憶檔、下一輪 turn 先對帳一次提交忘記 2 筆、墓碑沒有內容、那一輪的檢索看不到；`list` 也先對帳；**競態**：點選後在不同時間點刪除任務，最後都沒有留下連到它的工作決定；**兩跳的固定點**（忘記「不吃香菜」→ T1 撤回 → W1 忘記 → T2 撤回 → W2 忘記，同一個 revision，log「2 筆，2 輪」，寫回 version 3）；`settleWithdrawals` 單元測試：5 跳的輪數等於跳數、不超過 results＋1，記憶關閉與撤回同意一筆都不忘；**審查 M1**（審查者的探針 P1、P2 改成的回歸測試）：關閉記憶只撤回成果、兩筆工作決定都保留、重新開啟後照常檢索；撤回同意保留；依賴索引超過上限保留而且不換世代；探針 P3：「remember I used to like tea」不出卡；探針 P4（審查 m3）：卡片不解密 24 小時外的任務標題；即時語音在旗標開著時仍是一般筆記；審查 m5：request_id 快取沒有標題、重送時重新取得、刪除後不列；同句的工作決定不擋「只記成一般筆記」；**刪除與提交之間當機**：檢索先排除，重啟後對帳忘記；任務金鑰換掉或沒有加密保存時不清；單一任務檔損壞（金鑰正確）時任務仍在、不清、標籤是不在範圍內；清單的連結標籤（範圍內有標題、範圍外沒有）；有工作決定才寫 4、刪掉後回 2；IPC 過濾；新句型都有英文 |
| `tests/memory-view.test.ts`（＋2，假 DOM） | 選擇卡的標題、工作、按鈕順序、按鈕的無障礙標籤「連到：{標題}」、`task` 選擇、`user_request`、同一個 request_id，中英；清單的「工作決定 · 連到：…」「已不存在」、記憶管理的篩選，中英 |
| `tests/memory-retrieve.test.ts`（改 1） | MEM-5a 的「`work_summary` 不送」改成「照一般規則送、只有原話、沒有任務 ID；沒同意不送」 |
| `tests/apikey-route.test.ts`（調整） | `NOUS_MEMORY_ROUTES` 的 `work_summary` 預設關閉、可以和其他值一起列出 |
| `tests/fixtures/memory-service.ts` | harness 可接 `workSummary` |

時間相關的判斷用注入的時鐘（測試把它設成目前時間，因為任務的完成時間是真的時間）；沒有牆鐘上限的斷言。

### 測試結果（本批實際輸出）

```text
npm run typecheck                      (no errors)
npx vitest run (run 1)                 Test Files  94 passed (94)
                                       Tests  1746 passed | 4 skipped (1750)
npx vitest run (run 2)                 Test Files  94 passed (94)
                                       Tests  1746 passed | 4 skipped (1750)
npx vite build                         ✓ built
node --check desktop/*.mjs desktop/*.cjs (each)   (no errors)
node scripts/verify-aios.mjs           PASS (its full suite, run 3: 94 files, 1746 passed, 4 skipped)
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed (after --record)
node scripts/check-pstack.mjs          pstack 0.15.29: 172 upstream hashes, 56 skills in both clients, agents and model roles verified.
git diff --check                       (no output)
```

基準 main `d0ff7bb` 是 93 個測試檔、1712 passed、4 skipped；本批新增 34 個測試（新測試檔 32，其中 13 個是審查後加的；畫面 2），另把 `tests/memory-retrieve.test.ts` 的 1 個測試改成新的規則。以上是審查修正後的實際輸出。

## 5. Mac gate（全部未執行，不能宣稱通過）

前提：簽章過的 App；MEM-1 與 MEM-4a 的 Mac 步驟已做（任務加密保存）；`.env` 的 `NOUS_MEMORY_ROUTES` 加上 `work_summary`（第 6 步另加 `task`）；虛構人物 George 與 Amy；log 開著。

1. **旗標**：啟動 log 有「工作決定已放行（NOUS_MEMORY_ROUTES，Mac gate 尚未通過）」。拿掉 `work_summary` 重啟，選定 George 打「記住這次選了方案 B」：回條是「記在 George 名下了：這次選了方案 B」，沒有選擇卡（和 MEM-5a 相同）。
2. **選擇卡**：放回旗標。交辦兩件小工作讓它們完成，再打「記住這次選了方案 B」：記憶 Surface 出現「要連到哪一個工作？」、兩個工作的標題與完成時間、「只記成一般筆記」「取消」。中英各截圖一張。按「連到這個工作」：回條「記在 George 名下的工作決定了：這次選了方案 B」；「你記得我什麼？」顯示「工作決定 · 連到：{標題}」。
3. **沒有可選的工作**：用一份全新的資料（或等 24 小時之後），同一句：回條先說「最近 24 小時沒有可以連結的已完成工作，改用一般記住處理」，再是一般的保存回條。
4. **範圍**：切到 Amy：George 帶記憶的工作不在 Amy 的卡上；記憶管理看 George 的清單時，連到 George 帶記憶工作的那一筆只寫「連到的工作不在目前範圍內」。
5. **刪除後對帳**：在「成果紀錄…」刪除第 2 步連結的工作（原生確認）：log 這時沒有記憶的變動；再打一句話（或打開「你記得我什麼？」）：log 有「工作決定連帶忘記 1 筆（任務已不存在）」，記憶清單裡那筆工作決定消失。
6. **撤回連帶忘記（`task` 也開）**：記住「我不吃香菜」，交辦「幫我規劃一週晚餐」（帶記憶）；完成後「記住這次選了第二份菜單」連到它；再交辦「把第二份菜單寫成採買清單」（會用到上一筆工作決定），完成後也連一筆。在記憶管理忘記「不吃香菜」：兩個成果都撤回、兩筆工作決定都消失；log 有「連帶忘記工作決定 2 筆，2 輪」。
6a. **可以回頭的撤回不忘（審查 M1）**：重做第 6 步的前半（一個帶記憶的工作，連一筆工作決定），在記憶管理關閉記憶：成果撤回，log 沒有「連帶忘記工作決定」；重新開啟記憶：那筆工作決定仍在清單上。撤回 George 對 Claude 的同意也一樣。
7. **重啟後對帳**：連一筆工作決定後結束 App；重新打開 App，打開網頁 `/history` 刪除那個工作，馬上結束 App；再打開 App 打一句話：log 有「工作決定連帶忘記 1 筆（任務已不存在）」，清單裡沒有那一筆。
8. **讀不到不清**：在任務的 Keychain 項目上拒絕存取（或用 MEM-4a 的金鑰拒絕步驟）後開 App 並打字：log 有「工作決定對帳略過」，工作決定仍在。
9. **舊版 App**：複製 `userData/memory/` 並記下 `shasum -a 256`。用 main `d0ff7bb`（MEM-5a）建的 App 打開：記憶可用（它讀得懂 version 4），清單不顯示工作決定；不做任何寫入時檔案的 SHA-256 不變。
10. **canary**：用含 canary 的標題交辦一件工作，連一筆工作決定，再問一個相關的問題；`grep -r` 掃 log 與 `userData/`：log 沒有 canary；記憶檔是加密的。

## 6. 未完成項目與下一個 gate

- §5 第 1–10 步（含 6a），特別是第 2 步（實際畫面）、第 6、6a 步（撤回與保留）與第 5、7 步（對帳）。
- 從即時語音建立工作決定、工作決定的期限、全家共用的工作決定：都沒有做，等 George 決定。
- 給 George 的問題：§3 的 W1–W19。

## 7. 殘餘風險

- **召回低是刻意的**：只認固定句型（「這次／剛剛／上次＋選／決定…」），「記住方案 B 比較好」「記住我們最後用 Postgres」都還是一般筆記。測試的正負例是本批作者與審查者寫的，不是獨立評估集；排除詞（W19）是固定詞表，新的說法（例如「剛剛用了很多錢」）仍可能出卡。
- **連鎖撤銷的範圍（W12，審查 M1 後縮小）**：忘記、更正、過期一筆記憶或刪除人物，仍會連帶忘記用到它的工作的工作決定，多跳時可能一次忘記好幾筆，不能復原。關閉記憶、撤回同意與超過上限只撤回成果、保留工作決定；之後這些工作決定連到的是成果已移除的任務。
- **任務刪除不直接改記憶（W18）**：刪除之後到下一次開記憶檔或可信主視窗的 turn／list 之間，那筆工作決定仍在加密檔裡，只是不會被檢索或送出。任務端沒有加密保存或金鑰不可用時不對帳；記憶一直沒用就一直不會清。
- **和 MEM-4c 的互動**：選擇卡與清單的連結標籤會經 `listFor` 解密已結束任務的任務檔（不含成果）取標題，放進 MEM-4c 的標題快取；丟棄時機照 MEM-4c。
- **打字的人不一定是本次人物**：「我是 X」就能把工作決定記在 X 名下（自稱的身分，不是驗證）。
- **標題可能是模型改寫的**（W4）：使用者在卡上看到的是任務的標題，不一定是自己說的原句；保存的仍只有使用者這次說的話。
- **降回 MEM-5a**：舊版讀得到 version 4，但不顯示、不送出工作決定，也沒有連鎖撤銷；在舊版裡刪除的任務，回到 MEM-5b 時由對帳補做。
- **頁面的 DOM** 在卡片處理前留著任務標題（renderer 的記憶體，不是安全抹除）。

## 8. 獨立審查與修正（2026-10-30）

同日的獨立審查沒有 blocker；1 個 major、7 個 minor 與幾個 nit 都已修正。審查者的探針 P1–P4 改成 `tests/memory-work-summary.test.ts` 的回歸測試。

| 項目 | 修正 |
| --- | --- |
| M1 連鎖撤銷太大（關閉記憶、撤回同意、超過上限會永久忘記使用者的原話） | `withdrawalCauses` 分原因；`settleWithdrawals` 只為 `forgotten` 連帶忘記；可以回頭的撤回只撤回成果、不換世代；對帳只清 `missing`；`usableFacts` 只排除 `missing`；卡片說明、W12、§7 與 16 §8 的註記一起改 |
| m1 英文誤判（used to、picked up、selected nothing） | 負向前瞻與受詞排除；中文「用了很久」「這次用中文」「這次選了」也排除（W19） |
| m2 偏好句與「只記成一般筆記」 | `workDecision` 要求 `kind === "note"`；一般筆記路徑的已記得判斷不算工作決定 |
| m3 卡片解密不必要的任務 | 範圍條件先用外殼欄位篩選（範圍、成功、沒有撤回、沒有 `cancel_reason`、24 小時內） |
| m4 回條預先宣告結果 | 改成「…，改用一般記住處理」，結果看下一條回條 |
| m5 request_id 快取留著任務標題 | 快取存成空標題，重送時重新取得；記憶關閉、記憶層關閉與對帳時清掉快取 |
| m6 測試缺口 | 補上語音、記憶關閉／同意／上限、輪數上限、競態、英文負例、單一任務檔損壞 |
| m7 HTTP 刪除不帶記憶票證就改記憶 | 拿掉 `subscribeDeleted` 的連動；改由開檔與可信主視窗 turn／list 的對帳處理（W18） |
| nit | `shellOf` 的註解歸位；拿掉重複的 `hiddenNow` 篩選（`listFor` 已處理）；「連到這個工作」的無障礙標籤「連到：{標題}」；超過上限的路徑不再換世代 |
