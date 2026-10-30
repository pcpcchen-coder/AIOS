// MEM-1 的記憶指令解析（16 §5、§7）：只用固定規則與固定詞庫，不呼叫模型。核心在兩個地方用同一個函式：
//   1. 收到可信主視窗的打字時，切出要處理的段落（選人 → 寫入 → 剩下的問題送 chat）；
//   2. MemoryBoundary.issueParsed 發票證前，用同一個函式重新解析核心觀察到的原句，結果必須與命令完全相同。
// 規則刻意保守：第三人轉述、引文、假設、玩笑一律不寫入；語意不清楚就交給澄清卡，不猜。
// 「今天不要…」只影響這一次（送 chat），明說「記住今天」才保存到當地當日結束。
// 這裡不知道人物、同意或資料庫；那些由 service.ts 決定。

export type TopicId = "food" | "comfort" | "reply_style" | "schedule" | "media" | "naming" | "other";
export type ParsedSegment =
  /** text：原段落（這個名字不是既有人物、句子也沒有接著「記住」時，原句照樣交給一般聊天）。 */
  | { op: "self_id"; part: number; name: string; text: string }
  | { op: "remember"; part: number; value: string; topic: TopicId; key: string; kind: "preference" | "note"; expires: "none" | "today" }
  /** text：原段落（找不到要更正或忘記的記憶時，原句照樣交給一般聊天）。 */
  | { op: "correct"; part: number; value: string; topic: TopicId; key: string; text: string }
  | { op: "forget"; part: number; value: string; topic: TopicId; key: string; text: string }
  | { op: "forget_all"; part: number }
  | { op: "inspect"; part: number }
  | { op: "rejected"; part: number; reason: "third_party" | "quote" | "hypothetical" | "joke" | "sensitive" }
  | { op: "unclear"; part: number; reason: "question" | "uncertain" | "too_long" | "empty" | "about_assistant"; value: string }
  | { op: "temporary"; part: number; text: string }
  | { op: "chat"; part: number; text: string };

/** 會寫入的段落（需要來源票證）。 */
export type WriteSegment = Extract<ParsedSegment, { op: "remember" | "correct" | "forget" | "forget_all" | "self_id" }>;

export const MAX_VALUE_CHARS = 512;
/** 一句話裡的記憶內容超過這個長度就請使用者確認（不截斷）。 */
const CLARIFY_CHARS = 200;

// ───────────── 固定詞庫 ─────────────

/** 主題詞庫：值或問題含這些詞就歸到該主題。英文詞以小寫比對完整單字。 */
export const TOPIC_TERMS: Record<Exclude<TopicId, "other">, readonly string[]> = {
  food: ["吃", "喝", "食物", "食", "菜", "料理", "餐", "早餐", "午餐", "晚餐", "晚飯", "午飯", "早飯", "宵夜", "點心", "甜點", "飯", "麵", "湯", "香菜", "芫荽", "咖啡", "拿鐵", "茶", "奶茶", "牛奶", "鮮奶", "酒", "啤酒", "辣", "辣椒", "甜", "鹹", "素食", "吃素", "海鮮", "牛肉", "豬肉", "雞肉", "魚", "蝦", "蛋", "花生", "過敏", "口味", "飲料", "果汁", "水果", "蔬菜", "餐廳", "外送", "便當", "火鍋", "番茄", "洋蔥", "蔥", "大蒜", "起司", "乳製品", "dinner", "lunch", "breakfast", "food", "eat", "eats", "drink", "coffee", "tea", "milk", "spicy", "cilantro", "coriander", "vegetarian", "vegan", "allergic", "meal", "restaurant", "snack", "beer", "wine"],
  comfort: ["冷氣", "空調", "溫度", "暖氣", "電暖器", "燈", "燈光", "亮", "暗", "窗簾", "風扇", "電扇", "濕度", "除濕", "太冷", "太熱", "怕冷", "怕熱", "air", "conditioning", "ac", "temperature", "heater", "light", "lights", "fan", "humidity"],
  reply_style: ["回答", "回覆", "簡短", "簡單", "詳細", "長一點", "短一點", "語氣", "說話", "解釋", "條列", "英文回答", "中文回答", "answer", "answers", "reply", "replies", "brief", "concise", "detailed", "short", "tone"],
  schedule: ["起床", "睡覺", "早睡", "晚睡", "作息", "上班", "下班", "午睡", "鬧鐘", "wake", "sleep", "bedtime", "alarm"],
  media: ["音樂", "歌", "電影", "影集", "節目", "書", "閱讀", "小說", "遊戲", "運動", "球", "music", "song", "songs", "movie", "movies", "show", "shows", "book", "books", "game", "games", "sport", "sports"],
  naming: ["叫我", "稱呼", "名字", "暱稱", "nickname", "call"],
};

/**
 * 同義詞組（含常見的簡體／中國大陸用語）：組內任一詞出現就算同一個「物件」。用於比對更正／忘記的目標與檢索相關性。
 * 第一個詞是保存時使用的標準鍵。
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["香菜", "芫荽", "cilantro", "coriander"],
  ["咖啡", "拿鐵", "美式", "濃縮", "coffee", "latte", "espresso"],
  ["茶", "奶茶", "紅茶", "綠茶", "tea"],
  ["牛奶", "鮮奶", "乳製品", "milk", "dairy"],
  ["辣", "辣椒", "麻辣", "spicy", "chili"],
  ["酒", "啤酒", "紅酒", "alcohol", "beer", "wine"],
  ["海鮮", "蝦", "蟹", "螃蟹", "seafood", "shrimp", "crab"],
  ["花生", "堅果", "peanut", "peanuts", "nuts"],
  ["番茄", "西紅柿", "tomato", "tomatoes"],
  ["馬鈴薯", "土豆", "potato", "potatoes"],
  ["鳳梨", "菠蘿", "pineapple"],
  ["素食", "吃素", "蔬食", "vegetarian", "vegan"],
  ["冷氣", "空調", "air conditioning", "ac"],
  ["暖氣", "電暖器", "heater"],
  ["燈", "燈光", "light", "lights"],
  ["簡短", "簡單", "短一點", "精簡", "brief", "concise", "short"],
  ["詳細", "長一點", "detailed"],
  ["起床", "鬧鐘", "wake", "alarm"],
  ["睡覺", "就寢", "早睡", "晚睡", "sleep", "bedtime"],
  ["音樂", "歌", "music", "song", "songs"],
  ["電影", "影片", "movie", "movies", "film"],
  ["香蕉", "banana"],
  ["蔥", "洋蔥", "onion", "onions"],
];

/** 問題常用詞 → 主題（例如「晚餐吃什麼」→ food）。 */
const QUESTION_TOPICS: readonly [RegExp, TopicId][] = [
  [/(吃什麼|吃啥|晚餐|午餐|早餐|宵夜|點心|食譜|菜單|料理|餐廳|外送|便當|飲料|喝什麼|喝點|下午茶|聚餐|請客|煮|做菜|買菜|dinner|lunch|breakfast|recipe|restaurant|menu|eat|drink|cook)/i, "food"],
  [/(冷氣|空調|溫度|太冷|太熱|好熱|好冷|暖氣|燈|開燈|關燈|窗簾|風扇|temperature|thermostat|\bac\b|air conditioning|heater)/i, "comfort"],
  [/(怎麼回答|回答方式|回覆方式|說話方式|講話方式|簡短|詳細|answer style|reply style|how (should|do) you (answer|reply))/i, "reply_style"],
  [/(起床|睡覺|作息|鬧鐘|幾點睡|幾點起|wake|sleep|bedtime|alarm)/i, "schedule"],
  [/(音樂|歌|電影|影集|節目|看什麼|聽什麼|書|遊戲|運動|music|movie|show|book|game|sport)/i, "media"],
  [/(怎麼叫我|叫我什麼|稱呼|暱稱|what should you call me|nickname)/i, "naming"],
];

/** 簡體 → 繁體（只用於搜尋 token；保存的原文不改）。 */
const S2T: Record<string, string> = Object.fromEntries([
  "鸡雞", "猪豬", "鱼魚", "虾蝦", "蟹蟹", "面麵", "饭飯", "汤湯", "菜菜", "冷冷", "气氣", "温溫", "热熱", "灯燈", "欢歡", "讨討", "厌厭", "过過", "敏敏", "晚晚", "饮飲", "料料", "茶茶", "奶奶", "鲜鮮", "辣辣", "酱醬", "点點", "钟鐘", "觉覺", "觉覺", "乐樂", "电電", "视視", "剧劇", "书書", "戏戲", "运運", "动動", "这這", "个個", "说說", "时時", "间間", "东東", "买買", "么麼", "吗嗎", "记記", "忆憶", "们們", "还還", "没沒", "从從", "种種", "样樣", "让讓", "调調", "节節", "适適", "爱愛", "喝喝", "啤啤", "红紅", "绿綠", "鳯鳳", "梨梨", "蔬蔬", "葱蔥", "蒜蒜", "腊臘", "肠腸", "饺餃", "馄餛", "饨飩", "粮糧", "盐鹽", "糖糖", "块塊", "单單", "简簡", "详詳", "细細", "长長", "短短", "语語", "气氣", "睡睡", "闹鬧", "铃鈴", "开開", "关關", "风風", "扇扇", "帘簾", "窗窗", "湿濕", "度度", "暖暖", "厨廚", "烧燒", "烤烤", "炸炸", "蛋蛋", "鲁魯", "卤滷", "饼餅", "粥粥", "汤湯", "豆豆", "腐腐", "园園", "习習", "惯慣", "爷爺", "妈媽", "爸爸", "儿兒", "女女", "孙孫", "听聽", "读讀", "写寫", "游遊", "确確", "认認",
].map(pair => [pair[0]!, pair.slice(1)]));

/** 對照表的每個簡體字都是單一 BMP 字元，可以一次用字元類別取代。 */
const S2T_PATTERN = new RegExp(`[${Object.keys(S2T).join("")}]`, "gu");

export function toTraditional(text: string): string {
  return text.replace(S2T_PATTERN, ch => S2T[ch] ?? ch);
}

/**
 * 單一字元的簡轉繁（不在對照表就原樣）。這張表也用在語音記憶保存前（memory/live.ts），所以只放一對一、
 * 不會改寫繁體原句的字；成果紀錄搜尋另有自己的補充表（server/search-terms.ts），不加在這裡。
 */
export function toTraditionalChar(ch: string): string {
  return S2T[ch] ?? ch;
}

// ───────────── 判斷用的固定句型 ─────────────
// MEM-5a：排除規則（第三人、引文、假設、玩笑、不確定、敏感、今天／這次）也給 server/memory/suggest.ts 用，所以 export。

export const THIRD_PERSON = "(?:他|她|它|他們|她們|媽媽|媽|爸爸|爸|哥哥|姊姊|姐姐|弟弟|妹妹|奶奶|爺爺|外婆|外公|阿嬤|阿公|老婆|老公|太太|先生|兒子|女兒|小孩|孩子|阿姨|叔叔|伯伯|舅舅|朋友|同事|老闆|鄰居)";
export const THIRD_SPEAKER = new RegExp(`(${THIRD_PERSON}|電視|新聞|廣播|影片|文章|網路|書上|有人|別人|大家)(?:剛剛|剛才|之前|也)?(?:說|講|提到|寫)`);
export const THIRD_HELPER = new RegExp(`(?:幫|替|為)${THIRD_PERSON}(?:記住|記下|記一下)`);
export const THIRD_SUBJECT = new RegExp(`^(?:我(?:的)?)?${THIRD_PERSON}(?:都|也|很|不|喜歡|討厭|愛|要|想|會|是|對|每天|吃|喝)`);
export const EN_THIRD = /\b(he|she|they|someone|somebody|the tv|the news|my (?:mom|mother|dad|father|wife|husband|son|daughter|kid|kids|friend|boss|brother|sister))\b(?: (?:said|says|told|wants|likes|hates|doesn't|does not|is))/i;
export const EN_THIRD_SUBJECT = /^(?:that\s+)?(?:he|she|they|my (?:mom|mother|dad|father|wife|husband|son|daughter|kid|kids|friend|boss|brother|sister))\b/i;
export const QUOTE = /[「」『』"“”]/;
export const HYPOTHETICAL = /(如果|假如|假設|要是|萬一|倘若|假使|\bif\b|\bsuppose\b|\bimagine\b|\bpretend\b|\bwhat if\b)/i;
export const JOKE = /(開玩笑|開個玩笑|騙你的|說笑的|說著玩|鬧著玩|亂說的|\bjust kidding\b|\bkidding\b|\bjoking\b|\bjk\b)/i;
export const UNCERTAIN = /(可能|大概|好像|也許|或許|說不定|不確定|\bmaybe\b|\bprobably\b|\bperhaps\b|\bnot sure\b)/i;
const ABOUT_ASSISTANT = /^(?:你|妳|nous|you\b)/i;

const ZH_REMEMBER = "(?:記住|記下來|記下|記一下)";
const ZH_REMEMBER_PREFIX = new RegExp(`^(?:請|麻煩)?(?:你)?(?:幫我|替我)?${ZH_REMEMBER}(今天)?(?:[：:，,、\\s]+)?(.*)$`);
const ZH_REMEMBER_SUFFIX = new RegExp(`^(.+?)[，,、\\s]*(?:請|麻煩)?(?:你)?(?:幫我|替我)?${ZH_REMEMBER}(今天)?(?:喔|哦|吧|唷|啦|好嗎|好不好|一下)?$`);
const EN_REMEMBER_PREFIX = /^(?:please\s+)?remember(\s+(?:just\s+)?for\s+today)?(?:\s+that)?[:,]?\s+(.+)$/i;
const EN_REMEMBER_SUFFIX = /^(.+?),?\s+(?:please\s+)?remember (?:that|this|it)(\s+(?:just\s+)?for\s+today)?$/i;
// 更正／忘記只認句首的動詞，而且要有「記憶」受詞，或（「更正，…」「忘記…」）由 service.ts 找到明確的記憶目標；
// 「把報告改一下」「這段文字幫我改一下」「忘記密碼了怎麼辦」「forget it」都是一般聊天。找不到目標時原句照樣交給 chat。
const ZH_CORRECT_MEMORY = /^(?:請)?(?:幫我)?(?:更正|更新|修改|改一下)(?:一下)?(?:我的)?記憶[：:，,\s]*(.+)$/;
const ZH_CORRECT_PREFIX = /^(?:請)?(?:幫我)?更正(?:一下)?[：:，,\s]+(.+)$/;
const EN_CORRECT_PREFIX = /^(?:please\s+)?(?:correct|update|change)\s+(?:my\s+memory|memory|what you remember)(?:\s+to)?[:,]?\s+(.+)$|^correction[:,]\s+(.+)$/i;
const ZH_FORGET = /^(?:請)?(?:幫我)?(?:忘記|忘掉|不要再記得|別再記得)[：:，,\s]*(.+?)(?:這件事|這個|這筆|的事情|的事)?(?:吧|喔)?$/;
const EN_FORGET = /^(?:please\s+)?forget\s+(?:that|about)\s+(.+)$/i;
/** 忘記的內容只是代名詞或問句（「忘記這件事吧」「忘記密碼了怎麼辦」）：不是明確的記憶目標，當一般聊天。 */
const NOT_A_TARGET = /^(?:這件事|這個|那個|這|那|它|it|this|that|everything)$|(?:怎麼辦|怎麼做|怎麼弄|嗎|呢|[?？])$/i;
/**
 * 16 §3 不納入記憶的敏感資料：密碼、權杖、卡號、帳號、病歷、身分證等固定詞，以及連續長數字（≥6 位，或含空白與連字號的 ≥9 位）。
 * 命中就拒絕寫入（「這類資料不能存進記憶」），不嘗試遮罩後保存。
 */
export const SENSITIVE = /(密碼|密碼是|口令|驗證碼|權杖|金鑰|token|api ?key|卡號|信用卡|金融卡|提款卡|帳號|帳戶|銀行|存摺|病歷|診斷|病史|處方|身分證|身份證|護照|健保卡|password|passcode|\bpin\b|credit card|card number|account number|bank account|social security|\bssn\b|medical record|diagnosis|passport)/i;
export const LONG_NUMBER = /\d{6,}|(?:\d[\s-]?){9,}/;
const FORGET_ALL = /^(?:請)?(?:幫我)?(?:全部忘記|忘記全部|全部都忘記|全部忘掉|忘掉全部|忘記所有(?:的)?(?:事|事情|記憶)?|清除(?:所有|全部)(?:的)?記憶|刪除(?:所有|全部)(?:的)?記憶)(?:吧)?$|^(?:please\s+)?(?:forget everything|forget all(?: of it| memories)?|delete all memories|clear (?:all )?memories)$/i;
const INSPECT = /^(?:你)?(?:都)?(?:記得|知道|記住了)(?:我|關於我)(?:的)?(?:什麼|哪些|些什麼|哪些事)(?:嗎|呢)?$|^你(?:都)?記得(?:些)?什麼(?:嗎|呢)?$|^(?:看|打開|顯示)?我的記憶(?:有哪些)?$|^what do you (?:remember|know) about me$|^what do you remember$|^show (?:me )?my memories$/i;
export const TEMPORARY = /^(?:今天|今晚|這次|這一次|這餐|這頓|現在先|今天先)(?:先)?(?:不要|別|不想|想|要|改)|^(?:just\s+)?(?:for\s+)?(?:today|tonight|this time)\b/i;
// 「我是 X」只提出名字；service.ts 只在 X 是既有人物（或句子接著「記住」）時才當選人，否則原句交給一般聊天。
const ZH_SELF = /^(?:我是|我叫)\s*([^\s，,、。]{1,16}?)\s*(?:啦|喔|哦|唷|呀)?$/;
const EN_SELF = /^(?:[Ii] am|[Ii]'m|[Mm]y name is)\s+([A-Z][A-Za-z'-]{0,30}(?:\s+[A-Z][A-Za-z'-]{0,30}){0,2})$/;
const SELF_REST = /^((?:我是|我叫)\s*[^\s，,、。]{1,16}?|(?:i am|i'm|my name is)\s+[A-Z][A-Za-z'-]{0,30})\s*[，,]\s*(.+)$/i;
const NOT_A_NAME = /^(素食者|素食|吃素|學生|老師|醫生|護士|工程師|新來的|誰|男生|女生|大人|小孩|人|客人|主人|你的主人|管理員|家長|開玩笑的?)$|[者人的了在不很有要會想吃喝愛也都說個們你他她它嗎呢吧]$/;

function cleanValue(raw: string): string {
  return raw.replace(/^[\s：:，,、]+/, "").replace(/[\s，,、。.!！~～…]+$/, "").replace(/(喔|哦|唷|啦)$/, "").trim();
}

/** zh 去掉開頭的「我」（回條用人物名，不轉換人稱；「我的…」「我們…」保留，避免剩下「的…」）；en 去掉開頭的 that。其餘保留原話。 */
function storedValue(value: string): string {
  return value.replace(/^我(?=[^們的])/, "").replace(/^that\s+/i, "").trim();
}

function hasWord(text: string, term: string): boolean {
  if (/^[a-z ]+$/.test(term)) return new RegExp(`\\b${term}\\b`, "i").test(text);
  return text.includes(term);
}

export function topicOf(text: string): TopicId {
  const t = toTraditional(text);
  for (const [topic, terms] of Object.entries(TOPIC_TERMS) as [Exclude<TopicId, "other">, readonly string[]][]) {
    if (topic === "naming" ? /(叫我|稱呼我|call me|my nickname)/i.test(t) : terms.some(term => hasWord(t, term))) {
      // naming 只看明確句型；其他主題依詞庫順序取第一個命中的。
      return topic;
    }
  }
  return "other";
}

/** 問題 → 主題集合（檢索用）：問題常用詞與主題詞庫都算。 */
export function questionTopics(text: string): Set<TopicId> {
  const t = toTraditional(text);
  const topics = new Set<TopicId>();
  for (const [pattern, topic] of QUESTION_TOPICS) if (pattern.test(t)) topics.add(topic);
  for (const [topic, terms] of Object.entries(TOPIC_TERMS) as [Exclude<TopicId, "other">, readonly string[]][]) {
    if (topic !== "naming" && terms.some(term => term.length > 1 && hasWord(t, term))) topics.add(topic);
  }
  return topics;
}

/** 同義詞組索引（依出現順序，不重複）。 */
export function synonymGroups(text: string): number[] {
  const t = toTraditional(text).toLowerCase();
  const out: number[] = [];
  SYNONYM_GROUPS.forEach((group, index) => { if (group.some(term => hasWord(t, term.toLowerCase()))) out.push(index); });
  return out;
}

/** 標準化鍵：第一個命中的同義詞組的標準詞；沒有就用主題加前兩個字。 */
export function keyOf(value: string, topic: TopicId): string {
  const groups = synonymGroups(value);
  if (groups.length) return SYNONYM_GROUPS[groups[0]!]![0]!;
  const compact = toTraditional(value).replace(/[\s\p{P}]/gu, "").replace(/^(不|沒|很|最|都|也|喜歡|討厭|不喜歡|愛)+/u, "");
  return `${topic}:${[...compact].slice(0, 4).join("") || "general"}`;
}

function kindOf(value: string): "preference" | "note" {
  return /(喜歡|討厭|愛|不吃|不喝|吃|喝|偏好|習慣|怕|要|不要|\blike\b|\blove\b|\bhate\b|\bprefer\b|\bdon't\b|\bdo not\b|\beat\b|\bdrink\b|\bavoid\b)/i.test(value) ? "preference" : "note";
}

function content(part: number, raw: string, todayFlag: boolean): ParsedSegment {
  let value = cleanValue(raw);
  let expires: "none" | "today" = todayFlag ? "today" : "none";
  if (/^今天[，,\s]*/.test(value) && value.length > 2) {
    value = value.replace(/^今天[，,\s]*/, "");
    expires = "today";
  }
  if (/^(?:just\s+)?for today[,:]?\s+/i.test(value)) {
    value = value.replace(/^(?:just\s+)?for today[,:]?\s+/i, "");
    expires = "today";
  }
  if (!value) return { op: "unclear", part, reason: "empty", value: "" };
  if (SENSITIVE.test(value) || LONG_NUMBER.test(value)) return { op: "rejected", part, reason: "sensitive" };
  if (QUOTE.test(value)) return { op: "rejected", part, reason: "quote" };
  if (JOKE.test(value)) return { op: "rejected", part, reason: "joke" };
  if (HYPOTHETICAL.test(value)) return { op: "rejected", part, reason: "hypothetical" };
  if (THIRD_SUBJECT.test(value) || EN_THIRD_SUBJECT.test(value) || EN_THIRD.test(value)) return { op: "rejected", part, reason: "third_party" };
  const stored = storedValue(value);
  if (ABOUT_ASSISTANT.test(stored)) return { op: "unclear", part, reason: "about_assistant", value: stored };
  if ([...stored].length > CLARIFY_CHARS) return { op: "unclear", part, reason: "too_long", value: [...stored].slice(0, MAX_VALUE_CHARS).join("") };
  if (/[?？]$|嗎$/.test(value) || /^(?:能|可以|可不可以|能不能)/.test(value)) return { op: "unclear", part, reason: "question", value: stored };
  if (UNCERTAIN.test(value)) return { op: "unclear", part, reason: "uncertain", value: stored };
  const topic = topicOf(stored);
  return { op: "remember", part, value: stored, topic, key: keyOf(stored, topic), kind: kindOf(stored), expires };
}

function target(op: "correct" | "forget", part: number, raw: string, text: string): ParsedSegment {
  const value = storedValue(cleanValue(raw));
  // 沒有明確目標（代名詞、問句）或原段太長（票證欄位上限）：一般聊天。
  if (!value || NOT_A_TARGET.test(value) || NOT_A_TARGET.test(cleanValue(raw)) || [...text].length > 400) return { op: "chat", part, text };
  if (op === "correct" && (SENSITIVE.test(value) || LONG_NUMBER.test(value))) return { op: "rejected", part, reason: "sensitive" };
  if (QUOTE.test(value)) return { op: "rejected", part, reason: "quote" };
  if (JOKE.test(value)) return { op: "rejected", part, reason: "joke" };
  if (HYPOTHETICAL.test(value)) return { op: "rejected", part, reason: "hypothetical" };
  if (THIRD_SUBJECT.test(value) || EN_THIRD_SUBJECT.test(value)) return { op: "rejected", part, reason: "third_party" };
  if ([...value].length > CLARIFY_CHARS) return { op: "unclear", part, reason: "too_long", value: [...value].slice(0, MAX_VALUE_CHARS).join("") };
  const topic = topicOf(value);
  return { op, part, value, topic, key: keyOf(value, topic), text };
}

function selfName(raw: string): string | null {
  const name = raw.trim();
  if (!name || [...name].length > 16 || NOT_A_NAME.test(name)) return null;
  if (/^[A-Za-z]/.test(name)) return /^[A-Z][A-Za-z'-]{0,30}(?:\s+[A-Z][A-Za-z'-]{0,30}){0,2}$/.test(name) ? name : null;
  // 中文名字最多 4 個字；不能有標點或數字。
  return /^[\p{Script=Han}]{1,4}$/u.test(name) ? name : null;
}

/** 一段（沒有句號的片段）。 */
function piece(part: number, raw: string): ParsedSegment[] {
  const text = raw.trim();
  if (!text) return [];
  if (FORGET_ALL.test(text)) return [{ op: "forget_all", part }];
  if (INSPECT.test(text.replace(/[?？]$/, ""))) return [{ op: "inspect", part }];
  const zhSelf = ZH_SELF.exec(text) ?? EN_SELF.exec(text);
  if (zhSelf) {
    const name = selfName(zhSelf[1]!);
    if (name) return [{ op: "self_id", part, name, text }];
  }
  const combined = SELF_REST.exec(text);
  if (combined) {
    const head = piece(part, combined[1]!);
    if (head.length === 1 && head[0]!.op === "self_id") return [head[0]!, ...piece(part + 1, combined[2]!)];
  }
  const asksToRemember = new RegExp(ZH_REMEMBER).test(text) || /\bremember\b/i.test(text);
  if (asksToRemember) {
    // 寫入前的全句檢查：誰說的、是不是引文、假設或玩笑。
    if (THIRD_HELPER.test(text) || THIRD_SPEAKER.test(text) || EN_THIRD.test(text) || /\b(?:remember (?:it|this) for (?:him|her|them))\b/i.test(text)) return [{ op: "rejected", part, reason: "third_party" }];
    if (QUOTE.test(text)) return [{ op: "rejected", part, reason: "quote" }];
    if (JOKE.test(text)) return [{ op: "rejected", part, reason: "joke" }];
    if (HYPOTHETICAL.test(text)) return [{ op: "rejected", part, reason: "hypothetical" }];
    if (SENSITIVE.test(text) || LONG_NUMBER.test(text)) return [{ op: "rejected", part, reason: "sensitive" }];
    const zhPrefix = ZH_REMEMBER_PREFIX.exec(text);
    // 「你記住了嗎」「記住了沒」是在問，不是指令。
    if (zhPrefix && /^(?:了|沒|嗎|吧|呢)/.test(zhPrefix[2]!)) return [{ op: "chat", part, text }];
    if (zhPrefix && zhPrefix[2]!.trim()) return [content(part, zhPrefix[2]!, !!zhPrefix[1])];
    const zhSuffix = ZH_REMEMBER_SUFFIX.exec(text);
    if (zhSuffix) return [content(part, zhSuffix[1]!, !!zhSuffix[2])];
    if (zhPrefix) return [content(part, "", !!zhPrefix[1])];
    const enPrefix = EN_REMEMBER_PREFIX.exec(text);
    if (enPrefix) return [content(part, enPrefix[2]!, !!enPrefix[1])];
    const enSuffix = EN_REMEMBER_SUFFIX.exec(text);
    if (enSuffix) return [content(part, enSuffix[1]!, !!enSuffix[2])];
    // 「記住」在句子中間（例如「你會記住嗎」）：不是明確指令，當一般聊天。
  }
  const forget = ZH_FORGET.exec(text) ?? EN_FORGET.exec(text);
  if (forget) return [target("forget", part, forget[1]!, text)];
  const correct = ZH_CORRECT_MEMORY.exec(text) ?? ZH_CORRECT_PREFIX.exec(text) ?? EN_CORRECT_PREFIX.exec(text);
  if (correct) return [target("correct", part, correct[1] ?? correct[2]!, text)];
  if (TEMPORARY.test(text)) return [{ op: "temporary", part, text }];
  return [{ op: "chat", part, text }];
}

/**
 * 整句解析。依句號、問號、驚嘆號、分號與換行切段，段內再處理「我是 X，記住…」與「…，記住」。
 * 回傳的 part 依序編號（issueParsed 用它對應同一段）。
 */
export function parseMemoryText(input: string): ParsedSegment[] {
  if (typeof input !== "string") return [];
  const text = input.replace(/　/g, " ").trim();
  if (!text || text.length > 2000) return text ? [{ op: "chat", part: 0, text }] : [];
  const pieces = text.split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/u).map(p => p.replace(/[。！!；;\n.]+$/u, "").trim()).filter(Boolean);
  const out: ParsedSegment[] = [];
  for (const raw of pieces) {
    // 「媽媽不喝咖啡，幫她記住」：逗號後面才是指令，整段一起判斷（piece 內的 THIRD_HELPER 會拒絕）。
    const segs = piece(out.length, raw);
    for (const seg of segs) out.push({ ...seg, part: out.length } as ParsedSegment);
  }
  return out;
}

/** 寫入段落的票證比對內容（boundary.issueParsed 用）：只含基本型別；scope 由澄清卡的選擇決定，呼叫端加入。 */
export function commandBodies(input: string): ({ op: string; part: number } & Record<string, string | number | boolean | null>)[] {
  return parseMemoryText(input).map(seg => ({ ...seg }) as { op: string; part: number } & Record<string, string | number | boolean | null>);
}

/** 給 chat 的文字：非記憶指令的段落依原順序接起來（含「今天不要…」這種只影響這次的要求）；沒有就回 null。 */
export function chatText(segments: readonly ParsedSegment[]): string | null {
  const parts = segments.filter((s): s is Extract<ParsedSegment, { op: "chat" | "temporary" }> => s.op === "chat" || s.op === "temporary").map(s => s.text);
  return parts.length ? parts.join("。") : null;
}

// ───────────── MEM-5b：工作決定（work_summary） ─────────────
// 明說「記住」而且內容是第一人稱、指著最近一次工作的決定：「記住這次選了方案 B」「記住我們剛剛決定用 Postgres」
// 「remember I chose plan B」「remember we decided to use Postgres」。只看 parse 已經接受的 remember 段落（第三人、引文、
// 假設、玩笑、敏感、不確定、問句都已在 content() 排除）；「記住今天…」（只到今天）不算。是不是真的要連到某個工作，由
// service.ts 的選擇卡讓使用者點選；這裡不知道有哪些工作。

const ZH_DECISION = /^(?:我們|我)?(?:這次|這一次|剛剛|剛才|上次|上一次)(?:我們|我)?(?:是)?(?:選了|選擇了|選擇|選|決定了|決定|採用了|採用|定了|用了|用)\s*\S/u;
/**
 * 審查 m1：不是決定的常見說法。「用了很久／一下」是時間長短；「這次用中文／英文」是這一次的回覆方式（交給一般記住）；
 * 「這次選了」沒有說選了什麼。
 * 只排除這幾個固定說法；其他漏網的（例如「剛剛用了很多錢」）仍會出選擇卡，使用者可以選「只記成一般筆記」。
 */
const ZH_NOT_DECISION = /(?:用了?|選了?)\s*(?:很久|好久|一下|一陣子|半天|很多次)|用\s*(?:中文|英文|日文|台語|國語)(?:回答|回覆|說)?$|(?:選擇|選|決定|採用|定|用)了?$/u;
// 英文：時間錨點（this time／just now／last time）或動詞後面的受詞都要有；used to（以前習慣）、picked up（接人、拿起）、
// 受詞是 nothing／anything／none 的不算。
const EN_DECISION = /^(?:(?:this time|just now|last time),?\s+)?(?:i|we)\s+(?:(?:just|finally)\s+)?(?:chose|picked(?!\s+up\b)|selected|decided(?:\s+on|\s+to)?|went with|settled on|opted for|used(?!\s+to\b))\s+(?!(?:(?:on|to)\s+)?(?:nothing|anything|none|it)\b)\S/i;

/**
 * 這個 remember 段落是不是「工作決定」（MEM-5b）：只認第一人稱的「這次／剛剛／上次＋選／決定／採用／定了／用」，不含今天有效的；
 * 審查 m2：parse 判成偏好（preference）的也不算，和旗標關閉時一樣交給一般記住（含衝突確認）。
 */
export function workDecision(seg: Extract<ParsedSegment, { op: "remember" }>): boolean {
  if (seg.expires !== "none" || seg.kind !== "note") return false;
  if (ZH_DECISION.test(seg.value)) return !ZH_NOT_DECISION.test(seg.value);
  return EN_DECISION.test(seg.value);
}

/** 句子看起來像在要求記住（給瀏覽器版或語音路徑判斷要不要提示「這裡沒有記憶」）。 */
export function looksLikeMemoryRequest(text: string): boolean {
  return parseMemoryText(text).some(s => s.op !== "chat" && s.op !== "temporary");
}
