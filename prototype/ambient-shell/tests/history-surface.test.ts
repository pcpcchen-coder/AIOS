import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { classify, matchHistory } from "../src/intent.ts";
import { evaluateSurface } from "../src/presentation-policy.ts";
import { blocksAutoTalk, initialShell, reduceShell, type Surface } from "../src/shell-state.ts";
import { runDesktopCommand } from "../src/desktop-command.ts";
import { setLocale } from "../src/i18n.ts";
import type { HistoryDetail, HistoryPage, HistoryQuery } from "../shared/history.ts";
import type { Artifact, Task } from "../shared/types.ts";

// HIST-1：成果紀錄 Surface 的呈現政策、意圖、選單指令與畫面（資料一律是文字，不變成 HTML）。

const sanitize = vi.fn((html: string) => `SANITIZED(${html.length})`);
vi.mock("dompurify", () => ({ default: { addHook: () => {}, sanitize: (html: string) => sanitize(html) } }));

class El {
  children: (El | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event?: unknown) => void)[]>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  selected = false;
  value = "";
  innerHTMLSet: string | null = null;
  constructor(readonly tagName: string) {}
  set innerHTML(value: string) { this.innerHTMLSet = value; this.children = []; }
  get innerHTML(): string { return this.innerHTMLSet ?? ""; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  append(...nodes: (El | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (El | string)[]) { this.children = nodes; }
  addEventListener(type: string, callback: (event?: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  fire(type: string) { for (const cb of this.listeners.get(type) ?? []) cb({ preventDefault() {} }); }
  get textContent(): string { return this.children.map((n) => (typeof n === "string" ? n : n.textContent)).join(""); }
  set textContent(value: string) { this.children = [value]; }
  all(): El[] { return this.children.flatMap((n) => (typeof n === "string" ? [] : [n, ...n.all()])); }
}

let views: typeof import("../src/views.ts");
let historyView: typeof import("../src/history-view.ts");
const originalDocument = globalThis.document;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag), createElementNS: (_ns: string, tag: string) => new El(tag) });
  views = await import("../src/views.ts");
  historyView = await import("../src/history-view.ts");
});
afterEach(() => setLocale("zh-TW"));
afterAll(() => {
  vi.unstubAllGlobals();
  if (originalDocument) globalThis.document = originalDocument;
});

const XSS_TITLE = `<img src=x onerror="alert('title')">晚餐`;
const XSS_STEP = `<script>alert('step')</script>`;
const XSS_CONTENT = `# 菜單\n<img src=x onerror=alert('content')>\n香菜<script>alert(1)</script>`;

function task(overrides: Partial<Task> = {}): Task {
  return {
    schema_version: "proto-0.1", task_id: "task_xss", request_id: "req_xss000001", title: XSS_TITLE, status: "succeeded", mode: "claude", model: "fixture-model",
    plan_ready: true, steps: [{ title: XSS_STEP, status: "done", started_at: null, finished_at: null, output_chars: null }],
    created_at: "2026-10-30T01:00:00.000Z", updated_at: "2026-10-30T01:05:00.000Z", finished_at: "2026-10-30T01:05:00.000Z",
    error: null, artifact_id: "artifact_xss", retry_of: null, ...overrides,
  };
}
const artifact: Artifact = {
  schema_version: "proto-0.1", artifact_id: "artifact_xss", version: 1, task_id: "task_xss", title: XSS_TITLE, content: XSS_CONTENT,
  mode: "claude", model: "fixture-model", assumptions: ["<b>假設</b>"], capability_gaps: ["<i>缺口</i>"], status: "complete", created_at: "2026-10-30T01:05:00.000Z",
};
const page: HistoryPage = {
  total: 1, next_cursor: null, sources: [{ id: "tasks", protected: false }],
  items: [{
    task_id: "task_xss", artifact_id: "artifact_xss", title: XSS_TITLE, status: "succeeded", mode: "claude", model: "fixture-model",
    created_at: "2026-10-30T01:00:00.000Z", finished_at: "2026-10-30T01:05:00.000Z", source: "tasks", protected: false, score: 3,
    title_matches: [{ start: XSS_TITLE.length - 2, end: XSS_TITLE.length }],
    snippet: { field: "content", text: `<img src=x onerror=alert('content')> 香菜<script>`, matches: [{ start: 37, end: 39 }], truncated_start: true, truncated_end: false },
  }],
};

function deps(overrides: Partial<Omit<import("../src/history-view.ts").HistoryViewDeps, "api">> = {}) {
  const api = {
    searchHistory: vi.fn(async (_query: HistoryQuery): Promise<HistoryPage> => page),
    getHistory: vi.fn(async (_taskId: string): Promise<HistoryDetail> => ({ task: task(), artifact, source: "tasks", protected: false })),
    deleteHistory: vi.fn(async (_taskId: string, _requestId: string): Promise<unknown> => ({ ok: true })),
  };
  return { confirm: vi.fn((_message: string) => true), requestId: () => "req_click000001", redo: vi.fn(async () => null), dismiss: vi.fn(), ...overrides, api };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const forbidden = (root: El) => root.all().filter((el) => ["img", "script", "b", "i", "iframe"].includes(el.tagName));

describe("presentation policy for the history Surface", () => {
  const tasks = new Map<string, Task>();
  const surface = (overrides: Partial<Surface> = {}): Surface => ({
    surface_id: "surface_history_req_known00001", kind: "history", visibility_reason: "user_request", request_id: "req_known00001",
    task_id: null, artifact_id: null, message: null, ...overrides,
  });

  it("allows it only for a real user request id", () => {
    expect(evaluateSurface(surface(), { userRequestIds: new Set(["req_known00001"]), tasks })).toEqual({ allowed: true });
    expect(evaluateSurface(surface(), { userRequestIds: new Set(), tasks })).toMatchObject({ allowed: false });
    expect(evaluateSurface(surface({ request_id: "" }), { userRequestIds: new Set(["req_known00001"]), tasks })).toMatchObject({ allowed: false });
  });

  it("rejects any other visibility_reason, even with a known request id", () => {
    for (const reason of ["subscribed_event", "sensor_status", "user_pinned", "task_clarification", "action_confirmation"] as const) {
      const decision = evaluateSurface(surface({ visibility_reason: reason }), { userRequestIds: new Set(["req_known00001"]), tasks, pendingConfirmIds: new Set(["req_known00001"]) });
      expect(decision, reason).toMatchObject({ allowed: false });
    }
  });

  it("show.history opens it with user_request and the request id; dismiss only closes the view", () => {
    const shown = reduceShell(initialShell, { type: "show.history", request_id: "req_known00001" });
    expect(shown.surface).toMatchObject({ kind: "history", visibility_reason: "user_request", request_id: "req_known00001" });
    expect(blocksAutoTalk(shown.surface)).toBe(true);
    const working = reduceShell(reduceShell(initialShell, { type: "task.submitted", task_id: "task_a", request_id: "req_a0000001" }), { type: "show.history", request_id: "req_b0000001" });
    expect(reduceShell(working, { type: "dismiss" })).toEqual(initialShell);
  });
});

describe("history intent and entry points", () => {
  it.each([
    ["找之前關於晚餐的成果", "晚餐"],
    ["搜尋成果 香菜", "香菜"],
    ["搜尋成果：日本旅行規劃", "日本旅行規劃"],
    ["請幫我搜尋成果 香菜", "香菜"],
    ["找之前做過的晚餐結果", "晚餐"],
    ["查找以前的成果裡有沒有香菜", "香菜"],
    ["搜尋成果 整理書單", "整理書單"],
    ["成果紀錄", ""],
    ["搜尋全部成果", ""],
    ["找之前的成果", ""],
    ["search past results for dinner", "dinner"],
    ["Search my results for budget.", "budget"],
    ["find past results about cilantro", "cilantro"],
    ["results history", ""],
  ])("「%s」 opens results history with query 「%s」", (text, query) => {
    expect(classify(text)).toEqual({ kind: "history", query });
  });

  it("the existing 成果 commands still open only the latest artifact, and tasks stay tasks", () => {
    for (const text of ["成果", "看結果", "給我看成果", "剛才那份", "比賽結果", "show results"]) expect(classify(text).kind, text).toBe("result");
    for (const text of ["分析上季銷售結果", "show results about the election", "寫一份成果報告"]) expect(classify(text).kind, text).toBe("task");
    expect(matchHistory("幫我寫晚餐菜單")).toBeNull();
  });

  it("does not hijack ordinary sentences that mention 成果 or 結果 (review M1)", () => {
    // 像在交辦工作的查詢詞：交給 AI。
    for (const text of ["找成果，然後寫一份報告", "搜尋成果：幫我整理成一份新報告", "找之前的筆記整理成結果", "search results for flights to Tokyo", "search my results for dinner and then write a summary"]) {
      expect(matchHistory(text), text).toBeNull();
      expect(classify(text).kind, text).toBe("task");
    }
    // 沒說「做過」的「結果」是一般問題：不是成果紀錄（短句仍照既有規則打開最近一份，見指令表「容易誤會」）。
    for (const text of ["查詢之前的考試結果", "搜尋之前的比賽結果", "幫我找之前的投票結果"]) {
      expect(matchHistory(text), text).toBeNull();
      expect(classify(text).kind, text).not.toBe("history");
    }
  });

  it("the macOS menu command opens it, and the menu item exists in the tray template", () => {
    const calls: string[] = [];
    const noop = () => {};
    expect(runDesktopCommand("history", { voice: noop, progress: noop, settings: noop, type: noop, cameraPreview: noop, family: noop, familyCalibrate: noop, memory: noop, history: () => calls.push("history"), vault: noop })).toBe(true);
    expect(calls).toEqual(["history"]);
    const main = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
    expect(main).toContain('{ label: "成果紀錄…", click: openHistoryMenu }');
    expect(main).toMatch(/function openHistoryMenu\(\) \{\n\s+historyClick\.mark\(Date\.now\(\)\);\n\s+command\("history"\);/);
    expect(main).toMatch(/shell\.openExternal\(`\$\{core\.url\}\/history/);
    const en = JSON.parse(readFileSync(new URL("../desktop/messages.en.json", import.meta.url), "utf8")) as Record<string, string>;
    expect(en["成果紀錄…"]).toBe("Results history…");
  });

  it("the progress card offers 搜尋全部成果 only when there are tasks, and it calls openHistory", () => {
    const openHistory = vi.fn();
    const noop = () => {};
    const actions = { cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop, selectProvider: noop, chatgptLogin: noop, chatgptCancel: noop, chatgptLogout: noop, updateCamera: noop, openCameraPreview: noop, updateVoice: noop, updateRealtime: noop, codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory };
    const empty = views.renderProgress([], null, actions) as unknown as El;
    expect(empty.textContent).not.toContain("搜尋全部成果");
    const tasks = Array.from({ length: 10 }, (_, i) => task({ task_id: `task_${i}`, title: `任務 ${i}` }));
    const el = views.renderProgress(tasks, null, actions) as unknown as El;
    expect(el.textContent).toContain("另有 2 個較早的任務未列出");
    el.all().find((e) => e.tagName === "button" && e.textContent === "搜尋全部成果")!.fire("click");
    expect(openHistory).toHaveBeenCalledOnce();
    setLocale("en");
    const english = views.renderProgress(tasks, null, actions) as unknown as El;
    expect(english.all().some((e) => e.tagName === "button" && e.textContent === "Search all results")).toBe(true);
  });

  it("main.ts wires every entry point to a user request, and no model tool path opens it", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain('openHistory: () => openHistory(userRequest())');
    expect(main).toContain('history: () => openHistory(userRequest(), "", true)');
    expect(main).toMatch(/case "history":\n\s+input\.value = "";\n\s+historyView\.open\(intent\.query\);\n\s+dispatch\(\{ type: "show\.history", request_id: requestId \}\);/);
    const tools = readFileSync(new URL("../src/realtime-tools.ts", import.meta.url), "utf8");
    expect(tools).not.toMatch(/show\.history|historyView|openHistory/);
  });
});

describe("HistoryView rendering never turns data into HTML", () => {
  it("highlight builds <mark> elements and text, and ignores bad offsets", () => {
    const parts = historyView.highlight("<b>香菜</b>湯", [{ start: 3, end: 5 }, { start: 4, end: 9 }, { start: -1, end: 2 }, { start: 8, end: 99 }]);
    expect(parts.map((p) => (typeof p === "string" ? p : `[${(p as unknown as El).tagName}:${(p as unknown as El).textContent}]`))).toEqual(["<b>", "[mark:香菜]", "</b>湯"]);
  });

  it("search results: titles and snippets with markup are text nodes; matches become <mark>", async () => {
    const d = deps();
    const view = new historyView.HistoryView(d);
    view.open("香菜");
    await flush();
    expect(d.api.searchHistory).toHaveBeenCalledWith(expect.objectContaining({ q: "香菜", cursor: null }));
    const root = view.element as unknown as El;
    expect(forbidden(root)).toEqual([]);
    expect(root.all().every((el) => el.innerHTMLSet === null)).toBe(true);
    expect(root.textContent).toContain(XSS_TITLE);
    expect(root.textContent).toContain("…<img src=x onerror=alert('content')> 香菜<script>");
    expect(root.all().filter((el) => el.tagName === "mark").map((el) => el.textContent)).toEqual(["晚餐", "香菜"]);
    expect(root.textContent).toContain("找到 1 筆");
  });

  it("detail view reuses the artifact renderer (sanitized Markdown) and shows request, engine, time, notes and steps as text", async () => {
    const d = deps();
    const view = new historyView.HistoryView(d);
    view.open("香菜");
    await flush();
    (view.element as unknown as El).all().find((el) => el.getAttribute("class") === "history-open")!.fire("click");
    await flush();
    const root = view.element as unknown as El;
    expect(d.api.getHistory).toHaveBeenCalledWith("task_xss");
    expect(sanitize).toHaveBeenCalled();
    expect(sanitize.mock.calls.at(-1)![0]).toContain("香菜");
    const article = root.all().find((el) => el.tagName === "article")!;
    expect(article.innerHTMLSet).toMatch(/^SANITIZED\(/);
    expect(root.all().filter((el) => el !== article).every((el) => el.innerHTMLSet === null)).toBe(true);
    expect(forbidden(root)).toEqual([]);
    for (const text of ["原始要求", XSS_TITLE, "Claude · fixture-model", XSS_STEP, "<b>假設</b>", "<i>缺口</i>", "重做", "刪除"]) expect(root.textContent).toContain(text);
  });

  it("delete asks for native confirmation first; cancel keeps the task, confirm sends confirm with a request id", async () => {
    const confirm = vi.fn((_message: string) => false);
    const d = deps({ confirm });
    const view = new historyView.HistoryView(d);
    view.open("");
    await flush();
    await view.openDetail("task_xss");
    const del = () => (view.element as unknown as El).all().find((el) => el.tagName === "button" && el.textContent === "刪除")!;
    del().fire("click");
    await flush();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(XSS_TITLE));
    expect(d.api.deleteHistory).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    del().fire("click");
    await flush();
    expect(d.api.deleteHistory).toHaveBeenCalledWith("task_xss", "req_click000001");
    expect((view.element as unknown as El).textContent).toContain("已刪除這筆任務與它的成果。");
    expect((view.element as unknown as El).textContent).not.toContain(XSS_TITLE);
  });

  it("a running task has no redo or delete button; dismiss only calls the dismiss callback", async () => {
    const d = deps();
    d.api.getHistory.mockResolvedValue({ task: task({ status: "running", artifact_id: null, finished_at: null }), artifact: null, source: "tasks", protected: false });
    const view = new historyView.HistoryView(d);
    await view.openDetail("task_xss");
    const root = view.element as unknown as El;
    expect(root.all().some((el) => el.tagName === "button" && (el.textContent === "刪除" || el.textContent === "重做"))).toBe(false);
    expect(root.textContent).toContain("執行中的任務要先停止，才能重做或刪除。");
    root.all().find((el) => el.tagName === "button" && el.textContent === "收起")!.fire("click");
    expect(d.dismiss).toHaveBeenCalledOnce();
    expect(d.api.deleteHistory).not.toHaveBeenCalled();
  });

  it("renders all interface copy in English, including placeholders and aria-labels, without translating task data", async () => {
    setLocale("en");
    const view = new historyView.HistoryView(deps());
    view.open("");
    await flush();
    const root = view.element as unknown as El;
    const input = root.all().find((el) => el.tagName === "input" && el.getAttribute("type") === "search")!;
    expect(input.getAttribute("placeholder")).toBe("Enter keywords, for example: dinner, cilantro");
    expect(input.getAttribute("aria-label")).toBe("Keywords to search results");
    for (const text of ["Results history", "Search past tasks and results", "All statuses", "All engines", "Search", "1 in total (newest first)", "Completed", "Dismiss"]) expect(root.textContent).toContain(text);
    expect(root.textContent).toContain(XSS_TITLE);
    const visible = root.textContent.replace(XSS_TITLE, "").replace("<img src=x onerror=alert('content')> 香菜<script>", "");
    expect(/\p{Script=Han}/u.test(visible)).toBe(false);
  });

  it("with a filter and no results says no match, not that there are no tasks (review m4)", async () => {
    const d = deps();
    const empty: HistoryPage = { ...page, items: [], total: 0 };
    d.api.searchHistory.mockResolvedValue(empty);
    const view = new historyView.HistoryView(d);
    view.open("");
    await flush();
    expect((view.element as unknown as El).textContent).toContain("還沒有任何任務或成果。");
    const root = view.element as unknown as El;
    const status = root.all().find((el) => el.tagName === "select" && el.getAttribute("name") === "status")!;
    status.value = "failed";
    status.fire("change");
    await flush();
    expect(d.api.searchHistory).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
    expect((view.element as unknown as El).textContent).toContain("沒有符合的任務或成果。");
    // 日期：開始日期不能晚於結束日期。
    const from = root.all().find((el) => el.getAttribute("name") === "from")! as El & { min?: string; max?: string };
    const to = root.all().find((el) => el.getAttribute("name") === "to")! as El & { min?: string; max?: string };
    from.value = "2026-10-10";
    from.fire("change");
    expect(to.min).toBe("2026-10-10");
  });

  it("follows task.updated in the list and an open detail view (review m8)", async () => {
    const d = deps();
    const running = task({ status: "running", artifact_id: null, finished_at: null });
    d.api.getHistory.mockResolvedValueOnce({ task: running, artifact: null, source: "tasks", protected: false });
    const view = new historyView.HistoryView(d);
    await view.openDetail("task_xss");
    const root = () => view.element as unknown as El;
    expect(root().all().some((el) => el.tagName === "button" && el.textContent === "刪除")).toBe(false);
    view.taskUpdated(task({ status: "cancelled", artifact_id: null }));
    expect(root().all().some((el) => el.tagName === "button" && el.textContent === "刪除")).toBe(true);
    expect(root().textContent).toContain("已停止");
    // 成果出現（artifact_id 改變）時重讀詳細內容。
    view.taskUpdated(task());
    await flush();
    expect(d.api.getHistory).toHaveBeenCalledTimes(2);
  });

  it("re-translates its own aria-label and has a back button at the top of the detail view", async () => {
    const view = new historyView.HistoryView(deps());
    await view.openDetail("task_xss");
    const root = view.element as unknown as El;
    expect(root.getAttribute("aria-label")).toBe("成果紀錄");
    expect((root.children[0] as El).textContent).toBe("回到搜尋結果");
    setLocale("en");
    expect(root.getAttribute("aria-label")).toBe("Results history");
  });

  it("reports a failed search honestly instead of showing an empty result", async () => {
    const d = deps();
    d.api.searchHistory.mockRejectedValue(new Error("無法連到本機核心（伺服器未啟動或已停止）"));
    const view = new historyView.HistoryView(d);
    view.open("香菜");
    await flush();
    const text = (view.element as unknown as El).textContent;
    expect(text).toContain("無法搜尋成果紀錄：無法連到本機核心");
    expect(text).not.toContain("沒有符合的任務或成果。");
  });
});

describe("MEM-4a: protected shells and withdrawn results on screen", () => {
  const noop = () => {};
  const baseActions = { cancel: noop, retry: noop, openArtifact: noop, showProgress: noop, dismiss: noop, openSettings: noop, ackWelcome: noop, selectProvider: noop, chatgptLogin: noop, chatgptCancel: noop, chatgptLogout: noop, updateCamera: noop, openCameraPreview: noop, updateVoice: noop, updateRealtime: noop, codexLogin: noop, codexCancel: noop, codexLogout: noop, openHistory: noop };

  it("a withdrawn result shows the fixed text and a redo button; a revoked running task says why it stopped (both languages)", () => {
    const redo = vi.fn();
    const withdrawn = task({ task_id: "task_w", title: "規劃晚餐", withdrawn: true, artifact_id: null, steps: [] });
    const revoked = task({ task_id: "task_r", title: "規劃午餐", status: "cancelled", cancel_reason: "memory_revoked", artifact_id: null, steps: [] });
    const el = views.renderProgress([withdrawn, revoked], null, { ...baseActions, redo }) as unknown as El;
    expect(el.textContent).toContain("這份成果用到已忘記的記憶，內容已移除");
    expect(el.textContent).toContain("用到的記憶已被撤銷，任務已停止，沒有產生成果。");
    expect(el.all().some((e) => e.tagName === "button" && e.textContent === "查看成果")).toBe(false);
    el.all().find((e) => e.tagName === "button" && e.textContent === "重做")!.fire("click");
    expect(redo).toHaveBeenCalledWith("task_w");
    setLocale("en");
    const english = views.renderProgress([withdrawn, revoked], null, { ...baseActions, redo }) as unknown as El;
    expect(english.textContent).toContain("This result used memory that has since been forgotten, so its content was removed");
    expect(english.textContent).toContain("The memory this task used was revoked, so the task stopped without producing a result.");
  });

  it("over HTTP (shells mode) a protected item shows only the placeholder in the current language, with no snippet", async () => {
    const protectedPage: HistoryPage = { ...page, sources: [{ id: "tasks", protected: true }], items: [{ ...page.items[0]!, title: "受保護的任務，請在 App 內查看", protected: true }] };
    const d = deps({ shells: true });
    d.api.searchHistory.mockResolvedValue(protectedPage);
    d.api.getHistory.mockResolvedValue({ task: task({ title: "受保護的任務，請在 App 內查看", protected: true, steps: [] }), artifact: null, source: "tasks", protected: true });
    setLocale("en");
    const view = new historyView.HistoryView(d);
    view.open("");
    await flush();
    const root = view.element as unknown as El;
    expect(root.textContent).toContain("Protected task — view it in the Nous app");
    expect(root.textContent).not.toContain("香菜<script>");
    root.all().find((el) => el.getAttribute("class") === "history-open")!.fire("click");
    await flush();
    expect(root.textContent).toContain("Protected task — view it in the Nous app");
  });

  it("a withdrawn detail (App, via IPC) keeps the user's sentence, says the content was removed, and offers redo", async () => {
    const d = deps();
    d.api.getHistory.mockResolvedValue({ task: task({ title: "規劃晚餐", withdrawn: true, artifact_id: null, steps: [] }), artifact: null, source: "tasks", protected: true });
    const view = new historyView.HistoryView(d);
    view.open("");
    await flush();
    (view.element as unknown as El).all().find((el) => el.getAttribute("class") === "history-open")!.fire("click");
    await flush();
    const root = view.element as unknown as El;
    expect(root.textContent).toContain("規劃晚餐");
    expect(root.textContent).toContain("這份成果用到已忘記的記憶，內容已移除");
    root.all().find((e) => e.tagName === "button" && e.textContent === "重做")!.fire("click");
    await flush();
    expect(d.redo).toHaveBeenCalled();
  });
});

describe("MEM-4c review M1: the page clears its own caches when the core drops plaintext", () => {
  const CANARY = "canary犀牛蛋糕七七三一";
  const shellTask = (id: string): Task => ({ ...task({ task_id: id, artifact_id: `artifact_${id}`, title: "受保護的任務，請在 App 內查看" }), protected: true, steps: [{ title: "受保護的步驟", status: "done", started_at: null, finished_at: null, output_chars: null }] });

  it("ProtectedTasks: want() loads only the given cards; after the drop display() is the shell and late replies do not refill the cache", async () => {
    const { ProtectedTasks, applyPlaintextDrop } = await import("../src/protected-tasks.ts");
    let release: (() => void) | null = null;
    const bridge = vi.fn(async (request: { op: string; task_id?: string }) => {
      if (request.task_id === "task_late") await new Promise<void>((r) => { release = r; });
      return { ok: true as const, op: "get" as const, task: { ...shellTask(request.task_id!), protected: undefined, title: `真實${CANARY}`, steps: [{ title: `步驟${CANARY}`, status: "done" as const, started_at: null, finished_at: null, output_chars: null }] }, artifact: null };
    });
    const p = new ProtectedTasks(bridge as never, () => {});
    const shown = [shellTask("task_a"), shellTask("task_b")];
    p.want(shown);
    await flush();
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge.mock.calls.every((c) => c[0].op === "get")).toBe(true);
    expect(p.display(shown[0]!).title).toBe(`真實${CANARY}`);
    p.want([shellTask("task_late")]);
    const tasks = new Map(shown.map((t) => [t.task_id, t] as const));
    const artifacts = new Map<string, Artifact>([["artifact_task_a", { ...artifact, artifact_id: "artifact_task_a", task_id: "task_a", content: CANARY }]]);
    const artifactErrors = new Map<string, string>([["artifact_task_b", "x"]]);
    const hidden: string[] = [];
    const dismiss = vi.fn();
    const render = vi.fn();
    applyPlaintextDrop("os_lock", { protectedTasks: p, tasks, artifacts, artifactErrors, history: { hideContent: (r) => hidden.push(r) }, surface: { kind: "artifact", task_id: "task_a" }, dismiss, render });
    release!();
    await flush();
    expect(p.cachedCount).toBe(0);
    for (const t of [...shown, shellTask("task_late")]) expect(JSON.stringify(p.display(t))).not.toContain(CANARY);
    expect(artifacts.size).toBe(0);
    expect(artifactErrors.size).toBe(0);
    expect(hidden).toEqual(["os_lock"]);
    expect(dismiss).toHaveBeenCalledTimes(1); // 收起受保護成果的畫面（只關畫面）
    expect(render).toHaveBeenCalled();
    // 另一個畫面（例如進度）不收起。
    applyPlaintextDrop("idle", { protectedTasks: p, tasks, artifacts, artifactErrors, history: { hideContent: () => {} }, surface: { kind: "progress" }, dismiss, render });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("HistoryView.hideContent removes results, snippets, the open detail and the query, and shows a bilingual notice", async () => {
    const d = deps();
    d.api.searchHistory.mockResolvedValue({ ...page, items: [{ ...page.items[0]!, title: `標題${CANARY}`, snippet: { ...page.items[0]!.snippet!, text: `片段${CANARY}` } }] });
    d.api.getHistory.mockResolvedValue({ task: task({ title: `標題${CANARY}` }), artifact: { ...artifact, content: `內容${CANARY}` }, source: "tasks", protected: true });
    const view = new historyView.HistoryView(d);
    view.open(`查${CANARY}`);
    await flush();
    const root = view.element as unknown as El;
    expect(root.textContent).toContain(CANARY);
    root.all().find((el) => el.getAttribute("class") === "history-open")!.fire("click");
    await flush();
    view.hideContent("os_lock");
    expect(JSON.stringify(root.textContent)).not.toContain("犀牛");
    expect(root.all().some((el) => el.value.includes("犀牛"))).toBe(false);
    expect(root.textContent).toContain("內容已因鎖定隱藏，請重新搜尋");
    setLocale("en");
    view.hideContent("idle");
    expect(root.textContent).toContain("Content hidden after inactivity or a memory setting change; search again");
    view.hideContent("suspend");
    expect(root.textContent).toContain("Content hidden after lock; search again");
    // 再搜尋：提示消失，照常顯示。
    await view.search();
    expect(root.textContent).not.toContain("Content hidden");
  });

  it("main.ts wires the event, never calls loadAll, and only wants the displayed progress cards", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/window\.nousDesktop\?\.onTasksPlaintextDropped\?\.\(\(reason\) => applyPlaintextDrop\(reason,/);
    expect(main).not.toMatch(/protectedTasks\.loadAll\(\)/);
    expect(main).toMatch(/protectedTasks\.want\(sortForProgress\(\[\.\.\.tasks\.values\(\)\]\)\.slice\(0, MAX_LISTED\)\)/);
  });
});
