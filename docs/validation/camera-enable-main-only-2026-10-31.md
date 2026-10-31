<!-- bilingual: source=zh-TW -->

> [繁體中文](camera-enable-main-only-2026-10-31.md) | [English](camera-enable-main-only-2026-10-31.en.md)

# App 裡鏡頭只能由主程序打開：驗證

日期：2026-10-31，Asia/Taipei。分支：`claude/camera-enable-main-only`（基於 main `2c7104b`，尚未提交與合併）。來源：[WK-01a 驗證 §8 審查 M2](wk-01a-2026-10-31.md#8-獨立審查後的修正2026-10-31) 列出的已知事項——`POST /api/settings/camera` 接受任何頁面腳本送來的 `{active:true}`，使用者沒看到任何說明鏡頭就被打開。

**這不是實機驗收。** 以下測試全部在 Linux 雲端容器以 HTTP、靜態原始碼檢查與假的 Electron 物件執行，**不是 Mac、不是真的鏡頭、沒有真的原生對話框**。Mac 上的手動核對尚未執行（§6）。

## 1. 問題

常駐喚醒聆聽在 WK-01a 審查 M2 已改成：HTTP 收到 `wake_listen: true` 回 403，只有 App 主程序在原生說明對話框之後，經同一個行程的 `NousHandle.wake.setListen` 打開。鏡頭的 `POST /api/settings/camera` 有同一類問題：頁面上的任何腳本都能送 `{active:true}` 打開鏡頭，使用者看不到說明。

## 2. 設計

使用者在本批進行中決定：**瀏覽器版必須仍然可以打開鏡頭。** 所以由啟動核心的一方決定模式：

| 模式 | 誰使用 | `POST /api/settings/camera` 的 `active: true` | `settings.camera.enable_via` | 打開鏡頭的路 |
|---|---|---|---|---|
| `"main_process"`（嚴格） | macOS App（`desktop/main.mjs` 的 `startNous({ cameraEnable: "main_process" })`） | 403「鏡頭只能從 App 打開」（英文 “The camera can be turned on only from the App”），整個請求拒絕、什麼都不保存 | `"app"` | 主程序原生說明 → 使用者按「開啟」→ 同一行程的 `NousHandle.camera.setActive(true)` |
| `"http"`（預設） | 終端機／瀏覽器版（`server/index.ts`，`npm start`） | 照舊 200 | 不帶這個欄位（`/api/settings` 與以前逐位元組相同） | 照舊經 HTTP；由瀏覽器自己的鏡頭權限提示與右下角指示點把關 |

兩個模式下 `active: false` 與其他鍵都照常；驗證先於 403（`active: "yes"` 仍是 400）；未設定鏡頭 409、寫檔失敗 500 都不變。

- **核心**（`server/nous.ts`）：`NousOptions.cameraEnable?: "main_process" | "http"`（預設 `"http"`）傳給 `createApp`；`NousHandle.camera.setActive(value)` 呼叫 `CameraSettingsStore.update({ active })`：先寫 `camera.json`，成功後才經 `onChange` 推送 `settings.updated`；寫檔失敗丟錯、設定不變。
- **HTTP**（`server/app.ts`）：`cameraEnable === "main_process"` 而且解析後的 patch 有 `active === true` 時回 403；嚴格模式的 `settings.camera` 多 `enable_via: "app"`。
- **App 主程序**（`desktop/main.mjs`）：`setCameraActive(value)`。打開時先顯示原生問題對話框（`開啟`／`取消`，預設與取消鍵都是「取消」），說明：鏡頭影像只在這台 Mac 本機處理，不保存、不上傳；畫面右下角的圓點顯示實際狀態；隨時可以在選單列或說「關掉鏡頭」關閉。按「開啟」才呼叫 `core.camera.setActive(true)`、重新讀取設定，再經 `nous:command` 送 `camera-enabled` 給頁面。保存失敗時：選單列打開的跳原生錯誤框；頁面經 IPC 要求的只把錯誤回給頁面顯示，不另跳錯誤框（避免同一個錯誤報兩次）。對話框只有在主視窗存在而且看得見時才掛在視窗上（sheet），否則用 App 層級的對話框：隱藏視窗上的 sheet 使用者看不到，會讓共用的等待一直卡住（常駐喚醒聆聽的對話框同樣處理）。說明框開著時再收到請求會共用同一個對話框與結果，不疊第二個。關掉照原本的 HTTP 路徑。選單列「鏡頭」勾選框（`setMenuPref`）把「打開」轉到 `setCameraActive`，不經 HTTP。
- **鏡頭影像權限**（`desktop/main.mjs`，審查後補上）：只有 HTTP 403 還不夠——原本 `setPermissionRequestHandler` 把 `media` 權限給任何來自核心網址的請求，頁面腳本可以直接呼叫 `navigator.mediaDevices.getUserMedia({ video: true })` 拿到鏡頭，不管 `camera.json` 的 `active`，甚至沒有 `NOUS_CAMERA=on` 也可以。現在 `media` 請求的 `details.mediaTypes` 含 `"video"`（或沒有、空陣列、看不懂的值，一律當成要影像，fail closed）時，必須同時 `allowMedia(url)` 而且 `core.camera.isActive()`；只要麥克風（`["audio"]`）的請求不變。`NousHandle.camera.isActive()` 每次直接讀 store（`enabled && active`），不用主程序輪詢來的 `settings`（可能過時）。`setPermissionCheckHandler` 維持原樣：它只回答同步的權限查詢（`navigator.permissions.query`、`enumerateDevices` 是否給裝置名稱），本身不會開鏡頭，真正取得影像的 `getUserMedia` 一律經請求處理器（依 Electron 文件判斷，Mac 未實測）。
- **只給同一個 origin**：`allowMedia` 改用 `desktop/trusted-sender.mjs` 的 `sameOrigin(url, core.url)`（解析後比較 origin），不再用字首比對，所以 `http://localhost:5173` 不會接受 `http://localhost:51730`；請求與檢查處理器用同一個 `allowMedia`。
- **頁面撤銷「關掉但沒保存」**：先前在頁面關掉鏡頭但保存失敗時，這個視窗用 `cameraOffPending` 維持關閉。核心推送的設定分不出「使用者後來在選單列明確打開」（關掉沒保存時核心本來就是開，值不會改變），所以改由主程序在打開成功後送 `camera-enabled`，頁面的 `cameraEnabledByApp()` 撤銷 `cameraOffPending`、清掉 `cameraFailed` 並 `syncCamera`。這個視窗的「關掉」POST 還在送出中（`cameraOffInFlight > 0`）時不撤銷，以那個關掉落到核心的結果為準。核心推送的設定本身仍然只在回報 `active=false` 時清掉 `cameraOffPending`（和以前相同），不會因為無關的設定更新把鏡頭打開。
- **合法的鏡頭啟動都在核心保存之後**：`src/` 裡唯一要影像的 `getUserMedia` 在 `src/sense/pipeline.ts`，只由 `syncCamera` → `startCamera` 在 `cameraShouldRun`（`enabled && active`，以核心回報的設定為準）時啟動。「顯示鏡頭畫面」只在鏡頭已在運作時打開，否則說「鏡頭沒有在運作，無法顯示鏡頭畫面。」；家人辨識與校正只從同一個管線取樣，沒有自己的 `getUserMedia`。所以這些入口不需要改，也不會被新的權限檢查擋掉。
- **IPC**：`ipcMain.handle("nous:camera-enable")` 先用 `checkTrustedSender`（主視窗主框架、來自本機核心頁面）檢查，再執行 `setCameraActive(true)`；回 `{ ok: true }` 或 `{ ok: false, reason: "cancelled" | "unavailable" | "error", message? }`。`desktop/preload.cjs` 公開 `nousDesktop.cameraEnable()`，不帶任何參數（頁面傳什麼都不會送過去）。
- **頁面**（`src/main.ts` 的 `updateCameraPrefs`）：只有 `settings.camera.enable_via === "app"` 而且 patch 有 `active: true` 時，把 `active` 拿掉、其他鍵照常經 HTTP 保存，鏡頭交給 `nousDesktop.cameraEnable()`；成功後重新讀取設定並重繪，取消回「已取消開啟鏡頭」，失敗回原因。核心保存之前不在本機啟動鏡頭（`syncCamera` 只看核心回報的 `active`），取消或失敗時不改 `cameraOffPending`／`cameraFailed`，所以鏡頭不會被留在開著。設定已經是開時不再問，只重試上次失敗的啟動。沒有 `enable_via` 時照舊經 HTTP。
- 新增的介面文字都在共用翻譯表：`desktop/messages.en.json`（對話框）、`shared/messages.en.json`（403 訊息）、`src/messages.en.json`（頁面訊息）。

## 3. 行為表

| 入口 | App（嚴格模式） | 終端機／瀏覽器版（預設模式） |
|---|---|---|
| 選單列「鏡頭」勾選框 | 原生說明 → 按「開啟」才打開；取消則不變 | 不適用（沒有選單列） |
| 頁面設定畫面的「鏡頭」開關 | 經 `nousDesktop.cameraEnable()` 出現同一個原生說明；取消時設定畫面顯示「已取消開啟鏡頭」 | 照舊經 HTTP 打開；瀏覽器第一次會跳出鏡頭權限提示 |
| 說或打「打開鏡頭」／“turn on the camera” | 同上（原生說明）；字幕顯示結果或「已取消開啟鏡頭」 | 照舊經 HTTP 打開 |
| 即時語音逐字稿裡的「打開鏡頭」 | 走同一個 `handleCameraCommand`，所以同上 | 照舊經 HTTP 打開 |
| 頁面腳本直接 `POST {active:true}` | 403，什麼都不保存 | **仍然可以打開**（使用者的決定；見 §5 殘餘風險） |
| 頁面腳本直接呼叫 `getUserMedia({ video: true })` | 鏡頭設定關著（或沒有 `NOUS_CAMERA=on`）時主程序拒絕權限，拿不到影像；開著時給。注意：`NOUS_CAMERA=on` 而且還沒有 `camera.json` 時，鏡頭設定預設就是開（第一次啟動不經原生說明，見 §5） | 由瀏覽器自己的權限提示決定（不變） |
| 頁面腳本呼叫 `nousDesktop.cameraEnable()` | 只會跳出原生說明，要使用者按「開啟」 | 不存在 |
| 第一次啟動（`NOUS_CAMERA=on`、還沒有 `camera.json`） | 鏡頭預設為開，直接運作並給影像權限，**不經原生說明**（安裝者在 `.env` 打開；George 2026-10-31：維持現狀） | 照舊預設為開 |
| 關掉鏡頭（任何入口） | 照舊，立即在本機釋放再保存 | 照舊 |

## 4. 測試

在 `prototype/ambient-shell/`：

| 檔案 | 內容 |
|---|---|
| `tests/http.test.ts`（新增 2 項） | 預設模式：`{active:true, look_to_talk:false}` 200、settings 不帶 `enable_via`。嚴格模式：`settings.camera.enable_via === "app"`；`active:true` 403（中文與英文訊息）；`{active:true, look_to_talk:false}` 403 且 `camera.json` 逐位元組不變；`active:"yes"` 400；`look_to_talk:false` 與 `active:false` 200；經 store 打開後 settings 為開 |
| `tests/camera-enable.test.ts`（新檔，21 項） | 審查修正：`sameOrigin` 的單元測試（5173 與 51730、`5173.evil.test`、https、127.0.0.1、壞網址）且兩個權限處理器都用 `allowMedia`；鏡頭與常駐喚醒聆聽的對話框都用 `dialogParent()`（需要 `win.isVisible()`）；頁面要求的打開不跳原生錯誤框、選單列的會跳；打開成功後送 `camera-enabled`，頁面在沒有送出中的「關掉」時才撤銷 `cameraOffPending`，核心推送仍只在 `active=false` 時清掉。釘住目前的第一次啟動預設：啟用而且沒有 `camera.json` 時 `isActive()` 為 true。`isActive`：`NOUS_CAMERA` 關閉時即使保存為開也是 false；啟用時跟著保存的值（含 HTTP 關掉）立即改變。權限：請求處理器檢查 `wantsVideo(details)` 與 `cameraAllowed()`（直接問 `core.camera.isActive()`，不讀 `settings`），檢查處理器不變；`wantsVideo` 對 video、未知、空、缺少都回 true，只有 `["audio"]` 回 false；`src/` 唯一要影像的 `getUserMedia` 在 pipeline，且只在 `cameraShouldRun` 時啟動。核心：嚴格模式下 HTTP 403、`NousHandle.camera.setActive(true)` 寫入 `camera.json` 並推送 `settings.updated`。App 以 `cameraEnable: "main_process"` 啟動核心、`server/index.ts` 不傳、核心預設 `"http"`。主程序：`setCameraActive` 先 `showMessage(`（`defaultId: 1, cancelId: 1`）再 `core.camera.setActive(true)`、main.mjs 的程式碼不送 `active: true`、選單列的鏡頭開關先轉到 `setCameraActive`、`nous:camera-enable` 先 `checkTrustedSender` 且不收參數、對話框英文翻譯完整。preload：`cameraEnable(...)` 不論頁面傳什麼都只 `invoke("nous:camera-enable")`。頁面（靜態）：`api.updateCamera(` 只出現一次且在 App 模式分支之後、`enableCamera` 不經 HTTP、取消／失敗不改鏡頭狀態旗標、新訊息有英文 |
| `tests/identity-ipc.test.ts`（修改 1 項） | preload 公開的名稱清單加上 `cameraEnable` |

**測試缺口**：頁面的嚴格模式分支（`updateCameraPrefs`／`enableCamera`／`cameraEnabledByApp`）只有原始碼的靜態檢查，沒有執行行為的單元測試——`src/main.ts` 是直接操作 DOM 的單一大檔，無法便宜地單獨載入。「取消後鏡頭維持關閉」「送出中的關掉不被撤銷」要靠 §6 的 Mac 核對。

結果（Linux 雲端容器，Node.js 22）：`npm run typecheck` 通過；`npx vitest run` 107 個測試檔，2,038 項通過、5 項跳過；`npm run build` 通過。

## 5. 風險與限制

- **瀏覽器版殘餘風險（使用者決定）**：終端機／瀏覽器版仍允許頁面經 HTTP 打開鏡頭，所以本機頁面腳本仍然可以打開鏡頭，只靠瀏覽器自己的鏡頭權限提示（以及之後的畫面指示點）把關。瀏覽器記住過權限時不會再提示。這是使用者 2026-10-31 的選擇，不是本批的遺漏。
- **第一次啟動的預設（George 2026-10-31：維持現狀）**：`NOUS_CAMERA=on` 而且還沒有 `camera.json` 時，`active` 預設為開（`shared/sense.ts` 的預設與 `server/config.ts`），所以 App 第一次啟動就會開鏡頭，主程序也會把影像權限給頁面（包括頁面腳本自己的 `getUserMedia({ video: true })`），**不經原生說明**。使用者決定不改行為：`.env` 的 `NOUS_CAMERA=on` 是安裝者明確的選擇，第一次不另跳原生確認；這是保留的殘餘項目。測試釘住這個行為，要改時必須刻意改測試。
- App 的殘餘風險：鏡頭設定是開的時候（包括上面的第一次啟動），頁面腳本可以自己呼叫 `getUserMedia({ video: true })` 拿到影像（這時管線通常也在運作、指示點顯示開）；之後使用者關掉鏡頭，管線會停，但腳本先前拿到的串流不會被主程序收回，要等它自己停止或頁面重新載入。權限處理器每次 `getUserMedia` 都會被問到（Electron 不保存權限決定）是依文件判斷，Mac 未實測。
- 嚴格模式只保護「打開」。關掉一定安全，所以任何頁面腳本都還能關掉鏡頭或改其他鏡頭設定（例如看著說話）。
- App 的 `nous:camera-enable` 讓頁面可以要求跳出說明框；頁面腳本可以反覆要求（同時只會有一個框），但沒有使用者按「開啟」就打不開。
- 本批沒有改 `server/index.ts`；如果其他程式自己呼叫 `startNous` 而沒有傳 `cameraEnable`，會是寬鬆模式。
- 型別：`desktop/trusted-sender.d.mts` 加上 `sameOrigin`；`desktop/main.mjs` 沒有型別宣告檔，`preload.cjs` 的公開型別在 `src/main.ts` 的 `DesktopBridge`（已加 `cameraEnable?`）。
- 本批沒有改主視窗導覽與外部連結的 `isLocal`（`desktop/main.mjs` 仍用 `url.startsWith(core.url)` 字首比對），它和鏡頭權限無關，但有同樣的埠字首問題，留給另一批。

## 6. 未驗證：Mac 手動核對（待執行）

在 Mac 上用這個分支建置的 App：

1. 選單列 →「鏡頭與語音設定」→ 取消勾選「鏡頭」，確認右下角指示點變成關閉。
2. 再勾選「鏡頭」：應出現原生對話框「要打開鏡頭嗎？」，預設按鈕是「取消」。按「取消」：指示點仍是關閉、勾選框仍是未勾。
3. 再勾選一次，按「開啟」：指示點變成開啟、勾選框打勾。
4. 關掉鏡頭後，在頁面的設定畫面按「鏡頭」開關：應出現同一個對話框；按「取消」時設定畫面顯示「已取消開啟鏡頭」，鏡頭沒有開。
5. 說或打「打開鏡頭」：同一個對話框；按「開啟」後字幕顯示「正在開啟鏡頭（狀態看右下角指示點）。」，指示點變成開啟。
6. 即時語音進行中說「打開鏡頭」：同一個對話框。
7. 切換到 English 重做第 2 步：對話框標題 “Turn on the camera?”、按鈕 “Turn on”／“Cancel”。
8. 在 App 的開發者工具執行 `fetch("/api/settings/camera",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"active":true}'})`：應回 403，鏡頭不開。
9. 鏡頭關著時，在 App 的開發者工具執行 `navigator.mediaDevices.getUserMedia({video:true})`：應被拒絕（NotAllowedError），指示點與 Mac 的綠燈都不亮；打開鏡頭後同一行可以成功。`getUserMedia({audio:true})` 不受影響。
10. 關掉主視窗（App 留在選單列）後，從選單列勾選「鏡頭」：說明框應以 App 層級的對話框出現（不是掛在看不見的視窗上），按「取消」後再勾一次仍會出現。常駐喚醒聆聽的開關同樣核對一次。
11. 在頁面說「關掉鏡頭」時讓保存失敗（例如暫時把 `camera.json` 換成同名資料夾），確認這個視窗的鏡頭關閉（核心仍是開，選單列仍打勾）；把 `camera.json` 改回來後說「打開鏡頭」，應出現說明框，按「開啟」後鏡頭回到運作。
12. 用 `npm start` 開瀏覽器版：設定畫面的「鏡頭」開關與「打開鏡頭」照舊可以打開（瀏覽器可能跳出權限提示）。

## 7. 下一個 gate

George 在 Mac 上依 §6 核對；通過後再把 [目前實作文件](../Current_Implementation_Status.md) 的對應說明改成「Mac 已核對」。
