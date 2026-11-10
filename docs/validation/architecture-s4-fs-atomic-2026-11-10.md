<!-- bilingual: source=zh-TW -->

> [繁體中文](architecture-s4-fs-atomic-2026-11-10.md) | [English](architecture-s4-fs-atomic-2026-11-10.en.md)

# 架構重整 S4：共用原子寫檔 helper（2026-11-10）

對應文件：[23 架構盤點與重整計畫](../23_Architecture_Review_2026-11.md) §P1-3 與 §3 的 S4。這一批只做一件事：新增 `server/fs-atomic.ts` 的 `writeAtomic`，讓五個最簡單的「先寫暫存檔再 `renameSync`」呼叫者改用它，**行為不變**。**全部是 Linux 雲端容器的自動化測試，不是產品 gate，也不是實機驗收。**

## 1. 環境

- 基準：分支 `claude/architecture-review-2026-11` 的 `3cc1401`；本批分支 `claude/arch-s4-fs-atomic`。
- Linux 雲端容器（以 root 執行，umask 022）、Node.js v22.23.4、vitest 5.0.3、TypeScript 7.0.2、Vite 8.3.4。
- 沒有麥克風、鏡頭、Mac、Pi、中控或電視；沒有任何真實帳號。配對金鑰、費用紀錄都是測試裡的 fixture 值。

## 2. 改了什麼

| 檔案 | 變更 |
|---|---|
| `prototype/ambient-shell/server/fs-atomic.ts` | 新增。`writeAtomic(path, data, options)`：`data` 是字串（UTF-8）或 `Uint8Array`；步驟固定為 mkdir（有要求時）→ 寫暫存檔 → chmod 暫存檔（有要求時）→ rename；失敗丟出原本的錯 |
| `server/providers.ts` | `writeJson` 改成一行 `writeAtomic(path, JSON.stringify(value, null, 2))` |
| `server/proactive.ts` | `ProactiveDailyLog.mark` 的內層 try／catch 改成 `writeAtomic(…, { mode: 0o600, removeTempOnError: true })`；`mkdirSync(this.options.dir, …)`、之後的 `chmodSync` 與外層只記 log 的 catch 留在原地。同檔的 `ProactiveSettingsStore`（PrefsFile）沒有動 |
| `server/voice-cost-log.ts` | `write` 改成 `writeAtomic(…, { mode: 0o600, mkdir: 0o700, chmodTemp: true })`；只留 500 筆的 `slice` 與只記 log 的 catch 留在原地 |
| `server/lgtv/store.ts` | `writePairing` 改成 `writeAtomic(…, { mode: 0o600, mkdir: 0o700, chmodTemp: true, tempSuffix: ".<pid>.tmp" })`；之後對正式檔的 `chmodSync`（失敗會丟出）留在原地 |
| `server/nous.ts` | `memoryEnabledHint().set` 改成 `writeAtomic(…, { mode: 0o600, mkdir: true })` |
| `tests/fs-atomic.test.ts` | 新增，26 項 |

五個來源檔合計 +18／-32 行（淨 -14 行）。`writeAtomic` 的選項：

| 選項 | 預設 | 作用 |
|---|---|---|
| `mode` | 不給（Node 預設 0o666，照 umask 遮罩） | 建立暫存檔時的權限。暫存檔已存在時 `writeFileSync` 不會改它的權限 |
| `tempSuffix` | `".tmp"` | 暫存檔名＝目標路徑＋字尾 |
| `mkdir` | 不建 | `true`：`mkdirSync(dirname(path), { recursive: true })`；數字：同上並帶 `mode` |
| `chmodTemp` | 不做 | rename 之前 `chmodSync(暫存檔, mode)`；失敗會丟出 |
| `removeTempOnError` | 不做（暫存檔留著） | 寫入、chmod 或 rename 失敗時先 `rmSync(暫存檔, { force: true })` 再丟出原本的錯。mkdir 失敗不清理（那時還沒有暫存檔） |

不 fsync、不用 `O_EXCL`、暫存檔名不帶亂數：這些是 durable 寫法（下表 D 類）的事，不放進這個 helper。沒有統一暫存檔名：`lgtv/store.ts` 保留 `.<pid>.tmp`，其餘四個本來就是 `.tmp`。`grep -rn "\.tmp" tests` 找到的測試都屬於沒有搬的模組（`alarms`、`voice-settings`／`camera-settings` 經 `prefs-file.ts`、`memory-store`、`task-vault`、`identity-store`、`wake-runtime-manifest`）。

沒有重用既有函式：`prefs-file.ts:97` 的 `write` 是 `PrefsFile` 的 private 方法並綁定它的資料格式；`store.ts:1013` 的 `writeJsonAtomic` 是 fsync＋`O_EXCL`＋亂數檔名的 durable 寫法，給這五個呼叫者用會改變暫存檔名、同步行為與失敗時的清理。

## 3. 語意對照表

`grep -rn "renameSync" prototype/ambient-shell/server` 在 `3cc1401` 找到 16 個檔（`memories-google.ts` 另有兩處是搬下載檔，不是寫設定）。

### 3.1 已搬的五個（搬之前的語意，搬之後相同）

| 呼叫者 | 暫存檔名 | 建上層資料夾 | 暫存檔權限 | 內容 | rename 前 chmod 暫存檔 | rename 後 chmod 正式檔 | 失敗時暫存檔 | 錯誤 |
|---|---|---|---|---|---|---|---|---|
| `providers.ts` `writeJson`（`settings.json`） | `.tmp` | 不建 | 不指定（0o666 & ~umask） | `JSON.stringify(v, null, 2)`，無結尾換行 | 無 | 無 | 留著 | 丟出 |
| `proactive.ts` `ProactiveDailyLog.mark`（`proactive-log.json`） | `.tmp` | `mkdirSync(options.dir, recursive, 0o700)`（留在呼叫端） | 0o600 | `JSON.stringify(v)`（不縮排），無結尾換行 | 無 | 有，失敗吞掉 | 刪掉再丟 | 外層 catch 只記 log，不丟出 |
| `voice-cost-log.ts` `write`（`voice-cost.jsonl`） | `.tmp` | `dirname(file)`，recursive，0o700 | 0o600 | 最近 500 行以 `\n` 連接，結尾一個 `\n` | 有（0o600），失敗丟進 catch | 無 | 留著 | catch 只記 log，不丟出 |
| `lgtv/store.ts` `writePairing`（`lgtv.json`） | `.<pid>.tmp` | `dirname(file)`，recursive，0o700 | 0o600 | `JSON.stringify(v, null, 2)`，無結尾換行 | 有（0o600），失敗丟出 | 有，失敗丟出 | 留著 | 丟出 |
| `nous.ts` `memoryEnabledHint().set`（`memory-enabled.json`） | `.tmp` | `dirname(file)`，recursive，Node 預設權限 | 0o600 | `JSON.stringify({ enabled })`，無結尾換行 | 無 | 無 | 留著 | 丟出 |

五個都是字串以 UTF-8 寫入、都不 fsync。

### 3.2 沒搬的十一個

| 檔案 | 類別 | 語意摘要 | 為什麼這批不搬 |
|---|---|---|---|
| `prefs-file.ts:97` | A | `.tmp`、`mkdir(dir, 0o700)`、0o600、縮排 2、失敗刪暫存檔再丟、之後 chmod 正式檔（吞錯） | 和 `proactive.ts` 的每日紀錄同型，`writeAtomic` 可以原樣表達；但它是 11 個 store 的共用寫入點，S5（PrefsFile store 工廠）正在動同一區，留給 S5 之後 |
| `alarms.ts:610` | A | 同上 | 任務明列不動；`alarms.test.ts:253` 還依賴 `alarms.json.tmp` 這個檔名 |
| `codex-auth.ts:583` | A | 同上（登入憑證） | 任務明列不動 |
| `chatgpt-auth.ts:508` | B | `.tmp`、不建資料夾、0o600、縮排 2、失敗留暫存檔、之後 chmod 正式檔 | 任務明列不動（登入憑證） |
| `integrations/voice-relay/store.ts:84` | B | `.<pid>.<Date.now()>.tmp`、`mkdir(dir, 0o700)`、0o600、縮排 2 **加結尾換行**、失敗留暫存檔、丟出 | 可以用 `tempSuffix` 表達，但不在計畫列的五個裡，也沒有直接測試（23 §1.5），留到下一批 |
| `memories-google.ts:215` `save` | B | `.tmp`、不建資料夾、0o600、不縮排、失敗留暫存檔、丟出 | 可以表達，但不在計畫列的五個裡；同檔另外兩處 `renameSync`（:124、:522）是搬下載檔，和寫設定無關 |
| `store.ts:1013` `writeJsonAtomic` | D | `.tmp-<uuid>`、`O_EXCL`＋`O_NOFOLLOW`、0o600、fsync 檔案與資料夾、失敗 unlink | durable 寫法，任務明列不動 |
| `task-migration.ts:157` `writeDurable` | D | 同上（Buffer） | 同上 |
| `sealed-vault.ts:119` | D | 同上，另有 checkpoint 掛點與 `finally` 清理 | 同上 |
| `memory/store.ts:343` | D | 同上，另有寫入鎖檢查與 checkpoint | 同上 |
| `identity-store.ts:373` | D | 資料夾內亂數檔名、`"wx"`、fsync、失敗刪暫存檔 | 同上 |

A＝和已搬的 `proactive.ts` 同型；B＝簡單但各有一點不同；D＝durable（fsync、`O_EXCL`、亂數檔名）。任務說明提到 `voice-cost-log.ts` 可能因為輪替而不好搬：實際看過，輪替只是寫入前的 `slice(-500)`，寫檔本身是單純的 mkdir → 寫 → chmod → rename，所以搬了。

## 4. 前後相同的證據

### 4.1 逐一對照（舊 → 新）

| 呼叫者 | 舊（`3cc1401`） | 新 | 為什麼相同 |
|---|---|---|---|
| `providers.ts` | `writeFileSync(tmp, s)`；`renameSync(tmp, path)` | `writeAtomic(path, s)` | 沒給 `mode` 時 helper 呼叫的就是 `writeFileSync(tmp, s)`（不帶 options）；沒給 `mkdir`、`chmodTemp`、`removeTempOnError`，所以沒有多出任何步驟 |
| `proactive.ts` | `try { writeFileSync(tmp, s, { mode: 0o600 }); renameSync } catch { rmSync(tmp, { force: true }); throw }` | `writeAtomic(path, s, { mode: 0o600, removeTempOnError: true })` | helper 的 try／catch 就是這一段；mkdir 在呼叫端、在 helper 之前，失敗時兩邊都不會跑到 rmSync |
| `voice-cost-log.ts` | `mkdirSync(dirname(file), { recursive: true, mode: 0o700 })`；`writeFileSync(tmp, s, { mode: 0o600 })`；`chmodSync(tmp, 0o600)`；`renameSync` | `writeAtomic(file, s, { mode: 0o600, mkdir: 0o700, chmodTemp: true })` | 四個步驟與順序相同，參數相同；任何一步丟錯都落進呼叫端同一個 catch |
| `lgtv/store.ts` | 同上，暫存檔名 `${file}.${process.pid}.tmp`；之後 `chmodSync(file, 0o600)` | `writeAtomic(file, s, { …, tempSuffix: \`.${process.pid}.tmp\` })`；之後 `chmodSync(file, 0o600)` | 暫存檔名是 `path + tempSuffix`，字串相同；最後的 chmod 沒有動 |
| `nous.ts` | `mkdirSync(dirname(file), { recursive: true })`；`writeFileSync(tmp, s, { mode: 0o600 })`；`renameSync` | `writeAtomic(file, s, { mode: 0o600, mkdir: true })` | `mkdir: true` 呼叫的是不帶 `mode` 的 `mkdirSync(dirname(path), { recursive: true })` |

五個呼叫者傳進去的字串運算式都沒有改（`git diff 3cc1401 -- prototype/ambient-shell/server` 可核對）。

### 4.2 自動比對

`tests/fs-atomic.test.ts` 的第二個 `describe` 把 `3cc1401` 的五段舊寫法重現成 `legacy`（寫檔的那幾行逐字相同，但不是每一段都是原樣的一個函式：`legacy.voiceCost` 是把 `record()`、`lines()`、`write()` 三個方法攤平成一個；`legacy.proactive` 只留寫檔段，沒有 log 呼叫，也沒有 `mark()` 前面的日期與 `Set` 記帳），和現在的呼叫者各在一個新的暫存資料夾裡執行，再比兩邊的 snapshot（資料夾權限、每個檔名、內容的 hex、檔案權限）：

- 正常寫入 5 項：兩邊完全相同，而且資料夾裡只有 1 個檔（沒有留下暫存檔）。除了 `providers.ts`（本來就不建資料夾）之外，都從還不存在的子資料夾開始，所以也比到「上層資料夾建成什麼權限」。
- 已經有一個 0o644 的舊暫存檔 5 項：兩邊結果相同。有 `chmodTemp` 的兩個（`voice-cost-log.ts`、`lgtv/store.ts`）寫出來仍是 0o600；`providers.ts` 與 `nous.ts` 沿用暫存檔的 0o644（搬之前就是這樣）；`proactive.ts` 靠之後對正式檔的 chmod 變成 0o600。`voice-cost-log.ts` 這一項只寫一次（寫兩次時第二次會重新建立暫存檔，看不出差別）；暫時把它的 `chmodTemp` 拿掉，這一項會失敗，確認過之後已還原。
- 目標被非空資料夾佔住（rename 失敗）5 項：兩邊「丟不丟錯」與失敗後資料夾內容相同（`proactive.ts` 不留暫存檔、不丟；`voice-cost-log.ts` 留暫存檔、不丟；其餘三個留暫存檔、丟出）。

既有測試沒有修改：`voice-cost-log.test.ts`、`proactive.test.ts`、`proactive-calendar.test.ts`、`proactive-http.test.ts`、`integration-lg-tv.test.ts`，以及經 `ProviderManager.select` 與 `memoryEnabledHint` 的 HTTP／整合測試，都在第 5 節的全套測試裡通過。

## 5. 驗證結果

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別檢查 | `npx tsc --noEmit` | 通過 |
| 新測試 | `npx vitest run tests/fs-atomic.test.ts` | 1 個檔、26 項通過 |
| 單元與整合測試 | `npx vitest run` | 173 個測試檔通過；3,220 項中 3,215 項通過、5 項跳過；60 秒。基準是 172 檔 3,194 項：多的 1 檔 26 項就是 `fs-atomic.test.ts`。加入舊暫存檔案例之前的那一次是 3,215 項中 3,209 項通過、6 項跳過；跳過數依環境而異（見第 6 節） |
| 前端建置 | `npx vite build` | 通過；警告 `zh-tw-opencc` chunk 超過 500 kB（與基準相同） |
| 桌面主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 隔離 mock 流程 | `node scripts/verify-aios.mjs` | PASS |
| 雙語文件 | `node scripts/check-bilingual-docs.mjs` | 通過：138 份、137 組完整配對、1 份 inline |
| 空白 | `git diff --check` | 通過 |
| 量測 | `node scripts/architecture-metrics.mjs` | `own tmp+rename`：16 個檔 → 12 個檔（少了 `providers`、`proactive`、`voice-cost-log`、`lgtv/store`、`nous`，多了 `fs-atomic`；12 個裡含 `prefs-file.ts` 與 `fs-atomic.ts` 兩個共用 helper）。跨層 import 0、import 環 4 組、超過 800 行的檔 16 個都不變；server 102 → 103 檔、30,844 → 30,871 行 |

## 6. 限制

- 只在 Linux 容器（root、umask 022）跑過。macOS 的權限語意與 Linux 相同但沒有實測；Windows 沒有 POSIX 權限，測試在那裡略過權限斷言，也沒有實跑。
- 全套測試的跳過數依環境而異：同一個容器先後兩次是 6 項與 5 項（`apikey-integration.test.ts` 等用 `describe.skipIf(!realLockAvailable)`，基準紀錄也記過同樣的現象），和這批的變更無關。
- 以 root 執行，所以「權限不足」這類失敗沒有被測到；失敗案例用的是「目標被非空資料夾佔住」「上層是一般檔案」。
- 比對的是每個呼叫者一組代表性輸入，不是所有輸入；「內容相同」另外靠第 4.1 節的對照：傳給寫檔函式的字串運算式沒有改。
- `chmodSync` 失敗的路徑（`voice-cost-log.ts`、`lgtv/store.ts`）只靠讀碼對照，沒有自動測試。
- helper 和原本的寫法一樣不 fsync：當機時的耐久性沒有變好也沒有變差。
- 這批沒有動 23 §P1-3 的其餘部分（頁面 localStorage、預設值重複、桌面複製 shared）。
- 測試全綠只是 mock／fixture 的程式檢查，不是 G0–G3 或任何 Mac／Pi gate。
