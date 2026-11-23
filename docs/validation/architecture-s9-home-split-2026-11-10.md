<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s9-home-split-2026-11-10.md) | [English](architecture-s9-home-split-2026-11-10.en.md)

# 架構重整 S9：`home-bridge.ts` 拆成 `server/home/`（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §P1-4 與 §3 的 S9；功能規格見 [12 智慧家庭整合](../12_SmartHome_Integration_Plan_2026-10.md) §6。George 於 2026-11-10 核准 S6–S9。這一批只搬動程式，**目標是行為完全不變**。全部是雲端容器裡的型別檢查與假中控（fixture）自動化測試，**不是產品 gate，沒有碰到真實的中控、冷氣、紅外線家電或燈**。

## 1. 環境

- 分支 `claude/arch-s9-home-split`，基準是 main `1b61d08`。
- Linux 雲端容器、Node.js v22.23.4、vitest 5.0.3。`prototype/ambient-shell/node_modules` 是指向主要 checkout 的符號連結，沒有提交。
- 沒有武陵居中控、AIFA 冷氣、紅外線控制器、燈、Mac 或 Pi；沒有任何真實帳號或權杖。測試裡的權杖與設備都是虛構的 fixture。

## 2. 做了什麼

`prototype/ambient-shell/server/home-bridge.ts`（1,654 行，`wc -l`）拆成資料夾 `server/home/` 的 7 個檔；`server/home-bridge.ts` 留下來當只做重新匯出的入口（barrel，36 行），所以 4 個 importer（`server/app.ts`、`server/nous.ts`、`server/home-overview.ts`、`server/integrations/adapters/home.ts`）與所有測試的 import 路徑都沒有改，這 4 個檔本身也沒有修改。

搬移是用一支一次性的腳本依「舊檔行號區間」剪貼（沒有提交），不是手打，所以函式內容、註解、字串與模組層常數的值都逐字相同。`HomeBridge` 類別整個留在 `bridge.ts`，沒有把方法拆成獨立函式，也沒有改任何 `private` 成員。

### 2.1 檔案對照（舊檔行號 → 新檔）

行數是 `wc -l`。舊檔第 1–5 行是檔頭註解、第 7–35 行是 import。

| 新檔 | 行數 | 來自舊檔的行號 | 內容 |
|---|---|---|---|
| `server/home/types.ts` | 199 | 37、49–72、87–211、550–589、618 | `TIMEOUT_MS`、`H1B_TIMEOUTS_MS`、`COOLDOWN_WAIT_MS`、`UTTERANCE_MS`、`MIN_SEND_WINDOW_MS`；`HomeBridgeOptions`、`VoicePolicy`、`ControlRequest`、`HubMetric`、`HubDataStatus`、`IrKey`、`AifaClimateCaps`、`DeviceRoute`、`UnsupportedWhy`、`HubDevice`、`AifaListState`、`HubSnapshot`、`HomeBridgeErrorCode`、`HomeBridgeError`；`HubReply`、`ReplyMapper`、`ControllerReport`、`ClimateChange`、`ClimatePacket`、`Refusal` |
| `server/home/parse.ts` | 143 | 1517–1654 | `isRecord`、`str`、`num`、`dataStatus`、`TUYA_AIR_CON`、`UNSUPPORTED_TEXT`、`parseInfrared`、`routeOf`、`parseHome`、`reportedPowerValue`、`aifaId`、`parseCaps`、`parseAifa` |
| `server/home/readings.ts` | 92 | 213–230、235–263、477–514 | `METRICS`、`DATA_TEXT`、`norm`、`metricKey`、`splitMetric`、`clock`、`round`、`offline`、`report` |
| `server/home/aifa.ts` | 146 | 76–85、667–766、869–896 | `CLIMATE_DEFAULTS`、`NO_CLIMATE_TEXT`、`checkClimate`、`buildClimate`、`AC_OFF_TIMER_NOTE`、`AC_OFF_TIMER_NOTE_UNSURE`、`acOffTimerNote`、`reportedText`、`oneOf`、`parseReport`、`AIFA_STALE`、`AIFA_KEY_CONFLICT`、`aifaReply` |
| `server/home/infrared.ts` | 111 | 768–842、898–926 | `keyNorm`、`IR_SYNONYMS`、`SYNONYM_SETS`、`MAX_KEY_LABELS`、`matchKey`、`irReply` |
| `server/home/commands.ts` | 348 | 73–75、232–234、265–475、516–548、591–603、620–665、844–867 | `AIFA_LIST_TTL_S`、`AIFA_STALE_MARGIN_S`、`WHOLE_HOME`、`TRAILING`；`ON`／`OFF`、`toBool`、`toNumber`、`isCommandName`、`parseCommand`、`word`、冷氣用字表；`H1_COMMANDS`、`H1Command`、`isH1Command`、`toWire`；`names`、`Resolution`、`resolveTarget` 與其餘名稱比對；`ROUTE_TAG`、`TAGGED_NOTE`、`TV_MOVED`、`LIVING_TV`、`isTvName`、`isTvDevice`、`ambiguous`；`AifaRef`、`Plan`、`planFor`；`commandsReply` |
| `server/home/bridge.ts` | 637 | 38–47、605–616、928–1515 | 只有類別用的常數（`MAX_DEVICES`、`COMMAND_TIMEOUT_MS`、`REFRESH_TIMEOUT_MS`、`RATE_LIMIT`、`RATE_WINDOW_MS`、`CONFIRM_TTL_MS`、`MAX_PENDING`）、`PendingCommand`、`Entry`、`class HomeBridge`（整個，582 行）、`refusedConnection` |
| `server/home-bridge.ts`（入口） | 36 | 1–4（檔頭註解） | 只有 `export … from "./home/*.ts"` |
| 合計 | 1,712 | | 比舊檔多 58 行：各檔的 import、每檔一行檔頭註解、入口的重新匯出 |

舊檔第 37–1654 行除了空白行以外，每一行都剛好出現在一個新檔裡（§3.1）。

### 2.2 依賴方向（沒有環）

`types.ts` 只 import `shared/home.ts`。其餘：`parse.ts` → `types`；`readings.ts` → `types`；`aifa.ts` → `parse`、`types`；`infrared.ts` → `parse`、`types`；`commands.ts` → `aifa`、`infrared`、`parse`、`readings`、`types`；`bridge.ts` → 以上全部。`node scripts/architecture-metrics.mjs` 的 import 環仍是原本的 4 組，沒有新的。

### 2.3 與 23 §3 原文、與委派建議的差異

- 23 §3 寫的是 `server/home/{hub-client,parse,commands,aifa,infrared,bridge}.ts`。實際沒有 `hub-client.ts`：送出與讀取（`post`、`refresh`、`snapshot`、`home` 等）都是 `HomeBridge` 的 `private` 方法，這一批不拆類別。多了 `types.ts` 與 `readings.ts`。所以是 1 檔 → 入口加 7 檔，不是原文的 1 檔 → 7 檔。
- `HubReply`、`ControllerReport`、`ClimateChange`、`ClimatePacket`、`Refusal` 放在 `types.ts`，不放在 `aifa.ts`：`HubReply` 用到 `ControllerReport`，而 `aifa.ts`、`infrared.ts`、`commands.ts`、`bridge.ts` 都用 `HubReply`，放在 `aifa.ts` 會形成型別環。
- `norm`（名稱正規化）放在 `readings.ts`，`commands.ts` 的名稱比對與電視判斷 import 它；沒有為一個函式另開檔。
- `UNSUPPORTED_TEXT` 留在 `parse.ts`（原本就在解析器旁邊），`NO_CLIMATE_TEXT`、`AIFA_STALE` 留在 `aifa.ts`；`planFor` 與 `HomeBridge` 都用到它們。
- `commandsReply`（H1 的回覆對應）放在 `commands.ts`；`aifaReply` 在 `aifa.ts`、`irReply` 在 `infrared.ts`。
- 舊檔第 519–523 行的註解（說明候選名稱怎麼組）原本就隔著電視那一段才接到 `ambiguous()`；整段 516–548 一起搬，順序不變。

### 2.4 不是逐字搬移的地方（全部列出）

1. **24 個宣告加上 `export`**（只給資料夾內部用，入口沒有重新匯出）：`types.ts` 的 `TIMEOUT_MS`、`HubReply`、`ReplyMapper`、`Refusal`；`parse.ts` 的 `isRecord`、`str`、`num`、`UNSUPPORTED_TEXT`、`aifaId`；`readings.ts` 的 `METRICS`、`norm`、`splitMetric`；`aifa.ts` 的 `NO_CLIMATE_TEXT`、`checkClimate`、`acOffTimerNote`、`reportedText`、`parseReport`、`AIFA_STALE`；`commands.ts` 的 `toWire`、`H1Command`、`isTvDevice`、`ambiguous`、`AifaRef`、`commandsReply`。
2. **檔頭註解第 5 行改了一處**：舊檔是「三條控制路徑都在這個檔案：…」，拆檔後這句話不再是事實，入口改成「三條控制路徑都在 server/home/：…」，其餘逐字相同。
3. **新增 8 行註解**：7 個新檔各一行檔頭註解，入口一行說明它只重新匯出。
4. import 與 export 陳述式（各檔依實際用到的重新寫）。

程式碼本身（函式內容、常數值、字串、型別定義）沒有任何一行不同。

## 3. 驗證

### 3.1 逐字搬移的機械檢查（腳本沒有提交）

方法：舊檔（`git show main:prototype/ambient-shell/server/home-bridge.ts`）與新的 8 個檔（入口加 `server/home/*.ts`）各自去掉 import 陳述式、`export { … } from` 陳述式與空白行，把剩下的行當成多重集合（multiset）比較。

| 項目 | 結果 |
|---|---|
| 舊檔剩下的行數 | 1,494 |
| 新檔合計剩下的行數 | 1,502 |
| 只在舊檔出現 | 25 行 |
| 只在新檔出現 | 33 行 |
| 其中只差行首多一個 `export ` 的配對 | 24 對（§2.4 第 1 點列的 24 個宣告） |
| 扣掉後只在舊檔 | 1 行：舊的檔頭第 5 行 |
| 扣掉後只在新檔 | 9 行：改過的檔頭第 5 行，加上 §2.4 第 3 點的 8 行註解 |

也就是 1,494 行裡 1,469 行完全相同、24 行只多了 `export `、1 行是 §2.4 第 2 點的註解。這個檢查比較的是行的多重集合，不檢查行的先後；先後由「依行號區間剪貼」保證（每個區間內部順序不變），並由型別檢查與測試間接驗證。

### 3.2 匯出比對

用 `tsx` 分別 `import` 舊模組（解到暫存資料夾，`shared/` 用符號連結指向這個分支）與新的入口，比對 `Object.keys()`：

- 值的匯出：舊 24 個、新 24 個，名稱完全相同，沒有多也沒有少；每個的 `typeof` 相同；9 個不是函式的常數 `JSON.stringify` 相同。24 個是：`AC_OFF_TIMER_NOTE`、`AC_OFF_TIMER_NOTE_UNSURE`、`CLIMATE_DEFAULTS`、`COOLDOWN_WAIT_MS`、`H1B_TIMEOUTS_MS`、`HomeBridge`、`HomeBridgeError`、`IR_SYNONYMS`、`MIN_SEND_WINDOW_MS`、`TV_MOVED`、`UTTERANCE_MS`、`aifaReply`、`buildClimate`、`irReply`、`isTvName`、`keyNorm`、`matchKey`、`metricKey`、`parseAifa`、`parseCommand`、`parseHome`、`planFor`、`report`、`resolveTarget`。
- 型別的匯出：舊檔的 `export type`／`export interface` 共 18 個，與入口的 `type` 重新匯出逐一相同：`AifaClimateCaps`、`AifaListState`、`ClimateChange`、`ClimatePacket`、`ControlRequest`、`ControllerReport`、`DeviceRoute`、`HomeBridgeErrorCode`、`HomeBridgeOptions`、`HubDataStatus`、`HubDevice`、`HubMetric`、`HubSnapshot`、`IrKey`、`Plan`、`Resolution`、`UnsupportedWhy`、`VoicePolicy`。`npx tsc --noEmit` 通過，4 個 importer 與所有測試都沒有修改。
- `HomeBridgeError` 只有一個類別物件：入口匯出的與 `server/home/types.ts` 的是同一個（`===`），`instanceof` 在 `app.ts`、`home-overview.ts`、`adapters/home.ts` 照舊成立；`HomeBridge` 同理。

### 3.3 一次性的前後重播比對（沒有提交）

23 §3 的 S9 驗證條件是「假中控收到的請求序列逐位元組相同」。做法：一支暫時的 `tsx` 腳本，用同一個行程內的假 `fetch`（fixture 資料，不連網路）、固定的 `now`／`newId`／`sleep`，把同一串 44 個步驟分別跑在舊模組與新的入口上，記下每個請求的方法、路徑、標頭與 body，以及每一步的結果或丟出的錯誤。

- 步驟涵蓋：查詢（房間、讀值、全家、找不到）；H1 `/commands`（開關、亮度、色溫、候選、數值不合、未完成接入、不支援的冷氣、409 `state_stale` 後重送、5xx、未確認後重新讀取）；AIFA（關機、溫度、風量調大、超出範圍、暖氣、429 冷卻、清單過期後 `/discover`、非冷氣家電）；紅外線（音量、電源、沒有的鍵、429 冷卻、按鍵未同步）；電視改路；確認卡（需要確認、同意、重複同意、不存在的 ID）；政策關閉；連續 8 次觸發速率限制；401、資料格式不符、未設定。
- 結果：兩邊各 44 步、105 個請求（`GET /api/v1/home` 37、`GET /api/v1/integrations/aifa` 37、`POST …/commands` 15、`POST …/refresh` 1、AIFA `power` 5、`status` 2、`climate` 2、`discover` 1、`POST …/infrared-commands` 5）；結果的 `status` 分佈：`confirmed` 12、`unconfirmed` 10、`refused` 13、`ok` 3、`ambiguous` 1、`not_found` 1、`needs_confirmation` 1、丟出 `HomeBridgeError` 3。
- 兩邊「請求加結果」的 JSON 各 25,179 個字元，**完全相同**（SHA-256 前 16 碼都是 `b8b8f6e22289c2fe`）。

這支腳本依賴暫存資料夾裡的舊程式，跑完就不保留；可重現的證據是不經修改就通過的既有測試與 §3.4 的指令。

### 3.4 指令與結果

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過 |
| 單元與整合測試 | `npx vitest run` | 176 個測試檔通過；3,314 項中 3,308 項通過、6 項跳過；約 72 秒（文件寫完後再跑一次：3,309 項通過、5 項跳過，約 101 秒）。沒有新增或修改測試 |
| 其中指定的既有測試 | `npx vitest run tests/home-bridge.test.ts tests/integration-home-facade.test.ts tests/home-corner.test.ts tests/http.test.ts tests/realtime-*.test.ts` | 10 個檔、346 項全部通過：`home-bridge` 96、`home-corner` 42、`http` 27、`integration-home-facade` 18、`realtime-bridge` 8、`realtime-cost-guard-core` 14、`realtime-cost-guard` 30、`realtime-local-commands` 30、`realtime-routes` 38、`realtime-voice` 43 |
| 架構守門 | `tests/architecture.test.ts`（含在上面的全套） | 通過：跨層 import 0、沒有新的環 |
| 前端建置 | `npx vite build` | 通過；仍有 chunk 超過 500 kB 的警告（與基準相同） |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過：143 份、142 組完整配對、1 份 inline |
| 空白 | `git diff --check` | 通過 |
| 既有測試檔沒有修改 | `git diff --stat main -- prototype/ambient-shell/tests` | 沒有輸出 |

`node scripts/architecture-metrics.mjs`（main → 這個分支）：

| 指標 | 之前 | 之後 |
|---|---|---|
| 來源檔數／行數 | 246／67,693 | 253／67,758 |
| 超過 800 行的檔 | 16（含 `server/home-bridge.ts`，腳本算 1,655） | 15（`bridge.ts` 637 行，不在清單裡） |
| 跨層 import | 0 | 0 |
| import 環 | 4 組 | 同樣 4 組 |
| 沒有測試直接 import 的模組 | 26 | 33（多的 7 個就是 `server/home/*.ts`：測試仍然經 `server/home-bridge.ts` 入口 import，覆蓋的程式沒有變少） |

## 4. 限制

- **只有假中控 fixture**：`tests/home-bridge.test.ts` 的假中控 HTTP 伺服器與 §3.3 的假 `fetch`。**沒有對真實的武陵居中控、AIFA 冷氣、紅外線家電或燈送出任何指令**，也沒有在 Mac 或 Pi 上啟動過。
- H1 的家中開關燈先前由 George 口頭確認過；這一批雖然只搬程式，**合併後請 George 在家裡再確認一次開關燈**（最好也各試一次 AIFA 冷氣與紅外線按鍵）。在那之前，本紀錄只代表 fixture 測試通過。
- 這不是產品 gate；docs/12 的 H1、H1b 逐項設備結果與量測仍然沒有。
- §3.1 的機械檢查比較行的多重集合，不比較順序；§3.1 與 §3.3 的腳本都沒有提交，之後無法直接重跑。§3.3 的 44 個步驟是人工挑的，不是窮舉。
- 入口沒有重新匯出的 24 個內部符號（§2.4）仍然可以被別的檔直接從 `server/home/*.ts` import；目前沒有任何檔這樣做，也沒有守門測試擋它。
- `bridge.ts` 仍有 637 行，`HomeBridge` 類別沒有拆；要不要再拆（例如抽出送出與讀取）留給之後的批次決定。
- 全套測試的跳過數依環境而異（有的測試用 `describe.skipIf`）。
