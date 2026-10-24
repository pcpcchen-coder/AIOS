# Nous 12 — 武陵居智慧家電整合規劃（AIOS 端）

版本：v0.5 · 日期：2026-10-22 · 狀態：H0、H1、H1b 已在原型實作，H1 的開關燈 George 已在家裡口頭確認，H1b 待實機驗證；H2–H4 尚未開始（v0.2 納入 George 的四項決定，見 §8；v0.4 記錄 H1 對 §1 第 5 點的修正；v0.5 加入 H1b：AIFA 冷氣與 Tuya 紅外線家電）

> 2026-10-24 對照：[全案現況](./Current_Implementation_Status.md) 與 [功能擴充評估](./13_Feature_Expansion_Assessment_2026-10-24.md) 已加入。H1 的預設直接執行與 H2 尚未接設備政策是既有實作界線，不把確認卡存在寫成所有家電都需確認。家中口頭開關燈紀錄與 live 語音查溫度紀錄不能外推 H1b 或整套計費／實機驗收通過。Quest 空間家電綁定是後續 F8 提案。
對應：SmartHomeAI repo [`docs/AIOS接入規劃.md`](https://github.com/pcpcchen-coder/SmartHomeAI/blob/main/docs/AIOS接入規劃.md)（中控端要補的介面）
關聯：10（遠距 UI）、11（雙目鏡頭）、即時語音的工具與語音確認（`prototype/ambient-shell/src/realtime.ts`、`src/approval.ts`）

---

## 0. 一頁摘要

- **目標**：George 在 18 吋螢幕前 1.5–3 m 處，用語音控制與查詢武陵居的家電：「客廳燈關掉」「冷氣調 26 度」「現在濕度多少」。全程免手。
  - 燈、插座、音響、窗簾走中控的一般控制（H1）。
  - AIFA i-Ctrl 冷氣：開關、設定溫度、模式、風量、擺風（H1b）。
  - Tuya 紅外線家電（電視、電風扇等）：一次按一個遙控鍵（H1b）。
- **分工**：
  - **中控（SmartHomeAI）**：設備、狀態、控制、回讀確認、權杖，以及每台設備的「語音控制」設定。
  - **AIOS**：語音、名稱對應的對話、確認卡、畫面、與鏡頭的在場資訊整合。**整合工作放在 AIOS**。
- **連線（已決定）**：AIOS 本機核心經區網呼叫中控 REST v1 與 SSE，使用範圍權杖。
  - **不走 OpenAI Realtime 的遠端 MCP**：那會由 OpenAI 伺服器連進家裡，等於把家庭控制開到公網。
- **語音工具**：新增 `home_status`、`home_control` 兩個函式工具，由 AIOS 本機核心代為呼叫中控。
- **語音控制設定（存在中控，逐台設定）**：
  - `allow`（預設，所有設備）：直接執行。
  - `confirm`：顯示確認卡，說「確認執行」才送出，沿用現有的語音確認。
  - `off`：不送出，告訴使用者這台沒有開放語音。
- **回報結果**：只說中控回報的真實結果。
  - `confirmed` 才說「已經關了」。
  - `unconfirmed` 說「已送出，請確認」，例如紅外線。AIFA 冷氣與紅外線家電沒有回讀，永遠不會是 `confirmed`。
  - `failed` 照實說。

---

## 1. 架構

```
George（遠處）
  │ 語音（OpenAI Realtime，WebRTC）
  ▼
AIOS 前端（電子腦、確認卡）
  │ function call：home_status / home_control
  ▼
AIOS 本機核心 HomeBridge（新）── REST v1 + SSE，Bearer 範圍權杖 ──► 武陵居中控 :8788
  │                                                          （設備轉接器、回讀、稽核）
  └─ 權杖只在本機核心；不進瀏覽器、不進 OpenAI
```

**HomeBridge**（`server/home-bridge.ts`）是 AIOS 本機核心的新模組，職責如下：

1. **設定**：`.env` 的 `SMARTHOME_URL` 與 `SMARTHOME_TOKEN`（中控「系統接入」建立的 AIOS 專用權杖）。
   - 目前與中控在同一台 Mac：`SMARTHOME_URL=http://127.0.0.1:8788`。
   - 之後分開時只改成中控的區網位址，例如 `http://192.168.1.x:8788`，程式不變。HomeBridge 不寫死位址，也不假設同機（例如不讀中控的資料目錄或主權杖檔）。
2. **快取**：保存設備清單與房間（`GET /home`、`/devices`，之後改用 `/rooms`）。
3. **名稱解析**：
   - 中控提供 `GET /resolve` 後直接使用（中控 P0-3）。
   - 在那之前，用本機的確定性比對過渡：名稱、別名、房間；完全相同優先，其次是包含關係。
4. **送出指令**：`POST /devices/{id}/commands`，帶 `Idempotency-Key`（AIOS 產生的指令 ID）。逾時重試時沿用同一把 key。
5. **接收結果**：訂閱 `GET /events`（SSE，Last-Event-ID 重播）。
   - 收到 `command.result`（中控 P0-4）就轉成語音通知。
   - 在中控補上之前，改用 `GET /commands/{id}` 輪詢。
   - **H1 修正（2026-10-22）**：實際讀過中控程式後，`POST /devices/{id}/commands` 是同步的：送出後等 0.4 秒回讀設備（最多 14 秒）才回傳 `confirmed`／`unconfirmed`／`failed`。同一把 `Idempotency-Key`、同樣內容再送一次會回傳已記下的結果（還在執行時等它完成），不會再執行。所以 H1 不輪詢 `/commands/{id}`：逾時就用同一把 key 重送一次，等於輪詢，而且第一次沒收到回覆、不知道中控的指令 id 也能用。兩次都沒有回覆時回報「不確定有沒有執行」，不說成功。SSE `command.result` 仍留給 H2（例如中控之後改成非同步時）。
6. **語音控制設定**：
   - 讀取中控設備能力中的 `voice: "allow" | "confirm" | "off"`（中控 P0-2）。
   - **設定只在中控改**。AIOS 沒有自己的設定，也不自行判斷風險。
   - 中控補上之前，所有設備視為 `allow`（George 決定的預設）。

## 2. 即時語音的工具

```jsonc
// 查狀態與感測值（不改變任何東西）
{ "name": "home_status",
  "parameters": { "target": "客廳 / 客廳主燈 / 全家", "metric": "temperature | humidity | co2 | power | …（可省略）" } }

// 控制一台設備（房間指令是 H3）
{ "name": "home_control",
  "parameters": { "target": "客廳主燈 / 冷氣 / 電視",
                  "command": "power | brightness | color_temperature | color | volume | mute | play | pause | stop | cover
                              | ac_temperature | ac_mode | ac_fan | ac_swing | press",
                  "value": "true / 60 / 3000 / #FFAA00 / 26 / dry / down / fixed_3 / volume_up …" } }
```

- `color_temperature` 是燈的色溫（K），送到中控時才叫 `temperature`。冷氣的設定溫度是 `ac_temperature`（攝氏），故意不叫 `temperature`。
- `ac_mode`：`auto`／`cool`／`dry`（AIFA 設定碼 173 沒有暖氣和送風）。`ac_fan`：`auto`／`low`／`medium`／`high`／`up`／`down`。`ac_swing`：`auto`／`fixed_1`–`fixed_5`。
- `press`：紅外線家電按一個鍵。`value` 是意圖（`power`、`volume_up`、`volume_down`、`mute`、`channel_up`、`channel_down`、`fan_speed`、`oscillate`）或使用者說的按鍵名稱；HomeBridge 對設備實際同步的按鍵名稱找鍵，模型看不到按鍵 id。紅外線家電的 `power`／`mute` 也是按鍵。

回傳給模型的內容（模型依此說話，不自己補資料）：

| 情況 | 回傳 | 模型怎麼說 |
|---|---|---|
| 名稱有多個候選 | `{ status: "ambiguous", candidates: ["客廳主燈", "客廳立燈"] }` | 「是客廳主燈還是立燈？」；畫面顯示兩張編號卡，說「第一個」也可以 |
| 找不到 | `{ status: "not_found" }` | 「家裡找不到叫這個名字的設備」 |
| 需要確認（設定為 `confirm`） | `{ status: "needs_confirmation", confirm_id }` | 用一句話說要做什麼，請使用者說「確認執行」 |
| 不開放語音（設定為 `off`） | `{ status: "voice_disabled" }` | 「這台設備沒有開放語音控制」 |
| 已確認 | `{ status: "confirmed", message }` | 「客廳主燈已經關了」 |
| 未確認 | `{ status: "unconfirmed", why, message }` | 「已送出，請看一下有沒有反應」 |
| 冷氣、紅外線已送出（H1b） | `{ status: "unconfirmed", why: "one_way", key?, toggle?, sent_settings?, defaults_used?, controller_reported?, note? }` | 「已送出，請確認」；說按了哪個鍵；`toggle` 時不說開了或關了；`controller_reported` 只說成「控制器回報…」；用了預設值要說 |
| 紅外線雲端沒回覆（H1b） | `{ status: "unconfirmed", why: "cloud_no_reply" }` | 「雲端沒有回覆，不確定有沒有送出」 |
| 失敗 | `{ status: "failed", message }` | 照實說原因 |
| 讀值缺失 | `value: null` | 「沒有讀值」，不說 0 |

**確認流程**沿用 PR #9 的語音確認：
- **只在設定為 `confirm` 的設備出現**。
- **確認卡**：琥珀色，顯示動作、設備、房間與數值。
- **固定語句**：`src/approval.ts` 判斷。「確認執行」才送出；只說「好」不算；說「取消」、60 秒逾時或收起確認卡都不送。
- **要調整的地方**：目前確認佇列只服務 MCP 的 `mcp_approval_request`，要擴充成也能處理 HomeBridge 的 `needs_confirmation`。HomeBridge 的確認由本機核心執行指令，不經 OpenAI。

## 3. 畫面（延續 10 的遠距規則）

- **查狀態**：照 05 的錨點樣式，一個大數字加房間名，例如「客廳 26.5° · 濕度 62%」，並標示資料時間。資料過舊時標「快照」，不當成即時值。
- **控制結果**：設備名加大圖示（✓ 已確認／⏳ 已送出／✕ 失敗），3 秒後收起，不需要按任何東西。
- **房間指令**：例如「客廳的燈全部關掉」，逐台列出結果，不顯示「全部成功」。
- **完整細節**：每台的回讀值、來源、時間寄到信箱，不放在 18 吋畫面上（10 §5）。

## 4. 與雙目鏡頭（11）的整合

- **距離自動字級**：同樣套用在家電狀態畫面。
- **手臂指向**：只用來選螢幕上的候選卡片，例如「客廳主燈」或「客廳立燈」。不用來指實體家電，因為鏡頭看不到家電位置與中控的平面圖座標對應，這項另立規劃。
- **手勢不能觸發控制**：停止手勢只停播報，不送任何家電指令。

## 5. 安全與隱私

- **權杖**：AIOS 只使用中控核發的範圍權杖（中控 P0-1：`devices:read`、`telemetry:read`、`commands:write`、`events:read`）。不取得廠商憑證，不能改配置或管理權杖。
  - 範圍權杖完成前，若先用完整權限權杖做開發驗證，只能連示例設備，並在 README 標示。
- **保存**：權杖放在 `.env`，只在本機核心使用，不送瀏覽器、不寫進 trace、不出現在 OpenAI 的工作階段設定。
- **不公開到網際網路**：不提供公網路徑，不把中控掛成 OpenAI 遠端 MCP。
- **速率限制**：HomeBridge 本身限制每分鐘最多 6 個控制指令，避免語音誤觸連發。中控 P1-3 完成後以中控為準。
- **確認政策（George 決定）**：家電控制預設不確認；需要確認或關閉語音的設備，由 George 在中控介面逐台設定。CLAUDE.md 的「當次明確確認」紅線列的是寄出、發布、付費、永久刪除，家電控制不在其中，因此照這個決定執行；設為 `confirm` 的設備仍沿用同一套語音確認。

## 6. 工作批次（AIOS 端）

| 批次 | 內容 | 依賴 | 完成條件 |
|---|---|---|---|
| H0 | HomeBridge 骨架、設定、`home_status`（唯讀）、本機名稱比對過渡、假中控測試伺服器 | 中控現有 REST | 語音問「客廳溫度」，回答中控的真實讀值與時間；缺值說「沒有讀值」 |
| H1 | `home_control`，預設直接執行；`Idempotency-Key`；同步回讀結果，逾時以同 key 重送取得已記錄結果（見 §1 的 H1 修正）；確認卡流程先接好（以測試設定觸發） | H0 | 示例設備：語音直接控制並回報真實結果；`unconfirmed` 不說成成功 |
| H1b | `home_control` 延伸到 AIFA 冷氣（開關、設定溫度、模式、風量、擺風）與 Tuya 紅外線家電（一次按一個鍵）；結果永遠不是 `confirmed` | H1；中控的 AIFA、紅外線介面（已有） | 實機：「開冷氣」「冷氣調 26 度」「打開電視」「電視大聲一點」都送到中控，字幕與語音只說「已送出，請確認」；缺鍵、清單過期照實說沒有送出 |
| H2 | 改用中控的範圍權杖、`voice` 設定、`resolve`、`command.result` SSE | 中控 P0-1～P0-4 | `allow` 直接執行、`confirm` 說「確認執行」才送、`off` 不送；同名候選以編號卡選擇；結果即時以語音回報 |
| H3 | 房間群組指令、逐台結果畫面 | 中控 P1-2 | 實機：從遠處用語音關掉一個房間的燈 |
| H4（選用） | 背景 Agent 透過中控本機 MCP 執行多步驟工作，例如晚上的例行檢查 | 中控 P3 | 與語音共用同一權杖範圍與語音控制設定 |

每個批次依 CLAUDE.md 交付變更清單、測試結果、實機證據與未完成項目。

**H1b 實作對照（2026-10-22）**：仍是同一個 `home_control` 工具與同一個 HomeBridge（`server/home-bridge.ts`），三條路徑都在這個檔案：`control` → `planFor` → `sendCommands`（H1，不變）／`sendAifa`／`sendIr` → `commandsReply`／`aifaReply`／`irReply`。做法與限制：

- **路徑**：每台設備在讀取時決定一次 `route`，之後只依它分流。
  - `commands`：H1 的 `POST /devices/{id}/commands`，行為不變。
  - `aifa`：AIFA 冷氣不是中控的設備，只在 `GET /integrations/aifa` 的子設備裡（`type "0"`、`sub_type "0"`）。HomeBridge 每次和 `/home` 同時讀這份清單並合併；房間只能經 `matched_device_id` 得知，對不到就沒有房間。清單讀不到時燈照樣能控制，「找不到冷氣」會加註「AIFA 冷氣清單讀不到」。清單裡的 `online` 最多是 24 小時前的，所以查詢時不說在線（「狀態未知」）；離線要帶那次讀清單的時間（「上次讀取 AIFA 清單時離線（12:20）」），不說成現在離線，清單沒有讀取時間就說「狀態未知」。
  - `infrared`：Tuya 紅外線家電（`config.infrared_virtual`）。中控對它們的 `configured` 永遠是 false，只看 `infrared.ready`。
  - `unsupported`：不是 AIFA 的冷氣（Tuya `kt`／`ktkzq`、Home Assistant `climate.*`）、中控設備裡的 AIFA 控制器本身、紅外線控制器本身（`wnykq`，「請說要控制的家電名稱」）、無線按鈕、AIFA 的非冷氣家電。
  - 判斷順序是紅外線先，所以紅外線的冷氣遙控不會拿到 AIFA 的溫度設定：對它說 `ac_temperature` 會被拒絕，只能 `press` 它的鍵。
- **AIFA 開關**：`POST …/children/{c}/power {"power":bool}`。
- **AIFA 設定**：中控的 `/climate` 要完整的模式、溫度、風量、擺風。HomeBridge 先 `POST …/status` 讀控制器記得的設定，缺的項目用預設值（冷氣、26 度、風量自動、擺風自動；特殊功能沒回報時用一般），結果的 `defaults_used` 列出用了哪些預設，模型要說出來。特殊功能（睡眠、強力）照回報保留，不會被清掉。
  - 冷氣關著時中控回報的模式與溫度是 null，所以「改除濕」會用預設的 26 度；結果帶 `note`「這個設定不代表會開機」，不說成開了冷氣。
  - 「開冷氣 26 度」是兩次工具呼叫：先開關，再設定溫度，兩個結果都照說。
  - 風量調大／調小依控制器回報的目前風量調一格；回報是自動或沒有回報時不送，請使用者說低、中、高或自動；已經最低／最高也照實說。
  - 範圍與模式照那台冷氣的 `capabilities`（17–30 度，自動／冷氣／除濕）。設定碼不是 173 的冷氣只有開關，設定在送出前就拒絕。
- **紅外線按鍵**：`POST /devices/{id}/infrared-commands {key, key_id}`，一次一個鍵，不連按。按鍵在 `control()` 時就選好，確認卡寫的是真正的鍵名（「按下「Vol+」鍵」）。
  - 比對：按鍵名稱正規化（NFKC、小寫、加→+、減→-、減號 −→-、▲→+、▼→-、去掉空白與底線）後，意圖照同義詞表完全相同比對，再比對完全相同的按鍵名稱，**不找包含的**（「volume_up」不能落到導覽的「Up」，在冷氣遙控上那可能是溫度鍵）；開先找開機鍵、關先找關機鍵，沒有才按電源切換鍵。電源切換鍵與靜音鍵都是切換鍵（`toggle`，只說「按下「Power」鍵」，不說已開、已關、已靜音或已取消靜音；`mute false` 按的也是同一個靜音鍵）。其他說法當成按鍵名稱：先完全相同，再找唯一包含它的。好幾個不同的鍵（`key` 與 `key_id` 一起比，中控的 `key_id` 預設是 0）就問要按哪一個；找不到就說沒有這個鍵，列出最多 8 個真的有的鍵。同義詞表刻意不收「auto／低／on／高」這類字（在紅外線冷氣遙控上它們是模式鍵）。
  - 按鍵沒同步或超過 24 小時：不送出，請使用者在中控的紅外線控制器按「同步」。AIOS 不呼叫紅外線同步（中控同步失敗時會清掉那台的按鍵）。
- **結果**：AIFA 與紅外線都沒有回讀，永遠不是 `confirmed`。`unconfirmed` 的 `why`：`one_way`＝已送出、請使用者看一下；`cloud_no_reply`＝紅外線雲端沒回覆、不確定有沒有送出（中控不會自動重送）；`no_reply`＝中控沒回覆或紀錄還在處理中。AIFA 的 `controller_reported` 只說成「控制器回報…」，那是控制器記得的設定，不是冷氣的狀態。中控回 200 `failed` 照實說失敗。
- **AIFA 清單 24 小時**：清單超過 24 小時減 10 分鐘，或中控回 409「請先重新讀取 AIFA 家電清單」時，`POST /integrations/aifa/discover` 一次（每個指令最多一次），再用同一把 key 送出或重送。重新讀取失敗就說沒有送出；中控說一分鐘內有人讀過（429）就照樣送出，由中控決定，中控仍說過期時回 `not_ready`、`retry_after_s: 60`。重新讀取後再確認這台冷氣還在。
- **重送**：每個指令最多兩次 POST，同一把 key 與內容。唯一的一次重送給：逾時、5xx 或連線問題；中控冷卻 429（AIFA 全域 2 秒、紅外線每個控制器 1 秒；中控在記下 key 之前就拒絕，所以等 2.2／1.2 秒再送是安全的）；清單過期 409（重新讀取後）。第二次仍是冷卻就回 `rate_limited`。第一次可能已經送到時，第二次的「沒有送出」不採信，回報不確定。
- **時間**：每句話最多 60 秒（`UTTERANCE_MS`），每一步的逾時都被它截短；剩不到 5 秒就不再開始 POST（第一次之前：沒有送出；之後：不確定有沒有執行）。逾時：讀清單 8 秒、`/status` 22 秒、AIFA 重新讀取 25 秒、AIFA 送出 16 秒＋重送 12 秒、紅外線送出 16 秒＋重送 10 秒。最壞時間的算法見驗證文件；H1 的 `/commands` 最壞 55 秒，不會被截到。
- **共用**：每分鐘 6 個指令的上限三條路徑共用，每個意圖在第一次控制 POST 之前才算一次：沒有 POST 就拒絕的（清單重新讀取失敗、冷氣設定組不出來、已經最低、時間不夠）不算，`/discover`、`/status` 與各種重送也不算。確認卡流程（測試專用的 `policyFor`）在每條路徑都能用。問是哪一台時，AIFA 冷氣與紅外線家電的候選一律加上路徑（「冷氣（AIFA）」「客廳的冷氣（紅外線遙控）」），結果帶 `note` 請模型照抄候選名稱；AIFA 冷氣常常沒有房間，所以只看名稱分不出來。使用者照著回答就能選到那一台；名稱只對到另一條路徑的設備時，以括號裡的路徑為準。

驗證見 [`docs/validation/smarthome-h1b-2026-10-22.md`](./validation/smarthome-h1b-2026-10-22.md)：假中控測試、時間預算，以及真實中控程式（示例配置，沒有 AIFA 帳號與 Tuya 認證，冷氣與紅外線的清單、按鍵是寫進中控的 fixture）。尚缺：George 家裡的實機語音控制、記下他家紅外線家電真正的按鍵名稱。

**H1 實作對照（2026-10-22）**：`HomeBridge.control`／`confirm`（`server/home-bridge.ts`）、`POST /api/home/control`、`POST /api/home/confirm`、即時語音的 `home_control` 工具、家電確認卡與字幕錨點。做法與限制：

- 指令：開關、亮度、燈的色溫（工具參數叫 `color_temperature`，單位 K，送到中控時才是 `temperature`）、顏色、音量、靜音、播放／暫停／停止、窗簾。**H1 時冷氣與紅外線設備不支援**（冷氣與紅外線走中控的專用路徑，H1b 已補上，見上）：HomeBridge 依中控 `/home` 的欄位判斷冷氣（AIFA、Tuya 類別 `kt`／`ktkzq`、Home Assistant 的 `climate.*` 實體）與紅外線家電，不送出，回 `refused`／`unsupported` 並照實說是冷氣或紅外線設備；其他 `kind: remote` 的設備（例如 Tuya `wxkg` 無線按鈕）說這類設備還不能用語音控制，不說成紅外線或冷氣。工具說明與模型指示說的是同一件事：冷氣（開關與溫度）、紅外線設備與無線按鈕還不能用語音控制。
- 一次一台：說房間或全家（即使房間裡只有一台）一律回 `ambiguous` 請使用者指定，房間指令留給 H3。
- 結果照 §2 的狀態詞：只有 `confirmed` 是成功；`unconfirmed` 帶 `why`（`hub_unverified`＝中控送出但設備沒確認，`no_reply`＝兩次逾時、不確定有沒有執行）；`failed` 帶原因；沒有送出時是 `refused` 加原因（未完成接入、狀態未更新、不支援、數值不合、每分鐘 6 個上限、不開放語音、沒有確認、確認卡失效）。中控回傳 `accepted`／`sent` 或不認得的狀態一律當成未確認。
- 中控回 409 `state_stale`（上一次回讀逾時後設備被標成過期）時，自動 `POST /devices/{id}/refresh` 一次，再用同一把 key 重送；中控在記下 key 之前就回 409，所以不會執行兩次。仍不能控制就回報「狀態還沒更新，指令沒有送出」。不在 AIOS 端用 `can_control`／`state.commands` 先拒絕，因為回讀逾時後 `commands` 是空的，會被誤說成不支援。
- 時間：先讀 `/home` 等 8 秒；每次送出等 16 秒；重新讀取等 15 秒。整個指令只有一次同 key 重送，逾時等錯誤與 `state_stale`（重新讀取後）共用，所以最多兩次 POST。最壞 8 + 16 + 15 + 16 = 55 秒；確認卡同意後不再讀 `/home`，最壞 47 秒（算法見驗證文件）。模型先說一句「好，我請中控處理」，字幕顯示「控制中：設備」。
- 確認卡流程已接好，但 H1 沒有任何設備會觸發：只能用測試專用的 `policyFor` 選項，`.env` 與設定檔都不能開。H2 改讀中控的 `voice` 設定。確認卡的答案交給本機核心（不送 OpenAI），確認後的結果以系統通知轉告；伺服器端的確認 ID 只能用一次、綁定設備與指令、90 秒失效；`needs_confirmation` 帶 `expires_in_s`，確認卡倒數取 60 秒與它的較小值。已經有確認卡（MCP 或家電）開著或排隊時，家電卡不排隊：本機核心丟掉這張，模型拿到 `busy`，請使用者先回答那張卡再說一次。

驗證見 [`docs/validation/smarthome-h1-2026-10-22.md`](./validation/smarthome-h1-2026-10-22.md)：假中控測試與真實中控程式（示例配置，沒有真實設備）。本文件狀態列另記家中開關燈口頭確認；仍缺完整逐項設備結果、量測與 §3 的大圖示結果畫面，不改寫原批次測試範圍。

**H0 實作對照（2026-10-21）**：`prototype/ambient-shell/server/home-bridge.ts`（設定、讀 `GET /api/v1/home`、本機名稱比對、讀值整理）、`POST /api/home/status`、即時語音的 `home_status` 工具與字幕錨點。每次查詢都向中控取最新資料，不快取讀值。驗證見 [`docs/validation/smarthome-h0-2026-10-21.md`](./validation/smarthome-h0-2026-10-21.md)。後續家中查溫度的 log 與口頭結果見 [live 語音 §4](./validation/live-voice-2026-10-23.md#4-真實結果george-家中測試)；仍缺完整量測與 §3 的大數字錨點畫面。

## 7. 測試

- **假中控**：
  - 用 Node 的假 HTTP 伺服器模擬 `/devices`、`/commands`、`/events`。
  - 涵蓋 `confirmed`、`unconfirmed`、`failed`、逾時、同鍵重送 409、SSE 重播。
  - H1b：`GET /integrations/aifa`、`/discover`、`…/status`、`…/power`、`…/climate`、`/infrared-commands`；清單過期、冷卻 429、200 `failed`、409 字串、雲端沒回覆、缺鍵；假時鐘測 60 秒上限；所有冷氣與紅外線的結果都不是 `confirmed`。
- **語音工具**：
  - 用 RealtimeVoice 的假資料通道測工具呼叫、確認卡、固定語句、取消、逾時。
  - 確認「好」不會送出指令。
- **隱私**：權杖不出現在前端回應、OpenAI 工作階段 body、log。
- **實機**（George）：
  - 至少一台 LIFX 或 Tuya 燈（雙向回讀）。
  - AIFA 冷氣：開關、設定溫度、模式、風量（單向，`unconfirmed`）。
  - 紅外線家電（電視、電風扇）：只按遙控鍵（單向，`unconfirmed`）；紅外線遙控的冷氣也只按鍵，不設定溫度。
  - 一個溫濕度感測器（讀值與時間）。

## 8. George 的決定（2026-10-21）

1. **部署**：目前 AIOS 與中控在同一台 Mac；之後分開時，只改 `SMARTHOME_URL` 的 IP 就要能用（§1）。
2. **確認**：預設不需要確認；之後可逐台設成「需確認」（§1 第 6 點、§2）。
3. **高風險設備**：一樣開放語音；之後可逐台設成「關閉語音」。第 2、3 點合成同一個設定，**做在中控**，不在 AIOS（中控 P0-2）。
4. **沒人在家時的家電事件通知**：先不處理。
