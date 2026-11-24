import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config.ts";
import { GoogleCalendarAdapter } from "../server/integrations/adapters/google-calendar.ts";
import { WeatherAdapter } from "../server/integrations/adapters/weather.ts";
import { staticCatalog } from "../server/integrations/catalog.ts";
import type { ExecutionContext } from "../server/integrations/contracts.ts";
import { buildSkills, mentionedTools, parseSkillFile, SKILL_LIMITS, SKILL_PROBLEM_CODES, type SkillProblemCode } from "../server/skills/format.ts";
import { loadSkills, SHIPPED_SKILLS_DIR } from "../server/skills/load.ts";
import type { WeatherService } from "../server/weather.ts";
import { TOOL_RESULT_REASONS, TOOL_RESULT_STATUSES } from "../shared/integrations.ts";
import { RAIN_MENTION_PERCENT, SCHEDULE_MAX, UMBRELLA_PERCENT } from "../shared/proactive.ts";
import { commandsPageOutputs } from "./fixtures/commands-page.ts";
import { modelToolOutputs } from "./fixtures/model-tools.ts";

// SKL-1（docs/24 §4）：技能的格式、解析與檢查。全部是 fixture 與型別檢查，不是產品 gate，也不是 Mac 實機驗收；
// 「早晨簡報」在真實語音下的表現要到 SKL-2 在 Mac 上跑過才知道。
// 失敗情況的 fixture 在測試時寫進暫存目錄（放進 repo 的 .md 會被雙語檢查當成文件）。

const shellDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, string>;

const skillText = (o: { name?: string; description?: string; tools?: string[]; body?: string; extra?: string } = {}) => {
  const lines = ["---"];
  if (o.name !== "") lines.push(`name: ${o.name ?? "sample"}`);
  if (o.description !== "") lines.push(`description: ${o.description ?? "測試用的技能。"}`);
  if (o.extra) lines.push(o.extra);
  const tools = o.tools ?? ["app.weather.today"];
  if (tools.length) lines.push("tools:", ...tools.map((t) => `  - ${t}`));
  lines.push("---", "", o.body ?? "呼叫 `app.weather.today`，照實說結果。");
  return `${lines.join("\n")}\n`;
};

/** 在暫存目錄寫一棵技能樹：{ "<dir>/<file>": 內容 }。 */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nous-skills-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const pair = (dir: string, zh: Parameters<typeof skillText>[0] = {}, en: Parameters<typeof skillText>[0] = zh) => ({
  [`${dir}/SKILL.md`]: skillText({ name: dir, ...zh }),
  [`${dir}/SKILL.en.md`]: skillText({ name: dir, description: "A skill for tests.", body: "Call `app.weather.today` and report the result truthfully.", ...en }),
});

const codes = (root: string) => loadSkills(root).problems.map((p) => p.code);

describe("shipped skills", () => {
  const loaded = loadSkills();

  it("all pass the check: exactly one skill, morning-briefing, in both languages (George 2026-11-24 decisions 2 and 5)", () => {
    expect(loaded.problems).toEqual([]);
    expect(loaded.skills.map((s) => s.name)).toEqual(["morning-briefing"]);
    expect(readdirSync(SHIPPED_SKILLS_DIR)).toEqual(["morning-briefing"]);
  });

  it("morning-briefing uses only the weather and calendar read tools, which are on the catalog, not hidden, and read-only", () => {
    const skill = loaded.skills[0]!;
    expect(skill.tools).toEqual(["app.weather.today", "app.calendar.list_events"]);
    const catalog = new Map(staticCatalog().map((e) => [e.id, e]));
    for (const id of skill.tools) expect(catalog.get(id)).toMatchObject({ kind: "integration", hidden: false, effect: "read" });
    for (const locale of ["zh-TW", "en"] as const) expect(mentionedTools(skill.locales[locale].body)).toEqual([...skill.tools]);
  });

  it("strips the repo's bilingual marker and language links from what would be the model text, and stays under the limits", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const { body, description } = loaded.skills[0]!.locales[locale];
      expect(body).not.toMatch(/bilingual|\[English\]|\[繁體中文\]/);
      expect(body.startsWith("# ")).toBe(true);
      expect([...body].length).toBeLessThanOrEqual(SKILL_LIMITS.body);
      expect([...description].length).toBeLessThanOrEqual(SKILL_LIMITS.description);
    }
  });

  it("every backticked word in the body is a real status, reason, argument or result field of those two tools", async () => {
    const ctx: ExecutionContext = { actor: "user", route: "api_key", sessionId: "s", requestId: "r", signal: new AbortController().signal };
    const weather = new WeatherAdapter({
      place: () => "taipei",
      service: { refresh: async () => ({ place: "taipei", date: "2026-11-24", code: 61, min_c: 18, max_c: 23, rain: { part: "afternoon", percent: 60 } }) } as unknown as WeatherService,
    });
    const calendar = new GoogleCalendarAdapter({
      account: "someone@example.com",
      gogPath: "/usr/local/bin/gog",
      run: async () => ({ code: 0, stdout: JSON.stringify({ events: [{ summary: "", start: "2026-11-24", end: "2026-11-25", location: "家" }] }) }),
    });
    const w = await weather.execute("app.weather.today", {}, ctx);
    const c = await calendar.execute("app.calendar.list_events", { range: "today" }, ctx);
    expect([w.status, c.status]).toEqual(["confirmed", "confirmed"]);
    const keys = (v: unknown): string[] => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(Array.isArray(x) ? x[0] : x)]) : []);
    const schema = calendar.tools()[0]!.inputSchema as unknown as { properties: { range: { enum: string[] } } };
    const allowed = new Set<string>([
      ...staticCatalog().map((e) => e.id),
      ...TOOL_RESULT_STATUSES,
      ...TOOL_RESULT_REASONS,
      ...keys(w.data),
      ...keys(c.data),
      ...Object.keys(schema.properties),
      ...schema.properties.range.enum,
      "data",
      "message",
      "reason",
      "null",
      "morning",
      "afternoon",
      "evening",
      "YYYY-MM-DD",
    ]);
    for (const locale of ["zh-TW", "en"] as const) {
      const words = [...loaded.skills[0]!.locales[locale].body.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      expect(words.length).toBeGreaterThan(20);
      for (const word of words) expect(allowed.has(word), `${locale}: \`${word}\``).toBe(true);
    }
  });

  it("uses the same rain, umbrella and event-count thresholds as the proactive greeting (PRO-1 weatherSentence, PRO-2 SCHEDULE_MAX)", () => {
    const zh = loaded.skills[0]!.locales["zh-TW"].body;
    const en = loaded.skills[0]!.locales.en.body;
    expect(zh).toContain(`\`percent\` 至少 ${RAIN_MENTION_PERCENT}`);
    expect(zh).toContain(`至少 ${UMBRELLA_PERCENT} 才加一句「記得帶傘」`);
    expect(zh).toContain(`超過 ${SCHEDULE_MAX} 個時說前 ${SCHEDULE_MAX} 個`);
    expect(en).toContain(`\`percent\` is at least ${RAIN_MENTION_PERCENT}`);
    expect(en).toContain(`only when it is at least ${UMBRELLA_PERCENT}`);
    expect(en).toContain(`more than ${SCHEDULE_MAX} events, say the first ${SCHEDULE_MAX}`);
  });

  it("asks for no external side effect: no write tool, and the body never names a tool outside tools", () => {
    const skill = loaded.skills[0]!;
    const writes = staticCatalog().filter((e) => e.effect !== "read" && e.kind === "integration").map((e) => e.id);
    for (const locale of ["zh-TW", "en"] as const) for (const id of writes) expect(skill.locales[locale].body).not.toContain(id);
  });
});

describe("skill check fails on (fixture trees)", () => {
  const cases: [string, Record<string, string>, SkillProblemCode][] = [
    ["no frontmatter", { "sample/SKILL.md": "# 沒有 frontmatter\n", ...{ "sample/SKILL.en.md": pair("sample")["sample/SKILL.en.md"]! } }, "frontmatter_missing"],
    ["an unclosed frontmatter", { ...pair("sample"), "sample/SKILL.md": "---\nname: sample\ndescription: x\n" }, "frontmatter_unclosed"],
    ["a missing name", pair("sample", { name: "" }), "missing_field"],
    ["a missing description", pair("sample", { description: "" }), "missing_field"],
    ["missing tools", pair("sample", { tools: [] }), "missing_field"],
    ["an unknown key", pair("sample", { extra: "version: 2" }), "frontmatter_unknown_key"],
    ["a duplicate key", pair("sample", { extra: "name: other" }), "frontmatter_duplicate_key"],
    ["tools written inline", { ...pair("sample"), "sample/SKILL.md": "---\nname: sample\ndescription: x\ntools: [app.weather.today]\n---\n\nbody\n" }, "frontmatter_syntax"],
    ["a line that is not key: value", pair("sample", { extra: "just some words" }), "frontmatter_syntax"],
    ["a badly formed name", { "Sample/SKILL.md": skillText({ name: "Sample" }), "Sample/SKILL.en.md": skillText({ name: "Sample" }) }, "bad_name"],
    ["a quoted (YAML) description", pair("sample", { description: '"quoted"' }), "bad_description"],
    ["a description over the limit", pair("sample", { description: "長".repeat(SKILL_LIMITS.description + 1) }), "description_too_long"],
    ["name differs from the directory", pair("sample", { name: "other" }, { name: "other" }), "name_mismatch"],
    ["a tool ID that is not app.<service>.<action>", pair("sample", { tools: ["web_search"] }), "bad_tool_id"],
    ["a tool listed twice", pair("sample", { tools: ["app.weather.today", "app.weather.today"] }), "duplicate_tool"],
    ["too many tools", pair("sample", { tools: Array.from({ length: SKILL_LIMITS.tools + 1 }, (_, i) => `app.x.t${i}`) }), "too_many_tools"],
    ["a tool that is not on the static catalog", pair("sample", { tools: ["app.weather.tomorrow"] }), "unknown_tool"],
    ["a hidden tool", pair("sample", { tools: ["app.home.control"], body: "用 `app.home.control`。" }), "hidden_tool"],
    ["a body that names a catalog tool missing from tools", pair("sample", { body: "先 `app.weather.today`，再 `app.calendar.list_events`。" }), "mention_not_in_tools"],
    ["a body that names a tool not on the catalog", pair("sample", { body: "呼叫 app.weather.today 與 app.weather.radar。" }), "mention_unknown_tool"],
    ["an empty body", pair("sample", { body: "<!-- bilingual: source=zh-TW -->\n" }), "empty_body"],
    ["a body over the limit", pair("sample", { body: `呼叫 \`app.weather.today\`。${"長".repeat(SKILL_LIMITS.body)}` }), "body_too_long"],
    ["zh and en with different tools", pair("sample", { tools: ["app.weather.today"] }, { tools: ["app.weather.today", "app.calendar.list_events"], body: "Call `app.weather.today`." }), "locale_mismatch"],
    ["zh and en in a different tool order", pair("sample", { tools: ["app.weather.today", "app.calendar.list_events"] }, { tools: ["app.calendar.list_events", "app.weather.today"] }), "locale_mismatch"],
    ["a missing English file", { "sample/SKILL.md": skillText({ name: "sample" }) }, "missing_file"],
    ["a missing Chinese file", { "sample/SKILL.en.md": skillText({ name: "sample" }) }, "missing_file"],
    ["an extra file (skills carry no code)", { ...pair("sample"), "sample/run.sh": "echo hi\n" }, "extra_file"],
    ["a file at the root instead of a skill directory", { ...pair("sample"), "README.md": "# x\n" }, "not_a_directory"],
  ];
  it("covers every problem code with a fixture (24 codes; the three below have their own tests)", () => {
    expect(SKILL_PROBLEM_CODES).toHaveLength(24);
    const covered = new Set<SkillProblemCode>([...cases.map((c) => c[2]), "locale_mismatch", "duplicate_name", "extra_file"]);
    expect([...SKILL_PROBLEM_CODES].filter((c) => !covered.has(c))).toEqual([]);
  });

  for (const [name, files, code] of cases) {
    it(name, () => {
      const result = loadSkills(tree(files));
      expect(result.problems.map((p) => p.code), JSON.stringify(result.problems, null, 1)).toContain(code);
      // 問題在這份技能本身時，它不能出現在 skills（根目錄多一個檔不影響 sample）。
      if (code !== "not_a_directory") expect(result.skills.map((s) => s.name)).not.toContain("sample");
      else expect(result.skills.map((s) => s.name)).toEqual(["sample"]);
      for (const p of result.problems) expect(p.message.length).toBeGreaterThan(0);
    });
  }

  it("zh and en with different names", () => {
    const problems = buildSkills([{ dir: "sample", files: { "SKILL.md": skillText({ name: "sample" }), "SKILL.en.md": skillText({ name: "sample-en" }) } }], staticCatalog()).problems;
    expect(problems.map((p) => p.code)).toEqual(expect.arrayContaining(["locale_mismatch", "name_mismatch"]));
  });

  it("two skills with the same name (both reported; the second directory is rejected for the collision)", () => {
    const root = tree({ ...pair("alpha", { name: "beta" }, { name: "beta" }), ...pair("beta") });
    const result = loadSkills(root);
    expect(result.problems).toContainEqual(expect.objectContaining({ where: "beta", code: "duplicate_name" }));
    expect(result.problems).toContainEqual(expect.objectContaining({ where: "alpha/SKILL.md", code: "name_mismatch" }));
    expect(result.skills).toEqual([]);
  });

  it("a subdirectory inside a skill directory is reported, not read", () => {
    const root = tree(pair("sample"));
    mkdirSync(join(root, "sample", "scripts"));
    expect(codes(root)).toEqual(["extra_file"]);
  });

  it("a valid fixture passes, so the cases above fail for their own reason", () => {
    const result = loadSkills(tree(pair("sample")));
    expect(result.problems).toEqual([]);
    expect(result.skills).toEqual([{ name: "sample", tools: ["app.weather.today"], locales: { "zh-TW": { description: "測試用的技能。", body: "呼叫 `app.weather.today`，照實說結果。" }, en: { description: "A skill for tests.", body: "Call `app.weather.today` and report the result truthfully." } } }]);
  });

  it("an empty or missing skills root is not an error (no skills)", () => {
    expect(loadSkills(join(tree({}), "nope"))).toEqual({ skills: [], problems: [] });
  });
});

describe("parser", () => {
  it("reads only text: the body is returned verbatim, never executed or interpreted", () => {
    const body = "<script>globalThis.ran = true</script>\n\n```sh\nrm -rf /\n```\n\n${process.exit(1)}";
    const result = parseSkillFile(skillText({ body: `呼叫 \`app.weather.today\`。\n\n${body}` }), "x/SKILL.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toBe(`呼叫 \`app.weather.today\`。\n\n${body}`);
    expect((globalThis as { ran?: boolean }).ran).toBeUndefined();
  });

  it("accepts CRLF line endings and a BOM", () => {
    const result = parseSkillFile(`﻿${skillText().replace(/\n/g, "\r\n")}`, "x/SKILL.md");
    expect(result).toMatchObject({ ok: true, value: { name: "sample", tools: ["app.weather.today"] } });
  });
});

describe("gate: skills change nothing the model sees (NOUS_SKILLS on or off)", () => {
  it("SKL-2: NOUS_SKILLS only sets config.skills (default off); everything else in the configuration is the same", () => {
    expect(loadConfig({}).skills).toBe(false);
    expect(loadConfig({ NOUS_SKILLS: "off" }).skills).toBe(false);
    expect(loadConfig({ NOUS_SKILLS: " ON " }).skills).toBe(true);
    expect({ ...loadConfig({ NOUS_SKILLS: "on" }), skills: false }).toEqual(loadConfig({}));
    expect({ ...loadConfig({ NOUS_SKILLS: "on", NOUS_AIL: "on", NOUS_AIL_SERVICES: "weather" }), skills: false }).toEqual(loadConfig({ NOUS_AIL: "on", NOUS_AIL_SERVICES: "weather" }));
  });

  it("with NOUS_SKILLS=on in the environment, the tool JSON and /help/commands still equal the CAP-1/CAP-2 baselines", () => {
    const prior = process.env.NOUS_SKILLS;
    process.env.NOUS_SKILLS = "on";
    try {
      const tools = baseline("model-tools.baseline.json");
      const now = modelToolOutputs();
      for (const key of Object.keys(tools)) expect(now[key], key).toBe(tools[key]);
      const pages = baseline("commands-page.baseline.json");
      const page = commandsPageOutputs();
      for (const key of Object.keys(pages)) expect(page[key], key).toBe(pages[key]);
    } finally {
      if (prior === undefined) delete process.env.NOUS_SKILLS;
      else process.env.NOUS_SKILLS = prior;
    }
  });

  it("SKL-2: only scripts/catalog.ts and server/nous.ts load skills (nous.ts only when NOUS_SKILLS=on; tests/skills-realtime.test.ts covers the wiring); app.skill.read is a hidden catalog entry", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (relative(shellDir, path) !== join("server", "skills")) walk(path);
        }
        else if (/\.(ts|mts|js|mjs)$/.test(entry.name) && /from\s+["'][^"']*skills\/(format|load)\.ts["']/.test(readFileSync(path, "utf8"))) importers.push(relative(shellDir, path));
      }
    };
    for (const dir of ["server", "shared", "src", "desktop", "scripts"]) walk(join(shellDir, dir));
    expect(importers.sort()).toEqual(["scripts/catalog.ts", "server/nous.ts"]);
    expect(staticCatalog().find((e) => e.id === "app.skill.read")).toMatchObject({ hidden: true, builtin: true, effect: "read" });
  });
});
