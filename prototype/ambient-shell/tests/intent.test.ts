import { describe, expect, it } from "vitest";
import { classify } from "../src/intent.ts";

describe("classify", () => {
  it.each([
    ["進度如何", "progress"],
    ["目前進度如何？", "progress"],
    ["做到哪了", "progress"],
    ["幫我看一下進度", "progress"],
    ["那個報告做得怎樣了", "progress"],
    ["看結果", "result"],
    ["把剛才那份拿出來", "result"],
    ["收起", "dismiss"],
    ["收起來吧。", "dismiss"],
    ["回桌布", "dismiss"],
    ["停止任務", "stop"],
    ["取消這個任務", "stop"],
    ["不要做了", "stop"],
  ])("「%s」→ %s", (text, kind) => {
    expect(classify(text).kind).toBe(kind);
  });

  it.each([
    "幫我寫一份專案進度報告",
    "分析上季銷售結果",
    "整理本週會議重點，寄給團隊之前先給我看",
    "幫我規劃下週去台南的三天行程，包含預算",
    "比較三個雲端儲存方案的價格與優缺點，並整理成表格給我看",
  ])("交辦內容「%s」不會被當成控制指令", (text) => {
    expect(classify(text)).toEqual({ kind: "task", text });
  });

  it("空白輸入", () => {
    expect(classify("   ").kind).toBe("empty");
  });
});
