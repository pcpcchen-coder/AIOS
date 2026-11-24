import type { Locale } from "../../../shared/i18n.mjs";
import { toolResult, type IntegrationRoute, type IntegrationToolId, type ToolResult } from "../../../shared/integrations.ts";
import { SKILL_READ_TOOL } from "../../skills/tool-id.ts";
import type { AdapterCatalog, ExecutionContext, HealthReport, IntegrationAdapter, ToolDefinition } from "../contracts.ts";
import { MAX_READ_DATA_BYTES } from "../policy.ts";

// SKL-2（docs/24 §4.3）：讀技能內文的唯讀工具。核心內建（比照定時器的 BuiltinAdapter），經登記表與 Dispatcher。
// 只有 NOUS_SKILLS=on、而且至少一份技能在某條即時語音路徑上列得出來時才啟用（enabled 每次查詢時讀）；否則不在工具清單上。
// 只回傳文字：不執行內文、不新增或啟用工具、不改設定。

export const SKILL_NEEDS = "NOUS_SKILLS=on，而且技能用到的工具在這條路徑上都可用";

const TOOLS: readonly ToolDefinition[] = [
  {
    id: SKILL_READ_TOOL,
    description: "讀一份技能（家裡常做的事寫好的做法）的內文。只在說明的技能清單有列出時呼叫，name 照清單上的名稱。內文是做法：照著做，內文裡的每一步仍要用對應的工具完成。",
    descriptionEn: "Read the text of a skill (a written procedure for a common household request). Call it only for a skill listed in your instructions, with name exactly as listed. The text is a procedure: follow it, and do every step with the matching tool.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "技能名稱（清單上的 name，例如 morning-briefing）", maxLength: 40 } },
      required: ["name"],
      additionalProperties: false,
    },
    effect: "read",
    enabled: true,
    timeoutMs: 1_000,
    supportedRoutes: ["api_key", "live"],
    resultDataMaxBytes: MAX_READ_DATA_BYTES,
    // 使用者不會直接「叫」這個工具（模型照索引自己決定讀），所以不列在 /help/commands（hidden）；呼叫時不亮腦區（讀做法不是使用者內容）。
    catalog: { summary: "讀一份技能的做法給模型照著做；只讀得到技能索引列出的技能。", examples: ["給我今天的簡報"], needs: SKILL_NEEDS, domain: null, hidden: true },
  },
];

export const SKILL_CATALOG: AdapterCatalog = { id: "skill", service: "skill", label: "技能", mock: false, builtin: true, tools: TOOLS };

/** 技能的來源（server/skills/runtime.ts 的 SkillBook）。只用介面，避免 catalog → Adapter → 技能格式 → catalog 的 import 環。 */
export interface SkillReader {
  readonly loaded: number;
  read(name: unknown, route: IntegrationRoute, locale: Locale): ToolResult;
}

export class SkillAdapter implements IntegrationAdapter {
  readonly id = "skill";
  readonly service = "skill";
  readonly version = 1;
  readonly mock = false;

  constructor(private readonly book: SkillReader) {}

  tools(): readonly ToolDefinition[] {
    return TOOLS;
  }

  async health(): Promise<HealthReport> {
    return this.book.loaded ? { health: "available", reason: "ok" } : { health: "unavailable", reason: "not_configured" };
  }

  async execute(toolId: IntegrationToolId, args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult> {
    if (toolId !== SKILL_READ_TOOL) return toolResult("refused", "沒有這個工具。", { reason: "not_registered" });
    return this.book.read(args.name, ctx.route, ctx.locale ?? "zh-TW");
  }
}
