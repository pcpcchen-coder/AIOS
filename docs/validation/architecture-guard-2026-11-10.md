<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-guard-2026-11-10.md) | [English](architecture-guard-2026-11-10.en.md)

# 架構守門測試 S2（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §3 的 S2；基準數字的算法見[架構盤點的量測與基準線](architecture-review-2026-11-09.md)。**這是靜態分析加上雲端容器的自動化測試，不是產品 gate，也不是實機驗收；它只證明分層與規模沒有在不知情的情況下比基準更差，不代表任何功能可用。**

## 1. 範圍

- 分支 `claude/arch-s2-guard-test`，建立在 `claude/architecture-review-2026-11` 的 `3cc1401` 之上；尚未合併到 main。
- 不改產品行為，不動 `prototype/ambient-shell/{server,shared,src,desktop}` 的任何原始碼。
- 變更：`scripts/architecture-metrics.mjs`（改成可 import）、新增 `scripts/architecture-metrics.d.mts`（型別宣告）、新增 `prototype/ambient-shell/tests/architecture.test.ts`、本紀錄與索引、23 §3 的 S2 列補記。

## 2. 量測腳本改成可 import

- `collectImportGraph(shellDir)`：只算規模與 import 圖（檔數、行數、超過 800 行的檔、fan-in／fan-out、跨層 import、import 環）。只需要分層目錄，不存在的分層略過，所以可以拿來量測試用的假目錄。
- `collectMetrics(shellDir)`：上面的結果加上盤點專用的數字（路由比對數、寫檔方式、測試分類等），需要完整的 `prototype/ambient-shell`。
- 另外匯出 `DEFAULT_SHELL_DIR`、`LAYERS`、`ALLOWED_IMPORTS`、`LINE_LIMIT`（800）。
- 命令列行為不變：只有直接執行這個檔才印結果（比對 `process.argv[1]` 與本檔的實際路徑），被 import 時不印、不做事。
- 前後輸出比對：重構前後在同一份原始碼上執行 `node scripts/architecture-metrics.mjs` 與 `--json`，用 `cmp` 逐位元組比對，兩者都相同（兩次都在 2026-11-10 執行，`measured_at` 也相同）。

## 3. 守門規則

測試量的是測試檔所在的原型目錄（`tests/` 的上一層）。

| 規則 | 判定 | 允許清單 |
|---|---|---|
| 跨層 import | 必須是 0。允許的方向：`server→{server,shared}`、`src→{src,shared}`、`desktop→{desktop,shared}`、`shared→shared` | 無 |
| import 環 | 「環」指 import 圖的強連通分量（兩個檔以上，含 type-only import）。找到的每一個分量必須是允許清單某一組的子集合：分量可以變小、分裂或消失，不能包含清單外的檔。分量內部多一條 import 不會被擋（見第 6 節） | 4 組（見下） |
| 超過 800 行的檔 | 每一個都必須在允許清單內；新檔與其他檔須維持在 800 行以內，或依 3.2 的例外加入清單 | 16 個（見下） |
| 清單上限 | 環的清單不多於 `MAX_ALLOWED_CYCLES`（4）組、`MAX_ALLOWED_CYCLE_FILES`（18）個檔；大檔清單不多於 `MAX_ALLOWED_LARGE_FILES`（16）個且不重複。加項目時要一起調高常數，讓這件事在 diff 裡看得見 | — |
| 不是空量測 | 四層都量到，來源檔多於 200 個 | — |

允許的 4 組環（基準 `3cc1401`）：

1. `shared/realtime-route.ts`、`shared/seconds-menu.ts`、`shared/types.ts`、`shared/voice-cost.ts`
2. `server/apikey-call.ts`、`server/codex-auth.ts`、`server/codex-responses.ts`、`server/live-tool-caller.ts`、`server/memory/live.ts`、`server/proactive-calendar.ts`、`server/realtime-routes.ts`、`server/web-search.ts`
3. `server/memories-google.ts`、`server/memories.ts`
4. `src/api.ts`、`src/realtime-session.ts`、`src/realtime-tools.ts`、`src/realtime.ts`

允許的 16 個大檔（括號內是基準行數，只供對照，不參與判斷）：`src/main.ts`（4,211）、`server/memory/service.ts`（2,613）、`src/views.ts`（2,028）、`server/identity-service.ts`（1,684）、`server/home-bridge.ts`（1,655）、`desktop/main.mjs`（1,523）、`server/app.ts`（1,369）、`server/memory/live.ts`（1,361）、`server/realtime-routes.ts`（1,275）、`src/family-view.ts`（1,259）、`src/realtime.ts`（1,080）、`server/store.ts`（1,029）、`src/live-voice.ts`（884）、`src/brain.ts`（873）、`src/memory-view.ts`（836）、`server/live-route.ts`（811）。行數用 `text.split("\n").length`（檔尾有換行的檔比 `wc -l` 多 1）。

目前接近上限、下一個功能可能就會碰到的檔（2026-11-10 用同一個算法量）：`desktop/settings-menu.mjs` 785、`server/integrations/adapters/lg-tv.ts` 751、`server/nous.ts` 705、`server/apikey-call.ts` 701、`server/alarms.ts` 695。它們超過 800 行時測試會失敗，處理方式見 3.2。

### 3.1 大檔規則的選擇

只檢查「是否在清單內」，**不限制清單內的檔再長多少**。理由：目前的優先順序是功能便利性（`CLAUDE.md`，2026-10-31），一般功能仍會改到 `src/main.ts`、`server/app.ts`；再加逐檔行數上限會讓日常功能 PR 在 CI 失敗。這些大檔的瘦身由 23 §3 的 S6–S14 處理。

### 3.2 怎麼更新清單

- 兩份清單與三個上限常數都寫在 `tests/architecture.test.ts`。預設是只刪不加。
- 拆掉一組環、把某個檔移出環，或把大檔拆到 800 行以內之後，在同一個 PR 刪掉對應項目。
- 測試因為新的環或新的大檔失敗時，先考慮改程式：把共用型別移到 `shared/`、拆出小模組、解開環。
- **有意識的例外**（目前功能便利性優先）：功能 PR 若現在拆檔或解環不合理，**可以**加一筆項目，條件是 (1) 項目旁邊加一行註解寫原因；(2) 同時調高對應的上限常數；(3) 在 PR 說明提到。這個測試的目的是讓變差是被看見、被決定的，不是擋住功能。
- 跨層 import 沒有允許清單（基準是 0）。真的需要例外時，在同一個 PR 為這條規則加一份允許清單（每筆一行原因）、更新本紀錄，並在 PR 說明提到。
- 每個失敗訊息都會寫出規則、該怎麼做、上述例外與本文件的路徑。

## 4. 反向自我測試（fixture）

測試在系統暫存目錄建立一個假目錄樹（fixture，與產品原始碼無關，測試結束後刪除），內容是：`server/bad.ts` import `src/page.ts`（跨層）、`shared/a.ts` 與 `shared/b.ts` 互相 import（環，其中一邊是 type-only）、801 行的 `src/huge.ts`；對照組是剛好 800 行的檔、合法方向的 import、以及應被排除的 `.d.ts` 與 `*.test.ts`。斷言量測腳本只回報這三項違規，而且三條守門規則用同一組函式都判定違規。

另外在真實原始碼上手動驗證一次（之後還原，沒有提交）：在 `shared/domain.ts` 末尾加 `import type {} from "../server/store.ts";`，`npx vitest run tests/architecture.test.ts` 的結果是 8 項中 2 項失敗——跨層規則回報 `shared/domain.ts -> server/store.ts`，環的規則回報一組 11 個檔的新環。

## 5. 驗證結果

環境：Linux 雲端容器、Node.js v22，依賴沿用既有的 `node_modules`（vitest 5.0.3）。沒有麥克風、鏡頭、Mac、Pi、中控或電視。

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過 |
| 守門測試單獨執行 | `npx vitest run tests/architecture.test.ts` | 1 個測試檔、8 項通過 |
| 單元與整合測試 | `npx vitest run` | 173 個測試檔通過；3,202 項中 3,196 項通過、6 項跳過；54 秒（比基準多 1 檔 8 項，就是這個測試） |
| 前端建置 | `npx vite build` | 通過；既有的 chunk 超過 500 kB 警告不變 |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS；其中的測試是 173 檔、3,197 項通過、5 項跳過（跳過數依環境而異，見基準紀錄）。rpi4 終端機套件的 dry-run 因容器沒有 `ssh-keygen` 而印出 skip，屬部分執行 |
| 量測腳本輸出 | `node scripts/architecture-metrics.mjs`、`--json` | 重構前後逐位元組相同 |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過 |
| 空白 | `git diff --check` | 通過 |

`scripts/verify-aios.mjs` 是在 `prototype/ambient-shell` 原地執行 `npm run test`，只有啟動伺服器那一段才複製 `server`、`shared`、`dist` 到暫存目錄，所以測試找得到 `../../../scripts/architecture-metrics.mjs`。測試用靜態 import：腳本不在時整個測試檔載入失敗而變紅，不會悄悄跳過。

## 6. 限制

- 靜態分析，以正規表示式找相對路徑的 import，不解析語法樹；註解或字串裡長得像 import 的文字也會被算進去（偏向多報），非相對路徑的 import 不看。
- CommonJS 的 `require()` 不看（來源裡唯一的 `.cjs` 是 `desktop/preload.cjs`），所以經 `require()` 的跨層或環不會被發現。
- 環的檢查是以強連通分量為單位，不是逐條邊或逐個基本環：
  - 已在清單內的分量裡多一條 import、或多一個基本環，只要成員沒有超出清單就會通過。
  - 分量變小之後，在清單項目還沒收緊之前，可以再長回清單記錄的那一組而不被擋。
  - 把清單的一筆項目換成另一筆（總數不變）不會碰到上限常數，只會在 diff 裡看得見。
  - type-only import 也算邊；型別環在執行期無害，但同樣會讓測試失敗。
- 所以「沒有新的環」的準確說法是：沒有出現包含清單外檔案的強連通分量。
- 不量執行時行為，也不檢查模組內部的品質；通過不代表架構良好，只代表沒有在不知情的情況下比基準更差。
- 例外規則靠註解、上限常數與 PR 說明讓人看見，測試本身無法檢查原因是否合理或 PR 說明有沒有寫。
- 大檔清單內的檔可以繼續變大（見 3.1）。清單內的檔降到 800 行以下後若沒有刪掉項目，之後又長回來不會被擋。
- 盤點紀錄 3.6 的測試分類會變成 173 檔，新測試依「檔案全文含 `server/app.ts`」的規則被歸在「伺服器 HTTP」（23 → 24），實際上它不啟動伺服器；這是分類用正規表示式的限制，沒有修改分類規則。
- 測試全綠只是 mock／fixture 的程式檢查，不是 G0–G3 或任何 Mac／Pi gate。
