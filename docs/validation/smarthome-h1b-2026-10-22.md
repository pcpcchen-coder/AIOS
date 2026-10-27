<!-- bilingual: source=zh-TW -->

> [繁體中文](smarthome-h1b-2026-10-22.md) | [English](smarthome-h1b-2026-10-22.en.md)

# 武陵居家電控制 H1b 驗證（AIFA 冷氣、紅外線家電）

日期為 2026-10-22，平台為 Linux 雲端環境，Node.js 22.22.0。對應 [docs/12](../12_SmartHome_Integration_Plan_2026-10.md) 的批次 H1b（`home_control` 延伸到 AIFA 冷氣與 Tuya 紅外線家電）。這是原型的驗證，沒有變更 G0 至 G3 驗收狀態。

**這份文件裡沒有任何真實冷氣或真實紅外線家電的結果。** 假中控測試是 fixture；真實中控程式沒有 AIFA 帳號與 Tuya 雲端認證，冷氣清單與紅外線按鍵是寫進中控資料庫的 fixture，所以只走得到「失敗」「沒有送出」與冷卻後重送。George 家裡的步驟在最後，結果還沒有記錄。

## 結果

| 檢查 | 結果 | 範圍 |
| --- | --- | --- |
| `npx vitest run` | 通過（586 個：審查修正前 580 個，H1b 前 537 個） | H1b 新增 43 個：`tests/home-bridge.test.ts` 41 個、`tests/http.test.ts` 1 個、`tests/realtime-voice.test.ts` 1 個；審查修正再加 6 個（都在 `tests/home-bridge.test.ts`）。見下方「假中控測試」與「審查修正」。 |
| 真實中控程式 | 通過（只有拒絕、失敗與冷卻的路徑） | SmartHomeAI 的 FastAPI 中控（示例配置），加上 fixture 的 AIFA 清單與紅外線按鍵。沒有 AIFA 帳號與 Tuya 認證，任何指令都不會到廠商。見「真實中控程式」。 |
| `npx tsc --noEmit`、`npx vite build`、`node --check desktop/main.mjs`、`node scripts/verify-aios.mjs`、`git diff --check` | 通過 | |

## 假中控測試（fixture）

假中控是 Node 的 HTTP 伺服器，設備、清單、按鍵與回覆都是虛構的。回覆格式照中控 `backend/app.py`、`aifa.py`、`infrared.py`：AIFA 的錯誤是字串（409「請先重新讀取 AIFA 家電清單」「找不到已授權的 AIFA 冷氣」「相同指令識別碼不可用於不同內容」、429「請稍候兩秒再操作」），成功是 200 `unconfirmed` 加 `controller_status`；紅外線的錯誤是 `{code, message}`（`ir_cooldown`、`ir_keys_required`、`ir_key_unsupported`、`ir_not_authorized`），成功是 200 `unconfirmed` 加 `transport_status`。冷卻等待用注入的 `sleep` 推進假時鐘，不真的等。

`tests/home-bridge.test.ts`：

- **合併 AIFA 清單**：冷氣的房間來自 `matched_device_id` 對到的中控設備，對不到就沒有房間；查詢時說「狀態未知」，不說在線；離線帶讀清單的時間（見「審查修正」6）。清單回 500、404、格式不符或逾時：燈照樣控制，「冷氣」是 `not_found` 加註「AIFA 冷氣清單讀不到」；帳號沒連結時只說找不到，不加註。設定碼不是 173 的冷氣只能開關，設定在送出前就拒絕（也不讀 `/status`）；AIFA 的非冷氣家電照實拒絕。
- **開關**：送出的內容就是 `{"power":true}`，帶 `Idempotency-Key`；結果 `unconfirmed`／`one_way`，字幕「⏳ 客廳 冷氣 開啟：已送出，請確認」；`controller_reported` 是「控制器回報：開、冷氣、26 度、風量低、擺風自動」，系統通知說明那不是冷氣的實際狀態。
- **設定**：
  - 冷氣開著說「26 度」：先 POST `/status`（沒有 body），再 POST `/climate`，內容是 `{mode, temperature, fan, swing, feature}` 五個欄位，模式、風量、擺風照控制器回報，睡眠模式保留。
  - 冷氣關著說「26 度」：模式用預設的冷氣，`defaults_used: ["模式：冷氣"]`，`note` 說這個設定不代表會開機；結果裡沒有「已開」。
  - 冷氣關著說「改除濕」：溫度用預設的 26 度（候選設計 1 的預設沒有溫度，這裡修正）。
  - `/status` 逾時或回 409：所有項目用預設值，四項都列在 `defaults_used`。
  - 風量調小：中到低；回報是自動或沒有回報、已經最低：不送 `/climate`，照實說。
  - 暖氣、送風、35 度、25.5 度：本機拒絕，沒有任何請求。
- **中控回覆**：200 `failed` 是 `failed`／`device`，照中控的原因說；中控記下但還在處理（`accepted`）是 `no_reply`。409「找不到已授權的 AIFA 冷氣」是 `not_ready`，帶中控原文；只有同 key 不同內容是「AIOS 內部錯誤」。
- **冷卻 429**：等一次（2.2 秒）用同一把 key 與內容重送，結果 `one_way`；第二次仍是 429：`rate_limited`、`retry_after_s: 2`，兩次 POST，不是 502。
- **慢回覆**：第一次逾時、第二次拿到已記下的結果是 `one_way`（同一把 key）；兩次都逾時是 `no_reply`；第一次逾時後第二次回 409，也是 `no_reply`，不說「沒有送出」（中控先檢查清單再比對已記下的 key）。
- **清單超過 24 小時**：只呼叫一次 `/discover` 再送出；`/discover` 回 409 或重新讀取後找不到這台：`not_ready`，沒有送出；`/discover` 回 429：照樣送出，中控仍說過期時是 `not_ready`、`retry_after_s: 60`；清單看起來沒過期但中控回 409 過期：重新讀取一次後用同一把 key 重送；設定的順序是 `discover` → `status` → `climate`。
- **紅外線**：
  - 「打開電視」按 `Power`（`{key:"Power", key_id:1}`），`toggle: true`，字幕「⏳ 客廳 電視 按下「Power」鍵：已送出，請確認（這是切換鍵）」；`configured:false` 的紅外線家電照樣送出。
  - 「大聲一點」（`press volume_up`）按 `Vol+`；`channel_down` 按「頻道減」；`mute` 按 `Mute`。
  - 電風扇開／關優先按 `PowerOn`／`PowerOff`（不是切換鍵）；說 `timer` 完全相同、說 `Spe` 唯一包含，都按到對的鍵。
  - 「擺頭」沒有這個鍵：`unsupported`，「電風扇沒有「擺頭」鍵，指令沒有送出；有：PowerOn、PowerOff、Speed、Timer。」；同一個意圖有兩個不同的鍵（「音量加」與「Vol+」）：問要按哪一個。
  - 按鍵沒同步（`ready:false`）：`not_ready`，沒有請求；紅外線控制器本身：請說家電名稱；紅外線家電設音量數字：請說「大聲一點」。
  - 紅外線的冷氣遙控：`ac_temperature` 拒絕，`press "temp 加"` 按 `Temp+`。
  - `ir_cooldown`：等一次（1.2 秒）同 key 重送；`transport_status: unknown` 是 `cloud_no_reply`，字幕「? 客廳 電視 按下「Vol+」鍵：雲端沒有回覆，不確定有沒有送出（中控不會自動重送）」；Tuya 拒絕是 `failed`；`ir_keys_required` 是 `not_ready`；`ir_key_unsupported` 是 `unsupported`；`ir_not_authorized` 是 `not_configured`。
- **共用規則**：
  - 同名的 AIFA 冷氣與紅外線「冷氣」：候選是「客廳的冷氣（紅外線遙控）」「客廳的冷氣（AIFA）」，照這兩種說法回答會選到那一台。
  - 「冷氣26度」當成目標時不會變成讀值查詢；對燈說 `ac_temperature` 不會送到 `/commands`；`temperature` 不是指令。
  - 每分鐘 6 個上限三條路徑共用：3 個燈、2 個冷氣、1 個紅外線之後，第 7 個不送出，也沒有任何請求。
  - 確認卡（測試專用的 `policyFor`）：紅外線卡寫「按下「Vol+」鍵」，同時兩次同意只送一次；冷氣卡在同意之前不讀 `/status`，拒絕不送出，同意後才讀 `/status` 再送。
  - 即使假中控把 AIFA 與紅外線的結果寫成 `confirmed`，AIOS 也不回報 `confirmed`；結果與送出的內容都不含權杖。
- 其他：`keyNorm`（加→+、保留結尾的 -）、每個紅外線意圖都有同義詞且沒有「auto／on／低／高」這類字、`buildClimate` 的預設值清單、`parseCommand` 的說法。

`tests/http.test.ts`：`/api/home/control` 送 `ac_swing fixed_3` 與 `press volume_up`，本機核心依序 POST `/status`、`/climate`、`/infrared-commands`，回應不含權杖。H1 的兩個測試多了一筆 `GET /api/v1/integrations/aifa`（每次都和 `/home` 一起讀）。`tests/realtime-voice.test.ts`：`ac_temperature` 的工具呼叫與 `one_way` 結果原樣交給模型，之後請模型說話。

H1 的測試只有這些預期改了：紅外線電視（`ready:false`）從 `unsupported` 改成 `not_ready`；Tuya `kt`／`ktkzq` 與 Home Assistant 冷氣的拒絕文字改成「是冷氣，但不是透過 AIFA 連接」；中控設備裡的 AIFA 控制器改成「是 AIFA 控制器本身」；工具說明與模型指示的文字。假中控多回答 `GET /integrations/aifa`（帳號沒連結）。

## 審查修正

獨立審查 `7a7f70a` 找到 6 個問題，都已修正，各加一個回歸測試（`tests/home-bridge.test.ts`，名稱以 `review:` 開頭，另外改了 4 個既有測試的預期）。把 `server/`、`shared/` 改回修正前的程式時，這 6 個新測試與 4 個改過預期的既有測試（共 10 個）都會失敗：

1. **意圖落到包含比對，按錯鍵**：`press volume_up` 在同義詞表找不到時，會用說法（`volumeup`）去找「包含」的鍵，`Up`／`Down` 這類導覽鍵就會被按下（電視有「音量▲／▼」又有 `Up`／`Down` 時按到 `Up`；紅外線冷氣遙控上可能改到溫度）。改成有意圖時只比對同義詞表與完全相同的按鍵名稱，不找包含的；找不到就拒絕並列出真的有的鍵。`keyNorm` 另外把 `▲`／`△` 當成 +、`▼`／`▽` 當成 -、減號 `−`（U+2212）當成 -（全形＋／－原本就由 NFKC 處理），所以「音量▲」「頻道▼」「Vol −」直接對到既有的「音量+」「頻道-」「Vol-」，不必另加同義詞；不會因此多出模糊的對應（沒有任何同義詞是單獨的 + 或 -）。測試：「臥室電視」（`Power`、`Up`、`Down`、`音量▲`、`音量▼`、`頻道▲`、`頻道▼`）的 `volume_up`／`volume_down`／`channel_up`／「頻道減」各按到對的鍵；「窗型冷氣」（`Power`、`Up`、`Down`、`Mode`）的 `volume_up` 與「音量加」都拒絕：「窗型冷氣沒有「音量加」鍵，指令沒有送出；有：Power、Up、Down、Mode。」，沒有任何紅外線請求。
2. **沒有房間的 AIFA 冷氣選不到**：客廳有紅外線「冷氣」、AIFA「冷氣」沒有房間時，候選是「客廳的冷氣」「冷氣」，名稱不同所以沒加路徑，使用者說「冷氣」又是同樣兩個候選，AIFA 那台永遠選不到。改成問是哪一台時，AIFA 冷氣與紅外線家電的候選一律加上路徑，結果帶 `note`「使用者選了之後，target 照候選名稱一字不差填，包括括號裡的（AIFA）或（紅外線遙控）。」；模型指示（`home_status` 與 `home_control` 的 ambiguous）也這樣說。名稱只對到另一條路徑的一台時（模型自己說成「客廳的冷氣（AIFA）」），以括號裡的路徑為準。測試：候選是「客廳的冷氣（紅外線遙控）」「冷氣（AIFA）」（`home_status` 相同）；說「冷氣（AIFA）」與「客廳的冷氣（AIFA）」都送到 AIFA 的 `c9`，說「客廳的冷氣（紅外線遙控）」按紅外線的 `Power`。
3. **共用 `key_id` 掩蓋了模糊**：判斷「是不是同一個鍵」只看 `key_id`，中控的 `key_id` 預設是 0，`Vol+` 與 `Vol-` 都是 0 時「vol」會直接按 `Vol+`。改成用 `key` 加 `key_id` 判斷。測試：兩個鍵都是 `key_id` 0，「vol」回「電視有好幾個可能的鍵：「Vol+」、「Vol-」；要按哪一個？指令沒有送出。」；同一個鍵列兩次仍只算一個。
4. **紅外線靜音是切換鍵**：`mute false` 按的是和 `mute true` 同一個靜音鍵，卻沒有 `toggle`。改成按到靜音鍵（`mute`、`press mute` 或說按鍵名稱）時都帶 `toggle: true`。字幕改成不分電源或靜音的「（這是切換鍵）」，系統通知與模型指示說「按的是切換鍵（電源切換鍵或靜音鍵），按一下切換一次…不能說開了、關了、靜音了或取消靜音了」。測試：`mute true` 與 `mute false` 都按 `{key:"Mute", key_id:4}`、`toggle: true`，字幕「⏳ 客廳 電視 按下「Mute」鍵：已送出，請確認（這是切換鍵）」，字幕、系統通知與結果都不含「已靜音」「已取消靜音」。
5. **沒有 POST 的拒絕也用掉速率限制**：每分鐘 6 個的名額原本在一開始就記下，清單重新讀取失敗、冷氣設定組不出來（不知道目前風量）、已經最低、時間不夠這些沒有送出的拒絕也算一個。改成在第一次控制 POST 之前才記（`postTwice`；H1 的 `/commands` 在 `sendCommands` 之前），仍是每個意圖一次：同 key 重送、冷卻後重送、重新讀取清單後重送、`/discover`、`/status` 都不算。測試：先三個沒有 POST 的拒絕（清單過期且 `/discover` 409、風量自動時說調小、已經最低時說調小），再 3 個燈、2 個冷氣、1 個紅外線都送出；第 7 個送出的意圖仍是 `rate_limited`，沒有請求。代價是被限制的冷氣設定仍會先讀 `/status`（不是控制指令，不影響冷氣）。
6. **AIFA 的離線說成現在**：AIFA 冷氣的 `online:false` 來自最多 24 小時前的清單，`home_status` 卻說「離線」。改成「上次讀取 AIFA 清單時離線（12:20）」（不是今天時加日期，和讀值時間的寫法相同），清單沒有讀取時間就說「狀態未知」；中控自己的設備不變。測試：清單 1 小時前讀（12:20），`主臥冷氣` 的 `online` 與字幕都帶這個時間；`queried_at: null` 時是「狀態未知」；中控的「客廳立燈」仍是「離線」。

docs/12 的 H1b 段落與 `prototype/ambient-shell/README.md` 的紅外線段落照上面改寫。

## 時間預算

逾時常數在 `server/home-bridge.ts` 的 `H1B_TIMEOUTS_MS`：讀清單 8 秒（`/home` 與 `/integrations/aifa` 同時讀）、`/status` 22 秒、`/discover` 25 秒、AIFA 送出 16 秒＋重送 12 秒、紅外線送出 16 秒＋重送 10 秒。`tests/home-bridge.test.ts` 的 budget 測試把常數加起來，再檢查 60 秒上限（`UTTERANCE_MS`）：

| 情況 | 算法 | 名目最壞 | 實際上限 |
| --- | --- | --- | --- |
| AIFA 設定，清單過期 | 8 + 25 + 22 + 16 + 12 | 83 秒 | 60 秒 |
| AIFA 設定 | 8 + 22 + 16 + 12 | 58 秒 | 58 秒 |
| AIFA 開關 | 8 + 16 + 12 | 36 秒 | 36 秒 |
| AIFA 開關，清單過期 | 8 + 25 + 16 + 12 | 61 秒 | 60 秒 |
| 紅外線 | 8 + 16 + 10 | 34 秒 | 34 秒 |
| H1 `/commands`（不變） | 8 + 16 + 15 + 16 | 55 秒 | 55 秒 |

- 每一步的逾時都取它自己的常數與剩下時間的較小值。`/status` 另外留 5 秒給送出。剩下不到 5 秒（`MIN_SEND_WINDOW_MS`）就不再開始 POST：還沒送過是 `not_ready`（沒有送出），送過一次是 `no_reply`（不確定）。
- 冷卻那一條比較短：第一次 429 幾乎立刻回來，等 2.2 秒（紅外線 1.2 秒）再送 16 秒。
- 確認卡同意（`confirm()`）不再讀清單，60 秒從同意時算。
- 假時鐘測試：清單過期的設定，`/discover` 用掉 25 秒、`/status` 22 秒，第一次送出被截成剩下的 13 秒並回 503，之後不再重送，結果 `no_reply`，總共 60 秒。`/discover` 40 秒加 `/status` 17 秒之後只剩 3 秒：`not_ready`，沒有 POST。冷卻 429 時已用掉 56 秒：`rate_limited`，只有一次 POST。
- H1 的 `/commands` 最壞 55 秒，比 60 秒短，所以 deadline 不套用在 H1 的路徑（`sendCommands` 不變）。

## 真實中控程式

中控是 SmartHomeAI `90a3168` 的 `backend/app.py`，用 `WULING_POLL=0`、暫存資料夾啟動，載入 `assets/example-seed.json`，用中控主權杖。**這個中控沒有 AIFA 帳號，也沒有 Tuya 雲端認證**：冷氣不會收到任何封包，紅外線也不會送到 Tuya。每一列都是 `HomeBridge.control` 實際的請求與結果。

### 沒有寫入任何 fixture（示例配置本身）

| 說法 | 中控請求與回覆 | 結果與字幕 |
| --- | --- | --- |
| 冷氣 power true | GET `/home`、GET `/integrations/aifa` → `connected:false`、沒有冷氣 | `not_found`：「家裡找不到「冷氣」」（帳號沒連結，不加註） |
| 示例燈具 ac_temperature 26 | 只讀清單，沒有 POST | `refused`／`unsupported`：「示例燈具不是 AIFA 冷氣或紅外線家電，不能「設定 26 度」，指令沒有送出。」 |
| 示例燈具 power false | H1 路徑：POST `/commands` → 409 `state_stale`；POST refresh → 200；同一把 key 再 POST → 409 | `refused`／`not_ready`，和 H1 驗證相同 |
| 電視 press volume_up | 只讀清單 | `not_found` |

### 寫入 fixture 的 AIFA 清單與紅外線按鍵（不是任何真實設備）

`seed_h1b.py` 寫入：一份 AIFA 清單（一台設定碼 173 的「冷氣」），一台紅外線控制器（`wnykq`）與一台紅外線「電視」（按鍵 `Power`、`Vol+`、`Vol-`），以及 Tuya 設備授權清單。AIFA 權杖與 Tuya 雲端認證都沒有設定。

清單是 1 小時前讀的：

| 說法 | 中控請求與回覆 | 結果與字幕 |
| --- | --- | --- |
| 冷氣 power true | POST `…/children/fixture-ac/power {"power":true}` → 200 `failed`「請先連結 AIFA Smart 帳號」 | 「✕ 冷氣 開啟：失敗（請先連結 AIFA Smart 帳號）」 |
| 冷氣 ac_temperature 26 | POST `…/status` → 409「請先連結 AIFA Smart 帳號」（讀不到，用預設值）；POST `…/climate {"mode":"cool","temperature":26,"fan":"auto","swing":"auto","feature":"normal"}` → 200 `failed` | 「✕ 冷氣 設定 26 度：失敗（請先連結 AIFA Smart 帳號）」；失敗的結果不帶「送出的設定」與預設值 |
| 電視 power true | POST `/devices/ir-fixture-tv/infrared-commands {"key":"Power","key_id":1}` → 200 `failed`「尚未設定 Tuya 雲端認證」 | 「✕ 電視 按下「Power」鍵：失敗（尚未設定 Tuya 雲端認證）」 |
| 電視 press volume_up（緊接著上一句） | POST → **429 `ir_cooldown`**（中控在送 Tuya 之前就記下送出時間）；等 1.2 秒，同一把 key 再 POST → 200 `failed` | 「✕ 電視 按下「Vol+」鍵：失敗（尚未設定 Tuya 雲端認證）」，共 1219 ms |
| 電視 mute true | 只讀清單，沒有 POST | 「沒有送出：電視沒有「靜音」鍵，指令沒有送出；有：Power、Vol+、Vol-。」 |
| 紅外線控制器（fixture） power true | 只讀清單 | 「…是紅外線控制器本身，請說要控制的家電名稱，例如電視。」 |

清單是 25 小時前讀的（超過中控的 24 小時）：

| 說法 | 中控請求與回覆 | 結果與字幕 |
| --- | --- | --- |
| 冷氣 power true | POST `/integrations/aifa/discover` → 409「請先連結 AIFA Smart 帳號」；沒有送出 | `not_ready`：「AIFA 冷氣清單超過 24 小時，重新讀取沒有成功（請先連結 AIFA Smart 帳號），指令沒有送出；請到中控的 AIFA 頁重新讀取。」 |
| 冷氣 power false（一分鐘內） | POST `/discover` → 429「AIFA 清單同步至少相隔 60 秒」（失敗的讀取也算）；照樣 POST `/power` → 409「請先重新讀取 AIFA 家電清單」 | `not_ready`、`retry_after_s: 60`：「中控回覆「請先重新讀取 AIFA 家電清單」，指令沒有送出；剛剛有人重新讀取過，一分鐘內不能再讀，請一分鐘後再說一次。」 |
| 冷氣 ac_mode dry（一分鐘內） | `/discover` → 429；`/status` → 409 過期；`/climate` → 409 過期 | 同上 |

另外清單是 23.9 小時前讀的（超過 AIOS 的 24 小時減 10 分鐘，但還沒超過中控的 24 小時）：「冷氣 power true」先 `/discover` → 409（沒有帳號），重新讀取失敗就不送，結果 `not_ready`；一分鐘內說「冷氣調 26 度」時 `/discover` → 429，照樣讀 `/status`（409）再送 `/climate`，中控接受這份清單，回 200 `failed`（沒有帳號）。這一組是在最後兩處文字修改（拒絕訊息的說法、失敗結果不帶設定）之前跑的，請求順序與結果狀態不受影響；上面兩張表是改完後重跑的。

用 curl 對中控確認：同一把 key、同樣內容 POST `/power` 兩次，回傳同一筆結果（同一個 `id`）；同一把 key、不同內容回 409「相同指令識別碼不可用於不同內容」；沒有 `Idempotency-Key` 回 422「請提供唯一指令識別碼」（AIOS 每次都帶）。

所有結果都檢查過不含權杖。

**沒有走到的真實路徑**：AIFA 送出成功（`unconfirmed`＋`controller_status`）、AIFA 的 2 秒冷卻（中控在送出封包時才記時間，沒有帳號時走不到）、`/status` 讀到真的設定、`/discover` 成功、紅外線 `accepted_by_cloud`／`unknown`、慢回覆與逾時。這些只在假中控測過。

## 尚未驗證

- **真實冷氣與真實紅外線家電**：見上一段，都只有 fixture。
- **中控在 AIOS 中斷連線後是否繼續送出**：中控用 Starlette 的 `BaseHTTPMiddleware`，交叉審查讀程式認為不會取消處理；同 key 重送拿到已記下的結果是依此設計，沒有實測。
- **控制器記得的設定是否跟著實體遙控器**：George 用實體遙控器改過之後，`/status` 可能還是舊的；結果只說成「控制器回報」。
- **實機語音**：模型會不會把「開冷氣 26 度」拆成兩次、會不會說出預設值、會不會把切換鍵說成「已關」，都還沒實測。
- **George 家的紅外線按鍵名稱**：同義詞表是依常見的 Tuya 名稱寫的，要用下面的表核對。

## 2026-10-25 補記

George 對兩件事做了決定，程式已改，本檔上下文保留 2026-10-22 的原文：

- 冷氣關著時讀不到控制器記得的模式，預設改成**自動**（不分季節），原本是冷氣。上面「冷氣關著說『26 度』」的 `defaults_used: ["模式：冷氣"]` 與真實中控那一列的 `"mode":"cool"`，現在分別是 `["模式：自動"]` 與 `"mode":"auto"`；`sent_settings` 的模式前面加了「模式」（例如「模式自動、26 度、風量高、擺風固定 2」）。
- 關 AIFA 冷氣時，Nous 會說「如果這台冷氣有設定定時，中控關機時會一併取消，需要的話請重新設定」。下面步驟 3（關冷氣）與步驟 4（預設模式）的預期跟著改，步驟見 [三項小決定](small-decisions-2026-10-25.md#george-在-mac家裡的測試步驟)。

## George 家裡的實機驗證步驟

1. 中控在執行，「系統接入」的權杖已填進 Nous 的 `.env`（H1 已完成）。在中控的 AIFA 頁確認帳號已連結、冷氣清單是今天讀的；在紅外線控制器按「同步」，確認電視、電風扇的按鍵已同步。
2. `npm start`，終端機顯示「武陵居中控：已設定，…（查詢與控制）」與「即時語音：可用」。
3. 按「開始語音對話」，依序說（每句之間等 Nous 說完）：
   - **冷氣**
     1. 「開冷氣」：預期 Nous 先說「好，我請中控處理」，字幕「⏳ … 冷氣 開啟：已送出，請確認」，Nous 請你看一下，不說「已經開了」。冷氣實際有沒有開：＿＿。
     2. 「冷氣調 26 度」（冷氣開著）：字幕「⏳ … 設定 26 度：已送出，請確認」；Nous 可能提到模式和風量照控制器的設定。冷氣面板顯示：＿＿。
     3. 「關冷氣」：字幕「⏳ … 關閉：已送出，請確認」。冷氣實際有沒有關：＿＿。
     4. 「冷氣調 26 度」（冷氣關著）：Nous 要說模式用了預設的冷氣，而且這個設定不代表會開機。冷氣有沒有自己開機：＿＿（這是中控文件沒寫的事，請照實記）。
     5. 「冷氣改除濕」（先開冷氣）：字幕「模式改成除濕」。冷氣面板顯示：＿＿。
     6. 「冷氣風量調小」：控制器回報低／中／高時調一格；回報自動時 Nous 說不知道目前風量，請你說低、中、高或自動。結果：＿＿。
     7. 「開冷氣 26 度」：預期 Nous 呼叫兩次（開關、設定），字幕出現兩行。結果：＿＿。
   - **電視與電風扇**
     1. 「打開電視」：字幕「⏳ … 電視 按下「Power」鍵：已送出，請確認（這是切換鍵）」（鍵名照你家的）；Nous 不說「電視已開」。電視實際：＿＿。
     2. 「電視大聲一點」：字幕「按下「Vol+」鍵」之類，音量加一格。結果：＿＿。
     3. 「電風扇開」：如果遙控器有分開的開機鍵，按開機鍵；只有電源鍵就按電源鍵並說是切換鍵。結果：＿＿。
     4. 說一個電視沒有的鍵，例如「電視按擺頭」：Nous 說沒有這個鍵並唸出幾個有的鍵，沒有送出。結果：＿＿。
4. 把每一步的字幕、Nous 說的話與家電的實際反應記在本檔，特別是「開冷氣」從說完到字幕出現的秒數，以及第 4 步冷氣有沒有開機。

## George 家的紅外線按鍵名稱（待記錄）

請在中控的紅外線家電頁看每台家電同步到的按鍵名稱（`label`），記在下表，並記下 Nous 實際按到哪個鍵。比對不到的鍵（「Nous 選的鍵」與預期不同或說沒有這個鍵）要回報，好補同義詞表（`server/home-bridge.ts` 的 `IR_SYNONYMS`）。

| 家電 | 中控顯示的按鍵名稱（全部） | 說「打開」時 Nous 選的鍵 | 說「大聲一點」／「風速」時選的鍵 | 有沒有比對不到的說法 |
| --- | --- | --- | --- | --- |
| 電視 | | | | |
| 電風扇 | | | | |
| （其他） | | | | |

## George 家裡的實機結果

尚未記錄。
