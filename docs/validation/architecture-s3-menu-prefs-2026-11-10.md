<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s3-menu-prefs-2026-11-10.md) | [English](architecture-s3-menu-prefs-2026-11-10.en.md)

# 架構重整 S3：`shared/seconds-menu.ts` 改名為 `shared/menu-prefs.ts`（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §P2-7、§P3-11、§3 的 S3。**純改名與型別搬移，行為不變；全部是雲端容器的靜態檢查與自動化測試，不是產品 gate，也不是實機驗收。**

## 1. 環境

- 基準：分支 `claude/architecture-review-2026-11` 的 `3cc1401`；本批在分支 `claude/arch-s3-menu-prefs`，尚未合併。
- Linux 雲端容器、Node.js v22.23.4；依賴沿用基準的 `node_modules`（vitest 5.0.3、TypeScript 7.0.2、Vite 8.3.4）。
- 沒有麥克風、鏡頭、Mac、Pi、中控或電視；沒有任何真實帳號；沒有啟動 Electron App。

## 2. 搬了什麼

- `git mv prototype/ambient-shell/shared/seconds-menu.ts prototype/ambient-shell/shared/menu-prefs.ts`；檔頭註明由 `seconds-menu.ts` 改名。
- import 路徑改 `menu-prefs.ts`：來源檔 `server/app.ts`、`src/terminal-camera.ts`、`shared/voice-commands.ts`、`desktop/settings-menu.d.mts`；測試 `prefs`、`desktop-menu`、`settings-view`、`http`、`backend-i18n`、`desktop-i18n`、`service-mode`（7 個 `*.test.ts`，只改 import 那一行）。`desktop/settings-menu.mjs` 的註解與原型 README 結構樹（中、英）跟著改檔名。
- 新檔 `shared/menu-prefs-types.ts`（只有型別）：`CameraSecondsKey`、`SecondsKey`、`FactorKey`、`CameraBoolKey`、`MenuNumberKey`、`MenuPrefKey`、`MenuPrefOption`、`MenuRowFields`（未匯出）、`MenuNumberSetting`、`MenuBoolSetting`、`MenuPrefSetting`、`SecondsOption`、`SecondsSetting` 原樣搬入；`menu-prefs.ts` 以 `export type { … } from "./menu-prefs-types.ts"` 原樣 re-export，所以其他 importer 不用改。
- `shared/types.ts` 的 `MenuPrefSetting` 改從 `menu-prefs-types.ts` import（唯一改到 import 來源的既有 importer）。
- 沒有改的：匯出的識別字（`describeMenuPrefs`、`describeSeconds`、`SecondsSetting`、`SecondsSource`、`SettingsView.seconds` 等）、三個停用原因字串、函式本體、HTTP 與 SSE 內容。歷史驗證紀錄與 docs/15、docs/23 對問題的敘述保留舊檔名；docs/23 只在 §P3-11 與 S3 列加日期補記。

### 為什麼不照計畫搬到 `shared/prefs.ts`

計畫寫「把 `MenuPrefSetting` 型別搬到 `shared/prefs.ts`」。這組型別的鍵由 `typeof CAMERA_PREFS`（`shared/sense.ts`）與 `VoicePrefs`（`shared/voice-prefs.ts`）推導，而這兩個檔都 import `prefs.ts`；搬進 `prefs.ts` 會新增 `prefs.ts` 與 `sense.ts`、`voice-prefs.ts` 之間的環。改放獨立的型別檔可以達到同一個目的（`types.ts` 不再 import `menu-prefs.ts`），不新增環。

## 3. import 環：前後

指令：`node scripts/architecture-metrics.mjs`（唯讀；含 type-only import）。

改之前（`3cc1401`），4 組，shared 那一組是：

```
shared/realtime-route.ts <-> shared/seconds-menu.ts <-> shared/types.ts <-> shared/voice-cost.ts
```

改之後，仍是 4 組，shared 那一組少了一個成員：

```
shared/realtime-route.ts <-> shared/types.ts <-> shared/voice-cost.ts
```

另外三組沒有變：

```
server/apikey-call.ts <-> server/codex-auth.ts <-> server/codex-responses.ts <-> server/live-tool-caller.ts <-> server/memory/live.ts <-> server/proactive-calendar.ts <-> server/realtime-routes.ts <-> server/web-search.ts
server/memories-google.ts <-> server/memories.ts
src/api.ts <-> src/realtime-session.ts <-> src/realtime-tools.ts <-> src/realtime.ts
```

`menu-prefs.ts` 仍 import `types.ts` 的 `RealtimeBaseInfo`（單向），`types.ts` 不再 import 它，所以它離開了環。

**剩下的 `types.ts` ↔ `realtime-route.ts` ↔ `voice-cost.ts` 沒有處理**：`realtime-route.ts` 從 `types.ts` 取 `Task`（連帶 `TaskStep`、`TaskStatus`、`ExecutorMode`、`ErrorAction` 等一整組），`types.ts` 從 `realtime-route.ts` 取 `RealtimeRouteFields`、`RealtimeServerEvent`；`voice-cost.ts` 取 `RouteId`（由常數 `ROUTE_IDS` 推導），`realtime-route.ts` 取 `VoiceUsage`。要完全解開得搬 `Task` 這組型別或拆 `realtime-route.ts`，超過「搬兩三個型別宣告」的範圍，留給後續批次。

量測腳本其他數字的變動只來自多了一個檔：來源檔 241 → 242、shared 38 → 39 檔、沒有被測試直接 import 的模組 26 → 27（多的是只有型別的 `shared/menu-prefs-types.ts`）。跨層 import 仍是 0，超過 800 行的檔仍是 16 個。

## 4. 行為不變的證據

- 測試除了 import 路徑以外沒有改，全數通過（見 §5）。直接呼叫 `describeMenuPrefs`／`describeSeconds` 的測試：`tests/prefs.test.ts`（24 處，含每一列的鍵、選項、標籤、停用原因與 `describeSeconds` 過濾）、`desktop-menu.test.ts`、`settings-view.test.ts`、`backend-i18n.test.ts`、`desktop-i18n.test.ts`、`service-mode.test.ts`；`http.test.ts` 經 `/api/settings` 的 `SettingsView.seconds` 與 `isNumberRow` 間接驗。
- 一次性比對（腳本用完即刪，未提交）：把 `3cc1401` 的 `seconds-menu.ts` 與新的 `menu-prefs.ts` 同時載入，對 8 種鏡頭設定 × 3 種即時語音狀態 × 2 種語音可寫狀態共 48 組輸入，各呼叫 `describeMenuPrefs` 與 `describeSeconds`（96 個輸出）並加上 `cameraPreviewDisabledReason`，JSON 序列化後 SHA-256 相同（`15ccccafe87c4213…`）；兩個模組的執行期匯出名稱清單相同（7 個）。
- `tests/__snapshots__/` 只有 `wake-flag-off.test.ts.snap`，沒有內嵌舊檔名；`desktop/scripts/`、`scripts/`、`package.json`、`tsconfig*.json`、`vite.config.ts`、`spike/` 都沒有引用舊檔名。

## 5. 指令與結果

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過 |
| 型別檢查（含 spike） | `npm run typecheck` | 通過（主專案、`spike/face`、`spike/wake` 三個 tsconfig） |
| 單元與整合測試 | `npx vitest run` | 172 個測試檔通過；3,194 項中 3,188 項通過、6 項跳過；53 秒（與基準相同的檔數與項數） |
| 前端建置 | `npx vite build` | 通過；同基準的 chunk 超過 500 kB 警告 |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過（`--record` 之後重跑） |
| 空白 | `git diff --check` | 通過 |
| import 環 | `node scripts/architecture-metrics.mjs` | 見 §3 |

## 6. 限制

- 沒有啟動 Electron App，沒有在 Mac 上看選單列；選單列的畫法只由既有的 `desktop-menu.test.ts` 等測試覆蓋。
- §4 的一次性比對沒有進測試套件；長期的保障是既有測試。
- shared 的型別環只縮小、沒有消失；環數仍是 4 組。
- `SettingsView.seconds`、`describeSeconds`、`SecondsSetting` 等沿用「seconds」的識別字是 API 名稱，這一批沒有改。
