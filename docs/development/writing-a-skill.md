<!-- bilingual: source=zh-TW -->

> [繁體中文](writing-a-skill.md) | [English](writing-a-skill.en.md)

# 怎麼寫一份技能

版本：2026-11-24（SKL-1）。適用 `prototype/ambient-shell`。給在本 repo 開發的人與開發 Agent。設計背景見 [24 能力總表與技能目錄 §4](../24_Capability_Catalog_and_Skills_2026-11.md#4-skl技能目錄)；這一批的驗證見 [SKL-1 驗證紀錄](../validation/skl-1-skill-format-2026-11-24.md)。

**現況：模型還看不到技能。** SKL-1 只有格式、解析與檢查，加上一份出貨技能「早晨簡報」。技能索引進工作階段說明、唯讀工具 `app.skill.read` 都是 SKL-2；家裡自己存的技能是 SKL-3。旗標 `NOUS_SKILLS`（預設關閉）在 SKL-1 沒有任何程式讀它，SKL-2 才會用到。

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

長度上限的根據：2026-11-24 出貨的 `morning-briefing` 中文內文 1,730 字、英文內文 4,437 字、英文 `description` 177 字，上限留約三成餘裕。技能索引一次列幾份、佔多少字，要等 SKL-2 量測後再定。

## 4. 工具 ID 的規則

- `tools` 的每個 ID 都必須在**靜態總表**上（`npm run catalog -- --json`），而且是整合工具（`app.<service>.<action>`）。頁面工具（`web_search` 等）不能列。
- 不能列 hidden 工具（模擬工具與 legacy Facade，例如 `app.home.control`）。
- 內文提到的每個 `app.<service>.<action>`（反引號內外都算）都必須在總表上，而且列在 `tools`。所以工具改名或移除時，檢查會指出哪份技能壞了。

技能「能列出」不代表「這次能用」。這台裝置沒有設定那個服務時，工具不會註冊；SKL-2 才會依即時總表只列出工具全部可用的技能（[24 §4.3](../24_Capability_Catalog_and_Skills_2026-11.md#43-總表與技能怎麼接起來)）。

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

這些都是 fixture 與型別檢查。技能在真實語音下的表現，要等 SKL-2 在 Mac 上實際跑過才知道，不能用這些檢查宣稱。

## 7. 程式在哪裡

| 檔案 | 內容 |
|---|---|
| `server/skills/format.ts` | 純函式：`parseSkillFile()`（一個檔）、`buildSkills()`（中英文配對、對照總表、撞名）、`mentionedTools()`、`SKILL_LIMITS` |
| `server/skills/load.ts` | 讀 `skills/` 目錄（只讀文字檔）：`readSkillSources()`、`loadSkills()` |
| `scripts/catalog.ts` | `--check` 呼叫 `loadSkills()` |
| `tests/skills.test.ts` | 出貨技能通過、每種失敗一個 fixture、旗標與「模型看不到」的 gate |

SKL-1 除了 `scripts/catalog.ts` 與測試，沒有任何程式 import `server/skills/`（測試會檢查），所以模型、工作階段說明與 `/help/commands` 都不會看到技能。
