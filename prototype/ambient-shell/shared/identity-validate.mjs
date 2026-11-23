// 家人辨識請求的形狀過濾（純函式；macOS App 的 IPC 與終端機的 HTTP 共用同一份，tests/identity-ipc.test.ts、
// tests/terminal-routes.test.ts 直接測）。核心持有資料與比對（ADR-0001 §2.1），這裡只做 op 白名單與每個 op 允許的
// 欄位與型別（多的欄位丟掉）；語意驗證（特徵正規化、名稱、人數）由核心負責。發送者檢查與選單列時間窗留在 desktop/identity-ipc.mjs。

/** 與 shared/identity.ts 的 IDENTITY_OPS 相同（測試對照）。 */
export const IDENTITY_OPS = ["open_session", "close_session", "list", "probe", "enroll", "delete", "clear_all", "ambient_status", "ambient_probe", "greeting", "ack_naming", "enroll_voice", "delete_voice", "voice_probe", "voice_test", "call_voice", "calib_status", "calib_trial", "calib_apply", "calib_clear"];

const FEATURE_DIM = 128;
const MAX_SAMPLES = 10;
/** SP-01 聲音特徵（CAM++）與段數（同 shared/identity.ts 的 SPEAKER_FEATURE_DIM、VOICE_KEYWORD_SAMPLES、VOICE_UTTERANCE_SAMPLES）。 */
const SPEAKER_DIM = 192;
const VOICE_KEYWORD_SAMPLES = 5;
const VOICE_UTTERANCE_SAMPLES = 3;
const SESSION = /^ids_[0-9a-f]{32}$/;
const PERSON = /^fam_[0-9a-f]{24}$/;
const INTERACTION = /^int_[0-9a-f]{16}$/;
/** 喚醒 ID（同 shared/wake.ts 的 WAKE_ID）。 */
const WAKE = /^int_[0-9a-f]{16}$/;
const SEGMENTS = ["keyword", "utterance"];

const isInt = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isShortString = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

function feature(v, dim = FEATURE_DIM) {
  if (!Array.isArray(v) || v.length !== dim) return null;
  for (const x of v) if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return v.slice();
}

function speakerModel(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (!isShortString(v.speaker, 64) || !isShortString(v.preproc, 64) || !isInt(v.dim, 1, 4096)) return null;
  return { speaker: v.speaker, preproc: v.preproc, dim: v.dim };
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
  if (op === "open_session" || op === "ambient_status") return { ok: true, request: { op } };
  // ID-02：看著說話時的同步辨識與問候決策不需要管理 session；核心另外依設定、鏡頭與模型決定接不接受。
  if (op === "ambient_probe") {
    const m = model(req.model);
    if (!m) return bad("model is required");
    if (!isInt(req.track, 0, Number.MAX_SAFE_INTEGER) || !isInt(req.face_count, 0, 64)) return bad("track and face_count must be integers");
    if (!isShortString(req.quality, 32)) return bad("quality is required");
    const request = { op, track: req.track, face_count: req.face_count, quality: req.quality, model: m };
    if (req.feature !== undefined) {
      const f = feature(req.feature);
      if (!f) return bad(`feature must be ${FEATURE_DIM} finite numbers`);
      request.feature = f;
    }
    return { ok: true, request };
  }
  if (op === "greeting") {
    if (!(typeof req.interaction === "string" && INTERACTION.test(req.interaction))) return bad("interaction is required");
    if (!isInt(req.track, 0, Number.MAX_SAFE_INTEGER)) return bad("track must be an integer");
    if (typeof req.eligible !== "boolean") return bad("eligible must be a boolean");
    if (req.route !== "api_key" && req.route !== "live") return bad("route must be api_key or live");
    return { ok: true, request: { op, interaction: req.interaction, track: req.track, eligible: req.eligible, route: req.route } };
  }
  // SP-02a：喚醒時的一段聲音（不需要管理 session；核心另外決定接不接受，回應只有 ok）。
  if (op === "voice_probe") {
    const m = speakerModel(req.model);
    if (!m) return bad("model is required");
    if (!(typeof req.wake_id === "string" && WAKE.test(req.wake_id))) return bad("wake_id is required");
    if (!SEGMENTS.includes(req.segment)) return bad("segment must be keyword or utterance");
    if (!isInt(req.voiced_ms, 0, 60_000)) return bad("voiced_ms must be an integer");
    const request = { op, wake_id: req.wake_id, segment: req.segment, voiced_ms: req.voiced_ms, model: m };
    if (req.feature !== undefined) {
      const f = feature(req.feature, SPEAKER_DIM);
      if (!f) return bad(`feature must be ${SPEAKER_DIM} finite numbers`);
      request.feature = f;
    }
    return { ok: true, request };
  }
  // SP-02b：通話中的一段話（不需要管理 session；核心依「通話中辨認說話者」決定接不接受，回應只有 ok）。
  if (op === "call_voice") {
    const m = speakerModel(req.model);
    if (!m) return bad("model is required");
    if (!isInt(req.voiced_ms, 0, 60_000)) return bad("voiced_ms must be an integer");
    const request = { op, voiced_ms: req.voiced_ms, model: m };
    if (req.feature !== undefined) {
      const f = feature(req.feature, SPEAKER_DIM);
      if (!f) return bad(`feature must be ${SPEAKER_DIM} finite numbers`);
      request.feature = f;
    }
    return { ok: true, request };
  }
  if (!(typeof req.session === "string" && SESSION.test(req.session))) return bad("session is required");
  const session = req.session;
  switch (op) {
    case "close_session":
    case "list":
    case "clear_all":
    case "ack_naming":
    case "calib_status":
    case "calib_apply":
    case "calib_clear":
      return { ok: true, request: { op, session } };
    case "delete":
    case "delete_voice":
      if (!(typeof req.person_id === "string" && PERSON.test(req.person_id))) return bad("person_id is required");
      return { ok: true, request: { op, session, person_id: req.person_id } };
    case "enroll_voice": {
      // 只有特徵，沒有錄音：形狀不對整個拒絕。有 person_id 時不收 name／minor（沿用已存的資料）。
      const m = speakerModel(req.model);
      if (!m) return bad("model is required");
      if (typeof req.consent !== "boolean") return bad("consent must be a boolean");
      if (req.guardian_confirmed !== undefined && typeof req.guardian_confirmed !== "boolean") return bad("guardian_confirmed must be a boolean");
      if (!Array.isArray(req.keyword) || req.keyword.length !== VOICE_KEYWORD_SAMPLES) return bad(`keyword must be ${VOICE_KEYWORD_SAMPLES} features`);
      if (!Array.isArray(req.utterance) || req.utterance.length !== VOICE_UTTERANCE_SAMPLES) return bad(`utterance must be ${VOICE_UTTERANCE_SAMPLES} features`);
      const keyword = req.keyword.map((f) => feature(f, SPEAKER_DIM));
      const utterance = req.utterance.map((f) => feature(f, SPEAKER_DIM));
      if ([...keyword, ...utterance].some((f) => f === null)) return bad(`each voice feature must be ${SPEAKER_DIM} finite numbers`);
      const request = { op, session, consent: req.consent, model: m, keyword, utterance };
      if (req.guardian_confirmed !== undefined) request.guardian_confirmed = req.guardian_confirmed;
      if (req.person_id !== undefined) {
        if (!(typeof req.person_id === "string" && PERSON.test(req.person_id))) return bad("person_id is malformed");
        request.person_id = req.person_id;
      } else {
        if (typeof req.name !== "string" || req.name.length > 256) return bad("name is required");
        if (typeof req.minor !== "boolean") return bad("minor must be a boolean");
        request.name = req.name;
        request.minor = req.minor;
      }
      return { ok: true, request };
    }
    case "calib_trial": {
      const m = speakerModel(req.model);
      if (!m) return bad("model is required");
      if (req.label !== "member" && req.label !== "stranger") return bad("label must be member or stranger");
      if (!SEGMENTS.includes(req.segment)) return bad("segment must be keyword or utterance");
      if (!isInt(req.voiced_ms, 0, 60_000)) return bad("voiced_ms must be an integer");
      const f = feature(req.feature, SPEAKER_DIM);
      if (!f) return bad(`feature must be ${SPEAKER_DIM} finite numbers`);
      const request = { op, session, label: req.label, segment: req.segment, voiced_ms: req.voiced_ms, model: m, feature: f };
      if (req.label === "member") {
        if (!(typeof req.person_id === "string" && PERSON.test(req.person_id))) return bad("person_id is required for member");
        request.person_id = req.person_id;
      }
      return { ok: true, request };
    }
    case "voice_test": {
      const m = speakerModel(req.model);
      if (!m) return bad("model is required");
      if (!SEGMENTS.includes(req.segment)) return bad("segment must be keyword or utterance");
      const f = feature(req.feature, SPEAKER_DIM);
      if (!f) return bad(`feature must be ${SPEAKER_DIM} finite numbers`);
      return { ok: true, request: { op, session, segment: req.segment, model: m, feature: f } };
    }
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
      const samples = req.samples.map((s) => feature(s));
      if (samples.some((s) => s === null)) return bad(`each sample must be ${FEATURE_DIM} finite numbers`);
      const request = { op, session, name: req.name, minor: req.minor, guardian_confirmed: req.guardian_confirmed, consent: req.consent, model: m, samples };
      // SP-01：幫只登記了聲音的家人補臉（名稱與未成年由核心沿用已存的資料）。
      if (req.person_id !== undefined) {
        if (!(typeof req.person_id === "string" && PERSON.test(req.person_id))) return bad("person_id is malformed");
        request.person_id = req.person_id;
      }
      return { ok: true, request };
    }
    default:
      return bad("unknown op");
  }
}
