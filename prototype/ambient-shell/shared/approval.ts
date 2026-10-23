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
