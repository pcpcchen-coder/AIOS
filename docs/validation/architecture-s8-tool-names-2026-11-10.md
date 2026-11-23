<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s8-tool-names-2026-11-10.md) | [English](architecture-s8-tool-names-2026-11-10.en.md)

# 架構重整 S8：工具名單單一來源（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §P1-2 與 §3 的 S8；George 於 2026-11-10 同意 S6–S9。這一批只把重複宣告的名單與數字收成一份，**目標是行為完全不變**。全部是雲端容器裡的型別檢查與 fixture 自動化測試，**沒有真實語音通話，不是產品 gate，也不是 Mac／Pi 實機驗收**。

## 1. 環境

- 分支 `claude/arch-s8-tool-names`，基準是 main `1b61d08`（已含 PR #140 的 `show_search_result`）。
- Linux 雲端容器、Node.js v22.23.4、vitest 5.0.3、TypeScript 7.0.2、Vite 8.3.4。`prototype/ambient-shell/node_modules` 是指向主要 checkout 的符號連結，沒有提交。
- Codex Responses、頁面的工具執行器與武陵居中控都是測試裡的假物件；沒有麥克風、沒有 OpenAI 連線、沒有任何真實帳號。

## 2. 重構前的盤點

以下路徑都在 `prototype/ambient-shell/` 底下。

### 2.1 六份名單

| # | 位置 | 形式 | 順序 | 順序或成員在哪裡看得到 |
|---|---|---|---|---|
| A | `shared/realtime-route.ts` `HostToolName` | 型別 union | `web_search`、`show_search_result`、`delegate_task`、`get_tasks`、`end_conversation`、`home_status`、`home_control`、`set_voice_volume`、`set_day_night` | 只有型別，執行期不存在 |
| B | `shared/voice-commands.ts` `RealtimeToolName` | 型別 union | 與 A 相同 | 只有型別；是 `ASK_THE_AI` 的鍵型別 |
| C | `server/live-tool-caller.ts` `HOST_TOOLS` | 模組內陣列（沒有匯出） | 與 A 相同 | 只用在 `HOST_TOOLS.includes(name)`：順序看不到；成員決定模型呼叫的名稱是交給頁面還是回「這條路徑沒有這個工具」 |
| D | `server/realtime-routes.ts` `HOST_TIMEOUT_MS` | `Record<HostToolName, number>` | `home_control`、`home_status`、`web_search`、`show_search_result`、`delegate_task`、`get_tasks`、`end_conversation`、`set_voice_volume`、`set_day_night` | `Object.values()` 取最大值（`MAX_HOST_TIMEOUT_MS`）與 `HOST_TIMEOUT_MS[name]`，都與順序無關；鍵已由型別在編譯期檢查 |
| E | `shared/voice-commands.ts` `ASK_THE_AI` | 以 B 為鍵的物件 | `end_conversation`、`set_voice_volume`、`set_day_night`、`get_tasks`、`web_search`、`show_search_result`、`delegate_task`、`home_status`、`home_control` | **看得到**：`Object.keys()` 的順序就是指令表「可以問 AI」的列順序（`/help/commands` 與原型 README 的產生段落） |
| F | `server/realtime.ts` `REALTIME_TOOLS` 加 `HOME_STATUS_TOOL`、`HOME_CONTROL_TOOL` | schema 物件 | `web_search`、`show_search_result`、`delegate_task`、`get_tasks`、`set_voice_volume`、`set_day_night`、`end_conversation`，接上網時才有前兩個；有中控時再加 `home_status`、`home_control` | **看得到**：`buildRealtimeTools()` 的陣列順序就是送給模型的工具順序；`liveCallerTools()` 沿用 |

另外 `src/realtime-tools.ts` 的 `executeRealtimeTool(name: string, …)` 是一串 `if (name === "…")`（不是 `switch`），9 個名稱各一個分支。

六份名單的**成員完全相同**（9 個）；A、B、C 順序相同，D、E、F 各有自己的順序。

### 2.2 本來就不在名單裡的工具

| 工具 | 在哪裡 | 為什麼不在 `HostToolName` |
|---|---|---|
| `recall_memory`（`RECALL_MEMORY_TOOL`） | `caps.memory` 時由 `buildRealtimeTools()` 加在家電工具之後 | 核心自己執行（`LiveToolCaller`／`apikey-call.ts`），不經頁面，沒有頁面逾時 |
| `app__<service>__<action>` | `caps.integrations` 提供時加在後面 | 整合層的 Dispatcher 在核心執行，名稱由 Registry 依設定產生 |
| MCP 伺服器（`type: "mcp"`） | `caps.mcp` | 由 OpenAI 端執行；ChatGPT 方案路徑不可用，`liveCallerTools()` 會去掉 |
| `home_confirm` | 只是整合層 Facade 的 `legacyName` | 只由頁面的確認卡呼叫，不給模型 |

這些差異都保留，沒有併入單一名單。

### 2.3 家電參數的長度上限

| 位置 | 內容 |
|---|---|
| `server/app.ts` `/api/home/status` | `target.length > 100` 或 `metric.length > 40` → 400 `target or metric is too long` |
| `server/app.ts` `/api/home/control` | `target.length > 100` 或 `command.length > 40` → 400 `target or command is too long`；字串 `value.length > 40` → 400 `value must be a short string, a number or a boolean` |
| `server/integrations/adapters/home.ts` `inputSchema` | status：`target` `maxLength: 100`、`metric` `maxLength: 40`；control：`target` 100、`command` 40、`value` 40 |
| `server/realtime.ts` `HOME_STATUS_TOOL`／`HOME_CONTROL_TOOL` | **沒有任何長度上限**（schema 裡沒有 `maxLength`） |

**與 23 §P1-2 的出入**：盤點寫「家電參數長度限制三處」，實際只有兩處寫了數字；送給模型的 schema 從來沒有 `maxLength`。兩處的數字一致（100／40／40／40），沒有互相矛盾的值。`confirm_id` 的長度（`adapters/home.ts` 的 6–69 對 `app.ts` 的 `/^home_[\w-]{1,64}$/`，5＋1 到 5＋64，兩者相符）不是模型的工具參數，這一批沒有動。

## 3. 做了什麼

| 名單 | 重構前 | 重構後 |
|---|---|---|
| A `HostToolName` | 手寫 union | `export const HOST_TOOL_NAMES = [...] as const`（順序與原本的 union 相同）；`HostToolName = (typeof HOST_TOOL_NAMES)[number]` |
| B `RealtimeToolName` | 手寫 union | `export type RealtimeToolName = HostToolName`（type-only import `./realtime-route.ts`） |
| C `HOST_TOOLS` | 手寫陣列 | `const HOST_TOOLS: readonly HostToolName[] = HOST_TOOL_NAMES` |
| D `HOST_TIMEOUT_MS` | `Record<HostToolName, number>` | 不變（數值、鍵的順序都沒有動；只加一行註解）。少一個或多一個鍵本來就編譯不過 |
| E `ASK_THE_AI` | `{ [T in RealtimeToolName]: AskTheAi }` | 不變；鍵型別現在跟著 `HOST_TOOL_NAMES`，少一列編譯不過。列順序仍由這個物件自己決定 |
| F 工具 schema | 各自的 `name` | 不變（只在 `REALTIME_TOOLS` 上加註解）。名稱集合由測試在編譯期與執行期比對 |
| `src/realtime-tools.ts` | `if` 串 | **沒有修改**。參數是 `string`，沒有可以加窮舉檢查的 `switch`；改由測試讀原始碼比對分支名稱 |
| 家電上限 | 兩處各寫數字 | `shared/home.ts` 新增 `HOME_ARG_MAX = { target: 100, metric: 40, command: 40, value: 40 } as const`；`adapters/home.ts` 的 schema 與 `app.ts` 的五個比較引用它。`server/realtime.ts` 的 schema 不引用（加上 `maxLength` 會改變送給模型的 JSON） |

改動的檔案：`shared/realtime-route.ts`、`shared/voice-commands.ts`、`shared/home.ts`、`server/live-tool-caller.ts`、`server/realtime-routes.ts`（只有註解）、`server/realtime.ts`（只有註解）、`server/integrations/adapters/home.ts`、`server/app.ts`；新增 `tests/realtime-tool-names.test.ts` 與它的 snapshot。

**加一個頁面工具時要改的地方**（不是只改一處；少了 `HOST_TOOLS` 這一份手寫名單，其餘仍要補）：

1. 在 `shared/realtime-route.ts` 的 `HOST_TOOL_NAMES` 加名稱。
2. `tsc` 接著會要求補 `server/realtime-routes.ts` 的 `HOST_TIMEOUT_MS` 與 `shared/voice-commands.ts` 的 `ASK_THE_AI`（之後跑 `npm run docs:commands`）。
3. 自己要加：`server/realtime.ts` 的工具 schema（與規則文字）、`src/realtime-tools.ts` 的分支。沒加時 `tests/realtime-tool-names.test.ts` 失敗（schema 另外在 `tsc` 的 `expectTypeOf` 失敗）。
4. 更新 `tests/realtime-tool-names.test.ts` 的特徵名單（`CANONICAL`、`TIMEOUT_KEY_ORDER`、`ASK_ORDER`、`MODEL_ORDER`、逾時數值）與 snapshot。

**與 23 §3 原文的差異**：

1. 原文說上限「只留 `adapters/home.ts` schema 一份，`realtime.ts` 與 `app.ts` 引用它」。實際放在 `shared/home.ts`：`app.ts` 已經 import `adapters/home.ts`，但數字放在 shared 才不會讓 HTTP 層為了一個數字依賴整合層的 Adapter。`realtime.ts` 沒有引用，原因見 §2.3。
2. 原文估 4 檔，實際 8 個來源檔（其中 2 個只有註解）。
3. 模組依賴：`shared/voice-commands.ts` 多一條對 `shared/realtime-route.ts` 的 type-only import（shared 內部）。量測腳本的跨層 import 仍是 0、import 環仍是 4 組，`tests/architecture.test.ts` 沒有修改就通過。

## 4. 驗證

### 4.1 先在未修改的 main 上通過的特徵測試

`tests/realtime-tool-names.test.ts` 的前五個 `describe`（35 項）只用重構前就有的匯出。**先寫好、在未修改的 `1b61d08` 工作目錄上執行（當時 `git status` 只有這個新測試檔），35 項通過並寫出 53 份 snapshot**；之後才開始重構。重構後 snapshot 檔的 SHA-256 與重構前相同（`ff856060a7011b2baa70afccd83e201fc523d5571763212a1a0ac00ef86cfe98`），35 項不改期望值仍通過。

| 內容 | 做法 |
|---|---|
| 送給模型的工具 JSON | 7 組能力（最小、上網、家電、記憶、整合、MCP、全開）× `buildRealtimeTools()`／`liveCallerTools()` × zh-TW／en 的 `JSON.stringify`，snapshot |
| 規則與說明文字 | 同 7 組的 `realtimeToolRules()`、`buildRealtimeInstructions()`、`buildCallerInstructions()`（固定時間），snapshot |
| 工具順序 | F 的順序、全開時 `recall_memory`、整合工具、MCP 的位置，inline |
| 逾時表 | `Object.keys(HOST_TIMEOUT_MS)` 的順序與 9 個數值、`SIDE_EFFECT_TOOLS`，inline |
| 指令表 | `Object.keys(ASK_THE_AI)` 的順序、`commandSections(null)` 的「可以問 AI」段落的列 id（inline）與整列內容（snapshot）。整份 README 產生段落另由既有的 `tests/commands-doc.test.ts` 比對 |
| `HOST_TOOLS` 的成員 | 沒有匯出，所以用行為觀察：假的 Codex 回一個工具呼叫，9 個名稱各自會交給頁面；`recall_memory`（沒開記憶）、`home_confirm`、`app__mock__echo`（沒有整合層）、`no_such_tool` 不呼叫頁面，回 `這條路徑沒有這個工具：<名稱>` |
| 頁面執行器 | 讀 `src/realtime-tools.ts` 原始碼，`name === "…"` 的名稱集合等於 9 個 |
| 家電上限 | Facade 三個工具的 `inputSchema` JSON（snapshot）；真的起一個核心（Facade 關與開各一次）加空的假中控，送剛好在上限與多一個字的 10 個請求，狀態碼、回應內容與「有沒有送到中控」做 snapshot，另 inline 檢查三句 400 訊息 |
| 家電工具 schema 沒有上限 | `HOME_STATUS_TOOL`／`HOME_CONTROL_TOOL` 的 JSON 不含 `maxLength` |

### 4.2 重構後加入的一致性測試

同一個檔最後的 `describe`（5 項）用到新的匯出，重構前無法執行：

- `HOST_TOOL_NAMES` 的內容與順序等於重構前的 union，名稱不重複。
- 編譯期（`expectTypeOf`，由 `tsc --noEmit` 檢查）：`RealtimeToolName`、`keyof typeof HOST_TIMEOUT_MS`、工具 schema 的名稱 union 都等於 `HostToolName`。
- 執行期：逾時表的鍵、`ASK_THE_AI` 的鍵、`buildRealtimeTools()` 與 `liveCallerTools()`（上網＋家電）的名稱，排序後都等於 `HOST_TOOL_NAMES`（頁面執行器的分支名稱由 §4.1 那一項比對，不重複）；`SIDE_EFFECT_TOOLS` 都在名單裡。
- 保留的差異：`recall_memory`、整合工具、MCP 不在名單裡。
- `HOME_ARG_MAX` 的四個數字；Facade schema 的 `maxLength` 等於它；`app.ts` 與 `adapters/home.ts` 的原始碼引用 `HOME_ARG_MAX`。

為了加這一段，測試檔在重構後改了 import（多 `expectTypeOf`、`HOME_ARG_MAX`、`HOST_TOOL_NAMES`、兩個型別）、檔頭多兩行註解、檔尾多這個 `describe`；前 35 項的程式與期望值沒有改。

### 4.3 指令與結果

| 檢查 | 指令 | 結果 |
|---|---|---|
| 特徵測試（未修改的 main） | `npx vitest run tests/realtime-tool-names.test.ts` | 1 檔、35 項通過，寫出 53 份 snapshot；第二次執行 35 項通過、沒有寫入 |
| 型別檢查 | `npx tsc --noEmit` | 通過（重構前後各一次） |
| 新測試（重構後） | `npx vitest run tests/realtime-tool-names.test.ts` | 1 檔、40 項通過；snapshot 檔雜湊不變 |
| 單元與整合測試 | `npx vitest run` | 177 個測試檔、3,354 項（新檔占 40 項）。重構後第一次執行 3,348 項通過、6 項跳過；提交後的執行（作者兩次與獨立審查）是 3,349 項通過、5 項跳過。跳過數依環境而異。另有一次執行出現 1 項失敗、沒有記下是哪一項，見 §5 |
| 前端建置 | `npx vite build` | 通過；仍有 chunk 大小的警告 |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 指令表 | `npm run docs:commands` | 「README.md 的指令表已是最新」，工作目錄沒有因此變動 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過：143 份、142 組完整配對、1 份 inline |
| 空白 | `git diff --check` | 通過 |
| 架構量測 | `node scripts/architecture-metrics.mjs` | 跨層 import 0、import 環 4 組，與重構前相同；差異只有行數（server ＋7、shared ＋20） |
| 既有測試檔沒有修改 | `git status` | `tests/` 底下只有新增的測試檔與它的 snapshot |

## 5. 限制

- 只有雲端容器的 fixture 測試：沒有真實語音通話，沒有把工具表送到 OpenAI 或 Codex，沒有真的中控。「送給模型的 JSON 不變」是比對核心產生的字串，不是觀察上游收到的請求。
- 7 組能力是人工挑的代表組合，不是所有開關的窮舉；整合工具用的是測試裡寫的一個假規格，不是真實 Registry 的 `app__tv__`／`app__timer__`／`app__alarm__`（那幾條規則文字由既有測試涵蓋）。
- `HOST_TOOLS` 沒有匯出，成員是用行為觀察的；它的順序本來就沒有對外行為，沒有測。
- 頁面執行器用正規表示式讀原始碼比對分支名稱：只能發現「少一個或多一個名稱」，不能證明分支做的事正確（那由既有的 `realtime-tools` 相關測試負責）。
- 讀原始碼文字的檢查（`src/realtime-tools.ts` 的分支名稱、`app.ts` 與 `adapters/home.ts` 裡的 `HOME_ARG_MAX.` 字樣）是刻意寫得脆弱的特徵檢查：改寫法就會失敗，失敗時要人判斷是否仍然一致。
- 測試裡的 `freePort()`（先開一個埠探測、關掉後再 listen）和另外 17 個使用同樣 helper 的檔案（`tests/` 底下，含 fixtures）有同一個競爭條件：兩者之間埠可能被別的行程占用。§4.3 提到的那一次全套執行出現 1 項失敗、沒有記下是哪一項（當時同時在改文件並執行雙語檢查），這可能是原因之一，沒有證實；之後 4 次全套執行沒有重現。
- `src/realtime-tools.ts` 的參數仍是 `string`，沒有編譯期的窮舉檢查；改成 `HostToolName` 會動到頁面兩條語音路徑的呼叫端，不在這一批。
- `server/realtime.ts` 的家電工具 schema 仍然沒有 `maxLength`：模型送出過長的參數時，由 `/api/home/*` 回 400。要不要把上限告訴模型是行為變更，這一批不做。
- 這一批不處理 23 §P1-2 的其他項目（頁面兩路的重複方法、核心兩路各做一次的 `recall_memory`／`delegate_task`）。
- 全套測試通過只是程式檢查，不是 G0–G3 或任何 Mac／Pi gate。跳過數依環境而異。
