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

export function isTerminalId(value: unknown): value is string {
  return typeof value === "string" && TERMINAL_ID.test(value);
}
