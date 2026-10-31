import { ConverterFactory } from "opencc-js/core";
import cn from "opencc-js/from/cn";
import tw from "opencc-js/to/tw";
import STCharacters from "opencc-js/dict/STCharacters";
import TSCharacters from "opencc-js/dict/TSCharacters";
import { convertsLocale, makeTaiwanize, type Converter } from "./zh-tw.ts";

// 載入 OpenCC 字典（opencc-js 1.4.2，MIT AND Apache-2.0）並建立「簡體 → 台灣繁體」轉換（規則見 shared/zh-tw.ts）。
// 字典約 1 MB（STPhrases），建 trie 約 0.15 秒：第一次用到才建。核心靜態 import；頁面只在中文介面時動態 import（獨立 chunk）。

let converter: Converter | null = null;

/** 先把字典載入、建好 trie（約 0.15 秒），讓第一則逐字稿不必等。 */
export function warmTaiwan(): void {
  taiwanize("");
}

/** 不看語言：一律轉（呼叫端已確定是中文）。 */
export function taiwanize(text: string): string {
  converter ??= makeTaiwanize(ConverterFactory(cn, tw), STCharacters, TSCharacters);
  return converter(text);
}

/** 語音逐字稿（使用者或模型）：中文介面／語音語言才轉成台灣繁體；英文介面原樣。 */
export function taiwanTranscript(text: string, locale: string | null | undefined): string {
  return convertsLocale(locale) ? taiwanize(text) : text;
}
