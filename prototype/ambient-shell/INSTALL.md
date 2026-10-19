# 安裝與執行指南（本機）

這份指南帶你在自己的電腦上跑起 Nous 電子腦原型。全程約 10 分鐘。

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

## 4. 設定（選填 API key）

複製設定範本：

| 系統 | 指令 |
|---|---|
| macOS／Linux | `cp .env.example .env` |
| Windows PowerShell | `Copy-Item .env.example .env` |
| Windows 命令提示字元 | `copy .env.example .env` |

想讓 Claude 真的執行任務，用文字編輯器打開 `.env`，把這行填上你的 key（到 <https://console.anthropic.com> 申請，使用依量計費）：

```
ANTHROPIC_API_KEY=sk-ant-...
```

不填就是模擬模式：畫面左上角會顯示「模擬模式」，任務只是走流程，不會真的完成。

`.env` 已被 git 排除，不會被上傳。

## 5. 啟動

```bash
npm start
```

看到下面這行就成功了：

```
Nous 原型已啟動：http://localhost:8787
```

用 Chrome 或 Edge 打開 <http://localhost:8787>。

要關閉時，在終端機按 `Ctrl + C`。下次只要回到 `AIOS/prototype/ambient-shell` 再執行 `npm start`。

## 6. 怎麼用

| 操作 | 結果 |
|---|---|
| 點電子腦、按空白鍵，或直接打字 | 出現輸入框 |
| 輸入要交辦的事，按 Enter | 開始執行，電子腦下方顯示目前步驟與進度環 |
| 輸入「進度如何」 | 列出所有任務的進度 |
| 輸入「看結果」 | 打開最新完成的成果 |
| 輸入「停止任務」 | 停止進行中的任務 |
| 輸入「收起」或按 Esc | 回到只有電子腦的畫面，任務在背景繼續 |
| 麥克風按鈕 | 按下說話（第一次會先詢問是否同意使用瀏覽器的雲端語音辨識） |

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
| 麥克風權限被拒 | 點網址列左側的鎖頭圖示，把麥克風改為「允許」後重新整理 |

## 8. 資料存放位置

- 任務與成果：`prototype/ambient-shell/data/`（本機 JSON 檔，不會上傳）
- 想清空紀錄：先停止 `npm start`，刪除 `data` 資料夾，再重新啟動
