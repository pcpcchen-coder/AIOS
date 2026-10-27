<!-- bilingual: source=zh-TW -->

> [繁體中文](03_3Month_Accelerated_Roadmap.md) | [English](03_3Month_Accelerated_Roadmap.en.md)

# Nous 認知 OS — 3 個月加速開發時程

> **2026-10-24 閱讀導覽**：目前程式與缺口以 [實作現況](Current_Implementation_Status.md) 為準；新功能的價值、依賴、MVP 與 roadmap 見 [功能擴充評估](13_Feature_Expansion_Assessment_2026-10-24.md)。本文保留早期設計，不代表已實作或已通過驗收。產品紅線與 G0–G3 仍依 [06](06_Ambient_Voice_Gaze_Experience.md)、[07](07_Ambient_Implementation_and_Acceptance.md) 及後續明確修訂執行；新評估中的 F0–F10、Q0–Q4 不取代這些 gate。
>
> 程式基準為 `1f44c6b`（2026-10-23）。可執行原型位於 `prototype/ambient-shell`，採 Node HTTP、SSE、TypeScript、Vite 與 Electron。本文的 Tauri、React、Python kernel、Agent SDK、長期記憶及生成工具等屬目標設計；模型、價格、市場、stars 與外部生態數據是原始撰寫時的資料，本次未重新查證，採用前須另查。

> **2026-10-07 歷史更新**：當時的估計時程（PR-00 + G0–G3）見 [08 §6](08_Consolidation_and_Update_2026-10.md#6-重新排程)。08 §3.3 P1 記錄當時對「Letta REST API」路線的修正判斷；本次未重新查證外部狀態。以下未勾選項是舊計畫，不能用來推算今日進度。

> **2026-09-16 互動規格更新**：電子腦待機、無 App、語音優先、webcam 視線選取及按需呈現，依 [06 體驗規格](06_Ambient_Voice_Gaze_Experience.md) 與 [07 開發驗收](07_Ambient_Implementation_and_Acceptance.md)。本文其餘底層設計保留；舊時程與舊介面描述僅供歷史參考，衝突時以 06–07 為準。

> **核心哲學**：不重造輪子、不自建底層、專注整合與 UX。**12 個月 → 3 個月**的關鍵在於把每個模組都外包給社群已成熟的 OSS，我們只寫「薄膠水層」與差異化的使用者體驗。
>
> **團隊**：1 人類 + Claude Code（pair programmer）
> **目標交付**：**Alpha Release（可邀請 5-10 位早期使用者試用）**
> **不追求**：公開 Beta、App Store 上架、完整 plugin marketplace（這些留給 Month 4+）

---

## 2026-09-16 排程修訂

語音、按需呈現與 webcam 大區塊選取已成核心需求。實作依 [07](07_Ambient_Implementation_and_Acceptance.md) 的 G0–G3 推進：殼與政策 → 真實語音任務 → 視線融合 → Alpha 驗收。優先削減知識圖譜 UI、白板及公開發布等非必要工作，以騰出硬體驗證時間。

以下週級拆解保留供底層工作參考，不再作固定 12 週交付承諾；其中聊天、知識、成本與工作流畫面一律按需顯示。

## 🎯 原 3 個月的總體節奏

```
Month 1: Assemble ────── 把所有零件裝起來，跑通端到端 demo
Month 2: Integrate ───── 整合所有元件，補上 Agent 編排與 MCP
Month 3: Polish ──────── UX 打磨、測試、打包、Alpha 釋出
```

**每週五**：人類做 review + demo + 下週計畫
**每日**：Claude Code 執行實作 + 人類架構決策
**每兩週**：對外更新（Twitter / Blog / Discord）累積社群

---

## Month 1｜Assemble 組裝期（Week 1-4）

**目標**：把 Letta + LightRAG + Claude Agent SDK + Tauri + assistant-ui 五大引擎組起來,跑通「匯入文件 → 對話 → 記住 → 再問」的端到端最小閉環。

---

### Week 1 — 基礎設施與骨架

**Must-have 交付物**：
- [ ] Fork `agmmnn/tauri-ui` 作為桌面殼骨架
- [ ] 建立 monorepo 結構（pnpm workspaces）
  ```
  nous/
    apps/desktop/       # Tauri + React 前端
    apps/kernel/        # Python FastAPI 後端
    packages/shared/    # 共用 types (tRPC)
    packages/agents/    # Claude Agent SDK 封裝
    docker/             # Letta + LightRAG + Langfuse
  ```
- [ ] 撰寫 `CLAUDE.md`（架構決策、編碼慣例、禁止事項）
- [ ] Docker Compose 啟動 Letta + LightRAG + Langfuse 三個服務
- [ ] 最基本的 Claude API 對話能跑起來（TS SDK）
- [ ] 新版優先項：Ambient 電子腦 Shell、狀態事件與 Presentation Policy（07 PR-01–02）

**Nice-to-have**：
- GitHub Actions CI（lint / test）
- Claude Code Skills 設定（讓 Claude Code 知道怎麼操作這個 repo）

**分工**：
- **人類**：Tauri 配置、架構決策、Docker Compose 編排、CLAUDE.md
- **Claude Code**：monorepo 初始化、tauri-ui fork 清理、package.json 依賴安裝

**風險 / Fallback**：
- Tauri 2 跨平台 WebView 問題 → 先只測 macOS,Windows 延後
- Letta Docker 啟動慢 → 用 Mem0 Python SDK 當 fallback

---

### Week 2 — 記憶層整合

**Must-have 交付物**：
- [ ] Kernel 後端透過 Letta REST API 建立 agent 與發送訊息
- [ ] 前端能顯示 Letta agent 的 core memory（persona + human block）
- [ ] 對話跨 session 保持記憶（驗證：關掉 App 重開,Claude 記得你名字）
- [ ] assistant-ui 整合：訊息流 UI、streaming、markdown 渲染
- [ ] Langfuse 開始記錄所有 LLM 呼叫

**參考整合點**：
- Letta SDK：https://github.com/letta-ai/letta
- assistant-ui：https://github.com/assistant-ui/assistant-ui
- Langfuse integration：https://langfuse.com/docs

**分工**：
- **人類**：Letta vs Mem0 決策、記憶 schema 設計、對話流程驗證
- **Claude Code**：Letta client wrapper、assistant-ui 元件整合、Langfuse SDK 埋點

**可展示里程碑**：💬 **能跨 session 記住你的 Claude 對話桌面應用**

---

### Week 3 — 知識層整合

**Must-have 交付物**：
- [ ] Docker Compose 加入 LightRAG
- [ ] 文件攝取管線：Docling（PDF/Office）+ MarkItDown（通用）+ Firecrawl API（Web）
- [ ] 上傳文件 → 切塊 → 嵌入 → 存入 LightRAG
- [ ] LightRAG 雙層檢索介接 Claude（作為 Agent 的 retrieval tool）
- [ ] 知識庫瀏覽 UI 雛型（列出已攝取文件）

**參考整合點**：
- LightRAG：https://github.com/HKUDS/LightRAG
- Docling：https://github.com/docling-project/docling
- MarkItDown：https://github.com/microsoft/markitdown

**分工**：
- **人類**：ingestion pipeline 架構、知識庫 schema、切塊策略決策
- **Claude Code**：Docling/MarkItDown wrapper、LightRAG client、檔案上傳 UI

**可展示里程碑**：📚 **丟一批 PDF 進去,Claude 能基於內容準確回答**

---

### Week 4 — 端到端閉環

**Must-have 交付物**：
- [ ] 串起三個引擎：使用者發問 → Letta（記憶 context）+ LightRAG（知識 context）→ Claude → 回答 + 更新記憶
- [ ] Claude Agent SDK 整合：用 `@tool` decorator 定義 `search_knowledge` 與 `recall_memory` 工具
- [ ] 基本權限對話框：首次使用工具時彈窗授權
- [ ] Alpha 版本可安裝（未簽章也 OK）

**Nice-to-have**：
- Week 4 小 demo 影片（2 分鐘）放 Twitter 累積關注度

**Month 1 收官里程碑**：🎉 **端到端跑通 — 桌面應用、持久記憶、知識檢索、工具呼叫**

---

## Month 2｜Integrate 整合期（Week 5-8）

**目標**：補完 Agent 編排、MCP 工具生態、UI 完整度,讓系統從「能用」進化到「實用」。

---

### Week 5 — Agent 編排與 Sub-Agents

**Must-have 交付物**：
- [ ] Claude Agent SDK Sub-Agent 能力啟用（`AgentDefinition`）
- [ ] 3 個內建專業 Agent：
  - **Research Agent**（搜尋 + 閱讀 + 摘要）
  - **Writer Agent**（長文撰寫 + 編輯）
  - **Summarizer Agent**（會議 / 文件摘要）
- [ ] Supervisor Agent 路由邏輯（根據使用者意圖分派）
- [ ] Agent Monitor UI 雛型（顯示執行中 agents、進度、可中斷）

**參考整合點**：
- Claude Agent SDK docs：https://docs.claude.com/en/docs/claude-code/sdk

**分工**：
- **人類**：Agent 角色設計、系統提示詞、路由邏輯
- **Claude Code**：Agent 類別實作、UI 元件、streaming 多 agent 狀態

**可展示里程碑**：🤖 **「幫我研究 X 並寫成報告」觸發多 Agent 分工協作**

---

### Week 6 — MCP 工具生態

**Must-have 交付物**：
- [ ] MCP Server Manager 後端：啟動、停止、管理 STDIO / HTTP MCP servers
- [ ] MCP Server Manager UI：瀏覽官方 Registry、一鍵安裝、授權對話
- [ ] 內建 5 個 MCP servers：filesystem、github、gmail、notion、playwright（瀏覽器）
- [ ] 權限稽核日誌（哪個 agent、哪個時間、呼叫了哪個工具）

**參考整合點**：
- MCP Registry：https://github.com/modelcontextprotocol/registry
- MCP Servers：https://github.com/modelcontextprotocol/servers
- GitHub MCP：https://github.com/github/github-mcp-server
- Notion MCP：https://github.com/makenotion/notion-mcp-server
- Playwright MCP：https://github.com/microsoft/playwright-mcp

**分工**：
- **人類**：MCP server 生命週期架構、權限模型、稽核策略
- **Claude Code**：MCP client pool、Registry API integration、UI 安裝流程

**可展示里程碑**：🔌 **「看一下我今天 GitHub PR 狀況」自動呼叫 GitHub MCP**

---

### Week 7 — 知識 UI 與個人化工作流

**Must-have 交付物**：
- [ ] 按需 Knowledge Surface：搜尋、篩選、預覽、刪除，關閉後回電子腦
- [ ] LightRAG 知識圖譜視覺化（它自帶 Web UI,用 iframe 或重繪）
- [ ] 個人 vs 工作知識庫分離（UI + SQLite namespace）
- [ ] 背景攝取 daemon：監控資料夾自動索引
- [ ] Command Bar（Cmd+K）全域搜尋 + 快速命令

**分工**：
- **人類**：UX 設計、互動流程、視覺層決策
- **Claude Code**：UI 元件實作、shortcuts 系統、背景任務

**可展示里程碑**：🔍 **完整的第二大腦體驗 — 搜尋、瀏覽、視覺化知識圖譜**

---

### Week 8 — 可觀測性與持久化

**Must-have 交付物**：
- [ ] Langfuse 完整埋點：trace、token、成本、agent graph 視覺化
- [ ] 按需查詢 Token／成本（每日 / 每月 / 每個 Agent），不常駐顯示
- [ ] 長時任務持久化：SQLite checkpoint 機制（不上 Temporal）
- [ ] 對話可回放 / 編輯 / 從任意點重試
- [ ] 按需顯示任務依據、來源與執行摘要

**參考整合點**：
- Langfuse：https://github.com/langfuse/langfuse

**分工**：
- **人類**：儀表板指標設計、checkpoint schema
- **Claude Code**：Langfuse hooks、UI 儀表板、回放邏輯

**Month 2 收官里程碑**：🏗️ **完整的 OS 骨架 — 記憶、知識、Agent、工具、追蹤一應俱全**

---

## Month 3｜Polish 打磨與釋出（Week 9-12）

**目標**：從「能用」升級到「好用」,準備 Alpha 釋出給早期使用者。

---

### Week 9 — UX 精修與多模態

**Must-have 交付物**：
- [ ] TipTap 富文字編輯器整合（知識撰寫）
- [ ] 深色 / 淺色主題
- [ ] 視覺一致性全面檢查（spacing、typography、color tokens）
- [ ] 快捷鍵系統完整化
- [ ] 啟動速度優化（目標 < 3 秒）
- [ ] 對話首 token < 1 秒

**Nice-to-have**：
- tldraw 白板整合（知識地圖）

語音已移至新版 G1 必做：喚醒、STT、TTS、打斷與備援，不再列入本週 Nice-to-have。

**參考整合點**：
- TipTap：https://github.com/ueberdosis/tiptap
- tldraw：https://github.com/tldraw/tldraw

**分工**：
- **人類**：UX 細節、視覺品質、使用者測試（找 2-3 位朋友試玩）
- **Claude Code**：TipTap 整合、主題系統、動畫優化

---

### Week 10 — 安全與設定

**Must-have 交付物**：
- [ ] API Key 管理移到 Tauri keyring plugin（OS 原生）
- [ ] 設定面板完整版：API keys、模型選擇、記憶參數、Agent 配置
- [ ] 權限模型三層完整實作（系統 / Agent / 使用者）
- [ ] 資料備份匯出（單一 .nous 檔案包含所有記憶 + 知識 + 設定）
- [ ] 資料匯入（從備份還原）

**參考整合點**：
- Tauri keyring plugin：https://github.com/tauri-apps/plugins-workspace

**分工**：
- **人類**：安全模型審查、UX 設計
- **Claude Code**：keyring 整合、設定面板、備份邏輯

---

### Week 11 — 穩定性與打包

**Must-have 交付物**：
- [ ] E2E 測試覆蓋核心流程（Playwright）
- [ ] 記憶系統壓力測試（1000+ 記憶、100+ 文件）
- [ ] 崩潰回報機制（Sentry 或自建）
- [ ] Tauri auto-updater 配置
- [ ] macOS .dmg 打包（先不 notarize,Alpha 可接受）
- [ ] Windows .msi 打包
- [ ] Linux .AppImage 打包

**Nice-to-have**：
- Apple notarization（如有 Developer Account）
- Windows code signing（成本 $400+/年,可延後）

**分工**：
- **人類**：測試場景設計、打包配置、崩潰優先順序
- **Claude Code**：Playwright scripts、bug 修復、CI/CD 打包流程

---

### Week 12 — 文件、社群、Alpha 釋出

**Must-have 交付物**：
- [ ] README（安裝、quick start、architecture 概覽）
- [ ] `docs/` 資料夾：Getting Started、Architecture、Privacy、FAQ
- [ ] Landing page（GitHub Pages 或 Vercel，1 頁即可）
- [ ] 發布 Blog：「Building Nous in 3 Months: A Cognitive OS on Claude」
- [ ] Discord 伺服器建立、GitHub Discussions 開啟
- [ ] Demo 影片（5 分鐘 walkthrough）
- [ ] **Private Alpha 釋出**：邀請 5-10 位早期使用者（Twitter DM / 個人網絡）

**Nice-to-have**：
- Hacker News / Product Hunt 試水（只有骨架 ok 就先發）
- Twitter 發布文章

**分工**：
- **人類**：文件撰寫、社群經營、PR/行銷、alpha 邀請
- **Claude Code**：文件生成骨架、網站程式碼、最終 bug 修復

**Month 3 收官里程碑**：🚀 **Private Alpha 釋出 — 5-10 位使用者實際使用,開始收集回饋**

---

## 📊 3 個月 vs 12 個月的取捨

| 功能 | 12 個月版本 | 3 個月版本 | 為何可砍 |
|---|---|---|---|
| 三層記憶自建 | ✅ 全自建 | ❌ 用 Letta | 省 6-8 週 |
| 知識圖譜自建 | ✅ SQLite 模擬 → Neo4j | ❌ 用 LightRAG | 省 4-6 週 |
| 文件解析自建 | ✅ 多格式分層 | ❌ 用 Docling + MarkItDown | 省 2-3 週 |
| Chat UI 自建 | ✅ 客製化元件 | ❌ 用 assistant-ui | 省 2-3 週 |
| Tauri shell 自建 | ✅ 從頭配置 | ❌ Fork tauri-ui | 省 1-2 週 |
| MCP connectors 自寫 | 部分內建 | ❌ 全用官方 | 省 3-4 週 |
| 觀測儀表板自建 | ✅ | ❌ 用 Langfuse | 省 2-3 週 |
| Temporal.io 整合 | Phase 2 引入 | ❌ 砍掉,用 SQLite checkpoint | 省 2 週 |
| tldraw 白板 | ✅ | 🟡 Nice-to-have | 非核心 |
| 語音介面 | ✅ | ✅ 新版 G1 必做 | 主要互動通道 |
| webcam 視線選取 | 未納入原時程 | ✅ 新版 G2 驗證大區塊 | 接替核心流程的滑鼠指向 |
| 電子腦＋按需呈現 | 未納入原時程 | ✅ 新版 G0 必做 | 預設產品體驗 |
| 雲端同步 | ✅ | ❌ Month 4+ | 非核心 |
| 行動端 | ✅ | ❌ Month 6+ | 非核心 |
| Plugin marketplace | ✅ | ❌ Month 6+ | 非核心 |
| 完整 Beta 發布 | ✅ | 🟡 Alpha 釋出 | 縮小 scope |
| 商業化準備 | ✅ | ❌ Month 4+ | 非核心 |

---

## 🔥 關鍵成功因子

### 1. 嚴守「整合優先」紀律
每次遇到「自己寫會不會更好」的誘惑,**強制先搜尋 GitHub**。只有當沒有 >5K⭐ 的成熟專案能用時才自建。

### 2. Claude Code 效能倍增
- **CLAUDE.md** 寫清楚架構決策、禁止事項、編碼慣例
- **Git worktrees** 讓 Claude Code 同時在多個 feature branch 上作業
- **Skills system** 建立 repo 專屬技能（例如 `add-mcp-server`、`create-agent-template`）
- **明確的任務粒度**:一次給 Claude Code 一個 PR 大小的任務,不要「做整個 Agent 系統」

### 3. 每週五 Demo Day
每週五下午:
1. 錄 2-3 分鐘 demo 影片(即使還很醜)
2. 發 Twitter / 個人社群
3. 寫 dev log（Notion / Blog）
4. Review 本週進度 + 調整下週計畫

累積「build in public」動能,為 Month 3 的 Alpha 釋出預熱。

### 4. 砍 scope 比加 scope 重要
每週檢視:「這個功能 Alpha 使用者真的會用嗎?」若否,立刻延後。

### 5. Alpha 使用者是真實回饋來源
Week 12 釋出後,每週訪談 2 位使用者,Month 4 規劃由他們的痛點決定,不是由你的想像決定。

---

## ⚠️ 高風險區與應對

| 風險 | 機率 | 影響 | 應對 |
|---|---|---|---|
| Letta API 不穩 / 效能不符預期 | 中 | 高 | Week 2 結束時若發現問題,立即 fallback 到 Mem0 |
| LightRAG 索引太慢 | 中 | 中 | Fallback 到純 sqlite-vec + FTS5,不做 KG |
| Tauri 跨平台 bug | 中 | 中 | 只支援 macOS + Windows,Linux 延後 |
| MCP servers 品質不穩 | 高 | 中 | 只內建官方維護的 5 個 server |
| Anthropic 釋出類似產品（Claude Cowork 更新）| 中 | 高 | 保持差異化定位（本地優先、記憶持久、多 agent OS 抽象）,透過 MCP 貢獻保持能見度 |
| Claude Code 生產力未達預期 | 低 | 高 | 縮減功能,保住核心閉環 |
| 兩人時間被本業稀釋 | 高 | 高 | 嚴格每週 20-25 小時投入下限,低於即重新規劃 |

---

## 🎯 3 個月後的狀態

**Alpha 版本 Nous 應具備**：

✅ 桌面應用（macOS + Windows + Linux）
✅ 與 Claude 對話,記憶跨 session 持久
✅ 上傳文件建立個人知識庫,Claude 能查詢
✅ 3 個專業 Agent（研究、寫作、摘要）自動分工
✅ 5+ MCP 整合（檔案、GitHub、Gmail、Notion、瀏覽器）
✅ Token 消耗與成本儀表板
✅ 基礎權限與安全（OS keychain、稽核日誌）
✅ 可在 GitHub 公開、有文件、有 Discord、5-10 位 alpha 使用者

**這個階段 Nous 已經是個有差異化的產品**,足以:
- 在 Hacker News / Twitter / Product Hunt 獲得關注
- 吸引早期貢獻者加入開發
- 對 Anthropic 生態展示作為「第三方 Claude OS 層」的可能性
- 為 Month 4-6 的公開 Beta 與商業化探索奠定基礎

---

## 📌 後續路線圖 (Post-Alpha, Month 4+)

- Month 4：回饋驅動迭代 + 公開 Beta
- Month 5-6：Plugin SDK、Agent marketplace、雲端同步（可選）
- Month 7+：商業化探索（開源核心 + 託管雲端 / 企業功能）

但這些都等 Month 3 Alpha 回饋來了再規劃——**不要提前優化尚未存在的問題**。

---

**最後提醒**：這份時程非常激進,但可行。關鍵不在技術,而在**紀律**—— 不擴張 scope、不重建輪子、不完美主義、不閉門造車。

每週五問自己一個問題:**「如果今天就要給朋友 demo,我最驕傲的是什麼?最丟臉的是什麼?」** 這個答案會告訴你下週該做什麼。
