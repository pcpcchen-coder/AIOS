<!-- bilingual: source=zh-TW -->

> [繁體中文](04_Generative_Interaction_System.md) | [English](04_Generative_Interaction_System.en.md)

# Nous 生成式互動系統設計稿

> **2026-10-24 閱讀導覽**：目前程式與缺口以 [實作現況](Current_Implementation_Status.md) 為準；新功能的價值、依賴、MVP 與 roadmap 見 [功能擴充評估](13_Feature_Expansion_Assessment_2026-10-24.md)。本文保留早期設計，不代表已實作或已通過驗收。產品紅線與 G0–G3 仍依 [06](06_Ambient_Voice_Gaze_Experience.md)、[07](07_Ambient_Implementation_and_Acceptance.md) 及後續明確修訂執行；新評估中的 F0–F10、Q0–Q4 不取代這些 gate。
>
> 程式基準為 `1f44c6b`（2026-10-23）。可執行原型位於 `prototype/ambient-shell`，採 Node HTTP、SSE、TypeScript、Vite 與 Electron。本文的 Tauri、React、Python kernel、Agent SDK、長期記憶及生成工具等屬目標設計；模型、價格、市場、stars 與外部生態數據是原始撰寫時的資料，本次未重新查證，採用前須另查。

> **2026-09-16 互動規格更新**：電子腦待機、無 App、語音優先、webcam 視線選取及按需呈現，依 [06 體驗規格](06_Ambient_Voice_Gaze_Experience.md) 與 [07 開發驗收](07_Ambient_Implementation_and_Acceptance.md)。本文其餘底層設計保留；舊時程與舊介面描述僅供歷史參考，衝突時以 06–07 為準。

> **核心命題**:Nous 沒有固定的 UI。每次互動,AI 根據「你的意圖 × 你的認知偏好 × 當下可用的能力」即時生成「工具 + 呈現」。你不再選擇 App,你只表達意圖。

---

## 1. 典範轉移

### 舊世界(應用中心)
```
人類 → 選擇應用(Word)→ 操作應用 → 產出文件
```
人類學習每個 App 的固定介面,每次任務在預先設計好的工具裡執行。

### 新世界(意圖中心)
```
人類 → 表達意圖(「我要一份文件」)
          ↓
AI 理解意圖 → 設計工具 + 設計呈現 + 考慮認知吸收
          ↓
生成臨時工具(或複用既有)→ 產出 + 以最佳方式呈現給人類
```

**關鍵差異**:
| 維度 | 應用中心 | 意圖中心 |
|---|---|---|
| 學習成本 | 人學 App | AI 學人 |
| UI 生命週期 | 永恆(安裝後存在) | 暫態(為當次互動生成) |
| 設計者 | 人類設計師預設 | AI 為當次情境設計 |
| 能力邊界 | App 預定能力 | AI 能組合的一切能力 |
| 呈現形式 | 固定(文字/表格/UI)| 動態(AI 選最適合當次的模態) |

---

## 2. 五大設計原則

### 原則一:意圖優於應用(Intent over Application)
Nous 永遠不問「你要用什麼工具」,只問「你要達成什麼」。「產生一份文件」的背後可能是:報告、摘要、備忘錄、計畫書、信件——每一個最適合的呈現完全不同。

### 原則二:呈現即設計交付物(Presentation is a Design Deliverable)
AI 不只是「產出內容」,還要「設計如何呈現這個內容」。一份財務報告可以是:表格?互動 dashboard?口述 podcast?條列摘要?——**決定用哪一種,是 AI 的設計工作**。

### 原則三:工具即答案(Tool as Answer)
當問題複雜到靜態文字無法承載,AI **生成一個工具**作為答案。例如:
- 問:「這份合約風險在哪?」→ 回答可能是一個**互動式風險地圖**,點擊條款看解釋
- 問:「幫我決定買哪台筆電」→ 回答可能是一個**即時比較表**,滑桿調整權重

### 原則四:認知適配(Cognitive Fit)
呈現方式必須符合人類的認知吸收方式,基於:
- **多媒體學習理論(Mayer)**:同時給視覺+語音比只給一種更易吸收
- **認知負荷理論(Sweller)**:複雜資訊必須分層遞進,不能一次倒出
- **個人認知輪廓**:這位使用者偏好視覺還是文字?密集還是漸進?

### 原則五:暫態預設、持久為例外(Ephemeral by Default)
每個生成的工具/UI 預設是**為這次互動而生**,互動結束即消失。**只有被重複使用的工具才會晉升為持久技能**(skill promotion)。這避免了 UI 膨脹。

---

## 3. 系統架構

```
┌─────────────────────────────────────────────────────────────┐
│                        人類使用者                              │
│              (語音 / 文字 / 手勢 / 多模態輸入)                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: 意圖理解層 (Intent Parser)                           │
│  - 解析表面請求 → 萃取真實意圖                                  │
│  - 分類:一次性產出 / 持續工具 / 重複工作流                       │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Layer 2a     │ │ Layer 2b     │ │ Layer 2c     │
│ 能力圖譜      │ │ 認知輪廓      │ │ 情境記憶      │
│ Capability   │ │ Cognitive    │ │ (來自 Nous    │
│ Graph        │ │ Profile      │ │  Memory 層)   │
│              │ │              │ │              │
│ 系統當下有    │ │ 這位使用者    │ │ 過去的對話、  │
│ 什麼硬體、    │ │ 的認知偏好、  │ │ 偏好、結果   │
│ 工具、API?   │ │ 吸收模式?    │ │ 回饋         │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │
       └────────────────┼────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: 呈現設計師 Agent (Presentation Designer)            │
│  - 綜合意圖 + 能力 + 認知 → 產出「互動計畫」(Interaction Plan)  │
│  - 決定:模態、工具、互動性、分層遞進、回饋迴路                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 4: 生成執行層 (Generative Runtime)                     │
│  - 生成程式碼(TS/Python/Shell)                              │
│  - 生成 UI 元件(React/SVG/Canvas/Audio)                     │
│  - 生成內容(文字/圖表/音訊)                                  │
│  - 在沙盒中執行、流式輸出                                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 5: 呈現層 (Rendering Surface)                         │
│  - 螢幕繪製 / 音訊播放 / 觸覺回饋                              │
│  - 漸進式揭露(progressive disclosure)                        │
│  - 互動式修正(「不對,換成表格」→ 即時重塑)                    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Layer 6: 晉升管線 (Skill Promotion)                         │
│  - 暫態工具被使用 N 次 → 詢問是否晉升為持久技能                 │
│  - 持久技能被一段時間未用 → 降級或封存                          │
│  - 每位使用者緩慢成長的個人化工具庫                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 六大核心子系統

### 4.1 意圖理解層(Intent Parser)

**職責**:把人類的表面請求解析為結構化意圖。

**關鍵輸出**(Intent Record):
```yaml
raw_input: "幫我整理今天開會討論的重點"
parsed_intent:
  goal_type: one_shot_artifact       # 一次性產出 / persistent_tool / recurring_workflow
  domain: meeting_notes
  inputs_needed:
    - audio_recording | text_transcript
  deliverable: structured_summary
  urgency: immediate
  audience: self                      # 誰要看這個?
  expected_form: unspecified          # 人未指定,AI 決定
```

**設計重點**:
- **不強迫人類精確表達**——模糊意圖由 AI 追問(但只追問必要的)
- **區分「一次性」vs「重複」**——決定是否要考慮建立持久工具
- **推斷受眾**——「給自己看」跟「給老闆看」的呈現完全不同

### 4.2 能力圖譜(Capability Graph)

**職責**:AI 知道當下系統「能做什麼」的結構化知識。

**圖譜內容**:
```
Capabilities/
├── Hardware/
│   ├── Display (resolution, color depth, refresh)
│   ├── Audio Out (speakers, TTS engines)
│   ├── Audio In (microphone, STT engines)
│   ├── Camera
│   └── Input (keyboard, touch, stylus)
├── Software Tools/
│   ├── File I/O (read, write, monitor)
│   ├── Code Execution (Python sandbox, JS runtime)
│   ├── Rendering (HTML, SVG, Canvas, WebGL)
│   ├── Charts (recharts, d3, plotly)
│   └── Document Generation (docx, pdf, xlsx)
├── External Services (via MCP)/
│   ├── Gmail, GitHub, Notion, ...
│   └── (dynamic, added by user)
├── Knowledge (via Nous knowledge layer)/
│   ├── Personal docs
│   ├── Work docs
│   └── Conversation history
└── Memory (via Nous memory layer)/
    ├── User preferences
    ├── Past interactions
    └── Skill library
```

**設計重點**:
- **AI 對硬體的「熟悉度」**來自這個圖譜——它知道有音訊輸出,所以「口述摘要」是可行的
- **圖譜可擴展**——新 MCP server 安裝後自動註冊為新能力
- **能力組合**——複雜任務是多個能力的組合,AI 做組合規劃

### 4.3 認知輪廓(Cognitive Profile)

**職責**:為每位使用者建模「最適合的呈現模式」,並持續學習。

**輪廓結構**:
```yaml
user_cognitive_profile:
  modality_preference:
    visual: 0.8          # 偏好視覺程度
    auditory: 0.3        # 偏好聽覺程度
    tactile: 0.1         # 偏好互動操作程度

  information_density:
    preferred: medium    # sparse / medium / dense
    max_items_per_screen: 7

  disclosure_pattern:
    preferred: progressive   # all_at_once / progressive / on_demand

  comprehension_style:
    prefers_examples_first: true
    prefers_abstract_first: false
    bullet_vs_prose: bullet

  domain_expertise:
    programming: expert
    finance: novice
    design: intermediate

  time_preferences:
    morning: high_bandwidth   # 早上可以吸收複雜內容
    evening: low_bandwidth    # 晚上只給簡單摘要

  feedback_history:
    - interaction_id: xxx
      generated_form: interactive_chart
      user_rating: positive
    - interaction_id: yyy
      generated_form: dense_table
      user_rating: "太多資訊,改成卡片"
```

**如何建構**:
1. **冷啟動**:前 10 次互動,提供多種呈現給使用者選,記錄選擇
2. **被動觀察**:使用者閱讀時間、滾動、點擊模式
3. **主動詢問**:每 20 次互動的某次,問一次「這個呈現有幫到你嗎?」
4. **Claude Agent SDK hooks**:每次呈現後記錄使用者的下一步(重問?滿意?修正?)

**認知負荷計算**:
呈現設計師 Agent 會計算每個候選方案的 **預估認知負荷**:
```
cognitive_load = (
  content_complexity * density_factor
  - modality_match_bonus
  - expertise_bonus
  + interaction_cost
)
```
選擇負荷最低但仍能完整傳達意圖的方案。

### 4.4 呈現設計師 Agent(Presentation Designer)

**職責**:最關鍵的子系統。接收 Intent + Capabilities + Cognitive Profile,輸出**互動計畫**。

**Agent 的 system prompt 核心**:
> 你是 Nous 的呈現設計師。你不產生內容,你設計「內容如何被感知」。你的輸出是一份互動計畫(Interaction Plan),告訴執行層:用什麼模態、什麼工具、什麼節奏、什麼層次遞進、什麼時候讓人介入。你的決策依據是多媒體學習理論、認知負荷理論、以及這位使用者的個人認知輪廓。

**輸出格式**(Interaction Plan):
```yaml
interaction_plan:
  plan_id: plan_abc123

  presentation_mode: hybrid          # text | chart | interactive | audio | hybrid

  primary_artifact:
    type: interactive_dashboard      # 或 document / chart / audio_narration / 3d_view
    tool: generate_react_component   # 要生成什麼形式的工具
    estimated_generation_time: 8s
    estimated_cognitive_load: medium

  secondary_artifacts:                # 可選的補充呈現
    - type: audio_narration
      trigger: user_request          # 若使用者要求口述版
    - type: printable_pdf
      trigger: explicit_save

  disclosure_layers:                  # 分層遞進
    layer_1:
      shows: "一句話結論 + 關鍵數字"
      trigger: immediate
    layer_2:
      shows: "三個主要發現 + 視覺化"
      trigger: explicit_expand_command
    layer_3:
      shows: "完整分析 + 原始資料"
      trigger: explicit_deep_dive_command

  interaction_affordances:            # 互動性設計
    - "注視權重區後說出數值,結果即時重算；滑桿為可選備援"
    - "注視項目後說『看來源』；鍵盤與點擊為可選備援"
    - "語音指令『下一個』切換視圖"

  accessibility:
    screen_reader_script: "...”
    keyboard_shortcuts: {...}

  adaptability:
    switchable_modes:                 # 使用者可中途切換
      - compact_table
      - text_summary
      - chart_only
```

**決策邏輯範例**:
```
IF intent.deliverable == "report"
   AND user.modality_preference.visual > 0.7
   AND content.has_quantitative_data:
   → primary: interactive_dashboard
   → secondary: exportable_pdf
ELIF intent.urgency == "immediate"
     AND context.time_of_day == "late_evening"
     AND user.evening_bandwidth == "low":
   → primary: voice_narration (3 sentences)
   → secondary: full_text_saved_for_tomorrow
```

### 4.5 生成執行層(Generative Runtime)

**職責**:根據互動計畫,實際**生成並執行**工具與呈現。

**三種生成路徑**:

#### 路徑 A:純內容生成(最簡單)
Claude 直接輸出文字/markdown/圖表規格 → 渲染器顯示。例:「摘要這篇文章」。

#### 路徑 B:UI 元件生成(中等)
Claude 生成一段 React/SVG 程式碼 → 沙盒執行 → 顯示互動元件。例:「給我一個可調整的預算計算器」。
- 類似 **Claude Artifacts** 但為當次任務量身打造
- 執行環境:WebView sandbox + capability-gated APIs
- 可嵌入 Nous 知識庫的資料

#### 路徑 C:工具合成(最進階)
Claude 生成完整的 Python/TS 指令碼 + UI → 組合成臨時工具。例:「幫我監控我 GitHub 上所有 PR 的審核進度,有更新就通知我」。
- 生成:後端邏輯(Python)+ 前端介面(React)+ 排程(cron)
- 執行:Docker / gVisor 沙盒
- 可存取:透過 MCP 宣告的外部服務

**沙盒安全原則**:
- **預設無權限**——所有生成程式碼啟動時沒有任何權限
- **逐項宣告**——程式碼必須在 manifest 中列出需要的能力(讀檔/網路/MCP X/...)
- **使用者批准**——首次執行時彈窗顯示宣告,使用者決定允許
- **行為記錄**——所有系統呼叫寫入 Langfuse trace

**流式呈現**:
生成可能需要 5-30 秒,因此:
- **骨架先行**——Claude 先輸出版面結構,填充是之後的事
- **漸進式填充**——各區域獨立串流,不互相阻塞
- **可中斷**——使用者隨時可說「停,換一種」

### 4.6 晉升管線(Skill Promotion Pipeline)

**職責**:把被重複使用的暫態工具,晉升為持久技能。

**生命週期**:
```
ephemeral_tool (暫態工具)
   │
   │ 被使用 ≥ 3 次(相同或相似意圖)
   ▼
candidate_skill (候選技能) ── 背景記錄候選,在使用者詢問重用／自動化時提出
   │
   │ 使用者同意
   ▼
persistent_skill (持久技能) ── 登錄背景能力庫,用意圖／語音喚起
   │
   │ 60 天未使用
   ▼
archived_skill (封存) ── 不顯示,但語義搜尋仍可喚回
```

**設計重點**:
- **背景發現,按需確認**——AI 觀察模式並記錄候選；使用者詢問重用／自動化時提議，不在待機時主動彈窗
- **個人化能力庫**——每位使用者逐漸累積自己的技能；平時不佔畫面，說出需求或「列出我的技能」才喚起
- **技能可分享**——使用者可以把一個技能匯出為 skill file,分享給別人(類似 Claude Skills 的可分享性)
- **技能可重組**——持久技能成為能力圖譜的一部分,未來可被其他生成任務引用

---

## 5. 互動流程三範例

### 範例 1:一次性意圖(Intent → Artifact)

```
使用者:「幫我看看這個合約有什麼風險」
│
├─ Intent Parser:
│    意圖類型:one_shot_analysis
│    輸入:附件合約 PDF
│    交付物:風險分析
│    受眾:使用者本人(中度法律知識)
│
├─ Capability Graph 檢查:
│    ✓ PDF 解析能力(Docling)
│    ✓ LLM 分析能力(Claude)
│    ✓ 互動 UI 生成能力(React in Artifact)
│    ✓ 知識庫(使用者之前存的類似案例)
│
├─ Cognitive Profile 查詢:
│    視覺偏好 0.8,喜歡先看概覽再深入,中等密度
│
├─ Presentation Designer 決策:
│    Plan:互動式風險地圖
│    Layer 1:紅/黃/綠 三層風險標記整體條款
│    Layer 2:點擊特定條款,側邊彈出「為什麼風險?」
│    Layer 3:深入展開,對比類似案例
│
├─ Generative Runtime:
│    生成 React 元件 + 載入 PDF 渲染 + 綁定 Claude 分析結果
│    沙盒中執行,串流到使用者螢幕
│
└─ 呈現:使用者看到互動式風險地圖,可自行探索
```

**對比舊世界**:舊世界會是「AI 輸出一段文字分析」—— 相同資訊,完全不同的可操作性。

---

### 範例 2:模糊意圖(Intent → Clarify → Artifact)

```
使用者:「幫我整理一下最近的狀況」
│
├─ Intent Parser:意圖過於模糊,觸發澄清
│
├─ AI 追問(但只問最少的):
│    「你指的是:
│     (A) 工作專案進度
│     (B) 個人待辦事項
│     (C) 最近讀過的資訊重點
│     (D) 其他」
│
├─ 使用者:(A)
│
├─ 接續正常流程...
│    Presentation Designer 選擇:卡片式看板(Kanban)
│    因為使用者認知輪廓偏好「中等密度 + 視覺化」
│
└─ 呈現:一個可拖拉的互動看板,每張卡片是一個專案
```

**設計重點**:追問的**成本意識**——只問絕對必要的。過度追問會毀掉體驗。

---

### 範例 3:晉升為持久技能

```
使用者第一次:「每週幫我整理上週 GitHub 的 PR review 狀況」
→ AI 生成一次性報告

使用者第二次(一週後):「再幫我看上週的 PR review 狀況」
→ AI 複用上次模式,再產生一次

使用者第三次:「看一下上週 PR,這個可以自動做嗎?」
→ AI 對照重複模式,回應自動化需求:
  「我發現你常問這個,要不要我每週一早上 9 點自動產生 PR 週報送到 Nous?」

使用者:「好」
→ Skill Promotion:
   - 建立 cron trigger
   - 登錄背景技能；成果按訂閱規則呈現，不建立常駐 UI widget
   - 這個技能的「能力宣告」被登記(需要 GitHub MCP、Gmail MCP 等)
```

**從此這位使用者的 Nous 比昨天多了一個小能力**—— 而且是他專屬的。

---

## 6. 信任與安全

生成式系統最大的風險是**不可預期的行為**。設計上:

### 6.1 多層沙盒
| 生成內容類型 | 執行環境 | 預設能力 |
|---|---|---|
| 純文字/Markdown | 主 UI | 僅顯示 |
| UI 元件(React/SVG) | WebView sandbox | 無 I/O,無網路 |
| 程式碼片段(短期) | Deno/WASM 沙盒 | 宣告式 capabilities |
| 完整工具(長期) | Docker/gVisor | 嚴格審查後才允許 |

### 6.2 能力宣告機制(Capability Manifest)
每個生成的工具必須附上:
```yaml
manifest:
  needs:
    - read_knowledge: ["work/*"]
    - call_mcp: ["github"]
    - network: ["api.github.com"]
  does_not_need:
    - write_filesystem
    - call_mcp: ["gmail", "notion"]
    - execute_shell
```
使用者在首次執行時看到這個宣告,決定授權。**預設拒絕,明示允許**。

### 6.3 行為可追溯
所有生成工具的執行都進入 Langfuse trace。使用者可以:
- 事後檢視「這個工具做了什麼」
- 撤回某個已授權的能力
- 一鍵刪除該工具及其所有記憶痕跡

### 6.4 降級機制
若生成失敗、沙盒異常、使用者不確信——**退回純文字回答**。AI 不會因為「應該要生成互動 UI」而強迫自己,簡單勝過華麗。

---

## 7. 與 Nous 核心的關係

這個系統**不是獨立產品**,而是 Nous 作業系統上的**呈現層與互動層**。它疊加在既有架構上:

```
┌─────────────────────────────────────┐
│ 生成式互動系統(本文件)                │  ← 新增這層
├─────────────────────────────────────┤
│ Agent 編排 / MCP 工具 / 權限引擎      │  ← Nous 核心
├─────────────────────────────────────┤
│ 記憶系統(Letta)+ 知識系統(LightRAG)│
├─────────────────────────────────────┤
│ Claude(認知核心)                    │
└─────────────────────────────────────┘
```

**關鍵依賴**:
- **記憶層**提供 Cognitive Profile 的持久儲存
- **知識層**提供能力圖譜中的「可被引用內容」
- **Agent 編排層**提供 Presentation Designer 作為一個 specialized sub-agent
- **MCP** 提供動態能力註冊機制

---

## 8. 漸進式實作路徑

不可能在 3 個月 Alpha 裡做完這套系統。但**可以把種子植入**。

### Phase 0(Alpha):種子
- **新版必要閉環**：電子腦待機、語音需求、Agent 執行、按需成果、webcam 校正與看＋說；按 07 的 gate 驗收，原月份需重新估工
- **認知輪廓雛型**:只記錄使用者偏好「密集表格 vs 條列摘要 vs 視覺化」三選一,簡單存於 Letta core memory
- **基礎生成式呈現**:先由結構化計畫驅動受控元件；任意 React 生成須待沙盒隔離驗收後啟用
- **暫態呈現**:使用者可用語音要求圖表或受控互動工具；Surface 暫態，成果可依需求保存
- **1 個真實範例**:依 07 的方案比較 fixture 完成語音需求、計算、看＋說修改、保存及喚回；呈現方式可再按需切換

### Phase 1(Month 4-6,Beta):骨架
- **完整 Intent Parser**:有結構化意圖記錄
- **能力圖譜 v1**:靜態註冊,涵蓋硬體 + MCP + 內建工具
- **Presentation Designer Agent** v1:為 5 種常見意圖類型有穩定方案
- **晉升管線 MVP**:使用者可手動把暫態工具標為「保留」

### Phase 2(Month 7-12,v1.0):血肉
- **認知輪廓學習閉環**:被動觀察 + 主動詢問
- **工具合成**:生成 Python/TS 完整工具,含沙盒
- **技能候選偵測**:背景發現模式，按需詢問是否保存與排程
- **多模態擴充**:延伸音訊與簡易 3D；基本語音輸入／回饋已前移至 Alpha

### Phase 3(Year 2):成熟
- **工具市集**:使用者間可分享晉升過的技能
- **硬體深度整合**:擴充多螢幕、其他感測器與裝置能力；基本麥克風及 webcam 視線已前移至 Alpha
- **群組認知輪廓**:團隊共用的呈現偏好(例:「給 CEO 看的報告」套模板)

---

## 9. 為什麼這是對的方向

**三個結構性原因**:

1. **模型能力已經到位**——Claude 可以在單次回應中生成高品質 React/Python 程式碼,這在 2024 年以前不成立
2. **Artifacts 證明了原理**——Claude Desktop 的 Artifacts 已展示生成式 UI 的使用者接受度,Nous 要做的是把這個模式從「偶爾出現」變成「預設互動方式」
3. **MCP 提供了能力擴展層**——當 AI 可以動態取得新能力,「為當次任務生成最佳工具」才真正成為可能

**最深的洞察**:
> 作業系統的歷史是「降低人與電腦互動成本」的歷史。從指令列到 GUI 到觸控,每一代都把更多認知負擔從人類轉移到系統。**Nous 的生成式互動系統是這個方向的下一步**——連「學習 App」這個認知負擔都由 AI 承擔。人類只負責表達意圖,其餘的一切——工具設計、介面設計、認知適配——都交給 AI。

---

## 10. 一個視覺化比喻

想像你找一位**超級能幹的私人助理**。你不會說:「打開 Word,新建文件,設定標題為...」。你只會說:「幫我寫封道歉信給供應商」。這位助理會:
- 判斷道歉的嚴重程度(意圖理解)
- 知道你偏好正式還是親切(認知輪廓)
- 知道有信紙、打字機、電腦可選(能力圖譜)
- 選擇最適合的形式(呈現設計)
- 執行並交付(生成執行)
- 下次類似場合記得你的偏好(晉升學習)

**Nous 的生成式互動系統,就是把這位助理建進作業系統。**

UI 消失了,因為 UI 隨請求而生。應用消失了,因為應用隨意圖而合成。剩下的只有:**人的意圖,與 AI 為此意圖即時打造的整套體驗**。
