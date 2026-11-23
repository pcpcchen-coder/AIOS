// 終端機連線狀態（服務模式的「Pi 已連線／已斷線」）：只來自 POST /api/terminal/heartbeat 的心跳，不看 SSE 或 TCP 連線。
// 只在記憶體記「識別碼 → 最後收到的時間」；不寫檔、不記 IP 或內容。沒有終端機時不排計時器。

import { TERMINAL_STALE_MS, type TerminalStatus } from "../shared/terminal.ts";

export interface TerminalPresenceOptions {
  now?: () => number;
  /** 單次計時器；回傳取消。測試注入假的。 */
  timer?: (run: () => void, ms: number) => () => void;
  /** connected 或仍在線的終端機集合改變時呼叫（含逾時斷線）。 */
  onChange?: (status: TerminalStatus) => void;
  staleMs?: number;
}

const defaultTimer = (run: () => void, ms: number) => {
  const id = setTimeout(run, ms);
  id.unref?.();
  return () => clearTimeout(id);
};

export class TerminalPresence {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly timer: (run: () => void, ms: number) => () => void;
  private readonly staleMs: number;
  private cancelExpiry: (() => void) | null = null;
  private lastKey = "";

  constructor(private readonly options: TerminalPresenceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? defaultTimer;
    this.staleMs = options.staleMs ?? TERMINAL_STALE_MS;
  }

  heartbeat(id: string): void {
    this.seen.set(id, this.now());
    this.refresh();
  }

  status(): TerminalStatus {
    const now = this.now();
    const terminals = [...this.seen]
      .filter(([, at]) => now - at < this.staleMs)
      .map(([id, at]) => ({ id, last_seen_ms_ago: Math.max(0, now - at) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { connected: terminals.length > 0, terminals };
  }

  dispose(): void {
    this.cancelExpiry?.();
    this.cancelExpiry = null;
    this.seen.clear();
  }

  /** 移除逾時的、通知改變、排下一次到期。 */
  private refresh(): void {
    const now = this.now();
    for (const [id, at] of this.seen) if (now - at >= this.staleMs) this.seen.delete(id);
    const status = this.status();
    const key = status.terminals.map((t) => t.id).join(",");
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.options.onChange?.(status);
    }
    this.cancelExpiry?.();
    this.cancelExpiry = null;
    if (this.seen.size === 0) return;
    const oldest = Math.min(...this.seen.values());
    // 真實的 setTimeout 可能早到 1 毫秒：到期時再算一次，還沒過期就再排。
    this.cancelExpiry = this.timer(() => {
      this.cancelExpiry = null;
      this.refresh();
    }, Math.max(1, oldest + this.staleMs - now));
  }
}
