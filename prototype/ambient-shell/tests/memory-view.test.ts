import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setLocale } from "../src/i18n.ts";
import type { MemoryCardView, MemoryRequest, MemoryResponse, MemoryStatusView } from "../shared/memory.ts";

// src/memory-view.ts 的畫面（DOM 替身，不是瀏覽器或 Electron 截圖；真正的畫面證據屬 Mac gate）。

class El {
  children: (El | string)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  dataset: Record<string, string> = {};
  disabled = false;
  checked = false;
  value = "";
  lang = "";
  constructor(readonly tagName: string) {}
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  append(...n: (El | string)[]) { this.children.push(...n); }
  replaceChildren(...n: (El | string)[]) { this.children = n; }
  addEventListener(type: string, cb: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]); }
  get textContent(): string { return this.children.map(c => typeof c === "string" ? c : c.textContent).join(""); }
  set textContent(v: string) { this.children = [v]; }
  all(): El[] { return this.children.flatMap(c => typeof c === "string" ? [] : [c, ...c.all()]); }
  click() { this.listeners.get("click")?.forEach(cb => cb()); }
}
let mod: typeof import("../src/memory-view.ts");
const originalDocument = globalThis.document;
beforeAll(async () => {
  vi.stubGlobal("document", { createElement: (tag: string) => new El(tag) });
  mod = await import("../src/memory-view.ts");
});
afterEach(() => setLocale("zh-TW"));
afterAll(() => { vi.unstubAllGlobals(); if (originalDocument) globalThis.document = originalDocument; });

const status: MemoryStatusView = {
  state: "ready", reason: null, enabled: false, setup_done: false,
  presence: { state: "unselected", epoch: 1, select_card: "mc_000000000000000000000001", profile: null, name: null, reason: null },
  profiles: [{ id: "profile_0123456789abcdef", name: "George", minor: false, linked: false, facts: 0 }],
  target: { provider: "claude", account: "fp0000claude0001", label: "Claude", allowed: false, household_allowed: false },
  targets: [{ provider: "claude", account: "fp0000claude0001", label: "Claude", allowed: false, household_allowed: false }, { provider: "chatgpt", account: "fp000chatgpt0001", label: "ChatGPT（fixture@example.invalid）", allowed: false, household_allowed: false }],
  active_facts: 0, limits: { facts: 1000, profiles: 20, value_chars: 512 },
};
const turnView = { receipts: [], card: null, chat: { text: "晚餐吃什麼", memory_turn: "mt_" + "0".repeat(32) }, presence: status.presence, history_reset: false, notice: null, suggestion: null };

function make(responses: (req: MemoryRequest) => MemoryResponse) {
  const calls: MemoryRequest[] = [];
  const resolved = vi.fn(), changed = vi.fn(), dismiss = vi.fn();
  const view = new mod.MemoryView({ bridge: { memory: async (req) => { calls.push(req); return responses(req); } }, dismiss, resolved, changed });
  return { view, calls, resolved, changed, dismiss, el: view.element as unknown as El };
}
const flush = () => new Promise(r => setTimeout(r, 0));
const buttons = (el: El) => el.all().filter(e => e.tagName === "button");
const byText = (el: El, text: string) => buttons(el).find(b => b.textContent === text)!;

describe("memory cards", () => {
  it("first-time setup shows four independent options, all off by default; suggestions are disabled", async () => {
    const t = make(req => req.op === "setup" ? { ok: true, op: "setup", ...turnView, status } : { ok: true, op: "status", ...status });
    t.view.showCard({ kind: "setup", card: "mc_0123456789abcdef01234567", text: "我是 George。記住，我不吃香菜" }, "req_fixture01", null, status);
    const boxes = t.el.all().filter(e => e.tagName === "input" && e.getAttribute("type") === "checkbox");
    expect(boxes.map(b => [b.checked, b.disabled])).toEqual([[false, false], [false, false], [false, false], [false, true]]);
    expect(t.el.textContent).toContain("啟用跨對話記憶（預設關閉）");
    expect(t.el.textContent).toContain("ChatGPT（fixture@example.invalid）");
    // 「我是 George」預填新的人物名稱；按儲存只送使用者勾的。
    boxes[0]!.checked = true; boxes[1]!.checked = true;
    byText(t.el, "儲存設定").click();
    await flush();
    expect(t.calls.at(-1)).toEqual({ op: "setup", enabled: true, subject: { kind: "name", name: "George" }, allow: [{ provider: "claude", account: "fp0000claude0001" }], card: "mc_0123456789abcdef01234567" });
    expect(t.resolved).toHaveBeenCalledWith(expect.objectContaining({ chat: turnView.chat }), "req_fixture01");
  });

  it("clarify buttons are save / household / cancel and answer the core-held card", async () => {
    const t = make(() => ({ ok: true, op: "card_answer", ...turnView, status }));
    const card: MemoryCardView = { kind: "clarify", card: "mc_0123456789abcdef01234567", value: "可能不喜歡香菜", reason: { message: "內容含「可能」「大概」這類不確定的說法：要記住這一句嗎？", values: [] }, options: ["save", "household", "cancel"] };
    t.view.showCard(card, "req_fixture02", turnView.chat);
    expect(buttons(t.el).map(b => b.textContent)).toEqual(["保存", "改記全家共用", "取消", "收起"]);
    expect(t.el.textContent).toContain("處理完這張卡片後會接著回答：晚餐吃什麼");
    byText(t.el, "改記全家共用").click();
    await flush();
    expect(t.calls).toEqual([{ op: "card_answer", card: card.card, choice: "household" }]);
    expect(t.resolved).toHaveBeenCalledOnce();
  });

  it("「你記得我什麼？」 lists source/time and edit/forget/pin act on that item", async () => {
    const fact = { id: "mem_0123456789abcdef", revision: 4, subject: "profile_0123456789abcdef", subject_name: "George", text: "不吃香菜", topic: "food", source: "explicit" as const, excerpt: "記住，我不吃香菜", at: "2026-10-29T02:00:00Z", expires: null, pinned: false, by_name: null, kind: "preference" as const, work: null };
    const t = make(req => req.op === "list" ? { ok: true, op: "list", facts: [], subject: null, manage: null, status, face_people: null, consents: [] } : { ok: true, op: "forget", receipt: { status: "forgotten", message: "已忘記 {0} 的一筆記憶", values: ["George"], operation_id: null }, history_reset: true, status });
    t.view.showCard({ kind: "inspect", subject_name: "George", facts: [fact] }, "req_fixture03", null);
    expect(t.el.textContent).toContain("不吃香菜");
    expect(t.el.textContent).toContain("來源：本人明示");
    byText(t.el, "忘記").click();
    await flush(); await flush();
    expect(t.calls[0]).toEqual({ op: "forget", id: fact.id, revision: 4 });
    expect(t.changed).toHaveBeenCalledWith(expect.objectContaining({ status: "forgotten" }), true, status.presence);
    expect(t.el.textContent).toContain("已忘記 George 的一筆記憶");
  });

  it("English: interface copy is translated; the user's words and names stay as typed", () => {
    setLocale("en");
    const t = make(() => ({ ok: false, code: "unavailable", message: "x" }));
    t.view.showCard({ kind: "face_candidate", card: "mc_0123456789abcdef01234567", name: "小明" }, "req_fixture04", null);
    expect(t.el.textContent).toContain("Use 小明's preferences this time?");
    expect(t.el.textContent.replace(/小明/g, "")).not.toMatch(/\p{Script=Han}/u);
    t.view.showCard({ kind: "clarify", card: "mc_0123456789abcdef01234567", value: "不吃香菜", reason: { message: "還沒有選定本次人物：要記成全家共用，還是先選擇本次人物？", values: [] }, options: ["household", "cancel"] }, "req_fixture05", null);
    expect(t.el.textContent.replace(/不吃香菜/g, "")).not.toMatch(/\p{Script=Han}/u);
    t.view.showCard({ kind: "setup", card: "mc_0123456789abcdef01234567", text: "記住，我不吃香菜" }, "req_fixture06", null, status);
    expect(t.el.textContent.replace(/記住，我不吃香菜|ChatGPT（fixture@example\.invalid）/g, "")).not.toMatch(/\p{Script=Han}/u);
    expect(mod.presenceLabel({ state: "selected", epoch: 2, select_card: "mc_000000000000000000000002", profile: "profile_0123456789abcdef", name: "George", reason: null })).toBe("Current person: George");
  });

  it("browser version says memory is unavailable instead of pretending", () => {
    const view = new mod.MemoryView({ bridge: null, dismiss: () => {}, resolved: () => {}, changed: () => {} });
    view.openManager();
    expect((view.element as unknown as El).textContent).toContain("記憶：瀏覽器版不可用（只在 macOS App 提供）。");
    expect(mod.presenceLabel({ state: "unselected", epoch: 1, select_card: "mc_000000000000000000000001", profile: null, name: null, reason: null })).toBe("本次人物：未選定（只用全家共用的記憶）");
    expect(mod.receiptsText([{ status: "saved", message: "記在 {0} 名下了：{1}", values: ["George", "不吃香菜"], operation_id: null }])).toBe("記在 George 名下了：不吃香菜");
  });
});

describe("setup card cancel (Minor 4)", () => {
  it("cancel goes back to the core so the held question is still sent", async () => {
    const t = make(() => ({ ok: true, op: "card_answer", ...turnView, status }));
    t.view.showCard({ kind: "setup", card: "mc_0123456789abcdef01234567", text: "記住我不吃香菜。晚餐吃什麼" }, "req_fixture07", { text: "晚餐吃什麼", memory_turn: null }, status);
    expect(t.el.textContent).toContain("第一次設定時，勾選的服務帳號也會一併允許取得全家共用的記憶");
    byText(t.el, "取消").click();
    await flush();
    expect(t.calls).toEqual([{ op: "card_answer", card: "mc_0123456789abcdef01234567", choice: "cancel" }]);
    expect(t.resolved).toHaveBeenCalledOnce();
  });
});

describe("MEM-2 live cards (DOM stand-in)", () => {
  const C = "mc_0123456789abcdef01234567";
  const voice: MemoryCardView = { kind: "voice_confirm", card: C, action: "remember", heard: "記住，我不喝咖啡", value: "不喝咖啡", subject_name: "George", target: null, options: ["confirm", "household", "cancel"], replaces: false };

  it("fetches a live card by id over IPC and shows what was heard, in Chinese and English; answers go to liveResolved without chat", async () => {
    const liveResolved = vi.fn();
    const calls: MemoryRequest[] = [];
    const view = new mod.MemoryView({
      bridge: { memory: async (req) => { calls.push(req); return req.op === "card_view" ? { ok: true, op: "card_view", card: voice, origin: "live" } : { ok: true, op: "card_answer", ...turnView, chat: null, status } as MemoryResponse; } },
      dismiss: vi.fn(), resolved: vi.fn(), changed: vi.fn(), liveResolved,
    });
    const el = view.element as unknown as El;
    expect(await view.showLiveCard(C)).toBe(true);
    expect(calls[0]).toEqual({ op: "card_view", card: C });
    expect(view.showing(C)).toBe(true);
    expect(el.textContent).toContain("聽到你說：「記住，我不喝咖啡」");
    expect(el.textContent).toContain("要記住的是：「不喝咖啡」（George）");
    expect(el.textContent).toContain("說「確認記住」");
    expect(buttons(el).map(b => b.textContent)).toEqual(["記住", "改記全家共用", "取消", "收起"]);
    setLocale("en");
    expect(el.textContent).toContain("Heard you say: “記住，我不喝咖啡”");
    expect(el.textContent).toContain("say “confirm remember”");
    expect(buttons(el).map(b => b.textContent)).toEqual(["Remember", "Save for household instead", "Cancel", "Dismiss"]);
    byText(el, "Remember").click();
    await flush();
    expect(calls[1]).toEqual({ op: "card_answer", card: C, choice: "confirm" });
    expect(liveResolved).toHaveBeenCalledTimes(1);
  });

  it("the delegate card uses the user's own sentence and only delegates on a click", async () => {
    const run = vi.fn();
    const t = make(() => ({ ok: true, op: "status", ...status }));
    t.view.showDelegate("幫我寫一份晚餐菜單報告", run);
    expect(t.el.textContent).toContain("要交辦這件事嗎？「幫我寫一份晚餐菜單報告」");
    expect(run).not.toHaveBeenCalled();
    setLocale("en");
    expect(t.el.textContent).toContain("Delegate this? “幫我寫一份晚餐菜單報告”");
    byText(t.el, "Delegate").click();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("MEM-5a suggestion line and household attribution (DOM stand-in)", () => {
  const C = "mc_00000000000000000000aaaa";
  const card: MemoryCardView = { kind: "suggestion", card: C, text: "我不吃香菜", value: "不吃香菜", subject_name: "George" };
  function prompt(answer: MemoryResponse) {
    const calls: MemoryRequest[] = [];
    const applied = vi.fn(), changed = vi.fn();
    const p = new mod.SuggestionPrompt({ bridge: { memory: async (r) => { calls.push(r); return r.op === "card_view" ? { ok: true, op: "card_view", card, origin: "typed" } : answer; } }, applied, changed });
    return { p, calls, applied, changed };
  }

  it("shows one line under the finished reply only (same request id), fetched by card id; 「記住」 answers confirm and shows the core receipt", async () => {
    const t = prompt({ ok: true, op: "card_answer", ...turnView, chat: null, receipts: [{ status: "saved", message: "記在 {0} 名下了：{1}", values: ["George", "不吃香菜"], operation_id: null }], status });
    t.p.set("req_fixture20", C);
    expect(t.p.render("req_fixture20", false)).toBeNull(); // 回覆還在串流：不擋聊天、也不先取內容
    expect(t.calls).toEqual([]);
    expect(t.p.render("req_fixture99", true)).toBeNull(); // 別一輪的回覆
    expect(t.p.render("req_fixture20", true)).toBeNull(); // 第一次：經 card_view 取內容
    await flush();
    expect(t.calls).toEqual([{ op: "card_view", card: C }]);
    expect(t.changed).toHaveBeenCalled();
    const el = t.p.render("req_fixture20", true) as unknown as El;
    expect(el.getAttribute("data-visibility-reason")).toBe("user_request");
    expect(el.getAttribute("data-request-id")).toBe("req_fixture20");
    expect(el.textContent).toBe("要記住『我不吃香菜』嗎？ 記住不用");
    expect(el.getAttribute("aria-label")).toBe("記憶建議");
    setLocale("en");
    const en = t.p.render("req_fixture20", true) as unknown as El;
    expect(en.textContent).toBe("Remember “我不吃香菜”? RememberNo thanks");
    expect(en.getAttribute("aria-label")).toBe("Memory suggestion");
    expect(en.getAttribute("title")).toBe("Saved only if you press “Remember”; nothing is remembered automatically.");
    byText(en, "Remember").click();
    await flush();
    expect(t.calls[1]).toEqual({ op: "card_answer", card: C, choice: "confirm" });
    expect(t.applied).toHaveBeenCalledOnce();
    expect((t.p.render("req_fixture20", true) as unknown as El).textContent).toBe("Saved for George: 不吃香菜");
    // 審查 n4：回條是固定句型，換語言時重新翻譯。
    setLocale("zh-TW");
    expect((t.p.render("req_fixture20", true) as unknown as El).textContent).toBe("記在 George 名下了：不吃香菜");
  });

  it("「不用」 answers decline and the line disappears; clear() drops it (epoch change)", async () => {
    const t = prompt({ ok: true, op: "card_answer", ...turnView, chat: null, receipts: [{ status: "cancelled", message: "好，不記這一句", values: [], operation_id: null }], status });
    t.p.set("req_fixture21", C);
    t.p.render("req_fixture21", true);
    await flush();
    byText(t.p.render("req_fixture21", true) as unknown as El, "不用").click();
    await flush();
    expect(t.calls[1]).toEqual({ op: "card_answer", card: C, choice: "decline" });
    expect(t.p.render("req_fixture21", true)).toBeNull();
    t.p.set("req_fixture22", C);
    t.p.clear();
    expect(t.p.render("req_fixture22", true)).toBeNull();
    expect(new mod.SuggestionPrompt({ bridge: null, applied: () => {}, changed: () => {} }).render("req_fixture22", true)).toBeNull();
  });

  it("household facts show 「全家共用・由 X 記下・日期」 with the not-identity-verification note, in both languages", () => {
    const fact = { id: "mem_0123456789abcde0", revision: 2, subject: null, subject_name: null, text: "晚餐不要太鹹", topic: "food", source: "explicit" as const, excerpt: "晚餐不要太鹹", at: "2026-10-30T02:00:00Z", expires: null, pinned: false, by_name: "George", kind: "note" as const, work: null };
    const own = { ...fact, id: "mem_0123456789abcde1", subject: "profile_0123456789abcdef", subject_name: "George", text: "不吃香菜", source: "suggestion" as const, by_name: null };
    const t = make(() => ({ ok: false, code: "unavailable", message: "x" }));
    t.view.showCard({ kind: "inspect", subject_name: "George", facts: [fact, own] }, "req_fixture23", null);
    expect(t.el.textContent).toMatch(/全家共用・由 George 記下・2026\/10\/30/);
    expect(t.el.textContent).toContain("來源：記憶建議（按了記住）");
    expect(t.el.textContent).toContain("「由誰記下」只是記下當時選定的本次人物，不是身分驗證。");
    setLocale("en");
    t.view.showCard({ kind: "inspect", subject_name: "George", facts: [fact, own] }, "req_fixture23", null);
    expect(t.el.textContent).toMatch(/Household · noted by George · 2026\/10\/30/);
    expect(t.el.textContent).toContain("Source: memory suggestion (you pressed Remember)");
    expect(t.el.textContent).toContain("it is not identity verification");
    expect(t.el.textContent.replace(/晚餐不要太鹹|不吃香菜/g, "")).not.toMatch(/\p{Script=Han}/u);
  });

  it("the manager's suggestions switch needs the flag and the token, and is translated", async () => {
    const managed = { ...status, enabled: true, suggestions: { available: true, enabled: false } };
    const t = make(req => req.op === "list" ? { ok: true, op: "list", facts: [], subject: null, manage: "mm_" + "a".repeat(32), status: managed, face_people: null, consents: [] }
      : { ok: true, op: "suggestions", receipt: { status: "updated", message: "已關閉記憶建議", values: [], operation_id: null }, history_reset: false, status: managed });
    t.view.openManager();
    await flush();
    expect(t.el.textContent).toContain("記憶建議：已關閉（預設）。");
    byText(t.el, "開啟記憶建議").click();
    await flush();
    expect(t.calls[1]).toEqual({ op: "suggestions", enabled: true, token: "mm_" + "a".repeat(32) });
    setLocale("en");
    t.view.openManager();
    await flush();
    expect(t.el.textContent).toContain("Memory suggestions: off (default).");
    expect(t.el.textContent).toContain("Suggestions never come from voice, task results or model replies");
    const unavailable = make(req => req.op === "list" ? { ok: true, op: "list", facts: [], subject: null, manage: "mm_" + "a".repeat(32), status: { ...managed, suggestions: { available: false, enabled: false } }, face_people: null, consents: [] } : { ok: false, code: "unavailable", message: "x" });
    unavailable.view.openManager();
    await flush();
    expect(unavailable.el.textContent).toContain("Memory suggestions: not available (NOUS_MEMORY_ROUTES does not list suggest).");
    expect(buttons(unavailable.el).map(b => b.textContent)).not.toContain("Turn on memory suggestions");
    // 審查 m2：旗標拿掉但建議還開著時，仍可以關掉（降回舊版前要先關）。
    const stillOn = make(req => req.op === "list" ? { ok: true, op: "list", facts: [], subject: null, manage: "mm_" + "a".repeat(32), status: { ...managed, suggestions: { available: false, enabled: true } }, face_people: null, consents: [] }
      : { ok: true, op: "suggestions", receipt: { status: "updated", message: "已關閉記憶建議", values: [], operation_id: null }, history_reset: false, status: managed });
    stillOn.view.openManager();
    await flush();
    byText(stillOn.el, "Turn off memory suggestions").click();
    await flush();
    expect(stillOn.calls[1]).toEqual({ op: "suggestions", enabled: false, token: "mm_" + "a".repeat(32) });
  });
});

describe("MEM-5b work decisions", () => {
  const card: MemoryCardView = { kind: "work_summary", card: "mc_0123456789abcdef0123456f", value: "這次選了方案 B", subject_name: "George", tasks: [{ task_id: "task_01234567-89ab-cdef-0123-456789abcdef", title: "比較兩個方案", finished_at: "2026-10-30T02:00:00Z" }], options: ["task", "note", "cancel"] };
  const work = { id: "mem_0123456789abcdef", revision: 3, subject: "profile_0123456789abcdef", subject_name: "George", text: "這次選了方案 B", topic: "other", source: "explicit" as const, excerpt: "記住這次選了方案 B", at: "2026-10-30T02:00:00Z", expires: null, pinned: false, by_name: null, kind: "work_summary" as const, work: { task_id: "task_01234567-89ab-cdef-0123-456789abcdef", title: "比較兩個方案", state: "in_scope" as const } };
  const note = { ...work, id: "mem_0123456789abcde2", text: "不吃香菜", kind: "preference" as const, work: null };

  it("the choice card lists the work, links by task id, and offers 「只記成一般筆記」 and 「取消」 in both languages", async () => {
    const t = make(() => ({ ok: true, op: "card_answer", ...turnView, status }));
    t.view.showCard(card, "req_fixture30", null);
    expect(t.el.getAttribute("data-visibility-reason")).toBe("user_request");
    expect(t.el.textContent).toContain("要連到哪一個工作？");
    expect(t.el.textContent).toContain("比較兩個方案");
    expect(buttons(t.el).map(b => b.textContent)).toEqual(["連到這個工作", "只記成一般筆記", "取消", "收起"]);
    expect(byText(t.el, "連到這個工作").getAttribute("aria-label")).toBe("連到：比較兩個方案");
    byText(t.el, "連到這個工作").click();
    await flush();
    expect(t.calls[0]).toEqual({ op: "card_answer", card: card.card, choice: "task", task: "task_01234567-89ab-cdef-0123-456789abcdef" });
    expect(t.resolved).toHaveBeenCalledWith(expect.anything(), "req_fixture30");
    setLocale("en");
    t.view.showCard(card, "req_fixture31", null);
    expect(buttons(t.el).map(b => b.textContent)).toEqual(["Link to this work", "Just save as a regular memory", "Cancel", "Dismiss"]);
    expect(t.el.textContent).toContain("Which work should this link to?");
    expect(byText(t.el, "Link to this work").getAttribute("aria-label")).toBe("Linked to: 比較兩個方案");
    expect(t.el.textContent.replace(/這次選了方案 B|比較兩個方案/g, "")).not.toMatch(/\p{Script=Han}/u);
  });

  it("the list labels work decisions with the linked work (title only in scope) and the manager can filter to 「工作決定」", async () => {
    const t = make(req => req.op === "list" ? { ok: true, op: "list", facts: [work, note, { ...work, id: "mem_0123456789abcde3", work: { task_id: work.work.task_id, title: null, state: "missing" as const } }], subject: "profile_0123456789abcdef", manage: "mm_" + "a".repeat(32), status: { ...status, enabled: true }, face_people: null, consents: [] } : { ok: false, code: "unavailable", message: "x" });
    t.view.openManager();
    await flush();
    expect(t.el.textContent).toContain("工作決定 · 連到：比較兩個方案");
    expect(t.el.textContent).toContain("工作決定 · 連到的工作已不存在");
    expect(t.el.textContent).toContain("不吃香菜");
    const filter = t.el.all().find(e => e.tagName === "select" && e.getAttribute("aria-label") === "篩選記憶")!;
    filter.value = "work";
    filter.listeners.get("change")!.forEach(cb => cb());
    expect(t.el.textContent).not.toContain("不吃香菜");
    expect(t.el.textContent).toContain("這次選了方案 B");
    setLocale("en");
    t.view.openManager();
    await flush();
    expect(t.el.textContent).toContain("Work decision · linked to: 比較兩個方案");
    expect(t.el.textContent).toContain("Work decision · the linked work no longer exists");
  });
});
