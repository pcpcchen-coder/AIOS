// MEM-5a 記憶建議（docs/16 §11、docs/validation/memory-mem5a-2026-10-30.md）：只用固定規則，不呼叫模型。
// - 來源只有可信主視窗打字那一輪的 chat 段落（parseMemoryText 的 op "chat"）；語音、任務成果與模型回覆一律不用。
// - 只認第一人稱、穩定的偏好句型（「我不吃／不喝／喜歡／討厭／習慣／以後都／我都…」、"I don't eat / I like / I prefer /
//   I always / from now on…"），而且內容要落在固定主題詞庫（food、comfort、reply_style、schedule、media）；其他一律不提。
// - 沿用 parse.ts 的排除規則（第三人、引文、假設、玩笑、不確定、敏感資料），另外排除健康詞、過去式、時效詞、問句、
//   指示代名詞與要求句。寧可少提，不要提錯（George 2026-10-30 授權的保守預設，待確認）。
// - suggestFrom 是確定性的：點「記住」時核心用卡片上保存的原句重新跑一次，結果必須相同才發來源票證。
// - SuggestionBook 只在記憶體：候選、被拒絕的 key 與頻率計數都不寫檔、不進 log、SSE、快照、ContextFact 或模型。

import { EN_THIRD, EN_THIRD_SUBJECT, HYPOTHETICAL, JOKE, LONG_NUMBER, QUOTE, SENSITIVE, TEMPORARY, THIRD_HELPER, THIRD_PERSON, THIRD_SPEAKER, THIRD_SUBJECT, UNCERTAIN, keyOf, parseMemoryText, topicOf, type TopicId } from "./parse.ts";

/** 建議能用的主題（naming 與 other 不提：人名、關係、個性一律不推測）。 */
export const SUGGEST_TOPICS: ReadonlySet<TopicId> = new Set(["food", "comfort", "reply_style", "schedule", "media"]);
export const SUGGEST_TTL_MS = 24 * 60 * 60_000;
export const SUGGEST_PER_HOUR = 3;
export const SUGGEST_PER_DAY = 10;
const HOUR_MS = 60 * 60_000;
const MAX_TURN_CHARS = 300;
/** 審查 M3：受詞要是短名詞片語（中文最多 12 字、英文最多 4 個詞）。 */
const MAX_ZH_OBJECT = 12;
const MAX_EN_OBJECT_WORDS = 4;
const MAX_CLAUSE_CHARS = 60;

export interface SuggestionCandidate {
  /** 使用者打的那一句（第一人稱的子句，去掉結尾標點），卡片上照原樣顯示。 */
  clause: string;
  /** 要保存的內容（中文去掉開頭的「我」，英文照原句），和明示「記住…」的保存規則相同。 */
  value: string;
  topic: TopicId;
  key: string;
  kind: "preference";
}

export type SuggestReject =
  | "empty" | "too_long" | "quote" | "joke" | "hypothetical" | "sensitive" | "third_party" | "uncertain"
  | "health" | "past" | "temporal" | "question" | "deictic" | "request" | "off_topic" | "list" | "no_match"
  /** 審查 M2：代打、轉達、翻譯、角色扮演、造句、年齡（可能是未成年）這類框架；或候選前面有不是問句或請求的子句。 */
  | "framing" | "context"
  /** 審查 M3：宗教、政治、成癮（特殊類別資料）。 */
  | "special"
  /** 受詞不是短名詞片語（條件、原因、期間）。 */
  | "clause"
  /** 這一輪有明示的記憶指令或「今天／這次」的要求。 */
  | "command";

export type SuggestAnalysis = { candidate: SuggestionCandidate } | { reject: SuggestReject };

// ───────────── 額外的排除詞（parse.ts 以外） ─────────────

/** 健康與身體狀況：過敏、藥、懷孕、疾病。16 §3 不收健康紀錄，建議也不碰。 */
export const HEALTH = /(過敏|藥|懷孕|孕|哺乳|病|醫生|醫師|醫院|血壓|血糖|糖尿|痛風|膽固醇|開刀|手術|不耐|氣喘|偏頭痛|減肥|疹|抗生素|維他命|保健|喉嚨|腫|\bmeds\b|\bvitamins?\b|\bsupplements?\b|\bblood sugar\b|\bthroat\b|\bswell\w*|\brash\b|\bhives\b|\binsulin\b|\ballerg\w*|\bmedic\w*|\bpills?\b|\bpregnan\w*|\bbreastfeed\w*|\bdisease\b|\bdiabet\w*|\bblood pressure\b|\bcholesterol\b|\bdoctor\b|\bsick\b|\bill\b|\billness\b|\basthma\b|\bmigraine\b|\bsurgery\b|\bintoleran\w*|\bdiet(?:ing)?\b|\bweight\b)/i;
/** 過去式與已經改變的狀態（「以前」「曾經」"used to"）。「本來就」是強調，不算。 */
export const PAST = /(以前|曾經|之前|小時候|過去|以往|那時候|當時|本來(?!就)|\bused to\b|\bonce\b|\bwhen i was\b|\bback then\b|\bin the past\b|\bbefore\b|\bdidn't\b|\bdid not\b|\b(?:ate|drank|liked|loved|hated|preferred|enjoyed|disliked)\b)/i;
/** 時效詞：這句只影響最近、今天或這一次。 */
export const TEMPORAL = /(最近|這週|這周|這禮拜|這星期|這個月|今年|這陣子|這幾天|今天|今晚|明天|昨天|現在|目前|暫時|這次|這一次|這餐|這頓|待會|等一下|先不|先別|\btoday\b|\btonight\b|\btomorrow\b|\byesterday\b|\bthis (?:week|month|year|time|morning|evening)\b|\blately\b|\brecently\b|\bright now\b|\bfor now\b|\bthese days\b|\bcurrently\b|\bat the moment\b|\bnow\b)/i;
/** 審查 M3：宗教、政治、成癮與戒斷（特殊類別資料）：這一輪任何一處出現就不提。 */
export const SPECIAL = /(穆斯林|回教|伊斯蘭|清真|齋戒|齋月|拜拜|拜觀音|觀音|佛教|基督|教會|禮拜|猶太|宗教|信仰|民進黨|國民黨|民眾黨|政黨|政治|選舉|總統|立委|戒酒|戒毒|戒菸|勒戒|成癮|上癮|\blent\b|ramadan|\bhalal\b|\bkosher\b|\bmuslims?\b|\bislam\w*|\bchristian\w*|\bjewish\b|\bbuddhis\w*|\bhindu\w*|\bcatholic\w*|\bchurch\b|\bmosque\b|\breligio\w*|\bfox news\b|\bcnn\b|\bdemocrat\w*|\brepublican\w*|\bpolitic\w*|\belection\w*|\brecovery\b|\brehab\b|\bsober\w*|\baddict\w*|\baa\b)/i;
/** 審查 M3：反諷與玩笑的補充（parse.ts 的 JOKE 之外）：才怪、呵呵、XD、lol、表情符號… */
export const SARCASM = /(才怪|呵呵|哈哈|笑死|XD|\blol\b|\blmao\b|\bhaha\w*|\bsaid no one\b|\boh great\b|\byeah right\b|\bsure,? jan\b|\p{Extended_Pictographic})/iu;
/** 審查 M3：「應該吧」「我想」"I think" 這類不確定（parse.ts 的 UNCERTAIN 之外）。 */
const UNSURE = /(應該|我想|我覺得|來著|\bi think\b|\bi guess\b|\bkinda\b|\bsort of\b|\bkind of\b)/i;
/** 審查 M2：代打、轉達、翻譯、角色扮演、造句、作業、年齡（可能是未成年）。這一輪任何一處出現就不提。 */
export const FRAMING = /(要我跟你說|要我告訴你|幫[^，,。.!?？﹖]{0,4}打|代替|代我|在打字|翻成|翻譯|造句|角色扮演|扮演|假裝|我\s*[0-9０-９零一二三四五六七八九十兩]+\s*歲|年級|小學|國小|國中|幼稚園|作業|\bhere\b|\bthis is\b|\bfor my\b|\bon behalf\b|\btranslat\w*|\bpretend\w*|\brole-?play\w*|\bact as\b|\bgrade\b|\byears? old\b|\bi'?m \d+\b|\bhomework\b)/iu;
/** 審查 M3：受詞裡有條件、原因或期間（「的話」「因為」「直到」「到月底」"until" "because"…）：不是單純的偏好。 */
const OBJECT_CLAUSE = /(因為|所以|的話|直到|到月底|到年底|為止|結束|之前|之後|如果|除非|\buntil\b|\bduring\b|\bsince\b|\bbecause\b|\bunless\b|\bon my\b|\bwhen\b|\bwhile\b|\bafter\b|\bbefore\b|\bexcept\b)/i;
/** 只有人物稱呼的子句（「…啦，媽媽」）：是在對別人說話，整句不提。 */
const VOCATIVE = new RegExp(`^${THIRD_PERSON}(?:啊|呀|喔|啦|欸)?$`);
/** 請求句（候選前面可以有）。 */
const REQUEST_CLAUSE = /^(?:請|麻煩|幫我|推薦|給我|告訴我|你|可以|能不能|can you|could you|would you|please|help|suggest|recommend|tell me|give me|any\b)/i;
/** 轉述（英文）：said、told… 一律當成別人的話。 */
const EN_REPORTED = /\b(?:said|says|told|tells|asked|according to)\b/i;
/** 中文的轉述與代別人說（parse.ts 的 THIRD_SPEAKER 之外）：「跟他說」「告訴她」。 */
const ZH_REPORTED = /(?:跟|和|告訴|叫)(?:他|她|他們|她們)|(?:他|她|他們|她們)(?:覺得|認為|以為)/;
/** 附加問句（「對吧」"right?"）：整句是在確認，不是陳述。 */
const TAG_QUESTION = /(?:對吧|對不對|是吧|是不是|沒錯吧)\s*[?？﹖]?\s*$|\b(?:right|correct|isn't it|don't i|do i|am i)\s*\??\s*$/i;
const ZH_QUESTION = /[?？﹖]\s*$|(?:嗎|呢|吧|麼)\s*$|什麼|是不是|對不對|有沒有|會不會|要不要|可不可以|能不能|為什麼|為何|怎麼|多少|幾點|哪|來著/;
const EN_QUESTION = /[?？﹖]\s*$|^(?:what|how|any|can|could|should|would|do|does|did|is|are|which|where|when|why|who)\b/i;
/** 受詞是代名詞或指示詞（「這部電影」「你」"it" "that"）：講的是眼前的東西或人，不是穩定偏好。 */
const ZH_DEICTIC = /^(?:這|那|你|妳|您|他|她|它|祂)|(?:這個|那個|這些|那些|這部|那部|這家|那家|這首|那首|這款|那款|這樣|那樣|你|妳|您|他們|她們)/;
const EN_DEICTIC = /^(?:it|this|that|these|those|you|him|her|them|me|us|one)\b|\b(?:this|that|these|those)\b/i;
/** 要求或打算，不是偏好（「我想要」"I'd like" "I want"）。 */
const ZH_REQUEST = /^(?:想|想要|要|需要|得|必須|應該|會|打算|準備|正在|在)/;
const EN_REQUEST = /^i(?:'d|\s+would|'ll|\s+will|\s+want|\s+need|\s+have to|\s+should|'m going to|\s+am going to|'m|\s+am)\b/i;

// ───────────── 句型 ─────────────

const ZH_ADVERB = "(?:本來就|一向|向來|從來都|從來|平常|平時|一直|都|也|很|真的|非常|超|最|比較|特別|蠻|滿|挺|完全|根本|絕對|只|還是|通常|總是)";
/** 「我」開頭（可以先有「以後」）；不能是「我們」「我的」「我家」「我媽」這類（後面一定要接副詞或動詞）。 */
const ZH_LEAD = /^(以後)?我(以後)?(.*)$/u;
const ZH_ADVERB_HEAD = new RegExp(`^${ZH_ADVERB}`);
/** 中文偏好動詞：比對順序由長到短。positive 的「吃／喝」只有在「都」「只」「習慣」之後才算（「我吃牛肉」不是偏好）。 */
const ZH_VERBS: readonly { verb: string; needsHabit?: boolean; bare?: boolean }[] = [
  { verb: "不太喜歡" }, { verb: "不喜歡" }, { verb: "喜歡" }, { verb: "討厭" }, { verb: "受不了" }, { verb: "偏好" }, { verb: "偏愛" },
  { verb: "不愛吃" }, { verb: "不愛喝" }, { verb: "愛吃" }, { verb: "愛喝" }, { verb: "愛看" }, { verb: "愛聽" },
  { verb: "很少吃" }, { verb: "很少喝" }, { verb: "不吃" }, { verb: "不喝" }, { verb: "不碰" }, { verb: "習慣" }, { verb: "怕" },
  { verb: "吃全素", bare: true }, { verb: "吃蛋奶素", bare: true }, { verb: "吃素", bare: true }, { verb: "是素食者", bare: true },
  { verb: "吃", needsHabit: true }, { verb: "喝", needsHabit: true }, { verb: "用", needsHabit: true }, { verb: "聽", needsHabit: true }, { verb: "看", needsHabit: true },
];
const EN_ADVERB = "(?:really|absolutely|totally|usually|generally|always|never|just|only|strongly|much|definitely|actually|honestly|normally|typically|still|also|truly|kind of|sort of)";
const EN_LEAD = new RegExp(`^(from now on,?\\s+)?i\\s+((?:${EN_ADVERB}\\s+)*)(.*)$`, "i");
/** 英文偏好動詞（含否定）；positive 的 eat／drink 等只有在 always／usually／only／never 之後才算。 */
const EN_VERB = /^(?:(?:don't|do not|never)\s+(?:eat|drink|like|enjoy|use|watch|listen to)|like|love|prefer|enjoy|hate|dislike|can't stand|cannot stand|avoid|(eat|drink|go to bed|go to sleep|wake up|sleep|get up|have|take|use|listen to|watch))\b\s*(.*)$/i;
const EN_HABIT = /\b(?:always|usually|only|never|normally|typically|generally)\b/i;
const EN_DIET = /^(?:i'm|i am)\s+(?:a\s+)?(vegetarian|vegan)$/i;

/** 依逗號、分號與「但是／可是」"but" 切成子句（頓號「、」不切：「我不吃香菜、洋蔥」是同一個偏好）。 */
function clauses(segment: string): string[] {
  return segment.split(/[，,；;]|\s+but\s+|但是|可是|不過/u).map(c => c.trim()).filter(Boolean);
}

/**
 * 下一個子句看起來是同一串列舉的延續（"I don't eat pork, beef or lamb"、「我不吃香菜，洋蔥」）：只記前半會記錯，整句不提。
 * 新的子句（有主詞、問句、請求）不算。
 */
function listContinues(next: string | undefined, english: boolean): boolean {
  if (!next) return false;
  const t = stripEnd(next);
  if (english) return !/^(?:i|i'm|i'd|i'll|you|we|what|how|any|anything|can|could|should|would|do|does|did|is|are|which|where|when|why|who|please|so|thanks|thank|ok|okay|and i|got|tell|give|help|suggest|recommend|let's|lets)\b/i.test(t) && !/[?？]/.test(next);
  return /^(?:和|跟|還有|以及|或|或是|或者)?[\p{Script=Han}]{1,6}$/u.test(t) && !/[吃喝要想是有會幫推薦請好嗎呢吧什麼怎哪幾不沒我你妳他她也都很]/u.test(t);
}

function stripEnd(text: string): string {
  return text.replace(/[\s。.!！~～…]+$/u, "").replace(/(?:啦|喔|哦|唷|耶|欸|呀|捏|哈)+$/u, "").trim();
}

function zhCandidate(raw: string): SuggestionCandidate | SuggestReject {
  const clause = stripEnd(raw);
  const lead = ZH_LEAD.exec(clause);
  if (!lead) return "no_match";
  const later = !!(lead[1] || lead[2]);
  let adverbs = "";
  let rest = lead[3] ?? "";
  // 動詞先比、比不到才吃掉一個副詞再比（「很少吃」是動詞，不是「很」＋「少吃」）。
  for (;;) {
    if (ZH_VERBS.some(v => rest.startsWith(v.verb) && (!v.needsHabit || /都|只|習慣/.test(adverbs)))) break;
    const head = ZH_ADVERB_HEAD.exec(rest);
    if (!head) break;
    adverbs += head[0];
    rest = rest.slice(head[0].length);
  }
  if (ZH_REQUEST.test(rest)) return "request";
  const habit = /都|只|習慣/.test(adverbs);
  for (const v of ZH_VERBS) {
    if (!rest.startsWith(v.verb)) continue;
    if (v.needsHabit && !habit) continue;
    let object = rest.slice(v.verb.length).trim();
    // 結尾的「了」：「我不吃了」「我不吃辣了」是當下的狀態或剛改變，不提；只有「以後都…了」是明確的長期決定。
    if (/了$/.test(object) || (v.bare && object === "了")) {
      if (!later) return "temporal";
      object = object.replace(/了$/u, "").trim();
    }
    if (!v.bare && !object) return "no_match";
    if (v.bare && object) return "no_match";
    if (ZH_DEICTIC.test(object)) return "deictic";
    if (OBJECT_CLAUSE.test(object)) return "clause";
    if ([...object].length > MAX_ZH_OBJECT) return "too_long";
    const typed = later ? clause.replace(/了$/u, "").trim() : clause;
    // 保存規則同 parse.ts 的 storedValue：去掉開頭的「我」（「我們」「我的」不會走到這裡）。
    const value = typed.replace(/^我/u, "").trim();
    return finish(typed, value);
  }
  return "no_match";
}

function enCandidate(raw: string): SuggestionCandidate | SuggestReject {
  const clause = stripEnd(raw);
  const diet = EN_DIET.exec(clause);
  if (diet) return finish(clause, clause);
  if (EN_REQUEST.test(clause)) return "request";
  const lead = EN_LEAD.exec(clause);
  if (!lead) return "no_match";
  const adverbs = lead[2] ?? "";
  const verb = EN_VERB.exec(lead[3] ?? "");
  if (!verb) return "no_match";
  const object = (verb[2] ?? "").trim();
  if (verb[1] && !EN_HABIT.test(adverbs)) return "no_match";
  if (!object) return "no_match";
  if (EN_DEICTIC.test(object)) return "deictic";
  if (OBJECT_CLAUSE.test(object)) return "clause";
  if (object.split(/\s+/).filter(Boolean).length > MAX_EN_OBJECT_WORDS) return "too_long";
  return finish(clause, clause);
}

function finish(clause: string, value: string): SuggestionCandidate | SuggestReject {
  if (!value || [...clause].length > MAX_CLAUSE_CHARS) return "too_long";
  const topic = topicOf(value);
  if (!SUGGEST_TOPICS.has(topic)) return "off_topic";
  return { clause, value, topic, key: keyOf(value, topic), kind: "preference" };
}

/** 審查 M3：彎引號換成直引號、全形小問號換成全形問號（長度不變），只用來比對；保存的值照使用者打的原樣。 */
function forMatching(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/﹖/g, "？");
}

/** 比對時用的子句在原句中的原樣（只有引號可能不同）。 */
function asTyped(original: string, matched: string): string {
  if (original.includes(matched)) return matched;
  const pattern = new RegExp(matched.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’‘]"));
  return pattern.exec(original)?.[0] ?? matched;
}

function isQuestion(clause: string): boolean {
  return ZH_QUESTION.test(clause) || EN_QUESTION.test(clause);
}

/**
 * 審查 M1、M2、m3：整個打字的一輪（和 MemoryService.maybeSuggest 走同一個函式）→ 第一個合格的候選，或為什麼不提。
 * 1. 這一輪要全部是一般聊天（parseMemoryText 的 chat；有明示記憶指令或「今天／這次」的要求就不提）。
 * 2. 整輪的排除（任何一句、任何一處命中就整輪不提）：引文、玩笑與反諷、假設、敏感資料、第三人與轉述、代打／翻譯／角色扮演／年齡、
 *    不確定、健康、宗教／政治／成癮、過去式、附加問句；任何子句以第三人或稱呼開頭；不是問句的子句有時效詞。
 * 3. 候選必須是這一輪的第一個子句，或前面只有問句、請求句；子句本身不能是問句，句尾問號的最後一個子句也不行；後面不能接同一串列舉。
 */
export function analyzeSuggestion(text: string): SuggestAnalysis {
  if (typeof text !== "string") return { reject: "empty" };
  const original = text.replace(/　/g, " ").trim();
  if (!original) return { reject: "empty" };
  if ([...original].length > MAX_TURN_CHARS) return { reject: "too_long" };
  const turn = forMatching(original);
  const segments = parseMemoryText(turn);
  if (!segments.length || !segments.every(seg => seg.op === "chat")) return { reject: segments.some(seg => seg.op === "temporary") ? "temporal" : "command" };
  if (QUOTE.test(turn)) return { reject: "quote" };
  if (JOKE.test(turn) || SARCASM.test(turn)) return { reject: "joke" };
  if (HYPOTHETICAL.test(turn)) return { reject: "hypothetical" };
  if (SENSITIVE.test(turn) || LONG_NUMBER.test(turn)) return { reject: "sensitive" };
  if (THIRD_SPEAKER.test(turn) || THIRD_HELPER.test(turn) || EN_THIRD.test(turn) || EN_REPORTED.test(turn) || ZH_REPORTED.test(turn)) return { reject: "third_party" };
  if (FRAMING.test(turn)) return { reject: "framing" };
  if (UNCERTAIN.test(turn) || UNSURE.test(turn)) return { reject: "uncertain" };
  if (HEALTH.test(turn)) return { reject: "health" };
  if (SPECIAL.test(turn)) return { reject: "special" };
  if (PAST.test(turn)) return { reject: "past" };
  const chats = segments.map(seg => (seg as Extract<typeof seg, { op: "chat" }>).text);
  if (chats.some(c => TEMPORARY.test(c) || TAG_QUESTION.test(c))) return { reject: TEMPORARY.test(chats.join(" ")) ? "temporal" : "question" };
  const parts = chats.flatMap(c => {
    const list = clauses(c);
    return list.map((clause, i) => ({ clause, last: i === list.length - 1, endsWithQuestion: /[?？]\s*$/.test(c), next: list[i + 1] }));
  });
  for (const p of parts) {
    if (THIRD_SUBJECT.test(p.clause) || EN_THIRD_SUBJECT.test(p.clause) || VOCATIVE.test(stripEnd(p.clause))) return { reject: "third_party" };
    if (!isQuestion(p.clause) && TEMPORAL.test(p.clause.replace(/^from now on,?\s*/i, ""))) return { reject: "temporal" };
  }
  let reason: SuggestReject = "no_match";
  for (const [index, p] of parts.entries()) {
    const english = /^(?:from now on,?\s+)?i\b|^i'm\b/i.test(p.clause);
    const result = english ? enCandidate(p.clause) : zhCandidate(p.clause);
    const earlierOk = parts.slice(0, index).every(q => isQuestion(q.clause) || REQUEST_CLAUSE.test(q.clause));
    if (typeof result === "string") {
      if (reason === "no_match" && result !== "no_match") reason = result;
      continue;
    }
    if (!earlierOk) return { reject: "context" };
    // 子句本身是問句、或是段落的最後一個子句而那段以問號結尾（"I don't eat pork?"）：不提。
    if ((english ? EN_QUESTION.test(p.clause) : ZH_QUESTION.test(p.clause)) || (p.endsWithQuestion && p.last)) return { reject: "question" };
    if (listContinues(p.next, english)) return { reject: "list" };
    const clause = asTyped(original, result.clause);
    const value = asTyped(original, result.value);
    return { candidate: { ...result, clause, value } };
  }
  return { reject: reason };
}

export function suggestFrom(text: string): SuggestionCandidate | null {
  const result = analyzeSuggestion(text);
  return "candidate" in result ? result.candidate : null;
}

/**
 * 來源票證的重新解析（MemoryBoundary.issueParsed）：卡片上核心保存的原句（整個打字的一輪）重新跑 suggestFrom，
 * 結果必須和要寫入的命令（不含 operationId）完全相同。
 */
export function suggestionBodies(text: string): { op: string; part: number; value: string; topic: string; key: string; kind: string; expires: string; scope: string }[] {
  const c = suggestFrom(text);
  return c ? [{ op: "suggest", part: 0, value: c.value, topic: c.topic, key: c.key, kind: c.kind, expires: "none", scope: "subject" }] : [];
}

// ───────────── 只在記憶體的建議簿 ─────────────

export interface PendingSuggestion {
  card: string;
  /** 卡片上核心保存的原句（整個打字的一輪）：點「記住」時用它重新取得來源票證。 */
  text: string;
  candidate: SuggestionCandidate;
  profileId: string;
  epoch: number;
  requestId: string;
  createdAt: number;
}

export type RateBlock = "hour" | "day";

/**
 * 候選與被拒絕的 key（RAM only）。頻率計數只有時間與世代，沒有內容；換世代、閒置、OS 鎖定、關閉記憶或核心關閉時，
 * 候選與被拒絕的 key 一起丟掉（呼叫端 clear），24 小時後自然過期。
 */
export class SuggestionBook {
  private readonly pending = new Map<string, PendingSuggestion>();
  private readonly rejected = new Map<string, number>();
  private readonly issued: { at: number; epoch: number }[] = [];

  private sweep(now: number): void {
    for (const [id, p] of this.pending) if (now - p.createdAt >= SUGGEST_TTL_MS) this.pending.delete(id);
    for (const [key, until] of this.rejected) if (until <= now) this.rejected.delete(key);
    while (this.issued.length && now - this.issued[0]!.at >= SUGGEST_TTL_MS) this.issued.shift();
  }

  /** 頻率：每個世代每小時 3 筆、每 24 小時 10 筆（不論世代）。 */
  rateBlock(now: number, epoch: number): RateBlock | null {
    this.sweep(now);
    if (this.issued.length >= SUGGEST_PER_DAY) return "day";
    if (this.issued.filter(x => x.epoch === epoch && now - x.at < HOUR_MS).length >= SUGGEST_PER_HOUR) return "hour";
    return null;
  }

  rejectedKey(profileId: string, key: string, now: number): boolean {
    this.sweep(now);
    return this.rejected.has(`${profileId}\u0000${key}`);
  }

  /** 審查 m1：新的一輪開始時，上一輪沒回答的候選作廢（不算拒絕；被拒絕的 key 與計數保留）。 */
  dropPending(): void { this.pending.clear(); }

  /** 新的候選：同時只留一張（上一張還沒回答就作廢，不算拒絕）。 */
  add(entry: PendingSuggestion): void {
    this.pending.clear();
    this.pending.set(entry.card, entry);
    this.issued.push({ at: entry.createdAt, epoch: entry.epoch });
  }

  /** 取得還有效的候選（不移除）。 */
  get(card: string, now: number): PendingSuggestion | null {
    this.sweep(now);
    return this.pending.get(card) ?? null;
  }

  /** 一次性：回答（記住或不用）時移除。 */
  take(card: string, now: number): PendingSuggestion | null {
    const p = this.get(card, now);
    if (p) this.pending.delete(card);
    return p;
  }

  has(card: string): boolean { return this.pending.has(card); }

  reject(profileId: string, key: string, now: number): void {
    this.rejected.set(`${profileId}\u0000${key}`, now + SUGGEST_TTL_MS);
  }

  /** 換世代、閒置、OS 鎖定、關閉記憶或建議、核心關閉：候選與被拒絕的 key 都丟掉（計數保留，沒有內容）。 */
  clear(): void {
    this.pending.clear();
    this.rejected.clear();
  }

  /** 只給測試：目前記憶體裡有幾筆（不含內容）。 */
  sizes(): { pending: number; rejected: number; issued: number } {
    return { pending: this.pending.size, rejected: this.rejected.size, issued: this.issued.length };
  }
}
