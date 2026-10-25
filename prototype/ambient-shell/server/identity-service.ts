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
  sameModelVersion,
  type EvidenceState,
  type FaceModelVersion,
  type FamilyMember,
  type FrameMatch,
  type IdentityErrorCode,
  type IdentityManageStatus,
  type IdentityManageView,
  type IdentityResponse,
  type IdentityStatus,
  type QualityReason,
} from "../shared/identity.ts";
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

export const SESSION_IDLE_MS = 10 * 60_000;
/** session 從開啟起算的上限（不論有沒有在用）。 */
export const SESSION_MAX_MS = 15 * 60_000;
/** 每個 session 每秒最多幾次請求（4 Hz 取樣加一點餘裕）。 */
export const SESSION_RATE_PER_S = 6;

export type ConfirmRequest =
  | { kind: "enroll"; name: string; minor: boolean }
  | { kind: "delete"; name: string }
  | { kind: "clear_all" };

/** 主程序的原生確認對話框（dialog.showMessageBox）；回 true 才寫檔。 */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;

export interface IdentityServiceOptions {
  store: GalleryStore;
  confirm: ConfirmFn;
  /** 鏡頭是否啟用且開著（NOUS_CAMERA=on 且使用者沒關）。 */
  camera: () => boolean;
  /** 模型與 runtime 的雜湊核對結果（啟動時算一次）。 */
  runtime: FaceRuntimeCheck;
  model: FaceModelVersion;
  now?: () => number;
  log?: (line: string) => void;
  onChange?: () => void;
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

  constructor(private readonly options: IdentityServiceOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
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
    this.closeSessions();
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
      if (op !== "probe") this.log(`identity: ${op} ok（${Math.round(this.now() - started)} ms，epoch ${this.epoch}，gallery_version ${this.versions.gallery_version}）`);
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
    return { ok: true, op: "enroll", ...this.manageView(session) };
  }

  private async remove(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    if (this.gallery !== "ready") throw new RequestError("unavailable", this.manageStatus().limited_reason ?? "家人資料不可用");
    const id = req.person_id;
    const target = typeof id === "string" && PERSON_ID.test(id) ? this.people.find((p) => p.person_id === id) : undefined;
    if (!target) throw new RequestError("not_found", "找不到這位家人");
    if (!(await this.options.confirm({ kind: "delete", name: target.name }))) throw new RequestError("declined", "沒有確認，未刪除");
    this.afterConfirm(session, "未刪除");
    if (!this.people.includes(target)) throw new RequestError("not_found", "找不到這位家人");
    this.commit(this.people.filter((p) => p !== target));
    // 寫檔成功後才清零被刪者的特徵；寫入失敗時資料與比對都保持原樣。
    for (const f of target.features) f.fill(0);
    return { ok: true, op: "delete", ...this.manageView(session) };
  }

  private async clearAll(session: Session): Promise<IdentityResponse> {
    if (this.gallery !== "corrupt" && this.gallery !== "ready") throw new RequestError("unavailable", this.manageStatus().limited_reason ?? "目前不能清除");
    if (!(await this.options.confirm({ kind: "clear_all" }))) throw new RequestError("declined", "沒有確認，未清除");
    this.afterConfirm(session, "未清除");
    this.options.store.remove();
    for (const p of this.people) for (const f of p.features) f.fill(0);
    this.people = [];
    this.gallery = "ready";
    this.expectedDisk = null;
    // 這次執行期間世代不倒退（舊結果因版本不符被丟掉）；檔案已刪，重新啟動後世代從 0 重新開始。
    this.versions = { key_generation: this.versions.key_generation + 1, gallery_version: this.versions.gallery_version + 1 };
    session.evidence = EMPTY_EVIDENCE;
    this.bump();
    return { ok: true, op: "clear_all", ...this.manageView(session) };
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
    this.bump();
  }

  private bump(): void {
    this.epoch++;
    this.options.onChange?.();
  }
}
