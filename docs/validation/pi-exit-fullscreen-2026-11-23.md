<!-- bilingual: source=zh-TW -->

> [繁體中文](pi-exit-fullscreen-2026-11-23.md) | [English](pi-exit-fullscreen-2026-11-23.en.md)

# Pi 設定的「離開全螢幕」WIN-1（2026-11-23）

George 2026-11-23 要求：在 Pi 的設定裡加一個「離開全螢幕」的選項。

## 為什麼不能在頁面上直接做

Pi 的 Chromium 是用 `--kiosk` 開的。頁面裡的 JavaScript 沒辦法離開 kiosk 全螢幕，也沒辦法關掉或重開瀏覽器；Mac 上的核心也碰不到 Pi 的 Chromium。所以改走和 DN-3 深夜關螢幕同一條路。

## 做了什麼

1. **設定頁**：Pi 等終端頁面多一段「這台 Pi 的全螢幕」。
   - 寫出目前的模式：「目前：全螢幕」或「目前：視窗」，依網址有沒有 `display=window` 判斷。
   - 只有一個按鈕，在「離開全螢幕」與「回到全螢幕」之間切換。
   - Mac 視窗沒有這一段。
2. **核心**：新增 `POST /api/terminal/window {terminal, mode}`（`mode` 是 `kiosk` 或 `window`）。
   - 核心只在記憶體記住最近一次請求，60 秒內有效。
   - Pi 原本就在讀的 `GET /api/terminal/display?terminal=rpi4` 多回一個 `window` 欄位，過期或沒有請求時是 `null`。
3. **Pi 套件**：
   - `aios-display` 原本就每 2 秒讀核心。讀到的 `window` 和 Pi 上存的不同時，寫進 `~/.config/aios-terminal/window-mode`，再排一個 `systemctl --user --no-block restart aios-kiosk.service`（不等舊的 Chromium 關掉，夜間關螢幕的迴圈不會卡住）。同一個請求不會重開第二次；連排程都失敗時，把存的模式改回原本的，和畫面保持一致。
   - `aios-kiosk` 讀這個檔：
     - 全螢幕用 `--kiosk`；
     - 視窗模式改用 `--start-maximized`，網址加 `&display=window`，頁面就知道自己是視窗。
   - Pi 上的這個檔案才是持久的設定，重開機後沿用最後的選擇。
4. **照實回報**：
   - 按下後設定頁寫「已送出，Pi 會在幾秒內重新開啟畫面…」，按鈕停用。
   - Pi 重開 Chromium 時頁面會重新載入；20 秒後頁面還在，就改寫「Pi 沒有反應：請確認 Pi 套件已更新…」。
   - 送出失敗就寫「沒有送出：原因」。

## 使用前要做的事

這次改了 Pi 套件的 `aios-kiosk`、`aios-display` 與 `lib/common.sh`，**Pi 上要更新套件**：拉新版 repo 後在 Pi 執行 `bash install.sh`。沒更新的話，按下後會顯示「Pi 沒有反應」。

## 已知限制

- 切換時 Chromium 會重開，進行中的語音對話會中斷；鏡頭與麥克風權限存在同一個 profile，不用重新允許。
- 視窗模式下，關掉視窗後 `aios-kiosk.service`（`Restart=always`）約 3 秒後會再開。要完全關掉，執行 `systemctl --user stop aios-kiosk.service`。
- 在別台電腦用 `?terminal=rpi4` 開的瀏覽器頁面也有這一段，按下也會切換 Pi；那個頁面不會重新載入，所以 20 秒後會誤顯示「Pi 沒有反應」。
- Mac 的核心重新啟動後，記憶體裡的請求會消失；Pi 維持檔案裡的模式，不會被改回。

## 測試

- `tests/terminal-window.test.ts`（5 項）：
  - 核心的請求按終端分開、60 秒內有效、過期回 `null`；
  - 從網址判斷模式；
  - 設定頁按鈕的方向、送出後的三種狀態（已送出並停用按鈕、Pi 沒反應、送出失敗）；
  - 英文翻譯。
- `tests/day-night-mode.test.ts`：
  - HTTP 的 `window` 欄位；
  - `POST /api/terminal/window` 合法時是 200；mode 或 terminal 不合法時是 400。
- `terminals/rpi4/tests/dry-run.sh`（149 項，新增 18 項）：
  - 沒有請求時不動；
  - 收到視窗請求時存檔、重開一次，同一個請求不重開第二次；
  - 視窗模式的 Chromium 沒有 `--kiosk`，帶 `--start-maximized` 與 `display=window`；
  - 收到全螢幕請求時改回 `--kiosk`；
  - 重開排不進去時，存的模式改回原本的；
  - shellcheck 乾淨。
- **無頭 Chromium（mock 核心）：**
  - Pi 頁面設定裡有這一段，全螢幕頁面寫「目前：全螢幕」，帶 `display=window` 的寫「目前：視窗」。
  - 按下後核心的 `window` 是對應的值，設定頁顯示「已送出…」。
  - Mac 頁面沒有這一段；頁面沒有 JS 錯誤。
- `npm run typecheck`、`npx vitest run`、`npm run build`、`node scripts/verify-aios.mjs` 都通過。

## 還沒驗證

- 沒有在 Pi 實機試過。
- 待驗：
  1. 更新套件後，按「離開全螢幕」，幾秒內變成有標題列的視窗，設定頁寫「目前：視窗」。
  2. 按「回到全螢幕」，回到全螢幕。
  3. 重開機後沿用最後的選擇。
