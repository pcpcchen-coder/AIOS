# 選單列秒數設定與語音指令表驗證

2026-10-22；基底 `5572b91a26d156dee80db8a6aa2cae455c24b5a2`。本紀錄隨「選單列秒數設定、語音閒置秒數、語音指令表」交付。

George 的要求：秒數相關設定要能在選單列（macOS App 的選單列圖示與應用程式選單）設定，閒置秒數也一起做成可設定；所有語音指令寫成一張表，能從選單列打開。

## 做了什麼

- 四個秒數設定：鏡頭的「面向螢幕幾秒後開始對話」「對話結束後暫停」（既有 `CAMERA_PREFS`，加上選單選項），與新的語音閒置秒數 `VOICE_PREFS`：語音模式 30–600 秒、每格 10、預設 90；即時語音 30–600 秒、每格 10、預設 120。保存在 `~/.config/nous/voice.json`，`POST /api/settings/voice`，立即生效。
- 本機核心在 `SettingsView.seconds` 推導每個秒數的選單列（標籤、目前值、選項、停用原因、寫入路徑）；`desktop/main.mjs` 照著畫，沒有任何鍵、範圍或選項。
- 語音指令表：`shared/voice-commands.ts` 是唯一來源，產生 `GET /help/commands`（App 的唯讀視窗）與 README 的指令段落。
- 頁面：閒置秒數改了，只有值真的改變而且語音正開著時才從現在重新倒數；設定畫面多「語音」區段；同意說明的秒數用目前設定。

## 這個環境驗證了什麼

沒有 Mac，Electron 沒有執行。以下都在 Linux 開發環境完成。

| 項目 | 方式 | 結果 |
| --- | --- | --- |
| 型別 | `npx tsc --noEmit` | 通過；含編譯期檢查：表裡的意圖種類、引擎、確認決定、即時語音工具名稱必須等於程式實際的型別 |
| 單元與 HTTP 測試 | `npx vitest run` | 37 個檔案、476 項通過（基底 32 個檔案、353 項） |
| 指令表對照比對規則 | `tests/voice-commands.test.ts` | 表裡每一句都丟進 `matchCameraCommand`、`classify`、`matchApproval`、`isStopWord`；「在哪裡有效」由 `LOCAL_ROUTING` 加真實比對結果推算後比對。每條鏡頭規則、每種意圖與引擎、確認動詞與取消詞、插話詞、即時語音工具都要有列 |
| 測試會抓到走樣 | 暫時改錯表（多一個路徑、少一個插話詞、改錯一個誤會列、多一種意圖），再跑測試 | 5 項測試失敗、2 個編譯錯誤；還原後通過 |
| README 不走樣 | `tests/commands-doc.test.ts` | README 標記之間的內容必須等於 `renderCommandsMarkdown()`；`npm run docs:commands` 重新產生 |
| 閒置秒數重新倒數 | `tests/idle-settings.test.ts`（假計時器） | 同樣的值不延長倒數；改值從現在重新倒數新的長度；關著的不動作、不會誤報「已關閉」，下次開啟才用新值；即時語音回覆中仍不計時 |
| 設定檔 | `tests/voice-settings.test.ts`；`tests/camera-settings.test.ts` 沒有修改仍通過 | 抽出共用的 `PrefsFile`；鏡頭的 fail closed（`active` 不合法或檔案讀不懂 → `false`）改成資料 `failClosed` |
| 選項規則 | `tests/prefs.test.ts` | 每個秒數規格的選項由小到大、不重複、在範圍內、落在 step 上、包含預設，且通過對應的驗證函式；目前值不在選項裡時插入「（目前）」 |
| 真實核心 | `npx tsx server/index.ts`（mock 引擎、暫存設定目錄、`NOUS_CAMERA=on`）用 curl 呼叫 | `GET /api/settings` 有 `voice` 與四列 `seconds`；`voice_idle_s: 95` 回 400；`look_to_talk_s: 1.6` 的回應中該列勾選「1.6 秒（目前）」；`realtime_idle_s: 300` 寫入 `voice.json`（權限 0600）；指令表頁顯示「目前 5 分鐘（預設 2 分鐘）」；外來 Host 回 403 |
| 指令表頁實際呈現 | Playwright Chromium、**關閉 JavaScript**（同 App 視窗設定），深色模式 | 標頭 CSP 的 hash 與 inline style 一致，樣式有套用；鏡頭未啟用時 12 列標註「目前：…」；沒有 console 訊息。截圖 `menu-seconds-commands-2026-10-22/commands-page.png` |
| 設定畫面語音區段 | Playwright Chromium 打開建置後的頁面，輸入「設定」，按「語音模式閒置多久自動關閉增加」 | 1 分 30 秒 → 1 分 40 秒，`voice.json` 寫入 100。截圖 `menu-seconds-commands-2026-10-22/settings-voice.png` |
| App 主程式語法 | `node --check desktop/main.mjs` | 通過 |
| 建置與整體驗證 | `npx vite build`；從儲存庫根目錄 `node scripts/verify-aios.mjs` | 通過 |

截圖由模擬引擎與暫存設定目錄產生，不代表真實帳號、麥克風或鏡頭。

## 指令表照實寫出的行為

以下來自比對規則（測試確認）與讀 `src/main.ts`、`src/voice.ts`、`src/realtime.ts` 的路由：

- 「結束對話」「開始語音對話」「再見」不是本機指令；「再見」只在即時語音中由 AI 判斷。
- 單獨的「停」只在語音模式打斷播報，之後仍交給 AI；「stop」打斷後當成停止任務。插話詞以開頭比對；語音模式中任何兩個字以上、不像 Nous 自己聲音的話也會打斷（`src/voice.ts` 的 `onresult`）。
- 打字的「取消」是停止任務；停止任務會換上進度或通知畫面，換掉確認卡也算拒絕（`dispatch` 的 `leftConfirm`），所以確認卡被拒絕、任務也可能被停止。即時語音中說「取消」才是單純拒絕。
- 即時語音中說「關閉／打開手掌停止」等含「停止」的鏡頭指令，確認卡開著時也會拒絕確認卡；用打的不會。
- 即時語音中說的鏡頭指令本機照做，這句話仍會送到 AI。即時語音中說「停止任務」「進度如何」「收起」不在本機處理。
- 「收起」同時結束語音模式或即時語音，不停止任務。
- 短句中有「狀況」「結果」等詞就會被當成查進度或看成果（例如「交通狀況如何」「比賽結果」）。這是既有比對規則的行為，本批次只照實寫出，沒有改規則。

`LOCAL_ROUTING`（哪條路徑跑哪些比對）是表裡唯一手寫的路由事實；`tests/voice-commands.test.ts` 用原始碼片段檢查即時語音逐字稿只跑鏡頭規則與確認語句、`handleCommand` 先跑鏡頭規則再 `classify`。

## 需要在真的 Mac 上驗證

- 選單列圖示的「秒數設定」子選單：四項、分段標題、勾選位置、「（目前）」項、鏡頭未啟用時停用且第一項顯示原因（macOS 14.4 以下沒有 sublabel）、點選後主視窗設定畫面立即更新、錯誤對話框。
- 「語音指令表」視窗：選單列項目、「顯示 → 語音指令表」⌘/、「說明」選單；打開時正在說話的即時語音不被打斷；⌘R 重新整理；核心重新啟動後自動重新載入；視窗不能導覽、不能開新視窗、麥克風與鏡頭權限被拒。
- 即時語音中把閒置秒數從 2 分鐘改成 1 分鐘，大約 1 分鐘後自動結束（需要 `OPENAI_API_KEY`）。

## 下一個 gate

在 Mac 上用打包好的 App 完成上一節的項目並截圖，之後才能把這項功能視為端到端完成。
