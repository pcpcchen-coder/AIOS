import { randomBytes, randomUUID } from "node:crypto";
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
  WORK_CHOICES_MAX,
  WORK_CHOICE_WINDOW_MS,
} from "../../shared/memory.ts";
import { literalCommand, MemoryBoundary, type ContextLease, type InputVia, type MemoryCommand, type MemorySession, type ParsedMemoryCommand, type Subject } from "./boundary.ts";
import { LiveMemoryBinding, VOICE_CARDS_PER_MINUTE, type LiveBindingOptions, type LiveContextResult, type LiveMemoryService, type RevokeWhy, type VoiceAction, type VoiceRoute, type VoiceTurnOutcome } from "./live.ts";
import { chatText, keyOf, parseMemoryText, topicOf, workDecision, type ParsedSegment } from "./parse.ts";
import { relevance, retrieve, type ChatTarget, type ContextFact } from "./retrieve.ts";
import { SuggestionBook, suggestFrom, suggestionBodies, SUGGEST_TTL_MS, type PendingSuggestion } from "./suggest.ts";
import type { Locale } from "../../shared/i18n.mjs";
import type { LiveMemoryReason } from "../../shared/realtime-route.ts";
import { newStoreOperation, RESULT_LIMIT, type MemoryData, type MemoryFact, type MemoryOutcome, type MemoryProfile, type MemoryResult, type MemorySnapshot, type MemoryStoreLike, type StoreOperation, type StoreResult } from "./store.ts";
import type { ExecutorMode, Task } from "../../shared/types.ts";
import { shellOf } from "../store.ts";
import { DELEGATE_CARD } from "../../shared/protected-tasks.ts";

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
// - MEM-2（ChatGPT 方案即時語音）：openLive 建立每通通話的 LiveMemoryBinding（server/memory/live.ts）；同意鍵是獨立的
//   codex（targets().live），不沿用 chatgpt。語音的記住、更正、忘記只出 voice_confirm 卡，語音確認詞或畫面點擊才寫入。
// - MEM-3（OpenAI API key 即時語音）：openVoice(route) 依路徑建立 binding；同意對象來自 targets().byRoute[route]
//   （api_key：openai_realtime，OPENAI_API_KEY 的 HMAC），boundary 的放行表決定這條路徑能不能帶記憶。同時只允許一通語音通話帶記憶。
// - MEM-4b（語音交辦自動帶記憶）：delegateVoice 用 binding 核對過的語音辨識原句（via voice_heard）走同一個 delegateProtected；
//   受保護的原句卡由這裡持有原句（voiceDelegateCard），可信主視窗經 tasks IPC 取標題、按「交辦」算直接確認（confirmation）。
// - MEM-5a（記憶建議與家庭協同，docs/validation/memory-mem5a-2026-10-30.md）：可信主視窗打字的一輪處理完、沒有任何記憶指令與卡片時，
//   maybeSuggest 用 server/memory/suggest.ts 的固定規則從 chat 段落找一句第一人稱的穩定偏好，最多 1 筆，只放在記憶體
//   （SuggestionBook）；turn 只回卡片 ID，內容經 card_view。只有在那張卡上按「記住」（confirmation，suggestFrom 重新解析）才寫入，
//   source.kind "suggestion"。要 NOUS_MEMORY_ROUTES 列出 suggest、而且記憶管理裡開了 settings.suggestions 才會提。
//   全家共用的新事實在旗標開著時記下 source.by（當時的本次人物；不是身分驗證），只在查看記憶時顯示。
// - MEM-5b（工作決定，docs/validation/memory-mem5b-2026-10-30.md）：NOUS_MEMORY_ROUTES 列出 work_summary、任務確實加密保存時，
//   打字的「記住這次選了方案 B」先出選擇卡（最近 24 小時成功完成、沒有撤回、在目前範圍內的工作，最多 5 個；標題只經 IPC），
//   點選才寫入 kind work_summary（值＝使用者原話，derivedFrom＝那個任務）。依賴的記憶被忘記、更正或過期而撤回成果時在同一次
//   提交裡連帶忘記（固定點）；任務已不存在時由對帳忘記（開檔與可信主視窗的 turn／list）。記憶關閉、撤回同意或依賴索引超過上限
//   只撤回成果、保留工作決定（審查 M1）；讀不到的任務（金鑰問題）不清。

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
  /** MEM-2：稱名設定（看著說話時用名字問候）是否開著；關著時語音問句不帶人物名。沒有提供時當作開著。 */
  nameAllowed?(): boolean;
}

export interface MemoryServiceOptions {
  openStore: () => Promise<MemoryStoreLike>;
  /** 安全儲存是否可用（不開 store）。 */
  available: () => boolean;
  /**
   * 一般聊天目前的服務帳號，以及所有已設定的服務帳號（首次設定逐一允許）。live：ChatGPT 方案即時語音（Codex 登入）的
   * 同意鍵（provider codex）；沒有登入時為 null。all 也要含它，首次設定卡與記憶管理才能逐一允許。
   */
  targets: () => { current: ChatTarget | null; all: ChatTarget[]; live?: ChatTarget | null; byRoute?: Partial<Record<VoiceRoute, ChatTarget | null>> };
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
  /**
   * MEM-4a：受保護交辦的任務端（核心的 TaskRunner）。沒有提供時沒有受保護交辦（和 M15 一樣）。
   * target：任務引擎的同意對象（沿用 claude／chatgpt 的同意，Q4-A）；模擬引擎不帶記憶。
   */
  tasks?: TaskPort;
  /**
   * MEM-4a 撤銷傳播：受保護成果的依賴被撤銷（忘記、更正、撤回同意、刪除人物、關閉記憶、記憶過期）。快照先寫入
   * withdrawn，之後才呼叫；記憶檔開啟時也會為已撤銷的成果再呼叫一次（重啟後清掉中斷前沒刪完的成果檔）。
   */
  onResultsWithdrawn?: (taskIds: string[]) => void;
  /**
   * MEM-4c：提交撤回（寫快照）期間先把這些任務對外改成外殼（TaskStore.hold），回傳釋放函式。快照寫入與 onResultsWithdrawn
   * 之間有非同步的空檔；這段期間的搜尋、詳細與模型標題都不會用到撤回中的成果。
   */
  holdResults?: (taskIds: string[]) => () => void;
  /**
   * MEM-4c：記憶關閉（設定改成關閉）、記憶檔因寫入失敗而停用、或記憶層關閉（結束 App）時，請任務端丟棄記憶體裡
   * 已結束受保護任務的解密內容與倒排索引。OS 鎖定與睡眠由主程序直接通知任務端（desktop/main.mjs）。
   */
  onPlaintextDrop?: (reason: "memory_off" | "memory_closed") => void;
  /** 只限測試：依賴索引的筆數上限（正式一律 RESULT_LIMIT）。 */
  resultLimit?: number;
  /**
   * MEM-5a：NOUS_MEMORY_ROUTES 列出 suggest（預設關閉）。關閉時不提建議、不能在記憶管理開啟建議，全家共用的新事實也不記 source.by，
   * 快照照 2／3 寫。使用者還要在記憶管理開 settings.suggestions，兩者都開才會提。
   */
  suggest?: boolean;
  /**
   * MEM-5b：NOUS_MEMORY_ROUTES 列出 work_summary（預設關閉）。關閉時「記住這次選了方案 B」照舊記成一般筆記；
   * 已經存在的工作決定照樣顯示、檢索，任務被刪或成果被撤回時照樣連帶忘記（撤銷不看旗標）。
   */
  workSummary?: boolean;
}

/** MEM-4a：受保護交辦需要的任務端介面（只在核心內）。 */
export interface TaskPort {
  /**
   * 審查 M1：任務是否真的加密保存（TaskStore 在加密模式、而且金鑰沒有問題）。false（明文退回、金鑰不可用）時不做受保護交辦，
   * 改出原句卡：用到記憶的成果不能落到明文或只在記憶體。
   */
  sealed(): boolean;
  mode(): ExecutorMode;
  target(): ChatTarget | null;
  submit(input: { task_id: string; title: string; request_id: string; locale?: Locale; retry_of?: string; facts: ContextFact[]; target?: { provider: string; account: string } | null }): Task;
  /** MEM-4b：給頁面的外殼（SSE 的 delegated 事件只帶外殼；真實標題經 IPC）。沒有提供時用 shellOf。 */
  publicGet?(taskId: string): Task | undefined;
  /**
   * MEM-5b：可信主視窗看得到的任務清單（TaskStore.listFor）：inScope 為 true、沒有撤回中而且讀得到內容的給真實內容，其他給外殼
   * （protected: true）。只在核心內用來列工作決定卡與記憶清單上的連結標題；內容不進記憶、不送模型。
   */
  scopedList?(inScope: (task: Task) => boolean): Task[];
  /** MEM-5b：任務還在不在（不解密）：present、withdrawn（成果已撤回）、missing（已刪除）。讀不到內容的任務仍是 present。 */
  taskState?(taskId: string): "present" | "withdrawn" | "missing";
}

/** MEM-4b：受保護原句卡的有效時間（卡片留在畫面上，按「交辦」時才核對）。 */
export const DELEGATE_CARD_MS = 10 * 60_000;
/** MEM-4b：受保護原句卡的 ID（不透明；SSE 只送它）。和 IPC 過濾共用 shared/protected-tasks.ts 的同一個 regex。 */
export const DELEGATE_CARD_ID = DELEGATE_CARD;

/** 受保護交辦的結果：task 是核心的完整任務（對外前要換外殼）；used 是帶了幾筆記憶。 */
export interface ProtectedDelegation { task: Task; used: number }

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
  /**
   * MEM-4a：受保護交辦（NOUS_MEMORY_ROUTES 含 task、記憶開著、這一輪是可信主視窗的打字）。標題一律是這一輪的使用者原句；
   * 依原句重新檢索（8 筆、4 KB）並寫入依賴索引後才建立任務。沒有放行或不適用時為 null（照 M15：不交辦或出交辦卡）。
   * 回 null＝這次沒能受保護交辦（呼叫端改出交辦卡）。
   */
  delegate: ((locale?: Locale) => Promise<ProtectedDelegation | null>) | null;
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
  /** MEM-2：語音的記住、更正、忘記（origin live）。target：更正或忘記的那一筆與當時的版本；replace：記住時要取代的偏好。 */
  | { kind: "voice_confirm"; action: VoiceAction; segment: Extract<ParsedSegment, { op: "remember" | "correct" | "forget" }>; scope: "subject" | "household"; target: { id: string; revision: number } | null; replace: string | null }
  /** MEM-2：語音「你記得我什麼？」：內容在 card_view 時才組（不經 SSE）。 */
  | { kind: "inspect" }
  | { kind: "clarify"; segment: Extract<ParsedSegment, { op: "remember" }>; conflict: string | null; options: ClarifyChoice[] }
  | { kind: "create_profile"; name: string }
  | { kind: "choose_profile"; name: string; profiles: string[] }
  | { kind: "face_candidate"; profile: string; person?: string; at?: number }
  | { kind: "pick"; action: "correct" | "forget"; segment: Extract<ParsedSegment, { op: "correct" | "forget" }>; candidates: string[] }
  /** MEM-5b：工作決定卡。profileId：出卡時的本次人物；tasks：卡上列出的任務 ID（核心持有，點選只能從這裡選）。 */
  | { kind: "work_summary"; segment: Extract<ParsedSegment, { op: "remember" }>; profileId: string; tasks: string[] };

/**
 * fallback：處理到卡片前，因為找不到目標而改交給聊天的段落（卡片回答後一起送）。
 * origin：typed＝打字那一輪（回答後續送剩下的聊天）；live＝即時語音（模型已經聽到了，不經 /api/chat 續送）。
 */
/** route：MEM-3 語音卡來自哪條即時語音路徑（origin live 的卡；回條與 log 記路徑）。 */
interface Card { id: string; state: CardState; text: string; part: number; resume: number; requestId: string; epoch: number; expires: number; fallback: Record<number, string>; origin: "typed" | "live"; route?: VoiceRoute }

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

/**
 * 審查 m4：MEM-5a 只處理 preference 與 note。MEM-5b 起 work_summary（工作決定）也列出、可以更正或忘記、依同意送給模型
 * （retrieve.ts 同一條規則）。降回 MEM-5a 時那一版仍不顯示它。
 */
export function shownKind(f: Pick<MemoryFact, "kind">): boolean {
  return f.kind === "preference" || f.kind === "note" || f.kind === "work_summary";
}

/** MEM-5b：這次提交要連帶忘記的工作決定（連到的任務成果被撤回）。 */
function workFactsOf(facts: readonly MemoryFact[], taskIds: ReadonlySet<string>): MemoryFact[] {
  return facts.filter(f => f.kind === "work_summary" && f.derivedFrom !== null && taskIds.has(f.derivedFrom.taskId));
}

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
  return { facts: [], signal: null, deliver: (output) => { output(); return true; }, saved: false, notice, blockDelegation, delegate: null };
}

/** 這些段落需要使用者明說「記住」（首次設定卡只為它們出現，也只有它們會在記憶未開啟時打開 store）。 */
function explicitRemember(segments: readonly ParsedSegment[]): boolean {
  return segments.some(s => s.op === "remember" || s.op === "unclear");
}

/**
 * MEM-4a：這次提交會撤回哪些受保護成果（回傳 taskId）。規則（Q3-A）：記憶關閉；人物被刪；任何一筆依賴被刪或版本變了
 * （忘記、更正、過期）；依賴所屬範圍（人物或全家共用）對那個服務帳號的同意不再成立。換人、閒置不在其中。
 */
export function withdrawals(before: MemoryData, after: MemoryData): Set<string> {
  return new Set(withdrawalCauses(before, after).keys());
}

/**
 * MEM-5b 審查 M1：同一套撤回規則，另外記下原因。forgotten：依賴的記憶被刪（忘記、過期）或版本變了（更正），或人物被刪除——
 * 來源真的沒了；reversible：記憶關閉或同意撤回（之後可以再打開）。兩種原因都有時算 forgotten。
 */
export function withdrawalCauses(before: MemoryData, after: MemoryData): Map<string, "forgotten" | "reversible"> {
  const out = new Map<string, "forgotten" | "reversible">();
  for (const r of after.results) {
    if (r.state !== "active") continue;
    const facts = r.deps.map(d => ({ dep: d, old: before.facts.find(f => f.id === d.factId), now: after.facts.find(f => f.id === d.factId) }));
    const consented = (profileId: string | null) => after.consents.some(c => c.allowed && c.profileId === profileId && c.provider === r.target.provider && c.account === r.target.account);
    if ((r.subject !== null && !after.profiles.some(p => p.id === r.subject)) || facts.some(x => !x.now || x.now.revision !== x.dep.revision)) out.set(r.taskId, "forgotten");
    else if (!after.settings.enabled || facts.some(x => !consented((x.now ?? x.old)?.profileId ?? null))) out.set(r.taskId, "reversible");
  }
  return out;
}

/**
 * MEM-5b：一次提交裡的撤回與工作決定連帶忘記（固定點；planned 會被改動）。只有「來源真的沒了」（forgotten）的成果，
 * 連到它的工作決定才忘記（審查 M1：記憶關閉、撤回同意、依賴索引超過上限都是可以回頭的，只撤回成果，保留使用者的原話）。
 * 忘記的工作決定若被別的成果用到，那些成果也撤回（原因是 forgotten），再忘記連到它們的工作決定……每一輪至少多撤回一筆成果
 * 才有下一輪，所以 rounds 不超過依賴索引的筆數；另設上限 results.length + 1。
 */
export function settleWithdrawals(before: MemoryData, planned: MemoryData, tombstoneRevision: number): { withdrawn: Set<string>; forgotten: Set<string>; cascaded: number; rounds: number } {
  const causes = withdrawalCauses(before, planned);
  const withdrawn = new Set(causes.keys());
  const forgotten = new Set([...causes].filter(([, c]) => c === "forgotten").map(([id]) => id));
  const bound = planned.results.length + 1;
  let cascaded = 0, rounds = 0;
  for (;;) {
    if (withdrawn.size) planned.results = planned.results.map(r => withdrawn.has(r.taskId) && r.state === "active" ? { ...r, state: "withdrawn" as const, deps: [], subject: null } : r);
    const gone = workFactsOf(planned.facts, forgotten);
    if (!gone.length || rounds >= bound) break;
    rounds++;
    const ids = new Set(gone.map(f => f.id));
    planned.facts = planned.facts.filter(f => !ids.has(f.id));
    planned.tombstones = [...planned.tombstones.filter(t => !ids.has(t.id)), ...gone.map(f => ({ id: f.id, revision: tombstoneRevision }))].slice(-10000);
    cascaded += gone.length;
    for (const [id, cause] of withdrawalCauses(before, planned)) {
      withdrawn.add(id);
      if (cause === "forgotten") forgotten.add(id);
    }
  }
  return { withdrawn, forgotten, cascaded, rounds };
}

/** live 卡片的回條對應到要念的固定句。 */
function liveStatus(status: MemoryReceiptStatus): MemoryReceiptStatus {
  return status === "saved" || status === "updated" || status === "forgotten" || status === "cancelled" ? status : "rejected";
}

export class MemoryService implements LiveMemoryService {
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
  /** MEM-2：進行中的 live 通話（一個核心只有一個）。 */
  private live: LiveMemoryBinding | null = null;
  /** MEM-3：建立 binding 時的上一通（busy 的那通結束時把位置交還）。 */
  private readonly previousVoice = new WeakMap<LiveMemoryBinding, LiveMemoryBinding>();
  /** 被撤銷的世代為什麼被撤銷（live 的 cleanup 依此決定重建或結束）。 */
  private readonly revokedBy = new WeakMap<MemorySession, RevokeWhy>();
  /** MEM-2：語音卡的建立時間（以核心計數，重建後不歸零）與目前那一張（同時最多 1 張，挑選卡也算）。 */
  private readonly voiceCardTimes: number[] = [];
  private liveVoiceCard: string | null = null;
  /** MEM-4b：受保護原句卡（核心持有原句；最多 16 張）。 */
  private readonly delegateCards = new Map<string, { title: string; route: VoiceRoute; expires: number; session: MemorySession; epoch: number; locale?: Locale }>();
  /** MEM-5a：記憶建議（候選、被拒絕的 key、頻率計數）只在記憶體。 */
  private readonly suggestions = new SuggestionBook();
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
        // MEM-4a：已撤回的受保護成果再確認一次已刪（撤銷提交後、刪檔前中斷的情況）。
        const withdrawn = this.snapshot().results.filter(r => r.state === "withdrawn").map(r => r.taskId);
        if (withdrawn.length) this.propagate(withdrawn);
        // MEM-5b：對帳（連到的任務已不存在的工作決定一起忘記；任務刪除本身不碰記憶，見 reconcileWork）。
        // 不等它：開檔可能發生在別的互斥操作裡；排在互斥佇列，下一個操作之前就會做完。
        void this.exclusive(() => this.reconcileWork("open")).catch(() => this.log("memory: 工作決定對帳失敗"));
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

  /**
   * 撤銷目前世代：舊 session 的串流 abort、memory_turn、卡片與 request_id 快取失效，通知頁面清掉用過記憶的歷史。
   * why：給 live 通話的 cleanup 判斷重建或結束（MEM-2）。
   */
  private replacePresence(state: PresenceState, subject: Subject, reason: MemoryText | null, why: RevokeWhy = "updated"): void {
    const old = this.presence;
    this.presence = this.openPresence(state, subject, reason);
    this.turns.clear();
    this.cards.clear();
    // MEM-4b 審查 M3：受保護原句卡綁本次人物世代；換人或世代改變就作廢（點擊回 not_found）。
    this.delegateCards.clear();
    // MEM-5a：換世代（換人、暫停、閒置、OS 鎖定、更正、忘記、撤銷）時，記憶建議的候選與被拒絕的 key 一起丟掉。
    this.suggestions.clear();
    this.recent.clear();
    this.revokedBy.set(old.session, why);
    void this.boundary.revoke(old.session).then(ok => { if (!ok) this.log("memory: 撤銷清理未完成"); });
    this.options.onChange?.();
    try { this.options.onPresence?.(); } catch { /* 通知失敗不影響撤銷 */ }
    try { this.live?.presenceChanged(); } catch { /* 語音通話自己處理 */ }
  }

  /** 換新世代但維持同一人物（更正、忘記、撤回同意之後）。 */
  private bumpEpoch(why: RevokeWhy = "updated"): void {
    this.replacePresence(this.presence.state, this.presence.subject, this.presence.reason, why);
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

  private select(profileId: string | null, why: RevokeWhy = "presence"): void {
    if (profileId === null) this.replacePresence("unselected", { kind: "household" }, null, why);
    else this.replacePresence("selected", { kind: "person", profileId }, null, why);
    this.log(`memory: 本次人物 ${profileId === null ? "unselected" : "selected"}`);
  }

  /**
   * 暫停本次人物（只能降權，不能選人）。「互動結束」的定義：有鏡頭時是追蹤中斷（在場判斷結束或鏡頭停止）與多人入鏡，
   * 無鏡頭時是閒置 30 分鐘；另加 OS 鎖定與刪除連結的家人。
   */
  suspend(reason: "multi_face" | "tracking_lost" | "os_lock" | "idle" | "unlinked"): void {
    if (this.presence.state !== "selected") {
      if (reason === "os_lock") this.replacePresence(this.presence.state, this.presence.subject, this.presence.reason, "os_lock");
      return;
    }
    // 固定句型整句翻譯（values 只放使用者的話或名字，不放介面文字）。
    const message = reason === "multi_face" ? "已暫停本次人物（畫面裡有多張臉）；請重新選擇" : reason === "tracking_lost" ? "已暫停本次人物（追蹤中斷）；請重新選擇"
      : reason === "os_lock" ? "已暫停本次人物（電腦已鎖定）；請重新選擇" : reason === "idle" ? "已暫停本次人物（閒置超過 30 分鐘）；請重新選擇" : "已暫停本次人物（家人辨識資料已刪除）；請重新選擇";
    this.replacePresence("suspended", { kind: "household" }, txt(message), reason === "os_lock" ? "os_lock" : "suspended");
    this.log(`memory: 本次人物暫停（${reason}）`);
  }

  /** OS 鎖定（powerMonitor lock-screen）。 */
  suspendAll(): void { this.suspend("os_lock"); }

  /** 主視窗導覽、重新載入或 renderer 結束：回到 unselected，管理畫面失效。 */
  closeSessions(): void {
    this.manager = null;
    this.historyTainted = false;
    this.replacePresence("unselected", { kind: "household" }, null, "closed");
  }

  private checkIdle(): void {
    const idle = this.options.idleMs ?? MEMORY_IDLE_MS;
    if (this.presence.state === "selected" && this.now() - this.presence.lastActive > idle) this.suspend("idle");
    this.sweepExpired();
  }

  private sweeping = false;
  /**
   * 審查 minor 3：受保護成果依賴的記憶過期了（例如「今天有效」），不等下一次有人改記憶，就提交一次（只清過期與撤回），
   * 讓執行中的任務停止、已完成的成果移除。每分鐘的計時器與每次操作都會檢查；沒有到期的依賴時什麼都不做。
   */
  private sweepExpired(): void {
    if (this.sweeping || this.closed || this.storeState !== "ready" || !this.store) return;
    let data: MemorySnapshot;
    try { data = this.snapshot(); } catch { return; }
    const now = this.now();
    const due = data.results.some(r => r.state === "active" && r.deps.some(d => {
      const fact = data.facts.find(f => f.id === d.factId);
      return !fact || (fact.expiresAt !== null && Date.parse(fact.expiresAt) <= now);
    }));
    if (!due) return;
    this.sweeping = true;
    void this.exclusive(() => this.commit(JSON.stringify(["expire_sweep", now]), d => d, "unchanged"))
      .catch(() => this.log("memory: 過期清除失敗"))
      .finally(() => { this.sweeping = false; });
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
      suggestions: { available: this.options.suggest === true, enabled: data.settings.suggestions },
    };
  }

  private factView(f: MemoryFact, data: MemoryData, labels: Map<string, NonNullable<MemoryFactView["work"]>>): MemoryFactView {
    const by = f.profileId === null && f.source.by ? data.profiles.find(p => p.id === f.source.by)?.name ?? null : null;
    const work = f.kind === "work_summary" && f.derivedFrom ? labels.get(f.derivedFrom.taskId) ?? { task_id: f.derivedFrom.taskId, title: null, state: "out_of_scope" as const } : null;
    return { id: f.id, revision: f.revision, subject: f.profileId, subject_name: f.profileId ? data.profiles.find(p => p.id === f.profileId)?.name ?? null : null, text: f.value, topic: f.topic, source: f.source.kind, excerpt: f.source.excerpt, at: f.source.at, expires: f.expiresAt, pinned: f.pinned, by_name: by, kind: f.kind, work };
  }

  /** 一次組好多筆的畫面資料（MEM-5b：工作決定的連結標題一次查好，只查這幾筆用到的任務）。 */
  private factViews(facts: readonly MemoryFact[], data: MemoryData): MemoryFactView[] {
    const ids = new Set(facts.flatMap(f => f.kind === "work_summary" && f.derivedFrom ? [f.derivedFrom.taskId] : []));
    const labels = this.workLabels(ids);
    return facts.map(f => this.factView(f, data, labels));
  }

  /**
   * MEM-5b：工作決定連到的任務在畫面上的標籤。標題只在任務屬於目前範圍（D2：沒用到記憶的任務、全家共用或本次人物的帶記憶任務）
   * 而且讀得到內容時才給；範圍外或讀不到的只說 out_of_scope；已刪除的說 missing。只經可信主視窗的 IPC。
   */
  private workLabels(ids: ReadonlySet<string>): Map<string, NonNullable<MemoryFactView["work"]>> {
    const out = new Map<string, NonNullable<MemoryFactView["work"]>>();
    if (!ids.size) return out;
    const tasks = this.options.tasks;
    const scope = this.scopeNow();
    let listed: Task[] = [];
    try { listed = tasks?.scopedList?.(t => ids.has(t.task_id) && scope(t)) ?? []; } catch { listed = []; }
    for (const id of ids) {
      const task = listed.find(t => t.task_id === id);
      let state: "present" | "withdrawn" | "missing" | null = null;
      try { state = tasks?.taskState?.(id) ?? null; } catch { state = null; }
      if (state === "missing") out.set(id, { task_id: id, title: null, state: "missing" });
      else if (task && task.protected !== true && state !== null) out.set(id, { task_id: id, title: task.title, state: "in_scope" });
      else out.set(id, { task_id: id, title: null, state: "out_of_scope" });
    }
    return out;
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
        case "card_view": return this.cardView(req);
        case "select": return await this.exclusive(() => this.selectOp(req));
        case "list": await this.exclusive(() => this.reconcileWork("ipc")); return this.list(req, ctx);
        case "receipt": return this.receiptOp(req);
        case "edit": return await this.exclusive(() => this.edit(req));
        case "forget": return await this.exclusive(() => req.all === true ? this.forgetAll(req) : this.forgetOp(req));
        case "pin": return await this.exclusive(() => this.pin(req));
        case "profile_delete": return await this.exclusive(() => this.profileDelete(req));
        case "link_face": return await this.exclusive(() => this.linkFace(req));
        case "profile_minor": return await this.exclusive(() => this.profileMinor(req));
        case "suggestions": return await this.exclusive(() => this.suggestionsOp(req));
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
        return { ok: true, op: "turn", ...this.replayView(cached.view), status: this.statusView() };
      }
      // MEM-5b 審查 m7：連到的任務已經不存在的工作決定，在可信主視窗的這一輪先對帳忘記（任務刪除本身不碰記憶）。
      await this.reconcileWork("ipc");
      // 審查 m1：建議只屬於提出它的那一輪（16 §11）；新的一輪開始時，上一輪沒回答的建議作廢（不算拒絕）。
      this.suggestions.dropPending();
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
      // MEM-5b 審查 m5：工作決定卡的任務標題不留在 request_id 快取裡（重送時依目前的任務重新取得）。
      this.recent.set(requestId, { text, view: view.card?.kind === "work_summary" ? { ...view, card: { ...view.card, tasks: view.card.tasks.map(t => ({ ...t, title: "" })) } } : view });
      while (this.recent.size > REQUEST_LRU) this.recent.delete(this.recent.keys().next().value!);
      return { ok: true, op: "turn", ...view, status: this.statusView() };
    });
  }

  /**
   * MEM-5b 審查 m5：同一個 request_id 重送時，工作決定卡的標題重新取得：卡片還有效時只列仍然可選的工作，失效時不列任何工作
   * （按下也會回「已失效」）。
   */
  private replayView(view: MemoryTurnView): MemoryTurnView {
    if (view.card?.kind !== "work_summary") return view;
    const card = this.cards.get(view.card.card);
    const live = card && card.state.kind === "work_summary" && card.epoch === this.presence.epoch && card.expires > this.now() ? card.state.tasks : [];
    const choices = live.length ? this.workChoices().filter(c => live.includes(c.task_id)) : [];
    return { ...view, card: { ...view.card, tasks: choices } };
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
    return { receipts, card, chat: chat ? { text: chat, memory_turn: nonce } : null, presence: this.presenceView(), history_reset: reset, notice, suggestion: null };
  }

  private receipt(status: MemoryReceiptStatus, text: MemoryText, operationId: string | null = null): MemoryReceiptView {
    return { status, ...text, operation_id: operationId };
  }

  private newCard(state: CardState, text: string, part: number, resume: number, requestId: string, fallback: Record<number, string>, origin: Card["origin"] = "typed"): Card {
    const card: Card = { id: `mc_${hex(12)}`, state, text, part, resume, requestId, epoch: this.presence.epoch, expires: this.now() + MEMORY_CARD_MS, fallback: { ...fallback }, origin };
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
          // MEM-5b：「記住這次選了方案 B」→ 先問連到哪一個最近完成的工作（旗標與加密保存都要開著；否則照舊記成一般筆記）。
          if (this.workSummaryOn() && workDecision(seg)) {
            const choices = this.workChoices();
            if (choices.length) {
              const card = this.newCard({ kind: "work_summary", segment: seg, profileId: profile, tasks: choices.map(c => c.task_id) }, text, seg.part, next, requestId, fallback);
              this.log(`memory: 工作決定卡（${choices.length} 個工作）`);
              return stop({ kind: "work_summary", card: card.id, value: seg.value, subject_name: this.nameOf(profile) || null, tasks: choices, options: ["task", "note", "cancel"] });
            }
            // 沒有可以連結的工作：照實說，照舊記成一般筆記（下面的一般流程）。
            receipts.push(this.receipt("not_found", txt("最近 24 小時沒有可以連結的已完成工作，改用一般記住處理")));
            this.log("memory: 工作決定沒有可連結的工作，記成一般筆記");
          }
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
          const scope = this.activeFacts(data, f => shownKind(f) && (f.profileId === null || (profile !== null && f.profileId === profile)));
          const candidates = this.targetsFor(scope, seg);
          // 找不到明確的記憶目標：不是在講記憶（例如「更正：報告第三段」），原句照樣交給聊天。
          if (candidates.length === 0) { fallback[seg.part] = seg.text; break; }
          if (candidates.length > 1) {
            const card = this.newCard({ kind: "pick", action: seg.op, segment: seg, candidates: candidates.map(f => f.id) }, text, seg.part, next, requestId, fallback);
            return stop({ kind: "pick", card: card.id, action: seg.op, value: seg.value, candidates: this.factViews(candidates, data) });
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
          const facts = this.activeFacts(data, f => shownKind(f) && (f.profileId === null || (profile !== null && f.profileId === profile)));
          return stop({ kind: "inspect", subject_name: profile ? this.nameOf(profile) : null, facts: this.factViews(facts, data) });
        }
      }
    }
    const message = chat();
    const view = this.view(receipts, null, message, reset, message ? this.consentNotice() : null, saved, requestId);
    // MEM-5a：只有打字那一輪從頭處理完（沒有卡片、沒有任何記憶指令）才看要不要提一筆建議；卡片之後的續送不提。
    if (via === "typed" && from === 0 && message) view.suggestion = this.maybeSuggest(text, segments, requestId);
    return view;
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

  /**
   * 依原句（打字或卡片上核心保存的原句）取得票證；票證綁本次 session、世代、序號與命令。
   * voice_confirmed：MEM-2 的語音確認（server/memory/live.ts 核對過時窗、回音、世代與一次性）。
   */
  private ticketFor(text: string, via: InputVia, command: ParsedMemoryCommand, scope: "subject" | "household", reparse: (text: string) => readonly ({ op: string; part: number } & Record<string, string | number | boolean | null>)[] = this.reparse(scope)): void {
    const session = this.presence.session;
    const input = via === "typed" ? this.boundary.observeTypedInput(session, text) : via === "confirmation" ? this.boundary.observeConfirmation(session, text) : this.boundary.observeVoiceConfirmation(session, text);
    const ticket = this.boundary.issueParsed(session, input, command, reparse);
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
    const planned = plan(structuredClone({ settings: snap.settings, profiles: snap.profiles, facts: snap.facts, consents: snap.consents, tombstones: snap.tombstones, results: snap.results }));
    const now = this.now();
    const expired = planned.facts.filter(f => f.expiresAt !== null && Date.parse(f.expiresAt) <= now);
    if (expired.length) {
      const ids = new Set(expired.map(f => f.id));
      planned.facts = planned.facts.filter(f => !ids.has(f.id));
      planned.tombstones = [...planned.tombstones.filter(t => !ids.has(t.id)), ...expired.map(f => ({ id: f.id, revision: snap.revision + 1 }))].slice(-10000);
    }
    // MEM-4a：撤銷傳播在同一次提交裡算好（所有改資料的操作都經過這裡）：依賴的記憶被刪、被更正、人物被刪、
    // 同意被撤回或記憶被關閉的成果改成 withdrawn（清掉 deps 與人物）。快照寫入成功後才刪成果檔。
    // MEM-5b：只有依賴的記憶真的被忘記、更正、過期或人物被刪時，連到那些任務的工作決定才一起忘記（固定點，見 settleWithdrawals）。
    // log 只記筆數。
    const { withdrawn, cascaded, rounds } = settleWithdrawals(snap, planned, snap.revision + 1);
    // 超過上限：先丟最舊的已撤回項目；沒有可丟的才丟最舊的有效項目，而且那筆成果一併撤回（審查 M4b），
    // 不留下一份沒有依賴索引、撤銷傳播不到的成果。MEM-5b 審查 M1：這種撤回不忘記工作決定（不換世代、不清歷史）。
    while (planned.results.length > (this.options.resultLimit ?? RESULT_LIMIT)) {
      const oldest = planned.results.findIndex(r => r.state === "withdrawn");
      const [dropped] = planned.results.splice(oldest >= 0 ? oldest : 0, 1);
      if (dropped && dropped.state === "active") withdrawn.add(dropped.taskId);
    }
    if (planned.facts.length > MEMORY_FACT_MAX) return { result: { status: "conflict" }, operationId: operation.operationId };
    if (Buffer.byteLength(JSON.stringify({ ...snap, ...planned })) > SNAPSHOT_BUDGET * 0.98) return { result: { status: "unavailable" }, operationId: operation.operationId };
    // MEM-4c：寫快照到傳給任務端之間（非同步），撤回中的成果對外一律外殼；傳完（或提交失敗）才釋放。
    let release: (() => void) | undefined;
    if (withdrawn.size) { try { release = this.options.holdResults?.([...withdrawn]); } catch { this.log("memory: 撤回中的成果無法先隱藏"); } }
    try {
      const result = await this.store!.commit(operation, data => {
        data.settings = planned.settings; data.profiles = planned.profiles; data.facts = planned.facts; data.consents = planned.consents; data.tombstones = planned.tombstones; data.results = planned.results;
        return status;
      });
      if (result.status === "unavailable") {
        this.storeState = "unavailable";
        this.replacePresence("unselected", { kind: "household" }, null, "unavailable");
        this.dropPlaintext("memory_closed");
      }
      const ok = result.status === "saved" || result.status === "updated" || result.status === "forgotten" || result.status === "unchanged";
      this.log(`memory: commit ${result.status}${expired.length ? `（清除過期 ${expired.length} 筆）` : ""}${withdrawn.size && ok ? `（撤回受保護成果 ${withdrawn.size} 筆）` : ""}${cascaded && ok ? `（連帶忘記工作決定 ${cascaded} 筆，${rounds} 輪）` : ""}`);
      if (withdrawn.size && ok) this.propagate([...withdrawn]);
      // MEM-5b：連帶忘記了工作決定：用過它的對話歷史、卡片與串流一起作廢（呼叫端若也換世代，多換一次無妨）。
      if (cascaded && ok) this.bumpEpoch();
      return { result, operationId: operation.operationId };
    } finally {
      release?.();
    }
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

  /**
   * MEM-5a 家庭協同：全家共用的新事實由哪位本次人物記下（旗標 suggest 開著時；沒有選定人物時 null）。
   * 只是當時選定的人物（自稱「我是 X」即可），不是身分驗證；畫面照實說明。
   */
  private byFor(profileId: string | null): string | null {
    // 審查 M5：本次人物是未成年時不記（不把未成年家人的名字掛到全家共用的記憶上）。
    return profileId === null && this.options.suggest === true && !this.currentIsMinor() ? this.currentProfileId() : null;
  }

  /**
   * origin suggestion（MEM-5a）：記憶建議上按「記住」。票證用 suggestionBodies（suggestFrom 對卡片上保存的原句重新解析），
   * 命令的 op 是 "suggest"；source.kind "suggestion"。
   */
  private async writeRemember(seg: Extract<ParsedSegment, { op: "remember" }>, scope: "subject" | "household", text: string, via: InputVia, requestId: string, replace: string | null = null, origin: "turn" | "suggestion" = "turn"): Promise<MemoryReceiptView> {
    const profileId = scope === "household" ? null : this.currentProfileId();
    if (scope === "subject" && profileId === null) return this.receipt("rejected", txt(UNCLEAR.no_person!));
    if ([...seg.value].length > MEMORY_VALUE_MAX) return this.receipt("full", txt("內容超過 {0} 字，沒有保存", String(MEMORY_VALUE_MAX)));
    const data = this.snapshot();
    if (!replace && !this.hasRoom(data, 1)) return this.fullReceipt();
    const operationFields = { op: origin === "suggestion" ? "suggest" : seg.op, part: seg.part, value: seg.value, topic: seg.topic, key: seg.key, kind: seg.kind, expires: seg.expires, scope };
    const nowIso = new Date(this.now()).toISOString();
    const excerpt = [...text].length <= MEMORY_EXCERPT_MAX ? text : [...seg.value].length <= MEMORY_EXCERPT_MAX ? seg.value : null;
    if (excerpt === null) return this.receipt("full", txt("內容太長，沒有保存（摘錄上限 {0} 字）", String(MEMORY_EXCERPT_MAX)));
    // 票證的 operationId 與 store 的操作 ID 相同：同一次直接輸入只會落盤一次。
    const operation = this.operation(JSON.stringify([operationFields, replace]));
    try {
      this.ticketFor(text, via, { ...operationFields, operationId: operation.operationId } as ParsedMemoryCommand, scope, origin === "suggestion" ? suggestionBodies : undefined);
    } catch {
      return this.receipt("rejected", txt("這次的來源無法驗證，沒有保存；請再說一次"));
    }
    const fact: MemoryFact = {
      id: `mem_${hex(8)}`, profileId, revision: 0, kind: seg.kind, topic: seg.topic, key: seg.key, value: seg.value, audience: "household",
      source: { kind: origin === "suggestion" ? "suggestion" : via === "voice_confirmed" ? "voice_confirmed" : "explicit", turnId: requestId, at: nowIso, excerpt, by: this.byFor(profileId) }, validFrom: nowIso,
      expiresAt: seg.expires === "today" ? endOfLocalDay(this.now()) : null, reviewAfter: null, pinned: false, derivedFrom: null,
    };
    const replaced = replace ? data.facts.find(f => f.id === replace) : undefined;
    // 取代一筆偏好等同更正：帶著記憶的 live 通話先暫停輸出，commit 失敗才恢復（16 §8）。
    if (replaced) this.liveHold(true);
    const { result, operationId: stored } = await this.commit(operation, (d) => {
      fact.revision = this.snapshot().revision + 1;
      if (replaced) d.facts = d.facts.map(f => f.id === replaced.id ? { ...fact, id: replaced.id, pinned: replaced.pinned } : f);
      else d.facts.push(fact);
      return d;
    }, replaced ? "updated" : "saved");
    if (replaced && result.status !== "updated") this.liveHold(false);
    if (result.status === "conflict" && !this.hasRoom(this.snapshot(), replaced ? 0 : 1)) return this.fullReceipt();
    if (result.status !== "saved" && result.status !== "updated") return this.storeFailure(result);
    const who = profileId ? this.nameOf(profileId) : null;
    if (replaced) this.bumpEpoch();
    const message = replaced ? (who ? txt("已更正 {0} 的記憶：{1}", who, seg.value) : txt("已更正全家共用的記憶：{0}", seg.value))
      : who ? txt(seg.expires === "today" ? "記在 {0} 名下了（今天有效）：{1}" : "記在 {0} 名下了：{1}", who, seg.value)
        : txt(seg.expires === "today" ? "記在全家共用了（今天有效）：{0}" : "記在全家共用了：{0}", seg.value);
    return this.receipt(result.status, message, stored);
  }

  private async writeTarget(seg: Extract<ParsedSegment, { op: "correct" | "forget" }>, target: MemoryFact, text: string, via: InputVia, requestId: string): Promise<MemoryReceiptView> {
    const fields = { op: seg.op, part: seg.part, value: seg.value, topic: seg.topic, key: seg.key, text: seg.text, scope: "subject" as const };
    const operation = this.operation(JSON.stringify([fields, target.id, target.revision]));
    try {
      this.ticketFor(text, via, { ...fields, operationId: operation.operationId } as ParsedMemoryCommand, "subject");
    } catch {
      return this.receipt("rejected", txt("這次的來源無法驗證，沒有改動；請再說一次"));
    }
    return seg.op === "forget" ? this.applyForget(target, target.revision, operation) : this.applyCorrect(target, target.revision, seg.value, requestId, text, operation, via);
  }

  private async applyCorrect(target: MemoryFact, revision: number, value: string, requestId: string, excerptSource: string, operation: StoreOperation, via: InputVia = "typed", fromManager = false): Promise<MemoryReceiptView> {
    const data = this.snapshot();
    const current = data.facts.find(f => f.id === target.id);
    if (!current) return this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）"));
    if (current.revision !== revision) return this.receipt("conflict", txt("這筆記憶剛被改過，沒有覆蓋；請重新整理後再改"));
    if ([...value].length > MEMORY_VALUE_MAX) return this.receipt("full", txt("內容超過 {0} 字，沒有保存", String(MEMORY_VALUE_MAX)));
    const nowIso = new Date(this.now()).toISOString();
    const topic = topicOf(value);
    const excerpt = [...excerptSource].length <= MEMORY_EXCERPT_MAX ? excerptSource : [...value].slice(0, MEMORY_EXCERPT_MAX).join("");
    this.liveHold(true);
    const { result, operationId: stored } = await this.commit(operation, (d) => {
      const nextRevision = this.snapshot().revision + 1;
      // 更正清掉舊正文與舊摘錄；首版不保存無限全文版本史（16 §6）。
      d.facts = d.facts.map(f => f.id === current.id ? { ...f, revision: nextRevision, value, topic, key: keyOf(value, topic), source: { kind: via === "voice_confirmed" ? "voice_confirmed" as const : "explicit" as const, turnId: requestId, at: nowIso, excerpt, by: fromManager ? null : this.byFor(current.profileId) }, validFrom: nowIso } : f);
      return d;
    }, "updated");
    if (result.status !== "updated") { this.liveHold(false); return this.storeFailure(result); }
    this.bumpEpoch();
    return this.receipt("updated", current.profileId ? txt("已更正 {0} 的記憶：{1}", this.nameOf(current.profileId), value) : txt("已更正全家共用的記憶：{0}", value), stored);
  }

  private async applyForget(target: MemoryFact, revision: number, operation: StoreOperation): Promise<MemoryReceiptView> {
    const data = this.snapshot();
    const current = data.facts.find(f => f.id === target.id);
    if (!current) return this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）"));
    if (current.revision !== revision) return this.receipt("conflict", txt("這筆記憶剛被改過，沒有刪除；請重新整理後再試"));
    this.liveHold(true);
    const { result, operationId: stored } = await this.commit(operation, (d) => {
      d.facts = d.facts.filter(f => f.id !== current.id);
      // 墓碑只剩 ID 與版本，沒有正文。
      d.tombstones = [...d.tombstones.filter(t => t.id !== current.id), { id: current.id, revision: this.snapshot().revision + 1 }].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") { this.liveHold(false); return this.storeFailure(result); }
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
      d.settings = { enabled: req.enabled as boolean, setupAt: d.settings.setupAt ?? new Date(this.now()).toISOString(), suggestions: d.settings.suggestions };
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
    // MEM-4c：關閉記憶時，任務端一併丟棄已結束受保護任務的解密內容與索引。
    if (!req.enabled) this.dropPlaintext("memory_off");
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
    // MEM-5a：記憶建議的卡（只在記憶體的 SuggestionBook，不在 this.cards）。
    if (typeof id === "string" && this.suggestions.has(id)) return this.answerSuggestion(id, req.choice);
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
    const live = card.origin === "live";
    const finish = async (from: number): Promise<MemoryResponse> => {
      // live 來源：模型已經聽到了，不經 /api/chat 續送剩下的段落；回條只在畫面上，語音只念固定句。
      if (live) return { ok: true, op: "card_answer", ...this.view(receipts, null, null, reset, null, false), status: this.statusView() };
      const rest = await this.process(card.text, card.requestId, segments, from, "confirmation", card.fallback);
      return { ok: true, op: "card_answer", ...rest, receipts: [...receipts, ...rest.receipts], history_reset: rest.history_reset || reset, status: this.statusView() };
    };
    if (state.kind === "setup") {
      // 首次設定卡按取消：被暫緩的問題照樣送出，不寫入記憶。
      return { ok: true, op: "card_answer", ...this.view([this.receipt("cancelled", txt("沒有保存"))], null, chatText(segments), false, null, false), status: this.statusView() };
    }
    if (choice === "cancel" || choice === "decline") {
      receipts.push(this.receipt("cancelled", txt("沒有保存")));
      if (live) {
        this.live?.cardAnswered(card.id, state.kind, false);
        if (state.kind === "voice_confirm") this.liveReceipt("cancelled");
      }
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
        if (live) this.live?.cardAnswered(card.id, state.kind, true);
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
          if (live) this.liveReceipt(r.status);
        }
        return finish(card.resume);
      }
      case "voice_confirm": {
        // 畫面上的語音卡（替代方式）：點擊是可信主視窗的直接輸入（confirmation）。
        if (choice !== "confirm" && choice !== "household") throw new ServiceError("bad_request", "choice 格式不對");
        if (choice === "household" && state.action !== "remember") throw new ServiceError("bad_request", "這張卡片沒有這個選項");
        this.live?.cardAnswered(card.id, state.kind, true);
        const r = await this.applyVoiceCard(card, state, "confirmation", choice);
        receipts.push(r);
        reset ||= r.status === "updated" || r.status === "forgotten";
        this.liveReceipt(r.status);
        return finish(card.resume);
      }
      case "work_summary": {
        // MEM-5b：點選算直接確認（confirmation）；核心用卡片上保存的原句重新解析，工作只能從卡上列出的那幾個選。
        if (choice !== "task" && choice !== "note") throw new ServiceError("bad_request", "choice 格式不對");
        if (this.currentIsMinor()) { receipts.push(this.receipt("minor", txt(MINOR))); return finish(card.resume); }
        if (this.currentProfileId() !== state.profileId) throw new ServiceError("expired", "這張卡片已失效（可能換了人物或超過時間）；請再說一次");
        if (choice === "note") {
          const profile = state.profileId;
          // 審查 m2：和一般記住同一個判斷（同一個鍵、同一句、不是工作決定的就是已經記得了）。
          const same = this.activeFacts(this.snapshot(), f => f.profileId === profile && f.kind !== "work_summary" && f.key === state.segment.key && f.value === state.segment.value);
          if (same.length) receipts.push(this.receipt("unchanged", txt("已經記得了（{0}）：{1}", this.nameOf(profile), state.segment.value)));
          else receipts.push(await this.writeRemember(state.segment, "subject", card.text, "confirmation", card.requestId));
          this.log("memory: 工作決定卡：只記成一般筆記");
          return finish(card.resume);
        }
        const taskId = req.task;
        if (typeof taskId !== "string" || !state.tasks.includes(taskId)) throw new ServiceError("bad_request", "請從卡片上的工作選擇");
        receipts.push(await this.writeWorkSummary(state.segment, taskId, card.text, "confirmation", card.requestId));
        return finish(card.resume);
      }
      case "inspect":
        throw new ServiceError("bad_request", "這張卡片只能查看");
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

  // ─────────────── MEM-5a 記憶建議 ───────────────

  /**
   * 打字那一輪處理完之後：最多提一筆建議（只在記憶體；回傳卡片 ID）。不提的情況：旗標或設定沒開、記憶關著、這一輪有任何記憶指令、
   * 有還開著的記憶卡、沒有選定人物（含暫停）、本次人物是未成年、找不到合格的句子、已經有相同或衝突的記憶（同一個鍵或相同內容，
   * 本人或全家共用）、24 小時內按過「不用」、超過頻率（每個世代每小時 3 筆、每 24 小時 10 筆）或記憶已滿。log 只記筆數與主題。
   */
  private maybeSuggest(text: string, segments: readonly ParsedSegment[], requestId: string): { card: string } | null {
    if (this.options.suggest !== true) return null;
    if (!segments.every(seg => seg.op === "chat" || seg.op === "temporary")) return null;
    let data: MemorySnapshot;
    try { data = this.snapshot(); } catch { return null; }
    if (!data.settings.enabled || data.settings.suggestions !== true) return null;
    const profile = this.currentProfileId();
    if (!profile || this.currentIsMinor()) return null;
    const now = this.now();
    if ([...this.cards.values()].some(c => c.expires > now && c.epoch === this.presence.epoch)) return null;
    // 審查 M1、m3：整個打字的一輪一起判斷（跨句的玩笑、轉述、時效詞都算），和離線指標用同一個函式。
    const candidate = suggestFrom(text);
    if (!candidate) return null;
    const found = { text, candidate };
    const c = found.candidate;
    if ([...c.value].length > MEMORY_VALUE_MAX || !this.hasRoom(data, 1)) return null;
    if (this.activeFacts(data, f => f.profileId === profile || f.profileId === null).some(f => f.key === c.key || f.value === c.value)) {
      this.log("memory: 記憶建議略過（已有相同或相關的記憶）");
      return null;
    }
    if (this.suggestions.rejectedKey(profile, c.key, now)) { this.log("memory: 記憶建議略過（24 小時內按過不用）"); return null; }
    const block = this.suggestions.rateBlock(now, this.presence.epoch);
    if (block) { this.log(`memory: 記憶建議略過（頻率上限：${block === "hour" ? "每小時" : "每天"}）`); return null; }
    const card = `mc_${hex(12)}`;
    this.suggestions.add({ card, text: found.text, candidate: c, profileId: profile, epoch: this.presence.epoch, requestId, createdAt: now });
    this.log(`memory: 記憶建議 1 筆（主題 ${c.topic}）`);
    return { card };
  }

  /** 還有效的建議：沒過期（24 小時）、同一個世代、本次人物還是同一位。 */
  private liveSuggestion(card: unknown, take: boolean): PendingSuggestion | null {
    if (typeof card !== "string" || !CARD_ID.test(card)) return null;
    const now = this.now();
    const pending = take ? this.suggestions.take(card, now) : this.suggestions.get(card, now);
    if (!pending) return null;
    if (pending.epoch !== this.presence.epoch || this.currentProfileId() !== pending.profileId || now - pending.createdAt >= SUGGEST_TTL_MS) {
      this.suggestions.take(card, now);
      return null;
    }
    return pending;
  }

  /** 記憶建議上的「記住」（confirm）或「不用」（decline）。點擊是可信主視窗的直接輸入；一次性。 */
  private async answerSuggestion(card: string, choice: unknown): Promise<MemoryResponse> {
    if (choice !== "confirm" && choice !== "decline" && choice !== "cancel") throw new ServiceError("bad_request", "choice 格式不對");
    const pending = this.liveSuggestion(card, true);
    if (!pending) throw new ServiceError("expired", "這張卡片已失效（可能換了人物或超過時間）；請再說一次");
    const done = (receipt: MemoryReceiptView, reset = false): MemoryResponse => ({ ok: true, op: "card_answer", ...this.view([receipt], null, null, reset, null, false), status: this.statusView() });
    if (choice !== "confirm") {
      this.suggestions.reject(pending.profileId, pending.candidate.key, this.now());
      this.log("memory: 記憶建議：不用");
      return done(this.receipt("cancelled", txt("好，不記這一句")));
    }
    // 按下時再核對一次：旗標、設定與記憶都還開著、不是未成年、還沒有相同或相關的記憶。
    const data = this.snapshot();
    if (this.options.suggest !== true || !data.settings.enabled || data.settings.suggestions !== true) return done(this.receipt("disabled", txt("記憶建議已關閉，這次沒有保存")));
    if (this.currentIsMinor()) return done(this.receipt("minor", txt(MINOR)));
    const c = pending.candidate;
    const same = this.activeFacts(data, f => (f.profileId === pending.profileId || f.profileId === null) && (f.key === c.key || f.value === c.value));
    if (same.length) return done(this.receipt("unchanged", txt("已經有相關的記憶，這次沒有保存：{0}", same[0]!.value)));
    const seg: Extract<ParsedSegment, { op: "remember" }> = { op: "remember", part: 0, value: c.value, topic: c.topic, key: c.key, kind: c.kind, expires: "none" };
    const receipt = await this.writeRemember(seg, "subject", pending.text, "confirmation", pending.requestId, null, "suggestion");
    this.log(`memory: 記憶建議：記住 → ${receipt.status}`);
    return done(receipt);
  }

  /** 記憶管理（管理權杖）開關記憶建議。開啟還要 NOUS_MEMORY_ROUTES 列出 suggest；關閉時記憶體裡的候選一起丟掉。 */
  private async suggestionsOp(req: Record<string, unknown>): Promise<MemoryResponse> {
    if (!this.manageToken(req)) throw new ServiceError("no_manage", NEED_MANAGE);
    if (typeof req.enabled !== "boolean") throw new ServiceError("bad_request", "enabled 必須是 true 或 false");
    const enabled = req.enabled;
    if (enabled && this.options.suggest !== true) throw new ServiceError("unavailable", "記憶建議目前沒有開放（需要 NOUS_MEMORY_ROUTES 列出 suggest）");
    const { result, operationId } = await this.commit(JSON.stringify(["suggestions", enabled]), (d) => { d.settings = { ...d.settings, suggestions: enabled }; return d; }, "updated");
    if (result.status !== "updated") return this.mutationResponse("suggestions", this.storeFailure(result), false);
    if (!enabled) this.suggestions.clear();
    this.log(`memory: 記憶建議${enabled ? "開啟" : "關閉"}`);
    return this.mutationResponse("suggestions", this.receipt("updated", txt(enabled ? "已開啟記憶建議：打字聊天說到自己穩定的偏好時，會在回覆下方問一次；只有按「記住」才保存" : "已關閉記憶建議"), operationId), false);
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
    const facts = this.factViews(this.activeFacts(data, f => shownKind(f) && f.profileId === subject), data);
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

  private mutationResponse(op: "edit" | "forget" | "pin" | "profile_delete" | "link_face" | "profile_minor" | "suggestions", receipt: MemoryReceiptView, reset: boolean): MemoryResponse {
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
      const fact: MemoryFact = { id: `mem_${hex(8)}`, profileId: subject as string | null, revision: 0, kind: "preference", topic, key: keyOf(value, topic), value, audience: "household", source: { kind: "explicit", turnId: requestId, at: nowIso, excerpt: [...value].slice(0, MEMORY_EXCERPT_MAX).join(""), by: null }, validFrom: nowIso, expiresAt: null, reviewAfter: null, pinned: false, derivedFrom: null };
      const { result, operationId } = await this.commit(op, (d) => { fact.revision = this.snapshot().revision + 1; d.facts.push(fact); return d; }, "saved");
      if (result.status !== "saved") return this.mutationResponse("edit", this.storeFailure(result), false);
      return this.mutationResponse("edit", this.receipt("saved", subject ? txt("記在 {0} 名下了：{1}", this.nameOf(subject as string), value) : txt("記在全家共用了：{0}", value), operationId), false);
    }
    const { fact, revision } = this.findFact(req, managed);
    const parsed = parseMemoryText(`記住：${value}`);
    if (parsed.length === 1 && parsed[0]!.op === "rejected" && parsed[0]!.reason === "sensitive") return this.mutationResponse("edit", this.receipt("rejected", txt(REJECTED.sensitive)), false);
    const op = this.operation(JSON.stringify(["edit", fact.id, revision, value]));
    this.literalTicket({ op: "correct", operationId: op.operationId, id: fact.id, expectedRevision: revision, value });
    // 審查 M5：記憶管理的修改不記「由誰記下」（管理畫面不代表本次人物在說話）。
    const receipt = await this.applyCorrect(fact, revision, value, requestId, value, op, "typed", true);
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
    this.liveHold(true);
    const { result, operationId } = await this.commit(JSON.stringify(["forget_all", scope, ids.size]), (d) => {
      const revision = this.snapshot().revision + 1;
      d.facts = d.facts.filter(f => !ids.has(f.id));
      d.tombstones = [...d.tombstones.filter(t => !ids.has(t.id)), ...[...ids].map(id => ({ id, revision }))].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") { this.liveHold(false); return this.mutationResponse("forget", this.storeFailure(result), false); }
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
    this.liveHold(true);
    const { result, operationId } = await this.commit(JSON.stringify(["profile_delete", profileId]), (d) => {
      const revision = this.snapshot().revision + 1;
      d.profiles = d.profiles.filter(p => p.id !== profileId);
      // MEM-5a：全家共用的事實上「由 X 記下」的 X 被刪除時，記下的人一併清掉（刪除人物也刪除這個關聯）。
      d.facts = d.facts.filter(f => f.profileId !== profileId).map(f => f.source.by === profileId ? { ...f, source: { ...f.source, by: null } } : f);
      d.consents = d.consents.filter(c => c.profileId !== profileId);
      d.tombstones = [...d.tombstones, ...facts.map(f => ({ id: f.id, revision }))].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") { this.liveHold(false); return this.storeFailure(result); }
    // 刪除人物檔：帶著記憶的 live 通話直接結束，不重建（MEM-2 撤銷的處理表）。
    if (this.presence.subject.kind === "person" && this.presence.subject.profileId === profileId) this.select(null, "profile_deleted");
    else this.bumpEpoch("profile_deleted");
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

  // ─────────────── MEM-2：ChatGPT 方案即時語音（只給核心，不是 IPC、HTTP 或模型工具） ───────────────

  /** 每通 live 通話建立一個 binding（server/live-route.ts 經 server/nous.ts 呼叫）；同時只有一通。 */
  openLive(options: { lookToTalk: boolean; rebuild: boolean; now: () => number; locale?: Locale; approvalOpen?: () => boolean }): LiveMemoryBinding {
    return this.openVoice("live", options);
  }

  /**
   * MEM-3：每通即時語音通話（live 或 api_key）建立一個 binding。同時只允許一通語音通話帶記憶：上一通的 binding 還沒結束時，
   * 新的這通完全不處理記憶（reason busy）。
   */
  openVoice(route: VoiceRoute, options: Omit<LiveBindingOptions, "route" | "log" | "busy">): LiveMemoryBinding {
    const previous = this.live;
    // 連線時（不是建立時）才判斷：上一通的結束是非同步的（closed promise），建立當下可能還沒處理完。
    // 上一通還開著而且有記憶規則（memoryActive：可能隨時取用或中途補上記憶），或還帶著 lease：這通不處理記憶。
    const busy = () => previous !== null && !previous.finished && (previous.memoryActive || previous.carriesMemory());
    const binding = new LiveMemoryBinding(this, { ...options, route, busy, log: this.log });
    this.live = binding;
    if (previous) this.previousVoice.set(binding, previous);
    return binding;
  }

  /** 這條路徑的同意對象（live 沿用 targets().live）。 */
  private targetFor(route: VoiceRoute): ChatTarget | null {
    const targets = this.options.targets();
    return targets.byRoute?.[route] ?? (route === "live" ? targets.live ?? null : null);
  }

  clearLive(binding: LiveMemoryBinding): void {
    if (this.live !== binding) return;
    // 因為 busy 而沒有用記憶的那通結束：交還給還在帶著記憶的上一通。
    const previous = this.previousVoice.get(binding);
    this.live = previous && !previous.finished ? previous : null;
  }

  private liveHold(active: boolean): void {
    try { this.live?.hold(active); } catch { /* live 通話自己處理 */ }
  }

  private liveReceipt(status: MemoryReceiptStatus): void {
    try { this.live?.receipt(liveStatus(status)); } catch { /* live 通話自己處理 */ }
  }

  revokeReasonOf(session: MemorySession): RevokeWhy {
    return this.revokedBy.get(session) ?? "updated";
  }

  holdVoice(route: VoiceRoute, session: MemorySession, cleanup: () => Promise<void>, connect: (lease: ContextLease) => Promise<{ closed: Promise<void> }>): Promise<void> {
    return this.boundary.withVoiceContext(session, route, cleanup, connect);
  }

  attachVoice(route: VoiceRoute, session: MemorySession, cleanup: () => Promise<void>, closed: Promise<void>): ContextLease | null {
    return this.boundary.attachVoiceContext(session, route, cleanup, closed);
  }

  /**
   * 即時語音的檢索：同一套 retrieve（人物、可見範圍、期限、同意、相關性；8 筆、4 KB），同意鍵依路徑（live：codex；api_key：openai_realtime）。
   * query 空字串＝連線時的記憶包（只有釘選的，最多 4 筆）。只在記憶上次是開著（enabledHint）時才開 store，不為了查狀態碰 Keychain。
   * 這條路徑還沒放行（boundary 的放行表）時回 route_off，不開 store。
   */
  async voiceContext(route: VoiceRoute, query: string): Promise<LiveContextResult> {
    const result = (reason: LiveMemoryReason | null, facts: ContextFact[] = []): LiveContextResult =>
      ({ session: this.presence.session, epoch: this.presence.epoch, facts, reason, selected: this.presence.state === "selected" });
    if (this.closed) return result("unavailable");
    const block = this.boundary.routeBlock(route);
    if (block === "not_released") return result("route_off");
    if (block !== null) return result("route_disabled");
    const open = this.storeState === "ready" || (this.hint() && await this.ensureOpen());
    if (!open || !this.store) return result(this.storeState === "unloaded" && this.options.available() ? "not_setup" : "unavailable");
    let data: MemorySnapshot;
    try { data = this.snapshot(); } catch { return result("unavailable"); }
    if (data.settings.setupAt === null) return result("not_setup");
    if (!data.settings.enabled) return result("disabled");
    const target = this.targetFor(route);
    if (!target?.account) return result("no_account");
    this.touch();
    const profileId = this.currentProfileId();
    const consented = data.consents.some(c => c.allowed && c.provider === target.provider && c.account === target.account && (c.profileId === null || c.profileId === profileId));
    if (!consented) return result("no_consent");
    const found = retrieve({ facts: this.usableFacts(data.facts), consents: data.consents, profileId, target, query, now: this.now() });
    this.log(`memory: ${route} 檢索 ${found.facts.length} 筆（捨去 ${found.dropped}，未同意 ${found.blockedByConsent}）`);
    return result(null, found.facts);
  }

  /** 目前範圍（本次人物或全家共用）有沒有這條路徑的同意（不開 store；store 沒開時當作沒有）。 */
  voiceConsented(route: VoiceRoute): boolean {
    // 放行表與執行期間的停用（stop_unconfirmed、cleanup_failed）都要通過。
    if (this.closed || this.storeState !== "ready" || !this.store || !this.boundary.routeEnabled(route)) return false;
    const target = this.targetFor(route);
    if (!target?.account) return false;
    let data: MemorySnapshot;
    try { data = this.snapshot(); } catch { return false; }
    if (!data.settings.enabled) return false;
    const profileId = this.currentProfileId();
    return data.consents.some(c => c.allowed && c.provider === target.provider && c.account === target.account && (c.profileId === null || c.profileId === profileId));
  }

  /** 看著說話開始的通話：臉部候選（沿用 faceCandidate 的「每個決策只問一次」），出一張 live 來源的候選卡。 */
  liveFaceCandidate(): { card: string; name: string } | null {
    if (this.closed || this.storeState !== "ready" || !this.store || this.presence.state === "selected") return null;
    try { if (!this.snapshot().settings.enabled) return null; } catch { return null; }
    const hit = this.options.identity?.()?.candidate() ?? null;
    const profile = this.faceCandidate();
    if (!profile || !hit) return null;
    const card = this.newCard({ kind: "face_candidate", profile: profile.id, person: hit.person_id, at: hit.at }, "", 0, 0, `req_live${hex(8)}`, {}, "live");
    return { card: card.id, name: profile.name };
  }

  /**
   * 語音回答臉部候選（server/memory/live.ts 已核對時窗、錨定比對與回音）。「是」只能選人：候選必須仍是同一個辨識決策
   * （同一追蹤世代、沒有多臉、60 秒內）。選人不是寫入，不需要來源票證（17 §9.2 只要求一次短確認）。
   */
  answerLiveCandidate(cardId: string, accept: boolean): Promise<boolean> {
    return this.exclusive(async () => {
      const card = this.cards.get(cardId);
      if (!card || card.origin !== "live" || card.state.kind !== "face_candidate" || card.epoch !== this.presence.epoch || card.expires <= this.now()) {
        if (card) this.cards.delete(cardId);
        return false;
      }
      this.cards.delete(cardId);
      if (!accept) {
        this.log("memory: 臉部候選（語音）：不是");
        return true;
      }
      const state = card.state;
      const hit = this.options.identity?.()?.candidate() ?? null;
      if (!hit || hit.person_id !== state.person || hit.at !== state.at || !this.profileOf(state.profile)) return false;
      this.touch();
      this.select(state.profile);
      this.log("memory: 臉部候選（語音）：是，已選定");
      return true;
    });
  }

  /**
   * sideband 的使用者 final 逐字稿（已轉繁體，已排除回音）。只跑同一個 parser：「我是 X」直接選人（和打字一致）；
   * 記住、更正、忘記一律只出 voice_confirm 卡（MEM-2 不直接寫入）；「你記得我什麼？」出查看卡。拒絕規則照舊
   * （第三人、引文、假設、玩笑、敏感資料）；未成年仍不准從語音寫入。記憶沒開過時不為語音開 store。
   */
  async voiceTurn(text: string, route: VoiceRoute = "live"): Promise<VoiceTurnOutcome> {
    const none: VoiceTurnOutcome = { kind: "none" };
    if (this.closed || typeof text !== "string" || !text.trim() || text.length > 2000) return none;
    const segments = parseMemoryText(text);
    const writes = segments.some(s => s.op === "remember" || s.op === "correct" || s.op === "forget" || s.op === "forget_all" || s.op === "unclear");
    if (!segments.some(s => s.op !== "chat" && s.op !== "temporary" && s.op !== "unclear") && !writes) return none;
    const notice = (message: string, speak: string | null = null): VoiceTurnOutcome => ({ kind: "notice", message, speak });
    const open = this.storeState === "ready" || (this.hint() && await this.ensureOpen());
    if (!open) return writes ? notice("記憶沒有開啟或目前不可用；這次沒有保存") : none;
    return this.exclusive(async () => {
      if (this.storeState !== "ready" || !this.store) return writes ? notice("記憶沒有開啟或目前不可用；這次沒有保存") : none;
      const settings = this.snapshot().settings;
      if (!settings.enabled) return writes ? notice("記憶功能已關閉，這次沒有保存；可以在選單列「記憶…」開啟") : none;
      this.touch();
      const requestId = `req_live${hex(8)}`;
      let selected = false;
      const now = this.now();
      while (this.voiceCardTimes.length && now - this.voiceCardTimes[0]! > 60_000) this.voiceCardTimes.shift();
      const allowCard = this.voiceCardTimes.length < VOICE_CARDS_PER_MINUTE;
      /** 建立一張語音卡或挑選卡：記下頻率，取代上一張（回傳被取代的卡 ID，binding 通知頁面關掉）。 */
      const liveCard = (state: CardState, seg: { part: number }): { card: Card; replaced: string | null } => {
        const replaced = this.liveVoiceCard && this.cards.has(this.liveVoiceCard) ? this.liveVoiceCard : null;
        if (replaced) this.cards.delete(replaced);
        const card = this.newCard(state, text, seg.part, seg.part + 1, requestId, {}, "live");
        // MEM-3：回條記錄路徑（只在核心的卡片與 log；store 格式不變），MEM-5 的 derived_from 可以用。
        card.route = route;
        this.voiceCardTimes.push(now);
        this.liveVoiceCard = card.id;
        return { card, replaced };
      };
      // 稱名：有這條路徑的同意、稱名設定開著才把人物名交給 binding（沒有同意時不念任何記憶的中繼資料）。
      const nameOf = (profileId: string | null) => profileId && this.voiceConsented(route) && (this.options.identity?.()?.nameAllowed?.() ?? true) ? this.nameOf(profileId) : null;
      for (const seg of segments) {
        const data = this.snapshot();
        switch (seg.op) {
          case "self_id": {
            const same = data.profiles.filter(p => p.name.toLowerCase() === seg.name.toLowerCase());
            if (same.length === 1) {
              if (this.currentProfileId() !== same[0]!.id) { this.select(same[0]!.id); selected = true; }
            } else if (same.length > 1) return notice("有多位同名人物：請在畫面上的「本次人物」選單選擇");
            break;
          }
          case "remember": {
            if (this.currentIsMinor()) return notice(MINOR);
            const profile = this.currentProfileId();
            const scope = profile ? "subject" as const : "household" as const;
            const same = this.activeFacts(data, f => f.profileId === profile && f.key === seg.key);
            if (same.some(f => f.value === seg.value)) return notice("已經記得了", "已經記得了。");
            if (!allowCard) return notice("語音確認卡太多了；請稍後再說，或在畫面上操作");
            const conflicting = profile ? same.find(f => f.kind === "preference" && seg.kind === "preference" && seg.expires === "none" && f.expiresAt === null) : undefined;
            const { card, replaced } = liveCard({ kind: "voice_confirm", action: "remember", segment: seg, scope, target: null, replace: conflicting?.id ?? null }, seg);
            this.log("memory: 語音確認卡（remember）");
            return { kind: "confirm", card: card.id, action: "remember", value: seg.value, name: nameOf(profile), scope, replaces: !!conflicting, replaced };
          }
          case "correct":
          case "forget": {
            if (this.currentIsMinor()) return notice(MINOR);
            const profile = this.currentProfileId();
            const candidates = this.targetsFor(this.activeFacts(data, f => shownKind(f) && (f.profileId === null || (profile !== null && f.profileId === profile))), seg);
            // 找不到明確的記憶目標：不是在講記憶，照一般對話。
            if (candidates.length === 0) break;
            if (!allowCard) return notice("語音確認卡太多了；請稍後再說，或在畫面上操作");
            if (candidates.length > 1) {
              const { card, replaced } = liveCard({ kind: "pick", action: seg.op, segment: seg, candidates: candidates.map(f => f.id) }, seg);
              return { kind: "pick", card: card.id, replaced };
            }
            const target = candidates[0]!;
            const { card, replaced } = liveCard({ kind: "voice_confirm", action: seg.op, segment: seg, scope: "subject", target: { id: target.id, revision: target.revision }, replace: null }, seg);
            this.log(`memory: 語音確認卡（${seg.op}）`);
            return { kind: "confirm", card: card.id, action: seg.op, value: seg.value, name: nameOf(target.profileId), scope: "subject", replaces: false, replaced };
          }
          case "rejected":
            return notice(REJECTED[seg.reason]);
          case "forget_all":
            return notice("全部忘記請從選單列「記憶…」的記憶管理操作；這次沒有刪除");
          case "inspect": {
            const profile = this.currentProfileId();
            const count = this.activeFacts(data, f => shownKind(f) && (f.profileId === null || (profile !== null && f.profileId === profile))).length;
            const card = this.newCard({ kind: "inspect" }, text, seg.part, seg.part + 1, requestId, {}, "live");
            return { kind: "inspect", card: card.id, count };
          }
          default:
            break;
        }
      }
      return selected ? { kind: "selected" } : none;
    });
  }

  /**
   * 語音確認詞（George 2026-10-30）：live.ts 已核對確認詞、時窗、回音；這裡再核對卡片存在、是 live 的語音卡、世代沒變、
   * 沒有過期，並刪掉卡片（同一張卡只能確認一次），再走 issueParsed（voice_confirmed）與 commit。
   */
  voiceConfirm(cardId: string): Promise<{ status: MemoryReceiptStatus }> {
    return this.exclusive(async () => {
      const card = this.cards.get(cardId);
      if (!card || card.origin !== "live" || card.state.kind !== "voice_confirm" || card.epoch !== this.presence.epoch || card.expires <= this.now() || this.storeState !== "ready" || !this.store) {
        if (card) this.cards.delete(cardId);
        return { status: "receipt_expired" as const };
      }
      this.cards.delete(cardId);
      const receipt = await this.applyVoiceCard(card, card.state, "voice_confirmed", "confirm");
      this.log(`memory: 語音確認（${card.state.action}，${card.route ?? "live"}）→ ${receipt.status}`);
      this.liveReceipt(receipt.status);
      try { this.options.onPresence?.(); } catch { /* 只是請頁面重讀狀態 */ }
      return { status: receipt.status };
    });
  }

  /** 說「取消」或換了一張新卡：作廢這張語音卡。 */
  voiceCancel(cardId: string): void {
    const card = this.cards.get(cardId);
    if (card?.origin === "live" && (card.state.kind === "voice_confirm" || card.state.kind === "pick")) this.cards.delete(cardId);
  }

  private async applyVoiceCard(card: Card, state: Extract<CardState, { kind: "voice_confirm" }>, via: InputVia, choice: "confirm" | "household"): Promise<MemoryReceiptView> {
    if (this.currentIsMinor()) return this.receipt("minor", txt(MINOR));
    if (state.segment.op === "remember") {
      const scope = choice === "household" ? "household" : state.scope;
      return this.writeRemember(state.segment, scope, card.text, via, card.requestId, scope === "household" ? null : state.replace);
    }
    const target = this.snapshot().facts.find(f => f.id === state.target?.id);
    if (!target) return this.receipt("not_found", txt("找不到這筆記憶（可能已被忘記）"));
    if (target.revision !== state.target!.revision) return this.receipt("conflict", txt("這筆記憶剛被改過，沒有覆蓋；請重新整理後再改"));
    return this.writeTarget(state.segment, target, card.text, via, card.requestId);
  }

  /** IPC card_view：SSE 只送卡片 ID；可信主視窗用它取內容（只有這個世代、還沒過期的卡）。 */
  private cardView(req: Record<string, unknown>): MemoryResponse {
    const id = req.card;
    // MEM-5a：記憶建議的內容只經這裡（可信主視窗的 IPC）給畫面；turn 只回卡片 ID。
    const suggestion = this.liveSuggestion(id, false);
    if (suggestion) return { ok: true, op: "card_view", card: { kind: "suggestion", card: suggestion.card, text: suggestion.candidate.clause, value: suggestion.candidate.value, subject_name: this.nameOf(suggestion.profileId) || null }, origin: "typed" };
    const card = typeof id === "string" && CARD_ID.test(id) ? this.cards.get(id) : undefined;
    if (!card || card.expires <= this.now() || card.epoch !== this.presence.epoch) throw new ServiceError("expired", "這張卡片已失效（可能換了人物或超過時間）；請再說一次");
    const data = this.snapshot();
    const state = card.state;
    const profile = this.currentProfileId();
    let view: MemoryCardView;
    switch (state.kind) {
      case "voice_confirm": {
        const target = state.target ? data.facts.find(f => f.id === state.target!.id) : undefined;
        const subjectName = state.scope === "household" ? null : state.target ? (target?.profileId ? this.nameOf(target.profileId) : null) : profile ? this.nameOf(profile) : null;
        view = { kind: "voice_confirm", card: card.id, action: state.action, heard: card.text, value: state.segment.value, subject_name: subjectName, target: target?.value ?? null, options: state.action === "remember" ? (state.scope === "subject" ? ["confirm", "household", "cancel"] : ["confirm", "cancel"]) : ["confirm", "cancel"], replaces: state.replace !== null };
        break;
      }
      case "face_candidate":
        view = { kind: "face_candidate", card: card.id, name: this.nameOf(state.profile) };
        break;
      case "pick":
        view = { kind: "pick", card: card.id, action: state.action, value: state.segment.value, candidates: this.factViews(state.candidates.map(fid => data.facts.find(f => f.id === fid)).filter((f): f is MemoryFact => !!f), data) };
        break;
      case "inspect": {
        const facts = this.activeFacts(data, f => shownKind(f) && (f.profileId === null || (profile !== null && f.profileId === profile)));
        view = { kind: "inspect", subject_name: profile ? this.nameOf(profile) : null, facts: this.factViews(facts, data) };
        break;
      }
      default:
        throw new ServiceError("bad_request", "這張卡片不能這樣查看");
    }
    return { ok: true, op: "card_view", card: view, origin: card.origin };
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
    const result = retrieve({ facts: this.usableFacts(data.facts), consents: data.consents, profileId, target: request.target, query: request.lastUser, now: this.now() });
    this.log(`memory: 檢索 ${result.facts.length} 筆（捨去 ${result.dropped}，未同意 ${result.blockedByConsent}）`);
    const notice = result.facts.length === 0 && result.blockedByConsent > 0 ? txt("這次沒有用到記憶：目前的服務或帳號尚未允許取用") : null;
    // MEM-4a：受保護交辦（放行 task 路徑時）。標題是這一輪核心核對過的使用者原句（binding.text），不是模型的改寫。
    const delegate = this.options.tasks && this.boundary.routeEnabled("task")
      ? (locale?: Locale) => this.delegateProtected({ session: binding.session, epoch: binding.epoch, text: binding.text, requestId: request.requestId, via: "typed", ...(locale ? { locale } : {}) })
      : null;
    if (result.facts.length === 0) return run({ ...plainContext(notice, tainted), saved: binding.saved, delegate });
    this.historyTainted = true;
    try {
      return await this.boundary.withContext(binding.session, async () => {}, (lease) => run({ facts: result.facts, signal: lease.signal, deliver: lease.deliver, saved: binding.saved, notice, blockDelegation: true, delegate }), "text");
    } catch (error) {
      if ((error as Error)?.message === "inactive_session") return run(plainContext(txt("這次沒有用到記憶（本次人物已改變或請求已過期）"), true));
      throw error;
    }
  }

  // ─────────────── MEM-5b 工作決定（work_summary） ───────────────

  /** 旗標（NOUS_MEMORY_ROUTES 的 work_summary）開著，而且任務確實加密保存（任務端在、加密模式、金鑰沒有問題）。 */
  private workSummaryOn(): boolean {
    const tasks = this.options.tasks;
    if (this.options.workSummary !== true || !tasks?.scopedList) return false;
    try { return tasks.sealed(); } catch { return false; }
  }

  /**
   * 可信主視窗任務清單的範圍（D2，和 taskScope(false) 同一條規則；記憶檔已開時同步算）：沒有用到記憶的任務、
   * 全家共用或本次人物的帶記憶任務。記憶檔讀不到時帶記憶的任務一律不在範圍內。
   */
  private scopeNow(): (task: Pick<Task, "task_id" | "memory">) => boolean {
    let index: Map<string, MemoryResult> | null = null;
    try { index = new Map(this.snapshot().results.map(r => [r.taskId, r])); } catch { index = null; }
    const profileId = this.currentProfileId();
    return (task) => {
      if (task.memory !== true) return true;
      const r = index?.get(task.task_id);
      return !!r && (r.subject === null || r.subject === profileId);
    };
  }

  /**
   * 工作決定卡上的工作：最近 24 小時內成功完成、沒有撤回（也不在撤回中）、讀得到內容、在目前範圍內的受保護任務，
   * 依完成時間新到舊最多 5 個。標題只給畫面（IPC），不進記憶、不送模型。
   */
  private workChoices(): { task_id: string; title: string; finished_at: string }[] {
    const tasks = this.options.tasks;
    if (!tasks?.scopedList) return [];
    const scope = this.scopeNow();
    const now = this.now();
    const recent = (t: Pick<Task, "finished_at">) => { const at = typeof t.finished_at === "string" ? Date.parse(t.finished_at) : NaN; return Number.isFinite(at) && at <= now + 60_000 && now - at <= WORK_CHOICE_WINDOW_MS; };
    // 審查 m3：先用外殼上就有的欄位（範圍、狀態、撤回、完成時間）篩選，不合格的任務不解密。
    const eligible = (t: Task) => scope(t) && t.status === "succeeded" && t.withdrawn !== true && !t.cancel_reason && recent(t);
    let listed: Task[];
    try { listed = tasks.scopedList(eligible); } catch { return []; }
    return listed
      .filter(t => t.protected !== true && eligible(t) && !!t.title)
      .sort((a, b) => b.finished_at!.localeCompare(a.finished_at!))
      .slice(0, WORK_CHOICES_MAX)
      .map(t => ({ task_id: t.task_id, title: t.title, finished_at: t.finished_at! }));
  }

  /**
   * 票證比對用的重新解析（工作決定）：卡片上保存的原句再跑一次 parser，第 part 段必須仍是工作決定，命令才對得上；
   * 任務 ID 來自核心卡片上列出、使用者點選的那一個（頁面不能指定別的）。
   */
  private workSummaryBodies(taskId: string, part: number): (text: string) => ({ op: string; part: number } & Record<string, string | number | boolean | null>)[] {
    return (text) => parseMemoryText(text).map(seg => (seg.op === "remember" && seg.part === part && workDecision(seg)
      ? { op: "work_summary", part: seg.part, value: seg.value, topic: seg.topic, key: seg.key, kind: "work_summary", expires: "none", task: taskId, scope: "subject" }
      : { ...seg, scope: "subject" }) as { op: string; part: number } & Record<string, string | number | boolean | null>);
  }

  /**
   * 寫入一筆工作決定：kind work_summary，值＝使用者原話（不含任務標題或成果，也不經模型摘要），derivedFrom＝選的任務；
   * 不設期限（待 George 確認）。按下時再核對：旗標與加密保存、記憶開著、這個任務仍可選（沒刪、沒撤回、在範圍內、24 小時內）。
   */
  private async writeWorkSummary(seg: Extract<ParsedSegment, { op: "remember" }>, taskId: string, text: string, via: InputVia, requestId: string): Promise<MemoryReceiptView> {
    const profileId = this.currentProfileId();
    if (profileId === null) return this.receipt("rejected", txt(UNCLEAR.no_person!));
    if (!this.workSummaryOn() || !this.snapshot().settings.enabled) return this.receipt("disabled", txt("工作決定目前沒有開放（或任務沒有加密保存），這次沒有保存"));
    if (!this.workChoices().some(c => c.task_id === taskId)) return this.receipt("not_found", txt("這個工作已不存在、已撤回或不在目前範圍內，這次沒有保存"));
    if ([...seg.value].length > MEMORY_VALUE_MAX) return this.receipt("full", txt("內容超過 {0} 字，沒有保存", String(MEMORY_VALUE_MAX)));
    const data = this.snapshot();
    const same = this.activeFacts(data, f => f.profileId === profileId && f.kind === "work_summary" && f.derivedFrom?.taskId === taskId && f.value === seg.value);
    if (same.length) return this.receipt("unchanged", txt("已經記得這個工作決定了（{0}）：{1}", this.nameOf(profileId), seg.value));
    if (!this.hasRoom(data, 1)) return this.fullReceipt();
    const excerpt = [...text].length <= MEMORY_EXCERPT_MAX ? text : [...seg.value].length <= MEMORY_EXCERPT_MAX ? seg.value : null;
    if (excerpt === null) return this.receipt("full", txt("內容太長，沒有保存（摘錄上限 {0} 字）", String(MEMORY_EXCERPT_MAX)));
    const fields = { op: "work_summary", part: seg.part, value: seg.value, topic: seg.topic, key: seg.key, kind: "work_summary", expires: "none", task: taskId, scope: "subject" as const };
    const operation = this.operation(JSON.stringify([fields]));
    try {
      this.ticketFor(text, via, { ...fields, operationId: operation.operationId } as ParsedMemoryCommand, "subject", this.workSummaryBodies(taskId, seg.part));
    } catch {
      return this.receipt("rejected", txt("這次的來源無法驗證，沒有保存；請再說一次"));
    }
    const nowIso = new Date(this.now()).toISOString();
    const fact: MemoryFact = {
      id: `mem_${hex(8)}`, profileId, revision: 0, kind: "work_summary", topic: seg.topic, key: seg.key, value: seg.value, audience: "household",
      source: { kind: "explicit", turnId: requestId, at: nowIso, excerpt, by: null }, validFrom: nowIso, expiresAt: null, reviewAfter: null, pinned: false,
      derivedFrom: { taskId },
    };
    const { result, operationId } = await this.commit(operation, (d) => { fact.revision = this.snapshot().revision + 1; d.facts.push(fact); return d; }, "saved");
    if (result.status === "conflict" && !this.hasRoom(this.snapshot(), 1)) return this.fullReceipt();
    if (result.status !== "saved") return this.storeFailure(result);
    this.log("memory: 工作決定 1 筆（連到 1 個工作）");
    return this.receipt("saved", txt("記在 {0} 名下的工作決定了：{1}", this.nameOf(profileId), seg.value), operationId);
  }

  /** 忘記這幾筆工作決定（一次提交、只留墓碑）；成功後換世代（用過它們的歷史作廢）。回傳忘記的筆數。 */
  private async forgetWork(ids: ReadonlySet<string>): Promise<number> {
    this.liveHold(true);
    const { result } = await this.commit(JSON.stringify(["work_gone", [...ids].sort()]), (d) => {
      const revision = this.snapshot().revision + 1;
      d.facts = d.facts.filter(f => !ids.has(f.id));
      d.tombstones = [...d.tombstones.filter(t => !ids.has(t.id)), ...[...ids].map(id => ({ id, revision }))].slice(-10000);
      return d;
    }, "forgotten");
    if (result.status !== "forgotten") {
      this.liveHold(false);
      this.log(`memory: 工作決定連帶忘記失敗（${result.status}）`);
      return 0;
    }
    this.recent.clear();
    this.bumpEpoch();
    this.log(`memory: 工作決定連帶忘記 ${ids.size} 筆（任務已不存在）`);
    return ids.size;
  }

  /**
   * 對帳（MEM-5b 審查 M1、m7）：連到的任務已經不存在（taskState missing）的工作決定一起忘記。任務被刪除的路徑（成果紀錄的
   * HTTP 刪除）不帶記憶票證、也不一定來自可信主視窗，所以刪除本身不碰記憶；記憶檔開啟時，以及可信主視窗的下一次 turn 與 list
   * （互斥區內）才對帳。成果被撤回（任務還在）不算：記憶關閉或撤回同意可以回頭，使用者的原話保留。任務端不在、沒有加密保存
   * 或金鑰有問題（tasks.sealed() 為 false）時不知道任務在不在，一律不清；讀不到內容的任務仍在清單上，算存在（和 MEM-4a B1 一致）。
   */
  private async reconcileWork(trigger: "open" | "ipc"): Promise<number> {
    const tasks = this.options.tasks;
    if (!tasks?.taskState || this.closed || this.storeState !== "ready" || !this.store) return 0;
    let data: MemorySnapshot;
    try { data = this.snapshot(); } catch { return 0; }
    const work = data.facts.filter(f => f.kind === "work_summary" && f.derivedFrom !== null);
    if (!work.length) return 0;
    let sealed = false;
    try { sealed = tasks.sealed(); } catch { sealed = false; }
    if (!sealed) {
      if (trigger === "open") this.log(`memory: 工作決定對帳略過（任務沒有加密保存或金鑰不可用；${work.length} 筆不動）`);
      return 0;
    }
    const ids = new Set(work.filter(f => {
      try { return tasks.taskState!(f.derivedFrom!.taskId) === "missing"; } catch { return false; }
    }).map(f => f.id));
    if (!ids.size) return 0;
    return this.forgetWork(ids);
  }

  /**
   * 送模型前（聊天、即時語音、受保護交辦）先排除連到的任務已不存在的工作決定：任務刪除不碰記憶，要等對帳才真正忘記；
   * 在那之前不讓它被取用。成果已撤回、任務還在的照常（審查 M1）。任務端不知道時照常。
   */
  private usableFacts(facts: readonly MemoryFact[]): MemoryFact[] {
    const state = this.options.tasks?.taskState;
    if (!state) return [...facts];
    return facts.filter(f => {
      if (f.kind !== "work_summary" || !f.derivedFrom) return true;
      try { return state(f.derivedFrom.taskId) !== "missing"; } catch { return true; }
    });
  }

  // ─────────────── MEM-4a 受保護交辦與撤銷傳播 ───────────────

  /** MEM-4c：請任務端丟棄解密內容（失敗只記 log）。MEM-5a：記憶建議的候選與被拒絕的 key 也一起丟掉。 */
  private dropPlaintext(reason: "memory_off" | "memory_closed"): void {
    this.suggestions.clear();
    // MEM-5b 審查 m5：request_id 快取裡的卡片（含原句）一起丟掉。
    this.recent.clear();
    try { this.options.onPlaintextDrop?.(reason); } catch { this.log("memory: 任務端丟棄解密內容失敗"); }
  }

  /** 撤回的成果交給任務端（停止執行中的、移除已完成的成果內容）。失敗只記 log（下次開啟記憶檔時再做一次）。 */
  private propagate(taskIds: string[]): void {
    try { this.options.onResultsWithdrawn?.(taskIds); } catch { this.log("memory: 撤回受保護成果時任務端失敗"); }
  }

  /**
   * 受保護交辦（互斥區內，與所有改資料的操作同一把鎖）：放行、記憶開著、session 與世代沒變、來源票證核對通過後，
   * 依原句檢索（本次人物＋全家共用、任務引擎的同意、8 筆、4 KB），先把依賴索引寫進快照再建立任務。
   * 模擬引擎不帶記憶；沒有相關記憶時照樣建立任務（標題仍是原句，沒有依賴）。不能交辦時回 null。
   */
  private delegateProtected(args: { session: MemorySession; epoch: number; text: string; requestId: string; via: "typed" | "confirmation" | "voice_heard"; locale?: Locale; retryOf?: string; profileId?: string | null }): Promise<ProtectedDelegation | null> {
    return this.exclusive(async () => {
      const tasks = this.options.tasks;
      if (!tasks || this.closed || !this.boundary.routeEnabled("task")) return null;
      if (!tasks.sealed()) { this.log("memory: 任務沒有加密保存，不做受保護交辦"); return null; }
      if (this.storeState !== "ready" || !this.store) return null;
      let data: MemorySnapshot;
      try { data = this.snapshot(); } catch { return null; }
      if (!data.settings.enabled) return null;
      if (args.session !== this.presence.session || args.epoch !== this.presence.epoch || !this.boundary.active(args.session)) return null;
      try {
        const input = args.via === "typed" ? this.boundary.observeTypedInput(args.session, args.text)
          : args.via === "voice_heard" ? this.boundary.observeVoiceUtterance(args.session, args.text)
            : this.boundary.observeConfirmation(args.session, args.text);
        const ticket = this.boundary.issueDelegation(args.session, input, args.text);
        this.boundary.consumeDelegation(args.session, ticket, args.text);
      } catch {
        this.log("memory: 受保護交辦的來源無法驗證");
        return null;
      }
      const mode = tasks.mode();
      const target = mode === "mock" ? null : tasks.target();
      // MEM-4b：語音交辦在臉部候選還沒有結果時只用全家共用（profileId null）。
      const profileId = args.profileId !== undefined ? args.profileId : this.currentProfileId();
      const found = target ? retrieve({ facts: this.usableFacts(data.facts), consents: data.consents, profileId, target, query: args.text, now: this.now() }) : { facts: [], deps: [], dropped: 0, blockedByConsent: 0 };
      const taskId = `task_${randomUUID()}`;
      if (found.facts.length > 0 && target?.account) {
        const entry: MemoryResult = { id: `res_${hex(8)}`, taskId, subject: profileId, deps: found.deps, target: { provider: target.provider, account: target.account }, createdAt: new Date(this.now()).toISOString(), state: "active" };
        const { result } = await this.commit(JSON.stringify(["task", taskId, found.deps]), (d) => { d.results.push(entry); return d; }, "saved");
        if (result.status !== "saved") {
          this.log(`memory: 受保護交辦的依賴索引沒有寫入（${result.status}）`);
          return null;
        }
      }
      const task = tasks.submit({ task_id: taskId, title: args.text, request_id: args.requestId, facts: found.facts, target: target?.account ? { provider: target.provider, account: target.account } : null, ...(args.locale ? { locale: args.locale } : {}), ...(args.retryOf ? { retry_of: args.retryOf } : {}) });
      this.log(`memory: 受保護交辦（帶 ${found.facts.length} 筆，未同意 ${found.blockedByConsent}）`);
      return { task, used: found.facts.length };
    });
  }

  /**
   * 重做（可信主視窗的點擊；title 是核心保存的使用者原句，不是頁面送來的）：重新檢索目前的記憶，不沿用舊的依賴。
   * 不能受保護交辦（沒放行、記憶關著或不可用）時回 null，呼叫端照一般重做（不帶記憶）。
   */
  async redoProtected(input: { title: string; requestId: string; retryOf: string; locale?: Locale }): Promise<ProtectedDelegation | null> {
    if (!this.options.tasks || !this.boundary.routeEnabled("task") || this.closed) return null;
    if (!(this.storeState === "ready" || (this.hint() && await this.ensureOpen()))) return null;
    const p = this.presence;
    return this.delegateProtected({ session: p.session, epoch: p.epoch, text: input.title, requestId: input.requestId, via: "confirmation", retryOf: input.retryOf, ...(input.locale ? { locale: input.locale } : {}) });
  }

  // ─────────────── MEM-4b 語音交辦自動帶記憶 ───────────────

  /** task 與這條語音路徑都放行、有任務端、核心還開著。 */
  voiceDelegationOn(route: VoiceRoute): boolean {
    return !!this.options.tasks && !this.closed && this.boundary.routeEnabled("task") && this.boundary.routeEnabled(route);
  }

  voiceStamp(): { session: MemorySession; epoch: number } {
    return { session: this.presence.session, epoch: this.presence.epoch };
  }

  /**
   * 語音的受保護交辦：server/memory/live.ts 已核對原句（回音、確認詞、記憶指令、時窗、開口時間、世代、一次性、和模型描述相符），
   * 這裡再走 MEM-4a 的 delegateProtected（session 與世代、voice_heard 的來源票證、任務引擎的同意、8 筆／4 KB、依賴索引先寫）。
   * 標題與檢索查詢都是原句。回傳的 shell 是給頁面的外殼。
   */
  async delegateVoice(input: { route: VoiceRoute; text: string; session: MemorySession; epoch: number; householdOnly: boolean; locale?: Locale }): Promise<{ task: Task; shell: Task; used: number } | null> {
    if (!this.voiceDelegationOn(input.route) || typeof input.text !== "string" || !input.text.trim()) return null;
    if (!(this.storeState === "ready" || (this.hint() && await this.ensureOpen()))) return null;
    const out = await this.delegateProtected({ session: input.session, epoch: input.epoch, text: input.text, requestId: `req_voice${hex(8)}`, via: "voice_heard", ...(input.householdOnly ? { profileId: null } : {}), ...(input.locale ? { locale: input.locale } : {}) });
    if (!out) return null;
    const shell = this.options.tasks?.publicGet?.(out.task.task_id) ?? shellOf(out.task);
    return { task: out.task, shell, used: out.used };
  }

  /** 受保護的原句卡：核心持有原句，回傳不透明的 ID（SSE 只送它）。 */
  voiceDelegateCard(title: string, route: VoiceRoute, locale?: Locale): string {
    const now = this.now();
    for (const [id, card] of this.delegateCards) if (card.expires <= now) this.delegateCards.delete(id);
    while (this.delegateCards.size >= 16) this.delegateCards.delete(this.delegateCards.keys().next().value!);
    const id = `dc_${hex(12)}`;
    this.delegateCards.set(id, { title, route, expires: now + DELEGATE_CARD_MS, session: this.presence.session, epoch: this.presence.epoch, ...(locale ? { locale } : {}) });
    return id;
  }

  /** 這張原句卡仍然有效：沒過期，而且建立時的本次人物 session 與世代沒變。 */
  private liveDelegateCard(card: string) {
    const c = typeof card === "string" && DELEGATE_CARD_ID.test(card) ? this.delegateCards.get(card) : undefined;
    if (!c) return null;
    if (c.expires <= this.now() || c.session !== this.presence.session || c.epoch !== this.presence.epoch) {
      this.delegateCards.delete(card);
      return null;
    }
    return c;
  }

  /** 可信主視窗（tasks IPC card_title）取原句卡的標題；過期、換了人物或不存在時 null。 */
  delegateCardTitle(card: string): string | null {
    return this.liveDelegateCard(card)?.title ?? null;
  }

  /**
   * 原句卡上按「交辦」（tasks IPC card_delegate；可信主視窗的點擊算直接確認，via confirmation）：卡片一次性。放行、記憶開著、
   * 加密保存時走受保護交辦（目前的本次人物、任務引擎的同意）；不能時 out 為 null，呼叫端照舊建立不帶記憶的任務。
   */
  async delegateCard(card: string, requestId: string): Promise<{ title: string; locale?: Locale; out: ProtectedDelegation | null } | null> {
    const c = this.liveDelegateCard(card);
    if (!c) return null;
    this.delegateCards.delete(card);
    const base = { title: c.title, ...(c.locale ? { locale: c.locale } : {}) };
    if (!this.voiceDelegationOn(c.route)) return { ...base, out: null };
    if (!(this.storeState === "ready" || (this.hint() && await this.ensureOpen()))) return { ...base, out: null };
    // 卡片建立時的本次人物世代（審查 M3）：開記憶檔之間換了人物，delegateProtected 會因世代不符回 null。
    const out = await this.delegateProtected({ session: c.session, epoch: c.epoch, text: c.title, requestId, via: "confirmation", ...(c.locale ? { locale: c.locale } : {}) });
    return { ...base, out };
  }

  /**
   * 模型提示能不能看到任務的真實標題（MEM-4a 保守規則）：記憶開著，而且這個服務帳號對本次人物或全家共用有記憶同意。
   * 不開記憶檔（沒開過就是不行）。其他目標（即時語音、未同意的帳號）只看到外殼。
   */
  taskTitlesAllowed(target: ChatTarget | null): boolean {
    if (!target?.account || this.closed || this.storeState !== "ready" || !this.store) return false;
    try {
      const data = this.snapshot();
      if (!data.settings.enabled) return false;
      const profileId = this.currentProfileId();
      return data.consents.some(c => c.allowed && c.provider === target.provider && c.account === target.account && (c.profileId === null || c.profileId === profileId));
    } catch { return false; }
  }

  /** 這條即時語音路徑的同意對象（live：codex；api_key：openai_realtime，放行時）。 */
  routeTarget(route: VoiceRoute): ChatTarget | null {
    return this.targetFor(route);
  }

  /**
   * MEM-4a（George 2026-10-30，審查 minor 1）：給某個模型目標的任務清單裡，哪些任務可以放真實標題。
   * 目標要有記憶同意（taskTitlesAllowed）；帶記憶的任務另外要：依賴索引記下的同意對象就是這個目標，而且人物是全家共用或本次人物。
   * 不符合的一律外殼。記憶檔沒開或沒有同意時回 null（全部外殼）。
   */
  taskTitleFilter(target: ChatTarget | null): ((task: Pick<Task, "task_id" | "memory">) => boolean) | null {
    if (!target?.account || !this.taskTitlesAllowed(target)) return null;
    const index = new Map(this.snapshot().results.map(r => [r.taskId, r]));
    const profileId = this.currentProfileId();
    return (task) => {
      if (task.memory !== true) return true;
      const r = index.get(task.task_id);
      return !!r && r.target.provider === target.provider && r.target.account === target.account && (r.subject === null || r.subject === profileId);
    };
  }

  /**
   * MEM-4a（George 2026-10-30 的 D2，審查 minor 7）：可信主視窗的任務清單、詳細與搜尋看得到哪些任務的真實內容。
   * 沒有用到記憶的任務、全家共用或本次人物的帶記憶任務：可以。其他人物的帶記憶任務：只有從選單列「成果紀錄…」打開
   * （點擊 10 秒內，full）才可以；否則顯示外殼。記憶檔開不了時，帶記憶的任務一律外殼。
   */
  async taskScope(full: boolean): Promise<(task: Pick<Task, "task_id" | "memory">) => boolean> {
    // MEM-4c 審查 M2：選單列打開的「全部」也要先開記憶檔。開檔時會把已撤回、但當機前還沒傳到任務端的成果再傳一次
    // （刪成果檔），之後的搜尋與詳細才不會看到撤回的內容。記憶上次開著卻開不了時，帶記憶的任務一律外殼。
    const ready = this.storeState === "ready" || (this.hint() && await this.ensureOpen());
    if (full) {
      const memoryUnknown = !ready && this.hint();
      return (task) => task.memory !== true || !memoryUnknown;
    }
    // MEM-5b：同一條規則也給工作決定卡與記憶清單的連結標題用（scopeNow）。
    return ready ? this.scopeNow() : (task) => task.memory !== true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.manager = null;
    this.turns.clear();
    this.cards.clear();
    this.delegateCards.clear();
    this.suggestions.clear();
    this.revokedBy.set(this.presence.session, "closed");
    void this.boundary.revoke(this.presence.session);
    await this.queue.catch(() => undefined);
    await this.store?.close().catch(() => undefined);
    this.store = null;
    this.dropPlaintext("memory_closed");
  }
}
