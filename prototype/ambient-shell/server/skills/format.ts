import type { CatalogEntry } from "../integrations/catalog.ts";

// SKL-1（docs/24 §4）：技能的格式、解析與檢查。全部是純函式：輸入是檔案文字，輸出是結構化結果與明確的問題清單。
// 技能只有文字。這裡只「讀」：不執行、不 eval、不依內文做任何事，也不新增或啟用工具（工具只來自登記表）。
// 這一批模型看不到技能（索引與 app.skill.read 是 SKL-2）；只有 scripts/catalog.ts 與測試用到這個模組。
// 格式說明見 docs/development/writing-a-skill.md。

/** 一份技能目錄裡的兩個檔：中文是原文（SKILL.md），英文是 SKILL.en.md。George 2026-11-24 決定 5：中英文各一份。 */
export const SKILL_FILES = { "zh-TW": "SKILL.md", en: "SKILL.en.md" } as const;
export type SkillLocale = keyof typeof SKILL_FILES;
export const SKILL_LOCALES = Object.keys(SKILL_FILES) as SkillLocale[];

/**
 * 長度上限（Unicode code point）。2026-11-24 量測出貨的 morning-briefing：中文內文 1,730、英文內文 4,437、英文 description 177。
 * 上限留約三成餘裕；SKL-2 量測技能索引的實際字數後才決定索引列幾份（docs/24 §4.3）。
 */
export const SKILL_LIMITS = { name: 40, description: 240, body: 6_000, tools: 12 } as const;

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TOOL_ID = /^app\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** 內文裡提到的工具 ID（反引號內外都算）。 */
const TOOL_MENTION = /\bapp\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/g;
const KEYS = ["name", "description", "tools"] as const;
/** 為了讓檔案仍是合法的 YAML，description 只接受單行的純文字（不能用 YAML 的引號、區塊或其他語法起頭）。 */
const YAML_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** 檢查會回報的問題代碼（docs/development/writing-a-skill.md §6 的表）。 */
export const SKILL_PROBLEM_CODES = [
  "missing_file",
  "extra_file",
  "not_a_directory",
  "frontmatter_missing",
  "frontmatter_unclosed",
  "frontmatter_unknown_key",
  "frontmatter_duplicate_key",
  "frontmatter_syntax",
  "missing_field",
  "bad_name",
  "name_mismatch",
  "bad_description",
  "description_too_long",
  "bad_tool_id",
  "duplicate_tool",
  "too_many_tools",
  "unknown_tool",
  "hidden_tool",
  "mention_not_in_tools",
  "mention_unknown_tool",
  "empty_body",
  "body_too_long",
  "locale_mismatch",
  "duplicate_name",
] as const;
export type SkillProblemCode = (typeof SKILL_PROBLEM_CODES)[number];

export interface SkillProblem {
  /** 出問題的檔或目錄（相對於技能根目錄，例如 morning-briefing/SKILL.en.md）。 */
  where: string;
  code: SkillProblemCode;
  message: string;
}

/** 一個檔解析後的內容。body 已去掉 frontmatter、雙語標記與語言切換那一行。 */
export interface SkillFile {
  name: string;
  description: string;
  tools: string[];
  body: string;
}

/** 一份檢查通過的技能。 */
export interface Skill {
  name: string;
  tools: readonly string[];
  locales: Readonly<Record<SkillLocale, { description: string; body: string }>>;
}

/** 讀檔的結果（還沒解析）：目錄名稱與目錄裡每個項目。files 的值是 null 代表那一項不是一般檔案。 */
export interface SkillSource {
  dir: string;
  files: Readonly<Record<string, string | null>>;
}

const length = (text: string) => [...text].length;

/** 只支援本格式的 frontmatter：`key: value` 單行，或 `tools:` 後面接 `  - item` 清單。不是通用 YAML 解析器。 */
export function parseSkillFile(text: string, where: string): { ok: true; value: SkillFile } | { ok: false; problems: SkillProblem[] } {
  const problems: SkillProblem[] = [];
  const fail = (code: SkillProblemCode, message: string) => problems.push({ where, code, message });
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") {
    fail("frontmatter_missing", "第一行必須是 ---（frontmatter 開頭）");
    return { ok: false, problems };
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    fail("frontmatter_unclosed", "frontmatter 沒有結尾的 ---");
    return { ok: false, problems };
  }
  const fields = new Map<string, string | string[]>();
  let list: string[] | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const at = `第 ${i + 1} 行`;
    if (!line.trim()) continue;
    const item = /^ {2}- (.*)$/.exec(line);
    if (item) {
      if (!list) fail("frontmatter_syntax", `${at}：清單項目前面要有 tools:`);
      else list.push(item[1]!.trim());
      continue;
    }
    const kv = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!kv) {
      fail("frontmatter_syntax", `${at}：看不懂（只接受 key: value 或兩格縮排的 - item）：${line}`);
      list = null;
      continue;
    }
    const [, key, raw] = kv;
    const value = (raw ?? "").trim();
    list = null;
    if (!(KEYS as readonly string[]).includes(key!)) {
      fail("frontmatter_unknown_key", `${at}：不認得的欄位 ${key}（只有 ${KEYS.join("、")}）`);
      continue;
    }
    if (fields.has(key!)) {
      fail("frontmatter_duplicate_key", `${at}：${key} 重複`);
      continue;
    }
    if (key === "tools") {
      if (value) fail("frontmatter_syntax", `${at}：tools 要寫成下一行起的清單（  - app.<service>.<action>）`);
      list = [];
      fields.set(key, list);
    } else {
      fields.set(key!, value);
    }
  }

  const name = fields.get("name");
  const description = fields.get("description");
  const tools = fields.get("tools");
  if (typeof name !== "string" || !name) fail("missing_field", "缺 name");
  else if (length(name) > SKILL_LIMITS.name || !NAME.test(name)) fail("bad_name", `name 要是小寫英數與連字號（例如 morning-briefing），最多 ${SKILL_LIMITS.name} 字：${name}`);
  if (typeof description !== "string" || !description) fail("missing_field", "缺 description");
  else if (YAML_INDICATOR.test(description) || /: | #/.test(description)) fail("bad_description", "description 要是單行純文字，不能用引號或 YAML 語法起頭，也不能含「: 」或「 #」");
  else if (length(description) > SKILL_LIMITS.description) fail("description_too_long", `description 有 ${length(description)} 字，上限 ${SKILL_LIMITS.description}`);
  if (!Array.isArray(tools) || !tools.length) fail("missing_field", "缺 tools（至少列一個工具 ID）");
  else {
    if (tools.length > SKILL_LIMITS.tools) fail("too_many_tools", `tools 有 ${tools.length} 個，上限 ${SKILL_LIMITS.tools}`);
    const seen = new Set<string>();
    for (const id of tools) {
      if (!TOOL_ID.test(id)) fail("bad_tool_id", `tools 的 ${id} 不是 app.<service>.<action> 格式`);
      if (seen.has(id)) fail("duplicate_tool", `tools 的 ${id} 重複`);
      seen.add(id);
    }
  }

  const body = stripDocChrome(lines.slice(end + 1).join("\n")).trim();
  if (!body) fail("empty_body", "內文是空的");
  else if (length(body) > SKILL_LIMITS.body) fail("body_too_long", `內文有 ${length(body)} 字，上限 ${SKILL_LIMITS.body}`);

  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { name: name as string, description: description as string, tools: tools as string[], body } };
}

/** repo 文件慣例的雙語標記與語言切換連結（docs/BILINGUAL.md）不是給模型的做法，從內文拿掉。 */
function stripDocChrome(text: string): string {
  return text.replace(/^<!-- bilingual:.*-->[ \t]*$/gm, "").replace(/^> \[繁體中文\]\(.*\) \| \[English\]\(.*\)[ \t]*$/gm, "");
}

/** 內文提到的工具 ID（不重複，依出現順序）。 */
export function mentionedTools(body: string): string[] {
  return [...new Set(body.match(TOOL_MENTION) ?? [])];
}

/**
 * 從讀到的目錄建立技能並檢查。catalog 是靜態總表（staticCatalog()）：tools 與內文提到的工具 ID 都要在總表上、
 * 是整合工具（app.<service>.<action>）、不是 hidden。有任何問題的技能不會出現在 skills。
 */
export function buildSkills(sources: readonly SkillSource[], catalog: readonly CatalogEntry[]): { skills: Skill[]; problems: SkillProblem[] } {
  const known = new Map(catalog.filter((e) => e.kind === "integration").map((e) => [e.id, e]));
  const problems: SkillProblem[] = [];
  const skills: Skill[] = [];
  const owners = new Map<string, string>();
  for (const source of [...sources].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const before = problems.length;
    const add = (where: string, code: SkillProblemCode, message: string) => problems.push({ where, code, message });
    const expected = new Set<string>(Object.values(SKILL_FILES));
    for (const [file, text] of Object.entries(source.files)) {
      if (!expected.has(file)) add(`${source.dir}/${file}`, "extra_file", `技能目錄只能有 ${[...expected].join(" 與 ")}（技能只有文字，不帶程式或其他檔）`);
      else if (text === null) add(`${source.dir}/${file}`, "extra_file", "不是一般檔案");
    }
    const parsed: Partial<Record<SkillLocale, SkillFile>> = {};
    for (const locale of SKILL_LOCALES) {
      const where = `${source.dir}/${SKILL_FILES[locale]}`;
      const text = source.files[SKILL_FILES[locale]];
      if (typeof text !== "string") {
        if (text === undefined) add(where, "missing_file", `缺 ${SKILL_FILES[locale]}（中英文各一份）`);
        continue;
      }
      const result = parseSkillFile(text, where);
      if (!result.ok) {
        problems.push(...result.problems);
        continue;
      }
      const file = result.value;
      parsed[locale] = file;
      if (file.name !== source.dir) add(where, "name_mismatch", `name 是 ${file.name}，目錄是 ${source.dir}（兩者要相同）`);
      for (const id of file.tools) {
        const entry = known.get(id);
        if (!entry) add(where, "unknown_tool", `tools 的 ${id} 不在能力總表上（npm run catalog -- --json）`);
        else if (entry.hidden) add(where, "hidden_tool", `tools 的 ${id} 是 hidden 工具（模擬或 legacy Facade），技能不能用`);
      }
      for (const id of mentionedTools(file.body)) {
        if (!known.has(id)) add(where, "mention_unknown_tool", `內文提到的 ${id} 不在能力總表上`);
        else if (!file.tools.includes(id)) add(where, "mention_not_in_tools", `內文提到的 ${id} 沒有列在 tools`);
      }
    }
    const zh = parsed["zh-TW"];
    const en = parsed.en;
    if (zh && en) {
      if (zh.name !== en.name) add(`${source.dir}/${SKILL_FILES.en}`, "locale_mismatch", `中英文的 name 不同：${zh.name}／${en.name}`);
      if (zh.tools.join("\n") !== en.tools.join("\n")) add(`${source.dir}/${SKILL_FILES.en}`, "locale_mismatch", `中英文的 tools 不同（含順序）：${zh.tools.join(", ")}／${en.tools.join(", ")}`);
    }
    for (const name of new Set([zh?.name, en?.name].filter((n): n is string => Boolean(n)))) {
      const prior = owners.get(name);
      if (prior && prior !== source.dir) add(source.dir, "duplicate_name", `技能名稱 ${name} 撞名（${prior} 與 ${source.dir}）`);
      else owners.set(name, source.dir);
    }
    if (problems.length === before && zh && en) {
      skills.push({ name: zh.name, tools: [...zh.tools], locales: { "zh-TW": { description: zh.description, body: zh.body }, en: { description: en.description, body: en.body } } });
    }
  }
  return { skills, problems };
}
