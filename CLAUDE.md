# CLAUDE.md — Nous 開發規則 v0.1（2026-10-07）

給在本 repo 工作的開發 agent（Claude Code 等）。規格以 `docs/06`、`docs/07` 為準，現況與修正提案見 `docs/08`。

## 開工前

1. 讀 `README.md`、`docs/08`、`docs/06`、`docs/07`，再讀 01–04 中與本任務相關段落。
2. 檢查 repo 是否已有他人新增的程式；延伸既有結構，不重建。
3. 一次只做一個批次（07 的 PR-xx 或 08 的 PR-00／S1–S4）。

## 產品紅線（違反即不合格）

- 不建立 App launcher、App 圖示、常駐側欄、首頁 Dashboard、預設聊天主頁。
- 每個 Surface 必須帶可驗證的 `visibility_reason`；無有效理由不得呈現。
- 注視只選定目標，不觸發展開、提交、刪除或任何副作用；眨眼不是點擊。
- 「收起」只關視圖，不取消任務；「停止任務」才取消。
- 外部副作用（寄出、發布、付費、永久刪除）須經 Action Gate 與當次明確確認。
- 生成 UI 不得直接取得 shell、檔案系統、MCP token 或任意網路。
- 原始 webcam 影像與未喚醒音訊不得寫檔、進 trace 或外傳。

## 誠實規則

- mock、fixture、replay 必須明確標示；不得用來宣稱真實語音、視線或 Agent 能力。
- 工具失敗、timeout、缺資料要回報真實狀態，不顯示假成功。
- 動畫只能由真實事件驅動，不得假裝進度。
- 數字先計算再陳述；計算方式寫進測試或 `docs/validation/`。

## 技術慣例

- TypeScript 為主（前端、shared、presentation-policy）；Python 只用於 `apps/kernel`。
- TS 與 Python 共用 `packages/shared/schemas` 的版本化 JSON Schema；不假設 Python 可用 tRPC。
- 模型型號不得寫死，經設定或 Models API 取得。
- 使用者以 API key 驗證；不得接入 claude.ai 登入。
- 套件鎖版本；sqlite-vec 為 pre-v1，升版需單獨 PR。
- 不引入 LangChain、LlamaIndex、AGPL／GPL／NC 授權依賴。

## 交付格式

每個批次交付：變更檔案清單、啟動指令、測試結果、畫面或量測證據、未完成項目、下一個 gate。只有真實端到端流程通過對應 gate，才能把 README 的「待實作」改為完成。

## Commit

- Conventional commits（`feat:`、`fix:`、`docs:`、`test:`、`chore:`）。
- 一個 PR 對應一個批次；不夾帶無關重構。
