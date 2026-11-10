<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s5-prefs-store-2026-11-10.md) | [English](architecture-s5-prefs-store-2026-11-10.en.md)

# 架構重整 S5：設定 store 共用基底（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §P1-3 與 §3 的 S5。這一批只搬動重複的樣板，**目標是行為完全不變**。全部是雲端容器裡的型別檢查與 fixture／mock 自動化測試，**不是產品 gate，也不是 Mac／Pi 實機驗收**。

## 1. 環境

- 分支 `claude/arch-s5-prefs-store`，基準是 `claude/architecture-review-2026-11` 的 `3cc1401`（main `416a1ab` 加上架構盤點文件）。
- Linux 雲端容器、Node.js v22.23.4、vitest 5.0.3、TypeScript 7.0.2、Vite 8.3.4。`prototype/ambient-shell/node_modules` 是指向主要 checkout 的符號連結，沒有提交。
- 沒有麥克風、鏡頭、Mac、Pi、中控或電視；沒有任何真實帳號。

## 2. 做了什麼

新增 `prototype/ambient-shell/server/prefs-store.ts`（41 行）：基底類別 `PrefsStore<S, O>`，只收 11 個 store 逐字相同的三件事。

| 成員 | 內容 | 取代的樣板 |
|---|---|---|
| `constructor(spec, options)` | 用 `spec`（`name`、`parse`、`failClosed`、`unreadable`）加上 `options.dir`、`options.log`、`version: 1` 建立 `PrefsFile` | 每個 store 10 行的 `new PrefsFile({...})` 與 `private readonly file` 欄位 |
| `protected resolve(keys, defaults)` | 依 `keys` 的順序，每個鍵取「保存的值 `??` 預設值」 | `Object.fromEntries(KEYS.map((key) => [key, saved[key] ?? DEFAULTS[key]])) as unknown as P` |
| `protected commit(patch)` | `this.file.update(patch)` 之後呼叫 `this.options.onChange()` | 每個 `update()` 裡的那兩行 |

沒有 hook、沒有選項開關。`view()` 的形狀、`update()` 的規則與回傳值、額外的方法都留在各 store。`prefs-file.ts` 沒有修改，所以讀檔、逐鍵驗證、fail closed、原子寫入、0600 權限與 log 字串都還是同一段程式。

**與 23 §3 原文的差異**：原計畫寫的是 `createPrefsStore(spec, file, defaults)` 工廠、各檔只留一行 export。實際讀完 11 個 store 之後，只有 2 個（`voice`、`memories`）的 `view()`／`update()` 完全沒有自己的邏輯；工廠要涵蓋其餘 9 個就得加好幾個 hook。所以改成基底類別加兩個 helper，各 store 保留自己的類別。

### 2.1 逐一盤點

共同點：建構參數都有 `dir`、`onChange()`、`log?`；`schema_version` 都是 1；`update()` 都是「先寫檔，成功後才改記憶體並呼叫 `onChange`」，**不比較值有沒有變，每次成功的寫入都呼叫一次**；寫檔失敗時丟錯、不呼叫 `onChange`。「讀不懂」沒有獨立的狀態欄位：`PrefsFile` 記一筆 log（`無法讀取 <路徑>（<原因>），<unreadable>`）並套用 `failClosed`，檔案留在原地不覆寫，直到下一次 `update()`。

| store（檔案） | 設定檔 | 額外建構參數 | 預設值來源 | `failClosed` | `unreadable` 字串 | `view()` | `update()` 與其他方法 |
|---|---|---|---|---|---|---|---|
| `ClockSettingsStore`（`clock-settings.ts`） | `clock.json` | 無 | `DEFAULT_CLOCK_PREFS` | `{}` | 右上角時鐘用預設值 | `view(source)` 回 `{ enabled, prefs, write_path }`，`enabled` 依來源是 main 或 terminal；另有 `prefs()` | `update()` 回 `prefs()`（不是 `view()`） |
| `HomeCornerSettingsStore`（`home-corner-settings.ts`） | `home-corner.json` | 無 | `DEFAULT_HOME_CORNER_PREFS` | `{}` | 左上角家中狀態用預設值 | 同時鐘 | 同時鐘 |
| `VoiceSettingsStore`（`voice-settings.ts`） | `voice.json` | 無 | `DEFAULT_VOICE_PREFS` | `{}` | 語音閒置秒數用預設值 | 保存值疊預設值 | 直接寫入，回 `view()` |
| `MemoriesSettingsStore`（`memories.ts`） | `memories.json` | 無 | `DEFAULT_MEMORIES_PREFS` | `{ enabled: false }` | 回憶模式保持關閉 | 保存值疊預設值 | 直接寫入，回 `view()` |
| `AudioSettingsStore`（`audio-settings.ts`） | `audio.json` | 無 | `DEFAULT_AUDIO_PREFS` | `{ ...DEFAULT_AUDIO_PREFS }` | 聲音輸入與輸出都用系統預設 | 保存值疊預設值 | 裝置 id 選回 `null` 時把對應的名稱一起寫成 `null` |
| `WakeSettingsStore`（`wake-settings.ts`） | `wake.json` | 無（只有 `NOUS_WAKE=on` 才建立） | `DEFAULT_WAKE_PREFS` | `{ wake_listen: false, device_id: null, voice_name_test: false, speaker_in_call: false }` | 常駐喚醒聆聽保持關閉 | 保存值疊預設值 | 開關關著（或這次關掉）時把 `device_id` 寫成 `null` |
| `RealtimeSettingsStore`（`realtime-settings.ts`） | `realtime.json` | `defaults`（來自 `.env`） | `options.defaults` | `{}` | 即時語音的路徑偏好用預設值 | `{ ...defaults, ...saved }`（展開，不是逐鍵 `??`） | 直接寫入，回 `view()` |
| `CameraSettingsStore`（`camera-settings.ts`） | `camera.json` | `base`（`loadConfig().camera`） | `options.base` | `{ active: false }` | 鏡頭保持關閉；其他設定用 .env 與預設值 | 安裝設定（永遠來自 `.env`）加上保存值疊 `base` | 直接寫入，回 `view()` |
| `FaceTuningStore`（`face-tuning-settings.ts`） | `face-tuning.json` | `now?()` | `DEFAULT_FACE_TUNING` | `{}` | 人臉辨識校正值用預設 | 多 `customized`、`calibrated_at`；整組不合理時整組退回預設 | `update(patch, calibrated)` 先檢查合併後的整組，`calibrated` 時記時間；`reset()` 用 `file.replace({})` |
| `DayNightSettingsStore`（`day-night-settings.ts`） | `day-night.json` | `now?` | `DEFAULT_DAY_NIGHT_PREFS` | `{}` | 日夜間模式用預設值 | `{ prefs, override, saved, core_mode, write_path }`；另有 `prefs()`、`override()`、`coreMode()` | `override` day／night 依 `scope` 算結束時間、`auto` 寫成 `null`；保存的形狀比 prefs 多一個 `override` |
| `ProactiveSettingsStore`（`proactive.ts`） | `proactive.json` | 無 | `DEFAULT_PROACTIVE_PREFS` | `{}` | 主動提醒用預設值 | 保存值疊預設值；開始 ≥ 結束時時段退回預設 | 先檢查合併後的時段，不合法丟 `ProactivePatchError`、不寫檔 |

### 2.2 遷移結果與行數

11 個都遷移。基底只提供建構與兩個 helper，所以每個 store 的改動都是把相同的幾行換成一行，沒有為任何一個 store 加選項。

| store | 遷移 | 用到的基底成員 | 保留在 store 的寫法 | 行數（前 → 後，`wc -l`） |
|---|---|---|---|---|
| `clock-settings.ts` | 是 | 建構、`resolve`、`commit` | `view(source)`、`update()` 回 `prefs()` | 40 → 28 |
| `home-corner-settings.ts` | 是 | 建構、`resolve`、`commit` | 同上 | 40 → 28 |
| `voice-settings.ts` | 是 | 建構、`resolve`、`commit` | 無額外邏輯 | 39 → 27 |
| `memories.ts`（`MemoriesSettingsStore`） | 是 | 建構、`resolve`、`commit` | 無額外邏輯 | 254 → 242 |
| `audio-settings.ts` | 是 | 建構、`resolve`、`commit` | 名稱跟著 id 清掉 | 49 → 37 |
| `wake-settings.ts` | 是 | 建構、`resolve`、`commit` | 開關關著時不記麥克風 | 48 → 36 |
| `realtime-settings.ts` | 是 | 建構、`commit` | `view()` 仍是 `{ ...defaults, ...saved }`。沒有改用 `resolve`：展開與逐鍵 `??` 對保存的 `null` 和鍵的順序不保證相同，不值得為了省一行去證明 | 41 → 30 |
| `camera-settings.ts` | 是 | 建構、`resolve`、`commit` | 安裝設定與 `base` 合併 | 58 → 46 |
| `face-tuning-settings.ts` | 是 | 建構、`resolve`、`commit` | 整組檢查、`calibrated_at`、`reset()` 直接用 `this.file.replace({})` | 85 → 74 |
| `day-night-settings.ts` | 是 | 建構、`commit` | `prefs()` 仍逐鍵寫出（`shared/day-night.ts` 沒有鍵的清單，不為這個新增）、手動切換的全部邏輯 | 76 → 66 |
| `proactive.ts`（`ProactiveSettingsStore`） | 是 | 建構、`resolve`、`commit` | 時段檢查 | 323 → 311 |
| 合計 | 11／11 | | | 1,053 → 925（−128）；加上 `prefs-store.ts` 41 行，淨 −87 |

各 store 對外不變的部分：匯出的類別與型別名稱、建構參數、公開方法簽章、每一個使用者看得到的字串（`unreadable` 與錯誤訊息逐字相同，`server/messages.en.json` 沒有修改）。TypeScript 層面的差異只有 `file` 與 `options` 從 `private` 變成 `protected`（基底類別持有），沒有新增公開成員。

## 3. 驗證

### 3.1 新增的測試

`tests/prefs-store.test.ts`，22 項，全部用 `mkdtempSync` 的暫存資料夾（每項結束後在 `afterEach` 刪掉）：

- `PrefsStore`（用測試裡定義的最小 store，17 項）：沒有檔案時是預設值、鍵的順序照 `keys`、不建立檔案；`update` 寫出的 JSON 逐字比對（2 個空白縮排、結尾沒有換行）、檔案 0600、資料夾 0700、不留 `.tmp`；同樣的 patch 再送一次檔案不變但 `onChange` 仍呼叫；保存的 `null` 視同沒有保存；`resolve` 不帶 `defaults` 多出來的鍵；逐鍵驗證（壞掉的鍵丟掉並記 log、在 `failClosed` 裡的鍵用 `failClosed` 的值、其餘照用）；檔案讀不懂的 6 種情況都 fail closed、記一筆 log、**不覆寫檔案**；讀不懂之後第一次 `update` 寫出 `failClosed` 疊上 patch；`failClosed` 是 `{}` 時退回預設；寫檔失敗的兩條路徑都丟錯、記憶體不變、不呼叫 `onChange`：（一）寫 `.tmp` 就失敗（`.tmp` 已經是資料夾）時原本的設定檔不變，而 `rmSync(tmp, { force: true })` 刪不掉資料夾，所以那個 `.tmp` 資料夾**還在**，丟出來的是清理的錯誤；（二）`renameSync` 失敗（設定檔的位置是非空資料夾）時丟出 rename 的錯誤，剛寫好的 `.tmp` 檔**被清掉**；沒有傳 `log` 時用 `console.warn`；真實的 `ClockSettingsStore` 寫出的位元組、權限與 log 字串。
- `PrefsFile` 直接測試（5 項；這個模組先前沒有任何測試直接 import）：`path` 與空的 `saved`；`update` 合併與 `schema_version`、版本不符視為讀不懂；`replace` 整份換掉且複製傳入的物件；讀不懂時 `saved` 是 `failClosed` 的複本；既有檔案權限較寬時寫入後收回 0600。

預期的檔案內容是照重整前的程式推出來的：`JSON.stringify({ schema_version: 1, prefs }, null, 2)`、`writeFileSync(tmp, …, { mode: 0o600 })`、`renameSync`、`chmodSync(path, 0o600)`。

### 3.2 一次性的前後差異比對（沒有提交）

用 `git archive HEAD` 把重整前的 `server/` 與 `shared/` 解到暫存資料夾，寫一支暫時的 vitest 測試，把同樣的輸入分別餵給重整前與重整後的 11 個 store，比對：每個讀取方法的 `JSON.stringify` 結果、每次 `update`／`reset` 的回傳或丟出的錯誤類別與訊息、log 字串（把暫存路徑換成固定字）、設定檔的完整文字與權限、`onChange` 的累計次數、重新建立 store 後讀回的結果。

- 起始檔案：每個 store 7–8 種（沒有檔案、4 種讀不懂的內容、2–3 種含合法與不合法鍵的內容）。
- 寫入序列：每個 store 2–5 步，包含會被拒絕的寫入（人臉校正的距離範圍、主動提醒的時段）。
- 結果：11 個 store 全部相同，共比對 **1,450** 筆輸出（測試以 `before.length` 累加後印出）；丟出的錯誤只有預期的兩種（「辨識的最遠距離要比最近距離遠至少 0.3 m」、「時段的開始要早於結束」）。

這支測試依賴暫存資料夾裡的舊程式，跑完就刪除，沒有進 repo；可重現的證據是 §3.1 的測試與不經修改就通過的既有測試。

### 3.3 指令與結果

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過 |
| 單元與整合測試 | `npx vitest run` | 173 個測試檔通過；3,216 項中 3,211 項通過、5 項跳過；約 50 秒。比基準多 1 個檔、22 項（就是 `tests/prefs-store.test.ts`）。跳過數依環境而異（基準紀錄是 6 或 5 項） |
| 前端建置 | `npx vite build` | 通過；仍有 chunk 超過 500 kB 的警告（與基準相同） |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過：138 份、137 組完整配對、1 份 inline |
| 空白 | `git diff --check` | 通過 |
| 既有測試檔沒有修改 | `git diff --stat` | `tests/` 底下只有新增的 `prefs-store.test.ts` |

23 §3 的 S5 列出的既有測試（`audio-`／`camera-`／`clock-`／`voice-`／`wake-settings`、`camera-prefs`、`prefs`、`day-night-mode`、`home-corner`、`memories-http`、`memories-google`、`proactive`、`proactive-calendar`、`apikey-integration`、`live-integration`、`http`、`backend-i18n`）都在上面的全套測試裡，沒有修改就通過。

## 4. 限制

- 只有雲端容器的 fixture 測試；沒有在 Mac 或 Pi 上用真實的 `~/.config/nous/*.json` 啟動過。設定檔格式沒有改，不需要搬移資料，但這一點是由測試與讀程式得出，不是實機觀察。
- §3.2 的差異比對沒有提交，之後無法直接重跑；輸入組合是人工挑的，不是窮舉。
- `face-tuning.json` 在 repo 的既有測試裡仍然只經 `http.test.ts` 間接測到；這一批沒有為它加專屬測試。
- 獨立審查另外自己跑了一次重整前後的差異比對：11 個 store、676 筆紀錄、0 筆不同；同樣沒有提交。
- 全套測試的跳過數依環境而異（有的測試用 `describe.skipIf`），同一份程式在不同次執行可能是 5 或 6 項。
- `PrefsFile` 寫檔失敗只測了兩種方式（`.tmp` 已經是資料夾、設定檔的位置是非空資料夾）；磁碟滿或權限不足沒有測。
- 這一批不處理 23 §P1-3 的其他項目：`app.ts` 的 13 條設定路由（S6）、繞過 `prefs-file.ts` 的 15 個寫檔模組（S4）、讀回時的第二次驗證。
- 全套測試通過只是程式檢查，不是 G0–G3 或任何 Mac／Pi gate。
