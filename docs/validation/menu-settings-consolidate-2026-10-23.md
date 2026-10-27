<!-- bilingual: source=zh-TW -->

> [繁體中文](menu-settings-consolidate-2026-10-23.md) | [English](menu-settings-consolidate-2026-10-23.en.md)

# macOS App 設定集中到選單列驗證

2026-10-23；基底 `3df6c4bbd37569898b7343ea085b954fb1834764`（分支 `claude/menu-settings-consolidate`）。內容含獨立審查後的修正。

George 的決定：macOS App 的設定以選單列為主體；瀏覽器版（沒有選單列）保留完整設定頁。

## 做了什麼

- **選單列「鏡頭與語音設定」**（原「秒數與倍率設定」）：
  - 加入鏡頭的四個開關（鏡頭、看著說話、看著說話時先打招呼、手掌停止播報），用 checkbox；依 `CAMERA_PREFS` 的順序排在秒數與倍率之間，所以「看著說話」後面緊接它的兩個秒數與打招呼。分段標題由「鏡頭」改為「鏡頭與手勢」（第一個開關就叫「鏡頭」，避免重複）。
  - 「顯示鏡頭畫面」放在鏡頭分段的最後（「語音」標題之前），送 `command("camera-preview")`，頁面經 `runDesktopCommand`（`src/desktop-command.ts`）接到 `actions.openCameraPreview`。
  - 任一列有停用原因時，在該分段標題下方加一個灰色說明項顯示原因（macOS 14.4 以下看不到 sublabel，舊版也看得到原因）。
  - 移除「更多設定…」。
- **開關列怎麼表示**：`SettingsView.seconds`（欄位名沿用舊名）的列改成以 `kind` 區分的聯集：`seconds`／`factor` 是 `MenuNumberSetting`（有 `options`），`bool` 是 `MenuBoolSetting`（`value: boolean`、`value_label`「開」「關」，沒有 `options`）。共用 `key`、`group`、`group_label`、`label`、`disabled_reason`、`note`、`write_path`。由核心從 `CAMERA_PREFS` 推導（`shared/seconds-menu.ts` 的 `describeMenuPrefs`）。
  - 停用：鏡頭未啟用或沒有鏡頭設定來源時，所有鏡頭列停用，原因是 `CAMERA_DISABLED_REASON`。
  - 說明：「看著說話」在即時語音不可用時寫「…；需要即時語音（目前不可用）」（和設定畫面同一個提示）；看著說話關著時打招呼寫「看著說話目前關閉，這個開關暫時用不到」；使用者關掉鏡頭（`active: false`）時，其他三個開關寫「鏡頭目前關閉，這個開關暫時用不到」（優先，和倍率列「鏡頭目前關閉…」一致）。這些都不停用。
  - 「顯示鏡頭畫面」能不能用也由核心推導：`SettingsView.camera_preview_disabled_reason`（`cameraPreviewDisabledReason`）：未啟用 → `CAMERA_DISABLED_REASON`；鏡頭關著 → 「鏡頭目前關閉，勾選「鏡頭」後才能顯示畫面」；否則 `null`。
  - 寫入：`POST /api/settings/camera` 送 `{ [key]: !value }`（核心的值取反，不是 Electron 切換後的狀態），成功直接套用回應；失敗跳出「『看著說話』沒有保存」等錯誤框並重新讀取（同 `setMenuPref`）。
- **選單範本抽成純函式**：`desktop/settings-menu.mjs`（不載入 Electron，型別在 `settings-menu.d.mts`），`desktop/main.mjs` 匯入；`desktop/scripts/build.mjs` 一併複製到 App 內容。`main.mjs` 與範本只依 `kind`、`group` 與核心給的原因畫，不讀任何設定鍵名。
- **App 內的設定頁只剩帳號**：`renderSettings(settings, message, actions, { desktop })`，`src/main.ts` 傳 `{ desktop: !!window.nousDesktop }`。
  - App 內標題「帳號與登入」，只有 ChatGPT 引擎帳號（登入中、已登入的帳號／重新授權／管理用量／使用其他帳號／登出、needs_reauth 重新登入、未登入時的「Continue with ChatGPT」、welcome 說明、message、last_error、目前的引擎一行）與即時語音用的 Codex 帳號（狀態行、兩條路徑的狀態清單、登入中／裝置代碼、已登入／登出、登入按鈕、last_error）。登入中的提示寫「已在瀏覽器開啟」（App 用系統瀏覽器，不是新分頁）。
  - 底部說明逐項寫出位置：切換引擎在「AI 引擎」；即時語音的路徑與聲音在「即時語音」；鏡頭開關、秒數與倍率在「鏡頭與語音設定」。
  - 不畫引擎選擇清單、即時語音路徑與聲音按鈕、「語音」秒數區、「鏡頭與手勢」整區。
  - **瀏覽器版畫面除語音區說明那句改名外不變**（「macOS App 也可以在選單列『秒數與倍率設定』調整」→「macOS App 在選單列『鏡頭與語音設定』調整」）；程式只把帳號區塊抽成函式，子元素順序有測試。
- **「設定」指令的回話**（`settingsReply`，`src/intent.ts`）：瀏覽器照舊（「這是 AI 引擎與鏡頭設定。」／「這是 AI 引擎設定。」）。App：「設定」→「這是帳號與登入；鏡頭、秒數與引擎在選單列的 Nous 圖示裡。」；「鏡頭設定」「打開鏡頭設定」→ 指向「鏡頭與語音設定」；「切換引擎」「模型設定」→ 指向「AI 引擎」。App 沒有瀏覽器語音模式，語音模式沒開時直接顯示字幕。指令表的「設定」一列寫同樣的內容。
- **核心與 AI 指示的字句**：要使用者切到 API key 路徑的兩句（`server/realtime.ts`、`server/live-tool-caller.ts`）改成「到設定（macOS App：選單列「即時語音」）把路徑切換到 API key」。重新登入、重新授權的字句（`server/live-route.ts`、`server/chatgpt-auth.ts`）維持「設定」：App 的帳號頁仍可做。
- 其他選單：即時語音子選單加「帳號與登入…」；應用程式選單「顯示 → AI 引擎設定（⌘,）」改名「帳號與登入…」；AI 引擎子選單的「登入／帳號設定…」保留。
- 頁面改設定後通知 App 的機制（`reportState` 的 `settings` 版本字串）沒有改動；語音或打字指令改了鏡頭開關，選單列照舊重新讀取。
- 文件與字串：`desktop/README.md`、`README.md`、`INSTALL.md`、`shared/voice-commands.ts`（README 指令表用 `npm run docs:commands` 重新產生）都改成兩種版本各自正確的寫法。

## 在 Linux 驗證了什麼

沒有 Mac，Electron 沒有執行。

| 項目 | 方式 | 結果 |
| --- | --- | --- |
| 型別 | `npx tsc --noEmit` | 通過 |
| 單元與 HTTP 測試 | `npx vitest run` | 48 個檔案、790 項通過（基底 46 個檔案、752 項；新增 2 個檔案、38 項：`settings-view` 12、`desktop-menu` 10、`intent` 8、`prefs` 6、`http` 1、`live-tool-caller` 1） |
| 開關列的推導 | `tests/prefs.test.ts` | 列的順序等於 `CAMERA_PREFS`；開關列的值、標籤、`value_label`、說明等於規格；未啟用或沒有來源時全部停用；即時語音不可用、看著說話關閉、鏡頭關閉時的說明；`cameraPreviewDisabledReason` 三種情況；`describeSeconds` 仍只有秒數列 |
| `/api/settings` 帶出新欄位 | `tests/http.test.ts` | 沒有鏡頭時 9 列的鍵與順序，`camera_preview_disabled_reason` 是未啟用原因；`NOUS_CAMERA=on` 時四個開關列的值與寫入路徑、預覽可用；關掉鏡頭後預覽原因「鏡頭目前關閉…」；`POST {look_to_talk:false}` 的回應與 `camera.json` 一致 |
| 選單範本 | `tests/desktop-menu.test.ts`：直接執行 `desktop/settings-menu.mjs`（純函式，輸入是 `describeMenuPrefs` 的真實輸出；不是 Electron） | 完整項目順序（「顯示鏡頭畫面」在鏡頭分段最後、語音標題之前）；沒有「更多設定…」；checkbox 點選送出核心值取反；未啟用時標題下有說明項、所有鏡頭項停用、數值選項停用；鏡頭關閉時預覽停用並寫「鏡頭目前關閉…」、開關仍可用；語音無法保存時語音分段也有說明項；核心沒給預覽欄位時不畫 |
| 選單指令路由 | `tests/desktop-menu.test.ts` | `runDesktopCommand` 每個指令對到對應動作（含 `camera-preview` → 顯示鏡頭畫面），不認得的不動作；`main.mjs` 與範本送出的每個 `command("…")` 都是頁面認得的 |
| 設定頁兩種版本 | `tests/settings-view.test.ts`（假 DOM：只實作 views 用到的 createElement、setAttribute、append、addEventListener；DOMPurify 換成替身） | 瀏覽器版：最上層子元素順序（標題、訊息、錯誤、引擎清單、即時語音、引擎說明、語音、鏡頭與手勢、頁尾；登入後含 welcome 與帳號）、引擎清單、路徑與聲音、−／+、四個開關、「顯示鏡頭畫面」都在，登入中仍寫「新分頁」。App 版：只有帳號兩段與說明（順序有斷言），說明含「AI 引擎」「即時語音」「鏡頭與語音設定」；沒有任何重複的設定；帳號按鈕接到對應動作；登入中寫「已在瀏覽器開啟」 |
| 「設定」回話 | `tests/intent.test.ts` | 指令表「設定」一列的每一句：瀏覽器回原本的話；App 依說法指向選單列對應位置；指令表說明含同樣的位置 |
| AI 指示 | `tests/live-tool-caller.test.ts` | 工具執行層與 ChatGPT 方案語音層（有 MCP 時）的指示含「到設定（macOS App：選單列「即時語音」）把路徑切換到 API key」 |
| 真實核心（第一輪） | `npx tsx server/index.ts`（mock 引擎、暫存設定目錄、`NOUS_CAMERA=on`、沒有 OpenAI key）用 curl | `seconds` 的順序與說明正確；`POST {look_to_talk:false}` 後回應與 `camera.json` 一致；`{look_to_talk:"no"}` 回 400。修正後的 `camera_preview_disabled_reason` 由 `tests/http.test.ts` 對同一個 `createApp` 確認 |
| App 主程式語法 | `node --check desktop/main.mjs`、`node --check desktop/settings-menu.mjs` | 通過（`main.mjs` **只做了語法檢查**） |
| 建置與整體驗證 | `npx vite build`；儲存庫根目錄 `node scripts/verify-aios.mjs`；`git diff --check` | 通過 |

模擬引擎、暫存設定目錄與假 DOM 的結果不代表真實帳號、鏡頭或 macOS 選單的行為。

## 待 George 在 Mac 實測

1. **選單列 checkbox**：`.env` 設 `NOUS_CAMERA=on` 並重新啟動（需要重新 `npm run build`，App 內容多了 `settings-menu.mjs`）。打開「鏡頭與語音設定」：分段「鏡頭與手勢」裡依序是「鏡頭」「看著說話」兩個秒數「看著說話時先打招呼」「手掌停止播報」放大倍率「顯示鏡頭畫面」，然後才是「語音」。點「看著說話」取消勾選 → 再打開選單仍是未勾選，`~/.config/nous/camera.json` 有 `"look_to_talk": false`，兩個秒數與打招呼的說明（macOS 14.4 以上的 sublabel）變成「看著說話目前關閉…」。面向螢幕不再自動開始即時語音。再勾回來。四個開關都各試一次。
2. **保存失敗**：暫時讓 `camera.json` 不能寫（例如換成同名目錄），點一個開關 → 跳出「『…』沒有保存」錯誤框，再打開選單時勾選狀態是實際保存的值。測完復原。
3. **停用狀態**：`.env` 拿掉 `NOUS_CAMERA=on` 重新啟動 → 「鏡頭與手勢」標題下方有灰色的「鏡頭未啟用（.env 設定 NOUS_CAMERA=on 後重新啟動）」，四個開關、鏡頭的秒數與倍率、「顯示鏡頭畫面」都是灰的。沒有即時語音（未登入 Codex、沒有 OpenAI key）時「看著說話」的說明寫「需要即時語音（目前不可用）」。
4. **鏡頭關閉**：取消勾選「鏡頭」→「顯示鏡頭畫面」變灰，說明「鏡頭目前關閉…」；其他三個開關仍可點，說明「鏡頭目前關閉，這個開關暫時用不到」。
5. **顯示鏡頭畫面**：鏡頭運作中點「顯示鏡頭畫面」→ 視窗出現並顯示兩格小畫面。
6. **語音改設定同步**：說或打「關閉看著說話」→ 不用重開選單列，下次打開時「看著說話」已取消勾選。
7. **App 頁面只剩帳號**：選單列「AI 引擎 → 登入／帳號設定…」、「即時語音 → 帳號與登入…」或 ⌘, → 標題「帳號與登入」，只有 ChatGPT 帳號與即時語音的 Codex 帳號（含狀態行與兩條路徑的狀態），底部逐項說明其他設定在選單列哪裡；沒有引擎清單、路徑與聲音按鈕、語音秒數、鏡頭與手勢。未登入 ChatGPT 時有「Continue with ChatGPT」，按下後提示「已在瀏覽器開啟」；登入、登出、裝置代碼登入都能用。
8. **「設定」指令**：打「設定」「鏡頭設定」「切換引擎」→ 打開帳號頁，字幕分別指向選單列整體、「鏡頭與語音設定」、「AI 引擎」。
9. **瀏覽器頁面仍完整**：終端機 `npm start`，在 Chrome 打開 `http://localhost:8787` 說或打「設定」→ 引擎清單、即時語音路徑與聲音、語音秒數、鏡頭與手勢、「顯示鏡頭畫面」都在，回話仍是「這是 AI 引擎與鏡頭設定。」，行為和之前一樣。
10. 「更多設定…」已不在子選單。

## 未完成與疑慮

- Electron 部分（選單實際畫出的樣子、checkbox 點選、停用、sublabel、說明項、`camera-preview` 指令從主程式送到頁面）沒有在 macOS 執行；`main.mjs` 只用 `node --check` 檢查語法，選單範本與指令路由是用純函式測的。
- 選單列不能微調（只能選預設選項）；App 內沒有 −／+ 了，不在選項裡的值只能改 `camera.json`／`voice.json` 或用瀏覽器版設定畫面調。
- 停用原因同時出現在標題下的說明項與每一項的 sublabel，macOS 14.4 以上會看到重複的文字。
