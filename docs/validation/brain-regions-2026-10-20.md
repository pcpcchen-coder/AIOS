# 六腦區合併驗證

驗證時間為 2026-10-20 15:33–15:34，Asia/Taipei。本批次將 `claude/blissful-rubin-rbtgtk` 的 `17147efa` 合併到既有 ChatGPT 對話版本 `e3b1e5f`，並擴充為六個功能區。電子腦仍使用同一個 renderer。

## 結果

| 檢查 | 結果 |
| --- | --- |
| `node scripts/check-pstack.mjs` | 172 個上游檔案雜湊、兩個客戶端的 56 個技能連結與角色設定通過。 |
| `node scripts/verify-aios.mjs` | 型別檢查、20 個檔案的 178 項測試、正式建置與隔離的模擬 HTTP 流程通過。 |
| Chromium 瀏覽器驗證 | 9 組情境通過，瀏覽器錯誤為 0。操作實際建置頁面，期間來源與建置雜湊不變。 |
| 獨立檢視 | 未發現可證實的正確性缺陷；另行執行的 55 項重點測試通過。 |

[模擬 HTTP 報告](brain-regions-2026-10-20/unit-and-http-report.json)記錄建立任務、完成步驟、持久化、標明模擬的成果，以及含終止事件的直接聊天 SSE。這些檢查沒有呼叫真實模型。

## 瀏覽器情境

[瀏覽器報告](brain-regions-2026-10-20/browser-report.json)包含請求紀錄、原始來源與資產雜湊，以及下列情境的結果。

1. 未登入及尚未同意收音時，不啟動語音。
2. 六種任務領域分別點亮對應分區，終止後清除。
3. 六種對話主題分別分類並顯示來源。
4. 舊回覆晚到時，不覆蓋目前對話或重新點亮舊主題。
5. 收音與播報依音訊開始、結束、錯誤及重新啟動事件變化，舊回呼失效。
6. 按下說話同樣依實際音訊事件亮起，錯誤時清除。
7. 背景任務、對話主題與收音可同時顯示；收起對話保留背景任務。
8. 切換引擎或重設帳號清除對話活動，保留背景任務。
9. 語音與打字共用歷史，缺少終止事件的串流顯示錯誤。

報告中的截圖路徑保留執行時的 `/tmp` 路徑。相同檔名的原始 PNG 已保存在本文件旁的 `brain-regions-2026-10-20` 目錄。

| 分區 | 實際節點數 | 原始截圖 |
| --- | ---: | --- |
| 語言 | 76 | [語言區](brain-regions-2026-10-20/partition-language-fixture.png) |
| 數理 | 118 | [數理區](brain-regions-2026-10-20/partition-math-fixture.png) |
| 藝術 | 97 | [藝術區](brain-regions-2026-10-20/partition-art-fixture.png) |
| 聽覺 | 45 | [聽覺區](brain-regions-2026-10-20/partition-auditory-fixture.png) |
| 視覺 | 141 | [視覺區](brain-regions-2026-10-20/partition-visual-fixture.png) |
| 規劃 | 93 | [規劃區](brain-regions-2026-10-20/partition-planning-fixture.png) |

數量取自同一份實際 renderer 節點的分類結果，不包含維持中性的小腦與腦幹。[多來源截圖](brain-regions-2026-10-20/simultaneous-sources-fixture.png)呈現任務、主題與收音同時活動。[視覺主題截圖](brain-regions-2026-10-20/visual-topic-fixture.png)顯示主題分類來源。

## 對應版本與重跑方式

瀏覽器報告記錄的 SHA-256 如下。檔案雜湊及彙總算法見 `scripts/verify-regions-browser.mjs`。

| 目錄 | SHA-256 |
| --- | --- |
| `prototype/ambient-shell/src` | `9b23ba5ebed85b35e8aac6b19492e5dba7a92928fad459b3582e9ac20801d8cc` |
| `prototype/ambient-shell/shared` | `2d498de6998ba971974de2f3f968364c4bce3c1e46948841052959398933654c` |
| `prototype/ambient-shell/dist` | `ed7fc05ffe18fbdfaa91386fc54e914513e97c67e62803cdd99a2e484df71e23` |

從儲存庫根目錄執行 `node scripts/verify-aios.mjs`。已有 Playwright 與 Chromium 時，再執行 `node scripts/verify-regions-browser.mjs --output /tmp/aios-regions-check`。可用 `PLAYWRIGHT_MODULE` 與 `CHROMIUM_PATH` 指定既有安裝。

啟動原型時，在 `prototype/ambient-shell` 執行 `npm start`。變更集中於 `shared/domain.ts`、規劃器及執行器的領域傳遞、`src/region-activity.ts`、電子腦繪圖、對話與音訊事件，以及相關測試和驗證腳本。設計說明見[腦區連動](../development/brain-regions.md)。

## 尚未通過的實機檢查

瀏覽器驗證僅在帳號、模型 SSE 與瀏覽器語音 API 邊界使用 fixture。所有截圖均標明模擬。它證明介面的事件處理與呈現，沒有驗證真實 OAuth 帳號、模型服務、麥克風、語音播放硬體或攝影機。六區是功能分類示意，不是神經活動量測。

下一個 gate 是以使用者自己的 ChatGPT 帳號，實測登入、連續語音、插話、文字備援及錯誤恢復。視覺區目前只呈現相關主題，尚無攝影機或影像分析流程。先前的 [ChatGPT 對話驗證](chatgpt-conversation-2026-10-20.md)保留為合併前版本的歷史紀錄，本文件記錄目前六區版本。
