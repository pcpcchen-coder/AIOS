// 本機、確定性的文字比對 token：簡繁對照（只用於比對，不改原文）、中文二字片段與英文詞。
// 記憶檢索（server/memory/retrieve.ts）與成果紀錄搜尋（server/history.ts）共用，不各寫一份。

import { toTraditional, toTraditionalChar } from "./memory/parse.ts";

/**
 * 只用於成果紀錄搜尋的補充折疊（任務常用字）。簡轉繁只放一對一的字；「划（划／劃）」「发（發／髮）」這類一對多的，
 * 改成把繁體折成共同的字，兩邊（查詢與原文）都折，比對才一致。
 * 這張表不給記憶用（記憶保存前的 toTraditional 會改寫要保存的句子），所以不加進 memory/parse.ts。
 */
const SEARCH_S2T: Record<string, string> = Object.fromEntries([
  "计計", "报報", "规規", "议議", "会會", "项項", "题題", "资資", "产產", "业業", "车車", "机機", "场場", "实實", "处處",
  "应應", "网網", "务務", "预預", "费費", "钱錢", "购購", "邮郵", "图圖", "设設", "库庫", "师師", "学學", "医醫", "药藥",
  "楼樓", "馆館", "旧舊", "头頭", "总總", "结結", "论論", "络絡", "数數", "统統", "门門", "问問",
  // 一個簡體字對多個繁體字的，反過來把繁體折成共同的那個字（只影響比對，不改原文）：劃／划 → 划，發／髮 → 发。
  "劃划", "發发", "髮发",
].map((pair) => [pair[0]!, pair.slice(1)]));
const SEARCH_S2T_PATTERN = new RegExp(`[${Object.keys(SEARCH_S2T).join("")}]`, "gu");

function searchTraditional(text: string): string {
  return toTraditional(text).replace(SEARCH_S2T_PATTERN, (ch) => SEARCH_S2T[ch] ?? ch);
}

function searchTraditionalChar(ch: string): string {
  const t = toTraditionalChar(ch);
  return SEARCH_S2T[t] ?? t;
}

/** 記憶檢索用：問句裡常見、對相關性沒有意義的二字片段。 */
export const STOP_BIGRAMS: ReadonlySet<string> = new Set(["什麼", "怎麼", "可以", "我們", "你們", "他們", "一下", "這個", "那個", "今天", "明天", "現在", "幫我", "請你", "一個", "沒有", "不是", "就是", "還是", "因為", "所以", "如果", "知道", "覺得", "應該", "需要", "想要", "喜歡", "不要", "要不", "好嗎", "嗎？", "一點"]);
export const EN_STOP: ReadonlySet<string> = new Set(["the", "and", "for", "you", "are", "what", "how", "can", "should", "with", "that", "this", "have", "has", "was", "were", "about", "please", "help", "me", "my", "your", "i", "it", "is", "do", "does", "don't", "not", "like"]);
const NO_STOP: ReadonlySet<string> = new Set();

/** 中文二字片段（簡繁對照後，只取漢字連續段）。stop 預設是記憶檢索的停用詞；搜尋框傳空集合。 */
export function bigrams(text: string, stop: ReadonlySet<string> = STOP_BIGRAMS): Set<string> {
  const out = new Set<string>();
  for (const run of toTraditional(text).match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      const gram = chars[i]! + chars[i + 1]!;
      if (!stop.has(gram)) out.add(gram);
    }
  }
  return out;
}

/** 英文詞（小寫、至少 minLength 個字母）；stop 預設是記憶檢索的停用詞。 */
export function words(text: string, stop: ReadonlySet<string> = EN_STOP, minLength = 3): Set<string> {
  const pattern = new RegExp(`[a-z][a-z'-]{${Math.max(0, minLength - 1)},}`, "g");
  return new Set((text.toLowerCase().match(pattern) ?? []).filter(w => !stop.has(w)));
}

/**
 * 比對用的折疊：逐字（UTF-16 單位）簡轉繁、英文轉小寫；長度不變，所以折疊後的位置就是原文的位置
 * （片段標示的 offset 可以直接用在原文）。會改變長度的大小寫轉換（少數非英文字母）就保留原字。
 */
export function foldForSearch(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return searchTraditional(lower);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const folded = searchTraditionalChar(ch);
    const low = folded.toLowerCase();
    out += low.length === folded.length ? low : folded;
  }
  return out;
}

/** 搜尋框的查詢詞：中文二字片段（單一漢字也算一個詞）、英文與數字詞（至少 2 個字元），都已折疊；去重。 */
export function queryTerms(query: string): string[] {
  const folded = foldForSearch(query.normalize("NFKC"));
  const out = new Set<string>();
  for (const run of folded.match(/\p{Script=Han}+/gu) ?? []) {
    if ([...run].length === 1) out.add(run);
    else for (const g of bigrams(run, NO_STOP)) out.add(g);
  }
  for (const w of folded.match(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}'_-]*/gu) ?? []) {
    if (w.length >= 2 || /\p{N}/u.test(w)) out.add(w);
  }
  return [...out];
}

/**
 * 成果紀錄搜尋的近義詞（HIST-1 Mac 驗收 F2，George 2026-10-31 選擇支援近義詞）。保守、明確列出的小表，不做模糊比對：
 * - 只擴充查詢詞（queryTerms 的結果），不改寫、不擴充保存的原文；折疊（foldForSearch）照舊，兩邊都折。
 * - 同一組的詞互為近義詞。中文詞只放一或兩個字（查詢詞就是二字片段，兩字詞才對得上）。
 * - 一個字的詞（「信」）只在單獨成段的「信」（整段漢字就是那一個字）時才擴充，而且永遠不拿來當其他詞的近義詞
 *   （一個字太寬：「相信」也有「信」）。
 * - 英文的整詞規則只用在近義詞（前後不是英文字母或數字），近義詞「plan」不會比對到「explanation」；複數等變化明確列出。
 *   查詢的原詞照舊是子字串比對（原本的行為）。
 * - 中文近義詞是子字串比對，可能跨詞界命中（中文沒有空白分詞）；已知的「離開會場」（開會）、「每日程式」（日程）、
 *   「法規劃分」（規劃）用 SYNONYM_EXCLUDE 排除，其他跨詞界的情況仍可能出現（已知限制）。
 * - 近義詞命中算命中（命中比例照算），但分數只有原詞的一半；排序在命中比例之後先比「原詞命中幾個」，再比分數，
 *   所以命中比例相同時，原詞命中較多的一定排在前面。
 * 「行程」（itinerary）和「計畫／規劃」（plan）意思不同，分成兩組，不互相擴充。
 */
export const SEARCH_SYNONYMS: readonly (readonly string[])[] = [
  ["晚餐", "晚飯", "晚饭", "dinner", "dinners", "supper"],
  ["午餐", "午飯", "午饭", "lunch", "lunches"],
  ["早餐", "早飯", "早饭", "breakfast", "breakfasts"],
  ["會議", "会议", "開會", "开会", "meeting", "meetings"],
  ["計畫", "計劃", "计划", "規劃", "规划", "plan", "plans", "planning"],
  ["行程", "日程", "itinerary", "itineraries"],
  ["郵件", "邮件", "電郵", "电邮", "信件", "信", "email", "emails", "e-mail"],
  ["報告", "报告", "report", "reports"],
];

/** 折疊後的詞 → 它所在的組（折疊後去重）。 */
const SYNONYM_GROUPS: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SEARCH_SYNONYMS) {
    const folded = [...new Set(group.map((w) => foldForSearch(w.normalize("NFKC"))))];
    for (const w of folded) map.set(w, folded);
  }
  return map;
})();

const LATIN_WORD_CHAR = /[\p{Script=Latin}\p{N}]/u;

/**
 * 中文近義詞的已知跨詞界誤命中：近義詞出現在這些上下文裡時不算（只影響近義詞；查詢的原詞照舊）。
 * 鍵與上下文都已折疊。
 */
const SYNONYM_EXCLUDE: ReadonlyMap<string, readonly string[]> = new Map(
  ([["開會", ["離開會"]], ["日程", ["每日程"]], ["規劃", ["法規劃"]]] as const).map(([alt, ctx]) => [foldForSearch(alt), ctx.map((c) => foldForSearch(c))]),
);

function excludedAt(folded: string, alt: string, at: number): boolean {
  for (const ctx of SYNONYM_EXCLUDE.get(alt) ?? []) {
    const k = ctx.indexOf(alt);
    if (k >= 0 && at - k >= 0 && folded.startsWith(ctx, at - k)) return true;
  }
  return false;
}

/** 近義詞是英文詞時要整個詞相符；中文照子字串。 */
function isLatinWord(term: string): boolean {
  return /^[\p{Script=Latin}\p{N}]/u.test(term);
}

/**
 * 每個查詢詞的近義詞（順序和 terms 相同；沒有近義詞的是空陣列）。已經包含原詞的近義詞不列（原詞命中就算到了，分數也較高）；
 * 一個字的詞不當近義詞。
 */
export function synonymsFor(terms: readonly string[]): string[][] {
  return terms.map((term) => {
    const group = SYNONYM_GROUPS.get(term);
    if (!group) return [];
    return group.filter((alt) => alt !== term && [...alt].length > 1 && !alt.includes(term));
  });
}

/** 近義詞 alt 在折疊後的文字裡從 from 起第一次出現的位置（英文要整個詞相符）；沒有回 -1。 */
export function synonymIndexOf(folded: string, alt: string, from = 0): number {
  const whole = isLatinWord(alt);
  for (let at = folded.indexOf(alt, from); at >= 0; at = folded.indexOf(alt, at + 1)) {
    if (!whole) {
      if (!excludedAt(folded, alt, at)) return at;
      continue;
    }
    const before = at > 0 ? folded[at - 1]! : "";
    const after = folded[at + alt.length] ?? "";
    if (!LATIN_WORD_CHAR.test(before) && !LATIN_WORD_CHAR.test(after)) return at;
  }
  return -1;
}
