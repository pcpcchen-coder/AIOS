// 確認語句的規則搬到 shared/approval.ts，讓頁面的確認卡與核心的 LiveToolCaller 用同一套判斷。
export { APPROVE_VERBS, matchApproval, REJECT_WORDS, type ApprovalDecision } from "../shared/approval.ts";
