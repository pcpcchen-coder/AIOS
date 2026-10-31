import { describe, expect, it } from "vitest";
import { HistoryQueryError, makeSnippet, markdownToPlain, parseHistoryQuery, searchHistory, type HistoryDocument, type HistorySource } from "../server/history.ts";
import { bigrams, foldForSearch, queryTerms, SEARCH_SYNONYMS, synonymIndexOf, synonymsFor, words } from "../server/search-terms.ts";
import { matchHistory } from "../src/intent.ts";
import { relevance } from "../server/memory/retrieve.ts";
import { parseMemoryText, toTraditional } from "../server/memory/parse.ts";
import { HISTORY_PAGE_SIZE, HISTORY_SNIPPET_RADIUS } from "../shared/history.ts";
import type { Artifact, ExecutorMode, Task, TaskStatus } from "../shared/types.ts";

// HIST-1：成果紀錄搜尋（server/history.ts）。全部在記憶體內，不碰檔案。

let seq = 0;
function doc(title: string, content: string | null, opts: { status?: TaskStatus; mode?: ExecutorMode; created?: string; steps?: string[]; assumptions?: string[]; gaps?: string[] } = {}): HistoryDocument {
  const id = `task_${String(++seq).padStart(4, "0")}`;
  const status = opts.status ?? (content === null ? "failed" : "succeeded");
  const created = opts.created ?? `2026-10-${String(1 + (seq % 28)).padStart(2, "0")}T10:00:00.000Z`;
  const task: Task = {
    schema_version: "proto-0.1", task_id: id, request_id: `req_${id}`, title, status, mode: opts.mode ?? "mock", model: null,
    plan_ready: true, steps: (opts.steps ?? []).map((s) => ({ title: s, status: "done", started_at: null, finished_at: null, output_chars: null })),
    created_at: created, updated_at: created, finished_at: created, error: null, artifact_id: content === null ? null : `artifact_${id}`, retry_of: null,
  };
  const artifact: Artifact | null = content === null ? null : {
    schema_version: "proto-0.1", artifact_id: `artifact_${id}`, version: 1, task_id: id, title, content, mode: task.mode, model: null,
    assumptions: opts.assumptions ?? [], capability_gaps: opts.gaps ?? [], status: "complete", created_at: created,
  };
  return { task, artifact };
}

function source(docs: HistoryDocument[], id = "tasks", prot = false): HistorySource {
  return { id, protected: prot, documents: () => docs };
}

const search = (docs: HistoryDocument[] | HistorySource[], params: Record<string, string> = {}) => {
  const sources = (docs.length > 0 && "documents" in docs[0]!) ? docs as HistorySource[] : [source(docs as HistoryDocument[])];
  return searchHistory(sources, parseHistoryQuery(new URLSearchParams(params)));
};

describe("shared matching helpers (extracted from memory retrieval)", () => {
  it("keeps memory retrieval behaviour: stop bigrams and English stop words still ignored there", () => {
    expect([...bigrams("今天幫我煮晚餐")]).toEqual(["天幫", "我煮", "煮晚", "晚餐"]);
    expect([...words("Please help me with the dinner plan")]).toEqual(["dinner", "plan"]);
    expect(relevance({ topic: "food", key: "", value: "晚餐不要香菜" }, "晚饭有香菜吗")).toBeGreaterThan(0);
  });

  it("folds Simplified to Traditional and case without changing length, so offsets map to the original", () => {
    const text = "晚饭计划 Dinner PLAN 🍜 报告";
    const folded = foldForSearch(text);
    expect(folded.length).toBe(text.length);
    // 「划／劃」一對多：兩邊都折成「划」（只影響比對）。
    expect(folded).toBe("晚飯計划 dinner plan 🍜 報告");
  });

  it("does not rewrite Traditional sentences that voice memory saves (review M2)", () => {
    // memory/live.ts 在保存語音記憶前用 toTraditional；搜尋用的補充表不能影響這裡。
    for (const text of ["記住我喜歡划船", "我覺得這個很划算", "我頭髮很長", "記住我喜歡吃麵", "記住發票要報帳"]) expect(toTraditional(text), text).toBe(text);
    expect(toTraditional("记住我喜欢划船")).toBe("記住我喜歡划船");
    expect(toTraditional("我头发很长")).toBe("我头发很長");
    expect(JSON.stringify(parseMemoryText(toTraditional("记住我喜欢划船")))).toContain("划船");
    // 搜尋仍然把 計劃／计划、頭髮／头发 折成同一個形式。
    expect(foldForSearch("計劃")).toBe(foldForSearch("计划"));
    expect(foldForSearch("頭髮")).toBe(foldForSearch("头发"));
    expect(foldForSearch("發票")).toBe(foldForSearch("发票"));
  });

  it("turns a query into CJK bigrams (single characters kept), English words and numbers", () => {
    expect(queryTerms("香菜")).toEqual(["香菜"]);
    expect(queryTerms("日本旅行")).toEqual(["日本", "本旅", "旅行"]);
    expect(queryTerms("湯")).toEqual(["湯"]);
    expect(queryTerms("Budget 2026 Q4")).toEqual(["budget", "2026", "q4"]);
    expect(queryTerms("晚饭")).toEqual(["晚飯"]);
    expect(queryTerms("报告")).toEqual(["報告"]);
    expect(queryTerms("  ")).toEqual([]);
  });
});

describe("searchHistory matching", () => {
  const docs = [
    doc("規劃這週晚餐菜單", "## 晚餐\n- 週一：番茄炒蛋\n- 週二：香菜牛肉湯"),
    doc("寫一份日本旅行計劃", "第一天到東京，第二天京都。"),
    doc("Draft a budget email", "Hi team, the **Q4 budget** is attached."),
    doc("整理書單", "推薦閱讀：小王子"),
    doc("失敗的任務：晚餐訂位", null, { status: "failed" }),
  ];

  it("matches Traditional text with a Simplified query and vice versa", () => {
    // 晚飯 不在內容裡；HIST-1 Mac 驗收 F2 之後它是「晚餐」的近義詞，所以找到的是寫「晚餐」的兩筆（不是簡繁對照找到的）。
    expect(search(docs, { q: "晚饭" }).items.map((i) => i.title).sort()).toEqual(["失敗的任務：晚餐訂位", "規劃這週晚餐菜單"]);
    expect(search(docs, { q: "宵夜" }).items).toEqual([]);
    expect(search(docs, { q: "日本旅行计划" }).items.map((i) => i.title)).toEqual(["寫一份日本旅行計劃"]);
    const simplified = [doc("准备晚饭", "买菜：葱、蒜")];
    expect(search(simplified, { q: "晚飯" }).items.map((i) => i.title)).toEqual(["准备晚饭"]);
    expect(search(simplified, { q: "蔥" }).items.map((i) => i.title)).toEqual(["准备晚饭"]);
  });

  it("matches bigrams inside longer text and English words case-insensitively", () => {
    expect(search(docs, { q: "香菜" }).items.map((i) => i.title)).toEqual(["規劃這週晚餐菜單"]);
    expect(search(docs, { q: "BUDGET" }).items.map((i) => i.title)).toEqual(["Draft a budget email"]);
    expect(search(docs, { q: "q4" }).items.map((i) => i.title)).toEqual(["Draft a budget email"]);
  });

  it("finds tasks without an artifact by title, and searches step titles and notes", () => {
    expect(search(docs, { q: "訂位" }).items.map((i) => i.status)).toEqual(["failed"]);
    const stepDoc = [doc("一般任務", "內容", { steps: ["查詢颱風動態"] }), doc("另一個", "內容", { assumptions: ["假設預算三萬"] })];
    expect(search(stepDoc, { q: "颱風" }).items[0]!.snippet).toMatchObject({ field: "step", text: "查詢颱風動態" });
    expect(search(stepDoc, { q: "預算" }).items[0]!.snippet).toMatchObject({ field: "notes" });
  });

  it("requires at least half of the query terms when there are several", () => {
    // 日本、本旅、旅行：只命中「日本」的不算。
    const partial = [doc("日本料理", "壽司"), doc("日本旅行", "行程")];
    expect(search(partial, { q: "日本旅行" }).items.map((i) => i.title)).toEqual(["日本旅行"]);
  });

  it("ranks by term coverage, then weighted score (title over content), then recency", () => {
    const ranked = [
      doc("香菜的做法", "其他", { created: "2026-10-01T00:00:00Z" }),
      doc("其他標題", "香菜很多 香菜", { created: "2026-10-20T00:00:00Z" }),
      doc("香菜湯", "香菜", { created: "2026-10-02T00:00:00Z" }),
    ];
    const titles = search(ranked, { q: "香菜" }).items.map((i) => i.title);
    // 標題與內容都有（3+2×2 片語加分）> 只在標題 > 只在內容
    expect(titles).toEqual(["香菜湯", "香菜的做法", "其他標題"]);
    const tie = [doc("香菜 A", null, { created: "2026-10-01T00:00:00Z", status: "failed" }), doc("香菜 B", null, { created: "2026-10-05T00:00:00Z", status: "failed" })];
    expect(search(tie, { q: "香菜" }).items.map((i) => i.title)).toEqual(["香菜 B", "香菜 A"]);
  });

  it("returns title highlights and a content snippet of about ±120 characters with match offsets", () => {
    const long = "前".repeat(300) + "香菜牛肉湯" + "後".repeat(300);
    const [item] = search([doc("香菜湯", long)], { q: "香菜" }).items;
    expect(item!.title_matches).toEqual([{ start: 0, end: 2 }]);
    const s = item!.snippet!;
    expect(s.field).toBe("content");
    expect(s.text.length).toBe(HISTORY_SNIPPET_RADIUS + 2 + HISTORY_SNIPPET_RADIUS);
    expect(s.truncated_start && s.truncated_end).toBe(true);
    expect(s.matches).toEqual([{ start: HISTORY_SNIPPET_RADIUS, end: HISTORY_SNIPPET_RADIUS + 2 }]);
    expect(s.text.slice(s.matches[0]!.start, s.matches[0]!.end)).toBe("香菜");
  });

  it("highlights the original (Simplified) characters at folded offsets and merges adjacent bigrams", () => {
    const [item] = search([doc("任务", "今晚的晚饭计划很简单")], { q: "晚飯計劃" }).items;
    const s = item!.snippet!;
    expect(s.matches).toEqual([{ start: 3, end: 7 }]);
    expect(s.text.slice(3, 7)).toBe("晚饭计划");
  });

  it("strips Markdown syntax from content before matching and snippets", () => {
    expect(markdownToPlain("# 標題\n- **粗體** [連結](https://x.invalid)\n```js\ncode\n```")).toBe("標題 粗體 連結 code");
    const [item] = search(docs, { q: "budget" }).items;
    expect(item!.snippet!.text).not.toContain("**");
  });

  it("keeps underscores inside identifiers and strips only paired emphasis (review m2)", () => {
    expect(markdownToPlain("設定 ANTHROPIC_API_KEY 與 snake_case_name，_斜體_ 和 __粗體__、*星號* **粗**")).toBe("設定 ANTHROPIC_API_KEY 與 snake_case_name，斜體 和 粗體、星號 粗");
    const [item] = search([doc("設定金鑰", "請在 .env 設定 ANTHROPIC_API_KEY")], { q: "ANTHROPIC_API_KEY" }).items;
    expect(item!.snippet!.text).toContain("ANTHROPIC_API_KEY");
  });

  it("stays fast on pathological Markdown (review m1)", () => {
    const nasty = ["[".repeat(50_000), "*".repeat(50_000), "_a".repeat(25_000), "![".repeat(25_000), "[x](".repeat(12_500), "**a".repeat(16_000)];
    for (const content of nasty) {
      const start = performance.now();
      markdownToPlain(content);
      const ms = performance.now() - start;
      // 修正前 50,000 個「[」要 1.76 秒；上限 200 ms 留給慢的 CI 機器。
      expect(ms, content.slice(0, 4)).toBeLessThan(200);
    }
  });

  it("does not split a surrogate pair at the snippet edge", () => {
    const text = "😀".repeat(100) + "目標" + "😀".repeat(100);
    const snippet = makeSnippet("content", text, [{ start: 200, end: 202 }]);
    expect(snippet.text.startsWith("\uDE00")).toBe(false);
    expect(/[\uD800-\uDBFF]$/.test(snippet.text)).toBe(false);
    expect(snippet.text.slice(snippet.matches[0]!.start, snippet.matches[0]!.end)).toBe("目標");
  });
});

describe("HIST-1 Mac finding F2: curated synonyms expand the query only", () => {
  const dinner = doc("准备晚饭", "买菜：葱、蒜，六点开饭");
  const exact = doc("規劃晚餐", "週末的晚餐菜單");
  const unrelated = [
    doc("晚上的會議筆記", "討論預算"), // 晚、會議：不是晚餐
    doc("相信自己", "寫給自己的一封信"), // 「信」不當其他詞的近義詞
    doc("Explain the explanation", "an explanatory planet note"), // plan 只比對整個英文詞
    doc("吃飯", "家常菜"),
  ];
  const all = [dinner, exact, ...unrelated];
  const titles = (q: string, docs: HistoryDocument[] = all) => search(docs, { q }).items.map((i) => i.title);

  it("「找之前關於晚餐的成果」 extracts 晚餐 and finds 「准备晚饭」 (Simplified 晚饭 = synonym 晚飯)", () => {
    const q = matchHistory("找之前關於晚餐的成果");
    expect(q).toBe("晚餐");
    expect(titles(q!)).toContain("准备晚饭");
    const hit = search(all, { q: q! }).items.find((i) => i.title === "准备晚饭")!;
    // 近義詞命中也標示：標題的「晚饭」、片段沒有命中時給內容開頭。
    expect(hit.title_matches).toEqual([{ start: 2, end: 4 }]);
  });

  it("English dinner finds 晚餐 and 晚飯; Chinese 晚餐 finds English dinner; snippets mark the synonym", () => {
    expect(titles("dinner").sort()).toEqual(["准备晚饭", "規劃晚餐"]);
    const en = doc("Plan the family dinner", "Shopping list for dinner: rice");
    const page = search([en], { q: "晚餐" });
    expect(page.items.map((i) => i.title)).toEqual(["Plan the family dinner"]);
    expect(page.items[0]!.title_matches).toEqual([{ start: 16, end: 22 }]);
    const snippet = page.items[0]!.snippet!;
    expect(snippet.matches.map((m) => snippet.text.slice(m.start, m.end))).toEqual(["dinner"]);
    const zhSnippet = search([doc("一般標題", "今天的晚飯吃麵")], { q: "晚餐" }).items[0]!.snippet!;
    expect(zhSnippet.matches.map((m) => zhSnippet.text.slice(m.start, m.end))).toEqual(["晚飯"]);
  });

  it("an exact match outranks a synonym match in the same field", () => {
    expect(titles("晚餐", [dinner, exact])).toEqual(["規劃晚餐", "准备晚饭"]);
    // 時間較新的近義詞命中仍排在原詞命中後面。
    const newer = doc("晚饭吃什么", "x", { created: "2026-10-30T10:00:00.000Z" });
    const older = doc("晚餐吃什麼", "x", { created: "2026-10-01T10:00:00.000Z" });
    expect(titles("晚餐", [newer, older])).toEqual(["晚餐吃什麼", "晚饭吃什么"]);
    const [a, b] = search([newer, older], { q: "晚餐" }).items;
    expect(a!.score).toBeGreaterThan(b!.score);
  });

  it("review minor 1: across fields, more exact terms outrank synonym hits even with a higher weighted score", () => {
    const exactInStep = doc("整理預算", "x", { steps: ["晚餐清單"], created: "2026-10-01T10:00:00.000Z" });
    const synonymInTitle = doc("晚飯預算", "x", { created: "2026-10-30T10:00:00.000Z" });
    expect(titles("晚餐 預算", [synonymInTitle, exactInStep])).toEqual(["整理預算", "晚飯預算"]);
    const contentExact = doc("一般", "今天的晚餐");
    const titleSynonym = doc("晚飯", "x");
    expect(titles("晚餐", [titleSynonym, contentExact])).toEqual(["一般", "晚飯"]);
  });

  it("review minor 3: known cross-word Chinese synonym hits are excluded (synonyms only)", () => {
    const docs = [doc("我們離開會場後去吃飯", "x"), doc("每日程式更新", "x"), doc("依法規劃分責任", "x")];
    expect(titles("會議", docs)).toEqual([]);
    expect(titles("行程", docs)).toEqual([]);
    expect(titles("計畫", docs)).toEqual([]);
    expect(titles("會議", [doc("明天開會", "x")])).toEqual(["明天開會"]);
    expect(synonymIndexOf("離開會場後開會", "開會")).toBe(5);
    // 原詞照舊是子字串比對（不受排除影響）。
    expect(titles("開會", docs)).toEqual(["我們離開會場後去吃飯"]);
  });

  it("does not expand unrelated words (晚, 飯, 會, 信 inside 相信, plan inside explanation)", () => {
    expect(titles("晚餐")).not.toContain("晚上的會議筆記");
    expect(titles("晚餐")).not.toContain("吃飯");
    expect(titles("郵件")).toEqual([]);
    // 原詞照舊是子字串比對（explanation 裡的 plan，原本就會找到）；近義詞「規劃」排在後面。
    expect(titles("plan")).toEqual(["Explain the explanation", "規劃晚餐"]);
    expect(titles("規劃")).toEqual(["規劃晚餐"]); // 近義詞 plan 不比對 explanation／planet
    expect(titles("香菜")).toEqual([]);
    expect(synonymsFor(["晚上", "飯", "會", "相信", "菜單", "budget"])).toEqual([[], [], [], [], [], []]);
  });

  it("the table is small, explicit, and Chinese entries are one or two characters; one-character words are never alternates", () => {
    expect(SEARCH_SYNONYMS.length).toBeLessThanOrEqual(12);
    for (const group of SEARCH_SYNONYMS) {
      for (const w of group) {
        if (/\p{Script=Han}/u.test(w)) expect([...w].length, w).toBeLessThanOrEqual(2);
        else expect(w, w).toMatch(/^[a-z][a-z-]*$/);
      }
    }
    expect(synonymsFor(["信"])[0]).toEqual(expect.arrayContaining(["郵件", "email"]));
    expect(synonymsFor(["郵件"])[0]).not.toContain("信");
    expect(synonymsFor(["dinner"])[0]).toEqual(["晚餐", "晚飯", "supper"]); // dinners 已含原詞，不列
    expect(synonymsFor(["行程"])[0]).not.toContain("plan"); // 行程和計畫分組
    expect(synonymIndexOf("an explanation", "plan")).toBe(-1);
    expect(synonymIndexOf("my plan.", "plan")).toBe(3);
    expect(synonymIndexOf("晚餐plan", "plan")).toBe(2);
  });

  it("only the query is expanded: stored text, folding and the query terms themselves are unchanged", () => {
    expect(queryTerms("晚餐")).toEqual(["晚餐"]);
    expect(foldForSearch("晚饭")).toBe("晚飯");
    const before = JSON.stringify(dinner);
    search([dinner], { q: "dinner" });
    expect(JSON.stringify(dinner)).toBe(before);
  });
});

describe("searchHistory filters, empty query and pagination", () => {
  const many = Array.from({ length: 45 }, (_, i) =>
    doc(`任務 ${i}`, i % 3 === 0 ? null : `成果 ${i} 晚餐`, {
      status: i % 3 === 0 ? "failed" : "succeeded",
      mode: i % 2 === 0 ? "claude" : "mock",
      created: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    }));

  it("empty query lists everything newest first, 20 per page, with an opaque next cursor", () => {
    const first = search(many);
    expect(first.total).toBe(45);
    expect(first.items).toHaveLength(HISTORY_PAGE_SIZE);
    expect(first.items[0]!.title).toBe("任務 44");
    expect(first.next_cursor).toBe("20");
    const second = search(many, { cursor: first.next_cursor! });
    const third = search(many, { cursor: second.next_cursor! });
    expect(third.items).toHaveLength(5);
    expect(third.next_cursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.task_id);
    expect(new Set(ids).size).toBe(45);
    expect(first.items.every((i) => i.title_matches.length === 0)).toBe(true);
  });

  it("filters by status, engine (mode) and date range; date-only `to` includes the whole day", () => {
    expect(search(many, { status: "failed" }).total).toBe(15);
    expect(search(many, { mode: "claude" }).total).toBe(23);
    expect(search(many, { status: "succeeded", mode: "mock", q: "晚餐" }).items.every((i) => i.status === "succeeded" && i.mode === "mock")).toBe(true);
    const dated = [doc("十月", "x", { created: "2026-10-15T12:00:00" }), doc("九月", "x", { created: "2026-09-15T12:00:00" })];
    expect(search(dated, { from: "2026-10-01" }).items.map((i) => i.title)).toEqual(["十月"]);
    expect(search(dated, { to: "2026-10-15" }).items.map((i) => i.title)).toEqual(["十月", "九月"]);
    expect(search(dated, { to: "2026-10-14" }).items.map((i) => i.title)).toEqual(["九月"]);
  });

  it("rejects malformed parameters instead of guessing", () => {
    const bad = (params: Record<string, string>) => () => parseHistoryQuery(new URLSearchParams(params));
    expect(bad({ status: "done" })).toThrow(HistoryQueryError);
    expect(bad({ mode: "gpt" })).toThrow(HistoryQueryError);
    expect(bad({ from: "yesterday" })).toThrow(HistoryQueryError);
    expect(bad({ from: "2026-13-45" })).toThrow("日期格式不正確");
    expect(bad({ to: "2026-02-31" })).toThrow("日期格式不正確");
    expect(bad({ from: "2026-10-01 garbage" })).toThrow("日期格式不正確");
    expect(parseHistoryQuery(new URLSearchParams({ from: "2028-02-29", to: "2028-10-30T12:00:00Z" })).range.from).not.toBeNull();
    expect(bad({ status: "done" })).toThrow("未知的任務狀態");
    expect(bad({ from: "2026-10-02", to: "2026-10-01" })).toThrow(HistoryQueryError);
    expect(bad({ cursor: "-1" })).toThrow(HistoryQueryError);
    expect(bad({ limit: "0" })).toThrow(HistoryQueryError);
    expect(bad({ limit: "51" })).toThrow(HistoryQueryError);
    expect(bad({ q: "字".repeat(201) })).toThrow(HistoryQueryError);
    expect(parseHistoryQuery(new URLSearchParams({ status: "failed,cancelled", limit: "5" }))).toMatchObject({ statuses: ["failed", "cancelled"], limit: 5, cursor: 0 });
  });

  it("merges pluggable sources and labels each item with its source and protected flag", () => {
    const plain = source([doc("一般 香菜", "x")]);
    const later = source([doc("受保護 香菜", "y")], "protected_fixture", true);
    const page = search([plain, later], { q: "香菜" });
    expect(page.sources).toEqual([{ id: "tasks", protected: false }, { id: "protected_fixture", protected: true }]);
    expect(page.items.map((i) => [i.source, i.protected])).toEqual(expect.arrayContaining([["tasks", false], ["protected_fixture", true]]));
  });
});

describe("search latency (in-memory, no index)", () => {
  it("searches 500 synthetic tasks with ~3 KB results within the stated bound", () => {
    // 500 個任務，每個成果約 3 KB（中英混合），合計約 1.5 MB 文字。
    const filler = "這是一段用來測試搜尋速度的成果內容，包含晚餐、旅行、預算與 budget report 等字詞。".repeat(60);
    const docs = Array.from({ length: 500 }, (_, i) => doc(`合成任務 ${i}`, `${filler} 編號${i}`, { steps: ["規劃步驟", "整理資料", "彙整成果"] }));
    const src = source(docs);
    const queries = ["晚餐", "budget", "日本旅行計劃", "編號499", "完全不存在的詞"];
    search([src], { q: "暖機" });
    const times: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const start = performance.now();
        search([src], { q });
        times.push(performance.now() - start);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const worst = times[times.length - 1]!;
    // 上限：互動式搜尋 300 ms（使用者按下搜尋到結果出現的感受門檻），CI 機器較慢時放寬到 1,000 ms 的最差值。
    // 實際數字寫進 docs/validation/history-hist1-2026-10-30.md。
    console.log(`[history perf] 500 tasks × ~${Math.round(filler.length / 1000)}k chars: median ${median.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    expect(median).toBeLessThan(300);
    expect(worst).toBeLessThan(1000);
    expect(search([src], { q: "編號499" }).items[0]!.title).toBe("合成任務 499");
  });
});
