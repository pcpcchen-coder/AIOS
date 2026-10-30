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
const turnView = { receipts: [], card: null, chat: { text: "晚餐吃什麼", memory_turn: "mt_" + "0".repeat(32) }, presence: status.presence, history_reset: false, notice: null };

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
    const fact = { id: "mem_0123456789abcdef", revision: 4, subject: "profile_0123456789abcdef", subject_name: "George", text: "不吃香菜", topic: "food", source: "explicit" as const, excerpt: "記住，我不吃香菜", at: "2026-10-29T02:00:00Z", expires: null, pinned: false };
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
