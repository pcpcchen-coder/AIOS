<!-- bilingual: source=zh-TW -->

> [繁體中文](home-corner-2026-11-07.md) | [English](home-corner-2026-11-07.en.md)

# 左上角家中狀態 HOME-1 與日期放大（2026-11-07）

> **2026-11-07 後續變更：** 角落不再顯示冷氣，也不再在背景讀冷氣的控制器回報，見[後續紀錄](day-night-badge-2026-11-07.md)。下文關於冷氣的部分是當時的實作。

George 2026-11-07 要求：(1) 右上角時鐘的日期字放大，但仍比時間小；(2) 畫面左上角（電子腦上方）加一塊顯示家裡現在的開關、設備使用與室內溫度等，「要有智慧家庭的感覺」。

## 範圍與產品紅線

- 這是**環境狀態角落**，和右上角時鐘（[CLK-1](pi-clock-weather-2026-11-07.md)）同一種：被動讀數，不是 Surface、Dashboard 或 App 入口。沒有按鈕、不能點（`pointer-events: none`）、不能控制、不搶焦點；範圍固定只有室內讀值、燈與插座的數量、冷氣，不會再加其他資訊卡。
- 容器帶 `data-visibility-reason="user_setting:home_corner"`：只有使用者在設定打開了這個角落（Mac 視窗、Pi 終端機各一個開關）才出現；關掉時整個從頁面移除。
- 唯讀：核心只讀武陵居中控的快照，不送任何控制指令、不寫中控的資料。冷氣的控制器回報用中控的 `POST …/status`（中控文件標為唯讀：沒有 body、沒有冷卻、不算控制的速率限制）。
- 誠實：每個數字都來自中控的回報。中控沒有回報的開關顯示「—」，沒有讀值的感測器顯示「—」，不補 0、不猜；快照、過期資料或超過 10 分鐘的讀值標出時間（小畫面也標）；不同感測器的讀值不合在一起說，各自帶房間與時間；中控未設定說「智慧家庭未設定」，讀不到說「讀不到中控」加上原因，不沿用舊的數字。

## 日期放大（CLK-1 的調整）

| 項目 | 之前 | 現在 |
| --- | --- | --- |
| 日期 `.clock-date` | `clamp(.85rem, 1.6vh, 1.15rem)`（和天氣文字共用 `--clock-date-size`） | `clamp(1.15rem, 2.4vh, 1.9rem)`（自己的字級） |
| 時間 `.clock-time` | `clamp(2rem, 4.4vh, 3.6rem)` | 不變 |
| 天氣狀況、第二行 | `--clock-date-size` | 不變 |
| 小畫面（寬 ≤ 900 或高 ≤ 600）日期 | `0.8rem`（時間 `1.5rem`） | `0.95rem`（時間不變） |

日期的最小值、隨高度變化的比例與最大值三項都小於時間（1.15 < 2 rem、2.4 < 4.4 vh、1.9 < 3.6 rem），所以每個畫面高度日期都比時間小。`tests/home-corner.test.ts` 從 `src/style.css` 讀出兩個 `clamp`，在 300–3000 px 高度每 10 px 計算一次確認；1080 px 高時日期是 25.92 px、時間 47.52 px（無頭 Chromium 量到的值相同）。

## 預設值

| 項目 | 預設 | 理由 |
| --- | --- | --- |
| Mac 視窗（主視窗與不帶 `?terminal=` 的頁面） | 關 | 和右上角時鐘相同 |
| Pi 終端機（帶 `?terminal=` 的頁面） | 開 | 和右上角時鐘相同（時鐘在 Pi 預設開，要求是比照時鐘）。中控未設定時 Pi 只多一行灰字「智慧家庭未設定」，可在選單列或設定頁關掉 |

兩個開關存在 Mac 核心的 `configDir/home-corner.json`（只存改過的鍵，讀不懂時退回預設）。Pi 頁面的設定頁也顯示兩個開關。

## 資料來源與整理

`GET /api/home/overview`（沒有參數，GET 照現有的本機 Host 檢查）由核心的 `HomeOverview` 從 `HomeBridge` 的快照整理（`GET /api/v1/home` 與 `GET /api/v1/integrations/aifa`，和語音查家電同一份讀法）：

| 部分 | 怎麼算 |
| --- | --- |
| 室內讀值 | 溫度、濕度、CO₂、PM2.5 各取一台：即時優先，其次快照、過期資料、沒有讀值；同一級取中控收到時間最新的。回傳值、單位、精度、房間、狀態、年紀與 `sensor`（這次回應裡的感測器編號，不是設備 id；同一台的讀值編號相同）。年紀＝中控的 `server_time` − 中控收到讀值的時間，快取期間照樣往上加；中控沒給 `server_time` 時 `parseHome` 改用 Mac 的時間，年紀就受兩邊時鐘差影響。沒有讀值時 `value: null` |
| 燈與插座 | 走 H1 控制路徑的設備：`kind` 是 `light` 算燈；`switch`、`plug`、`outlet`、`socket` 算插座開關（Tuya 冷氣匯入成 `switch` 的不算，紅外線家電不算）。**開關只用中控 `/home` 的 `state.values.power`（布林；SmartHomeAI 的 observation 格式，舊格式 `state.power` 也接受）**，而且設備在線（`available: true`）才算。中控只把 90 秒內的讀值標成 `fresh`；較舊的讀值照樣採用，但用中控的 `state.age_seconds` 在同一行標出「最舊的讀值 N 分鐘前」，不知道多舊的就算「未知」。開著的名稱最多 4 個 |
| 冷氣 | AIFA 冷氣（最多 3 台）：只顯示**控制器回報**（控制器記得的設定，不是冷氣本身的狀態），而且 2 小時內的；沒有就「—」。回報來自三個地方：語音控制冷氣時中控回的 `controller_status`、調整冷氣設定前讀的狀態，以及這個角落在背景讀的 `POST …/status`。背景讀只讀角落會畫的前 3 台、而且 AIFA 清單沒說離線的；一次只讀一台；同一台 5 分鐘內讀過、語音控制過或正在讀就不讀；語音控制要讀的冷氣正在背景讀時，等那一次的結果，不送第二個請求；失敗就沒有新回報 |
| 快取 | 30 秒（成功與失敗都快取，中控掛掉時不會一直打）；同時只有一個快照請求；任何家電控制結束後下一次就重讀，控制結束前就開始的請求不拿來用（等它結束再讀一次）；控制後讀到的結果只快取 5 秒。頁面在家電控制有結果時立即重讀，8 秒後再讀一次（中控的開關狀態可能稍晚才更新） |
| 錯誤 | 未設定 → `{"configured": false}`；讀不到 → `state: "unreachable"` 與 `error`（`timeout`、`unreachable`、`auth`、`bad_response`），不帶中控原文 |
| 不外流 | 回應沒有設備 id、權杖、中控位址或原始回應；設備名稱最長 24 字；不寫 log |

回應的形狀（數值是 fixture）：

```json
{
  "configured": true,
  "state": "ok",
  "server_now": 1794053839043,
  "climate": [
    { "key": "temperature", "sensor": 0, "value": 25.8, "unit": "°C", "precision": 1, "room": "客廳", "status": "live", "age_s": 90 },
    { "key": "humidity", "sensor": 0, "value": 61, "unit": "%", "precision": 0, "room": "客廳", "status": "live", "age_s": 90 },
    { "key": "co2", "sensor": 1, "value": 812, "unit": "ppm", "precision": 0, "room": "書房", "status": "stale", "age_s": 10800 }
  ],
  "switches": [
    { "group": "light", "total": 6, "on": 3, "unknown": 1, "on_names": ["客廳主燈", "客廳立燈", "書桌燈"] },
    { "group": "switch", "total": 2, "on": 1, "unknown": 0, "on_names": ["延長線"] }
  ],
  "ac": [
    { "name": "客廳冷氣", "room": null, "power": true, "mode": "cool", "temperature": 26, "age_s": 60 }
  ]
}
```

## 角落

| 情況 | 畫面 |
| --- | --- |
| 有資料 | 溫度計圖示＋溫度大字、水滴圖示＋濕度（只畫溫度那台感測器的讀值）；下一行灰字「客廳 · CO₂ 640 ppm」（同一台）；別台感測器的讀值每台一行，帶自己的房間與時間，例如「書房 CO₂ 812 ppm · 3 小時前」；分隔線下每組一行：「燈 3／6 開著 · 1 個未知」（第二行開著的名稱）、「插座開關 1／2 開著」、「客廳冷氣 開 · 26° 冷氣」（第二行「控制器回報 · 1 分鐘前」） |
| 開關全部未知 | 「燈 —／8」 |
| 感測器沒有讀值 | 「—」 |
| 快照、過期資料、或超過 10 分鐘 | 灰字加「N 分鐘前」或「N 小時前」（小畫面也畫） |
| 從背景回來而畫面上的資料超過 2 分鐘，重讀還沒完成 | 數字淡化，最上方一行「更新中…」，讀完後恢復 |
| 冷氣沒有 2 小時內的回報 | 「客廳冷氣 —」 |
| 中控未設定 | 一行灰字「智慧家庭未設定」 |
| 讀不到中控 | 「讀不到中控」加一行原因（逾時、連不上、權杖被拒、回應錯誤）；不顯示舊數字 |
| 核心沒有回應（頁面的請求失敗或 15 秒逾時） | 「讀不到中控」·「核心沒有回應」 |
| 中控沒有任何可顯示的設備 | 「中控沒有可顯示的設備」 |

- 樣式：圓角 16px 的半透明深色卡片（漸層 `rgba(14,26,48,.5)` → `rgba(6,11,22,.38)`、細邊框 `rgba(110,210,255,.14)`、`backdrop-filter: blur(10px)`）；「這台裝置的畫面效能」關閉背景模糊（`perf-no-blur`）時改成不模糊的深色底。圖示是手繪 24×24 SVG（線寬 1.6、圓角端點，同天氣圖示的畫法）：溫度計 `--amber`、水滴 `--cyan`；燈開著時亮黃 `#ffd75c`、插座 `--mint`、冷氣 `--cyan`，都關著或不知道時灰色。
- 位置：`top: calc(max(14px, 2vh) - 8px)`、`left: calc(max(16px, 1.6vw) - 12px)`，`z-index: 6`（在 `.surface-root` 的 4 之上，所以 Surface 打開時整個收起，見下）；模擬模式或斷線的狀態列出現時排到它下方（`top: 48px`）。置中的記憶提示與腦區文字寬度同時扣掉時鐘與這個角落的寬度（`--home-reserve`）。Pi 4 頁面和時鐘一樣放大 1.5 倍（`transform-origin: top left`）。
- 對話或打字列開啟時降為 70% 不透明；Surface 打開時整個收起（`opacity: 0`、`visibility: hidden`），不會蓋到 Surface（1280 寬的 Pi 放大 1.5 倍時角落會伸到 Surface 左上角）；回憶模式時底色加深。
- 小畫面（寬 ≤ 900 或高 ≤ 600）：只省略房間、設備名稱與別台感測器那幾行；讀值的時間、「快照」「過期資料」與冷氣的「控制器回報 · N 分鐘前」照畫，舊資料不會看起來像即時的；「· 1 個未知」整段換行，不拆字。
- 排程：看得到時每 60 秒讀一次，頁面隱藏時暫停；回到前景、取得焦點或 `pageshow` 時重讀。請求最多等 15 秒，之後一定排下一次；請求中又要求重讀時，結束後立即再讀；家電控制有結果時立即重讀、8 秒後再讀一次。這些在 `src/home-feed.ts`（不碰 DOM）。
- 無障礙：容器 `aria-label`（例如「家中狀態：25.8°，濕度 61%，客廳 · CO₂ 640 ppm，燈 3／6 開著 · 1 個未知 · …」），不設 `aria-live`；圖示 `aria-hidden`。
- Pi 頁面經同一個 Mac 核心的 API（通道），不直接連中控；權杖只在 Mac 核心。

## 怎麼打開

- **Mac**：選單列「鏡頭與語音設定」→「左上角家中狀態」→ 勾選「Mac 視窗」；或設定頁的「左上角家中狀態」→「Mac 視窗」按「開」。
- **Pi**：預設開。要關：Mac 選單列取消「Pi 終端機」，或在 Pi 頁面的設定頁按「Pi 終端機」。
- 中控要先在 Mac 的 `.env` 設定 `SMARTHOME_URL`、`SMARTHOME_TOKEN`（同語音控制家電）。

## 做了什麼

| 部分 | 檔案（`prototype/ambient-shell/`） |
| --- | --- |
| 型別、文字、預設與畫面內容（純函式） | `shared/home-corner.ts` |
| 設定檔 `home-corner.json` | `server/home-corner-settings.ts` |
| 整理與快取 | `server/home-overview.ts` |
| 中控快照的唯讀入口、`state.values.power`、錯誤類別、冷氣回報的記錄與背景讀取 | `server/home-bridge.ts` |
| 路由 `GET /api/home/overview`、`POST /api/settings/home-corner`、`settings.home_corner` | `server/app.ts`、`server/nous.ts`、`shared/types.ts` |
| 角落、排程、圖示 | `src/home-corner.ts`、`src/home-feed.ts`、`src/home-icons.ts`、`src/main.ts`、`src/api.ts`、`src/style.css` |
| 設定頁（瀏覽器與 Mac App 兩條路徑） | `src/views.ts` |
| 選單列 | `desktop/settings-menu.mjs`、`desktop/settings-menu.d.mts`、`desktop/main.mjs` |
| 英文 | `shared/messages.en.json` |
| 日期字級 | `src/style.css` |

## 驗證

| 檢查 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `npx vitest run`（全部） | 160 個檔案通過；2978 通過、5 略過（共 2983） |
| 本批新增測試 | `tests/home-corner.test.ts` 44 個（含審查修正加的 11 個）；`tests/settings-view.test.ts` 加 2 個 |
| 更新的測試 | `tests/wake-flag-off.test.ts`：`settings.home_corner` 列為第六個不綁旗標的刻意例外，拿掉後其餘逐位元組相同，快照不更新 |
| `npm run build` | 通過 |

測試涵蓋：開關只算在線、有 `state.values.power`（或舊格式 `state.power`）的設備，不是最新的要有 `age_seconds` 並標出最舊的時間（不在線、沒回報、不知道多舊都算未知）；Tuya 冷氣與紅外線不算；室內讀值即時優先、過期的只補即時那台沒有的種類、年紀依中控時鐘加上快取時間；沒有讀值是 `null` 不是 0；冷氣回報 2 小時內才用；名稱最多 4 個、回應沒有 id；未設定不呼叫中控；同時兩個請求只讀一次、30 秒快取、控制後與過期後重讀；讀不到時的錯誤類別與快取；快照只有 GET；冷氣回報一次讀一台、5 分鐘內不重讀、失敗不留回報；背景讀只讀會畫的、沒離線的冷氣，跳過 5 分鐘內語音控制過的；語音控制要讀的冷氣正在背景讀時共用同一個請求；控制前開始的快照請求不拿來用、控制後的結果只快取 5 秒；頁面控制後 8 秒追讀；從背景回來資料超過 2 分鐘時標「更新中…」；不同感測器的讀值各自帶房間與時間（不把書房的 CO₂ 標成客廳）；小畫面的 CSS 不隱藏讀值時間與「控制器回報」；Surface 打開時角落 `opacity: 0` 與 `visibility: hidden`；中英文的每個畫面狀態；排程（60 秒、請求中再讀、暫停、逾時後說讀不到並丟掉舊數字）；角落 DOM（只在設定打開時掛上、`data-visibility-reason`、沒有按鈕、關閉時移除與清掉 CSS 變數、兩種灰字狀態）；`home-corner.json` 的預設、驗證、保存與重啟；選單列與頁面文字一致、勾選送出相反值、英文；設定頁兩條路徑的開關；日期字級在每個高度都比時間小；經真的核心入口（`startNous`）與假中控 HTTP 伺服器：未設定、`settings.home_corner` 依 `X-Nous-Terminal`、保存與 400、POST 不是 overview 的路由、權杖與中控位址不出現在回應、30 秒內只讀一次中控、log 沒有設備名稱。

### 無頭 Chromium 的畫面檢查（mock）

在雲端容器以 Playwright 內附的 Chromium 開啟 `vite build` 後的頁面，核心用**假中控（fixture HTTP 伺服器，設備與讀值是虛構的）**與假 Open-Meteo 回覆，模擬模式。檢查了 Mac 視窗 1920×1080（中文、英文）、Pi 4 頁面（`?terminal=rpi4`）1920×1080、1280×720 與 1024×600、中控未設定、讀不到中控（英文）。量到的角落外框不和時鐘或狀態列重疊，也不壓到電子腦的節點；1080 px 高時日期 25.92 px、時間 47.52 px。

審查修正後再用同一個 Chromium（`/opt/node-tools` 已安裝的 Playwright，沒有另外安裝）看 Pi 4 頁面：假中控只有一台 3 小時前的過期溫度與 CO₂（書房）和另一台即時濕度（客廳）。1024×600 時角落畫「30.1°」「CO₂ 812 ppm · 3 小時前」「主臥冷氣 開 · 26° 冷氣」「控制器回報 · 1 分鐘前」，省略房間、燈名與客廳濕度那行；1280×720 時另外畫「書房 · CO₂ 812 ppm · 3 小時前」「客廳 濕度 61%」與燈名。在頁面加上 `has-surface` 後角落的計算樣式是 `opacity: 0`、`visibility: hidden`。截圖只在開發環境，沒有放進 repo。這不是 Pi、Mac 或真實中控的驗證。

## 限制

- **開關欄位（2026-11-07 更正）。** 第一版讀 `state.power`，George 實測燈與插座全部顯示「—」。核對 SmartHomeAI 的 `backend/adapters.py`（`observation()` 把讀值放在 `values`）與 `backend/app.py` 的 `public()` 後，改讀 `state.values.power`。Tuya 多路開關的 `values.power` 是中控設定的第一路（`power_dps[0]`），不代表其他路。
- 冷氣只有控制器回報（控制器記得的設定），不是冷氣真的開著；畫面標「控制器回報」。背景讀取會經中控呼叫 AIFA 雲端，只讀畫面上的、沒離線的冷氣（最多 3 台），每台最多每 5 分鐘一次。
- 每種讀值只顯示一台感測器（即時、最新的那台），不是全家平均；和溫度不是同一台的讀值另起一行並標自己的房間。
- 中控沒有給 `server_time` 時，讀值年紀改用 Mac 的時間計算，會受兩邊時鐘差影響。
- Pi、Mac 與真實中控未驗證。

## Pi／Mac 實機步驟（未做）

1. Mac 更新核心（含本批程式），重新啟動 Nous；Pi：`systemctl --user restart aios-kiosk.service`。
2. Pi 上左上角出現卡片，溫濕度和中控網頁的同一台感測器一致；右上角日期比之前大、仍比時間小。
3. 用語音開關一盞燈：角落的燈數在一分鐘內跟著變（如果一直是「—」，記下中控 `/home` 的 `state` 欄位，回報開關欄位名稱）。
4. 用語音開冷氣：冷氣那行顯示「開」與「控制器回報 · N 分鐘前」。
5. 停掉中控：卡片變成「讀不到中控」，不顯示舊數字；恢復後一分鐘內回來。
6. 開啟語音對話：卡片變淡、不擋字幕；打開一個 Surface：卡片收起，關掉後回來；模擬模式的狀態列出現時卡片排在它下方。
7. Mac 選單列勾選「Mac 視窗」，Mac 視窗左上角出現；取消「Pi 終端機」，Pi 上消失。

## 回退

- 選單列或設定頁關掉「左上角家中狀態」的兩個開關即可隱藏，不需重新啟動。
- 需要移除程式時回退這個 PR；HomeBridge 新增的只是唯讀入口與記錄，語音查詢與控制的行為不變。

## 未完成

- 真實中控的開關欄位確認、Pi 與 Mac 實機未驗證。
- 下一個 gate：上面的實機步驟。
