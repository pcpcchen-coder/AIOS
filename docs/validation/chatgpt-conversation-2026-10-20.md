<!-- bilingual: source=zh-TW -->

> [繁體中文](chatgpt-conversation-2026-10-20.md) | [English](chatgpt-conversation-2026-10-20.en.md)

# 電子腦 ChatGPT 對話驗證

日期為 2026-10-20，平台為 Linux 雲端環境，Node.js 24.19.0，npm 11.9.0，Chromium 無頭瀏覽器。這是原型對話流程的驗證，沒有變更 G0 至 G3 驗收狀態。

## 結果

| 檢查 | 結果 | 範圍 |
| --- | --- | --- |
| `node scripts/verify-aios.mjs` | 通過 | 型別檢查、16 個測試檔共 130 項測試、前端建置、真正伺服器入口的隔離模擬任務與直接對話 HTTP 流程。 |
| Chromium 對話旅程 | 10 個案例通過 | 登入入口、語音同意、聆聽與播報狀態、語音與文字共用歷史、插話、關閉、權限拒絕、斷線與授權錯誤恢復。 |
| Chromium 引擎切換競態 | 2 個案例通過 | 狀態 SSE 先於引擎切換 HTTP 回應時，第一句仍送出一次；切換期間按 Esc 後不再送出或展開。 |
| Chromium 延遲交辦 | 1 個案例通過 | 關閉時背景工作仍完成並保留成果，沒有取消請求，也沒有重新開啟回覆、任務前景、麥克風或 TTS。 |
| `node scripts/check-pstack.mjs` | 通過 | 官方技能固定版本、雜湊、兩個客戶端的技能連結及角色設定。 |
| `git diff --check` | 通過 | 工作樹差異格式。 |

瀏覽器案例操作真正建置頁面的按鈕、輸入、fetch 與 EventSource。帳號、ChatGPT HTTP 回應、語音辨識及播報皆使用外部邊界 fixture。一般問答沒有建立背景任務，延遲交辦案例則明確建立一個工作。所有案例都沒有頁面錯誤。

完整結果與建置雜湊在 [summary.json](./chatgpt-conversation-2026-10-20/summary.json)，三份瀏覽器報告及隔離伺服器報告保存在同一目錄。測試來源以尚未提交的工作樹為準。最終 `main.ts` SHA-256 為 `f667d9e416dbfe8e4846d422e4a3a94cb114c21b849ee8a7c2670857a4129c03`。三份瀏覽器報告皆對應同一份 `index-CJrLsjcm.js`。

![電子腦對話畫面，帳號、模型與音訊皆為測試 fixture](./chatgpt-conversation-2026-10-20/speaking-SIMULATED.png)

## 審查修正

審查確認並修正兩個使用者可見的競態。引擎狀態先到時，原始輸入不再被漏掉。交辦工作的建立回應晚到時，工作保留在背景，不會讓已關閉的前景再次出現。修正後以最終建置重新執行上述 13 個瀏覽器案例。

新增單元測試涵蓋舊回覆污染歷史、取消、收起、重試、帳號重設、訊息位元組限制、分段 SSE、提前 EOF、模型不完整回覆，以及實際播報開始與結束事件。相依套件與鎖定檔沒有變更。

## 尚未驗證

沒有完成真實 ChatGPT 帳號登入、方案推論授權或模型回覆。官方 SIWC 文件請求被目前雲端 proxy 政策拒絕，未繞過限制。已保存網路草稿，加入 `developers.openai.com`、`auth.openai.com`、`api.openai.com`，並保存沿用 HTTPS proxy 的啟動指示。設定草稿尚不代表已套用或發布。

沒有實體麥克風、喇叭、webcam、原生 ChatGPT 即時音訊或 Tauri 驗證。此版語音路徑仍是瀏覽器 STT、ChatGPT 文字串流與瀏覽器 TTS。

要進行真實驗證，先檢閱儲存環境設定並發布，確認目前執行環境取得所需網路，再依 [安裝指南](../../prototype/ambient-shell/INSTALL.md) 啟動、登入帳號及明確啟動收音。確認帳號確實取得推論授權，再實測回覆、插話、拒絕權限及關閉後停止收音。所有秘密值均在正式授權畫面或環境設定中處理。
