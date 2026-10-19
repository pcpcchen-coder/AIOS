// 插話與回音判斷（純函式）：喇叭念出的話也會被麥克風收到並辨識成文字，
// 所以要分辨「這是 Nous 自己的聲音」還是「使用者開口插話」。
// 比對辨識文字與正在念的文字：大多數字都出現在念的內容裡就當回音。

const IGNORED = /[\s，,。.!！?？、；;：:「」『』（）()…~～"'\-—]/gu;

export function normalizeSpeech(text: string): string {
  return text.replace(IGNORED, "").toLowerCase();
}

/** 聽到的文字中，有幾個字沒有出現在念出的內容裡。 */
export function novelChars(heard: string, spoken: string): number {
  const vocab = new Set(normalizeSpeech(spoken));
  let count = 0;
  for (const ch of normalizeSpeech(heard)) if (!vocab.has(ch)) count += 1;
  return count;
}

/** 聽到的內容是否大致就是正在念的話（回音）。 */
export function isLikelyEcho(heard: string, spoken: string): boolean {
  const h = normalizeSpeech(heard);
  if (!h) return true;
  if (!normalizeSpeech(spoken)) return false;
  return novelChars(heard, spoken) < Math.max(2, Math.ceil(h.length * 0.34));
}

/** 插話時辨識結果常以回音開頭；去掉開頭那段（至少兩個字都在念的內容裡才去掉）。 */
export function stripEcho(heard: string, spoken: string): string {
  const vocab = new Set(normalizeSpeech(spoken));
  const chars = [...heard];
  let cut = 0;
  let matched = 0;
  while (cut < chars.length) {
    const c = chars[cut];
    if (normalizeSpeech(c) === "") {
      cut += 1;
      continue;
    }
    if (!vocab.has(c.toLowerCase())) break;
    matched += 1;
    cut += 1;
  }
  if (matched < 2) return heard.trim();
  return chars.slice(cut).join("").trim();
}

const STOP_WORDS = ["停", "停停", "停一下", "暫停", "先停", "等等", "等一下", "等一等", "stop", "wait"];

/** 「停」「等一下」這類插話詞：即使很短、即使字剛好出現在念的內容裡，也要立刻打斷。 */
export function isStopWord(heard: string): boolean {
  const h = normalizeSpeech(heard);
  return STOP_WORDS.some((w) => h === w || h.startsWith(w));
}

/** 回音判斷的最短長度：念完之後的短回應（「好」「對」「你好」）一律當成使用者說的話。 */
export const MIN_ECHO_LENGTH_AFTER_SPEECH = 4;

/** 把串流文字切成可以逐句念的片段；太長的句子在逗號處先切。 */
export function takeSentences(buffer: string, maxLength = 40): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = /[。！？!?；;\n]/u.exec(rest);
    if (match) {
      const s = rest.slice(0, match.index + 1).trim();
      rest = rest.slice(match.index + 1);
      if (normalizeSpeech(s)) sentences.push(s);
      continue;
    }
    if (rest.length > maxLength) {
      const comma = Math.max(rest.lastIndexOf("，"), rest.lastIndexOf(","));
      if (comma > 0) {
        const s = rest.slice(0, comma + 1).trim();
        rest = rest.slice(comma + 1);
        if (normalizeSpeech(s)) sentences.push(s);
        continue;
      }
    }
    break;
  }
  return { sentences, rest };
}
