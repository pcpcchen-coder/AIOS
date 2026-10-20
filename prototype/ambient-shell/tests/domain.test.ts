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

import { DOMAINS, REGIONS, REGION_COLOR, isDomain, regionOf } from "../shared/domain.ts";
import { parsePlan, PLAN_SCHEMA, planPrompt } from "../server/prompts.ts";

describe("six-region contract", () => {
  it("uses the registry for schema, prompt descriptions, colors and anchors", () => {
    expect(DOMAINS).toEqual(["language", "math", "art", "auditory", "visual", "planning"]);
    expect(PLAN_SCHEMA.properties.steps.items.properties.domain.enum).toEqual(DOMAINS);
    expect(new Set(REGIONS.map((r) => r.color.join(","))).size).toBe(6);
    for (const region of REGIONS) {
      expect(planPrompt("任務")).toContain(`${region.id}（${region.label}`);
      expect(REGION_COLOR[region.id]).toEqual(region.color);
      const [x, y, z] = region.anchor;
      expect(regionOf({ x, y, z, group: 0 })).toBe(region.id);
    }
    expect(regionOf({ x: 0, y: 0, z: 0, group: 2 })).toBeNull();
    for (const invalid of [null, undefined, "unknown", "toString", 3, {}]) expect(isDomain(invalid)).toBe(false);
  });

  it.each([
    ["音樂旋律和聲音", "auditory"], ["討論這3張照片的場景", "visual"],
    ["規劃明天的排程", "planning"], ["1+2 等於多少", "math"],
  ])("classifies %s deterministically", (text, domain) => {
    expect(Array.from({ length: 3 }, () => classifyDomain(text))).toEqual([domain, domain, domain]);
  });

  it("preserves all model domains and supplies a safe missing/invalid fallback", () => {
    for (const domain of DOMAINS) {
      expect(parsePlan(JSON.stringify({ steps: [{ title: "步驟", instruction: "執行", domain }] })).steps[0].domain).toBe(domain);
    }
    expect(parsePlan(JSON.stringify({ steps: [{ title: "照片場景", instruction: "說明", domain: "invalid" }] })).steps[0].domain).toBe("visual");
    expect(parsePlan(JSON.stringify({ steps: [{ title: "嗯", instruction: "嗯" }] })).steps[0].domain).toBe("language");
  });
});
