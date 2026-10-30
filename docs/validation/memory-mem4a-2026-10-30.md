<!-- bilingual: source=zh-TW -->

> [繁體中文](memory-mem4a-2026-10-30.md) | [English](memory-mem4a-2026-10-30.en.md)

# MEM-4a 任務加密、背景任務自動帶記憶與撤銷傳播：雲端驗證與 Mac gate

日期為 2026-10-30，Asia/Taipei。起點是 main `368235a`（已含 MEM-0 至 MEM-3 與 HIST-1），在獨立 worktree 分支 `claude/mem-4a` 實作，沒有提交、推送或合併。全部人物、帳號、任務與記憶內容都是虛構的 canary 測試資料。

**本批狀態：MEM-4a 的程式與雲端（Linux）可驗部分已完成；Mac gate 全部未執行、未通過。** 任務加密在 macOS App 一律開啟；背景任務自動帶記憶**預設關閉**（`NOUS_MEMORY_ROUTES` 列出 `task` 才打開）。不能據此宣稱 Nous 在真機上已安全加密任務或已能讓背景任務安全使用記憶。瀏覽器版沒有 safeStorage／Keychain，照舊明文、不搬遷。

## 1. 擁有者決定（George，2026-10-30）

1. **macOS App 加密全部任務**，不只用到記憶的任務：`tasks.json`（標題是使用者原句、步驟標題、錯誤）與 `artifacts.json`（內容、假設、能力缺口）。舊的明文在 App 內搬遷一次、可回復：讀明文 → 加密寫入 → 逐筆解密驗證 → 原檔移到 `userData/data/plaintext-backup-<日期>/`（0700）→ 備份保留到使用者在畫面上確認刪除。任何一步失敗明文都不動，照實回報。瀏覽器版不加密、不搬遷。
2. **背景任務自動帶記憶**，不加卡片按鈕：帶記憶的一輪交辦，或記憶開著時的任何交辦，改走受保護交辦（同一個 MemoryService 檢索 8 筆／4 KB；同意沿用任務引擎的 claude／chatgpt 同意（Q4-A）；人物取本次人物；來源票證來自直接輸入）。執行器輸入加 `facts?`，系統指示加 memoryBlock；模擬引擎不帶記憶。放行旗標是 `NOUS_MEMORY_ROUTES` 的 `task`，預設關閉；關閉時和 M15 一樣。標題只能是使用者原句。允許上網查詢（Q4-A），殘餘風險見 §7。
3. **撤銷傳播（Q3-A）**：忘記、更正、撤回同意、刪除人物、關閉記憶都會傳到用過那些記憶的成果：刪除成果內容（原決定稱 crypto-shred；實作是刪除加密檔，見 §2.1），保留外殼、固定句「這份成果用到已忘記的記憶，內容已移除」與「重做」。執行中的任務依賴被撤銷就停止（原因 `memory_revoked`），不產生成果，晚到的輸出丟掉。換人或閒置**不**中止執行中的任務。重做重新取用目前的記憶，不沿用舊依賴。

## 2. 設計與實作

### 2.1 加密保存（`server/sealed-vault.ts`）

- 一筆一檔，放在 `userData/data/sealed/`：任務 `task_<uuid>.enc`（使用者原句、步驟標題、錯誤），成果 `artifact_<uuid>.enc`（內容、假設、能力缺口）。
- 每檔一把隨機資料金鑰，AES-256-GCM；資料金鑰用和記憶相同的 safeStorage secretBox 包裝後放在檔頭。AAD 綁定格式、版本、種類與 ID：檔案改名或內容被改都解不開。
- 檔案 0600、資料夾 0700；寫入是唯一暫存檔 → fsync → rename → 資料夾 fsync（和 `server/memory/store.ts` 相同）。刪除就是刪檔（file deletion）：那把資料金鑰只在這個檔，刪掉後 Nous 自己解不開；但這不是密碼學上的抹除（crypto-shred），見 §7。
- 單一寫入者：資料夾裡的 `writer.lock` 用和記憶檔相同的 BSD 鎖（macOS `/usr/bin/lockf`；Linux 測試用 `flock(1)`）。唯一的呼叫者是 TaskStore（核心裡同步呼叫，不會交錯）；Electron 也有單一實例鎖。
- **為什麼不用記憶檔的鎖或 `userData/memory/results/`（與計畫不同）**：老闆決定全部任務都加密，所以任務加密不論記憶開不開都要運作；記憶檔只在使用者用到記憶時才開（不能為了任務去碰它）。放在 `data/sealed/` 也讓選單列「打開任務與成果資料夾」看到的是同一處。依賴索引（哪個成果用了哪幾筆記憶）仍只由 MemoryService 經記憶檔的寫入鎖與互斥區寫入。

### 2.2 TaskStore 的加密模式（`server/store.ts`）

- `tasks.json` 只放受保護外殼：`protected: true`、ID、狀態、時間、引擎、步驟數與狀態、腦區 `domain`（電子腦動畫仍由真實事件驅動）；標題、步驟標題與錯誤換成固定的雙語句（「受保護的任務，請在 App 內查看」「受保護的步驟」「受保護的錯誤說明，請在 App 內查看」）。加密模式沒有 `artifacts.json`。
- 加密檔只在建立、規劃完成、狀態改變、錯誤、成果產生與撤銷時寫；步驟進度只改外殼（計畫寫「規劃完成與終止時」，本批另在建立時寫，當機後原句才不會遺失）。
- 對外的方法 `publicList`／`publicGet`／`publicArtifact`／`publicDocuments` 與 `subscribe` 一律給外殼；`list`／`get`／`getArtifact`／`documents` 的完整內容只給核心（執行器）與可信主視窗的 IPC。
- 重新啟動：外殼決定有哪些任務與狀態，加密檔補上內容；執行中的任務誠實標為失敗；沒有外殼的加密檔（刪除或撤銷中途中斷的孤兒）與已撤銷任務殘留的成果檔都刪掉。
- 補強（所有版本）：JSON 檔 0600、唯一暫存檔名、檔案與資料夾 fsync；載入時刪掉殘留的暫存檔。格式不變。
- 金鑰不可用或鎖被占用：已有明文時這次照舊明文（`plain_fallback`，不動原檔，下次再搬）；沒有明文時仍寫外殼，新任務的內容只留在記憶體並照實計數、提示。

### 2.3 明文搬遷（`server/task-migration.ts`）

步驟 `read → encrypt → verify → backup → switch`。備份是逐位元組複製加 fsync 再比對（不是 rename：rename 後若當機，`tasks.json` 會不見）。`switch` 先原子取代 `tasks.json` 成外殼，再刪 `artifacts.json`；刪不掉就把 `tasks.json` 從備份還原。任何一步失敗：清掉這次寫的加密檔與備份資料夾，明文原檔逐位元組不變，這次照舊明文。上次搬到一半（`tasks.json` 已是外殼、`artifacts.json` 還在）時再搬一次是安全的。備份資料夾依資料夾名稱偵測，重新啟動也不會自動刪；使用者在畫面上按「刪除明文備份」後，主程序先跳原生確認（頁面無法偽造），按「刪除明文備份」才刪。刪除只是刪檔，不是安全抹除（見 §7）。

### 2.4 對外頻道一律只給外殼

| 頻道 | 加密模式下 |
| --- | --- |
| SSE（`hello`、`task.updated`） | 外殼 |
| `GET /api/tasks`、`POST /api/tasks`、重試／停止的回應 | 外殼 |
| `GET /api/artifacts/:id` | 404 |
| `GET /api/history`、`/api/history/:id`（`/history` 網頁） | 外殼、`protected: true`、沒有成果與片段；畫面顯示「受保護的任務，請在 App 內查看」 |
| 對話提示（`chat.ts` 的任務列） | 只有這個服務帳號對本次人物或全家共用有記憶同意、而且記憶開著時，才放真實標題；帶記憶的任務另外要依賴索引記下的同意對象就是這個帳號、人物是全家共用或本次人物（審查 minor 1）；其他一律外殼 |
| 即時語音指示（兩條路徑）、`get_tasks`、語音完成通知 | 和對話提示同一條規則（George 2026-10-30）：live 看 `codex` 同意、API key 看 `openai_realtime` 同意；沒有同意一律外殼。指示由 `RealtimeSessions.tasks(route)` 取得；`get_tasks` 由頁面經 IPC `voice_tasks` 向核心取得；語音完成通知仍用外殼 |
| 核心 log | 只記筆數、步驟與狀態 |
| 可信主視窗（macOS App） | 經 IPC `nous:tasks`：`list`、`get`（成果內容）、`search`、`redo`、`status`、`delete_backups` |

本機語音合成念完成通知時，念的是畫面上的真實標題（不經模型）。

### 2.5 App 內成果紀錄（MEM-4c 的一部分）

App 內的成果紀錄 Surface 經 IPC `search` 搜尋加密任務的真實內容（核心記憶體內比對，同 HIST-1；受保護來源 `protected: true`），詳細頁經 IPC `get`；刪除仍走 HTTP（只有任務 ID）。`/history` 網頁與 `/api/history` 只有外殼。MEM-4c 剩下的是受保護成果的 RAM 倒排索引、鎖定或關閉時丟棄、與撤銷在同一互斥區移除（目前每次查詢都從核心記憶體重新比對，沒有額外索引）。**2026-10-30 更新：** MEM-4c 已交付（程式與雲端測試，Mac gate 未執行），見 [MEM-4c 驗證](memory-mem4c-2026-10-30.md)。

### 2.6 受保護交辦（背景任務自動帶記憶）

- 只在 `NOUS_MEMORY_ROUTES` 含 `task`（boundary 的放行表 `task`，預設 false）、記憶開著、而且這一輪帶著可信主視窗發的 `memory_turn` 時才有；`MemoryContext.delegate` 為 null 時一切照 M15。
- 模型輸出交辦標記後，串流結束時核心在 MemoryService 的互斥區內：核對 session 與世代 → 用這一輪的原句取得直接輸入、發一次性來源票證並消耗（`issueDelegation`／`consumeDelegation`）→ 依原句檢索（本次人物＋全家共用、任務引擎的同意、8 筆、4 KB）→ 有用到記憶就先把依賴索引寫進記憶快照 → 才建立任務（`TaskRunner.submitProtected`）。頁面收到 `delegated` 事件（外殼），不再收到 `delegate` 或 `delegate_blocked`；寫不進依賴索引時改出原句卡（M15）。
- 標題一律是使用者原句（核心核對過的 `memory_turn` 原文），不是模型的改寫。模擬引擎不帶記憶；沒有同意或沒有相關記憶時照樣交辦，但不帶記憶、沒有依賴。
- 執行器（Claude、ChatGPT）的系統指示最後加 memoryBlock 與一句「上網查詢不要寫進記憶裡的個人偏好或家人資料」；沒有記憶時系統指示和之前逐字相同。
- 重做與重試（App）經 IPC `redo`：核心用自己保存的原句，放行時重新檢索目前的記憶；HTTP 的重試照舊不帶記憶。

### 2.7 依賴索引（記憶快照 v3）

快照新增 `results: [{id, taskId, subject, deps: [{factId, revision}], target: {provider, account}, createdAt, state}]`，沒有任何內容。記憶體裡一律有 `results`；**磁碟上要等第一次產生受保護成果才寫成 version 3**，在那之前照 version 2 寫，欄位與順序和 MEM-3 一樣（測試逐欄核對）。舊版 App 讀到 version 3 會當成損壞而停用記憶（不會覆寫）；若要退回舊版，要先關掉 `task` 旗標、而且不能已經產生受保護成果。

### 2.8 撤銷傳播

所有改記憶的操作都經 `MemoryService.commit`，同一次提交裡用 `withdrawals(before, after)` 算出要撤回的成果：記憶關閉；人物被刪；任何一筆依賴被刪或版本變了（忘記、更正、過期）；依賴所屬範圍對那個服務帳號的同意不再成立。撤回的項目改成 `withdrawn`（清掉 `deps` 與人物），快照寫入成功後才通知任務端：

- 排隊中：停止，`cancel_reason: memory_revoked`；
- 執行中：標為停止中並中止；執行器之後的進度與成果一律丟掉，最後是 `cancelled`＋`memory_revoked`，沒有成果；
- 已完成：成果加密檔刪除、步驟標題換成固定句、`withdrawn: true`，保留使用者原句、外殼與重做。

記憶檔開啟時會為已撤回的成果再傳一次（處理「快照已寫、成果檔還沒刪就當機」）；TaskStore 載入時也清孤兒。換人、暫停、閒置、OS 鎖定都不在撤回規則裡。

### 2.9 介面（雙語，共用翻譯表）

搬遷結果與明文備份提示（「刪除明文備份」「稍後」）、原生確認對話框、搬遷失敗的步驟名、外殼固定句、撤回固定句、`memory_revoked` 說明、重做、IPC 錯誤，都在 `src/messages.en.json`、`server/messages.en.json` 或 `desktop/messages.en.json`。提示不是 Surface（和交辦卡相同，是一個小提示），按「稍後」只是這次不再顯示。

## 3. 與計畫或決定的差異（照實記錄）

1. 加密檔放在 `userData/data/sealed/`，不是 `userData/memory/results/`，也不共用記憶檔的寫入鎖（理由見 §2.1）。
2. 任務加密檔在建立時也寫（計畫只寫規劃完成與終止），當機時原句才不會遺失。
3. 即時語音（ChatGPT 方案與 API key）帶記憶時的交辦**沒有**改成受保護交辦，仍是 M15 的原句卡（`delegatePolicy` 未改）。即時語音的來源票證要從 sideband／旁路逐字稿建立，範圍較大，George 2026-10-30 決定留到下一批（MEM-4b）；卡片上的「交辦」照舊建立不帶記憶的任務。
4. 模型能否看到真實任務標題：記憶開著，而且那個目標對本次人物或全家共用有記憶同意；帶記憶的任務另外要同意對象相同、人物在範圍內。即時語音同樣依那條路徑的同意（George 2026-10-30 決定，取代原本「即時語音一律外殼」）。
5. App 啟動時就碰 Keychain（解開任務與搬遷），和記憶層「用到才開」不同；這是「全部任務加密」的直接結果。
6. 金鑰不可用而已有明文時，這次照舊明文（`plain_fallback`）並提示（明文原本就在，沒有新寫明文）；沒有明文時新任務的內容只留在記憶體並提示，絕不寫明文（George 2026-10-30 確認）。這兩種狀態下都不做受保護交辦（審查 M1）。
7. 過期的記憶在下一次提交時被清除，也會撤回用到它的成果（計畫沒有寫到，但和「依賴被刪」同一條規則）。
8. App 的「重試」也改走 IPC 的重做（記憶放行時重新取用）；HTTP 的重試不變。

## 4. 雲端（Linux）驗證

Node.js 22.22.0。真 AES-256-GCM、真 rename／fsync、Linux 上用 `flock(1)` 當測試鎖；只有資料金鑰的包裝是假的（正式 App 是 safeStorage／Keychain）。執行器與聊天引擎是假的，不呼叫任何模型。

| 測試檔 | 內容 |
| --- | --- |
| `tests/task-vault.test.ts`（新，28） | 0600／0700、往返、沒有明文；AAD（改名、竄改解不開）；每次寫新金鑰、刪除即刪檔；沒有金鑰、第二個寫入者、權限不符都拒絕；rename 前當機只留暫存檔且下次清掉；JSON 補強（0600、唯一暫存檔）；瀏覽器版格式不變；加密模式的外殼、沒有 `artifacts.json`、重新啟動讀回、執行中標失敗、孤兒清除、金鑰不可用、刪除兩個加密檔；搬遷成功（備份 0700、逐位元組相同、保留到刪除）與 `read`／`encrypt`／`verify`／`backup`／`switch` 五步各自失敗時明文逐位元組不變、沒有加密檔、沒有備份；金鑰不可用時不搬遷；審查 B1（金鑰被拒、單檔解不開、0644、損壞檔都不刪不重寫，下次讀回）、minor 2（撤回先寫外殼）、M4a（記憶關閉提示時載入即撤回）、M3（切換後失敗與審查者的 probe 2） |
| `tests/memory-tasks.test.ts`（新，26） | 受保護交辦：原句檢索、執行器收到記憶（不含 ID）、依賴索引先寫入（快照 v3）；系統指示的記憶區塊；8 筆／4 KB；模擬引擎不帶記憶；沒有同意不帶記憶；旗標關閉時照 M15、快照維持 version 2 且欄位順序與 MEM-3 相同；六種撤銷路徑（忘記、更正、撤回同意、刪除人物、關閉記憶、全部忘記）各自刪除成果檔並留外殼；執行中被撤銷、晚到的成果丟掉；換人、閒置、OS 鎖定不中止；無關的忘記不影響；重做重新檢索、不沿用舊依賴；當機後重新開啟記憶時清掉殘留成果檔；交辦與忘記同時進行時不會留下指向已忘記記憶的有效成果；`withdrawals` 規則表；log 與檔案 canary；審查 M1（沒有真正加密時不交辦）、M4b（索引超過上限時撤回）、minor 3（過期掃描）、minor 4（帳號變了不帶記憶）、加強的並行斷言 |
| `tests/task-redaction.test.ts`（新，7） | SSE、`/api/tasks`、`/api/artifacts`（404）、`/api/history`、`/api/history/:id` 與磁碟檔案都沒有 canary；即時語音與對話依目標同意、人物與同意對象給真實標題或外殼（`tasksForTarget`）；沒有同意的服務帳號在對話提示只看到外殼、有同意的看到真實標題；經 `/api/chat` 的受保護交辦（頁面只收到外殼、沒有模型改寫、執行器收到記憶）；旗標關閉時照 M15；瀏覽器版不受影響 |
| `tests/tasks-ipc.test.ts`（新，9） | IPC 形狀過濾與 op 清單對照；主程序先檢查發送者再過濾、preload 只呼叫 `nous:tasks`、打包腳本複製新檔；核心的 `list`／`get`／`search`／`redo`；明文備份保留到使用者確認（原生確認取消時不刪）；畫面的覆蓋邏輯與提示文字；審查 M2（只有使用者原句的任務重做時用記憶、讀不到內容的任務不能重做）、minor 7（人物範圍、選單點擊與 10 分鐘期限、`voice_tasks`）、minor 8（提示只在搬遷當次或手動打開時出現） |
| `tests/history-surface.test.ts`（＋3） | 撤回的成果顯示固定句與重做（中英）、`memory_revoked` 說明；`/history` 網頁的受保護項目只顯示固定句、沒有片段；App 內撤回的詳細頁保留原句並可重做 |
| 既有測試調整 | `tests/apikey-route.test.ts`（`NOUS_MEMORY_ROUTES` 的 `task`）、`tests/identity-ipc.test.ts`（preload 多一個 `tasks`）、`tests/memory-ipc.test.ts`（記憶與任務共用 secretBox） |

### 測試結果（本批實際輸出）

```text
npm run typecheck                      (no errors)
npx vitest run                         Test Files  90 passed (90)
                                       Tests  1542 passed | 4 skipped (1546)
npx vite build                         ✓ built
node --check desktop/*.mjs             (no errors)
node scripts/verify-aios.mjs           PASS
node scripts/check-bilingual-docs.mjs  Bilingual documentation check passed
node scripts/check-pstack.mjs          pstack 0.15.29: ... verified.
git diff --check                       (no output)
```

基準 main `368235a` 是 86 個測試檔、1469 passed、4 skipped（本批新增 73 個測試）。`node scripts/verify-aios.mjs` 第一次執行時，既有的 HIST-1 效能測試（`tests/history-search.test.ts:162`，上限 200 ms）在負載下逾時，重跑後 PASS；這個測試不是本批新增的。

## 5. Mac gate（全部未執行，不能宣稱通過）

1. 有舊明文資料的 App 第一次啟動：Keychain 允許後搬遷成功；`data/` 只剩外殼 `tasks.json`、`sealed/`、`plaintext-backup-<日期>/`；畫面出現搬遷提示；用 `grep -r` 確認 `data/`（不含備份）沒有任何原句或成果文字。
2. Keychain 拒絕：照舊明文、原檔不動、提示照實；允許後重新啟動才搬遷。
3. 搬遷中途強制結束（每一步各一次）：重新啟動後明文仍完整，或搬遷已完成；沒有半套狀態。
4. 按「刪除明文備份」→ 原生確認：取消不刪；確認後資料夾消失；Time Machine 排除與既有快照的限制照實說明。
5. 進度卡、成果畫面、App 內成果紀錄都顯示真實標題與內容；另開瀏覽器到 `http://127.0.0.1:<埠>/history` 與 `/api/tasks`、`/api/artifacts/<id>` 只看到外殼或 404。
6. `NOUS_MEMORY_ROUTES=task`：Claude 與 ChatGPT 各一次，帶記憶的交辦結果反映記憶；模擬引擎不帶；沒有同意不帶。
7. 執行中忘記那筆記憶：任務在幾秒內停止、顯示 `memory_revoked` 說明、沒有成果；完成後忘記：成果消失、外殼與重做仍在、加密成果檔已刪。
8. 換人、閒置 30 分鐘、OS 鎖定：執行中的受保護任務繼續完成。
9. 舊版 App 開到 version 3 的記憶快照：記憶停用、檔案沒被覆寫（George 2026-10-30 接受這個退版限制）。
10. 打包與簽章版本的 safeStorage 讀回、雙核心鎖（第二個核心不能寫 `sealed/`）。
11. 搬遷完成後在 Keychain 拒絕存取（或改權限）的情況下重新啟動：任務只顯示外殼、出現金鑰提示、`sealed/` 裡的檔案逐位元組不變；允許後再重新啟動，原句與成果全部回來。

## 6. 未完成項目與下一個 gate

- 即時語音的受保護交辦（見 §3 第 3 點）。
- MEM-4c 的其餘部分：受保護成果的 RAM 倒排索引與鎖定時丟棄；目前 App 內搜尋每次都在核心記憶體重新比對。（2026-10-30 更新：已在 [MEM-4c](memory-mem4c-2026-10-30.md) 交付，Mac gate 未執行。）
- 帶來源的工作摘要（work_summary）與自動整理在 MEM-5。
- 下一個 gate：§5 的 Mac 第 1–11 步，特別是第 1、3、5、7、11 步。

## 7. 殘餘風險

- **刪除不是安全抹除**：刪檔只刪掉那個檔與它的資料金鑰；既有的 Time Machine 備份、APFS 本機快照或尚未覆寫的磁區仍可能留有舊檔，應用程式金鑰不輪換，理論上仍可解開。明文備份刪除後也一樣可能留在快照裡。
- **上網查詢**：允許上網查詢（Q4-A）。模型可能把記憶內容寫進查詢字串，查詢會送到同一個服務帳號（Claude 或 ChatGPT）的搜尋；系統指示有提醒，但無法保證。
- **核心記憶體**：核心執行期間記憶體裡有全部任務的明文（執行器與 App 畫面需要）；加密只保護磁碟上的檔案。（2026-10-30 MEM-4c 更新：已結束的受保護任務改成要用時才解密，OS 鎖定、睡眠、閒置 10 分鐘、關閉記憶與結束 App 時丟棄；排隊與執行中的任務仍有明文；丟棄不是安全抹除。見 [MEM-4c §7](memory-mem4c-2026-10-30.md#7-殘餘風險)。）
- **可信主視窗**：真實內容經 IPC 給主視窗；主視窗頁面若被注入腳本，能讀到這些內容（和記憶 IPC 相同的信任邊界）。
- **模型看得到的標題**：有記憶同意的服務帳號在對話提示裡看得到真實任務標題。
- **退版**：記憶快照升到 version 3 後，舊版 App 會停用記憶（George 2026-10-30 接受）。
- **依賴索引在記憶檔裡**：記憶檔損壞或被刪除時，依賴索引一起遺失，之後的撤銷傳播找不到那些成果（成果仍加密，但不會因忘記而移除）；只有「記憶已關閉」的提示會在下次啟動時撤回全部帶記憶的成果。
- **成果紀錄的快取**：HIST-1 的 `CONTENT_CACHE` 在核心記憶體裡保存折疊過的成果純文字（不寫檔），刪除與撤回時清掉。（2026-10-30 MEM-4c 更新：受保護內容不再進 `CONTENT_CACHE`，丟棄時整個清空；改由 RAM 倒排索引保存折疊後的欄位，和解密內容同時丟棄。）
- **外殼保留字數**：外殼保留每一步的 `output_chars`（App 的進度與字數要用），外人看得到產出長度，看不到內容。
- **啟動時碰 Keychain**：App 啟動就需要 Keychain 允許，否則照舊明文（有明文時）或內容只留在記憶體。

## 8. 獨立審查與修正（2026-10-30）

審查找到 1 個 blocker、4 個 major、8 個 minor 與數個 nit；George 同日另做決定（金鑰不可用時只留在記憶體、絕不寫明文；即時語音依路徑同意給標題；即時語音的受保護交辦延到 MEM-4b；接受舊版 App 讀不了 version 3；App 內清單依 D2 的人物範圍）。修正如下，都有回歸測試（審查者的 probe 情境併入 `tests/task-vault.test.ts`）：

| 項目 | 修正 |
| --- | --- |
| B1 讀不到就當孤兒刪、還重寫成外殼 | 讀不到的任務保留 ID 記為 unreadable，絕不 `seal`、重寫或刪檔；只改外殼。金鑰被拒、權限不符時整個不清孤兒並記下原因。`SealedVault.open` 先實際包裝再解開一次金鑰（Keychain 拒絕解密時開不起來）。 |
| M1 明文退回時仍做受保護交辦 | `TaskPort.sealed()`（加密模式而且沒有金鑰問題）不成立時不做受保護交辦，改出原句卡。 |
| M3 切換後失敗會刪掉加密檔與備份 | 外殼寫入後就不再刪加密檔與備份；刪 `artifacts.json` 失敗時用 O_EXCL 暫存檔、fsync、rename、資料夾 fsync 從備份還原 `tasks.json`。上次搬到一半時沿用內容相同的備份，不另開 `-2`。 |
| M2 重做會替任意文字開票證 | 新欄位 `origin: "user_sentence"`（受保護交辦，或明確標為打字的 `POST /api/tasks`）；只有這種任務重做時才重新取用記憶，其他照一般重做；讀不到內容的任務不能重做。 |
| M4 撤回的持久性 | (a) 記憶已關閉的提示在任務載入時就撤回全部帶記憶的成果；(b) 依賴索引超過上限時被擠掉的有效項目一併撤回；(c) 記憶檔損壞會失去索引，列為殘餘風險。 |
| minor 1 | 帶記憶的任務只對同一個同意對象、人物在範圍內的目標給真實標題；即時語音同一條規則。 |
| minor 2 | 刪除與撤回先寫外殼再刪加密檔；中途中斷的殘檔由載入時的孤兒清除處理。 |
| minor 3 | 每分鐘（與每次操作）檢查依賴是否過期，有就提交一次，執行中的任務立刻停止。 |
| minor 4 | 執行前核對任務引擎現在的帳號仍是同意對象，不是就不帶記憶。 |
| minor 5 | 「crypto-shred」改稱刪檔（file deletion），並說明不是密碼學抹除。 |
| minor 6 | `sealed/` 與明文備份資料夾排除在 Time Machine 之外（失敗只記 log）。 |
| minor 7 | App 內清單、詳細與搜尋：沒用到記憶的任務、全家共用與本次人物的帶記憶任務顯示真實內容；其他家人的帶記憶任務只有外殼，除非從選單列「成果紀錄…」打開（點擊 10 秒內，之後 10 分鐘有效，主視窗導覽就收回）。 |
| minor 8 | 搬遷提示只在搬遷當次（或無法加密時）自動出現；平常從選單列「刪除明文備份…」打開。 |
| nit | 「只有已結束的任務可以重做」改用中文原句並翻譯；搬遷提示不再顯示容易誤會的筆數；`POST /api/tasks` 回應直接是外殼；並行測試的斷言加強；`output_chars` 保留（見 §7）。 |

## 9. 重跑

```sh
cd prototype/ambient-shell
npm ci
npx vitest run tests/task-vault.test.ts tests/memory-tasks.test.ts tests/task-redaction.test.ts tests/tasks-ipc.test.ts tests/history-surface.test.ts
cd ../..
node scripts/verify-aios.mjs
```

Linux 需要 util-linux 的 `flock`；沒有時真檔案測試會略過，不會假裝通過。
