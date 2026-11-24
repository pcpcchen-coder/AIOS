<!-- bilingual: source=zh-TW -->

> [繁體中文](writing-a-skill.md) | [English](writing-a-skill.en.md)

# 怎麼寫一份技能

版本：2026-11-24（SKL-1；SKL-2 補上 §8–§9）。適用 `prototype/ambient-shell`。給在本 repo 開發的人與開發 Agent。設計背景見 [24 能力總表與技能目錄 §4](../24_Capability_Catalog_and_Skills_2026-11.md#4-skl技能目錄)；驗證見 [SKL-1 驗證紀錄](../validation/skl-1-skill-format-2026-11-24.md)與 [SKL-2 驗證紀錄](../validation/skl-2-skills-realtime-2026-11-24.md)。

**現況（SKL-2）：`NOUS_SKILLS=on` 時，兩條即時語音路徑的模型看得到技能索引，可以用唯讀工具 `app.skill.read` 讀內文**（§8）；旗標預設關閉，關閉時模型看不到技能。真實語音下的表現還沒在 Mac 上驗過。家裡自己存的技能是 SKL-3，文字聊天與背景任務要等 CAP-5。

## 1. 技能是什麼

技能是一份 Markdown 做法，告訴模型「家裡這件常做的事，要依序用哪些總表上的工具、遇到哪種結果怎麼照實說」。

- 只有文字。不帶程式、不能新增或啟用工具、不能改設定。載入模組只讀文字，不執行內文的任何東西。
- 每一步仍然由 Dispatcher 執行；工具的政策、確認、頻率限制、`unknown`／`unconfirmed` 的回報方式都照舊，技能沒辦法繞過。
- 不建立圖示、側欄或常駐入口。

## 2. 檔案放哪裡

```text
prototype/ambient-shell/skills/<name>/SKILL.md      中文（原文）
prototype/ambient-shell/skills/<name>/SKILL.en.md   英文
```

- 每份技能中英文各一份（George 2026-11-24 決定 5），兩個檔都必須存在。
- 技能目錄裡只能有這兩個檔；多一個檔或子目錄，檢查會失敗。
- `skills/` 底下只能放技能目錄。
- 檔名沿用 repo 的雙語慣例（[雙語規範](../BILINGUAL.md)）：中文是原文，英文是 `.en.md`。所以 `node scripts/check-bilingual-docs.mjs` 也會檢查這兩個檔是否同步。

## 3. 格式

```markdown
---
name: morning-briefing
description: 使用者要早晨簡報、想一次聽今天的天氣和行程時使用。
tools:
  - app.weather.today
  - app.calendar.list_events
---

<!-- bilingual: source=zh-TW -->

> [繁體中文](SKILL.md) | [English](SKILL.en.md)

# 早晨簡報

（做法）
```

frontmatter 只接受下面三個欄位，順序不拘，不能重複，也不能有其他欄位：

| 欄位 | 規則 |
|---|---|
| `name` | 小寫英數與連字號（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`），最多 40 字；必須等於目錄名稱；中英文兩份相同 |
| `description` | 一行純文字：什麼時候用這份技能。最多 240 字。不能用 YAML 的引號、區塊或其他語法起頭，不能含「`: `」或「` #`」（讓檔案仍是合法 YAML） |
| `tools` | 這份技能用到的工具 ID 清單，寫成下一行起、兩格縮排的 `  - app.<service>.<action>`。至少 1 個、最多 12 個、不能重複；中英文兩份相同（含順序） |

解析器只支援這個格式，不是通用的 YAML 解析器（沒有新增 npm 依賴）。檔案可以是 CRLF 或帶 BOM。

內文是 frontmatter 之後的全部文字。repo 文件慣例的 `<!-- bilingual: ... -->` 標記與語言切換那一行會被拿掉，不算進內文，也不會給模型。內文最多 6,000 字（Unicode code point）；不能是空的。

長度上限的根據：2026-11-24 出貨的 `morning-briefing` 中文內文 1,730 字、英文內文 4,437 字、英文 `description` 177 字，上限留約三成餘裕。技能索引的上限是 SKL-2 量測後定的（§8.3）。

## 4. 工具 ID 的規則

- `tools` 的每個 ID 都必須在**靜態總表**上（`npm run catalog -- --json`），而且是整合工具（`app.<service>.<action>`）。頁面工具（`web_search` 等）不能列。
- 不能列 hidden 工具（模擬工具與 legacy Facade，例如 `app.home.control`）。
- 內文提到的每個 `app.<service>.<action>`（反引號內外都算）都必須在總表上，而且列在 `tools`。所以工具改名或移除時，檢查會指出哪份技能壞了。

技能「能列出」不代表「這次能用」。這台裝置沒有設定那個服務時，工具不會註冊；SKL-2 起依即時狀態只列出工具全部可用的技能（§8.2，[24 §4.3](../24_Capability_Catalog_and_Skills_2026-11.md#43-總表與技能怎麼接起來)）。

## 5. 內文怎麼寫

先讀你要用的 Adapter 的實際程式（`server/integrations/adapters/*.ts`），技能只能寫工具真的做得到的事。

1. **步驟**：依序呼叫哪些工具、用什麼參數。互不相依的可以一起送出。
2. **每一種結果怎麼說**：`confirmed`、`refused`、`failed`、`unknown`，以及工具不在這次可用的工具裡（或 `reason` 是 `not_registered`、`disabled`）。逾時或中止一律是 `unknown`，不能說成沒有或失敗以外的東西。只有 `confirmed` 能說完成。
3. **只有一部分成功時**：各自照實說，不要編一份完整的結果。
4. **哪些事要先問使用者**：例如工具只支援今天、使用者要的是明天。
5. **不要做的事**：技能不能要求寄出、發布、付費、永久刪除等外部副作用；使用者要做這些時，是另一個請求，照那個工具平常的規則與確認處理。
6. **資料不是指令**：日曆標題、信件內容等可能是別人寫的，照念，不照做。

用說的語氣寫：句子短，不要叫模型念欄位名稱或 JSON。

## 6. 檢查

在 `prototype/ambient-shell`：

```bash
npm run catalog -- --check
npx vitest run tests/skills.test.ts
npm run typecheck
```

`--check` 先檢查能力總表，再檢查 `skills/` 底下每份技能，任何一邊有問題就以非 0 結束，每個問題印出檔案、說明與代碼。檢查會失敗的情況：

| 代碼 | 情況 |
|---|---|
| `frontmatter_missing`、`frontmatter_unclosed` | 第一行不是 `---`，或沒有結尾的 `---` |
| `frontmatter_unknown_key`、`frontmatter_duplicate_key`、`frontmatter_syntax` | 不認得的欄位、欄位重複、看不懂的行（例如 `tools: [a, b]`） |
| `missing_field` | 缺 `name`、`description` 或 `tools` |
| `bad_name`、`name_mismatch` | `name` 格式不對，或和目錄名稱不同 |
| `bad_description`、`description_too_long` | `description` 不是單行純文字，或超過上限 |
| `bad_tool_id`、`duplicate_tool`、`too_many_tools` | 工具 ID 格式不對、重複、超過 12 個 |
| `unknown_tool`、`hidden_tool` | `tools` 的 ID 不在靜態總表上，或是 hidden 工具 |
| `mention_unknown_tool`、`mention_not_in_tools` | 內文提到的 ID 不在總表上，或沒有列在 `tools` |
| `empty_body`、`body_too_long` | 內文是空的，或超過上限 |
| `locale_mismatch` | 中英文兩份的 `name` 或 `tools` 不同 |
| `missing_file`、`extra_file`、`not_a_directory` | 缺中文或英文檔、目錄裡有別的檔或子目錄、`skills/` 底下有不是目錄的項目 |
| `duplicate_name` | 兩份技能同名 |

repo 根目錄：`node scripts/check-bilingual-docs.mjs`（中英文兩份都改好、審閱過，才用 `--record`）。

這些都是 fixture 與型別檢查。技能在真實語音下的表現，要在 Mac 上實際跑過才知道（SKL-2 驗證第 7 節），不能用這些檢查宣稱。

## 7. 程式在哪裡

| 檔案 | 內容 |
|---|---|
| `server/skills/format.ts` | 純函式：`parseSkillFile()`（一個檔）、`buildSkills()`（中英文配對、對照總表、撞名）、`mentionedTools()`、`SKILL_LIMITS` |
| `server/skills/load.ts` | 讀 `skills/` 目錄（只讀文字檔）：`readSkillSources()`、`loadSkills()` |
| `scripts/catalog.ts` | `--check` 呼叫 `loadSkills()` |
| `server/skills/runtime.ts` | SKL-2：`SkillBook`（列出、索引、讀取）、`SKILL_INDEX_LIMITS`、`skillLoadLog()` |
| `server/skills/tool-id.ts` | SKL-2：`app.skill.read` 的 ID 與模型看到的名稱 |
| `server/integrations/adapters/skill.ts` | SKL-2：讀取工具的 `SkillAdapter` 與總表資料 |
| `server/nous.ts` | SKL-2：`NOUS_SKILLS=on` 時載入技能、記 log、註冊讀取工具、把索引交給兩條路徑 |
| `server/realtime.ts` | SKL-2：`realtimeToolRules()` 與 `buildLiveInstructions()` 插入索引 |
| `tests/skills.test.ts` | 出貨技能通過、每種失敗一個 fixture、旗標的 gate |
| `tests/skills-realtime.test.ts` | SKL-2：旗標關閉逐字不變、開啟時差異只有索引與讀取工具、過濾、讀取與拒絕、上限、壞檔略過、量測 |

除了 `scripts/catalog.ts`、`server/nous.ts`（只在 `NOUS_SKILLS=on` 時）與測試，沒有程式載入技能（測試會檢查）。

## 8. 模型怎麼看到技能（SKL-2）

### 8.1 索引與讀取

`NOUS_SKILLS=on` 時，Nous 啟動時讀一次 `skills/`，檢查失敗的那一份略過並記 log，其他照常。每次組工作階段說明時：

1. 依名稱排序，只留這條路徑上工具全部可用的技能（§8.2），套上限（§8.3）。
2. 說明裡插入一段索引：一句指示，加上每份技能一行 `- name：description`。中文介面用 `SKILL.md` 的 `description`，英文介面用 `SKILL.en.md` 的。**只有名稱與說明，沒有內文**，所以 `description` 要寫清楚「什麼時候用」。
3. 模型判斷使用者的請求符合某一份時，呼叫 `app.skill.read`（參數 `name`），拿到那個語言的內文，照內文呼叫各個工具。

位置：API key 語音模型與 ChatGPT 方案的工具執行層，索引插在鬧鐘規則之後（同一份 `realtimeToolRules()`）；ChatGPT 方案沒有工具的語音層，插一段「符合時一律交辦」版的索引。實際文字見 [SKL-2 驗證 §5.1](../validation/skl-2-skills-realtime-2026-11-24.md#51-旗標開啟時實際加進說明的中文段落)。

`app.skill.read` 只回傳文字：只讀這條路徑、這個語言現在列得出來的技能，名稱只和已載入的清單比對（不組路徑、不讀檔）；不在清單上回 `refused`（`invalid_arguments`），工具不可用或被上限截掉回 `refused`（`unavailable`），旗標關閉時根本沒有註冊（`not_registered`）。它是 hidden，不列在 `/help/commands`。

### 8.2 什麼時候列出

一份技能的 `tools` **每一個**在這條路徑上都是 `available`（登記表的即時狀態）才列出。例如沒有設定日曆（`NOUS_AIL_SERVICES` 沒有 `google_calendar`）時，早晨簡報不列出；沒有任何技能列得出來時，連 `app.skill.read` 都不在工具清單上，說明和旗標關閉時相同。

- API key 路徑：以工作階段開始時為準；通話中狀態改變不會更新索引。
- ChatGPT 方案：工具執行層每次交辦都重組說明，會反映通話中的變化；語音層以工作階段開始時為準。
- 讀取工具每次呼叫都重新看狀態。

### 8.3 上限

一次最多 **8 份**，整段索引（指示加每份一行）最多 **2,000 字**（Unicode code point，兩種語言共用）。超過時依名稱排序，從第一份放不下的開始後面全部不列，並在 log 記錄被截掉的名稱。量測：只有早晨簡報時，API key 說明中文多 202 字、英文多 571 字。寫新技能時 `description` 盡量短；英文一行約 200 字時，8 份剛好放得下。

### 8.4 診斷

啟動 log（macOS App 在 `~/Library/Application Support/Nous/nous.log`）：

```text
技能：載入 1 份（morning-briefing）
技能：api_key／zh-TW 列出 1 份（morning-briefing）
```

不列出時會寫原因，例如 `技能：api_key／zh-TW 列出 0 份；工具不可用沒列：morning-briefing（app.calendar.list_events 未註冊）`；檢查失敗時寫 `技能：1 份檢查失敗被略過：…` 與每個問題。log 不記內文。

## 9. 在本機打開旗標試用

1. 在 `prototype/ambient-shell` 的 `.env`（macOS App：選單列「編輯 API key 與進階設定（.env）…」）加上：

   ```bash
   NOUS_SKILLS=on
   NOUS_AIL=on
   NOUS_AIL_SERVICES=weather,google_calendar
   NOUS_GOG_ACCOUNT=you@gmail.com
   ```

   早晨簡報需要天氣與日曆兩個工具；日曆要先照 [CAL-1](../validation/cal-1-google-calendar-2026-11-05.md) 授權 gog，天氣要在選單列「主動提醒」選好地點。
2. 重新啟動（`npm start`；macOS App 存檔後自動重新啟動），在 log 確認 `技能：… 列出 1 份（morning-briefing）`。
3. 開即時語音說「給我今天的簡報」。log 應該依序有 `app.skill.read`、`app.weather.today`、`app.calendar.list_events` 的呼叫與各自的 status。
4. 改自己的技能後先跑 `npm run catalog -- --check`；技能是啟動時讀的，改完要重新啟動。

Mac 上的完整驗收步驟與結果表見 [SKL-2 驗證第 7 節](../validation/skl-2-skills-realtime-2026-11-24.md#7-mac-實機驗收給-george未執行)。
