import { SCREEN_STALE_MS, type ScreenState } from "../shared/day-night.ts";

// DN-3（George 2026-11-08）：終端機頁面回報的螢幕狀態（開／關），給 Pi 套件的 aios-display 讀。
// 只在記憶體記「識別碼 → 狀態與時間」；不寫檔、不記 log。沒收到或太舊一律回「開」（寧可亮著，不卡在黑畫面）。

export class TerminalDisplay {
  private readonly reports = new Map<string, { screen: ScreenState; at: number }>();

  constructor(private readonly options: { now?: () => number; staleMs?: number } = {}) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  report(id: string, screen: ScreenState): void {
    this.reports.set(id, { screen, at: this.now });
  }

  /** screen：aios-display 要套用的狀態；fresh：有沒有夠新的頁面回報。 */
  view(id: string): { screen: ScreenState; fresh: boolean } {
    const r = this.reports.get(id);
    const fresh = !!r && this.now - r.at < (this.options.staleMs ?? SCREEN_STALE_MS);
    return { screen: fresh ? r!.screen : "on", fresh };
  }
}
