import type { Locale } from "../../shared/i18n.mjs";
import { toolResult, type CapabilityStatus, type IntegrationRoute, type IntegrationToolId, type ToolResult } from "../../shared/integrations.ts";
import type { Skill, SkillProblem } from "./format.ts";
import { SKILL_READ_WIRE } from "./tool-id.ts";

// SKL-2（docs/24 §4.3）：技能怎麼被模型看到。兩條即時語音路徑共用這一份（docs/23 §P1-2：不各寫一次）：
// - 列出：一份技能的 tools 在這條路徑上**全部** available（登記表的即時狀態）才列；依名稱排序，超過上限的截斷並記 log。
// - 索引：列出的技能只放 name 與 description（依介面語言），加一段簡短指示。
// - 讀取：app.skill.read 只能讀「這條路徑、這個語言現在列得出來」的技能；名稱只對照已載入的清單，從不拿來組檔案路徑。
// 技能只有文字：這裡不執行內文、不新增或啟用工具；內文裡的每一步仍由模型呼叫工具、經 Dispatcher 與既有政策。

/**
 * 索引上限（2026-11-24 量測後定案，計算見 docs/validation/skl-2-skills-realtime-2026-11-24.md 與 tests/skills-realtime.test.ts）。
 * - count：一次最多列幾份。
 * - chars：整段索引（指示＋每份技能一行，以換行連接）的 Unicode code point 上限，兩種語言共用。
 * 超過時依名稱排序，從第一份放不下的開始全部不列（不跳著塞），並在診斷 log 記錄被截掉的名稱。
 */
export const SKILL_INDEX_LIMITS = { count: 8, chars: 2_000 } as const;
export type SkillIndexLimits = { count: number; chars: number };

/** 兩種索引：tool＝有工具的模型（API key 語音模型、ChatGPT 方案的工具執行層）；delegate＝ChatGPT 方案沒有工具的語音層。 */
export type SkillIndexMode = "tool" | "delegate";

const HEADER: Record<SkillIndexMode, Record<Locale, string>> = {
  tool: {
    "zh-TW": `家裡常做的事有寫好的做法（技能），列在下面。使用者的請求符合其中一項時，先呼叫 ${SKILL_READ_WIRE}（name 照下面的名稱）讀內文，再照內文做；內文裡的每一步仍要用對應的工具完成，只說工具真的回傳的內容。下面沒有列出的做法就是目前不能用，不要假裝有。`,
    en: `Some common household requests have written procedures (skills), listed below. When a request matches one, first call ${SKILL_READ_WIRE} with that name to read the procedure, then follow it; every step still goes through the matching tool, and say only what the tools actually returned. A procedure that is not listed is not available right now; do not pretend it exists.`,
  },
  delegate: {
    "zh-TW": "家裡常做的事有寫好的做法，使用者的請求符合下面其中一項時一律交辦（連同使用者的原話）：",
    en: "Some common household requests have written procedures; when a request matches one below, always delegate it (with the user's own words):",
  },
};

const item = (name: string, description: string, locale: Locale) => (locale === "en" ? `- ${name}: ${description}` : `- ${name}：${description}`);
const length = (text: string) => [...text].length;

/** 一條路徑、一種語言的列出結果。 */
export interface SkillListing {
  /** 這次列出（依名稱排序）。 */
  listed: Skill[];
  /** 因工具不可用沒列：技能名稱與不可用的工具 ID（和它們的狀態；null＝沒有註冊）。 */
  unavailable: { name: string; tools: { id: string; status: CapabilityStatus | null }[] }[];
  /** 工具都可用，但超過索引上限沒列（依名稱排序的尾端）。 */
  truncated: string[];
}

export interface SkillBookOptions {
  /** 已載入並通過檢查的技能（loadSkills().skills）。 */
  skills: readonly Skill[];
  /** 一個工具在一條路徑上的即時狀態（IntegrationRegistry.status）；沒有註冊回 null。 */
  status: (id: IntegrationToolId, route: IntegrationRoute) => CapabilityStatus | null;
  limits?: SkillIndexLimits;
  log?: (line: string) => void;
}

export class SkillBook {
  private readonly skills: readonly Skill[];
  private readonly limits: SkillIndexLimits;
  private readonly lastLogged = new Map<string, string>();

  constructor(private readonly options: SkillBookOptions) {
    this.skills = [...options.skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.limits = options.limits ?? SKILL_INDEX_LIMITS;
  }

  /** 已載入的技能數（不看工具狀態）。 */
  get loaded(): number {
    return this.skills.length;
  }

  /** 這條路徑、這個語言現在列得出來的技能（每次都看登記表的即時狀態）。 */
  listing(route: IntegrationRoute, locale: Locale): SkillListing {
    const listed: Skill[] = [];
    const unavailable: SkillListing["unavailable"] = [];
    const truncated: string[] = [];
    let chars = length(HEADER.tool[locale]);
    for (const skill of this.skills) {
      const blocked = skill.tools.map((id) => ({ id, status: this.options.status(id as IntegrationToolId, route) })).filter((t) => t.status !== "available");
      if (blocked.length) {
        unavailable.push({ name: skill.name, tools: blocked });
        continue;
      }
      // 上限以 tool 版（較長的指示）計算；delegate 版的指示比較短，列出的技能相同。
      const next = chars + 1 + length(item(skill.name, skill.locales[locale].description, locale));
      if (truncated.length || listed.length >= this.limits.count || next > this.limits.chars) {
        truncated.push(skill.name);
        continue;
      }
      listed.push(skill);
      chars = next;
    }
    return { listed, unavailable, truncated };
  }

  /** 任何一條即時語音路徑、任何語言有列得出來的技能（讀取工具只有這時才出現在工具清單）。 */
  anyListed(): boolean {
    return (["api_key", "live"] as const).some((route) => (["zh-TW", "en"] as const).some((locale) => this.listing(route, locale).listed.length > 0));
  }

  /** 工作階段說明裡的技能索引（沒有列出任何技能時是空陣列，說明就和沒有技能時相同）。 */
  indexLines(route: IntegrationRoute, locale: Locale, mode: SkillIndexMode): string[] {
    const listing = this.listing(route, locale);
    this.report(route, locale, listing);
    if (!listing.listed.length) return [];
    return [HEADER[mode][locale], ...listing.listed.map((s) => item(s.name, s.locales[locale].description, locale))];
  }

  /** app.skill.read 的內容：只讀這條路徑、這個語言列得出來的技能。 */
  read(name: unknown, route: IntegrationRoute, locale: Locale): ToolResult {
    const en = locale === "en";
    const key = typeof name === "string" ? name : "";
    // 只對照已載入的清單（完全相同的字串）；名稱從不拿來組路徑或讀檔。
    const skill = this.skills.find((s) => s.name === key);
    if (!skill) {
      return toolResult("refused", en ? "There is no skill by that name; only the skills listed in your instructions can be read." : "沒有這個名稱的技能；只能讀說明裡列出的技能。", { reason: "invalid_arguments" });
    }
    const listing = this.listing(route, locale);
    const blocked = listing.unavailable.find((u) => u.name === skill.name);
    if (blocked) {
      const tools = blocked.tools.map((t) => t.id).join(", ");
      return toolResult("refused", en ? `The skill ${skill.name} is not available right now: these tools are not available on this route: ${tools}.` : `技能 ${skill.name} 現在不能用：這條路徑上這些工具不可用：${tools}。`, { reason: "unavailable", data: { name: skill.name, unavailable_tools: blocked.tools.map((t) => t.id) } });
    }
    if (listing.truncated.includes(skill.name)) {
      return toolResult("refused", en ? `The skill ${skill.name} is over the skill index limit this time and is not listed.` : `技能 ${skill.name} 超過這次技能索引的上限，沒有列出。`, { reason: "unavailable", data: { name: skill.name } });
    }
    return toolResult("confirmed", en ? `Read the procedure for ${skill.name}. Follow data.body; every step still needs its tool, and say only what the tools return.` : `已讀取 ${skill.name} 的做法。照 data.body 做；每一步仍要用工具完成，只說工具回傳的內容。`, {
      data: { name: skill.name, locale, tools: [...skill.tools], body: skill.locales[locale].body },
    });
  }

  /** 診斷：這次列出幾份、哪些因工具不可用沒列、哪些被上限截掉。和上一次相同時不重複記。不記技能內文。 */
  private report(route: IntegrationRoute, locale: Locale, listing: SkillListing): void {
    const parts = [`列出 ${listing.listed.length} 份${listing.listed.length ? `（${listing.listed.map((s) => s.name).join("、")}）` : ""}`];
    if (listing.unavailable.length) parts.push(`工具不可用沒列：${listing.unavailable.map((u) => `${u.name}（${u.tools.map((t) => `${t.id} ${t.status ?? "未註冊"}`).join("、")}）`).join("；")}`);
    if (listing.truncated.length) parts.push(`超過索引上限（${this.limits.count} 份／${this.limits.chars} 字）沒列：${listing.truncated.join("、")}`);
    const line = `技能：${route}／${locale} ${parts.join("；")}`;
    const key = `${route}/${locale}`;
    if (this.lastLogged.get(key) === line) return;
    this.lastLogged.set(key, line);
    this.options.log?.(line);
  }
}

/** 啟動時的載入診斷（幾份載入、哪些因檢查失敗被略過）。技能檔有錯只略過那一份，不讓 Nous 啟動失敗。 */
export function skillLoadLog(skills: readonly Skill[], problems: readonly SkillProblem[]): string[] {
  const lines = [`技能：載入 ${skills.length} 份${skills.length ? `（${skills.map((s) => s.name).join("、")}）` : ""}`];
  const skipped = [...new Set(problems.map((p) => p.where.split("/")[0]!))];
  if (skipped.length) lines.push(`技能：${skipped.length} 份檢查失敗被略過：${skipped.join("、")}`);
  for (const p of problems) lines.push(`技能：✗ ${p.where}（${p.code}）${p.message}`);
  return lines;
}
