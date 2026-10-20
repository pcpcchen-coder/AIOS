// 腦區對應：語言區、數理區、藝術區。
// 電子腦上亮起的區域代表「目前處理的內容類型」——任務步驟由 AI 規劃時標記的領域，
// 或依關鍵字判斷的對話主題；不是模型內部神經活動的視覺化。

export type Domain = "language" | "math" | "art";

export const DOMAINS: readonly Domain[] = ["language", "math", "art"];

export const DOMAIN_LABEL: Record<Domain, string> = {
  language: "語言區",
  math: "數理區",
  art: "藝術區",
};

const KEYWORDS: Record<Domain, RegExp> = {
  math: /(計算|算|數學|統計|數據|資料分析|分析|比較|預算|成本|價格|金額|費用|百分比|%|公式|方程|機率|邏輯|推理|程式|程式碼|code|excel|試算表|財務|報表|數字|加總|平均|估算|排程|時程|效率|單位|換算|\d)/giu,
  art: /(設計|畫|繪|插畫|圖像|顏色|配色|色彩|風格|美術|藝術|音樂|歌|曲|詩|創作|故事|小說|劇本|影片|攝影|照片|logo|海報|裝潢|穿搭|創意|靈感|視覺|排版)/giu,
  language: /(寫|撰寫|翻譯|摘要|總結|整理|文章|報告|信件|寫信|email|郵件|文案|說明|解釋|回覆|簡報|大綱|校對|潤飾|句子|語言|英文|日文|中文|閱讀|對話|聊天|問答|講|說)/giu,
};

/** 同分時的優先順序：較具體的領域優先。 */
const TIE_ORDER: readonly Domain[] = ["art", "math", "language"];

/** 依關鍵字判斷文字主要屬於哪個領域；沒有線索時回傳 null（不亂點亮）。 */
export function classifyDomain(text: string): Domain | null {
  let best: Domain | null = null;
  let bestScore = 0;
  for (const d of TIE_ORDER) {
    const score = text.match(KEYWORDS[d])?.length ?? 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function isDomain(value: unknown): value is Domain {
  return value === "language" || value === "math" || value === "art";
}
