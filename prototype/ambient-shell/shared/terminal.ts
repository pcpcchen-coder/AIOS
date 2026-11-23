import type { EvidenceTiming } from "./identity.ts";

// 終端機（例如 Raspberry Pi kiosk）連線狀態的共用常數與型別。
// SSH 轉發的 TCP 連線在 Pi 消失後仍可能在 Mac 這端保持「開著」，SSE 連線狀態不能當成連線證據；
// 只以頁面每 TERMINAL_HEARTBEAT_MS 送一次的應用層心跳為準，超過 TERMINAL_STALE_MS 沒收到就算斷線。

/** 終端機頁面送心跳的間隔。 */
export const TERMINAL_HEARTBEAT_MS = 10_000;
/** 多久沒收到心跳就算斷線（容許漏掉一次心跳）。 */
export const TERMINAL_STALE_MS = 25_000;
/** 終端機識別碼（URL 的 ?terminal= 與心跳的 terminal 欄位）。 */
export const TERMINAL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface TerminalStatus {
  /** 至少一台終端機在 TERMINAL_STALE_MS 內送過心跳。 */
  connected: boolean;
  terminals: { id: string; last_seen_ms_ago: number }[];
}

/**
 * Mac 主視窗（IPC，或不帶 X-Nous-Terminal 的 HTTP 請求）的頁面來源。核心依來源分開辨識證據與記憶候選，所以終端機不能叫這個名字。
 */
export const MAIN_SOURCE = "main";

export function isTerminalId(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_ID.test(value) && value !== MAIN_SOURCE;
}

/**
 * RPI-ID：終端機頁面在每個 API 請求帶這個標頭（值是 ?terminal= 的識別碼），核心據此知道是哪個頁面在問（記憶候選、即時語音的
 * 候選與喚醒時窗）。只是分開頁面的標記，不是授權：本機任何 HTTP 用戶端都能帶。
 */
export const TERMINAL_HEADER = "X-Nous-Terminal";

/** 請求的頁面來源：合法的終端機識別碼，否則是 Mac 主視窗。 */
export function pageSource(header: unknown): string {
  return isTerminalId(header) ? header : MAIN_SOURCE;
}

/**
 * RPI-ID（George 2026-11-05）：終端機頁面經 HTTP（POST /api/terminal/identity）能用的家人辨識操作：只有不需要管理 session 的
 * 認人操作。登記、刪除、校準與管理 session 只在 Mac 的 App（IPC）。回應和 IPC 一樣不含分數或辨識結果。
 */
export const TERMINAL_IDENTITY_OPS = ["ambient_status", "ambient_probe", "greeting", "voice_probe", "call_voice"] as const;

/**
 * RPI-ID：終端機頁面經 HTTP（POST /api/terminal/memory）能用的記憶操作：只有「正在用 X 的記憶」「不是我」與本次人物選單需要的。
 * card_view／card_answer 只限人物候選卡（face_candidate），card_answer 只能 decline；select 不能帶管理權杖。
 * 回應不含記憶內容（卡片、要送的聊天與建議都拿掉）。
 */
export const TERMINAL_MEMORY_OPS = ["status", "suspend", "select", "card_view", "card_answer"] as const;

/**
 * 終端機頁面在 POST /api/terminal/identity 的信封（不是 IPC 的請求本身）回報的鏡頭狀態：頁面實際套用的「看著說話」三個設定
 * （Pi 本機保存，src/terminal-camera.ts）與鏡頭是否真的在跑。核心依它決定這個終端機的同步辨識與稱名；Mac 主視窗照舊讀 camera.json。
 */
export interface TerminalPageReport {
  camera_active: boolean;
  look_to_talk: boolean;
  look_to_talk_greet: boolean;
  look_to_talk_greet_name: boolean;
}

export const TERMINAL_PAGE_KEYS = ["camera_active", "look_to_talk", "look_to_talk_greet", "look_to_talk_greet_name"] as const;

/** 嚴格解析：四個欄位都要是 boolean、不能有別的欄位；不合格回 null。 */
export function parseTerminalPageReport(value: unknown): TerminalPageReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== TERMINAL_PAGE_KEYS.length || !TERMINAL_PAGE_KEYS.every((key) => typeof record[key] === "boolean")) return null;
  return { camera_active: record.camera_active as boolean, look_to_talk: record.look_to_talk as boolean, look_to_talk_greet: record.look_to_talk_greet as boolean, look_to_talk_greet_name: record.look_to_talk_greet_name as boolean };
}

export const TERMINAL_EVIDENCE_TIMING: Readonly<EvidenceTiming> = { gap_ms: 2000, fresh_ms: 2000 };

/**
 * 終端機頁面（Pi）的效能保護（對話流暢優先）：感知迴圈與看著說話的取樣頻率減半。Mac 主視窗與一般瀏覽器照舊。
 * senseFrameMs：鏡頭感知迴圈的間隔；identitySampleMs：同步辨識兩次取樣的最短間隔（250 ms＝4 Hz、500 ms＝2 Hz）。
 */
export const PAGE_PACE = {
  main: { senseFrameMs: 80, identitySampleMs: 250 },
  terminal: { senseFrameMs: 160, identitySampleMs: 500 },
} as const;

/** 頁面的終端機識別碼：沒有 App preload、網址帶合法的 ?terminal= 才算；否則 null。 */
export function pageTerminal(search: string, desktop: boolean): string | null {
  if (desktop) return null;
  const id = new URLSearchParams(search).get("terminal");
  return isTerminalId(id) ? id : null;
}
