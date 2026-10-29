import { randomBytes } from "node:crypto";
import {
  CARD_ID,
  FACT_ID,
  MANAGE_TOKEN,
  MEMORY_EXCERPT_MAX,
  MEMORY_FACT_MAX,
  MEMORY_OPS,
  MEMORY_PROFILE_MAX,
  MEMORY_VALUE_MAX,
  PROFILE_ID,
  TURN_NONCE,
  type ClarifyChoice,
  type MemoryCardView,
  type MemoryErrorCode,
  type MemoryFactView,
  type MemoryPresenceView,
  type MemoryReceiptStatus,
  type MemoryReceiptView,
  type MemoryResponse,
  type MemorySettingsStatus,
  type MemoryStatusView,
  type MemoryTargetView,
  type MemoryText,
  type MemoryTurnView,
  type PresenceState,
} from "../../shared/memory.ts";
import { literalCommand, MemoryBoundary, type MemoryCommand, type MemorySession, type ParsedMemoryCommand, type Subject } from "./boundary.ts";
import { chatText, keyOf, parseMemoryText, topicOf, type ParsedSegment } from "./parse.ts";
import { relevance, retrieve, type ChatTarget, type ContextFact } from "./retrieve.ts";
import { newStoreOperation, type MemoryData, type MemoryFact, type MemoryOutcome, type MemoryProfile, type MemorySnapshot, type MemoryStoreLike, type StoreOperation, type StoreResult } from "./store.ts";

// MemoryService：記憶的唯一規則入口（16 §9、§10）。擁有 profile、同意、來源票證、更新、檢索與撤銷；store 只管加密快照。
// - 開啟時機（碰 Keychain 與建資料夾）：只有使用者說「記住…」、打開選單列「記憶…」，或上次執行時記憶是開著的
//   （enabledHint：記在加密檔外的一個布林值，不含內容）時，第一次打字的 turn 才開 store。status 永遠不開 store。
//   解不開金鑰（key_unavailable）後，這次執行期間停用；只有使用者從「記憶…」明確重試才再開。
// - 所有檢查都在 commit 前、在這裡的 mutex 內完成；store 的 change callback 只套用已算好的結果，不會 throw
//   （throw 會讓 store 停用）。單筆記憶的 revision 由這裡檢查，store 的 expectedRevision 是整份快照的版本。
//   每次 commit 都順便清除已過期的事實（寫墓碑），所以容量與 store 的 1,000 筆上限用同一個口徑。
// - 寫入前先取得來源票證：可信主視窗的打字（observeTypedInput）或澄清卡點擊（observeConfirmation），再用同一個
//   parser 重新解析原句（issueParsed）；記憶管理畫面的修改、忘記沿用 MEM-0 的字面句型（issue）。票證是核心的自我核對，
//   防止核心自己把命令弄錯或被改動；真正的信任邊界是 IPC 發送者檢查（主視窗主框架、本機核心頁面）加上 renderer
//   只轉送使用者打的字。
// - 本次人物（16 §4）：unselected／selected／suspended。換人、多人或追蹤中斷、OS 鎖定、主視窗導覽、關閉記憶、
//   撤回同意、刪除家人、閒置 30 分鐘都撤銷舊世代：舊的 memory_turn、卡片與進行中的串流一律失效，onPresence 通知頁面。
//   自稱「我是 X」即可檢視與修改 X 在家中可用的資料：這是家中共用裝置上的人物分類，不是身分驗證。
// - 記憶未設定、關閉、不可用或找不到目標時，原句照樣交給一般聊天；錯誤一律回 unavailable，照實說這次沒有用到記憶。
//   log 只記操作、狀態與數字，不記內容或姓名。

export const MEMORY_IDLE_MS = 30 * 60_000;
export const MEMORY_TURN_MS = 60_000;
export const MEMORY_CARD_MS = 2 * 60_000;
export const MANAGE_IDLE_MS = 10 * 60_000;
export const MANAGE_MAX_MS = 15 * 60_000;
export const REQUEST_LRU = 256;
const SNAPSHOT_BUDGET = 10 * 1024 * 1024;

export type MemoryConfirmRequest =
  | { kind: "profile_delete"; name: string; count: number }
  | { kind: "forget_all"; scope: string | null; count: number }
  | { kind: "link_face"; profile: string; person: string | null };
export type MemoryConfirmFn = (request: MemoryConfirmRequest) => Promise<boolean>;

export interface MemoryIdentityHooks {
  /** 最近一次比對成功、60 秒內、同一追蹤世代、沒有多臉的決策；只給核心（IdentityService.memoryCandidate）。 */
  candidate(): { person_id: string; name: string; at: number } | null;
  /** 已登記的家人（連結到既有人物用）；家人資料還沒載入時回 null。 */
  people(): { person_id: string; name: string; minor: boolean }[] | null;
}

export interface MemoryServiceOptions {
  openStore: () => Promise<MemoryStoreLike>;
  /** 安全儲存是否可用（不開 store）。 */
  available: () => boolean;
  /** 一般聊天目前的服務帳號，以及所有已設定的服務帳號（首次設定逐一允許）。 */
  targets: () => { current: ChatTarget | null; all: ChatTarget[] };
  confirm: MemoryConfirmFn;
  identity?: () => MemoryIdentityHooks | null;
  /**
   * 上次執行時記憶是否開著（加密檔外的一個布林值，不含任何內容）。true 時第一次打字就開 store，讓重啟後也取用得到記憶；
   * 未提供或 false 時，只有「記住…」或「記憶…」才開。
   */
  enabledHint?: { get(): boolean; set(enabled: boolean): void };
  /** 第一次成功開啟後呼叫一次（App：Time Machine 排除）。失敗只記 log。 */
  afterOpen?: () => Promise<void>;
  boundary?: MemoryBoundary;
  now?: () => number;
  idleMs?: number;
  log?: (line: string) => void;
  onChange?: () => void;
  /** 本次人物世代改變（換人、暫停、撤銷）：主程序推一個不含內容的通知給主視窗。 */
  onPresence?: () => void;
}

export interface MemoryContext {
  facts: ContextFact[];
  /** 撤銷時 abort；沒有用到記憶時為 null。 */
  signal: AbortSignal | null;
  /** 帶世代檢查的輸出：撤銷後回 false，不交付。 */
  deliver(output: () => void): boolean;
  /** 這一輪（memory_turn 綁定的 IPC turn）是否有成功保存的回條。 */
  saved: boolean;
  /** 為什麼沒有用到記憶（固定句型）；用到或不適用時為 null。 */
  notice: MemoryText | null;
  /** 這一輪或對話歷史用過記憶：交辦一律改成問使用者（delegate_blocked）。 */
  blockDelegation: boolean;
}

type StoreState = "unloaded" | "ready" | "key_unavailable" | "corrupt" | "locked" | "permissions" | "unavailable";

interface Presence {
  state: PresenceState;
  subject: Subject;
  session: MemorySession;
  epoch: number;
  lastActive: number;
  reason: MemoryText | null;
  selectCard: string;
}

interface TurnBinding { session: MemorySession; epoch: number; text: string; requestId: string; expires: number; saved: boolean }

type CardState =
  | { kind: "setup" }
  | { kind: "clarify"; segment: Extract<ParsedSegment, { op: "remember" }>; conflict: string | null; options: ClarifyChoice[] }
  | { kind: "create_profile"; name: string }
  | { kind: "choose_profile"; name: string; profiles: string[] }
  | { kind: "face_candidate"; profile: string }
  | { kind: "pick"; action: "correct" | "forget"; segment: Extract<ParsedSegment, { op: "correct" | "forget" }>; candidates: string[] };

/** fallback：處理到卡片前，因為找不到目標而改交給聊天的段落（卡片回答後一起送）。 */
interface Card { id: string; state: CardState; text: string; part: number; resume: number; requestId: string; epoch: number; expires: number; fallback: Record<number, string> }

class ServiceError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) { super(message); }
}

const txt = (message: string, ...values: string[]): MemoryText => ({ message, values });
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const REQUEST_ID = /^req_[A-Za-z0-9_-]{6,64}$/;
const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PERSON_ID = /^fam_[0-9a-f]{24}$/;
const UNAVAILABLE: Record<Exclude<StoreState, "unloaded" | "ready">, string> = {
  key_unavailable: "無法解開記憶的金鑰（可能沒有允許鑰匙圈存取）；資料沒有被改動",
  corrupt: "記憶檔損壞或被改動，無法解密；不會覆寫成空的記憶",
  locked: "另一個 Nous 核心正在使用記憶；這個核心不讀寫記憶",
  permissions: "記憶資料夾的權限不符；為了安全不讀寫記憶",
  unavailable: "記憶目前不可用（無法安全保存）；一般聊天照常，但不會用到或保存記憶",
};
const REJECTED: Record<"third_party" | "quote" | "hypothetical" | "joke" | "sensitive", string> = {
  third_party: "這像是轉述別人的事，沒有記在任何人名下；請本人自己說，或由家長在「記憶…」管理",
  quote: "引文或別處的話不會自動記成你的偏好；要記住請直接說你自己的偏好",
  hypothetical: "假設的情況不會記住；要記住請直接說",
  joke: "玩笑話不會記住",
  sensitive: "這類資料（密碼、卡號、帳號、病歷、證件號碼等）不能存進記憶",
};
const UNCLEAR: Record<string, string> = {
  question: "聽起來像是問題，不確定要不要記住：要記住這一句嗎？",
  uncertain: "內容含「可能」「大概」這類不確定的說法：要記住這一句嗎？",
  too_long: "內容很長：要記住這一段嗎？",
  empty: "沒有聽到要記住的內容",
  about_assistant: "這像是對 Nous 的指示，不是你的偏好（記憶不能改變規則或權限）：要照原話記成一筆資料嗎？",
  no_person: "還沒有選定本次人物：要記成全家共用，還是先選擇本次人物？",
  suspended: "本次人物已暫停：要記成全家共用，還是先重新選擇本次人物？",
};
const MINOR = "未成年家人的記憶請由家長在選單列「記憶…」管理；這次沒有保存或改動";
const NEED_MANAGE = "請從選單列「記憶…」打開記憶管理";

function endOfLocalDay(now: number): string {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

/** 澄清卡上「保存」的內容：不確定的段落照原話記成 note，主題與鍵用同一套詞庫。 */
function clarified(seg: Extract<ParsedSegment, { op: "unclear" }>): Extract<ParsedSegment, { op: "remember" }> {
  const topic = topicOf(seg.value);
  return { op: "remember", part: seg.part, value: seg.value, topic, key: keyOf(seg.value, topic), kind: "note", expires: "none" };
}

function plainContext(notice: MemoryText | null, blockDelegation = false): MemoryContext {
  return { facts: [], signal: null, deliver: (output) => { output(); return true; }, saved: false, notice, blockDelegation };
}

/** 這些段落需要使用者明說「記住」（首次設定卡只為它們出現，也只有它們會在記憶未開啟時打開 store）。 */
function explicitRemember(segments: readonly ParsedSegment[]): boolean {
  return segments.some(s => s.op === "remember" || s.op === "unclear");
}

export class MemoryService {
  private readonly boundary: MemoryBoundary;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private store: MemoryStoreLike | null = null;
  private storeState: StoreState = "unloaded";
  private opening: Promise<void> | null = null;
  private presence: Presence;
  private epochCounter = 0;
  private readonly turns = new Map<string, TurnBinding>();
  private readonly recent = new Map<string, { text: string; view: MemoryTurnView }>();
  private readonly cards = new Map<string, Card>();
  private manager: { token: string; openedAt: number; lastUsed: number } | null = null;
  private readonly offered = new Set<string>();
  /** 頁面的對話歷史含有用過記憶的回答（核心看得到的範圍：上一次沒有歷史的請求之後，有任何一輪用了記憶）。 */
  private historyTainted = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: MemoryServiceOptions) {
    this.boundary = options.boundary ?? new MemoryBoundary({ now: options.now });
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.presence = this.openPresence("unselected", { kind: "household" }, null);
    this.timer = setInterval(() => this.checkIdle(), 60_000);
    this.timer.unref?.();
  }

  // ─────────────── 狀態與 store ───────────────

  private hint(): boolean {
    try { return this.options.enabledHint?.get() === true; } catch { return false; }
  }

  private setHint(enabled: boolean): void {
    try { if (this.options.enabledHint && this.options.enabledHint.get() !== enabled) this.options.enabledHint.set(enabled); } catch { this.log("memory: 開關提示寫入失敗"); }
  }

  /** settings／全體 SSE 只放這兩個欄位；不開 store。開啟前 enabled 依上次執行留下的提示。 */
  settingsStatus(): MemorySettingsStatus {
    if (this.closed) return { available: false, enabled: false };
    const failed = this.storeState !== "unloaded" && this.storeState !== "ready";
    const available = !failed && this.options.available();
    const enabled = this.storeState === "ready" && this.store ? this.snapshot().settings.enabled : this.hint();
    return { available, enabled: available && enabled };
  }

  private snapshot(): MemorySnapshot {
    if (!this.store) throw new ServiceError("unavailable", UNAVAILABLE.unavailable);
    return this.store.read();
  }

  /**
   * 開 store（碰 Keychain、建資料夾）。retry：使用者從「記憶…」明確重試；只有這時才會在解不開金鑰後再開一次。
   * 損壞、鎖被占用、權限不符或寫入失敗：這次執行都不重試。
   */
  private async ensureOpen(retry = false): Promise<boolean> {
    if (this.closed) return false;
    if (this.storeState === "ready" && this.store) return true;
    if (this.storeState !== "unloaded" && !(retry && this.storeState === "key_unavailable")) return false;
    if (!this.options.available()) return false;
    this.opening ??= (async () => {
      try {
        this.store = await this.options.openStore();
        this.storeState = "ready";
        this.log("memory: store 已開啟");
        this.setHint(this.snapshot().settings.enabled);
        try { await this.options.afterOpen?.(); } catch { this.log("memory: 備份排除失敗"); }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        this.storeState = code === "key_unavailable" || code === "corrupt" || code === "locked" || code === "permissions" ? code : "unavailable";
        this.store = null;
        this.log(`memory: store 無法開啟（${this.storeState}）`);
      } finally {
        this.opening = null;
        this.options.onChange?.();
      }
    })();
    await this.opening;
    return (this.storeState as StoreState) === "ready";
  }

  private unavailableText(): MemoryText {
    const state = this.storeState === "unloaded" || this.storeState === "ready" ? "unavailable" : this.storeState;
    return txt(this.closed ? "Nous 核心正在重新啟動；這次沒有用到記憶" : !this.options.available() ? "此 Mac 無法加密保存（safeStorage 不可用），記憶停用" : UNAVAILABLE[state]);
  }

  /** 同一時間只有一個會改資料的操作（含等待原生確認）。 */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ─────────────── 本次人物 ───────────────

  private openPresence(state: PresenceState, subject: Subject, reason: MemoryText | null): Presence {
    return { state, subject, session: this.boundary.openSession(subject), epoch: ++this.epochCounter, lastActive: this.now(), reason, selectCard: `mc_${hex(12)}` };
  }

  /** 撤銷目前世代：舊 session 的串流 abort、memory_turn、卡片與 request_id 快取失效，通知頁面清掉用過記憶的歷史。 */
  private replacePresence(state: PresenceState, subject: Subject, reason: MemoryText | null): void {
    const old = this.presence;
    this.presence = this.openPresence(state, subject, reason);
    this.turns.clear();
    this.cards.clear();
    this.recent.clear();
    void this.boundary.revoke(old.session).then(ok => { if (!ok) this.log("memory: 撤銷清理未完成"); });
    this.options.onChange?.();
    try { this.options.onPresence?.(); } catch { /* 通知失敗不影響撤銷 */ }
  }

  /** 換新世代但維持同一人物（更正、忘記、撤回同意之後）。 */
  private bumpEpoch(): void {
    this.replacePresence(this.presence.state, this.presence.subject, this.presence.reason);
  }

  private profileOf(id: string | null): MemoryProfile | undefined {
    if (!id || !this.store) return undefined;
    return this.snapshot().profiles.find(p => p.id === id);
  }

  private presenceView(): MemoryPresenceView {
    const p = this.presence;
    const profile = p.subject.kind === "person" ? this.profileOf(p.subject.profileId) : undefined;
    return { state: p.state, epoch: p.epoch, select_card: p.selectCard, profile: profile?.id ?? null, name: profile?.name ?? null, reason: p.reason };
  }

  private currentProfileId(): string | null {
    return this.presence.state === "selected" && this.presence.subject.kind === "person" ? this.presence.subject.profileId : null;
  }

  private currentIsMinor(): boolean {
    return this.profileOf(this.currentProfileId())?.minor === true;
  }

  private select(profileId: string | null): void {
    if (profileId === null) this.replacePresence("unselected", { kind: "household" }, null);
    else this.replacePresence("selected", { kind: "person", profileId }, null);
    this.log(`memory: 本次人物 ${profileId === null ? "unselected" : "selected"}`);
  }

  /**
   * 暫停本次人物（只能降權，不能選人）。「互動結束」的定義：有鏡頭時是追蹤中斷（在場判斷結束或鏡頭停止）與多人入鏡，
   * 無鏡頭時是閒置 30 分鐘；另加 OS 鎖定與刪除連結的家人。
   */
  suspend(reason: "multi_face" | "tracking_lost" | "os_lock" | "idle" | "unlinked"): void {
    if (this.presence.state !== "selected") {
      if (reason === "os_lock") this.replacePresence(this.presence.state, this.presence.subject, this.presence.reason);
      return;
    }
    // 固定句型整句翻譯（values 只放使用者的話或名字，不放介面文字）。
    const message = reason === "multi_face" ? "已暫停本次人物（畫面裡有多張臉）；請重新選擇" : reason === "tracking_lost" ? "已暫停本次人物（追蹤中斷）；請重新選擇"
      : reason === "os_lock" ? "已暫停本次人物（電腦已鎖定）；請重新選擇" : reason === "idle" ? "已暫停本次人物（閒置超過 30 分鐘）；請重新選擇" : "已暫停本次人物（家人辨識資料已刪除）；請重新選擇";
    this.replacePresence("suspended", { kind: "household" }, txt(message));
    this.log(`memory: 本次人物暫停（${reason}）`);
  }

  /** OS 鎖定（powerMonitor lock-screen）。 */
  suspendAll(): void { this.suspend("os_lock"); }

  /** 主視窗導覽、重新載入或 renderer 結束：回到 unselected，管理畫面失效。 */
  closeSessions(): void {
    this.manager = null;
    this.historyTainted = false;
    this.replacePresence("unselected", { kind: "household" }, null);
  }

  private checkIdle(): void {
    const idle = this.options.idleMs ?? MEMORY_IDLE_MS;
    if (this.presence.state === "selected" && this.now() - this.presence.lastActive > idle) this.suspend("idle");
  }

  private touch(): void { this.checkIdle(); this.presence.lastActive = this.now(); }

  // ─────────────── 視圖 ───────────────

  private targetView(target: ChatTarget, data: MemoryData): MemoryTargetView | null {
    if (!target.account) return null;
    const allowed = (profileId: string | null) => data.consents.some(c => c.profileId === profileId && c.provider === target.provider && c.account === target.account && c.allowed);
    return { provider: target.provider, account: target.account, label: target.label, allowed: allowed(this.currentProfileId()), household_allowed: allowed(null) };
  }

  private statusView(): MemoryStatusView {
    const base = { limits: { facts: MEMORY_FACT_MAX, profiles: MEMORY_PROFILE_MAX, value_chars: MEMORY_VALUE_MAX } };
    if (this.storeState !== "ready" || !this.store) {
      const notLoaded = this.storeState === "unloaded" && this.options.available() && !this.closed;
      return { ...base, state: notLoaded ? "not_loaded" : "unavailable", reason: notLoaded ? null : this.unavailableText(), enabled: notLoaded && this.hint(), setup_done: false, presence: this.presenceView(), profiles: [], target: null, targets: [], active_facts: 0 };
    }
    const data = this.snapshot();
    const targets = this.options.targets();
    return {
      ...base,
      state: "ready",
      reason: null,
      enabled: data.settings.enabled,
      setup_done: data.settings.setupAt !== null,
      presence: this.presenceView(),
      profiles: data.profiles.map(p => ({ id: p.id, name: p.name, minor: p.minor, linked: p.facePersonId !== null, facts: this.activeFacts(data, f => f.profileId === p.id).length })),
      target: targets.current ? this.targetView(targets.current, data) : null,
      targets: targets.all.map(t => this.targetView(t, data)).filter((t): t is MemoryTargetView => t !== null),
      active_facts: this.activeFacts(data, () => true).length,
    };
  }

  private factView(f: MemoryFact, data: MemoryData): MemoryFactView {
    return { id: f.id, revision: f.revision, subject: f.profileId, subject_name: f.profileId ? data.profiles.find(p => p.id === f.profileId)?.name ?? null : null, text: f.value, topic: f.topic, source: "explicit", excerpt: f.source.excerpt, at: f.source.at, expires: f.expiresAt, pinned: f.pinned };
  }

  private activeFacts(data: MemoryData, scope: (f: MemoryFact) => boolean): MemoryFact[] {
    const now = this.now();
    return data.facts.filter(f => scope(f) && (f.expiresAt === null || Date.parse(f.expiresAt) > now));
  }

  // ─────────────── IPC 入口 ───────────────

  /** IPC 進來的請求（desktop/memory-ipc.mjs 已過濾形狀；這裡仍完整驗證，核心為權威）。 */
  async handle(raw: unknown, ctx: { userInitiated?: boolean } = {}): Promise<MemoryResponse> {
    const req = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const op = req && (MEMORY_OPS as readonly unknown[]).includes(req.op) ? req.op as string : "unknown";
    try {
      if (!req || op === "unknown") throw new ServiceError("bad_request", "不認得的記憶操作");
      if (this.closed) throw new ServiceError("closed", "Nous 核心正在重新啟動");
      // suspend 只降權；status 只回報目前狀態：兩者都不開 store（不碰 Keychain）。
      if (op === "suspend") {
        const reason = req.reason === "multi_face" || req.reason === "tracking_lost" ? req.reason : null;
        if (!reason) throw new ServiceError("bad_request", "reason 格式不對");
        this.suspend(reason);
        return { ok: true, op: "suspend", presence: this.presenceView() };
      }
      if (op === "status") { this.checkIdle(); return { ok: true, op: "status", ...this.statusView() }; }
      if (op === "turn") return await this.turn(req);
      // 選單列「記憶…」打開記憶管理：使用者明確動作，可以開 store，也可以在解不開金鑰後重試一次。
      const userOpen = op === "list" && req.manage === true && ctx.userInitiated === true;
      if (!(await this.ensureOpen(userOpen))) throw new ServiceError("unavailable", this.unavailableText().message);
      this.touch();
      switch (op) {
        case "setup": return await this.exclusive(() => this.setup(req));
        case "card_answer": return await this.exclusive(() => this.cardAnswer(req));
        case "select": return await this.exclusive(() => this.selectOp(req));
        case "list": return this.list(req, ctx);
        case "receipt": return this.receiptOp(req);
        case "edit": return await this.exclusive(() => this.edit(req));
        case "forget": return await this.exclusive(() => req.all === true ? this.forgetAll(req) : this.forgetOp(req));
        case "pin": return await this.exclusive(() => this.pin(req));
        case "profile_delete": return await this.exclusive(() => this.profileDelete(req));
        case "link_face": return await this.exclusive(() => this.linkFace(req));
        case "profile_minor": return await this.exclusive(() => this.profileMinor(req));
        default: throw new ServiceError("bad_request", "不認得的記憶操作");
      }
    } catch (error) {
      if (error instanceof ServiceError) {
        this.log(`memory: ${op} 拒絕（${error.code}）`);
        return { ok: false, code: error.code, message: error.message };
      }
      const code = (error as { code?: unknown } | null)?.code;
      this.log(`memory: ${op} 失敗（${typeof code === "string" ? code : error instanceof Error ? error.constructor.name : "error"}）`);
      return { ok: false, code: "unavailable", message: UNAVAILABLE.unavailable };
    }
  }

  // ─────────────── turn：打字的一句話 ───────────────

  private async turn(req: Record<string, unknown>): Promise<MemoryResponse> {
    const text = typeof req.text === "string" ? req.text.trim() : "";
    const requestId = req.request_id;
    if (!text || text.length > 2000) throw new ServiceError("bad_request", "text 需為 1–2000 字");
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw new ServiceError("bad_request", "request_id 格式不對");
    const segments = parseMemoryText(text);
    const remember = explicitRemember(segments);
    // 記憶未開啟（或不知道）時只跑 parser：除非使用者明說「記住…」，否則不開 store、不碰 Keychain。
    const open = this.storeState === "ready" || ((remember || this.hint()) && await this.ensureOpen());
    const passThrough = (receipts: MemoryReceiptView[], notice: MemoryText | null): MemoryResponse =>
      ({ ok: true, op: "turn", ...this.view(receipts, null, text, false, notice, false), status: this.statusView() });
    if (!open) {
      const failed = this.storeState !== "unloaded" || (remember && !this.options.available());
      return passThrough(remember && failed ? [this.receipt("unavailable", txt("記憶目前不可用，這次沒有保存或取用記憶"))] : [], failed && (remember || this.hint()) ? this.unavailableText() : null);
    }
    return this.exclusive(async () => {
      const cached = this.recent.get(requestId);
      if (cached) {
        if (cached.text !== text) throw new ServiceError("conflict", "同一個 request_id 帶了不同的內容");
        return { ok: true, op: "turn", ...cached.view, status: this.statusView() };
      }
      this.touch();
      const settings = this.snapshot().settings;
      let view: MemoryTurnView;
      if (!settings.enabled) {
        if (remember && settings.setupAt === null) {
          // 首次「記住」：出設定卡；問題先暫緩，取消或不啟用時照樣送出（不寫入記憶）。
          const card = this.newCard({ kind: "setup" }, text, 0, 0, requestId, {});
          view = this.view([], { kind: "setup", card: card.id, text }, chatText(segments), false, null, false);
        } else {
          // 記憶已關閉：原句照樣交給一般聊天，照實說這次沒有保存。
          view = this.view(remember ? [this.receipt("disabled", txt("記憶功能已關閉，這次沒有保存；可以在選單列「記憶…」開啟"))] : [], null, text, false, null, false);
        }
      } else {
        view = await this.process(text, requestId, segments, 0, "typed", {});
      }
      this.recent.set(requestId, { text, view });
      while (this.recent.size > REQUEST_LRU) this.recent.delete(this.recent.keys().next().value!);
      return { ok: true, op: "turn", ...view, status: this.statusView() };
    });
  }

  /** chat 與 card 都在時，chat 只是暫緩顯示，不發 memory_turn；卡片處理完才發。 */
  private view(receipts: MemoryReceiptView[], card: MemoryCardView | null, chat: string | null, reset: boolean, notice: MemoryText | null, saved: boolean, requestId?: string): MemoryTurnView {
    let nonce: string | null = null;
    if (chat && !card && requestId) {
      nonce = `mt_${hex(16)}`;
      this.turns.set(nonce, { session: this.presence.session, epoch: this.presence.epoch, text: chat, requestId, expires: this.now() + MEMORY_TURN_MS, saved });
      // 過期的 nonce 順手清掉（每次最多 64 筆）。
      for (const [key, binding] of this.turns) if (binding.expires <= this.now() || this.turns.size > 64) this.turns.delete(key); else break;
    }
    return { receipts, card, chat: chat ? { text: chat, memory_turn: nonce } : null, presence: this.presenceView(), history_reset: reset, notice };
  }

  private receipt(status: MemoryReceiptStatus, text: MemoryText, operationId: string | null = null): MemoryReceiptView {
    return { status, ...text, operation_id: operationId };
  }

  private newCard(state: CardState, text: string, part: number, resume: number, requestId: string, fallback: Record<number, string>): Card {
    const card: Card = { id: `mc_${hex(12)}`, state, text, part, resume, requestId, epoch: this.presence.epoch, expires: this.now() + MEMORY_CARD_MS, fallback: { ...fallback } };
    this.cards.set(card.id, card);
    if (this.cards.size > 16) this.cards.delete(this.cards.keys().next().value!);
    return card;
  }

  /** 送 chat 的文字：一般段落與改交給聊天的段落，依原句順序接起來。 */
  private chatOf(segments: readonly ParsedSegment[], fallback: Record<number, string>): string | null {
    const parts = new Map<number, string>(Object.entries(fallback).map(([k, v]) => [Number(k), v]));
    for (const s of segments) if (s.op === "chat" || s.op === "temporary") parts.set(s.part, s.text);
    const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    return ordered.length ? ordered.join("。") : null;
  }

  /**
   * 依序處理原句的段落：選人 → 寫入 → 剩下的問題送 chat（帶上新記憶）。需要使用者決定時出一張卡片並停下；
   * 卡片回答後從下一段繼續（resume）。via 決定這次的直接輸入來源（打字或卡片點擊）。記憶關閉時原句照樣交給 chat。
   */
  private async process(text: string, requestId: string, segments: ParsedSegment[], from: number, via: "typed" | "confirmation", carried: Record<number, string>): Promise<MemoryTurnView> {
    if (!this.snapshot().settings.enabled) return this.view([], null, text, false, null, false);
    const receipts: MemoryReceiptView[] = [];
    const fallback: Record<number, string> = { ...carried };
    let reset = false;
    let saved = false;
    const chat = () => this.chatOf(segments, fallback);
    const stop = (card: MemoryCardView): MemoryTurnView => this.view(receipts, card, chat(), reset, null, saved);
    // 臉部候選：未選定或已暫停、這句話沒有「我是 X」、這個候選還沒問過，才在處理前問一次（確認後才選定）。
    if (from === 0 && this.presence.state !== "selected" && !segments.some(s => s.op === "self_id")) {
      const candidate = this.faceCandidate();
      if (candidate) {
        const card = this.newCard({ kind: "face_candidate", profile: candidate.id }, text, 0, 0, requestId, fallback);
        return stop({ kind: "face_candidate", card: card.id, name: candidate.name });
      }
    }
    for (const seg of segments.slice(from)) {
      const next = seg.part + 1;
      const data = this.snapshot();
      switch (seg.op) {
        case "chat":
        case "temporary":
          break;
        case "self_id": {
          const same = data.profiles.filter(p => p.name.toLowerCase() === seg.name.toLowerCase());
          const remembersLater = explicitRemember(segments.slice(segments.indexOf(seg) + 1));
          if (same.length === 1) {
            if (this.currentProfileId() !== same[0]!.id) { this.select(same[0]!.id); reset = true; }
            receipts.push(this.receipt("selected", txt("本次人物：{0}", same[0]!.name)));
          } else if (same.length > 1) {
            const card = this.newCard({ kind: "choose_profile", name: seg.name, profiles: same.map(p => p.id) }, text, seg.part, next, requestId, fallback);
            return stop({ kind: "choose_profile", card: card.id, name: seg.name, profiles: same.map(p => ({ id: p.id, name: p.name })) });
          } else if (remembersLater) {
            const card = this.newCard({ kind: "create_profile", name: seg.name }, text, seg.part, next, requestId, fallback);
            const target = this.options.targets().current;
            return stop({ kind: "create_profile", card: card.id, name: seg.name, target: target ? this.targetView(target, data) : null });
          } else {
            // 「我是老闆」「I'm Fine」：不是既有人物、後面也沒有「記住」，就是一般聊天。
            fallback[seg.part] = seg.text;
          }
          break;
        }
        case "remember": {
          const profile = this.currentProfileId();
          if (profile === null) {
            const card = this.newCard({ kind: "clarify", segment: seg, conflict: null, options: ["household", "cancel"] }, text, seg.part, next, requestId, fallback);
            const why = this.presence.state === "suspended" ? UNCLEAR.suspended! : UNCLEAR.no_person!;
            return stop({ kind: "clarify", card: card.id, value: seg.value, reason: txt(why), options: ["household", "cancel"] });
          }
          if (this.currentIsMinor()) { receipts.push(this.receipt("minor", txt(MINOR))); break; }
          const same = this.activeFacts(data, f => f.profileId === profile && f.key === seg.key);
          if (same.some(f => f.value === seg.value)) {
            receipts.push(this.receipt("unchanged", txt("已經記得了（{0}）：{1}", this.nameOf(profile), seg.value)));
            break;
          }
          const conflicting = same.find(f => f.kind === "preference" && seg.kind === "preference" && seg.expires === "none" && f.expiresAt === null);
          if (conflicting) {
            const card = this.newCard({ kind: "clarify", segment: seg, conflict: conflicting.id, options: ["save", "cancel"] }, text, seg.part, next, requestId, fallback);
            return stop({ kind: "clarify", card: card.id, value: seg.value, reason: txt("已經記得「{0}」；要改成新的說法嗎？", conflicting.value), options: ["save", "cancel"] });
          }
          const result = await this.writeRemember(seg, "subject", text, via, requestId);
          receipts.push(result);
          saved ||= result.status === "saved";
          break;
        }
        case "unclear": {
          if (!seg.value) { receipts.push(this.receipt("rejected", txt(UNCLEAR.empty!))); break; }
          if (this.currentIsMinor()) { receipts.push(this.receipt("minor", txt(MINOR))); break; }
          const options: ClarifyChoice[] = this.currentProfileId() ? ["save", "household", "cancel"] : ["household", "cancel"];
          const card = this.newCard({ kind: "clarify", segment: clarified(seg), conflict: null, options }, text, seg.part, next, requestId, fallback);
          return stop({ kind: "clarify", card: card.id, value: seg.value, reason: txt(UNCLEAR[seg.reason] ?? UNCLEAR.question!), options });
        }
        case "rejected":
          receipts.push(this.receipt("rejected", txt(REJECTED[seg.reason])));
          break;
        case "correct":
        case "forget": {
          if (this.currentIsMinor()) { receipts.push(this.receipt("minor", txt(MINOR))); break; }
          const profile = this.currentProfileId();
          const scope = this.activeFacts(data, f => f.profileId === null || (profile !== null && f.profileId === profile));
          const candidates = this.targetsFor(scope, seg);
          // 找不到明確的記憶目標：不是在講記憶（例如「更正：報告第三段」），原句照樣交給聊天。
          if (candidates.length === 0) { fallback[seg.part] = seg.text; break; }
          if (candidates.length > 1) {
            const card = this.newCard({ kind: "pick", action: seg.op, segment: seg, candidates: candidates.map(f => f.id) }, text, seg.part, next, requestId, fallback);
            return stop({ kind: "pick", card: card.id, action: seg.op, value: seg.value, candidates: candidates.map(f => this.factView(f, data)) });
          }
          const result = await this.writeTarget(seg, candidates[0]!, text, via, requestId);
          receipts.push(result);
          if (result.status === "updated" || result.status === "forgotten") reset = true;
          break;
        }
        case "forget_all":
          // 全部忘記只在記憶管理（管理權杖＋原生確認），不從聊天執行。
          receipts.push(this.receipt("rejected", txt("全部忘記請從選單列「記憶…」的記憶管理操作；這次沒有刪除")));
          break;
        case "inspect": {
          const profile = this.currentProfileId();
          const facts = this.activeFacts(data, f => f.profileId === null || (profile !== null && f.profileId === profile));
          return stop({ kind: "inspect", subject_name: profile ? this.nameOf(profile) : null, facts: facts.map(f => this.factView(f, data)) });
        }
      }
    }
    const message = chat();
    return this.view(receipts, null, message, reset, message ? this.consentNotice() : null, saved, requestId);
  }

  private consentNotice(): MemoryText | null {
    const target = this.options.targets().current;
    if (!target?.account) return txt("目前的服務沒有可用的帳號；這次沒有用到記憶");
    return null;
  }

  private nameOf(profileId: string | null): string {
    return profileId ? this.profileOf(profileId)?.name ?? "" : "";
  }

  private faceCandidate(): MemoryProfile | null {
    const hit = this.options.identity?.()?.candidate() ?? null;
    if (!hit || !PERSON_ID.test(hit.person_id)) return null;
    const profile = this.snapshot().profiles.find(p => p.facePersonId === hit.person_id);
    // 每個辨識決策只問一次（「這次用 X 的偏好？」），拒絕後同一次互動不再問。
    const key = `${hit.person_id}@${hit.at}`;
    if (!profile || this.offered.has(key)) return null;
    this.offered.add(key);
    if (this.offered.size > 32) this.offered.delete(this.offered.values().next().value!);
    return profile;
  }

  /** 更正／忘記的目標：同一個標準鍵優先；沒有就用相關性（主題＋二字片段）最高且唯一的那一組。 */
  private targetsFor(scope: MemoryFact[], seg: Extract<ParsedSegment, { op: "correct" | "forget" }>): MemoryFact[] {
    const byKey = scope.filter(f => f.key === seg.key);
    if (byKey.length) return byKey;
    const scored = scope.map(f => ({ f, s: relevance(f, seg.value) - (f.topic === seg.topic ? 0 : 2) })).filter(x => x.s >= 2);
    const best = Math.max(0, ...scored.map(x => x.s));
    return scored.filter(x => x.s === best).map(x => x.f);
  }

  // ─────────────── 寫入（都要票證） ───────────────

  /**
   * 票證比對用的重新解析：與 turn 用同一個 parser。澄清卡把「不確定」的段落變成記住，這個轉換也是確定性的（clarified）。
   * scope（本人或全家共用）來自卡片上的選擇，由核心加入，頁面不能指定。
   */
  private reparse(scope: "subject" | "household"): (text: string) => ({ op: string; part: number } & Record<string, string | number | boolean | null>)[] {
    return (text) => parseMemoryText(text).map(seg => ({ ...(seg.op === "unclear" && seg.value ? clarified(seg) : seg), scope }) as { op: string; part: number } & Record<string, string | number | boolean | null>);
  }

  /** 依原句（打字或卡片上核心保存的原句）取得票證；票證綁本次 session、世代、序號與命令。 */
  private ticketFor(text: string, via: "typed" | "confirmation", command: ParsedMemoryCommand, scope: "subject" | "household"): void {
    const session = this.presence.session;
    const input = via === "typed" ? this.boundary.observeTypedInput(session, text) : this.boundary.observeConfirmation(session, text);
    const ticket = this.boundary.issueParsed(session, input, command, this.reparse(scope));
    this.boundary.consumeParsed(session, ticket, command);
  }

  /** 新的 store 操作（UUIDv7，核心產生；模型不能指定 ID 或時間）。票證與 store 用同一個 operationId。 */
  private operation(fingerprint: string): StoreOperation {
    return newStoreOperation(this.snapshot().revision, fingerprint, this.now());
  }

  /**
   * 寫入一次。plan 之後順便清除已過期的事實並寫墓碑（「記住今天」到期後不留在檔案裡），所以 capacity 與 store 的上限同口徑。
   * change 只套用已算好的結果，不會 throw。
   */
  private async commit(fingerprint: string | StoreOperation, plan: (data: MemoryData) => MemoryData, status: MemoryOutcome): Promise<{ result: StoreResult; operationId: string }> {
    const snap = this.snapshot();
    const operation = typeof fingerprint === "string" ? newStoreOperation(snap.revision, fingerprint, this.now()) : fingerprint;
    const planned = plan(structuredClone({ settings: snap.settings, profiles: snap.profiles, facts: snap.facts, consents: snap.consents, tombstones: snap.tombstones }));
    const now = this.now();
    const expired = planned.facts.filter(f => f.expiresAt !== null && Date.parse(f.expiresAt) <= now);
    if (expired.length) {
      const ids = new Set(expired.map(f => f.id));
      planned.facts = planned.facts.filter(f => !ids.has(f.id));
      planned.tombstones = [...planned.tombstones.filter(t => !ids.has(t.id)), ...expired.map(f => ({ id: f.id, revision: snap.revision + 1 }))].slice(-10000);
    }
    if (planned.facts.length > MEMORY_FACT_MAX) return { result: { status: "conflict" }, operationId: operation.operationId };
    if (Buffer.byteLength(JSON.stringify({ ...snap, ...planned })) > SNAPSHOT_BUDGET * 0.98) return { result: { status: "unavailable" }, operationId: operation.operationId };
    const result = await this.store!.commit(operation, data => {
      data.settings = planned.settings; data.profiles = planned.profiles; data.facts = planned.facts; data.consents = planned.consents; data.tombstones = planned.tombstones;
      return status;
    });
    if (result.status === "unavailable") {
      this.storeState = "unavailable";
      this.replacePresence("unselected", { kind: "household" }, null);
    }
    this.log(`memory: commit ${result.status}${expired.length ? `（清除過期 ${expired.length} 筆）` : ""}`);
    return { result, operationId: operation.operationId };
  }

  private storeFailure(result: StoreResult): MemoryReceiptView {
    if (result.status === "receipt_expired") return this.receipt("receipt_expired", txt("這個操作已過期，沒有保存；請再說一次"));
    if (result.status === "conflict") return this.receipt("conflict", txt("記憶剛被其他操作改過，這次沒有保存；請再說一次"));
    return this.receipt("unavailable", txt("記憶沒有保存（無法安全寫入）；原本的資料沒有改變"));
  }

  /** 容量：有效（未過期）事實＋新增 ≤ 1,000；過期的會在同一次 commit 被清除，所以和 store 的上限同口徑。 */
  private hasRoom(data: MemoryData, adding: number): boolean {
    return this.activeFacts(data, () => true).length + adding <= MEMORY_FACT_MAX;
  }

  private fullReceipt(): MemoryReceiptView {
    return this.receipt("full", txt("記憶已滿（{0} 筆）；請先整理或忘記一些再保存", String(MEMORY_FACT_MAX)));
  }

  private async writeRemember(seg: Extract<ParsedSegment, { op: "remember" }>, scope: "subject" | "household", text: string, via: "typed" | "confirmation", requestId: string, replace: string | null = null): Promise<MemoryReceiptView> {
    const profileId = scope === "household" ? null : this.currentProfileId();
    if (scope === "subject" && profileId === null) return this.receipt("rejected", txt(UNCLEAR.no_person!));
    if ([...seg.value].length > MEMORY_VALUE_MAX) return this.receipt("full", txt("內容超過 {0} 字，沒有保存", String(MEMORY_VALUE_MAX)));
    const data = this.snapshot();
    if (!replace && !this.hasRoom(data, 1)) return this.fullReceipt();
    const operationFields = { op: seg.op, part: seg.part, value: seg.value, topic: seg.topic, key: seg.key, kind: seg.kind, expires: seg.expires, scope };
    const nowIso = new Date(this.now()).toISOString();
    const excerpt = [...text].length <= MEMORY_EXCERPT_MAX ? text : [...seg.value].length <= MEMORY_EXCERPT_MAX ? seg.value : null;
    if (excerpt === null) return this.receipt("full", txt("內容太長，沒有保存（摘錄上限 {0} 字）", String(MEMORY_EXCERPT_MAX)));
    // 票證的 operationId 與 store 的操作 ID 相同：同一次直接輸入只會落盤一次。
    const operation = this.operation(JSON.stringify([operationFields, replace]));
    try {
      this.ticketFor(text, via, { ...operationFields, operationId: operation.operationId } as ParsedMemoryCommand, scope);
    } catch {
      return this.receipt("rejected", txt("這次的來源無法驗證，沒有保存；請再說一次"));
    }
    const fact: MemoryFact = {
      id: `mem_${hex(8)}`, profileId, revision: 0, kind: seg.kind, topic: seg.topic, key: seg.key, value: seg.value, audience: "household",
      source: { kind: "explicit", turnId: requestId, at: nowIso, excerpt }, validFrom: nowIso,
      expiresAt: seg.expires === "today" ? endOfLocalDay(this.now()) : null, reviewAfter: null, pinned: false,
    };
    const replaced = replace ? data.facts.find(f => f.id === replace) : undefined;
    const { result, operationId: stored } = await this.commit(operation, (d) => {
      fact.revision = this.snapshot().revision + 1;
      if (replaced) d.facts = d.facts.map(f => f.id === replaced.id ? { ...fact, id: replaced.id, pinned: replaced.pinned } : f);
      else d.facts.push(fact);
      return d;
    }, replaced ? "updated" : "saved");
    if (result.status === "conflict" && !this.hasRoom(this.snapshot(), replaced ? 0 : 1)) return this.fullReceipt();
    if (result.status !== "saved" && result.status !== "updated") return this.storeFailure(result);
    const who = profileId ? this.nameOf(profileId) : null;
    if (replaced) this.bumpEpoch();
    const message = replaced ? (who ? txt("已更正 {0} 的記憶：{1}", who, seg.value) : txt("已更正全家共用的記憶：{0}", seg.value))
      : who ? txt(seg.expires === "today" ? "記在 {0} 名下了（今天有效）：{1}" : "記在 {0} 名下了：{1}", who, seg.value)
        : txt(seg.expires === "today" ? "記在全家共用了（今天有效）：{0}" : "記在全家共用了：{0}", seg.value);
    return this.receipt(result.status, message, stored);
  }

  private async writeTarget(seg: Extract<ParsedSegment, { op: "correct" | "forget" }>, target: MemoryFact, text: string, via: "typed" | "confirmation", requestId: string): Promise<MemoryReceiptView> {
    const fields = { op: seg.op, part: seg.part, value: seg.value, topic: seg.topic, key: seg.key, text: seg.text, scope: "subject" as const };
    const operation = this.operation(JSON.stringify([fields, target.id, target.revision]));
    try {
      this.ticketFor(text, via, { ...fields, operationId: operation.operationId } as ParsedMemoryCommand, "subject");
    } catch {
      return this.receipt("rejected", txt("這次的來源無法驗證，沒有改動；請再說一次"));
    }
    return seg.op === "forget" ? this.applyForget(target, target.revision, operation) : this.applyCorrect(target, target.revision, seg.value, requestId, text, operation);
  }

  private async applyCorrect(target: MemoryFact, revision: number, value: string, requestId: string, excerptSource: string, operation: StoreOperation): Promise<MemoryReceiptView> {
    const data = this.snapshot();
    const current = data.facts.find(f => f.id === target.id);
    if (!current) return this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）"));
    if (current.revision !== revision) return this.receipt("conflict", txt("這筆記憶剛被改過，沒有覆蓋；請重新整理後再改"));
    if ([...value].length > MEMORY_VALUE_MAX) return this.receipt("full", txt("內容超過 {0} 字，沒有保存", String(MEMORY_VALUE_MAX)));
    const nowIso = new Date(this.now()).toISOString();
    const topic = topicOf(value);
    const excerpt = [...excerptSource].length <= MEMORY_EXCERPT_MAX ? excerptSource : [...value].slice(0, MEMORY_EXCERPT_MAX).join("");
    const { result, operationId: stored } = await this.commit(operation, (d) => {
      const nextRevision = this.snapshot().revision + 1;
      // 更正清掉舊正文與舊摘錄；首版不保存無限全文版本史（16 §6）。
      d.facts = d.facts.map(f => f.id === current.id ? { ...f, revision: nextRevision, value, topic, key: keyOf(value, topic), source: { kind: "explicit" as const, turnId: requestId, at: nowIso, excerpt }, validFrom: nowIso } : f);
      return d;
    }, "updated");
    if (result.status !== "updated") return this.storeFailure(result);
    this.bumpEpoch();
    return this.receipt("updated", current.profileId ? txt("已更正 {0} 的記憶：{1}", this.nameOf(current.profileId), value) : txt("已更正全家共用的記憶：{0}", value), stored);
  }

  private async applyForget(target: MemoryFact, revision: number, operation: StoreOperation): Promise<MemoryReceiptView> {
    const data = this.snapshot();
    const current = data.facts.find(f => f.id === target.id);
    if (!current) return this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）"));
    if (current.revision !== revision) return this.receipt("conflict", txt("這筆記憶剛被改過，沒有刪除；請重新整理後再試"));
    const { result, operationId: stored } = await this.commit(operation, (d) => {
      d.facts = d.facts.filter(f => f.id !== current.id);
      // 墓碑只剩 ID 與版本，沒有正文。
      d.tombstones = [...d.tombstones.filter(t => t.id !== current.id), { id: current.id, revision: this.snapshot().revision + 1 }].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") return this.storeFailure(result);
    this.bumpEpoch();
    return this.receipt("forgotten", current.profileId ? txt("已忘記 {0} 的一筆記憶", this.nameOf(current.profileId)) : txt("已忘記一筆全家共用的記憶"), stored);
  }

  // ─────────────── setup／卡片／選人 ───────────────

  /** 開關記憶與服務同意：只有首次設定卡（card）或記憶管理（token）可以改。 */
  private async setup(req: Record<string, unknown>): Promise<MemoryResponse> {
    const card = typeof req.card === "string" && CARD_ID.test(req.card) ? this.cards.get(req.card) : undefined;
    const setupCard = card && card.state.kind === "setup" && card.expires > this.now() && card.epoch === this.presence.epoch ? card : undefined;
    if (!setupCard && !this.manageToken(req)) throw new ServiceError("no_manage", NEED_MANAGE);
    if (typeof req.enabled !== "boolean") throw new ServiceError("bad_request", "enabled 必須是 true 或 false");
    const subject = req.subject as Record<string, unknown> | undefined;
    if (!subject || typeof subject !== "object") throw new ServiceError("bad_request", "subject 格式不對");
    if (!Array.isArray(req.allow) || req.allow.length > 8) throw new ServiceError("bad_request", "allow 格式不對");
    const targets = this.options.targets().all.filter(t => t.account);
    const allow = req.allow.map(a => a as Record<string, unknown>).filter(a => targets.some(t => t.provider === a?.provider && t.account === a?.account));
    if (allow.length !== req.allow.length) throw new ServiceError("bad_request", "只能允許已設定的服務帳號");
    const data = this.snapshot();
    let profileId: string | null = null;
    let created: MemoryProfile | null = null;
    if (subject.kind === "profile") {
      if (typeof subject.profile !== "string" || !data.profiles.some(p => p.id === subject.profile)) throw new ServiceError("not_found", "找不到這位人物");
      profileId = subject.profile;
    } else if (subject.kind === "name") {
      const name = typeof subject.name === "string" ? subject.name.trim() : "";
      if (!name || [...name].length > 16 || /[<>{}[\]`"\\\n]/.test(name)) throw new ServiceError("bad_request", "名稱需為 1–16 個字，不能有換行或特殊符號");
      const existing = data.profiles.filter(p => p.name.toLowerCase() === name.toLowerCase());
      if (existing.length > 1) throw new ServiceError("bad_request", "有多位同名人物，請從清單選擇");
      if (existing.length === 1) profileId = existing[0]!.id;
      else {
        if (data.profiles.length >= MEMORY_PROFILE_MAX) throw new ServiceError("full", "最多 20 位人物");
        created = { id: `profile_${hex(8)}`, name, createdAt: new Date(this.now()).toISOString(), facePersonId: null, minor: false };
        profileId = created.id;
      }
    } else if (subject.kind !== "household") throw new ServiceError("bad_request", "subject 格式不對");
    // 首次設定時人物與全家共用一起允許（設定卡上有說明）；之後（記憶管理）只改選定的那一個範圍。
    const subjects = profileId === null || data.settings.setupAt !== null ? [profileId] : [profileId, null];
    const { result } = await this.commit(JSON.stringify(["setup", req.enabled, profileId, allow]), (d) => {
      d.settings = { enabled: req.enabled as boolean, setupAt: d.settings.setupAt ?? new Date(this.now()).toISOString(), suggestions: false };
      if (created) d.profiles.push(created);
      // 依「服務＋帳號」逐一允許或撤回；只換模型不影響（同意不綁模型名稱）。
      for (const target of targets) {
        for (const s of subjects) {
          const allowed = allow.some(a => a.provider === target.provider && a.account === target.account);
          d.consents = d.consents.filter(c => !(c.profileId === s && c.provider === target.provider && c.account === target.account));
          d.consents.push({ profileId: s, provider: target.provider, account: target.account!, allowed });
        }
      }
      return d;
    }, "updated");
    if (result.status !== "updated") return { ok: false, code: "unavailable", message: this.storeFailure(result).message };
    this.setHint(req.enabled);
    this.log(`memory: 設定（enabled ${req.enabled}，允許 ${allow.length} 個帳號）`);
    // 關閉記憶或改變同意：撤銷持有舊內容的串流與 memory_turn（M11）。首次設定卡才順便選定人物；記憶管理改同意不換本次人物。
    if (profileId !== null && req.enabled && setupCard) this.select(profileId);
    else this.bumpEpoch();
    let view: MemoryTurnView = this.view([this.receipt("updated", txt(req.enabled ? "記憶已開啟" : "記憶已關閉；已存的內容保留"))], null, null, true, null, false);
    if (setupCard) {
      this.cards.delete(setupCard.id);
      // 啟用：從頭處理這句話；沒有啟用：被暫緩的問題照樣送出，不寫入記憶。
      const resumed = req.enabled
        ? await this.process(setupCard.text, setupCard.requestId, parseMemoryText(setupCard.text), 0, "confirmation", {})
        : this.view([], null, chatText(parseMemoryText(setupCard.text)), true, null, false);
      view = { ...resumed, receipts: [...view.receipts, ...resumed.receipts], history_reset: true };
    }
    return { ok: true, op: "setup", ...view, status: this.statusView() };
  }

  private async cardAnswer(req: Record<string, unknown>): Promise<MemoryResponse> {
    const id = req.card;
    const card = typeof id === "string" && CARD_ID.test(id) ? this.cards.get(id) : undefined;
    if (!card || card.expires <= this.now() || card.epoch !== this.presence.epoch) {
      if (card) this.cards.delete(card.id);
      throw new ServiceError("expired", "這張卡片已失效（可能換了人物或超過時間）；請再說一次");
    }
    const choice = req.choice;
    const state = card.state;
    if (state.kind === "setup" && choice !== "cancel") throw new ServiceError("bad_request", "首次設定請用設定畫面完成");
    this.cards.delete(card.id);
    const segments = parseMemoryText(card.text);
    const receipts: MemoryReceiptView[] = [];
    let reset = false;
    const finish = async (from: number): Promise<MemoryResponse> => {
      const rest = await this.process(card.text, card.requestId, segments, from, "confirmation", card.fallback);
      return { ok: true, op: "card_answer", ...rest, receipts: [...receipts, ...rest.receipts], history_reset: rest.history_reset || reset, status: this.statusView() };
    };
    if (state.kind === "setup") {
      // 首次設定卡按取消：被暫緩的問題照樣送出，不寫入記憶。
      return { ok: true, op: "card_answer", ...this.view([this.receipt("cancelled", txt("沒有保存"))], null, chatText(segments), false, null, false), status: this.statusView() };
    }
    if (choice === "cancel" || choice === "decline") {
      receipts.push(this.receipt("cancelled", txt("沒有保存")));
      return finish(state.kind === "face_candidate" ? 0 : card.resume);
    }
    switch (state.kind) {
      case "clarify": {
        if (choice !== "save" && choice !== "household") throw new ServiceError("bad_request", "choice 格式不對");
        if (!state.options.includes(choice)) throw new ServiceError("bad_request", "這張卡片沒有這個選項");
        if (this.currentIsMinor()) receipts.push(this.receipt("minor", txt(MINOR)));
        else if (choice === "save" && state.conflict) {
          const target = this.snapshot().facts.find(f => f.id === state.conflict);
          if (!target) receipts.push(this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）")));
          else {
            // 用卡片保存的原句重新取得票證，再更正原有那一筆。
            const r = await this.writeRemember(state.segment, "subject", card.text, "confirmation", card.requestId, target.id);
            receipts.push(r);
            reset ||= r.status === "updated";
          }
        } else receipts.push(await this.writeRemember(state.segment, choice === "household" ? "household" : "subject", card.text, "confirmation", card.requestId));
        return finish(card.resume);
      }
      case "create_profile": {
        if (choice !== "create") throw new ServiceError("bad_request", "choice 格式不對");
        const data = this.snapshot();
        if (data.profiles.length >= MEMORY_PROFILE_MAX) throw new ServiceError("full", "最多 20 位人物");
        const target = this.options.targets().current;
        const profile: MemoryProfile = { id: `profile_${hex(8)}`, name: state.name, createdAt: new Date(this.now()).toISOString(), facePersonId: null, minor: false };
        const allow = req.allow === true && !!target?.account;
        const { result } = await this.commit(JSON.stringify(["create_profile", profile.id, allow]), (d) => {
          d.profiles.push(profile);
          if (allow) d.consents.push({ profileId: profile.id, provider: target!.provider, account: target!.account!, allowed: true });
          return d;
        }, "saved");
        if (result.status !== "saved") { receipts.push(this.storeFailure(result)); return finish(segments.length); }
        this.select(profile.id);
        reset = true;
        receipts.push(this.receipt("selected", txt("已建立 {0} 的記憶檔；本次人物：{0}", profile.name)));
        return finish(card.resume);
      }
      case "choose_profile": {
        if (choice !== "select" || typeof req.profile !== "string" || !state.profiles.includes(req.profile)) throw new ServiceError("bad_request", "請從卡片上的人物選擇");
        this.select(req.profile);
        reset = true;
        receipts.push(this.receipt("selected", txt("本次人物：{0}", this.nameOf(req.profile))));
        return finish(card.resume);
      }
      case "face_candidate": {
        if (choice !== "accept") throw new ServiceError("bad_request", "choice 格式不對");
        if (!this.profileOf(state.profile)) throw new ServiceError("not_found", "找不到這位人物");
        this.select(state.profile);
        reset = true;
        receipts.push(this.receipt("selected", txt("本次人物：{0}", this.nameOf(state.profile))));
        return finish(0);
      }
      case "pick": {
        const factId = req.fact;
        if (choice !== "select" || typeof factId !== "string" || !state.candidates.includes(factId)) throw new ServiceError("bad_request", "請從卡片上的記憶選擇");
        const target = this.snapshot().facts.find(f => f.id === factId);
        if (this.currentIsMinor()) receipts.push(this.receipt("minor", txt(MINOR)));
        else if (!target) receipts.push(this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）")));
        else {
          const r = await this.writeTarget(state.segment, target, card.text, "confirmation", card.requestId);
          receipts.push(r);
          reset ||= r.status === "updated" || r.status === "forgotten";
        }
        return finish(card.resume);
      }
    }
  }

  /** 主視窗「本次人物」選單（帶這個世代的 select_card）或記憶管理（token）才能選人。 */
  private async selectOp(req: Record<string, unknown>): Promise<MemoryResponse> {
    const cardOk = typeof req.card === "string" && req.card === this.presence.selectCard;
    if (!cardOk && !this.manageToken(req)) throw new ServiceError("no_manage", "請從主視窗的「本次人物」選單選擇");
    const profile = req.profile;
    if (profile !== null && (typeof profile !== "string" || !PROFILE_ID.test(profile) || !this.profileOf(profile))) throw new ServiceError("not_found", "找不到這位人物");
    if (profile !== this.currentProfileId() || this.presence.state !== (profile === null ? "unselected" : "selected")) this.select(profile);
    else this.presence.selectCard = `mc_${hex(12)}`;
    const receipts = [this.receipt("selected", profile ? txt("本次人物：{0}", this.nameOf(profile)) : txt("沒有選定人物：只用全家共用的記憶"))];
    return { ok: true, op: "select", ...this.view(receipts, null, null, true, null, false), status: this.statusView() };
  }

  // ─────────────── 記憶管理 ───────────────

  private manageToken(req: Record<string, unknown>): boolean {
    const m = this.manager;
    const now = this.now();
    if (!m || typeof req.token !== "string" || !MANAGE_TOKEN.test(req.token) || req.token !== m.token) return false;
    if (now - m.lastUsed > MANAGE_IDLE_MS || now - m.openedAt > MANAGE_MAX_MS) { this.manager = null; return false; }
    m.lastUsed = now;
    return true;
  }

  /**
   * 沒有管理畫面時（「你記得我什麼？」卡上的按鈕），只能動本次人物與全家共用的記憶；本次人物是未成年時一律不行，
   * 未成年人物的記憶也只能在記憶管理動。
   */
  private mayTouch(fact: MemoryFact, managed: boolean): boolean {
    if (managed) return true;
    if (this.currentIsMinor() || this.profileOf(fact.profileId)?.minor) return false;
    return fact.profileId === null || fact.profileId === this.currentProfileId();
  }

  private list(req: Record<string, unknown>, ctx: { userInitiated?: boolean }): MemoryResponse {
    let managed = this.manageToken(req);
    let token: string | null = managed ? this.manager!.token : null;
    if (req.manage === true && !managed) {
      // 記憶管理只能由選單列「記憶…」打開（點擊 10 秒內）；語音或頁面腳本不能自己打開。
      if (ctx.userInitiated !== true) throw new ServiceError("not_user_initiated", NEED_MANAGE);
      const now = this.now();
      this.manager = { token: `mm_${hex(16)}`, openedAt: now, lastUsed: now };
      managed = true;
      token = this.manager.token;
    }
    const data = this.snapshot();
    const subject = req.subject === undefined ? this.currentProfileId() : req.subject;
    if (subject !== null && (typeof subject !== "string" || !PROFILE_ID.test(subject) || !this.profileOf(subject))) throw new ServiceError("not_found", "找不到這位人物");
    if (!managed && subject !== null && subject !== this.currentProfileId()) throw new ServiceError("no_manage", NEED_MANAGE);
    const facts = this.activeFacts(data, f => f.profileId === subject).map(f => this.factView(f, data));
    const people = managed ? this.options.identity?.()?.people() ?? null : null;
    const facePeople = people ? people.map(p => ({ person_id: p.person_id, name: p.name, linked: data.profiles.some(x => x.facePersonId === p.person_id) })) : null;
    const consents = this.options.targets().all.filter(t => t.account).map(t => ({ provider: t.provider, account: t.account!, allowed: data.consents.some(c => c.profileId === subject && c.provider === t.provider && c.account === t.account && c.allowed) }));
    return { ok: true, op: "list", facts, subject, manage: token, status: this.statusView(), face_people: facePeople, consents };
  }

  private receiptOp(req: Record<string, unknown>): MemoryResponse {
    const id = req.operation_id;
    if (typeof id !== "string" || !OPERATION_ID.test(id)) throw new ServiceError("bad_request", "operation_id 格式不對");
    const r = this.store!.receipt(id);
    return { ok: true, op: "receipt", status: r.status };
  }

  private findFact(req: Record<string, unknown>, managed: boolean): { fact: MemoryFact; revision: number } {
    const id = req.id;
    const revision = req.revision;
    if (typeof id !== "string" || !FACT_ID.test(id) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new ServiceError("bad_request", "id 與 revision 格式不對");
    const fact = this.snapshot().facts.find(f => f.id === id);
    if (!fact) throw new ServiceError("not_found", "找不到這筆記憶（可能已被忘記）");
    if (!this.mayTouch(fact, managed)) throw new ServiceError("no_manage", NEED_MANAGE);
    return { fact, revision };
  }

  private uiValue(raw: unknown): string {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || [...value].length > MEMORY_VALUE_MAX || /[\u0000-\u001f]/.test(value)) throw new ServiceError("bad_request", "內容需為 1–512 字");
    return value;
  }

  /** 管理畫面的直接輸入：沿用 MEM-0 的字面句型取得票證（點擊與打字都在可信主視窗）。 */
  private literalTicket(command: MemoryCommand): void {
    const session = this.presence.session;
    const input = this.boundary.observeTypedInput(session, literalCommand(command));
    const ticket = this.boundary.issue(session, input, command);
    this.boundary.consume(session, ticket, command);
  }

  private mutationResponse(op: "edit" | "forget" | "pin" | "profile_delete" | "link_face" | "profile_minor", receipt: MemoryReceiptView, reset: boolean): MemoryResponse {
    return { ok: true, op, receipt, history_reset: reset, status: this.statusView() };
  }

  private async edit(req: Record<string, unknown>): Promise<MemoryResponse> {
    const managed = this.manageToken(req);
    const value = this.uiValue(req.value);
    const requestId = `req_ui${hex(8)}`;
    if (req.id === null) {
      // 新增：只在記憶管理畫面（例如家長替未成年家人整理）。敏感資料一樣不收。
      if (!managed) throw new ServiceError("no_manage", NEED_MANAGE);
      const subject = req.subject ?? null;
      if (subject !== null && (typeof subject !== "string" || !this.profileOf(subject))) throw new ServiceError("not_found", "找不到這位人物");
      const parsed = parseMemoryText(`記住：${value}`);
      if (parsed.length === 1 && parsed[0]!.op === "rejected" && parsed[0]!.reason === "sensitive") return this.mutationResponse("edit", this.receipt("rejected", txt(REJECTED.sensitive)), false);
      if (!this.hasRoom(this.snapshot(), 1)) return this.mutationResponse("edit", this.fullReceipt(), false);
      const op = this.operation(JSON.stringify(["add", subject, value]));
      this.literalTicket({ op: "remember", operationId: op.operationId, value });
      const topic = topicOf(value);
      const nowIso = new Date(this.now()).toISOString();
      const fact: MemoryFact = { id: `mem_${hex(8)}`, profileId: subject as string | null, revision: 0, kind: "preference", topic, key: keyOf(value, topic), value, audience: "household", source: { kind: "explicit", turnId: requestId, at: nowIso, excerpt: [...value].slice(0, MEMORY_EXCERPT_MAX).join("") }, validFrom: nowIso, expiresAt: null, reviewAfter: null, pinned: false };
      const { result, operationId } = await this.commit(op, (d) => { fact.revision = this.snapshot().revision + 1; d.facts.push(fact); return d; }, "saved");
      if (result.status !== "saved") return this.mutationResponse("edit", this.storeFailure(result), false);
      return this.mutationResponse("edit", this.receipt("saved", subject ? txt("記在 {0} 名下了：{1}", this.nameOf(subject as string), value) : txt("記在全家共用了：{0}", value), operationId), false);
    }
    const { fact, revision } = this.findFact(req, managed);
    const parsed = parseMemoryText(`記住：${value}`);
    if (parsed.length === 1 && parsed[0]!.op === "rejected" && parsed[0]!.reason === "sensitive") return this.mutationResponse("edit", this.receipt("rejected", txt(REJECTED.sensitive)), false);
    const op = this.operation(JSON.stringify(["edit", fact.id, revision, value]));
    this.literalTicket({ op: "correct", operationId: op.operationId, id: fact.id, expectedRevision: revision, value });
    const receipt = await this.applyCorrect(fact, revision, value, requestId, value, op);
    return this.mutationResponse("edit", receipt, receipt.status === "updated");
  }

  private async forgetOp(req: Record<string, unknown>): Promise<MemoryResponse> {
    const managed = this.manageToken(req);
    const { fact, revision } = this.findFact(req, managed);
    const op = this.operation(JSON.stringify(["forget", fact.id, revision]));
    this.literalTicket({ op: "forget", operationId: op.operationId, id: fact.id, expectedRevision: revision });
    const receipt = await this.applyForget(fact, revision, op);
    return this.mutationResponse("forget", receipt, receipt.status === "forgotten");
  }

  /** 全部忘記（某位人物或全家共用）：只在記憶管理，原生確認後才刪。 */
  private async forgetAll(req: Record<string, unknown>): Promise<MemoryResponse> {
    if (!this.manageToken(req)) throw new ServiceError("no_manage", NEED_MANAGE);
    const scope = req.subject ?? null;
    if (scope !== null && (typeof scope !== "string" || !PROFILE_ID.test(scope) || !this.profileOf(scope))) throw new ServiceError("not_found", "找不到這位人物");
    const facts = this.snapshot().facts.filter(f => f.profileId === scope);
    if (!(await this.options.confirm({ kind: "forget_all", scope: scope ? this.nameOf(scope as string) : null, count: facts.length }))) return this.mutationResponse("forget", this.receipt("cancelled", txt("沒有確認，沒有刪除")), false);
    const ids = new Set(this.snapshot().facts.filter(f => f.profileId === scope).map(f => f.id));
    const { result, operationId } = await this.commit(JSON.stringify(["forget_all", scope, ids.size]), (d) => {
      const revision = this.snapshot().revision + 1;
      d.facts = d.facts.filter(f => !ids.has(f.id));
      d.tombstones = [...d.tombstones.filter(t => !ids.has(t.id)), ...[...ids].map(id => ({ id, revision }))].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") return this.mutationResponse("forget", this.storeFailure(result), false);
    this.bumpEpoch();
    return this.mutationResponse("forget", this.receipt("forgotten", scope ? txt("已忘記 {0} 的 {1} 筆記憶", this.nameOf(scope as string), String(ids.size)) : txt("已忘記全家共用的 {0} 筆記憶", String(ids.size)), operationId), true);
  }

  private async pin(req: Record<string, unknown>): Promise<MemoryResponse> {
    const managed = this.manageToken(req);
    const { fact, revision } = this.findFact(req, managed);
    if (typeof req.pinned !== "boolean") throw new ServiceError("bad_request", "pinned 必須是 true 或 false");
    if (fact.revision !== revision) return this.mutationResponse("pin", this.receipt("conflict", txt("這筆記憶剛被改過；請重新整理後再試")), false);
    const pinned = req.pinned;
    const data = this.snapshot();
    // 釘選最多 4 筆會預載（16 §7）；超過也保存，但檢索只取 4 筆，畫面照實說明。
    const { result, operationId } = await this.commit(JSON.stringify(["pin", fact.id, revision, pinned]), (d) => {
      const nextRevision = this.snapshot().revision + 1;
      d.facts = d.facts.map(f => f.id === fact.id ? { ...f, pinned, revision: nextRevision } : f);
      return d;
    }, "updated");
    if (result.status !== "updated") return this.mutationResponse("pin", this.storeFailure(result), false);
    const count = data.facts.filter(f => f.pinned && f.profileId === fact.profileId && f.id !== fact.id).length + (pinned ? 1 : 0);
    return this.mutationResponse("pin", this.receipt("updated", pinned ? (count > 4 ? txt("已釘選；每次最多預載 4 筆釘選的記憶") : txt("已釘選這筆記憶")) : txt("已取消釘選"), operationId), false);
  }

  /** 記憶管理手動標記未成年（沒有連結家人辨識時也能標）。 */
  private async profileMinor(req: Record<string, unknown>): Promise<MemoryResponse> {
    if (!this.manageToken(req)) throw new ServiceError("no_manage", NEED_MANAGE);
    const profile = typeof req.profile === "string" && PROFILE_ID.test(req.profile) ? this.profileOf(req.profile) : undefined;
    if (!profile) throw new ServiceError("not_found", "找不到這位人物");
    if (typeof req.minor !== "boolean") throw new ServiceError("bad_request", "minor 必須是 true 或 false");
    const minor = req.minor;
    const { result, operationId } = await this.commit(JSON.stringify(["profile_minor", profile.id, minor]), (d) => {
      d.profiles = d.profiles.map(p => p.id === profile.id ? { ...p, minor } : p);
      return d;
    }, "updated");
    if (result.status !== "updated") return this.mutationResponse("profile_minor", this.storeFailure(result), false);
    if (this.presence.subject.kind === "person" && this.presence.subject.profileId === profile.id) this.bumpEpoch();
    return this.mutationResponse("profile_minor", this.receipt("updated", minor ? txt("已把 {0} 標為未成年：聊天不會寫入或改動他的記憶", profile.name) : txt("已取消 {0} 的未成年標記", profile.name), operationId), false);
  }

  private async profileDelete(req: Record<string, unknown>): Promise<MemoryResponse> {
    if (!this.manageToken(req)) throw new ServiceError("no_manage", NEED_MANAGE);
    const id = req.profile;
    const profile = typeof id === "string" && PROFILE_ID.test(id) ? this.profileOf(id) : undefined;
    if (!profile) throw new ServiceError("not_found", "找不到這位人物");
    const count = this.snapshot().facts.filter(f => f.profileId === profile.id).length;
    if (!(await this.options.confirm({ kind: "profile_delete", name: profile.name, count }))) return this.mutationResponse("profile_delete", this.receipt("cancelled", txt("沒有確認，沒有刪除")), false);
    const receipt = await this.deleteProfile(profile.id);
    return this.mutationResponse("profile_delete", receipt, receipt.status === "forgotten");
  }

  /** 刪除整個人物記憶：事實、同意與連結一起清除，只留不含正文的墓碑（16 §8）。 */
  private async deleteProfile(profileId: string): Promise<MemoryReceiptView> {
    const data = this.snapshot();
    const profile = data.profiles.find(p => p.id === profileId);
    if (!profile) return this.receipt("not_found", txt("找不到這位人物"));
    const facts = data.facts.filter(f => f.profileId === profileId);
    const { result, operationId } = await this.commit(JSON.stringify(["profile_delete", profileId]), (d) => {
      const revision = this.snapshot().revision + 1;
      d.profiles = d.profiles.filter(p => p.id !== profileId);
      d.facts = d.facts.filter(f => f.profileId !== profileId);
      d.consents = d.consents.filter(c => c.profileId !== profileId);
      d.tombstones = [...d.tombstones, ...facts.map(f => ({ id: f.id, revision }))].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") return this.storeFailure(result);
    if (this.presence.subject.kind === "person" && this.presence.subject.profileId === profileId) this.select(null);
    else this.bumpEpoch();
    return this.receipt("forgotten", txt("已刪除 {0} 的記憶檔（{1} 筆）", profile.name, String(facts.length)), operationId);
  }

  private async linkFace(req: Record<string, unknown>): Promise<MemoryResponse> {
    if (!this.manageToken(req)) throw new ServiceError("no_manage", NEED_MANAGE);
    const profile = typeof req.profile === "string" && PROFILE_ID.test(req.profile) ? this.profileOf(req.profile) : undefined;
    if (!profile) throw new ServiceError("not_found", "找不到這位人物");
    const personId = req.person;
    if (personId !== null && (typeof personId !== "string" || !PERSON_ID.test(personId))) throw new ServiceError("bad_request", "person 格式不對");
    const people = this.options.identity?.()?.people() ?? null;
    const person = personId ? people?.find(p => p.person_id === personId) : undefined;
    if (personId && !person) throw new ServiceError("not_found", "找不到這位家人辨識資料（請先打開一次「家人辨識…」）");
    if (personId && this.snapshot().profiles.some(p => p.facePersonId === personId && p.id !== profile.id)) throw new ServiceError("conflict", "這位家人辨識資料已連結到另一個記憶檔");
    // 相同名字不會自動接回舊資料（M16）：一定要在管理畫面選擇並經原生確認。
    if (!(await this.options.confirm({ kind: "link_face", profile: profile.name, person: person?.name ?? null }))) return this.mutationResponse("link_face", this.receipt("cancelled", txt("沒有確認，沒有連結")), false);
    const { result, operationId } = await this.commit(JSON.stringify(["link_face", profile.id, personId]), (d) => {
      d.profiles = d.profiles.map(p => p.id === profile.id ? { ...p, facePersonId: personId as string | null, minor: person ? person.minor || p.minor : p.minor } : p);
      return d;
    }, "updated");
    if (result.status !== "updated") return this.mutationResponse("link_face", this.storeFailure(result), false);
    if (this.presence.subject.kind === "person" && this.presence.subject.profileId === profile.id) this.bumpEpoch();
    return this.mutationResponse("link_face", this.receipt("updated", person ? txt("已把 {0} 的記憶檔連結到家人辨識的「{1}」", profile.name, person.name) : txt("已解除 {0} 的家人辨識連結", profile.name), operationId), false);
  }

  // ─────────────── 家人辨識的連接點（只給核心） ───────────────

  /**
   * 刪除家人前：連結到這位家人的記憶筆數。store 還沒開時不為了計數去開（不碰 Keychain），回 count null（畫面寫「刪除時一併處理」）；
   * store 開著而且沒有連結，或記憶不可用時回 null。
   */
  async countForFace(personId: string): Promise<{ count: number | null; minor: boolean } | null> {
    if (!PERSON_ID.test(personId) || this.closed) return null;
    if (this.storeState === "unloaded") return this.options.available() ? { count: null, minor: false } : null;
    if (this.storeState !== "ready" || !this.store) return null;
    const data = this.snapshot();
    const profile = data.profiles.find(p => p.facePersonId === personId);
    return profile ? { count: this.activeFacts(data, f => f.profileId === profile.id).length, minor: profile.minor } : null;
  }

  /**
   * 刪除家人後：只解除連結並暫停本次人物（預設），或依確認時的勾選刪除整個記憶檔（17 §9.4、George 決定 ⑨）。
   * 回傳實際結果，家人辨識畫面照實告知；使用者確認後才開 store。
   */
  async unlinkFace(personId: string, deleteMemory: boolean): Promise<"none" | "unlinked" | "deleted" | "failed"> {
    return this.exclusive(async () => {
      if (!PERSON_ID.test(personId)) return "failed";
      if (!(await this.ensureOpen())) return this.storeState === "unloaded" && !this.options.available() ? "none" : "failed";
      const profile = this.snapshot().profiles.find(p => p.facePersonId === personId);
      if (!profile) return "none";
      const current = this.presence.subject.kind === "person" && this.presence.subject.profileId === profile.id;
      if (deleteMemory) return (await this.deleteProfile(profile.id)).status === "forgotten" ? "deleted" : "failed";
      const { result } = await this.commit(JSON.stringify(["unlink", profile.id]), (d) => {
        d.profiles = d.profiles.map(p => p.id === profile.id ? { ...p, facePersonId: null } : p);
        return d;
      }, "updated");
      this.log(`memory: 家人刪除後解除連結（${result.status}）`);
      if (current) this.suspend("unlinked");
      return result.status === "updated" ? "unlinked" : "failed";
    });
  }

  // ─────────────── 一般文字聊天 ───────────────

  /**
   * /api/chat：驗證一次性的 memory_turn（60 秒、綁本次 session、世代、原句與 request_id），通過才檢索並以 lease 包住整個串流。
   * 不符就不取用記憶（照常聊天、照實告知）。撤銷時 ctx.signal abort、deliver 回 false。
   * historyLength：這次請求帶了幾則訊息。只有 1 則（頁面清空了歷史）時才解除交辦封鎖；之後只要有一輪用了記憶，
   * 含歷史的請求（包括語音來源、沒有 memory_turn 的）交辦一律改成問使用者。
   */
  async withChat<T>(request: { nonce: unknown; requestId: string; lastUser: string; target: ChatTarget | null; historyLength?: number }, run: (ctx: MemoryContext) => Promise<T>): Promise<T> {
    if ((request.historyLength ?? 1) <= 1) this.historyTainted = false;
    const tainted = this.historyTainted;
    const nonce = request.nonce;
    if (nonce === undefined || nonce === null) return run(plainContext(null, tainted));
    const binding = typeof nonce === "string" && TURN_NONCE.test(nonce) ? this.turns.get(nonce) : undefined;
    if (typeof nonce === "string") this.turns.delete(nonce);
    if (!binding || binding.expires <= this.now() || binding.requestId !== request.requestId || binding.text !== request.lastUser
      || binding.epoch !== this.presence.epoch || binding.session !== this.presence.session || !this.boundary.active(binding.session)) {
      return run(plainContext(txt("這次沒有用到記憶（本次人物已改變或請求已過期）"), tainted));
    }
    if (this.storeState !== "ready" || !this.store) return run(plainContext(this.unavailableText(), tainted));
    let data: MemorySnapshot;
    try { data = this.snapshot(); } catch { return run(plainContext(this.unavailableText(), tainted)); }
    if (!data.settings.enabled) return run(plainContext(txt("記憶功能已關閉；這次沒有用到記憶"), tainted));
    this.touch();
    const profileId = this.currentProfileId();
    const result = retrieve({ facts: data.facts, consents: data.consents, profileId, target: request.target, query: request.lastUser, now: this.now() });
    this.log(`memory: 檢索 ${result.facts.length} 筆（捨去 ${result.dropped}，未同意 ${result.blockedByConsent}）`);
    const notice = result.facts.length === 0 && result.blockedByConsent > 0 ? txt("這次沒有用到記憶：目前的服務或帳號尚未允許取用") : null;
    if (result.facts.length === 0) return run({ ...plainContext(notice, tainted), saved: binding.saved });
    this.historyTainted = true;
    try {
      return await this.boundary.withContext(binding.session, async () => {}, (lease) => run({ facts: result.facts, signal: lease.signal, deliver: lease.deliver, saved: binding.saved, notice, blockDelegation: true }), "text");
    } catch (error) {
      if ((error as Error)?.message === "inactive_session") return run(plainContext(txt("這次沒有用到記憶（本次人物已改變或請求已過期）"), true));
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.manager = null;
    this.turns.clear();
    this.cards.clear();
    void this.boundary.revoke(this.presence.session);
    await this.queue.catch(() => undefined);
    await this.store?.close().catch(() => undefined);
    this.store = null;
  }
}
