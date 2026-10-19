import { describe, expect, it } from "vitest";
import { shortTitle, speakFinished, speakProgress, speakSubmitted } from "../src/speech-text.ts";
import { makeTask, step } from "./fixtures.ts";

describe("語音回覆短句", () => {
  it("過長標題截短", () => {
    expect(shortTitle("一二三四五六七八九十一二三四五六七八九十")).toBe("一二三四五六七八九十一二三四五六七八…");
  });

  it("交辦確認；模擬模式要說出來", () => {
    expect(speakSubmitted(makeTask({ title: "寫週報", mode: "claude" }))).toBe("好，已交辦：寫週報。");
    expect(speakSubmitted(makeTask({ title: "寫週報", mode: "mock" }))).toContain("模擬模式");
  });

  it("沒有任務", () => {
    expect(speakProgress([])).toBe("目前沒有交辦的任務。");
  });

  it("進度摘要只用真實步驟狀態", () => {
    const running = makeTask({
      task_id: "a",
      title: "寫週報",
      plan_ready: true,
      steps: [step("規劃步驟", "done"), step("列出重點", "running"), step("彙整成果", "pending")],
    });
    const done = makeTask({ task_id: "b", status: "succeeded", created_at: "2026-10-19T11:00:00.000Z" });
    expect(speakProgress([done, running])).toBe("目前有 1 個進行中、1 個已完成。寫週報：第 2 步，共 3 步，正在列出重點。");
  });

  it("規劃中不報步數", () => {
    const t = makeTask({ title: "寫週報", steps: [step("規劃步驟", "running")] });
    expect(speakProgress([t])).toBe("目前有 1 個進行中。寫週報：正在規劃步驟。");
  });

  it("完成與失敗通知", () => {
    expect(speakFinished(makeTask({ title: "寫週報", status: "succeeded" }))).toBe("寫週報完成了，成果在畫面上。");
    expect(speakFinished(makeTask({ title: "寫週報", status: "failed", error: "連線逾時" }))).toBe("寫週報失敗了：連線逾時");
  });
});
