import { DOMAINS } from "../shared/domain.ts";
import { describe, expect, it } from "vitest";
import type { ChatGPTAuth } from "../server/chatgpt-auth.ts";
import { ChatGPTExecutor } from "../server/chatgpt-executor.ts";
import { ExecutionError, type Reporter } from "../server/runner.ts";

// 假的 /v1/models 與 /v1/responses（SSE），驗證請求形狀、進度回報與錯誤對應；不代表真實模型能力。

const PLAN = {
  steps: [{ title: "列出重點", instruction: "整理三個重點" }],
  assumptions: ["讀者是團隊成員"],
  capability_gaps: [],
};

function sse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const textStream = (chunks: string[], terminal = "response.completed") =>
  sse([
    { type: "response.created", response: { model: "gpt-x-2026" } },
    ...chunks.map((delta) => ({ type: "response.output_text.delta", delta })),
    { type: terminal, response: { model: "gpt-x-2026" } },
  ]);

interface Recorded {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

function setup(responses: (body: Record<string, unknown>) => Response) {
  const requests: Recorded[] = [];
  const invalidated: string[] = [];
  const auth = {
    getAccessToken: async () => "oauth-access",
    invalidate: (m: string) => invalidated.push(m),
  } as unknown as ChatGPTAuth;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({
          models: [
            { slug: "hidden-model", display_name: "Hidden", visibility: "hide" },
            { slug: "gpt-x", display_name: "GPT X", visibility: "list" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return responses(body!);
  };
  const ex = new ChatGPTExecutor(auth, { model: null, fetch: fakeFetch as typeof fetch });
  const calls: string[] = [];
  const reporter: Reporter = {
    planReady: (steps, model) =>
      calls.push(`plan:${steps.map((s) => `${s.title}/${s.domain}`).join("|")}:${model}`),
    stepStarted: (i) => calls.push(`start:${i}`),
    stepProgress: (i, n) => calls.push(`progress:${i}:${n}`),
    stepDone: (i) => calls.push(`done:${i}`),
  };
  const run = () => ex.run({ title: "寫週報" }, reporter, new AbortController().signal);
  return { requests, invalidated, calls, run };
}

describe("ChatGPTExecutor", () => {
  it("用帳號模型清單的第一個可顯示模型，依 SIWC 限制送出串流請求", async () => {
    const t = setup((body) => (body.text ? textStream([JSON.stringify(PLAN)]) : textStream(["第一段，", "第二段。"])));
    const result = await t.run();

    expect(t.calls[0]).toBe("plan:列出重點/language|彙整成果/language:gpt-x");
    expect(t.calls).toEqual(expect.arrayContaining(["start:0", "progress:0:8", "done:0", "start:1", "progress:1:8", "done:1"]));
    expect(result).toMatchObject({ content: "第一段，第二段。", status: "complete", model: "gpt-x-2026" });

    const inference = t.requests.filter((r) => r.url.endsWith("/v1/responses"));
    expect(inference).toHaveLength(3);
    for (const r of inference) {
      expect(r.auth).toBe("Bearer oauth-access");
      expect(r.body).toMatchObject({ model: "gpt-x", store: false, stream: true });
      expect(typeof r.body!.instructions).toBe("string");
      expect(JSON.stringify(r.body!.input)).not.toContain('"system"');
      for (const banned of ["temperature", "max_output_tokens", "previous_response_id", "metadata", "user"]) {
        expect(r.body).not.toHaveProperty(banned);
      }
    }
    expect(inference[0].body!.text).toMatchObject({ format: { type: "json_schema", strict: true } });
  });

  it("語音對話：system 放 instructions、歷史放 input，串流回覆", async () => {
    const t = setup(() => textStream(["你好", "！"]));
    const ex = new ChatGPTExecutor(
      { getAccessToken: async () => "oauth-access" } as unknown as ChatGPTAuth,
      { model: "gpt-x", fetch: (async (_u: string, init?: RequestInit) => {
        t.requests.push({ url: String(_u), auth: null, body: JSON.parse(String(init!.body)) });
        return textStream(["你好", "！"]);
      }) as unknown as typeof fetch },
    );
    const deltas: string[] = [];
    const messages = [
      { role: "user" as const, content: "嗨" },
      { role: "assistant" as const, content: "你好" },
      { role: "user" as const, content: "今天天氣？" },
    ];
    await ex.chat({ system: "SYS", messages }, (d) => deltas.push(d), new AbortController().signal);
    expect(deltas.join("")).toBe("你好！");
    expect(t.requests.at(-1)!.body).toMatchObject({ model: "gpt-x", instructions: "SYS", input: messages, store: false, stream: true });
  });

  it("does not claim chat completion on response.incomplete", async () => {
    const executor = new ChatGPTExecutor(
      { getAccessToken: async () => "fixture-token" } as unknown as ChatGPTAuth,
      { model: "fixture-model", fetch: (async () => textStream(["部分"], "response.incomplete")) as typeof fetch },
    );
    await expect(executor.chat({ system: "SYS", messages: [{ role: "user", content: "你好" }] }, () => {}, new AbortController().signal)).rejects.toThrow(/response.incomplete/);
  });

  it("用量上限：失敗並提示到 ChatGPT 設定管理用量", async () => {
    const t = setup(() =>
      sse([
        { type: "response.created", response: {} },
        { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } },
      ]),
    );
    const err = await t.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutionError);
    expect(err).toMatchObject({ action: "manage_chatgpt_usage" });
  });

  it("串流前 401：保留原始訊息並提示重新登入", async () => {
    const t = setup(() => new Response(JSON.stringify({ detail: "bad identity" }), { status: 401 }));
    const err = (await t.run().catch((e: unknown) => e)) as ExecutionError;
    expect(err.action).toBe("chatgpt_sign_in");
    expect(err.userMessage).toContain("401");
  });

  it("subscription_sharing_invalid_user：標記登入失效", async () => {
    const t = setup(
      () =>
        new Response(JSON.stringify({ error: { code: "subscription_sharing_invalid_user", message: "x" } }), {
          status: 401,
          headers: { "x-request-id": "req_abc" },
        }),
    );
    const err = (await t.run().catch((e: unknown) => e)) as ExecutionError;
    expect(err.userMessage).toContain("req_abc");
    expect(t.invalidated).toHaveLength(1);
  });

  it("網路錯誤轉成可讀說明，不顯示原始的 fetch failed", async () => {
    const t = setup(() => {
      throw new TypeError("fetch failed");
    });
    await expect(t.run()).rejects.toThrow(/無法連線到 OpenAI API/);
  });

  it("串流沒有 response.completed 就結束時，不當成成功", async () => {
    const t = setup(() => sse([{ type: "response.output_text.delta", delta: "半" }]));
    await expect(t.run()).rejects.toThrow(/沒有收到 response.completed/);
  });

  it("response.incomplete 標為不完整成果", async () => {
    const t = setup((body) =>
      body.text ? textStream([JSON.stringify(PLAN)]) : textStream(["部分"], "response.incomplete"),
    );
    const result = await t.run();
    expect(result.status).toBe("partial");
    expect(result.capability_gaps.join()).toContain("response.incomplete");
  });
});


it.each(DOMAINS)("ChatGPT planner passes %s through Reporter and six-category schema", async (domain) => {
  const t = setup((body) => body.text ? textStream([JSON.stringify({ ...PLAN, steps: [{ title: "主題步驟", instruction: "執行", domain }] })]) : textStream(["產出。"]));
  await t.run();
  expect(t.calls[0]).toBe(`plan:主題步驟/${domain}|彙整成果/language:gpt-x`);
  const schema = t.requests.find((r) => r.body?.text)?.body?.text;
  expect(schema).toMatchObject({ format: { schema: { properties: { steps: { items: { properties: { domain: { enum: DOMAINS } } } } } } } });
});
