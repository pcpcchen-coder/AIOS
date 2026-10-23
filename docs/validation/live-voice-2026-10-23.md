# 即時語音：ChatGPT 方案路徑（gpt-live-1-codex）＋可切換的 API key 路徑（2026-10-23）

批次：`prototype/ambient-shell` 的即時語音加上第二條路徑。Nous 自己做 Codex 登入，經 `chatgpt.com/backend-api/codex/realtime/calls` 與 `wss://api.openai.com/v1/live/{callId}` 用 `gpt-live-1-codex`，做法和 OpenClaw 相同。原本的 `OPENAI_API_KEY`（`gpt-realtime`）路徑保留，使用者可以切換。

**本文件的狀態：只有 fixture 結果。** 開發環境沒有 ChatGPT 帳號，也沒有麥克風與喇叭，所以沒有呼叫任何真實的 OpenAI 端點。下面的「家中測試」由 George 在自己的 Mac 上執行，結果填進最後一節，並標明是真實結果。

## 1. 用假端點測了什麼（fixture）

全部是 vitest。fixture 包括：假的 chatgpt.com 與 auth.openai.com（可編排的 fetch，`tests/fixtures/fake-chatgpt.ts`）、假的 sideband（`tests/fixtures/fake-sideband.ts`）、假的頁面、假的 WebRTC 與假的時鐘。fake sideband 是手寫的 WebSocket upgrade 伺服器，會和 Node 22 內建的 `WebSocket` 真的握手。fixture 的內容不代表 OpenAI 伺服器的行為。

| 檔案 | 測試數 | 內容 |
|---|---:|---|
| `tests/frameless.test.ts` | 6 | frameless 事件解析（`session.updated` 不算開始，沒有 `session.closed`）、致命錯誤、append 切成 ≤500 bytes、不切斷字元、總長 1,800 字元並加 `[truncated]` |
| `tests/realtime-routes.test.ts` | 16 | `billingLine`；`planStart` 的完整表（3 種偏好 × 3 種 live 狀態 × 2 種 key 狀態）；auto＋從未登入時安靜改用 API key；`planFallback`；確認卡只有說出的回答才開始時窗、卡片過了自己的時限自動當成已關閉；偏好在工作階段中途改變不影響進行中的工作階段；一次一個 live 工作階段；擁有者憑證；工具呼叫只送到擁有者的串流；串流關閉後工作階段立刻結束，等待中的工具呼叫被拒絕，重新整理後可以馬上開始；有副作用的工具逾時回報「結果不明，請確認」；sideband 結束時拒絕等待中的呼叫；auto 只在開始時改路徑；設定錯誤不會改用計費路徑 |
| `tests/codex-auth.test.ts` | 12 | 授權網址參數（client_id、127.0.0.1:1455 回呼、S256、`codex_cli_simplified_flow`、`originator=nous`）；1455 被占用時改用 1457，兩個都被占用時改用裝置代碼；回應 Codex 的 `/cancel`；state 不符時拒絕；沒有帳號 ID 時拒絕而且不存檔；檔案權限 0600；5 個同時呼叫只更新 1 次，而且輪替後的 refresh token 先寫檔；401 時更新後重試，第二次 401 標記需要重新登入；`refresh_token_reused` 標記需要重新登入；更新或換 token 進行中登出時丟掉結果（不寫檔、撤銷拿到的 refresh token）；權杖在 JSON、字串與 inspect 輸出都是 `[redacted]`；`~/.codex/auth.json` 的哨兵檔案內容與 mtime 都不變 |
| `tests/live-route.test.ts` | 16 | 通話網址與 query、標頭（Bearer、`chatgpt-account-id`、`OpenAI-Alpha: quicksilver=v2`、三個不同的 UUID、`originator: nous`、沒有 `OpenAI-Beta`）、JSON 內容預設不送 model，設定 `NOUS_LIVE_MODEL` 才送；sideband 網址與標頭真的到達 fake 伺服器，沒有送 `session.update`；400 `session.model`、403（訊息包含聲音）、429 用量上限（剩幾分鐘）、5xx 的對應，錯誤文字不含權杖、帳號 ID 或 JWT；Location／`openai-session-id` 解析；sideband 5 次都失敗時不回傳 answer；交辦只跑一次，結果切成 ≤500 bytes 的 `delegation.context.append`；交辦一個接一個；空內容回「沒有聽清楚」；致命錯誤結束為 auth；sideband 斷線結束為 `connection_lost`，之後不再 append；`session.close` 只送一次；「還在處理」用 `session.context.append`（不帶交辦 ID）；caller 丟例外時仍以 speakable 結尾並送 `failed`；確認卡狀態在交辦排進佇列時記下 |
| `tests/live-tool-caller.test.ts` | 25 | 預算算式（§2）；工具表與規則文字和 API key 路徑相同；home_control unconfirmed 的回答不說「開了」；每次交辦最多 2 個工具呼叫；工具逾時以 unknown 交給模型；超過預算說「沒有完成：處理超過時間」，有副作用的工具還沒回報時說「結果不明，請確認」（下層不理中止訊號也一樣）；用量上限與登入失效照實說；end_conversation；確認語句：只有整句是確認／取消（錨定比對）而且卡開著或 8 秒內剛被回答時才攔下（speakable，模型與工具都不會被呼叫），審查探針的五句請求在任何卡片狀態下都交給 Codex；有副作用的工具有確定結果後就不是「結果不明」；輪數用完時照已執行的工具輸出說；Codex Responses 的請求形狀（`store:false`、`parallel_tool_calls:false`、標頭）與 429 對應；查模型清單算在每一輪的時限內、兩個 Codex 用戶端共用模型快取、上網查詢在 `HOST_TIMEOUT_MS.web_search` 內結束 |
| `tests/live-voice.test.ts` | 24 | 頁面：「聆聽中」要麥克風、peer、`session.started` 三項證據；「回覆中」只看遠端音量；不需要任何 GA 事件；資料通道與核心的逐字稿依 item id 去重，沒有 item id 時只配對另一個來源的同一份，使用者 10 秒內重說同一句仍然算；確認卡回報卡片時限與結果、POST 失敗重試一次；開始流程在每個 await 之後可以被 Esc／收起／人離開取消；忽略資料通道上的 `delegation.created`；確認卡先回報給核心再交回工具結果；說「確認執行」或按按鈕都能確認；卡片開著時第二個家電指令回 busy；web_search 與 delegate_task 走同一份 callbacks；道別念完才結束；本機「再見」備援；打字；`tool_unknown`；核心的 closed 事件會拆掉 peer，顯示並說出原因，而且不改路徑；Esc 只靜音；腦區光脈衝只來自實際執行的工具 callback（原始碼檢查）；`openRealtime` 在開麥克風前說出通知；改路徑時先關掉 live 的麥克風、說出通知，再開 API key；拒絕時照實說原因 |
| `tests/live-integration.test.ts` | 6 | 核心 ↔ 真的 SSE 串流 ↔ 假的頁面：交辦 → SSE `realtime.host` → 頁面用工作階段憑證呼叫 `/api/realtime/web-search`（走 Codex 額度）→ host-result → speakable append；重複的 call_id 被丟掉；擁有者不符回 403；重新整理（串流關閉）時 sideband 收到 `session.close`，而且不再 append，新的頁面可以馬上開始；sideband 掉線以 `closed connection_lost` 送到頁面；工作階段中途切換路徑不影響進行中的工作階段；`/api/realtime/approval` 要求 `timeout_ms`／`outcome`；**權杖檢查**：把每個 HTTP 回應、SSE frame 與 console／log 輸出串起來，搜尋 access token、refresh token、帳號 ID、`OPENAI_API_KEY`、client secret 和 `SECRET` 標記，結果都是 0 筆 |

API key 路徑的回歸檢查：`tests/realtime-voice.test.ts`（33）、`tests/realtime-bridge.test.ts`（8）、`tests/http.test.ts`（含 :222-249 的即時語音路由）、`tests/sense-controller.test.ts`（CSP `connect-src 'self'`）、`tests/prefs.test.ts`、`tests/idle-settings.test.ts` 與 `tests/voice-commands.test.ts` 的原始碼檢查。**這些測試檔都沒有修改**，全部通過。`tests/prefs.test.ts:148` 也不必改，因為 `describeSeconds` 只讀 `RealtimeBaseInfo` 的欄位。

這次執行：44 個測試檔，691 個測試全部通過（審查修正後；第一版是 667 個，新增 81 個；修改前是 37 個檔、586 個測試。審查修正新增 24 個、改寫 4 個舊的確認語句與 planStart 測試）。

Node 22 `WebSocket` 的自訂標頭：`tests/live-route.test.ts` 的「attaches the sideband…」測試由 fake 伺服器收到 `Authorization`、`chatgpt-account-id`、`OpenAI-Alpha` 與 `session-id`，所以不需要 `ws` 套件，也沒有新增任何依賴。

## 2. 時間預算的算式

常數在 `server/realtime-routes.ts`、`server/live-tool-caller.ts`、`server/live-route.ts`，測試用常數重算，沒有寫死數字。

**等 answer SDP 的上限**（`ANSWER_BOUND_MS`）：

| 步驟 | 毫秒 |
|---|---:|
| 建立通話（`LIVE_TIMEOUTS_MS.call`） | 30,000 |
| sideband 5 次，每次 15,000 | 75,000 |
| 嘗試之間的等待 200·2^n，n=0..3：200＋400＋800＋1,600 | 3,000 |
| **合計** | **108,000** |

正常情況是建立通話約 1–3 秒，加上 sideband 約 0.5 秒。核心接上 sideband 之後才回傳 answer。

**每個工具等頁面回覆的時限**（`HOST_TIMEOUT_MS`）：home_control 62 s（home-bridge 的 `UTTERANCE_MS` 60 s＋2 s）、web_search 32 s（`WEB_SEARCH_TIMEOUT_MS` 30 s＋`HOST_REPLY_MARGIN_MS` 2 s）、home_status 20 s、delegate_task 10 s、get_tasks 5 s、end_conversation 5 s。其中有副作用的 home_control 與 delegate_task 逾時時回報 `status: unknown`（「結果不明，請確認」），其他工具逾時回報 `ok:false`。

**每次交辦的上限**（`DELEGATION_BUDGET_MS`）：

```
maxTurns × turnTimeoutMs + maxHostCalls × max(HOST_TIMEOUT_MS) + marginMs
= 3 × 20,000 + 2 × 62,000 + 3,000
= 60,000 + 124,000 + 3,000
= 187,000 ms（187 秒）
```

`maxTurns = 3` 涵蓋「開冷氣 26 度」需要的三輪：先呼叫 power，再呼叫 ac_temperature，最後說結果。`maxHostCalls = 2` 是每次交辦最多兩個工具呼叫，第三個不會執行，並且照實回報。超過上限時說「沒有完成：處理超過時間（187 秒）」；如果當時有副作用的工具已送出、還沒有可轉述的結果，則說「結果不明，請確認」。交辦超過 10 s 而且頁面上真的有工具還在跑時，會說一次「還在處理，再等一下」，其他時候不說。

**查模型清單也在每一輪的時限內**：沒有設定 `NOUS_LIVE_AGENT_MODEL` 時，第一輪要先查 `/models`。`CodexResponses.turn()` 的時限從查詢開始算，涵蓋「查模型清單＋連線＋串流」，所以 `DELEGATION_BUDGET_MS` 不必另外加查詢時間。ChatGPT 方案的上網查詢那一輪時限是 `WEB_SEARCH_TIMEOUT_MS`（30 s，含查詢），比頁面等 web_search 的 32 s 少 2 s 轉交結果的餘裕。交辦與上網查詢共用一份模型快取，`/models` 只查一次。修正前查詢有自己的 30 s 時限，上網查詢最壞是 30＋30＝60 s，超過頁面的 32 s。

**工作階段上限**：取伺服器的 `session.expires_at` 與 30 分鐘中較早的一個。一個核心同時只能有一個 live 工作階段。

## 審查修正（2026-10-23）

獨立審查找到 10 個問題，每個都有在舊程式上會失敗的回歸測試（把 `server/`、`src/`、`shared/` 換回 77e332d、保留新的測試執行：27 個測試失敗，包括所有新增的測試）。

1. **確認語句吞掉一般請求**：`approvalGuard` 改用 `shared/approval.ts` 的 `exactApproval`（整句去掉標點後就是確認／取消，錨定比對），而且只在卡開著或 8 秒內剛被回答時攔下。沒有卡時「確認執行」也交給 Codex，不再回「目前沒有需要確認的項目」。頁面確認卡用的 `matchApproval` 不變。
2. **開始流程不能取消**：`openRealtime(deps, signal)` 在每個 await 之後檢查；`stopRealtime`（`closeConversation`、Esc、人離開）中止它並清掉 `realtimeStarting`；已經開始的工作階段立刻 `stop()`，不會再開改路徑的那一個。人離開在開始中也會呼叫 `stopRealtime`。
3. **登出被進行中的更新復活**：`CodexAuth` 加登入世代；登出與新的登入都會加一。`refresh()` 與 `exchange()` 在 await 之後比對世代，不同就丟掉結果、不寫檔，並盡力撤銷拿到的 refresh token。
4. **只用 API key 的使用者每次都聽到通知**：auto 下 live 是 `not_logged_in` 時安靜開始 API key 路徑；設定過但不能用（needs_reauth、usage_limit、上游錯誤）才說通知；明確選 live 時照舊拒絕並說原因。
5. **「還在處理」送錯管道**：改用 `session.context.append`（不帶交辦 ID），同 OpenClaw `sendSessionContext`。每個交辦都以 speakable 的 `delegation.context.append` 結尾，包括確認語句被攔下的情況：OpenClaw 的 `runDelegation` 成功與失敗都送 speakable，原始碼裡沒有只送 commentary 就結束交辦的例子，所以 `DelegationResult` 只剩 speakable。
6. **確認時窗的誠實**：交辦排進佇列時記下確認卡狀態與時間；頁面回報 `open` 時帶卡片自己的時限、`resolved` 時帶結果，只有 `said_approve`／`said_reject` 開始時窗，逾時與收起不算回答。POST 失敗重試一次；仍失敗時核心過了卡片時限就當成已關閉。
7. **結果不明的旗標**：有副作用的工具回傳確定結果（不是 `status: unknown`）後就不再是「結果不明」。輪數用完時照已執行的工具輸出說，不說「沒有完成」或「結果不明」；之後的失敗也先說已經執行的結果。
8. **caller 丟例外時頁面卡住**：`delegate()` 接住例外，送 speakable 的失敗句與 `failed`，頁面清掉「思考中」，閒置計時繼續。
9. **逐字稿去重吃掉真的重複**：有 item id 時照舊；沒有時每個來源各記一份，只把另一個來源的同一份配對掉。使用者 10 秒內重說「確認執行」仍然有效。
10. **查模型清單不在時限內**：見 §2。`codex` 與 `codexSearch` 共用 `CodexModelCache`；查詢算在每一輪的時限內；`HOST_TIMEOUT_MS.web_search` 由 `WEB_SEARCH_TIMEOUT_MS + HOST_REPLY_MARGIN_MS` 推導（數字仍是 32 s），`DELEGATION_BUDGET_MS` 仍是 187 s。

## 3. George 的家中測試（Mac，桌面 App）

**事前準備**

- 用這個 commit 建置的 Nous。
- **不需要** Codex CLI。OpenClaw 可以繼續裝著：Nous 用自己的登入，OpenClaw 在 1455 登入到一半時，Nous 會改用 1457。
- `.env` 有 `OPENAI_API_KEY`（步驟 8 要用）。
- 先記錄 `ls -la ~/.codex 2>/dev/null`，最後再記錄一次。
- 先打開 <https://platform.openai.com/usage>，記下目前的 Realtime、Responses 與 web search 用量（截圖）。
- 確認卡流程（家電設為需要確認）目前只有 fixture：在 H2 之前所有設備都是 `allow`，家中測試不會出現確認卡。所以步驟 4 只檢查沒有卡時的確認語句。

每個步驟都保存 `~/Library/Application Support/Nous/nous.log`（只有路徑與計費，沒有權杖），並錄影或截圖。

| 步驟 | 動作 | 預期 | 記錄 |
|---|---|---|---|
| 1 | 選單列 → 即時語音 → ChatGPT 方案（Codex）登入… | 瀏覽器出現同意頁，之後顯示「已登入 ChatGPT 方案（Codex）」。設定顯示 `<email> · <plan>`，選單列顯示 `即時語音：ChatGPT 方案（Codex 額度）· gpt-live-1-codex`。`~/.config/nous/codex-credentials.json` 權限是 600。`~/.codex` 沒有被建立或修改 | 截圖、`stat` 輸出、前後的 `ls -la ~/.codex` |
| 2 | 路徑選「自動」→「開始語音對話」 | 引擎列顯示 `即時語音：ChatGPT 方案（Codex 額度）· gpt-live-1-codex｜交辦工作：…`。「聆聽中」要等麥克風指示亮起之後才出現。沒有假的問候 | 錄影、到聆聽中的秒數。另外記下：伺服器是否接受 `originator: nous`；被拒時畫面的原文 |
| 3 | 說「客廳燈打開」 | 字幕顯示「控制中：客廳燈」，接著是 `⏳ … 已送出、未確認` 或 `✓ … 已確認`。說出的話和字幕的狀態一致，燈真的有變化 | 錄影、log 裡 `home_control` 那一行 |
| 4 | 沒有確認卡時說「確認執行」 | 照一般請求交給 Codex；回答說沒有要確認的事，中控 log 沒有收到指令。另外說「停止播放音樂」「不用開燈，查一下客廳溫度」：都要被當成請求處理，不能回「沒有需要確認」 | 錄影、中控 log |
| 5 | 說「新竹今天會下雨嗎」 | 字幕顯示「上網查詢：…」與「來源：…」，回答有數字 | 錄影 |
| 6 | 說「幫我寫一份報告，比較三家電信資費」→ 說「進度如何」→ 等它完成 | 任務畫面和 API key 路徑完全相同：電子腦下方顯示進度，規劃區依真實步驟的 domain 亮起，完成後出現成果畫面並用語音告知 | 錄影 |
| 7 | 說「再見」 | 道別之後顯示「對話已結束。」；log 有 `session.close` | log |
| 8 | 設定 →「即時語音」→ 登出（即時語音）→ 路徑「自動」→ 開始 | 沒有登入 ChatGPT 方案＝只用 API key 的設定：安靜開始，不說改路徑通知；引擎列變成 `OpenAI API key 計費 · gpt-realtime`，API key 路徑和以前一樣能用。接著把路徑改成「ChatGPT 方案」再開始：會拒絕並說出原因，platform 用量**沒有**增加 | 錄影、platform 用量前後截圖 |
| 9 | （做得到才做）用完方案額度 | 「ChatGPT 方案額度已用完，約 N 分鐘後重置」加上「管理用量」；在「自動」下會說出通知並改用 API key | 截圖 |
| 10 | 對話中在選單列把路徑改成「API key」 | 進行中的對話維持 ChatGPT 方案，選單列顯示「（進行中）；下次：OpenAI API key 計費 · gpt-realtime」，下一次開始改用 API key | 錄影 |
| 11 | ChatGPT 方案對話中重新整理視窗（⌘R） | 對話立刻結束，重新按「開始語音對話」可以馬上開始，沒有「已經有一個…在進行中」 | 錄影 |

**家中測試要回答的問題**（不阻擋這次的提交）：

- 伺服器接受 `originator: nous` 嗎？不接受時錯誤要照實顯示；不要改成假裝是 Codex CLI，除非 George 決定這麼做。
- `/models?client_version=…` 會回傳清單嗎？實機已確認帶 `0.1.0` 是空清單，預設改成 `0.162.1`（見第 4 節）；仍是空清單時在 `.env` 設 `NOUS_LIVE_AGENT_MODEL` 或 `NOUS_CODEX_CLIENT_VERSION`，並記下所用的值。
- 瀏覽器的資料通道有沒有送 frameless 逐字稿？沒有的話，頁面改用核心轉送的 `realtime.live transcript`，字幕照樣出現。記下是哪一種情況。
- 「回覆中」的音量門檻 `SPEAKING_RMS = 0.02` 實際好不好用。

**計費證據**

- 步驟 2–7 期間，platform.openai.com 上這把 key 的 Realtime、Responses 與 web search 用量**完全沒有增加**。比對事前與事後的截圖，時間要涵蓋測試期間。
- 同一段時間，ChatGPT 的用量頁面（<https://chatgpt.com/settings/usage>，Codex）有活動紀錄。

**把 README 改為「已完成」的門檻**

- 步驟 1–8 和 11 在 George 的 Mac 上用真實端點通過。
- 計費證據成立。
- 本文件 §4 已依那次測試填寫。
- 確認卡流程記為只有 fixture。
- 沒做到步驟 9 時記為「未達到」。

## 4. 真實結果（George 家中測試）

| 步驟 | 結果 | 證據 |
|---|---|---|
| Codex 登入、建立通話、sideband | 正常：`nous.log` 有「已開始（gpt-live-1-codex）」 | George 2026-10-23 的 `nous.log` |
| 語音層交辦 | 正常：問「你幫我看一下客廳的溫度」，收到交辦 | 同上 |
| 交辦執行（查客廳溫度） | **失敗**：Codex 模型清單是空的（`bad_request`）。原因是 `/models` 帶了 Nous 自己的版本 `client_version=0.1.0`；改成預設 `0.162.1`（和 OpenClaw 相同）後待重測 | 同上；修正與回歸測試 `tests/codex-client-version.test.ts` |
| 其他步驟 | 尚未執行 | — |
| 計費證據 | 尚未執行 | — |

同一份 `nous.log` 也記到 sideband 上目前沒有處理的事件：`session.input_audio.append`、`turn.created`、`turn.delta`、`delegation.context.appended`、`session.usage.updated`。它們不影響功能，先只記錄。

在這一節填寫之前，所有關於 ChatGPT 方案路徑的結論都只來自 fixture，不代表真實的語音、帳號或計費行為。
