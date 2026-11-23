import { SCREEN_STALE_MS, type ScreenState } from "../shared/day-night.ts";
import { WINDOW_REQUEST_FRESH_MS, type WindowMode } from "../shared/terminal-window.ts";

// DN-3（George 2026-11-08）：終端機頁面回報的螢幕狀態（開／關），給 Pi 套件的 aios-display 讀。
// 只在記憶體記「識別碼 → 狀態與時間」；不寫檔、不記 log。沒收到或太舊一律回「開」（寧可亮著，不卡在黑畫面）。

export class TerminalDisplay {
  private readonly reports = new Map<string, { screen: ScreenState; at: number }>();
  /** WIN-1：頁面要求的全螢幕／視窗模式（最近一次）。 */
  private readonly windows = new Map<string, { mode: WindowMode; at: number }>();

  constructor(private readonly options: { now?: () => number; staleMs?: number } = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  report(id: string, screen: ScreenState): void {
    this.reports.set(id, { screen, at: this.now });
  }

  /** WIN-1：頁面要求改成全螢幕或視窗（aios-display 下一次讀到時套用）。 */
  requestWindow(id: string, mode: WindowMode): void {
    this.windows.set(id, { mode, at: this.now });
  }

  /**
   * screen：aios-display 要套用的狀態；fresh：有沒有夠新的頁面回報。
   * window：WINDOW_REQUEST_FRESH_MS 內的全螢幕／視窗請求，沒有時 null（Pi 維持現狀）。
   */
  view(id: string): { screen: ScreenState; fresh: boolean; window: WindowMode | null } {
    const r = this.reports.get(id);
    const fresh = !!r && this.now - r.at < (this.options.staleMs ?? SCREEN_STALE_MS);
    const w = this.windows.get(id);
    const window = w && this.now - w.at < WINDOW_REQUEST_FRESH_MS ? w.mode : null;
    return { screen: fresh ? r!.screen : "on", fresh, window };
  }
}
