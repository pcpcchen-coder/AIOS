<!-- bilingual: source=zh-TW -->

> [繁體中文](service-mode-2026-11-03.md) | [English](service-mode-2026-11-03.en.md)

# Mac 服務模式（給 Pi 終端使用）驗證

日期：2026-11-03。分支 `claude/service-mode`（基於 main `a2ac54b`）。狀態：**程式與 Linux 雲端自動測試完成；Mac 實機與 Pi 實機都未驗證。**

## 需求（George，2026-11-03）

Mac mini 的 App 補做服務模式。進入後：

- 隱藏 Mac 電子腦，停止 Mac 本機麥克風、喚醒與鏡頭。
- 保留核心、登入與背景任務，讓 Pi 繼續使用。
- Mac 選單列顯示「服務模式：Pi 已連線／已斷線」。
- 提供「返回 Mac 使用」切回本機。

「Pi 已連線」必須根據終端實際連線與心跳顯示，不能只看服務模式開關。

## 做法

| 部分 | 行為 |
|---|---|
| Pi 心跳 | Pi kiosk 開 `http://localhost:<AIOS_PORT>/?terminal=rpi4`。頁面只在不是 App 主視窗（沒有 `nousDesktop`）而且網址帶合法的 `terminal` 時，立即送一次、之後每 10 秒送 `POST /api/terminal/heartbeat`，失敗不顯示，下一輪再送 |
| 核心判斷 | `server/terminal-presence.ts` 只在記憶體記住每個終端最後一次心跳；25 秒內有心跳才算「已連線」，逾時由計時器改成「已斷線」並通知 App 主程序。不寫檔、不記 IP，log 只記連線與斷線的轉變。`http-guard.ts` 不變 |
| 為什麼不用 SSE 連線判斷 | Pi 經 SSH 轉送；Pi 斷電或斷網時，Mac 端的轉送連線可能還開很久，SSE 寫入也會成功，所以不能當成 Pi 在線的證據 |
| 進入服務模式 | 選單列「進入服務模式（給 Pi 使用）」。保存在 `desktop.json`（App 重開仍是服務模式）；隱藏主視窗；通知頁面結束即時語音、語音模式與按下說話，以新的暫停原因 `service` 暫停常駐喚醒聆聽，停止鏡頭流程。主視窗的麥克風與鏡頭權限一律拒絕，`nous:camera-enable` 也拒絕 |
| 服務模式中 | 快速鍵、Dock 點擊、第二次啟動與會打開主視窗的選單項目都不作用（顯示電子腦、語音、打字、看進度、登入／帳號設定、成果紀錄、記憶、家人辨識、顯示鏡頭畫面等）。喚醒聆聽與鏡頭開關停用並標示「服務模式中暫停（設定不變）」。引擎選擇、Codex 瀏覽器登入、即時語音設定、`.env` 仍可用。核心、既有登入與背景任務照常 |
| 選單列 | 最上面一行是「服務模式：Pi 已連線」或「服務模式：Pi 已斷線」，只來自核心的心跳狀態；每次狀態改變就重建選單。另有說明行與「返回 Mac 使用」。進行中任務數的標記照舊 |
| 防止睡眠 | 服務模式中以 `powerSaveBlocker`（`prevent-app-suspension`）防止 App Nap 與系統閒置睡眠讓核心停住；螢幕仍可關。返回 Mac 使用時解除 |
| 返回 Mac 使用 | 保存 `serviceMode: false`，通知頁面解除 `service` 暫停（喚醒依原本偏好自動恢復，鏡頭設定為開時重新開啟），顯示主視窗 |

每次頁面載入完成（啟動、核心重啟、重新載入）都把目前狀態（進入或離開）再送一次給頁面，避免載入中按「返回 Mac 使用」時頁面收不到。選單列每次重建都直接向核心讀終端狀態。

所有新介面文字都經 `t()` 與 `desktop/messages.en.json`、`shared/messages.en.json` 提供英文。

## 自動測試（Linux 雲端）

| 檢查 | 結果 |
|---|---|
| `tests/service-mode.test.ts`（13 項） | 假時鐘的心跳與逾時、HTTP 路由（不合法 id 400、非 JSON 415、合法 200）、log 只記轉變且不含 IP、頁面心跳（假計時器與假 fetch：App 內與無參數時不送、失敗後繼續）、選單列範本（連線狀態只來自心跳、服務模式顯示「返回 Mac 使用」並隱藏電子腦與語音項目、一般模式顯示進入項目）、英文涵蓋、preload 只接受 `enter`／`exit` |
| `tests/audio-front-end.test.ts` 新增 3 項 | `service` 暫停的優先順序與解除、服務模式中關掉偏好、`controller.service` |
| 既有測試 | 更新 `camera-enable`、`history-surface`、`identity-ipc` 中比對原始碼字串的斷言 |
| 全部 | `npm run typecheck` 通過；`npx vitest run` 133 個檔案、2440 項通過、5 項略過；`npm run build` 通過；`node scripts/verify-aios.mjs` PASS；`bash terminals/rpi4/tests/dry-run.sh` 104 項通過 |

## 未驗證

- Electron App 本身：選單列畫面、視窗隱藏、權限拒絕、IPC 在 Mac 上的實際行為。這些只有單元測試與原始碼靜態檢查。
- Pi 經 SSH 通道送心跳、斷線後變成「已斷線」的時間。
- macOS 14.4 以上選單副標題的顯示。

## 已知限制

- 服務模式中喚醒聆聽與鏡頭開關整個停用，也不能在服務模式中把它們關掉；要先返回 Mac 使用。
- 頁面端（`src/main.ts`）進入與離開服務模式的處理沒有行為測試；`main.mjs` 的接線只有原始碼字串檢查。
- Pi 頁面若離開帶 `?terminal=rpi4` 的網址（例如 ChatGPT 登入改用整頁跳轉），心跳會停，選單列會顯示「已斷線」（只會少報，不會誤報已連線）。重新開 kiosk 即恢復。

## Mac gate（待 George 執行）

1. 開 App，選單列選「進入服務模式（給 Pi 使用）」。電子腦隱藏；選單列顯示「服務模式：Pi 已斷線」（Pi 還沒開時）。
2. 說「Hello Nous」：Mac 不應喚醒。按 Alt+Command+N、Alt+Command+V：不應出現電子腦或開始語音。Mac 的麥克風與鏡頭指示燈應熄滅。
3. 開 Pi（kiosk）。30 秒內選單列變成「服務模式：Pi 已連線」。在 Pi 交辦一個任務並開一通即時語音，確認可用。
4. 拔 Pi 網路線或關 Pi：約 15–25 秒後變成「服務模式：Pi 已斷線」（最後一次心跳後 25 秒逾時，心跳每 10 秒一次，所以是拔線後 15–25 秒，另加計時器誤差）；接回後 30 秒內回到「已連線」。
5. 結束並重開 App：仍是服務模式，電子腦不出現。
6. 選「返回 Mac 使用」：電子腦出現；常駐喚醒聆聽與鏡頭照原本設定恢復；說「Hello Nous」可喚醒。
7. 記錄每一步 PASS／FAIL 與時間，填入 [Pi 測試報告](../experiments/RPI4_REMOTE_TERMINAL_REPORT.zh-TW.md)。
