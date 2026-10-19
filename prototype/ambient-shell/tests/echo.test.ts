import { describe, expect, it } from "vitest";
import { isLikelyEcho, isStopWord, novelChars, stripEcho, takeSentences } from "../src/echo.ts";

const SPOKEN = "今天台北多雲，下午可能有短暫陣雨，出門記得帶傘。";

describe("回音判斷", () => {
  it("念出的句子被收音辨識回來時視為回音", () => {
    expect(isLikelyEcho("今天台北多雲下午可能有", SPOKEN)).toBe(true);
    expect(isLikelyEcho("台北多雲", SPOKEN)).toBe(true);
  });

  it("使用者插入新內容時不是回音", () => {
    expect(isLikelyEcho("等一下我想問明天", SPOKEN)).toBe(false);
    expect(isLikelyEcho("停", "")).toBe(false);
  });

  it("空白或標點不算插話", () => {
    expect(isLikelyEcho("，。", SPOKEN)).toBe(true);
  });

  it("計算新字數", () => {
    expect(novelChars("今天天氣", SPOKEN)).toBe(1); // 「氣」不在念的內容裡
  });

  it("去掉開頭的回音，保留使用者的話", () => {
    expect(stripEcho("今天台北等一下我想問明天", SPOKEN)).toBe("等一下我想問明天");
    expect(stripEcho("我想問明天", SPOKEN)).toBe("我想問明天");
    // 只有一個字剛好相同時不刪
    expect(stripEcho("今晚呢", SPOKEN)).toBe("今晚呢");
  });
});

describe("插話詞", () => {
  it("停、等一下等詞一律打斷", () => {
    expect(isStopWord("停")).toBe(true);
    expect(isStopWord("等一下，我想問")).toBe(true);
    expect(isStopWord("Stop")).toBe(true);
    expect(isStopWord("今天天氣")).toBe(false);
  });
});

describe("takeSentences", () => {
  it("依句號、問號切句，剩下的保留", () => {
    expect(takeSentences("你好！今天要做什麼？我")).toEqual({ sentences: ["你好！", "今天要做什麼？"], rest: "我" });
  });

  it("太長的句子在逗號先切", () => {
    const long = "這是一段很長很長很長很長很長很長的說明，後面還有一些內容還沒結束而且也很長很長很長";
    const { sentences, rest } = takeSentences(long, 30);
    expect(sentences[0].endsWith("，")).toBe(true);
    expect(rest.length).toBeLessThan(long.length);
  });
});
