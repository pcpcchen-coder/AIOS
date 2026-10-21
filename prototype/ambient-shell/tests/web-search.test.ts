import { describe, expect, it } from "vitest";
import { parseMcp } from "../server/config.ts";
import { parseResponse, WebSearch, WebSearchError } from "../server/web-search.ts";

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
    expect(parseResponse({ output: [{ type: "web_search_call" }] })).toEqual({ answer: "", sources: [] });
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
