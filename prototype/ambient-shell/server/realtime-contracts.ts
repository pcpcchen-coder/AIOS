import type { Locale } from "../shared/i18n.mjs";
import type { RealtimeBaseInfo, Task } from "../shared/types.ts";
import type {
  CoreToolName,
  HostToolName,
  LiveCoreEvent,
  LiveInputKind,
  LiveMemoryReason,
  RouteId,
  RouteOption,
  StopEvidence,
  StopReplyTurn,
  UnavailableReason,
} from "../shared/realtime-route.ts";
import { WEB_SEARCH_TIMEOUT_MS } from "../shared/web-search.ts";

// 即時語音的契約（docs/23 §3 的 S7，2026-11-10 從 server/realtime-routes.ts 原樣搬出）：
// 路徑模組（apikey-route、apikey-call、live-route）、交辦（live-tool-caller）、登入（codex-auth）與記憶（memory/live）
// 都需要的介面、錯誤類別與時限常數。這個檔只 import shared/，不 import server/ 的其他模組，所以不會形成 import 環。
// server/realtime-routes.ts 照舊 re-export 這裡的每一個名字（同一個類別物件，instanceof 不變）。

// ─────────────────────────── 兩條路徑都實作的介面 ───────────────────────────

export type Readiness = { ready: true } | { ready: false; reason: UnavailableReason; message: string };

/** 頁面的確認卡狀態（頁面回報）：核心據此判斷「確認執行」是在回答哪張卡。 */
export interface ApprovalSnapshot {
  open: boolean;
  /** 最近一次確認卡結束的時間（epoch ms）。 */
  resolvedAt: number | null;
}

/** 一個工作階段給路徑的東西。由 RealtimeSessions 建立；路徑看不到其他工作階段。 */
export interface SessionContext {
  readonly sessionId: string;
  readonly locale?: Locale;
  readonly tasks: () => Task[];
  /** 真實事件 → 擁有工作階段的頁面（SSE realtime.live）。closed 事件同時結束工作階段。 */
  emit(event: LiveCoreEvent): void;
  /** 共用的工具執行器（頁面），經 SSE realtime.host ＋ POST /api/realtime/host-result。 */
  readonly host: ToolHost;
  /** 頁面確認卡的狀態。 */
  approval(): ApprovalSnapshot;
  now(): number;
  /** MEM-2：看著說話開始的（核心發了互動 ID）：本次人物可能由臉部候選決定，連線時先不放記憶。 */
  readonly lookToTalk?: boolean;
  /** MEM-2：記憶撤銷後自動重建的通話（MEM-3：走被撤銷那通的路徑、不問候、第一句是固定句）。 */
  readonly rebuild?: boolean;
  /** RPI-ID：開始這通的頁面（Mac 主視窗 "main"，終端機是識別碼）；記憶候選只看這個頁面認出的人。 */
  readonly page?: string;
  /** MEM-3：開始的頁面有 SSE 串流（核心能送事件與工具呼叫給它）；記憶工作階段需要它。 */
  readonly events?: boolean;
  /** MEM-2：等頁面回報這個工作階段已停播（POST /api/realtime/stopped）；逾時回 null。 */
  stopped?(timeoutMs: number): Promise<StopEvidence | null>;
  /** MEM-2：停播未確認：強制靜音（Electron setAudioMuted），並把分開的回條送給頁面。 */
  forceSilence?(message: string): void;
}

export interface RealtimeRoute {
  readonly id: RouteId;
  /** 本機、同步（有沒有登入、有沒有 key）；不連網，每次設定畫面都會呼叫。 */
  readiness(): Readiness;
  /** 標籤、計費、聲音、工具：RealtimeInfo.routes。 */
  describe(): RouteOption;
  /** 舊欄位（available／model／web_search／home／mcp／detail）在這條路徑的值。 */
  baseInfo(): RealtimeBaseInfo;
  /**
   * 開始：把瀏覽器的 offer 換成 answer。只有在這條路徑能服務整個工作階段時才 resolve
   * （live：通話建立而且 sideband 接上）。失敗丟 RouteStartError。
   */
  connect(offerSdp: string, ctx: SessionContext): Promise<RouteCall>;
}

export interface RouteCall {
  readonly route: RouteId;
  readonly answerSdp: string;
  readonly model: string;
  /** live：核心端的控制面。api_key：null（頁面的資料通道照舊負責工具、問候與打字；記憶的控制面是核心旁路）。 */
  readonly control: LiveControl | null;
  /**
   * 可重複呼叫。live：sideband 送 session.close、中止進行中的交辦。api_key：沒有旁路時沒有事要做；
   * MEM-3 有旁路時關旁路（頁面離開時另外掛斷）。
   * enforced（費用防護，2026-11-06）：核心自己結束（每通上限、頁面沒報到、Mac 鎖定或睡眠）：頁面可能還開著，
   * 所以 api_key 一律向 OpenAI 掛斷（有 call ID 時）；live 和 ended 一樣送 session.close。
   */
  close(reason: CallCloseReason): Promise<void>;
  /** MEM-3：頁面略過、由核心處理的工具（API key 路徑帶記憶規則時）。 */
  readonly coreTools?: readonly CoreToolName[];
  /** MEM-3：這通記憶的初始狀態（/call 回應用；只有筆數與原因代碼）。 */
  memoryStatus?(): { used: number; reason: LiveMemoryReason | null } | null;
  /** MEM-3：API key 路徑的問候決策已做出（IdentityService）：問候那一輪結束後才問臉部候選。 */
  /** spoken：問候那一輪真的開始時呼叫（PRO-1 記下主動提醒說過）。 */
  greetingDecided?(named: boolean, spoken?: () => void): void;
  /** MEM-3：頁面回報播放結束（只會把語音確認的時窗往後延）。 */
  playback?(): void;
  /**
   * F7（ID-02 Mac 2026-10-31）：頁面回報手掌停止（停止回覆）：這一輪還沒回來的工具／交辦結果不再請模型念出
   * （只交回當背景）。不中止工具、不取消背景任務、不結束通話。
   */
  stopReply?(turn?: StopReplyTurn): void;
}

export type CallCloseReason = "ended" | "page_gone" | "fallback" | "enforced";

/** live 路徑上頁面 → 模型的輸入；sideband 是唯一寫給模型的管道。 */
export interface LiveControl {
  input(kind: LiveInputKind, text: string): void;
}

export class RouteStartError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    readonly status: number,
    message: string,
    /**
     * auto 能不能在「這次開始」改用 api_key：usage_limit、forbidden、network、upstream、needs_reauth、
     * not_logged_in、no_account_id 可以；model_rejected 不行（設定錯了要修，不能默默換成計費路徑來掩蓋）。
     */
    readonly fallbackable: boolean,
  ) {
    super(message);
  }
}

// ─────────────────────────── 頁面當工具執行器 ───────────────────────────

/** 工作階段已結束（頁面離開、sideband 斷線、使用者結束）：等待中的工具呼叫一律拒絕。 */
export class HostGone extends Error {
  constructor(message = "即時語音已結束，工具呼叫沒有完成。") {
    super(message);
  }
}

export interface ToolHost {
  /**
   * 請頁面照 API key 路徑的方式執行一個工具（同一份 callbacks、同一個畫面）。
   * 逾時：有副作用的工具回 status unknown（「結果不明，請確認」），其他回 ok:false；從不假裝成功。
   * 工作階段結束時丟 HostGone。
   */
  call(name: HostToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** 正在等頁面回覆的工具數量（進度提示只在真的有工具在跑時才說）。 */
  readonly outstanding: number;
}

/** 頁面轉交工具結果（POST host-result）的餘裕。 */
export const HOST_REPLY_MARGIN_MS = 2_000;

/**
 * 每個工具等頁面回覆的時限。home_control＝home-bridge UTTERANCE_MS（60 秒）＋2 秒；
 * web_search＝WEB_SEARCH_TIMEOUT_MS（30 秒；Codex 那一輪的時限也是它，含第一次查模型清單）＋2 秒。
 * 鍵由 HostToolName（shared/realtime-route.ts HOST_TOOL_NAMES）在編譯期檢查：少一個或多一個都編譯不過。
 */
export const HOST_TIMEOUT_MS: Record<HostToolName, number> = {
  home_control: 62_000,
  home_status: 20_000,
  web_search: WEB_SEARCH_TIMEOUT_MS + HOST_REPLY_MARGIN_MS,
  show_search_result: 5_000 + HOST_REPLY_MARGIN_MS,
  delegate_task: 10_000,
  get_tasks: 5_000,
  end_conversation: 5_000,
  set_voice_volume: 5_000,
  set_day_night: 10_000,
};

// ─────────────────────────── 交辦時的記憶接口（原在 server/live-tool-caller.ts，那裡照舊 re-export） ───────────────────────────

/**
 * MEM-2：這通 live 通話的記憶（server/memory/live.ts 的 LiveMemoryBinding 提供）。
 * blocked：這通已經送過記憶，delegate_task 改成問使用者；recall：recall_memory（唯讀、經 lease.deliver）；
 * delegateBlocked：通知頁面出「要交辦這件事嗎？」卡（標題是 sideband 最近一則使用者原句）。
 */
export interface LiveCallerMemory {
  blocked(): boolean;
  recall(query: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  /** title：觸發交辦的使用者原句；null 時不出卡。 */
  delegateBlocked(title: string | null): void;
}
