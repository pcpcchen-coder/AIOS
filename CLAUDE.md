<!-- bilingual: source=zh-TW -->

> [繁體中文](CLAUDE.md) | [English](CLAUDE.en.md)

# CLAUDE.md — Nous 開發規則 v0.1（2026-10-07）

給在本 repo 工作的開發 agent（Claude Code 等）。規格以 `docs/06`、`docs/07` 及明確日期的專題決定為準；目前實作與證據見 [`docs/Current_Implementation_Status.md`](docs/Current_Implementation_Status.md)。`docs/08` 是 2026-10-07 的歷史規劃快照，不能當作今日現況。

本專案採用 pstack 開發流程。開始非簡單修改前，讀取 [`AGENTS.md`](AGENTS.zh-TW.md) 的專案適配規則及 [`使用指南`](docs/development/pstack.md)，再依對應 playbook 工作。

## 中英文文件與介面（2026-10-26 使用者要求）

所有新增或修改的專案說明文件，必須在同一批變更提供完整繁體中文與英文版本，並同步更新語言切換連結。App 與網頁新增或修改的介面文字（含選單、提示、錯誤、無障礙標籤）也必須支援兩種語言，沿用共用翻譯表。所有後續 Agent 均須遵守 [雙語規範](./docs/BILINGUAL.md)；交付前執行 `node scripts/check-bilingual-docs.mjs`，翻譯審閱完成後才可用 `--record` 更新對應紀錄。摘要不能替代完整翻譯。

**English requirement:** Every agent must deliver complete Traditional Chinese and English documentation in the same change, and support both languages in new or changed App/web interface copy. Follow [the bilingual policy](./docs/BILINGUAL.md), review both versions, and run `node scripts/check-bilingual-docs.mjs` before delivery.

## 開工前

1. 讀 `README.md`、`docs/Current_Implementation_Status.md`、`docs/06`、`docs/07` 及相關專題；需要歷史決策時再讀 `docs/08` 與 01–05。
2. 檢查 repo 是否已有他人新增的程式；延伸既有結構，不重建。
3. 一次只做一個可驗收批次。07 的 PR-xx 與 08 的 PR-00／S1–S4 是原規劃標籤，先對照既有程式，不依舊 prompt 重建。新功能評估 F0–F10／Q0–Q4 仍是提案，不自動更改 gate 或 ADR。

目前程式是 `prototype/ambient-shell` 的 Node HTTP＋SSE、無框架 TypeScript／Vite、Electron 與 JSON 保存。Claude 使用 Anthropic Messages SDK，尚未遷移 Python、Tauri 或完整 Agent SDK。鏡頭已有頭向與手勢實作，但不是眼動校正。開發分工以 Claude 為核心主力、ChatGPT／Codex 為 Quest 端方向；不得由此限制執行時模型供應商。

## 現階段優先順序（2026-10-31 使用者要求）

系統目前只在家裡使用：**功能便利性優先**，權限與安全強化往後擺。挑下一批時先選功能；不主動加做額外的權限或安全防護（例如通用 Action Gate／F1、主視窗網址比對收緊），除非使用者要求。下方「產品紅線」仍必須遵守。

## 產品紅線（違反即不合格）

- 不建立 App launcher、App 圖示、常駐側欄、首頁 Dashboard、預設聊天主頁。
- 每個 Surface 必須帶可驗證的 `visibility_reason`；無有效理由不得呈現。
- 注視只選定目標，不觸發展開、提交、刪除或任何副作用；眨眼不是點擊。
- 「收起」只關視圖，不取消任務；「停止任務」才取消。
- 外部副作用（寄出、發布、付費、永久刪除）須經 Action Gate 與當次明確確認。
- 生成 UI 不得直接取得 shell、檔案系統、MCP token 或任意網路。
- 原始 webcam 影像與未喚醒音訊不得寫檔、進 trace 或外傳。

## 使用者指定的設計要求（必須保留）

- 電子腦至少分「語言區、數理區、藝術區、聽覺區、視覺區、規劃區」；目前處理的內容與實際應用事件必須連動到對應腦區的動畫（亮起、光脈衝、區名）。
- 連動來源只能是真實事件：任務步驟的 `domain` 標記或對話主題分類；不得把它說成模型內部神經活動。
- 收音與播報狀態以裝置事件為準，不把模式開關當作正在收音。視覺主題分類須標明來源，沒有影像輸入或分析時不得宣稱正在觀看。
- 原型實作見 `prototype/ambient-shell/shared/domain.ts`、`src/brain.ts`；正式版 Presence 動畫須延續此要求。

## 誠實規則

- mock、fixture、replay 必須明確標示；不得用來宣稱真實語音、視線或 Agent 能力。
- 工具失敗、timeout、缺資料要回報真實狀態，不顯示假成功。
- 動畫只能由真實事件驅動，不得假裝進度。
- 數字先計算再陳述；計算方式寫進測試或 `docs/validation/`。

## 技術慣例

- TypeScript 為目前原型主體。若採用原規劃的 Python 核心，Python 才放在 `apps/kernel`，不得把此路徑說成已存在。
- 跨語言核心採用時，共用版本化 JSON Schema；`packages/shared/schemas` 目前尚未建立，不假設 Python 可用 tRPC。
- 模型型號不得寫死，經設定或 Models API 取得。
- 使用者以 API key 驗證；不得接入 claude.ai 登入。
- 套件鎖版本；sqlite-vec 為 pre-v1，升版需單獨 PR。
- 不引入 LangChain、LlamaIndex、AGPL／GPL／NC 授權依賴。

## 交付格式

每個批次交付：變更檔案清單、啟動指令、測試結果、畫面或量測證據、未完成項目、下一個 gate。只有真實端到端流程通過對應 gate，才能把 README 的「待實作」改為完成。

## Commit

- Conventional commits（`feat:`、`fix:`、`docs:`、`test:`、`chore:`）。
- 一個 PR 對應一個批次；不夾帶無關重構。
