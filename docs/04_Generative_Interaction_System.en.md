<!-- bilingual: source=zh-TW -->

> [繁體中文](04_Generative_Interaction_System.md) | [English](04_Generative_Interaction_System.en.md)

<a id="nous-生成式互動系統設計稿"></a>
# Nous generative interaction system design

> **Reading guide, 2026-10-24**: See [implementation status](Current_Implementation_Status.en.md) for current code and gaps. See the [feature expansion assessment](13_Feature_Expansion_Assessment_2026-10-24.en.md) for value, dependencies, MVPs, and roadmaps. This document preserves early designs, not implemented or accepted capabilities. Product constraints and G0–G3 follow [06](06_Ambient_Voice_Gaze_Experience.en.md), [07](07_Ambient_Implementation_and_Acceptance.en.md), and later explicit revisions. F0–F10 and Q0–Q4 do not replace those gates.
>
> The code baseline is `1f44c6b` (2026-10-23). The runnable prototype in `prototype/ambient-shell` uses Node HTTP, SSE, TypeScript, Vite, and Electron. Tauri, React, a Python kernel, Agent SDK, long-term memory, and generated tools are target designs. Model, price, market, star, and ecosystem figures reflect the original writing date. They were not rechecked here. Verify before adoption.

> **Interaction update, 2026-09-16**: Ambient brain standby, no apps, voice first, webcam gaze selection, and on-demand presentation follow [06](06_Ambient_Voice_Gaze_Experience.en.md) and [07](07_Ambient_Implementation_and_Acceptance.en.md). Underlying designs remain. Old schedules and interfaces are historical references. 06–07 take precedence where they conflict.

> **Core proposition**: Nous has no fixed UI. For each interaction, AI generates tools and presentation from your intent × cognitive preferences × available capabilities. You express intent rather than choose an app.

---

<a id="1-典範轉移"></a>
## 1. Paradigm shift

<a id="舊世界應用中心"></a>
### The old world (application centered)
```
人類 → 選擇應用(Word)→ 操作應用 → 產出文件
```
People learn each fixed app interface and execute tasks within predefined tools.

<a id="新世界意圖中心"></a>
### The new world (intent centered)
```
人類 → 表達意圖(「我要一份文件」)
          ↓
AI 理解意圖 → 設計工具 + 設計呈現 + 考慮認知吸收
          ↓
生成臨時工具(或複用既有)→ 產出 + 以最佳方式呈現給人類
```

**Key differences**:
| Dimension | Application centered | Intent centered |
|---|---|---|
| Learning | People learn apps | AI learns people |
| UI lifetime | Permanent after installation | Temporary, generated for the interaction |
| Designer | Human designers in advance | AI for the current situation |
| Capability limits | Predefined app features | All capabilities AI can combine |
| Presentation | Fixed text/tables/UI | Dynamic modality chosen for the task |

---

<a id="2-五大設計原則"></a>
## 2. Five design principles

<a id="原則一意圖優於應用intent-over-application"></a>
### Principle 1: Intent over Application
Nous asks what you want to achieve, never which tool to use. “Create a document” might mean a report, summary, memo, plan, or letter. Each needs a different presentation.

<a id="原則二呈現即設計交付物presentation-is-a-design-deliverable"></a>
### Principle 2: Presentation is a Design Deliverable
AI designs how content is presented as well as producing it. A financial report might be a table, interactive dashboard, spoken podcast, or bullet summary. **Choosing the form is AI's design work.**

<a id="原則三工具即答案tool-as-answer"></a>
### Principle 3: Tool as Answer
When static text cannot carry a complex answer, AI **generates a tool**. Examples:
- “Where are the risks in this contract?” → an **interactive risk map** with clause explanations.
- “Which laptop should I buy?” → a **live comparison table** with adjustable weighting.

<a id="原則四認知適配cognitive-fit"></a>
### Principle 4: Cognitive Fit
Presentation follows how people absorb information:
- **Mayer's multimedia learning theory**: Visuals plus speech aid understanding more than either alone.
- **Sweller's cognitive load theory**: Reveal complex information in layers rather than all at once.
- **Personal cognitive profiles**: Visual or textual, dense or progressive preferences.

<a id="原則五暫態預設持久為例外ephemeral-by-default"></a>
### Principle 5: Ephemeral by Default
Generated tools/UI exist **for the current interaction** and disappear afterward. **Only repeatedly used tools become persistent skills** through skill promotion. This prevents UI growth.

---

<a id="3-系統架構"></a>
## 3. System architecture

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

<a id="4-六大核心子系統"></a>
## 4. Six core subsystems

<a id="41-意圖理解層intent-parser"></a>
### 4.1 Intent Parser

**Responsibility**: Turn surface requests into structured intent.

**Key output (Intent Record)**:
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

**Design priorities**:
- **Do not require precision from people**. Clarify ambiguity only when necessary.
- **Distinguish one-time and recurring needs** to decide whether a persistent tool is appropriate.
- **Infer the audience**. Personal and executive-facing outputs need different presentations.

<a id="42-能力圖譜capability-graph"></a>
### 4.2 Capability Graph

**Responsibility**: Structured knowledge of what the current system can do.

**Contents**:
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

**Design priorities**:
- **Hardware awareness** comes from this graph. Audio output makes spoken summaries feasible.
- **Extensibility**: Installing an MCP server registers new capabilities.
- **Composition**: AI plans complex tasks by combining capabilities.

<a id="43-認知輪廓cognitive-profile"></a>
### 4.3 Cognitive Profile

**Responsibility**: Model each user's best presentation style and keep learning.

**Profile structure**:
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

**Construction**:
1. **Cold start**: Offer different forms in the first 10 interactions and record choices.
2. **Passive observation**: Reading duration, scrolling, and clicking patterns.
3. **Active questions**: Once in every 20 interactions, ask whether the presentation helped.
4. **Claude Agent SDK hooks**: Record the next action after each presentation (repeat, accept, revise).

**Cognitive load calculation**:
The Presentation Designer estimates each candidate's **cognitive load**:
```
cognitive_load = (
  content_complexity * density_factor
  - modality_match_bonus
  - expertise_bonus
  + interaction_cost
)
```
Choose the lowest load that still conveys the full intent.

<a id="44-呈現設計師-agentpresentation-designer"></a>
### 4.4 Presentation Designer

**Responsibility**: The central subsystem combines Intent, Capabilities, and Cognitive Profile into an **Interaction Plan**.

**Core system prompt**:
> You are Nous's Presentation Designer. You design how content is perceived rather than produce content. Return an Interaction Plan telling the runtime which modalities, tools, pacing, disclosure levels, and human intervention points to use. Base decisions on multimedia learning, cognitive load theory, and this user's cognitive profile.

**Output (Interaction Plan)**:
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

**Example decision logic**:
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

<a id="45-生成執行層generative-runtime"></a>
### 4.5 Generative Runtime

**Responsibility**: **Generate and execute** tools and presentations from the plan.

**Three generation paths**:

<a id="路徑-a純內容生成最簡單"></a>
#### Path A: content only (simplest)
Claude returns text/Markdown/chart specifications for rendering. Example: “Summarize this article.”

<a id="路徑-bui-元件生成中等"></a>
#### Path B: UI components (intermediate)
Claude generates React/SVG code, executes it in a sandbox, and shows an interactive component. Example: “Give me an adjustable budget calculator.”
- Like **Claude Artifacts**, tailored to this task.
- WebView sandbox with capability-gated APIs.
- Can embed Nous knowledge data.

<a id="路徑-c工具合成最進階"></a>
#### Path C: tool synthesis (advanced)
Claude generates Python/TS scripts and UI as a temporary tool. Example: “Monitor all my GitHub PR reviews and notify me of updates.”
- Generates backend Python, frontend React, and cron scheduling.
- Executes in Docker/gVisor sandboxes.
- Accesses services declared through MCP.

**Sandbox principles**:
- **No permissions by default** for generated code.
- **Declare each capability** in a manifest (files, network, specific MCP services).
- **User approval** at first execution, with declared needs shown.
- **Behavior logging** of all system calls in Langfuse traces.

**Streaming presentation**:
Generation may take 5-30 seconds:
- **Structure first**: Claude emits layout before filling content.
- **Progressive filling**: Regions stream independently.
- **Interruptible**: Users can say “stop, use another form” at any time.

<a id="46-晉升管線skill-promotion-pipeline"></a>
### 4.6 Skill Promotion Pipeline

**Responsibility**: Promote repeatedly used temporary tools to durable skills.

**Lifecycle**:
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

**Design priorities**:
- **Discover in the background, confirm on demand**. Record patterns and suggest reuse/automation when asked, without standby popups.
- **Personal capability library**. Skills accumulate without occupying the screen. Invoke by need or “list my skills.”
- **Shareable skills**. Export a skill file, like Claude Skills.
- **Composable skills**. Persistent skills enter the capability graph for future generated tasks.

---

<a id="5-互動流程三範例"></a>
## 5. Three interaction examples

<a id="範例-1一次性意圖intent--artifact"></a>
### Example 1: one-time intent (Intent → Artifact)

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

**Compared with the old world**: A text analysis contains the same information but offers very different usability.

---

<a id="範例-2模糊意圖intent--clarify--artifact"></a>
### Example 2: ambiguous intent (Intent → Clarify → Artifact)

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

**Design priority**: Clarification has a cost. Ask only essential questions. Excessive questions damage the experience.

---

<a id="範例-3晉升為持久技能"></a>
### Example 3: promotion to a persistent skill

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

**This user's Nous now has another personal capability.**

---

<a id="6-信任與安全"></a>
## 6. Trust and security

The main generative-system risk is **unpredictable behavior**. Address it as follows.

<a id="61-多層沙盒"></a>
### 6.1 Multiple sandbox layers
| Generated content | Environment | Default capabilities |
|---|---|---|
| Text/Markdown | Main UI | Display only |
| React/SVG components | WebView sandbox | No I/O or network |
| Short-lived snippets | Deno/WASM sandbox | Declared capabilities |
| Long-lived full tools | Docker/gVisor | Allowed only after strict review |

<a id="62-能力宣告機制capability-manifest"></a>
### 6.2 Capability Manifest
Every generated tool includes:
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
Show this at first execution for authorization. **Deny by default, allow explicitly.**

<a id="63-行為可追溯"></a>
### 6.3 Traceability
Every tool execution enters Langfuse traces. Users can:
- Review what a tool did.
- Revoke granted capabilities.
- Delete the tool and all its memory traces in one action.

<a id="64-降級機制"></a>
### 6.4 Fallback
On generation failure, sandbox errors, or user uncertainty, **return a text answer**. Do not force an interactive UI. Simplicity takes priority over appearance.

---

<a id="7-與-nous-核心的關係"></a>
## 7. Relationship to the Nous core

This is **the OS presentation and interaction layer**, not a separate product. It sits above the existing architecture:

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

**Dependencies**:
- **Memory** persists Cognitive Profiles.
- **Knowledge** supplies referenceable content in the graph.
- **Orchestration** runs the Presentation Designer as a specialist sub-agent.
- **MCP** registers capabilities dynamically.

---

<a id="8-漸進式實作路徑"></a>
## 8. Incremental implementation

The whole system cannot fit a three-month Alpha, but its foundations can.

<a id="phase-0alpha種子"></a>
### Phase 0 (Alpha): foundations
- **Required updated loop**: Ambient brain, voice request, agents, on-demand results, webcam calibration, look-and-speak. Follow 07 gates and re-estimate original month plans.
- **Profile prototype**: Store one preference in Letta core memory: dense tables, bullets, or visuals.
- **Basic generative presentation**: Structured plans drive controlled components. Arbitrary React generation waits for sandbox acceptance.
- **Temporary surfaces**: Request charts or controlled tools by voice. The surface is temporary, while results may be saved.
- **One real example**: Use 07's comparison fixture for a voice request, calculations, look-and-speak edits, save, and recall. Change presentation on demand.

<a id="phase-1month-4-6beta骨架"></a>
### Phase 1 (Month 4-6, Beta): framework
- **Full Intent Parser** with structured records.
- **Capability Graph v1** with static hardware, MCP, and tool registration.
- **Presentation Designer v1** with stable plans for five common intents.
- **Promotion MVP** lets users mark a temporary tool to keep.

<a id="phase-2month-7-12v10血肉"></a>
### Phase 2 (Month 7-12, v1.0): expansion
- **Profile learning loop** through passive observation and active questions.
- **Tool synthesis** with full Python/TS tools and sandboxing.
- **Skill candidate detection** in the background, with on-demand save/schedule prompts.
- **Multimodality** adds audio and simple 3D. Basic voice input/feedback has moved to Alpha.

<a id="phase-3year-2成熟"></a>
### Phase 3 (Year 2): maturity
- **Tool marketplace** for shared promoted skills.
- **Deeper hardware integration** for multiple displays and other sensors/devices. Basic microphones and webcam gaze have moved to Alpha.
- **Group cognitive profiles**, such as a team template for CEO reports.

---

<a id="9-為什麼這是對的方向"></a>
## 9. Why this direction

**Three structural reasons**:

1. **Models are capable enough**. Claude can produce quality React/Python in one response, unlike before 2024.
2. **Artifacts validates the idea**. Claude Desktop demonstrates acceptance of generated UI. Nous makes this the default rather than occasional interaction.
3. **MCP expands capabilities**. Dynamic capability acquisition makes the best tool for each task possible.

**Central insight**:
> OS history is about reducing interaction costs. Command lines, GUIs, and touch shift cognitive work from people to systems. **Nous's generative interaction is the next step**: AI also takes on learning apps. People express intent; AI handles tools, interfaces, and cognitive fit.

---

<a id="10-一個視覺化比喻"></a>
## 10. A visual analogy

Imagine a **highly capable personal assistant**. You say “write an apology to our supplier,” rather than dictate Word commands and headings. The assistant:
- Assesses the seriousness (intent).
- Knows your formal/friendly preference (profile).
- Knows available paper, typewriter, and computer (capabilities).
- Chooses the form (presentation design).
- Executes and delivers (runtime).
- Remembers preferences next time (promotion learning).

**Nous builds that assistant into the OS.**

UI exists for requests, and applications are synthesized for intent. What remains is **human intent and the complete experience AI builds for it**.
