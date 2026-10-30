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
