<!-- bilingual: source=zh-TW -->

> [繁體中文](24_Capability_Catalog_and_Skills_2026-11.md) | [English](24_Capability_Catalog_and_Skills_2026-11.en.md)

# Nous 24 — 能力總表與技能目錄（2026-11）

版本：v0.1 · 日期：2026-11-24（Asia/Taipei）· 狀態：**George 已於 2026-11-24 回覆 6 項決定（[§6.1](#61-george-的決定2026-11-24)），同意從 CAP-1 動工；本文本身沒有改任何產品程式**。基準：main `fd2198b`（PR #150 之後）。本文借鏡 [Omarchy](https://omarchy.org/) 的兩個機制，對照 Nous 現有程式後提出兩組批次：CAP（能力總表）與 SKL（技能目錄）。CAP、SKL 是本文新提的批次標籤，不更改 `docs/07` 的 gate、`docs/13` 的 F0–F10 或任何 ADR。開發遵守 [CLAUDE.md](../CLAUDE.md)、[目前實作狀態](Current_Implementation_Status.md)、[18 App Integration Layer](18_App_Integration_Layer_and_Spotify_2026-11.md) 與 [雙語規範](BILINGUAL.md)。

## 0. 一頁摘要

- Nous 已經有工具登記表：`prototype/ambient-shell/server/integrations/registry.ts`（AIL-1）。所以這份提案不是從零設計，而是補三個缺口。
- **缺口一：登記表只給模型看。** 每個工具只有給模型的 `description`，沒有給人看的一句話與「可以這樣說」的例句。語音指令表（`/help/commands`）因此另外手寫：`shared/voice-commands.ts` 的 `ASK_THE_AI` 只列 9 個頁面工具，`TIMER_ASK` 手寫 5 列定時器與鬧鐘；電視、日曆、寄信、天氣、語音中繼的工具都不在表上。
- **缺口二：沒有機器可讀的總表。** `IntegrationRegistry.capabilities(route)` 寫了但沒有任何呼叫端；設定畫面只拿到工具名稱。沒有一份「Nous 現在會什麼、為什麼某項不能用」的清單可以給人、給模型、給開發 Agent 共用。
- **缺口三：沒有技能。** `docs/06` 寫了「記住這種做法」保存技能，現況文件寫「技能晉升沒有」。程式裡沒有任何技能的資料結構（在 `server`、`shared`、`src` 搜尋 `skill`／`技能` 沒有結果）。
- **提案**：
  - **CAP**：把人看的說明與例句加進每個工具的定義，由登記表產生一份總表；語音指令表由它產生；加一個檢查，漏寫就失敗。
  - **SKL**：技能是一份 Markdown 做法，只描述「怎麼用總表上的工具完成一件家裡常做的事」。它不新增工具、不帶程式、不改權限。檢查會確認技能提到的每個工具都在總表上。
- **建議順序**：CAP-1 → CAP-2 → SKL-1 → SKL-2 → CAP-3 → SKL-3。技能的檢查要用到總表，所以 CAP-1 先做。
- 原本待 George 決定的 6 項已於 2026-11-24 回覆，見 [§6.1](#61-george-的決定2026-11-24)。

## 1. Omarchy 的兩個機制

以下是 2026-11-24 讀 `omacom/omarchy` 的 `quattro` 分支得到的事實。沒有讀到的部分列在本節最後。本提案只借用做法，沒有複製任何程式碼。

### 1.1 指令總表

- 沒有另外的清單檔。`bin/` 裡每個 `omarchy-*` 執行檔的開頭註解就是它的資料：`omarchy:summary=`、`omarchy:args=`、`omarchy:examples=`、`omarchy:group=`、`omarchy:hidden=true`、`omarchy:requires-sudo=true` 等。
- 分派程式 `bin/omarchy` 掃過這些檔案，讀前 80 行的註解，組成總表。
- `omarchy commands --json` 輸出每個指令的 `route`、`group`、`name`、`summary`、`args`、`examples`、`aliases`、`hidden`、`requires_sudo`。
- `omarchy commands --check` 會失敗的情況：路由撞名、沒有明確寫 `summary`、`hidden`／`requires-sudo` 的值不是 `true`、`subcommand` 格式不對。
- 選單節點寫在另一個檔（`default/omarchy/omarchy-menu.jsonc`），每個節點的 `action` 是一行 shell 指令，多數直接呼叫同一批 `omarchy-*` 執行檔。讀到的文件沒有說選單的 `action` 會對照總表檢查。

### 1.2 技能

- 隨系統出貨的技能放在 `default/agents/skills/<名稱>/SKILL.md`。frontmatter 只有 `name` 與 `description` 兩欄。
- 主要技能 `omarchy` 的內容是規則與做法：只改 `~/.config/`、不改系統目錄；優先用 `omarchy <group> <action>`；用 `omarchy commands --json` 找指令；某些動作前先確認。細節拆到同目錄的主題檔，由 `SKILL.md` 連過去。
- `bin/omarchy-agent-skills-link` 把每個技能目錄用符號連結放進各家 Agent 工具的技能目錄。使用者自己有同名目錄時，以使用者的為準。
- repo 根目錄的 `agents/skills/*.md` 是另一種東西：給**開發 Omarchy 的 Agent** 看的任務指引（例如怎麼寫指令的註解資料、怎麼寫 migration），沒有 frontmatter，由 `AGENTS.md` 索引。

### 1.3 沒有驗證的部分

- 手冊說出貨 7 個技能；只讀了 `omarchy` 這一個的 `SKILL.md`，其餘 6 個與主題檔沒有讀。
- `bin/` 的檔案清單在頁面上被截斷，沒有看到全部指令。
- 沒有找到 `omarchy commands --json` 的實際輸出範例；欄位是從 `bin/omarchy` 裡的 jq 篩選式讀出來的。

### 1.4 哪些借、哪些不借

| Omarchy | Nous 的對應 | 決定 |
|---|---|---|
| 資料寫在每個指令自己的檔頭 | 資料寫在每個工具自己的 `ToolDefinition` | 借。不另外維護清單檔 |
| `commands --json` | 登記表產生總表 JSON | 借 |
| `commands --check` | 測試與檢查腳本 | 借 |
| `hidden=true` | 模擬工具與 Facade 工具不列在給人看的表 | 借 |
| 選單另外寫，沒有對照總表 | 語音指令表**直接由總表產生** | 改良：同一個來源，不會漏 |
| 技能＝Markdown＋`name`／`description` | 相同，另加 `tools` 欄列出用到的工具 | 借並擴充 |
| 使用者同名技能優先 | 相同 | 借（SKL-3） |
| 給開發 Agent 的任務指引 | 一份「怎麼加一個 Adapter」的雙語 how-to | 借（放進 CAP-1） |
| App launcher、系統選單、鍵盤優先 | 無 | **不借**，違反產品紅線 |
| 給使用者打的 CLI | 無 | 不借。下面的 `npm run catalog` 只是開發工具 |
| 動態安裝外掛 | 無 | 不借。Adapter 仍然只由程式碼註冊（`docs/18` §4） |

## 2. Nous 現況

路徑都在 `prototype/ambient-shell/` 底下。

| 項目 | 位置 | 現況 |
|---|---|---|
| 工具登記表 | `server/integrations/registry.ts` | 註冊時檢查 ID、schema、`effect`、時限、路徑；`listTools(route)`、`functionSpecs(route, locale)` 產生給模型的清單 |
| 工具定義 | `server/integrations/contracts.ts` `ToolDefinition` | `id`、`description`、`descriptionEn`、`inputSchema`、`effect`、`enabled`、`timeoutMs`、`supportedRoutes`、`legacyName`。**沒有給人看的說明或例句** |
| 已審核的 Adapter | `server/integrations/index.ts` `KNOWN_ADAPTERS` | 8 個：`mock`、`home`、`spotify_soloist`、`voice_relay`、`google_calendar`、`weather`、`lg_tv`、`gmail_gog`；另有核心內建的定時器與鬧鐘 |
| 工具 ID | `server/integrations/adapters/*.ts` | 32 個不同的 `app.<service>.<action>` 字串：alarm 6、calendar 2、home 3、mail 1、mock 2、timer 7、tv 9、voice_relay 1、weather 1（計算方式見 [§7](#7-數字的計算方式)） |
| 頁面工具 | `shared/realtime-route.ts` `HOST_TOOL_NAMES` | 9 個（`web_search`、`delegate_task`、`home_status` 等），在登記表之外，另有自己的名單與時限 |
| 診斷清單 | `IntegrationRegistry.capabilities(route)` | 有實作，沒有呼叫端 |
| 語音指令表 | `shared/voice-commands.ts`、`server/commands-page.ts` | 本機固定語句由測試逐句驗證。「可以問 AI」一段是手寫的 `ASK_THE_AI`（9 個頁面工具）與 `TIMER_ASK`（5 列） |
| 設定畫面 | `server/app.ts` 的 settings | 只有 `integrations.tools`：工具的函式名稱清單 |
| 文字聊天與背景任務 | `server/claude-executor.ts`、`server/chatgpt-executor.ts` | 只有上網查詢，沒有接登記表（`docs/18` §2 已記載） |
| 技能 | 無 | 沒有資料結構、沒有載入、沒有保存 |

Adapter 的建立方式有一個會影響設計的細節：缺設定時 factory 回 `null`，這個 Adapter 就不註冊。所以**執行中的登記表只知道這次有設定的服務**，沒辦法回答「Nous 總共能接哪些東西」。

## 3. CAP：能力總表

### 3.1 資料放在哪裡

加在 `ToolDefinition` 上，和 `description`、`effect` 放在一起。新增工具的人在同一個地方寫完，不必再去改另一個檔。

```ts
// 提案草稿，不是已存在的型別。
interface ToolCatalogInfo {
  /** 給人看的一句話：這個工具做什麼。 */
  summary: string;
  /** 可以這樣說（至少一句）。 */
  examples: readonly [string, ...string[]];
  /** 前提，例如「需要電視已配對」。沒有就不寫。 */
  needs?: string;
  /** 不列在給人看的表（模擬工具、Facade 工具）。 */
  hidden?: true;
}
```

Adapter 另外加一個給人看的服務名稱（例如「客廳電視」），對應 Omarchy 的群組說明。

文字以中文為原文，英文沿用既有的共用翻譯表與 `localize()`（`server/localization.ts`），不另開一組英文欄位。檢查會確認每一句都有英文。

### 3.2 兩種總表

| | 靜態總表 | 即時總表 |
|---|---|---|
| 回答的問題 | Nous 的程式總共定義了哪些工具 | 現在這台、這條路徑上哪些可用，不可用的原因是什麼 |
| 來源 | 所有已審核 Adapter 的工具定義，不需要任何設定 | 執行中的登記表加上健康狀態 |
| 用途 | 檢查、文件、技能的工具 ID 對照 | 語音指令表的「目前」標註、模型回答「你會做什麼」 |

靜態總表需要每個 Adapter 不靠設定就能交出工具定義。現有 10 個 Adapter 檔是否都做得到，要在 CAP-1 逐一確認；做不到的要先把定義搬成模組層級的常數。

一筆的形狀（示意，欄位名稱在 CAP-1 定案）：

```json
{
  "id": "app.tv.volume",
  "wire": "app__tv__volume",
  "adapter": "lg_tv",
  "effect": "reversible_write",
  "routes": ["api_key", "live"],
  "summary": "…",
  "examples": ["…"],
  "mock": false,
  "status": { "api_key": "available", "live": "available" }
}
```

`status` 只出現在即時總表，值沿用既有的 `CapabilityStatus`。

### 3.3 批次

| 批次 | 交付 | Gate |
|---|---|---|
| CAP-0（本文） | 雙語提案 | 文件互連、雙語檢查通過、沒有改產品程式 |
| CAP-1 | `ToolCatalogInfo` 欄位；現有工具全部補上說明與例句；`registry.catalog()`；`npm run catalog -- --json／--check／--markdown`；雙語 how-to「怎麼加一個 Adapter」 | 檢查在漏寫說明、漏寫例句、缺英文、ID 撞名時失敗；**送給模型的工具 JSON 與改動前逐位元組相同**（測試比對）。全部是 fixture，不是產品 gate |
| CAP-2 | `/help/commands` 與原型 README 的「可以問 AI」一段，整合工具的部分改由總表產生；`TIMER_ASK` 改由總表產生；不可用的列依即時狀態標註原因 | 電視、日曆、寄信、天氣的列出現在表上；模擬工具與 Facade 不出現；既有 9 個頁面工具的列不變 |
| CAP-3 | 內建唯讀工具（暫名 `app.nous.capabilities`）：模型被問「你會做什麼」「為什麼不能開電視」時，依即時總表回答，包含不可用的原因 | fixture 測試；Mac 上真實語音各問一次可用與不可用的服務，回答與設定畫面一致 |
| CAP-4（George 2026-11-24 同意） | 9 個頁面工具也有總表資料，`ASK_THE_AI` 改由總表產生 | 模型看到的工具定義不變；指令表的列與順序不變 |
| CAP-6（George 2026-11-24 同意） | 工具呼叫連動腦區：頁面收到真實的工具呼叫事件時，依總表上那個工具的 `domain` 亮起對應腦區，標明來源是工具呼叫 | fixture；沒有工具呼叫時不亮；模擬工具標示 mock；Mac 上真實語音看一次。CLAUDE.md 的規則已同步放寬 |
| CAP-5（另案） | 文字聊天與背景任務接上登記表 | 不在本提案範圍；`docs/18` §2 已說要另立批次 |

**CAP-2 狀態補記（2026-11-24）**：已實作於分支 `claude/cap-2-commands-from-catalog`。「定時器與鬧鐘」改由總表產生（一個工具一列，13 列），整合工具放在新的「App 整合」一段（14 列），「可以問 AI」的 9 個頁面工具不動（CAP-4）；不可用的列依即時總表標原因。雲端 fixture 與型別檢查，不是產品 gate，見 [CAP-2 驗證](validation/cap-2-commands-from-catalog-2026-11-24.md)。

CAP-1 與 CAP-2 不改變任何語音行為，只改文件頁與開發工具。使用者第一次感覺得到的是 CAP-2（指令表變完整）與 CAP-3（可以直接問 Nous 會什麼）。

### 3.4 CAP-3 的呈現

「你會做什麼」的回答以語音為主。需要畫面時，只在使用者這次問了才顯示，`visibility_reason` 是這次的提問，念完後依既有設定收起。**不做常駐的能力清單、圖示牆或首頁。**

## 4. SKL：技能目錄

### 4.1 技能是什麼

技能是一份 Markdown 檔，告訴模型「家裡這件常做的事，要依序用哪些工具、遇到哪種情況怎麼處理」。

- 技能**只有文字**。它不能新增工具、不能啟用被停用的工具、不帶程式碼、不能改設定。
- 技能裡的每一步仍然由 Dispatcher 執行，政策、確認卡、頻率限制、`unknown`／`unconfirmed` 的回報方式都照舊。技能沒辦法繞過確認。
- 技能不建立圖示、側欄或常駐入口。它只在使用者提出需求時被模型拿來用。

### 4.2 檔案格式

```text
prototype/ambient-shell/skills/<name>/SKILL.md
<data-dir>/skills/<name>/SKILL.md
```

第一行是隨程式出貨的技能，經過 PR 審核。第二行是家裡自己存的技能（SKL-3），放在 Nous 的資料目錄；同名時以它為準。

```markdown
---
name: movie-night
description: 使用者說要看電影、看片、電影時間時使用。
tools:
  - app.tv.power
  - app.tv.launch_app
  - app.home.control
---

（做法：步驟、每一步失敗時怎麼說、哪些事要先問使用者）
```

`name` 與 `description` 和 Omarchy、各家 Agent 工具的技能格式相同。`tools` 是 Nous 加的欄位：列出這份技能用到的工具 ID。上面的技能名稱與工具組合只是格式示意，不是已決定的內容。

家裡資料目錄的實際路徑在 SKL-3 依 `server/config.ts` 定案。

### 4.3 總表與技能怎麼接起來

- **檢查**：技能的 `tools` 與內文提到的每個 `app.<service>.<action>` 都必須在靜態總表上。工具改名或移除時，檢查會指出哪份技能壞了。Omarchy 的選單沒有這一層對照。
- **列出**：一份技能只有在它的 `tools` **全部**在這條路徑上可用時，才出現在給模型的技能索引裡。電視沒配對時，模型不會看到要用電視的技能，也就不會答應做不到的事。
- **載入**：模型先只看到索引（每份技能的 `name` 與 `description`）。決定要用時，才用唯讀工具（暫名 `app.skill.read`）讀內文。索引佔多少字、一次最多列幾份，在 SKL-2 量測後才定數字。

### 4.4 批次

| 批次 | 交付 | Gate |
|---|---|---|
| SKL-1 | 格式、解析、檢查（併入 `npm run catalog -- --check`）；1 份出貨技能（早晨簡報，中英文各一份）；旗標 `NOUS_SKILLS` 預設關閉，**模型還看不到** | fixture：frontmatter 錯、名稱與目錄不符、工具 ID 不存在、內文過長時檢查失敗 |
| SKL-2 | 兩條即時語音路徑：技能索引進工作階段說明；`app.skill.read`；依可用工具過濾 | fixture；旗標關閉時工具表與說明逐位元組不變；Mac 上真實語音跑一次出貨技能，記錄每一步的真實結果 |
| SKL-3 | 「記住這種做法」：模型起草 → 畫面顯示名稱與步驟 → 使用者確認後寫檔；用說的列出與忘掉；同名時家裡的優先 | fixture；Mac 上存一份、用一次、忘掉一次；沒確認就不寫檔 |

**SKL-1 狀態補記（2026-11-24）**：已實作於分支 `claude/skl-1-skill-format`。格式是 `skills/<name>/SKILL.md`（中文）與 `SKILL.en.md`（英文），frontmatter 只有 `name`、`description`、`tools`；解析與檢查在 `server/skills/`，併入 `npm run catalog -- --check`，24 種失敗各有 fixture；出貨「早晨簡報」一份（只用天氣與日曆的唯讀工具）。**模型還看不到技能**；`NOUS_SKILLS` 這一批沒有程式讀它，SKL-2 才會用到。雲端 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收，見 [SKL-1 驗證](validation/skl-1-skill-format-2026-11-24.md)與[怎麼寫一份技能](development/writing-a-skill.md)。

**SKL-2 狀態補記（2026-11-24）**：已實作於分支 `claude/skl-2-skills-realtime`。`NOUS_SKILLS=on`（預設關閉）時，兩條即時語音路徑共用 `server/skills/runtime.ts` 的 `SkillBook`：工作階段說明加上技能索引（每份技能的 `name` 與介面語言的 `description`，加一段「先用讀取工具讀內文、照做、只說工具回傳的內容」的指示）；讀取工具名稱定案為 `app.skill.read`（核心內建、`read`、hidden、`domain: null`），只讀這條路徑、這個語言列得出來的技能，名稱只對照已載入清單。一份技能的 `tools` 在這條路徑上全部 `available` 才列出（登記表即時狀態）：API key 路徑以工作階段開始時為準，ChatGPT 方案的工具執行層每次交辦重算。§4.3 待量測的數字：只有早晨簡報時 API key 說明中文 +202、英文 +571 字；上限一次 8 份、整段 2,000 字，超過時依名稱截斷並記 log。旗標關閉時工具 JSON、說明與 `/help/commands` 逐字不變。雲端 fixture 與型別檢查，不是產品 gate；**gate 的「Mac 上用真實語音跑一次」未完成，待 George 執行**，見 [SKL-2 驗證](validation/skl-2-skills-realtime-2026-11-24.md)。

先接即時語音，是因為這兩條路徑已經有經過登記表的工具迴圈。文字聊天與背景任務要等 CAP-5。

### 4.5 第一批出貨技能的候選

只用現有工具就做得到的組合：

| 候選 | 用到的服務 | 說明 |
|---|---|---|
| 電影時間 | 電視、家電 | 開電視、開指定 App、調燈 |
| 早晨簡報 | 天氣、日曆 | 今天的天氣與行程一起講 |
| 出門前 | 家電、日曆 | 檢查燈與冷氣、提醒下一個行程 |
| 煮飯計時 | 定時器 | 一道菜的多個定時器一次設好 |

George 於 2026-11-24 決定 SKL-1 先做「早晨簡報」一份。這些只是候選；實際能做到哪一步，要等 SKL-2 在 Mac 上跑過才知道。

## 5. 產品紅線與誠實規則對照

| 規則 | 本提案的處理 |
|---|---|
| 不建立 App launcher、常駐側欄、Dashboard | 總表與技能都沒有常駐畫面。`/help/commands` 是既有的、使用者主動打開的說明頁 |
| 每個 Surface 有 `visibility_reason` | CAP-3 的回答與 SKL-3 的確認畫面都由當次請求觸發 |
| 外部副作用須經 Action Gate | 技能不改變任何工具的 `effect` 或確認方式。`external_commit` 目前一律拒絕，本提案不動它 |
| 生成 UI 不得取得 shell、檔案系統 | 技能只有文字。SKL-3 寫檔由核心做，路徑與檔名由核心決定，模型只提供名稱與內文，且有長度與字元限制 |
| mock 要標示 | 總表每筆帶 `mock`；模擬工具不列在給人看的表 |
| 不顯示假成功 | 即時總表照實列出不可用與原因；技能只在工具都可用時列出 |
| 模型不能自行啟用工具 | 不變。啟用仍然只來自核心設定 |
| 現階段功能便利性優先 | 兩組批次都是為了讓加功能變快、讓人知道能說什麼，沒有新增權限機制 |

Spotify 語音控制仍然是 SP-2 BLOCKED，本提案不改。

SKL-3 有一個要知道的性質：存下來的技能是「以後的模型會照著做的文字」。所以 SKL-3 一定先顯示內容、使用者確認才存，而且技能做不到任何現有工具做不到的事。

## 6. 待 George 決定

1. **批次與順序**：同意 CAP／SKL 的切法與「CAP-1 → CAP-2 → SKL-1 → SKL-2 → CAP-3 → SKL-3」嗎？
2. **第一批技能**：§4.5 的候選選哪兩份，或另外指定？
3. **腦區連動**：要不要讓「工具呼叫」成為腦區動畫的新來源（每個工具在總表上標 `domain`）？CLAUDE.md 目前寫明來源只能是任務步驟的 `domain` 或對話主題分類，所以這是規則變更，預設不做。
4. **家裡自己存的技能**：全家共用一份，還是每個人各自一份（接家人辨識）？建議先全家共用。
5. **出貨技能的雙語**：`SKILL.md` 是給模型看的做法。建議比照 `.agents/skills/verify-aios` 提供兩種語言的檔，模型依介面語言讀對應那份。
6. **9 個頁面工具**（CAP-4）：要不要也納入總表？納入後指令表只剩一個來源，但要動 `shared/voice-commands.ts` 與它的測試。

### 6.1 George 的決定（2026-11-24）

| 項目 | 決定 | 對批次的影響 |
|---|---|---|
| 1 批次與順序 | 同意 | 照 CAP-1 → CAP-2 → SKL-1 → SKL-2 → CAP-3 → SKL-3；CAP-4、CAP-6 排在這之後，順序另定 |
| 2 第一批技能 | 先做「早晨簡報」 | SKL-1 出貨 1 份，不是原先寫的 2 份 |
| 3 腦區連動 | 要 | `ToolCatalogInfo` 加 `domain` 欄（CAP-1 只放資料並檢查）；動畫接線是 CAP-6。CLAUDE.md「使用者指定的設計要求」的連動來源加上「工具呼叫」 |
| 4 家裡自己存的技能 | 先全家共用 | SKL-3 不接家人辨識 |
| 5 出貨技能的雙語 | 要 | 每份技能中英文各一份 |
| 6 9 個頁面工具 | 要納入 | CAP-1 先讓總表列得出這 9 個工具（資料）；`ASK_THE_AI` 改由總表產生是 CAP-4 |

第 3 項的界線：亮起的來源必須是真實的工具呼叫事件，不是模型內部活動；沒有呼叫就不亮。

## 7. 數字的計算方式

- **32 個工具 ID**：在 `prototype/ambient-shell` 執行 `grep -rhoE '"app\.[a-z_]+\.[a-z_]+"' server/integrations/adapters | sort -u | wc -l`，2026-11-24 在 main `fd2198b` 得到 32。這是字串計數，不是執行期的註冊數；CAP-1 的靜態總表做出來後以它為準。
- **8 個已審核 Adapter**：`server/integrations/index.ts` 的 `KNOWN_ADAPTERS` 有 8 個鍵。
- **9 個頁面工具**：`shared/realtime-route.ts` 的 `HOST_TOOL_NAMES` 有 9 個元素。
- **`capabilities()` 沒有呼叫端**：`grep -rn "\.capabilities(" server src tests --include=*.ts`，扣掉 `live-route.ts` 裡無關的 `options.capabilities()` 後沒有結果。
- **沒有技能的程式**：`grep -rniE "skill|技能" server shared src --include=*.ts -l` 沒有結果。

## 8. 資料來源（2026-11-24 查核）

Omarchy，`omacom/omarchy` 的 `quattro` 分支，MIT 授權：

- [repo](https://github.com/omacom/omarchy)、[官網](https://omarchy.org/)
- `bin/omarchy`（分派與總表）、`bin/omarchy-agent-skills-link`（技能連結）
- `agents/skills/command-metadata.md`（指令的註解資料）
- `default/agents/skills/omarchy/SKILL.md`（出貨技能）
- `default/omarchy/omarchy-menu.jsonc`、`docs/menu.md`（選單）
- `manual/14-omarchy-cli.md`、`manual/17-ai.md`、`AGENTS.md`

Nous：本文 §2 列出的檔案，以及 [18](18_App_Integration_Layer_and_Spotify_2026-11.md)、[23](23_Architecture_Review_2026-11.md)、[S8 驗證紀錄](validation/architecture-s8-tool-names-2026-11-10.md)、[06](06_Ambient_Voice_Gaze_Experience.md)。
