import { toWireName, type IntegrationToolId } from "../../shared/integrations.ts";

// SKL-2：技能讀取工具的 ID（docs/24 的暫名 app.skill.read 定案，沿用 app.<service>.<action> 的命名）。
// 獨立成沒有其他依賴的小模組，Adapter、技能索引與即時語音的說明都 import 它，不形成 import 環。
export const SKILL_READ_TOOL = "app.skill.read" as const satisfies IntegrationToolId;
export const SKILL_READ_WIRE = toWireName(SKILL_READ_TOOL);
