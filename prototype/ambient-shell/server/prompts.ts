import { type Locale } from "../shared/i18n.mjs";
import { classifyDomain, isDomain, DOMAINS, REGIONS, type Domain } from "../shared/domain.ts";
import { ExecutionError } from "./runner.ts";

// Claude 與 ChatGPT 執行器共用的提示詞與計畫格式：同樣走「規劃 → 逐步執行 → 彙整」。

/** 任務執行的系統指示；依這次執行實際擁有的工具說明能力。 */
export function systemPrompt(caps: { webSearch: boolean }, locale: Locale = "zh-TW"): string {
  return [
    "你是 Nous 的任務執行 Agent。使用者在桌面上交辦一件事，你負責完成它。",
    caps.webSearch
      ? "你可以使用 web_search 上網查詢最新與即時資料：涉及時事、價格、規格、日期、天氣或任何可能過時的事實，先查再寫，並在內容中附上來源網址。"
      : "這次執行沒有上網工具：涉及即時或最新資料的部分，列出需要查證的項目。",
    "寄信、對外發布、付款、刪除等會改變外部狀態的動作，由系統的確認流程處理，不在任務中直接執行；需要時產出可直接使用的草稿或內容。",
    "產出要能直接使用；做不到的部分寫進缺口並提供替代產出，不得假裝已經完成。",
    locale === "en" ? "Label uncertain facts as inferences. Produce the plan, step titles, assumptions, gaps, and final artifact in English unless the user explicitly requests another output language." : "不確定的事實要標明是推測。使用繁體中文（台灣用語）。",
  ].join("\n");
}

export const WEB_SEARCH_UNAVAILABLE_GAP = "這次執行的引擎或方案不支援上網搜尋，涉及即時資料的內容未經查證。";

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          instruction: { type: "string" },
          domain: { type: "string", enum: DOMAINS },
        },
        required: ["title", "instruction", "domain"],
        additionalProperties: false,
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    capability_gaps: { type: "array", items: { type: "string" } },
  },
  required: ["steps", "assumptions", "capability_gaps"],
  additionalProperties: false,
} as const;

export interface Plan {
  steps: { title: string; instruction: string; domain: Domain }[];
  assumptions: string[];
  capability_gaps: string[];
}

export const MAX_PLAN_STEPS = 5;
export const SYNTHESIS_TITLE = "彙整成果";

/** 規劃步驟用的使用者訊息。 */
export function planPrompt(title: string, today = new Date().toISOString().slice(0, 10)): string {
  return [
    `今天日期：${today}`,
    `使用者交辦的任務：${title}`,
    "",
    `請把任務拆成 1 到 ${MAX_PLAN_STEPS} 個具體執行步驟，每步給一個 15 字以內的標題與給執行者的指示。`,
    "不要加入「彙整」或「總結」步驟，系統會自動在最後加上。",
    `每一步標記主要用到的能力 domain：${REGIONS.map((r) => `${r.id}（${r.label}：${r.help}）`).join("、")}。`,
    "同時列出你做的假設，以及現有工具做不到的部分（能力缺口）。",
  ].join("\n");
}

/** 第 index 步（最後一步為彙整）的使用者訊息，帶入計畫與先前產出。 */
export function stepPrompt(
  title: string,
  plan: Plan,
  outputs: string[],
  index: number,
  today = new Date().toISOString().slice(0, 10),
): string {
  const isSynthesis = index === plan.steps.length;
  const planText = plan.steps.map((s, i) => `${i + 1}. ${s.title}：${s.instruction}`).join("\n");
  const previous = outputs.map((out, j) => `### 步驟 ${j + 1}：${plan.steps[j].title}\n${out}`).join("\n\n");
  const instruction = isSynthesis
    ? [
        "根據以上步驟的產出，寫出交付給使用者的最終成果（Markdown）。",
        "開頭先用 1–2 句總結。若有能力缺口，最後用「尚未完成／需要你處理」小節列出。",
      ].join("\n")
    : `現在執行步驟 ${index + 1}：${plan.steps[index].title}\n指示：${plan.steps[index].instruction}\n只輸出這一步的產出（Markdown）。`;
  return [
    `今天日期：${today}`,
    `使用者交辦的任務：${title}`,
    "",
    "完整計畫：",
    planText,
    previous ? `\n先前步驟的產出：\n${previous}` : "",
    "",
    instruction,
  ].join("\n");
}

export function parsePlan(text: string): Plan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ExecutionError("規劃結果不是有效的 JSON，無法確定步驟。");
  }
  const obj = raw as Partial<Plan>;
  const steps = Array.isArray(obj.steps)
    ? obj.steps
        .filter((s) => typeof s?.title === "string" && s.title.trim() && typeof s.instruction === "string")
        .slice(0, MAX_PLAN_STEPS)
        .map((s) => ({
          title: s.title.trim().slice(0, 40),
          instruction: s.instruction.trim(),
          // 模型沒給或給錯時，以關鍵字補判；仍判斷不出來就當語言（撰寫產出）。
          domain: isDomain(s.domain) ? s.domain : (classifyDomain(`${s.title} ${s.instruction}`) ?? "language"),
        }))
    : [];
  if (steps.length === 0) throw new ExecutionError("規劃結果沒有任何可執行的步驟。");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { steps, assumptions: strings(obj.assumptions), capability_gaps: strings(obj.capability_gaps) };
}
