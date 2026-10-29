// MEM-1 檢索（16 §7）：先過權限再排序。順序固定為
//   subject（本次人物＋家庭共用）→ audience（household）→ 有效狀態與期限 → 當前服務帳號的同意 → 相關性。
// 不能跨人物搜尋後才刪掉不該看的結果，也不拿其他家人的資料補空結果。相關性只用固定主題、同義詞組、簡繁對照
// （只用於搜尋 token）與中文二字片段；沒有命中就回空。總共最多 8 筆、其中釘選最多 4 筆、4 KB UTF-8；超額捨去整筆，不截斷。
// ContextFact 只含 text、source、at、expires，不含人物 ID、記憶 ID、票證或版本。

import type { MemoryConsent, MemoryFact } from "./store.ts";
import { questionTopics, synonymGroups, toTraditional, type TopicId } from "./parse.ts";

export const CONTEXT_MAX_FACTS = 8;
export const CONTEXT_MAX_PINNED = 4;
export const CONTEXT_MAX_BYTES = 4096;

export interface ContextFact {
  text: string;
  source: "explicit";
  at: string;
  expires: string | null;
}

export interface ChatTarget {
  provider: string;
  /** 帳號指紋（Claude：API key 的 HMAC 前 16 碼；ChatGPT：帳號 ID 的雜湊）。null＝沒有可用帳號，不送記憶。 */
  account: string | null;
  label: string;
}

export interface RetrievalInput {
  facts: readonly MemoryFact[];
  consents: readonly MemoryConsent[];
  /** 本次人物；null＝沒有選定人物，只用家庭共用。 */
  profileId: string | null;
  target: ChatTarget | null;
  query: string;
  now: number;
}

export interface RetrievalResult {
  facts: ContextFact[];
  /** 依權限可用但不相關、或因上限捨去的筆數（只給 log 與測試，不給模型）。 */
  dropped: number;
  /** 人物與期限上可用、也與問題相關（或已釘選），但目前服務／帳號沒有同意的筆數（用來照實告知「這次沒有用到記憶」）。 */
  blockedByConsent: number;
}

const STOP_BIGRAMS = new Set(["什麼", "怎麼", "可以", "我們", "你們", "他們", "一下", "這個", "那個", "今天", "明天", "現在", "幫我", "請你", "一個", "沒有", "不是", "就是", "還是", "因為", "所以", "如果", "知道", "覺得", "應該", "需要", "想要", "喜歡", "不要", "要不", "好嗎", "嗎？", "一點"]);
const EN_STOP = new Set(["the", "and", "for", "you", "are", "what", "how", "can", "should", "with", "that", "this", "have", "has", "was", "were", "about", "please", "help", "me", "my", "your", "i", "it", "is", "do", "does", "don't", "not", "like"]);

/** 中文二字片段（簡繁對照後，只取漢字連續段）。 */
export function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of toTraditional(text).match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      const gram = chars[i]! + chars[i + 1]!;
      if (!STOP_BIGRAMS.has(gram)) out.add(gram);
    }
  }
  return out;
}

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter(w => !EN_STOP.has(w)));
}

function consentFor(consents: readonly MemoryConsent[], profileId: string | null, target: ChatTarget): boolean {
  return consents.some(c => c.profileId === profileId && c.provider === target.provider && c.account === target.account && c.allowed);
}

function active(fact: MemoryFact, now: number): boolean {
  const from = Date.parse(fact.validFrom);
  if (Number.isFinite(from) && from > now) return false;
  return fact.expiresAt === null || Date.parse(fact.expiresAt) > now;
}

/** 相關性分數：主題 2、同義詞組 3、每個共同的二字片段或英文詞 1。0＝不相關。 */
export function relevance(fact: Pick<MemoryFact, "topic" | "value" | "key">, query: string, topics: Set<TopicId> = questionTopics(query)): number {
  let score = 0;
  if (topics.has(fact.topic as TopicId)) score += 2;
  const qGroups = new Set(synonymGroups(query));
  for (const g of synonymGroups(`${fact.value} ${fact.key}`)) if (qGroups.has(g)) score += 3;
  const qGrams = bigrams(query);
  for (const g of bigrams(fact.value)) if (qGrams.has(g)) score += 1;
  const qWords = words(query);
  for (const w of words(fact.value)) if (qWords.has(w)) score += 1;
  return score;
}

export function contextLine(fact: ContextFact): string {
  return JSON.stringify(fact);
}

/** 權限過濾後排序；回傳要送給模型的 ContextFact（不含任何 ID）。 */
export function retrieve(input: RetrievalInput): RetrievalResult {
  const { target, now } = input;
  if (!target || !target.account) return { facts: [], dropped: 0, blockedByConsent: 0 };
  // 1. subject：本次人物＋家庭共用（沒有選定人物時只有家庭共用）。
  const inScope = input.facts.filter(f => f.profileId === null || (input.profileId !== null && f.profileId === input.profileId));
  // 2. audience：首版只有 household。3. 有效狀態與期限。
  const valid = inScope.filter(f => f.audience === "household" && active(f, now));
  // 4. 當前服務＋帳號的同意（依 fact 的歸屬：人物或家庭）。
  const allowed = valid.filter(f => consentFor(input.consents, f.profileId, target));
  // 5. 相關性：釘選的先放（最多 4 筆），其餘依分數，同分取較新的。
  const topics = questionTopics(input.query);
  // 沒有同意而不能送出的相關記憶（只計數，不送內容）。
  const blockedByConsent = valid.filter(f => !allowed.includes(f) && (f.pinned || relevance(f, input.query, topics) > 0)).length;
  const scored = allowed.map(f => ({ f, score: relevance(f, input.query, topics) }));
  const pinned = scored.filter(x => x.f.pinned).sort((a, b) => b.score - a.score || b.f.source.at.localeCompare(a.f.source.at)).slice(0, CONTEXT_MAX_PINNED);
  const rest = scored.filter(x => !pinned.includes(x) && x.score > 0).sort((a, b) => b.score - a.score || b.f.source.at.localeCompare(a.f.source.at));
  const chosen: ContextFact[] = [];
  let bytes = 0;
  for (const { f } of [...pinned, ...rest]) {
    if (chosen.length >= CONTEXT_MAX_FACTS) break;
    const fact: ContextFact = { text: f.value, source: "explicit", at: f.source.at, expires: f.expiresAt };
    const size = Buffer.byteLength(contextLine(fact)) + 1;
    // 超額就捨去整筆（不截斷「不要」這類否定語意），繼續看後面較短的。
    if (bytes + size > CONTEXT_MAX_BYTES) continue;
    bytes += size;
    chosen.push(fact);
  }
  return { facts: chosen, dropped: allowed.length - chosen.length, blockedByConsent };
}
