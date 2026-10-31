// 語音逐字稿轉成台灣繁體（George 2026-10-31：「逐字稿為何是簡體字？幫我設定成台灣繁體！」）。
// 純函式：OpenCC 字典由呼叫端傳入（核心靜態載入、頁面動態載入，見 shared/zh-tw-opencc.ts），這裡只放規則，測試直接用。
//
// 規則（docs/validation/history-hist1-mac-2026-10-31.md、family-id-02-mac-2026-10-31.md 的 F1／F3／F11）：
//  1. 只在中文介面／語音語言時轉換；英文（locale en）一律原樣。打字的文字不經過這裡（呼叫端只轉語音辨識與模型逐字稿）。
//  2. 兩個訊號決定怎麼轉：
//     - 句子裡有「只存在於繁體」的字（OpenCC TSCharacters 的鍵、而且不是 STCharacters 的鍵，例如 這、們、說、條、裡；
//       另加 TRADITIONAL_FORMS）：
//       這是繁體或繁簡混雜的句子，只換「只存在於簡體」的字（STCharacters 的鍵、不在 SHARED_CHARS）；兩邊共用的字只在緊鄰
//       簡體字時（同一個簡體詞，例如 这里、面条）才換，其他保留（所以 里長、鄰里、余光中、范、朴、台、了 在繁體句子裡不會被改）。
//     - 沒有「只存在於繁體」的字（但有 STCharacters 的鍵或共用的字）：整句當簡體，用 OpenCC s2tw 轉（含詞組判斷：头发→頭髮、干净→乾淨、确定→確定）。
//       這時兩邊共用的字（SHARED_CHARS）也可能被改，例如沒有其他線索的「周末」→「週末」；下面三條減少誤改。
//  3. 不用 s2twp：它會改詞彙（软件→軟體、视频→影片、打开→開啟、保存→儲存），等於改寫使用者說的話，也會讓本機指令對不上。
//  4. 台灣日常寫法：OpenCC 依教育部字形把 台→臺、念→唸，這裡保留原字；了解→瞭解 改回「了解」（瞭望 不動）；
//     发布→發佈 改成「發布」（台灣標準，也是確認卡 shared/approval.ts 認的寫法）。
//  5. 姓名：「姓X」「叫X」「X先生／小姐／太太」的 X 是兩邊共用的字時保留原字（我叫余小明 不會變成 餘小明）。
//  6. 已經是繁體的輸出再轉一次不會再變（冪等）。

/** API key 路徑的語音辨識提示（中文才帶）；上游在雜音時偶爾把它當成逐字稿吐回來，見 isPromptEcho。 */
export const ZH_TW_TRANSCRIPTION_PROMPT = "以下是台灣繁體中文（正體字）的對話。";

/**
 * 繁體也照常使用的字：OpenCC 1.4.2 data/dictionary/STCharacters.txt 裡，候選字包含自己的鍵（203 個）。
 * opencc-js 的字典只留第一個候選，看不出這件事，所以從上游字典取出後固定在這裡（Apache-2.0；依賴說明見 prototype/ambient-shell/README.md 的「台灣繁體逐字稿」）。
 */
export const SHARED_CHARS =
  "㐹万丑丰了于云亘仆仇价仿伙余佛佣俊修借僵克党具冢冬准凌几凶出划刮制千升卜占卷厂厘只台叶吁吃合吊同后向吣呆周咨咸咽哄唇喂噪回困坐坯堤夫夸奸姜娘它家尸局岩岳巨布帘席干幸广庵弦彩征御志念恤愈愿戚扇才扎托扣折抵拐拿挂挨挽捆捍据搜斗斤斫旋昆暗曲札朱朴杆杠杯杰松板极果柜栗核梁棱檗欲沈沾泛注浚涂涌淀游溪漓澄焰熏狸玩琅璇症皂矩确硷私秋种穗筑筱糊系累耇胄背胜胡腊腌膻致舍芸苔苹范荐蒙蔑藤虫蚝蜡蝎表谷豆象跖辟适郁酸采里雇雕面";

/**
 * 同時是 STCharacters 與 TSCharacters 鍵的字（OpenCC 1.4.2 上游字典），也就是繁體裡也用的寫法，例如 什麽 的「麽」。
 * 當成「只存在於繁體」的訊號、不當簡體字轉。上游還有「么」「坏」兩個，它們是日常簡體（什么、坏了），所以不列。
 */
export const TRADITIONAL_FORMS = "麽緼苧藴輼醖";

/** 整句轉換時，OpenCC 換成教育部字形、台灣日常仍用原字的：輸入是左邊、轉出右邊時保留左邊。 */
export const TAIWAN_KEEP: Readonly<Record<string, string>> = { 台: "臺", 念: "唸" };

/** 整句轉換時的詞組修正：[輸入, s2tw 的輸出, 改成]（位置對齊才套用）。 */
export const TAIWAN_PHRASES: readonly (readonly [string, string, string])[] = [
  ["了解", "瞭解", "了解"],
  ["发布", "發佈", "發布"],
];

const SURNAME_BEFORE = new Set(["姓", "叫"]);
const SURNAME_AFTER = ["先生", "小姐", "太太"];

export type Converter = (text: string) => string;

/** 中文介面／語音語言才轉換（"en" 以外都是繁體中文介面）。 */
export function convertsLocale(locale: string | null | undefined): boolean {
  return locale !== "en";
}

const keysOf = (dict: string): Set<string> => new Set(dict.split("|").map((entry) => entry.split(" ")[0]!).filter(Boolean));

/**
 * 建立「簡體 → 台灣繁體」的轉換函式。
 * s2tw：OpenCC 的 cn → tw 轉換；stCharacters／tsCharacters：opencc-js 的 STCharacters／TSCharacters 字典字串（"简 簡|…"）。
 */
export function makeTaiwanize(s2tw: Converter, stCharacters: string, tsCharacters: string): Converter {
  const shared = new Set(SHARED_CHARS);
  const stKeys = keysOf(stCharacters);
  const forms = new Set(TRADITIONAL_FORMS);
  const simplifiedOnly = new Set([...stKeys].filter((ch) => !shared.has(ch) && !forms.has(ch)));
  const traditionalOnly = new Set([...[...keysOf(tsCharacters)].filter((ch) => !stKeys.has(ch)), ...forms]);
  return (text: string): string => {
    const input = [...text];
    let convertible = false;
    let simplified = false;
    let traditional = false;
    for (const ch of input) {
      if (stKeys.has(ch) || shared.has(ch)) convertible = true;
      if (simplifiedOnly.has(ch)) simplified = true;
      if (traditionalOnly.has(ch)) traditional = true;
    }
    if (!convertible || (traditional && !simplified)) return text;
    let output = [...s2tw(text)];
    // 詞組轉換改變長度（少見）：退回逐字轉換，好讓下面能逐字對齊。
    if (output.length !== input.length) output = input.map((ch) => (stKeys.has(ch) ? s2tw(ch) : ch));
    const surname = (i: number) => SURNAME_BEFORE.has(input[i - 1] ?? "") || SURNAME_AFTER.some((w) => input.slice(i + 1, i + 1 + w.length).join("") === w);
    if (traditional) {
      // 繁簡混雜：換只存在於簡體的字（用整句轉換的結果，保留詞組判斷）；共用的字只在緊鄰簡體字、屬於同一個簡體詞時才換
      // （这里→這裡、面条→麵條），其他保留（鄰里、余光中、了解、台中）。
      const nearSimplified = (i: number) => simplifiedOnly.has(input[i - 1] ?? "") || simplifiedOnly.has(input[i + 1] ?? "");
      return input.map((ch, i) => {
        if (simplifiedOnly.has(ch)) return output[i]!;
        if (shared.has(ch) && nearSimplified(i) && !surname(i) && TAIWAN_KEEP[ch] !== output[i]) return output[i]!;
        return ch;
      }).join("");
    }
    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;
      if (TAIWAN_KEEP[ch] === output[i]) output[i] = ch;
      if (shared.has(ch) && surname(i)) output[i] = ch;
    }
    for (const [from, converted, to] of TAIWAN_PHRASES) {
      const f = [...from], c = [...converted], t = [...to];
      for (let i = 0; i + f.length <= input.length; i++) {
        if (f.every((x, k) => input[i + k] === x) && c.every((x, k) => output[i + k] === x)) t.forEach((x, k) => { output[i + k] = x; });
      }
    }
    return output.join("");
  };
}

const PROMPT_NORM = /[\s\p{P}\p{S}]/gu;

/**
 * 上游語音辨識在雜音時把 prompt 本身當逐字稿吐回來（已轉成繁體後判斷）：等於 prompt，或以 prompt 開頭，
 * 或是 prompt 的前段（至少 6 個字）。這種逐字稿要丟掉，不當成使用者說的話。
 */
export function isPromptEcho(text: string): boolean {
  const heard = text.replace(PROMPT_NORM, "");
  const prompt = ZH_TW_TRANSCRIPTION_PROMPT.replace(PROMPT_NORM, "");
  if (!heard) return false;
  return heard.startsWith(prompt) || ([...heard].length >= 6 && prompt.startsWith(heard));
}
