// 頁面（src/realtime-tools.ts 的確認卡）與核心（server/live-tool-caller.ts 的確認語句判斷）共用。
// 外部動作的語音確認：只認固定語句，由確定性規則判斷，不交給模型轉述使用者的同意。
// 「確認」或「確定」後面要接動作（執行、寄出、發布…）；只說「好」「可以」「確認」都不算。
// 句中出現取消類詞語時一律視為拒絕（寧可不做也不誤做）。

export type ApprovalDecision = "approve" | "reject";

/** 取消類詞語；指令表的拒絕列由測試對照這份。 */
export const REJECT_WORDS = ["取消", "不要", "別", "算了", "停止", "不用", "不行", "不同意", "拒絕"] as const;
const REJECT = new RegExp(REJECT_WORDS.join("|"));
/** 「確認／確定」後面可以接的動作；指令表的確認列由測試對照這份。 */
export const APPROVE_VERBS = ["執行", "寄出", "送出", "寄送", "發送", "發布", "刪除", "付款", "購買", "下單", "建立", "新增", "修改", "更新"] as const;
const APPROVE = new RegExp(`(確認|確定)(${APPROVE_VERBS.join("|")})`);

/** 判斷一句話是否為確認或取消；都不是時回傳 null（確認卡繼續等待）。 */
export function matchApproval(text: string): ApprovalDecision | null {
  const t = text.replace(/[\s，。、！？!?,.「」『』"'：:；;]/g, "");
  if (!t) return null;
  if (REJECT.test(t)) return "reject";
  if (APPROVE.test(t)) return "approve";
  return null;
}

/** 整句是確認語句時可以有的開頭與結尾（「好，確認執行吧」）；中間不能有別的內容。 */
const LEAD = "(?:好的?|嗯|對|請)*";
const TAIL = "(?:吧|啦|了|喔|哦|囉|謝謝)*";
const EXACT_APPROVE = new RegExp(`^${LEAD}(?:確認|確定)(?:${APPROVE_VERBS.join("|")})${TAIL}$`);
const EXACT_REJECT = new RegExp(`^${LEAD}(?:${REJECT_WORDS.join("|")})(?:${["執行", ...APPROVE_VERBS].join("|")}|掉)?${TAIL}$`);

/**
 * 整句（去掉標點與空白）就是一句確認或取消（錨定比對）；句子裡還有別的請求時回傳 null。
 * 核心用它判斷一個交辦是不是在回答確認卡：「停止播放音樂」「不用開燈，查一下客廳溫度」是請求，不是答案。
 */
export function exactApproval(text: string): ApprovalDecision | null {
  const t = text.replace(/[\s，。、！？!?,.「」『』"'：:；;～~]/g, "");
  if (!t) return null;
  if (EXACT_REJECT.test(t)) return "reject";
  if (EXACT_APPROVE.test(t)) return "approve";
  return null;
}
