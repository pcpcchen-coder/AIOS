<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem4b-2026-10-30.md) | [English](memory-mem4b-2026-10-30.en.md)

# MEM-4b 語音交辦自動帶記憶：雲端驗證與 Mac gate

日期為 2026-10-30，Asia/Taipei。起點是 main `a5c7df3`（已含 MEM-0 至 MEM-4a 與 HIST-1），在獨立 worktree 分支 `claude/mem-4b` 實作，沒有提交、推送或合併。全部人物、帳號、任務與記憶內容都是虛構的 canary 測試資料。

**本批狀態：MEM-4b 的程式與雲端（Linux）可驗部分已完成；Mac gate 全部未執行、未通過。** 語音交辦帶記憶跟著既有旗標：`NOUS_MEMORY_ROUTES` 要列出 `task`（API key 路徑另外要列出 `api_key`）才打開，沒有新增旗標；關閉時和 MEM-4a 逐位元組相同。不能據此宣稱 Nous 在真機上已能從語音安全交辦帶記憶的任務。

## 1. 擁有者決定（George，2026-10-30）

1. **兩條語音路徑的條件不同。** ChatGPT 方案即時語音（live）：記憶開著而且不是 passive（沒設定、關閉、不可用、路徑沒放行、另一通在用）就做受保護交辦，**不需要 codex 同意**，因為原句是核心自己從 sideband 解析的使用者語音，不是交給語音模型的記憶。OpenAI API key 即時語音：只有這通帶記憶規則（旁路接上，也就是有 `openai_realtime` 同意）時才做；沒有同意就不開旁路，維持 MEM-3「請求一個位元組都不差」的保證。
2. **原句卡改成受保護。** 核心持有卡上的原句；SSE 只送不透明的卡片 ID（`delegate_card`），可信主視窗經 IPC 取標題；按「交辦」算直接確認（via `confirmation`），走 MEM-4a 的受保護交辦（帶記憶，受旗標、同意與加密保存限制）。旗標關閉時卡片和今天完全一樣（`delegate_blocked` 帶標題、按下去經 HTTP 建立不帶記憶的任務）。
3. **最後一句只是短肯定時（選 C）。** 「好」「對」「可以」這類肯定詞（白名單）之後模型才交辦時，自動綁到緊接在前的那一句（合格、沒用過、時窗內、同 session／世代，而且兩句之間模型真的問過），用它當標題，不出卡片；不符合就退回卡片（帶記憶的通話）或照常交辦。「好」綁到前一句的風險見 §7。

## 2. 設計與實作

### 2.1 核心記下的原句（`server/memory/live.ts`）

- `LiveMemoryBinding` 新增 `heard`：最近 8 句使用者原句（繁體），每句記 `{text, at, speechStart, itemId, session, epoch, used, eligible}`。session 與世代來自 `MemoryService.voiceStamp()`（記下當時的本次人物）。
- 只在 `handleUser` 分類之後寫入；助理的話不經這裡，永遠不會成為原句。只有 `voiceTurn` 結果是 `none` 的一般句子才合格；下列一律記成不合格（`eligible: false`）：回音（`isEcho`）、確認詞（「確認記住」等）、回答臉部候選的「是／不是」、等待中語音卡的「取消」、記憶指令、「我是 X」這類自我介紹（就算本次人物沒有改變；審查 minor 1）、頁面確認卡開著時說的「確認執行」或「取消」。
- 使用者打字（live 的 `input user_text`、API key 旁路上 `typed` 的 user 項目）讓之前的原句全部不合格。
- 通話撤銷或結束時清空。

### 2.2 綁定（`binding.delegate`）

1. 等佇列（還沒處理完的 final 先處理）。
2. 找那一句：
   - live 依順序：開口時間不晚於工具到達的最後一句；
   - API key 依觸發項目（§2.4）。
   如果有一句已開口、開口時間不晚於工具到達，但 final 還沒到，最多等 `ASR_GRACE_MS`（2 秒，具名常數，Mac 上校正）。等完還沒到就沒有可信原句，不退回更舊的那句。
3. 那一句要合格、在 `DELEGATE_WINDOW_MS`（30 秒）內、session 與世代和現在相同、沒用過。用過的回 `delegate_once`（同一句不會交辦兩次）。
4. 否定或猶豫（「不」「不要」「不用」「算了」「等一下」「取消」、no、wait、don't、stop…）：這次不交辦、不往前找（審查 M1）。短肯定（§1 第 3 點，只認肯定詞白名單）：只看緊接的前一句，要合格、沒用過、時窗內、同世代、自己不是肯定或否定，而且那句之後、肯定之前要有一則助理逐字稿（模型真的問了）；不跳過任何句子（審查 M2）。其他短句（例如「寫首詩」）是一般的一句話，自己就是標題，照樣要通過第 6 步的相似度。
5. 用過就標記。
6. 模型的描述和原句（正規化後）的二字片段 Dice 係數低於 `DELEGATE_ARG_MATCH`（0.1，具名常數，Mac 上校正），就當成對不上（§2.3）。
7. `MemoryService.delegateVoice` 走 MEM-4a 的 `delegateProtected`：
   - 核對 session 與世代；
   - `observeVoiceUtterance`（新的 via `voice_heard`）→ `issueDelegation`／`consumeDelegation`；
   - 依原句檢索（任務引擎的 claude／chatgpt 同意，8 筆、4 KB）；
   - 先寫依賴索引，再 `TaskPort.submit`（`origin: user_sentence`）。
   臉部候選還沒有結果時只用全家共用。

### 2.3 三態政策

`voiceDelegateDecision` 有三個結果：

- `protected`：核心建立受保護交辦；
- `run`：照舊由頁面交辦，不帶記憶；
- `card`：出受保護原句卡。

只有放行而且綁到可信原句時才是 `protected`。綁不到（ASR 缺漏、逾時、換人、`sealed()` 為 false、Dice 對不上、短肯定前沒有合格的句子）時：

- 帶記憶的通話出卡；
- 沒帶記憶的通話照舊經頁面交辦（不帶記憶）。

舊的兩態 `delegatePolicy` 保留給旗標關閉的情況，輸出逐位元組不變（快照測試）。

### 2.4 API key 路徑（`server/apikey-call.ts`、`shared/realtime-ga.ts`）

- `parseGaEvent` 的 `function_call` 帶 `response_id`。
- 旁路在 `response.created` 記下這個回應的觸發項目：
  - 核心送出的 `response.create` 都帶 `response.metadata.nous_trigger`（自己的 event_id），上游在 `response.created` 的 response 物件回送；依這個標記對應，不靠送出的先後（審查 minor 4）。工具結果之後的接續回應沿用原本那一句；核心要念的句子是 null。
  - 其他回應：最近的輸入是麥克風提交（`committed`）的項目就是它；是打字就是 null。
- `function_call` 用 `response_id` 找回觸發項目，只綁那個項目的語音辨識逐字稿。打字觸發、沒有 `committed` 的逐字稿、或找不到 `response_id` 的呼叫都沒有可信原句。
- `delegate_task` 本來就是核心工具，頁面略過；受保護交辦不呼叫 `ToolHost`。

### 2.5 輸出、log 與頁面

- 交回語音模型的是固定句 `{ok:true, status:"delegated", engine, note:"已開始處理，完成會通知"}`，不含標題或筆數。同一次交辦第二次呼叫回 `delegate_once`。給語音模型的任務標題仍照 MEM-4a 的 `taskTitleFilter`。
- 模型描述只記字數；log 不記原句或描述。
- live 的「收到交辦」log：通話帶記憶或放行受保護語音交辦（`delegatePort()` 不是 null）時只記字數；旗標關閉時和之前逐位元組相同（審查 minor 2）。
- 新的 `LiveCoreEvent`：
  - `{kind:"delegated", task}`：`task` 是外殼（`TaskPort.publicGet`），不帶筆數。頁面像文字聊天的 `delegatedTask` 一樣處理；任務還沒結束就加入 `realtimeTaskIds`（完成時通知），SSE 的完成事件比它先到時立刻通知（審查 minor 7）；
  - `{kind:"delegate_card", card}`：只有卡片 ID。
- tasks IPC 新增兩個 op（`desktop/tasks-ipc.mjs` 只接受 `dc_` 加 24 個十六進位字元的卡片 ID，多的欄位丟掉）：
  - `card_title`：取原句卡標題；
  - `card_delegate`：按「交辦」。卡片一次性、10 分鐘有效，而且綁建立時的本次人物 session 與世代：換人或世代改變（`replacePresence`）就作廢，點擊與取標題都回 `not_found`「這張卡片已失效（可能換了人物或超過時間）；請再說一次」（審查 M3）。不能受保護交辦時，用核心持有的原句建立不帶記憶的任務（和 MEM-4a 的卡片一樣），回應帶 `memory: "unavailable"`，頁面顯示「這次沒有帶記憶」（審查 minor 3）。

### 2.6 旗標

- 需要 `routeEnabled("task")` 和 `routeEnabled(route)`；API key 另外要在 `NOUS_MEMORY_ROUTES` 列出 `api_key`；這條路徑也不能被停用。沒有新增旗標。
- 旗標關閉時，`delegatePort()` 是 null：live 的工具執行層、API key 旁路與頁面都走 MEM-4a 的路徑。

### 2.7 介面（雙語）

新增頁面可見的文字「這次沒有帶記憶」，並把既有的「這張卡片已失效（可能換了人物或超過時間）；請再說一次」加進 `src/messages.en.json`（原本只在核心的翻譯表）。交辦卡沿用既有的 `memoryView.showDelegate`。交回模型的固定句和 MEM-2／3 的交辦句一樣是給模型的指示，不經翻譯表。

## 3. 與計畫或決定的差異（照實記錄）

1. **沒帶記憶的通話綁不到原句時照舊經頁面交辦（`run`），不出卡**，包括 Dice 對不上和短肯定前沒有合格句子的情況。計畫寫「退回卡片」；這裡只在帶記憶的通話出卡，因為沒帶記憶的通話裡模型的描述不含記憶，照 M15 讓頁面交辦即可。
2. **API key 的工具結果接續回應沿用原本的觸發項目**，例如先 `recall_memory` 再 `delegate_task`。計畫寫「核心觸發的 `response.create` 沒有可信 ASR」；這裡只把核心要念的句子當成沒有可信 ASR。理由：接續回應回答的是同一句使用者語音，信任程度和原本的回應相同。核心請求以 `response.metadata` 標記對應（不靠先後）。
3. **原句卡點擊沒有原生點擊權杖**（審查 minor 8）：成果紀錄的 `historyClick` 只用於選單列的原生點擊；交辦卡在主視窗頁面裡，主程序看不到這個點擊，沒有便宜的同等做法。信任邊界和記憶卡點擊相同（可信主視窗的 IPC），列為殘餘風險（§7）。
4. **原句卡的標題與點擊走 tasks IPC**（`card_title`、`card_delegate`），沒有放進記憶 IPC 的 `card_view`／`card_answer`。理由：任務 IPC 已經負責受保護任務的完整內容與重做。
5. 等原句的 grace 只在「已有一句開口、final 還沒到」時才等。live 上沒有任何開口跡象（沒有 `speech_started`、沒有未完成逐字稿）就不等。
6. 「renderer 只負責媒體」仍延後（不在本批）。

## 4. 雲端（Linux）驗證

Node.js 22。真 AES-256-GCM 的記憶快照與任務加密檔；Linux 上用 `flock(1)` 當測試鎖；執行器是假的（不呼叫模型）；live 用假的 LiveCall 或假的 sideband（真 HTTP／SSE），API key 用假的 GA 伺服器（真 WebSocket）。

| 測試檔 | 內容 |
| --- | --- |
| `tests/memory-voice-delegation.test.ts`（新，26） | 旗標關閉時 `delegatePolicy` 的逐位元組快照；三態表；肯定詞白名單與否定／猶豫清單；固定句。live：標題與查詢都是 ASR 原句、執行器收到記憶、頁面只收到外殼、不需要 codex 同意；log 只記字數（canary 不出現）；排除：回音、助理的話、確認詞、記憶指令、打字、確認卡開著時的「確認執行」；時窗過期、用一次、換人（世代改變）都退回；ASR 晚到但在 grace 內仍綁定、grace 後不綁；短肯定綁到緊接的前一句（模型問過）、沒有前一句時出卡（無標題不出卡）；Dice 對不上→受保護卡（SSE 只有 ID、IPC 取標題、點擊帶記憶交辦、一次性）；`sealed` false 不做受保護交辦（點卡建立不帶記憶的任務）；交辦後忘記→`memory_revoked`，換人與通話結束不中止；旗標關閉時沒有 `delegatePort`、卡片照舊。API key：committed → response.created → function_call 綁定、頁面看不到工具呼叫；逐字稿晚到（grace 內）；打字觸發與沒有 committed 的逐字稿不可信；recall_memory → delegate_task 的接續回應依 metadata 綁回原本的項目；頁面與核心回應重疊時依標記歸屬；沒有 `openai_realtime` 同意就沒有旁路、沒有受保護交辦。審查回歸（審查者 probe P1–P5）：P1「不要／等一下／算了／不用」不交辦、不往前找；P2 短請求自己是標題，英文描述對不上時出卡、卡片標題是那一句；P3 不跳過用過的句子、模型沒問就不綁；P4 換人後原句卡作廢（not_found）；P5「我是 George」不合格；minor 2 的 log 只記長度 |
| `tests/memory-boundary.test.ts`（＋2） | `voice_heard` 票證：文字不符拒絕、一次性、較新的輸入使它失效；`voice_heard` 不能換記憶寫入的票證（`issueParsed`、字面句型都拒絕） |
| `tests/live-tool-caller.test.ts`（＋2） | 受保護時不呼叫頁面、交回固定句、同一次交辦第二次回 `delegate_once`、canary 不出現在 log 與輸出；`run` 照舊經頁面；`card` 回卡片輸出、不走舊的記憶分支；打字觸發帶 `fallbackTitle` |
| `tests/live-integration.test.ts`（＋1） | 端到端（假 sideband、真 SSE、加密任務）：任務標題是 ASR 原句，SSE 只有外殼與 `delegated`，沒有 `realtime.host`，交給 Codex 的工具結果是固定句，模型描述不在 SSE、任務或核心處理交辦的 log |
| `tests/apikey-integration.test.ts`（＋1） | 端到端（假 GA、真 SSE、加密任務）：committed → response.created → function_call，標題是 ASR 原句，頁面只收到外殼、沒有工具呼叫，固定句；原句與描述不在 SSE、log 或 HTTP 回應 |
| `tests/tasks-ipc.test.ts`（＋2） | `card_title`／`card_delegate` 的形狀過濾（多的欄位，例如偽造的標題，被丟掉）；頁面只從 IPC 取卡片標題、點擊經 IPC、`delegated` 在任務還沒結束時加入 `realtimeTaskIds` |

`memory-live`、`memory-apikey`、`memory-tasks`、`task-redaction`、`memory-canary` 等既有測試全部不改仍通過（旗標關閉時行為不變的證據）。MEM-4b 的情境集中在新檔，避免改動 MEM-2／3 既有的 fixture。

### 測試結果（本批實際輸出）

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

基準 main `a5c7df3` 是 90 個測試檔、1542 passed、4 skipped。本批新增 34 個測試：新檔 26（含獨立審查的回歸 8 個），加上既有檔 2＋2＋1＋1＋2。

## 5. Mac gate（全部未執行，不能宣稱通過）

前提：`NOUS_MEMORY_ROUTES=task`（API key 再加 `api_key`）、任務已加密保存、記憶開著並允許任務引擎（Claude 或 ChatGPT）。

1. **校正 grace**：兩種到達順序各 10 次以上，記錄 ASR final 和交辦（live 的 `delegation.created`、API key 的 `function_call`）的時間差。兩種順序是「ASR 先、交辦後」與「交辦先、ASR 後」。依分布決定 `ASR_GRACE_MS`；超過 grace 的比例照實記。
2. **ASR 標題品質**：中文、英文各 10 句交辦，記錄任務標題（ASR 原句）和使用者實際說的差異；記錄 Dice 低於 `DELEGATE_ARG_MATCH` 而出卡的次數，依此校正門檻。
3. **模型說話時的回音**：模型念交辦確認時使用者沒說話，確認沒有用模型的話建立任務。
4. **電視或旁人**：電視播一句像交辦的話，模型因此交辦時，記錄綁到哪一句（這是已知風險，見 §7）。
5. **短肯定**：「幫我規劃晚餐」→ 模型問「要交辦嗎？」→「好」，標題是第一句；「不要」「等一下」「算了」一律不交辦；只說「好」（前面沒有請求）時出卡或照常交辦；在中間插一句別的請求，記錄綁到哪一句。
6. **沒有同意的情況**：live 沒有 codex 同意仍能受保護交辦；API key 沒有 `openai_realtime` 同意時沒有旁路、照 M15。
7. **Keychain 拒絕**：任務金鑰不可用（`sealed` false）時不做受保護交辦，畫面與語音照實說明。
8. **交辦後忘記與換人**：執行中忘記那筆記憶，任務以 `memory_revoked` 停止；換人或結束通話，任務繼續。
9. **完成通知沒有洩漏**：完成時語音通知只用外殼或依同意的標題，錄音確認沒有念出其他家人的帶記憶標題。
10. **P2 committed／item_id 對應**：API key 旁路上 `input_audio_buffer.committed` 的 `item_id`、`response.created` 的 `response.id`、`response.function_call_arguments.done` 的 `response_id` 都對得上；任一項不成立時，API key 的受保護交辦不放行。
11. **受保護原句卡**：帶記憶的通話描述對不上時出卡，畫面標題來自 IPC（SSE 抓包沒有原句）；按「交辦」帶記憶；旗標關閉時卡片和 MEM-4a 相同。

## 6. 未完成項目與下一個 gate

- 「renderer 只負責媒體」（API key 路徑把工具與問候也移到核心）仍延後。
- `ASR_GRACE_MS`、`DELEGATE_ARG_MATCH`、肯定詞與否定詞清單都是未校準的初值。
- 下一個 gate：§5 的 Mac 第 1–11 步，特別是第 1、4、5、10 步。

## 7. 殘餘風險

- **「好」綁到前一句（George 決定 3＝C 的已知代價）**：使用者說「好」「對」「可以」時，核心把緊接在前、模型問過之後的那一句當成標題。那一句可能是另一件事，或是電視、旁人說的話；使用者的「好」也可能是在回答別的問題。Dice 只能擋掉和模型描述完全無關的句子。猜錯時任務標題是錯的句子，但仍是使用者那邊真的說過的話，不是模型的改寫；記憶依那一句檢索。否定與猶豫（「不要」「等一下」…）一律不交辦。
- **電視或旁人**：ASR 收到的任何人聲都可能成為原句（和 MEM-2 語音確認相同的限制）。
- **ASR 錯字**：標題就是 ASR 原句，錯字不會被模型「修正」。這是刻意的取捨（不讓帶記憶的改寫進標題）。
- **API key 回應歸屬**：核心請求依 `response.metadata` 標記歸屬；上游如果沒有回送 metadata（Mac 第 10 步要確認），核心的回應會被當成頁面或 VAD 的回應，歸給最近的麥克風項目（仍是使用者的語音）。
- **頁面的「（系統通知）」算打字**：API key 路徑上頁面送出的通知是 `input_text` 的 user 項目，旁路把它當成打字，讓之前的原句全部不合格。這是安全方向的誤判（之後的交辦退回卡片或照常交辦，不會用錯的原句）。
- **原句卡點擊**：沒有主程序看得到的點擊權杖（§3 第 3 點）；主視窗頁面若被注入腳本，可以替使用者按「交辦」（和記憶卡點擊相同的信任邊界）。
- **依順序綁定（live）**：live 沒有 item 對應，只靠順序、時窗、開口時間與一次性；模型很晚才交辦時，中間插入的話可能被當成原句（受 30 秒時窗限制）。
- **模型可能不再呼叫 delegate_task**：模型看到固定句後應說「已開始處理」；它若自己改寫說明，語音內容可能和標題不同（標題以核心為準）。
- MEM-4a 的殘餘風險（上網查詢可能帶到記憶、刪除不是安全抹除、核心記憶體有明文）同樣適用。

## 8. 重跑

```sh
cd prototype/ambient-shell
npm ci
npx vitest run tests/memory-voice-delegation.test.ts tests/memory-boundary.test.ts tests/live-tool-caller.test.ts tests/live-integration.test.ts tests/apikey-integration.test.ts tests/tasks-ipc.test.ts
cd ../..
node scripts/verify-aios.mjs
```

Linux 需要 util-linux 的 `flock`；沒有時真檔案測試會略過，不會假裝通過。

## 9. 獨立審查與修正（2026-10-30）

審查找到 0 個 blocker、3 個 major、8 個 minor 與數個 nit；審查者的 probe（P1–P5）併入 `tests/memory-voice-delegation.test.ts` 當回歸測試。

| 項目 | 修正 |
| --- | --- |
| M1 短肯定判斷太寬 | 只認肯定詞白名單；新增否定／猶豫清單，這次一律不交辦；其他短句是一般的一句話（照樣要通過相似度）。原本 §3 的「少於 4 字也算短肯定」差異已刪除。 |
| M2 往前找會跳過用過或不合格的句子 | 只看緊接的前一句（合格、沒用過、時窗內、同世代），而且兩句之間要有助理逐字稿；不符合就出卡（帶記憶）或照常交辦。 |
| M3 原句卡沒有綁本次人物 | 卡片記下 session 與世代；換人或世代改變時作廢，點擊與取標題回 `not_found` 與既有的固定句；`replacePresence` 清掉全部原句卡。 |
| minor 1 | 只有 `voiceTurn` 結果是 `none` 才合格；「我是 X」一律不合格。 |
| minor 2 | 放行受保護語音交辦時，live 的「收到交辦」log 只記字數；旗標關閉時不變。 |
| minor 3 | 點卡退回不帶記憶的任務時，IPC 回 `memory: "unavailable"`，頁面顯示「這次沒有帶記憶」。 |
| minor 4 | 核心的 `response.create` 帶 `response.metadata.nous_trigger`，依上游回送的標記歸屬；新增接續回應與重疊的測試。 |
| minor 5 | §7 記下頁面的「（系統通知）」算打字（安全方向的誤判）。 |
| minor 6 | 等佇列也受 grace 的時限（`Promise.race`）。 |
| minor 7 | `delegated` 到達時任務已結束就立刻通知。 |
| minor 8 | 原句卡點擊沒有便宜的原生點擊權杖，記在 §3 與 §7。 |
| nit | 打字觸發明確帶 `itemId: null`；SSE 的 `delegated` 不再帶 `memory_used`；`waitHeard` 逾時時移除等待者；`DELEGATE_CARD` regex 只留一份（`shared/protected-tasks.ts`）；三態政策拿掉沒用到的 `released` 參數。 |
