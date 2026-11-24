<!-- bilingual: source=zh-TW -->

> [繁體中文](cap-2-commands-from-catalog-2026-11-24.md) | [English](cap-2-commands-from-catalog-2026-11-24.en.md)

# CAP-2 語音指令表改由能力總表產生：驗證

日期：2026-11-24（Asia/Taipei）。分支：`claude/cap-2-commands-from-catalog`，以 main 的 `c365f7d`（CAP-1，PR #152 合併）為基礎。範圍是 [24 §3.3](../24_Capability_Catalog_and_Skills_2026-11.md#33-批次) 的 CAP-2。

**這一批全部是雲端容器裡的 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收。** 沒有真實語音、沒有真實服務。語音行為、送給模型的工具 JSON、設定畫面都沒有變；`/help/commands` 與原型 README 只有「定時器與鬧鐘」一段改寫、新增「App 整合」一段。

## 1. 環境

| 項目 | 值 |
|---|---|
| 機器 | Linux 雲端容器（不是 Mac、不是 Pi） |
| Node | v22.23.5 |
| 安裝 | `prototype/ambient-shell` 執行 `npm ci`（沒有新增或升級套件） |
| 外部服務 | 沒有連任何服務；Adapter 的依賴都是測試替身 |

## 2. 交付內容

路徑在 `prototype/ambient-shell/` 底下。

| 項目 | 內容 |
|---|---|
| 資料流 | `shared/voice-commands.ts` 新增 `CatalogToolRow`（只有需要的欄位；`server/integrations/catalog.ts` 的 `CatalogEntry` 在結構上符合），`commandSections(ctx, catalog)` 與 `renderCommandsMarkdown(catalog)` 多一個參數。`shared/` 仍然沒有 import `server/`（[23](../23_Architecture_Review_2026-11.md) 的分層）：總表由 server 端傳進來 |
| 頁面 | `server/app.ts` 每次請求 `/help/commands` 時用 `liveCatalog(registry)` 產生即時總表傳給 `renderCommandsPage(view, catalog, now, locale)`；沒有整合層（只有測試）時用空的登記表，每列標「目前：未設定」 |
| README | `scripts/write-commands-doc.ts` 傳 `staticCatalog()`；`npm run docs:commands` 重新產生指令段落（已提交） |
| 「定時器與鬧鐘」 | 手寫的 `TIMER_ASK`（5 列）刪除；改由總表的 `timer`、`alarm`（`builtin`）工具產生，一個工具一列，共 13 列 |
| 「App 整合」（新段落） | 其他非 hidden 的整合工具，一個工具一列，共 14 列：語音中繼 1、Google 日曆 2、天氣 1、客廳電視 9、Gmail（寄給自己）1。hidden 的 5 個（`app.mock.*` 2、`app.home.*` Facade 3）不列 |
| 欄位 | 兩段都是「服務／可以這樣問／AI 可能會做什麼／條件」：服務名稱、例句、`summary`、「需要即時語音，」＋`needs` |
| 不可用的標註 | 依序：即時語音不可用 →「目前：即時語音不可用」；工具沒有註冊（缺設定）→「目前：未設定」；下一次會用的語音路徑（`RealtimeRouteFields.route`）上的 `CapabilityStatus`：`disabled`→「目前：已停用」、`unsupported`→「目前：這條語音路徑不支援」、`authorization_required`→「目前：需要授權」。沿用頁面既有的 `unmet` 樣式（列變灰、第一格加標籤）；README 不標 |
| 總表資料 | `CatalogEntry` 加 `builtin`（來自 `AdapterCatalog.builtin`）。定時器與鬧鐘的 `summary`／例句補上原本只寫在 `TIMER_ASK` 的資訊（見第 4 節） |
| 英文 | `server/messages.en.json` 788 → 792 個鍵：新增 11、刪除 7（只給舊 `TIMER_ASK` 用的文字）、改寫 3（定時器與鬧鐘的 summary）。條件欄用 `需要即時語音，{0}` 加上 `needs` 本身的翻譯組成 |
| 測試 | 新增 `tests/commands-from-catalog.test.ts` 14 項；`tests/fixtures/commands-page.baseline.json` 重新產生；`tests/fixtures/commands-page.pre-cap-2.json` 是 CAP-2 之前的輸出（`c365f7d` 的基準檔原樣複製），用來證明其他段落逐字不變 |

## 3. 指令與結果

在 `prototype/ambient-shell`：

| 指令 | 結果 |
|---|---|
| `npm run catalog -- --check` | `能力總表檢查通過：41 個工具（36 個列在給人看的表、5 個 hidden）` |
| `npm run docs:commands` | 第一次「已更新 README.md 的指令表」，之後「README.md 的指令表已是最新」 |
| `npx vitest run tests/commands-from-catalog.test.ts` | 1 檔，14 項通過 |
| `npx vitest run` | 182 檔，3,414 項通過、5 項跳過 |

repo 根目錄：

| 指令 | 結果 |
|---|---|
| `node scripts/verify-aios.mjs` | PASS（型別檢查、測試、建置、隔離 mock HTTP 流程） |
| `node scripts/check-pstack.mjs` | 見 PR 說明（交付前最後一次執行的輸出） |
| `node scripts/check-bilingual-docs.mjs` | 審閱兩版之後 `--record`，重跑通過；輸出見 PR 說明 |

## 4. Gate 的證據

### 4.1 本機固定語句與 9 個頁面工具的列逐字不變

`tests/commands-from-catalog.test.ts` 把現在的三份輸出（中文頁、英文頁、README）與 `commands-page.pre-cap-2.json` 比對：兩邊都去掉由總表產生的段落（頁面的 `<section id="timers">`／`<section id="apps">`，README 從「#### 定時器與鬧鐘」到「#### 不用說話」之前），剩下的字串逐字相同。所以鏡頭、對話與畫面、任務、外部動作確認、插話、容易誤會、「可以問 AI」（`ASK_THE_AI` 的 9 列與順序）、不用說話，以及頁首、樣式、CSP 用的 style 雜湊都沒有變。測試也確認被去掉的部分不是空的（去掉前後不同），避免比對變成空比對。`tests/realtime-tool-names.test.ts` 的「可以問 AI」列快照照樣通過。

### 4.2 送給模型的工具 JSON 逐字不變

CAP-1 的 `tests/fixtures/model-tools.baseline.json`（26 份）沒有重新產生，`tests/capability-catalog.test.ts` 的比對照樣通過。總表欄位不會進函式規格（CAP-1 的測試）。

### 4.3 新的列、hidden、標註、兩種語言

| 測試 | 確認什麼 |
|---|---|
| every non-hidden integration tool has exactly one row | 27 列＝32 個整合工具 − 5 個 hidden；hidden 的 5 個不在頁面上 |
| TV, calendar, mail, weather and the voice relay appear | 電視、日曆、寄信、天氣、語音中繼在「App 整合」；定時器與鬧鐘只在自己的段落 |
| cells are service, examples, summary and needs | 每格內容直接來自總表 |
| what the old hand-written TIMER_ASK said is still on the table | 見 4.4 |
| unavailable rows are marked from the live state（6 項） | README 不標；即時語音不可用優先；未註冊＝未設定；有註冊但停用＝已停用；啟用＝不標；`unsupported`／`authorization_required` 依下一次的路徑判斷（換到另一條可用的路徑就不標）；頁面用既有的 `unmet` 樣式，中英文都有 |
| both languages（2 項） | 英文頁每一列的服務、說明、條件、標註都沒有中文字（例句刻意保留中文原句，和既有「可以問 AI」相同，頁首有說明）；兩段的標題與說明是英文；中文頁與 README 用同一組列 |

### 4.4 `TIMER_ASK` 前後差異

原本 5 列是「一列涵蓋好幾個工具」；現在一個工具一列，加「服務」欄分成定時器 7 列、鬧鐘 6 列，所以看得出每個工具各做什麼，也多列出原本沒寫的「停止響鈴」「貪睡」兩個工具。原本文字中的資訊對照：

| 原本 `TIMER_ASK` 的資訊 | 現在在哪裡 |
|---|---|
| 「5 分鐘後叫我」 | `app.timer.start` 的例句（新增） |
| 時間到時在建立的那台裝置響、那台不在線時每個畫面都響、右下角按需顯示倒數 | `app.timer.start` 的 summary（補上） |
| 「繼續」 | `app.timer.resume` 的例句（新增） |
| 「全部取消」 | `app.timer.cancel` 原有例句「定時器全部取消」 |
| 有好幾個而沒說是哪一個時，AI 會問 | 段落說明（定時器與鬧鐘都是：`server/alarms.ts` 對兩者都回 `ambiguous`） |
| 鬧鐘可以取名字、用這台 Mac 的時區、跨夏令時間照當地時間響、一小時內右下角顯示倒數 | `app.alarm.set` 的 summary（補上） |
| 設定頁也可以管理鬧鐘 | `app.alarm.list` 的 summary（補上） |
| 重新啟動後還在、睡眠後 30 分鐘內補響 | 段落說明（原文不變） |
| 條件「設定頁『鬧鐘與定時器』開著（預設開）」 | 每一列的條件欄（原本只在設定的兩列；其實每個工具都要開著才註冊） |
| 「（ALARM-2）」 | 刪除：內部批次代號，對使用者沒有意義 |

改了 summary 不會改變模型看到的內容：總表欄位不進函式規格（4.2）。

### 4.5 基準檔前後 diff

| 輸出 | 前 → 後（字元） | 由總表產生的列 |
|---|---|---|
| 中文頁 | 19,140 → 24,698 | 5（`timer-0`…`timer-4`）→ 27（`cap-app.*`） |
| 英文頁 | 29,856 → 38,776 | 5 → 27 |
| README | 9,282 → 11,933 | 5 → 27（Markdown 表格列） |

被取代的：`timer-0` 到 `timer-4` 5 列（換成 13 列 `cap-app.timer.*`／`cap-app.alarm.*`）、「定時器與鬧鐘」的說明（後面加兩句）、該段的欄位（多「服務」）。新增的：`apps` 段落與它的 14 列。其他部分不變（4.1）。

### 4.6 截圖（fixture）

[中文](cap-2-commands-from-catalog-2026-11-24/commands-zh-TW-FIXTURE.png)、[英文](cap-2-commands-from-catalog-2026-11-24/commands-en-FIXTURE.png)：headless Chromium 開 `renderCommandsPage` 產生的 HTML 檔，只截「定時器與鬧鐘」與「App 整合」兩段。設定是 fixture：即時語音可用（API key 路徑），只註冊定時器、鬧鐘與天氣，其他服務沒有設定，所以那些列標「目前：未設定」。不是真實的 Nous 執行畫面。

## 5. 分層與產品紅線

- `shared/voice-commands.ts` 只 import `shared/`（`CapabilityStatus` 來自 `shared/integrations.ts`、`RouteId` 來自 `shared/realtime-route.ts`）；架構守門測試通過。
- `/help/commands` 仍是使用者主動打開的唯讀頁：沒有 script，CSP 沒有放寬（style 沒有改，雜湊相同）。沒有新增常駐 UI、launcher 或 Dashboard。
- 語音行為不變：沒有改任何比對規則、工具定義或路由。

## 6. 沒有做的事（照實寫）

- **不是產品 gate，也不是 Mac 實機驗收。** 沒有真實語音，沒有真實電視、日曆、Gmail、天氣或音箱。
- 「可以問 AI」的 9 個頁面工具仍由 `ASK_THE_AI` 產生（CAP-4）。模型還問不到總表（CAP-3）。`domain` 沒有接腦區動畫（CAP-6）。沒有技能（SKL-*）、沒有動 Spotify、沒有新的權限或安全機制。
- 「鈴響時停止」與「貪睡」同時是本機固定語句（「不用說話」的 `ring-stop` 列）與模型工具；兩處都照實列出，沒有合併。
- 服務欄在窄的瀏覽器寬度會斷行（例如「定時器」）；沒有改 CSS，因為改 style 會改 CSP 雜湊與其他段落的輸出。

## 7. 數字的計算方式

| 數字 | 怎麼算 |
|---|---|
| 27 列 | 靜態總表 `kind === "integration" && !hidden`：32 − 5；測試同時要求 |
| 13／14 列 | 上面 27 列依 `builtin` 分開：timer 7 ＋ alarm 6；voice_relay 1 ＋ google_calendar 2 ＋ weather 1 ＋ lg_tv 9 ＋ gmail_gog 1 |
| 788 → 792 個翻譯鍵 | `git show c365f7d:prototype/ambient-shell/server/messages.en.json` 與現在的鍵數；788 − 7 ＋ 11 ＝ 792（改寫的 3 個鍵數不變） |
| 字元數與列數（4.5） | `node` 讀兩個基準檔：字元數是 `length`；頁面的列數是 `data-row="(timer-\d\|cap-…)"` 的符合次數；README 數兩段表格的資料列 |
