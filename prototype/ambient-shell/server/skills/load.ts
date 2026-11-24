import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { staticCatalog, type CatalogEntry } from "../integrations/catalog.ts";
import { buildSkills, type Skill, type SkillProblem, type SkillSource } from "./format.ts";

// SKL-1（docs/24 §4.2）：讀出貨技能的目錄（prototype/ambient-shell/skills/<name>/）。只讀文字檔，不執行、不 import 任何東西。
// 家裡自己存的技能（<data-dir>/skills/）是 SKL-3；這一批沒有。

/** 隨程式出貨、經 PR 審核的技能目錄。 */
export const SHIPPED_SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

/** 一般檔案讀成文字；目錄、符號連結或其他項目記成 null（buildSkills 會回報）。 */
export function readSkillSources(root: string): { sources: SkillSource[]; problems: SkillProblem[] } {
  const sources: SkillSource[] = [];
  const problems: SkillProblem[] = [];
  if (!existsSync(root)) return { sources, problems };
  for (const dir of readdirSync(root).sort()) {
    const path = join(root, dir);
    if (!lstatSync(path).isDirectory()) {
      problems.push({ where: dir, code: "not_a_directory", message: "技能根目錄裡只能有技能目錄（skills/<name>/）" });
      continue;
    }
    const files: Record<string, string | null> = {};
    for (const file of readdirSync(path).sort()) {
      const filePath = join(path, file);
      files[file] = lstatSync(filePath).isFile() ? readFileSync(filePath, "utf8") : null;
    }
    sources.push({ dir, files });
  }
  return { sources, problems };
}

/** 讀出並檢查技能目錄。problems 為空才代表全部通過；有問題的技能不在 skills 裡。 */
export function loadSkills(root: string = SHIPPED_SKILLS_DIR, catalog: readonly CatalogEntry[] = staticCatalog()): { skills: Skill[]; problems: SkillProblem[] } {
  const read = readSkillSources(root);
  const built = buildSkills(read.sources, catalog);
  return { skills: built.skills, problems: [...read.problems, ...built.problems] };
}
