// 記憶層的 IPC 過濾（純函式，不載入 Electron；tests/memory-ipc.test.ts 直接測）。
// 架構（docs/16 §9）：核心（server/memory/service.ts）持有資料與規則，IPC 只做傳輸。這裡只做三件事：
//   1. 發送者必須是主視窗的主框架、頁面來自本機核心（desktop/trusted-sender.mjs，與家人辨識共用）；
//   2. op 白名單與每個 op 允許的欄位與型別（多的欄位丟掉）；語意驗證（人物、版本、同意、票證）由核心負責；
//   3. 選單列「記憶…」的點擊時間窗：只有點擊後 10 秒內，list 的 manage 才算使用者打開記憶管理（一次有效）。
// 刪除人物記憶、全部忘記與連結家人辨識的原生確認由核心呼叫主程序的 confirm（頁面無法偽造）。

/** 與 shared/memory.ts 的 MEMORY_OPS 相同（測試對照）。 */
export const MEMORY_OPS = ["status", "setup", "turn", "card_answer", "card_view", "select", "suspend", "list", "receipt", "edit", "forget", "pin", "profile_delete", "link_face", "profile_minor", "suggestions"];

const PROFILE = /^profile_[a-f0-9]{16}$/;
const FACT = /^mem_[a-f0-9]{16}$/;
const CARD = /^mc_[a-f0-9]{24}$/;
const TOKEN = /^mm_[a-f0-9]{32}$/;
const REQUEST = /^req_[A-Za-z0-9_-]{6,64}$/;
const OPERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PERSON = /^fam_[0-9a-f]{24}$/;
// MEM-3：openai_realtime（OpenAI API key 即時語音）的同意鍵含底線。
const PROVIDER = /^[a-z][a-z_]{0,19}$/;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const CHOICES = ["save", "household", "cancel", "create", "select", "accept", "decline", "confirm"];

const isString = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const isRevision = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const optionalToken = (req, out) => {
  if (req.token === undefined) return true;
  if (typeof req.token !== "string" || !TOKEN.test(req.token)) return false;
  out.token = req.token;
  return true;
};

/** 白名單與形狀。成功回 { ok: true, request }（只含允許的欄位），否則 { ok: false, error }。 */
export function validateMemoryRequest(req) {
  const bad = (error) => ({ ok: false, error });
  if (!req || typeof req !== "object" || Array.isArray(req)) return bad("request must be an object");
  const op = req.op;
  if (!MEMORY_OPS.includes(op)) return bad("unknown op");
  switch (op) {
    case "status":
      return { ok: true, request: { op } };
    case "turn":
      if (!isString(req.text, 2000)) return bad("text is required");
      if (typeof req.request_id !== "string" || !REQUEST.test(req.request_id)) return bad("request_id is required");
      return { ok: true, request: { op, text: req.text, request_id: req.request_id } };
    case "setup": {
      if (typeof req.enabled !== "boolean") return bad("enabled must be a boolean");
      const s = req.subject;
      let subject;
      if (s && s.kind === "household") subject = { kind: "household" };
      else if (s && s.kind === "profile" && typeof s.profile === "string" && PROFILE.test(s.profile)) subject = { kind: "profile", profile: s.profile };
      else if (s && s.kind === "name" && isString(s.name, 16)) subject = { kind: "name", name: s.name };
      else return bad("subject must be household, a profile or a name");
      if (!Array.isArray(req.allow) || req.allow.length > 8) return bad("allow must be a list");
      const allow = [];
      for (const a of req.allow) {
        if (!a || typeof a !== "object" || typeof a.provider !== "string" || !PROVIDER.test(a.provider) || typeof a.account !== "string" || !ACCOUNT.test(a.account)) return bad("allow entries need provider and account");
        allow.push({ provider: a.provider, account: a.account });
      }
      const request = { op, enabled: req.enabled, subject, allow };
      if (req.card !== undefined) {
        if (typeof req.card !== "string" || !CARD.test(req.card)) return bad("card is invalid");
        request.card = req.card;
      }
      if (!optionalToken(req, request)) return bad("token is invalid");
      return { ok: true, request };
    }
    case "card_answer": {
      if (typeof req.card !== "string" || !CARD.test(req.card)) return bad("card is required");
      if (!CHOICES.includes(req.choice)) return bad("choice is invalid");
      const request = { op, card: req.card, choice: req.choice };
      if (req.profile !== undefined) {
        if (typeof req.profile !== "string" || !PROFILE.test(req.profile)) return bad("profile is invalid");
        request.profile = req.profile;
      }
      if (req.fact !== undefined) {
        if (typeof req.fact !== "string" || !FACT.test(req.fact)) return bad("fact is invalid");
        request.fact = req.fact;
      }
      if (req.allow !== undefined) {
        if (typeof req.allow !== "boolean") return bad("allow must be a boolean");
        request.allow = req.allow;
      }
      return { ok: true, request };
    }
    case "card_view":
      // MEM-2：SSE 只送卡片 ID；內容只經這個 op 給可信主視窗。
      if (typeof req.card !== "string" || !CARD.test(req.card)) return bad("card is required");
      return { ok: true, request: { op, card: req.card } };
    case "select": {
      if (req.profile !== null && !(typeof req.profile === "string" && PROFILE.test(req.profile))) return bad("profile must be a profile id or null");
      const request = { op, profile: req.profile };
      if (req.card !== undefined) {
        if (typeof req.card !== "string" || !CARD.test(req.card)) return bad("card is invalid");
        request.card = req.card;
      }
      if (!optionalToken(req, request)) return bad("token is invalid");
      return { ok: true, request };
    }
    case "suspend":
      if (req.reason !== "multi_face" && req.reason !== "tracking_lost") return bad("reason must be multi_face or tracking_lost");
      return { ok: true, request: { op, reason: req.reason } };
    case "list": {
      const request = { op };
      if (req.subject !== undefined) {
        if (req.subject !== null && !(typeof req.subject === "string" && PROFILE.test(req.subject))) return bad("subject is invalid");
        request.subject = req.subject;
      }
      if (req.manage !== undefined) {
        if (typeof req.manage !== "boolean") return bad("manage must be a boolean");
        request.manage = req.manage;
      }
      if (!optionalToken(req, request)) return bad("token is invalid");
      return { ok: true, request };
    }
    case "receipt":
      if (typeof req.operation_id !== "string" || !OPERATION.test(req.operation_id)) return bad("operation_id is required");
      return { ok: true, request: { op, operation_id: req.operation_id } };
    case "edit": {
      if (!isString(req.value, 512)) return bad("value is required");
      const request = { op, value: req.value };
      if (req.id === null) {
        request.id = null;
        if (req.subject !== undefined && req.subject !== null && !(typeof req.subject === "string" && PROFILE.test(req.subject))) return bad("subject is invalid");
        request.subject = req.subject ?? null;
      } else {
        if (typeof req.id !== "string" || !FACT.test(req.id) || !isRevision(req.revision)) return bad("id and revision are required");
        request.id = req.id;
        request.revision = req.revision;
      }
      if (!optionalToken(req, request)) return bad("token is invalid");
      return { ok: true, request };
    }
    case "forget":
      if (req.all === true) {
        if (req.subject !== null && !(typeof req.subject === "string" && PROFILE.test(req.subject))) return bad("subject is invalid");
        if (typeof req.token !== "string" || !TOKEN.test(req.token)) return bad("token is required");
        return { ok: true, request: { op, all: true, subject: req.subject, token: req.token } };
      }
    // falls through
    case "pin": {
      if (typeof req.id !== "string" || !FACT.test(req.id) || !isRevision(req.revision)) return bad("id and revision are required");
      const request = { op, id: req.id, revision: req.revision };
      if (op === "pin") {
        if (typeof req.pinned !== "boolean") return bad("pinned must be a boolean");
        request.pinned = req.pinned;
      }
      if (!optionalToken(req, request)) return bad("token is invalid");
      return { ok: true, request };
    }
    case "profile_minor":
      if (typeof req.profile !== "string" || !PROFILE.test(req.profile)) return bad("profile is required");
      if (typeof req.minor !== "boolean") return bad("minor must be a boolean");
      if (typeof req.token !== "string" || !TOKEN.test(req.token)) return bad("token is required");
      return { ok: true, request: { op, profile: req.profile, minor: req.minor, token: req.token } };
    case "suggestions":
      // MEM-5a：記憶建議只能在記憶管理（token）開關；核心另外檢查 NOUS_MEMORY_ROUTES 的 suggest。
      if (typeof req.enabled !== "boolean") return bad("enabled must be a boolean");
      if (typeof req.token !== "string" || !TOKEN.test(req.token)) return bad("token is required");
      return { ok: true, request: { op, enabled: req.enabled, token: req.token } };
    case "profile_delete":
    case "link_face": {
      if (typeof req.profile !== "string" || !PROFILE.test(req.profile)) return bad("profile is required");
      if (typeof req.token !== "string" || !TOKEN.test(req.token)) return bad("token is required");
      const request = { op, profile: req.profile, token: req.token };
      if (op === "link_face") {
        if (req.person !== null && !(typeof req.person === "string" && PERSON.test(req.person))) return bad("person must be a family id or null");
        request.person = req.person;
      }
      return { ok: true, request };
    }
    default:
      return bad("unknown op");
  }
}
