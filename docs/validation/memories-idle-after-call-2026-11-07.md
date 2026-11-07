<!-- bilingual: source=zh-TW -->

> [繁體中文](memories-idle-after-call-2026-11-07.md) | [English](memories-idle-after-call-2026-11-07.en.md)

# 通話自動結束後恢復回憶模式

日期：2026-11-07，Asia/Taipei。使用者回報 Pi 通話結束後，閒置很久仍沒有回憶輪播，並確認文字輸入列留在畫面上。

## 原因與修正

`src/main.ts` 的即時語音 `onClosed` 原本一律送出 `input.open`。費用防護因閒置或達到通話時限而正常結束時，也會打開空白輸入列。`memoriesBusy()` 將 `shell.listening` 視為忙碌，導致每次檢查都清空閒置開始時間。

Pi 實際執行該 callback 的診斷重現顯示，其他十一個忙碌條件均為 false，只有輸入列為 true，回憶階段維持 `busy`。診斷使用合成的通話結束事件，沒有開啟麥克風或呼叫模型。

修正限於 `idle`／`max_duration` 的自動結束：沒有草稿且沒有開啟中的 Surface 時，只以 `input.close` 關閉空白輸入列，沒有其他工作才恢復待機。這會保留前景任務，讓其完成後照常呈現成果；不能使用會清除前景任務的 `dismiss`。既有通話清理與原因字幕保留；真正錯誤仍提供輸入復原，使用者草稿與開啟中的畫面不被關掉。鏡頭面向條件、語音計費防護與媒體權限沒有改動。

同一批同步保存先前已部署的 Pi-only 1.5 倍電子腦基準。只有沒有桌面橋接且 `terminal=rpi4` 的頁面使用放大值；Mac 預設比例仍為 1。幾何、點擊範圍與字幕定位使用同一個半徑。既有 500 筆磁碟寫入測試保留原斷言，Mac 的測試時間預算為 15 秒。

## 回歸證據

`scripts/verify-memories-idle-close.mjs` 啟動隔離 mock 核心與合成 PNG，載入真正建置的前端。它以暫時、不暫停畫面的 CDP breakpoint 呼叫模組內實際 `onClosed`，再觀察輸入列及回憶階段。沒有在產品新增測試 API，也不使用私人照片、真實帳號、麥克風或模型。

| 情境 | 修正前 | 修正後 |
|---|---|---|
| 閒置自動結束，沒有草稿或 Surface | 輸入列開啟、`busy` | 輸入列關閉、閒置後 `showing` |
| 通話時限自動結束，沒有草稿或 Surface | 輸入列開啟、`busy` | 輸入列關閉、閒置後 `showing` |
| 真正錯誤 | 輸入列可復原 | 相同行為 |
| 使用者有草稿 | 草稿保留、阻擋輪播 | 相同行為 |
| 使用者開著設定畫面 | 畫面保留、阻擋輪播 | 相同行為 |
| 前景任務仍執行中 | 任務仍可完成，但空白輸入列被打開 | 只關輸入列，保留任務與完成後的成果呈現 |

舊版的兩項自動結束案例失敗；修正後六項通過，零頁面錯誤。fixture 使用假時鐘跨過設定的閒置時間，不能當作硬體效能量測。相同產品修正另通過型別、既有完整測試、建置與隔離 mock HTTP；Pi 尺寸有獨立幾何／點擊測試。

### 重跑

先安裝原型與桌面開發依賴，再建置 App 內容：

```bash
npm ci --prefix prototype/ambient-shell
npm ci --prefix prototype/ambient-shell/desktop
npm run build --prefix prototype/ambient-shell/desktop
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium node scripts/verify-memories-idle-close.mjs --output /tmp/memories-idle-report.json
```

Playwright 另外安裝；`CHROMIUM_PATH` 未指定時使用其瀏覽器。`--web /path/to/older/web` 可驗證舊版 bundle，但仍需要目前已建置的桌面核心。腳本會回報找不到 callback 的建置格式，不能把未執行案例視為通過。

## 指定 Pi 驗證與部署邊界

修正版已安裝至 Mac 核心，Pi 已重新載入相同的新前端資產。Pi 的實際主程式收到合成 `idle` 結束事件後，空白輸入列維持關閉；以真實時鐘、既有 60 秒閒置設定觀察，約 70 秒時已進入 `showing`，約 76 秒時觀察到媒體解碼就緒。診斷只讀布林狀態，沒有讀取照片內容、檔名、網址、字幕或保存私人截圖。這些帶有 instrumentation 的時間不是效能基準，也不是新一通真實語音的端到端驗收。

暫時診斷設定、localhost 偵錯埠與轉送均已移除；原 kiosk 啟動腳本雜湊未變，kiosk 與通道服務保持 active，裝置回報無降頻。保留安裝前的完整 App 備份。私人媒體與登入設定不放進 repo。
