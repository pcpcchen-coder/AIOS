// macOS App 選單列送來的指令（desktop/main.mjs 的 command(name) → nous:command 事件）對到頁面的動作。
// 純函式，tests/desktop-menu.test.ts 直接測。

export interface DesktopCommandHandlers {
  voice(): void;
  progress(): void;
  settings(): void;
  type(): void;
  /** 選單列「鏡頭與語音設定 → 顯示鏡頭畫面」。 */
  cameraPreview(): void;
  /** 選單列「鏡頭與語音設定 → 家人辨識…」（主程序已記下點擊時間；管理 session 由核心決定能不能開）。 */
  family(): void;
  /** 選單列「記憶…」（主程序已記下點擊時間；記憶管理能不能打開由核心決定）。 */
  memory(): void;
  /** 選單列「成果紀錄…」（HIST-1）：打開成果紀錄 Surface。 */
  history(): void;
  /** 選單列「刪除明文備份…」（MEM-4a）：顯示任務加密搬遷的明文備份提示（刪除前主程序另跳原生確認）。 */
  vault(): void;
}

export const DESKTOP_COMMANDS = ["voice", "progress", "settings", "type", "camera-preview", "family", "memory", "history", "vault"] as const;

/** 認得的指令執行對應動作並回 true；不認得的不做任何事，回 false。 */
export function runDesktopCommand(command: string, handlers: DesktopCommandHandlers): boolean {
  switch (command) {
    case "voice":
      handlers.voice();
      return true;
    case "progress":
      handlers.progress();
      return true;
    case "settings":
      handlers.settings();
      return true;
    case "type":
      handlers.type();
      return true;
    case "camera-preview":
      handlers.cameraPreview();
      return true;
    case "family":
      handlers.family();
      return true;
    case "memory":
      handlers.memory();
      return true;
    case "history":
      handlers.history();
      return true;
    case "vault":
      handlers.vault();
      return true;
    default:
      return false;
  }
}
