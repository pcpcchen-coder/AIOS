// 家人辨識 ID-01（docs/14、docs/adr/ADR-0001）：核心、桌面 IPC 與頁面共用的型別、常數與純函式。
// 規則：身分只用於稱呼，不作授權；未知不硬配人；所有門檻都是未校準的起點值（CALIBRATED = false）。
// 這裡沒有任何 I/O；比對與證據累積在核心（server/identity-service.ts），頁面只顯示核心給的狀態。

/** SFace 特徵維度。 */
export const IDENTITY_FEATURE_DIM = 128;
/** 特徵必須已 L2 normalize：|‖v‖ − 1| 小於這個值。 */
export const FEATURE_NORM_TOLERANCE = 1e-3;
/** 第一版最多登記幾位家人（George 2026-10-25）。 */
export const FAMILY_MAX = 5;
/** 每位家人的樣本數範圍（George 2026-10-25：5–10 張）。 */
export const ENROLL_MIN_SAMPLES = 5;
export const ENROLL_MAX_SAMPLES = 10;
/** 名稱長度上限（以字元計，不是位元組）。 */
export const FAMILY_NAME_MAX = 16;

/**
 * 門檻是否已用登記以外的保留樣本與陌生人校準。ID-01 沒有：每個觀測都帶 calibrated:false，試認畫面標「門檻未校準」。
 * 校準完成（ID-03）前不得改成 true。
 */
export const CALIBRATED = false;

/**
 * 比對門檻（cosine，起點值、未校準）。刻意不用 OpenCV 範例的 0.363：那是 LFW 上的範例值，不是本專案的校準結果。
 * 起點取得比範例高，寧可「不認得」也不要叫錯名字；ID-00 雲端 sanity check 的同一人 0.73–0.80、不同人 0.07–0.25
 * 只有 3 個人、5 張官方肖像，不能拿來定門檻，只說明這個起點不在明顯錯誤的位置。
 * - match：最高分的家人至少要有這個分數才算 matched。
 * - margin：最高分與第二高分（另一位家人）的差距不足就是 ambiguous，不任選一位。
 * - consistency：登記時每張樣本與樣本平均方向的 cosine 下限；
 * - consistency_pair：登記時任兩張樣本之間的 cosine 下限。只看平均方向擋不住「兩個人各一半」（各自與平均約 0.7），
 *   所以兩項都要過；低於任一項表示樣本混到別人或品質太差，整批拒絕。
 */
export const MATCH_THRESHOLDS = { match: 0.5, margin: 0.08, consistency: 0.5, consistency_pair: 0.4 } as const;

/** 證據規則（docs/14 §4 起點值）。 */
export const EVIDENCE_RULES = {
  /** 至少幾個不同畫格一致指向同一人。 */
  min_frames: 3,
  /** 這些畫格至少要跨多久。 */
  min_span_ms: 500,
  /** 最新證據最多多舊。 */
  fresh_ms: 1000,
  /** 相鄰兩格超過這麼久就算追蹤斷開，證據清空。 */
  gap_ms: 500,
  /** 一段連續證據最多留幾格（只需要最近的）。 */
  max_frames: 20,
} as const;

/** 模型與前處理版本：四項都相符的登記特徵才參與比對，否則標 needs_reenroll（不做跨模型轉換）。 */
export interface FaceModelVersion {
  detector: string;
  recognizer: string;
  align: string;
  preproc: string;
}

export function sameModelVersion(a: FaceModelVersion, b: FaceModelVersion): boolean {
  return a.detector === b.detector && a.recognizer === b.recognizer && a.align === b.align && a.preproc === b.preproc;
}

/** worker 回報的畫格品質（src/sense/face/quality.ts）。ok 以外都不送特徵。 */
export const QUALITY_REASONS = [
  "ok",
  "no_frame",
  "no_face",
  "multi_face",
  "too_small",
  "out_of_frame",
  "low_score",
  "not_frontal",
  "tilted",
  "too_dark",
  "too_bright",
] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];

export type IdentityState = "matched" | "unknown" | "ambiguous" | "unavailable";

/**
 * 不是 matched 時的原因。
 * - multi_face：畫面有多張臉，不挑最大或最近的臉。
 * - margin：兩位家人分數太接近。
 * - quality：臉太小、側臉、太暗…（品質不足）。
 * - no_face：沒有臉（含鏡頭沒有畫面）。
 * - collecting：證據還不夠（< 3 格或 < 500 ms）。這個中性狀態同時涵蓋「可能是某位家人」「可能不認得」與「兩位分不清」：
 *   和 gallery 有關的結果都要累積到證據門檻才回，單一格不能拿來探測某張臉是否已登記（審查 2026-10-25）。
 * - stale：最新證據超過 1 秒，或追蹤斷開、世代或登記資料已改變。
 * - no_gallery：沒有任何可比對的登記資料（包含全部需重新登記）。
 */
export type IdentityReason = "multi_face" | "margin" | "quality" | "no_face" | "collecting" | "stale" | "no_gallery";

/** 單一畫格在核心的比對結果；不含相似度分數。 */
export type FrameMatch =
  | { kind: "matched"; person_id: string }
  | { kind: "unknown" }
  | { kind: "ambiguous"; reason: "margin" | "multi_face" }
  | { kind: "unavailable"; reason: "no_face" | "quality" | "no_gallery" };

export interface EvidenceFrame {
  /** 核心時鐘（毫秒）。 */
  t: number;
  /** 頁面的取樣世代（開關鏡頭、收起畫面都會加一）。 */
  gen: number;
  match: FrameMatch;
}

/** 證據的範圍：任何一項改變，舊證據全部作廢。 */
export interface EvidenceScope {
  gen: number;
  epoch: number;
  gallery_version: number;
}

export interface EvidenceState {
  scope: EvidenceScope | null;
  /** 最新一格與它之前連續、同一種結果的畫格（matched 時是同一人）。 */
  frames: readonly EvidenceFrame[];
}

export const EMPTY_EVIDENCE: EvidenceState = { scope: null, frames: [] };

/** 給頁面的辨識觀測；只有 matched 帶 person_id。不含分數。 */
export interface IdentityObservation {
  state: IdentityState;
  reason: IdentityReason | null;
  person_id?: string;
  gen: number;
  epoch: number;
  gallery_version: number;
  observed_at: number;
  /** 門檻沒有校準：一律 false。 */
  calibrated: boolean;
}

function sameScope(a: EvidenceScope | null, b: EvidenceScope): boolean {
  return !!a && a.gen === b.gen && a.epoch === b.epoch && a.gallery_version === b.gallery_version;
}

function sameMatch(a: FrameMatch, b: FrameMatch): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "matched" && b.kind === "matched") return a.person_id === b.person_id;
  return true;
}

/**
 * 加入一格證據（純函式）。範圍改變、時間倒退或與上一格相隔超過 gap_ms 時清空重來；
 * 結果與上一格不同（換人、變成未知、品質不足…）時也從這一格重新累積，所以「都指向同一人」只看連續的同一人。
 */
export function pushEvidence(state: EvidenceState, frame: EvidenceFrame, scope: EvidenceScope): EvidenceState {
  const last = state.frames.at(-1);
  const fresh = !sameScope(state.scope, scope) || frame.gen !== scope.gen || !last || frame.t < last.t || frame.t - last.t > EVIDENCE_RULES.gap_ms;
  if (fresh || !sameMatch(last.match, frame.match)) return { scope, frames: [frame] };
  const frames = [...state.frames, frame];
  return { scope, frames: frames.slice(-EVIDENCE_RULES.max_frames) };
}

/**
 * 依目前證據決定辨識結果（純函式，時間由呼叫端給，測試用假時鐘）。
 * matched 的條件：同一範圍（世代、epoch、gallery_version）內至少 3 格、跨至少 500 ms、全部指向同一人，且最新一格不超過 1 秒。
 * 其他情況都不帶姓名：未知、多張臉、品質不足、關鏡頭與追蹤遺失都不沿用上一位。
 */
export function decideIdentity(state: EvidenceState, now: number, scope: EvidenceScope): IdentityObservation {
  const base = { gen: scope.gen, epoch: scope.epoch, gallery_version: scope.gallery_version, observed_at: now, calibrated: CALIBRATED };
  const last = state.frames.at(-1);
  if (!last) return { ...base, state: "unavailable", reason: "no_face" };
  if (!sameScope(state.scope, scope) || last.gen !== scope.gen || now - last.t > EVIDENCE_RULES.fresh_ms || now < last.t) {
    return { ...base, state: "unavailable", reason: "stale" };
  }
  const m = last.match;
  switch (m.kind) {
    case "ambiguous":
      // 多張臉和 gallery 無關，立即回報；「兩位分不清」要跟其他比對結果一樣累積證據。
      if (m.reason === "multi_face") return { ...base, state: "ambiguous", reason: "multi_face" };
      break;
    case "unavailable":
      return { ...base, state: "unavailable", reason: m.reason };
  }
  const first = state.frames[0]!;
  const enough = state.frames.length >= EVIDENCE_RULES.min_frames && last.t - first.t >= EVIDENCE_RULES.min_span_ms;
  if (!enough) return { ...base, state: "unavailable", reason: "collecting" };
  if (m.kind === "matched") return { ...base, state: "matched", reason: null, person_id: m.person_id };
  if (m.kind === "unknown") return { ...base, state: "unknown", reason: null };
  return { ...base, state: "ambiguous", reason: "margin" };
}

/** 名稱裡不允許的字元：標記、指令與程式碼常見的括號與引號（I11）。控制字元與格式字元另外檢查。 */
const NAME_FORBIDDEN = /[<>{}[\]`"\\]/u;
const NAME_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export type NameResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * 家人名稱的唯一驗證（核心為權威；頁面用同一函式即時提示）。NFC 正規化、去頭尾空白後 1–16 個字元；
 * 拒絕換行、控制與格式字元（含雙向文字覆寫）與 <>{}[]`"\ 。名稱只會被唸出來或顯示，從不當成指令。
 */
export function parseFamilyName(raw: unknown): NameResult {
  if (typeof raw !== "string") return { ok: false, error: "請輸入名稱" };
  if (raw.length > 256) return { ok: false, error: `名稱最多 ${FAMILY_NAME_MAX} 個字` };
  const normalized = raw.normalize("NFC");
  // 先檢查再去空白：頭尾的換行也算（不靠 trim 悄悄吃掉）。
  if (NAME_CONTROL.test(normalized)) return { ok: false, error: "名稱不能有換行或控制字元" };
  const name = normalized.trim();
  if (!name) return { ok: false, error: "請輸入名稱" };
  if (NAME_FORBIDDEN.test(name)) return { ok: false, error: "名稱不能有 < > { } [ ] ` \" \\ 這些符號" };
  if ([...name].length > FAMILY_NAME_MAX) return { ok: false, error: `名稱最多 ${FAMILY_NAME_MAX} 個字` };
  return { ok: true, name };
}

/** 特徵向量的形狀檢查：128 個有限數值且已 L2 normalize。 */
export function isValidFeature(v: unknown): v is ArrayLike<number> {
  if (!(Array.isArray(v) || v instanceof Float32Array) || v.length !== IDENTITY_FEATURE_DIM) return false;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== "number" || !Number.isFinite(x)) return false;
    sum += x * x;
  }
  return Math.abs(Math.sqrt(sum) - 1) < FEATURE_NORM_TOLERANCE;
}

/** 家人列表的一列（只在管理 session 內經 IPC 給頁面；不經 HTTP、不進 log）。 */
export interface FamilyMember {
  person_id: string;
  name: string;
  minor: boolean;
  created_at: string;
  /** 登記時的模型或前處理版本與目前不同：不參與比對，要重新登記。 */
  needs_reenroll: boolean;
  /** 載入時發現特徵不合格（維度、非有限值或沒有正規化）：照實標為壞資料，不參與比對，只能刪除。 */
  damaged: boolean;
}

/**
 * GET /api/settings 的 identity 欄位：只有選單列需要的可用狀態（審查 2026-10-25：人數、世代等改經 IPC 只給已開 session 的頁面）。
 * disabled_reason：選單列「家人辨識…」停用的原因（null＝可以打開）。
 * limited_reason：打得開，但不能新增或試認的原因（鏡頭沒開、模型沒裝…）；查看與刪除仍可用。這裡只看鏡頭與模型，
 * 不看 gallery（gallery 要到第一次開 session 才載入，啟動時不碰 Keychain）。
 */
export interface IdentityStatus {
  available: boolean;
  disabled_reason: string | null;
  limited_reason: string | null;
}

/**
 * 管理畫面的狀態（只經 IPC 給已開 session 的頁面）。
 * - key_unavailable：解不開資料金鑰（例如沒有允許鑰匙圈存取）。可重試，不提供清除。
 * - corrupt：GCM 驗證失敗或檔案損壞。不覆寫，只提供經原生確認的「清除全部家人資料」。
 */
export interface IdentityManageStatus {
  state: "ready" | "key_unavailable" | "corrupt";
  limited_reason: string | null;
  count: number;
  max: number;
  needs_reenroll: number;
  damaged: number;
  gallery_version: number;
  epoch: number;
  models: "ok" | "missing" | "hash_mismatch" | "not_configured";
  /** Time Machine 排除：excluded／failed（原因只在畫面說明，不阻擋）／pending／not_applicable。 */
  backup_exclusion: "excluded" | "failed" | "pending" | "not_applicable";
  calibrated: boolean;
}

export const IDENTITY_BROWSER_REASON = "瀏覽器版不可用（只在 macOS App 提供）";

/** 瀏覽器版（npm start）沒有注入 identity：核心照實回報不可用。 */
export const BROWSER_IDENTITY_STATUS: IdentityStatus = {
  available: false,
  disabled_reason: IDENTITY_BROWSER_REASON,
  limited_reason: null,
};

/** IPC 的操作（desktop/identity-ipc.mjs 的白名單與這裡一致，測試對照）。 */
export const IDENTITY_OPS = ["open_session", "close_session", "list", "probe", "enroll", "delete", "clear_all"] as const;
export type IdentityOp = (typeof IDENTITY_OPS)[number];

export type IdentityRequest =
  | { op: "open_session" }
  | { op: "close_session"; session: string }
  | { op: "list"; session: string }
  | { op: "probe"; session: string; gen: number; face_count: number; quality: QualityReason; model: FaceModelVersion; feature?: number[] }
  | { op: "enroll"; session: string; name: string; minor: boolean; guardian_confirmed: boolean; consent: boolean; model: FaceModelVersion; samples: number[][] }
  | { op: "delete"; session: string; person_id: string }
  | { op: "clear_all"; session: string };

/** 管理畫面需要的狀態（open_session、list 與變更後回傳）。 */
export interface IdentityManageView {
  session: string;
  people: FamilyMember[];
  status: IdentityManageStatus;
}

export type IdentityErrorCode =
  | "unavailable"
  | "closed"
  | "busy"
  | "stale_gallery"
  | "not_user_initiated"
  | "no_session"
  | "rate_limited"
  | "bad_request"
  | "model_mismatch"
  | "full"
  | "bad_name"
  | "consent_required"
  | "guardian_required"
  | "bad_samples"
  | "inconsistent_samples"
  | "duplicate"
  | "declined"
  | "not_found"
  | "write_failed";

export type IdentityResponse =
  | ({ ok: true; op: "open_session" | "list" | "delete" | "clear_all" | "enroll" } & IdentityManageView)
  | { ok: true; op: "close_session" }
  | { ok: true; op: "probe"; observation: IdentityObservation }
  | { ok: false; code: IdentityErrorCode; message: string };
