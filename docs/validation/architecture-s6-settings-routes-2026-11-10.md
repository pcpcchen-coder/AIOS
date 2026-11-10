<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s6-settings-routes-2026-11-10.md) | [English](architecture-s6-settings-routes-2026-11-10.en.md)

# 架構重整 S6：設定寫入路由表（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §P2-6 與 §3 的 S6。這一批只搬動 `server/app.ts` 裡重複的設定寫入路由，**目標是行為完全不變**。全部是雲端容器裡的型別檢查與 fixture／mock 自動化測試，**不是產品 gate，也不是 Mac／Pi 實機驗收**。

## 1. 環境

- 分支 `claude/arch-s6-settings-routes`，基準是 main `1b61d08`（已含架構 S1–S5）。George 於 2026-11-10 同意做 S6–S9。
- Linux 雲端容器、Node.js v22.23.4、vitest 5.0.3。`prototype/ambient-shell/node_modules` 是指向主要 checkout 的符號連結，沒有提交。
- 沒有麥克風、鏡頭、Mac、Pi、中控或電視；沒有任何真實帳號。引擎是 `MockExecutor`，設定檔都在 `mkdtempSync` 的暫存資料夾。

## 2. 重整前的盤點

重整前，`handleApi` 在 `GET /api/settings` 之後有 13 條 `POST /api/settings/*`，中間夾著 5 組別的路由（`GET /api/weather/now`、`/api/alarms/*`、`GET /api/home/overview`、`/api/memories/google/*` 與 `/api/memories/*`）。

13 條共同的部分：

- 只接受 `POST`，路徑完整比對。Host／Origin／Content-Type 由最外層的 `checkRequest` 先檢查（這一批沒有動）。
- 成功：`200`，本體是整份設定 `localizeSettings(settings.view(pageSource(X-Nous-Terminal)), normalizeLocale(X-Nous-Locale))`，標頭 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。
- 失敗：丟 `HttpError(status, 訊息)`，最外層回 `{ "error": localize(訊息, 語言) }`，標頭同上；`500` 另外 `console.error`。
- 副作用：路由自己不廣播。store 的 `update()` 成功後呼叫 `onChange`（→ `notifySettings` → SSE `settings.updated`），每次成功的寫入一次；沒有重新啟動任何東西。
- body 由 `readJson` 讀：超過 16 KiB 回 `413 body too large`，不是 JSON 物件回 `400 body must be a JSON object`，空的 body 當成 `{}`。
- 驗證做兩次的那一點沒有動：路由解析 patch 一次，`PrefsFile` 下次讀檔時再逐鍵驗證一次。

逐條（「store 不在」那一欄的檢查都在讀 body 之前；訊息是逐字的，同時是翻譯表的鍵）：

| 路徑 | store 不在 | 讀 body 與格式（400） | 寫入前的拒絕 | store 呼叫 | 寫入失敗 | 是否一致 |
|---|---|---|---|---|---|---|
| `/api/settings/provider` | 不檢查（一定有） | `provider` 不是 `claude`／`chatgpt`／`mock` → `400 unknown provider` | 無 | `settings.select(provider)` | 任何錯誤 → `409` 加錯誤本身的訊息（例如 `尚未設定 ANTHROPIC_API_KEY，無法使用 Claude。`）；沒有 500 的對應 | 否：自己的處理函式 |
| `/api/settings/camera` | `409 鏡頭未設定` | `parseCameraPatch`；`CameraPatchError` → 400 加它的訊息 | `cameraEnable` 是 `main_process` 而且 `active === true` → `403 鏡頭只能從 App 打開`（什麼都不保存） | `camera.update(patch)` | `500 鏡頭設定沒有保存（無法寫入設定檔：<原因>）` | 一致加一個「寫入前拒絕」 |
| `/api/settings/camera-tuning` | 沒有 `faceTuning`，或 `camera.view().enabled` 不是 true → `409 鏡頭未啟用` | `reset === true` 時不解析其他欄位；否則拿掉 `calibrated` 後 `parseFaceTuningPatch`；`FaceTuningError`（解析或 store 檢查合併後整組時丟的）→ 400 | 無 | `faceTuning.reset()`，或 `faceTuning.update(patch, calibrated === true)` | `500 校正值沒有保存（無法寫入設定檔：<原因>）` | 否：自己的處理函式 |
| `/api/settings/voice` | `409 語音設定未設定` | `parseVoicePatch`／`VoicePatchError` | 無 | `voice.update(patch)` | `500 語音設定沒有保存（…）` | 一致 |
| `/api/settings/audio` | `409 聲音裝置設定未設定` | `parseAudioPatch`／`AudioPatchError` | 無 | `audio.update(patch)` | `500 聲音裝置設定沒有保存（…）` | 一致 |
| `/api/settings/wake` | 路由不存在（`NOUS_WAKE` 關閉）→ 落到 `404 not found` | `parseWakePatch`／`WakePatchError` | 依序：`wake_listen === true` → `403 常駐喚醒聆聽只能從 App 選單列打開`；`voice_name_test === true` → `403 只憑聲音叫名字只能從 App 選單列打開` | `wake.update(patch)` | `500 常駐喚醒聆聽設定沒有保存（…）` | 一致加一個「寫入前拒絕」 |
| `/api/settings/clock` | 路由不存在 → 404 | `parseClockPatch`／`ClockPatchError` | 無 | `clock.update(patch)` | `500 時鐘設定沒有保存（…）` | 一致 |
| `/api/settings/alarms` | 路由不存在 → 404 | 路由不解析；`alarms.updatePrefs(body)` 自己驗證，`AlarmPatchError` → 固定的 `400 鬧鐘與定時器的設定值不正確`（不帶原因） | 無 | `alarms.updatePrefs(body)` | `console.warn` 後 `500 定時器沒有保存（無法寫入設定檔）`（不帶原因） | 否：和 `/api/alarms/*` 九條動作共用同一段錯誤處理 |
| `/api/settings/day-night` | 路由不存在 → 404 | `parseDayNightPatch`／`DayNightPatchError` | 無 | `dayNight.update(patch)` | `500 日夜間設定沒有保存（…）` | 一致 |
| `/api/settings/home-corner` | 路由不存在 → 404 | `parseHomeCornerPatch`／`HomeCornerPatchError` | 無 | `homeCorner.update(patch)` | `500 家中狀態設定沒有保存（…）` | 一致 |
| `/api/settings/proactive` | 路由不存在 → 404 | `parseProactivePatch`／`ProactivePatchError` | 無 | `proactive.update(patch)`；store 丟 `ProactivePatchError`（合併後開始不早於結束）也是 400 | `500 主動提醒設定沒有保存（…）` | 一致加「store 也會丟格式錯誤」 |
| `/api/settings/memories` | 路由不存在 → 404 | `parseMemoriesPatch`／`MemoriesPatchError` | 無 | `memories.update(patch)` | `500 回憶模式設定沒有保存（…）` | 一致 |
| `/api/settings/realtime` | `409 即時語音路徑設定未設定` | `parseRealtimePatch`／`RealtimePatchError` | 無 | `realtimePrefs.update(patch)`（只影響下一次開始的通話） | `500 即時語音設定沒有保存（…）` | 一致 |

完全一致的是 7 條（voice、audio、clock、day-night、home-corner、memories、realtime）；鏡頭、喚醒、主動提醒各多一件事；切換引擎、人臉校正、鬧鐘各有自己的邏輯。

順帶看到、**這一批沒有改**的事：`校正值沒有保存（無法寫入設定檔：{0}）` 不在英文翻譯表裡，英文介面收到的是中文（其餘 10 句與鬧鐘那一句都有翻譯）。新的測試把現況記下來，要補翻譯得另開一批。

## 3. 做了什麼

| 檔案 | 內容 |
|---|---|
| `server/routes/settings.ts`（新，227 行） | 路由表 `ROUTES`（`Map<路徑, 處理函式>`，12 條）與 `findSettingsWrite(method, path)`。一致的那一種由 `patchRoute(spec)` 產生：`store`、`missing`（字串＝409 的訊息，`null`＝路由不存在）、`parse`、`PatchError`、`saveFailed`，另有兩個選用欄位 `refuse`（鏡頭、喚醒）與 `storeValidates`（主動提醒）。切換引擎與人臉校正是表上各自的處理函式，內容照搬。寫檔失敗的對應收成一個 `saveFailed(message, err)`。處理函式只回 `true`（已寫入）或 `false`（路由在目前的組裝不存在），不碰 `req`／`res`、SSE 或語言。 |
| `server/http-error.ts`（新，6 行） | `HttpError` 從 `app.ts` 搬出來，內容相同。這樣 `routes/settings.ts` 不必 import `app.ts`（否則會多一組 import 環）。 |
| `server/app.ts` | 12 段路由換成兩行：`findSettingsWrite(method, path)` 找到而且處理函式回 `true` 時 `sendSettings(req, res)`。整份設定的回應收成 `sendSettings(req, res, source?)` 一個 helper，原本 18 處相同的式子與鬧鐘那一處（自己算好 `source`）都改用它。拿掉用不到的 import。`/api/settings/alarms` 與其他路由群組的邏輯沒有動。 |

### 3.1 行數

| 檔案 | 前（`wc -l`） | 後 |
|---|---|---|
| `server/app.ts` | 1,368 | 1,173（−195） |
| `server/routes/settings.ts` | — | 227 |
| `server/http-error.ts` | — | 6 |
| 合計 | 1,368 | 1,406（淨 +38） |

`scripts/architecture-metrics.mjs` 的數字（它的行數比 `wc -l` 多 1）：`app.ts` 1,369 → 1,174；`app.ts repeats: localizeSettings(settings.view(...))` x18 → x0、`same save error` x12 → x1；`app_ts_path_matches` 56 → 49；跨層 import 0 → 0；import 環 4 → 4；沒有測試直接 import 的模組 26 → 26。x0 是因為 helper 裡寫成 `settings.view(source)`，腳本的樣式比對不到，實際上這個式子在 `app.ts` 還有 1 處（就是 helper）；x1 是鬧鐘原本那一句，另外 11 句現在是 `routes/settings.ts` 表上的資料。

### 3.2 與 23 §3 原文的差異

- **表上是 12 條，不是 13 條。** `/api/settings/alarms` 和 `/api/alarms/*` 九條動作共用同一個 `saved()`（固定訊息、不帶原因、先 `console.warn`），而且 body 由 `AlarmCenter` 自己驗證。搬進表裡就得把這段錯誤處理拆成兩份或讓鬧鐘的動作路由反過來 import 設定路由表，所以留在 `app.ts`，只改用 `sendSettings`。
- **`app.ts` 少 195 行，三個檔合計多 38 行。** 多出來的是表的型別、註解，以及每一條保留完整的訊息字串（沒有拆成「名詞＋共用句尾」，這樣在原始碼裡仍然搜得到翻譯表的鍵）。
- **查表的位置只有一個**：在 `GET /api/settings` 之後，也就是原本第一條設定路由的位置。原本 12 條散在 5 組別的路由之間；合成一處不改變先後，因為這 12 條都是 `POST` 加完整路徑，而夾在中間的路由沒有一條比對得到這些路徑（`GET /api/weather/now`、`POST /api/settings/alarms` 與 `/api/alarms/` 開頭、`GET /api/home/overview`、`/api/memories/google/*`、`GET /api/memories/items`、`/api/memories/media/` 開頭）。旗標關閉的路由處理函式回 `false`，照舊一路落到最後的 `404 not found`。
- **不是 `path → store → parsePatch` 三欄就夠**：還需要「store 不在時是 409 還是不存在」、錯誤類別與完整的失敗訊息，另外兩個選用欄位只給需要的三條用。
- `sendSettings` 也用在 6 處不是設定寫入的地方（`GET /api/settings`、Google 相簿的挑選與取消／清除、兩個登入的取消、`welcome-ack`）：式子逐字相同，只是換成呼叫。

## 4. 驗證

### 4.1 新增的測試

`tests/settings-routes.test.ts`（19 項，經真的 HTTP）。它不 import 重整後才有的模組，所以**在重整前的 main 上也能跑**。兩種 fixture：

- 真實核心（`startNous`，`NOUS_WAKE=on`、`NOUS_CAMERA=on`、模擬引擎、暫存設定資料夾）：12 條各自的合法 patch（200、本體和緊接著的 `GET /api/settings` 完全相同、對應的那一段有變、設定檔寫出 patch）；不合法的 patch（400 加逐字訊息、設定與設定檔不變）；設定檔寫不進去（設定檔的位置先放一個非空資料夾；鬧鐘擋的是 `alarms.json.tmp`）回 500 與「沒有保存」；切換引擎的 200／400／409；`X-Nous-Terminal` 與 `X-Nous-Locale` 的回應和同樣標頭的 GET 相同；同一路徑的 GET 是 404；人臉校正的 reset／calibrated／整組檢查；`NOUS_CAMERA=off` 時校正值 409；喚醒的兩個 403 與先後；主動提醒的時段檢查。
- `createApp` 加可控制的 store（真的 store 外面包一層，記錄呼叫、可以要求每次寫入都丟 `Error("disk full")`）：合法 patch 只呼叫一次自己的 store、`onChange` 一次；不合法的 patch 不呼叫 store；寫入失敗的 500 訊息逐字比對（中文與 `X-Nous-Locale: en`）；格式檢查在寫入之前；沒有提供 store 時 409 或 404，而且在讀 body 之前；body 不是 JSON 物件時 400；`cameraEnable: "main_process"` 的 403 與先後；`http` 或未指定時照收；reset 走 `reset()`。

表上的 12 條加鬧鐘共 13 條都在同一張測試表裡跑（鬧鐘留在 `app.ts`，一樣驗）。

`tests/settings-route-table.test.ts`（4 項，不經 HTTP，直接 import 新模組）：只比對 `POST` 與完整路徑、`/api/settings/alarms` 不在表上；沒有 store 時旗標路由回 `false`、其餘 409，都不讀 body；一致的那一種的 400／500／成功與 `this`；store 自己丟的格式錯誤只有主動提醒是 400。

### 4.2 新測試在重整前的 main 上通過

1. 先寫測試、不動 `server/`。當時 `git status --short` 只有 `?? tests/settings-routes.test.ts`，`HEAD` 是 `1b61d08`，`server/app.ts` 的 SHA-256 是 `11eb3f5b…`。`npx vitest run tests/settings-routes.test.ts`：**1 檔 19 項通過**。
2. 重整後同一份測試：**19 項通過**。
3. 重整後測試檔只多了一個型別標註（`as Record<string, string>[]`，為了過 `tsc`）。再把定稿的測試檔放進 `git archive 1b61d08` 解出來的乾淨副本（沒有 `server/routes/`，`server/app.ts` 同一個 SHA-256）跑一次：**19 項通過**，`npx tsc --noEmit` 也通過。

### 4.3 一次性的回應逐位元組比對（沒有提交）

把同一份測試複製成暫時的檔案，在 HTTP 用戶端加一行，把每一筆回應（測試名稱、網址、狀態碼、兩個標頭、原始本體文字）寫進 JSONL；只把暫存資料夾路徑、連接埠、ISO 時間與 `server_now` 換成固定字。重整前跑兩次確認輸出穩定（兩次相同），重整後再跑一次：

- **294 筆回應、1,685,615 位元組，前後 `cmp` 完全相同**（SHA-256 都是 `dcfe80bd…`）。

這份暫時的測試與 JSONL 沒有進 repo，之後無法直接重跑；可重現的證據是 §4.1 的測試。

### 4.4 指令與結果

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過 |
| 單元與整合測試 | `npx vitest run` | 178 個測試檔通過；3,337 項中 3,332 項通過、5 項跳過；約 67 秒。比基準多 2 個檔、23 項（就是新增的兩個測試檔）。跳過數依環境而異（同一份程式稍早一次是 6 項） |
| 前端建置 | `npx vite build` | 通過；仍有 chunk 超過 500 kB 的警告（與基準相同） |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過：143 份、142 組完整配對、1 份 inline |
| 空白 | `git diff --check` | 通過 |
| 架構量測 | `node scripts/architecture-metrics.mjs` | 見 §3.1 |
| 既有測試檔沒有修改 | `git status --short` | `tests/` 底下只有新增的兩個檔 |

任務指定的既有測試（`http`、`backend-i18n`、`camera-settings`、`camera-enable`、`audio-settings`、`wake-settings`、`clock-settings`、`voice-settings`、`day-night-mode`、`home-corner`、`memories-http`、`proactive-http`、`alarms`、`realtime-routes`、`service-mode`、`architecture`）都在全套測試裡，沒有修改就通過；架構守門測試（跨層 import 0、沒有新的 import 環）維持綠燈。

基準：`git archive 1b61d08` 的乾淨副本上 `npx vitest run` 是 176 個測試檔通過、3,314 項中 3,308 項通過、6 項跳過。

## 5. 限制

- 只有雲端容器的 fixture 測試；沒有在 Mac 或 Pi 上啟動過，也沒有用真的設定頁或選單列按過這些設定。
- 寫入失敗只測了兩種：store 丟固定的錯誤，與設定檔（或暫存檔）的位置是非空資料夾。磁碟滿、權限不足沒有測。
- `413 body too large` 與 `415`（Content-Type）沒有逐條測；它們在 `readJson` 與 `checkRequest`，這一批沒有改。
- 「查表合成一處不改變先後」是讀程式得出的（§3.2），加上每一條路徑與 404 的測試；沒有窮舉所有路徑。
- §4.3 的逐位元組比對沒有提交；它涵蓋的是測試會送出的那 294 個請求，不是所有可能的輸入。
- 讀回時的第二次驗證（`PrefsFile`）沒有動，也沒有證明兩處驗證等價；那是 23 §3 說的另一個 PR。
- `校正值沒有保存…` 沒有英文翻譯（§2）是既有的缺口，這一批照原樣保留。
- 全套測試通過只是程式檢查，不是 G0–G3 或任何 Mac／Pi gate。
