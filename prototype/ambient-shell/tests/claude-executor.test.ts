import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeExecutor, parsePlan } from "../server/claude-executor.ts";
import { ExecutionError, type Reporter } from "../server/runner.ts";

// 以假的 fetch 取代網路，驗證送出的請求形狀與進度回報；不代表真實模型能力。

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

const MODELS = [
  { type: "model", id: "claude-haiku-5-5", display_name: "Haiku", created_at: "2026-09-10T00:00:00Z" },
  { type: "model", id: "claude-opus-5", display_name: "Opus 5", created_at: "2026-05-01T00:00:00Z" },
  { type: "model", id: "claude-opus-5-5", display_name: "Opus 5.5", created_at: "2026-09-22T00:00:00Z" },
  { type: "model", id: "claude-sonnet-5-5", display_name: "Sonnet 5.5", created_at: "2026-09-28T00:00:00Z" },
];

const PLAN = {
  steps: [
    { title: "列出重點", instruction: "整理三個重點" },
    { title: "撰寫草稿", instruction: "寫成短文" },
  ],
  assumptions: ["讀者是團隊成員"],
  capability_gaps: ["無法實際寄出"],
};

function message(text: string, stop_reason = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function sse(chunks: string[]): string {
  const events: object[] = [
    { type: "message_start", message: { ...message(""), content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...chunks.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function fakeClient(handler: (req: Recorded) => Response) {
  const requests: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const req: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    requests.push(req);
    return handler(req);
  };
  const client = new Anthropic({ apiKey: "test-key", baseURL: "http://fake.local", fetch, maxRetries: 0 });
  return { client, requests };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function happyHandler(req: Recorded): Response {
  if (req.path === "/v1/models") return json({ data: MODELS, has_more: false, first_id: null, last_id: null });
  if (req.body?.stream) {
    return new Response(sse(["第一段，", "第二段。"]), { headers: { "content-type": "text/event-stream" } });
  }
  return json(message(JSON.stringify(PLAN)));
}

function recordingReporter() {
  const calls: string[] = [];
  const reporter: Reporter = {
    planReady: (titles, model) => calls.push(`plan:${titles.join("|")}:${model}`),
    stepStarted: (i) => calls.push(`start:${i}`),
    stepProgress: (i, chars) => calls.push(`progress:${i}:${chars}`),
    stepDone: (i) => calls.push(`done:${i}`),
  };
  return { reporter, calls };
}

describe("ClaudeExecutor", () => {
  it("經 Models API 取最新的 opus 系列模型，不寫死型號", async () => {
    const { client } = fakeClient(happyHandler);
    const ex = new ClaudeExecutor({ apiKey: "k", model: null, modelFamily: "opus", fallbacks: true, client });
    expect(await ex.resolveModel()).toBe("claude-opus-5-5");
  });

  it("有設定 NOUS_MODEL 時直接使用，不查 Models API", async () => {
    const { client, requests } = fakeClient(happyHandler);
    const ex = new ClaudeExecutor({ apiKey: "k", model: "claude-sonnet-5-5", modelFamily: "opus", fallbacks: true, client });
    expect(await ex.resolveModel()).toBe("claude-sonnet-5-5");
    expect(requests).toHaveLength(0);
  });

  it("規劃 → 逐步串流執行 → 彙整，進度只來自真實回應", async () => {
    const { client, requests } = fakeClient(happyHandler);
    const ex = new ClaudeExecutor({ apiKey: "k", model: null, modelFamily: "opus", fallbacks: true, client });
    const { reporter, calls } = recordingReporter();

    const result = await ex.run({ title: "寫一封週報" }, reporter, new AbortController().signal);

    expect(calls[0]).toBe("plan:列出重點|撰寫草稿|彙整成果:claude-opus-5-5");
    // 三步（兩個規劃步驟＋彙整）各自 start → progress(實際字元數) → done；"第一段，第二段。" 共 8 字
    for (const i of [0, 1, 2]) {
      expect(calls).toContain(`start:${i}`);
      expect(calls).toContain(`progress:${i}:8`);
      expect(calls).toContain(`done:${i}`);
    }
    expect(result).toMatchObject({
      content: "第一段，第二段。",
      assumptions: ["讀者是團隊成員"],
      capability_gaps: ["無法實際寄出"],
      status: "complete",
      model: "claude-opus-5-5",
    });

    const messageCalls = requests.filter((r) => r.path === "/v1/messages");
    expect(messageCalls).toHaveLength(4);
    const [plan, ...steps] = messageCalls;
    expect(plan.body).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    expect(plan.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    for (const s of steps) expect(s.body).toMatchObject({ stream: true, output_config: { effort: "medium" } });
    expect(JSON.stringify(steps[2].body)).toContain("第一段，第二段。"); // 彙整時帶入先前產出
  });

  it("NOUS_FALLBACKS=off 時不送 beta 參數", async () => {
    const { client, requests } = fakeClient(happyHandler);
    const ex = new ClaudeExecutor({ apiKey: "k", model: "claude-opus-5-5", modelFamily: "opus", fallbacks: false, client });
    await ex.run({ title: "x" }, recordingReporter().reporter, new AbortController().signal);
    const first = requests.find((r) => r.path === "/v1/messages")!;
    expect(first.body).not.toHaveProperty("fallbacks");
    expect(first.headers.get("anthropic-beta")).toBeNull();
  });

  it("模型拒絕時回報失敗原因，不產生成果", async () => {
    const { client } = fakeClient((req) =>
      req.path === "/v1/models" ? happyHandler(req) : json(message("", "refusal")),
    );
    const ex = new ClaudeExecutor({ apiKey: "k", model: "claude-opus-5-5", modelFamily: "opus", fallbacks: true, client });
    const run = ex.run({ title: "x" }, recordingReporter().reporter, new AbortController().signal);
    await expect(run).rejects.toThrow(ExecutionError);
    await expect(run).rejects.toThrow(/拒絕/);
  });

  it("API key 錯誤轉成可讀的 401 說明", async () => {
    const { client } = fakeClient(() =>
      json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401),
    );
    const ex = new ClaudeExecutor({ apiKey: "k", model: "claude-opus-5-5", modelFamily: "opus", fallbacks: true, client });
    await expect(ex.run({ title: "x" }, recordingReporter().reporter, new AbortController().signal)).rejects.toThrow(
      /401/,
    );
  });
});

describe("parsePlan", () => {
  it("最多保留 5 步，過濾無效步驟", () => {
    const steps = Array.from({ length: 7 }, (_, i) => ({ title: `步驟${i}`, instruction: "做" }));
    const plan = parsePlan(JSON.stringify({ steps: [{ title: " ", instruction: "x" }, ...steps], assumptions: [], capability_gaps: [] }));
    expect(plan.steps.map((s) => s.title)).toEqual(["步驟0", "步驟1", "步驟2", "步驟3", "步驟4"]);
  });

  it("沒有步驟或不是 JSON 時視為失敗", () => {
    expect(() => parsePlan("not json")).toThrow(ExecutionError);
    expect(() => parsePlan(JSON.stringify({ steps: [] }))).toThrow(/沒有任何可執行的步驟/);
  });
});
