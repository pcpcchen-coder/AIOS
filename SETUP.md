<!-- bilingual: source=zh-TW -->

> [繁體中文](SETUP.md) | [English](SETUP.en.md)

# 安裝、驗證與協作入口

更新日期：2026-10-24。AIOS 已有可執行的 Nous 原型，並非只含設計文件。

## 執行本機原型

需要 Node.js 22.12 以上、npm 與 Git。

```bash
git clone https://github.com/pcpcchen-coder/AIOS.git
cd AIOS/prototype/ambient-shell
npm ci
npm start
```

開啟 `http://localhost:8787`。核心只綁本機位址；沒有配置模型時可先用明示的模擬模式。Claude API、ChatGPT 引擎登入與即時語音的 Codex 登入是不同設定，請依 [完整安裝指南](prototype/ambient-shell/INSTALL.md) 選擇。

macOS 的 [桌面指南](prototype/ambient-shell/desktop/README.md) 包含既有預覽版與自行打包方式。預先建置 Release 的內容不保證等於 main 最新程式。Quest 與其他區網裝置目前不能直接接這個 localhost 服務。

## 更新既有 checkout

先確認工作目錄沒有需要保留的未提交修改，再更新 main。若正在功能分支，先依該分支的工作流程處理，不覆蓋現有修改。

```bash
git status
git switch main
git pull --ff-only
cd prototype/ambient-shell
npm ci
```

執行中的程式需重新啟動才會載入新來源。帳號、設定與任務資料位置見安裝指南；不要用重下載 repo 取代資料遷移。

## 驗證開發環境

在原型安裝依賴後，從 repo 根目錄執行：

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
git diff --check
```

第一項檢查固定版本的 pstack；第二項執行型別、測試、建置及隔離 mock HTTP 流程。測試不會因此證明真實模型、語音、鏡頭或 Quest 已驗收，詳見 [目前實作與驗證](docs/Current_Implementation_Status.md)。

## 參與變更

先讀 [AGENTS.md](AGENTS.zh-TW.md)、[CLAUDE.md](CLAUDE.md) 及 [文件索引](docs/README.md)，延伸既有 `prototype/ambient-shell`，不要依舊藍圖重新建立另一套應用程式。

使用獨立分支，提交有範圍的變更與相應證據，再推送分支並開 PR。不要將 `.env`、登入憑證、原始音訊／影像、私人 trace 或任務資料加入版本控制。推送需要有權限的 GitHub 登入；沿用已配置的認證，不把權杖寫進文件。

文件調整須同步區分目前實作、尚未通過的實機驗證與未實作構想。架構和功能的新提案見 [功能擴充評估](docs/13_Feature_Expansion_Assessment_2026-10-24.md)；歷史驗證紀錄保留原始日期和 fixture 標記。

## 找到正確的下一步

- 只想使用原型：讀原型安裝與桌面指南。
- 需要確認做到了什麼：讀目前實作與驗證，不用舊 roadmap 推論完成度。
- 需要決定擴充順序：讀功能評估的 F0–F10 與 Q0–Q4。
- 需要正式 Alpha 驗收：依 docs/06–07 與相關專題驗證，不能用測試全綠替代 gate。
