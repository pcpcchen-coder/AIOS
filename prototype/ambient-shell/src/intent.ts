// 本機、確定性的指令判斷：只有短句且符合固定語彙時才當成控制指令，
// 其餘一律視為「交辦任務」。不用模型猜測，避免把交辦內容誤當成控制動作。

export type Intent =
  | { kind: "empty" }
  | { kind: "dismiss" }
  | { kind: "stop" }
  | { kind: "progress" }
  | { kind: "result" }
  | { kind: "task"; text: string };

const MAX_COMMAND_CHARS = 14;
const POLITE_PREFIX = /^(請你?|麻煩你?|幫我|可以|能不能|我想|我要)+/;
const TRAILING = /[\s，,。.!！?？~～…]+$/;
const LEADING = /^[\s，,。.!！?？~～…]+/;

const DISMISS = /^(收起(來)?(吧)?|回(到)?桌布(吧)?|關閉(畫面|視窗)?|隱藏|先這樣|close|dismiss|hide)$/i;
const STOP = /^((停止|取消|中止|終止)(這個|那個|目前的|剛才的)?(任務|工作)?|不要做了|別做了|stop|cancel)$/i;
const PROGRESS = /(進度|做到哪|做得怎樣|怎麼樣了|好了沒|完成了沒|完成了嗎|狀態|狀況|進展|progress|status)/i;
const RESULT = /(成果|結果|剛才那份|剛剛那份|上一份|那份報告|拿出來|給我看)/;
// 含這些動詞的句子是在交辦工作，即使提到「進度」「結果」也不是查詢。
const TASK_VERB = /(寫|撰寫|整理|規劃|分析|產生|擬|設計|翻譯|計算|比較|列出|建立|製作|準備|研究|摘要|總結|做一份)/;

export function normalizeCommand(text: string): string {
  return text.replace(TRAILING, "").replace(LEADING, "").replace(POLITE_PREFIX, "").trim();
}

export function classify(input: string): Intent {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const command = normalizeCommand(text);
  if (command.length <= MAX_COMMAND_CHARS && !TASK_VERB.test(command)) {
    if (DISMISS.test(command)) return { kind: "dismiss" };
    if (STOP.test(command)) return { kind: "stop" };
    if (PROGRESS.test(command)) return { kind: "progress" };
    if (RESULT.test(command)) return { kind: "result" };
  }
  return { kind: "task", text };
}
