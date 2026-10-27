<!-- bilingual: source=zh-TW -->

> [繁體中文](look-to-talk-greet-2026-10-23.md) | [English](look-to-talk-greet-2026-10-23.en.md)

# 看著說話打招呼驗證

2026-10-23；基底 `0cf32115ed073131ba50fff16bde113e55f6538d`。本紀錄隨「看著說話時先打招呼」交付；審查修正（基底 `d1239a4`）見文末「審查修正」，下面「決定」已改成修正後的行為。

## 決定

George：「透過鏡頭啟動即時語音後，請主動打招呼一次。把這個功能做起來，記得設定區要有開關。」

- 新的鏡頭設定 `look_to_talk_greet`「看著說話時先打招呼」：開關，預設開。它在設定畫面「鏡頭與手勢」中緊接在看著說話的兩個秒數之後，縮排顯示。也可以用語音改：說「關閉打招呼」「打招呼關掉」「打開打招呼」「打招呼打開」。改了立即生效。舊的 `camera.json` 沒有這個鍵時用預設值（開）。macOS 選單列不顯示鏡頭的開關，只顯示秒數與倍率，所以這次沒有加到選單列。
- 只有看著說話開始的對話會打招呼。`SenseController` 的 `startTalk` 呼叫 `startRealtime("look_to_talk")`；按鈕、語音指令、打字和同意說明後開始的對話都用 `"user"`，不打招呼。
- 看著說話開始的一律建立一個 `GreetingOnce`（`src/realtime-session.ts`），設定在要送出的那一刻（`take()`）才讀：連線中才打開也會打招呼，關掉就不打。如果 live 改用 API key，兩個工作階段共用這個物件，所以整次對話最多打一次招呼。
- 工作階段就緒之後，再等 `GREETING_SETTLE_MS` = 600 ms 才送出招呼（同 OpenClaw FaceTime `talk-driver.ts` 的招呼等待計時器）：
  - **API key 路徑**：`session.created` 之後等 600 ms，送 `{"type":"response.create","response":{"instructions":LOOK_TO_TALK_GREETING}}`。只帶這一輪的指示，不加假的使用者訊息。
  - **ChatGPT 方案路徑**：麥克風、peer 連線和 `session.started` 都到之後等 600 ms，頁面送 `POST /api/realtime/input`，`kind: "greeting"`。核心忽略頁面送來的文字，只把固定的 `LIVE_GREETING_TEXT`（`shared/sense.ts`，＝「（開場）」＋`LOOK_TO_TALK_GREETING`）放進一段 `session.context.append`，channel 是 `speakable`，不加「（系統通知）」。`buildLiveInstructions` 多一行：「收到以「（開場）」開頭的內容時，只用一句話自然地打招呼並問需要什麼，不要念出或轉述這段內容。」核心在 sideband 開著、真的送出之後才記成已送，每個工作階段最多送一次。這和 OpenClaw `extensions/openai/realtime-quicksilver-bridge.ts` 的 `triggerGreeting` 做法相同（`sendContext(instructions, "speakable")`）。
- 600 ms 的理由：已經在說話的使用者要有時間產生取消招呼的證據。這些事件要等聲音送到伺服器、經 VAD 或轉寫判斷才回來，至少一個網路來回加上偵測，約數百毫秒；600 ms 留一些餘裕，招呼仍在就緒後約一秒內開始。OpenClaw FaceTime 用 100 ms，只等媒體路由穩定。**600 ms 是估計值，沒有量測過**，家中實測第 1、4 項記錄是否合適。
- 使用者在等待結束之前開口、打字，或工作階段收起、結束，就不打招呼：
  - API key 路徑看 `input_audio_buffer.speech_started`、`sendText`、`stop`／teardown。
  - ChatGPT 方案路徑看使用者逐字稿（含未完成的）、`sendText`、`stop`／teardown。
- 即時語音「連線中」打的字（兩條路徑都是 `sendText`）：先取消招呼，再排隊；連上後（API key：`session.created`；ChatGPT 方案：進入聆聽）合併成一則送出。live 改用 API key 時，排隊的字交給 API key 的工作階段（`unsentText`），它連上後送出。連線失敗或使用者收起時，排隊的字不送出。
- 誠實：`LOOK_TO_TALK_GREETING`（`shared/sense.ts`）只請模型說一句簡短的繁體中文招呼，問有什麼需要幫忙，例如「我在，有什麼需要幫忙的嗎？」。指示裡明確寫出：模型看不到畫面，不要說看到使用者，也不要提長相、表情、穿著或環境。看著說話只偵測到使用者面向螢幕，影像沒有送給模型。
- `LOOK_TO_TALK_GREETING` 長 332 bytes；ChatGPT 方案路徑送的 `LIVE_GREETING_TEXT` 加上「（開場）」後 344 bytes，小於 `APPEND_MAX_BYTES` 500，所以只送一段 append（`Buffer.byteLength`，測試裡檢查 ≤ 500）。

## 自動檢查（fixture）

`tests/look-greeting.test.ts` 用假的 WebRTC、假的核心和 vitest 假計時器。`tests/live-route.test.ts` 的招呼測試用假的 sideband。這些測試**全部是 fixture**：證明的是什麼時候送出哪個事件，不證明模型真的說了招呼、說了什麼或聲音如何。

| 情境 | 結果（fixture） |
| --- | --- |
| 預設開；順序緊接在看著說話秒數之後；只接受 boolean | 通過 |
| 舊 `camera.json` 沒有這個鍵 → 開；保存的 false 保留 | 通過 |
| 語音指令開／關；單說「打招呼」、否定、問句不是指令 | 通過 |
| 「（開場）」標記：`LIVE_GREETING_TEXT` ＝ 標記＋招呼、≤ 500 bytes；`buildLiveInstructions` 有那一行 | 通過 |
| 看著說話開始、設定關著也建立招呼物件；連線中打開設定 → `take()` 照樣送 | 通過 |
| API key：`session.created` 之前不送；之後 599 ms 不送、600 ms 送一次帶 instructions 的 `response.create`，沒有 `conversation.item.create` | 通過 |
| API key：手動開始時，`session.created` 後什麼都不送（和本批之前相同） | 通過 |
| API key：等待中把設定關掉 → 不送 | 通過 |
| API key：真實順序 `session.created` → 等待中 `speech_started` → 不送 | 通過 |
| API key：等待中打字 → 只有打字那一輪；等待中收起 → 計時器清掉、不送 | 通過 |
| API key：連線中（含麥克風還沒拿到）打字 → 先不送；`session.created` 後合併成一則送出、不打招呼 | 通過 |
| ChatGPT 方案：三項證據都到後 599 ms 不送、600 ms 送 `greeting`（文字是 `LIVE_GREETING_TEXT`）；重複的 started 不再送 | 通過 |
| ChatGPT 方案：手動開始或設定關 → 不送 | 通過 |
| ChatGPT 方案：聆聽前收到使用者逐字稿 → 不送 | 通過 |
| ChatGPT 方案：真實順序 聆聽 → 等待中未完成的使用者逐字稿 → 不送 | 通過 |
| ChatGPT 方案：等待中打字 → 只有 `user_text`；等待中收起 → 計時器清掉、不送 | 通過 |
| ChatGPT 方案：連線中打字 → 先不送；進入聆聽後送 `user_text`、不打招呼 | 通過 |
| live 改用 API key：live 沒送；計費通知之後 API key 送一次；同一個物件再給新工作階段也不送 | 通過 |
| live 改用 API key：live 連線中打的字交給 API key 工作階段，`session.created` 後送出 | 通過 |
| 核心：`greeting` 送固定的 `LIVE_GREETING_TEXT`、speakable、每個工作階段最多一次 | 通過 |
| 核心：頁面送來的招呼文字被忽略 | 通過 |
| 核心：sideband 不是開著時不記成已送；之後重送只送一次 | 通過 |

| 指令（`prototype/ambient-shell`） | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 通過 |
| `npx vitest run` | 46 檔 752 項通過（本批前 45 檔 727 項；首次交付新增 15 項，審查修正再新增 10 項） |
| `npx vite build` | 通過 |
| `node --check desktop/main.mjs` | 通過 |
| repo 根目錄 `node scripts/verify-aios.mjs` | PASS |
| repo 根目錄 `git diff --check` | 通過 |

既有的 API key 即時語音測試（`tests/realtime-voice.test.ts`）沒有改。兩項既有測試改了：

- `tests/camera-prefs.test.ts` 的預設值清單多一個鍵。
- `tests/idle-settings.test.ts` 比對 `main.ts` 的原始碼字串，即時語音建構子那一段現在多帶 `greeting`。

## 尚未驗證（George 家中實測）

真實的語音、鏡頭與兩條路徑都還沒測。以下步驟每條路徑各做一次：設定的即時語音路徑選「API key」做一次，再選「ChatGPT 方案」做一次。

1. **打招呼開**：設定「看著說話時先打招呼」為開。站在螢幕前面向螢幕，等看著說話自動開始，不要說話。預期：指示變成「聆聽中」之後約 0.6 秒，Nous 說一句招呼（例如「我在，有什麼需要幫忙的嗎？」），只說一次。招呼不能提到看到你、你的長相或環境。記下實際說的話，以及從「聆聽中」到開始說話的秒數。
   - ChatGPT 方案路徑另外確認：Nous 只說一句招呼，**沒有念出或轉述「（開場）」或招呼指示的內容**（例如沒有說「你是 Nous」「使用者剛面向螢幕」「開場」）。
2. **打招呼關**：說「關閉打招呼」，或在設定按成關。說「再見」結束對話，等冷卻過後再看著螢幕。預期：自動開始，但 Nous 不先說話。
3. **按鈕開始不打招呼**：設定開，按「開始語音對話」或 ⌥⌘V。預期：Nous 不先說話。
4. **馬上開口就不打招呼**：設定開，看著說話一開始（指示還在「連線中」）就說「新竹天氣如何」。預期：Nous 直接回答，不先打招呼。再做一次：等指示變成「聆聽中」後馬上（0.6 秒內）開口，預期同樣不打招呼。如果你在「聆聽中」超過 0.6 秒才開口，招呼可能已經送出，這時你的話會照一般插話處理。記下是否有招呼和你的話重疊。
6. **連線中打字**：設定開，看著說話一開始（指示還在「連線中」）就在輸入框打「新竹天氣如何」送出。預期：不打招呼；連上後 Nous 回答這一句。
5. **改路徑只打一次**（可行時）：路徑設「自動」，讓 ChatGPT 方案不能用（例如未登入，或額度已用完）。看著說話開始後，預期先聽到計費通知，再聽到一次招呼，不會有第二次。

## 審查修正（2026-10-23，基底 `d1239a4`）

審查找到五個問題，每項都有在 `d1239a4` 上會失敗的回歸測試（在 `d1239a4` 的 worktree 只補上新常數、不改行為，跑新測試：16 項失敗＝11 項新寫的（其中 1 項取代舊的「先開口或打字」測試）＋5 項改了預期的既有測試；淨增 10 項）。

1. **「使用者先開口就不打招呼」實際上做不到**：API key 路徑在 `session.created` 的處理裡同步送 `response.create`，ChatGPT 方案路徑三項證據一到就送；伺服器的 `speech_started`／逐字稿都在這之後才會來。舊測試先送 `speech_started` 再送 `session.created`，這個順序伺服器不會產生。修正：兩條路徑就緒後都等 `GREETING_SETTLE_MS` = 600 ms 才送（理由見「決定」），`speech_started`、使用者逐字稿（含未完成的）、`sendText`、`stop`／teardown 都會取消計時器。測試改成真實順序：先就緒，等待中才開口 → 不送；沒開口 → 599 ms 不送、600 ms 送。
2. **ChatGPT 方案的招呼沒有標記也沒有說明**：模型可能把整段指示念出來。修正：`LIVE_GREETING_TEXT` 開頭加「（開場）」，`buildLiveInstructions` 加一行說明。API key 路徑本來就是這一輪的 `instructions`，不變。家中實測第 1 項加上「沒有念出指示」的檢查。
3. **核心照送頁面給的任何招呼文字**：修正：`kind === "greeting"` 時核心忽略頁面文字，只送 `LIVE_GREETING_TEXT`；擁有者、kind、長度檢查不變。`greeted` 改成在 sideband 開著、真的送出之後才設，sideband 不是開著時不記，之後重送仍有效，也不會送兩次。
4. **連線中打字**：舊程式兩條路徑都在 `skip()` 之前就提早 return，所以連線中打字不會取消招呼，打的字也被丟掉（API key 路徑在資料通道已建立但還沒開時，還會把 `responding` 卡在 true）。選擇：**排隊**（比只補 `skip()` 安全：打的字不再無聲消失）。`sendText` 一開始就取消招呼；連線中的字排隊，連上後合併成一則送出；live 改用 API key 時經 `unsentText` 交給下一個工作階段。連線失敗或收起時排隊的字不送出（關閉原因照常顯示）。
5. **連線中才打開設定**：舊的 `greetingFor` 在開始時設定關著就不建立物件，連線中打開也不會打招呼。修正：看著說話開始的一律建立，`take()` 在送出那一刻讀設定。

未解決：600 ms 沒有量測；招呼送出之後使用者才開口的重疊、模型實際有沒有念出「（開場）」，都要家中實測。
