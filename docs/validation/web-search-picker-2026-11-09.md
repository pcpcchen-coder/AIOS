<!-- bilingual: source=zh-TW -->

> [繁體中文](web-search-picker-2026-11-09.md) | [English](web-search-picker-2026-11-09.en.md)

# 即時語音查詢結果：編號挑選、重點跟讀與自動收起（2026-11-09）

George 2026-11-09 核准的設計：上網查詢 → 畫面列出 3 則編號候選 → 助理念出標題並問要哪一則 → 使用者說「第二個」→ 助理呼叫新工具 `show_search_result` → 畫面顯示那一則的重點，助理依序念、念到的那一點亮起 → 語音真的念完後，依使用者設定的秒數自動收起。兩條即時語音路徑（API key、ChatGPT 方案）共用同一個執行器與頁面 callbacks。分支 `claude/web-search-picker`（基於 main `416a1ab`）。

**證據層級：** 單元測試、fixture 與無頭 Chromium 截圖（查詢回應與語音事件都是 **SIMULATED**）。**兩條路徑的真實語音、真實 Codex／OpenAI 查詢輸出格式都沒有驗證。**

## 1. 做了什麼

| 部分 | 內容 |
|---|---|
| 資料形狀 | `shared/web-search.ts`：`SearchCandidate {n, title, url, host, points, summarized}`、`WebSearchResult` 多了 `candidates`；純函式 `parseCandidates`（答案與候選分開）、`matchSpokenPoint`（跟讀）、`searchToolOutput`／`pickToolOutput`（交回模型的內容） |
| 核心查詢 | `server/web-search.ts` 的指示要求搜尋模型在 120 字答案之後附一個 ```json 區塊：最多 3 則不同來源，每則 2–5 個重點（40 字以內、數字照原文）。解析接受 ```json 區塊或尾端 JSON；答案不含 JSON（即使 JSON 壞掉也拿掉）。解析不出候選時改用 citations 的標題與網址，`points` 留空、`summarized:false`，**不編重點**。依網址去重（忽略 `#` 與結尾斜線），最多 3 則，每則最多 5 點。API key 路徑與 ChatGPT 方案（Codex）路徑用同一段解析 |
| 新工具 | `show_search_result {index: 1..3}`：只在能上網查詢時提供，排在 `web_search` 之後；登記在 `REALTIME_TOOLS`、`HostToolName`、`HOST_TOOLS`、`HOST_TIMEOUT_MS`（5 秒＋回覆餘裕，最慢工具上限不變）、`RealtimeToolName` 與指令表 `ASK_THE_AI`。共用執行器 `executeRealtimeTool` 新分支：範圍外或不是整數回「沒有這一則」；已結束的通話（generation 換了）、這次通話還沒查過、頁面沒有這個 callback 回「還沒有查詢結果」 |
| 規則 | `SEARCH_PICK_RULE`（兩條路徑共用）：兩則以上先念編號標題、問要哪一則、先不念內容；選了就呼叫 `show_search_result`，依序念重點，每點一句、用那一點開頭的字開始、數字照念。只有一則時 `web_search` 直接回傳重點。ChatGPT 方案的工具執行層多一條例外：最後一則訊息可以列出編號標題或念重點（最多六句短句）；語音層多一條「照順序念、不要改寫」 |
| 交回模型 | `web_search`：`{ok, answer, candidates:[{n,title,host}], next}`（選之前不給重點）；一則時多 `points`。`show_search_result`：`{ok, n, title, host, points}`，沒有摘要時附 `note` |
| 頁面狀態 | `src/search-panel.ts` 的 `SearchPanel`（`candidates`／`reading`／`failed` 的 discriminated union）與 `SearchPanelController`（挑選、跟讀、收起計時）。新 Surface `search`（`show.search`，`user_request`，查詢結果回來時登記 request id）。確認卡開著時不換掉它，結果留著，之後選一則時再顯示。收起或換畫面只停止倒數，結果仍可選；通話結束全部清掉並收起 |
| 收起計時 | 只在 `reading`／`failed`：播放（phase `speaking`）結束後開始倒數 N 秒；再開始播放或使用者開口（`hearing`）取消、之後重算；收起或換畫面取消；倒數到了只收起同一張畫面（同一個 `surface_id`）。進入念重點後 15 秒都沒有播放，就不等播放直接開始倒數。候選列表不自動收起 |
| 設定 | `search_close_s`「查詢結果收起秒數」：預設 8，3–60 秒、間隔 1，選項 3／5／8／15／30／60；經 `VOICE_PREFS` 自動有保存、HTTP、設定頁 −／+、macOS 選單列與 SSE |
| 畫面 | `.surface--search` 用 docs/10 §2 的 token（`--fs-title` 108、`--fs-body` 76、`--fs-meta` 56、`--badge` 88，另定義 `--fs-anchor`、`--fs-hero`），視窗較小時依 vw／vh 縮小；寬 `min(1700px, 100vw − 192px)`，底部留字幕帶。候選卡有 88 px 編號圓標與 `data-selectable`（只指向，不觸發）；念到的那一點全亮、放大 1.04 並發光，其他 35%；失敗是珊瑚紅外框與「沒有查到」＋真實錯誤；沒有摘要的那一則照實顯示「這則沒有摘要，只有來源」 |
| 中英文 | 新介面字（含 aria-label）、設定標籤與說明、指令表一列都有英文；測試確認英文沒有漢字 |

## 2. 跟讀的精確度限制

- **文字比聲音先到。** API key 路徑的 `response.output_audio_transcript.delta` 通常比實際播放早；亮起的那一點可能比耳朵聽到的早一點。
- **ChatGPT 方案路徑的「播放中」晚約 0.6 秒。** 那條路徑以遠端音量（RMS）判斷 `speaking`，開始與結束都有延遲；收起倒數也從那時開始算。
- **只在播放中換亮起的那一點**；不在播放時保留最後亮起的那一點。
- **沒比對到就不亮。** 辨識詞是每一點開頭的字（中文最多 6 個、遇到數字停；英文 12 個字母）與點裡夠長的數字（三位數以上或百分比）；兩點共用的詞不算。模型改寫開頭又把數字念成中文讀法時會比對不到——這時不亮，不猜。
- 簡體逐字稿不另外轉換（數字仍可比對）。

## 3. 測試

| 指令（`prototype/ambient-shell`） | 結果 |
|---|---|
| `npx tsc --noEmit` | 通過 |
| `npx vitest run` | 173 個檔案；3232 項通過、5 項略過 |
| `npx vite build` | 通過 |
| `node --check desktop/main.mjs` | 通過 |
| repo 根目錄 `node scripts/verify-aios.mjs` | PASS |

新增與修改的測試：`tests/web-search.test.ts`（解析：成功、```json 區塊、尾端 JSON、壞 JSON 退回 citations、超過 3 則、依網址去重；交回模型的內容；跟讀比對的中英文 fixture）、`tests/web-search-picker.test.ts`（兩條路徑工具表一致、時限、規則；執行器四種情況；ChatGPT 方案經 `LiveToolCaller` 走到同一個執行器；收起計時的各種 phase 順序與 15 秒保底；跟讀只在播放中換點、累積式片段；`show.search` 與呈現政策；設定預設與範圍；畫面與英文）。既有測試依新工具與新設定更新（API key 請求基準快照的轉換、工具清單、設定列、選單列）；`wake-flag-off` 快照不更新，比對前拿掉新設定（第九個例外）。

## 4. 截圖（全部 SIMULATED）

`node scripts/verify-search-panel-browser.mjs`（先 `npx vite build`；Playwright 不在專案依賴時用 `PLAYWRIGHT_MODULE` 指向已安裝的 `index.mjs`）在建置後的真實頁面上，以 `page.route` 回 SIMULATED 查詢結果、直接呼叫頁面的 realtime callbacks，1920 × 1080、deviceScaleFactor 2。右上角有「SIMULATED」標示，查詢詞也帶 SIMULATED。

| 檔案 | 內容 |
|---|---|
| [`search-candidates.zh-TW.png`](../screenshots/web-search-picker/search-candidates.zh-TW.png) | 三則編號候選 |
| [`search-reading-point2.zh-TW.png`](../screenshots/web-search-picker/search-reading-point2.zh-TW.png) | 第 1 則的重點，第 2 點亮起 |
| [`search-reading-unsummarized.zh-TW.png`](../screenshots/web-search-picker/search-reading-unsummarized.zh-TW.png) | 沒有摘要的那一則 |
| [`search-failed.zh-TW.png`](../screenshots/web-search-picker/search-failed.zh-TW.png) | 查詢失敗（SIMULATED 逾時） |
| [`settings-search-close.zh-TW.png`](../screenshots/web-search-picker/settings-search-close.zh-TW.png) | 設定頁「查詢結果收起秒數」（mock 核心沒有即時語音，所以說明多了「即時語音目前不可用」） |
| [`search-reading-point2.en.png`](../screenshots/web-search-picker/search-reading-point2.en.png) | 英文介面，第 2 點亮起 |

同一支腳本也確認失敗畫面在 `speaking → listening` 後 8 秒（預設值）真的收起（真實計時器）。

## 5. 沒有驗證的事

- 兩條路徑的真實語音：模型是否照規則先念標題、問要哪一則、選了才呼叫 `show_search_result`、照順序念重點且不改寫。
- 真實 Codex（ChatGPT 方案）與 OpenAI Responses 的搜尋輸出是否照指示附上 JSON 區塊；不照做時會退回 citations（只有標題與網址）。
- ChatGPT 方案路徑上語音層把「第二個」交辦、工具執行層從逐字稿判斷編號的實際成功率。
- 18 吋螢幕 2 m 的實際可讀性與 Mac 小視窗的版面（截圖只有 1920 × 1080）。
- 跟讀亮起與耳朵聽到的時間差（沒有量測）。
