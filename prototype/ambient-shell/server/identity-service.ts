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
  sameSpeakerModel,
  speakableName,
  isValidSpeakerFeature,
  SPEAKER_FEATURE_DIM,
  VOICE_KEYWORD_SAMPLES,
  CALIBRATION_MATCH_FLOOR,
  CALIBRATION_MIN,
  CALIBRATION_SAFETY,
  CALIBRATION_VERIFY_STRANGERS,
  CALL_VOICE_MIN_MS,
  VOICE_MIN_VOICED_MS,
  VOICE_SEGMENTS,
  VOICE_THRESHOLDS,
  VOICE_UTTERANCE_SAMPLES,
  type SpeakerModelVersion,
  type CalibrationReport,
  type CalibrationSegmentReport,
  type VoiceFusion,
  type VoiceObservation,
  type VoiceSegment,
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
import { liveGreetingText, strictGreetingInstructions } from "../shared/sense.ts";
import { appendBriefing } from "../shared/proactive.ts";
import { fitBriefing, fitsLiveAppend, type BriefingPort, type BriefingSubject, type PendingBriefing } from "./proactive.ts";
import { WAKE_ID } from "../shared/wake.ts";
import { isTerminalId, MAIN_SOURCE, TERMINAL_EVIDENCE_TIMING } from "../shared/terminal.ts";
import { GreetingPicker } from "./greeting-picker.ts";
import type { FaceRuntimeCheck } from "./face-runtime.ts";
import type { SpeakerRuntimeCheck } from "./speaker-runtime.ts";
import type { CalibrationFileData, GalleryStore, GalleryVersions, StoredCalibrationTrial, StoredPerson } from "./identity-store.ts";

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
// - WK-02（George 2026-10-31：喚醒後一律打招呼）：喚醒開始的互動（claimGreeting 回 source wake_word）不需要「看著說話」
//   「看著說話時先打招呼」；稱名仍跟「打招呼時稱呼認出的家人」與其他條件（雲端稱名說明、證據）。喚醒開始、還沒決策的互動
//   期間（wakeGreetingOpen），ambient_status／ambient_probe 同樣不需要那兩個設定。
// - ambient_status／ambient_probe 被拒時不說原因（原因可能透露有沒有登記家人）。
// - 身分只用於稱呼：GreetingDecision 不給任何授權流程使用。
// - RPI-ID（George 2026-11-05）：頁面各自累積證據。Mac 主視窗（IPC）的來源是 "main"，Pi 等終端機頁面（HTTP，
//   server/terminal-routes.ts）的來源是終端機識別碼；看著說話的追蹤世代、比對成功的人、喚醒與通話中的聲音、取樣限速都依來源分開，
//   兩個頁面的 track 計數器互不干擾，一邊的證據不能讓另一邊稱名。記憶候選（memoryCandidate）也只看發問那個頁面的證據：
//   Pi 看到的臉不會替 Mac 的打字聊天選人。所有終端機另有一份合計的取樣限速（等於分頁前的全核心上限），換識別碼繞不過；
//   主視窗的證據不會因為終端機太多被擠掉。問候決策的互動 ID 與限速仍是全核心一份（一次互動只問候一次）；
//   Mac 開著家人辨識管理畫面時，所有來源的同步辨識一樣停止。終端機只送頁面算好的特徵向量，從不送影像或錄音。
//
// SP-02a（喚醒時認聲音，docs/17 §4、§7.2、§7.3）：
// - voice_probe：頁面在喚醒後送來這次喚醒（wake_id）的聲音特徵：喚醒詞那一段（keyword，只和喚醒詞模板比）與問候前說的話
//   （utterance，只和朗讀模板比）。不需要管理 session、不需要鏡頭；回應只有 ok，結果只留在核心給這次喚醒的問候決策。
// - 問候決策時把聲音與臉融合（§7.3）：臉認出 P、聲音也是 P 才「確認」；聲音認成別人（或兩段指向不同人）不稱名；P 有登記聲音、
//   這次聲音卻不支持他也不稱名；沒有可用的聲音照 ID-02。只憑聲音稱名要等 SP-03 校準（VOICE_CALIBRATED 全是 false），
//   所以沒有臉的時候不會因為聲音帶出名字；唯一的例外是 George 2026-11-01 要的測試開關 voiceNameTest（預設關閉，選單列打開）。
// - voice_test：管理畫面的「試認聲音」，使用者自己按的，回傳這一段認成誰（不含分數）。
// - log 只記片段狀態與融合結果，不記 person_id、名字或分數。
//
// SP-02b（通話中辨認說話者，17 §7.2、§9.2；George 2026-11-01 的決定）：
// - call_voice：開關開著時頁面送來通話中每段話（≥2 秒人聲）的特徵，只和朗讀模板比。回應只有 ok。
// - 本次人物沒有選定、聲音認出一位家人（臉沒有反對）：記成聲音候選（60 秒），請這通語音問一次「這次用 X 的偏好嗎？」，
//   一定等使用者確認才選定。
// - 本次人物已選定、聲音像另一位家人：只記 log，不撤銷、不打斷（George 選「只記 log」；SP-03 校準後再決定）。

export const SESSION_IDLE_MS = 10 * 60_000;
/** session 從開啟起算的上限（不論有沒有在用）。 */
export const SESSION_MAX_MS = 15 * 60_000;
/** 每個 session 每秒最多幾次請求（4 Hz 取樣加一點餘裕）。 */
export const SESSION_RATE_PER_S = 6;

export type ConfirmRequest =
  | { kind: "enroll"; name: string; minor: boolean }
  /** SP-01：保存聲音特徵。existing＝加到已登記的家人（取代原本的聲音）；false＝新增一位只有聲音的家人。 */
  | { kind: "enroll_voice"; name: string; minor: boolean; existing: boolean }
  /** SP-01：只刪聲音（這位家人還有臉；只有聲音的家人走 delete）。 */
  | { kind: "delete_voice"; name: string }
  /**
   * memory：連結到這位家人的記憶筆數與預設是否一起刪（17 §9.4、George 決定 ⑨：成人預設不勾，未成年預設勾）。
   * count 為 null：記憶檔這次還沒開過，不為了計數去開（不碰 Keychain），畫面寫「刪除時一併處理」。
   */
  | { kind: "delete"; name: string; memory?: { count: number | null; defaultDelete: boolean } }
  /** memory：每位家人的連結記憶筆數；未成年的記憶一併刪除，成人只有勾選「同時刪除成人家人的記憶」才刪。 */
  | { kind: "clear_all"; memory?: { people: { name: string; count: number | null; minor: boolean }[] } }
  /** SP-03a：套用建議的聲音門檻（每種片段的 match 與在收集資料上的拒認率；null＝這種片段資料不足，維持起點值）。 */
  | { kind: "calib_apply"; keyword: { match: number; reject_rate: number } | null; utterance: { match: number; reject_rate: number } | null }
  /** SP-03a：清除聲音校準資料（回到未校準的起點門檻，只憑聲音不再稱名）。 */
  | { kind: "calib_clear" };

/**
 * 主程序的原生確認對話框（dialog.showMessageBox）；回 true 才寫檔。
 * 刪除家人且有連結記憶時可回 { confirmed, deleteMemory }（勾選「同時刪除此人的記憶」）。
 */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean | { confirmed: boolean; deleteMemory: boolean }>;

/** 記憶層的連接點（server/memory/service.ts）；只在核心內部呼叫。 */
export interface IdentityMemoryLink {
  countForFace(personId: string): Promise<{ count: number | null; minor: boolean } | null>;
  unlinkFace(personId: string, deleteMemory: boolean): Promise<MemoryUnlinkResult>;
  /** 看著說話取樣時看到多張臉：暫停記憶的本次人物（只能降權）。source：看到的頁面；別的頁面選定的本次人物不受影響。 */
  suspend(reason: "multi_face", source?: string): void;
  /** SP-02b：本次人物連結的家人辨識 person_id（沒有選定或沒有連結時 null）。 */
  currentPersonId?(): string | null;
  /** SP-02b：通話中的聲音認出一位家人、本次人物沒有選定：請這通語音問一次（named＝可以念出名字）。 */
  offerVoiceCandidate?(named: boolean, source?: string): void;
  /** 記憶預設選人（2026-11-02）：還沒選定前，通話中的聲音認出的是和候選不同的家人：不選定，改用全家共用。 */
  voiceDisagrees?(source?: string): void;
}

/** SP-03a：排序後的分數是否被接受（最高分 ≥ match 且領先第二名 ≥ margin）；接受時回那位家人。 */
function acceptedBy(scores: readonly { person_id: string; score: number }[], limits: { match: number; margin: number }): string | null {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const [first, second] = ranked;
  if (!first || first.score < limits.match) return null;
  if (second && first.score - second.score < limits.margin) return null;
  return first.person_id;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

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
  /** 這個頁面來源是否可使用鏡頭辨識。 */
  camera: (source: string) => boolean;
  /** 看著說話與稱名的設定；未提供時（舊的組裝、測試）視為全部關閉，不做同步辨識也不稱名。 */
  ambient?: () => AmbientPrefs;
  /**
   * 核心發出的互動 ID 換成真的工作階段（RealtimeSessions.claimGreeting）：沒提供或回 null 時不稱名。
   * 成功一次之後同一個 ID 就不能再用。
   */
  claimGreeting?: (interaction: string) => { route: GreetingRoute; session_id: string; source?: "look_to_talk" | "wake_word"; locale?: Locale; wake_id?: string } | null;
  /**
   * SP-02a 測試開關（George 2026-11-01，wake.json 的 voice_name_test）：喚醒開始的通話認不出臉（沒看鏡頭、鏡頭關、證據不足）時，
   * 聲音認出一人就叫名字。看到陌生臉、多張臉、臉聲不一致時仍不叫。未提供時視為關閉。
   */
  voiceNameTest?: () => boolean;
  /** SP-02b「通話中辨認說話者」（wake.json 的 speaker_in_call）：關著時 call_voice 一律拒絕。未提供時視為關閉。 */
  speakerInCall?: () => boolean;
  /**
   * WK-02：這個頁面有喚醒開始、還沒決策的互動（RealtimeSessions.wakeGreetingOpen）；那段時間同步辨識不需要「看著說話」設定。
   * RPI-ID：只看同一個頁面開始的互動（Mac 的喚醒不放寬 Pi 的取樣，反之亦然）。
   */
  wakeGreetingOpen?: (source: string) => boolean;
  /**
   * MEM-3：API key 路徑的問候決策做出後通知（RealtimeSessions.greeted）：這次問候有沒有稱名。帶記憶的通話等問候那一輪
   * 結束後才問臉部候選（只有稱名過，問句才帶名字）。只有互動 ID 換得到真的工作階段時才呼叫。
   */
  apiKeyGreeted?: (sessionId: string, named: boolean, spoken?: () => void) => void;
  /** PRO-2：這通 API key 工作階段有核心旁路（核心聽得到使用者的回答）；沒有時不問行程。 */
  apiKeyListens?: (sessionId: string) => boolean;
  /** 開場句挑選（固定清單、依時段、避開上一次）；未提供時建一個（Math.random、這台電腦的時區）。 */
  picker?: GreetingPicker;
  /**
   * PRO-1：招呼後接的主動提醒（今天的天氣；server/proactive.ts）。personId 只在這次問候稱名時給（沒稱名就當沒認出）。
   * 真的送出才 commit：API key 路徑在決策交回頁面時，live 路徑在 takeLiveGreeting 真的取用時。未提供時只打招呼。
   */
  briefing?: BriefingPort;
  /** 模型與 runtime 的雜湊核對結果（啟動時算一次）。 */
  runtime: FaceRuntimeCheck;
  model: FaceModelVersion;
  /** SP-01 講者模型的雜湊核對結果與版本；未提供時（舊的組裝、測試）不能登記聲音。 */
  speakerRuntime?: SpeakerRuntimeCheck;
  speakerModel?: SpeakerModelVersion;
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
  /** 送來這個請求的頁面：Mac 主視窗（IPC）是 "main"（未提供時同），終端機（HTTP）是它的識別碼。只用來分開各頁面的證據。 */
  source?: string;
}

export { MAIN_SOURCE };
/** 最多同時記幾個頁面的證據（主視窗＋幾台終端機）；超過時丟掉最久沒用的終端機（主視窗不丟）。 */
const PAGE_SOURCES_MAX = 8;

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

function speakerModelOf(v: unknown): SpeakerModelVersion {
  const m = record(v);
  const s = (k: string) => {
    const x = m[k];
    if (typeof x !== "string" || x.length === 0 || x.length > 64) throw new RequestError("bad_request", "模型版本格式不對");
    return x;
  };
  if (!Number.isInteger(m.dim)) throw new RequestError("bad_request", "模型版本格式不對");
  return { speaker: s("speaker"), preproc: s("preproc"), dim: m.dim as number };
}

function toSpeakerFeature(v: unknown): Float32Array {
  if (!isValidSpeakerFeature(v)) throw new RequestError("bad_request", `聲音特徵必須是 ${SPEAKER_FEATURE_DIM} 個有限數值且已正規化`);
  return Float32Array.from(v);
}

/** 正規化的平均方向（特徵都已 normalize）。 */
function meanDirection(features: readonly Float32Array[]): Float32Array {
  const dim = features[0]?.length ?? 0;
  const mean = new Float32Array(dim);
  for (const f of features) for (let i = 0; i < dim; i++) mean[i]! += f[i]!;
  const norm = Math.hypot(...mean);
  for (let i = 0; i < dim; i++) mean[i] = mean[i]! / (norm || 1);
  return mean;
}

/** 每段都接近平均方向、任兩段也不能差太多；低於任一項表示混到別人或沒錄到人聲。 */
function consistent(features: readonly Float32Array[], limits: { consistency: number; consistency_pair: number }): boolean {
  const mean = meanDirection(features);
  const pairLow = features.some((f, i) => features.some((g, j) => j > i && dot(f, g) < limits.consistency_pair));
  return !pairLow && features.every((f) => dot(f, mean) >= limits.consistency);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** 每位家人：各樣本 cosine 的最大值（特徵都已 normalize，內積即 cosine）。 */
function scores(people: readonly StoredPerson[], feature: Float32Array): { person: StoredPerson; score: number }[] {
  return people
    .map((person) => ({ person, score: person.features.length > 0 ? Math.max(...person.features.map((f) => dot(f, feature))) : -1 }))
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

/** 一個頁面（Mac 主視窗或一台終端機）的證據與限速；頁面之間互不影響。 */
interface PageEvidence {
  /** 看著說話的同步辨識（ID-02）。 */
  ambient: AmbientTrack | null;
  ambientCalls: number[];
  /** SP-02a：這次喚醒的聲音證據。 */
  wakeVoice: WakeVoice | null;
  voiceCalls: number[];
  /** SP-02b：通話中聲音認出的人（給記憶層當候選；同一人只記第一次的時間，候選卡才對得上）。 */
  callVoice: { person_id: string; at: number } | null;
  callVoiceCalls: number[];
  /** 最近一次比對成功、沒有多臉的問候決策（給記憶層當人物候選；同一追蹤世代、60 秒內）。 */
  lastMatch: { person_id: string; track: number; at: number } | null;
  /** 記憶預設選人（2026-11-02）：最近一次看到多張臉的時間（多臉時不用聲音候選）。 */
  multiFaceAt: number | null;
}

type PageRate = "ambientCalls" | "voiceCalls" | "callVoiceCalls";

function emptyPage(): PageEvidence {
  return { ambient: null, ambientCalls: [], wakeVoice: null, voiceCalls: [], callVoice: null, callVoiceCalls: [], lastMatch: null, multiFaceAt: null };
}

const AMBIENT_REFUSED = "目前不能取樣";
const VOICE_REFUSED = "目前不能辨認聲音";

/** 一次喚醒的聲音證據只保留這麼久（喚醒到問候決策通常 2–5 秒；連線慢時上限約 20 秒）。 */
export const VOICE_EVIDENCE_MS = 30_000;
/** voice_probe 每秒最多幾次（每次喚醒正常只有 2 段）。 */
export const VOICE_PROBE_RATE_PER_S = 4;

/** 一次喚醒（wake_id）的聲音證據；換喚醒、gallery 改版或逾時就丟掉。 */
interface WakeVoice {
  wake_id: string;
  at: number;
  gallery_version: number;
  obs: Partial<Record<VoiceSegment, VoiceObservation>>;
}

/** 合併兩段聲音：指向兩個不同的人 → conflict；一段 matched → 那個人；否則取最「有內容」的狀態。 */
export function combineVoice(obs: Partial<Record<VoiceSegment, VoiceObservation>>): { state: VoiceObservation["state"]; person_id?: string; conflict: boolean } {
  const list = VOICE_SEGMENTS.map((seg) => obs[seg]).filter((o): o is VoiceObservation => !!o);
  const people = new Set(list.filter((o) => o.state === "matched" && o.person_id).map((o) => o.person_id!));
  if (people.size > 1) return { state: "ambiguous", conflict: true };
  if (people.size === 1) return { state: "matched", person_id: [...people][0]!, conflict: false };
  if (list.some((o) => o.state === "ambiguous")) return { state: "ambiguous", conflict: false };
  if (list.some((o) => o.state === "unknown")) return { state: "unknown", conflict: false };
  return { state: "unavailable", conflict: false };
}

/** log 用的片段摘要（不含身分）：例如「喚醒詞 matched／話語 too_short」。 */
function voiceSummary(v: WakeVoice | null): string {
  if (!v) return "沒有聲音";
  return VOICE_SEGMENTS.map((seg) => {
    const o = v.obs[seg];
    return `${seg === "keyword" ? "喚醒詞" : "話語"} ${o ? (o.state === "unavailable" ? (o.reason ?? "unavailable") : o.state) : "—"}`;
  }).join("／");
}

const QUIET_OPS = new Set(["probe", "ambient_probe", "ambient_status", "greeting", "ack_naming", "voice_probe", "call_voice"]);

/** 記住多少個已決策的互動 ID（每個互動最多一次決策）。 */
const DECIDED_KEEP = 32;

const LIMIT_MODELS_MISSING = "辨識模型未安裝（npm run face:setup -- --product）；只能查看與刪除";
const LIMIT_MODELS_BAD = "辨識模型雜湊不符，已停用新增與試認；只能查看與刪除";
const LIMIT_CAMERA = "鏡頭未啟用或已關閉；只能查看與刪除";
const LIMIT_KEY = "無法解開家人資料的金鑰（可能沒有允許鑰匙圈存取）：關閉後重新打開「家人辨識…」並在系統詢問時按「允許」，或重新啟動 Nous。資料沒有被改動";
const LIMIT_CORRUPT = "家人資料檔損壞或被改動，無法解密：只能清除全部家人資料後重新登記";
const VOICE_MODELS_MISSING = "聲音模型未安裝（npm run speaker:setup）；只能查看與刪除聲音";
const VOICE_MODELS_BAD = "聲音模型雜湊不符，已停用錄製聲音；只能查看與刪除";

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
  /** 各頁面的證據（RPI-ID：Mac 主視窗與終端機分開；Map 的順序＝最近使用）。 */
  private readonly pages = new Map<string, PageEvidence>();
  /** 所有終端機合計的取樣限速（各頁面另有自己的一份）。 */
  private readonly terminalCalls: Record<PageRate, number[]> = { ambientCalls: [], voiceCalls: [], callVoiceCalls: [] };
  private readonly greetingCalls: number[] = [];
  private readonly greetingMinute: number[] = [];
  /** 已做過問候決策的互動 ID。 */
  private readonly decided: string[] = [];
  /** live 路徑：已組好、等 server/live-route.ts 取用的短句（一次只有一個互動）。 */
  private pendingLive: { locale: Locale; interaction: string; session_id: string; named: boolean; text: string; sentence: string; at: number; briefing: PendingBriefing | null } | null = null;
  private readonly picker: GreetingPicker;
  /** SP-03a：聲音校準資料（第一次需要時才讀；undefined＝還沒讀）。 */
  private calibration: CalibrationFileData | null | undefined = undefined;
  /** 最近一次問候決策的臉聲融合結果（只給 log）。 */
  private lastFusion: VoiceFusion | null = null;

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
  private runtimeLimit(source = MAIN_SOURCE): string | null {
    const runtime = this.options.runtime.state;
    if (runtime === "missing" || runtime === "not_configured") return LIMIT_MODELS_MISSING;
    if (runtime === "hash_mismatch") return LIMIT_MODELS_BAD;
    if (!this.options.camera(source)) return LIMIT_CAMERA;
    return null;
  }

  /** settings.identity：只有選單列需要的欄位，不含人數、世代、姓名或 person_id。 */
  status(source = MAIN_SOURCE): IdentityStatus {
    if (this.closed) return { available: false, disabled_reason: "核心重新啟動中", limited_reason: null };
    if (!this.encryptionAvailable()) return { available: false, disabled_reason: "此 Mac 無法加密保存（safeStorage 不可用），家人辨識停用", limited_reason: null };
    return { available: true, disabled_reason: null, limited_reason: this.runtimeLimit(source) };
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
      needs_reenroll: this.people.filter((p) => p.features.length > 0 && !sameModelVersion(p.model, this.options.model)).length,
      damaged: this.people.filter((p) => p.damaged).length,
      gallery_version: this.versions.gallery_version,
      epoch: this.epoch,
      models: this.options.runtime.state,
      voice_models: this.options.speakerRuntime?.state ?? "not_configured",
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
    for (const page of this.pages.values()) {
      page.ambient = null;
      page.lastMatch = null;
      page.multiFaceAt = null;
    }
    this.pendingLive = null;
  }

  /**
   * 這個來源的證據（沒有就建一份）；同時把它標成最近使用，超過上限時丟掉最久沒用的終端機。只在請求的欄位驗證過之後呼叫，
   * 格式錯誤的請求不會建出頁面。
   */
  private page(source: string): PageEvidence {
    let page = this.pages.get(source);
    if (page) this.pages.delete(source);
    else page = emptyPage();
    this.pages.set(source, page);
    for (const key of this.pages.keys()) {
      if (this.pages.size <= PAGE_SOURCES_MAX) break;
      if (key !== MAIN_SOURCE) this.pages.delete(key);
    }
    return page;
  }

  /** 取樣限速：終端機先算所有終端機的合計（換識別碼繞不過），再算這個頁面自己的；回傳這個頁面。 */
  private pageRate(source: string, kind: PageRate, max: number): PageEvidence {
    if (source !== MAIN_SOURCE) this.ambientRate(this.terminalCalls[kind], max);
    const page = this.page(source);
    this.ambientRate(page[kind], max);
    return page;
  }

  /**
   * 只給記憶層（核心內部）：source 這個頁面最近一次比對成功、MEMORY_CANDIDATE_MS 內、同一追蹤世代、沒有多臉的決策。
   * 這只是「這次用 X 的偏好？」的候選，不是授權；記憶層要使用者確認後才選定人物。只看發問的頁面（打字聊天或語音通話所在的頁面）：
   * 別的頁面認出的人不會被拿來選人。
   */
  memoryCandidate(source: string): { person_id: string; name: string; at: number; source: "face" | "voice" } | null {
    const face = this.memoryFaceCandidate(source);
    if (face) return face;
    // SP-02b：沒有臉的候選時，用通話中聲音認出的人。記憶預設選人（2026-11-02）：畫面裡有多張臉時不用聲音候選。
    const page = this.pages.get(source);
    const v = page?.callVoice;
    if (!page || !v || this.now() - v.at > MEMORY_CANDIDATE_MS || this.multiFaceRecent(page)) return null;
    const person = this.comparableVoice().find((p) => p.person_id === v.person_id);
    return person ? { person_id: person.person_id, name: person.name, at: v.at, source: "voice" } : null;
  }

  /** 只給記憶層：source 這個頁面只有臉的候選（打字聊天的記憶預設選人只用臉，不退回通話中的聲音）。 */
  memoryFaceCandidate(source: string): { person_id: string; name: string; at: number; source: "face" } | null {
    const page = this.pages.get(source);
    const m = page?.lastMatch;
    if (!page || !m || this.now() - m.at > MEMORY_CANDIDATE_MS || (page.ambient && page.ambient.track !== m.track)) return null;
    const person = this.comparable().find((p) => p.person_id === m.person_id);
    return person ? { person_id: person.person_id, name: person.name, at: m.at, source: "face" } : null;
  }

  /** 這個頁面最近（候選有效期間內）看到多張臉。 */
  private multiFaceRecent(page: PageEvidence): boolean {
    return (page.ambient?.mixed ?? false) || (page.multiFaceAt !== null && this.now() - page.multiFaceAt <= MEMORY_CANDIDATE_MS);
  }

  /** 只給記憶層：已登記的家人（連結到既有人物用）；家人資料還沒載入時回 null，不在這裡碰 Keychain。 */
  memoryPeople(): { person_id: string; name: string; minor: boolean }[] | null {
    if (this.gallery !== "ready") return null;
    return this.people.map((p) => ({ person_id: p.person_id, name: p.name, minor: p.minor }));
  }

  /**
   * IPC 或終端機 HTTP 進來的請求（已由 shared/identity-validate.mjs 過濾形狀；這裡仍完整驗證，核心為權威）。
   * ctx.source 分開各頁面的證據（未提供時是 Mac 主視窗）。
   */
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
    const source = ctx.source ?? MAIN_SOURCE;
    if (source !== MAIN_SOURCE && !isTerminalId(source)) throw new RequestError("bad_request", "source 格式不對");
    if (op === "ambient_status") return this.ambientStatus(source);
    if (op === "ambient_probe") return this.ambientProbe(req, source);
    if (op === "greeting") return this.greeting(req, source);
    if (op === "voice_probe") return this.voiceProbe(req, source);
    if (op === "call_voice") return this.callVoiceProbe(req, source);
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
      case "enroll_voice":
        return this.mutate(() => this.enrollVoice(session, req));
      case "delete_voice":
        return this.mutate(() => this.removeVoice(session, req));
      case "voice_test":
        return this.voiceTest(req);
      case "calib_status":
        this.requireVoiceReady();
        return { ok: true, op: "calib_status", report: this.calibrationReport() };
      case "calib_trial":
        return this.calibTrial(req);
      case "calib_apply":
        return this.mutate(() => this.calibApply());
      case "calib_clear":
        return this.mutate(() => this.calibClear());
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
      needs_reenroll: p.features.length > 0 && !sameModelVersion(p.model, this.options.model),
      damaged: p.damaged === true,
      face: p.features.length > 0,
      voice: !p.voice ? "none" : this.options.speakerModel && sameSpeakerModel(p.voice.model, this.options.speakerModel) ? "enrolled" : "needs_reenroll",
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
    return this.people.filter((p) => !p.damaged && p.features.length > 0 && sameModelVersion(p.model, this.options.model));
  }

  /** 聲音：只與講者模型版本相符、資料完好的家人比對。 */
  private comparableVoice(): StoredPerson[] {
    const model = this.options.speakerModel;
    return model ? this.people.filter((p) => !p.damaged && p.voice && sameSpeakerModel(p.voice.model, model)) : [];
  }

  /** 錄製聲音需要 gallery 可用與講者模型核對通過；鏡頭與臉的模型無關。 */
  private requireVoiceReady(): SpeakerModelVersion {
    const st = this.manageStatus();
    if (st.state !== "ready") throw new RequestError("unavailable", st.limited_reason ?? "家人資料不可用");
    const runtime = this.options.speakerRuntime?.state ?? "not_configured";
    if (runtime === "hash_mismatch") throw new RequestError("unavailable", VOICE_MODELS_BAD);
    if (runtime !== "ok" || !this.options.speakerModel) throw new RequestError("unavailable", VOICE_MODELS_MISSING);
    return this.options.speakerModel;
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

  /**
   * 看著說話時同步辨識不能做的原因；null＝可以。不載入 gallery（不碰 Keychain）。
   * viaWake（WK-02）：喚醒開始的互動不需要「看著說話」「看著說話時先打招呼」；其他條件不變。
   */
  private ambientBlock(source: string, viaWake = false): string | null {
    const prefs = this.ambientPrefs();
    if (!viaWake && (!prefs.look_to_talk || !prefs.look_to_talk_greet)) return "看著說話或打招呼關閉";
    if (!prefs.look_to_talk_greet_name) return "稱名關閉";
    const st = this.status(source);
    if (!st.available) return st.disabled_reason ?? "家人辨識不可用";
    if (st.limited_reason) return st.limited_reason;
    if (this.session) return "家人辨識畫面開著";
    if (this.gallery === "key_unavailable" || this.gallery === "corrupt") return "家人資料解不開";
    if (this.gallery === "unloaded" ? !this.options.store.exists() : this.comparable().length === 0) return "沒有可比對的家人";
    return null;
  }

  private ambientStatus(source: string): IdentityResponse {
    return { ok: true, op: "ambient_status", ready: this.ambientBlock(source, this.wakeOpen(source)) === null };
  }

  private wakeOpen(source: string): boolean {
    try {
      return this.options.wakeGreetingOpen?.(source) === true;
    } catch {
      return false;
    }
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
  private ambientProbe(req: Record<string, unknown>, source: string): IdentityResponse {
    const track = req.track;
    if (typeof track !== "number" || !Number.isInteger(track) || track < 0) throw new RequestError("bad_request", "track 格式不對");
    const page = this.pageRate(source, "ambientCalls", SESSION_RATE_PER_S);
    // 被拒時不說原因：「沒有可比對的家人」之類的原因會透露有沒有登記家人。
    if (this.ambientBlock(source, this.wakeOpen(source))) throw new RequestError("unavailable", AMBIENT_REFUSED);
    this.ensureLoaded();
    if (this.gallery !== "ready") throw new RequestError("unavailable", AMBIENT_REFUSED);
    this.requireModel(req);
    const match = this.matchFrame(req);
    const now = this.now();
    if (!page.ambient || page.ambient.track !== track) page.ambient = { track, evidence: EMPTY_EVIDENCE, firstMatch: null, mixed: false };
    if (page.lastMatch && page.lastMatch.track !== track) page.lastMatch = null;
    const a = page.ambient;
    if (match.kind === "ambiguous" && match.reason === "multi_face") {
      a.mixed = true;
      page.lastMatch = null;
      page.multiFaceAt = now;
      // 多人入鏡：記憶的本次人物暫停（只降權；別的頁面選定的不動）。
      this.options.memory?.()?.suspend("multi_face", source);
    }
    if (match.kind === "matched") {
      a.firstMatch ??= match.person_id;
      if (a.firstMatch !== match.person_id) a.mixed = true;
    }
    a.evidence = pushEvidence(a.evidence, { t: now, gen: track, match }, this.ambientScope(track), isTerminalId(source) ? TERMINAL_EVIDENCE_TIMING : undefined);
    return { ok: true, op: "ambient_probe" };
  }

  /**
   * 送出問候前的決策（docs/14 §3）。頁面負責它看得到的條件（eligible：同一互動與追蹤世代、仍在近距離面向、
   * 只有一張臉、辨識沒有出錯）；核心負責其餘：同一追蹤世代、沒有混到別人、證據 ≥3 格且仍在來源的有效時窗內、person 仍存在且
   * gallery 版本沒變、稱名設定仍開。任一項不符就不帶名字（仍說「我在」）。每個互動 ID 最多決策一次。
   */
  private greeting(req: Record<string, unknown>, source: string): IdentityResponse {
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
    const page = this.page(source);

    // 互動 ID 必須換得到核心自己知道的、真的連上的工作階段（頁面自己編的 ID 不給名字）。
    const claim = this.options.claimGreeting?.(interaction) ?? null;
    const session = claim && claim.route === route ? claim : null;
    const wakeId = session?.source === "wake_word" ? (session.wake_id ?? null) : null;
    const decision = this.decide(source, page, interaction, track, req.eligible, session !== null, session?.source === "wake_word", wakeId);
    const person = decision.person_id ? this.people.find((p) => p.person_id === decision.person_id) : undefined;
    const name = person ? speakableName(person.name) : null;
    // 從固定清單挑一句（依時段、避開上一次）；log 只記模板編號，不記句子。
    const locale = normalizeLocale(session?.locale);
    const picked = this.picker.pick(name, locale);
    // PRO-1：招呼後接的主動提醒（確定性的模板；沒有就只打招呼）。
    // PRO-2：核心聽得到這通的回答才問行程：live 一律有 sideband；API key 要有核心旁路（apiKeyListens）。
    const listens = session !== null && (route === "live" || this.options.apiKeyListens?.(session.session_id) === true);
    let briefing = this.composeBriefing({ personId: name !== null ? decision.person_id : null, name, listens }, locale);
    // live：整段要放得進一段 sideband append（≤500 bytes），否則第二段沒有「（開場）」標記、可能被念出指示；放不下就不接。
    if (briefing && route === "live") briefing = fitBriefing(briefing, (extra) => fitsLiveAppend(liveGreetingText(appendBriefing(picked.sentence, extra, locale), locale)));
    const sentence = appendBriefing(picked.sentence, briefing?.sentence ?? null, locale);
    // 只有原因與數字（給 Mac 實測對照時序）：證據格數、跨度與最新一格多久以前；不記姓名、person_id 或分數。
    const ev = page.ambient?.track === track ? page.ambient.evidence.frames : [];
    const span = ev.length ? Math.round(ev.at(-1)!.t - ev[0]!.t) : 0;
    const age = decision.evidence_at === null ? "—" : `${Math.round(decision.decided_at - decision.evidence_at)} ms`;
    const voice = wakeId !== null ? `，聲音 ${voiceSummary(this.voiceFor(page, wakeId))}，融合 ${this.lastFusion ?? "—"}` : "";
    this.log(`identity: 問候決策（${route}，${decision.reason ?? "ok"}，世代 ${track}，連續證據 ${ev.length} 格／${span} ms，最新 ${age} 前${voice}，模板 ${picked.id}${briefing ? "＋天氣" : ""}，${decision.calibrated ? "聲音門檻已校準" : "門檻未校準"}）`);
    // 證據只為這一次問候存在：決策後丟掉，晚到的推論不能讓下一次互動沿用。
    page.ambient = null;
    if (wakeId !== null && page.wakeVoice?.wake_id === wakeId) page.wakeVoice = null;
    // 新的互動：上一通的聲音候選不沿用。
    page.callVoice = null;
    // 記憶的臉部候選只來自臉（只憑聲音的測試開關不算）。
    page.lastMatch = decision.person_id && decision.reason === null && this.lastFusion !== "voice_only_test" && this.lastFusion !== "voice_only_calibrated" ? { person_id: decision.person_id, track, at: this.now() } : null;
    if (route === "api_key") {
      if (session) {
        // PRO-1：有核心旁路時，等問候那一輪真的開始（response.created）才記下說過；沒有旁路時旁路會立刻呼叫 spoken。
        const b = briefing;
        if (this.options.apiKeyGreeted) {
          const call = { sessionId: session.session_id, spoken: sentence };
          try { this.options.apiKeyGreeted(session.session_id, name !== null, b ? () => this.commitBriefing(b, call) : undefined); } catch { /* 通知失敗不影響問候 */ }
        } else if (b) this.commitBriefing(b);
      } else if (briefing) {
        // 換不到工作階段（核心看不到這通）：交回頁面就算說過。
        this.commitBriefing(briefing);
      }
      return { ok: true, op: "greeting", text: strictGreetingInstructions(sentence, locale) };
    }
    this.pendingLive = session ? { locale, interaction, session_id: session.session_id, named: name !== null, text: liveGreetingText(sentence, locale), sentence, at: this.now(), briefing } : null;
    return { ok: true, op: "greeting", text: null };
  }

  private composeBriefing(subject: BriefingSubject, locale: Locale): PendingBriefing | null {
    try {
      return this.options.briefing?.compose(subject, locale) ?? null;
    } catch (err) {
      this.log(`主動提醒：組句失敗，這次只打招呼（${(err as Error).message}）`);
      return null;
    }
  }

  private commitBriefing(b: PendingBriefing, call?: { sessionId: string; spoken: string }): void {
    try {
      this.options.briefing?.commit(b, call);
    } catch {
      // 紀錄寫不進去不影響問候
    }
  }

  /** 建立 GreetingDecision（只在核心）。名稱驗證不過時改成不稱名。 */
  private decide(source: string, page: PageEvidence, interaction: string, track: number, eligible: boolean, claimed: boolean, viaWake = false, wakeId: string | null = null): GreetingDecision {
    const now = this.now();
    // 先記「沒有臉的結果時」的融合（只給 log）；臉認出人時下面會改寫。
    this.lastFusion = wakeId === null ? null : combineVoice(this.voiceFor(page, wakeId)?.obs ?? {}).state === "matched" ? "voice_only" : "none";
    const base = { interaction_id: interaction, track_generation: track, gallery_version: this.versions.gallery_version, decided_at: now, calibrated: CALIBRATED };
    const last = page.ambient?.track === track ? page.ambient.evidence.frames.at(-1) : undefined;
    const plain = (reason: GreetingNameReason): GreetingDecision => ({ ...base, person_id: null, evidence_at: last?.t ?? null, reason });
    // 認不出臉（不是看到別人）時，測試開關開著就改用聲音（只限喚醒開始的通話）。
    // SP-03a：校準驗證通過的片段，不需要測試開關也可以只憑聲音稱名。
    const faceMissing = (reason: GreetingNameReason): GreetingDecision => (wakeId !== null ? (this.voiceOnly(page, base, wakeId, track) ?? plain(reason)) : plain(reason));
    if (!this.ambientPrefs().look_to_talk_greet_name) return plain("naming_off");
    if (!claimed) return plain("no_session");
    if (!this.options.store.namingNoticeSeen()) return plain("notice_unseen");
    if (!eligible) return faceMissing("not_eligible");
    if (this.ambientBlock(source, viaWake)) return faceMissing("unavailable");
    const a = page.ambient;
    if (!a) return faceMissing("no_evidence");
    if (a.track !== track) return faceMissing("track_changed");
    if (a.mixed) return plain("multi_face");
    const obs = decideIdentity(a.evidence, now, this.ambientScope(track), isTerminalId(source) ? TERMINAL_EVIDENCE_TIMING : undefined);
    if (obs.state !== "matched" || !obs.person_id) {
      const reason: GreetingNameReason = obs.state === "unknown" ? "unknown" : obs.state === "ambiguous" ? (obs.reason === "multi_face" ? "multi_face" : "ambiguous") : ((obs.reason ?? "collecting") as GreetingNameReason);
      // 看到陌生臉（unknown）或分不出是哪一位（ambiguous）是臉在反對，不改用聲音；只有證據不足才算「認不出臉」。
      return obs.state === "unavailable" ? faceMissing(reason) : plain(reason);
    }
    const person = this.comparable().find((p) => p.person_id === obs.person_id);
    if (!person) return plain("person_gone");
    if (!speakableName(person.name)) return plain("bad_name");
    if (wakeId !== null) {
      const fusion = this.fuse(person, this.voiceFor(page, wakeId));
      this.lastFusion = fusion;
      if (fusion === "conflict") return plain("voice_conflict");
      if (fusion === "voice_unsupported") return plain("voice_unsupported");
    }
    return { ...base, person_id: person.person_id, evidence_at: last?.t ?? null, reason: null };
  }

  // ─────────────── SP-02a：喚醒時認聲音 ───────────────

  private voiceNameTestOn(): boolean {
    try {
      return this.options.voiceNameTest?.() === true;
    } catch {
      return false;
    }
  }

  /**
   * 測試開關：這次喚醒的聲音認出一人（兩段沒有互相矛盾）、名稱可念，就以聲音叫名字；否則 null。
   * 這個追蹤世代出現過多張臉，或臉曾認出另一位家人，就不用聲音（頁面的 not_eligible 也可能是多張臉）。
   */
  private voiceOnly(page: PageEvidence, base: Omit<GreetingDecision, "person_id" | "evidence_at" | "reason">, wakeId: string, track: number): GreetingDecision | null {
    const voice = this.voiceFor(page, wakeId);
    const v = combineVoice(voice?.obs ?? {});
    if (v.state !== "matched" || v.conflict) return null;
    const test = this.voiceNameTestOn();
    // 沒有測試開關時，認出這個人的那段片段必須校準驗證通過（17 §4.4：對應片段的校準完成才可以稱名）。
    const calibrated = this.calibratedSegments();
    const byCalibrated = VOICE_SEGMENTS.some((seg) => calibrated[seg] && voice?.obs[seg]?.state === "matched" && voice.obs[seg]?.person_id === v.person_id);
    if (!test && !byCalibrated) return null;
    const a = page.ambient?.track === track ? page.ambient : null;
    if (a && (a.mixed || (a.firstMatch !== null && a.firstMatch !== v.person_id))) return null;
    const person = this.comparableVoice().find((p) => p.person_id === v.person_id);
    if (!person || !speakableName(person.name)) return null;
    this.lastFusion = byCalibrated ? "voice_only_calibrated" : "voice_only_test";
    return { ...base, person_id: person.person_id, evidence_at: null, reason: null, ...(byCalibrated ? { calibrated: true } : {}) };
  }

  // ─────────────── SP-03a：聲音校準 ───────────────

  private loadCalibration(): CalibrationFileData | null {
    if (this.calibration === undefined) this.calibration = this.options.store.loadCalibration?.() ?? null;
    const c = this.calibration;
    const model = this.options.speakerModel;
    // 講者模型換了：舊分數與門檻都不適用。
    if (c && model && !sameSpeakerModel(c.model, model)) return null;
    return c;
  }

  /** 目前每種片段的門檻：已套用的校準值，否則是起點值。 */
  private voiceLimits(segment: VoiceSegment): { match: number; margin: number } {
    const applied = this.loadCalibration()?.applied?.thresholds[segment];
    if (applied) return applied;
    const d = VOICE_THRESHOLDS[segment];
    return { match: d.match, margin: d.margin };
  }

  private voiceVersions(): Record<string, string> {
    return Object.fromEntries(this.comparableVoice().map((p) => [p.person_id, p.voice!.updated_at]));
  }

  /** 還有效的試驗：模板集合與版本和現在一樣（重錄、刪除或新增家人之後，舊分數不再採用）。 */
  private validTrials(c: CalibrationFileData): StoredCalibrationTrial[] {
    const now = this.voiceVersions();
    const keys = Object.keys(now).sort().join(",");
    return c.trials.filter((t) => Object.keys(t.templates).sort().join(",") === keys && Object.entries(t.templates).every(([pid, at]) => now[pid] === at));
  }

  calibratedSegments(): Record<VoiceSegment, boolean> {
    const out: Record<VoiceSegment, boolean> = { keyword: false, utterance: false };
    try {
      if (!this.loadCalibration()?.applied) return out;
      for (const seg of this.calibrationReport().segments) out[seg.segment] = seg.calibrated;
    } catch {
      // 讀不到就當沒校準
    }
    return out;
  }

  calibrationReport(): CalibrationReport {
    const c = this.loadCalibration();
    const trials = c ? this.validTrials(c) : [];
    const voices = this.comparableVoice().length;
    const appliedAt = c?.applied?.at ?? null;
    const segments = VOICE_SEGMENTS.map((segment): CalibrationSegmentReport => {
      const current = this.voiceLimits(segment);
      const seg = trials.filter((t) => t.segment === segment);
      const collect = seg.filter((t) => t.phase === "collect");
      const own = (t: StoredCalibrationTrial) => t.scores.find((x) => x.person_id === t.person_id)?.score ?? null;
      const members = collect.filter((t) => t.label === "member" && t.person_id);
      const memberScores = members.map(own).filter((x): x is number => x !== null);
      // 冒名分數：電腦朗讀的陌生聲音對任何家人；家人樣本對其他家人。
      const impostor: number[] = [];
      for (const t of collect) {
        const others = t.label === "stranger" ? t.scores : t.scores.filter((x) => x.person_id !== t.person_id);
        if (others.length) impostor.push(Math.max(...others.map((x) => x.score)));
      }
      const strangers = collect.filter((t) => t.label === "stranger").length;
      const strangerMax = impostor.length ? Math.max(...impostor) : null;
      const ready = members.length >= CALIBRATION_MIN.member && strangers >= CALIBRATION_MIN.stranger && strangerMax !== null;
      const proposed = ready ? { match: round3(Math.min(0.95, Math.max(CALIBRATION_MATCH_FLOOR, strangerMax! + CALIBRATION_SAFETY))), margin: VOICE_THRESHOLDS[segment].margin } : null;
      const rejectRate = proposed && members.length ? members.filter((t) => acceptedBy(t.scores, proposed) !== t.person_id).length / members.length : null;
      const verifyTrials = appliedAt ? seg.filter((t) => t.phase === "verify" && t.at >= appliedAt) : [];
      const vStrangers = verifyTrials.filter((t) => t.label === "stranger");
      const vMembers = verifyTrials.filter((t) => t.label === "member" && t.person_id);
      const verify = {
        stranger_trials: vStrangers.length,
        false_accepts: vStrangers.filter((t) => acceptedBy(t.scores, current) !== null).length + vMembers.filter((t) => {
          const who = acceptedBy(t.scores, current);
          return who !== null && who !== t.person_id;
        }).length,
        member_trials: vMembers.length,
        rejects: vMembers.filter((t) => acceptedBy(t.scores, current) !== t.person_id).length,
      };
      const applied = !!c?.applied;
      return {
        segment,
        member_trials: members.length,
        stranger_trials: strangers,
        member_min: memberScores.length ? round3(Math.min(...memberScores)) : null,
        member_median: memberScores.length ? round3(median(memberScores)!) : null,
        stranger_max: strangerMax === null ? null : round3(strangerMax),
        proposed,
        proposed_reject_rate: rejectRate === null ? null : round3(rejectRate),
        current,
        applied,
        verify,
        calibrated: applied && verify.stranger_trials >= CALIBRATION_VERIFY_STRANGERS && verify.false_accepts === 0,
      };
    });
    return { segments, voices, applied_at: appliedAt };
  }

  /** 記一筆校準試驗（只存分數）。套用門檻之前是 collect，之後是 verify。 */
  private calibTrial(req: Record<string, unknown>): IdentityResponse {
    this.requireVoiceReady();
    this.requireSpeakerModel(req);
    const label = req.label;
    if (label !== "member" && label !== "stranger") throw new RequestError("bad_request", "label 格式不對");
    const segment = this.segmentOf(req.segment);
    const voiced = req.voiced_ms;
    if (typeof voiced !== "number" || !Number.isInteger(voiced) || voiced < 0 || voiced > 60_000) throw new RequestError("bad_request", "voiced_ms 格式不對");
    const people = this.comparableVoice();
    if (people.length === 0) throw new RequestError("unavailable", "還沒有家人登記聲音");
    let personId: string | undefined;
    if (label === "member") {
      if (typeof req.person_id !== "string" || !people.some((p) => p.person_id === req.person_id)) throw new RequestError("not_found", "找不到這位登記了聲音的家人");
      personId = req.person_id;
    }
    const feature = toSpeakerFeature(req.feature);
    const scores = people.map((p) => ({ person_id: p.person_id, score: round3(dot(feature, meanDirection(p.voice![segment]))) }));
    feature.fill(0);
    const model = this.options.speakerModel!;
    const c: CalibrationFileData = this.loadCalibration() ?? { model, trials: [], applied: null };
    c.trials.push({
      label,
      ...(personId ? { person_id: personId } : {}),
      segment,
      voiced_ms: voiced,
      scores,
      phase: c.applied ? "verify" : "collect",
      at: new Date(this.now()).toISOString(),
      templates: this.voiceVersions(),
    });
    this.options.store.saveCalibration?.(c);
    this.calibration = c;
    return { ok: true, op: "calib_trial", report: this.calibrationReport() };
  }

  private async calibApply(): Promise<IdentityResponse> {
    this.requireVoiceReady();
    const report = this.calibrationReport();
    const pick = (seg: VoiceSegment) => {
      const r = report.segments.find((x) => x.segment === seg)!;
      return r.proposed ? { match: r.proposed.match, reject_rate: r.proposed_reject_rate ?? 0 } : null;
    };
    const keyword = pick("keyword");
    const utterance = pick("utterance");
    if (!keyword && !utterance) throw new RequestError("bad_samples", "資料還不夠：每種片段至少要有 10 筆你的樣本與 30 筆陌生聲音");
    const ok = (await this.options.confirm({ kind: "calib_apply", keyword, utterance })) === true;
    if (!ok) throw new RequestError("declined", "沒有套用");
    const c = this.loadCalibration()!;
    const keep = (seg: VoiceSegment) => {
      const d = VOICE_THRESHOLDS[seg];
      return { match: d.match, margin: d.margin };
    };
    c.applied = {
      at: new Date(this.now()).toISOString(),
      thresholds: {
        keyword: keyword ? { match: keyword.match, margin: VOICE_THRESHOLDS.keyword.margin } : keep("keyword"),
        utterance: utterance ? { match: utterance.match, margin: VOICE_THRESHOLDS.utterance.margin } : keep("utterance"),
      },
    };
    this.options.store.saveCalibration?.(c);
    this.calibration = c;
    this.log(`identity: 聲音門檻已套用（喚醒詞 ${keyword ? "校準值" : "起點值"}，話語 ${utterance ? "校準值" : "起點值"}；待驗證）`);
    return { ok: true, op: "calib_apply", report: this.calibrationReport() };
  }

  private async calibClear(): Promise<IdentityResponse> {
    this.requireVoiceReady();
    const ok = (await this.options.confirm({ kind: "calib_clear" })) === true;
    if (!ok) throw new RequestError("declined", "沒有清除");
    this.options.store.removeCalibration?.();
    this.calibration = null;
    this.log("identity: 聲音校準資料已清除");
    return { ok: true, op: "calib_clear", report: this.calibrationReport() };
  }

  /**
   * 臉認出 person 時，這次喚醒的聲音支不支持他（docs/17 §7.3）。這個人沒有登記聲音時，unknown／ambiguous 不算反對
   * （本來就比不到他），只有聲音明確認成別人才是 conflict。
   */
  private fuse(person: StoredPerson, voice: WakeVoice | null): VoiceFusion {
    const v = combineVoice(voice?.obs ?? {});
    if (v.conflict) return "conflict";
    if (v.state === "matched") return v.person_id === person.person_id ? "confirmed" : "conflict";
    const hasVoice = this.comparableVoice().some((p) => p.person_id === person.person_id);
    if ((v.state === "unknown" || v.state === "ambiguous") && hasVoice) return "voice_unsupported";
    return "face_only";
  }

  /** 這次喚醒還有效的聲音證據（同一個 wake_id、gallery 沒改版、沒逾時）。 */
  private voiceFor(page: PageEvidence, wakeId: string): WakeVoice | null {
    const v = page.wakeVoice;
    if (!v || v.wake_id !== wakeId) return null;
    if (v.gallery_version !== this.versions.gallery_version || this.now() - v.at > VOICE_EVIDENCE_MS) {
      page.wakeVoice = null;
      return null;
    }
    return v;
  }

  /** 喚醒時能不能辨認聲音；null＝可以。不需要鏡頭與看著說話的設定（聲音只能取消或確認臉的稱名）。 */
  private voiceBlock(): string | null {
    const st = this.status();
    if (!st.available) return st.disabled_reason ?? "家人辨識不可用";
    if (this.session) return "家人辨識畫面開著";
    if ((this.options.speakerRuntime?.state ?? "not_configured") !== "ok" || !this.options.speakerModel) return "聲音模型不可用";
    if (this.gallery === "key_unavailable" || this.gallery === "corrupt") return "家人資料解不開";
    if (this.gallery === "unloaded" && !this.options.store.exists()) return "沒有家人資料";
    return null;
  }

  /** 一段聲音與每位家人同類模板的平均方向比對（最高分 ≥ match 且領先第二名 ≥ margin）。 */
  private matchVoice(segment: VoiceSegment, feature: Float32Array): VoiceObservation {
    const people = this.comparableVoice();
    if (people.length === 0) return { state: "unavailable", reason: "no_enrollment", segment };
    const limits = this.voiceLimits(segment);
    const ranked = people.map((person) => ({ person, score: dot(feature, meanDirection(person.voice![segment])) })).sort((a, b) => b.score - a.score);
    const [first, second] = ranked;
    if (!first || first.score < limits.match) return { state: "unknown", segment };
    if (second && first.score - second.score < limits.margin) return { state: "ambiguous", reason: "margin", segment };
    return { state: "matched", person_id: first.person.person_id, segment };
  }

  private segmentOf(v: unknown): VoiceSegment {
    if (v !== "keyword" && v !== "utterance") throw new RequestError("bad_request", "segment 格式不對");
    return v;
  }

  private requireSpeakerModel(req: Record<string, unknown>): void {
    const model = this.options.speakerModel;
    if (!model || !sameSpeakerModel(speakerModelOf(req.model), model)) throw new RequestError("model_mismatch", "頁面的聲音模型版本與核心不同，請重新整理");
  }

  /** 喚醒時的一段聲音。回應只有 ok；被拒時不說原因（原因可能透露有沒有登記家人）。 */
  private voiceProbe(req: Record<string, unknown>, source: string): IdentityResponse {
    const wakeId = req.wake_id;
    if (typeof wakeId !== "string" || !WAKE_ID.test(wakeId)) throw new RequestError("bad_request", "wake_id 格式不對");
    const segment = this.segmentOf(req.segment);
    const voiced = req.voiced_ms;
    if (typeof voiced !== "number" || !Number.isInteger(voiced) || voiced < 0 || voiced > 60_000) throw new RequestError("bad_request", "voiced_ms 格式不對");
    const page = this.pageRate(source, "voiceCalls", VOICE_PROBE_RATE_PER_S);
    if (this.voiceBlock()) throw new RequestError("unavailable", VOICE_REFUSED);
    this.ensureLoaded();
    if (this.gallery !== "ready") throw new RequestError("unavailable", VOICE_REFUSED);
    this.requireSpeakerModel(req);
    let obs: VoiceObservation;
    if (req.feature === undefined || voiced < VOICE_MIN_VOICED_MS[segment]) {
      obs = { state: "unavailable", reason: "too_short", segment };
    } else {
      const feature = toSpeakerFeature(req.feature);
      obs = this.matchVoice(segment, feature);
      feature.fill(0);
    }
    const now = this.now();
    const current = this.voiceFor(page, wakeId);
    const v: WakeVoice = current ?? { wake_id: wakeId, at: now, gallery_version: this.versions.gallery_version, obs: {} };
    v.obs[segment] = obs;
    page.wakeVoice = v;
    return { ok: true, op: "voice_probe" };
  }

  /**
   * SP-02b 通話中的一段話。回應只有 ok；被拒時不說原因。結果只用在記憶人物候選與 log（不撤銷、不打斷，George 2026-11-01）。
   */
  private callVoiceProbe(req: Record<string, unknown>, source: string): IdentityResponse {
    const voiced = req.voiced_ms;
    if (typeof voiced !== "number" || !Number.isInteger(voiced) || voiced < 0 || voiced > 60_000) throw new RequestError("bad_request", "voiced_ms 格式不對");
    const page = this.pageRate(source, "callVoiceCalls", 2);
    let on = false;
    try {
      on = this.options.speakerInCall?.() === true;
    } catch {
      on = false;
    }
    if (!on || this.voiceBlock()) throw new RequestError("unavailable", VOICE_REFUSED);
    this.ensureLoaded();
    if (this.gallery !== "ready") throw new RequestError("unavailable", VOICE_REFUSED);
    this.requireSpeakerModel(req);
    if (req.feature === undefined || voiced < CALL_VOICE_MIN_MS) return { ok: true, op: "call_voice" };
    const feature = toSpeakerFeature(req.feature);
    const obs = this.matchVoice("utterance", feature);
    feature.fill(0);
    const memory = this.options.memory?.() ?? null;
    let current: string | null = null;
    try {
      current = memory?.currentPersonId?.() ?? null;
    } catch {
      current = null;
    }
    const now = this.now();
    let note = "";
    if (obs.state === "matched" && obs.person_id) {
      if (current !== null) {
        note = obs.person_id === current ? "，與本次人物一致" : "，像另一位家人（只記錄，不打斷）";
        // 記憶預設選人（2026-11-02）：剛預設選定（10 秒內）就聽到另一位家人的聲音時，記憶層改回全家共用；其他情況照 G2 只記錄。
        if (obs.person_id !== current) {
          try {
            memory?.voiceDisagrees?.(source);
          } catch {
            // 記憶層自己處理
          }
        }
      } else if (this.multiFaceRecent(page)) {
        // 記憶預設選人（2026-11-02）：多張臉時不提聲音候選（只降權）。
        page.callVoice = null;
        note = "，沒有本次人物，畫面有多張臉，不提候選";
      } else {
        const v = page.callVoice;
        const faceAgainst = !!page.ambient && (page.ambient.mixed || (page.ambient.firstMatch !== null && page.ambient.firstMatch !== obs.person_id));
        // 記憶預設選人（2026-11-02）：問候決策認出的臉（記憶的候選）是另一位家人。
        const lastFace = page.lastMatch && now - page.lastMatch.at <= MEMORY_CANDIDATE_MS ? page.lastMatch.person_id : null;
        const faceOther = lastFace !== null && lastFace !== obs.person_id;
        if (faceAgainst || faceOther || (v && now - v.at <= MEMORY_CANDIDATE_MS && v.person_id !== obs.person_id)) {
          // 臉或前一段話指向別人：不提候選；還在等選定的記憶預設選人也作廢（改用全家共用）。
          page.callVoice = null;
          note = "，沒有本次人物，和其他證據不一致，不提候選";
          try {
            memory?.voiceDisagrees?.(source);
          } catch {
            // 記憶層自己處理
          }
        } else {
          if (!v || now - v.at > MEMORY_CANDIDATE_MS) page.callVoice = { person_id: obs.person_id, at: now };
          note = "，沒有本次人物，提出聲音候選";
          const named = this.ambientPrefs().look_to_talk_greet_name && this.options.store.namingNoticeSeen();
          try {
            memory?.offerVoiceCandidate?.(named, source);
          } catch {
            // 記憶層自己處理
          }
        }
      }
    }
    this.log(`identity: 通話中聲音（${obs.state === "unavailable" ? (obs.reason ?? "unavailable") : obs.state}${note}，門檻未校準）`);
    return { ok: true, op: "call_voice" };
  }

  /** 管理畫面的「試認聲音」：回傳這一段認成誰（不含分數）。 */
  private voiceTest(req: Record<string, unknown>): IdentityResponse {
    this.requireVoiceReady();
    this.requireSpeakerModel(req);
    const segment = this.segmentOf(req.segment);
    const feature = toSpeakerFeature(req.feature);
    const observation = this.matchVoice(segment, feature);
    feature.fill(0);
    return { ok: true, op: "voice_test", observation };
  }

  /**
   * server/live-route.ts 取用 live 路徑的短句（頁面 POST greeting 帶來的只有互動 ID）。只有同一個互動、同一個 live 工作階段、
   * LIVE_GREETING_PICKUP_MS 內才給，取一次就清掉；稱名在這之間被關掉時改挑一句不含名字的。找不到時回 null
   * （server/nous.ts 的 liveGreetingSource 改挑一句不含名字的）。回傳整段文字與那一句（逐字稿緩衝用來認出問候）。
   */
  takeLiveGreeting(interaction: string, sessionId: string, use = true): { text: string; sentence: string; named: boolean } | null {
    const pending = this.pendingLive;
    this.pendingLive = null;
    if (!pending || pending.interaction !== interaction || pending.session_id !== sessionId || this.now() - pending.at > LIVE_GREETING_PICKUP_MS) return null;
    // use=false：使用者先開口，這次不打招呼，只丟掉；主動提醒沒有說出，不記。
    if (pending.named && !this.ambientPrefs().look_to_talk_greet_name) {
      const plain = this.picker.plainLive(pending.locale, pending.briefing?.sentence ?? null);
      if (use && pending.briefing) this.commitBriefing(pending.briefing, { sessionId, spoken: plain.sentence });
      return { ...plain, named: false };
    }
    if (use && pending.briefing) this.commitBriefing(pending.briefing, { sessionId, spoken: pending.sentence });
    // named：MEM-2 臉部候選的問句只有在問候已經稱名時才帶名字。
    return { text: pending.text, sentence: pending.sentence, named: pending.named };
  }

  /** 等待原生確認之後：核心關閉、session 換掉或 gallery 已被改過就不寫。 */
  private afterConfirm(session: Session, what: string): void {
    if (this.closed) throw new RequestError("closed", `Nous 核心正在重新啟動，${what}`);
    if (this.session !== session) throw new RequestError("no_session", `家人辨識畫面已失效，${what}`);
  }

  private async enroll(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    this.requireReady("新增家人");
    this.requireModel(req);
    // SP-01：person_id＝幫只登記了聲音的家人補上臉（名稱與未成年沿用已存的資料）。
    const existing = req.person_id === undefined ? null : this.findPerson(req.person_id);
    if (existing && existing.features.length > 0) throw new RequestError("bad_request", "這位家人已經登記過臉；要重新登記請先刪除");
    if (!existing && this.people.length >= FAMILY_MAX) throw new RequestError("full", `最多 ${FAMILY_MAX} 位家人`);
    const name = existing ? { ok: true as const, name: existing.name } : parseFamilyName(req.name);
    if (!name.ok) throw new RequestError("bad_name", name.error);
    if (req.consent !== true) throw new RequestError("consent_required", "需要本人在場並同意");
    const minor = existing ? existing.minor : req.minor;
    if (typeof minor !== "boolean") throw new RequestError("bad_request", "minor 格式不對");
    if (minor && req.guardian_confirmed !== true) throw new RequestError("guardian_required", "未成年家人需要家長確認同意");
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
    for (const other of this.comparable()) {
      const hits = samples.filter((f) => Math.max(...other.features.map((g) => dot(f, g))) >= MATCH_THRESHOLDS.match).length;
      if (hits * 2 > samples.length) throw new RequestError("duplicate", "這個人看起來可能已經登記過；不會覆蓋。要重新登記請先刪除原本的資料");
    }
    if (!(await this.options.confirm({ kind: "enroll", name: name.name, minor }))) {
      throw new RequestError("declined", "沒有確認，未保存");
    }
    this.afterConfirm(session, "未保存");
    const at = new Date(this.now()).toISOString();
    if (existing) {
      if (!this.people.includes(existing)) throw new RequestError("not_found", "找不到這位家人");
      this.commit(this.people.map((p) => (p === existing ? { ...p, model: { ...this.options.model }, features: samples, updated_at: at } : p)));
      this.options.store.markNamingNoticeSeen(at);
      return { ok: true, op: "enroll", ...this.manageView(session) };
    }
    if (this.people.length >= FAMILY_MAX) throw new RequestError("full", `最多 ${FAMILY_MAX} 位家人`);
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

  private findPerson(id: unknown): StoredPerson {
    const target = typeof id === "string" && PERSON_ID.test(id) ? this.people.find((p) => p.person_id === id) : undefined;
    if (!target) throw new RequestError("not_found", "找不到這位家人");
    return target;
  }

  /**
   * SP-01 登記聲音：只收特徵（頁面算好、錄音已丟）。檢查順序：資料與模型可用 → 模型版本 → 段數與形狀 → 喚醒詞與朗讀各自一致
   * → 對象（已登記的家人，或新增只有聲音的家人：名稱、同意、未成年的家長確認、人數上限）→ 和別人的聲音去重 → 原生確認 → 寫檔。
   */
  private async enrollVoice(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    const model = this.requireVoiceReady();
    if (!sameSpeakerModel(speakerModelOf(req.model), model)) throw new RequestError("model_mismatch", "頁面的聲音模型版本與核心不同，請重新整理");
    if (!Array.isArray(req.keyword) || req.keyword.length !== VOICE_KEYWORD_SAMPLES || !Array.isArray(req.utterance) || req.utterance.length !== VOICE_UTTERANCE_SAMPLES) {
      throw new RequestError("bad_samples", `需要喚醒詞 ${VOICE_KEYWORD_SAMPLES} 段與朗讀 ${VOICE_UTTERANCE_SAMPLES} 段`);
    }
    const keyword = req.keyword.map(toSpeakerFeature);
    const utterance = req.utterance.map(toSpeakerFeature);
    if (!consistent(keyword, VOICE_THRESHOLDS.keyword) || !consistent(utterance, VOICE_THRESHOLDS.utterance)) {
      throw new RequestError("inconsistent_samples", "這次錄到的聲音不太一致（可能有別人說話、太小聲或背景太吵），請在安靜的地方重錄");
    }
    if (req.consent !== true) throw new RequestError("consent_required", "需要本人在場並同意");
    const existing = req.person_id === undefined ? null : this.findPerson(req.person_id);
    let name: string;
    let minor: boolean;
    if (existing) {
      name = existing.name;
      minor = existing.minor;
    } else {
      if (this.people.length >= FAMILY_MAX) throw new RequestError("full", `最多 ${FAMILY_MAX} 位家人`);
      const parsed = parseFamilyName(req.name);
      if (!parsed.ok) throw new RequestError("bad_name", parsed.error);
      if (typeof req.minor !== "boolean") throw new RequestError("bad_request", "minor 格式不對");
      name = parsed.name;
      minor = req.minor;
    }
    if (minor && req.guardian_confirmed !== true) throw new RequestError("guardian_required", "未成年家人需要家長確認同意");
    // 去重：朗讀的平均方向和另一位家人的太像，視為同一個人；不回是哪一位（避免拿登記當探測工具）。
    const mine = meanDirection(utterance);
    for (const other of this.comparableVoice()) {
      if (other === existing) continue;
      if (dot(mine, meanDirection(other.voice!.utterance)) >= VOICE_THRESHOLDS.duplicate) {
        throw new RequestError("duplicate", "這個聲音和另一位已登記的家人很像；不會保存。要重錄請先刪除原本的聲音");
      }
    }
    if (!(await this.options.confirm({ kind: "enroll_voice", name, minor, existing: existing !== null }))) {
      throw new RequestError("declined", "沒有確認，未保存");
    }
    this.afterConfirm(session, "未保存");
    const at = new Date(this.now()).toISOString();
    const voice = { model: { ...model }, keyword, utterance, updated_at: at };
    if (existing) {
      if (!this.people.includes(existing)) throw new RequestError("not_found", "找不到這位家人");
      const old = existing.voice;
      this.commit(this.people.map((p) => (p === existing ? { ...p, voice, updated_at: at } : p)));
      if (old) for (const f of [...old.keyword, ...old.utterance]) f.fill(0);
    } else {
      if (this.people.length >= FAMILY_MAX) throw new RequestError("full", `最多 ${FAMILY_MAX} 位家人`);
      this.commit([
        ...this.people,
        { person_id: `fam_${randomBytes(12).toString("hex")}`, name, minor, created_at: at, updated_at: at, model: { ...this.options.model }, features: [], voice },
      ]);
    }
    return { ok: true, op: "enroll_voice", ...this.manageView(session) };
  }

  /** 只刪聲音；只有聲音的家人等同刪除整位（含記憶的處理），走 remove。 */
  private async removeVoice(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    if (this.gallery !== "ready") throw new RequestError("unavailable", this.manageStatus().limited_reason ?? "家人資料不可用");
    const target = this.findPerson(req.person_id);
    if (!target.voice) throw new RequestError("not_found", "這位家人沒有登記聲音");
    if (target.features.length === 0) {
      const res = await this.remove(session, req);
      return res.ok && res.op === "delete" ? { ...res, op: "delete_voice" } : res;
    }
    if (!(await this.options.confirm({ kind: "delete_voice", name: target.name }))) throw new RequestError("declined", "沒有確認，未刪除");
    this.afterConfirm(session, "未刪除");
    if (!this.people.includes(target)) throw new RequestError("not_found", "找不到這位家人");
    const old = target.voice;
    const at = new Date(this.now()).toISOString();
    this.commit(this.people.map((p) => {
      if (p !== target) return p;
      const { voice: _voice, ...rest } = p;
      return { ...rest, updated_at: at };
    }));
    for (const f of [...old.keyword, ...old.utterance]) f.fill(0);
    return { ok: true, op: "delete_voice", ...this.manageView(session) };
  }

  private async remove(session: Session, req: Record<string, unknown>): Promise<IdentityResponse> {
    if (this.gallery !== "ready") throw new RequestError("unavailable", this.manageStatus().limited_reason ?? "家人資料不可用");
    const target = this.findPerson(req.person_id);
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
    if (target.voice) for (const f of [...target.voice.keyword, ...target.voice.utterance]) f.fill(0);
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
