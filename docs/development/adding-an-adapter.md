<!-- bilingual: source=zh-TW -->

> [繁體中文](adding-an-adapter.md) | [English](adding-an-adapter.en.md)

# 怎麼加一個 Adapter 或工具

版本：2026-11-24（CAP-1）。適用 `prototype/ambient-shell`。給在本 repo 開發的人與開發 Agent。設計背景見 [18 App Integration Layer](../18_App_Integration_Layer_and_Spotify_2026-11.md) 與 [24 能力總表與技能目錄](../24_Capability_Catalog_and_Skills_2026-11.md)；這一批的驗證見 [CAP-1 驗證紀錄](../validation/cap-1-capability-catalog-2026-11-24.md)。

以下路徑都在 `prototype/ambient-shell/` 底下。

## 1. 先決定是哪一種工具

| | 整合工具（建議） | 頁面工具 |
|---|---|---|
| 名稱 | `app.<service>.<action>`，模型看到 `app__<service>__<action>` | 自己的名稱，列在 `shared/realtime-route.ts` 的 `HOST_TOOL_NAMES` |
| 誰執行 | 核心的 Dispatcher（兩條即時語音路徑相同） | 頁面的工具執行器 |
| 要改的地方 | 一個 Adapter 檔、`index.ts`、`catalog.ts`、翻譯表 | 第 6 節列的 5 個步驟 |

新的服務一律做成整合工具。頁面工具只留給必須在頁面上執行的事（例如畫面上的搜尋結果）。

## 2. 加一個新的 Adapter

1. 新增 `server/integrations/adapters/<名稱>.ts`。在**模組層級**宣告 `const TOOLS: readonly ToolDefinition[]`，不要在 `tools()` 方法裡才組。靜態總表不建立 Adapter 就要讀得到這些定義：缺設定時 factory 回 `null`，執行中的登記表看不到這個 Adapter。
2. 每個工具都要寫齊：
   - 給模型的 `description`（中文）與 `descriptionEn`、`inputSchema`、`effect`、`enabled`、`timeoutMs`、`supportedRoutes`。
   - 給人的 `catalog`，寫法見第 4 節。`catalog` 是必填欄位，漏了 `tsc` 會失敗。
3. 同一個檔匯出靜態資料：

   ```ts
   export const EXAMPLE_CATALOG: AdapterCatalog = { id: "example", service: "example", label: "範例服務", mock: false, tools: TOOLS };
   ```

   `id`、`service` 必須等於 Adapter 類別的 `id`、`service`（測試會比對）。`mock` 寫 `true`（一定是模擬）、`false`，或 `"config"`（依設定，例如 `voice_relay` 在 `NOUS_VCR=fake` 時是模擬）。
4. 工具的 schema 要看設定才知道時（例如 `voice_relay` 的音箱 `enum`），把不看設定的部分宣告成一個 `CatalogTool` 常數放進 `tools: [...]`，`tools()` 再加上 schema 組出完整定義。照 `adapters/voice-relay.ts` 的 `RELAY_TOOL_STATIC` 做。
5. 類別實作 `IntegrationAdapter`：`tools()` 回 `TOOLS`；`health()` 只回固定的原因代碼；`execute()` 一律用 `toolResult()` 回結果。只有讀回確認才是 `confirmed`；送出但沒有讀回是 `unconfirmed`；逾時或結果不明是 `unknown`。
6. 在 `server/integrations/index.ts` 的 `KNOWN_ADAPTERS` 加 factory。缺設定時回 `null`，並用 `log` 寫出缺哪個設定。核心內建、不經 `NOUS_AIL_SERVICES` 的工具（定時器、鬧鐘）改由 `createIntegrations` 的 `builtins` 傳入，並在靜態資料加 `builtin: true`。
7. 在 `server/integrations/catalog.ts` 的 `ADAPTER_CATALOGS` 加上 `EXAMPLE_CATALOG`。漏加時 `tests/capability-catalog.test.ts` 會失敗：它要求清單等於 `KNOWN_ADAPTERS` 加上 `timer`、`alarm`。
8. 在 `server/messages.en.json` 加上服務名稱、每句 `summary`、每句例句與 `needs` 的英文。鍵是中文原文。
   - 先確認同一句沒有出現在 `src/messages.en.json` 或 `desktop/messages.en.json`。頁面與桌面 App 先載入伺服器的表，再載入自己的表，同一個鍵以自己的表為準。
   - 也不要讓新鍵剛好等於畫面上另一處要求翻譯、但原本刻意沒有翻譯的文字。
9. 測試：
   - 為 Adapter 自己寫 fixture 測試（假的外部服務，不連網路）。
   - 在 `tests/fixtures/model-tools.ts` 的 `modelToolAdapters()` 加上這個 Adapter 的實例。
   - 模型會看到新工具，所以 `tests/fixtures/model-tools.baseline.json` 一定會變。在 `prototype/ambient-shell` 執行 `npx tsx scripts/write-model-tools-baseline.ts --model-tools` 重新產生，並在 PR 說明這是刻意的改變。只改總表文字時不要重跑；那時測試的用途就是證明模型看到的內容沒有變。
10. 跑第 5 節的檢查。

## 3. 在既有的 Adapter 加一個工具

在那個 Adapter 的 `TOOLS` 加一筆，寫齊第 2 節第 2 步的欄位與英文翻譯，再照第 2 節第 9 步重新產生模型工具的基準檔、跑第 5 節的檢查。Registry 會拒絕不屬於這個 Adapter 服務的 ID、重複的 ID、不支援的 schema、不合法的時限與路徑。

## 4. 總表欄位怎麼寫

| 欄位 | 規則 |
|---|---|
| `summary` | 一句話：這個工具替使用者做什麼。用「你」稱呼使用者，不寫給模型的指示（那是 `description` 的事）。限制要照實寫，例如「電視不回報播放狀態」「結果最多是已發出、未確認」 |
| `examples` | 至少一句。先讀 `execute()` 的實際行為再寫：必須是使用者真的會說、而且這個工具真的做得到的話。不要照工具名稱猜。頁面工具的例句取自 `shared/voice-commands.ts` 的 `ASK_THE_AI`（測試比對） |
| `needs` | 前提，例如要設定的環境變數、要先配對。沒有就不寫；不要寫空字串 |
| `domain` | 真實工具呼叫要連動的腦區（George 2026-11-24 決定 3；動畫接線是 CAP-6）。值是 `shared/domain.ts` 的腦區 ID，或明寫 `null`＝不對應任何腦區、呼叫時不亮 |
| `hidden` | 模擬工具與 legacy Facade 工具一定要寫 `hidden: true`，不列在給人看的表。檢查會擋下沒標的 |

`domain` 目前的對應方式（CAP-1 的選擇，CAP-6 接動畫前可以再調整）：

| 腦區 | 用在 |
|---|---|
| `language` 語言區 | 文字與對話：寄信、上網查詢後回答、結束對話 |
| `math` 數理區 | 讀數字與資料：天氣、家電感測值 |
| `art` 藝術區 | 目前沒有工具 |
| `auditory` 聽覺區 | 聲音：電視音量與靜音、Nous 說話的音量、語音中繼 |
| `visual` 視覺區 | 畫面：電視開關、輸入源、App、播放；畫面上的搜尋結果；日夜間模式 |
| `planning` 規劃區 | 時間與安排：定時器、鬧鐘、日曆、交辦任務 |
| `null` | 沒有合適的腦區：家電控制、模擬工具、確認卡 |

腦區是象徵性的分類，不是模型的神經活動。`domain` 只是資料；沒有真實的工具呼叫時不能亮。

## 5. 交付前的檢查

在 `prototype/ambient-shell`：

```bash
npm run catalog -- --check
npm run catalog -- --markdown
npm run catalog -- --json
npm run typecheck
npx vitest run tests/capability-catalog.test.ts tests/commands-from-catalog.test.ts
npm run docs:commands
```

`--check` 在漏寫 summary 或例句、缺英文、`domain` 不合法、ID 撞名，或模擬／Facade 工具沒標 hidden 時失敗；`--markdown` 是給人看的表、`--json` 是靜態總表，兩者都可以加 `--lang en` 看英文。

repo 根目錄：`node scripts/verify-aios.mjs`、`node scripts/check-bilingual-docs.mjs`。

SKL-1（2026-11-24）起，`--check` 也檢查出貨技能：改名或移除工具、或把工具改成 hidden 時，用到它的技能會讓檢查失敗，要同一個 PR 改技能（見[怎麼寫一份技能](writing-a-skill.md)）。

`--check` 與 `tests/capability-catalog.test.ts` 共用 `checkCatalog()`。這些都是 fixture 與型別檢查，不能拿來宣稱真實語音或真實服務已驗證。

## 6. 加一個頁面工具

照 [S8 驗證紀錄](../validation/architecture-s8-tool-names-2026-11-10.md)「加一個頁面工具時要改的地方」那 4 步，再加第 5 步：

5. 在 `server/integrations/catalog.ts` 的 `HOST_TOOL_CATALOG` 加一筆（型別要求 `HOST_TOOL_NAMES` 的每個名稱都要有一筆，漏了 `tsc` 會失敗），例句取自你寫進 `ASK_THE_AI` 的句子，英文加在 `server/messages.en.json`。

CAP-2 起，整合工具（含定時器與鬧鐘）在 `/help/commands` 與原型 README 的列由總表產生：加好總表資料後，非 hidden 的工具自動出現在「App 整合」（核心內建的出現在「定時器與鬧鐘」），不用再手寫指令表；只要在 `prototype/ambient-shell` 跑 `npm run docs:commands` 更新 README 並重新產生 `tests/fixtures/commands-page.baseline.json`（`npx tsx scripts/write-model-tools-baseline.ts --commands`），並在 PR 說明多了哪些列。頁面工具仍由 `ASK_THE_AI` 產生（CAP-4）。

## 7. 不能做的事

- 不動態載入第三方程式碼；Adapter 只由程式碼註冊。模型沒有任何方法新增、啟用或設定工具。
- Spotify 語音控制仍然是 SP-2 BLOCKED：Registry 拒絕任何 `app.spotify.*` 工具。
- `external_commit` 要當次確認；確認卡還沒接上，所以目前一律拒絕。唯一的例外列在 `server/integrations/policy.ts` 的 `CONFIRMATION_EXEMPT_TOOLS`（寄信給自己，George 2026-11-04 的決定）。不要為新工具加例外，除非使用者明確決定。
- 不為了工具加 App launcher、圖示、常駐側欄或 Dashboard。
- 總表欄位不能進給模型的 schema。`functionSpecs()` 只取 `description` 與 `inputSchema`，測試逐字比對。
