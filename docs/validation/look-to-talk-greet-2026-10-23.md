# 看著說話打招呼驗證

2026-10-23；基底 `0cf32115ed073131ba50fff16bde113e55f6538d`。本紀錄隨「看著說話時先打招呼」交付。

## 決定

George：「透過鏡頭啟動即時語音後，請主動打招呼一次。把這個功能做起來，記得設定區要有開關。」

- 新的鏡頭設定 `look_to_talk_greet`「看著說話時先打招呼」：開關，預設開。它在設定畫面「鏡頭與手勢」中緊接在看著說話的兩個秒數之後，縮排顯示。也可以用語音改：說「關閉打招呼」「打招呼關掉」「打開打招呼」「打招呼打開」。改了立即生效。舊的 `camera.json` 沒有這個鍵時用預設值（開）。macOS 選單列不顯示鏡頭的開關，只顯示秒數與倍率，所以這次沒有加到選單列。
- 只有看著說話開始的對話會打招呼。`SenseController` 的 `startTalk` 呼叫 `startRealtime("look_to_talk")`；按鈕、語音指令、打字和同意說明後開始的對話都用 `"user"`，不打招呼。
- 一次開始只建立一個 `GreetingOnce`（`src/realtime-session.ts`）。如果 live 改用 API key，兩個工作階段共用這個物件，所以整次對話最多打一次招呼。設定在連上的那一刻會再讀一次。
- 工作階段真的連上之後才送出招呼：
  - **API key 路徑**：在 `session.created` 之後送 `{"type":"response.create","response":{"instructions":LOOK_TO_TALK_GREETING}}`。只帶這一輪的指示，不加假的使用者訊息。
  - **ChatGPT 方案路徑**：麥克風、peer 連線和 `session.started` 都到之後，頁面送 `POST /api/realtime/input`，`kind: "greeting"`。核心把指示原文放進一段 `session.context.append`，channel 是 `speakable`，不加「（系統通知）」，每個工作階段最多送一次。這和 OpenClaw `extensions/openai/realtime-quicksilver-bridge.ts` 的 `triggerGreeting` 做法相同（`sendContext(instructions, "speakable")`）。OpenClaw FaceTime 也只讓真的使用者逐字稿取消招呼，Nous 的 ChatGPT 方案路徑照這個規則做。
- 使用者先開口或打字就不打招呼：
  - API key 路徑看 `input_audio_buffer.speech_started` 或 `sendText`。
  - ChatGPT 方案路徑看使用者逐字稿（含未完成的）或 `sendText`。
- 誠實：`LOOK_TO_TALK_GREETING`（`shared/sense.ts`）只請模型說一句簡短的繁體中文招呼，問有什麼需要幫忙，例如「我在，有什麼需要幫忙的嗎？」。指示裡明確寫出：模型看不到畫面，不要說看到使用者，也不要提長相、表情、穿著或環境。看著說話只偵測到使用者面向螢幕，影像沒有送給模型。
- 指示長 332 bytes，小於 500，所以 ChatGPT 方案路徑只送一段 append。

## 自動檢查（fixture）

`tests/look-greeting.test.ts` 用假的 WebRTC 和假的核心。`tests/live-route.test.ts` 新增的那一項用假的 sideband。這些測試**全部是 fixture**：證明的是什麼時候送出哪個事件，不證明模型真的說了招呼、說了什麼或聲音如何。

| 情境 | 結果（fixture） |
| --- | --- |
| 預設開；順序緊接在看著說話秒數之後；只接受 boolean | 通過 |
| 舊 `camera.json` 沒有這個鍵 → 開；保存的 false 保留 | 通過 |
| 語音指令開／關；單說「打招呼」、否定、問句不是指令 | 通過 |
| API key：`session.created` 之前不送；之後送一次帶 instructions 的 `response.create`，沒有 `conversation.item.create` | 通過 |
| API key：手動開始時，`session.created` 後什麼都不送（和本批之前相同） | 通過 |
| API key：連上前把設定關掉 → 不送 | 通過 |
| API key：先開口（`speech_started`）或先打字 → 不打招呼 | 通過 |
| ChatGPT 方案：三項證據都到才送 `greeting`；重複的 started 不再送 | 通過 |
| ChatGPT 方案：手動開始或設定關 → 不送 | 通過 |
| ChatGPT 方案：聆聽前收到使用者逐字稿 → 不送 | 通過 |
| live 改用 API key：live 沒送；計費通知之後 API key 送一次；同一個物件再給新工作階段也不送 | 通過 |
| 核心：`greeting` 原文、speakable、每個工作階段最多一次 | 通過 |

| 指令（`prototype/ambient-shell`） | 結果 |
| --- | --- |
| `npx tsc --noEmit` | 通過 |
| `npx vitest run` | 46 檔 742 項通過（本批前 45 檔 727 項；新增 15 項） |
| `npx vite build` | 通過 |
| `node --check desktop/main.mjs` | 通過 |
| repo 根目錄 `node scripts/verify-aios.mjs` | PASS |

既有的 API key 即時語音測試（`tests/realtime-voice.test.ts`）沒有改。兩項既有測試改了：

- `tests/camera-prefs.test.ts` 的預設值清單多一個鍵。
- `tests/idle-settings.test.ts` 比對 `main.ts` 的原始碼字串，即時語音建構子那一段現在多帶 `greeting`。

## 尚未驗證（George 家中實測）

真實的語音、鏡頭與兩條路徑都還沒測。以下步驟每條路徑各做一次：設定的即時語音路徑選「API key」做一次，再選「ChatGPT 方案」做一次。

1. **打招呼開**：設定「看著說話時先打招呼」為開。站在螢幕前面向螢幕，等看著說話自動開始。預期：指示變成「聆聽中」之後，Nous 說一句招呼（例如「我在，有什麼需要幫忙的嗎？」），只說一次。招呼不能提到看到你、你的長相或環境。記下實際說的話，以及從「聆聽中」到開始說話的秒數。
2. **打招呼關**：說「關閉打招呼」，或在設定按成關。說「再見」結束對話，等冷卻過後再看著螢幕。預期：自動開始，但 Nous 不先說話。
3. **按鈕開始不打招呼**：設定開，按「開始語音對話」或 ⌥⌘V。預期：Nous 不先說話。
4. **馬上開口就不打招呼**：設定開，看著說話一開始（指示還在「連線中」）就說「新竹天氣如何」。預期：Nous 直接回答，不先打招呼。注意：如果你在連上之後才開口，招呼可能已經送出，這時你的話會照一般插話處理。
5. **改路徑只打一次**（可行時）：路徑設「自動」，讓 ChatGPT 方案不能用（例如未登入，或額度已用完）。看著說話開始後，預期先聽到計費通知，再聽到一次招呼，不會有第二次。
