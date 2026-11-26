<!-- bilingual: source=zh-TW -->

> [繁體中文](duck-voice-terminal-2026-11-26.md) | [English](duck-voice-terminal-2026-11-26.en.md)

# DUCK-2 鴨子當語音終端（鴨子的喚醒 → 頁面開始對話、頁面的語音狀態 → 鴨子）驗證

日期：2026-11-26，Asia/Taipei。分支：`claude/duck-voice-terminal`（基於 main `265cbee`）。接在 [DUCK-1](duck-link-2026-11-26.md) 之後。

使用者 2026-11-26 的決定：鴨子的語音對話走「鴨子的 Raspberry Pi 上跑 Chromium 開 Nous 頁面（`?terminal=duck`）」，和既有的 Pi 終端相同——收音、播放、和雲端模型的 WebRTC 都在那個頁面，核心不經手音訊。這個批次補上兩件核心原本做不到的事：

1. **鴨子本機偵測到喚醒詞時，讓那個頁面開始一通對話。**（原本沒有任何方法能叫頁面開始對話。）
2. **頁面把真實的語音狀態（聽、想、說）回報給核心**，核心轉成鴨子的互動狀態——DUCK-1 沒有的「說話中」現在有來源了。

**這不是實機驗收，也不是真實語音驗收。** 伺服器端是 fixture 測試（假的語音路徑、假鴨子、用 `fetch` 當頁面）。頁面端的改動只有型別檢查與建置，**沒有在任何瀏覽器裡跑過**；沒有麥克風、沒有語音模型、沒有真的鴨子。全部在旗標 `NOUS_DUCK`（預設關閉）後面；旗標關閉時行為和之前相同。

## 1. 做了什麼

| 部分 | 內容 | 檔案 |
|---|---|---|
| 喚醒 → 開始對話 | 核心收到 duck-link 的 `wake_word` 事件，對鴨子終端頁面的 SSE 串流送新的事件 `voice.request`（`action: "start"`、`source: "wake_word"`、一次性權杖 `duck_wake`）。頁面收到後走和自己的喚醒觸發相同的規則，以 `wake_word` 開始即時語音 | `server/nous.ts`、`server/app.ts`（`requestVoice`）、`shared/types.ts`、`src/main.ts`（`onDuckWake`） |
| 喚醒權杖 | `DuckWakeGate`：核心發的一次性權杖（15 秒內、只給那個頁面、用一次）。`POST /api/realtime/start` 帶著有效的權杖時，把這通當成 `wake_word`，**不需要 `NOUS_WAKE=on`** | `server/duck/wake-gate.ts`、`shared/duck-terminal.ts`、`server/app.ts`、`src/api.ts` |
| 語音狀態回報 | 新路由 `POST /api/realtime/phase`（只有 `NOUS_DUCK=on` 時存在）：鴨子終端的頁面每次狀態改變就回報 `connecting`／`listening`／`hearing`／`thinking`／`speaking`。核心核對擁有者後交給 DUCK-1 的 presence 橋接 | `server/app.ts`、`server/duck/session-bridge.ts`、`src/main.ts`、`src/api.ts` |
| 鴨子終端的頁面設定 | `settings.duck = { terminal: true }` 只出現在來源等於 `NOUS_DUCK_TERMINAL` 的頁面。這個頁面：回報語音狀態；**不啟動自己的喚醒聆聽**（喚醒由鴨子偵測，避免兩個偵測器搶同一支麥克風） | `server/app.ts`、`shared/types.ts`、`src/main.ts` |
| 沒人說話就結束 | 鴨子喚醒開始的通話也有「沒人出聲就結束」的計時（預設 5 秒）；這個頁面沒有喚醒控制器、也不載入 `src/audio`，所以用只看通話階段的計時（上游判斷使用者開口就不再倒數），不碰任何音訊 | `src/main.ts`、`src/duck-wake-watch.ts` |
| 設定 | `NOUS_DUCK_TERMINAL`：鴨子終端頁面的終端 ID，預設 `duck` | `server/config.ts`、`.env.example` |

沒有動的：語音工作階段本身（`RealtimeSessions` 的規則、兩條路徑、費用紀錄、記憶）、喚醒引擎與關鍵詞、音訊裝置選擇。核心仍然不經手任何音訊。

## 2. 既有的限制怎麼套用在鴨子的喚醒

| 既有規則 | 對鴨子的喚醒 |
|---|---|
| `source: "wake_word"` 只有 `NOUS_WAKE=on` 才接受 | 多一個條件：帶著核心剛發的有效權杖也接受。理由：`NOUS_WAKE` 管的是「這個頁面自己開喚醒聆聽」；鴨子的喚醒是鴨子偵測的，證據是 duck-link 上的事件，不是頁面說了算。沒有權杖、權杖用過、過期或不是發給這個頁面：和以前一樣當成 `user` |
| 喚醒開始的通話每 60 秒最多 3 次 | **照樣適用**，而且和頁面自己偵測的喚醒算在一起（`RealtimeSessions.start` 的同一個計數）。超過時核心回拒絕，頁面顯示原因，不開始 |
| 同一時間只有一通 live、一通 api_key | 照舊。通話中再收到 `voice.request` 會被頁面忽略 |
| 喚醒開始的通話一律打招呼 | 照舊（它就是一通 `wake_word` 通話）。家人辨識的聲音證據（`wake_id`）這裡沒有：喚醒的那段聲音在鴨子上，沒有交給頁面 |
| 即時語音的同意說明 | 照舊，存在那個瀏覽器的 localStorage。**鴨子沒有螢幕可以按同意**：還沒同意過時，鴨子的喚醒只會讓頁面顯示同意說明、不開始對話。要先用別的方式在那個瀏覽器設定檔上同意一次（Nous Duck repo 的終端啟動文件說明） |
| 鈴響時不因喚醒開始通話 | 照舊 |

喚醒詞：使用者 2026-11-26 決定鴨子用「Hello 鴨子」與「Hey 鴨子」，由鴨子本機偵測（鴨子端的設定）。AIOS 自己的關鍵詞（「Hello Nous」「Hey Nous」）沒有改；核心只看到「鴨子說它被叫醒了」，不知道也不需要知道是哪個詞。鴨子終端的頁面不啟動頁面內建的喚醒聆聽（就算 `NOUS_WAKE=on`），所以那個頁面只會因為鴨子的 `wake_word` 事件開始對話，不會因為有人說「Hey Nous」而開始。

## 3. 旗標、啟用與回退

```bash
# .env
NOUS_DUCK=on
# NOUS_DUCK_TERMINAL=duck       # 鴨子終端頁面的終端 ID（預設 duck）
NOUS_AIL=on                     # 要讓模型叫鴨子做動作才需要（DUCK-1）
NOUS_AIL_SERVICES=duck
```

鴨子端：Pi 上的瀏覽器開 `http://localhost:<核心的埠>/?terminal=duck`（經 SSH 通道，埠要和核心相同）；duckd 連 `/duck-link`。啟動時核心的 log 會印出這個頁面網址。

回退：拿掉 `NOUS_DUCK`。沒有寫入任何設定檔或資料檔。`NOUS_DUCK` 關閉時：`voice.request` 不會被送出、`/api/realtime/start` 不認 `duck_wake`、沒有 `/api/realtime/phase`（404）、`settings` 沒有 `duck`——`tests/duck-terminal.test.ts` 有一項確認。

## 4. 驗證

```bash
cd prototype/ambient-shell
TZ=UTC npx vitest run tests/duck-terminal.test.ts
npm run typecheck
```

`tests/duck-terminal.test.ts`（17 項，全部 fixture）：

| 類別 | 內容 |
|---|---|
| `DuckWakeGate` | 權杖格式；只能用一次、只能由那個頁面用、過期作廢；同一頁面的新喚醒讓舊權杖作廢；格式不對一律拒絕 |
| `DuckWakeWatch` | 在聽的時候倒數、在想或說話時暫停、回到在聽重新倒數、只觸發一次；使用者開口、打字或通話結束就不再倒數 |
| `NOUS_DUCK_TERMINAL` | 預設 `duck`；不合法的終端 ID（含 `main`）啟動時報錯 |
| 頁面狀態 → presence（假時鐘） | 有頁面回報時鴨子得到真的 `speaking`，順序和發生的順序一致；有頁面回報之後，核心端的委派只切換 `working`、不再硬切回 `listening`；核心不認得的工作階段（已結束或沒開始）的回報被忽略 |
| HTTP（假的語音路徑） | `voice.request` 只送到鴨子終端的 SSE 串流、帶核心發的權杖；有效權杖讓通話成為 `wake_word`（不需要 `NOUS_WAKE`）、只能用一次；沒有權杖、亂編的權杖、發給別的頁面的權杖都當成一般的 `user` 開始；既有的每分鐘 3 次限速對鴨子的喚醒照樣生效；`/api/realtime/phase` 只接受擁有者、只轉鴨子終端的回報、只接受認得的狀態名稱；旗標關閉時這些都不存在 |
| 核心接線（`startNous`、假鴨子） | 假鴨子送 `wake_word` 事件 → `?terminal=duck` 的 SSE 串流收到 `voice.request`；其他鴨子事件不會；終端頁面沒連著時 log 照實寫「沒有開始對話」；`NOUS_DUCK_TERMINAL` 決定哪個頁面是鴨子的 |

另外：`TZ=UTC node scripts/verify-aios.mjs`、`node scripts/check-bilingual-docs.mjs` 的結果見 PR 說明。

## 5. 沒有驗證的事

- **頁面端的程式沒有在瀏覽器裡執行過**（`onDuckWake`、狀態回報、鴨子終端不啟動喚醒聆聽、沒人說話的計時）。只有型別檢查與建置。
- 真的鴨子、真的麥克風與喇叭、真的語音模型；鴨子端把本機喚醒變成 duck-link `wake_word` 事件的那一段（在 Nous Duck repo）。
- Pi 4 上無螢幕的 Chromium 取得 XVF3800、回音消除、和鴨子其他程式同時運作的負載。
- 從鴨子聽到喚醒詞到頁面開始收音之間的延遲（事件 → SSE → 開始 → WebRTC 連線），以及這段時間使用者已經說出口的話會不會漏掉。
- 兩條語音路徑各自的行為（測試用的是假的 api_key 路徑）；macOS App 內。

## 6. 使用者要怎麼試

需要鴨子端先就緒（Nous Duck repo 的語音實測文件）。Nous 這一側：

1. 用含這個分支的程式啟動一個開了上面旗標的 Nous（另起開發實例或更新平常用的那一個，由你決定與執行；金鑰與 `.env` 你自己處理）。log 會有「鴨子：duck-link 已開在…；語音終端頁面：http://localhost:<埠>/?terminal=duck」。
2. 讓鴨子 Pi 上的瀏覽器開那個網址（經通道）。那個瀏覽器設定檔要先同意過即時語音、允許麥克風。
3. 鴨子的 duckd 連上（log：「鴨子：鴨子已連線」），鴨子的喚醒服務啟動。
4. 對鴨子說喚醒詞。預期 log：「鴨子：聽到喚醒詞，已請終端頁面（duck）開始對話（1 個頁面）」，接著是一通 `wake_word` 的即時語音；鴨子的互動狀態依序是被叫醒、在聽、在想、**說話中**、在聽、待命。
5. 5 秒沒有人說話，這通會自己結束。

這些步驟**沒有人執行過**。
