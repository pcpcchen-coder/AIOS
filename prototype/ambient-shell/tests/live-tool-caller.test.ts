import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exactApproval } from "../shared/approval.ts";
import { RESULT_UNKNOWN_TEXT } from "../shared/realtime-route.ts";
import { CodexAuth } from "../server/codex-auth.ts";
import { CodexError, CodexResponses, type CodexModelCache, type CodexTurn, type CodexTurnRequest } from "../server/codex-responses.ts";
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
import { buildLiveInstructions, buildRealtimeInstructions, realtimeToolRules, REALTIME_TOOLS } from "../server/realtime.ts";
import { HOST_REPLY_MARGIN_MS, HOST_TIMEOUT_MS, hostTimeoutOutput, type ApprovalSnapshot, type ToolHost } from "../server/realtime-routes.ts";
import { WEB_SEARCH_TIMEOUT_MS } from "../server/web-search.ts";
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

  it("telling the user where to switch to the API key route is right for both the browser and the macOS App", () => {
    const where = "到設定（macOS App：選單列「即時語音」）把路徑切換到 API key";
    expect(buildCallerInstructions(CAPS, [], new Date("2026-10-23T00:00:00Z"))).toContain(where);
    const mcp = [{ name: "notes", url: "https://mcp.example.com" }] as unknown as Parameters<typeof buildLiveInstructions>[2]["mcp"];
    expect(buildLiveInstructions([], new Date(), { mcp })).toContain(where);
    expect(buildLiveInstructions([], new Date(), { mcp: [] })).not.toContain("API key");
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
  const RESOLVED: ApprovalSnapshot = { open: false, resolvedAt: now - (APPROVAL_WINDOW_MS - 1) };
  const OPEN: ApprovalSnapshot = { open: true, resolvedAt: null };

  it("a card resolved within N seconds: the delegation is that answer — speakable, no model, no tool", async () => {
    const t = caller([], {}, RESOLVED, () => now);
    const result = await t.c.run(request("確認執行"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, channel: "speakable" });
    expect(result.text).not.toMatch(/完成|做好/);
    expect(t.requests).toHaveLength(0);
    expect(t.hostCalls).toHaveLength(0);
  });

  it("reverse order — the sideband delegation arrives before the page resolves the open card: speakable, never executed", async () => {
    // 頁面先回報卡片打開（工具結果之前就送到），交辦比「確認執行」的卡片結束先到。
    const state: ApprovalSnapshot = { ...OPEN };
    const t = caller([], {}, state, () => now);
    const result = await t.c.run(request("確認執行"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, channel: "speakable" });
    expect(result.text).toContain("不能替你確認");
    // 之後頁面才結束卡片：再晚到的重複交辦也只是回答那張卡。
    state.open = false;
    state.resolvedAt = now + 500;
    expect(approvalGuard("確認執行", state, now + 1_000)).toMatchObject({ channel: "speakable" });
    expect(t.requests).toHaveLength(0);
    expect(t.hostCalls).toHaveLength(0);
  });

  it("no card open and none answered recently: even 「確認執行」 goes to Codex (never 「目前沒有需要確認」)", async () => {
    expect(approvalGuard("確認執行", NO_CARD, now)).toBeNull();
    expect(approvalGuard("確認執行", { open: false, resolvedAt: now - APPROVAL_WINDOW_MS - 1 }, now)).toBeNull();
    expect(approvalGuard("客廳燈打開", OPEN, now)).toBeNull();
    const t = caller([turn({ text: "目前沒有要確認的事。" })], {}, NO_CARD, () => now);
    const result = await t.c.run(request("確認執行"), new AbortController().signal);
    expect(t.requests).toHaveLength(1);
    expect(result.text).toBe("目前沒有要確認的事。");
  });

  // 審查的探針（probe-live/guard.mts）：這些是請求，不是確認卡的答案。舊的子字串比對會回「目前沒有需要確認的項目」而不呼叫 Codex。
  const REQUESTS = ["停止播放音樂", "把燈關掉，不要開冷氣", "別忘了明天的會議，幫我建立任務", "不用開燈，查一下客廳溫度", "取消明天的鬧鐘"];
  for (const state of [NO_CARD, OPEN, RESOLVED]) {
    it(`requests that merely contain a reject word reach Codex (card ${state.open ? "open" : state.resolvedAt ? "just answered" : "none"})`, async () => {
      for (const text of REQUESTS) {
        expect(approvalGuard(text, state, now)).toBeNull();
        const t = caller([turn({ text: "好" })], {}, state, () => now);
        const result = await t.c.run(request(text), new AbortController().signal);
        expect(t.requests, text).toHaveLength(1);
        expect(result.text).not.toContain("沒有需要確認");
      }
    });
  }

  it("exactApproval is anchored: the whole utterance must be the phrase", () => {
    for (const text of ["確認執行", "確認執行。", "好，確認執行吧", "確定寄出", "請確認刪除"]) expect(exactApproval(text), text).toBe("approve");
    for (const text of ["取消", "不要", "算了", "不用了", "取消執行", "不要執行！", "好，取消吧"]) expect(exactApproval(text), text).toBe("reject");
    for (const text of [...REQUESTS, "開客廳的燈", "確認執行客廳燈打開", "確認一下溫度", ""]) expect(exactApproval(text), text).toBeNull();
  });

  it("the guard uses the snapshot taken when the delegation was enqueued, not the state when it runs", async () => {
    // 執行時卡片已經過了時窗；但使用者說這句話時卡片還開著。
    const t = caller([turn({ text: "不該被呼叫" })], {}, NO_CARD, () => now + 60_000);
    const result = await t.c.run({ ...request("確認執行"), approval: OPEN, at: now }, new AbortController().signal);
    expect(t.requests).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, channel: "speakable" });
  });
});

describe("side-effect outcome is unknown only while it really is", () => {
  const control = (n: number) => ({ call_id: `c${n}`, name: "home_control", arguments: JSON.stringify({ target: "客廳燈", command: "power", value: "true" }) });
  const confirmed = async () => ({ ok: true, status: "confirmed", message: "客廳燈已開啟（設備回讀）" });

  it("a definitive home_control result followed by a Codex failure is not 「結果不明」", async () => {
    const t = caller([turn({ calls: [control(1)] }), new CodexError({ kind: "network" }, "Codex 串流中斷（網路）。")], { call: confirmed });
    const result = await t.c.run(request("客廳燈打開"), new AbortController().signal);
    expect(result.text).not.toContain(RESULT_UNKNOWN_TEXT);
    expect(result.text).toContain("客廳燈已開啟（設備回讀）");
    expect(result).toMatchObject({ ok: false, reason: "upstream" });
  });

  it("status unknown keeps it unknown", async () => {
    const t = caller([turn({ calls: [control(1)] }), new CodexError({ kind: "network" }, "x")], { call: async (name) => hostTimeoutOutput(name) });
    const result = await t.c.run(request("客廳燈打開"), new AbortController().signal);
    expect(result).toMatchObject({ ok: false, reason: "unknown", text: `${RESULT_UNKNOWN_TEXT}。` });
  });

  it("turns run out with known results: the executed outputs are spoken, not 「沒有完成」 or 「結果不明」", async () => {
    const status = (n: number) => ({ call_id: `s${n}`, name: "home_status", arguments: JSON.stringify({ target: "客廳" }) });
    const t = caller([turn({ calls: [control(1)] }), turn({ calls: [status(1)] }), turn({ calls: [status(2)] })], {
      call: async (name) => (name === "home_control" ? confirmed() : { ok: true, message: "客廳 26 度（fixture）" }),
    });
    const result = await t.c.run(request("開燈再查溫度"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, channel: "speakable" });
    expect(result.text).toContain("客廳燈已開啟（設備回讀）");
    expect(result.text).toContain("客廳 26 度（fixture）");
    expect(result.text).not.toMatch(/沒有完成|結果不明/);
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

describe("model lookup is inside each turn's time budget", () => {
  const MODELS = () => new Response(JSON.stringify({ models: [{ slug: "a", visibility: "list", priority: 1 }] }));
  /** 會理會中止訊號的假 fetch（真的 fetch 也是）；handler 回 null 表示永遠不回。 */
  function abortableFetch(handler: (url: string) => Promise<Response | null>) {
    const urls: string[] = [];
    const impl = (async (input: string | URL, init: RequestInit = {}) => {
      urls.push(String(input));
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        void handler(String(input)).then((res) => res && resolve(res), reject);
      });
    }) as unknown as typeof fetch;
    return { fetch: impl, urls };
  }
  function responses(fetchImpl: typeof fetch, turnTimeoutMs: number, modelCache?: CodexModelCache) {
    const dir = mkdtempSync(join(tmpdir(), "nous-codex-budget-"));
    writeCredentials(dir);
    const auth = new CodexAuth({ dir, onChange: () => {}, fetch: scriptedFetch(() => new Response("{}", { status: 500 })).fetch });
    return new CodexResponses(auth, { model: null, clientVersion: "0.1.0", turnTimeoutMs, baseUrl: "https://chatgpt.fixture/backend-api/codex", fetch: fetchImpl, modelCache });
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("a slow /models plus a slow stream still ends at turnTimeoutMs (not lookup + turn)", async () => {
    vi.useFakeTimers();
    const f = abortableFetch(async (url) => (url.includes("/models") ? (await sleep(15_000), MODELS()) : null));
    const r = responses(f.fetch, CALLER_LIMITS.turnTimeoutMs);
    let settled: unknown = null;
    const turn = r.turn({ instructions: "i", input: [], tools: [] }).catch((e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(CALLER_LIMITS.turnTimeoutMs);
    await turn;
    expect(settled).toBeInstanceOf(CodexError);
    expect((settled as CodexError).failure.kind).toBe("timeout");
  });

  it("codex and codexSearch share one model cache: /models is fetched once", async () => {
    const f = abortableFetch(async (url) => (url.includes("/models") ? MODELS() : codexTurn({ text: "好" })));
    const cache: CodexModelCache = { model: null };
    const a = responses(f.fetch, CALLER_LIMITS.turnTimeoutMs, cache);
    const b = responses(f.fetch, WEB_SEARCH_TIMEOUT_MS, cache);
    await a.turn({ instructions: "i", input: [], tools: [] });
    await b.turn({ instructions: "i", input: [], tools: [] });
    expect(f.urls.filter((u) => u.includes("/models"))).toHaveLength(1);
    const nous = readFileSync(new URL("../server/nous.ts", import.meta.url), "utf8");
    expect(nous.match(/new CodexResponses\([^)]*modelCache \}\)/g)).toHaveLength(2);
    expect(nous).toContain("turnTimeoutMs: WEB_SEARCH_TIMEOUT_MS");
  });

  it("live web search (lookup + turn) fits inside the page's wait for web_search", async () => {
    // Codex 上網查詢那一輪的時限＝WEB_SEARCH_TIMEOUT_MS，含第一次查模型清單；頁面多等 HOST_REPLY_MARGIN_MS 轉交結果。
    expect(HOST_TIMEOUT_MS.web_search).toBe(WEB_SEARCH_TIMEOUT_MS + HOST_REPLY_MARGIN_MS);
    expect(WEB_SEARCH_TIMEOUT_MS + HOST_REPLY_MARGIN_MS).toBe(32_000);
    vi.useFakeTimers();
    const f = abortableFetch(async (url) => (url.includes("/models") ? (await sleep(WEB_SEARCH_TIMEOUT_MS - 1_000), MODELS()) : null));
    const r = responses(f.fetch, WEB_SEARCH_TIMEOUT_MS);
    let at: number | null = null;
    const started = Date.now();
    const turn = r.turn({ instructions: "i", input: [], tools: [] }).catch(() => (at = Date.now() - started));
    await vi.advanceTimersByTimeAsync(HOST_TIMEOUT_MS.web_search);
    await turn;
    expect(at).not.toBeNull();
    expect(at!).toBeLessThanOrEqual(WEB_SEARCH_TIMEOUT_MS);
  });
});

describe("MEM-2: recall_memory and the delegation block", () => {
  function memoryCaller(turns: CodexTurn[], memory: { blocked: boolean; recall?: (q: string, s: AbortSignal) => Promise<Record<string, unknown>> }) {
    const requests: CodexTurnRequest[] = [];
    const hostCalls: string[] = [];
    const blockedTitles: (string | null)[] = [];
    const recalls: string[] = [];
    const c = new LiveToolCaller({
      responses: { turn: async (req) => { requests.push({ ...req, input: [...req.input] }); const next = turns.shift(); if (!next) throw new Error("no more turns"); return next; } },
      caps: () => ({ ...CAPS, memory: true }),
      host: { outstanding: 0, call: async (name) => { hostCalls.push(name); return { ok: true, title: "fixture" }; } },
      tasks: () => [],
      approval: () => NO_CARD,
      memory: {
        blocked: () => memory.blocked,
        recall: memory.recall ?? (async (q) => { recalls.push(q); return { facts: [{ text: "不吃香菜", at: "2026-10-30T00:00:00.000Z", expires: null }] }; }),
        delegateBlocked: (title) => void blockedTitles.push(title),
      },
    });
    return { c, requests, hostCalls, blockedTitles, recalls };
  }

  it("offers recall_memory only with caps.memory (never to the API key path); the rule text says it cannot write", () => {
    expect(liveCallerTools(CAPS).map((t) => (t.type === "function" ? t.name : ""))).not.toContain("recall_memory");
    expect(liveCallerTools({ ...CAPS, memory: true }).map((t) => (t.type === "function" ? t.name : ""))).toContain("recall_memory");
    expect(REALTIME_TOOLS.map((t) => t.name)).not.toContain("recall_memory");
    expect(realtimeToolRules({ ...CAPS, memory: true }).join("\n")).toContain("你沒有保存、更正或忘記記憶的工具");
    expect(buildRealtimeInstructions([], new Date(), CAPS)).not.toContain("recall_memory");
    const live = buildLiveInstructions([], new Date(), { mcp: [], memory: true });
    expect(live).toContain("收到以「（記憶確認）」開頭的內容時，只說其中「」裡的那一句");
    expect(live).toContain("（記憶資料）");
    expect(buildLiveInstructions([], new Date(), { mcp: [] })).not.toContain("（記憶確認）");
  });

  it("recall_memory runs in the core (not the page) and its result goes back to Codex as data", async () => {
    const { c, requests, hostCalls, recalls } = memoryCaller([
      turn({ calls: [{ name: "recall_memory", arguments: JSON.stringify({ query: "晚餐吃什麼" }), call_id: "r1" }], replay: [{ type: "function_call", call_id: "r1", name: "recall_memory", arguments: "{}" } as never] }),
      turn({ text: "依你之前交代的，晚餐避開香菜。" }),
    ], { blocked: false });
    const result = await c.run(request("晚餐吃什麼好"), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, text: "依你之前交代的，晚餐避開香菜。" });
    expect(recalls).toEqual(["晚餐吃什麼"]);
    expect(hostCalls).toEqual([]);
    const output = requests[1]!.input.find((i) => (i as { type?: string }).type === "function_call_output") as { output: string };
    expect(JSON.parse(output.output)).toEqual({ facts: [{ text: "不吃香菜", at: "2026-10-30T00:00:00.000Z", expires: null }] });
    expect(requests[0]!.instructions).toContain("你沒有寫入記憶的工具");
  });

  it("a revoked lease means recall answers ok:false (nothing stale is delivered)", async () => {
    const { c, requests } = memoryCaller([
      turn({ calls: [{ name: "recall_memory", arguments: JSON.stringify({ query: "顏色" }), call_id: "r1" }] }),
      turn({ text: "我不確定。" }),
    ], { blocked: true, recall: async () => ({ ok: false, error: "記憶已更新，這次的結果作廢。" }) });
    await c.run(request("我喜歡什麼顏色"), new AbortController().signal);
    const output = requests[1]!.input.find((i) => (i as { type?: string }).type === "function_call_output") as { output: string };
    expect(JSON.parse(output.output)).toEqual({ ok: false, error: "記憶已更新，這次的結果作廢。" });
  });

  it("delegate_task is blocked once the call carries memory: no host call (so no TaskStore entry), the page gets the original-sentence card", async () => {
    const { c, hostCalls, blockedTitles, requests } = memoryCaller([
      turn({ calls: [{ name: "delegate_task", arguments: JSON.stringify({ title: "照 George 不吃香菜的偏好寫菜單" }), call_id: "t1" }] }),
      turn({ text: "請看畫面上的卡，按「交辦」就會開始。" }),
    ], { blocked: true });
    await c.run({ ...request("寫一份照偏好的晚餐菜單報告"), userText: "幫我寫一份晚餐菜單報告" }, new AbortController().signal);
    expect(hostCalls).toEqual([]);
    expect(blockedTitles).toEqual(["幫我寫一份晚餐菜單報告"]);
    const output = requests[1]!.input.find((i) => (i as { type?: string }).type === "function_call_output") as { output: string };
    expect(JSON.parse(output.output)).toMatchObject({ ok: false, status: "delegate_blocked", message: expect.stringContaining("看畫面上的卡") });
    // 找不到觸發交辦的使用者原句：不出卡，Codex 不能說「請看畫面上的卡」，改請使用者再說一次完整的要求。
    const untitled = memoryCaller([turn({ calls: [{ name: "delegate_task", arguments: JSON.stringify({ title: "寫菜單" }), call_id: "t1" }] }), turn({ text: "請再說一次" })], { blocked: true });
    await untitled.c.run(request("寫菜單"), new AbortController().signal);
    expect(untitled.blockedTitles).toEqual([null]);
    const quiet = untitled.requests[1]!.input.find((i) => (i as { type?: string }).type === "function_call_output") as { output: string };
    expect(JSON.parse(quiet.output).message).not.toContain("看畫面上的卡");
    expect(JSON.parse(quiet.output).message).toContain("再說一次");
    const free = memoryCaller([turn({ calls: [{ name: "delegate_task", arguments: JSON.stringify({ title: "寫報告" }), call_id: "t1" }] }), turn({ text: "好" })], { blocked: false });
    await free.c.run(request("寫報告"), new AbortController().signal);
    expect(free.hostCalls).toEqual(["delegate_task"]);
  });

  it("the spoken confirmation phrases never reach Codex (the core's voice confirmation handles them)", async () => {
    const { c, requests } = memoryCaller([], { blocked: false });
    for (const text of ["確認記住", "確認忘記", "confirm change"]) {
      expect(await c.run(request(text), new AbortController().signal)).toMatchObject({ ok: true, text: "記憶的確認由 Nous 核心處理，結果會另外通知。", tools: [] });
    }
    expect(requests).toEqual([]);
  });
});
