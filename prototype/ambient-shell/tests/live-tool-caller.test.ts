import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESULT_UNKNOWN_TEXT } from "../shared/realtime-route.ts";
import { CodexAuth } from "../server/codex-auth.ts";
import { CodexError, CodexResponses, type CodexTurn, type CodexTurnRequest } from "../server/codex-responses.ts";
import {
  APPROVAL_WINDOW_MS,
  approvalGuard,
  buildCallerInstructions,
  CALLER_LIMITS,
  DELEGATION_BUDGET_MS,
  liveCallerTools,
  LiveToolCaller,
  MAX_HOST_TIMEOUT_MS,
} from "../server/live-tool-caller.ts";
import { buildRealtimeInstructions, realtimeToolRules, REALTIME_TOOLS } from "../server/realtime.ts";
import { HOST_TIMEOUT_MS, hostTimeoutOutput, type ApprovalSnapshot, type ToolHost } from "../server/realtime-routes.ts";
import { codexTurn, scriptedFetch, writeCredentials } from "./fixtures/fake-chatgpt.ts";

// LiveToolCaller：把 gpt-live-1-codex 的交辦文字變成和 API key 路徑相同的工具呼叫。Codex Responses 與頁面都是假的（fixture）。

const CAPS = { webSearch: true, mcp: [], taskWebSearch: true, home: true };
const NO_CARD: ApprovalSnapshot = { open: false, resolvedAt: null };

function turn(partial: Partial<CodexTurn>): CodexTurn {
  return { text: "", calls: [], citations: [], model: "gpt-fixture-codex", replay: [], ...partial };
}

function caller(turns: (CodexTurn | Error | ((req: CodexTurnRequest) => Promise<CodexTurn>))[], host: Partial<ToolHost> & { calls?: { name: string; args: Record<string, unknown> }[] } = {}, approval: ApprovalSnapshot = NO_CARD, now = () => Date.now()) {
  const requests: CodexTurnRequest[] = [];
  const hostCalls: { name: string; args: Record<string, unknown> }[] = host.calls ?? [];
  const responses = {
    turn: async (req: CodexTurnRequest) => {
      requests.push({ ...req, input: [...req.input] });
      const next = turns.shift();
      if (!next) throw new Error("no more turns");
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(req);
      return next;
    },
  };
  const toolHost: ToolHost = {
    outstanding: 0,
    call: host.call ?? (async (name, args) => {
      hostCalls.push({ name, args });
      return { ok: true, status: "unconfirmed", device: "客廳燈", room: "客廳", action: "開啟", why: "no_reply", message: "已送出，設備還沒確認（fixture）" };
    }),
  };
  const c = new LiveToolCaller({ responses, caps: () => CAPS, host: toolHost, tasks: () => [], approval: () => approval, now });
  return { c, requests, hostCalls };
}

const request = (text: string) => ({ id: "d1", text, source: "voice" as const, transcript: [] });

afterEach(() => {
  vi.useRealTimers();
});

describe("budget arithmetic", () => {
  it("DELEGATION_BUDGET_MS = maxTurns × turn + maxHostCalls × slowest host wait + margin, recomputed from the constants", () => {
    const slowest = Math.max(...Object.values(HOST_TIMEOUT_MS));
    expect(MAX_HOST_TIMEOUT_MS).toBe(slowest);
    expect(slowest).toBe(HOST_TIMEOUT_MS.home_control);
    expect(DELEGATION_BUDGET_MS).toBe(CALLER_LIMITS.maxTurns * CALLER_LIMITS.turnTimeoutMs + CALLER_LIMITS.maxHostCalls * slowest + CALLER_LIMITS.marginMs);
    // 3 × 20 s ＋ 2 × 62 s ＋ 3 s ＝ 187 s（docs/validation/live-voice-2026-10-23.md）
    expect(DELEGATION_BUDGET_MS).toBe(187_000);
  });
});

describe("tool registry and rules are the GA ones", () => {
  it("uses the same function tools as REALTIME_TOOLS (minus MCP), flat, strict:false", () => {
    const tools = liveCallerTools({ ...CAPS, mcp: [{ server_label: "x", server_url: "https://x", require_approval: "always" }] });
    const names = tools.map((t) => (t.type === "function" ? t.name : t.type));
    expect(names).toEqual([...REALTIME_TOOLS.map((t) => t.name), "home_status", "home_control"]);
    for (const t of tools) expect(t).toMatchObject({ type: "function", strict: false });
    const ga = REALTIME_TOOLS.find((t) => t.name === "delegate_task")!;
    expect(tools.find((t) => t.type === "function" && t.name === "delegate_task")).toMatchObject({ description: ga.description, parameters: ga.parameters });
  });

  it("the caller gets the exact rule paragraphs the GA voice model gets", () => {
    const text = buildCallerInstructions(CAPS, [], new Date("2026-10-23T00:00:00Z"));
    for (const rule of realtimeToolRules(CAPS)) expect(text).toContain(rule);
    for (const rule of realtimeToolRules(CAPS)) expect(buildRealtimeInstructions([], new Date(), CAPS)).toContain(rule);
    expect(text).toContain("你不能確認");
    expect(text).toContain(RESULT_UNKNOWN_TEXT);
  });
});

describe("LiveToolCaller.run", () => {
  it("home_control unconfirmed: one host call, the result fed back, the speakable answer says sent-not-confirmed", async () => {
    const t = caller([
      turn({ calls: [{ call_id: "c1", name: "home_control", arguments: JSON.stringify({ target: "客廳燈", command: "power", value: "true" }) }] }),
      turn({ text: "已送出，但燈還沒確認，請看一下有沒有亮。" }),
    ]);
    const result = await t.c.run(request("客廳燈打開"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, channel: "speakable", text: "已送出，但燈還沒確認，請看一下有沒有亮。" });
    expect(result.text).not.toContain("開了");
    expect(t.hostCalls).toEqual([{ name: "home_control", args: { target: "客廳燈", command: "power", value: "true" } }]);
    const fed = t.requests[1].input.at(-1) as { type: string; call_id: string; output: string };
    expect(fed).toMatchObject({ type: "function_call_output", call_id: "c1" });
    expect(JSON.parse(fed.output)).toMatchObject({ status: "unconfirmed" });
  });

  it("caps host calls per delegation at MAX_HOST_CALLS and never runs the extra one", async () => {
    const call = (n: number) => ({ call_id: `c${n}`, name: "home_status", arguments: JSON.stringify({ target: `房間${n}` }) });
    const t = caller([turn({ calls: [call(1), call(2), call(3)] }), turn({ text: "好" })]);
    await t.c.run(request("查三個房間"), new AbortController().signal);
    expect(t.hostCalls).toHaveLength(CALLER_LIMITS.maxHostCalls);
    const outputs = t.requests[1].input.filter((i) => (i as { type?: string }).type === "function_call_output") as { output: string }[];
    expect(JSON.parse(outputs[2].output)).toMatchObject({ ok: false });
  });

  it("a host timeout on home_control reaches the model as unknown, not failure", async () => {
    const t = caller(
      [turn({ calls: [{ call_id: "c1", name: "home_control", arguments: "{\"target\":\"冷氣\",\"command\":\"power\",\"value\":\"true\"}" }] }), turn({ text: `${RESULT_UNKNOWN_TEXT}。` })],
      { call: async (name) => hostTimeoutOutput(name) },
    );
    const result = await t.c.run(request("開冷氣"), new AbortController().signal);
    const fed = JSON.parse((t.requests[1].input.at(-1) as { output: string }).output);
    expect(fed).toMatchObject({ status: "unknown" });
    expect(result.text).toContain(RESULT_UNKNOWN_TEXT);
  });

  it("over budget with no side effect → 「沒有完成：處理超過時間」; with a side effect still out → 「結果不明，請確認」", async () => {
    vi.useFakeTimers();
    // 下層（模型那一輪）不理中止訊號也一樣：上限一到就回報。
    const hang = () => new Promise<CodexTurn>(() => {});
    const b = caller([hang]);
    const timedOut = b.c.run(request("查天氣"), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(DELEGATION_BUDGET_MS);
    expect(await timedOut).toMatchObject({ ok: false, reason: "timeout", text: `沒有完成：處理超過時間（${DELEGATION_BUDGET_MS / 1000} 秒）。` });

    const pendingHost: ToolHost = {
      outstanding: 1,
      call: (_name, _args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const c = caller([turn({ calls: [{ call_id: "c1", name: "home_control", arguments: "{\"target\":\"客廳燈\",\"command\":\"power\",\"value\":\"true\"}" }] })], pendingHost);
    const unknown = c.c.run(request("客廳燈打開"), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(DELEGATION_BUDGET_MS);
    const result = await unknown;
    expect(result).toMatchObject({ ok: false, reason: "unknown" });
    expect(result.text).toBe(`${RESULT_UNKNOWN_TEXT}。`);
    expect(result.text).not.toMatch(/失敗|沒有完成/);
  });

  it("usage limit and expired login are spoken truthfully", async () => {
    const usage = caller([new CodexError({ kind: "usage_limit", plan: "plus", resets_in_min: 42 }, "ChatGPT 方案額度已用完，約 42 分鐘後重置")]);
    expect(await usage.c.run(request("查天氣"), new AbortController().signal)).toMatchObject({ ok: false, reason: "usage_limit", text: "沒有完成：ChatGPT 方案額度已用完，約 42 分鐘後重置。" });
    const auth = caller([new CodexError({ kind: "auth", reason: "needs_reauth" }, "x")]);
    expect(await auth.c.run(request("查天氣"), new AbortController().signal)).toMatchObject({ ok: false, reason: "auth" });
  });

  it("end_conversation runs through the page and finishes with the goodbye", async () => {
    const t = caller([turn({ calls: [{ call_id: "e", name: "end_conversation", arguments: "{}" }] }), turn({ text: "再見！" })], {});
    const result = await t.c.run(request("再見"), new AbortController().signal);
    expect(t.hostCalls.map((c) => c.name)).toEqual(["end_conversation"]);
    expect(result).toMatchObject({ ok: true, text: "再見！", ended: true });
  });
});

describe("approval phrases (the agent can never confirm)", () => {
  const now = 1_000_000;
  it("a card resolved within N seconds: the delegation is that answer, commentary only, no model, no tool", async () => {
    const t = caller([], {}, { open: false, resolvedAt: now - (APPROVAL_WINDOW_MS - 1) }, () => now);
    const result = await t.c.run(request("確認執行"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, channel: "commentary" });
    expect(t.requests).toHaveLength(0);
    expect(t.hostCalls).toHaveLength(0);
  });

  it("reverse order — the sideband delegation arrives before the page resolves the open card: still commentary, never executed", async () => {
    // 頁面先回報卡片打開（工具結果之前就送到），交辦比「確認執行」的卡片結束先到。
    const state: ApprovalSnapshot = { open: true, resolvedAt: null };
    const t = caller([], {}, state, () => now);
    const result = await t.c.run(request("確認執行"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, channel: "commentary" });
    expect(result.text).toContain("你不能替使用者確認");
    // 之後頁面才結束卡片：再晚到的重複交辦也只是 commentary。
    state.open = false;
    state.resolvedAt = now + 500;
    expect(approvalGuard("確認執行", state, now + 1_000)).toMatchObject({ channel: "commentary" });
    expect(t.requests).toHaveLength(0);
    expect(t.hostCalls).toHaveLength(0);
  });

  it("no card and none resolved recently: 「目前沒有需要確認的項目」; outside the window it is not an answer", () => {
    expect(approvalGuard("確認執行", NO_CARD, now)).toMatchObject({ channel: "speakable", text: "目前沒有需要確認的項目。" });
    expect(approvalGuard("確認執行", { open: false, resolvedAt: now - APPROVAL_WINDOW_MS - 1 }, now)).toMatchObject({ channel: "speakable" });
    expect(approvalGuard("客廳燈打開", NO_CARD, now)).toBeNull();
  });
});

describe("CodexResponses (fake chatgpt.com)", () => {
  function setup(handler: Parameters<typeof scriptedFetch>[0]) {
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-resp-"));
    const creds = writeCredentials(dir);
    const auth = new CodexAuth({ dir, onChange: () => {}, fetch: scriptedFetch(() => new Response(JSON.stringify({ access_token: creds.access, refresh_token: "rt_x", expires_in: 3600 }))).fetch });
    const { fetch, calls } = scriptedFetch(handler);
    return { responses: new CodexResponses(auth, { model: null, clientVersion: "0.1.0", turnTimeoutMs: 20_000, baseUrl: "https://chatgpt.fixture/backend-api/codex", fetch }), calls, creds };
  }

  it("resolves the model from /models and streams a turn with store:false, parallel_tool_calls:false and the Codex headers", async () => {
    const t = setup((req) =>
      req.url.includes("/models")
        ? new Response(JSON.stringify({ models: [{ slug: "b", visibility: "list", priority: 2 }, { slug: "hidden", visibility: "hide", priority: 0 }, { slug: "a", visibility: "list", priority: 1 }] }))
        : codexTurn({ calls: [{ name: "web_search", arguments: { query: "新竹天氣" } }] }),
    );
    const out = await t.responses.turn({ instructions: "i", input: [{ role: "user", content: "新竹今天會下雨嗎" }], tools: [] });
    expect(out.calls).toEqual([{ call_id: "call_0", name: "web_search", arguments: JSON.stringify({ query: "新竹天氣" }) }]);
    expect(t.calls[0].url).toBe("https://chatgpt.fixture/backend-api/codex/models?client_version=0.1.0");
    const req = t.calls[1];
    expect(req.url).toBe("https://chatgpt.fixture/backend-api/codex/responses");
    expect(req.headers).toMatchObject({ authorization: `Bearer ${t.creds.access}`, "chatgpt-account-id": t.creds.account, originator: "nous", "openai-beta": "responses=experimental", accept: "text/event-stream" });
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({ model: "a", store: false, stream: true, parallel_tool_calls: false, tool_choice: "auto", include: ["reasoning.encrypted_content"] });
    expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "新竹今天會下雨嗎" }] }]);
  });

  it("maps 429 to a usage limit with the reset time, without leaking the token", async () => {
    const t = setup((req) =>
      req.url.includes("/models")
        ? new Response(JSON.stringify({ models: [{ slug: "a", visibility: "list", priority: 1 }] }))
        : new Response(JSON.stringify({ error: { code: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1000) + 600 } }), { status: 429 }),
    );
    const err = (await t.responses.turn({ instructions: "i", input: [], tools: [] }).catch((e: unknown) => e)) as CodexError;
    expect(err.failure).toMatchObject({ kind: "usage_limit", plan: "plus" });
    expect(err.message).toMatch(/ChatGPT 方案額度已用完，約 10 分鐘後重置/);
    expect(err.message).not.toContain(t.creds.access);
  });
});
