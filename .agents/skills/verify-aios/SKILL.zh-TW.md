---
name: verify-aios
description: 使用既有測試、型別檢查、建置與隔離的模擬 HTTP 任務流程驗證 AIOS ambient-shell 原型。在修改原型或檢查開發環境是否就緒後使用。
---

<!-- bilingual: source=en -->

> [繁體中文](SKILL.zh-TW.md) | [English](SKILL.md)

<a id="verify-aios"></a>
# 驗證 AIOS

從儲存庫根目錄執行，需要 Node.js 22.12 以上。僅在依賴缺少時才於 `prototype/ambient-shell` 執行 `npm ci`。

```bash
node scripts/verify-aios.mjs
```

指令執行型別檢查、既有測試與前端建置，再把真實的伺服器入口、共用模組與已建置前端複製到新的暫存目錄。依賴使用連結；設定與任務資料隔離，不複製專案 `.env` 或登入憑證。子程序沒有 Anthropic key，並以 mock provider 在未占用的本機埠啟動。

閱讀輸出位置的 `report.json` 與日誌。通過條件包括已建置 HTML、啟用的 mock provider、HTTP 任務建立、完成、明確標示為不完整的模擬成果，以及相符的持久化 JSON。它也會發出直接模擬對話請求，要求文字增量與終止事件，不能額外建立背景任務。檢查報告旁的 `data/`，確認保存結果。清理只停止它啟動的子程序並刪除執行副本；日誌與報告保留在輸出位置。

指令失敗時，閱讀對應日誌、修正環境問題，只有在診斷或變更後才重試。不得弱化斷言或以連接埠檢查取代行為檢查。既有測試名稱說明取消、重試、狀態轉換、HTTP 防護與供應商契約的覆蓋。

這只能證明模擬 API 流程與目前測試涵蓋的行為，無法證明瀏覽器畫面、語音輸入、TTS、注視或真實 AI 請求成功。這些項目需要瀏覽器與實體裝置檢查。不得根據此指令宣稱 `docs/07` 的 gate 通過。

六區 UI 先建置原型，再從 repo 根目錄執行 `node scripts/verify-regions-browser.mjs --output /tmp/aios-region-verification`。此選用工具需要已安裝的 Playwright 與 Chromium；無法自動找到時，設定 `PLAYWRIGHT_MODULE` 為已安裝模組入口、`CHROMIUM_PATH` 為瀏覽器執行檔。工具以明確的帳號、API 與語音 fixture 操作實際建置頁面，檢查真實分區數與來源標籤，保留有標示的截圖及精確來源／建置雜湊。不使用帳號憑證。閱讀報告，將 fixture 證據與硬體驗證分開。
