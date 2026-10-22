# 安裝與執行指南（本機）

這份指南帶你在自己的電腦上跑起 Nous 電子腦原型。全程約 10 分鐘。

> **macOS 也可以直接用 App**：下載 Releases 裡的 `Nous.app`，不用裝 Node.js、不用開終端機，選單列有 Nous 圖示可以設定。見 [desktop/README.md](./desktop/README.md)。

## 0. 需要的東西

| 項目 | 版本／說明 |
|---|---|
| Node.js | 22.12 以上（建議 LTS） |
| Git | 任一近期版本 |
| 瀏覽器 | Chrome 或 Edge（語音輸入只在這兩個可用） |
| Anthropic API key | 選填。沒有也能跑，但只會是「模擬模式」 |

## 1. 安裝 Node.js 與 Git

### macOS

1. 到 <https://nodejs.org> 下載 **LTS** 的 macOS 安裝檔（`.pkg`），雙擊安裝。
2. Git：打開「終端機」輸入 `git --version`。若跳出安裝開發者工具的視窗，按「安裝」即可。

### Windows

1. 到 <https://nodejs.org> 下載 **LTS** 的 Windows 安裝檔（`.msi`），一路按「Next」安裝。
2. 到 <https://git-scm.com/download/win> 下載 Git 並安裝（選項保持預設）。
3. 裝完後**重新開啟**「PowerShell」或「命令提示字元」，新安裝的指令才會生效。

### 確認

```bash
node --version   # 應顯示 v22.12.0 或更新
npm --version
git --version
```

## 2. 下載程式碼

選一個要放專案的資料夾（例如家目錄），然後：

```bash
git clone https://github.com/pcpcchen-coder/AIOS.git
cd AIOS/prototype/ambient-shell
```

repo 若是私有的，`git clone` 會要求登入 GitHub：用瀏覽器授權，或用 Personal Access Token 當密碼（見 repo 根目錄的 `SETUP.md`）。

已經 clone 過的話，改成更新：

```bash
cd AIOS
git checkout main
git pull
cd prototype/ambient-shell
```

## 3. 安裝套件

```bash
npm install
```

看到 `found 0 vulnerabilities` 或類似結尾就完成了。

## 4. 選擇 AI 引擎

複製設定範本：

| 系統 | 指令 |
|---|---|
| macOS／Linux | `cp .env.example .env` |
| Windows PowerShell | `Copy-Item .env.example .env` |
| Windows 命令提示字元 | `copy .env.example .env` |

Nous 可以用三種引擎，之後隨時在畫面上說「設定」切換：

- **ChatGPT 帳號登入**：啟動後點電子腦或「開始語音對話」，按 **Continue with ChatGPT**，在跳出的分頁登入自己的帳號並同意。完成後回到 Nous，再按語音入口並同意收音。登入不會自動開啟麥克風。登入憑證存在 `~/.config/nous/`。現有 Sign in with ChatGPT 預覽流程需要帳號取得推論授權；此版本尚未以真實帳號驗證成功，不保證所有方案皆適用。
- **Claude（API key，依用量計費）**：在 `.env` 填入 key（到 <https://console.anthropic.com> 申請）：

```
ANTHROPIC_API_KEY=sk-ant-...
```

- **模擬**：開發驗證時在「設定」中明確選擇。畫面顯示「模擬模式」，不會呼叫模型。ChatGPT 對話入口未登入時會提示登入，不會默默替換成模擬回覆。

`.env` 已被 git 排除，不會被上傳。

### 即時語音模式（選填，像 ChatGPT 語音模式）

想要「語音直接對語音」、可以隨時插話的對話，在 `.env` 填入 OpenAI API key（到 <https://platform.openai.com/api-keys> 申請，依用量計費，語音比文字貴）：

```
OPENAI_API_KEY=sk-...
```

存檔後重新 `npm start`，終端機會顯示「即時語音：可用」。之後按「開始語音對話」就會用 OpenAI Realtime（`gpt-realtime`）：

- 語音直接對語音，不經過瀏覽器的語音辨識，對話是連續的；你一開口，它就停下來聽。
- 要它做較長的工作時，它會交辦成背景任務。**任務仍用上面選的引擎執行**（例如 ChatGPT 方案），不會用 API key 跑任務。
- 任務完成時它會用語音告訴你；問「進度如何」它會查真實狀態再回答。
- 點右上角指示、按 Esc，或沒說話一段時間（預設 2 分鐘，可在「設定」或 App 選單列「秒數設定」調整）就會結束，避免忘記關而持續計費。說「再見」或「結束對話」時由 AI 判斷要不要結束，不保證每次都結束。
- API key 只留在本機核心，不會送到瀏覽器。

ChatGPT 方案登入不能用即時語音（實測 OpenAI 會回 server_error），所以這個模式一定要 API key。沒填 key 時，「開始語音對話」沿用原本的語音模式（瀏覽器語音辨識＋ChatGPT 文字回覆＋電腦語音）。

### 雙目鏡頭（選填，Waveshare AR0144）

1. 把鏡頭裝在 18 吋螢幕上緣、面向你坐或站的位置，USB 接到這台電腦。macOS 會列出名為 `CCB Camera` 的鏡頭。
2. 下載本機視覺模型（只需一次，約 30 MB）：

   ```sh
   npm run vision:setup
   ```

3. 在 `.env` 加上 `NOUS_CAMERA=on`，存檔後重新 `npm start`。第一次會詢問鏡頭權限，請按「允許」。

之後畫面右下角會出現鏡頭狀態小點。你走到螢幕前、面向螢幕約 1.5 秒，它就會自動開始即時語音（需要先同意過一次即時語音）。說話中舉起張開的手掌，可以讓它停止播報。說「鏡頭關掉」隨時關閉。影像只在這台電腦上處理，不保存也不上傳。

- **看鏡頭畫面**：說「顯示鏡頭畫面」或按右下角小點，會出現兩格小畫面：左眼的即時影像，和左右眼的差異。可以用來確認鏡頭有沒有對準你。說「收起鏡頭畫面」或再按一次小點收起。
- **調整**：說「鏡頭設定」，在「鏡頭與手勢」可以開關鏡頭、看著說話、手掌停止播報，並調整「面向螢幕幾秒後開始對話」（0.5–5 秒）與「對話結束後暫停」（3–60 秒）。改了立即生效，不用重新啟動。
- 說「鏡頭關掉」會記住，之後重新啟動也不會自己打開，要說「打開鏡頭」才會再開。

以上畫面與設定還沒在實機鏡頭上驗證過。

### 武陵居中控（選填）

即時語音可以查家裡的感測值與設備狀態，例如「客廳現在幾度」「書房二氧化碳多少」「客廳主燈在不在線」，也可以控制一台家電，例如「客廳主燈關掉」「書桌燈調到 60%」「色溫調到 3000K」。需要先設定好上面的即時語音。

1. 確認武陵居中控正在執行（預設 `http://127.0.0.1:8788`）。
2. 在中控的「系統接入」建立一把給 Nous 用的權杖。
3. 在 `.env` 加上：

   ```
   SMARTHOME_URL=http://127.0.0.1:8788
   SMARTHOME_TOKEN=剛剛建立的權杖
   ```

   中控之後搬到另一台電腦時，只要把 `127.0.0.1` 改成中控的區網 IP。

4. 重新 `npm start`，終端機會顯示「武陵居中控：已設定」。

讀值照中控回報：沒有讀值會說「沒有讀值」，雲端快照或過期資料會說是幾點的資料。

控制照中控的回讀說結果：設備確認了才說好了；「已送出、未確認」表示中控送出了但設備沒有回報，請看一下有沒有反應。注意：

- 一次控制一台。說「客廳的燈全部關掉」會先問是哪一台。
- 冷氣溫度與紅外線設備（電視、冷氣遙控）還不能用語音控制。
- 設備要先在中控完成接入；中控顯示狀態過期時，Nous 會請中控重新讀取一次再送，仍不行就會說沒有送出。
- 每分鐘最多 6 個控制指令。

權杖只留在本機核心，不會送到瀏覽器或 OpenAI。

## 5. 啟動

```bash
npm start
```

看到下面這行就成功了：

```
Nous 原型已啟動：http://localhost:8787
```

用 Chrome 或 Edge 打開 <http://localhost:8787>。

在這個已準備的雲端環境中，Node.js 為 24.19，對外請求須沿用環境的 HTTPS proxy。從原型目錄使用 `NODE_USE_ENV_PROXY=1 NOUS_CONFIG_DIR=/workspace/.nous-cloud npm start`。若網路政策仍封鎖 OpenAI 網域，先在環境設定檢閱儲存網路草稿。瀏覽器登入回呼與麥克風仍需在可連到同一個本機核心的裝置上操作。

要關閉時，在終端機按 `Ctrl + C`。下次只要回到 `AIOS/prototype/ambient-shell` 再執行 `npm start`。

## 6. 怎麼用

| 操作 | 結果 |
|---|---|
| 點電子腦或「開始語音對話」 | 依提示登入自己的 ChatGPT 帳號，明確啟動語音後收音 |
| 按空白鍵或直接打字，Enter 送出 | 接續同一段對話；沒有麥克風也可使用 |
| 對方播報時直接說話或按 Esc | 停止當前回覆及播報，回到聆聽 |
| 輸入「進度如何」 | 列出所有任務的進度 |
| 輸入「看結果」 | 打開最新完成的成果 |
| 輸入「停止任務」 | 停止進行中的任務 |
| 輸入「設定」／「改用 ChatGPT」 | 切換 AI 引擎、登入或登出 ChatGPT |
| 按「結束對話」、輸入「收起」，或非播報時按 Esc | 停止收音、生成及播報，既有背景任務繼續執行 |
| 麥克風按鈕 | 按下說話（第一次會先詢問是否同意使用瀏覽器的雲端語音辨識） |
| 說或打「開啟語音模式」／按聲波按鈕 | 語音對話模式：像 ChatGPT 語音模式一樣直接聊天，它說話時可以插話（說「停」或直接講）；要它做較長的工作時會自動交辦成任務。建議戴耳機。說「關閉語音模式」結束，閒置預設 1 分 30 秒自動關閉（可調） |
| 有設定 `OPENAI_API_KEY` 時按「開始語音對話」 | 即時語音模式（OpenAI Realtime）：語音直接對語音、隨時插話；工作交辦給目前的引擎。右上角顯示「即時語音 · 聆聽中／回覆中」，點它結束；說「再見」時由 AI 判斷是否結束 |

完整的語音與打字指令（哪些在本機處理、哪些交給 AI、容易誤會的說法）見 [README 的指令表](./README.md#語音與打字指令表)；核心啟動後也可以打開 <http://localhost:8787/help/commands>，macOS App 在選單列「語音指令表」（⌘/）。

## 7. 常見問題

| 狀況 | 處理方式 |
|---|---|
| `node: command not found`／「不是內部或外部命令」 | Node.js 沒裝好，或裝完沒重開終端機 |
| `npm install` 出現 `EBADENGINE` 或 vitest 相關錯誤 | Node 版本太舊，升級到 22.12 以上 |
| `EADDRINUSE: address already in use 127.0.0.1:8787` | 8787 埠被佔用：關掉舊的 `npm start`，或在 `.env` 加 `PORT=8790` 後改開 <http://localhost:8790> |
| 頁面顯示「前端尚未建置」 | 你執行的是 `npm run dev:server`；改用 `npm start` |
| 畫面左上角紅字「與本機核心的連線中斷」 | 終端機裡的 `npm start` 已停止，重新啟動即可 |
| 任務失敗顯示「API key 無效或未授權（401）」 | 檢查 `.env` 的 key 是否完整、沒有多餘空白，改完要重新 `npm start` |
| 任務失敗顯示「超過 API 速率限制（429）」 | 稍等再按「重試」 |
| 看不到麥克風按鈕 | 瀏覽器不支援語音辨識；請用 Chrome 或 Edge |
| 按 Continue with ChatGPT 沒有開新分頁 | 瀏覽器擋了彈出視窗；允許 localhost 開彈出視窗後再按一次 |
| ChatGPT 登入後顯示「沒有核發 client_id」或「未授權使用方案」 | 在同意頁面要允許使用 ChatGPT 方案；到設定按「重新授權」 |
| ChatGPT 任務失敗「已達用量上限」 | 按「管理用量」到 ChatGPT 設定查看方案或 Nous 的上限 |
| 公司網路要走 proxy，任務顯示「無法連線到 OpenAI API」 | 啟動時加上 `NODE_USE_ENV_PROXY=1`（例如 `NODE_USE_ENV_PROXY=1 npm start`），讓 Node 使用 `HTTPS_PROXY` 設定 |
| 問家裡溫度時說「無法連線到武陵居中控」 | 中控沒有在執行，或 `SMARTHOME_URL` 的位址、埠號不對 |
| 問家裡溫度時說「中控拒絕了權杖（401）」 | 權杖被撤銷或貼錯；到中控「系統接入」重新建立，更新 `SMARTHOME_TOKEN` 後重新 `npm start` |
| 麥克風權限被拒 | 點網址列左側的鎖頭圖示，把麥克風改為「允許」後重新整理 |
| 即時語音顯示「OPENAI_API_KEY 無效或未授權（401）」 | 檢查 `.env` 的 `OPENAI_API_KEY` 是否完整、沒有多餘空白，改完重新 `npm start` |
| 即時語音顯示「額度不足或超過速率限制（429）」 | 到 <https://platform.openai.com/settings/organization/billing> 確認 API 帳戶有餘額 |
| 設定裡「即時語音：不可用」 | `.env` 沒有 `OPENAI_API_KEY`，或填了之後沒有重新 `npm start` |

## 8. 資料存放位置

- 任務與成果：`prototype/ambient-shell/data/`（本機 JSON 檔，不會上傳）
- ChatGPT 登入憑證與引擎選擇：`~/.config/nous/`（Windows 為 `C:\Users\你的帳號\.config\nous\`）。要完全移除 ChatGPT 連結：先在設定按「登出 ChatGPT」，再到 ChatGPT 設定中斷開 Nous
- 鏡頭與手勢設定：`~/.config/nous/camera.json`（只存你改過的項目，不含任何影像）。刪除這個檔案再重新啟動，就回到 `.env` 與預設值
- 語音閒置秒數：`~/.config/nous/voice.json`（只存你改過的項目）。刪除後重新啟動回到預設（語音模式 1 分 30 秒、即時語音 2 分鐘）
- 想清空紀錄：先停止 `npm start`，刪除 `data` 資料夾，再重新啟動
