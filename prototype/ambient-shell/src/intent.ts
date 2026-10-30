// 本機、確定性的指令判斷：只有短句且符合固定語彙時才當成控制指令，
// 其餘一律視為「交辦任務」。不用模型猜測，避免把交辦內容誤當成控制動作。

export type Intent =
  | { kind: "empty" }
  | { kind: "dismiss" }
  | { kind: "stop" }
  | { kind: "progress" }
  | { kind: "result" }
  /** 成果紀錄（HIST-1）：搜尋過去的任務與成果；query 可以是空字串（列出全部）。 */
  | { kind: "history"; query: string }
  | { kind: "voice_on" }
  | { kind: "voice_off" }
  | { kind: "settings" }
  | { kind: "use_provider"; provider: "claude" | "chatgpt" | "mock" }
  | { kind: "task"; text: string };

const MAX_COMMAND_CHARS = 14;
const POLITE_PREFIX = /^(請你?|麻煩你?|幫我|可以|能不能|我想|我要)+/;
const TRAILING = /[\s，,。.!！?？~～…]+$/;
const LEADING = /^[\s，,。.!！?？~～…]+/;

const VOICE_ON = /^(開啟|打開|啟動|進入|開)?語音(模式|對話|互動)$/;
const VOICE_OFF = /^((關閉|關掉|結束|離開|退出|停止)語音(模式|對話|互動)?|語音(模式)?(關閉|關掉))$/;
const SETTINGS = /^(設定|打開設定|開啟設定|切換(引擎|模型|AI)|(AI )?引擎(設定)?|模型設定|(打開|開啟)?鏡頭設定|登入 ?ChatGPT|ChatGPT 登入|settings)$/i;
const USE_PROVIDER = /^(改用|使用|切換到|換成|用)\s*(ChatGPT|GPT|Claude|模擬模式|模擬)(引擎|模式)?$/i;
const DISMISS = /^(收起(來)?(吧)?|回(到)?桌布(吧)?|關閉(畫面|視窗)?|隱藏|先這樣|close|dismiss|hide)$/i;
const STOP = /^((停止|取消|中止|終止)(這個|那個|目前的|剛才的)?(任務|工作)?|不要做了|別做了|stop|cancel)$/i;
const PROGRESS = /(進度|做到哪|做得怎樣|怎麼樣了|好了沒|完成了沒|完成了嗎|狀態|狀況|進展|progress|status)/i;
const RESULT = /(成果|結果|剛才那份|剛剛那份|上一份|那份報告|拿出來|給我看)/;
// 含這些動詞的句子是在交辦工作，即使提到「進度」「結果」也不是查詢。
const TASK_VERB = /(寫|撰寫|整理|規劃|分析|產生|擬定|草擬|設計|翻譯|計算|比較|列出|建立|製作|準備|研究|摘要|總結|做一份)/;

// 成果紀錄：明確說「搜尋成果」「成果紀錄」或「找之前（做過）…的成果」才算；只說「成果」「看結果」仍是打開最近一份（result）。
// 不受 14 字限制（查詢詞可以長），但要以這些固定說法開頭或結尾；查詢詞像是在交辦工作（然後、幫我、整理成一份…）就不算。
// 「結果」只在說了「做過／交辦過」時才算成果紀錄：「查詢之前的考試結果」「搜尋之前的比賽結果」是一般問題，不是成果紀錄。
const HISTORY_ONLY = /^(?:打開|開啟|顯示|看|找|搜尋|查)?(?:一下)?(?:成果紀錄|成果記錄|成果歷史|全部成果|所有成果|搜尋全部成果|搜尋所有成果|搜尋成果|找成果|過去的成果|之前的成果|以前的成果)$/;
const HISTORY_VERB = "(?:搜尋|搜索|查找|查詢|找)(?:一下)?";
const HISTORY_PREFIX = new RegExp(`^${HISTORY_VERB}(?:全部|所有|過去|之前|以前|先前)?(?:的)?成果(?:紀錄|記錄)?(?:(?:裡|中)(?:有沒有|有沒|有|關於|有關|提到)?[：:，,、\\s]*|[：:，,、\\s]+|關於|有關)(.+)$`);
const HISTORY_ABOUT = new RegExp(`^${HISTORY_VERB}(?:之前|以前|過去|先前|上次)(?:做過|交辦過|做的|交辦的)?(?:的)?(?:關於|有關)?(.+?)(?:的|相關的)?成果(?:紀錄|記錄)?$`);
const HISTORY_DONE = new RegExp(`^${HISTORY_VERB}(?:之前|以前|過去|先前|上次)(?:做過|交辦過)(?:的)?(?:關於|有關)?(.+?)(?:的|相關的)?結果$`);
/** 查詢詞裡出現這些，表示整句是在交辦工作，不是搜尋。 */
const HISTORY_NOT_QUERY = /(然後|接著|並且|之後再|再幫|再寫|再做|幫我|替我|請你|一份|(?:寫|做|整理|製作|產生|草擬|擬定|翻譯|摘要|總結)成)/;
const EN_HISTORY_ONLY = /^(?:(?:open |show )?(?:results|work) history|search (?:all |my |past |previous |earlier )*results|(?:show|find) (?:all |my |past |previous |earlier )+results)$/i;
// 英文要有 my／past／previous 等字（"search results for flights to Tokyo" 是一般問題）。
const EN_HISTORY_QUERY = /^(?:(?:search|find) (?:all )?(?:my|past|previous|earlier|old)(?: (?:past|previous|earlier|old))? (?:results|work|artifacts)(?: history)?(?: for| about| on)?|search (?:results|work) history for)\s+(.+)$/i;
const EN_NOT_QUERY = /\b(?:and then|then (?:write|make|draft)|write|draft|summari[sz]e)\b/i;

/** 成果紀錄的說法與查詢詞；不是就回 null。 */
export function matchHistory(text: string): string | null {
  const trimmed = text.replace(TRAILING, "").replace(LEADING, "").trim();
  if (/^[\x00-\x7F]+$/.test(trimmed)) {
    const english = trimmed.replace(/^please\s+/i, "").replace(/\s+/g, " ");
    if (EN_HISTORY_ONLY.test(english)) return "";
    const q = EN_HISTORY_QUERY.exec(english);
    if (!q || EN_NOT_QUERY.test(q[1]!)) return null;
    return cleanQuery(q[1]!);
  }
  const command = trimmed.replace(POLITE_PREFIX, "").trim();
  if (HISTORY_ONLY.test(command)) return "";
  const match = HISTORY_PREFIX.exec(command) ?? HISTORY_ABOUT.exec(command) ?? HISTORY_DONE.exec(command);
  if (!match) return null;
  const query = cleanQuery(match[1]!);
  return HISTORY_NOT_QUERY.test(query) ? null : query;
}

function cleanQuery(text: string): string {
  return text.replace(/^[「『"“'‘\s]+|[」』"”'’\s]+$/g, "").replace(/(?:嗎|呢)$/, "").replace(/^的+|的+$/g, "").trim();
}

export function normalizeCommand(text: string): string {
  return text.replace(TRAILING, "").replace(LEADING, "").replace(POLITE_PREFIX, "").trim();
}

const ENGLISH_COMMANDS: readonly [RegExp, Intent][] = [
  [/^(?:open )?(?:settings|camera settings|engine settings)$/i, { kind: "settings" }],
  [/^(?:show |view )?(?:progress|status|task progress)$/i, { kind: "progress" }],
  [/^(?:show |view )?(?:results?|latest results?)$/i, { kind: "result" }],
  [/^(?:stop|cancel)(?: (?:the )?task)?$/i, { kind: "stop" }],
  [/^(?:dismiss|hide|close)(?: (?:the )?(?:view|window))?$/i, { kind: "dismiss" }],
  [/^(?:voice on|(?:turn on|enable|start) voice(?: mode| conversation)?)$/i, { kind: "voice_on" }],
  [/^(?:voice off|(?:turn off|disable|end|stop) voice(?: mode| conversation)?)$/i, { kind: "voice_off" }],
];

export function classify(input: string): Intent {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const history = matchHistory(text);
  if (history !== null) return { kind: "history", query: history };
  const english = text.replace(/[.!?]+$/, "").trim().replace(/^please\s+/i, "").replace(/\s+/g, " ");
  if (/^[\x00-\x7F]+$/.test(english)) {
    const provider = /^(?:use|switch to) (claude|chatgpt|gpt|mock(?: mode)?)$/i.exec(english);
    if (provider) return { kind: "use_provider", provider: provider[1]!.toLowerCase() === "claude" ? "claude" : provider[1]!.toLowerCase().startsWith("mock") ? "mock" : "chatgpt" };
    const matched = ENGLISH_COMMANDS.find(([pattern]) => pattern.test(english));
    return matched ? { ...matched[1] } : { kind: "task", text };
  }
  const command = normalizeCommand(text);
  if (command.length <= MAX_COMMAND_CHARS && !TASK_VERB.test(command)) {
    if (VOICE_OFF.test(command)) return { kind: "voice_off" };
    if (VOICE_ON.test(command)) return { kind: "voice_on" };
    const use = command.match(USE_PROVIDER);
    if (use) {
      const name = use[2].toLowerCase();
      const provider = name === "claude" ? "claude" : name.startsWith("模擬") ? "mock" : "chatgpt";
      return { kind: "use_provider", provider };
    }
    if (SETTINGS.test(command)) return { kind: "settings" };
    if (DISMISS.test(command)) return { kind: "dismiss" };
    if (STOP.test(command)) return { kind: "stop" };
    if (PROGRESS.test(command)) return { kind: "progress" };
    if (RESULT.test(command)) return { kind: "result" };
  }
  return { kind: "task", text };
}

/** 「設定」類說法指的是哪一塊：鏡頭（「鏡頭設定」）、引擎（「切換引擎」「模型設定」）或一般（「設定」「登入 ChatGPT」）。 */
export type SettingsTopic = "camera" | "engine" | "general";

export function settingsTopic(input: string): SettingsTopic {
  const command = normalizeCommand(input.trim());
  if (/鏡頭|camera/i.test(command)) return "camera";
  if (/引擎|模型|AI|engine|model/i.test(command)) return "engine";
  return "general";
}

/**
 * 打開設定畫面時說的話（字幕與語音模式的播報）。瀏覽器版是完整的設定畫面；macOS App（desktop）的設定頁只有
 * 帳號與登入，其他設定在選單列，所以照實指出在選單列的哪裡。
 */
export function settingsReply(input: string, ctx: { desktop: boolean; cameraEnabled: boolean }): string {
  if (!ctx.desktop) return ctx.cameraEnabled ? "這是 AI 引擎與鏡頭設定。" : "這是 AI 引擎設定。";
  const topic = settingsTopic(input);
  if (topic === "camera") return "這是帳號與登入；鏡頭設定在選單列 Nous 圖示的「鏡頭與語音設定」。";
  if (topic === "engine") return "這是帳號與登入；切換引擎在選單列 Nous 圖示的「AI 引擎」。";
  return "這是帳號與登入；鏡頭、秒數與引擎在選單列的 Nous 圖示裡。";
}
