import { describe, expect, it } from "vitest";
import { buildChatSystem, DelegationFilter, validateMessages } from "../server/chat.ts";
import { makeTask, step } from "./fixtures.ts";

describe("DelegationFilter", () => {
  it("把交辦標記從要念的文字拿掉並回報任務描述，即使標記被拆在多個片段", () => {
    const f = new DelegationFilter();
    const parts = ["好，我幫你整理。\n⟦交", "辦：整理本週會議", "重點⟧", "完成會告訴你。"];
    const out = parts.map((p) => f.push(p));
    expect(out.map((o) => o.text).join("") + f.flush()).toBe("好，我幫你整理。\n完成會告訴你。");
    expect(out.flatMap((o) => o.delegates)).toEqual(["整理本週會議重點"]);
  });

  it("不是交辦的方括號照常輸出；未閉合的內容在結束時放行", () => {
    const f = new DelegationFilter();
    expect(f.push("看⟦這個⟧")).toEqual({ text: "看⟦這個⟧", delegates: [] });
    expect(f.push("還有⟦沒結束").text).toBe("還有");
    expect(f.flush()).toBe("⟦沒結束");
  });
});

describe("validateMessages", () => {
  it("只接受 user/assistant 交替且以 user 結尾的對話", () => {
    expect(validateMessages([{ role: "user", content: " 你好 " }])).toEqual([{ role: "user", content: "你好" }]);
    expect(validateMessages([{ role: "assistant", content: "嗨" }])).toBeNull();
    expect(validateMessages([{ role: "system", content: "x" }])).toBeNull();
    expect(validateMessages([])).toBeNull();
    expect(validateMessages([{ role: "user", content: "x".repeat(4001) }])).toBeNull();
  });
});

describe("buildChatSystem", () => {
  it("附上真實任務狀態與交辦標記格式", () => {
    const t = makeTask({
      title: "寫週報",
      plan_ready: true,
      steps: [step("規劃步驟", "done"), step("撰寫", "running")],
    });
    const s = buildChatSystem([t], new Date("2026-10-19T12:00:00Z"));
    expect(s).toContain("「寫週報」：進行中，1/2 步");
    expect(s).toContain("⟦交辦：任務描述⟧");
    expect(s).toContain("2026-10-19");
  });
});
