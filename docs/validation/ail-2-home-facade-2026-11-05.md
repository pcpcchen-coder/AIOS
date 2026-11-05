<!-- bilingual: source=zh-TW -->

> [繁體中文](ail-2-home-facade-2026-11-05.md) | [English](ail-2-home-facade-2026-11-05.en.md)

# AIL-2 家電 Facade 與 gog 共用模組驗證

日期：2026-11-05（Asia/Taipei）。分支：`claude/ail-2-home-facade`（基於 main `190aa83`）。範圍是 [18 §6](../18_App_Integration_Layer_and_Spotify_2026-11.md) 的 AIL-2：HomeBridge Facade，Gate 是「H0／H1／H1b 回歸無差異」。George 2026-11-05 要求先做這批，再把 Gmail 寄信一起整理進來，之後接 Google Calendar。

**沒有在 Mac 或真實武陵居中控上執行過。** 回歸測試用假中控（fixture），設備與讀值都是虛構的。

## 1. 做了什麼

| 項目 | 內容 |
|---|---|
| 家電改走整合層 | `NOUS_AIL=on`、`NOUS_AIL_SERVICES` 有 `home`、中控已設定時，`/api/home/status`、`/api/home/control`、`/api/home/confirm` 改由 Dispatcher 呼叫新的 `home` Adapter（`server/integrations/adapters/home.ts`），再交給 HomeBridge。沒有列出 `home` 或中控沒設定時，照原本直接呼叫 |
| 行為不變的做法 | HomeBridge 的結果原封不動放在 `data.legacy`，HTTP 照原樣回給頁面；HomeBridgeError 的狀態碼與訊息照原樣回。確認卡、busy、`needs_confirmation` 仍由頁面的 ApprovalQueue 處理。HomeBridge 自己的設備政策、速率限制（每分鐘 6 個指令）、逾時預算（一句話 60 秒）、回讀與確認都沒有改 |
| 模型看到的工具不變 | 新增 `legacyName`：Facade 工具（`app.home.status`、`app.home.control`、`app.home.confirm`）只接受新的 `page` 路徑（頁面經本機 HTTP 轉交），不會出現在模型的工具清單。模型看到的仍是 `server/realtime.ts` 原本的 `home_status`、`home_control`，一個位元組都不變 |
| 整合層多給的 | 同一份啟用設定、參數驗證、稽核紀錄（只有工具 ID、路徑、狀態、毫秒，沒有目標、指令或數值）、設定頁「App 整合」的按需健康狀態（讀一次中控快照，不送指令） |
| 限制放寬只給 Facade | `legacyName` 工具可以用新的 `scalar` 參數型別（字串、數字或布林值，對應 `value`），時限上限 90 秒；Dispatcher 不另外限速，結果大小上限 256 KB。模型工具仍是 60 秒、30 次／分鐘、4 KB，而且不能用 `scalar` |
| gog 共用模組 | gog 的執行方式（spawn、不經 shell、SIGTERM／SIGKILL、找 gog 的位置、帳號格式）從 Gmail Adapter 移到 `server/integrations/gog/runner.ts`，Gmail 與接下來的 Google Calendar 共用。Gmail 寄信的行為沒有改，原本的匯出照舊保留 |
| HomeBridge | 只加一個 `probe()`（讀一次快照給健康檢查用），其他沒動 |

## 2. 回歸測試（fixture）

新測試檔 `tests/integration-home-facade.test.ts`，18 項。核心做法：同一組請求在「Facade 開著」和「關著（原本直接呼叫）」各跑一次，各自用一模一樣的假中控、固定的 ID 與時間；比對每一步的 HTTP 狀態碼與回應內容，以及送到中控的每一個請求（方法、路徑、idempotency key、內容），必須完全相同。

| 情境 | 結果 |
|---|---|
| H0 查詢：房間、設備、讀值、空的讀值、沒有的讀值、找不到、名稱不明確、全家 | 相同；Facade 開著時 7 個請求各有一筆 Dispatcher 稽核，證明真的經過整合層 |
| H1 控制：確認、數字或字串的值、不合法的值、未知指令、找不到、房間層級（要問哪一台） | 相同 |
| H1 中控狀態：設備狀態過期（409）、中控沒有回覆（不確定有沒有執行） | 相同 |
| H1 確認卡：需要確認、同意、重複同意（同一個結果）、不同意、逾期、未知 ID | 相同；5 次確認都經過 Dispatcher |
| H1 設備政策關閉語音控制 | 相同（拒絕、沒有送出） |
| H1b AIFA 冷氣擺風、溫度、關機；紅外線音量鍵、電源 | 相同（單向，`unconfirmed`） |
| 速率限制 | HomeBridge 的第 7 個指令照樣被拒；連續 35 次查詢都成功，證明整合層沒有另外限速 |
| 中控錯誤：權杖被拒、連不上 | 相同的狀態碼與訊息 |
| 邊界值：`value` 為 null、0、空字串、false，前後有空白的目標與指令，只有空白或不是字串的讀值；英文頁面的錯誤內容 | 相同 |
| HomeBridge 拋出非預期的錯誤（程式錯誤） | 相同的 500 與訊息 |
| 輸入驗證與中控未設定 | 相同的 400／409；中控沒設定時 Facade 不註冊 |
| 整合層自己的保險時限（HomeBridge 一直不結束，測試把時限縮短） | 控制回 504「不確定有沒有執行」，英文頁面收到英文；查詢回 502 |
| 模型工具 | Facade 開著時，兩條路徑的工具表、即時語音說明與 ChatGPT 方案路徑的工具表，中英文都和關著時逐位元組相同；設定的 `integrations.tools` 是空的；模型用 `app__home__control` 叫會被拒（路徑不支援），中控沒有收到任何請求 |
| 稽核 | 紀錄沒有設備名、指令、數值或權杖 |
| Adapter 單元 | 狀態對應、健康檢查（未設定、可用、連不上、逾時、權杖被拒、格式不符、其他錯誤）、原始結果與 HomeBridgeError 原樣交回、其他錯誤在控制時變成「結果不明」、`scalar` 和 90 秒只限 Facade；`legacyName` 工具只能走 `page`，`page` 也只給 `legacyName` 工具 |

另外，`tests/home-bridge.test.ts`、`tests/http.test.ts` 既有的 H0／H1／H1b 測試全部照舊通過，沒有修改。

指令與結果（2026-11-05，Linux 雲端、Node.js 22）：

- `npm run typecheck`：通過。
- `npx vitest run`：135 個檔案，2,473 項通過、5 項跳過。
- `node scripts/verify-aios.mjs`：PASS；`git diff --check`：通過。

## 3. 獨立審查與修正

同一個模型的獨立審查（不是跨模型審查）：沒有阻擋項。修了：504 訊息補上英文；HomeBridge 拋出非預期錯誤時照原本回 500（不再變成 502／504）；Registry 強制 `legacyName` 工具只走 `page`、`page` 也只給 `legacyName` 工具；健康檢查分出逾時、權杖被拒與格式不符；補上邊界值、英文錯誤內容、非預期錯誤與保險時限的測試。沒有改：只有在整合層的保險時限（查詢 45 秒、控制 80 秒）到了才會出現的 502／504，是 Facade 之前沒有的回應，記在第 5 節。

## 4. 在 Mac 上的驗證步驟（尚未執行）

1. `.env` 的 `NOUS_AIL_SERVICES` 加上 `home`（例如 `home,gmail_gog`），重新啟動 Nous。
2. 設定頁「App 整合」應該顯示「武陵居家電（中控）：可用」。
3. 照 [H1 驗證](smarthome-h1-2026-10-22.md) 與 [H1b 驗證](smarthome-h1b-2026-10-22.md) 的實機步驟，兩條即時語音路徑各做一次：查客廳溫度、開關一盞燈、需要確認的設備說「確認執行」與「取消」、冷氣調溫度、電視音量鍵。結果應該和沒加 `home` 時一樣。
4. Nous 的 log 應該多出「整合層：… app.home.control page → …」的紀錄，裡面沒有設備名或數值。
5. 回退：從 `NOUS_AIL_SERVICES` 拿掉 `home`，重新啟動，就回到原本直接呼叫。

## 5. 限制與未完成

- 沒有在 Mac 或真實中控上執行。
- 頁面呼叫家電 API 時沒有帶工作階段，所以稽核只能記 `page`，分不出是哪條語音路徑。
- 只在整合層自己出狀況（例如 HomeBridge 80 秒都沒結束）時，Facade 才會回原本沒有的錯誤：查詢回 502，控制回 504，並說「不確定有沒有執行」。HomeBridge 自己在 60 秒內一定會結束，正常不會走到這裡。
- 確認卡仍在頁面，整合層的 `external_commit` 確認卡還沒接上。

## 6. 下一個 gate

George 在 Mac 完成第 4 節之後，才能宣稱「家電經整合層在實機上和原本一樣」。下一批是 Google Calendar（CAL-1）。
