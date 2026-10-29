import { describe, expect, it } from "vitest";
import data from "./fixtures/memory-queries.zh.json" with { type: "json" };
import { parseMemoryText } from "../server/memory/parse.ts";
import { CONTEXT_MAX_BYTES, CONTEXT_MAX_FACTS, contextLine, retrieve, type ChatTarget } from "../server/memory/retrieve.ts";
import type { MemoryConsent, MemoryFact } from "../server/memory/store.ts";

// 16 §7 的檢索：先過人物、可見範圍、期限與同意，再算相關性。30 組中文查詢的逐題結果也由這裡算（見 docs/validation/memory-mem1-2026-10-29.md）。
const AT = "2026-10-29T00:00:00.000Z";
const NOW = Date.parse("2026-10-29T12:00:00Z");
const IDS: Record<string, string | null> = { george: "profile_000000000000000a", amy: "profile_000000000000000b", household: null };
const target: ChatTarget = { provider: "claude", account: "fp_claude_fixture", label: "Claude" };
const other: ChatTarget = { provider: "chatgpt", account: "fp_chatgpt_fixture", label: "ChatGPT" };

function factsFromSentences(): { facts: MemoryFact[]; owner: Map<string, string | null> } {
  const facts: MemoryFact[] = [];
  const owner = new Map<string, string | null>();
  let n = 0;
  const add = (who: string, sentence: string) => {
    for (const seg of parseMemoryText(sentence)) {
      if (seg.op !== "remember") continue;
      const id = `mem_${String(n++).padStart(16, "0")}`;
      facts.push({ id, profileId: IDS[who]!, revision: 1, kind: seg.kind, topic: seg.topic, key: seg.key, value: seg.value, audience: "household", source: { kind: "explicit", turnId: "req_fixture", at: AT, excerpt: sentence }, validFrom: AT, expiresAt: null, reviewAfter: null, pinned: false });
      owner.set(seg.value, IDS[who]!);
    }
  };
  for (const [who, sentences] of Object.entries(data.people)) for (const s of sentences) add(who, s);
  for (const s of data.household) add("household", s);
  for (const [who, sentences] of Object.entries(data.third_party)) for (const s of sentences) add(who, s);
  return { facts, owner };
}
const consentAll = (t: ChatTarget): MemoryConsent[] => [null, IDS.george!, IDS.amy!].map(profileId => ({ profileId, provider: t.provider, account: t.account!, allowed: true }));

describe("retrieval: permission filters come before relevance", () => {
  const { facts, owner } = factsFromSentences();

  it("third-party sentences never became facts", () => {
    expect(facts.some(f => /媽媽|海鮮/.test(f.value))).toBe(false);
    expect(facts).toHaveLength(data.people.george.length + data.people.amy.length + data.household.length);
  });

  it("30-query Chinese set: recall ≥ 90%, zero wrong-person and zero unconsented facts (per-query results in the validation doc)", () => {
    expect(data.queries).toHaveLength(30);
    const counts = data.queries.reduce<Record<string, number>>((acc, q) => ({ ...acc, [q.category]: (acc[q.category] ?? 0) + 1 }), {});
    expect(counts).toEqual({ positive: 8, synonym: 6, simplified: 3, negation: 4, unrelated: 5, cross_person: 2, third_party: 2 });
    let expected = 0, hit = 0, wrongPerson = 0, forbidden = 0, unrelatedReturned = 0;
    const rows: string[] = [];
    for (const q of data.queries) {
      const profileId = IDS[q.subject]!;
      const result = retrieve({ facts, consents: consentAll(target), profileId, target, query: q.query, now: NOW });
      const texts = result.facts.map(f => f.text);
      expected += q.expect.length;
      hit += q.expect.filter(e => texts.includes(e)).length;
      wrongPerson += texts.filter(t => owner.get(t) !== null && owner.get(t) !== profileId).length;
      forbidden += q.forbid.includes("*") ? 0 : texts.filter(t => q.forbid.some(f => t.includes(f))).length;
      if (q.forbid.includes("*")) unrelatedReturned += texts.length;
      rows.push(`${q.id}\t${q.category}\t${q.expect.filter(e => texts.includes(e)).length}/${q.expect.length}\t${texts.length}`);
      // 不送任何 ID：只有 text、source、at、expires。
      for (const f of result.facts) expect(Object.keys(f).sort()).toEqual(["at", "expires", "source", "text"]);
    }
    expect(hit / expected).toBeGreaterThanOrEqual(0.9);
    expect(wrongPerson).toBe(0);
    expect(forbidden).toBe(0);
    expect(unrelatedReturned).toBe(0);
    // 實際數字（驗證文件引用）：23 題有期望項（無相關 5 題、第三人 2 題沒有），共 24 項，全部取回。
    expect({ expected, hit }).toEqual({ expected: 24, hit: 24 });
    expect(rows).toHaveLength(30);
  });

  it("sends nothing to a service/account without consent, even when relevant (M02/M11)", () => {
    for (const q of data.queries) {
      const result = retrieve({ facts, consents: consentAll(target), profileId: IDS[q.subject]!, target: other, query: q.query, now: NOW });
      expect(result.facts).toEqual([]);
    }
    const blocked = retrieve({ facts, consents: consentAll(target), profileId: IDS.george!, target: other, query: "晚餐吃什麼", now: NOW });
    expect(blocked.blockedByConsent).toBeGreaterThan(0);
    expect(retrieve({ facts, consents: consentAll(target), profileId: IDS.george!, target: { ...target, account: null }, query: "晚餐吃什麼", now: NOW }).facts).toEqual([]);
  });

  it("consent is per subject: household consent does not unlock a person (and vice versa)", () => {
    const onlyHousehold: MemoryConsent[] = [{ profileId: null, provider: "claude", account: target.account!, allowed: true }];
    const texts = retrieve({ facts, consents: onlyHousehold, profileId: IDS.george!, target, query: "晚餐吃什麼", now: NOW }).facts.map(f => f.text);
    expect(texts).toEqual(["家裡晚餐不吃牛肉"]);
  });

  it("unselected uses household facts only, never another person's to fill an empty result (M04)", () => {
    const texts = retrieve({ facts, consents: consentAll(target), profileId: null, target, query: "這道菜要不要加香菜", now: NOW }).facts.map(f => f.text);
    expect(texts).not.toContain("不吃香菜");
    expect(texts).not.toContain("喜歡香菜");
  });
});

describe("retrieval: validity, pinning and the 8 facts / 4 KB budget", () => {
  const base = (i: number, extra: Partial<MemoryFact> = {}): MemoryFact => ({ id: `mem_${String(i).padStart(16, "0")}`, profileId: null, revision: 1, kind: "preference", topic: "food", key: `k${i}`, value: `不吃第${i}種菜`, audience: "household", source: { kind: "explicit", turnId: "req_fixture", at: AT, excerpt: "x" }, validFrom: AT, expiresAt: null, reviewAfter: null, pinned: false, ...extra });
  const consents: MemoryConsent[] = [{ profileId: null, provider: "claude", account: target.account!, allowed: true }];

  it("drops expired and not-yet-valid facts (M05)", () => {
    const facts = [base(1, { expiresAt: "2026-10-29T11:00:00Z" }), base(2, { validFrom: "2026-10-30T00:00:00Z" }), base(3)];
    expect(retrieve({ facts, consents, profileId: null, target, query: "晚餐吃什麼", now: NOW }).facts.map(f => f.text)).toEqual(["不吃第3種菜"]);
  });

  it("caps at 8 facts with at most 4 pinned preloaded, and drops whole entries over 4 KB without truncating negation (M17)", () => {
    const pinned = Array.from({ length: 6 }, (_, i) => base(i, { pinned: true, topic: "media", value: `釘選${i}` }));
    const many = Array.from({ length: 12 }, (_, i) => base(i + 10));
    const result = retrieve({ facts: [...pinned, ...many], consents, profileId: null, target, query: "晚餐吃什麼", now: NOW });
    expect(result.facts).toHaveLength(CONTEXT_MAX_FACTS);
    expect(result.facts.filter(f => f.text.startsWith("釘選"))).toHaveLength(4);
    const long = Array.from({ length: 8 }, (_, i) => base(i + 40, { value: `不要${"很長的偏好".repeat(80)}${i}` }));
    const big = retrieve({ facts: long, consents, profileId: null, target, query: "晚餐", now: NOW });
    const bytes = big.facts.reduce((n, f) => n + Buffer.byteLength(contextLine(f)) + 1, 0);
    expect(bytes).toBeLessThanOrEqual(CONTEXT_MAX_BYTES);
    expect(big.facts.length).toBeLessThan(8);
    for (const f of big.facts) expect(long.some(l => l.value === f.text)).toBe(true);
  });
});
