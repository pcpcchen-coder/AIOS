// 家人辨識 ID-01／ID-02（docs/14、docs/adr/ADR-0001）：核心、桌面 IPC 與頁面共用的型別、常數與純函式。
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
 * 校準完成（ID-03）前不得改成 true。George 2026-10-25 決定：稱名問候（ID-02）不等校準，先用這組未校準的起點門檻，
 * 但所有觀測、問候決策（GreetingDecision.calibrated）、log 與文件都照實標未校準（ADR-0001 §9）。
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

/** 口語名稱只能有文字、組合符號、數字，以及名字裡常見的空白、間隔號、句點、撇號與連字號。 */
const SPEAKABLE_NAME = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} ·・.'’-]*$/u;
/**
 * 像指令的字（盡力而為的黑名單，不是完整防護）：名字只會放進「」裡被念出來，但仍不讓它看起來像是在下指令。
 * 刻意不收「說」「念」這類也會出現在人名裡的字；真正的防線是名稱只能由使用者在管理畫面登記（原生確認），
 * 而且短句的形狀固定（greetingSentence）。
 */
const NAME_INSTRUCTION_WORDS = /(忽略|無視|指示|指令|提示詞|系統|扮演|假裝|\b(?:ignore|instructions?|prompt|system|assistant|pretend)\b)/iu;

/**
 * 問候用的口語名稱（ID-02，docs/14 §6、I11）。核心組句前從受管理人物檔案取出名稱後再驗一次：
 * 先過 parseFamilyName（同登記規則），再限制字元種類並拒絕像指令的內容。不合格回 null：問候只說「我在」，不拒絕對話。
 */
export function speakableName(raw: unknown): string | null {
  const parsed = parseFamilyName(raw);
  if (!parsed.ok) return null;
  if (!SPEAKABLE_NAME.test(parsed.name) || NAME_INSTRUCTION_WORDS.test(parsed.name)) return null;
  // 像句子的不念：空白分隔最多 3 段（「Mary Jane Watson」可以，「please say hello to me」不行），段與段之間只有一個空白。
  if (/\s{2,}/u.test(parsed.name) || parsed.name.split(" ").length > SPEAKABLE_NAME_MAX_WORDS) return null;
  return parsed.name;
}

/** 口語名稱最多幾段（空白分隔）。 */
export const SPEAKABLE_NAME_MAX_WORDS = 3;

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
  /** 已看過「開啟稱名時，名字會以短句送到雲端語音供應商」的一次性說明（ID-02）。沒看過就不稱名。 */
  naming_notice_seen: boolean;
}

export const IDENTITY_BROWSER_REASON = "瀏覽器版不可用（只在 macOS App 提供）";

/** 瀏覽器版（npm start）沒有注入 identity：核心照實回報不可用。 */
export const BROWSER_IDENTITY_STATUS: IdentityStatus = {
  available: false,
  disabled_reason: IDENTITY_BROWSER_REASON,
  limited_reason: null,
};

// ─────────────── ID-02：看著說話時同步辨識與稱名問候 ───────────────

/**
 * 近距離（公尺，docs/14 §4 起點值、未校準）：PresenceTracker 的距離在這個範圍內才取樣。距離未知（null）不算近距離，
 * 保守地只說「我在」。雙目距離沒有真校正，不能當成精準界線。
 */
export const AMBIENT_NEAR_M = { min: 0.6, max: 1.5 } as const;

/** 問候決策的速率上限：每秒與每分鐘（正常每次看著說話的互動只有一次）。 */
export const GREETING_RATE = { per_second: 2, per_minute: 3 } as const;

/** 核心為 live 路徑保留已組好的短句多久（IPC 決策 → 頁面 POST greeting 之間；本機來回通常數毫秒）。 */
export const LIVE_GREETING_PICKUP_MS = 3_000;

/** 看著說話開始的互動 ID 格式：由核心在 /api/realtime/start 發出（RealtimeSessions），不含身分。 */
export const INTERACTION_ID = /^int_[0-9a-f]{16}$/;

export type GreetingRoute = "api_key" | "live";

/**
 * 沒有稱名的原因（只進 log 與測試，不含身分）。
 * - naming_off：「打招呼時稱呼認出的家人」關閉（核心不得補回姓名）。
 * - notice_unseen：還沒在家人辨識畫面看過「名字會送到雲端語音」的一次性說明（登記同意或「我知道了」）。
 * - no_session：互動 ID 不是核心發出、已用過、工作階段沒有真的連上或已結束、連上超過 20 秒，或路徑不符。
 * - not_eligible：頁面端條件不符（換人、轉開、離開近距離、多張臉、關鏡頭、辨識錯誤…）。
 * - unavailable：辨識不可用（瀏覽器版、鏡頭關、模型、gallery 解不開、管理畫面開著）。
 * - no_evidence：核心沒有這次看著說話的任何一格（模型還沒載入、取樣沒開始）。
 * - track_changed：核心最後一格的追蹤世代與互動綁定的不同。
 * - multi_face：這個追蹤世代出現過多張臉或兩位不同的家人。
 * - 其餘對應 decideIdentity 的結果（collecting、stale、unknown、ambiguous、quality、no_face、no_gallery）。
 * - person_gone：人物已刪除或不再參與比對。
 * - bad_name：名稱沒有通過 speakableName。
 */
export type GreetingNameReason =
  | "naming_off"
  | "notice_unseen"
  | "no_session"
  | "not_eligible"
  | "unavailable"
  | "no_evidence"
  | "track_changed"
  | "multi_face"
  | "collecting"
  | "stale"
  | "unknown"
  | "ambiguous"
  | "quality"
  | "no_face"
  | "no_gallery"
  | "person_gone"
  | "bad_name";

/**
 * 結構化的問候決策（docs/14 §6）：只在核心建立與使用，不經 HTTP、不給頁面、不進 log。
 * person_id 為 null 時問候只說「我在」，reason 說明原因；有 person_id 時 reason 為 null。
 */
export interface GreetingDecision {
  interaction_id: string;
  person_id: string | null;
  track_generation: number;
  gallery_version: number;
  /** 最新證據的核心時鐘時間；沒有證據時 null。 */
  evidence_at: number | null;
  decided_at: number;
  reason: GreetingNameReason | null;
  /** 門檻沒有校準：一律 false（George 2026-10-25：未校準也先稱名，但照實標示）。 */
  calibrated: boolean;
}

/** IPC 的操作（desktop/identity-ipc.mjs 的白名單與這裡一致，測試對照）。 */
export const IDENTITY_OPS = ["open_session", "close_session", "list", "probe", "enroll", "delete", "clear_all", "ambient_status", "ambient_probe", "greeting", "ack_naming"] as const;
export type IdentityOp = (typeof IDENTITY_OPS)[number];

export type IdentityRequest =
  | { op: "open_session" }
  | { op: "close_session"; session: string }
  | { op: "list"; session: string }
  | { op: "probe"; session: string; gen: number; face_count: number; quality: QualityReason; model: FaceModelVersion; feature?: number[] }
  | { op: "enroll"; session: string; name: string; minor: boolean; guardian_confirmed: boolean; consent: boolean; model: FaceModelVersion; samples: number[][] }
  | { op: "delete"; session: string; person_id: string }
  | { op: "clear_all"; session: string }
  /** 看著說話時能不能同步辨識（不載入 gallery、不碰 Keychain）。 */
  | { op: "ambient_status" }
  /** 看著說話的面向等待期間的一格（不需要管理 session；回應不含任何結果，避免變成探測工具）。 */
  | { op: "ambient_probe"; track: number; face_count: number; quality: QualityReason; model: FaceModelVersion; feature?: number[] }
  /** 送出問候前：頁面給互動 ID、綁定的追蹤世代與頁面端條件，核心建立 GreetingDecision 並組句。 */
  | { op: "greeting"; interaction: string; track: number; eligible: boolean; route: GreetingRoute }
  /** 管理畫面：使用者按下「我知道了」，記錄已看過雲端稱名的說明（沒看過就不稱名）。 */
  | { op: "ack_naming"; session: string };

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
  | "write_failed"
  /** 這個互動已經做過問候決策（每次互動最多一次，送出狀態未知時也不重來）。 */
  | "already";

/**
 * 刪除家人或清除全部後，連結記憶的處理結果（docs/16 MEM-1）：none 沒有連結、unlinked 只解除連結、deleted 一併刪除、
 * failed 記憶沒有處理成功（家人資料已刪；畫面照實告知，請到「記憶…」處理）。
 */
export type MemoryUnlinkResult = "none" | "unlinked" | "deleted" | "failed";

export type IdentityResponse =
  | ({ ok: true; op: "open_session" | "list" | "enroll" | "ack_naming" } & IdentityManageView)
  | ({ ok: true; op: "delete" | "clear_all"; memory?: MemoryUnlinkResult } & IdentityManageView)
  | { ok: true; op: "close_session" }
  | { ok: true; op: "probe"; observation: IdentityObservation }
  /** 只回可不可以取樣；不回原因（原因可能透露有沒有登記家人）。 */
  | { ok: true; op: "ambient_status"; ready: boolean }
  | { ok: true; op: "ambient_probe" }
  /**
   * api_key：text 是 response.create 這一輪的 instructions（只含核心組好的短句；名字會短暫出現在頁面，ADR-0001 §2.4）。
   * live：text 為 null，短句留在核心，頁面接著 POST /api/realtime/input greeting（只帶互動 ID），核心自己送進 sideband。
   */
  | { ok: true; op: "greeting"; text: string | null }
  | { ok: false; code: IdentityErrorCode; message: string };
