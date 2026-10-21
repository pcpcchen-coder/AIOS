# 使用 pstack 開發 AIOS

本專案將 pstack 0.15.29 固定在 `cursor/plugins` 的 commit `88d47514b82e7c44f00f2b2a72ff6dd12158038c`。官方技能與 MIT 授權保存在 `vendor/pstack`，版本及檔案雜湊保存在 `vendor/pstack.lock.json`。

## 開始工作

1. 在儲存庫根目錄開啟新的 Cursor 或 Codex 工作階段，讓工具重新探索專案技能。Cursor 使用 `.cursor/skills`，Codex 使用 `.agents/skills`。兩者連向同一份官方檔案。
2. 提供目標及可觀察的完成條件。例如，在 Cursor 輸入 `/poteto-mode 修正取消任務後仍更新進度的問題，先重現，再驗證取消與重試。` Codex 可輸入 `$poteto-mode` 加上需求；若目前介面未列出技能，直接要求讀取 `vendor/pstack/skills/poteto-mode/SKILL.md`。
3. 依選定 playbook 進行理解、設計、實作、審查及驗證。跳過的步驟必須附原因。AIOS 的產品紅線與 gate 定義沿用 `CLAUDE.md` 和 `docs/06` 至 `docs/08`。
4. 在根目錄執行下列檢查，再檢閱 diff。

```bash
node scripts/check-pstack.mjs
node scripts/verify-aios.mjs
git diff --check
```

驗證程式需要 Node.js 22.12 以上及原型的已安裝依賴。缺少套件時，在 `prototype/ambient-shell` 執行 `npm ci`。程式會檢查型別、執行現有測試、建置前端，再從暫存副本啟動真正的伺服器入口，提交模擬任務並取回成果。任務資料與引擎設定均隔離於暫存目錄，不讀取專案 `.env` 或使用者登入憑證。結束後保留報告、日誌與持久化結果證據，並移除伺服器副本。輸出會顯示證據位置。

這個流程只驗證原型的模擬 HTTP 路徑。畫面操作、真實 AI、麥克風、喇叭與 webcam 需要各自的實測，不可由這些結果宣稱通過 G0 至 G3。

## 調整模型

修改 `.cursor/rules/pstack-models.mdc` 的對應角色即可調整專案模型。先從目前工具提供的模型清單確認名稱及推理等級。預設 `inherit-parent` 沿用工作階段模型與推理預算。相同模型的獨立審查不等於跨模型審查。

官方 `/setup-pstack` 預設寫入使用者家目錄，並詢問預算與模型。若要使用它，明確要求改寫本專案的規則檔，並在寫入前確認選擇。此次接入沒有執行全域設定，也沒有選用付費模型方案。

## 更新官方技能

1. 從官方儲存庫選定 commit，檢閱版本差異與授權。
2. 將該 commit 的完整 `pstack/` 複製至 `vendor/pstack`，保留本地 adapter 與 `verify-aios`。不要直接修改官方技能。
3. 更新 `vendor/pstack.lock.json` 的 commit、版本與每個檔案的 SHA-256，並為新增或移除的技能同步調整兩個技能目錄的連結。
4. 執行上述檢查，並在實際使用的客戶端確認技能重新探索成功。

本地檔案與驗證程式可以在雲端檢查。Cursor 選單顯示、全域外掛安裝狀態及原生專屬功能仍須在 Cursor 內確認。Benny Automations 隨官方原始檔保留，但未啟用。此接入不會自動提交、推送、建立 PR、合併或發布。

## Observatory：AIOS pstack 執行監控

原版 pstack 0.15.29 與 `vendor/pstack.lock.json`、既有 Skills 均保持不動；另外提供 `tools/pstack-observe.mjs` 記錄 Run 與步驟。完整操作規範在 `AGENTS.md` 的 observability 區塊。

- Dashboard：https://pcpcchen-coder.github.io/CursorPlugins/
- 本地資料：`.pstack/observability/runs/*.json`（gitignored；預設不公開）。
- AIOS CI：`.github/workflows/pstack-observer.yml`，執行記錄器測試、`scripts/check-pstack.mjs`，生成可下載的 smoke Run Artifact。
- AIOS CI smoke 只證明 Recorder 工作，**不等於** pstack Agent 真正做了功能修改，也不等於 AIOS 產品 Gate 通過。
- 真實的 pstack 任務需由 Agent 依序呼叫 `start`、`step`（running→完成狀態）、`finish`，記錄真實證據與失敗原因。沒有呼叫就沒有觀測資料。
- 需使用者另行明確授權公開內容，才可依[中央文件](https://github.com/pcpcchen-coder/CursorPlugins/blob/custom/pstack/docs/fork/PSTACK_DASHBOARD.md)執行 `publish --public-ok`；預設絕不公開。


### Public cross-repo Observatory E2E

The AIOS owner approved public **sanitized** pstack workflow metadata. The workflow .github/workflows/pstack-public-e2e.yml runs an actual recorder with a scripted, read-only CI investigation, validates the pinned pstack files and recorder tests, exports a filtered snapshot to the public telemetry/pstack branch and stores an evidence artifact. The CI run is labelled investigation-ci and must not be confused with Cursor/Codex pstack Agents executing development tasks.

Source feed: https://github.com/pcpcchen-coder/AIOS/tree/telemetry/pstack/observability/public

Dashboard: https://pcpcchen-coder.github.io/CursorPlugins/

The Dashboard fetches the source feed directly. It requires no cross-repository PAT, and polls about every 60 seconds while the browser tab is visible. GitHub/CDN caching may delay a response. Actual native Agent-run coverage still requires agents to invoke the recorder for each playbook step. Running the workflow does not imply AIOS UI, microphone, camera or other real hardware gates passed.
