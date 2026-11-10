// 即時語音查詢結果的挑選與跟讀（George 2026-11-09）：工具註冊、共用執行器、畫面狀態與收起計時、Surface、設定與翻譯。
// 搜尋結果是 fixture（不是真實的搜尋輸出）；真實語音與兩條路徑的實機行為不在這裡驗證。
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCallerInstructions, LiveToolCaller, liveCallerTools, MAX_HOST_TIMEOUT_MS } from "../server/live-tool-caller.ts";
import { buildRealtimeTools, realtimeToolRules, SEARCH_PICK_RULE } from "../server/realtime.ts";
import { HOST_TIMEOUT_MS, type ToolHost } from "../server/realtime-routes.ts";
import type { CodexTurn } from "../server/codex-responses.ts";
import { translate } from "../shared/i18n.mjs";
import { parsePrefsPatch, stepPref } from "../shared/prefs.ts";
import { DEFAULT_VOICE_PREFS, parseVoicePatch, VOICE_PREFS, VoicePatchError } from "../shared/voice-prefs.ts";
import { parseCandidates, SEARCH_ERRORS, searchToolOutput, type SearchCandidate } from "../shared/web-search.ts";
import { evaluateSurface } from "../src/presentation-policy.ts";
import { executeRealtimeTool, type ToolContext } from "../src/realtime-tools.ts";
import type { RealtimeCallbacks } from "../src/realtime.ts";
import { classifySearchError, dismissEmptySearch, planSearchSurface, READ_ALONG_CHARS_PER_S, READ_ALONG_TICK_MS, SEARCH_ERROR_TEXT, SEARCH_TEXT, SearchPanelController, shouldAutoClose, SPEECH_WAIT_MS, UtteranceRequests } from "../src/search-panel.ts";
import { initialShell, reduceShell } from "../src/shell-state.ts";
import { setLocale } from "../src/i18n.ts";

vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => html } }));

const CANDIDATES = parseCandidates(`台股今天收 23,456.78 點（fixture）。\n${JSON.stringify({
  candidates: [
    { title: "台股收盤", url: "https://news.example.com/a", points: ["加權指數收 23,456.78 點", "成交量 4,321 億元", "外資買超 120 億元"] },
    { title: "半導體領漲", url: "https://example.org/b", points: ["台積電上漲 1.2%", "聯發科持平"] },
    { title: "盤後分析", url: "https://c.example.net/x", points: [] },
  ],
})}`, []).candidates;

function panel(closeS = 8, charsPerSecond: number = READ_ALONG_CHARS_PER_S["zh-TW"]) {
  const closed: number[] = [];
  let changes = 0;
  const controller = new SearchPanelController({ closeAfterMs: () => closeS * 1000, changed: () => { changes++; }, autoClose: () => closed.push(Date.now()), charsPerSecond: () => charsPerSecond });
  return { controller, closed, changes: () => changes };
}

const shownOk = () => true;

afterEach(() => {
  vi.useRealTimers();
  setLocale("zh-TW");
});

describe("show_search_result is registered the same way on both routes", () => {
  it("API key tools and live caller tools both offer it right after web_search, only when web search is available", () => {
    for (const locale of ["zh-TW", "en"] as const) {
      const apiKey = buildRealtimeTools({ webSearch: true, mcp: [] }, locale).map((t) => t.name);
      const live = liveCallerTools({ webSearch: true, mcp: [] }, locale).map((t) => ("name" in t ? t.name : t.type));
      expect(apiKey.slice(0, 2)).toEqual(["web_search", "show_search_result"]);
      expect(live.slice(0, 2)).toEqual(["web_search", "show_search_result"]);
      expect(buildRealtimeTools({ webSearch: false, mcp: [] }, locale).map((t) => t.name)).not.toContain("show_search_result");
      expect(liveCallerTools({ webSearch: false, mcp: [] }, locale).map((t) => ("name" in t ? t.name : t.type))).not.toContain("show_search_result");
    }
    const spec = buildRealtimeTools({ webSearch: true, mcp: [] }).find((t) => t.name === "show_search_result") as { parameters: { properties: { index: object }; required: string[] } };
    expect(spec.parameters.properties.index).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    expect(spec.parameters.required).toEqual(["index"]);
  });

  it("has a short page timeout that does not raise the slowest tool wait", () => {
    expect(HOST_TIMEOUT_MS.show_search_result).toBeLessThanOrEqual(10_000);
    expect(MAX_HOST_TIMEOUT_MS).toBe(HOST_TIMEOUT_MS.home_control);
  });

  it("the pick rule is in both routes' instructions, and the live caller may list titles or read points", () => {
    expect(realtimeToolRules({ webSearch: true, mcp: [] })).toContain(SEARCH_PICK_RULE);
    expect(realtimeToolRules({ webSearch: false, mcp: [] })).not.toContain(SEARCH_PICK_RULE);
    const zh = buildCallerInstructions({ webSearch: true, mcp: [] }, [], new Date(0));
    expect(zh).toContain(SEARCH_PICK_RULE);
    expect(zh).toMatch(/查詢結果例外：.*最多六句/);
    expect(buildCallerInstructions({ webSearch: true, mcp: [] }, [], new Date(0), "en")).toMatch(/Exception for web search results/);
    expect(buildCallerInstructions({ webSearch: false, mcp: [] }, [], new Date(0))).not.toMatch(/查詢結果例外/);
  });
});

describe("executeRealtimeTool show_search_result", () => {
  function run(args: unknown, options: { stale?: boolean; controller?: SearchPanelController; noCallback?: boolean } = {}) {
    const delivered: Record<string, unknown>[] = [];
    const controller = options.controller ?? panel().controller;
    const callbacks = options.noCallback ? {} : { onShowSearchResult: (index: number) => controller.pick(index, shownOk) };
    const ctx = { callbacks: callbacks as RealtimeCallbacks, approvals: {} as ToolContext["approvals"], generation: 1, stale: () => !!options.stale, end: () => {}, deliver: (o: Record<string, unknown>) => delivered.push(o) };
    return executeRealtimeTool("show_search_result", JSON.stringify(args), ctx).then(() => ({ out: delivered[0], controller }));
  }

  it("in range: the page switches to reading that candidate and the model gets its points", async () => {
    const { controller } = panel();
    controller.results("台股", CANDIDATES);
    const { out } = await run({ index: 2 }, { controller });
    expect(out).toMatchObject({ ok: true, n: 2, title: "半導體領漲", host: "example.org", points: ["台積電上漲 1.2%", "聯發科持平"] });
    expect(controller.state).toMatchObject({ mode: "reading", query: "台股", candidate: { n: 2 }, active: null });
  });

  it("out of range or not a number: 沒有這一則, and the panel stays as it was", async () => {
    const { controller } = panel();
    controller.results("台股", CANDIDATES.slice(0, 2));
    for (const index of [3, 0, 4, 1.5, "x"]) expect((await run({ index }, { controller })).out).toEqual({ ok: false, error: SEARCH_ERRORS.outOfRange });
    expect(controller.state?.mode).toBe("candidates");
  });

  it("no search yet, a cleared call, or a page without the callback: 還沒有查詢結果", async () => {
    expect((await run({ index: 1 })).out).toEqual({ ok: false, error: SEARCH_ERRORS.none });
    const { controller } = panel();
    controller.results("台股", CANDIDATES);
    controller.clear();
    expect((await run({ index: 1 }, { controller })).out).toEqual({ ok: false, error: SEARCH_ERRORS.none });
    expect((await run({ index: 1 }, { noCallback: true })).out).toEqual({ ok: false, error: SEARCH_ERRORS.none });
  });

  it("a call from an ended session generation does not open the current results", async () => {
    const { controller } = panel();
    controller.results("台股", CANDIDATES);
    expect((await run({ index: 1 }, { controller, stale: true })).out).toEqual({ ok: false, error: SEARCH_ERRORS.none });
    expect(controller.state?.mode).toBe("candidates");
  });

  it("the ChatGPT plan route reaches the same executor through the live caller", async () => {
    const { controller } = panel();
    controller.results("台股", CANDIDATES);
    const hostCalls: string[] = [];
    const host: ToolHost = {
      outstanding: 0,
      call: async (name, args) => {
        hostCalls.push(name);
        let output: Record<string, unknown> = {};
        await executeRealtimeTool(name, JSON.stringify(args), { callbacks: { onShowSearchResult: (i: number) => controller.pick(i, shownOk) } as unknown as RealtimeCallbacks, approvals: {} as ToolContext["approvals"], generation: 1, stale: () => false, end: () => {}, deliver: (o) => { output = o; } });
        return output;
      },
    };
    const turns: CodexTurn[] = [
      { text: "", calls: [{ call_id: "c1", name: "show_search_result", arguments: "{\"index\":1}" }], citations: [], model: "fixture", replay: [] },
      { text: "加權指數收 23,456.78 點。成交量 4,321 億元。外資買超 120 億元。", calls: [], citations: [], model: "fixture", replay: [] },
    ];
    const caller = new LiveToolCaller({ responses: { turn: async () => turns.shift()! }, caps: () => ({ webSearch: true, mcp: [] }), host, tasks: () => [], approval: () => ({ open: false, resolvedAt: null }) });
    const result = await caller.run({ id: "d1", text: "使用者要看第一則", source: "voice", transcript: [] }, new AbortController().signal);
    expect(hostCalls).toEqual(["show_search_result"]);
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining("加權指數") });
    expect(controller.state).toMatchObject({ mode: "reading", candidate: { n: 1 } });
  });
});

describe("SearchPanelController", () => {
  it("two or more candidates list them with no close timer; one candidate goes straight to reading; none shows nothing", () => {
    vi.useFakeTimers();
    const p = panel();
    expect(p.controller.results("台股", CANDIDATES)).toMatchObject({ mode: "candidates", candidates: CANDIDATES });
    p.controller.setPhase("speaking");
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(120_000);
    expect(p.closed).toEqual([]);
    expect(p.controller.results("台股", [CANDIDATES[0]])).toMatchObject({ mode: "reading", candidate: CANDIDATES[0] });
    expect(p.controller.results("台股", [])).toBe(null);
    expect(p.controller.state).toBe(null);
  });

  it("speaking → listening after the pick closes after N seconds", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.results("台股", CANDIDATES);
    p.controller.setPhase("thinking");
    p.controller.pick(1, shownOk);
    p.controller.setPhase("speaking");
    vi.advanceTimersByTime(30_000);
    expect(p.closed).toHaveLength(0);
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(7_999);
    expect(p.closed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(p.closed).toHaveLength(1);
  });

  it("filler speech that started before the pick does not count as reading: no N-second close, only the 15 s fallback", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.results("台股", CANDIDATES);
    p.controller.setPhase("speaking"); // 「好，我看看」：選之前就開始的話
    p.controller.pick(1, shownOk);
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(8_000);
    expect(p.closed).toHaveLength(0);
    vi.advanceTimersByTime(SPEECH_WAIT_MS - 8_000 + 8_000);
    expect(p.closed).toHaveLength(1);
  });

  it("thinking (a pending delegation) arms neither the close timer nor the 15 s fallback", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.results("台股", CANDIDATES);
    p.controller.setPhase("speaking");
    p.controller.setPhase("thinking");
    p.controller.pick(2, shownOk);
    vi.advanceTimersByTime(10 * 60_000);
    expect(p.closed).toHaveLength(0);
    p.controller.failed("台股", "timeout");
    vi.advanceTimersByTime(10 * 60_000);
    expect(p.closed).toHaveLength(0);
  });

  it("speaking again, thinking or the user starting to talk cancels the countdown; it restarts after", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.results("台股", [CANDIDATES[0]]);
    p.controller.setPhase("speaking");
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(5_000);
    p.controller.setPhase("speaking");
    vi.advanceTimersByTime(10_000);
    p.controller.setPhase("thinking");
    vi.advanceTimersByTime(5_000);
    p.controller.setPhase("hearing");
    vi.advanceTimersByTime(10_000);
    expect(p.closed).toHaveLength(0);
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(8_000);
    expect(p.closed).toHaveLength(1);
  });

  it("dismissing the panel cancels the countdown, and the results stay pickable", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.results("台股", CANDIDATES);
    p.controller.pick(2, shownOk);
    p.controller.setPhase("speaking");
    p.controller.setPhase("listening");
    p.controller.hidden();
    vi.advanceTimersByTime(60_000);
    expect(p.closed).toHaveLength(0);
    expect(p.controller.pick(3, shownOk)).toMatchObject({ ok: true, n: 3 });
  });

  it("no speech after entering reading while idle (listening): waits SPEECH_WAIT_MS, then counts N anyway", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.setPhase("listening");
    p.controller.results("台股", [CANDIDATES[0]]);
    vi.advanceTimersByTime(SPEECH_WAIT_MS - 1);
    expect(p.closed).toHaveLength(0);
    vi.advanceTimersByTime(1 + 7_999);
    expect(p.closed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(p.closed).toHaveLength(1);
  });

  it("a failed search uses the same rule", () => {
    vi.useFakeTimers();
    const p = panel(3);
    expect(p.controller.failed("台股", "timeout")).toEqual({ mode: "failed", query: "台股", error: "timeout" });
    p.controller.setPhase("speaking");
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(3_000);
    expect(p.closed).toHaveLength(1);
    expect(p.controller.pick(1, shownOk)).toEqual({ ok: false, error: SEARCH_ERRORS.none });
  });

  it("every enter() bumps the revision, so re-picking the same result re-renders", () => {
    const p = panel();
    p.controller.results("台股", CANDIDATES);
    const a = p.controller.revision;
    p.controller.pick(1, shownOk);
    const b = p.controller.revision;
    p.controller.pick(1, shownOk);
    expect(b).toBeGreaterThan(a);
    expect(p.controller.revision).toBeGreaterThan(b);
  });

  it("the pick tells the model whether the screen really shows it", () => {
    const p = panel();
    p.controller.results("台股", CANDIDATES);
    expect(String(p.controller.pick(1, () => true).next)).toMatch(/^畫面已顯示/);
    expect(String(p.controller.pick(1, () => false).next)).toMatch(/^畫面沒有顯示/);
  });
});

describe("read-along paced by real playback (estimated)", () => {
  // 每秒 10 個字（測試用的速率），算起來比較直觀。
  const RATE = 10;
  const SPOKEN = "好，加權指數收兩萬三千點。成交量四千多億元。外資買超 120 億元。";
  const at = (text: string) => SPOKEN.indexOf(text);

  function reading() {
    vi.useFakeTimers();
    const p = panel(8, RATE);
    p.controller.results("台股", CANDIDATES);
    p.controller.setPhase("thinking");
    p.controller.pick(1, shownOk);
    return p;
  }

  it("a whole final transcript arriving at playback start does not jump ahead: the highlight advances with speaking time", () => {
    const p = reading();
    p.controller.setPhase("speaking");
    p.controller.assistantFinal(SPOKEN);
    expect(p.controller.state).toMatchObject({ active: null });
    // 「加權指數收」念完大約在第 (位置 + 5) 個字。
    vi.advanceTimersByTime(((at("加權指數收") + 5) / RATE) * 1000 + READ_ALONG_TICK_MS);
    expect(p.controller.state).toMatchObject({ active: 0 });
    vi.advanceTimersByTime(((at("成交量") - at("加權指數收")) / RATE) * 1000);
    expect(p.controller.state).toMatchObject({ active: 1 });
    vi.advanceTimersByTime(((at("外資買超") + 4 - at("成交量")) / RATE) * 1000);
    expect(p.controller.state).toMatchObject({ active: 2 });
  });

  it("only speaking time counts: pauses (listening) do not advance it, and speech already playing at the pick does not count", () => {
    vi.useFakeTimers();
    const p = panel(8, RATE);
    p.controller.results("台股", CANDIDATES);
    p.controller.setPhase("speaking"); // 選之前就在播放
    p.controller.pick(1, shownOk);
    p.controller.assistantPartial(SPOKEN);
    vi.advanceTimersByTime(60_000);
    expect(p.controller.state).toMatchObject({ active: null });
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(60_000);
    p.controller.setPhase("speaking"); // 選之後真的開始念
    vi.advanceTimersByTime(((at("加權指數收") + 5) / RATE) * 1000 + READ_ALONG_TICK_MS);
    expect(p.controller.state).toMatchObject({ active: 0 });
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(60_000);
    expect(p.controller.state).toMatchObject({ active: 0 });
    p.controller.setPhase("speaking");
    vi.advanceTimersByTime(((at("成交量") + 3 - at("加權指數收") - 5) / RATE) * 1000 + READ_ALONG_TICK_MS);
    expect(p.controller.state).toMatchObject({ active: 1 });
  });

  it("never moves backwards within one reading, and a conclusion with a later point's number does not start the highlight", () => {
    const p = reading();
    p.controller.setPhase("speaking");
    p.controller.assistantPartial("外資今天買超 120 億元。加權指數收兩萬三千點。成交量");
    vi.advanceTimersByTime(("外資今天買超 120 億元。".length / RATE) * 1000 + READ_ALONG_TICK_MS);
    expect(p.controller.state).toMatchObject({ active: null }); // 只憑數字不開始亮
    vi.advanceTimersByTime(10_000);
    expect(p.controller.state).toMatchObject({ active: 1 });
    p.controller.assistantFinal("回到加權指數收盤");
    vi.advanceTimersByTime(10_000);
    expect(p.controller.state).toMatchObject({ active: 1 });
    p.controller.setPhase("listening");
    p.controller.setPhase("speaking");
    vi.advanceTimersByTime(10_000);
    expect(p.controller.state).toMatchObject({ active: 1 });
  });

  it("does not tick while not speaking (no change callbacks while idle)", () => {
    const p = reading();
    p.controller.assistantFinal(SPOKEN);
    vi.advanceTimersByTime(60_000);
    expect(p.changes()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the locale's estimated rate (zh 5.5, en 15 characters per second)", () => {
    expect(READ_ALONG_CHARS_PER_S).toEqual({ "zh-TW": 5.5, en: 15 });
    vi.useFakeTimers();
    const en = panel(8, READ_ALONG_CHARS_PER_S.en);
    const points = ["The index closed at 23,456.78", "Turnover reached 432.1 billion"];
    const c: SearchCandidate = { n: 1, title: "t", url: "https://e.example/", host: "e.example", points, summarized: true, cited: true };
    en.controller.results("q", [c]);
    en.controller.setPhase("speaking");
    en.controller.assistantFinal("The index closed at twenty-three thousand. Turnover reached four hundred billion.");
    vi.advanceTimersByTime(2_000 + READ_ALONG_TICK_MS); // 30 個字元：還沒到 Turnover
    expect(en.controller.state).toMatchObject({ active: 0 });
    vi.advanceTimersByTime(2_000); // 63 個字元：念到 Turnover
    expect(en.controller.state).toMatchObject({ active: 1 });
  });

  it("cumulative partials from two sources: a lagging copy is ignored, an extension replaces, anything else appends", () => {
    const p = reading();
    p.controller.setPhase("speaking");
    p.controller.assistantPartial("加權指數收");
    p.controller.assistantPartial("加權指數收兩萬三千點，成交");
    p.controller.assistantPartial("加權指數收兩萬"); // 另一個來源慢一步的累積版本
    p.controller.assistantPartial("加權指數收兩萬三千點，成交"); // 一樣的
    vi.advanceTimersByTime(60_000);
    expect(p.controller.state).toMatchObject({ active: 0 });
    p.controller.assistantPartial("加權指數收兩萬三千點，成交量四千");
    vi.advanceTimersByTime(READ_ALONG_TICK_MS);
    expect(p.controller.state).toMatchObject({ active: 1 });
  });

  it("ABCDE then ABC stays ABCDE (observed through the cap: nothing is appended)", () => {
    vi.useFakeTimers();
    const p = panel(8, 1);
    const c: SearchCandidate = { n: 1, title: "t", url: "https://e.example/", host: "e.example", points: ["ABCDEABC", "第二點"], summarized: true, cited: true };
    p.controller.results("q", [c]);
    p.controller.setPhase("speaking");
    p.controller.assistantPartial("ABCDE");
    p.controller.assistantPartial("ABC");
    vi.advanceTimersByTime(60_000);
    // 若 "ABC" 被接在後面，累積會變成 ABCDEABC 而亮起第一點。
    expect(p.controller.state).toMatchObject({ active: null });
  });
});

describe("search Surface", () => {
  it("show.search opens a user_request surface the presentation policy accepts only for a real request id", () => {
    const shown = reduceShell(initialShell, { type: "show.search", request_id: "req_search0001" });
    expect(shown.surface).toMatchObject({ kind: "search", visibility_reason: "user_request", request_id: "req_search0001", surface_id: "surface_search_req_search0001" });
    expect(shown.mode).toBe("presenting");
    expect(evaluateSurface(shown.surface, { userRequestIds: new Set(["req_search0001"]), tasks: new Map() })).toEqual({ allowed: true });
    expect(evaluateSurface(shown.surface, { userRequestIds: new Set(), tasks: new Map() }).allowed).toBe(false);
    expect(reduceShell(shown, { type: "dismiss" }).surface).toBe(null);
  });

  function requests() {
    const userRequestIds = new Set<string>();
    let n = 0;
    const r = new UtteranceRequests(() => {
      const id = `req_utter${String(++n).padStart(4, "0")}`;
      userRequestIds.add(id);
      return id;
    });
    return { r, userRequestIds };
  }

  it("opening needs the user's latest unconsumed utterance; its id passes the presentation policy; each id opens once", () => {
    const { r, userRequestIds } = requests();
    expect(planSearchSurface(null, null, r)).toEqual({ action: "no_request" });
    r.noted();
    r.noted();
    const step = planSearchSurface(null, null, r);
    expect(step).toEqual({ action: "open", requestId: "req_utter0002" });
    const shell = reduceShell(initialShell, { type: "show.search", request_id: (step as { requestId: string }).requestId });
    expect(evaluateSurface(shell.surface, { userRequestIds, tasks: new Map() })).toEqual({ allowed: true });
    expect(planSearchSurface(null, null, r)).toEqual({ action: "no_request" });
  });

  it("an open confirm card is kept (the utterance stays for a later pick); the same search surface is reused", () => {
    const { r } = requests();
    r.noted();
    expect(planSearchSurface({ kind: "confirm", surface_id: "surface_confirm_x" }, null, r)).toEqual({ action: "blocked" });
    expect(planSearchSurface({ kind: "search", surface_id: "s1" }, "s1", r)).toEqual({ action: "reuse" });
    // reuse 也用掉了那一句話：之後模型自己的查詢不能拿它打開新畫面。
    expect(planSearchSurface({ kind: "search", surface_id: "old" }, "s1", r)).toEqual({ action: "no_request" });
  });

  it("a successful search with no candidates closes the previous search panel (no blank card) and the model answers by voice", () => {
    const p = panel();
    p.controller.results("台股", CANDIDATES);
    const empty = p.controller.results("別的問題", []);
    expect(empty).toBe(null);
    expect(p.controller.state).toBe(null);
    expect(dismissEmptySearch(empty, { kind: "search", surface_id: "s1" })).toBe(true);
    expect(dismissEmptySearch(empty, { kind: "confirm", surface_id: "c1" })).toBe(false);
    expect(dismissEmptySearch(empty, null)).toBe(false);
    expect(dismissEmptySearch(p.controller.results("台股", CANDIDATES), { kind: "search", surface_id: "s1" })).toBe(false);
    expect(searchToolOutput({ answer: "台股今天收 23,456.78 點。", candidates: [] }, false)).toEqual({ ok: true, answer: "台股今天收 23,456.78 點。", candidates: [], next: "用 answer 回答。" });
  });

  it("auto-close only dismisses the same search surface", () => {
    expect(shouldAutoClose({ kind: "search", surface_id: "s1" }, "s1")).toBe(true);
    expect(shouldAutoClose({ kind: "search", surface_id: "s2" }, "s1")).toBe(false);
    expect(shouldAutoClose({ kind: "confirm", surface_id: "s1" }, "s1")).toBe(false);
    expect(shouldAutoClose(null, "s1")).toBe(false);
  });

  it("search errors map to fixed bilingual sentences", () => {
    expect(classifySearchError(504, "上網查詢逾時（30 秒）。")).toBe("timeout");
    expect(classifySearchError(502, "上網查詢逾時（30 秒）。")).toBe("timeout");
    expect(classifySearchError(409, "上網查詢未啟用（需要 OPENAI_API_KEY）")).toBe("unavailable");
    expect(classifySearchError(502, "上網查詢失敗：OPENAI_API_KEY 無效或未授權（401）。")).toBe("auth");
    expect(classifySearchError(0, "無法連到本機核心（伺服器未啟動或已停止）")).toBe("network");
    expect(classifySearchError(502, "上網查詢失敗：無法連線到 OpenAI（網路中斷或被阻擋）。")).toBe("network");
    expect(classifySearchError(502, "上網查詢失敗（HTTP 500）：boom")).toBe("generic");
    expect(classifySearchError(null, "boom")).toBe("generic");
  });
});

describe("search_close_s setting", () => {
  it("defaults to 8 s within 3–60 s, step 1, and is validated like the other voice seconds", () => {
    expect(DEFAULT_VOICE_PREFS.search_close_s).toBe(8);
    expect(VOICE_PREFS.search_close_s).toMatchObject({ kind: "seconds", default: 8, min: 3, max: 60, step: 1, label: "查詢結果收起秒數" });
    expect(VOICE_PREFS.search_close_s.presets).toContain(8);
    expect(parseVoicePatch({ search_close_s: 3 })).toEqual({ search_close_s: 3 });
    expect(parseVoicePatch({ search_close_s: 60 })).toEqual({ search_close_s: 60 });
    for (const bad of [2, 61, 4.5, "8", null]) expect(() => parseVoicePatch({ search_close_s: bad })).toThrow(VoicePatchError);
    expect(stepPref(VOICE_PREFS.search_close_s, 3, -1)).toBe(3);
    expect(stepPref(VOICE_PREFS.search_close_s, 60, 1)).toBe(60);
    expect(parsePrefsPatch(VOICE_PREFS, {}, { noun: "語音設定", make: (m) => new Error(m) })).toEqual({});
  });
});

describe("search panel view and English", () => {
  class El {
    children: (El | string)[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, (() => void)[]>();
    constructor(readonly tagName: string) {}
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    getAttribute(key: string) { return this.attributes.get(key) ?? null; }
    append(...nodes: (El | string)[]) { this.children.push(...nodes); }
    addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    get textContent(): string { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); }
    all(): El[] { return this.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...c.all()])); }
  }
  let views: typeof import("../src/views.ts");
  beforeAll(async () => {
    vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
    views = await import("../src/views.ts");
  });
  afterAll(() => vi.unstubAllGlobals());
  const actions = { dismiss: () => {} } as unknown as import("../src/views.ts").ViewActions;
  const byClass = (root: El, cls: string) => root.all().filter((e) => (e.getAttribute("class") ?? "").split(" ").includes(cls));

  it("candidates: three selectable cards with number badges", () => {
    const el = views.renderSearch({ mode: "candidates", query: "台股", candidates: CANDIDATES }, actions) as unknown as El;
    expect(el.getAttribute("class")).toBe("surface surface--search surface--search-candidates");
    const cards = byClass(el, "search-candidate");
    expect(cards.map((c) => c.attributes.has("data-selectable"))).toEqual([true, true, true]);
    expect(byClass(el, "search-badge").map((b) => b.textContent)).toEqual(["1", "2", "3"]);
  });

  it("reading: the active point is marked and the others dimmed; unsummarized says so honestly", () => {
    const el = views.renderSearch({ mode: "reading", query: "台股", candidate: CANDIDATES[0], active: 1 }, actions) as unknown as El;
    expect(byClass(el, "search-point").map((p) => p.getAttribute("class"))).toEqual(["search-point is-dim", "search-point is-active", "search-point is-dim"]);
    expect(el.textContent).toContain("來源 news.example.com");
    const none = views.renderSearch({ mode: "reading", query: "台股", candidate: CANDIDATES[2] as SearchCandidate, active: null }, actions) as unknown as El;
    expect(none.textContent).toContain("這則沒有摘要，只有來源");
  });

  it("every new interface string has an English entry without Han characters", () => {
    const en = JSON.parse(readFileSync(new URL("../src/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    for (const source of [...Object.values(SEARCH_TEXT), ...Object.values(SEARCH_ERROR_TEXT)]) {
      expect(en[source], source).toBeTruthy();
      expect(translate(source, "en", 2), source).not.toMatch(/\p{Script=Han}/u);
    }
    for (const source of [VOICE_PREFS.search_close_s.label, VOICE_PREFS.search_close_s.hint]) {
      expect(translate(source, "en"), source).not.toMatch(/\p{Script=Han}/u);
    }
    setLocale("en");
    const el = views.renderSearch({ mode: "reading", query: "SIMULATED", candidate: { ...CANDIDATES[2], title: "Title", host: "example.com" }, active: null }, actions) as unknown as El;
    expect(el.textContent).not.toMatch(/\p{Script=Han}/u);
    expect(el.getAttribute("aria-label")).toBe(en[SEARCH_TEXT.region]);
    const failed = views.renderSearch({ mode: "failed", query: "SIMULATED", error: "timeout" }, actions) as unknown as El;
    expect(failed.textContent).not.toMatch(/\p{Script=Han}/u);
    expect(failed.textContent).toContain("Search failed");
    expect(failed.textContent).toContain(en[SEARCH_ERROR_TEXT.timeout]);
    const uncited = views.renderSearch({ mode: "reading", query: "SIMULATED", candidate: { ...CANDIDATES[0], title: "Title", points: ["Point"], cited: false }, active: null }, actions) as unknown as El;
    expect(uncited.textContent).toContain(en[SEARCH_TEXT.uncited]);
    expect(uncited.textContent).not.toMatch(/\p{Script=Han}/u);
  });

  it("failed panel: 查詢失敗 eyebrow and a fixed sentence per error kind (not the core's raw text)", () => {
    const el = views.renderSearch({ mode: "failed", query: "台股", error: "auth" }, actions) as unknown as El;
    expect(byClass(el, "search-eyebrow")[0].textContent).toBe("查詢失敗");
    expect(byClass(el, "search-error")[0].textContent).toBe(SEARCH_ERROR_TEXT.auth);
  });

  it("the highlight scrolls the lit point into view (nearest) and marks only that one", () => {
    const scrolled: unknown[] = [];
    const items = [0, 1, 2].map((i) => {
      const classes = new Set<string>();
      const attrs = new Map<string, string>();
      return {
        i,
        classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
        scrollIntoView: (o: unknown) => scrolled.push([i, o]),
        classes,
        attrs,
      };
    });
    const root = { querySelectorAll: () => items } as unknown as ParentNode;
    views.applySearchHighlight(root, 1);
    expect(scrolled).toEqual([[1, { block: "nearest" }]]);
    expect(items.map((e) => [...e.classes])).toEqual([["is-dim"], ["is-active"], ["is-dim"]]);
    expect(items[1].attrs.get("aria-current")).toBe("true");
  });
});
