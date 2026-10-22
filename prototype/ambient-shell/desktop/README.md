# Nous macOS App

把 Nous 電子腦包成 macOS App：內建本機核心，不用開終端機；上方選單列有 Nous 圖示，常用動作和設定都在裡面。

![App 圖示](./assets/icon-1024.png)

## 安裝

1. 到 repo 的 Releases 下載 `Nous-x.y.z-mac-arm64.zip`（Apple Silicon），解壓後把 `Nous.app` 拖進「應用程式」。
2. 第一次打開：App 沒有 Apple 開發者簽章（只有本機 ad-hoc 簽章），macOS 會擋。到「系統設定 → 隱私權與安全性」最下方按「強制打開」；或在終端機執行：

   ```bash
   xattr -dr com.apple.quarantine /Applications/Nous.app
   ```

3. 填 API key：選單列 Nous 圖示 →「即時語音 → 填入 OpenAI API key…」，會用「文字編輯」打開設定檔。把 key 貼在 `OPENAI_API_KEY=` 後面，存檔後 App 會自動重新啟動核心套用。
4. 第一次開始語音對話時，macOS 會詢問麥克風權限，按「允許」。

## 選單列圖示

| 項目 | 作用 |
|---|---|
| 狀態列（前三行） | 目前引擎、即時語音是否可用與語音狀態、進行中的任務數 |
| 顯示電子腦（⌥⌘N） | 叫出／收起視窗（全域快捷鍵） |
| 開始／結束語音對話（⌥⌘V） | 即時語音（全域快捷鍵） |
| 打字對話、看進度 | 直接打開對應畫面 |
| AI 引擎 | 切換執行交辦工作的引擎：ChatGPT／Claude／模擬；「登入／帳號設定…」打開 ChatGPT 登入 |
| 即時語音 | 模型（`gpt-realtime` 或便宜約 3 倍的 `gpt-realtime-mini`）、聲音、填入 API key、OpenAI 用量 |
| 同時處理任務數 | 2／4／6／8 |
| 秒數設定 | 「鏡頭」：面向螢幕幾秒後開始對話、對話結束後暫停；「語音」：語音模式閒置多久自動關閉、即時語音閒置多久自動結束。每項是一組預設選項，目前的值打勾；值是在設定畫面用 −／+ 調的、不在選項裡時多一項「（目前）」。點了立即保存並套用，不用重新啟動核心；保存失敗會跳出原因並顯示實際保存的值。鏡頭未啟用時鏡頭兩項停用，原因寫在子選單第一項。「更多設定…」打開視窗裡的設定畫面（可以 0.1 秒／1 秒／10 秒微調） |
| 語音指令表 | 打開唯讀的「Nous 語音指令表」視窗：所有本機指令、在哪裡有效、容易誤會的說法、可以問 AI 的事、不用說話的操作與目前秒數。內容依打開當下的設定產生（頁尾寫產生時間），改了設定按 ⌘R 重新整理。不會打斷正在進行的對話 |
| 設定與資料 | 編輯 `.env`、打開任務與成果資料夾、重新啟動核心、ChatGPT 用量、麥克風權限、記錄檔 |
| 視窗永遠在最上層、在 Dock 顯示圖示、登入 Mac 時自動開啟、開啟時只顯示選單列圖示 | 勾選即生效 |

上方「顯示」選單也有「語音指令表」（⌘/），「說明」選單有同一項。

指令表視窗由本機核心產生（`GET /help/commands`），頁面沒有 script，CSP 只允許它自己的樣式；視窗不載入 preload、開 sandbox、關掉 JavaScript、用獨立的記憶體 session 並拒絕所有權限（包含麥克風與鏡頭），也不允許導覽或開新視窗。核心重新啟動後視窗會自動重新載入。秒數的選項、範圍與標籤都由核心提供（`GET /api/settings` 的 `seconds`），App 的程式裡沒有另一份。

圖示是黑白範本圖，會跟著淺色／深色選單列變色；語音開啟時右下角多一個實心圓點（像錄音指示燈），有任務在跑時圖示旁顯示數量。關掉視窗不會結束 App，Nous 留在選單列，背景任務繼續；要完全結束用「結束 Nous」（⌘Q）。

## 檔案放在哪裡

| 內容 | 位置 |
|---|---|
| 設定（API key 等） | `~/Library/Application Support/Nous/.env` |
| App 偏好（模型、聲音、視窗…） | `~/Library/Application Support/Nous/desktop.json` |
| 任務與成果 | `~/Library/Application Support/Nous/data/` |
| ChatGPT 登入憑證 | `~/.config/nous/`（與終端機版共用，不用重新登入） |
| 鏡頭設定 | `~/.config/nous/camera.json`（與終端機版共用） |
| 語音閒置秒數 | `~/.config/nous/voice.json`（與終端機版共用；選單列「秒數設定」寫入這裡） |
| 記錄檔 | `~/Library/Application Support/Nous/nous.log` |

App 內容（`app.asar`）只有程式、前端與圖示，不含任何 `.env`、任務資料或登入憑證。

## 與終端機版的差別

- App 的語音對話用即時語音（OpenAI Realtime），需要 `OPENAI_API_KEY`。Electron 沒有 Chrome 的雲端語音辨識，所以沒填 key 時只能打字對話；終端機版在 Chrome 裡仍可用舊的語音模式。
- 連接埠預設 8787，被占用（例如終端機版正在跑）時自動改用其他空閒埠。
- ChatGPT 登入改用系統瀏覽器開啟（Google 等登入頁會擋內嵌視窗），完成後自動回到 App。

## 自己打包

需要 macOS、Node.js 22.12 以上、Xcode Command Line Tools（`swift`、`iconutil`、`codesign`）。

```bash
cd prototype/ambient-shell && npm install
cd desktop && npm install
npm run icons    # 重新產生圖示（已附在 assets/，改了 scripts/make-icons.swift 才需要）
npm start        # 開發：組好內容後直接用 Electron 開
npm run package  # 打包成 release/Nous-darwin-arm64/Nous.app 與 zip
```

`scripts/build.mjs` 先用 vite 建前端、用 esbuild 把本機核心（`server/nous.ts`）打成單檔 `server.mjs`，再組成 `build/app`；`scripts/package.mjs` 用 `@electron/packager`（Electron 44.7.0）打包、ad-hoc 簽章並壓 zip。
