import { describe, expect, it } from "vitest";
import { classifyDomain } from "../shared/domain.ts";

describe("classifyDomain", () => {
  it.each([
    ["幫我翻譯這封英文郵件", "language"],
    ["整理本週會議重點", "language"],
    ["計算三個方案的每度成本", "math"],
    ["比較預算和實際花費的百分比", "math"],
    ["設計一張活動海報的配色", "art"],
    ["寫一首關於秋天的詩", "art"],
  ])("「%s」→ %s", (text, domain) => {
    expect(classifyDomain(text)).toBe(domain);
  });

  it("沒有線索時不判斷", () => {
    expect(classifyDomain("嗯")).toBeNull();
  });
});
