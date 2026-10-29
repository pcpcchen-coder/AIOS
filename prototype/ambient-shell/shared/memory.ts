// 記憶層的受限 UI 命令與結果 DTO（16 §9）：只經 macOS App 的 IPC（desktop/memory-ipc.mjs → server/memory/service.ts），
// 不走 HTTP、不交給模型。不暴露資料金鑰、票證實作或任意 scope；人物 ID 只給可信主視窗用來選人物與管理。
// 文字欄位 message 是核心的固定句型（中文原文，{0}… 由 values 帶入），畫面用共用翻譯表 t(message, ...values) 顯示；
// values 是使用者自己的話或人物名稱，不翻譯。

export const MEMORY_OPS = ["status", "setup", "turn", "card_answer", "select", "suspend", "list", "receipt", "edit", "forget", "pin", "profile_delete", "link_face", "profile_minor"] as const;
export type MemoryOp = (typeof MEMORY_OPS)[number];

/** 本次人物狀態（16 §4）：unselected 只用家庭共用；suspended 是撤銷後暫停，要重新選擇。 */
export type PresenceState = "unselected" | "selected" | "suspended";
export const PROFILE_ID = /^profile_[a-f0-9]{16}$/;
export const FACT_ID = /^mem_[a-f0-9]{16}$/;
export const CARD_ID = /^mc_[a-f0-9]{24}$/;
export const MANAGE_TOKEN = /^mm_[a-f0-9]{32}$/;
export const TURN_NONCE = /^mt_[a-f0-9]{32}$/;
export const MEMORY_PROFILE_MAX = 20;
export const MEMORY_FACT_MAX = 1000;
export const MEMORY_VALUE_MAX = 512;
export const MEMORY_EXCERPT_MAX = 240;

/** 只放全體 SSE 與 settings 的欄位（不含人物、內容或筆數）。 */
export interface MemorySettingsStatus {
  available: boolean;
  enabled: boolean;
}
export const BROWSER_MEMORY_STATUS: MemorySettingsStatus = { available: false, enabled: false };

export interface MemoryText {
  message: string;
  values: string[];
}

export interface MemoryPresenceView {
  state: PresenceState;
  /** 本次人物世代：每次換人、暫停、更正、忘記或撤銷都加一。頁面看到它變了，就清掉用過記憶的對話歷史並更新標示。 */
  epoch: number;
  /** 主視窗「本次人物」選單用的一次性憑證（這個世代有效）；select 必須帶它或管理權杖。 */
  select_card: string;
  profile: string | null;
  name: string | null;
  /** 暫停原因（固定句型）；selected／unselected 為 null。 */
  reason: MemoryText | null;
}

export interface MemoryProfileView {
  id: string;
  name: string;
  minor: boolean;
  linked: boolean;
  facts: number;
}

export interface MemoryTargetView {
  provider: string;
  account: string;
  label: string;
  /** 目前本次範圍（本次人物或全家共用）是否允許這個服務帳號取得相關片段。 */
  allowed: boolean;
  household_allowed: boolean;
}

export interface MemoryStatusView {
  /** ready：可用；not_loaded：這次執行還沒開過加密檔（status 不會為了查狀態去開）；unavailable：無法解鎖、損壞、權限不符、鎖被占用或寫入失敗。 */
  state: "ready" | "not_loaded" | "unavailable";
  reason: MemoryText | null;
  enabled: boolean;
  setup_done: boolean;
  presence: MemoryPresenceView;
  profiles: MemoryProfileView[];
  /** 目前一般聊天用的服務帳號；null＝沒有可用帳號（例如模擬模式以外都沒登入）。 */
  target: MemoryTargetView | null;
  targets: MemoryTargetView[];
  active_facts: number;
  limits: { facts: number; profiles: number; value_chars: number };
}

export interface MemoryFactView {
  id: string;
  revision: number;
  subject: string | null;
  subject_name: string | null;
  text: string;
  topic: string;
  source: "explicit";
  excerpt: string;
  at: string;
  expires: string | null;
  pinned: boolean;
}

export type MemoryReceiptStatus =
  | "saved" | "updated" | "forgotten" | "unchanged" | "selected" | "cancelled"
  | "not_found" | "rejected" | "minor" | "disabled" | "full" | "conflict" | "receipt_expired" | "unavailable";

export interface MemoryReceiptView extends MemoryText {
  status: MemoryReceiptStatus;
  /** 存進核心的操作 ID（UUIDv7）；中斷後可用 receipt 查詢。 */
  operation_id: string | null;
}

export type ClarifyChoice = "save" | "household" | "cancel";

export type MemoryCardView =
  | { kind: "setup"; card: string; text: string }
  | { kind: "clarify"; card: string; value: string; reason: MemoryText; options: ClarifyChoice[] }
  | { kind: "create_profile"; card: string; name: string; target: MemoryTargetView | null }
  | { kind: "choose_profile"; card: string; name: string; profiles: { id: string; name: string }[] }
  | { kind: "face_candidate"; card: string; name: string }
  | { kind: "pick"; card: string; action: "correct" | "forget"; value: string; candidates: MemoryFactView[] }
  | { kind: "inspect"; subject_name: string | null; facts: MemoryFactView[] };

export interface MemoryTurnView {
  receipts: MemoryReceiptView[];
  card: MemoryCardView | null;
  /** 要送一般聊天的文字與一次性的 memory_turn（60 秒、綁本次人物世代與原句）；card 在時頁面先處理卡片再送。 */
  chat: { text: string; memory_turn: string | null } | null;
  presence: MemoryPresenceView;
  /** 更正、忘記、換人或撤銷：用過記憶的對話歷史要清空。 */
  history_reset: boolean;
  /** 這次沒有用到記憶的原因（固定句型）；null＝已依設定處理。 */
  notice: MemoryText | null;
}

export type MemoryErrorCode = "bad_request" | "unavailable" | "not_user_initiated" | "no_manage" | "not_found" | "expired" | "conflict" | "declined" | "full" | "busy" | "closed";

export type MemoryResponse =
  | ({ ok: true; op: "status" } & MemoryStatusView)
  | ({ ok: true; op: "turn" | "card_answer" | "setup" | "select" } & MemoryTurnView & { status: MemoryStatusView })
  | { ok: true; op: "suspend"; presence: MemoryPresenceView }
  | { ok: true; op: "list"; facts: MemoryFactView[]; subject: string | null; manage: string | null; status: MemoryStatusView; face_people: { person_id: string; name: string; linked: boolean }[] | null; consents: { provider: string; account: string; allowed: boolean }[] }
  | { ok: true; op: "receipt"; status: MemoryReceiptStatus }
  | ({ ok: true; op: "edit" | "forget" | "pin" | "profile_delete" | "link_face" | "profile_minor" } & { receipt: MemoryReceiptView; history_reset: boolean; status: MemoryStatusView })
  | { ok: false; code: MemoryErrorCode; message: string };

export type MemorySetupSubject = { kind: "household" } | { kind: "profile"; profile: string } | { kind: "name"; name: string };

export type MemoryRequest =
  | { op: "status" }
  /** 首次設定卡（card）或記憶管理（token）才可以開關記憶、改同意。 */
  | { op: "setup"; enabled: boolean; subject: MemorySetupSubject; allow: { provider: string; account: string }[]; card?: string; token?: string }
  | { op: "turn"; text: string; request_id: string }
  | { op: "card_answer"; card: string; choice: string; profile?: string; fact?: string; allow?: boolean }
  /** card：presence.select_card（主視窗「本次人物」選單）；或記憶管理的 token。 */
  | { op: "select"; profile: string | null; card?: string; token?: string }
  | { op: "suspend"; reason: "multi_face" | "tracking_lost" }
  | { op: "list"; subject?: string | null; manage?: boolean; token?: string }
  | { op: "receipt"; operation_id: string }
  | { op: "edit"; id: string | null; revision?: number; value: string; subject?: string | null; token?: string }
  | { op: "forget"; id: string; revision: number; token?: string }
  /** 全部忘記（某人或全家共用）：只在記憶管理（token），之後還有原生確認。 */
  | { op: "forget"; all: true; subject: string | null; token: string }
  /** 記憶管理手動標記未成年（未成年的記憶不能從聊天或卡片寫入、更正或忘記）。 */
  | { op: "profile_minor"; profile: string; minor: boolean; token: string }
  | { op: "pin"; id: string; revision: number; pinned: boolean; token?: string }
  | { op: "profile_delete"; profile: string; token: string }
  | { op: "link_face"; profile: string; person: string | null; token: string };

/** 模型說「記住了」但核心沒有成功回條時，串流結束後追加的固定句型（app.ts 與畫面共用）。 */
export const MEMORY_CLAIM = /(記住了|記下了|已記住|已經記住|我會記得|我記得了|幫你記著|記在.*名下|I(?:'ll| will) remember|I(?:'ve| have) (?:saved|remembered|noted)|got it,? i'?ll remember)/i;
