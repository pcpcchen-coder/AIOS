# 武陵居家電控制 H1 驗證

日期為 2026-10-22，平台為 Linux 雲端環境，Node.js 22.22.0。對應 [docs/12](../12_SmartHome_Integration_Plan_2026-10.md) 的批次 H1（`home_control`）。這是原型的驗證，沒有變更 G0 至 G3 驗收狀態。

## 結果

| 檢查 | 結果 | 範圍 |
| --- | --- | --- |
| `npx vitest run` | 通過（530 個，H1 前 492 個） | 見下方「假中控測試」。 |
| 真實中控程式 | 通過 | SmartHomeAI 的 FastAPI 中控（示例配置）。示例設備沒有真實位址，所以只驗證拒絕與失敗的對應，沒有任何 `confirmed`。 |
| 真正伺服器入口 | 通過 | 以 `SMARTHOME_URL`、`SMARTHOME_TOKEN` 啟動 `server/index.ts`，`POST /api/home/control` 回傳中控的結果；啟動訊息顯示「（查詢與控制）」，回應與啟動訊息都不含權杖。 |
| `npx tsc --noEmit`、`npx vite build`、`node --check desktop/main.mjs`、`node scripts/verify-aios.mjs` | 通過 | |

## 假中控測試

假中控是 Node 的 HTTP 伺服器（**fixture**，設備與回覆是虛構的）。回覆格式照中控 `backend/app.py` 的 `execute()`：同步回傳 `{id, status, message}`、409 `state_stale`／`not_configured`、422 `unsupported_command`、同 key 不同內容的 409 字串。

`tests/home-bridge.test.ts`：

- `confirmed`：送出的內容是 `{command:"power", value:false}`，帶 `Idempotency-Key`（`nous_` 開頭，128 字以內）與權杖；字幕「✓ 客廳主燈 關閉：已確認」。
- 亮度「60%」送 60；色溫「3000K」以中控的 `temperature: 3000` 送出；色溫「26」在本機拒絕，不送出。
- `unconfirmed` 與中控記下的 `accepted` 都回報「已送出、未確認」，不是 ✓。
- `failed` 照中控的原因說。
- 第一次逾時：用同一把 key、同樣內容重送一次，採用第二次的結果。兩次都逾時：`unconfirmed`／`no_reply`。
- 連線被拒（中控一定沒收到）：`failed`／`hub_unreachable`；先逾時再被拒：仍是 `no_reply`，因為第一次可能已經執行。
- 同 key 不同內容的 409：`failed`／`internal`，不重送，訊息不含權杖。
- `state_stale`：重新讀取一次，再用同一把 key 重送，結果 `confirmed`；仍過期或重新讀取失敗：`refused`／`not_ready`。上一次回讀逾時、`commands: []` 的設備照樣送出，不會被說成不支援。這個流程只算一次速率限制。
- 未完成接入（`/home` 的 `configured:false` 不送出；中控回 409 也對應到同一個原因）、不支援（中控 422；紅外線設備不送出）、中控拒絕的數值（422 字串）。
- 多個候選、房間（包括只有一台的房間）、全家：`ambiguous`，不送出；找不到：`not_found`。
- 速率限制：一分鐘內第 7 個不送出，`retry_after_s` 是 55（算法見下）；再過 61 秒後可以送。
- 確認卡（測試專用的 `policyFor`）：`needs_confirmation` 不送出；同意只送一次，用 `control()` 時產生的 key；同時兩次同意、之後再同意或拒絕都拿到同一個結果；拒絕後再同意、未知 ID、90 秒後都是 `expired`；`off` 是 `voice_disabled`。
- 權杖只出現在 `Authorization`，不在任何結果、送出的內容、網址、`detail` 或即時語音工具設定裡。

`retry_after_s` 的算法：測試的六個指令在第 1 到第 6 秒送出，第 7 個在第 6 秒；最早那個到第 61 秒才離開 60 秒的視窗，所以要等 61 − 6 = 55 秒（`Math.ceil((最早 + 60 000 − 現在) / 1000)`，至少 1 秒）。

`tests/realtime-voice.test.ts`（假的 WebRTC 資料通道）：

- 直接執行：工具結果交還模型後請它說話；缺少設備或動作時不呼叫本機核心。
- `needs_confirmation`：確認卡在工具結果交回之前就排好；沒有 MCP 的說明通知；工具結果交回後照樣請模型說話（家電卡不佔 MCP 的計數）。
- 說「好」不送出；說「確認執行」把答案交給本機核心，不送 `mcp_approval_response`，結果在這輪回應結束後以一則系統通知轉告，只多一次 `response.create`。
- 「確認執行停止播放」算取消；說「取消」只補背景資訊，不另外要求回應；逾時、收起確認卡會通知模型沒有執行；結束對話只告訴本機核心，不再送任何事件。
- MCP 卡和家電卡排在同一個佇列，一次一張，各自回答。
- 確認後的指令執行中不計閒置；對話結束後才到的結果不再通知。

`tests/http.test.ts`：輸入驗證、未設定中控時 409、`/api/home/control` 與 `/api/home/confirm` 經本機核心送到中控，回應不含權杖。`tests/voice-commands.test.ts`：`home_control` 的指令表列與四個「容易誤會」列（「確認執行停止播放」「好」「冷氣調 26 度」「客廳的燈全部關掉」）都經真正的比對函式檢查。

## 真實中控程式

中控是 SmartHomeAI 的 `backend/app.py`，用 `WULING_POLL=0`、暫存資料夾啟動，載入 `assets/example-seed.json`，用中控主權杖。每一列都是 `HomeBridge.control` 實際的請求與結果。

| 說法 | 中控請求與回覆 | 結果與字幕 |
| --- | --- | --- |
| 示例燈具 power false | POST → 409 `state_stale`；POST refresh → 200（8 ms，設備沒有位址，回讀失敗）；同一把 key 再 POST → 409 `state_stale` | `refused`／`not_ready`：「示例燈具的狀態還沒更新，指令沒有送出；請稍後再試，或先在中控重新讀取設備。」 |
| 示例空氣感測器 power true | 只讀 `/home`（`configured:false`），沒有 POST | `refused`／`not_configured` |
| 同上，把 `/home` 的 `configured` 改成 true（只為了看中控自己的回覆） | POST → 409 `not_configured` | `refused`／`not_configured`：「示例空氣感測器還沒在中控完成設備接入，指令沒有送出。」 |
| 客廳（只有示例燈具一台） | 只讀 `/home` | 第一次測時直接控制了那一台；改成房間一律先問，之後是 `ambiguous`：「客廳（示例）的示例燈具」 |
| 示例燈具 color_temperature 26 | 沒有呼叫中控 | `refused`／`invalid_value`（提到冷氣溫度還不支援） |
| 陽台燈 | 只讀 `/home` | `not_found` |

接著在中控資料庫寫入一筆 **fixture 狀態**：示例燈具 `fresh: true`、`commands: ["power"]`，來源標為「fixture (AIOS H1 validation)」。這不是任何設備的真實觀測，只為了讓中控走到送出那一步。

| 說法 | 中控請求與回覆 | 結果與字幕 |
| --- | --- | --- |
| 示例燈具 brightness 60 | POST → 422 `unsupported_command` | `refused`／`unsupported`：「示例燈具沒有這項控制功能，指令沒有送出。」 |
| 示例燈具 power false | POST → 200 `status: failed`（LIFX 沒有位址，送出前就失敗） | 「✕ 客廳（示例） 示例燈具 關閉：失敗（控制未成功，請檢查設備連線與設定）」 |

另外用 curl 對中控確認兩件事：同一把 key、同樣內容再送兩次，回傳同一筆結果（同一個 `id`）；同一把 key、不同內容回 409 `這個 Idempotency-Key 已用於不同指令`。

所有結果都檢查過不含權杖。

## 尚未驗證

- **`confirmed` 與 `unconfirmed` 的真實回讀**：示例設備沒有真實位址，這兩種結果只在假中控測過。
- **逾時與同 key 重送**：只在假中控測過；真實中控的慢回讀（LIFX 最多 14 秒）沒有實測。
- **實機語音**：沒有 OpenAI API key、麥克風與喇叭；模型會不會先說「好，我請中控處理」、怎麼念各種結果、會不會在 `needs_confirmation` 後重複呼叫，都還沒實測。
- **確認卡畫面**：家電確認卡只有自動化測試，沒有在瀏覽器裡看過；H1 也沒有任何設備會觸發它（要等中控的 `voice` 設定，H2）。
- **範圍權杖**：中控尚未提供 `commands:write` 等範圍（中控 P0-1），本次用中控主權杖。
- **冷氣與紅外線**：不在 H1 範圍（H1b）。

## George 家裡的實機驗證步驟

1. 中控在執行，到「系統接入」建立給 Nous 的權杖；確認要測的燈在中控顯示可控制（至少一台 LIFX 或 Tuya 燈）。
2. Nous 的 `.env` 填 `OPENAI_API_KEY`、`SMARTHOME_URL`、`SMARTHOME_TOKEN`，`npm start`，終端機顯示「武陵居中控：已設定，…（查詢與控制）」與「即時語音：可用」。
3. 按「開始語音對話」，依序說：
   1. 「客廳主燈關掉」：預期 Nous 先說一句「好，我請中控處理」，燈關掉，字幕「✓ … 關閉：已確認」，Nous 說已經關了。
   2. 「書桌燈調到 60%」：亮度 60，字幕 ✓。
   3. 「色溫調到 3000K」（Nous 可能會問是哪一台）：色溫變暖，字幕 ✓。
   4. 對易微聯插座說「插座打開」：字幕「⏳ … 已送出、未確認」，Nous 請你看一下，不說成功。
   5. 「客廳的燈全部關掉」：Nous 問是哪一台，不會一次關掉。
   6. 「冷氣調 26 度」：Nous 說冷氣溫度還不能用語音控制。
   7. 一分鐘內連說 7 次開關：第 7 次說太多了、要等幾秒，燈沒有動。
   8. 把某台燈拔電，等中控標成離線後說「把它打開」：預期 Nous 說狀態還沒更新、沒有送出；插回電、中控恢復後再說一次應該成功。
4. 把每一步的字幕與 Nous 說的話記在本檔，特別是第 1 步從說完到字幕出現的秒數。
