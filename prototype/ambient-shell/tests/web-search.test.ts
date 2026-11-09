import { describe, expect, it } from "vitest";
import { parseMcp } from "../server/config.ts";
import { parseResponse, WebSearch, WebSearchError } from "../server/web-search.ts";
import { matchSpokenPoint, parseCandidates, pickToolOutput, searchToolOutput } from "../shared/web-search.ts";

// 假的 /v1/responses：驗證請求形狀與回應解析；fixture 內容不代表真實搜尋結果。

const RESPONSE = {
  model: "gpt-fixture",
  output: [
    { type: "web_search_call", status: "completed" },
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "新竹市今天多雲，22 到 27 度（fixture）。",
          annotations: [
            { type: "url_citation", url: "https://example.com/a", title: "A 氣象" },
            { type: "url_citation", url: "https://example.com/a", title: "A 氣象" },
            { type: "url_citation", url: "https://example.org/b" },
          ],
        },
      ],
    },
  ],
};

function fake(responses: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return responses.shift()!;
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetch };
}

const opts = { apiKey: "sk-fixture", model: "gpt-fixture", country: "TW", timezone: "Asia/Taipei" };

describe("WebSearch", () => {
  it("calls Responses API with the web_search tool and returns answer + deduplicated sources", async () => {
    const api = fake([new Response(JSON.stringify(RESPONSE), { status: 200 })]);
    const search = new WebSearch({ ...opts, fetch: api.fetch });
    const result = await search.search("新竹天氣");
    expect(result).toEqual({
      ok: true,
      answer: "新竹市今天多雲，22 到 27 度（fixture）。",
      sources: [
        { title: "A 氣象", url: "https://example.com/a" },
        { title: "example.org", url: "https://example.org/b" },
      ],
      candidates: [
        { n: 1, title: "A 氣象", url: "https://example.com/a", host: "example.com", points: [], summarized: false },
        { n: 2, title: "example.org", url: "https://example.org/b", host: "example.org", points: [], summarized: false },
      ],
      model: "gpt-fixture",
    });
    expect(api.bodies[0]).toMatchObject({
      model: "gpt-fixture",
      input: "新竹天氣",
      store: false,
      tools: [{ type: "web_search", search_context_size: "low", user_location: { type: "approximate", country: "TW", timezone: "Asia/Taipei" } }],
    });
  });

  it("retries without the reasoning parameter when the model rejects it", async () => {
    const api = fake([
      new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort'" } }), { status: 400 }),
      new Response(JSON.stringify(RESPONSE), { status: 200 }),
    ]);
    const result = await new WebSearch({ ...opts, fetch: api.fetch }).search("q");
    expect(result.ok).toBe(true);
    expect(api.bodies[0]).toHaveProperty("reasoning");
    expect(api.bodies[1]).not.toHaveProperty("reasoning");
  });

  it("reports missing key, auth errors and empty answers honestly", async () => {
    await expect(new WebSearch({ ...opts, apiKey: null }).search("q")).rejects.toMatchObject({ status: 409 });
    const unauth = fake([new Response("{}", { status: 401 })]);
    await expect(new WebSearch({ ...opts, fetch: unauth.fetch }).search("q")).rejects.toThrow(/401/);
    const empty = fake([new Response(JSON.stringify({ output: [] }), { status: 200 })]);
    await expect(new WebSearch({ ...opts, fetch: empty.fetch }).search("q")).rejects.toBeInstanceOf(WebSearchError);
  });

  it("parseResponse ignores non-message items", () => {
    expect(parseResponse({ output: [{ type: "web_search_call" }] })).toEqual({ text: "", sources: [] });
  });
});

// 搜尋模型回的文字（fixture，不是真實的搜尋結果）。
const ANSWER = "台股今天收 23,456.78 點，漲 1.2%（fixture）。";
const CITES = [
  { title: "A 財經", url: "https://news.example.com/a" },
  { title: "B 新聞", url: "https://www.example.org/b" },
];
const CANDIDATES = {
  candidates: [
    { title: "台股收盤", url: "https://news.example.com/a", points: ["加權指數收 23,456.78 點", "成交量 4,321 億元", "外資買超 120 億元"] },
    { title: "半導體領漲", url: "https://www.example.org/b#top", points: ["台積電上漲 1.2%", "聯發科持平"] },
    { title: "盤後分析", url: "https://c.example.net/x", points: [] },
  ],
};

describe("parseCandidates", () => {
  it("splits the spoken answer from a fenced JSON block and numbers up to three candidates", () => {
    const parsed = parseCandidates(`${ANSWER}\n\n\`\`\`json\n${JSON.stringify(CANDIDATES)}\n\`\`\``, CITES);
    expect(parsed.answer).toBe(ANSWER);
    expect(parsed.candidates).toEqual([
      { n: 1, title: "台股收盤", url: "https://news.example.com/a", host: "news.example.com", points: ["加權指數收 23,456.78 點", "成交量 4,321 億元", "外資買超 120 億元"], summarized: true },
      { n: 2, title: "半導體領漲", url: "https://www.example.org/b#top", host: "example.org", points: ["台積電上漲 1.2%", "聯發科持平"], summarized: true },
      { n: 3, title: "盤後分析", url: "https://c.example.net/x", host: "c.example.net", points: [], summarized: false },
    ]);
  });

  it("accepts trailing JSON without a fence and keeps it out of the answer", () => {
    const parsed = parseCandidates(`${ANSWER}\n${JSON.stringify(CANDIDATES)}`, CITES);
    expect(parsed.answer).toBe(ANSWER);
    expect(parsed.candidates.map((c) => c.title)).toEqual(["台股收盤", "半導體領漲", "盤後分析"]);
  });

  it("malformed JSON falls back to the citations with no invented points, and the broken block is not spoken", () => {
    const parsed = parseCandidates(`${ANSWER}\n\`\`\`json\n{"candidates":[{"title":"台股收盤","url":\n\`\`\``, CITES);
    expect(parsed.answer).toBe(ANSWER);
    expect(parsed.candidates).toEqual([
      { n: 1, title: "A 財經", url: "https://news.example.com/a", host: "news.example.com", points: [], summarized: false },
      { n: 2, title: "B 新聞", url: "https://www.example.org/b", host: "example.org", points: [], summarized: false },
    ]);
    expect(parseCandidates(`${ANSWER}\n{"candidates": [`, CITES).answer).toBe(ANSWER);
  });

  it("no JSON at all: answer unchanged, candidates from citations", () => {
    expect(parseCandidates(ANSWER, CITES)).toMatchObject({ answer: ANSWER, candidates: [{ n: 1, summarized: false }, { n: 2, summarized: false }] });
    expect(parseCandidates(ANSWER, [])).toEqual({ answer: ANSWER, candidates: [] });
  });

  it("caps at three, dedupes by URL (ignoring #fragment and trailing slash), drops non-http items and clips five points", () => {
    const many = {
      candidates: [
        { title: "一", url: "https://a.example/x", points: ["1", "2", "3", "4", "5", "6"] },
        { title: "一（重複）", url: "https://a.example/x/#p", points: ["重複"] },
        { title: "壞網址", url: "javascript:alert(1)", points: ["x"] },
        { title: "二", url: "https://b.example/", points: ["b"] },
        { title: "三", url: "https://c.example/", points: ["c"] },
        { title: "四", url: "https://d.example/", points: ["d"] },
      ],
    };
    const parsed = parseCandidates(`答案\n\`\`\`json\n${JSON.stringify(many)}\n\`\`\``, []);
    expect(parsed.candidates.map((c) => [c.n, c.title])).toEqual([[1, "一"], [2, "二"], [3, "三"]]);
    expect(parsed.candidates[0].points).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("WebSearch.search returns structured candidates from the model's JSON block", async () => {
    const body = { model: "gpt-fixture", output: [{ type: "message", content: [{ type: "output_text", text: `${ANSWER}\n\`\`\`json\n${JSON.stringify(CANDIDATES)}\n\`\`\``, annotations: [] }] }] };
    const api = fake([new Response(JSON.stringify(body), { status: 200 })]);
    const result = await new WebSearch({ ...opts, fetch: api.fetch }).search("台股");
    expect(result.answer).toBe(ANSWER);
    expect(result.candidates).toHaveLength(3);
    expect(String(api.bodies[0].instructions)).toMatch(/json/);
  });
});

describe("tool outputs for the voice model", () => {
  const candidates = parseCandidates(`${ANSWER}\n${JSON.stringify(CANDIDATES)}`, CITES).candidates;

  it("web_search with several candidates lists numbers, titles and hosts only (no points before the pick)", () => {
    const out = searchToolOutput({ answer: ANSWER, candidates });
    expect(out.candidates).toEqual([
      { n: 1, title: "台股收盤", host: "news.example.com" },
      { n: 2, title: "半導體領漲", host: "example.org" },
      { n: 3, title: "盤後分析", host: "c.example.net" },
    ]);
    expect(JSON.stringify(out)).not.toContain("外資買超");
    expect(out.next).toMatch(/show_search_result/);
  });

  it("web_search with one candidate hands its points over directly; an unsummarized one says there are none", () => {
    expect(searchToolOutput({ answer: ANSWER, candidates: [candidates[0]] })).toMatchObject({ points: candidates[0].points });
    expect(searchToolOutput({ answer: ANSWER, candidates: [candidates[2]] })).not.toHaveProperty("points");
  });

  it("show_search_result output carries the picked points", () => {
    expect(pickToolOutput(candidates[1])).toMatchObject({ ok: true, n: 2, title: "半導體領漲", host: "example.org", points: ["台積電上漲 1.2%", "聯發科持平"] });
    expect(pickToolOutput(candidates[2])).toMatchObject({ ok: true, points: [], note: expect.stringContaining("沒有摘要") });
  });
});

describe("matchSpokenPoint (read-along)", () => {
  const zh = ["加權指數收 23,456.78 點", "成交量 4,321 億元", "外資買超 120 億元"];
  const en = ["The index closed at 23,456.78 points", "Turnover reached 432.1 billion", "Foreign investors bought 12 billion"];

  it.each([
    ["", null],
    ["好，我念第二則。", null],
    ["加權指數收兩萬三千多點", 0],
    ["加權指數收 23456.78 點。成交量４，３２１億元", 1],
    ["成交量 4321 億元，外資買超一百二十億", 2],
    ["外資買超 120 億元。回到加權指數收盤", 0],
  ] as const)("zh 「%s」 → %s", (spoken, expected) => {
    expect(matchSpokenPoint(spoken, zh)).toBe(expected);
  });

  it.each([
    ["Let me read it.", null],
    ["The index closed at twenty-three thousand", 0],
    ["the index is at 23,456.78 and turnover was 432.1 billion", 1],
    ["Foreign investors bought a lot", 2],
  ] as const)("en 「%s」 → %s", (spoken, expected) => {
    expect(matchSpokenPoint(spoken, en)).toBe(expected);
  });

  it("a key shared by two points is not distinctive (no guess)", () => {
    expect(matchSpokenPoint("2026 年", ["2026 年營收創高", "2026 年獲利下滑"])).toBe(null);
  });
});

describe("parseMcp", () => {
  it("parses servers, defaults require_approval to always, and rejects bad input", () => {
    expect(parseMcp(undefined)).toEqual([]);
    expect(parseMcp('[{"server_label":"cal","server_url":"https://x.test/mcp","allowed_tools":["list"]}]')).toEqual([
      { server_label: "cal", server_url: "https://x.test/mcp", allowed_tools: ["list"], require_approval: "always" },
    ]);
    expect(parseMcp('[{"server_label":"r","server_url":"https://x.test","require_approval":"never"}]')[0].require_approval).toBe("never");
    expect(() => parseMcp("{}")).toThrow(/JSON 陣列/);
    expect(() => parseMcp('[{"server_label":"a","server_url":"http://x"}]')).toThrow(/https/);
    expect(() => parseMcp('[{"server_label":"a","server_url":"https://x"},{"server_label":"a","server_url":"https://y"}]')).toThrow(/重複/);
  });
});
