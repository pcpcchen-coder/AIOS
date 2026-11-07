<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-clock-weather-2026-11-07.md) | [English](pi-clock-weather-2026-11-07.en.md)

# 右上角時鐘與天氣 CLK-1（2026-11-07）

George 2026-11-07 要求：Raspberry Pi 的畫面右上角顯示時間、日期、星期、氣溫與天氣，設計好看、有圖示。

## 範圍與產品紅線

- 這是**環境狀態角落**（和左上角的狀態列、右下角的鏡頭指示一樣的被動讀數），不是 Surface、Dashboard 或 App 入口：沒有按鈕、不能點（`pointer-events: none`）、不搶焦點，範圍固定只有時間、日期、星期與天氣，不會再加其他資訊卡。
- 容器帶 `data-visibility-reason="user_setting:clock_corner"`：只有使用者在設定打開了這個角落（Mac 視窗、Pi 終端機各一個開關）才出現。
- 誠實：天氣只來自核心的 `GET /api/weather/now`（Open-Meteo，CC BY 4.0）；查不到照實說「天氣暫時無法取得」，沒有地點時說「設定天氣地點後顯示天氣」，不畫猜的天氣。沒有「現在」的氣溫時只畫今天的最低／最高，天氣文字標「今日」，不說成現在。

## George 決定的預設值（2026-11-07）

| 項目 | 預設 |
| --- | --- |
| Mac 視窗（主視窗與不帶 `?terminal=` 的瀏覽器頁面） | 關 |
| Pi 終端機（帶 `?terminal=` 的頁面） | 開 |
| 回憶模式播放照片時 | 時鐘留在照片上方（z-index 6 > 照片 5），加深色底 `rgba(3,5,11,.55)`、圓角 14px |

兩個開關存在 Mac 核心的同一個 `clock.json`。Pi 頁面的設定頁也顯示兩個開關，所以在 Pi 上也能關掉 Mac 視窗的時鐘；Mac 上用一般瀏覽器開的頁面（沒有 `?terminal=`）算「Mac 視窗」。

## 做了什麼

| 部分 | 內容 | 檔案（`prototype/ambient-shell/`） |
| --- | --- | --- |
| 天氣資料 | Open-Meteo 請求多加 `current=temperature_2m,weather_code,is_day`（只多欄位，主機與地點不變）；`parseCurrent` 驗證時間是今天、氣溫在 −60～60、`is_day` 是 0／1，否則 `now: null`。招呼念的那一句不變 | `server/weather.ts`、`shared/proactive.ts` |
| 唯讀 API | `GET /api/weather/now`，沒有參數：地點同「主動提醒」的天氣地點（選的或依系統時區推的），和招呼共用 30 分鐘快取；回應 `time_zone`、`server_now`、`place`（名稱依 `X-Nous-Locale`）、`state`（ok／failed／none／no_place）、`weather`、`attribution`。不受「說今天的天氣」開關影響 | `server/weather.ts` 的 `weatherNowView`、`server/app.ts`、`server/nous.ts` |
| 設定 | `configDir/clock.json`（`{main, terminal}`，只存改過的鍵）；`settings.clock` 依頁面來源給 `enabled`；`POST /api/settings/clock` 逐鍵驗證（400） | `server/clock-settings.ts`、`shared/clock.ts` |
| 選單列與設定頁 | 「右上角時鐘與天氣」分段：「Mac 視窗」「Pi 終端機」兩個勾選；設定頁（Mac App 與 Pi／瀏覽器）同樣兩個開關與資料出處 | `desktop/settings-menu.mjs`、`desktop/main.mjs`、`src/views.ts` |
| 角落 | 時間 24 小時制 HH:mm、日期（中文「11月7日 週六」、英文「Sat, Nov 7」）、天氣列（圖示＋氣溫＋天氣）、第二行「台北 · 18°–26° · 降雨 20%」 | `src/clock-corner.ts`、`src/clock-feed.ts`、`src/style.css`、`src/main.ts`、`src/api.ts` |
| 圖示 | 手繪 24×24 SVG，線寬 1.6、圓角端點，12 種（晴、晴時多雲、多雲、陰、霧、毛毛雨、凍雨、雨、大雨、陣雨、雪、雷雨），晴／晴時多雲／多雲／陣雨有夜晚版（月亮）；雲擋住太陽的部分用遮罩挖掉。顏色：太陽 `--amber`、月亮 `#c9d6ff`、雲 `#b8c7d9`、雨 `--cyan`、雪 `--text`、閃電 `#ffd75c`、霧 `--muted` | `src/weather-icons.ts` |
| 文字 | 兩種語言共用翻譯表 `shared/messages.en.json`；天氣狀況中英文在 `shared/clock.ts` 的 WMO 表 | `shared/clock.ts` |

### 時間與時區

- 時間一律用核心給的時區格式化（地點的時區；沒有地點時 Mac 核心的系統時區），**不用 Pi 自己的時區**。
- 核心時間以請求來回的中點錨定在頁面的單調時鐘（`performance.now()`）上：現在＝核心時間＋之後經過的單調時間。Pi 牆上時鐘和它差超過 60 秒時用核心時間，60 秒內用牆上時鐘（不跟著網路抖動）。每次重畫都重新比較，所以 Pi 之後對時（fake-hwclock → NTP 跳動）會立即改回牆上時鐘，偏移不會算兩次；兩次重畫之間牆上時鐘與單調時鐘走的差距超過 30 秒（睡眠、對時）時立即重新向核心對時。
- 每分鐘只重寫一次：對齊下一個整分（多 50 ms），沒有每秒的計時器；只在文字改變時寫入。回到前景、取得焦點或 `pageshow` 時立即重畫並重讀，睡眠後不顯示舊時間。
- 天氣每 15 分鐘讀一次（核心另有 30 分鐘快取），頁面隱藏時暫停。每個請求最多等 10 秒（逾時中止，就算請求不理會中止也放手），之後一定排下一次；請求進行中又要求重讀（例如換介面語言，地點名稱依語言）時，這次結束後立即再讀一次。
- 核心還沒回應過（不知道時區）或請求失敗時不顯示新的資料，每 60 秒再試。
- 這些排程與計算在 `src/clock-feed.ts`（不碰 DOM，可在 node 用假計時器測試）；`src/clock-corner.ts` 只負責畫與事件。

### 天氣的狀態

| 情況 | 畫面 |
| --- | --- |
| 有現在的資料 | 圖示＋現在氣溫＋天氣，第二行地點、今天範圍、降雨機率。「現在」來自核心 30 分鐘快取，日出、日落前後的白天／夜晚圖示（`is_day`）可能晚約 30 分鐘才換 |
| 資料超過 45 分鐘 | 加一行灰字「N 分鐘前」 |
| 回覆沒有現在的氣溫 | 今天的「18°–26°」＋白天版圖示，天氣標「今日晴」 |
| 查詢失敗或核心連不上 | 沿用頁面上一次的資料並標「N 分鐘前」，最多 2 小時且同一天；之後只剩灰字「天氣暫時無法取得」 |
| 過了午夜 | 不論核心或頁面的資料，昨天的範圍與「今日」立即不畫（核心的資料也要是今天、2 小時內），並立即重讀 |
| Open-Meteo 一直失敗 | 核心失敗後 2 分鐘內不再查同一個地點（右上角時鐘、招呼與工具都一樣），回快取裡仍可用的資料或「查不到」 |
| 沒有地點 | 灰字「設定天氣地點後顯示天氣」 |
| 不認得的天氣代碼 | 只畫氣溫，不畫圖示與天氣文字 |

### 版面

- 位置：文字的上緣與右緣在 `max(14px, 2vh)`、`max(16px, 1.6vw)`（容器本身是 `top: calc(max(14px, 2vh) - 8px)`、`right: calc(max(16px, 1.6vw) - 12px)`，加 8px／12px 內距，讓回憶模式的深色底不移動文字），`z-index: 6`，靠右對齊、等寬數字、固定最小寬度。
- 字級：時間 `clamp(2rem, 4.4vh, 3.6rem)`、粗細 300；日期 `clamp(.85rem, 1.6vh, 1.15rem)`；圖示 `clamp(28px, 4.2vh, 46px)`；氣溫 `clamp(1.25rem, 2.6vh, 1.9rem)`；第二行為日期的 0.9 倍。文字陰影 `0 1px 12px rgba(0,0,0,.6)`，不用 backdrop-filter（Pi 效能）。
- 語音狀態膠囊原本也在右上角（`top: 14px`），有時鐘時改排在時鐘下方並與時鐘右緣對齊；置中的記憶提示與腦區活動文字寬度扣掉時鐘的寬度（`--clock-reserve`，時鐘大小或視窗寬度改變時重算）。
- 對話、Surface 或打字列開啟時時鐘降為 70% 不透明。
- 小畫面（寬 ≤ 900 或高 ≤ 600）：時間與日期同一行，天氣只留圖示與氣溫，寬度 ≤ 180px。
- 無障礙：容器有 `aria-label`（例如「時間、日期與天氣：09:05，11月7日 週六，24°，多雲，台北 · 18°–26° · 降雨 20%」），不設 `aria-live`（每分鐘的變化不朗讀）；圖示 `aria-hidden`。減少動態時天氣淡入（300 ms）取消。

## 和計畫的差異

- `index.html` 沒有改：角落在 `src/clock-corner.ts` 動態建立（和回憶模式的 `#memories` 相同），設定關閉時整個移除。
- 降雨文字用「降雨 20%」（計畫寫「雨 20%」），避免和天氣「雨」混淆。
- 第二行開頭多放地點名稱（API 本來就給名稱），讓人知道是哪裡的天氣。
- 沒有現在的氣溫時，天氣文字加「今日」（例如「今日晴」／“Today: clear”），更明確不是現在的天氣。
- 語音膠囊放在時鐘下方 8px（以量測到的時鐘底緣為準），並和時鐘右緣對齊。

## 驗證

| 檢查 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `npx vitest run`（全部） | 158 個檔案通過；2882 通過、5 略過（共 2887） |
| 本批新增測試 | `tests/clock-format.test.ts`、`tests/weather-icons.test.ts`、`tests/weather-now-http.test.ts`、`tests/clock-settings.test.ts`、`tests/clock-feed.test.ts`，共 38 個 |
| 更新的測試 | `tests/proactive.test.ts`（請求網址多了 `current`、`parseForecast` 多了 `now`）；`tests/wake-flag-off.test.ts`（`settings.clock` 列為第五個不綁旗標的刻意例外，拿掉後其餘逐位元組相同，快照不更新） |
| `npm run build` | 通過 |

測試涵蓋：台北時區的固定時刻（中英文）、台北午夜與 UTC 午夜換日、到下一個整分的等待、時鐘偏差（60 秒門檻、單調時鐘錨點、Pi 之後對時不重複校正）、午夜後不用昨天的資料（核心或頁面）、天氣列每個狀態、四捨五入與不顯示 −0°；全部 28 個 WMO 代碼的圖示、白天／夜晚、不認得的代碼不畫；`current` 區塊無效或不是今天時丟掉但保留整天的值；`weatherNowView`（ok、沒有 current、失敗但有 2 小時內快取、失敗沒有快取、沒有地點、名稱依語言、30 分鐘內不重查）；經真的核心入口（`startNous`）的 HTTP：GET 唯讀、查詢參數不能指定地點或網址、POST 不是路由、`settings.clock` 依 `X-Nous-Terminal` 給 `enabled`、POST 驗證與英文錯誤；`ClockFeed`（卡住的請求 10 秒後放手並照排下一次、請求中換語言結束後再讀、午夜立即重讀、牆上時鐘跳動後重新對時、暫停與恢復）；Open-Meteo 失敗後 2 分鐘冷卻；`clock.json` 的預設、保存、重啟與壞鍵；選單列文字與頁面一致、勾選送出相反值、英文翻譯。

### 無頭 Chromium 的畫面檢查（mock）

在雲端容器以 Playwright 內附的 Chromium 開啟 `vite build` 後的 Pi 頁面（`/?terminal=pi`），核心用**假的 Open-Meteo 回覆（fixture，不連網）**，地點台北，模擬模式（未呼叫 AI 模型）。檢查了 1920×1080 與 1280×720、中文與英文、回憶模式播放照片時（亮色測試圖片）、夜晚的雨、沒有現在氣溫、查詢失敗、雷雨在 800×480 小畫面、打字列開啟時降低不透明度、語音膠囊排在時鐘下方。截圖只在開發環境，沒有放進 repo。這不是 Pi 實機或真實天氣的驗證。

## Pi 實機步驟（未做）

1. Mac 更新核心（含本批程式），重新啟動 Nous。
2. Pi：`systemctl --user restart aios-kiosk.service`。
3. 在 1920×1080 確認：時間和 Mac 一致；日期與星期正確；天氣和 [Open-Meteo](https://open-meteo.com/) 同一地點一致；切換 English／繁體中文。
4. 回憶模式播放時時鐘仍清楚可讀。
5. 開啟語音對話，語音膠囊在時鐘下方、不重疊。
6. 拔掉 Mac 網路超過 2 小時（或用假時鐘）：先顯示「N 分鐘前」，之後只剩「天氣暫時無法取得」。
7. 選單列取消「Pi 終端機」，Pi 上的時鐘消失。
8. 選做：1280×720。
9. 若 Pi 與 Mac 的時間差很多：Mac 在「系統設定」→「一般」→「日期與時間」確認自動設定時間已開啟；Pi 執行 `timedatectl status` 確認 NTP 已同步。頁面差超過 60 秒時會改用 Mac 核心的時間。

## 回退

- 選單列「右上角時鐘與天氣」取消「Pi 終端機」（或設定頁關閉）即可隱藏，不需重新啟動。
- 需要移除程式時回退這個 PR；Open-Meteo 請求多的 `current` 欄位是附加的，招呼的天氣句不受影響。

## 未完成

- Pi 與 Mac 實機未驗證；真實 Open-Meteo 回覆未驗證（只有 fixture）。
- 頁面的角落元件沒有 DOM 單元測試（測試環境沒有 DOM），由純函式測試與無頭 Chromium 的 mock 畫面檢查涵蓋。
- 下一個 gate：上面的 Pi 實機步驟。
