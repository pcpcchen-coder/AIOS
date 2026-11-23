<!-- bilingual: source=zh-TW -->

> [繁體中文](realtime-cost-guard-2026-11-06.md) | [English](realtime-cost-guard-2026-11-06.en.md)

# 即時語音費用防護驗證

日期：2026-11-06。分支 `claude/realtime-cost-guard`（基於 main `bc3d99e`）。狀態：**程式與 Linux 雲端 fixture 測試完成；Mac App 與 Raspberry Pi kiosk 實機未驗證。**

## 問題

George 2026-11-06：即時語音會一直計費、停不下來。Mac App 與 Pi kiosk（Pi 上的 Chromium 開 `http://localhost:8787`，經 SSH 通道連到 Mac App 的核心，沒有 `window.nousDesktop`）都要處理。原因有四個：

1. 閒置計時器在上游的開口事件（`input_audio_buffer.speech_started`、ChatGPT 方案的 `speech.started`、未完成逐字稿）與每個回覆結束都重新倒數。電視或旁人一直說話時，通話永遠不會閒置。
2. 每通沒有上限，頁面與核心都沒有。
3. 螢幕鎖定、睡眠、頁面在背景、Pi 頁面不見了，通話都繼續。核心只在 SSE 串流關閉時結束；Pi 的 SSH 通道可能讓連線留著。沒有旁路的 API key 通話，核心連掛斷都不會（`close` 是空的）。
4. 看不到通話多久、用了多少。

## 做法

### 1. 閒置只算真的使用者一輪

新模組 `src/call-guard.ts` 的 `CallGuard`，兩條路徑（`src/realtime.ts` 的 `RealtimeVoice`、`src/live-voice.ts` 的 `LiveVoice`）共用。

| 事件 | 之前 | 現在 |
|---|---|---|
| 開口事件（`speech_started`、`speech.started`） | 重新倒數 | **不算** |
| 未完成的使用者逐字稿（ChatGPT 方案） | 重新倒數 | **不算** |
| 完整的使用者逐字稿 | API key：不算；ChatGPT 方案：算 | 兩條都算；空白或 prompt 回吐（`isPromptEcho`）不算 |
| 打字、核心送來的工具結果、交辦結束、確認卡回答 | 大多算 | 算 |
| API key 路徑的工具結果 | 不算 | 只有回答真的使用者一輪的回應（或還在進行、正在回答使用者的回應）呼叫的工具才算；雜音觸發的回應呼叫的工具不延長 |
| 回覆結束（`response.done`、遠端聲音停止） | 每次都算 | 只有上一次真的使用者一輪之後的**第一次**算（credit，用一次就沒了）。ChatGPT 方案沒有 `response.done`：回答真的一輪的回覆，每段說完（停頓）都重新倒數但不用掉 credit，助理的整句逐字稿到了、聲音停下時才算回覆結束；之後的開口事件讓 credit 作廢 |
| 回覆中、查資料、等確認、工具執行中 | 到時間時重新倒數 | 不變 |

雜音觸發的回覆因此不會無限延長通話。閒置秒數仍是設定裡的「即時語音閒置多久自動結束」（預設 120 秒）；提示文字改成「從你最後一次說完一句（聽得出字的話）、打字或 Nous 回覆你之後算起」。

### 2. 每通上限（頁面與核心都執行）

- 新設定 `realtime_max_call_s`（`voice.json`）：預設 1200 秒（20 分鐘），範圍 300–3600 秒、間隔 60 秒，選單列選項 10／20／30／60 分鐘，**沒有「不限」**。選單列「鏡頭與語音設定」與頁面設定的「語音」段都會出現「每通即時語音最長多久」。
- 頁面：從連上起算，到上限前 60 秒字幕「通話快滿 {n} 分鐘，一分鐘後會自動結束」並響一次處理中提示音；到上限結束，字幕「已達通話上限，即時語音已結束。」，費用紀錄 `end_reason: "max_duration"`。使用者一直說話也不延長。通話中改設定，從連上的時間重新算。
- 核心：`RealtimeSessions` 在連上時開始計時，到 **上限＋30 秒** 還沒結束就由核心結束：送 SSE `realtime.live` `closed{reason:"max_duration"}` 給頁面、寫費用紀錄、`call.close("enforced")`。時間到時重讀設定：通話中改長了照新的值；改短了由頁面照新值結束，核心仍照連上時的值當最後防線。
- 掛斷：`close("enforced")` 在 API key 路徑一律向 OpenAI `POST /realtime/calls/{id}/hangup`。沒有旁路的 API key 通話（`plainApiKeyCall`）現在保留 call ID（只在核心，不交給頁面），在 `page_gone` 與 `enforced` 時掛斷一次。ChatGPT 方案路徑照舊送 `session.close`。
- SSE 斷線：沒有旁路的 API key 通話（媒體直接在頁面和 OpenAI 之間）**已經報到過**時，事件串流斷了不馬上掛斷（Wi-Fi 瞬斷、Pi 的 autossh 重連）：核心只忘記那條串流，頁面還在就繼續報到，真的不在了由 45 秒的報到逾時（`client_lost`）結束並掛斷。從沒報到過的、帶記憶的 API key 通話與 ChatGPT 方案通話照舊立刻結束（`page_gone`）。

### 3. 鎖定、睡眠、背景頁面、失聯的頁面

新模組 `src/call-lifecycle.ts`（主程式只把事件交進來）。

| 情況 | Mac App（有 `window.nousDesktop`） | 瀏覽器與 Pi（沒有） |
|---|---|---|
| 螢幕鎖定 | 頁面結束（`os_lock`）；核心 `endAll("os_lock", "app")` 只結束 App 主視窗開始的通話（開始時頁面報 `app: true`） | 不適用（Mac 上一般瀏覽器開的通話也不受影響） |
| 睡眠 | 頁面結束（`suspend`）；核心 `endAll("suspend")` 結束全部通話（核心也要睡了） | 不適用 |
| 視窗隱藏、收起 | **不結束**（George 預設：App 常駐選單列） | 背景超過 30 秒結束（`hidden`）；30 秒內回來不結束。計時跟著每一通：通話結束就取消，在背景中開始的通話從開始時算起 |
| 關頁、重新整理、離開（`pagehide`） | 不結束（App 視窗不會這樣離開） | 立刻結束，`/api/realtime/end` 用 `keepalive` 送出 |
| 報到 | 每 15 秒 `POST /api/realtime/alive`，每次最多等 10 秒（卡住的請求不擋之後的報到） | 同左 |
| 核心說這通不存在（`alive` 回 404） | 先等 1.5 秒讓核心的 `closed` 事件（例如記憶撤銷後的重建、核心自己的結束原因）先到；還是同一通、還開著才結束本機這一端，字幕「本機核心已結束這通即時語音。」 | 同左 |

核心的報到檢查：**第一次報到之後**，45 秒沒有再報到就結束這通（`client_lost`），送 `closed{client_lost}`、寫費用紀錄、掛斷。從不報到的舊頁面不會被這個檢查結束。報到失敗（網路錯誤）時頁面不自己結束，閒置與上限仍在。

鎖定只結束 App 主視窗的通話，是刻意偏離架構師計畫（計畫寫 `endAll`）：Mac 鎖定是 Mac 前的人離開，不應掛斷廚房 Pi 上別人正在講的通話，也不結束 Mac 上一般瀏覽器開的通話。App 主視窗在開始時於 `/api/realtime/start` 帶 `app: true`（頁面報的，只決定鎖定時要不要結束，不是授權）。睡眠時核心本身停住，沒人管的通話不能留著，所以結束全部。

結束原因要不要念出：App 主視窗在鎖定或睡眠結束時不念（Mac 前沒有人）；Pi 與瀏覽器照念（例如 Mac 睡眠結束了 Pi 的通話，Pi 旁邊的人聽得到原因）。

### 4. 顯示通話時間與約略 tokens

- 頁面（Mac 與 Pi 都看得到）：右上角即時語音指示加上「3:07 / 20:00 · 約 3,400 tokens」，每秒更新；ChatGPT 方案寫「ChatGPT 方案：用量不明」；API key 路徑還沒有任何 `response.done` 時只顯示時間。滑鼠停在指示上說明「tokens 是頁面加總 response.done 回報的數字（約略），不是帳單」。設定畫面「即時語音」的「進行中」一行也附上同樣的文字（核心最近一次設定的快照）。
- Mac 選單列：「即時語音：… （進行中） · 3:07 / 20:00 · 約 3,400 tokens · 語音聆聽中」；Pi 開始的通話前面加「終端機 rpi4 · 」。資料來自核心 `settings.realtime.active` 新增的 `started_at`、`max_call_s`、`usage`、`page`；選單在既有的 15 秒設定重讀時更新（計畫寫通話中另加 30 秒重讀，既有的 15 秒已經比較密，所以沒有加）。
- tokens：API key 路徑頁面每次報到附上這通加總的 usage（`parseVoiceUsage` 只取認得的數字欄位並截上限），核心記在工作階段上；頁面不在時費用紀錄也用最近一次報到的加總。

### 費用紀錄

`PAGE_END_REASONS` 增加 `idle`、`max_duration`、`hidden`、`os_lock`、`suspend`（`client_lost` 只有核心會記，不收頁面送來的）。`end_reason` 以頁面說明的原因優先，否則用核心自己的原因。頁面的原因比核心的結束晚到時，只取代核心的一般原因（`ended`、`page_gone`）；核心自己的原因（`max_duration`、`client_lost`、`os_lock`、`suspend`、`connection_lost` 等）照實保留。

## Pi 的行為

- Pi 的 Chromium kiosk 沒有 `window.nousDesktop`，所以走瀏覽器規則：背景超過 30 秒或頁面關閉就結束；每 15 秒經 SSH 通道向 Mac 核心報到。
- **Pi 螢幕關掉（或螢幕保護）不會讓頁面變成背景**，不會因此結束；那時靠閒置、每通上限與核心的報到檢查。[Pi 套件指南](../../terminals/rpi4/README.md)本來就建議關掉螢幕自動變黑。
- SSH 通道斷了：頁面報到送不出去；核心 45 秒後結束並掛斷（API key）或送 `session.close`（ChatGPT 方案）。SSE 串流關閉時：已報到過的沒有旁路的 API key 通話交給 45 秒的報到逾時，其他照舊立刻結束（`page_gone`）。
- Mac 鎖定不會結束 Pi 的通話；Mac 睡眠會。
- Pi 的通話在 Mac 選單列顯示「終端機 rpi4 · 時間 / 上限 · 用量」。

## 預設值

| 項目 | 值 | 在哪裡 |
|---|---|---|
| 閒置 | 120 秒（設定 30–600 秒） | `shared/voice-prefs.ts` `realtime_idle_s` |
| 每通上限 | 20 分鐘（設定 5–60 分鐘，沒有不限） | `shared/voice-prefs.ts` `realtime_max_call_s` |
| 上限前提醒 | 60 秒 | `src/call-guard.ts` `CALL_WARN_BEFORE_MS` |
| 核心寬限 | 上限＋30 秒 | `server/realtime-routes.ts` `CORE_CAP_GRACE_MS` |
| 背景結束（瀏覽器與 Pi） | 30 秒 | `src/call-lifecycle.ts` `HIDDEN_END_MS` |
| 報到間隔 | 15 秒 | `src/call-lifecycle.ts` `ALIVE_INTERVAL_MS` |
| 失聯判定 | 第一次報到後 45 秒 | `server/realtime-routes.ts` `ALIVE_TIMEOUT_MS` |

## 自動測試（Linux 雲端，全部 fixture）

| 檔案 | 內容 |
|---|---|
| `tests/realtime-cost-guard.test.ts`（新，30 項） | 另有：ChatGPT 方案長回覆中間的停頓不讓閒置到期、整句逐字稿到了才算回覆結束；API key 路徑雜音回應的工具結果不延長、真的一輪的工具結果會；App 主視窗鎖定或睡眠結束時不念原因、Pi 與瀏覽器照念；背景計時跟著每一通（連續兩通、在背景中開始）；404 之後等 1.5 秒、等待中通話已結束或換成重建的新通話就不結束；卡住的報到 10 秒後中止、不擋下一次。原有：`CallGuard`：雜音回覆不延長、credit 只用一次、忙碌時重新倒數、上限不看忙碌、20 分鐘預設與提前 60 秒提醒、通話中改上限、`stop()`。`RealtimeVoice`：只有 `speech_started` 時照閒置結束（`idle`）；空白與 prompt 回吐逐字稿及它觸發的回覆不延長，真的一句會；打字算；上限提醒與結束（`max_duration`）。`LiveVoice`：`speech.started` 與未完成逐字稿不延長、`end("idle")`；雜音回覆不延長、真的一句加回覆會；上限；核心的 `closed{max_duration／client_lost／os_lock}` 結束頁面且不再呼叫 `/end`。`CallLifecycle`：背景 30 秒、`pagehide` 用 keepalive、App 隱藏不結束、鎖定與睡眠結束、沒有通話時不動作、報到只在連上後、404 結束本機、網路錯誤不結束。顯示文字、上限換算、`parsePageEndReason`、英文翻譯沒有中文字 |
| `tests/realtime-cost-guard-core.test.ts`（新，14 項） | 另有：已報到的沒有旁路的 API key 通話 SSE 重連後不掛斷、由 45 秒報到逾時結束；從沒報到的與 ChatGPT 方案照舊立刻 `page_gone`；鎖定只結束 App 主視窗（不結束 Pi 與一般瀏覽器）。原有：兩條路徑的核心上限（上限＋30 秒、SSE `closed`、`enforced`、費用紀錄 `max_duration`）；通話中改長上限；頁面先結束時用頁面原因與 usage；從不報到不會被結束；報到後 45 秒 `client_lost` 並保留最近 usage；ChatGPT 方案忽略 usage、擁有者檢查、結束後 404；鎖定只結束主視窗、睡眠結束全部；晚到的頁面原因只取代一般原因；`plainApiKeyCall` 只在 `page_gone`／`enforced` 掛斷一次、`connectApiKey` 不帶記憶時保留 call ID 而且不外露；選單列文字（兩條路徑、Pi、英文）；`POST /api/realtime/alive` 的擁有者、usage 過濾與 `voice.json` 的上限 |
| 既有測試的更新 | 新設定讓設定列多一列：`prefs`、`voice-settings`、`http`、`desktop-menu`、`idle-settings`、`live-voice` 的期望值；`wake-flag-off` 的快照（`voice` 多一個鍵、選單多一列，刻意的改變）；`wake-call` 的原始碼比對（`/end` 多帶 keepalive 與 LiveVoice 的原因）；`prefs` 另加上限範圍的測試 |

全部結果：`npm run typecheck` 通過；`npx vitest run` 148 個檔案、2746 項通過、5 項略過（有一項依環境決定是否略過，曾出現 6 項略過；改動前的 main 是 146 個檔案、2699 項通過、6 項略過）；`npm run build` 通過。

## Mac 手動驗證步驟（未執行）

1. 選單列「鏡頭與語音設定」→「語音」：看到「每通即時語音最長多久：20 分鐘」；改成 10 分鐘，頁面設定的同一列跟著變。
2. API key 路徑開始即時語音：右上角指示出現「0:0x / 10:00」，第一次回覆後出現「約 N tokens」；選單列「即時語音」一行 15 秒內出現同樣的時間與用量。
3. 開著電視或播放對話錄音，不對 Nous 說話：預設 120 秒（可先把閒置改成 1 分鐘）後通話結束，字幕說沒有說話；`voice-cost.jsonl` 最後一筆 `end_reason` 是 `idle`。電視台詞若被辨識成逐字稿會算一輪，這是已知限制，可能撐到上限。
4. 把上限改成 5 分鐘，一直和 Nous 對話：第 4 分鐘出現提醒字幕和提示音，第 5 分鐘結束，紀錄 `max_duration`。
5. 通話中收起視窗：通話繼續。鎖定螢幕：通話結束，解鎖後字幕是「螢幕鎖定，即時語音已結束。」，紀錄 `os_lock`。睡眠再喚醒：紀錄 `suspend`。
6. ChatGPT 方案路徑重做第 2、4 步：指示寫「ChatGPT 方案：用量不明」。
7. 在 OpenAI 用量頁面核對：步驟 3–5 結束後沒有繼續累積的即時語音用量（tokens 只是頁面回報的約略值，不是帳單）。

## Pi 手動驗證步驟（未執行）

1. Mac App 進入服務模式，Pi kiosk 開始即時語音：Pi 右上角指示有時間與用量；Mac 選單列寫「終端機 rpi4 · …」。
2. 在 Pi 上切到別的視窗或最小化 Chromium 超過 30 秒：通話結束，紀錄 `hidden`；30 秒內回來不結束。
3. 通話中拔掉 Pi 網路或停掉 SSH 通道（`systemctl --user stop aios-tunnel`）：Mac 核心最慢約 45 秒後（或 SSE 關閉時立刻）結束這通，紀錄 `client_lost` 或 `page_gone`；OpenAI 用量不再增加。
4. 關掉 Pi 螢幕：通話**不會**因此結束，只會照閒置或上限結束。
5. Mac 鎖定：Pi 的通話繼續。Mac 睡眠：Pi 的通話結束，紀錄 `suspend`。
6. 重新整理 Pi 頁面：通話立刻結束（`hidden`，keepalive 送出）。

## 誠實的限制

- 被語音辨識轉成逐字稿的電視或旁人台詞仍算一輪，頁面分不出是誰說的；**每通上限才是最後防線**。
- tokens 是頁面加總 `response.done` 回報的 usage，**不是帳單**：還沒有回應結束時的輸入音訊不算進來，計費規則與單價也不在這裡；費用紀錄的 `cost` 照舊一律 `unknown`。
- ChatGPT 方案路徑拿不到 usage，一律顯示用量不明，不推算。
- 選單列的時間在核心設定重讀時才更新（15 秒一次），頁面上的指示每秒更新。
- ChatGPT 方案的回覆有沒有結束，看助理的整句逐字稿；上游沒送整句時，credit 留到下一個開口事件，那之前雜音觸發的回覆停頓仍會重新倒數一次。
- 上限前的提示音沿用處理中提示音；瀏覽器暫停了 AudioContext（沒有使用者手勢）時不出聲，只有字幕。
- 核心結束 ChatGPT 方案通話靠 sideband 的 `session.close`；sideband 已斷時沒有別的掛斷方式（那時上游也已經結束連線）。
- 沒有旁路的 API key 通話：還沒報到過（連上後 15 秒內）就遇到 SSE 斷線會立刻掛斷；報到過的通話在 SSE 斷線後最多再計費約 45 秒才由核心掛斷（頁面還在時照常繼續，但核心送不了事件給它）。帶記憶的 API key 通話與 ChatGPT 方案通話仍在 SSE 斷線時立刻結束。
- Mac 與 Pi 實機都沒有驗證；鎖定與睡眠事件只有 fixture。

## 回復

- 回復這個分支的 commit 即可。`voice.json` 裡多出的 `realtime_max_call_s` 對舊版是不認得的鍵：舊版只略過它並記 log，其他設定照常。
- 只想放寬時：把上限設成 60 分鐘、閒置設成 600 秒（不能關掉）。

## 變更的檔案

`prototype/ambient-shell/`：`src/call-guard.ts`（新）、`src/call-lifecycle.ts`（新）、`shared/call-meter.ts`（新）、`src/realtime.ts`、`src/live-voice.ts`、`src/realtime-session.ts`、`src/main.ts`、`src/api.ts`、`src/views.ts`、`shared/voice-prefs.ts`、`shared/voice-cost.ts`、`shared/realtime-route.ts`、`shared/messages.en.json`、`server/realtime-routes.ts`、`server/apikey-call.ts`、`server/live-route.ts`、`server/app.ts`、`server/nous.ts`、`desktop/main.mjs`、`desktop/settings-menu.mjs`、`desktop/settings-menu.d.mts`、`desktop/messages.en.json`、`shared/seconds-menu.ts`、`shared/voice-commands.ts`（語音指令表多一列「每通即時語音到上限」）、`README.md`／`README.en.md`（語音閒置秒數表與指令表），以及上面列的測試。
