<!-- bilingual: source=en -->

> [繁體中文](AGENTS.zh-TW.md) | [English](AGENTS.md)

<a id="aios-agent-workflow"></a>
# AIOS Agent 工作流程

<a id="required-bilingual-documentation-and-interface-policy--中英文必要規則"></a>
## 中英文文件與介面必要規則 / Required bilingual documentation and interface policy

**使用者要求（2026-10-26）：所有 Agent（包含 Claude Code、Codex、Cursor）新增或修改專案說明文件時，必須在同一批變更提供完整繁體中文與英文版本；新增或修改 App／網頁介面文字也必須同時支援中英文。**

**Owner requirement, 2026-10-26. Every new or updated project document must provide complete Traditional Chinese and English versions in the same change. Every new or changed user-facing App or web string must support both languages. This applies to every agent, including Claude Code, Codex, and Cursor.**

- 寫作前閱讀[雙語規範](docs/BILINGUAL.md)。中文原路徑保留，英文對應檔使用 `name.en.md`；英文原稿使用 `name.zh-TW.md` 提供中文。短篇規範可以在同一檔完整列出兩種語言。
- 完整翻譯內容，包含表格、警告、限制與驗收證據。保留可執行範例、識別字、路徑、數字與歷史日期；摘要或語言切換連結不能取代翻譯。
- 修改其中一版時同步另一版，加入相互語言連結並優先連到對應語言。翻譯標題時保留原章節錨點。
- 區分使用者內容、模型回覆與介面文案。App 與網頁沿用共用翻譯表，涵蓋無障礙標籤及原生選單／對話框；不因翻譯或自動化 UI 測試推論硬體驗收完成。
- 交付前執行 `node scripts/check-bilingual-docs.mjs`。審閱同步翻譯後，執行 `node scripts/check-bilingual-docs.mjs --record` 更新目錄紀錄，再重跑檢查。不可為了通過而記錄過時或不完整翻譯。
- 固定於 `vendor/` 的第三方原碼、註冊符號連結、原始證據日誌、依賴清單及 App HTML 樣稿不在翻譯範圍；另以雙語專案文件說明。不為滿足此規範修改上游雜湊。

閱讀 `CLAUDE.md`，遵守產品規則、文件閱讀順序、批次邊界與證據要求。先讀 `docs/Current_Implementation_Status.md`，確認目前能力與證據，再讀適用規格。現行 App 是 `prototype/ambient-shell`，使用 Node HTTP/SSE、純 TypeScript/Vite、Electron 與 JSON 任務／成果保存。設計文件中的 monorepo、Python kernel、Tauri shell、校正眼動及本機喚醒／ASR／TTS 流程仍在規劃。頭向、雙目姿態與手勢已有程式，不代表硬體準確度已證實。延伸目前原型，不依歷史 roadmap 重建。

`docs/13_Feature_Expansion_Assessment_2026-10-24.md` 提出 Quest、OpenClaw 與多裝置工作。F0–F10、Q0–Q4 是提案，不代表已實作或通過 G0–G3。Claude 主力開發核心，ChatGPT/Codex 主力負責 Quest 工程，執行時供應商保持可配置。

<a id="use-pstack-for-engineering-work"></a>
## 工程工作使用 pstack

非簡單開發工作先讀 `docs/development/pstack.md`，再讀 `vendor/pstack/skills/poteto-mode/SKILL.md` 與對應 playbook，然後編輯。步驟適用時閱讀引用技能。小型、明確修改可直接編輯並做相稱驗證。文件工作閱讀 `vendor/pstack/skills/technical-writing/SKILL.md`。

多步工作維持計畫，對照 investigation、bug fix、feature、refactoring 或其他上游 playbook。修 bug 前先重現；新增有狀態邏輯前先定義資料結構。採取能解決問題的最小修改，每個單位以受影響行為的證據收尾。ambient 原型使用 `.agents/skills/verify-aios/SKILL.md`。

<a id="runtime-adaptation"></a>
## 執行環境適配

- 這是專案內固定的 pstack 副本，原檔在 `vendor/pstack`；`.cursor/skills` 與 `.agents/skills` 連到它們，引用時使用正式原檔路徑。
- Codex 中，Cursor `Task` 對應可用協作工具，待辦清單對應計畫工具，檔案／搜尋指令對應 shell 工具。每個委派任務都提供 poteto-mode 絕對路徑與明確範圍；playbook 要求時讀上游 agent brief，不傳入不支援的 Cursor 欄位。
- 委派前讀 `.cursor/rules/pstack-models.mdc`。所有角色目前沿用主工作階段的模型與推理預算。不虛構 Cursor 模型 ID，不把相同模型審查稱為多模型審查。其他模型僅在可用且被要求時配置。
- 只有適用流程要求且執行環境允許時使用平行 Agent，分開寫入範圍避免修改同檔，並親自驗證成果。
- 雲端工作已有隔離 checkout，直接使用；僅在使用者明確要求時建立 worktree。流程需要隔離時優先使用暫存檔或 checkout 中的獨立所有權。
- 此接入未安裝 Cursor UI 控制、Bugbot、Automations 或 cursor-team-kit。無法執行的步驟說明具體原因。依 repo 檢查實際證明的內容陳述；HTTP 測試不能宣稱瀏覽器互動已驗證。
- 上游自治文字不授權傳訊、發布、合併、部署或破壞性操作；遵守使用者當次授權與主機權限。不可只因 playbook 最後列出提交而建立 commit 或 PR。
- 憑證、使用者資料、私人逐字稿不可進驗證產物。明示 mock，模擬供應商測試不能讓 `docs/07` 的真硬體或 AI gate 通過。

<a id="validation"></a>
## 驗證

repo 根目錄執行 `node scripts/check-pstack.mjs`，檢查固定上游副本與技能註冊。執行 `node scripts/verify-aios.mjs` 進行型別檢查、既有測試、建置與隔離模擬 HTTP 流程。這兩項不會安裝依賴；需要時先在 `prototype/ambient-shell` 執行 `npm ci`。

<!-- PSTACK_OBSERVABILITY_BEGIN -->
<a id="aios-pstack-execution-observability"></a>
## AIOS pstack 執行可觀測性

AIOS 已將 pstack 固定在 `vendor/pstack/`，版本紀錄為 `vendor/pstack.lock.json`。不取代原始技能、模型規則或雜湊檢查，先遵守 CLAUDE.md。

每個**實際** pstack 工程任務，必須在第一個 playbook 階段之前從 repo 根目錄初始化穩定 run：

```bash
node tools/pstack-observe.mjs start --repo pcpcchen-coder/AIOS --title "Read-only investigation" --playbook investigation --steps "inspect,verify,report" --branch "feature/my-work"
node tools/pstack-observe.mjs step --run RUN_ID --step inspect --status running
# Execute work; mark the actual result with evidence only afterwards.
node tools/pstack-observe.mjs step --run RUN_ID --step inspect --status passed --note "Reviewed source" --evidence "https://github.com/pcpcchen-coder/AIOS"
# Repeat other actual steps before finishing.
node tools/pstack-observe.mjs finish --run RUN_ID --status passed
```

從 stdout 取得 RUN_ID，選擇實際 playbook 步驟 ID，不用泛稱。先標 running，再依事實標 passed / failed / blocked / skipped 並加註。無測試證據不得標通過；記錄器錯誤必須回報，不可略過。

獨立的 `.github/workflows/pstack-observer.yml` 只是**記錄器 smoke test**，不是 pstack 工程執行或 AIOS 產品驗證，只生成 Actions artifact。

Run JSON 預設保存在 `.pstack/observability/runs/`，gitignored 並留本機，未啟用自動公開上傳。中央 [Pstack Observatory](https://pcpcchen-coder.github.io/CursorPlugins/) 是公開服務，不得發布私人逐字稿、prompt、原碼、秘密、路徑或個資。任何 run 發布都需要另外明確授權、`PSTACK_OBSERVE_PUBLICATION_ACK=1` 與 `--public-ok`，見[操作文件](https://github.com/pcpcchen-coder/CursorPlugins/blob/custom/pstack/docs/fork/PSTACK_DASHBOARD.md)。既有 CLAUDE.md 操作 gate 仍適用。
<!-- PSTACK_OBSERVABILITY_END -->

<a id="public-aios-observatory-feed-consent-2026-10-21"></a>
## AIOS Observatory 公開 feed 授權（2026-10-21）

AIOS 擁有者已核准發布本專案的 pstack 進度與證據。僅發布**去識別的操作 run metadata**：任務標題、playbook、步驟狀態、時間與公開 GitHub 證據網址。不得把原碼 payload、本機路徑、秘密、私人 prompt／逐字稿或個資放進公開 feed。

`.github/workflows/pstack-public-e2e.yml` 可透過**僅限 AIOS 的 GITHUB_TOKEN**，將腳本化 CI investigation 發到 AIOS 公開的 telemetry/pstack 分支。Run 刻意命名為 investigation-ci，不是 IDE Agent run；流程不執行原生 Cursor/Codex pstack controller。

真實 Cursor/Codex 任務仍須依 AGENTS.md 呼叫 start/step/finish。使用另行登入的 GitHub CLI 發到中央 Dashboard 時，檢查 metadata 後設定 PSTACK_OBSERVE_PUBLICATION_ACK=1，並使用 --publish --public-ok。不可把 token 存 repo。連線不可用時，可安全地只記錄本機資料。

授權**只適用 AIOS**，不適用共用 pstack 的其他專案。

<a id="native-pstack-task-reporting-after-instrumentation"></a>
### 接入後的原生 pstack 任務回報

**後續真正的 AIOS pstack 開發工作**改用公開安全 sidecar，取代直接呼叫原始記錄器。它會先成功記錄本機，再在擁有者核准的 AIOS 公開旗標啟用時發布每個階段快照：

    export PSTACK_OBSERVE_PUBLICATION_ACK=1
    node tools/pstack-observe-live.mjs start --repo pcpcchen-coder/AIOS --title "Task" --playbook investigation --steps "inspect,verify,report"
    node tools/pstack-observe-live.mjs step --run RUN_ID --step inspect --status running
    # Work, then record the actual observed result.
    node tools/pstack-observe-live.mjs step --run RUN_ID --step inspect --status passed --note "Checked actual source"
    # Continue remaining stages and finish the run.

未配置 GH_TOKEN/GITHUB_TOKEN 時，wrapper 嘗試已登入的 GitHub CLI，不印出 token。發布仍需要寫入 **AIOS telemetry/pstack 分支**的權限。發布失敗會回報錯誤並保留本機 JSON；只有發布成功才能宣稱 Dashboard 收到。Wrapper 拒絕直接傳入未過濾的 --publish 旗標。

這是 **Agent 主動呼叫的可觀測性**，不是隱藏攔截 Cursor/Codex 工具操作；忽略規則的 Agent 不會自動被觀測。
