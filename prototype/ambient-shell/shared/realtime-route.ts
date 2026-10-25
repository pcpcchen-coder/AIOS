// 即時語音的兩條路徑（核心、頁面與桌面選單共用）：路徑是什麼、誰計費、頁面看得到的事件。
// 這裡沒有任何線路格式、權杖或帳號 ID；線路細節只在 server/live-route.ts 與 server/codex-responses.ts。

/** 兩條路徑。標籤、計費、聲音的表都以這份清單為鍵。 */
export const ROUTE_IDS = ["live", "api_key"] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

/** 使用者偏好（realtime.json；預設來自 NOUS_REALTIME_ROUTE，再沒有就是 auto）。 */
export const ROUTE_PREFERENCES = ["auto", "live", "api_key"] as const;
export type RoutePreference = (typeof ROUTE_PREFERENCES)[number];

export const ROUTE_PREFERENCE_LABEL: Record<RoutePreference, string> = {
  auto: "自動（先用 ChatGPT 方案，不能用時改用 API key 並告知）",
  live: "ChatGPT 方案（Codex 額度）",
  api_key: "OpenAI API key（依用量計費）",
};

export type Billing = "chatgpt_plan" | "openai_api";

export const ROUTE_BILLING: Record<RouteId, Billing> = { live: "chatgpt_plan", api_key: "openai_api" };

/**
 * 每個畫面（設定、即時語音列、選單列、引擎列）印的同一句話；推導出來，不另外保存。
 * billingLine("live", "gpt-live-1-codex") → 「ChatGPT 方案（Codex 額度）· gpt-live-1-codex」
 */
export function billingLine(route: RouteId, model: string): string {
  return route === "live" ? `ChatGPT 方案（Codex 額度）· ${model}` : `OpenAI API key 計費 · ${model}`;
}

/**
 * gpt-live-1-codex 的聲音（OpenClaw realtime-quicksilver.ts:33-43，與 Codex protocol.rs 的 v1 清單相同）。
 * 這條路徑不能查聲音清單；送出清單外的聲音會得到語意不明的 403，所以核心只送清單內的值。
 */
export const LIVE_VOICES = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const;
export type LiveVoiceId = (typeof LIVE_VOICES)[number];
export const DEFAULT_LIVE_VOICE: LiveVoiceId = "cove";

export function isLiveVoice(value: unknown): value is LiveVoiceId {
  return typeof value === "string" && (LIVE_VOICES as readonly string[]).includes(value);
}

/** 一條路徑現在為什麼不能開始；每個原因對應一句使用者看得懂的話（unavailableText）。 */
export type UnavailableReason =
  | "not_logged_in"
  | "needs_reauth"
  | "no_account_id"
  | "usage_limit"
  | "forbidden"
  | "model_rejected"
  | "network"
  | "upstream"
  | "no_api_key"
  | "api_key_rejected"
  | "session_busy";

export function unavailableText(reason: UnavailableReason, detail: { voice?: string; resetsInMin?: number | null; message?: string } = {}): string {
  switch (reason) {
    case "not_logged_in":
      return "ChatGPT 方案路徑尚未登入（設定 → 即時語音 → 用 ChatGPT 方案登入）";
    case "needs_reauth":
      return "ChatGPT 方案登入已失效，請重新登入";
    case "no_account_id":
      return "這個登入沒有 ChatGPT 帳號 ID，無法使用方案額度";
    case "usage_limit":
      return `ChatGPT 方案額度已用完${typeof detail.resetsInMin === "number" ? `，約 ${detail.resetsInMin} 分鐘後重置` : ""}`;
    case "forbidden":
      return `ChatGPT 方案拒絕這次即時語音（403）：帳號、方案或聲音（${detail.voice ?? DEFAULT_LIVE_VOICE}）其中之一不被接受，伺服器沒有說是哪一個`;
    case "model_rejected":
      return "NOUS_LIVE_MODEL 的值不被接受；清空它（預設不送 model）";
    case "network":
      return "無法連線到 chatgpt.com 或 api.openai.com（網路中斷或被阻擋）";
    case "upstream":
      return `ChatGPT 方案即時語音暫時無法使用${detail.message ? `：${detail.message}` : ""}`;
    case "no_api_key":
      return "未設定 OPENAI_API_KEY";
    case "api_key_rejected":
      return `OpenAI API key 路徑失敗${detail.message ? `：${detail.message}` : ""}`;
    case "session_busy":
      return "已經有一個 ChatGPT 方案即時語音在進行中（一次只能一個）";
  }
}

/** 設定畫面與桌面選單畫的一條路徑。 */
export interface RouteOption {
  id: RouteId;
  available: boolean;
  /** 可用時為 null。 */
  reason: UnavailableReason | null;
  /** billingLine(id, model)。 */
  billing_line: string;
  model: string;
  voice: string;
  /** live：LIVE_VOICES；api_key：空陣列（聲音清單在桌面選單，沿用原本的設定方式）。 */
  voices: readonly string[];
  /** 這條路徑提供的工具（文字）。 */
  tools: string;
  detail: string;
}

/** 即時語音用的 Codex 登入摘要。永遠不含權杖與帳號 ID。 */
export interface LiveAccountInfo {
  signed_in: boolean;
  email: string | null;
  /** chatgpt_plan_type，例如 plus。 */
  plan: string | null;
  needs_reauth: boolean;
  pending: null | { method: "browser"; port: number } | { method: "device"; user_code: string; verification_url: string };
  last_error: string | null;
}

/**
 * RealtimeInfo 增加的路徑與計費欄位。原本的 available／model／detail 意思是「下一次開始會怎樣」，
 * 選單列與指令表照舊讀它們。
 */
export interface RealtimeRouteFields {
  preference: RoutePreference;
  /** 依 planStart 下一次會用的路徑；都不能用時為 null。 */
  route: RouteId | null;
  billing: Billing | null;
  billing_line: string | null;
  routes: RouteOption[];
  /** 沒有接上 ChatGPT 方案路徑（測試或舊設定）時為 null。 */
  live_account: LiveAccountInfo | null;
  /** 正在進行的工作階段（偏好改了也維持到它結束）。 */
  active: null | { session_id: string; route: RouteId; billing_line: string };
}

/** POST /api/realtime/start 的回答：開麥克風前就決定好。 */
export type StartDecision =
  | {
      ok: true;
      session_id: string;
      /** 這個工作階段的擁有者憑證：只有開始它的頁面拿得到；host-result、input、end 都要帶。 */
      owner: string;
      route: RouteId;
      model: string;
      billing_line: string;
      /** auto 改用 API key 時要說出並顯示的計費通知。 */
      notice: string | null;
      /**
       * 看著說話開始的互動 ID（ID-02）：只有 source 為 look_to_talk 時由核心發出，同一次互動改路徑時沿用。
       * 問候決策只接受核心發出、尚未使用、工作階段真的連上 20 秒內的 ID（RealtimeSessions.claimGreeting）。
       */
      interaction?: string | null;
    }
  | { ok: false; message: string; reasons: Partial<Record<RouteId, UnavailableReason>> };

/** POST /api/realtime/call 在 live 建立失敗、auto 可以改路徑時的 409 內容。 */
export interface FallbackOffer {
  error: string;
  fallback: { session_id: string; owner: string; route: "api_key"; model: string; billing_line: string; notice: string } | null;
}

// ---- 核心 → 頁面（SSE /api/events，只送給擁有工作階段的那條串流） ----

/** 工具名稱；tests/voice-commands.test.ts 在編譯期比對 server/realtime.ts 的 REALTIME_TOOLS。 */
export type HostToolName = "web_search" | "delegate_task" | "get_tasks" | "end_conversation" | "home_status" | "home_control";

/** 有外部副作用的工具：逾時或結果遺失時只能說「結果不明，請確認」，不能說失敗。 */
export const SIDE_EFFECT_TOOLS: readonly HostToolName[] = ["home_control", "delegate_task"];

export const RESULT_UNKNOWN_TEXT = "結果不明，請確認";

/** 核心請頁面（共用的工具執行器）執行一個工具。 */
export interface HostCall {
  call_id: string;
  name: HostToolName;
  arguments: string;
}

export interface HostResult {
  output: Record<string, unknown>;
}

/** live 工作階段在核心發生的真實事件（sideband 或 LiveToolCaller），不是模型的口頭填充。 */
export type LiveCoreEvent =
  | { kind: "started"; expires_at: number | null }
  /** sideband 收到的逐字稿（資料通道沒有送時頁面用這份；依 item_id 去重）。 */
  | { kind: "transcript"; role: "user" | "assistant"; text: string; final: boolean; item_id: string | null }
  | { kind: "delegation"; id: string; state: "started" | "finished" | "failed" | "unknown" }
  /** 有副作用的工具沒有在時限內回覆：照實說結果不明。 */
  | { kind: "tool_unknown"; name: HostToolName; message: string }
  | { kind: "closed"; reason: LiveCloseReason; message: string };

export type LiveCloseReason = "ended" | "expired" | "connection_lost" | "auth" | "usage_limit" | "error" | "page_gone";

export type RealtimeServerEvent =
  | { type: "realtime.host"; sequence: number; session_id: string; call: HostCall }
  | { type: "realtime.live"; sequence: number; session_id: string; event: LiveCoreEvent };

/**
 * 頁面 → 核心（POST /api/realtime/input）。API key 路徑改用資料通道。
 * greeting：看著說話開始時的一次招呼指示（session.context.append speakable，不加「（系統通知）」；核心每個工作階段最多送一次）。
 */
export const LIVE_INPUT_KINDS = ["user_text", "notice", "context", "greeting"] as const;
export type LiveInputKind = (typeof LIVE_INPUT_KINDS)[number];

/** 頁面回報確認卡狀態（POST /api/realtime/approval）：核心據此判斷「確認執行」是不是在回答一張卡。 */
export type ApprovalState = "open" | "resolved";

/** 確認卡結束的方式（同頁面的 ApprovalOutcome）。只有 said_* 是使用者的回答；逾時、收起、結束都不是。 */
export const APPROVAL_CARD_OUTCOMES = ["said_approve", "said_reject", "timeout", "dismissed", "closed"] as const;
export type ApprovalCardOutcome = (typeof APPROVAL_CARD_OUTCOMES)[number];
export const isApprovalAnswer = (outcome: ApprovalCardOutcome) => outcome === "said_approve" || outcome === "said_reject";

/** POST /api/realtime/approval 的內容：打開時帶卡片自己的時限（核心在時限後自動當成已關閉），結束時帶結果。 */
export type ApprovalReport = { state: "open"; timeout_ms: number } | { state: "resolved"; outcome: ApprovalCardOutcome };

// ---- realtime.json（路徑偏好與 ChatGPT 方案路徑的聲音） ----

export interface RealtimePrefs {
  route: RoutePreference;
  live_voice: LiveVoiceId;
}

export type RealtimePrefsPatch = Partial<RealtimePrefs>;

export class RealtimePatchError extends Error {}

/** 邊界驗證（POST /api/settings/realtime、realtime.json）：只接受列舉值。 */
export function parseRealtimePatch(input: unknown): RealtimePrefsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RealtimePatchError("即時語音設定必須是 JSON 物件");
  const patch: RealtimePrefsPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "route") {
      if (!(ROUTE_PREFERENCES as readonly unknown[]).includes(value)) throw new RealtimePatchError(`route 只能是 ${ROUTE_PREFERENCES.join("、")}`);
      patch.route = value as RoutePreference;
    } else if (key === "live_voice") {
      if (!isLiveVoice(value)) throw new RealtimePatchError(`live_voice 只能是 ${LIVE_VOICES.join("、")}`);
      patch.live_voice = value;
    } else {
      throw new RealtimePatchError(`未知的即時語音設定：${key}`);
    }
  }
  return patch;
}
