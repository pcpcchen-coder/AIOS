<!-- bilingual: source=zh-TW -->

> [繁體中文](localization.md) | [English](localization.en.md)

# App 與網頁的中英文支援

日期：2026-10-26。此批次在現有 `prototype/ambient-shell` 實作繁體中文與英文，不另建第二套 App。文件要求見[雙語規範](../BILINGUAL.md)，實測範圍見[驗證紀錄](../validation/bilingual-2026-10-26.md)。

## 切換語言

- 網頁：輸入「設定」或 `settings`，在「語言 / Language」選擇「繁體中文」或 English。
- macOS App：選單列或上方 App 選單的「語言 / Language」，也可在「帳號與登入」畫面切換。
- 預設繁體中文。網頁將選擇保存在目前來源的 `localStorage`（`nous.locale`）；App 保存在自己的 `desktop.json`，重新載入或核心換埠後沿用。
- 介面立即更新，不重新載入主視窗、不取消任務、不改寫既有對話、成果、姓名或設備名稱。App 與網頁使用相同前端；獨立瀏覽器來源各自保存偏好，沒有新增跨裝置同步。
- 新對話及新交辦沿用開始時的語言。進行中的語音、回覆、延遲交辦及失敗重試保留原語言；介面切換不把它們改成另一種語言。
- macOS 麥克風與鏡頭權限說明的語言由系統選擇，打包提供 `en.lproj` 與 `zh-Hant.lproj`。設定頁選擇不覆蓋 macOS 的系統提示語言。

## 英文指令

固定英文指令必須是完整短句，既有中文指令繼續有效。

| 目的 | 英文例句 |
|---|---|
| 開啟設定 | `settings`、`open settings` |
| 看進度／成果 | `show progress`、`show results` |
| 停止任務／收起畫面 | `stop task`、`dismiss` |
| 啟閉語音 | `turn on voice mode`、`turn off voice mode` |
| 選引擎 | `use Claude`、`use ChatGPT`、`use mock` |
| 鏡頭預覽 | `show camera preview`、`hide camera preview` |
| 鏡頭與感知開關 | `turn off camera`、`enable look to talk`、`disable palm stop` |
| 回答當前確認卡 | `confirm execution`、`cancel action` |

`yes`、`okay` 或單獨 `confirm` 不是操作授權。含否定或拒絕的內容不會被當成同意。確認卡逾時、被收起或被替換仍不執行。即時語音與打字的既有路由差異不變；完整表格在本機 `/help/commands?lang=en`，英文頁保留精確中文指令例句並翻譯說明。

## 維護翻譯

`shared/i18n.mjs` 提供無瀏覽器相依的語言正規化與翻譯，`shared/messages.en.json` 保存共用的狀態、單位與設定文案。前端、伺服器及原生桌面各自有 `messages.en.json`，共用同一個格式化器。`src/i18n.ts` 管理偏好與變更通知；原生 wrapper 打包時會連同共用及伺服器文案一起嵌入。

新增文案時，同時補完整繁體中文來源與英文值。動態內容使用 `{0}`、`{1}` 等參數。翻譯後的結果直接放到文字節點，不再對整段文字翻譯第二次；使用者輸入、模型回覆、姓名、設備名稱與成果內容必須保持原值。不要用掃描整個 DOM 並任意替換文字的方式處理雙語。

`X-Nous-Locale` 只接受已知語言；不認得的值回到繁體中文。每個請求、任務與即時語音工作階段持有自己的語言，不用全域變數切換所有使用者。語言不提供任何額外工具或身分權限，核心的來源、擁有者、確認卡與隱私檢查仍適用。

文件的兩種版本一起更新，審閱後執行 `node scripts/check-bilingual-docs.mjs --record`，再執行 `node scripts/check-bilingual-docs.mjs`。完整開發驗證仍使用 `node scripts/verify-aios.mjs`。實際畫面驗證工具為 `scripts/verify-bilingual-ui.mjs` 與 `scripts/verify-bilingual-desktop.mjs`；需已建置前端／桌面內容及已安裝的 Playwright，分別使用 Chrome 與 Electron 執行。

本批次沒有安裝或替換使用者的正式 App，也沒有發布新版下載。使用最新功能需依[桌面指南](../../prototype/ambient-shell/desktop/README.md)自行建置。真實英語辨識、播報品質、模型是否完全遵守語言，以及家電與相機仍需各自實機驗證；自動化 fixture 不讓 G0–G3 通過。
