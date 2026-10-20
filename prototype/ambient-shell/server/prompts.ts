import { classifyDomain, isDomain, type Domain } from "../shared/domain.ts";
import { ExecutionError } from "./runner.ts";

// Claude 與 ChatGPT 執行器共用的提示詞與計畫格式：同樣走「規劃 → 逐步執行 → 彙整」。

export const SYSTEM_PROMPT = [
  "你是 Nous 的任務執行 Agent。使用者在桌面上交辦一件事，你負責完成它。",
  "能力限制：這個原型沒有任何工具——不能上網、不能讀寫檔案、不能寄信或對外發布、不能付款、不能查詢即時資料。",
  "你只能運用既有知識進行思考、分析、撰寫與規劃。",
  "需要上述能力的部分，必須明確寫出缺口，並提供可行的替代產出（例如草稿、清單、操作步驟），不得假裝已經完成。",
  "不確定的事實要標明是推測。使用繁體中文（台灣用語）。",
].join("\n");

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
          domain: { type: "string", enum: ["language", "math", "art"] },
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
    "每一步標記主要用到的能力 domain：language（語言：閱讀、撰寫、翻譯、整理）、math（數理：計算、邏輯、資料、比較）、art（藝術：設計、創作、美感、故事）。",
    "同時列出你做的假設，以及因為沒有工具而無法完成的部分（能力缺口）。",
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
