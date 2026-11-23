import { SCREEN_REPORT_MS, screenWanted, type DayNightMode, type DayNightPrefs, type ScreenState } from "../shared/day-night.ts";

// DN-3（George 2026-11-08）：終端機（Pi）頁面算出螢幕要開或關，回報給核心，Pi 套件的 aios-display 照著開關螢幕。
// 有人碰螢幕、按鍵或頁面在忙（對話、收音、念話、任務、畫面、看著說話）都算活動；夜間閒置 SCREEN_IDLE_MS 才關。
// 狀態改變立即送，沒變也每 SCREEN_REPORT_MS 送一次（核心 30 秒沒收到就當成開）。送失敗不顯示，下一次再送。

export interface ScreenReporterDeps {
  send(screen: ScreenState): Promise<unknown>;
  now?(): number;
}

export class ScreenReporter {
  private lastActivity: number;
  private sent: ScreenState | null = null;
  private sentAt = 0;

  constructor(private readonly deps: ScreenReporterDeps) {
    this.lastActivity = this.now();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** 使用者碰了螢幕或按鍵。 */
  activity(): void {
    this.lastActivity = this.now();
  }

  get current(): ScreenState | null {
    return this.sent;
  }

  /** 重算並在需要時回報；回傳現在要的狀態。 */
  update(input: { mode: DayNightMode; prefs: Pick<DayNightPrefs, "screen_off">; busy: boolean }): ScreenState {
    const now = this.now();
    if (input.busy) this.lastActivity = now;
    const screen = screenWanted({ ...input, idleMs: now - this.lastActivity });
    if (screen !== this.sent || now - this.sentAt >= SCREEN_REPORT_MS) {
      this.sent = screen;
      this.sentAt = now;
      void this.deps.send(screen).catch(() => {});
    }
    return screen;
  }
}
