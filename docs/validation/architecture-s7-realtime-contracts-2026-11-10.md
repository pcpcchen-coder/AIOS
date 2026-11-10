<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s7-realtime-contracts-2026-11-10.md) | [English](architecture-s7-realtime-contracts-2026-11-10.en.md)

# 架構重整 S7：即時語音契約與 ApiKeyRoute 搬移（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) 的 §P2-7 與 §3 的 S7；守門規則見[架構守門測試 S2](architecture-guard-2026-11-10.md)。這一批只搬移宣告，**目標是行為零改變**。這裡的內容全部是型別檢查、靜態量測，加上雲端容器裡的 fixture／mock 自動化測試；**不是產品 gate，也不是 Mac／Pi 實機驗收；沒有打任何一通真實的即時語音通話**。

## 1. 環境與範圍

- 分支 `claude/arch-s7-realtime-contracts`，建立在 main `1b61d08` 之上；尚未合併，沒有 push。George 於 2026-11-10 同意 S6–S9。
- Linux 雲端容器、Node.js v22.23.4、vitest 5.0.3、esbuild 0.28.2。`prototype/ambient-shell/node_modules` 是指到主要 checkout 的符號連結，沒有提交。沒有麥克風、鏡頭、Mac、Pi、OpenAI 或 ChatGPT 連線。
- 新增 2 個檔：`server/realtime-contracts.ts`（176 行）、`server/apikey-route.ts`（70 行）。
- 修改 8 個原始檔：`server/realtime-routes.ts`（1,275 → 1,083 行）、`server/apikey-call.ts`、`server/codex-auth.ts`、`server/live-route.ts`、`server/live-tool-caller.ts`、`server/memory/live.ts`、`server/web-search.ts`、`shared/web-search.ts`。前四個小檔與 `memory/live.ts` 各只改一行 import 路徑。
- 修改 1 個測試檔：`tests/architecture.test.ts`，只改允許清單、上限常數與註解。其他測試檔都沒有修改。
- `server/app.ts` 與 `server/nous.ts` **沒有修改**：`createApp` 沒帶 `realtimeRoutes` 時照舊自己 `new ApiKeyRoute(...)`，import 路徑也照舊是 `./realtime-routes.ts`（見第 7 節與原規劃的差異）。

## 2. 搬移前的環：8 個檔、15 條邊

基準 main `1b61d08`。「環」指 import 圖的強連通分量。下表是分量內部的每一條 import（檔名省略 `server/`）。

| # | 從 | 到 | 值（執行期） | 只有型別 |
|---|---|---|---|---|
| 1 | `realtime-routes` | `apikey-call` | `connectApiKey` | `ApiKeyBridge` |
| 2 | `realtime-routes` | `proactive-calendar` | — | `CallFollowUp` |
| 3 | `realtime-routes` | `memory/live` | — | `LiveMemoryPort` |
| 4 | `realtime-routes` | `web-search` | `WEB_SEARCH_TIMEOUT_MS` | — |
| 5 | `apikey-call` | `realtime-routes` | `RouteStartError` | `CallCloseReason`、`RouteCall`、`SessionContext` |
| 6 | `apikey-call` | `proactive-calendar` | `SCHEDULE_MARKER` | `CallFollowUp` |
| 7 | `apikey-call` | `memory/live` | `delegatePolicy`、`MAX_RECALLS` | `LiveCallPort`、`LiveMemoryPort`、`RevokeWhy` |
| 8 | `codex-auth` | `realtime-routes` | — | `Readiness` |
| 9 | `codex-responses` | `codex-auth` | `CodexUnauthorized`、`NOUS_ORIGINATOR` | `CodexAuth` |
| 10 | `live-tool-caller` | `codex-responses` | `CodexError` | `CodexInputItem`、`CodexResponses`、`CodexToolSpec`、`FunctionToolSpec` |
| 11 | `live-tool-caller` | `memory/live` | `delegatePolicy`、`DELEGATE_ONCE_OUTPUT`、`exactVoiceConfirm`、`MAX_RECALLS` | `VoiceDelegatePort` |
| 12 | `live-tool-caller` | `realtime-routes` | `HOST_TIMEOUT_MS`、`HostGone` | `ApprovalSnapshot`、`ToolHost` |
| 13 | `memory/live` | `live-tool-caller` | — | `LiveCallerMemory` |
| 14 | `proactive-calendar` | `memory/live` | `CONFIRM_AFTER_MS`、`ECHO_WINDOW_MS`、`exactYesNo`、`normalizeSpoken`、`readsQuestion` | — |
| 15 | `web-search` | `codex-responses` | `CodexError` | `CodexResponses` |

執行期的環是第 1 條與第 5 條（`realtime-routes` ↔ `apikey-call`，兩邊都是值）。其餘回到 `realtime-routes` 或 `live-tool-caller` 的反向邊（第 8、13 條）只有型別。

## 3. 搬移後的邊

| # | 搬移後 | 說明 |
|---|---|---|
| 1 | `realtime-routes` → `apikey-route`（re-export 值 `ApiKeyRoute`、型別 `ApiKeyRouteOptions`）；`apikey-route` → `apikey-call`（值 `connectApiKey`、型別 `ApiKeyBridge`） | `realtime-routes` 不再直接 import `apikey-call` |
| 2 | `apikey-route` → `proactive-calendar`（型別 `CallFollowUp`） | 跟著 `ApiKeyRouteOptions` 走 |
| 3 | `apikey-route` → `memory/live`（型別 `LiveMemoryPort`） | 跟著 `ApiKeyRouteOptions` 走 |
| 4 | `realtime-contracts` → `shared/web-search`（值 `WEB_SEARCH_TIMEOUT_MS`）；`web-search` → `shared/web-search`（同一個常數，照舊 re-export） | `realtime-routes` 不再 import `web-search` |
| 5 | `apikey-call` → `realtime-contracts`（同樣的 4 個名字） | **反向邊消失** |
| 8 | `codex-auth` → `realtime-contracts`（型別 `Readiness`） | **反向邊消失** |
| 12 | `live-tool-caller` → `realtime-contracts`（原本的 4 個名字，加上型別 `LiveCallerMemory`） | **反向邊消失** |
| 13 | `memory/live` → `realtime-contracts`（型別 `LiveCallerMemory`） | **反向邊消失** |
| 6、7、9、10、11、14、15 | 不變 | — |
| 新 | `realtime-routes` → `realtime-contracts`（import 自己要用的，並 re-export 全部 12 個名字） | — |
| 新 | `live-route` → `realtime-contracts`（原本從 `realtime-routes` import 的同樣 8 個名字；`live-route` 原本就不在環裡） | 路徑模組只依賴契約 |

`realtime-contracts.ts` 只 import `shared/`，不 import `server/` 的任何模組，所以沒有任何邊能從它回到上層。`apikey-route.ts` 不 import `realtime-routes.ts`。方向是 `realtime-routes` → `apikey-route` → `apikey-call` → `realtime-contracts`。

## 4. 搬了哪些宣告

全部是原樣搬移（含註解）；用腳本逐行比對：新檔裡除了 import 與檔頭說明以外的每一行都出現在搬移前的來源檔，`realtime-routes.ts` 搬移前的每一行都還在三個檔之一（只少了不再需要的 4 行 import）。

| 宣告 | 種類 | 從 | 到 | 原位置是否 re-export |
|---|---|---|---|---|
| `Readiness`、`CallCloseReason` | type | `realtime-routes.ts` | `realtime-contracts.ts` | 是 |
| `ApprovalSnapshot`、`SessionContext`、`RealtimeRoute`、`RouteCall`、`LiveControl`、`ToolHost` | interface | `realtime-routes.ts` | `realtime-contracts.ts` | 是 |
| `RouteStartError`、`HostGone` | class | `realtime-routes.ts` | `realtime-contracts.ts` | 是（同一個類別物件，`instanceof` 不變） |
| `HOST_REPLY_MARGIN_MS`、`HOST_TIMEOUT_MS` | const | `realtime-routes.ts` | `realtime-contracts.ts` | 是 |
| `ApiKeyRouteOptions` | interface | `realtime-routes.ts` | `apikey-route.ts` | 是 |
| `ApiKeyRoute` | class | `realtime-routes.ts` | `apikey-route.ts` | 是 |
| `LiveCallerMemory` | interface | `live-tool-caller.ts` | `realtime-contracts.ts` | 是（`export type`） |
| `WEB_SEARCH_TIMEOUT_MS` | const（30_000） | `server/web-search.ts` | `shared/web-search.ts` | 是 |

留在 `realtime-routes.ts` 沒搬的：`EnforcedEndReason`、`CORE_CAP_GRACE_MS`、`ALIVE_TIMEOUT_MS`、`unknownOutput`、`hostTimeoutOutput`、`planStart`、`planFallback`、`FallbackRequired`、`SessionError`、`RealtimeSessions` 等（只有工作階段擁有者與 `app.ts` 用，底層模組不需要）。

為什麼連 `WEB_SEARCH_TIMEOUT_MS` 也搬：`HOST_TIMEOUT_MS` 的 `web_search` 那一項要用它。如果契約檔去 import `server/web-search.ts`，依 import 圖會留下 `realtime-contracts` → `web-search` → `codex-responses` → `codex-auth` → `realtime-contracts` 一組 4 個檔的環（最後一段是 `Readiness` 型別）。常數值與註解不變，`server/web-search.ts` 照舊匯出同一個名字。

## 5. 量測：環的清單前後

指令：`node scripts/architecture-metrics.mjs`（在 repo 根目錄）。

搬移前（main `1b61d08`）：`import cycles: 4`

```
shared/realtime-route.ts <-> shared/types.ts <-> shared/voice-cost.ts
server/apikey-call.ts <-> server/codex-auth.ts <-> server/codex-responses.ts <-> server/live-tool-caller.ts <-> server/memory/live.ts <-> server/proactive-calendar.ts <-> server/realtime-routes.ts <-> server/web-search.ts
server/memories-google.ts <-> server/memories.ts
src/api.ts <-> src/realtime-session.ts <-> src/realtime-tools.ts <-> src/realtime.ts
```

搬移後：`import cycles: 3`

```
shared/realtime-route.ts <-> shared/types.ts <-> shared/voice-cost.ts
server/memories-google.ts <-> server/memories.ts
src/api.ts <-> src/realtime-session.ts <-> src/realtime-tools.ts <-> src/realtime.ts
```

server 的 8 檔分量整組消失（不是縮小）。其他數字：來源檔 246 → 248；跨層 import 仍是 0；超過 800 行的檔仍是 16 個（`realtime-routes.ts` 1,083 行，仍在名單上；只供參考，不是限制）。

守門測試的允許清單同步收緊：刪掉 server 那一組；shared 那一組拿掉已不存在的 `shared/seconds-menu.ts`（S3 已改名為 `menu-prefs.ts` 並離開了環）。`MAX_ALLOWED_CYCLES` 4 → 3，`MAX_ALLOWED_CYCLE_FILES` 18 → 9。之後這 8 個檔若再長回任何一組環，測試會失敗。

## 6. 驗證結果

| 檢查 | 指令（位置） | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit`（`prototype/ambient-shell`） | 通過，沒有輸出 |
| 單元與整合測試 | `npx vitest run`（同上） | 176 個測試檔通過；共 3,314 項，跑了兩次：第一次 3,308 項通過、6 項跳過（68 秒），文件寫完後重跑是 3,309 項通過、5 項跳過，兩次都沒有失敗（跳過數依環境而異，見基準紀錄）。除了 `architecture.test.ts` 的清單與上限，沒有修改任何既有測試檔 |
| 前端建置 | `npx vite build`（同上） | 通過；既有的 chunk 超過 500 kB 警告不變 |
| 桌面主程式語法 | `node --check desktop/main.mjs`（同上） | 通過 |
| 桌面核心打包 | 用 `desktop/scripts/build.mjs` 同一組 esbuild 選項（`bundle`、`platform: node`、`format: esm`、`target: node24`、同一段 banner）把 `server/nous.ts` 打包到 repo 外的暫存檔 | esbuild 0.28.2，0 個警告、0 個錯誤；`node --check` 通過；import 這個檔後 `typeof startNous` 是 `function`；`RouteStartError`、`HostGone`、`ApiKeyRoute` 在打包結果裡各只有一份定義。`desktop/node_modules` 不存在，所以沒有執行 `build.mjs` 本身（它還會呼叫 vite 與複製 Electron 檔案） |
| 載入順序 | `npx tsx -e "import('./server/nous.ts').then(m=>console.log(typeof m.startNous))"`（同上） | 印出 `function` |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs`（repo 根目錄） | PASS。rpi4 終端機套件的 dry-run 是部分執行（報告裡註明 skip），和之前的紀錄相同 |
| 量測腳本 | `node scripts/architecture-metrics.mjs`（repo 根目錄） | 環 4 → 3（見第 5 節） |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs`（repo 根目錄） | 通過 |
| 空白 | `git diff --check`（repo 根目錄） | 通過 |

## 7. 與原規劃的差異

- 原規劃寫「`app.ts` 不再自己 `new ApiKeyRoute`，由 `nous.ts` 注入」。這一批**沒有做**：有測試依賴 `createApp` 沒帶 `realtimeRoutes` 時的預設，所以依規劃裡的風險註記保留預設，只搬類別的位置。`app.ts` 與 `nous.ts` 沒有修改，仍從 `./realtime-routes.ts` import `ApiKeyRoute`。
- 原規劃估 `realtime-routes.ts` 少 60 行左右；實際少 192 行（1,275 → 1,083），因為契約宣告也一起搬出去了。
- 原規劃只提 `realtime-routes` ↔ `apikey-call`。多做了兩個同類的原樣搬移，否則 8 檔分量只會縮小、不會消失：`LiveCallerMemory`（`memory/live` → `live-tool-caller` 的型別反向邊）與 `WEB_SEARCH_TIMEOUT_MS`（見第 4 節）。後者動到 `shared/web-search.ts`（多一個常數）。
- `live-route.ts` 的 import 路徑也改成契約檔（一行）。它原本不在環裡，這只是讓兩個路徑模組都只依賴契約。

## 8. 限制

- 只有雲端容器的 fixture／mock 測試與靜態量測。沒有 Mac、Pi、麥克風或喇叭，沒有連 OpenAI 或 ChatGPT，**沒有打真實的即時語音通話**（API key 路徑與 ChatGPT 方案路徑都沒有）。「行為零改變」的依據是：宣告逐行相同、型別檢查通過、既有測試不改即綠；不是實機觀察。
- 桌面 App 沒有實際打包或啟動；只驗證了核心那一個 esbuild bundle 能產生、語法正確、能 import。
- `realtime-routes.ts` 仍然 re-export `ApiKeyRoute`，所以 import `realtime-routes.ts` 仍會載入 `apikey-route.ts` 與 `apikey-call.ts`（單向，沒有環）。要拿掉這條依賴得改 `app.ts`、`nous.ts` 與測試的 import，留給之後的批次。
- 量測腳本用正規表示式找相對路徑 import，type-only 也算邊，限制同[守門測試紀錄](architecture-guard-2026-11-10.md)第 6 節。「環消失」的準確說法是：這 8 個檔不再屬於任何兩個檔以上的強連通分量。
- 其餘 3 組環（shared 的型別環、`memories` ↔ `memories-google`、頁面的 4 檔環）沒有處理。
- 不是 G0–G3 或任何 Mac／Pi gate；不改變 README 任何「待實作」項目的狀態。
