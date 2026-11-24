<!-- bilingual: source=zh-TW -->

> [繁體中文](cap-1-capability-catalog-2026-11-24.md) | [English](cap-1-capability-catalog-2026-11-24.en.md)

# CAP-1 能力總表驗證

日期：2026-11-24（Asia/Taipei）。分支：`claude/cap-1-capability-catalog`，以 `claude/amazing-babbage-us2i3o`（[docs/24](../24_Capability_Catalog_and_Skills_2026-11.md) 的提案，PR #151，尚未合併）為基礎；main 是 `fd2198b`。範圍是 [24 §3.3](../24_Capability_Catalog_and_Skills_2026-11.md#33-批次) 的 CAP-1，加上 [§6.1](../24_Capability_Catalog_and_Skills_2026-11.md#61-george-的決定2026-11-24) 決定 3（`domain` 欄，只有資料）與決定 6（總表列得出 9 個頁面工具，只有資料）。

**這一批全部是雲端容器裡的 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收。** 沒有真實語音、沒有真實服務。語音行為、`/help/commands`、設定畫面與送給模型的工具 JSON 都沒有變，下面第 4 節是證據。

## 1. 環境

| 項目 | 值 |
|---|---|
| 機器 | Linux 雲端容器（不是 Mac、不是 Pi） |
| Node | v22.23.5 |
| 安裝 | `prototype/ambient-shell` 執行 `npm ci`（依 `package-lock.json`，沒有新增或升級套件） |
| 外部服務 | 沒有連任何服務；Adapter 的依賴都是測試替身 |

## 2. 交付內容

路徑在 `prototype/ambient-shell/` 底下。

| 項目 | 內容 |
|---|---|
| 型別 | `server/integrations/contracts.ts`：`ToolCatalogInfo`（`summary`、`examples` 至少一句、選填 `needs`、`domain`、選填 `hidden`）；`ToolDefinition.catalog` 必填；`CatalogTool`（靜態總表需要的部分，不含 `inputSchema`）；`AdapterCatalog`（`id`、`service`、服務名稱 `label`、`mock`、`builtin`、`tools`） |
| 工具資料 | 10 個 Adapter 檔的 32 個工具全部補上總表資料；例句是讀過每個 `execute()` 之後寫的。模擬工具（2）與 legacy Facade（`app.home.*`，3）標 `hidden` |
| 模組層級常數 | 10 個檔都匯出一份 `*_CATALOG`。`weather.ts` 與 `lg-tv.ts` 原本在 `tools()` 方法裡組定義，搬成模組層級的 `TOOLS`（內容不變）。`voice-relay.ts` 的 schema 要看音箱目錄，所以只把不看設定的部分搬成 `RELAY_TOOL_STATIC` |
| 頁面工具 | `server/integrations/catalog.ts` 的 `HOST_TOOL_CATALOG`：`HOST_TOOL_NAMES` 的 9 個工具，型別要求一個都不能少；例句取自 `ASK_THE_AI`。`ASK_THE_AI` 與 `/help/commands` 沒有改 |
| 總表 | `staticCatalog()`（不需要設定）；`liveCatalog(registry)`（加上 `configured` 與兩條語音路徑的 `CapabilityStatus`）；`localizeCatalog()`；`checkCatalog()`；`catalogMarkdown()` |
| 英文 | `server/messages.en.json` 新增 127 個鍵，經 `localize()` 取用；沒有另開英文欄位 |
| 開發指令 | `npm run catalog -- --json | --check | --markdown`（可加 `--lang en`），`scripts/catalog.ts` |
| 測試 | `tests/capability-catalog.test.ts` 23 項；基準檔 `tests/fixtures/model-tools.baseline.json`、`tests/fixtures/commands-page.baseline.json` 與產生它們的 `scripts/write-model-tools-baseline.ts` |
| 文件 | [怎麼加一個 Adapter 或工具](../development/adding-an-adapter.md)（中英文）、本紀錄（中英文）、[目前實作狀態](../Current_Implementation_Status.md) 的 App Integration Layer 一列 |

**與 24 §3.3 原文的差異**：原文寫 `registry.catalog()`。實際是 `catalog.ts` 的 `liveCatalog(registry)`：總表要讀全部 10 個 Adapter 模組，如果放進 `registry.ts`，登記表就要 import 所有 Adapter，依賴方向反過來。`registry.capabilities()` 仍然沒有呼叫端，這一批沒有動它。

## 3. 指令與結果

在 `prototype/ambient-shell`：

| 指令 | 結果 |
|---|---|
| `npm run catalog -- --check` | `能力總表檢查通過：41 個工具（36 個列在給人看的表、5 個 hidden）`，結束碼 0 |
| `npm run typecheck` | 0 個錯誤（`tsc` 包含 `tests/`） |
| `npx vitest run tests/capability-catalog.test.ts` | 1 檔，23 項通過 |
| `npx vitest run` | 181 檔，3,399 項通過、6 項跳過（共 3,405） |

repo 根目錄：

| 指令 | 結果 |
|---|---|
| `node scripts/verify-aios.mjs` | PASS（型別檢查、181 檔 3,399 項通過 6 項跳過、建置、隔離 mock HTTP 流程 8 項檢查）。Pi 的 `ssh-keygen` 試跑因容器沒有安裝而略過，原本就會略過 |
| `node scripts/check-pstack.mjs` | 通過：`pstack 0.15.29: 172 upstream hashes, 56 skills in both clients, agents and model roles verified.` |
| `node scripts/check-bilingual-docs.mjs` | 審閱兩版之後 `--record`，重跑通過：150 份文件、149 組完整配對、1 份同檔雙語規範 |

## 4. Gate 的證據

### 4.1 送給模型的工具 JSON 逐字相同

做法：先在**沒有修改**的程式上產生基準檔，單獨 commit（`0ef8773`），之後才改程式。

- `tests/fixtures/model-tools.ts` 註冊全部 10 個已審核的 Adapter（依賴都是測試替身，全部啟用），產生 26 份輸出：
  - `functionSpecs()`：`api_key`、`live` 兩條路徑 × `zh-TW`、`en` 兩種語言 × `voice_relay` 的 `fake`、`mac` 兩種模式，共 8 份。
  - `buildRealtimeTools()`（`server/realtime.ts` 的工具表，含 `REALTIME_TOOLS`、`home_status`／`home_control`、`recall_memory`）：同樣的 8 種組合 × 有沒有上網查詢 2 種，共 16 份；加上沒有整合層時兩種語言各 1 份，共 2 份。
  - 8 + 16 + 2 = 26。
- `tests/capability-catalog.test.ts` 把現在的輸出與基準檔逐字串比對，26 份都相同。
- 另一項測試確認每一份函式規格剛好等於 `{ type, name, description, parameters }`，`description` 與 `parameters` 就是原本的 `description`／`descriptionEn` 與 `inputSchema`。
- 加完總表欄位後重新產生一次基準檔，內容沒有變（`git diff` 沒有差異）。

### 4.2 `/help/commands` 與 README 指令表不變

新的翻譯鍵進的是共用翻譯表，有可能改到別處的英文。所以在加翻譯**之前**另外產生 `tests/fixtures/commands-page.baseline.json`（`renderCommandsPage` 的中文與英文頁、`renderCommandsMarkdown()`），單獨 commit（`830d2f2`）。加完翻譯後，3 份輸出都與基準檔逐字相同。

翻譯鍵的衝突另外人工檢查過：127 個鍵都不在 `shared/messages.en.json`，也不在原本的 `server/messages.en.json`。「定時器」「鬧鐘」「貪睡」已在 `src/messages.en.json` 或 `desktop/messages.en.json`；頁面與桌面 App 先載入伺服器的表再載入自己的表，同一個鍵以自己的表為準，所以畫面不變。「再見」在 `src/live-voice.ts` 的 `LOCAL_GOODBYES` 只用來比對語句，沒有經過翻譯。

### 4.3 設定畫面不變

設定畫面的 `integrations.tools` 只取 `functionSpecs("api_key")` 的函式名稱，已在 4.1 涵蓋。這一批沒有改 `server/app.ts`、`server/routes/settings.ts` 或任何 `src/` 檔。

### 4.4 檢查會在該失敗的時候失敗

`tests/capability-catalog.test.ts` 對 `checkCatalog()` 各放一個錯誤，確認回報對應的問題：summary 空白、沒有例句、有一句空白例句、summary 沒有英文、例句沒有英文、needs 沒有英文、`domain` 不合法、兩個工具同一個 ID、頁面工具的名稱撞到整合工具的函式名稱、服務名稱沒有英文、模擬或 Facade 工具沒標 `hidden`。

## 5. 數字的計算方式

| 數字 | 怎麼算 |
|---|---|
| 32 個整合工具 | `ADAPTER_CATALOGS` 每份 `tools.length` 的總和，測試同時要求等於 32。另以 [24 §7](../24_Capability_Catalog_and_Skills_2026-11.md#7-數字的計算方式) 的 `grep -rhoE '"app\.[a-z_]+\.[a-z_]+"' server/integrations/adapters | sort -u | wc -l` 交叉確認，得到 32 |
| 9 個頁面工具 | `HOST_TOOL_NAMES` 的長度；測試要求總表的頁面工具依序等於它 |
| 41 個工具 | 32 + 9，`npm run catalog -- --check` 的輸出 |
| 5 個 hidden | `app.mock.echo`、`app.mock.toggle`、`app.home.status`、`app.home.control`、`app.home.confirm`，測試逐一列出 |
| 36 個列在給人看的表 | 41 − 5 |
| 127 個翻譯鍵 | 新舊 `server/messages.en.json` 的鍵數差：788 − 661。其中 126 個是總表文字（11 個服務名稱、41 個 summary、65 句不重複的例句、9 句不重複的 needs），1 個是 `--markdown` 最後一行 |
| `domain` 分布 | planning 17、visual 9、auditory 4、math 3、language 3、`null` 5；由 `npm run catalog -- --json` 的輸出統計 |
| 26 份基準輸出 | 見 4.1 |

## 6. 沒有做的事（照實寫）

- **不是產品 gate，也不是 Mac 實機驗收。** 沒有真實語音，沒有真實電視、日曆、Gmail、天氣或音箱。
- `domain` 只有資料與檢查，沒有接腦區動畫（CAP-6）。
- `ASK_THE_AI`、`TIMER_ASK` 與 `/help/commands` 沒有改由總表產生（CAP-2、CAP-4）。電視、日曆、寄信、天氣的列還不在指令表上。
- 即時總表只是一個函式，沒有 HTTP 端點，也沒有給模型（CAP-3）。
- 即時總表裡頁面工具沒有能力狀態：要看即時語音路徑的能力（上網查詢、中控），CAP-1 沒有推導。
- 沒有技能（SKL-*）、沒有新的權限或安全機制、沒有常駐畫面；Spotify 仍是 SP-2 BLOCKED，沒有工具。

## 7. 待 George 決定

- `domain: null` 用在家電控制（`home_control`、`app.home.control`）、家電確認卡與模擬工具：沒有合適的腦區，呼叫時不亮。如果希望家電控制也亮某一區，CAP-6 前告訴我們是哪一區。
- 天氣與家電感測值放在數理區（讀數字與資料），日夜間模式與畫面上的搜尋結果放在視覺區。這是 CAP-1 的選擇，CAP-6 接動畫前可以改。
