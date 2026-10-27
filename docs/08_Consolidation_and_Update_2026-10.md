<!-- bilingual: source=zh-TW -->

> [繁體中文](08_Consolidation_and_Update_2026-10.md) | [English](08_Consolidation_and_Update_2026-10.en.md)

# Nous — 2026-10 匯總與更新（規劃基線 v0.2）

版本：v0.2 · 快照日期：2026-10-07 · 歷史效力說明更新：2026-10-24。本文件保留 10-07 的盤點與提案，不代表今日程式狀態。架構修正仍須經 spike／ADR 確認；本次文件整理沒有把任何提案改標為已決。

> **2026-10-24 閱讀導覽**：repo 現已有 `prototype/ambient-shell` 可執行原型，以 `1f44c6b`（2026-10-23）為程式基準。今日程式與缺口以 [實作現況](Current_Implementation_Status.md) 為準，後續功能優先序與 Quest 分期見 [功能擴充評估](13_Feature_Expansion_Assessment_2026-10-24.md)。原型採 Node HTTP、SSE、TypeScript、Vite 與 Electron，有多引擎、雙路語音、任務／成果及感測；這些不代表已通過 G0–G3。
>
> 下文 §0–9 均保留為 **2026-10-07 歷史快照**。其中「實作為 0」、未開始、未決、字數、兩個 commit、模型價格、外部專案狀態及 14 天排程均只指當時，本次未重新查證外部資料。今日不應照舊表重建 PR-00／PR-01；先延伸現有原型，補驗收與整合缺口。F0–F10、Q0–Q4 不取代既有 gate。

> 2026-10-07 的歷史閱讀順序：本文件（當時現況與修正）→ [06](06_Ambient_Voice_Gaze_Experience.md)／[07](07_Ambient_Implementation_and_Acceptance.md)（最新產品規格與驗收）→ 01–05（基礎設計與歷史快照）。當時的設計衝突優先順序：**08 的已決項 > 06–07 > 01–05**；08 標為「提案」者不覆蓋既有文件，直到對應 ADR 通過。

---

## 0. 2026-10-07 一頁摘要

1. **當時進度**：33 天內（2026-09-04 → 10-07）完成 7 份設計文件與 2 個 commit；**截至 2026-10-07 實作進度為 0**。按原「3 個月 Alpha」計畫，10-07 應在 Week 5，當時尚未開始 Week 1。此盤點不適用 10-24 的可執行原型。
2. **產品方向已收斂**：09-16 的更新把 Nous 定為「電子腦待機 → 語音提出需求 → Agents 執行 → 按需成果 → 看＋說繼續操作」，沒有 App、沒有常駐 Dashboard。
3. **生態有 4 個會改變架構的變化**：Letta V1 API server 已退役（02/03 的記憶層整合路線失效）；MCP 2026-07-28 規格轉為無狀態並正式納入 **MCP Apps**（沙盒化 UI）與 **Tasks**（長任務）；Anthropic 的記憶模型收斂為「路徑定址的 Markdown 檔」；第三方 Agent SDK 產品須使用 API key，不能借用 claude.ai 登入額度。
4. **建議修正**：記憶層改為本地 Markdown 記憶檔 + SQLite 索引；成果 Surface 改為 MCP Apps 相容 host；Task 模型對齊 MCP Tasks；觀測改為本地 OTel、Langfuse 改為可選匯出。
5. **新排程**：以 gate 取代週次。若 2026-10-12 開工、每週 20–25 小時，G3（可邀請 Alpha）預估 **2027-01-24**，屬估計值，G2 視線實測是最大變數。

---

## 1. 時間線

| 日期 | 事件 | 產出 |
|---|---|---|
| 2026-09 初 | 提出命題：給 Claude 專用的作業系統 | 選定 Cognitive OS、通用產品、12 個月 |
| 2026-09 初 | 深度研究 | 01 完整藍圖（7 模組、9 層 OS 映射、12 個月） |
| 2026-09 初 | OSS 整合策略 | 02 元件對應表、03 三個月加速路徑 |
| 2026-09 初 | 「沒有固定 UI」的延伸 | 04 生成式互動系統 |
| 2026-09-04 | Initial commit（`dcecb59`） | 01–05、README、SETUP、.gitignore |
| 2026-09-16 | 互動規格更新（`3ff01ee`） | 06 電子腦／語音／視線、07 開發與驗收；01–05 加上覆蓋註記 |
| 2026-09-22 | Anthropic 發布 Claude Opus 5.5 | 本文件 §4 |
| 2026-10-07 | 本次匯總 | 08、CLAUDE.md、README／docs 索引更新 |

---

## 2. 2026-10-07 現況盤點

### 2.1 文件清單（2026-10-07 實算）

以 Python 計算 Unicode 字元，排除空白；CJK 為中日韓統一漢字數。

| 文件 | 非空白字元 | 定位 | 目前效力 |
|---|---:|---|---|
| 01 完整技術藍圖 | 18,100 | 7 模組、技術選型、12 個月 | 基礎架構有效；Shell、時程、模型名稱已過時 |
| 02 OSS 元件對應表 | 10,838 | 整合優先策略 | 策略有效；Letta、Langfuse 部署方式需修正（§5） |
| 03 三個月加速路徑 | 8,940 | 週級計畫 | 已被 07 gate 取代，僅作底層工作參考 |
| 04 生成式互動系統 | 11,672 | 意圖中心、6 層架構、技能晉升 | 有效；Runtime 路徑 B 建議改走 MCP Apps |
| 05 進度彙總 v1 | 14,664 | 09 月初快照 | 歷史快照 |
| 06 電子腦／語音／視線 | 7,819 | 最新產品規格 | **現行規格** |
| 07 開發與驗收 | 7,837 | 契約、prompt、PR-01–08、AC-01–18 | **現行執行依據** |
| **01–07 合計** | **79,870** | — | 其中 CJK 漢字 28,016 |

**更正**：先前對話稱 01–04「約 8.5 萬字元」。該數字是在 POSIX locale 下用 `wc -m` 量到的**位元組數**，不是字元數。01–04 在該次盤點實際為 **49,550 個非空白字元**（CJK 漢字 15,282）。

### 2.2 已完成

- 產品定位、命名（Nous）、OS 抽象映射、7 模組設計、17 項架構決策（01）。
- OSS 整合策略與授權避雷（02）。
- 生成式互動系統：意圖解析、能力圖譜、認知輪廓、呈現設計 Agent、生成執行、技能晉升（04）。
- 電子腦待機、無 App、語音優先、webcam 視線、按需呈現、Shell／Task 狀態分離（06）。
- JSON 資料契約、Agent prompt、PR-01–08、G0–G3、AC-01–18、可手算 fixture、量測方法（07）。
- Magic Moment 實質已選定：07 §6.1 的「三方案比較 → 注視 B 改成本 → 保存／喚回」。

### 2.3 當時尚未完成

| 項目 | 來源 | 狀態 |
|---|---|---|
| 可執行程式碼 | 03、07 | 10-07 未開始；今日已有 prototype，正式 monorepo、Tauri 與 Python kernel 另見現況文件 |
| `CLAUDE.md` 開發憲法 | 05 優先 4 | **本次新增 v0.1** |
| 敘事文件（elevator pitch、persona、positioning） | 05 優先 1 | 未開始 |
| 商標／網域查核 | 05 P0 | 未開始 |
| repo 公開時機 | 05 P0 | 未決 |
| 目標測試硬體清單（機型、麥克風、攝影機、螢幕） | 07 §1 | 未記錄 |
| 視線與語音 PoC | 06 §4、07 PR-03／05 | 未開始 |

---

## 3. 決策日誌 v2

### 3.1 沿用（01 的 17 項）

| # | 決策 | 狀態 |
|---|---|---|
| D1 | Cognitive OS，非 Agentic OS | 沿用 |
| D2 | 通用產品 | 沿用 |
| D3 | 3 個月 Alpha | **由 D20 取代** |
| D4 | 產品名 Nous | 沿用；商標未查 |
| D5 | Claude 作為 kernel | 沿用；模型版本見 §4.1 |
| D6 | Tauri 2.x | 沿用；需 spike 驗證 WebView 麥克風／攝影機權限 |
| D7 | 記憶層 Letta | **待改，見 P1** |
| D8 | 知識層 LightRAG | 沿用；改為延後到 G1 之後 |
| D9 | Claude Agent SDK | 沿用；注意 §4.2 的授權限制 |
| D10 | TypeScript 為主 | 沿用 |
| D11 | SQLite + sqlite-vec | 沿用；sqlite-vec 仍為 pre-v1 |
| D12 | Apache-2.0 | 沿用 |
| D13 | Fork agmmnn/tauri-ui | 降級為參考；電子腦殼不需要現成 dashboard 骨架 |
| D14 | assistant-ui | 降級為按需對話／工具 UI 元件，不作首頁 |
| D15 | Langfuse | **待改，見 P5** |
| D16 | 生成式動態 UI | 沿用；由 06 細化 |
| D17 | Khoj 只參考不 fork | 沿用 |

### 3.2 2026-09-16 新增（已決）

| # | 決策 | 依據 |
|---|---|---|
| D18 | 待機只有電子腦；無 App、圖示、啟動器、常駐側欄或 Dashboard | 06 §1–2 |
| D19 | 語音從「延後」改為 G1 必做；webcam 視線改為 G2 驗證大區塊 | 06 §3–4 |
| D20 | 以 G0–G3 驗收 gate 取代固定 12 週 | 07 §5 |
| D21 | 確定性 Presentation Policy，每個 Surface 必須有 `visibility_reason` | 06 §2.2 |
| D22 | 看＝指向、說＝動作；注視與眨眼不構成授權 | 06 §4.4 |
| D23 | Shell 狀態與 Task 狀態分離並各自持久化 | 06 §5 |
| D24 | Surface 暫態、Artifact 可保存並帶版本 | 06 §2.3 |
| D25 | 任意 React／Python 生成在沙盒驗收前不啟用 | 06 §6 |
| D26 | 技能晉升改為背景記錄、按需提出，不新增常駐 widget | 04、06 |

### 3.3 2026-10-07 提案（待 ADR）

| # | 提案 | 理由 | 驗證方式 |
|---|---|---|---|
| P1 | 記憶層改為本地「路徑定址 Markdown 記憶檔」+ SQLite FTS5／sqlite-vec 索引 + 版本紀錄；Mem0 為備援 | Letta V1 server 退役；Anthropic 的記憶模型同為路徑檔案；檔案使用者可讀、可匯出 | ADR-001 + 20 個記憶回歸場景 |
| P2 | 成果 Surface 實作為 **MCP Apps 相容 host**（`ui://`、沙盒 iframe、CSP 預設拒絕、宣告式權限） | 04 的 Capability Manifest 與 06 的受控 renderer 已有標準可對齊；第三方 MCP server 的 UI 可直接呈現 | Spike S4 |
| P3 | Task 狀態對齊 MCP Tasks 擴充（`taskId`、輪詢、輸入更新、斷線後可續） | 06 §5 的 Task 狀態機與標準一致，減少自訂協議 | ADR-003 |
| P4 | MCP client 以 2026-07-28 規格為目標（無狀態、`server/discover`、OAuth 2.1） | 新規格不相容舊 session 模型；新專案直接採新版 | 契約測試 |
| P5 | 觀測改為本地 OpenTelemetry（JSONL／SQLite），Langfuse 為可選匯出，不隨桌面版打包 | 桌面本地優先不適合捆綁伺服器級觀測堆疊；Langfuse 仍 MIT 且可自架 | ADR-005 |
| P6 | 語音堆疊候選：sherpa-onnx（喚醒、VAD、串流 ASR、TTS）+ Breeze-ASR-25（最終轉寫） | 單一本地依賴涵蓋 G1；Breeze 針對台灣華語與中英混用 | Spike S2 |
| P7 | 視線候選：MediaPipe Face Landmarker + 自建個人校正迴歸；GazeFollower、WebGazer 僅研究參考 | 授權：GazeFollower 為 CC BY-NC-SA，WebGazer 為 GPLv3 且不保證更新 | Spike S3 |
| P8 | 模型路由：Opus 5.5 規劃／困難推理，Sonnet 系列為一般 worker，快速模型做意圖分類；以 Models API 動態列出，不寫死型號 | 型號半年內已更替 3 輪 | 成本基準測試 |
| P9 | 知識層（LightRAG）延後到 G1 之後接入；G1 只需 07 fixture 的受控計算工具 | 減少 G0–G1 依賴面 | 排程 |

---

## 4. 生態變化（2026-06 → 2026-10）與影響

### 4.1 Anthropic 模型

| 日期 | 事件 | 對 Nous 的影響 |
|---|---|---|
| 2026-09-01 | Claude Fable 5.1／Mythos 5.1（1M context，$10/$50 per MTok） | 最高能力層成本高，不作預設 |
| 2026-09-22 | **Claude Opus 5.5**（1M context，128k 輸出，$4/$20 per MTok；token 單價比 Opus 5 的 $5/$25 低 20%，官方稱整體運行成本低約 40%） | 01 的「Opus/Sonnet 4.6」改為 Opus 5.5 規劃層 |
| 2026-09-28 | Claude Sonnet 5.5（1M context） | worker 候選；定價以官方頁為準 |
| 2026-09-30 | Sonnet 4.5 宣告淘汰（2026-11-30 退役） | 印證 P8：型號不可寫死 |

**成本估算更新**（假設：每次任務 30K input、3K output、不計 cache、每月 600 次任務）：

| 模型 | 每次任務 | 每月 600 次 |
|---|---:|---:|
| Opus 5.5（$4/$20） | $0.18 | $108 |
| Sonnet 5（$2/$10） | $0.09 | $54 |
| Fable 5.1（$10/$50） | $0.45 | $270 |

prompt cache 命中會明顯下降成本；實際數字以 G1 量測為準。01 的「$70–260/月」區間仍大致成立。

### 4.2 Claude Agent SDK

- 提供 Claude Code 同款工具、hooks、subagents、MCP、permissions、sessions（resume／fork）、skills、plugins，Python 與 TypeScript。
- **限制**：未經核准，第三方產品不得提供 claude.ai 登入或其額度；Nous 使用者需自備 API key 或由 Nous 計費。這是商業模式與 onboarding 的硬性條件。
- 品牌：可用「Nous, Powered by Claude」；不得使用「Claude Code」字樣或仿其視覺。
- Managed Agents 提供託管 agent loop、self-hosted sandbox、memory stores；可作未來雲端版選項，不影響本地優先的 Alpha。

### 4.3 記憶的業界收斂

Managed Agents memory stores：記憶是以路徑組織的文字檔（如 `/preferences/formatting.md`），掛載為目錄、用一般檔案工具讀寫、每次變更產生不可變版本；單檔上限 100 kB、每 store 上限 10,000 份。這與 01 的「Markdown 為檔案系統、SQLite 為索引」及「資料主權」原則一致，支持 P1。

### 4.4 MCP 2026-07-28

- 移除 initialize 握手，請求自帶 `_meta`，無狀態、無 session id；能力查詢改 `server/discover`。
- HTTP+SSE 擬淘汰，改 Streamable HTTP；stdio 保留。
- OAuth 2.1／OIDC 成為必要；Dynamic Client Registration 擬淘汰。
- 新擴充：**MCP Apps**（伺服器提供沙盒 HTML／JS UI，iframe 與 host 以 postMessage JSON-RPC 溝通，CSP 預設 `default-src 'none'`，權限於 `_meta.ui.permissions` 宣告）；**Tasks**（長任務 `taskId`，可輪詢與續接）。
- Roots、Sampling、Logging 擬淘汰，最早 2027-07-28 移除。

### 4.5 OSS 元件狀態

| 元件 | 2026-09 文件記載 | 2026-10 查證 | 動作 |
|---|---|---|---|
| Letta | 21.6K⭐，Docker + REST API 作記憶層 | ~25K⭐；主 repo 轉為封存，V1 API server 退役，開發移至 `letta-code`（agent harness、App Server、WebSocket／OpenAI 相容 API） | **退出主選**，改 P1 |
| Mem0 | 48K⭐ 備選 | 66.7K⭐，Apache-2.0，可自架，支援 Anthropic | 保留為 P1 備援 |
| LightRAG | 32.8K⭐ | 39.3K⭐，MIT；新增 Docling／MinerU 整合、刪文件自動重建圖譜、reranker、Langfuse tracing | 沿用，延後接入（P9） |
| sqlite-vec | 6K+⭐ | 8.2K⭐，Apache-2.0/MIT，pre-v1；新增 DiskANN、IVF 索引 | 沿用，鎖版本 |
| assistant-ui | 5K+⭐ | 11.4K⭐，MIT；支援 tool call 渲染與內嵌審批 | 降級為按需元件 |
| Langfuse | 25K+⭐，Docker 一鍵起 | 2026-01 被 ClickHouse 收購；官方表示維持 MIT、可自架、roadmap 不變 | 可選匯出（P5） |
| sherpa-onnx | — | 本地 KWS、VAD、串流／非串流 ASR、TTS；支援 macOS／Windows／Linux 與 Tauri | 新增候選（P6） |
| Breeze-ASR-25 | — | MediaTek Research，Whisper-large-v2 微調，Apache-2.0；台灣華語與中英混用；有 whisper.cpp GGML 與 faster-whisper 轉檔 | 新增候選（P6） |
| GazeFollower | — | webcam gaze，v1.1.0（2026-09-16），**CC BY-NC-SA 4.0** | 僅參考 |
| WebGazer | 06 已列 | GPLv3，官方公告 2026-02-24 起不保證更新 | 僅參考 |

### 4.6 競爭環境

| 對手 | 已具備 | 與 Nous 重疊 |
|---|---|---|
| Claude 官方 App | 跨對話記憶（路徑檔案）、Artifacts 與型別化輸出、排程任務、電腦操作、Chrome 擴充 | 高：記憶、生成式成果、背景任務 |
| Windows 11 Copilot | 語音喚醒、Copilot Vision、Agent Workspace（Insider）；Microsoft 公開談「agent 驅動的 Windows」 | 中：OS 層語音 agent |
| MCP Apps 生態 | 標準化的對話內 UI | 中：生成式 Surface |

**定位修正**：「有記憶的 Claude」與「生成式 UI」已不足以構成差異。Nous 的差異應集中在：

1. **無 App 的 Ambient Shell**：待機只有電子腦，看＋說取代滑鼠的核心流程。
2. **使用者擁有的本地記憶**：可讀、可改、可匯出的 Markdown 檔，不綁單一雲端。
3. **信任作為架構**：確定性 Presentation Policy 與 Action Gate 獨立於模型，注視不等於授權、mock 不等於能力。這是與《可信任的控制》最直接的連結點。
4. **Claude-native 但不寫死型號**：Agent SDK + MCP 標準，隨 Anthropic 更新受益而非被覆蓋。

---

## 5. 更新後的元件對應（只列差異）

| 模組 | 原選型（02） | 新建議 | 狀態 |
|---|---|---|---|
| A 記憶 | Letta Docker + REST | 本地 `~/.nous/memory/**/*.md` + SQLite FTS5／sqlite-vec 索引 + 版本表；Mem0 備援 | 提案 P1 |
| B 知識 | LightRAG（G1 前接入） | LightRAG（G1 後接入） | 提案 P9 |
| C 編排 | Claude Agent SDK | 同；Task 狀態對齊 MCP Tasks | 提案 P3 |
| D 工具 | MCP 官方 servers | 同；client 以 2026-07-28 為目標 | 提案 P4 |
| E Shell | tauri-ui fork + assistant-ui 首頁 | Tauri 電子腦殼 + MCP Apps 相容 Surface host；assistant-ui 只做按需元件 | D18、P2 |
| E 語音 | 未定 | sherpa-onnx + Breeze-ASR-25（whisper.cpp） | 提案 P6 |
| E 視線 | 未定 | MediaPipe Face Landmarker + 自建校正 | 提案 P7 |
| G 觀測 | Langfuse Docker | 本地 OTel；Langfuse 可選匯出 | 提案 P5 |

---

## 6. 重新排程

> 以下排程是 2026-10-07 的估計，並非目前開工指令或交付承諾。實作先盤點現有 `prototype/ambient-shell`；保留或遷移架構須另有決策，硬體 gate 仍需實測。

### 6.1 新增前置批次與 spike

| 批次 | 內容 | 驗收 |
|---|---|---|
| **PR-00** | monorepo 骨架（pnpm workspaces）、`packages/shared/schemas` 空殼、CI（lint／test）、`docs/validation/` 範本、記錄目標測試硬體 | CI 綠燈；硬體清單入庫 |
| S1 | Tauri WebView 麥克風／攝影機權限（先 macOS） | 授權、拒絕、撤銷三種情境可重現 |
| S2 | sherpa-onnx 喚醒 + Breeze-ASR-25 延遲與準確度 | 07 §6.4 量測格式，30 次樣本 |
| S3 | MediaPipe 三區選取 | 07 §6.3，至少 1 人 30 次 |
| S4 | 在 Tauri 內跑一個 MCP Apps `ui://` 資源 | 沙盒、CSP、postMessage 往返成功 |

S1 在 PR-00 週內完成；S2 併入 G1 前段；S3 併入 G2 前段；S4 併入 G0。

### 6.2 Gate 時程估計

前提：2026-10-12（週一）開工、每週 20–25 小時、Claude Code 負責主要實作。週數為估計，不是承諾。

| Gate | 內容（07 批次） | 估計週數 | 估計區間 |
|---|---|---:|---|
| PR-00 | 骨架、CI、S1 | 1 | 2026-10-12 → 10-18 |
| G0 | PR-01–02：電子腦、Shell 狀態機、契約、Presentation Policy、S4 | 2 | 10-19 → 11-01 |
| G1 | PR-03–04：真實語音 → Agent → 成果閉環、S2 | 4 | 11-02 → 11-29 |
| G2 | PR-05–06：視線校正、三區、看＋說融合、S3 | 5 | 11-30 → 2027-01-03 |
| G3 | PR-07–08：外部動作、去重、鎖屏、硬體驗收 | 3 | 2027-01-04 → 01-24 |

G2 不過時的降級路徑（06 §4.5 已定）：以語音編號完成同一流程，先以「語音版 Alpha」邀請使用者，視線持續研發。

---

## 7. 開放問題（更新）

| 優先 | 問題 | 狀態 | 建議 |
|---|---|---|---|
| P0 | 「Nous」商標與網域 | 未查 | 開工前完成；備選 Thymos |
| P0 | repo 公開時機 | 未決 | G0 通過（有可見電子腦 demo）時公開 |
| P0 | 目標測試硬體 | 未記錄 | PR-00 寫入 `docs/validation/hardware.md` |
| P0 | ADR-001 記憶層 | 新增 | 開工第一週決定，影響 PR-02 契約 |
| P1 | API key 與計費模式 | 新增（§4.2） | Alpha 期使用者自備 key |
| P1 | 平台優先 | 06 已選 macOS | 沿用 |
| P1 | Alpha 名單 | 未開始 | G1 後開始招募 |
| P2 | Discord、build in public 尺度 | 未決 | G0 公開 repo 時一併決定 |
| P2 | 敘事文件 | 未開始 | 以 §4.6 四點差異為骨架 |

---

## 8. 2026-10-07 當時計畫的接下來 14 天

1. 商標／網域查核（P0）。
2. 寫 ADR-001（記憶層），在 P1 與 Mem0 間定案。
3. 記錄測試硬體（機型、OS、麥克風、攝影機、螢幕、縮放）。
4. 當時計畫先跑 PR-00 + S1，再啟動 PR-01–02。今日改先依 07 §4.3 盤點既有原型，再選一個驗收缺口延伸。
5. G0 結束時錄第一支 30 秒電子腦待機 → 聆聽 → 成果的 demo（可用 fixture，需標示為 mock）。

---

## 9. 2026-10-07 更新內容

- 新增本文件 `docs/08_Consolidation_and_Update_2026-10.md`。
- 新增根目錄 `CLAUDE.md` v0.1（開發 agent 的規則與禁止事項）。
- 更新 `README.md`：狀態、技術棧、文件表。
- 更新 `docs/README.md`：加入 08、閱讀順序。
- 於 02、03 開頭加註指向本文件的修正說明；正文未改。

---

## 來源（查閱日期 2026-10-07）

- [Claude Platform release notes](https://platform.claude.com/docs/en/release-notes/overview.md)
- [Anthropic Releases Claude Opus 5.5 — Thurrott](https://thurrott.com/a-i/anthropic/341913/anthropic-releases-claude-opus-5-5)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk)
- [Managed Agents memory stores](https://platform.claude.com/docs/managed-agents/memory)
- [MCP 2026-07-28: What's changing — AAIF](https://aaif.io/blog/mcp-2026-07-28-whats-changing-and-how-to-migrate)
- [MCP Apps: the iframe is the agent — DEV](https://dev.to/rcsxplatform/mcp-apps-the-iframe-is-the-agent-40k9)
- [letta-ai/letta](https://github.com/letta-ai/letta)、[Letta App Server quickstart](https://docs.letta.com/platform/app-server/quickstart)
- [mem0ai/mem0](https://github.com/mem0ai/mem0)
- [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG)
- [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)
- [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui)
- [Langfuse joins ClickHouse](https://langfuse.com/blog/joining-clickhouse)
- [sherpa-onnx README](https://cdn.jsdelivr.net/gh/k2-fsa/sherpa-onnx@master/README.md)
- [Breeze-ASR-25 — Hugging Face](https://huggingface.co/MediaTek-Research/Twister)
- [GazeFollower — PyPI](https://pypi.org/project/gazefollower)
- [Microsoft hints at a future AI agent-driven Windows — Redmond](https://redmondmag.com/blogs/generationai/2026/01/microsoft-hints-at-a-future-ai-agent-driven-windows.aspx)
