<!-- bilingual: source=zh-TW -->

> [繁體中文](history-hist1-2026-10-30.md) | [English](history-hist1-2026-10-30.en.md)

# HIST-1 成果紀錄（一般任務的可搜尋閱讀器）：雲端驗證與 Mac 驗證步驟

日期為 2026-10-30，Asia/Taipei。起點是 main `b54c3af`（已含 MEM-1、MEM-2〔PR #47〕、MEM-3〔PR #48〕），在分支 `claude/mem-4` 實作，沒有提交、推送或合併。測試資料都是虛構的。

**本批狀態：HIST-1 的程式與雲端（Linux）可驗部分已完成；Mac 驗證（截圖、選單、原生確認對話框、真資料夾的延遲）未執行。** 成果紀錄只涵蓋明文的一般任務與成果。任務與成果加密、受保護成果的搜尋、背景任務帶記憶都沒有實作（MEM-4a、MEM-4c）。畫面行為以假 DOM 的單元測試與 HTTP 測試驗證；同日的獨立審查另在雲端用 Playwright（headless Chromium）實際操作過 `/history` 與一般瀏覽器裡的 App Surface（中英文，見第 8 節的截圖清單），但沒有在 macOS App 或 Electron 裡操作過，原生對話框與選單仍待 Mac 驗證。

## 1. 擁有者決定（George，2026-10-30）

- 閱讀介面兩種都做：(a) App 主視窗裡的按需 Surface；(b) 可以用一般瀏覽器打開的獨立網頁 `/history`。
- 順序：先做閱讀器（一般任務，HIST-1），再做記憶安全（MEM-4a：加密、撤銷、背景任務自動帶記憶），最後接上受保護成果的搜尋（MEM-4c）。API 要讓之後的受保護來源能併入。
- 閱讀器可以刪除，但要經原生（或明確）確認。
- MEM-4 其餘決定（全部任務加密並一次性搬遷、撤銷後刪內容留外殼並可重做、換人不中止、work_summary 延到 MEM-5）屬於後續批次，本批不實作。

## 2. 設計

### 2.1 搜尋 API

`GET /api/history?q&status&mode&from&to&cursor&limit`

| 參數 | 意義 |
| --- | --- |
| `q` | 查詢文字，最多 200 字；空字串＝列出全部（新到舊） |
| `status` | 任務狀態，可用逗號列多個（`succeeded`、`failed`、`cancelled`、`running`、`queued`、`cancelling`） |
| `mode` | 引擎：`claude`、`chatgpt`、`mock`（可逗號列多個） |
| `from`、`to` | `YYYY-MM-DD`（本機時區一整天，`to` 含當天；不存在的日期如 `2026-13-45`、`2026-02-31` 回 400）或完整 ISO 時間；比對交辦時間 |
| `cursor` | 上一頁回的 `next_cursor`（不透明字串） |
| `limit` | 1–50，預設 20 |

格式不對回 400，不猜測；錯誤訊息是中文原句，經共用翻譯表回英文（例如「開始日期晚於結束日期」「日期格式不正確」「找不到這個任務」）。畫面上的日期欄也限制開始日期不能晚於結束日期。回應是 `{ items, total, next_cursor, sources }`；每筆 `item` 有 `task_id`、`artifact_id`、`title`（使用者原句）、`status`、`mode`、`model`、時間、`source`（目前只有 `"tasks"`）、`protected`（HIST-1 一律 `false`）、`score`、`title_matches`，以及 `snippet`（`field`、`text`、`matches`、`truncated_start`、`truncated_end`）。

另有 `GET /api/history/:taskId`（單筆詳細：任務、成果、來源）與 `POST /api/history/:taskId/delete`（見 2.4）。

### 2.2 比對與排序

- 比對方式從記憶檢索（`server/memory/retrieve.ts`）抽成共用的 `server/search-terms.ts`：簡轉繁、中文二字片段、英文詞。記憶檢索改用同一份函式，行為不變（既有記憶測試全過）。記憶的簡轉繁對照表（`server/memory/parse.ts`）保持原樣，因為語音記憶保存前也會用它；搜尋另有自己的補充表（任務常用字，只放一對一的字），「划／劃」「发／發／髮」這類一對多的字則把繁體折成共同的字（`劃→划`、`發、髮→发`），兩邊都折所以比對一致，而且只影響比對，不改任何原文。
- 搜尋框的查詢詞：每段漢字切成二字片段（單一漢字也算一個詞），英文與數字詞至少 2 個字元；全部簡轉繁、轉小寫。文字逐字折疊、長度不變，所以命中位置可以直接標在原文（包括簡體原文）上。
- 比對範圍：任務標題（權重 3）、成果內容（去掉 Markdown 符號後的純文字，權重 2；只去掉成對的強調記號，`ANTHROPIC_API_KEY` 這類識別字的底線保留；每個樣式都有長度上限，病態內容不會讓正規式退化成平方時間）、步驟標題與假設／能力缺口（權重 1）。整句查詢出現在某個欄位時再加該欄位權重 × 2。
- 有兩個以上的查詢詞時，至少要命中一半，避免只命中一個二字片段的雜訊。
- 排序：命中的查詢詞比例 → 加權分數 → 交辦時間新到舊 → `task_id`。分頁每頁 20 筆。
- 片段以第一個命中為中心、前後各約 120 字（`HISTORY_SNIPPET_RADIUS`），不切斷代理對；相鄰的二字片段（「香菜」「菜湯」）合併成一段標示。片段優先取成果內容，其次步驟、註記；只有標題命中時給成果開頭。

### 2.3 不寫索引、不記查詢

每次查詢都在核心記憶體內從 `TaskStore` 取快照比對，沒有建立或寫入任何索引檔；資料夾裡仍只有 `tasks.json` 與 `artifacts.json`（測試驗證）。成果內容轉成的純文字與折疊結果放在核心記憶體裡重用（依 `artifact_id`、version 與內容長度，最多 5,000 筆），不寫檔；任務刪除時一併丟掉。核心不記錄查詢文字：搜尋路由沒有任何 log，測試把 `console.*` 全部攔下確認查詢 canary 沒有出現。

### 2.4 刪除

- 頁面先跳原生確認（`window.confirm`：macOS App 裡是系統對話框，瀏覽器裡是瀏覽器的確認框），使用者按確定後才送 `POST /api/history/:id/delete`，body 必須有 `request_id` 與 `confirm: true`，缺少就 400，不刪。
- 執行中（排隊、執行、停止中）的任務回 409「執行中的任務不能刪除，請先停止任務」；畫面上這種任務沒有刪除與重做按鈕。
- 刪除同時移除任務與它的成果，先改寫 `artifacts.json` 再改寫 `tasks.json`（中途中斷時只會留下沒有成果的任務，不會留下沒有任務的成果；載入時也會丟掉找不到任務的成果），並經 SSE 廣播 `{ type: "task.deleted", task_id, artifact_id }`；所有頁面從清單移除，正在看那份成果的畫面由呈現政策收起。
- 刪除只改寫 JSON 檔，不是安全抹除；Time Machine 或其他備份裡的舊檔不受影響。

### 2.5 重做

沿用既有的重試：`POST /api/tasks/:id/retry` 加上 `redo: true` 時也接受已完成的任務，同樣建立新任務並記下 `retry_of`。沒有 `redo` 時行為不變（已完成的任務仍回 409）。App 裡重做後換成新任務的前景進度；獨立網頁顯示「已重新交辦這件事；進度請在 Nous 主畫面查看」。

### 2.6 App 內的 Surface

- 新的 `SurfaceKind` `"history"`，事件 `show.history`，`visibility_reason` 一律 `user_request`，`request_id` 是那一次打字、說話、按鈕或選單點擊（`userRequest()` 登記的真實請求）。
- 呈現政策（`src/presentation-policy.ts`）：history 只要不是 `user_request` 就拒絕；`request_id` 不在本次 session 的使用者請求裡也拒絕。測試涵蓋沒有 request_id、未知 request_id 與其他五種 visibility_reason。
- 畫面：搜尋框、篩選（狀態、引擎、開始與結束日期）、結果清單（標題與片段的命中處用 `<mark>`）、「載入更多」、詳細頁。詳細頁重用成果畫面的 `artifactSections`（從 `renderArtifact` 拆出；成果 Markdown 照舊經 DOMPurify 消毒），再加「來源」（原始要求、狀態、引擎、交辦與結束時間）、步驟、錯誤、重做與刪除。
- 使用者原句、片段、步驟與模型輸出都用文字節點與 DOM 建立的 `<mark>` 組出，不經 `innerHTML`；只有成果內容經 `renderMarkdown`（消毒）。測試用 XSS canary（`<img onerror>`、`<script>`、`<b>`、`<i>`）確認沒有變成元素。
- 詳細頁上方與下方都有「回到搜尋結果」。App 收到 SSE `task.updated` 時更新清單裡那一筆的狀態，詳細頁開著時跟著更新（成果出現時重讀），「重做／刪除」按鈕才跟得上。有查詢詞或任何篩選卻沒有結果時顯示「沒有符合的任務或成果」，不說「還沒有任何任務」。Surface 的無障礙標籤隨介面語言更新。
- 「收起」只呼叫 dismiss（只關畫面，不取消任何任務）。成果紀錄開著時不會被看著說話自動開始的對話打斷（`blocksAutoTalk`）。畫面裡的輸入欄自己接收按鍵，打字不會打開指令列（`src/main.ts` 的全域按鍵處理多一個條件，也適用家人辨識的姓名欄）。

### 2.7 入口（都是按需）

1. 說或打：「找之前關於晚餐的成果」「搜尋成果 香菜」「查找以前的成果裡有沒有香菜」「找之前做過的晚餐結果」「成果紀錄」「搜尋全部成果」，英文「search past results for dinner」「Search my results for budget」「results history」。要以這些固定說法開頭或結尾（`src/intent.ts` 的 `matchHistory`）。查詢詞像在交辦工作（含「然後」「接著」「幫我」「一份」「整理成」等）時不算，整句交給 AI，例如「找成果，然後寫一份報告」「搜尋成果：幫我整理成一份新報告」。「結果」只有說了「做過／交辦過」才算，所以「查詢之前的考試結果」「搜尋之前的比賽結果」不會打開成果紀錄（這類短句仍照既有規則打開最近一份成果，見指令表「容易誤會」）。英文要說 my／past／previous 等字，「search results for flights to Tokyo」是一般問題。只說「成果」「看結果」「給我看成果」「show results」仍只打開最近一份（`result`），「show results about the election」仍是交辦任務。
2. 進度畫面在「另有 N 個較早的任務未列出」附近有「搜尋全部成果」按鈕（有任務時才出現）。
3. macOS 選單列「成果紀錄…」（`command("history")`）打開 App 內的 Surface；另有「在瀏覽器打開成果紀錄」，用系統瀏覽器開核心的 `/history?lang=<目前語言>`。
4. 一般瀏覽器裡的 App，成果紀錄 Surface 底部有「在新分頁打開成果紀錄」連結；macOS App 不顯示（主視窗不開新分頁）。

模型工具不能打開成果紀錄：即時語音工具清單沒有相關工具（測試），`src/realtime-tools.ts` 不會 dispatch `show.history`（測試）。指令表（`shared/voice-commands.ts`、`/help/commands`、README）加了一列，`REPLACES_CONFIRM_CARD` 與「容易誤會」也同步。

### 2.8 獨立網頁 `/history`

- Vite 多頁建置：`history.html` → `src/history-page.ts`，與 App 共用 `HistoryView`、`src/api.ts`、`src/style.css` 與同一份翻譯表；`dist/history.html` 只引用同源 `/assets/` 的外部腳本，沒有內嵌腳本。
- 核心在 `GET /history`（或 `/history/`）提供 `dist/history.html`，標頭比主畫面更嚴：沿用主畫面（鏡頭關閉時）的 CSP（`default-src 'self'`、`connect-src 'self'`、`style-src 'self'`、`frame-ancestors 'none'` 等，不允許 `wasm-unsafe-eval`）再加 `form-action 'none'`，`Permissions-Policy` 不允許鏡頭與麥克風。`/` 與其他未知路徑仍是主畫面；主畫面的 HTML 沒有指向 `/history` 的常駐連結。
- 頁面有語言切換（English／繁體中文），也接受 `?lang=en|zh-TW` 與 `?q=` 參數。這兩者只換這一頁的語言，不寫入共用的語言偏好（同一個本機位址的瀏覽器版 App 不會因此換語言）；頁面一開始仍沿用已保存的語言。語言切換下方沒有語音相關的說明（這頁沒有語音）。它不訂閱 SSE：別的頁面刪除或新增任務後，重新搜尋才會看到。

### 2.9 驗證與來源保護（瀏覽器怎麼通過）

本機核心目前沒有權杖；所有 `/api` 路由的保護是 `server/http-guard.ts`：

- 每個請求的 `Host` 必須是 `localhost` 或 `127.0.0.1` 加上核心或 Vite dev 的連接埠（擋 DNS rebinding）。
- 非 GET／HEAD 的請求若帶 `Origin`，主機也要在同一份清單；而且 `Content-Type` 必須是 `application/json`（跨站的 simple request 帶不了，會觸發 preflight，而核心不回 CORS 標頭）。
- 讀取回應不帶 CORS 標頭，其他網站的腳本讀不到內容。

`/api/history`、`/api/history/:id` 與刪除路由走同一個檢查，測試逐條比對與 `/api/tasks`、重試路由相同的 403／415。一般瀏覽器打開 `http://127.0.0.1:<port>/history` 時 Host 與 Origin 都是本機位址，所以在現有模型下就能使用，不需要新的權杖。代價和主畫面相同：同一台電腦上能連到 localhost 的其他本機程式也能讀取（這是既有的信任邊界，不是 HIST-1 新增的）。

### 2.10 可插拔來源

`server/history.ts` 的 `searchHistory(sources, query)` 接受 `HistorySource[]`（`id`、`protected`、`documents()`）；核心預設只有 `{ id: "tasks", protected: false }`，`createApp` 的 `historySources` 可以加入其他來源。MEM-4c 的受保護成果將以 `protected: true` 的來源併入同一個排序與分頁；回應的 `sources` 列出這次查詢了哪些來源。測試已用一個假的受保護來源確認合併與標記。

## 3. 變更檔案

| 檔案 | 內容 |
| --- | --- |
| `prototype/ambient-shell/server/search-terms.ts`（新） | 共用比對：`bigrams`、`words`、`foldForSearch`、`queryTerms` |
| `prototype/ambient-shell/server/history.ts`（新） | 查詢參數解析、Markdown 轉純文字、比對、排序、片段、分頁、可插拔來源 |
| `prototype/ambient-shell/shared/history.ts`（新） | 前後端共用的型別、常數、`historySearchPath`、`isDeletable` |
| `prototype/ambient-shell/src/history-view.ts`（新） | App Surface 與獨立網頁共用的畫面（搜尋、篩選、片段標示、詳細、重做、刪除） |
| `prototype/ambient-shell/src/history-page.ts`、`history.html`（新） | 獨立網頁 `/history` |
| `prototype/ambient-shell/server/app.ts` | `/api/history` 三條路由、`task.deleted` 廣播、重試的 `redo`、`/history` 靜態頁、`historySources` |
| `prototype/ambient-shell/server/store.ts` | `documents()`、`delete()`、`subscribeDeleted()` |
| `prototype/ambient-shell/server/runner.ts` | `retry(..., { redo })` |
| `prototype/ambient-shell/server/memory/retrieve.ts`、`server/memory/parse.ts` | 改用共用比對；`toTraditional` 改用一次取代、`toTraditionalChar`；對照表內容不變 |
| `prototype/ambient-shell/server/page-headers.ts` | `/history` 用的 `historyPageHeaders` |
| `prototype/ambient-shell/src/i18n.ts` | `useLocale`（只換這一頁、不保存） |
| `prototype/ambient-shell/shared/types.ts` | `ServerEvent` 加 `task.deleted` |
| `prototype/ambient-shell/src/main.ts` | 成果紀錄的意圖、按鈕、選單指令、Surface 與 `task.deleted`；畫面輸入欄不打開指令列 |
| `prototype/ambient-shell/src/intent.ts` | `history` 意圖與 `matchHistory` |
| `prototype/ambient-shell/src/shell-state.ts`、`src/presentation-policy.ts`、`src/desktop-command.ts` | `history` Surface、政策、選單指令 |
| `prototype/ambient-shell/src/views.ts`、`src/api.ts`、`src/style.css` | 進度卡按鈕、`artifactSections`、共用小工具、API 用戶端、樣式 |
| `prototype/ambient-shell/desktop/main.mjs` | 選單列「成果紀錄…」「在瀏覽器打開成果紀錄」 |
| `prototype/ambient-shell/shared/voice-commands.ts`、`README.md`、`README.en.md` | 指令表一列、說明段落 |
| `prototype/ambient-shell/src/messages.en.json`、`server/messages.en.json`、`desktop/messages.en.json` | 新文案的英文 |
| `prototype/ambient-shell/vite.config.ts` | 多頁建置（`index.html`、`history.html`） |
| `prototype/ambient-shell/tests/history-*.test.ts`（新 4 個）與 3 個既有測試的 fixture | 測試 |
| `scripts/verify-aios.mjs` | 隔離 mock 流程加查 `/api/history` 與 `/history` |
| `docs/…` | 本文件、目前實作狀態、16 號設計、索引 |

## 4. 測試結果（Linux，Node.js 22.22.0）

在 `prototype/ambient-shell`：

| 指令 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `npx vitest run` | 86 個測試檔；1469 通過、4 略過（既有的略過項）。HIST-1 新增 4 個檔、66 項（審查前 56 項） |
| `npx vite build` | 通過，產出 `dist/index.html` 與 `dist/history.html` |
| `node --check desktop/*.mjs` | 通過 |

在 repo 根目錄：`node scripts/verify-aios.mjs`、`node scripts/check-bilingual-docs.mjs`、`node scripts/check-pstack.mjs`、`git diff --check` 的輸出記錄在交付報告。

HIST-1 新測試的範圍：

| 檔案 | 涵蓋 |
| --- | --- |
| `tests/history-search.test.ts` | 共用比對（記憶檢索行為不變）、折疊長度不變、查詢詞；簡繁雙向、二字片段、英文大小寫、數字；步驟與註記；一半命中門檻；排序（比例、權重、時間）；±120 字片段與 offset；簡體原文的標示位置與相鄰片段合併；Markdown 去除、識別字底線保留、病態 Markdown 的時間上限（200 ms）；代理對；語音記憶保存的繁體原句不被改寫；空查詢新到舊、20 筆分頁與游標；狀態、引擎、日期篩選；錯誤參數（含不存在的日期與中文錯誤）；多來源合併；500 筆效能 |
| `tests/history-http.test.ts` | 搜尋、詳細、404、中英文錯誤訊息；不寫索引、不記查詢（canary）；與 `/api/tasks`、重試路由相同的 Host／Origin／content-type 保護；沒有模型工具；刪除需要 `request_id` 與 `confirm: true`；拒絕執行中任務（中英文錯誤）；刪除後記憶體與磁碟都沒有、SSE `task.deleted`、重新載入仍不在；先寫成果檔再寫任務檔、載入時丟掉孤兒成果；重做；經 HTTP 的 500 筆效能 |
| `tests/history-surface.test.ts` | 呈現政策（沒有或未知 request_id、其他 visibility_reason 都拒絕）、`show.history` 與收起；意圖正反例（含既有「成果」仍是最近一份，以及審查列出的交辦句與「結果」句）；選單指令與選單列項目；進度卡按鈕（中英文）；`main.ts` 的入口都是使用者請求、模型工具不會打開；`<mark>` 標示與錯誤 offset；XSS canary 不變成元素、只有成果經消毒的 `innerHTML`；原生確認取消就不刪；執行中沒有刪除與重做；英文介面沒有殘留中文；有篩選時的空結果文字；`task.updated` 更新清單與詳細頁；無障礙標籤隨語言更新、詳細頁上方的返回按鈕；搜尋失敗照實顯示 |
| `tests/history-page.test.ts` | 以 Vite API 建置到暫存資料夾：`history.html` 存在、只有同源外部腳本；核心在 `/history` 提供、標頭是主畫面的 CSP 加 `form-action 'none'` 且不允許鏡頭與麥克風、`/` 與未知路徑仍是主畫面；主畫面沒有連到 `/history` |

### 4.1 搜尋延遲

合成資料：500 個任務，每份成果約 3,000 字（中英混合、重複句），另有 3 個步驟標題；5 種查詢各跑 3 輪取中位數與最差值。上限的理由：互動搜尋以 300 ms 作為「按下搜尋到結果出現」的中位數門檻，CI 機器較慢時最差值放寬到 1,000 ms；這兩個數字寫在測試裡。

| 量測 | 中位數 | 最差 | 上限 |
| --- | --- | --- | --- |
| 直接呼叫 `searchHistory`（`tests/history-search.test.ts`） | 8.9 ms | 65.3 ms | 中位數 < 300 ms、最差 < 1,000 ms |
| 經 HTTP `GET /api/history`（`tests/history-http.test.ts`，含 `TaskStore` 快照） | 26.4 ms | 46.1 ms | 同上 |

數字來自審查修正後全套測試平行執行時的一次輸出，會隨機器負載變動。測試先跑一次暖機查詢，所以表上是成果純文字已在記憶體裡的情況；核心啟動後第一次查詢要轉換全部成果，另外量到約 121 ms（同樣 500 筆，含 JIT 暖機），之後同樣的查詢約 7–16 ms。審查前沒有記憶體快取時，中位數是 62 ms（直接）與 88 ms（HTTP）；第一版逐字折疊時（當時每份成果約 2,000 字）是 172 ms。沒有索引：比對仍是每次掃過全部文字，資料量再大（數千筆以上）需要重新量測。病態 Markdown（50,000 個「[」等）在審查前要 1.76 秒，修正後測試上限 200 ms。

## 5. Mac 驗證步驟（未執行）

1. 建置並打開 macOS App（依 `prototype/ambient-shell/desktop/README.md`），用模擬引擎交辦 3–5 件事（含一件標題有簡體字，例如「准备晚饭」；一件會失敗或被停止）。
2. 選單列：確認有「成果紀錄…」與「在瀏覽器打開成果紀錄」（英文介面為「Results history…」「Open results history in browser」）。點「成果紀錄…」，截圖 Surface；點「在瀏覽器打開成果紀錄」，確認系統瀏覽器打開 `http://127.0.0.1:<port>/history?lang=…` 並能搜尋，截圖。
3. 打字：「搜尋成果 晚飯」（繁體查簡體）、「找之前關於晚餐的成果」、「成果紀錄」，確認命中處有標示；「看結果」仍只打開最近一份。
4. 進度畫面：說「進度如何」，確認「搜尋全部成果」按鈕在「另有 N 個較早的任務未列出」附近，點了打開成果紀錄。
5. 詳細頁：確認原始要求、引擎、時間、假設、能力缺口、步驟；按「重做」後換成新任務的進度。
6. 刪除：按「刪除」，確認出現 macOS 原生對話框；按取消不刪；再按確定，任務從清單消失，App 資料夾（選單列「設定與資料 → 打開任務與成果資料夾」，即 Electron `userData` 下的 `data/`）裡的兩個 JSON 檔都不再含該任務（用 `grep` 檢查標題）。對執行中的任務確認沒有刪除按鈕。
7. 收起：在成果紀錄裡說或打「收起」、按 Esc，確認只關畫面，進行中的任務繼續。
8. 延遲：在 Mac 上執行 `cd prototype/ambient-shell && npx vitest run tests/history-search.test.ts tests/history-http.test.ts --reporter=verbose`，記下 `[history perf]` 兩行；若要量真 App，把一份 500 筆的測試資料夾（不要用真資料）放到 App 的資料位置後重新啟動，量「按下搜尋到結果出現」的時間。
9. 截圖存到 `docs/validation/` 下的新資料夾，並在本文件（兩種語言）補上結果；截圖不可含真實個人資料。

## 6. 未完成與限制

- 加密、受保護成果與撤銷（MEM-4a）、受保護成果的搜尋（MEM-4c）、背景任務帶記憶都沒有實作；`tasks.json` 與 `artifacts.json` 仍是明文。
- 簡轉繁只用固定對照表（不是完整轉換），不在表上的簡體字查不到對應的繁體字（反之亦然）。一對多的字只處理了「划／劃」「发／發／髮」。
- 比對是折疊後的子字串比對加二字片段，沒有同義詞、詞幹或錯字容忍。
- 獨立網頁不訂閱 SSE；別處的刪除或新增要重新搜尋才看得到。刪除不是安全抹除，備份與 APFS 快照裡的舊檔不受影響。重做或重試鏈上被刪除的原任務，`retry_of` 仍保留它的 ID。
- 瀏覽器操作只有審查時在雲端 headless Chromium 跑過（第 8 節），本批的自動化測試仍是假 DOM 與 HTTP；`scripts/verify-aios.mjs` 沒有加入瀏覽器操作（避免引入不穩定）。macOS App 的原生對話框與選單沒有實測。
- 全套測試中 `tests/identity-service.test.ts` 有一項偶發失敗（把密文第一個字元換成 `A`，原本就是 `A` 時檔案沒有被破壞），與 HIST-1 無關，本批沒有修改。

## 7. 下一個 gate

George 在 Mac 上完成第 5 節，確認 HIST-1 可以合併；之後才開始 MEM-4a（任務與成果加密、一次性搬遷、撤銷傳播、背景任務自動帶記憶），再做 MEM-4c 把受保護成果接進同一個搜尋。

## 8. 獨立審查與修正（2026-10-30）

同日的獨立審查沒有 blocker，有 2 個 major、8 個 minor 與幾個 nit，全部在本分支修正（沒有提交）：

| 項目 | 問題 | 修正 |
| --- | --- | --- |
| M1 | 意圖把一般句子當成成果紀錄（「找成果，然後寫一份報告」「查詢之前的考試結果」「search results for flights to Tokyo」等），「查找以前的成果裡有沒有香菜」反而沒有接到 | 見 2.7：交辦句不算、「結果」要說「做過／交辦過」、英文要有 my／past；補「…成果裡有沒有…」；正反例都進測試 |
| M2 | 搜尋加進記憶對照表的字（划→劃、发→發）會改寫語音記憶保存的句子（划船→劃船、头发→头發） | 記憶對照表還原；搜尋的補充表搬到 `search-terms.ts`，一對多的字反向折疊；加記憶回歸測試 |
| m1 | `markdownToPlain` 在病態內容上是平方時間（50,000 個「[」要 1.76 秒） | 每個樣式都有長度上限，成果純文字在記憶體裡重用；加病態效能測試 |
| m2 | 去 Markdown 時把所有底線拿掉（`ANTHROPIC_API_KEY` → `ANTHROPICAPIKEY`） | 只去掉成對的強調記號 |
| m3 | 不存在的日期（`2026-13-45`、`2026-02-31`）被接受 | 核對年月日，回 400 |
| m4 | 有篩選時的空結果說「還沒有任何任務」 | 有查詢詞或篩選就說「沒有符合」 |
| m5 | 搜尋與詳細的錯誤訊息是英文 | 改成中文原句並加進翻譯表；日期欄限制開始不晚於結束 |
| m6 | 刪除改寫兩個檔不是原子的 | 先寫成果檔、後寫任務檔；載入時丟掉孤兒成果 |
| m7 | 本文件說沒有瀏覽器與截圖 | 改為說明審查的 Playwright 驗證與截圖清單（本節）；Mac 驗證仍未執行 |
| m8 | App 的詳細頁不跟著 `task.updated` | `historyView.taskUpdated(task)` |
| nit | `/history` 標頭、無障礙標籤翻譯、`?lang=` 改到 App 的語言、語言說明、詳細頁上方返回 | 見 2.6、2.8 |

審查時的雲端瀏覽器驗證（Playwright、headless Chromium、隔離的 mock 核心與虛構資料；不是 macOS App，也不是本批的自動化測試）操作了 `/history` 的清單、搜尋、XSS 測試任務的清單與詳細（沒有注入任何 `img`／`script` 元素）、英文介面、狀態篩選、手機寬度（390×844），以及一般瀏覽器裡 App 的成果紀錄 Surface（打字開啟、在搜尋框打字不開指令列、詳細、收起、確認後刪除、重做、進度卡的按鈕）。截圖檔名如下；檔案留在審查的暫存資料夾，沒有放進 repo：

- `/history`：`history-list-zh.png`、`history-list-en.png`、`history-search-zh.png`、`history-search-en.png`、`history-xss-list-zh.png`、`history-xss-list-en.png`、`history-detail-xss-zh.png`、`history-detail-xss-en.png`、`history-mobile-zh.png`、`history-mobile-en.png`
- App Surface：`app-history-surface-zh.png`、`app-history-surface-en.png`、`app-history-detail-zh.png`、`app-history-detail-en.png`、`app-history-after-delete-en.png`、`app-after-redo-en.png`

這些截圖是審查修正之前的版本；修正後沒有重新截圖。
