import { describe, expect, it } from "vitest";
import { classify, settingsReply, settingsTopic } from "../src/intent.ts";
import { INTENT_COMMANDS } from "../shared/voice-commands.ts";

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
    ["開啟語音模式", "voice_on"],
    ["語音模式", "voice_on"],
    ["打開語音對話", "voice_on"],
    ["關閉語音模式", "voice_off"],
    ["結束語音", "voice_off"],
    ["語音關掉", "voice_off"],
    ["設定", "settings"],
    ["切換引擎", "settings"],
    ["鏡頭設定", "settings"],
    ["打開鏡頭設定", "settings"],
    ["開啟鏡頭設定", "settings"],
    ["登入 ChatGPT", "settings"],
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

  it.each([
    ["改用 ChatGPT", "chatgpt"],
    ["用chatgpt", "chatgpt"],
    ["切換到 Claude", "claude"],
    ["改用模擬模式", "mock"],
  ])("「%s」→ 切換引擎 %s", (text, provider) => {
    expect(classify(text)).toEqual({ kind: "use_provider", provider });
  });

  it("空白輸入", () => {
    expect(classify("   ").kind).toBe("empty");
  });
});

describe("settingsReply (what Nous says when the settings screen opens)", () => {
  const settingsRow = INTENT_COMMANDS.settings.find((r) => r.id === "settings")!;

  it("the browser keeps the full-settings sentence for every phrase", () => {
    for (const says of settingsRow.says) {
      expect(settingsReply(says, { desktop: false, cameraEnabled: true })).toBe("這是 AI 引擎與鏡頭設定。");
      expect(settingsReply(says, { desktop: false, cameraEnabled: false })).toBe("這是 AI 引擎設定。");
    }
  });

  it("the macOS App says the page is accounts only and points each phrase in the command table to the menu bar", () => {
    const replies = Object.fromEntries(settingsRow.says.map((says) => [says, settingsReply(says, { desktop: true, cameraEnabled: true })]));
    expect(replies).toEqual({
      設定: "這是帳號與登入；鏡頭、秒數與引擎在選單列的 Nous 圖示裡。",
      鏡頭設定: "這是帳號與登入；鏡頭設定在選單列 Nous 圖示的「鏡頭與語音設定」。",
      切換引擎: "這是帳號與登入；切換引擎在選單列 Nous 圖示的「AI 引擎」。",
      打開鏡頭設定: "這是帳號與登入；鏡頭設定在選單列 Nous 圖示的「鏡頭與語音設定」。",
    });
    // 指令表的說明和實際的話一致。
    expect(settingsRow.does).toContain("「鏡頭與語音設定」");
    expect(settingsRow.does).toContain("「AI 引擎」");
  });

  it.each([
    ["請打開鏡頭設定。", "camera"],
    ["模型設定", "engine"],
    ["AI 引擎設定", "engine"],
    ["引擎", "engine"],
    ["登入 ChatGPT", "general"],
    ["settings", "general"],
  ] as const)("%s → %s (and still classified as settings)", (text, topic) => {
    expect(classify(text).kind).toBe("settings");
    expect(settingsTopic(text)).toBe(topic);
  });
});
