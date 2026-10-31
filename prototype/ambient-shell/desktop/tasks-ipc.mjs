// MEM-4a：加密保存任務的 IPC 過濾（純函式，不載入 Electron；tests/tasks-ipc.test.ts 直接測）。
// 核心（server/task-ipc.ts）持有資料與規則；這裡只做 op 白名單與每個 op 允許的欄位與型別（多的欄位丟掉）。
// 發送者檢查沿用 desktop/trusted-sender.mjs（主視窗主框架、頁面來自本機核心）。

/** 與 shared/protected-tasks.ts 的 TASK_OPS 相同（測試對照）。 */
export const TASK_OPS = ["status", "list", "get", "search", "redo", "delete_backups", "voice_tasks", "card_title", "card_delegate"];

const TASK = /^task_[0-9a-f-]{36}$/;
const REQUEST = /^req_[A-Za-z0-9_-]{6,64}$/;
const CARD = /^dc_[0-9a-f]{24}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["", "succeeded", "failed", "cancelled", "running", "queued", "cancelling"];
const MODES = ["", "claude", "chatgpt", "mock"];

/** 白名單與形狀。成功回 { ok: true, request }（只含允許的欄位），否則 { ok: false, error }。 */
export function validateTasksRequest(req) {
  const bad = (error) => ({ ok: false, error });
  if (!req || typeof req !== "object" || Array.isArray(req)) return bad("request must be an object");
  const op = req.op;
  if (!TASK_OPS.includes(op)) return bad("unknown op");
  if (req.all !== undefined && typeof req.all !== "boolean") return bad("all must be a boolean");
  const all = req.all === true ? { all: true } : {};
  switch (op) {
    case "status":
    case "delete_backups":
      return { ok: true, request: { op } };
    case "list":
      return { ok: true, request: { op, ...all } };
    case "voice_tasks":
      if (req.route !== "live" && req.route !== "api_key") return bad("route must be live or api_key");
      return { ok: true, request: { op, route: req.route } };
    case "card_title":
      if (typeof req.card !== "string" || !CARD.test(req.card)) return bad("card is required");
      return { ok: true, request: { op, card: req.card } };
    case "card_delegate":
      if (typeof req.card !== "string" || !CARD.test(req.card)) return bad("card is required");
      if (typeof req.request_id !== "string" || !REQUEST.test(req.request_id)) return bad("request_id is required");
      return { ok: true, request: { op, card: req.card, request_id: req.request_id } };
    case "get":
      if (typeof req.task_id !== "string" || !TASK.test(req.task_id)) return bad("task_id is required");
      return { ok: true, request: { op, task_id: req.task_id, ...all } };
    case "redo":
      if (typeof req.task_id !== "string" || !TASK.test(req.task_id)) return bad("task_id is required");
      if (typeof req.request_id !== "string" || !REQUEST.test(req.request_id)) return bad("request_id is required");
      return { ok: true, request: { op, task_id: req.task_id, request_id: req.request_id, ...all } };
    case "search": {
      const q = req.query;
      if (!q || typeof q !== "object" || Array.isArray(q)) return bad("query is required");
      const query = {};
      if (q.q !== undefined) { if (typeof q.q !== "string" || q.q.length > 200) return bad("q is invalid"); query.q = q.q; }
      if (q.status !== undefined) { if (!STATUSES.includes(q.status)) return bad("status is invalid"); query.status = q.status; }
      if (q.mode !== undefined) { if (!MODES.includes(q.mode)) return bad("mode is invalid"); query.mode = q.mode; }
      for (const key of ["from", "to"]) {
        if (q[key] !== undefined && q[key] !== "") { if (typeof q[key] !== "string" || !DATE.test(q[key])) return bad(`${key} is invalid`); query[key] = q[key]; }
      }
      if (q.cursor !== undefined && q.cursor !== null) { if (typeof q.cursor !== "string" || !/^\d{1,6}$/.test(q.cursor)) return bad("cursor is invalid"); query.cursor = q.cursor; }
      if (q.limit !== undefined) { if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 50) return bad("limit is invalid"); query.limit = q.limit; }
      return { ok: true, request: { op, query, ...all } };
    }
    default:
      return bad("unknown op");
  }
}

// HIST-1 Mac 驗收 F4：成果紀錄「刪除」的原生確認。window.confirm 在 Electron 裡的按鈕固定是系統的「Cancel／OK」，
// 不能換成「取消／刪除」，所以改由主程序用 dialog.showMessageBox 問（按鈕經共用翻譯表）。頁面只送要顯示的標題；
// 刪除本身仍走 HTTP（只有任務 ID）。主程序先檢查發送者（主視窗主框架、來自本機核心頁面），對話框按「取消」或關掉就不刪。

const MAX_TITLE = 500;

/** nous:confirm-delete 的形狀過濾：目前只有 kind task（成果紀錄的一筆任務）。多的欄位丟掉。 */
export function validateConfirmDeleteRequest(req) {
  const bad = (error) => ({ ok: false, error });
  if (!req || typeof req !== "object" || Array.isArray(req)) return bad("request must be an object");
  if (req.kind !== "task") return bad("unknown kind");
  if (typeof req.title !== "string") return bad("title is required");
  // 控制字元、雙向文字控制字元（U+200E、U+200F、U+202A–U+202E、U+2066–U+2069）與行／段分隔字元（U+2028、U+2029）
  // 換成空白（對話框的文字不能被倒排或斷行偽裝）；去掉頭尾空白後是空的就拒絕；依碼位截斷（不切開 emoji 的代理對）。
  const cleaned = req.title.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+/g, " ").trim();
  if (cleaned.length === 0) return bad("title is required");
  const title = [...cleaned].slice(0, MAX_TITLE).join("");
  return { ok: true, request: { kind: "task", title } };
}

/**
 * 原生對話框的選項（中文原文；主程序的 showMessage 經 localizeDialog 依目前語言翻譯按鈕與文字）。
 * 「刪除」在前、「取消」是預設與取消鍵（按 Esc 或關掉對話框都等於取消）。
 */
export function deleteTaskDialog(title, translate = (source, ...values) => values.reduce((text, value, i) => text.replace(`{${i}}`, value), source)) {
  return {
    type: "warning",
    buttons: ["刪除", "取消"],
    defaultId: 1,
    cancelId: 1,
    message: translate("要永久刪除「{0}」這筆任務與它的成果嗎？", title),
    detail: translate("刪除後無法復原。"),
  };
}

/** 對話框的回應：只有按了第一個按鈕（刪除）才是 true。 */
export function deleteConfirmed(result) {
  return !!result && result.response === 0;
}
