import { normalizeLocale, type Locale } from "../shared/i18n.mjs";
import { randomBytes } from "node:crypto";
import {
  CALIBRATED,
  decideIdentity,
  EMPTY_EVIDENCE,
  ENROLL_MAX_SAMPLES,
  EVIDENCE_RULES,
  ENROLL_MIN_SAMPLES,
  FAMILY_MAX,
  IDENTITY_FEATURE_DIM,
  IDENTITY_OPS,
  isValidFeature,
  MATCH_THRESHOLDS,
  parseFamilyName,
  pushEvidence,
  QUALITY_REASONS,
  GREETING_RATE,
  INTERACTION_ID,
  LIVE_GREETING_PICKUP_MS,
  sameModelVersion,
  speakableName,
  type EvidenceScope,
  type EvidenceState,
  type GreetingDecision,
  type GreetingNameReason,
  type GreetingRoute,
  type FaceModelVersion,
  type FamilyMember,
  type FrameMatch,
  type IdentityErrorCode,
  type IdentityManageStatus,
  type IdentityManageView,
  type IdentityResponse,
  type IdentityStatus,
  type MemoryUnlinkResult,
  type QualityReason,
} from "../shared/identity.ts";
import { greetingInstructions, liveGreetingText } from "../shared/sense.ts";
import { GreetingPicker } from "./greeting-picker.ts";
import type { FaceRuntimeCheck } from "./face-runtime.ts";
import type { GalleryStore, GalleryVersions, StoredPerson } from "./identity-store.ts";

// 家人辨識的核心（ADR-0001 §2.1：核心持有資料與邏輯，IPC 只做傳輸）。跑在 Electron 主程序（desktop/main.mjs 以
// startNous 的 identity 選項注入）；瀏覽器版沒有注入，settings.identity 照實回報不可用。
//
// - 管理 session：只有使用者在選單列點「家人辨識…」後 10 秒內，主視窗的頁面才能開（userInitiated 由主程序判斷）；
//   收起（close_session）、閒置 10 分鐘、開了 15 分鐘、主視窗導覽／重新載入／renderer 結束（主程序呼叫 closeSessions）
//   或核心關閉（shutdown）都會失效。一次只有一個 session。probe／enroll／delete 都要有效 session。
// - gallery 第一次開 session 才載入（啟動時不碰 Keychain、不建資料夾、不跑 tmutil）。
// - 會改資料的操作（enroll／delete／clear_all）同時只能有一個；寫入前核對磁碟上的 gallery_version 與記憶體相同。
// - 比對在這裡：回應不含相似度分數。每位家人的分數取該人各樣本 cosine 的最大值；最高分 ≥ match 且領先第二名 ≥ margin
//   才是這一格的 matched；之後還要通過 shared/identity.ts 的證據規則（≥3 格、≥500 ms、最新 ≤1 秒）。
// - 永久刪除與登記都要主程序的原生確認（confirm，頁面無法偽造），被拒就不寫檔。
// - log 只記狀態、原因、耗時、世代與模型版本；不記姓名、person_id、特徵或分數。
//
// ID-02（看著說話時同步辨識與稱名問候，docs/14 §2、§3、§6）：
// - ambient_probe：不需要管理 session，但只在「看著說話」「看著說話時先打招呼」「打招呼時稱呼認出的家人」都開、鏡頭開、
//   模型雜湊相符、沒有管理畫面開著時接受。證據依頁面的追蹤世代（track）分開累積；回應不含任何辨識結果，
//   頁面因此無法拿它探測某張臉是否已登記。這個追蹤世代出現過多張臉或兩位不同的家人就整段作廢（不稱名）。
// - greeting：送出問候前呼叫一次（每個互動 ID 最多一次；每秒 2 次、每分鐘 3 次）。互動 ID 必須是 RealtimeSessions 在
//   看著說話開始時發出、還沒用過、工作階段真的連上 20 秒內（claimGreeting），否則不帶名字。核心建立 GreetingDecision
//   （docs/14 §3 的條件），從受管理人物檔案取名稱、以 speakableName 再驗一次，從 shared/sense.ts 的固定清單挑一句（依本機時段、避開上一次；例如「George，我在」「早安，George」「我在」）。
//   稱名設定關閉、或還沒看過雲端稱名說明時一律不帶名字。API key 路徑回傳組好的 instructions；live 路徑把短句留在核心，
//   綁定那個 live 工作階段，由 server/live-route.ts 取用（takeLiveGreeting）。
// - ambient_status／ambient_probe 被拒時不說原因（原因可能透露有沒有登記家人）。
// - 身分只用於稱呼：GreetingDecision 不給任何授權流程使用。

export const SESSION_IDLE_MS = 10 * 60_000;
/** session 從開啟起算的上限（不論有沒有在用）。 */
export const SESSION_MAX_MS = 15 * 60_000;
/** 每個 session 每秒最多幾次請求（4 Hz 取樣加一點餘裕）。 */
export const SESSION_RATE_PER_S = 6;

export type ConfirmRequest =
  | { kind: "enroll"; name: string; minor: boolean }
  /**
   * memory：連結到這位家人的記憶筆數與預設是否一起刪（17 §9.4、George 決定 ⑨：成人預設不勾，未成年預設勾）。
   * count 為 null：記憶檔這次還沒開過，不為了計數去開（不碰 Keychain），畫面寫「刪除時一併處理」。
   */
  | { kind: "delete"; name: string; memory?: { count: number | null; defaultDelete: boolean } }
  /** memory：每位家人的連結記憶筆數；未成年的記憶一併刪除，成人只有勾選「同時刪除成人家人的記憶」才刪。 */
  | { kind: "clear_all"; memory?: { people: { name: string; count: number | null; minor: boolean }[] } };

/**
 * 主程序的原生確認對話框（dialog.showMessageBox）；回 true 才寫檔。
 * 刪除家人且有連結記憶時可回 { confirmed, deleteMemory }（勾選「同時刪除此人的記憶」）。
 */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean | { confirmed: boolean; deleteMemory: boolean }>;

/** 記憶層的連接點（server/memory/service.ts）；只在核心內部呼叫。 */
export interface IdentityMemoryLink {
  countForFace(personId: string): Promise<{ count: number | null; minor: boolean } | null>;
  unlinkFace(personId: string, deleteMemory: boolean): Promise<MemoryUnlinkResult>;
  /** 看著說話取樣時看到多張臉：暫停記憶的本次人物（只能降權）。 */
  suspend(reason: "multi_face"): void;
}

/** 給記憶層的臉部候選只保留這麼久（docs/16 §4：只是候選，確認後才選定）。 */
export const MEMORY_CANDIDATE_MS = 60_000;

/** 看著說話時同步辨識需要的使用者設定（camera.json；核心每次都重新讀，改了立即生效）。 */
export interface AmbientPrefs {
  look_to_talk: boolean;
  look_to_talk_greet: boolean;
  look_to_talk_greet_name: boolean;
}

export interface IdentityServiceOptions {
  store: GalleryStore;
  confirm: ConfirmFn;
  /** 鏡頭是否啟用且開著（NOUS_CAMERA=on 且使用者沒關）。 */
  camera: () => boolean;
  /** 看著說話與稱名的設定；未提供時（舊的組裝、測試）視為全部關閉，不做同步辨識也不稱名。 */
  ambient?: () => AmbientPrefs;
  /**
   * 核心發出的互動 ID 換成真的工作階段（RealtimeSessions.claimGreeting）：沒提供或回 null 時不稱名。
   * 成功一次之後同一個 ID 就不能再用。
   */
  claimGreeting?: (interaction: string) => { route: GreetingRoute; session_id: string; locale?: Locale } | null;
  /** 開場句挑選（固定清單、依時段、避開上一次）；未提供時建一個（Math.random、這台電腦的時區）。 */
  picker?: GreetingPicker;
  /** 模型與 runtime 的雜湊核對結果（啟動時算一次）。 */
  runtime: FaceRuntimeCheck;
  model: FaceModelVersion;
  now?: () => number;
  log?: (line: string) => void;
  onChange?: () => void;
  /** 記憶層（只有注入 memory 時存在）：刪除家人時解除連結或一起刪除記憶。 */
  memory?: () => IdentityMemoryLink | null;
}

/** 頁面送來的請求還沒驗證，一律當 unknown。 */
export interface IdentityContext {
  /** 主程序確認：這次 open_session 是使用者 10 秒內在選單列點的。 */
  userInitiated?: boolean;
}

interface Session {
  id: string;
  openedAt: number;
  lastUsed: number;
  calls: number[];
  evidence: EvidenceState;
  /** 相鄰兩次 probe 的間隔（毫秒，最多留 400 筆）：收起時只把統計寫進 log，供 Mac 實測判斷取樣是否夠快。 */
  probeGaps: number[];
  lastProbeAt: number | null;
}

/** 試認取樣間隔的統計（只有數字）；中位數與 p95 用 nearest-rank。 */
export function gapStats(gaps: readonly number[]): { n: number; median: number; p95: number; max: number; over_gap: number } | null {
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return { n: sorted.length, median: rank(0.5), p95: rank(0.95), max: sorted.at(-1)!, over_gap: sorted.filter((g) => g > EVIDENCE_RULES.gap_ms).length };
}

class RequestError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_ID = /^ids_[0-9a-f]{32}$/;
const PERSON_ID = /^fam_[0-9a-f]{24}$/;

function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new RequestError("bad_request", "請求格式不對");
  return v as Record<string, unknown>;
}

function modelOf(v: unknown): FaceModelVersion {
  const m = record(v);
  const s = (k: string) => {
    const x = m[k];
    if (typeof x !== "string" || x.length === 0 || x.length > 64) throw new RequestError("bad_request", "模型版本格式不對");
    return x;
  };
  return { detector: s("detector"), recognizer: s("recognizer"), align: s("align"), preproc: s("preproc") };
}

function toFeature(v: unknown): Float32Array {
  if (!isValidFeature(v)) throw new RequestError("bad_request", `特徵必須是 ${IDENTITY_FEATURE_DIM} 個有限數值且已正規化`);
  return Float32Array.from(v);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** 每位家人：各樣本 cosine 的最大值（特徵都已 normalize，內積即 cosine）。 */
function scores(people: readonly StoredPerson[], feature: Float32Array): { person: StoredPerson; score: number }[] {
  return people
    .map((person) => ({ person, score: Math.max(...person.features.map((f) => dot(f, feature))) }))
    .sort((a, b) => b.score - a.score);
}

type GalleryState = "unloaded" | "ready" | "key_unavailable" | "corrupt";

/** 看著說話時的證據（一個追蹤世代一份；換世代就丟掉）。 */
interface AmbientTrack {
  track: number;
  evidence: EvidenceState;
  /** 這個世代第一次 matched 的人；之後出現另一位就 mixed。 */
  firstMatch: string | null;
  /** 出現過多張臉，或兩位不同的家人：整個世代不稱名（docs/14 §3 條件 2）。 */
  mixed: boolean;
}

const AMBIENT_REFUSED = "目前不能取樣";

const QUIET_OPS = new Set(["probe", "ambient_probe", "ambient_status", "greeting", "ack_naming"]);

/** 記住多少個已決策的互動 ID（每個互動最多一次決策）。 */
const DECIDED_KEEP = 32;

const LIMIT_MODELS_MISSING = "辨識模型未安裝（npm run face:setup -- --product）；只能查看與刪除";
const LIMIT_MODELS_BAD = "辨識模型雜湊不符，已停用新增與試認；只能查看與刪除";
const LIMIT_CAMERA = "鏡頭未啟用或已關閉；只能查看與刪除";
const LIMIT_KEY = "無法解開家人資料的金鑰（可能沒有允許鑰匙圈存取）：關閉後重新打開「家人辨識…」並在系統詢問時按「允許」，或重新啟動 Nous。資料沒有被改動";
const LIMIT_CORRUPT = "家人資料檔損壞或被改動，無法解密：只能清除全部家人資料後重新登記";

export class IdentityService {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private people: StoredPerson[] = [];
  private versions: GalleryVersions = { key_generation: 0, gallery_version: 0 };
  private gallery: GalleryState = "unloaded";
  /** 上次寫入（或載入）後磁碟上應該有的 gallery_version；null＝沒有檔案。 */
  private expectedDisk: number | null = null;
  private session: Session | null = null;
  /** 任何 session 開關或 gallery 改變都加一；頁面與證據以它判斷舊結果作廢。 */
  private epoch = 0;
  /** 會改資料的操作正在進行（含等待原生確認）。 */
  private mutating = false;
  /** 核心關閉中（shutdown）：之後的請求一律拒絕，等待中的確認回來也不寫。 */
  private closed = false;
  /** 看著說話的同步辨識（ID-02）。 */
  private ambient: AmbientTrack | null = null;
  private readonly ambientCalls: number[] = [];
  private readonly greetingCalls: number[] = [];
  private readonly greetingMinute: number[] = [];
  /** 已做過問候決策的互動 ID。 */
  private readonly decided: string[] = [];
  /** live 路徑：已組好、等 server/live-route.ts 取用的短句（一次只有一個互動）。 */
  private pendingLive: { locale: Locale; interaction: string; session_id: string; named: boolean; text: string; sentence: string; at: number } | null = null;
  private readonly picker: GreetingPicker;
  /** 最近一次比對成功、沒有多臉的問候決策（給記憶層當人物候選；同一追蹤世代、60 秒內）。 */
  private lastMatch: { person_id: string; track: number; at: number } | null = null;

  constructor(private readonly options: IdentityServiceOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.picker = options.picker ?? new GreetingPicker({ now: this.now });
  }

  private encryptionAvailable(): boolean {
    return this.options.store.encryptionAvailable();
  }

  /** 第一次開 session（或上次解不開金鑰）時載入；已載入或檔案損壞時不重讀。 */
  private ensureLoaded(): void {
    if (this.gallery === "ready" || this.gallery === "corrupt") return;
    this.options.store.prepare();
    const loaded = this.options.store.load();
    if (!loaded.ok) {
      this.gallery = loaded.reason;
      this.people = [];
      this.expectedDisk = this.options.store.diskVersion();
      this.log(`identity: gallery 無法載入（${loaded.reason}）；不覆寫`);
      return;
    }
    this.gallery = "ready";
    this.people = loaded.data.people;
    this.versions = { key_generation: loaded.key_generation, gallery_version: loaded.gallery_version };
    this.expectedDisk = this.options.store.exists() ? loaded.gallery_version : null;
    const count = this.people.length;
    const bad = this.people.filter((p) => p.damaged).length;
    this.log(`identity: 已載入（${count} 位，壞資料 ${bad} 位，gallery_version ${this.versions.gallery_version}，key_generation ${this.versions.key_generation}）`);
  }

  /** 鏡頭與模型造成的限制（不看 gallery）。 */
  private runtimeLimit(): string | null {
    const runtime = this.options.runtime.state;
    if (runtime === "missing" || runtime === "not_configured") return LIMIT_MODELS_MISSING;
    if (runtime === "hash_mismatch") return LIMIT_MODELS_BAD;
    if (!this.options.camera()) return LIMIT_CAMERA;
    return null;
  }

  /** settings.identity：只有選單列需要的欄位，不含人數、世代、姓名或 person_id。 */
  status(): IdentityStatus {
    if (this.closed) return { available: false, disabled_reason: "核心重新啟動中", limited_reason: null };
    if (!this.encryptionAvailable()) return { available: false, disabled_reason: "此 Mac 無法加密保存（safeStorage 不可用），家人辨識停用", limited_reason: null };
    return { available: true, disabled_reason: null, limited_reason: this.runtimeLimit() };
  }

  /** 管理畫面的狀態（只經 IPC 給已開 session 的頁面）。 */
  private manageStatus(): IdentityManageStatus {
    const state = this.gallery === "ready" || this.gallery === "unloaded" ? "ready" : this.gallery;
    const limited = state === "key_unavailable" ? LIMIT_KEY : state === "corrupt" ? LIMIT_CORRUPT : this.runtimeLimit();
    return {
      state,
      limited_reason: limited,
      count: this.people.length,
      max: FAMILY_MAX,
      needs_reenroll: this.people.filter((p) => !sameModelVersion(p.model, this.options.model)).length,
      damaged: this.people.filter((p) => p.damaged).length,
      gallery_version: this.versions.gallery_version,
      epoch: this.epoch,
      models: this.options.runtime.state,
      backup_exclusion: this.options.store.backupExclusion(),
      calibrated: CALIBRATED,
      naming_notice_seen: this.options.store.namingNoticeSeen(),
    };
  }

  /** 主程序：主視窗導覽、重新載入或 renderer 結束時呼叫；結束 session（已存資料不動）。 */
  closeSessions(): void {
    if (!this.session) return;
    this.endSession(this.session);
    this.session = null;
    this.bump();
  }

  /** 核心關閉：結束 session，之後一律拒絕；等待中的原生確認回來後也不寫。 */
  shutdown(): void {
    this.closed = true;
    this.dropAmbient();
    this.closeSessions();
  }

  /** 登記資料改變或核心關閉：撤銷看著說話的證據與等待取用的短句（docs/14 §3 條件 4、ADR-0001 §2.2）。 */
  private dropAmbient(): void {
    this.ambient = null;
    this.pendingLive = null;
    this.lastMatch = null;
  }

  /**
   * 只給記憶層（核心內部）：最近一次比對成功、MEMORY_CANDIDATE_MS 內、同一追蹤世代、沒有多臉的決策。
   * 這只是「這次用 X 的偏好？」的候選，不是授權；記憶層要使用者確認後才選定人物。
   */
  memoryCandidate(): { person_id: string; name: string; at: number } | null {
    const m = this.lastMatch;
    if (!m || this.now() - m.at > MEMORY_CANDIDATE_MS) return null;
    if (this.ambient && this.ambient.track !== m.track) return null;
    const person = this.comparable().find((p) => p.person_id === m.person_id);
    return person ? { person_id: person.person_id, name: person.name, at: m.at } : null;
  }

  /** 只給記憶層：已登記的家人（連結到既有人物用）；家人資料還沒載入時回 null，不在這裡碰 Keychain。 */
  memoryPeople(): { person_id: string; name: string; minor: boolean }[] | null {
    if (this.gallery !== "ready") return null;
    return this.people.map((p) => ({ person_id: p.person_id, name: p.name, minor: p.minor }));
  }

  /** IPC 進來的請求（已由 desktop/identity-ipc.mjs 過濾形狀；這裡仍完整驗證，核心為權威）。 */
  async handle(raw: unknown, ctx: IdentityContext = {}): Promise<IdentityResponse> {
    const started = this.now();
    let op = "unknown";
    try {
      const req = record(raw);
      // 只記白名單裡的 op 名稱；頁面送來的任意字串不進 log。
      op = (IDENTITY_OPS as readonly unknown[]).includes(req.op) ? (req.op as string) : "unknown";
      if (this.closed) throw new RequestError("closed", "Nous 核心正在重新啟動，請稍後從選單列重新打開");
      const res = await this.dispatch(op, req, ctx);
      // 取樣（probe、ambient_probe 約 4 Hz）與狀態查詢不逐筆記；問候決策自己記一行原因。
      if (!QUIET_OPS.has(op)) this.log(`identity: ${op} ok（${Math.round(this.now() - started)} ms，epoch ${this.epoch}，gallery_version ${this.versions.gallery_version}）`);
      return res;
    } catch (err) {
      if (err instanceof RequestError) {
        if (err.code !== "rate_limited") this.log(`identity: ${op} 拒絕（${err.code}）`);
        return { ok: false, code: err.code, message: err.message };
      }
      // 只記錯誤代碼（例如 ENOSPC）或類別，不記訊息：訊息可能帶路徑或內容。
      const code = (err as { code?: unknown } | null)?.code;
      const kind = typeof code === "string" ? code : err instanceof Error ? err.constructor.name : "error";
      this.log(`identity: ${op} 失敗（${kind}）`);
      return { ok: false, code: "write_failed", message: "家人資料沒有保存（寫入失敗）；原本的資料沒有改變" };
    }
  }

  private async dispatch(op: string, req: Record<string, unknown>, ctx: IdentityContext): Promise<IdentityResponse> {
    if (op === "open_session") return this.openSession(ctx);
    if (op === "ambient_status") return this.ambientStatus();
    if (op === "ambient_probe") return this.ambientProbe(req);
    if (op === "greeting") return this.greeting(req);
    if (op === "close_session") {
      this.closeSession(req.session);
      return { ok: true, op: "close_session" };
    }
    const session = this.useSession(req.session);
    switch (op) {
      case "list":
        return { ok: true, op: "list", ...this.manageView(session) };
      case "probe":
        return this.probe(session, req);
      case "enroll":
        return this.mutate(() => this.enroll(session, req));
      case "delete":
        return this.mutate(() => this.remove(session, req));
      case "clear_all":
        return this.mutate(() => this.clearAll(session));
      case "ack_naming":
        this.options.store.markNamingNoticeSeen(new Date(this.now()).toISOString());
        this.log("identity: 已看過雲端稱名說明");
        return { ok: true, op: "ack_naming", ...this.manageView(session) };
      default:
        throw new RequestError("bad_request", "不認得的操作");
    }
  }

  /** 會改資料的操作同時只能有一個（避免疊出多個原生對話框，或用過期的去重資料）。 */
  private async mutate(run: () => Promise<IdentityResponse>): Promise<IdentityResponse> {
    if (this.mutating) throw new RequestError("busy", "另一個變更還在進行（可能在等系統確認）");
    this.mutating = true;
    try {
      return await run();
    } finally {
      this.mutating = false;
    }
  }

  private openSession(ctx: IdentityContext): IdentityResponse {
    if (ctx.userInitiated !== true) throw new RequestError("not_user_initiated", "請從選單列「鏡頭與語音設定 → 家人辨識…」打開");
    const st = this.status();
    if (!st.available) throw new RequestError("unavailable", st.disabled_reason ?? "家人辨識不可用");
    this.ensureLoaded();
    if (this.session) this.endSession(this.session);
    const now = this.now();
    this.session = { id: `ids_${randomBytes(16).toString("hex")}`, openedAt: now, lastUsed: now, calls: [], evidence: EMPTY_EVIDENCE, probeGaps: [], lastProbeAt: null };
    this.bump();
    return { ok: true, op: "open_session", ...this.manageView(this.session) };
  }

  /** 收起畫面：session 與記憶體中的證據丟掉，已存的資料不動。 */
  private closeSession(id: unknown): void {
    if (this.session && this.session.id === id) this.closeSessions();
  }

  /** session 結束：只記試認取樣間隔的統計（數字），供實測判斷「相鄰兩格 ≤ 500 ms」是否做得到。 */
  private endSession(session: Session): void {
    const st = gapStats(session.probeGaps);
    if (st) this.log(`identity: 試認取樣間隔（${st.n} 個，中位數 ${st.median} ms，p95 ${st.p95} ms，最大 ${st.max} ms，超過 ${EVIDENCE_RULES.gap_ms} ms 有 ${st.over_gap} 個）`);
  }

  private useSession(id: unknown): Session {
    const s = this.session;
    const now = this.now();
    if (!s || typeof id !== "string" || !SESSION_ID.test(id) || s.id !== id) throw new RequestError("no_session", "家人辨識畫面已失效，請從選單列重新打開");
    if (now - s.lastUsed > SESSION_IDLE_MS || now - s.openedAt > SESSION_MAX_MS) {
      this.closeSessions();
      throw new RequestError("no_session", "家人辨識畫面已開太久或閒置太久，請從選單列重新打開");
    }
    s.calls = s.calls.filter((t) => now - t < 1000);
    if (s.calls.length >= SESSION_RATE_PER_S) throw new RequestError("rate_limited", "請求太頻繁");
    s.calls.push(now);
    s.lastUsed = now;
    return s;
  }

  private manageView(session: Session): IdentityManageView {
    return { session: session.id, people: this.members(), status: this.manageStatus() };
  }

  private members(): FamilyMember[] {
    return this.people.map((p) => ({
      person_id: p.person_id,
      name: p.name,
      minor: p.minor,
      created_at: p.created_at,
      needs_reenroll: !sameModelVersion(p.model, this.options.model),
      damaged: p.damaged === true,
    }));
  }

  private requireReady(what: string): void {
    const st = this.manageStatus();
    if (st.state !== "ready" || st.limited_reason) throw new RequestError("unavailable", st.limited_reason ?? `${what}目前不可用`);
  }

  private requireModel(req: Record<string, unknown>): void {
    if (!sameModelVersion(modelOf(req.model), this.options.model)) throw new RequestError("model_mismatch", "頁面的模型版本與核心不同，請重新整理");
  }

  /** 只與模型版本相符、資料完好的家人比對。 */
  private comparable(): StoredPerson[] {
    return this.people.filter((p) => !p.damaged && sameModelVersion(p.model, this.options.model));
  }

  private matchFrame(req: Record<string, unknown>): FrameMatch {
    const faces = req.face_count;
    if (typeof faces !== "number" || !Number.isInteger(faces) || faces < 0 || faces > 64) throw new RequestError("bad_request", "face_count 格式不對");
    const quality = req.quality;
    if (!(QUALITY_REASONS as readonly unknown[]).includes(quality)) throw new RequestError("bad_request", "quality 格式不對");
    if (faces > 1 || quality === "multi_face") return { kind: "ambiguous", reason: "multi_face" };
    if (faces === 0 || quality === "no_face" || quality === "no_frame") return { kind: "unavailable", reason: "no_face" };
    if ((quality as QualityReason) !== "ok") {
      if (req.feature !== undefined) throw new RequestError("bad_request", "品質不足的畫格不能帶特徵");
      return { kind: "unavailable", reason: "quality" };
    }
    const feature = toFeature(req.feature);
    const people = this.comparable();
    if (people.length === 0) return { kind: "unavailable", reason: "no_gallery" };
    const ranked = scores(people, feature);
    feature.fill(0);
    const [first, second] = ranked;
    if (!first || first.score < MATCH_THRESHOLDS.match) return { kind: "unknown" };
    if (second && first.score - second.score < MATCH_THRESHOLDS.margin) return { kind: "ambiguous", reason: "margin" };
    return { kind: "matched", person_id: first.person.person_id };
  }

  private probe(session: Session, req: Record<string, unknown>): IdentityResponse {
    this.requireReady("試認");
    this.requireModel(req);
    const gen = req.gen;
    if (typeof gen !== "number" || !Number.isInteger(gen) || gen < 0) throw new RequestError("bad_request", "gen 格式不對");
    const match = this.matchFrame(req);
    const now = this.now();
    if (session.lastProbeAt !== null && session.probeGaps.length < 400) session.probeGaps.push(now - session.lastProbeAt);
    session.lastProbeAt = now;
    const scope = { gen, epoch: this.epoch, gallery_version: this.versions.gallery_version };
    session.evidence = pushEvidence(session.evidence, { t: now, gen, match }, scope);
    return { ok: true, op: "probe", observation: decideIdentity(session.evidence, now, scope) };
  }

  // ─────────────── ID-02：看著說話時同步辨識與問候決策 ───────────────

  private ambientPrefs(): AmbientPrefs {
    return this.options.ambient?.() ?? { look_to_talk: false, look_to_talk_greet: false, look_to_talk_greet_name: false };
  }

  /** 看著說話時同步辨識不能做的原因；null＝可以。不載入 gallery（不碰 Keychain）。 */
  private ambientBlock(): string | null {
    const prefs = this.ambientPrefs();
    if (!prefs.look_to_talk || !prefs.look_to_talk_greet) return "看著說話或打招呼關閉";
    if (!prefs.look_to_talk_greet_name) return "稱名關閉";
    const st = this.status();
    if (!st.available) return st.disabled_reason ?? "家人辨識不可用";
    if (st.limited_reason) return st.limited_reason;
    if (this.session) return "家人辨識畫面開著";
    if (this.gallery === "key_unavailable" || this.gallery === "corrupt") return "家人資料解不開";
    if (this.gallery === "unloaded" ? !this.options.store.exists() : this.comparable().length === 0) return "沒有可比對的家人";
    return null;
  }

  private ambientStatus(): IdentityResponse {
    return { ok: true, op: "ambient_status", ready: this.ambientBlock() === null };
  }

  /** 取樣與問候決策各自限速（每秒 6 格；問候決策每秒 2 次、每分鐘 3 次，正常每次互動只有一次）。 */
  private ambientRate(calls: number[], max: number, windowMs = 1000): void {
    const now = this.now();
    const recent = calls.filter((t) => now - t < windowMs);
    calls.splice(0, calls.length, ...recent);
    if (calls.length >= max) throw new RequestError("rate_limited", "請求太頻繁");
    calls.push(now);
  }

  private ambientScope(track: number): EvidenceScope {
    return { gen: track, epoch: this.epoch, gallery_version: this.versions.gallery_version };
  }

  /**
   * 看著說話的面向等待期間的一格。回應一律只有 ok（不回 matched／unknown），頁面拿不到結果；
   * 證據留在核心，送出問候前由 greeting 讀取。第一次（gallery 檔存在時）才載入 gallery。
   */
  private ambientProbe(req: Record<string, unknown>): IdentityResponse {
    this.ambientRate(this.ambientCalls, SESSION_RATE_PER_S);
    // 被拒時不說原因：「沒有可比對的家人」之類的原因會透露有沒有登記家人。
    if (this.ambientBlock()) throw new RequestError("unavailable", AMBIENT_REFUSED);
    this.ensureLoaded();
    if (this.gallery !== "ready") throw new RequestError("unavailable", AMBIENT_REFUSED);
    this.requireModel(req);
    const track = req.track;
    if (typeof track !== "number" || !Number.isInteger(track) || track < 0) throw new RequestError("bad_request", "track 格式不對");
    const match = this.matchFrame(req);
    const now = this.now();
    if (!this.ambient || this.ambient.track !== track) this.ambient = { track, evidence: EMPTY_EVIDENCE, firstMatch: null, mixed: false };
    if (this.lastMatch && this.lastMatch.track !== track) this.lastMatch = null;
    const a = this.ambient;
    if (match.kind === "ambiguous" && match.reason === "multi_face") {
      a.mixed = true;
      this.lastMatch = null;
      // 多人入鏡：記憶的本次人物暫停（只降權）。
      this.options.memory?.()?.suspend("multi_face");
    }
    if (match.kind === "matched") {
      a.firstMatch ??= match.person_id;
      if (a.firstMatch !== match.person_id) a.mixed = true;
    }
    a.evidence = pushEvidence(a.evidence, { t: now, gen: track, match }, this.ambientScope(track));
    return { ok: true, op: "ambient_probe" };
  }

  /**
   * 送出問候前的決策（docs/14 §3）。頁面負責它看得到的條件（eligible：同一互動與追蹤世代、仍在近距離面向、
   * 只有一張臉、辨識沒有出錯）；核心負責其餘：同一追蹤世代、沒有混到別人、證據 ≥3 格且最新 ≤1 秒、person 仍存在且
   * gallery 版本沒變、稱名設定仍開。任一項不符就不帶名字（仍說「我在」）。每個互動 ID 最多決策一次。
   */
  private greeting(req: Record<string, unknown>): IdentityResponse {
    const interaction = req.interaction;
    if (typeof interaction !== "string" || !INTERACTION_ID.test(interaction)) throw new RequestError("bad_request", "interaction 格式不對");
    const track = req.track;
    if (typeof track !== "number" || !Number.isInteger(track) || track < 0) throw new RequestError("bad_request", "track 格式不對");
    if (typeof req.eligible !== "boolean") throw new RequestError("bad_request", "eligible 格式不對");
    if (req.route !== "api_key" && req.route !== "live") throw new RequestError("bad_request", "route 格式不對");
    const route: GreetingRoute = req.route;
    if (this.decided.includes(interaction)) throw new RequestError("already", "這次互動已經決定過問候");
    this.ambientRate(this.greetingCalls, GREETING_RATE.per_second);
    this.ambientRate(this.greetingMinute, GREETING_RATE.per_minute, 60_000);
    this.decided.push(interaction);
    if (this.decided.length > DECIDED_KEEP) this.decided.shift();

    // 互動 ID 必須換得到核心自己知道的、真的連上的工作階段（頁面自己編的 ID 不給名字）。
    const claim = this.options.claimGreeting?.(interaction) ?? null;
    const session = claim && claim.route === route ? claim : null;
    const decision = this.decide(interaction, track, req.eligible, session !== null);
    const person = decision.person_id ? this.people.find((p) => p.person_id === decision.person_id) : undefined;
    const name = person ? speakableName(person.name) : null;
    // 從固定清單挑一句（依時段、避開上一次）；log 只記模板編號，不記句子。
    const locale = normalizeLocale(session?.locale);
    const picked = this.picker.pick(name, locale);
    const sentence = picked.sentence;
    // 只有原因與數字（給 Mac 實測對照時序）：證據格數、跨度與最新一格多久以前；不記姓名、person_id 或分數。
    const ev = this.ambient?.track === track ? this.ambient.evidence.frames : [];
    const span = ev.length ? Math.round(ev.at(-1)!.t - ev[0]!.t) : 0;
    const age = decision.evidence_at === null ? "—" : `${Math.round(decision.decided_at - decision.evidence_at)} ms`;
    this.log(`identity: 問候決策（${route}，${decision.reason ?? "ok"}，世代 ${track}，連續證據 ${ev.length} 格／${span} ms，最新 ${age} 前，模板 ${picked.id}，門檻未校準）`);
    // 證據只為這一次問候存在：決策後丟掉，晚到的推論不能讓下一次互動沿用。
    this.ambient = null;
    this.lastMatch = decision.person_id && decision.reason === null ? { person_id: decision.person_id, track, at: this.now() } : null;
    if (route === "api_key") return { ok: true, op: "greeting", text: greetingInstructions(sentence, locale) };
    this.pendingLive = session ? { locale, interaction, session_id: session.session_id, named: name !== null, text: liveGreetingText(sentence, locale), sentence, at: this.now() } : null;
    return { ok: true, op: "greeting", text: null };
  }

  /** 建立 GreetingDecision（只在核心）。名稱驗證不過時改成不稱名。 */
  private decide(interaction: string, track: number, eligible: boolean, claimed: boolean): GreetingDecision {
    const now = this.now();
    const base = { interaction_id: interaction, track_generation: track, gallery_version: this.versions.gallery_version, decided_at: now, calibrated: CALIBRATED };
    const last = this.ambient?.track === track ? this.ambient.evidence.frames.at(-1) : undefined;
    const plain = (reason: GreetingNameReason): GreetingDecision => ({ ...base, person_id: null, evidence_at: last?.t ?? null, reason });
    if (!this.ambientPrefs().look_to_talk_greet_name) return plain("naming_off");
    if (!claimed) return plain("no_session");
    if (!this.options.store.namingNoticeSeen()) return plain("notice_unseen");
    if (!eligible) return plain("not_eligible");
    if (this.ambientBlock()) return plain("unavailable");
    const a = this.ambient;
    if (!a) return plain("no_evidence");
    if (a.track !== track) return plain("track_changed");
    if (a.mixed) return plain("multi_face");
    const obs = decideIdentity(a.evidence, now, this.ambientScope(track));
    if (obs.state !== "matched" || !obs.person_id) {
      const reason: GreetingNameReason = obs.state === "unknown" ? "unknown" : obs.state === "ambiguous" ? (obs.reason === "multi_face" ? "multi_face" : "ambiguous") : ((obs.reason ?? "collecting") as GreetingNameReason);
      return plain(reason);
    }
    const person = this.comparable().find((p) => p.person_id === obs.person_id);
    if (!person) return plain("person_gone");
    if (!speakableName(person.name)) return plain("bad_name");
    return { ...base, person_id: person.person_id, evidence_at: last?.t ?? null, reason: null };
  }

  /**
   * server/live-route.ts 取用 live 路徑的短句（頁面 POST greeting 帶來的只有互動 ID）。只有同一個互動、同一個 live 工作階段、
   * LIVE_GREETING_PICKUP_MS 內才給，取一次就清掉；稱名在這之間被關掉時改挑一句不含名字的。找不到時回 null
   * （server/nous.ts 的 liveGreetingSource 改挑一句不含名字的）。回傳整段文字與那一句（逐字稿緩衝用來認出問候）。
   */
  takeLiveGreeting(interaction: string, sessionId: string): { text: string; sentence: string } | null {
    const pending = this.pendingLive;
    this.pendingLive = null;
    if (!pending || pending.interaction !== interaction || pending.session_id !== sessionId || this.now() - pending.at > LIVE_GREETING_PICKUP_MS) return null;
    if (pending.named && !this.ambientPrefs().look_to_talk_greet_name) return this.picker.plainLive(pending.locale);
    return { text: pending.text, sentence: pending.sentence };
  }

  /** 等待原生確認之後：核心關閉、session 換掉或 gallery 已被改過就不寫。 */
  private afterConfirm(session: Session, what: string): void {
    if (this.closed) throw new RequestError("closed", `Nous 核心正在重新啟動，${what}`);
    if (this.session !== session) throw new RequestError("no_session", `家人辨識畫面已失效，${what}`);
  }

  private async enroll(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    this.requireReady("新增家人");
    this.requireModel(req);
    if (this.people.length >= FAMILY_MAX) throw new RequestError("full", `最多 ${FAMILY_MAX} 位家人`);
    const name = parseFamilyName(req.name);
    if (!name.ok) throw new RequestError("bad_name", name.error);
    if (req.consent !== true) throw new RequestError("consent_required", "需要本人在場並同意");
    if (typeof req.minor !== "boolean") throw new RequestError("bad_request", "minor 格式不對");
    if (req.minor && req.guardian_confirmed !== true) throw new RequestError("guardian_required", "未成年家人需要家長確認同意");
    const raw = req.samples;
    if (!Array.isArray(raw) || raw.length < ENROLL_MIN_SAMPLES || raw.length > ENROLL_MAX_SAMPLES) {
      throw new RequestError("bad_samples", `需要 ${ENROLL_MIN_SAMPLES}–${ENROLL_MAX_SAMPLES} 張樣本`);
    }
    const samples = raw.map(toFeature);
    // 樣本一致性：每張都要接近樣本的平均方向，任兩張也不能差太多，否則可能混到別人或品質太差。
    const mean = new Float32Array(IDENTITY_FEATURE_DIM);
    for (const f of samples) for (let i = 0; i < mean.length; i++) mean[i]! += f[i]!;
    const norm = Math.hypot(...mean);
    for (let i = 0; i < mean.length; i++) mean[i] = mean[i]! / (norm || 1);
    const pairLow = samples.some((f, i) => samples.some((g, j) => j > i && dot(f, g) < MATCH_THRESHOLDS.consistency_pair));
    if (pairLow || samples.some((f) => dot(f, mean) < MATCH_THRESHOLDS.consistency)) {
      throw new RequestError("inconsistent_samples", "這批樣本看起來不是同一個人或品質不穩定，請重新取樣");
    }
    // 去重：多數樣本都和某位已登記的家人相符時，不新增、不覆蓋。不回是哪一位（避免拿登記當探測工具）。
    for (const existing of this.comparable()) {
      const hits = samples.filter((f) => Math.max(...existing.features.map((g) => dot(f, g))) >= MATCH_THRESHOLDS.match).length;
      if (hits * 2 > samples.length) throw new RequestError("duplicate", "這個人看起來可能已經登記過；不會覆蓋。要重新登記請先刪除原本的資料");
    }
    const minor = req.minor;
    if (!(await this.options.confirm({ kind: "enroll", name: name.name, minor }))) {
      throw new RequestError("declined", "沒有確認，未保存");
    }
    this.afterConfirm(session, "未保存");
    if (this.people.length >= FAMILY_MAX) throw new RequestError("full", `最多 ${FAMILY_MAX} 位家人`);
    const at = new Date(this.now()).toISOString();
    const person: StoredPerson = {
      person_id: `fam_${randomBytes(12).toString("hex")}`,
      name: name.name,
      minor,
      created_at: at,
      updated_at: at,
      model: { ...this.options.model },
      features: samples,
    };
    this.commit([...this.people, person]);
    // 登記的同意說明已寫明「開啟稱名時，名字會以短句送到雲端語音供應商」：同意並保存後也算看過（ID-02）。
    this.options.store.markNamingNoticeSeen(at);
    return { ok: true, op: "enroll", ...this.manageView(session) };
  }

  private async remove(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    if (this.gallery !== "ready") throw new RequestError("unavailable", this.manageStatus().limited_reason ?? "家人資料不可用");
    const id = req.person_id;
    const target = typeof id === "string" && PERSON_ID.test(id) ? this.people.find((p) => p.person_id === id) : undefined;
    if (!target) throw new RequestError("not_found", "找不到這位家人");
    // 連結的記憶筆數（記憶不可用或沒有連結時不問）：未成年預設一起刪，成人預設只解除連結（George 決定 ⑨）。
    const memory = this.options.memory?.() ?? null;
    const linked = memory ? await memory.countForFace(target.person_id).catch(() => null) : null;
    const answer = await this.options.confirm({ kind: "delete", name: target.name, ...(linked ? { memory: { count: linked.count, defaultDelete: target.minor || linked.minor } } : {}) });
    const confirmed = typeof answer === "boolean" ? answer : answer.confirmed === true;
    if (!confirmed) throw new RequestError("declined", "沒有確認，未刪除");
    this.afterConfirm(session, "未刪除");
    if (!this.people.includes(target)) throw new RequestError("not_found", "找不到這位家人");
    this.commit(this.people.filter((p) => p !== target));
    // 寫檔成功後才清零被刪者的特徵；寫入失敗時資料與比對都保持原樣。
    for (const f of target.features) f.fill(0);
    // 記憶：不勾只解除連結並撤銷本次人物，不默默刪記憶（16 §8）；勾選才刪除整個人物記憶。結果照實回給畫面。
    let result: MemoryUnlinkResult | undefined;
    if (memory && linked) {
      const deleteMemory = typeof answer === "object" && answer.deleteMemory === true;
      result = await memory.unlinkFace(target.person_id, deleteMemory).catch((): MemoryUnlinkResult => "failed");
      if (result === "failed") this.log("identity: 記憶連結解除失敗");
    }
    return { ok: true, op: "delete", ...(result ? { memory: result } : {}), ...this.manageView(session) };
  }

  private async clearAll(session: Session): Promise<IdentityResponse> {
    if (this.gallery !== "corrupt" && this.gallery !== "ready") throw new RequestError("unavailable", this.manageStatus().limited_reason ?? "目前不能清除");
    // 每位家人連結的記憶（不為了計數去開記憶檔）：未成年一併刪除，成人只有勾選才刪，否則只解除連結並暫停本次人物。
    const memory = this.options.memory?.() ?? null;
    const linked: { person: StoredPerson; count: number | null; minor: boolean }[] = [];
    if (memory) for (const p of this.people) {
      const c = await memory.countForFace(p.person_id).catch(() => null);
      if (c) linked.push({ person: p, count: c.count, minor: p.minor || c.minor });
    }
    const answer = await this.options.confirm({ kind: "clear_all", ...(linked.length ? { memory: { people: linked.map(l => ({ name: l.person.name, count: l.count, minor: l.minor })) } } : {}) });
    const confirmed = typeof answer === "boolean" ? answer : answer.confirmed === true;
    if (!confirmed) throw new RequestError("declined", "沒有確認，未清除");
    this.afterConfirm(session, "未清除");
    const deleteAdults = typeof answer === "object" && answer.deleteMemory === true;
    const ids = linked.map(l => ({ id: l.person.person_id, del: l.minor || deleteAdults }));
    this.options.store.remove();
    for (const p of this.people) for (const f of p.features) f.fill(0);
    this.people = [];
    this.gallery = "ready";
    this.expectedDisk = null;
    // 這次執行期間世代不倒退（舊結果因版本不符被丟掉）；檔案已刪，重新啟動後世代從 0 重新開始。
    this.versions = { key_generation: this.versions.key_generation + 1, gallery_version: this.versions.gallery_version + 1 };
    session.evidence = EMPTY_EVIDENCE;
    this.dropAmbient();
    this.bump();
    let result: MemoryUnlinkResult | undefined;
    if (memory && ids.length) {
      const results = await Promise.all(ids.map(x => memory.unlinkFace(x.id, x.del).catch((): MemoryUnlinkResult => "failed")));
      result = results.includes("failed") ? "failed" : results.includes("deleted") ? "deleted" : results.includes("unlinked") ? "unlinked" : "none";
      if (result === "failed") this.log("identity: 記憶連結解除失敗");
    }
    return { ok: true, op: "clear_all", ...(result ? { memory: result } : {}), ...this.manageView(session) };
  }

  /**
   * 寫檔（新資料金鑰）成功後才換掉記憶體中的資料；失敗時原本的資料不變。
   * 寫入前核對磁碟上的 gallery_version：被別的程序（例如另一個核心）改過就拒絕，不用舊資料蓋掉。
   */
  private commit(people: StoredPerson[]): void {
    if (this.options.store.diskVersion() !== this.expectedDisk) {
      throw new RequestError("stale_gallery", "家人資料在別處被改過；請關閉後重新打開「家人辨識…」");
    }
    this.versions = this.options.store.save({ people }, this.versions);
    this.expectedDisk = this.versions.gallery_version;
    this.people = people;
    if (this.session) this.session.evidence = EMPTY_EVIDENCE;
    this.dropAmbient();
    this.bump();
  }

  private bump(): void {
    this.epoch++;
    this.options.onChange?.();
  }
}
