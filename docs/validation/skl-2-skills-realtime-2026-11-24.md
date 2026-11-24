<!-- bilingual: source=zh-TW -->

> [繁體中文](skl-2-skills-realtime-2026-11-24.md) | [English](skl-2-skills-realtime-2026-11-24.en.md)

# SKL-2 技能接上兩條即時語音路徑：驗證

日期：2026-11-24（Asia/Taipei）。分支：`claude/skl-2-skills-realtime`，以 main 的 `c853078`（SKL-1，PR #154 合併）為基礎。範圍是 [24 §4.4](../24_Capability_Catalog_and_Skills_2026-11.md#44-批次) 的 SKL-2：技能索引進兩條即時語音路徑的工作階段說明、唯讀工具 `app.skill.read`、依可用工具過濾，由 `NOUS_SKILLS` 開關。

**這一批雲端做的全部是 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收。** SKL-2 的 gate 還有一項「Mac 上用真實語音跑一次早晨簡報，記錄每一步的真實結果」：**未完成，待 George 在 Mac 上實機執行**，步驟與空白結果表在[第 7 節](#7-mac-實機驗收給-george未執行)。

## 1. 環境

| 項目 | 值 |
|---|---|
| 機器 | Linux 雲端容器（不是 Mac、不是 Pi） |
| Node | v22.23.5 |
| 安裝 | `prototype/ambient-shell` 執行 `npm ci`（沒有新增或升級套件） |
| 外部服務 | 沒有連任何服務：天氣與日曆 Adapter 的依賴是測試替身，`startNous` 測試用假的 Open-Meteo 回應與不存在的 gog 路徑（不會被呼叫） |

## 2. 交付內容

路徑在 `prototype/ambient-shell/` 底下。

| 項目 | 內容 |
|---|---|
| 旗標 | `NOUS_SKILLS=on` 才開（預設關閉），由 `server/config.ts` 讀成 `config.skills`。關閉時 `server/nous.ts` 不讀技能目錄、不註冊讀取工具，工具表、說明與 `/help/commands` 和之前相同 |
| 技能索引與讀取 | `server/skills/runtime.ts` 的 `SkillBook`：`listing()`（依登記表即時狀態過濾、依名稱排序、套上限）、`indexLines()`（工作階段說明的索引段落）、`read()`（讀取工具的內容）、`skillLoadLog()`（啟動診斷）。兩條路徑共用這一份（[23 §P1-2](../23_Architecture_Review_2026-11.md)） |
| 讀取工具 | `app.skill.read`（模型看到的名稱 `app__skill__read`），`server/integrations/adapters/skill.ts` 的 `SkillAdapter`，比照定時器做成核心內建的 `BuiltinAdapter`，經登記表與 Dispatcher。`effect: read`、兩條語音路徑、時限 1 秒；名稱與 ID 常數在 `server/skills/tool-id.ts` |
| 說明接線 | `server/realtime.ts`：`RealtimeCapabilities.skills`（已綁定路徑的索引）。`realtimeToolRules()`——API key 語音模型與 ChatGPT 方案工具執行層共用的規則——在鬧鐘規則之後、對話音量規則之前插入索引；ChatGPT 方案沒有工具的語音層（`buildLiveInstructions()`）在鬧鐘那一句之後插入「符合時一律交辦」版的索引 |
| 語言 | 讀取工具要回傳介面語言的內文，所以 `ExecutionContext` 與 `DispatchRequest` 多一個 `locale`：API key 路徑由核心依工作階段的語言帶入（新增 `RealtimeSessions.localeOf()`，頁面不能指定），ChatGPT 方案由 `LiveToolCaller` 帶入 |
| 資料上限 | 一般工具的結果 `data` 上限 4,096 位元組，英文內文 4,437 字放不下。`ToolDefinition.resultDataMaxBytes` 讓唯讀工具宣告較大的上限，最多 `MAX_READ_DATA_BYTES`＝32,768（內文上限 6,000 字 × 中文 3 位元組＝18,000，加上 JSON 跳脫仍在範圍內）。登記表拒絕非 `read` 工具或超過範圍的值 |
| 總表 | `SKILL_CATALOG` 加進 `ADAPTER_CATALOGS`：summary、例句「給我今天的簡報」、`needs`、`domain: null`、`hidden: true`、`builtin: true`；英文在 `server/messages.en.json` |
| 測試 | 新增 `tests/skills-realtime.test.ts` 26 項；`tests/integration-routes.test.ts` 加 2 項（兩條路徑把語言交給 Adapter）；更新 SKL-1 寫死「SKL-1 還沒用到」的 2 項與總表計數 3 項（見 §4.5） |
| 文件 | 本紀錄、驗證索引、[目前實作狀態](../Current_Implementation_Status.md)、[24](../24_Capability_Catalog_and_Skills_2026-11.md) 的 SKL-2 補記、[怎麼寫一份技能](../development/writing-a-skill.md) §8–§9、原型 README 的目錄說明、`.env.example`，中英文各一份 |

### 2.1 決定與理由

- **名稱定案 `app.skill.read`**：沿用 docs/24 的暫名，符合既有的 `app.<service>.<action>`，服務段 `skill`。
- **`/help/commands` 不列（hidden）**：使用者不會直接「叫」這個工具，是模型依索引自己決定讀；`/help/commands` 列的是使用者可以說的話。總表上照樣有完整資料（`npm run catalog -- --json` 看得到）。
- **`domain: null`**：讀做法不是使用者內容，呼叫時不亮腦區；技能裡實際的天氣、日曆呼叫才是真實事件（CAP-6 接動畫時照各自的 `domain`）。
- **讀取工具只在有技能列得出來時出現**：`SkillAdapter` 的 `enabled()` 是「至少一份技能在某條語音路徑、某個語言列得出來」。所以日曆沒設定時，工具清單和旗標關閉時一樣，模型看不到讀取工具也看不到索引。
- **說明裡的「整合層規則」不因讀取工具出現**：`realtimeToolRules()` 判斷要不要加整合層規則時排除 `app__skill__read`。否則在整合層與定時器都關閉的設定下，開旗標會多出一段整合層規則（不是索引的文字）。
- **過濾的時間點**：API key 路徑的說明在工作階段開始時組好（client secret 與帶記憶的 `session.update` 各組一次），以那時的狀態為準；通話中狀態改變不會更新索引。ChatGPT 方案的工具執行層每次交辦都重組說明（`LiveToolCaller.run()` 每次呼叫 `caps()`），所以會反映通話中的變化；它的語音層說明在工作階段開始時組好。讀取工具每次呼叫都重新看即時狀態，已經不能用的技能會被拒絕。

## 3. 指令與結果

在 `prototype/ambient-shell`：

| 指令 | 結果 |
|---|---|
| `npm run typecheck` | 通過 |
| `npx vitest run tests/skills-realtime.test.ts` | 1 檔，26 項通過 |
| `npx vitest run` | 184 檔，最後一次 3,487 項通過、5 項跳過（共 3,492）；前一次 3,486 通過、6 跳過 |
| `npm run catalog -- --check` | `能力總表檢查通過：42 個工具（36 個列在給人看的表、6 個 hidden）`、`技能檢查通過：1 份出貨技能（morning-briefing），中英文各一份`，結束代碼 0 |
| `npm run docs:commands` | `README.md 的指令表已是最新`（讀取工具是 hidden，指令表沒有變） |

跳過的項目依環境條件決定、每次可能差一項（改動前在這個容器跑也是 6 項跳過），不是這一批新增的；沒有任何失敗。

repo 根目錄：

| 指令 | 結果 |
|---|---|
| `node scripts/verify-aios.mjs` | PASS（型別檢查、184 檔測試、建置、隔離 mock HTTP 流程；交付前最後一次的數字見 PR 說明） |
| `node scripts/check-pstack.mjs` | 通過；輸出見 PR 說明 |
| `node scripts/check-bilingual-docs.mjs` | 審閱兩版之後 `--record`，重跑通過；輸出見 PR 說明 |

## 4. Gate 的證據

### 4.1 旗標關閉：逐字不變

| 測試 | 確認什麼 |
|---|---|
| `tests/capability-catalog.test.ts` 的 CAP-1／CAP-2 基準 | `model-tools.baseline.json`（26 份工具 JSON）與 `commands-page.baseline.json`（`/help/commands` 兩種語言與 README 指令表）逐字相同。**基準檔沒有重新產生** |
| `without a skill book the instructions of all three layers equal a build with no skills at all` | 兩條路徑 × 兩種語言，三份說明（API key 語音模型、ChatGPT 方案工具執行層、ChatGPT 方案語音層）都和完全沒有技能時相同，也沒有出現 `app__skill__read` |
| `the Dispatcher refuses app.skill.read when the flag is off` | 沒有註冊：`refused`，`reason: not_registered` |
| `off (default): no skill is read, no read tool, no skill log line`（真的 `startNous`） | 整合層開著天氣與日曆時，`/api/settings` 的工具名稱沒有 `app__skill__read`，log 沒有任何「技能：」開頭的行 |
| `SKL-2: NOUS_SKILLS only sets config.skills` | 設定裡只有 `skills` 一欄不同 |

說明文字目前沒有基準檔，所以「說明不變」的證據是：同一份程式在「沒有技能」與「旗標關閉」兩種輸入下輸出相同，加上 `server/realtime.ts` 只在 `caps.skills` 存在時才多出段落（沒有就展開成空陣列）。

### 4.2 旗標開啟：差異只有讀取工具與索引

| 測試 | 確認什麼 |
|---|---|
| `tool JSON: the only difference is app__skill__read` | 天氣與日曆都註冊時，兩條路徑 × 兩種語言：`functionSpecs()` 與 `buildRealtimeTools()` 拿掉 `app__skill__read` 之後，和沒有技能時逐字相同；`app__skill__read` 正好一個；ChatGPT 方案工具執行層的工具表也有它 |
| `instructions: removing exactly the index lines gives back the flag-off text` | 三份說明各拿掉索引那幾行，就逐字等於沒有技能時的說明 |
| `both routes get the same index` | API key 路徑與 ChatGPT 方案工具執行層的規則段落完全相同 |
| `index text` | 中文指示全文、每份技能一行 `- 名稱：說明`（說明逐字取自 `SKILL.md`）；英文版取自 `SKILL.en.md`、沒有任何漢字；索引裡沒有內文 |

### 4.3 依可用工具過濾

| 測試 | 確認什麼 |
|---|---|
| `calendar not configured` | 只註冊天氣：早晨簡報不列出、索引是空的（說明完全不變）、讀取工具是 `disabled`（不在工具清單），log 記「工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）」 |
| `a registered but disabled tool also keeps the skill out` | 工具有註冊但 `disabled` 也不列；改回 `available` 就列出 |
| `the live tool layer rebuilds its instructions per delegation` | ChatGPT 方案工具執行層的說明跟著狀態改變 |
| `on, calendar not configured`（真的 `startNous`） | `NOUS_SKILLS=on`、只有天氣：工具清單沒有讀取工具，log 照實記錄原因 |

### 4.4 讀取工具

| 測試 | 確認什麼 |
|---|---|
| `returns the body in the session's language` | 兩條路徑：中文工作階段回 `SKILL.md` 的內文，英文回 `SKILL.en.md`；`data` 有 `name`、`locale`、`tools`、`body`。英文 `data` 超過 4,096 位元組，仍原樣交回 |
| `refuses a name that is not loaded, a path-like name, and a name over 40 characters` | `movie-night`、`../morning-briefing`、`morning-briefing/SKILL.md`、41 字、沒有 `name`、多一個參數：全部 `refused`、`invalid_arguments`。名稱只和已載入清單比對完全相同的字串，從不組成路徑 |
| `refuses a loaded skill whose tools are unavailable on this route` | `refused`、`reason: unavailable`，訊息與 `data.unavailable_tools` 列出不可用的工具（中英文各一句） |
| `is refused as disabled when the read tool is registered but nothing is listable` | `refused`、`disabled` |
| `has full catalog data, is hidden from /help/commands` | 總表上 `effect: read`、`builtin`、`hidden`、`domain: null`、兩條路徑、有 summary、例句與 `needs` |
| `only a read tool may raise its data limit` | 32,768 可以；32,769 或非 `read` 工具註冊失敗 |
| `SKL-2: the core passes the session's interface language to the Adapter`／`passes the caller's interface language` | API key：用 `x-nous-locale: en` 開始的工作階段，Adapter 收到 `en`（請求本文帶 `locale` 也沒有作用）；ChatGPT 方案：`LiveToolCaller` 的語言交給 Adapter |

讀取工具只回傳文字：`SkillBook.read()` 只從記憶體裡已載入的技能取內文，不讀檔、不執行內文；技能不能新增或啟用工具、不能改設定。內文裡的每一步仍然是模型呼叫各自的工具、經 Dispatcher 與既有政策。

### 4.5 改了哪些既有測試

都是 SKL-1 時寫明「SKL-2 才會改」的地方，或由總表推導的計數，不是基準檔：

- `tests/skills.test.ts`：「`NOUS_SKILLS` 在 SKL-1 沒有程式讀」改成「只設定 `config.skills`」；「只有 `scripts/catalog.ts` import 技能模組」改成「`scripts/catalog.ts` 與 `server/nous.ts`」，總表上的 `app.skill.read` 必須是 hidden、builtin、read。
- `tests/capability-catalog.test.ts`：內建 Adapter 多一個 `skill`；整合工具 32→33、hidden 5→6。
- `tests/commands-from-catalog.test.ts`：hidden 工具 5→6，`app.skill.read` 不在頁面上。

## 5. 量測：索引佔多少字、上限

量法：同一份程式、同樣的能力，分別組出有索引與沒有索引的說明，相減兩者的 Unicode code point 數（`[...text].length`，和 `SKILL_LIMITS` 相同）。只有早晨簡報一份、天氣與日曆都可用。測試 `measured: how much the index adds` 每次都重算並比對這些數字。

| 說明 | 中文 | 英文 |
|---|---:|---:|
| API key 語音模型的工作階段說明 | **+202** | **+571** |
| ChatGPT 方案工具執行層（每次交辦） | +202 | +571 |
| ChatGPT 方案語音層（交辦版索引） | +113 | +339 |
| 其中：指示那一行 | 132 | 369 |
| 其中：早晨簡報那一行 | 68 | 200 |

202＝132＋68＋2 個換行；571＝369＋200＋2。對照：量測用的 API key 說明（上網查詢開、家電關、沒有整合工具、沒有任務）中文本身是 1,394 字，加上索引是 1,596 字；英文 1,607 → 2,178。

**上限（`SKILL_INDEX_LIMITS`）：一次最多 8 份，整段索引（指示＋每份一行，以換行連接）最多 2,000 字，兩種語言共用。** 理由：英文較長，8 份和早晨簡報一樣長的技能是 369＋8 ×（200＋1）＝1,977 字，剛好放得下；中文同樣 8 份是 132＋8 × 69＝684 字。`description` 上限 240 字，最長的一行約 284 字，這種長度的技能大約 5 份就會碰到字數上限。

**超過時**：依名稱排序，從第一份放不下的開始，後面全部不列（不跳著把短的塞進去，結果可預測），並在 log 記「超過索引上限（8 份／2000 字）沒列：…」。被截掉的技能，讀取工具也拒絕（`unavailable`），模型和索引看到的一致。測試：`lists at most 8 by name order`、`stops at the first skill that does not fit`。

### 5.1 旗標開啟時實際加進說明的中文段落

中文介面，API key 語音模型與 ChatGPT 方案工具執行層（插在鬧鐘規則之後）：

```text
家裡常做的事有寫好的做法（技能），列在下面。使用者的請求符合其中一項時，先呼叫 app__skill__read（name 照下面的名稱）讀內文，再照內文做；內文裡的每一步仍要用對應的工具完成，只說工具真的回傳的內容。下面沒有列出的做法就是目前不能用，不要假裝有。
- morning-briefing：使用者要早晨簡報、想一次聽今天的天氣和行程時使用（例如「給我今天的簡報」「今天天氣和行程怎樣」）。
```

中文介面，ChatGPT 方案語音層（沒有工具）：

```text
家裡常做的事有寫好的做法，使用者的請求符合下面其中一項時一律交辦（連同使用者的原話）：
- morning-briefing：使用者要早晨簡報、想一次聽今天的天氣和行程時使用（例如「給我今天的簡報」「今天天氣和行程怎樣」）。
```

英文介面的同兩段（技能說明取自 `SKILL.en.md`）：

```text
Some common household requests have written procedures (skills), listed below. When a request matches one, first call app__skill__read with that name to read the procedure, then follow it; every step still goes through the matching tool, and say only what the tools actually returned. A procedure that is not listed is not available right now; do not pretend it exists.
- morning-briefing: Use when the user asks for a morning briefing or wants today's weather and schedule together (for example "give me today's briefing" or "what's the weather and my schedule today").
```

```text
Some common household requests have written procedures; when a request matches one below, always delegate it (with the user's own words):
- morning-briefing: Use when the user asks for a morning briefing or wants today's weather and schedule together (for example "give me today's briefing" or "what's the weather and my schedule today").
```

## 6. 診斷 log

`NOUS_SKILLS=on` 時，啟動 log（macOS App 在 `~/Library/Application Support/Nous/nous.log`，`npm start` 在終端機）照實記：

```text
技能：載入 1 份（morning-briefing）
技能：api_key／zh-TW 列出 1 份（morning-briefing）
技能：api_key／en 列出 1 份（morning-briefing）
技能：live／zh-TW 列出 1 份（morning-briefing）
技能：live／en 列出 1 份（morning-briefing）
```

這是天氣與日曆都註冊時，真的 `startNous` 測試裡的輸出。日曆沒設定時是 `技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）`。之後每次組說明（開始一通、ChatGPT 方案每次交辦）若結果和上一次不同才再記一行。技能檔有錯時記 `技能：N 份檢查失敗被略過：…` 與每個問題（`技能：✗ 檔案（代碼）說明`），只略過那一份，Nous 照常啟動（測試 `loads the good skill, skips the bad one`）。讀技能目錄本身丟錯時也只記一行、這次沒有技能。log 不記技能內文。

## 7. Mac 實機驗收（給 George，未執行）

**狀態：NOT TESTED。** 雲端沒有 Mac、麥克風或真實帳號，這一節沒有任何結果。做完後把結果填進 7.4 的表，連同 log 片段補記到本紀錄（或新增一份 Mac 紀錄）。

### 7.1 準備

1. 天氣：整合層要列出 `weather`；在選單列「主動提醒」選好天氣地點（沒選時天氣會回 `refused`，那是另一種要記錄的情況）。
2. 日曆：gog 已照 [CAL-1](cal-1-google-calendar-2026-11-05.md) 授權 Calendar；今天的 Google 日曆上最好有 1–2 個行程，方便核對。
3. 至少一條即時語音路徑能用（ChatGPT 方案或 `OPENAI_API_KEY`）。建議兩條都跑一次，因為兩條路徑的接法不同（API key 由語音模型直接呼叫工具；ChatGPT 方案由工具執行層呼叫）。

### 7.2 `.env`（macOS App：選單列「編輯 API key 與進階設定（.env）…」，存檔後核心自動重新啟動；`npm start` 則改完重新啟動）

```bash
NOUS_SKILLS=on
NOUS_AIL=on
NOUS_AIL_SERVICES=weather,google_calendar
NOUS_GOG_ACCOUNT=you@gmail.com
```

`NOUS_AIL_SERVICES` 原本有其他服務就保留，加上這兩個；`NOUS_GOG_ACCOUNT` 填你自己的 Gmail（沒設時用 `NOUS_MAIL_SELF`）；找不到 gog 時才需要 `NOUS_GOG_PATH=/opt/homebrew/bin/gog`。

### 7.3 三種情況

**情況 A：兩個工具都可用。**

1. 啟動後在 `~/Library/Application Support/Nous/nous.log` 找 `技能：` 開頭的行，應該是 §6 那 5 行（`列出 1 份（morning-briefing）`）。
2. 開即時語音，說「給我今天的簡報」（英文介面說 "Give me today's briefing"）。
3. 預期：先說今天的天氣（地點、狀況、最低到最高溫；降雨 30% 以上才說降雨、50% 以上提醒帶傘），再說今天的行程（時間與標題，最多 5 個）；只說工具回傳的內容。
4. 記下 log 裡這一通的工具呼叫：API key 路徑是 `整合層：xxxxxxxx app.skill.read api_key → confirmed`、`app.weather.today api_key → …`、`app.calendar.list_events api_key → …`；ChatGPT 方案另外有 `即時語音（ChatGPT 方案）：整合工具 app__skill__read → confirmed` 等行。記下順序、每個的 status 與毫秒數。
5. 核對：說的天氣與 Open-Meteo／天氣角落一致嗎？說的行程與 Google 日曆一致嗎？有沒有說出工具沒給的東西（體感溫度、明天的天氣）？
6. 加做（可選）：中英文介面各一次；說「明天的簡報」看它會不會先說天氣只能說今天的。

**情況 B：日曆沒設定（技能應該不列出）。**

1. `NOUS_AIL_SERVICES` 拿掉 `google_calendar`（只留 `weather`），重新啟動。
2. log 應該有 `技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）`（其他路徑、語言同樣各一行），而且**沒有**任何 `app.skill.read` 的呼叫。
3. 說「給我今天的簡報」。預期：模型不會說有一份早晨簡報的做法、不會呼叫 `app.skill.read`；可能只說天氣（用天氣工具）或照實說行程查不到／沒有接日曆。**不應該**編出行程。
4. 記下模型實際說了什麼、log 裡有哪些工具呼叫。

**情況 C：旗標關閉。**

1. `.env` 改成 `NOUS_SKILLS=off`（或刪掉這行），日曆加回來，重新啟動。
2. log **沒有**任何 `技能：` 開頭的行，也沒有 `app.skill.read` 的呼叫。
3. 說「給我今天的簡報」。預期：行為和 SKL-2 之前相同（模型可能自己決定呼叫天氣與日曆，也可能不會；這是基準，照實記）。

### 7.4 結果表（George 填寫）

| 情況 | 路徑 | 介面語言 | log 的「技能：」行 | 工具呼叫（順序、status、ms） | 模型實際說了什麼（摘要） | 與工具結果一致？ | 結果 |
|---|---|---|---|---|---|---|---|
| A 兩個都可用 | API key | 中文 | | | | | NOT TESTED |
| A 兩個都可用 | ChatGPT 方案 | 中文 | | | | | NOT TESTED |
| A 兩個都可用 | （任一） | 英文 | | | | | NOT TESTED |
| B 日曆沒設定 | （任一） | 中文 | | | | | NOT TESTED |
| C 旗標關閉 | （任一） | 中文 | | | | | NOT TESTED |

記錄時不要貼行程的真實標題或家人的名字到 repo；寫「2 個行程，時間與標題和日曆相符」這樣的摘要即可。

## 8. 限制與沒有做的事

- **Mac 實機驗收沒有做**（第 7 節）：模型真的會不會讀技能、照技能說、句子聽起來如何，目前完全不知道。
- API key 路徑的索引以工作階段開始時為準；通話中工具狀態改變不會更新索引（讀取工具會照當下狀態拒絕）。
- 文字聊天與背景任務沒有接技能（要等 CAP-5）。
- 沒有做 SKL-3（記住這種做法、存檔、家裡自訂技能目錄）、CAP-3、CAP-4、CAP-6；沒有動 Spotify；沒有新增常駐 UI、launcher、Dashboard；沒有新增權限或安全機制。
- 工作階段說明的規則仍是中文為主（既有設計），英文介面時只有索引的指示與技能說明是英文。
- 上限是依目前一份技能訂的；技能變多後若常被截斷，要重新量測再調。

## 9. 下一個 gate

1. **SKL-2 的 Mac 實機驗收**（第 7 節），George 執行。通過之前，不能宣稱技能在真實語音下可用。
2. 依 [24](../24_Capability_Catalog_and_Skills_2026-11.md) 的順序，之後是 CAP-3（模型問得到總表），再來 SKL-3。
