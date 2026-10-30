import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSuggestion, suggestFrom, suggestionBodies, SuggestionBook, SUGGEST_PER_DAY, SUGGEST_PER_HOUR, SUGGEST_TTL_MS, type SuggestReject } from "../server/memory/suggest.ts";
import { MEMORY_FILE } from "../server/memory/store.ts";
import type { MemoryCardView, MemoryFactView, MemoryReceiptView } from "../shared/memory.ts";
import { realLockAvailable } from "./fixtures/memory-lock.ts";
import { CLAUDE, enable, fakeBox, harness, manage, req, selectProfile, type Harness } from "./fixtures/memory-service.ts";

// MEM-5a 記憶建議（docs/validation/memory-mem5a-2026-10-30.md）：規則的離線指標、每一種排除、頻率、旗標、只在記憶體、
// 過期與換世代、點「記住」才寫入。全部是虛構人物與合成句子；金鑰包裝是假的（不是 Keychain），不是 Mac gate。

interface Item { text: string; propose: boolean; value: string | null; attribution: "self" | "third" | "household" | "none"; timing: "stable" | "today" | "temporary" | "past"; negative: string | null }
const load = (name: string): Item[] => (JSON.parse(readFileSync(new URL(`./fixtures/memory-candidates.${name}.json`, import.meta.url), "utf8")) as { items: Item[] }).items;

/**
 * 指標的定義（數字由這裡算出，寫進驗證文件）：
 * - proposals：suggestFrom 有回候選的句子數。
 * - correct：應該提、值逐字相同、本人、穩定（候選一律記在本次人物名下、沒有期限）。
 * - precision＝correct／proposals；falseMemoryRate＝（不該提卻提了＋提了但值、人物或期限錯）／proposals；recall＝correct／應該提（只報告）。
 * - categoryFP：每個負例類別被提出的次數；personMisattribution：提了但標註不是本人（第三人、全家共用、無）。
 */
export function metrics(items: Item[]) {
  const rows = items.map(item => ({ item, got: suggestFrom(item.text) }));
  const proposed = rows.filter(r => r.got !== null);
  const correct = proposed.filter(r => r.item.propose && r.got!.value === r.item.value && r.item.attribution === "self" && r.item.timing === "stable");
  const negativesProposed = proposed.filter(r => !r.item.propose);
  const wrong = proposed.filter(r => r.item.propose && !correct.includes(r));
  const categoryFP: Record<string, number> = {};
  for (const r of items.filter(i => i.negative)) categoryFP[r.negative!] = 0;
  for (const r of negativesProposed) categoryFP[r.item.negative ?? "unlabelled"] = (categoryFP[r.item.negative ?? "unlabelled"] ?? 0) + 1;
  const positives = items.filter(i => i.propose).length;
  return {
    items: items.length, positives, negatives: items.length - positives, proposals: proposed.length, correct: correct.length,
    precision: proposed.length ? correct.length / proposed.length : 1,
    falseMemory: negativesProposed.length + wrong.length,
    falseMemoryRate: proposed.length ? (negativesProposed.length + wrong.length) / proposed.length : 0,
    recall: positives ? correct.length / positives : 1,
    categoryFP,
    personMisattribution: proposed.filter(r => r.item.attribution !== "self").length,
    /** 審查 m3：特殊類別（健康、宗教、政治、敏感）的負例被提出的次數。 */
    specialLeak: negativesProposed.filter(r => /sensitive|health|religion|politic|special/.test(r.item.negative ?? "")).length,
    misses: rows.filter(r => r.item.propose && !correct.includes(r)).map(r => r.item.text),
  };
}

describe("MEM-5a offline metrics (fixtures written alongside the rules; the holdout was written first)", () => {
  const zh = load("zh"), en = load("en"), holdout = load("holdout"), adversarial = load("adversarial");

  it("fixtures are large enough and fully labelled", () => {
    expect(zh.length).toBeGreaterThanOrEqual(100);
    expect(en.length).toBeGreaterThanOrEqual(50);
    expect(holdout.length).toBe(30);
    expect(adversarial.length).toBe(76);
    for (const item of [...zh, ...en, ...holdout, ...adversarial]) {
      expect(["self", "third", "household", "none"]).toContain(item.attribution);
      expect(["stable", "today", "temporary", "past"]).toContain(item.timing);
      expect(item.propose ? typeof item.value === "string" && item.negative === null : item.value === null && typeof item.negative === "string").toBe(true);
    }
  });

  it.each([["zh", zh], ["en", en], ["zh+en", [...zh, ...en]]] as const)("%s: precision ≥ 95%%, zero category false positives, zero person misattributions", (_name, items) => {
    const m = metrics([...items]);
    expect(m.precision).toBeGreaterThanOrEqual(0.95);
    expect(Object.values(m.categoryFP).every(n => n === 0)).toBe(true);
    expect(m.personMisattribution).toBe(0);
    expect(m.falseMemoryRate).toBeLessThanOrEqual(0.05);
  });

  it("審查 m3: the reviewer's adversarial set (tuned against after the review, so no longer independent): precision ≥ 90%, zero person misattributions, zero special-category values", () => {
    const m = metrics(adversarial);
    expect(m.precision).toBeGreaterThanOrEqual(0.9);
    expect(m.personMisattribution).toBe(0);
    expect(m.specialLeak).toBe(0);
  });

  it("reports the computed numbers (recall is reported, not gated)", () => {
    const out = { zh: metrics(zh), en: metrics(en), all: metrics([...zh, ...en]), holdout: metrics(holdout), adversarial: metrics(adversarial) };
    // 驗證文件的數字就是這一行印出的；改了規則或 fixture 要重跑並更新文件。
    console.log(`MEM-5a metrics ${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, m]) => [k, { items: m.items, positives: m.positives, proposals: m.proposals, correct: m.correct, precision: m.precision, falseMemory: m.falseMemory, falseMemoryRate: m.falseMemoryRate, recall: m.recall, personMisattribution: m.personMisattribution, specialLeak: m.specialLeak, categoryFP: m.categoryFP, misses: m.misses }])))}`);
    expect(out.zh).toMatchObject({ items: 123, positives: 45, proposals: 42, correct: 42, falseMemory: 0, personMisattribution: 0 });
    expect(out.en).toMatchObject({ items: 79, positives: 26, proposals: 20, correct: 20, falseMemory: 0, personMisattribution: 0 });
    // holdout 只報告（規則定稿前寫好、之後沒有改；檔案的 SHA-256 記在驗證文件）。
    expect(out.holdout).toMatchObject({ items: 30, positives: 9, proposals: 9, correct: 9, falseMemory: 0, personMisattribution: 0 });
    // 審查前（逐段流程）同一份 76 句：proposals 51、correct 10、precision 19.6%、false-memory 80.4%（審查報告的數字）。
    expect(out.adversarial).toMatchObject({ items: 76, positives: 11, proposals: 11, correct: 11, falseMemory: 0, personMisattribution: 0, specialLeak: 0 });
  });

  it("is deterministic: the same text always gives the same candidate and ticket body", () => {
    for (const item of [...zh, ...en]) {
      expect(suggestFrom(item.text)).toEqual(suggestFrom(item.text));
      expect(suggestionBodies(item.text)).toEqual(suggestionBodies(item.text));
    }
    expect(suggestionBodies("我不吃香菜，晚餐吃什麼？")).toEqual([{ op: "suggest", part: 0, value: "不吃香菜", topic: "food", key: "香菜", kind: "preference", expires: "none", scope: "subject" }]);
    expect(suggestionBodies("晚餐吃什麼？")).toEqual([]);
  });
});

describe("MEM-5a negative categories (one or more per rule)", () => {
  const cases: [string, SuggestReject][] = [
    ["他說我不吃香菜", "third_party"], ["我跟他說我不吃牛肉", "third_party"], ["My friend said I don't like spicy food", "third_party"], ["我媽不吃辣", "third_party"],
    ["「我不吃香菜」", "quote"], ["如果我不吃早餐會怎樣", "hypothetical"], ["I hate food, just kidding", "joke"],
    ["我喜歡用信用卡付款", "sensitive"], ["我好像不喜歡香菜", "uncertain"],
    ["我對花生過敏", "health"], ["我不吃藥", "health"], ["I'm pregnant so no coffee", "health"], ["我在減肥，不吃宵夜", "health"],
    ["我以前不吃香菜", "past"], ["我曾經很喜歡喝可樂", "past"], ["I used to drink coffee", "past"],
    ["我最近不喝咖啡", "temporal"], ["我這週不吃甜的", "temporal"], ["今天不要放香菜", "temporal"], ["I don't want coffee today", "temporal"], ["我不吃了", "temporal"],
    ["我不吃香菜對吧？", "question"], ["我喜歡香菜嗎", "question"], ["I don't eat pork, right?", "question"], ["I like tea?", "question"],
    ["我喜歡這道菜", "deictic"], ["I like this song", "deictic"], ["我要一杯咖啡", "request"], ["我想吃拉麵", "uncertain"], ["I'd like a coffee", "request"],
    ["我喜歡藍色", "off_topic"], ["I don't eat pork, beef or lamb", "list"], ["我們家不吃牛肉", "no_match"],
    // 審查 M1：跨句（整輪一起判斷）。
    ["我不吃香菜。開玩笑的。", "joke"], ["我不吃辣。才怪。", "joke"], ["我不吃香菜。我媽說的。", "third_party"], ["我不喝咖啡。這週而已。", "temporal"], ["I don't eat pork. Just kidding.", "joke"],
    ["My sister texted me. I hate onions.", "third_party"], ["Long day at work. I hate spicy food.", "context"], ["好累。我不吃香菜", "context"], ["記住我不喝咖啡。我不吃洋蔥", "command"], ["今天不要放香菜。我不吃洋蔥", "temporal"],
    // 審查 M2：代打、翻譯、角色扮演、年齡。
    ["我爸要我跟你說，我不吃豬肉", "framing"], ["幫我爸打的，我不吃豬肉", "framing"], ["爸爸在打字，我不吃豬肉", "framing"], ["代替我媽回答，我不吃牛肉", "framing"],
    ["幫我翻成英文，我不吃香菜", "framing"], ["假裝你是我，我不吃香菜", "framing"], ["我五歲，我不喜歡吃青菜", "framing"], ["Dad here, I don't eat pork", "framing"],
    ["This is Amy, I don't eat pork", "framing"], ["For my dad, I don't eat pork", "framing"], ["Translate this, I don't eat pork", "framing"], ["I'm in 2nd grade, I hate vegetables", "framing"],
    ["我不愛吃青菜啦，媽媽", "third_party"], ["Oh great, I love soggy fries", "joke"],
    // 審查 M3：受詞的條件與期間、特殊類別、反諷、全形小問號。
    ["我不吃辣的話就點別的", "clause"], ["I don't eat sugar until Christmas", "clause"], ["我不吃牛肉因為我拜觀音", "special"], ["I don't eat pork because I'm Muslim", "special"],
    ["我不喝酒，正在戒酒", "special"], ["I never watch Fox News", "special"], ["我不吃蝦，吃了會起疹子", "health"], ["I never drink alcohol on my meds", "health"],
    ["我最喜歡吃苦瓜XD", "joke"], ["I absolutely love cold coffee 🙄", "joke"], ["我不吃香菜（應該吧）", "uncertain"], ["我不吃香菜﹖", "question"],
    ["我不吃澱粉麵包蛋糕餅乾甜點跟含糖飲料", "too_long"], ["I don't eat red meat or white fish", "too_long"],
  ];
  it.each(cases)("%s → %s", (text, reason) => {
    expect(analyzeSuggestion(text)).toEqual({ reject: reason });
    expect(suggestFrom(text)).toBeNull();
  });

  it("審查 M3: curly apostrophes match but the saved value keeps what was typed", () => {
    expect(suggestFrom("I don’t eat pork")).toMatchObject({ clause: "I don’t eat pork", value: "I don’t eat pork" });
    expect(suggestionBodies("I don’t eat pork")[0]).toMatchObject({ value: "I don’t eat pork" });
  });
});

describe("SuggestionBook (RAM only)", () => {
  it("rate limits: 3 per hour per epoch, 10 per 24 h overall; rejected keys stay 24 h; clear drops candidates and keys but not counts", () => {
    const book = new SuggestionBook();
    const t0 = Date.parse("2026-10-30T00:00:00Z");
    const add = (i: number, at: number, epoch: number) => book.add({ card: `mc_${String(i).padStart(24, "0")}`, text: "x", candidate: { clause: "x", value: "x", topic: "food", key: `k${i}`, kind: "preference" }, profileId: "profile_a", epoch, requestId: "req_x", createdAt: at });
    for (let i = 0; i < SUGGEST_PER_HOUR; i++) add(i, t0 + i, 1);
    expect(book.rateBlock(t0 + 10, 1)).toBe("hour");
    expect(book.rateBlock(t0 + 10, 2)).toBeNull();
    expect(book.rateBlock(t0 + 60 * 60_000, 1)).toBeNull();
    for (let i = 3; i < SUGGEST_PER_DAY; i++) add(i, t0 + 2 * 60 * 60_000 + i, 10 + i);
    expect(book.rateBlock(t0 + 3 * 60 * 60_000, 99)).toBe("day");
    expect(book.rateBlock(t0 + SUGGEST_TTL_MS + 1, 99)).toBeNull();
    book.reject("profile_a", "香菜", t0);
    expect(book.rejectedKey("profile_a", "香菜", t0 + SUGGEST_TTL_MS - 1)).toBe(true);
    expect(book.rejectedKey("profile_b", "香菜", t0)).toBe(false);
    expect(book.rejectedKey("profile_a", "香菜", t0 + SUGGEST_TTL_MS)).toBe(false);
    book.reject("profile_a", "香菜", t0);
    book.clear();
    expect(book.sizes()).toMatchObject({ pending: 0, rejected: 0 });
  });

  it("keeps only the newest pending candidate and expires it after 24 h", () => {
    const book = new SuggestionBook();
    const t0 = 1_000_000;
    const entry = (card: string) => ({ card, text: "我不吃香菜", candidate: suggestFrom("我不吃香菜")!, profileId: "profile_a", epoch: 1, requestId: "req_x", createdAt: t0 });
    book.add(entry("mc_000000000000000000000001"));
    book.add(entry("mc_000000000000000000000002"));
    expect(book.get("mc_000000000000000000000001", t0)).toBeNull();
    expect(book.get("mc_000000000000000000000002", t0 + SUGGEST_TTL_MS - 1)).not.toBeNull();
    expect(book.get("mc_000000000000000000000002", t0 + SUGGEST_TTL_MS)).toBeNull();
  });
});

// ───────────── MemoryService ─────────────

let dir: string, key: Buffer;
const open: Harness[] = [];
let logs: string[] = [];
function make(extra: Partial<Parameters<typeof harness>[0]> = {}): Harness {
  const h = harness({ dir, key, suggest: true, log: line => logs.push(line), ...extra });
  open.push(h);
  return h;
}
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nous-memory-suggest-")); key = randomBytes(32); logs = []; });
afterEach(async () => { await Promise.all(open.splice(0).map(h => h.close())); rmSync(dir, { recursive: true, force: true }); });

const receipts = (r: Record<string, unknown>) => (r.receipts as MemoryReceiptView[] | undefined) ?? [];
const suggestion = (r: Record<string, unknown>) => r.suggestion as { card: string } | null;
async function turnOn(h: Harness, name: string | null = "George"): Promise<string> {
  await enable(h, name);
  const token = await manage(h);
  const res = await h.call({ op: "suggestions", enabled: true, token });
  expect(res).toMatchObject({ ok: true, op: "suggestions", receipt: { status: "updated" } });
  return token;
}
/** 磁碟上的加密快照解開後的明文（fakeBox 的金鑰）。 */
function diskPlain(): string {
  const e = JSON.parse(readFileSync(join(dir, MEMORY_FILE), "utf8")) as { wrappedKey: string; nonce: string; tag: string; ciphertext: string; version: number; revision: number; format: string };
  const dek = Buffer.from(fakeBox(key).open(Buffer.from(e.wrappedKey, "base64")), "base64");
  const d = createDecipheriv("aes-256-gcm", dek, Buffer.from(e.nonce, "base64"));
  d.setAAD(Buffer.from(JSON.stringify([e.format, e.version, e.revision, e.wrappedKey])));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]).toString("utf8");
}
const diskVersion = () => (JSON.parse(readFileSync(join(dir, MEMORY_FILE), "utf8")) as { version: number }).version;

describe.skipIf(!realLockAvailable)("MEM-5a suggestions in MemoryService", () => {
  it("proposes one candidate after a typed chat turn; the turn carries only the card id; 「記住」 writes source.kind suggestion (snapshot v4)", async () => {
    const h = make();
    await turnOn(h);
    const t = await h.turn("我不吃香菜，晚餐吃什麼？");
    expect(t.chat).toMatchObject({ text: "我不吃香菜，晚餐吃什麼？" });
    expect(Object.keys(suggestion(t)!)).toEqual(["card"]);
    const view = await h.call({ op: "card_view", card: suggestion(t)!.card });
    expect(view).toMatchObject({ ok: true, op: "card_view", origin: "typed", card: { kind: "suggestion", text: "我不吃香菜", value: "不吃香菜", subject_name: "George" } });
    // 不擋聊天：同一輪的 chat 照常有 memory_turn。
    expect((t.chat as { memory_turn: string | null }).memory_turn).toMatch(/^mt_/);
    const answer = await h.call({ op: "card_answer", card: suggestion(t)!.card, choice: "confirm" });
    expect(receipts(answer).map(r => [r.status, r.message, r.values])).toEqual([["saved", "記在 {0} 名下了：{1}", ["George", "不吃香菜"]]]);
    const list = await h.call({ op: "list" });
    expect((list.facts as MemoryFactView[])[0]).toMatchObject({ text: "不吃香菜", source: "suggestion", excerpt: "我不吃香菜，晚餐吃什麼？", by_name: null });
    expect(diskVersion()).toBe(4);
    // 一次性：同一張卡不能再按。
    expect(await h.call({ op: "card_answer", card: suggestion(t)!.card, choice: "confirm" })).toMatchObject({ ok: false, code: "expired" });
    // 已經記得：下一次同樣的話不再提。
    expect(suggestion(await h.turn("我不吃香菜"))).toBeNull();
  });

  it("審查 M1、m1: the whole turn is judged together, and an unanswered suggestion is dropped when the next turn starts", async () => {
    const h = make();
    await turnOn(h);
    expect(suggestion(await h.turn("我不吃香菜。開玩笑的。"))).toBeNull();
    expect(suggestion(await h.turn("我不喝咖啡。這週而已。"))).toBeNull();
    const t = await h.turn("我不吃香菜。晚餐吃什麼？");
    expect(suggestion(t)).not.toBeNull();
    // 卡片保存整輪原句：重新解析（來源票證）用整輪。
    expect((await h.call({ op: "card_view", card: suggestion(t)!.card })).card).toMatchObject({ text: "我不吃香菜", value: "不吃香菜" });
    expect(suggestion(await h.turn("晚餐吃什麼？"))).toBeNull();
    expect(await h.call({ op: "card_view", card: suggestion(t)!.card })).toMatchObject({ ok: false, code: "expired" });
    // 作廢不算拒絕：同一句之後仍可以再提。
    const again = await h.turn("我不吃香菜");
    expect(suggestion(again)).not.toBeNull();
    const saved = await h.call({ op: "card_answer", card: suggestion(again)!.card, choice: "confirm" });
    expect(receipts(saved).map(r => r.status)).toEqual(["saved"]);
    expect(((await h.call({ op: "list" })).facts as MemoryFactView[])[0]).toMatchObject({ excerpt: "我不吃香菜", source: "suggestion" });
  });

  it("「不用」 writes nothing and the same key is not proposed again for 24 h", async () => {
    const h = make();
    await turnOn(h);
    const before = diskPlain();
    const t = await h.turn("我不喝咖啡");
    const res = await h.call({ op: "card_answer", card: suggestion(t)!.card, choice: "decline" });
    expect(receipts(res).map(r => r.status)).toEqual(["cancelled"]);
    expect(diskPlain()).toBe(before);
    expect(suggestion(await h.turn("我不喝咖啡"))).toBeNull();
    expect(suggestion(await h.turn("我真的不喝咖啡"))).toBeNull(); // 同一個鍵（咖啡）
    expect(suggestion(await h.turn("我不吃香菜"))).not.toBeNull();
  });

  it("rate limits in the service: 1 per turn, 3 per hour per epoch, 10 per day", async () => {
    const h = make();
    await turnOn(h);
    const foods = ["香菜", "洋蔥", "苦瓜", "茄子", "青椒", "芹菜", "榴槤", "秋葵", "韭菜", "香腸", "皮蛋", "臭豆腐"];
    let i = 0;
    const offer = async () => suggestion(await h.turn(`我不吃${foods[i++]}`));
    // 一輪只提一筆（兩個子句都合格時只取第一個）。
    const two = await h.turn("我不吃香菜，我不喝咖啡");
    expect(suggestion(two)).not.toBeNull();
    expect((await h.call({ op: "card_view", card: suggestion(two)!.card })).card).toMatchObject({ value: "不吃香菜" });
    i = 1;
    expect(await offer()).not.toBeNull();
    expect(await offer()).not.toBeNull();
    expect(await offer()).toBeNull(); // 這個世代這一小時第 4 筆
    expect(logs.some(l => l.includes("頻率上限：每小時"))).toBe(true);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string; name: string }[] };
    const george = status.profiles.find(p => p.name === "George")!.id;
    // 換世代（先選全家共用再選回 George）：每小時的計數重新算，但每天的不變。
    let issued = 3;
    while (issued < 10) {
      await selectProfile(h, null);
      await selectProfile(h, george);
      for (let k = 0; k < 3 && issued < 10; k++) { expect(await offer()).not.toBeNull(); issued++; }
    }
    await selectProfile(h, null);
    await selectProfile(h, george);
    expect(await offer()).toBeNull(); // 24 小時第 11 筆
    expect(logs.some(l => l.includes("頻率上限：每天"))).toBe(true);
  });

  it("no candidate for a minor, with no person selected, while suspended, for live voice, or when the flag, the setting or memory is off", async () => {
    // 旗標關閉：不能開建議，也不提。
    const off = make({ suggest: false });
    await enable(off, "George");
    const token = await manage(off);
    expect(await off.call({ op: "suggestions", enabled: true, token })).toMatchObject({ ok: false, code: "unavailable" });
    expect(suggestion(await off.turn("我不吃香菜"))).toBeNull();
    expect(((await off.call({ op: "status" })) as unknown as { suggestions: unknown }).suggestions).toEqual({ available: false, enabled: false });
    await off.close();

    const h = make();
    await enable(h, "George");
    // 設定沒開（旗標開）：不提。
    expect(suggestion(await h.turn("我不吃香菜"))).toBeNull();
    const t2 = await manage(h);
    await h.call({ op: "suggestions", enabled: true, token: t2 });
    expect(suggestion(await h.turn("我不吃香菜"))).not.toBeNull();
    // 沒有選定人物：不提（候選不提全家共用）。
    await selectProfile(h, null);
    expect(suggestion(await h.turn("我不吃洋蔥"))).toBeNull();
    // 暫停（多臉）：不提。
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await selectProfile(h, status.profiles[0]!.id);
    await h.call({ op: "suspend", reason: "multi_face" });
    expect(suggestion(await h.turn("我不吃洋蔥"))).toBeNull();
    // 未成年：不提。
    await selectProfile(h, status.profiles[0]!.id);
    const t3 = await manage(h);
    await h.call({ op: "profile_minor", profile: status.profiles[0]!.id, minor: true, token: t3 });
    expect(suggestion(await h.turn("我不吃洋蔥"))).toBeNull();
    await h.call({ op: "profile_minor", profile: status.profiles[0]!.id, minor: false, token: t3 });
    // 即時語音：voiceTurn 走不同的路徑，永遠不提建議。
    expect(await h.service.voiceTurn("我不吃洋蔥")).toEqual({ kind: "none" });
    expect((h.service as unknown as { suggestions: SuggestionBook }).suggestions.sizes().pending).toBe(0);
    // 這一輪有明示的記憶指令：不提（即使另一段是合格的句子）。
    const mixed = await h.turn("記住我不喝咖啡。我不吃洋蔥");
    expect(receipts(mixed).map(r => r.status)).toEqual(["saved"]);
    expect(suggestion(mixed)).toBeNull();
    // 開著一張記憶卡：不提。
    const clarify = await h.turn("記住我可能不吃辣");
    expect(clarify.card).toMatchObject({ kind: "clarify" });
    expect(suggestion(await h.turn("我不吃洋蔥"))).toBeNull();
    await h.call({ op: "card_answer", card: (clarify.card as { card: string }).card, choice: "cancel" });
    // 關閉建議：不提，記憶體裡的候選丟掉。
    const pending = await h.turn("我不吃洋蔥");
    expect(suggestion(pending)).not.toBeNull();
    await h.call({ op: "suggestions", enabled: false, token: t3 });
    expect(await h.call({ op: "card_view", card: suggestion(pending)!.card })).toMatchObject({ ok: false, code: "expired" });
    expect(suggestion(await h.turn("我不吃苦瓜"))).toBeNull();
    // 記憶關閉：不提。
    await h.call({ op: "suggestions", enabled: true, token: t3 });
    await h.call({ op: "setup", token: t3, enabled: false, subject: { kind: "household" }, allow: [] });
    expect(suggestion(await h.turn("我不吃苦瓜"))).toBeNull();
  });

  it("duplicates or conflicts with an existing fact (own or household) are not proposed", async () => {
    const h = make();
    const token = await turnOn(h);
    await h.turn("記住我喜歡香菜");
    expect(suggestion(await h.turn("我不吃香菜"))).toBeNull(); // 同一個鍵（香菜）：衝突
    await h.call({ op: "edit", id: null, subject: null, value: "不喝咖啡", token });
    expect(suggestion(await h.turn("我不喝咖啡"))).toBeNull(); // 全家共用已有
    expect(logs.filter(l => l.includes("已有相同或相關的記憶")).length).toBe(2);
  });

  it("RAM only: the candidate never reaches the snapshot, logs, the turn's suggestion field, ContextFact or the model payload (canary)", async () => {
    const CANARY = "QZXCANARY5";
    const h = make();
    await turnOn(h);
    const id = req();
    const t = await h.turn(`我不吃${CANARY}菜`, id);
    expect(suggestion(t)).not.toBeNull();
    expect(JSON.stringify(t.suggestion)).not.toContain(CANARY);
    const chat = t.chat as { text: string; memory_turn: string };
    const facts = await h.service.withChat({ nonce: chat.memory_turn, requestId: id, lastUser: chat.text, target: CLAUDE }, async ctx => ctx.facts);
    expect(JSON.stringify(facts)).not.toContain(CANARY);
    expect(diskPlain()).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
    expect(logs.some(l => /記憶建議 1 筆（主題 food）/.test(l))).toBe(true);
    // card_view（可信主視窗的 IPC）才看得到內容；按「不用」之後仍然沒有落盤。
    expect(JSON.stringify(await h.call({ op: "card_view", card: suggestion(t)!.card }))).toContain(CANARY);
    await h.call({ op: "card_answer", card: suggestion(t)!.card, choice: "decline" });
    await h.close();
    expect(diskPlain()).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("expires after 24 h and on epoch change (换人、更正、忘記、OS 鎖定); a stale card cannot write", async () => {
    const h = make();
    await turnOn(h);
    const t = await h.turn("我不吃香菜");
    h.clock.now += SUGGEST_TTL_MS;
    expect(await h.call({ op: "card_view", card: suggestion(t)!.card })).toMatchObject({ ok: false, code: "expired" });
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await selectProfile(h, status.profiles[0]!.id);
    const t2 = await h.turn("我不吃洋蔥");
    expect(suggestion(t2)).not.toBeNull();
    h.service.suspendAll(); // OS 鎖定
    expect(await h.call({ op: "card_answer", card: suggestion(t2)!.card, choice: "confirm" })).toMatchObject({ ok: false, code: "expired" });
    expect(((await h.call({ op: "list", subject: status.profiles[0]!.id, token: await manage(h) })).facts as unknown[]).length).toBe(0);
    await selectProfile(h, status.profiles[0]!.id);
    const t3 = await h.turn("我不吃苦瓜");
    await h.turn("記住我不喝咖啡");
    await h.turn("忘記我不喝咖啡"); // 忘記會換世代
    expect(await h.call({ op: "card_view", card: suggestion(t3)!.card })).toMatchObject({ ok: false, code: "expired" });
  });
});

describe.skipIf(!realLockAvailable)("MEM-5a family attribution (source.by)", () => {
  it("household facts written while the flag is on record the writer; shown only when viewing; profile deletion clears it", async () => {
    const h = make();
    await enable(h, "George");
    const token = await manage(h);
    expect(diskVersion()).toBe(2);
    // 審查 M5：記憶管理的新增不記「由誰記下」（管理畫面不代表本次人物在說話）。
    await h.call({ op: "edit", id: null, subject: null, value: "晚餐不要太鹹", token });
    expect(((await h.call({ op: "list", subject: null, token })).facts as MemoryFactView[])[0]).toMatchObject({ text: "晚餐不要太鹹", by_name: null });
    expect(diskVersion()).toBe(2);
    // 聊天裡選「改記全家共用」：記下本次人物 George。
    const clarify = await h.turn("記住我可能不吃辣");
    expect(clarify.card).toMatchObject({ kind: "clarify", options: ["save", "household", "cancel"] });
    await h.call({ op: "card_answer", card: (clarify.card as { card: string }).card, choice: "household" });
    expect(diskVersion()).toBe(4);
    const list = await h.call({ op: "list", subject: null, token });
    expect((list.facts as MemoryFactView[]).find(f => f.text === "可能不吃辣")).toMatchObject({ subject: null, by_name: "George" });
    const inspect = await h.turn("你記得我什麼？");
    expect(((inspect.card as Extract<MemoryCardView, { kind: "inspect" }>).facts).find(f => f.text === "可能不吃辣")).toMatchObject({ by_name: "George" });
    // 個人事實不記 by。
    await h.turn("記住我不吃香菜");
    expect(((await h.call({ op: "list" })).facts as MemoryFactView[])[0]).toMatchObject({ by_name: null });
    // 刪除 George：「由 George 記下」一併清掉，快照仍然有效、照 2 寫回（沒有 version 4 的內容了）。
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    expect(await h.call({ op: "profile_delete", profile: status.profiles[0]!.id, token })).toMatchObject({ ok: true, receipt: { status: "forgotten" } });
    expect(((await h.call({ op: "list", subject: null, token })).facts as MemoryFactView[]).find(f => f.text === "可能不吃辣")).toMatchObject({ by_name: null });
    expect(diskVersion()).toBe(2);
  });

  it("審查 M5: a minor as the current person is never recorded as the writer", async () => {
    const h = make();
    await enable(h, "George");
    const token = await manage(h);
    const status = await h.call({ op: "status" }) as unknown as { profiles: { id: string }[] };
    await h.call({ op: "profile_minor", profile: status.profiles[0]!.id, minor: true, token });
    // 未成年時聊天不准寫入（MINOR）；記憶管理的新增一律 null。
    await h.call({ op: "edit", id: null, subject: null, value: "晚餐不要太鹹", token });
    expect(((await h.call({ op: "list", subject: null, token })).facts as MemoryFactView[])[0]).toMatchObject({ by_name: null });
    // 直接檢查 byFor：未成年時是 null，成年時是本人。
    const byFor = (h.service as unknown as { byFor(p: string | null): string | null }).byFor.bind(h.service);
    expect(byFor(null)).toBeNull();
    await h.call({ op: "profile_minor", profile: status.profiles[0]!.id, minor: false, token });
    await selectProfile(h, status.profiles[0]!.id);
    expect(byFor(null)).toBe(status.profiles[0]!.id);
    expect(diskVersion()).toBe(2);
  });

  it("with the flag off nothing records by and the snapshot stays version 2 (byte layout of MEM-4c)", async () => {
    const h = make({ suggest: false });
    await enable(h, "George");
    const token = await manage(h);
    await h.call({ op: "edit", id: null, subject: null, value: "晚餐不要太鹹", token });
    expect(((await h.call({ op: "list", subject: null, token })).facts as MemoryFactView[])[0]).toMatchObject({ by_name: null });
    expect(diskVersion()).toBe(2);
    expect(diskPlain()).not.toMatch(/"by"|"derivedFrom"/);
  });
});
