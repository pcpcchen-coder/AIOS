<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-review-2026-11-09.md) | [English](architecture-review-2026-11-09.en.md)

# 架構盤點的量測與基準線（2026-11-09）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md)。這份紀錄只說明數字怎麼算、在哪個 commit 算、以及基準線的驗證結果。**全部是靜態分析與雲端容器的自動化測試，不是產品 gate，也不是實機驗收。**

## 1. 環境

- 基準：main `416a1ab`（PR #138 之後），分支 `claude/architecture-review-2026-11`。
- Linux 雲端容器、Node.js v22.23.4、`prototype/ambient-shell` 以 `npm ci` 安裝依賴（vitest 5.0.3、TypeScript 7.0.2、Vite 8.3.4）。
- 沒有麥克風、鏡頭、Mac、Pi、中控或電視；沒有任何真實帳號。

## 2. 基準線驗證（改文件之前，在 main 上）

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過，2.5 秒 |
| 單元與整合測試 | `npx vitest run` | 172 個測試檔通過；3,194 項中 3,188 項通過、6 項跳過；54 秒。跳過數依環境而異：同一容器稍後重跑是 3,189 項通過、5 項跳過（`apikey-integration.test.ts:193` 等用 `describe.skipIf(!realLockAvailable)`） |
| 前端建置 | `npx vite build` | 通過；警告 `zh-tw-opencc` chunk 1,070 kB 超過 500 kB |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS，66 秒（型別、測試、建置、隔離 mock 任務與對話 HTTP） |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過：135 份、134 組完整配對、1 份 inline |
| 空白 | `git diff --check` | 通過 |

## 3. 量測腳本

`node scripts/architecture-metrics.mjs`（加 `--json` 輸出完整 JSON）。唯讀：只讀 `prototype/ambient-shell/{server,shared,src,desktop}` 與 `tests/`，不執行程式、不連網、不寫檔。排除 `.d.ts`／`.d.mts`、`*.test.ts`、`node_modules`、`dist`、`desktop/scripts/`（建置腳本）。

### 3.1 規模與大檔

| 層 | 檔案 | 行數 |
|---|---|---|
| server | 102 | 30,844 |
| src | 92 | 25,626 |
| shared | 38 | 7,721 |
| desktop | 9 | 2,696 |
| 合計 | 241 | 66,887 |

行數用 `text.split("\n").length`（含最後的空行，所以比 `wc -l` 多 1）。超過 800 行：16 個檔，清單見 23 §1.1。

### 3.2 import 圖

- 只看相對路徑 import（`import … from "./x.ts"`、`import("./x.ts")`、`import "./x.ts"`、`export … from`），含 type-only import。解析順序：原字串、`.ts`、`.mts`、`.mjs`、`.js→.ts`、`/index.ts`。
- 允許的方向：`server→{server,shared}`、`src→{src,shared}`、`desktop→{desktop,shared}`、`shared→shared`。**跨層違規：0**。
- 用 Tarjan 強連通分量找環，結果 **4 組**：
  1. `shared/realtime-route.ts` ↔ `shared/seconds-menu.ts` ↔ `shared/types.ts` ↔ `shared/voice-cost.ts`（全部 type-only）
  2. `server/apikey-call.ts` ↔ `server/codex-auth.ts` ↔ `server/codex-responses.ts` ↔ `server/live-tool-caller.ts` ↔ `server/memory/live.ts` ↔ `server/proactive-calendar.ts` ↔ `server/realtime-routes.ts` ↔ `server/web-search.ts`（含執行期值：`realtime-routes.ts:36` ↔ `apikey-call.ts:7`）
  3. `server/memories-google.ts` ↔ `server/memories.ts`（一邊 type-only）
  4. `src/api.ts` ↔ `src/realtime-session.ts` ↔ `src/realtime-tools.ts` ↔ `src/realtime.ts`（`api.ts:22` 是值 import，其餘 type-only）
- fan-out 最高：`src/main.ts` 67、`server/nous.ts` 62、`server/app.ts` 51、`src/views.ts` 27、`src/api.ts` 22。fan-in 最高：`shared/i18n.mjs` 40、`shared/types.ts` 37、`shared/identity.ts` 26、`shared/realtime-route.ts` 24、`shared/sense.ts` 23。

### 3.3 HTTP 路由 85 條（人工逐行點算）

腳本只算 `app.ts` 裡 `path === "/api/…"`、`path.startsWith(…)`、`path.match(/^\/api…/)` 的比對數，與路由數不相等（一行可含多個動詞或子路徑）。85 條是依 `grep -nE "path ===|path\.match|startsWith\(" server/app.ts` 在 `handleApi`（404-1053）內逐行列出，規則：
- 鬧鐘區塊（527-569）每個子路徑算一條（9 條）。
- `/api/terminal/display` 的 GET 與 POST 算兩條；`/api/tasks/:id/(cancel|retry)` 算兩條。
- 語音中繼 `server/integrations/voice-relay/routes.ts` 的 `GET` 加 9 個 `case` 算 10 條。
- 非 API 分派 5 條：`/help/commands`、`/face-runtime/*`、`/speaker-runtime/*`、`/wake-runtime/*`、靜態頁。
- `realtime-routes.ts`、`live-route.ts`、`home-bridge.ts`、`memory/` 裡的 `/commands`、`/infrared-commands`、`/aifa/discover` 是對外送出的中控網址，不是路由。

### 3.4 設定檔寫入

- 自己呼叫 `renameSync` 的 server 檔：16 個，其中 `prefs-file.ts` 是共用 helper 本身，所以繞過它的是 15 個（`alarms`、`chatgpt-auth`、`codex-auth`、`identity-store`、`integrations/voice-relay/store`、`lgtv/store`、`memories-google`、`memory/store`、`nous`、`prefs-file`、`proactive`、`providers`、`sealed-vault`、`store`、`task-migration`、`voice-cost-log`）。
- import `prefs-file.ts` 的 server 檔：11 個（`audio-`、`camera-`、`clock-`、`day-night-`、`face-tuning-`、`home-corner-`、`realtime-`、`voice-`、`wake-settings`、`memories`、`proactive`）。`proactive.ts` 兩邊都算：設定走 PrefsFile，每日紀錄自己寫。
- `server/app.ts`：`localizeSettings(settings.view(pageSource` 出現 18 次；錯誤字串「沒有保存（無法寫入設定檔」出現 12 次。

### 3.5 兩條即時語音頁面類別

`src/realtime.ts` 與 `src/live-voice.ts` 同名的 `private` 方法 13 個：`cancelGreetTimer`、`close`、`greetIfPending`、`handle`、`onCore`、`onHostCall`、`quietLocalCommand`、`scheduleGreeting`、`setPhase`、`skipGreeting`、`stopEarlySpeech`、`teardown`、`watchEarlySpeech`（正規表示式 `^\s+private\s+(async\s+)?name\(`）。同名不代表內容相同；23 §P1-2 逐一比對過的是問候四個、先開口兩個、`onCore`、`onHostCall`。

### 3.6 測試分類

172 個 `tests/*.test.ts`，依序取第一個符合的類別（看檔案全文）：

| 順序 | 類別 | 正規表示式 | 檔數 |
|---|---|---|---|
| 1 | 桌面 | `\.\./desktop/` | 25 |
| 2 | 伺服器 HTTP | `server/app\.ts` 或 `node:http"` | 23 |
| 3 | 頁面 DOM | `globalThis\.document`、`document\.createElement`、`HTMLElement`、`createElement`、或 `readFileSync(…src|index.html|history.html|style.css)` | 29 |
| 4 | fixture | `\./fixtures/` 或 `\./fixtures\.ts` | 30 |
| 5 | 純函式 | 其餘 | 65 |

不套用先後順序時：22 個檔 import `server/app.ts`，52 個檔用 fixtures。`package.json` 沒有 `jsdom`／`happy-dom`；沒有任何測試用 `@vitest-environment`。

### 3.7 沒有任何測試直接 import 的來源模組（26 個）

`desktop/main.mjs`、`desktop/preload.cjs`、`server/index.ts`、`server/integrations/schema.ts`、`server/integrations/voice-relay/routes.ts`、`server/integrations/voice-relay/store.ts`、`server/lgtv/config.ts`、`server/prefs-file.ts`、`server/sideband.ts`、`shared/identity-validate.mjs`、`shared/memory-validate.mjs`、`src/alarm-ring.ts`、`src/audio/capture-worklet.ts`、`src/audio/capture.ts`、`src/audio/index.ts`、`src/audio/wake-worker.ts`、`src/brain-canvas.ts`、`src/brain-frame.ts`、`src/clock-corner.ts`、`src/format.ts`、`src/history-page.ts`、`src/home-icons.ts`、`src/icons.ts`、`src/main.ts`、`src/sense/identity-worker.ts`、`src/sense/light-worker.ts`。

方法：把 `tests/*.test.ts`、`tests/fixtures.ts`、`tests/fixtures/*.ts` 的相對 import 解析成來源路徑取聯集，再和來源清單相減。「直接 import」而已：很多模組經別的模組間接被測（例如 `prefs-file.ts` 經 11 個 store；`identity-validate.mjs` 經 `desktop/identity-ipc.mjs`），有些測試用讀原始碼文字的方式核對（`wake-threshold`、`audio-privacy`、`camera-privacy`）。

## 4. 文件落差的核對方式

23 §P1-5 表的每一列都用 `grep -n` 在基準 commit 上同時找到文件句子與對應程式（或確認檔案不存在）。驗證紀錄索引的 9 份缺漏是 `ls docs/validation/*.md | grep -v '\.en\.md'`（81 份，不含 README）對照 `docs/validation/README.md` 表列（69 列）得到。

## 5. 限制

- 靜態分析，不量執行時行為；同名方法與相似區塊的「重複」是人工讀碼判斷，數字只算同名。
- 行號會隨後續 PR 漂移；重跑腳本就能更新數字，但 23 的行號引用需要人工更新。
- 基準線的測試全綠只是 mock／fixture 的程式檢查，不是 G0–G3 或任何 Mac／Pi gate。
