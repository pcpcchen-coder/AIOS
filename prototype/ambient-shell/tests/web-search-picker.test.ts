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
import { parseCandidates, SEARCH_ERRORS, type SearchCandidate } from "../shared/web-search.ts";
import { evaluateSurface } from "../src/presentation-policy.ts";
import { executeRealtimeTool, type ToolContext } from "../src/realtime-tools.ts";
import type { RealtimeCallbacks } from "../src/realtime.ts";
import { SEARCH_TEXT, SearchPanelController, SPEECH_WAIT_MS } from "../src/search-panel.ts";
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

function panel(closeS = 8) {
  const closed: number[] = [];
  let changes = 0;
  const controller = new SearchPanelController({ closeAfterMs: () => closeS * 1000, changed: () => { changes++; }, autoClose: () => closed.push(Date.now()) });
  return { controller, closed, changes: () => changes };
}

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
    const callbacks = options.noCallback ? {} : { onShowSearchResult: (index: number) => controller.pick(index) };
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
        await executeRealtimeTool(name, JSON.stringify(args), { callbacks: { onShowSearchResult: (i: number) => controller.pick(i) } as unknown as RealtimeCallbacks, approvals: {} as ToolContext["approvals"], generation: 1, stale: () => false, end: () => {}, deliver: (o) => { output = o; } });
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
  });

  it("speaking → listening closes after N seconds", () => {
    vi.useFakeTimers();
    const p = panel(8);
    p.controller.results("台股", CANDIDATES);
    p.controller.setPhase("thinking");
    p.controller.pick(1);
    p.controller.setPhase("speaking");
    vi.advanceTimersByTime(30_000);
    expect(p.closed).toHaveLength(0);
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(7_999);
    expect(p.closed).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(p.closed).toHaveLength(1);
  });

  it("speaking again or the user starting to talk cancels the countdown; it restarts after", () => {
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
    p.controller.pick(2);
    p.controller.setPhase("speaking");
    p.controller.setPhase("listening");
    p.controller.hidden();
    vi.advanceTimersByTime(60_000);
    expect(p.closed).toHaveLength(0);
    expect(p.controller.pick(3)).toMatchObject({ ok: true, n: 3 });
  });

  it("no speech after entering reading: waits SPEECH_WAIT_MS, then counts N anyway", () => {
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
    expect(p.controller.failed("台股", "上網查詢逾時（30 秒）。")).toEqual({ mode: "failed", query: "台股", error: "上網查詢逾時（30 秒）。" });
    p.controller.setPhase("speaking");
    p.controller.setPhase("listening");
    vi.advanceTimersByTime(3_000);
    expect(p.closed).toHaveLength(1);
    expect(p.controller.pick(1)).toEqual({ ok: false, error: SEARCH_ERRORS.none });
  });

  it("read-along lights only while speaking, keeps the last point when not speaking, and never guesses", () => {
    const p = panel();
    p.controller.results("台股", CANDIDATES);
    p.controller.pick(1);
    p.controller.setPhase("speaking");
    p.controller.assistantPartial("好，");
    expect(p.controller.state).toMatchObject({ active: null });
    p.controller.assistantPartial("加權指數收兩萬");
    expect(p.controller.state).toMatchObject({ active: 0 });
    p.controller.assistantPartial("三千點。成交量");
    expect(p.controller.state).toMatchObject({ active: 1 });
    p.controller.setPhase("listening");
    p.controller.assistantFinal("好，加權指數收兩萬三千點。成交量四千多億元。外資買超 120 億元。");
    expect(p.controller.state).toMatchObject({ active: 1 });
    p.controller.setPhase("speaking");
    expect(p.controller.state).toMatchObject({ active: 2 });
    expect(p.changes()).toBe(3);
  });

  it("cumulative partials (ChatGPT plan route) are not double-counted", () => {
    const p = panel();
    p.controller.results("台股", CANDIDATES);
    p.controller.pick(1);
    p.controller.setPhase("speaking");
    p.controller.assistantPartial("加權指數收");
    p.controller.assistantPartial("加權指數收兩萬三千點，成交");
    expect(p.controller.state).toMatchObject({ active: 0 });
    p.controller.assistantPartial("加權指數收兩萬三千點，成交量四千");
    expect(p.controller.state).toMatchObject({ active: 1 });
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

  it("main.ts keeps an open confirm card and only auto-closes the same search surface", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/if \(s\?\.kind === "confirm"\) \{\n\s+searchPanel\.hidden\(\);\n\s+return false;/);
    expect(main).toContain('if (shell.surface?.kind === "search" && shell.surface.surface_id === searchSurfaceId) dispatch({ type: "dismiss" });');
    expect(main).toContain('dispatch({ type: "show.search", request_id: userRequest() });');
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
    for (const source of Object.values(SEARCH_TEXT)) {
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
  });
});
