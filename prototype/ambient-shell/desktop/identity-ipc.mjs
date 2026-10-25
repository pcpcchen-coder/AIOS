// 家人辨識的 IPC 過濾（純函式，不載入 Electron；tests/identity-ipc.test.ts 直接測）。
// 架構（ADR-0001 §2.1）：核心持有資料與比對，IPC 只做傳輸。這裡只做三件事：
//   1. 確認發送者是主視窗的主框架、而且頁面來自本機核心（不是其他視窗、iframe 或導覽後的外部頁面）；
//   2. op 白名單與每個 op 允許的欄位與型別（多的欄位丟掉）；語意驗證（特徵正規化、名稱、人數）由核心負責；
//   3. 選單列點擊時間窗：只有使用者在選單列點「家人辨識…」後 10 秒內，open_session 才算使用者發起（一次有效）。

/** 與 shared/identity.ts 的 IDENTITY_OPS 相同（測試對照）。 */
export const IDENTITY_OPS = ["open_session", "close_session", "list", "probe", "enroll", "delete", "clear_all"];

export const MENU_CLICK_WINDOW_MS = 10_000;
const FEATURE_DIM = 128;
const MAX_SAMPLES = 10;
const SESSION = /^ids_[0-9a-f]{32}$/;
const PERSON = /^fam_[0-9a-f]{24}$/;

/**
 * 發送者檢查。event 為 ipcMain.handle 的 IpcMainInvokeEvent；win 為主視窗；coreUrl 為本機核心網址（http://localhost:埠）。
 * 回傳 true 才轉給核心。
 */
export function checkIdentitySender(event, win, coreUrl) {
  if (!event || !win || typeof coreUrl !== "string" || !coreUrl) return false;
  if (typeof win.isDestroyed === "function" && win.isDestroyed()) return false;
  const sender = event.sender;
  if (!sender || sender !== win.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== sender.mainFrame) return false;
  const url = typeof frame.url === "string" ? frame.url : "";
  // 以 core.url 加上 "/" 比對，避免 http://localhost:8787 被 http://localhost:87870 冒充。
  return url === coreUrl || url.startsWith(`${coreUrl}/`);
}

const isInt = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isShortString = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

function feature(v) {
  if (!Array.isArray(v) || v.length !== FEATURE_DIM) return null;
  for (const x of v) if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return v.slice();
}

function model(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const key of ["detector", "recognizer", "align", "preproc"]) {
    if (!isShortString(v[key], 64)) return null;
    out[key] = v[key];
  }
  return out;
}

/**
 * 白名單與形狀。成功回 { ok: true, request }（只含允許的欄位），否則 { ok: false, error }。
 * 不檢查特徵是否正規化、名稱內容、人數或樣本一致性：核心是權威。
 */
export function validateIdentityRequest(req) {
  const bad = (error) => ({ ok: false, error });
  if (!req || typeof req !== "object" || Array.isArray(req)) return bad("request must be an object");
  const op = req.op;
  if (!IDENTITY_OPS.includes(op)) return bad("unknown op");
  if (op === "open_session") return { ok: true, request: { op } };
  if (!(typeof req.session === "string" && SESSION.test(req.session))) return bad("session is required");
  const session = req.session;
  switch (op) {
    case "close_session":
    case "list":
    case "clear_all":
      return { ok: true, request: { op, session } };
    case "delete":
      if (!(typeof req.person_id === "string" && PERSON.test(req.person_id))) return bad("person_id is required");
      return { ok: true, request: { op, session, person_id: req.person_id } };
    case "probe": {
      const m = model(req.model);
      if (!m) return bad("model is required");
      if (!isInt(req.gen, 0, Number.MAX_SAFE_INTEGER) || !isInt(req.face_count, 0, 64)) return bad("gen and face_count must be integers");
      if (!isShortString(req.quality, 32)) return bad("quality is required");
      const request = { op, session, gen: req.gen, face_count: req.face_count, quality: req.quality, model: m };
      if (req.feature !== undefined) {
        const f = feature(req.feature);
        if (!f) return bad(`feature must be ${FEATURE_DIM} finite numbers`);
        request.feature = f;
      }
      return { ok: true, request };
    }
    case "enroll": {
      const m = model(req.model);
      if (!m) return bad("model is required");
      if (typeof req.name !== "string" || req.name.length > 256) return bad("name is required");
      if (typeof req.minor !== "boolean" || typeof req.guardian_confirmed !== "boolean" || typeof req.consent !== "boolean") {
        return bad("minor, guardian_confirmed and consent must be booleans");
      }
      if (!Array.isArray(req.samples) || req.samples.length === 0 || req.samples.length > MAX_SAMPLES) return bad("samples must be 1–10 features");
      const samples = req.samples.map(feature);
      if (samples.some((s) => s === null)) return bad(`each sample must be ${FEATURE_DIM} finite numbers`);
      return {
        ok: true,
        request: { op, session, name: req.name, minor: req.minor, guardian_confirmed: req.guardian_confirmed, consent: req.consent, model: m, samples },
      };
    }
    default:
      return bad("unknown op");
  }
}

/** 選單列點擊的時間窗：mark() 在點擊時呼叫；consume() 在 open_session 時呼叫，10 秒內第一次回 true，之後失效。 */
export class MenuClickWindow {
  constructor(windowMs = MENU_CLICK_WINDOW_MS) {
    this.windowMs = windowMs;
    this.at = null;
  }

  mark(now) {
    this.at = now;
  }

  consume(now) {
    const at = this.at;
    this.at = null;
    return at !== null && now >= at && now - at <= this.windowMs;
  }
}
